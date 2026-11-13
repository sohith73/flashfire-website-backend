// Regression tests for the 2026-10-09 review of attendance v2. Each block names the finding it guards.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';

isolateExternalServices();

import { getCrmJwtSecret, requireBdaExtension } from '../Middlewares/CrmAuth.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { reportJoin } from '../Controllers/BdaAttendanceController.js';
import { registerAttendanceRoutes } from '../Routes/attendanceRoutes.js';
import { registerBdaProfileRoutes } from '../Routes/bdaProfileRoutes.js';
import { computeVerdictHealth, runVerdictPass } from '../Utils/AttendanceVerdictJob.js';
import { canWrite, handleVerdict, makeContext } from '../Utils/DeductionEngine.js';
import { buildCallSummaries } from '../Utils/BookingCallSummary.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { recordPresentSignal, signalCounts } from '../Utils/recordPresentSignal.js';
import { statusChangeSet, statusHistoryPush } from '../Utils/statusHistoryOps.js';

const RUN = Math.random().toString(36).slice(2, 8);
const D = `rf-${RUN}.test.invalid`;
const PREFIX = `__rf_${RUN}_`;
const SID = `sid@${D}`;
const ADMIN = `admin@${D}`;
const MIN = 60 * 1000;
const FILTER = { bookingId: { $regex: `^${PREFIX}` } };
const domainRe = { $regex: `@${D.replace(/\./g, '\\.')}$` };

let server;
let base;
let seq = 0;

const extToken = (email) => jwt.sign({ role: 'bda_extension', email, name: email.split('@')[0] }, getCrmJwtSecret(), { expiresIn: '1h' });
const crmToken = (email) => jwt.sign({ role: 'crm_user', email, name: email.split('@')[0] }, getCrmJwtSecret(), { expiresIn: '1h' });

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function mkBooking({ start, extra = {} }) {
  const bookingId = `${PREFIX}${++seq}`;
  await CampaignBookingModel.create({
    bookingId,
    clientName: `Client ${seq}`,
    clientEmail: `${bookingId}@${D}`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    scheduledEventStartTime: new Date(start),
    scheduledEventEndTime: new Date(start + 30 * MIN),
    googleMeetCode: 'abc-defg-hij',
    googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
    calendlyHost: { name: 'sid', email: SID },
    bookingCreatedAt: new Date(),
    ...extra,
  });
  return bookingId;
}

const healthyDeps = (extra = {}) => ({
  poster: async () => true,
  adminPoster: async () => true,
  attendancePoster: async () => true,
  meetVerifier: async () => ({ checked: true }),
  bookingFilter: FILTER,
  ignoreGoLive: true,
  health: {
    recordSyncOk: async () => true,
    recordSyncError: async () => true,
    wasSourceHealthy: async () => true,
    syncOkBetween: async () => true,
    getAllSyncHealth: async () => [],
  },
  ...extra,
});

async function cleanup() {
  await Promise.all([
    CampaignBookingModel.deleteMany(FILTER),
    BdaAttendanceModel.deleteMany(FILTER),
    BdaDeductionModel.deleteMany(FILTER),
    BdaProfileModel.deleteMany({ email: domainRe }),
    CrmUserModel.deleteMany({ email: domainRe }),
  ]);
  invalidateRegistryCache();
}

before(async () => {
  await connectTestDb();
  await Promise.all([CampaignBookingModel.init(), BdaAttendanceModel.init(), BdaDeductionModel.init(), BdaProfileModel.init()]);
  const app = express();
  app.use(express.json());
  app.post('/api/bda-attendance/report-join', requireBdaExtension, reportJoin);
  registerAttendanceRoutes(app);
  registerBdaProfileRoutes(app);
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await cleanup();
  await new Promise((r) => server.close(r));
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanup();
  await BdaProfileModel.create({
    email: SID,
    displayName: 'Sid',
    firstName: 'sid',
    tracked: true,
    trackedSince: new Date('2026-01-01T00:00:00Z'),
  });
  await CrmUserModel.create({ email: SID, name: 'Sid', role: 'bda', isActive: true, permissions: [] });
  await CrmUserModel.create({ email: ADMIN, name: 'Admin', role: 'admin', isActive: true, permissions: [] });
  invalidateRegistryCache();
});

// ---------------------------------------------------------------------------------------------------------
describe('pure rules', () => {
  it('statusHistoryOps pushes a history entry only when the status really changes', () => {
    const actor = { source: 'calendly', name: 'Calendly' };
    assert.deepEqual(statusHistoryPush('scheduled', 'scheduled', actor), {});
    assert.deepEqual(statusChangeSet('scheduled', 'scheduled', actor), {});
    const push = statusHistoryPush('not-scheduled', 'scheduled', actor);
    assert.equal(push.$push.statusHistory.status, 'scheduled');
    assert.equal(push.$push.statusHistory.previousStatus, 'not-scheduled');
    assert.equal(push.$push.statusHistory.source, 'calendly');
    assert.equal(statusChangeSet('canceled', 'scheduled', actor).statusChangeSource, 'calendly');
  });

  it('join evidence from before the window counts only if the BDA was still in the call when it opened', () => {
    const start = Date.parse('2026-10-08T11:00:00Z');
    const early = { kind: 'extension_join', eventAt: new Date(start - 25 * MIN) };
    // Joined at -25, left at -20, never came back: not present.
    assert.equal(signalCounts(early, start, { joinedAt: null, leftAt: new Date(start - 20 * MIN) }), false);
    // Joined at -8 and is still in the call: present.
    assert.equal(signalCounts({ ...early, eventAt: new Date(start - 8 * MIN) }, start, { joinedAt: new Date(start - 8 * MIN), leftAt: null }), true);
    // Left after the window opened: was there at the window.
    assert.equal(signalCounts(early, start, { joinedAt: null, leftAt: new Date(start + 10 * MIN) }), true);
    // Google sessions decide for google_meet when present.
    const g = { kind: 'google_meet', eventAt: new Date(start - 25 * MIN) };
    assert.equal(signalCounts(g, start, { sessions: [{ startTime: new Date(start - 25 * MIN), endTime: new Date(start - 20 * MIN) }] }), false);
    assert.equal(signalCounts(g, start, { sessions: [{ startTime: new Date(start - 25 * MIN), endTime: new Date(start + 15 * MIN) }] }), true);
    // In-window joins and buttons are unaffected.
    assert.equal(signalCounts({ kind: 'extension_join', eventAt: new Date(start + 30 * 1000) }, start, null), true);
    assert.equal(signalCounts({ kind: 'button_crm', eventAt: new Date(start - 4 * MIN) }, start, null), true);
    assert.equal(signalCounts({ kind: 'extension_join', eventAt: new Date(start + 61 * 1000) }, start, null), false);
  });

  it('a call to the client\'s number in the window counts for the no-show rule even when linked to a twin booking', () => {
    const start = Date.parse('2026-10-08T11:00:00Z');
    const real = { bookingId: 'real', scheduledEventStartTime: new Date(start), normalizedClientPhone: '5550001111', clientPhone: '+1 555 000 1111' };
    const twin = { bookingId: 'twin', scheduledEventStartTime: new Date(start), normalizedClientPhone: '5550001111', clientPhone: '+1 555 000 1111' };
    const callToTwin = {
      callId: 'c1',
      direction: 'outbound',
      bookingId: 'twin',
      leadNumberNormalized: '15550001111', // an older 11-digit key: still the same client's number
      startedAt: new Date(start + 10 * MIN),
      salesEmail: SID,
      callResult: 'connected',
      durationSec: 40,
    };
    const resolvers = { assignedEmailOf: () => SID, callerEmailOf: (c) => c.salesEmail };
    // The twin is not on this page (the common case): the real booking still knows the client was called.
    const alone = buildCallSummaries([real], [callToTwin], resolvers);
    assert.equal(alone.get('real').calledWithin30Min, true);
    // Both on the page: the call is displayed on the twin, but the real one is still not fined.
    const both = buildCallSummaries([real, twin], [callToTwin], resolvers);
    assert.equal(both.get('real').calledWithin30Min, true);
    assert.equal(both.get('twin').calls, 1);
  });

  it('shadow mode writes nothing without a go-live date (no 60-day back-fill flood)', () => {
    assert.equal(canWrite(makeContext({ mode: 'shadow', liveFrom: null })), false);
    assert.equal(canWrite(makeContext({ mode: 'shadow', liveFrom: new Date('2026-10-01') })), true);
    assert.equal(canWrite(makeContext({ mode: 'live', liveFrom: null })), false);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('verdict health (finding 3: Google never checked this meeting)', () => {
  const startMs = Date.parse('2026-10-08T11:00:00Z');
  const nowMs = startMs + 215 * 1000;
  const deps = (beatMs) => ({
    health: { wasSourceHealthy: async () => true, syncOkBetween: async () => true },
    getHeartbeat: async () => (beatMs == null ? null : { lastHeartbeatAt: new Date(beatMs) }),
  });

  it('a healthy Google source is not enough when this meeting was never checked', async () => {
    assert.equal(await computeVerdictHealth({ startMs, nowMs, bdaEmail: SID, googleChecked: false }, deps(null)), false);
    assert.equal(await computeVerdictHealth({ startMs, nowMs, bdaEmail: SID, googleChecked: true }, deps(null)), true);
  });

  it('only a heartbeat around the window proves the extension was alive', async () => {
    assert.equal(await computeVerdictHealth({ startMs, nowMs, bdaEmail: SID, googleChecked: false }, deps(startMs + 30 * 1000)), true);
    // A heartbeat from two hours later says nothing about the meeting.
    assert.equal(await computeVerdictHealth({ startMs, nowMs, bdaEmail: SID, googleChecked: false }, deps(startMs + 2 * 60 * MIN)), false);
  });

  it('the verdict pass passes "not checked" through: an absent fine would be needs_review', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const verdicts = await runVerdictPass(
      new Date(start + 215 * 1000),
      healthyDeps({ meetVerifier: async () => ({ checked: false, reason: 'no_meet_code' }), getHeartbeat: async () => null })
    );
    const v = verdicts.verdicts.find((x) => x.bookingId === bookingId);
    assert.equal(v.verdict, 'absent');
    assert.equal(v.healthy, false);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('finding 1: a stale absent never survives in-time evidence', () => {
  it('a repeated Google signal corrects an absent written in the race window', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    // The state the race leaves behind: the signal landed, then the absent verdict was written over it.
    await BdaAttendanceModel.create({
      attendanceId: `att_${RUN}_${seq}`,
      bookingId,
      bdaEmail: SID,
      bdaName: 'Sid',
      status: 'present',
      source: 'meet_api',
      matchedBy: 'stable_id',
      meetingScheduledStart: new Date(start),
      signals: [{ kind: 'google_meet', eventAt: new Date(start + 20 * 1000), receivedAt: new Date(start + 80 * 1000) }],
      verdict: 'absent',
      verdictAt: new Date(start + 90 * 1000),
    });
    const posts = [];
    const r = await recordPresentSignal(
      { bookingId, bdaEmail: SID, kind: 'google_meet', eventAt: new Date(start + 20 * 1000), matchedBy: 'stable_id' },
      { postCorrection: async (m) => posts.push(m), now: () => start + 3 * MIN }
    );
    assert.equal(r.duplicate, true);
    assert.ok(r.correction, 'the duplicate still applies the correction');
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: SID }).lean();
    assert.equal(row.verdict, 'present');
    assert.equal(posts.length, 1);
  });

  it('the deduction engine refuses to fine while in-time evidence sits on the row', async () => {
    const start = Date.parse('2026-10-05T10:00:00Z');
    const bookingId = await mkBooking({ start });
    await BdaAttendanceModel.create({
      attendanceId: `att_${RUN}_${seq}`,
      bookingId,
      bdaEmail: SID,
      bdaName: 'Sid',
      status: 'present',
      source: 'auto',
      meetingScheduledStart: new Date(start),
      signals: [{ kind: 'extension_join', eventAt: new Date(start + 20 * 1000), receivedAt: new Date(start + 25 * 1000) }],
      verdict: 'absent', // stale
      verdictAt: new Date(start + 90 * 1000),
    });
    const out = await handleVerdict(
      { bookingId, bdaEmail: SID, verdict: 'absent', verdictAt: new Date(start + 90 * 1000), scheduledStart: new Date(start), signals: [], healthy: true },
      { mode: 'live', liveFrom: new Date('2026-10-01T00:00:00Z'), now: start + 3 * MIN, post: async () => true, getCallSummaries: async () => new Map() }
    );
    assert.equal(out.created, false);
    assert.equal(out.reason, 'has_in_time_evidence');
    assert.equal(await BdaDeductionModel.countDocuments({ bookingId }), 0);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('finding 5: back-dated extension joins', () => {
  it('a report-join posted 10 minutes late with a time before the start cannot flip the verdict', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await call('POST', '/api/bda-attendance/report-join', {
      token: extToken(SID),
      body: { bookingId, meetLink: 'https://meet.google.com/abc-defg-hij', joinedAt: new Date(start - 1 * MIN).toISOString() },
    });
    assert.equal(r.status, 200);
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: SID }).lean();
    const sig = row.signals.find((s) => s.kind === 'extension_join');
    assert.ok(new Date(sig.eventAt).getTime() >= Date.now() - 2 * MIN - 5000, 'clamped to at most 2 minutes before receipt');
    await runVerdictPass(new Date(start + 215 * 1000), healthyDeps());
    assert.equal((await BdaAttendanceModel.findOne({ bookingId, bdaEmail: SID }).lean()).verdict, 'absent');
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('CRM findings on the backend', () => {
  it('my-window: a meeting 20 minutes after the current one is "next", not "no more meetings"', async () => {
    const now = Date.now();
    await mkBooking({ start: now + 2 * MIN });
    const second = await mkBooking({ start: now + 22 * MIN });
    const r = await call('GET', '/api/crm/attendance/my-window', { token: crmToken(SID) });
    assert.equal(r.status, 200);
    assert.ok(r.body.current, 'current meeting');
    assert.equal(r.body.next?.bookingId, second);
  });

  it('profile list edits are atomic: two admins adding leave days keep both', async () => {
    const put = (body) => call('PUT', `/api/crm/admin/bda-profiles/${encodeURIComponent(SID)}`, { token: crmToken(ADMIN), body });
    const [a, b] = await Promise.all([put({ addLeaveDays: ['2026-10-20'] }), put({ addLeaveDays: ['2026-10-21'] })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    let p = await BdaProfileModel.findOne({ email: SID }).lean();
    assert.deepEqual([...p.leaveDays].sort(), ['2026-10-20', '2026-10-21']);
    const removed = await put({ removeLeaveDays: ['2026-10-20'] });
    assert.equal(removed.status, 200);
    p = await BdaProfileModel.findOne({ email: SID }).lean();
    assert.deepEqual(p.leaveDays, ['2026-10-21']);
    const conflicting = await put({ leaveDays: [], addLeaveDays: ['2026-10-22'] });
    assert.equal(conflicting.status, 422);
    assert.equal(conflicting.body.error.code, 'conflicting_list_edit');
    const added = await put({ addAliases: ['sid b'] });
    assert.equal(added.status, 200);
    assert.ok((await BdaProfileModel.findOne({ email: SID }).lean()).aliases.includes('sid b'));
  });
});

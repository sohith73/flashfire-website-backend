import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { DateTime } from 'luxon';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';

isolateExternalServices();

import { getCrmJwtSecret, requireBdaExtension, requireCrmUser } from '../Middlewares/CrmAuth.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaAttendanceWarnDedupeModel } from '../Schema_Models/BdaAttendanceWarnDedupe.js';
import { BdaExtensionHeartbeatModel } from '../Schema_Models/BdaExtensionHeartbeat.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { crmMe } from '../Controllers/CrmAuthController.js';
import { markAbsent, reportJoin, warnAbsent, getMyMeetings, manualMark } from '../Controllers/BdaAttendanceController.js';
import { registerAttendanceRoutes, markPresentRateLimit } from '../Routes/attendanceRoutes.js';
import { EVENTS, attendanceEvents } from '../Utils/attendanceEvents.js';
import {
  computeVerdictHealth,
  resetSyncAlertState,
  runHeartbeatAlert,
  runIntegrityCheck,
  runNeedsReassignmentPost,
  runSyncHealthAlert,
  runVerdictPass,
} from '../Utils/AttendanceVerdictJob.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { getAttendanceRowFields } from '../Utils/attendanceRowFields.js';
import { recordPresentSignal } from '../Utils/recordPresentSignal.js';

// Random per run: other agents run suites in parallel against the same throwaway database.
const RUN = Math.random().toString(36).slice(2, 8);
const D = `att-${RUN}.test.invalid`;
const PREFIX = `__att_${RUN}_`;
const SID = `sid@${D}`;
const KAL = `kal@${D}`;
const ADMIN = `admin@${D}`;
const PLAIN = `plain@${D}`;
const NOBODY = `nobody@${D}`;
const DISCORD_ID = '123456789012345678';
const FILTER = { bookingId: { $regex: `^${PREFIX}` } };
const MIN = 60 * 1000;

let server;
let base;
let seq = 0;
const events = { verdict: [], corrected: [], integrity: [] };

const crmToken = (email) => jwt.sign({ role: 'crm_user', email, name: email.split('@')[0] }, getCrmJwtSecret(), { expiresIn: '1h' });
const adminToken = () => jwt.sign({ role: 'crm_admin', email: `ca@${D}`, name: 'CA' }, getCrmJwtSecret(), { expiresIn: '1h' });
const extToken = (email) => jwt.sign({ role: 'bda_extension', email, name: email.split('@')[0] }, getCrmJwtSecret(), { expiresIn: '1h' });

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function mkBooking({ start, host = SID, status = 'scheduled', extra = {} }) {
  const bookingId = `${PREFIX}${++seq}`;
  await CampaignBookingModel.create({
    bookingId,
    clientName: `Client ${seq}`,
    clientEmail: `${bookingId}@${D}`,
    bookingStatus: status,
    utmSource: 'direct',
    scheduledEventStartTime: new Date(start),
    scheduledEventEndTime: new Date(start + 30 * MIN),
    googleMeetCode: 'abc-defg-hij',
    googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
    calendlyHost: host ? { name: host.split('@')[0], email: host } : undefined,
    bookingCreatedAt: new Date(),
    ...extra,
  });
  return bookingId;
}

const fakeHealth = (over = {}) => ({
  recordSyncOk: async () => true,
  recordSyncError: async () => true,
  wasSourceHealthy: async () => true,
  syncOkBetween: async () => true,
  getAllSyncHealth: async () => [],
  ...over,
});

function mkDeps(extra = {}) {
  const posts = [];
  const admin = [];
  const attendance = [];
  const deps = {
    poster: async (m) => (posts.push(m), true),
    adminPoster: async (m) => (admin.push(m), true),
    attendancePoster: async (m) => (attendance.push(m), true),
    meetVerifier: async () => {},
    bookingFilter: FILTER,
    health: fakeHealth(),
    // The fixtures create their profiles right before their (past) bookings; the go-live rule has its own tests.
    ignoreGoLive: true,
    ...extra,
  };
  return { posts, admin, attendance, deps };
}

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const rowOf = (bookingId, email = SID) => BdaAttendanceModel.findOne({ bookingId, bdaEmail: email }).lean();
const istDay = (ms) => DateTime.fromMillis(ms, { zone: 'Asia/Kolkata' }).toFormat('yyyy-LL-dd');

const domainRe = { $regex: `@${D.replace(/\./g, '\\.')}$` };
async function cleanup() {
  // Independent collections, so the round trips to the remote test database run side by side.
  await Promise.all([
    CampaignBookingModel.deleteMany(FILTER),
    BdaAttendanceModel.deleteMany(FILTER),
    BdaAttendanceWarnDedupeModel.deleteMany({ bookingId: { $regex: `^(needs_reassignment:)?${PREFIX}` } }),
    BdaDeductionModel.deleteMany(FILTER),
    BdaExtensionHeartbeatModel.deleteMany({ bdaEmail: domainRe }),
    BdaProfileModel.deleteMany({ email: domainRe }),
    CrmUserModel.deleteMany({ email: domainRe }),
  ]);
  invalidateRegistryCache();
}

const onVerdict = (p) => p.bookingId.startsWith(PREFIX) && events.verdict.push(p);
const onCorrected = (p) => p.bookingId.startsWith(PREFIX) && events.corrected.push(p);
const onIntegrity = (p) => p.bookingId.startsWith(PREFIX) && events.integrity.push(p);

before(async () => {
  await connectTestDb();
  await Promise.all([
    BdaAttendanceModel.init(),
    BdaProfileModel.init(),
    CampaignBookingModel.init(),
    CrmUserModel.init(),
    BdaDeductionModel.init(),
    BdaExtensionHeartbeatModel.init(),
    BdaAttendanceWarnDedupeModel.init(),
  ]);
  attendanceEvents.on(EVENTS.VERDICT, onVerdict);
  attendanceEvents.on(EVENTS.VERDICT_CORRECTED, onCorrected);
  attendanceEvents.on(EVENTS.INTEGRITY_FLAGGED, onIntegrity);

  const app = express();
  app.use(express.json());
  registerAttendanceRoutes(app);
  app.get('/api/crm/me', requireCrmUser, crmMe);
  app.get('/api/bda-attendance/my-meetings', requireBdaExtension, getMyMeetings);
  app.post('/api/bda-attendance/report-join', requireBdaExtension, reportJoin);
  app.post('/api/bda-attendance/mark-absent', requireBdaExtension, markAbsent);
  app.post('/api/bda-attendance/warn-absent', requireBdaExtension, warnAbsent);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  attendanceEvents.off(EVENTS.VERDICT, onVerdict);
  attendanceEvents.off(EVENTS.VERDICT_CORRECTED, onCorrected);
  attendanceEvents.off(EVENTS.INTEGRITY_FLAGGED, onIntegrity);
  await cleanup();
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanup();
  events.verdict.length = events.corrected.length = events.integrity.length = 0;
  markPresentRateLimit.reset();
  resetSyncAlertState();
  delete process.env.MIN_EXTENSION_VERSION;
  await Promise.all([
    CrmUserModel.create([
      { email: ADMIN, name: 'Admin', role: 'admin' },
      { email: PLAIN, name: 'Plain', role: 'bda' },
      { email: SID, name: 'Siddhartha', role: 'bda' },
      { email: KAL, name: 'Kalpataru', role: 'bda' },
    ]),
    BdaProfileModel.create([
      { email: SID, displayName: 'Siddhartha', firstName: `sid${RUN}`, lastName: 'b', tracked: true, discordUserId: DISCORD_ID },
      { email: KAL, displayName: 'Kalpataru', firstName: `kal${RUN}`, lastName: 's', tracked: true },
    ]),
  ]);
});

// ---------------------------------------------------------------------------
describe('mark window and verdict (plan 2.2, 5.6)', () => {
  it('a button at +59 s is present', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(start + 59 * 1000) });
    assert.equal(r.ok, true);
    assert.equal(r.counted, true);

    const { deps, posts } = mkDeps();
    const out = await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.deepEqual(out.verdicts.map((v) => v.verdict), ['present']);
    const row = await rowOf(bookingId);
    assert.equal(row.verdict, 'present');
    assert.equal(row.verdictSignal, 'button_meet');
    assert.equal(new Date(row.markedPresentAt).getTime(), start + 59 * 1000);
    assert.equal(posts.length, 0, 'present posts nothing');
  });

  it('a button at +61 s is rejected with window_closed and the verdict is absent, with one Discord post', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'button_crm', receivedAt: new Date(start + 61 * 1000) });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.code, 'window_closed');

    const { deps, posts } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal((await rowOf(bookingId)).verdict, 'absent');
    assert.equal(posts.length, 1);
    assert.match(posts[0], /^🚫 \*\*BDA Absent\*\*\n\*\*BDA:\*\* Siddhartha \(/);
    assert.match(posts[0], /\*\*Client:\*\* Client \d+\n/);
    assert.match(posts[0], /\*\*Not marked present by:\*\* \d{1,2}:\d{2} [AP]M\n/);
    assert.ok(!posts[0].includes('A fine applies'), 'no fine promise while DEDUCTIONS_MODE is not live');
    assert.ok(!posts[0].includes('—'), 'no em dash');
  });

  it('a button at start - 6 min is rejected with window_not_open and the opening time', async () => {
    const start = Date.now() + 30 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(start - 6 * MIN) });
    assert.equal(r.code, 'window_not_open');
    assert.equal(r.status, 409);
    assert.equal(r.windowOpensAt, new Date(start - 5 * MIN).toISOString());
    const ok = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(start - 5 * MIN) });
    assert.equal(ok.ok, true, 'the window opens exactly at start - 5 min');
  });

  it('uses the server time for button clicks, ignoring any event time sent', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await recordPresentSignal({
      bookingId,
      bdaEmail: SID,
      kind: 'button_meet',
      eventAt: new Date(start - MIN), // a client claiming it clicked early
      receivedAt: new Date(start + 70 * 1000),
    });
    assert.equal(r.code, 'window_closed');
  });

  it('is idempotent: a repeat click returns the first mark, even after the window closed', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const first = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(start + 10 * 1000) });
    const again = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(start + 5 * MIN) });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(new Date(again.markedPresentAt).getTime(), new Date(first.markedPresentAt).getTime());
    assert.equal((await rowOf(bookingId)).signals.length, 1);
  });

  it('a Google signal that lands at +80 s with eventAt +20 s makes the verdict present', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const { deps } = mkDeps({
      meetVerifier: async () => {
        await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'google_meet', eventAt: new Date(start + 20 * 1000), matchedBy: 'stable_id', receivedAt: new Date(start + 80 * 1000) });
      },
    });
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    const row = await rowOf(bookingId);
    assert.equal(row.verdict, 'present');
    assert.equal(row.verdictSignal, 'google_meet');
    assert.equal(row.matchedBy ?? 'stable_id', 'stable_id');
  });

  it('a Google signal matched only by name never decides a verdict', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'google_meet', eventAt: new Date(start + 20 * 1000), matchedBy: 'name' });
    assert.equal(r.marked, false);
    assert.equal(r.ignored, 'not_stable_id');
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal((await rowOf(bookingId)).verdict, 'absent');
  });

  it('an extension join at +2 min is absent, but in time and signal are still recorded', async () => {
    // The join reaches the server as it happens (real joins arrive within seconds), so no back-dating cap applies.
    const start = Date.now() - 2 * MIN - 5000;
    const bookingId = await mkBooking({ start });
    const joinedAt = new Date(start + 2 * MIN).toISOString();
    const r = await call('POST', '/api/bda-attendance/report-join', {
      token: extToken(SID),
      body: { bookingId, meetLink: 'https://meet.google.com/abc-defg-hij', joinedAt },
    });
    assert.equal(r.status, 200);

    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    const row = await rowOf(bookingId);
    assert.equal(row.verdict, 'absent');
    assert.equal(new Date(row.firstJoinedAt).toISOString(), joinedAt);
    assert.deepEqual(row.signals.map((s) => s.kind), ['extension_join']);
    assert.equal(new Date(row.signals[0].eventAt).toISOString(), joinedAt);
    assert.equal(row.markedPresentAt, null, 'a late join does not count as a mark in time');
  });

  it('a timely extension join is present via extension_join', async () => {
    const start = Date.now() - 30 * 1000 - 5000; // the join at +30 s reaches the server right away
    const bookingId = await mkBooking({ start });
    await call('POST', '/api/bda-attendance/report-join', {
      token: extToken(SID),
      body: { bookingId, meetLink: 'https://meet.google.com/abc-defg-hij', joinedAt: new Date(start + 30 * 1000).toISOString() },
    });
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    const row = await rowOf(bookingId);
    assert.equal(row.verdict, 'present');
    assert.equal(row.verdictSignal, 'extension_join');
  });

  it('a BDA who is not assigned gets 403 not_assigned, an untracked assignee 403 not_tracked', async () => {
    const start = Date.now() + 2 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await call('POST', `/api/crm/attendance/${bookingId}/mark-present`, { token: crmToken(KAL), body: {} });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'not_assigned');
    assert.equal(r.body.success, false);
    assert.equal(await rowOf(bookingId, KAL), null);

    const admin = await call('POST', `/api/crm/attendance/${bookingId}/mark-present`, { token: crmToken(ADMIN), body: {} });
    assert.equal(admin.body.error.code, 'not_assigned', 'an admin cannot mark a BDA present');

    await BdaProfileModel.updateOne({ email: SID }, { tracked: false });
    invalidateRegistryCache();
    const untracked = await call('POST', `/api/crm/attendance/${bookingId}/mark-present`, { token: crmToken(SID), body: {} });
    assert.equal(untracked.status, 403);
    assert.equal(untracked.body.error.code, 'not_tracked');
  });

  it('404 booking_not_found for an unknown booking', async () => {
    const r = await call('POST', `/api/crm/attendance/${PREFIX}missing/mark-present`, { token: crmToken(SID), body: {} });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'booking_not_found');
  });

  it('two verdict passes racing write exactly one verdict, one post and one event', async () => {
    const start = Date.now() - 10 * MIN;
    const absentId = await mkBooking({ start });
    const presentId = await mkBooking({ start });
    await recordPresentSignal({ bookingId: presentId, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(start) });

    const one = mkDeps();
    const two = mkDeps();
    const now = new Date(start + 215 * 1000);
    const [a, b] = await Promise.all([runVerdictPass(now, one.deps), runVerdictPass(now, two.deps)]);
    await flush();

    assert.equal(a.verdicts.length + b.verdicts.length, 2, 'two bookings, each judged once in total');
    assert.equal(one.posts.length + two.posts.length, 1, 'one absent post');
    assert.equal(events.verdict.length, 2);
    assert.equal(events.verdict.filter((e) => e.bookingId === absentId).length, 1);
    assert.equal((await rowOf(absentId)).verdict, 'absent');
    assert.equal((await rowOf(presentId)).verdict, 'present');
    assert.equal(await BdaAttendanceModel.countDocuments({ bookingId: absentId }), 1);
  });

  it('never judges a booking canceled before it started, and never posts about it', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({
      start,
      status: 'canceled',
      extra: { statusHistory: [{ status: 'canceled', previousStatus: 'scheduled', changedAt: new Date(start - 60 * MIN), source: 'calendly' }] },
    });
    const { deps, posts } = mkDeps();
    const out = await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal(out.verdicts.length, 0);
    assert.equal(await rowOf(bookingId), null);
    assert.equal(posts.length, 0);
  });

  it('still judges a booking that was canceled after it started', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({
      start,
      status: 'canceled',
      extra: {
        statusHistory: [
          { status: 'scheduled', previousStatus: null, changedAt: new Date(start - 24 * 60 * MIN), source: 'calendly' },
          { status: 'canceled', previousStatus: 'scheduled', changedAt: new Date(start + 10 * MIN), source: 'calendly' },
        ],
      },
    });
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal((await rowOf(bookingId)).verdict, 'absent');
  });

  it('a late in-time Google signal after an absent verdict flips it to present, with one correction', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal((await rowOf(bookingId)).verdict, 'absent');

    const corrections = [];
    const late = { bookingId, bdaEmail: SID, kind: 'google_meet', eventAt: new Date(start + 20 * 1000), matchedBy: 'stable_id' };
    const r = await recordPresentSignal(late, { postCorrection: async (m) => corrections.push(m) });
    assert.deepEqual(r.correction, { signal: 'google_meet' });
    const again = await recordPresentSignal(late, { postCorrection: async (m) => corrections.push(m) });
    assert.equal(again.correction, null);
    await flush();

    const row = await rowOf(bookingId);
    assert.equal(row.verdict, 'present');
    assert.equal(row.verdictSignal, 'google_meet');
    assert.ok(row.verdictCorrectedAt);
    assert.equal(corrections.length, 1);
    assert.match(corrections[0], /Correction/);
    assert.ok(!corrections[0].includes('—'));
    assert.equal(events.corrected.length, 1);
    assert.equal(events.corrected[0].bdaEmail, SID);
    assert.equal(events.corrected[0].signal, 'google_meet');
  });

  it('late evidence that is itself late (+2 min) does not flip an absent verdict', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    const r = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'extension_join', eventAt: new Date(start + 2 * MIN) });
    assert.equal(r.counted, false);
    assert.equal(r.correction, null);
    assert.equal((await rowOf(bookingId)).verdict, 'absent');
  });

  it('a present verdict never flips to absent, whatever arrives later', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(start) });
    const { deps, posts } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);

    await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'extension_join', eventAt: new Date(start + 10 * MIN) });
    await runVerdictPass(new Date(start + 5 * MIN), deps);
    await runVerdictPass(new Date(start + 5 * 60 * MIN), deps);
    const row = await rowOf(bookingId);
    assert.equal(row.verdict, 'present');
    assert.equal(row.verdictCorrectedAt, null);
    assert.equal(posts.length, 0);
  });

  it('a colleague covering gets their own row; the assigned BDA is judged on their own signals', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start, host: SID });
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal((await rowOf(bookingId, SID)).verdict, 'absent');

    // KAL joins on time-ish, after SID's verdict. SID's verdict row must survive the phantom-row cleanup.
    const r = await call('POST', '/api/bda-attendance/report-join', {
      token: extToken(KAL),
      body: { bookingId, meetLink: 'https://meet.google.com/abc-defg-hij', joinedAt: new Date(start + 20 * 1000).toISOString() },
    });
    assert.equal(r.status, 200);
    const kal = await rowOf(bookingId, KAL);
    assert.deepEqual(kal.signals.map((s) => s.kind), ['extension_join']);
    assert.equal(kal.verdict, null, 'a covering BDA is never judged');
    const sid = await rowOf(bookingId, SID);
    assert.equal(sid.verdict, 'absent');
    assert.equal(sid.signals.length, 0);
  });

  it('a meeting on the BDA leave day gets no verdict', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    await BdaProfileModel.updateOne({ email: SID }, { leaveDays: [istDay(start)] });
    invalidateRegistryCache();
    const { deps, posts } = mkDeps();
    const out = await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal(out.verdicts.length, 0);
    assert.equal(await rowOf(bookingId), null);
    assert.equal(posts.length, 0);
  });

  it('an untracked BDA gets no verdict', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start, host: NOBODY });
    const { deps } = mkDeps();
    const out = await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal(out.verdicts.length, 0);
    assert.equal(await rowOf(bookingId, NOBODY), null);
  });

  it('does nothing before start + 3 min 30 s (window + 2 min minimum stay + settle)', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 90 * 1000), deps);
    assert.equal(await rowOf(bookingId), null);
    await runVerdictPass(new Date(start + 200 * 1000), deps);
    assert.equal(await rowOf(bookingId), null);
    await runVerdictPass(new Date(start + 210 * 1000), deps);
    assert.equal((await rowOf(bookingId)).verdict, 'absent');
  });

  it('calls the Meet verifier once per meeting and judges from what it stored', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    let calls = 0;
    const { deps } = mkDeps({ meetVerifier: async (b) => { calls++; assert.equal(b.bookingId, bookingId); } });
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    await runVerdictPass(new Date(start + 230 * 1000), deps);
    assert.equal(calls, 1);
  });

  it('a verdict is judged for the new assignee after a reassignment', async () => {
    const start = Date.now() + 60 * MIN;
    const bookingId = await mkBooking({ start, host: SID });
    const r = await call('PUT', `/api/crm/admin/bookings/${bookingId}/attendance-assignee`, { token: adminToken(), body: { email: KAL } });
    assert.equal(r.status, 200);
    assert.equal(r.body.booking.assignedBdaEmail, KAL);

    await recordPresentSignal({ bookingId, bdaEmail: KAL, kind: 'button_crm', receivedAt: new Date(start - MIN) });
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal((await rowOf(bookingId, KAL)).verdict, 'present');
    assert.equal(await rowOf(bookingId, SID), null, 'the old assignee is not judged');
  });
});

// ---------------------------------------------------------------------------
describe('verdict health flag (plan 2.7)', () => {
  const payload = (start, nowMs) => ({ startMs: start, nowMs, bdaEmail: SID });

  it('is healthy when the job is on time and Google is fresh', async () => {
    const start = Date.now() - 10 * MIN;
    const { deps } = mkDeps();
    assert.equal(await computeVerdictHealth(payload(start, start + 215 * 1000), { ...deps, getHeartbeat: async () => null }), true);
  });

  it('is unhealthy when Google is stale and the extension sent no heartbeat, healthy when it did', async () => {
    const start = Date.now() - 10 * MIN;
    const staleGoogle = fakeHealth({ wasSourceHealthy: async () => false });
    const none = { ...mkDeps({ health: staleGoogle }).deps, getHeartbeat: async () => null };
    assert.equal(await computeVerdictHealth(payload(start, start + 215 * 1000), none), false);
    const beat = { ...none, getHeartbeat: async () => ({ lastHeartbeatAt: new Date(start - MIN) }) };
    assert.equal(await computeVerdictHealth(payload(start, start + 215 * 1000), beat), true);
  });

  it('is unhealthy when the job did not run between start + 60 s and start + 5 min', async () => {
    const start = Date.now() - 60 * MIN;
    const down = { ...mkDeps({ health: fakeHealth({ syncOkBetween: async () => false }) }).deps, getHeartbeat: async () => null };
    assert.equal(await computeVerdictHealth(payload(start, start + 20 * MIN), down), false);
  });

  it('puts healthy on the VERDICT event', async () => {
    const start = Date.now() - 10 * MIN;
    const a = await mkBooking({ start });
    const { deps } = mkDeps({ health: fakeHealth({ wasSourceHealthy: async () => false }), getHeartbeat: async () => null });
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    await flush();
    const e = events.verdict.find((x) => x.bookingId === a);
    assert.equal(e.healthy, false);
    assert.equal(e.verdict, 'absent');
    assert.equal(e.bdaEmail, SID);
    assert.equal(new Date(e.scheduledStart).getTime(), start);
    assert.ok(e.verdictAt instanceof Date);
    assert.ok(Array.isArray(e.signals));
  });
});

// ---------------------------------------------------------------------------
describe('integrity check', () => {
  async function presentByButton(startOffsetMs, kind = 'button_crm', extraSignals = [], rowExtra = {}) {
    const start = Date.now() + startOffsetMs;
    const bookingId = await mkBooking({ start });
    await BdaAttendanceModel.create({
      bookingId,
      bdaEmail: SID,
      bdaName: 'Siddhartha',
      status: 'manual',
      source: 'manual',
      meetingScheduledStart: new Date(start),
      signals: [{ kind, eventAt: new Date(start - MIN), receivedAt: new Date(start - MIN) }, ...extraSignals],
      markedPresentAt: new Date(start - MIN),
      verdict: 'present',
      verdictAt: new Date(start + 215 * 1000),
      verdictSignal: kind,
      ...rowExtra,
    });
    return { bookingId, start };
  }

  it('flags a button-only present older than 3 h, emits the event and writes no deduction', async () => {
    const { bookingId } = await presentByButton(-4 * 60 * MIN);
    const { deps } = mkDeps();
    const out = await runIntegrityCheck(new Date(), deps);
    await flush();
    assert.deepEqual(out.flagged.map((f) => f.bookingId), [bookingId]);
    assert.equal((await rowOf(bookingId)).integrityFlag, 'marked_never_joined');
    assert.equal(events.integrity.length, 1);
    assert.equal(events.integrity[0].signal, 'button_crm');
    assert.equal(await BdaDeductionModel.countDocuments({ bookingId }), 0);
    // A second pass flags nothing new.
    assert.equal((await runIntegrityCheck(new Date(), deps)).flagged.length, 0);
  });

  it('does not flag before 3 h, or when the extension or Google saw the BDA', async () => {
    const young = await presentByButton(-2 * 60 * MIN);
    const ext = await presentByButton(-4 * 60 * MIN, 'button_meet', [{ kind: 'extension_join', eventAt: new Date(), receivedAt: new Date() }]);
    const google = await presentByButton(-4 * 60 * MIN, 'button_meet', [], { source: 'meet_api', matchedBy: 'stable_id', firstJoinedAt: new Date() });
    const byName = await presentByButton(-4 * 60 * MIN, 'button_meet', [], { source: 'meet_api', matchedBy: 'name', firstJoinedAt: new Date() });
    const { deps } = mkDeps();
    const out = await runIntegrityCheck(new Date(), deps);
    assert.deepEqual(out.flagged.map((f) => f.bookingId), [byName.bookingId], 'a name match is not proof');
    for (const b of [young, ext, google]) assert.equal((await rowOf(b.bookingId)).integrityFlag, null);
  });
});

// ---------------------------------------------------------------------------
describe('heartbeat alert', () => {
  it('warns once, 9 to 11 minutes before, mentioning the BDA, and dedupes', async () => {
    const bookingId = await mkBooking({ start: Date.now() + 10 * MIN });
    const { deps, attendance } = mkDeps();
    const now = new Date();
    const first = await runHeartbeatAlert(now, deps);
    assert.deepEqual(first.warned.map((w) => w.bookingId), [bookingId]);
    assert.equal(attendance.length, 1);
    assert.match(attendance[0], new RegExp(`^<@${DISCORD_ID}> your attendance extension is offline\\. Open Chrome with your work profile before your \\d{1,2}:\\d{2} [AP]M meeting\\.$`));
    assert.ok((await rowOf(bookingId)).heartbeatWarnedAt);

    await runHeartbeatAlert(new Date(now.getTime() + 60 * 1000), deps);
    assert.equal(attendance.length, 1, 'no second warning for the same meeting');
  });

  it('names the BDA in bold when there is no Discord id', async () => {
    await mkBooking({ start: Date.now() + 10 * MIN, host: KAL });
    const { deps, attendance } = mkDeps();
    await runHeartbeatAlert(new Date(), deps);
    assert.match(attendance[0], /^\*\*Kalpataru\*\* your attendance extension is offline/);
  });

  it('stays quiet for a fresh heartbeat, warns for a stale one, ignores meetings outside 9 to 11 min', async () => {
    const soon = await mkBooking({ start: Date.now() + 10 * MIN });
    await mkBooking({ start: Date.now() + 20 * MIN, host: KAL });
    await mkBooking({ start: Date.now() + 5 * MIN, host: KAL });
    await BdaExtensionHeartbeatModel.create({ bdaEmail: SID, lastHeartbeatAt: new Date(Date.now() - 2 * MIN) });
    const { deps, attendance } = mkDeps();
    assert.equal((await runHeartbeatAlert(new Date(), deps)).warned.length, 0);

    await BdaExtensionHeartbeatModel.updateOne({ bdaEmail: SID }, { lastHeartbeatAt: new Date(Date.now() - 6 * MIN) });
    const out = await runHeartbeatAlert(new Date(), deps);
    assert.deepEqual(out.warned.map((w) => w.bookingId), [soon]);
    assert.equal(attendance.length, 1);
  });

  it('skips a leave-day meeting and an untracked BDA', async () => {
    const start = Date.now() + 10 * MIN;
    await mkBooking({ start });
    await mkBooking({ start, host: NOBODY });
    await BdaProfileModel.updateOne({ email: SID }, { leaveDays: [istDay(start)] });
    invalidateRegistryCache();
    const { deps, attendance } = mkDeps();
    assert.equal((await runHeartbeatAlert(new Date(), deps)).warned.length, 0);
    assert.equal(attendance.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('needs reassignment (leave days)', () => {
  const tomorrowNoon = () => DateTime.now().setZone('Asia/Kolkata').plus({ days: 1 }).set({ hour: 12, minute: 0, second: 0, millisecond: 0 }).toMillis();

  it('posts tomorrow leave-day meetings once, and lists them in the review queue', async () => {
    const start = tomorrowNoon();
    const bookingId = await mkBooking({ start });
    await BdaProfileModel.updateOne({ email: SID }, { leaveDays: [istDay(start)] });
    invalidateRegistryCache();
    const { deps, admin } = mkDeps();
    const out = await runNeedsReassignmentPost(new Date(), deps);
    assert.deepEqual(out.posted.map((p) => p.bookingId), [bookingId]);
    assert.equal(admin.length, 1);
    assert.match(admin[0], /Needs a new BDA tomorrow/);
    assert.match(admin[0], /Siddhartha is on leave/);
    assert.equal((await runNeedsReassignmentPost(new Date(), deps)).posted.length, 0, 'announced once');

    const q = await call('GET', '/api/crm/admin/attendance/review-queues', { token: adminToken() });
    const item = q.body.needsReassignment.find((x) => x.bookingId === bookingId);
    assert.deepEqual(item, {
      bookingId,
      clientName: item.clientName,
      scheduledStart: new Date(start).toISOString(),
      assignedBdaEmail: SID,
      reason: 'leave',
    });
  });

  it('ignores a BDA who is not on leave', async () => {
    await mkBooking({ start: tomorrowNoon() });
    const { deps, admin } = mkDeps();
    assert.equal((await runNeedsReassignmentPost(new Date(), deps)).posted.length, 0);
    assert.equal(admin.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('sync health alert', () => {
  const at = (hourIst) => new Date(DateTime.now().setZone('Asia/Kolkata').set({ hour: hourIst, minute: 30 }).toMillis());
  const rows = (googleAgeMin, zoomAgeMin, now) => [
    { source: 'google_meet', lastOkAt: googleAgeMin == null ? null : new Date(now.getTime() - googleAgeMin * MIN), lastError: 'boom' },
    { source: 'zoom_phone', lastOkAt: new Date(now.getTime() - zoomAgeMin * MIN), lastError: null },
    { source: 'verdict_job', lastOkAt: new Date(now.getTime() - 10 * 1000), lastError: null },
  ];

  it('alerts the admin channel when Google is stale during working hours, once per hour', async () => {
    const now = at(12);
    const { deps, admin } = mkDeps({ health: fakeHealth({ getAllSyncHealth: async () => rows(20, 5, now) }) });
    const out = await runSyncHealthAlert(now, deps);
    assert.deepEqual(out.alerts, ['google_meet']);
    assert.match(admin[0], /Google Meet sync is stale/);
    assert.match(admin[0], /boom/);
    await runSyncHealthAlert(new Date(now.getTime() + 5 * MIN), deps);
    assert.equal(admin.length, 1, 'not repeated within the hour');
  });

  it('alerts for Zoom after 30 min, and when Google has never synced', async () => {
    const now = at(12);
    const { deps, admin } = mkDeps({ health: fakeHealth({ getAllSyncHealth: async () => rows(null, 31, now) }) });
    const out = await runSyncHealthAlert(now, deps);
    assert.deepEqual(out.alerts.sort(), ['google_meet', 'zoom_phone']);
    assert.ok(admin.some((m) => /never synced/.test(m)));
  });

  it('stays quiet when healthy, or outside working hours', async () => {
    const noon = at(12);
    const fresh = mkDeps({ health: fakeHealth({ getAllSyncHealth: async () => rows(2, 5, noon) }) });
    assert.equal((await runSyncHealthAlert(noon, fresh.deps)).alerts.length, 0);

    const night = at(3);
    const quiet = mkDeps({ health: fakeHealth({ getAllSyncHealth: async () => rows(60, 60, night) }) });
    assert.equal((await runSyncHealthAlert(night, quiet.deps)).alerts.length, 0);
    assert.equal(quiet.admin.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('endpoints', () => {
  it('extension mark-present: 200 shape, idempotent, and the row carries a button_meet signal', async () => {
    const start = Date.now() + 2 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await call('POST', '/api/bda-attendance/mark-present', { token: extToken(SID), body: { bookingId, clientNow: new Date(0).toISOString() } });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.marked, true);
    assert.ok(Math.abs(new Date(r.body.markedPresentAt).getTime() - Date.now()) < 5000, 'server time, not the client clientNow');
    const again = await call('POST', '/api/bda-attendance/mark-present', { token: extToken(SID), body: { bookingId } });
    assert.equal(again.body.markedPresentAt, r.body.markedPresentAt);
    const row = await rowOf(bookingId);
    assert.deepEqual(row.signals.map((s) => s.kind), ['button_meet']);
    assert.equal(row.status, 'manual');
  });

  it('extension mark-present: 409 bodies carry error.code and the window times at the top level', async () => {
    const bookingId = await mkBooking({ start: Date.now() + 60 * MIN });
    const r = await call('POST', '/api/bda-attendance/mark-present', { token: extToken(SID), body: { bookingId } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'window_not_open');
    assert.ok(r.body.windowOpensAt);
    const closed = await mkBooking({ start: Date.now() - 5 * MIN });
    const c = await call('POST', '/api/bda-attendance/mark-present', { token: extToken(SID), body: { bookingId: closed } });
    assert.equal(c.status, 409);
    assert.equal(c.body.error.code, 'window_closed');
  });

  it('CRM mark-present: stores button_crm with the CRM user email', async () => {
    const bookingId = await mkBooking({ start: Date.now() + 2 * MIN });
    const r = await call('POST', `/api/crm/attendance/${bookingId}/mark-present`, { token: crmToken(SID), body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.marked, true);
    assert.deepEqual((await rowOf(bookingId)).signals.map((s) => s.kind), ['button_crm']);
  });

  it('401 without a token', async () => {
    assert.equal((await call('POST', '/api/bda-attendance/mark-present', { body: {} })).status, 401);
    assert.equal((await call('GET', '/api/crm/attendance/my-window')).status, 401);
    assert.equal((await call('GET', '/api/crm/admin/attendance/health')).status, 401);
  });

  it('rate limits both mark-present endpoints at 10 per minute per user, with 429 rate_limited', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await call('POST', `/api/crm/attendance/${PREFIX}x/mark-present`, { token: crmToken(PLAIN), body: {} });
      assert.equal(r.status, 404);
    }
    const blocked = await call('POST', `/api/crm/attendance/${PREFIX}x/mark-present`, { token: crmToken(PLAIN), body: {} });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.equal(blocked.body.success, false);
    // Another user is unaffected, and so is the same user after the window passes (reset stands in for time).
    assert.equal((await call('POST', `/api/crm/attendance/${PREFIX}x/mark-present`, { token: crmToken(KAL), body: {} })).status, 404);

    markPresentRateLimit.reset();
    for (let i = 0; i < 10; i++) await call('POST', '/api/bda-attendance/mark-present', { token: extToken(PLAIN), body: { bookingId: `${PREFIX}x` } });
    const ext = await call('POST', '/api/bda-attendance/mark-present', { token: extToken(PLAIN), body: { bookingId: `${PREFIX}x` } });
    assert.equal(ext.status, 429);
    assert.equal(ext.body.error.code, 'rate_limited');
  });

  it('mark-absent and warn-absent are no-ops that write nothing', async () => {
    const bookingId = await mkBooking({ start: Date.now() - 6 * MIN });
    for (const path of ['mark-absent', 'warn-absent']) {
      const r = await call('POST', `/api/bda-attendance/${path}`, { token: extToken(SID), body: { bookingId } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true, skipped: true, reason: 'server_decides' });
    }
    assert.equal(await BdaAttendanceModel.countDocuments({ bookingId }), 0);
  });

  it('heartbeat stores the extension state and whether the profile matches', async () => {
    const ok = await call('POST', '/api/bda-attendance/heartbeat', {
      token: extToken(SID),
      // Same name on another COMPANY domain: the Workspace account can differ from the CRM login's domain.
      body: { version: '2.0.0', profileEmail: `SID@flashfirejobs.com`, meetTabs: [{ code: 'abc-defg-hij', inCall: true }, { code: 5 }], loggedIn: true },
    });
    assert.deepEqual(ok.body, { success: true });
    const beat = await BdaExtensionHeartbeatModel.findOne({ bdaEmail: SID }).lean();
    assert.equal(beat.version, '2.0.0');
    assert.equal(beat.profileEmail, 'sid@flashfirejobs.com');
    assert.equal(beat.profileMatchesLogin, true, 'same name on a company domain matches');
    assert.deepEqual(beat.meetTabs, [{ code: 'abc-defg-hij', inCall: true }, { code: null, inCall: null }]);
    assert.ok(Date.now() - new Date(beat.lastHeartbeatAt).getTime() < 5000);

    await call('POST', '/api/bda-attendance/heartbeat', { token: extToken(SID), body: { version: '2.0.0', profileEmail: 'feedback.flashfire@gmail.com', meetTabs: [] } });
    assert.equal((await BdaExtensionHeartbeatModel.findOne({ bdaEmail: SID }).lean()).profileMatchesLogin, false);
    // Same name on a personal domain is a different Google account: Meet records would not match the BDA.
    await call('POST', '/api/bda-attendance/heartbeat', { token: extToken(SID), body: { version: '2.0.0', profileEmail: 'sid@gmail.com', meetTabs: [] } });
    assert.equal((await BdaExtensionHeartbeatModel.findOne({ bdaEmail: SID }).lean()).profileMatchesLogin, false);
    await call('POST', '/api/bda-attendance/heartbeat', { token: extToken(SID), body: {} });
    assert.equal((await BdaExtensionHeartbeatModel.findOne({ bdaEmail: SID }).lean()).profileMatchesLogin, null);
  });

  it('crmMe returns isAdmin, true for role admin and for isAdmin with role bda, false otherwise', async () => {
    await CrmUserModel.create({ email: `flag@${D}`, name: 'Flag', role: 'bda', isAdmin: true });
    assert.equal((await call('GET', '/api/crm/me', { token: crmToken(ADMIN) })).body.user.isAdmin, true);
    assert.equal((await call('GET', '/api/crm/me', { token: crmToken(`flag@${D}`) })).body.user.isAdmin, true);
    const plain = await call('GET', '/api/crm/me', { token: crmToken(PLAIN) });
    assert.equal(plain.body.user.isAdmin, false);
    assert.equal(plain.body.user.role, 'bda');
  });

  it('my-meetings adds minExtensionVersion (only when set) and attendance.markedPresentAt', async () => {
    // Far in the past inside the 7 day horizon so a busy shared test database cannot push it past the page limit.
    const start = Date.now() - 6.9 * 24 * 60 * MIN;
    const bookingId = await mkBooking({ start });
    const markedAt = new Date(start - MIN);
    await BdaAttendanceModel.create({
      bookingId, bdaEmail: SID, bdaName: 'Siddhartha', status: 'manual', source: 'manual',
      meetingScheduledStart: new Date(start), markedPresentAt: markedAt,
      signals: [{ kind: 'button_meet', eventAt: markedAt, receivedAt: markedAt }],
    });
    const plain = await call('GET', '/api/bda-attendance/my-meetings', { token: extToken(SID) });
    assert.equal('minExtensionVersion' in plain.body, false);
    const mine = [...plain.body.upcoming, ...plain.body.previous].find((m) => m.bookingId === bookingId);
    assert.equal(mine.attendance.markedPresentAt, markedAt.toISOString());

    process.env.MIN_EXTENSION_VERSION = '2.0.0';
    const gated = await call('GET', '/api/bda-attendance/my-meetings', { token: extToken(SID) });
    assert.equal(gated.body.minExtensionVersion, '2.0.0');
  });

  it('my-meetings honours an attendance reassignment for assignedToMe', async () => {
    const start = Date.now() - 6.9 * 24 * 60 * MIN;
    const bookingId = await mkBooking({
      start, host: SID,
      extra: { attendanceAssignee: { email: KAL, name: 'Kalpataru', setBy: ADMIN, setAt: new Date() } },
    });
    const kal = await call('GET', '/api/bda-attendance/my-meetings', { token: extToken(KAL) });
    const sid = await call('GET', '/api/bda-attendance/my-meetings', { token: extToken(SID) });
    const find = (b) => [...b.upcoming, ...b.previous].find((m) => m.bookingId === bookingId);
    assert.equal(find(kal.body).assignedToMe, true);
    assert.equal(find(sid.body).assignedToMe, false);
  });
});

// ---------------------------------------------------------------------------
describe('my-window', () => {
  it('returns nothing for someone who is not a tracked BDA', async () => {
    const r = await call('GET', '/api/crm/attendance/my-window', { token: crmToken(PLAIN) });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.tracked, false);
    assert.equal(r.body.current, null);
    assert.equal(r.body.next, null);
    assert.ok(Math.abs(new Date(r.body.serverTime).getTime() - Date.now()) < 5000);
  });

  it('returns the current window with the contract shape, and marked after a mark', async () => {
    const start = Date.now() + 2 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await call('GET', '/api/crm/attendance/my-window', { token: crmToken(SID) });
    assert.equal(r.body.tracked, true);
    assert.deepEqual(Object.keys(r.body.current).sort(), [
      'bookingId', 'clientName', 'marked', 'markedPresentAt', 'scheduledStart', 'verdict', 'verdictSignal', 'windowClosesAt', 'windowOpensAt',
    ]);
    assert.equal(r.body.current.bookingId, bookingId);
    assert.equal(r.body.current.windowOpensAt, new Date(start - 5 * MIN).toISOString());
    assert.equal(r.body.current.windowClosesAt, new Date(start + 60 * 1000).toISOString());
    assert.equal(r.body.current.marked, false);

    await call('POST', `/api/crm/attendance/${bookingId}/mark-present`, { token: crmToken(SID), body: {} });
    const after = await call('GET', '/api/crm/attendance/my-window', { token: crmToken(SID) });
    assert.equal(after.body.current.marked, true);
    assert.ok(after.body.current.markedPresentAt);
  });

  it('does not show a colleague meeting, and puts a later meeting today under next', async () => {
    await mkBooking({ start: Date.now() + 2 * MIN, host: KAL });
    const later = await mkBooking({ start: Date.now() + 40 * MIN });
    const r = await call('GET', '/api/crm/attendance/my-window', { token: crmToken(SID) });
    assert.equal(r.body.current, null);
    const endOfToday = DateTime.now().setZone('Asia/Kolkata').endOf('day').toMillis();
    if (endOfToday - Date.now() > 2 * 60 * MIN) assert.equal(r.body.next?.bookingId, later);
  });
});

// ---------------------------------------------------------------------------
describe('my-month', () => {
  const monthOf = (ms) => DateTime.fromMillis(ms, { zone: 'Asia/Kolkata' }).toFormat('yyyy-LL');

  it('403 not_tracked for a user who is not a tracked BDA', async () => {
    const r = await call('GET', '/api/crm/attendance/my-month?month=2026-10', { token: crmToken(PLAIN) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'not_tracked');
  });

  it('422 invalid_month for a malformed month', async () => {
    for (const m of ['2026-13', '26-10', 'october', '2026-1']) {
      const r = await call('GET', `/api/crm/attendance/my-month?month=${m}`, { token: crmToken(SID) });
      assert.equal(r.status, 422, m);
      assert.equal(r.body.error.code, 'invalid_month');
    }
  });

  it('returns only my countable meetings for the month, newest first, with the contract keys always present', async () => {
    const t = Date.now();
    const older = await mkBooking({ start: t - 3 * 60 * MIN });
    const newer = await mkBooking({ start: t - 2 * 60 * MIN });
    await mkBooking({ start: t - 2 * 60 * MIN, host: KAL });
    await mkBooking({
      start: t - 90 * 60 * MIN,
      status: 'canceled',
      extra: { statusHistory: [{ status: 'canceled', previousStatus: 'scheduled', changedAt: new Date(t - 95 * 60 * MIN), source: 'calendly' }] },
    });
    await recordPresentSignal({ bookingId: newer, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(t - 2 * 60 * MIN) });

    const month = monthOf(t - 3 * 60 * MIN);
    const r = await call('GET', `/api/crm/attendance/my-month?month=${month}`, { token: crmToken(SID) });
    assert.equal(r.status, 200);
    assert.equal(r.body.month, month);
    const mine = r.body.rows.filter((x) => x.bookingId.startsWith(PREFIX));
    assert.deepEqual(mine.map((x) => x.bookingId).filter((id) => [older, newer].includes(id)), [newer, older]);
    assert.equal(mine.length, 2, 'colleague meeting and canceled meeting are left out');

    const row = mine[0];
    assert.deepEqual(Object.keys(row).sort(), ['attendance', 'bookingId', 'bookingStatus', 'callSummary', 'clientName', 'deductions', 'scheduledEnd', 'scheduledStart', 'statusUpdate', 'transcript']);
    assert.equal(row.transcript, null);
    assert.deepEqual(row.deductions, []);
    assert.equal(row.bookingStatus, 'scheduled');
    assert.equal(row.attendance.markedPresentAt, new Date(t - 2 * 60 * MIN).toISOString());
    assert.equal(row.attendance.verdict, null, 'no verdict yet');
    assert.deepEqual(row.attendance.signals.map((s) => s.kind), ['button_meet']);
  });

  it('defaults to the current IST month and returns an empty list for a month with nothing', async () => {
    const dflt = await call('GET', '/api/crm/attendance/my-month', { token: crmToken(SID) });
    assert.equal(dflt.status, 200);
    assert.equal(dflt.body.month, DateTime.now().setZone('Asia/Kolkata').toFormat('yyyy-LL'));
    const empty = await call('GET', '/api/crm/attendance/my-month?month=2001-01', { token: crmToken(SID) });
    assert.deepEqual(empty.body, { success: true, month: '2001-01', rows: [] });
  });

  it('puts a meeting at IST month boundaries in the right month', async () => {
    const lastNight = DateTime.fromISO('2026-10-31T23:30:00', { zone: 'Asia/Kolkata' }).toMillis();
    const firstMorning = DateTime.fromISO('2026-11-01T00:30:00', { zone: 'Asia/Kolkata' }).toMillis();
    const a = await mkBooking({ start: lastNight });
    const b = await mkBooking({ start: firstMorning });
    const oct = await call('GET', '/api/crm/attendance/my-month?month=2026-10', { token: crmToken(SID) });
    const nov = await call('GET', '/api/crm/attendance/my-month?month=2026-11', { token: crmToken(SID) });
    assert.ok(oct.body.rows.some((r) => r.bookingId === a) && !oct.body.rows.some((r) => r.bookingId === b));
    assert.ok(nov.body.rows.some((r) => r.bookingId === b) && !nov.body.rows.some((r) => r.bookingId === a));
  });
});

// ---------------------------------------------------------------------------
describe('admin: reassign', () => {
  it('sets the assignee, keeps a history entry and returns the new assignee', async () => {
    const start = Date.now() + 60 * MIN;
    const bookingId = await mkBooking({ start });
    const r = await call('PUT', `/api/crm/admin/bookings/${bookingId}/attendance-assignee`, { token: crmToken(ADMIN), body: { email: KAL.toUpperCase() } });
    assert.equal(r.status, 200);
    const b = await CampaignBookingModel.findOne({ bookingId }).lean();
    assert.equal(b.attendanceAssignee.email, KAL);
    assert.equal(b.attendanceAssignee.name, 'Kalpataru');
    assert.equal(b.attendanceAssignee.setBy, ADMIN);
    assert.equal(b.attendanceAssigneeHistory.length, 1);
    assert.equal(b.attendanceAssigneeHistory[0].previousEmail, SID);
    assert.equal(b.attendanceAssigneeHistory[0].email, KAL);

    await call('PUT', `/api/crm/admin/bookings/${bookingId}/attendance-assignee`, { token: adminToken(), body: { email: SID } });
    const b2 = await CampaignBookingModel.findOne({ bookingId }).lean();
    assert.equal(b2.attendanceAssigneeHistory.length, 2);
    assert.equal(b2.attendanceAssigneeHistory[1].setBy, `ca@${D}`, 'a crm_admin token is attributed by its email');
  });

  it('409 window_open once start - 5 min has passed, and nothing changes', async () => {
    const bookingId = await mkBooking({ start: Date.now() + 4 * MIN });
    const r = await call('PUT', `/api/crm/admin/bookings/${bookingId}/attendance-assignee`, { token: adminToken(), body: { email: KAL } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'window_open');
    const b = await CampaignBookingModel.findOne({ bookingId }).lean();
    assert.equal(b.attendanceAssignee?.email ?? null, null);
    assert.equal((b.attendanceAssigneeHistory || []).length, 0);
  });

  it('422 not_tracked_bda for an untracked or unknown email, 404 for an unknown booking, 400 for no email', async () => {
    const bookingId = await mkBooking({ start: Date.now() + 60 * MIN });
    const url = `/api/crm/admin/bookings/${bookingId}/attendance-assignee`;
    assert.equal((await call('PUT', url, { token: adminToken(), body: { email: PLAIN } })).body.error.code, 'not_tracked_bda');
    assert.equal((await call('PUT', url, { token: adminToken(), body: { email: NOBODY } })).status, 422);
    await BdaProfileModel.updateOne({ email: KAL }, { tracked: false });
    invalidateRegistryCache();
    assert.equal((await call('PUT', url, { token: adminToken(), body: { email: KAL } })).status, 422);
    assert.equal((await call('PUT', `/api/crm/admin/bookings/${PREFIX}nope/attendance-assignee`, { token: adminToken(), body: { email: SID } })).status, 404);
    assert.equal((await call('PUT', url, { token: adminToken(), body: {} })).status, 400);
  });

  it('403 for a non-admin CRM user, and a null email hands the meeting back to the Calendly host', async () => {
    const bookingId = await mkBooking({ start: Date.now() + 60 * MIN });
    const url = `/api/crm/admin/bookings/${bookingId}/attendance-assignee`;
    const denied = await call('PUT', url, { token: crmToken(PLAIN), body: { email: KAL } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'forbidden');
    await call('PUT', url, { token: adminToken(), body: { email: KAL } });
    const back = await call('PUT', url, { token: adminToken(), body: { email: null } });
    assert.equal(back.status, 200);
    assert.equal(back.body.booking.assignedBdaEmail, SID);
  });

  it('removes only the old assignee extension-offline placeholder row', async () => {
    const start = Date.now() + 10 * MIN + 5 * MIN; // inside the reassign allowance
    const bookingId = await mkBooking({ start });
    await runHeartbeatAlert(new Date(start - 10 * MIN), mkDeps().deps);
    assert.ok(await rowOf(bookingId, SID));
    await call('PUT', `/api/crm/admin/bookings/${bookingId}/attendance-assignee`, { token: adminToken(), body: { email: KAL } });
    assert.equal(await rowOf(bookingId, SID), null);
  });

  it('409 target_on_leave when the new BDA is off that day, and 409 already_assigned for the same BDA', async () => {
    const start = Date.now() + 3 * 60 * MIN;
    const bookingId = await mkBooking({ start });
    await BdaProfileModel.updateOne({ email: KAL }, { $set: { leaveDays: [istDay(start)] } });
    invalidateRegistryCache();
    const url = `/api/crm/admin/bookings/${bookingId}/attendance-assignee`;
    const leave = await call('PUT', url, { token: adminToken(), body: { email: KAL } });
    assert.equal(leave.status, 409);
    assert.equal(leave.body.error.code, 'target_on_leave');
    const same = await call('PUT', url, { token: adminToken(), body: { email: SID } });
    assert.equal(same.status, 409);
    assert.equal(same.body.error.code, 'already_assigned');
    assert.equal((await CampaignBookingModel.findOne({ bookingId }).lean()).attendanceAssignee?.email ?? null, null);
  });

  it('warns, but still moves the meeting, when the new BDA is already in a meeting at that time', async () => {
    const start = Date.now() + 4 * 60 * MIN;
    const mine = await mkBooking({ start, host: SID });
    await mkBooking({ start, host: KAL });
    const r = await call('PUT', `/api/crm/admin/bookings/${mine}/attendance-assignee`, { token: adminToken(), body: { email: KAL } });
    assert.equal(r.status, 200);
    assert.equal(r.body.booking.assignedBdaEmail, KAL);
    assert.match(r.body.warnings[0], /^double_booked:/);
  });
});

// ---------------------------------------------------------------------------
describe('admin: transfer meetings in one call', () => {
  const BATCH = '/api/crm/admin/bookings/reassign';

  it('moves each meeting and reports every one on its own, so a locked meeting does not block the rest', async () => {
    const a = await mkBooking({ start: Date.now() + 2 * 60 * MIN });
    const b = await mkBooking({ start: Date.now() + 3 * 60 * MIN });
    const locked = await mkBooking({ start: Date.now() + 2 * MIN });
    const r = await call('POST', BATCH, {
      token: adminToken(),
      body: { items: [a, locked, b].map((bookingId) => ({ bookingId, email: KAL.toUpperCase() })) },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.summary, { moved: 2, failed: 1 });
    assert.deepEqual(r.body.results.map((x) => x.ok), [true, false, true]);
    assert.equal(r.body.results[1].error.code, 'window_open');
    assert.equal(r.body.results[0].assignedBdaEmail, KAL);
    assert.equal(r.body.results[0].previousEmail, SID);
    assert.equal((await CampaignBookingModel.findOne({ bookingId: a }).lean()).attendanceAssignee.email, KAL);
    assert.equal((await CampaignBookingModel.findOne({ bookingId: locked }).lean()).attendanceAssignee?.email ?? null, null);
  });

  it('refuses a target on leave per item and warns when two meetings in the batch land on one BDA at one time', async () => {
    const start = Date.now() + 5 * 60 * MIN;
    const x = await mkBooking({ start, host: SID });
    const y = await mkBooking({ start, host: PLAIN });
    const off = await mkBooking({ start: start + 24 * 60 * MIN, host: SID });
    await BdaProfileModel.updateOne({ email: KAL }, { $set: { leaveDays: [istDay(start + 24 * 60 * MIN)] } });
    invalidateRegistryCache();
    const r = await call('POST', BATCH, {
      token: adminToken(),
      body: { items: [{ bookingId: x, email: KAL }, { bookingId: y, email: KAL }, { bookingId: off, email: KAL }] },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((i) => i.ok), [true, true, false]);
    assert.equal(r.body.results[0].warnings.length, 0);
    assert.match(r.body.results[1].warnings[0], /^double_booked:/);
    assert.equal(r.body.results[2].error.code, 'target_on_leave');
  });

  it('validates the body: 422 for no items, too many, a duplicate or a missing email; 403 for a non-admin', async () => {
    const t = adminToken();
    assert.equal((await call('POST', BATCH, { token: t, body: {} })).body.error.code, 'invalid_items');
    assert.equal((await call('POST', BATCH, { token: t, body: { items: [{ bookingId: 'x' }] } })).body.error.code, 'invalid_items');
    const many = Array.from({ length: 51 }, (_, i) => ({ bookingId: `${PREFIX}m${i}`, email: KAL }));
    assert.equal((await call('POST', BATCH, { token: t, body: { items: many } })).body.error.code, 'too_many_items');
    const dup = [{ bookingId: `${PREFIX}d`, email: KAL }, { bookingId: `${PREFIX}d`, email: KAL }];
    assert.equal((await call('POST', BATCH, { token: t, body: { items: dup } })).body.error.code, 'duplicate_booking');
    assert.equal((await call('POST', BATCH, { token: crmToken(PLAIN), body: { items: dup } })).status, 403);
    const unknown = await call('POST', BATCH, { token: t, body: { items: [{ bookingId: `${PREFIX}nope`, email: KAL }] } });
    assert.equal(unknown.body.results[0].error.code, 'booking_not_found');
  });

  it('the dialog call lists a BDA meetings with canMove, and every tracked BDA with leave days and load', async () => {
    const day = Date.now() + 26 * 60 * MIN;
    const soon = await mkBooking({ start: Date.now() + 2 * MIN, host: SID });
    const later = await mkBooking({ start: day, host: SID });
    await mkBooking({ start: day, host: KAL });
    await BdaProfileModel.updateOne({ email: KAL }, { $set: { leaveDays: [istDay(day)] } });
    invalidateRegistryCache();
    const to = istDay(day + 24 * 60 * MIN);
    const r = await call('GET', `/api/crm/admin/transfer-meetings?bdaEmail=${SID}&from=${istDay(Date.now())}&to=${to}`, { token: adminToken() });
    assert.equal(r.status, 200);
    const mine = Object.fromEntries(r.body.meetings.map((m) => [m.bookingId, m]));
    assert.equal(mine[soon].canMove, false);
    assert.equal(mine[later].canMove, true);
    assert.equal(mine[later].day, istDay(day));
    const kal = r.body.bdas.find((x) => x.email === KAL);
    assert.deepEqual(kal.leaveDays, [istDay(day)]);
    assert.ok(kal.loadByDay[istDay(day)] >= 1);
    assert.equal((await call('GET', '/api/crm/admin/transfer-meetings', { token: adminToken() })).body.error.code, 'invalid_bda');
    assert.equal((await call('GET', `/api/crm/admin/transfer-meetings?bdaEmail=${SID}&from=2026-13-99`, { token: adminToken() })).body.error.code, 'invalid_range');
  });
});

// ---------------------------------------------------------------------------
describe('admin: health, review queues, dismiss', () => {
  it('health returns the three sources with limits, rows24h and one heartbeat entry per tracked BDA', async () => {
    await BdaExtensionHeartbeatModel.create({ bdaEmail: SID, lastHeartbeatAt: new Date(Date.now() - 3000), version: '2.0.0' });
    const r = await call('GET', '/api/crm/admin/attendance/health', { token: adminToken() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sources.map((s) => s.source).sort(), ['google_meet', 'verdict_job', 'zoom_phone']);
    const google = r.body.sources.find((s) => s.source === 'google_meet');
    assert.deepEqual(Object.keys(google).sort(), ['ageMs', 'healthy', 'lastError', 'lastOkAt', 'limitMs', 'source']);
    assert.equal(google.limitMs, 10 * MIN);
    assert.equal(r.body.sources.find((s) => s.source === 'zoom_phone').limitMs, 30 * MIN);
    assert.equal(typeof r.body.rows24h, 'number');
    const sid = r.body.heartbeats.find((h) => h.bdaEmail === SID);
    assert.equal(sid.version, '2.0.0');
    assert.ok(sid.ageMs >= 0 && sid.ageMs < 60 * 1000);
    const kal = r.body.heartbeats.find((h) => h.bdaEmail === KAL);
    assert.deepEqual(kal, { bdaEmail: KAL, lastHeartbeatAt: null, ageMs: null, version: null });
    assert.equal((await call('GET', '/api/crm/admin/attendance/health', { token: crmToken(PLAIN) })).status, 403);
    assert.equal((await call('GET', '/api/crm/admin/attendance/health', { token: crmToken(ADMIN) })).status, 200);
  });

  it('review queues list marked-never-joined, stuck-status and needs-review, and dismiss closes a flag', async () => {
    const start = Date.now() - 5 * 60 * MIN;
    const flagged = await mkBooking({ start });
    await BdaAttendanceModel.create({
      bookingId: flagged, bdaEmail: SID, bdaName: 'Siddhartha', status: 'manual', source: 'manual',
      meetingScheduledStart: new Date(start), signals: [{ kind: 'button_crm', eventAt: new Date(start - MIN), receivedAt: new Date(start - MIN) }],
      markedPresentAt: new Date(start - MIN), verdict: 'present', verdictSignal: 'button_crm', integrityFlag: 'marked_never_joined',
    });
    const stuck = await mkBooking({ start: Date.now() - 25 * 60 * MIN });
    const fresh = await mkBooking({ start: Date.now() - 23 * 60 * MIN });
    await BdaDeductionModel.create({
      bdaEmail: SID, bookingId: flagged, rule: 'missed_meeting', month: '2026-10', amountInr: 500, status: 'needs_review',
      evidence: { clientName: 'Client X', scheduledStart: new Date(start), healthy: false },
    });

    const q = await call('GET', '/api/crm/admin/attendance/review-queues', { token: adminToken() });
    assert.equal(q.status, 200);
    assert.equal(q.body.success, true);
    const never = q.body.markedNeverJoined.find((x) => x.bookingId === flagged);
    assert.deepEqual(Object.keys(never).sort(), ['bdaEmail', 'bookingId', 'clientName', 'markedAt', 'scheduledStart', 'signal']);
    assert.equal(never.signal, 'button_crm');
    const st = q.body.stuckStatus.find((x) => x.bookingId === stuck);
    assert.deepEqual(Object.keys(st).sort(), ['bdaEmail', 'bookingId', 'bookingStatus', 'clientName', 'scheduledStart']);
    assert.equal(st.bookingStatus, 'scheduled');
    assert.ok(!q.body.stuckStatus.some((x) => x.bookingId === fresh), 'only past start + 24 h');
    assert.ok(q.body.needsReview.some((x) => x.bookingId === flagged && x.rule === 'missed_meeting'));
    assert.ok(Array.isArray(q.body.needsReassignment));

    const url = `/api/crm/admin/attendance/${flagged}/dismiss-integrity-flag`;
    assert.equal((await call('POST', url, { token: adminToken(), body: { bdaEmail: SID, reason: 'no' } })).status, 422);
    assert.equal((await call('POST', url, { token: crmToken(PLAIN), body: { bdaEmail: SID, reason: 'checked with the BDA' } })).status, 403);
    const ok = await call('POST', url, { token: adminToken(), body: { bdaEmail: SID, reason: 'Joined from a phone, checked' } });
    assert.equal(ok.status, 200);
    const row = await rowOf(flagged);
    assert.equal(row.integrityResolved.action, 'dismissed');
    assert.equal(row.integrityResolved.reason, 'Joined from a phone, checked');
    assert.equal(row.integrityResolved.by, `ca@${D}`);
    assert.ok(row.integrityResolved.at);
    assert.equal((await call('POST', url, { token: adminToken(), body: { bdaEmail: SID, reason: 'Joined from a phone, checked' } })).status, 409);

    const after = await call('GET', '/api/crm/admin/attendance/review-queues', { token: adminToken() });
    assert.ok(!after.body.markedNeverJoined.some((x) => x.bookingId === flagged));
    const fields = await getAttendanceRowFields([await CampaignBookingModel.findOne({ bookingId: flagged }).lean()], { email: ADMIN, isAdmin: true });
    assert.equal(fields.get(flagged).attendance.integrityFlag, null, 'a closed flag is not shown on the row');

    const missing = await call('POST', `/api/crm/admin/attendance/${PREFIX}none/dismiss-integrity-flag`, { token: adminToken(), body: { bdaEmail: SID, reason: 'long enough reason' } });
    assert.equal(missing.status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('getAttendanceRowFields contract', () => {
  it('returns the exact shapes, one attendance query and one deduction query for the whole page', async () => {
    const t = Date.now();
    const ids = [];
    for (let i = 0; i < 30; i++) ids.push(await mkBooking({ start: t - (i + 3) * 60 * MIN, host: i % 2 ? KAL : SID }));
    const start0 = t - 3 * 60 * MIN;
    await BdaAttendanceModel.create({
      bookingId: ids[0], bdaEmail: SID, bdaName: 'Siddhartha', status: 'present', source: 'meet_api', matchedBy: 'stable_id',
      meetingScheduledStart: new Date(start0), firstJoinedAt: new Date(start0 + 20 * 1000), leftAt: new Date(start0 + 20 * MIN),
      durationMs: 19 * MIN, meetApiFinalizedAt: new Date(),
      sessions: [{ startTime: new Date(start0 + 20 * 1000), endTime: new Date(start0 + 20 * MIN), durationMs: 19 * MIN }],
      signals: [{ kind: 'google_meet', eventAt: new Date(start0 + 20 * 1000), receivedAt: new Date(start0 + 80 * 1000) }],
      markedPresentAt: new Date(start0 + 20 * 1000), verdict: 'present', verdictAt: new Date(start0 + 95 * 1000), verdictSignal: 'google_meet',
    });
    const bookings = await CampaignBookingModel.find({ bookingId: { $in: ids } }).lean();

    const calls = { attendance: 0, deduction: 0 };
    const realFind = BdaAttendanceModel.find.bind(BdaAttendanceModel);
    BdaAttendanceModel.find = (...a) => (calls.attendance++, realFind(...a));
    const ded = [
      { deductionId: 'd1', bookingId: ids[0], bdaEmail: SID, rule: 'missed_meeting', amountInr: 500, status: 'active', waiverReason: null },
      { deductionId: 'd2', bookingId: ids[0], bdaEmail: SID, rule: 'status_not_updated', amountInr: 50, status: 'shadow', waiverReason: null },
      { deductionId: 'd3', bookingId: ids[1], bdaEmail: KAL, rule: 'no_show_not_called', amountInr: 100, status: 'waived', waiverReason: 'ok' },
    ];
    const DeductionModel = {
      find(query) {
        calls.deduction++;
        const rows = ded.filter((d) => ids.includes(d.bookingId)
          && (!query.bdaEmail || d.bdaEmail === query.bdaEmail)
          && (!query.status || d.status !== query.status.$ne));
        return { select: () => ({ lean: async () => rows }) };
      },
    };
    let own;
    let adminView;
    try {
      own = await getAttendanceRowFields(bookings, { email: SID, isAdmin: false }, { DeductionModel });
      adminView = await getAttendanceRowFields(bookings, { email: ADMIN, isAdmin: true }, { DeductionModel });
    } finally {
      BdaAttendanceModel.find = realFind;
    }
    assert.equal(calls.attendance, 2, 'one attendance query per call, not per row');
    assert.equal(calls.deduction, 2);

    const first = own.get(ids[0]);
    assert.deepEqual(Object.keys(first).sort(), ['attendance', 'deductions', 'statusUpdate', 'transcript']);
    assert.deepEqual(first.attendance, {
      verdict: 'present',
      verdictAt: new Date(start0 + 95 * 1000).toISOString(),
      markedPresentAt: new Date(start0 + 20 * 1000).toISOString(),
      signals: [{ kind: 'google_meet', eventAt: new Date(start0 + 20 * 1000).toISOString() }],
      inAt: new Date(start0 + 20 * 1000).toISOString(),
      outAt: new Date(start0 + 20 * MIN).toISOString(),
      timeSpentMs: 19 * MIN,
      sessions: [{ joinedAt: new Date(start0 + 20 * 1000).toISOString(), leftAt: new Date(start0 + 20 * MIN).toISOString() }],
      verified: true,
      matchedBy: 'stable_id',
      // Google signal only, no extension join and no stored device yet: unknown, so null (Utils/JoinDevice.js).
      joinDevice: null,
      joinDeviceReason: null,
      integrityFlag: null,
    });
    assert.equal(first.transcript, null);
    assert.deepEqual(first.deductions, [{ deductionId: 'd1', rule: 'missed_meeting', amountInr: 500, status: 'active', waiverReason: null }]);
    assert.deepEqual(own.get(ids[1]).deductions, [], 'a BDA never sees another BDA row');
    assert.equal(adminView.get(ids[0]).deductions.length, 2, 'admins see shadow rows too');
    assert.equal(adminView.get(ids[1]).deductions[0].waiverReason, 'ok');

    // No attendance row yet: the keys are there with null or empty values.
    const empty = own.get(ids[2]).attendance;
    assert.deepEqual(empty, {
      verdict: null, verdictAt: null, markedPresentAt: null, signals: [], inAt: null, outAt: null,
      timeSpentMs: 0, sessions: [], verified: false, matchedBy: null, joinDevice: null, joinDeviceReason: null, integrityFlag: null,
    });
  });

  it('statusUpdate: who set the current status and when, and stuck after start + 24 h', async () => {
    const t = Date.now();
    const stuck = await mkBooking({ start: t - 25 * 60 * MIN });
    const fresh = await mkBooking({ start: t - 23 * 60 * MIN });
    // A manual CRM edit goes through findOneAndUpdate and pushes its own history entry, like this.
    const done = await mkBooking({ start: t - 30 * 60 * MIN });
    await CampaignBookingModel.updateOne(
      { bookingId: done },
      {
        $set: { bookingStatus: 'completed' },
        $push: { statusHistory: { status: 'completed', previousStatus: 'scheduled', changedByEmail: SID, changedByName: 'Siddhartha', source: 'bda', changedAt: new Date(t - 29 * 60 * MIN) } },
      }
    );
    const bookings = await CampaignBookingModel.find({ bookingId: { $in: [stuck, fresh, done] } }).lean();
    const map = await getAttendanceRowFields(bookings, { email: SID, isAdmin: false }, { DeductionModel: null });
    assert.equal(map.get(stuck).statusUpdate.stuck, true);
    assert.equal(map.get(stuck).statusUpdate.status, 'scheduled');
    assert.equal(map.get(fresh).statusUpdate.stuck, false);
    assert.equal(map.get(done).statusUpdate.stuck, false);
    assert.equal(map.get(done).statusUpdate.updatedBy, 'Siddhartha');
    assert.equal(map.get(done).statusUpdate.updatedAt.startsWith(new Date(t - 29 * 60 * MIN).toISOString().slice(0, 16)), true);
    assert.deepEqual(map.get(done).deductions, [], 'no deduction model means no deductions');
  });

  it('an unassigned booking has attendance null, and an empty page returns an empty map', async () => {
    const id = await mkBooking({ start: Date.now() - 60 * MIN, host: null });
    const bookings = await CampaignBookingModel.find({ bookingId: id }).lean();
    const map = await getAttendanceRowFields(bookings, { email: SID }, { DeductionModel: null });
    assert.equal(map.get(id).attendance, null);
    assert.equal((await getAttendanceRowFields([], {})).size, 0);
  });
});

describe('rollout safety', () => {
  const rowFor = (bookingId) => BdaAttendanceModel.findOne({ bookingId, bdaEmail: SID }).lean();

  it('does not judge meetings that started before the BDA was put in the registry (no burst of false absent alerts)', async () => {
    // Started 10 min ago, but the profile was created just now: this is the meeting the OLD system handled.
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const { deps, posts } = mkDeps({ ignoreGoLive: false });
    const result = await runVerdictPass(new Date(), deps);
    assert.deepEqual(result.verdicts.filter((v) => v.bookingId === bookingId), []);
    assert.equal((await rowFor(bookingId))?.verdict ?? null, null, 'no verdict written');
    assert.deepEqual(posts, [], 'and nothing posted');
  });

  it('judges a meeting that started after the BDA was registered', async () => {
    // Backdate the profile to before the meeting started, bypassing the timestamps plugin.
    const start = Date.now() - 10 * MIN;
    await BdaProfileModel.collection.updateOne({ email: SID }, { $set: { createdAt: new Date(start - 60 * MIN) } });
    invalidateRegistryCache();
    const bookingId = await mkBooking({ start });
    const { deps, posts } = mkDeps({ ignoreGoLive: false });
    await runVerdictPass(new Date(), deps);
    assert.equal((await rowFor(bookingId)).verdict, 'absent');
    assert.equal(posts.length, 1);
  });
});

describe('legacy manual-mark (extensions older than v2)', () => {
  function fakeRes() {
    return {
      statusCode: 200,
      body: null,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
    };
  }
  const mark = async (bookingId) => {
    const res = fakeRes();
    await manualMark({ bdaUser: { email: SID, name: 'Siddhartha' }, body: { bookingId, meetLink: 'https://meet.google.com/abc-defg-hij' } }, res);
    return res;
  };

  it('a mark inside the window also counts as a present signal, so the verdict is present', async () => {
    const start = Date.now() - 20 * 1000; // 20 s after the start, window still open
    const bookingId = await mkBooking({ start });
    const res = await mark(bookingId);
    assert.equal(res.statusCode, 200);
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: SID }).lean();
    assert.deepEqual(row.signals.map((x) => x.kind), ['button_meet']);

    const { deps, posts } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps);
    assert.equal((await rowOf(bookingId)).verdict, 'present');
    assert.deepEqual(posts, [], 'present means no absent alert');
  });

  it('a mark after the window still saves the old row but is not counted, so the verdict stays absent', async () => {
    const start = Date.now() - 5 * MIN;
    const bookingId = await mkBooking({ start });
    const res = await mark(bookingId);
    assert.equal(res.statusCode, 200);
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: SID }).lean();
    assert.equal(row.status, 'manual');
    assert.deepEqual(row.signals, []);
  });
});

describe('review fixes: alert delivery, go-live clock, forged times', () => {
  const rowFor = (bookingId) => BdaAttendanceModel.findOne({ bookingId, bdaEmail: SID }).lean();

  it('an absent alert that Discord refused is retried on the next pass, and only then cleared', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const down = mkDeps();
    down.deps.poster = async (m) => (down.posts.push(m), false); // Discord is down
    await runVerdictPass(new Date(start + 215 * 1000), down.deps);
    let row = await rowFor(bookingId);
    assert.equal(row.verdict, 'absent');
    assert.equal(row.verdictAlertPending, true, 'the verdict exists but nobody has been told yet');

    const up = mkDeps();
    await runVerdictPass(new Date(), up.deps); // the next pass
    assert.equal(up.posts.length, 1, 'the alert is delivered now');
    assert.match(up.posts[0], /^🚫 \*\*BDA Absent\*\*/);
    row = await rowFor(bookingId);
    assert.equal(row.verdictAlertPending, false);

    const again = mkDeps();
    await runVerdictPass(new Date(), again.deps);
    assert.deepEqual(again.posts, [], 'and never repeated');
  });

  it('tracking switched on later starts a new go-live clock (an old createdAt does not reopen the last 24 hours)', async () => {
    const start = Date.now() - 10 * MIN;
    // The profile was created long ago but only switched to tracked just now.
    await BdaProfileModel.collection.updateOne({ email: SID }, { $set: { createdAt: new Date(start - 24 * 60 * MIN), trackedSince: new Date() } });
    invalidateRegistryCache();
    const bookingId = await mkBooking({ start });
    const { deps, posts } = mkDeps({ ignoreGoLive: false });
    await runVerdictPass(new Date(), deps);
    assert.equal((await rowFor(bookingId))?.verdict ?? null, null);
    assert.deepEqual(posts, []);
  });

  it('a join time in the future is clamped to now, so it cannot fake an in-window signal', async () => {
    const start = Date.now() - 10 * MIN; // the window closed 9 minutes ago
    const bookingId = await mkBooking({ start });
    const r = await recordPresentSignal({
      bookingId,
      bdaEmail: SID,
      kind: 'extension_join',
      eventAt: new Date(start + 10 * 1000), // claims to be in the window, but this is the past: stored as sent
    });
    assert.equal(r.ok, true);
    const forged = await mkBooking({ start });
    const f = await recordPresentSignal({ bookingId: forged, bdaEmail: SID, kind: 'extension_join', eventAt: new Date(Date.now() + 60 * MIN) });
    assert.equal(f.ok, true);
    const row = await rowFor(forged);
    assert.ok(new Date(row.signals[0].eventAt).getTime() <= Date.now() + 6000, 'clamped to receipt time');
    assert.equal(f.counted, false, 'receipt time is after the window, so it does not count');
  });

  it('the correction message does not mention a fine while fines are off', async () => {
    const start = Date.now() - 10 * MIN;
    const bookingId = await mkBooking({ start });
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * 1000), deps); // absent
    const posts = [];
    const r = await recordPresentSignal(
      { bookingId, bdaEmail: SID, kind: 'extension_join', eventAt: new Date(start + 20 * 1000) },
      // Received at +100 s: 80 s after the join, inside the 2-minute back-dating cap.
      { postCorrection: async (m) => posts.push(m), now: () => start + 100 * 1000 }
    );
    assert.equal(r.correction ? true : r.ok, true);
    assert.equal(posts.length, 1);
    assert.ok(!/fine/i.test(posts[0]), posts[0]);
  });
});

// Minimum stay (Nov 2026): a BDA counts as present only after at least 2 minutes in the call after the scheduled
// start. Joining early, clicking Mark Present and leaving before the meeting begins is not attending it.
//
//   node --test --test-concurrency=1 test/AttendanceMinStay.test.mjs
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';

isolateExternalServices();
delete process.env.DEDUCTIONS_MODE;
delete process.env.DEDUCTIONS_LIVE_FROM;

import { getCrmJwtSecret, requireBdaExtension } from '../Middlewares/CrmAuth.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { reportJoin, reportLeave } from '../Controllers/BdaAttendanceController.js';
import { registerAttendanceRoutes, markPresentRateLimit } from '../Routes/attendanceRoutes.js';
import { runVerdictPass } from '../Utils/AttendanceVerdictJob.js';
import { recordPresentSignal } from '../Utils/recordPresentSignal.js';
import { handleVerdict } from '../Utils/DeductionEngine.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { MIN_STAY_MS, presenceVerdict, stayAfterStart, formatStay } from '../Utils/AttendanceStay.js';

const RUN = Math.random().toString(36).slice(2, 8);
const D = `stay-${RUN}.test.invalid`;
const PREFIX = `__stay_${RUN}_`;
const SID = `sid@${D}`;
const KAL = `kal@${D}`;
const FILTER = { bookingId: { $regex: `^${PREFIX}` } };
const MIN = 60 * 1000;
const S = 1000;

let server;
let base;
let seq = 0;

const extToken = (email) => jwt.sign({ role: 'bda_extension', email, name: email.split('@')[0] }, getCrmJwtSecret(), { expiresIn: '1h' });

async function call(path, { token, body }) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function mkBooking(start) {
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
  });
  return bookingId;
}

function mkDeps() {
  const posts = [];
  return {
    posts,
    deps: {
      poster: async (m) => (posts.push(m), true),
      adminPoster: async () => true,
      attendancePoster: async () => true,
      meetVerifier: async () => {},
      bookingFilter: FILTER,
      health: {
        recordSyncOk: async () => true,
        recordSyncError: async () => true,
        wasSourceHealthy: async () => true,
        syncOkBetween: async () => true,
        getAllSyncHealth: async () => [],
      },
      ignoreGoLive: true,
    },
  };
}

const rowOf = (bookingId, email = SID) => BdaAttendanceModel.findOne({ bookingId, bdaEmail: email }).lean();
const join = (bookingId, at, email = SID) =>
  call('/api/bda-attendance/report-join', { token: extToken(email), body: { bookingId, meetLink: 'https://meet.google.com/abc-defg-hij', joinedAt: new Date(at).toISOString(), clientNow: new Date().toISOString() } });
const leave = (bookingId, at, durationMs, email = SID) =>
  call('/api/bda-attendance/report-leave', { token: extToken(email), body: { bookingId, leftAt: new Date(at).toISOString(), clientNow: new Date().toISOString(), durationMs } });

// A join and leave as the extension would have reported them live: the signal arrives the moment it happens, and
// the row carries the extension's segment fields. (Reporting a past join over HTTP now would be clamped by the
// back-dating cap, which is correct and has its own tests.)
async function liveJoin(bookingId, at, email = SID) {
  const r = await recordPresentSignal({ bookingId, bdaEmail: email, kind: 'extension_join', eventAt: new Date(at), receivedAt: new Date(at) });
  assert.equal(r.ok, true);
  await BdaAttendanceModel.updateOne({ bookingId, bdaEmail: email }, { $set: { joinedAt: new Date(at), firstJoinedAt: new Date(at), leftAt: null } });
}
async function liveLeave(bookingId, at, cumulativeMs, email = SID) {
  await BdaAttendanceModel.updateOne({ bookingId, bdaEmail: email }, { $set: { joinedAt: null, leftAt: new Date(at), cumulativeDurationMs: cumulativeMs, durationMs: cumulativeMs } });
}

async function cleanup() {
  const domain = { $regex: `@${D.replace(/\./g, '\\.')}$` };
  await Promise.all([
    CampaignBookingModel.deleteMany(FILTER),
    BdaAttendanceModel.deleteMany(FILTER),
    BdaDeductionModel.deleteMany(FILTER),
    BdaProfileModel.deleteMany({ email: domain }),
    CrmUserModel.deleteMany({ email: domain }),
  ]);
  invalidateRegistryCache();
}

before(async () => {
  await connectTestDb();
  await Promise.all([BdaAttendanceModel.init(), BdaProfileModel.init(), CampaignBookingModel.init(), CrmUserModel.init(), BdaDeductionModel.init()]);
  const app = express();
  app.use(express.json());
  registerAttendanceRoutes(app);
  app.post('/api/bda-attendance/report-join', requireBdaExtension, reportJoin);
  app.post('/api/bda-attendance/report-leave', requireBdaExtension, reportLeave);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await cleanup();
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanup();
  markPresentRateLimit.reset();
  await Promise.all([
    CrmUserModel.create([
      { email: SID, name: 'Siddhartha', role: 'bda' },
      { email: KAL, name: 'Kalpataru', role: 'bda' },
    ]),
    BdaProfileModel.create([
      { email: SID, displayName: 'Siddhartha', firstName: `sid${RUN}`, lastName: 'b', tracked: true },
      { email: KAL, displayName: 'Kalpataru', firstName: `kal${RUN}`, lastName: 's', tracked: true },
    ]),
  ]);
});

// ---------------------------------------------------------------------------
describe('time in the call after the start (pure)', () => {
  const start = Date.parse('2026-11-05T10:00:00Z');
  const now = start + 4 * MIN;
  const at = (ms) => new Date(start + ms);

  it('Google sessions: overlapping sessions count once, time before the start never counts', () => {
    const row = { sessions: [{ startTime: at(-5 * MIN), endTime: at(30 * S) }, { startTime: at(0), endTime: at(60 * S) }, { startTime: at(2 * MIN), endTime: null }] };
    const stay = stayAfterStart(row, start, now);
    assert.equal(stay.source, 'google_meet');
    assert.equal(stay.ms, 60 * S + 2 * MIN); // [0, 60 s] plus [2 min, now = 4 min]
  });

  it('the extension\'s live session counts until now; a closed one is an upper bound from the last leave', () => {
    assert.deepEqual(
      [stayAfterStart({ joinedAt: at(-3 * MIN), leftAt: null }, start, now).ms, stayAfterStart({ joinedAt: at(-3 * MIN), leftAt: null }, start, now).source],
      [4 * MIN, 'extension_live']
    );
    const left = stayAfterStart({ joinedAt: null, leftAt: at(90 * S), cumulativeDurationMs: 5 * MIN }, start, now);
    assert.deepEqual([left.ms, left.source], [90 * S, 'extension_last_leave']);
    // Left before the start: nothing after it, whatever the cumulative total says.
    assert.equal(stayAfterStart({ leftAt: at(-1 * MIN), cumulativeDurationMs: 4 * MIN }, start, now).ms, 0);
    // The cumulative total caps it too (joined at +1:30, left at +2:00 = 30 s).
    assert.equal(stayAfterStart({ leftAt: at(2 * MIN), cumulativeDurationMs: 30 * S }, start, now).ms, 30 * S);
  });

  it('a live rejoin outweighs Google records that have not caught up yet', () => {
    const row = { sessions: [{ startTime: at(-4 * MIN), endTime: at(-3 * MIN) }], joinedAt: at(30 * S), leftAt: null };
    const stay = stayAfterStart(row, start, now);
    assert.deepEqual([stay.source, stay.ms], ['extension_live', 3.5 * MIN]);
  });

  it('no timeline at all is unknown, and unknown never makes anyone absent', () => {
    const row = { signals: [{ kind: 'button_meet', eventAt: at(-2 * MIN) }] };
    assert.equal(stayAfterStart(row, start, now).known, false);
    assert.deepEqual([presenceVerdict(row, start, now).present, presenceVerdict(row, start, now).reason], [true, 'present']);
  });

  it('the decision: in time AND stayed, or a named reason', () => {
    const signal = [{ kind: 'extension_join', eventAt: at(-3 * MIN) }];
    assert.equal(presenceVerdict({ signals: [] }, start, now).reason, 'no_signal');
    assert.equal(presenceVerdict({ signals: signal, leftAt: at(-1 * MIN) }, start, now).reason, 'left_early');
    assert.equal(presenceVerdict({ signals: signal, leftAt: at(MIN_STAY_MS - S) }, start, now).reason, 'left_early');
    assert.equal(presenceVerdict({ signals: signal, leftAt: at(MIN_STAY_MS) }, start, now).reason, 'present');
    assert.equal(formatStay(80 * S), '1 min 20 s');
  });
});

// ---------------------------------------------------------------------------
describe('verdict job with the minimum stay', () => {
  it('joined early, clicked Mark Present, left before the meeting started: absent, and the alert says why', async () => {
    const start = Date.now() - 4 * MIN;
    const bookingId = await mkBooking(start);
    assert.equal((await join(bookingId, start - 3 * MIN)).status, 200);
    await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(start - 3 * MIN + 10 * S) });
    assert.equal((await leave(bookingId, start - 2 * MIN, 1 * MIN)).status, 200);

    const { deps, posts } = mkDeps();
    await runVerdictPass(new Date(start + 215 * S), deps);
    const row = await rowOf(bookingId);
    assert.equal(row.verdict, 'absent');
    assert.equal(row.verdictReason, 'left_early');
    assert.equal(row.verdictStayMs, 0);
    assert.equal(posts.length, 1);
    assert.match(posts[0], /BDA Absent: left the call too early/);
    assert.match(posts[0], /In the call after the start:\*\* 0 s \(at least 2 min needed\)/);
  });

  it('left 90 s after the start: absent (needed 2 min)', async () => {
    const start = Date.now() - 4 * MIN;
    const bookingId = await mkBooking(start);
    await liveJoin(bookingId, start - 1 * MIN);
    await liveLeave(bookingId, start + 90 * S, 150 * S);
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * S), deps);
    const row = await rowOf(bookingId);
    assert.deepEqual([row.verdict, row.verdictReason, row.verdictStayMs], ['absent', 'left_early', 90 * S]);
  });

  it('joined before the start and still in the call: present', async () => {
    const start = Date.now() - 4 * MIN;
    const bookingId = await mkBooking(start);
    await liveJoin(bookingId, start - 3 * MIN);
    const { deps, posts } = mkDeps();
    await runVerdictPass(new Date(start + 215 * S), deps);
    const row = await rowOf(bookingId);
    assert.deepEqual([row.verdict, row.verdictReason], ['present', 'present']);
    assert.ok(row.verdictStayMs >= MIN_STAY_MS);
    assert.equal(posts.length, 0);
  });

  it('joined at +50 s (inside the window) and stayed to +2:55: present', async () => {
    const start = Date.now() - 4 * MIN;
    const bookingId = await mkBooking(start);
    await liveJoin(bookingId, start + 50 * S);
    await liveLeave(bookingId, start + 175 * S, 125 * S);
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * S), deps);
    assert.equal((await rowOf(bookingId)).verdict, 'present');
  });

  it('a Mark Present click with no join data at all stays present (the integrity check reviews it, as before)', async () => {
    const start = Date.now() - 4 * MIN;
    const bookingId = await mkBooking(start);
    await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'button_meet', receivedAt: new Date(start - 1 * MIN) });
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * S), deps);
    const row = await rowOf(bookingId);
    assert.deepEqual([row.verdict, row.verdictStayMs], ['present', null]);
  });

  it('a late Google record of the same short visit does not turn "left early" back into present', async () => {
    const start = Date.now() - 4 * MIN;
    const bookingId = await mkBooking(start);
    await liveJoin(bookingId, start - 3 * MIN);
    await liveLeave(bookingId, start - 2 * MIN, 1 * MIN);
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * S), deps);
    assert.equal((await rowOf(bookingId)).verdict, 'absent');

    // Google's sync stores the sessions, then reports the join (the order MeetAttendanceScheduler uses).
    await BdaAttendanceModel.updateOne({ bookingId, bdaEmail: SID }, { $set: { sessions: [{ startTime: new Date(start - 3 * MIN), endTime: new Date(start - 2 * MIN), durationMs: MIN }] } });
    const r = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'google_meet', eventAt: new Date(start - 3 * MIN), matchedBy: 'stable_id' });
    assert.equal(r.correction, null);
    assert.equal((await rowOf(bookingId)).verdict, 'absent');
  });

  it('Google records that show a real stay DO correct an absent', async () => {
    const start = Date.now() - 4 * MIN;
    const bookingId = await mkBooking(start);
    await liveJoin(bookingId, start - 3 * MIN);
    await liveLeave(bookingId, start - 2 * MIN, 1 * MIN); // the extension saw a leave (tab switch), but the BDA stayed
    const { deps } = mkDeps();
    await runVerdictPass(new Date(start + 215 * S), deps);
    assert.equal((await rowOf(bookingId)).verdict, 'absent');

    await BdaAttendanceModel.updateOne({ bookingId, bdaEmail: SID }, { $set: { sessions: [{ startTime: new Date(start - 3 * MIN), endTime: null, durationMs: 0 }] } });
    const r = await recordPresentSignal({ bookingId, bdaEmail: SID, kind: 'google_meet', eventAt: new Date(start - 3 * MIN), matchedBy: 'stable_id' });
    assert.deepEqual(r.correction, { signal: 'google_meet' });
    const row = await rowOf(bookingId);
    assert.deepEqual([row.verdict, row.verdictReason], ['present', 'present']);
  });
});

// ---------------------------------------------------------------------------
describe('fines with the minimum stay', () => {
  const START = '2026-10-05T10:00:00Z';
  const startMs = Date.parse(START);
  const opts = (posts) => ({
    now: new Date('2026-10-05T12:00:00Z'),
    mode: 'live',
    liveFrom: new Date('2026-10-01T00:00:00Z'),
    getProfile: async (email) => ({ email, displayName: email.startsWith('kal') ? 'Kalpataru' : 'Siddhartha', active: true, tracked: true, leaveDays: [] }),
    listTracked: async () => [],
    post: async (p) => (posts.push(p), { ok: true }),
  });
  const absent = (bookingId) => ({ bookingId, bdaEmail: SID, verdict: 'absent', verdictAt: new Date(startMs + 215 * S), scheduledStart: new Date(startMs), signals: [], healthy: true });

  async function seedBooking() {
    const bookingId = `${PREFIX}${++seq}`;
    await CampaignBookingModel.create({
      bookingId, clientName: 'Jason', clientEmail: `${bookingId}@${D}`, bookingStatus: 'scheduled', utmSource: 'direct',
      scheduledEventStartTime: new Date(startMs), calendlyHost: { name: 'sid', email: SID },
    });
    return bookingId;
  }

  it('in-time evidence does not block the fine when the BDA left early, and the message says so', async () => {
    const bookingId = await seedBooking();
    await BdaAttendanceModel.create({
      bookingId, bdaEmail: SID, bdaName: 'Siddhartha', status: 'present', source: 'auto', meetingScheduledStart: new Date(startMs),
      verdict: 'absent', verdictReason: 'left_early', leftAt: new Date(startMs + 40 * S), cumulativeDurationMs: 4 * MIN,
      signals: [{ kind: 'extension_join', eventAt: new Date(startMs - 3 * MIN) }],
    });
    const posts = [];
    await handleVerdict(absent(bookingId), opts(posts));
    const [row] = await BdaDeductionModel.find({ bookingId, rule: 'missed_meeting' }).lean();
    assert.equal(row?.status, 'active');
    assert.equal(row.evidence.absentReason, 'left_early');
    assert.equal(row.evidence.stayMs, 40 * S);
    assert.match(posts[0].content, /missed the meeting with Jason at .*: joined the Google Meet but left too early \(40 s after the start, 2 min needed\)/);
  });

  it('a colleague who popped in for under 2 minutes is not a cover; one who stayed is', async () => {
    const quick = await seedBooking();
    await BdaAttendanceModel.create({
      bookingId: quick, bdaEmail: KAL, bdaName: 'Kalpataru', status: 'present', source: 'auto', meetingScheduledStart: new Date(startMs),
      firstJoinedAt: new Date(startMs + 1 * MIN), leftAt: new Date(startMs + 80 * S), cumulativeDurationMs: 20 * S,
      signals: [{ kind: 'extension_join', eventAt: new Date(startMs + 1 * MIN) }],
    });
    const stayed = await seedBooking();
    await BdaAttendanceModel.create({
      bookingId: stayed, bdaEmail: KAL, bdaName: 'Kalpataru', status: 'present', source: 'meet_api', meetingScheduledStart: new Date(startMs),
      firstJoinedAt: new Date(startMs + 1 * MIN), sessions: [{ startTime: new Date(startMs + 1 * MIN), endTime: new Date(startMs + 13 * MIN) }],
      signals: [{ kind: 'google_meet', eventAt: new Date(startMs + 1 * MIN) }],
    });
    const posts = [];
    await handleVerdict(absent(quick), opts(posts));
    await handleVerdict(absent(stayed), opts(posts));
    const byId = Object.fromEntries((await BdaDeductionModel.find({ bookingId: { $in: [quick, stayed] } }).lean()).map((r) => [r.bookingId, r]));
    assert.equal(byId[quick].status, 'active', 'a 20-second visit holds nothing');
    assert.deepEqual(byId[quick].evidence.coveredBy, []);
    assert.equal(byId[stayed].status, 'needs_review');
    assert.equal(byId[stayed].evidence.coveredBy[0].minutes, 12);
    const held = posts.find((p) => p.row?.bookingId === stayed);
    assert.match(held.content, /^\[held for review: Kalpataru \(12 min\) was in the Google Meet call instead, not counted yet\]/);
  });
});

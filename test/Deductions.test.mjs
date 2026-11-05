import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';

// Imported before isolateExternalServices() runs so dotenv has already loaded here; the lazy imports inside the
// engine then reuse these cached modules and cannot reload a real webhook URL.
import '../Utils/DiscordConnect.js';
import '../Utils/attendanceDiscord.js';
import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { BdaDeductionDigestModel } from '../Schema_Models/BdaDeductionDigest.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CallLogModel } from '../Schema_Models/CallLog.js';
import { attendanceEvents, EVENTS, emitAttendanceEvent } from '../Utils/attendanceEvents.js';
import { getAssignedBdaEmail } from '../Utils/BdaAssignment.js';
import { resolveBda } from '../Utils/BdaIdentity.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { getCallSummaries as realGetCallSummaries } from '../Utils/BookingCallSummary.js';
import { normalizeLeadPhone } from '../Utils/CallLinking.js';
import {
  activateDeduction, convertFlagToMiss, evaluateMissedMeetings, evaluateNoShowNotCalled, evaluateStatusNotUpdated,
  handleVerdict, handleVerdictCorrected, repriceMonth, runDailySummary, runDeductionEvaluators,
  startDeductionEngine, stopDeductionEngine, sweepCorrectedVerdicts, waiveDeduction,
} from '../Utils/DeductionEngine.js';

isolateExternalServices();
for (const k of ['DISCORD_BDA_DEDUCTIONS_WEBHOOK_URL', 'DISCORD_BDA_ADMIN_WEBHOOK_URL', 'DISCORD_BDA_ABSENT_WEBHOOK_URL', 'DISCORD_BDA_ATTENDANCE_WEBHOOK_URL']) {
  process.env[k] = ''; // blank, so no code path in this file can reach a real channel
}
delete process.env.DEDUCTIONS_MODE;
delete process.env.DEDUCTIONS_LIVE_FROM;

// Random per run: other agents run suites in parallel against the same throwaway database, so everything below
// carries this prefix and cleanup deletes only rows that carry it.
const RUN = Math.random().toString(36).slice(2, 8);
const PFX = `ded${RUN}`;
const D = `ded-${RUN}.test.invalid`;
const SID = `sid@${D}`;
const KAL = `kal@${D}`;
const ADMIN = { email: `admin@${D}`, name: 'Admin Person' };
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

const profiles = {
  [SID]: { email: SID, displayName: 'Sid', firstName: 'sid', lastName: 'x', active: true, tracked: true, leaveDays: [], discordUserId: '111111111111111111' },
  [KAL]: { email: KAL, displayName: 'Kal', firstName: 'kal', lastName: 'y', active: true, tracked: true, leaveDays: [], discordUserId: null },
};

const NOW = new Date('2026-10-20T12:00:00.000Z');
const LIVE_FROM = new Date('2026-10-01T00:00:00.000Z');

let posts;
let zoomHealthy;
let jobRan;
let summaries; // bookingId -> callSummary for the fake call source

const opts = (over = {}) => ({
  now: NOW,
  mode: 'live',
  liveFrom: LIVE_FROM,
  statusDeadlineMs: 2 * 3600 * 1000,
  getProfile: async (email) => profiles[email] || null,
  listTracked: async () => Object.values(profiles),
  getCallSummaries: async (bookings) =>
    new Map(bookings.map((b) => [b.bookingId, summaries[b.bookingId] ?? { calls: 0, calledWithin30Min: false }])),
  sourceHealthy: async (source) => (source === 'zoom_phone' ? zoomHealthy : true),
  syncRanBetween: async () => jobRan,
  post: async (p) => {
    posts.push(p);
    return { ok: true };
  },
  ...over,
});

const startOf = (iso) => new Date(iso);
const plusMin = (iso, m) => new Date(new Date(iso).getTime() + m * 60000);

async function mkBooking(key, startIso, { host = SID, status = 'scheduled', phone = `+1 ${digits(10)}`, history = [], statusChangedAt = null } = {}) {
  const bookingId = `${PFX}-${key}`;
  await CampaignBookingModel.create({
    bookingId,
    utmSource: 'test',
    clientName: `Client ${key}`,
    clientEmail: `${key}.${RUN}@${D}`,
    clientPhone: phone,
    scheduledEventStartTime: startOf(startIso),
    bookingStatus: status,
    calendlyHost: { email: host, name: 'Host' },
  });
  // The save hook adds a genesis history entry stamped with the real clock; tests set history explicitly.
  await CampaignBookingModel.updateOne({ bookingId }, { $set: { statusHistory: history, statusChangedAt } });
  return bookingId;
}

const absentEvent = (bookingId, startIso, over = {}) => ({
  bookingId,
  bdaEmail: SID,
  verdict: 'absent',
  verdictAt: plusMin(startIso, 2),
  scheduledStart: startOf(startIso),
  signals: [],
  healthy: true,
  ...over,
});

const rowsOf = (bdaEmail = SID, month, rule = 'missed_meeting') =>
  BdaDeductionModel.find({ bdaEmail, rule, ...(month ? { month } : {}) }).sort({ 'evidence.scheduledStart': 1 }).lean();

async function cleanup() {
  const byBooking = { bookingId: { $regex: `^${PFX}-` } };
  await Promise.all([
    CampaignBookingModel.deleteMany(byBooking),
    BdaAttendanceModel.deleteMany(byBooking),
    BdaDeductionModel.deleteMany(byBooking),
    BdaDeductionDigestModel.deleteMany({ key: { $regex: `\\|[a-z]+@${D.replace(/\./g, '\\.')}\\|` } }),
    CallLogModel.deleteMany({ callId: { $regex: `^${PFX}-` } }),
    BdaProfileModel.deleteMany({ email: { $regex: `@${D.replace(/\./g, '\\.')}$` } }),
  ]);
  invalidateRegistryCache();
}

before(async () => {
  await connectTestDb();
  await Promise.all([
    CampaignBookingModel.init(), BdaAttendanceModel.init(), BdaDeductionModel.init(),
    BdaDeductionDigestModel.init(), CallLogModel.init(), BdaProfileModel.init(),
  ]);
});
after(async () => {
  stopDeductionEngine();
  await cleanup();
  await disconnectTestDb();
});
beforeEach(async () => {
  await cleanup();
  posts = [];
  zoomHealthy = true;
  jobRan = true;
  summaries = {};
});

describe('a colleague covered the meeting', () => {
  const START = '2026-10-05T10:00:00Z';
  const coverRow = (bookingId, over = {}) =>
    BdaAttendanceModel.create({
      bookingId,
      bdaEmail: KAL,
      bdaName: 'Kal',
      meetingScheduledStart: startOf(START),
      status: 'present',
      verdict: 'present',
      source: 'meet_api',
      firstJoinedAt: plusMin(START, -2),
      durationMs: 20 * 60000,
      signals: [{ kind: 'extension_join', eventAt: plusMin(START, -2) }],
      ...over,
    });

  it('holds the fine for review, names who covered, and does not count it', async () => {
    const id = await mkBooking('cov1', START);
    await coverRow(id);
    await handleVerdict(absentEvent(id, START), opts());
    const [row] = await rowsOf(SID);
    assert.equal(row.status, 'needs_review');
    assert.equal(row.tierIndex, null, 'a held row is not part of the tiers');
    assert.equal(row.evidence.coveredBy.length, 1);
    assert.equal(row.evidence.coveredBy[0].bdaEmail, KAL);
    assert.equal(row.evidence.coveredBy[0].bdaName, 'Kal');
    assert.equal(row.evidence.coveredBy[0].minutes, 20);
  });

  it('fines normally when nobody covered it, or the colleague row shows nobody in the call', async () => {
    const none = await mkBooking('cov2', START);
    const empty = await mkBooking('cov3', '2026-10-06T10:00:00Z');
    await coverRow(empty, { status: 'unmarked', verdict: 'absent', firstJoinedAt: null, durationMs: 0, signals: [] });
    await handleVerdict(absentEvent(none, START), opts());
    await handleVerdict(absentEvent(empty, '2026-10-06T10:00:00Z'), opts());
    const rows = await rowsOf(SID);
    assert.deepEqual(rows.map((r) => r.status), ['active', 'active']);
    assert.deepEqual(rows.map((r) => r.evidence.coveredBy), [[], []]);
  });

  it('still fines when the cover lookup fails, and a held row is not re-priced into the tiers', async () => {
    const id = await mkBooking('cov4', START);
    await handleVerdict(absentEvent(id, START), opts({ loadCover: async () => { throw new Error('db down'); } }));
    assert.equal((await rowsOf(SID))[0].status, 'active');

    const covered = await mkBooking('cov5', '2026-10-07T10:00:00Z');
    await coverRow(covered, { meetingScheduledStart: startOf('2026-10-07T10:00:00Z') });
    await handleVerdict(absentEvent(covered, '2026-10-07T10:00:00Z'), opts());
    const rows = await rowsOf(SID);
    assert.deepEqual(rows.map((r) => r.status), ['active', 'needs_review']);
    assert.deepEqual(rows.map((r) => r.amountInr), [500, 500]);
    assert.equal(rows.find((r) => r.status === 'active').tierIndex, 1);
  });
});

describe('other signs the meeting was attended hold the fine for review', () => {
  const START = '2026-10-05T10:00:00Z';
  const ownRow = (bookingId, participantsAtJoin) =>
    BdaAttendanceModel.create({
      bookingId, bdaEmail: SID, bdaName: 'Sid', meetingScheduledStart: startOf(START),
      status: 'unmarked', verdict: 'absent', source: 'meet_api', signals: [], participantsAtJoin,
    });

  it('a shared team account (FLASHFIRE) in the roster holds it and records the account', async () => {
    const id = await mkBooking('stf1', START);
    await ownRow(id, [{ displayName: 'FLASHFIRE', kind: 'signedin' }, { displayName: 'Calendly Notetaker', kind: 'anonymous' }]);
    await handleVerdict(absentEvent(id, START), opts());
    const [row] = await rowsOf(SID);
    assert.equal(row.status, 'needs_review');
    assert.deepEqual(row.evidence.unattributedStaff.map((p) => p.displayName), ['FLASHFIRE']);
  });

  it('only the notetaker and the client in the roster is a real miss and stays active', async () => {
    const id = await mkBooking('stf2', START);
    await ownRow(id, [{ displayName: 'Calendly Notetaker', kind: 'anonymous' }, { displayName: 'A Client', kind: 'anonymous' }]);
    await handleVerdict(absentEvent(id, START), opts());
    const [row] = await rowsOf(SID);
    assert.equal(row.status, 'active');
    assert.deepEqual(row.evidence.unattributedStaff, []);
    assert.equal(row.evidence.extensionInCall, null);
  });

  it('the BDA own extension reporting them in this call holds it, with when; a failed lookup does not block the fine', async () => {
    const held = await mkBooking('ext1', START);
    const calls = [];
    await handleVerdict(absentEvent(held, START), opts({ loadInCall: async (email, code, startMs) => { calls.push({ email, code, startMs }); return { firstAt: plusMin(START, 2), lastAt: plusMin(START, 20) }; } }));
    const [row] = await rowsOf(SID);
    assert.equal(row.status, 'needs_review');
    assert.equal(new Date(row.evidence.extensionInCall.firstAt).toISOString(), plusMin(START, 2).toISOString());
    assert.equal(calls[0].email, SID);
    assert.equal(calls[0].startMs, startOf(START).getTime());

    const broken = await mkBooking('ext2', '2026-10-06T10:00:00Z');
    await handleVerdict(absentEvent(broken, '2026-10-06T10:00:00Z'), opts({ loadInCall: async () => { throw new Error('db down'); } }));
    assert.equal((await rowsOf(SID)).find((r) => r.bookingId === broken).status, 'active');
  });
});

describe('missed_meeting tiers (plan 2.5 and 8.5)', () => {
  it('7 misses in a month cost 500 x 5 + 1000 x 2 = 4500, however they arrive', async () => {
    const days = [2, 3, 4, 5, 6, 7, 8];
    const ids = {};
    for (const d of days) ids[d] = await mkBooking(`m${d}`, `2026-10-0${d}T10:00:00Z`);
    for (const d of [4, 2, 8, 6, 3, 7, 5]) await handleVerdict(absentEvent(ids[d], `2026-10-0${d}T10:00:00Z`), opts());

    const rows = await rowsOf(SID, '2026-10');
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((r) => r.tierIndex), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(rows.map((r) => r.amountInr), [500, 500, 500, 500, 500, 1000, 1000]);
    assert.ok(rows.every((r) => r.status === 'active'));
    assert.equal(rows.reduce((s, r) => s + r.amountInr, 0), 4500);
    assert.equal(posts.length, 7);
  });

  it('from 22 Oct a miss is a flat 500 even as the 7th and 8th of the month, and earlier ones keep their old charge', async () => {
    const later = new Date('2026-10-30T00:00:00Z');
    const old = {};
    for (const d of [2, 3, 4, 5, 6, 7]) old[d] = await mkBooking(`f${d}`, `2026-10-0${d}T10:00:00Z`);
    const a = await mkBooking('f22', '2026-10-22T10:00:00Z');
    const b = await mkBooking('f23', '2026-10-23T10:00:00Z');
    for (const d of [2, 3, 4, 5, 6, 7]) await handleVerdict(absentEvent(old[d], `2026-10-0${d}T10:00:00Z`), opts({ now: later }));
    await handleVerdict(absentEvent(b, '2026-10-23T10:00:00Z'), opts({ now: later }));
    await handleVerdict(absentEvent(a, '2026-10-22T10:00:00Z'), opts({ now: later }));

    const rows = await rowsOf(SID, '2026-10');
    assert.deepEqual(rows.map((r) => r.tierIndex), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(rows.map((r) => r.amountInr), [500, 500, 500, 500, 500, 1000, 500, 500]);
    assert.equal(rows.reduce((sum, r) => sum + r.amountInr, 0), 4500);
  });

  it('waiving the 2nd re-prices the rest to 3500 and keeps the waived row with who, when and why', async () => {
    for (let d = 2; d <= 8; d++) {
      const id = await mkBooking(`m${d}`, `2026-10-0${d}T10:00:00Z`);
      await handleVerdict(absentEvent(id, `2026-10-0${d}T10:00:00Z`), opts());
    }
    const [, second] = await rowsOf(SID, '2026-10');
    const res = await waiveDeduction(second.deductionId, ADMIN, 'Client confirmed the meeting moved');
    assert.equal(res.ok, true);

    const rows = await rowsOf(SID, '2026-10');
    assert.equal(rows.length, 7, 'a waiver never deletes');
    const waived = rows.find((r) => r.deductionId === second.deductionId);
    assert.equal(waived.status, 'waived');
    assert.equal(waived.waivedBy, ADMIN.email);
    assert.equal(waived.waivedByName, ADMIN.name);
    assert.equal(waived.waiverReason, 'Client confirmed the meeting moved');
    assert.ok(waived.waivedAt instanceof Date);
    const live = rows.filter((r) => r.status === 'active');
    assert.equal(live.length, 6);
    assert.deepEqual(live.map((r) => r.amountInr), [500, 500, 500, 500, 500, 1000]);
    assert.equal(live.reduce((s, r) => s + r.amountInr, 0), 3500);

    const again = await waiveDeduction(second.deductionId, ADMIN, 'Waiving twice');
    assert.equal(again.ok, false);
    assert.equal(again.status, 409);
    assert.equal(again.code, 'already_resolved');
  });

  it('the month rolls over with the working day (08:00 IST), so a shift that crosses midnight on the 1st stays in the month it began', async () => {
    const lateOct = '2026-11-01T02:29:00Z'; // 07:59 IST on 1 Nov, still the 31 Oct shift
    const earlyNov = '2026-11-01T02:31:00Z'; // 08:01 IST on 1 Nov, the first November shift
    const a = await mkBooking('edge-a', lateOct);
    const b = await mkBooking('edge-b', earlyNov);
    const later = opts({ now: new Date('2026-11-05T12:00:00Z') });
    await handleVerdict(absentEvent(a, lateOct), later);
    await handleVerdict(absentEvent(b, earlyNov), later);

    const oct = await rowsOf(SID, '2026-10');
    const nov = await rowsOf(SID, '2026-11');
    assert.equal(oct.length, 1);
    assert.equal(nov.length, 1);
    assert.equal(oct[0].tierIndex, 1);
    assert.equal(nov[0].tierIndex, 1, 'the counter restarts on the 1st');
  });

  it('repriceMonth is a deterministic recompute: running it twice, or at once, changes nothing more', async () => {
    for (let d = 2; d <= 8; d++) {
      const id = await mkBooking(`m${d}`, `2026-10-0${d}T10:00:00Z`);
      await handleVerdict(absentEvent(id, `2026-10-0${d}T10:00:00Z`), opts());
    }
    // Scramble the stored numbers, then repair them from several callers at once.
    await BdaDeductionModel.updateMany({ bdaEmail: SID }, { $set: { tierIndex: 99, amountInr: 7 } });
    await Promise.all([repriceMonth(SID, '2026-10'), repriceMonth(SID, '2026-10'), repriceMonth(SID, '2026-10')]);
    let rows = await rowsOf(SID, '2026-10');
    assert.deepEqual(rows.map((r) => r.amountInr), [500, 500, 500, 500, 500, 1000, 1000]);
    const second = await repriceMonth(SID, '2026-10');
    assert.equal(second.updated, 0);
    rows = await rowsOf(SID, '2026-10');
    assert.deepEqual(rows.map((r) => r.tierIndex), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('a needs_review row never counts toward the tier until an admin activates it', async () => {
    const ids = [];
    for (const d of [2, 3, 4]) ids.push(await mkBooking(`m${d}`, `2026-10-0${d}T10:00:00Z`));
    await handleVerdict(absentEvent(ids[0], '2026-10-02T10:00:00Z'), opts());
    await handleVerdict(absentEvent(ids[1], '2026-10-03T10:00:00Z', { healthy: false }), opts());
    await handleVerdict(absentEvent(ids[2], '2026-10-04T10:00:00Z'), opts());

    let rows = await rowsOf(SID, '2026-10');
    assert.deepEqual(rows.map((r) => r.status), ['active', 'needs_review', 'active']);
    assert.deepEqual(rows.filter((r) => r.status === 'active').map((r) => r.tierIndex), [1, 2]);
    assert.equal(rows[1].tierIndex, null);
    assert.equal(rows[1].evidence.healthy, false);
    // Only the two counted fines go to the BDA channel; the review row goes to the admins.
    assert.deepEqual(posts.map((p) => p.channel), ['deductions', 'admin', 'deductions']);

    const res = await activateDeduction(rows[1].deductionId, ADMIN, 'Checked Google by hand, they were absent');
    assert.equal(res.ok, true);
    rows = await rowsOf(SID, '2026-10');
    assert.deepEqual(rows.map((r) => r.status), ['active', 'active', 'active']);
    assert.deepEqual(rows.map((r) => r.tierIndex), [1, 2, 3]);
    assert.equal(rows[1].reviewedBy, ADMIN.email);
    assert.equal(rows[1].reviewReason, 'Checked Google by hand, they were absent');
  });

  it('activate with action waive waives a review row, and refuses rows that are not under review', async () => {
    const a = await mkBooking('r1', '2026-10-02T10:00:00Z');
    const b = await mkBooking('r2', '2026-10-03T10:00:00Z');
    await handleVerdict(absentEvent(a, '2026-10-02T10:00:00Z', { healthy: false }), opts());
    await handleVerdict(absentEvent(b, '2026-10-03T10:00:00Z'), opts());
    const [review, active] = await rowsOf(SID, '2026-10');

    const waived = await activateDeduction(review.deductionId, ADMIN, 'Not a real miss', 'waive');
    assert.equal(waived.ok, true);
    assert.equal(waived.deduction.status, 'waived');

    const notReview = await activateDeduction(active.deductionId, ADMIN, 'Trying to activate an active one');
    assert.equal(notReview.status, 409);
    assert.equal(notReview.code, 'not_under_review');
    const resolved = await activateDeduction(review.deductionId, ADMIN, 'Second time lucky');
    assert.equal(resolved.status, 409);
    assert.equal(resolved.code, 'already_resolved');
    const missing = await activateDeduction('nope', ADMIN, 'Does not exist');
    assert.equal(missing.status, 404);
  });
});

describe('missed_meeting creation rules', () => {
  it('running the evaluators twice, and an event after the sweep, creates no duplicates', async () => {
    const id = await mkBooking('dup', '2026-10-05T10:00:00Z');
    await BdaAttendanceModel.create({
      bdaName: 'Sid', bdaEmail: SID, bookingId: id, status: 'absent', source: 'scheduler',
      meetingScheduledStart: startOf('2026-10-05T10:00:00Z'), verdict: 'absent', verdictAt: plusMin('2026-10-05T10:00:00Z', 2),
    });
    const first = await evaluateMissedMeetings(opts());
    const second = await evaluateMissedMeetings(opts());
    await handleVerdict(absentEvent(id, '2026-10-05T10:00:00Z'), opts());
    assert.equal(first.created, 1);
    assert.equal(second.created, 0);
    assert.equal((await rowsOf(SID)).length, 1);
    assert.equal(posts.length, 1, 'one post for one fine');
  });

  it('concurrent runs are safe through the unique index: one row, one post', async () => {
    const id = await mkBooking('race', '2026-10-05T10:00:00Z');
    await Promise.all(Array.from({ length: 6 }, () => handleVerdict(absentEvent(id, '2026-10-05T10:00:00Z'), opts())));
    assert.equal((await rowsOf(SID)).length, 1);
    assert.equal(posts.length, 1);
  });

  it('the sweep rebuilds health: a verdict job that did not run in the window gives needs_review', async () => {
    const id = await mkBooking('sweep', '2026-10-05T10:00:00Z');
    await BdaAttendanceModel.create({
      bdaName: 'Sid', bdaEmail: SID, bookingId: id, status: 'absent', source: 'scheduler',
      meetingScheduledStart: startOf('2026-10-05T10:00:00Z'), verdict: 'absent', verdictAt: plusMin('2026-10-05T10:00:00Z', 2),
    });
    jobRan = false;
    await evaluateMissedMeetings(opts());
    const [row] = await rowsOf(SID);
    assert.equal(row.status, 'needs_review');
  });

  it('keeps a frozen evidence snapshot', async () => {
    const id = await mkBooking('ev', '2026-10-05T10:00:00Z');
    summaries[id] = { calls: 2, calledWithin30Min: true };
    const signals = [{ kind: 'extension_join', eventAt: plusMin('2026-10-05T10:00:00Z', 3), receivedAt: plusMin('2026-10-05T10:00:00Z', 3) }];
    await handleVerdict(absentEvent(id, '2026-10-05T10:00:00Z', { signals }), opts());
    const [row] = await rowsOf(SID);
    assert.equal(row.evidence.scheduledStart.toISOString(), '2026-10-05T10:00:00.000Z');
    assert.equal(row.evidence.windowClosedAt.toISOString(), '2026-10-05T10:01:00.000Z');
    assert.equal(row.evidence.clientName, 'Client ev');
    assert.equal(row.evidence.bookingStatus, 'scheduled');
    assert.equal(row.evidence.signals[0].kind, 'extension_join');
    assert.equal(row.evidence.callSummary.calls, 2);
    assert.equal(row.month, '2026-10');
  });

  it('only the assigned BDA is fined, on a countable meeting', async () => {
    const mine = await mkBooking('own', '2026-10-05T10:00:00Z');
    await handleVerdict(absentEvent(mine, '2026-10-05T10:00:00Z', { bdaEmail: KAL }), opts());
    assert.equal((await rowsOf(KAL)).length, 0, 'a colleague who is not assigned is never fined');

    const cancelled = await mkBooking('cx', '2026-10-06T10:00:00Z', {
      status: 'canceled',
      history: [{ status: 'canceled', previousStatus: 'scheduled', changedAt: plusMin('2026-10-06T10:00:00Z', -120) }],
    });
    await handleVerdict(absentEvent(cancelled, '2026-10-06T10:00:00Z'), opts());

    const leave = await mkBooking('leave', '2026-10-07T10:00:00Z');
    await handleVerdict(
      absentEvent(leave, '2026-10-07T10:00:00Z'),
      opts({ getProfile: async () => ({ ...profiles[SID], leaveDays: ['2026-10-07'] }) })
    );

    const untracked = await mkBooking('untracked', '2026-10-08T10:00:00Z');
    await handleVerdict(absentEvent(untracked, '2026-10-08T10:00:00Z'), opts({ getProfile: async () => null }));

    const unassigned = await mkBooking('unassigned', '2026-10-09T10:00:00Z', { host: '' });
    await handleVerdict(absentEvent(unassigned, '2026-10-09T10:00:00Z'), opts());

    assert.equal((await rowsOf(SID)).length, 0);
    assert.equal(posts.length, 0);
  });

  it('a present verdict creates nothing', async () => {
    const id = await mkBooking('pres', '2026-10-05T10:00:00Z');
    await handleVerdict(absentEvent(id, '2026-10-05T10:00:00Z', { verdict: 'present' }), opts());
    assert.equal((await rowsOf(SID)).length, 0);
  });
});

describe('modes and the go-live date', () => {
  it('mode off (the default) writes nothing: no rows, no posts, from any entry point', async () => {
    const miss = await mkBooking('off-miss', '2026-10-05T10:00:00Z');
    const ns = await mkBooking('off-ns', '2026-10-05T10:00:00Z', { status: 'no-show' });
    const st = await mkBooking('off-st', '2026-10-05T10:00:00Z');
    await BdaAttendanceModel.create({
      bdaName: 'Sid', bdaEmail: SID, bookingId: miss, status: 'absent', source: 'scheduler',
      meetingScheduledStart: startOf('2026-10-05T10:00:00Z'), verdict: 'absent', verdictAt: plusMin('2026-10-05T10:00:00Z', 2),
    });
    const off = opts({ mode: 'off' });
    await handleVerdict(absentEvent(miss, '2026-10-05T10:00:00Z'), off);
    const pass = await runDeductionEvaluators(NOW, off);
    assert.equal(pass.skipped, true);
    assert.equal((await evaluateNoShowNotCalled(off)).skipped, 'mode_off');
    assert.equal((await evaluateStatusNotUpdated(off)).skipped, 'mode_off');
    assert.equal((await runDailySummary({ ...off, now: new Date('2026-10-20T17:00:00Z') })).skipped, 'mode_off');
    const direct = await BdaDeductionModel.countDocuments({ bookingId: { $in: [miss, ns, st] } });
    assert.equal(direct, 0);
    assert.equal(posts.length, 0);
    delete process.env.DEDUCTIONS_MODE;
    assert.equal((await evaluateStatusNotUpdated({ ...opts(), mode: undefined })).skipped, 'mode_off', 'unset env means off');
  });

  it('shadow mode: rows are shadow, the BDA channel is never used, tiers are projected among shadow rows only', async () => {
    const a = await mkBooking('sh1', '2026-10-02T10:00:00Z');
    const b = await mkBooking('sh2', '2026-10-03T10:00:00Z');
    const shadow = opts({ mode: 'shadow' });
    await handleVerdict(absentEvent(a, '2026-10-02T10:00:00Z'), shadow);
    await handleVerdict(absentEvent(b, '2026-10-03T10:00:00Z', { healthy: false }), shadow);
    const rows = await rowsOf(SID);
    assert.deepEqual(rows.map((r) => r.status), ['shadow', 'shadow']);
    assert.deepEqual(rows.map((r) => r.tierIndex), [1, 2]);
    assert.ok(posts.every((p) => p.channel === 'admin'));
    assert.ok(posts.every((p) => p.content.startsWith('[shadow')));
    assert.ok(posts.every((p) => !p.content.includes('<@')), 'shadow posts never ping the BDA');
  });

  it('live mode without DEDUCTIONS_LIVE_FROM writes nothing', async () => {
    const id = await mkBooking('nolive', '2026-10-05T10:00:00Z');
    const res = await handleVerdict(absentEvent(id, '2026-10-05T10:00:00Z'), opts({ liveFrom: null }));
    assert.equal(res.created, false);
    assert.equal((await rowsOf(SID)).length, 0);
  });

  it('a meeting before DEDUCTIONS_LIVE_FROM gets no row in any mode, from any evaluator', async () => {
    const before = '2026-09-20T10:00:00Z';
    const miss = await mkBooking('old-miss', before);
    const ns = await mkBooking('old-ns', before, { status: 'no-show' });
    const st = await mkBooking('old-st', before);
    await BdaAttendanceModel.create({
      bdaName: 'Sid', bdaEmail: SID, bookingId: miss, status: 'absent', source: 'scheduler',
      meetingScheduledStart: startOf(before), verdict: 'absent', verdictAt: plusMin(before, 2),
    });
    for (const mode of ['shadow', 'live']) {
      const o = opts({ mode });
      await handleVerdict(absentEvent(miss, before), o);
      await runDeductionEvaluators(NOW, o);
      await evaluateNoShowNotCalled(o);
      await evaluateStatusNotUpdated(o);
    }
    assert.equal(await BdaDeductionModel.countDocuments({ bookingId: { $in: [miss, ns, st] } }), 0);
  });
});

describe('late evidence (plan 2.2)', () => {
  it('VERDICT_CORRECTED voids the linked miss with reason late_evidence and re-prices the month', async () => {
    const ids = [];
    for (const d of [2, 3, 4]) {
      const id = await mkBooking(`le${d}`, `2026-10-0${d}T10:00:00Z`);
      ids.push(id);
      await handleVerdict(absentEvent(id, `2026-10-0${d}T10:00:00Z`), opts());
    }
    const res = await handleVerdictCorrected({ bookingId: ids[0], bdaEmail: SID, correctedAt: NOW, signal: 'google_meet' }, opts());
    assert.equal(res.voided, 1);

    const rows = await rowsOf(SID, '2026-10');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].status, 'voided');
    assert.equal(rows[0].voidReason, 'late_evidence');
    assert.ok(rows[0].voidedAt instanceof Date);
    assert.deepEqual(rows.filter((r) => r.status === 'active').map((r) => r.tierIndex), [1, 2]);

    const again = await handleVerdictCorrected({ bookingId: ids[0], bdaEmail: SID, correctedAt: NOW, signal: 'google_meet' }, opts());
    assert.equal(again.voided, 0, 'idempotent');
  });

  it('voiding runs even in mode off, because it can only lower a fine', async () => {
    const id = await mkBooking('le-off', '2026-10-02T10:00:00Z');
    await handleVerdict(absentEvent(id, '2026-10-02T10:00:00Z'), opts());
    const res = await handleVerdictCorrected({ bookingId: id, bdaEmail: SID, correctedAt: NOW, signal: 'extension_join' }, opts({ mode: 'off' }));
    assert.equal(res.voided, 1);
  });

  it('an absent event that arrives after the correction creates no row, and the sweep voids what the event missed', async () => {
    const id = await mkBooking('le-late', '2026-10-02T10:00:00Z');
    await BdaAttendanceModel.create({
      bdaName: 'Sid', bdaEmail: SID, bookingId: id, status: 'present', source: 'meet_api',
      meetingScheduledStart: startOf('2026-10-02T10:00:00Z'), verdict: 'present', verdictAt: plusMin('2026-10-02T10:00:00Z', 2),
      verdictCorrectedAt: plusMin('2026-10-02T10:00:00Z', 5),
    });
    const stale = await handleVerdict(absentEvent(id, '2026-10-02T10:00:00Z'), opts());
    assert.equal(stale.reason, 'verdict_corrected');
    assert.equal((await rowsOf(SID)).length, 0);

    // The row exists (created before the correction), the VERDICT_CORRECTED event was lost: the sweep fixes it.
    await BdaDeductionModel.create({
      bookingId: id, bdaEmail: SID, rule: 'missed_meeting', month: '2026-10', amountInr: 500, status: 'active',
      evidence: { scheduledStart: startOf('2026-10-02T10:00:00Z') },
    });
    const swept = await sweepCorrectedVerdicts(opts());
    assert.equal(swept.voided, 1);
    assert.equal((await rowsOf(SID))[0].status, 'voided');
  });
});

describe('no_show_not_called (plan 2.5, D1)', () => {
  const START = '2026-10-10T10:00:00Z';
  const phone = `+1 ${digits(10)}`;
  const stubIdentity = {
    getTrackedBdas: async () => Object.values(profiles),
    resolveBda,
    getAssignedBdaEmail,
  };
  const realSummaries = (bookings) => realGetCallSummaries(bookings, stubIdentity);

  async function noShow(key, over = {}) {
    return mkBooking(key, START, {
      status: 'no-show',
      phone,
      history: [{ status: 'no-show', previousStatus: 'scheduled', changedAt: plusMin(START, 50) }],
      statusChangedAt: plusMin(START, 50),
      ...over,
    });
  }
  async function call(id, bookingId, minute) {
    await CallLogModel.create({
      callId: `${PFX}-${id}`, direction: 'outbound', bookingId, leadNumber: phone,
      leadNumberNormalized: normalizeLeadPhone(phone), salesEmail: SID, startedAt: plusMin(START, minute),
      durationSec: 60, callResult: 'connected',
    });
  }
  const at = (m) => opts({ now: plusMin(START, m), getCallSummaries: realSummaries });

  it('a call at +29 min means no fine, a call at +31 min means 100 INR', async () => {
    const early = await noShow('ns-early');
    await call('c-early', early, 29);
    const lateId = await noShow('ns-late', { phone: `+1 ${digits(10)}` });
    await CallLogModel.create({
      callId: `${PFX}-c-late`, direction: 'outbound', bookingId: lateId, leadNumber: 'x', salesEmail: SID,
      startedAt: plusMin(START, 31), durationSec: 60, callResult: 'connected',
    });
    await evaluateNoShowNotCalled(at(60));
    const rows = await rowsOf(SID, undefined, 'no_show_not_called');
    assert.deepEqual(rows.map((r) => r.bookingId), [lateId]);
    assert.equal(rows[0].amountInr, 100);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[0].evidence.callSummary.calls, 1);
    assert.equal(rows[0].evidence.callSummary.calledWithin30Min, false);
    assert.equal(posts.length, 1);
    assert.match(posts[0].content, /^<@111111111111111111> ₹100 deduction, Sid: Client ns-late was a no-show at 3:30 PM IST and no Zoom call to them was found within 30 min\.$/);
  });

  it('holds the fine for review when a colleague covered the no-show meeting, and still fines when nobody did', async () => {
    const cover = (bookingId, startIso) => BdaAttendanceModel.create({
      bookingId, bdaEmail: KAL, bdaName: 'Kal', meetingScheduledStart: startOf(startIso), status: 'present', verdict: 'present',
      source: 'meet_api', firstJoinedAt: plusMin(startIso, -1), durationMs: 25 * 60000, signals: [{ kind: 'extension_join', eventAt: plusMin(startIso, -1) }],
    });
    const covered = await noShow('ns-cov');
    await cover(covered, START);
    const alone = await noShow('ns-alone', { phone: `+1 ${digits(10)}` });
    await evaluateNoShowNotCalled(at(60));
    const rows = await rowsOf(SID, undefined, 'no_show_not_called');
    assert.equal(rows.find((r) => r.bookingId === covered).status, 'needs_review');
    assert.equal(rows.find((r) => r.bookingId === covered).evidence.coveredBy[0].bdaEmail, KAL);
    assert.equal(rows.find((r) => r.bookingId === alone).status, 'active');
  });

  it('waits for the health window: nothing is judged before start + 40 min', async () => {
    await noShow('ns-wait');
    await evaluateNoShowNotCalled(at(35));
    assert.equal((await rowsOf(SID, undefined, 'no_show_not_called')).length, 0);
    await evaluateNoShowNotCalled(at(41));
    assert.equal((await rowsOf(SID, undefined, 'no_show_not_called')).length, 1);
  });

  it('is idempotent: a second run adds nothing', async () => {
    await noShow('ns-twice');
    await evaluateNoShowNotCalled(at(60));
    await evaluateNoShowNotCalled(at(65));
    assert.equal((await rowsOf(SID, undefined, 'no_show_not_called')).length, 1);
    assert.equal(posts.length, 1);
  });

  it('a stale Zoom sync inside the window makes it needs_review, which does not count', async () => {
    await noShow('ns-stale');
    zoomHealthy = false;
    await evaluateNoShowNotCalled(at(60));
    const [row] = await rowsOf(SID, undefined, 'no_show_not_called');
    assert.equal(row.status, 'needs_review');
    assert.equal(row.evidence.healthy, false);
    assert.equal(posts[0].channel, 'admin');
  });

  it('asks the health check about the exact window [start, start + 40 min] against the 30 min limit', async () => {
    await noShow('ns-window');
    let asked = null;
    await evaluateNoShowNotCalled(
      at(60) && opts({
        now: plusMin(START, 60),
        getCallSummaries: realSummaries,
        sourceHealthy: async (source, w) => {
          asked = { source, ...w };
          return true;
        },
      })
    );
    assert.equal(asked.source, 'zoom_phone');
    assert.equal(asked.fromMs, startOf(START).getTime());
    assert.equal(asked.toMs, plusMin(START, 40).getTime());
    assert.equal(asked.maxAgeMs, 30 * 60000);
  });

  it('needs a client phone, a countable meeting and the assigned BDA', async () => {
    await noShow('ns-nophone', { phone: '' });
    await noShow('ns-unassigned', { host: '' });
    await noShow('ns-kal', { host: KAL });
    await evaluateNoShowNotCalled(at(60));
    const rows = await rowsOf(SID, undefined, 'no_show_not_called');
    const kalRows = await rowsOf(KAL, undefined, 'no_show_not_called');
    assert.equal(rows.length, 0);
    assert.equal(kalRows.length, 1, 'the fine goes to the BDA the meeting belongs to');
  });

  it('keeps judging for 60 days and then stops', async () => {
    await noShow('ns-60');
    await evaluateNoShowNotCalled(at(61 * 24 * 60));
    assert.equal((await rowsOf(SID, undefined, 'no_show_not_called')).length, 0);
    await evaluateNoShowNotCalled(at(59 * 24 * 60));
    assert.equal((await rowsOf(SID, undefined, 'no_show_not_called')).length, 1);
  });
});

describe('status_not_updated (plan 2.5, D2)', () => {
  const START = '2026-10-10T10:00:00Z';
  const at = (m) => opts({ now: plusMin(START, m) });

  it('fires once at start + 2 h and never again, even after the status is updated later', async () => {
    const id = await mkBooking('st1', START);
    await evaluateStatusNotUpdated(at(119));
    assert.equal((await rowsOf(SID, undefined, 'status_not_updated')).length, 0, 'not before the deadline');
    await evaluateStatusNotUpdated(at(125));
    await evaluateStatusNotUpdated(at(130));
    assert.equal((await rowsOf(SID, undefined, 'status_not_updated')).length, 1);

    await CampaignBookingModel.updateOne({ bookingId: id }, {
      $set: {
        bookingStatus: 'completed', statusChangedAt: plusMin(START, 200),
        statusHistory: [{ status: 'completed', previousStatus: 'scheduled', changedAt: plusMin(START, 200) }],
      },
    });
    await evaluateStatusNotUpdated(at(300));
    const rows = await rowsOf(SID, undefined, 'status_not_updated');
    assert.equal(rows.length, 1, 'updating later does not fine again or undo the first fine');
    assert.equal(rows[0].amountInr, 50);
    assert.equal(posts.length, 1);
  });

  it('holds the fine for review when a colleague covered the meeting, and still fines when nobody did', async () => {
    const cover = (bookingId, startIso) => BdaAttendanceModel.create({
      bookingId, bdaEmail: KAL, bdaName: 'Kal', meetingScheduledStart: startOf(startIso), status: 'present', verdict: 'present',
      source: 'meet_api', firstJoinedAt: plusMin(startIso, -1), durationMs: 25 * 60000, signals: [{ kind: 'extension_join', eventAt: plusMin(startIso, -1) }],
    });
    const covered = await mkBooking('st-cov', START);
    await cover(covered, START);
    const alone = await mkBooking('st-alone', '2026-10-11T10:00:00Z');
    await evaluateStatusNotUpdated(opts({ now: plusMin('2026-10-11T10:00:00Z', 125) }));
    const rows = await rowsOf(SID, undefined, 'status_not_updated');
    assert.equal(rows.find((r) => r.bookingId === covered).status, 'needs_review');
    assert.equal(rows.find((r) => r.bookingId === covered).evidence.coveredBy[0].bdaName, 'Kal');
    assert.equal(rows.find((r) => r.bookingId === alone).status, 'active');
  });

  it('a change before the deadline satisfies the rule', async () => {
    await mkBooking('st-ok', START, {
      status: 'completed', statusChangedAt: plusMin(START, 60),
      history: [{ status: 'completed', previousStatus: 'scheduled', changedAt: plusMin(START, 60) }],
    });
    await evaluateStatusNotUpdated(at(300));
    assert.equal((await rowsOf(SID, undefined, 'status_not_updated')).length, 0);
  });

  it('a change just after the deadline that no tick saw in time still costs the 50', async () => {
    await mkBooking('st-late', START, {
      status: 'completed', statusChangedAt: plusMin(START, 121),
      history: [{ status: 'completed', previousStatus: 'scheduled', changedAt: plusMin(START, 121) }],
    });
    await evaluateStatusNotUpdated(at(130));
    assert.equal((await rowsOf(SID, undefined, 'status_not_updated')).length, 1);
  });

  it('honours the deadline setting and the backend-up check (needs_review when the job never ran)', async () => {
    await mkBooking('st-cfg', START);
    await evaluateStatusNotUpdated(opts({ now: plusMin(START, 100), statusDeadlineMs: 90 * 60000 }));
    assert.equal((await rowsOf(SID, undefined, 'status_not_updated')).length, 1);

    await mkBooking('st-down', '2026-10-11T10:00:00Z');
    jobRan = false;
    await evaluateStatusNotUpdated(opts({ now: plusMin('2026-10-11T10:00:00Z', 130) }));
    const down = (await rowsOf(SID, undefined, 'status_not_updated')).find((r) => r.bookingId.endsWith('st-down'));
    assert.equal(down.status, 'needs_review');
  });
});

describe('the 60 day loophole (plan 2.5)', () => {
  it('no-show left on scheduled, set to no-show 3 days later with no call: both 50 and 100 exist', async () => {
    const START = '2026-10-10T10:00:00Z';
    const id = await mkBooking('loop', START);
    await evaluateStatusNotUpdated(opts({ now: plusMin(START, 130) }));
    await evaluateNoShowNotCalled(opts({ now: plusMin(START, 130) }));
    assert.deepEqual((await BdaDeductionModel.find({ bookingId: id }).lean()).map((r) => r.rule), ['status_not_updated']);

    const threeDays = plusMin(START, 3 * 24 * 60);
    await CampaignBookingModel.updateOne({ bookingId: id }, {
      $set: {
        bookingStatus: 'no-show', statusChangedAt: threeDays,
        statusHistory: [{ status: 'no-show', previousStatus: 'scheduled', changedAt: threeDays }],
      },
    });
    const later = opts({ now: plusMin(threeDays.toISOString(), 10) });
    await evaluateNoShowNotCalled(later);
    await evaluateStatusNotUpdated(later);
    await evaluateNoShowNotCalled(later);

    const rows = await BdaDeductionModel.find({ bookingId: id }).lean();
    assert.deepEqual(rows.map((r) => [r.rule, r.amountInr, r.status]).sort(), [
      ['no_show_not_called', 100, 'active'],
      ['status_not_updated', 50, 'active'],
    ]);
  });
});

describe('convert a "marked present, never joined" flag (decision D10)', () => {
  const START = '2026-10-05T10:00:00Z';
  async function flagged(key, over = {}) {
    const id = await mkBooking(key, START);
    await BdaAttendanceModel.create({
      bdaName: 'Sid', bdaEmail: SID, bookingId: id, status: 'present', source: 'manual',
      meetingScheduledStart: startOf(START), verdict: 'present', verdictAt: plusMin(START, 2),
      signals: [{ kind: 'button_crm', eventAt: plusMin(START, -1), receivedAt: plusMin(START, -1) }],
      integrityFlag: 'marked_never_joined', ...over,
    });
    return id;
  }
  const args = (bookingId, over = {}) => ({ bookingId, bdaEmail: SID, reason: 'Google shows they never joined', actor: ADMIN, ...over });

  it('creates an active miss with the reason in evidence, re-prices, posts and closes the flag', async () => {
    const earlier = await mkBooking('conv-early', '2026-10-02T10:00:00Z');
    await handleVerdict(absentEvent(earlier, '2026-10-02T10:00:00Z'), opts());
    const id = await flagged('conv');

    const res = await convertFlagToMiss(args(id), opts());
    assert.equal(res.ok, true);
    assert.equal(res.deduction.status, 'active');
    assert.equal(res.deduction.rule, 'missed_meeting');
    assert.equal(res.deduction.tierIndex, 2, 'counted after the earlier miss');
    assert.equal(res.deduction.evidence.convertedFromFlag.reason, 'Google shows they never joined');
    assert.equal(res.deduction.evidence.convertedFromFlag.by, ADMIN.email);
    assert.equal(posts.length, 2);
    const att = await BdaAttendanceModel.findOne({ bookingId: id }).lean();
    assert.equal(att.integrityResolved.action, 'converted');
    assert.equal(att.integrityResolved.reason, 'Google shows they never joined');

    const again = await convertFlagToMiss(args(id), opts());
    assert.equal(again.status, 409);
    assert.equal(again.code, 'no_open_flag');
  });

  it('respects the mode: off refuses, shadow writes a shadow row', async () => {
    const id = await flagged('conv-mode');
    const off = await convertFlagToMiss(args(id), opts({ mode: 'off' }));
    assert.equal(off.status, 409);
    assert.equal(off.code, 'deductions_off');
    assert.equal((await rowsOf(SID)).length, 0);

    const shadow = await convertFlagToMiss(args(id), opts({ mode: 'shadow' }));
    assert.equal(shadow.ok, true);
    assert.equal(shadow.deduction.status, 'shadow');
  });

  it('refuses a meeting with no flag, the wrong BDA, an unknown meeting and a pre-go-live meeting', async () => {
    const clean = await mkBooking('conv-clean', START);
    await BdaAttendanceModel.create({
      bdaName: 'Sid', bdaEmail: SID, bookingId: clean, status: 'present', source: 'manual',
      meetingScheduledStart: startOf(START), verdict: 'present',
    });
    assert.equal((await convertFlagToMiss(args(clean), opts())).code, 'no_open_flag');
    assert.equal((await convertFlagToMiss(args(`${PFX}-ghost`), opts())).code, 'attendance_not_found');

    const id = await flagged('conv-wrong');
    await BdaAttendanceModel.create({
      bdaName: 'Kal', bdaEmail: KAL, bookingId: id, status: 'present', source: 'manual',
      meetingScheduledStart: startOf(START), verdict: 'present', integrityFlag: 'marked_never_joined',
    });
    assert.equal((await convertFlagToMiss(args(id, { bdaEmail: KAL }), opts())).code, 'not_assigned');

    const old = await flagged('conv-old');
    const res = await convertFlagToMiss(args(old), opts({ liveFrom: new Date('2026-11-01T00:00:00Z') }));
    assert.equal(res.code, 'before_live_from');
  });
});

describe('daily summary (plan D7)', () => {
  // 22:30 IST today by the real calendar, so the createdAt of rows written in the test falls inside "today".
  const todayIst = DateTime.now().setZone('Asia/Kolkata');
  const evening = todayIst.startOf('day').plus({ hours: 22, minutes: 30 });
  const dayStart = todayIst.startOf('day');

  async function seedDay() {
    const mk = async (key, hour, verdict, status = 'scheduled') => {
      const iso = dayStart.plus({ hours: hour }).toUTC().toISO();
      const id = await mkBooking(key, iso, { status });
      await BdaAttendanceModel.create({
        bdaName: 'Sid', bdaEmail: SID, bookingId: id, status: verdict === 'present' ? 'present' : 'absent', source: 'scheduler',
        meetingScheduledStart: new Date(iso), verdict,
      });
      return id;
    };
    const a = await mk('day-a', 9, 'present', 'completed');
    await mk('day-b', 11, 'absent');
    await mk('day-c', 13, 'present');
    summaries[a] = { calls: 3, calledWithin30Min: true };
    await BdaDeductionModel.create({
      bookingId: `${PFX}-day-b`, bdaEmail: SID, rule: 'missed_meeting', month: '2026-10', amountInr: 500, status: 'active',
      evidence: { scheduledStart: dayStart.plus({ hours: 11 }).toJSDate() },
    });
  }

  it('posts one summary per tracked BDA after 22:00 IST, once, with meetings, calls, pending statuses and deductions', async () => {
    await seedDay();
    const o = opts({ now: evening.toJSDate(), mode: 'live' });
    const first = await runDailySummary(o);
    const second = await runDailySummary(o);
    assert.equal(first.posted, 2);
    assert.equal(second.posted, 0, 'deduped by the digest marker');
    assert.equal(posts.length, 2);
    const sid = posts.find((p) => p.content.includes('Sid'));
    assert.equal(sid.channel, 'deductions');
    assert.ok(sid.content.startsWith('<@111111111111111111>'));
    assert.match(sid.content, /Meetings: 3 \(2 present, 1 absent\)/);
    assert.match(sid.content, /Calls to clients: 3 across 1 meeting\n/);
    assert.match(sid.content, /Statuses still on scheduled: 2/);
    assert.match(sid.content, /Deductions today: ₹500 from 1/);
  });

  it('stays quiet before 22:00 IST, in mode off, and retries after a failed post', async () => {
    await seedDay();
    const early = opts({ now: dayStart.plus({ hours: 21, minutes: 59 }).toJSDate() });
    assert.equal((await runDailySummary(early)).skipped, 'too_early');

    let ok = false;
    const flaky = opts({ now: evening.toJSDate(), post: async (p) => { posts.push(p); return { ok }; } });
    const failed = await runDailySummary(flaky);
    assert.equal(failed.posted, 0);
    ok = true;
    const retried = await runDailySummary(flaky);
    assert.equal(retried.posted, 2, 'a failed post leaves no marker behind');
  });

  it('shadow mode sends the summary to the admin channel without mentioning anyone', async () => {
    await seedDay();
    await runDailySummary(opts({ now: evening.toJSDate(), mode: 'shadow' }));
    assert.ok(posts.length > 0);
    assert.ok(posts.every((p) => p.channel === 'admin' && !p.content.includes('<@')));
  });
});

describe('engine lifecycle', () => {
  it('subscribes to the three attendance events on start and unsubscribes on stop', async () => {
    const counts = () => [EVENTS.VERDICT, EVENTS.VERDICT_CORRECTED, EVENTS.INTEGRITY_FLAGGED].map((e) => attendanceEvents.listenerCount(e));
    const base = counts();
    process.env.DEDUCTIONS_MODE = 'off'; // the first tick starts with deductions off and returns at once
    try {
      startDeductionEngine();
      startDeductionEngine(); // idempotent
      assert.deepEqual(counts(), base.map((n) => n + 1));
      stopDeductionEngine();
      assert.deepEqual(counts(), base);
    } finally {
      stopDeductionEngine();
      delete process.env.DEDUCTIONS_MODE;
    }
  });

  it('turns a VERDICT event from the bus into a row, and VERDICT_CORRECTED into a void (real registry, shadow mode)', async () => {
    // Tracked since before the meeting: a meeting from before tracking began is never fined.
    await BdaProfileModel.create({ email: SID, displayName: 'Sid', firstName: 'sid', lastName: 'x', tracked: true, trackedSince: new Date('2026-09-01T00:00:00Z') });
    invalidateRegistryCache();
    const id = await mkBooking('bus', '2026-10-05T10:00:00Z');

    process.env.DEDUCTIONS_MODE = 'off';
    try {
      startDeductionEngine();
      await new Promise((r) => setImmediate(r)); // let the boot tick see "off" before the mode changes
      await new Promise((r) => setImmediate(r));
      process.env.DEDUCTIONS_MODE = 'shadow';
      process.env.DEDUCTIONS_LIVE_FROM = '2026-10-01';

      emitAttendanceEvent(EVENTS.VERDICT, absentEvent(id, '2026-10-05T10:00:00Z'));
      const row = await waitFor(async () => (await rowsOf(SID))[0]);
      assert.equal(row.status, 'shadow');
      assert.equal(row.bookingId, id);

      emitAttendanceEvent(EVENTS.VERDICT_CORRECTED, { bookingId: id, bdaEmail: SID, correctedAt: new Date(), signal: 'google_meet' });
      const voided = await waitFor(async () => {
        const [r] = await rowsOf(SID);
        return r.status === 'voided' ? r : null;
      });
      assert.equal(voided.voidReason, 'late_evidence');
    } finally {
      stopDeductionEngine();
      delete process.env.DEDUCTIONS_MODE;
      delete process.env.DEDUCTIONS_LIVE_FROM;
    }
  });
});

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting for the engine');
    await new Promise((r) => setTimeout(r, 50));
  }
}

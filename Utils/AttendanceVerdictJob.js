import { DateTime } from 'luxon';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaAttendanceWarnDedupeModel } from '../Schema_Models/BdaAttendanceWarnDedupe.js';
import { BdaExtensionHeartbeatModel } from '../Schema_Models/BdaExtensionHeartbeat.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { EVENTS, emitAttendanceEvent } from './attendanceEvents.js';
import { postAbsentChannel, postAdminChannel, postAttendanceChannel } from './attendanceDiscord.js';
import { countableReason, getAssignedBdaEmail, isAfterGoLive } from './BdaAssignment.js';
import { isLeaveDayFor } from './WorkDay.js';
import { getBdaProfile, getTrackedBdas } from './BdaRegistry.js';
import { finesAreLive } from './deductionPolicy.js';
import { doubleBookedLine, findOverlappingMeetings } from './DoubleBooking.js';
import { SYNC_LIMITS_MS, getAllSyncHealth, recordSyncError, recordSyncOk, syncOkBetween, wasSourceHealthy } from './SyncHealth.js';
import { WINDOW_CLOSES_AFTER_MS, VERDICT_SETTLE_MS, formatIstTime } from './recordPresentSignal.js';
import { MIN_STAY_MS, presenceVerdict, formatStay } from './AttendanceStay.js';

// The server decides who was present (plan 2.2, 5.4). One job, several steps on different clocks:
//   every 5 s   verdicts, on their own timer: start + 60 s when nobody marked present in time (the absent alert),
//                start + 3 min 30 s for everyone else (window + 2 min minimum stay + settle)
//   every 60 s  "your extension is offline" warning 9 to 11 minutes before a meeting
//   every 5 min integrity check (button without a join) and sync-health alerts
//   daily 18:00 IST  meetings tomorrow whose BDA is on leave
// Every step is a function of (now, deps), so tests run it with a fake clock, poster and Meet verifier.

const VERDICT_EVERY_MS = 5 * 1000;
const HOUSEKEEPING_EVERY_MS = 15 * 1000;
const HEARTBEAT_ALERT_EVERY_MS = 60 * 1000;
const SLOW_STEPS_EVERY_MS = 5 * 60 * 1000;

// Two decision points. A BDA who gave NO present signal in time is absent the moment the window closes (start + 60 s):
// how long they would have stayed is moot, so the alert goes out right then. Everyone else waits until a BDA who joined
// at the last allowed moment (start + 60 s) could have stayed the minimum MIN_STAY_MS, plus the settle time for
// Google's records: start + 3 min 30 s. That later point decides present vs left early.
const NO_SIGNAL_DELAY_MS = WINDOW_CLOSES_AFTER_MS;
const VERDICT_DELAY_MS = WINDOW_CLOSES_AFTER_MS + MIN_STAY_MS + VERDICT_SETTLE_MS;
// One live Google check per meeting runs before the verdict. Capped so a slow Google call delays the absent alert by
// at most this long (it used to be 20 s per meeting, one after another). If Google did not answer in time the
// verdict is marked unhealthy, so a fine goes to review instead of being applied.
const GOOGLE_CHECK_TIMEOUT_MS = Number(process.env.VERDICT_GOOGLE_CHECK_MS) || 5000;
// Meetings judged at the same moment (a busy :00 or :30 slot) run in parallel batches of this size.
const VERDICT_CONCURRENCY = 5;
// A verdict written later than this after its decision point gets a warning, so a stalled loop shows in the logs.
const VERDICT_LATE_WARN_MS = 15 * 1000;
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const JOB_HEALTH_DEADLINE_MS = 5 * 60 * 1000; // plan 2.7: the job must have run by start + 5 min
const INTEGRITY_AFTER_MS = 3 * 60 * 60 * 1000;
const INTEGRITY_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const HEARTBEAT_ALERT_MIN_MS = 9 * 60 * 1000;
const HEARTBEAT_ALERT_MAX_MS = 11 * 60 * 1000;
const REASSIGN_POST_HOUR_IST = 18;
const WORKING_HOURS_IST = { from: 8, to: 22 };
const SYNC_REALERT_MS = 60 * 60 * 1000;

const BUTTON_KINDS = ['button_meet', 'button_crm'];
const ASSIGNED_ANYONE = [
  { 'attendanceAssignee.email': { $nin: [null, ''] } },
  { 'calendlyHost.email': { $nin: [null, ''] } },
  { 'claimedBy.email': { $nin: [null, ''] } },
];

const BOOKING_FIELDS =
  'bookingId clientName clientEmail bookingStatus statusHistory scheduledEventStartTime scheduledEventEndTime googleMeetCode googleMeetUrl calendlyMeetLink calendlyHost claimedBy attendanceAssignee';

const toMs = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

function buildDeps(deps = {}) {
  return {
    poster: postAbsentChannel,
    adminPoster: postAdminChannel,
    attendancePoster: postAttendanceChannel,
    meetVerifier: async (booking) => {
      const { syncBookingFromMeetNow } = await import('./MeetAttendanceScheduler.js');
      return syncBookingFromMeetNow(booking);
    },
    getHeartbeat: async (email) => BdaExtensionHeartbeatModel.findOne({ bdaEmail: email }).lean(),
    bookingFilter: {}, // tests narrow every query to their own bookings
    ...deps,
    registry: { getBdaProfile, ...(deps.registry || {}) },
    health: { recordSyncOk, recordSyncError, wasSourceHealthy, syncOkBetween, getAllSyncHealth, ...(deps.health || {}) },
  };
}

function withFilter(base, deps) {
  return deps.bookingFilter && Object.keys(deps.bookingFilter).length ? { $and: [base, deps.bookingFilter] } : base;
}

async function safePost(poster, message, label) {
  try {
    const ok = await poster(message);
    if (ok === false) console.warn(`[AttendanceVerdict] ${label} post did not go out (no webhook or Discord refused)`);
    return ok !== false;
  } catch (err) {
    console.error(`[AttendanceVerdict] ${label} post failed:`, err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * Was every source this verdict rests on healthy (plan 2.7)? False tells the deduction engine to create
 * needs_review instead of active. Healthy needs both:
 *   - the verdict job ran between start + 60 s and start + 5 min (this pass is that run when it is on time)
 *   - Google's sync was no older than 10 min at verdict time, unless the BDA's extension sent a heartbeat
 */
export async function computeVerdictHealth({ startMs, nowMs, bdaEmail, googleChecked = true }, deps) {
  const jobOk =
    nowMs <= startMs + JOB_HEALTH_DEADLINE_MS ||
    (await deps.health.syncOkBetween('verdict_job', startMs + WINDOW_CLOSES_AFTER_MS, startMs + JOB_HEALTH_DEADLINE_MS));
  if (!jobOk) return false;

  const googleOk =
    googleChecked &&
    (await deps.health.wasSourceHealthy('google_meet', {
      fromMs: nowMs,
      toMs: nowMs,
      maxAgeMs: SYNC_LIMITS_MS.google_meet,
    }));
  if (googleOk) return true;

  // The extension proves it was alive only with a heartbeat around the window itself. A heartbeat from long after
  // (a catch-up verdict hours later) says nothing about the meeting, so it does not count.
  const beat = await deps.getHeartbeat(bdaEmail);
  const beatMs = beat?.lastHeartbeatAt ? toMs(beat.lastHeartbeatAt) : NaN;
  return Number.isFinite(beatMs) && beatMs >= startMs - 5 * 60 * 1000 && beatMs <= startMs + JOB_HEALTH_DEADLINE_MS;
}

/**
 * Write the verdict for every countable meeting that has none yet: at start + 60 s when no present signal arrived
 * in time, at start + VERDICT_DELAY_MS for the rest (see writeVerdict).
 * Returns { checked, verdicts: [{ bookingId, bdaEmail, verdict }] } for the verdicts THIS call wrote.
 */
/**
 * The immediate absent alert. Posted the moment the verdict is written: start + 60 s when nobody marked present in
 * time, start + 3 min 30 s when the BDA joined but left early. Google's own confirmation ("verified from Google Meet
 * records") follows from MeetAttendanceScheduler once its data has settled.
 * `leftEarly` is set when the BDA was there in time but left before staying MIN_STAY_MS after the start.
 */
function absentAlertMessage({ who, bdaEmail, clientName, startMs, roster, doubleBooked = '', leftEarly = null }) {
  const when = DateTime.fromMillis(startMs, { zone: 'Asia/Kolkata' }).toFormat('dd MMM yyyy, hh:mm a');
  if (leftEarly) {
    return (
      `🚫 **BDA Absent: left the call too early**\n` +
      `**BDA:** ${who} (${bdaEmail})\n` +
      `**Client:** ${clientName || 'the client'}\n` +
      `**Meeting:** ${when}\n` +
      (leftEarly.leftAt ? `**Left the call at:** ${formatIstTime(leftEarly.leftAt)}\n` : '') +
      `**In the call after the start:** ${formatStay(leftEarly.ms)} (at least ${formatStay(MIN_STAY_MS)} needed)\n` +
      (roster ? `**Who was in the call:** ${roster}\n` : '') +
      doubleBooked +
      `_Joined in time but did not stay in the meeting, so attendance is not counted._` +
      (finesAreLive() ? ' A fine applies per policy.' : '')
    );
  }
  return (
    `🚫 **BDA Absent**\n` +
    `**BDA:** ${who} (${bdaEmail})\n` +
    `**Client:** ${clientName || 'the client'}\n` +
    `**Meeting:** ${when}\n` +
    `**Not marked present by:** ${formatIstTime(startMs + WINDOW_CLOSES_AFTER_MS)}\n` +
    (roster ? `**Who was in the call:** ${roster}\n` : '') +
    doubleBooked +
    `_No present signal arrived in time. Google Meet records will confirm shortly._` +
    // The fine line only appears when fines are really on, so the channel never promises a deduction that is off.
    (finesAreLive() ? ' A fine applies per policy.' : '')
  );
}

/** Re-send absent alerts whose first delivery failed (Discord down at start + 60 s). Only the last 30 minutes. */
async function retryPendingAbsentAlerts(nowMs, d) {
  // Only rows whose first post is at least 60 s old: the first attempt (with DiscordConnect's own retries) can
  // still be in flight, and a second instance retrying it now would post the alert twice.
  const pending = await BdaAttendanceModel.find({
    verdict: 'absent',
    verdictAlertPending: true,
    verdictAt: { $gte: new Date(nowMs - 30 * 60 * 1000), $lte: new Date(nowMs - 60 * 1000) },
  })
    .limit(20)
    .lean();
  for (const candidate of pending) {
    // Claim it first, conditionally, so exactly one instance re-sends it. Undone below if the post fails.
    const row = await BdaAttendanceModel.findOneAndUpdate(
      { _id: candidate._id, verdict: 'absent', verdictAlertPending: true },
      { $set: { verdictAlertPending: false } },
      { new: true }
    ).lean();
    if (!row) continue;
    const booking = await CampaignBookingModel.findOne({ bookingId: row.bookingId }).select(BOOKING_FIELDS).lean();
    if (!booking) continue; // already claimed (flag cleared); nothing to say about a deleted booking
    const profile = await d.registry.getBdaProfile(row.bdaEmail);
    const delivered = await safePost(
      d.poster,
      absentAlertMessage({
        who: profile?.displayName || row.bdaName || row.bdaEmail,
        bdaEmail: row.bdaEmail,
        clientName: booking.clientName,
        startMs: toMs(booking.scheduledEventStartTime),
        roster: (row.participantsAtJoin || []).map((p) => p.displayName).filter(Boolean).join(', '),
        leftEarly: row.verdictReason === 'left_early' ? { ms: row.verdictStayMs, leftAt: row.leftAt || null } : null,
      }),
      'absent-retry'
    );
    if (!delivered) await BdaAttendanceModel.updateOne({ _id: row._id, verdict: 'absent' }, { $set: { verdictAlertPending: true } });
  }
}

export async function runVerdictPass(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);

  await retryPendingAbsentAlerts(nowMs, d).catch((err) => console.warn('[AttendanceVerdict] alert retry failed:', err?.message));

  const bookings = await CampaignBookingModel.find(
    withFilter(
      {
        scheduledEventStartTime: { $gte: new Date(nowMs - LOOKBACK_MS), $lte: new Date(nowMs - NO_SIGNAL_DELAY_MS) },
        $or: ASSIGNED_ANYONE,
      },
      d
    )
  )
    .select(BOOKING_FIELDS)
    .lean();
  if (bookings.length === 0) return { checked: 0, verdicts: [] };

  const judged = await BdaAttendanceModel.find({
    bookingId: { $in: bookings.map((b) => b.bookingId) },
    verdict: { $ne: null },
  })
    .select('bookingId bdaEmail')
    .lean();
  const done = new Set(judged.map((r) => `${r.bookingId}|${r.bdaEmail}`));

  const due = [];
  for (const booking of bookings) {
    const bdaEmail = getAssignedBdaEmail(booking);
    if (!bdaEmail || done.has(`${booking.bookingId}|${bdaEmail}`)) continue;

    const profile = await d.registry.getBdaProfile(bdaEmail);
    // Leave days, untracked BDAs and meetings canceled before they started get no verdict and no message.
    if (!countableReason(booking, profile, nowMs).countable) continue;

    // Go-live: judge only meetings that started after this BDA was put in the registry. Without this, seeding the
    // registry would judge the last 24 hours at once, and every meeting recorded by the old system (no signals yet)
    // would be called absent, firing a burst of false alerts. `ignoreGoLive` is for tests only.
    if (!d.ignoreGoLive && !isAfterGoLive(profile, toMs(booking.scheduledEventStartTime))) continue;

    due.push({ booking, bdaEmail, profile });
  }

  // Parallel batches: each verdict may wait on a live Google check, and a :00 slot has several meetings.
  const verdicts = [];
  for (let i = 0; i < due.length; i += VERDICT_CONCURRENCY) {
    const batch = due.slice(i, i + VERDICT_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ booking, bdaEmail, profile }) => {
        try {
          return await writeVerdict({ booking, bdaEmail, profile, nowMs, now: new Date(nowMs) }, d);
        } catch (err) {
          // One bad meeting must not stop the others in the batch from being judged.
          console.error(`[AttendanceVerdict] verdict failed for ${booking.bookingId}:`, err?.message || err);
          return null;
        }
      })
    );
    for (const r of results) if (r) verdicts.push(r);
  }
  return { checked: bookings.length, verdicts };
}

async function writeVerdict({ booking, bdaEmail, profile, nowMs, now }, d) {
  const startMs = toMs(booking.scheduledEventStartTime);

  // Before the later decision point only "nobody marked present in time" can be decided. Someone who did give a
  // signal waits for the minimum-stay check, so skip them here without spending a Google call every tick.
  const tooEarlyForStay = nowMs - startMs < VERDICT_DELAY_MS;
  if (tooEarlyForStay) {
    const stored = await BdaAttendanceModel.findOne({ bookingId: booking.bookingId, bdaEmail }).lean();
    if (stored?.verdict) return null;
    if (presenceVerdict(stored, startMs, nowMs).reason !== 'no_signal') return null;
  }

  // One live Google check per meeting, then judge from what is stored. The verifier never throws, but a fake might.
  // Bounded: one hung Google call must not stall the alert (or every verdict behind it).
  // googleChecked: Google was really asked about THIS meeting. A sync that resolved no Meet code or had no API
  // client returns checked: false, and must not count as "Google is healthy" for this verdict (finding 2026-10-09).
  let googleChecked = false;
  try {
    const checkedResult = await Promise.race([
      d.meetVerifier(booking),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Google check timed out after ${GOOGLE_CHECK_TIMEOUT_MS} ms`)), GOOGLE_CHECK_TIMEOUT_MS).unref?.()),
    ]);
    googleChecked = checkedResult?.checked === true;
  } catch (err) {
    console.warn(`[AttendanceVerdict] live Meet check failed for ${booking.bookingId}: ${err?.message}`);
  }

  const row = await BdaAttendanceModel.findOne({ bookingId: booking.bookingId, bdaEmail }).lean();
  if (row?.verdict) return null; // an overlapping pass or another instance got there first

  // One rule for "was the BDA there": an in-time signal AND no proof of leaving before MIN_STAY_MS after the start.
  const judged = presenceVerdict(row, startMs, nowMs);
  // The Google check may have just shown an in-time join: that BDA now waits for the minimum-stay decision.
  if (tooEarlyForStay && judged.reason !== 'no_signal') return null;
  const dueAtMs = startMs + (judged.reason === 'no_signal' ? NO_SIGNAL_DELAY_MS : VERDICT_DELAY_MS);
  if (nowMs - dueAtMs > VERDICT_LATE_WARN_MS) {
    console.warn(`[AttendanceVerdict] verdict for ${booking.bookingId} is ${Math.round((nowMs - dueAtMs) / 1000)} s past its decision point; the loop was stalled or the job just restarted`);
  }
  const verdict = judged.present ? 'present' : 'absent';
  const verdictSignal = judged.counted[0]?.kind ?? null;

  const base = { bookingId: booking.bookingId, bdaEmail, verdict: null };
  const update = {
    $set: {
      verdict,
      verdictAt: now,
      verdictSignal,
      verdictReason: judged.reason,
      verdictStayMs: judged.stay.known ? judged.stay.ms : null,
      verdictAlertPending: verdict === 'absent',
    },
  };
  if (!row) {
    update.$setOnInsert = {
      attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      bdaName: profile?.displayName || booking.calendlyHost?.name || bdaEmail.split('@')[0],
      // 'unmarked' keeps legacy readers from treating a verdict row as a recorded presence or absence.
      status: 'unmarked',
      source: 'scheduler',
      markedAt: now,
      meetingScheduledStart: booking.scheduledEventStartTime,
      meetingScheduledEnd: booking.scheduledEventEndTime || null,
      meetLink: booking.googleMeetUrl || booking.calendlyMeetLink || null,
      notes: 'Verdict written by the attendance verdict job',
    };
  }

  // Conditional on verdict: null so two instances can never both write (and never both post).
  let won = false;
  try {
    const res = await BdaAttendanceModel.updateOne(base, update, { upsert: !row });
    won = (res.modifiedCount ?? 0) > 0 || (res.upsertedCount ?? 0) > 0;
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  if (!won) return null;

  // Close the race: a signal can be pushed between the read above and the write (its own check then saw verdict
  // null and skipped the correction). Re-read once; if in-time evidence is there now, the absent never stands, never
  // alerts and never fines. A signal pushed after this re-read sees verdict 'absent' and corrects it itself.
  if (verdict === 'absent') {
    const after = await BdaAttendanceModel.findOne({ bookingId: booking.bookingId, bdaEmail }).lean();
    const late = presenceVerdict(after, startMs, nowMs);
    if (late.present) {
      await BdaAttendanceModel.updateOne(
        { bookingId: booking.bookingId, bdaEmail, verdict: 'absent' },
        { $set: { verdict: 'present', verdictSignal: late.counted[0].kind, verdictReason: 'present', verdictCorrectedAt: now, verdictAlertPending: false } }
      );
      return { bookingId: booking.bookingId, bdaEmail, verdict: 'present', healthy: true, raceCorrected: true };
    }
  }

  const healthy = await computeVerdictHealth({ startMs, nowMs, bdaEmail, googleChecked }, d);

  if (verdict === 'absent') {
    const who = profile?.displayName || row?.bdaName || bdaEmail;
    let doubleBooked = '';
    try {
      doubleBooked = doubleBookedLine(await (d.findOverlapping || findOverlappingMeetings)(booking, bdaEmail, { nowMs }), formatIstTime);
    } catch (err) {
      console.warn(`[AttendanceVerdict] double-booking check failed for ${booking.bookingId}: ${err?.message}`);
    }
    const delivered = await safePost(
      d.poster,
      absentAlertMessage({
        who,
        bdaEmail,
        clientName: booking.clientName,
        startMs,
        roster: (row?.participantsAtJoin || []).map((p) => p.displayName).filter(Boolean).join(', '),
        doubleBooked,
        leftEarly: judged.reason === 'left_early' ? judged.stay : null,
      }),
      'absent'
    );
    // Delivered: clear the flag. Not delivered (Discord down): leave it set so the next pass retries the alert.
    if (delivered) await BdaAttendanceModel.updateOne({ bookingId: booking.bookingId, bdaEmail }, { $set: { verdictAlertPending: false } });
  }

  emitAttendanceEvent(EVENTS.VERDICT, {
    bookingId: booking.bookingId,
    bdaEmail,
    verdict,
    verdictAt: now,
    scheduledStart: new Date(startMs),
    signals: (row?.signals || []).map((s) => ({ kind: s.kind, eventAt: s.eventAt, receivedAt: s.receivedAt })),
    healthy,
  });
  return { bookingId: booking.bookingId, bdaEmail, verdict, healthy };
}

// ---------------------------------------------------------------------------
// Integrity: a button with no join behind it
// ---------------------------------------------------------------------------

/** True when something other than a button saw the BDA in the call. */
function hasJoinEvidence(row) {
  if ((row.signals || []).some((s) => s.kind === 'extension_join' || s.kind === 'google_meet')) return true;
  if (row.firstJoinedAt && (row.source === 'auto' || (row.source === 'meet_api' && row.matchedBy === 'stable_id'))) return true;
  return false;
}

/**
 * A present verdict that rests on a button, with no Google stable-ID join and no extension join three hours after
 * the meeting started, goes on the admin review list (plan 2.2). It is never fined automatically (decision D10).
 */
export async function runIntegrityCheck(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);
  const query = {
    verdict: 'present',
    verdictSignal: { $in: BUTTON_KINDS },
    integrityFlag: null,
    'integrityResolved.at': null,
    meetingScheduledStart: { $lte: new Date(nowMs - INTEGRITY_AFTER_MS), $gte: new Date(nowMs - INTEGRITY_LOOKBACK_MS) },
  };
  // Tests narrow to their own bookings; attendance rows carry the same bookingId.
  if (d.bookingFilter?.bookingId) query.bookingId = d.bookingFilter.bookingId;
  const rows = await BdaAttendanceModel.find(query).lean();

  const flagged = [];
  for (const row of rows) {
    if (hasJoinEvidence(row)) continue;
    const res = await BdaAttendanceModel.updateOne({ _id: row._id, integrityFlag: null }, { $set: { integrityFlag: 'marked_never_joined' } });
    if ((res.modifiedCount ?? 0) === 0) continue;
    flagged.push({ bookingId: row.bookingId, bdaEmail: row.bdaEmail });
    emitAttendanceEvent(EVENTS.INTEGRITY_FLAGGED, {
      bookingId: row.bookingId,
      bdaEmail: row.bdaEmail,
      flaggedAt: new Date(nowMs),
      signal: row.verdictSignal,
    });
  }
  return { flagged };
}

// ---------------------------------------------------------------------------
// Heartbeat alert
// ---------------------------------------------------------------------------

/** 9 to 11 minutes before a countable meeting, warn once when the assigned BDA's extension has gone quiet. */
/**
 * 25 to 35 minutes before a slot where a tracked BDA has two (or more) countable meetings at the same time, warn the
 * admin channel once so someone can reassign one. Otherwise the second meeting is a certain absent and a fine.
 */
export async function runDoubleBookingAlert(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);
  const bookings = await CampaignBookingModel.find(
    withFilter(
      { scheduledEventStartTime: { $gte: new Date(nowMs + 25 * 60 * 1000), $lte: new Date(nowMs + 35 * 60 * 1000) }, $or: ASSIGNED_ANYONE },
      d
    )
  )
    .select(BOOKING_FIELDS)
    .lean();

  const posted = [];
  for (const booking of bookings) {
    const bdaEmail = getAssignedBdaEmail(booking);
    const profile = bdaEmail ? await d.registry.getBdaProfile(bdaEmail) : null;
    if (!bdaEmail || !countableReason(booking, profile, nowMs).countable) continue;
    const clashes = await (d.findOverlapping || findOverlappingMeetings)(booking, bdaEmail, { nowMs });
    if (clashes.length === 0) continue;

    // One warning per set of clashing meetings, whichever of them this loop reaches first.
    const ids = [booking.bookingId, ...clashes.map((c) => c.bookingId)].sort();
    try {
      await BdaAttendanceWarnDedupeModel.create({ bookingId: `double_booked:${ids.join('+')}`, bdaEmail, sentAt: new Date(nowMs) });
    } catch (err) {
      if (err?.code === 11000) continue;
      throw err;
    }
    const who = profile?.discordUserId ? `<@${profile.discordUserId}>` : `**${profile?.displayName || bdaEmail}**`;
    const list = [{ clientName: booking.clientName, startMs: toMs(booking.scheduledEventStartTime) }, ...clashes]
      .sort((a, b) => a.startMs - b.startMs)
      .map((m) => `- ${formatIstTime(m.startMs)} ${m.clientName || 'client'}`)
      .join('\n');
    await safePost(
      d.adminPoster,
      `⚠️ **Double-booked:** ${who} has overlapping meetings:\n${list}\nReassign one in the CRM before the mark window opens (5 min before the start), or the other will be marked absent.`,
      'double-booked'
    );
    posted.push(ids);
  }
  return { posted };
}

export async function runHeartbeatAlert(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);
  const bookings = await CampaignBookingModel.find(
    withFilter(
      {
        scheduledEventStartTime: {
          $gte: new Date(nowMs + HEARTBEAT_ALERT_MIN_MS),
          $lte: new Date(nowMs + HEARTBEAT_ALERT_MAX_MS),
        },
        $or: ASSIGNED_ANYONE,
      },
      d
    )
  )
    .select(BOOKING_FIELDS)
    .lean();

  const warned = [];
  for (const booking of bookings) {
    const bdaEmail = getAssignedBdaEmail(booking);
    const profile = bdaEmail ? await d.registry.getBdaProfile(bdaEmail) : null;
    if (!bdaEmail || !countableReason(booking, profile, nowMs).countable) continue;

    const beat = await d.getHeartbeat(bdaEmail);
    if (beat?.lastHeartbeatAt && nowMs - toMs(beat.lastHeartbeatAt) <= HEARTBEAT_STALE_MS) continue;

    // Claim the warning on the attendance row (creating a placeholder if needed). Only the claimer posts.
    try {
      const res = await BdaAttendanceModel.updateOne(
        { bookingId: booking.bookingId, bdaEmail, heartbeatWarnedAt: null },
        {
          $set: { heartbeatWarnedAt: new Date(nowMs) },
          $setOnInsert: {
            attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            bdaName: profile?.displayName || bdaEmail.split('@')[0],
            status: 'unmarked',
            source: 'scheduler',
            markedAt: new Date(nowMs),
            meetingScheduledStart: booking.scheduledEventStartTime,
            meetingScheduledEnd: booking.scheduledEventEndTime || null,
          },
        },
        { upsert: true }
      );
      if ((res.modifiedCount ?? 0) === 0 && (res.upsertedCount ?? 0) === 0) continue;
    } catch (err) {
      if (err?.code === 11000) continue; // already warned
      throw err;
    }

    const mention = profile?.discordUserId ? `<@${profile.discordUserId}>` : `**${profile?.displayName || bdaEmail}**`;
    await safePost(
      d.attendancePoster,
      `${mention} your attendance extension is offline. Open Chrome with your work profile before your ${formatIstTime(booking.scheduledEventStartTime)} meeting.`,
      'heartbeat'
    );
    warned.push({ bookingId: booking.bookingId, bdaEmail });
  }
  return { warned };
}

// ---------------------------------------------------------------------------
// Needs reassignment (leave days), daily at 18:00 IST
// ---------------------------------------------------------------------------

/** Meetings starting on `istDay` ('YYYY-MM-DD') whose assigned BDA has that day in leaveDays. */
export async function findMeetingsOnLeave({ fromMs, untilMs, deps }) {
  const d = buildDeps(deps);
  const bookings = await CampaignBookingModel.find(
    withFilter({ scheduledEventStartTime: { $gte: new Date(fromMs), $lt: new Date(untilMs) }, $or: ASSIGNED_ANYONE }, d)
  )
    .select(BOOKING_FIELDS)
    .sort({ scheduledEventStartTime: 1 })
    .limit(500)
    .lean();

  const out = [];
  for (const booking of bookings) {
    const bdaEmail = getAssignedBdaEmail(booking);
    const profile = bdaEmail ? await d.registry.getBdaProfile(bdaEmail) : null;
    if (!profile || profile.active === false || profile.tracked !== true) continue;
    const startMs = toMs(booking.scheduledEventStartTime);
    if (!isLeaveDayFor(profile, startMs)) continue;
    if (['canceled', 'rescheduled', 'not-scheduled'].includes(booking.bookingStatus)) continue;
    out.push({ booking, bdaEmail, profile });
  }
  return out;
}

/** Post tomorrow's leave-day meetings to the admin channel. Each meeting is announced once, even across restarts. */
export async function runNeedsReassignmentPost(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const tomorrow = DateTime.fromMillis(toMs(now), { zone: 'Asia/Kolkata' }).plus({ days: 1 }).startOf('day');
  const items = await findMeetingsOnLeave({
    fromMs: tomorrow.toMillis(),
    untilMs: tomorrow.plus({ days: 1 }).toMillis(),
    deps,
  });

  const fresh = [];
  for (const item of items) {
    try {
      await BdaAttendanceWarnDedupeModel.create({
        bookingId: `needs_reassignment:${item.booking.bookingId}`,
        bdaEmail: item.bdaEmail,
        sentAt: new Date(toMs(now)),
      });
      fresh.push(item);
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  if (fresh.length > 0) {
    const lines = fresh.map(
      (i) => `- ${formatIstTime(i.booking.scheduledEventStartTime)} ${i.booking.clientName || 'client'}: ${i.profile.displayName || i.bdaEmail} is on leave`
    );
    await safePost(
      d.adminPoster,
      `📋 **Needs a new BDA tomorrow (${tomorrow.toFormat('dd LLL')}):**\n${lines.join('\n')}\nReassign each one in the CRM before the mark window opens.`,
      'needs-reassignment'
    );
  }
  return { posted: fresh.map((i) => ({ bookingId: i.booking.bookingId, bdaEmail: i.bdaEmail })) };
}

// ---------------------------------------------------------------------------
// Sync health alerts
// ---------------------------------------------------------------------------

const alertState = new Map(); // source -> last alert ms; cleared when the source is healthy again

export function resetSyncAlertState() {
  alertState.clear();
}

function inWorkingHours(nowMs) {
  const hour = DateTime.fromMillis(nowMs, { zone: 'Asia/Kolkata' }).hour;
  return hour >= WORKING_HOURS_IST.from && hour < WORKING_HOURS_IST.to;
}

/** Tell the admins when Google or Zoom stopped syncing during working hours (limits from plan 2.7). */
export async function runSyncHealthAlert(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);
  const rows = await d.health.getAllSyncHealth();
  const alerts = [];
  for (const source of ['google_meet', 'zoom_phone']) {
    const row = rows.find((r) => r.source === source);
    const lastOk = row?.lastOkAt ? toMs(row.lastOkAt) : null;
    const age = lastOk == null ? Infinity : nowMs - lastOk;
    const stale = age > SYNC_LIMITS_MS[source];
    if (!stale) {
      alertState.delete(source);
      continue;
    }
    if (!inWorkingHours(nowMs)) continue;
    const last = alertState.get(source);
    if (last != null && nowMs - last < SYNC_REALERT_MS) continue;
    alertState.set(source, nowMs);

    const label = source === 'google_meet' ? 'Google Meet' : 'Zoom Phone';
    const since = lastOk == null ? 'It has never synced.' : `Last good sync was ${Math.round(age / 60000)} min ago.`;
    const why = row?.lastError ? ` Last error: ${row.lastError}` : '';
    await safePost(
      d.adminPoster,
      `⚠️ **${label} sync is stale.** ${since}${why}${finesAreLive() ? ' Fines that depend on it will go to review until it recovers.' : ''}`,
      'sync-health'
    );
    alerts.push(source);
  }
  return { alerts };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

let timer = null;
let housekeepingTimer = null;
let ticking = false;
let housekeeping = false;
let lastHeartbeatRun = 0;
let lastSlowRun = 0;
let lastReassignDay = null;

/**
 * The time-critical half: judge meetings whose window just closed and post the absent alert. It runs on its own
 * timer and lock (see startAttendanceVerdictJob) so the slower steps below can never hold it up.
 * The verdict pass is the health signal for 'verdict_job': it counts as run even with nothing to judge.
 */
export async function runVerdictTick(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  try {
    await runVerdictPass(now, d);
    await d.health.recordSyncOk('verdict_job');
  } catch (err) {
    console.error('[AttendanceVerdict] verdict pass failed:', err?.message || err);
    await d.health.recordSyncError('verdict_job', err);
  }
}

/** Everything that is not a verdict: heartbeat and double-booking alerts, integrity, sync health, reassignment. */
export async function runHousekeepingTick(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[AttendanceVerdict] ${name} failed:`, err?.message || err);
      return null;
    }
  };

  if (nowMs - lastHeartbeatRun >= HEARTBEAT_ALERT_EVERY_MS) {
    lastHeartbeatRun = nowMs;
    await step('heartbeat alert', () => runHeartbeatAlert(now, d));
    await step('double-booking alert', () => runDoubleBookingAlert(now, d));
  }
  if (nowMs - lastSlowRun >= SLOW_STEPS_EVERY_MS) {
    lastSlowRun = nowMs;
    await step('integrity check', () => runIntegrityCheck(now, d));
    await step('sync health alert', () => runSyncHealthAlert(now, d));
  }
  const ist = DateTime.fromMillis(nowMs, { zone: 'Asia/Kolkata' });
  if (ist.hour >= REASSIGN_POST_HOUR_IST && lastReassignDay !== ist.toISODate()) {
    lastReassignDay = ist.toISODate();
    await step('needs-reassignment post', () => runNeedsReassignmentPost(now, d));
  }
}

/** Both halves in order. Exported so a test can drive the whole cadence with a fake clock. */
export async function runAttendanceTick(now = new Date(), deps = {}) {
  await runVerdictTick(now, deps);
  await runHousekeepingTick(now, deps);
}

export function startAttendanceVerdictJob() {
  if (timer) {
    console.warn('[AttendanceVerdict] already running');
    return;
  }
  console.log(`[AttendanceVerdict] starting (verdicts every ${VERDICT_EVERY_MS / 1000}s)`);
  // The job only judges BDAs who are in the registry with tracked: true. An empty registry means NO absent alert
  // will ever fire, which looks exactly like "alerts stopped working", so say it loudly at startup and tell the
  // admin channel once. Fix: POST /api/crm/admin/attendance/setup/seed-profiles (see GET .../setup/status).
  getTrackedBdas()
    .then((tracked) => {
      if (tracked.length > 0) {
        console.log(`[AttendanceVerdict] judging ${tracked.length} tracked BDA(s)`);
        return null;
      }
      console.warn('[AttendanceVerdict] NO tracked BDAs in the registry: no verdicts or absent alerts until it is seeded');
      return postAdminChannel(
        '⚠️ **Attendance alerts are OFF**: the BDA registry has no tracked BDAs, so nobody is judged and no absent alert will fire. ' +
          'Call `POST /api/crm/admin/attendance/setup/run` (dry run first, then with apply), or set `tracked` on the BDA registry page.'
      );
    })
    .catch((err) => console.warn('[AttendanceVerdict] could not read the registry at startup:', err?.message || err));
  // Two loops, two locks. Before, the heartbeat/integrity/sync-health steps ran inside the same tick as the
  // verdict pass, so any slow step (Discord retries, Google, DB) made every verdict wait behind it.
  const verdictTick = async () => {
    if (ticking) return; // a slow Google check must not stack passes
    ticking = true;
    try {
      await runVerdictTick(new Date());
    } catch (err) {
      console.error('[AttendanceVerdict] verdict tick failed:', err?.message || err);
    } finally {
      ticking = false;
    }
  };
  const housekeepingTick = async () => {
    if (housekeeping) return;
    housekeeping = true;
    try {
      await runHousekeepingTick(new Date());
    } catch (err) {
      console.error('[AttendanceVerdict] housekeeping tick failed:', err?.message || err);
    } finally {
      housekeeping = false;
    }
  };
  verdictTick();
  housekeepingTick();
  timer = setInterval(verdictTick, VERDICT_EVERY_MS);
  housekeepingTimer = setInterval(housekeepingTick, HOUSEKEEPING_EVERY_MS);
}

export function stopAttendanceVerdictJob() {
  if (housekeepingTimer) {
    clearInterval(housekeepingTimer);
    housekeepingTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[AttendanceVerdict] stopped');
  }
}

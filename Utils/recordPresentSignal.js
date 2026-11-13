import { finesAreLive } from './deductionPolicy.js';
import { DateTime } from 'luxon';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { EVENTS, emitAttendanceEvent } from './attendanceEvents.js';
import { postAbsentChannel } from './attendanceDiscord.js';
import { getAssignedBdaEmail } from './BdaAssignment.js';
import { getBdaProfile } from './BdaRegistry.js';
import { presenceVerdict } from './AttendanceStay.js';

// The one place a "present" signal is stored (plan 2.2 and 5.3). The two Mark Present buttons, the extension's
// join detection and the Google Meet sync all come through here, so every rule lives once. It returns a plain
// result object, never an Express response, so HTTP handlers and schedulers share it.

export const SIGNAL_KINDS = Object.freeze(['button_meet', 'button_crm', 'extension_join', 'google_meet']);
const BUTTON_KINDS = new Set(['button_meet', 'button_crm']);

/** The mark window is [start - 5 min, start + 60 s] on the server clock. */
export const WINDOW_OPENS_BEFORE_MS = 5 * 60 * 1000;
export const WINDOW_CLOSES_AFTER_MS = 60 * 1000;
/** After the window closes the verdict waits this long for Google's records to land. */
export const VERDICT_SETTLE_MS = 30 * 1000;

const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const toMs = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

export const isButtonKind = (kind) => BUTTON_KINDS.has(kind);

export function formatIstTime(date) {
  return DateTime.fromMillis(toMs(date), { zone: 'Asia/Kolkata' }).toFormat('h:mm a');
}

/** Window edges for a booking start (ms). */
export function windowFor(startMs) {
  return { opensAtMs: startMs - WINDOW_OPENS_BEFORE_MS, closesAtMs: startMs + WINDOW_CLOSES_AFTER_MS };
}

/** extension_join times come from the BDA's machine; anything older than this before receipt is clamped. */
export const MAX_JOIN_BACKDATE_MS = 2 * 60 * 1000;

/**
 * Was the BDA still in the call when the window opened? Used for join evidence that STARTED before the window
 * (joined at -25 min). Google's sessions are exact when we have them; otherwise the attendance row's last segment:
 * an open segment (joinedAt set, leftAt null) that started in time, or a closed one that ended after the window
 * opened. Joined at -25 and left at -20 never counts; joined at -8 and stayed always does.
 */
function stillInCallAtWindow(row, kind, opensAtMs, closesAtMs) {
  if (!row) return false;
  const sessions = Array.isArray(row.sessions) ? row.sessions.filter((x) => x?.startTime) : [];
  if (kind === 'google_meet' && sessions.length) {
    return sessions.some((x) => toMs(x.startTime) <= closesAtMs && (!x.endTime || toMs(x.endTime) >= opensAtMs));
  }
  if (row.joinedAt && !row.leftAt) return toMs(row.joinedAt) <= closesAtMs;
  if (row.leftAt) return toMs(row.leftAt) >= opensAtMs;
  return false;
}

/**
 * One signal counts toward the verdict when its event time is at or before the window closes AND, for join
 * evidence that started before the window opened, the BDA was still in the call at the window (plan 2.2).
 * Buttons are only ever accepted inside the window, so their time alone decides.
 */
export function signalCounts(signal, startMs, row = null) {
  const t = signal?.eventAt ? toMs(signal.eventAt) : NaN;
  const { opensAtMs, closesAtMs } = windowFor(startMs);
  if (!Number.isFinite(t) || t > closesAtMs) return false;
  if (isButtonKind(signal.kind) || t >= opensAtMs) return true;
  return stillInCallAtWindow(row, signal.kind, opensAtMs, closesAtMs);
}

/** Signals that count toward the verdict (see signalCounts), earliest first. Pass the row for join evidence. */
export function countedSignals(signals, startMs, row = null) {
  return (Array.isArray(signals) ? signals : [])
    .filter((s) => signalCounts(s, startMs, row))
    .sort((a, b) => toMs(a.eventAt) - toMs(b.eventAt));
}

const fail = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra });

/**
 * Store one present signal on the reporting BDA's own attendance row.
 *
 * input: { bookingId, bdaEmail, kind, eventAt?, receivedAt?, bdaName?, matchedBy? }
 * deps (all optional, for tests): { postCorrection(message), now() }
 *
 * Button kinds: the server receive time is the event time (client clocks are never trusted), and the BDA must be
 * the assigned, tracked BDA and inside the window. extension_join and google_meet: no assignment or window error;
 * a late event time is stored (it is attendance data) but does not count toward the window.
 *
 * Success: { ok: true, marked, counted, duplicate, markedPresentAt, correction, attendanceId }
 * Failure: { ok: false, status, code, message, windowOpensAt?, windowClosesAt? }
 */
export async function recordPresentSignal(input, deps = {}) {
  const kind = input?.kind;
  const bookingId = input?.bookingId ? String(input.bookingId) : '';
  const bdaEmail = normEmail(input?.bdaEmail);
  if (!SIGNAL_KINDS.includes(kind)) return fail(400, 'invalid_kind', `Unknown signal kind: ${kind}`);
  if (!bookingId) return fail(404, 'booking_not_found', 'Booking not found');
  if (!bdaEmail) return fail(400, 'invalid_bda', 'bdaEmail is required');

  const nowDate = deps.now ? new Date(deps.now()) : new Date();
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : nowDate;

  const booking = await CampaignBookingModel.findOne({ bookingId })
    .select('bookingId clientName bookingStatus scheduledEventStartTime scheduledEventEndTime googleMeetUrl calendlyHost claimedBy attendanceAssignee')
    .lean();
  if (!booking) return fail(404, 'booking_not_found', 'Booking not found');

  const startMs = booking.scheduledEventStartTime ? toMs(booking.scheduledEventStartTime) : NaN;
  if (!Number.isFinite(startMs)) return fail(422, 'no_start_time', 'This booking has no scheduled start time');
  const { opensAtMs, closesAtMs } = windowFor(startMs);

  const isButton = isButtonKind(kind);
  // Button clicks are timed by the server, whatever the client says. Join evidence carries its own event time.
  let eventAt = isButton ? receivedAt : input.eventAt ? new Date(input.eventAt) : receivedAt;
  if (!Number.isFinite(eventAt.getTime())) eventAt = receivedAt;
  // Join evidence can be earlier than now, never later. A client that sends a future time would otherwise look "in
  // time" for a window that has not happened yet (a few seconds of clock skew are tolerated).
  if (eventAt.getTime() > receivedAt.getTime() + 5000) eventAt = receivedAt;
  // ...and the extension's time cannot reach far into the past either. A report-join posted at +10 min with
  // joinedAt = start - 1 min would otherwise flip an absent and void the fine. Real joins arrive within seconds
  // (3 s dwell); a join delayed longer (offline, queued) still lands as attendance data, and Google's stable-ID
  // record is what corrects a verdict that late.
  if (kind === 'extension_join' && eventAt.getTime() < receivedAt.getTime() - MAX_JOIN_BACKDATE_MS) {
    eventAt = new Date(receivedAt.getTime() - MAX_JOIN_BACKDATE_MS);
  }

  const existing = await BdaAttendanceModel.findOne({ bookingId, bdaEmail }).lean();
  const profile = await getBdaProfile(bdaEmail);

  if (isButton) {
    if (getAssignedBdaEmail(booking) !== bdaEmail) {
      return fail(403, 'not_assigned', 'This meeting is assigned to another BDA');
    }
    if (!profile || profile.active === false || profile.tracked !== true) {
      return fail(403, 'not_tracked', 'Attendance is not tracked for this account');
    }
    const prior = (existing?.signals || []).find((s) => s.kind === kind);
    if (prior) {
      // A repeat click, or a request the extension retried from its queue. Same answer as the first time.
      return {
        ok: true,
        marked: true,
        counted: true,
        duplicate: true,
        markedPresentAt: existing.markedPresentAt || prior.eventAt,
        correction: null,
        attendanceId: existing.attendanceId,
      };
    }
    const windowInfo = { windowOpensAt: new Date(opensAtMs).toISOString(), windowClosesAt: new Date(closesAtMs).toISOString() };
    if (receivedAt.getTime() < opensAtMs) {
      return fail(409, 'window_not_open', 'The mark window opens 5 minutes before the meeting', windowInfo);
    }
    if (receivedAt.getTime() > closesAtMs) {
      return fail(409, 'window_closed', 'The mark window closed 1 minute after the meeting started', windowInfo);
    }
  } else if (kind === 'google_meet') {
    // Only a stable-ID match (Directory email or Google user ID) may decide a verdict. A name match is display only.
    const stable = (input.matchedBy ?? existing?.matchedBy) === 'stable_id';
    if (!stable) return { ok: true, marked: false, counted: false, duplicate: false, ignored: 'not_stable_id', markedPresentAt: existing?.markedPresentAt ?? null, correction: null };
    if ((existing?.signals || []).some((s) => s.kind === kind)) return duplicateJoin(existing, kind, booking, profile, startMs, deps, nowDate);
  } else if ((existing?.signals || []).some((s) => s.kind === kind)) {
    // extension_join repeats on every rejoin; the first one is the evidence. It can still be what corrects an absent
    // verdict that was written in the moment between this signal's first push and the verdict job's write.
    return duplicateJoin(existing, kind, booking, profile, startMs, deps, nowDate);
  }

  // Make sure the BDA's own row exists. Another request may create it first; that duplicate-key error is fine.
  if (!existing) {
    try {
      await BdaAttendanceModel.updateOne(
        { bookingId, bdaEmail },
        {
          $setOnInsert: {
            attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            bdaName: input.bdaName || profile?.displayName || bdaEmail.split('@')[0],
            status: isButton ? 'manual' : 'present',
            source: isButton ? 'manual' : kind === 'google_meet' ? 'meet_api' : 'auto',
            markedAt: receivedAt,
            meetingScheduledStart: booking.scheduledEventStartTime,
            meetingScheduledEnd: booking.scheduledEventEndTime || null,
            meetLink: booking.googleMeetUrl || null,
          },
        },
        { upsert: true }
      );
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }

  // Push the signal once per kind. A concurrent identical request matches nothing here and falls through.
  const signal = { kind, eventAt, receivedAt };
  const pushed = await BdaAttendanceModel.findOneAndUpdate(
    { bookingId, bdaEmail, 'signals.kind': { $ne: kind } },
    { $push: { signals: signal } },
    { new: true }
  ).lean();
  let row = pushed || (await BdaAttendanceModel.findOne({ bookingId, bdaEmail }).lean());
  if (!row) return fail(500, 'row_missing', 'Attendance row could not be created');
  const duplicate = !pushed;

  const counted = signalCounts(signal, startMs, row);

  // A button click on an unmarked placeholder row turns it into a real mark. Legacy readers key on status.
  if (isButton && row.status === 'unmarked') {
    await BdaAttendanceModel.updateOne({ _id: row._id, status: 'unmarked' }, { $set: { status: 'manual', source: 'manual', markedAt: receivedAt } });
  }

  // markedPresentAt is the earliest signal time that counted toward the window. A conditional write keeps it
  // correct when two signals race.
  const firstCounted = countedSignals([...(row.signals || [])], startMs, row)[0];
  if (firstCounted) {
    await BdaAttendanceModel.updateOne(
      { _id: row._id, $or: [{ markedPresentAt: null }, { markedPresentAt: { $gt: firstCounted.eventAt } }] },
      { $set: { markedPresentAt: firstCounted.eventAt } }
    );
  }

  // Late evidence: an absent verdict flips to present when proof of an in-window join arrives afterwards, and the
  // record does not show the BDA leaving before the minimum stay (a late Google record of a 40-second visit must not
  // turn a left_early absent back into present).
  let correction = null;
  if (counted && !isButton && row.verdict === 'absent' && presenceVerdict(row, startMs, nowDate.getTime()).present) {
    correction = await applyLateCorrection({ row, booking, profile, kind, startMs, deps, now: nowDate });
  }

  const fresh = await BdaAttendanceModel.findById(row._id).select('markedPresentAt attendanceId').lean();
  return {
    ok: true,
    marked: true,
    counted,
    duplicate,
    markedPresentAt: fresh?.markedPresentAt ?? null,
    correction,
    attendanceId: fresh?.attendanceId ?? row.attendanceId,
  };
}

/** A repeated join kind. Same answer as the first time, plus the late correction if a stale absent is in the way. */
async function duplicateJoin(existing, kind, booking, profile, startMs, deps, now) {
  const stored = existing.signals.find((s) => s.kind === kind);
  const counted = signalCounts(stored, startMs, existing);
  let correction = null;
  if (counted && existing.verdict === 'absent' && presenceVerdict(existing, startMs, toMs(now)).present) {
    correction = await applyLateCorrection({ row: existing, booking, profile, kind, startMs, deps, now });
  }
  return { ok: true, marked: true, counted, duplicate: true, markedPresentAt: existing.markedPresentAt ?? null, correction, attendanceId: existing.attendanceId };
}

/**
 * absent -> present, once. The conditional filter means two racing signals produce one correction, one event and
 * one Discord post. A present verdict is never touched by this module.
 */
async function applyLateCorrection({ row, booking, profile, kind, startMs, deps, now }) {
  const flipped = await BdaAttendanceModel.findOneAndUpdate(
    { _id: row._id, verdict: 'absent' },
    { $set: { verdict: 'present', verdictSignal: kind, verdictReason: 'present', verdictCorrectedAt: now } },
    { new: true }
  ).lean();
  if (!flipped) return null;

  emitAttendanceEvent(EVENTS.VERDICT_CORRECTED, {
    bookingId: row.bookingId,
    bdaEmail: row.bdaEmail,
    correctedAt: now,
    signal: kind,
  });

  const who = profile?.displayName || row.bdaName || row.bdaEmail;
  const message =
    `✅ **Correction:** ${who} was in the call for ${booking.clientName || 'the client'} on time after all. ` +
    `The ${kind.replace('_', ' ')} record reached us late, so the absent verdict for the ${formatIstTime(startMs)} meeting is reversed${finesAreLive() ? ' and any fine is voided' : ''}.`;
  const poster = deps.postCorrection || postAbsentChannel;
  try {
    await poster(message);
  } catch (err) {
    console.error('[recordPresentSignal] correction post failed:', err?.message || err);
  }
  return { signal: kind };
}

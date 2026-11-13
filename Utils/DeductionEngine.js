import { refreshDeductionSettings, startDeductionSettingsRefresher } from './DeductionSettings.js';
import { findOverlappingMeetings } from './DoubleBooking.js';
import { bookingPhoneKey } from './CallLinking.js';
import { presenceVerdict, stayAfterStart, leftTooEarly, formatStay, MIN_STAY_MS } from './AttendanceStay.js';
import { DateTime } from 'luxon';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { BdaDeductionDigestModel } from '../Schema_Models/BdaDeductionDigest.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaHeartbeatLogModel } from '../Schema_Models/BdaHeartbeatLog.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { attendanceEvents, EVENTS } from './attendanceEvents.js';
import { countableReason, getAssignedBdaEmail, isAfterGoLive, statusAtStart } from './BdaAssignment.js';
import { isLeaveDayFor, workDayOf, workMonthOf } from './WorkDay.js';
import { evaluateWarningLetters } from './WarningLetters.js';
import { getBdaProfile, getTrackedBdas } from './BdaRegistry.js';
import { getCallSummaries } from './BookingCallSummary.js';
import { SYNC_LIMITS_MS, syncOkBetween, wasSourceHealthy } from './SyncHealth.js';
import {
  DEDUCTION_POLICY,
  IST_ZONE,
  baseAmountFor,
  buildTotals,
  getDeductionsMode,
  getEvaluatorIntervalMs,
  getLiveFrom,
  getStatusDeadlineMs,
  missedMeetingAmount,
} from './deductionPolicy.js';

export { buildTotals }; // lives in deductionPolicy.js so light importers (payroll) skip this module's imports

// The deduction engine (plan 8.2). Three evaluators create ledger rows, repriceMonth owns the tier maths, and
// the admin actions (waive, activate, convert) live here too so routes stay thin.
//
// Everything that touches the outside world is injectable through the options object every function takes
// (see makeContext), so tests never need a registry, a Zoom sync or Discord. Judging functions (judge*) and
// planTiers are pure.

const MIN = 60 * 1000;
const WINDOW_CLOSE_MS = 60 * 1000; // the mark window closes at start + 60 s (plan 2.2)
const VERDICT_JOB_WINDOW_MS = 5 * MIN; // plan 2.7: the verdict job must have run between start + 60 s and start + 5 min
const BATCH = 200;
const ACTIVE_LIKE = ['shadow', 'needs_review', 'active'];

const norm = (e) => String(e ?? '').trim().toLowerCase();
const toMs = (d) => {
  if (d == null) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};
const newDeductionId = () => `ded_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
const fmtTimeIst = (ms) => `${DateTime.fromMillis(ms, { zone: IST_ZONE }).setLocale('en-US').toFormat('h:mm a')} IST`;
const istDay = (ms) => DateTime.fromMillis(ms, { zone: IST_ZONE }).toFormat('yyyy-LL-dd');

const BOOKING_FIELDS = [
  'bookingId', 'clientName', 'clientPhone', 'normalizedClientPhone', 'bookingStatus', 'statusHistory',
  'statusChangedAt', 'scheduledEventStartTime', 'attendanceAssignee', 'calendlyHost', 'claimedBy', 'googleMeetCode',
].join(' ');

// ---------------------------------------------------------------------------------------------------------
// Context: policy, clock and every outside dependency, with test overrides
// ---------------------------------------------------------------------------------------------------------

let warnedNoDeductionsWebhook = false;
let warnedLiveWithoutDate = false;

/** Default poster: `channel` is 'deductions' (BDA-facing, mentions) or 'admin'. Never throws. */
async function defaultPost({ channel, content }) {
  try {
    if (channel === 'admin') {
      const { postAdminChannel } = await import('./attendanceDiscord.js');
      return { ok: await postAdminChannel(content) };
    }
    const url = (process.env.DISCORD_BDA_DEDUCTIONS_WEBHOOK_URL || '').trim();
    if (!url) {
      if (!warnedNoDeductionsWebhook) {
        warnedNoDeductionsWebhook = true;
        console.warn('[DeductionEngine] DISCORD_BDA_DEDUCTIONS_WEBHOOK_URL not configured, BDA posts are skipped');
      }
      return { ok: false, error: 'no_url' };
    }
    const { DiscordConnect } = await import('./DiscordConnect.js');
    const res = await DiscordConnect(url, content, false);
    return { ok: Boolean(res?.ok) };
  } catch (err) {
    console.error('[DeductionEngine] discord post failed:', err?.message || err);
    return { ok: false, error: err?.message };
  }
}

/**
 * Build the dependency bag. Pass any of these as options to override: now (Date|ms), mode, liveFrom (Date|null),
 * statusDeadlineMs, getProfile, listTracked, getCallSummaries, sourceHealthy, syncRanBetween, post,
 * loadBookings, loadAttendance.
 */
export function makeContext(opts = {}) {
  const nowMs = opts.now == null ? Date.now() : toMs(opts.now);
  return {
    nowMs,
    mode: opts.mode ?? getDeductionsMode(),
    liveFrom: opts.liveFrom !== undefined ? opts.liveFrom : getLiveFrom(),
    statusDeadlineMs: opts.statusDeadlineMs ?? getStatusDeadlineMs(),
    getProfile: opts.getProfile ?? getBdaProfile,
    listTracked: opts.listTracked ?? getTrackedBdas,
    getCallSummaries: opts.getCallSummaries ?? getCallSummaries,
    sourceHealthy: opts.sourceHealthy ?? wasSourceHealthy,
    syncRanBetween: opts.syncRanBetween ?? syncOkBetween,
    post: opts.post ?? defaultPost,
    loadBookings:
      opts.loadBookings ??
      (async (ids) =>
        ids.length ? CampaignBookingModel.find({ bookingId: { $in: ids } }).select(BOOKING_FIELDS).lean() : []),
    loadAttendance:
      opts.loadAttendance ??
      (async (bookingId, bdaEmail) =>
        // sessions / joinedAt / leftAt / cumulativeDurationMs: the minimum-stay check (AttendanceStay.js) reads them.
        BdaAttendanceModel.findOne({ bookingId, bdaEmail }).select('verdict verdictAt verdictCorrectedAt verdictReason signals sessions firstJoinedAt joinedAt leftAt cumulativeDurationMs participantsAtJoin').lean()),
    // Did the BDA's own extension report them in THIS meeting's call around the start? Returns { firstAt, lastAt } or null.
    loadInCall:
      opts.loadInCall ??
      (async (bdaEmail, meetCode, startMs) => {
        if (!meetCode) return null;
        const rows = await BdaHeartbeatLogModel.find({
          bdaEmail,
          at: { $gte: new Date(startMs - 5 * 60_000), $lte: new Date(startMs + 35 * 60_000) },
          meetTabs: { $elemMatch: { code: meetCode, inCall: true } },
        })
          .select('at')
          .sort({ at: 1 })
          .lean();
        return rows.length ? { firstAt: rows[0].at, lastAt: rows[rows.length - 1].at } : null;
      }),
    // Attendance rows of OTHER BDAs for the same meeting, to see whether a colleague covered it.
    loadCover:
      opts.loadCover ??
      (async (bookingId, bdaEmail) =>
        BdaAttendanceModel.find({ bookingId, bdaEmail: { $ne: bdaEmail } })
          .select('bdaEmail bdaName status verdict signals sessions firstJoinedAt joinedAt leftAt markedPresentAt durationMs cumulativeDurationMs joinDevice')
          .lean()),
    _profiles: new Map(),
  };
}

const profileOf = async (ctx, email) => {
  if (!ctx.getProfile) return null;
  if (!ctx._profiles.has(email)) ctx._profiles.set(email, await ctx.getProfile(email));
  return ctx._profiles.get(email);
};

/**
 * Can this mode write rows at all? off never; shadow and live only once a go-live date exists. Shadow used to run
 * without one, which back-filled 60 days on its first tick: hundreds of rows and one admin post each.
 */
export function canWrite(ctx) {
  if (ctx.mode !== 'shadow' && ctx.mode !== 'live') return false;
  if (ctx.liveFrom) return true;
  if (!warnedLiveWithoutDate) {
    warnedLiveWithoutDate = true;
    console.warn(`[DeductionEngine] DEDUCTIONS_MODE=${ctx.mode} but DEDUCTIONS_LIVE_FROM is unset or invalid: writing nothing`);
  }
  return false;
}

/** Meetings that start before the go-live date are never fined, in any mode (no date = nothing is allowed). */
const startAllowed = (ctx, startMs) => Boolean(ctx.liveFrom) && startMs >= ctx.liveFrom.getTime();

/** Earliest meeting start any evaluator looks at. */
const lowerBoundMs = (ctx, lookbackMs) =>
  Math.max(ctx.nowMs - lookbackMs, ctx.liveFrom ? ctx.liveFrom.getTime() : 0);

/** Row status for a new fine: shadow in shadow mode, otherwise active, or needs_review when data was unhealthy. */
const statusForNew = (ctx, healthy) => (ctx.mode === 'shadow' ? 'shadow' : healthy ? 'active' : 'needs_review');

// ---------------------------------------------------------------------------------------------------------
// Pure judging (plan 2.5). Each returns { fine, reason }. No database, no clock but the argument.
// ---------------------------------------------------------------------------------------------------------

function baseJudge(booking, profile, nowMs) {
  const assigned = getAssignedBdaEmail(booking);
  if (!assigned) return { fine: false, reason: 'unassigned' };
  const verdict = countableReason(booking, profile, nowMs);
  if (!verdict.countable) return { fine: false, reason: verdict.reason };
  return { fine: true, assigned };
}

/** Missed meeting: the verdict was absent for the assigned BDA on a countable meeting. */
export function judgeMissedMeeting({ booking, profile, bdaEmail, nowMs }) {
  const base = baseJudge(booking, profile, nowMs);
  if (!base.fine) return base;
  if (base.assigned !== norm(bdaEmail)) return { fine: false, reason: 'not_assigned' };
  return { fine: true, reason: null, bdaEmail: base.assigned };
}

/**
 * No-show not called. `summary` is the booking's callSummary, or undefined when unknown (unknown is never a fine).
 * Judged once start + healthWindow has passed, for 60 days after the meeting.
 */
export function judgeNoShowNotCalled({ booking, profile, summary, nowMs }) {
  const p = DEDUCTION_POLICY;
  if (booking?.bookingStatus !== 'no-show') return { fine: false, reason: 'not_no_show' };
  const base = baseJudge(booking, profile, nowMs);
  if (!base.fine) return base;
  const startMs = toMs(booking.scheduledEventStartTime);
  if (nowMs < startMs + p.noShowNotCalled.healthWindowMs) return { fine: false, reason: 'too_early' };
  if (nowMs > startMs + p.rejudgeWindowMs) return { fine: false, reason: 'outside_rejudge_window' };
  // The fine needs a number a call could actually be linked to. "N/A", "12345" or a local number without a country
  // code has no usable key on either side, so even a call the BDA really made could never link: no fine.
  if (!bookingPhoneKey(booking)) {
    return { fine: false, reason: 'no_callable_phone' };
  }
  if (!summary) return { fine: false, reason: 'call_data_unknown' };
  if (summary.calledWithin30Min) return { fine: false, reason: 'called_in_time' };
  return { fine: true, reason: null, bdaEmail: base.assigned };
}

/** Status not updated: still `scheduled` at start + deadline. Reads the status AT the deadline from history. */
export function judgeStatusNotUpdated({ booking, profile, nowMs, deadlineMs }) {
  const base = baseJudge(booking, profile, nowMs);
  if (!base.fine) return base;
  const startMs = toMs(booking.scheduledEventStartTime);
  const at = startMs + deadlineMs;
  if (nowMs < at) return { fine: false, reason: 'before_deadline' };
  if (nowMs > startMs + DEDUCTION_POLICY.rejudgeWindowMs) return { fine: false, reason: 'outside_rejudge_window' };
  // A change away from `scheduled` before the deadline satisfies the rule, a change after it does not undo it.
  if (statusAtStart(booking, at) !== 'scheduled') return { fine: false, reason: 'status_updated_in_time' };
  return { fine: true, reason: null, bdaEmail: base.assigned };
}

// ---------------------------------------------------------------------------------------------------------
// Tier maths (plan 2.5, 8.2)
// ---------------------------------------------------------------------------------------------------------

/**
 * Pure. Given the month's missed_meeting rows, returns the target tierIndex and amount for each.
 * `active` rows are ordered by scheduledStart and numbered 1..N. A meeting from the flat-rate date on costs the base
 * amount whatever its number; an earlier one keeps the old tiers (see missedMeetingAmount). `shadow` rows are ordered among themselves only,
 * a projection for the shadow-week review that never mixes with real tiers. Other statuses are ignored.
 */
export function planTiers(rows) {
  const plan = [];
  for (const status of ['active', 'shadow']) {
    const group = rows
      .filter((r) => r.status === status)
      .map((r) => ({ r, key: toMs(r.evidence?.scheduledStart) ?? toMs(r.createdAt) ?? 0 }))
      .sort((a, b) => a.key - b.key || String(a.r.deductionId).localeCompare(String(b.r.deductionId)));
    group.forEach(({ r, key }, i) => {
      const tierIndex = i + 1;
      const amountInr = missedMeetingAmount(tierIndex, key);
      plan.push({
        deductionId: r.deductionId,
        status,
        tierIndex,
        amountInr,
        changed: r.tierIndex !== tierIndex || r.amountInr !== amountInr,
      });
    });
  }
  return plan;
}

const signature = (rows) => rows.map((r) => `${r.deductionId}:${r.status}`).sort().join('|');

/**
 * Deterministic full recompute of one BDA's month. Safe to run twice or concurrently: every run reads the whole
 * set, writes only rows whose numbers differ, then re-reads and repeats if the set moved underneath it.
 */
export async function repriceMonth(bdaEmail, month, { maxPasses = 4 } = {}) {
  const filter = { bdaEmail: norm(bdaEmail), month, rule: 'missed_meeting', status: { $in: ['active', 'shadow'] } };
  let updated = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const rows = await BdaDeductionModel.find(filter).select('deductionId status tierIndex amountInr evidence.scheduledStart createdAt').lean();
    const ops = planTiers(rows)
      .filter((p) => p.changed)
      .map((p) => ({
        updateOne: {
          filter: { deductionId: p.deductionId, status: p.status }, // a row waived in between is left alone
          update: { $set: { tierIndex: p.tierIndex, amountInr: p.amountInr } },
        },
      }));
    if (ops.length) {
      await BdaDeductionModel.bulkWrite(ops, { ordered: false });
      updated += ops.length;
    }
    const after = await BdaDeductionModel.find(filter).select('deductionId status').lean();
    if (signature(after) === signature(rows)) return { month, bdaEmail: filter.bdaEmail, rows: rows.length, updated };
  }
  console.warn(`[DeductionEngine] repriceMonth(${bdaEmail}, ${month}) kept changing, the next tick will settle it`);
  return { month, bdaEmail: filter.bdaEmail, rows: null, updated, unsettled: true };
}

// ---------------------------------------------------------------------------------------------------------
// Row creation (idempotent through the unique index) and Discord
// ---------------------------------------------------------------------------------------------------------

/** Upsert keyed by {bookingId, bdaEmail, rule}. A second call, or a second instance, never adds a duplicate. */
async function insertDeduction({ bookingId, bdaEmail, rule, startMs, status, amountInr, evidence }, profile = null) {
  const filter = { bookingId, bdaEmail, rule };
  try {
    const res = await BdaDeductionModel.updateOne(
      filter,
      {
        $setOnInsert: {
          deductionId: newDeductionId(),
          month: workMonthOf(startMs, profile),
          amountInr: amountInr ?? baseAmountFor(rule),
          tierIndex: null,
          status,
          evidence,
        },
      },
      { upsert: true }
    );
    return { created: res.upsertedCount === 1 };
  } catch (err) {
    if (err?.code === 11000) return { created: false }; // lost an upsert race, the other writer's row stands
    throw err;
  }
}

const nameOf = (profile, email) => profile?.displayName || String(email).split('@')[0];

function messageFor(row, name, client) {
  const start = toMs(row.evidence?.scheduledStart);
  const at = start ? fmtTimeIst(start) : 'an unknown time';
  const who = client || 'the client';
  if (row.rule === 'no_show_not_called') {
    return `${inr(row.amountInr)} deduction, ${name}: ${who} was a no-show at ${at} and no Zoom call to them was found within 30 min.`;
  }
  if (row.rule === 'status_not_updated') {
    return `${inr(row.amountInr)} deduction, ${name}: the CRM status for ${who} (${at}) was still "scheduled" past the update deadline.`;
  }
  const tier = row.tierIndex ? ` (miss ${row.tierIndex} this month)` : '';
  const manual = row.evidence?.manualAbsent;
  if (manual) {
    const what = manual.kind === 'allocation' ? 'the allocated call' : 'the meeting';
    return `${inr(row.amountInr)} deduction, ${name}: marked absent for ${what} with ${who} at ${at}${tier}. Marked by ${manual.markedByName || manual.markedBy || 'an admin'}.`;
  }
  if (row.evidence?.absentReason === 'left_early') {
    const stayed = Number.isFinite(row.evidence?.stayMs) ? formatStay(row.evidence.stayMs) : 'less than the minimum';
    return `${inr(row.amountInr)} deduction, ${name}: missed the meeting with ${who} at ${at}: joined the Google Meet but left too early (${stayed} after the start, ${formatStay(MIN_STAY_MS)} needed)${tier}.`;
  }
  return `${inr(row.amountInr)} deduction, ${name}: missed the meeting with ${who} at ${at}: not in the Google Meet and not marked present in time${tier}.`;
}

const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Why a row is held for review instead of counting, in words an admin can act on. Reads the evidence the rule
 * stored; falls back to a plain "held for review" when a row predates these fields.
 */
export function reviewReason(row) {
  const ev = row.evidence || {};
  const covered = Array.isArray(ev.coveredBy) ? ev.coveredBy : [];
  if (covered.length) {
    const who = listNames(covered.map((c) => `${c.bdaName || String(c.bdaEmail || '').split('@')[0]}${Number.isFinite(c.minutes) ? ` (${c.minutes} min)` : ''}`));
    const where = covered.every((c) => c.source === 'extension') ? 'the call' : 'the Google Meet call';
    const verb = covered.length > 1 ? 'were' : 'was';
    if (row.rule === 'no_show_not_called') return `held for review: ${who} ${verb} in ${where}, so calling the client may have been theirs`;
    if (row.rule === 'status_not_updated') return `held for review: ${who} ${verb} in ${where}, so updating the status may have been theirs`;
    return `held for review: ${who} ${verb} in ${where} instead`;
  }
  const staff = Array.isArray(ev.unattributedStaff) ? ev.unattributedStaff : [];
  if (staff.length) return `held for review: a shared team account (${listNames(staff.map((x) => x.displayName || x.name || String(x)))}) was in the Google Meet call`;
  if (ev.extensionInCall) return 'held for review: their extension reported them in the call, but Google Meet did not';
  if (ev.healthy === false) {
    if (row.rule === 'no_show_not_called') return 'held for review: the Zoom call log was not syncing during the call window';
    if (row.rule === 'status_not_updated') return 'held for review: the attendance job was not running at the status deadline';
    return 'held for review: the Google Meet attendance sync was not running at the meeting time';
  }
  return 'held for review';
}

/** Exported for tests. Wording per plan 8.2; `mention` is the BDA's `<@discordUserId>` when set. */
export function formatDeductionMessage(row, { name, client, mention = null }) {
  const body = messageFor(row, name, client);
  if (row.status === 'shadow') return `[shadow, not counted] ${body}`;
  if (row.status === 'needs_review') return `[${reviewReason(row)}, not counted yet] ${body}`;
  return mention ? `${mention} ${body}` : body;
}

async function announce(ctx, row, profile, booking) {
  const name = nameOf(profile, row.bdaEmail);
  const client = booking?.clientName || row.evidence?.clientName || null;
  const mention = profile?.discordUserId ? `<@${profile.discordUserId}>` : null;
  const content = formatDeductionMessage(row, { name, client, mention });
  // Only a real, counted fine goes to the BDA channel. Shadow and review rows stay with the admins.
  const channel = row.status === 'active' ? 'deductions' : 'admin';
  try {
    await ctx.post({ channel, content, row, mention });
  } catch (err) {
    console.error('[DeductionEngine] announce failed:', err?.message || err);
  }
}

/** Insert, reprice the month if it is a miss, then post once. Returns the final row or null when nothing new. */
async function createAndAnnounce(ctx, args, profile, booking, { ignoreTracking = false } = {}) {
  // Never fine a meeting from before this BDA was tracked (the status and no-show rules ignored trackedSince).
  // An admin marking by hand can override this on purpose.
  if (!ignoreTracking && profile && !isAfterGoLive(profile, args.startMs)) return null;
  const { created } = await insertDeduction(args, profile);
  if (!created) return null;
  if (args.rule === 'missed_meeting') await repriceMonth(args.bdaEmail, workMonthOf(args.startMs, profile));
  const row = await BdaDeductionModel.findOne({ bookingId: args.bookingId, bdaEmail: args.bdaEmail, rule: args.rule }).lean();
  if (row) await announce(ctx, row, profile, booking);
  return row;
}

const callSummaryFor = async (ctx, booking) => {
  try {
    const map = await ctx.getCallSummaries([booking]);
    return map?.get?.(booking.bookingId) ?? null;
  } catch (err) {
    console.error('[DeductionEngine] call summary unavailable for evidence:', err?.message || err);
    return null;
  }
};

const plainJson = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------------------------------------
// missed_meeting
// ---------------------------------------------------------------------------------------------------------

/**
 * Health of the sources behind an absent verdict that was found by the sweep (plan 2.7). The live event carries its
 * own `healthy`; this is the conservative rebuild for a verdict whose event was missed. Heartbeat history is not
 * stored, so the "extension was alive" exemption is not available here and Google staleness alone decides.
 */
async function sweepVerdictHealthy(ctx, startMs, verdictAtMs) {
  const from = startMs + WINDOW_CLOSE_MS;
  const ran = await ctx.syncRanBetween('verdict_job', from, startMs + VERDICT_JOB_WINDOW_MS);
  if (!ran) return false;
  return ctx.sourceHealthy('google_meet', {
    fromMs: from,
    toMs: Math.max(from, verdictAtMs ?? from),
    maxAgeMs: SYNC_LIMITS_MS.google_meet,
  });
}

/**
 * Colleagues the attendance record shows in this meeting while the assigned BDA is not. Without a CRM reassignment the
 * engine fines the assigned BDA, so a covered meeting looked like a miss: 20 of Kalpataru's October fines were this.
 * Returns [] when nobody covered it, or when the lookup fails (never block a fine on a lookup error).
 */
async function coverFor(ctx, bookingId, email, startMs) {
  try {
    const rows = await ctx.loadCover(bookingId, email);
    const out = [];
    for (const row of rows ?? []) {
      const seen = attendanceShowsPresent(row);
      if (!seen) continue;
      // A colleague who popped in and out (record shows under MIN_STAY_MS in the call after the start) did not
      // cover the meeting, so their visit does not hold the fine.
      const stay = Number.isFinite(startMs) ? stayAfterStart(row, startMs, ctx.nowMs) : { known: false, ms: null };
      if (leftTooEarly(stay)) continue;
      const who = norm(row.bdaEmail);
      const profile = await profileOf(ctx, who);
      out.push({
        bdaEmail: who,
        bdaName: profile?.displayName || row.bdaName || who.split('@')[0],
        joinedAt: seen.joinedAt ? seen.joinedAt.toISOString() : null,
        minutes: stay.known ? Math.round(stay.ms / 60000) : seen.minutes,
        source: row.sessions?.length ? 'google_meet' : 'extension',
      });
    }
    return out;
  } catch (err) {
    console.warn('[DeductionEngine] cover check failed:', err?.message);
    return [];
  }
}

/**
 * Signed-in participants in the Meet roster whose name is a shared team account (for example "FLASHFIRE"). Someone
 * from the team was in the call, but not as a BDA the roster could match, so the engine saw nobody.
 */
export function sharedAccountsIn(roster) {
  const names = DEDUCTION_POLICY.sharedStaffAccountNames;
  return (roster ?? [])
    .filter((p) => p?.kind === 'signedin' && names.some((n) => String(p.displayName ?? '').toLowerCase().includes(n)))
    .map((p) => ({ displayName: p.displayName }));
}

/** The BDA's own extension reported them in this meeting's call. A failed lookup is "no evidence", never a block. */
async function inCallFor(ctx, bdaEmail, booking, startMs) {
  try {
    return (await ctx.loadInCall(bdaEmail, booking.googleMeetCode ?? null, startMs)) ?? null;
  } catch (err) {
    console.warn('[DeductionEngine] in-call check failed:', err?.message);
    return null;
  }
}

/**
 * Create the missed_meeting row for one absent verdict. `healthy` false makes it needs_review. So does evidence that
 * the meeting was attended after all: a colleague in the call, a shared team account in the roster, or the BDA's own
 * extension reporting them in the call. A held row is written but does not count until an admin decides.
 * Returns { created, reason? }.
 */
async function createMissedMeeting(ctx, { booking, bdaEmail, signals, healthy }) {
  const email = norm(bdaEmail);
  const startMs = toMs(booking?.scheduledEventStartTime);
  if (startMs == null) return { created: false, reason: 'no_start_time' };
  if (!startAllowed(ctx, startMs)) return { created: false, reason: 'before_live_from' };

  const profile = await profileOf(ctx, email);
  const judged = judgeMissedMeeting({ booking, profile, bdaEmail: email, nowMs: ctx.nowMs });
  if (!judged.fine) return { created: false, reason: judged.reason };

  // Late evidence may have flipped the verdict while this event was in flight (plan 2.2). Never fine on a stale absent.
  const att = await ctx.loadAttendance(booking.bookingId, email);
  if (att && (att.verdict === 'present' || att.verdictCorrectedAt)) return { created: false, reason: 'verdict_corrected' };
  // Belt and braces: never fine while in-time evidence sits on the row, whatever the verdict field says.
  // Same rule as the verdict: in-time evidence only protects a BDA who also stayed the minimum after the start.
  const presence = att ? presenceVerdict(att, startMs, ctx.nowMs) : null;
  if (presence?.present) return { created: false, reason: 'has_in_time_evidence' };

  const coveredBy = await coverFor(ctx, booking.bookingId, email, startMs);
  const unattributedStaff = sharedAccountsIn(att?.participantsAtJoin);
  const extensionInCall = await inCallFor(ctx, email, booking, startMs);
  const heldForReview = coveredBy.length > 0 || unattributedStaff.length > 0 || Boolean(extensionInCall);

  const evidence = {
    scheduledStart: new Date(startMs),
    windowClosedAt: new Date(startMs + WINDOW_CLOSE_MS),
    coveredBy: plainJson(coveredBy),
    unattributedStaff: plainJson(unattributedStaff),
    extensionInCall: plainJson(extensionInCall),
    signals: plainJson(signals ?? att?.signals ?? []),
    bookingStatus: booking.bookingStatus ?? null,
    callSummary: plainJson(await callSummaryFor(ctx, booking)),
    clientName: booking.clientName ?? null,
    healthy: Boolean(healthy),
    // Why the BDA counts as absent: 'no_signal' (never seen in time) or 'left_early' (left before the minimum stay).
    absentReason: presence?.reason === 'left_early' ? 'left_early' : 'no_signal',
    stayMs: presence?.stay?.known ? presence.stay.ms : null,
    // Double-booked: the other meeting(s) at the same time, and whether the BDA was in one. Admins decide on waivers.
    doubleBookedWith: plainJson(await overlappingFor(ctx, booking, email)),
  };
  const row = await createAndAnnounce(
    ctx,
    {
      bookingId: booking.bookingId,
      bdaEmail: email,
      rule: 'missed_meeting',
      startMs,
      status: statusForNew(ctx, healthy && !heldForReview),
      amountInr: DEDUCTION_POLICY.missedMeeting.baseAmountInr,
      evidence,
    },
    profile,
    booking
  );
  return { created: Boolean(row), reason: row ? null : 'exists', row };
}

async function overlappingFor(ctx, booking, email) {
  try {
    const list = await (ctx.findOverlapping || findOverlappingMeetings)(booking, email, { nowMs: ctx.nowMs });
    return list.map((o) => ({ bookingId: o.bookingId, clientName: o.clientName, attended: o.attended }));
  } catch (err) {
    console.warn('[DeductionEngine] double-booking check failed:', err?.message);
    return [];
  }
}

/** VERDICT event: an absent verdict becomes a missed_meeting row. A present verdict is not our business. */
export async function handleVerdict(payload, opts = {}) {
  const ctx = makeContext(opts);
  if (!canWrite(ctx)) return { created: false, reason: `mode_${ctx.mode}` };
  if (payload?.verdict !== 'absent') return { created: false, reason: 'not_absent' };
  const [booking] = await ctx.loadBookings([payload.bookingId]);
  if (!booking) return { created: false, reason: 'booking_not_found' };
  if (!booking.scheduledEventStartTime && payload.scheduledStart) booking.scheduledEventStartTime = payload.scheduledStart;
  return createMissedMeeting(ctx, {
    booking,
    bdaEmail: payload.bdaEmail,
    signals: payload.signals,
    healthy: payload.healthy !== false, // an event that does not say is treated as healthy
  });
}

/** Sweep: absent verdicts that have no row yet (a lost event, a restart, a mode switch). */
export async function evaluateMissedMeetings(opts = {}) {
  const ctx = makeContext(opts);
  const out = { checked: 0, created: 0 };
  if (!canWrite(ctx)) return { ...out, skipped: `mode_${ctx.mode}` };

  const from = new Date(lowerBoundMs(ctx, DEDUCTION_POLICY.verdictSweepLookbackMs));
  const cursor = BdaAttendanceModel.find({
    verdict: 'absent',
    verdictCorrectedAt: null,
    meetingScheduledStart: { $gte: from, $lte: new Date(ctx.nowMs) },
  })
    .select('bookingId bdaEmail verdictAt signals meetingScheduledStart')
    .sort({ meetingScheduledStart: 1 })
    .lean()
    .cursor();

  await forEachBatch(cursor, BATCH, async (atts) => {
    const have = await BdaDeductionModel.find({
      rule: 'missed_meeting',
      bookingId: { $in: atts.map((a) => a.bookingId) },
    }).select('bookingId bdaEmail').lean();
    const haveKey = new Set(have.map((d) => `${d.bookingId}|${d.bdaEmail}`));
    const todo = atts.filter((a) => !haveKey.has(`${a.bookingId}|${norm(a.bdaEmail)}`));
    if (todo.length === 0) return;
    const bookings = new Map((await ctx.loadBookings(todo.map((a) => a.bookingId))).map((b) => [b.bookingId, b]));
    for (const a of todo) {
      out.checked += 1;
      const booking = bookings.get(a.bookingId);
      if (!booking) continue;
      const startMs = toMs(booking.scheduledEventStartTime);
      const healthy = startMs == null ? false : await sweepVerdictHealthy(ctx, startMs, toMs(a.verdictAt));
      const res = await createMissedMeeting(ctx, { booking, bdaEmail: a.bdaEmail, signals: a.signals, healthy });
      if (res.created) out.created += 1;
    }
  });
  return out;
}

/** Void missed_meeting rows (any live status) for a booking whose absent verdict was corrected, then reprice. */
async function voidMissedForBooking(bookingId, bdaEmail, reason, now) {
  const rows = await BdaDeductionModel.find({
    bookingId,
    bdaEmail: norm(bdaEmail),
    rule: 'missed_meeting',
    status: { $in: ACTIVE_LIKE },
  }).select('deductionId month bdaEmail').lean();
  const months = new Set();
  let voided = 0;
  for (const r of rows) {
    const res = await BdaDeductionModel.updateOne(
      { deductionId: r.deductionId, status: { $in: ACTIVE_LIKE } },
      { $set: { status: 'voided', voidedAt: now, voidReason: reason, tierIndex: null } }
    );
    if (res.modifiedCount === 1) {
      voided += 1;
      months.add(r.month);
    }
  }
  for (const m of months) await repriceMonth(bdaEmail, m);
  return { voided, months: [...months] };
}

/**
 * VERDICT_CORRECTED event: late evidence turned an absent verdict into present. Voiding only ever lowers a fine, so
 * it runs in every mode, including off.
 */
export async function handleVerdictCorrected(payload, opts = {}) {
  const ctx = makeContext(opts);
  return voidMissedForBooking(payload.bookingId, payload.bdaEmail, 'late_evidence', new Date(ctx.nowMs));
}

/** Safety net for a lost VERDICT_CORRECTED event: any live row whose attendance row was corrected gets voided. */
export async function sweepCorrectedVerdicts(opts = {}) {
  const ctx = makeContext(opts);
  const from = new Date(ctx.nowMs - DEDUCTION_POLICY.verdictSweepLookbackMs);
  const corrected = await BdaAttendanceModel.find({
    verdict: 'present',
    verdictCorrectedAt: { $ne: null },
    meetingScheduledStart: { $gte: from },
  }).select('bookingId bdaEmail').lean();
  if (corrected.length === 0) return { voided: 0 };
  const rows = await BdaDeductionModel.find({
    rule: 'missed_meeting',
    status: { $in: ACTIVE_LIKE },
    bookingId: { $in: corrected.map((c) => c.bookingId) },
  }).select('bookingId bdaEmail').lean();
  const correctedKey = new Set(corrected.map((c) => `${c.bookingId}|${norm(c.bdaEmail)}`));
  let voided = 0;
  for (const r of rows) {
    if (!correctedKey.has(`${r.bookingId}|${r.bdaEmail}`)) continue;
    voided += (await voidMissedForBooking(r.bookingId, r.bdaEmail, 'late_evidence', new Date(ctx.nowMs))).voided;
  }
  return { voided };
}

// ---------------------------------------------------------------------------------------------------------
// no_show_not_called and status_not_updated
// ---------------------------------------------------------------------------------------------------------

async function forEachBatch(cursor, size, fn) {
  let batch = [];
  for await (const item of cursor) {
    batch.push(item);
    if (batch.length >= size) {
      await fn(batch);
      batch = [];
    }
  }
  if (batch.length) await fn(batch);
}

const existingRuleRows = async (rule, bookings) => {
  const have = await BdaDeductionModel.find({ rule, bookingId: { $in: bookings.map((b) => b.bookingId) } })
    .select('bookingId bdaEmail').lean();
  return new Set(have.map((d) => `${d.bookingId}|${d.bdaEmail}`));
};

export async function evaluateNoShowNotCalled(opts = {}) {
  const ctx = makeContext(opts);
  const out = { checked: 0, created: 0 };
  if (!canWrite(ctx)) return { ...out, skipped: `mode_${ctx.mode}` };
  const p = DEDUCTION_POLICY;

  const cursor = CampaignBookingModel.find({
    bookingStatus: 'no-show',
    scheduledEventStartTime: {
      $gte: new Date(lowerBoundMs(ctx, p.rejudgeWindowMs)),
      $lte: new Date(ctx.nowMs - p.noShowNotCalled.healthWindowMs),
    },
  }).select(BOOKING_FIELDS).sort({ scheduledEventStartTime: 1 }).lean().cursor();

  await forEachBatch(cursor, BATCH, async (bookings) => {
    const have = await existingRuleRows('no_show_not_called', bookings);
    const todo = bookings.filter((b) => {
      const email = getAssignedBdaEmail(b);
      return email && !have.has(`${b.bookingId}|${email}`);
    });
    if (todo.length === 0) return;
    let summaries;
    try {
      summaries = await ctx.getCallSummaries(todo);
    } catch (err) {
      console.error('[DeductionEngine] call summaries unavailable, skipping no-show batch:', err?.message || err);
      return; // unknown call data never fines
    }
    for (const booking of todo) {
      out.checked += 1;
      const email = getAssignedBdaEmail(booking);
      const startMs = toMs(booking.scheduledEventStartTime);
      if (!startAllowed(ctx, startMs)) continue;
      const profile = await profileOf(ctx, email);
      const summary = summaries?.get?.(booking.bookingId);
      const judged = judgeNoShowNotCalled({ booking, profile, summary, nowMs: ctx.nowMs });
      if (!judged.fine) continue;

      // Plan 2.7: the Zoom sync must have been fresh at every moment of [start, start + 40 min].
      const healthy = await ctx.sourceHealthy('zoom_phone', {
        fromMs: startMs,
        toMs: startMs + p.noShowNotCalled.healthWindowMs,
        maxAgeMs: SYNC_LIMITS_MS.zoom_phone,
      });
      // A colleague covered the meeting, so ringing the no-show client was theirs to do: hold it for review.
      const coveredBy = await coverFor(ctx, booking.bookingId, email, startMs);
      const row = await createAndAnnounce(
        ctx,
        {
          bookingId: booking.bookingId,
          bdaEmail: email,
          rule: 'no_show_not_called',
          startMs,
          status: statusForNew(ctx, healthy && coveredBy.length === 0),
          evidence: {
            scheduledStart: new Date(startMs),
            windowClosedAt: new Date(startMs + p.noShowNotCalled.callWindowMs),
            signals: [],
            bookingStatus: booking.bookingStatus,
            callSummary: plainJson(summary),
            clientName: booking.clientName ?? null,
            healthy,
            coveredBy: plainJson(coveredBy),
          },
        },
        profile,
        booking
      );
      if (row) out.created += 1;
    }
  });
  return out;
}

export async function evaluateStatusNotUpdated(opts = {}) {
  const ctx = makeContext(opts);
  const out = { checked: 0, created: 0 };
  if (!canWrite(ctx)) return { ...out, skipped: `mode_${ctx.mode}` };
  const p = DEDUCTION_POLICY;
  const deadlineMs = ctx.statusDeadlineMs;

  // Still scheduled now, or changed after its own deadline (status AT the deadline decides, so a late update
  // that a 5-minute tick missed cannot undo the fine).
  const cursor = CampaignBookingModel.find({
    scheduledEventStartTime: {
      $gte: new Date(lowerBoundMs(ctx, p.rejudgeWindowMs)),
      $lte: new Date(ctx.nowMs - deadlineMs),
    },
    $or: [
      { bookingStatus: 'scheduled' },
      { $expr: { $gt: ['$statusChangedAt', { $add: ['$scheduledEventStartTime', deadlineMs] }] } },
    ],
  }).select(BOOKING_FIELDS).sort({ scheduledEventStartTime: 1 }).lean().cursor();

  await forEachBatch(cursor, BATCH, async (bookings) => {
    const have = await existingRuleRows('status_not_updated', bookings);
    for (const booking of bookings) {
      const email = getAssignedBdaEmail(booking);
      if (!email || have.has(`${booking.bookingId}|${email}`)) continue;
      out.checked += 1;
      const startMs = toMs(booking.scheduledEventStartTime);
      if (!startAllowed(ctx, startMs)) continue;
      const profile = await profileOf(ctx, email);
      const judged = judgeStatusNotUpdated({ booking, profile, nowMs: ctx.nowMs, deadlineMs });
      if (!judged.fine) continue;

      // Plan 2.7: the only dependency is the backend being up at the deadline. The verdict job runs every 15 s,
      // so a sample near the deadline proves it.
      const at = startMs + deadlineMs;
      const healthy = await ctx.syncRanBetween('verdict_job', at - 10 * MIN, at);
      // A colleague covered the meeting, so updating its status was theirs to do: hold it for review.
      const coveredBy = await coverFor(ctx, booking.bookingId, email, startMs);
      const row = await createAndAnnounce(
        ctx,
        {
          bookingId: booking.bookingId,
          bdaEmail: email,
          rule: 'status_not_updated',
          startMs,
          status: statusForNew(ctx, healthy && coveredBy.length === 0),
          evidence: {
            scheduledStart: new Date(startMs),
            windowClosedAt: new Date(at),
            signals: [],
            bookingStatus: 'scheduled',
            callSummary: null,
            clientName: booking.clientName ?? null,
            healthy,
            coveredBy: plainJson(coveredBy),
          },
        },
        profile,
        booking
      );
      if (row) out.created += 1;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------------------------------------

/** Run every evaluator once. Plan 8.2: called every 5 minutes. Off writes nothing. */
export async function runDeductionEvaluators(now = new Date(), opts = {}) {
  const ctxOpts = { ...opts, now };
  const ctx = makeContext(ctxOpts);
  if (!canWrite(ctx)) return { mode: ctx.mode, skipped: true };

  const result = { mode: ctx.mode };
  const step = async (name, fn) => {
    try {
      result[name] = await fn();
    } catch (err) {
      // One failing evaluator must not stop the others; the next tick retries it.
      console.error(`[DeductionEngine] ${name} failed:`, err?.message || err);
      result[name] = { error: err?.message || String(err) };
    }
  };
  await step('voided', () => sweepCorrectedVerdicts(ctxOpts));
  await step('missedMeeting', () => evaluateMissedMeetings(ctxOpts));
  await step('noShowNotCalled', () => evaluateNoShowNotCalled(ctxOpts));
  await step('statusNotUpdated', () => evaluateStatusNotUpdated(ctxOpts));
  // Warning letters at 7, 10 and 15 misses in the current calendar month (a draft for admins, or sent, by WARNING_LETTERS_MODE).
  await step('warningLetters', () => evaluateWarningLetters(new Date(ctx.nowMs), {}));
  // Self-heal: recompute the current and previous IST month for every BDA that has a miss row.
  await step('repriced', async () => {
    const months = [workMonthOf(ctx.nowMs), workMonthOf(ctx.nowMs - 31 * 24 * 60 * MIN)];
    const pairs = await BdaDeductionModel.aggregate([
      { $match: { rule: 'missed_meeting', month: { $in: months }, status: { $in: ['active', 'shadow'] } } },
      { $group: { _id: { bdaEmail: '$bdaEmail', month: '$month' } } },
    ]);
    let updated = 0;
    for (const { _id } of pairs) updated += (await repriceMonth(_id.bdaEmail, _id.month)).updated;
    return { pairs: pairs.length, updated };
  });
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Admin actions (waive, activate, convert a flag into a miss)
// ---------------------------------------------------------------------------------------------------------

const fail = (status, code, message) => ({ ok: false, status, code, message });

/** `actor` is { email, name }. A waiver is never a delete: the row keeps who, when and why. */
export async function waiveDeduction(deductionId, actor, reason, { now = new Date() } = {}) {
  const row = await BdaDeductionModel.findOneAndUpdate(
    { deductionId, status: { $in: ACTIVE_LIKE } },
    {
      $set: {
        status: 'waived',
        waivedBy: actor.email || 'admin',
        waivedByName: actor.name || null,
        waivedAt: now,
        waiverReason: reason,
        tierIndex: null,
      },
    },
    { new: true }
  ).lean();
  if (!row) return missingOrResolved(deductionId);
  if (row.rule === 'missed_meeting') await repriceMonth(row.bdaEmail, row.month);
  return { ok: true, deduction: await BdaDeductionModel.findOne({ deductionId }).lean() };
}

/**
 * What the attendance row shows about this BDA in the meeting, or null when nothing shows them there. Any join, any
 * counted signal, or a present verdict counts: a person marking a call absent has to be told when the record disagrees.
 */
export function attendanceShowsPresent(row) {
  if (!row) return null;
  const joinedAt = row.firstJoinedAt || row.joinedAt || null;
  const present = row.verdict === 'present' || row.status === 'present' || row.status === 'manual' || Boolean(joinedAt) || Boolean(row.markedPresentAt) || (row.signals || []).length > 0;
  if (!present) return null;
  const ms = row.durationMs ?? row.cumulativeDurationMs ?? 0;
  return {
    status: row.status ?? null,
    verdict: row.verdict ?? null,
    joinedAt: joinedAt ? new Date(joinedAt) : null,
    minutes: Math.round(ms / 60000),
    signals: (row.signals || []).map((s) => s.kind),
    joinDevice: row.joinDevice ?? null,
  };
}

/**
 * A fine written by a person, not by the verdict job: an admin marking a call absent, or an admin approving a BDA's
 * own report. It is a normal missed_meeting row, so the monthly tiers, waivers, payroll and Discord all treat it like
 * any other miss. It obeys the same gates as the automatic fines: fines off writes nothing, shadow writes a shadow
 * row, and a call before the go-live date or before the BDA was tracked is never fined.
 *
 * `refId` is the booking id for a Calendly meeting or the allocation id for a Lead Allocation call; the unique
 * {bookingId, bdaEmail, rule} index makes a second mark of the same call a no-op that reports `already_fined`.
 */
export async function createManualMiss({ kind, refId, bdaEmail, startMs, clientName = null, actor, reason, requestId = null, force = false, ignoreStartGates = false }, opts = {}) {
  const ctx = makeContext(opts);
  const email = norm(bdaEmail);
  if (ctx.mode === 'off') return fail(409, 'fines_off', 'Fines are switched off, so nothing can be recorded');
  if (!canWrite(ctx)) return fail(409, 'fines_not_started', 'Fines have no go-live date yet, so nothing can be recorded');
  if (!Number.isFinite(startMs)) return fail(422, 'no_start_time', 'This call has no start time');
  // `ignoreStartGates` is an admin's deliberate mark: the go-live date and the tracked-since date do not stop it.
  if (!ignoreStartGates && !startAllowed(ctx, startMs)) return fail(409, 'before_live_from', 'This call started before fines went live');
  const profile = await profileOf(ctx, email);
  if (!profile || profile.active === false || profile.tracked !== true) {
    return fail(409, 'not_tracked', 'This person is not a tracked BDA');
  }
  if (!ignoreStartGates && !isAfterGoLive(profile, startMs)) return fail(409, 'before_tracking', 'This call started before the BDA was tracked');
  // The automatic rules skip approved leave days, so a person marking by hand must not fine one either.
  if (isLeaveDayFor(profile, startMs)) {
    return fail(409, 'on_leave', `This call is in the ${workDayOf(startMs, profile)} working day, an approved leave day, so it cannot be marked absent`);
  }

  const existing = await BdaDeductionModel.findOne({ bookingId: refId, bdaEmail: email, rule: 'missed_meeting' }).select('status').lean();
  if (existing) return fail(409, 'already_fined', `This call already has a fine (${existing.status})`);

  // A person marking a call absent by hand must not fine someone the attendance record shows in the meeting. The
  // automatic rule needs no signal to fine, so this is the only place a wrong fine can be stopped. An admin can
  // still override on purpose; the override and what the record showed are kept on the fine.
  const seen =
    kind === 'booking'
      ? attendanceShowsPresent(
          await (opts.Attendance ?? BdaAttendanceModel)
            .findOne({ bookingId: refId, bdaEmail: email })
            .select('status verdict signals firstJoinedAt joinedAt markedPresentAt durationMs cumulativeDurationMs joinDevice')
            .lean()
        )
      : null;
  if (seen && !force) {
    const when = seen.joinedAt
      ? ` at ${new Date(seen.joinedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST${seen.minutes > 0 ? ` for about ${seen.minutes} minutes` : ''}`
      : '';
    return fail(409, 'attendance_present', `Attendance shows ${profile.displayName || email} joined this meeting${when}, so marking them absent looks wrong. If you are sure, tick "Fine anyway" and try again.`);
  }

  const now = new Date(ctx.nowMs);
  const row = await createAndAnnounce(
    ctx,
    {
      bookingId: refId,
      bdaEmail: email,
      rule: 'missed_meeting',
      startMs,
      status: ctx.mode === 'shadow' ? 'shadow' : 'active',
      amountInr: DEDUCTION_POLICY.missedMeeting.baseAmountInr,
      evidence: {
        scheduledStart: new Date(startMs),
        windowClosedAt: new Date(startMs),
        signals: [],
        bookingStatus: null,
        callSummary: null,
        clientName,
        healthy: true,
        manualAbsent: {
          kind,
          reason,
          requestId,
          markedBy: actor?.email || 'admin',
          markedByName: actor?.name || null,
          at: now,
          // Set only when an admin overrode the attendance check: what the record showed at that moment.
          forced: Boolean(seen && force),
          attendance: seen && force ? seen : null,
        },
      },
    },
    profile,
    null,
    { ignoreTracking: ignoreStartGates }
  );
  if (!row) return fail(409, 'already_fined', 'This call already has a fine');
  return { ok: true, deduction: row };
}

async function missingOrResolved(deductionId) {
  const exists = await BdaDeductionModel.findOne({ deductionId }).select('status').lean();
  if (!exists) return fail(404, 'deduction_not_found', 'No such deduction');
  return fail(409, 'already_resolved', `This deduction is already ${exists.status}`);
}

/** Move a needs_review row to active (or waive it) with a reason, then reprice the month. */
export async function activateDeduction(deductionId, actor, reason, action = 'activate', { now = new Date() } = {}) {
  const current = await BdaDeductionModel.findOne({ deductionId }).select('status').lean();
  if (!current) return fail(404, 'deduction_not_found', 'No such deduction');
  if (['waived', 'voided'].includes(current.status)) return missingOrResolved(deductionId);
  if (current.status !== 'needs_review') {
    return fail(409, 'not_under_review', `Only a deduction under review can be activated, this one is ${current.status}`);
  }
  if (action === 'waive') return waiveDeduction(deductionId, actor, reason, { now });

  const row = await BdaDeductionModel.findOneAndUpdate(
    { deductionId, status: 'needs_review' },
    {
      $set: {
        status: 'active',
        reviewedBy: actor.email || 'admin',
        reviewedByName: actor.name || null,
        reviewedAt: now,
        reviewReason: reason,
      },
    },
    { new: true }
  ).lean();
  if (!row) return missingOrResolved(deductionId); // someone else resolved it first
  if (row.rule === 'missed_meeting') await repriceMonth(row.bdaEmail, row.month);
  return { ok: true, deduction: await BdaDeductionModel.findOne({ deductionId }).lean() };
}

/**
 * Admin turns a "marked present, never joined" flag into a missed_meeting row (decision D10).
 * Respects the mode and the go-live date like any other fine.
 */
export async function convertFlagToMiss({ bookingId, bdaEmail, reason, actor }, opts = {}) {
  const ctx = makeContext(opts);
  const email = norm(bdaEmail);
  if (ctx.mode === 'off') return fail(409, 'deductions_off', 'Deductions are off, nothing was written');
  if (!canWrite(ctx)) return fail(409, 'live_from_not_set', 'Deductions are live but the go-live date is not set');

  const att = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: email }).select('integrityFlag integrityResolved signals').lean();
  if (!att) return fail(404, 'attendance_not_found', 'No attendance row for this BDA and meeting');
  if (att.integrityFlag !== 'marked_never_joined' || att.integrityResolved?.at) {
    return fail(409, 'no_open_flag', 'There is no open "marked present, never joined" flag on this meeting');
  }
  const [booking] = await ctx.loadBookings([bookingId]);
  if (!booking) return fail(404, 'booking_not_found', 'Booking not found');
  const startMs = toMs(booking.scheduledEventStartTime);
  if (startMs == null) return fail(409, 'no_start_time', 'The booking has no start time');
  if (getAssignedBdaEmail(booking) !== email) return fail(409, 'not_assigned', 'That BDA is not assigned to this meeting');
  if (!startAllowed(ctx, startMs)) return fail(409, 'before_live_from', 'This meeting is before the go-live date');

  const profile = await profileOf(ctx, email);
  const now = new Date(ctx.nowMs);
  const row = await createAndAnnounce(
    ctx,
    {
      bookingId,
      bdaEmail: email,
      rule: 'missed_meeting',
      startMs,
      status: ctx.mode === 'shadow' ? 'shadow' : 'active', // an admin decided, so source health is moot
      amountInr: DEDUCTION_POLICY.missedMeeting.baseAmountInr,
      evidence: {
        scheduledStart: new Date(startMs),
        windowClosedAt: new Date(startMs + WINDOW_CLOSE_MS),
        signals: plainJson(att.signals ?? []),
        bookingStatus: booking.bookingStatus ?? null,
        callSummary: plainJson(await callSummaryFor(ctx, booking)),
        clientName: booking.clientName ?? null,
        healthy: true,
        convertedFromFlag: { reason, by: actor.email || 'admin', byName: actor.name || null, at: now },
      },
    },
    profile,
    booking
  );
  if (!row) return fail(409, 'already_exists', 'A missed-meeting deduction already exists for this meeting');
  // Close the flag so it leaves the admin review list. The attendance row keeps who, when and why.
  await BdaAttendanceModel.updateOne(
    { bookingId, bdaEmail: email, integrityFlag: 'marked_never_joined', 'integrityResolved.at': null },
    { $set: { integrityResolved: { at: now, by: actor.email || null, action: 'converted', reason } } }
  );
  return { ok: true, deduction: row };
}

// ---------------------------------------------------------------------------------------------------------
// Daily summary (plan D7), 22:00 IST, one post per tracked BDA
// ---------------------------------------------------------------------------------------------------------

/** Pure text builder, exported for tests. */
export function formatDailySummary({ name, mention, day, meetings, present, absent, noVerdict, calls, callMeetings, pending, deductions, shadow }) {
  const head = `${mention ? `${mention} ` : ''}Daily summary, ${name} (${DateTime.fromISO(day, { zone: IST_ZONE }).setLocale('en-US').toFormat('ccc d LLL')})${shadow ? ' [shadow]' : ''}`;
  const total = deductions.reduce((s, d) => s + d.amountInr, 0);
  const byRule = deductions.length
    ? ` (${deductions.map((d) => `${d.rule.replace(/_/g, ' ')} ${d.amountInr}`).join(', ')})`
    : '';
  return [
    head,
    `Meetings: ${meetings} (${present} present, ${absent} absent${noVerdict ? `, ${noVerdict} without a verdict yet` : ''})`,
    `Calls to clients: ${calls} across ${callMeetings} meeting${callMeetings === 1 ? '' : 's'}`,
    `Statuses still on scheduled: ${pending}`,
    `Deductions today: ${inr(total)}${deductions.length ? ` from ${deductions.length}` : ''}${byRule}`,
  ].join('\n');
}

async function summaryFor(ctx, profile, dayStartMs, dayEndMs) {
  const email = profile.email;
  const bookings = (await CampaignBookingModel.find({
    scheduledEventStartTime: { $gte: new Date(dayStartMs), $lt: new Date(dayEndMs) },
    $or: [{ 'attendanceAssignee.email': email }, { 'calendlyHost.email': email }, { 'claimedBy.email': email }],
  }).select(BOOKING_FIELDS).lean()).filter(
    (b) => getAssignedBdaEmail(b) === email && countableReason(b, profile, ctx.nowMs).countable
  );

  const atts = bookings.length
    ? await BdaAttendanceModel.find({ bdaEmail: email, bookingId: { $in: bookings.map((b) => b.bookingId) } }).select('bookingId verdict').lean()
    : [];
  const verdictOf = new Map(atts.map((a) => [a.bookingId, a.verdict]));
  let summaries = new Map();
  try {
    summaries = bookings.length ? await ctx.getCallSummaries(bookings) : new Map();
  } catch (err) {
    console.error('[DeductionEngine] daily summary: call data unavailable:', err?.message || err);
  }
  const statuses = ctx.mode === 'shadow' ? ['shadow'] : ['active', 'needs_review'];
  const deductions = await BdaDeductionModel.find({
    bdaEmail: email,
    status: { $in: statuses },
    createdAt: { $gte: new Date(dayStartMs), $lt: new Date(dayEndMs) },
  }).select('rule amountInr').lean();

  const calls = bookings.reduce((s, b) => s + (summaries.get(b.bookingId)?.calls ?? 0), 0);
  return {
    meetings: bookings.length,
    present: bookings.filter((b) => verdictOf.get(b.bookingId) === 'present').length,
    absent: bookings.filter((b) => verdictOf.get(b.bookingId) === 'absent').length,
    noVerdict: bookings.filter((b) => !verdictOf.get(b.bookingId)).length,
    calls,
    callMeetings: bookings.filter((b) => (summaries.get(b.bookingId)?.calls ?? 0) > 0).length,
    pending: bookings.filter((b) => b.bookingStatus === 'scheduled' && toMs(b.scheduledEventStartTime) < ctx.nowMs).length,
    deductions,
  };
}

/** Post today's summary once per tracked BDA after 22:00 IST. Off posts nothing. */
export async function runDailySummary(opts = {}) {
  const ctx = makeContext(opts);
  const out = { posted: 0 };
  if (!canWrite(ctx)) return { ...out, skipped: `mode_${ctx.mode}` };
  const ist = DateTime.fromMillis(ctx.nowMs, { zone: IST_ZONE });
  if (ist.hour < DEDUCTION_POLICY.dailySummaryHourIst) return { ...out, skipped: 'too_early' };

  const day = ist.toFormat('yyyy-LL-dd');
  const dayStartMs = ist.startOf('day').toMillis();
  const dayEndMs = ist.startOf('day').plus({ days: 1 }).toMillis();
  const channel = ctx.mode === 'live' ? 'deductions' : 'admin';

  for (const profile of await ctx.listTracked()) {
    const key = `${day}|${profile.email}|${channel}`;
    try {
      await BdaDeductionDigestModel.create({ key }); // claim; a duplicate key means someone already posted
    } catch (err) {
      if (err?.code === 11000) continue;
      throw err;
    }
    try {
      const s = await summaryFor(ctx, profile, dayStartMs, dayEndMs);
      const mention = channel === 'deductions' && profile.discordUserId ? `<@${profile.discordUserId}>` : null;
      const content = formatDailySummary({
        name: nameOf(profile, profile.email), mention, day, shadow: ctx.mode === 'shadow', ...s,
      });
      const res = await ctx.post({ channel, content, summary: true });
      if (res?.ok === false) {
        await BdaDeductionDigestModel.deleteOne({ key }); // nothing went out, let the next tick retry
      } else {
        out.posted += 1;
      }
    } catch (err) {
      await BdaDeductionDigestModel.deleteOne({ key });
      console.error(`[DeductionEngine] daily summary for ${profile.email} failed:`, err?.message || err);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Lifecycle: event subscriptions and the 5-minute tick
// ---------------------------------------------------------------------------------------------------------

let timer = null;
let ticking = false;
let subscriptions = [];

function subscribe(event, handler) {
  const wrapped = async (payload) => {
    try {
      await handler(payload);
    } catch (err) {
      // Logged here; the 5-minute sweep creates whatever a failed handler missed.
      console.error(`[DeductionEngine] ${event} handler failed:`, err?.message || err);
    }
  };
  attendanceEvents.on(event, wrapped);
  subscriptions.push([event, wrapped]);
}

/** Start listening to the attendance event bus and run the evaluators every 5 minutes. Idempotent. */
export function startDeductionEngine() {
  if (timer) return;
  subscribe(EVENTS.VERDICT, (p) => handleVerdict(p));
  subscribe(EVENTS.VERDICT_CORRECTED, (p) => handleVerdictCorrected(p));
  // A flagged button-only presence is never fined automatically (decision D10). An admin converts it with a reason.
  subscribe(EVENTS.INTEGRITY_FLAGGED, (p) =>
    console.log(`[DeductionEngine] integrity flag for ${p?.bookingId} (${p?.bdaEmail}), no automatic fine (D10)`)
  );

  const tick = async () => {
    if (ticking) return; // never overlap two passes in one process
    ticking = true;
    try {
      const now = new Date();
      await runDeductionEvaluators(now);
      await runDailySummary({ now });
    } catch (err) {
      console.error('[DeductionEngine] tick failed:', err?.message || err);
    } finally {
      ticking = false;
    }
  };
  // The CRM fines switch lives in the database: load it before the first tick, then keep it fresh every 30 s.
  startDeductionSettingsRefresher();
  refreshDeductionSettings().finally(tick);
  timer = setInterval(tick, getEvaluatorIntervalMs());
  console.log(`[DeductionEngine] started, mode=${getDeductionsMode()}`);
}

export function stopDeductionEngine() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  for (const [event, fn] of subscriptions) attendanceEvents.off(event, fn);
  subscriptions = [];
}

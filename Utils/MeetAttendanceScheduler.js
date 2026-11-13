import dotenv from 'dotenv';
import fs from 'node:fs';
import { DateTime } from 'luxon';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnect } from './DiscordConnect.js';
import { postAbsentChannel } from './attendanceDiscord.js';
import { countableReason, getAssignedBdaEmail, isAfterGoLive } from './BdaAssignment.js';
import {
  extractMeetCode,
  findConferenceRecords,
  hasMeetApiCredentials,
  meetClientFor,
  listParticipantsWithSessions,
  mergeParticipants,
  resolveCalendlyMeetUrl,
  resolveUserEmail,
} from './MeetApiHelper.js';
import { foldName, isNonHuman, isShared, resolveBda } from './BdaIdentity.js';
import { getAllBdaProfiles, getBdaProfile, learnGoogleUserId, logUnknownName } from './BdaRegistry.js';
import { recordPresentSignal } from './recordPresentSignal.js';
import { recordSyncError, recordSyncOk } from './SyncHealth.js';
import { classifyJoinDevice, deviceLine, loadHeartbeatsForSessions } from './JoinDevice.js';
import { doubleBookedLine, findOverlappingMeetings } from './DoubleBooking.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Meet-API attendance worker.
//
// Source of truth for BDA attendance: Google's own conference records, read
// server-side via the Meet REST API (see MeetApiHelper.js). The Chrome
// extension's DOM detection keeps running as a FALLBACK; wherever both wrote
// data, the API values win (they come from Google's servers, not the DOM).
//
// Per booking inside its live window we:
//   1. find the conference record for the booking's meet code,
//   2. list participants + sessions,
//   3. identify the assigned BDA (resolved email first, display name second),
//   4. upsert timing onto BdaAttendance: firstJoinedAt, lateByMs, sessions,
//      who was already in the call at the BDA's join,
//   5. once the conference has ended: authoritative durationMs and leftAt.
//
// This worker no longer decides absence (plan 5.4). It keeps the exact in,
// out, sessions and duration, and reports the BDA's first join as a
// `google_meet` present signal (only when the match came from a stable ID).
// The verdict job reads signals and writes present or absent. Rows are keyed
// on the ASSIGNED BDA (getAssignedBdaEmail), not on the Calendly host, so a
// reassigned meeting lands on the right person.
//
// Discord: only the "Attendance Verified" recap is sent from here. Absent
// messages belong to the verdict job.
// ---------------------------------------------------------------------------

const PRESENCE_BUFFER_MS = 60 * 1000;           // ±1 min around the scheduled window
const WINDOW_LEAD_MS = 60 * 1000;               // start polling 1 min before start
const WINDOW_GRACE_MS = 30 * 60 * 1000;         // keep polling 30 min after scheduled end
const DEFAULT_MEETING_MS = 60 * 60 * 1000;      // window when scheduledEnd is missing
const MAX_SESSION_MS = 6 * 60 * 60 * 1000;      // sanity clamp per session
// Google's numbers are final enough to report once the call (or the BDA's part of it) has been over this long. A BDA
// who rejoins inside this gap simply updates the recap; waiting for the scheduled end made the recap hours late.
const EARLY_FINALIZE_SETTLE_MS = 2 * 60 * 1000;
// Mark Present closes 60 s after start (plan 2.2). A first join later than this is "joined late".
const LATE_AFTER_START_MS = 60 * 1000;

let isRunning = false;
let disabledLogged = false;
let credsWarned = false;
let startupLogged = false;

function formatIST(date) {
  if (!date) return 'N/A';
  return DateTime.fromJSDate(new Date(date))
    .setZone('Asia/Kolkata')
    .toFormat('dd MMM yyyy, hh:mm a');
}

// One summary message per booking, sent at finalization. Live join/leave
// pings still come from the extension flow — this is the authoritative recap.
async function sendVerifiedDiscord(message) {
  const url = process.env.DISCORD_BDA_DURATION_WEBHOOK_URL || process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL || null;
  if (!url) return false;
  try {
    const res = await DiscordConnect(url, message, false);
    return Boolean(res?.ok);
  } catch (e) {
    console.error('[MeetAttendance] Discord send failed:', e?.message);
    return false;
  }
}

function punctualityLabel(lateByMs) {
  if (lateByMs == null) return null;
  if (lateByMs > 60 * 1000) return `${Math.round(lateByMs / 60000)} min late`;
  if (lateByMs < -60 * 1000) return `${Math.round(-lateByMs / 60000)} min early`;
  return 'on time';
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

/**
 * Which credential source MeetApiHelper will use: json | file | split | MISSING. Mirrors its lookup order and
 * never prints a value. Shown once at startup so a missing production key (P3) is visible in the first log lines.
 */
export function describeMeetCredentials() {
  if (!hasMeetApiCredentials()) return 'MISSING';
  try {
    const parsed = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) : null;
    if (parsed?.client_email && parsed?.private_key) return 'json';
  } catch {
    // Invalid JSON is not usable; the helper already logged it and fell through to the next source.
  }
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (keyFile && fs.existsSync(keyFile)) return 'file';
  return 'split';
}

/**
 * Match the assigned BDA among conference participants (plan 2.8).
 *   1. Directory email, then the stored googleUserId: stable IDs, allowed to decide a verdict.
 *   2. Name or alias that resolves to exactly the assigned BDA: fills in, out and time spent only.
 * A name that fits two participants (a client sharing the BDA's first name) is ambiguous, so nobody is picked.
 * Returns { participant, via, matchedBy: 'stable_id' | 'name' } or null.
 * `registry` and `resolveEmail` are injectable so tests never touch the network or the database.
 */
export async function findBdaParticipant({
  participants,
  hostEmail,
  assignedEmail = hostEmail,
  expectedNames = [],
  registry,
  resolveEmail = resolveUserEmail,
}) {
  const assigned = normEmail(assignedEmail);
  const profiles = registry || (await getAllBdaProfiles());
  const profile = profiles.find((p) => p.email === assigned) || null;

  // 1a. Directory email (works for signed-in Workspace users).
  for (const p of participants) {
    if (!p.userId) continue;
    const email = await resolveEmail({ hostEmail, userId: p.userId });
    p.resolvedEmail = email;
    if (email && email === assigned) {
      // First Directory hit teaches us the Google user ID, so later meetings match without Directory.
      if (profile && !profile.googleUserId) {
        try {
          await learnGoogleUserId(assigned, p.userId);
        } catch (err) {
          console.error('[MeetAttendance] could not learn googleUserId:', err?.message);
        }
      }
      return { participant: p, via: 'email', matchedBy: 'stable_id' };
    }
  }

  // 1b. Stored Google user ID.
  if (profile?.googleUserId) {
    const byId = participants.find((p) => p.userId && p.userId === profile.googleUserId);
    if (byId) return { participant: byId, via: 'google', matchedBy: 'stable_id' };
  }

  // 2. Name or alias. A participant Directory already tied to a different registry BDA is someone else.
  const candidates = [];
  for (const p of participants) {
    if (!p.displayName || isNonHuman(p.displayName) || isShared(p.displayName)) continue;
    // A stable ID already ties this person to a registry BDA; had it been the assigned one, step 1 returned.
    if (resolveBda({ email: p.resolvedEmail, googleUserId: p.userId }, profiles)) continue;
    if (profile) {
      const hit = resolveBda({ name: p.displayName }, profiles);
      if (hit && hit.bda.email === assigned) candidates.push({ participant: p, via: hit.via });
    } else if (expectedNames.map(foldName).includes(foldName(p.displayName))) {
      // Assigned person is not in the registry (so nothing about them is fined): keep the old exact-name rule.
      candidates.push({ participant: p, via: 'name' });
    }
  }
  if (candidates.length === 1) return { ...candidates[0], matchedBy: 'name' };
  return null;
}

function sumSessions(sessions, now) {
  let total = 0;
  for (const s of sessions) {
    if (!s.startTime) continue;
    const end = s.endTime || now; // open session counts up to "now"
    const ms = Math.min(Math.max(0, end - s.startTime), MAX_SESSION_MS);
    total += ms;
  }
  return total;
}

function overlapsWindow(sessions, windowStart, windowEnd, now) {
  return sessions.some((s) => {
    if (!s.startTime) return false;
    const end = s.endTime || now;
    return s.startTime <= windowEnd && end >= windowStart;
  });
}

/**
 * Get the booking's Meet code. Bookings created from Calendly webhooks often
 * carry only the "calendly.com/events/{id}/google_meet" join URL — the real
 * meet.google.com link is behind its 302 redirect. Resolve it once and cache
 * the code back onto the booking so every later poll is free.
 *
 * Exported: the Calendly webhook and getMyMeetings also call this so bookings
 * carry a real meet code BEFORE the meeting — the extension's tab matching
 * (and therefore live join detection at the true join moment) depends on it.
 */
export async function resolveBookingMeetCode(booking) {
  const direct = extractMeetCode(
    booking.googleMeetCode || booking.googleMeetUrl || booking.calendlyMeetLink
  );
  if (direct) return direct;

  const meetUrl = await resolveCalendlyMeetUrl(booking.calendlyMeetLink);
  const code = extractMeetCode(meetUrl);
  if (!code) return null;

  await CampaignBookingModel.updateOne(
    { bookingId: booking.bookingId },
    { $set: { googleMeetCode: code, googleMeetUrl: `https://meet.google.com/${code}` } }
  );
  console.log(`[MeetAttendance] Resolved meet code ${code} for ${booking.bookingId} via Calendly redirect`);
  return code;
}

/** Others already in the call at the BDA's first join. */
function rosterAtJoin(participants, bdaParticipant, bdaJoin) {
  if (!bdaJoin) return [];
  return participants
    .filter((p) => p !== bdaParticipant)
    .filter((p) =>
      p.sessions.some(
        (s) => s.startTime && s.startTime <= bdaJoin && (!s.endTime || s.endTime > bdaJoin)
      )
    )
    .map((p) => ({ displayName: p.displayName || 'Unknown', kind: p.kind }));
}

/**
 * `deps` is for tests only: { resolveMeetCode, findConferenceRecords, listParticipants, registry, resolveEmail,
 * recordSignal }. Every default is the real Google-backed function.
 */
/**
 * Sync one booking from Google. Returns { checked, reason }: checked is true only when Google was really asked
 * about this meeting (or already gave final numbers). The verdict job treats a meeting Google never looked at
 * (no Meet code resolved, no API client) as unverified, so its fine is needs_review, never active.
 */
export async function processBooking(booking, now, deps = {}) {
  const result = await processBookingInner(booking, now, deps);
  return result ?? { checked: true, reason: 'synced' };
}

async function processBookingInner(booking, now, deps = {}) {
  const getMeetCode = deps.resolveMeetCode || resolveBookingMeetCode;
  const findRecords = deps.findConferenceRecords || findConferenceRecords;
  const listParticipants = deps.listParticipants || listParticipantsWithSessions;
  const signal = deps.recordSignal || recordPresentSignal;

  const scheduledStart = new Date(booking.scheduledEventStartTime);
  const scheduledEnd = booking.scheduledEventEndTime
    ? new Date(booking.scheduledEventEndTime)
    : new Date(scheduledStart.getTime() + DEFAULT_MEETING_MS);

  // The BDA this meeting belongs to (admin reassignment, then Calendly host, then CRM claim). The attendance row
  // is keyed on it. Google is still asked as the original organizer, because reassigning a meeting for leave cover
  // does not move the Meet space to the covering BDA.
  const assignedEmail = getAssignedBdaEmail(booking);
  if (!assignedEmail) return { checked: false, reason: 'unassigned' }; // absent scheduler alerts unassigned meetings
  const hostEmail = normEmail(booking.calendlyHost?.email || booking.claimedBy?.email) || assignedEmail;

  // Skip if already finalized from the API (check before the Calendly
  // redirect so finalized bookings cost nothing).
  const existing = await BdaAttendanceModel.findOne({
    bookingId: booking.bookingId,
    bdaEmail: assignedEmail,
  });
  // Finalized AFTER the scheduled end is final. Finalized earlier (call over, BDA done) stays open until the slot
  // ends, because the BDA may rejoin; the recap is then re-sent as an update (see the recap block below).
  if (existing?.meetApiFinalizedAt && new Date(existing.meetApiFinalizedAt).getTime() > scheduledEnd.getTime()) {
    return { checked: true, reason: 'finalized' };
  }

  // Discord posts from here are only for meetings the verdict job also judges: assigned to a TRACKED BDA, not on
  // leave, not canceled, and started after tracking began. Otherwise an untracked host (the shared FLASHFIRE account,
  // someone not in the registry) or an old meeting would get alerts the rest of the system says should not exist.
  // Row timing (in, out, duration) is still written for everyone.
  const profile = await (deps.getProfile || getBdaProfile)(assignedEmail);
  const alertable =
    countableReason(booking, profile, now.getTime()).countable &&
    (deps.ignoreGoLive || isAfterGoLive(profile, scheduledStart.getTime()));

  const meetCode = await getMeetCode(booking);
  if (!meetCode) return { checked: false, reason: 'no_meet_code' };
  // findConferenceRecords answers [] when it has no API client, which would look like "no conference happened".
  if (!deps.findConferenceRecords && !meetClientFor(hostEmail)) return { checked: false, reason: 'no_api_client' };

  // One booking can span SEVERAL conference records on the same code
  // ("end call for everyone" + rejoin starts a new record) — take them all
  // and merge each person's sessions across records.
  const records = await findRecords({
    hostEmail,
    meetCode,
    scheduledStart,
    windowEnd: new Date(scheduledEnd.getTime() + WINDOW_GRACE_MS),
  });
  if (records.length === 0) return { checked: true, reason: 'no_conference' }; // Google answered: nobody joined yet

  const perRecord = [];
  for (const r of records) {
    perRecord.push(
      ...(await listParticipants({
        hostEmail,
        conferenceRecordName: r.name,
      }))
    );
  }
  const participants = mergeParticipants(perRecord);
  if (participants.length === 0) return { checked: true, reason: 'no_participants' };

  const record = records[records.length - 1]; // latest — drives ended/reference

  const expectedNames = [
    booking.attendanceAssignee?.name,
    booking.calendlyHost?.name,
    booking.claimedBy?.name,
  ].filter(Boolean);

  const match = await findBdaParticipant({
    participants,
    hostEmail,
    assignedEmail,
    expectedNames,
    registry: deps.registry,
    resolveEmail: deps.resolveEmail,
  });
  const bda = match?.participant || null;

  // Finalize only when every record has ended AND the scheduled slot is over
  // (an early "ended" mid-slot could miss a rejoin that starts a new record),
  // or unconditionally once the grace window is exhausted.
  const allEnded = records.every((r) => Boolean(r.endTime));
  const pastGrace = now.getTime() > scheduledEnd.getTime() + WINDOW_GRACE_MS;
  // Report as soon as Google's data is settled instead of waiting for the scheduled end: the whole call has been
  // over for a couple of minutes, or the BDA left (all their sessions ended) a couple of minutes ago.
  const settledFor = (endTime) => {
    const t = endTime ? new Date(endTime).getTime() : 0;
    return t > 0 && now.getTime() - t >= EARLY_FINALIZE_SETTLE_MS;
  };
  const lastRecordEnd = records.reduce((m, r) => Math.max(m, r.endTime ? new Date(r.endTime).getTime() : 0), 0);
  const bdaDone = Boolean(bda && bda.sessions?.length && bda.sessions.every((s) => s.endTime) && settledFor(bda.latestEndTime));
  const finalize =
    (allEnded && now.getTime() > scheduledEnd.getTime()) || pastGrace || (allEnded && settledFor(lastRecordEnd)) || bdaDone;

  const windowStart = new Date(scheduledStart.getTime() - PRESENCE_BUFFER_MS);
  const windowEnd = new Date(scheduledEnd.getTime() + PRESENCE_BUFFER_MS);

  const base = {
    bdaName:
      (booking.attendanceAssignee?.email ? booking.attendanceAssignee?.name : null) ||
      booking.calendlyHost?.name ||
      booking.claimedBy?.name ||
      assignedEmail,
    bdaEmail: assignedEmail,
    bookingId: booking.bookingId,
    meetLink: booking.googleMeetUrl || booking.calendlyMeetLink || null,
    meetingScheduledStart: scheduledStart,
    meetingScheduledEnd: booking.scheduledEventEndTime || null,
    conferenceRecordName: record.name,
    meetApiSyncedAt: now,
  };

  if (bda) {
    const firstJoin = bda.earliestStartTime;
    const present = overlapsWindow(bda.sessions, windowStart, windowEnd, now);
    const durationMs = sumSessions(bda.sessions, now);

    const set = {
      ...base,
      firstJoinedAt: firstJoin,
      lateByMs: firstJoin ? firstJoin.getTime() - scheduledStart.getTime() : null,
      sessions: bda.sessions.map((s) => ({
        startTime: s.startTime,
        endTime: s.endTime,
        durationMs: s.startTime
          ? Math.min(Math.max(0, (s.endTime || now) - s.startTime), MAX_SESSION_MS)
          : 0,
      })),
      participantsAtJoin: rosterAtJoin(participants, bda, firstJoin),
      source: 'meet_api',
      // 'stable_id' (Directory email or Google user ID) or 'name'. Only a stable match may decide a verdict;
      // a name match still fills in, out and time spent, and the CRM shows it as "matched by name".
      matchedBy: match.matchedBy,
      // 'signedin' | 'anonymous' | 'phone'. 'phone' is a dial-in; it drives the join-device answer.
      googleParticipantKind: bda.kind || null,
    };

    // Which device (pc / mobile / dial-in / unknown), from Google's sessions plus the extension's heartbeats in
    // that time (Utils/JoinDevice.js). Display only: it never decides a verdict or a fine.
    try {
      const rowForDevice = { ...(existing?.toObject ? existing.toObject() : existing || {}), ...set };
      const logs = await (deps.loadHeartbeats || loadHeartbeatsForSessions)(assignedEmail, rowForDevice, now.getTime());
      const device = classifyJoinDevice({ row: rowForDevice, meetCode, logs, nowMs: now.getTime() });
      set.joinDevice = device.device;
      set.joinDeviceReason = device.reason;
    } catch (err) {
      console.warn(`[MeetAttendance] join device check failed for ${booking.bookingId}: ${err?.message}`);
    }

    if (present && (!existing || !['manual', 'absent'].includes(existing.status))) {
      set.status = 'present';
    }

    if (finalize) {
      set.durationMs = durationMs;
      set.leftAt = bda.latestEndTime || null;
      set.meetApiFinalizedAt = now;
    }

    // status is required on insert — default to present-window verdict.
    if (!set.status && !existing) set.status = present ? 'present' : 'unmarked';

    await BdaAttendanceModel.findOneAndUpdate(
      { bookingId: booking.bookingId, bdaEmail: assignedEmail },
      {
        $set: set,
        $setOnInsert: {
          attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          markedAt: now,
        },
      },
      { upsert: true, new: true }
    );

    // The BDA's first join, as a present signal with Google's exact time. A name match is display only, so only a
    // stable-ID match is reported. A late first join is stored too but does not count toward the window, and a join
    // that was in time but arrives after an absent verdict triggers the late-evidence correction.
    if (match.matchedBy === 'stable_id' && firstJoin) {
      try {
        await signal({
          bookingId: booking.bookingId,
          bdaEmail: assignedEmail,
          bdaName: set.bdaName,
          kind: 'google_meet',
          eventAt: firstJoin,
          matchedBy: 'stable_id',
        });
      } catch (err) {
        console.error(`[MeetAttendance] could not record google_meet signal for ${booking.bookingId}:`, err?.message);
      }
    }

    // Google-verified messages, sent as soon as the data is settled (see `finalize` above).
    if (finalize) {
      const late = punctualityLabel(set.lateByMs);
      const roster = (set.participantsAtJoin || []).map((p) => p.displayName).join(', ');
      const durationMs = set.durationMs || 0;

      // 1) The recap. Sent once; if the BDA rejoined afterwards and the total moved by a minute or more, sent
      //    again as an update so the channel always ends on the right numbers.
      const sentBefore = Boolean(existing?.verifiedRecapSentAt);
      const moved = Math.abs(durationMs - (existing?.verifiedRecapDurationMs ?? 0)) >= 60 * 1000;
      if (alertable && (!sentBefore || moved)) {
        const sent = await sendVerifiedDiscord(
          `${sentBefore ? '🔄 **Attendance Verified (updated): Google Meet records**' : '📋 **Attendance Verified: Google Meet records**'}\n` +
          `**BDA:** ${set.bdaName} (${assignedEmail})\n` +
          `**Client:** ${booking.clientName || 'Unknown'}\n` +
          `**In:** ${formatIST(firstJoin)}${late ? ` (${late})` : ''}\n` +
          `**Out:** ${formatIST(set.leftAt)}\n` +
          `**Duration (total):** ${Math.round(durationMs / 60000)} min\n` +
          deviceLine(set.joinDevice) +
          `**In call when BDA joined:** ${roster || 'nobody (BDA was first)'}`
        );
        // Only record it as sent when Discord took it, so a failed send is retried on the next pass.
        if (sent) {
          await BdaAttendanceModel.updateOne(
            { bookingId: booking.bookingId, bdaEmail: assignedEmail },
            { $set: { verifiedRecapSentAt: now, verifiedRecapDurationMs: durationMs } }
          );
        }
      }

      // 2) Joined, but after the Mark Present window closed. The verdict job already told the channel "absent"
      //    at start + 60 s; this confirms it from Google's exact join time. Skipped when the BDA was marked present
      //    in time by a button or the extension (the verdict is then present).
      const joinedLate = firstJoin && firstJoin.getTime() > scheduledStart.getTime() + LATE_AFTER_START_MS;
      // Needs the verdict job's absent verdict first (written at start + 60 s, only for judged BDAs): a Google record
      // alone, for example the client sitting in the room before the start, must never produce an absent alert.
      if (alertable && joinedLate && existing?.verdict === 'absent' && !existing?.verifiedAbsentNotifiedAt) {
        const posted = await postAbsentChannel(
          `🚫 **BDA Absent: verified from Google Meet records**\n` +
          `**BDA:** ${set.bdaName} (${assignedEmail})\n` +
          `**Client:** ${booking.clientName || 'Unknown'}\n` +
          `**Meeting:** ${formatIST(scheduledStart)}\n` +
          `**Joined At:** ${formatIST(firstJoin)}${late ? ` (${late})` : ''}\n` +
          `_The BDA joined, but after the Mark Present window closed (1 min after the start)._`
        );
        if (posted) {
          await BdaAttendanceModel.updateOne(
            { bookingId: booking.bookingId, bdaEmail: assignedEmail },
            { $set: { verifiedAbsentNotifiedAt: now } }
          );
        }
      }
    }
    return;
  }

  // BDA not identified among participants.
  if (finalize) {
    // Show an admin which names failed to resolve, so a missing alias is one click away (plan 2.8).
    const profiles = await getAllBdaProfiles();
    for (const p of participants.slice(0, 20)) {
      if (p.kind === 'phone' || !p.displayName) continue;
      if (resolveBda({ email: p.resolvedEmail, googleUserId: p.userId, name: p.displayName }, profiles)) continue;
      await logUnknownName({ name: p.displayName, source: 'google_meet', ref: booking.bookingId });
    }

    // Canceled booking + BDA not in the call = nothing to record.
    if (booking.bookingStatus === 'canceled') return;
    // The extension fallback may already prove presence (identity match can fail if the BDA joined signed-out;
    // the DOM detection is authoritative for "was there"). Keep it and just mark the Google data final.
    if (existing && ['present', 'manual'].includes(existing.status)) {
      await BdaAttendanceModel.updateOne(
        { _id: existing._id },
        {
          $set: {
            conferenceRecordName: record.name,
            meetApiSyncedAt: now,
            meetApiFinalizedAt: now,
            notes: `${existing.notes || ''} [meet_api: could not identify BDA among ${participants.length} participants — extension presence kept]`.trim(),
          },
        }
      );
      return;
    }

    // The meeting ran and nobody matched the assigned BDA. Keep who WAS in the call for the CRM, but do not decide
    // anything: the verdict job turns "no signal in time" into absent, and the row stays 'unmarked' until then.
    await BdaAttendanceModel.findOneAndUpdate(
      { bookingId: booking.bookingId, bdaEmail: assignedEmail },
      {
        $set: {
          ...base,
          source: 'meet_api',
          participantsAtJoin: participants.map((p) => ({
            displayName: p.displayName || 'Unknown',
            kind: p.kind,
          })),
          meetApiFinalizedAt: now,
          notes: `Conference happened (${participants.length} participant(s)) but the assigned BDA was not identified among them`,
        },
        $setOnInsert: {
          attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          status: 'unmarked',
          markedAt: now,
        },
      },
      { upsert: true, new: true }
    );

    // Google confirms the call ran without the assigned BDA in it. Posted once per booking; the verdict job
    // already announced the absence at start + 60 s, this is the verification. Not for canceled bookings, and not
    // when a button or the extension had the BDA present in time.
    if (alertable && existing?.verdict === 'absent' && !existing?.verifiedAbsentNotifiedAt) {
      const whoWasThere = participants.map((p) => p.displayName || 'Unknown').join(', ');
      // Say WHY when we can: a BDA in another meeting at the same time (double-booked) is a scheduling problem.
      let doubleBooked = '';
      try {
        doubleBooked = doubleBookedLine(await findOverlappingMeetings(booking, assignedEmail, { nowMs: now.getTime() }), (t) => formatIST(t));
      } catch (err) {
        console.warn(`[MeetAttendance] double-booking check failed for ${booking.bookingId}: ${err?.message}`);
      }
      const posted = await postAbsentChannel(
        `🚫 **BDA Absent: verified from Google Meet records**\n` +
        `**BDA:** ${base.bdaName} (${assignedEmail})\n` +
        `**Client:** ${booking.clientName || 'Unknown'}\n` +
        `**Meeting:** ${formatIST(scheduledStart)}\n` +
        `**Who was in the call:** ${whoWasThere}\n` +
        doubleBooked +
        `_The meeting ran, but the assigned BDA never joined._`
      );
      if (posted) {
        await BdaAttendanceModel.updateOne(
          { bookingId: booking.bookingId, bdaEmail: assignedEmail },
          { $set: { verifiedAbsentNotifiedAt: now } }
        );
      }
    }
  }
}

function meetApiEnabled() {
  return String(process.env.MEET_API_ATTENDANCE_ENABLED || '').trim().toLowerCase() !== 'false';
}

/**
 * Sync one booking from Google's live conference records right now. The
 * absent poller calls this before posting "No Response", so a BDA who is in
 * the call but whose extension missed the join (other Chrome profile, logged
 * out, phone) is marked present instead of getting a false alert.
 * Never throws; a Meet API failure must not block the alert path.
 */
export async function syncBookingFromMeetNow(booking) {
  if (!meetApiEnabled() || !hasMeetApiCredentials()) return { checked: false, reason: 'disabled' };
  try {
    const result = await processBooking(booking, new Date());
    await recordSyncOk('google_meet');
    return result;
  } catch (err) {
    console.warn(`[MeetAttendance] live check failed for ${booking?.bookingId}: ${err?.message}`);
    await recordSyncError('google_meet', err);
    return { checked: false, reason: 'error' };
  }
}

export async function pollMeetApiAttendance() {
  // On by default: Google's conference records are the only source that
  // catches joins the extension missed. Opt out with MEET_API_ATTENDANCE_ENABLED=false.
  if (!meetApiEnabled()) {
    if (!disabledLogged) {
      console.log('[MeetAttendance] Disabled by MEET_API_ATTENDANCE_ENABLED=false');
      disabledLogged = true;
    }
    return;
  }
  if (!startupLogged) {
    startupLogged = true;
    console.log(`[MeetAttendance] enabled, credentials: ${describeMeetCredentials()}`);
  }
  if (!hasMeetApiCredentials()) {
    // Visible on the health screen as an error with a stale lastOkAt, which is the P3 symptom (plan 1.2).
    await recordSyncError('google_meet', 'No Google credentials configured');
    if (!credsWarned) {
      console.warn('[MeetAttendance] No Google credentials (GOOGLE_SERVICE_ACCOUNT_KEY_JSON, GOOGLE_SERVICE_ACCOUNT_KEY_FILE, or GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY) — attendance is NOT being verified against Google Meet');
      credsWarned = true;
    }
    return;
  }
  if (isRunning) return;
  isRunning = true;

  try {
    const now = new Date();
    // Live window: from 1 min before start until 30 min past scheduled end
    // (bounded below by a 3 h lookback so long-dead bookings are never scanned).
    const lookback = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const lead = new Date(now.getTime() + WINDOW_LEAD_MS);

    // 'canceled' included on purpose: a Calendly reschedule/cancel can land
    // after the meeting already happened on that link — attendance still
    // counts. Canceled bookings are present-only (never auto-absent, see
    // processBooking) since not joining a canceled meeting is correct.
    const bookings = await CampaignBookingModel.find({
      bookingStatus: { $in: ['scheduled', 'completed', 'canceled', 'paid', 'no-show'] },
      scheduledEventStartTime: { $gte: lookback, $lte: lead },
    })
      .select(
        'bookingId clientName bookingStatus scheduledEventStartTime scheduledEventEndTime googleMeetCode googleMeetUrl calendlyMeetLink calendlyHost claimedBy attendanceAssignee'
      )
      .lean();

    let lastBookingError = null;
    for (const booking of bookings) {
      try {
        await processBooking(booking, now);
      } catch (err) {
        lastBookingError = err;
        // 403 here means DWD scopes not authorized yet — actionable, so say so.
        const status = err?.response?.status || err?.code;
        const hint = status === 403 ? ' (DWD scopes not authorized in Admin console?)' : '';
        console.error(
          `[MeetAttendance] ${booking.bookingId} failed: ${err?.message}${hint}`
        );
      }
    }
    // A cycle counts as healthy only when no booking failed in it.
    if (lastBookingError) await recordSyncError('google_meet', lastBookingError);
    else await recordSyncOk('google_meet');
  } catch (error) {
    console.error('[MeetAttendance] Poll error:', error.message);
    await recordSyncError('google_meet', error);
  } finally {
    isRunning = false;
  }
}

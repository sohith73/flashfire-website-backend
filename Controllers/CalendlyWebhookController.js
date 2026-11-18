import { Logger } from '../Utils/Logger.js';
import { marketFromUtmContent } from '../Utils/leadMarket.js';
import { sendNoShowReminder } from '../Utils/WatiHelper.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';
import { UserModel } from '../Schema_Models/User.js';
import { DiscordConnect, DiscordConnectForMeet } from '../Utils/DiscordConnect.js';
import { cancelCall, scheduleCall } from '../Utils/CallScheduler.js';
import { cancelWhatsAppReminder } from '../Utils/WhatsAppReminderScheduler.js';
import {
  extractCalendlyPhoneFromPayload,
  extractCalendlyPhoneFromInvitee,
  normalizePhoneForReminders,
  parseMeetingStartToDate,
} from '../Utils/MeetingReminderUtils.js';
import { cancelDiscordMeetRemindersForMeeting, scheduleDiscordMeetReminder } from '../Utils/DiscordMeetReminderScheduler.js';
import { getRescheduleLinkForBooking, resolveCalendlyHost } from '../Utils/CalendlyAPIHelper.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { withMongoRetry } from '../Utils/withMongoRetry.js';

/**
 * One-line "Assigned BDA" label for Discord messages. Prefers the Calendly
 * round-robin host (who the meeting is assigned to); falls back to a manual CRM
 * claim, then to "Not assigned".
 */
function assignedBdaLabel(booking) {
  return (
    booking?.calendlyHost?.name ||
    booking?.calendlyHost?.email ||
    booking?.claimedBy?.name ||
    booking?.claimedBy?.email ||
    'Not assigned'
  );
}
import { triggerWorkflow, cancelScheduledWorkflows, cancelNotScheduledWorkflowsForClient } from './WorkflowController.js';
import { normalizePhoneForMatching } from '../Utils/normalizePhoneForMatching.js';
import { DateTime } from 'luxon';
import crypto from 'crypto';
import { logReminderError } from '../Schema_Models/ReminderError.js';
import { CalendlyWebhookDedupeModel } from '../Schema_Models/CalendlyWebhookDedupe.js';
import { CalendlyWebhookLogModel } from '../Schema_Models/CalendlyWebhookLog.js';
import { validatePostMeetingBookingStatus } from '../Utils/meetingStatusEligibility.js';
import { CALENDLY_ACTOR, statusChangeSet, statusHistoryPush } from '../Utils/statusHistoryOps.js';

/** Compare stored Date / ISO string to Calendly start_time (same instant within 2 min). */
function sameScheduledInstant(stored, isoFromPayload) {
  if (stored == null || isoFromPayload == null) return false;
  const a = stored instanceof Date ? stored.getTime() : new Date(stored).getTime();
  const b = new Date(isoFromPayload).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < 120000;
}

// In-memory cache for Discord duplication check
const discordMessageCache = new Map();

/**
 * Check if a Discord message is a duplicate based on booking details
 * @param {Object} details 
 * @returns {boolean}
 */
function isDuplicateDiscord(details) {
  try {
    const uniqueString = `${details["Invitee Email"]}-${details["Meeting Time (Team India)"]}-${details["Booked At"]}`;
    const hash = crypto.createHash('md5').update(uniqueString).digest('hex');

    if (discordMessageCache.has(hash)) {
      const timestamp = discordMessageCache.get(hash);
      if (Date.now() - timestamp < 10 * 60 * 1000) { // 10 minutes cache
        return true;
      }
    }

    discordMessageCache.set(hash, Date.now());

    // Cleanup cache occasionally
    if (discordMessageCache.size > 1000) {
      for (const [key, time] of discordMessageCache.entries()) {
        if (Date.now() - time > 10 * 60 * 1000) {
          discordMessageCache.delete(key);
        }
      }
    }

    return false;
  } catch (err) {
    console.error('Error in isDuplicateDiscord:', err);
    return false;
  }
}

/**
 * Handle Calendly webhook events
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handleCalendlyWebhook = async (req, res) => {
  try {
    const { event, created_at, payload } = req.body;

    Logger.info('Received Calendly webhook', {
      event,
      created_at,
      payload: payload ? {
        uri: payload.uri,
        name: payload.name,
        email: payload.email,
        status: payload.status
      } : null
    });

    if (event === 'invitee.created') {
      return await handleCreatedEvent(req, res, payload);
    }

    // Handle invitee.rescheduled events
    if (event === 'invitee.rescheduled') {
      return await handleRescheduledEvent(req, res, payload);
    }

    if (event === 'invitee.canceled') {
      return await handleCanceledEvent(req, res, payload);
    }

    // Only handle invitee_no_show events
    if (event === 'invitee_no_show') {
      return await handleNoShowEvent(req, res, payload);
    }

    Logger.info(`Ignoring Calendly event: ${event}`);
    return res.status(200).json({
      success: true,
      message: `Event ${event} received but not processed`
    });

  } catch (error) {
    Logger.error('Error processing Calendly webhook', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    // Best-effort alert so the team still hears about a booking even when the
    // DB write itself failed (e.g. transient Mongo timeout) — a failure here
    // must never mask the original error response below. Posted to the same
    // channel as successful bookings (#new-meetings-calendly) so failures are
    // visible right next to normal booking activity.
    if (process.env.DISCORD_MEET_WEB_HOOK_URL) {
      const payload = req.body?.payload;
      const inviteeName = payload?.invitee?.name || payload?.name || 'Unknown';
      const inviteeEmail = payload?.invitee?.email || payload?.email || 'Unknown';
      const meetingStart = payload?.scheduled_event?.start_time || 'Unknown';
      DiscordConnectForMeet(
        `⚠️ Calendly webhook processing FAILED (${error.message}). Booking may be missing from DB — please check manually.\nName: ${inviteeName}\nEmail: ${inviteeEmail}\nMeeting start: ${meetingStart}`
      ).catch(discordErr => Logger.warn('Failed to send webhook-failure Discord alert', { error: discordErr.message }));
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error processing webhook'
    });
  }
};

/**
 * Handle invitee.created events
 */
async function handleCreatedEvent(req, res, payload) {
  Logger.info('Calendly payload received (invitee.created)');

  const inviteeName = payload?.invitee?.name || payload?.name;
  const inviteeEmail = payload?.invitee?.email || payload?.email;
  let inviteePhone = extractCalendlyPhoneFromPayload(payload);

  const meetingStart = parseMeetingStartToDate(payload?.scheduled_event?.start_time);

  if (!meetingStart || isNaN(meetingStart.getTime())) {
    Logger.error('Invalid meeting start time received from Calendly', {
      startTime: payload?.scheduled_event?.start_time,
      inviteeEmail
    });
    return res.status(400).json({
      error: 'Invalid meeting start time',
      message: 'Could not parse meeting start time from Calendly webhook'
    });
  }

  const delay = meetingStart.getTime() - Date.now() - (10 * 60 * 1000);

  const callExecutionTime = new Date(Date.now() + delay);
  const meetingTimeFormatted = meetingStart.toISOString();
  const callTimeFormatted = callExecutionTime.toISOString();

  Logger.info('📅 Meeting scheduled - calculating call delay', {
    inviteeName,
    inviteeEmail,
    meetingStart: meetingTimeFormatted,
    currentTime: new Date().toISOString(),
    delayMs: delay,
    delayMinutes: Math.round(delay / 60000),
    callWillExecuteAt: callTimeFormatted,
    callWillExecuteInMinutes: Math.round(delay / 60000)
  });

  if (delay < 0) {
    const minutesUntilMeeting = Math.round(-delay / 60000);
    Logger.warn('⚠️ Meeting is too soon to schedule calls - skipping reminder', {
      inviteeName,
      inviteeEmail,
      meetingStart: meetingTimeFormatted,
      delayMs: delay,
      meetingInMinutes: minutesUntilMeeting
    });
    // Use optional chaining for environment variable in case it's not set
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `⚠️ Meeting too soon for reminder call: ${inviteeName || 'Unknown'} (${inviteeEmail || 'Unknown'}). Meeting in ${minutesUntilMeeting} minutes.`
      );
    }
  }

  const rawStartTime = payload?.scheduled_event?.start_time;
  const meetingStartUTC = DateTime.fromISO(rawStartTime, { zone: 'utc' });

  // Determine invitee timezone (from Calendly webhook) if available
  const inviteeTimezone = payload?.invitee?.timezone || payload?.timezone || null;

  // Use the invitee's timezone for the client-facing time (PST/ET/etc).
  // Fallback to America/Los_Angeles (PST/PDT) if Calendly doesn't send a timezone.
  const clientZone = inviteeTimezone || 'America/Los_Angeles';

  // Guard against invalid DateTime — prevents "Invalid DateTime" in Discord/WhatsApp messages
  // Append timezone abbreviation so the team can see which timezone the client is in
  let meetingTimeUS = meetingStartUTC.isValid
    ? meetingStartUTC.setZone(clientZone).toFormat('ff') + ' ' + meetingStartUTC.setZone(clientZone).toFormat('ZZZZ')
    : `Unknown (raw: ${rawStartTime || 'null'})`;
  let meetingTimeIndia = meetingStartUTC.isValid
    ? meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff') + ' IST'
    : `Unknown (raw: ${rawStartTime || 'null'})`;
  const meetLink = payload?.scheduled_event?.location?.join_url || 'Not Provided';
  const bookedAt = new Date(payload?.created_at || new Date()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  // Pin the FIRST BDA a lead is ever assigned to, so credit survives a rebooking.
  //
  // Calendly round-robins again whenever a client cancels and books a new slot, so
  // calendlyHost legitimately changes to whoever hosts the new meeting. Attribution
  // must not follow it: the BDA who worked the lead first keeps it. Returns an empty
  // patch when the lead already has an owner, which is what makes this write-once.
  const firstBdaPatch = (existing, host) => {
    if (!host?.email) return {};
    if (existing?.originalBda?.email) return {};
    return {
      originalBda: {
        email: host.email,
        name: host.name || null,
        calendlyUserUri: host.calendlyUserUri || null,
        source: 'calendly',
        assignedAt: new Date(),
      },
    };
  };

  // Resolve the Calendly round-robin host (the BDA this meeting is assigned to) and
  // match it to a CRM user by email so downstream views can show "Assigned BDA".
  let calendlyHost = null;
  try {
    const host = await resolveCalendlyHost(payload);
    if (host?.email) {
      const crmUser = await CrmUserModel.findOne({ email: host.email }).select('name email').lean();
      calendlyHost = {
        email: host.email,
        name: crmUser?.name || host.name || null,
        calendlyUserUri: host.calendlyUserUri || null,
        matchedCrmUser: Boolean(crmUser),
      };
      Logger.info('📌 Calendly host resolved for booking', {
        hostEmail: calendlyHost.email,
        matchedCrmUser: calendlyHost.matchedCrmUser,
        inviteeEmail,
      });
    }
  } catch (hostErr) {
    Logger.warn('Failed to resolve Calendly host', { error: hostErr.message, inviteeEmail });
  }
  const bdaEmailForNotification = calendlyHost?.email || 'Not assigned';

  // invitee.created puts the invitee URI at payload.uri — there is no payload.invitee
  // object on this event, so every payload.invitee.uri read here resolved to null.
  // That silently disabled webhook-log dedupe, the Calendly API fallback below, and
  // the strongest duplicate-booking key.
  const inviteeUri = payload?.invitee?.uri || payload?.uri || null;

  // Store raw webhook payload for debugging/audit (fire-and-forget)
  const webhookLogId = inviteeUri
    ? `wh_${crypto.createHash('md5').update(inviteeUri + (rawStartTime || '')).digest('hex')}`
    : `wh_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  CalendlyWebhookLogModel.create({
    webhookId: webhookLogId,
    eventType: 'invitee.created',
    payload: { ...payload },
  }).catch(err => Logger.warn('Failed to store webhook log', { error: err.message }));

  // Extract and log reschedule link
  let rescheduleLink = payload?.reschedule_url || null;
  // Calendly sends cancel_url beside reschedule_url on every invitee.created. Same
  // invitee uuid, under /cancellations/ instead of /reschedulings/. Drives the
  // "Cancel" button on flashfire_appointment_reminder_rc.
  const cancelLink = payload?.cancel_url || null;

  Logger.info('Reschedule link from invitee.created webhook', {
    rescheduleLink,
    hasRescheduleLink: !!rescheduleLink,
    topLevelRescheduleUrl: payload?.reschedule_url,
    hasCancelLink: !!cancelLink,
    inviteeUri
  });

  // If reschedule link is not in webhook, try fetching from Calendly API
  if (!rescheduleLink && inviteeUri) {
    try {
      const { fetchRescheduleLinkFromCalendly } = await import('../Utils/CalendlyAPIHelper.js');
      const fetchedLink = await fetchRescheduleLinkFromCalendly(inviteeUri);
      if (fetchedLink) {
        rescheduleLink = fetchedLink;
        console.log('✅ [Calendly Webhook] Fetched reschedule link from Calendly API:', rescheduleLink);
      }
    } catch (error) {
      console.warn('⚠️ [Calendly Webhook] Could not fetch reschedule link from API:', error.message);
    }
  }

  // Extract UTM parameters
  const utmSource = payload?.tracking?.utm_source || 'direct';
  const utmMedium = payload?.tracking?.utm_medium || null;
  const utmCampaign = payload?.tracking?.utm_campaign || null;
  const utmContent = payload?.tracking?.utm_content || null;
  const utmTerm = payload?.tracking?.utm_term || null;

  const anythingToKnow = payload?.questions_and_answers?.find(q =>
    q.question.toLowerCase().includes('anything') ||
    q.question.toLowerCase().includes('prepare')
  )?.answer || null;

  const scheduledStartISO = payload?.scheduled_event?.start_time;

  // DUPLICATE CHECK (include Calendly invitee URI — unique per scheduled invite)
  const duplicateOr = [
    inviteeUri ? { calendlyInviteeUri: inviteeUri } : null,
    { clientEmail: inviteeEmail },
    inviteePhone ? { clientPhone: inviteePhone } : null,
    meetLink && meetLink !== 'Not Provided' ? { calendlyMeetLink: meetLink } : null,
  ].filter(Boolean);

  const duplicateQuery = {
    scheduledEventStartTime: scheduledStartISO,
    $or: duplicateOr,
  };
  let existingBooking = await withMongoRetry(() => CampaignBookingModel.findOne(duplicateQuery));

  // Same invitee URI already stored = Calendly retry/duplicate delivery, UNLESS the
  // stored record is a placeholder from the frontend's early booking capture (fires on
  // the client-side calendly.event_scheduled event, before this webhook lands, with no
  // scheduledEventStartTime yet — which is why `duplicateQuery` above, keyed on that
  // field, misses it and `existingBooking` comes back null even though the row exists).
  // Treating that placeholder as a real duplicate here meant this webhook returned early
  // and never wrote the invitee's actual name/email/phone/meeting time into it — silently
  // dropping the booking (and any reminder/workflow keyed off it) even though the row
  // existed in the DB the whole time. Route it into the same merge path as any other
  // existing booking instead of bailing out.
  if (inviteeUri) {
    const uriAlready = await withMongoRetry(() => CampaignBookingModel.findOne({ calendlyInviteeUri: inviteeUri }));
    const isPlaceholder = uriAlready && (
      uriAlready.clientName === 'Unknown Client' ||
      /^unknown_\d+@calendly\.placeholder$/.test(uriAlready.clientEmail || '')
    );
    if (uriAlready && !isPlaceholder) {
      Logger.warn('Duplicate invitee.created — calendlyInviteeUri already in DB', { inviteeUri });
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: 'Duplicate webhook (invitee uri already processed)',
      });
    }
    if (isPlaceholder && !existingBooking) {
      existingBooking = uriAlready;
    }
  }

  const emailsMatch =
    inviteeEmail &&
    existingBooking &&
    String(inviteeEmail).trim().toLowerCase() === String(existingBooking.clientEmail || '').trim().toLowerCase();

  const existingIsPlaceholder = !!existingBooking && (
    existingBooking.clientName === 'Unknown Client' ||
    /^unknown_\d+@calendly\.placeholder$/.test(existingBooking.clientEmail || '')
  );

  /**
   * Frontend capture often saves first without calendlyInviteeUri; merge webhook instead
   * of skipping Discord. A placeholder capture (no real email yet, so `emailsMatch` can't
   * apply) matched by calendlyInviteeUri above also belongs here — that's the record this
   * webhook's real name/email/phone/meeting time need to land in.
   */
  const mergedFromFrontendCapture =
    !!existingBooking &&
    !!inviteeUri &&
    (
      existingIsPlaceholder ||
      (!existingBooking.calendlyInviteeUri && !!emailsMatch && sameScheduledInstant(existingBooking.scheduledEventStartTime, scheduledStartISO))
    );

  /**
   * Cancel + rebook: client cancelled the original event and re-booked the same slot,
   * so Calendly sent invitee.canceled (which nuked our reminders) followed by a fresh
   * invitee.created carrying a new scheduled_event.uri / invitee.uri. Same email + same
   * start time still matches `duplicateQuery`, but this is NOT a duplicate — the stored
   * calendlyEventUri points at the cancelled event and the booking has no live reminders.
   * Detect by comparing incoming URIs to what we have and re-merge so reminders reschedule.
   */
  const incomingEventUri = payload?.scheduled_event?.uri || null;
  const rebookedSameSlot =
    !!existingBooking &&
    !mergedFromFrontendCapture &&
    !!emailsMatch &&
    sameScheduledInstant(existingBooking.scheduledEventStartTime, scheduledStartISO) &&
    (
      (!!inviteeUri && existingBooking.calendlyInviteeUri && inviteeUri !== existingBooking.calendlyInviteeUri) ||
      (!!incomingEventUri && existingBooking.calendlyEventUri && incomingEventUri !== existingBooking.calendlyEventUri)
    );

  if (rebookedSameSlot) {
    Logger.info('Cancel+rebook at same slot — merging new Calendly event onto existing booking so reminders reschedule', {
      email: inviteeEmail,
      existingBookingId: existingBooking.bookingId,
      storedEventUri: existingBooking.calendlyEventUri,
      incomingEventUri,
      storedInviteeUri: existingBooking.calendlyInviteeUri,
      incomingInviteeUri: inviteeUri,
    });
  }

  const shouldMergeIntoExisting = mergedFromFrontendCapture || rebookedSameSlot;

  if (existingBooking && !shouldMergeIntoExisting) {
    Logger.warn('🔄 Duplicate booking detected - already exists in database', {
      email: inviteeEmail,
      phone: inviteePhone,
      meetLink,
      existingBookingId: existingBooking.bookingId,
      existingTime: existingBooking.scheduledEventStartTime
    });
    return res.status(200).json({
      message: 'Duplicate booking detected and suppressed',
      duplicate: true,
      existingBookingId: existingBooking.bookingId
    });
  }

  let calendlyDedupeKey = null;
  if (inviteeUri) {
    calendlyDedupeKey = `invitee.created:${inviteeUri}`;
    try {
      await withMongoRetry(() => CalendlyWebhookDedupeModel.create({ key: calendlyDedupeKey }));
    } catch (e) {
      if (e.code === 11000) {
        Logger.warn('Calendly invitee.created duplicate delivery suppressed', { inviteeUri });
        return res.status(200).json({
          success: true,
          duplicate: true,
          message: 'Duplicate webhook delivery suppressed (invitee uri)',
        });
      }
      throw e;
    }
  }

  let newBooking = null;
  if (shouldMergeIntoExisting) {
    newBooking = await withMongoRetry(() => CampaignBookingModel.findOneAndUpdate(
      { bookingId: existingBooking.bookingId },
      {
        $set: {
          calendlyEventUri: payload?.scheduled_event?.uri || null,
          calendlyInviteeUri: inviteeUri,
          calendlyMeetLink: meetLink,
          calendlyRescheduleLink: rescheduleLink || null,
          calendlyCancelLink: cancelLink || null,
          scheduledEventStartTime: payload?.scheduled_event?.start_time ?? existingBooking.scheduledEventStartTime,
          scheduledEventEndTime: payload?.scheduled_event?.end_time ?? null,
          inviteeTimezone: inviteeTimezone || null,
          anythingToKnow: anythingToKnow ?? existingBooking.anythingToKnow,
          questionsAndAnswers: payload?.questions_and_answers ?? existingBooking.questionsAndAnswers,
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip || req.connection.remoteAddress,
          clientPhone: inviteePhone || existingBooking.clientPhone,
          clientName: inviteeName || existingBooking.clientName,
          clientEmail: inviteeEmail
            ? String(inviteeEmail).trim().toLowerCase()
            : existingBooking.clientEmail,
          utmSource: utmSource || existingBooking.utmSource,
          utmMedium: utmMedium ?? existingBooking.utmMedium,
          utmCampaign: utmCampaign ?? existingBooking.utmCampaign,
          utmContent: utmContent ?? existingBooking.utmContent,
          utmTerm: utmTerm ?? existingBooking.utmTerm,
          ...(!existingBooking.leadMarket && marketFromUtmContent(utmContent) ? { leadMarket: marketFromUtmContent(utmContent) } : {}),
          bookingStatus: 'scheduled',
          ...statusChangeSet(existingBooking.bookingStatus, 'scheduled', CALENDLY_ACTOR),
          ...(calendlyHost ? { calendlyHost } : {}),
          ...firstBdaPatch(existingBooking, calendlyHost),
        },
        ...statusHistoryPush(existingBooking.bookingStatus, 'scheduled', CALENDLY_ACTOR),
      },
      { new: true }
    ));
    Logger.info(
      rebookedSameSlot
        ? '✅ Merged Calendly invitee.created into existing booking (cancel+rebook)'
        : '✅ Merged Calendly invitee.created into existing booking (frontend capture)',
      { bookingId: newBooking?.bookingId, inviteeUri, rebookedSameSlot }
    );
    if (!newBooking) {
      return res.status(500).json({ success: false, error: 'Failed to merge Calendly data into booking' });
    }
  }

  try {
  if (!shouldMergeIntoExisting) {
  // META LEAD SYNC: Check if there's an existing meta lead with 'not-scheduled' status
  // matching by email or phone (without country code). If found, upgrade it to 'scheduled'
  // and merge Calendly booking data into it instead of creating a new booking.
  const normalizedPhone = normalizePhoneForMatching(inviteePhone);
  const metaSyncConditions = [{ clientEmail: inviteeEmail.trim().toLowerCase() }];
  if (normalizedPhone) {
    metaSyncConditions.push({ normalizedClientPhone: normalizedPhone });
    metaSyncConditions.push({ clientPhone: { $regex: normalizedPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' } });
  }

  const existingMetaLead = await CampaignBookingModel.findOne({
    bookingStatus: 'not-scheduled',
    leadSource: 'meta_lead_ad',
    $or: metaSyncConditions
  }).sort({ bookingCreatedAt: -1 });

  if (existingMetaLead) {
    Logger.info('🔗 Meta lead sync: upgrading not-scheduled meta lead to scheduled', {
      metaBookingId: existingMetaLead.bookingId,
      email: inviteeEmail
    });

    // Cancel any 'not-scheduled' workflows before status change
    try {
      await cancelScheduledWorkflows(existingMetaLead.bookingId, 'scheduled', 'not-scheduled');
    } catch (cancelErr) {
      Logger.warn('Failed to cancel not-scheduled workflows during meta sync', { error: cancelErr.message });
    }

    // Merge Calendly data into the existing meta lead and set status to scheduled (keep normalizedClientPhone in sync)
    const mergedPhone = inviteePhone || existingMetaLead.clientPhone;
    const mergedBooking = await CampaignBookingModel.findOneAndUpdate(
      { bookingId: existingMetaLead.bookingId },
      {
        $set: {
          bookingStatus: 'scheduled',
          ...statusChangeSet(existingMetaLead.bookingStatus, 'scheduled', CALENDLY_ACTOR),
          clientName: inviteeName || existingMetaLead.clientName,
          clientPhone: mergedPhone || existingMetaLead.clientPhone,
          normalizedClientPhone: normalizePhoneForMatching(mergedPhone) || null,
          calendlyEventUri: payload?.scheduled_event?.uri || null,
          calendlyInviteeUri: inviteeUri,
          calendlyMeetLink: meetLink || null,
          calendlyRescheduleLink: rescheduleLink || null,
          calendlyCancelLink: cancelLink || null,
          scheduledEventStartTime: payload?.scheduled_event?.start_time || null,
          scheduledEventEndTime: payload?.scheduled_event?.end_time || null,
          inviteeTimezone: inviteeTimezone || null,
          anythingToKnow: anythingToKnow || existingMetaLead.anythingToKnow,
          questionsAndAnswers: payload?.questions_and_answers || null,
          userAgent: req.headers['user-agent'],
          ipAddress: req.ip || req.connection.remoteAddress,
          ...(calendlyHost ? { calendlyHost } : {}),
          ...firstBdaPatch(existingMetaLead, calendlyHost)
        },
        ...statusHistoryPush(existingMetaLead.bookingStatus, 'scheduled', CALENDLY_ACTOR),
      },
      { new: true }
    );

    Logger.info('✅ Meta lead synced to scheduled', {
      bookingId: mergedBooking.bookingId,
      clientEmail: mergedBooking.clientEmail,
      metaLeadId: mergedBooking.metaLeadId
    });

    // Mark user as booked
    try {
      const escapedEmail = inviteeEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await UserModel.updateOne(
        { email: { $regex: new RegExp(`^${escapedEmail}$`, 'i') } },
        { $set: { booked: true } }
      );
    } catch (userUpdateError) {
      Logger.warn('Failed to update user booked status during meta sync', { error: userUpdateError.message });
    }

    // ── Schedule reminders for meta-lead-synced bookings ──
    // Previously this path returned early without scheduling any reminders.
    // Now we schedule Discord meet reminders, calls, and WhatsApp reminders
    // exactly like the normal booking path.

    const metaPhone = inviteePhone || mergedBooking.clientPhone;
    const startISO = payload?.scheduled_event?.start_time;
    const metaMeetLink = meetLink && meetLink !== 'Not Provided' ? meetLink : null;
    let metaReminderResults = { discord: null, call: null };

    // 1. Schedule Discord "meeting in ~5 minutes" reminder
    try {
      if (startISO) {
        await scheduleDiscordMeetReminder({
          bookingId: mergedBooking.bookingId,
          clientName: inviteeName || mergedBooking.clientName || 'Valued Client',
          clientEmail: inviteeEmail || null,
          meetingStartISO: startISO,
          meetingLink: metaMeetLink,
          inviteeTimezone,
          source: 'calendly_meta_sync',
          metadata: {
            campaignId: mergedBooking.campaignId,
            utmSource: mergedBooking.utmSource,
          },
        });
        metaReminderResults.discord = 'scheduled';
      }
    } catch (discordReminderError) {
      Logger.warn('Failed to schedule Discord meet reminder for meta-synced booking', {
        error: discordReminderError.message,
        bookingId: mergedBooking.bookingId,
      });
      logReminderError({
        bookingId: mergedBooking.bookingId, clientEmail: inviteeEmail, clientPhone: metaPhone,
        clientName: inviteeName, category: 'discord', severity: 'error',
        message: 'Failed to schedule Discord meet reminder for meta-synced booking: ' + discordReminderError.message,
        source: 'CalendlyWebhookController.handleCreatedEvent.metaSync'
      });
    }

    // 2. Send Discord notification about the booking
    const metaBookingDetails = {
      "Booking ID": mergedBooking.bookingId,
      "Campaign ID": mergedBooking.campaignId || 'N/A',
      "Invitee Name": inviteeName,
      "Invitee Email": inviteeEmail,
      "Invitee Phone": metaPhone || 'Not Provided',
      "Google Meet Link": meetLink,
      "Reschedule Link": rescheduleLink || 'Not Provided',
      "Meeting Time (Client)": meetingTimeUS,
      "Meeting Time (Team India)": meetingTimeIndia,
      "Client Timezone": inviteeTimezone || 'Not provided by Calendly',
      "Booked At": bookedAt,
      "UTM Source": mergedBooking.utmSource || utmSource,
      "Lead Source": 'meta_lead_ad (synced)',
      "BDA Email": bdaEmailForNotification,
      "Assigned BDA": calendlyHost?.name || (calendlyHost?.email ? calendlyHost.email : 'Not assigned'),
      "Database Status": "\u2705 META SYNCED \u2192 SCHEDULED"
    };

    if (!isDuplicateDiscord(metaBookingDetails)) {
      try {
        await DiscordConnectForMeet(JSON.stringify(metaBookingDetails, null, 2));
      } catch (discordErr) {
        Logger.warn('Failed to send Discord booking notification for meta-synced booking', { error: discordErr.message });
      }
    }

    // 3. Schedule call + WhatsApp reminders (if valid phone and meeting is far enough)
    const phoneRegex = /^\+?[1-9]\d{9,14}$/;
    if (metaPhone && phoneRegex.test(metaPhone) && delay > 0) {
      try {
        let rescheduleLinkForReminder = mergedBooking.calendlyRescheduleLink || rescheduleLink;
        if (!rescheduleLinkForReminder && mergedBooking.calendlyInviteeUri) {
          try {
            const fetchedLink = await getRescheduleLinkForBooking(mergedBooking);
            if (fetchedLink) rescheduleLinkForReminder = fetchedLink;
          } catch (err) {
            Logger.warn('Could not fetch reschedule link for meta-synced booking', { error: err.message });
          }
        }
        if (!rescheduleLinkForReminder) {
          rescheduleLinkForReminder = 'https://calendly.com/flashfirejobs';
        }

        const mongoResult = await scheduleCall({
          phoneNumber: metaPhone,
          meetingStartISO: startISO,
          meetingTime: meetingTimeUS,
          inviteeName: inviteeName || mergedBooking.clientName,
          inviteeEmail,
          source: 'calendly_meta_sync',
          meetingLink: metaMeetLink,
          rescheduleLink: rescheduleLinkForReminder,
          metadata: {
            bookingId: mergedBooking.bookingId,
            eventUri: payload?.scheduled_event?.uri,
            inviteeTimezone: inviteeTimezone,
            meetingTimeIndia,
            meetingEndISO: payload?.scheduled_event?.end_time || null,
          }
        });

        if (mongoResult.success) {
          Logger.info('✅ Call + WhatsApp reminders scheduled for meta-synced booking', {
            callId: mongoResult.callId,
            bookingId: mergedBooking.bookingId,
          });
          metaReminderResults.call = mongoResult.callId;

          await CampaignBookingModel.findOneAndUpdate(
            { bookingId: mergedBooking.bookingId },
            { reminderCallJobId: mongoResult.callId }
          );
        } else {
          Logger.warn('Failed to schedule call for meta-synced booking', { error: mongoResult.error });
        }
      } catch (callError) {
        Logger.warn('Error scheduling call for meta-synced booking', { error: callError.message });
        logReminderError({
          bookingId: mergedBooking.bookingId, clientEmail: inviteeEmail, clientPhone: metaPhone,
          clientName: inviteeName, category: 'call', severity: 'error',
          message: 'Failed to schedule call for meta-synced booking: ' + callError.message,
          source: 'CalendlyWebhookController.handleCreatedEvent.metaSync'
        });
      }
    } else if (delay <= 0) {
      Logger.warn('Meeting too soon to schedule call for meta-synced booking', {
        bookingId: mergedBooking.bookingId,
        delayMs: delay,
      });
      if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
        const minutesUntilMeeting = Math.round(-delay / 60000);
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
          `⚠️ Meta-synced meeting too soon for reminder call: ${inviteeName || 'Unknown'} (${inviteeEmail || 'Unknown'}). Meeting in ${minutesUntilMeeting} minutes.`
        );
      }
    }

    // 4. Trigger workflows for the new 'scheduled' status
    try {
      await triggerWorkflow(mergedBooking.bookingId, 'scheduled');
      Logger.info('✅ Workflows triggered for meta-synced booking', { bookingId: mergedBooking.bookingId });
    } catch (workflowError) {
      Logger.warn('Failed to trigger workflows for meta-synced booking', { error: workflowError.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Meta lead synced and upgraded to scheduled',
      bookingId: mergedBooking.bookingId,
      metaSynced: true,
      reminders: metaReminderResults
    });
  }
  } // end if (!shouldMergeIntoExisting) — meta lead sync

  // Find campaign by UTM source
  let campaignId = null;
  if (!shouldMergeIntoExisting) {
  let campaign = await CampaignModel.findOne({ utmSource });

  if (campaign) {
    campaignId = campaign.campaignId;
    Logger.info('✅ Campaign found for booking', { campaignId, utmSource });
  } else {
    // Only warn if tracking is expected
    if (utmSource !== 'direct' && utmSource !== 'webpage_visit') {
      Logger.warn('⚠️ No campaign found for UTM source - Creating virtual campaign', { utmSource });

      try {
        const virtualCampaign = new CampaignModel({
          campaignName: utmSource,
          utmSource: utmSource,
          utmMedium: utmMedium || 'direct',
          utmCampaign: utmCampaign || 'calendly_direct',
          generatedUrl: `https://calendly.com/feedback-flashfire/15min?utm_source=${utmSource}&utm_medium=${utmMedium || 'direct'}`,
          baseUrl: 'https://calendly.com/feedback-flashfire/15min',
          isActive: true
        });

        await virtualCampaign.save();
        campaignId = virtualCampaign.campaignId;

        Logger.info('✅ Virtual campaign created', {
          campaignId,
          utmSource,
          campaignName: virtualCampaign.campaignName
        });
      } catch (error) {
        Logger.error('❌ Failed to create virtual campaign', { error: error.message, utmSource });
      }
    }
  }

  // Create booking object
  newBooking = new CampaignBookingModel({
    campaignId,
    utmSource: utmSource || 'direct',
    utmMedium,
    utmCampaign,
    utmContent,
    utmTerm,
    leadMarket: marketFromUtmContent(utmContent),
    clientName: inviteeName,
    clientEmail: inviteeEmail,
    clientPhone: inviteePhone,
    calendlyEventUri: payload?.scheduled_event?.uri,
    calendlyInviteeUri: inviteeUri,
    calendlyMeetLink: meetLink,
    calendlyRescheduleLink: rescheduleLink, // ✅ Save reschedule link
    calendlyCancelLink: cancelLink,
    scheduledEventStartTime: payload?.scheduled_event?.start_time,
    scheduledEventEndTime: payload?.scheduled_event?.end_time,
    inviteeTimezone: inviteeTimezone, // ✅ Save invitee timezone from webhook
    anythingToKnow,
    questionsAndAnswers: payload?.questions_and_answers,
    visitorId: null,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip || req.connection.remoteAddress,
    bookingStatus: 'scheduled',
    ...(calendlyHost ? { calendlyHost } : {}),
    ...firstBdaPatch(null, calendlyHost)
  });

  await withMongoRetry(() => newBooking.save());

  // Resolve the real meet.google.com code behind Calendly's join_url redirect
  // NOW, so the extension can match the Meet tab the moment the BDA joins
  // (without a code, live join detection can't attribute the tab to a booking
  // and the join time falls back to the ~5-min recovery check — wrong by
  // minutes). Fire-and-forget: must never delay or fail the webhook.
  import('../Utils/MeetAttendanceScheduler.js')
    .then(({ resolveBookingMeetCode }) => resolveBookingMeetCode(newBooking))
    .catch((e) => Logger.warn('Meet code resolution failed (will retry lazily)', { error: e?.message }));
  } // end if (!shouldMergeIntoExisting) — campaign + new booking

  // The lead-form record for this client is a separate not-scheduled booking (different
  // bookingId, often a different email), so its queued "you have not booked" nudges
  // would keep firing. Cancel them now; the send-time guard in cronScheduler is the backstop.
  try {
    const stop = await cancelNotScheduledWorkflowsForClient(
      inviteeEmail, inviteePhone || newBooking?.clientPhone, newBooking?.bookingId
    );
    if (stop.cancelledBookings > 0) {
      Logger.info('Cancelled not-scheduled workflows on sibling lead records', {
        bookingId: newBooking?.bookingId, siblings: stop.cancelledBookings,
      });
    }
  } catch (siblingCancelErr) {
    Logger.warn('Failed to cancel sibling not-scheduled workflows', { error: siblingCancelErr.message });
  }

  // Mark user as booked
  try {
    const escapedEmail = inviteeEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await UserModel.updateOne(
      { email: { $regex: new RegExp(`^${escapedEmail}$`, 'i') } },
      { $set: { booked: true } }
    );
    Logger.info('✅ User marked as booked:', { email: inviteeEmail });
  } catch (userUpdateError) {
    Logger.warn('⚠️ Failed to update user booked status:', {
      email: inviteeEmail,
      error: userUpdateError.message
    });
  }

  Logger.info('✅ Booking saved', {
    bookingId: newBooking.bookingId,
    campaignId: newBooking.campaignId,
    utmSource: newBooking.utmSource,
    clientName: newBooking.clientName,
    clientEmail: newBooking.clientEmail,
    clientPhone: newBooking.clientPhone,
    calendlyMeetLink: newBooking.calendlyMeetLink,
    googleMeetUrl: newBooking.googleMeetUrl || null,
    rescheduleLink: newBooking.calendlyRescheduleLink
  });

  // Send Facebook Conversion API event (non-blocking)
  try {
    const { sendScheduleEvent } = await import('../Services/FacebookConversionAPI.js');
    sendScheduleEvent({
      email: inviteeEmail,
      phone: inviteePhone,
      fullName: inviteeName,
      clientIp: req.ip || req.connection.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmContent: utmContent || null,
      utmTerm: utmTerm || null,
      eventId: newBooking.bookingId, // Use bookingId for deduplication
      eventSourceUrl: 'https://www.flashfirejobs.com/meeting-booked',
    }).catch((error) => {
      // Log but don't fail the webhook if Conversion API fails
      Logger.warn('⚠️ Facebook Conversion API call failed (non-critical):', error.message);
    });
  } catch (importError) {
    Logger.warn('⚠️ Failed to import Facebook Conversion API service:', importError.message);
  }

  // Send LinkedIn Conversion API event (non-blocking)
  // Server-side tracking bypasses ad blockers and works regardless of browser settings
  try {
    const { sendScheduleEvent: sendLinkedInScheduleEvent } = await import('../Services/LinkedInConversionAPI.js');
    sendLinkedInScheduleEvent({
      email: inviteeEmail,
      phone: inviteePhone,
      fullName: inviteeName,
      clientIp: req.ip || req.connection.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmContent: utmContent || null,
      utmTerm: utmTerm || null,
      eventId: newBooking.bookingId, // Use bookingId for deduplication
      eventSourceUrl: 'https://www.flashfirejobs.com/meeting-booked',
    }).catch((error) => {
      // Log but don't fail the webhook if Conversion API fails
      Logger.warn('⚠️ LinkedIn Conversion API call failed (non-critical):', error.message);
    });
  } catch (importError) {
    Logger.warn('⚠️ Failed to import LinkedIn Conversion API service:', importError.message);
  }

  // Recompute times if webhook missed start_time — use saved booking record as source of truth
  if (!meetingStartUTC.isValid && newBooking?.scheduledEventStartTime) {
    const fallbackUTC = DateTime.fromJSDate(
      new Date(newBooking.scheduledEventStartTime), { zone: 'utc' }
    );
    if (fallbackUTC.isValid) {
      const effectiveZone = inviteeTimezone || newBooking.inviteeTimezone || 'America/Los_Angeles';
      meetingTimeUS    = fallbackUTC.setZone(effectiveZone).toFormat('ff') + ' ' + fallbackUTC.setZone(effectiveZone).toFormat('ZZZZ');
      meetingTimeIndia = fallbackUTC.setZone('Asia/Kolkata').toFormat('ff') + ' IST';
    }
  }

  // Prepare booking details for Discord
  const bookingDetails = {
    "Booking ID": newBooking.bookingId,
    "Campaign ID": newBooking.campaignId || 'N/A',
    "Invitee Name": inviteeName,
    "Invitee Email": inviteeEmail,
    "Invitee Phone": inviteePhone || 'Not Provided',
    "Google Meet Link": meetLink,
    "Real Google Meet Link": newBooking.googleMeetUrl || meetLink,
    "Reschedule Link": rescheduleLink || 'Not Provided',
    "Meeting Time (Client)": meetingTimeUS,
    "Meeting Time (Team India)": meetingTimeIndia,
    "Client Timezone": inviteeTimezone || 'Not provided by Calendly',
    "Booked At": bookedAt,
    "UTM Source": utmSource,
    "UTM Medium": utmMedium || 'N/A',
    "UTM Campaign": utmCampaign || 'N/A',
    "BDA Email": bdaEmailForNotification,
    "Assigned BDA": calendlyHost?.name || (calendlyHost?.email ? calendlyHost.email : 'Not assigned'),
    "Database Status": "\u2705 SAVED"
  };

  // Update webhook log with resolved bookingId
  if (newBooking?.bookingId) {
    CalendlyWebhookLogModel.updateOne(
      { webhookId: webhookLogId },
      { $set: { bookingId: newBooking.bookingId } }
    ).catch(() => {});
  }

  if (payload?.tracking?.utm_source !== 'webpage_visit' && payload?.tracking?.utm_source !== null && payload?.tracking?.utm_source !== 'direct') {
    try {
      const utmData = {
        clientName: inviteeName,
        clientEmail: inviteeEmail,
        clientPhone: inviteePhone || 'Not Provided',
        utmSource: payload?.tracking?.utm_source,
      };
      // Note: Assuming global fetch is available (Node 18+)
      await fetch('https://clients-tracking-backend.onrender.com/api/track/utm-campaign-lead', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(utmData)
      });
      console.log('✅ UTM campaign lead tracked to external service:', utmData);
    } catch (utmError) {
      Logger.error('Failed to track UTM lead', { error: utmError.message });
    }
  }

  Logger.info('New Calendly booking', bookingDetails);

  if (!isDuplicateDiscord(bookingDetails)) {
    await DiscordConnectForMeet(JSON.stringify(bookingDetails, null, 2));
  } else {
    Logger.warn('Duplicate Discord message suppressed (fingerprint match)', {
      inviteeEmail,
      inviteePhone,
      scheduledStartISO
    });
  }

  // Schedule Discord "meeting in 2 minutes" reminder
  try {
    const startISO = payload?.scheduled_event?.start_time;
    if (startISO) {
      await scheduleDiscordMeetReminder({
        bookingId: newBooking.bookingId,
        clientName: inviteeName || 'Valued Client',
        clientEmail: inviteeEmail || null,
        meetingStartISO: startISO,
        meetingLink: meetLink && meetLink !== 'Not Provided' ? meetLink : null,
        inviteeTimezone,
        source: 'calendly',
        metadata: {
          campaignId: newBooking.campaignId,
          utmSource: newBooking.utmSource,
        },
      });
    } else {
      Logger.warn('No scheduled_event.start_time found in Calendly payload for Discord reminder');
    }
  } catch (discordReminderError) {
    Logger.warn('Failed to schedule Discord 2-minute meeting reminder', {
      error: discordReminderError.message,
      inviteeEmail,
    });
  }

  // Validate phone numbers
  const phoneRegex = /^\+?[1-9]\d{9,14}$/;
  let scheduledJobs = [];

  // Schedule call if delay is positive
  if (inviteePhone && phoneRegex.test(inviteePhone) && delay > 0) {
    const meetingLink = meetLink && meetLink !== 'Not Provided' ? meetLink : null;
    let rescheduleLinkForReminder = newBooking?.calendlyRescheduleLink || rescheduleLink;

    if (!rescheduleLinkForReminder && newBooking?.calendlyInviteeUri) {
      try {
        const fetchedLink = await getRescheduleLinkForBooking(newBooking);
        if (fetchedLink) {
          rescheduleLinkForReminder = fetchedLink;
          console.log('✅ [Calendly Webhook] Fetched reschedule link for reminder from API:', rescheduleLinkForReminder);
        }
      } catch (error) {
        console.warn('⚠️ [Calendly Webhook] Could not fetch reschedule link for reminder:', error.message);
      }
    }

    // Fallback to default
    if (!rescheduleLinkForReminder) {
      rescheduleLinkForReminder = 'https://calendly.com/flashfirejobs';
      Logger.warn('Using default reschedule link - Calendly did not provide one', {
        bookingId: newBooking.bookingId
      });
    }

    const meetingEndTime = payload?.scheduled_event?.end_time || null;

    const mongoResult = await scheduleCall({
      phoneNumber: inviteePhone,
      meetingStartISO: payload?.scheduled_event?.start_time,
      meetingTime: meetingTimeUS,
      inviteeName,
      inviteeEmail,
      source: 'calendly',
      meetingLink: meetingLink,
      rescheduleLink: rescheduleLinkForReminder,
      metadata: {
        bookingId: newBooking?.bookingId,
        eventUri: payload?.scheduled_event?.uri,
        inviteeTimezone: inviteeTimezone,
        meetingTimeIndia,
        meetingEndISO: meetingEndTime
      }
    });

    if (mongoResult.success) {
      console.log('✅ [MongoDB Scheduler] Call scheduled successfully:', mongoResult.callId);
      scheduledJobs.push(`Client: ${inviteePhone} (MongoDB)`);

      // Update booking with call ID
      if (newBooking?.bookingId) {
        await CampaignBookingModel.findOneAndUpdate(
          { bookingId: newBooking.bookingId },
          { reminderCallJobId: mongoResult.callId }
        );
      }
    } else {
      console.warn('⚠️ [MongoDB Scheduler] Failed to schedule:', mongoResult.error);
    }

    // Single Discord post for reminder-call success (was two back-to-back posts to the same webhook)
    const reminderWebhook = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
    if (reminderWebhook) {
      const scheduledMessage =
        `📞 **Reminder Call Scheduled!**\n• MongoDB Call ID: ${mongoResult.callId}\n• Client: ${inviteeName} (${inviteePhone})\n• Meeting (Client): ${meetingTimeUS}\n• Meeting (India): ${meetingTimeIndia}\n• Reschedule Link: ${rescheduleLinkForReminder}\n• Reminder: 10 minutes before meeting\n• Scheduled: ${scheduledJobs.join(', ')}`;
      await DiscordConnect(reminderWebhook, scheduledMessage);
    } else {
      Logger.warn('Discord webhook URL not configured');
    }

    // WhatsApp reminders are scheduled internally by scheduleCall() above

    return res.status(200).json({
      message: 'Webhook received & calls scheduled',
      bookingDetails,
      scheduledCalls: scheduledJobs,
      rescheduleLink: rescheduleLink || 'Not provided by Calendly'
    });
  } else if (delay <= 0) {
    Logger.warn('Skipping call scheduling - meeting too soon or invalid phone', {
      phone: inviteePhone,
      delayMs: delay,
      hasValidPhone: inviteePhone && phoneRegex.test(inviteePhone)
    });
    return res.status(200).json({ message: 'Meeting too soon or invalid phone, booking saved but no call scheduled.' });
  } else {
    Logger.warn('No valid phone number provided by invitee', { phone: inviteePhone });
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `⚠ No valid phone for client: ${inviteeName} (${inviteeEmail}) — Got: ${inviteePhone}`
      );
    }
    return res.status(200).json({ message: 'No valid phone, booking saved.' });
  }
  } catch (err) {
    if (calendlyDedupeKey) {
      await CalendlyWebhookDedupeModel.deleteOne({ key: calendlyDedupeKey }).catch(() => {});
    }
    throw err;
  }
}

/**
 * Handle invitee_no_show events
 */
async function handleNoShowEvent(req, res, payload) {
  // Extract booking information from webhook payload
  const { invitee, event: calendlyEvent, questions_and_answers } = payload;

  if (!invitee || !invitee.email) {
    Logger.error('Invalid webhook payload: missing invitee information');
    return res.status(400).json({
      success: false,
      error: 'Missing invitee information in webhook payload'
    });
  }

  // Extract client information
  const clientEmail = invitee.email;
  const clientName = invitee.name || 'Valued Client';
  const clientPhone = invitee.phone_number || null;

  const rescheduleUrl = payload?.reschedule_url || invitee.reschedule_url || null;

  Logger.info('Extracted reschedule URL from no-show webhook', {
    rescheduleUrl,
    clientEmail,
    hasRescheduleUrl: !!rescheduleUrl,
    topLevelRescheduleUrl: payload?.reschedule_url,
    nestedRescheduleUrl: invitee.reschedule_url
  });

  // Get UTM parameters from questions and answers
  let utmSource = null;
  let utmMedium = null;

  if (questions_and_answers && Array.isArray(questions_and_answers)) {
    questions_and_answers.forEach(qa => {
      if (qa.question && qa.answer) {
        if (qa.question.toLowerCase().includes('utm_source') || qa.question.toLowerCase().includes('source')) {
          utmSource = qa.answer;
        }
        if (qa.question.toLowerCase().includes('utm_medium') || qa.question.toLowerCase().includes('medium')) {
          utmMedium = qa.answer;
        }
      }
    });
  }

  // Try to find the booking in our database
  // FIX: Use better lookup if possible
  let bookingRecord = null;
  try {
    const query = { clientEmail: clientEmail };
    if (calendlyEvent && calendlyEvent.uri) {
      // Ideally match by Event URI if stored
      // But we check by StartTime logic mostly.
      // Here we keep existing logic but prefer StartTime match if available
    }

    // Default to existing logic for now for no-shows, but be careful
    bookingRecord = await CampaignBookingModel.findOne({
      clientEmail: clientEmail,
      $or: [
        { utmSource: utmSource },
        { calendlyMeetLink: { $exists: true, $ne: null } }
      ]
    }).sort({ bookingCreatedAt: -1 }).limit(1);

    if (!bookingRecord && utmSource) {
      bookingRecord = await CampaignBookingModel.findOne({
        utmSource: utmSource
      }).sort({ bookingCreatedAt: -1 }).limit(1);
    }
  } catch (dbError) {
    Logger.error('Database error while finding booking record', {
      error: dbError.message,
      clientEmail,
      utmSource
    });
  }

  // Prepare booking data for WhatsApp message
  const bookingData = {
    clientName,
    clientEmail,
    clientPhone: clientPhone || bookingRecord?.clientPhone,
    bookingCreatedAt: bookingRecord?.bookingCreatedAt || new Date(),
    calendlyMeetLink: bookingRecord?.calendlyMeetLink || calendlyEvent?.uri,
    rescheduleUrl: rescheduleUrl || bookingRecord?.calendlyRescheduleLink || null,
    utmSource: utmSource || bookingRecord?.utmSource,
    utmMedium: utmMedium || bookingRecord?.utmMedium,
    bookingId: bookingRecord?._id || null
  };

  Logger.info('Prepared booking data for WhatsApp', {
    clientName,
    clientEmail,
    hasRescheduleUrl: !!bookingData.rescheduleUrl,
    rescheduleUrl: bookingData.rescheduleUrl
  });

  const noShowEligibility = bookingRecord
    ? validatePostMeetingBookingStatus(bookingRecord.scheduledEventStartTime, 'no-show')
    : { ok: true };
  const allowNoShowSideEffects = !bookingRecord || noShowEligibility.ok;

  // Send Discord notification
  try {
    if (allowNoShowSideEffects) {
      await DiscordConnectForMeet(`🚨 No-Show Alert: ${clientName} (${clientEmail}) missed their meeting. Assigned BDA: ${assignedBdaLabel(bookingRecord)}. UTM Source: ${bookingData.utmSource || 'Unknown'}`);
    } else {
      await DiscordConnectForMeet(
        `⚠ Calendly invitee_no_show for ${clientName} (${clientEmail}) — CRM status not updated (${noShowEligibility.message}). Assigned BDA: ${assignedBdaLabel(bookingRecord)}. UTM: ${bookingData.utmSource || 'Unknown'}`
      );
      Logger.warn('Calendly no-show webhook: skipped notifications and DB update until meeting + 5m', {
        clientEmail,
        bookingId: bookingRecord?.bookingId,
        scheduledEventStartTime: bookingRecord?.scheduledEventStartTime,
      });
    }
  } catch (discordError) {
    Logger.error('Failed to send Discord notification', { error: discordError.message });
  }

  // Send WhatsApp message if phone number is available (only when eligible — same rule as CRM status)
  let whatsappSent = false;
  if (allowNoShowSideEffects && bookingData.clientPhone) {
    const whatsappResult = await sendNoShowReminder(bookingData);

    if (whatsappResult.success) {
      whatsappSent = true;
      Logger.info('No-show reminder sent successfully via WhatsApp', {
        clientName,
        clientPhone: bookingData.clientPhone,
        bookingId: bookingData.bookingId
      });
    } else {
      Logger.error('Failed to send no-show reminder via WhatsApp', {
        error: whatsappResult.error,
        clientName,
        clientPhone: bookingData.clientPhone
      });
    }
  } else if (!allowNoShowSideEffects) {
    Logger.warn('Skipped no-show WhatsApp: meeting not past grace window', { clientEmail });
  } else {
    Logger.warn('No phone number available for WhatsApp reminder', {
      clientName,
      clientEmail,
      bookingId: bookingData.bookingId
    });
  }

  // Update booking record if found
  if (bookingRecord) {
    try {
      if (!noShowEligibility.ok) {
        Logger.info('No-show webhook: booking matched but not persisting status yet', {
          bookingId: bookingRecord.bookingId,
          clientEmail,
        });
      } else {
        bookingRecord._statusActor = { source: 'calendly', name: 'Calendly', email: 'calendly_webhook', previousStatus: bookingRecord.bookingStatus };
        bookingRecord.bookingStatus = 'no-show';
        bookingRecord.statusChangedAt = new Date();
        bookingRecord.statusChangeSource = 'calendly';
        bookingRecord.statusChangedBy = 'calendly_webhook';
        bookingRecord.noShowDate = new Date();
        bookingRecord.noShowProcessed = true;
        bookingRecord.whatsappReminderSent = whatsappSent;
        if (whatsappSent) {
          bookingRecord.whatsappSentAt = new Date();
        }
        // Update reschedule URL if we got it from webhook and it's not already saved
        if (rescheduleUrl && !bookingRecord.calendlyRescheduleLink) {
          bookingRecord.calendlyRescheduleLink = rescheduleUrl;
          Logger.info('Updated booking record with reschedule URL from webhook', {
            bookingId: bookingRecord._id,
            rescheduleUrl
          });
        }
        await bookingRecord.save();

        Logger.info('Updated booking record with no-show status', {
          bookingId: bookingRecord._id,
          clientEmail,
          whatsappSent
        });
      }
    } catch (updateError) {
      Logger.error('Failed to update booking record', {
        error: updateError.message,
        bookingId: bookingRecord._id
      });
    }
  }

  res.status(200).json({
    success: true,
    message: 'No-show event processed successfully',
    data: {
      clientName,
      clientEmail,
      whatsappSent: whatsappSent,
      phoneAvailable: !!bookingData.clientPhone,
      bookingUpdated: !!bookingRecord,
      utmSource: bookingData.utmSource,
      rescheduleUrl: bookingData.rescheduleUrl
    }
  });
}

/**
 * Test webhook endpoint
 */
export const testWebhook = async (req, res) => {
  try {
    const { sendWhatsApp } = req.query;

    const testData = {
      clientName: 'Test User',
      clientEmail: 'test@example.com',
      clientPhone: sendWhatsApp === 'true' ? '+1234567890' : null,
      bookingCreatedAt: new Date(),
      calendlyMeetLink: 'https://calendly.com/test',
      rescheduleUrl: 'https://calendly.com/reschedulings/test-reschedule-url',
      utmSource: 'test_source',
      utmMedium: 'test_medium'
    };

    let whatsappResult = null;
    if (sendWhatsApp === 'true') {
      whatsappResult = await sendNoShowReminder(testData);
    }

    res.status(200).json({
      success: true,
      message: 'Webhook test completed',
      data: {
        testData,
        whatsappResult
      }
    });

  } catch (error) {
    Logger.error('Error in webhook test', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      error: 'Webhook test failed'
    });
  }
};

async function handleRescheduledEvent(req, res, payload) {
  try {
    // Audit trail — mirror invitee.created path so reschedules are visible in CalendlyWebhookLog
    try {
      const newInviteeUri = payload?.new_invitee?.invitee?.uri || payload?.new_invitee?.uri || null;
      const logId = newInviteeUri
        ? `wh_resched_${crypto.createHash('md5').update(newInviteeUri).digest('hex')}`
        : `wh_resched_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      CalendlyWebhookLogModel.create({
        webhookId: logId,
        eventType: 'invitee.rescheduled',
        payload: { ...payload },
      }).catch(err => Logger.warn('Failed to store reschedule webhook log', { error: err.message }));
    } catch (logErr) {
      Logger.warn('Reschedule webhook log wrapper threw', { error: logErr.message });
    }

    // ✅ FIXED: Correct destructuring for rescheduled event
    const { old_invitee, new_invitee } = payload;

    // Use new_invitee for current booking info
    const invitee = new_invitee || old_invitee;

    if (!invitee || !invitee.email) {
      Logger.error('Invalid reschedule webhook payload: missing invitee information');
      return res.status(400).json({
        success: false,
        error: 'Missing invitee information in webhook payload'
      });
    }

    const oldStartTime = old_invitee?.scheduled_event?.start_time;
    const newStartTime = new_invitee?.scheduled_event?.start_time;
    const newEndTime = new_invitee?.scheduled_event?.end_time;

    if (!oldStartTime || !newStartTime) {
      Logger.error('Invalid reschedule webhook payload: missing scheduled event times');
      return res.status(400).json({
        success: false,
        error: 'Missing old or new scheduled event times'
      });
    }

    const clientEmail = invitee.email;
    const clientName = invitee.name || 'Valued Client';

    const rescheduleUrl = payload?.reschedule_url || null;

    const meetLink = new_invitee?.scheduled_event?.location?.join_url || 'Not Provided';

    // Correct Booking Lookup
    let bookingRecord = null;
    try {
      // Event URI first (unique), for the same reason as the cancel handler: the invitee email can differ from the
      // email on the booking row, and an email-only match then falls through to the wrong record.
      const oldEventUri = old_invitee?.scheduled_event?.uri || null;
      if (oldEventUri) {
        bookingRecord = await CampaignBookingModel.findOne({ calendlyEventUri: oldEventUri });
      }

      const query = { clientEmail: clientEmail };

      // Try to find exact match by old start time first
      // Because we want to find the meeting that WAS at oldStartTime
      query.scheduledEventStartTime = oldStartTime;

      if (!bookingRecord) bookingRecord = await CampaignBookingModel.findOne(query);

      if (!bookingRecord) {
        Logger.warn('Could not find booking with exact start time, falling back to latest booking', { clientEmail, oldStartTime });
        bookingRecord = await CampaignBookingModel.findOne({ clientEmail: clientEmail })
          .sort({ bookingCreatedAt: -1 }).limit(1);
      }
    } catch (dbError) {
      Logger.error('Database error while finding booking record for reschedule', {
        error: dbError.message,
        clientEmail
      });
    }

    const clientPhone =
      extractCalendlyPhoneFromInvitee(invitee) ||
      normalizePhoneForReminders(bookingRecord?.clientPhone) ||
      null;

    Logger.info('Processing rescheduled meeting', {
      clientEmail,
      clientName,
      clientPhone,
      oldStartTime,
      newStartTime,
      hasRescheduleUrl: !!rescheduleUrl,
      rescheduleUrl,
    });

    let oldCallCancelled = false;
    let oldWhatsAppCancelled = false;

    if (clientPhone && oldStartTime) {
      // Cancel old call reminder
      try {
        const cancelCallResult = await cancelCall({
          phoneNumber: clientPhone,
          meetingStartISO: oldStartTime
        });
        if (cancelCallResult.success) {
          oldCallCancelled = true;
          Logger.info('Cancelled old call reminder', {
            callId: cancelCallResult.callId,
            clientPhone,
            oldStartTime
          });
        }
      } catch (callError) {
        Logger.error('Failed to cancel old call reminder', {
          error: callError.message,
          clientPhone,
          oldStartTime
        });
      }

      // Cancel old WhatsApp reminder
      try {
        const cancelWhatsAppResult = await cancelWhatsAppReminder({
          phoneNumber: clientPhone,
          meetingStartISO: oldStartTime
        });
        if (cancelWhatsAppResult.success) {
          oldWhatsAppCancelled = true;
          Logger.info('Cancelled old WhatsApp reminder', {
            cancelledCount: cancelWhatsAppResult.cancelledCount,
            clientPhone,
            oldStartTime,
          });
        }
      } catch (whatsappError) {
        Logger.error('Failed to cancel old WhatsApp reminder', {
          error: whatsappError.message,
          clientPhone,
          oldStartTime
        });
      }
    }

    // Cancel old Discord BDA meeting alert (3-min "I'm in" reminder) for the old time
    // ✅ Same identifier as call reminder: meeting time + clientEmail; fallback by clientName
    let oldDiscordMeetCancelled = false;
    try {
      const cancelDiscordResult = await cancelDiscordMeetRemindersForMeeting({
        meetingStartISO: oldStartTime,
        clientEmail,
        clientName,
      });
      if (cancelDiscordResult.success && cancelDiscordResult.cancelledCount > 0) {
        oldDiscordMeetCancelled = true;
        Logger.info('Cancelled old Discord meet reminder', {
          clientEmail,
          oldStartTime,
          cancelledCount: cancelDiscordResult.cancelledCount
        });
      }
    } catch (discordError) {
      Logger.error('Failed to cancel old Discord meet reminder', {
        error: discordError.message,
        clientEmail,
        oldStartTime
      });
    }

    // Update booking record with reschedule information
    if (bookingRecord) {
      try {
        bookingRecord._statusActor = { source: 'calendly', name: 'Calendly', email: 'calendly_webhook', previousStatus: bookingRecord.bookingStatus };
        bookingRecord.bookingStatus = 'rescheduled';
        bookingRecord.statusChangedAt = new Date();
        bookingRecord.statusChangeSource = 'calendly';
        bookingRecord.statusChangedBy = 'calendly_webhook';
        bookingRecord.rescheduledFrom = new Date(oldStartTime);
        bookingRecord.rescheduledTo = new Date(newStartTime);
        bookingRecord.rescheduledAt = new Date();
        bookingRecord.scheduledEventStartTime = new Date(newStartTime);
        if (newEndTime) {
          bookingRecord.scheduledEventEndTime = new Date(newEndTime);
        }
        if (rescheduleUrl) {
          bookingRecord.calendlyRescheduleLink = rescheduleUrl;
        }
        if (meetLink && meetLink !== 'Not Provided') {
          bookingRecord.calendlyMeetLink = meetLink;
        }
        bookingRecord.rescheduledCount = (bookingRecord.rescheduledCount || 0) + 1;
        // Reset single-winner dispatch flags so new meeting's reminder can fire.
        bookingRecord.bdaDiscordReminderSentAt = null;
        bookingRecord.bdaDiscordReminderSentBy = null;
        bookingRecord.whatsappReminderSentAt = null;
        bookingRecord.whatsappReminderSentBy = null;
        bookingRecord.bdaCallPlacedAt = null;
        bookingRecord.bdaCallPlacedBy = null;

        await bookingRecord.save();

        Logger.info('Updated booking record with reschedule information', {
          bookingId: bookingRecord._id,
          clientEmail,
          oldStartTime,
          newStartTime
        });
      } catch (updateError) {
        Logger.error('Failed to update booking record for reschedule', {
          error: updateError.message,
          bookingId: bookingRecord?._id
        });
      }
    }

    // Schedule new reminders with new meeting time
    let newCallScheduled = false;
    let newWhatsAppScheduled = false;

    if (clientPhone && newStartTime) {
      // Validate phone number format
      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      if (!phoneRegex.test(clientPhone)) {
        Logger.warn('Invalid phone number format, skipping reminder scheduling', {
          clientPhone
        });
      } else {
        const newMeetingStartUTC = DateTime.fromISO(newStartTime, { zone: 'utc' });
        const reschInviteeTimezone = new_invitee?.timezone || bookingRecord?.inviteeTimezone || null;
        const reschClientZone = reschInviteeTimezone || 'America/Los_Angeles';
        const newMeetingTimeClient = newMeetingStartUTC.isValid
          ? newMeetingStartUTC.setZone(reschClientZone).toFormat('ff') + ' ' + newMeetingStartUTC.setZone(reschClientZone).toFormat('ZZZZ')
          : `Unknown (raw: ${newStartTime || 'null'})`;
        const newMeetingTimeIndia = newMeetingStartUTC.isValid
          ? newMeetingStartUTC.setZone('Asia/Kolkata').toFormat('ff') + ' IST'
          : `Unknown (raw: ${newStartTime || 'null'})`;

        //Use reschedule URL from webhook with proper fallback chain
        const finalRescheduleLink = rescheduleUrl ||
          bookingRecord?.calendlyRescheduleLink ||
          'https://calendly.com/flashfirejobs';

        try {
          const scheduleCallResult = await scheduleCall({
            phoneNumber: clientPhone,
            meetingStartISO: newStartTime,
            meetingTime: newMeetingTimeClient,
            inviteeName: clientName,
            inviteeEmail: clientEmail,
            source: 'reschedule',
            meetingLink: meetLink !== 'Not Provided' ? meetLink : null,
            rescheduleLink: finalRescheduleLink,
            metadata: {
              bookingId: bookingRecord?.bookingId,
              rescheduledFrom: oldStartTime,
              rescheduledTo: newStartTime,
              meetingEndISO: newEndTime,
              meetingTimeIndia: newMeetingTimeIndia,
              inviteeTimezone: reschInviteeTimezone
            }
          });

          if (scheduleCallResult.success) {
            newCallScheduled = true;
            newWhatsAppScheduled = true;
            Logger.info('Scheduled new call + WhatsApp reminders for rescheduled meeting', {
              callId: scheduleCallResult.callId,
              clientPhone,
              newStartTime,
            });

            if (bookingRecord && scheduleCallResult.callId) {
              bookingRecord.reminderCallJobId = scheduleCallResult.callId;
              await bookingRecord.save();
            }
          }
        } catch (callScheduleError) {
          Logger.error('Failed to schedule new call reminder', {
            error: callScheduleError.message,
            clientPhone,
            newStartTime
          });
        }
      }
    }

    // Schedule Discord "meeting in 2 minutes" reminder for NEW time
    {
      try {
        if (newStartTime) {
          await scheduleDiscordMeetReminder({
            bookingId: bookingRecord?.bookingId,
            clientName: clientName || 'Valued Client',
            clientEmail: clientEmail || null,
            meetingStartISO: newStartTime,
            meetingLink: meetLink && meetLink !== 'Not Provided' ? meetLink : null,
            inviteeTimezone: new_invitee?.timezone || bookingRecord?.inviteeTimezone || null,
            source: 'reschedule',
            metadata: {
              campaignId: bookingRecord?.campaignId,
              utmSource: bookingRecord?.utmSource,
              rescheduledFrom: oldStartTime
            },
          });
          Logger.info('Scheduled new Discord meet reminder for rescheduled meeting');
        }
      } catch (discordReminderError) {
        Logger.warn('Failed to schedule new Discord 2-minute meeting reminder', {
          error: discordReminderError.message,
        });
      }
    }

    try {
      const fullPayload = JSON.stringify(req.body, null, 2);
      const truncatedPayload = fullPayload.length > 1000
        ? fullPayload.substring(0, 1000) + '\n... (truncated)'
        : fullPayload;

      await DiscordConnectForMeet(
        `🔄 Meeting Rescheduled: ${clientName} (${clientEmail})\n` +
        `👤 Assigned BDA: ${assignedBdaLabel(bookingRecord)}\n` +
        `📅 Old Time: ${(() => { const d = DateTime.fromISO(oldStartTime); return d.isValid ? d.toFormat('ff') : (oldStartTime || 'Unknown'); })()}\n` +
        `📅 New Time: ${(() => { const d = DateTime.fromISO(newStartTime); return d.isValid ? d.toFormat('ff') : (newStartTime || 'Unknown'); })()}\n` +
        `🔗 Reschedule URL: ${rescheduleUrl || 'NOT PROVIDED BY CALENDLY'}\n` +
        `❌ Old Reminders: Call ${oldCallCancelled ? '✓' : '✗'}, WhatsApp ${oldWhatsAppCancelled ? '✓' : '✗'}, BDA Meeting Reminder ${oldDiscordMeetCancelled ? '✓' : '✗'}\n` +
        `✅ New Reminders: Call ${newCallScheduled ? '✓' : '✗'}, WhatsApp ${newWhatsAppScheduled ? '✓' : '✗'}, BDA Meeting Reminder ✓\n\n` +
        `🔍 Webhook Payload (truncated if large):\n\`\`\`json\n${truncatedPayload}\n\`\`\``
      );
    } catch (discordError) {
      // ...
    }

    res.status(200).json({
      success: true,
      message: 'Rescheduled event processed successfully',
      data: {
        clientName,
        clientEmail,
        oldStartTime,
        newStartTime,
        oldCallCancelled,
        oldDiscordMeetCancelled
      }
    });

  } catch (error) {
    Logger.error('Error processing rescheduled event', {
      error: error.message,
      stack: error.stack,
      payload
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error processing rescheduled event'
    });
  }
}

async function handleCanceledEvent(req, res, payload) {
  try {
    // Audit trail — mirror invitee.created so cancels are visible in CalendlyWebhookLog
    try {
      const inviteeUri = payload?.invitee?.uri || payload?.uri || null;
      const logId = inviteeUri
        ? `wh_cancel_${crypto.createHash('md5').update(inviteeUri).digest('hex')}`
        : `wh_cancel_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      CalendlyWebhookLogModel.create({
        webhookId: logId,
        eventType: 'invitee.canceled',
        payload: { ...payload },
      }).catch(err => Logger.warn('Failed to store cancel webhook log', { error: err.message }));
    } catch (logErr) {
      Logger.warn('Cancel webhook log wrapper threw', { error: logErr.message });
    }

    const clientEmail = payload?.invitee?.email || payload?.email || null;
    const clientName = payload?.invitee?.name || payload?.name || 'Valued Client';

    const canceledBy = payload?.cancellation?.canceled_by || payload?.canceled_by || 'unknown';
    const cancelReason = payload?.cancellation?.reason || payload?.cancel_reason || 'No reason provided';
    const meetingStartTime = payload?.scheduled_event?.start_time || payload?.event?.start_time || null;
    const calendlyEventUri = payload?.scheduled_event?.uri || null;

    if (!clientEmail) {
      Logger.error('Invalid cancel webhook payload: missing email information');
      return res.status(400).json({
        success: false,
        error: 'Missing email information in webhook payload'
      });
    }

    let bookingRecord = null;
    let staleCancelForRebookedEvent = false;
    try {
      // The event URI is unique per Calendly event, the invitee email is not: a lead can fill our form with one
      // address and book with another (or reschedule under a different one). Matching on email alone left the
      // original booking 'scheduled' after the client cancelled, and the BDA was fined for a meeting that never ran.
      if (calendlyEventUri) {
        bookingRecord = await CampaignBookingModel.findOne({ calendlyEventUri });
      }

      const query = { clientEmail: clientEmail };

      if (calendlyEventUri) {
        query.calendlyEventUri = calendlyEventUri;
      } else if (meetingStartTime) {
        query.scheduledEventStartTime = meetingStartTime;
      }

      // If we have specific criteria, use it
      if (!bookingRecord && (query.calendlyEventUri || query.scheduledEventStartTime)) {
        bookingRecord = await CampaignBookingModel.findOne(query);
      }

      // Fallback ONLY if we couldn't find exact match.
      // Cancel+rebook race: invitee.created for the new event may have already overwritten
      // calendlyEventUri to the new event's URI. If the cancel arrives moments later, the
      // exact-match lookup misses. The fallback then grabs the latest booking and would
      // clobber the freshly-rebooked record with status=canceled. Detect that and skip the
      // status update so the live rebooked booking keeps its reminders.
      if (!bookingRecord) {
        Logger.warn('Could not find booking with exact event URI or start time, falling back to latest booking', { clientEmail });
        bookingRecord = await CampaignBookingModel.findOne({
          clientEmail: clientEmail
        }).sort({ bookingCreatedAt: -1 }).limit(1);

        if (
          bookingRecord &&
          calendlyEventUri &&
          bookingRecord.calendlyEventUri &&
          bookingRecord.calendlyEventUri !== calendlyEventUri
        ) {
          staleCancelForRebookedEvent = true;
          Logger.warn('Stale cancel for rebooked event — refusing to overwrite booking status', {
            clientEmail,
            cancelEventUri: calendlyEventUri,
            currentBookingEventUri: bookingRecord.calendlyEventUri,
            bookingId: bookingRecord.bookingId,
            bookingStatus: bookingRecord.bookingStatus,
          });
        }
      }

    } catch (dbError) {
      Logger.error('Database error while finding booking record for cancellation', {
        error: dbError.message,
        clientEmail
      });
    }

    const clientPhone =
      extractCalendlyPhoneFromPayload(payload) ||
      normalizePhoneForReminders(bookingRecord?.clientPhone) ||
      null;

    const meetingStartISO =
      meetingStartTime || bookingRecord?.scheduledEventStartTime || null;

    if (!meetingStartISO) {
      Logger.warn('Cancel webhook: no meeting start time for reminder cancellation', {
        clientEmail,
        hasBooking: !!bookingRecord,
      });
    }

    Logger.info('Processing canceled meeting', {
      clientEmail,
      clientName,
      clientPhone,
      canceledBy,
      cancelReason,
      meetingStartTime,
      meetingStartISO: meetingStartISO || null,
    });

    // Cancel scheduled reminders
    let callCancelled = false;
    let whatsappCancelled = false;

    if (staleCancelForRebookedEvent) {
      Logger.info('Stale cancel — skipping reminder cancellation to protect rebooked event', {
        clientEmail,
        meetingStartISO,
      });
    }

    if (!staleCancelForRebookedEvent && clientPhone && meetingStartISO) {
      // Cancel call reminder
      try {
        const cancelCallResult = await cancelCall({
          phoneNumber: clientPhone,
          meetingStartISO: meetingStartISO
        });
        if (cancelCallResult.success) {
          callCancelled = true;
          Logger.info('Cancelled call reminder', {
            callId: cancelCallResult.callId,
            clientPhone,
            meetingStartISO
          });
        }
      } catch (callError) {
        Logger.error('Failed to cancel call reminder', {
          error: callError.message,
          clientPhone,
          meetingStartISO
        });
      }

      // Cancel WhatsApp reminder
      try {
        const cancelWhatsAppResult = await cancelWhatsAppReminder({
          phoneNumber: clientPhone,
          meetingStartISO: meetingStartISO
        });
        if (cancelWhatsAppResult.success) {
          whatsappCancelled = true;
          Logger.info('Cancelled WhatsApp reminder', {
            cancelledCount: cancelWhatsAppResult.cancelledCount,
            clientPhone,
            meetingStartISO,
          });
        }
      } catch (whatsappError) {
        Logger.error('Failed to cancel WhatsApp reminder', {
          error: whatsappError.message,
          clientPhone,
          meetingStartISO
        });
      }
    }

    // Cancel Discord BDA meeting alert (3-min "I'm in" reminder) for this meeting
    // ✅ Same identifier as call reminder; fallback by clientName if no match by email
    let discordMeetCancelled = false;
    if (!staleCancelForRebookedEvent) try {
      const cancelDiscordResult = await cancelDiscordMeetRemindersForMeeting({
        meetingStartISO,
        clientEmail,
        clientName,
      });
      if (cancelDiscordResult.success && cancelDiscordResult.cancelledCount > 0) {
        discordMeetCancelled = true;
        Logger.info('Cancelled Discord meet reminder for canceled meeting', {
          clientEmail,
          meetingStartISO,
          cancelledCount: cancelDiscordResult.cancelledCount
        });
      }
    } catch (discordError) {
      Logger.error('Failed to cancel Discord meet reminder for canceled meeting', {
        error: discordError.message,
        clientEmail,
        meetingStartISO
      });
    }

    // Update booking record status to canceled
    if (bookingRecord && !staleCancelForRebookedEvent) {
      try {
        bookingRecord._statusActor = { source: 'calendly', name: 'Calendly', email: 'calendly_webhook', previousStatus: bookingRecord.bookingStatus };
        bookingRecord.bookingStatus = 'canceled';
        bookingRecord.statusChangedAt = new Date();
        bookingRecord.statusChangeSource = 'calendly';
        bookingRecord.statusChangedBy = 'calendly_webhook';
        bookingRecord.canceledAt = new Date();
        bookingRecord.canceledBy = canceledBy;
        bookingRecord.cancelReason = cancelReason;
        await bookingRecord.save();

        Logger.info('Updated booking record status to canceled', {
          bookingId: bookingRecord._id,
          clientEmail
        });
      } catch (updateError) {
        Logger.error('Failed to update booking record for cancellation', {
          error: updateError.message,
          bookingId: bookingRecord?._id
        });
      }
    } else if (staleCancelForRebookedEvent) {
      Logger.info('Skipped booking status update — cancel was for a rebooked old event', {
        bookingId: bookingRecord?.bookingId,
        clientEmail,
      });
    }

    // Format meeting time for Discord
    let meetingTimeFormatted = 'Not Available';
    if (meetingStartISO) {
      try {
        const meetingTime = DateTime.fromISO(meetingStartISO, { zone: 'utc' });
        meetingTimeFormatted = meetingTime.isValid ? meetingTime.toFormat('ff') : `Unknown (raw: ${meetingStartISO})`;
      } catch (timeError) {
        Logger.warn('Failed to format meeting time', { error: timeError.message });
      }
    }

    // Notify Discord
    const discordMsg = `🗑️ **Meeting Cancelled - Reminders Cancelled**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 **Name:** ${clientName}\n` +
      `📧 **Email:** ${clientEmail}\n` +
      `📞 **Phone:** ${clientPhone || 'Not Provided'}\n` +
      `👤 **Assigned BDA:** ${assignedBdaLabel(bookingRecord)}\n` +
      `📅 **Meeting Time:** ${meetingTimeFormatted}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ **Call Reminder:** ${callCancelled ? 'Cancelled' : 'Not Found'}\n` +
      `✅ **WhatsApp Reminder:** ${whatsappCancelled ? 'Cancelled' : 'Not Found'}\n` +
      `✅ **BDA Meeting Reminder:** ${discordMeetCancelled ? 'Cancelled' : 'Not Found'}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, discordMsg);
    }

    res.status(200).json({
      success: true,
      message: 'Canceled event processed successfully',
      data: {
        clientName,
        clientEmail,
        callCancelled,
        whatsappCancelled,
        discordMeetCancelled
      }
    });

  } catch (error) {
    Logger.error('Error processing canceled event', {
      error: error.message,
      stack: error.stack,
      payload
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error processing canceled event'
    });
  }
}

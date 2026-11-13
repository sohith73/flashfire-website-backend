import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { resolveLeadOwnersForPage } from '../Utils/clientIdentity.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';
import { UserModel } from '../Schema_Models/User.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { DateTime } from 'luxon';
import { triggerWorkflow, cancelScheduledWorkflows, cancelScheduledWorkflowLogsForBooking } from './WorkflowController.js';
import {
  cancelWhatsAppRemindersForClient,
  cancelWhatsAppReminder,
} from '../Utils/WhatsAppReminderScheduler.js';
import {
  cancelDiscordMeetRemindersForMeeting,
  scheduleDiscordMeetReminder,
} from '../Utils/DiscordMeetReminderScheduler.js';
import { cancelCall, scheduleCall } from '../Utils/CallScheduler.js';
import { normalizePhoneForReminders } from '../Utils/MeetingReminderUtils.js';
import { Logger } from '../Utils/Logger.js';
import { sendScheduleEvent } from '../Services/FacebookConversionAPI.js';
import { sendScheduleEvent as sendGoogleAdsScheduleEvent } from '../Services/GoogleAdsConversionAPI.js';
import { sendScheduleEvent as sendLinkedInScheduleEvent } from '../Services/LinkedInConversionAPI.js';
import { normalizePhoneForMatching } from '../Utils/normalizePhoneForMatching.js';
import { getCallSummariesSafe } from '../Utils/BookingCallSummary.js';
import { getAttendanceRowFieldsSafe } from '../Utils/attendanceRowFields.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import { normalizeCurrency, formatMoney } from '../Utils/currency.js';
import { crmUserMetaLeadsOnly, crmUserBdaOwnEmailScope } from '../Middlewares/CrmAuth.js';

/**
 * Restricts a leads query to the requesting BDA's own assigned leads, while still
 * showing leads with no resolved calendlyHost (so nothing becomes invisible to
 * everyone just because it predates round-robin Calendly scheduling, or came in
 * as a Meta lead that never got a host resolved).
 * No-op (returns matchQuery unchanged) for admins.
 */
export function applyBdaOwnLeadScope(matchQuery, req) {
  const ownEmail = crmUserBdaOwnEmailScope(req);
  if (!ownEmail) return matchQuery;

  matchQuery.$and = matchQuery.$and || [];
  // An admin transfer (attendanceAssignee) decides first: the new BDA sees the meeting and the old one stops seeing
  // it. With no transfer, the Calendly host rule below is unchanged.
  matchQuery.$and.push({
    $or: [
      { 'attendanceAssignee.email': caseInsensitiveExact(ownEmail) },
      {
        $and: [
          { 'attendanceAssignee.email': { $in: [null, ''] } },
          {
            $or: [
              { 'calendlyHost.email': caseInsensitiveExact(ownEmail) },
              { 'calendlyHost.email': { $in: [null, ''] } },
              { calendlyHost: { $exists: false } },
            ],
          },
        ],
      },
    ],
  });
  return matchQuery;
}

/** The post-meeting lead ratings a BDA can pick. */
const LEAD_TEMPERATURES = ['hot', 'warm', 'cold'];

/**
 * Applies the post-meeting lead rating filter (hot/warm/cold, or 'unrated') to the
 * leads list. Unknown values are ignored rather than rejected, matching how the other
 * optional list filters behave.
 *
 * 'unrated' has to cover three shapes, not just a null value: leads that predate the
 * field entirely (no subdocument), leads whose subdocument exists with value null, and
 * leads where the value was cleared — otherwise the rated and unrated counts would not
 * add up to the total.
 */
function applyTemperatureFilter(matchQuery, temperature) {
  const t = temperature ? String(temperature).trim().toLowerCase() : null;
  if (!t || t === 'all') return matchQuery;

  if (t === 'unrated') {
    matchQuery.$and = matchQuery.$and || [];
    matchQuery.$and.push({
      $or: [
        { leadTemperature: { $exists: false } },
        { 'leadTemperature.value': { $in: [null, ''] } },
        { 'leadTemperature.value': { $exists: false } }
      ]
    });
    return matchQuery;
  }

  if (LEAD_TEMPERATURES.includes(t)) {
    matchQuery['leadTemperature.value'] = t;
  }
  return matchQuery;
}

/**
 * Applies the fromDate/toDate range to matchQuery for the leads list (getLeadsPaginated /
 * getLeadsIds). Leads with a scheduled meeting are matched by scheduledEventStartTime.
 * Leads with no meeting booked yet (not-scheduled status, or a Meta lead that hasn't
 * booked) have no scheduledEventStartTime to range against, so without this they'd
 * silently vanish the moment any date filter is applied — they're matched by
 * bookingCreatedAt (when the lead came in) instead so the date range still applies to them.
 * With no date filter at all, every eligible lead type is shown, no range check needed.
 */
function applyLeadsDateRange(matchQuery, fromDate, toDate) {
  matchQuery.$and = matchQuery.$and || [];

  if (!fromDate && !toDate) {
    matchQuery.$and.push({
      $or: [
        { scheduledEventStartTime: { $exists: true, $ne: null } },
        { leadSource: 'meta_lead_ad' },
        { metaLeadId: { $exists: true, $ne: null } },
        { bookingStatus: 'not-scheduled' },
      ],
    });
    return matchQuery;
  }

  const range = {};
  if (fromDate) {
    const from = new Date(fromDate);
    from.setHours(0, 0, 0, 0);
    range.$gte = from;
  }
  if (toDate) {
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);
    range.$lte = to;
  }

  matchQuery.$and.push({
    $or: [
      { scheduledEventStartTime: range },
      {
        $and: [
          { $or: [{ scheduledEventStartTime: { $exists: false } }, { scheduledEventStartTime: null }] },
          { $or: [{ bookingStatus: 'not-scheduled' }, { leadSource: 'meta_lead_ad' }, { metaLeadId: { $exists: true, $ne: null } }] },
          { bookingCreatedAt: range },
        ],
      },
    ],
  });
  return matchQuery;
}

/**
 * Strict "Booked Date" filter — separate from applyLeadsDateRange. Filters only by
 * scheduledEventStartTime (the actual meeting time), no bookingCreatedAt fallback.
 * A lead with no scheduledEventStartTime (not-scheduled status, or a Meta lead that
 * hasn't booked a meeting) can never match a $gte/$lte range on that field, so it's
 * naturally excluded — no explicit status exclusion needed.
 */
function applyBookedDateRange(matchQuery, bookedFromDate, bookedToDate) {
  if (!bookedFromDate && !bookedToDate) return matchQuery;

  const range = {};
  if (bookedFromDate) {
    const from = new Date(bookedFromDate);
    from.setHours(0, 0, 0, 0);
    range.$gte = from;
  }
  if (bookedToDate) {
    const to = new Date(bookedToDate);
    to.setHours(23, 59, 59, 999);
    range.$lte = to;
  }

  matchQuery.$and = matchQuery.$and || [];
  matchQuery.$and.push({ scheduledEventStartTime: range });
  return matchQuery;
}

import { logReminderError } from '../Schema_Models/ReminderError.js';
import { validatePostMeetingBookingStatus } from '../Utils/meetingStatusEligibility.js';
import { checkBdaStatusAllowed, parseIgnoreReason, formatIgnoreReason } from '../Utils/bdaStatusRules.js';
import { SYSTEM_ACTOR, statusChangeSet, statusHistoryPush } from '../Utils/statusHistoryOps.js';

const PHONE_REGEX = /^\+?[1-9]\d{9,14}$/;

/**
 * Case-insensitive exact-match regex for dropdown filter values (utmSource / utmMedium /
 * utmCampaign). Lets "cpc" in a Campaign doc match "CPC" on a booking, "Paid" match "paid",
 * "usa-job" match "USA-Job", etc. Also tolerates `+` ↔ space (URL decoding artifacts).
 */
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
function caseInsensitiveExact(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  // Escape regex specials, then allow `+` and a single space to be interchangeable so
  // URL-encoded ("Google+Discovery+Arun") and decoded ("Google Discovery Arun") variants
  // both match.
  const escaped = trimmed.replace(REGEX_SPECIALS, '\\$&').replace(/[+ ]/g, '[+ ]');
  return { $regex: `^${escaped}$`, $options: 'i' };
}

/**
 * Schedule all reminders (call, WhatsApp, Discord BDA) for a booking.
 * Skips if meeting is too soon (<10 min).
 * Call internally schedules WhatsApp reminders.
 */
async function scheduleRemindersForBooking(booking, { source = 'manual' } = {}) {
  const phone = booking.clientPhone;
  const meetingStartISO = booking.scheduledEventStartTime?.toISOString?.() || booking.scheduledEventStartTime;
  const results = { call: false, whatsapp: false, discord: false, skipped: null };

  if (!meetingStartISO) {
    results.skipped = 'no meeting time';
    return results;
  }

  const meetingStart = new Date(meetingStartISO);
  const delay = meetingStart.getTime() - Date.now() - (10 * 60 * 1000);

  // Schedule Discord BDA reminder (doesn't need phone)
  try {
    await scheduleDiscordMeetReminder({
      bookingId: booking.bookingId,
      clientName: booking.clientName || 'Valued Client',
      clientEmail: booking.clientEmail || null,
      meetingStartISO,
      meetingLink: booking.calendlyMeetLink || booking.googleMeetUrl || null,
      inviteeTimezone: booking.inviteeTimezone || null,
      source,
      metadata: { campaignId: booking.campaignId, utmSource: booking.utmSource },
    });
    results.discord = true;
  } catch (err) {
    console.warn(`⚠️ [scheduleRemindersForBooking] Discord reminder failed for ${booking.bookingId}:`, err.message);
    logReminderError({
      bookingId: booking.bookingId, clientEmail: booking.clientEmail, clientPhone: phone,
      clientName: booking.clientName, category: 'discord', severity: 'error',
      message: 'Failed to schedule Discord meet reminder: ' + err.message,
      source: `CampaignBookingController.scheduleRemindersForBooking.${source}`
    });
  }

  // Schedule call + WhatsApp (needs valid non-India phone and enough time)
  if (phone && PHONE_REGEX.test(phone) && delay > 0) {
    try {
      const meetingStartUTC = DateTime.fromISO(meetingStartISO, { zone: 'utc' });
      const meetingTimeIndia = meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');

      const callResult = await scheduleCall({
        phoneNumber: phone,
        meetingStartISO,
        meetingTime: meetingTimeIndia,
        inviteeName: booking.clientName,
        inviteeEmail: booking.clientEmail,
        source,
        meetingLink: booking.calendlyMeetLink || booking.googleMeetUrl || null,
        rescheduleLink: booking.calendlyRescheduleLink || 'https://calendly.com/flashfirejobs',
        metadata: {
          bookingId: booking.bookingId,
          inviteeTimezone: booking.inviteeTimezone || null,
        }
      });

      if (callResult.success) {
        results.call = true;
        results.whatsapp = true; // WhatsApp is scheduled inside scheduleCall
        // Update booking with call ID
        await CampaignBookingModel.findOneAndUpdate(
          { bookingId: booking.bookingId },
          { reminderCallJobId: callResult.callId }
        );
      }
    } catch (err) {
      console.warn(`⚠️ [scheduleRemindersForBooking] Call/WhatsApp failed for ${booking.bookingId}:`, err.message);
      logReminderError({
        bookingId: booking.bookingId, clientEmail: booking.clientEmail, clientPhone: phone,
        clientName: booking.clientName, category: 'call', severity: 'error',
        message: 'Failed to schedule call+WhatsApp: ' + err.message,
        source: `CampaignBookingController.scheduleRemindersForBooking.${source}`
      });
    }
  } else if (delay <= 0) {
    results.skipped = 'meeting_too_soon';
    console.log(`⏭️ [scheduleRemindersForBooking] Meeting too soon for call/WA: ${booking.bookingId}`);
  } else {
    results.skipped = 'invalid_or_missing_phone';
  }

  console.log(`📋 [scheduleRemindersForBooking] ${booking.bookingId}: call=${results.call}, wa=${results.whatsapp}, discord=${results.discord}, skipped=${results.skipped || 'none'}`);
  return results;
}

const PLAN_CATALOG = {
  PRIME: { price: 99, currency: 'USD', displayPrice: '$99' },
  IGNITE: { price: 199, currency: 'USD', displayPrice: '$199' },
  PROFESSIONAL: { price: 349, currency: 'USD', displayPrice: '$349' },
  EXECUTIVE: { price: 599, currency: 'USD', displayPrice: '$599' },
};

const MQL_STATUSES = ['not-scheduled', 'scheduled', 'rescheduled', 'no-show', 'canceled', 'ignored'];
const SQL_STATUSES = ['completed'];
const CONVERTED_STATUSES = ['paid'];

function getQualificationFromStatus(bookingStatus) {
  if (CONVERTED_STATUSES.includes(bookingStatus)) return 'Converted';
  if (SQL_STATUSES.includes(bookingStatus)) return 'SQL';
  return 'MQL';
}

// ==================== SAVE CALENDLY BOOKING WITH UTM ====================
export const saveCalendlyBooking = async (bookingData) => {
  try {
    let {
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      clientName,
      clientEmail,
      clientPhone,
      calendlyEventUri,
      calendlyInviteeUri,
      calendlyMeetLink,
      scheduledEventStartTime,
      scheduledEventEndTime,
      anythingToKnow,
      questionsAndAnswers,
      visitorId,
      userAgent,
      ipAddress
    } = bookingData;

    if ((!clientName || clientName.trim() === '') || (!clientEmail || clientEmail.trim() === '')) {
      console.log('⚠️ Missing client name or email, searching for existing Calendly booking...');

      const findQuery = {};
      if (utmSource) {
        findQuery.utmSource = utmSource;
      }
      if (scheduledEventStartTime) {
        findQuery.scheduledEventStartTime = scheduledEventStartTime;
      }
      if (calendlyMeetLink && calendlyMeetLink !== 'Not Provided') {
        findQuery.calendlyMeetLink = calendlyMeetLink;
      }
      if (clientPhone) {
        findQuery.clientPhone = clientPhone;
      }

      if (Object.keys(findQuery).length > 0) {
        const existingBooking = await CampaignBookingModel.findOne(findQuery)
          .sort({ bookingCreatedAt: -1 })
          .limit(1)
          .lean();

        if (existingBooking) {
          console.log('✅ Found existing Calendly booking, using its data to fill missing fields');
          // Use Calendly data to fill in missing fields
          if (!clientName || clientName.trim() === '') {
            clientName = existingBooking.clientName || 'Unknown Client';
          }
          if (!clientEmail || clientEmail.trim() === '') {
            clientEmail = existingBooking.clientEmail || `unknown_${Date.now()}@calendly.placeholder`;
          }
          if (!clientPhone && existingBooking.clientPhone) {
            clientPhone = existingBooking.clientPhone;
          }
          if (!calendlyMeetLink && existingBooking.calendlyMeetLink) {
            calendlyMeetLink = existingBooking.calendlyMeetLink;
          }
          if (!calendlyEventUri && existingBooking.calendlyEventUri) {
            calendlyEventUri = existingBooking.calendlyEventUri;
          }
          if (!calendlyInviteeUri && existingBooking.calendlyInviteeUri) {
            calendlyInviteeUri = existingBooking.calendlyInviteeUri;
          }
        }
      }
    }

    // Use defaults if still empty after checking existing bookings
    if (!clientName || clientName.trim() === '') {
      clientName = 'Unknown Client';
      console.log('⚠️ Using default client name: Unknown Client');
    }
    if (!clientEmail || clientEmail.trim() === '') {
      clientEmail = `unknown_${Date.now()}@calendly.placeholder`;
      console.log('⚠️ Using default client email:', clientEmail);
    }

    // Find the campaign
    let campaignId = null;
    if (utmSource) {
      const campaign = await CampaignModel.findOne({ utmSource }).lean();
      if (campaign) {
        campaignId = campaign.campaignId;
      } else {
        // Get or create default "Calendly" campaign for direct bookings
        let defaultCampaign = await CampaignModel.findOne({ utmSource: 'calendly_direct' }).lean();

        if (!defaultCampaign) {
          // Create default Calendly campaign if it doesn't exist
          defaultCampaign = new CampaignModel({
            campaignName: 'Calendly Direct Bookings',
            utmSource: 'calendly_direct',
            utmMedium: 'calendly',
            utmCampaign: 'direct_booking',
            generatedUrl: 'https://www.flashfirejobs.com?utm_source=calendly_direct&utm_medium=calendly&utm_campaign=direct_booking',
            baseUrl: 'https://www.flashfirejobs.com',
            createdBy: 'system'
          });
          await defaultCampaign.save();
          console.log('✅ Created default Calendly campaign', { campaignId: defaultCampaign.campaignId });
        }

        campaignId = defaultCampaign.campaignId;
        console.log('✅ Assigned booking to default Calendly campaign', { campaignId });
      }
    }

    // Final duplicate check before saving (safety net)
    const finalDuplicateCheck = {
      $or: []
    };

    if (clientEmail && clientEmail.trim() !== '' && !clientEmail.includes('@calendly.placeholder')) {
      finalDuplicateCheck.$or.push({
        clientEmail: clientEmail.trim().toLowerCase(),
        scheduledEventStartTime: scheduledEventStartTime
      });
    }

    if (scheduledEventStartTime && calendlyMeetLink && calendlyMeetLink !== 'Not Provided') {
      finalDuplicateCheck.$or.push({
        scheduledEventStartTime: scheduledEventStartTime,
        calendlyMeetLink: calendlyMeetLink
      });
    }

    if (finalDuplicateCheck.$or.length > 0) {
      const existingDuplicate = await CampaignBookingModel.findOne(finalDuplicateCheck);
      if (existingDuplicate) {
        console.log('⚠️ Duplicate booking detected before save, returning existing booking');
        return {
          success: true,
          data: existingDuplicate,
          duplicate: true
        };
      }
    }

    // META LEAD SYNC: Check if there's a not-scheduled meta lead matching by email/phone
    const normalizedPhone = normalizePhoneForMatching(clientPhone);
    const metaSyncConditions = [{ clientEmail: clientEmail.trim().toLowerCase() }];
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
      console.log(`🔗 Meta lead sync: upgrading not-scheduled meta lead ${existingMetaLead.bookingId} to scheduled`);

      // Cancel not-scheduled workflows before status change
      try {
        await cancelScheduledWorkflows(existingMetaLead.bookingId, 'scheduled', 'not-scheduled');
      } catch (cancelErr) {
        console.warn('Failed to cancel not-scheduled workflows during meta sync:', cancelErr.message);
      }

      // Merge Calendly data into the existing meta lead (keep normalizedClientPhone in sync for future matching)
      const mergedPhone = clientPhone || existingMetaLead.clientPhone;
      const mergedBooking = await CampaignBookingModel.findOneAndUpdate(
        { bookingId: existingMetaLead.bookingId },
        {
          $set: {
            bookingStatus: 'scheduled',
            ...statusChangeSet(existingMetaLead.bookingStatus, 'scheduled', SYSTEM_ACTOR),
            clientName: clientName?.trim() || existingMetaLead.clientName,
            clientPhone: mergedPhone || existingMetaLead.clientPhone,
            normalizedClientPhone: normalizePhoneForMatching(mergedPhone) || null,
            campaignId: campaignId || existingMetaLead.campaignId,
            calendlyEventUri: calendlyEventUri || null,
            calendlyInviteeUri: calendlyInviteeUri || null,
            calendlyMeetLink: calendlyMeetLink || null,
            scheduledEventStartTime: scheduledEventStartTime || null,
            scheduledEventEndTime: scheduledEventEndTime || null,
            anythingToKnow: anythingToKnow || existingMetaLead.anythingToKnow,
            questionsAndAnswers: questionsAndAnswers || null,
            visitorId: visitorId || null,
            userAgent: userAgent || null,
            ipAddress: ipAddress || null
          },
          ...statusHistoryPush(existingMetaLead.bookingStatus, 'scheduled', SYSTEM_ACTOR),
        },
        { new: true }
      );

      // Mark user as booked
      try {
        const escapedEmail = mergedBooking.clientEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await UserModel.updateOne(
          { email: { $regex: new RegExp(`^${escapedEmail}$`, 'i') } },
          { $set: { booked: true } }
        );
      } catch (userUpdateError) {
        console.warn('Failed to update user booked status during meta sync:', userUpdateError.message);
      }

      // Schedule reminders for meta-synced booking (frontend_direct path)
      try {
        await scheduleRemindersForBooking(mergedBooking, { source: 'frontend_meta_sync' });
      } catch (reminderError) {
        console.warn('⚠️ [saveCalendlyBooking] Reminder scheduling failed for meta-synced booking:', reminderError.message);
      }

      return {
        success: true,
        data: mergedBooking,
        metaSynced: true
      };
    }

    // Create booking record
    const booking = new CampaignBookingModel({
      campaignId,
      utmSource: utmSource || 'direct',
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      clientName: clientName.trim(),
      clientEmail: clientEmail.trim().toLowerCase(),
      clientPhone,
      calendlyEventUri,
      calendlyInviteeUri,
      calendlyMeetLink,
      scheduledEventStartTime,
      scheduledEventEndTime,
      anythingToKnow,
      questionsAndAnswers,
      visitorId,
      userAgent,
      ipAddress,
      bookingStatus: 'scheduled'
    });

    await booking.save();

    // Mark user as booked in UserModel since they now have a booking
    try {
      const escapedEmail = booking.clientEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await UserModel.updateOne(
        { email: { $regex: new RegExp(`^${escapedEmail}$`, 'i') } },
        { $set: { booked: true } }
      );
      console.log('✅ User marked as booked:', { email: booking.clientEmail });
    } catch (userUpdateError) {
      console.warn('⚠️ Failed to update user booked status:', {
        email: booking.clientEmail,
        error: userUpdateError.message
      });
      // Don't fail the whole request if user update fails
    }

    console.log('✅ Calendly booking saved with UTM data:', {
      bookingId: booking.bookingId,
      utmSource: booking.utmSource,
      clientName: booking.clientName,
      clientEmail: booking.clientEmail,
      clientPhone: booking.clientPhone,
      calendlyMeetLink: booking.calendlyMeetLink,
      scheduledEventStartTime: booking.scheduledEventStartTime,
      bookingStatus: booking.bookingStatus
    });

    if (process.env.NODE_ENV !== 'production') {
      console.log('📊 Full booking object saved to database:', JSON.stringify({
        bookingId: booking.bookingId,
        campaignId: booking.campaignId,
        utmSource: booking.utmSource,
        clientName: booking.clientName,
        clientEmail: booking.clientEmail,
        clientPhone: booking.clientPhone,
        calendlyMeetLink: booking.calendlyMeetLink,
        scheduledEventStartTime: booking.scheduledEventStartTime,
        bookingCreatedAt: booking.bookingCreatedAt
      }, null, 2));
    }

    // Schedule reminders for this booking (call, WhatsApp, Discord BDA)
    // This covers the frontend_direct path where Calendly webhook may not fire
    try {
      await scheduleRemindersForBooking(booking, { source: 'frontend_direct' });
    } catch (reminderError) {
      console.warn('⚠️ [saveCalendlyBooking] Reminder scheduling failed (booking saved):', reminderError.message);
    }

    // Send Facebook Conversion API event (non-blocking)
    // This runs asynchronously and won't block the booking save
    sendScheduleEvent({
      email: booking.clientEmail,
      phone: booking.clientPhone,
      fullName: booking.clientName,
      clientIp: ipAddress || null,
      userAgent: userAgent || null,
      utmSource: booking.utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmContent: utmContent || null,
      utmTerm: utmTerm || null,
      eventId: booking.bookingId, // Use bookingId for deduplication
      eventSourceUrl: 'https://www.flashfirejobs.com/meeting-booked',
    }).catch((error) => {
      // Log but don't fail the booking save if Conversion API fails
      console.warn('⚠️ Facebook Conversion API call failed (non-critical):', error.message);
    });

    // Send Google Ads Conversion API event (non-blocking)
    // This runs asynchronously and won't block the booking save
    // Note: Google Ads server-side tracking requires Google Ads API setup with OAuth2
    // Current implementation prepares data - full API integration needs additional setup
    sendGoogleAdsScheduleEvent({
      email: booking.clientEmail,
      phone: booking.clientPhone,
      fullName: booking.clientName,
      clientIp: ipAddress || null,
      userAgent: userAgent || null,
      gclid: null, // Google Click ID - would come from URL params if available
      utmSource: booking.utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmContent: utmContent || null,
      utmTerm: utmTerm || null,
      eventId: booking.bookingId, // Use bookingId for deduplication
      eventSourceUrl: 'https://www.flashfirejobs.com/meeting-booked',
    }).catch((error) => {
      // Log but don't fail the booking save if Conversion API fails
      console.warn('⚠️ Google Ads Conversion API call failed (non-critical):', error.message);
    });

    // Send LinkedIn Conversion API event (non-blocking)
    // Server-side tracking bypasses ad blockers and works regardless of browser settings
    // Skip if email is placeholder - real email will come from Calendly webhook
    if (booking.clientEmail && !booking.clientEmail.includes('@calendly.placeholder')) {
      sendLinkedInScheduleEvent({
        email: booking.clientEmail,
        phone: booking.clientPhone,
        fullName: booking.clientName,
        clientIp: ipAddress || null,
        userAgent: userAgent || null,
        utmSource: booking.utmSource || null,
        utmMedium: utmMedium || null,
        utmCampaign: utmCampaign || null,
        utmContent: utmContent || null,
        utmTerm: utmTerm || null,
        eventId: booking.bookingId, // Use bookingId for deduplication
        eventSourceUrl: 'https://www.flashfirejobs.com/meeting-booked',
      }).catch((error) => {
        // Log but don't fail the booking save if Conversion API fails
        console.warn('⚠️ LinkedIn Conversion API call failed (non-critical):', error.message);
      });
    } else {
      console.log('⏭️ Skipping LinkedIn conversion - placeholder email, will send when webhook arrives with real email');
    }

    return {
      success: true,
      data: booking
    };

  } catch (error) {
    console.error('❌ Error saving Calendly booking:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

export const getAllBookingsPaginated = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status,
      utmSource,
      search,
      fromDate,
      toDate,
      type = 'all',
      planName,
      temperature
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let query = {};
    const normalizedPlanName = planName ? String(planName).toUpperCase() : null;

    if (status && status !== 'all') {
      query.bookingStatus = status;
    }

    if (utmSource && utmSource !== 'all') {
      query.utmSource = utmSource;
    }

    if (normalizedPlanName && normalizedPlanName !== 'ALL') {
      query['paymentPlan.name'] = normalizedPlanName;
    }

    if (search) {
      const trimmedSearch = search.trim();
      const escapedSearch = trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (escapedSearch) {
        const digitsOnly = trimmedSearch.replace(/\D/g, '');
        const phoneOrConditions = [];
        if (digitsOnly.length >= 4) {
          const flexPhoneRegex = digitsOnly.split('').join('[\\s().+\\-]*');
          phoneOrConditions.push({ clientPhone: { $regex: flexPhoneRegex, $options: 'i' } });
        }
        query.$or = [
          { clientName: { $regex: escapedSearch, $options: 'i' } },
          { clientEmail: { $regex: escapedSearch, $options: 'i' } },
          { clientPhone: { $regex: escapedSearch, $options: 'i' } },
          ...phoneOrConditions,
          { utmSource: { $regex: escapedSearch, $options: 'i' } }
        ];
      }
    }

    applyLeadsDateRange(query, fromDate, toDate);
    applyTemperatureFilter(query, temperature);

    const total = await CampaignBookingModel.countDocuments(query);

    const bookings = await CampaignBookingModel.find(query)
      .select({
        bookingId: 1,
        campaignId: 1,
        utmSource: 1,
        utmMedium: 1,
        utmCampaign: 1,
        utmContent: 1,
        utmTerm: 1,
        clientName: 1,
        clientEmail: 1,
        clientPhone: 1,
        calendlyMeetLink: 1,
        googleMeetUrl: 1,
        meetingVideoUrl: 1,
        scheduledEventStartTime: 1,
        scheduledEventEndTime: 1,
        bookingCreatedAt: 1,
        bookingStatus: 1,
      paymentPlan: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        firefliesTranscriptId: 1,
        reminderCallJobId: 1,
        paymentReminders: 1,
        rescheduledCount: 1,
        whatsappReminderSent: 1,
        leadTemperature: 1,
        // Status attribution. Without these the All Data tab cannot show who moved a
        // lead last or render the status timeline — the fields simply never arrived.
        statusChangedBy: 1,
        statusChangedByName: 1,
        statusChangedAt: 1,
        statusChangeSource: 1,
        statusHistory: 1,
        ignoreReason: 1,
        originalBda: 1,
        calendlyHost: 1,
        claimedBy: 1
      })
      .sort({ scheduledEventStartTime: -1, bookingCreatedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    // Lead owner is a property of the CLIENT, so it is resolved across every booking
    // that shares this one's email or phone. Without this each row shows whichever BDA
    // hosted that particular meeting, and one client reads as several different owners.
    try {
      const owners = await resolveLeadOwnersForPage(CampaignBookingModel, bookings);
      for (const b of bookings) {
        const o = owners.get(b.bookingId);
        if (o) b.leadOwner = { email: o.email, name: o.name, via: o.via, assignedAt: o.at };
      }
    } catch (e) {
      console.warn('resolveLeadOwnersForPage failed (all-data):', e.message);
    }

    return res.status(200).json({
      success: true,
      data: bookings,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });

  } catch (error) {
    console.error('Error fetching paginated bookings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message
    });
  }
};

export const getMeetingsBookedToday = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const query = {
      scheduledEventStartTime: {
        $gte: today,
        $lt: tomorrow
      }
    };

    const bookings = await CampaignBookingModel.find(query)
      .select({
        bookingId: 1,
        campaignId: 1,
        utmSource: 1,
        utmMedium: 1,
        utmCampaign: 1,
        clientName: 1,
        clientEmail: 1,
        clientPhone: 1,
        calendlyMeetLink: 1,
        scheduledEventStartTime: 1,
        scheduledEventEndTime: 1,
        bookingCreatedAt: 1,
        bookingStatus: 1,
      paymentPlan: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        firefliesTranscriptId: 1,
        reminderCallJobId: 1,
        paymentReminders: 1,
        rescheduledCount: 1,
        whatsappReminderSent: 1,
        leadTemperature: 1,
        // Status attribution. Without these the All Data tab cannot show who moved a
        // lead last or render the status timeline — the fields simply never arrived.
        statusChangedBy: 1,
        statusChangedByName: 1,
        statusChangedAt: 1,
        statusChangeSource: 1,
        statusHistory: 1,
        ignoreReason: 1,
        originalBda: 1,
        calendlyHost: 1,
        claimedBy: 1
      })
      .sort({ scheduledEventStartTime: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: bookings,
      count: bookings.length
    });

  } catch (error) {
    console.error('Error fetching meetings booked today:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meetings booked today',
      error: error.message
    });
  }
};

export const getMeetingsByDate = async (req, res) => {
  try {
    const { date, fromDate, toDate } = req.query;
    
    // Support both single date and date range
    let startDate, endDate;
    
    if (fromDate && toDate) {
      // Date range mode
      startDate = new Date(fromDate);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(toDate);
      endDate.setHours(23, 59, 59, 999);
    } else if (date) {
      // Single date mode (backward compatibility)
      startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      endDate.setHours(0, 0, 0, 0);
    } else {
      return res.status(400).json({
        success: false,
        message: 'Either date parameter (YYYY-MM-DD) or fromDate and toDate parameters (YYYY-MM-DD) are required'
      });
    }

    const query = {
      scheduledEventStartTime: {
        $gte: startDate,
        $lte: endDate
      }
    };

    const bookings = await CampaignBookingModel.find(query)
      .select({
        bookingId: 1,
        campaignId: 1,
        utmSource: 1,
        utmMedium: 1,
        utmCampaign: 1,
        clientName: 1,
        clientEmail: 1,
        clientPhone: 1,
        calendlyMeetLink: 1,
        scheduledEventStartTime: 1,
        scheduledEventEndTime: 1,
        bookingCreatedAt: 1,
        bookingStatus: 1,
      paymentPlan: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        firefliesTranscriptId: 1,
        reminderCallJobId: 1,
        paymentReminders: 1,
        rescheduledCount: 1,
        whatsappReminderSent: 1,
        leadTemperature: 1,
        // Status attribution. Without these the All Data tab cannot show who moved a
        // lead last or render the status timeline — the fields simply never arrived.
        statusChangedBy: 1,
        statusChangedByName: 1,
        statusChangedAt: 1,
        statusChangeSource: 1,
        statusHistory: 1,
        ignoreReason: 1,
        originalBda: 1,
        calendlyHost: 1,
        claimedBy: 1
      })
      .sort({ scheduledEventStartTime: 1 })
      .lean();

    // Calculate breakdown by status
    const breakdown = {
      booked: bookings.filter(b => b.bookingStatus === 'scheduled' || !b.bookingStatus).length,
      cancelled: bookings.filter(b => b.bookingStatus === 'canceled').length,
      noShow: bookings.filter(b => b.bookingStatus === 'no-show').length,
      completed: bookings.filter(b => b.bookingStatus === 'completed').length,
      rescheduled: bookings.filter(b => b.bookingStatus === 'rescheduled').length,
      total: bookings.length
    };

    return res.status(200).json({
      success: true,
      data: bookings,
      count: bookings.length,
      breakdown,
      dateRange: fromDate && toDate ? { fromDate, toDate } : { date }
    });

  } catch (error) {
    console.error('Error fetching meetings by date:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meetings by date',
      error: error.message
    });
  }
};

export const getAllBookings = async (req, res) => {
  try {
    const { utmSource, status, planName } = req.query;

    let query = {};
    const normalizedPlanName = planName ? String(planName).toUpperCase() : null;
    if (utmSource) query.utmSource = utmSource;
    if (status) query.bookingStatus = status;
    if (normalizedPlanName) {
      query['paymentPlan.name'] = normalizedPlanName;
    }

    const bookings = await CampaignBookingModel.find(query)
      .select({
        bookingId: 1,
        campaignId: 1,
        utmSource: 1,
        utmMedium: 1,
        utmCampaign: 1,
        utmContent: 1,
        utmTerm: 1,
        clientName: 1,
        clientEmail: 1,
        clientPhone: 1,
        calendlyMeetLink: 1,
        scheduledEventStartTime: 1,
        scheduledEventEndTime: 1,
        bookingCreatedAt: 1,
        bookingStatus: 1,
        paymentPlan: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        firefliesTranscriptId: 1,
        ignoreReason: 1
      })
      .sort({ scheduledEventStartTime: -1, bookingCreatedAt: -1 })
      .limit(5000)
      .lean();

    const total = bookings.length;

    return res.status(200).json({
      success: true,
      count: bookings.length,
      total,
      data: bookings
    });

  } catch (error) {
    console.error('Error fetching bookings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message
    });
  }
};

// ==================== GET BOOKING BY ID ====================
export const getBookingById = async (req, res) => {
  try {
    const { bookingId } = req.params;

    const results = await CampaignBookingModel.aggregate([
      { $match: { bookingId } },
      { $limit: 1 },
      {
        $lookup: {
          from: 'campaigns',
          localField: 'campaignId',
          foreignField: 'campaignId',
          as: '_campaign',
          pipeline: [{ $project: { campaignName: 1, campaignId: 1 } }]
        }
      },
      {
        $addFields: {
          _campaignDetail: { $arrayElemAt: ['$_campaign', 0] }
        }
      },
      { $project: { _campaign: 0 } }
    ]);

    const booking = results[0];
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    const campaignDetails = booking._campaignDetail
      ? { campaignName: booking._campaignDetail.campaignName, campaignId: booking._campaignDetail.campaignId }
      : null;
    delete booking._campaignDetail;

    return res.status(200).json({
      success: true,
      data: {
        booking,
        campaign: campaignDetails
      }
    });

  } catch (error) {
    console.error('Error fetching booking:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch booking details',
      error: error.message
    });
  }
};

// ==================== UPDATE BOOKING STATUS ====================
export const updateBookingStatus = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { status, plan, planDetails, paymentBreakdown } = req.body;

    const validStatuses = ['not-scheduled', 'scheduled', 'completed', 'canceled', 'rescheduled', 'no-show', 'paid', 'ignored'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Get booking before update to access client details
    const existingBooking = await CampaignBookingModel.findOne({ bookingId }).lean();
    if (!existingBooking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    const postMeetingCheck = validatePostMeetingBookingStatus(
      existingBooking.scheduledEventStartTime,
      status
    );
    if (!postMeetingCheck.ok) {
      return res.status(400).json({
        success: false,
        message: postMeetingCheck.message,
      });
    }

    // A completed meeting must carry a hot/warm/cold rating. The CRM asks for it before
    // sending this request, so this is the server-side backstop that keeps the rule true
    // no matter which client calls the API. Only blocks the transition INTO completed —
    // a booking already completed (rated or not, including everything from before this
    // rule existed) can still be moved to any other status.
    if (status === 'completed' && existingBooking.bookingStatus !== 'completed') {
      const rated = existingBooking.leadTemperature?.value;
      if (!LEAD_TEMPERATURES.includes(rated)) {
        return res.status(400).json({
          success: false,
          message: 'Rate the lead hot, warm or cold before marking the meeting completed.',
          code: 'RATING_REQUIRED',
        });
      }
    }

    let paymentPlanUpdate = null;
    let planDetailsUpdate = null;

    // Handle planDetails for finalkk template (can be sent with any status)
    if (planDetails) {
      planDetailsUpdate = {
        days: planDetails.days || 7,
        updatedAt: new Date()
      };
    }

    let paymentBreakdownToSet = null;
    const allowedPlans = ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'];
    if (status === 'paid') {
      if (Array.isArray(paymentBreakdown) && paymentBreakdown.length > 0) {
        const lines = [];
        let totalAmount = 0;
        for (const line of paymentBreakdown) {
          const planKey = String(line.planName || '').toUpperCase();
          const amount = Number(line.amount);
          if (!allowedPlans.includes(planKey) || amount <= 0 || Number.isNaN(amount)) continue;
          lines.push({
            planName: planKey,
            amount,
            currency: normalizeCurrency(line.currency)
          });
          totalAmount += amount;
        }
        if (lines.length > 0) {
          const currency = normalizeCurrency(lines[0].currency);
          paymentPlanUpdate = {
            name: lines[0].planName,
            price: totalAmount,
            currency,
            displayPrice: formatMoney(totalAmount, currency),
            selectedAt: new Date()
          };
          paymentBreakdownToSet = lines;
        }
      }
      if (!paymentPlanUpdate) {
        const normalizedPlanName = plan?.name ? String(plan.name).toUpperCase() : null;
        if (!normalizedPlanName || !PLAN_CATALOG[normalizedPlanName]) {
          return res.status(400).json({
            success: false,
            message: 'A valid plan is required when marking a booking as paid'
          });
        }
        const amountPaid = plan?.price != null ? Number(plan.price) : PLAN_CATALOG[normalizedPlanName].price;
        if (amountPaid <= 0 || Number.isNaN(amountPaid)) {
          return res.status(400).json({
            success: false,
            message: 'Amount paid by client must be greater than 0'
          });
        }
        const catalogPlan = PLAN_CATALOG[normalizedPlanName];
        const paidCurrency = normalizeCurrency(plan?.currency || catalogPlan.currency);
        paymentPlanUpdate = {
          name: normalizedPlanName,
          price: amountPaid,
          currency: paidCurrency,
          // Derived, never taken from the request: a client-supplied displayPrice could
          // disagree with the currency and strand a "$" label on a EUR/CAD record.
          displayPrice: formatMoney(amountPaid, paidCurrency),
          selectedAt: new Date()
        };
        paymentBreakdownToSet = []; // single plan = no breakdown
      }
    }

    // Who is making this change. When a CRM login token is present (attached by
    // attachCrmUserOptional) we TRUST its email over anything in the body — this
    // is what makes the status-ownership lock tamper-resistant. Non-CRM callers
    // (microservices/automations) fall back to the body actor fields.
    const statusChangedAt = new Date();
    const authedEmail = req.crmUser?.email ? String(req.crmUser.email).toLowerCase() : null;

    // Resolve whether the authenticated actor is a CRM admin (role lives in the DB,
    // not in the token). Admins may override any lock.
    let isAdminActor = false;
    if (authedEmail) {
      // A crm_admin token (the /admin/analysis login) is an admin by construction, even
      // when that email has no CrmUser row. Otherwise use the shared rule: role 'admin'
      // or the isAdmin flag (some admins have role 'bda' with isAdmin: true).
      isAdminActor = req.crmUser.role === 'crm_admin' || (await isCrmAdmin(req.crmUser));
    }

    let actorEmail;
    let actorName;
    let statusSource;
    if (authedEmail) {
      actorEmail = authedEmail;
      actorName = req.crmUser.name || req.body.changedByName || (isAdminActor ? 'Admin' : authedEmail);
      statusSource = isAdminActor ? 'admin' : 'bda';
    } else {
      // Legacy / non-CRM path (unauthenticated). Trust the body, as before.
      actorEmail = req.body.changedBy || req.headers['x-user-email'] || 'admin';
      actorName = req.body.changedByName || 'Admin';
      statusSource = req.body.source || 'admin';
      isAdminActor = statusSource === 'admin' || statusSource === 'system';
    }
    const previousStatus = existingBooking.bookingStatus || null;

    // ── Status-ownership lock ────────────────────────────────────────────────
    // Once a BDA sets a FINAL decision (completed / no-show / paid / canceled /
    // ignored) that lead's status belongs to them: another BDA cannot change it.
    // Only the same BDA, or an admin, may. Automated sources are exempt.
    const FINAL_DECISION_STATUSES = ['completed', 'no-show', 'paid', 'canceled', 'ignored'];
    const lockedOwner = existingBooking.statusChangedBy
      ? String(existingBooking.statusChangedBy).toLowerCase()
      : null;
    const isLocked =
      existingBooking.statusChangeSource === 'bda' &&
      FINAL_DECISION_STATUSES.includes(existingBooking.bookingStatus) &&
      !!lockedOwner;

    if (isLocked && !isAdminActor && actorEmail.toLowerCase() !== lockedOwner) {
      const ownerName = existingBooking.statusChangedByName || existingBooking.statusChangedBy;
      return res.status(403).json({
        success: false,
        locked: true,
        owner: existingBooking.statusChangedBy,
        ownerName,
        currentStatus: existingBooking.bookingStatus,
        message: `This lead was marked "${existingBooking.bookingStatus}" by ${ownerName}. Only ${ownerName} or an admin can change its status.`,
      });
    }

    // BDAs only record meeting outcomes; everything else is Calendly, automations or an admin.
    const bdaRule = checkBdaStatusAllowed({ status, statusSource });
    if (!bdaRule.ok) {
      return res.status(403).json({
        success: false,
        code: 'STATUS_NOT_ALLOWED_FOR_BDA',
        message: bdaRule.message,
      });
    }

    // Ignoring a lead needs a reason from a BDA (admins may add one, automations never do).
    let ignoreReason = null;
    if (status === 'ignored') {
      const parsed = parseIgnoreReason(req.body.ignoreReason, { required: statusSource === 'bda' });
      if (!parsed.ok) {
        return res.status(400).json({
          success: false,
          code: 'IGNORE_REASON_INVALID',
          message: parsed.message,
        });
      }
      ignoreReason = parsed.value;
    }

    const updatePayload = {
      bookingStatus: status,
      statusChangedAt,
      statusChangeSource: statusSource,
      statusChangedBy: actorEmail,
      statusChangedByName: actorName,
    };

    if (ignoreReason) {
      updatePayload.ignoreReason = {
        ...ignoreReason,
        setByEmail: actorEmail,
        setByName: actorName,
        setAt: statusChangedAt,
      };
    } else if (status !== 'ignored' && existingBooking.ignoreReason) {
      // The lead left Ignored; the reason stays in statusHistory, not on the live record.
      updatePayload.ignoreReason = null;
    }

    if (paymentPlanUpdate) {
      updatePayload.paymentPlan = paymentPlanUpdate;
    }
    if (paymentBreakdownToSet !== null) {
      updatePayload.paymentBreakdown = paymentBreakdownToSet;
    }

    // Store planDetails for finalkk template execution
    if (planDetailsUpdate) {
      updatePayload.planDetails = planDetailsUpdate;
    }
    
    // Also update paymentPlan if plan is provided (for completed status with finalkk)
    if (plan && !paymentPlanUpdate) {
      const normalizedPlanName = plan?.name ? String(plan.name).toUpperCase() : null;
      if (normalizedPlanName && PLAN_CATALOG[normalizedPlanName]) {
        const catalogPlan = PLAN_CATALOG[normalizedPlanName];
        updatePayload.paymentPlan = {
          name: normalizedPlanName,
          price: plan?.price ?? catalogPlan.price,
          currency: plan?.currency || catalogPlan.currency,
          displayPrice: plan?.displayPrice || catalogPlan.displayPrice,
          selectedAt: new Date()
        };
      }
    }

    // Update booking status. Append an append-only history entry whenever the status
    // actually changes so the CRM timeline records who/when for every transition.
    const updateOps = { $set: updatePayload };
    if (status !== previousStatus) {
      updateOps.$push = {
        statusHistory: {
          status,
          previousStatus,
          changedByEmail: actorEmail,
          changedByName: actorName,
          source: statusSource,
          changedAt: statusChangedAt,
          reason: formatIgnoreReason(ignoreReason),
        },
      };
    }
    const booking = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      updateOps,
      { new: true }
    );

    // If status changed to "paid", cancel all scheduled reminders for this client
    if (status === 'paid') {
      try {
        const cancellationResults = {
          whatsappReminders: { cancelled: 0 },
          discordMeetReminders: { cancelled: 0 },
          callReminders: { cancelled: 0 },
          paymentReminders: { cancelled: 0 },
          scheduledWorkflows: { cancelled: 0 }
        };

        // Cancel WhatsApp reminders
        if (existingBooking.clientEmail || existingBooking.clientPhone) {
          const whatsappResult = await cancelWhatsAppRemindersForClient({
            clientEmail: existingBooking.clientEmail,
            phoneNumber: existingBooking.clientPhone,
            meetingStartISO: existingBooking.scheduledEventStartTime
          });

          if (whatsappResult.success && whatsappResult.cancelledCount > 0) {
            cancellationResults.whatsappReminders.cancelled = whatsappResult.cancelledCount;
            Logger.info('WhatsApp reminders cancelled for paid booking', {
              bookingId,
              clientEmail: existingBooking.clientEmail,
              cancelledCount: whatsappResult.cancelledCount
            });
          }
        }

        // Cancel Discord BDA meeting alert (3-min "I'm in" reminder)
        if (existingBooking.scheduledEventStartTime) {
          try {
            const discordResult = await cancelDiscordMeetRemindersForMeeting({
              meetingStartISO: existingBooking.scheduledEventStartTime,
              clientEmail: existingBooking.clientEmail,
              clientName: existingBooking.clientName || null,
            });
            if (discordResult.success && discordResult.cancelledCount > 0) {
              cancellationResults.discordMeetReminders.cancelled = discordResult.cancelledCount;
              Logger.info('Discord meet reminders cancelled for paid booking', {
                bookingId,
                clientEmail: existingBooking.clientEmail,
                cancelledCount: discordResult.cancelledCount
              });
            }
          } catch (discordError) {
            Logger.warn('Error cancelling Discord meet reminders for paid booking', {
              bookingId,
              error: discordError.message
            });
          }
        }

        // Cancel call reminders (if reminderCallJobId exists)
        if (existingBooking.reminderCallJobId && callQueue) {
          try {
            const callJob = await callQueue.getJob(existingBooking.reminderCallJobId);
            if (callJob) {
              await callJob.remove();
              cancellationResults.callReminders.cancelled = 1;
              Logger.info('Call reminder job cancelled for paid booking', {
                bookingId,
                jobId: existingBooking.reminderCallJobId
              });
            }
          } catch (callError) {
            Logger.warn('Could not cancel call reminder job (may not exist)', {
              bookingId,
              jobId: existingBooking.reminderCallJobId,
              error: callError.message
            });
          }
        }

        // Also try to cancel via CallScheduler if phone and meeting time are available
        if (existingBooking.clientPhone && existingBooking.scheduledEventStartTime) {
          try {
            const callCancelResult = await cancelCall({
              phoneNumber: existingBooking.clientPhone,
              meetingStartISO: existingBooking.scheduledEventStartTime
            });
            if (callCancelResult.success) {
              cancellationResults.callReminders.cancelled += 1;
            }
          } catch (callError) {
            Logger.warn('Error cancelling call via CallScheduler', {
              bookingId,
              error: callError.message
            });
          }
        }

        // Cancel payment reminders (email reminders)
        if (existingBooking.paymentReminders && existingBooking.paymentReminders.length > 0) {
          const scheduledPaymentReminders = existingBooking.paymentReminders.filter(
            pr => pr.status === 'scheduled'
          );

          if (scheduledPaymentReminders.length > 0) {
            for (const paymentReminder of scheduledPaymentReminders) {
              try {
                // Remove job from queue
                if (paymentReminder.jobId && callQueue) {
                  const paymentJob = await callQueue.getJob(paymentReminder.jobId);
                  if (paymentJob) {
                    await paymentJob.remove();
                  }
                }

                // Update status to cancelled in database
                await CampaignBookingModel.updateOne(
                  {
                    bookingId,
                    'paymentReminders.jobId': paymentReminder.jobId
                  },
                  {
                    $set: {
                      'paymentReminders.$.status': 'cancelled'
                    }
                  }
                );

                cancellationResults.paymentReminders.cancelled += 1;
              } catch (paymentError) {
                Logger.warn('Error cancelling payment reminder', {
                  bookingId,
                  jobId: paymentReminder.jobId,
                  error: paymentError.message
                });
              }
            }

            Logger.info('Payment reminders cancelled for paid booking', {
              bookingId,
              cancelledCount: cancellationResults.paymentReminders.cancelled
            });
          }
        }

        // Cancel scheduled WorkflowLog entries (cron processes these - must cancel to prevent execution)
        try {
          const logCancelResult = await cancelScheduledWorkflowLogsForBooking(bookingId, 'Cancelled: Booking status changed to paid');
          if (logCancelResult.success && logCancelResult.cancelled > 0) {
            cancellationResults.scheduledWorkflows.cancelled += logCancelResult.cancelled;
          }
        } catch (logCancelError) {
          Logger.warn('Error cancelling scheduled workflow logs for paid booking', {
            bookingId,
            error: logCancelError.message
          });
        }

        // Cancel scheduled workflows (email and WhatsApp workflows) in booking document
        if (existingBooking.scheduledWorkflows && existingBooking.scheduledWorkflows.length > 0) {
          const scheduledWorkflows = existingBooking.scheduledWorkflows.filter(
            sw => sw.status === 'scheduled'
          );

          if (scheduledWorkflows.length > 0) {
            // Update all scheduled workflows to cancelled status
            for (const workflow of scheduledWorkflows) {
              try {
                await CampaignBookingModel.updateOne(
                  {
                    bookingId,
                    'scheduledWorkflows._id': workflow._id
                  },
                  {
                    $set: {
                      'scheduledWorkflows.$.status': 'cancelled',
                      'scheduledWorkflows.$.error': 'Cancelled: Booking status changed to paid'
                    }
                  }
                );

                cancellationResults.scheduledWorkflows.cancelled += 1;
              } catch (workflowError) {
                Logger.warn('Error cancelling scheduled workflow', {
                  bookingId,
                  workflowId: workflow.workflowId,
                  error: workflowError.message
                });
              }
            }

            Logger.info('Scheduled workflows cancelled for paid booking', {
              bookingId,
              cancelledCount: cancellationResults.scheduledWorkflows.cancelled
            });
          }
        }

        console.log(`✅ Cancelled all reminders and workflows for paid booking ${bookingId}:`, cancellationResults);
      } catch (cancellationError) {
        // Log error but don't fail the status update
        Logger.error('Error cancelling reminders and workflows for paid booking', {
          bookingId,
          error: cancellationError.message,
          stack: cancellationError.stack
        });
        console.error('⚠️ Failed to cancel reminders and workflows for paid booking:', cancellationError);
      }
    }

    // If status changed to "ignored", cancel scheduled workflow logs immediately
    // so cron workers never execute stale workflow records.
    if (status === 'ignored') {
      try {
        await cancelScheduledWorkflowLogsForBooking(bookingId, 'Cancelled: Booking status changed to ignored');
      } catch (logCancelError) {
        Logger.warn('Error cancelling scheduled workflow logs for ignored booking', {
          bookingId,
          error: logCancelError.message
        });
      }
    }

    // Cancel scheduled workflows when status changes to certain statuses
    // This should happen BEFORE triggering new workflows
    // Cancel workflows when moving away from workflow-triggering statuses (like 'no-show') 
    // to other statuses, so old workflows don't execute for the wrong status
    const oldStatus = existingBooking.bookingStatus;
    const statusesThatCancelWorkflows = ['completed', 'paid', 'canceled', 'scheduled', 'rescheduled', 'not-scheduled', 'ignored'];
    
    // Cancel workflows if:
    // 1. New status is in the cancellation list AND
    // 2. Status is actually changing AND
    // 3. Old status was a workflow-triggering status (has scheduled workflows that should be cancelled)
    if (statusesThatCancelWorkflows.includes(status) && oldStatus !== status) {
      try {
        const cancelResult = await cancelScheduledWorkflows(bookingId, status, oldStatus);
        
        if (cancelResult.success && cancelResult.cancelled > 0) {
          console.log(`✅ Cancelled ${cancelResult.cancelled} scheduled workflow(s) for booking ${bookingId} due to status change from ${oldStatus} to ${status}`);
          Logger.info('Cancelled scheduled workflows due to status change', {
            bookingId,
            oldStatus,
            newStatus: status,
            cancelledCount: cancelResult.cancelled,
            clientEmail: existingBooking.clientEmail
          });
        }
      } catch (cancelError) {
        console.error('Error cancelling scheduled workflows:', cancelError);
        Logger.error('Error cancelling scheduled workflows', {
          bookingId,
          oldStatus,
          newStatus: status,
          error: cancelError.message,
          stack: cancelError.stack
        });
        // Don't fail the status update if cancellation fails
      }
    }

    // Trigger workflows for specific status changes
    // NOTE: 'paid' is excluded - paid clients must NEVER receive any workflows
    const workflowTriggerStatuses = ['not-scheduled', 'completed', 'canceled', 'rescheduled', 'no-show'];
    if (workflowTriggerStatuses.includes(status)) {
      try {
        Logger.info('Triggering workflows for status change', {
          bookingId,
          status,
          clientEmail: existingBooking.clientEmail,
          source: 'status_update'
        });
        
        const workflowResult = await triggerWorkflow(bookingId, status);
        if (workflowResult.success && workflowResult.triggered) {
          console.log(`✅ Workflows triggered for booking ${bookingId} with status ${status}`);
          Logger.info('Workflows triggered successfully', {
            bookingId,
            status,
            workflowsTriggered: workflowResult.workflowsTriggered?.length || 0,
            clientEmail: existingBooking.clientEmail
          });
        } else {
          Logger.info('No workflows triggered (none configured or inactive)', {
            bookingId,
            status,
            clientEmail: existingBooking.clientEmail
          });
        }
      } catch (workflowError) {
        console.error('Error triggering workflows:', workflowError);
        Logger.error('Error triggering workflows', {
          bookingId,
          status,
          error: workflowError.message,
          stack: workflowError.stack
        });
        // Don't fail the status update if workflow trigger fails
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Booking status updated successfully',
      data: booking,
      workflowTriggered: workflowTriggerStatuses.includes(status),
      remindersCancelled: status === 'paid'
    });

  } catch (error) {
    console.error('Error updating booking status:', error);
    Logger.error('Error updating booking status', {
      bookingId: req.params.bookingId,
      status: req.body.status,
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      success: false,
      message: 'Failed to update booking status',
      error: error.message
    });
  }
};

// ==================== GET BOOKINGS BY EMAIL ====================
export const getBookingsByEmail = async (req, res) => {
  try {
    const { email } = req.params;

    const bookings = await CampaignBookingModel.find({
      clientEmail: email.toLowerCase()
    }).sort({ bookingCreatedAt: -1 });

    return res.status(200).json({
      success: true,
      count: bookings.length,
      data: bookings
    });

  } catch (error) {
    console.error('Error fetching bookings by email:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message
    });
  }
};

// ==================== RESCHEDULE BOOKING ====================
export const rescheduleBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { newTime } = req.body;

    if (!newTime) {
      return res.status(400).json({
        success: false,
        message: 'newTime (ISO string) is required',
      });
    }

    const parsedTime = new Date(newTime);
    if (Number.isNaN(parsedTime.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date provided for newTime',
      });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    const oldStartISO = booking.scheduledEventStartTime || null;
    const normalizedPhone =
      normalizePhoneForReminders(booking.clientPhone) || null;

    if (oldStartISO && normalizedPhone) {
      try {
        await cancelCall({
          phoneNumber: normalizedPhone,
          meetingStartISO: oldStartISO,
        });
      } catch (e) {
        console.warn('[rescheduleBooking] cancelCall:', e.message);
      }
      try {
        await cancelWhatsAppReminder({
          phoneNumber: normalizedPhone,
          meetingStartISO: oldStartISO,
        });
      } catch (e) {
        console.warn('[rescheduleBooking] cancelWhatsAppReminder:', e.message);
      }
      try {
        await cancelDiscordMeetRemindersForMeeting({
          meetingStartISO: oldStartISO,
          clientEmail: booking.clientEmail,
          clientName: booking.clientName,
        });
      } catch (e) {
        console.warn('[rescheduleBooking] cancelDiscordMeetRemindersForMeeting:', e.message);
      }
    }

    // Clear the old job reference (BullMQ removed — CallScheduler handles cancellation via MongoDB)
    if (booking.reminderCallJobId) {
      booking.reminderCallJobId = null;
    }

    const rescheduledFrom = booking.scheduledEventStartTime;
    booking.rescheduledFrom = rescheduledFrom || null;
    booking.rescheduledTo = parsedTime;
    booking.rescheduledAt = new Date();
    booking.rescheduledCount = (booking.rescheduledCount || 0) + 1;
    booking.scheduledEventStartTime = parsedTime;
    // Reset single-winner dispatch flags so the next meeting's reminder can fire.
    booking.bdaDiscordReminderSentAt = null;
    booking.bdaDiscordReminderSentBy = null;
    booking.whatsappReminderSentAt = null;
    booking.whatsappReminderSentBy = null;
    booking.bdaCallPlacedAt = null;
    booking.bdaCallPlacedBy = null;

    const phone = normalizedPhone;
    const delayMs = parsedTime.getTime() - Date.now() - 10 * 60 * 1000;
    if (phone && delayMs > 0) {
      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      if (phoneRegex.test(phone)) {
        try {
          const meetingStartUTC = DateTime.fromJSDate(parsedTime, { zone: 'utc' });
          const meetingTimeIndia = meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');

          const scheduleResult = await scheduleCall({
            phoneNumber: phone,
            meetingStartISO: parsedTime.toISOString(),
            meetingTime: meetingTimeIndia,
            inviteeName: booking.clientName,
            inviteeEmail: booking.clientEmail,
            source: 'manual',
            meetingLink: booking.calendlyMeetLink || null,
            rescheduleLink: booking.calendlyRescheduleLink || null,
            metadata: {
              bookingId: booking.bookingId,
              inviteeTimezone: booking.inviteeTimezone || null,
            },
          });

          if (scheduleResult.success && scheduleResult.callId) {
            booking.reminderCallJobId = scheduleResult.callId;
            console.log('✅ Mongo call + WA reminders scheduled from rescheduleBooking', {
              callId: scheduleResult.callId,
              phone,
            });
          }

          try {
            await scheduleDiscordMeetReminder({
              bookingId: booking.bookingId,
              clientName: booking.clientName || 'Valued Client',
              clientEmail: booking.clientEmail || null,
              meetingStartISO: parsedTime.toISOString(),
              meetingLink:
                booking.calendlyMeetLink && booking.calendlyMeetLink !== 'Not Provided'
                  ? booking.calendlyMeetLink
                  : null,
              inviteeTimezone: booking.inviteeTimezone || null,
              source: 'manual',
              metadata: { bookingId: booking.bookingId },
            });
          } catch (discordErr) {
            console.warn('[rescheduleBooking] scheduleDiscordMeetReminder:', discordErr.message);
          }
        } catch (error) {
          console.error('Error scheduling Mongo reminder chain from rescheduleBooking:', error);
        }
      }
    }

    booking.bookingStatus = 'scheduled';
    await booking.save();

    return res.status(200).json({
      success: true,
      message: 'Booking rescheduled successfully',
      data: booking.toObject(),
    });
  } catch (error) {
    console.error('Error rescheduling booking:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reschedule booking',
      error: error.message,
    });
  }
};

// ==================== EXPORT BOOKINGS FOR MICROSERVICE ====================
export const exportBookingsForMicroservice = async (req, res) => {
  try {
    const { syncedOnly = false, limit = 1000 } = req.query;

    let query = {};
    if (syncedOnly === 'true') {
      query.syncedToMicroservice = false;
    }

    const bookings = await CampaignBookingModel.find(query)
      .sort({ bookingCreatedAt: -1 })
      .limit(parseInt(limit))
      .lean();

    // Format for export
    const exportData = bookings.map(booking => ({
      bookingId: booking.bookingId,
      utmSource: booking.utmSource,
      utmMedium: booking.utmMedium,
      utmCampaign: booking.utmCampaign,
      clientName: booking.clientName,
      clientEmail: booking.clientEmail,
      clientPhone: booking.clientPhone,
      meetLink: booking.calendlyMeetLink,
      scheduledTime: booking.scheduledEventStartTime,
      bookingDate: booking.bookingCreatedAt,
      status: booking.bookingStatus
    }));

    return res.status(200).json({
      success: true,
      count: exportData.length,
      data: exportData,
      exportedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error exporting bookings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to export bookings',
      error: error.message
    });
  }
};

// ==================== MARK AS SYNCED ====================
export const markBookingsAsSynced = async (req, res) => {
  try {
    const { bookingIds } = req.body;

    if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'bookingIds array is required'
      });
    }

    const result = await CampaignBookingModel.updateMany(
      { bookingId: { $in: bookingIds } },
      {
        syncedToMicroservice: true,
        syncedAt: new Date()
      }
    );

    return res.status(200).json({
      success: true,
      message: `${result.modifiedCount} bookings marked as synced`,
      modifiedCount: result.modifiedCount
    });

  } catch (error) {
    console.error('Error marking bookings as synced:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark bookings as synced',
      error: error.message
    });
  }
};

// ==================== FRONTEND CAPTURE (BACKUP TO WEBHOOK) ====================
export const captureFrontendBooking = async (req, res) => {
  try {
    const bookingData = req.body;

    console.log('📱 Frontend booking capture received:', {
      email: bookingData.clientEmail,
      name: bookingData.clientName,
      utmSource: bookingData.utmSource
    });

    // Build query to check if booking already exists (from webhook)
    // Check by multiple criteria since frontend might send empty email/name
    const duplicateQuery = {
      $or: []
    };

    // If email is provided, check by email and scheduled time
    if (bookingData.clientEmail && bookingData.clientEmail.trim() !== '') {
      duplicateQuery.$or.push({
        clientEmail: bookingData.clientEmail,
        scheduledEventStartTime: bookingData.scheduledEventStartTime
      });
    }

    // Also check by UTM source and scheduled time (for when email is empty)
    if (bookingData.utmSource && bookingData.scheduledEventStartTime) {
      duplicateQuery.$or.push({
        utmSource: bookingData.utmSource,
        scheduledEventStartTime: bookingData.scheduledEventStartTime
      });
    }

    // Check by meet link if available
    if (bookingData.calendlyMeetLink && bookingData.calendlyMeetLink !== 'Not Provided') {
      duplicateQuery.$or.push({
        calendlyMeetLink: bookingData.calendlyMeetLink
      });
    }

    // If we have query criteria, check for duplicates
    if (duplicateQuery.$or.length > 0) {
      const existingBooking = await CampaignBookingModel.findOne(duplicateQuery);

      if (existingBooking) {
        console.log('ℹ️ Booking already exists (webhook captured it first), skipping duplicate');
        return res.status(200).json({
          success: true,
          message: 'Booking already captured by webhook',
          duplicate: true,
          bookingId: existingBooking.bookingId
        });
      }
    }

    // Save booking using the existing function (it will handle missing data)
    const result = await saveCalendlyBooking(bookingData);

    if (result.success) {
      return res.status(201).json({
        success: true,
        message: 'Booking captured successfully from frontend',
        data: result.data
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Failed to save booking',
        error: result.error
      });
    }

  } catch (error) {
    console.error('❌ Error capturing frontend booking:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to capture booking',
      error: error.message
    });
  }
};

// ==================== UPDATE BOOKING NOTES ====================
export const updateBookingNotes = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { notes } = req.body;

    const booking = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      { meetingNotes: notes },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Booking notes updated successfully',
      data: booking
    });

  } catch (error) {
    console.error('Error updating booking notes:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update booking notes',
      error: error.message
    });
  }
};

// ==================== LEAD TEMPERATURE (post-meeting rating) ====================

/**
 * PUT /api/campaign-bookings/:bookingId/temperature
 *
 * Records how warm the lead felt to the BDA, captured right after the meeting is
 * marked completed. Re-rating simply overwrites, with fresh attribution — a BDA
 * changing their mind is expected, and the status history already carries the
 * meeting timeline.
 */
export const updateBookingTemperature = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const raw = req.body?.temperature;
    const temperature = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

    if (!LEAD_TEMPERATURES.includes(temperature)) {
      return res.status(400).json({
        success: false,
        message: `temperature must be one of: ${LEAD_TEMPERATURES.join(', ')}`
      });
    }

    // Same trust rule as the status endpoint: a CRM token wins over body fields.
    const authedEmail = req.crmUser?.email ? String(req.crmUser.email).toLowerCase() : null;
    const ratedByEmail = authedEmail || (req.body?.ratedByEmail ? String(req.body.ratedByEmail).toLowerCase() : null);
    const ratedByName = (authedEmail ? req.crmUser.name : null) || req.body?.ratedByName || ratedByEmail || null;

    const booking = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      {
        $set: {
          'leadTemperature.value': temperature,
          'leadTemperature.ratedByEmail': ratedByEmail,
          'leadTemperature.ratedByName': ratedByName,
          'leadTemperature.ratedAt': new Date()
        }
      },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    return res.status(200).json({
      success: true,
      message: 'Lead rating saved',
      data: { bookingId: booking.bookingId, leadTemperature: booking.leadTemperature }
    });
  } catch (error) {
    console.error('Error updating lead temperature:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save lead rating',
      error: error.message
    });
  }
};

// ==================== CREATE BOOKING MANUALLY ====================
export const createBookingManually = async (req, res) => {
  try {
    const {
      clientName,
      clientEmail,
      clientPhone,
      scheduledEventStartTime,
      utmSource,
      utmMedium,
      utmCampaign,
      bookingStatus,
      calendlyMeetLink,
      anythingToKnow,
      meetingNotes
    } = req.body;

    // Validation
    if (!clientName || !clientEmail || !clientPhone || !scheduledEventStartTime) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: clientName, clientEmail, clientPhone, scheduledEventStartTime'
      });
    }

    // Find or create campaign
    let campaignId = null;
    if (utmSource) {
      const campaign = await CampaignModel.findOne({ utmSource });
      if (campaign) {
        campaignId = campaign.campaignId;
      }
    }

    // Create booking
    const newBooking = new CampaignBookingModel({
      clientName: clientName.trim(),
      clientEmail: clientEmail.trim().toLowerCase(),
      clientPhone: clientPhone.trim(),
      scheduledEventStartTime: new Date(scheduledEventStartTime),
      scheduledEventEndTime: new Date(new Date(scheduledEventStartTime).getTime() + 30 * 60000), // 30 min default
      utmSource: utmSource || 'MANUAL',
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      campaignId: campaignId,
      bookingStatus: bookingStatus || 'scheduled',
      calendlyMeetLink: calendlyMeetLink || null,
      anythingToKnow: anythingToKnow || null,
      meetingNotes: meetingNotes || null,
      bookingCreatedAt: new Date()
    });

    await newBooking.save();

    console.log('✅ Booking created manually:', newBooking.bookingId);

    // Schedule all reminders (call, WhatsApp, Discord BDA) for the new booking
    let reminderResults = null;
    try {
      reminderResults = await scheduleRemindersForBooking(newBooking, { source: 'manual' });
    } catch (reminderError) {
      console.warn('⚠️ Reminder scheduling failed for manual booking (booking saved):', reminderError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      booking: newBooking,
      reminders: reminderResults
    });
  } catch (error) {
    console.error('❌ Error creating booking manually:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create booking',
      error: error.message
    });
  }
};

export const bulkCreateLeads = async (req, res) => {
  try {
    const { leads } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Leads array is required and must not be empty'
      });
    }

    const defaultMeetingTime = new Date('2025-01-01T10:00:00Z');
    const results = {
      successful: [],
      failed: [],
      skipped: []
    };

    for (const lead of leads) {
      try {
        const { name, email, mobile } = lead;

        if (!name || !email) {
          results.failed.push({
            lead,
            error: 'Name and email are required'
          });
          continue;
        }

        const normalizedEmail = email.trim().toLowerCase();
        
        const existingBooking = await CampaignBookingModel.findOne({
          clientEmail: normalizedEmail
        });

        if (existingBooking) {
          results.skipped.push({
            email: normalizedEmail,
            reason: 'Email already exists'
          });
          continue;
        }

        const newBooking = new CampaignBookingModel({
          clientName: name.trim(),
          clientEmail: normalizedEmail,
          clientPhone: mobile && mobile.trim() ? mobile.trim() : null,
          scheduledEventStartTime: defaultMeetingTime,
          scheduledEventEndTime: new Date(defaultMeetingTime.getTime() + 30 * 60000),
          utmSource: 'CSV_IMPORT',
          utmMedium: null,
          utmCampaign: null,
          campaignId: null,
          bookingStatus: 'scheduled',
          calendlyMeetLink: null,
          anythingToKnow: null,
          meetingNotes: null,
          bookingCreatedAt: new Date()
        });

        await newBooking.save();
        results.successful.push({
          email: normalizedEmail,
          bookingId: newBooking.bookingId
        });
      } catch (error) {
        results.failed.push({
          lead,
          error: error.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${leads.length} leads`,
      results: {
        total: leads.length,
        successful: results.successful.length,
        failed: results.failed.length,
        skipped: results.skipped.length
      },
      details: results
    });
  } catch (error) {
    console.error('❌ Error bulk creating leads:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to bulk create leads',
      error: error.message
    });
  }
};

export const getLeadsPaginated = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      fromDate,
      toDate,
      bookedFromDate,
      bookedToDate,
      planName,
      utmMedium,
      utmCampaign,
      minAmount,
      maxAmount,
      status,
      qualification,
      temperature
    } = req.query;

    let utmSource = req.query.utmSource;
    if (crmUserMetaLeadsOnly(req)) {
      utmSource = 'meta_lead_ad';
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let matchQuery = {};
    const normalizedPlanName = planName ? String(planName).toUpperCase() : null;

    const qual = qualification ? String(qualification).toLowerCase() : null;
    if (qual === 'mql' || qual === 'sql' || qual === 'converted') {
      matchQuery.bookingStatus = {
        $in: qual === 'mql' ? MQL_STATUSES : qual === 'sql' ? SQL_STATUSES : CONVERTED_STATUSES
      };
    } else if (status && status !== 'all') {
      matchQuery.bookingStatus = status;
    }

    if (utmSource && utmSource !== 'all') {
      if (utmSource === 'meta_lead_ad') {
        // Meta Leads tab: show all leads that have Meta lead data (native or merged)
        matchQuery.$and = matchQuery.$and || [];
        matchQuery.$and.push({
          $or: [
            { metaLeadId: { $exists: true, $ne: null } },
            { leadSource: 'meta_lead_ad' }
          ]
        });
      } else {
        matchQuery.utmSource = caseInsensitiveExact(utmSource);
      }
    }
    if (utmCampaign && utmCampaign !== 'all') {
      matchQuery.$and = matchQuery.$and || [];
      matchQuery.$and.push({
        $or: [
          { utmCampaign: caseInsensitiveExact(utmCampaign) },
          { metaCampaignName: caseInsensitiveExact(utmCampaign) },
        ],
      });
    }
    if (utmMedium && utmMedium !== 'all') {
      matchQuery.utmMedium = caseInsensitiveExact(utmMedium);
    }

    if (normalizedPlanName && normalizedPlanName !== 'ALL') {
      matchQuery['paymentPlan.name'] = normalizedPlanName;
    }

    if (minAmount || maxAmount) {
      matchQuery['paymentPlan.price'] = {};
      if (minAmount) {
        matchQuery['paymentPlan.price'].$gte = parseFloat(minAmount);
      }
      if (maxAmount) {
        matchQuery['paymentPlan.price'].$lte = parseFloat(maxAmount);
      }
    }

    if (search) {
      const trimmedSearch = search.trim();
      if (trimmedSearch) {
        const escapedSearch = trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Build a flexible phone regex: strip all non-digits from the search term,
        // then allow any formatting characters between each digit so that
        // "6605805378", "+1 660 580-5378", "(660)580-5378", etc. all match
        // the stored value regardless of how it was formatted.
        const digitsOnly = trimmedSearch.replace(/\D/g, '');
        const phoneOrConditions = [];
        if (digitsOnly.length >= 4) {
          const flexPhoneRegex = digitsOnly.split('').join('[\\s().+\\-]*');
          phoneOrConditions.push({ clientPhone: { $regex: flexPhoneRegex, $options: 'i' } });
        }
        matchQuery.$or = [
          { clientName: { $regex: escapedSearch, $options: 'i' } },
          { clientEmail: { $regex: escapedSearch, $options: 'i' } },
          { clientPhone: { $regex: escapedSearch, $options: 'i' } },
          ...phoneOrConditions,
          { utmSource: { $regex: escapedSearch, $options: 'i' } },
          { utmMedium: { $regex: escapedSearch, $options: 'i' } },
          { utmCampaign: { $regex: escapedSearch, $options: 'i' } },
          { metaCampaignName: { $regex: escapedSearch, $options: 'i' } },
          { metaAdName: { $regex: escapedSearch, $options: 'i' } }
        ];
      }
    }

    applyLeadsDateRange(matchQuery, fromDate, toDate);
    applyBookedDateRange(matchQuery, bookedFromDate, bookedToDate);
    applyTemperatureFilter(matchQuery, temperature);
    applyBdaOwnLeadScope(matchQuery, req);

    // For Meta leads (meta_lead_ad), show ALL leads including duplicates
    // For other leads, group by email/phone to show unique leads only
    const isMetaLeadsOnly = utmSource === 'meta_lead_ad';

    const pipeline = [
      { $match: matchQuery },
      {
        $sort: {
          scheduledEventStartTime: -1,
          bookingCreatedAt: -1
        }
      }
    ];

    // Only group if NOT Meta leads (Meta leads should show all individual records)
    if (!isMetaLeadsOnly) {
      pipeline.push(
        {
          $addFields: {
            groupKey: {
              $ifNull: ['$clientPhone', '$clientEmail']
            }
          }
        },
        {
          $group: {
            _id: '$groupKey',
            booking: { $first: '$$ROOT' },
            totalBookings: { $sum: 1 }
          }
        },
        {
          $replaceRoot: {
            newRoot: {
              $mergeObjects: ['$booking', { totalBookings: '$totalBookings' }]
            }
          }
        },
        {
          $sort: {
            scheduledEventStartTime: -1,
            bookingCreatedAt: -1
          }
        }
      );
    } else {
      // For Meta leads, add totalBookings: 1 to each record (no grouping)
      pipeline.push({
        $addFields: {
          totalBookings: 1
        }
      });
    }

    // Search is already included in matchQuery.$or — no duplicate $match needed

    const countPipeline = [
      ...pipeline.slice(0, -1),
      { $count: 'total' }
    ];

    const [countResult] = await CampaignBookingModel.aggregate(countPipeline, { allowDiskUse: true });
    const total = countResult?.total || 0;

    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNum });

    const bookings = await CampaignBookingModel.aggregate(pipeline, { allowDiskUse: true });

    // Only do additional grouping if NOT Meta leads (Meta leads already show all records)
    let finalBookings;
    if (!isMetaLeadsOnly) {
      const groupedMap = new Map();
      for (const booking of bookings) {
        const normalizedPhone = normalizePhoneForMatching(booking.clientPhone);
        const groupKey = normalizedPhone || booking.clientEmail;
        
        if (!groupedMap.has(groupKey)) {
          groupedMap.set(groupKey, booking);
        } else {
          const existing = groupedMap.get(groupKey);
          const existingTime = existing.scheduledEventStartTime ? new Date(existing.scheduledEventStartTime).getTime() : 0;
          const currentTime = booking.scheduledEventStartTime ? new Date(booking.scheduledEventStartTime).getTime() : 0;
          if (currentTime > existingTime || (currentTime === existingTime && new Date(booking.bookingCreatedAt).getTime() > new Date(existing.bookingCreatedAt).getTime())) {
            groupedMap.set(groupKey, booking);
          }
        }
      }
      finalBookings = Array.from(groupedMap.values());
    } else {
      // For Meta leads, return all bookings as-is (no additional grouping)
      finalBookings = bookings;
    }

    // Sort final bookings
    finalBookings = finalBookings.sort((a, b) => {
      const aTime = a.scheduledEventStartTime ? new Date(a.scheduledEventStartTime).getTime() : 0;
      const bTime = b.scheduledEventStartTime ? new Date(b.scheduledEventStartTime).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime;
      return new Date(b.bookingCreatedAt).getTime() - new Date(a.bookingCreatedAt).getTime();
    }).map((b) => ({ ...b, qualification: getQualificationFromStatus(b.bookingStatus) }));

    // Same client-level owner the All Data tab shows, so both tabs agree on who the
    // lead belongs to rather than each row naming whoever hosted that meeting.
    try {
      const owners = await resolveLeadOwnersForPage(CampaignBookingModel, finalBookings);
      finalBookings = finalBookings.map((b) => {
        const o = owners.get(b.bookingId);
        return o ? { ...b, leadOwner: { email: o.email, name: o.name, via: o.via, assignedAt: o.at } } : b;
      });
    } catch (e) {
      console.warn('resolveLeadOwnersForPage failed (leads):', e.message);
    }

    // BDA attendance (plan 6.3): did the assigned BDA call this client? One CallLog query for the whole page.
    const leadCallSummaries = await getCallSummariesSafe(finalBookings);
    finalBookings = finalBookings.map((b) => ({ ...b, callSummary: leadCallSummaries.get(b.bookingId) ?? null }));

    // BDA attendance (plan 9.2): verdict, status trail, deductions. Two queries for the whole page; admins see every deduction.
    const leadAttendance = await getAttendanceRowFieldsSafe(finalBookings, {
      email: req.crmUser?.email,
      isAdmin: await isCrmAdmin(req.crmUser).catch(() => false)
    });
    finalBookings = finalBookings.map((b) => {
      const f = leadAttendance.get(b.bookingId);
      return { ...b, attendance: f?.attendance ?? null, statusUpdate: f?.statusUpdate ?? null, deductions: f?.deductions ?? [], transcript: f?.transcript ?? null };
    });

    const baseMatchQuery = { ...matchQuery };
    delete baseMatchQuery.bookingStatus;
    const qualStatsPipeline = [
      { $match: baseMatchQuery },
      { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
      { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
      { $group: { _id: '$groupKey', bookingStatus: { $first: '$bookingStatus' } } },
      {
        $addFields: {
          qualification: {
            $cond: [
              { $in: ['$bookingStatus', CONVERTED_STATUSES] },
              'Converted',
              { $cond: [{ $in: ['$bookingStatus', SQL_STATUSES] }, 'SQL', 'MQL'] }
            ]
          }
        }
      },
      { $group: { _id: '$qualification', count: { $sum: 1 } } }
    ];
    // Search is already included in baseMatchQuery.$or — no duplicate $match needed
    const qualStatsResult = await CampaignBookingModel.aggregate(qualStatsPipeline);
    const mqlCount = qualStatsResult.find((r) => r._id === 'MQL')?.count ?? 0;
    const sqlCount = qualStatsResult.find((r) => r._id === 'SQL')?.count ?? 0;
    const convertedCount = qualStatsResult.find((r) => r._id === 'Converted')?.count ?? 0;

    // Status breakdown for "Meetings from X to Y".
    // Counts DISTINCT (client, status) pairs — i.e. per status, how many unique clients had
    // that status in range. This is exactly what the UI shows when you filter the table to a
    // single status, so the unfiltered chart now equals the per-status numbers.
    // (The old version collapsed each client to their latest row only, so a client who was
    // canceled and later rescheduled counted once under "rescheduled" and vanished from
    // "canceled" — which is why unfiltered showed 13 canceled but filtering showed 22.)
    const statusBreakdownPipeline = [
      { $match: matchQuery },
      { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
      { $group: { _id: { groupKey: '$groupKey', bookingStatus: '$bookingStatus' } } },
      { $group: { _id: '$_id.bookingStatus', count: { $sum: 1 } } }
    ];
    const statusBreakdownResult = await CampaignBookingModel.aggregate(statusBreakdownPipeline);
    const statusBreakdown = {};
    for (const row of statusBreakdownResult) {
      statusBreakdown[row._id] = row.count;
    }

    // Monthly breakdown by status for the bar chart.
    // Same counting rule as statusBreakdown above: DISTINCT (client, status) pairs, bucketed
    // into the month of that client's most recent row carrying that status. Summing a status
    // across months therefore equals what the table shows when filtered to that status.
    const monthlyStatusPipeline = [
      { $match: matchQuery },
      { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
      { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
      { $group: {
        _id: { groupKey: '$groupKey', bookingStatus: '$bookingStatus' },
        monthDate: { $first: { $ifNull: ['$scheduledEventStartTime', '$bookingCreatedAt'] } }
      }},
      { $addFields: { month: { $dateToString: { format: '%Y-%m', date: '$monthDate' } } } },
      { $group: { _id: { month: '$month', bookingStatus: '$_id.bookingStatus' }, count: { $sum: 1 } } },
      { $sort: { '_id.month': 1 } }
    ];
    const flatMonthlyStatusResult = await CampaignBookingModel.aggregate(monthlyStatusPipeline, { allowDiskUse: true });
    const monthMap = new Map();
    for (const row of flatMonthlyStatusResult) {
      const { month, bookingStatus } = row._id;
      if (!monthMap.has(month)) {
        monthMap.set(month, { month, 'not-scheduled': 0, scheduled: 0, completed: 0, canceled: 0, 'no-show': 0, rescheduled: 0, ignored: 0, paid: 0 });
      }
      const entry = monthMap.get(month);
      if (entry.hasOwnProperty(bookingStatus)) {
        entry[bookingStatus] = row.count;
      }
    }
    const monthlyStatusBreakdown = Array.from(monthMap.values())
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((entry) => ({
        ...entry,
        booked: (entry.scheduled || 0) + (entry.rescheduled || 0)
      }));

    const statsPipeline = [
      { $match: matchQuery },
      {
        $group: {
          _id: '$paymentPlan.name',
          count: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$paymentPlan.name', null] }, { $eq: ['$bookingStatus', 'paid'] }] },
                1,
                0
              ]
            }
          },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ['$bookingStatus', 'paid'] },
                { $ifNull: ['$paymentPlan.price', 0] },
                0
              ]
            }
          }
        }
      },
      { $match: { _id: { $ne: null } } }
    ];

    const planBreakdown = await CampaignBookingModel.aggregate(statsPipeline);
    const totalRevenue = planBreakdown.reduce((sum, plan) => sum + (plan.revenue || 0), 0);

    return res.status(200).json({
      success: true,
      data: finalBookings,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      },
      stats: {
        totalRevenue: totalRevenue || 0,
        planBreakdown: planBreakdown,
        mqlCount,
        sqlCount,
        convertedCount,
        statusBreakdown,
        monthlyStatusBreakdown
      }
    });

  } catch (error) {
    console.error('Error fetching paginated leads:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch leads',
      error: error.message
    });
  }
};

export const getLeadsIds = async (req, res) => {
  try {
    const {
      search,
      fromDate,
      toDate,
      bookedFromDate,
      bookedToDate,
      planName,
      utmMedium,
      utmCampaign,
      minAmount,
      maxAmount,
      status,
      qualification,
      temperature,
      limit = '5000'
    } = req.query;

    let utmSource = req.query.utmSource;
    if (crmUserMetaLeadsOnly(req)) {
      utmSource = 'meta_lead_ad';
    }

    const limitNum = Math.min(5000, Math.max(1, parseInt(String(limit), 10) || 5000));
    let matchQuery = {};
    const normalizedPlanName = planName ? String(planName).toUpperCase() : null;
    const qual = qualification ? String(qualification).toLowerCase() : null;
    if (qual === 'mql' || qual === 'sql' || qual === 'converted') {
      matchQuery.bookingStatus = {
        $in: qual === 'mql' ? MQL_STATUSES : qual === 'sql' ? SQL_STATUSES : CONVERTED_STATUSES
      };
    } else if (status && status !== 'all') {
      matchQuery.bookingStatus = status;
    }
    if (utmSource && utmSource !== 'all') {
      if (utmSource === 'meta_lead_ad') {
        matchQuery.$and = matchQuery.$and || [];
        matchQuery.$and.push({
          $or: [
            { metaLeadId: { $exists: true, $ne: null } },
            { leadSource: 'meta_lead_ad' }
          ]
        });
      } else {
        matchQuery.utmSource = caseInsensitiveExact(utmSource);
      }
    }
    if (utmCampaign && utmCampaign !== 'all') {
      matchQuery.$and = matchQuery.$and || [];
      matchQuery.$and.push({
        $or: [
          { utmCampaign: caseInsensitiveExact(utmCampaign) },
          { metaCampaignName: caseInsensitiveExact(utmCampaign) },
        ],
      });
    }
    if (utmMedium && utmMedium !== 'all') {
      matchQuery.utmMedium = caseInsensitiveExact(utmMedium);
    }
    if (normalizedPlanName && normalizedPlanName !== 'ALL') matchQuery['paymentPlan.name'] = normalizedPlanName;
    if (minAmount || maxAmount) {
      matchQuery['paymentPlan.price'] = {};
      if (minAmount) matchQuery['paymentPlan.price'].$gte = parseFloat(minAmount);
      if (maxAmount) matchQuery['paymentPlan.price'].$lte = parseFloat(maxAmount);
    }
    if (search && String(search).trim()) {
      const escapedSearch = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matchQuery.$or = [
        { clientName: { $regex: escapedSearch, $options: 'i' } },
        { clientEmail: { $regex: escapedSearch, $options: 'i' } },
        { clientPhone: { $regex: escapedSearch, $options: 'i' } },
        { utmSource: { $regex: escapedSearch, $options: 'i' } },
        { utmMedium: { $regex: escapedSearch, $options: 'i' } },
        { utmCampaign: { $regex: escapedSearch, $options: 'i' } }
      ];
    }
    applyLeadsDateRange(matchQuery, fromDate, toDate);
    applyBookedDateRange(matchQuery, bookedFromDate, bookedToDate);
    applyTemperatureFilter(matchQuery, temperature);
    applyBdaOwnLeadScope(matchQuery, req);

    const idsPipeline = [
      { $match: matchQuery },
      { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
      { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
      { $group: { _id: '$groupKey', bookingId: { $first: '$bookingId' } } },
      { $project: { bookingId: 1, _id: 0 } },
      { $limit: limitNum }
    ];
    const results = await CampaignBookingModel.aggregate(idsPipeline);
    const bookingIds = results.map((r) => r.bookingId).filter(Boolean);

    return res.status(200).json({
      success: true,
      data: { bookingIds, total: bookingIds.length }
    });
  } catch (error) {
    console.error('Error fetching lead IDs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch lead IDs',
      error: error.message
    });
  }
};

export const updateBookingAmount = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { amount, planName } = req.body;

    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (booking.bookingStatus !== 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Can only update amount for paid bookings'
      });
    }

    const normalizedPlanName = planName ? String(planName).toUpperCase() : booking.paymentPlan?.name;
    if (!normalizedPlanName || !PLAN_CATALOG[normalizedPlanName]) {
      return res.status(400).json({
        success: false,
        message: 'Invalid plan name'
      });
    }

    const catalogPlan = PLAN_CATALOG[normalizedPlanName];
    const newAmount = amount ? parseFloat(amount) : catalogPlan.price;

    // Keep the currency the client actually paid in. PLAN_CATALOG is USD-only, so taking the
    // currency from there silently converted CAD/EUR clients to USD on every amount edit.
    const existingCurrency = normalizeCurrency(booking.paymentPlan?.currency);

    const paymentPlanUpdate = {
      name: normalizedPlanName,
      price: newAmount,
      currency: existingCurrency,
      displayPrice: formatMoney(newAmount, existingCurrency),
      selectedAt: booking.paymentPlan?.selectedAt || new Date()
    };

    const updatedBooking = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      { $set: { paymentPlan: paymentPlanUpdate } },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      data: updatedBooking
    });

  } catch (error) {
    console.error('Error updating booking amount:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update booking amount',
      error: error.message
    });
  }
};


export const handlePaidClientFromMicroservice = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      oldEmail,
      password,
      planType,
      dashboardManager,
      amountPaid,
      currency,
      amountPaidFormatted,
      mobile // Optional: mobile number without country code
    } = req.body;

    // Validate required fields
    if (!oldEmail) {
      return res.status(400).json({
        success: false,
        message: 'oldEmail is required to match leads'
      });
    }

    if (!planType) {
      return res.status(400).json({
        success: false,
        message: 'planType is required'
      });
    }

    // Normalize plan name to match PLAN_CATALOG enum
    const normalizedPlanName = String(planType).toUpperCase();
    if (!PLAN_CATALOG[normalizedPlanName]) {
      return res.status(400).json({
        success: false,
        message: `Invalid planType. Must be one of: ${Object.keys(PLAN_CATALOG).join(', ')}`
      });
    }
    const normalizedOldEmail = oldEmail.trim().toLowerCase();

    let matchQuery = {};

    // If mobile number is provided, match by either email OR mobile
    // This ensures we match leads even if email doesn't match exactly
    if (mobile) {
      const normalizedMobile = normalizePhoneForMatching(mobile);
      if (normalizedMobile) {
        // Use $or to match by either email or mobile
        matchQuery.$or = [
          { clientEmail: normalizedOldEmail },
          { clientPhone: { $regex: normalizedMobile, $options: 'i' } }
        ];
      } else {
        // If mobile normalization failed, fall back to email only
        matchQuery.clientEmail = normalizedOldEmail;
      }
    } else {
      // If no mobile provided, match by email only
      matchQuery.clientEmail = normalizedOldEmail;
    }

    // Find all matching bookings/leads
    const matchingLeads = await CampaignBookingModel.find(matchQuery);

    if (!matchingLeads || matchingLeads.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No leads found matching oldEmail: ${oldEmail}${mobile ? ` or mobile: ${mobile}` : ''}`,
        matchedCount: 0
      });
    }

    // Prepare payment plan update
    const catalogPlan = PLAN_CATALOG[normalizedPlanName];

    // Safely parse amountPaid (may be null/undefined/empty from external systems)
    const parsedAmountPaid = amountPaid !== undefined && amountPaid !== null && amountPaid !== ''
      ? parseFloat(amountPaid)
      : NaN;
    const hasValidNumericAmount = !Number.isNaN(parsedAmountPaid) && parsedAmountPaid > 0;

    const paymentAmount = hasValidNumericAmount ? parsedAmountPaid : catalogPlan.price;
    const paymentCurrency = currency || catalogPlan.currency;

    // Some external systems may send strings like "null", "$null", "undefined"
    // Treat those as invalid and fall back to our catalog/default formatting.
    const normalizedFormatted = typeof amountPaidFormatted === 'string'
      ? amountPaidFormatted.trim()
      : '';
    const lowerFormatted = normalizedFormatted.toLowerCase();
    const isInvalidFormatted =
      !normalizedFormatted ||
      lowerFormatted === 'null' ||
      lowerFormatted === 'undefined' ||
      lowerFormatted === '$null' ||
      lowerFormatted === '$undefined';

    const displayPrice = !isInvalidFormatted
      ? normalizedFormatted
      : (catalogPlan.displayPrice || `${paymentCurrency}${paymentAmount}`);

    const paymentPlanUpdate = {
      name: normalizedPlanName,
      price: paymentAmount,
      currency: paymentCurrency,
      displayPrice: displayPrice,
      selectedAt: new Date()
    };

    // Update all matching leads to mark as paid
    const updateResult = await CampaignBookingModel.updateMany(
      matchQuery,
      {
        $set: {
          bookingStatus: 'paid',
          paymentPlan: paymentPlanUpdate
        }
      }
    );

    // Log the update
    console.log(`✅ Marked ${updateResult.modifiedCount} lead(s) as paid`, {
      oldEmail: normalizedOldEmail,
      mobile: mobile || 'not provided',
      planType: normalizedPlanName,
      amountPaid: paymentAmount,
      currency: paymentCurrency
    });

    return res.status(200).json({
      success: true,
      message: `Successfully marked ${updateResult.modifiedCount} lead(s) as paid`,
      data: {
        matchedCount: matchingLeads.length,
        updatedCount: updateResult.modifiedCount,
        oldEmail: normalizedOldEmail,
        newEmail: email || null,
        planType: normalizedPlanName,
        amountPaid: paymentAmount,
        currency: paymentCurrency,
        displayPrice: displayPrice,
        updatedLeads: matchingLeads.map(lead => ({
          bookingId: lead.bookingId,
          clientName: lead.clientName,
          clientEmail: lead.clientEmail,
          clientPhone: lead.clientPhone
        }))
      }
    });

  } catch (error) {
    console.error('❌ Error handling paid client from microservice:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process paid client webhook',
      error: error.message
    });
  }
};

export const getMeetingNotes = async (req, res) => {
  try {
    const { bookingId } = req.params;
    // Fireflies integration has been disabled.
    // This endpoint now simply returns an informative response without calling external APIs.

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: 'Booking ID is required'
      });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    return res.status(200).json({
      success: false,
      message: 'Fireflies meeting-notes integration is currently disabled. Use manual notes instead.',
      hasTranscriptId: !!booking.firefliesTranscriptId
    });
  } catch (error) {
    console.error('Error fetching meeting notes:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meeting notes',
      error: error.message
    });
  }
};

export const getMeetingLinks = async (req, res) => {
  try {
    const { fromDate, toDate, page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;
    // Optional BDA filter: the meeting's ASSIGNED BDA (attendanceAssignee, else Calendly host, else CRM claim),
    // the same precedence as getAssignedBdaEmail, written as a query so counts and pages stay correct.
    const bdaEmail = typeof req.query.bdaEmail === 'string' ? req.query.bdaEmail.trim().toLowerCase().slice(0, 200) : '';
    const blank = { $in: [null, ''] };
    const assignedTo = bdaEmail
      ? {
          $or: [
            { 'attendanceAssignee.email': bdaEmail },
            { 'attendanceAssignee.email': blank, 'calendlyHost.email': bdaEmail },
            { 'attendanceAssignee.email': blank, 'calendlyHost.email': blank, 'claimedBy.email': bdaEmail },
          ],
        }
      : null;

    const now = new Date();
    const twoHoursMs = 2 * 60 * 60 * 1000;

    const cutoff = new Date(now.getTime() - 15 * 60 * 1000);
    const minMeetingDate = new Date('2026-02-03T00:00:00.000Z');
    let gte = minMeetingDate;
    if (fromDate) {
      const from = new Date(String(fromDate));
      from.setHours(0, 0, 0, 0);
      if (from > minMeetingDate) gte = from;
    }
    const startTimeCond = { $exists: true, $ne: null, $gte: gte };
    if (toDate) {
      const to = new Date(String(toDate));
      to.setHours(23, 59, 59, 999);
      startTimeCond.$lte = to;
    }
    const startTimeCondWithCutoff = { ...startTimeCond, $lt: cutoff };
    const baseMatch = {
      bookingStatus: { $nin: ['canceled', 'rescheduled'] },
      $or: [
        {
          scheduledEventEndTime: { $exists: true, $ne: null, $lt: now },
          scheduledEventStartTime: startTimeCond
        },
        {
          $and: [
            { $or: [{ scheduledEventEndTime: null }, { scheduledEventEndTime: { $exists: false } }] },
            { scheduledEventStartTime: startTimeCondWithCutoff }
          ]
        }
      ]
    };
    const match = assignedTo ? { $and: [baseMatch, assignedTo] } : baseMatch;

    const [bookings, totalCount, bdaAbsentResult] = await Promise.all([
      CampaignBookingModel.find(
        match,
        {
          clientName: 1, scheduledEventStartTime: 1, scheduledEventEndTime: 1, meetingVideoUrl: 1, bookingId: 1,
          // Read-only inputs for callSummary (phone to match calls, fields that decide the assigned BDA).
          clientPhone: 1, normalizedClientPhone: 1, calendlyHost: 1, claimedBy: 1, attendanceAssignee: 1,
          // Read-only inputs for the attendance fields (status trail and the stuck-status flag).
          bookingStatus: 1, statusHistory: 1, statusChangedAt: 1, statusChangedBy: 1, statusChangedByName: 1
        }
      )
        .sort({ scheduledEventStartTime: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CampaignBookingModel.countDocuments(match),
      CampaignBookingModel.aggregate([
        { $match: match },
        {
          $addFields: {
            meetEnd: {
              $cond: {
                if: { $and: [{ $ne: ['$scheduledEventEndTime', null] }, { $ne: ['$scheduledEventEndTime', undefined] }] },
                then: { $toLong: '$scheduledEventEndTime' },
                else: { $add: [{ $toLong: '$scheduledEventStartTime' }, 15 * 60 * 1000] }
              }
            }
          }
        },
        {
          $match: {
            $expr: {
              $and: [
                { $lte: ['$meetEnd', now.getTime() - twoHoursMs] },
                { $lte: [{ $strLenCP: { $trim: { input: { $ifNull: ['$meetingVideoUrl', ''] } } } }, 0] }
              ]
            }
          }
        },
        { $count: 'bdaAbsentCount' }
      ])
    ]);
    const bdaAbsentCount = bdaAbsentResult?.[0]?.bdaAbsentCount ?? 0;

    // BDA attendance (plan 6.3): did the assigned BDA call this client? One CallLog query for the whole page.
    const callSummaries = await getCallSummariesSafe(bookings);

    // BDA attendance (plan 9.2): verdict, status trail, deductions. Two queries for the whole page; admins see every deduction.
    const attendanceFields = await getAttendanceRowFieldsSafe(bookings, {
      email: req.crmUser?.email,
      isAdmin: await isCrmAdmin(req.crmUser).catch(() => false)
    });

    const data = bookings.map((b) => {
      const meetEnd = b.scheduledEventEndTime
        ? new Date(b.scheduledEventEndTime).getTime()
        : b.scheduledEventStartTime
          ? new Date(b.scheduledEventStartTime).getTime() + 15 * 60 * 1000
          : null;
      const hasVideo = !!(b.meetingVideoUrl && String(b.meetingVideoUrl).trim());
      const endedOver2hAgo = meetEnd !== null && now.getTime() - meetEnd >= twoHoursMs;
      const bdaAbsent = endedOver2hAgo && !hasVideo;

      return {
        bookingId: b.bookingId,
        clientName: b.clientName || '—',
        dateOfMeet: b.scheduledEventStartTime || null,
        meetingVideoUrl: hasVideo ? b.meetingVideoUrl : null,
        bdaAbsent,
        callSummary: callSummaries.get(b.bookingId) ?? null,
        attendance: attendanceFields.get(b.bookingId)?.attendance ?? null,
        statusUpdate: attendanceFields.get(b.bookingId)?.statusUpdate ?? null,
        deductions: attendanceFields.get(b.bookingId)?.deductions ?? [],
        // The Calendly Notetaker summary saved by the Apps Script: { url, summaryPreview, sentAt, bookingId } or null.
        transcript: attendanceFields.get(b.bookingId)?.transcript ?? null
      };
    });

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      bdaAbsentCount
    });
  } catch (error) {
    console.error('Error fetching meeting info:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meeting info',
      error: error.message
    });
  }
};

// ==================== LEADS ANALYTICS (Qualified Leads Graphs) ====================
export const getLeadsAnalytics = async (req, res) => {
  try {
    const { fromDate, toDate, qualification, status, planName, utmMedium, utmCampaign, minAmount, maxAmount, leadSource, bdaEmail, sourceType } = req.query;
    let utmSource = req.query.utmSource;
    if (crmUserMetaLeadsOnly(req)) {
      utmSource = 'meta_lead_ad';
    }

    // Build base match query - use scheduledEventStartTime for date (matches "Meetings from X to Y" / table)
    const matchQuery = {};
    if (qualification && qualification !== 'all') {
      const q = String(qualification).toLowerCase();
      if (q === 'mql' || q === 'sql' || q === 'converted') {
        matchQuery.bookingStatus = { $in: q === 'mql' ? MQL_STATUSES : q === 'sql' ? SQL_STATUSES : CONVERTED_STATUSES };
      }
    } else if (status && status !== 'all') {
      matchQuery.bookingStatus = status;
    }
    if (planName && planName !== 'all') {
      matchQuery['paymentPlan.name'] = String(planName).toUpperCase();
    }
    if (minAmount || maxAmount) {
      matchQuery['paymentPlan.price'] = {};
      if (minAmount) matchQuery['paymentPlan.price'].$gte = parseFloat(minAmount);
      if (maxAmount) matchQuery['paymentPlan.price'].$lte = parseFloat(maxAmount);
    }
    if (utmSource && utmSource !== 'all') {
      if (utmSource === 'meta_lead_ad') {
        matchQuery.$and = matchQuery.$and || [];
        matchQuery.$and.push({
          $or: [
            { metaLeadId: { $exists: true, $ne: null } },
            { leadSource: 'meta_lead_ad' }
          ]
        });
      } else {
        matchQuery.utmSource = caseInsensitiveExact(utmSource);
      }
    }
    if (utmCampaign && utmCampaign !== 'all') {
      matchQuery.$and = matchQuery.$and || [];
      matchQuery.$and.push({
        $or: [
          { utmCampaign: caseInsensitiveExact(utmCampaign) },
          { metaCampaignName: caseInsensitiveExact(utmCampaign) },
        ],
      });
    }
    if (utmMedium && utmMedium !== 'all') {
      matchQuery.utmMedium = caseInsensitiveExact(utmMedium);
    }
    if (leadSource && leadSource !== 'all') {
      matchQuery.leadSource = String(leadSource);
    }
    if (bdaEmail && bdaEmail !== 'all') {
      matchQuery['claimedBy.email'] = caseInsensitiveExact(bdaEmail);
    }
    // sourceType filter: 'paid' = came from paid ads, 'organic' = everything else.
    if (sourceType === 'paid' || sourceType === 'organic') {
      const paidMarkers = {
        $or: [
          { metaIsOrganic: false },
          { utmMedium: { $in: [/^cpc$/i, /^ppc$/i, /^paid$/i, /^paid[_-]?social$/i] } },
          { metaAdId: { $exists: true, $nin: [null, ''] } },
        ],
      };
      matchQuery.$and = matchQuery.$and || [];
      matchQuery.$and.push(sourceType === 'paid' ? paidMarkers : { $nor: [paidMarkers] });
    }

    applyLeadsDateRange(matchQuery, fromDate, toDate);
    applyBdaOwnLeadScope(matchQuery, req);

    // Qualification add-fields expression (reusable)
    const qualExpr = {
      $cond: [
        { $in: ['$bookingStatus', CONVERTED_STATUSES] },
        'Converted',
        { $cond: [{ $in: ['$bookingStatus', SQL_STATUSES] }, 'SQL', 'MQL'] }
      ]
    };

    // Paid vs organic source-type expression.
    // Organic = known direct/website/tool sources. Everything else (any new source) = paid.
    const ORGANIC_SOURCES = ['WEBSITE', 'direct', 'webpage_visit', 'google', 'chatgpt.com', 'copilot.com'];
    const sourceTypeExpr = {
      $cond: [
        { $in: [{ $ifNull: ['$utmSource', ''] }, ORGANIC_SOURCES] },
        'organic',
        'paid',
      ],
    };

    // source|medium pairs tracked by the "Direct leads → meetings" graph.
    const DIRECT_MEETING_PAIRS = [
      'direct|(none)',
      'WEBSITE|Hero_Section',
      'WEBSITE|Navigation_Navbar_Button',
      'webpage_visit|website',
      'direct|paid',
      'WEBSITE|Result_Stats_Section',
    ];

    // Run all aggregation pipelines concurrently for max performance
    const [
      funnelResult,
      trendResult,
      conversionTrendResult,
      revenueByPlanResult,
      revenueTrendResult,
      sourceResult,
      sourceConversionResult,
      dayOfWeekResult,
      hourOfDayResult,
      statusBreakdownResult,
      avgDealSizeResult,
      leadAgingResult,
      planDistResult,
      planConversionResult,
      velocityResult,
      bdaResult,
      leadSourceTypeResult,
      monthlyComparisonResult,
      monthlyStatusResult,
      monthlySourceTypeResult,
      utmSourceMonthlyResult,
      utmMediumMonthlyResult,
      utmSourceStatusResult,
      utmMediumStatusResult,
      metaLeadsMonthlyResult,
      leadsVsBookedResult,
      weeklyOutcomesResult,
      dailyOutcomesResult,
      monthlyOutcomesResult,
      noShowMonthlyResult,
      noShowDailyResult,
      noShowCallsResult,
      noShowCallsDailyResult,
      directMeetingsMonthlyResult
    ] = await Promise.all([

      // 1. FUNNEL: MQL → SQL → Converted counts (deduplicated by client, same as table)
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
        { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
        { $group: { _id: '$groupKey', bookingStatus: { $first: '$bookingStatus' } } },
        {
          $addFields: {
            qualification: {
              $cond: [
                { $in: ['$bookingStatus', CONVERTED_STATUSES] },
                'Converted',
                { $cond: [{ $in: ['$bookingStatus', SQL_STATUSES] }, 'SQL', 'MQL'] }
              ]
            }
          }
        },
        { $group: { _id: '$qualification', count: { $sum: 1 } } }
      ]),

      // 2. LEAD VOLUME TREND: Daily leads with qualification breakdown
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { qualification: qualExpr } },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$bookingCreatedAt' } },
              qualification: '$qualification'
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.date': 1 } },
        {
          $group: {
            _id: '$_id.date',
            breakdown: { $push: { qualification: '$_id.qualification', count: '$count' } },
            total: { $sum: '$count' }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 3. CONVERSION RATE TREND: Weekly conversion rates
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { qualification: qualExpr } },
        {
          $group: {
            _id: {
              week: { $dateToString: { format: '%Y-W%V', date: '$bookingCreatedAt' } }
            },
            total: { $sum: 1 },
            sqlCount: { $sum: { $cond: [{ $eq: ['$qualification', 'SQL'] }, 1, 0] } },
            convertedCount: { $sum: { $cond: [{ $eq: ['$qualification', 'Converted'] }, 1, 0] } },
            mqlCount: { $sum: { $cond: [{ $eq: ['$qualification', 'MQL'] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            week: '$_id.week',
            total: 1,
            sqlRate: { $cond: [{ $eq: ['$total', 0] }, 0, { $multiply: [{ $divide: ['$sqlCount', '$total'] }, 100] }] },
            convertedRate: { $cond: [{ $eq: ['$total', 0] }, 0, { $multiply: [{ $divide: ['$convertedCount', '$total'] }, 100] }] },
            mqlRate: { $cond: [{ $eq: ['$total', 0] }, 0, { $multiply: [{ $divide: ['$mqlCount', '$total'] }, 100] }] }
          }
        }
      ]),

      // 4. REVENUE BY PLAN
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, bookingStatus: 'paid', 'paymentPlan.name': { $ne: null } } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $group: {
            _id: '$paymentPlan.name',
            revenue: { $sum: { $ifNull: ['$paymentPlan.price', 0] } },
            count: { $sum: 1 },
            avgDeal: { $avg: { $ifNull: ['$paymentPlan.price', 0] } }
          }
        },
        { $sort: { revenue: -1 } }
      ]),

      // 5. REVENUE TREND: Monthly revenue
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, bookingStatus: 'paid' } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$bookingCreatedAt' } },
            revenue: { $sum: { $ifNull: ['$paymentPlan.price', 0] } },
            deals: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 6. LEADS BY SOURCE (utmSource)
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { qualification: qualExpr } },
        {
          $group: {
            _id: { $ifNull: ['$utmSource', 'direct'] },
            total: { $sum: 1 },
            mql: { $sum: { $cond: [{ $eq: ['$qualification', 'MQL'] }, 1, 0] } },
            sql: { $sum: { $cond: [{ $eq: ['$qualification', 'SQL'] }, 1, 0] } },
            converted: { $sum: { $cond: [{ $eq: ['$qualification', 'Converted'] }, 1, 0] } }
          }
        },
        { $sort: { total: -1 } },
        { $limit: 15 }
      ]),

      // 7. CONVERSION RATE BY SOURCE
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { qualification: qualExpr } },
        {
          $group: {
            _id: { $ifNull: ['$utmSource', 'direct'] },
            total: { $sum: 1 },
            converted: { $sum: { $cond: [{ $eq: ['$qualification', 'Converted'] }, 1, 0] } },
            sql: { $sum: { $cond: [{ $eq: ['$qualification', 'SQL'] }, 1, 0] } }
          }
        },
        { $match: { total: { $gte: 3 } } },
        {
          $project: {
            source: '$_id',
            total: 1,
            conversionRate: { $cond: [{ $eq: ['$total', 0] }, 0, { $multiply: [{ $divide: ['$converted', '$total'] }, 100] }] },
            sqlRate: { $cond: [{ $eq: ['$total', 0] }, 0, { $multiply: [{ $divide: ['$sql', '$total'] }, 100] }] }
          }
        },
        { $sort: { conversionRate: -1 } },
        { $limit: 10 }
      ]),

      // 8. LEADS BY DAY OF WEEK
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { qualification: qualExpr } },
        {
          $group: {
            _id: { $dayOfWeek: '$bookingCreatedAt' },
            total: { $sum: 1 },
            converted: { $sum: { $cond: [{ $eq: ['$qualification', 'Converted'] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 9. LEADS BY HOUR OF DAY
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $group: {
            _id: { $hour: '$bookingCreatedAt' },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 10. STATUS BREAKDOWN — distinct (client, status) pairs, so each status counts every
      // unique client who held it in range. Matches the per-status filtered table count,
      // same rule as statusBreakdown in getLeadsPaginated.
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
        { $group: { _id: { groupKey: '$groupKey', bookingStatus: '$bookingStatus' } } },
        { $group: { _id: '$_id.bookingStatus', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),

      // 11. AVERAGE DEAL SIZE BY PLAN
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, bookingStatus: 'paid', 'paymentPlan.price': { $gt: 0 } } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $group: {
            _id: '$paymentPlan.name',
            avgDeal: { $avg: '$paymentPlan.price' },
            minDeal: { $min: '$paymentPlan.price' },
            maxDeal: { $max: '$paymentPlan.price' },
            count: { $sum: 1 }
          }
        },
        { $sort: { avgDeal: -1 } }
      ]),

      // 12. LEAD AGING: How long leads sit in current status
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, bookingStatus: { $in: MQL_STATUSES } } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $addFields: {
            ageDays: {
              $divide: [{ $subtract: [new Date(), '$bookingCreatedAt'] }, 86400000]
            }
          }
        },
        {
          $bucket: {
            groupBy: '$ageDays',
            boundaries: [0, 7, 14, 30, 60, 90, 180, 365],
            default: '365+',
            output: { count: { $sum: 1 } }
          }
        }
      ]),

      // 13. PLAN DISTRIBUTION
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, 'paymentPlan.name': { $ne: null } } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $group: {
            _id: '$paymentPlan.name',
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } }
      ]),

      // 14. PLAN CONVERSION RATES
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, 'paymentPlan.name': { $ne: null } } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $group: {
            _id: '$paymentPlan.name',
            total: { $sum: 1 },
            paid: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'completed'] }, 1, 0] } }
          }
        },
        {
          $project: {
            plan: '$_id',
            total: 1,
            paidRate: { $cond: [{ $eq: ['$total', 0] }, 0, { $multiply: [{ $divide: ['$paid', '$total'] }, 100] }] },
            sqlRate: { $cond: [{ $eq: ['$total', 0] }, 0, { $multiply: [{ $divide: ['$completed', '$total'] }, 100] }] }
          }
        },
        { $sort: { paidRate: -1 } }
      ]),

      // 15. VELOCITY: Avg days from creation to paid
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, bookingStatus: 'paid', 'paymentPlan.selectedAt': { $ne: null } } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] },
            'paymentPlan.selectedAt': { $cond: [{ $ne: ['$paymentPlan.selectedAt', null] }, { $toDate: '$paymentPlan.selectedAt' }, null] }
        } },
        {
          $addFields: {
            daysToConvert: {
              $divide: [{ $subtract: ['$paymentPlan.selectedAt', '$bookingCreatedAt'] }, 86400000]
            }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$bookingCreatedAt' } },
            avgDays: { $avg: '$daysToConvert' },
            minDays: { $min: '$daysToConvert' },
            maxDays: { $max: '$daysToConvert' },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 16. BDA PERFORMANCE
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, 'claimedBy.email': { $ne: null } } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $group: {
            _id: { email: '$claimedBy.email', name: '$claimedBy.name' },
            claimed: { $sum: 1 },
            converted: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'completed'] }, 1, 0] } },
            revenue: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, { $ifNull: ['$paymentPlan.price', 0] }, 0] } }
          }
        },
        { $sort: { converted: -1, claimed: -1 } },
        { $limit: 20 }
      ]),

      // 17. LEAD SOURCE TYPE: calendly vs meta vs manual etc.
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { qualification: qualExpr } },
        {
          $group: {
            _id: { $ifNull: ['$leadSource', 'calendly'] },
            total: { $sum: 1 },
            mql: { $sum: { $cond: [{ $eq: ['$qualification', 'MQL'] }, 1, 0] } },
            sql: { $sum: { $cond: [{ $eq: ['$qualification', 'SQL'] }, 1, 0] } },
            converted: { $sum: { $cond: [{ $eq: ['$qualification', 'Converted'] }, 1, 0] } }
          }
        },
        { $sort: { total: -1 } }
      ]),

      // 18. MONTH-OVER-MONTH COMPARISON
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { qualification: qualExpr } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$bookingCreatedAt' } },
            total: { $sum: 1 },
            mql: { $sum: { $cond: [{ $eq: ['$qualification', 'MQL'] }, 1, 0] } },
            sql: { $sum: { $cond: [{ $eq: ['$qualification', 'SQL'] }, 1, 0] } },
            converted: { $sum: { $cond: [{ $eq: ['$qualification', 'Converted'] }, 1, 0] } },
            revenue: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, { $ifNull: ['$paymentPlan.price', 0] }, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 19. MONTHLY STATUS BREAKDOWN — matches the Leads table exactly.
      // Filter by month FIRST, then deduplicate by client within that month.
      // This matches leads tab behaviour: "show me all unique clients whose meeting
      // was in May, with their current status in May".
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, scheduledEventStartTime: { $ne: null, $exists: true } } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: {
          groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] },
          month: { $dateToString: { format: '%Y-%m', date: '$scheduledEventStartTime' } }
        }},
        { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
        {
          // one row per client per month — latest booking in that month wins
          $group: {
            _id: { groupKey: '$groupKey', month: '$month' },
            bookingStatus: { $first: '$bookingStatus' },
          }
        },
        {
          $group: {
            _id: '$_id.month',
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'completed'] }, 1, 0] } },
            noShow: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no-show'] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'canceled'] }, 1, 0] } },
            rescheduled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'rescheduled'] }, 1, 0] } },
            paid: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, 1, 0] } },
            scheduled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'scheduled'] }, 1, 0] } },
            notScheduled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'not-scheduled'] }, 1, 0] } },
            ignored: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'ignored'] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 20. MONTHLY PAID vs ORGANIC LEADS — also deduplicated by client,
      // bucketed by meeting date (same as #19).
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] }, sourceType: sourceTypeExpr } },
        { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
        {
          $group: {
            _id: '$groupKey',
            sourceType: { $first: '$sourceType' },
            monthDate: { $first: { $ifNull: ['$scheduledEventStartTime', '$bookingCreatedAt'] } }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$monthDate' } },
            total: { $sum: 1 },
            paid: { $sum: { $cond: [{ $eq: ['$sourceType', 'paid'] }, 1, 0] } },
            organic: { $sum: { $cond: [{ $eq: ['$sourceType', 'organic'] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 21. MONTHLY BY UTM SOURCE — deduped by client, bucketed by meeting month.
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
        { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
        {
          $group: {
            _id: '$groupKey',
            utmSource: { $first: { $ifNull: ['$utmSource', 'direct'] } },
            monthDate: { $first: { $ifNull: ['$scheduledEventStartTime', '$bookingCreatedAt'] } }
          }
        },
        {
          $group: {
            _id: {
              month: { $dateToString: { format: '%Y-%m', date: '$monthDate' } },
              source: '$utmSource'
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.month': 1 } }
      ]),

      // 22. MONTHLY BY UTM MEDIUM — deduped by client, bucketed by meeting month.
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
        { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
        {
          $group: {
            _id: '$groupKey',
            utmMedium: { $first: { $ifNull: ['$utmMedium', 'none'] } },
            monthDate: { $first: { $ifNull: ['$scheduledEventStartTime', '$bookingCreatedAt'] } }
          }
        },
        {
          $group: {
            _id: {
              month: { $dateToString: { format: '%Y-%m', date: '$monthDate' } },
              medium: '$utmMedium'
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.month': 1 } }
      ]),

      // 23. UTM SOURCE — leads + current status, per month (deduped by client).
      // Month bucket = meeting month, so the Graphs UTM table can be filtered by month.
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
        { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
        {
          $group: {
            _id: '$groupKey',
            utmSource: { $first: { $ifNull: ['$utmSource', 'direct'] } },
            bookingStatus: { $first: '$bookingStatus' },
            monthDate: { $first: { $ifNull: ['$scheduledEventStartTime', '$bookingCreatedAt'] } }
          }
        },
        {
          $group: {
            _id: {
              month: { $dateToString: { format: '%Y-%m', date: '$monthDate' } },
              source: '$utmSource'
            },
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'completed'] }, 1, 0] } },
            noShow: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no-show'] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'canceled'] }, 1, 0] } },
            rescheduled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'rescheduled'] }, 1, 0] } },
            paid: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, 1, 0] } },
            scheduled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'scheduled'] }, 1, 0] } },
            notScheduled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'not-scheduled'] }, 1, 0] } }
          }
        },
        { $sort: { '_id.month': 1 } }
      ]),

      // 24. UTM MEDIUM — leads + current status, per month (deduped by client).
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
        { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
        {
          $group: {
            _id: '$groupKey',
            utmMedium: { $first: { $ifNull: ['$utmMedium', 'none'] } },
            bookingStatus: { $first: '$bookingStatus' },
            monthDate: { $first: { $ifNull: ['$scheduledEventStartTime', '$bookingCreatedAt'] } }
          }
        },
        {
          $group: {
            _id: {
              month: { $dateToString: { format: '%Y-%m', date: '$monthDate' } },
              medium: '$utmMedium'
            },
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'completed'] }, 1, 0] } },
            noShow: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no-show'] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'canceled'] }, 1, 0] } },
            rescheduled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'rescheduled'] }, 1, 0] } },
            paid: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, 1, 0] } },
            scheduled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'scheduled'] }, 1, 0] } },
            notScheduled: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'not-scheduled'] }, 1, 0] } }
          }
        },
        { $sort: { '_id.month': 1 } }
      ]),

      // 25. META LEADS — booked a meeting vs not, per month (deduped by client).
      // Meta lead = has metaLeadId or leadSource 'meta_lead_ad'.
      // Booked = current status is anything other than 'not-scheduled'.
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $match: { leadSource: 'meta_lead_ad' } },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $addFields: {
            month: { $dateToString: { format: '%Y-%m', date: '$bookingCreatedAt' } }
          }
        },
        {
          $group: {
            _id: '$month',
            total: { $sum: 1 },
            booked: { $sum: { $cond: [{ $ne: ['$bookingStatus', 'not-scheduled'] }, 1, 0] } },
            notBooked: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'not-scheduled'] }, 1, 0] } }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 26. LEADS vs BOOKED A MEETING — per form-fill month, deduped by client.
      // "Booked" = an actual calendar event exists (scheduledEventStartTime), NOT
      // just status != not-scheduled. Status alone overcounts: manually-created /
      // imported leads carry a booked-ish status with no real meeting. Bucketed by
      // first form-fill (bookingCreatedAt) so it's a clean per-cohort booking rate.
      // Also splits out the Meta subset and carries completed/paid for the funnel.
      CampaignBookingModel.aggregate([
        { $match: matchQuery },
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        {
          $addFields: {
            groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] },
            isMeta: { $cond: [{ $or: [{ $ne: [{ $ifNull: ['$metaLeadId', null] }, null] }, { $eq: ['$leadSource', 'meta_lead_ad'] }] }, 1, 0] },
          }
        },
        {
          $group: {
            _id: '$groupKey',
            isMeta: { $max: '$isMeta' },
            hasMeeting: { $max: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, 1, 0] } },
            everCompleted: { $max: { $cond: [{ $in: ['$bookingStatus', ['completed', 'paid']] }, 1, 0] } },
            everPaid: { $max: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, 1, 0] } },
            firstSeen: { $min: { $ifNull: ['$bookingCreatedAt', '$scheduledEventStartTime'] } },
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$firstSeen' } },
            leads: { $sum: 1 },
            booked: { $sum: '$hasMeeting' },
            metaLeads: { $sum: '$isMeta' },
            metaBooked: { $sum: { $cond: [{ $eq: ['$isMeta', 1] }, '$hasMeeting', 0] } },
            completed: { $sum: '$everCompleted' },
            paid: { $sum: '$everPaid' },
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // 27. WEEKLY MEETING OUTCOMES — completed/no-show/canceled/rescheduled
      // Bucketed by scheduledEventStartTime week. Splits ALL vs META leads.
      CampaignBookingModel.aggregate([
        { $match: {
          ...matchQuery,
          bookingStatus: { $in: ['completed', 'paid', 'no-show', 'canceled', 'rescheduled', 'scheduled'] },
          scheduledEventStartTime: { $ne: null }
        }},
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: {
          week: { $dateToString: { format: '%Y-W%V', date: '$scheduledEventStartTime' } },
          isMeta: { $cond: [{ $eq: ['$leadSource', 'meta_lead_ad'] }, 1, 0] }
        }},
        { $group: {
          _id: '$week',
          completed:       { $sum: { $cond: [{ $in: ['$bookingStatus', ['completed','paid']] }, 1, 0] } },
          noShow:          { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no-show'] }, 1, 0] } },
          canceled:        { $sum: { $cond: [{ $eq: ['$bookingStatus', 'canceled'] }, 1, 0] } },
          rescheduled:     { $sum: { $cond: [{ $eq: ['$bookingStatus', 'rescheduled'] }, 1, 0] } },
          scheduled:       { $sum: { $cond: [{ $eq: ['$bookingStatus', 'scheduled'] }, 1, 0] } },
          metaCompleted:   { $sum: { $cond: [{ $and: [{ $in: ['$bookingStatus', ['completed','paid']] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaNoShow:      { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'no-show'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaCanceled:    { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'canceled'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaRescheduled: { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'rescheduled'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaScheduled:   { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'scheduled'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
        }},
        { $sort: { _id: 1 } }
      ]),

      // 28. DAILY MEETING OUTCOMES
      CampaignBookingModel.aggregate([
        { $match: {
          ...matchQuery,
          bookingStatus: { $in: ['completed', 'paid', 'no-show', 'canceled', 'rescheduled', 'scheduled'] },
          scheduledEventStartTime: { $ne: null }
        }},
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$scheduledEventStartTime' } },
          isMeta: { $cond: [{ $eq: ['$leadSource', 'meta_lead_ad'] }, 1, 0] }
        }},
        { $group: {
          _id: '$day',
          completed:       { $sum: { $cond: [{ $in: ['$bookingStatus', ['completed','paid']] }, 1, 0] } },
          noShow:          { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no-show'] }, 1, 0] } },
          canceled:        { $sum: { $cond: [{ $eq: ['$bookingStatus', 'canceled'] }, 1, 0] } },
          rescheduled:     { $sum: { $cond: [{ $eq: ['$bookingStatus', 'rescheduled'] }, 1, 0] } },
          scheduled:       { $sum: { $cond: [{ $eq: ['$bookingStatus', 'scheduled'] }, 1, 0] } },
          metaCompleted:   { $sum: { $cond: [{ $and: [{ $in: ['$bookingStatus', ['completed','paid']] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaNoShow:      { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'no-show'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaCanceled:    { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'canceled'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaRescheduled: { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'rescheduled'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaScheduled:   { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'scheduled'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
        }},
        { $sort: { _id: 1 } }
      ]),

      // 29. MONTHLY MEETING OUTCOMES
      CampaignBookingModel.aggregate([
        { $match: {
          ...matchQuery,
          bookingStatus: { $in: ['completed', 'paid', 'no-show', 'canceled', 'rescheduled', 'scheduled'] },
          scheduledEventStartTime: { $ne: null }
        }},
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: {
          month: { $dateToString: { format: '%Y-%m', date: '$scheduledEventStartTime' } },
          isMeta: { $cond: [{ $eq: ['$leadSource', 'meta_lead_ad'] }, 1, 0] }
        }},
        { $group: {
          _id: '$month',
          completed:       { $sum: { $cond: [{ $in: ['$bookingStatus', ['completed','paid']] }, 1, 0] } },
          noShow:          { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no-show'] }, 1, 0] } },
          canceled:        { $sum: { $cond: [{ $eq: ['$bookingStatus', 'canceled'] }, 1, 0] } },
          rescheduled:     { $sum: { $cond: [{ $eq: ['$bookingStatus', 'rescheduled'] }, 1, 0] } },
          scheduled:       { $sum: { $cond: [{ $eq: ['$bookingStatus', 'scheduled'] }, 1, 0] } },
          metaCompleted:   { $sum: { $cond: [{ $and: [{ $in: ['$bookingStatus', ['completed','paid']] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaNoShow:      { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'no-show'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaCanceled:    { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'canceled'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaRescheduled: { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'rescheduled'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
          metaScheduled:   { $sum: { $cond: [{ $and: [{ $eq: ['$bookingStatus', 'scheduled'] }, { $eq: ['$isMeta', 1] }] }, 1, 0] } },
        }},
        { $sort: { _id: 1 } }
      ]),

      // 30. NO-SHOW MONTHLY — no-shows + total meetings per month
      CampaignBookingModel.aggregate([
        { $match: {
          ...matchQuery,
          bookingStatus: { $in: ['completed','paid','no-show','canceled'] },
          scheduledEventStartTime: { $ne: null }
        }},
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { month: { $dateToString: { format: '%Y-%m', date: '$scheduledEventStartTime' } } } },
        { $group: {
          _id: '$month',
          noShow: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no-show'] }, 1, 0] } },
          total:  { $sum: 1 }
        }},
        { $sort: { _id: 1 } }
      ]),

      // 31. NO-SHOW DAILY — no-shows + total meetings per day
      CampaignBookingModel.aggregate([
        { $match: {
          ...matchQuery,
          bookingStatus: { $in: ['completed','paid','no-show','canceled'] },
          scheduledEventStartTime: { $ne: null }
        }},
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: { day: { $dateToString: { format: '%Y-%m-%d', date: '$scheduledEventStartTime' } } } },
        { $group: {
          _id: '$day',
          noShow: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no-show'] }, 1, 0] } },
          total:  { $sum: 1 }
        }},
        { $sort: { _id: 1 } }
      ]),

      // 32. NO-SHOW vs CALLS MONTHLY — May 2026 onwards
      // Join on phone number (leadNumberNormalized) to match leads tab behaviour
      CampaignBookingModel.aggregate([
        { $match: {
          bookingStatus: 'no-show',
          scheduledEventStartTime: { $gte: new Date('2026-05-22') },
          clientPhone: { $ne: null }
        }},
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: {
          phoneStripped: { $replaceAll: { input: '$clientPhone', find: '+', replacement: '' } }
        }},
        { $addFields: {
          phoneNorm: { $substr: ['$phoneStripped', { $subtract: [{ $strLenCP: '$phoneStripped' }, 10] }, 10] }
        }},
        { $lookup: {
          from: 'calllogs',
          localField: 'phoneNorm',
          foreignField: 'leadNumberNormalized',
          as: 'calls'
        }},
        { $addFields: {
          month: { $dateToString: { format: '%Y-%m', date: '$scheduledEventStartTime' } },
          wasCalled: { $gt: [{ $size: '$calls' }, 0] }
        }},
        { $group: {
          _id: '$month',
          called:    { $sum: { $cond: ['$wasCalled', 1, 0] } },
          notCalled: { $sum: { $cond: ['$wasCalled', 0, 1] } },
          total:     { $sum: 1 }
        }},
        { $sort: { _id: 1 } }
      ]),

      // 33. NO-SHOW vs CALLS DAILY — last 10 days
      CampaignBookingModel.aggregate([
        { $match: {
          bookingStatus: 'no-show',
          scheduledEventStartTime: { $gte: new Date('2026-05-22') },
          clientPhone: { $ne: null }
        }},
        { $addFields: {
            bookingCreatedAt: { $toDate: { $ifNull: ['$bookingCreatedAt', new Date(0)] } },
            scheduledEventStartTime: { $cond: [{ $ne: ['$scheduledEventStartTime', null] }, { $toDate: '$scheduledEventStartTime' }, null] }
        } },
        { $addFields: {
          phoneStripped: { $replaceAll: { input: '$clientPhone', find: '+', replacement: '' } }
        }},
        { $addFields: {
          phoneNorm: { $substr: ['$phoneStripped', { $subtract: [{ $strLenCP: '$phoneStripped' }, 10] }, 10] }
        }},
        { $lookup: {
          from: 'calllogs',
          localField: 'phoneNorm',
          foreignField: 'leadNumberNormalized',
          as: 'calls'
        }},
        { $addFields: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$scheduledEventStartTime' } },
          wasCalled: { $gt: [{ $size: '$calls' }, 0] }
        }},
        { $group: {
          _id: '$day',
          called:    { $sum: { $cond: ['$wasCalled', 1, 0] } },
          notCalled: { $sum: { $cond: ['$wasCalled', 0, 1] } },
          total:     { $sum: 1 }
        }},
        { $sort: { _id: -1 } },
        { $limit: 10 },
        { $sort: { _id: 1 } }
      ]),

      // 33. DIRECT-TRAFFIC MEETINGS MONTHLY — meetings (any booking with a scheduled time,
      // any status) for a fixed set of direct/organic utmSource + utmMedium pairs, bucketed
      // by meeting month (US Eastern). Not deduped: one row = one meeting.
      CampaignBookingModel.aggregate([
        { $match: { ...matchQuery, scheduledEventStartTime: { $ne: null } } },
        { $addFields: {
            scheduledEventStartTime: { $toDate: '$scheduledEventStartTime' },
            src: { $ifNull: ['$utmSource', 'direct'] },
            med: { $cond: [{ $in: [{ $ifNull: ['$utmMedium', ''] }, ['']] }, '(none)', '$utmMedium'] }
        } },
        { $match: { $expr: { $in: [{ $concat: ['$src', '|', '$med'] }, DIRECT_MEETING_PAIRS] } } },
        { $group: {
          _id: {
            month: { $dateToString: { format: '%Y-%m', date: '$scheduledEventStartTime', timezone: 'America/New_York' } },
            source: '$src',
            medium: '$med'
          },
          count: { $sum: 1 }
        }},
        { $sort: { '_id.month': 1 } }
      ])
    ]);

    // Transform results
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const agingLabels = { 0: '0-7d', 7: '7-14d', 14: '14-30d', 30: '30-60d', 60: '60-90d', 90: '90-180d', 180: '180-365d', '365+': '365+d' };

    const funnel = {
      mql: funnelResult.find(r => r._id === 'MQL')?.count ?? 0,
      sql: funnelResult.find(r => r._id === 'SQL')?.count ?? 0,
      converted: funnelResult.find(r => r._id === 'Converted')?.count ?? 0
    };
    funnel.total = funnel.mql + funnel.sql + funnel.converted;
    funnel.mqlToSqlRate = funnel.mql > 0 ? ((funnel.sql + funnel.converted) / (funnel.mql + funnel.sql + funnel.converted) * 100) : 0;
    // SQL→Converted: of those who reached SQL (completed), what % converted to paid
    funnel.sqlToConvertedRate = funnel.sql > 0 ? (funnel.converted / funnel.sql * 100) : (funnel.converted > 0 ? 100 : 0);
    funnel.overallConversion = funnel.total > 0 ? (funnel.converted / funnel.total * 100) : 0;

    const volumeTrend = trendResult.map(day => {
      const row = { date: day._id, total: day.total, MQL: 0, SQL: 0, Converted: 0 };
      day.breakdown.forEach(b => { row[b.qualification] = b.count; });
      return row;
    });

    const conversionTrend = conversionTrendResult.map(w => ({
      week: w._id.week,
      sqlRate: Math.round(w.sqlRate * 10) / 10,
      convertedRate: Math.round(w.convertedRate * 10) / 10,
      total: w.total
    }));

    const revenueByPlan = revenueByPlanResult.map(r => ({
      plan: r._id,
      revenue: r.revenue,
      count: r.count,
      avgDeal: Math.round(r.avgDeal)
    }));

    const revenueTrend = revenueTrendResult.map(r => ({
      month: r._id,
      revenue: r.revenue,
      deals: r.deals
    }));

    const sourceBreakdown = sourceResult.map(r => ({
      source: r._id,
      total: r.total,
      mql: r.mql,
      sql: r.sql,
      converted: r.converted
    }));

    const sourceConversion = sourceConversionResult.map(r => ({
      source: r._id,
      total: r.total,
      conversionRate: Math.round(r.conversionRate * 10) / 10,
      sqlRate: Math.round(r.sqlRate * 10) / 10
    }));

    const dayOfWeek = dayOfWeekResult.map(r => ({
      day: dayNames[r._id - 1] || `Day ${r._id}`,
      dayNum: r._id,
      total: r.total,
      converted: r.converted
    }));

    const hourOfDay = hourOfDayResult.map(r => ({
      hour: r._id,
      label: `${r._id.toString().padStart(2, '0')}:00`,
      count: r.count
    }));

    const statusBreakdown = statusBreakdownResult.map(r => ({
      status: r._id,
      count: r.count
    }));

    const avgDealSize = avgDealSizeResult.map(r => ({
      plan: r._id,
      avgDeal: Math.round(r.avgDeal),
      minDeal: r.minDeal,
      maxDeal: r.maxDeal,
      count: r.count
    }));

    const leadAging = leadAgingResult.map(r => ({
      bucket: agingLabels[r._id] || `${r._id}+d`,
      count: r.count
    }));

    const planDistribution = planDistResult.map(r => ({
      plan: r._id,
      count: r.count
    }));

    const planConversion = planConversionResult.map(r => ({
      plan: r._id,
      total: r.total,
      paidRate: Math.round(r.paidRate * 10) / 10,
      sqlRate: Math.round(r.sqlRate * 10) / 10
    }));

    const velocity = velocityResult.map(r => ({
      month: r._id,
      avgDays: Math.round(r.avgDays * 10) / 10,
      minDays: Math.round(r.minDays * 10) / 10,
      maxDays: Math.round(r.maxDays * 10) / 10,
      count: r.count
    }));

    const bdaPerformance = bdaResult.map(r => ({
      name: r._id.name || r._id.email,
      email: r._id.email,
      claimed: r.claimed,
      converted: r.converted,
      completed: r.completed,
      revenue: r.revenue,
      conversionRate: r.claimed > 0 ? Math.round((r.converted / r.claimed) * 1000) / 10 : 0
    }));

    const leadSourceType = leadSourceTypeResult.map(r => ({
      source: r._id,
      total: r.total,
      mql: r.mql,
      sql: r.sql,
      converted: r.converted
    }));

    const monthlyComparison = monthlyComparisonResult.map(r => ({
      month: r._id,
      total: r.total,
      mql: r.mql,
      sql: r.sql,
      converted: r.converted,
      revenue: r.revenue
    }));

    const monthlyStatus = monthlyStatusResult.map(r => ({
      month: r._id,
      total: r.total,
      completed: r.completed,
      noShow: r.noShow,
      cancelled: r.cancelled,
      rescheduled: r.rescheduled,
      paid: r.paid,
      scheduled: r.scheduled,
      notScheduled: r.notScheduled,
      ignored: r.ignored ?? 0
    }));

    const monthlySourceType = monthlySourceTypeResult.map(r => ({
      month: r._id,
      total: r.total,
      paid: r.paid,
      organic: r.organic
    }));

    const utmSourceMonthly = utmSourceMonthlyResult.map(r => ({
      month: r._id.month,
      source: r._id.source,
      count: r.count
    }));

    const utmMediumMonthly = utmMediumMonthlyResult.map(r => ({
      month: r._id.month,
      medium: r._id.medium,
      count: r.count
    }));

    const utmSourceStatus = utmSourceStatusResult.map(r => ({
      month: r._id.month,
      source: r._id.source,
      total: r.total,
      completed: r.completed,
      noShow: r.noShow,
      cancelled: r.cancelled,
      rescheduled: r.rescheduled,
      paid: r.paid,
      scheduled: r.scheduled,
      notScheduled: r.notScheduled
    }));

    const utmMediumStatus = utmMediumStatusResult.map(r => ({
      month: r._id.month,
      medium: r._id.medium,
      total: r.total,
      completed: r.completed,
      noShow: r.noShow,
      cancelled: r.cancelled,
      rescheduled: r.rescheduled,
      paid: r.paid,
      scheduled: r.scheduled,
      notScheduled: r.notScheduled
    }));

    const metaLeadsMonthly = metaLeadsMonthlyResult.map(r => ({
      month: r._id,
      total: r.total,
      booked: r.booked,
      notBooked: r.notBooked
    }));

    const leadsVsBooked = leadsVsBookedResult.map(r => ({
      month: r._id,
      leads: r.leads,
      booked: r.booked,
      metaLeads: r.metaLeads,
      metaBooked: r.metaBooked,
      completed: r.completed,
      paid: r.paid
    }));

    const mapOutcomes = (arr, key) => arr.map(r => ({
      [key]: r._id,
      completed: r.completed, noShow: r.noShow, canceled: r.canceled, rescheduled: r.rescheduled, scheduled: r.scheduled,
      metaCompleted: r.metaCompleted, metaNoShow: r.metaNoShow,
      metaCanceled: r.metaCanceled, metaRescheduled: r.metaRescheduled, metaScheduled: r.metaScheduled,
    }));

    const mapNoShow = (arr) => arr.map(r => ({
      period: r._id,
      noShow: r.noShow,
      total:  r.total,
      rate:   r.total > 0 ? Math.round(r.noShow / r.total * 1000) / 10 : 0,
    }));
    const noShowMonthly = mapNoShow(noShowMonthlyResult);
    const noShowDaily   = mapNoShow(noShowDailyResult);

    const noShowCalls = noShowCallsResult.map(r => ({
      month: r._id,
      called: r.called,
      notCalled: r.notCalled,
      total: r.total,
    }));

    const noShowCallsDaily = noShowCallsDailyResult.map(r => ({
      day: r._id,
      called: r.called,
      notCalled: r.notCalled,
      total: r.total,
    }));

    const weeklyOutcomes  = mapOutcomes(weeklyOutcomesResult,  'week');
    const dailyOutcomes   = mapOutcomes(dailyOutcomesResult,   'day');
    const monthlyOutcomes = mapOutcomes(monthlyOutcomesResult, 'month');

    return res.status(200).json({
      success: true,
      data: {
        funnel,
        volumeTrend,
        conversionTrend,
        revenueByPlan,
        revenueTrend,
        sourceBreakdown,
        sourceConversion,
        dayOfWeek,
        hourOfDay,
        statusBreakdown,
        avgDealSize,
        leadAging,
        planDistribution,
        planConversion,
        velocity,
        bdaPerformance,
        leadSourceType,
        monthlyComparison,
        monthlyStatus,
        monthlySourceType,
        utmSourceMonthly,
        utmMediumMonthly,
        utmSourceStatus,
        utmMediumStatus,
        metaLeadsMonthly,
        leadsVsBooked,
        weeklyOutcomes,
        dailyOutcomes,
        monthlyOutcomes,
        noShowMonthly,
        noShowDaily,
        noShowCalls,
        noShowCallsDaily,
        directMeetingsMonthly: directMeetingsMonthlyResult.map(r => ({
          month: r._id.month,
          source: r._id.source,
          medium: r._id.medium,
          count: r.count
        }))
      }
    });

  } catch (error) {
    console.error('Error fetching leads analytics:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch leads analytics',
      error: error.message
    });
  }
};

/**
 * Return distinct utmSource / utmMedium / utmCampaign / metaCampaignName values actually
 * present on CampaignBooking documents. Used to populate the Leads view filter dropdowns
 * so every value that exists on a lead is selectable (even orphan values not registered
 * as a Campaign doc).
 */
export const getDistinctBookingUtm = async (_req, res) => {
  try {
    const [utmSources, utmMediums, utmCampaigns, metaCampaignNames, metaAdNames] = await Promise.all([
      CampaignBookingModel.distinct('utmSource'),
      CampaignBookingModel.distinct('utmMedium'),
      CampaignBookingModel.distinct('utmCampaign'),
      CampaignBookingModel.distinct('metaCampaignName'),
      CampaignBookingModel.distinct('metaAdName'),
    ]);

    const clean = (arr) =>
      Array.from(
        new Set(
          arr
            .filter((v) => typeof v === 'string' && v.trim() !== '')
            .map((v) => v.trim())
        )
      ).sort();

    return res.status(200).json({
      success: true,
      data: {
        utmSources: clean(utmSources),
        utmMediums: clean(utmMediums),
        utmCampaigns: clean(utmCampaigns),
        metaCampaignNames: clean(metaCampaignNames),
        metaAdNames: clean(metaAdNames),
      },
    });
  } catch (error) {
    console.error('Error fetching distinct booking utm values:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch distinct booking utm values',
      error: error.message,
    });
  }
};



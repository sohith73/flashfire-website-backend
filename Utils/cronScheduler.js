import cron from 'node-cron';
import { WorkflowLogModel } from '../Schema_Models/WorkflowLog.js';
import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import sgMail from '@sendgrid/mail';
import watiService from './WatiService.js';
import { EmailCampaignModel } from '../Schema_Models/EmailCampaign.js';
import { DateTime } from 'luxon';
import { scheduleEmailBatch, scheduleWhatsAppBatch } from './JobScheduler.js';
import { buildTemplateParameters } from './TemplateParameterBuilder.js';
import { safeErrorDetails } from './safeErrorDetails.js';
import { sendgridCircuitBreaker } from './CircuitBreaker.js';
import { clientHasPaidBooking, clientHasBookedElsewhere } from '../Controllers/WorkflowController.js';
import { DesignedEmailTemplateModel } from '../Schema_Models/DesignedEmailTemplate.js';
import { renderDesignedEmail, buildBookingTokens, unsubscribeAsm } from '../Controllers/DesignedEmailTemplateController.js';
import { ScheduledWhatsAppReminderModel } from '../Schema_Models/ScheduledWhatsAppReminder.js';
import { ScheduledCallModel } from '../Schema_Models/ScheduledCall.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';
import { scheduleCall } from './CallScheduler.js';
import { scheduleAllWhatsAppReminders } from './WhatsAppReminderScheduler.js';
import { normalizeTimezoneLabel } from './MeetingReminderUtils.js';
import { scheduleDiscordMeetReminder } from './DiscordMeetReminderScheduler.js';
import { DiscordConnect } from './DiscordConnect.js';
import { startWhatsAppFailureAlertCron } from './WhatsAppFailureAlert.js';
import { runAutoOnboardSweep } from './AutoOnboard.js';
import { didCompanySendAfter, getBridgeStatus } from './WhatsAppBridge.js';
import { normalizePhoneForReminders, buildCallId } from './MeetingReminderUtils.js';

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(s) { return typeof s === 'string' && EMAIL_RE.test(s.trim()); }

function isPermanentSendError(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  if (msg.includes('does not contain a valid address')) return true;
  if (msg.includes('invalid from email')) return true;
  // SendGrid wraps 400 in error.code / error.response.statusCode
  const status = error.code || error.response?.statusCode;
  if (status === 400 || status === 401 || status === 403) {
    const body = JSON.stringify(error.response?.body || error.responseBody || '');
    if (/invalid|does not contain a valid address|from address/i.test(body)) return true;
  }
  return false;
}

const IST_TIMEZONE = 'Asia/Kolkata';
const SEND_HOUR = 19; // 7 PM IST (for backward compatibility with campaigns)
const SEND_MINUTE = 30;

// WhatsApp workflow timing: 11 PM IST
const WHATSAPP_WORKFLOW_HOUR = 23;
const WHATSAPP_WORKFLOW_MINUTE = 0;

// Email workflow timing: Random between 8-10 PM IST
const EMAIL_WORKFLOW_START_HOUR = 20; // 8 PM IST
const EMAIL_WORKFLOW_END_HOUR = 22; // 10 PM IST

function getIST730PM(date) {
  const istDate = DateTime.fromJSDate(date).setZone(IST_TIMEZONE);
  return istDate.set({ hour: SEND_HOUR, minute: SEND_MINUTE, second: 0, millisecond: 0 }).toJSDate();
}

function getIST10AM(date) {
  const istDate = DateTime.fromJSDate(date).setZone(IST_TIMEZONE);
  return istDate.set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toJSDate();
}

/**
 * Get WhatsApp workflow send time: 11 PM IST
 */
function getIST11PM(date) {
  const istDate = DateTime.fromJSDate(date).setZone(IST_TIMEZONE);
  return istDate.set({ hour: WHATSAPP_WORKFLOW_HOUR, minute: WHATSAPP_WORKFLOW_MINUTE, second: 0, millisecond: 0 }).toJSDate();
}

/**
 * Get Email workflow send time: Random between 8-10 PM IST
 * Uses a deterministic random based on bookingId to ensure same time for same booking
 */
function getISTEmailWindow(date, bookingId = null) {
  const istDate = DateTime.fromJSDate(date).setZone(IST_TIMEZONE);
  
  // Generate deterministic random hour between 20-22 (8-10 PM) based on bookingId or date
  let seed = bookingId ? bookingId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) : date.getTime();
  const randomHour = EMAIL_WORKFLOW_START_HOUR + (seed % (EMAIL_WORKFLOW_END_HOUR - EMAIL_WORKFLOW_START_HOUR + 1));
  
  // Random minute between 0-59
  const randomMinute = seed % 60;
  
  return istDate.set({ hour: randomHour, minute: randomMinute, second: 0, millisecond: 0 }).toJSDate();
}

/**
 * Calculate scheduled date for workflows based on channel type
 * @param {Date} triggerDate - The date to calculate from
 * @param {number} daysAfter - Days after trigger date
 * @param {string} channel - 'email' or 'whatsapp' (for workflows)
 * @param {string} bookingId - Optional booking ID for deterministic email timing
 * @param {number} hoursAfter - Hours after trigger date (added on top of days)
 */
function calculateScheduledDate(triggerDate, daysAfter, channel = null, bookingId = null, hoursAfter = 0) {
  const targetDate = new Date(triggerDate);
  targetDate.setDate(targetDate.getDate() + daysAfter);

  // If hoursAfter is set, use exact time scheduling (no window-based)
  if (hoursAfter > 0) {
    targetDate.setTime(targetDate.getTime() + (hoursAfter * 60 * 60 * 1000));
    return targetDate;
  }

  if (channel === 'whatsapp') {
    return getIST11PM(targetDate);
  } else if (channel === 'email') {
    return getISTEmailWindow(targetDate, bookingId);
  }

  // Default: 7:30 PM IST (for backward compatibility with campaigns)
  return getIST730PM(targetDate);
}

export async function executeWorkflowLog(log) {
  try {
    const booking = await CampaignBookingModel.findOne({ bookingId: log.bookingId }).lean();
    if (!booking) {
      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        { 
          $set: { 
            status: 'failed',
            error: 'Booking not found',
            executedAt: new Date()
          }
        }
      );
      return;
    }

    // STRICT: Never execute workflows for paid/ignored clients (safety check at execution time)
    if (booking.bookingStatus === 'paid' || booking.bookingStatus === 'ignored') {
      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        { 
          $set: { 
            status: 'cancelled',
            error: 'Skipped: Client is marked as paid/ignored - workflows are not sent',
            executedAt: new Date()
          }
        }
      );
      console.log(`⏭️ Skipped workflow log ${log.logId}: booking ${log.bookingId} is paid/ignored`);
      return;
    }
    const hasPaid = await clientHasPaidBooking(booking.clientEmail, booking.clientPhone);
    if (hasPaid) {
      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        { 
          $set: { 
            status: 'cancelled',
            error: 'Skipped: Client has paid booking - workflows are not sent to paid clients',
            executedAt: new Date()
          }
        }
      );
      console.log(`⏭️ Skipped workflow log ${log.logId}: client has paid booking elsewhere`);
      return;
    }

    // Not-scheduled nudges say "you have not booked yet". Re-check at send time, since the
    // client may have booked after the log was queued, under another email or phone.
    if (log.triggerAction === 'not-scheduled') {
      const bookedHere = booking.bookingStatus !== 'not-scheduled';
      const bookedElsewhere = bookedHere
        ? false
        : await clientHasBookedElsewhere(booking.clientEmail, booking.clientPhone, booking.bookingId);
      if (bookedHere || bookedElsewhere) {
        const reason = bookedHere
          ? `Skipped: booking is now ${booking.bookingStatus}, client already booked`
          : 'Skipped: client already has a booking under another record';
        await WorkflowLogModel.updateOne(
          { logId: log.logId },
          { $set: { status: 'cancelled', error: reason, executedAt: null } }
        );
        console.log(`⏭️ Skipped not-scheduled workflow log ${log.logId}: ${reason}`);
        return;
      }
    }

    if (log.step.channel === 'email') {
      if (!booking.clientEmail) {
        await WorkflowLogModel.updateOne(
          { logId: log.logId },
          { $set: { status: 'failed', error: 'Client email not available', executedAt: new Date() } }
        );
        return;
      }
      if (!isValidEmail(booking.clientEmail)) {
        await WorkflowLogModel.updateOne(
          { logId: log.logId },
          { $set: { status: 'failed', error: `Invalid client email format: ${booking.clientEmail}`, executedAt: new Date() } }
        );
        return;
      }
      const domainName = log.step.domainName || 'flashfiremails.com';
      let senderEmail = log.step.senderEmail || process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';
      if (!isValidEmail(senderEmail)) {
        await WorkflowLogModel.updateOne(
          { logId: log.logId },
          { $set: { status: 'failed', error: `Invalid sender email: ${senderEmail}`, executedAt: new Date() } }
        );
        return;
      }

      // A templateId without the SendGrid "d-" prefix is the Mongo _id of an
      // in-dashboard DesignedEmailTemplate -> render its HTML and send directly.
      const isDesigned = !!log.step.templateId && !/^d-/i.test(String(log.step.templateId).trim());

      let msg;
      if (isDesigned) {
        const tpl = await DesignedEmailTemplateModel.findById(log.step.templateId).lean();
        if (!tpl) {
          await WorkflowLogModel.updateOne(
            { logId: log.logId },
            { $set: { status: 'failed', error: `Designed template not found: ${log.step.templateId}`, executedAt: new Date() } }
          );
          return;
        }
        const { subject, html, from } = renderDesignedEmail(tpl, buildBookingTokens(booking));
        const sendFrom = log.step.senderEmail ? { email: log.step.senderEmail, name: from.name } : from;
        msg = { to: booking.clientEmail, from: sendFrom, subject, html, ...unsubscribeAsm() };
      } else {
        msg = {
          to: booking.clientEmail,
          from: senderEmail,
          templateId: log.step.templateId,
          dynamicTemplateData: {
            domain: domainName,
            clientName: booking.clientName,
            bookingId: booking.bookingId
          }
        };
      }

      const result = await sendgridCircuitBreaker.execute(() => sgMail.send(msg));
      const responseData = { statusCode: result[0]?.statusCode, messageId: result[0]?.headers?.['x-message-id'] };

      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        {
          $set: {
            status: 'executed',
            executedAt: new Date(),
            responseData
          }
        }
      );

      console.log(`✅ Workflow email sent: ${log.logId} to ${booking.clientEmail}`);
    } else if (log.step.channel === 'whatsapp') {
      // A truthy phone is not a usable one: Meta lead rows can hold a country code like "CA"
      // or "Not Provided". WATI strips non-digits, gets an empty number and rejects it with
      // "Either whatsappNumber or target must be provided", so every retry fails the same way
      // and fires a Discord alert. Fail once, quietly, before calling WATI.
      const phoneDigits = String(booking.clientPhone || '').replace(/\D/g, '');
      if (phoneDigits.length < 7 || phoneDigits.length > 15) {
        await WorkflowLogModel.updateOne(
          { logId: log.logId },
          {
            $set: {
              status: 'failed',
              error: booking.clientPhone
                ? `Client phone number is not valid: ${JSON.stringify(String(booking.clientPhone).slice(0, 30))}`
                : 'Client phone number not available',
              executedAt: new Date()
            }
          }
        );
        console.warn(`⏭️ Skipped WhatsApp workflow log ${log.logId}: no usable phone on booking ${booking.bookingId}`);
        return;
      }

      // Resolve the actual WATI template name from ID if templateName is missing
      // This ensures buildTemplateParameters gets the real name (e.g., "meta_2") not the ID
      let resolvedTemplateName = log.step.templateName;
      if (!resolvedTemplateName && log.step.templateId) {
        try {
          resolvedTemplateName = await watiService.resolveTemplateName(null, log.step.templateId);
          console.log(`[cronScheduler] Resolved template ID ${log.step.templateId} → name: ${resolvedTemplateName}`);
        } catch (resolveErr) {
          console.warn(`[cronScheduler] Could not resolve template ID ${log.step.templateId}:`, resolveErr.message);
          resolvedTemplateName = log.step.templateId; // fallback
        }
      }

      const parameters = await buildTemplateParameters(resolvedTemplateName || log.step.templateId, {
        booking,
        step: log.step,
        executedAt: new Date()
      });

      const result = await watiService.sendTemplateMessage({
        mobileNumber: booking.clientPhone,
        templateId: log.step.templateId,
        templateName: resolvedTemplateName,
        parameters,
        campaignId: `workflow_${log.workflowId}_${Date.now()}`
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to send WhatsApp message');
      }

      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        {
          $set: {
            status: 'executed',
            executedAt: new Date(),
            responseData: result.data
          }
        }
      );

      console.log(`✅ Workflow WhatsApp sent: ${log.logId} to ${booking.clientPhone}`);
    }
  } catch (error) {
    console.error(`[cronScheduler] Error executing workflow log ${log.logId}:`, error.message);

    const isCircuitBreakerError = error.message?.includes('Circuit breaker');
    const permanent = isPermanentSendError(error);
    const currentAttempts = isCircuitBreakerError
      ? (log.attempts || 0)  // Don't count circuit breaker blocks as real attempts
      : (log.attempts || 0) + 1;
    const maxAttempts = log.maxAttempts || 3;

    if (!permanent && currentAttempts < maxAttempts) {
      // Circuit breaker errors: retry in 2 minutes (service might be back)
      // Other errors: exponential backoff — 5min, 20min, 80min
      const delayMs = isCircuitBreakerError
        ? 2 * 60 * 1000
        : Math.pow(4, currentAttempts) * 5 * 60 * 1000;
      const nextRetry = new Date(Date.now() + delayMs);

      console.log(`[cronScheduler] Retry ${currentAttempts}/${maxAttempts} for ${log.logId}, next at ${nextRetry.toISOString()}`);

      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        {
          $set: {
            status: 'scheduled',
            scheduledFor: nextRetry,
            error: `Attempt ${currentAttempts} failed: ${error.message}`,
            errorDetails: safeErrorDetails(error),
            attempts: currentAttempts
          }
        }
      );
    } else {
      // Max retries exhausted — mark as permanently failed
      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        {
          $set: {
            status: 'failed',
            error: error.message,
            errorDetails: safeErrorDetails(error),
            executedAt: new Date(),
            attempts: currentAttempts
          }
        }
      );
    }
  }
}

export async function executeScheduledEmailCampaign(campaign, scheduleItem) {
  try {
    const scheduleIndex = campaign.sendSchedule.findIndex(s => s.day === scheduleItem.day);
    if (scheduleIndex === -1) return;

    campaign.sendSchedule[scheduleIndex].status = 'processing';
    await campaign.save();

    let senderEmail = campaign.senderEmail;
    if (!senderEmail) {
      const stepDomainName = campaign.domainName || process.env.DOMAIN_NAME || null;
      if (stepDomainName) {
        senderEmail = `elizabeth@${stepDomainName}`;
      } else {
        senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';
      }
    }

    const normalizedEmails = campaign.recipientEmails
      .map(email => email.trim().toLowerCase())
      .filter(email => email.length > 0);

    const existingBookings = await CampaignBookingModel.find({
      clientEmail: { $in: normalizedEmails },
      bookingStatus: { $in: ['scheduled', 'completed'] }
    }).select('clientEmail').lean();

    const bookedEmails = new Set(existingBookings.map(b => b.clientEmail));
    
    const validRecipients = [];
    const skippedEmails = [];
    
    for (const email of normalizedEmails) {
      if (bookedEmails.has(email)) {
        skippedEmails.push({
          email: email,
          reason: 'User has booking',
          skippedAt: new Date()
        });
      } else {
        validRecipients.push(email);
      }
    }

    // Use JobScheduler to schedule emails with time spreading (over 1 hour)
    // This will spread the emails evenly and process only 3 at a time
    if (validRecipients.length > 0) {
      const schedulingResult = await scheduleEmailBatch({
        recipients: validRecipients,
        templateId: campaign.templateId,
        templateName: campaign.templateName,
        domainName: campaign.domainName,
        senderEmail,
        scheduledStartTime: new Date(), // Start immediately, will spread over 1 hour
        campaignId: campaign._id?.toString(),
        dynamicTemplateData: {
          domain: campaign.domainName
        }
      });

      if (schedulingResult.success) {
        console.log(`✅ [CronScheduler] Scheduled ${validRecipients.length} emails with time spreading over ${schedulingResult.spreadMinutes} minutes`);
        
        campaign.logs.push({
          timestamp: new Date(),
          level: 'info',
          message: `Scheduled ${validRecipients.length} emails with time spreading`,
          details: {
            sendDay: scheduleItem.day,
            totalRecipients: validRecipients.length,
            skipped: skippedEmails.length,
            batchId: schedulingResult.batchId,
            spreadMinutes: schedulingResult.spreadMinutes,
            firstSendTime: schedulingResult.firstSendTime,
            lastSendTime: schedulingResult.lastSendTime
          }
        });
      } else {
        throw new Error(schedulingResult.error || 'Failed to schedule emails');
      }
    }

    // Mark as processing (actual completion will be tracked by JobScheduler)
    // We don't mark as completed yet since emails will be sent over time
    campaign.sendSchedule[scheduleIndex].status = 'processing';
    campaign.sendSchedule[scheduleIndex].skippedCount = skippedEmails.length;

    campaign.logs.push({
      timestamp: new Date(),
      level: 'success',
      message: `Queued email send for day ${scheduleItem.day} with time spreading`,
      details: {
        sendDay: scheduleItem.day,
        queued: validRecipients.length,
        skipped: skippedEmails.length,
        note: 'Emails will be sent over 1 hour with 3 concurrent max'
      }
    });

    await campaign.save();
    console.log(`✅ Scheduled email campaign ${campaign._id} day ${scheduleItem.day} queued (${validRecipients.length} emails over 1 hour)`);
  } catch (error) {
    console.error(`❌ Error executing scheduled email campaign:`, error);
    const scheduleIndex = campaign.sendSchedule.findIndex(s => s.day === scheduleItem.day);
    if (scheduleIndex !== -1) {
      campaign.sendSchedule[scheduleIndex].status = 'failed';
      campaign.logs.push({
        timestamp: new Date(),
        level: 'error',
        message: `Failed to execute day ${scheduleItem.day}`,
        details: { error: error.message }
      });
      await campaign.save();
    }
  }
}

export async function executeWhatsAppCampaign(campaign) {
  try {
    const campaignId = campaign.campaignId || campaign._id?.toString();
    if (!campaignId) return;

    const campaignDoc = await WhatsAppCampaignModel.findOne({ campaignId });
    if (!campaignDoc) return;

    const pendingMessages = campaignDoc.messageStatuses.filter(
      msg => msg.status === 'pending' || msg.status === 'scheduled'
    );

    if (pendingMessages.length === 0) return;

    const now = new Date();
    const dueMessages = pendingMessages.filter(msg => {
      if (msg.sendDay === 0) return true;
      if (!msg.scheduledSendDate) return false;
      return new Date(msg.scheduledSendDate) <= now;
    });

    if (dueMessages.length === 0) return;

    const dayGroups = {};
    dueMessages.forEach(msg => {
      if (!dayGroups[msg.sendDay]) {
        dayGroups[msg.sendDay] = [];
      }
      dayGroups[msg.sendDay].push(msg.mobileNumber);
    });

    const nextDay = Math.min(...Object.keys(dayGroups).map(Number));
    const mobilesToSend = dayGroups[nextDay];

    campaignDoc.status = 'IN_PROGRESS';
    await campaignDoc.save();

    // Use JobScheduler to schedule WhatsApp messages with time spreading
    // This will spread messages over 1 hour and process sequentially
    if (mobilesToSend.length > 0) {
      const schedulingResult = await scheduleWhatsAppBatch({
        mobileNumbers: mobilesToSend,
        templateName: campaignDoc.templateName,
        templateId: campaignDoc.templateId,
        parameters: Array.isArray(campaignDoc.parameters) ? campaignDoc.parameters : [],
        scheduledStartTime: new Date(),
        campaignId: campaignDoc.campaignId,
        metadata: { sendDay: nextDay }
      });

      if (schedulingResult.success) {
        console.log(`✅ [CronScheduler] Scheduled ${mobilesToSend.length} WhatsApp messages with time spreading over ${schedulingResult.spreadMinutes} minutes`);
        console.log(`✅ WhatsApp campaign ${campaignDoc.campaignId} day ${nextDay} queued (${mobilesToSend.length} messages over 1 hour)`);
      } else {
        throw new Error(schedulingResult.error || 'Failed to schedule WhatsApp messages');
      }
    }
  } catch (error) {
    console.error(`❌ Error executing WhatsApp campaign:`, error);
    try {
      const campaignId = campaign.campaignId || campaign._id?.toString();
      if (campaignId) {
        const campaignDoc = await WhatsAppCampaignModel.findOne({ campaignId });
        if (campaignDoc) {
          campaignDoc.status = 'FAILED';
          campaignDoc.errorMessage = error.message;
          await campaignDoc.save();
        }
      }
    } catch (saveError) {
      console.error('Failed to update campaign error status:', saveError);
    }
  }
}

async function processScheduledItems() {
  try {
    const now = new Date();
    const nowIST = DateTime.fromJSDate(now).setZone(IST_TIMEZONE);
    const currentHour = nowIST.hour;
    const currentMinute = nowIST.minute;

    // Legacy send window for campaigns (7:30 PM IST)
    const isSendWindow = currentHour === SEND_HOUR && currentMinute >= SEND_MINUTE && currentMinute < SEND_MINUTE + 15;

    // Recover workflow logs left in "processing" (crash / timeout after claim)
    const stuckMs = Math.max(60000, Number(process.env.WORKFLOW_LOG_STUCK_MS) || 15 * 60 * 1000);
    const stuckBefore = new Date(Date.now() - stuckMs);
    const stuckReset = await WorkflowLogModel.updateMany(
      { status: 'processing', claimedAt: { $ne: null, $lte: stuckBefore } },
      { $set: { status: 'scheduled', claimedAt: null, scheduledFor: now } }
    );
    if (stuckReset.modifiedCount > 0) {
      console.log(`[cronScheduler] Reset ${stuckReset.modifiedCount} stuck workflow log(s) from processing → scheduled`);
    }

    // Atomic claim pattern: use findOneAndUpdate to claim one log at a time.
    // This prevents duplicate execution when multiple cron ticks or server instances overlap.

    // Helper: atomically claim and execute workflow logs matching a filter
    async function claimAndExecute(extraFilter, label) {
      let count = 0;
      let claimed;
      do {
        claimed = await WorkflowLogModel.findOneAndUpdate(
          {
            status: 'scheduled',
            scheduledFor: { $lte: now },
            ...extraFilter
          },
          {
            $set: { status: 'processing', claimedAt: now }
          },
          { returnDocument: 'after', sort: { scheduledFor: 1 } }
        );
        if (claimed) {
          count++;
          await executeWorkflowLog(claimed);
        }
      } while (claimed);
      if (count > 0) {
        console.log(`[cronScheduler] ${label}: processed ${count} workflow logs`);
      }
    }

    // 1. Hour-based workflows: run as soon as scheduledFor <= now (every cron tick).
    await claimAndExecute(
      { 'step.hoursAfter': { $gt: 0 } },
      'Hour-based (immediate)'
    );

    // 2–3. Day-based email & WhatsApp: run whenever due.
    // calculateScheduledDate() already sets channel-specific wall time (8–10 PM IST email, 11 PM IST WhatsApp).
    // Do NOT gate on a second "send window" here — cron runs every :00/:15/:30/:45, so a 15-minute window
    // (e.g. 23:00–23:14) missed the next tick at 23:15 and left jobs stuck until the next day.
    await claimAndExecute(
      { 'step.channel': 'email', $or: [{ 'step.hoursAfter': { $exists: false } }, { 'step.hoursAfter': 0 }] },
      'Day-based email workflows'
    );

    await claimAndExecute(
      { 'step.channel': 'whatsapp', $or: [{ 'step.hoursAfter': { $exists: false } }, { 'step.hoursAfter': 0 }] },
      'Day-based WhatsApp workflows'
    );

    if (isSendWindow) {
      const scheduledCampaigns = await ScheduledEmailCampaignModel.find({
        status: { $in: ['active'] },
        'sendSchedule.status': 'pending'
      }).limit(50);

      for (const campaign of scheduledCampaigns) {
        const dueSchedules = campaign.sendSchedule.filter(
          s => s.status === 'pending' && new Date(s.scheduledDate) <= now
        );

        for (const scheduleItem of dueSchedules) {
          await executeScheduledEmailCampaign(campaign, scheduleItem);
        }
      }

      const whatsappCampaigns = await WhatsAppCampaignModel.find({
        status: { $in: ['SCHEDULED', 'PENDING', 'IN_PROGRESS'] },
        $or: [
          { scheduledFor: { $lte: now } },
          { scheduledFor: null },
          { 'messageStatuses.sendDay': 0 }
        ]
      }).limit(50);

      for (const campaign of whatsappCampaigns) {
        const hasPending = campaign.messageStatuses.some(
          msg => {
            if (msg.status === 'pending') return true;
            if (msg.status === 'scheduled' && msg.scheduledSendDate && new Date(msg.scheduledSendDate) <= now) return true;
            return false;
          }
        );
        if (hasPending) {
          await executeWhatsAppCampaign(campaign);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error in cron scheduler:', error);
  }
}

/**
 * Runs at 10 AM IST daily.
 * Ensures every meeting in the next 24 hours has its call, WA, and Discord reminders.
 * Also cancels pending reminders for client-canceled meetings.
 * Production-ready: idempotent, handles all edge cases.
 */
async function runDailyReminderBackfill() {
  const DISCORD_WEBHOOK = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
  const report = { ensured: 0, cancelled: 0, skipped: 0, errors: 0, details: [] };

  try {
    console.log('🔁 [DailyBackfill] Starting 10am IST daily reminder backfill...');

    const nowIST  = DateTime.now().setZone(IST_TIMEZONE);
    const windowStart = nowIST.toJSDate();
    const windowEnd   = nowIST.plus({ hours: 24 }).toJSDate();

    // ── Part 1: Cancel reminders for client-canceled bookings ──────────────
    const canceledBookings = await CampaignBookingModel.find({
      bookingStatus: 'canceled',
      statusChangeSource: 'calendly',
      scheduledEventStartTime: { $gte: windowStart, $lt: windowEnd },
    }).lean();

    for (const b of canceledBookings) {
      try {
        const startMs = new Date(b.scheduledEventStartTime).getTime();
        const phone   = b.clientPhone ? normalizePhoneForReminders(b.clientPhone) : null;

        // Cancel WA reminders
        const waResult = await ScheduledWhatsAppReminderModel.updateMany(
          {
            clientEmail: b.clientEmail,
            meetingStartISO: { $gte: new Date(startMs - 60000), $lte: new Date(startMs + 60000) },
            status: 'pending',
          },
          { $set: { status: 'cancelled', errorMessage: 'Cancelled: client canceled meeting (daily backfill)' } }
        );

        // Cancel call
        if (phone) {
          const callId = buildCallId(phone, startMs);
          await ScheduledCallModel.updateMany(
            { callId, status: 'pending' },
            { $set: { status: 'cancelled', errorMessage: 'Cancelled: client canceled meeting (daily backfill)' } }
          );
        }

        // Cancel discord reminder
        await ScheduledDiscordMeetReminderModel.updateMany(
          {
            bookingId: b.bookingId,
            status: 'pending',
          },
          { $set: { status: 'cancelled', errorMessage: 'Cancelled: client canceled meeting (daily backfill)' } }
        );

        report.cancelled++;
        report.details.push(`❌ CANCEL: ${b.clientName} — meeting at ${new Date(b.scheduledEventStartTime).toISOString()}`);
      } catch (err) {
        report.errors++;
        console.error(`[DailyBackfill] Error cancelling reminders for ${b.clientEmail}:`, err.message);
      }
    }

    // ── Part 2: Ensure reminders for active scheduled bookings ─────────────
    const activeBookings = await CampaignBookingModel.find({
      bookingStatus: 'scheduled',
      scheduledEventStartTime: { $gte: windowStart, $lt: windowEnd },
    }).lean();

    for (const b of activeBookings) {
      try {
        const meetingStartISO = b.scheduledEventStartTime instanceof Date
          ? b.scheduledEventStartTime.toISOString()
          : b.scheduledEventStartTime;

        const meetingStartMs = new Date(meetingStartISO).getTime();
        const minutesUntil   = (meetingStartMs - Date.now()) / 60000;

        // Skip meetings too soon to meaningfully schedule a call (< 12 min)
        if (minutesUntil < 12) {
          report.skipped++;
          report.details.push(`⏭️ TOO SOON: ${b.clientName} — ${Math.round(minutesUntil)}m away`);
          continue;
        }

        const phone = b.clientPhone ? normalizePhoneForReminders(b.clientPhone) : null;

        // ── Check existing records ──────────────────────────────────────────
        const existingCall = phone
          ? await ScheduledCallModel.findOne({
              callId: buildCallId(phone, meetingStartMs),
            }).lean()
          : null;

        const existingWA = phone
          ? await ScheduledWhatsAppReminderModel.find({
              phoneNumber: phone,
              meetingStartISO: { $gte: new Date(meetingStartMs - 60000), $lte: new Date(meetingStartMs + 60000) },
              status: { $in: ['pending', 'processing', 'completed'] },
            }).lean()
          : [];

        const existingDiscord = await ScheduledDiscordMeetReminderModel.findOne({
          bookingId: b.bookingId,
          status: { $in: ['pending', 'processing', 'completed'] },
        }).lean();

        const needCall    = !existingCall && !!phone;
        const needWA      = existingWA.length === 0 && !!phone;
        const needDiscord = !existingDiscord;

        if (!needCall && !needWA && !needDiscord) {
          report.skipped++;
          continue;
        }

        // ── Build time strings (same logic as CallScheduler) ──────────────
        const meetingStartUTC = DateTime.fromISO(meetingStartISO, { zone: 'utc' });
        const meetingEndISO   = b.scheduledEventEndTime
          ? (b.scheduledEventEndTime instanceof Date ? b.scheduledEventEndTime.toISOString() : b.scheduledEventEndTime)
          : null;
        const meetingEndUTC   = meetingEndISO
          ? DateTime.fromISO(meetingEndISO, { zone: 'utc' })
          : meetingStartUTC.plus({ minutes: 15 });

        const inviteeTz = b.inviteeTimezone || null;
        let displayZone = inviteeTz;
        if (!displayZone) {
          const pst = meetingStartUTC.setZone('America/Los_Angeles').offset / 60;
          displayZone = (pst === -8 || pst === -7) ? 'America/Los_Angeles' : 'America/New_York';
        }

        const startInZone = meetingStartUTC.setZone(displayZone);
        const endInZone   = meetingEndUTC.setZone(displayZone);

        const fmt = (dt) => dt.minute === 0
          ? dt.toFormat('ha').toLowerCase()
          : dt.toFormat('h:mma').toLowerCase();

        const meetingTimeFormatted = `${fmt(startInZone)} – ${fmt(endInZone)}`;
        const meetingDateFormatted = startInZone.toFormat('EEEE MMM d, yyyy');

        // Timezone abbreviation
        let tzAbbr = 'ET';
        if (inviteeTz) {
          const tz = DateTime.fromISO(meetingStartISO, { zone: inviteeTz });
          tzAbbr = tz.isValid ? normalizeTimezoneLabel(tz.toFormat('ZZZZ')) : 'ET';
        }

        const sharedMeta = {
          bookingId: b.bookingId,
          inviteeTimezone: inviteeTz,
          meetingEndISO,
        };

        // ── Schedule call (+ WA via scheduleCall when both missing) ─────────
        if (needCall) {
          const callResult = await scheduleCall({
            phoneNumber: phone,
            meetingStartISO,
            meetingTime: meetingTimeFormatted,
            inviteeName: b.clientName,
            inviteeEmail: b.clientEmail,
            source: 'manual',
            meetingLink: b.calendlyMeetLink || null,
            rescheduleLink: b.calendlyRescheduleLink || 'https://calendly.com/flashfirejobs',
            skipWhatsAppReminders: !needWA, // If WA already exists, skip; else schedule together
            metadata: sharedMeta,
          });
          if (callResult.success && !callResult.existing) {
            report.ensured++;
            report.details.push(`✅ CALL+WA: ${b.clientName} (${phone}) — ${meetingTimeFormatted}`);
          }
        } else if (needWA) {
          // Call already exists but WA is missing — schedule WA separately with proper format
          await scheduleAllWhatsAppReminders({
            phoneNumber: phone,
            meetingStartISO,
            meetingTime: meetingTimeFormatted,
            meetingDate: meetingDateFormatted,
            clientName: b.clientName,
            clientEmail: b.clientEmail,
            meetingLink: b.calendlyMeetLink || null,
            rescheduleLink: b.calendlyRescheduleLink || 'https://calendly.com/flashfirejobs',
            source: 'manual',
            timezone: tzAbbr,
            metadata: sharedMeta,
          });
          report.ensured++;
          report.details.push(`✅ WA ONLY: ${b.clientName} (${phone}) — ${meetingTimeFormatted}`);
        }

        // ── Schedule Discord reminder ──────────────────────────────────────
        if (needDiscord) {
          await scheduleDiscordMeetReminder({
            bookingId: b.bookingId,
            clientName: b.clientName,
            clientEmail: b.clientEmail,
            meetingStartISO,
            meetingLink: b.calendlyMeetLink || null,
            inviteeTimezone: inviteeTz,
            source: 'manual',
            metadata: { bookingId: b.bookingId },
          });
          if (!needCall && !needWA) {
            report.ensured++;
            report.details.push(`✅ DISCORD: ${b.clientName} — ${meetingTimeFormatted}`);
          }
        }
      } catch (err) {
        report.errors++;
        console.error(`[DailyBackfill] Error processing ${b.clientEmail}:`, err.message);
        report.details.push(`❌ ERROR: ${b.clientName} — ${err.message}`);
      }
    }

    console.log(`✅ [DailyBackfill] Done — ensured: ${report.ensured}, cancelled: ${report.cancelled}, skipped: ${report.skipped}, errors: ${report.errors}`);

    // Send Discord summary
    if (DISCORD_WEBHOOK && (report.ensured > 0 || report.cancelled > 0 || report.errors > 0)) {
      const lines = [
        `🔁 **Daily Reminder Backfill (10am IST)**`,
        `✅ Ensured: ${report.ensured} | ❌ Cancelled: ${report.cancelled} | ⏭️ Skipped: ${report.skipped} | 💥 Errors: ${report.errors}`,
        '',
        ...report.details.slice(0, 20), // cap to avoid Discord message limit
      ];
      await DiscordConnect(DISCORD_WEBHOOK, lines.join('\n'), false);
    }
  } catch (err) {
    console.error('❌ [DailyBackfill] Fatal error:', err.message, err.stack);
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `❌ **Daily Reminder Backfill FAILED**: ${err.message}`,
        false
      ).catch(() => {});
    }
  }
}


const LEAD_ACTION_WEBHOOK = process.env.DISCORD_LEAD_ACTION_WEBHOOK_URL;

function formatIST(date) {
  return DateTime.fromJSDate(new Date(date)).setZone(IST_TIMEZONE).toFormat('dd MMM, h:mm a');
}

function formatElapsed(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function minutesSince(date) {
  return Math.floor((Date.now() - new Date(date).getTime()) / 60000);
}

/**
 * Alert 1 — Greeting not sent within 1 hour of meeting completion.
 * Checks meetings completed 60–1440 min ago without a greeting alert already fired.
 */
async function checkGreetingAlerts() {
  if (!LEAD_ACTION_WEBHOOK) return;

  // Check bridge auth state first — alert if logged out
  const bridgeStatus = await getBridgeStatus();
  if (!bridgeStatus.ok || bridgeStatus.auth_state === 'logged_out') {
    await DiscordConnect(
      LEAD_ACTION_WEBHOOK,
      `⚠️ **WhatsApp Bridge Logged Out**\nThe company WhatsApp session has expired and needs re-pairing.\n**Action:** Go to Render dashboard → whatsapp-bridge service → open Logs → scan the QR code shown on your phone.\nhttps://dashboard.render.com`,
      false
    ).catch(() => {});
    return;
  }

  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

  let bookings;
  try {
    bookings = await CampaignBookingModel.find({
      bookingStatus: 'completed',
      statusChangedAt: { $gte: oneDayAgo, $lte: oneHourAgo },
      bdaGreetingAlertSentAt: null,
      phone: { $nin: [null, ''] },
    }).select('name phone claimedBy statusChangedAt').lean();
  } catch (err) {
    console.error('[GreetingAlert] DB query failed:', err.message);
    return;
  }

  for (const booking of bookings) {
    try {
      const { sent, error } = await didCompanySendAfter(booking.phone, booking.statusChangedAt);

      if (error) {
        console.warn(`[GreetingAlert] Bridge error for booking ${booking._id}: ${error}`);
        continue;
      }

      if (sent) {
        // Greeting was sent — mark with epoch so we never re-check this booking
        await CampaignBookingModel.updateOne(
          { _id: booking._id, bdaGreetingAlertSentAt: null },
          { $set: { bdaGreetingAlertSentAt: new Date(0) } }
        );
        continue;
      }

      // Not sent — atomically claim to avoid duplicate alerts across restarts
      const claimed = await CampaignBookingModel.findOneAndUpdate(
        { _id: booking._id, bdaGreetingAlertSentAt: null },
        { $set: { bdaGreetingAlertSentAt: now } },
        { new: false }
      );
      if (!claimed) continue;

      const elapsed = formatElapsed(minutesSince(booking.statusChangedAt));
      const bdaName = booking.claimedBy?.name || 'Unknown BDA';
      const digits = String(booking.phone).replace(/\D/g, '').replace(/^91/, '');
      const formattedPhone = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;

      const msg = [
        `🚨 **Greeting Not Sent — 1 Hour Passed**`,
        ``,
        `**BDA:** ${bdaName}`,
        `**Client:** ${booking.name || 'Unknown'}`,
        `**Phone:** ${formattedPhone}`,
        `**Meeting completed at:** ${formatIST(booking.statusChangedAt)}`,
        `**Time elapsed:** ${elapsed}`,
      ].join('\n');

      await DiscordConnect(LEAD_ACTION_WEBHOOK, msg, false).catch(() => {});
      console.log(`[GreetingAlert] Alert sent for booking ${booking._id} (${bdaName})`);
    } catch (err) {
      console.error(`[GreetingAlert] Error processing booking ${booking._id}:`, err.message);
    }
  }
}

/**
 * Alert 2 — Follow-up WhatsApp not sent by the BDA's scheduled follow-up date.
 * Uses followUp.at — the date the BDA manually set in the CRM follow-up pop-up.
 */
async function checkFollowUpAlerts() {
  if (!LEAD_ACTION_WEBHOOK) return;

  const now = new Date();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

  let bookings;
  try {
    bookings = await CampaignBookingModel.find({
      bookingStatus: { $nin: ['paid', 'cancelled', 'ignored'] },
      bdaFollowUpAlertSentAt: null,
      phone: { $nin: [null, ''] },
      'followUp.at': { $gte: oneDayAgo, $lte: now },
    }).select('name phone claimedBy followUp').lean();
  } catch (err) {
    console.error('[FollowUpAlert] DB query failed:', err.message);
    return;
  }

  for (const booking of bookings) {
    const followUpAt = booking.followUp?.at;
    if (!followUpAt) continue;

    try {
      const { sent, error } = await didCompanySendAfter(booking.phone, followUpAt);

      if (error) {
        console.warn(`[FollowUpAlert] Bridge error for booking ${booking._id}: ${error}`);
        continue;
      }

      if (sent) {
        await CampaignBookingModel.updateOne(
          { _id: booking._id, bdaFollowUpAlertSentAt: null },
          { $set: { bdaFollowUpAlertSentAt: new Date(0) } }
        );
        continue;
      }

      const claimed = await CampaignBookingModel.findOneAndUpdate(
        { _id: booking._id, bdaFollowUpAlertSentAt: null },
        { $set: { bdaFollowUpAlertSentAt: now } },
        { new: false }
      );
      if (!claimed) continue;

      const elapsed = formatElapsed(minutesSince(followUpAt));
      const bdaName = booking.claimedBy?.name || 'Unknown BDA';
      const digits = String(booking.phone).replace(/\D/g, '').replace(/^91/, '');
      const formattedPhone = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;

      const msg = [
        `⏰ **Follow-up Not Done**`,
        ``,
        `**BDA:** ${bdaName}`,
        `**Client:** ${booking.name || 'Unknown'}`,
        `**Phone:** ${formattedPhone}`,
        `**Follow-up was due:** ${formatIST(followUpAt)}`,
        `**Overdue by:** ${elapsed}`,
      ].join('\n');

      await DiscordConnect(LEAD_ACTION_WEBHOOK, msg, false).catch(() => {});
      console.log(`[FollowUpAlert] Alert sent for booking ${booking._id} (${bdaName})`);
    } catch (err) {
      console.error(`[FollowUpAlert] Error processing booking ${booking._id}:`, err.message);
    }
  }
}

export function startCronScheduler() {
  cron.schedule('*/15 * * * *', async () => {
    await processScheduledItems();
  }, {
    scheduled: true,
    timezone: IST_TIMEZONE
  });

  // 10am IST daily: ensure all meetings in next 24h have reminders, cancel for canceled bookings
  cron.schedule('0 10 * * *', async () => {
    await runDailyReminderBackfill();
  }, {
    scheduled: true,
    timezone: IST_TIMEZONE
  });

  // Every 5 minutes: paid CRM leads and completed payments become dashboard users (idempotent, retried on failure).
  cron.schedule('*/5 * * * *', async () => {
    try {
      await runAutoOnboardSweep();
    } catch (err) {
      console.error('[auto-onboard] sweep failed:', err?.message || err);
    }
  }, {
    scheduled: true,
    timezone: IST_TIMEZONE
  });

  // 9am + 9pm IST: post WhatsApp (WATI) send failures from the last 12h to Discord
  startWhatsAppFailureAlertCron();

  // Every 15 min: greeting alert — BDA must send WhatsApp within 1hr of meeting completion
  cron.schedule('*/15 * * * *', async () => {
    try {
      await checkGreetingAlerts();
    } catch (err) {
      console.error('[GreetingAlert] Unhandled error:', err.message);
    }
  }, { scheduled: true, timezone: IST_TIMEZONE });

  // Every 15 min: follow-up alert — BDA must send WhatsApp by the scheduled follow-up date
  cron.schedule('*/15 * * * *', async () => {
    try {
      await checkFollowUpAlerts();
    } catch (err) {
      console.error('[FollowUpAlert] Unhandled error:', err.message);
    }
  }, { scheduled: true, timezone: IST_TIMEZONE });

  // NOTE: the 4am IST call summary lives in index.js (sendCallLeadsDailySummary).
  // The shift-window duplicate that used to be scheduled here was removed — it ran at the
  // same 0 4 * * * IST as the index.js one, so Discord got two summaries every morning.

  console.log('✅ Cron scheduler started - every 15min processing + 10am IST daily backfill');

  processScheduledItems();
}

export { calculateScheduledDate, getIST730PM, getIST11PM, getISTEmailWindow, getIST10AM };

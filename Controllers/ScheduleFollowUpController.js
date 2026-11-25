import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { scheduleCall } from '../Utils/CallScheduler.js';
import { scheduleAllWhatsAppReminders } from '../Utils/WhatsAppReminderScheduler.js';
import sgMail from '@sendgrid/mail';
import { DateTime } from 'luxon';
import { Logger } from '../Utils/Logger.js';
import { getRescheduleLinkForBooking } from '../Utils/CalendlyAPIHelper.js';

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1);

export default async function ScheduleFollowUp(req, res) {
  try {
    const { bookingId } = req.params;
    const { followUpDateTime } = req.body;

    // Validation
    if (!bookingId || !followUpDateTime) {
      return res.status(400).json({
        success: false,
        message: 'Booking ID and follow-up date/time are required'
      });
    }

    const senderEmail = 'elizabeth@flashfirehq.com';

    // Find the booking
    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    const followUpDate = new Date(followUpDateTime);
    const now = new Date();

    // Validate follow-up date is in the future
    if (followUpDate <= now) {
      return res.status(400).json({
        success: false,
        message: 'Follow-up date/time must be in the future'
      });
    }

    // Calculate times
    const callTime = new Date(followUpDate.getTime() - 10 * 60 * 1000); // 10 minutes before
    const whatsappTime = new Date(followUpDate.getTime() - 5 * 60 * 1000); // 5 minutes before

    // Validate call and WhatsApp times are in the future
    if (callTime <= now) {
      return res.status(400).json({
        success: false,
        message: 'Follow-up time is too soon. Call reminder (10 min before) would be in the past.'
      });
    }

    if (whatsappTime <= now) {
      return res.status(400).json({
        success: false,
        message: 'Follow-up time is too soon. WhatsApp reminder (5 min before) would be in the past.'
      });
    }

    // Keep the date the BDA picked on the lead itself. The Sales Tracker sheet reads it from here; the scheduled call
    // above is cancelled or replaced, so it is not a reliable record of what was chosen.
    await CampaignBookingModel.updateOne({ bookingId }, { $set: { 'followUp.at': followUpDate, 'followUp.setAt': now } });

    const results = {
      email: { success: false, error: null },
      call: { success: false, error: null },
      whatsapp: { success: false, error: null }
    };

    // 1. Follow-up email: send immediately via SendGrid (queue removed)
    if (booking.clientEmail) {
      try {
        const followUpMessage = `Hi ${booking.clientName || 'there'},

You asked for a follow-up regarding your consultation with FlashFire. We wanted to reach out and see how things are going.

If you have any questions or would like to reschedule your meeting, please don't hesitate to reach out to us.

Best regards,
Elizabeth
FlashFire Team`;

        await sgMail.send({
          to: booking.clientEmail,
          from: senderEmail,
          subject: 'Follow-up: FlashFire Consultation',
          text: followUpMessage,
          html: `
            <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <p>Hi ${booking.clientName || 'there'},</p>
              <p>You asked for a follow-up regarding your consultation with FlashFire. We wanted to reach out and see how things are going.</p>
              <p>If you have any questions or would like to reschedule your meeting, please don't hesitate to reach out to us.</p>
              <p>Best regards,<br/>Elizabeth<br/>FlashFire Team</p>
            </div>
          `
        });

        results.email.success = true;
        Logger.info('Sent follow-up email immediately', {
          bookingId: booking.bookingId,
          email: booking.clientEmail
        });
      } catch (error) {
        results.email.error = error.message;
        Logger.error('Failed to send follow-up email', {
          bookingId: booking.bookingId,
          error: error.message
        });
      }
    } else {
      results.email.error = 'No email address available for booking';
    }

    // 2. Schedule Call 10 minutes before follow-up
    if (booking.clientPhone) {
      try {
        // Format date/time for call scheduler (America/New_York timezone)
        const followUpET = DateTime.fromJSDate(followUpDate, { zone: 'utc' })
          .setZone('America/New_York');
        
        const meetingDateFormatted = followUpET.toFormat('EEEE MMM d, yyyy');
        const meetingTimeFormatted = followUpET.minute === 0
          ? followUpET.toFormat('ha').toLowerCase()
          : followUpET.toFormat('h:mma').toLowerCase();

        const callResult = await scheduleCall({
          phoneNumber: booking.clientPhone,
          meetingStartISO: followUpDate.toISOString(),
          meetingTime: meetingTimeFormatted,
          inviteeName: booking.clientName,
          inviteeEmail: booking.clientEmail,
          source: 'crm_followup',
          metadata: {
            bookingId: booking.bookingId,
            followUpType: 'followup',
            originalBookingId: booking.bookingId
          },
          meetingLink: booking.calendlyMeetLink || null,
          rescheduleLink: booking.calendlyRescheduleLink || null
        });

        if (callResult.success) {
          results.call.success = true;
          results.call.callId = callResult.callId;
          Logger.info('Scheduled follow-up call', {
            bookingId: booking.bookingId,
            phone: booking.clientPhone,
            scheduledFor: callTime.toISOString(),
            callId: callResult.callId
          });
        } else {
          results.call.error = callResult.error || 'Failed to schedule call';
        }
      } catch (error) {
        results.call.error = error.message;
        Logger.error('Failed to schedule follow-up call', {
          bookingId: booking.bookingId,
          error: error.message
        });
      }
    } else {
      results.call.error = 'No phone number available for booking';
    }

    // 3. Schedule WhatsApp message 5 minutes before follow-up
    if (booking.clientPhone) {
      try {
        // Format date/time for WhatsApp (America/New_York timezone)
        const followUpET = DateTime.fromJSDate(followUpDate, { zone: 'utc' })
          .setZone('America/New_York');
        
        const meetingDateFormatted = followUpET.toFormat('EEEE MMM d, yyyy');
        const startTimeET = followUpET;
        const startTimeFormatted = startTimeET.minute === 0
          ? startTimeET.toFormat('ha').toLowerCase()
          : startTimeET.toFormat('h:mma').toLowerCase();
        
        // Default 15 min duration
        const endTimeET = followUpET.plus({ minutes: 15 });
        const endTimeFormatted = endTimeET.minute === 0
          ? endTimeET.toFormat('ha').toLowerCase()
          : endTimeET.toFormat('h:mma').toLowerCase();
        
        const meetingTimeFormatted = `${startTimeFormatted} – ${endTimeFormatted}`;

        // Try to fetch reschedule link from Calendly API if not in booking
        let rescheduleLink = booking.calendlyRescheduleLink || null;
        if (!rescheduleLink) {
          try {
            const fetchedLink = await getRescheduleLinkForBooking(booking);
            if (fetchedLink) {
              rescheduleLink = fetchedLink;
              console.log('✅ [ScheduleFollowUp] Fetched reschedule link from Calendly API:', rescheduleLink);
            }
          } catch (error) {
            console.warn('⚠️ [ScheduleFollowUp] Could not fetch reschedule link:', error.message);
          }
        }

        const whatsappResults = await scheduleAllWhatsAppReminders({
          phoneNumber: booking.clientPhone,
          meetingStartISO: followUpDate.toISOString(),
          meetingTime: meetingTimeFormatted,
          meetingDate: meetingDateFormatted,
          clientName: booking.clientName,
          clientEmail: booking.clientEmail,
          meetingLink: booking.calendlyMeetLink || null,
          rescheduleLink: rescheduleLink,
          source: 'crm_followup',
          timezone: 'ET', // Follow-up meetings are scheduled in ET timezone
          metadata: {
            bookingId: booking.bookingId,
            followUpType: 'followup',
            originalBookingId: booking.bookingId,
            meetingEndISO: endTimeET.toISO()
          }
        });

        const scheduledCount = Object.values(whatsappResults).filter(r => r.success).length;
        if (scheduledCount > 0) {
          results.whatsapp.success = true;
          results.whatsapp.scheduledCount = scheduledCount;
          Logger.info('Scheduled follow-up WhatsApp reminders', {
            bookingId: booking.bookingId,
            scheduledCount,
            phone: booking.clientPhone
          });
        } else {
          const skippedCount = Object.values(whatsappResults).filter(r => r.skipped).length;
          results.whatsapp.error = `Failed to schedule WhatsApp reminders (${skippedCount} skipped)`;
        }
      } catch (error) {
        results.whatsapp.error = error.message;
        Logger.error('Failed to schedule follow-up WhatsApp', {
          bookingId: booking.bookingId,
          error: error.message
        });
      }
    } else {
      results.whatsapp.error = 'No phone number available for booking';
    }

    // Determine overall success
    const overallSuccess = results.email.success && 
                          (results.call.success || !booking.clientPhone) && 
                          (results.whatsapp.success || !booking.clientPhone);

    return res.status(overallSuccess ? 200 : 207).json({
      success: overallSuccess,
      message: overallSuccess 
        ? 'Follow-up scheduled successfully' 
        : 'Follow-up scheduled with some errors',
      results,
      scheduledFor: {
        email: followUpDate.toISOString(),
        call: callTime.toISOString(),
        whatsapp: whatsappTime.toISOString()
      }
    });

  } catch (error) {
    Logger.error('Error scheduling follow-up', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      success: false,
      message: 'Failed to schedule follow-up',
      error: error.message
    });
  }
}


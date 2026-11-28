// import express from 'express';
// import Routes from './Routes.js';
// import Connection from './Utils/ConnectDB.js';
// import cors from 'cors';
// import 'dotenv/config';
// import { callQueue } from './Utils/queue.js';
// import Twilio from 'twilio';
// import { DateTime } from 'luxon';
// import { Worker } from 'bullmq';
// import { DiscordConnect } from './Utils/DiscordConnect.js';
// import TwilioReminder from './Controllers/TwilioReminder.js';

// // -------------------- Express Setup --------------------
// const app = express();
// const allowedOrigins = [
//   "https://flashfire-frontend-hoisted.vercel.app", // your frontend
//   "http://localhost:5173",
//   "https://www.flashfirejobs.com"
// ];

// app.use(
//   cors({
//     origin: allowedOrigins,
//     methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//     credentials: true,
//   })
// );

// // ✅ Handle preflight requests for all routes
// // app.options("*", cors());
// // app.use(cors());
// app.use(express.json());
// app.use(express.urlencoded({ extended: false }));


// // -------------------- Discord Utility --------------------
// export const DiscordConnectForMeet = async (message) => {
//   const webhookURL = process.env.DISCORD_MEET_WEB_HOOK_URL;
//   try {
//     const response = await fetch(webhookURL, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ content: `🚨 App Update: ${message}` }),
//     });

//     if (!response.ok) throw new Error(`Failed to send: ${response.statusText}`);

//     console.log('✅ Message sent to Discord!');
//   } catch (error) {
//     console.error('❌ Error sending message:', error);
//   }
// };



// app.post("/call-status", async (req, res) => {
//   const { CallSid, CallStatus, To, From, AnsweredBy, Timestamp } = req.body;

//   try {
//     console.log(`📞 Call Update: SID=${CallSid}, To=${To}, Status=${CallStatus}, AnsweredBy=${AnsweredBy}`);

//     const msg = `
// 📞 **Call Status Update**
// - To: ${To}
// - From: ${From}
// - Status: ${CallStatus}
// - Answered By: ${AnsweredBy || "Unknown"}
// - At: ${Timestamp || new Date().toISOString()}
// SID: ${CallSid}
//     `;

//     await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, msg);

//     res.status(200).send("✅ Call status received");
//   } catch (error) {
//     console.error("❌ Error in /call-status:", error);
//     res.status(500).send("Server Error");
//   }
// });

// // -------------------- Calendly Webhook --------------------
// app.post('/calendly-webhook', async (req, res) => {
//   const { event, payload } = req.body;

//   try {
//     if (event === "invitee.created") {
//       console.log("📥 Calendly Webhook Received:", JSON.stringify(payload, null, 2));

//       // ✅ Calculate meeting start in UTC
//       const meetingStart = new Date(payload?.scheduled_event?.start_time);
//       const delay = meetingStart.getTime() - Date.now() - (10 * 60 * 1000);

//       if (delay < 0) {
//         console.log('⚠ Meeting is too soon to schedule calls.');
//         return res.status(400).json({ error: 'Meeting too soon to schedule call' });
//       }

//       // ✅ Convert to different time zones
//       const meetingStartUTC = DateTime.fromISO(payload?.scheduled_event?.start_time, { zone: 'utc' });
//       const meetingTimeUS = meetingStartUTC.setZone('America/New_York').toFormat('ff');
//       const meetingTimeIndia = meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');

//       // ✅ Extract details
//       const inviteeName = payload?.invitee?.name || payload?.name;
//       const inviteeEmail = payload?.invitee?.email || payload?.email;
//       let inviteePhone = payload?.questions_and_answers?.find(q =>
//   q.question.trim().toLowerCase() === 'phone number'
// )?.answer || null;

// if (inviteePhone) {
//   // Remove spaces and any non-digit except leading +
//   inviteePhone = inviteePhone.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '');
// }
//       const meetLink = payload?.scheduled_event?.location?.join_url || 'Not Provided';
//       const bookedAt = new Date(req.body?.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

//       // ✅ Prepare booking details for Discord
//       const bookingDetails = {
//         "Invitee Name": inviteeName,
//         "Invitee Email": inviteeEmail,
//         "Invitee Phone": inviteePhone || 'Not Provided',
//         "Google Meet Link": meetLink,
//         "Meeting Time (Client US)": meetingTimeUS,
//         "Meeting Time (Team India)": meetingTimeIndia,
//         "Booked At": bookedAt
//       };

//       console.log("📅 New Calendly Booking:", bookingDetails);

//       // ✅ Send to Discord
//       await DiscordConnectForMeet(JSON.stringify(bookingDetails, null, 2));

//       // ✅ Validate phone numbers

//       const phoneRegex = /^\+?[1-9]\d{9,14}$/;
//       let scheduledJobs = [];

//       if (inviteePhone && phoneRegex.test(inviteePhone)) {
//         await callQueue.add('callUser', {
//           phone: inviteePhone,
//           meetingTime: meetingTimeIndia,// meetingTimeUS,
//           role: 'client'
//         }, { delay });
//         scheduledJobs.push(`Client: ${inviteePhone}`);
//         console.log(`📞 Valid phone, scheduled: ${inviteePhone}`);
//         const scheduledMessage =`Reminder Call Scheduled For ${inviteePhone}-${inviteeName} for meeting scheduled on ${meetingTimeIndia} (IST).Reminder 10 minutes before Start of meeting.`
//         await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, scheduledMessage);
//       } else {
//         console.log("⚠ No valid phone number provided by invitee.");
//         await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
//           `⚠ No valid phone for client: ${inviteeName} (${inviteeEmail}) — Got: ${inviteePhone}`
//         );
//       }

//       console.log(`✅ Scheduled calls: ${scheduledJobs.join(', ')}`);
//       DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`✅ Scheduled calls: ${scheduledJobs.join(', ')}` )

//       return res.status(200).json({
//         message: 'Webhook received & calls scheduled',
//         bookingDetails,
//         scheduledCalls: scheduledJobs
//       });
//     }

//     return res.status(200).json({ message: 'Ignored non-invitee event' });

//   } catch (error) {
//     console.error('❌ Error processing Calendly webhook:', error);
//     res.status(500).json({ error: 'Internal Server Error' });
//   }
// });
// app.post("/twilio-ivr", TwilioReminder);
// // -------------------- Worker Setup --------------------
// const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
   

// new Worker(
//   'callQueue',
//   async (job) => {
//     console.log(`[Worker] Processing job for ${job.data.phone}`);

//     try {
//       const call = await client.calls.create({
//         to: job.data.phone,
//         from: process.env.TWILIO_FROM, // must be a Twilio voice-enabled number
//         url: `https://api.flashfirejobs.com/twilio-ivr?meetingTime=${encodeURIComponent(job.data.meetingTime)}`,
//         statusCallback: 'https://api.flashfirejobs.com/call-status',
//         statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
//         method: 'POST', // optional (Twilio defaults to POST for Calls API)
//       });

//       console.log(`[Worker] ✅ Call initiated. SID: ${call.sid} Status: ${call.status}`);
//       DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`[Worker] ✅ Call initiated. SID: ${call.sid} Status: ${call.status}` )
//     } catch (error) {
//       console.error(`[Worker] ❌ Twilio call failed for ${job.data.phone}:`, error.message);
//       await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`❌ Twilio call failed for ${job.data.phone}. Error: ${error.message}`);
//     }
//   },
//   { connection: { url: process.env.UPSTASH_REDIS_URL } }
// );

// // -------------------- Base Route --------------------
// app.get("/", (req, res) => {
//   res.send("FlashFire API is up and running 🚀");
// });

// // -------------------- Routes & DB --------------------
// Routes(app);
// Connection();

// // -------------------- Start Server --------------------
// const PORT = process.env.PORT;
// if (!PORT) throw new Error('❌ process.env.PORT is not set. This is required for Render deployment.');

// app.listen(PORT || 4001, () => {
//   console.log('✅ Server is live at port:', PORT || 4001);
// });



import compression from 'compression';
import { handleCalendlyWebhook } from './Controllers/CalendlyWebhookController.js';
import express from 'express';
import Routes from './Routes.js';
import Connection from './Utils/ConnectDB.js';
import { activityLogMiddleware } from './Utils/ActivityLogger.js';
import cors from 'cors';
import 'dotenv/config';
// Redis/BullMQ removed — call scheduling via MongoDB-based CallScheduler + UnifiedScheduler
import Twilio from 'twilio';
import { DateTime } from 'luxon';
import { Logger } from './Utils/Logger.js';
import { basicFraudCheck } from './Utils/FraudScreening.js';
import { DiscordConnect } from './Utils/DiscordConnect.js';
import TwilioReminder from './Controllers/TwilioReminder.js';
import { CampaignBookingModel } from './Schema_Models/CampaignBooking.js';
import { UserModel } from './Schema_Models/User.js';
import { CampaignModel } from './Schema_Models/Campaign.js';
import { initGeoIp, getClientIp, detectCountryFromIp } from './Utils/GeoIP.js';
// DISABLED: Redis workers causing "Too many requests" rate limiting issues
// Using MongoDB-based JobScheduler instead for email and WhatsApp campaigns
// import emailWorker from './Utils/emailWorker.js';
// import whatsappWorker from './Utils/whatsappWorker.js';
// import './Utils/worker.js'; // Import worker to start it (handles callQueue jobs)
// import { redisConnection } from './Utils/queue.js'; // Import shared ioredis connection

import { getJobSchedulerStats } from './Utils/JobScheduler.js';
import { scheduleCall, cancelCall, getSchedulerStats, getUpcomingCalls } from './Utils/CallScheduler.js';
import { scheduleDiscordMeetReminder } from './Utils/DiscordMeetReminderScheduler.js';
import { getRescheduleLinkForBooking } from './Utils/CalendlyAPIHelper.js';
import watiService from './Utils/WatiService.js';
import { APP_VERSION, APP_VERSION_NOTE } from './config/version.js';

// -------------------- Express Setup --------------------
const app = express();
// Respect proxy headers like X-Forwarded-For when deployed behind proxies (Render/NGINX/Cloudflare)
app.set('trust proxy', true);
const allowedOrigins = [
  "https://flashfire-frontend-hoisted.vercel.app", // your frontend
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5174/",
  "https://www.flashfirejobs.com",
  "https://flashfirejobs.com"
];

// Permissive CORS in production (allows all origins/headers). Safe with credentials when origin: true
app.use(
  cors({
    origin: true, // reflect request origin
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// ✅ Handle preflight requests for all routes
// Handle preflight for any path (Express 5: avoid "*" pattern)
app.options(/.*/, cors({ origin: true, credentials: true }));
// app.use(cors());
// NOTE: Server-Sent Events (the BDA attendance panel live feed) must NOT be
// compressed. compression() buffers the response body and only flushes past a
// size threshold; an SSE stream sends tiny events and never ends, so the initial
// `connected` bytes get stuck in the buffer and the client's EventSource hangs in
// CONNECTING forever. Skip compression for the SSE endpoint.
app.use(
  compression({
    filter: (req, res) => {
      if (
        req.path === '/api/bda-attendance/sse' ||
        res.getHeader('Content-Type') === 'text/event-stream'
      ) {
        return false;
      }
      return compression.filter(req, res);
    },
  })
);
// Stripe webhook must receive raw body for signature verification.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
// Capture raw bytes for Zoom Phone webhook HMAC verification.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if (req.originalUrl && req.originalUrl.startsWith('/api/zoom-phone/webhook')) {
        req.rawBody = buf;
      }
    },
  })
);
app.use(express.urlencoded({ extended: false }));

// Activity logging — records every mutating CRM/BDA request after it finishes.
app.use(activityLogMiddleware);




// -------------------- Discord Utility --------------------
// Use the shared DiscordConnect with retry/rate-limit handling instead of raw fetch
export { DiscordConnectForMeet } from './Utils/DiscordConnect.js';



// GET handler for /call-status (for testing/debugging)
app.get("/call-status", async (req, res) => {
  const discordWebhookConfigured = !!process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
  const webhookUrlPreview = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL 
    ? `${process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL.substring(0, 30)}...` 
    : 'Not configured';

  res.status(200).json({
    message: "✅ Call Status Webhook Endpoint is active",
    endpoint: "/call-status",
    method: "POST (for Twilio webhooks)",
    status: "operational",
    discordWebhook: {
      configured: discordWebhookConfigured,
      urlPreview: webhookUrlPreview
    },
    scheduling: "MongoDB-based (UnifiedScheduler + CallScheduler)",
    twilio: {
      fromNumber: process.env.TWILIO_FROM ? 'Configured' : 'Not configured',
      accountSid: process.env.TWILIO_ACCOUNT_SID ? 'Configured' : 'Not configured'
    },
    note: "This endpoint accepts POST requests from Twilio. Use POST method to send call status updates."
  });
});

// Diagnostic endpoint to check call system health
app.get("/api/call-system-status", async (req, res) => {
  try {
    const status = {
      timestamp: new Date().toISOString(),
      discord: {
        webhookConfigured: !!process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        urlPreview: process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL 
          ? `${process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL.substring(0, 40)}...` 
          : 'NOT CONFIGURED ⚠️'
      },
      twilio: {
        fromNumber: process.env.TWILIO_FROM || 'NOT CONFIGURED ⚠️',
        accountSid: process.env.TWILIO_ACCOUNT_SID ? 'Configured' : 'NOT CONFIGURED ⚠️',
        authToken: process.env.TWILIO_AUTH_TOKEN ? 'Configured' : 'NOT CONFIGURED ⚠️'
      },
      scheduling: "MongoDB-based (UnifiedScheduler + CallScheduler)"
    };

    // Check recent bookings with call jobs
    try {
      const recentBookings = await CampaignBookingModel.find({
        reminderCallJobId: { $exists: true, $ne: null },
        bookingStatus: 'scheduled'
      })
      .sort({ bookingCreatedAt: -1 })
      .limit(5)
      .select('clientName clientPhone reminderCallJobId scheduledEventStartTime bookingCreatedAt')
      .lean();

      status.recentBookings = recentBookings.map(b => ({
        clientName: b.clientName,
        clientPhone: b.clientPhone,
        jobId: b.reminderCallJobId,
        meetingTime: b.scheduledEventStartTime,
        bookedAt: b.bookingCreatedAt
      }));
    } catch (error) {
      status.recentBookingsError = error.message;
    }

    res.status(200).json(status);
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});


app.post("/api/debug/test-call", async (req, res) => {
  try {
    const { phone, meetingTime, email } = req.body || {};

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: phone (E.164 format, e.g. +19135551234)",
      });
    }

    // Redis/BullMQ removed. Use POST /api/campaign-bookings/:id/reschedule or the
    // UnifiedScheduler to test calls via the MongoDB-based scheduling path.
    return res.status(410).json({
      success: false,
      error: "BullMQ queue removed. Use MongoDB-based CallScheduler instead.",
      hint: "Create a ScheduledCall record directly or use the booking reschedule endpoint."
    });

    if (!process.env.TWILIO_FROM || !process.env.TWILIO_ACCOUNT_SID) {
      return res.status(500).json({
        success: false,
        error: "Twilio environment variables are not fully configured.",
        twilio: {
          fromNumber: process.env.TWILIO_FROM || "NOT CONFIGURED",
          accountSid: process.env.TWILIO_ACCOUNT_SID ? "Configured" : "NOT CONFIGURED",
        },
      });
    }

    // Use a simple regex to validate E.164-like numbers
    const phoneRegex = /^\+?[1-9]\d{9,14}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        error: "Invalid phone format. Use E.164 (e.g. +19135551234).",
      });
    }

    // Build a fake "meeting time" 10 minutes from now if not provided
    const eventStart = meetingTime
      ? DateTime.fromISO(meetingTime)
      : DateTime.now().plus({ minutes: 10 });

    const meetingTimeIndia = eventStart.setZone("Asia/Kolkata").toFormat("ff");

    // Small delay so you can see the job queued before it fires
    const delayMs = 5_000;

    const job = await callQueue.add(
      "callUser",
      {
        type: "call_reminder",
        phone,
        phoneNumber: phone, // Include both for compatibility with all workers
        meetingTime: meetingTimeIndia,
        inviteeEmail: email || null,
        eventStartISO: eventStart.toISO(),
        force: true,        // ⬅ bypass calendar presence check for debug
        source: "debug_api" // ⬅ mark as coming from debug endpoint
      },
      {
        delay: delayMs,
        removeOnComplete: true,
        removeOnFail: 10,
      }
    );

    const summary = {
      jobId: job.id,
      phone,
      meetingTimeIST: meetingTimeIndia,
      delayMs,
    };

    Logger.info("🧪 Enqueued debug test-call job", summary);

    // Fetch all scheduled calls (waiting and delayed jobs)
    let allScheduledCalls = [];
    try {
      const waitingJobs = await callQueue.getWaiting();
      const delayedJobs = await callQueue.getDelayed();
      const activeJobs = await callQueue.getActive();
      
      // Create sets of job IDs for quick lookup
      const delayedJobIds = new Set(delayedJobs.map(j => j.id));
      const activeJobIds = new Set(activeJobs.map(j => j.id));
      const waitingJobIds = new Set(waitingJobs.map(j => j.id));
      
      // Combine all jobs and remove duplicates by job ID
      const allJobsMap = new Map();
      [...waitingJobs, ...delayedJobs, ...activeJobs].forEach((job) => {
        if (!allJobsMap.has(job.id)) {
          allJobsMap.set(job.id, job);
        }
      });
      const allJobs = Array.from(allJobsMap.values());
      
      allScheduledCalls = allJobs.map((job) => {
        const jobData = job.data || {};
        
        // Calculate scheduled time
        let scheduledFor = null;
        if (job.timestamp) {
          scheduledFor = new Date(job.timestamp + (job.opts?.delay || 0)).toISOString();
        } else if (job.opts?.delay) {
          scheduledFor = new Date(Date.now() + job.opts.delay).toISOString();
        }
        
        // Determine status
        let status = 'unknown';
        if (activeJobIds.has(job.id)) {
          status = 'active';
        } else if (delayedJobIds.has(job.id)) {
          status = 'delayed';
        } else if (waitingJobIds.has(job.id)) {
          status = 'waiting';
        }
        
        return {
          jobId: job.id,
          phone: jobData.phone || 'N/A',
          email: jobData.inviteeEmail || jobData.email || null,
          meetingTime: jobData.meetingTime || 'N/A',
          scheduledFor: scheduledFor,
          scheduledForLocal: scheduledFor ? new Date(scheduledFor).toLocaleString() : 'N/A',
          status: status,
          source: jobData.source || jobData.type || 'unknown',
          delayMs: job.opts?.delay || 0,
        };
      }).sort((a, b) => {
        // Sort by scheduled time (earliest first)
        if (a.scheduledFor && b.scheduledFor) {
          return new Date(a.scheduledFor) - new Date(b.scheduledFor);
        }
        if (a.scheduledFor && !b.scheduledFor) return -1;
        if (!a.scheduledFor && b.scheduledFor) return 1;
        return 0;
      });
    } catch (error) {
      Logger.error("Error fetching scheduled calls", {
        error: error.message,
      });
    }

    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `🧪 **Debug Test Call Job Created**\n- Phone: ${phone}\n- Meeting Time (IST): ${meetingTimeIndia}\n- Delay: ${Math.round(
          delayMs / 1000
        )}s\n- Job ID: ${job.id}`
      );
    }

    res.status(200).json({
      success: true,
      message: "Debug call job enqueued. Watch Discord and /call-status for logs.",
      data: summary,
      allScheduledCalls: {
        total: allScheduledCalls.length,
        calls: allScheduledCalls,
        summary: {
          waiting: allScheduledCalls.filter(c => c.status === 'waiting').length,
          delayed: allScheduledCalls.filter(c => c.status === 'delayed').length,
          active: allScheduledCalls.filter(c => c.status === 'active').length,
        }
      },
    });
  } catch (error) {
    Logger.error("Error in /api/debug/test-call", {
      error: error.message,
      stack: error.stack,
    });

    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `❌ Error in /api/debug/test-call: ${error.message}`
      );
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Translate raw Twilio CallStatus + duration into a human-readable label.
 * Twilio sends "completed" even when the callee immediately rejects/cuts the call
 * (duration = 0). We distinguish that here.
 */
function getEffectiveCallStatus(callStatus, durationSecs) {
  const dur = parseInt(durationSecs ?? 0, 10) || 0;
  switch (callStatus) {
    case 'completed':
      return dur <= 2
        ? '📵 Rejected / Cut Short (0s)'
        : `✅ Answered & Completed (${dur}s)`;
    case 'no-answer':  return '🔇 No Answer';
    case 'busy':       return '📵 Busy';
    case 'failed':     return '❌ Failed';
    case 'canceled':   return '🚫 Canceled';
    case 'initiated':  return '📲 Initiated';
    case 'ringing':    return '🔔 Ringing';
    case 'in-progress':return '📞 In Progress';
    default:           return callStatus || 'Unknown';
  }
}

function buildCallSummaryMessage(scheduledCall, meetingInfo, To, From, CallSid) {
  // Use the last status entry as the final result
  const last = scheduledCall.statusHistory?.[scheduledCall.statusHistory.length - 1];
  const effectiveStatus = last
    ? getEffectiveCallStatus(last.status, last.duration)
    : 'Unknown';

  let summary = `📞 **Call Summary**\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  summary += `👤 **Client:** ${meetingInfo.inviteeName || 'Unknown'}\n`;
  if (meetingInfo.inviteeEmail && meetingInfo.inviteeEmail !== 'Unknown') {
    summary += `📧 **Email:** ${meetingInfo.inviteeEmail}\n`;
  }
  summary += `📞 **Phone:** ${To}\n`;
  summary += `🏁 **Result:** ${effectiveStatus}\n`;
  if (last?.duration) {
    summary += `⏱️ **Duration:** ${last.duration}s\n`;
  }
  if (meetingInfo.meetingTime && meetingInfo.meetingTime !== 'Unknown') {
    summary += `📆 **Meeting (Client):** ${meetingInfo.meetingTime}\n`;
  }
  if (meetingInfo.meetingTimeIndia) {
    summary += `📆 **Meeting (India):** ${meetingInfo.meetingTimeIndia}\n`;
  }
  summary += `🎫 **Twilio SID:** ${CallSid}\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  return summary;
}

// POST handler for /call-status (Twilio webhook)
app.post("/call-status", async (req, res) => {
  const { CallSid, CallStatus, To, From, AnsweredBy, Timestamp, CallDuration } = req.body;

  try {
    // Log the raw request for debugging
    console.log(`📞 Call Status Webhook Received:`, {
      CallSid,
      CallStatus,
      To,
      From,
      AnsweredBy,
      Timestamp,
      CallDuration,
      receivedAt: new Date().toISOString()
    });

    Logger.info('📞 Call Status Update received from Twilio', {
      CallSid,
      CallStatus,
      To,
      From,
      AnsweredBy,
      Timestamp,
      CallDuration
    });

    let scheduledCall = null;
    let meetingInfo = {};
    let isFinalStatus = false;
    try {
      const { ScheduledCallModel } = await import('./Schema_Models/ScheduledCall.js');
      scheduledCall = await ScheduledCallModel.findOne({ twilioCallSid: CallSid });
      
      if (scheduledCall) {
        // Fix meetingTime if it's "Invalid DateTime" — reformat from the ISO date
        let meetingTimeDisplay = scheduledCall.meetingTime || 'Unknown';
        if (meetingTimeDisplay === 'Invalid DateTime' && scheduledCall.meetingStartISO) {
          try {
            const dt = DateTime.fromJSDate(
              scheduledCall.meetingStartISO instanceof Date
                ? scheduledCall.meetingStartISO
                : new Date(scheduledCall.meetingStartISO),
              { zone: 'utc' }
            );
            if (dt.isValid) {
              meetingTimeDisplay = dt.setZone('Asia/Kolkata').toFormat('ff');
            }
          } catch { /* keep existing value */ }
        }

        // Also derive India time for team reference
        let meetingTimeIndia = '';
        if (scheduledCall.meetingStartISO) {
          try {
            const dtIndia = DateTime.fromJSDate(
              scheduledCall.meetingStartISO instanceof Date
                ? scheduledCall.meetingStartISO
                : new Date(scheduledCall.meetingStartISO),
              { zone: 'utc' }
            );
            if (dtIndia.isValid) {
              meetingTimeIndia = dtIndia.setZone('Asia/Kolkata').toFormat('ff');
            }
          } catch { /* ignore */ }
        }
        // Use metadata.meetingTimeIndia if stored (backward compat)
        if (!meetingTimeIndia && scheduledCall.metadata?.meetingTimeIndia) {
          meetingTimeIndia = scheduledCall.metadata.meetingTimeIndia;
        }

        meetingInfo = {
          inviteeName: scheduledCall.inviteeName || 'Unknown',
          inviteeEmail: scheduledCall.inviteeEmail || 'Unknown',
          meetingTime: meetingTimeDisplay,
          meetingTimeIndia,
        };
        
        // Track status history
        const statusTimestamp = Timestamp ? new Date(Timestamp) : new Date();
        const statusUpdate = {
          status: CallStatus,
          answeredBy: AnsweredBy || 'Unknown',
          timestamp: statusTimestamp,
          duration: CallDuration ? parseInt(CallDuration) : null,
          rawData: req.body
        };
        
        // Determine if this is a final status
        const finalStatuses = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
        isFinalStatus = finalStatuses.includes(CallStatus);

        // Better DB status: "completed" with 0s duration = rejected/cut, store as "rejected"
        const duration = CallDuration ? parseInt(CallDuration, 10) : 0;
        const statusMap = {
          'completed': duration <= 2 ? 'rejected' : 'completed',
          'busy':      'failed',
          'failed':    'failed',
          'no-answer': 'no-answer',
          'canceled':  'cancelled'
        };

        const updateData = {
          $push: { statusHistory: statusUpdate }
        };

        if (statusMap[CallStatus]) {
          updateData.status = statusMap[CallStatus];
          if (CallStatus === 'completed') {
            updateData.completedAt = new Date();
            updateData.callDuration = duration;
          }
        }
        
        await ScheduledCallModel.updateOne(
          { _id: scheduledCall._id },
          updateData
        );
        
        // Reload to get updated status history
        scheduledCall = await ScheduledCallModel.findById(scheduledCall._id);
      }
    } catch (lookupError) {
      console.warn('Could not lookup scheduled call:', lookupError.message);
    }

    // Format timestamp
    const statusTimestamp = Timestamp ? new Date(Timestamp).toISOString() : new Date().toISOString();
    const statusDate = Timestamp ? new Date(Timestamp).toUTCString() : new Date().toUTCString();

    // Build Discord message with meaningful status
    const effectiveStatus = getEffectiveCallStatus(CallStatus, CallDuration);
    let msg = `📞 **Call Update: ${effectiveStatus}**\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📞 **To:** ${To}\n`;

    if (meetingInfo.inviteeName && meetingInfo.inviteeName !== 'Unknown') {
      msg += `👤 **Name:** ${meetingInfo.inviteeName}\n`;
    }
    if (meetingInfo.inviteeEmail && meetingInfo.inviteeEmail !== 'Unknown') {
      msg += `📧 **Email:** ${meetingInfo.inviteeEmail}\n`;
    }

    msg += `🏁 **Status:** ${effectiveStatus}\n`;
    if (CallDuration) msg += `⏱️ **Duration:** ${CallDuration}s\n`;
    if (AnsweredBy && AnsweredBy !== 'unknown') msg += `☎️ **Answered By:** ${AnsweredBy}\n`;

    if (meetingInfo.meetingTime && meetingInfo.meetingTime !== 'Unknown') {
      msg += `📆 **Meeting (Client):** ${meetingInfo.meetingTime}\n`;
    }
    if (meetingInfo.meetingTimeIndia) {
      msg += `📆 **Meeting (India):** ${meetingInfo.meetingTimeIndia}\n`;
    }

    msg += `🎫 **Twilio SID:** ${CallSid}\n`;
    msg += `🕐 **At:** ${statusDate}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    // Send Discord notification if configured
    const discordWebhookUrl = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
    if (discordWebhookUrl) {
      Logger.info('Sending call status to Discord', { CallSid, CallStatus, hasWebhook: !!discordWebhookUrl });
      await DiscordConnect(discordWebhookUrl, msg);
      console.log('✅ Discord notification sent for call status');
      
      // If this is a final status, send comprehensive summary message
      if (isFinalStatus && scheduledCall && scheduledCall.statusHistory && scheduledCall.statusHistory.length > 0) {
        const summaryMsg = buildCallSummaryMessage(scheduledCall, meetingInfo, To, From, CallSid);
        await DiscordConnect(discordWebhookUrl, summaryMsg);
        console.log('✅ Discord summary notification sent for call completion');
      }
    } else {
      console.warn("⚠️ DISCORD_REMINDER_CALL_WEBHOOK_URL not configured. Discord notification skipped.");
      Logger.warn('Discord webhook URL not configured - skipping notification', { CallSid, CallStatus });
    }

    res.status(200).send("✅ Call status received");
  } catch (error) {
    console.error("❌ Error in /call-status:", error);
    Logger.error('Error processing call status webhook', { error: error.message, stack: error.stack });
    res.status(500).send("Server Error");
  }
});

// -------------------- Calendly Webhook --------------------
app.post('/calendly-webhook', handleCalendlyWebhook);
app.post("/twilio-ivr", TwilioReminder);

// -------------------- /send/temp — Test all Discord notification types --------------------
app.post('/send/temp', async (req, res) => {
  try {
    const {
      clientName = 'Test Client',
      clientEmail = 'test@example.com',
      phoneNumber = '+19135551234',
      meetingStartISO,
      bdaEmail = 'bda@example.com',
      inviteeTimezone = 'America/New_York',
    } = req.body || {};

    const meetingStart = meetingStartISO
      ? new Date(meetingStartISO)
      : new Date(Date.now() + 15 * 60 * 1000);

    const meetingStartUTC = DateTime.fromJSDate(meetingStart, { zone: 'utc' });
    const clientZone = inviteeTimezone || 'America/Los_Angeles';
    // Include timezone abbreviation (e.g. "PDT", "CDT", "IST")
    const tzAbbr = meetingStartUTC.isValid ? meetingStartUTC.setZone(clientZone).toFormat('ZZZZ') : '';
    const formattedClient = meetingStartUTC.isValid
      ? meetingStartUTC.setZone(clientZone).toFormat('ff') + ' ' + tzAbbr
      : 'Unknown';
    const formattedIndia = meetingStartUTC.isValid
      ? meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff') + ' IST'
      : 'Unknown';

    const callSid = `CA_TEST_${Date.now().toString(36)}`;
    const bookingId = `test_${Date.now()}`;
    const results = {};

    const callWebhook = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
    const meetWebhook = process.env.DISCORD_MEET_WEB_HOOK_URL;

    // 1. Meeting Booked notification — exact same format as real CalendlyWebhookController
    if (meetWebhook) {
      try {
        const bookingDetails = {
          'Booking ID': bookingId,
          'Campaign ID': 'test_campaign',
          'Invitee Name': clientName,
          'Invitee Email': clientEmail,
          'Invitee Phone': phoneNumber,
          'Google Meet Link': 'https://meet.google.com/test-link',
          'Real Google Meet Link': 'https://meet.google.com/test-link',
          'Reschedule Link': 'https://calendly.com/reschedulings/test',
          'Meeting Time (Client)': formattedClient,
          'Meeting Time (Team India)': formattedIndia,
          'Client Timezone': inviteeTimezone || 'Not provided',
          'Booked At': new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
          'UTM Source': 'test',
          'UTM Medium': 'N/A',
          'UTM Campaign': 'N/A',
          'Database Status': '\u2705 SAVED (TEST)',
        };
        const r = await DiscordConnect(meetWebhook, JSON.stringify(bookingDetails, null, 2));
        results.meetingBooked = { success: r.ok, error: r.error };
      } catch (err) {
        results.meetingBooked = { success: false, error: err.message };
      }
    } else {
      results.meetingBooked = { success: false, error: 'DISCORD_MEET_WEB_HOOK_URL not configured' };
    }

    // 1b. Call Scheduled notification
    if (callWebhook) {
      try {
        const callScheduledMsg =
          `\u{1F4C5} **Call Scheduled (MongoDB)**\n` +
          `\u{1F4DE} Phone: ${phoneNumber}\n` +
          `\u{1F464} Name: ${clientName}\n` +
          `\u{1F4E7} Email: ${clientEmail}\n` +
          `\u23F0 Call at: ${new Date(meetingStart.getTime() - 10 * 60 * 1000).toISOString()}\n` +
          `\u{1F4C6} Meeting (Client): ${formattedClient}\n` +
          `\u{1F4C6} Meeting (India): ${formattedIndia}\n` +
          `\u23F3 In: 10 minutes\n` +
          `\u{1F516} Source: test`;
        const r = await DiscordConnect(callWebhook, callScheduledMsg);
        results.callScheduled = { success: r.ok, error: r.error };
      } catch (err) {
        results.callScheduled = { success: false, error: err.message };
      }
    }

    // 2-4. Call status progression (initiated, ringing, completed)
    if (callWebhook) {
      for (const status of ['initiated', 'ringing', 'completed']) {
        const statusDate = new Date().toUTCString();
        let msg = `\u{1F6A8} **App Update: ${status}**\n`;
        msg += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
        msg += `\u{1F4DE} **To:** ${phoneNumber}\n`;
        msg += `\u{1F464} **From:** +14722138424\n`;
        msg += `\u{1F464} **Name:** ${clientName}\n`;
        msg += `\u{1F464} **Status:** ${status}\n`;
        msg += `\u{1F464} **Answered By:** ${status === 'completed' ? 'human' : 'Unknown'}\n`;
        if (status === 'completed') {
          msg += `\u23F1\uFE0F **Duration:** 15 seconds\n`;
        }
        msg += `\u{1F464} **Call SID:** ${callSid}\n`;
        msg += `\u{1F464} **Timestamp:** ${statusDate}\n`;
        msg += `\u{1F4E7} **Email:** ${clientEmail}\n`;
        msg += `\u{1F4C6} **Meeting (Client):** ${formattedClient}\n`;
        msg += `\u{1F4C6} **Meeting (India):** ${formattedIndia}\n`;
        msg += `\u{1F3AB} **Twilio SID:** ${callSid}\n`;
        msg += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`;

        try {
          const r = await DiscordConnect(callWebhook, msg, false);
          results[`call_${status}`] = { success: r.ok, error: r.error };
        } catch (err) {
          results[`call_${status}`] = { success: false, error: err.message };
        }
      }
    } else {
      results.call_initiated = { success: false, error: 'DISCORD_REMINDER_CALL_WEBHOOK_URL not configured' };
    }

    // 5. Meeting reminder (hot lead)
    if (meetWebhook) {
      try {
        const minutesUntil = Math.max(0, Math.round((meetingStart.getTime() - Date.now()) / 60000));
        const reminderMsg = [
          `\u{1F525} **Hot Lead \u2014 Meeting in ~${minutesUntil} minutes**`,
          ``,
          `**Client:** ${clientName}`,
          `**Time (Client):** ${formattedClient}`,
          `**Time (India):** ${formattedIndia}`,
          `**Link:** https://meet.google.com/test-link`,
          `**Assigned BDA:** ${bdaEmail}`,
          ``,
          `BDA team, confirm attendance by typing **"I'm in."** Let's close this.`,
        ].join('\n');
        const r = await DiscordConnect(meetWebhook, reminderMsg, false);
        results.hotLead = { success: r.ok, error: r.error };
      } catch (err) {
        results.hotLead = { success: false, error: err.message };
      }
    }

    // Summary
    const totalSent = Object.values(results).filter(r => r.success).length;
    const totalFailed = Object.values(results).filter(r => !r.success).length;

    Logger.info('/send/temp completed', { totalSent, totalFailed });

    res.json({
      status: totalFailed === 0 ? 'all_sent' : totalSent === 0 ? 'all_failed' : 'partial',
      totalSent,
      totalFailed,
      meetingTime: { client: formattedClient, india: formattedIndia, timezone: inviteeTimezone, iso: meetingStart.toISOString() },
      results,
      webhooks: {
        DISCORD_MEET_WEB_HOOK_URL: !!meetWebhook,
        DISCORD_REMINDER_CALL_WEBHOOK_URL: !!callWebhook,
        DISCORD_BDA_ATTENDANCE_WEBHOOK_URL: !!process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL,
      },
    });
  } catch (error) {
    Logger.error('/send/temp error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------- Worker Setup --------------------
// Worker is now handled in Utils/worker.js to avoid duplicate connections
// This reduces Redis connection count and prevents "Too many requests" errors

// -------------------- Base Route --------------------
app.get("/", (req, res) => {
  res.send("FlashFire API is up and running 🚀");
});

// -------------------- Build Version --------------------
// Bump config/version.js on every deploy; hit this to confirm which build is live.
app.get('/api/get-version', (req, res) => {
  res.status(200).json({
    success: true,
    version: APP_VERSION,
    note: APP_VERSION_NOTE,
  });
});

// -------------------- GeoIP Route --------------------
app.get('/api/geo', (req, res) => {
  try {
    // Allow test overrides in dev: ?debugIp=1.2.3.4 or env FORCE_TEST_IP
    let ip = req.query?.debugIp || process.env.FORCE_TEST_IP || getClientIp(req);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[GeoAPI] Incoming /api/geo request');
      console.log('[GeoAPI] Headers of interest:', {
        'cf-connecting-ip': req.headers['cf-connecting-ip'],
        'x-real-ip': req.headers['x-real-ip'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
        remoteAddress: req.connection?.remoteAddress || req.socket?.remoteAddress
      });
      console.log('[GeoAPI] Resolved client IP:', ip);
    }
    const geo = detectCountryFromIp(ip);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[GeoAPI] Result:', geo);
    }
    return res.json({
      success: true,
      countryCode: geo.countryCode,
      country: geo.country,
      ip: ip || undefined,
      detectionMethod: 'ip-geolocation'
    });
  } catch (error) {
    console.error('Geo detection error:', error);
    return res.json({
      success: false,
      countryCode: 'US',
      country: 'United States',
      detectionMethod: 'fallback'
    });
  }
});

// -------------------- Routes & DB --------------------
Routes(app);
Connection();

// -------------------- Start Server --------------------
const PORT = process.env.PORT;
if (!PORT) throw new Error('❌ process.env.PORT is not set. This is required for Render deployment.');

app.listen(PORT || 4001, async () => {
  console.log('✅ Server is live at port:', PORT || 4001);
  
  const { startCronScheduler } = await import('./Utils/cronScheduler.js');
  startCronScheduler();
  
  // Start UnifiedScheduler — replaces 5 separate polling loops with precision timers
  console.log('🚀 [Server] Starting Unified Precision Scheduler...');
  const { UnifiedScheduler, getScheduler } = await import('./Utils/UnifiedScheduler.js');
  const scheduler = new UnifiedScheduler();
  await scheduler.start();
  console.log('✅ [Server] Unified Precision Scheduler started — precision timers active');

  // Independent BDA Discord reminder loop (own interval, own lock). If the unified
  // scheduler ever stalls, BDA reminders still go out. Safe to run alongside it:
  // rows and bookings are claimed atomically, so each reminder is sent only once.
  const { startDiscordMeetReminderScheduler } = await import('./Utils/DiscordMeetReminderScheduler.js');
  startDiscordMeetReminderScheduler();

  // Sales Lead Allocation call reminders (5 min before each allocated call). Claims rows atomically.
  const { startSalesAllocationReminders } = await import('./Utils/SalesAllocationReminder.js');
  startSalesAllocationReminders();
  
  try {
    await watiService.refreshTemplatesCache();
    console.log('✅ [Server] WATI template cache pre-warmed');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to pre-warm WATI template cache:', error.message);
  }

  try {
    const { ensureDefaultCampaigns } = await import('./Scripts/seedDefaultCampaigns.js');
    await ensureDefaultCampaigns();
    console.log('✅ [Server] Default UTM campaigns (whatsapp, instagram) ensured');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to seed default campaigns:', error.message);
  }

  // Zoom Phone — poll call_history every 5 min to backfill calls even if
  // webhook delivery is flaky or recording lags behind the event.
  try {
    const { startZoomPhoneSyncer } = await import('./Utils/ZoomPhoneSync.js');
    startZoomPhoneSyncer(5 * 60 * 1000);
    console.log('✅ [Server] Zoom Phone call-history syncer started (5m interval)');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to start Zoom Phone syncer:', error.message);
  }

  // Call Leads — assign any Meta lead that has gone 24h without booking to the
  // fixed call-lead assignee. A lead becomes assignable purely by ageing past the
  // cutoff, so this has to run on a timer rather than at ingest.
  try {
    const { assignUnassignedCallLeads } = await import('./Controllers/CallLeadsController.js');
    const runAssigner = async () => {
      try {
        const r = await assignUnassignedCallLeads({});
        if (r.assigned > 0) {
          console.log(`✅ [CallLeads] assigned ${r.assigned} lead(s) to ${r.assignee || 'n/a'}`);
        }
      } catch (error) {
        console.warn('⚠️ [CallLeads] assignment pass failed:', error.message);
      }
    };
    await runAssigner();
    setInterval(runAssigner, 10 * 60 * 1000).unref();
    console.log('✅ [Server] Call Leads assigner started (10m interval)');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to start Call Leads assigner:', error.message);
  }

  // Call Leads — daily Discord summary at 4:00 AM IST: unique leads called and time
  // on calls over the last 24h, per-BDA breakdown, and the still-uncalled queue from
  // the past 3 days. 4 AM IST is just past the end of the US-evening calling window.
  try {
    const cronModule = await import('node-cron');
    const { sendCallLeadsDailySummary } = await import('./Controllers/CallLeadsController.js');
    cronModule.default.schedule('0 4 * * *', async () => {
      try {
        await sendCallLeadsDailySummary();
      } catch (error) {
        console.warn('⚠️ [CallLeads] daily summary failed:', error.message);
      }
    }, { scheduled: true, timezone: 'Asia/Kolkata' });
    console.log('✅ [Server] Call Leads daily Discord summary scheduled (4:00 AM IST)');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to schedule Call Leads daily summary:', error.message);
  }

  // Call Leads — 12:00 AM IST Discord message: per BDA, how many no-show and not-scheduled leads
  // from the past 3 days are still uncalled.
  try {
    const cronModule = await import('node-cron');
    const { sendPendingCallLeadsSummary } = await import('./Controllers/CallLeadsController.js');
    cronModule.default.schedule('0 0 * * *', async () => {
      try {
        await sendPendingCallLeadsSummary();
      } catch (error) {
        console.warn('⚠️ [CallLeads] pending summary failed:', error.message);
      }
    }, { scheduled: true, timezone: 'Asia/Kolkata' });
    console.log('✅ [Server] Call Leads pending summary scheduled (12:00 AM IST)');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to schedule Call Leads pending summary:', error.message);
  }

  // Twilio daily cost report: yesterday's (UTC) spend, per-country split, balance and runway,
  // posted at 00:10 UTC (5:40 AM IST) to the twilio-automated-call Discord channel.
  try {
    const cronModule = await import('node-cron');
    const { sendTwilioDailyCostReport } = await import('./Utils/TwilioDailyCostReport.js');
    cronModule.default.schedule('10 0 * * *', async () => {
      try {
        const r = await sendTwilioDailyCostReport();
        if (r?.skipped) console.log(`ℹ️ [TwilioCost] ${r.skipped} for ${r.day}`);
        else if (!r?.ok) console.warn('⚠️ [TwilioCost] daily report not sent:', r?.error);
      } catch (error) {
        console.warn('⚠️ [TwilioCost] daily report failed:', error.message);
      }
    }, { scheduled: true, timezone: 'UTC' });
    console.log('✅ [Server] Twilio daily cost report scheduled (00:10 UTC)');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to schedule Twilio daily cost report:', error.message);
  }

  // WATI daily cost report: yesterday's (UTC) template-message count and estimated Meta charge,
  // posted at 00:12 UTC to the same Discord channel as the Twilio report.
  try {
    const cronModule = await import('node-cron');
    const { sendWatiDailyCostReport } = await import('./Utils/WatiDailyCostReport.js');
    cronModule.default.schedule('12 0 * * *', async () => {
      try {
        const r = await sendWatiDailyCostReport();
        if (r?.skipped) console.log(`ℹ️ [WatiCost] ${r.skipped} for ${r.day}`);
        else if (!r?.ok) console.warn('⚠️ [WatiCost] daily report not sent:', r?.error);
      } catch (error) {
        console.warn('⚠️ [WatiCost] daily report failed:', error.message);
      }
    }, { scheduled: true, timezone: 'UTC' });
    console.log('✅ [Server] WATI daily cost report scheduled (00:12 UTC)');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to schedule WATI daily cost report:', error.message);
  }

  // One-time backfill: existing CRM users with a view permission get the matching
  // `_edit` permission so behavior does not regress when per-module view/edit ships.
  // Idempotent — only adds missing edit keys.
  try {
    const { CrmUserModel, CRM_MODULE_KEYS_ALLOWED } = await import('./Schema_Models/CrmUser.js');
    const users = await CrmUserModel.find({}).select('_id permissions');
    let updated = 0;
    for (const u of users) {
      const perms = Array.isArray(u.permissions) ? u.permissions : [];
      const additions = [];
      for (const mod of CRM_MODULE_KEYS_ALLOWED) {
        if (perms.includes(mod) && !perms.includes(`${mod}_edit`)) {
          additions.push(`${mod}_edit`);
        }
      }
      if (additions.length > 0) {
        u.permissions = [...perms, ...additions];
        await u.save();
        updated += 1;
      }
    }
    if (updated > 0) {
      console.log(`✅ [Server] Backfilled _edit permissions for ${updated} existing CRM user(s)`);
    }
  } catch (error) {
    console.warn('⚠️ [Server] Failed to backfill CRM edit permissions:', error.message);
  }
});

// Initialize GeoIP after server startup
initGeoIp();

// -------------------- Graceful Shutdown --------------------
const gracefulShutdown = async (signal) => {
  console.log(`\n[Server] ${signal} received. Starting graceful shutdown...`);
  try {
    const { getScheduler } = await import('./Utils/UnifiedScheduler.js');
    const scheduler = getScheduler();
    if (scheduler) {
      console.log('[Server] Stopping unified scheduler...');
      await scheduler.stop();
    }
  } catch {}
  try {
    const mongoose = (await import('mongoose')).default;
    await mongoose.connection.close();
    console.log('[Server] MongoDB connection closed.');
  } catch {}
  process.exit(0);
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// -------------------- Scheduler API Endpoints --------------------
// Unified scheduler health (new)
app.get('/api/scheduler/health', async (req, res) => {
  try {
    const { getScheduler } = await import('./Utils/UnifiedScheduler.js');
    const scheduler = getScheduler();
    if (!scheduler) return res.status(503).json({ success: false, error: 'Scheduler not running' });
    const health = scheduler.getHealth();
    res.status(health.isHealthy ? 200 : 503).json({ success: true, ...health });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Unified scheduler full stats (new)
app.get('/api/scheduler/unified-stats', async (req, res) => {
  try {
    const { getScheduler } = await import('./Utils/UnifiedScheduler.js');
    const scheduler = getScheduler();
    if (!scheduler) return res.status(503).json({ success: false, error: 'Scheduler not running' });
    const stats = await scheduler.getStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get scheduler stats (backward compatible)
app.get('/api/scheduler/stats', async (req, res) => {
  try {
    const stats = await getSchedulerStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get upcoming calls
app.get('/api/scheduler/upcoming', async (req, res) => {
  try {
    const calls = await getUpcomingCalls(20);
    res.json({ success: true, calls });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------- Job Scheduler API Endpoints (Email/WhatsApp) --------------------
// Get job scheduler stats (MongoDB-based, replaces Redis)
app.get('/api/job-scheduler/stats', async (req, res) => {
  try {
    const stats = await getJobSchedulerStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});












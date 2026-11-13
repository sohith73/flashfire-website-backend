import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { DateTime } from 'luxon';
import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import {
  BdaAttendanceEndEventModel,
  END_SOURCES,
} from '../Schema_Models/BdaAttendanceEndEvent.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { DiscordConnect } from '../Utils/DiscordConnect.js';
import { isBookingAssignedTo } from '../Utils/BdaAssignment.js';
import { recordPresentSignal } from '../Utils/recordPresentSignal.js';
import { setOtp, getOtp, decrementAttempts, deleteOtp, getOtpCacheStats } from '../Utils/CrmOtpCache.js';
import { sendBdaOtpEmail } from '../Utils/SendGridHelper.js';

// ==================== Helpers ====================

function formatIST(date) {
  if (!date) return 'N/A';
  return DateTime.fromJSDate(new Date(date))
    .setZone('Asia/Kolkata')
    .toFormat('dd MMM yyyy, hh:mm a');
}

// Present/Join/Leave/Manual → goes to the attendance webhook
async function sendPresentDiscord(message) {
  const url = process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL || null;
  if (!url) {
    console.warn('[BdaAttendance] DISCORD_BDA_ATTENDANCE_WEBHOOK_URL not configured');
    return;
  }
  await DiscordConnect(url, message, false);
}

// Leave/Duration → goes to the duration webhook (+ attendance webhook as fallback)
async function sendDurationDiscord(message) {
  const url = process.env.DISCORD_BDA_DURATION_WEBHOOK_URL || process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL || null;
  if (!url) {
    console.warn('[BdaAttendance] DISCORD_BDA_DURATION_WEBHOOK_URL not configured');
    return;
  }
  await DiscordConnect(url, message, false);
}

// Absent/Error → goes to the error webhook
async function sendAbsentDiscord(message) {
  const url = process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL || null;
  if (!url) {
    console.warn('[BdaAttendance] DISCORD_BDA_ABSENT_WEBHOOK_URL not configured');
    return;
  }
  await DiscordConnect(url, message, false);
}

/**
 * Move a client-clock timestamp onto the server clock. The extension stamps
 * each request with `clientNow` (its own Date.now() at send time); the gap to
 * the server's now is the client's clock skew. Joins/leaves are measured on the
 * BDA's machine, so without this a PC running 2 minutes fast recorded every
 * join 2 minutes early. Returns the original value when no usable clientNow is
 * sent (older builds) or the skew is negligible / implausible.
 */
const MIN_SKEW_MS = 5 * 1000;
const MAX_SKEW_MS = 24 * 60 * 60 * 1000;
function toServerClock(value, clientNow) {
  if (value == null || value === '') return value;
  const t = new Date(value).getTime();
  const c = new Date(clientNow).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(c)) return value;
  const skew = Date.now() - c;
  if (Math.abs(skew) < MIN_SKEW_MS || Math.abs(skew) > MAX_SKEW_MS) return value;
  return new Date(t + skew).toISOString();
}

// Simple in-memory rate limiter
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 10;

function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// Cleanup rate limit map every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(key);
    }
  }
}, 10 * 60 * 1000).unref(); // unref: a cleanup timer must not keep a script or a test process alive on its own

// SSE connections map: bdaEmail -> Set<res>
const sseConnections = new Map();

export function notifyBdaSSE(bdaEmail, event, data) {
  const connections = sseConnections.get(bdaEmail);
  if (!connections || connections.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of connections) {
    try {
      res.write(payload);
      if (typeof res.flush === 'function') res.flush();
    } catch (err) {
      connections.delete(res);
    }
  }
}

// ==================== POST /api/bda-attendance/register ====================

// ==================== OTP Helpers ====================

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const OTP_CACHE_PREFIX = 'bda_attendance:';

function otpCacheKey(email) {
  return `${OTP_CACHE_PREFIX}${normalizeEmail(email)}`;
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000)); // 6 digits
}

function bdaOtpHash(email, otp) {
  const secret = process.env.CRM_OTP_HASH_SECRET || getCrmJwtSecret();
  const value = `${otpCacheKey(email)}|${String(otp).trim()}|${secret}`;
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** CRM profile name, else email local-part, else email */
function bdaDisplayNameFromUser(user) {
  const email = normalizeEmail(user?.email);
  const rawName = user?.name != null ? String(user.name).trim() : '';
  if (rawName) return rawName;
  if (!email) return '';
  const local = email.split('@')[0];
  return local || email;
}

function assertBookingClaimedBy(booking, bdaEmail) {
  const claimed = booking?.claimedBy?.email;
  return claimed && normalizeEmail(claimed) === normalizeEmail(bdaEmail);
}

// ==================== Meet link + session close helpers (join/leave/end) ====================

function extractMeetCodeFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  if (m) return m[1].toLowerCase();
  const m2 = url.match(/meet\.google\.com\/([a-zA-Z0-9_-]+)/);
  if (!m2) return null;
  const seg = m2[1].toLowerCase();
  // Not a real room — would false-match bookings or imply "joined" incorrectly
  if (seg === 'landing' || seg === 'new' || seg === 'about' || seg === 'getting-started') {
    return null;
  }
  return seg;
}

/** Lobby / home URL — not an actual Google Meet room */
function isGoogleMeetLandingUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const s = url.trim().toLowerCase();
  if (!s.includes('meet.google.com')) return false;
  return /meet\.google\.com\/landing(\/|\?|#|$)/i.test(s);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find best-matching booking for a Meet URL (time window around now). */
async function findBookingByMeetLink(meetLink) {
  const code = extractMeetCodeFromUrl(meetLink);
  if (!code) return { bookingId: null, booking: null, candidates: 0 };

  const from = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const codeRe = escapeRegex(code);

  const bookings = await CampaignBookingModel.find({
    scheduledEventStartTime: { $gte: from, $lte: to },
    $or: [
      { googleMeetCode: new RegExp(`^${codeRe}$`, 'i') },
      { googleMeetUrl: { $regex: codeRe, $options: 'i' } },
      { calendlyMeetLink: { $regex: codeRe, $options: 'i' } },
    ],
  })
    .lean();

  if (!bookings.length) return { bookingId: null, booking: null, candidates: 0 };

  const now = Date.now();
  const scored = bookings.map((b) => ({
    b,
    d: Math.abs(new Date(b.scheduledEventStartTime).getTime() - now),
  }));
  scored.sort((a, b) => a.d - b.d);
  return {
    bookingId: scored[0].b.bookingId,
    booking: scored[0].b,
    candidates: bookings.length,
  };
}

function meetLinksRoughMatch(booking, meetLink) {
  const c1 = extractMeetCodeFromUrl(meetLink);
  if (!c1 || !booking) return { mismatch: false };

  const parts = [
    booking.googleMeetCode,
    extractMeetCodeFromUrl(booking.googleMeetUrl || ''),
    extractMeetCodeFromUrl(booking.calendlyMeetLink || ''),
  ]
    .filter(Boolean)
    .map((c) => String(c).toLowerCase());

  if (parts.length === 0) return { mismatch: false };
  const mismatch = !parts.some((c) => c === c1);
  return { mismatch };
}

/**
 * Close an open in-meet session (joinedAt set, leftAt cleared).
 * @returns {{ closed: boolean, attendance: object|null, leaveTime: Date|null, durationMs: number|null }}
 */
/** Hard ceiling on a single in-meet segment (guards corrupt joinedAt / clock skew). */
const MAX_SEGMENT_MS = 6 * 60 * 60 * 1000; // 6 hours

async function closeBdaAttendanceSession({
  bookingId,
  bdaEmail,
  bdaName,
  leftAt,
  clientDurationMs = null,
  sendDurationNotification = true,
}) {
  const attendance = await BdaAttendanceModel.findOne({ bookingId, bdaEmail });

  if (!attendance) {
    notifyBdaSSE(bdaEmail, 'attendance_update', { bookingId });
    return { closed: false, attendance: null, leaveTime: null, durationMs: null };
  }

  if (!attendance.joinedAt) {
    notifyBdaSSE(bdaEmail, 'attendance_update', { bookingId });
    return {
      closed: false,
      noOpenSession: true,
      attendance,
      leaveTime: attendance.leftAt ? new Date(attendance.leftAt) : null,
      durationMs: attendance.durationMs ?? null,
    };
  }

  const leaveTime = leftAt ? new Date(leftAt) : new Date();
  const serverSegmentMs = Math.max(
    0,
    leaveTime.getTime() - new Date(attendance.joinedAt).getTime()
  );
  // Prefer the client-measured duration when present and sane: it is a single-clock
  // delta (join→leave on the same machine), so it is immune to client/server clock
  // skew and to a stale joinedAt. Fall back to the server compute otherwise.
  const cd = Number(clientDurationMs);
  let segmentMs;
  if (Number.isFinite(cd) && cd >= 0 && cd <= MAX_SEGMENT_MS) {
    segmentMs = cd;
  } else {
    segmentMs = Math.min(serverSegmentMs, MAX_SEGMENT_MS);
  }
  attendance.cumulativeDurationMs = (attendance.cumulativeDurationMs || 0) + segmentMs;
  attendance.durationMs = attendance.cumulativeDurationMs;
  attendance.leftAt = leaveTime;
  attendance.joinedAt = null;
  await attendance.save();

  if (sendDurationNotification) {
    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    const durationMin = Math.round(attendance.cumulativeDurationMs / 60000);
    const message =
      `🚪 **BDA Left Meeting**\n` +
      `**BDA:** ${bdaName} (${bdaEmail})\n` +
      `**Client:** ${booking?.clientName || 'Unknown'}\n` +
      `**Duration (total):** ${durationMin} min\n` +
      `**Left At:** ${formatIST(leaveTime)}\n` +
      `_Source: extension (live detection) — final times verified from Google Meet records after the meeting_`;

    // Not awaited: the leave is already saved, and a slow or retrying Discord call must not delay the response
    // (the extension closes its session on it) or the SSE update below. Failures are logged, never swallowed.
    sendDurationDiscord(message).catch((e) => console.error('[BdaAttendance] leave alert failed:', e?.message || e));
  }

  const durationMin = Math.round(attendance.cumulativeDurationMs / 60000);
  notifyBdaSSE(bdaEmail, 'attendance_update', {
    bookingId,
    status: attendance.status,
    leftAt: leaveTime,
    durationMin,
    durationMs: attendance.durationMs,
  });

  return {
    closed: true,
    attendance,
    leaveTime,
    durationMs: attendance.durationMs,
  };
}

async function persistEndEventAndMetadata({
  emailNorm,
  name,
  bookingId,
  meetLink,
  meetCode,
  endedAt,
  endSource,
  requestId,
  joinedAtSnapshot,
  durationMsSnapshot,
  linkMismatch,
  unresolvedBooking,
  sessionClosed,
  durationMsAfterClose,
}) {
  try {
    await BdaAttendanceEndEventModel.create({
      bdaEmail: emailNorm,
      bdaName: name || emailNorm,
      bookingId: bookingId || null,
      meetLink: meetLink || null,
      meetCode: meetCode || null,
      joinedAtSnapshot: joinedAtSnapshot ? new Date(joinedAtSnapshot) : null,
      endedAt,
      endSource,
      durationMsSnapshot:
        durationMsSnapshot != null && !Number.isNaN(Number(durationMsSnapshot))
          ? Number(durationMsSnapshot)
          : null,
      durationMsAfterClose:
        durationMsAfterClose != null ? Number(durationMsAfterClose) : null,
      requestId,
      linkMismatch: Boolean(linkMismatch),
      unresolvedBooking: Boolean(unresolvedBooking),
      sessionClosed: Boolean(sessionClosed),
    });
  } catch (err) {
    if (err.code === 11000) {
      return { stored: true, deduped: true };
    }
    throw err;
  }

  if (bookingId) {
    await BdaAttendanceModel.updateOne(
      { bookingId, bdaEmail: emailNorm },
      {
        $set: {
          lastEndSource: endSource,
          lastEndedAt: endedAt,
          lastEndMeetLink: meetLink || null,
        },
      }
    );
  }

  return { stored: true, deduped: false };
}

async function processReportEndEventCore({
  emailNorm,
  name,
  bookingId: bodyBookingId,
  meetLink,
  leftAt,
  endSource,
  requestId,
  joinedAtSnapshot,
  durationMsSnapshot,
}) {
  if (!requestId || typeof requestId !== 'string') {
    return { ok: false, status: 400, body: { success: false, error: 'requestId is required' } };
  }

  if (!END_SOURCES.includes(endSource)) {
    return {
      ok: false,
      status: 400,
      body: { success: false, error: 'Invalid endSource' },
    };
  }

  if (meetLink && !meetLink.includes('meet.google.com')) {
    return {
      ok: false,
      status: 400,
      body: { success: false, error: 'Invalid meet link' },
    };
  }

  const existing = await BdaAttendanceEndEventModel.findOne({
    bdaEmail: emailNorm,
    requestId,
  }).lean();

  if (existing) {
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        deduped: true,
        sessionClosed: existing.sessionClosed,
        eventStored: true,
      },
    };
  }

  let bookingId = bodyBookingId || null;
  let booking = null;
  let unresolvedBooking = false;

  if (bookingId) {
    booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    if (!booking) {
      return {
        ok: false,
        status: 404,
        body: { success: false, error: 'Booking not found' },
      };
    }
  } else if (meetLink) {
    const found = await findBookingByMeetLink(meetLink);
    if (found.bookingId) {
      bookingId = found.bookingId;
      booking = found.booking;
    } else {
      unresolvedBooking = true;
    }
  } else {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: 'bookingId or meetLink is required',
      },
    };
  }

  let linkMismatch = false;
  if (booking && meetLink) {
    linkMismatch = meetLinksRoughMatch(booking, meetLink).mismatch;
  }

  const endedAt = leftAt ? new Date(leftAt) : new Date();
  const meetCode = extractMeetCodeFromUrl(meetLink) || null;

  let sessionClosed = false;
  let durationMsAfterClose = null;

  if (bookingId) {
    const closeResult = await closeBdaAttendanceSession({
      bookingId,
      bdaEmail: emailNorm,
      bdaName: name,
      leftAt: endedAt,
      clientDurationMs: durationMsSnapshot,
      sendDurationNotification: true,
    });
    sessionClosed =
      closeResult.closed ||
      Boolean(closeResult.noOpenSession && closeResult.durationMs != null);
    durationMsAfterClose = closeResult.durationMs;
  }

  await persistEndEventAndMetadata({
    emailNorm,
    name,
    bookingId,
    meetLink,
    meetCode,
    endedAt,
    endSource,
    requestId,
    joinedAtSnapshot,
    durationMsSnapshot,
    linkMismatch,
    unresolvedBooking,
    sessionClosed,
    durationMsAfterClose,
  });

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      deduped: false,
      sessionClosed,
      eventStored: true,
      bookingId: bookingId || null,
      unresolvedBooking,
      linkMismatch,
      durationMs: durationMsAfterClose,
    },
  };
}

// ==================== POST /api/bda-attendance/request-otp ====================

export async function requestBdaOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }

    // Rate limit by IP
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkRateLimit(`bda-otp:${ip}`)) {
      return res.status(429).json({ success: false, error: 'Too many attempts. Try again later.' });
    }

    // Check if user exists and is explicitly deactivated
    const user = await CrmUserModel.findOne({ email }).lean();
    if (user && user.isActive === false) {
      return res.status(200).json({
        success: true,
        message: 'If your email is authorized, you will receive an OTP.',
      });
    }

    // Generate and send OTP (even if user doesn't exist yet — will auto-create on verify)
    const otp = generateOtp();
    console.log(`[BDA OTP] ${email} -> ${otp}`);

    const ttlSeconds = Number(process.env.CRM_OTP_TTL_SECONDS || 300);
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    setOtp(otpCacheKey(email), { otpHash: bdaOtpHash(email, otp), expiresAtMs, attemptsLeft: 5 });

    const displayName = user ? bdaDisplayNameFromUser(user) : email.split('@')[0];
    await sendBdaOtpEmail(email, otp, displayName);

    return res.status(200).json({
      success: true,
      message: 'OTP sent',
      cache: getOtpCacheStats(),
    });
  } catch (error) {
    console.error('[BdaAttendance] requestBdaOtp error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ==================== POST /api/bda-attendance/verify-otp ====================

export async function verifyBdaOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ success: false, error: 'Invalid OTP format. Enter 6 digits.' });
    }

    const key = otpCacheKey(email);
    const entry = getOtp(key);
    if (!entry) {
      return res.status(401).json({ success: false, error: 'OTP expired or not found. Request a new one.' });
    }

    const incomingHash = bdaOtpHash(email, otp);
    const ok = crypto.timingSafeEqual(Buffer.from(incomingHash), Buffer.from(entry.otpHash));
    if (!ok) {
      const remaining = decrementAttempts(key);
      const attemptsLeft = remaining?.attemptsLeft || 0;
      return res.status(401).json({
        success: false,
        error: attemptsLeft > 0
          ? `Invalid OTP. ${attemptsLeft} attempt${attemptsLeft > 1 ? 's' : ''} remaining.`
          : 'Too many failed attempts. Request a new OTP.',
      });
    }

    // OTP valid - delete it
    deleteOtp(key);

    // Find or auto-create CrmUser
    let user = await CrmUserModel.findOne({ email }).lean();

    if (user && user.isActive === false) {
      return res.status(403).json({ success: false, error: 'User not authorized' });
    }

    let isNewUser = false;
    if (!user) {
      // Auto-create CrmUser with placeholder name
      const placeholderName = email.split('@')[0];
      const created = await CrmUserModel.create({
        email,
        name: placeholderName,
        permissions: [],
        isActive: true,
      });
      user = created.toObject();
      isNewUser = true;
      console.log(`[BdaAttendance] Auto-created CrmUser for ${email}`);
    }

    const displayName = bdaDisplayNameFromUser(user);

    // Check if name needs to be set (placeholder or empty)
    const emailLocalPart = email.split('@')[0];
    const needsName = isNewUser || !user.name || user.name === emailLocalPart;

    // Issue 30-day JWT for BDA extension
    const token = jwt.sign(
      {
        role: 'bda_extension',
        email: user.email,
        name: displayName,
      },
      getCrmJwtSecret(),
      { expiresIn: '30d' }
    );

    return res.status(200).json({
      success: true,
      token,
      expiresIn: '30d',
      bda: { name: displayName, email: user.email },
      needsName,
    });
  } catch (error) {
    console.error('[BdaAttendance] verifyBdaOtp error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ==================== POST /api/bda-attendance/update-name ====================

export async function updateBdaName(req, res) {
  try {
    const { email } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const name = String(req.body?.name || '').trim();

    if (!name || name.length < 2 || name.length > 100) {
      return res.status(400).json({ success: false, error: 'Name must be 2-100 characters' });
    }

    const user = await CrmUserModel.findOneAndUpdate(
      { email: emailNorm },
      { $set: { name } },
      { new: true }
    ).lean();

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Issue a new JWT with the updated name
    const newToken = jwt.sign(
      { role: 'bda_extension', email: user.email, name },
      getCrmJwtSecret(),
      { expiresIn: '30d' }
    );

    return res.status(200).json({
      success: true,
      token: newToken,
      bda: { name, email: user.email },
    });
  } catch (error) {
    console.error('[BdaAttendance] updateBdaName error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ==================== POST /api/bda-attendance/create-test-meeting ====================

export async function createTestMeeting(req, res) {
  try {
    const { clientName, startTime, durationMinutes, bdaEmail, bdaName, googleMeetUrl } = req.body;

    if (!clientName) {
      return res.status(400).json({ success: false, error: 'clientName is required' });
    }

    const start = startTime ? new Date(startTime) : new Date(Date.now() + 5 * 60 * 1000); // default: 5 min from now
    const durMin = durationMinutes || 30;
    const end = new Date(start.getTime() + durMin * 60 * 1000);

    const booking = await CampaignBookingModel.create({
      bookingId: `test_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      utmSource: 'test',
      clientName,
      clientEmail: `${clientName.toLowerCase().replace(/\s+/g, '.')}@test.com`,
      bookingStatus: 'scheduled',
      scheduledEventStartTime: start,
      scheduledEventEndTime: end,
      googleMeetUrl: googleMeetUrl || '',
      googleMeetCode: '',
      claimedBy: {
        email: normalizeEmail(bdaEmail || 'test@flashfirehq.com'),
        name: bdaName || 'Test BDA',
        claimedAt: new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      booking: {
        bookingId: booking.bookingId,
        clientName: booking.clientName,
        start: start.toISOString(),
        end: end.toISOString(),
        bdaEmail: booking.claimedBy.email,
      },
    });
  } catch (error) {
    console.error('[BdaAttendance] createTestMeeting error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ==================== GET /api/bda-attendance/my-meetings ====================

export async function getMyMeetings(req, res) {
  try {
    const { email } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const now = new Date();
    const horizonPast = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const horizonFuture = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // List every scheduled meeting so a covering join can be matched by meet code, but with client details only
    // on the requesting BDA's own meetings (see the dto below).
    //
    // Two queries on purpose. This used to be ONE query over [now - 7 d, now + 14 d] sorted oldest first with
    // .limit(100). Once the past week alone held 100 bookings, the limit was spent on past meetings and every
    // upcoming meeting was cut off, so BDAs saw an empty "Upcoming Meetings" list even though they were logged in.
    // Each side now has its own limit: soonest 100 upcoming, newest 100 past.
    const selectFields =
      'bookingId clientName clientEmail scheduledEventStartTime scheduledEventEndTime googleMeetUrl googleMeetCode calendlyMeetLink claimedBy calendlyHost attendanceAssignee';
    const statusFilter = { $in: ['paid', 'scheduled', 'completed'] };
    const [upcomingBookings, pastBookings] = await Promise.all([
      CampaignBookingModel.find({
        bookingStatus: statusFilter,
        scheduledEventStartTime: { $gte: now, $lte: horizonFuture },
      })
        .sort({ scheduledEventStartTime: 1 })
        .select(selectFields)
        .limit(100)
        .lean(),
      CampaignBookingModel.find({
        bookingStatus: statusFilter,
        scheduledEventStartTime: { $gte: horizonPast, $lt: now },
      })
        .sort({ scheduledEventStartTime: -1 })
        .select(selectFields)
        .limit(100)
        .lean(),
    ]);
    const bookings = [...upcomingBookings, ...pastBookings];

    // Backfill missing meet codes (Calendly bookings only carry a redirect
    // URL). Fire-and-forget, capped — the extension polls this endpoint, so
    // codes appear within a refresh cycle without slowing this response.
    // Live join detection needs the code to match the Meet tab to the booking.
    const missingCode = bookings.filter((b) => !b.googleMeetCode && b.calendlyMeetLink).slice(0, 10);
    if (missingCode.length > 0) {
      import('../Utils/MeetAttendanceScheduler.js')
        .then(({ resolveBookingMeetCode }) =>
          Promise.allSettled(missingCode.map((b) => resolveBookingMeetCode(b)))
        )
        .catch(() => {});
    }

    const ids = bookings.map((b) => b.bookingId);
    // Only the requesting BDA's own rows. The extension and panel treat
    // `attendance` as "has MY attendance been recorded": returning another BDA's
    // row (e.g. a colleague's absent mark) made the extension stop tracking the
    // meeting, so the assigned BDA's real join was never recorded.
    // 'unmarked' rows are server alert artifacts (no response yet), not a
    // recorded attendance, so they must not block auto-join or Mark Present.
    const attendanceRecords = await BdaAttendanceModel.find({
      bookingId: { $in: ids },
      bdaEmail: emailNorm,
      status: { $ne: 'unmarked' },
    }).lean();

    const attendanceByBooking = Object.fromEntries(
      attendanceRecords.map((a) => [
        a.bookingId,
        {
          status: a.status,
          source: a.source,
          bdaName: a.bdaName || null,
          bdaEmail: a.bdaEmail || null,
          // In time survives session close via firstJoinedAt; fall back for old rows.
          joinedAt: a.firstJoinedAt || a.joinedAt || a.markedAt || null,
          // When the BDA's counted present signal reached the server (button or auto-detect). Null when none did in time.
          markedPresentAt: a.markedPresentAt || null,
          leftAt: a.leftAt || null,
          // Null while in-progress (no completed segment yet) so the UI shows "—"
          // instead of a misleading "0 min"; cumulative default 0 must not surface.
          durationMs: a.durationMs ?? (a.cumulativeDurationMs > 0 ? a.cumulativeDurationMs : null),
          // ---- Meet REST API fields (present when source === 'meet_api') ----
          lateByMs: a.lateByMs ?? null,
          sessions: Array.isArray(a.sessions) ? a.sessions : [],
          participantsAtJoin: Array.isArray(a.participantsAtJoin) ? a.participantsAtJoin : [],
          meetApiFinalized: Boolean(a.meetApiFinalizedAt),
        },
      ])
    );

    const upcoming = [];
    const previous = [];

    for (const b of bookings) {
      const start = b.scheduledEventStartTime ? new Date(b.scheduledEventStartTime) : null;
      const mine = isBookingAssignedTo(b, emailNorm);
      // Role control: a BDA gets full details only for their own meetings. A colleague's meeting keeps just what
      // the extension needs to record a covering join (id, time, meet code, who it belongs to), never the client's
      // name or email. Same keys either way, so the response shape does not change.
      const dto = {
        bookingId: b.bookingId,
        clientName: mine ? b.clientName : "Colleague's meeting",
        clientEmail: mine ? b.clientEmail : null,
        scheduledStart: b.scheduledEventStartTime,
        scheduledEnd: b.scheduledEventEndTime,
        googleMeetUrl: b.googleMeetUrl,
        googleMeetCode: b.googleMeetCode,
        calendlyMeetLink: b.calendlyMeetLink,
        claimedBy: b.claimedBy ? { name: b.claimedBy.name, email: b.claimedBy.email } : null,
        // Calendly round-robin host — the BDA this meeting is assigned to.
        calendlyHost: b.calendlyHost && (b.calendlyHost.name || b.calendlyHost.email)
          ? { name: b.calendlyHost.name, email: b.calendlyHost.email }
          : null,
        assignedToMe: mine,
        attendance: attendanceByBooking[b.bookingId] || null,
      };
      if (start && start >= now) {
        upcoming.push(dto);
      } else {
        previous.push(dto);
      }
    }

    previous.sort((a, b) => new Date(b.scheduledStart) - new Date(a.scheduledStart));

    // Oldest extension version still allowed to run. Unset means no gate, so the key is left out entirely.
    const minExtensionVersion = String(process.env.MIN_EXTENSION_VERSION || '').trim();

    return res.status(200).json({
      success: true,
      upcoming,
      previous,
      serverTime: now.toISOString(),
      ...(minExtensionVersion ? { minExtensionVersion } : {}),
    });
  } catch (error) {
    console.error('[BdaAttendance] getMyMeetings error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/report-join ====================

export async function reportJoin(req, res) {
  try {
    const { email, name } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const { bookingId, meetLink, clientNow } = req.body;
    const joinedAt = toServerClock(req.body.joinedAt, clientNow);

    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'bookingId is required' });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    // Any BDA can report for any meeting (claimedBy check removed)

    if (meetLink && !meetLink.includes('meet.google.com')) {
      return res.status(400).json({ success: false, error: 'Invalid meet link' });
    }

    if (meetLink && isGoogleMeetLandingUrl(meetLink)) {
      const notes = `Google Meet landing page (not a real meeting room). URL: ${String(meetLink).slice(0, 240)}`;
      const prev = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: emailNorm });

      // Bad join URL — record as "unmarked", not "absent". The BDA tried to
      // join; only an explicit mark-absent action may set status: 'absent'.
      const attendance = await BdaAttendanceModel.findOneAndUpdate(
        { bookingId, bdaEmail: emailNorm },
        {
          $set: {
            bdaName: name,
            bdaEmail: emailNorm,
            bookingId,
            status: 'unmarked',
            source: 'manual',
            markedAt: new Date(),
            joinedAt: null,
            leftAt: null,
            meetLink,
            meetingScheduledStart: booking.scheduledEventStartTime,
            meetingScheduledEnd: booking.scheduledEventEndTime || null,
            notes,
            cumulativeDurationMs: 0,
            durationMs: null,
          },
          $setOnInsert: {
            attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          },
        },
        { upsert: true, new: true }
      );

      const wasAlreadyRecorded = prev?.status === 'unmarked' || prev?.status === 'absent';
      if (!wasAlreadyRecorded) {
        const warnMsg =
          `⚠️ **BDA No Response (Unmarked)** — Meet landing URL\n` +
          `**BDA:** ${name} (${emailNorm})\n` +
          `**Client:** ${booking.clientName}\n` +
          `**Meeting:** ${formatIST(booking.scheduledEventStartTime)}\n` +
          `_Join attempted from meet.google.com/landing — not a real Meet room. NOT marked absent._`;
        await sendAbsentDiscord(warnMsg);
        await BdaAttendanceModel.updateOne({ _id: attendance._id }, { discordNotified: true });
      }

      notifyBdaSSE(emailNorm, 'attendance_update', {
        bookingId,
        status: 'unmarked',
        source: 'manual',
      });

      return res.status(200).json({
        success: true,
        markedAbsent: false,
        status: 'unmarked',
        attendanceId: attendance.attendanceId,
        message: 'Meet landing URL does not count as joined; recorded as unmarked.',
      });
    }

    const joinDate = joinedAt ? new Date(joinedAt) : new Date();
    let doc = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: emailNorm });
    let notifyJoin = false;
    // A closed earlier segment means this is the BDA coming back into the call.
    const isRejoin = Boolean(doc && (doc.cumulativeDurationMs > 0 || (doc.firstJoinedAt && doc.leftAt)));

    if (!doc) {
      notifyJoin = true;
      doc = new BdaAttendanceModel({
        attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        bdaName: name,
        bdaEmail: emailNorm,
        bookingId,
        meetLink: meetLink || null,
        joinedAt: joinDate,
        firstJoinedAt: joinDate,
        leftAt: null,
        status: 'present',
        source: 'auto',
        markedAt: new Date(),
        meetingScheduledStart: booking.scheduledEventStartTime,
        meetingScheduledEnd: booking.scheduledEventEndTime || null,
      });
    } else {
      const openSession = Boolean(doc.joinedAt && !doc.leftAt);
      if (!openSession) {
        doc.joinedAt = joinDate;
        doc.leftAt = null;
        notifyJoin = true;
      }
      if (!doc.firstJoinedAt) doc.firstJoinedAt = joinDate;
      doc.bdaName = name;
      doc.bdaEmail = emailNorm;
      doc.meetLink = meetLink || doc.meetLink;
      doc.status = 'present';
      doc.source = 'auto';
      doc.markedAt = new Date();
      doc.meetingScheduledStart = booking.scheduledEventStartTime;
      doc.meetingScheduledEnd = booking.scheduledEventEndTime || null;
    }

    await doc.save();

    // The absent-poller keys its row on 'unassigned', so a real join creates a
    // separate document and leaves a phantom "unmarked" row behind. A recorded
    // join supersedes it — otherwise the CRM shows a false absence for a BDA who
    // was actually in the meeting.
    // Rows that carry a verdict, a signal or a heartbeat-warning mark are real attendance data, never phantoms.
    const supersededPhantom = await BdaAttendanceModel.deleteMany({
      bookingId,
      source: 'scheduler',
      status: 'unmarked',
      bdaEmail: { $ne: emailNorm },
      verdict: null,
      heartbeatWarnedAt: null,
      'signals.0': { $exists: false },
    });
    if (supersededPhantom.deletedCount) {
      console.log(
        `[BdaAttendance] Superseded ${supersededPhantom.deletedCount} phantom "unmarked" row(s) for ${bookingId} after real join by ${emailNorm}`
      );
    }

    // The extension saw the BDA in the call: store it as an extension_join signal with the real (server-corrected)
    // join time. The server decides present or absent from signals; this never fails the join report itself.
    try {
      await recordPresentSignal({
        bookingId,
        bdaEmail: emailNorm,
        bdaName: name,
        kind: 'extension_join',
        eventAt: joinDate,
      });
    } catch (signalError) {
      console.error('[BdaAttendance] could not record extension_join signal:', signalError?.message || signalError);
    }

    if (notifyJoin) {
      // On time / early / late against the scheduled start (the Mark Present window closes 1 min after it).
      const deltaMin = Math.round((joinDate.getTime() - new Date(booking.scheduledEventStartTime).getTime()) / 60000);
      const punctuality = isRejoin ? '' : deltaMin > 1 ? ` (${deltaMin} min late)` : deltaMin < -1 ? ` (${-deltaMin} min early)` : ' (on time)';
      // The room link without ?authuser=0 and other per-person query noise.
      const cleanLink = meetLink ? String(meetLink).split(/[?#]/)[0] : null;
      const message =
        (isRejoin ? `🔁 **BDA Rejoined Meeting**\n` : `✅ **BDA Joined Meeting**\n`) +
        `**BDA:** ${name} (${emailNorm})\n` +
        `**Client:** ${booking.clientName}\n` +
        `**Meeting:** ${formatIST(booking.scheduledEventStartTime)}\n` +
        `**Joined At:** ${formatIST(joinDate)}${punctuality}\n` +
        `**Device:** 💻 PC (attendance extension)\n` +
        `**Meet Link:** ${cleanLink || 'N/A'}\n` +
        `_Live detection from the extension. Google Meet records confirm the final times after the meeting._`;

      // Not awaited: the join is already saved. Discord (with its retries) must not hold up the extension's
      // response, so the alert goes out the instant the join is detected and the API answers immediately.
      sendPresentDiscord(message).catch((e) => console.error('[BdaAttendance] join alert failed:', e?.message || e));
      await BdaAttendanceModel.updateOne({ _id: doc._id }, { discordNotified: true });
    }

    notifyBdaSSE(emailNorm, 'attendance_update', {
      bookingId,
      status: 'present',
      source: 'auto',
      joinedAt: doc.joinedAt,
    });

    return res.status(200).json({
      success: true,
      attendanceId: doc.attendanceId,
    });
  } catch (error) {
    console.error('[BdaAttendance] reportJoin error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/report-leave ====================

export async function reportLeave(req, res) {
  try {
    const { email, name } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const { bookingId, durationMs, clientNow } = req.body;
    const leftAt = toServerClock(req.body.leftAt, clientNow);

    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'bookingId is required' });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    const result = await closeBdaAttendanceSession({
      bookingId,
      bdaEmail: emailNorm,
      bdaName: name,
      leftAt,
      clientDurationMs: durationMs,
      sendDurationNotification: true,
    });

    return res.status(200).json({ success: true, durationMs: result.durationMs });
  } catch (error) {
    console.error('[BdaAttendance] reportLeave error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/report-end-event ====================

export async function reportEndEvent(req, res) {
  try {
    const { email, name } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const {
      bookingId,
      meetLink,
      endSource,
      requestId,
      durationMsSnapshot,
      clientNow,
    } = req.body;
    const leftAt = toServerClock(req.body.leftAt, clientNow);
    const joinedAtSnapshot = toServerClock(req.body.joinedAtSnapshot, clientNow);

    const out = await processReportEndEventCore({
      emailNorm,
      name,
      bookingId,
      meetLink,
      leftAt,
      endSource,
      requestId,
      joinedAtSnapshot,
      durationMsSnapshot,
    });

    if (!out.ok) {
      return res.status(out.status).json(out.body);
    }
    return res.status(200).json(out.body);
  } catch (error) {
    console.error('[BdaAttendance] reportEndEvent error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/manual-mark ====================

export async function manualMark(req, res) {
  try {
    const { email, name } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const { bookingId, meetLink } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'bookingId is required' });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    // Any BDA can report for any meeting (claimedBy check removed)

    if (meetLink && isGoogleMeetLandingUrl(meetLink)) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark present from the Google Meet landing page. Open the real meeting link first.',
      });
    }

    const now = new Date();
    const meetStart = new Date(booking.scheduledEventStartTime);

    // Strict: only after meeting start time
    if (now < meetStart) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark attendance before meeting start time',
      });
    }

    // Strict: within 2 hours of meeting start
    const twoHoursAfter = new Date(meetStart.getTime() + 2 * 60 * 60 * 1000);
    if (now > twoHoursAfter) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark attendance more than 2 hours after meeting start',
      });
    }

    // Check if already present via auto
    const existing = await BdaAttendanceModel.findOne({
      bookingId,
      bdaEmail: emailNorm,
      status: 'present',
      source: 'auto',
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Attendance already recorded automatically',
      });
    }

    // Upsert
    const attendance = await BdaAttendanceModel.findOneAndUpdate(
      { bookingId, bdaEmail: emailNorm },
      {
        $set: {
          bdaName: name,
          bdaEmail: emailNorm,
          bookingId,
          status: 'manual',
          source: 'manual',
          markedAt: now,
          meetLink: meetLink || booking.googleMeetUrl || null,
          meetingScheduledStart: booking.scheduledEventStartTime,
          meetingScheduledEnd: booking.scheduledEventEndTime || null,
        },
        $setOnInsert: {
          attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        },
      },
      { upsert: true, new: true }
    );

    // Extensions older than v2 still mark present through this endpoint. Record it as a present signal too, so a mark
    // made inside the window counts for the server's verdict. The window and assignment rules live in
    // recordPresentSignal; a mark outside them is simply not counted (this endpoint still saves its own row).
    try {
      await recordPresentSignal({ bookingId, bdaEmail: emailNorm, bdaName: name, kind: 'button_meet' });
    } catch (signalError) {
      console.error('[BdaAttendance] could not record legacy manual mark as a signal:', signalError?.message || signalError);
    }

    // Discord notification
    const resolvedMeetLink = meetLink || booking.googleMeetUrl || 'N/A';
    const message =
      `✋ **BDA Manual Attendance**\n` +
      `**BDA:** ${name} (${emailNorm})\n` +
      `**Client:** ${booking.clientName}\n` +
      `**Meeting:** ${formatIST(booking.scheduledEventStartTime)}\n` +
      `**Meet Link:** ${resolvedMeetLink}\n` +
      `_Note: Auto-detection did not trigger; BDA manually confirmed attendance._`;

    // Not awaited, like the join alert: the mark is saved, Discord must not delay the response.
    sendPresentDiscord(message).catch((e) => console.error('[BdaAttendance] manual mark alert failed:', e?.message || e));
    await BdaAttendanceModel.updateOne(
      { _id: attendance._id },
      { discordNotified: true }
    );

    // Notify SSE
    notifyBdaSSE(emailNorm, 'attendance_update', {
      bookingId,
      status: 'manual',
      source: 'manual',
      markedAt: now,
    });

    return res.status(200).json({
      success: true,
      attendanceId: attendance.attendanceId,
    });
  } catch (error) {
    console.error('[BdaAttendance] manualMark error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/mark-absent and /warn-absent ====================
// Retired (plan 4.4.5 and 5.4). The server decides absence from signals now, in the verdict job, so a client can
// no longer mark anyone absent or fire a warning. Extensions older than v2.0.0 still call these endpoints; answer
// with a clean skip so they stop retrying, and write nothing.

const SERVER_DECIDES = { success: true, skipped: true, reason: 'server_decides' };

export async function markAbsent(_req, res) {
  return res.status(200).json(SERVER_DECIDES);
}

export async function warnAbsent(_req, res) {
  return res.status(200).json(SERVER_DECIDES);
}

// ==================== GET /api/bda-attendance/sse ====================

export async function sseConnection(req, res) {
  try {
    const token = req.query.token;
    if (!token) {
      return res.status(401).json({ success: false, error: 'Token required' });
    }

    let payload;
    try {
      payload = jwt.verify(token, getCrmJwtSecret());
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    if (payload?.role !== 'bda_extension') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const email = payload.email;

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Initial keepalive to confirm connection (some clients need an initial push).
    // res.flush() forces bytes past any lingering buffer (belt-and-suspenders now
    // that compression is disabled for this route).
    res.write(':ok\n\n');
    if (typeof res.flush === 'function') res.flush();

    // Register connection
    if (!sseConnections.has(email)) {
      sseConnections.set(email, new Set());
    }
    sseConnections.get(email).add(res);

    // Send connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ email, serverTime: new Date().toISOString() })}\n\n`);
    if (typeof res.flush === 'function') res.flush();

    // Heartbeat every 30s
    const heartbeatInterval = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ serverTime: new Date().toISOString() })}\n\n`);
        if (typeof res.flush === 'function') res.flush();
      } catch (err) {
        clearInterval(heartbeatInterval);
      }
    }, 30000);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(heartbeatInterval);
      const connections = sseConnections.get(email);
      if (connections) {
        connections.delete(res);
        if (connections.size === 0) {
          sseConnections.delete(email);
        }
      }
    });
  } catch (error) {
    console.error('[BdaAttendance] SSE error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/beacon-leave ====================
// Fire-and-forget endpoint for navigator.sendBeacon (no auth header — token in body)

export async function beaconLeave(req, res) {
  try {
    const {
      bookingId,
      token: bodyToken,
      endRequestId,
      endMeetLink,
      endSource,
      durationMsSnapshot,
      clientNow,
    } = req.body;
    const leftAt = toServerClock(req.body.leftAt, clientNow);
    const joinedAtSnapshot = toServerClock(req.body.joinedAtSnapshot, clientNow);

    if (!bookingId || !bodyToken) {
      return res.status(200).json({ success: false, error: 'Missing required fields' });
    }

    let payload;
    try {
      payload = jwt.verify(bodyToken, getCrmJwtSecret());
    } catch {
      return res.status(200).json({ success: false, error: 'Invalid token' });
    }

    if (payload?.role !== 'bda_extension') {
      return res.status(200).json({ success: false, error: 'Forbidden' });
    }

    const emailNorm = normalizeEmail(payload.email);
    const name = payload.name || emailNorm;

    const closeResult = await closeBdaAttendanceSession({
      bookingId,
      bdaEmail: emailNorm,
      bdaName: name,
      leftAt,
      clientDurationMs: durationMsSnapshot,
      sendDurationNotification: true,
    });

    if (!closeResult.closed) {
      return res.status(200).json({ success: true, message: 'No open session' });
    }

    if (
      endRequestId &&
      endSource &&
      END_SOURCES.includes(String(endSource))
    ) {
      const existing = await BdaAttendanceEndEventModel.findOne({
        bdaEmail: emailNorm,
        requestId: String(endRequestId),
      });
      if (!existing) {
        const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
        const meetLink = endMeetLink || null;
        let linkMismatch = false;
        if (booking && meetLink) {
          linkMismatch = meetLinksRoughMatch(booking, meetLink).mismatch;
        }
        await persistEndEventAndMetadata({
          emailNorm,
          name,
          bookingId,
          meetLink,
          meetCode: extractMeetCodeFromUrl(meetLink),
          endedAt: closeResult.leaveTime,
          endSource: String(endSource),
          requestId: String(endRequestId),
          joinedAtSnapshot,
          durationMsSnapshot,
          linkMismatch,
          unresolvedBooking: false,
          sessionClosed: true,
          durationMsAfterClose: closeResult.durationMs,
        });
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[BdaAttendance] beaconLeave error:', error);
    return res.status(200).json({ success: true });
  }
}

// ==================== POST /api/bda-attendance/beacon-end-event ====================
// sendBeacon when bookingId may be unknown — token in body; resolves booking via meet link

export async function beaconReportEndEvent(req, res) {
  try {
    const {
      token: bodyToken,
      meetLink,
      endSource,
      requestId,
      durationMsSnapshot,
      clientNow,
    } = req.body;
    const leftAt = toServerClock(req.body.leftAt, clientNow);
    const joinedAtSnapshot = toServerClock(req.body.joinedAtSnapshot, clientNow);

    if (!bodyToken || !requestId) {
      return res.status(200).json({ success: false, error: 'Missing required fields' });
    }

    let payload;
    try {
      payload = jwt.verify(bodyToken, getCrmJwtSecret());
    } catch {
      return res.status(200).json({ success: false, error: 'Invalid token' });
    }

    if (payload?.role !== 'bda_extension') {
      return res.status(200).json({ success: false, error: 'Forbidden' });
    }

    const emailNorm = normalizeEmail(payload.email);
    const name = payload.name || emailNorm;

    const out = await processReportEndEventCore({
      emailNorm,
      name,
      bookingId: undefined,
      meetLink,
      leftAt,
      endSource,
      requestId,
      joinedAtSnapshot,
      durationMsSnapshot,
    });

    return res.status(200).json(out.ok ? out.body : { success: false, ...out.body });
  } catch (error) {
    console.error('[BdaAttendance] beaconReportEndEvent error:', error);
    return res.status(200).json({ success: true });
  }
}

// ==================== GET /api/bda-attendance/missed-logs ====================

export async function getMissedMeetingLogs(req, res) {
  try {
    const { fromDate, toDate, page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Missed = explicitly absent OR unmarked (no response captured). Unmarked
    // is NOT a confirmed absence — surfaced here so admin can follow up.
    const attendanceMatch = { status: { $in: ['absent', 'unmarked'] } };
    // Optional BDA filter (Meeting Info's BDA dropdown): only that BDA's missed rows.
    if (typeof req.query.bdaEmail === 'string' && req.query.bdaEmail.trim()) {
      attendanceMatch.bdaEmail = req.query.bdaEmail.trim().toLowerCase().slice(0, 200);
    }
    if (fromDate || toDate) {
      attendanceMatch.meetingScheduledStart = {};
      if (fromDate) {
        const from = new Date(String(fromDate));
        from.setHours(0, 0, 0, 0);
        attendanceMatch.meetingScheduledStart.$gte = from;
      }
      if (toDate) {
        const to = new Date(String(toDate));
        to.setHours(23, 59, 59, 999);
        attendanceMatch.meetingScheduledStart.$lte = to;
      }
    }

    const [rows, totalCount] = await Promise.all([
      BdaAttendanceModel.aggregate([
        { $match: attendanceMatch },
        {
          $lookup: {
            from: 'campaignbookings',
            localField: 'bookingId',
            foreignField: 'bookingId',
            as: 'booking',
          },
        },
        {
          $unwind: {
            path: '$booking',
            preserveNullAndEmptyArrays: true,
          },
        },
        { $sort: { meetingScheduledStart: -1, markedAt: -1 } },
        { $skip: skip },
        { $limit: limitNum },
        {
          $project: {
            _id: 0,
            bookingId: 1,
            bdaName: 1,
            bdaEmail: 1,
            status: 1,
            source: 1,
            notes: 1,
            markedAt: 1,
            // In time survives session close via firstJoinedAt.
            joinedAt: { $ifNull: ['$firstJoinedAt', '$joinedAt'] },
            leftAt: 1,
            durationMs: 1,
            cumulativeDurationMs: 1,
            lateByMs: 1,
            verified: {
              $or: [{ $eq: ['$source', 'meet_api'] }, { $ne: ['$meetApiFinalizedAt', null] }],
            },
            meetLink: 1,
            meetingScheduledStart: 1,
            meetingScheduledEnd: 1,
            clientName: { $ifNull: ['$booking.clientName', null] },
            clientEmail: { $ifNull: ['$booking.clientEmail', null] },
            meetingVideoUrl: { $ifNull: ['$booking.meetingVideoUrl', null] },
            bookingStatus: { $ifNull: ['$booking.bookingStatus', null] },
            utmSource: { $ifNull: ['$booking.utmSource', null] },
          },
        },
      ]),
      BdaAttendanceModel.countDocuments(attendanceMatch),
    ]);

    // Drop "no response" rows for bookings where another row proves presence
    // (e.g. the scheduler's "unassigned" row sitting next to the BDA's real
    // present row) — they would falsely appear as missed meetings.
    const pageIds = rows.map((r) => r.bookingId);
    const presentRows = await BdaAttendanceModel.find({
      bookingId: { $in: pageIds },
      status: { $in: ['present', 'manual'] },
    })
      .select('bookingId')
      .lean();
    const presentSet = new Set(presentRows.map((r) => r.bookingId));
    const data = rows.filter((r) => !(r.status === 'unmarked' && presentSet.has(r.bookingId)));

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error) {
    console.error('[BdaAttendance] getMissedMeetingLogs error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== GET /api/bda-attendance/by-booking/:bookingId ====================

export async function getAttendanceByBooking(req, res) {
  try {
    const { bookingId } = req.params;

    const attendance = await BdaAttendanceModel.findOne({ bookingId }).lean();

    return res.status(200).json({
      success: true,
      attendance: attendance
        ? {
            status: attendance.status,
            source: attendance.source,
            bdaName: attendance.bdaName,
            bdaEmail: attendance.bdaEmail,
            joinedAt: attendance.firstJoinedAt || attendance.joinedAt || null,
            leftAt: attendance.leftAt,
            markedAt: attendance.markedAt,
            meetLink: attendance.meetLink,
            durationMs: attendance.durationMs ?? null,
            cumulativeDurationMs: attendance.cumulativeDurationMs ?? 0,
            verified: attendance.source === 'meet_api' || Boolean(attendance.meetApiFinalizedAt),
            lateByMs: attendance.lateByMs ?? null,
            sessions: Array.isArray(attendance.sessions) ? attendance.sessions : [],
            participantsAtJoin: Array.isArray(attendance.participantsAtJoin) ? attendance.participantsAtJoin : [],
            meetingScheduledStart: attendance.meetingScheduledStart ?? null,
            meetingScheduledEnd: attendance.meetingScheduledEnd ?? null,
            notes: attendance.notes ?? null,
          }
        : null,
    });
  } catch (error) {
    console.error('[BdaAttendance] getAttendanceByBooking error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== GET /api/bda-attendance/bulk ====================

export async function getAttendanceBulk(req, res) {
  try {
    const bookingIdsParam = req.query.bookingIds;
    if (!bookingIdsParam) {
      return res.status(400).json({ success: false, error: 'bookingIds query param required' });
    }

    const bookingIds = bookingIdsParam.split(',').filter(Boolean).slice(0, 100);

    const records = await BdaAttendanceModel.find({
      bookingId: { $in: bookingIds },
    }).lean();

    // A booking can have several rows (scheduler's "unassigned" + the real
    // BDA's row). Keep the most authoritative one:
    // Google-verified > present/manual > absent > unmarked.
    const rank = (a) =>
      (a.source === 'meet_api' ? 40 : 0) +
      (a.status === 'present' ? 30 : a.status === 'manual' ? 20 : a.status === 'absent' ? 10 : 0);
    records.sort((a, b) => rank(a) - rank(b));

    const attendanceMap = {};
    for (const att of records) {
      attendanceMap[att.bookingId] = {
        status: att.status,
        source: att.source,
        bdaName: att.bdaName,
        bdaEmail: att.bdaEmail,
        // In time survives session close via firstJoinedAt (joinedAt is
        // cleared when a session ends).
        joinedAt: att.firstJoinedAt || att.joinedAt || null,
        leftAt: att.leftAt,
        markedAt: att.markedAt,
        durationMs: att.durationMs ?? null,
        cumulativeDurationMs: att.cumulativeDurationMs ?? 0,
        // ---- Google Meet records (source: meet_api) ----
        verified: att.source === 'meet_api' || Boolean(att.meetApiFinalizedAt),
        lateByMs: att.lateByMs ?? null,
        sessions: Array.isArray(att.sessions) ? att.sessions : [],
        participantsAtJoin: Array.isArray(att.participantsAtJoin) ? att.participantsAtJoin : [],
        notes: att.notes ?? null,
      };
    }

    // Fill nulls for missing
    for (const id of bookingIds) {
      if (!attendanceMap[id]) {
        attendanceMap[id] = null;
      }
    }

    return res.status(200).json({ success: true, attendanceMap });
  } catch (error) {
    console.error('[BdaAttendance] getAttendanceBulk error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

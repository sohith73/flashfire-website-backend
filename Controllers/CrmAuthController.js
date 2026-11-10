import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { CrmSessionModel } from '../Schema_Models/CrmSessionModel.js';
import { CrmLoginApprovalModel } from '../Schema_Models/CrmLoginApprovalModel.js';
import { CrmTrustedDeviceModel } from '../Schema_Models/CrmTrustedDeviceModel.js';
import { sendCrmOtpEmail } from '../Utils/SendGridHelper.js';
import { deleteOtp, decrementAttempts, getOtp, setOtp, getOtpCacheStats } from '../Utils/CrmOtpCache.js';
import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { getClientIp, detectCountryFromIp } from '../Utils/GeoIP.js';
import { parseUserAgent } from '../Utils/UserAgentParser.js';
import { computeDeviceKey } from '../Utils/DeviceKey.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';

/**
 * Issues a CRM JWT + session record for a fully-authenticated user (OTP verified,
 * and — for BDAs — device already trusted or just approved by an admin).
 * Shared by the direct-login path and the "approval just granted" path so both
 * produce an identical session record.
 */
// Every CRM login lasts 30 days.
const CRM_SESSION_EXPIRES_IN = '30d';
const CRM_SESSION_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;

export async function issueCrmSessionAndToken({ user, ip, countryCode, country, browser, os, deviceType, userAgent }) {
  const expiresIn = CRM_SESSION_EXPIRES_IN;
  const expiresMs = CRM_SESSION_EXPIRES_MS;
  const sessionId = crypto.randomUUID();

  const token = jwt.sign(
    {
      role: 'crm_user',
      // Distinct from the `role` claim above (which is the auth-role used by
      // requireCrmUser/requireCrmAdmin) — this carries the CrmUser.role value
      // (admin/bda) so per-request BDA scoping can read it without a DB lookup.
      bdaRole: user.role || 'bda',
      email: user.email,
      name: user.name,
      permissions: user.permissions || [],
      sessionId,
    },
    getCrmJwtSecret(),
    { expiresIn }
  );

  try {
    await CrmSessionModel.create({
      sessionId,
      email: user.email,
      deviceKey: computeDeviceKey(userAgent, ip),
      ip: ip || '',
      countryCode,
      country,
      browser,
      os,
      deviceType,
      userAgent: userAgent || '',
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + expiresMs),
    });
  } catch (sessionError) {
    // Session bookkeeping must never block a successful login.
    console.error('CRM session creation error:', sessionError?.message || sessionError);
  }

  return {
    token,
    user: {
      email: user.email,
      name: user.name,
      permissions: user.permissions || [],
      role: user.role || 'bda',
      // The CRM decides what to show from role OR isAdmin. Without it an admin whose account is role 'bda' would be
      // shown as a BDA until the next page reload (only /auth/me used to return it).
      isAdmin: user.isAdmin === true,
    },
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  // Simple internal validation; not RFC perfect but good enough for auth.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000)); // 6 digits
}

function otpHash(email, otp) {
  const secret = process.env.CRM_OTP_HASH_SECRET || getCrmJwtSecret();
  const value = `${normalizeEmail(email)}|${String(otp).trim()}|${secret}`;
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function requestCrmOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }

    const user = await CrmUserModel.findOne({ email }).lean();

    // Privacy-friendly response: always return success even if user not found/inactive.
    // But only send OTP if user exists and is active.
    if (!user || user.isActive === false) {
      return res.status(200).json({ success: true, message: 'If your email is authorized, you will receive an OTP.' });
    }

    const otp = generateOtp();
    // Requested: console log OTP for now (keep it short and clear)
    console.log(`[CRM OTP] ${email} -> ${otp}`);

    const ttlSeconds = Number(process.env.CRM_OTP_TTL_SECONDS || 300);
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    setOtp(email, { otpHash: otpHash(email, otp), expiresAtMs, attemptsLeft: 5 });

    // Send email via SendGrid
    await sendCrmOtpEmail(email, otp, user?.name);

    return res.status(200).json({
      success: true,
      message: 'OTP sent',
      cache: getOtpCacheStats(),
    });
  } catch (error) {
    console.error('CRM OTP request error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function verifyCrmOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();

    if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, error: 'Invalid email' });
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ success: false, error: 'Invalid OTP' });

    const entry = getOtp(email);
    if (!entry) {
      return res.status(401).json({ success: false, error: 'OTP expired or not found' });
    }

    const incomingHash = otpHash(email, otp);
    const ok = crypto.timingSafeEqual(Buffer.from(incomingHash), Buffer.from(entry.otpHash));
    if (!ok) {
      decrementAttempts(email);
      return res.status(401).json({ success: false, error: 'Invalid OTP' });
    }

    // Required: remove it after validation
    deleteOtp(email);

    const user = await CrmUserModel.findOne({ email }).lean();
    if (!user || user.isActive === false) {
      return res.status(403).json({ success: false, error: 'User not authorized' });
    }

    const ip = getClientIp(req);
    const { countryCode, country } = detectCountryFromIp(ip);
    const { browser, os, deviceType } = parseUserAgent(req.headers['user-agent']);
    const userAgent = req.headers['user-agent'] || '';

    // Admins bypass the device-approval gate entirely; only BDAs are gated.
    if (user.role === 'bda') {
      const deviceKey = computeDeviceKey(userAgent, ip);
      const trusted = await CrmTrustedDeviceModel.findOne({ email: user.email, deviceKey }).lean();

      if (!trusted) {
        const sessionId = crypto.randomUUID();
        await CrmLoginApprovalModel.create({
          email: user.email,
          name: user.name,
          deviceKey,
          sessionId,
          ip: ip || '',
          countryCode,
          country,
          browser,
          os,
          deviceType,
          userAgent,
          status: 'pending',
          expiresIn: CRM_SESSION_EXPIRES_IN,
        });

        return res.status(200).json({
          success: true,
          pendingApproval: true,
          approvalId: sessionId,
          message: 'New device detected. Waiting for admin approval.',
        });
      }
    }

    const result = await issueCrmSessionAndToken({
      user, ip, countryCode, country, browser, os, deviceType, userAgent,
    });

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('CRM OTP verify error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function getLoginApprovalStatus(req, res) {
  try {
    const { approvalId } = req.params;
    const approval = await CrmLoginApprovalModel.findOne({ sessionId: approvalId });
    if (!approval) return res.status(404).json({ success: false, error: 'Approval request not found' });

    if (approval.status === 'pending') {
      return res.status(200).json({ success: true, status: 'pending' });
    }

    if (approval.status === 'denied') {
      return res.status(200).json({ success: true, status: 'denied' });
    }

    // approved — but only hand out the token once; approval doc is consumed on first poll hit.
    if (approval.status === 'approved' && approval.issuedToken) {
      const token = approval.issuedToken;
      approval.issuedToken = undefined;
      await approval.save();

      const user = await CrmUserModel.findOne({ email: approval.email }).lean();
      return res.status(200).json({
        success: true,
        status: 'approved',
        token,
        user: {
          email: user.email,
          name: user.name,
          permissions: user.permissions || [],
          role: user.role || 'bda',
          isAdmin: user.isAdmin === true,
        },
      });
    }

    return res.status(200).json({ success: true, status: 'approved' });
  } catch (error) {
    console.error('CRM login approval status error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function crmMe(req, res) {
  try {
    const email = normalizeEmail(req.crmUser?.email);
    if (!email) return res.status(401).json({ success: false, error: 'Invalid token' });
    const user = await CrmUserModel.findOne({ email }).lean();
    if (!user || user.isActive === false) return res.status(401).json({ success: false, error: 'Unauthorized' });
    // Attendance: the CRM shows admin-only screens from this flag, not from `role`, because some admin accounts have
    // role 'bda' with isAdmin set (plan 8.3). One shared rule, isCrmAdmin, decides it.
    const isAdmin = await isCrmAdmin(req.crmUser);
    return res.status(200).json({
      success: true,
      user: {
        email: user.email,
        name: user.name,
        permissions: user.permissions || [],
        role: user.role || 'bda',
        isAdmin,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}



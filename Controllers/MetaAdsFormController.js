import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { MetaAdsFormSubmissionModel } from '../Schema_Models/MetaAdsFormSubmission.js';
import { normalizePhoneForMatching } from '../Utils/normalizePhoneForMatching.js';
import { triggerWorkflow } from './WorkflowController.js';
import { getClientIp, detectCountryFromIp } from '../Utils/GeoIP.js';
import { sendMetaLeadDiscordNotification } from './MetaLeadWebhookController.js';
import { resolveLeadMarket, routeNoteLine } from '../Utils/leadMarket.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORM_NAME = 'meta_ads_form_website';

// ---------------------------------------------------------------------------
// In-memory rate limiter — fixed window per IP
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_MAX_REQUESTS = 8;
const RATE_MAP_EVICT_SIZE = 5000;
const rateMap = new Map(); // ip -> { count, resetAt }

/**
 * Keep the rate map bounded. Only runs when over the cap (no per-request full
 * scan): first sweep expired entries; if still over, drop the oldest entries
 * (Map preserves insertion order) until we are back under the cap.
 */
function evictRateMapEntries(now) {
  if (rateMap.size <= RATE_MAP_EVICT_SIZE) return;

  for (const [k, entry] of rateMap) {
    if (entry.resetAt <= now) rateMap.delete(k);
  }

  if (rateMap.size <= RATE_MAP_EVICT_SIZE) return;

  for (const k of rateMap.keys()) {
    if (rateMap.size <= RATE_MAP_EVICT_SIZE) break;
    rateMap.delete(k);
  }
}

function isRateLimited(ip) {
  const key = ip || 'unknown';
  const now = Date.now();

  const existing = rateMap.get(key);
  if (!existing || existing.resetAt <= now) {
    rateMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    evictRateMapEntries(now);
    return false;
  }

  existing.count += 1;
  return existing.count > RATE_MAX_REQUESTS;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Trim a string field; missing → '', wrong type → null. */
function cleanString(value) {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  return value.trim();
}

/**
 * Optional string field: trimmed value or null (wrong type / empty → null).
 * Over-length values are TRUNCATED, never rejected — a lead must not be lost
 * over telemetry.
 */
function optionalString(value, maxLength) {
  const v = cleanString(value);
  if (!v) return null;
  return maxLength && v.length > maxLength ? v.slice(0, maxLength) : v;
}

function extractClientGeo(raw) {
  const geo = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    countryCode: optionalString(geo.countryCode, 8),
    timezone: optionalString(geo.timezone, 64),
    language: optionalString(geo.language, 35)
  };
}

function validateSubmission(body) {
  const errors = {};

  const name = cleanString(body.name);
  if (name === null) {
    errors.name = 'Name must be a string';
  } else if (name.length < 2 || name.length > 200) {
    errors.name = 'Name must be between 2 and 200 characters';
  }

  const rawEmail = cleanString(body.email);
  const email = rawEmail === null ? null : rawEmail.toLowerCase();
  if (email === null) {
    errors.email = 'Email must be a string';
  } else if (!email) {
    errors.email = 'Email is required';
  } else if (email.length > 320 || !EMAIL_REGEX.test(email)) {
    errors.email = 'Please provide a valid email address';
  }

  const phone = cleanString(body.phone);
  if (phone === null) {
    errors.phone = 'Phone must be a string';
  } else if (!phone) {
    errors.phone = 'Phone is required';
  } else if (phone.length > 32) {
    errors.phone = 'Phone must be at most 32 characters';
  } else if (phone.replace(/\D/g, '').length < 7) {
    errors.phone = 'Phone must contain at least 7 digits';
  }

  const status = cleanString(body.status);
  if (status === null) {
    errors.status = 'Status must be a string';
  } else if (!status) {
    errors.status = 'Status is required';
  } else if (status.length > 200) {
    errors.status = 'Status must be at most 200 characters';
  }

  const rawLocale = cleanString(body.locale);
  let locale = 'us';
  if (rawLocale === null) {
    errors.locale = 'Locale must be a string';
  } else if (rawLocale && rawLocale !== 'us' && rawLocale !== 'en-ca') {
    errors.locale = "Locale must be 'us' or 'en-ca'";
  } else if (rawLocale) {
    locale = rawLocale;
  }

  // Optional/telemetry strings are truncated to their caps, never rejected.
  // utmSource is an indexed field (Mongo rejects index keys > 1024 bytes);
  // 200 chars stays safely under even with multibyte UTF-8.
  return {
    errors,
    fields: {
      name: name || '',
      email: email || '',
      phone: phone || '',
      status: status || '',
      locale,
      pageUrl: optionalString(body.pageUrl, 2048),
      referrer: optionalString(body.referrer, 2048),
      visitorId: optionalString(body.visitorId, 64),
      utmSource: optionalString(body.utmSource, 200),
      utmMedium: optionalString(body.utmMedium, 200),
      utmCampaign: optionalString(body.utmCampaign, 200),
      utmContent: optionalString(body.utmContent, 200),
      utmTerm: optionalString(body.utmTerm, 200),
      fbclid: optionalString(body.fbclid, 512),
      fbp: optionalString(body.fbp, 512),
      fbc: optionalString(body.fbc, 512),
      // Which page the lead submitted from, and the Google Ads click ids from the landing URL
      market: optionalString(body.market, 16),
      landingRoute: optionalString(body.landingRoute, 120),
      gclid: optionalString(body.gclid, 512),
      gbraid: optionalString(body.gbraid, 512),
      wbraid: optionalString(body.wbraid, 512),
      gadCampaignId: optionalString(body.gadCampaignId, 64),
      clientGeo: extractClientGeo(body.clientGeo)
    }
  };
}

// ---------------------------------------------------------------------------
// Bookkeeping — archive outcome + Discord notification (both non-fatal)
// ---------------------------------------------------------------------------

async function finalizeSubmission(archiveDoc, outcome, bookingId, discordInfo) {
  if (archiveDoc) {
    try {
      archiveDoc.bookingId = bookingId;
      archiveDoc.outcome = outcome;
      await archiveDoc.save();
    } catch (archiveError) {
      console.error('Meta ads form: failed to update archive outcome:', archiveError.message);
    }
  }

  try {
    await sendMetaLeadDiscordNotification(discordInfo);
  } catch (discordErr) {
    console.error('Failed to send Discord notification for meta ads form lead:', discordErr.message);
  }
}

// ---------------------------------------------------------------------------
// POST /api/meta-ads-form/lead — public website form → CRM meta lead
// ---------------------------------------------------------------------------

export const submitMetaAdsFormLead = async (req, res) => {
  let archiveDoc = null;

  try {
    // 1. Honeypot — bots get a fake success, zero writes, zero notifications
    if ((req.body?._honey ?? '') !== '') {
      console.log('Meta ads form: honeypot triggered, dropping submission');
      return res.status(200).json({ success: true, bookingId: null, deduped: false });
    }

    // Stored for analytics (client-settable headers are fine there); the rate
    // limiter must NOT trust those headers, so it keys on req.ip instead
    // (derived via Express's `trust proxy` setting in index.js).
    const ip = getClientIp(req);

    // 2. Rate limit by IP
    if (isRateLimited(req.ip || 'unknown')) {
      console.warn(`Meta ads form: rate limit exceeded for IP ${req.ip || 'unknown'}`);
      return res.status(429).json({ success: false, message: 'Too many requests. Please try again shortly.' });
    }

    // 3. Validate — collect ALL field errors into one response
    const { errors, fields } = validateSubmission(req.body || {});
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    const {
      name, email, phone, status, locale, pageUrl, referrer, visitorId,
      utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
      fbclid, fbp, fbc, clientGeo, gclid, gbraid, wbraid, gadCampaignId
    } = fields;
    const { leadMarket, landingRoute } = resolveLeadMarket({ market: fields.market, landingRoute: fields.landingRoute, pageUrl, locale });
    // Google Ads traffic has no utm_source of its own; label it so the CRM source column is not blank.
    const sourceFallback = gclid || gbraid || wbraid ? 'google' : 'meta_ads_form';

    // 4. Server-side geo (never blocks the submission)
    let geoLookup = { countryCode: null, country: null };
    try {
      geoLookup = detectCountryFromIp(ip) || { countryCode: null, country: null };
    } catch (geoError) {
      console.warn('Meta ads form: GeoIP lookup failed:', geoError.message);
    }
    const serverGeo = {
      ip: ip || null,
      countryCode: geoLookup.countryCode || null,
      country: geoLookup.country || null
    };

    const userAgent = req.headers['user-agent'] || null;
    const normalizedEmail = email; // already trimmed + lowercased in validation
    const normalizedPhone = normalizePhoneForMatching(phone);

    // 5. Archive first — CRM capture takes priority, so archive failure is non-fatal
    try {
      archiveDoc = await MetaAdsFormSubmissionModel.create({
        name,
        email: normalizedEmail,
        phone: phone || null,
        normalizedPhone: normalizedPhone || null,
        status,
        locale,
        clientGeo,
        serverGeo,
        userAgent,
        utmSource,
        utmMedium,
        utmCampaign,
        utmContent,
        utmTerm,
        fbclid,
        fbp,
        fbc,
        market: leadMarket,
        landingRoute,
        gclid,
        gbraid,
        wbraid,
        gadCampaignId,
        pageUrl,
        referrer,
        visitorId
      });
    } catch (archiveError) {
      console.error('Meta ads form: failed to archive submission (continuing):', archiveError.message);
    }

    // 6. Dedupe against existing CRM leads (email + phone, same as Meta webhook)
    const orConditions = [{ clientEmail: normalizedEmail }];
    if (normalizedPhone) {
      orConditions.push({ normalizedClientPhone: normalizedPhone });
      orConditions.push({ clientPhone: { $regex: normalizedPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' } });
    }
    const existingLead = await CampaignBookingModel.findOne({ $or: orConditions }).sort({ bookingCreatedAt: -1 });

    const additionalNotes = `Job type: ${status}`;

    if (existingLead) {
      // 7. Merge path — enrich only; never downgrade status or re-trigger workflows
      const mergeSet = { clientName: name };
      // Keep the first page a lead came from; fill it in only when the lead has none yet.
      if (leadMarket && !existingLead.leadMarket) mergeSet.leadMarket = leadMarket;
      if (landingRoute && !existingLead.landingRoute) mergeSet.landingRoute = landingRoute;
      if (gclid && !existingLead.gclid) mergeSet.gclid = gclid;
      if (gadCampaignId && !existingLead.gadCampaignId) mergeSet.gadCampaignId = gadCampaignId;
      if (phone) {
        mergeSet.clientPhone = phone;
        // findOneAndUpdate bypasses the pre-save hook, so set normalizedClientPhone explicitly
        mergeSet.normalizedClientPhone = normalizedPhone || null;
      }
      // Skip the note append when this exact line is already there (resubmission)
      const prev = existingLead.anythingToKnow || '';
      // The route note is added once per route, so a resubmission from /uk after /uk adds nothing.
      const routeNote = routeNoteLine(leadMarket, landingRoute);
      const noteParts = [];
      if (!prev.includes(additionalNotes)) noteParts.push(additionalNotes);
      if (routeNote && !prev.includes(routeNote)) noteParts.push(routeNote);
      if (noteParts.length) mergeSet.anythingToKnow = [prev, noteParts.join('\n')].filter(Boolean).join('\n\n');

      await CampaignBookingModel.findOneAndUpdate({ bookingId: existingLead.bookingId }, { $set: mergeSet });
      console.log(`Meta ads form lead merged: ${existingLead.bookingId} | ${normalizedEmail} | ${existingLead.bookingStatus}`);

      // Respond immediately — bookkeeping below must not delay the client
      res.status(200).json({ success: true, bookingId: existingLead.bookingId, deduped: true });

      // Post-response: archive outcome + Discord (each step try/caught inside)
      await finalizeSubmission(archiveDoc, 'merged', existingLead.bookingId, {
        bookingId: existingLead.bookingId,
        clientName: name,
        clientEmail: normalizedEmail,
        clientPhone: phone,
        formName: FORM_NAME,
        jobType: status,
        utmSource: utmSource || sourceFallback,
        utmMedium: utmMedium || 'paid',
        utmCampaign: utmCampaign || FORM_NAME,
        countryCode: serverGeo.countryCode,
        locale,
        market: leadMarket,
        landingRoute,
        outcome: 'merged',
        leadgenId: null,
        adId: null
      });
      return;
    }

    // 8. Create path — new CRM meta lead
    const newBooking = new CampaignBookingModel({
      clientName: name,
      clientEmail: normalizedEmail,
      clientPhone: phone || null,
      normalizedClientPhone: normalizedPhone || null,
      utmSource: utmSource || sourceFallback,
      utmMedium: utmMedium || 'paid',
      utmCampaign: utmCampaign || FORM_NAME,
      utmContent: utmContent || null,
      utmTerm: utmTerm || null,
      bookingStatus: 'not-scheduled',
      leadSource: 'meta_lead_ad',
      metaFormName: FORM_NAME,
      leadMarket,
      landingRoute,
      gclid: gclid || null,
      gadCampaignId: gadCampaignId || null,
      metaRawData: {
        source: FORM_NAME,
        locale,
        payload: {
          name,
          email: normalizedEmail,
          phone,
          status,
          locale,
          pageUrl,
          referrer,
          visitorId,
          utmSource,
          utmMedium,
          utmCampaign,
          utmContent,
          utmTerm,
          fbclid,
          fbp,
          fbc,
          market: leadMarket,
          landingRoute,
          gclid,
          gbraid,
          wbraid,
          gadCampaignId
        },
        clientGeo,
        serverGeo,
        submittedAt: new Date().toISOString()
      },
      anythingToKnow: [additionalNotes, routeNoteLine(leadMarket, landingRoute)].filter(Boolean).join('\n'),
      visitorId: visitorId || null,
      userAgent,
      ipAddress: ip || null,
      bookingCreatedAt: new Date()
    });

    await newBooking.save();
    console.log(`Meta ads form lead saved: ${newBooking.bookingId} | ${name} | ${normalizedEmail} | ${phone}`);

    // Respond immediately — triggerWorkflow can run SendGrid/WATI sends inline
    // and must not push the client past its 15s abort
    res.status(201).json({ success: true, bookingId: newBooking.bookingId, deduped: false });

    // Post-response: workflows + archive outcome + Discord. Every step is
    // try/caught (no global rejection handler in this app) and none touch res.
    try {
      const wfResult = await triggerWorkflow(newBooking.bookingId, 'not-scheduled');
      if (wfResult.success && wfResult.triggered) {
        console.log(`Not-scheduled workflows triggered for meta ads form lead ${newBooking.bookingId}`);
      }
    } catch (wfError) {
      console.error(`Failed to trigger workflows for meta ads form lead ${newBooking.bookingId}:`, wfError.message);
    }

    await finalizeSubmission(archiveDoc, 'created', newBooking.bookingId, {
      bookingId: newBooking.bookingId,
      clientName: name,
      clientEmail: normalizedEmail,
      clientPhone: phone,
      formName: FORM_NAME,
      jobType: status,
      utmSource: newBooking.utmSource,
      utmMedium: newBooking.utmMedium,
      utmCampaign: newBooking.utmCampaign,
      countryCode: serverGeo.countryCode,
      locale,
      market: leadMarket,
      landingRoute,
      outcome: 'created',
      leadgenId: null,
      adId: null
    });
    return;
  } catch (error) {
    console.error('Error processing meta ads form lead:', error);

    if (archiveDoc) {
      try {
        archiveDoc.outcome = 'error';
        archiveDoc.errorMessage = error.message || String(error);
        await archiveDoc.save();
      } catch (archiveError) {
        console.error('Meta ads form: failed to mark archive as errored:', archiveError.message);
      }
    }

    // Post-response steps are individually try/caught, so reaching here after
    // the response was sent should not happen — but never touch res twice.
    if (res.headersSent) return;
    return res.status(500).json({ success: false, message: 'Failed to submit lead. Please try again.' });
  }
};

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { Logger } from '../Utils/Logger.js';
import { normalizePhoneForMatching } from '../Utils/normalizePhoneForMatching.js';
import { triggerWorkflow } from './WorkflowController.js';
import { sanitizeMetaField, sanitizeMetaFields } from '../Utils/sanitizeMetaField.js';

const FB_VERIFY_TOKEN = process.env.FB_WEBHOOK_VERIFY_TOKEN || 'flashfire_meta_leads_verify';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const META_GRAPH_VERSION = 'v21.0';
const LEAD_FETCH_FIELDS = 'id,created_time,field_data,ad_id,form_id,form_name,campaign_id,platform';

// ---------------------------------------------------------------------------
// GET — Meta webhook verification
// ---------------------------------------------------------------------------

export const verifyMetaWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('Meta Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('Meta Webhook verification failed. Token mismatch.');
  return res.status(403).json({ error: 'Verification failed' });
};

// ---------------------------------------------------------------------------
// Graph API — fetch lead by leadgen_id (with retries for race condition)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLeadDataFromMeta(leadgenId) {
  if (!FB_PAGE_ACCESS_TOKEN) {
    Logger.error('FB_PAGE_ACCESS_TOKEN not configured — cannot fetch lead data from Meta');
    return null;
  }

  const base = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(leadgenId)}`;
  const delaysMs = [0, 1500, 3500];

  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    if (delaysMs[attempt] > 0) await sleep(delaysMs[attempt]);

    try {
      const url = new URL(base);
      url.searchParams.set('fields', LEAD_FETCH_FIELDS);
      url.searchParams.set('access_token', FB_PAGE_ACCESS_TOKEN);

      const response = await fetch(url.toString());
      const data = await response.json();

      if (data.error) {
        Logger.warn('Meta Graph API error fetching lead', {
          leadgenId,
          attempt: attempt + 1,
          message: data.error.message,
          code: data.error.code,
          type: data.error.type
        });
        if (attempt === delaysMs.length - 1) return null;
        continue;
      }

      const hasFields = Array.isArray(data.field_data) && data.field_data.length > 0;

      if (hasFields || attempt === delaysMs.length - 1) return data;

      Logger.warn('Meta lead fetch returned empty field_data; retrying', {
        leadgenId,
        attempt: attempt + 1
      });
    } catch (error) {
      Logger.error('Failed to fetch lead data from Meta', { leadgenId, error: error.message });
      if (attempt === delaysMs.length - 1) return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// field_data parsing helpers
// ---------------------------------------------------------------------------

/**
 * Get value from Meta field_data by exact name first, then normalized name.
 * Tries each candidate in order.
 */
function getFieldValue(fieldData, ...candidates) {
  if (!Array.isArray(fieldData)) return '';

  const val = (f) => {
    if (!f?.values?.length) return '';
    return f.values[0] == null ? '' : String(f.values[0]).trim();
  };

  for (const c of candidates) {
    if (!c) continue;
    const hit = fieldData.find((f) => f.name === c);
    const v = val(hit);
    if (v) return v;
  }

  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, '_');
  const map = new Map();
  for (const f of fieldData) {
    const key = norm(f.name);
    const v = val(f);
    if (!map.has(key) && v) map.set(key, v);
  }
  for (const c of candidates) {
    if (!c) continue;
    const v = map.get(norm(c));
    if (v) return v;
  }

  return '';
}

/**
 * A job type is an answer like "opt_jobs" — never a phone number.
 *
 * Both ingest paths have been landing the lead's phone in the job-type slot: the
 * webhook via a "...whatsapp number...job..." field name (fixed in parseLeadFields
 * below), and the Sheets upsert because the Apps Script sends the phone in its
 * `job_type` column (on the affected rows metaRawData.job_type === metaRawData.phone
 * exactly, so the real answer never reached us and cannot be recovered here).
 *
 * Dropping the value keeps the bad data out of `anythingToKnow`, which is what the
 * Call Leads tab reads the lead's Type from. It does not fix the Sheet.
 */
function sanitizeJobType(value) {
  const v = (value == null ? '' : String(value)).trim();
  if (!v) return '';
  if (/^[+(]?\d[\d\s()\-.]{5,}$/.test(v)) return '';
  return v;
}

/**
 * Broad field_data parser — maps common field names to a structured object.
 */
function parseLeadFields(fieldData) {
  const parsed = {};
  if (!Array.isArray(fieldData)) return parsed;

  for (const field of fieldData) {
    const name = (field.name || '').toLowerCase().replace(/\s+/g, '_');
    const rawValue = field.values?.[0];
    const value = rawValue != null ? String(rawValue).trim() : '';

    if (name.includes('email') || name === 'email') {
      parsed.email = value;
    } else if (name.includes('full_name') || name === 'full_name') {
      parsed.fullName = value;
    } else if (name.includes('first_name') || name === 'first_name') {
      parsed.firstName = value;
    } else if (name.includes('last_name') || name === 'last_name') {
      parsed.lastName = value;
    } else if (
      name.includes('whatsapp') ||
      name.includes('phone') ||
      name === 'mobile' ||
      name === 'mobile_number'
    ) {
      // Matched on `includes`, not `startsWith`: Meta forms ask this as a sentence,
      // e.g. "What is your WhatsApp number to receive job details?". The old prefix
      // test missed those, and they then fell through to the `includes('job')` branch
      // below and were filed as the lead's job title.
      parsed.phone = parsed.phone || value;
    } else if (name.includes('job') || name.includes('role') || name.includes('position')) {
      parsed.jobTitle = value;
    } else if (name.includes('utm_source') || name === 'utmsource') {
      parsed.utmSource = value;
    } else if (name.includes('utm_medium') || name === 'utmmedium') {
      parsed.utmMedium = value;
    } else if (name.includes('utm_campaign') || name === 'utmcampaign') {
      parsed.utmCampaign = value;
    } else {
      if (!parsed.customFields) parsed.customFields = {};
      parsed.customFields[name] = value;
    }
  }

  if (!parsed.fullName && (parsed.firstName || parsed.lastName)) {
    parsed.fullName = [parsed.firstName, parsed.lastName].filter(Boolean).join(' ');
  }

  return parsed;
}

/**
 * Extract CRM-ready fields from Graph API lead data.
 */
function extractLeadFields(leadData) {
  const fd = leadData?.field_data;
  const parsed = parseLeadFields(fd);

  const email =
    getFieldValue(fd, 'email', 'work_email', 'business_email') ||
    parsed.email ||
    '';

  const fullName =
    getFieldValue(fd, 'full_name') ||
    parsed.fullName ||
    [
      getFieldValue(fd, 'first_name') || parsed.firstName,
      getFieldValue(fd, 'last_name') || parsed.lastName
    ].filter(Boolean).join(' ') ||
    '';

  const phone =
    getFieldValue(fd, 'whatsapp_number', 'WhatsApp number', 'whatsapp', 'phone_number', 'phone', 'mobile', 'mobile_number') ||
    parsed.phone ||
    parsed.customFields?.whatsapp_number ||
    parsed.customFields?.phone ||
    parsed.customFields?.mobile ||
    '';

  const jobType = sanitizeJobType(
    getFieldValue(fd, 'which_type_of_job_looking?', 'which_type_of_job_looking') ||
      parsed.jobTitle ||
      ''
  );

  return {
    email: email.trim().toLowerCase(),
    fullName: fullName.trim(),
    phone: phone.trim(),
    jobType: jobType.trim(),
    parsedFields: parsed
  };
}

// ---------------------------------------------------------------------------
// POST — Meta lead webhook handler
// ---------------------------------------------------------------------------

export const handleMetaLeadWebhook = async (req, res) => {
  res.status(200).json({ status: 'received' });

  try {
    const body = req.body;

    if (body.object !== 'page') {
      console.warn('Meta webhook: Unexpected object type:', body.object);
      return;
    }

    for (const entry of body.entry || []) {
      const pageId = entry.id;

      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen') continue;

        const leadValue = change.value || {};
        const { leadgen_id, form_id, ad_id, adgroup_id, created_time } = leadValue;

        if (!leadgen_id) {
          console.warn('Meta webhook: Missing leadgen_id, skipping');
          continue;
        }

        const existingByMetaId = await CampaignBookingModel.findOne({ metaLeadId: leadgen_id });
        if (existingByMetaId) {
          console.log(`Meta lead ${leadgen_id} already exists (${existingByMetaId.bookingId}), skipping`);
          continue;
        }

        const leadData = await fetchLeadDataFromMeta(leadgen_id);
        const extracted = extractLeadFields(leadData);

        if (!extracted.email) {
          Logger.error('Meta lead skipped — no email returned from Graph API', {
            leadgen_id,
            graphReturnedData: !!leadData,
            hint: 'Renew FB_PAGE_ACCESS_TOKEN; ensure leads_retrieval permission; check Leads Access Manager'
          });
          continue;
        }

        const clientName = extracted.fullName || 'New lead';
        const clientEmail = extracted.email;
        const clientPhone = extracted.phone || '';
        const formName = leadData?.form_name || '';
        const parsedFields = extracted.parsedFields || {};

        let additionalNotes = '';
        if (extracted.jobType) {
          additionalNotes = `Job type: ${extracted.jobType}`;
        }
        if (parsedFields.customFields) {
          for (const [key, val] of Object.entries(parsedFields.customFields)) {
            if (key.includes('utm')) continue;
            if (key.includes('which_type') && extracted.jobType) continue;
            additionalNotes = additionalNotes ? `${additionalNotes}\n${key}: ${val}` : `${key}: ${val}`;
          }
        }

        const normalizedEmail = clientEmail.trim().toLowerCase();
        const normalizedPhone = normalizePhoneForMatching(clientPhone);

        const orConditions = [{ clientEmail: normalizedEmail }];
        if (normalizedPhone) {
          orConditions.push({ normalizedClientPhone: normalizedPhone });
          orConditions.push({ clientPhone: { $regex: normalizedPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' } });
        }
        const existingLead = await CampaignBookingModel.findOne({ $or: orConditions }).sort({ bookingCreatedAt: -1 });

        if (existingLead) {
          // sanitizeMetaFields drops Meta permission-error text so it can never be stored
          // as a campaign/ad name. See Utils/sanitizeMetaField.js.
          const mergeSet = sanitizeMetaFields({
            metaLeadId: leadgen_id,
            metaFormId: form_id || null,
            metaAdId: ad_id || null,
            metaAdName: leadValue.ad_name || leadData?.ad_name || null,
            metaAdsetId: adgroup_id || null,
            metaAdsetName: leadValue.adset_name || leadData?.adset_name || null,
            metaPageId: pageId || null,
            metaFormName: formName || null,
            metaCampaignId: leadValue.campaign_id || null,
            metaCampaignName: leadValue.campaign_name || leadData?.campaign_name || null,
            metaPlatform: leadValue.platform || leadData?.platform || null,
            metaIsOrganic: typeof leadValue.is_organic === 'boolean' ? leadValue.is_organic : null,
            metaLeadStatus: leadValue.lead_status || null,
          });
          // Kept verbatim on purpose: the raw payload is the debugging record, so it must
          // not be scrubbed even when it contains the permission error.
          mergeSet.metaRawData = leadData || leadValue;
          if (clientPhone) {
            mergeSet.clientPhone = clientPhone;
            mergeSet.normalizedClientPhone = normalizedPhone || null;
          }
          if (clientName && clientName !== 'New lead') mergeSet.clientName = clientName;
          if (additionalNotes) {
            const prev = existingLead.anythingToKnow || '';
            mergeSet.anythingToKnow = prev ? `${prev}\n\n${additionalNotes}` : additionalNotes;
          }

          await CampaignBookingModel.findOneAndUpdate({ bookingId: existingLead.bookingId }, { $set: mergeSet });
          console.log(`Meta lead merged: ${existingLead.bookingId} | ${existingLead.clientEmail} | ${existingLead.bookingStatus} | Form: ${formName}`);

          try {
            const wfResult = await triggerWorkflow(existingLead.bookingId, 'not-scheduled');
            if (wfResult.success && wfResult.triggered) {
              console.log(`Not-scheduled workflows re-triggered for returning meta lead ${existingLead.bookingId} (status: ${existingLead.bookingStatus})`);
            }
          } catch (wfError) {
            console.error(`Failed to re-trigger workflows for returning meta lead ${existingLead.bookingId}:`, wfError.message);
          }
        } else {
          // sanitizeMetaField drops Meta permission-error text so it can never be stored
          // as a campaign/ad name. See Utils/sanitizeMetaField.js.
          const metaCampaignName = sanitizeMetaField(leadValue.campaign_name || leadData?.campaign_name || null);
          const metaAdName = sanitizeMetaField(leadValue.ad_name || leadData?.ad_name || null);
          const metaAdsetName = sanitizeMetaField(leadValue.adset_name || leadData?.adset_name || null);
          const metaPlatform = sanitizeMetaField(leadValue.platform || leadData?.platform || null);
          const safeAdId = sanitizeMetaField(ad_id || null);
          const newBooking = new CampaignBookingModel({
            clientName: clientName.trim(),
            clientEmail: normalizedEmail,
            clientPhone: clientPhone || null,
            normalizedClientPhone: normalizedPhone || null,
            utmSource: parsedFields.utmSource || metaPlatform || 'meta_lead_ad',
            utmMedium: parsedFields.utmMedium || 'paid',
            utmCampaign: parsedFields.utmCampaign || metaCampaignName || (safeAdId ? `meta_ad_${safeAdId}` : 'meta_lead_form'),
            bookingStatus: 'not-scheduled',
            leadSource: 'meta_lead_ad',
            metaLeadId: leadgen_id,
            metaFormId: form_id || null,
            metaAdId: safeAdId,
            metaAdName,
            metaAdsetId: sanitizeMetaField(adgroup_id || null),
            metaAdsetName,
            metaPageId: pageId || null,
            metaFormName: sanitizeMetaField(formName || null),
            metaCampaignId: sanitizeMetaField(leadValue.campaign_id || null),
            metaCampaignName,
            metaPlatform,
            metaIsOrganic: typeof leadValue.is_organic === 'boolean' ? leadValue.is_organic : null,
            metaLeadStatus: leadValue.lead_status || null,
            metaRawData: leadData || leadValue,
            anythingToKnow: additionalNotes || null,
            bookingCreatedAt: created_time ? new Date(created_time * 1000) : new Date()
          });

          await newBooking.save();
          console.log(`Meta lead saved: ${newBooking.bookingId} | ${clientName} | ${clientEmail} | ${clientPhone} | Form: ${formName}`);

          try {
            const wfResult = await triggerWorkflow(newBooking.bookingId, 'not-scheduled');
            if (wfResult.success && wfResult.triggered) {
              console.log(`Not-scheduled workflows triggered for meta lead ${newBooking.bookingId}`);
            }
          } catch (wfError) {
            console.error(`Failed to trigger workflows for meta lead ${newBooking.bookingId}:`, wfError.message);
          }
        }

        const targetBooking = existingLead || await CampaignBookingModel.findOne({ metaLeadId: leadgen_id });
        if (targetBooking) {
          try {
            await sendMetaLeadDiscordNotification({
              bookingId: targetBooking.bookingId,
              clientName: clientName || targetBooking.clientName,
              clientEmail: clientEmail || targetBooking.clientEmail,
              clientPhone: clientPhone || targetBooking.clientPhone || '',
              formName,
              jobType: extracted.jobType || '',
              leadgenId: leadgen_id,
              adId: ad_id
            });
          } catch (discordErr) {
            console.error('Failed to send Discord notification for Meta lead:', discordErr.message);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error processing Meta lead webhook:', error);
  }
};

// ---------------------------------------------------------------------------
// Discord notification
// ---------------------------------------------------------------------------

export async function sendMetaLeadDiscordNotification(leadInfo) {
  // DISCORD_META_LEADS_WEBHOOK_URL targets the meta-leads channel (same one
  // the Sheets Apps Script posts to); DISCORD_WEB_HOOK_URL is the legacy
  // fallback and points at the payments channel.
  const webhookUrl = process.env.DISCORD_META_LEADS_WEBHOOK_URL || process.env.DISCORD_WEB_HOOK_URL;
  if (!webhookUrl) return;

  // Color + title signal the outcome at a glance: green = new lead,
  // amber = repeat submission merged into an existing lead, Facebook blue
  // for legacy callers that pass no outcome.
  const isMerged = leadInfo.outcome === 'merged';
  const isCreated = leadInfo.outcome === 'created';
  const title = isMerged
    ? 'Meta Lead — Repeat Submission (merged)'
    : (isCreated ? 'New Meta Lead' : 'New Meta Lead Ad Submission');
  const color = isMerged ? 0xF59E0B : (isCreated ? 0x57F287 : 0x1877F2);

  const embed = {
    title,
    description: `**${leadInfo.clientName || 'Unknown name'}**`,
    color,
    fields: [
      { name: 'Email', value: '`' + (leadInfo.clientEmail || 'N/A') + '`', inline: true },
      { name: 'Phone', value: '`' + (leadInfo.clientPhone || 'N/A') + '`', inline: true },
      ...(leadInfo.jobType ? [{ name: 'Job Type', value: leadInfo.jobType, inline: true }] : []),
      ...(leadInfo.utmSource ? [{ name: 'Source', value: leadInfo.utmSource, inline: true }] : []),
      ...(leadInfo.utmMedium ? [{ name: 'Medium', value: leadInfo.utmMedium, inline: true }] : []),
      ...(leadInfo.utmCampaign ? [{ name: 'Campaign', value: leadInfo.utmCampaign, inline: true }] : []),
      ...(leadInfo.countryCode ? [{ name: 'Country', value: leadInfo.countryCode, inline: true }] : []),
      ...(leadInfo.market || leadInfo.landingRoute
        ? [{ name: 'Page', value: `${leadInfo.landingRoute || '/'}${leadInfo.market ? ` (${String(leadInfo.market).toUpperCase()})` : ''}`, inline: true }]
        : (leadInfo.locale ? [{ name: 'Page', value: leadInfo.locale, inline: true }] : [])),
      ...(leadInfo.leadgenId ? [{ name: 'Lead ID', value: String(leadInfo.leadgenId), inline: true }] : []),
      ...(leadInfo.outcome ? [{
        name: 'Outcome',
        value: isMerged ? 'Merged into existing lead — workflows NOT re-triggered' : 'New lead created — workflows triggered',
        inline: false
      }] : []),
    ],
    timestamp: new Date().toISOString(),
    footer: { text: `${leadInfo.formName || 'Meta Lead Ads'} • ${leadInfo.bookingId} • Flashfire CRM` }
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
    signal: AbortSignal.timeout(5000)
  });
}

// ---------------------------------------------------------------------------
// Manual test endpoint
// ---------------------------------------------------------------------------

export const createMetaLeadManually = async (req, res) => {
  try {
    const { clientName, clientEmail, clientPhone, formName, adId } = req.body;

    if (!clientName || !clientEmail) {
      return res.status(400).json({ success: false, message: 'clientName and clientEmail are required' });
    }

    const normalizedEmail = clientEmail.trim().toLowerCase();
    const normalizedPhone = normalizePhoneForMatching(clientPhone || '');

    const orConditions = [{ clientEmail: normalizedEmail }];
    if (normalizedPhone) {
      orConditions.push({ normalizedClientPhone: normalizedPhone });
      orConditions.push({ clientPhone: { $regex: normalizedPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' } });
    }
    const existingLead = await CampaignBookingModel.findOne({ $or: orConditions }).sort({ bookingCreatedAt: -1 });

    if (existingLead) {
      await CampaignBookingModel.findOneAndUpdate(
        { bookingId: existingLead.bookingId },
        { $set: { metaFormName: formName || null, metaAdId: adId || null } }
      );
      return res.status(200).json({
        success: true,
        message: 'Meta lead merged with existing lead',
        merged: true,
        booking: {
          bookingId: existingLead.bookingId,
          clientName: existingLead.clientName,
          clientEmail: existingLead.clientEmail,
          bookingStatus: existingLead.bookingStatus,
          leadSource: existingLead.leadSource
        }
      });
    }

    const newBooking = new CampaignBookingModel({
      clientName: clientName.trim(),
      clientEmail: normalizedEmail,
      clientPhone: clientPhone || null,
      utmSource: 'meta_lead_ad',
      utmMedium: 'paid',
      utmCampaign: adId ? `meta_ad_${adId}` : 'meta_lead_form',
      bookingStatus: 'not-scheduled',
      leadSource: 'meta_lead_ad',
      metaFormName: formName || null,
      metaAdId: adId || null,
      bookingCreatedAt: new Date()
    });

    await newBooking.save();

    try {
      const wfResult = await triggerWorkflow(newBooking.bookingId, 'not-scheduled');
      if (wfResult.success && wfResult.triggered) {
        console.log(`Not-scheduled workflows triggered for manual meta lead ${newBooking.bookingId}`);
      }
    } catch (wfError) {
      console.error(`Failed to trigger workflows for manual meta lead ${newBooking.bookingId}:`, wfError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Meta lead created successfully',
      booking: {
        bookingId: newBooking.bookingId,
        clientName: newBooking.clientName,
        clientEmail: newBooking.clientEmail,
        leadSource: newBooking.leadSource
      }
    });
  } catch (error) {
    console.error('Error creating Meta lead manually:', error);
    return res.status(500).json({ success: false, message: 'Failed to create Meta lead', error: error.message });
  }
};

// ---------------------------------------------------------------------------
// POST — Google Apps Script / Sheets → upsert by metaLeadId
// ---------------------------------------------------------------------------

function parseSheetCreatedTime(value) {
  if (value == null || value === '') return new Date();
  if (typeof value === 'number') {
    if (value < 1e12) return new Date(value * 1000);
    return new Date(value);
  }
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  console.warn('meta-leads-from-sheet: invalid created_time, using now', { value });
  return new Date();
}

/** Last 10 digits, numbers only (per sheet sync spec). */
function normalizedPhoneLast10(phone) {
  if (phone == null || phone === '') return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function generateBookingId() {
  return `booking_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export const upsertMetaLeadFromSheet = async (req, res) => {
  try {
    const body = req.body || {};
    const {
      id,
      created_time,
      ad_id,
      ad_name,
      form_id,
      campaign_id,
      campaign_name,
      adset_id,
      adset_name,
      form_name,
      job_type,
      email,
      full_name,
      phone,
      platform,
      is_organic,
      lead_status
    } = body;

    const metaLeadId = id != null && id !== '' ? String(id).trim() : '';
    if (!metaLeadId) {
      console.warn('meta-leads-from-sheet: missing id');
      return res.status(400).json({ success: false, message: 'id is required' });
    }

    const clientEmail = email != null ? String(email).trim().toLowerCase() : '';
    if (!clientEmail) {
      console.warn('meta-leads-from-sheet: missing email', { metaLeadId });
      return res.status(400).json({ success: false, message: 'email is required' });
    }

    const now = new Date();
    const bookingCreatedAt = parseSheetCreatedTime(created_time);
    const clientName = (full_name != null ? String(full_name).trim() : '') || 'New lead';
    const clientPhone = phone != null && String(phone).trim() !== '' ? String(phone).trim() : null;
    const normalizedClientPhone = normalizedPhoneLast10(clientPhone);

    // Meta writes a permission-error sentence into these columns when the synced FB user
    // cannot read the ad account. sanitizeMetaField turns that into null so it never
    // becomes a campaign name in the CRM. See Utils/sanitizeMetaField.js.
    const rawCampaignName = sanitizeMetaField(campaign_name);
    const resolvedCampaignName = rawCampaignName != null && String(rawCampaignName).trim() !== '' ? String(rawCampaignName).trim() : null;
    const safeAdId = sanitizeMetaField(ad_id);
    const utmCampaign = resolvedCampaignName
      || (safeAdId != null && String(safeAdId).trim() !== '' ? `meta_ad_${String(safeAdId).trim()}` : 'meta_lead_form');

    const anythingToKnow = `Job type: ${sanitizeJobType(job_type)}`;

    const metaFields = {
      metaLeadId,
      metaFormId: form_id != null ? String(form_id) : null,
      metaAdId: sanitizeMetaField(ad_id != null ? String(ad_id) : null),
      metaAdName: sanitizeMetaField(ad_name != null ? String(ad_name) : null),
      metaCampaignId: sanitizeMetaField(campaign_id != null ? String(campaign_id) : null),
      metaCampaignName: resolvedCampaignName,
      metaAdsetId: sanitizeMetaField(adset_id != null ? String(adset_id) : null),
      metaAdsetName: sanitizeMetaField(adset_name != null ? String(adset_name) : null),
      metaFormName: sanitizeMetaField(form_name != null ? String(form_name) : null),
      metaPlatform: sanitizeMetaField(platform != null ? String(platform) : null),
      metaIsOrganic: typeof is_organic === 'boolean' ? is_organic : (is_organic === 'true' ? true : (is_organic === 'false' ? false : null)),
      metaLeadStatus: lead_status != null ? String(lead_status) : null,
      metaRawData: body
    };

    // The upsert below keys on metaLeadId, but the same person may already
    // exist WITHOUT one (e.g. captured via the website meta ads form before
    // the sheet synced). Merge the meta fields into that lead instead of
    // creating a duplicate — same email/phone fallback the webhook path uses.
    const existingByMetaId = await CampaignBookingModel.findOne({ metaLeadId }).lean();
    if (!existingByMetaId) {
      const orConditions = [{ clientEmail }];
      if (normalizedClientPhone) {
        orConditions.push({ normalizedClientPhone });
        orConditions.push({ clientPhone: { $regex: normalizedClientPhone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' } });
      }
      const existingLead = await CampaignBookingModel.findOne({ $or: orConditions }).sort({ bookingCreatedAt: -1 });

      if (existingLead) {
        const mergeSet = {
          utmSource: platform != null && String(platform).trim() !== '' ? String(platform).trim() : 'meta_lead_ad',
          utmMedium: 'paid',
          utmCampaign,
          clientEmail,
          leadSource: 'meta_lead_ad',
          ...metaFields,
          updatedAt: now
        };
        if (clientPhone) {
          mergeSet.clientPhone = clientPhone;
          mergeSet.normalizedClientPhone = normalizedClientPhone || null;
        }
        if (clientName && clientName !== 'New lead') mergeSet.clientName = clientName;
        const prev = existingLead.anythingToKnow || '';
        mergeSet.anythingToKnow = prev && !prev.includes(anythingToKnow) ? `${prev}\n\n${anythingToKnow}` : (prev || anythingToKnow);

        await CampaignBookingModel.findOneAndUpdate({ bookingId: existingLead.bookingId }, { $set: mergeSet });
        console.log('meta-leads-from-sheet: merged into existing lead', {
          metaLeadId,
          bookingId: existingLead.bookingId,
          leadSource: existingLead.leadSource,
          priorStatus: existingLead.bookingStatus
        });

        try {
          await sendMetaLeadDiscordNotification({
            bookingId: existingLead.bookingId,
            clientName: mergeSet.clientName || existingLead.clientName,
            clientEmail,
            clientPhone: clientPhone || existingLead.clientPhone || '',
            formName: metaFields.metaFormName,
            jobType: sanitizeJobType(job_type),
            leadgenId: metaLeadId,
            adId: metaFields.metaAdId,
            outcome: 'merged'
          });
        } catch (discordError) {
          console.error('meta-leads-from-sheet: discord notify failed', discordError.message);
        }

        let workflowResult = null;
        try {
          workflowResult = await triggerWorkflow(existingLead.bookingId, 'not-scheduled');
          if (workflowResult.success && workflowResult.triggered) {
            console.log(`meta-leads-from-sheet: workflows re-triggered for returning lead ${existingLead.bookingId} (status: ${existingLead.bookingStatus})`);
          }
        } catch (wfError) {
          console.error(`meta-leads-from-sheet: workflow re-trigger failed for ${existingLead.bookingId}:`, wfError.message);
        }

        return res.status(200).json({
          success: true,
          isNewLead: false,
          merged: true,
          workflowTriggered: workflowResult?.triggered || false
        });
      }
    }

    const filter = { metaLeadId };

    const $set = {
      utmSource: platform != null && String(platform).trim() !== '' ? String(platform).trim() : 'meta_lead_ad',
      utmMedium: 'paid',
      utmCampaign,
      clientName,
      clientEmail,
      clientPhone,
      normalizedClientPhone,
      bookingCreatedAt,
      leadSource: 'meta_lead_ad',
      ...metaFields,
      anythingToKnow,
      updatedAt: now
    };

    const result = await CampaignBookingModel.updateOne(
      filter,
      {
        $set,
        $setOnInsert: {
          bookingId: generateBookingId(),
          bookingStatus: 'not-scheduled',
          createdAt: now
        }
      },
      { upsert: true, runValidators: true }
    );

    const isNewLead = result.upsertedCount > 0;

    console.log('meta-leads-from-sheet: upsert ok', {
      metaLeadId,
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upserted: result.upsertedCount
    });

    // Trigger not-scheduled workflows for NEW leads only
    let workflowResult = null;
    if (isNewLead) {
      try {
        const inserted = await CampaignBookingModel.findOne({ metaLeadId }).lean();
        if (inserted && inserted.bookingId) {
          workflowResult = await triggerWorkflow(inserted.bookingId, 'not-scheduled');
          if (workflowResult.success && workflowResult.triggered) {
            console.log(`meta-leads-from-sheet: workflows triggered for ${inserted.bookingId}`);
          } else {
            console.log(`meta-leads-from-sheet: no workflows triggered for ${inserted.bookingId}`, workflowResult.message || '');
          }
        }
      } catch (wfError) {
        console.error(`meta-leads-from-sheet: workflow trigger failed for metaLeadId=${metaLeadId}:`, wfError.message);
        // Don't fail the response — lead is already saved
      }
    }

    return res.status(200).json({
      success: true,
      isNewLead,
      workflowTriggered: workflowResult?.triggered || false
    });
  } catch (error) {
    console.error('meta-leads-from-sheet:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to upsert Meta lead from sheet',
      error: error.message
    });
  }
};

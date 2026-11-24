/**
 * Auto onboarding on payment. Two sources, one idempotent sink:
 *   1. CRM: a lead marked paid (bookingStatus 'paid' with a plan)
 *   2. Any completed payment (PayPal or Stripe) stored in the payments collection
 * Both are sent to the clients-tracking backend (POST /api/internal/auto-onboard), which creates the
 * dashboard user, assigns CSM and dashboard manager by round robin, and skips clients that already exist.
 *
 * Polling instead of hooking each payment path: BDA, admin, microservice, PayPal and Stripe all end
 * as a row in one of two collections, so one sweep covers every path and a missed call is retried.
 * Only rows newer than AUTO_ONBOARD_SINCE are looked at, so old clients are never re-created.
 */
import axios from 'axios';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { PaymentModel } from '../Schema_Models/Payment.js';
import { DiscordConnect } from './DiscordConnect.js';

export const AUTO_ONBOARD_SINCE = new Date('2026-11-25T00:00:00+05:30');
const CLIENTS_TRACKING_URL = 'https://clients-tracking-backend-580t.onrender.com';
const USD_PLAN_PRICES = { 99: 'PRIME', 199: 'IGNITE', 349: 'PROFESSIONAL', 599: 'EXECUTIVE' };
const BATCH = 25;

/** @returns {'PRIME'|'IGNITE'|'PROFESSIONAL'|'EXECUTIVE'|null} */
export function planFromText(text) {
  const m = /\b(prime|ignite|professional|executive)\b/i.exec(String(text || ''));
  return m ? m[1].toUpperCase() : null;
}

/** USD list price to plan. Anything else returns null: a wrong plan sets the wrong cap, so never guess. */
export function planFromAmount(amount, currency = 'USD') {
  if (String(currency || 'USD').toUpperCase() !== 'USD') return null;
  return USD_PLAN_PRICES[Number(amount)] || null;
}

/** @returns {{email: string, name: string, planType: string|null, amountPaid: number, currency: string, source: string}} */
export function inputFromBooking(b) {
  return {
    email: String(b.clientEmail || '').trim().toLowerCase(),
    name: String(b.clientName || '').trim(),
    planType: b.paymentPlan?.name || null,
    amountPaid: b.paymentPlan?.price ?? 0,
    currency: b.paymentPlan?.currency || 'USD',
    source: 'crm-paid',
  };
}

/** @returns {{email: string, name: string, planType: string|null, amountPaid: number, currency: string, source: string}} */
export function inputFromPayment(p) {
  const planType = planFromText(p.planName) || planFromText(p.planSubtitle) || planFromAmount(p.amount, p.currency);
  return {
    email: String(p.customerEmail || '').trim().toLowerCase(),
    name: [p.customerFirstName, p.customerLastName].filter(Boolean).join(' ').trim(),
    planType,
    amountPaid: p.amount ?? 0,
    currency: p.currency || 'USD',
    source: 'payment',
  };
}

/** Sends one client to clients-tracking. Never throws. */
export async function triggerAutoOnboard(input, { secret = process.env.AUTO_ONBOARD_SECRET, url = process.env.CLIENTS_TRACKING_URL || CLIENTS_TRACKING_URL, http = axios } = {}) {
  if (!secret) return { transient: true, error: 'AUTO_ONBOARD_SECRET not set' };
  try {
    const r = await http.post(`${url.replace(/\/$/, '')}/api/internal/auto-onboard`, input, {
      headers: { 'x-cron-secret': secret },
      timeout: 60_000,
      validateStatus: () => true,
    });
    const body = r.data || {};
    // 200 created/exists, 400 invalid, 422 bad plan are final. 401, 503, 5xx and network errors are retried next run.
    if ([200, 400, 422].includes(r.status)) return { status: body.status || (r.status === 200 ? 'created' : 'invalid'), error: body.error || '', clientNumber: body.clientNumber ?? null };
    return { transient: true, error: `HTTP ${r.status}` };
  } catch (e) {
    return { transient: true, error: String(e?.message || e).slice(0, 200) };
  }
}

let running = false;

/**
 * One pass over both sources. Final outcomes are stamped on the row so it is never sent twice.
 * @param {{trigger?: Function, now?: Date, alert?: (msg: string) => Promise<unknown>, logger?: Console,
 *   Booking?: object, Payment?: object}} [deps]
 */
export async function runAutoOnboardSweep(deps = {}) {
  const trigger = deps.trigger || triggerAutoOnboard;
  const Booking = deps.Booking || CampaignBookingModel;
  const Payment = deps.Payment || PaymentModel;
  const logger = deps.logger || console;
  const alert = deps.alert || ((msg) => DiscordConnect(process.env.DISCORD_MAIN_WEBHOOK_URL, msg, false).catch(() => {}));
  const now = deps.now || new Date();
  const stats = { checked: 0, created: 0, exists: 0, rejected: 0, retry: 0 };

  if (running) return { ...stats, skipped: 'busy' };
  running = true;
  try {
    const sources = [
      {
        label: 'CRM paid',
        Model: Booking,
        filter: { bookingStatus: 'paid', 'paymentPlan.name': { $ne: null }, 'paymentPlan.selectedAt': { $gte: AUTO_ONBOARD_SINCE }, autoOnboardedAt: null },
        build: inputFromBooking,
      },
      {
        label: 'payment',
        Model: Payment,
        filter: { paymentStatus: 'completed', paymentDate: { $gte: AUTO_ONBOARD_SINCE }, autoOnboardedAt: null },
        build: inputFromPayment,
      },
    ];

    for (const src of sources) {
      const rows = await src.Model.find(src.filter).sort({ _id: 1 }).limit(BATCH).lean();
      for (const row of rows) {
        stats.checked++;
        const input = src.build(row);
        const out = input.email && input.name && input.planType
          ? await trigger(input)
          : { status: input.planType ? 'invalid' : 'bad_plan', error: !input.planType ? 'plan could not be determined' : 'missing email or name' };

        if (out.transient) {
          stats.retry++;
          logger.warn(`[auto-onboard] ${src.label} ${input.email}: will retry (${out.error})`);
          continue;
        }
        await src.Model.updateOne({ _id: row._id }, { $set: { autoOnboardedAt: now, autoOnboardResult: out.status } });
        if (out.status === 'created') stats.created++;
        else if (out.status === 'exists') stats.exists++;
        else {
          stats.rejected++;
          await alert(`⚠️ **Auto onboarding skipped** (${src.label}): ${input.email || 'no email'} plan=${input.planType || 'unknown'} reason=${out.status} ${out.error || ''}. Create this client by hand.`);
        }
      }
    }
    if (stats.checked) logger.log(`[auto-onboard] sweep ${JSON.stringify(stats)}`);
    return stats;
  } finally {
    running = false;
  }
}

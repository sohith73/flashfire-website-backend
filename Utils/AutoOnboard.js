/**
 * Paid notice. Two sources, one idempotent sink:
 *   1. CRM: a lead marked paid (bookingStatus 'paid' with a plan), by a BDA or an admin
 *   2. Any completed payment (PayPal or Stripe) stored in the payments collection, plus Stripe checkouts straight from the webhook
 * Each is sent to the clients-tracking backend (POST /api/internal/paid-notice). That creates NO dashboard user:
 * it posts "create the dashboard for X" in the client's private Discord channel, tagging the dashboard people,
 * once per email, and skips clients who already have a dashboard.
 *
 * Real time: the places that mark a lead paid or store a payment call kickAutoOnboard(), which runs the
 * sweep within about a second. Stripe leaves no row of its own, so its webhook calls onboardFromStripe()
 * directly. The 5 minute cron sweep stays as the fallback for anything a kick missed.
 * Only rows newer than AUTO_ONBOARD_SINCE are looked at, so old clients are never announced.
 * (File and field names keep "autoOnboard" so rows already stamped are not announced twice.)
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

const CURRENCY_COUNTRY = { USD: 'USA', CAD: 'Canada', GBP: 'UK', AUD: 'Australia', EUR: 'Europe' };

/** A client with no name on the payment is still announced, by the part of the email before the @. */
const nameOrEmail = (name, email) => String(name || '').trim() || String(email || '').split('@')[0];

/** Country for the channel name, from the payment currency. Empty (not guessed) for any other currency. */
export function countryFromCurrency(currency) {
  return CURRENCY_COUNTRY[String(currency || '').toUpperCase()] || '';
}

/** @returns {{email: string, name: string, planType: string|null, amountPaid: number, currency: string, country: string, source: string}} */
export function inputFromBooking(b) {
  return {
    email: String(b.clientEmail || '').trim().toLowerCase(),
    name: nameOrEmail(b.clientName, String(b.clientEmail || '').trim().toLowerCase()),
    planType: b.paymentPlan?.name || null,
    amountPaid: b.paymentPlan?.price ?? 0,
    currency: b.paymentPlan?.currency || 'USD',
    country: countryFromCurrency(b.paymentPlan?.currency || 'USD'),
    source: 'crm-paid',
  };
}

/** @returns {{email: string, name: string, planType: string|null, amountPaid: number, currency: string, country: string, source: string}} */
export function inputFromPayment(p) {
  const planType = planFromText(p.planName) || planFromText(p.planSubtitle) || planFromAmount(p.amount, p.currency);
  return {
    email: String(p.customerEmail || '').trim().toLowerCase(),
    name: nameOrEmail([p.customerFirstName, p.customerLastName].filter(Boolean).join(' '), String(p.customerEmail || '').trim().toLowerCase()),
    planType,
    amountPaid: p.amount ?? 0,
    currency: p.currency || 'USD',
    country: countryFromCurrency(p.currency || 'USD'),
    source: 'payment',
  };
}

/** Sends one client to clients-tracking. Never throws. */
export async function triggerAutoOnboard(input, { secret = process.env.AUTO_ONBOARD_SECRET, url = process.env.CLIENTS_TRACKING_URL || CLIENTS_TRACKING_URL, http = axios } = {}) {
  if (!secret) return { transient: true, error: 'AUTO_ONBOARD_SECRET not set' };
  try {
    const r = await http.post(`${url.replace(/\/$/, '')}/api/internal/paid-notice`, input, {
      headers: { 'x-cron-secret': secret },
      timeout: 60_000,
      validateStatus: () => true,
    });
    const body = r.data || {};
    // 200 notified/exists and 400 invalid are final. 401, 503 (bot off, no Pranjal ids, Discord down), 5xx and network errors are retried.
    if ([200, 400].includes(r.status)) return { status: body.status || (r.status === 200 ? 'notified' : 'invalid'), error: body.error || '' };
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
  const stats = { checked: 0, notified: 0, exists: 0, rejected: 0, retry: 0 };

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
        const out = input.email ? await trigger(input) : { status: 'invalid', error: 'no email on the payment' };

        if (out.transient) {
          stats.retry++;
          logger.warn(`[auto-onboard] ${src.label} ${input.email}: will retry (${out.error})`);
          continue;
        }
        await src.Model.updateOne({ _id: row._id }, { $set: { autoOnboardedAt: now, autoOnboardResult: out.status } });
        if (out.status === 'notified') stats.notified++;
        else if (out.status === 'exists') stats.exists++;
        else {
          stats.rejected++;
          await alert(`⚠️ **Paid notice skipped** (${src.label}): ${input.email || 'no email'} reason=${out.status} ${out.error || ''}. Tell the dashboard team by hand.`);
        }
      }
    }
    if (stats.checked) logger.log(`[auto-onboard] sweep ${JSON.stringify(stats)}`);
    return stats;
  } finally {
    running = false;
  }
}

const KICK_DELAY_MS = 1500;
const KICK_RETRY_MS = 3000;
const KICK_MAX_RETRIES = 10;
let kickTimer = null;

/**
 * Run the sweep right away (after a short delay that merges a burst into one run). Never throws.
 * If a sweep is already running, try again shortly so a payment that lands mid-run is not left for the cron.
 * @param {{delayMs?: number, retryMs?: number, run?: Function}} [opts]
 */
export function kickAutoOnboard(opts = {}) {
  if (kickTimer) return;
  const run = opts.run || runAutoOnboardSweep;
  const retryMs = opts.retryMs ?? KICK_RETRY_MS;
  let tries = 0;
  const fire = async () => {
    kickTimer = null;
    try {
      const out = await run();
      if (out?.skipped === 'busy' && tries++ < KICK_MAX_RETRIES) {
        kickTimer = setTimeout(fire, retryMs);
        kickTimer.unref?.();
      }
    } catch (e) {
      console.error('[auto-onboard] kick failed:', String(e?.message || e).slice(0, 200));
    }
  };
  kickTimer = setTimeout(fire, opts.delayMs ?? KICK_DELAY_MS);
  kickTimer.unref?.();
}

/** @returns {{email: string, name: string, planType: string|null, amountPaid: number, currency: string, source: string}} */
export function inputFromStripe(f) {
  return {
    email: String(f.email || '').trim().toLowerCase(),
    name: nameOrEmail(f.name, String(f.email || '').trim().toLowerCase()),
    planType: planFromText(f.planName) || planFromText(f.planSubtitle) || planFromAmount(f.amount, f.currency),
    amountPaid: f.amount ?? 0,
    currency: f.currency || 'USD',
    country: countryFromCurrency(f.currency || 'USD'),
    source: 'stripe',
  };
}

const STRIPE_RETRY_DELAYS_MS = [0, 20_000, 60_000, 180_000];

/**
 * Stripe payment straight from the webhook (no payments row exists for the poller to find).
 * Retries a transient failure a few times (a sleeping clients-tracking instance wakes up), and alerts a
 * human if it still fails. Never throws.
 * @param {{email: string, name: string, planName?: string, planSubtitle?: string, amount?: number, currency?: string, createdAt?: Date}} fields
 * @param {{trigger?: Function, alert?: Function, sleep?: Function, delays?: number[], logger?: Console}} [deps]
 */
export async function onboardFromStripe(fields, deps = {}) {
  const trigger = deps.trigger || triggerAutoOnboard;
  const logger = deps.logger || console;
  const alert = deps.alert || ((msg) => DiscordConnect(process.env.DISCORD_MAIN_WEBHOOK_URL, msg, false).catch(() => {}));
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const delays = deps.delays || STRIPE_RETRY_DELAYS_MS;
  try {
    if ((fields.createdAt || new Date()) < AUTO_ONBOARD_SINCE) return { status: 'skipped_old' };
    const input = inputFromStripe(fields);
    if (!input.email) return { status: 'invalid', error: 'no email on the payment' };
    let out = { transient: true, error: 'not tried' };
    for (const wait of delays) {
      if (wait) await sleep(wait);
      out = await trigger(input);
      if (!out.transient) break;
      logger.warn(`[auto-onboard] stripe ${input.email}: retrying (${out.error})`);
    }
    if (out.transient) {
      await alert(`⚠️ **Paid notice failed** (stripe): ${input.email} paid but clients-tracking did not answer (${out.error}). Tell the dashboard team by hand.`);
      return { status: 'failed', error: out.error };
    }
    if (!['notified', 'exists'].includes(out.status)) {
      await alert(`⚠️ **Paid notice skipped** (stripe): ${input.email} reason=${out.status} ${out.error || ''}. Tell the dashboard team by hand.`);
    }
    logger.log(`[auto-onboard] stripe ${input.email}: ${out.status}`);
    return out;
  } catch (e) {
    logger.error('[auto-onboard] stripe handler error:', String(e?.message || e).slice(0, 200));
    return { status: 'failed', error: 'handler error' };
  }
}

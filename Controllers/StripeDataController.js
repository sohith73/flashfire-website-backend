import Stripe from "stripe";
import { ManualPaymentModel } from "../Schema_Models/ManualPaymentModel.js";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

// Same plan-name classification as the Stripe Data tab's Plan Breakdown
// (src/components/StripeDataView.tsx PLAN_BUCKETS) — kept in lockstep so the
// two views never disagree on what counts as a "real" plan.
const isAddonOrUpgrade = (planName) => {
  const p = (planName || "").toLowerCase();
  return p.includes("add-on") || p.includes("add on") || p.includes("upgrade");
};

// Simple in-memory cache for checkout-session line-item lookups, since each
// charge needs 2 extra API calls (session lookup + line items) to get the
// plan name, and that data never changes once a charge has settled.
const lineItemCache = new Map();

async function getPlanNameForCharge(charge) {
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) return "";
  if (lineItemCache.has(paymentIntentId)) return lineItemCache.get(paymentIntentId);

  try {
    const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
    const session = sessions.data[0];
    if (!session) {
      lineItemCache.set(paymentIntentId, "");
      return "";
    }
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
    const planName = lineItems.data[0]?.description || "";
    lineItemCache.set(paymentIntentId, planName);
    return planName;
  } catch (err) {
    lineItemCache.set(paymentIntentId, "");
    return "";
  }
}

/**
 * Month-wise Stripe payments for the "Stripe Data" CRM tab.
 * Returns only succeeded charges, enriched with the Checkout line-item
 * plan name (e.g. "Professional Plan – Mid-Level Professionals").
 * Query params: month=YYYY-MM (required)
 */
/**
 * All-months summary for the Stripe Revenue chart in Graph 02.
 * Returns one entry per month that has at least one succeeded charge,
 * with USD, CAD and EUR totals.
 */
export const getStripeAllMonthsSummary = async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ success: false, error: "Stripe not configured." });
    }

    // Fetch all succeeded charges (paginated)
    let charges = [];
    let startingAfter;
    while (true) {
      const page = await stripe.charges.list({ limit: 100, starting_after: startingAfter });
      const succeeded = page.data.filter((c) => c.status === "succeeded");
      charges = charges.concat(succeeded);
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    // Group by YYYY-MM
    const byMonth = {};
    for (const c of charges) {
      const d = new Date(c.created * 1000);
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      if (!byMonth[ym]) byMonth[ym] = { usd: 0, cad: 0, eur: 0, count: 0 };
      const currency = c.currency.toUpperCase();
      const amount = c.amount / 100;
      if (currency === "USD") byMonth[ym].usd += amount;
      else if (currency === "CAD") byMonth[ym].cad += amount;
      else if (currency === "EUR") byMonth[ym].eur += amount;
      byMonth[ym].count += 1;
    }

    const months = Object.keys(byMonth).sort();
    const rows = months.map((m) => ({ month: m, ...byMonth[m] }));

    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error fetching Stripe all-months summary:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch summary" });
  }
};

/**
 * All-months "real plan" paid-client count for Graph 03's Completed — Monthly chart.
 * Same universe as the Stripe Data tab's Plan Breakdown (Stripe succeeded charges +
 * manual payments, classified by plan name) but summed across all plan tiers and
 * EXCLUDING Add-on / Upgrade line items — those are extras on an existing plan, not
 * a new paying client, so they'd inflate this count past what "Paid" should mean here.
 */
export const getStripePaidPlanMonthlySummary = async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ success: false, error: "Stripe not configured." });
    }

    let charges = [];
    let startingAfter;
    while (true) {
      const page = await stripe.charges.list({ limit: 100, starting_after: startingAfter });
      const succeeded = page.data.filter((c) => c.status === "succeeded");
      charges = charges.concat(succeeded);
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    const planNames = await Promise.all(charges.map((c) => getPlanNameForCharge(c)));

    const byMonth = {};
    charges.forEach((c, i) => {
      if (isAddonOrUpgrade(planNames[i])) return;
      const d = new Date(c.created * 1000);
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      byMonth[ym] = (byMonth[ym] || 0) + 1;
    });

    const manualDocs = await ManualPaymentModel.find({});
    for (const m of manualDocs) {
      if (isAddonOrUpgrade(m.planName)) continue;
      const d = new Date(m.date);
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      byMonth[ym] = (byMonth[ym] || 0) + 1;
    }

    const months = Object.keys(byMonth).sort();
    const rows = months.map((m) => ({ month: m, paidCount: byMonth[m] }));

    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error fetching Stripe paid-plan monthly summary:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch summary" });
  }
};

export const getStripePaymentsByMonth = async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({
        success: false,
        error: "Stripe not configured. Set STRIPE_SECRET_KEY in the backend .env.",
      });
    }

    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: "month query param required, format YYYY-MM" });
    }

    const [year, mon] = month.split("-").map(Number);
    const start = Math.floor(Date.UTC(year, mon - 1, 1) / 1000);
    const end = Math.floor(Date.UTC(year, mon, 1) / 1000);

    let charges = [];
    let startingAfter;
    // Paginate through all charges in the range (Stripe caps list results at 100/page).
    while (true) {
      const page = await stripe.charges.list({
        created: { gte: start, lt: end },
        limit: 100,
        starting_after: startingAfter,
      });
      charges = charges.concat(page.data);
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    const succeeded = charges.filter((c) => c.status === "succeeded");

    const rows = await Promise.all(
      succeeded.map(async (c) => ({
        id: c.id,
        date: new Date(c.created * 1000).toISOString(),
        amount: c.amount / 100,
        currency: c.currency.toUpperCase(),
        email: c.billing_details?.email || c.receipt_email || "",
        name: c.billing_details?.name || "",
        cardBrand: c.payment_method_details?.card?.brand || "",
        cardLast4: c.payment_method_details?.card?.last4 || "",
        planName: await getPlanNameForCharge(c),
      }))
    );

    rows.sort((a, b) => new Date(a.date) - new Date(b.date));

    const totalsByCurrency = {};
    for (const r of rows) {
      totalsByCurrency[r.currency] = (totalsByCurrency[r.currency] || 0) + r.amount;
    }

    return res.status(200).json({
      success: true,
      data: { month, rows, totalsByCurrency, count: rows.length },
    });
  } catch (error) {
    console.error("Error fetching Stripe payments by month:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch Stripe payments",
    });
  }
};

const PAID_PAYMENTS_TTL_MS = 10 * 60 * 1000;
const PLAN_LOOKUP_BATCH = 10;
let paidPaymentsCache = { at: 0, rows: null };

/**
 * Every real-plan payment (Stripe succeeded charges + manual payments), add-ons and
 * upgrades excluded — the same universe as getStripePaidPlanMonthlySummary. Cached for
 * a few minutes since a cold load makes 2 Stripe calls per charge for the plan name.
 * Rows: { email, date, amount, currency, planName, source }.
 */
export async function getPaidPlanPayments() {
  if (paidPaymentsCache.rows && Date.now() - paidPaymentsCache.at < PAID_PAYMENTS_TTL_MS) {
    return paidPaymentsCache.rows;
  }
  if (!stripe) throw new Error("Stripe not configured.");

  let charges = [];
  let startingAfter;
  while (true) {
    const page = await stripe.charges.list({ limit: 100, starting_after: startingAfter });
    charges = charges.concat(page.data.filter((c) => c.status === "succeeded"));
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  const planNames = [];
  for (let i = 0; i < charges.length; i += PLAN_LOOKUP_BATCH) {
    const batch = charges.slice(i, i + PLAN_LOOKUP_BATCH);
    planNames.push(...(await Promise.all(batch.map((c) => getPlanNameForCharge(c)))));
  }

  const rows = [];
  charges.forEach((c, i) => {
    if (isAddonOrUpgrade(planNames[i])) return;
    rows.push({
      email: String(c.billing_details?.email || c.receipt_email || "").trim().toLowerCase(),
      date: new Date(c.created * 1000),
      amount: c.amount / 100,
      currency: c.currency.toUpperCase(),
      planName: planNames[i],
      source: "stripe",
    });
  });

  const manualDocs = await ManualPaymentModel.find({}).lean();
  for (const m of manualDocs) {
    if (isAddonOrUpgrade(m.planName)) continue;
    rows.push({
      email: String(m.customerEmail || "").trim().toLowerCase(),
      date: new Date(m.date),
      amount: m.amount,
      currency: String(m.currency || "").toUpperCase(),
      planName: m.planName,
      source: "manual",
    });
  }

  paidPaymentsCache = { at: Date.now(), rows };
  return rows;
}

import Stripe from "stripe";
import { PaymentModel } from "../Schema_Models/Payment.js";
import { sendPaymentConfirmationEmail } from "../Utils/PaymentEmailHelper.js";
import { DiscordConnect } from "../Utils/DiscordConnect.js";
import { onboardFromStripe } from "../Utils/AutoOnboard.js";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const STRIPE_FALLBACK_PLAN_NAME = process.env.STRIPE_FALLBACK_PLAN_NAME || "FlashFire Plan";
const STRIPE_INVOICE_DEDUPE_TTL_MS = Number(process.env.STRIPE_INVOICE_DEDUPE_TTL_MS || 7 * 24 * 60 * 60 * 1000);

const STRIPE_DISCORD_WEBHOOK =
  process.env.DISCORD_STRIPE_WEBHOOK_URL ||
  process.env.DISCORD_WEB_HOOK_URL ||
  null;

const processedEventCache = new Map();
const sentInvoiceCache = new Map();

function formatAmountFromStripe(amountInCents, currency = "usd") {
  return Number((Number(amountInCents || 0) / 100).toFixed(2));
}

function cleanupExpiredCacheEntries(cacheMap, ttlMs) {
  const now = Date.now();
  for (const [key, value] of cacheMap.entries()) {
    if (now - value > ttlMs) {
      cacheMap.delete(key);
    }
  }
}

function markAndCheckDuplicate(cacheMap, key, ttlMs) {
  if (!key) return false;
  cleanupExpiredCacheEntries(cacheMap, ttlMs);
  const seenAt = cacheMap.get(key);
  if (seenAt && Date.now() - seenAt <= ttlMs) {
    return true;
  }
  cacheMap.set(key, Date.now());
  return false;
}

function safeSlice(value, limit = 40) {
  return String(value || "").slice(0, limit);
}

function buildInvoiceNumber(...values) {
  const picked = values.find(Boolean);
  const cleaned = String(picked || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "");
  return `INV-${cleaned.slice(-20)}`;
}

function parseName(name, fallbackEmail = "") {
  const cleaned = String(name || "").trim();
  if (!cleaned) {
    const fallback = String(fallbackEmail || "").split("@")[0] || "Customer";
    return { firstName: fallback, lastName: "Client" };
  }

  const [firstName = "Customer", ...rest] = cleaned.split(/\s+/);
  return { firstName, lastName: rest.join(" ") || "Client" };
}

async function sendStripeDiscordSummary(messageLines) {
  if (!STRIPE_DISCORD_WEBHOOK) {
    console.warn("⚠️ DISCORD_STRIPE_WEBHOOK_URL not set — skipping Stripe Discord notification");
    return;
  }

  try {
    await DiscordConnect(STRIPE_DISCORD_WEBHOOK, messageLines.join("\n"), false);
  } catch (error) {
    console.error("❌ Failed to send Stripe Discord notification:", error.message);
  }
}

async function resolvePaymentFromDb({ candidateTransactionIds = [], customerEmail = null }) {
  for (const transactionId of candidateTransactionIds.filter(Boolean)) {
    const byTransactionId = await PaymentModel.findOne({ paypalOrderId: transactionId });
    if (byTransactionId) return byTransactionId;
  }

  if (customerEmail) {
    const recentByEmail = await PaymentModel.findOne({
      customerEmail: customerEmail.toLowerCase(),
      paymentStatus: "completed",
    }).sort({ paymentDate: -1 });
    if (recentByEmail) return recentByEmail;
  }

  return null;
}

function buildEmailPayloadFallback(normalized) {
  const {
    customerEmail,
    customerName,
    amount,
    currency,
    planName,
    planSubtitle,
    transactionId,
    invoiceId,
    paymentDate,
    stripeReceiptPdfUrl,
  } = normalized;
  const { firstName, lastName } = parseName(customerName, customerEmail);

  return {
    customerEmail,
    customerFirstName: firstName,
    customerLastName: lastName,
    amount,
    currency: (currency || "USD").toUpperCase(),
    planName: planName || STRIPE_FALLBACK_PLAN_NAME,
    planSubtitle: planSubtitle || "",
    transactionId,
    transactionProvider: "Stripe",
    invoiceNumber: buildInvoiceNumber(invoiceId, transactionId),
    paymentDate: paymentDate || new Date(),
    includePdfInvoice: false,
    stripeReceiptPdfUrl: stripeReceiptPdfUrl || null,
  };
}

async function sendInvoiceEmailForStripe(normalized, event) {
  const {
    sourceType,
    customerEmail = null,
    customerName = "",
    amount = 0,
    currency = "USD",
    planName = "",
    planSubtitle = "",
    transactionId = "",
    invoiceId = "",
    paymentDate = new Date(),
    metadata = {},
    candidateTransactionIds = [],
    stripeReceiptPdfUrl = null,
  } = normalized;

  if (!customerEmail) {
    await sendStripeDiscordSummary([
      "⚠️ **Stripe Payment Received (email skipped)**",
      "────────────────────────────────",
      `📦 **Source:** ${sourceType}`,
      `🔖 **Event:** ${event.type}`,
      "📧 **Email:** missing",
      `🔖 **Transaction:** ${transactionId || "N/A"}`,
    ]);
    return;
  }

  const dedupeKey = [
    "stripe-email",
    sourceType || "payment",
    transactionId || "",
    invoiceId || "",
    customerEmail.toLowerCase(),
    Number(amount || 0).toFixed(2),
    String(currency || "USD").toUpperCase(),
  ].join("|");

  if (markAndCheckDuplicate(sentInvoiceCache, dedupeKey, STRIPE_INVOICE_DEDUPE_TTL_MS)) {
    console.log("ℹ️ Stripe duplicate email skipped:", dedupeKey);
    return;
  }

  const paymentRecord = await resolvePaymentFromDb({
    candidateTransactionIds: [...candidateTransactionIds, transactionId, invoiceId],
    customerEmail,
  });

  let emailPayload = null;
  if (paymentRecord) {
    emailPayload = {
      customerEmail: paymentRecord.customerEmail,
      customerFirstName: paymentRecord.customerFirstName,
      customerLastName: paymentRecord.customerLastName,
      amount: paymentRecord.amount,
      currency: paymentRecord.currency,
      planName: paymentRecord.planName,
      planSubtitle: paymentRecord.planSubtitle,
      transactionId: transactionId || invoiceId || candidateTransactionIds.find(Boolean),
      transactionProvider: "Stripe",
      invoiceNumber: buildInvoiceNumber(invoiceId, transactionId, event.id),
      paymentDate: paymentRecord.paymentDate || paymentDate || new Date(),
      includePdfInvoice: false,
      stripeReceiptPdfUrl,
    };
  } else {
    emailPayload = buildEmailPayloadFallback({
      customerEmail,
      customerName,
      amount,
      currency,
      planName,
      planSubtitle,
      transactionId,
      invoiceId,
      paymentDate,
      stripeReceiptPdfUrl,
    });
  }

  const emailResult = await sendPaymentConfirmationEmail(emailPayload);
  await sendStripeDiscordSummary([
    "✅ **Stripe Payment Webhook Processed**",
    "────────────────────────────────",
    `📦 **Source:** ${sourceType}`,
    `📧 **Email:** ${customerEmail}`,
    `💵 **Amount:** ${String(currency || "USD").toUpperCase()} ${Number(amount || 0).toFixed(2)}`,
    `📦 **Plan/Item:** ${planName || STRIPE_FALLBACK_PLAN_NAME}${planSubtitle ? ` - ${planSubtitle}` : ""}`,
    `🔖 **Transaction:** ${transactionId || "N/A"}`,
    `🧾 **Invoice:** ${invoiceId || emailPayload.invoiceNumber || "N/A"}`,
    `📧 **Invoice Email:** ${emailResult.success ? "Sent with PDF ✅" : `Failed ❌ (${emailResult.error || "unknown"})`}`,
    ...(metadata && Object.keys(metadata).length
      ? [`🏷️ **Metadata:** ${safeSlice(JSON.stringify(metadata), 400)}`]
      : []),
    `🕐 **Time (IST):** ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ]);
}

async function markRefundInDb(candidateTransactionIds = [], customerEmail = "") {
  for (const tx of candidateTransactionIds.filter(Boolean)) {
    const updated = await PaymentModel.findOneAndUpdate(
      { paypalOrderId: tx },
      { paymentStatus: "refunded" },
      { new: true }
    );
    if (updated) return updated;
  }

  if (customerEmail) {
    return PaymentModel.findOneAndUpdate(
      { customerEmail: customerEmail.toLowerCase(), paymentStatus: "completed" },
      { paymentStatus: "refunded" },
      { sort: { paymentDate: -1 }, new: true }
    );
  }

  return null;
}

async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object;
  if (!session || session.payment_status !== "paid") return;

  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const invoiceId = typeof session.invoice === "string" ? session.invoice : session.invoice?.id;
  const customerEmail = session.customer_details?.email || session.customer_email || null;
  const customerName = session.customer_details?.name || "";
  const currency = (session.currency || "usd").toUpperCase();
  const amount = formatAmountFromStripe(session.amount_total, currency);
  let planName = session.metadata?.planName || "";
  let planSubtitle = session.metadata?.planSubtitle || "";

  if (stripe && session.id) {
    try {
      const lineItemsResponse = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
      const topLineItem = lineItemsResponse?.data?.[0];
      if (topLineItem?.description) planName = topLineItem.description;
    } catch (error) {
      console.warn("⚠️ Could not fetch checkout line items:", error.message);
    }
  }

  await sendInvoiceEmailForStripe(
    {
      sourceType: "checkout.session.completed",
      customerEmail,
      customerName,
      amount,
      currency,
      planName,
      planSubtitle,
      transactionId: paymentIntentId || session.id,
      invoiceId,
      paymentDate: new Date(),
      metadata: session.metadata || {},
      candidateTransactionIds: [paymentIntentId, session.id, invoiceId],
    },
    event
  );

  // A paid checkout: tell the dashboard team on Discord (once per email, creates no dashboard). Not awaited: the webhook answers at once.
  void onboardFromStripe({ email: customerEmail, name: customerName, planName, planSubtitle, amount, currency, createdAt: new Date((event.created || Date.now() / 1000) * 1000) });
}

async function handleCheckoutAsyncPaymentSucceeded(event) {
  const session = event.data.object;
  if (!session) return;

  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const customerEmail = session.customer_details?.email || session.customer_email || null;
  const customerName = session.customer_details?.name || "";
  const currency = (session.currency || "usd").toUpperCase();
  const amount = formatAmountFromStripe(session.amount_total, currency);

  await sendInvoiceEmailForStripe(
    {
      sourceType: "checkout.session.async_payment_succeeded",
      customerEmail,
      customerName,
      amount,
      currency,
      planName: session.metadata?.planName || STRIPE_FALLBACK_PLAN_NAME,
      planSubtitle: session.metadata?.planSubtitle || "",
      transactionId: paymentIntentId || session.id,
      invoiceId: typeof session.invoice === "string" ? session.invoice : "",
      paymentDate: new Date(),
      metadata: session.metadata || {},
      candidateTransactionIds: [paymentIntentId, session.id],
    },
    event
  );

  void onboardFromStripe({ email: customerEmail, name: customerName, planName: session.metadata?.planName, planSubtitle: session.metadata?.planSubtitle, amount, currency, createdAt: new Date((event.created || Date.now() / 1000) * 1000) });
}

async function handleInvoicePaid(event) {
  const invoice = event.data.object;
  if (!invoice || !invoice.paid) return;

  const customerEmail = invoice.customer_email || null;
  const customerName = invoice.customer_name || "";
  const currency = (invoice.currency || "usd").toUpperCase();
  const amount = formatAmountFromStripe(invoice.amount_paid || invoice.total, currency);
  const paymentIntentId = typeof invoice.payment_intent === "string" ? invoice.payment_intent : invoice.payment_intent?.id;
  const lineItem = invoice.lines?.data?.[0];

  await sendInvoiceEmailForStripe(
    {
      sourceType: "invoice.paid",
      customerEmail,
      customerName,
      amount,
      currency,
      planName: lineItem?.description || invoice.description || invoice.metadata?.planName || STRIPE_FALLBACK_PLAN_NAME,
      planSubtitle: invoice.metadata?.planSubtitle || "",
      transactionId: paymentIntentId || invoice.charge || invoice.id,
      invoiceId: invoice.id,
      paymentDate: new Date((invoice.status_transitions?.paid_at || Date.now()) * 1000),
      metadata: invoice.metadata || {},
      candidateTransactionIds: [paymentIntentId, invoice.charge, invoice.id],
      stripeReceiptPdfUrl: invoice.invoice_pdf || null,
    },
    event
  );
}

async function handlePaymentIntentSucceeded(event) {
  const paymentIntent = event.data.object;
  if (!paymentIntent || paymentIntent.status !== "succeeded") return;

  if (paymentIntent.invoice) {
    console.log("ℹ️ payment_intent.succeeded belongs to invoice; invoice.paid handles email.");
    return;
  }

  const currency = (paymentIntent.currency || "usd").toUpperCase();
  const amount = formatAmountFromStripe(paymentIntent.amount_received || paymentIntent.amount, currency);
  const latestChargeId = typeof paymentIntent.latest_charge === "string" ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id;
  let customerEmail =
    paymentIntent.receipt_email ||
    paymentIntent.metadata?.customerEmail ||
    null;
  let customerName = paymentIntent.metadata?.customerName || "";

  if (stripe && !customerEmail && latestChargeId) {
    try {
      const charge = await stripe.charges.retrieve(latestChargeId);
      customerEmail = charge?.billing_details?.email || charge?.receipt_email || null;
      customerName = customerName || charge?.billing_details?.name || "";
    } catch (error) {
      console.warn("⚠️ Unable to fetch latest charge for payment_intent.succeeded:", error.message);
    }
  }

  await sendInvoiceEmailForStripe(
    {
      sourceType: "payment_intent.succeeded",
      customerEmail,
      customerName,
      amount,
      currency,
      planName: paymentIntent.description || paymentIntent.metadata?.planName || STRIPE_FALLBACK_PLAN_NAME,
      planSubtitle: paymentIntent.metadata?.planSubtitle || "",
      transactionId: paymentIntent.id,
      invoiceId: "",
      paymentDate: new Date(),
      metadata: paymentIntent.metadata || {},
      candidateTransactionIds: [paymentIntent.id, latestChargeId],
    },
    event
  );
}

async function handleChargeSucceeded(event) {
  const charge = event.data.object;
  if (!charge || !charge.paid) return;

  if (charge.invoice) {
    console.log("ℹ️ charge.succeeded belongs to invoice; invoice.paid handles email.");
    return;
  }

  await sendInvoiceEmailForStripe(
    {
      sourceType: "charge.succeeded",
      customerEmail: charge.billing_details?.email || charge.receipt_email || null,
      customerName: charge.billing_details?.name || "",
      amount: formatAmountFromStripe(charge.amount, charge.currency),
      currency: (charge.currency || "usd").toUpperCase(),
      planName: charge.description || charge.metadata?.planName || STRIPE_FALLBACK_PLAN_NAME,
      planSubtitle: charge.metadata?.planSubtitle || "",
      transactionId: charge.payment_intent || charge.id,
      invoiceId: charge.invoice || "",
      paymentDate: new Date(),
      metadata: charge.metadata || {},
      candidateTransactionIds: [charge.payment_intent, charge.id, charge.invoice],
    },
    event
  );
}

async function handleChargeRefunded(event) {
  const charge = event.data.object;
  if (!charge) return;

  const refundedAmount = formatAmountFromStripe(charge.amount_refunded || 0, charge.currency);
  const updated = await markRefundInDb(
    [charge.payment_intent, charge.id, charge.invoice].filter(Boolean),
    charge.billing_details?.email || charge.receipt_email || ""
  );

  await sendStripeDiscordSummary([
    "↩️ **Stripe Refund Processed**",
    "────────────────────────────────",
    `📧 **Email:** ${charge.billing_details?.email || charge.receipt_email || "unknown"}`,
    `💵 **Refund Amount:** ${(charge.currency || "usd").toUpperCase()} ${refundedAmount.toFixed(2)}`,
    `🔖 **Charge:** ${charge.id || "N/A"}`,
    `🔖 **Payment Intent:** ${charge.payment_intent || "N/A"}`,
    `🗂️ **DB Status Updated:** ${updated ? "Yes ✅" : "No record found"}`,
  ]);
}

async function handlePaymentFailure(event) {
  const obj = event.data.object || {};
  const amountInCents = obj.amount || obj.amount_capturable || obj.amount_received || 0;
  const currency = (obj.currency || "usd").toUpperCase();
  const email =
    obj.receipt_email ||
    obj.billing_details?.email ||
    obj.last_payment_error?.payment_method?.billing_details?.email ||
    "unknown";
  const reason = obj.last_payment_error?.message || obj.failure_message || obj.cancellation_reason || "unknown";

  await sendStripeDiscordSummary([
    "⚠️ **Stripe Payment Failed/Canceled**",
    "────────────────────────────────",
    `📦 **Event:** ${event.type}`,
    `📧 **Email:** ${email}`,
    `💵 **Amount:** ${currency} ${formatAmountFromStripe(amountInCents, currency).toFixed(2)}`,
    `🔖 **Reference:** ${obj.id || "N/A"}`,
    `❌ **Reason:** ${safeSlice(reason, 300)}`,
  ]);
}

export async function handleStripeWebhook(req, res) {
  try {
    if (!stripe || !stripeWebhookSecret) {
      console.error("❌ Stripe env missing. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in backend env.");
      return res.status(500).json({
        success: false,
        error: "Stripe configuration missing",
      });
    }

    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({ success: false, error: "Missing stripe-signature header" });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
    } catch (error) {
      console.error("❌ Stripe webhook signature verification failed:", error.message);
      return res.status(400).json({
        success: false,
        error: "Invalid Stripe signature",
      });
    }

    if (markAndCheckDuplicate(processedEventCache, event.id, 24 * 60 * 60 * 1000)) {
      console.log("ℹ️ Duplicate Stripe event ignored:", event.id);
      return res.status(200).json({ success: true, received: true, duplicate: true });
    }

    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event);
        break;
      case "checkout.session.async_payment_succeeded":
        await handleCheckoutAsyncPaymentSucceeded(event);
        break;
      case "invoice.paid":
      case "invoice.payment_succeeded":
        await handleInvoicePaid(event);
        break;
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event);
        break;
      case "charge.succeeded":
        await handleChargeSucceeded(event);
        break;
      case "charge.refunded":
        await handleChargeRefunded(event);
        break;
      case "payment_intent.payment_failed":
      case "payment_intent.canceled":
      case "invoice.payment_failed":
      case "charge.failed":
        await handlePaymentFailure(event);
        break;
      default:
        console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
        break;
    }

    return res.status(200).json({ success: true, received: true });
  } catch (error) {
    console.error("❌ Error processing Stripe webhook:", error);
    return res.status(200).json({
      success: false,
      received: true,
      error: error.message || "Webhook processing failed",
    });
  }
}

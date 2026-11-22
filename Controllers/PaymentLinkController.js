import Stripe from 'stripe';
import crypto from 'crypto';
import { ShortLinkModel } from '../Schema_Models/ShortLink.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generateShortCode(length = 7) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length];
  }
  return code;
}

async function createShortLink(longUrl, expiresAtSeconds, createdBy) {
  const shortLinkBase = process.env.SHORT_LINK_BASE_URL || 'https://api.flashfirejobs.com';

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShortCode();
    try {
      await ShortLinkModel.create({
        code,
        longUrl,
        createdBy,
        expiresAt: new Date(expiresAtSeconds * 1000),
      });
      return `${shortLinkBase}/s/${code}`;
    } catch (err) {
      if (err?.code === 11000) continue; // code collision, retry
      throw err;
    }
  }
  throw new Error('Unable to generate a unique short code.');
}

const PLAN_DESCRIPTION = 'Once your payment is confirmed, you will receive an official invoice via email. Our team will initiate the onboarding process within 24 hours, providing you with access credentials and clear next steps. Dedicated 24/7 support will be available throughout your journey.';

const REGIONS = {
  us: {
    currency: 'usd',
    plans: {
      professional: { name: 'Professional Plan – Mid-Level Professionals', originalPrice: 349 },
      executive: { name: 'Executive Plan – 1200+ Applications', originalPrice: 599 },
    },
  },
  uk: {
    currency: 'gbp',
    plans: {
      professional: { name: 'Professional Plan – Mid-Level Professionals', originalPrice: 299 },
      executive: { name: 'Executive Plan – 1200+ Applications', originalPrice: 499 },
    },
  },
  ca: {
    currency: 'cad',
    plans: {
      professional: { name: 'Professional Plan – Mid-Level Professionals', originalPrice: 409 },
      executive: { name: 'Executive Plan – 1200+ Applications', originalPrice: 799 },
    },
  },
  au: {
    currency: 'aud',
    plans: {
      professional: { name: 'Professional Plan – Mid-Level Professionals', originalPrice: 549 },
      executive: { name: 'Executive Plan – 1200+ Applications', originalPrice: 899 },
    },
  },
  eu: {
    currency: 'eur',
    plans: {
      professional: { name: 'Professional Plan – Mid-Level Professionals', originalPrice: 299 },
      executive: { name: 'Executive Plan – 1200+ Applications', originalPrice: 499 },
    },
  },
};

const MAX_DISCOUNT_PERCENT = 20;

export async function generatePaymentLink(req, res) {
  try {
    const { plan, discount } = req.body;
    const region = REGIONS[req.body.region || 'us'];

    if (!region) {
      return res.status(400).json({ success: false, error: 'Invalid region selected.' });
    }

    if (!plan || !region.plans[plan]) {
      return res.status(400).json({ success: false, error: 'Invalid plan selected.' });
    }

    const planConfig = region.plans[plan];
    const discountAmount = Number(discount);

    if (isNaN(discountAmount) || discountAmount < 0) {
      return res.status(400).json({ success: false, error: 'Discount cannot be negative.' });
    }

    const isAdmin = await isCrmAdmin(req.crmUser);
    const maxDiscount = isAdmin ? planConfig.originalPrice - 0.01 : Math.floor(planConfig.originalPrice * MAX_DISCOUNT_PERCENT) / 100;
    if (discountAmount > maxDiscount) {
      return res.status(400).json({ success: false, error: isAdmin
        ? `Discount cannot exceed the original price.`
        : `Discount cannot exceed ${MAX_DISCOUNT_PERCENT}% (${maxDiscount.toFixed(2)}).` });
    }

    const finalPrice = planConfig.originalPrice - discountAmount;

    if (finalPrice <= 0) {
      return res.status(400).json({ success: false, error: 'Discount exceeds original price.' });
    }

    const baseUrl = process.env.CAMPAIGN_BASE_URL || 'https://www.flashfirejobs.com';
    const expiresAt = Math.floor(Date.now() / 1000) + 6 * 60 * 60;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: region.currency,
      customer_creation: 'always',
      invoice_creation: { enabled: true },
      line_items: [
        {
          price_data: {
            currency: region.currency,
            unit_amount: Math.round(finalPrice * 100),
            product_data: {
              name: planConfig.name,
              description: PLAN_DESCRIPTION,
            },
          },
          quantity: 1,
        },
      ],
      expires_at: expiresAt,
      success_url: `${baseUrl}/payment-success`,
      cancel_url: `${baseUrl}/payment-cancelled`,
    });

    let shortUrl = null;
    try {
      shortUrl = await createShortLink(session.url, session.expires_at, req.crmUser?.email || req.crmUser?.id);
    } catch (shortLinkErr) {
      console.error('[PaymentLinkController] Short link creation failed:', shortLinkErr);
    }

    return res.json({
      success: true,
      url: shortUrl || session.url,
      stripeUrl: session.url,
      sessionId: session.id,
      finalPrice,
      expiresAt: session.expires_at,
    });
  } catch (err) {
    console.error('[PaymentLinkController] Error:', err);
    return res.status(500).json({ success: false, error: 'Unable to connect to Stripe. Please try again.' });
  }
}

export async function redirectShortLink(req, res) {
  try {
    const { code } = req.params;
    const link = await ShortLinkModel.findOne({ code });

    if (!link) {
      return res.status(404).send('This link is invalid or has expired.');
    }

    if (link.expiresAt.getTime() < Date.now()) {
      return res.status(410).send('This payment link has expired. Please request a new one.');
    }

    return res.redirect(302, link.longUrl);
  } catch (err) {
    console.error('[PaymentLinkController] Redirect error:', err);
    return res.status(500).send('Something went wrong. Please try again.');
  }
}

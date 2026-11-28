import crypto from 'crypto';
import { EmailUnsubscribeModel } from '../Schema_Models/EmailUnsubscribe.js';

// Unsubscribe links that point at this backend. The token is an HMAC of the address, so a link only works for the
// address it was made for and nobody can unsubscribe someone else by editing the URL.

const norm = (email) => String(email ?? '').trim().toLowerCase();

export function unsubscribeSecret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.CRM_JWT_SECRET || null;
}

export function publicApiBase() {
  return (process.env.PUBLIC_API_URL || 'https://api.flashfirejobs.com').replace(/\/+$/, '');
}

export function unsubscribeToken(email, secret = unsubscribeSecret()) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`unsub:${norm(email)}`).digest('base64url');
}

export function verifyUnsubscribeToken(email, token, secret = unsubscribeSecret()) {
  const want = unsubscribeToken(email, secret);
  if (!want || typeof token !== 'string') return false;
  const a = Buffer.from(want);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The link for one address, or null when no signing secret is configured. */
export function unsubscribeUrl(email, base = publicApiBase(), secret = unsubscribeSecret()) {
  const token = unsubscribeToken(email, secret);
  if (!token || !norm(email)) return null;
  return `${base}/unsubscribe?e=${encodeURIComponent(norm(email))}&t=${token}`;
}

export async function isUnsubscribed(email, Model = EmailUnsubscribeModel) {
  const e = norm(email);
  if (!e) return false;
  return Boolean(await Model.exists({ email: e }));
}

export async function recordUnsubscribe(email, source = 'link', Model = EmailUnsubscribeModel) {
  await Model.updateOne({ email: norm(email) }, { $setOnInsert: { source, unsubscribedAt: new Date() } }, { upsert: true });
}

/** Footer html and text for an email, plus the headers mail apps use for their own Unsubscribe button. */
export function unsubscribeParts(email) {
  const url = unsubscribeUrl(email);
  if (!url) return { html: '', text: '', headers: {} };
  return {
    html: `<p style="margin-top:24px;font-size:12px;color:#6b7280;">Don't want these emails? <a href="${url}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>.</p>`,
    text: `\n\nDon't want these emails? Unsubscribe: ${url}`,
    headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

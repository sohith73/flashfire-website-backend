import express from 'express';
import { createUserRateLimiter } from '../Middlewares/perUserRateLimit.js';
import { verifyUnsubscribeToken, recordUnsubscribe, isUnsubscribed } from '../Utils/Unsubscribe.js';

// Public unsubscribe page for the link in our emails.
//   GET  /unsubscribe?e=<email>&t=<token>   shows a button (a GET never unsubscribes: mail scanners open links)
//   POST /unsubscribe?e=<email>&t=<token>   unsubscribes; also the target of the one-click List-Unsubscribe header

const limiter = createUserRateLimiter({ max: 30, windowMs: 60 * 1000, keyOf: (req) => `unsub:${req.ip}` });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;max-width:420px;width:100%;text-align:center}h1{font-size:20px;margin:0 0 12px}p{color:#475569;line-height:1.5;margin:0 0 20px}
button{background:#ea580c;color:#fff;border:0;border-radius:8px;padding:10px 20px;font-size:15px;font-weight:600;cursor:pointer}</style></head><body><main>${body}</main></body></html>`;

export function registerUnsubscribeRoutes(app, deps = {}) {
  const verify = deps.verify ?? verifyUnsubscribeToken;
  const record = deps.record ?? recordUnsubscribe;
  const already = deps.isUnsubscribed ?? isUnsubscribed;
  const form = express.urlencoded({ extended: false, limit: '4kb' });

  const bad = (res) => res.status(400).type('html').send(page('Link not valid', '<h1>This link is not valid</h1><p>It may have been cut off when it was copied. Use the Unsubscribe link in the email again.</p>'));

  app.get('/unsubscribe', limiter, async (req, res) => {
    const { e, t } = req.query;
    if (typeof e !== 'string' || !verify(e, t)) return bad(res);
    try {
      if (await already(e)) {
        return res.type('html').send(page('Unsubscribed', `<h1>You are unsubscribed</h1><p>${esc(e)} will not get these emails from FlashFire.</p>`));
      }
      return res.type('html').send(page('Unsubscribe', `<h1>Unsubscribe from FlashFire emails?</h1><p>${esc(e)} will stop getting follow-up emails from us.</p>
<form method="post" action="/unsubscribe?e=${encodeURIComponent(e)}&t=${encodeURIComponent(t)}"><button type="submit">Unsubscribe</button></form>`));
    } catch (err) {
      console.error('[unsubscribe] page failed:', err?.message);
      return res.status(500).type('html').send(page('Something went wrong', '<h1>Something went wrong</h1><p>Please try again in a minute.</p>'));
    }
  });

  app.post('/unsubscribe', limiter, form, async (req, res) => {
    const e = req.query.e ?? req.body?.e;
    const t = req.query.t ?? req.body?.t;
    if (typeof e !== 'string' || !verify(e, t)) return bad(res);
    try {
      await record(e, 'link');
      return res.type('html').send(page('Unsubscribed', `<h1>You are unsubscribed</h1><p>${esc(e)} will not get these emails from FlashFire.</p>`));
    } catch (err) {
      console.error('[unsubscribe] save failed:', err?.message);
      return res.status(500).type('html').send(page('Something went wrong', '<h1>Something went wrong</h1><p>Please try again in a minute.</p>'));
    }
  });
}

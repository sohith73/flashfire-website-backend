import { unsubscribeParts } from './Unsubscribe.js';

// Footer for CRM workflow emails: the BDA's name as a signature on emails that follow a completed meeting, and our own
// unsubscribe link on every email. Pure, so it is easy to test.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The BDA who owns the lead: the person who hosted the meeting, else the original BDA, else whoever claimed it. */
export function bdaNameFor(booking) {
  return String(booking?.calendlyHost?.name || booking?.originalBda?.name || booking?.claimedBy?.name || '').trim();
}

/** True for a booking whose meeting is done, or a workflow triggered by completing it. */
export function isCompletedMeeting(booking, triggerAction) {
  const a = String(triggerAction || '').toLowerCase();
  return booking?.bookingStatus === 'completed' || a === 'complete' || a === 'completed';
}

/** { html, text, headers } to append to an email. Empty parts when there is nothing to add. */
export function emailFooter(booking, { triggerAction } = {}) {
  const email = booking?.clientEmail;
  const unsub = email ? unsubscribeParts(email) : { html: '', text: '', headers: {} };
  const name = isCompletedMeeting(booking, triggerAction) ? bdaNameFor(booking) : '';
  const sigHtml = name
    ? `<p style="margin:24px 0 0;font-size:14px;line-height:1.5;color:#111827;">Best regards,<br><strong>${esc(name)}</strong><br>FlashFire</p>`
    : '';
  const sigText = name ? `\n\nBest regards,\n${name}\nFlashFire` : '';
  return { html: sigHtml + unsub.html, text: sigText + unsub.text, headers: unsub.headers };
}

/**
 * Add the footer to a SendGrid message. A designed (HTML) email gets it written into its html. A SendGrid dynamic
 * template cannot be edited from here, so the footer rides on SendGrid's subscription-tracking footer slot.
 */
export function applyEmailFooter(msg, booking, { designed, triggerAction } = {}) {
  const f = emailFooter(booking, { triggerAction });
  if (!f.html && !f.text) return msg;
  if (Object.keys(f.headers).length) msg.headers = { ...(msg.headers || {}), ...f.headers };
  if (designed) {
    msg.html = String(msg.html || '') + f.html;
    msg.trackingSettings = { ...(msg.trackingSettings || {}), subscriptionTracking: { enable: false } };
  } else {
    msg.trackingSettings = { ...(msg.trackingSettings || {}), subscriptionTracking: { enable: true, html: f.html, text: f.text } };
  }
  return msg;
}

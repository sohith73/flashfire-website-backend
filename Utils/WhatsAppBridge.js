/**
 * WhatsAppBridge.js
 *
 * HTTP client for the whatsapp-bridge service (running on Render with persistent disk).
 * Checks whether the company WhatsApp number has sent a message to a client phone
 * after a given timestamp — used by lead action alert cron jobs.
 */

const BRIDGE_URL = process.env.WHATSAPP_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.WHATSAPP_BRIDGE_TOKEN;
const TIMEOUT_MS = 10000;

/**
 * Normalize Indian phone numbers to WhatsApp JID format.
 * Input: "9876543210", "919876543210", "+919876543210", "09876543210"
 * Output: "919876543210@s.whatsapp.net"
 */
function toJID(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = '91' + digits;
  return `${digits}@s.whatsapp.net`;
}

/**
 * Check if the company sent a WhatsApp message to `phone` after `afterTime`.
 *
 * Returns:
 *   { sent: true }  — a fromMe message was found after afterTime
 *   { sent: false } — no such message found
 *   { sent: null, error: string } — bridge unreachable or error
 */
export async function didCompanySendAfter(phone, afterTime) {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    console.warn('[WhatsAppBridge] WHATSAPP_BRIDGE_URL or WHATSAPP_BRIDGE_TOKEN not set');
    return { sent: null, error: 'bridge_not_configured' };
  }

  const jid = toJID(phone);
  if (!jid) return { sent: null, error: 'invalid_phone' };

  const url = `${BRIDGE_URL}/api/messages?chat_jid=${encodeURIComponent(jid)}&limit=50`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 404) return { sent: false };

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { sent: null, error: `bridge_${res.status}: ${text.slice(0, 100)}` };
    }

    const data = await res.json();
    const messages = data.messages ?? [];
    const afterMs = new Date(afterTime).getTime();

    const found = messages.some(m => {
      const msgMs = (m.timestamp ?? 0) * 1000;
      return m.from_me === true && msgMs > afterMs;
    });

    return { sent: found };
  } catch (err) {
    console.error('[WhatsAppBridge] fetch error:', err.message);
    return { sent: null, error: err.message };
  }
}

/**
 * Check bridge health and auth state.
 * Returns { ok: true, auth_state } or { ok: false, error }
 */
export async function getBridgeStatus() {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    return { ok: false, error: 'bridge_not_configured' };
  }
  try {
    const res = await fetch(`${BRIDGE_URL}/api/status`, {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `status_${res.status}` };
    const data = await res.json();
    return { ok: true, auth_state: data.auth_state };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * WhatsAppBridge.js
 *
 * HTTP client for the whatsapp-bridge service (running on Render with persistent disk).
 * Checks whether the company WhatsApp number has sent a message to a client phone
 * after a given timestamp — used by lead action alert cron jobs.
 *
 * The bridge stores chats under @lid JIDs internally. @s.whatsapp.net queries return
 * 0 results, so we resolve phone → lid via /api/chats first, then query by lid.
 */

const BRIDGE_URL = process.env.WHATSAPP_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.WHATSAPP_BRIDGE_TOKEN;
const TIMEOUT_MS = 10000;

// In-memory cache: phone digits → lid JID (e.g. "197633205391371@lid")
// Refreshed when a phone is not found, cleared every 30 min
let lidCache = {};
let lidCacheBuiltAt = 0;
const LID_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Strip non-digits from phone number.
 * Input: "+44 7508 762523", "447508762523", "07508762523"
 * Output: "447508762523"
 */
function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length <= 11) digits = digits.slice(1);
  return digits || null;
}

/**
 * Build/refresh the phone → lid cache from /api/chats.
 * Fetches all pages until exhausted.
 */
async function buildLidCache() {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) return;
  const newCache = {};
  let offset = 0;
  const limit = 200;
  while (true) {
    try {
      const res = await fetch(`${BRIDGE_URL}/api/chats?limit=${limit}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) break;
      const data = await res.json();
      const chats = data.chats ?? [];
      if (!chats.length) break;
      for (const chat of chats) {
        const lid = chat.jid;
        for (const alias of (chat.aliases ?? [])) {
          const phone = alias.replace('@s.whatsapp.net', '').replace('@lid', '');
          if (phone) newCache[phone] = lid;
        }
      }
      if (chats.length < limit) break;
      offset += limit;
    } catch {
      break;
    }
  }
  lidCache = newCache;
  lidCacheBuiltAt = Date.now();
  console.log(`[WhatsAppBridge] lid cache built: ${Object.keys(newCache).length} entries`);
}

/**
 * Resolve a phone number to its @lid JID used by the bridge.
 * Returns null if not found.
 */
async function resolveToLid(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;

  // Refresh cache if stale
  if (Date.now() - lidCacheBuiltAt > LID_CACHE_TTL_MS) {
    await buildLidCache();
  }

  if (lidCache[digits]) return lidCache[digits];

  // Not found — rebuild once more in case it's a new chat
  if (Date.now() - lidCacheBuiltAt > 60000) {
    await buildLidCache();
  }

  return lidCache[digits] ?? null;
}

/**
 * Check if the company sent a WhatsApp message to `phone` after `afterTime`.
 *
 * Returns:
 *   { sent: true }  — a is_from_me message was found after afterTime
 *   { sent: false } — no such message found
 *   { sent: null, error: string } — bridge unreachable or error
 */
export async function didCompanySendAfter(phone, afterTime) {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    console.warn('[WhatsAppBridge] WHATSAPP_BRIDGE_URL or WHATSAPP_BRIDGE_TOKEN not set');
    return { sent: null, error: 'bridge_not_configured' };
  }

  const digits = normalizePhone(phone);
  if (!digits) return { sent: null, error: 'invalid_phone' };

  // Resolve phone to lid JID
  const lid = await resolveToLid(digits);
  if (!lid) {
    // No chat found with this phone — BDA never messaged them
    return { sent: false };
  }

  const url = `${BRIDGE_URL}/api/messages?chat_jid=${encodeURIComponent(lid)}&limit=50`;

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
      return m.is_from_me === true && msgMs > afterMs;
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

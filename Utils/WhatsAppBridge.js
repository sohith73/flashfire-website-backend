/**
 * WhatsAppBridge.js
 *
 * HTTP client for the whatsapp-bridge service (running on Render with persistent disk).
 * Checks whether the company WhatsApp number has sent a message to a client phone
 * after a given timestamp — used by lead action alert cron jobs.
 *
 * Supports two bridges — one per executive:
 *   WHATSAPP_BRIDGE_URL_SIDDHARTHA + WHATSAPP_BRIDGE_TOKEN_SIDDHARTHA
 *   WHATSAPP_BRIDGE_URL_KALPATARU  + WHATSAPP_BRIDGE_TOKEN_KALPATARU
 *
 * Falls back to the legacy single-bridge env vars (WHATSAPP_BRIDGE_URL / WHATSAPP_BRIDGE_TOKEN)
 * if the per-executive ones are not set.
 *
 * The bridge stores chats under @lid JIDs internally. @s.whatsapp.net queries return
 * 0 results, so we resolve phone → lid via /api/chats first, then query by lid.
 */

const TIMEOUT_MS = 10000;
const LID_CACHE_TTL_MS = 30 * 60 * 1000;

// Per-bridge config — keyed by executive key ('siddhartha', 'kalpataru')
const BRIDGES = {
  siddhartha: {
    url: process.env.WHATSAPP_BRIDGE_URL_SIDDHARTHA || process.env.WHATSAPP_BRIDGE_URL,
    token: process.env.WHATSAPP_BRIDGE_TOKEN_SIDDHARTHA || process.env.WHATSAPP_BRIDGE_TOKEN,
    lidCache: {},
    lidCacheBuiltAt: 0,
  },
  kalpataru: {
    url: process.env.WHATSAPP_BRIDGE_URL_KALPATARU || process.env.WHATSAPP_BRIDGE_URL,
    token: process.env.WHATSAPP_BRIDGE_TOKEN_KALPATARU || process.env.WHATSAPP_BRIDGE_TOKEN,
    lidCache: {},
    lidCacheBuiltAt: 0,
  },
};

function normalizePhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length <= 11) digits = digits.slice(1);
  return digits || null;
}

async function buildLidCache(bridge) {
  if (!bridge.url || !bridge.token) return;
  const newCache = {};
  let offset = 0;
  const limit = 200;
  while (true) {
    try {
      const res = await fetch(`${bridge.url}/api/chats?limit=${limit}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${bridge.token}` },
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
  bridge.lidCache = newCache;
  bridge.lidCacheBuiltAt = Date.now();
  console.log(`[WhatsAppBridge] lid cache built for ${bridge.url}: ${Object.keys(newCache).length} entries`);
}

async function resolveToLid(bridge, phone) {
  const digits = normalizePhone(phone);
  if (!digits) return null;

  if (Date.now() - bridge.lidCacheBuiltAt > LID_CACHE_TTL_MS) {
    await buildLidCache(bridge);
  }

  if (bridge.lidCache[digits]) return bridge.lidCache[digits];

  if (Date.now() - bridge.lidCacheBuiltAt > 60000) {
    await buildLidCache(bridge);
  }

  return bridge.lidCache[digits] ?? null;
}

function getBridge(executiveKey) {
  return BRIDGES[executiveKey] ?? null;
}

/**
 * Check if the company sent a WhatsApp message to `phone` after `afterTime`.
 * Pass `executiveKey` ('siddhartha' or 'kalpataru') to use the right bridge.
 *
 * Returns:
 *   { sent: true }  — a is_from_me message was found after afterTime
 *   { sent: false } — no such message found
 *   { sent: null, error: string } — bridge unreachable or error
 */
export async function didCompanySendAfter(phone, afterTime, executiveKey = 'siddhartha') {
  const bridge = getBridge(executiveKey);
  if (!bridge || !bridge.url || !bridge.token) {
    console.warn(`[WhatsAppBridge] bridge not configured for executive: ${executiveKey}`);
    return { sent: null, error: 'bridge_not_configured' };
  }

  const digits = normalizePhone(phone);
  if (!digits) return { sent: null, error: 'invalid_phone' };

  const lid = await resolveToLid(bridge, digits);
  if (!lid) return { sent: false };

  const url = `${bridge.url}/api/messages?chat_jid=${encodeURIComponent(lid)}&limit=50`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${bridge.token}` },
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
 * Check bridge health for a given executive.
 * Returns { ok: true, auth_state } or { ok: false, error }
 */
export async function getBridgeStatus(executiveKey = 'siddhartha') {
  const bridge = getBridge(executiveKey);
  if (!bridge || !bridge.url || !bridge.token) {
    return { ok: false, error: 'bridge_not_configured' };
  }
  try {
    const res = await fetch(`${bridge.url}/api/status`, {
      headers: { Authorization: `Bearer ${bridge.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `status_${res.status}` };
    const data = await res.json();
    return { ok: true, auth_state: data.auth_state };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

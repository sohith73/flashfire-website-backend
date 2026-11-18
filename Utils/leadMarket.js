// Which market and landing route a lead came from. The register site serves one page per market
// (/ for the US, /en-ca for Canada, /uk and /en-gb for the UK), and the CRM needs to tell them apart.
//
// leadMarket: 'us' | 'ca' | 'uk' (null when unknown). landingRoute: the path the visitor submitted from, e.g. '/uk'.

export const LEAD_MARKETS = Object.freeze(['us', 'ca', 'uk']);
export const MARKET_LABELS = Object.freeze({ us: 'US', ca: 'Canada', uk: 'UK' });

const ROUTE_MARKET = [
  [/^\/(uk|en-gb)(\/|$)/i, 'uk'],
  [/^\/(en-ca|ca)(\/|$)/i, 'ca'],
];

/** A clean path such as '/uk' from a path or a full URL; null when it is not usable. Query and hash are dropped. */
export function cleanLandingRoute(value) {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try { raw = new URL(raw).pathname; } catch { return null; }
  }
  raw = raw.split(/[?#]/)[0];
  if (!raw.startsWith('/')) return null;
  const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  return path.slice(0, 80).toLowerCase() || null;
}

export function marketFromRoute(route) {
  const path = cleanLandingRoute(route);
  if (!path) return null;
  for (const [re, market] of ROUTE_MARKET) if (re.test(path)) return market;
  return 'us';
}

/** Normalises 'uk', 'en-gb', 'en-ca', 'ca', 'us' to a market; null for anything else. */
export function normalizeMarket(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'uk' || v === 'en-gb' || v === 'gb') return 'uk';
  if (v === 'ca' || v === 'en-ca') return 'ca';
  if (v === 'us' || v === 'en-us') return 'us';
  return null;
}

/**
 * Decides the market for a form submission. The explicit `market` the page sends wins, then the route
 * the visitor was on (from `landingRoute` or the page URL), then the locale.
 */
export function resolveLeadMarket({ market, landingRoute, pageUrl, locale } = {}) {
  const route = cleanLandingRoute(landingRoute) || cleanLandingRoute(pageUrl);
  const leadMarket = normalizeMarket(market) || (route ? marketFromRoute(route) : null) || normalizeMarket(locale);
  return { leadMarket, landingRoute: route };
}

/** The Calendly hidden tag: the form page puts utm_content = 'route-uk' when the ad link had none. */
export function marketFromUtmContent(utmContent) {
  const m = /^route-(us|ca|uk)$/i.exec(String(utmContent ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

/** The note line saved on the lead so the route is readable in the CRM notes too. */
export function routeNoteLine(leadMarket, landingRoute) {
  if (!leadMarket && !landingRoute) return null;
  return `Form page: ${landingRoute || '/'}${leadMarket ? ` (${MARKET_LABELS[leadMarket]})` : ''}`;
}

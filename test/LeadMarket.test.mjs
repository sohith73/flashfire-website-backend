// Which market and route a lead came from: the helper, the form controller and the leads filter.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
isolateExternalServices();

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { MetaAdsFormSubmissionModel } from '../Schema_Models/MetaAdsFormSubmission.js';
import { cleanLandingRoute, marketFromRoute, marketFromUtmContent, normalizeMarket, resolveLeadMarket, routeNoteLine } from '../Utils/leadMarket.js';
import { submitMetaAdsFormLead } from '../Controllers/MetaAdsFormController.js';

describe('leadMarket helper', () => {
  it('cleans a route from a path or a URL and drops query and hash', () => {
    assert.equal(cleanLandingRoute('https://register.flashfirejobs.com/uk?gclid=abc#top'), '/uk');
    assert.equal(cleanLandingRoute('/UK/'), '/uk');
    assert.equal(cleanLandingRoute('/'), '/');
    assert.equal(cleanLandingRoute('uk'), null);
    assert.equal(cleanLandingRoute(''), null);
    assert.equal(cleanLandingRoute(42), null);
  });

  it('maps routes to markets', () => {
    assert.equal(marketFromRoute('/uk'), 'uk');
    assert.equal(marketFromRoute('/en-gb/'), 'uk');
    assert.equal(marketFromRoute('/en-ca'), 'ca');
    assert.equal(marketFromRoute('/au'), 'au');
    assert.equal(marketFromRoute('/en-au/'), 'au');
    assert.equal(marketFromRoute('/aura'), 'us', 'only /au and /au/... are the Australia page');
    assert.equal(marketFromRoute('/'), 'us');
    assert.equal(marketFromRoute('/register'), 'us');
    assert.equal(marketFromRoute('/ukulele'), 'us', 'only /uk and /uk/... are the UK page');
  });

  it('prefers the explicit market, then the route, then the locale', () => {
    assert.deepEqual(resolveLeadMarket({ market: 'uk', pageUrl: 'https://x.com/', locale: 'us' }), { leadMarket: 'uk', landingRoute: '/' });
    assert.deepEqual(resolveLeadMarket({ pageUrl: 'https://x.com/uk?gclid=1', locale: 'us' }), { leadMarket: 'uk', landingRoute: '/uk' });
    assert.deepEqual(resolveLeadMarket({ locale: 'en-ca' }), { leadMarket: 'ca', landingRoute: null });
    assert.deepEqual(resolveLeadMarket({ market: 'mars', locale: 'zz' }), { leadMarket: null, landingRoute: null });
    assert.equal(normalizeMarket('GB'), 'uk');
    assert.equal(normalizeMarket('en-AU'), 'au');
    assert.deepEqual(resolveLeadMarket({ market: 'au', landingRoute: '/au', locale: 'us' }), { leadMarket: 'au', landingRoute: '/au' });
    assert.deepEqual(resolveLeadMarket({ pageUrl: 'https://x.com/', landingRoute: '/au', locale: 'us' }), { leadMarket: 'au', landingRoute: '/au' });
  });

  it('reads the hidden Calendly tag and writes the note line', () => {
    assert.equal(marketFromUtmContent('route-uk'), 'uk');
    assert.equal(marketFromUtmContent('Route-CA'), 'ca');
    assert.equal(marketFromUtmContent('route-au'), 'au');
    assert.equal(marketFromUtmContent('video-ad-3'), null);
    assert.equal(marketFromUtmContent(null), null);
    assert.equal(routeNoteLine('uk', '/uk'), 'Form page: /uk (UK)');
    assert.equal(routeNoteLine('au', '/au'), 'Form page: /au (Australia)');
    assert.equal(routeNoteLine(null, null), null);
  });
});

const EMAIL = 'market-test@test.local';
const EMAIL2 = 'market-test-2@test.local';
const PHONE = '+44 7700 900123';
const PHONE2 = '+44 7700 900456';

function fakeRes() {
  const res = { statusCode: 200, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  return res;
}
let ipCounter = 0;
async function submit(body) {
  const res = fakeRes();
  ipCounter += 1;
  await submitMetaAdsFormLead({ body: { name: 'Market Tester', status: 'Student Visa (UK)', ...body }, headers: { 'user-agent': 'test' }, ip: `10.9.${ipCounter}.1`, socket: { remoteAddress: `10.9.${ipCounter}.1` } }, res);
  return res;
}
const wipe = () => Promise.all([
  CampaignBookingModel.deleteMany({ clientEmail: { $in: [EMAIL, EMAIL2] } }),
  MetaAdsFormSubmissionModel.deleteMany({ email: { $in: [EMAIL, EMAIL2] } }),
]);

describe('form lead market', () => {
  before(connectTestDb);
  after(async () => { await wipe(); await disconnectTestDb(); });
  beforeEach(wipe);

  it('stores the market, route and Google click ids on a new lead and labels the source', async () => {
    const res = await submit({ email: EMAIL, phone: PHONE, locale: 'us', market: 'uk', landingRoute: '/uk', pageUrl: 'https://register.flashfirejobs.com/uk?gclid=G1', gclid: 'G1', gadCampaignId: '24469302872' });
    assert.equal(res.statusCode, 201);
    const lead = await CampaignBookingModel.findOne({ bookingId: res.body.bookingId }).lean();
    assert.equal(lead.leadMarket, 'uk');
    assert.equal(lead.landingRoute, '/uk');
    assert.equal(lead.gclid, 'G1');
    assert.equal(lead.gadCampaignId, '24469302872');
    assert.equal(lead.utmSource, 'google', 'a Google click with no utm_source is labelled google');
    assert.match(lead.anythingToKnow, /Form page: \/uk \(UK\)/);
    const archive = await MetaAdsFormSubmissionModel.findOne({ email: EMAIL }).lean();
    assert.equal(archive.market, 'uk');
    assert.equal(archive.landingRoute, '/uk');
  });

  it('works out the market from the page URL when the page sends none', async () => {
    const res = await submit({ email: EMAIL, phone: PHONE, locale: 'us', pageUrl: 'https://register.flashfirejobs.com/en-gb' });
    const lead = await CampaignBookingModel.findOne({ bookingId: res.body.bookingId }).lean();
    assert.equal(lead.leadMarket, 'uk');
    assert.equal(lead.landingRoute, '/en-gb');
    assert.equal(lead.utmSource, 'meta_ads_form');
  });

  it('fills the market on a merged lead that has none, and never overwrites an existing one', async () => {
    const first = await submit({ email: EMAIL, phone: PHONE, locale: 'us', market: 'us', landingRoute: '/' });
    assert.equal((await submit({ email: EMAIL, phone: PHONE, locale: 'us', market: 'uk', landingRoute: '/uk' })).body.deduped, true);
    const kept = await CampaignBookingModel.findOne({ bookingId: first.body.bookingId }).lean();
    assert.equal(kept.leadMarket, 'us', 'the first page stays');
    assert.match(kept.anythingToKnow, /Form page: \/uk \(UK\)/, 'the later page is noted');

    await CampaignBookingModel.create({ clientName: 'Old Lead', clientEmail: EMAIL2, clientPhone: PHONE2, bookingStatus: 'not-scheduled', leadSource: 'calendly', utmSource: 'direct' });
    const merged = await submit({ email: EMAIL2, phone: PHONE2, locale: 'us', market: 'uk', landingRoute: '/uk' });
    assert.equal(merged.body.deduped, true);
    assert.equal((await CampaignBookingModel.findOne({ clientEmail: EMAIL2 }).lean()).leadMarket, 'uk');
  });

  it('filters the leads list by market', async () => {
    await submit({ email: EMAIL, phone: PHONE, locale: 'us', market: 'uk', landingRoute: '/uk' });
    await submit({ email: EMAIL2, phone: PHONE2, locale: 'us', market: 'us', landingRoute: '/' });
    const { getLeadsPaginated } = await import('../Controllers/CampaignBookingController.js');
    const list = async (market) => {
      const res = fakeRes();
      await getLeadsPaginated({ query: { search: 'market-test', limit: '50', ...(market ? { market } : {}) }, crmUser: { email: 'admin@test.local', role: 'crm_admin' } }, res);
      return res.body?.bookings ?? res.body?.data ?? res.body?.leads ?? [];
    };
    assert.deepEqual((await list('uk')).map((b) => b.clientEmail), [EMAIL]);
    assert.deepEqual((await list('us')).map((b) => b.clientEmail), [EMAIL2]);
    assert.equal((await list()).length, 2);
    assert.equal((await list('none')).length, 0);
  });
});

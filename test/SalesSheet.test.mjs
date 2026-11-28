// Sales Tracker sheet feed: month bounds, country, grouping per executive, and the key-guarded route. No database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { monthBounds, countryFor, sheetDate, sheetDateTime, buildSalesSheetLeads, sheetNote } from '../Utils/SalesSheetLeads.js';
import { makeKeyCheck } from '../Utils/IntegrationKeyAuth.js';
import { registerSalesSheetRoutes } from '../Routes/salesSheetRoutes.js';
import { normalizePlan, updateFollowUpPlan } from '../Controllers/ScheduleFollowUpController.js';

const chain = (rows) => ({ sort: () => chain(rows), select: () => chain(rows), lean: async () => rows, then: undefined });
const booking = (o) => ({
  bookingId: o.id, clientName: o.name, clientPhone: o.phone, clientEmail: o.email || `${o.id}@x.test`,
  leadTemperature: { value: o.temp || 'hot', ratedByEmail: o.by, ratedAt: new Date('2026-11-10T10:00:00Z') },
  scheduledEventStartTime: o.meeting ?? new Date('2026-11-09T13:30:00Z'), bookingStatus: o.status || 'completed', utmCampaign: o.camp ?? null, leadMarket: o.market ?? null,
  paymentPlan: o.plan ?? null, statusHistory: o.hist ?? [], calendlyHost: o.host ? { email: o.host } : undefined,
});

describe('month bounds and helpers', () => {
  it('maps a month to IST bounds', () => {
    const b = monthBounds('2026-11');
    assert.equal(b.from.toISOString(), '2026-10-31T18:30:00.000Z');
    assert.equal(b.to.toISOString(), '2026-11-30T18:30:00.000Z');
    assert.equal(b.label, 'Nov 2026');
    assert.equal(monthBounds('2026-13'), null);
    assert.equal(monthBounds('nope'), null);
  });
  it('formats dates in IST', () => assert.equal(sheetDate('2026-11-16T20:00:00Z'), '17-Nov-2026'));
  it('formats the meeting date and time in IST', () => {
    assert.equal(sheetDateTime('2026-11-16T13:30:00Z'), '16-Nov-2026 7:00 PM');
    assert.equal(sheetDateTime('2026-11-16T00:15:00Z'), '16-Nov-2026 5:45 AM');
    assert.equal(sheetDateTime('2026-11-16T06:30:00Z'), '16-Nov-2026 12:00 PM');
    assert.equal(sheetDateTime(null), '');
  });
  it('picks the country from the campaign, then the phone prefix, then the market', () => {
    assert.equal(countryFor({ campaign: 'UK Job - Arun – United Kingdom', phone: '+4915' }), 'UK');
    assert.equal(countryFor({ campaign: 'Europe - Job - Arun', phone: '+4915774871821' }), 'Germany');
    assert.equal(countryFor({ campaign: 'Website', phone: '0743653305', market: 'uk' }), 'UK');
    assert.equal(countryFor({ campaign: null, phone: '0743653305' }), '');
  });
});

describe('buildSalesSheetLeads', () => {
  const rows = [
    booking({ id: 'a', name: 'A', phone: '+447000000001', by: 'kalpataru@flashfirehq.com', camp: 'UK Job - Arun – United Kingdom' }),
    booking({ id: 'b', name: 'B', phone: '+447000000001', by: 'kalpataru@flashfirehq.com' }),
    booking({ id: 'c', name: 'C', phone: '+31600000000', by: 'siddhartha@flashfirehq.com', temp: 'warm' }),
    booking({ id: 'd', name: 'D', phone: '+447000000004', by: 'ritika@flashfirehq.com', host: 'ritika@flashfirehq.com' }),
    booking({ id: 'e', name: 'E', phone: '+447000000005', by: 'adit.jain@flashfirehq.com', host: 'siddhartha@flashfirehq.com' }),
    booking({ id: 'f', name: 'F', phone: '+447000000006', by: 'kalpataru@flashfirehq.com', status: 'paid', plan: { name: 'IGNITE', price: 149, selectedAt: new Date('2026-11-13T10:00:00Z') } }),
  ];
  const deps = { Bookings: { find: () => chain(rows) }, Calls: { find: () => chain([{ phoneNumber: '+31600000000', meetingStartISO: new Date('2026-11-27T10:00:00Z'), createdAt: new Date() }]) } };

  it('groups per executive, dedupes, skips other BDAs and marks paid', async () => {
    const out = await buildSalesSheetLeads('2026-11', deps);
    const k = out.executives.find((x) => x.key === 'kalpataru').leads;
    const s = out.executives.find((x) => x.key === 'siddhartha');
    assert.deepEqual(k.map((l) => l.bookingId), ['a', 'f'], 'duplicate phone dropped');
    assert.equal(k[0].country, 'UK');
    assert.equal(k[0].meetingDateTime, '09-Nov-2026 7:00 PM');
    assert.equal(k[1].status, 'Paid');
    assert.equal(k[1].amountPaid, 149);
    assert.equal(k[1].package, 'Ignite');
    assert.equal(k[1].paymentDate, '13-Nov-2026');
    assert.deepEqual(s.leads.map((l) => l.bookingId), ['c', 'e'], 'adit-rated lead goes to the assigned executive');
    assert.equal(s.sheetName, 'Sidhharth');
    assert.equal(s.leads[0].followUpDate, '27-Nov-2026');
    assert.equal(s.leads[0].status, 'Warm');
    assert.equal(out.skippedOtherExecutives, 1);
  });
  it('prefers the date the BDA picked on the lead over the scheduled call', async () => {
    const picked = { ...booking({ id: 'g', name: 'G', phone: '+31600000000', by: 'siddhartha@flashfirehq.com' }), followUp: { at: new Date('2026-12-02T10:00:00Z') } };
    const out = await buildSalesSheetLeads('2026-11', { ...deps, Bookings: { find: () => chain([picked]) } });
    assert.equal(out.executives.find((x) => x.key === 'siddhartha').leads[0].followUpDate, '02-Dec-2026');
  });
  it('carries the BDA note on one line and caps it', async () => {
    assert.equal(sheetNote('call back\nasked for EXECUTIVE'), 'call back | asked for EXECUTIVE');
    assert.equal(sheetNote(null), '');
    assert.equal(sheetNote('x'.repeat(2000)).length, 1000);
    const n = { ...booking({ id: 'n', name: 'N', phone: '+447000000020', by: 'kalpataru@flashfirehq.com' }), meetingNotes: 'wants to think' };
    const out = await buildSalesSheetLeads('2026-11', { ...deps, Bookings: { find: () => chain([n]) } });
    assert.equal(out.executives.find((x) => x.key === 'kalpataru').leads[0].notes, 'wants to think');
  });
  it('uses the package the BDA leaned towards when no plan was bought, and the bought plan when there is one', async () => {
    const a = { ...booking({ id: 'h', name: 'H', phone: '+447000000011', by: 'kalpataru@flashfirehq.com' }), followUp: { plan: 'EXECUTIVE' } };
    const b = { ...booking({ id: 'i', name: 'I', phone: '+447000000012', by: 'kalpataru@flashfirehq.com', plan: { name: 'IGNITE', price: 199 } }), followUp: { plan: 'EXECUTIVE' } };
    const out = await buildSalesSheetLeads('2026-11', { ...deps, Bookings: { find: () => chain([a, b]) } });
    assert.deepEqual(out.executives.find((x) => x.key === 'kalpataru').leads.map((l) => l.package), ['Executive', 'Ignite']);
  });
  it('returns null for a bad month', async () => assert.equal(await buildSalesSheetLeads('2026-1', deps), null));
});

describe('key check', () => {
  const store = new Map();
  const Model = {
    findOne: (q) => ({ lean: async () => store.get(q.name) ?? null }),
    create: async (d) => { if (store.has(d.name)) throw Object.assign(new Error('dup'), { code: 11000 }); store.set(d.name, d); },
  };
  const check = makeKeyCheck({ name: 't', envVar: 'NO_SUCH_ENV_VAR', Model });
  const key = 'k'.repeat(40);
  it('rejects short keys, enrolls the first long key, then only accepts it', async () => {
    assert.equal(await check('short'), false);
    assert.equal(await check(key), true);
    assert.equal(await check(key), true);
    assert.equal(await check('z'.repeat(40)), false);
  });
});

describe('route', () => {
  let server; let base;
  before(async () => {
    const app = express();
    registerSalesSheetRoutes(app, { keyOk: async (k) => k === 'good', buildCallLeads: async ({ days }) => ({ generatedAt: 'x', windowDays: days, summary: [], leads: [] }), build: async (m) => (m === '2026-11' ? { month: m, label: 'Nov 2026', executives: [], skippedOtherExecutives: 0 } : null) });
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  const get = (path, key) => fetch(base + path, { headers: key ? { 'X-Sheet-Secret': key } : {} });
  it('401 without the key', async () => assert.equal((await get('/api/sales-sheet/leads?month=2026-11')).status, 401));
  it('422 for a bad month', async () => assert.equal((await get('/api/sales-sheet/leads?month=x', 'good')).status, 422));
  it('call-leads: 401 without the key, 422 for bad days, 200 otherwise', async () => {
    assert.equal((await get('/api/sales-sheet/call-leads')).status, 401);
    assert.equal((await get('/api/sales-sheet/call-leads?days=0', 'good')).status, 422);
    const ok = await get('/api/sales-sheet/call-leads?days=3', 'good');
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.windowDays, 3);
  });
  it('200 with the key', async () => {
    const res = await get('/api/sales-sheet/leads?month=2026-11', 'good');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
  });
});

describe('follow-up package', () => {
  it('accepts the four plans in any case and nothing else', () => {
    assert.equal(normalizePlan('ignite'), 'IGNITE');
    assert.equal(normalizePlan(' Prime '), 'PRIME');
    assert.equal(normalizePlan('gold'), null);
    assert.equal(normalizePlan(''), null);
    assert.equal(normalizePlan(undefined), null);
  });
  it('answers 400 for an unknown plan before touching the database', async () => {
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await updateFollowUpPlan({ params: { bookingId: 'x' }, body: { plan: 'gold' } }, res);
    assert.equal(res.code, 400);
    assert.equal(res.body.success, false);
  });
  it('refuses a follow-up with no package unless the lead already has one', async () => {
    const { CampaignBookingModel } = await import('../Schema_Models/CampaignBooking.js');
    const { default: ScheduleFollowUp } = await import('../Controllers/ScheduleFollowUpController.js');
    const original = CampaignBookingModel.findOne;
    const run = async (booking, body) => {
      CampaignBookingModel.findOne = async () => booking;
      const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      await ScheduleFollowUp({ params: { bookingId: 'x' }, body: { followUpDateTime: new Date(Date.now() - 1000).toISOString(), ...body } }, res);
      return res;
    };
    try {
      const none = await run({}, {});
      assert.equal(none.code, 400);
      assert.match(none.body.message, /package/i);
      // already has a plan: passes the package gate and fails later on the past date instead
      const has = await run({ followUp: { plan: 'PRIME' } }, {});
      assert.match(has.body.message, /future/i);
      const given = await run({}, { plan: 'ignite' });
      assert.match(given.body.message, /future/i);
    } finally { CampaignBookingModel.findOne = original; }
  });
});

describe('sheet package write-back', () => {
  let server; let base; let CampaignBookingModel; let orig; let found; let updated;
  before(async () => {
    ({ CampaignBookingModel } = await import('../Schema_Models/CampaignBooking.js'));
    orig = { f: CampaignBookingModel.findOne, u: CampaignBookingModel.updateOne };
    CampaignBookingModel.findOne = () => ({ sort: () => ({ select: () => ({ lean: async () => found }) }) });
    CampaignBookingModel.updateOne = async (q, u) => { updated = { q, u }; return { modifiedCount: 1 }; };
    const app = express();
    registerSalesSheetRoutes(app, { keyOk: async (k) => k === 'good' });
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { CampaignBookingModel.findOne = orig.f; CampaignBookingModel.updateOne = orig.u; server.close(); });
  const post = (body, key = 'good') => fetch(`${base}/api/sales-sheet/package`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Sheet-Secret': key }, body: JSON.stringify(body) });

  it('401 without the key', async () => assert.equal((await post({ phone: '+14155550000', plan: 'PRIME' }, 'bad')).status, 401));
  it('422 for an unknown plan or no lead', async () => {
    assert.equal((await post({ phone: '+14155550000', plan: 'GOLD' })).status, 422);
    assert.equal((await post({ plan: 'PRIME' })).status, 422);
  });
  it('404 when no lead matches', async () => { found = null; assert.equal((await post({ phone: '+14155550000', plan: 'PRIME' })).status, 404); });
  it('409 when the lead already bought a plan', async () => {
    found = { bookingId: 'b1', paymentPlan: { name: 'IGNITE' } };
    updated = null;
    assert.equal((await post({ phone: '+14155550000', plan: 'PRIME' })).status, 409);
    assert.equal(updated, null);
  });
  it('saves the package on the lead, any case', async () => {
    found = { bookingId: 'b1' };
    const res = await post({ phone: '+1 (415) 555-0000', plan: 'ignite' });
    assert.equal(res.status, 200);
    assert.deepEqual(updated, { q: { bookingId: 'b1' }, u: { $set: { 'followUp.plan': 'IGNITE' } } });
  });
});

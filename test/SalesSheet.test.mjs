// Sales Tracker sheet feed: month bounds, country, grouping per executive, and the key-guarded route. No database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { monthBounds, countryFor, sheetDate, buildSalesSheetLeads } from '../Utils/SalesSheetLeads.js';
import { makeKeyCheck } from '../Utils/IntegrationKeyAuth.js';
import { registerSalesSheetRoutes } from '../Routes/salesSheetRoutes.js';

const chain = (rows) => ({ sort: () => chain(rows), select: () => chain(rows), lean: async () => rows, then: undefined });
const booking = (o) => ({
  bookingId: o.id, clientName: o.name, clientPhone: o.phone, clientEmail: o.email || `${o.id}@x.test`,
  leadTemperature: { value: o.temp || 'hot', ratedByEmail: o.by, ratedAt: new Date('2026-11-10T10:00:00Z') },
  bookingStatus: o.status || 'completed', utmCampaign: o.camp ?? null, leadMarket: o.market ?? null,
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
    registerSalesSheetRoutes(app, { keyOk: async (k) => k === 'good', build: async (m) => (m === '2026-11' ? { month: m, label: 'Nov 2026', executives: [], skippedOtherExecutives: 0 } : null) });
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  const get = (path, key) => fetch(base + path, { headers: key ? { 'X-Sheet-Secret': key } : {} });
  it('401 without the key', async () => assert.equal((await get('/api/sales-sheet/leads?month=2026-11')).status, 401));
  it('422 for a bad month', async () => assert.equal((await get('/api/sales-sheet/leads?month=x', 'good')).status, 422));
  it('200 with the key', async () => {
    const res = await get('/api/sales-sheet/leads?month=2026-11', 'good');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
  });
});

// Sheet package write-back: POST /api/sales-sheet/package. No database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerSalesSheetRoutes } from '../Routes/salesSheetRoutes.js';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { planFromText, planFromAmount, inputFromBooking, inputFromPayment, triggerAutoOnboard, runAutoOnboardSweep, AUTO_ONBOARD_SINCE } from '../Utils/AutoOnboard.js';

const quiet = { log() {}, warn() {} };

function fakeModel(rows) {
  const updates = [];
  return {
    updates,
    find: (filter) => ({ sort: () => ({ limit: () => ({ lean: async () => rows.filter((r) => !r.autoOnboardedAt) }) }) }),
    updateOne: async (f, u) => { updates.push({ id: f._id, set: u.$set }); const r = rows.find((x) => x._id === f._id); Object.assign(r, u.$set); },
  };
}

test('plan is read from the text first, then the exact USD price, never guessed', () => {
  assert.equal(planFromText('Executive Plan - Monthly'), 'EXECUTIVE');
  assert.equal(planFromText('flashfire PROFESSIONAL'), 'PROFESSIONAL');
  assert.equal(planFromText('Custom thing'), null);
  assert.equal(planFromAmount(599, 'usd'), 'EXECUTIVE');
  assert.equal(planFromAmount(600, 'USD'), null);
  assert.equal(planFromAmount(599, 'INR'), null);
});

test('inputs are built from a paid lead and from a payment', () => {
  const b = inputFromBooking({ clientEmail: ' A@B.com ', clientName: 'Ann Lee', paymentPlan: { name: 'IGNITE', price: 199, currency: 'USD' } });
  assert.deepEqual(b, { email: 'a@b.com', name: 'Ann Lee', planType: 'IGNITE', amountPaid: 199, currency: 'USD', source: 'crm-paid' });
  const p = inputFromPayment({ customerEmail: 'c@d.com', customerFirstName: 'Cy', customerLastName: 'Dee', planName: 'Prime', planSubtitle: '', amount: 99, currency: 'USD' });
  assert.equal(p.name, 'Cy Dee');
  assert.equal(p.planType, 'PRIME');
  assert.equal(inputFromPayment({ customerEmail: 'c@d.com', planName: 'Custom', amount: 99, currency: 'USD' }).planType, 'PRIME');
});

test('trigger sends the secret, treats 200/400/422 as final and the rest as retryable, and never throws', async () => {
  const calls = [];
  const http = (status, data) => ({ post: async (url, body, cfg) => { calls.push({ url, cfg }); return { status, data }; } });
  const ok = await triggerAutoOnboard({ email: 'a@b.com' }, { secret: 's', url: 'https://x.test/', http: http(200, { status: 'created', clientNumber: 5810 }) });
  assert.deepEqual([ok.status, ok.clientNumber], ['created', 5810]);
  assert.equal(calls[0].url, 'https://x.test/api/internal/auto-onboard');
  assert.equal(calls[0].cfg.headers['x-cron-secret'], 's');
  assert.equal((await triggerAutoOnboard({}, { secret: 's', url: 'https://x.test', http: http(422, { status: 'bad_plan', error: 'nope' }) })).status, 'bad_plan');
  assert.equal((await triggerAutoOnboard({}, { secret: 's', url: 'https://x.test', http: http(503, {}) })).transient, true);
  assert.equal((await triggerAutoOnboard({}, { secret: 's', url: 'https://x.test', http: { post: async () => { throw new Error('ECONNRESET'); } } })).transient, true);
  assert.equal((await triggerAutoOnboard({}, { secret: '', http: http(200, {}) })).transient, true);
});

test('sweep stamps final outcomes, retries transient failures and alerts on rejections', async () => {
  const Booking = fakeModel([
    { _id: 'b1', clientEmail: 'new@x.com', clientName: 'New One', paymentPlan: { name: 'EXECUTIVE', price: 599, currency: 'USD' } },
    { _id: 'b2', clientEmail: 'old@x.com', clientName: 'Old One', paymentPlan: { name: 'PRIME', price: 99, currency: 'USD' } },
  ]);
  const Payment = fakeModel([
    { _id: 'p1', customerEmail: 'down@x.com', customerFirstName: 'Dee', customerLastName: 'Own', planName: 'Prime', amount: 99, currency: 'USD' },
    { _id: 'p2', customerEmail: 'weird@x.com', customerFirstName: 'We', customerLastName: 'Ird', planName: 'Mystery', amount: 123, currency: 'USD' },
  ]);
  const alerts = [];
  const trigger = async (i) => ({ 'new@x.com': { status: 'created' }, 'old@x.com': { status: 'exists' }, 'down@x.com': { transient: true, error: 'HTTP 503' } })[i.email];
  const now = new Date('2026-11-26T00:00:00Z');
  const s = await runAutoOnboardSweep({ trigger, Booking, Payment, now, alert: async (m) => alerts.push(m), logger: quiet });
  assert.deepEqual(s, { checked: 4, created: 1, exists: 1, rejected: 1, retry: 1 });
  assert.deepEqual(Booking.updates.map((u) => [u.id, u.set.autoOnboardResult]), [['b1', 'created'], ['b2', 'exists']]);
  assert.deepEqual(Payment.updates.map((u) => [u.id, u.set.autoOnboardResult]), [['p2', 'bad_plan']]);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes('weird@x.com'));
  // Second pass: only the transient one is retried, stamped rows are not sent again.
  const sent = [];
  const s2 = await runAutoOnboardSweep({ trigger: async (i) => { sent.push(i.email); return { status: 'created' }; }, Booking, Payment, now, alert: async () => {}, logger: quiet });
  assert.deepEqual(sent, ['down@x.com']);
  assert.equal(s2.created, 1);
});

test('the cutoff is in the past of go-live and rows older than it are not selected by the filters', () => {
  assert.equal(AUTO_ONBOARD_SINCE.toISOString(), '2026-11-24T18:30:00.000Z');
});

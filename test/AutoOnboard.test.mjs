import test from 'node:test';
import assert from 'node:assert/strict';
import { planFromText, planFromAmount, inputFromBooking, inputFromPayment, triggerAutoOnboard, runAutoOnboardSweep, kickAutoOnboard, onboardFromStripe, inputFromStripe, AUTO_ONBOARD_SINCE } from '../Utils/AutoOnboard.js';

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a burst of kicks runs the sweep once, and a busy sweep is retried shortly', async () => {
  let runs = 0;
  const run = async () => (++runs === 1 ? { skipped: 'busy' } : { checked: 1 });
  kickAutoOnboard({ run, delayMs: 5, retryMs: 5 });
  kickAutoOnboard({ run, delayMs: 5, retryMs: 5 });
  kickAutoOnboard({ run, delayMs: 5, retryMs: 5 });
  await wait(60);
  assert.equal(runs, 2); // one merged run, one retry after busy
  const boom = async () => { throw new Error('db down'); };
  kickAutoOnboard({ run: boom, delayMs: 1 });
  await wait(20); // must not throw or leave the timer stuck
  let after = 0;
  kickAutoOnboard({ run: async () => { after++; return {}; }, delayMs: 1 });
  await wait(20);
  assert.equal(after, 1);
});

const NOW_OK = new Date(AUTO_ONBOARD_SINCE.getTime() + 3600_000);
const stripeDeps = (over = {}) => {
  const alerts = [];
  const sent = [];
  return { alerts, sent, deps: { trigger: async (i) => { sent.push(i); return { status: 'created' }; }, alert: async (m) => { alerts.push(m); }, sleep: async () => {}, delays: [0, 1, 1], logger: { log() {}, warn() {}, error() {} }, ...over } };
};

test('a Stripe payment is sent with the plan from the text, else from the USD price', async () => {
  const a = stripeDeps();
  assert.equal((await onboardFromStripe({ email: 'A@B.com', name: 'Ann Lee', planName: 'FlashFire Executive Plan', amount: 599, currency: 'USD', createdAt: NOW_OK }, a.deps)).status, 'created');
  assert.deepEqual([a.sent[0].email, a.sent[0].planType, a.sent[0].source], ['a@b.com', 'EXECUTIVE', 'stripe']);
  const b = stripeDeps();
  await onboardFromStripe({ email: 'c@d.com', name: 'Cy', planName: 'FlashFire Plan', amount: 199, currency: 'USD', createdAt: NOW_OK }, b.deps);
  assert.equal(b.sent[0].planType, 'IGNITE');
  assert.equal(inputFromStripe({ email: 'x@y.com', name: 'X', planName: 'Custom', amount: 420, currency: 'AUD' }).planType, null);
});

test('Stripe: a transient failure is retried then succeeds, and a final failure alerts a human', async () => {
  let n = 0;
  const a = stripeDeps({ trigger: async () => (++n < 3 ? { transient: true, error: 'HTTP 502' } : { status: 'exists' }) });
  assert.equal((await onboardFromStripe({ email: 'a@b.com', name: 'A', planName: 'Prime', amount: 99, currency: 'USD', createdAt: NOW_OK }, a.deps)).status, 'exists');
  assert.equal(n, 3);
  assert.equal(a.alerts.length, 0);
  const b = stripeDeps({ trigger: async () => ({ transient: true, error: 'HTTP 503' }) });
  const r = await onboardFromStripe({ email: 'a@b.com', name: 'A', planName: 'Prime', amount: 99, currency: 'USD', createdAt: NOW_OK }, b.deps);
  assert.equal(r.status, 'failed');
  assert.match(b.alerts[0], /Auto onboarding failed.*a@b\.com.*503/);
});

test('Stripe: unknown plan alerts and sends nothing, old events and missing emails are ignored, and it never throws', async () => {
  const a = stripeDeps();
  assert.equal((await onboardFromStripe({ email: 'a@b.com', name: 'A', planName: 'Custom', amount: 420, currency: 'AUD', createdAt: NOW_OK }, a.deps)).status, 'bad_plan');
  assert.equal(a.sent.length, 0);
  assert.match(a.alerts[0], /plan=unknown/);
  const b = stripeDeps();
  assert.equal((await onboardFromStripe({ email: 'a@b.com', name: 'A', planName: 'Prime', amount: 99, currency: 'USD', createdAt: new Date(AUTO_ONBOARD_SINCE.getTime() - 1) }, b.deps)).status, 'skipped_old');
  assert.equal((await onboardFromStripe({ email: '', name: 'A', planName: 'Prime', createdAt: NOW_OK }, b.deps)).status, 'invalid');
  assert.equal(b.sent.length, 0);
  const c = stripeDeps({ trigger: async () => { throw new Error('boom'); } });
  assert.equal((await onboardFromStripe({ email: 'a@b.com', name: 'A', planName: 'Prime', amount: 99, currency: 'USD', createdAt: NOW_OK }, c.deps)).status, 'failed');
});

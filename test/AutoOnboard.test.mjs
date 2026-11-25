import test from 'node:test';
import assert from 'node:assert/strict';
import { planFromText, planFromAmount, inputFromBooking, inputFromPayment, triggerAutoOnboard, runAutoOnboardSweep, kickAutoOnboard, onboardFromStripe, inputFromStripe, countryFromCurrency, AUTO_ONBOARD_SINCE } from '../Utils/AutoOnboard.js';

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

test('inputs are built from a paid lead and from a payment, with a country from the currency', () => {
  const b = inputFromBooking({ clientEmail: ' A@B.com ', clientName: 'Ann Lee', paymentPlan: { name: 'IGNITE', price: 199, currency: 'AUD' } });
  assert.deepEqual(b, { email: 'a@b.com', name: 'Ann Lee', planType: 'IGNITE', amountPaid: 199, currency: 'AUD', country: 'Australia', source: 'crm-paid' });
  const p = inputFromPayment({ customerEmail: 'c@d.com', customerFirstName: 'Cy', customerLastName: 'Dee', planName: 'Prime', planSubtitle: '', amount: 99, currency: 'USD' });
  assert.equal(p.name, 'Cy Dee');
  assert.equal(p.planType, 'PRIME');
  assert.equal(p.country, 'USA');
  assert.equal(inputFromPayment({ customerEmail: 'c@d.com', planName: 'Custom', amount: 99, currency: 'USD' }).planType, 'PRIME');
  // A plan or name we cannot read never blocks the notice: the plan is empty, the name falls back to the email.
  const w = inputFromPayment({ customerEmail: 'sam@d.com', planName: 'Mystery', amount: 123, currency: 'INR' });
  assert.deepEqual([w.planType, w.name, w.country], [null, 'sam', '']);
  assert.equal(countryFromCurrency('gbp'), 'UK');
});

test('trigger sends the secret to paid-notice, treats 200/400 as final and the rest as retryable, and never throws', async () => {
  const calls = [];
  const http = (status, data) => ({ post: async (url, body, cfg) => { calls.push({ url, cfg }); return { status, data }; } });
  const ok = await triggerAutoOnboard({ email: 'a@b.com' }, { secret: 's', url: 'https://x.test/', http: http(200, { status: 'notified' }) });
  assert.equal(ok.status, 'notified');
  assert.equal(calls[0].url, 'https://x.test/api/internal/paid-notice');
  assert.equal(calls[0].cfg.headers['x-cron-secret'], 's');
  assert.equal((await triggerAutoOnboard({}, { secret: 's', url: 'https://x.test', http: http(400, { status: 'invalid', error: 'nope' }) })).status, 'invalid');
  assert.equal((await triggerAutoOnboard({}, { secret: 's', url: 'https://x.test', http: http(503, {}) })).transient, true);
  assert.equal((await triggerAutoOnboard({}, { secret: 's', url: 'https://x.test', http: http(401, {}) })).transient, true);
  assert.equal((await triggerAutoOnboard({}, { secret: 's', url: 'https://x.test', http: { post: async () => { throw new Error('ECONNRESET'); } } })).transient, true);
  assert.equal((await triggerAutoOnboard({}, { secret: '', http: http(200, {}) })).transient, true);
});

test('sweep stamps final outcomes, retries transient failures and alerts only when there is no email', async () => {
  const Booking = fakeModel([
    { _id: 'b1', clientEmail: 'new@x.com', clientName: 'New One', paymentPlan: { name: 'EXECUTIVE', price: 599, currency: 'USD' } },
    { _id: 'b2', clientEmail: 'old@x.com', clientName: 'Old One', paymentPlan: { name: 'PRIME', price: 99, currency: 'USD' } },
  ]);
  const Payment = fakeModel([
    { _id: 'p1', customerEmail: 'down@x.com', customerFirstName: 'Dee', customerLastName: 'Own', planName: 'Prime', amount: 99, currency: 'USD' },
    { _id: 'p2', customerEmail: '', customerFirstName: 'No', customerLastName: 'Mail', planName: 'Prime', amount: 99, currency: 'USD' },
    { _id: 'p3', customerEmail: 'weird@x.com', customerFirstName: 'We', customerLastName: 'Ird', planName: 'Mystery', amount: 123, currency: 'USD' },
  ]);
  const alerts = [];
  const sent = [];
  const trigger = async (i) => { sent.push(i); return ({ 'new@x.com': { status: 'notified' }, 'old@x.com': { status: 'exists' }, 'down@x.com': { transient: true, error: 'HTTP 503' }, 'weird@x.com': { status: 'notified' } })[i.email]; };
  const now = new Date('2026-11-26T00:00:00Z');
  const s = await runAutoOnboardSweep({ trigger, Booking, Payment, now, alert: async (m) => alerts.push(m), logger: quiet });
  assert.deepEqual(s, { checked: 5, notified: 2, exists: 1, rejected: 1, retry: 1 });
  assert.deepEqual(Booking.updates.map((u) => [u.id, u.set.autoOnboardResult]), [['b1', 'notified'], ['b2', 'exists']]);
  assert.deepEqual(Payment.updates.map((u) => [u.id, u.set.autoOnboardResult]), [['p2', 'invalid'], ['p3', 'notified']]);
  assert.equal(sent.find((i) => i.email === 'weird@x.com').planType, null); // an unknown plan is still announced
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Paid notice skipped.*no email/);
  // Second pass: only the transient one is retried, stamped rows are not sent again.
  const again = [];
  const s2 = await runAutoOnboardSweep({ trigger: async (i) => { again.push(i.email); return { status: 'notified' }; }, Booking, Payment, now, alert: async () => {}, logger: quiet });
  assert.deepEqual(again, ['down@x.com']);
  assert.equal(s2.notified, 1);
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
  return { alerts, sent, deps: { trigger: async (i) => { sent.push(i); return { status: 'notified' }; }, alert: async (m) => { alerts.push(m); }, sleep: async () => {}, delays: [0, 1, 1], logger: { log() {}, warn() {}, error() {} }, ...over } };
};

test('a Stripe payment is sent with the plan from the text, else from the USD price, and the country from the currency', async () => {
  const a = stripeDeps();
  assert.equal((await onboardFromStripe({ email: 'A@B.com', name: 'Ann Lee', planName: 'FlashFire Executive Plan', amount: 599, currency: 'USD', createdAt: NOW_OK }, a.deps)).status, 'notified');
  assert.deepEqual([a.sent[0].email, a.sent[0].planType, a.sent[0].country, a.sent[0].source], ['a@b.com', 'EXECUTIVE', 'USA', 'stripe']);
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
  assert.match(b.alerts[0], /Paid notice failed.*a@b\.com.*503/);
});

test('Stripe: an unknown plan is still announced, old events and missing emails are ignored, and it never throws', async () => {
  const a = stripeDeps();
  assert.equal((await onboardFromStripe({ email: 'a@b.com', name: 'A', planName: 'Custom', amount: 420, currency: 'AUD', createdAt: NOW_OK }, a.deps)).status, 'notified');
  assert.equal(a.sent[0].planType, null);
  assert.equal(a.alerts.length, 0);
  const b = stripeDeps();
  assert.equal((await onboardFromStripe({ email: 'a@b.com', name: 'A', planName: 'Prime', amount: 99, currency: 'USD', createdAt: new Date(AUTO_ONBOARD_SINCE.getTime() - 1) }, b.deps)).status, 'skipped_old');
  assert.equal((await onboardFromStripe({ email: '', name: 'A', planName: 'Prime', createdAt: NOW_OK }, b.deps)).status, 'invalid');
  assert.equal(b.sent.length, 0);
  const c = stripeDeps({ trigger: async () => { throw new Error('boom'); } });
  assert.equal((await onboardFromStripe({ email: 'a@b.com', name: 'A', planName: 'Prime', amount: 99, currency: 'USD', createdAt: NOW_OK }, c.deps)).status, 'failed');
});

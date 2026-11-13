// Warning letters at 7, 10 and 15 missed meetings in a calendar month, counted from 13 Nov 2026: policy, drafting, sending, the API.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
isolateExternalServices();

import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { BdaWarningLetterModel } from '../Schema_Models/BdaWarningLetter.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { WARNING_LEVELS, composeLetter, dismissLetter, evaluateWarningLetters, levelForCount, nextThreshold, sendLetter, warningStandings, warningWindow } from '../Utils/WarningLetters.js';
import { registerWarningLetterRoutes } from '../Routes/warningLetterRoutes.js';

const BDA = 'warn-bda@test.local';
const OTHER = 'warn-other@test.local';
const ADMIN = 'warn-admin@test.local';
const BASE = '/api/crm/warning-letters';
const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-11-20T06:00:00Z');
let server;
let baseUrl;
let seq = 0;

const sign = (role, email) => jwt.sign({ role, email, name: email.split('@')[0] }, getCrmJwtSecret(), { expiresIn: '1h' });
async function call(method, path, { token = sign('crm_admin', ADMIN), body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

/** n active missed-meeting fines for a BDA, spread over the last few days, starting `daysAgo` ago. */
async function fines(email, n, { daysAgo = 2, status = 'active' } = {}) {
  const docs = Array.from({ length: n }, (_, i) => {
    seq += 1;
    const start = new Date(NOW.getTime() - daysAgo * DAY - i * 3600 * 1000);
    return { bookingId: `warn_bk_${seq}`, bdaEmail: email, rule: 'missed_meeting', month: '2026-11', amountInr: 500, tierIndex: i + 1, status, evidence: { scheduledStart: start, clientName: `Client ${seq}` } };
  });
  await BdaDeductionModel.create(docs);
}
const wipe = async () => {
  await Promise.all([
    BdaProfileModel.deleteMany({ email: { $in: [BDA, OTHER] } }),
    CrmUserModel.deleteMany({ email: ADMIN }),
    BdaDeductionModel.deleteMany({ bdaEmail: { $in: [BDA, OTHER] } }),
    BdaWarningLetterModel.deleteMany({ bdaEmail: { $in: [BDA, OTHER] } }),
  ]);
  invalidateRegistryCache();
};
const sent = [];
const deps = (extra = {}) => ({ sendMail: async (m) => { sent.push(m); }, ...extra });

before(async () => {
  await connectTestDb();
  await wipe();
  const app = express();
  app.use(express.json());
  registerWarningLetterRoutes(app);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await wipe();
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
});
beforeEach(async () => {
  await wipe();
  sent.length = 0;
  for (const [email, name] of [[BDA, 'Warn Bda'], [OTHER, 'Other Bda']]) {
    await BdaProfileModel.create({ email, displayName: name, firstName: name.split(' ')[0].toLowerCase(), tracked: true, active: true, trackedSince: new Date('2026-01-02') });
  }
  await CrmUserModel.create({ email: ADMIN, name: 'Warn Admin', role: 'admin', isAdmin: true, isActive: true });
  invalidateRegistryCache();
});

describe('policy', () => {
  it('maps a count to the level it reaches', () => {
    assert.deepEqual([0, 6, 7, 9, 10, 14, 15, 44].map(levelForCount), [0, 0, 1, 1, 2, 2, 3, 3]);
    assert.deepEqual([0, 6, 7, 10, 15, 16].map(nextThreshold), [7, 7, 10, 15, null, null]);
    assert.deepEqual(WARNING_LEVELS.map((l) => l.threshold), [7, 10, 15]);
  });

  it('writes a plain and an HTML letter that name the count, the window and each meeting', () => {
    const missed = [{ clientName: 'Pavel <b>Novak</b>', scheduledStart: new Date('2026-11-10T20:00:00Z'), amountInr: 500 }];
    const l = composeLetter({ level: 2, bdaName: 'Warn Bda', missedCount: 10, windowFrom: new Date('2026-11-12T18:30:00Z'), windowTo: NOW, windowLabel: 'November 2026', missed, totalAmountInr: 5000 });
    assert.match(l.subject, /^Second warning: 10 missed meetings in November 2026$/);
    assert.match(l.bodyText, /Hi Warn,/);
    assert.match(l.bodyText, /₹5,000/);
    assert.match(l.bodyText, /Pavel <b>Novak<\/b>/, 'plain text is not escaped');
    assert.ok(l.bodyHtml.includes('Pavel &lt;b&gt;Novak&lt;/b&gt;'), 'HTML escapes a client name');
    assert.ok(!/—/.test(l.bodyText + l.bodyHtml), 'no em dashes');
    assert.throws(() => composeLetter({ level: 9, bdaName: 'x', missedCount: 1, windowFrom: NOW, windowTo: NOW, missed: [], totalAmountInr: 0 }));
  });
});

describe('evaluateWarningLetters', () => {
  it('writes nothing below 7, and one draft letter at 7 with the admins copied', async () => {
    await fines(BDA, 6);
    assert.equal((await evaluateWarningLetters(NOW, deps({ mode: 'draft' }))).created.length, 0);
    await fines(BDA, 1);
    const r = await evaluateWarningLetters(NOW, deps({ mode: 'draft' }));
    assert.equal(r.created.length, 1);
    const letter = await BdaWarningLetterModel.findOne({ bdaEmail: BDA }).lean();
    assert.equal(letter.level, 1);
    assert.equal(letter.status, 'draft');
    assert.equal(letter.missedCount, 7);
    assert.equal(letter.totalAmountInr, 3500);
    assert.equal(letter.missed.length, 7);
    assert.equal(letter.toEmail, BDA);
    assert.ok(letter.ccEmails.includes(ADMIN), 'the admins are copied');
    assert.ok(!letter.ccEmails.includes(BDA), 'the BDA is not copied on their own letter');
    assert.equal(sent.length, 0, 'a draft sends nothing');
  });

  it('does not write the same level twice, escalates to the next, and skips levels it jumps over', async () => {
    await fines(BDA, 7);
    await evaluateWarningLetters(NOW, deps({ mode: 'draft' }));
    assert.equal((await evaluateWarningLetters(NOW, deps({ mode: 'draft' }))).created.length, 0, 'second run, same level');
    await fines(BDA, 3, { daysAgo: 3 });
    assert.equal((await evaluateWarningLetters(NOW, deps({ mode: 'draft' }))).created.length, 1, 'ten misses: the 2nd letter');
    await fines(OTHER, 12);
    await evaluateWarningLetters(NOW, deps({ mode: 'draft' }));
    const others = await BdaWarningLetterModel.find({ bdaEmail: OTHER }).lean();
    assert.deepEqual(others.map((l) => l.level), [2], 'twelve misses with no earlier letter gets only the 2nd, not the 1st too');
    assert.deepEqual((await BdaWarningLetterModel.find({ bdaEmail: BDA }).sort({ level: 1 }).lean()).map((l) => l.level), [1, 2]);
  });

  it('counts only active fines from the launch day to the end of the month', async () => {
    await fines(BDA, 5);
    await fines(BDA, 5, { status: 'waived' });
    await fines(BDA, 5, { status: 'needs_review' });
    await fines(BDA, 5, { daysAgo: 10 }); // 10 Nov, before counting starts on 13 Nov
    await fines(BDA, 5, { daysAgo: 45 });
    assert.equal((await evaluateWarningLetters(NOW, deps({ mode: 'draft' }))).created.length, 0);
    const standing = (await warningStandings(NOW)).find((s) => s.bdaEmail === BDA);
    assert.equal(standing.missedCount, 5);
    assert.equal(standing.nextThreshold, 7);
  });

  it('starts counting on 13 Nov, the launch day, and not before', async () => {
    const win = warningWindow(NOW);
    assert.equal(win.from.toISOString(), '2026-11-12T18:30:00.000Z', '13 Nov 00:00 IST');
    assert.equal(win.to.toISOString(), '2026-11-30T18:29:59.999Z', '30 Nov 23:59:59 IST');
    assert.equal(win.label, 'November 2026');
    assert.equal(warningWindow(new Date('2026-11-12T10:00:00Z')), null, 'nothing before the launch day');
    await fines(BDA, 7, { daysAgo: 10 });
    assert.equal((await evaluateWarningLetters(new Date('2026-11-12T10:00:00Z'), deps({ mode: 'draft' }))).created.length, 0);
    assert.equal((await evaluateWarningLetters(NOW, deps({ mode: 'draft' }))).created.length, 0, 'seven old misses do not count');
  });

  it('starts a fresh count each calendar month, 1 to 31 December', async () => {
    const dec = warningWindow(new Date('2026-12-05T06:00:00Z'));
    assert.equal(dec.from.toISOString(), '2026-11-30T18:30:00.000Z', '1 Dec 00:00 IST');
    assert.equal(dec.to.toISOString(), '2026-12-31T18:29:59.999Z');
    assert.equal(dec.label, 'December 2026');
    await fines(BDA, 7);
    await evaluateWarningLetters(NOW, deps({ mode: 'draft' }));
    const decNow = new Date(NOW.getTime() + 15 * DAY);
    assert.equal((await warningStandings(decNow)).find((s) => s.bdaEmail === BDA).missedCount, 0, 'November misses do not carry into December');
    assert.equal((await evaluateWarningLetters(decNow, deps({ mode: 'draft' }))).created.length, 0);
    await fines(BDA, 7, { daysAgo: -15 });
    assert.equal((await evaluateWarningLetters(decNow, deps({ mode: 'draft' }))).created.length, 1, 'a new month, a new letter');
    const letters = await BdaWarningLetterModel.find({ bdaEmail: BDA }).sort({ createdAt: 1 }).lean();
    assert.match(letters[1].subject, /in December 2026$/);
  });

  it('writes again after a dismissed letter, and posts nothing to Discord', async () => {
    await fines(BDA, 7);
    await evaluateWarningLetters(NOW, deps({ mode: 'draft' }));
    const first = await BdaWarningLetterModel.findOne({ bdaEmail: BDA });
    await dismissLetter(first.letterId, ADMIN, 'counted wrongly');
    assert.equal((await evaluateWarningLetters(NOW, deps({ mode: 'draft' }))).created.length, 1, 'a dismissed letter does not block');
  });

  it('off writes nothing and live sends at once', async () => {
    await fines(BDA, 7);
    assert.equal((await evaluateWarningLetters(NOW, deps({ mode: 'off' }))).created.length, 0);
    const r = await evaluateWarningLetters(NOW, deps({ mode: 'live' }));
    assert.equal(r.sent.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, BDA);
    assert.ok(sent[0].cc.includes(ADMIN));
    assert.match(sent[0].subject, /First warning/);
    const letter = await BdaWarningLetterModel.findOne({ bdaEmail: BDA }).lean();
    assert.equal(letter.status, 'sent');
    assert.equal(letter.sentBy, 'system');
  });
});

describe('sending and dismissing', () => {
  async function draft() {
    await fines(BDA, 7);
    await evaluateWarningLetters(NOW, deps({ mode: 'draft' }));
    return BdaWarningLetterModel.findOne({ bdaEmail: BDA }).lean();
  }

  it('sends a draft once, records who sent it, and refuses a second send', async () => {
    const l = await draft();
    const r = await sendLetter(l.letterId, ADMIN, deps());
    assert.equal(r.ok, true);
    assert.equal(r.letter.status, 'sent');
    assert.equal(r.letter.sentBy, ADMIN);
    const again = await sendLetter(l.letterId, ADMIN, deps());
    assert.equal(again.status, 409);
    assert.equal(sent.length, 1);
  });

  it('records a failed send, keeps the error, and lets it be retried', async () => {
    const l = await draft();
    const bad = await sendLetter(l.letterId, ADMIN, { sendMail: async () => { throw new Error('mailbox full'); } });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'send_failed');
    const row = await BdaWarningLetterModel.findOne({ letterId: l.letterId }).lean();
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'mailbox full');
    assert.equal((await sendLetter(l.letterId, ADMIN, deps())).ok, true, 'a failed letter can be sent again');
  });

  it('dismisses a draft but not a sent letter, and 404s an unknown one', async () => {
    const l = await draft();
    assert.equal((await dismissLetter(l.letterId, ADMIN, 'duplicate')).letter.status, 'dismissed');
    assert.equal((await sendLetter(l.letterId, ADMIN, deps())).status, 409, 'a dismissed letter cannot be sent');
    assert.equal((await dismissLetter('nope', ADMIN, null)).status, 404);
  });
});

describe('API', () => {
  it('needs a token, and only an admin can send, dismiss or evaluate', async () => {
    assert.equal((await call('GET', BASE, { token: null })).status, 401);
    const bda = sign('crm_user', BDA);
    assert.equal((await call('POST', `${BASE}/evaluate`, { token: bda })).status, 403);
    assert.equal((await call('POST', `${BASE}/x/send`, { token: bda })).status, 403);
    assert.equal((await call('POST', `${BASE}/x/dismiss`, { token: bda })).status, 403);
  });

  it('an admin sees every letter and the standings; a BDA sees only their own sent letters', async () => {
    await fines(BDA, 7);
    await fines(OTHER, 8);
    await evaluateWarningLetters(NOW, deps({ mode: 'draft' }));
    const mine = await BdaWarningLetterModel.findOne({ bdaEmail: BDA }).lean();

    const admin = await call('GET', BASE);
    assert.equal(admin.status, 200);
    assert.equal(admin.body.letters.length, 2);
    assert.equal(admin.body.draftCount, 2);
    assert.deepEqual(admin.body.policy.map((p) => p.threshold), [7, 10, 15]);
    assert.ok(admin.body.standings.some((s) => s.bdaEmail === BDA && s.missedCount >= 0));

    const before = await call('GET', BASE, { token: sign('crm_user', BDA) });
    assert.equal(before.body.letters.length, 0, 'a draft is not shown to the BDA');
    assert.equal((await call('GET', `${BASE}?bdaEmail=${OTHER}`, { token: sign('crm_user', BDA) })).status, 403);

    await sendLetter(mine.letterId, ADMIN, deps());
    const after = await call('GET', BASE, { token: sign('crm_user', BDA) });
    assert.equal(after.body.letters.length, 1);
    assert.equal(after.body.letters[0].bdaEmail, BDA);
    assert.equal(after.body.letters[0].status, 'sent');
    assert.equal((await call('GET', `${BASE}?status=weird`)).status, 422);
  });

  it('dismiss and an unknown letter answer with the right codes', async () => {
    await fines(BDA, 7);
    await evaluateWarningLetters(NOW, deps({ mode: 'draft' }));
    const l = await BdaWarningLetterModel.findOne({ bdaEmail: BDA }).lean();
    const d = await call('POST', `${BASE}/${l.letterId}/dismiss`, { body: { note: 'counted wrongly' } });
    assert.equal(d.status, 200);
    assert.equal(d.body.letter.status, 'dismissed');
    assert.equal(d.body.letter.dismissNote, 'counted wrongly');
    assert.equal((await call('POST', `${BASE}/${l.letterId}/dismiss`)).status, 409);
    assert.equal((await call('POST', `${BASE}/nope/send`)).status, 404);
  });
});

// Unsubscribe links: signed per address, a GET only shows a page, a POST records it. No database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { unsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl, unsubscribeParts } from '../Utils/Unsubscribe.js';
import { registerUnsubscribeRoutes } from '../Routes/unsubscribeRoutes.js';

const SECRET = 'test-secret-test-secret-test-secret';

describe('unsubscribe token', () => {
  it('is tied to the address, ignoring case and spaces', () => {
    const t = unsubscribeToken('Asha@Example.com ', SECRET);
    assert.ok(verifyUnsubscribeToken('asha@example.com', t, SECRET));
    assert.equal(verifyUnsubscribeToken('other@example.com', t, SECRET), false);
    assert.equal(verifyUnsubscribeToken('asha@example.com', t + 'x', SECRET), false);
    assert.equal(verifyUnsubscribeToken('asha@example.com', undefined, SECRET), false);
  });
  it('makes no link without a secret', () => {
    assert.equal(unsubscribeToken('a@b.co', null), null);
    assert.equal(unsubscribeUrl('a@b.co', 'https://api.test', null), null);
  });
  it('builds a link on the backend host and the mail headers', () => {
    const url = unsubscribeUrl('asha@example.com', 'https://api.test', SECRET);
    assert.match(url, /^https:\/\/api\.test\/unsubscribe\?e=asha%40example\.com&t=/);
    const prev = process.env.UNSUBSCRIBE_SECRET;
    process.env.UNSUBSCRIBE_SECRET = SECRET;
    try {
      const p = unsubscribeParts('asha@example.com');
      assert.match(p.html, /href="https:\/\/api\.flashfirejobs\.com\/unsubscribe\?e=/);
      assert.match(p.html, />Unsubscribe</);
      assert.equal(p.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      assert.doesNotMatch(p.html, /asm_group/);
    } finally { if (prev === undefined) delete process.env.UNSUBSCRIBE_SECRET; else process.env.UNSUBSCRIBE_SECRET = prev; }
  });
});

describe('unsubscribe routes', () => {
  let server, base; const saved = new Set();
  before(async () => {
    const app = express();
    registerUnsubscribeRoutes(app, {
      verify: (e, t) => verifyUnsubscribeToken(e, t, SECRET),
      record: async (e) => { saved.add(e); },
      isUnsubscribed: async (e) => saved.has(e),
    });
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  const q = (e, t = unsubscribeToken(e, SECRET)) => `/unsubscribe?e=${encodeURIComponent(e)}&t=${encodeURIComponent(t)}`;

  it('shows a confirm button on GET and does not unsubscribe', async () => {
    const res = await fetch(base + q('asha@example.com'));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<button type="submit">Unsubscribe<\/button>/);
    assert.equal(saved.size, 0);
  });
  it('unsubscribes on POST, including the one-click form body', async () => {
    const res = await fetch(base + q('asha@example.com'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(res.status, 200);
    assert.ok(saved.has('asha@example.com'));
    const again = await fetch(base + q('asha@example.com'));
    assert.match(await again.text(), /You are unsubscribed/);
  });
  it('answers 400 for a wrong token and never saves it', async () => {
    const res = await fetch(base + q('bob@example.com', 'nope'), { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(saved.has('bob@example.com'), false);
  });
  it('escapes the address on the page', async () => {
    const e = '"><script>x</script>@a.co';
    const res = await fetch(base + q(e));
    const html = await res.text();
    assert.doesNotMatch(html, /<script>x/);
  });
});

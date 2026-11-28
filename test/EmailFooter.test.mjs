// Workflow email footer: signature on completed-meeting emails, unsubscribe link on all. No database.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.UNSUBSCRIBE_SECRET = 'test-secret-test-secret-test-secret';
process.env.PUBLIC_API_URL = 'https://api.example.test';
const { emailFooter, applyEmailFooter, bdaNameFor, isCompletedMeeting } = await import('../Utils/EmailFooter.js');

const done = { clientEmail: 'lead@x.test', bookingStatus: 'completed', calendlyHost: { name: 'Kalpataru Samal' } };
const upcoming = { clientEmail: 'lead@x.test', bookingStatus: 'scheduled', calendlyHost: { name: 'Kalpataru Samal' } };

describe('email footer', () => {
  it('picks the BDA name from the host, then the original BDA, then the claimer', () => {
    assert.equal(bdaNameFor(done), 'Kalpataru Samal');
    assert.equal(bdaNameFor({ originalBda: { name: 'Sid' } }), 'Sid');
    assert.equal(bdaNameFor({ claimedBy: { name: 'Ritika' } }), 'Ritika');
    assert.equal(bdaNameFor({}), '');
  });
  it('knows a completed meeting by status or by the completing trigger', () => {
    assert.equal(isCompletedMeeting(done), true);
    assert.equal(isCompletedMeeting(upcoming, 'complete'), true);
    assert.equal(isCompletedMeeting(upcoming), false);
  });
  it('signs completed-meeting emails with the BDA name and always adds the unsubscribe link', () => {
    const f = emailFooter(done);
    assert.match(f.html, /Best regards,<br><strong>Kalpataru Samal<\/strong>/);
    assert.match(f.html, /https:\/\/api\.example\.test\/unsubscribe\?/);
    assert.match(f.text, /Best regards,\nKalpataru Samal/);
    assert.ok(f.headers['List-Unsubscribe']);
  });
  it('adds only the unsubscribe link when the meeting is not done yet', () => {
    const f = emailFooter(upcoming);
    assert.doesNotMatch(f.html, /Best regards/);
    assert.match(f.html, /Unsubscribe/);
  });
  it('escapes a hostile BDA name', () => {
    const f = emailFooter({ ...done, calendlyHost: { name: '<img src=x onerror=1>' } });
    assert.doesNotMatch(f.html, /<img/);
  });
  it('writes the footer into a designed email and turns SendGrid tracking off', () => {
    const msg = applyEmailFooter({ to: 'lead@x.test', html: '<p>Hi</p>' }, done, { designed: true });
    assert.match(msg.html, /^<p>Hi<\/p>.*Kalpataru Samal.*Unsubscribe/s);
    assert.equal(msg.trackingSettings.subscriptionTracking.enable, false);
    assert.ok(msg.headers['List-Unsubscribe-Post']);
  });
  it('puts the footer in SendGrid\'s footer slot for a dynamic template', () => {
    const msg = applyEmailFooter({ to: 'lead@x.test', templateId: 'd-123' }, done, { designed: false });
    const t = msg.trackingSettings.subscriptionTracking;
    assert.equal(t.enable, true);
    assert.match(t.html, /Kalpataru Samal/);
    assert.match(t.text, /Unsubscribe: https:/);
  });
});

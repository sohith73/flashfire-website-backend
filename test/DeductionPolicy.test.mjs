import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEDUCTION_POLICY, getDeductionsMode, getLiveFrom, getStatusDeadlineMs, missedMeetingAmount,
  monthBoundsIST, monthKeyIST,
} from '../Utils/deductionPolicy.js';
import {
  buildTotals, formatDailySummary, formatDeductionMessage, judgeMissedMeeting, judgeNoShowNotCalled,
  judgeStatusNotUpdated, planTiers,
} from '../Utils/DeductionEngine.js';

// Pure logic only: no database, no network.

const SID = 'siddhartha@flashfirehq.com';
const KAL = 'kalpataru@flashfirehq.com';
const START = new Date('2026-10-01T10:00:00.000Z');
const at = (min) => new Date(START.getTime() + min * 60000);
const tracked = (email) => ({ email, active: true, tracked: true, leaveDays: [] });

const booking = (over = {}) => ({
  bookingId: 'pol-b1',
  scheduledEventStartTime: START,
  bookingStatus: 'no-show',
  clientPhone: '+1 777 013 0001',
  normalizedClientPhone: '7770130001',
  calendlyHost: { email: SID },
  statusHistory: [],
  ...over,
});

const ENV_KEYS = ['DEDUCTIONS_MODE', 'DEDUCTIONS_LIVE_FROM', 'DEDUCTIONS_STATUS_DEADLINE_MIN'];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

describe('policy readers', () => {
  it('DEDUCTIONS_MODE defaults to off and re-reads the environment on every call', () => {
    assert.equal(getDeductionsMode(), 'off');
    process.env.DEDUCTIONS_MODE = 'shadow';
    assert.equal(getDeductionsMode(), 'shadow');
    process.env.DEDUCTIONS_MODE = ' LIVE ';
    assert.equal(getDeductionsMode(), 'live');
    process.env.DEDUCTIONS_MODE = 'on';
    assert.equal(getDeductionsMode(), 'off', 'an unknown value never turns fines on');
  });

  it('DEDUCTIONS_LIVE_FROM: unset or junk is null, a bare date is 00:00 IST, a full ISO keeps its offset', () => {
    assert.equal(getLiveFrom(), null);
    process.env.DEDUCTIONS_LIVE_FROM = 'soon';
    assert.equal(getLiveFrom(), null);
    process.env.DEDUCTIONS_LIVE_FROM = '2026-11-01';
    assert.equal(getLiveFrom().toISOString(), '2026-10-31T18:30:00.000Z');
    process.env.DEDUCTIONS_LIVE_FROM = '2026-11-01T00:00:00Z';
    assert.equal(getLiveFrom().toISOString(), '2026-11-01T00:00:00.000Z');
  });

  it('status deadline defaults to 2 h and can be overridden in minutes', () => {
    assert.equal(getStatusDeadlineMs(), 2 * 3600 * 1000);
    process.env.DEDUCTIONS_STATUS_DEADLINE_MIN = '90';
    assert.equal(getStatusDeadlineMs(), 90 * 60000);
  });

  it('holds the amounts from plan 2.5 in one frozen object', () => {
    assert.equal(DEDUCTION_POLICY.missedMeeting.baseAmountInr, 500);
    assert.equal(DEDUCTION_POLICY.missedMeeting.escalatedAmountInr, 1000);
    assert.equal(DEDUCTION_POLICY.missedMeeting.tierSize, 5);
    assert.equal(DEDUCTION_POLICY.noShowNotCalled.amountInr, 100);
    assert.equal(DEDUCTION_POLICY.noShowNotCalled.callWindowMs, 30 * 60000);
    assert.equal(DEDUCTION_POLICY.statusNotUpdated.amountInr, 50);
    assert.equal(DEDUCTION_POLICY.rejudgeWindowMs, 60 * 86400000);
    assert.throws(() => { 'use strict'; DEDUCTION_POLICY.missedMeeting.baseAmountInr = 1; }, TypeError);
  });

  it('prices tiers 1 to 5 at 500 and 6 onward at 1000', () => {
    assert.deepEqual([1, 5, 6, 9].map(missedMeetingAmount), [500, 500, 1000, 1000]);
  });
});

describe('IST month boundaries', () => {
  it('23:59 IST on the 31st and 00:01 IST on the 1st are different months', () => {
    assert.equal(monthKeyIST(new Date('2026-10-31T18:29:00Z')), '2026-10'); // 23:59 IST on 31 Oct
    assert.equal(monthKeyIST(new Date('2026-10-31T18:31:00Z')), '2026-11'); // 00:01 IST on 1 Nov
  });

  it('month bounds are 00:00 IST to 00:00 IST, and a bad key is null', () => {
    const b = monthBoundsIST('2026-10');
    assert.equal(b.start.toISOString(), '2026-09-30T18:30:00.000Z');
    assert.equal(b.end.toISOString(), '2026-10-31T18:30:00.000Z');
    assert.equal(monthBoundsIST('2026-13'), null);
    assert.equal(monthBoundsIST('oct'), null);
  });
});

describe('planTiers', () => {
  const row = (n, status = 'active', over = {}) => ({
    deductionId: `d${n}`,
    status,
    tierIndex: null,
    amountInr: 500,
    evidence: { scheduledStart: new Date(Date.UTC(2026, 9, n, 10)) },
    ...over,
  });
  const total = (plan, status = 'active') => plan.filter((p) => p.status === status).reduce((s, p) => s + p.amountInr, 0);

  it('7 misses cost 500 x 5 + 1000 x 2 = 4500', () => {
    const plan = planTiers([1, 2, 3, 4, 5, 6, 7].map((n) => row(n)));
    assert.deepEqual(plan.map((p) => p.amountInr), [500, 500, 500, 500, 500, 1000, 1000]);
    assert.deepEqual(plan.map((p) => p.tierIndex), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(total(plan), 4500);
  });

  it('orders by scheduledStart, not by input order', () => {
    const plan = planTiers([row(7), row(1), row(3)]);
    assert.deepEqual(plan.map((p) => [p.deductionId, p.tierIndex]), [['d1', 1], ['d3', 2], ['d7', 3]]);
  });

  it('a waived row drops out and the later ones re-price (waive the 2nd of 7: 3500)', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => row(n, n === 2 ? 'waived' : 'active'));
    const plan = planTiers(rows);
    assert.equal(plan.length, 6);
    assert.equal(total(plan), 3500);
    assert.equal(plan.find((p) => p.deductionId === 'd7').amountInr, 1000);
    assert.equal(plan.find((p) => p.deductionId === 'd6').amountInr, 500);
  });

  it('needs_review and voided rows never count toward the tier', () => {
    const plan = planTiers([row(1), row(2, 'needs_review'), row(3, 'voided'), row(4)]);
    assert.deepEqual(plan.filter((p) => p.status === 'active').map((p) => p.tierIndex), [1, 2]);
    assert.equal(plan.length, 2);
  });

  it('shadow rows are projected among themselves and never shift real tiers', () => {
    const plan = planTiers([row(1, 'shadow'), row(2, 'shadow'), row(3)]);
    assert.equal(plan.find((p) => p.deductionId === 'd3').tierIndex, 1);
    assert.deepEqual(plan.filter((p) => p.status === 'shadow').map((p) => p.tierIndex), [1, 2]);
  });

  it('is a deterministic recompute: planning its own output again changes nothing', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => row(n));
    const first = planTiers(rows);
    const applied = rows.map((r, i) => ({ ...r, tierIndex: first[i].tierIndex, amountInr: first[i].amountInr }));
    assert.ok(planTiers(applied).every((p) => p.changed === false));
  });
});

describe('flat 500 per missed meeting from 22 Oct 2026', () => {
  const FLAT = DEDUCTION_POLICY.missedMeeting.flatFromMs;
  const row = (id, startMs, status = 'active') => ({ deductionId: id, status, tierIndex: null, amountInr: 500, evidence: { scheduledStart: new Date(startMs) } });

  it('starts at midnight IST on 22 Oct and the amount for a meeting uses its own start', () => {
    assert.equal(new Date(FLAT).toISOString(), '2026-10-21T18:30:00.000Z');
    assert.equal(missedMeetingAmount(7), 1000, 'no start given: the old tiers');
    assert.equal(missedMeetingAmount(7, FLAT - 1), 1000, 'the last millisecond before the date keeps the old tiers');
    assert.equal(missedMeetingAmount(7, FLAT), 500);
    assert.equal(missedMeetingAmount(30, FLAT + 86_400_000), 500, 'never escalates after that');
    assert.equal(missedMeetingAmount(6, Date.UTC(2026, 9, 1)), 1000);
  });

  it('a month of only flat meetings is 500 each, however many', () => {
    const plan = planTiers(Array.from({ length: 9 }, (_, i) => row(`f${i}`, FLAT + i * 3_600_000)));
    assert.ok(plan.every((p) => p.amountInr === 500));
    assert.deepEqual(plan.map((p) => p.tierIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'the count is still shown');
    assert.equal(total(plan), 4500);
  });

  it('a month that crosses the date keeps the old charges before it and is flat after it', () => {
    const before = Array.from({ length: 7 }, (_, i) => row(`b${i}`, FLAT - (8 - i) * 86_400_000));
    const after = Array.from({ length: 3 }, (_, i) => row(`a${i}`, FLAT + i * 3_600_000));
    const plan = planTiers([...after, ...before]);
    assert.deepEqual(plan.map((p) => p.amountInr), [500, 500, 500, 500, 500, 1000, 1000, 500, 500, 500]);
    assert.equal(total(plan), 6000, '5 x 500 + 2 x 1000 + 3 x 500');
  });

  it('waiving an earlier meeting never changes a flat one', () => {
    const rows = [row('b1', FLAT - 3 * 86_400_000), row('b2', FLAT - 2 * 86_400_000, 'waived'), row('a1', FLAT + 1000)];
    assert.deepEqual(planTiers(rows).map((p) => p.amountInr), [500, 500]);
  });

  function total(plan) { return plan.reduce((sum, p) => sum + p.amountInr, 0); }
});

describe('buildTotals', () => {
  it('counts active rows only, per rule', () => {
    const t = buildTotals([
      { rule: 'missed_meeting', amountInr: 500, status: 'active' },
      { rule: 'missed_meeting', amountInr: 500, status: 'needs_review' },
      { rule: 'missed_meeting', amountInr: 500, status: 'shadow' },
      { rule: 'no_show_not_called', amountInr: 100, status: 'active' },
      { rule: 'status_not_updated', amountInr: 50, status: 'waived' },
    ]);
    assert.equal(t.activeAmountInr, 600);
    assert.deepEqual(t.byRule.missed_meeting, { count: 1, amountInr: 500 });
    assert.deepEqual(t.byRule.status_not_updated, { count: 0, amountInr: 0 });
  });
});

describe('judgeNoShowNotCalled', () => {
  const profile = tracked(SID);
  const noCalls = { calls: 0, calledWithin30Min: false };
  const judge = (over = {}) => judgeNoShowNotCalled({
    booking: booking(), profile, summary: noCalls, nowMs: at(45).getTime(), ...over,
  });

  it('fines a no-show with no call in the window once the health window (start + 40 min) is over', () => {
    assert.equal(judge().fine, true);
    assert.equal(judge({ nowMs: at(35).getTime() }).reason, 'too_early');
  });

  it('a call at +29 min means no fine, a call at +31 min does not help', () => {
    assert.equal(judge({ summary: { calls: 1, calledWithin30Min: true } }).fine, false);
    assert.equal(judge({ summary: { calls: 1, calledWithin30Min: false } }).fine, true);
  });

  it('unknown call data is never a fine', () => {
    assert.equal(judge({ summary: undefined }).reason, 'call_data_unknown');
  });

  it('needs a phone number a call could actually be linked to', () => {
    // No number at all, and numbers with no usable key: a call the BDA really made could never link, so no fine.
    for (const [clientPhone, normalizedClientPhone] of [[null, null], ['N/A', null], ['---', null], ['12345', null]]) {
      const r = judge({ booking: booking({ clientPhone, normalizedClientPhone }) });
      assert.equal(r.fine, false, `clientPhone ${clientPhone}`);
      assert.equal(r.reason, 'no_callable_phone', `clientPhone ${clientPhone}`);
    }
    // A normal number still gets judged, and so does one with an extension: the extension is stripped, so the call links.
    assert.equal(judge({ booking: booking({ clientPhone: '+1 415 555 0100', normalizedClientPhone: '4155550100' }) }).fine, true);
    assert.equal(judge({ booking: booking({ clientPhone: '+1 415 555 0100 x123', normalizedClientPhone: '550100x123' }) }).fine, true, 'a corrupted stored key is recomputed');
  });

  it('keeps judging for 60 days and stops after', () => {
    assert.equal(judge({ nowMs: at(3 * 24 * 60).getTime() }).fine, true);
    assert.equal(judge({ nowMs: at(61 * 24 * 60).getTime() }).reason, 'outside_rejudge_window');
  });

  it('only for a countable meeting of the tracked, assigned BDA', () => {
    assert.equal(judge({ profile: null }).reason, 'not_tracked');
    assert.equal(judge({ profile: { ...profile, leaveDays: ['2026-10-01'] } }).reason, 'on_leave');
    assert.equal(judge({ booking: booking({ calendlyHost: null }) }).reason, 'unassigned');
    assert.equal(judge({ booking: booking({ bookingStatus: 'completed' }) }).reason, 'not_no_show');
  });
});

describe('judgeStatusNotUpdated', () => {
  const profile = tracked(SID);
  const deadlineMs = 2 * 3600 * 1000;
  const judge = (over = {}) => judgeStatusNotUpdated({
    booking: booking({ bookingStatus: 'scheduled' }), profile, nowMs: at(125).getTime(), deadlineMs, ...over,
  });

  it('fines a meeting still scheduled at start + 2 h, not before', () => {
    assert.equal(judge().fine, true);
    assert.equal(judge({ nowMs: at(119).getTime() }).reason, 'before_deadline');
  });

  it('a change away from scheduled before the deadline satisfies the rule', () => {
    const b = booking({
      bookingStatus: 'completed',
      statusHistory: [{ status: 'completed', previousStatus: 'scheduled', changedAt: at(90) }],
    });
    assert.equal(judge({ booking: b }).reason, 'status_updated_in_time');
  });

  it('a change after the deadline does not undo the fine', () => {
    const b = booking({
      bookingStatus: 'completed',
      statusHistory: [{ status: 'completed', previousStatus: 'scheduled', changedAt: at(180) }],
    });
    assert.equal(judge({ booking: b }).fine, true);
  });
});

describe('judgeMissedMeeting', () => {
  it('only the assigned BDA is fined, a colleague never is', () => {
    const profile = tracked(SID);
    assert.equal(judgeMissedMeeting({ booking: booking(), profile, bdaEmail: SID, nowMs: at(5).getTime() }).fine, true);
    assert.equal(judgeMissedMeeting({ booking: booking(), profile, bdaEmail: KAL, nowMs: at(5).getTime() }).reason, 'not_assigned');
  });

  it('a meeting canceled before it started is not countable', () => {
    const b = booking({
      bookingStatus: 'canceled',
      statusHistory: [{ status: 'canceled', previousStatus: 'scheduled', changedAt: at(-60) }],
    });
    assert.equal(judgeMissedMeeting({ booking: b, profile: tracked(SID), bdaEmail: SID, nowMs: at(5).getTime() }).fine, false);
  });
});

describe('Discord wording', () => {
  const base = { rule: 'no_show_not_called', amountInr: 100, status: 'active', evidence: { scheduledStart: new Date('2026-10-08T11:00:00Z') } };

  it('matches the plan example and mentions the BDA when a Discord id is set', () => {
    const text = formatDeductionMessage(base, { name: 'Kalpataru', client: 'Test Client', mention: '<@1234567890123456>' });
    assert.equal(text, '<@1234567890123456> ₹100 deduction, Kalpataru: Test Client was a no-show at 4:30 PM IST and no Zoom call to them was found within 30 min.');
    assert.ok(!text.includes(String.fromCharCode(0x2014)), 'no em dash');
  });

  it('says plainly when a row is shadow or under review, and does not mention the BDA there', () => {
    const shadow = formatDeductionMessage({ ...base, status: 'shadow' }, { name: 'Kalpataru', client: 'Test Client', mention: '<@1>' });
    assert.ok(shadow.startsWith('[shadow, not counted]'));
    assert.ok(!shadow.includes('<@1>'));
    const review = formatDeductionMessage({ ...base, status: 'needs_review' }, { name: 'Kalpataru', client: 'X', mention: '<@1>' });
    assert.ok(review.startsWith('[held for review, not counted yet]'));
    assert.ok(!review.includes('<@1>'));
  });

  // 2026-11-05: every held row said "source data was unhealthy" while the data was healthy and a colleague had
  // covered the call. The reason is now read from the evidence.
  it('a held row says WHY it is held, never a generic "unhealthy"', () => {
    const covered = [{ bdaEmail: 'kal@x.com', bdaName: 'Kalpataru', minutes: 12, source: 'google_meet' }];
    const held = (rule, evidence) =>
      formatDeductionMessage({ ...base, rule, status: 'needs_review', evidence: { ...base.evidence, healthy: true, ...evidence } }, { name: 'Ritika', client: 'Vipul' });

    assert.equal(
      held('no_show_not_called', { coveredBy: covered }),
      '[held for review: Kalpataru (12 min) was in the Google Meet call, so calling the client may have been theirs, not counted yet] ₹100 deduction, Ritika: Vipul was a no-show at 4:30 PM IST and no Zoom call to them was found within 30 min.'
    );
    assert.match(held('status_not_updated', { coveredBy: covered }), /^\[held for review: Kalpataru \(12 min\) was in the Google Meet call, so updating the status may have been theirs, not counted yet\]/);
    assert.match(held('missed_meeting', { coveredBy: [...covered, { bdaEmail: 's@x.com', bdaName: 'Siddhartha', minutes: 5, source: 'extension' }] }), /Kalpataru \(12 min\) and Siddhartha \(5 min\) were in the Google Meet call instead/);
    assert.match(held('missed_meeting', { unattributedStaff: [{ displayName: 'Flashfire Team' }] }), /a shared team account \(Flashfire Team\) was in the Google Meet call/);
    assert.match(held('missed_meeting', { extensionInCall: { at: new Date() } }), /extension reported them in the call, but Google Meet did not/);
    assert.match(held('no_show_not_called', { healthy: false }), /the Zoom call log was not syncing during the call window/);
    assert.match(held('missed_meeting', { healthy: false }), /the Google Meet attendance sync was not running/);
    for (const rule of ['no_show_not_called', 'status_not_updated', 'missed_meeting']) {
      assert.ok(!held(rule, { coveredBy: covered }).includes('unhealthy'));
    }
  });

  it('a missed meeting says whether the BDA never joined or left too early', () => {
    const miss = (evidence) =>
      formatDeductionMessage({ rule: 'missed_meeting', amountInr: 500, status: 'active', evidence: { scheduledStart: base.evidence.scheduledStart, ...evidence } }, { name: 'Ritika', client: 'Jason' });
    assert.equal(miss({}), '₹500 deduction, Ritika: missed the meeting with Jason at 4:30 PM IST: not in the Google Meet and not marked present in time.');
    assert.equal(
      miss({ absentReason: 'left_early', stayMs: 40_000 }),
      '₹500 deduction, Ritika: missed the meeting with Jason at 4:30 PM IST: joined the Google Meet but left too early (40 s after the start, 2 min needed).'
    );
  });

  it('daily summary lists meetings, presence, calls, pending statuses and the day deductions', () => {
    const text = formatDailySummary({
      name: 'Siddhartha', mention: null, day: '2026-10-08', meetings: 4, present: 3, absent: 1, noVerdict: 0,
      calls: 6, callMeetings: 3, pending: 2,
      deductions: [{ rule: 'missed_meeting', amountInr: 500 }, { rule: 'status_not_updated', amountInr: 50 }],
    });
    assert.match(text, /Siddhartha/);
    assert.match(text, /Meetings: 4 \(3 present, 1 absent\)/);
    assert.match(text, /Calls to clients: 6 across 3 meetings/);
    assert.match(text, /Statuses still on scheduled: 2/);
    assert.match(text, /Deductions today: ₹550 from 2/);
  });
});

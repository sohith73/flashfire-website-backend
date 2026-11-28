import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CallLogModel } from '../Schema_Models/CallLog.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { buildPendingCallLeads, formatPendingCallLeadsMessage } from '../Controllers/CallLeadsController.js';

const chain = (rows) => ({ select: () => chain(rows), sort: () => chain(rows), lean: async () => rows });
const orig = {};
const leads = [
  { bookingId: 'b1', clientName: 'A', clientPhone: '+14155550001', bookingStatus: 'no-show', bookingCreatedAt: new Date('2026-11-27T10:00:00Z'), callLeadAssignee: { email: 'kalpataru@flashfirehq.com', name: 'Kalpataru Samal' } },
  { bookingId: 'b2', clientName: 'B', clientPhone: '+14155550002', bookingStatus: 'not-scheduled', bookingCreatedAt: new Date('2026-11-27T09:00:00Z'), callLeadAssignee: { email: 'kalpataru@flashfirehq.com', name: 'Kalpataru Samal' } },
  { bookingId: 'b3', clientName: 'C', clientPhone: '+14155550003', bookingStatus: 'not-scheduled', bookingCreatedAt: new Date('2026-11-26T09:00:00Z'), callLeadAssignee: { email: 'siddhartha@flashfirehq.com', name: 'Basaveni siddhartha' } },
];

describe('buildPendingCallLeads', () => {
  beforeEach(() => {
    orig.b = CampaignBookingModel.find; orig.c = CallLogModel.find; orig.u = CrmUserModel.find;
    CampaignBookingModel.find = () => chain(leads);
    CallLogModel.find = () => chain([{ leadNumberNormalized: '4155550001', startedAt: new Date('2026-11-28T01:00:00Z'), durationSec: 60 }]);
    CrmUserModel.find = () => chain([]);
  });
  afterEach(() => { CampaignBookingModel.find = orig.b; CallLogModel.find = orig.c; CrmUserModel.find = orig.u; });

  test('splits per BDA by status and marks called leads', async () => {
    const d = await buildPendingCallLeads({ end: new Date('2026-11-28T18:30:00Z') });
    const k = d.summary.find((s) => s.email === 'kalpataru@flashfirehq.com');
    const s = d.summary.find((x) => x.email === 'siddhartha@flashfirehq.com');
    assert.deepEqual([k.noShow, k.notScheduled, k.total, k.called, k.left, k.leftNoShow, k.leftNotScheduled], [1, 1, 2, 1, 1, 0, 1]);
    assert.deepEqual([s.total, s.left], [1, 1]);
    assert.equal(d.leads.find((l) => l.bookingId === 'b1').called, true);
    assert.equal(d.leads.find((l) => l.bookingId === 'b2').called, false);
  });

  test('message names each BDA with the left-to-call split', async () => {
    const d = await buildPendingCallLeads({ end: new Date('2026-11-28T18:30:00Z') });
    const msg = formatPendingCallLeadsMessage(d);
    assert.match(msg, /past 3 days/);
    assert.match(msg, /\*\*Kalpataru\*\* — 1 left to call \(0 no-show · 1 not scheduled\), 1 already called of 2/);
    assert.match(msg, /\*\*Siddhartha\*\* — 1 left to call/);
  });
});

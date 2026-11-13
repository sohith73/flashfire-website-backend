import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { getCrmJwtSecret, requireBdaExtension } from '../Middlewares/CrmAuth.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import {
  getMyMeetings,
  markAbsent,
  warnAbsent,
  reportJoin,
  reportLeave,
} from '../Controllers/BdaAttendanceController.js';
import { pollForAbsentBDAs } from '../Utils/BdaAbsentScheduler.js';

// Every BDA's extension receives every meeting. These tests pin the rule that
// absence (reminders, warn, absent marks) belongs only to the assigned BDA, and
// that one BDA's row never hides another BDA's attendance.

const MONGO_URI = process.env.MONGO_URI;
const PREFIX = '__test_bdaassign_';
const HOST = 'host.bda@flashfirehq.com';
const OTHER = 'other.bda@flashfirehq.com';

// The absent-poller posts to Discord; keep tests off the network.
delete process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL;
delete process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL;
delete process.env.DISCORD_BDA_DURATION_WEBHOOK_URL;
// The poller now asks the Meet API before alerting; keep that off the network too.
process.env.MEET_API_ATTENDANCE_ENABLED = 'false';

let server;
let baseUrl;

function tokenFor(email) {
  return jwt.sign({ role: 'bda_extension', email, name: email.split('@')[0] }, getCrmJwtSecret(), {
    expiresIn: '1h',
  });
}

async function call(method, path, email, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(email)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function seedBooking(overrides = {}) {
  const bookingId = `${PREFIX}${Math.random().toString(36).slice(2)}`;
  await CampaignBookingModel.create({
    bookingId,
    clientName: 'Test Client',
    clientEmail: `${bookingId}@example.com`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    // Started 6 minutes ago: inside every reminder/absent window.
    scheduledEventStartTime: new Date(Date.now() - 6 * 60 * 1000),
    scheduledEventEndTime: new Date(Date.now() + 24 * 60 * 1000),
    googleMeetCode: 'abc-defg-hij',
    googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
    calendlyHost: { name: 'Host BDA', email: HOST },
    bookingCreatedAt: new Date(),
    ...overrides,
  });
  return bookingId;
}

async function cleanupAll() {
  const re = { $regex: `^${PREFIX}` };
  await CampaignBookingModel.deleteMany({ bookingId: re });
  await BdaAttendanceModel.deleteMany({ bookingId: re });
}

before(async () => {
  assert.ok(MONGO_URI, 'MONGO_URI must point at a test database');
  await mongoose.connect(MONGO_URI);
  await cleanupAll();

  const app = express();
  app.use(express.json());
  app.get('/my-meetings', requireBdaExtension, getMyMeetings);
  app.post('/mark-absent', requireBdaExtension, markAbsent);
  app.post('/warn-absent', requireBdaExtension, warnAbsent);
  app.post('/report-join', requireBdaExtension, reportJoin);
  app.post('/report-leave', requireBdaExtension, reportLeave);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(cleanupAll);

after(async () => {
  await cleanupAll();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
});

function findMeeting(body, bookingId) {
  return [...body.upcoming, ...body.previous].find((m) => m.bookingId === bookingId);
}

describe('mark-absent', () => {
  // Absence is decided by the server's verdict job now (plan 4.4.5 and 5.4). Old extensions still call these
  // endpoints, so they answer with a clean skip and write nothing, whoever calls.
  it('is a no-op for the assigned host and for anyone else', async () => {
    const bookingId = await seedBooking();
    for (const email of [HOST, OTHER]) {
      const r = await call('POST', '/mark-absent', email, { bookingId, reason: 'x' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true, skipped: true, reason: 'server_decides' });
    }
    assert.equal(await BdaAttendanceModel.countDocuments({ bookingId }), 0);
  });

  it('never touches an existing present row', async () => {
    const joined = await seedBooking();
    await call('POST', '/report-join', HOST, { bookingId: joined, meetLink: 'https://meet.google.com/abc-defg-hij' });
    await call('POST', '/mark-absent', HOST, { bookingId: joined });
    assert.equal((await BdaAttendanceModel.findOne({ bookingId: joined, bdaEmail: HOST }).lean()).status, 'present');
  });
});

describe('warn-absent', () => {
  it('is a no-op for everyone', async () => {
    const bookingId = await seedBooking();
    for (const email of [HOST, OTHER]) {
      const r = await call('POST', '/warn-absent', email, { bookingId });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true, skipped: true, reason: 'server_decides' });
    }
  });
});

describe('my-meetings', () => {
  it("returns only the requester's own attendance and flags assignment", async () => {
    const bookingId = await seedBooking();
    // A colleague's absent row used to surface as this booking's attendance and
    // made the host's extension stop tracking the meeting.
    await BdaAttendanceModel.create({
      bookingId,
      bdaEmail: OTHER,
      bdaName: 'Other',
      status: 'absent',
      source: 'manual',
      meetingScheduledStart: new Date(),
    });

    const host = findMeeting((await call('GET', '/my-meetings', HOST)).body, bookingId);
    assert.equal(host.assignedToMe, true);
    assert.equal(host.attendance, null);

    const other = findMeeting((await call('GET', '/my-meetings', OTHER)).body, bookingId);
    assert.equal(other.assignedToMe, false);
    assert.equal(other.attendance.status, 'absent');
  });

  it("gives client details only for the requester's own meetings, but keeps the meet code for covering joins", async () => {
    const bookingId = await seedBooking();
    const host = findMeeting((await call('GET', '/my-meetings', HOST)).body, bookingId);
    assert.equal(host.clientName, 'Test Client');
    assert.equal(host.clientEmail, `${bookingId}@example.com`);

    const other = findMeeting((await call('GET', '/my-meetings', OTHER)).body, bookingId);
    assert.equal(other.assignedToMe, false);
    assert.equal(other.clientName, "Colleague's meeting");
    assert.equal(other.clientEmail, null);
    assert.equal(other.googleMeetCode, 'abc-defg-hij', 'still matchable when a colleague covers the call');
    assert.deepEqual(Object.keys(other).sort(), Object.keys(host).sort(), 'same response shape for both');
  });

  it('hides an unmarked row so Mark Present and auto-join stay available', async () => {
    const bookingId = await seedBooking();
    await BdaAttendanceModel.create({
      bookingId, bdaEmail: HOST, bdaName: 'Host BDA', status: 'unmarked', source: 'scheduler', meetingScheduledStart: new Date(),
    });
    const host = findMeeting((await call('GET', '/my-meetings', HOST)).body, bookingId);
    assert.equal(host.attendance, null);
  });
});

describe('absent poller (stale sessions and unassigned meetings only)', () => {
  it('no longer pings or writes a "No Response" row for an assigned BDA', async () => {
    const bookingId = await seedBooking();
    await pollForAbsentBDAs();
    assert.equal(await BdaAttendanceModel.countDocuments({ bookingId }), 0);
  });

  it('treats an admin reassignment as assigned too', async () => {
    const bookingId = await seedBooking({ calendlyHost: null, attendanceAssignee: { email: OTHER, name: 'Other' } });
    await pollForAbsentBDAs();
    assert.equal(await BdaAttendanceModel.countDocuments({ bookingId }), 0);
  });

  it('still flags a truly unassigned meeting', async () => {
    const bookingId = await seedBooking({ calendlyHost: null });
    await pollForAbsentBDAs();
    const row = await BdaAttendanceModel.findOne({ bookingId }).lean();
    assert.equal(row.bdaEmail, 'unassigned');
    assert.match(row.notes, /not claimed/);
  });

  it('a real join by a covering BDA clears the unassigned placeholder', async () => {
    const bookingId = await seedBooking({ calendlyHost: null });
    await pollForAbsentBDAs();
    await call('POST', '/report-join', HOST, { bookingId, meetLink: 'https://meet.google.com/abc-defg-hij' });
    const rows = await BdaAttendanceModel.find({ bookingId }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bdaEmail, HOST);
    assert.equal(rows[0].status, 'present');
  });
});

describe('time spent and join time', () => {
  const MEET = 'https://meet.google.com/abc-defg-hij';

  it('adds every rejoin segment to the total', async () => {
    const bookingId = await seedBooking();
    const t0 = Date.now() - 30 * 60 * 1000;
    await call('POST', '/report-join', HOST, { bookingId, meetLink: MEET, joinedAt: new Date(t0).toISOString() });
    await call('POST', '/report-leave', HOST, { bookingId, leftAt: new Date(t0 + 10 * 60e3).toISOString(), durationMs: 10 * 60e3 });
    await call('POST', '/report-join', HOST, { bookingId, meetLink: MEET, joinedAt: new Date(t0 + 12 * 60e3).toISOString() });
    await call('POST', '/report-leave', HOST, { bookingId, leftAt: new Date(t0 + 20 * 60e3).toISOString(), durationMs: 8 * 60e3 });
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: HOST }).lean();
    assert.equal(row.durationMs, 18 * 60e3);
    assert.equal(new Date(row.firstJoinedAt).getTime(), t0);
  });

  it("moves a fast client clock's join time onto server time", async () => {
    const bookingId = await seedBooking();
    const skew = 2 * 60 * 1000; // client PC runs 2 minutes fast
    const realJoin = Date.now() - 60 * 1000;
    await call('POST', '/report-join', HOST, {
      bookingId,
      meetLink: MEET,
      joinedAt: new Date(realJoin + skew).toISOString(),
      clientNow: new Date(Date.now() + skew).toISOString(),
    });
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: HOST }).lean();
    assert.ok(Math.abs(new Date(row.firstJoinedAt).getTime() - realJoin) < 3000);
  });

  it('keeps the client time when no clientNow is sent (older builds)', async () => {
    const bookingId = await seedBooking();
    const joinedAt = new Date(Date.now() - 90 * 1000).toISOString();
    await call('POST', '/report-join', HOST, { bookingId, meetLink: MEET, joinedAt });
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: HOST }).lean();
    assert.equal(new Date(row.firstJoinedAt).toISOString(), joinedAt);
  });
});

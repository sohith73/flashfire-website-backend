// Discord notifications: double-booking (warning before, reason in the absent alert), device lines, and the join
// alert's punctuality and clean link. Modeled on the real case: Siddhartha had Jess and Nishath both at 00:30 IST.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';

isolateExternalServices();

import { getCrmJwtSecret, requireBdaExtension } from '../Middlewares/CrmAuth.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaAttendanceWarnDedupeModel } from '../Schema_Models/BdaAttendanceWarnDedupe.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { reportJoin } from '../Controllers/BdaAttendanceController.js';
import { runDoubleBookingAlert, runVerdictPass } from '../Utils/AttendanceVerdictJob.js';
import { doubleBookedLine, findOverlappingMeetings, overlaps } from '../Utils/DoubleBooking.js';
import { deviceLine } from '../Utils/JoinDevice.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { formatIstTime } from '../Utils/recordPresentSignal.js';

const RUN = Math.random().toString(36).slice(2, 8);
const D = `nt-${RUN}.test.invalid`;
const PREFIX = `__nt_${RUN}_`;
const SID = `sid@${D}`;
const MIN = 60 * 1000;
const FILTER = { bookingId: { $regex: `^${PREFIX}` } };

let server;
let base;
let seq = 0;

async function mkBooking({ start, clientName, host = SID, minutes = 30, status = 'scheduled' }) {
  const bookingId = `${PREFIX}${++seq}`;
  await CampaignBookingModel.create({
    bookingId,
    clientName,
    clientEmail: `${bookingId}@${D}`,
    bookingStatus: status,
    utmSource: 'direct',
    scheduledEventStartTime: new Date(start),
    scheduledEventEndTime: new Date(start + minutes * MIN),
    googleMeetCode: 'abc-defg-hij',
    googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
    calendlyHost: { name: 'Sid', email: host },
    bookingCreatedAt: new Date(),
  });
  return bookingId;
}

const deps = (extra = {}) => {
  const admin = [];
  const absent = [];
  return {
    admin,
    absent,
    d: {
      poster: async (m) => (absent.push(m), true),
      adminPoster: async (m) => (admin.push(m), true),
      attendancePoster: async () => true,
      meetVerifier: async () => ({ checked: true }),
      bookingFilter: FILTER,
      ignoreGoLive: true,
      health: {
        recordSyncOk: async () => true,
        recordSyncError: async () => true,
        wasSourceHealthy: async () => true,
        syncOkBetween: async () => true,
        getAllSyncHealth: async () => [],
      },
      ...extra,
    },
  };
};

async function cleanup() {
  await Promise.all([
    CampaignBookingModel.deleteMany(FILTER),
    BdaAttendanceModel.deleteMany(FILTER),
    BdaAttendanceWarnDedupeModel.deleteMany({ bookingId: { $regex: `^double_booked:.*${PREFIX}` } }),
    BdaProfileModel.deleteMany({ email: { $regex: `@${D.replace(/\./g, '\\.')}$` } }),
  ]);
  invalidateRegistryCache();
}

before(async () => {
  await connectTestDb();
  const app = express();
  app.use(express.json());
  app.post('/api/bda-attendance/report-join', requireBdaExtension, reportJoin);
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await cleanup();
  await new Promise((r) => server.close(r));
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanup();
  await BdaProfileModel.create({ email: SID, displayName: 'Siddhartha', firstName: 'siddhartha', tracked: true, trackedSince: new Date('2026-01-01') });
  invalidateRegistryCache();
});

describe('double-booking', () => {
  it('overlap means one starts before the other ends; back-to-back is not double-booked', () => {
    const at = (h, m, minutes = 30) => ({ scheduledEventStartTime: new Date(Date.UTC(2026, 9, 8, h, m)), scheduledEventEndTime: new Date(Date.UTC(2026, 9, 8, h, m + minutes)) });
    assert.equal(overlaps(at(19, 0), at(19, 0)), true);
    assert.equal(overlaps(at(19, 0), at(19, 15)), true);
    assert.equal(overlaps(at(19, 0), at(19, 30)), false);
  });

  it('finds the other meeting and whether the BDA was in it (the Jess / Nishath case)', async () => {
    const start = Date.now() - 60 * MIN;
    const jess = await mkBooking({ start, clientName: 'Jess' });
    const nishath = await mkBooking({ start, clientName: 'Nishath' });
    await BdaAttendanceModel.create({
      attendanceId: `a_${RUN}_${seq}`,
      bookingId: nishath,
      bdaEmail: SID,
      bdaName: 'Siddhartha',
      status: 'present',
      source: 'meet_api',
      meetingScheduledStart: new Date(start),
      firstJoinedAt: new Date(start - 2 * MIN),
    });
    const booking = await CampaignBookingModel.findOne({ bookingId: jess }).lean();
    const found = await findOverlappingMeetings(booking, SID);
    assert.equal(found.length, 1);
    assert.equal(found[0].clientName, 'Nishath');
    assert.equal(found[0].attended, true);
    const line = doubleBookedLine(found, formatIstTime);
    assert.match(line, /was in another meeting at the same time, Nishath \(joined/);
  });

  it('warns the admin channel once, 25 to 35 minutes before the clashing slot', async () => {
    const start = Date.now() + 30 * MIN;
    await mkBooking({ start, clientName: 'Jess' });
    await mkBooking({ start, clientName: 'Nishath' });
    await mkBooking({ start: start + 30 * MIN, clientName: 'Back To Back' }); // not a clash
    const { admin, d } = deps();
    await runDoubleBookingAlert(new Date(), d);
    assert.equal(admin.length, 1);
    assert.match(admin[0], /Double-booked/);
    assert.match(admin[0], /Jess/);
    assert.match(admin[0], /Nishath/);
    assert.doesNotMatch(admin[0], /Back To Back/);
    await runDoubleBookingAlert(new Date(), d);
    assert.equal(admin.length, 1, 'posted once per clash, not every minute');
  });

  it('the immediate absent alert says the BDA was in another meeting', async () => {
    const start = Date.now() - 10 * MIN;
    await mkBooking({ start, clientName: 'Jess' });
    const nishath = await mkBooking({ start, clientName: 'Nishath' });
    await BdaAttendanceModel.create({
      attendanceId: `a_${RUN}_${seq}`,
      bookingId: nishath,
      bdaEmail: SID,
      bdaName: 'Siddhartha',
      status: 'present',
      source: 'auto',
      meetingScheduledStart: new Date(start),
      firstJoinedAt: new Date(start - 2 * MIN),
      signals: [{ kind: 'extension_join', eventAt: new Date(start - 2 * MIN), receivedAt: new Date(start - 2 * MIN) }],
    });
    const { absent, d } = deps();
    await runVerdictPass(new Date(start + 215 * 1000), d);
    const jessAlert = absent.find((m) => /Client:\*\* Jess/.test(m));
    assert.ok(jessAlert, `absent alerts: ${absent.join(' | ')}`);
    assert.match(jessAlert, /Double-booked:\*\* was in another meeting at the same time, Nishath/);
  });
});

describe('device and join alert text', () => {
  it('deviceLine names each device and is empty when nobody saw the join', () => {
    assert.match(deviceLine('mobile'), /📱 Mobile \(likely\)/);
    assert.match(deviceLine('pc'), /💻 PC/);
    assert.match(deviceLine('phone_dial_in'), /Dial-in/);
    assert.match(deviceLine('unknown'), /offline during the call/);
    assert.equal(deviceLine(null), '');
  });

  it('the join alert shows punctuality, the device and a link without ?authuser', async () => {
    const posted = [];
    process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL = 'https://discord.invalid/webhook';
    const realFetch = globalThis.fetch;
    // Intercept only the Discord call; the request to our own test server goes through.
    globalThis.fetch = async (url, opts) => {
      if (String(url).startsWith('https://discord.invalid')) {
        posted.push(JSON.parse(opts.body).content);
        return new Response('', { status: 204 });
      }
      return realFetch(url, opts);
    };
    try {
      const start = Date.now() + 3 * MIN;
      const bookingId = await mkBooking({ start, clientName: 'Devanshi' });
      const token = jwt.sign({ role: 'bda_extension', email: SID, name: 'Siddhartha' }, getCrmJwtSecret(), { expiresIn: '1h' });
      const r = await realFetch(`${base}/api/bda-attendance/report-join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ bookingId, meetLink: 'https://meet.google.com/abc-defg-hij?authuser=0', joinedAt: new Date().toISOString() }),
      });
      assert.equal(r.status, 200);
      for (let i = 0; i < 50 && posted.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
      const msg = posted.find((m) => /BDA Joined Meeting/.test(m));
      assert.ok(msg, 'join alert posted');
      assert.match(msg, /\(3 min early\)|\(2 min early\)/);
      assert.match(msg, /Device:\*\* 💻 PC/);
      assert.match(msg, /Meet Link:\*\* https:\/\/meet\.google\.com\/abc-defg-hij\n/);
      assert.doesNotMatch(msg, /authuser/);
    } finally {
      globalThis.fetch = realFetch;
      process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL = '';
    }
  });
});

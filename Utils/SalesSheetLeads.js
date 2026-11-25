import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { ScheduledCallModel } from '../Schema_Models/ScheduledCall.js';

// The hot and warm leads a sales executive rated in a calendar month (IST), shaped for the Sales Tracker sheet.
// The sheet's Apps Script pulls this once a day and adds the leads it does not have yet.

export const SHEET_EXECUTIVES = Object.freeze([
  { key: 'kalpataru', email: 'kalpataru@flashfirehq.com', name: 'Kalpataru', sheetName: 'Kalpataru' },
  // The sheet's own dropdown and the Manager tab spell this one "Sidhharth"; the value must match for their formulas.
  { key: 'siddhartha', email: 'siddhartha@flashfirehq.com', name: 'Siddhartha', sheetName: 'Sidhharth' },
]);

const IST_MS = 5.5 * 3600 * 1000;
const DIAL = [['971', 'UAE'], ['353', 'Ireland'], ['351', 'Portugal'], ['44', 'UK'], ['61', 'Australia'], ['91', 'India'], ['49', 'Germany'], ['48', 'Poland'], ['47', 'Norway'], ['46', 'Sweden'], ['45', 'Denmark'], ['43', 'Austria'], ['41', 'Switzerland'], ['39', 'Italy'], ['34', 'Spain'], ['33', 'France'], ['32', 'Belgium'], ['31', 'Netherlands'], ['1', 'US']];
const MARKET = { uk: 'UK', us: 'US', ca: 'Canada', au: 'Australia' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11' to the IST month's bounds in UTC. Returns null when the text is not YYYY-MM. */
export function monthBounds(month) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { from: new Date(Date.UTC(y, mo, 1) - IST_MS), to: new Date(Date.UTC(y, mo + 1, 1) - IST_MS), label: `${MONTHS[mo]} ${y}` };
}

export function sheetDate(d) {
  if (!d) return '';
  const t = new Date(new Date(d).getTime() + IST_MS);
  return `${String(t.getUTCDate()).padStart(2, '0')}-${MONTHS[t.getUTCMonth()]}-${t.getUTCFullYear()}`;
}

/** '16-Nov-2026 7:00 PM' in IST, or '' when there is no date. */
export function sheetDateTime(d) {
  if (!d) return '';
  const t = new Date(new Date(d).getTime() + IST_MS);
  const h = t.getUTCHours();
  const h12 = h % 12 || 12;
  return `${sheetDate(d)} ${h12}:${String(t.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function countryFor({ campaign, phone, market }) {
  const c = String(campaign || '');
  if (/united kingdom|\buk\b/i.test(c)) return 'UK';
  if (/australia/i.test(c)) return 'Australia';
  if (/canada/i.test(c)) return 'Canada';
  if (/\b(usa|united states|us)\b/i.test(c)) return 'US';
  const raw = String(phone || '').trim();
  if (raw.startsWith('+')) {
    const d = raw.replace(/\D/g, '');
    for (const [code, name] of DIAL) if (d.startsWith(code)) return name;
  }
  return MARKET[market] || '';
}

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase() : '');
const digits = (p) => String(p || '').replace(/\D/g, '');

/** Who ran the meeting: the BDA who rated it, else the one it was assigned to, when that is a sheet executive. */
export function executiveFor(booking) {
  const byEmail = (e) => SHEET_EXECUTIVES.find((x) => x.email === String(e || '').toLowerCase());
  return byEmail(booking.leadTemperature?.ratedByEmail)
    || byEmail(booking.attendanceAssignee?.email || booking.calendlyHost?.email || booking.claimedBy?.email)
    || null;
}

/**
 * Rows for one month, grouped per executive. A lead appears once per executive. Paid leads carry Status "Paid" with the
 * amount and payment date (the sheet's dashboard counts sales by that status). The payment date is the paid status
 * change, else the day the plan was picked.
 */
export async function buildSalesSheetLeads(month, deps = {}) {
  const bounds = monthBounds(month);
  if (!bounds) return null;
  const Bookings = deps.Bookings ?? CampaignBookingModel;
  const Calls = deps.Calls ?? ScheduledCallModel;
  const bookings = await Bookings.find({
    'leadTemperature.value': { $in: ['hot', 'warm'] },
    'leadTemperature.ratedAt': { $gte: bounds.from, $lt: bounds.to },
  }).sort({ 'leadTemperature.ratedAt': 1 }).lean();
  const calls = await Calls.find({ source: 'crm_followup' }).select('phoneNumber meetingStartISO createdAt').lean();
  const followUp = new Map();
  for (const c of calls) {
    const k = digits(c.phoneNumber);
    const prev = followUp.get(k);
    if (!prev || new Date(c.createdAt) > new Date(prev.createdAt)) followUp.set(k, c);
  }

  const groups = Object.fromEntries(SHEET_EXECUTIVES.map((x) => [x.key, []]));
  const seen = new Set();
  let other = 0;
  for (const b of bookings) {
    const ex = executiveFor(b);
    if (!ex) { other += 1; continue; }
    const phone = digits(b.clientPhone);
    const dedupe = `${ex.key}|${phone || String(b.clientEmail || '').toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const paid = b.bookingStatus === 'paid';
    const paidAt = (b.statusHistory || []).filter((h) => h.status === 'paid').pop()?.changedAt || b.paymentPlan?.selectedAt;
    groups[ex.key].push({
      bookingId: b.bookingId,
      name: b.clientName || '',
      phone,
      email: b.clientEmail || '',
      country: countryFor({ campaign: b.utmCampaign, phone: b.clientPhone, market: b.leadMarket }),
      status: paid ? 'Paid' : cap(b.leadTemperature.value),
      meetingDateTime: sheetDateTime(b.scheduledEventStartTime),
      followUpDate: sheetDate(b.followUp?.at || followUp.get(phone)?.meetingStartISO),
      package: cap(b.paymentPlan?.name || b.followUp?.plan || ''),
      amountPaid: paid && b.paymentPlan?.price ? b.paymentPlan.price : '',
      paymentDate: paid ? sheetDate(paidAt) : '',
    });
  }
  return {
    month,
    label: bounds.label,
    executives: SHEET_EXECUTIVES.map((x) => ({ key: x.key, name: x.name, sheetName: x.sheetName, leads: groups[x.key] })),
    skippedOtherExecutives: other,
  };
}

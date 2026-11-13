import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { UserModel } from '../Schema_Models/User.js';
import { getPaidPlanPayments } from './StripeDataController.js';

/**
 * Sales funnel table for the CRM Analytics tab.
 *
 *   form filled → scheduled → attended → paid   (+ canceled, no-show, revenue)
 *
 * Cohort basis: a person (lower-cased email) is counted in the period they FIRST filled a
 * form, i.e. the earliest of their signup-form `User` row and their first booking. Each
 * row is therefore a true funnel: every later step (call, payment) is credited back to the
 * period the lead came in, so the percentages chain.
 *
 *   form fill  = signup form (User) OR a Meta lead-ad / any booking record
 *   scheduled  = at least one booking whose status is not 'not-scheduled'
 *   attended   = a booking is 'completed' or 'paid'
 *   completed  = attended but not (yet) paid, i.e. a 'completed' booking and no 'paid' one
 *   no-show    = never attended and has a 'no-show' booking
 *   canceled   = scheduled, never attended / no-show, latest live booking is 'canceled'

 * Paid / Revenue come from Stripe, NOT from booking status, and are bucketed by the ET day
 * of the payment (same data as the Stripe Data tab: succeeded charges + manual payments,
 * add-ons and upgrades excluded). Paid = number of payments; Revenue = USD payments only
 * (other currencies are counted in Paid and returned per currency in `otherRevenue`).
 *
 * People whose every booking is 'ignored' (duplicates / junk) are dropped.
 *
 * Day/month/quarter boundaries are in ET, like the rest of the graphs.
 */
const TZ = 'America/New_York';
const VIEWS = ['month', 'quarter', 'day', 'mtd'];
const MONTHS_BACK = 8;
const QUARTERS_BACK = 4;
const MAX_DAYS = 366;

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** 'YYYY-MM-DD' of an instant in ET. */
const etDay = (d) => dayFmt.format(d);

const pad = (n) => String(n).padStart(2, '0');
const quarterOf = (month) => Math.floor((month - 1) / 3) + 1;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

const addDays = (dayStr, n) => {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};

const eachDay = (from, to) => {
  const out = [];
  for (let d = from; d <= to && out.length < MAX_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Row definitions for the requested view. `keyOf` maps an ET day string to its row key. */
function buildRows(view, fromQ, toQ) {
  const today = etDay(new Date());
  const [ty, tm] = today.split('-').map(Number);

  if (view === 'month') {
    const rows = [];
    for (let i = MONTHS_BACK - 1; i >= 0; i--) {
      const dt = new Date(Date.UTC(ty, tm - 1 - i, 1));
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth() + 1;
      rows.push({ key: `${y}-${pad(m)}`, label: `${MONTH_NAMES[m - 1]} ${y}`, current: i === 0 });
    }
    return { rows, keyOf: (day) => day.slice(0, 7) };
  }

  if (view === 'quarter') {
    const rows = [];
    let y = ty;
    let q = quarterOf(tm);
    const list = [];
    for (let i = 0; i < QUARTERS_BACK; i++) {
      list.unshift({ y, q });
      q -= 1;
      if (q === 0) { q = 4; y -= 1; }
    }
    list.forEach(({ y: yy, q: qq }, idx) => {
      rows.push({ key: `${yy}-Q${qq}`, label: `Q${qq} ${yy}`, current: idx === list.length - 1 });
    });
    return { rows, keyOf: (day) => `${day.slice(0, 4)}-Q${quarterOf(Number(day.slice(5, 7)))}` };
  }

  // day / mtd — one row per ET day
  let from;
  let to;
  if (view === 'mtd') {
    from = `${ty}-${pad(tm)}-01`;
    to = today;
  } else {
    to = isDay(toQ) ? toQ : today;
    from = isDay(fromQ) ? fromQ : addDays(to, -29);
    if (from > to) [from, to] = [to, from];
  }
  const rows = eachDay(from, to).map((day) => {
    const [y, m, d] = day.split('-').map(Number);
    return { key: day, label: `${d} ${MONTH_NAMES[m - 1]}${view === 'day' ? ` ${y}` : ''}`, current: day === today };
  });
  return { rows, keyOf: (day) => day, from, to };
}

const emptyBucket = () => ({
  forms: 0, scheduled: 0, canceled: 0, attended: 0, completed: 0, noShow: 0, paid: 0, paidUsd: 0, revenue: 0, otherRevenue: {},
});

export const getFunnelAnalytics = async (req, res) => {
  try {
    const view = VIEWS.includes(req.query.view) ? req.query.view : 'month';
    const { rows, keyOf, from, to } = buildRows(view, req.query.from, req.query.to);
    const rowKeys = new Set(rows.map((r) => r.key));

    // Everything up to the end of the last row: later steps are credited to the form date.
    const endDay = to || etDay(new Date());
    const upTo = new Date(`${addDays(endDay, 2)}T00:00:00Z`);

    const [users, bookings] = await Promise.all([
      UserModel.find({ createdAt: { $lte: upTo } }).select({ email: 1, createdAt: 1 }).lean(),
      CampaignBookingModel.find({ bookingCreatedAt: { $lte: upTo } })
        .select({
          clientEmail: 1, bookingCreatedAt: 1, bookingStatus: 1, scheduledEventStartTime: 1,
          paymentPlan: 1, paymentBreakdown: 1,
        })
        .lean(),
    ]);

    // One record per person.
    const people = new Map();
    const personFor = (email) => {
      const key = String(email || '').trim().toLowerCase();
      if (!key || key === 'not specified') return null;
      let p = people.get(key);
      if (!p) {
        p = { formAt: null, bookings: [] };
        people.set(key, p);
      }
      return p;
    };
    const touch = (p, at) => {
      if (at && (!p.formAt || at < p.formAt)) p.formAt = at;
    };

    users.forEach((u) => {
      const p = personFor(u.email);
      if (p) touch(p, u.createdAt);
    });
    bookings.forEach((b) => {
      const p = personFor(b.clientEmail);
      if (!p) return;
      touch(p, b.bookingCreatedAt);
      p.bookings.push(b);
    });

    const buckets = new Map(rows.map((r) => [r.key, emptyBucket()]));
    const total = emptyBucket();

    people.forEach((p) => {
      if (!p.formAt) return;
      const key = keyOf(etDay(new Date(p.formAt)));
      if (!rowKeys.has(key)) return;

      const live = p.bookings.filter((b) => b.bookingStatus !== 'ignored');
      if (p.bookings.length > 0 && live.length === 0) return; // junk / duplicate only

      const statuses = live.map((b) => b.bookingStatus);
      const scheduled = statuses.some((s) => s && s !== 'not-scheduled');
      const paidStatus = statuses.includes('paid');
      const attended = paidStatus || statuses.includes('completed');
      const completed = !paidStatus && statuses.includes('completed');
      const noShow = !attended && statuses.includes('no-show');
      let canceled = false;
      if (scheduled && !attended && !noShow) {
        const latest = [...live]
          .filter((b) => b.bookingStatus !== 'not-scheduled')
          .sort((a, b) => new Date(b.bookingCreatedAt) - new Date(a.bookingCreatedAt))[0];
        canceled = latest?.bookingStatus === 'canceled';
      }

      [buckets.get(key), total].forEach((t) => {
        t.forms += 1;
        if (scheduled) t.scheduled += 1;
        if (canceled) t.canceled += 1;
        if (attended) t.attended += 1;
        if (completed) t.completed += 1;
        if (noShow) t.noShow += 1;
      });
    });

    // Paid / revenue straight from Stripe, by payment day. A Stripe outage must not take
    // the rest of the table down, so report it and leave those two columns at 0.
    let stripeError = null;
    try {
      const payments = await getPaidPlanPayments();
      payments.forEach((pay) => {
        const key = keyOf(etDay(pay.date));
        const bucket = buckets.get(key);
        if (!bucket) return;
        [bucket, total].forEach((t) => {
          t.paid += 1;
          if (pay.currency === 'USD') {
            t.paidUsd += 1;
            t.revenue += pay.amount;
          } else {
            t.otherRevenue[pay.currency] = (t.otherRevenue[pay.currency] || 0) + pay.amount;
          }
        });
      });
    } catch (err) {
      console.error('Funnel: Stripe payments unavailable:', err.message);
      stripeError = err.message || 'Stripe payments unavailable';
    }

    return res.json({
      success: true,
      data: {
        stripeError,
        view,
        timezone: TZ,
        from: from || null,
        to: to || null,
        rows: rows.map((r) => ({ key: r.key, label: r.label, current: r.current, ...buckets.get(r.key) })),
        total,
      },
    });
  } catch (error) {
    console.error('Error building funnel analytics:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to build funnel analytics' });
  }
};

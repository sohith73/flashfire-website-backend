import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CallLogModel } from '../Schema_Models/CallLog.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { countryFor } from '../Utils/SalesSheetLeads.js';

/**
 * Call Leads — Meta leads that filled the form but never booked a meeting.
 *
 * A lead qualifies once it is at least COOL_OFF_HOURS old and still has no
 * meeting. Both conditions matter:
 *   - bookingStatus === 'not-scheduled'  (never converted)
 *   - scheduledEventStartTime === null   (belt and braces: the Calendly sync sets
 *     both, but a manually-edited status could leave the two disagreeing)
 *
 * Calls are placed from the browser via the `zoomphonecall://` deep link, so the
 * server never sees the dial. Call facts (who, how long) come from CallLog, which
 * the Zoom webhook + the 5-minute call-history sync populate after the fact.
 */

const COOL_OFF_HOURS = 24;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_NOTE_LENGTH = 5000;

/** Meta-sourced leads, whichever ingest path created them. */
const META_LEAD_MATCH = {
  $or: [{ leadSource: 'meta_lead_ad' }, { metaLeadId: { $exists: true, $ne: null } }],
};

const JOB_TYPE_LABELS = {
  opt_jobs: 'OPT Jobs',
  h1b_visa_jobs: 'H1B Visa Jobs',
  sponsored_jobs: 'Sponsored Jobs',
};

/** A value that is really a phone number, not an answer to a form question. */
const PHONE_LIKE_RX = '^[+(]?[0-9][0-9 ()\\-.]{5,}$';

/** Form field names that leaked into the answer slot via the same ingest bug. */
const LEAKED_FIELD_NAMES = ['whatsapp_number', 'phone_number', 'mobile_number', 'phone', 'mobile'];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The business timezone. Every other CRM surface (Graphs 03, the reminders) buckets
// days in New York, so "Yesterday" here must mean the same calendar day it means there.
const TZ = 'America/New_York';

/** The calendar day (YYYY-MM-DD) of an instant, in the business timezone. */
function nyDay(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/**
 * Shift a YYYY-MM-DD day by whole days. Pure calendar arithmetic on the date parts
 * (via a UTC anchor that is never displayed), so a DST transition in the middle of the
 * range cannot move a boundary by a day.
 */
function shiftDay(dayStr, deltaDays) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

const isDayStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * The min/max NY day (inclusive) for a quick preset, relative to today. Presets overlap
 * on purpose (Yesterday ⊂ Last 7 days ⊂ Last 30 days) — they are alternative shortcuts,
 * not a partition, so their counts are not expected to sum to the total.
 */
function presetDayBounds(preset) {
  const today = nyDay(new Date());
  switch (preset) {
    case 'today':
      return { min: today, max: today };
    case 'yesterday': {
      const y = shiftDay(today, -1);
      return { min: y, max: y };
    }
    case 'last7':
      return { min: shiftDay(today, -6), max: today };
    case 'last30':
      return { min: shiftDay(today, -29), max: today };
    case 'older30':
      // Strictly before the Last-30 window starts.
      return { max: shiftDay(today, -30) };
    default:
      return null;
  }
}

/**
 * A `$match` on the derived `_createdDayNY` string. An explicit from/to range wins over a
 * preset. String comparison is exact here because YYYY-MM-DD sorts chronologically.
 */
function dateDayMatch({ preset, from, to }) {
  if (isDayStr(from) || isDayStr(to)) {
    const cond = {};
    if (isDayStr(from)) cond.$gte = from;
    if (isDayStr(to)) cond.$lte = to;
    return Object.keys(cond).length ? { _createdDayNY: cond } : null;
  }
  const b = presetDayBounds(preset);
  if (!b) return null;
  const cond = {};
  if (b.min) cond.$gte = b.min;
  if (b.max) cond.$lte = b.max;
  return { _createdDayNY: cond };
}

/**
 * Aggregation stages that derive the values this tab computes rather than stores:
 *
 *   _phoneKey     — the lead's last-10 digits. CampaignBooking.normalizedClientPhone is
 *                   already last-10, but ~9 rows never got one (written through an update
 *                   path that skips the pre-save hook), so fall back to the raw
 *                   clientPhone and truncate it here.
 *
 *   _type         — the job-type answer, which the ingest buries in the first line of
 *                   `anythingToKnow` ("Job type: opt_jobs"). Null unless it is a real
 *                   answer, because both ingest paths have been landing junk in that slot:
 *                   the lead's phone number (Sheets sends the phone in its `job_type`
 *                   column) and bare field names. Rendering a phone number under "Type"
 *                   would be wrong and would duplicate the Phone column.
 *
 *   _createdDayNY — the form-fill day as a NY calendar-day string, for the date filters.
 *
 * Defined once and shared by the list and summary endpoints, so a lead can never be
 * filtered under one definition and displayed under another.
 */
const DERIVE_STAGES = [
  {
    $addFields: {
      _rawPhone: {
        $cond: [
          { $ne: [{ $ifNull: ['$normalizedClientPhone', ''] }, ''] },
          '$normalizedClientPhone',
          { $ifNull: ['$clientPhone', ''] },
        ],
      },
      _jtRaw: {
        $let: {
          vars: {
            m: {
              $regexFind: {
                input: { $ifNull: ['$anythingToKnow', ''] },
                regex: 'Job type:[ \\t]*([^\\n\\r]*)',
              },
            },
          },
          in: { $trim: { input: { $ifNull: [{ $arrayElemAt: ['$$m.captures', 0] }, ''] } } },
        },
      },
    },
  },
  {
    $addFields: {
      _digits: {
        $reduce: {
          input: { $regexFindAll: { input: '$_rawPhone', regex: '[0-9]' } },
          initialValue: '',
          in: { $concat: ['$$value', '$$this.match'] },
        },
      },
    },
  },
  {
    $addFields: {
      _phoneKey: {
        $cond: [
          { $gt: [{ $strLenCP: '$_digits' }, 10] },
          { $substrCP: ['$_digits', { $subtract: [{ $strLenCP: '$_digits' }, 10] }, 10] },
          '$_digits',
        ],
      },
      _type: {
        $cond: [
          {
            $or: [
              { $eq: ['$_jtRaw', ''] },
              // No letter anywhere: "+1", "+9163", a bare digit string.
              { $not: [{ $regexMatch: { input: '$_jtRaw', regex: '[A-Za-z]' } }] },
              { $regexMatch: { input: '$_jtRaw', regex: PHONE_LIKE_RX } },
              { $in: [{ $toLower: '$_jtRaw' }, LEAKED_FIELD_NAMES] },
            ],
          },
          null,
          '$_jtRaw',
        ],
      },
      // The lead's form-fill day as a NY calendar-day string. Both the day-range filter
      // and the quick presets compare against this, so a lead can never be counted under
      // one day boundary and filtered under another.
      _createdDayNY: {
        $dateToString: { date: '$bookingCreatedAt', format: '%Y-%m-%d', timezone: TZ },
      },
    },
  },
];

/**
 * A call long enough to have been an actual conversation rather than a ring-out.
 * Same threshold the Graphs 03 tab uses, so the two never disagree about what
 * "reached the client" means.
 */
const CONVERSATION_MIN_SEC = 60;

/**
 * Which numbers have been called at all, and which produced a real conversation.
 *
 * Held in memory and passed back into the pipeline: there are a few hundred distinct
 * called numbers against a lead set in the thousands. That is what lets the status
 * filter run INSIDE the query, so totalCount and the page count describe the filtered
 * set instead of the filter quietly trimming a single page.
 */
async function callActivityKeys() {
  const rows = await CallLogModel.find({ leadNumberNormalized: { $nin: [null, ''] } })
    .select('leadNumberNormalized durationSec')
    .lean();

  const called = new Set();
  const conversed = new Set();
  for (const r of rows) {
    const k = last10(r.leadNumberNormalized);
    if (!k) continue;
    called.add(k);
    if ((Number(r.durationSec) || 0) >= CONVERSATION_MIN_SEC) conversed.add(k);
  }
  return { calledKeys: [...called], conversationKeys: [...conversed] };
}

/**
 * Call progress — the only status that carries information on this tab.
 *
 * Every lead here is `bookingStatus: 'not-scheduled'` by definition, so showing that
 * would be a column with one value repeated down every row. What a caller actually
 * needs to know is how far along the lead is:
 *
 *   new       — Zoom has no call to this number
 *   attempted — Zoom logged a call, but none reached 60s (rang out, voicemail, hang-up)
 *   contacted — a call of 60s or more actually happened
 *
 * Derived purely from Zoom's CallLog, the same source the Phone Calls tab reads. The
 * three are mutually exclusive and cover the set, so they can be counted as a funnel.
 */
function statusStage(calledKeys, conversationKeys) {
  return {
    $addFields: {
      _status: {
        $cond: [
          { $in: ['$_phoneKey', conversationKeys] },
          'contacted',
          { $cond: [{ $in: ['$_phoneKey', calledKeys] }, 'attempted', 'new'] },
        ],
      },
    },
  };
}

const jobTypeLabel = (t) =>
  t ? JOB_TYPE_LABELS[t] || t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;

/** Digits only, e.g. "+1 (817) 757-6833" -> "18177576833". */
const digitsOf = (s) => String(s || '').replace(/\D+/g, '');

/**
 * The last 10 digits — the one key both phone conventions in this codebase agree on.
 * CampaignBooking.normalizedClientPhone is last-10, but CallLog.leadNumberNormalized
 * only strips a leading US "1" (Utils/ZoomPhone.js), so a +91 number is stored as
 * "919959348539" on one side and "9959348539" on the other. Comparing the last 10
 * digits matches both without special-casing country codes.
 */
const last10 = (s) => {
  const d = digitsOf(s);
  return d.length > 10 ? d.slice(-10) : d;
};

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

/**
 * Every digit string a CallLog might have stored this lead's number under.
 *
 * Must consider BOTH fields: normalizedClientPhone is already truncated to 10 digits,
 * so on its own it can never produce the country-code form ("919959348539") that
 * CallLog.leadNumberNormalized holds for a non-US number. clientPhone keeps the full
 * number, so it is what yields that form.
 */
function phoneCandidatesOf(booking, into) {
  for (const raw of [booking.normalizedClientPhone, booking.clientPhone]) {
    const d = digitsOf(raw);
    if (!d) continue;
    into.add(d);
    into.add(last10(d));
  }
  return into;
}

function cutoffDate() {
  return new Date(Date.now() - COOL_OFF_HOURS * 60 * 60 * 1000);
}

/** The full set of leads this tab is about, before any user-supplied filter. */
function baseMatch() {
  return {
    ...META_LEAD_MATCH,
    bookingStatus: { $in: ['not-scheduled', 'no-show'] },
    bookingCreatedAt: { $lte: cutoffDate() },
  };
}

/* ------------------------------------------------------------------------ */
/* BDA assignment                                                            */
/* ------------------------------------------------------------------------ */

// Call leads are distributed round-robin between these two BDAs (oldest lead first).
const CALL_BDA_EMAILS = ['kalpataru@flashfirehq.com', 'siddhartha@flashfirehq.com'];

/**
 * The active non-admin BDAs, in a stable order. Used for view scoping.
 *
 * `role: 'bda'` alone is NOT a safe test: CrmUser.role DEFAULTS to 'bda', so an admin
 * whose document predates the field — or who simply never had it set — reads as a BDA.
 * Requiring isAdmin !== true drops them.
 */
async function rotationBdas() {
  const users = await CrmUserModel.find({
    role: 'bda',
    isActive: { $ne: false },
    isAdmin: { $ne: true },
  })
    .select('email name')
    .lean();

  return users
    .map((u) => ({ email: String(u.email).toLowerCase().trim(), name: u.name || u.email }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * The email this request may see, or null for someone who sees every lead.
 *
 * A non-admin BDA sees only their own leads; everyone else sees all of them. This
 * stays roster-based even with a fixed assignee, so a BDA who is not the fixed
 * assignee simply sees an empty queue instead of other people's leads.
 *
 * Resolved from the database rather than the JWT on purpose. The token's `bdaRole`
 * claim is `user.role || 'bda'`, so an admin with no role field arrives claiming to be
 * a BDA and would otherwise be scoped to an empty queue.
 */
async function ownScopeEmail(req) {
  const email = req.crmUser?.email ? String(req.crmUser.email).toLowerCase().trim() : null;
  if (!email) return null;
  const roster = await rotationBdas();
  return roster.some((b) => b.email === email) ? email : null;
}

/**
 * Assign every unassigned call lead to the fixed assignee.
 *
 * Existing assignments are never touched: only leads with an empty
 * callLeadAssignee are considered, and every update re-asserts "still
 * unassigned" in its own filter, so the pass is idempotent and safe to run
 * concurrently. Oldest leads go first — they have waited longest.
 */
export async function assignUnassignedCallLeads({ limit = 5000 } = {}) {
  // Load only the BDAs in CALL_BDA_EMAILS that are active
  const bdaDocs = await CrmUserModel.find({
    email: { $in: CALL_BDA_EMAILS },
    isActive: { $ne: false },
  })
    .select('email name')
    .lean();

  if (bdaDocs.length === 0) {
    return { ok: true, assigned: 0, reason: 'no active call BDAs found' };
  }

  // Keep stable order matching CALL_BDA_EMAILS
  const assignees = CALL_BDA_EMAILS
    .map((e) => bdaDocs.find((d) => String(d.email).toLowerCase().trim() === e))
    .filter(Boolean)
    .map((d) => ({ email: String(d.email).toLowerCase().trim(), name: d.name || d.email }));

  const pending = await CampaignBookingModel.find({
    ...baseMatch(),
    'callLeadAssignee.email': { $in: [null, ''] },
  })
    .select('bookingId')
    .sort({ bookingCreatedAt: 1 })
    .limit(limit)
    .lean();

  if (pending.length === 0) return { ok: true, assigned: 0 };

  const now = new Date();
  const ops = pending.map((lead, i) => {
    const pick = assignees[i % assignees.length];
    return {
      updateOne: {
        filter: { bookingId: lead.bookingId, 'callLeadAssignee.email': { $in: [null, ''] } },
        update: {
          $set: {
            'callLeadAssignee.email': pick.email,
            'callLeadAssignee.name': pick.name,
            'callLeadAssignee.assignedAt': now,
          },
        },
      },
    };
  });

  const result = await CampaignBookingModel.bulkWrite(ops, { ordered: false });

  return {
    ok: true,
    assigned: result.modifiedCount ?? 0,
    considered: pending.length,
    assignees: assignees.map((a) => a.email),
  };
}

/**
 * Fetch every CallLog belonging to the given leads, in one indexed query, and
 * bucket them by last-10 phone key.
 *
 * `leadNumberNormalized` is indexed, so we query it by exact value ($in) rather
 * than with a suffix regex (which could not use the index). We pass both digit
 * forms — the last-10 and the full digit string — so a call logged under a full
 * international number is still found.
 */
async function callsByPhoneKey(bookings) {
  const candidates = new Set();
  for (const b of bookings) phoneCandidatesOf(b, candidates);
  const byKey = new Map();
  if (candidates.size === 0) return byKey;

  const rows = await CallLogModel.find({ leadNumberNormalized: { $in: [...candidates] } })
    .select('leadNumberNormalized salesEmail salesName durationSec direction status startedAt callId')
    .sort({ startedAt: -1 })
    .lean();

  for (const r of rows) {
    const key = last10(r.leadNumberNormalized);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return byKey;
}

/** Roll a lead's raw CallLog rows up into the numbers the table shows. */
function summarizeCalls(rows) {
  const list = rows || [];
  const byAgent = new Map();
  let totalDurationSec = 0;
  let lastCallAt = null;

  for (const r of list) {
    const sec = Number(r.durationSec) || 0;
    totalDurationSec += sec;
    if (r.startedAt && (!lastCallAt || r.startedAt > lastCallAt)) lastCallAt = r.startedAt;

    // A call with no salesEmail is one Zoom could not attribute to an agent. Keep it
    // in the totals (it happened) but do not invent a caller for it.
    const email = nonEmpty(r.salesEmail) ? r.salesEmail.toLowerCase() : null;
    const key = email || '__unattributed__';
    if (!byAgent.has(key)) {
      byAgent.set(key, { email, name: r.salesName || null, calls: 0, durationSec: 0 });
    }
    const a = byAgent.get(key);
    a.calls += 1;
    a.durationSec += sec;
    if (!a.name && r.salesName) a.name = r.salesName;
  }

  const callers = [...byAgent.values()].sort((a, b) => b.calls - a.calls);

  return {
    count: list.length,
    totalDurationSec,
    lastCallAt,
    callers,
    // Newest first, capped — the row detail panel does not need an unbounded history.
    history: list.slice(0, 20).map((r) => ({
      callId: r.callId,
      startedAt: r.startedAt,
      durationSec: Number(r.durationSec) || 0,
      direction: r.direction,
      status: r.status,
      salesName: r.salesName || null,
      salesEmail: r.salesEmail || null,
    })),
  };
}

/** GET /api/crm/call-leads */
export const getCallLeads = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
    const search = String(req.query.search || '').trim();
    const typeFilter = String(req.query.type || '').trim();
    const assigneeFilter = String(req.query.assignee || '').trim().toLowerCase();
    const statusFilter = String(req.query.status || 'all').trim();
    const datePreset = String(req.query.datePreset || '').trim();
    const dateFrom = String(req.query.from || '').trim();
    const dateTo = String(req.query.to || '').trim();
    const sort = String(req.query.sort || 'newest').trim();

    const match = baseMatch();

    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      // `match` already owns a top-level $or (the Meta-source test), so the search
      // clause has to be $and-ed in rather than overwrite it.
      match.$and = [{ $or: [{ clientName: rx }, { clientEmail: rx }, { clientPhone: rx }] }];
    }

    if (assigneeFilter === 'unassigned') {
      match['callLeadAssignee.email'] = { $in: [null, ''] };
    } else if (assigneeFilter) {
      match['callLeadAssignee.email'] = assigneeFilter;
    }

    // Applied last so it overwrites any assignee filter: a BDA cannot widen their own
    // scope by passing ?assignee=someone-else.
    const scopedTo = await ownScopeEmail(req);
    if (scopedTo) match['callLeadAssignee.email'] = scopedTo;

    const { calledKeys, conversationKeys } = await callActivityKeys();

    const pipeline = [
      { $match: match },
      ...DERIVE_STAGES,
      statusStage(calledKeys, conversationKeys),
    ];

    // These run INSIDE the query, so totalCount and the page count describe the filtered
    // set. Filtering after $limit would only ever trim the current page — ask for
    // "contacted", land on page 1 of the newest leads, and see an empty table while the
    // contacted ones sat on later pages.
    if (typeFilter && typeFilter !== 'all') {
      pipeline.push({ $match: typeFilter === 'unknown' ? { _type: null } : { _type: typeFilter } });
    }
    if (['new', 'attempted', 'contacted'].includes(statusFilter)) {
      pipeline.push({ $match: { _status: statusFilter } });
    }
    const dateMatch = dateDayMatch({ preset: datePreset, from: dateFrom, to: dateTo });
    if (dateMatch) pipeline.push({ $match: dateMatch });

    const [facet] = await CampaignBookingModel.aggregate([
      ...pipeline,
      {
        $facet: {
          rows: [
            { $sort: { bookingCreatedAt: sort === 'oldest' ? 1 : -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                bookingId: 1, clientName: 1, clientEmail: 1, clientPhone: 1,
                normalizedClientPhone: 1, bookingStatus: 1, bookingCreatedAt: 1,
                metaCampaignName: 1, metaPlatform: 1, callLeadAssignee: 1, callLeadNotes: 1,
                _phoneKey: 1, _type: 1, _status: 1,
              },
            },
          ],
          total: [{ $count: 'n' }],
        },
      },
    ]);

    const bookings = facet?.rows ?? [];
    const totalCount = facet?.total?.[0]?.n ?? 0;

    const callMap = await callsByPhoneKey(bookings);
    const now = Date.now();

    const data = bookings.map((b) => {
      const type = b._type ?? null;
      const calls = summarizeCalls(callMap.get(b._phoneKey));

      const notes = (b.callLeadNotes || [])
        .map((n) => ({
          text: n.text,
          authorEmail: n.authorEmail || null,
          authorName: n.authorName || n.authorEmail || 'Unknown',
          createdAt: n.createdAt,
        }))
        .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));

      return {
        bookingId: b.bookingId,
        clientName: b.clientName,
        clientEmail: b.clientEmail,
        clientPhone: b.clientPhone,
        type,
        typeLabel: jobTypeLabel(type),
        // Call progress: new | attempted | contacted. NOT bookingStatus, which is
        // 'not-scheduled' on every row here and so says nothing.
        status: b._status,
        bookingCreatedAt: b.bookingCreatedAt,
        ageHours: b.bookingCreatedAt
          ? Math.floor((now - new Date(b.bookingCreatedAt).getTime()) / 3600000)
          : null,
        campaign: b.metaCampaignName || null,
        platform: b.metaPlatform || null,
        assignedBda: assigneeOf(b),
        notes,
        notesCount: notes.length,
        calls,
      };
    });

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
      // Non-null when the caller is a BDA seeing only their own queue. The UI uses it
      // to drop the columns and filters that are meaningless in that view.
      scopedTo,
      coolOffHours: COOL_OFF_HOURS,
    });
  } catch (error) {
    console.error('[CallLeads] getCallLeads error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * GET /api/crm/call-leads/summary
 * Whole-set counters + the values the filter dropdowns offer. Kept off the list
 * endpoint so paging does not recompute it.
 */
export const getCallLeadsSummary = async (req, res) => {
  try {
    const { calledKeys, conversationKeys } = await callActivityKeys();

    // A BDA's counters must describe THEIR queue. Showing them "1,611 leads to call"
    // when 806 are someone else's would be worse than showing nothing.
    const scopedTo = await ownScopeEmail(req);
    const match = baseMatch();
    if (scopedTo) match['callLeadAssignee.email'] = scopedTo;

    // Quick-preset boundaries, computed once here and reused as literals in the $group
    // below AND by dateDayMatch() at query time — same day strings both places, so each
    // chip's count is exactly what clicking it returns.
    const today = nyDay(new Date());
    const dYesterday = shiftDay(today, -1);
    const dLast7From = shiftDay(today, -6);
    const dLast30From = shiftDay(today, -29);
    const dOlder30To = shiftDay(today, -30);
    const inRange = (from, to) => ({
      $and: [{ $gte: ['$_createdDayNY', from] }, { $lte: ['$_createdDayNY', to] }],
    });

    const [facet] = await CampaignBookingModel.aggregate([
      { $match: match },
      ...DERIVE_STAGES,
      statusStage(calledKeys, conversationKeys),
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                // The funnel. Mutually exclusive, so these three sum to `total`.
                statusNew: { $sum: { $cond: [{ $eq: ['$_status', 'new'] }, 1, 0] } },
                attempted: { $sum: { $cond: [{ $eq: ['$_status', 'attempted'] }, 1, 0] } },
                contacted: { $sum: { $cond: [{ $eq: ['$_status', 'contacted'] }, 1, 0] } },
                assigned: {
                  $sum: {
                    $cond: [{ $ne: [{ $ifNull: ['$callLeadAssignee.email', ''] }, ''] }, 1, 0],
                  },
                },
                // A lead with no number cannot be called from this tab. Reported,
                // not silently folded into "never called".
                noPhone: { $sum: { $cond: [{ $eq: ['$_phoneKey', ''] }, 1, 0] } },
                // Quick-preset counts. These OVERLAP (yesterday ⊂ last7 ⊂ last30), so
                // they are not expected to sum to total.
                qYesterday: { $sum: { $cond: [{ $eq: ['$_createdDayNY', dYesterday] }, 1, 0] } },
                qLast7: { $sum: { $cond: [inRange(dLast7From, today), 1, 0] } },
                qLast30: { $sum: { $cond: [inRange(dLast30From, today), 1, 0] } },
                qOlder30: { $sum: { $cond: [{ $lte: ['$_createdDayNY', dOlder30To] }, 1, 0] } },
                // Oldest form-fill day present — bounds the range picker's "From".
                oldestDay: { $min: '$_createdDayNY' },
              },
            },
          ],
          byType: [{ $group: { _id: '$_type', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          byAssignee: [
            { $match: { 'callLeadAssignee.email': { $nin: [null, ''] } } },
            {
              $group: {
                _id: '$callLeadAssignee.email',
                name: { $first: '$callLeadAssignee.name' },
                leads: { $sum: 1 },
              },
            },
            { $sort: { leads: -1 } },
          ],
        },
      },
    ]);

    const t = facet?.totals?.[0] ?? {
      total: 0, statusNew: 0, attempted: 0, contacted: 0, assigned: 0, noPhone: 0,
      qYesterday: 0, qLast7: 0, qLast30: 0, qOlder30: 0, oldestDay: null,
    };

    return res.status(200).json({
      success: true,
      summary: {
        total: t.total,
        new: t.statusNew,
        attempted: t.attempted,
        contacted: t.contacted,
        assigned: t.assigned,
        unassigned: t.total - t.assigned,
        noPhone: t.noPhone,
      },
      types: (facet?.byType ?? []).map((r) => ({
        value: r._id ?? 'unknown',
        label: r._id ? jobTypeLabel(r._id) : 'Unknown',
        count: r.count,
      })),
      statuses: [
        { value: 'new', label: 'New', count: t.statusNew },
        { value: 'attempted', label: 'Attempted', count: t.attempted },
        { value: 'contacted', label: 'Contacted', count: t.contacted },
      ],
      // Quick date presets. Counts overlap by design — alternative shortcuts, not a
      // partition — so they do not sum to total.
      dateQuick: [
        { value: 'yesterday', label: 'Yesterday', count: t.qYesterday },
        { value: 'last7', label: 'Last 7 days', count: t.qLast7 },
        { value: 'last30', label: 'Last 30 days', count: t.qLast30 },
        { value: 'older30', label: '30+ days', count: t.qOlder30 },
      ],
      // The window the day-range picker may span: from the oldest form-fill up to today.
      // Lets the UI bound its date inputs instead of allowing absurd dates.
      dateBounds: { min: t.oldestDay, max: today },
      assignees: (facet?.byAssignee ?? []).map((r) => ({
        email: r._id,
        name: r.name || r._id,
        leads: r.leads,
      })),
      scopedTo,
      coolOffHours: COOL_OFF_HOURS,
    });
  } catch (error) {
    console.error('[CallLeads] getCallLeadsSummary error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Force reassignment of all call leads to Kalpataru.
 */
export async function reassignAllLeadsToKalpataru() {
  const kalpataru = await CrmUserModel.findOne({
    email: 'kalpataru@flashfirehq.com',
    isActive: { $ne: false },
  }).lean();

  if (!kalpataru) {
    throw new Error('Kalpataru user not found or inactive');
  }

  const match = {
    $or: [{ leadSource: 'meta_lead_ad' }, { metaLeadId: { $exists: true, $ne: null } }],
    bookingStatus: 'not-scheduled',
    scheduledEventStartTime: null,
  };

  const leads = await CampaignBookingModel.find(match).select('bookingId').lean();
  const now = new Date();

  const ops = leads.map((lead) => ({
    updateOne: {
      filter: { bookingId: lead.bookingId },
      update: {
        $set: {
          'callLeadAssignee.email': kalpataru.email,
          'callLeadAssignee.name': kalpataru.name,
          'callLeadAssignee.assignedAt': now,
        },
      },
    },
  }));

  if (ops.length === 0) return { assigned: 0 };
  const result = await CampaignBookingModel.bulkWrite(ops, { ordered: false });
  return { assigned: result.modifiedCount };
}

/**
 * POST /api/crm/call-leads/assign
 * Manual trigger for the assignment pass. The scheduler runs it anyway; this exists
 * so an admin can force a pass without waiting for the tick.
 */
export const triggerCallLeadAssignment = async (req, res) => {
  try {
    // A scoped BDA must not be able to reshuffle the queue.
    if (await ownScopeEmail(req)) {
      return res.status(403).json({ success: false, error: 'Admins only' });
    }
    const result = await assignUnassignedCallLeads({});
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[CallLeads] triggerCallLeadAssignment error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Guard for the write endpoints. A scoped BDA may only act on leads that are already
 * theirs — the list already hides everyone else's, and this closes the gap where a
 * bookingId could simply be POSTed directly.
 *
 * Returns an error object to send, or null to proceed.
 */
async function denyIfNotOwn(req, booking) {
  const scopedTo = await ownScopeEmail(req);
  if (!scopedTo) return null;

  const owner = String(booking.callLeadAssignee?.email || '').toLowerCase();
  if (owner === scopedTo) return null;

  return owner
    ? { code: 403, error: 'This lead is assigned to another BDA' }
    : { code: 403, error: 'This lead is not assigned to you yet' };
}

/** Shape the stored assignee for the API, or null when nobody owns the lead. */
const assigneeOf = (booking) =>
  nonEmpty(booking?.callLeadAssignee?.email)
    ? {
        email: booking.callLeadAssignee.email,
        name: booking.callLeadAssignee.name || booking.callLeadAssignee.email,
        assignedAt: booking.callLeadAssignee.assignedAt || null,
      }
    : null;

/** POST /api/crm/call-leads/:bookingId/notes  { text } */
export const addCallLeadNote = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const text = String(req.body?.text ?? '').trim();

    if (!text) {
      return res.status(400).json({ success: false, error: 'Note text is required' });
    }
    if (text.length > MAX_NOTE_LENGTH) {
      return res
        .status(400)
        .json({ success: false, error: `Note is too long (max ${MAX_NOTE_LENGTH} characters)` });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId })
      .select('bookingId bookingStatus callLeadAssignee')
      .lean();
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }
    if (booking.bookingStatus !== 'not-scheduled') {
      return res.status(400).json({
        success: false,
        error: 'This lead has already booked a meeting and is no longer a call lead',
      });
    }

    const denied = await denyIfNotOwn(req, booking);
    if (denied) return res.status(denied.code).json({ success: false, error: denied.error });

    const note = {
      text,
      authorEmail: req.crmUser?.email ? String(req.crmUser.email).toLowerCase() : null,
      authorName: req.crmUser?.name || req.crmUser?.email || null,
      createdAt: new Date(),
    };

    // Writing a note does NOT claim the lead. Round-robin owns assignment; letting a
    // touch claim it would hand ownership to whichever admin happened to look first.
    const updated = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      { $push: { callLeadNotes: note } },
      { new: true }
    )
      .select('callLeadNotes callLeadAssignee')
      .lean();

    const notes = (updated?.callLeadNotes || [])
      .map((n) => ({
        text: n.text,
        authorEmail: n.authorEmail || null,
        authorName: n.authorName || n.authorEmail || 'Unknown',
        createdAt: n.createdAt,
      }))
      .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));

    return res.status(200).json({
      success: true,
      notes,
      assignedBda: assigneeOf(updated),
    });
  } catch (error) {
    console.error('[CallLeads] addCallLeadNote error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// Note: there is deliberately no "call attempt" endpoint. Clicking Call opens the
// `zoomphonecall://` deep link and nothing else — every call fact on this tab (who
// called, how long, when) comes from Zoom's own CallLog, exactly like the Phone Calls
// tab. Recording our own click would be a second, disagreeing source of truth.

/* ------------------------------------------------------------------------ */
/* Daily Discord summary                                                     */
/* ------------------------------------------------------------------------ */

const IST = 'Asia/Kolkata';

/** "1h 12m" / "8m" — minutes rounded, so 25s shows as "0m" like the manual reports did. */
function fmtCallTime(totalSec) {
  const min = Math.round((totalSec || 0) / 60);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}

function fmtISTStamp(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IST,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${g('month')} ${g('day')}, ${g('hour')}:${g('minute')}${g('dayPeriod')}`;
}

/**
 * Build the daily call-leads summary for the 24h window ending at `end`.
 *
 * - Only the fixed assignee's calls count: every call lead is Kalpataru's, so
 *   other people's Zoom calls (admins, other teams) are noise here, not lead
 *   calling. Internal calls are excluded for the same reason.
 *   Both the headline and the per-BDA numbers count UNIQUE leads dialed (a
 *   redial is one lead), so the breakdown always sums to "Called".
 * - "Left to call" is the callable queue from the last 3 days: call leads
 *   created in the past 72h, already past the 24h cool-off, never called.
 */
export async function buildCallLeadsDailySummary(end = new Date()) {
  const windowStart = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  const calls = await CallLogModel.find({
    startedAt: { $gte: windowStart, $lt: end },
    direction: { $ne: 'internal' },
    salesEmail: { $in: CALL_BDA_EMAILS },
  })
    .select('salesEmail salesName leadNumberNormalized durationSec')
    .lean();

  const uniqueLeads = new Set();
  let totalSec = 0;
  const byBda = new Map();
  for (const c of calls) {
    if (c.leadNumberNormalized) uniqueLeads.add(c.leadNumberNormalized);
    totalSec += c.durationSec || 0;
    const key = (c.salesEmail || 'unknown').toLowerCase();
    const row = byBda.get(key) || { name: c.salesName || c.salesEmail || 'Unknown', leads: new Set(), sec: 0 };
    if (c.salesName) row.name = c.salesName;
    // Unique leads, same as the headline — a redial is one lead, not two, so the
    // breakdown always sums to "Called".
    if (c.leadNumberNormalized) row.leads.add(c.leadNumberNormalized);
    row.sec += c.durationSec || 0;
    byBda.set(key, row);
  }

  const threeDaysAgo = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000);
  const recentLeads = await CampaignBookingModel.find({
    ...baseMatch(),
    bookingCreatedAt: { $gte: threeDaysAgo, $lte: cutoffDate() },
  })
    .select('clientPhone rawClientPhone normalizedClientPhone')
    .lean();

  const candidates = new Set();
  for (const b of recentLeads) phoneCandidatesOf(b, candidates);
  const calledNumbers = new Set(
    candidates.size > 0
      ? await CallLogModel.distinct('leadNumberNormalized', { leadNumberNormalized: { $in: [...candidates] } })
      : []
  );
  let leftToCall = 0;
  for (const b of recentLeads) {
    const own = phoneCandidatesOf(b, new Set());
    let called = false;
    for (const k of own) {
      if (calledNumbers.has(k)) { called = true; break; }
    }
    if (!called) leftToCall += 1;
  }

  const breakdown = [...byBda.values()].sort((a, b) => b.leads.size - a.leads.size);
  const lines = [
    `📞 Call Leads Summary — ${fmtISTStamp(windowStart)} → ${fmtISTStamp(end)} IST`,
    `✅ Called: ${uniqueLeads.size}`,
    `⏳ Left to call (last 3 days): ${leftToCall}`,
    `🕐 Time on calls: ${fmtCallTime(totalSec)}`,
  ];
  if (breakdown.length > 0) {
    lines.push('', 'BDA Breakdown:');
    for (const r of breakdown) lines.push(`• ${r.name}: ${r.leads.size} call${r.leads.size === 1 ? '' : 's'} · ${fmtCallTime(r.sec)}`);
  }

  return {
    message: lines.join('\n'),
    stats: { uniqueLeadsCalled: uniqueLeads.size, totalCalls: calls.length, totalSec, leftToCall },
  };
}

/** Build today's summary and post it to the call-leads Discord channel. */
export async function sendCallLeadsDailySummary() {
  const url = process.env.DISCORD_CALL_LEADS_SUMMARY_WEBHOOK_URL;
  if (!url) {
    console.warn('⚠️ [CallLeads] DISCORD_CALL_LEADS_SUMMARY_WEBHOOK_URL not configured — daily summary skipped');
    return { ok: false, error: 'no_url' };
  }
  const { message, stats } = await buildCallLeadsDailySummary(new Date());
  const { DiscordConnect } = await import('../Utils/DiscordConnect.js');
  const result = await DiscordConnect(url, message, false);
  console.log(`${result.ok ? '✅' : '❌'} [CallLeads] daily summary ${result.ok ? 'sent' : 'failed'}`, stats);
  return result;
}

/* ------------------------------------------------------------------------ */
/* Pending leads: no-show + not-scheduled, past 3 days, per BDA              */
/* ------------------------------------------------------------------------ */

const PENDING_DAYS = 3;
// "kalpataru@flashfirehq.com" -> "Kalpataru": the display name is not reliable ("Basaveni siddhartha").
const shortName = (s) => {
  const local = String(s.email || '').split('@')[0];
  return local ? local[0].toUpperCase() + local.slice(1) : String(s.bda || 'Unassigned').trim().split(/\s+/)[0];
};

/**
 * Every call lead from the past `days` days that is still a no-show or never scheduled,
 * with its owner and whether the BDA has dialed it. Pure data: the 12 AM Discord message and
 * the sheet's "Call Leads" tab both read this, so the two can never disagree.
 *
 * Same lead definition as the Call Leads tab (`baseMatch`: Meta lead, not-scheduled or
 * no-show, past the 24h cool-off). "Called" means any non-internal CallLog row on the lead's
 * number, matched on the same phone candidates the tab uses.
 */
export async function buildPendingCallLeads({ end = new Date(), days = PENDING_DAYS } = {}) {
  const since = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const bookings = await CampaignBookingModel.find({
    ...baseMatch(),
    bookingCreatedAt: { $gte: since, $lte: cutoffDate() },
  })
    .select('bookingId clientName clientEmail clientPhone normalizedClientPhone bookingStatus bookingCreatedAt callLeadAssignee utmCampaign leadMarket')
    .sort({ bookingCreatedAt: -1 })
    .lean();

  const candidates = new Set();
  for (const b of bookings) phoneCandidatesOf(b, candidates);
  const logs = candidates.size
    ? await CallLogModel.find({ leadNumberNormalized: { $in: [...candidates] }, direction: { $ne: 'internal' } })
        .select('leadNumberNormalized startedAt durationSec')
        .lean()
    : [];
  const byNumber = new Map();
  for (const l of logs) {
    const row = byNumber.get(l.leadNumberNormalized) || { count: 0, last: null, sec: 0 };
    row.count += 1;
    row.sec += l.durationSec || 0;
    if (l.startedAt && (!row.last || l.startedAt > row.last)) row.last = l.startedAt;
    byNumber.set(l.leadNumberNormalized, row);
  }

  const users = await CrmUserModel.find({ email: { $in: CALL_BDA_EMAILS } }).select('email name').lean();
  const nameOf = new Map(users.map((u) => [String(u.email).toLowerCase(), u.name]));

  const leads = bookings.map((b) => {
    const email = String(b.callLeadAssignee?.email || '').toLowerCase();
    let count = 0;
    let sec = 0;
    let last = null;
    for (const k of phoneCandidatesOf(b, new Set())) {
      const r = byNumber.get(k);
      if (!r) continue;
      count = Math.max(count, r.count);
      sec = Math.max(sec, r.sec);
      if (r.last && (!last || r.last > last)) last = r.last;
    }
    return {
      bookingId: b.bookingId,
      bdaEmail: email,
      bda: b.callLeadAssignee?.name || nameOf.get(email) || (email ? email : 'Unassigned'),
      name: b.clientName || '',
      phone: b.clientPhone || '',
      email: b.clientEmail || '',
      country: countryFor({ campaign: b.utmCampaign, phone: b.clientPhone, market: b.leadMarket }),
      status: b.bookingStatus === 'no-show' ? 'no-show' : 'not-scheduled',
      formFilledAt: b.bookingCreatedAt ? new Date(b.bookingCreatedAt).toISOString() : null,
      lastCalledAt: last ? new Date(last).toISOString() : null,
      callCount: count,
      callSec: sec,
      called: count > 0,
    };
  });

  const order = [...CALL_BDA_EMAILS, ''];
  const keys = [...new Set([...order, ...leads.map((l) => l.bdaEmail)])].filter((k) => leads.some((l) => l.bdaEmail === k) || CALL_BDA_EMAILS.includes(k));
  const summary = keys.map((k) => {
    const mine = leads.filter((l) => l.bdaEmail === k);
    const left = mine.filter((l) => !l.called);
    return {
      bda: mine[0]?.bda || nameOf.get(k) || k || 'Unassigned',
      email: k,
      noShow: mine.filter((l) => l.status === 'no-show').length,
      notScheduled: mine.filter((l) => l.status === 'not-scheduled').length,
      total: mine.length,
      called: mine.length - left.length,
      left: left.length,
      leftNoShow: left.filter((l) => l.status === 'no-show').length,
      leftNotScheduled: left.filter((l) => l.status === 'not-scheduled').length,
      callMinutes: Math.round(mine.reduce((n, l) => n + l.callSec, 0) / 60),
    };
  });
  return { generatedAt: end.toISOString(), windowDays: days, summary, leads };
}

/** The 12 AM IST Discord message: what each BDA still has to call from the past 3 days. */
export function formatPendingCallLeadsMessage(data) {
  const lines = [`📋 Pending call leads — past ${data.windowDays} days (no-show + not scheduled)`];
  for (const s of data.summary) {
    lines.push('', `**${shortName(s)}** — ${s.left} left to call (${s.leftNoShow} no-show · ${s.leftNotScheduled} not scheduled), ${s.called} already called of ${s.total}`);
  }
  if (data.summary.length === 0) lines.push('', 'No pending leads.');
  return lines.join('\n');
}

/** Build the pending-leads message and post it to the call-leads Discord channel. */
export async function sendPendingCallLeadsSummary(end = new Date()) {
  const url = process.env.DISCORD_CALL_LEADS_SUMMARY_WEBHOOK_URL;
  if (!url) {
    console.warn('⚠️ [CallLeads] DISCORD_CALL_LEADS_SUMMARY_WEBHOOK_URL not configured — pending summary skipped');
    return { ok: false, error: 'no_url' };
  }
  const data = await buildPendingCallLeads({ end });
  const { DiscordConnect } = await import('../Utils/DiscordConnect.js');
  const result = await DiscordConnect(url, formatPendingCallLeadsMessage(data), false);
  console.log(`${result.ok ? '✅' : '❌'} [CallLeads] pending summary ${result.ok ? 'sent' : 'failed'}`, data.summary.map((s) => `${s.email}:${s.left}`).join(' '));
  return result;
}

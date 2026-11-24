import { DateTime, IANAZone } from 'luxon';
import { getRescheduleLinkForBooking } from './CalendlyAPIHelper.js';
import { normalizeTimezoneLabel, displayZoneFor, FORCE_EASTERN_DISPLAY, EASTERN_DISPLAY_LABEL } from './MeetingReminderUtils.js';
import { PRODUCT_DEMO_LINK } from '../config/watiTemplates.js';

export { PRODUCT_DEMO_LINK };

const DEFAULT_SCHEDULING_LINK = 'https://calendly.com/feedback-flashfire/15min';


// Fixed base of the "Reschedule" dynamic URL button on the
// flashfire_appointment_reminder_b template. The button URL is
// `https://calendly.com/{{6}}`, so we only send the path that comes AFTER this base.
const DEFAULT_BUTTON_TAIL = 'feedback-flashfire/15min';

/**
 * Extracts the path after https://calendly.com/ for a dynamic URL button whose
 * fixed base is https://calendly.com/. Unwraps Google-redirect links of the form
 * https://www.google.com/url?q=<encoded calendly url>&... first. Falls back to the
 * default scheduling path when no calendly.com URL is found (e.g. a raw Google
 * Meet link), so the button always resolves to a valid page even though the body
 * link may differ.
 */
export function calendlyButtonTail(link) {
  if (typeof link !== 'string') return DEFAULT_BUTTON_TAIL;

  let s = link.trim();

  // Unwrap Google redirect wrappers: .../url?q=<url-encoded calendly link>&sa=...
  const q = s.match(/[?&]q=([^&]+)/i);
  if (q) {
    try { s = decodeURIComponent(q[1]); } catch { /* keep original */ }
  }

  const match = s.match(/https?:\/\/calendly\.com\/(.+)$/i);
  if (match) return match[1];

  return DEFAULT_BUTTON_TAIL;
}

/**
 * Extracts the path after https://calendly.com/ for the "Cancel" dynamic URL button
 * (fixed base https://calendly.com/, sent as {{7}} on flashfire_appointment_reminder_rc).
 *
 * Prefers an explicit cancel link. When only the reschedule link is on file — true for
 * every booking created before cancel_url was captured from the webhook — it derives
 * the cancel URL by swapping the path segment: Calendly issues
 *   https://calendly.com/reschedulings/<invitee-uuid>
 *   https://calendly.com/cancellations/<invitee-uuid>
 * with the SAME uuid. Verified against 2000 stored invitee.created payloads, zero
 * exceptions.
 *
 * Returns null when no genuine cancel target can be derived. Callers must treat null
 * as "do not use the cancel template" rather than substituting a placeholder — a
 * "Cancel" button that opens a booking page is worse than no button at all.
 */
export function calendlyCancelTail(cancelLink, rescheduleLink) {
  const unwrap = (link) => {
    if (typeof link !== 'string') return null;
    let v = link.trim();
    if (!v) return null;
    // Unwrap Google redirect wrappers: .../url?q=<url-encoded calendly link>&sa=...
    const q = v.match(/[?&]q=([^&]+)/i);
    if (q) {
      try { v = decodeURIComponent(q[1]); } catch { /* keep original */ }
    }
    return v;
  };

  const direct = unwrap(cancelLink);
  if (direct) {
    const m = direct.match(/https?:\/\/calendly\.com\/(cancellations\/[^/?#]+)/i);
    if (m) return m[1];
  }

  const resched = unwrap(rescheduleLink);
  if (resched) {
    const m = resched.match(/https?:\/\/calendly\.com\/reschedulings\/([^/?#]+)/i);
    if (m) return `cancellations/${m[1]}`;
  }

  return null;
}

/**
 * Resolves timezone abbreviation from IANA timezone name.
 */
function getTimezoneAbbreviation(timezone, meetingStart) {
  if (!timezone || !meetingStart) return 'ET';

  try {
    const meetingStartUTC = DateTime.fromJSDate(new Date(meetingStart), { zone: 'utc' });
    const meetingInTimezone = meetingStartUTC.setZone(timezone);
    const offset = meetingInTimezone.offset / 60;

    if (timezone.includes('Los_Angeles') || timezone.includes('Pacific')) {
      return 'PT';
    }
    if (timezone.includes('New_York') || timezone.includes('Eastern')) {
      return 'ET';
    }
    if (timezone.includes('Chicago') || timezone.includes('Central')) {
      return 'CT';
    }
    if (timezone.includes('Denver') || timezone.includes('Mountain')) {
      return 'MT';
    }

    // Anything not named above (non-US zones, America/Phoenix, US/Eastern aliases)
    // gets its real abbreviation from the zone itself. Guessing from the UTC offset
    // labelled every -5 zone "ET", so an Asia/Kolkata client was told "2:30am ET".
    // An unparseable zone yields an invalid DateTime whose toFormat() returns the
    // string "Invalid DateTime" rather than throwing — check before trusting it.
    const realAbbr = meetingInTimezone.isValid
      ? normalizeTimezoneLabel(meetingInTimezone.toFormat('ZZZZ'))
      : '';
    if (realAbbr && !realAbbr.startsWith('GMT') && !realAbbr.startsWith('UTC')) {
      return realAbbr;
    }
    // Same India mapping the reminder path uses (sanitizeTimezoneLabel in
    // WhatsAppReminderScheduler.js), so both paths print the identical label.
    if (timezone.includes('Kolkata') || timezone.includes('Calcutta')) return 'IST';
    if (offset === -8 || offset === -7) return 'PT';
    if (offset === -5 || offset === -4) return 'ET';
    if (offset === -6) return 'CT';

    return realAbbr || 'ET';
  } catch {
    return 'ET';
  }
}

/**
 * Builds meeting time parameters (date, time with timezone) from booking data.
 * Used by cancelled1 and flashfire_appointment_reminder* templates.
 * Both the clock and the timezone label are rendered in the invitee's own zone.
 */
function buildMeetingTimeParams(booking) {
  const rawStart = booking.scheduledEventStartTime;
  if (rawStart == null || rawStart === '') {
    throw new Error('scheduledEventStartTime is missing for template');
  }
  const meetingStart = rawStart instanceof Date ? rawStart : new Date(rawStart);
  if (Number.isNaN(meetingStart.getTime())) {
    throw new Error('scheduledEventStartTime is not a valid date');
  }
  const meetingStartUTC = DateTime.fromJSDate(meetingStart, { zone: 'utc' });
  if (!meetingStartUTC.isValid) {
    throw new Error('Could not parse scheduledEventStartTime for template');
  }
  let meetingEndUTC;
  if (booking.scheduledEventEndTime) {
    const rawEnd = booking.scheduledEventEndTime instanceof Date
      ? booking.scheduledEventEndTime
      : new Date(booking.scheduledEventEndTime);
    meetingEndUTC = Number.isNaN(rawEnd.getTime())
      ? meetingStartUTC.plus({ minutes: 15 })
      : DateTime.fromJSDate(rawEnd, { zone: 'utc' });
    if (!meetingEndUTC.isValid) {
      meetingEndUTC = meetingStartUTC.plus({ minutes: 15 });
    }
  } else {
    meetingEndUTC = meetingStartUTC.plus({ minutes: 15 });
  }

  // Render the clock in the INVITEE's zone, not Eastern. The label below is derived
  // from booking.inviteeTimezone, so formatting the time in New York produced
  // "5pm PDT" for a 5pm-Eastern meeting — three hours off for a Pacific client, in
  // the direction that guarantees a missed call. Fall back to Eastern only when the
  // booking carries no usable zone.
  // displayZoneFor() applies the forced-Eastern policy; without it this falls back to
  // the invitee's own zone, and to Eastern when the booking carries no usable zone.
  const displayZone = displayZoneFor(booking.inviteeTimezone);

  const meetingDateFormatted = meetingStartUTC.setZone(displayZone).toFormat('MMM d');

  const startTimeLocal = meetingStartUTC.setZone(displayZone);
  const startTimeFormatted = startTimeLocal.minute === 0
    ? startTimeLocal.toFormat('ha').toLowerCase()
    : startTimeLocal.toFormat('h:mma').toLowerCase();

  const endTimeLocal = meetingEndUTC.setZone(displayZone);
  const endTimeFormatted = endTimeLocal.minute === 0
    ? endTimeLocal.toFormat('ha').toLowerCase()
    : endTimeLocal.toFormat('h:mma').toLowerCase();

  const meetingTimeFormatted = `${startTimeFormatted} – ${endTimeFormatted}`;

  const timezone = FORCE_EASTERN_DISPLAY
    ? EASTERN_DISPLAY_LABEL
    : booking.inviteeTimezone
      ? getTimezoneAbbreviation(booking.inviteeTimezone, booking.scheduledEventStartTime)
      : 'ET';

  return {
    meetingDateFormatted,
    meetingTimeWithTimezone: `${meetingTimeFormatted} ${timezone}`
  };
}

/**
 * Resolves a reschedule link from booking data or Calendly API.
 */
async function resolveRescheduleLink(booking) {
  if (booking.calendlyRescheduleLink) {
    return booking.calendlyRescheduleLink;
  }

  try {
    const fetched = await getRescheduleLinkForBooking(booking);
    if (fetched) return fetched;
  } catch (error) {
    console.warn('[TemplateParameterBuilder] Could not fetch reschedule link:', error.message);
  }

  return DEFAULT_SCHEDULING_LINK;
}

/**
 * Shared builder for the not-scheduled meta_* templates:
 * {{1}} = client name, {{2}} = booking link.
 */
async function metaSchedulingParams({ booking, step }) {
  const schedulingLink = step?.templateConfig?.schedulingLink || DEFAULT_SCHEDULING_LINK;

  return [
    booking.clientName || 'Valued Client',
    schedulingLink
  ];
}

/**
 * The *_demo variants of the meta templates: identical to the originals plus
 * {{3}} = the product demo video link.
 */
async function metaSchedulingParamsWithDemo(ctx) {
  const params = await metaSchedulingParams(ctx);
  return [...params, ctx?.step?.templateConfig?.demoLink || PRODUCT_DEMO_LINK];
}

/**
 * Template parameter builder registry.
 * Each builder takes { booking, step, executedAt } and returns an array of parameter values.
 */
const builders = {
  finalkk: ({ booking, step, executedAt }) => {
    const planName = booking.paymentPlan?.name || step?.templateConfig?.planName || 'PRIME';
    const days = booking.planDetails?.days || step?.templateConfig?.days || 7;

    const reminderDate = new Date(executedAt || Date.now());
    reminderDate.setDate(reminderDate.getDate() + days);
    const formattedDate = reminderDate.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });

    return [
      booking.clientName || 'Valued Client',
      planName,
      formattedDate
    ];
  },

  // plan_followup_123 and plan_follow_up_456: single variable {{1}} = client name.
  // 456 previously had no handler and only worked because the generic fallback happens
  // to emit exactly one parameter. Registered so it stops depending on that.
  plan_followup_123: ({ booking }) => {
    return [
      booking.clientName || 'Valued Client'
    ];
  },

  plan_follow_up_456: ({ booking }) => {
    return [
      booking.clientName || 'Valued Client'
    ];
  },

  plan_followup_utility_01dd: ({ booking, step }) => {
    const DEFAULT_PLAN_PRICE = 349;
    const rawPlanPrice = booking.paymentPlan?.price ?? step?.templateConfig?.planAmount;
    const planPrice = typeof rawPlanPrice === 'number' && rawPlanPrice > 0 ? rawPlanPrice : DEFAULT_PLAN_PRICE;

    let planAmount = booking.paymentPlan?.displayPrice;
    const normalized = typeof planAmount === 'string' ? planAmount.trim() : '';
    const lower = normalized.toLowerCase();
    const isValid = !!normalized && lower !== 'null' && lower !== 'undefined' && lower !== '$null' && lower !== '$undefined';

    return [
      booking.clientName || 'Valued Client',
      isValid ? normalized : `$${planPrice}`
    ];
  },

  // meta_* templates run in the not-scheduled workflow: the client has no active
  // upcoming meeting (status change to scheduled cancels these steps), so they must
  // always get a fresh BOOKING link. Never fall back to booking.calendlyRescheduleLink —
  // for a returning client (completed meeting, re-filled the form) that field still
  // holds the old event's reschedule link and would invite them to reschedule a
  // finished meeting instead of booking a new one.
  meta_1: metaSchedulingParams,
  meta_2: metaSchedulingParams,
  meta_31: metaSchedulingParams,
  meta_41: metaSchedulingParams,

  // Same copy plus "You can watch the Flashfire product demo video here: {{3}}".
  // Which of these a workflow step fires is chosen in the CRM, not here.
  meta_1_demo: metaSchedulingParamsWithDemo,
  meta_2_demo: metaSchedulingParamsWithDemo,
  meta_31_demo: metaSchedulingParamsWithDemo,
  // meta_2_demo came back from Meta as MARKETING, which marketing opt-outs drop.
  // meta_2_demo_u is the reworded UTILITY replacement and is what the workflow uses.
  meta_2_demo_u: metaSchedulingParamsWithDemo,
  meta_41_demo: metaSchedulingParamsWithDemo,

  // The *_revised_* pair: same two parameters as the rest of the family
  // ({{1}} name, {{2}} booking link), reworded copy, no demo link.
  // 134 is the immediate step, 123 the 8-hour one.
  meta__revised_134: metaSchedulingParams,
  meta_2_revised_123: metaSchedulingParams,
  // The 2-day follow-up, with Europe in the markets line. Same two variables.
  meta_31_revised_eu_v2: metaSchedulingParams,

  // Variants the CRM workflow currently points at. All take {{1}} name, {{2}} booking
  // link. Registered so they do not rely on the meta_* family fallback and its warning.
  meta__revised_134_eu: metaSchedulingParams,
  meta_31_revised_new123: metaSchedulingParams,
  meta_31_revised_new123_eu: metaSchedulingParams,
  meta_41_revised_123: metaSchedulingParams,

  cancelled1: async ({ booking }) => {
    if (!booking.scheduledEventStartTime) {
      throw new Error('Meeting date/time not available for cancelled1 template');
    }

    const { meetingDateFormatted, meetingTimeWithTimezone } = buildMeetingTimeParams(booking);

    // This template goes out after a missed or canceled meeting. The booking's own
    // Calendly reschedule link points at an event that is already in the past, so
    // Calendly refuses it ("this event is in the past"). Always send the open
    // scheduling page instead.
    return [
      booking.clientName || 'Valued Client',
      meetingDateFormatted,
      meetingTimeWithTimezone,
      DEFAULT_SCHEDULING_LINK
    ];
  },

  flashfire_appointment_reminder: async ({ booking }) => {
    if (!booking.scheduledEventStartTime) {
      throw new Error('Meeting date/time not available for flashfire_appointment_reminder template');
    }

    const { meetingDateFormatted, meetingTimeWithTimezone } = buildMeetingTimeParams(booking);
    const meetingLink = booking.calendlyMeetLink || booking.googleMeetUrl || booking.meetingVideoUrl || 'Not Provided';
    const rescheduleLink = await resolveRescheduleLink(booking);

    return [
      booking.clientName || 'Valued Client',
      meetingDateFormatted,
      meetingTimeWithTimezone,
      meetingLink,
      rescheduleLink
    ];
  },

  // Same body as flashfire_appointment_reminder plus one dynamic URL button var:
  // {{6}} = "Reschedule" button URL tail. Button base is https://calendly.com/, so we
  // send only the path after it. {{6}} uses the booking's real reschedule link so
  // reschedule/cancel tracking is preserved. ("I'll join" is a static quick-reply — no var.)
  flashfire_appointment_reminder_b: async ({ booking }) => {
    if (!booking.scheduledEventStartTime) {
      throw new Error('Meeting date/time not available for flashfire_appointment_reminder_b template');
    }

    const { meetingDateFormatted, meetingTimeWithTimezone } = buildMeetingTimeParams(booking);
    const meetingLink = booking.calendlyMeetLink || booking.googleMeetUrl || booking.meetingVideoUrl || 'Not Provided';
    const rescheduleLink = await resolveRescheduleLink(booking);

    return [
      booking.clientName || 'Valued Client',
      meetingDateFormatted,
      meetingTimeWithTimezone,
      meetingLink,
      rescheduleLink,
      calendlyButtonTail(rescheduleLink) // {{6}} → "Reschedule" button URL tail
    ];
  },

  // Same body as _b, plus a second dynamic URL button:
  // {{6}} = "Reschedule" tail, {{7}} = "Cancel" tail. Both sit on the fixed
  // https://calendly.com/ base, so only the path after it is sent. ("I'll Join" is a
  // static quick-reply — no variable.) Throws when no real cancel target exists, so a
  // caller cannot accidentally ship a Cancel button pointing at a booking page.
  flashfire_appointment_reminder_rc: async ({ booking }) => {
    if (!booking.scheduledEventStartTime) {
      throw new Error('Meeting date/time not available for flashfire_appointment_reminder_rc template');
    }

    const { meetingDateFormatted, meetingTimeWithTimezone } = buildMeetingTimeParams(booking);
    const meetingLink = booking.calendlyMeetLink || booking.googleMeetUrl || booking.meetingVideoUrl || 'Not Provided';
    const rescheduleLink = await resolveRescheduleLink(booking);
    const cancelTail = calendlyCancelTail(booking.calendlyCancelLink, rescheduleLink);

    if (!cancelTail) {
      throw new Error('No cancel link available for flashfire_appointment_reminder_rc template');
    }

    return [
      booking.clientName || 'Valued Client',
      meetingDateFormatted,
      meetingTimeWithTimezone,
      meetingLink,
      rescheduleLink,
      calendlyButtonTail(rescheduleLink), // {{6}} → "Reschedule" button URL tail
      cancelTail                          // {{7}} → "Cancel" button URL tail
    ];
  },

  // Adds the demo video line to the body as {{6}}, which pushes both button
  // variables along: {{7}} = "Reschedule" tail, {{8}} = "Cancel" tail.
  flashfire_appointment_reminder_demo: async ({ booking, step }) => {
    if (!booking.scheduledEventStartTime) {
      throw new Error('Meeting date/time not available for flashfire_appointment_reminder_demo template');
    }

    const { meetingDateFormatted, meetingTimeWithTimezone } = buildMeetingTimeParams(booking);
    const meetingLink = booking.calendlyMeetLink || booking.googleMeetUrl || booking.meetingVideoUrl || 'Not Provided';
    const rescheduleLink = await resolveRescheduleLink(booking);
    const cancelTail = calendlyCancelTail(booking.calendlyCancelLink, rescheduleLink);

    if (!cancelTail) {
      throw new Error('No cancel link available for flashfire_appointment_reminder_demo template');
    }

    return [
      booking.clientName || 'Valued Client',
      meetingDateFormatted,
      meetingTimeWithTimezone,
      meetingLink,
      rescheduleLink,
      step?.templateConfig?.demoLink || PRODUCT_DEMO_LINK, // {{6}} → demo video
      calendlyButtonTail(rescheduleLink),                  // {{7}} → "Reschedule" tail
      cancelTail                                           // {{8}} → "Cancel" tail
    ];
  }
};

// Every 8-parameter appointment template takes the identical arguments
// ({{6}} = demo link, {{7}} = Reschedule tail, {{8}} = Cancel tail); only the Meta
// template differs, so they all share one builder.
builders.flashfire_appointment_booked_demo = builders.flashfire_appointment_reminder_demo;
builders.new_meeting_booked_reminder = builders.flashfire_appointment_reminder_demo;
builders.new_meeting_booked_reminder_eu = builders.flashfire_appointment_reminder_demo;

/**
 * Build template parameters for a given template name and booking context.
 * This is the single source of truth for template parameter logic, shared by
 * WorkflowController (immediate sends) and cronScheduler (scheduled sends).
 *
 * @param {string} templateName - WATI template name
 * @param {Object} context - { booking, step, executedAt }
 * @returns {Promise<string[]>} Array of parameter values
 */
export async function buildTemplateParameters(templateName, { booking, step, executedAt }) {
  const builder = builders[templateName];

  if (builder) {
    const params = await builder({ booking, step, executedAt });
    console.log(`[TemplateParameterBuilder] ${templateName} parameters:`, params);
    return params;
  }

  // The meta_* family is the not-scheduled workflow: "you have not booked yet, here is
  // the link". They all take {{1}} = client name and {{2}} = booking link, and the
  // *_demo variants add {{3}} = demo video. New ones get added in the CRM without
  // anyone touching this file, so match by name rather than waiting for the generic
  // fallback to send too few parameters and have WATI reject the whole send with
  // "Check your template, it cannot have typos or blank text".
  if (/^meta/i.test(templateName)) {
    const wantsDemo = /_demo(_[a-z0-9]+)?$/i.test(templateName);
    const chosen = wantsDemo ? metaSchedulingParamsWithDemo : metaSchedulingParams;
    const params = await chosen({ booking, step, executedAt });
    console.warn(`[TemplateParameterBuilder] "${templateName}" has no explicit handler; matched the meta_* family (${params.length} params). Register it to be certain.`);
    return params;
  }

  // Generic fallback: at minimum provide client name. This sends ONE parameter, so any
  // template needing more will be rejected by WATI. Add a builder above instead of
  // relying on this.
  console.warn(`[TemplateParameterBuilder] No handler for "${templateName}" — falling back to client name only. If this template takes more than one variable the send WILL fail.`);
  const params = [booking.clientName || 'Valued Client'];

  if (step?.templateConfig?.schedulingLink) {
    params.push(step.templateConfig.schedulingLink);
  }

  return params;
}

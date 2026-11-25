import { createUserRateLimiter } from '../Middlewares/perUserRateLimit.js';
import { makeKeyCheck } from '../Utils/IntegrationKeyAuth.js';
import { buildSalesSheetLeads } from '../Utils/SalesSheetLeads.js';
import { didCompanySendAfter } from '../Utils/WhatsAppBridge.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

// Sales Tracker sheet feed. The sheet's Apps Script calls this once a day and adds the month's hot and warm leads it
// does not have yet.
//   GET /api/sales-sheet/leads?month=YYYY-MM    header X-Sheet-Secret (32+ characters, enrolled on first use)
// WhatsApp status for Col 12 (Greetings Message) and Col 13 (Follow-up Alert):
//   GET /api/sales-sheet/whatsapp-status?phone=447508762523&bookingId=booking_xxx   header X-Sheet-Secret
// Errors use the shared shape { success: false, error: { code, message } }.

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const keyOk = makeKeyCheck({ name: 'sales_sheet_sync', envVar: 'SALES_SHEET_SECRET' });
const limiter = createUserRateLimiter({ max: 60, windowMs: 60 * 1000, keyOf: () => 'sales-sheet-sync' });
const statusLimiter = createUserRateLimiter({ max: 120, windowMs: 60 * 1000, keyOf: () => 'sales-sheet-wa-status' });

export function registerSalesSheetRoutes(app, deps = {}) {
  app.get('/api/sales-sheet/leads', limiter, async (req, res) => {
    try {
      if (!(await (deps.keyOk ?? keyOk)(req.get('x-sheet-secret')))) return fail(res, 401, 'bad_secret', 'Missing or wrong X-Sheet-Secret');
      const data = await (deps.build ?? buildSalesSheetLeads)(req.query.month);
      if (!data) return fail(res, 422, 'invalid_month', 'month must look like 2026-11');
      return res.status(200).json({ success: true, ...data });
    } catch (err) {
      console.error('[salesSheet] feed failed:', err?.message);
      return fail(res, 500, 'sheet_feed_failed', 'Could not build the lead list');
    }
  });

  /**
   * GET /api/sales-sheet/whatsapp-status?phone=447508762523&bookingId=booking_xxx
   * Header: X-Sheet-Secret
   *
   * Returns:
   *   greetingStatus: 'Done' | 'Pending'            — did BDA send WhatsApp after meeting completed?
   *   followUpStatus: 'Upcoming' | 'Pending' | 'Due Today' | 'Overdue' | 'Done' | 'Closed - Paid' | 'Set Follow-up Date'
   */
  app.get('/api/sales-sheet/whatsapp-status', statusLimiter, async (req, res) => {
    try {
      if (!(await (deps.keyOk ?? keyOk)(req.get('x-sheet-secret')))) return fail(res, 401, 'bad_secret', 'Missing or wrong X-Sheet-Secret');

      const { phone, bookingId } = req.query;
      if (!phone && !bookingId) return fail(res, 422, 'missing_params', 'phone or bookingId required');

      // Fetch booking from DB
      const query = bookingId ? { bookingId } : { clientPhone: { $regex: phone.replace(/\D/g, '') } };
      const booking = await CampaignBookingModel.findOne(query)
        .select('bookingStatus statusChangedAt clientPhone followUp scheduledWorkflows paymentPlan')
        .lean();

      if (!booking) return fail(res, 404, 'not_found', 'Booking not found');

      const phone_ = booking.clientPhone;
      const status = booking.bookingStatus;
      const statusChangedAt = booking.statusChangedAt;
      const now = new Date();
      const todayIST = new Date(now.getTime() + 5.5 * 3600 * 1000);
      todayIST.setUTCHours(0, 0, 0, 0);
      const tomorrowIST = new Date(todayIST.getTime() + 24 * 3600 * 1000);

      // ── Greeting status (Col 12) ──────────────────────────────────────────
      let greetingStatus = '';
      if (status === 'completed' && statusChangedAt) {
        const { sent, error } = await (deps.didCompanySendAfter ?? didCompanySendAfter)(phone_, statusChangedAt);
        if (!error) greetingStatus = sent ? 'Done' : 'Pending';
      }

      // ── Follow-up status (Col 13) ─────────────────────────────────────────
      let followUpStatus = '';

      if (status === 'paid') {
        followUpStatus = 'Closed - Paid';
      } else if (status !== 'completed') {
        // Not yet completed — date-based only
        const followUpAt = booking.followUp?.at ? new Date(booking.followUp.at) : null;
        if (!followUpAt) {
          followUpStatus = 'Upcoming';
        } else if (followUpAt >= tomorrowIST) {
          followUpStatus = 'Upcoming';
        } else if (followUpAt >= todayIST) {
          followUpStatus = 'Due Today';
        } else {
          followUpStatus = 'Overdue';
        }
      } else {
        // Meeting completed — use followUp.at if set, else fall back to earliest scheduled WhatsApp workflow date
        const followUpAt = booking.followUp?.at
          ? new Date(booking.followUp.at)
          : (() => {
              const waScheduled = (booking.scheduledWorkflows ?? [])
                .filter(w => w.step?.channel === 'whatsapp' && w.status === 'scheduled' && w.scheduledFor)
                .map(w => new Date(w.scheduledFor))
                .sort((a, b) => a - b);
              return waScheduled[0] ?? null;
            })();

        if (!followUpAt) {
          followUpStatus = 'Upcoming';
        } else if (followUpAt >= tomorrowIST) {
          followUpStatus = 'Upcoming';
        } else if (followUpAt >= todayIST) {
          followUpStatus = 'Due Today';
        } else {
          // Follow-up date has passed — check if BDA sent WhatsApp after followUpAt
          const { sent, error } = await (deps.didCompanySendAfter ?? didCompanySendAfter)(phone_, followUpAt);
          if (!error && sent) {
            followUpStatus = 'Done';
          } else {
            followUpStatus = 'Overdue';
          }
        }
      }

      return res.status(200).json({ success: true, greetingStatus, followUpStatus });
    } catch (err) {
      console.error('[salesSheet] whatsapp-status failed:', err?.message);
      return fail(res, 500, 'status_check_failed', 'Could not check WhatsApp status');
    }
  });
}

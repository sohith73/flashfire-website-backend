import { createUserRateLimiter } from '../Middlewares/perUserRateLimit.js';
import { makeKeyCheck } from '../Utils/IntegrationKeyAuth.js';
import { buildSalesSheetLeads } from '../Utils/SalesSheetLeads.js';

// Sales Tracker sheet feed. The sheet's Apps Script calls this once a day and adds the month's hot and warm leads it
// does not have yet.
//   GET /api/sales-sheet/leads?month=YYYY-MM    header X-Sheet-Secret (32+ characters, enrolled on first use)
// Errors use the shared shape { success: false, error: { code, message } }.

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const keyOk = makeKeyCheck({ name: 'sales_sheet_sync', envVar: 'SALES_SHEET_SECRET' });
const limiter = createUserRateLimiter({ max: 60, windowMs: 60 * 1000, keyOf: () => 'sales-sheet-sync' });

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
}

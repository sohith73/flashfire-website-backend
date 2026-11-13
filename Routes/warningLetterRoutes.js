import { BdaWarningLetterModel, WARNING_STATUSES } from '../Schema_Models/BdaWarningLetter.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import { WARNING_LEVELS, dismissLetter, evaluateWarningLetters, getWarningMode, sendLetter, warningStandings, warningWindow } from '../Utils/WarningLetters.js';
import { actorOf, requireCrmUserOrAdmin } from './deductionRoutes.js';

// Warning letters API. A BDA reads their own SENT letters; an admin sees every letter, the live standings, and can
// send, dismiss or re-run the check. Same error shape as the other CRM APIs: { success:false, error:{ code, message } }.

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const norm = (e) => String(e ?? '').trim().toLowerCase();
const iso = (d) => (d ? new Date(d).toISOString() : null);
const LIST_CAP = 200;

async function requestIsAdmin(req) {
  if (req.crmAdmin) return true;
  return isCrmAdmin(req.crmUser);
}

export function toLetterRow(l) {
  return {
    letterId: l.letterId,
    bdaEmail: l.bdaEmail,
    bdaName: l.bdaName ?? l.bdaEmail.split('@')[0],
    level: l.level,
    title: WARNING_LEVELS.find((x) => x.level === l.level)?.title ?? `Warning ${l.level}`,
    threshold: l.threshold,
    missedCount: l.missedCount,
    windowFrom: iso(l.windowFrom),
    windowTo: iso(l.windowTo),
    totalAmountInr: l.totalAmountInr ?? 0,
    missed: (l.missed || []).map((m) => ({ bookingId: m.bookingId ?? null, clientName: m.clientName ?? '', scheduledStart: iso(m.scheduledStart), amountInr: m.amountInr ?? 0 })),
    status: l.status,
    subject: l.subject,
    bodyText: l.bodyText,
    toEmail: l.toEmail ?? null,
    ccEmails: l.ccEmails ?? [],
    sentAt: iso(l.sentAt),
    sentBy: l.sentBy ?? null,
    error: l.error ?? null,
    dismissedAt: iso(l.dismissedAt),
    dismissedBy: l.dismissedBy ?? null,
    dismissNote: l.dismissNote ?? null,
    createdAt: iso(l.createdAt),
  };
}

export function registerWarningLetterRoutes(app) {
  const BASE = '/api/crm/warning-letters';

  app.get(BASE, requireCrmUserOrAdmin, async (req, res) => {
    try {
      const admin = await requestIsAdmin(req);
      const filter = {};
      if (admin) {
        const status = String(req.query.status ?? '');
        if (status) {
          if (!WARNING_STATUSES.includes(status)) return fail(res, 422, 'invalid_status', `status must be one of ${WARNING_STATUSES.join(', ')}`);
          filter.status = status;
        }
        const wanted = norm(req.query.bdaEmail);
        if (wanted) filter.bdaEmail = wanted;
      } else {
        const own = norm(req.crmUser?.email);
        if (!own) return fail(res, 401, 'unauthorized', 'Token has no email');
        if (req.query.bdaEmail && norm(req.query.bdaEmail) !== own) return fail(res, 403, 'forbidden', 'You can only see your own letters');
        filter.bdaEmail = own;
        filter.status = 'sent'; // a draft is the admins' working copy, a BDA sees a letter once it has been sent
      }
      const rows = await BdaWarningLetterModel.find(filter).sort({ createdAt: -1 }).limit(LIST_CAP).lean();
      const body = {
        success: true,
        mode: getWarningMode(),
        window: (() => { const w = warningWindow(); return w ? { from: w.from.toISOString(), to: w.to.toISOString(), label: w.label } : null; })(),
        policy: WARNING_LEVELS.map(({ level, threshold, title }) => ({ level, threshold, title })),
        letters: rows.map(toLetterRow),
      };
      if (admin) {
        body.standings = await warningStandings();
        body.draftCount = await BdaWarningLetterModel.countDocuments({ status: { $in: ['draft', 'failed'] } });
      } else {
        const standing = (await warningStandings()).find((s) => s.bdaEmail === filter.bdaEmail);
        body.standings = standing ? [standing] : [];
      }
      return res.status(200).json(body);
    } catch (err) {
      console.error('[warningLetterRoutes] list failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load warning letters');
    }
  });

  app.post(`${BASE}/evaluate`, requireCrmUserOrAdmin, async (req, res) => {
    try {
      if (!(await requestIsAdmin(req))) return fail(res, 403, 'forbidden', 'Admin access required');
      if (getWarningMode() === 'off') return fail(res, 409, 'warnings_off', 'Warning letters are switched off (WARNING_LETTERS_MODE=off)');
      const result = await evaluateWarningLetters(new Date());
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      console.error('[warningLetterRoutes] evaluate failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not check for warning letters');
    }
  });

  app.post(`${BASE}/:id/send`, requireCrmUserOrAdmin, async (req, res) => {
    try {
      if (!(await requestIsAdmin(req))) return fail(res, 403, 'forbidden', 'Admin access required');
      const result = await sendLetter(String(req.params.id), actorOf(req).email || 'admin');
      if (!result.ok) return fail(res, result.status, result.code, result.message);
      return res.status(200).json({ success: true, letter: toLetterRow(result.letter) });
    } catch (err) {
      console.error('[warningLetterRoutes] send failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not send the letter');
    }
  });

  app.post(`${BASE}/:id/dismiss`, requireCrmUserOrAdmin, async (req, res) => {
    try {
      if (!(await requestIsAdmin(req))) return fail(res, 403, 'forbidden', 'Admin access required');
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
      const result = await dismissLetter(String(req.params.id), actorOf(req).email || 'admin', note || null);
      if (!result.ok) return fail(res, result.status, result.code, result.message);
      return res.status(200).json({ success: true, letter: toLetterRow(result.letter) });
    } catch (err) {
      console.error('[warningLetterRoutes] dismiss failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not dismiss the letter');
    }
  });
}

import { BdaWarningLetterModel } from '../Schema_Models/BdaWarningLetter.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { getTrackedBdas } from './BdaRegistry.js';
import { postAdminChannel } from './attendanceDiscord.js';

// Warning letters for missed meetings. Policy, by the number of active missed-meeting fines in the last 30 days:
//   0 to 6  no letter    7  1st warning    10  2nd warning    15  3rd warning
// A letter for a level is written once per 30 days per BDA. A BDA who jumps straight past a level (for example from 3
// misses to 12) gets only the highest level reached, not one letter per level. Fines that are waived, voided or under
// review do not count, so a waiver lowers the count the same way it lowers the fine.
//
// WARNING_LETTERS_MODE: off writes nothing, draft (the default) writes a draft an admin reads and sends, live also
// sends it the moment it is written.

export const WARNING_WINDOW_DAYS = 30;
export const WARNING_LEVELS = Object.freeze([
  { level: 1, threshold: 7, title: 'First warning' },
  { level: 2, threshold: 10, title: 'Second warning' },
  { level: 3, threshold: 15, title: 'Third warning' },
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const IST = 'Asia/Kolkata';

export function getWarningMode() {
  const raw = String(process.env.WARNING_LETTERS_MODE ?? 'draft').trim().toLowerCase();
  return ['off', 'draft', 'live'].includes(raw) ? raw : 'draft';
}

/** The highest policy level a count reaches (0 when it reaches none). */
export function levelForCount(count) {
  let reached = 0;
  for (const l of WARNING_LEVELS) if (count >= l.threshold) reached = l.level;
  return reached;
}

/** The next threshold above the count, or null once the third letter's threshold is passed. */
export function nextThreshold(count) {
  return WARNING_LEVELS.find((l) => count < l.threshold)?.threshold ?? null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const when = (d) =>
  new Date(d).toLocaleString('en-IN', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const day = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' });

/** Subject, plain text and HTML for a letter. Pure. `missed` is [{ clientName, scheduledStart, amountInr }], oldest first. */
export function composeLetter({ level, bdaName, missedCount, windowFrom, windowTo, missed, totalAmountInr }) {
  const spec = WARNING_LEVELS.find((l) => l.level === level);
  if (!spec) throw new Error(`Unknown warning level ${level}`);
  const first = String(bdaName || 'there').split(' ')[0];
  const subject = `${spec.title}: ${missedCount} missed meetings in the last ${WARNING_WINDOW_DAYS} days`;
  const intro = `This is your ${spec.title.toLowerCase()} letter. In the ${WARNING_WINDOW_DAYS} days from ${day(windowFrom)} to ${day(windowTo)}, the system recorded ${missedCount} meetings that you did not attend. Each one carries a deduction, and together they come to ${inr(totalAmountInr)}.`;
  const policy = `Our policy is a first warning at ${WARNING_LEVELS[0].threshold} missed meetings, a second at ${WARNING_LEVELS[1].threshold} and a third at ${WARNING_LEVELS[2].threshold}, counted over a rolling ${WARNING_WINDOW_DAYS} days.`;
  const ask = 'Please make sure you join every meeting assigned to you, on time. If you cannot take a meeting, tell an admin before it starts so it can be moved to a colleague.';
  const dispute = 'If you believe any meeting in the list above is wrong, reply to this email or contact an admin with the date and client. A meeting that is waived no longer counts.';
  const shown = missed.slice(0, 40);
  const more = missed.length > shown.length ? `and ${missed.length - shown.length} more` : '';
  const lines = shown.map((m, i) => `${i + 1}. ${when(m.scheduledStart)} IST, ${m.clientName || 'client'} (${inr(m.amountInr)})`);
  const text = [`Hi ${first},`, '', intro, '', policy, '', 'The meetings:', ...lines, ...(more ? [more] : []), '', ask, dispute, '', 'FlashFire team'].join('\n');
  const rows = shown
    .map((m, i) => `<tr><td style="padding:6px 10px;border-top:1px solid #e5e7eb;color:#6b7280;">${i + 1}</td><td style="padding:6px 10px;border-top:1px solid #e5e7eb;">${esc(when(m.scheduledStart))} IST</td><td style="padding:6px 10px;border-top:1px solid #e5e7eb;">${esc(m.clientName || 'client')}</td><td style="padding:6px 10px;border-top:1px solid #e5e7eb;text-align:right;">${esc(inr(m.amountInr))}</td></tr>`)
    .join('');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#111827;">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">FlashFire</div>
  <h1 style="font-size:22px;margin:6px 0 14px;color:#b91c1c;">${esc(spec.title)}</h1>
  <p style="font-size:15px;">Hi ${esc(first)},</p>
  <p style="font-size:15px;">${esc(intro)}</p>
  <p style="font-size:14px;color:#374151;">${esc(policy)}</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin:14px 0;border:1px solid #e5e7eb;border-radius:8px;"><tbody>${rows}</tbody></table>
  ${more ? `<p style="font-size:13px;color:#6b7280;">${esc(more)}</p>` : ''}
  <p style="font-size:15px;">${esc(ask)}</p>
  <p style="font-size:14px;color:#374151;">${esc(dispute)}</p>
  <p style="font-size:14px;margin-top:22px;">FlashFire team</p>
</div>`;
  return { subject, bodyText: text, bodyHtml: html };
}

/** The active missed-meeting fines in the window, oldest first. */
async function windowFines(bdaEmail, from, to, deps) {
  const Deduction = deps.Deduction ?? BdaDeductionModel;
  return Deduction.find({ bdaEmail, rule: 'missed_meeting', status: 'active', 'evidence.scheduledStart': { $gte: from, $lte: to } })
    .select('bookingId amountInr evidence.scheduledStart evidence.clientName')
    .sort({ 'evidence.scheduledStart': 1 })
    .lean();
}

/** Where a letter goes: the BDA, with every active CRM admin copied. */
export async function letterRecipients(bdaEmail, deps = {}) {
  const Users = deps.CrmUser ?? CrmUserModel;
  const admins = await Users.find({ isActive: { $ne: false }, $or: [{ role: 'admin' }, { isAdmin: true }] }).select('email').lean();
  const cc = [...new Set(admins.map((a) => String(a.email || '').trim().toLowerCase()).filter((e) => e && e !== bdaEmail))];
  return { to: bdaEmail, cc };
}

/** Each tracked BDA's standing right now: the count, the level it reaches, the next threshold. */
export async function warningStandings(now = new Date(), deps = {}) {
  const bdas = await (deps.getTrackedBdas ?? getTrackedBdas)();
  const from = new Date(now.getTime() - WARNING_WINDOW_DAYS * DAY_MS);
  const out = [];
  for (const p of bdas) {
    if (p.active === false) continue;
    const rows = await windowFines(p.email, from, now, deps);
    out.push({
      bdaEmail: p.email,
      bdaName: p.displayName || p.email.split('@')[0],
      missedCount: rows.length,
      level: levelForCount(rows.length),
      nextThreshold: nextThreshold(rows.length),
    });
  }
  return out.sort((a, b) => b.missedCount - a.missedCount);
}

/**
 * Write the letters that are due. For each tracked BDA: count the window, find the level reached, and write a draft
 * unless a non-dismissed letter at that level or higher was already written in the last 30 days. In live mode each new
 * letter is sent straight away. Returns { mode, created: [letterId], sent: [letterId], failed: [letterId] }.
 */
export async function evaluateWarningLetters(now = new Date(), deps = {}) {
  const mode = deps.mode ?? getWarningMode();
  const result = { mode, created: [], sent: [], failed: [] };
  if (mode === 'off') return result;
  const Letter = deps.Letter ?? BdaWarningLetterModel;
  const from = new Date(now.getTime() - WARNING_WINDOW_DAYS * DAY_MS);
  const bdas = await (deps.getTrackedBdas ?? getTrackedBdas)();
  for (const p of bdas) {
    if (p.active === false) continue;
    const rows = await windowFines(p.email, from, now, deps);
    const level = levelForCount(rows.length);
    if (level === 0) continue;
    const recent = await Letter.findOne({ bdaEmail: p.email, level: { $gte: level }, status: { $ne: 'dismissed' }, createdAt: { $gte: from } }).select('_id').lean();
    if (recent) continue;
    const missed = rows.map((r) => ({ bookingId: r.bookingId, clientName: r.evidence?.clientName ?? null, scheduledStart: r.evidence?.scheduledStart ?? null, amountInr: r.amountInr }));
    const totalAmountInr = missed.reduce((s, m) => s + (m.amountInr || 0), 0);
    const bdaName = p.displayName || p.email.split('@')[0];
    const spec = WARNING_LEVELS.find((l) => l.level === level);
    const { subject, bodyText, bodyHtml } = composeLetter({ level, bdaName, missedCount: rows.length, windowFrom: from, windowTo: now, missed, totalAmountInr });
    const { to, cc } = await letterRecipients(p.email, deps);
    const letter = await Letter.create({
      bdaEmail: p.email, bdaName, level, threshold: spec.threshold, missedCount: rows.length, windowFrom: from, windowTo: now,
      missed, totalAmountInr, status: 'draft', subject, bodyText, bodyHtml, toEmail: to, ccEmails: cc,
    });
    result.created.push(letter.letterId);
    if (deps.announce) await deps.announce(letter, 'created');
    if (mode === 'live') {
      const sent = await sendLetter(letter.letterId, 'system', deps);
      (sent.ok ? result.sent : result.failed).push(letter.letterId);
    }
  }
  return result;
}

/** Send a draft (or retry a failed one). Returns { ok: true, letter } or { ok: false, status, code, message }. */
export async function sendLetter(letterId, sentBy, deps = {}) {
  const Letter = deps.Letter ?? BdaWarningLetterModel;
  const mail = deps.sendMail ?? (await import('./SendGridHelper.js')).sendWarningLetterEmail;
  const claimed = await Letter.findOneAndUpdate({ letterId, status: { $in: ['draft', 'failed'] } }, { $set: { error: null } }, { new: true }).lean();
  if (!claimed) {
    const exists = await Letter.findOne({ letterId }).select('status').lean();
    if (!exists) return { ok: false, status: 404, code: 'not_found', message: 'No such letter' };
    return { ok: false, status: 409, code: 'already_resolved', message: `This letter is already ${exists.status}` };
  }
  try {
    await mail({ to: claimed.toEmail || claimed.bdaEmail, cc: claimed.ccEmails || [], subject: claimed.subject, text: claimed.bodyText, html: claimed.bodyHtml });
  } catch (err) {
    const message = String(err?.response?.body?.errors?.[0]?.message || err?.message || 'Send failed').slice(0, 300);
    const failed = await Letter.findOneAndUpdate({ letterId }, { $set: { status: 'failed', error: message } }, { new: true }).lean();
    if (deps.announce) await deps.announce(failed, 'failed');
    return { ok: false, status: 502, code: 'send_failed', message };
  }
  const letter = await Letter.findOneAndUpdate({ letterId }, { $set: { status: 'sent', sentAt: new Date(), sentBy: sentBy || 'system', error: null } }, { new: true }).lean();
  if (deps.announce) await deps.announce(letter, 'sent');
  return { ok: true, letter };
}

/** Dismiss a draft or failed letter with an optional note. The row stays. */
export async function dismissLetter(letterId, actorEmail, note, deps = {}) {
  const Letter = deps.Letter ?? BdaWarningLetterModel;
  const letter = await Letter.findOneAndUpdate(
    { letterId, status: { $in: ['draft', 'failed'] } },
    { $set: { status: 'dismissed', dismissedAt: new Date(), dismissedBy: actorEmail || 'admin', dismissNote: note || null } },
    { new: true }
  ).lean();
  if (letter) return { ok: true, letter };
  const exists = await Letter.findOne({ letterId }).select('status').lean();
  if (!exists) return { ok: false, status: 404, code: 'not_found', message: 'No such letter' };
  return { ok: false, status: 409, code: 'already_resolved', message: `This letter is already ${exists.status}` };
}

const LABEL = { created: 'drafted', sent: 'sent', failed: 'failed to send' };
export async function announceWarningLetter(letter, event) {
  try {
    const who = letter.bdaName || letter.bdaEmail;
    const tail = event === 'failed' ? ` (${letter.error})` : '';
    await postAdminChannel(`⚠️ **Warning letter ${LABEL[event] ?? event}**\n${who}: ${letter.subject}${tail}\nOpen Deductions > Warning letters in the CRM.`);
  } catch (err) {
    console.error('[WarningLetters] admin post failed:', err?.message);
  }
}

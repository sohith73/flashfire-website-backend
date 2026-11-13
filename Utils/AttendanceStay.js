import { countedSignals } from './recordPresentSignal.js';

// Minimum stay (ops rule, Nov 2026): a BDA counts as present only if they were in the call for at least
// MIN_STAY_MS AFTER the scheduled start. Joining early, clicking Mark Present and leaving before the meeting
// begins (or a minute after) is not attending it.
//
// Every place that decides "was the BDA there" goes through presenceVerdict(), so the verdict job, the late
// correction, the fine writer and the colleague-cover check can never disagree.
//
// Time in the call comes from, in order of trust:
//   1. Google Meet participant sessions (row.sessions, stable-ID match): exact join and leave times.
//   2. The extension's live session: an open segment (joinedAt set, leftAt null) is in the call until now.
//   3. The extension's last leave (leftAt, segment closed): an UPPER bound. Whatever happened before, the BDA
//      cannot have been in the call after leftAt, so time after start is at most leftAt - start (and at most the
//      cumulative time it measured). Enough to prove "left too early", never used to invent presence.
// With none of these (a button click and nothing else) the stay is unknown, and unknown never fines: the present
// verdict stands and the integrity check flags it for an admin, as before.

export const MIN_STAY_MS = 2 * 60 * 1000;

const toMs = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());
const finite = (n) => Number.isFinite(n);

/** Total length of the union of [from, to] intervals, each clipped to [lo, hi]. */
function unionMs(intervals, lo, hi) {
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([a, b]) => finite(a) && finite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of clipped) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else if (b > cur[1]) {
      cur[1] = b;
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/**
 * How long the BDA was in the call after the scheduled start, as far as the record shows.
 * Returns { ms, known, source, leftAt }:
 *   known false  -> no timeline at all (ms null)
 *   source       -> 'google_meet' | 'extension_live' | 'extension_last_leave'
 */
export function stayAfterStart(row, startMs, nowMs) {
  if (!row || !finite(startMs) || !finite(nowMs)) return { ms: null, known: false, source: null, leftAt: null };

  // The extension's open segment: in the call right now. A rejoin Google has not synced yet shows up here first,
  // so it is weighed alongside Google's sessions rather than below them.
  let live = null;
  if (row.joinedAt && !row.leftAt) {
    const joined = toMs(row.joinedAt);
    if (finite(joined)) live = { ms: Math.max(0, nowMs - Math.max(joined, startMs)), known: true, source: 'extension_live', leftAt: null };
  }

  const sessions = (Array.isArray(row.sessions) ? row.sessions : []).filter((s) => s?.startTime);
  if (sessions.length) {
    const intervals = sessions.map((s) => [toMs(s.startTime), s.endTime ? toMs(s.endTime) : nowMs]);
    const ms = unionMs(intervals, startMs, nowMs);
    const ended = sessions.every((s) => s.endTime);
    const lastEnd = ended ? Math.max(...sessions.map((s) => toMs(s.endTime))) : null;
    const google = { ms, known: true, source: 'google_meet', leftAt: lastEnd != null ? new Date(lastEnd) : null };
    return live && live.ms > google.ms ? live : google;
  }

  if (live) return live;

  if (row.leftAt && !row.joinedAt) {
    const left = toMs(row.leftAt);
    if (finite(left)) {
      let ms = Math.max(0, Math.min(left, nowMs) - startMs);
      const cum = Number(row.cumulativeDurationMs);
      if (finite(cum) && cum > 0) ms = Math.min(ms, cum);
      return { ms, known: true, source: 'extension_last_leave', leftAt: new Date(left) };
    }
  }

  return { ms: null, known: false, source: null, leftAt: null };
}

/** True when the record PROVES the BDA left before staying MIN_STAY_MS after the start. */
export function leftTooEarly(stay) {
  return Boolean(stay?.known) && stay.ms < MIN_STAY_MS;
}

/**
 * The one presence decision.
 * Returns { present, reason, counted, stay }, reason one of:
 *   'present'     - an in-time signal, and no proof of leaving early
 *   'no_signal'   - nothing showed the BDA in the call in time
 *   'left_early'  - in time, but out of the call before staying MIN_STAY_MS after the start
 */
export function presenceVerdict(row, startMs, nowMs) {
  const counted = countedSignals(row?.signals, startMs, row);
  const stay = stayAfterStart(row, startMs, nowMs);
  if (counted.length === 0) return { present: false, reason: 'no_signal', counted, stay };
  if (leftTooEarly(stay)) return { present: false, reason: 'left_early', counted, stay };
  return { present: true, reason: 'present', counted, stay };
}

/** "1 min 20 s" style, for messages. */
export function formatStay(ms) {
  if (!finite(ms) || ms < 0) return 'unknown';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} s`;
  return s ? `${m} min ${s} s` : `${m} min`;
}

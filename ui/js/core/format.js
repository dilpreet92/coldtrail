// Pure formatting helpers (no DOM): escaping, numbers, dates, plurals. Copy rules, spec §5.10:
// thousands separators; dates "Oct 9" / "Oct 9, 13:00"; relative within 48h, both ways. Plus the
// shared run-status wording.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DASH = '—';
const MIN = 60_000;
const HOUR = 60 * MIN;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for HTML, including both quote kinds (safe inside attributes). */
export function esc(s) {
  return s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** "6,131"; null / undefined / NaN → "—". */
export function fmtNum(n) {
  if (n == null || n === '') return DASH;
  const v = Number(n);
  return Number.isFinite(v) ? NUM.format(v) : DASH;
}

// SQLite's datetime('now') ("2026-10-09 13:00:00": space separator, no zone) is UTC.
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date | number | string → Date, or null when missing/invalid. Zone-less ISO ("…T08:00",
 *  e.g. the summary's next_at) is local time, as JS parses it; a bare "YYYY-MM-DD" is that
 *  local calendar day. */
export function toDate(v) {
  if (v == null || v === '') return null;
  let d;
  if (v instanceof Date) d = new Date(v.getTime());
  else if (typeof v === 'number') d = new Date(v);
  else {
    const s = String(v).trim();
    const day = s.match(DATE_ONLY);
    if (day) d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    else d = new Date(SQLITE_UTC.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, '0');

/** "Oct 9" / "Oct 9, 13:00" in local time; the year is added outside the current one
 *  ("Oct 9, 2025", "Oct 9, 2025, 13:00"). Missing/invalid → "—". */
export function fmtDate(iso, { time = false, now = new Date() } = {}) {
  const d = toDate(iso);
  if (!d) return DASH;
  let out = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (d.getFullYear() !== now.getFullYear()) out += `, ${d.getFullYear()}`;
  if (time) out += `, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return out;
}

/** "just now" (<60s), "5m ago" / "in 5m", "2h ago" / "in 3h" within 48h, else a dated
 *  fmtDate(iso, { time: true }). */
export function fmtRelative(iso, now = new Date()) {
  const d = toDate(iso);
  if (!d) return DASH;
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  if (abs < MIN) return 'just now';
  let span;
  if (abs < HOUR) span = `${Math.floor(abs / MIN)}m`;
  else if (abs < 48 * HOUR) span = `${Math.floor(abs / HOUR)}h`;
  else return fmtDate(d, { time: true, now });
  return diff < 0 ? `${span} ago` : `in ${span}`;
}

/** "1 draft", "1,200 companies". */
export function pluralize(n, one, many = `${one}s`) {
  return `${fmtNum(n)} ${Number(n) === 1 ? one : many}`;
}

/** Shorten to at most n characters, ending in "…" when cut. */
export function truncate(s, n) {
  const str = s == null ? '' : String(s);
  return str.length > n ? `${str.slice(0, Math.max(0, n - 1))}…` : str;
}

/** The URL when it is an absolute http(s) link, else "" — for hrefs built from stored data. */
export function safeUrl(u) {
  const s = u == null ? '' : String(u).trim();
  return /^https?:\/\/[^\s/]/i.test(s) ? s : '';
}

/**
 * How every screen names a run's status (scheduled_runs.status, summary.last_run.status): status →
 * [label, badge tone]. Read it through runStatus(), which also covers anything else.
 */
export const RUN_STATUS = Object.freeze(
  Object.assign(Object.create(null), {
    ok: Object.freeze(['Succeeded', 'ok']),
    error: Object.freeze(['Failed', 'danger']),
    auth_failed: Object.freeze(['Sign-in failed', 'warn']),
    running: Object.freeze(['Running', 'accent']),
  }),
);

/** [label, tone] for a run status; one it doesn't know shows as it is, in a neutral tone. */
export function runStatus(status) {
  const s = status == null ? '' : String(status);
  if (Object.prototype.hasOwnProperty.call(RUN_STATUS, s)) return RUN_STATUS[s];
  return [s || 'Unknown', 'neutral'];
}

// Pure formatting helpers (ui/js/core/format.js): escaping, numbers, dates, plurals.
// Dates are checked against values built from local-time parts (or each other), so the
// suite passes in any time zone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, fmtNum, fmtDate, fmtRelative, pluralize, truncate, safeUrl, RUN_STATUS, runStatus } from '../../ui/js/core/format.js';

const iso = (...parts) => new Date(...parts).toISOString();

test('esc escapes markup and both quote kinds', () => {
  assert.equal(esc('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(esc(`"a" & 'b'`), '&quot;a&quot; &amp; &#39;b&#39;');
  assert.equal(esc('<img src=x onerror=window.__xss=1>'), '&lt;img src=x onerror=window.__xss=1&gt;');
  assert.equal(esc('&amp;'), '&amp;amp;', 'already-escaped text is escaped again, not trusted');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});

test('fmtNum uses thousands separators and a dash for missing values', () => {
  assert.equal(fmtNum(6131), '6,131');
  assert.equal(fmtNum(1234567), '1,234,567');
  assert.equal(fmtNum(0), '0');
  assert.equal(fmtNum(-1200), '-1,200');
  assert.equal(fmtNum(null), '—');
  assert.equal(fmtNum(undefined), '—');
  assert.equal(fmtNum(NaN), '—');
  assert.equal(fmtNum('42'), '42');
});

test('fmtDate: "Oct 9", "Oct 9, 13:00", year only outside the current year', () => {
  const now = new Date(2026, 9, 27, 12, 0);
  assert.equal(fmtDate(iso(2026, 9, 9, 13, 0), { now }), 'Oct 9');
  assert.equal(fmtDate(iso(2026, 9, 9, 13, 0), { time: true, now }), 'Oct 9, 13:00');
  assert.equal(fmtDate(iso(2026, 0, 3, 7, 5), { time: true, now }), 'Jan 3, 07:05');
  assert.equal(fmtDate(iso(2025, 9, 9, 13, 0), { now }), 'Oct 9, 2025');
  assert.equal(fmtDate(iso(2025, 9, 9, 13, 0), { time: true, now }), 'Oct 9, 2025, 13:00');
  assert.equal(fmtDate(new Date(2026, 9, 9), { now }), 'Oct 9', 'accepts a Date');
  assert.equal(fmtDate(null), '—');
  assert.equal(fmtDate(''), '—');
  assert.equal(fmtDate('not a date'), '—');
});

test('fmtDate reads SQLite datetime() strings as UTC and zone-less ISO as local', () => {
  // datetime('now') in the DB has a space separator and no zone, and is UTC.
  assert.equal(
    fmtDate('2026-10-09 13:00:00', { time: true }),
    fmtDate('2026-10-09T13:00:00Z', { time: true }),
  );
  // The summary's next_at ("YYYY-MM-DDTHH:MM") is already local time.
  const now = new Date(2026, 9, 27, 12, 0);
  assert.equal(fmtDate('2026-10-29T08:00', { time: true, now }), 'Oct 29, 08:00');
  // A bare date is that calendar day wherever the browser is (JS alone would read it as UTC).
  assert.equal(fmtDate('2026-10-09', { now }), 'Oct 9');
  assert.equal(fmtDate('2026-10-09', { time: true, now }), 'Oct 9, 00:00');
});

test('fmtRelative: just now, minutes, hours both ways, then a dated fallback', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const at = (ms) => new Date(now.getTime() + ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  assert.equal(fmtRelative(at(-30_000), now), 'just now');
  assert.equal(fmtRelative(at(20_000), now), 'just now');
  assert.equal(fmtRelative(at(-5 * MIN), now), '5m ago');
  assert.equal(fmtRelative(at(-2 * HOUR), now), '2h ago');
  assert.equal(fmtRelative(at(3 * HOUR), now), 'in 3h');
  assert.equal(fmtRelative(at(10 * MIN), now), 'in 10m');
  assert.equal(fmtRelative(at(25 * MIN + 30_000), now), 'in 25m', 'future times count down too');
  assert.equal(fmtRelative(at(25 * HOUR), now), 'in 25h');
  assert.equal(fmtRelative(at(47 * HOUR + 59 * MIN), now), 'in 47h', 'future: relative within 48h');
  assert.equal(fmtRelative(at(-47 * HOUR), now), '47h ago', 'relative within 48h');
  const old = at(-3 * 24 * HOUR);
  assert.equal(fmtRelative(old, now), fmtDate(old, { time: true, now }));
  const later = at(5 * 24 * HOUR);
  assert.equal(fmtRelative(later, now), fmtDate(later, { time: true, now }));
  // Local-time check of the fallback text itself.
  const localNow = new Date(2026, 9, 27, 12, 0);
  assert.equal(fmtRelative(iso(2026, 9, 24, 13, 0), localNow), 'Oct 24, 13:00');
  assert.equal(fmtRelative(null, now), '—');
});

test('pluralize picks the word and formats the count', () => {
  assert.equal(pluralize(1, 'draft', 'drafts'), '1 draft');
  assert.equal(pluralize(0, 'draft', 'drafts'), '0 drafts');
  assert.equal(pluralize(1200, 'company', 'companies'), '1,200 companies');
  assert.equal(pluralize(2, 'invite'), '2 invites', 'many defaults to one + "s"');
});

test('truncate shortens with an ellipsis and keeps short text', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abcd', 4), 'abcd');
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate(null, 3), '');
});

test('safeUrl keeps http(s) links only', () => {
  assert.equal(safeUrl('https://acme.com/x?a=1'), 'https://acme.com/x?a=1');
  assert.equal(safeUrl(' http://a.b '), 'http://a.b');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('JaVaScRiPt:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,<b>'), '');
  assert.equal(safeUrl('//evil.example'), '');
  assert.equal(safeUrl(null), '');
});

test('RUN_STATUS: one wording and tone per run status, with a neutral fallback', () => {
  assert.deepEqual({ ...RUN_STATUS }, {
    ok: ['Succeeded', 'ok'],
    error: ['Failed', 'danger'],
    auth_failed: ['Sign-in failed', 'warn'],
    running: ['Running', 'accent'],
  });
  assert.ok(Object.isFrozen(RUN_STATUS), 'shared, so nobody edits it');
  assert.deepEqual(runStatus('ok'), ['Succeeded', 'ok']);
  assert.deepEqual(runStatus('auth_failed'), ['Sign-in failed', 'warn']);
  assert.deepEqual(runStatus('cancelled'), ['cancelled', 'neutral'], 'an unknown status shows as it is');
  assert.deepEqual(runStatus(''), ['Unknown', 'neutral']);
  assert.deepEqual(runStatus(null), ['Unknown', 'neutral']);
  assert.deepEqual(runStatus('constructor'), ['constructor', 'neutral'], 'no prototype lookups');
  assert.equal(RUN_STATUS.toString, undefined);
});

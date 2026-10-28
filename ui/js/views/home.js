// Home (spec §5.2): what needs the human now, the stat line, the funnel, recent runs and top
// searches; a workspace with no companies yet gets a getting-started list instead.
//
// Data: the summary comes from the shared store (/api/summary, polled every 30s and refreshed
// after mutations elsewhere), so Home and the sidebar counts always agree. /api/runs and
// /api/companies?per=1 (for `queries`) are fetched here, and fetched again when the summary says
// they changed (a newer last run, a different company count). Each source has its own loading,
// empty and error state. Every server string reaches the page as text through h(); hrefs are
// built with href() or checked against the app's own routes. Where their section is too narrow
// for a table, Recent runs render as cards (a ResizeObserver swaps them). Unmount drops the store
// subscription and that observer, and aborts any request in flight. Run statuses use the shared
// wording (runStatus, core/format.js), so Home and Schedules name a run the same way.

import { api } from '../core/api.js';
import { fmtDate, fmtNum, fmtRelative, h, pluralize, runStatus, toDate } from '../core/dom.js';
import { href } from '../core/router.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/emptyState.js';
import { table } from '../components/table.js';

const title = 'Home';

const RUNS_SHOWN = 5;
// Recent runs are a table when their section is at least this wide (px), else a list of cards:
// on a phone, and in a window the sidebar leaves narrow (1024px wide leaves the section ~730px).
const RUNS_TABLE_MIN = 820;
const SEARCHES_SHOWN = 8;
const STARTER_PROMPT =
  "Find 20 companies that match my company profile, then find each founder's email or LinkedIn profile.";

const PCT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

/** part / whole as "16.7%"; "—" when there is nothing to divide by. */
export function pct(part, whole) {
  const p = Number(part);
  const w = Number(whole);
  if (!w || !Number.isFinite(p) || !Number.isFinite(w)) return '—';
  return PCT.format(p / w);
}

const STAGES = {
  sourced: 'Sourced',
  contact_found: 'Contact found',
  drafted: 'Drafted',
  sent: 'Sent',
  replied: 'Replied',
};

const TRIGGERS = { scheduled: 'Scheduled', manual: 'Manual', dry: 'Dry run' };

// Problems only the human can fix (summary.attention), by kind: a short title, the action, and
// where to fix it when the server's target isn't an app route.
const ATTENTION = {
  provider_missing: { title: 'Agent unavailable', action: 'Open agent settings', target: '#/settings?tab=agent' },
  canonical_disconnected: { title: 'Canonical not connected', action: 'Connect Canonical', target: '#/settings?tab=connections' },
  linkedin_reconnect: { title: 'LinkedIn signed out', action: 'Reconnect LinkedIn', target: '#/settings?tab=connections' },
  last_run_failed: { title: 'Last run failed', action: 'See run history', target: '#/schedules' },
};
const ATTENTION_OTHER = { title: 'Needs attention', action: 'Open Settings', target: '#/settings' };

// Only hash routes of this app become hrefs; anything else from the server is ignored.
const APP_ROUTE = /^#\/[a-z-]+(\/[^\s"'<>]*)?(\?[^\s"'<>]*)?$/;

function icon(paths, size = 16, cls) {
  return h(
    'svg',
    {
      class: cls,
      viewBox: '0 0 24 24',
      width: String(size),
      height: String(size),
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.75',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    [].concat(paths).map((d) => h('path', { d })),
  );
}

const ICONS = {
  alert: ['M12 3l9.5 17h-19L12 3z', 'M12 10v4', 'M12 17.5v.01'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  check: 'M5 12.5l4.5 4.5L19 7',
};

const isAbort = (err) => err && (err.name === 'AbortError' || err.code === 20);

/** The error's message unless the session banner already says it (a 401). */
const detailOf = (err) => (err && err.status === 401 ? '' : (err && err.message) || String(err || ''));

const HOUR = 3_600_000;

/**
 * When a schedule runs next, worded to end the sentence "<name> runs next …": "in 18h" within 48h
 * (spec §5.10, as the top bar's chip says it), else "on Oct 30, 09:00". A time that has come
 * already (the timer is late) is "any minute now". `title` is the full date for the tooltip.
 */
export function nextRunWhen(iso, now = new Date()) {
  const d = toDate(iso);
  if (!d) return null;
  const ms = d.getTime() - now.getTime();
  const full = fmtDate(d, { time: true, now });
  const text = ms < 60_000 ? 'any minute now' : ms < 48 * HOUR ? fmtRelative(d, now) : `on ${full}`;
  return { text, datetime: d.toISOString(), title: full };
}

/** "<name> runs next in 18h." as nodes, the time in a <time> with the full date as its tooltip. */
function nextRunSentence(next, when, tail = '') {
  const name = next && next.name ? String(next.name) : 'A schedule';
  return [`${name} runs next `, h('time', { datetime: when.datetime, title: when.title }, when.text), `.${tail}`];
}

/** A section: an h2 head (with an optional link on the right) over a body the view refills. */
function section(id, heading, { link, cls, hiddenHeading = false } = {}) {
  const headingId = `home-${id}-title`;
  const h2 = h('h2', { id: headingId, class: ['home-h2', hiddenHeading && 'sr-only'], tabindex: '-1' }, heading);
  const body = h('div', { class: 'home-section-body' });
  const el = h(
    'section',
    { class: ['home-section', cls], 'aria-labelledby': headingId },
    hiddenHeading ? h2 : h('div', { class: 'home-section-head' }, h2, link ? h('a', { class: 'home-section-link', href: link.href }, link.label) : null),
    body,
  );
  return { el, h2, body };
}

/** Replace a container's children; a focused element that has a twin (same data-focus) in the
 *  new content keeps the focus. */
function swap(container, nodes) {
  const active = document.activeElement;
  const key = active && active !== container && container.contains(active) ? active.getAttribute('data-focus') : null;
  container.replaceChildren(...[].concat(nodes).filter(Boolean));
  if (key) {
    const twin = [...container.querySelectorAll('[data-focus]')].find((el) => el.getAttribute('data-focus') === key);
    if (twin) twin.focus({ preventScroll: true });
  }
}

function errorBox(heading, err, onRetry) {
  const detail = detailOf(err);
  return h(
    'div',
    { class: 'home-error', role: 'alert' },
    icon(ICONS.alert, 16, 'home-error-icon'),
    h(
      'div',
      { class: 'home-error-text' },
      h('p', { class: 'home-error-title' }, heading),
      detail ? h('p', { class: 'home-error-detail' }, detail) : null,
    ),
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: onRetry }, 'Try again'),
  );
}

function loadingRows(label, rows = 4) {
  return h(
    'div',
    { class: 'home-loading' },
    h('span', { class: 'sr-only' }, label),
    Array.from({ length: rows }, (_, i) => h('span', { class: 'skeleton', 'aria-hidden': 'true', style: { width: `${92 - i * 11}%` } })),
  );
}

// ---- Needs you ----

/** The cards Home shows, most urgent first: connection problems and a failed run, then the
 *  drafts, due follow-ups and replies waiting. */
export function needsYouItems(summary) {
  const c = (summary && summary.counts) || {};
  const items = [];
  for (const a of (summary && summary.attention) || []) {
    const known = ATTENTION[a.kind] || ATTENTION_OTHER;
    const target = typeof a.target === 'string' && APP_ROUTE.test(a.target) ? a.target : known.target;
    items.push({ key: `attention:${a.kind}`, warn: true, label: known.title, meta: a.message || '', cta: known.action, href: target });
  }
  const n = (v) => Number(v) || 0;
  if (n(c.drafts) > 0) {
    const parts = [];
    if (n(c.drafts_email) > 0) parts.push(`${fmtNum(c.drafts_email)} email`);
    if (n(c.drafts_linkedin) > 0) parts.push(`${fmtNum(c.drafts_linkedin)} LinkedIn`);
    items.push({
      key: 'drafts',
      num: c.drafts,
      label: n(c.drafts) === 1 ? 'draft waiting' : 'drafts waiting',
      meta: parts.join(' · '),
      cta: 'Review drafts',
      href: '#/drafts',
    });
  }
  if (n(c.followups_due) > 0) {
    items.push({
      key: 'followups',
      num: c.followups_due,
      label: n(c.followups_due) === 1 ? 'follow-up due' : 'follow-ups due',
      meta: 'No reply 4+ days after your last message',
      cta: 'Open follow-ups',
      href: href(['followups'], { tab: 'due' }),
    });
  }
  if (n(c.replied) > 0) {
    items.push({
      key: 'replies',
      num: c.replied,
      label: n(c.replied) === 1 ? 'reply' : 'replies',
      meta: 'Founders who wrote back',
      cta: 'See replies',
      href: href(['followups'], { tab: 'replied' }),
    });
  }
  return items;
}

// The link's name reads the card in order ("52 drafts waiting. 12 email · 40 LinkedIn. Review
// drafts"): its parts are separate boxes, which would otherwise run together.
const nameOf = (...parts) => parts.filter(Boolean).join('. ');

/** A count that waits on the human: number + what, a detail line, the action. */
function needsYouCard(it) {
  return h(
    'li',
    { class: 'home-ny-item' },
    h(
      'a',
      { class: 'home-ny-card', href: it.href, 'data-focus': it.key, 'aria-label': nameOf(`${fmtNum(it.num)} ${it.label}`, it.meta, it.cta) },
      h('span', { class: 'home-ny-top' }, h('span', { class: 'home-ny-num' }, fmtNum(it.num)), h('span', { class: 'home-ny-label' }, it.label)),
      it.meta ? h('span', { class: 'home-ny-meta' }, it.meta) : null,
      h('span', { class: 'home-ny-cta' }, it.cta, icon(ICONS.arrow, 14)),
    ),
  );
}

/** A problem only the human can fix: one full-width row above the counts. */
function needsYouAlert(it) {
  return h(
    'li',
    { class: 'home-ny-item' },
    h(
      'a',
      { class: 'home-ny-alert', href: it.href, 'data-focus': it.key, 'aria-label': nameOf(it.label, it.meta, it.cta) },
      icon(ICONS.alert, 18, 'home-ny-icon'),
      h('span', { class: 'home-ny-alert-text' }, h('span', { class: 'home-ny-title' }, it.label), it.meta ? h('span', { class: 'home-ny-meta' }, it.meta) : null),
      h('span', { class: 'home-ny-cta' }, it.cta, icon(ICONS.arrow, 14)),
    ),
  );
}

function renderNeedsYou(summary) {
  const items = needsYouItems(summary);
  if (!items.length) {
    return h(
      'div',
      { class: 'home-ny-quiet' },
      icon(ICONS.check, 18, 'home-ny-quiet-icon'),
      h('p', {}, h('strong', {}, 'Nothing needs you right now.'), ' New drafts, due follow-ups and replies show up here.'),
    );
  }
  const alerts = items.filter((it) => it.warn);
  const counts = items.filter((it) => !it.warn);
  return [
    alerts.length ? h('ul', { class: 'home-ny-alerts', role: 'list' }, alerts.map(needsYouAlert)) : null,
    counts.length ? h('ul', { class: 'home-ny-list', role: 'list' }, counts.map(needsYouCard)) : null,
  ];
}

// ---- Stat line ----

function renderStats(summary) {
  const c = summary.counts || {};
  const rate = pct(c.replied, c.sent);
  const stats = [
    { label: 'Companies', value: fmtNum(c.companies), hint: 'in your pipeline' },
    { label: 'Contacts', value: fmtNum(c.contacts), hint: 'people on file' },
    { label: 'Sent', value: fmtNum(c.sent), hint: 'emails and invites' },
    { label: 'Replies', value: fmtNum(c.replied), hint: 'marked replied' },
    { label: 'Reply rate', value: rate, hint: 'replies ÷ sent' },
  ];
  return h(
    'dl',
    { class: 'home-stats' },
    stats.map((s) =>
      h(
        'div',
        { class: 'home-stat' },
        h('dt', { class: 'home-stat-label' }, s.label),
        h('dd', { class: 'home-stat-value' }, s.value),
        h('dd', { class: 'home-stat-hint' }, s.hint),
      ),
    ),
  );
}

// ---- Funnel ----

function renderFunnel(summary) {
  const pairs = Array.isArray(summary.funnel) ? summary.funnel : [];
  const max = Math.max(1, ...pairs.map(([, n]) => Number(n) || 0));
  const rows = pairs.map(([stage, n], i) => {
    const prev = i > 0 ? pairs[i - 1] : null;
    return {
      stage: String(stage),
      label: STAGES[stage] || String(stage),
      n: Number(n) || 0,
      width: ((Number(n) || 0) / max) * 100,
      rate: prev ? pct(n, prev[1]) : '',
      prevLabel: prev ? STAGES[prev[0]] || String(prev[0]) : '',
    };
  });
  return table({
    label: 'Funnel',
    rowKey: 'stage',
    empty: 'No companies yet',
    columns: [
      {
        key: 'stage',
        label: 'Stage',
        render: (r) =>
          h(
            'div',
            { class: 'home-funnel-cell' },
            h('span', { class: 'home-funnel-stage' }, r.label),
            h('span', { class: 'home-funnel-track', 'aria-hidden': 'true' }, h('span', { class: ['home-funnel-fill', r.n === 0 && 'is-zero'], style: { width: `${r.width}%` } })),
          ),
      },
      { key: 'n', label: 'Companies', align: 'right', render: (r) => h('span', { class: 'home-funnel-count home-num' }, fmtNum(r.n)) },
      {
        key: 'rate',
        label: 'Conversion',
        align: 'right',
        render: (r) =>
          h('span', { class: 'home-funnel-rate home-num', title: r.rate ? `${r.rate} of ${r.prevLabel.toLowerCase()}` : null }, r.rate),
      },
    ],
    rows,
  });
}

// ---- Recent runs ----

function runWhen(iso) {
  const d = toDate(iso);
  return h('time', { datetime: d ? d.toISOString() : null, title: fmtDate(iso, { time: true }) }, fmtRelative(iso));
}

/** What to call a run with no schedule name. /api/runs leaves the name out both for a run nobody
 *  scheduled and for one whose schedule was deleted since, so the trigger tells them apart: a
 *  timer-fired run with no name had a schedule that is gone. */
export function runName(r) {
  if (r && r.schedule_name) return { text: String(r.schedule_name), muted: false };
  const trigger = r && r.trigger;
  if (trigger === 'scheduled') return { text: 'Deleted schedule', muted: true };
  if (trigger === 'manual' || trigger === 'dry') return { text: 'Manual run', muted: true };
  return { text: 'No schedule', muted: true };
}

/** Why a run failed, from its note: the first non-blank line to show and the whole note for the
 *  tooltip. Null for a run that succeeded or is still running, or that has no note. */
export function runNote(r) {
  if (!r || r.note == null || r.status === 'ok' || r.status === 'running') return null;
  const full = String(r.note).trim();
  const line = full
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ? { line, full } : null;
}

/** A key per run that stays the same when newer runs push it down the list (its start time and
 *  conversation, not its index), so a focused "View run" link keeps focus through a refetch. */
export function runKeys(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const base = `${(r && r.started_at) ?? ''}|${(r && r.chat_id) ?? ''}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}

const runTrigger = (r) => TRIGGERS[r.trigger] || r.trigger || '—';
const runBadge = (r) => badge(...runStatus(r.status));
const runHref = (r) => (r.chat_id ? href(['agent', String(r.chat_id)]) : null);
const runLinkName = (r) => `View run: ${runName(r).text}, ${fmtRelative(r.started_at)}`;

/** The run's name, and under it why it failed (the note's first line; the whole note on hover). */
function runTitle(r, noteClass) {
  const { text, muted } = runName(r);
  const note = runNote(r);
  return [
    h('span', { class: ['home-run-name', muted && 'is-muted'], title: text }, text),
    note ? h('span', { class: noteClass, title: note.full }, h('span', { class: 'sr-only' }, 'Why it failed: '), note.line) : null,
  ];
}

/** Recent runs as a table: one row per run, every column on screen. */
function runsTable(rows) {
  const count = (key) => ({ key, label: key[0].toUpperCase() + key.slice(1), align: 'right', render: (r) => h('span', { class: 'home-num' }, fmtNum(r[key])) });
  return table({
    label: 'Recent runs',
    rowKey: (r) => r.key,
    columns: [
      { key: 'name', label: 'Run', nowrap: true, render: (r) => runTitle(r, 'home-run-note') },
      { key: 'trigger', label: 'Trigger', nowrap: true, render: runTrigger },
      { key: 'status', label: 'Status', nowrap: true, render: runBadge },
      // Home is a glance: what each run added (Schedules has the full history, with enriched).
      count('sourced'),
      count('drafted'),
      count('sent'),
      { key: 'when', label: 'When', nowrap: true, render: (r) => runWhen(r.started_at) },
      {
        key: 'view',
        label: h('span', { class: 'sr-only' }, 'Conversation'),
        nowrap: true,
        align: 'right',
        render: (r) => (r.chat_id ? h('a', { href: runHref(r), 'data-focus': `run:${r.key}`, 'aria-label': runLinkName(r) }, 'View run') : ''),
      },
    ],
    rows,
  });
}

/** Recent runs in a narrow section: the table's eight columns don't fit, so each run is a card with
 *  the same facts (name and status, trigger and time, the counts, the link to its conversation). */
function runsCards(rows) {
  const n = (v, what) => [h('span', { class: 'home-num' }, fmtNum(v)), ` ${what}`];
  return h(
    'ul',
    { class: 'home-run-cards', role: 'list', 'aria-label': 'Recent runs' },
    rows.map((r) => {
      const [name, note] = runTitle(r, 'home-run-card-note');
      return h(
        'li',
        { class: 'home-run-card', 'data-key': r.key },
        h('div', { class: 'home-run-card-head' }, name, runBadge(r)),
        note,
        h('p', { class: 'home-run-card-meta' }, runTrigger(r), ' · ', runWhen(r.started_at)),
        h(
          'div',
          { class: 'home-run-card-foot' },
          h('p', { class: 'home-run-card-counts' }, ...n(r.sourced, 'sourced'), ' · ', ...n(r.drafted, 'drafted'), ' · ', ...n(r.sent, 'sent')),
          r.chat_id ? h('a', { class: 'home-run-card-link', href: runHref(r), 'data-focus': `run:${r.key}`, 'aria-label': runLinkName(r) }, 'View run') : null,
        ),
      );
    }),
  );
}

function renderRuns(rows, next, narrow) {
  if (!rows.length) {
    const when = next ? nextRunWhen(next.next_at) : null;
    return h(
      'div',
      { class: 'home-empty' },
      emptyState({
        level: 3,
        title: 'No runs yet',
        body: when
          ? nextRunSentence(next, when, ' What it adds shows up here.')
          : 'A run shows up here after a schedule fires or you use Run now on Schedules.',
        action: h('a', { class: 'btn btn-secondary', href: '#/schedules' }, when ? 'Open Schedules' : 'Create a schedule'),
      }),
    );
  }
  return narrow ? runsCards(rows) : runsTable(rows);
}

// ---- Top searches ----

/**
 * The line under Top searches: how many searches the list leaves out, and how many companies no
 * search found. /api/companies `queries` lists every search but leaves out companies with no
 * source query (a missing source can't be a Pipeline filter), so without this the shares wouldn't
 * add up and those companies would be missing from Home. '' when there is nothing to add.
 */
export function searchesCaption({ shown, searches, total, found }) {
  const parts = [];
  if (searches > shown) parts.push(`Showing the top ${fmtNum(shown)} of ${fmtNum(searches)} searches.`);
  const none = Number(total) - Number(found);
  if (none > 0) parts.push(`${pluralize(none, 'company has', 'companies have')} no search recorded.`);
  return parts.join(' ');
}

// The "No search recorded" row only guards against a null query from the server.
function renderSearches({ queries, total, searches, found }, open) {
  if (!queries.length) {
    return h(
      'div',
      { class: 'home-empty' },
      emptyState({
        level: 3,
        title: 'No searches yet',
        body: 'Companies the agent finds are grouped here by the search that found them.',
      }),
    );
  }
  const wrap = table({
    label: 'Top searches',
    rowKey: (r) => r.key,
    // A click anywhere on the row opens Pipeline filtered by its search. This is a click handler
    // (the table ignores presses on the link itself), not a link stretched over the row: WebKit
    // can't position anything against a <tr>, so a stretched link would cover the whole page.
    // The search's link is the row's one keyboard stop (a real link, named by the search, that
    // Cmd/Ctrl-click opens in a new tab), so the rows aren't tab stops too.
    rowFocus: false,
    onRowClick: (r) => {
      if (r.q) open(href(['pipeline'], { query: r.q }));
    },
    columns: [
      {
        key: 'q',
        label: 'Search',
        render: (r) =>
          r.q
            ? h('a', { class: 'home-search-link', href: href(['pipeline'], { query: r.q }), title: r.q, 'data-focus': `q:${r.q}` }, r.q)
            : h('span', { class: 'text-2' }, 'No search recorded'),
      },
      { key: 'n', label: 'Companies', align: 'right', width: '112px', render: (r) => h('span', { class: 'home-num' }, fmtNum(r.n)) },
      { key: 'share', label: 'Share', align: 'right', width: '88px', render: (r) => h('span', { class: 'home-num' }, pct(r.n, total)) },
    ],
    rows: queries.map(([q, n], i) => ({ key: `${i}`, q: q == null ? '' : String(q), n: Number(n) || 0 })),
  });
  // A row with nothing to filter by doesn't look clickable (its click does nothing).
  for (const tr of wrap.querySelectorAll('tbody tr.is-clickable')) {
    if (!tr.querySelector('a[href]')) tr.classList.remove('is-clickable');
  }
  const caption = searchesCaption({ shown: queries.length, searches, total, found });
  return [wrap, caption ? h('p', { class: 'home-caption' }, caption) : null];
}

// ---- Getting started ----

function startSteps(summary, status) {
  const steps = [
    {
      title: 'Find companies with the agent',
      body: 'Ask the agent for companies that match your profile. It sources them and looks up their founders.',
      action: { label: 'Ask the agent', href: href(['agent'], { prompt: STARTER_PROMPT }), primary: true },
    },
    {
      title: 'Review drafts',
      body: 'The agent writes an email or a LinkedIn note for each founder. Nothing goes out until you send it, or turn on auto-send.',
      action: { label: 'Open Drafts', href: '#/drafts' },
    },
  ];
  const next = summary && summary.next_schedule;
  steps.push({
    title: 'Create a schedule',
    body: 'Run the agent daily or weekly so new companies and drafts arrive while you are away.',
    // Plain data (the step list's signature is its JSON); renderStart words it.
    next: next ? { name: next.name, when: nextRunWhen(next.next_at) } : null,
    done: !!next,
    action: { label: next ? 'View schedules' : 'Open Schedules', href: '#/schedules' },
  });
  // Only when setup's destination step was skipped (and status says so).
  if (status && !status.destination_connected && !status.linkedin_connected) {
    steps.push({
      title: 'Connect where outreach goes',
      body: 'Connect Gmail or LinkedIn so your drafts can go out from your own accounts.',
      action: { label: 'Open Settings', href: href(['settings'], { tab: 'connections' }) },
    });
  }
  return steps;
}

function renderStart(summary, status) {
  const steps = startSteps(summary, status);
  return h(
    'ol',
    { class: 'home-start-steps', role: 'list' },
    steps.map((s, i) =>
      h(
        'li',
        { class: ['home-start-step', s.done && 'is-done'] },
        h('span', { class: 'home-start-num', 'aria-hidden': 'true' }, s.done ? icon(ICONS.check, 14) : String(i + 1)),
        h(
          'div',
          { class: 'home-start-text' },
          h('h3', { class: 'home-start-title' }, s.title, s.done ? h('span', { class: 'home-start-done' }, ' ', badge('Done', 'ok')) : null),
          h('p', { class: 'home-start-body' }, s.next && s.next.when ? nextRunSentence(s.next, s.next.when) : s.body),
        ),
        h(
          'a',
          { class: ['btn', s.action.primary ? 'btn-primary' : s.done ? 'btn-ghost' : 'btn-secondary', 'home-start-action'], href: s.action.href, 'data-focus': `step:${i}` },
          s.action.label,
        ),
      ),
    ),
  );
}

// ---- The view ----

const DESC = {
  dash: 'What needs you, how outreach is converting, and what recent runs did.',
  start: 'Nothing is in your pipeline yet. These steps take you from a first search to a first send.',
  loading: 'What needs you, how outreach is converting, and what recent runs did.',
};

let current = null;

// A summary this recent is the one on screen already; mounting doesn't fetch it again.
const FRESH_MS = 3000;

/** How long ago the latest /api/summary answer arrived, from the page's resource timing (the store
 *  doesn't say when it last fetched); Infinity when unknown, so Home then asks for fresh numbers. */
function summaryAgeMs() {
  try {
    const seen = performance.getEntriesByName(new URL('/api/summary', location.href).href, 'resource');
    const last = seen[seen.length - 1];
    return last && last.responseEnd > 0 ? performance.now() - last.responseEnd : Infinity;
  } catch (_) {
    return Infinity;
  }
}

function mountHome(root, ctx) {
  const store = ctx.store;
  let gone = false;
  let mode = null; // 'loading' | 'error' | 'dash' | 'start'
  const ctls = new Set();
  const sigs = {}; // last rendered signature per part, so unchanged parts keep their DOM (and focus)

  // Requests: each source tracks its own controller; unmount aborts them all.
  function controller() {
    const ctl = new AbortController();
    ctls.add(ctl);
    return ctl;
  }
  const release = (ctl) => ctls.delete(ctl);

  // ---- Static frame ----
  const desc = h('p', { class: 'page-desc' }, DESC.loading);
  const askAgent = h('a', { class: 'btn btn-primary', href: '#/agent', hidden: true }, 'Ask the agent');
  const body = h('div', { class: 'home-body' });
  root.append(
    h(
      'div',
      { class: 'home' },
      h('div', { class: 'page-head' }, h('div', { class: 'page-head-text' }, h('h1', {}, title), desc), h('div', { class: 'page-actions' }, askAgent)),
      body,
    ),
  );

  // Dashboard sections, built once per switch into dashboard mode.
  let dash = null;
  // Runs and searches: { status: 'idle'|'loading'|'ok'|'error', rows|queries, total, error }
  let runs = { status: 'idle' };
  let searches = { status: 'idle' };
  let runsKey; // the summary's last run when runs were fetched
  let companiesKey; // the company count when searches were fetched
  let runsCtl = null;
  let searchesCtl = null;
  let summaryShown = null;

  // Recent runs become cards when their section is narrower than RUNS_TABLE_MIN. The section's
  // width, not the window's, decides: the sidebar takes 232px from 900px up, so a 1024px window
  // leaves less room than an 899px one. Unknown (not laid out yet) means the table.
  const isNarrow = () => {
    const w = dash && dash.recent ? dash.recent.el.clientWidth : 0;
    return w > 0 && w < RUNS_TABLE_MIN;
  };
  let runsWidth = 0;
  const runsRo =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          const w = Math.round(entries[entries.length - 1].contentRect.width);
          if (gone || w === runsWidth) return;
          runsWidth = w;
          drawRuns();
        })
      : null;

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    for (const k of Object.keys(sigs)) delete sigs[k];
    if (runsRo) runsRo.disconnect();
    runsWidth = 0;
    desc.textContent = DESC[next] || DESC.dash;
    askAgent.hidden = next !== 'dash';
    body.removeAttribute('aria-busy');
    dash = null;
    if (next === 'loading') {
      body.setAttribute('aria-busy', 'true');
      body.replaceChildren(
        h('span', { class: 'sr-only' }, 'Loading your workspace…'),
        h('ul', { class: 'home-ny-list', 'aria-hidden': 'true' }, [0, 1, 2].map(() => h('li', { class: 'home-ny-card home-ny-card-skeleton' }, h('span', { class: 'skeleton home-skel-num' }), h('span', { class: 'skeleton home-skel-line' }), h('span', { class: 'skeleton home-skel-short' })))),
        h('div', { class: 'home-stats home-stats-loading', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(() => h('div', { class: 'home-stat' }, h('span', { class: 'skeleton home-skel-short' }), h('span', { class: 'skeleton home-skel-num' })))),
      );
    } else if (next === 'dash') {
      const needs = section('needs', 'Needs you', { cls: 'home-needs' });
      const glance = section('glance', 'At a glance', { cls: 'home-glance', hiddenHeading: true });
      const funnel = section('funnel', 'Funnel', { cls: 'home-funnel' });
      const top = section('searches', 'Top searches', { cls: 'home-searches', link: { label: 'Open pipeline', href: '#/pipeline' } });
      const recent = section('runs', 'Recent runs', { cls: 'home-runs', link: { label: 'All runs', href: '#/schedules' } });
      dash = { needs, glance, funnel, top, recent };
      body.replaceChildren(needs.el, glance.el, h('div', { class: 'home-grid' }, funnel.el, top.el), recent.el);
      if (runsRo) runsRo.observe(recent.el);
    } else if (next === 'start') {
      const start = section('start', 'Get started', { cls: 'home-start' });
      dash = { start };
      body.replaceChildren(start.el);
    }
  }

  function showSummaryError(err) {
    setMode('error');
    body.replaceChildren(errorBox("Couldn't load your workspace summary", err, () => loadSummary({ fromRetry: true })));
  }

  // Render one part only when what it shows changed.
  function part(name, sig, container, build) {
    if (sigs[name] === sig) return;
    sigs[name] = sig;
    swap(container, build());
  }

  function renderSummary(summary, status) {
    summaryShown = summary;
    const empty = !(summary.counts && Number(summary.counts.companies) > 0);
    setMode(empty ? 'start' : 'dash');
    if (empty) {
      const steps = startSteps(summary, status);
      part('start', JSON.stringify(steps), dash.start.body, () => renderStart(summary, status));
      return;
    }
    part('needs', JSON.stringify([summary.counts, summary.attention]), dash.needs.body, () => renderNeedsYou(summary));
    part('glance', JSON.stringify(summary.counts), dash.glance.body, () => renderStats(summary));
    part('funnel', JSON.stringify(summary.funnel), dash.funnel.body, () => renderFunnel(summary));

    // Runs and searches: first time, or when the summary says they changed.
    const lr = summary.last_run;
    const nextRunsKey = lr ? `${lr.started_at}|${lr.status}` : '';
    if (runs.status === 'idle' || nextRunsKey !== runsKey) {
      runsKey = nextRunsKey;
      loadRuns();
    } else {
      drawRuns();
    }
    const nextCompaniesKey = String(summary.counts.companies);
    if (searches.status === 'idle' || nextCompaniesKey !== companiesKey) {
      companiesKey = nextCompaniesKey;
      loadSearches();
    } else {
      drawSearches();
    }
  }

  function drawRuns() {
    if (!dash || !dash.recent) return;
    const sec = dash.recent;
    const loading = runs.status === 'loading' && !runs.rows;
    if (loading) sec.el.setAttribute('aria-busy', 'true');
    else sec.el.removeAttribute('aria-busy');
    if (runs.rows) {
      // Relative times ("2h ago", "in 18h") are part of the signature, so they stay current.
      const next = (summaryShown && summaryShown.next_schedule) || null;
      const narrow = isNarrow();
      const upcoming = runs.rows.length || !next ? null : [next, nextRunWhen(next.next_at)];
      const sig = JSON.stringify([narrow, runs.rows.map((r) => [r, fmtRelative(r.started_at)]), upcoming]);
      part('runs', sig, sec.body, () => renderRuns(runs.rows, next, narrow));
    } else if (runs.status === 'error') {
      part('runs', `error:${detailOf(runs.error)}`, sec.body, () => errorBox("Couldn't load recent runs", runs.error, () => loadRuns({ fromRetry: true })));
    } else {
      part('runs', 'loading', sec.body, () => loadingRows('Loading recent runs…', 5));
    }
  }

  function drawSearches() {
    if (!dash || !dash.top) return;
    const sec = dash.top;
    const loading = searches.status === 'loading' && !searches.queries;
    if (loading) sec.el.setAttribute('aria-busy', 'true');
    else sec.el.removeAttribute('aria-busy');
    if (searches.queries) {
      const { queries, total, count, found } = searches;
      part('searches', JSON.stringify([queries, total, count, found]), sec.body, () =>
        renderSearches({ queries, total, searches: count, found }, (to) => ctx.nav.navigate(to)),
      );
    } else if (searches.status === 'error') {
      part('searches', `error:${detailOf(searches.error)}`, sec.body, () => errorBox("Couldn't load top searches", searches.error, () => loadSearches({ fromRetry: true })));
    } else {
      part('searches', 'loading', sec.body, () => loadingRows('Loading top searches…', 6));
    }
  }

  // After a retry, keep keyboard focus in the section that was retried.
  function refocus(sec) {
    const a = document.activeElement;
    if (!a || a === document.body || !document.contains(a)) sec.h2.focus({ preventScroll: true });
  }

  async function loadRuns({ fromRetry = false } = {}) {
    if (runsCtl) runsCtl.abort();
    const ctl = controller();
    runsCtl = ctl;
    // A background refetch keeps the rows on screen; only a first load or a retry shows loading.
    if (!runs.rows || fromRetry) runs = { status: 'loading' };
    else runs = { ...runs, status: 'loading' };
    drawRuns();
    try {
      const rows = await api.get('/api/runs', { signal: ctl.signal });
      if (gone || ctl.signal.aborted) return;
      const list = Array.isArray(rows) ? rows.slice(0, RUNS_SHOWN) : [];
      const keys = runKeys(list);
      runs = { status: 'ok', rows: list.map((r, i) => ({ ...r, key: keys[i] })) };
    } catch (err) {
      if (gone || ctl.signal.aborted || isAbort(err)) return;
      // A failed background refetch keeps what is on screen.
      runs = runs.rows && !fromRetry ? { status: 'ok', rows: runs.rows } : { status: 'error', error: err };
    } finally {
      release(ctl);
      if (runsCtl === ctl) runsCtl = null;
    }
    drawRuns();
    if (fromRetry && dash && dash.recent) refocus(dash.recent);
  }

  async function loadSearches({ fromRetry = false } = {}) {
    if (searchesCtl) searchesCtl.abort();
    const ctl = controller();
    searchesCtl = ctl;
    if (!searches.queries || fromRetry) searches = { status: 'loading' };
    else searches = { ...searches, status: 'loading' };
    drawSearches();
    try {
      const page = await api.get('/api/companies?per=1', { signal: ctl.signal });
      if (gone || ctl.signal.aborted) return;
      const all = Array.isArray(page && page.queries) ? page.queries.filter(Array.isArray) : [];
      searches = {
        status: 'ok',
        queries: all.slice(0, SEARCHES_SHOWN),
        total: Number(page && page.total) || 0,
        count: all.length,
        found: all.reduce((sum, [, n]) => sum + (Number(n) || 0), 0),
      };
    } catch (err) {
      if (gone || ctl.signal.aborted || isAbort(err)) return;
      searches = searches.queries && !fromRetry ? { ...searches, status: 'ok' } : { status: 'error', error: err };
    } finally {
      release(ctl);
      if (searchesCtl === ctl) searchesCtl = null;
    }
    drawSearches();
    if (fromRetry && dash && dash.top) refocus(dash.top);
  }

  // The summary: fresh from the store on every visit; on failure, ask once more to say why.
  async function loadSummary({ fromRetry = false } = {}) {
    if (!summaryShown || fromRetry) setMode('loading');
    const snap = await store.refresh();
    if (gone) return;
    if (snap && snap.summary) {
      renderSummary(snap.summary, snap.status);
      if (fromRetry) focusTitle();
      return;
    }
    if (summaryShown) return; // keep the last good numbers
    const ctl = controller();
    try {
      const summary = await api.get('/api/summary', { signal: ctl.signal });
      if (gone) return;
      renderSummary(summary, store.get().status);
      store.refresh(); // the sidebar catches up too
      if (fromRetry) focusTitle();
    } catch (err) {
      if (gone || isAbort(err)) return;
      showSummaryError(err);
      if (fromRetry) {
        const btn = body.querySelector('.home-error button');
        if (btn) btn.focus({ preventScroll: true });
      }
    } finally {
      release(ctl);
    }
  }

  function focusTitle() {
    const a = document.activeElement;
    if (a && a !== document.body && document.contains(a)) return;
    const h1 = root.querySelector('h1');
    if (h1) {
      h1.setAttribute('tabindex', '-1');
      h1.focus({ preventScroll: true });
    }
  }

  const unsubscribe = store.subscribe((snap) => {
    if (gone || !snap.summary) return;
    renderSummary(snap.summary, snap.status);
  });

  // Fresh numbers on every visit, unless the store's summary only just arrived: on a cold load the
  // router mounts Home right after the store's first fetch, and asking again would repeat it.
  const first = store.get();
  if (first && first.summary) {
    renderSummary(first.summary, first.status);
    if (summaryAgeMs() > FRESH_MS) loadSummary();
  } else {
    setMode('loading');
    loadSummary();
  }

  const instance = {
    refresh: () => loadSummary(),
    unmount() {
      gone = true;
      unsubscribe();
      if (runsRo) runsRo.disconnect();
      for (const ctl of ctls) ctl.abort();
      ctls.clear();
      if (current === instance) current = null;
    },
  };
  current = instance;
  return instance.unmount;
}

export default {
  title,
  css: true,
  mount: mountHome,
  /** Same screen again (e.g. #/home?…): keep the DOM, fetch fresh numbers. */
  update() {
    if (current) current.refresh();
    return true;
  },
};

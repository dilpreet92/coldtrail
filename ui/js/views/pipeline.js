// Pipeline (spec §5.3): every sourced company in a server-paged table (50 a page) with a
// debounced search, stage tabs and a "Sourced by" picker, all mirrored in the URL
// (#/pipeline?q=&stage=&query=&page=). #/pipeline/<domain> opens the company drawer: website,
// stage, contacts, outreach history and source, with Ask agent (prefills Agent, never sends)
// and Skip / Restore (POST /api/companies/:domain/status); a company with a draft waiting is
// sent to Drafts instead.
//
// The URL is the single source of truth: controls only call nav.setQuery / nav.navigate, and
// update(ctx) applies whatever the address now says (typing, tabs, pager, back/forward, deep
// links). Every dynamic string reaches the page through h() / textContent. Work done elsewhere
// (a scheduled run, an agent turn) reaches the open list through the shared store.
//
// ⌘K over the drawer is the shell's (keys.js closes the drawer as Esc would, then search takes
// focus); the drawer's onClose puts the list back in the URL like any other user close.

import { api, errorText, isStaleSession } from '../core/api.js';
import { debounce, fmtDate, fmtNum, fmtRelative, h, pluralize, safeUrl, toDate } from '../core/dom.js';
import { bindKeys } from '../core/keys.js';
import { href, parseHash } from '../core/router.js';
import { isBusy, openDrawer, setBusy, toast } from '../core/ui.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/emptyState.js';
import { pager } from '../components/pager.js';
import { searchSelect } from '../components/searchSelect.js';
import { table } from '../components/table.js';
import { tabs } from '../components/tabs.js';

const TITLE = 'Pipeline';
const PER = 50;
const SEARCH_MS = 250;
const LOOKUP_PER = 200;
const DAY_MS = 86_400_000;

/** Company statuses in pipeline order: label (inventory "Friendly stage labels") and tone. */
export const STAGES = [
  { id: 'sourced', label: 'Sourced', tone: 'neutral' },
  { id: 'named', label: 'Name only', tone: 'neutral' },
  { id: 'emailed', label: 'Contact found', tone: 'accent' },
  { id: 'drafted', label: 'In Gmail', tone: 'accent' },
  { id: 'sent', label: 'Sent', tone: 'ok' },
  { id: 'replied', label: 'Replied', tone: 'ok' },
  { id: 'bounced', label: 'Bounced', tone: 'danger' },
  { id: 'skip', label: 'Skipped', tone: 'neutral' },
];
const STAGE_BY_ID = new Map(STAGES.map((s) => [s.id, s]));

/** "emailed" → "Contact found"; an unknown status reads as itself. */
export function stageLabel(status) {
  const s = STAGE_BY_ID.get(status);
  return s ? s.label : String(status ?? '');
}

function stageBadge(status, cls) {
  const el = badge(stageLabel(status), (STAGE_BY_ID.get(status) || {}).tone || 'neutral');
  if (cls) el.classList.add(cls);
  return el;
}

// Outreach row statuses (one message on one channel), as the drawer's history shows them.
const OUTREACH = {
  draft_pending: ['Draft', 'neutral'],
  drafted: ['In Gmail', 'accent'],
  sent: ['Sent', 'ok'],
  replied: ['Replied', 'ok'],
  bounced: ['Bounced', 'danger'],
};

const CONFIDENCE = { direct: 'Direct', inferred: 'Inferred', generic: 'Generic' };
const CONFIDENCE_HINT = {
  direct: 'Found published for this person',
  inferred: "Guessed from the company's email pattern",
  generic: 'A shared inbox, not a person',
};

/** How the company reads in prompts and toasts: "Acme (acme.com)", or the domain. */
const companyLabel = (c) => (c && c.name ? `${c.name} (${c.domain})` : c ? c.domain : '');
const displayName = (c, domain) => (c && c.name) || (c && c.domain) || domain;

/** The Agent prompt for a company's next step (never sent for the user). */
export function askPrompt(mode, company) {
  const who = companyLabel(company);
  return mode === 'draft'
    ? `Draft personalized outreach for ${who}.`
    : `Find a founder contact for ${who}, then draft personalized outreach.`;
}

const FIND_PROMPT = 'Find 20 companies that match my company profile and add them to the pipeline.';

/** "2h ago" within 48h, else "Oct 9" (dates in tables don't need the time). */
function shortWhen(iso, now = new Date()) {
  const d = toDate(iso);
  if (!d) return '—';
  return Math.abs(now - d) < 2 * DAY_MS ? fmtRelative(d, now) : fmtDate(d, { now });
}

const longWhen = (iso) => (toDate(iso) ? fmtDate(iso, { time: true }) : '');

// ---- Icons (inline stroke SVG, spec §2) ----

const ICON = {
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
  mail: ['M4 6.5h16v11H4z', 'M4.5 7l7.5 6 7.5-6'],
  person: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M5 20c.8-3.4 3.6-5 7-5s6.2 1.6 7 5'],
  external: ['M14 5h5v5', 'M19 5l-8 8', 'M17 14v5H5V7h5'],
  alert: ['M12 3l9.5 17h-19L12 3z', 'M12 10v4', 'M12 17.5v.01'],
};

function icon(name, size = 14) {
  return h(
    'svg',
    {
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
      class: 'pl-icon',
    },
    ICON[name].map((d) => h('path', { d })),
  );
}

function externalLink(url, label, cls) {
  return h(
    'a',
    { href: url, target: '_blank', rel: 'noopener noreferrer', class: ['pl-ext', cls] },
    h('span', {}, label),
    icon('external', 12),
    h('span', { class: 'sr-only' }, ' (opens in a new tab)'),
  );
}

/** A failed load (the list, or the drawer's company): what didn't load, why, and Try again. On a
 *  stale session the shell's banner (an alert) already says what happened, once: this gives the
 *  short pointer at the fix (errorText), isn't an alert itself, and offers no Try again (nothing
 *  loads until the tab is reopened). */
function errorBox(title, err, retry) {
  const stale = isStaleSession(err);
  return h(
    'div',
    { class: 'pl-error', role: stale ? null : 'alert' },
    icon('alert', 18),
    h('div', { class: 'pl-error-text' }, h('p', { class: 'pl-error-title' }, title), h('p', { class: 'pl-error-msg' }, errorText(err))),
    stale ? null : h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: retry }, 'Try again'),
  );
}

const SITE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const siteUrl = (domain) => (SITE_RE.test(String(domain || '')) ? `https://${domain}` : '');

// ---- URL state ----

function readQuery(query = {}) {
  const page = Number.parseInt(query.page, 10);
  return {
    q: String(query.q ?? ''),
    stage: String(query.stage ?? ''),
    query: String(query.query ?? ''),
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

const sameList = (a, b) => a.q.trim() === b.q.trim() && a.stage === b.stage && a.query === b.query && a.page === b.page;

/** The list part of the route as query params (page 1 and blanks left out). */
const listQuery = (s) => ({ q: s.q.trim() || null, stage: s.stage || null, query: s.query || null, page: s.page > 1 ? s.page : null });

const isAbort = (err) => err && err.name === 'AbortError';

// The history.state key on a drawer's entry: the list address it was opened over.
const DRAWER_FROM = 'pipelineDrawerFrom';

// ---- The view ----

let current = null; // the mounted instance (update() needs it)
let panelUid = 0;

function createView(root, ctx) {
  const { nav } = ctx;
  let state = readQuery(ctx.query);
  let dead = false;

  let listCtl = null;
  let listSeq = 0;
  let listLoading = null; // the list load in flight (loadList)
  let shownPage = null; // the page on screen as JSON (null: none yet, or an error)
  const rowsByDomain = new Map(); // the rows on screen, by lowercased domain

  // ---- Header ----

  const desc = h('p', { class: 'page-desc' }, 'Every company you’ve sourced, newest first. Open one to see its contacts and outreach.');
  const findBtn = h(
    'a',
    { class: 'btn btn-secondary', href: href(['agent'], { prompt: FIND_PROMPT }) },
    'Find companies',
  );
  const head = h(
    'div',
    { class: 'page-head' },
    h('div', { class: 'page-head-text' }, h('h1', {}, TITLE), desc),
    h('div', { class: 'page-actions' }, findBtn),
  );

  // ---- Stage tabs (counts from `stages`, under q + query) ----

  let stageIds = STAGES.map((s) => s.id);
  let stageTabs = null;
  const tabsSlot = h('div', { class: 'pl-tabs' });
  // Focusable from script only: Try again parks focus here while the list it replaces reloads.
  const results = h('div', { class: 'pl-results', id: `pl-results-${++panelUid}`, role: 'tabpanel', tabindex: '-1' });

  function buildTabs(extra = []) {
    const hadFocus = stageTabs && stageTabs.contains(document.activeElement);
    stageIds = [...STAGES.map((s) => s.id), ...extra];
    stageTabs = tabs({
      label: 'Stage',
      panelId: results.id,
      active: state.stage || 'all',
      items: [{ id: 'all', label: 'All' }, ...stageIds.map((id) => ({ id, label: stageLabel(id) }))],
      onChange: (id) => nav.setQuery({ stage: id === 'all' ? null : id, page: null }),
    });
    tabsSlot.replaceChildren(stageTabs);
    if (hadFocus) {
      const sel = stageTabs.querySelector('[aria-selected="true"]');
      if (sel) sel.focus();
    }
    syncPanelLabel();
  }

  function syncPanelLabel() {
    const sel = stageTabs && stageTabs.querySelector('[aria-selected="true"]');
    if (sel) results.setAttribute('aria-labelledby', sel.id);
  }

  function renderStageCounts(stages, total) {
    const counts = new Map((stages || []).map(([s, n]) => [s, n]));
    const unknown = [...counts.keys()].filter((s) => !STAGE_BY_ID.has(s));
    if (state.stage && !STAGE_BY_ID.has(state.stage) && !unknown.includes(state.stage)) unknown.push(state.stage);
    const extra = stageIds.slice(STAGES.length);
    if (unknown.length !== extra.length || unknown.some((s, i) => s !== extra[i])) buildTabs(unknown);
    const map = { all: total };
    for (const id of stageIds) map[id] = counts.get(id) || 0;
    stageTabs.setCounts(map);
    for (const b of stageTabs.querySelectorAll('[role="tab"]')) {
      b.classList.toggle('is-zero', map[b.dataset.id] === 0);
    }
  }

  // ---- Toolbar: filter + Sourced by + clear ----

  const filter = h('input', {
    type: 'search',
    class: 'input pl-filter-input',
    'aria-label': 'Filter companies',
    placeholder: 'Filter by name, domain or contact',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    value: state.q,
  });
  const pushSearch = debounce((q) => {
    if (!dead) nav.setQuery({ q: q.trim() || null, page: null });
  }, SEARCH_MS);
  filter.addEventListener('input', () => pushSearch(filter.value));
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      pushSearch.flush();
    } else if (e.key === 'Escape' && filter.value) {
      // Esc clears the filter first; a second Esc leaves the field to the page.
      e.preventDefault();
      e.stopPropagation();
      filter.value = '';
      pushSearch('');
      pushSearch.flush();
    }
  });

  // The picker's own label stays for screen readers; the visible one sits beside the field. The
  // list opens under the input and the component keeps it inside the window (--ss-room-x). Its
  // "All sources" row is pinned (renderSources): the field shows the placeholder while it is the
  // choice, typing never matches it, and picking it again changes nothing.
  const source = searchSelect({
    label: 'Sourced by',
    hideLabel: true,
    placeholder: 'All sources',
    options: [],
    value: state.query,
    onChange: (v) => nav.setQuery({ query: v || null, page: null }),
  });
  const sourceLabel = h(
    'span',
    {
      class: 'pl-source-label',
      'aria-hidden': 'true',
      onClick: () => {
        source.input.focus();
        source.input.click();
      },
    },
    'Sourced by',
  );

  const clearBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm pl-clear', onClick: clearFilters }, 'Clear filters');

  const toolbar = h(
    'div',
    { class: 'pl-toolbar' },
    h('div', { class: 'pl-filter' }, icon('search', 15), filter),
    h('div', { class: 'pl-source' }, sourceLabel, source),
    clearBtn,
  );

  function clearFilters() {
    pushSearch.cancel();
    filter.value = '';
    nav.setQuery({ q: null, stage: null, query: null, page: null });
    filter.focus();
  }

  // How many companies "All sources" stands for, like each source's own count: every company the
  // search matches, whatever its stage or source. A page loaded without a source filter tells
  // (its stage counts add up to it); one with a source filter can't, so the last figure for the
  // same search is used, else the row shows none.
  let allSources = null; // { q, n }

  function renderSources(queries) {
    const opts = (queries || []).map(([q, n]) => ({ value: q, label: q, count: n }));
    // A source in the URL that no company has (any more) still shows what's filtered.
    if (state.query && !opts.some((o) => o.value === state.query)) opts.unshift({ value: state.query, label: state.query, count: 0 });
    const all = { value: '', label: 'All sources', pinned: true };
    if (allSources && allSources.q === state.q.trim()) all.count = allSources.n;
    source.setOptions([all, ...opts]);
    // Not while the field has focus: setOptions keeps what is being typed there, and apply()
    // has already set a choice that came from the URL.
    if (document.activeElement !== source.input) source.setValue(state.query);
  }

  // ---- Footer: pager + keyboard hint ----

  const pg = pager({ page: state.page, per: PER, total: 0, label: 'Pages', onChange: (n) => nav.setQuery({ page: n > 1 ? n : null }) });
  const hint = h(
    'p',
    { class: 'pl-hint', 'aria-hidden': 'true' },
    h('kbd', { class: 'kbd' }, 'J'),
    h('kbd', { class: 'kbd' }, 'K'),
    ' to move · ',
    h('kbd', { class: 'kbd' }, 'Enter'),
    ' to open · ',
    h('kbd', { class: 'kbd' }, '/'),
    ' to filter',
  );
  const footer = h('div', { class: 'pl-footer', hidden: true }, hint, pg);
  // The pager's range is what a screen reader hears after a search ("1–24 of 24"); with nothing
  // to show it is hidden with the footer, so this says so instead.
  const announce = h('p', { class: 'sr-only pl-announce', role: 'status' });

  const controls = h('div', { class: 'pl-controls' }, tabsSlot, toolbar);
  const container = h('div', { class: 'pipeline' }, head, controls, results, footer, announce);
  root.append(container);
  buildTabs();
  clearBtn.hidden = !filtersOn();

  // ---- The table ----

  // The row's contact is the best one with an email (server side), so a "Name only" company
  // whose founder has no email or LinkedIn has none to show: say what is known instead.
  function contactCell(r) {
    const lines = [];
    if (r.founder || r.email) {
      const name = r.founder || r.email;
      lines.push(h('span', { class: 'pl-contact-name', title: name }, name));
      const meta = [];
      if (r.email && r.founder) meta.push(h('span', { class: 'pl-contact-email mono', title: r.email }, r.email));
      if (r.linkedin) meta.push(h('span', { class: 'pl-li' }, icon('person', 12), 'LinkedIn'));
      if (meta.length) lines.push(h('span', { class: 'pl-sub' }, meta));
    } else if (r.linkedin) {
      lines.push(h('span', { class: 'pl-contact-name pl-li' }, icon('person', 13), 'LinkedIn only'));
    } else if (r.status === 'named') {
      lines.push(h('span', { class: 'pl-none' }, 'Name found, no email yet'));
    } else {
      lines.push(h('span', { class: 'pl-none' }, 'No contact yet'));
    }
    return h('div', { class: 'pl-cell-stack' }, lines);
  }

  const COLUMNS = [
    {
      key: 'company',
      label: 'Company',
      render: (r) =>
        h(
          'div',
          { class: 'pl-cell-stack' },
          h('span', { class: ['pl-company-name', !r.name && 'pl-none'], title: r.name || null }, r.name || 'Unnamed'),
          h('span', { class: 'pl-sub pl-domain mono', title: r.domain }, r.domain),
        ),
    },
    { key: 'contact', label: 'Contact', render: contactCell },
    { key: 'stage', label: 'Stage', nowrap: true, render: (r) => stageBadge(r.status) },
    {
      key: 'source',
      label: 'Sourced by',
      render: (r) =>
        r.source_query
          ? h('span', { class: 'pl-source-text', title: r.source_query }, r.source_query)
          : h('span', { class: 'pl-none' }, '—'),
    },
    {
      key: 'first_seen',
      label: 'First seen',
      nowrap: true,
      render: (r) => h('span', { class: 'pl-when mono', title: longWhen(r.first_seen) || null }, shortWhen(r.first_seen)),
    },
  ];

  const SKELETON_COLUMNS = COLUMNS.map((c, i) => ({
    ...c,
    render: () =>
      h(
        'div',
        { class: 'pl-cell-stack' },
        h('span', { class: 'skeleton', style: `width: ${[70, 60, 45, 55, 40][i]}%` }),
        i < 2 ? h('span', { class: 'skeleton pl-sk-sub', style: `width: ${[50, 75][i]}%` }) : null,
      ),
  }));

  // Every cell carries its column (pl-col-<key>): the column widths in pipeline.css hang off it.
  const colClass = (col) => `pl-col-${col.key}`;

  function setListBusy(on) {
    const t = results.querySelector('table');
    if (t) t.setAttribute('aria-busy', on ? 'true' : 'false');
    results.classList.toggle('is-loading', on);
  }

  function showSkeleton() {
    const wrap = table({
      label: 'Companies',
      columns: SKELETON_COLUMNS,
      rows: Array.from({ length: 8 }, (_, i) => ({ i })),
      rowKey: 'i',
      cellClass: colClass,
    });
    wrap.querySelector('table').setAttribute('aria-busy', 'true');
    results.replaceChildren(wrap);
    results.classList.add('is-loading');
  }

  function showError(err) {
    shownPage = null;
    results.classList.remove('is-loading');
    // The count from the last list that loaded would sit above a different, failed one.
    desc.textContent = 'Every company you’ve sourced, newest first.';
    announce.textContent = '';
    results.replaceChildren(
      errorBox('Couldn’t load companies', err, () => {
        // The button goes with the box: focus waits on the list, so Tab carries on into it.
        results.focus({ preventScroll: true });
        loadList();
      }),
    );
    footer.hidden = true;
  }

  function filtersOn() {
    return !!(state.q.trim() || state.stage || state.query);
  }

  /** The list's empty state: `workspace` (no companies at all) or `filtered` (none match). Each
   *  carries the action it hides above the list, the header's Find companies or the toolbar's
   *  Clear filters. */
  function emptyList(kind) {
    const el =
      kind === 'workspace'
        ? emptyState({
            title: 'No companies yet',
            body: 'Ask the agent to find companies that match your company profile. They land here, deduped by domain, with their contacts and outreach.',
            action: h('a', { class: 'btn btn-primary', href: href(['agent'], { prompt: FIND_PROMPT }) }, 'Find companies'),
          })
        : emptyState({
            title: 'No companies match these filters',
            body: 'Try a shorter search, another stage or source, or clear the filters.',
            action: h('button', { type: 'button', class: 'btn btn-secondary', onClick: clearFilters }, 'Clear filters'),
          });
    el.dataset.kind = kind;
    return el;
  }

  /** Show a page of the list. `keepScroll` (a reload of the same list for changes made
   *  elsewhere) leaves the table scrolled where it was, and the empty state already shown (and
   *  the focus on its action) as it is when the list is still that one: only the counts move. */
  function renderList(page, { keepScroll = false } = {}) {
    shownPage = JSON.stringify(page);
    rowsByDomain.clear();
    for (const r of page.rows) rowsByDomain.set(String(r.domain).toLowerCase(), r);
    const stagesTotal = (page.stages || []).reduce((n, [, c]) => n + c, 0);
    const workspaceEmpty = !state.q.trim() && !state.query && stagesTotal === 0;
    const empty = workspaceEmpty ? 'workspace' : page.rows.length ? null : 'filtered';
    const oldEmpty = results.querySelector('.empty-state');
    const emptyFocused = oldEmpty && oldEmpty.contains(document.activeElement) ? oldEmpty.dataset.kind : null;
    const keepEmpty = keepScroll && !!empty && !!oldEmpty && oldEmpty.dataset.kind === empty;

    controls.hidden = workspaceEmpty;
    footer.hidden = workspaceEmpty || page.total === 0;
    clearBtn.hidden = !filtersOn() || empty === 'filtered'; // the empty states carry these two
    findBtn.hidden = workspaceEmpty;
    if (workspaceEmpty) desc.textContent = 'Every company you source lands here, deduped by domain.';
    else if (filtersOn() && page.total > 0) desc.textContent = `${pluralize(page.total, 'company', 'companies')} ${page.total === 1 ? 'matches' : 'match'} these filters, newest first.`;
    else if (filtersOn()) desc.textContent = 'Every company you’ve sourced, newest first.';
    else desc.textContent = `${pluralize(page.total, 'company', 'companies')}, newest first. Open one to see its contacts and outreach.`;

    renderStageCounts(page.stages, stagesTotal);
    if (!state.query) allSources = { q: state.q.trim(), n: stagesTotal };
    renderSources(page.queries);
    pg.update({ page: page.page, per: page.per, total: page.total });

    // Re-render the same rows in place of the old table, keeping a focused row focused.
    const focusedTr = results.contains(document.activeElement) ? document.activeElement.closest('tr') : null;
    const focusedKey = focusedTr ? focusedTr.dataset.key : null;
    const focusedAt = focusedTr ? rowEls().indexOf(focusedTr) : -1;
    const oldWrap = keepScroll ? results.querySelector('.table-wrap') : null;
    const scrolled = oldWrap ? { top: oldWrap.scrollTop, left: oldWrap.scrollLeft } : null;
    // Not said again for a kept empty state: nothing the user did, and nothing new to hear.
    if (!keepEmpty) announce.textContent = empty === 'filtered' ? 'No companies match these filters' : '';

    if (empty) {
      if (!keepEmpty) results.replaceChildren(emptyList(empty));
    } else {
      const wrap = table({
        label: 'Companies',
        columns: COLUMNS,
        rows: page.rows,
        rowKey: 'domain',
        cellClass: colClass,
        onRowClick: (row, e) => openCompany(row.domain, e.currentTarget),
      });
      results.replaceChildren(wrap);
      if (scrolled) {
        wrap.scrollTop = scrolled.top;
        wrap.scrollLeft = scrolled.left;
      }
      if (drawer) {
        markRow(drawer.domain);
        const at = rowEls().indexOf(rowFor(drawer.domain));
        if (at >= 0) drawer.rowIndex = at;
      }
    }
    // A focused row that left the list (skipped, filtered out) hands focus to the row now in its
    // place, not to <body>.
    if (focusedKey && !focusRow(focusedKey)) focusListAt(focusedAt);
    else if (emptyFocused && !keepEmpty) {
      // A replaced empty state's action hands focus to the same action where it is now, so Enter
      // still does what it would have: its twin above the list, else what the list now holds.
      const twin = emptyFocused === 'filtered' ? clearBtn : findBtn;
      if (!twin.closest('[hidden]')) twin.focus();
      else focusListAt(0);
    }
    results.classList.remove('is-loading');
    setListBusy(false);
  }

  /** Load the list for the current route → a Promise that settles (never rejects) once it is
   *  shown, failed or superseded. `listLoading` holds it meanwhile, for the drawer. `quiet` (a
   *  check for changes made elsewhere): no skeleton, nothing redrawn when the page came back
   *  the same, and a failure leaves the list on screen as it is. */
  function loadList({ quiet = false } = {}) {
    const p = fetchList(quiet);
    listLoading = p;
    p.then(() => {
      if (listLoading === p) listLoading = null;
    });
    return p;
  }

  async function fetchList(quiet) {
    if (listCtl) listCtl.abort();
    const ctl = new AbortController();
    listCtl = ctl;
    const seq = ++listSeq;
    const want = { ...state };
    // Rows on screen stay (marked busy) while the next page loads; anything else becomes a
    // skeleton (first load, or after an empty / error state), unless the load is quiet.
    const shown = results.querySelector('table');
    if (shown && shown.getAttribute('aria-busy') !== 'true') setListBusy(true);
    else if (!shown && !quiet) showSkeleton();

    const qs = new URLSearchParams({ per: String(PER) });
    if (want.q.trim()) qs.set('q', want.q.trim());
    if (want.stage) qs.set('stage', want.stage);
    if (want.query) qs.set('query', want.query);
    if (want.page > 1) qs.set('page', String(want.page));
    try {
      const page = await api.get(`/api/companies?${qs}`, { signal: ctl.signal });
      if (dead || seq !== listSeq) return;
      listCtl = null;
      // Past the last page (a stale link, or rows skipped away): go to the last one.
      const last = Math.max(1, Math.ceil(page.total / PER));
      if (!page.rows.length && page.total > 0 && want.page > last) {
        nav.setQuery({ page: last > 1 ? last : null });
        return;
      }
      if (quiet && JSON.stringify(page) === shownPage) setListBusy(false);
      else renderList(page, { keepScroll: quiet });
    } catch (err) {
      if (dead || seq !== listSeq || isAbort(err)) return;
      listCtl = null;
      if (quiet) setListBusy(false);
      else showError(err);
    }
  }

  // ---- Rows: focus, selection, J/K ----

  const rowEls = () => [...results.querySelectorAll('tbody tr.is-clickable')];
  const rowFor = (domain) => rowEls().find((tr) => String(tr.dataset.key).toLowerCase() === String(domain).toLowerCase());

  function focusRow(domain) {
    const tr = rowFor(domain);
    if (tr) tr.focus({ preventScroll: false });
    return !!tr;
  }

  /** Focus the row at `index` (the last one if the list got shorter), else the empty state's
   *  action. → whether anything took focus. */
  function focusListAt(index) {
    const list = rowEls();
    if (list.length) {
      list[Math.max(0, Math.min(index, list.length - 1))].focus();
      return true;
    }
    const action = results.querySelector('.empty-state .btn');
    if (action) action.focus();
    return !!action;
  }

  function markRow(domain) {
    for (const tr of rowEls()) {
      const on = domain && String(tr.dataset.key).toLowerCase() === String(domain).toLowerCase();
      tr.classList.toggle('is-selected', !!on);
      if (on) tr.setAttribute('aria-current', 'true');
      else tr.removeAttribute('aria-current');
    }
  }

  function moveRow(delta) {
    const list = rowEls();
    if (!list.length) return false;
    const at = list.indexOf(document.activeElement && document.activeElement.closest ? document.activeElement.closest('tr') : null);
    const i = at < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, at + delta));
    list[i].focus();
    return true;
  }

  const unbindKeys = bindKeys({
    j: () => moveRow(1),
    k: () => moveRow(-1),
    '/': () => {
      if (controls.hidden) return false;
      filter.focus();
      filter.select();
      return true;
    },
  });

  // ---- The drawer ----

  // The open drawer: { domain, hash, pushedFrom, rowIndex, handle, ctl, company, detail }.
  let drawer = null;
  let detailSeq = 0;
  // Handed from a row press (openCompany) to the drawer the route change opens (syncDrawer).
  let pendingOpener = null;
  let pushedFrom = null;

  /** A row press: push the drawer route (Back closes it again). */
  function openCompany(domain, opener) {
    // Typing just before the press: apply it now, so the drawer route carries it and the
    // debounced search doesn't fire later behind the drawer.
    pushSearch.flush();
    const target = href(['pipeline', domain], listQuery(state));
    const from = location.hash;
    pendingOpener = opener || null;
    pushedFrom = from;
    nav.navigate(target);
    // The new entry remembers the list it was pushed over, so closing the drawer can go Back to
    // it even after the screen is mounted afresh on that entry (Back from another screen).
    if (location.hash === target) history.replaceState({ ...(history.state || {}), [DRAWER_FROM]: from }, '', location.href);
  }

  /** Is `hash` this list as it stands now (the same filters, in any order)? */
  function isListNow(hash) {
    if (!hash) return false;
    const { path, query } = parseHash(hash);
    return path.length === 1 && path[0] === 'pipeline' && sameList(readQuery(query), state);
  }

  function closeDrawer() {
    if (!drawer) return;
    const d = drawer;
    drawer = null;
    if (d.ctl) d.ctl.abort();
    d.handle.close('api');
    markRow(null);
  }

  // The user closed it (Esc, ×, backdrop, ⌘K, a link inside): put the list back in the URL.
  function onUserClose(d) {
    if (d.ctl) d.ctl.abort();
    markRow(null);
    // Pushed over this very list (the filters may sit in another order in its address): go Back
    // to that entry rather than adding another, so the next Back leaves the Pipeline.
    const from = d.pushedFrom || (history.state && history.state[DRAWER_FROM]) || null;
    if (location.hash === d.hash && isListNow(from)) {
      history.back();
    } else if (parseDomain() === d.domain) {
      nav.navigate(href(['pipeline'], listQuery(state)), { replace: true });
    }
    // Focus the row it came from (the table may have been re-rendered meanwhile); if that row
    // has left the list (skipped under a stage filter), the row now in its place. A deep link
    // to a company that was never on screen leaves focus on the page.
    const active = document.activeElement;
    if (!active || active === document.body || active.id === 'view' || !active.isConnected) {
      if (!focusRow(d.domain) && d.rowIndex != null) focusListAt(d.rowIndex);
    }
  }

  function parseDomain() {
    const m = location.hash.match(/^#\/pipeline\/([^?]+)/);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]).toLowerCase();
    } catch (_) {
      return m[1].toLowerCase();
    }
  }

  function rowIndexOf(domain) {
    const at = rowEls().indexOf(rowFor(domain));
    return at >= 0 ? at : null;
  }

  function syncDrawer(domain) {
    const want = domain ? String(domain).toLowerCase() : null;
    if (!want) {
      closeDrawer();
      return;
    }
    if (drawer && drawer.domain === want) return;
    const opener = pendingOpener && pendingOpener.isConnected ? pendingOpener : rowFor(want) || null;
    const from = pushedFrom;
    pendingOpener = null;
    pushedFrom = null;
    if (drawer) {
      // Another company while one is open (e.g. back/forward between two): reuse the panel.
      // loadDetail aborts whatever the panel was still loading for the previous one.
      drawer.domain = want;
      drawer.hash = location.hash;
      drawer.pushedFrom = from;
      drawer.rowIndex = rowIndexOf(want);
      drawer.company = rowsByDomain.get(want) || null;
      drawer.detail = null;
      drawer.handle.setTitle(displayName(drawer.company, want));
      markRow(want);
      loadDetail();
      return;
    }
    const d = {
      domain: want,
      hash: location.hash,
      pushedFrom: from,
      rowIndex: rowIndexOf(want),
      company: rowsByDomain.get(want) || null,
      detail: null,
      ctl: null,
    };
    d.handle = openDrawer({
      title: displayName(d.company, want),
      content: null,
      opener,
      onClose: (reason) => {
        if (reason === 'api') return;
        if (drawer === d) drawer = null;
        onUserClose(d);
      },
    });
    d.handle.el.classList.add('company-drawer');
    drawer = d;
    markRow(want);
    loadDetail();
  }

  /** Is `domain` a company? Answered from a search for it, so an unknown link shows "not found"
   *  without a failed (404) request: the browser logs every 404 as a console error, and the e2e
   *  suite fails on those. null = can't tell. */
  async function lookup(domain, signal) {
    const qs = new URLSearchParams({ q: domain, per: String(LOOKUP_PER) });
    const page = await api.get(`/api/companies?${qs}`, { signal });
    const row = (page.rows || []).find((r) => String(r.domain).toLowerCase() === domain);
    if (row) return row;
    return page.total <= (page.rows || []).length ? false : null;
  }

  /**
   * Load the drawer's company. `refresh` re-reads it after a change (Skip / Restore) with the
   * current content left up, and `focusAction` then puts focus back on the action slot. `quiet`
   * (with refresh: a check for changes made elsewhere) redraws only if the company changed,
   * keeps focus on the same control where it can, and leaves the drawer as it is on a failure.
   * Every load runs under the drawer's AbortController, so moving the drawer to another company
   * (or closing it) drops whatever was still on its way for this one.
   */
  async function loadDetail({ refresh = false, focusAction = false, quiet = false } = {}) {
    const d = drawer;
    if (!d) return;
    if (d.ctl) d.ctl.abort();
    const ctl = new AbortController();
    d.ctl = ctl;
    const seq = ++detailSeq;
    const domain = d.domain;
    const fresh = () => !dead && drawer === d && d.domain === domain && seq === detailSeq;
    if (!refresh) renderDrawerLoading(d);
    try {
      if (!refresh && !d.company) {
        // A deep link while the list is still loading: that page may well have the company.
        if (listLoading) {
          await listLoading;
          if (!fresh()) return;
        }
        const found = rowsByDomain.get(domain) || (await lookup(domain, ctl.signal));
        if (!fresh()) return;
        if (found === false) {
          d.ctl = null;
          renderNotFound(d);
          return;
        }
        if (found) {
          d.company = found;
          d.handle.setTitle(displayName(found, domain));
          renderDrawerLoading(d);
        }
      }
      const detail = await api.get(`/api/companies/${encodeURIComponent(domain)}`, { signal: ctl.signal });
      if (!fresh()) return;
      d.ctl = null;
      if (quiet && JSON.stringify(detail) === JSON.stringify(d.detail)) return;
      const had = quiet && d.handle.body.contains(document.activeElement) ? document.activeElement : null;
      d.detail = detail;
      d.company = detail.company;
      d.handle.setTitle(displayName(detail.company, domain));
      renderDetail(d);
      if (focusAction) {
        const next = d.handle.el.querySelector('.cd-actions .btn:last-child') || d.handle.el;
        next.focus({ preventScroll: true });
      } else if (had) {
        // The same control in the redrawn drawer (by what it says and where it goes), else the
        // drawer's body: focus never drops out of the dialog.
        const same = [...d.handle.body.querySelectorAll(had.tagName)].find(
          (el) => el.textContent === had.textContent && el.getAttribute('href') === had.getAttribute('href'),
        );
        if (!same) d.handle.body.tabIndex = -1;
        (same || d.handle.body).focus({ preventScroll: true });
      }
    } catch (err) {
      if (!fresh() || isAbort(err)) return;
      d.ctl = null;
      if (quiet) return;
      if (err && err.status === 404) renderNotFound(d);
      else renderDrawerError(d, err);
    }
  }

  function drawerTop(d, company) {
    const url = siteUrl(company ? company.domain : d.domain);
    return h(
      'div',
      { class: 'cd-top' },
      url ? externalLink(url, company ? company.domain : d.domain, 'cd-site mono') : h('span', { class: 'cd-site mono' }, d.domain),
      company ? stageBadge(company.status, 'cd-stage') : null,
    );
  }

  function skeletonLines(n) {
    return Array.from({ length: n }, (_, i) => h('span', { class: 'skeleton', style: `width: ${[64, 88, 48, 72][i % 4]}%` }));
  }

  function renderDrawerLoading(d) {
    d.handle.body.setAttribute('aria-busy', 'true');
    d.handle.body.replaceChildren(
      drawerTop(d, d.company),
      h(
        'div',
        { class: 'cd-loading', 'aria-busy': 'true' },
        h('span', { class: 'sr-only' }, 'Loading company'),
        h('div', { class: 'cd-section' }, h('span', { class: 'skeleton cd-sk-head' }), ...skeletonLines(3)),
        h('div', { class: 'cd-section' }, h('span', { class: 'skeleton cd-sk-head' }), ...skeletonLines(2)),
      ),
    );
  }

  function renderNotFound(d) {
    d.handle.body.removeAttribute('aria-busy');
    d.handle.setTitle(d.domain);
    // An h3 under the drawer's own h2 title.
    d.handle.body.replaceChildren(
      emptyState({
        level: 3,
        title: `No company at ${d.domain}`,
        body: 'It isn’t in this workspace. The link may have a typo, or the company was never sourced here.',
        action: h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => d.handle.close('button') }, 'Back to Pipeline'),
      }),
    );
  }

  function renderDrawerError(d, err) {
    d.handle.body.removeAttribute('aria-busy');
    const retry = () => {
      // The button goes with the box: focus waits on the drawer's body (inside the dialog), so
      // Tab carries on into what loads there.
      d.handle.body.tabIndex = -1;
      d.handle.body.focus({ preventScroll: true });
      loadDetail();
    };
    d.handle.body.replaceChildren(drawerTop(d, d.company), errorBox('Couldn’t load this company', err, retry));
  }

  /** The drawer's actions, and a line on why Skip isn't one of them while a draft waits. */
  function actionsFor(d, company) {
    const st = company.status;
    const before = st === 'sourced' || st === 'named' || st === 'emailed'; // nothing sent yet
    // Writing a draft doesn't move the company's stage, so a "Contact found" company (or any
    // other) can have one waiting in Drafts: reviewing it there is the next step. Asking the
    // agent again would replace it and any edits made to it, and a Skip here would leave it
    // queued to send; Discard in Drafts drops the draft and skips the company in one go.
    const waiting = ((d.detail && d.detail.outreach) || []).filter((o) => o.status === 'draft_pending' || o.status === 'drafted').length;
    const ask = (mode, primary) =>
      h(
        'button',
        {
          type: 'button',
          class: ['btn', primary ? 'btn-primary' : 'btn-secondary'],
          onClick: () => nav.navigate(href(['agent'], { prompt: askPrompt(mode, company) })),
        },
        mode === 'draft' ? 'Ask agent to draft' : 'Ask agent to enrich',
      );
    // Sent, replied, bounced or a status this screen doesn't know: its history is in
    // Follow-ups. A sent company may be Due or Awaiting there; the filter finds it in either.
    const followups = (primary) =>
      h(
        'a',
        {
          class: ['btn', primary ? 'btn-primary' : 'btn-secondary'],
          href: href(['followups'], { tab: st === 'replied' || st === 'bounced' ? st : null, q: company.domain }),
        },
        'Open in Follow-ups',
      );
    const out = [];
    if (waiting || st === 'drafted') {
      out.push(h('a', { class: 'btn btn-primary', href: href(['drafts', company.domain]) }, 'Open in Drafts'));
      if (!before && st !== 'drafted' && st !== 'skip') out.push(followups(false));
    } else if (st === 'sourced' || st === 'named') out.push(ask('enrich', true));
    else if (st === 'emailed') out.push(ask('draft', true));
    else if (st !== 'skip') out.push(followups(true));
    if (st === 'skip') out.push(statusButton(d, company, 'restore'));
    else if (before && !waiting) out.push(statusButton(d, company, 'skip'));
    if (!out.length) return null;

    const actions = h('div', { class: 'cd-actions' }, out);
    const its = waiting > 1 ? 'Its drafts are' : 'Its draft is';
    const them = waiting > 1 ? 'them' : 'it';
    let note = null;
    if (waiting && before) note = `${its} waiting in Drafts. To skip this company, discard ${them} there.`;
    else if (waiting && st === 'skip') note = `${its} still waiting in Drafts and can be sent from there.`;
    return note ? [actions, h('p', { class: 'cd-note' }, note)] : actions;
  }

  function statusButton(d, company, value) {
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-secondary',
        onClick: async () => {
          if (isBusy(btn)) return;
          // Busy, not disabled: the button keeps focus while the change is saved.
          setBusy(btn, true);
          const domain = d.domain;
          const name = displayName(company, domain);
          // The toast and the store are the app's: the outcome is told even when the screen has
          // been left meanwhile. Only the screen's own refresh needs it still mounted.
          try {
            await api.post(`/api/companies/${encodeURIComponent(company.domain)}/status`, { value });
            toast(value === 'skip' ? `Skipped ${name}. It won’t be contacted.` : `Restored ${name} to the pipeline.`, 'ok');
            ctx.store.refresh();
            if (dead) return;
            loadList();
            // Re-read it unless the drawer has moved on to another company meanwhile.
            if (drawer === d && d.domain === domain) {
              loadDetail({ refresh: true, focusAction: d.handle.el.contains(document.activeElement) });
            }
          } catch (err) {
            if (!dead) setBusy(btn, false);
            toast(`Couldn’t ${value === 'skip' ? 'skip' : 'restore'} ${name}: ${errorText(err)}`, 'err');
          }
        },
      },
      value === 'skip' ? 'Skip' : 'Restore',
    );
    return btn;
  }

  function contactItem(k) {
    const name = k.founder_name || 'Name not on file';
    const email = k.email
      ? h(
          'div',
          { class: 'cd-email' },
          icon('mail', 13),
          // On a narrow drawer the badges wrap together, under the address.
          h(
            'div',
            { class: 'cd-email-main' },
            h('span', { class: 'mono cd-email-addr' }, k.email),
            h(
              'span',
              { class: 'cd-badges' },
              k.email_confidence
                ? h('span', { class: 'cd-conf', title: CONFIDENCE_HINT[k.email_confidence] || null }, badge(CONFIDENCE[k.email_confidence] || k.email_confidence, 'neutral'))
                : null,
              k.mx_ok ? badge('MX ok', 'ok') : badge('No MX', 'warn'),
            ),
          ),
        )
      : h('div', { class: 'cd-email cd-muted' }, icon('mail', 13), h('span', {}, 'No email'));
    const li = safeUrl(k.linkedin_url);
    return h(
      'li',
      { class: 'cd-item' },
      h('div', { class: 'cd-item-head' }, h('span', { class: ['cd-name', !k.founder_name && 'cd-muted'] }, name), k.role ? h('span', { class: 'cd-role' }, k.role) : null),
      email,
      li ? h('div', { class: 'cd-li' }, icon('person', 13), externalLink(li, 'LinkedIn profile')) : null,
    );
  }

  function outreachItem(o) {
    const [label, tone] = OUTREACH[o.status] || [o.status, 'neutral'];
    const channel = o.channel === 'linkedin' ? 'LinkedIn' : 'Email';
    const subject = o.channel === 'linkedin' ? 'Connection note' : o.subject || '(no subject)';
    const dates = [];
    if (o.created_at) dates.push(h('span', { title: longWhen(o.created_at) || null }, `Created ${fmtRelative(o.created_at)}`));
    if (o.sent_at) dates.push(h('span', { title: longWhen(o.sent_at) || null }, `Sent ${fmtRelative(o.sent_at)}`));
    return h(
      'li',
      { class: 'cd-item' },
      h(
        'div',
        { class: 'cd-item-head' },
        h('span', { class: 'cd-channel' }, icon(o.channel === 'linkedin' ? 'person' : 'mail', 13), channel),
        badge(label, tone),
      ),
      h('div', { class: ['cd-subject', !o.subject && o.channel !== 'linkedin' && 'cd-muted'] }, subject),
      dates.length ? h('div', { class: 'cd-dates mono' }, dates.flatMap((el, i) => (i ? [h('span', { 'aria-hidden': 'true' }, '·'), el] : [el]))) : null,
    );
  }

  function section(title, count, listLabel, items, empty) {
    const id = `cd-${listLabel.toLowerCase()}-${detailSeq}`;
    return h(
      'section',
      { class: 'cd-section', 'aria-labelledby': id },
      h('h3', { class: 'cd-section-title', id }, title, count ? h('span', { class: 'cd-count' }, fmtNum(count)) : null),
      items.length ? h('ul', { class: 'cd-list', 'aria-label': listLabel }, items) : h('p', { class: 'cd-empty' }, empty),
    );
  }

  function renderDetail(d) {
    const { company, contacts = [], outreach = [] } = d.detail;
    d.handle.body.removeAttribute('aria-busy');
    // "2h ago" within 48h (the exact time on hover), else the date and time.
    const seen = fmtRelative(company.first_seen);
    const seenAt = longWhen(company.first_seen);
    const details = h(
      'dl',
      { class: 'cd-details' },
      h('div', {}, h('dt', {}, 'Sourced by'), h('dd', {}, company.source_query || '—')),
      h('div', {}, h('dt', {}, 'First seen'), h('dd', { class: 'mono', title: seenAt && seenAt !== seen ? seenAt : null }, seen)),
    );
    d.handle.body.replaceChildren(
      h('div', { class: 'cd-head' }, drawerTop(d, company), actionsFor(d, company)),
      section('Contacts', contacts.length, 'Contacts', contacts.map(contactItem), 'No contacts yet. Ask the agent to enrich this company to find a founder.'),
      section('Outreach', outreach.length, 'Outreach', outreach.map(outreachItem), 'Nothing drafted or sent yet.'),
      h('section', { class: 'cd-section', 'aria-label': 'Details' }, h('h3', { class: 'cd-section-title' }, 'Details'), details),
    );
  }

  // ---- Routing ----

  function apply(c) {
    const next = readQuery(c.query);
    const domain = c.path[1] || null;
    const listChanged = !sameList(next, state);
    state = next;
    if (listChanged) {
      // Typing is the source of truth while the field has focus.
      if (document.activeElement !== filter && filter.value.trim() !== state.q.trim()) filter.value = state.q;
      clearBtn.hidden = !filtersOn();
      stageTabs.setActive(state.stage || 'all');
      syncPanelLabel();
      source.setValue(state.query);
      loadList();
    }
    syncDrawer(domain);
  }

  // ---- Changes made elsewhere ----

  // A scheduled run or an agent turn sources, enriches, drafts or sends while the list is open.
  // Each moves the shared summary (its counts and funnel, the last run, the chat running), so
  // when a store refresh brings a different one the list is asked again, quietly: the rows stay
  // up under the busy bar, focus and scroll stay put, and nothing is redrawn if the page came
  // back the same. Skip / Restore here don't move the summary; they reload the list themselves.
  const summaryKey = (sum) => (sum ? JSON.stringify([sum.counts, sum.funnel, sum.last_run, sum.running]) : null);
  let summarySeen = summaryKey(ctx.store.get().summary);
  const unsubscribe = ctx.store.subscribe(({ summary }) => {
    const key = summaryKey(summary);
    // Not while a load is on its way, nor over a failed one (Try again is the user's): the
    // change is still unseen on the next refresh.
    if (dead || key == null || key === summarySeen || listLoading || shownPage == null) return;
    summarySeen = key;
    loadList({ quiet: true });
    // The open drawer too (a draft may have been written for its company): once it has loaded,
    // and not while it is re-reading after a Skip / Restore.
    if (drawer && drawer.detail && !drawer.ctl) loadDetail({ refresh: true, quiet: true });
  });

  loadList();
  syncDrawer(ctx.path[1] || null);

  return {
    update(c) {
      if (dead) return false;
      apply(c);
      return true;
    },
    unmount() {
      dead = true;
      unsubscribe();
      pushSearch.cancel();
      unbindKeys();
      if (listCtl) listCtl.abort();
      closeDrawer();
    },
  };
}

export default {
  title: TITLE,
  css: true,
  mount(root, ctx) {
    const v = createView(root, ctx);
    current = v;
    return () => {
      v.unmount();
      if (current === v) current = null;
    };
  },
  update(ctx) {
    return current ? current.update(ctx) : false;
  },
};

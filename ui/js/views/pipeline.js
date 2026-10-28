// Pipeline (spec §5.3): every sourced company in a server-paged table (50 a page) with a
// debounced search, stage tabs and a "Sourced by" picker, all mirrored in the URL
// (#/pipeline?q=&stage=&query=&page=). #/pipeline/<domain> opens the company drawer: website,
// stage, contacts, outreach history and source, with Ask agent (prefills Agent, never sends)
// and Skip / Restore (POST /api/companies/:domain/status).
//
// The URL is the single source of truth: controls only call nav.setQuery / nav.navigate, and
// update(ctx) applies whatever the address now says (typing, tabs, pager, back/forward, deep
// links). Every dynamic string reaches the page through h() / textContent.

import { api } from '../core/api.js';
import { debounce, fmtDate, fmtNum, fmtRelative, h, pluralize, safeUrl, toDate } from '../core/dom.js';
import { bindKeys } from '../core/keys.js';
import { href } from '../core/router.js';
import { openDrawer, toast } from '../core/ui.js';
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
const errText = (err) => (err && err.message) || String(err);

// ---- The view ----

let current = null; // the mounted instance (update() needs it)
let panelUid = 0;

function createView(root, ctx) {
  const { nav } = ctx;
  let state = readQuery(ctx.query);
  let dead = false;

  let listCtl = null;
  let listSeq = 0;
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
  const results = h('div', { class: 'pl-results', id: `pl-results-${++panelUid}`, role: 'tabpanel' });

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

  // The picker's own label stays for screen readers; the visible one sits beside the field
  // (so the listbox lines up under the input, not the label).
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

  // Long source queries widen the list, but never past the window's right edge.
  const fitSourceList = () => {
    const r = source.getBoundingClientRect();
    if (!r.width) return;
    const room = document.documentElement.clientWidth - r.left - 16;
    source.style.setProperty('--pl-list-max', `${Math.round(Math.max(r.width, Math.min(440, room)))}px`);
  };
  source.input.addEventListener('focus', fitSourceList);
  source.input.addEventListener('pointerdown', fitSourceList);
  window.addEventListener('resize', fitSourceList);

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

  function renderSources(queries) {
    const opts = (queries || []).map(([q, n]) => ({ value: q, label: q, count: n }));
    // A source in the URL that no company has (any more) still shows what's filtered.
    if (state.query && !opts.some((o) => o.value === state.query)) opts.unshift({ value: state.query, label: state.query, count: 0 });
    source.setOptions(opts);
    source.setValue(state.query);
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

  const controls = h('div', { class: 'pl-controls' }, tabsSlot, toolbar);
  const container = h('div', { class: 'pipeline' }, head, controls, results, footer);
  root.append(container);
  buildTabs();
  clearBtn.hidden = !filtersOn();

  // ---- The table ----

  function contactCell(r) {
    const lines = [];
    if (r.founder || r.email) {
      lines.push(h('span', { class: 'pl-contact-name' }, r.founder || r.email));
      const meta = [];
      if (r.email && r.founder) meta.push(h('span', { class: 'pl-contact-email mono' }, r.email));
      if (r.linkedin) meta.push(h('span', { class: 'pl-li' }, icon('person', 12), 'LinkedIn'));
      if (meta.length) lines.push(h('span', { class: 'pl-sub' }, meta));
    } else if (r.linkedin) {
      lines.push(h('span', { class: 'pl-contact-name pl-li' }, icon('person', 13), 'LinkedIn only'));
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
          h('span', { class: ['pl-company-name', !r.name && 'pl-none'] }, r.name || 'Unnamed'),
          h('span', { class: 'pl-sub pl-domain mono' }, r.domain),
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

  function setBusy(on) {
    const t = results.querySelector('table');
    if (t) t.setAttribute('aria-busy', on ? 'true' : 'false');
    results.classList.toggle('is-loading', on);
  }

  function showSkeleton() {
    const wrap = table({ label: 'Companies', columns: SKELETON_COLUMNS, rows: Array.from({ length: 8 }, (_, i) => ({ i })), rowKey: 'i' });
    wrap.querySelector('table').setAttribute('aria-busy', 'true');
    results.replaceChildren(wrap);
    results.classList.add('is-loading');
  }

  function showError(err) {
    results.classList.remove('is-loading');
    results.replaceChildren(
      h(
        'div',
        { class: 'pl-error', role: 'alert' },
        icon('alert', 18),
        h(
          'div',
          { class: 'pl-error-text' },
          h('p', { class: 'pl-error-title' }, 'Couldn’t load companies'),
          h('p', { class: 'pl-error-msg' }, errText(err)),
        ),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: () => loadList() }, 'Try again'),
      ),
    );
    footer.hidden = true;
  }

  function filtersOn() {
    return !!(state.q.trim() || state.stage || state.query);
  }

  function renderList(page) {
    rowsByDomain.clear();
    for (const r of page.rows) rowsByDomain.set(String(r.domain).toLowerCase(), r);
    const stagesTotal = (page.stages || []).reduce((n, [, c]) => n + c, 0);
    const workspaceEmpty = !state.q.trim() && !state.query && stagesTotal === 0;

    controls.hidden = workspaceEmpty;
    footer.hidden = workspaceEmpty || page.total === 0;
    clearBtn.hidden = !filtersOn();
    findBtn.hidden = workspaceEmpty; // the empty state carries the same action
    if (workspaceEmpty) desc.textContent = 'Every company you source lands here, deduped by domain.';
    else if (filtersOn() && page.total > 0) desc.textContent = `${pluralize(page.total, 'company', 'companies')} ${page.total === 1 ? 'matches' : 'match'} these filters, newest first.`;
    else if (filtersOn()) desc.textContent = 'Every company you’ve sourced, newest first.';
    else desc.textContent = `${pluralize(page.total, 'company', 'companies')}, newest first. Open one to see its contacts and outreach.`;

    renderStageCounts(page.stages, stagesTotal);
    renderSources(page.queries);
    pg.update({ page: page.page, per: page.per, total: page.total });

    // Re-render the same rows in place of the old table, keeping a focused row focused.
    const focusedKey = document.activeElement && document.activeElement.closest && results.contains(document.activeElement)
      ? (document.activeElement.closest('tr') || {}).dataset?.key
      : null;

    if (workspaceEmpty) {
      results.replaceChildren(
        emptyState({
          title: 'No companies yet',
          body: 'Ask the agent to find companies that match your company profile. They land here, deduped by domain, with their contacts and outreach.',
          action: h('a', { class: 'btn btn-primary', href: href(['agent'], { prompt: FIND_PROMPT }) }, 'Find companies'),
        }),
      );
    } else if (!page.rows.length) {
      clearBtn.hidden = true; // the empty state carries it
      results.replaceChildren(
        emptyState({
          title: 'No companies match these filters',
          body: 'Try a shorter search, another stage or source, or clear the filters.',
          action: h('button', { type: 'button', class: 'btn btn-secondary', onClick: clearFilters }, 'Clear filters'),
        }),
      );
    } else {
      const wrap = table({
        label: 'Companies',
        columns: COLUMNS,
        rows: page.rows,
        rowKey: 'domain',
        onRowClick: (row, e) => openCompany(row.domain, e.currentTarget),
      });
      results.replaceChildren(wrap);
      if (drawer) markRow(drawer.domain);
      // A focused row that left the list hands focus to the first row, not to <body>.
      if (focusedKey && !focusRow(focusedKey)) {
        const first = rowEls()[0];
        if (first) first.focus();
      }
    }
    results.classList.remove('is-loading');
    setBusy(false);
  }

  async function loadList() {
    if (listCtl) listCtl.abort();
    const ctl = new AbortController();
    listCtl = ctl;
    const seq = ++listSeq;
    const want = { ...state };
    // Rows on screen stay (marked busy) while the next page loads; anything else becomes a
    // skeleton (first load, or after an empty / error state).
    const shown = results.querySelector('table');
    if (shown && shown.getAttribute('aria-busy') !== 'true') setBusy(true);
    else if (!shown) showSkeleton();

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
      renderList(page);
    } catch (err) {
      if (dead || seq !== listSeq || isAbort(err)) return;
      listCtl = null;
      showError(err);
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

  // The open drawer: { domain, hash, pushedFrom, handle, ctl, company, detail }.
  let drawer = null;
  let detailSeq = 0;

  /** A row press: push the drawer route (Back closes it again). */
  function openCompany(domain, opener) {
    const target = href(['pipeline', domain], listQuery(state));
    pendingOpener = opener || null;
    pushedFrom = location.hash;
    nav.navigate(target);
  }
  let pendingOpener = null;
  let pushedFrom = null;

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
    const listHash = href(['pipeline'], listQuery(state));
    if (d.pushedFrom === listHash && location.hash === d.hash) {
      history.back();
    } else if (parseDomain() === d.domain) {
      nav.navigate(listHash, { replace: true });
    }
    // Focus the row it came from (the table may have been re-rendered meanwhile).
    const active = document.activeElement;
    if (!active || active === document.body || active.id === 'view' || !active.isConnected) focusRow(d.domain);
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
      if (drawer.ctl) drawer.ctl.abort();
      drawer.domain = want;
      drawer.hash = location.hash;
      drawer.pushedFrom = from;
      drawer.company = rowsByDomain.get(want) || null;
      drawer.detail = null;
      drawer.handle.setTitle(displayName(drawer.company, want));
      markRow(want);
      loadDetail();
      return;
    }
    const d = { domain: want, hash: location.hash, pushedFrom: from, company: rowsByDomain.get(want) || null, detail: null, ctl: null };
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
    // ⌘K is global search: it closes the drawer so the (modal-inert) top bar can take focus.
    d.handle.el.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'k') d.handle.close('shortcut');
    });
    drawer = d;
    markRow(want);
    loadDetail();
  }

  /** Is `domain` a company? Answered from the rows on screen, else a search for it, so an
   *  unknown link shows "not found" without a failed (404) request. null = can't tell. */
  async function lookup(domain, signal) {
    const known = rowsByDomain.get(domain);
    if (known) return known;
    const qs = new URLSearchParams({ q: domain, per: String(LOOKUP_PER) });
    const page = await api.get(`/api/companies?${qs}`, { signal });
    const row = (page.rows || []).find((r) => String(r.domain).toLowerCase() === domain);
    if (row) return row;
    return page.total <= (page.rows || []).length ? false : null;
  }

  async function loadDetail() {
    const d = drawer;
    if (!d) return;
    if (d.ctl) d.ctl.abort();
    const ctl = new AbortController();
    d.ctl = ctl;
    const seq = ++detailSeq;
    const domain = d.domain;
    const fresh = () => !dead && drawer === d && d.domain === domain && seq === detailSeq;
    renderDrawerLoading(d);
    try {
      let company = d.company;
      if (!company) {
        const found = await lookup(domain, ctl.signal);
        if (!fresh()) return;
        if (found === false) {
          renderNotFound(d);
          return;
        }
        if (found) {
          company = found;
          d.company = found;
          d.handle.setTitle(displayName(found, domain));
          renderDrawerLoading(d);
        }
      }
      const detail = await api.get(`/api/companies/${encodeURIComponent(domain)}`, { signal: ctl.signal });
      if (!fresh()) return;
      d.ctl = null;
      d.detail = detail;
      d.company = detail.company;
      d.handle.setTitle(displayName(detail.company, domain));
      renderDetail(d);
    } catch (err) {
      if (!fresh() || isAbort(err)) return;
      d.ctl = null;
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
    // The empty-state look, with an h3 under the drawer's h2 title.
    d.handle.body.replaceChildren(
      h(
        'div',
        { class: 'empty-state' },
        h('h3', { class: 'empty-title' }, `No company at ${d.domain}`),
        h('p', { class: 'empty-body' }, 'It isn’t in this workspace. The link may have a typo, or the company was never sourced here.'),
        h('div', { class: 'empty-action' }, h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => d.handle.close('button') }, 'Back to pipeline')),
      ),
    );
  }

  function renderDrawerError(d, err) {
    d.handle.body.removeAttribute('aria-busy');
    d.handle.body.replaceChildren(
      drawerTop(d, d.company),
      h(
        'div',
        { class: 'pl-error', role: 'alert' },
        icon('alert', 18),
        h('div', { class: 'pl-error-text' }, h('p', { class: 'pl-error-title' }, 'Couldn’t load this company'), h('p', { class: 'pl-error-msg' }, errText(err))),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: () => loadDetail() }, 'Try again'),
      ),
    );
  }

  function actionsFor(d, company) {
    const st = company.status;
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
    const out = [];
    if (st === 'sourced' || st === 'named') out.push(ask('enrich', true));
    else if (st === 'emailed') out.push(ask('draft', true));
    else if (st === 'drafted') out.push(h('a', { class: 'btn btn-primary', href: href(['drafts', company.domain]) }, 'Open in Drafts'));
    else if (st === 'sent' || st === 'replied' || st === 'bounced') {
      const tab = st === 'replied' || st === 'bounced' ? st : null;
      out.push(h('a', { class: 'btn btn-primary', href: href(['followups'], { tab }) }, 'Open in Follow-ups'));
    }
    if (st === 'skip') out.push(statusButton(d, company, 'restore'));
    else if (st === 'sourced' || st === 'named' || st === 'emailed') out.push(statusButton(d, company, 'skip'));
    return out.length ? h('div', { class: 'cd-actions' }, out) : null;
  }

  function statusButton(d, company, value) {
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-secondary',
        onClick: async () => {
          if (btn.disabled) return;
          btn.disabled = true;
          btn.setAttribute('aria-busy', 'true');
          const name = displayName(company, d.domain);
          try {
            await api.post(`/api/companies/${encodeURIComponent(company.domain)}/status`, { value });
            if (dead) return;
            toast(value === 'skip' ? `Skipped ${name}. It won’t be contacted.` : `Restored ${name} to the pipeline.`, 'ok');
            ctx.store.refresh();
            loadList();
            if (drawer === d) {
              d.company = null;
              await refreshDetail(d);
            }
          } catch (err) {
            if (dead) return;
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            toast(errText(err), 'err');
          }
        },
      },
      value === 'skip' ? 'Skip' : 'Restore',
    );
    return btn;
  }

  /** Re-read the drawer's company after a change, keeping focus on the same action slot. */
  async function refreshDetail(d) {
    const hadFocus = d.handle.el.contains(document.activeElement);
    try {
      const detail = await api.get(`/api/companies/${encodeURIComponent(d.domain)}`);
      if (dead || drawer !== d) return;
      d.detail = detail;
      d.company = detail.company;
      renderDetail(d);
      if (hadFocus) {
        const next = d.handle.el.querySelector('.cd-actions .btn:last-child') || d.handle.el;
        next.focus({ preventScroll: true });
      }
    } catch (err) {
      if (dead || drawer !== d || isAbort(err)) return;
      renderDrawerError(d, err);
    }
  }

  function contactItem(k) {
    const name = k.founder_name || 'Name not on file';
    const email = k.email
      ? h(
          'div',
          { class: 'cd-email' },
          icon('mail', 13),
          h('span', { class: 'mono cd-email-addr' }, k.email),
          k.email_confidence
            ? h('span', { class: 'cd-conf', title: CONFIDENCE_HINT[k.email_confidence] || null }, badge(CONFIDENCE[k.email_confidence] || k.email_confidence, 'neutral'))
            : null,
          k.mx_ok ? badge('MX ok', 'ok') : badge('No MX', 'warn'),
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
    const details = h(
      'dl',
      { class: 'cd-details' },
      h('div', {}, h('dt', {}, 'Sourced by'), h('dd', {}, company.source_query || '—')),
      h('div', {}, h('dt', {}, 'First seen'), h('dd', { class: 'mono' }, longWhen(company.first_seen) || '—')),
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
      pushSearch.cancel();
      unbindKeys();
      window.removeEventListener('resize', fitSourceList);
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

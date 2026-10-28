// App shell (spec §4): the sidebar (sections with live counts, connection dots), the top bar
// (global search, schedule chip, and below 900px the menu button that opens the sidebar as an
// off-canvas panel) and the stale-session banner. Everything it shows comes from the shared store
// (/api/summary + /api/status), so it stays current without polling of its own.

import { api, SESSION_EXPIRED } from './core/api.js';
import { debounce, fmtDate, fmtNum, fmtRelative, h, pluralize } from './core/dom.js';
import { bindKeys, clearOverlay } from './core/keys.js';
import { href } from './core/router.js';

const SECTIONS = [
  {
    label: 'Workspace',
    items: [
      { route: 'home', label: 'Home' },
      { route: 'pipeline', label: 'Pipeline', count: (c) => c.companies, spoken: (n) => pluralize(n, 'company', 'companies') },
      { route: 'drafts', label: 'Drafts', count: (c) => c.drafts, strong: true, spoken: (n) => `${fmtNum(n)} waiting` },
      { route: 'followups', label: 'Follow-ups', count: (c) => c.followups_due, spoken: (n) => `${fmtNum(n)} due` },
      { route: 'agent', label: 'Agent' },
      { route: 'schedules', label: 'Schedules' },
    ],
  },
  {
    label: 'Setup',
    items: [
      { route: 'company', label: 'Company profile' },
      { route: 'settings', label: 'Settings' },
    ],
  },
];

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 5;
const DRAFTS_TTL_MS = 30_000;
const PHONE = '(max-width: 899px)';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

function icon(paths, size = 16) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    [].concat(paths).map((d) => h('path', { d })),
  );
}

const ICONS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
  alert: ['M12 3l9.5 17h-19L12 3z', 'M12 10v4', 'M12 17.5v.01'],
};

/** The coldtrail wordmark: a link home with the logo mark (a logo, so its own 2px stroke) and the
 *  name. For full-page screens without the sidebar (Setup) too. */
export function wordmark() {
  return h(
    'a',
    { class: 'wordmark', href: '#/home' },
    h(
      'svg',
      { viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { d: 'M3 17l5-5 4 3 8-9' }),
      h('circle', { cx: '20', cy: '6', r: '1.5' }),
    ),
    h('span', {}, 'coldtrail'),
  );
}

/**
 * Each connection as the sidebar footer shows it: state ok (green) | warn (amber: only the human
 * can fix it) | none (grey: not set up), a visible word for anything but ok, and a spoken state.
 * The spoken state of anything but ok is its visible word, so the link's name ("Gmail: Connect")
 * starts with what is on screen (WCAG 2.5.3); ok has no word and says "ready" / "connected".
 */
export function connections(status, summary) {
  if (!status) return [];
  const attention = new Set(((summary && summary.attention) || []).map((a) => a.kind));
  const agents = 'tab=agent';
  const conns = 'tab=connections';

  let agent;
  if (status.provider === 'openai') {
    agent = status.base_url
      ? { label: 'Agent · Your own model', state: 'ok', spoken: 'ready' }
      : { label: 'Agent · Your own model', state: 'none', word: 'Set up', spoken: 'Set up' };
  } else {
    const a = (status.agents || []).find((x) => x.kind === status.provider);
    const label = `Agent · ${a ? a.label : status.provider || 'none'}`;
    if (!a || !a.present || attention.has('provider_missing')) {
      agent = { label, state: 'warn', word: 'Not installed', spoken: 'Not installed' };
    } else if (!a.authed) {
      agent = { label, state: 'warn', word: 'Sign in', spoken: 'Sign in' };
    } else {
      agent = { label, state: 'ok', spoken: 'ready' };
    }
  }
  agent.tab = agents;

  const linked = (on) => (on ? { state: 'ok', spoken: 'connected' } : { state: 'none', word: 'Connect', spoken: 'Connect' });
  const canonical = { label: 'Canonical', tab: conns, ...linked(status.discovery_connected && !attention.has('canonical_disconnected')) };
  const gmail = { label: 'Gmail', tab: conns, ...linked(status.destination_connected) };
  const linkedin =
    status.linkedin_reconnect_needed || attention.has('linkedin_reconnect')
      ? { label: 'LinkedIn', tab: conns, state: 'warn', word: 'Reconnect', spoken: 'Reconnect' }
      : { label: 'LinkedIn', tab: conns, ...linked(status.linkedin_connected) };
  return [agent, canonical, gmail, linkedin];
}

/** Split the companies-search rows into Companies (name/domain hits) and People (contact hits). */
export function groupCompanyHits(rows, q) {
  const needle = q.trim().toLowerCase();
  const has = (s) => s != null && String(s).toLowerCase().includes(needle);
  const companies = [];
  const people = [];
  for (const r of rows) {
    const byCompany = has(r.name) || has(r.domain);
    const byPerson = has(r.founder) || has(r.email);
    if (byPerson) people.push(r);
    // A row found through a contact the list doesn't show still appears, as a company.
    if (byCompany || !byPerson) companies.push(r);
  }
  return { companies, people };
}

/** Drafts whose domain, recipient or subject contains q (any case), at most `limit`. */
export function matchDrafts(drafts, q, limit = SEARCH_LIMIT) {
  const needle = q.trim().toLowerCase();
  const has = (s) => s != null && String(s).toLowerCase().includes(needle);
  return drafts.filter((d) => has(d.domain) || has(d.to) || has(d.subject)).slice(0, limit);
}

/**
 * Render the shell into the page's fixed roots (#nav, #topbar, before #view) and keep it in sync
 * with the store. navigate(to) is the router's. Returns { setRoute(name) } for the router's
 * onRoute: it marks the current section and closes the phone menu.
 */
export function mountShell({ store, navigate }) {
  const app = document.getElementById('app');
  const aside = document.getElementById('nav');
  const topbar = document.getElementById('topbar');
  const view = document.getElementById('view');
  const mainCol = view.parentElement;

  // ---- Sidebar ----

  const links = [];
  const navEl = h(
    'nav',
    { class: 'nav', 'aria-label': 'Main' },
    SECTIONS.map((section, i) => {
      const labelId = `nav-group-${i}`;
      return h(
        'div',
        { class: 'nav-group' },
        h('div', { class: 'nav-group-label eyebrow', id: labelId }, section.label),
        h(
          'ul',
          { class: 'nav-list', 'aria-labelledby': labelId },
          section.items.map((item) => {
            const count = item.count
              ? h('span', { class: ['nav-count', item.strong && 'nav-count-strong'], 'aria-hidden': 'true', hidden: true })
              : null;
            const a = h(
              'a',
              { class: 'nav-item', href: `#/${item.route}`, 'data-route': item.route, onClick: (e) => onNavClick(e, a) },
              h('span', { class: 'nav-label' }, item.label),
              count,
            );
            links.push({ item, a, count });
            return h('li', {}, a);
          }),
        ),
      );
    }),
  );
  // A plain click on the link to the screen on show reloads a screen that failed to load (the
  // router only retries then; the browser fires no hashchange for the same address).
  function onNavClick(e, a) {
    closeNav({ restore: false });
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.getAttribute('href') === location.hash) navigate(location.hash);
  }

  const conns = h('ul', { class: 'nav-conns', 'aria-label': 'Connections' });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn nav-close', 'aria-label': 'Close menu', onClick: () => closeNav() }, icon(ICONS.close));
  aside.replaceChildren(h('div', { class: 'nav-head' }, wordmark(), closeBtn), navEl, conns);

  function renderCounts(summary) {
    const counts = summary && summary.counts;
    for (const { item, a, count } of links) {
      if (!count) continue;
      const n = counts ? item.count(counts) : null;
      const show = n != null && Number(n) > 0;
      count.hidden = !show;
      count.textContent = show ? fmtNum(n) : '';
      // Read out with what it counts ("Drafts, 52 waiting"), not as a bare number.
      if (show) a.setAttribute('aria-label', `${item.label}, ${item.spoken(n)}`);
      else a.removeAttribute('aria-label');
    }
  }

  function renderConnections(status, summary) {
    conns.replaceChildren(
      ...connections(status, summary).map((c) => {
        const name = `${c.label}: ${c.spoken}`;
        return h(
          'li',
          {},
          h(
            'a',
            { class: 'conn', href: `#/settings?${c.tab}`, 'data-state': c.state, 'aria-label': name, title: name, onClick: () => closeNav({ restore: false }) },
            h('span', { class: 'conn-dot', 'aria-hidden': 'true' }),
            h('span', { class: 'conn-label' }, c.label),
            h('span', { class: 'conn-state', 'aria-hidden': 'true' }, c.word || ''),
          ),
        );
      }),
    );
  }

  // ---- Phone: the sidebar as an off-canvas menu ----

  const phone = window.matchMedia(PHONE);
  const toggle = h(
    'button',
    { type: 'button', class: 'icon-btn nav-toggle', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'nav', onClick: () => (isOpen() ? closeNav() : openNav()) },
    icon(ICONS.menu, 20),
  );
  const scrim = h('div', { class: 'nav-scrim', hidden: true, onClick: () => closeNav() });
  app.append(scrim);
  const isOpen = () => app.classList.contains('nav-open');

  function openNav() {
    if (!phone.matches || isOpen()) return;
    app.classList.add('nav-open');
    toggle.setAttribute('aria-expanded', 'true');
    scrim.hidden = false;
    mainCol.inert = true;
    const first = aside.querySelector('[aria-current="page"]') || aside.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function closeNav({ restore = true } = {}) {
    if (!isOpen()) return;
    app.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    scrim.hidden = true;
    mainCol.inert = false;
    if (restore) toggle.focus();
  }

  aside.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeNav();
    } else if (e.key === 'Tab') {
      // Keep Tab inside the open menu.
      const items = [...aside.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  phone.addEventListener('change', () => {
    if (!phone.matches) closeNav({ restore: false });
  });

  // ---- Top bar: search ----

  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const listId = 'search-results';
  const input = h('input', {
    type: 'text',
    class: 'search-input',
    role: 'combobox',
    'aria-label': 'Search',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-keyshortcuts': 'Meta+K Control+K',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    placeholder: 'Search companies, people, drafts',
  });
  const status = h('div', { class: 'search-status', role: 'status' });
  const listbox = h('div', { class: 'search-list', role: 'listbox', id: listId, 'aria-label': 'Search results' });
  const pop = h('div', { class: 'search-pop', hidden: true }, status, listbox);
  const searchBox = h(
    'div',
    { class: 'search', role: 'search' },
    h('div', { class: 'search-field' }, icon(ICONS.search, 15), input, h('kbd', { class: 'kbd search-kbd', 'aria-hidden': 'true' }, mac ? '⌘K' : 'Ctrl K')),
    pop,
  );

  let results = []; // [{ el, href }]
  let shownQuery = null; // the query `results` answer
  let openFirst = false; // Enter came before the results for the typed query: open its first
  let active = -1;
  let searchSeq = 0;
  let searchCtl = null;
  let draftsCache = null; // { at, promise }

  function setActive(i) {
    active = i;
    results.forEach((r, j) => {
      r.el.classList.toggle('is-active', j === i);
      r.el.setAttribute('aria-selected', j === i ? 'true' : 'false');
    });
    if (i >= 0 && results[i]) {
      input.setAttribute('aria-activedescendant', results[i].el.id);
      results[i].el.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function openPop() {
    pop.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function closePop() {
    pop.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    runSearch.cancel();
    if (searchCtl) searchCtl.abort();
    searchSeq++;
    openFirst = false;
    shownQuery = null;
    results = [];
    listbox.replaceChildren();
    setActive(-1);
  }

  function setStatus(text, { quiet = false } = {}) {
    status.textContent = text;
    status.classList.toggle('sr-only', quiet);
  }

  function option(name, meta, to) {
    const el = h(
      'div',
      {
        role: 'option',
        id: `search-opt-${results.length}`,
        class: 'search-opt',
        'aria-selected': 'false',
        onMousedown: (e) => e.preventDefault(), // keep focus in the input
        onClick: () => choose(to),
      },
      h('span', { class: 'search-opt-name' }, name),
      meta ? h('span', { class: 'search-opt-meta' }, meta) : null,
    );
    results.push({ el, href: to });
    return el;
  }

  function group(label, items) {
    if (!items.length) return null;
    const id = `search-group-${label.toLowerCase()}`;
    return h('div', { role: 'group', 'aria-labelledby': id, class: 'search-group' }, h('div', { class: 'search-group-label eyebrow', id, role: 'presentation' }, label), items);
  }

  function renderResults(q, rows, drafts) {
    results = [];
    shownQuery = q;
    const { companies, people } = groupCompanyHits(rows, q);
    const companyOpts = companies.map((r) => option(r.name || r.domain, r.domain, href(['pipeline', r.domain])));
    const peopleOpts = people.map((r) =>
      option(r.founder || r.email, [r.name || r.domain, r.domain].filter((v, i, a) => a.indexOf(v) === i).join(' · '), href(['pipeline', r.domain])),
    );
    const draftOpts = drafts.map((d) => {
      const channel = d.channel === 'linkedin' ? 'LinkedIn note' : 'Email';
      const name = d.channel === 'linkedin' ? d.domain : d.to || d.domain;
      const meta = d.channel === 'linkedin' ? channel : `${channel} · ${d.subject || d.domain}`;
      return option(name, meta, href(['drafts', d.domain]));
    });
    listbox.replaceChildren(...[group('Companies', companyOpts), group('People', peopleOpts), group('Drafts', draftOpts)].filter(Boolean));
    if (results.length) setStatus(`${pluralize(results.length, 'result')}`, { quiet: true });
    else setStatus(`No matches for “${q}”`);
    setActive(results.length ? 0 : -1);
    if (openFirst) {
      openFirst = false;
      if (results.length) choose(results[0].href);
    }
  }

  // /api/drafts is the whole queue: fetch it once per search session (30s) and filter here.
  function loadDrafts() {
    if (!draftsCache || Date.now() - draftsCache.at > DRAFTS_TTL_MS) {
      const promise = api.get('/api/drafts').catch((err) => {
        draftsCache = null;
        throw err;
      });
      draftsCache = { at: Date.now(), promise };
    }
    return draftsCache.promise;
  }

  async function search(q) {
    if (searchCtl) searchCtl.abort();
    const ctl = new AbortController();
    searchCtl = ctl;
    const seq = ++searchSeq;
    try {
      const qs = new URLSearchParams({ q, per: String(SEARCH_LIMIT) });
      const [page, drafts] = await Promise.all([api.get(`/api/companies?${qs}`, { signal: ctl.signal }), loadDrafts()]);
      if (seq !== searchSeq) return;
      renderResults(q, page.rows || [], matchDrafts(Array.isArray(drafts) ? drafts : [], q));
    } catch (err) {
      if (seq !== searchSeq || (err && err.name === 'AbortError')) return;
      results = [];
      listbox.replaceChildren();
      setActive(-1);
      openFirst = false;
      setStatus((err && err.message) || String(err));
    }
  }
  const runSearch = debounce(search, SEARCH_DEBOUNCE_MS);

  function onQuery() {
    const q = input.value.trim();
    if (!q) {
      closePop();
      return;
    }
    openPop();
    if (!results.length) setStatus('Searching…');
    runSearch(q);
  }

  function choose(to) {
    closePop();
    input.value = '';
    input.blur();
    navigate(to);
  }

  input.addEventListener('input', onQuery);
  input.addEventListener('focus', () => {
    if (input.value.trim() && pop.hidden) onQuery();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (pop.hidden || !results.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(active < 0 ? (step > 0 ? 0 : results.length - 1) : (active + step + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      if (!pop.hidden && shownQuery === q && results[active]) {
        choose(results[active].href);
      } else {
        // The list on screen answers an older query: search now and open the first result.
        openFirst = true;
        openPop();
        runSearch.cancel();
        search(q);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!pop.hidden) closePop();
      else if (input.value) input.value = '';
      else input.blur();
    }
  });
  searchBox.addEventListener('focusout', (e) => {
    if (!searchBox.contains(e.relatedTarget)) closePop();
  });

  bindKeys({
    'mod+k': () => {
      if (topbar.offsetParent === null) return false; // hidden (setup): leave the key alone
      if (!clearOverlay()) return true; // closed one of several overlays; the next press goes on
      closeNav({ restore: false });
      input.focus();
      input.select();
      return true;
    },
  });

  // ---- Top bar: schedule chip ----

  const chipDot = h('span', { class: 'chip-dot', 'aria-hidden': 'true' });
  const chipText = h('span', { class: 'chip-text' });
  const chip = h('a', { class: 'chip', href: '#/schedules', hidden: true }, chipDot, chipText);

  function renderChip(summary) {
    if (!summary) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chipDot.className = 'chip-dot';
    if (summary.running) {
      const text = `Running · ${summary.running.title || 'a run'}`;
      chip.setAttribute('href', href(['agent', summary.running.chat_id]));
      chip.title = `${text}: open its conversation`;
      chipText.textContent = text;
      chipDot.classList.add('is-live');
    } else if (summary.next_schedule) {
      const next = summary.next_schedule;
      chip.setAttribute('href', '#/schedules');
      chip.title = `Next run ${fmtDate(next.next_at, { time: true })}`;
      chipText.textContent = `${next.name} · next ${fmtRelative(next.next_at)}`;
      chipDot.classList.add('is-next');
    } else {
      chip.setAttribute('href', '#/schedules');
      chip.title = 'Create a schedule';
      chipText.textContent = 'No schedule';
    }
  }

  topbar.replaceChildren(toggle, searchBox, chip);

  // ---- Stale session ----

  let banner = null;
  window.addEventListener('coldtrail:session-expired', (e) => {
    if (banner) return;
    const message = (e.detail && e.detail.message) || SESSION_EXPIRED;
    banner = h('div', { class: 'session-banner', role: 'alert' }, icon(ICONS.alert), h('span', {}, message));
    mainCol.insertBefore(banner, view);
  });

  // ---- Store ----

  function render({ summary, status: st }) {
    renderCounts(summary);
    renderConnections(st, summary);
    renderChip(summary);
  }
  render(store.get());
  store.subscribe(render);

  return {
    /** The router's onRoute: mark the current section; setup is a full page without the shell. */
    setRoute(name) {
      app.dataset.route = name;
      for (const { item, a } of links) {
        if (item.route === name) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      closeNav({ restore: false });
    },
  };
}

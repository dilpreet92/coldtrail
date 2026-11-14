// App shell (spec §4): the sidebar (sections with live counts, connection dots), the top bar
// (global search, schedule chip, and below 900px the menu button that opens the sidebar as an
// off-canvas panel) and the banner for a stale session or a coldtrail that stopped answering.
// Everything it shows comes from the shared store (/api/summary + /api/status), so it stays
// current without polling of its own.

import { api, errorText } from './core/api.js';
import { debounce, fmtDate, fmtNum, fmtRelative, h, pluralize } from './core/dom.js';
import { bindKeys, clearOverlay, holdPageKeys, isApple } from './core/keys.js';
import { href, parseHash } from './core/router.js';

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

const channelOf = (d) => (d.channel === 'linkedin' ? 'linkedin' : 'email');

/** Drafts whose contact, company, domain, recipient or subject contains q (any case), at most
 *  `limit`. One per domain and channel, the first (the newest): Drafts shows one row for them. */
export function matchDrafts(drafts, q, limit = SEARCH_LIMIT) {
  const needle = q.trim().toLowerCase();
  const has = (s) => s != null && String(s).toLowerCase().includes(needle);
  const seen = new Set();
  return drafts
    .filter((d) => has(d.contact_name) || has(d.company_name) || has(d.domain) || has(d.to) || has(d.subject))
    .filter((d) => {
      const key = `${channelOf(d)}:${d.domain}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

/** Where a draft search result goes: its row in Drafts, with the channel when the company has
 *  drafts on both (`all`: the whole queue), as Drafts' own address does. */
export function draftHref(d, all = []) {
  const channel = channelOf(d);
  const shared = all.some((x) => x.domain === d.domain && channelOf(x) !== channel);
  return href(['drafts', d.domain], { channel: shared ? channel : null });
}

/**
 * Where a company or person search result goes: the company's drawer in Pipeline. Searched from
 * Pipeline (`hash`, the address on show), over the same list: its search, stage, source and page
 * stay behind the drawer and are what closing it goes back to.
 */
export function companyHref(domain, hash = '') {
  const { path, query } = parseHash(hash);
  const list = path[0] === 'pipeline' ? { q: query.q, stage: query.stage, query: query.query, page: query.page } : {};
  return href(['pipeline', domain], list);
}

/**
 * A draft as a search result names it, the way the Drafts list does: { name: "Sami Roe ·
 * Northwind Health" (the contact and company, either alone when the other is missing; with
 * neither an email's recipient, else the domain), meta: "LinkedIn note · <domain>" / "Email ·
 * <domain> · <subject>" (the domain left out when the name is just the domain) }.
 */
export function draftOption(d) {
  const named = (v) => (v == null || !String(v).trim() ? null : String(v).trim());
  const linkedin = d.channel === 'linkedin';
  const domain = String(d.domain || '');
  const who = [named(d.contact_name), named(d.company_name)].filter(Boolean).join(' · ');
  const name = who || (!linkedin && named(d.to)) || domain;
  const meta = [linkedin ? 'LinkedIn note' : 'Email', name === domain ? null : domain, linkedin ? null : named(d.subject)];
  return { name, meta: meta.filter(Boolean).join(' · ') };
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
              { class: 'nav-item', href: `#/${item.route}`, 'data-route': item.route },
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

  // The rows are built once and then updated in place, as the counts are: rebuilding them on
  // every store refresh (each 30s) would drop the focus of anyone resting on one.
  const connRows = []; // [{ li, a, label, state }] in connections() order
  function renderConnections(status, summary) {
    const list = connections(status, summary);
    while (connRows.length > list.length) connRows.pop().li.remove();
    list.forEach((c, i) => {
      if (!connRows[i]) {
        const label = h('span', { class: 'conn-label' });
        const state = h('span', { class: 'conn-state', 'aria-hidden': 'true' });
        const dot = h('span', { class: 'conn-dot', 'aria-hidden': 'true' });
        const a = h('a', { class: 'conn' }, dot, label, state);
        connRows[i] = { li: h('li', {}, a), a, label, state };
        conns.append(connRows[i].li);
      }
      const row = connRows[i];
      const name = `${c.label}: ${c.spoken}`;
      row.a.setAttribute('href', `#/settings?${c.tab}`);
      row.a.setAttribute('data-state', c.state);
      row.a.setAttribute('aria-label', name);
      row.a.title = name;
      row.label.textContent = c.label;
      row.state.textContent = c.word || '';
    });
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
    holdPageKeys(true); // J/K and the rest must not act on the page the menu covers
    const first = aside.querySelector('[aria-current="page"]') || aside.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function closeNav({ restore = true } = {}) {
    if (!isOpen()) return;
    app.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    scrim.hidden = true;
    mainCol.inert = false;
    holdPageKeys(false);
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

  // The screen's heading, where the router puts focus on a new screen.
  function focusScreen() {
    const h1 = view.querySelector('h1');
    if (h1 && !h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
    (h1 || view).focus({ preventScroll: true });
  }

  // Any link in the sidebar: a screen, a connection dot, the wordmark. In the phone menu it closes
  // the menu and puts focus on the screen's heading, not on a link the closed menu hides (a new
  // screen's heading takes it over; a screen that stays keeps it), also when the link is to the
  // address on show and nothing else happens. A plain click on that address retries a screen that
  // failed (the browser fires no hashchange for it).
  aside.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const wasOpen = isOpen();
    closeNav({ restore: false });
    if (wasOpen) focusScreen();
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.getAttribute('href') === location.hash) navigate(location.hash);
  });

  // ---- Top bar: search ----

  const mac = isApple();
  const listId = 'search-results';
  const input = h('input', {
    type: 'text',
    class: 'search-input',
    role: 'combobox',
    'aria-label': 'Search',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-keyshortcuts': mac ? 'Meta+K' : 'Control+K',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
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
  let returnTo = null; // what had focus before the search took it (⌘K, Tab or a click)

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

  function renderResults(q, rows, drafts, allDrafts) {
    results = [];
    shownQuery = q;
    const { companies, people } = groupCompanyHits(rows, q);
    const companyOpts = companies.map((r) => option(r.name || r.domain, r.domain, companyHref(r.domain, location.hash)));
    const peopleOpts = people.map((r) =>
      option(r.founder || r.email, [r.name || r.domain, r.domain].filter((v, i, a) => a.indexOf(v) === i).join(' · '), companyHref(r.domain, location.hash)),
    );
    const draftOpts = drafts.map((d) => {
      const { name, meta } = draftOption(d);
      return option(name, meta, draftHref(d, allDrafts));
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
      const all = Array.isArray(drafts) ? drafts : [];
      renderResults(q, page.rows || [], matchDrafts(all, q), all);
    } catch (err) {
      if (seq !== searchSeq || (err && err.name === 'AbortError')) return;
      results = [];
      listbox.replaceChildren();
      setActive(-1);
      openFirst = false;
      // On a stale session only the short pointer: the banner above says it in full, once.
      setStatus(errorText(err));
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
    returnTo = null;
    input.blur();
    navigate(to);
  }

  // Esc out of an empty search goes back where the user was (the Pipeline row, the draft), as an
  // overlay gives focus back to its opener; to <body> only when that is gone or now hidden (inert,
  // or in the phone menu ⌘K closed).
  function leaveSearch() {
    const back = returnTo;
    returnTo = null;
    const hidden = !back || !back.isConnected || back.closest('[inert]') || (aside.contains(back) && phone.matches && !isOpen());
    if (!hidden) back.focus({ preventScroll: true });
    if (document.activeElement === input) input.blur();
  }

  input.addEventListener('input', onQuery);
  input.addEventListener('focus', (e) => {
    const from = e.relatedTarget;
    returnTo = from && from !== document.body && !searchBox.contains(from) ? from : null;
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
      else leaveSearch();
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

  // On a phone the chip has room for when, not what: "Next in 21h" / "Running", the full text
  // staying its name (which starts with the words on show, WCAG 2.5.3). "In under a minute" is
  // too long for it: "Next in <1m" there, its name saying it in full.
  let chipSummary = null;
  function renderChip(summary) {
    chipSummary = summary;
    if (!summary) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chipDot.className = 'chip-dot';
    let text;
    let short = null; // [the phone's text, the name it goes with]
    if (summary.running) {
      text = `Running · ${summary.running.title || 'a run'}`;
      short = ['Running', text];
      chip.setAttribute('href', href(['agent', summary.running.chat_id]));
      chip.title = `${text}: open its conversation`;
      chipDot.classList.add('is-live');
    } else if (summary.next_schedule) {
      const next = summary.next_schedule;
      const when = fmtRelative(next.next_at);
      text = `${next.name} · next ${when}`;
      short = [`Next ${when === 'in under a minute' ? 'in <1m' : when}`, `Next ${when} · ${next.name}`];
      chip.setAttribute('href', '#/schedules');
      chip.title = `Next run ${fmtDate(next.next_at, { time: true })}`;
      chipDot.classList.add('is-next');
    } else {
      text = 'No schedule';
      chip.setAttribute('href', '#/schedules');
      chip.title = 'Create a schedule';
    }
    if (short && phone.matches) {
      chipText.textContent = short[0];
      chip.setAttribute('aria-label', short[1]);
    } else {
      chipText.textContent = text;
      chip.removeAttribute('aria-label');
    }
  }

  // The search's hint, cut to fit a phone's top bar.
  function fitTopbar() {
    input.placeholder = phone.matches ? 'Search' : 'Search companies, people, drafts';
    renderChip(chipSummary);
  }
  phone.addEventListener('change', fitTopbar);

  topbar.replaceChildren(toggle, searchBox, chip);
  fitTopbar();

  // ---- Stale session, or coldtrail not answering ----

  // One banner while api.js says the tab can't reach coldtrail (a stale session, or no answer at
  // all), gone with the first answer after. A new problem replaces it, so it is announced.
  let banner = null;
  function showBanner(e) {
    const message = (e.detail && e.detail.message) || '';
    if (banner && banner.dataset.message === message) return;
    if (banner) banner.remove();
    banner = h('div', { class: 'session-banner', role: 'alert', 'data-message': message }, icon(ICONS.alert), h('span', {}, message));
    mainCol.insertBefore(banner, view);
  }
  window.addEventListener('coldtrail:session-expired', showBanner);
  window.addEventListener('coldtrail:offline', showBanner);
  window.addEventListener('coldtrail:reconnected', () => {
    if (banner) banner.remove();
    banner = null;
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

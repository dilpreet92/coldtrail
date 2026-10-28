// Follow-ups (spec §5.5): everyone already contacted, by state — Due / Awaiting / Replied /
// Bounced — from GET /api/followups, filterable, at most 100 rows at a time. Row actions: Draft
// follow-up (POST /api/followups/:domain/draft, one agent turn), Mark replied / Mark bounced
// (POST /api/followups/:domain/mark). Header action: Check for replies (POST
// /api/followups/check, one agent turn that reads Gmail). GET /api/drafts tells which due rows
// already have a draft waiting, so a second follow-up isn't drafted by accident.
//
// Agent turns take minutes and the server keeps running them whatever the page does, so they
// belong to the page, not the screen: leaving Follow-ups never cancels one, coming back shows its
// progress or result, and one that ends elsewhere says so in a toast. Everything the screen
// itself starts (fetches, the elapsed-time ticker, its store subscription) stops on unmount.

import { api } from '../core/api.js';
import { debounce, fmtNum, h, pluralize, truncate } from '../core/dom.js';
import { renderMarkdown } from '../core/markdown.js';
import { href } from '../core/router.js';
import { store } from '../core/store.js';
import { toast } from '../core/ui.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/emptyState.js';
import { table } from '../components/table.js';
import { tabs } from '../components/tabs.js';

const title = 'Follow-ups';
const PAGE = 100; // rows rendered at a time (spec Review Focus 4)
const FILTER_MS = 200;
// The server's rule (pipeline::followup_rows): due once the last send is 4+ days old, while
// fewer than 3 touches have gone out.
const DUE_AFTER_DAYS = 4;
const MAX_TOUCHES = 3;

const STATES = [
  {
    id: 'due',
    label: 'Due',
    badge: ['Due', 'accent'],
    empty: ['Nothing is due for a follow-up', `A follow-up comes due ${DUE_AFTER_DAYS} days after the last send, up to ${MAX_TOUCHES} touches in total.`],
  },
  {
    id: 'awaiting',
    label: 'Awaiting',
    badge: ['Awaiting reply', 'neutral'],
    empty: ['No one is awaiting a reply', 'Contacts you have written to and not heard back from show up here.'],
  },
  {
    id: 'replied',
    label: 'Replied',
    badge: ['Replied', 'ok'],
    empty: ['No replies yet', 'Replies show up here when Check for replies finds them in Gmail, or when you mark one.'],
  },
  {
    id: 'bounced',
    label: 'Bounced',
    badge: ['Bounced', 'danger'],
    empty: ['No bounces', 'Addresses that bounced show up here, so you can look for a better contact.'],
  },
];
const STATE = Object.fromEntries(STATES.map((st) => [st.id, st]));
const tabFrom = (query) => (query && STATE[query.tab] ? query.tab : 'due');

// ---- Agent turns: page-lifetime state ----

const jobs = {
  check: null, // { startedAt, contacts } while a reply check runs
  result: null, // { tone, title, message, markdown, at } of the last check, until dismissed
  drafting: new Set(), // domains whose follow-up the agent is writing
};
let screen = null; // hooks of the mounted screen, or null

function runCheck(contacts, before) {
  jobs.check = { startedAt: Date.now(), contacts, before };
  jobs.result = null;
  api
    .post('/api/followups/check', {})
    .then(
      (r) => {
        jobs.result =
          r && r.ok
            ? { tone: 'ok', title: 'Reply check finished', message: r.message || null, markdown: true }
            : { tone: 'warn', title: "Couldn't check for replies", message: (r && r.message) || 'The agent could not check Gmail.', markdown: true };
      },
      (err) => {
        jobs.result = { tone: 'err', title: 'Reply check failed', message: (err && err.message) || String(err), markdown: false };
      },
    )
    .finally(() => {
      // What the check changed is known once the list reloads (see diffCheck).
      if (jobs.result.tone === 'ok') jobs.result.before = jobs.check.before;
      jobs.result.at = new Date();
      jobs.check = null;
      if (screen) {
        screen.afterCheck();
      } else {
        const r = jobs.result;
        toast(r.tone === 'ok' ? 'Reply check finished. The summary is on Follow-ups.' : `${r.title}. The details are on Follow-ups.`, r.tone === 'ok' ? 'ok' : 'err');
        store.refresh();
      }
    });
}

/** Once the list has reloaded after a check: who it moved to replied / bounced. */
function diffCheck(rows) {
  const r = jobs.result;
  if (!r || !r.before || jobs.check) return;
  const changes = { replied: [], bounced: [] };
  for (const row of rows) {
    const was = r.before.get(row.domain);
    if (was && was !== row.state && changes[row.state]) changes[row.state].push(row.domain);
  }
  r.changes = changes;
  r.before = null;
}

/** "No new replies or bounces." / "1 new reply (a.example) and 2 bounces (b.example, c.example)." */
function changesText({ replied, bounced }) {
  const list = (ds) => (ds.length > 4 ? `${ds.slice(0, 3).join(', ')} and ${fmtNum(ds.length - 3)} more` : ds.join(', '));
  const parts = [];
  if (replied.length) parts.push(`${pluralize(replied.length, 'new reply', 'new replies')} (${list(replied)})`);
  if (bounced.length) parts.push(`${pluralize(bounced.length, 'bounce')} (${list(bounced)})`);
  return parts.length ? `${parts.join(' and ')}.` : 'No new replies or bounces.';
}

function runDraft(domain) {
  jobs.drafting.add(domain);
  api
    .post(`/api/followups/${encodeURIComponent(domain)}/draft`, {})
    .then(
      (r) => {
        if (r && r.ok) toast(`Follow-up drafted for ${domain}. Review it in Drafts.`, 'ok');
        else toast(`Couldn't draft a follow-up for ${domain}.\n${r && r.message ? mdPlain(r.message) : 'The agent finished without writing one.'}`, 'err');
      },
      (err) => toast(`Couldn't draft a follow-up for ${domain}.\n${(err && err.message) || err}`, 'err'),
    )
    .finally(() => {
      jobs.drafting.delete(domain);
      if (screen) screen.afterDraft(domain);
      else store.refresh();
    });
}

// ---- Small helpers ----

function icon(paths, size = 16) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    [].concat(paths).map((d) => h('path', { d })),
  );
}

const ICONS = {
  mail: ['M4 6.5h16v11H4z', 'M4.5 7l7.5 6 7.5-6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
  ok: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8 12.5l2.5 2.5L16 9.5'],
  warn: ['M12 3.5l9 16H3l9-16z', 'M12 10v4', 'M12 17v.01'],
  err: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5v5.5', 'M12 16.5v.01'],
  close: 'M6 6l12 12M18 6L6 18',
};

const spinner = () => h('span', { class: 'fu-spin', 'aria-hidden': 'true' });

/** "Less than a day" / "1 day" / "9 days" since the last send (whole days, as the API counts). */
function sinceLabel(days) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  return d < 1 ? 'Less than a day' : pluralize(d, 'day');
}

/** What comes next for a row still open: which follow-up is due, or when the next one is. */
function nextStep(r) {
  const touches = Number(r.touches) || 0;
  if (r.state === 'due') return `Follow-up ${fmtNum(touches)} of ${fmtNum(MAX_TOUCHES - 1)}`;
  if (r.state !== 'awaiting') return null;
  if (touches >= MAX_TOUCHES) return 'No more follow-ups';
  return `Due in ${pluralize(Math.max(1, DUE_AFTER_DAYS - (Number(r.days) || 0)), 'day')}`;
}

/** "0:07", "12:30". */
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Agent text as rendered markdown (the safe subset only). */
function mdBlock(text) {
  const box = h('div', { class: 'fu-md' });
  box.innerHTML = renderMarkdown(text);
  return box;
}

/** Agent text as plain text for a toast: rendered by renderMarkdown, then read back as text (a
 *  template's content is inert: nothing in it runs or loads). */
function mdPlain(text) {
  const tpl = document.createElement('template');
  tpl.innerHTML = renderMarkdown(text);
  const lines = [];
  for (const node of tpl.content.childNodes) {
    if (node.nodeName === 'UL' || node.nodeName === 'OL') {
      for (const li of node.children) lines.push(`• ${li.textContent.trim()}`);
    } else if (node.textContent.trim()) {
      lines.push(node.textContent.trim());
    }
  }
  return truncate(lines.join('\n'), 400);
}

const sigOf = (summary) => {
  const c = summary && summary.counts;
  return c ? `${c.followups_due}|${c.replied}|${c.sent}` : null;
};

// ---- The screen ----

function mount(root, ctx) {
  const nav = ctx.nav;
  const s = {
    tab: tabFrom(ctx.query),
    q: (ctx.query && ctx.query.q) || '',
    limit: PAGE,
    rows: null, // FollowupDto[] once loaded
    pending: new Set(), // lowercased domains with a draft waiting in Drafts
    error: null,
    loading: false,
    marking: new Map(), // domain → the value being marked
    gone: false,
  };
  const ac = new AbortController();
  let loadSeq = 0;
  let ticker = null;
  let elapsedEl = null;
  let selfRefresh = false;
  let sig = sigOf(store.get().summary);
  let revealFrom = null; // first row index shown by the last "Show more"

  // ---- Header ----

  const checkBtn = h('button', { type: 'button', class: 'btn btn-secondary fu-check', 'data-action': 'check', onClick: startCheck });
  const head = h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      { class: 'page-head-text' },
      h('h1', {}, title),
      h('p', { class: 'page-desc' }, `Everyone you have contacted. A follow-up comes due ${DUE_AFTER_DAYS} days after the last send, up to ${MAX_TOUCHES} touches in total.`),
    ),
    h('div', { class: 'page-actions' }, checkBtn),
  );
  const noticeSlot = h('div', { class: 'fu-notice-slot' });
  const live = h('div', { class: 'sr-only', role: 'status' });

  // ---- Tabs + filter ----

  const contentId = `fu-panel-${Math.random().toString(36).slice(2, 8)}`;
  const tabsEl = tabs({
    items: STATES.map((st) => ({ id: st.id, label: st.label })),
    active: s.tab,
    onChange: onTab,
    label: 'Follow-up state',
    panelId: contentId,
  });
  const filterInput = h('input', {
    type: 'search',
    class: 'input fu-filter-input',
    placeholder: 'Filter by domain or email',
    'aria-label': 'Filter follow-ups',
    autocomplete: 'off',
    spellcheck: 'false',
    value: s.q,
  });
  const onFilter = debounce(() => {
    if (s.gone) return;
    s.q = filterInput.value;
    s.limit = PAGE;
    renderContent();
    nav.setQuery({ q: s.q || null });
  }, FILTER_MS);
  filterInput.addEventListener('input', onFilter);
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onFilter.flush();
  });
  const filterBox = h('div', { class: 'fu-filter' }, icon(ICONS.search), filterInput);
  const tools = h('div', { class: 'fu-tools' }, tabsEl, filterBox);
  const content = h('section', { class: 'fu-content', id: contentId, role: 'tabpanel', 'aria-busy': 'true' });

  root.append(head, noticeSlot, tools, content, live);

  // ---- Rendering ----

  function announce(text) {
    live.textContent = text;
  }

  function syncPanelLabel() {
    const sel = tabsEl.querySelector('[aria-selected="true"]');
    if (sel) content.setAttribute('aria-labelledby', sel.id);
  }

  /** The rows the filter lets through (all of them with no filter). */
  function filtered() {
    const needle = s.q.trim().toLowerCase();
    if (!needle) return s.rows;
    return s.rows.filter((r) => String(r.domain).toLowerCase().includes(needle) || String(r.to ?? '').toLowerCase().includes(needle));
  }

  // Tab counts follow the filter, so a match under another tab shows where it is.
  function updateCounts() {
    const counts = Object.fromEntries(STATES.map((st) => [st.id, s.rows ? 0 : null]));
    if (s.rows) for (const r of filtered()) if (r.state in counts) counts[r.state] += 1;
    tabsEl.setCounts(counts);
  }

  function renderCheck() {
    const running = !!jobs.check;
    checkBtn.setAttribute('aria-busy', running ? 'true' : 'false');
    if (running) checkBtn.setAttribute('aria-disabled', 'true');
    else checkBtn.removeAttribute('aria-disabled');
    checkBtn.replaceChildren(running ? spinner() : icon(ICONS.mail), h('span', {}, running ? 'Checking…' : 'Check for replies'));
    renderNotice();
    if (running && !ticker) ticker = setInterval(tick, 1000);
    if (!running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function tick() {
    if (elapsedEl && jobs.check) elapsedEl.textContent = fmtElapsed(Date.now() - jobs.check.startedAt);
  }

  function noticeBox(tone, heading, body, meta, dismissible) {
    const mark = tone === 'progress' ? spinner() : icon(ICONS[tone] || ICONS.ok, 18);
    return h(
      'div',
      { class: `fu-notice fu-notice-${tone}` },
      h('span', { class: 'fu-notice-icon' }, mark),
      h('div', { class: 'fu-notice-main' }, h('p', { class: 'fu-notice-title' }, heading), body, meta ? h('p', { class: 'fu-notice-meta' }, meta) : null),
      dismissible
        ? h('button', { type: 'button', class: 'icon-btn fu-notice-close', 'aria-label': 'Dismiss', onClick: dismissResult }, icon(ICONS.close))
        : null,
    );
  }

  function renderNotice() {
    const hadFocus = noticeSlot.contains(document.activeElement);
    elapsedEl = null;
    if (jobs.check) {
      const n = jobs.check.contacts;
      elapsedEl = h('span', { class: 'fu-elapsed mono' }, fmtElapsed(Date.now() - jobs.check.startedAt));
      noticeSlot.replaceChildren(
        noticeBox(
          'progress',
          n == null ? 'Checking Gmail for replies…' : `Checking Gmail for replies from ${pluralize(n, 'contact')}…`,
          h('p', { class: 'fu-notice-text' }, 'The agent reads your inbox and marks who replied or bounced. This can take a few minutes, and you can leave this screen meanwhile.'),
          [elapsedEl, ' elapsed'],
          false,
        ),
      );
    } else if (jobs.result) {
      const r = jobs.result;
      let body;
      if (r.tone !== 'ok') {
        body = r.markdown ? mdBlock(r.message) : h('p', { class: 'fu-notice-text' }, r.message);
      } else {
        body = [
          r.changes ? h('p', { class: 'fu-notice-text fu-changes' }, changesText(r.changes)) : null,
          r.before ? h('p', { class: 'fu-notice-text' }, 'Updating the list…') : null,
          r.message ? mdBlock(r.message) : null,
          !r.changes && !r.before && !r.message ? h('p', { class: 'fu-notice-text' }, 'The agent did not report anything.') : null,
        ];
      }
      noticeSlot.replaceChildren(noticeBox(r.tone, r.title, body, r.at ? `Finished at ${clock(r.at)}` : null, true));
    } else {
      noticeSlot.replaceChildren();
    }
    if (hadFocus && !noticeSlot.contains(document.activeElement)) checkBtn.focus();
  }

  function dismissResult() {
    jobs.result = null;
    renderNotice();
    checkBtn.focus();
  }

  function skeleton() {
    const bar = (w) => h('span', { class: 'skeleton', style: { width: w } });
    return h(
      'div',
      { class: 'fu-skeleton' },
      h('span', { class: 'sr-only' }, 'Loading follow-ups…'),
      Array.from({ length: 5 }, (_, i) =>
        h(
          'div',
          { class: 'fu-skeleton-row', 'aria-hidden': 'true' },
          h('span', { class: 'fu-skeleton-who' }, bar(`${62 + ((i * 13) % 30)}%`), bar(`${48 + ((i * 17) % 34)}%`)),
          bar('4%'),
          bar('9%'),
          bar('14%'),
        ),
      ),
    );
  }

  function panel(node, attrs = {}) {
    return h('div', { class: 'fu-panel', ...attrs }, node);
  }

  function actButton({ action, domain, text, aria, kind = 'ghost', busy = false, disabled = false, onClick }) {
    return h(
      'button',
      {
        type: 'button',
        class: `btn btn-${kind} btn-sm`,
        'data-action': action,
        'data-domain': domain,
        'aria-label': aria,
        'aria-busy': busy ? 'true' : null,
        'aria-disabled': busy || disabled ? 'true' : null,
        onClick,
      },
      text,
    );
  }

  function actionsCell(r) {
    const domain = r.domain;
    const drafting = jobs.drafting.has(domain);
    const marking = s.marking.has(domain);
    const box = h('div', { class: 'fu-actions' });
    if (r.state === 'due' && r.to) {
      if (!drafting && s.pending.has(String(domain).toLowerCase())) {
        box.append(
          h('a', { class: 'btn btn-secondary btn-sm', href: href(['drafts', domain]), 'data-action': 'review', 'data-domain': domain, 'aria-label': `Review draft, ${domain}` }, 'Review draft'),
        );
      } else {
        box.append(
          actButton({
            action: 'draft',
            domain,
            kind: 'secondary',
            text: drafting ? [spinner(), 'Drafting…'] : 'Draft follow-up',
            aria: `${drafting ? 'Drafting follow-up' : 'Draft follow-up'}, ${domain}`,
            busy: drafting,
            disabled: marking,
            onClick: () => draftFollowup(domain),
          }),
        );
      }
    }
    for (const value of ['replied', 'bounced']) {
      box.append(
        actButton({
          action: value,
          domain,
          text: `Mark ${value}`,
          aria: `Mark ${value}, ${domain}`,
          busy: marking && s.marking.get(domain) === value,
          disabled: drafting || marking,
          onClick: () => mark(domain, value),
        }),
      );
    }
    return box;
  }

  function stateCell(r) {
    const st = STATE[r.state];
    const [label, tone] = st ? st.badge : [String(r.state ?? ''), 'neutral'];
    const hint = nextStep(r);
    return h('div', { class: 'fu-state' }, badge(label, tone), hint ? h('span', { class: 'fu-hint' }, hint) : null);
  }

  function columns(tab) {
    const cols = [
      {
        key: 'domain',
        label: 'Company and contact',
        render: (r) =>
          h(
            'div',
            { class: 'fu-who' },
            h('a', { class: 'fu-domain', href: href(['pipeline', r.domain]), title: r.domain, 'data-action': 'open', 'data-domain': r.domain }, r.domain),
            r.to ? h('span', { class: 'fu-email', title: r.to }, r.to) : h('span', { class: 'fu-email fu-none' }, 'No email on file'),
          ),
      },
      {
        key: 'touches',
        label: 'Touches',
        align: 'right',
        // data-unit: the word the phone layout adds after the number (CSS generated content).
        render: (r) => h('span', { class: 'mono num', 'data-unit': Number(r.touches) === 1 ? 'touch' : 'touches' }, fmtNum(r.touches)),
      },
      {
        key: 'days',
        label: 'Since last send',
        nowrap: true,
        render: (r) => h('span', { class: 'fu-since' }, sinceLabel(r.days)),
      },
      { key: 'state', label: 'State', nowrap: true, render: stateCell },
    ];
    if (tab === 'due' || tab === 'awaiting') {
      cols.push({ key: 'actions', label: h('span', { class: 'sr-only' }, 'Actions'), align: 'right', nowrap: true, render: actionsCell });
    }
    return cols;
  }

  /** Explicit table roles (phones restyle the rows as cards, which would drop the implicit
   *  ones) and a class per column for that layout. */
  function withRoles(wrap, cols) {
    const tbl = wrap.querySelector('table');
    tbl.setAttribute('role', 'table');
    for (const g of tbl.querySelectorAll('thead, tbody')) g.setAttribute('role', 'rowgroup');
    for (const tr of tbl.querySelectorAll('tr')) {
      tr.setAttribute('role', 'row');
      [...tr.children].forEach((cell, i) => {
        cell.setAttribute('role', cell.tagName === 'TH' ? 'columnheader' : 'cell');
        if (cols[i]) cell.classList.add(`fu-c-${cols[i].key}`);
      });
    }
    return wrap;
  }

  const rowEls = () => [...content.querySelectorAll('tbody tr[data-key]')];

  function captureFocus() {
    const a = document.activeElement;
    if (!a || a === content || !content.contains(a)) return null;
    const tr = a.closest('tr[data-key]');
    return { action: a.dataset.action || null, domain: tr ? tr.dataset.key : null, index: tr ? rowEls().indexOf(tr) : -1 };
  }

  function restoreFocus(f) {
    if (!f) return;
    const trs = rowEls();
    const inRow = (tr) => tr && ((f.action && tr.querySelector(`[data-action="${f.action}"]`)) || tr.querySelector('a[href], button'));
    let target = null;
    if (f.action === 'more') {
      target = content.querySelector('[data-action="more"]') || (revealFrom != null ? inRow(trs[revealFrom]) : null);
    } else if (f.action === 'clear' || f.action === 'retry') {
      target = filterInput;
    } else {
      const same = f.domain != null ? trs.find((tr) => tr.dataset.key === f.domain) : null;
      if (same) target = inRow(same);
      else if (f.index >= 0 && trs.length) target = inRow(trs[Math.min(f.index, trs.length - 1)]);
    }
    if (!target) target = tabsEl.querySelector('[aria-selected="true"]');
    if (target) target.focus();
  }

  function renderContent() {
    const focus = captureFocus();
    syncPanelLabel();
    if (!s.rows) {
      if (s.error) {
        content.setAttribute('aria-busy', 'false');
        content.replaceChildren(
          panel(
            emptyState({
              title: "Couldn't load follow-ups",
              body: s.error.message || String(s.error),
              action: h('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'retry', onClick: retry }, 'Try again'),
            }),
            { role: 'alert' },
          ),
        );
      } else {
        content.setAttribute('aria-busy', 'true');
        content.replaceChildren(skeleton());
      }
      restoreFocus(focus);
      return;
    }
    content.setAttribute('aria-busy', s.loading ? 'true' : 'false');

    const st = STATE[s.tab];
    const inTab = s.rows.filter((r) => r.state === s.tab);
    const matched = filtered().filter((r) => r.state === s.tab);
    filterBox.hidden = !s.rows.length && !s.q;
    updateCounts();

    if (!s.rows.length) {
      content.replaceChildren(
        panel(
          emptyState({
            title: 'No one to follow up with yet',
            body: 'Companies show up here once you send them an email or a LinkedIn invite, so you can see who replied and when a follow-up is due.',
            action: { label: 'Review drafts', href: '#/drafts' },
          }),
        ),
      );
    } else if (!inTab.length) {
      content.replaceChildren(panel(emptyState({ title: st.empty[0], body: st.empty[1] })));
    } else if (!matched.length) {
      content.replaceChildren(
        panel(
          emptyState({
            title: `No follow-ups match “${s.q.trim()}”`,
            body: elsewhere(),
            action: h('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'clear', onClick: clearFilter }, 'Clear filter'),
          }),
        ),
      );
    } else {
      const shown = matched.slice(0, s.limit);
      const cols = columns(s.tab);
      const parts = [
        withRoles(
          table({
            columns: cols,
            rows: shown,
            rowKey: 'domain',
            label: `${st.label} follow-ups`,
          }),
          cols,
        ),
      ];
      if (matched.length > shown.length) {
        parts.push(
          h(
            'div',
            { class: 'fu-more' },
            h('span', { class: 'fu-more-count' }, `Showing ${fmtNum(shown.length)} of ${fmtNum(matched.length)}`),
            h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'more', onClick: showMore }, 'Show more'),
          ),
        );
      }
      content.replaceChildren(...parts);
    }
    restoreFocus(focus);
  }

  /** Where the filter does match, when it isn't the open tab. */
  function elsewhere() {
    const hits = STATES.filter((x) => x.id !== s.tab)
      .map((x) => [x, filtered().filter((r) => r.state === x.id).length])
      .filter(([, n]) => n > 0);
    if (!hits.length) return 'No domain or email under any tab contains that text.';
    return `Nothing under ${STATE[s.tab].label}, but ${hits.map(([x, n]) => `${fmtNum(n)} under ${x.label}`).join(' and ')}.`;
  }

  function refreshRow(domain) {
    const tr = rowEls().find((el) => el.dataset.key === domain);
    const r = s.rows && s.rows.find((x) => x.domain === domain);
    const cell = tr && tr.querySelector('.fu-actions');
    if (!r || !cell) return;
    const a = document.activeElement;
    const focused = cell.contains(a) ? a.dataset.action : null;
    const next = actionsCell(r);
    cell.replaceWith(next);
    if (focused) {
      const el = next.querySelector(`[data-action="${focused}"]`);
      if (el) el.focus();
    }
  }

  // ---- Data ----

  async function load() {
    const seq = ++loadSeq;
    s.loading = true;
    if (!s.rows) renderContent();
    const [fu, dr] = await Promise.allSettled([
      api.get('/api/followups', { signal: ac.signal }),
      api.get('/api/drafts', { signal: ac.signal }),
    ]);
    if (s.gone || seq !== loadSeq) return;
    s.loading = false;
    if (fu.status === 'fulfilled') {
      s.rows = Array.isArray(fu.value) ? fu.value : [];
      s.error = null;
      if (jobs.result && jobs.result.before) {
        diffCheck(s.rows);
        renderNotice();
      }
    } else {
      if (s.rows) toast(`Couldn't refresh follow-ups: ${fu.reason && fu.reason.message}`, 'err');
      else s.error = fu.reason || new Error('Unknown error');
      // Without a fresh list there is nothing to compare a finished check against.
      if (jobs.result && jobs.result.before && !jobs.check) {
        jobs.result.before = null;
        renderNotice();
      }
    }
    // The drafts list only adds the "Review draft" hint; without it the rows still work.
    if (dr.status === 'fulfilled' && Array.isArray(dr.value)) {
      s.pending = new Set(dr.value.map((d) => String(d.domain).toLowerCase()));
    }
    updateCounts();
    renderContent();
  }

  async function refreshStore() {
    selfRefresh = true;
    try {
      const snap = await store.refresh();
      sig = sigOf(snap && snap.summary);
    } finally {
      selfRefresh = false;
    }
  }

  // Work done elsewhere (a chat turn, a scheduled run) changes the summary's counts: reload then.
  const unsubscribe = store.subscribe(({ summary }) => {
    const next = sigOf(summary);
    if (next === sig) return;
    const changed = sig !== null;
    sig = next;
    if (changed && !selfRefresh && s.rows && !s.gone) load();
  });

  // ---- Actions ----

  function onTab(id) {
    s.tab = id;
    s.limit = PAGE;
    revealFrom = null;
    renderContent();
    nav.setQuery({ tab: id === 'due' ? null : id });
  }

  function showMore() {
    revealFrom = s.limit;
    s.limit += PAGE;
    renderContent();
  }

  function clearFilter() {
    onFilter.cancel();
    filterInput.value = '';
    s.q = '';
    s.limit = PAGE;
    renderContent();
    filterInput.focus();
    nav.setQuery({ q: null });
  }

  function retry() {
    s.error = null;
    load();
  }

  function startCheck() {
    if (jobs.check) return;
    const contacts = s.rows ? s.rows.filter((r) => (r.state === 'due' || r.state === 'awaiting') && r.to).length : null;
    // Snapshot the states, so the result can say who replied or bounced whatever the agent
    // reports (some providers return no summary text at all).
    const before = contacts ? new Map(s.rows.map((r) => [r.domain, r.state])) : null;
    runCheck(contacts, before);
    renderCheck();
    announce('Checking Gmail for replies.');
  }

  function draftFollowup(domain) {
    if (jobs.drafting.has(domain) || s.marking.has(domain)) return;
    runDraft(domain);
    refreshRow(domain);
    announce(`Drafting a follow-up for ${domain}.`);
  }

  async function mark(domain, value) {
    if (s.marking.has(domain) || jobs.drafting.has(domain)) return;
    s.marking.set(domain, value);
    refreshRow(domain);
    let ok = false;
    try {
      await api.post(`/api/followups/${encodeURIComponent(domain)}/mark`, { value });
      ok = true;
      toast(`Marked ${domain} as ${value}.`, 'ok');
    } catch (err) {
      if (!s.gone) toast((err && err.message) || String(err), 'err');
    } finally {
      s.marking.delete(domain);
    }
    if (s.gone) {
      store.refresh();
      return;
    }
    if (ok) await load();
    else refreshRow(domain);
    refreshStore();
  }

  function applyQuery(query) {
    const tab = tabFrom(query);
    const q = (query && query.q) || '';
    let changed = false;
    if (tab !== s.tab) {
      s.tab = tab;
      tabsEl.setActive(tab);
      changed = true;
    }
    if (q !== s.q) {
      onFilter.cancel();
      s.q = q;
      if (filterInput.value !== q) filterInput.value = q;
      changed = true;
    }
    if (changed) {
      s.limit = PAGE;
      revealFrom = null;
      renderContent();
    }
  }

  screen = {
    applyQuery,
    afterCheck() {
      renderCheck();
      if (jobs.result) announce(jobs.result.title);
      load();
      refreshStore();
    },
    afterDraft(domain) {
      refreshRow(domain);
      load();
      refreshStore();
    },
  };

  renderCheck();
  updateCounts();
  load();

  return () => {
    s.gone = true;
    if (screen && screen.applyQuery === applyQuery) screen = null;
    ac.abort();
    onFilter.cancel();
    clearInterval(ticker);
    ticker = null;
    unsubscribe();
  };
}

export default {
  title,
  css: true,
  mount,
  update(ctx) {
    if (!screen) return false;
    screen.applyQuery(ctx.query);
    return true;
  },
};

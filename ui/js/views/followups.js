// Follow-ups (spec §5.5): everyone already contacted, by state — Due / Awaiting / Replied /
// Bounced — from GET /api/followups, filterable, at most 100 rows at a time. Row actions: Draft
// follow-up (POST /api/followups/:domain/draft, one agent turn), Mark replied / Mark bounced
// (POST /api/followups/:domain/mark). Header action: Check for replies (POST
// /api/followups/check, one agent turn that reads Gmail). GET /api/drafts tells which due rows
// already have an email draft waiting, so a second follow-up isn't drafted by accident.
//
// Agent turns take minutes and the server keeps running them whatever the page does, so they
// belong to the page, not the screen: leaving Follow-ups never cancels one, coming back shows its
// progress or result, and one that ends elsewhere says so in a toast. Everything the screen
// itself starts (fetches, the elapsed-time ticker, its store subscription) stops on unmount.

import { api, errorText } from '../core/api.js';
import { debounce, fmtNum, h, pluralize, truncate } from '../core/dom.js';
import { renderMarkdown } from '../core/markdown.js';
import { href } from '../core/router.js';
import { store } from '../core/store.js';
import { setBusy, toast } from '../core/ui.js';
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
/** The tab a row is listed under. A state this UI doesn't know (the server only sends the four
 *  above today) still shows, under Awaiting, with its raw label. */
const tabOf = (r) => (STATE[r.state] ? r.state : 'awaiting');
const isOpen = (r) => r.state === 'due' || r.state === 'awaiting';
const lower = (s) => String(s ?? '').toLowerCase();
/** Follow-ups are always email: a LinkedIn draft for the same company is not one. */
const isEmailDraft = (d) => !!d && (d.channel || 'email') === 'email';

// ---- Agent turns: page-lifetime state ----

const jobs = {
  // While a reply check runs: { startedAt, contacts, before: Map(domain → state) | null,
  // manual: Set(domain) marked by hand meanwhile, so the result doesn't credit the check }.
  check: null,
  result: null, // { tone, title, message, markdown, changes?, at } of the last check, until dismissed
  drafting: new Set(), // domains whose follow-up the agent is writing
};
let screen = null; // hooks of the mounted screen, or null

/** Contacts a reply check covers: due or awaiting, with an email (the server's own rule). */
const checkable = (rows) => rows.filter((r) => isOpen(r) && r.to).length;

/** Start a reply check. `rows` (the list on screen, or null) gives the progress line its count
 *  at once; `manual` holds the domains being marked by hand right now. */
function runCheck(rows, manual) {
  const job = { startedAt: Date.now(), contacts: rows ? checkable(rows) : null, before: null, manual };
  jobs.check = job;
  jobs.result = null;
  (async () => {
    // Snapshot every state before the agent starts, so the result can say who replied or
    // bounced whatever the agent reports. Read it from the server, not the screen: the list on
    // screen can be a store refresh old, or not yet reloaded after a mark that just finished,
    // and either would credit the check with a change it didn't make.
    let list = null;
    try {
      list = await api.get('/api/followups');
    } catch (_) {
      // The check itself may still work: fall back to the rows on screen.
    }
    if (!Array.isArray(list)) list = rows;
    if (list) {
      const n = checkable(list);
      job.before = n ? new Map(list.map((r) => [r.domain, r.state])) : null;
      if (n !== job.contacts) {
        job.contacts = n;
        if (screen) screen.checkProgress();
      }
    }
    let result;
    try {
      const r = await api.post('/api/followups/check', {});
      result =
        r && r.ok
          ? { tone: 'ok', title: 'Reply check finished', message: r.message || null, markdown: true }
          : { tone: 'warn', title: "Couldn't check for replies", message: (r && r.message) || 'The agent could not check Gmail.', markdown: true };
    } catch (err) {
      result = { tone: 'err', title: 'Reply check failed', message: errorText(err), markdown: false };
    }
    // Who it moved to replied / bounced, read from the list right away (not when Follow-ups
    // next loads, which would also count changes made elsewhere meanwhile).
    if (result.tone === 'ok' && job.before) result.changes = await changesSince(job);
    result.at = new Date();
    jobs.result = result;
    jobs.check = null;
    if (screen) {
      screen.afterCheck();
    } else {
      const ok = result.tone === 'ok';
      const what = ok ? (result.changes ? `Reply check finished: ${changesShort(result.changes)}.` : 'Reply check finished.') : `${result.title}.`;
      toast(`${what} The details are on Follow-ups.`, ok ? 'ok' : 'err');
      store.refresh();
    }
  })();
}

/** { replied: [domain], bounced: [domain] } the check changed, or null if the list didn't load. */
async function changesSince(job) {
  let rows;
  try {
    rows = await api.get('/api/followups');
  } catch (_) {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const changes = { replied: [], bounced: [] };
  for (const row of rows) {
    const was = job.before.get(row.domain);
    if (was && was !== row.state && changes[row.state] && !job.manual.has(row.domain)) changes[row.state].push(row.domain);
  }
  return changes;
}

/** "No new replies or bounces." / "1 new reply (a.example) and 2 bounces (b.example, c.example)." */
function changesText({ replied, bounced }) {
  const list = (ds) => (ds.length > 4 ? `${ds.slice(0, 3).join(', ')} and ${fmtNum(ds.length - 3)} more` : ds.join(', '));
  const parts = [];
  if (replied.length) parts.push(`${pluralize(replied.length, 'new reply', 'new replies')} (${list(replied)})`);
  if (bounced.length) parts.push(`${pluralize(bounced.length, 'bounce')} (${list(bounced)})`);
  return parts.length ? `${parts.join(' and ')}.` : 'No new replies or bounces.';
}

/** "no new replies or bounces" / "1 new reply and 2 bounces" (a toast's short form). */
function changesShort({ replied, bounced }) {
  const parts = [];
  if (replied.length) parts.push(pluralize(replied.length, 'new reply', 'new replies'));
  if (bounced.length) parts.push(pluralize(bounced.length, 'bounce'));
  return parts.length ? parts.join(' and ') : 'no new replies or bounces';
}

/** How many email drafts for `domain` are waiting in Drafts; null when that can't be told. */
async function emailDraftCount(domain) {
  try {
    const list = await api.get('/api/drafts');
    return Array.isArray(list) ? list.filter((d) => isEmailDraft(d) && lower(d.domain) === lower(domain)).length : null;
  } catch (_) {
    return null;
  }
}

function runDraft(domain) {
  jobs.drafting.add(domain);
  (async () => {
    // Saving a follow-up always adds a draft (`coldtrail followup` inserts a row), so count the
    // domain's drafts first: one made elsewhere that this screen hadn't picked up yet must not
    // pass for the agent's.
    const before = await emailDraftCount(domain);
    let r;
    try {
      r = await api.post(`/api/followups/${encodeURIComponent(domain)}/draft`, {});
    } catch (err) {
      toast(`Couldn't draft a follow-up for ${domain}.\n${errorText(err)}`, 'err');
      return;
    }
    if (!(r && r.ok)) {
      toast(`Couldn't draft a follow-up for ${domain}.\n${r && r.message ? mdPlain(r.message) : 'The agent finished without writing one.'}`, 'err');
      return;
    }
    // ok says how the agent's turn ended, not that it saved anything: look in Drafts.
    const after = await emailDraftCount(domain);
    if (after == null || after > (before ?? 0)) {
      toast(`Follow-up drafted for ${domain}. Review it in Drafts.`, 'ok');
    } else if (after > 0) {
      toast(`The agent finished, but no new follow-up draft was saved for ${domain}. An earlier one is waiting in Drafts.`, 'err');
    } else {
      toast(`The agent finished, but no follow-up draft was saved for ${domain}.`, 'err');
    }
  })().finally(() => {
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

/** "Less than a day" / "1 day" / "9 days" since the last send (whole days, as the API counts). */
function sinceLabel(days) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  return d < 1 ? 'Less than a day' : pluralize(d, 'day');
}

/** What comes next for a row still open: which follow-up is due, or when the next one is. A
 *  row without an email can't get a drafted follow-up, so it promises none. */
function nextStep(r) {
  const touches = Number(r.touches) || 0;
  if (r.state === 'awaiting' && touches >= MAX_TOUCHES) return 'No more follow-ups';
  if (!r.to) return null;
  if (r.state === 'due') return `Follow-up ${fmtNum(touches)} of ${fmtNum(MAX_TOUCHES - 1)}`;
  if (r.state === 'awaiting') return `Due in ${pluralize(Math.max(1, DUE_AFTER_DAYS - (Number(r.days) || 0)), 'day')}`;
  return null;
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

// ---- The screen ----

function mount(root, ctx) {
  const nav = ctx.nav;
  const s = {
    tab: tabFrom(ctx.query),
    q: (ctx.query && ctx.query.q) || '',
    limit: PAGE,
    rows: null, // FollowupDto[] once loaded
    pending: new Set(), // lowercased domains with an email draft waiting in Drafts
    error: null,
    loading: false,
    marking: new Map(), // domain → the value being marked
    gone: false,
  };
  const ac = new AbortController();
  let loadSeq = 0;
  let loaded = null; // what the last render showed (rows + pending), to skip identical reloads
  let draftsSeen = null; // the summary's email-draft count when the drafts on hand were asked for
  let ticker = null;
  let elapsedEl = null;
  let selfRefresh = false;
  let revealFrom = null; // first row index shown by the last "Show more"

  // ---- Header ----

  const checkBtn = h(
    'button',
    { type: 'button', class: 'btn btn-secondary fu-check', 'data-action': 'check', onClick: startCheck },
    icon(ICONS.mail),
    h('span', {}, 'Check for replies'),
  );
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
    nav.setQuery({ q: s.q || null }, { silent: true });
  }, FILTER_MS);
  filterInput.addEventListener('input', onFilter);
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onFilter.flush();
  });
  const filterBox = h('div', { class: 'fu-filter' }, icon(ICONS.search), filterInput);
  // The wrapper is the size container the narrow layout (tabs over the filter) is chosen by.
  const tools = h('div', { class: 'fu-toolbar' }, h('div', { class: 'fu-tools' }, tabsEl, filterBox));
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
    return s.rows.filter((r) => lower(r.domain).includes(needle) || lower(r.to).includes(needle));
  }

  // Tab counts follow the filter, so a match under another tab shows where it is.
  function updateCounts() {
    const counts = Object.fromEntries(STATES.map((st) => [st.id, s.rows ? 0 : null]));
    if (s.rows) for (const r of filtered()) counts[tabOf(r)] += 1;
    tabsEl.setCounts(counts);
    // Counts widen the tabs without resizing the list, so the shared component doesn't re-check
    // its overflow fade: its scroll listener does that.
    tabsEl.dispatchEvent(new Event('scroll'));
  }

  function renderCheck() {
    const running = !!jobs.check;
    setBusy(checkBtn, running, { label: 'Checking for replies…' });
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
    const mark = tone === 'progress' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon(ICONS[tone] || ICONS.ok, 18);
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
          n ? `Checking Gmail for replies from ${pluralize(n, 'contact')}…` : 'Checking Gmail for replies…',
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
        // coldtrail's own summary (from the list), then whatever the agent reported.
        body = [
          r.changes ? h('p', { class: 'fu-notice-text fu-changes' }, changesText(r.changes)) : null,
          r.message ? mdBlock(r.message) : null,
          !r.changes && !r.message ? h('p', { class: 'fu-notice-text' }, 'The agent did not report anything.') : null,
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

  /** A row action. `busy` (a label, or true to keep the text) shows the shared busy state. */
  function actButton({ action, domain, text, aria, kind = 'ghost', busy = false, disabled = false, onClick }) {
    const b = h(
      'button',
      {
        type: 'button',
        class: `btn btn-${kind} btn-sm`,
        'data-action': action,
        'data-domain': domain,
        'aria-label': aria,
        'aria-disabled': disabled ? 'true' : null,
        onClick,
      },
      text,
    );
    if (busy) setBusy(b, true, typeof busy === 'string' ? { label: busy } : {});
    return b;
  }

  function actionsCell(r) {
    const domain = r.domain;
    const drafting = jobs.drafting.has(domain);
    const marking = s.marking.has(domain);
    const box = h('div', { class: 'fu-actions' });
    if (r.state === 'due' && r.to) {
      if (!drafting && s.pending.has(lower(domain))) {
        box.append(
          h('a', { class: 'btn btn-secondary btn-sm', href: href(['drafts', domain]), 'data-action': 'review', 'data-domain': domain, 'aria-label': `Review draft, ${domain}` }, 'Review draft'),
        );
      } else {
        box.append(
          actButton({
            action: 'draft',
            domain,
            kind: 'secondary',
            text: 'Draft follow-up',
            aria: `${drafting ? 'Drafting follow-up' : 'Draft follow-up'}, ${domain}`,
            busy: drafting ? 'Drafting…' : false,
            disabled: marking,
            onClick: () => draftFollowup(domain),
          }),
        );
      }
    }
    if (isOpen(r)) {
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
        // data-unit: the word the card layout adds after the number (CSS generated content).
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
      target = filterBox.hidden ? null : filterInput;
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
      // While loading the filter can be typed into (it applies once the rows land); after a
      // failed load there is nothing for it to filter.
      filterBox.hidden = !!s.error;
      if (s.error) {
        content.setAttribute('aria-busy', 'false');
        content.replaceChildren(
          panel(
            emptyState({
              title: "Couldn't load follow-ups",
              body: errorText(s.error),
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
    const inTab = s.rows.filter((r) => tabOf(r) === s.tab);
    const matched = filtered().filter((r) => tabOf(r) === s.tab);
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
      // Explicit roles: the card layout restyles the rows, which would drop the implicit ones.
      // A class per column places each cell in that layout.
      const parts = [
        table({
          columns: columns(s.tab),
          rows: shown,
          rowKey: 'domain',
          label: `${st.label} follow-ups`,
          roles: true,
          cellClass: (col) => `fu-c-${col.key}`,
        }),
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
      .map((x) => [x, filtered().filter((r) => tabOf(r) === x.id).length])
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

  /** Fetch the list and the drafts. `quiet` (a background check for changes made elsewhere):
   *  skipped while another load runs, no error toast, no re-render when nothing changed, and
   *  the drafts list (bodies and all) only when the summary's email-draft count has moved. */
  async function load({ quiet = false } = {}) {
    if (quiet && s.loading) return;
    const seq = ++loadSeq;
    s.loading = true;
    if (!s.rows) renderContent();
    // Read before fetching: a count that moves while the list is on its way is caught next time.
    const drafts = emailDraftTotal();
    const withDrafts = !quiet || drafts == null || drafts !== draftsSeen;
    const [fu, dr] = await Promise.allSettled([
      api.get('/api/followups', { signal: ac.signal }),
      withDrafts ? api.get('/api/drafts', { signal: ac.signal }) : null,
    ]);
    if (s.gone || seq !== loadSeq) return;
    s.loading = false;
    if (fu.status === 'fulfilled') {
      s.rows = Array.isArray(fu.value) ? fu.value : [];
      s.error = null;
    } else if (!quiet) {
      if (s.rows) toast(`Couldn't refresh follow-ups: ${errorText(fu.reason)}`, 'err');
      else s.error = fu.reason || new Error('Unknown error');
    }
    // The drafts list only adds the "Review draft" hint; without it the rows still work.
    if (withDrafts && dr.status === 'fulfilled' && Array.isArray(dr.value)) {
      s.pending = new Set(dr.value.filter(isEmailDraft).map((d) => lower(d.domain)));
      draftsSeen = drafts;
    }
    const now = s.rows ? JSON.stringify([s.rows, [...s.pending].sort()]) : null;
    if (quiet && now === loaded) {
      content.setAttribute('aria-busy', 'false');
      return;
    }
    loaded = now;
    renderContent();
  }

  /** The summary's count of email drafts waiting, or null if there is no summary yet. */
  function emailDraftTotal() {
    const { summary } = store.get();
    const n = summary && summary.counts ? summary.counts.drafts_email : null;
    return Number.isFinite(n) ? n : null;
  }

  async function refreshStore() {
    selfRefresh = true;
    try {
      await store.refresh();
    } finally {
      selfRefresh = false;
    }
  }

  // Work done elsewhere (a chat turn or scheduled run marking a reply or bounce, a draft made or
  // discarded on another screen) shows up on the store's next refresh. Not every such change
  // moves the summary's counts (a bounce on an Awaiting row doesn't), so look at the list itself
  // each time: one cheap GET, and nothing is redrawn unless it changed. The drafts list is
  // heavier, and a draft made or discarded does move the email-draft count, so load() asks for
  // it only when that count has changed.
  const unsubscribe = store.subscribe(() => {
    if (selfRefresh || s.gone || !s.rows) return;
    load({ quiet: true });
  });

  // ---- Actions ----

  function onTab(id) {
    s.tab = id;
    s.limit = PAGE;
    revealFrom = null;
    renderContent();
    nav.setQuery({ tab: id === 'due' ? null : id }, { silent: true });
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
    nav.setQuery({ q: null }, { silent: true });
  }

  function retry() {
    s.error = null;
    load();
  }

  function startCheck() {
    if (jobs.check) return;
    // A mark already on its way is the user's, not the check's.
    runCheck(s.rows, new Set(s.marking.keys()));
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
    // A reply check running now must not report this mark as something it found.
    const job = jobs.check;
    if (job) job.manual.add(domain);
    s.marking.set(domain, value);
    refreshRow(domain);
    let ok = false;
    try {
      await api.post(`/api/followups/${encodeURIComponent(domain)}/mark`, { value });
      ok = true;
      toast(`Marked ${domain} as ${value}.`, 'ok');
    } catch (err) {
      if (job) job.manual.delete(domain);
      // Toasts are page-level: say so even if the user has moved on.
      toast(`Couldn't mark ${domain} as ${value}.\n${errorText(err)}`, 'err');
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
    checkProgress: renderNotice,
    afterCheck() {
      renderCheck();
      const r = jobs.result;
      if (r) announce(r.changes ? `${r.title}. ${changesText(r.changes)}` : r.title);
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

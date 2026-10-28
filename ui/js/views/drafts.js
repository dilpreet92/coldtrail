// Drafts (spec §5.4): the review queue. Tabs All / Email / LinkedIn with counts, a filter, a list
// that renders at most 100 rows at a time ("Show more"), and the selected draft beside it. J / K
// move, Enter jumps into the editor, Esc returns to the list. Edits autosave (600ms debounce) and
// are flushed before switching drafts, leaving the screen, or any send. Email drafts create a
// Gmail draft or send now; LinkedIn notes open in LinkedIn (then "Did it send?") or send through
// coldtrail; parked LinkedIn drafts say why auto-send skips them. Send all… states exactly what
// goes out before anything does; while it runs (even after the dialog closes or the screen is
// left and reopened) Send all shows its progress and nothing else can send the same drafts. The
// LinkedIn pollers (one row, or the bulk sender) stop when the screen unmounts and pick up again
// when it comes back. coldtrail's own LinkedIn sends (Send invite, Send all) mirror the sender's
// stops: none are offered while LinkedIn is signed out or outside 08:00–20:00 local. Open in
// LinkedIn, the manual path, never waits.
//
// Data: GET /api/drafts (the queue), /api/companies?stage=drafted (company names for the rows;
// then stage=sent, for follow-up drafts, when some are still unnamed),
// /api/companies/:domain (the selected draft's contact and source), the shared store (status for
// auto-send and caps, summary for the empty state). DraftDto carries no names, so rows fall back to
// the domain and the recipient until those lookups land (or when they fail).

import { api } from '../core/api.js';
import { debounce, fmtNum, h, pluralize, safeUrl } from '../core/dom.js';
import { bindKeys } from '../core/keys.js';
import { confirmDialog, openDialog, toast } from '../core/ui.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/emptyState.js';
import { listDetail } from '../components/listDetail.js';
import { tabs } from '../components/tabs.js';

const TITLE = 'Drafts';
const PAGE = 100; // list rows rendered at a time
const SAVE_MS = 600;
const FILTER_URL_MS = 250;
const NOTE_MAX = 300; // LinkedIn connection-note limit
const ROW_POLL_MS = 2000;
const ROW_TIMEOUT_MS = 240_000; // covers up to ~2 min pacing plus the drive
const BULK_POLL_MS = 3000;
const BULK_TIMEOUT_MS = 30 * 60_000;
const BULK_STATUS_EVERY = 2; // bulk polls between status refreshes (caps, the LinkedIn session)
const LI_HOURS = [8, 20]; // linkedin::send::within_window: invites go out 08:00–20:00 local
const NAME_PER = 200;
const NAME_PAGES = 5;
const NAME_STAGES = ['drafted', 'sent']; // company stages the names lookup reads, in turn
const GMAIL_DRAFTS = 'https://mail.google.com/mail/u/0/#drafts';
const TAB_IDS = ['all', 'email', 'linkedin'];
const TAB_KEY = 'ct-drafts-tab';
const SEND_OK_KEY = 'ct-send-confirmed'; // + '-email' / '-linkedin': one first-send confirm per channel
const BULK_KEY = 'ct-li-bulk';
const WIDE = '(min-width: 900px)';
// A refusal that applies to every email, not just one: stop the bulk loop instead of repeating it.
const EMAIL_GATE = /dry run|cap reached|auto-send is off|isn't connected|not connected/i;

// Page-lifetime state (kept across remounts, gone on reload — except what sessionStorage holds).
const staged = new Set(); // LinkedIn drafts opened with assist, waiting for "Did it send?"
const rowSends = new Map(); // key -> { at, timedOut }: per-row LinkedIn sends being watched
const pushing = new Set(); // email drafts being sent / put in Gmail one at a time (Send now)
const companies = new Map(); // domain -> { name, founder, email, source_query, contacts, full }
const sendConfirmed = new Set(); // channels whose first send this session was confirmed
let active = null; // the mounted view: { update, destroy, runChanged, reload }
// The Send all run while it goes: { auto, i, n, li } (email send mode, the email being sent, how
// many, whether it starts the LinkedIn sender after them). It outlives the view that started it,
// so a remount still sees it: Send all and Send now stay disabled until it ends.
let run = null;

const runChanged = () => {
  if (active) active.runChanged();
};

const ICONS = {
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
  alert: ['M12 3l9.5 17h-19L12 3z', 'M12 10v4', 'M12 17.5v.01'],
  check: 'M5 12.5l4.5 4.5L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  back: 'M15 6l-6 6 6 6',
};

function icon(paths, size = 16) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    [].concat(paths).map((d) => h('path', { d })),
  );
}

function readStore(kind, key) {
  try {
    return window[kind].getItem(key);
  } catch (_) {
    return null;
  }
}

function writeStore(kind, key, value) {
  try {
    if (value == null) window[kind].removeItem(key);
    else window[kind].setItem(key, value);
  } catch (_) {
    /* storage unavailable: the in-memory state still works for this page */
  }
}

/**
 * The running LinkedIn bulk send, or null: { at, want, keys } (when it started, how many invites
 * it should send today, the LinkedIn drafts it was queued from). Kept in sessionStorage, so it
 * survives a reload of the tab.
 */
function bulkRun() {
  try {
    const v = JSON.parse(readStore('sessionStorage', BULK_KEY) || 'null');
    if (!v || typeof v !== 'object' || !Number.isFinite(v.at) || v.at <= 0) return null;
    return { at: v.at, want: Math.max(0, Number(v.want) || 0), keys: Array.isArray(v.keys) ? v.keys.map(String) : [] };
  } catch (_) {
    return null;
  }
}

/** When the running LinkedIn bulk send started (ms), or 0. */
function bulkStart() {
  const b = bulkRun();
  return b ? b.at : 0;
}

/** Send invite waits while the bulk sender runs, or is about to (after a Send all's emails).
 *  Open in LinkedIn never waits: if the window is busy the server says so. */
const liBlocked = () => !!bulkStart() || !!(run && run.li);

const hh = (hour) => `${String(hour).padStart(2, '0')}:00`;
const LI_WINDOW_TEXT = `between ${hh(LI_HOURS[0])} and ${hh(LI_HOURS[1])} your time`;

/**
 * Why coldtrail can't send LinkedIn invites itself right now, or null when it can: the stops the
 * sender (`linkedin::send::deliver`, `send-pending`) hits before sending anything. 'reconnect':
 * the session expired; 'connect': LinkedIn was never connected; 'window': outside 08:00–20:00
 * local. (Auto-send and the caps are checked on their own.)
 */
function liGate(status, now = new Date()) {
  const st = status || {};
  if (st.linkedin_reconnect_needed) return 'reconnect';
  if (!st.linkedin_connected) return 'connect';
  const hour = now.getHours();
  return hour >= LI_HOURS[0] && hour < LI_HOURS[1] ? null : 'window';
}

const connectionsLink = () => h('a', { href: '#/settings?tab=connections' }, 'Settings → Connections');

/** A gate as a sentence ending in `tail` (strings and nodes, for h()). */
function gateText(gate, tail) {
  if (gate === 'reconnect') return [`LinkedIn is signed out, so ${tail} Reconnect it in `, connectionsLink(), '.'];
  if (gate === 'connect') return [`LinkedIn isn’t connected, so ${tail} Connect it in `, connectionsLink(), '.'];
  return [`LinkedIn invites go out ${LI_WINDOW_TEXT}, so ${tail}`];
}

/** The same, as plain text (for a toast). */
function gatePlain(gate) {
  if (gate === 'reconnect') return 'LinkedIn is signed out: reconnect it in Settings → Connections.';
  if (gate === 'connect') return 'LinkedIn isn’t connected: connect it in Settings → Connections.';
  return `LinkedIn invites go out ${LI_WINDOW_TEXT}.`;
}
/** Email sends wait while a Send all works through the emails (and until the queue reloads). */
const emailBlocked = () => !!(run && run.n);

const enc = encodeURIComponent;
const lower = (v) => (v == null ? '' : String(v).toLowerCase());

function toItem(d) {
  const channel = d.channel === 'linkedin' ? 'linkedin' : 'email';
  const domain = String(d.domain || '');
  const it = {
    key: `${channel}:${domain}`,
    domain,
    channel,
    to: d.to || null,
    subject: d.subject == null ? '' : String(d.subject),
    body: d.body == null ? '' : String(d.body),
    status: d.status === 'drafted' ? 'drafted' : 'draft_pending',
    parked: d.auto_skip || null,
    extra: 0, // older drafts on the same domain + channel, folded into this row
  };
  it.saved = snapshot(it);
  return it;
}

// What a save would write: email drafts save subject + body, LinkedIn notes only the body.
function snapshot(it) {
  return it.channel === 'email' ? JSON.stringify([it.subject, it.body]) : JSON.stringify([it.body]);
}
const isDirty = (it) => !!it && snapshot(it) !== it.saved;
const payloadOf = (it) => (it.channel === 'email' ? { subject: it.subject, body: it.body } : { body: it.body });
const editable = (it) => it.channel === 'linkedin' || it.status === 'draft_pending';
const overLimit = (it) => it.channel === 'linkedin' && it.body.length > NOTE_MAX;

function mergeCompany(domain, patch) {
  const next = { ...(companies.get(domain) || {}) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
  companies.set(domain, next);
}

/** The contact this draft goes to, when a lookup says who that is. */
function contactFor(it) {
  const c = companies.get(it.domain);
  const to = lower(it.to);
  if (!c || !to) return null;
  if (c.contacts) {
    const hit = c.contacts.find((k) => lower(it.channel === 'linkedin' ? k.linkedin_url : k.email) === to);
    if (hit) return hit;
  }
  if (it.channel === 'email' && c.founder && lower(c.email) === to) return { founder_name: c.founder, email: c.email };
  return null;
}

function linkedinHandle(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}`.replace(/\/+$/, '');
  } catch (_) {
    return String(url);
  }
}

function recipientText(it) {
  if (!it.to) return it.channel === 'linkedin' ? 'No LinkedIn profile on file' : 'No email address on file';
  return it.channel === 'linkedin' ? linkedinHandle(it.to) : it.to;
}

// The list's shorter form: "in/jane-roe-12" rather than the full profile URL.
function shortRecipient(it) {
  const r = recipientText(it);
  return it.channel === 'linkedin' && it.to ? r.replace(/^linkedin\.com\//i, '') : r;
}

function labelsOf(it) {
  const c = companies.get(it.domain);
  const company = (c && c.name) || null;
  const k = contactFor(it);
  const person = (k && k.founder_name) || null;
  return { company, person, role: (k && k.role) || null, title: company || it.domain, recipient: recipientText(it) };
}

const firstName = (name) => String(name).trim().split(/\s+/)[0];

function initials(s) {
  const words = String(s).match(/[\p{L}\p{N}]+/gu) || [];
  return (words.slice(0, 2).map((w) => w[0]).join('') || '·').toUpperCase();
}

function noteLink(text) {
  const m = String(text).match(/https?:\/\/[^\s<>"']+/i);
  return m ? safeUrl(m[0].replace(/[.,;:!?)\]]+$/, '')) : '';
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function chanTag(channel) {
  return h('span', { class: ['chan-tag', `chan-tag-${channel}`] }, channel === 'linkedin' ? 'LinkedIn' : 'Email');
}

function field(label, control, id) {
  return h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), control);
}

function readOnly(label, value, extra) {
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label' }, label),
    h('div', { class: ['draft-ro', extra] }, value || '—'),
  );
}

function skeletonRows(n) {
  return Array.from({ length: n }, () =>
    h(
      'div',
      { class: 'draft-row draft-row-skeleton', 'aria-hidden': 'true' },
      h('span', { class: 'draft-avatar skeleton' }),
      h('span', { class: 'draft-row-text' }, h('span', { class: 'skeleton', style: 'width: 60%' }), h('span', { class: 'skeleton', style: 'width: 85%' })),
    ),
  );
}

function createView(root, ctx) {
  const { nav, store } = ctx;
  const wide = window.matchMedia(WIDE);
  const ctl = new AbortController();
  let alive = true;
  let companyCtl = null;
  let rowTimer = null;
  let bulkTimer = null;
  let namesLoading = false;
  const namesTried = new Set(); // domains a names lookup has already covered, found or not
  let loading = 0; // queue fetches in flight
  let pushedSelection = false; // the current selection pushed a history entry (phone)
  let listY = null; // phone: the page's scroll when a draft opened from the list
  let openingSendAll = false;
  let d = null; // the rendered detail: refs + signatures

  const pickTab = (t) => {
    if (TAB_IDS.includes(t)) return t;
    const saved = readStore('localStorage', TAB_KEY);
    return TAB_IDS.includes(saved) ? saved : 'all';
  };

  const s = {
    items: null, // null while the first load runs
    error: null,
    loadSeq: 0,
    tab: pickTab(ctx.query.tab),
    q: ctx.query.q || '',
    limit: PAGE,
    key: null,
    missing: null, // a URL domain with no draft
    refocus: null, // the row to focus once a phone "back" lands
    want: { domain: ctx.path[1] || null, channel: ctx.query.channel || null },
    status: store.get().status,
    summary: store.get().summary,
  };

  // ---- Page frame ----

  const sendAllBtn = h('button', { type: 'button', class: 'btn btn-secondary', disabled: true, onClick: () => openSendAll() }, 'Send all…');
  const desc = h('p', { class: 'page-desc' });
  const head = h(
    'div',
    { class: 'page-head' },
    h('div', { class: 'page-head-text' }, h('h1', {}, TITLE), desc),
    h('div', { class: 'page-actions' }, sendAllBtn),
  );
  const tabBar = tabs({
    items: [
      { id: 'all', label: 'All', count: 0 },
      { id: 'email', label: 'Email', count: 0 },
      { id: 'linkedin', label: 'LinkedIn', count: 0 },
    ],
    active: s.tab,
    label: 'Channel',
    onChange: (id) => setTab(id),
  });
  const stats = h('p', { class: 'drafts-stats' });
  const bar = h('div', { class: 'drafts-bar' }, tabBar, stats);

  const filter = h('input', {
    type: 'search',
    class: 'input drafts-filter-input',
    placeholder: 'Filter by name or subject', // fits the narrowest list column (264px)
    'aria-label': 'Filter drafts',
    autocomplete: 'off',
    spellcheck: 'false',
    value: s.q,
    onInput: onFilterInput,
    onKeydown: onFilterKey,
  });
  const listbox = h('div', { role: 'listbox', class: 'drafts-list', 'aria-label': 'Drafts', onKeydown: onListKey });
  const listMsg = h('div', { class: 'drafts-listmsg', hidden: true });
  const shown = h('p', { class: 'drafts-shown' });
  const moreBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: showMore });
  const moreRow = h('div', { class: 'drafts-more', hidden: true }, shown, moreBtn);
  const keysHint = h(
    'p',
    { class: 'drafts-keys' },
    h('kbd', { class: 'kbd' }, 'J'),
    h('kbd', { class: 'kbd' }, 'K'),
    h('span', {}, 'move'),
    h('kbd', { class: 'kbd' }, 'Enter'),
    h('span', {}, 'edit'),
    h('kbd', { class: 'kbd' }, 'Esc'),
    h('span', {}, 'list'),
  );
  const listPane = h(
    'div',
    { class: 'drafts-listpane' },
    h('div', { class: 'drafts-filter' }, icon(ICONS.search, 15), filter),
    listbox,
    listMsg,
    moreRow,
    keysHint,
  );
  const detailPane = h('section', { class: 'drafts-detail', 'aria-label': 'Selected draft' });
  const ld = listDetail({ list: listPane, detail: detailPane });
  ld.classList.add('drafts-ld');
  const body = h('div', { class: 'drafts-body' });
  root.append(h('div', { class: 'drafts' }, head, bar, body));

  // ---- Lookups ----

  const find = (key) => (s.items ? s.items.find((it) => it.key === key) : null) || null;
  const inTab = (it) => s.tab === 'all' || it.channel === s.tab;
  const tabItems = () => (s.items || []).filter(inTab);
  const sharedDomain = (it) => (s.items || []).some((o) => o.domain === it.domain && o.key !== it.key);

  function matches(it, q) {
    if (!q) return true;
    const l = labelsOf(it);
    return [it.domain, it.to, it.subject, l.company, l.person].some((v) => v && lower(v).includes(q));
  }
  const visibleItems = () => {
    const q = s.q.trim().toLowerCase();
    return tabItems().filter((it) => matches(it, q));
  };

  // Drafts as the server counts them (rows), so the tabs agree with the sidebar and the summary:
  // a row folded into another one (same domain + channel) still counts.
  function counts() {
    const all = s.items || [];
    const n = (list) => list.reduce((sum, it) => sum + 1 + it.extra, 0);
    return {
      all: n(all),
      email: n(all.filter((it) => it.channel === 'email')),
      linkedin: n(all.filter((it) => it.channel === 'linkedin')),
    };
  }

  function caps() {
    const st = s.status || {};
    return {
      auto: !!st.auto_send,
      cap: st.daily_send_cap || 20,
      // Emails sent today, or null: /api/status doesn't report it yet (deliver::sent_today).
      emailToday: Number.isFinite(st.email_sent_today) ? st.email_sent_today : null,
      liAuto: !!st.linkedin_auto_send,
      daily: st.linkedin_daily_cap || 15,
      weekly: st.linkedin_weekly_cap || 80,
      today: st.linkedin_sent_today || 0,
      week: st.linkedin_sent_7d || 0,
      gate: liGate(s.status), // why coldtrail can't send LinkedIn invites now, or null
    };
  }

  // ---- Header ----

  function describe() {
    const c = caps();
    const n = counts()[s.tab];
    if (!n) return 'Nothing waiting for review.';
    const lead = `${fmtNum(n)} waiting for review.`;
    const liCaps = `${c.daily} a day, ${c.weekly} a week`;
    if (s.tab === 'email') {
      return c.auto
        ? `${lead} Send now emails it from your Gmail right away, up to ${c.cap} a day.`
        : `${lead} Create Gmail draft puts it in your Gmail Drafts; you send it from there. Pace a new mailbox at about 5 a day.`;
    }
    if (s.tab === 'linkedin') {
      return c.liAuto
        ? `${lead} Send invite sends it from your LinkedIn within your caps: ${liCaps}.`
        : `${lead} Open in LinkedIn fills in your note; you click Send there.`;
    }
    const parts = [lead];
    if (c.liAuto) parts.push(`LinkedIn invites send within your caps: ${liCaps}.`);
    if (c.auto) parts.push(`Email sends stop at ${c.cap} a day.`);
    if (!c.liAuto && !c.auto) parts.push('Nothing goes out until you send it.');
    return parts.join(' ');
  }

  function statsLine() {
    if (!s.status) return [];
    const c = caps();
    const num = (t) => h('span', { class: 'num' }, t);
    const email = c.auto ? ['Email auto-send on · cap ', num(`${c.cap}/day`)] : ['Email auto-send off'];
    const li = [
      num(`${c.today}/${c.daily}`), ' today · ', num(`${c.week}/${c.weekly}`), ' this week',
    ];
    if (s.tab === 'email') return c.auto ? ['Auto-send on · cap ', num(`${c.cap}/day`)] : ['Auto-send off'];
    if (s.tab === 'linkedin') return [`Auto-send ${c.liAuto ? 'on' : 'off'} · `, ...li];
    return [...email, ' · LinkedIn ', ...li];
  }

  /** What a running send blocks on `tab`, as Send all's label, or null when it is free. One
   *  Send all runs at a time; the LinkedIn sender it starts blocks only the tabs it covers. */
  function busyLabel(tab) {
    if (run) {
      if (run.i < run.n) return `${run.auto ? 'Sending email' : 'Creating draft'} ${fmtNum(run.i + 1)} of ${fmtNum(run.n)}…`;
      return run.li ? 'Starting LinkedIn…' : `${run.auto ? 'Sending' : 'Creating'}…`;
    }
    if (bulkStart() && tab !== 'email') return 'Sending on LinkedIn…';
    return null;
  }

  function renderSendAll() {
    const label = busyLabel(s.tab);
    sendAllBtn.textContent = label || 'Send all…';
    // While a send runs the button says how far it got. aria-disabled rather than disabled keeps
    // it focusable, so focus has somewhere to land when the Send all dialog closes mid-run.
    sendAllBtn.disabled = !label && (!s.items || counts()[s.tab] === 0);
    if (label) sendAllBtn.setAttribute('aria-disabled', 'true');
    else sendAllBtn.removeAttribute('aria-disabled');
  }

  function renderHeader() {
    tabBar.setCounts(counts());
    desc.textContent = s.items ? describe() : 'Loading the review queue…';
    stats.replaceChildren(...statsLine());
    renderSendAll();
  }

  // ---- Body: loading / error / empty / list + detail ----

  function errorPanel() {
    const expired = s.error && s.error.status === 401;
    return h(
      'div',
      { class: 'drafts-panel' },
      emptyState({
        title: 'Couldn’t load drafts',
        body: expired ? 'This tab’s session ended; see the message above.' : (s.error && s.error.message) || 'Something went wrong.',
        action: expired
          ? null
          : h('button', { type: 'button', class: 'btn btn-secondary', onClick: retry }, 'Try again'),
      }),
    );
  }

  function emptyPanel() {
    const sent = s.summary && s.summary.counts ? s.summary.counts.sent : 0;
    return h(
      'div',
      { class: 'drafts-panel' },
      sent > 0
        ? emptyState({
            title: 'No drafts waiting',
            body: `All caught up: ${pluralize(sent, 'message')} sent so far. Replies and follow-ups are in Follow-ups.`,
            action: { label: 'Open Follow-ups', href: '#/followups' },
          })
        : emptyState({
            title: 'No drafts waiting',
            body: 'Drafts appear here when the agent writes outreach for the companies it finds. Ask it to find companies and draft emails or LinkedIn notes.',
            action: { label: 'Open Agent', href: '#/agent' },
          }),
    );
  }

  function renderBody() {
    if (!s.items || !s.items.length) listSig = null; // the list pane shows something else: rebuild next time
    if (s.error && !s.items) {
      body.removeAttribute('aria-busy');
      body.replaceChildren(errorPanel());
      return;
    }
    if (body.firstChild !== ld && (s.items === null || s.items.length)) body.replaceChildren(ld);
    if (s.items === null) {
      body.setAttribute('aria-busy', 'true');
      listbox.hidden = true;
      moreRow.hidden = true;
      listMsg.hidden = false;
      listMsg.replaceChildren(h('p', { class: 'sr-only' }, 'Loading drafts…'), ...skeletonRows(7));
      detailPane.replaceChildren(
        h(
          'div',
          { class: 'draft draft-skeleton', 'aria-hidden': 'true' },
          h('span', { class: 'skeleton', style: 'width: 40%; height: 22px' }),
          h('span', { class: 'skeleton', style: 'width: 65%' }),
          h('span', { class: 'skeleton', style: 'height: 160px' }),
        ),
      );
      return;
    }
    body.removeAttribute('aria-busy');
    if (!s.items.length) {
      body.replaceChildren(emptyPanel());
      return;
    }
    renderList();
  }

  function option(it, tabbable) {
    const l = labelsOf(it);
    const on = it.key === s.key;
    const sub = [l.person || shortRecipient(it), l.company ? it.domain : null].filter(Boolean).join(' · ');
    const tags = [chanTag(it.channel)];
    if (it.parked) tags.push(badge('Parked', 'warn'));
    if (it.extra) tags.push(badge(`${fmtNum(it.extra + 1)} drafts`, 'neutral'));
    if (it.channel === 'email' && it.status === 'drafted') tags.push(badge('In Gmail', 'neutral'));
    if (staged.has(it.key)) tags.push(badge('Opened', 'accent'));
    if (rowSends.has(it.key)) tags.push(rowSends.get(it.key).timedOut ? badge('Unconfirmed', 'warn') : badge('Sending', 'accent'));
    return h(
      'div',
      {
        role: 'option',
        class: ['draft-row', on && 'is-selected'],
        'aria-selected': on ? 'true' : 'false',
        tabindex: tabbable ? '0' : '-1',
        'data-key': it.key,
        'data-domain': it.domain,
        onClick: () => select(it.key, { focusList: true }),
      },
      h('span', { class: 'draft-avatar', 'aria-hidden': 'true' }, initials(l.title)),
      h(
        'span',
        { class: 'draft-row-text' },
        h('span', { class: 'draft-row-title' }, l.title),
        h('span', { class: 'draft-row-sub' }, sub),
      ),
      h('span', { class: 'draft-row-tags' }, tags),
    );
  }

  function filterEmpty() {
    return emptyState({
      title: `No drafts match “${s.q.trim()}”`,
      body: 'The filter looks at company, person, email address, domain and subject.',
      action: h('button', { type: 'button', class: 'btn btn-secondary', onClick: clearFilter }, 'Clear filter'),
    });
  }

  function tabEmpty() {
    const what = s.tab === 'email' ? 'email' : 'LinkedIn';
    return emptyState({
      title: `No ${what} drafts waiting`,
      body: `The other ${pluralize(counts().all, 'draft')} ${counts().all === 1 ? 'is' : 'are'} under All.`,
      action: h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => setTab('all', { focus: true }) }, 'Show all drafts'),
    });
  }

  // Everything a row shows, so a refresh that changes none of it (a poller's every 2–3s) leaves
  // the rows alone rather than replacing them under a click or the keyboard focus.
  function rowSig(it) {
    const l = labelsOf(it);
    return [
      it.key, l.title, l.person || shortRecipient(it), l.company ? 1 : 0, it.parked ? 1 : 0, it.extra, it.status,
      staged.has(it.key) ? 1 : 0, rowSendState(it.key),
    ].join('\u0001');
  }

  let listSig = null; // what the list shows now (rows or a message), or null to rebuild

  function renderList() {
    const focusKey = listbox.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const vis = visibleItems();
    let rows = null;
    let sig;
    if (vis.length) {
      const at = vis.findIndex((it) => it.key === s.key);
      if (at >= s.limit) s.limit = Math.ceil((at + 1) / PAGE) * PAGE;
      rows = vis.slice(0, s.limit);
      sig = ['rows', vis.length, ...rows.map(rowSig)].join('\u0002');
    } else {
      sig = tabItems().length ? `filter\u0002${s.q.trim()}` : `tab\u0002${s.tab}\u0002${counts().all}`;
    }
    if (sig === listSig) {
      // The same rows: only the selection may have moved, and it moves in place.
      if (rows) markSelected();
      else ld.setSelected(!!s.key);
      return;
    }
    listSig = sig;
    if (!rows) {
      listbox.hidden = true;
      listbox.replaceChildren();
      moreRow.hidden = true;
      listMsg.hidden = false;
      listMsg.replaceChildren(tabItems().length ? filterEmpty() : tabEmpty());
    } else {
      listMsg.hidden = true;
      listMsg.replaceChildren();
      listbox.hidden = false;
      const anySelected = rows.some((it) => it.key === s.key);
      listbox.replaceChildren(...rows.map((it, i) => option(it, it.key === s.key || (!anySelected && i === 0))));
      const rest = vis.length - rows.length;
      moreRow.hidden = rest <= 0;
      shown.textContent = `${fmtNum(rows.length)} of ${fmtNum(vis.length)} shown`;
      moreBtn.textContent = `Show ${fmtNum(Math.min(PAGE, rest))} more`;
    }
    ld.setSelected(!!s.key);
    if (focusKey) focusOption(optionEl(focusKey) ? focusKey : s.key);
  }

  const optionEl = (key) => (key ? [...listbox.children].find((el) => el.dataset.key === key) || null : null);

  function markSelected() {
    let found = false;
    for (const el of listbox.children) {
      const on = el.dataset.key === s.key;
      if (on) found = true;
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      el.classList.toggle('is-selected', on);
      el.tabIndex = on ? 0 : -1;
    }
    if (!found && listbox.firstElementChild) listbox.firstElementChild.tabIndex = 0;
    ld.setSelected(!!s.key);
  }

  function focusOption(key, block = 'nearest') {
    let el = optionEl(key);
    if (!el && key && visibleItems().some((it) => it.key === key)) {
      renderList();
      el = optionEl(key);
    }
    if (!el) el = listbox.firstElementChild;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block });
  }

  // Phone, back from a draft: the list scrolled to where it was, its row in view and focused.
  // Placed again a frame later, after the scroll a browser restores when it goes Back.
  function returnToList(key) {
    const y = listY;
    listY = null;
    const place = () => {
      if (!alive || s.key || wide.matches) return;
      if (y != null) window.scrollTo(0, y);
      focusOption(key, y == null ? 'center' : 'nearest');
    };
    place();
    requestAnimationFrame(place);
  }

  function showMore() {
    const before = listbox.children.length;
    const fromButton = document.activeElement === moreBtn;
    s.limit += PAGE;
    renderList();
    if (!fromButton) return;
    // The keyboard stays on the button while there is more; once it's gone, on the first new row.
    const first = listbox.children[before];
    if (!moreRow.hidden) moreBtn.focus();
    else if (first) first.focus();
  }

  // ---- Selection and the URL ----

  function syncUrl({ replace = true } = {}) {
    const it = s.key ? find(s.key) : null;
    const path = it ? ['drafts', it.domain] : s.missing ? ['drafts', s.missing] : ['drafts'];
    const query = {
      tab: s.tab === 'all' ? null : s.tab,
      q: s.q.trim() || null,
      channel: it && sharedDomain(it) ? it.channel : null,
    };
    const to = nav.href(path, query);
    if (to === location.hash) return;
    nav.navigate(to, { replace });
  }

  function resolveKey(domain, channel) {
    const dom = lower(domain);
    const hits = (s.items || []).filter((it) => it.domain === dom && (!channel || it.channel === channel));
    const hit = hits.find(inTab) || hits[0];
    return hit ? hit.key : null;
  }

  // A deep link to a draft on another channel's tab shows it under All, so the list agrees.
  function ensureTabFor(key) {
    const it = find(key);
    if (!it || inTab(it)) return;
    s.tab = 'all';
    tabBar.setActive('all');
  }

  function select(key, { focusList = false, replace, updateUrl = true } = {}) {
    const it = find(key);
    if (!it) return;
    if (key !== s.key) {
      // Phone: the list is about to give way to the draft; remember where it was scrolled.
      if (!wide.matches && !s.key) listY = window.scrollY;
      flushSave();
      const had = !!s.key;
      s.key = key;
      s.missing = null;
      if (optionEl(key) || !visibleItems().some((v) => v.key === key)) markSelected();
      else renderList();
      renderDetail();
      if (updateUrl) {
        const push = replace === undefined ? !had && !wide.matches : !replace;
        pushedSelection = push;
        syncUrl({ replace: !push });
      }
      loadCompany(it.domain);
      if (!wide.matches && d && !focusList) d.name.focus({ preventScroll: true });
    }
    const el = optionEl(key);
    if (el) {
      if (focusList && wide.matches) el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    }
    if (focusList && !wide.matches && d) d.name.focus({ preventScroll: true });
  }

  function deselect({ updateUrl = true, refocus = false } = {}) {
    const last = s.key;
    flushSave();
    s.key = null;
    pushedSelection = false;
    markSelected();
    renderDetail();
    if (updateUrl) syncUrl({ replace: true });
    if (refocus && last) {
      if (wide.matches) focusOption(last);
      else returnToList(last);
    }
  }

  function autoSelect() {
    if (!wide.matches || s.key || s.missing || !s.items) return;
    const first = visibleItems()[0];
    if (first) select(first.key, { replace: true });
  }

  function move(delta, { focusList = false } = {}) {
    const vis = visibleItems();
    if (!vis.length) return;
    let i = vis.findIndex((it) => it.key === s.key);
    i = i < 0 ? (delta > 0 ? 0 : vis.length - 1) : Math.max(0, Math.min(vis.length - 1, i + delta));
    select(vis[i].key, { focusList: focusList || listbox.contains(document.activeElement) });
  }

  // Phone: back from the draft to the list (history back when the draft pushed an entry).
  function backToList() {
    const last = s.key;
    flushSave();
    if (pushedSelection) {
      pushedSelection = false;
      s.refocus = last;
      history.back();
    } else {
      deselect({ refocus: true });
    }
  }

  function setTab(id, { focus = false } = {}) {
    if (!TAB_IDS.includes(id) || id === s.tab) return;
    s.tab = id;
    tabBar.setActive(id);
    writeStore('localStorage', TAB_KEY, id);
    s.limit = PAGE;
    renderHeader();
    renderBody();
    const it = s.key ? find(s.key) : null;
    if (it && !inTab(it)) {
      const first = wide.matches ? visibleItems()[0] : null;
      if (first) {
        select(first.key, { replace: true });
        return;
      }
      deselect({ updateUrl: false });
    } else if (!it) {
      autoSelect();
    }
    syncUrl({ replace: true });
    if (focus) {
      const t = tabBar.querySelector('[aria-selected="true"]');
      if (t) t.focus();
    }
  }

  // ---- Filter ----

  const filterToUrl = debounce(() => {
    if (alive) syncUrl({ replace: true });
  }, FILTER_URL_MS);

  function onFilterInput() {
    s.q = filter.value;
    s.limit = PAGE;
    renderList();
    filterToUrl();
  }

  function clearFilter() {
    filter.value = '';
    s.q = '';
    s.limit = PAGE;
    renderList();
    filterToUrl.cancel();
    syncUrl({ replace: true });
    filter.focus();
  }

  function onFilterKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (filter.value) clearFilter();
      else focusOption(s.key);
    } else if (e.key === 'ArrowDown') {
      const vis = visibleItems();
      if (!vis.length) return;
      e.preventDefault();
      if (!vis.some((it) => it.key === s.key)) select(vis[0].key, { focusList: true });
      else focusOption(s.key);
    }
  }

  // ---- Keyboard ----

  function onListKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1, { focusList: true });
    } else if (e.key === 'Home' || e.key === 'End') {
      const rows = [...listbox.children];
      const el = e.key === 'Home' ? rows[0] : rows[rows.length - 1];
      if (!el) return;
      e.preventDefault();
      select(el.dataset.key, { focusList: true });
    } else if (e.key === 'Enter' || e.key === ' ') {
      // keys.js leaves Enter on an ARIA option alone, so the list handles it.
      const opt = e.target.closest('[role="option"]');
      if (!opt) return;
      e.preventDefault();
      select(opt.dataset.key, { focusList: e.key === ' ' });
      if (e.key === 'Enter') focusEditor();
    }
  }

  function focusEditor() {
    if (!d) return;
    const ed = d.el.querySelector('[data-editor]');
    if (!ed) return;
    ed.focus();
    if (typeof ed.setSelectionRange === 'function' && ed.tagName === 'TEXTAREA') {
      const n = ed.value.length;
      ed.setSelectionRange(n, n);
    }
  }

  const unbindKeys = bindKeys({
    j: () => {
      if (!s.items || !s.items.length) return false;
      move(1);
      return true;
    },
    k: () => {
      if (!s.items || !s.items.length) return false;
      move(-1);
      return true;
    },
    enter: () => {
      if (!d) return false;
      focusEditor();
      return true;
    },
    escape: (e) => {
      if (!s.items) return false;
      if (!wide.matches) {
        if (!s.key) return false;
        backToList();
        return true;
      }
      if (d && d.el.contains(e.target)) {
        focusOption(s.key);
        return true;
      }
      return false;
    },
  });

  // ---- Autosave ----

  let saveChain = Promise.resolve();
  const failedSaves = new Set();

  function showSave(key, state, message) {
    if (!alive || !d || d.key !== key || !d.save) return;
    const text = { pending: 'Saving…', saved: 'Saved', error: `Couldn’t save: ${message}` }[state] || '';
    d.save.textContent = text;
    d.save.classList.toggle('is-error', state === 'error');
  }

  function saveNow(key, { last = false } = {}) {
    // Saves run one after another, so an older edit can never land after a newer one, and each
    // one writes the text as it is when its turn comes (an edit undone inside the debounce window
    // writes nothing). They are not tied to the view's AbortController: an edit made just before
    // leaving the screen still lands. `last`: the save made on leaving the screen.
    saveChain = saveChain.then(async () => {
      const it = find(key);
      if (!it || !isDirty(it)) {
        if (!failedSaves.has(key)) showSave(key, 'saved');
        return;
      }
      const snap = snapshot(it);
      try {
        await api.post(`/api/drafts/${enc(it.domain)}`, payloadOf(it));
        const cur = find(key);
        if (cur) cur.saved = snap;
        failedSaves.delete(key);
        // Still dirty: newer typing, whose own debounced save is already scheduled.
        showSave(key, isDirty(find(key)) ? 'pending' : 'saved');
      } catch (err) {
        const msg = (err && err.message) || String(err);
        showSave(key, 'error', msg);
        if (last) {
          // The screen was left: the edit goes with it, so say which one.
          toast(`Your edit to ${labelsOf(it).title} wasn’t saved: ${msg}`, 'err');
        } else if (!failedSaves.has(key)) {
          failedSaves.add(key);
          toast(`Couldn’t save your edit: ${msg}`, 'err');
        }
      }
    });
    return saveChain;
  }

  const saveSoon = debounce((key) => saveNow(key), SAVE_MS);

  /** Write any pending edit now; resolves when every save so far has finished. */
  function flushSave() {
    saveSoon.flush();
    return saveChain;
  }

  /** Before a send: the server sends what it has stored, so the edit must be saved first. */
  async function saveBeforeAction(key) {
    await flushSave();
    if (isDirty(find(key))) await saveNow(key);
    return !isDirty(find(key));
  }

  function edit(key, fieldName, value) {
    const it = find(key);
    if (!it) return;
    it[fieldName] = value;
    if (it.channel === 'linkedin') updateNote(it);
    showSave(key, 'pending');
    saveSoon(key);
  }

  // A reload or closed tab inside the debounce window: send what's pending with keepalive.
  function onPageHide() {
    saveSoon.cancel();
    for (const it of s.items || []) {
      if (!isDirty(it)) continue;
      fetch(`/api/drafts/${enc(it.domain)}`, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payloadOf(it)),
      }).catch(() => {});
    }
  }
  window.addEventListener('pagehide', onPageHide);

  // ---- Detail ----

  function detailSig(it) {
    return [it.channel, it.status, it.parked || '', it.to || '', sharedDomain(it), it.extra].join('|');
  }

  function rowSendState(key) {
    const v = rowSends.get(key);
    return v ? (v.timedOut ? 'timeout' : 'sending') : '';
  }

  function actionsSig(it) {
    const c = caps();
    return [
      detailSig(it), staged.has(it.key), rowSendState(it.key), pushing.has(it.key),
      emailBlocked(), liBlocked(), !!bulkStart(), c.auto, c.liAuto, c.gate,
    ].join('|');
  }

  function placeholder() {
    if (s.missing) {
      return emptyState({
        title: 'This draft isn’t waiting anymore',
        body: `${s.missing} has no draft to review: it was sent, discarded or never drafted.`,
      });
    }
    return emptyState({
      title: 'No draft selected',
      body: 'Pick one from the list. J and K move through it, Enter jumps into the editor, Esc comes back.',
    });
  }

  function renderDetail() {
    const it = s.key ? find(s.key) : null;
    if (!it) {
      d = null;
      // With nothing in the list (empty tab, no filter matches) the list pane already says why.
      const quiet = !s.missing && !visibleItems().length;
      detailPane.replaceChildren(...(quiet ? [] : [h('div', { class: 'drafts-detail-empty' }, placeholder())]));
      return;
    }
    const el = h('article', { class: 'draft', 'aria-labelledby': 'draft-title' });
    d = { key: it.key, el, sig: detailSig(it), actionsSig: '', labels: new Map() };
    d.name = h('h2', { class: 'draft-name', id: 'draft-title', tabindex: '-1' });
    d.meta = h('p', { class: 'draft-meta' });
    d.badges = h('div', { class: 'draft-badges' });
    d.source = h('p', { class: 'draft-source', hidden: true });
    el.append(
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm draft-back', onClick: backToList }, icon(ICONS.back), 'All drafts'),
      h('div', { class: 'draft-head' }, h('div', { class: 'draft-head-text' }, d.name, d.meta), d.badges),
      d.source,
    );
    if (it.parked) {
      el.append(
        h(
          'div',
          { class: 'draft-banner' },
          icon(ICONS.alert),
          h('p', {}, h('strong', {}, 'Auto-send skipped:'), ' ', it.parked),
        ),
      );
    }
    if (it.extra) {
      // Several drafts wait on this channel (e.g. Draft follow-up pressed twice). The send routes
      // act on the newest, an edit saves to every one of them, and Discard deletes them all.
      const n = it.extra + 1;
      const all = n === 2 ? 'both' : `all ${fmtNum(n)}`;
      el.append(
        h(
          'div',
          { class: ['draft-banner', 'draft-dupes'] },
          icon(ICONS.alert),
          h(
            'p',
            {},
            h('strong', {}, `${fmtNum(n)} drafts wait for this company on this channel.`),
            ` You see the newest, the one that sends; the older ${it.extra === 1 ? 'one comes' : 'ones come'} up here after it.`,
            editable(it) ? ` Edits change ${all}.` : '',
            ` Discard deletes ${all}.`,
          ),
        ),
      );
    }
    if (editable(it) && sharedDomain(it)) {
      // The server saves a draft edit per company, not per channel (for now).
      const other = it.channel === 'email' ? 'a LinkedIn note' : 'an email';
      el.append(
        h(
          'div',
          { class: ['draft-banner', 'draft-shared'] },
          icon(ICONS.alert),
          h(
            'p',
            {},
            h('strong', {}, 'Edits here change both drafts.'),
            ` This company also has ${other} waiting, and coldtrail keeps one text per company for now, so saving this one replaces that one’s text too.`,
          ),
        ),
      );
    }
    el.append(editor(it));
    d.save = editable(it) ? h('span', { class: 'draft-save', role: 'status' }) : null;
    d.count = it.channel === 'linkedin' ? h('span', { class: 'draft-count', id: 'draft-count' }) : null;
    d.actions = h('div', { class: 'draft-actions' });
    el.append(h('div', { class: 'draft-foot' }, h('div', { class: 'draft-state' }, d.count, d.save), d.actions));
    detailPane.replaceChildren(el);
    detailPane.scrollTop = 0;
    if (failedSaves.has(it.key)) showSave(it.key, 'error', 'the last save failed');
    else if (isDirty(it)) showSave(it.key, 'pending');
    fillHead(it);
    if (it.channel === 'linkedin') updateNote(it);
    refreshActions(true);
  }

  function editor(it) {
    if (it.channel === 'linkedin') {
      const note = h('textarea', {
        id: 'draft-note',
        class: 'input draft-text',
        rows: '8',
        spellcheck: 'true',
        'data-editor': '',
        'aria-describedby': 'draft-count draft-note-err',
        value: it.body,
        onInput: (e) => edit(it.key, 'body', e.target.value),
      });
      d.note = note;
      d.noteErr = h('p', { class: 'field-error', id: 'draft-note-err', hidden: true }, `Shorten the note to ${NOTE_MAX} characters or fewer to send it.`);
      d.link = h('p', { class: 'draft-link' });
      return h('div', { class: 'draft-fields' }, h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'draft-note' }, 'Connection note'), note, d.noteErr, d.link));
    }
    const to = h('div', { class: 'draft-to' }, h('span', { class: 'field-label' }, 'To'), h('span', { class: it.to ? 'draft-to-addr' : 'draft-to-missing' }, recipientText(it)));
    if (it.status === 'drafted') {
      return h(
        'div',
        { class: 'draft-fields' },
        h('p', { class: 'draft-info' }, 'This email is in your Gmail Drafts. Send it from Gmail, then mark it sent here.'),
        to,
        readOnly('Subject', it.subject),
        readOnly('Body', it.body, 'draft-ro-body'),
      );
    }
    const subject = h('input', {
      type: 'text',
      id: 'draft-subject',
      class: 'input',
      autocomplete: 'off',
      spellcheck: 'true',
      value: it.subject,
      onInput: (e) => edit(it.key, 'subject', e.target.value),
    });
    const text = h('textarea', {
      id: 'draft-body',
      class: 'input draft-text',
      rows: '14',
      spellcheck: 'true',
      'data-editor': '',
      value: it.body,
      onInput: (e) => edit(it.key, 'body', e.target.value),
    });
    return h('div', { class: 'draft-fields' }, to, field('Subject', subject, 'draft-subject'), field('Body', text, 'draft-body'));
  }

  function domainLink(domain) {
    const url = safeUrl(`https://${domain}`);
    return url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, domain) : h('span', {}, domain);
  }

  function fillHead(it) {
    if (!d || d.key !== it.key) return;
    const l = labelsOf(it);
    const c = companies.get(it.domain);
    const source = c && c.source_query;
    // Unchanged (a poll's refresh): leave the links in the head alone.
    const sig = [l.person, l.role, l.company, l.title, it.domain, it.to, it.channel, it.status, it.parked, source].join('\u0001');
    if (sig === d.headSig) {
      relabel();
      return;
    }
    d.headSig = sig;
    d.name.textContent = l.person || l.title;
    const parts = [];
    if (l.person && l.role) parts.push(l.role);
    if (l.person && l.company) parts.push(l.company);
    parts.push(domainLink(it.domain));
    if (it.channel === 'linkedin') {
      const url = safeUrl(it.to);
      parts.push(url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, linkedinHandle(url)) : h('span', { class: 'draft-to-missing' }, recipientText(it)));
    }
    // Each item stays whole (a domain never breaks at its hyphen); the line wraps between them.
    d.meta.replaceChildren(
      ...parts.flatMap((p, i) => {
        const item = h('span', { class: 'draft-meta-item' }, p);
        return i ? [h('span', { class: 'draft-meta-sep', 'aria-hidden': 'true' }, ' · '), item] : [item];
      }),
    );
    const status =
      it.channel === 'email' && it.status === 'drafted' ? badge('In Gmail', 'accent') : badge('Draft', 'neutral');
    d.badges.replaceChildren(...(it.parked ? [badge('Parked', 'warn')] : []), status);
    d.source.hidden = !source;
    d.source.replaceChildren(...(source ? [h('span', { class: 'draft-source-label' }, 'Sourced by'), ' ', source] : []));
    relabel();
  }

  function updateNote(it) {
    if (!d || d.key !== it.key || !d.count) return;
    const over = overLimit(it);
    d.count.textContent = `${it.body.length} / ${NOTE_MAX}`;
    d.count.classList.toggle('is-over', over);
    d.noteErr.hidden = !over;
    if (over) d.note.setAttribute('aria-invalid', 'true');
    else d.note.removeAttribute('aria-invalid');
    const link = noteLink(it.body);
    d.link.replaceChildren(
      ...(link
        ? [h('span', {}, 'Link in note: '), h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, link)]
        : [h('span', {}, 'No link in this note.')]),
    );
    applyOver(it);
  }

  function applyOver(it) {
    if (!d || !it || d.key !== it.key) return;
    const over = overLimit(it);
    for (const b of d.actions.querySelectorAll('[data-needs-note]')) {
      if (!('busy' in b.dataset)) b.disabled = over || 'blocked' in b.dataset;
    }
  }

  function relabel() {
    if (!d) return;
    for (const [el, fn] of d.labels) if (!('busy' in el.dataset)) el.textContent = fn();
  }

  // `blocked`: disabled until a running send finishes (the hint beside it says which).
  function actionBtn(content, kind, action, onClick, { needsNote = false, label = null, disabled = false, blocked = false } = {}) {
    const b = h(
      'button',
      {
        type: 'button',
        class: `btn btn-${kind}`,
        'data-action': action,
        'data-needs-note': needsNote ? '' : null,
        'data-blocked': blocked ? '' : null,
        disabled: disabled || blocked,
        onClick,
      },
      content,
    );
    if (label) {
      d.labels.set(b, label);
      b.textContent = label();
    }
    return b;
  }

  function personFirst(it) {
    const p = labelsOf(it).person;
    return p ? firstName(p) : null;
  }

  function buildActions(it) {
    const c = caps();
    const key = it.key;
    const discardBtn = actionBtn('Discard', 'ghost', 'discard', (e) => discard(key, e.currentTarget));
    if (it.channel === 'email') {
      if (it.status === 'drafted') {
        return [
          discardBtn,
          h('a', { class: 'btn btn-secondary', href: GMAIL_DRAFTS, target: '_blank', rel: 'noopener noreferrer', 'data-action': 'gmail', 'data-editor': '' }, 'Open Gmail'),
          actionBtn('Mark sent', 'primary', 'mark', (e) => markSent(key, e.currentTarget)),
        ];
      }
      if (pushing.has(key)) {
        // A Send now still on its way (this button was rebuilt meanwhile): it stays busy.
        const b = actionBtn(c.auto ? 'Sending…' : 'Creating…', 'primary', 'push', null, { disabled: true });
        b.setAttribute('aria-busy', 'true');
        return [discardBtn, b];
      }
      const label = c.auto
        ? () => {
            const cur = find(key);
            const who = cur ? personFirst(cur) || cur.to : null;
            return who ? `Send now to ${who}` : 'Send now';
          }
        : () => 'Create Gmail draft';
      const blocked = emailBlocked();
      return [
        blocked
          ? h('span', { class: 'draft-hint' }, run.auto ? 'Send all is sending your emails, one at a time.' : 'Send all is creating your Gmail drafts, one at a time.')
          : null,
        discardBtn,
        actionBtn('', 'primary', 'push', (e) => pushEmail(key, e.currentTarget), { label, blocked }),
      ].filter(Boolean);
    }
    if (staged.has(key)) {
      return [
        h(
          'div',
          { class: 'draft-ask', role: 'group', 'aria-labelledby': 'draft-ask-q' },
          h('span', { class: 'draft-ask-q', id: 'draft-ask-q' }, 'Did it send?'),
          actionBtn([icon(ICONS.check), 'Yes, it sent'], 'primary', 'yes', (e) => answer(key, true, e.currentTarget)),
          actionBtn([icon(ICONS.x), 'No, it didn’t'], 'secondary', 'no', (e) => answer(key, false, e.currentTarget)),
        ),
      ];
    }
    if (rowSendState(key) === 'sending') {
      return [
        h('span', { class: 'draft-hint' }, 'coldtrail is sending this invite in the LinkedIn window.'),
        actionBtn('Sending…', 'primary', 'sending', null, { disabled: true }),
      ];
    }
    if (rowSendState(key) === 'timeout') {
      // It may still have gone out, so it isn't offered again until a reload.
      return [
        h('span', { class: 'draft-hint' }, 'The send didn’t confirm. Check the invite in LinkedIn, or reload this page to try again.'),
        actionBtn('Not confirmed', 'primary', 'sending', null, { disabled: true }),
      ];
    }
    const canSend = c.liAuto && !it.parked;
    // Send invite stays off when the sender would stop before sending (signed out, outside its
    // hours), and waits while a bulk send runs (it may send this one). Open in LinkedIn is the
    // manual path: it never waits (the server answers "busy" if the window is in use).
    const gate = canSend ? c.gate : null;
    const waits = canSend && !gate && liBlocked();
    let hint = null;
    if (gate) {
      const tail = gate === 'window' ? 'Send invite waits until then. Open in LinkedIn works any time.' : 'Send invite is off.';
      hint = h('span', { class: 'draft-hint' }, gateText(gate, tail));
    } else if (waits) {
      hint = h(
        'span',
        { class: 'draft-hint' },
        'Send invite waits for the LinkedIn bulk send to finish.',
        bulkStart()
          ? [' ', h('button', { type: 'button', class: 'draft-linkbtn', 'data-action': 'stop-waiting', onClick: stopWaiting }, 'Stop waiting')]
          : null,
      );
    }
    const ready = canSend && !gate;
    const out = [
      hint,
      discardBtn,
      actionBtn('Open in LinkedIn', ready ? 'secondary' : 'primary', 'assist', (e) => assist(key, e.currentTarget), { needsNote: true }),
    ].filter(Boolean);
    if (canSend) {
      out.push(
        actionBtn('', ready ? 'primary' : 'secondary', 'invite', (e) => sendInvite(key, e.currentTarget), {
          needsNote: true,
          blocked: !!gate || waits,
          label: () => {
            const cur = find(key);
            const who = cur && personFirst(cur);
            return who ? `Send invite to ${who}` : 'Send invite';
          },
        }),
      );
    }
    return out;
  }

  function refreshActions(force = false) {
    if (!d) return;
    const it = find(d.key);
    if (!it) return;
    const sig = actionsSig(it);
    if (!force && sig === d.actionsSig) {
      relabel();
      return;
    }
    d.actionsSig = sig;
    const focused = d.actions.contains(document.activeElement) ? document.activeElement.dataset.action : null;
    d.labels = new Map();
    d.actions.replaceChildren(...buildActions(it));
    applyOver(it);
    if (focused) {
      const again = d.actions.querySelector(`[data-action="${focused}"]`);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }
  }

  // After new data: re-render the detail only when the draft itself changed (never over an edit).
  function syncDetail() {
    const it = s.key ? find(s.key) : null;
    if (!it) {
      if (d || !detailPane.firstChild || detailPane.querySelector('.draft-skeleton')) renderDetail();
      return;
    }
    if (!d || d.key !== it.key || d.sig !== detailSig(it)) {
      renderDetail();
      return;
    }
    fillHead(it);
    refreshActions();
  }

  // ---- Busy buttons ----

  function busy(btn, text) {
    const nodes = [...btn.childNodes];
    const focused = document.activeElement === btn;
    btn.dataset.busy = '';
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    btn.textContent = text;
    return () => {
      if (!btn.isConnected) return;
      delete btn.dataset.busy;
      btn.removeAttribute('aria-busy');
      btn.replaceChildren(...nodes);
      btn.disabled = 'blocked' in btn.dataset;
      relabel();
      if (d) applyOver(find(d.key));
      if (focused && !btn.disabled) btn.focus({ preventScroll: true });
    };
  }

  // ---- Actions ----

  // Asked once per channel and session: confirming an email's Send now says nothing about what
  // Send invite does on LinkedIn, so that one still asks the first time.
  async function confirmFirstSend(channel, opts) {
    const storeKey = `${SEND_OK_KEY}-${channel}`;
    if (sendConfirmed.has(channel) || readStore('sessionStorage', storeKey) === '1') return true;
    const ok = await confirmDialog(opts);
    if (ok) {
      sendConfirmed.add(channel);
      writeStore('sessionStorage', storeKey, '1');
    }
    return ok;
  }

  async function pushEmail(key, btn) {
    const it = find(key);
    // One send per draft at a time, and none while Send all works through the emails.
    if (!it || pushing.has(key) || emailBlocked()) return;
    const auto = caps().auto;
    if (auto) {
      const ok = await confirmFirstSend('email', {
        title: 'Send this email now?',
        body: `It goes to ${it.to || 'the contact'} from your Gmail right away. You won’t be asked again in this browser session.`,
        confirmText: 'Send now',
        opener: btn,
      });
      if (!ok || pushing.has(key) || emailBlocked()) return;
    }
    pushing.add(key);
    const restore = busy(btn, auto ? 'Sending…' : 'Creating…');
    const what = auto ? 'Email not sent' : 'Gmail draft not created';
    try {
      if (!(await saveBeforeAction(key))) return;
      const r = await api.post(`/api/drafts/${enc(it.domain)}/send`, {});
      if (r && r.ok) {
        toast(r.message || (auto ? 'Sent.' : 'Created in your Gmail Drafts.'), 'ok');
        store.refresh();
        await load();
      } else {
        toast(`${what} — ${(r && r.message) || 'it could not be completed'}`, 'err');
      }
    } catch (err) {
      toast(`${what} — ${err.message}`, 'err');
    } finally {
      pushing.delete(key);
      restore();
      if (alive) refreshActions();
    }
  }

  async function markSent(key, btn) {
    const it = find(key);
    if (!it) return;
    const restore = busy(btn, 'Marking…');
    try {
      await api.post(`/api/followups/${enc(it.domain)}/mark`, { value: 'sent' });
      toast(`Marked ${labelsOf(it).title} as sent.`, 'ok');
      store.refresh();
      await load();
      restore();
    } catch (err) {
      restore();
      toast(err.message, 'err');
    }
  }

  async function discard(key, btn) {
    const it = find(key);
    if (!it) return;
    const l = labelsOf(it);
    const what = it.channel === 'linkedin' ? 'LinkedIn note' : 'email';
    const n = it.extra + 1;
    // Discard deletes every pending draft on this domain + channel, folded rows included.
    const lead = it.extra ? `${n === 2 ? 'Both' : `All ${fmtNum(n)}`} ${what}s` : `The ${what}`;
    const gmail = it.channel === 'email' && it.status === 'drafted' ? ' The copy in your Gmail Drafts stays there.' : '';
    const ok = await confirmDialog({
      title: it.extra ? `Discard ${n === 2 ? 'both' : `all ${fmtNum(n)}`} drafts?` : 'Discard this draft?',
      body: `${lead} to ${l.person || l.recipient} ${it.extra ? 'are' : 'is'} deleted and ${l.title} is marked Skip, so it isn’t drafted again.${gmail}`,
      confirmText: it.extra ? `Discard ${n === 2 ? 'both' : `all ${fmtNum(n)}`}` : 'Discard draft',
      danger: true,
      opener: btn,
    });
    if (!ok || !find(key)) return;
    saveSoon.cancel();
    const restore = busy(btn, 'Discarding…');
    try {
      // Opened in LinkedIn meanwhile (Discard was pressed while it opened): the server holds that
      // window, and the browser with it, until it hears back. Say it wasn't sent, so it closes
      // now rather than at its timeout. Best effort: the discard goes ahead either way.
      if (staged.has(key)) {
        await api.post(`/api/drafts/${enc(it.domain)}/linkedin/confirm`, { sent: false }).catch(() => {});
      }
      const r = await api.del(`/api/drafts/${enc(it.domain)}?channel=${it.channel}`);
      // The draft is gone (deleted now, or before): an unsaved edit has nothing left to save to.
      const cur = find(key);
      if (cur) cur.saved = snapshot(cur);
      if (r && r.ok === false) {
        restore();
        toast(r.message === 'no pending draft' ? 'This draft was already sent or discarded.' : r.message || 'Nothing to discard.', 'err');
      } else {
        staged.delete(key);
        rowSends.delete(key);
        toast(`${it.extra ? `${fmtNum(n)} drafts` : 'Draft'} discarded. ${l.title} is now skipped.`, 'ok');
      }
      store.refresh();
      await load({ focusOnVanish: true });
    } catch (err) {
      restore();
      toast(`Draft not discarded — ${err.message}`, 'err');
      // Still there, so an edit that was waiting to save still needs to.
      if (isDirty(find(key))) saveSoon(key);
    }
  }

  async function assist(key, btn) {
    const it = find(key);
    if (!it || overLimit(it)) return;
    const restore = busy(btn, 'Opening…');
    if (!(await saveBeforeAction(key))) {
      restore();
      return;
    }
    try {
      const r = await api.post(`/api/drafts/${enc(it.domain)}/linkedin/assist`, {});
      if (r && r.staged) {
        staged.add(key);
        toast('Opened in LinkedIn — review the note and click Send there.', 'ok');
        if (!alive) return;
        renderList();
        refreshActions(true);
        const yes = d && d.key === key ? d.actions.querySelector('[data-action="yes"]') : null;
        if (yes) yes.focus();
      } else if (r && r.already_invited) {
        toast('Already invited on LinkedIn (Pending) — marked as sent.', 'ok');
        store.refresh();
        await load({ focusOnVanish: true });
        restore();
      } else {
        restore();
        toast('Could not open LinkedIn.', 'err');
      }
    } catch (err) {
      restore();
      toast(err.message, 'err');
    }
  }

  async function answer(key, sent, btn) {
    const it = find(key);
    if (!it) return;
    const group = btn.closest('.draft-ask');
    const buttons = group ? [...group.querySelectorAll('button')] : [btn];
    for (const b of buttons) b.disabled = true;
    try {
      await api.post(`/api/drafts/${enc(it.domain)}/linkedin/confirm`, { sent });
      staged.delete(key);
      if (sent) {
        toast('Marked sent.', 'ok');
        store.refresh();
        await load({ focusOnVanish: true });
      } else {
        toast('Not sent — you can try again.', 'ok');
        if (!alive) return;
        renderList();
        refreshActions(true);
        const again = d && d.key === key ? d.actions.querySelector('[data-action="assist"]') : null;
        if (again) again.focus();
      }
    } catch (err) {
      for (const b of buttons) if (b.isConnected) b.disabled = false;
      toast(err.message, 'err');
    }
  }

  async function sendInvite(key, btn) {
    const it = find(key);
    if (!it || overLimit(it) || it.parked || liBlocked() || caps().gate) return;
    const c = caps();
    const who = labelsOf(it).person || linkedinHandle(it.to || it.domain);
    const ok = await confirmFirstSend('linkedin', {
      title: 'Send this LinkedIn invite?',
      body: `coldtrail opens LinkedIn and sends the connection request to ${who} with your note, within your caps (${c.daily} a day, ${c.weekly} a week). You won’t be asked again in this browser session.`,
      confirmText: 'Send invite',
      opener: btn,
    });
    if (!ok) return;
    const restore = busy(btn, 'Sending…');
    if (!(await saveBeforeAction(key))) {
      restore();
      return;
    }
    try {
      const r = await api.post(`/api/drafts/${enc(it.domain)}/linkedin/send`, {});
      if (!r || !r.sending) {
        restore();
        toast('Could not start the LinkedIn send.', 'err');
        return;
      }
      rowSends.set(key, { at: Date.now(), timedOut: false });
      toast('Sending on LinkedIn — coldtrail is driving the browser…', 'ok');
      if (!alive) return;
      renderList();
      refreshActions(true);
      scheduleRowPoll();
    } catch (err) {
      restore();
      toast(err.message, 'err');
    }
  }

  // ---- Send all ----

  function sendPlan() {
    const c = caps();
    const all = s.items || [];
    const emailSide = s.tab !== 'linkedin';
    const liSide = s.tab !== 'email';
    const emailPending = emailSide ? all.filter((it) => it.channel === 'email' && it.status === 'draft_pending') : [];
    const inGmail = emailSide ? all.filter((it) => it.channel === 'email' && it.status === 'drafted').length : 0;
    const li = liSide ? all.filter((it) => it.channel === 'linkedin') : [];
    const parked = li.filter((it) => it.parked).length;
    // The bulk sender queues LinkedIn drafts that aren't parked and have a profile URL.
    const sendable = li.filter((it) => !it.parked && it.to).length;
    const room = Math.max(0, Math.min(c.daily - c.today, c.weekly - c.week));
    const liUpTo = Math.min(sendable, room);
    const running = liBlocked();
    // Auto-send stops at the daily cap, counting what already went out today when that's known.
    const emailRoom = Math.max(0, c.cap - (c.emailToday || 0));
    const emails = c.auto ? emailPending.slice(0, emailRoom) : emailPending;
    return {
      tab: s.tab, c, emailSide, liSide, emailPending, emails, inGmail, li, parked, sendable, liUpTo, running,
      // The sender exits at once, sending nothing, when signed out or outside its hours.
      liGo: liSide && c.liAuto && !running && !c.gate && liUpTo > 0,
    };
  }

  // "14 invites" never splits across lines in the dialog.
  const nb = (text) => text.replace(/(\d) /g, '$1\u00a0');

  function emailLine(p) {
    const { c } = p;
    const n = p.emailPending.length;
    const known = c.emailToday != null;
    let text;
    let off = !n;
    if (!n) {
      text = 'No email drafts to send.';
    } else if (c.auto && !p.emails.length) {
      text = `None go out today: the email cap is reached (${fmtNum(c.emailToday)} of ${c.cap} sent).`;
      off = true;
    } else if (c.auto) {
      const capText = known ? `cap ${c.cap}, ${fmtNum(c.emailToday)} already sent` : `cap ${c.cap} a day`;
      text = `Up to ${pluralize(p.emails.length, 'email')} today (${capText}). They send from your Gmail one at a time; there’s no undo.`;
    } else {
      text = `Create ${pluralize(n, 'Gmail draft')}. Nothing is sent: they wait in your Gmail Drafts for you to send.`;
    }
    if (p.inGmail) text += ` ${fmtNum(p.inGmail)} already in Gmail ${p.inGmail === 1 ? 'is' : 'are'} left out.`;
    return h('li', { class: ['sendall-email', off && 'is-off'] }, h('strong', {}, 'Email'), h('span', {}, nb(text)));
  }

  function linkedinLine(p) {
    const { c } = p;
    const usage = `${c.today}/${c.daily} today, ${c.week}/${c.weekly} this week`;
    const parkedNote = p.parked ? `; ${pluralize(p.parked, 'parked draft')} excluded` : '';
    let content;
    let off = false;
    if (!p.li.length) {
      content = ['No LinkedIn invites to send.'];
      off = true;
    } else if (p.running) {
      content = ['A LinkedIn bulk send is already running; it works through these invites one at a time.'];
      off = true;
    } else if (!c.liAuto) {
      const n = p.sendable;
      content = [
        `LinkedIn auto-send is off, so ${pluralize(n, 'invite')} ${n === 1 ? 'stays' : 'stay'} here. Turn it on in `,
        h('a', { href: '#/settings?tab=sending' }, 'Settings → Sending'),
        ' to send them in bulk, or open each one in LinkedIn.',
      ];
      off = true;
    } else if (!p.sendable) {
      content = [`No LinkedIn invites to send${parkedNote}.`];
      off = true;
    } else if (c.gate) {
      content = gateText(c.gate, 'none go out now.');
      off = true;
    } else if (!p.liUpTo) {
      content = [`None go out today: the LinkedIn cap is reached (${usage})${parkedNote}.`];
      off = true;
    } else {
      const of = p.liUpTo < p.sendable ? ` of ${fmtNum(p.sendable)} LinkedIn ${p.sendable === 1 ? 'invite' : 'invites'}` : ` LinkedIn ${p.liUpTo === 1 ? 'invite' : 'invites'}`;
      content = [`Up to ${fmtNum(p.liUpTo)}${of} today (${usage})${parkedNote}. They go out one at a time, with pauses between them.`];
    }
    content = content.map((part) => (typeof part === 'string' ? nb(part) : part));
    return h('li', { class: ['sendall-linkedin', off && 'is-off'] }, h('strong', {}, 'LinkedIn'), h('span', {}, content));
  }

  // "Send 10 emails and 14 invites", "Create 10 Gmail drafts and send 14 invites", "Send 14 invites".
  function confirmLabel(p) {
    const parts = [];
    const emailVerb = p.c.auto ? 'send' : 'create';
    // (With auto-send on and today's cap used up, no email goes out: nothing to confirm there.)
    if (p.emails.length) {
      parts.push(p.c.auto ? `send ${pluralize(p.emails.length, 'email')}` : `create ${pluralize(p.emailPending.length, 'Gmail draft')}`);
    }
    if (p.liGo) {
      const invites = pluralize(p.liUpTo, 'invite');
      parts.push(parts.length && emailVerb === 'send' ? invites : `send ${invites}`);
    }
    return capitalize(parts.join(' and '));
  }

  async function openSendAll() {
    // A send already running on this tab owns the button until it ends.
    if (openingSendAll || busyLabel(s.tab)) return;
    openingSendAll = true;
    try {
      // Fresh numbers: the caps, today's usage and the queue as they are now.
      await Promise.all([store.refresh(), load()]);
    } finally {
      openingSendAll = false;
    }
    if (!alive || busyLabel(s.tab)) return;
    s.status = store.get().status;
    renderHeader();
    const p = sendPlan();
    const title = { all: 'Send all drafts', email: 'Send all email drafts', linkedin: 'Send all LinkedIn invites' }[s.tab];
    const progress = h('p', { class: 'sendall-progress', role: 'status' });
    const label = confirmLabel(p);
    openDialog({
      title,
      opener: sendAllBtn,
      content: [
        h('p', {}, label ? 'This is exactly what happens when you confirm:' : 'Nothing goes out from here right now:'),
        h('ul', { class: 'sendall-list' }, p.emailSide ? emailLine(p) : null, p.liSide ? linkedinLine(p) : null),
        progress,
      ],
      // Focus starts on Cancel / Close, never on a link inside the list (Enter there would leave
      // the screen), and never on the button that sends with no undo.
      actions: label
        ? [
            { label: 'Cancel', kind: 'secondary', autofocus: true },
            { label, kind: 'primary', onClick: () => runSendAll(p, progress) },
          ]
        : [{ label: 'Close', kind: 'secondary', autofocus: true }],
    });
  }

  async function runSendAll(p, progress) {
    if (run || busyLabel(p.tab)) return;
    const { auto } = p.c;
    // An email already going out through its own Send now is left to that send.
    const emails = p.emails.filter((it) => !pushing.has(it.key));
    // The dialog may have sat open past 20:00: check the LinkedIn sender's hours again.
    const gate = p.liGo ? liGate(s.status) : null;
    const liGo = p.liGo && !gate;
    run = { auto, i: 0, n: emails.length, li: liGo };
    const step = (text) => {
      progress.textContent = text;
      runChanged();
    };
    let ok = 0;
    let stopped = null;
    const failed = [];
    runChanged();
    try {
      await flushSave();
      for (let i = 0; i < emails.length; i++) {
        const it = emails[i];
        run.i = i;
        step(`${auto ? 'Sending' : 'Creating'} ${fmtNum(i + 1)} of ${fmtNum(emails.length)}…`);
        try {
          const r = await api.post(`/api/drafts/${enc(it.domain)}/send`, {});
          if (r && r.ok) {
            ok++;
          } else {
            const msg = (r && r.message) || 'it could not be completed';
            if (EMAIL_GATE.test(msg)) {
              stopped = msg;
              break;
            }
            failed.push(`${labelsOf(it).title}: ${msg}`);
          }
        } catch (err) {
          failed.push(`${labelsOf(it).title}: ${err.message}`);
          if (err.status === 401) break;
        }
      }
      run.i = run.n;
      if (emails.length) {
        const done = auto ? `Sent ${pluralize(ok, 'email')}.` : `Created ${pluralize(ok, 'Gmail draft')}.`;
        if (stopped) toast(`${done} Stopped: ${stopped}`, 'err');
        else if (failed.length) toast(`${done} ${fmtNum(failed.length)} failed:\n${failed.join('\n')}`, 'err');
        else toast(done, 'ok');
      }
      if (gate) toast(`No LinkedIn invites went out. ${gatePlain(gate)}`);
      if (liGo) {
        step('Starting the LinkedIn sender…');
        try {
          const r = await api.post('/api/drafts/linkedin/send-all', {});
          if (r && r.sending) {
            // What it should get through today, and the queue it starts from: the poller
            // reports it finished once that many have left the queue (or the cap is reached).
            const keys = p.li.filter((it) => !it.parked && it.to).map((it) => it.key);
            writeStore('sessionStorage', BULK_KEY, JSON.stringify({ at: Date.now(), want: p.liUpTo, keys }));
            toast('Sending on LinkedIn — one invite at a time, with pauses between them.', 'ok');
          } else {
            toast('Could not start the LinkedIn bulk send.', 'err');
          }
        } catch (err) {
          toast(`The LinkedIn bulk send didn’t start: ${err.message}`, 'err');
        }
      }
      // Send now stays off until the queue shows what went out, so nothing goes twice.
      store.refresh();
      if (active) await active.reload();
    } finally {
      run = null;
      runChanged();
    }
  }

  // ---- Pollers (stopped on unmount, resumed on the next mount) ----

  function scheduleRowPoll() {
    clearTimeout(rowTimer);
    rowTimer = null;
    if (!alive || ![...rowSends.values()].some((v) => !v.timedOut)) return;
    rowTimer = setTimeout(rowTick, ROW_POLL_MS);
  }

  async function rowTick() {
    rowTimer = null;
    if (!alive) return;
    const fresh = await load();
    if (!alive) return;
    if (fresh) {
      let late = false;
      for (const [key, v] of rowSends) {
        if (v.timedOut) continue;
        if (!find(key)) {
          rowSends.delete(key);
          toast('Invite sent on LinkedIn.', 'ok');
          store.refresh();
        } else if (Date.now() - v.at > ROW_TIMEOUT_MS) {
          // The button stays off (it may still go out), and now says the send didn't confirm.
          v.timedOut = true;
          late = true;
          toast('The LinkedIn invite didn’t confirm. Check it in LinkedIn, or reload this page to try again.');
        }
      }
      if (late) {
        renderList();
        refreshActions();
      }
    }
    scheduleRowPoll();
  }

  function scheduleBulkPoll() {
    clearTimeout(bulkTimer);
    bulkTimer = null;
    if (!alive || !bulkStart()) return;
    bulkTimer = setTimeout(bulkTick, BULK_POLL_MS);
  }

  function endBulk() {
    clearTimeout(bulkTimer);
    bulkTimer = null;
    writeStore('sessionStorage', BULK_KEY, null);
    if (alive) {
      renderSendAll();
      refreshActions();
    }
  }

  // The way out of a bulk send the screen can't see the end of (the sender stopped early for a
  // reason the queue doesn't show): Send all and Send invite are free again.
  function stopWaiting() {
    endBulk();
    if (!d) return;
    // Onto Send invite, the button it frees (or Open in LinkedIn when the note is too long).
    const next = ['invite', 'assist'].map((a) => d.actions.querySelector(`[data-action="${a}"]:not(:disabled)`)).find(Boolean);
    if (next) next.focus();
  }

  let bulkTicks = 0;

  async function bulkTick() {
    bulkTimer = null;
    const b = bulkRun();
    if (!alive || !b) return;
    const at = b.at;
    // The caps and the LinkedIn session come from /api/status, which the shared store refreshes
    // only every 30s: refresh it every few polls so the checks below keep up.
    bulkTicks++;
    const [fresh] = await Promise.all([load(), bulkTicks % BULK_STATUS_EVERY ? null : store.refresh()]);
    // Gone, or replaced, meanwhile (Stop waiting; a new run).
    if (!alive || !bulkRun() || bulkRun().at !== at) return;
    if (fresh) {
      // The sender stops at the daily / weekly cap, so it is done once as many invites as it
      // could send today have left the queue, or the cap says so. It also stops, sending no
      // more, when LinkedIn signs out or its hours end.
      const queued = new Set((s.items || []).map((it) => it.key));
      const gone = b.keys.filter((k) => !queued.has(k)).length;
      const c = caps();
      const capped = !!s.status && (c.today >= c.daily || c.week >= c.weekly);
      const gate = s.status ? c.gate : null;
      if (gone >= b.want || capped || gate) {
        endBulk();
        const sent = `${pluralize(gone, 'invite')} sent`;
        if (gone >= b.want) toast(`LinkedIn bulk send finished: ${sent}.`, 'ok');
        else if (capped) toast(`LinkedIn bulk send stopped at your LinkedIn cap: ${sent}.`, 'ok');
        else toast(`LinkedIn bulk send stopped: ${sent}. ${gatePlain(gate)}`);
        store.refresh();
        return;
      }
    }
    if (Date.now() - at > BULK_TIMEOUT_MS) {
      endBulk();
      toast('Still working through LinkedIn invites — check back in a bit.');
      return;
    }
    scheduleBulkPoll();
  }

  // ---- Loading ----

  function applyDrafts(rows) {
    const prev = new Map((s.items || []).map((it) => [it.key, it]));
    const seen = new Map();
    const items = [];
    for (const row of rows) {
      const it = toItem(row);
      if (!it.domain) continue;
      // Edits and sends are per domain on the server, so one row per domain + channel (the
      // newest, which is the one the send routes act on); older ones are counted on it.
      const kept = seen.get(it.key);
      if (kept) {
        kept.extra++;
        continue;
      }
      seen.set(it.key, it);
      const old = prev.get(it.key);
      if (old && isDirty(old)) {
        // Keep an unsaved edit over the server's copy; its save is still on the way.
        it.subject = old.subject;
        it.body = old.body;
      }
      items.push(it);
    }
    for (const key of staged) if (!seen.has(key)) staged.delete(key);
    s.items = items;
  }

  /**
   * Fetch the queue and re-render around it. Resolves true when fresh data landed. A failed
   * first load shows the error state; a failed refresh keeps what is on screen.
   */
  async function load({ focusOnVanish = false } = {}) {
    const seq = ++s.loadSeq;
    loading++;
    try {
      const rows = await api.get('/api/drafts', { signal: ctl.signal });
      if (!alive || seq !== s.loadSeq) return false;
      const vis = visibleItems();
      const prevIndex = vis.findIndex((it) => it.key === s.key);
      const focusWasInDetail = !!d && (d.el.contains(document.activeElement) || document.activeElement === document.body);
      const first = s.items === null;
      s.error = null;
      applyDrafts(Array.isArray(rows) ? rows : []);
      afterData(prevIndex, focusOnVanish && focusWasInDetail);
      if (first && s.key) {
        const el = optionEl(s.key);
        if (el) el.scrollIntoView({ block: 'center' });
      }
      return true;
    } catch (err) {
      if (!alive || seq !== s.loadSeq || (err && err.name === 'AbortError')) return false;
      if (s.items === null) {
        s.error = err;
        renderHeader();
        renderBody();
      }
      return false;
    } finally {
      loading--;
    }
  }

  function afterData(prevIndex, focusOnVanish) {
    let urlChanged = false;
    if (s.want) {
      const { domain, channel } = s.want;
      s.want = null;
      if (domain) {
        const key = resolveKey(domain, channel);
        if (key) {
          const tabBefore = s.tab;
          ensureTabFor(key);
          s.key = key;
          if (s.tab !== tabBefore) syncUrl({ replace: true });
        } else {
          s.missing = lower(domain);
        }
      }
    }
    if (s.key && !find(s.key)) {
      // The selected draft left the queue (sent, discarded): move to the one that took its place.
      s.key = null;
      urlChanged = true;
      const vis = visibleItems();
      if (vis.length && prevIndex >= 0 && (wide.matches || focusOnVanish)) s.key = vis[Math.min(prevIndex, vis.length - 1)].key;
    }
    renderHeader();
    renderBody();
    const before = d ? d.key : null;
    syncDetail();
    if (!s.key) autoSelect();
    else if (before !== s.key) loadCompany(find(s.key).domain);
    if (urlChanged && s.key) syncUrl({ replace: true });
    else if (urlChanged) deselect();
    if (urlChanged && focusOnVanish && s.key) focusOption(s.key);
    loadNames();
  }

  function retry() {
    s.error = null;
    renderHeader();
    renderBody();
    load();
  }

  // Company names for the rows: a paged lookup of drafted companies (DraftDto has no names), then
  // of sent ones when drafts remain unnamed (a follow-up draft leaves its company at "sent"). It
  // runs once for the drafts on screen, and again only for drafts that arrive later with a
  // domain no lookup has covered yet, whatever the outcome.
  async function loadNames() {
    if (namesLoading || !s.items) return;
    const unknown = new Set(s.items.filter((it) => !companies.has(it.domain) && !namesTried.has(it.domain)).map((it) => it.domain));
    if (!unknown.size) return;
    for (const domain of unknown) namesTried.add(domain);
    namesLoading = true;
    try {
      for (const stage of NAME_STAGES) {
        if (![...unknown].some((domain) => !companies.has(domain))) break;
        for (let page = 1; page <= NAME_PAGES; page++) {
          const res = await api.get(`/api/companies?stage=${stage}&per=${NAME_PER}&page=${page}`, { signal: ctl.signal });
          for (const r of (res && res.rows) || []) {
            mergeCompany(r.domain, { name: r.name || null, founder: r.founder || null, email: r.email || null, source_query: r.source_query || null });
          }
          if (!alive) return;
          if (page * NAME_PER >= ((res && res.total) || 0)) break;
        }
      }
    } catch (_) {
      // Names are a nicety: the rows keep their domains and recipients.
      return;
    } finally {
      namesLoading = false;
    }
    if (!alive) return;
    refreshLabels();
    loadNames(); // drafts that landed while this lookup ran
  }

  function loadCompany(domain) {
    const known = companies.get(domain);
    if (known && known.full) return;
    if (companyCtl) companyCtl.abort();
    const mine = new AbortController();
    companyCtl = mine;
    api.get(`/api/companies/${enc(domain)}`, { signal: mine.signal }).then(
      (res) => {
        const company = (res && res.company) || {};
        mergeCompany(domain, {
          name: company.name || undefined,
          source_query: company.source_query || undefined,
          contacts: (res && res.contacts) || [],
          full: true,
        });
        if (alive) refreshLabels();
      },
      () => {
        /* the detail falls back to what the queue knows */
      },
    );
  }

  function refreshLabels() {
    if (!s.items || !s.items.length) return;
    renderList();
    const it = s.key ? find(s.key) : null;
    if (it) fillHead(it);
  }

  // ---- Store, URL updates, unmount ----

  // The server's draft counts: [all, email, linkedin], or null.
  const queueCounts = (sm) => {
    const n = sm && sm.counts;
    return n && Number.isFinite(n.drafts) ? [n.drafts, n.drafts_email, n.drafts_linkedin] : null;
  };

  const unsubscribe = store.subscribe(({ status, summary }) => {
    if (!alive) return;
    const queueBefore = String(queueCounts(s.summary));
    if (status) s.status = status;
    if (summary) s.summary = summary;
    renderHeader();
    // Rebuilt only when what they depend on moved (auto-send, the LinkedIn session, the hour).
    refreshActions();
    if (s.items && !s.items.length) renderBody();
    // Drafts written elsewhere (the agent, a schedule) while this screen is open: reload when
    // the server's counts moved and no longer match the list. (The screen's own actions reload
    // the queue themselves; a fetch already on its way brings the change in anyway.)
    const server = queueCounts(s.summary);
    if (s.items && !loading && server && String(server) !== queueBefore) {
      const c = counts();
      const shown = [c.all, c.email, c.linkedin];
      if (server.some((n, i) => Number.isFinite(n) && n !== shown[i])) load();
    }
  });

  const onWide = () => {
    if (!alive) return;
    if (wide.matches) autoSelect();
  };
  wide.addEventListener('change', onWide);

  function update(c) {
    if (!alive) return false;
    const tab = pickTab(c.query.tab);
    const q = c.query.q || '';
    const domain = c.path[1] || null;
    const channel = c.query.channel || null;
    let listChanged = false;
    if (tab !== s.tab) {
      s.tab = tab;
      tabBar.setActive(tab);
      writeStore('localStorage', TAB_KEY, tab);
      s.limit = PAGE;
      listChanged = true;
    }
    // The URL keeps the filter trimmed (syncUrl), so its own echo differs from what is typed only
    // by the spaces at the ends: that is no change, and the box keeps the space just typed.
    if (q.trim() !== s.q.trim()) {
      s.q = q;
      if (filter.value !== q) filter.value = q;
      s.limit = PAGE;
      listChanged = true;
    }
    if (!s.items) {
      s.want = { domain, channel };
      if (listChanged) renderHeader();
      return true;
    }
    if (listChanged) {
      renderHeader();
      renderBody();
    }
    if (domain) {
      const key = resolveKey(domain, channel);
      if (key && key !== s.key) {
        ensureTabFor(key);
        select(key, { updateUrl: false });
      } else if (!key && lower(domain) !== s.missing) {
        s.key = null;
        s.missing = lower(domain);
        markSelected();
        renderDetail();
      }
    } else if (s.key || s.missing) {
      // Back to the list ("All drafts", Esc, or the browser's Back on a phone): onto the draft
      // that was open.
      const refocus = s.refocus || (wide.matches ? null : s.key);
      s.refocus = null;
      s.missing = null;
      deselect({ updateUrl: false });
      if (refocus) {
        if (wide.matches) focusOption(refocus);
        else returnToList(refocus);
      }
      autoSelect();
    } else {
      autoSelect();
    }
    return true;
  }

  // A Send all run started or moved on (maybe by an earlier mount of this screen).
  function onRunChanged() {
    if (!alive) return;
    renderSendAll();
    refreshActions();
    if (bulkStart() && !bulkTimer) scheduleBulkPoll();
  }

  function destroy() {
    alive = false;
    // Every unsaved edit gets one more save on the way out: the one waiting on the debounce, and
    // one whose save failed (nothing else would try it again).
    saveSoon.cancel();
    for (const it of s.items || []) if (isDirty(it)) saveNow(it.key, { last: true });
    ctl.abort();
    if (companyCtl) companyCtl.abort();
    clearTimeout(rowTimer);
    clearTimeout(bulkTimer);
    filterToUrl.cancel();
    unbindKeys();
    unsubscribe();
    wide.removeEventListener('change', onWide);
    window.removeEventListener('pagehide', onPageHide);
  }

  // ---- Start ----

  renderHeader();
  renderBody();
  load().then((fresh) => {
    if (!alive || !fresh) return;
    scheduleRowPoll();
    if (bulkStart()) {
      if (Date.now() - bulkStart() > BULK_TIMEOUT_MS) endBulk();
      else scheduleBulkPoll();
    }
  });

  return { update, destroy, runChanged: onRunChanged, reload: () => load() };
}

export default {
  title: TITLE,
  css: true,
  mount(root, ctx) {
    const v = createView(root, ctx);
    active = v;
    return () => {
      v.destroy();
      if (active === v) active = null;
    };
  },
  update(ctx) {
    return active ? active.update(ctx) : false;
  },
};

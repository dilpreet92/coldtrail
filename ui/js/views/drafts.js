// Drafts (spec §5.4): the review queue. Tabs All / Email / LinkedIn with counts, a filter, a list
// that renders at most 100 rows at a time ("Show more"), and the selected draft beside it. J / K
// move, Enter jumps into the editor, Esc returns to the list. Edits autosave (600ms debounce) to
// their own channel's draft, and are flushed before switching drafts, leaving the screen (the
// router's beforeLeave), or any send; a send whose edit can't be saved doesn't go out. Email
// drafts create a Gmail draft or send now; LinkedIn notes open in LinkedIn (then "Did it send?")
// or send through coldtrail; parked LinkedIn drafts say why auto-send skips them. Send all… states
// exactly what goes out before anything does; while it runs (even after the dialog closes or the
// screen is left and reopened) Send all shows its progress and nothing else can send the same
// drafts. The LinkedIn pollers (one row, or the bulk sender) stop when the screen unmounts and
// pick up again when it comes back. coldtrail's own LinkedIn sends (Send invite, Send all) mirror
// the sender's stops: none are offered while LinkedIn is signed out, outside 08:00–20:00 local or
// at a used-up cap, and a row's send stops being watched as soon as the sender shows it gave up.
// Open in LinkedIn, the manual path, has no hours or caps and never waits, but it drives the same
// Chrome profile, so it too is off until LinkedIn is connected. While a draft is on its way out
// (into Gmail, sent, opened in LinkedIn) its text is read-only: the server already has it.
//
// Data: GET /api/drafts (the queue, with each draft's contact and company names),
// /api/companies/:domain (the selected draft's source query and its contact's role), the shared
// store (status for auto-send and caps, summary for the empty state). A draft with no names falls
// back to its domain and recipient.

import { api, errorText, isStaleSession } from '../core/api.js';
import { debounce, fmtNum, h, pluralize, safeUrl } from '../core/dom.js';
import { bindKeys } from '../core/keys.js';
import { confirmDialog, isBusy, openDialog, setBusy, toast } from '../core/ui.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/emptyState.js';
import { listDetail } from '../components/listDetail.js';
import { tabs } from '../components/tabs.js';

const TITLE = 'Drafts';
const ERROR_DESC = 'Drafts the agent writes wait here for your review.'; // the header when the queue couldn't load
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
const GMAIL_DRAFTS = 'https://mail.google.com/mail/u/0/#drafts';
const TAB_IDS = ['all', 'email', 'linkedin'];
const TAB_KEY = 'ct-drafts-tab';
const SEND_OK_KEY = 'ct-send-confirmed'; // + '-email' / '-linkedin': one first-send confirm per channel
const BULK_KEY = 'ct-li-bulk';
const WIDE = '(min-width: 900px)';
// A refusal that applies to every email, not just one: stop the bulk loop instead of repeating it.
const EMAIL_GATE = /dry run|cap reached|auto-send is off|isn't connected|not connected/i;
const CONTACTED = ['sent', 'replied', 'bounced']; // outreach statuses that mean something went out
const WAITING = ['draft_pending', 'drafted']; // outreach statuses of a draft still in the queue

// Page-lifetime state (kept across remounts, gone on reload — except what sessionStorage holds).
const staged = new Set(); // LinkedIn drafts opened with assist, waiting for "Did it send?"
const opening = new Set(); // LinkedIn drafts being opened with assist (Open in LinkedIn on its way)
const starting = new Set(); // LinkedIn drafts whose Send invite is on its way to the server
const rowSends = new Map(); // key -> { at, timedOut, who }: per-row LinkedIn sends being watched
const pushing = new Map(); // key -> auto: email drafts being sent / put in Gmail one at a time (Send now)
const details = new Map(); // domain -> { source_query, contacts } from /api/companies/:domain
const sendConfirmed = new Set(); // channels whose first send this session was confirmed
let active = null; // the mounted view: { update, beforeLeave, destroy, runChanged, stateChanged, reload, saveFirst }
// The Send all run while it goes: { auto, i, n, li, key } (email send mode, the email being sent,
// how many, whether it starts the LinkedIn sender after them, the key of the one being sent). It
// outlives the view that started it, so a remount still sees it: Send all and Send now stay
// disabled until it ends.
let run = null;

const runChanged = () => {
  if (active) active.runChanged();
};

// A send started by an earlier mount of the screen landed after it was left (and maybe opened
// again): the screen showing now shows it.
const stateChanged = () => {
  if (active) active.stateChanged();
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

/**
 * Why nothing can be done in LinkedIn from here, Open in LinkedIn included, or null: 'reconnect'
 * or 'connect' as above. Both buttons drive coldtrail's own Chrome profile, which is signed in to
 * LinkedIn only once it's connected; without that the server finds LinkedIn's sign-in page and
 * answers "signed out". Taken as connected until /api/status has loaded (the server says so if not).
 */
function liSession(status) {
  const gate = status ? liGate(status) : null;
  return gate === 'reconnect' || gate === 'connect' ? gate : null;
}

const connectionsLink = () => h('a', { href: '#/settings?tab=connections' }, 'Settings → Connections');
const sendingLink = () => h('a', { href: '#/settings?tab=sending' }, 'Settings → Sending');

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

/** Which LinkedIn cap `c` (caps()) says is used up, as a sentence: "The daily LinkedIn cap is
 *  reached (15 of 15 sent today)". */
function capReached(c) {
  return c.liCap === 'week'
    ? `The weekly LinkedIn cap is reached (${fmtNum(c.week)} of ${fmtNum(c.weekly)} sent in the last 7 days)`
    : `The daily LinkedIn cap is reached (${fmtNum(c.today)} of ${fmtNum(c.daily)} sent today)`;
}

/** Send invite at a used-up cap: until when it waits, and what still works (strings and nodes). */
function capText(c) {
  // (The weekly cap is a rolling one: it frees up as the week's invites get older.)
  const until = c.liCap === 'week' ? 'until some of them are more than a week old' : 'until tomorrow';
  return [`${capReached(c)}, so Send invite waits ${until}. Open in LinkedIn works any time; raise the cap in `, sendingLink(), '.'];
}
/** Email sends wait while a Send all works through the emails (and until the queue reloads). */
const emailBlocked = () => !!(run && run.n);

/**
 * Whether coldtrail can reach Gmail to create a draft there or send: a Gmail app password or
 * sign-in (`destination_connected`), or a gcloud login, which `gmail::token` falls back to. Taken
 * as yes until /api/status has loaded (the server says so if it can't).
 */
const gmailReady = (status) => !status || !!status.destination_connected || !!status.gcloud_available;

const enc = encodeURIComponent;
const lower = (v) => (v == null ? '' : String(v).toLowerCase());
const named = (v) => (v == null || !String(v).trim() ? null : String(v).trim());

function toItem(d) {
  const channel = d.channel === 'linkedin' ? 'linkedin' : 'email';
  const domain = String(d.domain || '');
  const it = {
    key: `${channel}:${domain}`,
    domain,
    channel,
    to: d.to || null,
    person: named(d.contact_name),
    company: named(d.company_name),
    subject: d.subject == null ? '' : String(d.subject),
    body: d.body == null ? '' : String(d.body),
    status: d.status === 'drafted' ? 'drafted' : 'draft_pending',
    parked: d.auto_skip || null,
    extra: 0, // older drafts on the same domain + channel, folded into this row
    savedAt: 0, // when this draft's last save landed (the `clock` below), 0 if never
  };
  it.saved = snapshot(it);
  return it;
}

// What a save would write: email drafts save subject + body, LinkedIn notes only the body.
function snapshot(it) {
  return it.channel === 'email' ? JSON.stringify([it.subject, it.body]) : JSON.stringify([it.body]);
}
const isDirty = (it) => !!it && snapshot(it) !== it.saved;
// The channel goes with every save, so a LinkedIn note never overwrites the same company's email.
const payloadOf = (it) =>
  it.channel === 'email' ? { channel: 'email', subject: it.subject, body: it.body } : { channel: 'linkedin', body: it.body };
const editable = (it) => it.channel === 'linkedin' || it.status === 'draft_pending';
const overLimit = (it) => it.channel === 'linkedin' && it.body.length > NOTE_MAX;

/** The selected draft's contact in its company's details (for the role), once they've loaded. */
function contactFor(it) {
  const c = details.get(it.domain);
  const to = lower(it.to);
  if (!c || !c.contacts || !to) return null;
  return c.contacts.find((k) => lower(it.channel === 'linkedin' ? k.linkedin_url : k.email) === to) || null;
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

/**
 * What a draft is called. `name`: who it goes to, else the company, else the domain (a row's
 * title, the detail's heading). `org`: the company, else the domain (what Discard skips, what a
 * toast names). `sub`: the row's second line, "Company · domain" under a person's name, else the
 * recipient (· domain under a company name).
 */
function labelsOf(it) {
  const { person, company } = it;
  const k = person ? contactFor(it) : null;
  return {
    person,
    company,
    role: named(k && k.role),
    name: person || company || it.domain,
    org: company || it.domain,
    sub: (person ? [company, it.domain] : [shortRecipient(it), company ? it.domain : null]).filter(Boolean).join(' · '),
    recipient: recipientText(it),
  };
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
      { id: 'all', label: 'All' },
      { id: 'email', label: 'Email' },
      { id: 'linkedin', label: 'LinkedIn' },
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
    return [it.domain, it.to, it.subject, it.company, it.person].some((v) => v && lower(v).includes(q));
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

  // The server's draft counts: [all, email, linkedin], or null.
  const queueCounts = (sm) => {
    const n = sm && sm.counts;
    return n && Number.isFinite(n.drafts) ? [n.drafts, n.drafts_email, n.drafts_linkedin] : null;
  };

  // The tabs' counts: the queue's once it has loaded; until then (or when it couldn't load) the
  // summary's, as the sidebar shows them, else none rather than a 0 that isn't known.
  function tabCounts() {
    if (s.items) return counts();
    const n = queueCounts(s.summary) || [];
    return { all: n[0], email: n[1], linkedin: n[2] };
  }

  function caps() {
    const st = s.status || {};
    const auto = !!st.auto_send;
    const cap = st.daily_send_cap || 20;
    // Emails sent today (deliver::sent_today), or null from a server that doesn't report it.
    const emailToday = Number.isFinite(st.email_sent_today) ? st.email_sent_today : null;
    const daily = st.linkedin_daily_cap || 15;
    const weekly = st.linkedin_weekly_cap || 80;
    const today = st.linkedin_sent_today || 0;
    const week = st.linkedin_sent_7d || 0;
    return {
      auto,
      cap,
      emailToday,
      // Why an email's own send (Create Gmail draft, Send now) can't go now, or null: 'gmail' when
      // Gmail can't be reached, 'cap' when auto-send has used up today's cap.
      emailGate: !gmailReady(s.status) ? 'gmail' : auto && emailToday != null && emailToday >= cap ? 'cap' : null,
      liAuto: !!st.linkedin_auto_send,
      daily,
      weekly,
      today,
      week, // in the last 7 days (the weekly cap is a rolling one)
      // Which LinkedIn cap is used up ('week' first: it waits longer), or null. The sender refuses
      // at either before it sends anything.
      liCap: !s.status ? null : week >= weekly ? 'week' : today >= daily ? 'day' : null,
      gate: liGate(s.status), // why coldtrail can't send LinkedIn invites now, or null
      session: liSession(s.status), // why nothing can be done in LinkedIn from here, or null
    };
  }

  // ---- Header ----

  function describe() {
    const c = caps();
    const n = counts()[s.tab];
    if (!n) return 'Nothing waiting for review.';
    const lead = `${fmtNum(n)} waiting for review.`;
    const liCaps = `${c.daily} a day, ${c.weekly} a week`;
    // Emails waiting to go to Gmail while it can't be reached (one already in Gmail needs no
    // connection: it's sent from Gmail, then marked sent here).
    const gmailOff = c.emailGate === 'gmail' && (s.items || []).some((it) => it.channel === 'email' && it.status === 'draft_pending');
    // LinkedIn notes waiting while LinkedIn isn't connected (or is signed out): none can be opened
    // or sent from here.
    const liOff = !!c.session && (s.items || []).some((it) => it.channel === 'linkedin');
    const liVerb = c.session === 'reconnect' ? 'Reconnect' : 'Connect';
    const them = n === 1 ? 'it' : 'them';
    if (s.tab === 'email') {
      if (gmailOff) {
        return `${lead} Connect Gmail in Settings → Connections to ${c.auto ? `send ${them}` : `put ${them} in your Gmail Drafts`} from here.`;
      }
      return c.auto
        ? `${lead} Send now emails it from your Gmail right away, up to ${c.cap} a day.`
        : `${lead} Create Gmail draft puts it in your Gmail Drafts; you send it from there. Pace a new mailbox at about 5 a day.`;
    }
    if (s.tab === 'linkedin') {
      if (liOff) {
        return `${lead} ${liVerb} LinkedIn in Settings → Connections to ${c.liAuto ? `send ${them}` : `open ${them} in LinkedIn`} from here.`;
      }
      return c.liAuto
        ? `${lead} Send invite sends it from your LinkedIn within your caps: ${liCaps}.`
        : `${lead} Open in LinkedIn fills in your note; you click Send there.`;
    }
    const parts = [lead];
    if (c.liAuto && !liOff) parts.push(`LinkedIn invites send within your caps: ${liCaps}.`);
    if (gmailOff && liOff) {
      const li = c.session === 'reconnect' ? 'reconnect LinkedIn' : 'LinkedIn';
      parts.push(`Connect Gmail and ${li} in Settings → Connections to use them from here.`);
    } else if (gmailOff) {
      parts.push(`Connect Gmail in Settings → Connections to ${c.auto ? 'send emails' : 'put emails in your Gmail Drafts'} from here.`);
    } else if (liOff) {
      parts.push(`${liVerb} LinkedIn in Settings → Connections to ${c.liAuto ? 'send invites' : 'open notes in LinkedIn'} from here.`);
    }
    if (!gmailOff && c.auto) parts.push(`Email sends stop at ${c.cap} a day.`);
    if (!c.liAuto && !c.auto) parts.push('Nothing goes out until you send it.');
    return parts.join(' ');
  }

  function statsLine() {
    if (!s.status) return [];
    const c = caps();
    const num = (t) => h('span', { class: 'num' }, t);
    // Today's sends against the cap, as LinkedIn's are; the plain cap from a server that doesn't
    // report them.
    const emailUse = () => (c.emailToday != null ? [num(`${c.emailToday}/${c.cap}`), ' today'] : ['cap ', num(`${c.cap}/day`)]);
    if (s.tab === 'email') return c.auto ? ['Auto-send on · ', ...emailUse()] : ['Auto-send off'];
    const email = c.auto ? ['Email auto-send on · ', ...emailUse()] : ['Email auto-send off'];
    const li = [
      num(`${c.today}/${c.daily}`), ' today · ', num(`${c.week}/${c.weekly}`), ' in the last 7 days',
    ];
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

  let sendAllLabel = null; // what the busy Send all says now, or null
  function renderSendAll() {
    const label = busyLabel(s.tab);
    // While a send runs the button is busy and says how far it got. Busy, not disabled, keeps it
    // focusable, so focus has somewhere to land when the Send all dialog closes mid-run.
    if (label !== sendAllLabel) {
      sendAllLabel = label;
      setBusy(sendAllBtn, !!label, { label });
    }
    sendAllBtn.disabled = !label && (!s.items || counts()[s.tab] === 0);
  }

  function renderHeader() {
    tabBar.setCounts(tabCounts());
    // (A failed first load says so in the body; the header keeps its place.)
    desc.textContent = s.items ? describe() : s.error ? ERROR_DESC : 'Loading the review queue…';
    desc.hidden = !desc.textContent;
    stats.replaceChildren(...statsLine());
    renderSendAll();
  }

  // ---- Body: loading / error / empty / list + detail ----

  function errorPanel() {
    // A stale session: the shell's banner says what happened, this says what to do, and Try
    // again isn't offered (it can't work until coldtrail is reopened).
    const expired = isStaleSession(s.error);
    const panel = emptyState({
      title: 'Couldn’t load drafts',
      body: errorText(s.error) || 'Something went wrong.',
      action: expired
        ? null
        : h('button', { type: 'button', class: 'btn btn-secondary', onClick: retry }, 'Try again'),
    });
    panel.prepend(icon(ICONS.alert, 20));
    // Announced, as every screen's load error is; on a stale session the shell's banner already
    // is the alert, once.
    return h('div', { class: ['drafts-panel', 'drafts-error'], role: expired ? null : 'alert' }, panel);
  }

  const sentSoFar = () => (s.summary && s.summary.counts && s.summary.counts.sent) || 0;

  function emptyPanel() {
    const sent = sentSoFar();
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

  // What the empty state shows now (the count it names), or null when it isn't showing: a refresh
  // that changes none of it (every status poll) leaves it, and the keyboard on its link, alone.
  let emptySig = null;

  function renderBody() {
    if (!s.items || !s.items.length) listSig = null; // the list pane shows something else: rebuild next time
    if (!s.items || s.items.length) emptySig = null;
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
      const sig = String(sentSoFar());
      if (sig !== emptySig) {
        emptySig = sig;
        body.replaceChildren(emptyPanel());
      }
      return;
    }
    renderList();
  }

  function option(it, tabbable) {
    const l = labelsOf(it);
    const on = it.key === s.key;
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
      h('span', { class: 'draft-avatar', 'aria-hidden': 'true' }, initials(l.name)),
      h(
        'span',
        { class: 'draft-row-text' },
        h('span', { class: 'draft-row-title' }, l.name),
        h('span', { class: 'draft-row-sub' }, l.sub),
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
      it.key, l.name, l.sub, it.parked ? 1 : 0, it.extra, it.status, staged.has(it.key) ? 1 : 0, rowSendState(it.key),
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
    // The screen already shows what the address now says: only the address changes.
    nav.navigate(to, { replace, silent: true });
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
      loadDetails(it.domain);
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
    const fromDetail = !!d && d.el.contains(document.activeElement);
    select(vis[i].key, { focusList: focusList || listbox.contains(document.activeElement) });
    // From the draft (one of its actions, say), the keyboard moves on with it, onto the next
    // draft's heading, rather than dropping back to the top of the page.
    if (fromDetail && d && !d.el.contains(document.activeElement)) d.name.focus({ preventScroll: true });
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
  const failedSaves = new Map(); // key -> why its last save failed (until one succeeds)
  const quiet = new Set(); // keys whose save failure an action reports itself (no extra toast)
  const leaveQueued = new Map(); // key -> the text queued as its last save on leaving the screen
  // Orders saves against queue fetches: a fetch sent before a save landed may still carry the
  // text from before it, so applyDrafts keeps the saved text over that fetch's copy.
  let clock = 0;

  function showSave(key, state, message) {
    if (!alive || !d || d.key !== key || !d.save) return;
    const text = { pending: 'Saving…', saved: 'Saved', error: `Couldn’t save: ${message}` }[state] || '';
    d.save.textContent = text;
    d.save.classList.toggle('is-error', state === 'error');
  }

  /**
   * Save one draft's edit → Promise of null (saved, or nothing to save) or why it failed. Saves run
   * one after another, so an older edit can never land after a newer one, and each one writes the
   * text as it is when its turn comes (an edit undone inside the debounce window writes nothing).
   * They are not tied to the view's AbortController: an edit made just before leaving the screen
   * still lands. `last`: the save made on leaving the screen.
   */
  function saveNow(key, { last = false } = {}) {
    saveChain = saveChain.then(async () => {
      const it = find(key);
      if (!it || !isDirty(it)) {
        if (!failedSaves.has(key)) showSave(key, 'saved');
        return null;
      }
      const snap = snapshot(it);
      try {
        await api.post(`/api/drafts/${enc(it.domain)}`, payloadOf(it));
        const cur = find(key);
        if (cur) {
          cur.saved = snap;
          cur.savedAt = ++clock;
        }
        failedSaves.delete(key);
        // Still dirty: newer typing, whose own debounced save is already scheduled.
        showSave(key, isDirty(find(key)) ? 'pending' : 'saved');
        return null;
      } catch (err) {
        const msg = errorText(err);
        showSave(key, 'error', msg);
        if (last) {
          // The screen was left: the edit goes with it, so say which one.
          toast(`Your edit to ${labelsOf(it).org} wasn’t saved: ${msg}`, 'err');
        } else if (!failedSaves.has(key) && !quiet.has(key)) {
          toast(`Couldn’t save your edit: ${msg}`, 'err');
        }
        failedSaves.set(key, msg);
        return msg;
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

  /**
   * Before a send: the server sends what it has stored, so the edit must be saved first (tried
   * again if an earlier save failed) → null when it is, else why not. The caller says so in its
   * own words, so the save adds no toast of its own.
   */
  async function saveBeforeAction(key) {
    quiet.add(key);
    try {
      await flushSave();
      if (isDirty(find(key))) await saveNow(key);
    } finally {
      quiet.delete(key);
    }
    return isDirty(find(key)) ? failedSaves.get(key) || 'it couldn’t be saved' : null;
  }

  /**
   * Before Send all sends a draft: any edit to it saved first → null, or why it couldn't be. The
   * run outlives the screen that started it, so the edit is looked for where the user made it:
   * once this screen has been left and opened again, on the new one (an edit still in its
   * debounce, or one whose save failed). An edit this screen couldn't save as it was left (it
   * said so then) still keeps the draft back.
   */
  async function unsavedEdit(key) {
    if (alive || !active) return isDirty(find(key)) ? saveBeforeAction(key) : null;
    await flushSave(); // the saves this screen made as it was left
    if (isDirty(find(key))) return failedSaves.get(key) || 'it couldn’t be saved';
    return active.saveFirst(key);
  }

  function edit(key, fieldName, value) {
    const it = find(key);
    if (!it) return;
    it[fieldName] = value;
    if (it.channel === 'linkedin') updateNote(it);
    showSave(key, 'pending');
    saveSoon(key);
  }

  /**
   * Leaving the screen (the router's beforeLeave, then unmount): one last save for every unsaved
   * edit, the one waiting on the debounce and any whose save failed (nothing else would try it
   * again). An edit already queued this way isn't queued twice. Resolves when they're done.
   */
  function saveOnLeave() {
    saveSoon.cancel();
    for (const it of s.items || []) {
      if (!isDirty(it)) continue;
      const snap = snapshot(it);
      if (leaveQueued.get(it.key) === snap) continue;
      leaveQueued.set(it.key, snap);
      saveNow(it.key, { last: true });
    }
    return saveChain;
  }

  // A reload or closed tab inside the debounce window: send what's pending with keepalive.
  function onPageHide() {
    saveSoon.cancel();
    for (const it of s.items || []) {
      if (isDirty(it)) api.post(`/api/drafts/${enc(it.domain)}`, payloadOf(it), { keepalive: true }).catch(() => {});
    }
  }
  window.addEventListener('pagehide', onPageHide);

  // ---- Detail ----

  // What the detail's structure depends on (the text is kept in step by syncText).
  function detailSig(it) {
    return [it.channel, it.status, it.parked || '', it.to || '', it.extra].join('|');
  }

  function rowSendState(key) {
    const v = rowSends.get(key);
    return v ? (v.timedOut ? 'timeout' : 'sending') : '';
  }

  function actionsSig(it) {
    const c = caps();
    return [
      detailSig(it), staged.has(it.key), rowSendState(it.key), pushing.has(it.key), opening.has(it.key), starting.has(it.key),
      emailBlocked(), liBlocked(), !!bulkStart(), c.auto, c.liAuto, c.gate, c.session,
      c.emailGate, c.emailGate === 'cap' ? `${c.emailToday}/${c.cap}` : '', // (the cap hint names them)
      c.liCap, c.liCap ? `${c.today}/${c.daily}/${c.week}/${c.weekly}` : '',
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
      watchToasts();
      return;
    }
    // An email under review fills the pane on a desktop, its body taking the room left (drafts.css).
    const fill = it.channel === 'email' && it.status === 'draft_pending';
    const el = h('article', { class: ['draft', fill && 'draft-fill'], 'aria-labelledby': 'draft-title' });
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
    el.append(editor(it));
    d.save = editable(it) ? h('span', { class: 'draft-save', role: 'status' }) : null;
    d.actions = h('div', { class: 'draft-actions' });
    d.foot = h('div', { class: 'draft-foot' }, h('div', { class: 'draft-state' }, d.save), d.actions);
    el.append(d.foot);
    detailPane.replaceChildren(el);
    detailPane.scrollTop = 0;
    if (failedSaves.has(it.key)) showSave(it.key, 'error', failedSaves.get(it.key));
    else if (isDirty(it)) showSave(it.key, 'pending');
    fillHead(it);
    if (it.channel === 'linkedin') updateNote(it);
    refreshActions(true);
    watchToasts();
  }

  function editor(it) {
    if (it.channel === 'linkedin') {
      const note = h('textarea', {
        id: 'draft-note',
        class: 'input draft-text draft-note',
        rows: '8',
        spellcheck: 'true',
        'data-editor': '',
        'aria-describedby': 'draft-count', // + the error and the lock while they show (syncLock)
        value: it.body,
        onInput: (e) => edit(it.key, 'body', e.target.value),
      });
      d.note = note;
      d.text = { body: note };
      d.lock = lockLine();
      d.noteErr = h('p', { class: 'field-error', id: 'draft-note-err', hidden: true }, `Shorten the note to ${NOTE_MAX} characters or fewer to send it.`);
      d.link = h('p', { class: 'draft-link' });
      // The count sits under the note, at its end, as LinkedIn's own note box shows it.
      d.count = h('span', { class: 'draft-count', id: 'draft-count' });
      return h(
        'div',
        { class: 'draft-fields' },
        d.lock,
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'field-label', for: 'draft-note' }, 'Connection note'),
          note,
          h('div', { class: 'draft-note-meta' }, d.link, d.count),
          d.noteErr,
        ),
      );
    }
    const to = h('div', { class: 'draft-to' }, h('span', { class: 'field-label' }, 'To'), h('span', { class: it.to ? 'draft-to-addr' : 'draft-to-missing' }, recipientText(it)));
    if (it.status === 'drafted') {
      const subjectRo = readOnly('Subject', it.subject);
      const bodyRo = readOnly('Body', it.body, 'draft-ro-body');
      d.text = { subject: subjectRo.querySelector('.draft-ro'), body: bodyRo.querySelector('.draft-ro') };
      return h(
        'div',
        { class: 'draft-fields' },
        h('p', { class: 'draft-info' }, 'This email is in your Gmail Drafts. Send it from Gmail, then mark it sent here.'),
        to,
        subjectRo,
        bodyRo,
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
    d.text = { subject, body: text };
    d.lock = lockLine();
    return h('div', { class: 'draft-fields' }, d.lock, to, field('Subject', subject, 'draft-subject'), field('Body', text, 'draft-body'));
  }

  // Why the text can't be edited now (syncLock): named in the editor's description while it shows.
  const lockLine = () => h('p', { class: 'draft-lock', id: 'draft-lock', hidden: true });

  /**
   * Why the draft's text can't be edited now, or null: the server has taken it (or is about to)
   * for something under way, so an edit would never reach Gmail or LinkedIn, and one saved
   * meanwhile would be recorded as what went out.
   */
  function lockReason(it) {
    const { key } = it;
    if (it.channel === 'email') {
      const auto = pushing.has(key) ? pushing.get(key) : run && run.key === key ? run.auto : null;
      if (auto == null) return null;
      return auto ? 'Being sent: edits are off while it goes out.' : 'Being put in your Gmail Drafts: edits are off until it’s there.';
    }
    if (opening.has(key)) return 'Being opened in LinkedIn: edits are off until it’s open.';
    if (staged.has(key)) {
      return 'This note is open in LinkedIn: change it there if you need to. Editing here is off until you answer Did it send?';
    }
    if (starting.has(key) || rowSendState(key) === 'sending') return 'Being sent on LinkedIn: edits are off while it goes out.';
    return null;
  }

  /** The open draft's editor read-only, saying why, while it's on its way out (lockReason). */
  function syncLock(it) {
    if (!d || !it || d.key !== it.key || !d.lock) return;
    const why = lockReason(it);
    if (d.lock.textContent !== (why || '')) d.lock.textContent = why || '';
    d.lock.hidden = !why;
    for (const el of Object.values(d.text)) {
      el.readOnly = !!why;
      // A hidden element named in aria-describedby is still read out, so each part is named only
      // while it shows: the note's count, its over-the-limit error, why it can't be edited.
      const ids = [el === d.note && 'draft-count', el === d.note && overLimit(it) && 'draft-note-err', why && 'draft-lock'].filter(Boolean);
      if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
      else el.removeAttribute('aria-describedby');
    }
  }

  /**
   * The open draft's text as the server now has it (rewritten by the agent or a schedule while
   * the screen was open), when it has no unsaved edit: what's on screen is what a send sends. A
   * field being typed in keeps its caret.
   */
  function syncText(it) {
    if (!d || d.key !== it.key || !d.text || isDirty(it)) return;
    for (const [name, el] of Object.entries(d.text)) {
      const want = it[name];
      if (!el) continue;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.value === want) continue;
        const focused = document.activeElement === el;
        const [start, end] = focused ? [el.selectionStart, el.selectionEnd] : [0, 0];
        el.value = want;
        if (focused) el.setSelectionRange(Math.min(start, want.length), Math.min(end, want.length));
      } else if (el.textContent !== (want || '—')) {
        el.textContent = want || '—';
      }
    }
    if (it.channel === 'linkedin') updateNote(it);
  }

  function domainLink(domain) {
    const url = safeUrl(`https://${domain}`);
    return url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, domain) : h('span', {}, domain);
  }

  function fillHead(it) {
    if (!d || d.key !== it.key) return;
    const l = labelsOf(it);
    const c = details.get(it.domain);
    const source = named(c && c.source_query);
    // Unchanged (a poll's refresh): leave the links in the head alone.
    const sig = [l.person, l.role, l.company, l.name, it.domain, it.to, it.channel, it.status, it.parked, source].join('\u0001');
    if (sig === d.headSig) {
      relabel();
      return;
    }
    d.headSig = sig;
    d.name.textContent = l.name;
    const parts = [];
    if (l.person && l.role) parts.push(l.role);
    if (l.person && l.company) parts.push(l.company);
    parts.push(domainLink(it.domain));
    if (it.channel === 'linkedin') {
      const url = safeUrl(it.to);
      parts.push(url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, linkedinHandle(url)) : h('span', { class: 'draft-to-missing' }, recipientText(it)));
    }
    // Each item stays whole (a domain never breaks at its hyphen) and the line wraps between
    // them. The "·" between items is drawn by the CSS in front of each one, so a wrapped line
    // never ends on one (drafts.css, .draft-meta).
    d.meta.replaceChildren(h('span', { class: 'draft-meta-items' }, parts.map((p) => h('span', { class: 'draft-meta-item' }, p))));
    const status =
      it.channel === 'email' && it.status === 'drafted' ? badge('In Gmail', 'accent') : badge('Draft', 'neutral');
    d.badges.replaceChildren(...(it.parked ? [badge('Parked', 'warn')] : []), status);
    d.source.hidden = !source;
    d.source.replaceChildren(...(source ? [h('span', { class: 'draft-source-label' }, 'Sourced by:'), ' ', source] : []));
    relabel();
  }

  function updateNote(it) {
    if (!d || d.key !== it.key || !d.count) return;
    const over = overLimit(it);
    d.count.textContent = `${it.body.length} / ${NOTE_MAX}`;
    d.count.classList.toggle('is-over', over);
    d.noteErr.hidden = !over;
    syncLock(it); // (names the error in the note's description while it shows)
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
      if (!isBusy(b)) b.disabled = over || 'blocked' in b.dataset;
    }
  }

  function relabel() {
    if (!d) return;
    for (const [el, fn] of d.labels) if (!isBusy(el)) el.textContent = fn();
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
        const b = actionBtn('', 'primary', 'push', null);
        setBusy(b, true, { label: pushing.get(key) ? 'Sending…' : 'Creating…' });
        return [discardBtn, b];
      }
      const label = c.auto
        ? () => {
            const cur = find(key);
            const who = cur ? personFirst(cur) || cur.to : null;
            return who ? `Send now to ${who}` : 'Send now';
          }
        : () => 'Create Gmail draft';
      // Off while it can't work (Gmail can't be reached; auto-send has used up today's cap), and
      // waiting while Send all works through the emails: the hint beside it says which.
      let hint = null;
      if (c.emailGate === 'gmail') {
        hint = [`Gmail isn’t connected, so ${c.auto ? 'Send now' : 'Create Gmail draft'} is off. Connect it in `, connectionsLink(), '.'];
      } else if (c.emailGate === 'cap') {
        hint = [
          `The daily email cap is reached (${fmtNum(c.emailToday)} of ${fmtNum(c.cap)} sent), so Send now waits until tomorrow. Raise the cap in `,
          sendingLink(),
          '.',
        ];
      } else if (emailBlocked()) {
        hint = [run.auto ? 'Send all is sending your emails, one at a time.' : 'Send all is creating your Gmail drafts, one at a time.'];
      }
      return [
        hint ? h('span', { class: 'draft-hint' }, hint) : null,
        discardBtn,
        actionBtn('', 'primary', 'push', (e) => pushEmail(key, e.currentTarget), { label, blocked: !!hint }),
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
    if (opening.has(key)) {
      // Open in LinkedIn still on its way (this button was rebuilt meanwhile): it stays busy.
      const b = actionBtn('', 'primary', 'assist', null);
      setBusy(b, true, { label: 'Opening…' });
      return [discardBtn, b];
    }
    if (starting.has(key) || rowSendState(key) === 'sending') {
      const b = actionBtn('', 'primary', 'sending', null);
      setBusy(b, true, { label: 'Sending…' });
      return [h('span', { class: 'draft-hint' }, 'coldtrail is sending this invite in the LinkedIn window.'), b];
    }
    if (rowSendState(key) === 'timeout') {
      // It may still have gone out, so it isn't offered again until a reload.
      return [
        h('span', { class: 'draft-hint' }, 'The send didn’t confirm. Check the invite in LinkedIn, or reload this page to try again.'),
        actionBtn('Not confirmed', 'primary', 'sending', null, { disabled: true }),
      ];
    }
    const canSend = c.liAuto && !it.parked;
    // Neither button works while LinkedIn is signed out or was never connected: both are off, and
    // the hint says where to connect it. Send invite also stays off outside the sender's hours and
    // at a used-up cap (the sender would refuse it, and the screen would never hear why), and
    // waits while a bulk send runs (it may send this one). Open in LinkedIn is the manual path: it
    // has no hours or caps and never waits (the server answers "busy" if the window is in use).
    const { session } = c;
    const gate = canSend ? c.gate : null;
    const cap = canSend && !gate ? c.liCap : null;
    const waits = canSend && !gate && !cap && liBlocked();
    let hint = null;
    if (session) {
      hint = h('span', { class: 'draft-hint' }, gateText(session, canSend ? 'Open in LinkedIn and Send invite are off.' : 'Open in LinkedIn is off.'));
    } else if (gate) {
      hint = h('span', { class: 'draft-hint' }, gateText(gate, 'Send invite waits until then. Open in LinkedIn works any time.'));
    } else if (cap) {
      hint = h('span', { class: 'draft-hint' }, capText(c));
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
    const ready = canSend && !gate && !cap;
    const out = [
      hint,
      discardBtn,
      actionBtn('Open in LinkedIn', ready ? 'secondary' : 'primary', 'assist', (e) => assist(key, e.currentTarget), {
        needsNote: true,
        blocked: !!session,
      }),
    ].filter(Boolean);
    if (canSend) {
      out.push(
        actionBtn('', ready ? 'primary' : 'secondary', 'invite', (e) => sendInvite(key, e.currentTarget), {
          needsNote: true,
          blocked: !!gate || !!cap || waits,
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
    // What the actions follow (a send starting or ending) also locks the text, or frees it.
    syncLock(it);
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
    syncText(it);
    fillHead(it);
    refreshActions();
  }

  // ---- Busy buttons ----

  /** Mark an action button busy (a spinner, `text` if given, presses ignored; it keeps focus)
   *  → restore(). */
  function busy(btn, text) {
    setBusy(btn, true, { label: text });
    return () => {
      setBusy(btn, false);
      if (!btn.isConnected) return;
      relabel();
      if (d) applyOver(find(d.key));
    };
  }

  // ---- Actions ----

  // Asked once per channel and session: confirming an email's Send now says nothing about what
  // Send invite does on LinkedIn, so that one still asks the first time. Leaving the screen
  // answers no.
  async function confirmFirstSend(channel, opts) {
    const storeKey = `${SEND_OK_KEY}-${channel}`;
    if (sendConfirmed.has(channel) || readStore('sessionStorage', storeKey) === '1') return true;
    const ok = await confirmDialog({ ...opts, signal: ctl.signal });
    if (ok) {
      sendConfirmed.add(channel);
      writeStore('sessionStorage', storeKey, '1');
    }
    return ok;
  }

  // "Email not sent — your edit couldn't be saved: disk full".
  const unsaved = (what, reason) => toast(`${what} — your edit couldn’t be saved: ${reason}`, 'err');

  /** Reload the queue on the screen showing now: this one, or, once it has been left, the one
   *  opened since (if any). Resolves true when fresh data landed. */
  const reloadQueue = (opts) => (alive ? load(opts) : active ? active.reload(opts) : Promise.resolve(false));

  async function pushEmail(key, btn) {
    const it = find(key);
    // One send per draft at a time, none while Send all works through the emails, and none that
    // can't work (Gmail can't be reached, today's cap is used up).
    if (!it || pushing.has(key) || emailBlocked() || caps().emailGate) return;
    const auto = caps().auto;
    if (auto) {
      const ok = await confirmFirstSend('email', {
        title: 'Send this email now?',
        body: `It goes to ${it.to || 'the contact'} from your Gmail right away. You won’t be asked again in this browser session.`,
        confirmText: 'Send now',
        opener: btn,
      });
      if (!ok || pushing.has(key) || emailBlocked() || caps().emailGate) return;
    }
    pushing.set(key, auto);
    syncLock(it); // (the server sends what it has now: no edit until it's done)
    const restore = busy(btn, auto ? 'Sending…' : 'Creating…');
    const what = auto ? 'Email not sent' : 'Gmail draft not created';
    try {
      const reason = await saveBeforeAction(key);
      if (reason) {
        unsaved(what, reason);
        return;
      }
      const r = await api.post(`/api/drafts/${enc(it.domain)}/send`, {});
      if (r && r.ok) {
        // (A send's own message is the CLI's status line, "sent to … (3/20 today)": the toast
        // says it in this screen's words.)
        const l = labelsOf(it);
        toast(auto ? `Sent to ${l.person || it.to || l.org}.` : r.message || 'Created in your Gmail Drafts.', 'ok');
        store.refresh();
        // Onto the screen showing now: this one may have been left (and opened again) while the
        // send was on its way, and an email now in Gmail moves no count that would reload it.
        // A sent email leaves the queue: the keyboard goes on to the draft that took its place.
        await reloadQueue({ focusOnVanish: true });
        // One still here, now In Gmail (or the next of several on this channel), was rendered
        // again: the keyboard goes back to it, at its heading, rather than to the top of the page.
        if (alive && d && d.key === key && (!document.activeElement || document.activeElement === document.body)) {
          d.name.focus({ preventScroll: true });
        }
      } else {
        toast(`${what} — ${(r && r.message) || 'it could not be completed'}`, 'err');
      }
    } catch (err) {
      toast(`${what} — ${errorText(err)}`, 'err');
    } finally {
      pushing.delete(key);
      restore();
      if (alive) refreshActions();
      else stateChanged();
    }
  }

  async function markSent(key, btn) {
    const it = find(key);
    if (!it) return;
    const restore = busy(btn, 'Marking…');
    try {
      await api.post(`/api/followups/${enc(it.domain)}/mark`, { value: 'sent' });
      toast(`Marked ${labelsOf(it).org} as sent.`, 'ok');
      store.refresh();
      // It leaves the queue: the keyboard goes on to the draft that took its place.
      await load({ focusOnVanish: true });
      restore();
    } catch (err) {
      restore();
      toast(`Not marked sent — ${errorText(err)}`, 'err');
    }
  }

  /**
   * What decides whether discarding `domain`'s draft on `channel` skips the company: whether
   * anything has gone out to it yet (sent, replied or bounced, on either channel:
   * `mark::contacted`), and whether its draft on the other channel still waits. Each is true /
   * false, or null when that can't be told. Asked fresh, since a send or a new draft since the
   * details loaded changes them.
   */
  async function discardFacts(domain, channel) {
    try {
      const res = await api.get(`/api/companies/${enc(domain)}`, { signal: ctl.signal });
      const rows = res && Array.isArray(res.outreach) ? res.outreach : null;
      if (!rows) return { contacted: null, otherWaits: null };
      return {
        contacted: rows.some((o) => CONTACTED.includes(o.status)),
        otherWaits: rows.some((o) => (o.channel || 'email') !== channel && WAITING.includes(o.status)),
      };
    } catch (_) {
      return { contacted: null, otherWaits: null };
    }
  }

  let discardAsking = false; // Discard is finding out what it will do, before its confirm opens

  async function discard(key, btn) {
    const it = find(key);
    if (!it || discardAsking) return;
    const l = labelsOf(it);
    const what = it.channel === 'linkedin' ? 'LinkedIn note' : 'email';
    const n = it.extra + 1;
    // Discard deletes every pending draft on this domain + channel, folded rows included. A
    // company nothing has gone out to yet, with no draft waiting on its other channel, is then
    // marked Skip; one already written to (this is a follow-up) keeps its stage and stays in
    // Follow-ups, and one whose other draft still waits stays in Drafts.
    let facts;
    discardAsking = true;
    try {
      facts = await discardFacts(it.domain, it.channel);
    } finally {
      discardAsking = false;
    }
    if (!alive || !find(key)) return;
    const { contacted, otherWaits } = facts;
    const other = it.channel === 'linkedin' ? 'email' : 'LinkedIn note';
    const lead = it.extra ? `${n === 2 ? 'Both' : `All ${fmtNum(n)}`} ${what}s` : `The ${what}`;
    const gone = `${lead} to ${l.person || l.recipient} ${it.extra ? 'are' : 'is'} deleted`;
    let body;
    if (contacted) body = `${gone}. You’ve already been in touch with ${l.org}, so it stays in Follow-ups.`;
    else if (otherWaits) body = `${gone}. ${l.org}’s ${other} still waits, so it stays in Drafts.`;
    else if (contacted === false) body = `${gone} and ${l.org} is marked Skip, so it isn’t drafted again.`;
    else body = `${gone}. If nothing has gone out to ${l.org} yet, it’s marked Skip, so it isn’t drafted again.`;
    if (it.channel === 'email' && it.status === 'drafted') body += ' The copy in your Gmail Drafts stays there.';
    const ok = await confirmDialog({
      title: it.extra ? `Discard ${n === 2 ? 'both' : `all ${fmtNum(n)}`} drafts?` : 'Discard this draft?',
      body,
      confirmText: it.extra ? `Discard ${n === 2 ? 'both' : `all ${fmtNum(n)}`}` : 'Discard draft',
      danger: true,
      opener: btn,
      signal: ctl.signal,
    });
    if (!ok || !alive || !find(key)) return;
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
      failedSaves.delete(key);
      if (r && r.ok === false) {
        restore();
        toast(r.message === 'no pending draft' ? 'This draft was already sent or discarded.' : r.message || 'Nothing to discard.', 'err');
      } else {
        staged.delete(key);
        rowSends.delete(key);
        // The server says which it did (`skipped`; one that doesn't say always skipped). Not
        // skipped means written to before, or the other channel's draft still waits.
        let after = `${l.org} is now skipped.`;
        if (r && r.skipped === false) {
          after = !contacted && otherWaits ? `${l.org}’s ${other} still waits in Drafts.` : `${l.org} stays in Follow-ups.`;
        }
        toast(`${it.extra ? `${fmtNum(n)} drafts` : 'Draft'} discarded. ${after}`, 'ok');
      }
      store.refresh();
      await load({ focusOnVanish: true });
    } catch (err) {
      restore();
      toast(`Draft not discarded — ${errorText(err)}`, 'err');
      // Still there, so an edit that was waiting to save still needs to.
      if (isDirty(find(key))) saveSoon(key);
    }
  }

  async function assist(key, btn) {
    const it = find(key);
    if (!it || overLimit(it) || caps().session || opening.has(key)) return;
    const restore = busy(btn, 'Opening…');
    // LinkedIn opens with the note as saved now: no edit until it has (then "Did it send?").
    opening.add(key);
    syncLock(it);
    const reason = await saveBeforeAction(key);
    if (reason) {
      opening.delete(key);
      restore();
      settled();
      unsaved('LinkedIn not opened', reason);
      return;
    }
    try {
      const r = await api.post(`/api/drafts/${enc(it.domain)}/linkedin/assist`, {}).finally(() => opening.delete(key));
      if (r && r.staged) {
        staged.add(key);
        toast('Opened in LinkedIn — review the note and click Send there.', 'ok');
        if (!alive) {
          // Left (and maybe opened again) while LinkedIn opened: the screen showing now asks.
          stateChanged();
          return;
        }
        renderList();
        refreshActions(true);
        const yes = d && d.key === key ? d.actions.querySelector('[data-action="yes"]') : null;
        if (yes) yes.focus();
      } else if (r && r.already_invited) {
        toast('Already invited on LinkedIn (Pending) — marked as sent.', 'ok');
        store.refresh();
        await reloadQueue({ focusOnVanish: true });
        restore();
        settled();
      } else {
        restore();
        settled();
        toast('Couldn’t open LinkedIn.', 'err');
      }
    } catch (err) {
      restore();
      toast(await whyNotLinkedin('LinkedIn not opened', err), 'err');
      settled();
    }
  }

  /** After a LinkedIn action that didn't go ahead: the screen showing now shows it ended (the
   *  text editable again, the button back), this one or one opened since. */
  function settled() {
    if (alive) refreshActions();
    else stateChanged();
  }

  /**
   * A LinkedIn action the server refused, as a toast: "LinkedIn not opened — <why>". It may have
   * just found LinkedIn signed out (it records that, then says so), so the status is fetched again
   * first: the screen catches up at once rather than at the next refresh (30s), nothing offers the
   * action again, and the toast says how to reconnect in this screen's words.
   */
  async function whyNotLinkedin(what, err) {
    await store.refresh();
    const session = alive ? caps().session : null;
    return session ? `${what}. ${gatePlain(session)}` : `${what} — ${errorText(err)}`;
  }

  async function answer(key, sent, btn) {
    const it = find(key);
    if (!it) return;
    const group = btn.closest('.draft-ask');
    const others = group ? [...group.querySelectorAll('button')].filter((b) => b !== btn) : [];
    const restore = busy(btn);
    for (const b of others) b.disabled = true;
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
      restore();
      for (const b of others) if (b.isConnected) b.disabled = false;
      toast(`${sent ? 'Not marked sent' : 'Your answer wasn’t recorded'} — ${errorText(err)}`, 'err');
    }
  }

  async function sendInvite(key, btn) {
    const it = find(key);
    const blocked = () => liBlocked() || caps().gate || caps().liCap || rowSends.has(key) || starting.has(key);
    if (!it || overLimit(it) || it.parked || blocked()) return;
    const c = caps();
    const who = labelsOf(it).person || linkedinHandle(it.to || it.domain);
    const ok = await confirmFirstSend('linkedin', {
      title: 'Send this LinkedIn invite?',
      body: `coldtrail opens LinkedIn and sends the connection request to ${who} with your note, within your caps (${c.daily} a day, ${c.weekly} a week). You won’t be asked again in this browser session.`,
      confirmText: 'Send invite',
      opener: btn,
    });
    // (A status refresh while the confirm was open may have closed the window or used up a cap.)
    if (!ok || !alive || blocked()) return;
    const restore = busy(btn, 'Sending…');
    // The sender sends the note as saved now: no edit while it goes out.
    starting.add(key);
    syncLock(it);
    const reason = await saveBeforeAction(key);
    if (reason) {
      starting.delete(key);
      restore();
      settled();
      unsaved('Invite not sent', reason);
      return;
    }
    try {
      const r = await api.post(`/api/drafts/${enc(it.domain)}/linkedin/send`, {}).finally(() => starting.delete(key));
      if (!r || !r.sending) {
        restore();
        settled();
        toast('Couldn’t start the LinkedIn send.', 'err');
        return;
      }
      // (Named in its toasts: several can be going out, and they land after the user moved on.)
      rowSends.set(key, { at: Date.now(), timedOut: false, who });
      toast(`Sending on LinkedIn to ${who} — coldtrail is driving the browser…`, 'ok');
      if (!alive) {
        stateChanged(); // the screen showing now watches it
        return;
      }
      renderList();
      refreshActions(true);
      scheduleRowPoll();
    } catch (err) {
      restore();
      toast(await whyNotLinkedin('Invite not sent', err), 'err');
      settled();
    }
  }

  // ---- Send all ----

  /** A LinkedIn draft whose own Send invite is going out now (watched, not yet timed out). */
  function rowSending(it) {
    const v = rowSends.get(it.key);
    return !!v && !v.timedOut;
  }

  function sendPlan() {
    const c = caps();
    const all = s.items || [];
    const emailSide = s.tab !== 'linkedin';
    const liSide = s.tab !== 'email';
    const emailPending = emailSide ? all.filter((it) => it.channel === 'email' && it.status === 'draft_pending') : [];
    const inGmail = emailSide ? all.filter((it) => it.channel === 'email' && it.status === 'drafted').length : 0;
    const li = liSide ? all.filter((it) => it.channel === 'linkedin') : [];
    const parked = li.filter((it) => it.parked).length;
    // The bulk sender queues LinkedIn drafts that aren't parked and have a profile URL; one whose
    // own Send invite is still going out is that send's, so it isn't counted here.
    const sending = li.filter(rowSending).length;
    const queued = li.filter((it) => !it.parked && it.to && !rowSending(it));
    const sendable = queued.length;
    const room = Math.max(0, Math.min(c.daily - c.today, c.weekly - c.week));
    const liUpTo = Math.min(sendable, room);
    const running = liBlocked();
    // Auto-send stops at the daily cap, counting what already went out today when that's known.
    // None go anywhere while Gmail can't be reached.
    const emailRoom = Math.max(0, c.cap - (c.emailToday || 0));
    const emails = c.emailGate === 'gmail' ? [] : c.auto ? emailPending.slice(0, emailRoom) : emailPending;
    return {
      tab: s.tab, c, emailSide, liSide, emailPending, emails, inGmail, li, parked, sending, queued, sendable, liUpTo, running,
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
    if (n && c.emailGate === 'gmail') {
      const what = c.auto ? 'no emails can be sent' : 'no Gmail drafts can be created';
      return h(
        'li',
        { class: ['sendall-email', 'is-off'] },
        h('strong', {}, 'Email'),
        h('span', {}, `Gmail isn’t connected, so ${what}. Connect it in `, connectionsLink(), '.'),
      );
    }
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
    const usage = `${c.today}/${c.daily} today, ${c.week}/${c.weekly} in the last 7 days`;
    const left = [p.parked ? pluralize(p.parked, 'parked draft') : null, p.sending ? `${fmtNum(p.sending)} already sending` : null];
    const parkedNote = left.some(Boolean) ? `; ${left.filter(Boolean).join(' and ')} excluded` : '';
    let content;
    let off = false;
    if (!p.li.length) {
      content = ['No LinkedIn invites to send.'];
      off = true;
    } else if (p.running) {
      content = ['A LinkedIn bulk send is already running; it works through these invites one at a time.'];
      off = true;
    } else if (c.session) {
      // (Opening them one by one needs LinkedIn too: nothing to suggest until it's connected.)
      content = gateText(c.session, 'none go out now.');
      off = true;
    } else if (!c.liAuto) {
      const n = p.sendable;
      content = [
        `LinkedIn auto-send is off, so ${pluralize(n, 'invite')} ${n === 1 ? 'stays' : 'stay'} here. Turn it on in `,
        sendingLink(),
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
    // (With Gmail out of reach, or auto-send on and today's cap used up, no email goes out:
    // nothing to confirm there.)
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
      // Leaving the screen (the browser's Back) closes it; a run already going carries on.
      signal: ctl.signal,
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
    run = { auto, i: 0, n: emails.length, li: liGo, key: null };
    const step = (text) => {
      progress.textContent = text;
      runChanged();
    };
    let ok = 0;
    let stopped = null;
    let staleStop = false; // a stale session stopped the emails: the LinkedIn part would meet it too
    const failed = [];
    runChanged();
    try {
      await flushSave();
      for (let i = 0; i < emails.length; i++) {
        const it = emails[i];
        const name = labelsOf(it).org;
        run.i = i;
        run.key = it.key; // (its text is read-only while it goes: lockReason)
        step(`${auto ? 'Sending' : 'Creating'} ${fmtNum(i + 1)} of ${fmtNum(emails.length)}…`);
        // The server sends what it has stored: an edit it doesn't have yet (its save failed, or
        // is still on the way) is saved first, and an email whose edit can't be saved stays here.
        const reason = await unsavedEdit(it.key);
        if (reason) {
          failed.push(`${name}: your edit couldn’t be saved (${reason})`);
          continue;
        }
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
            failed.push(`${name}: ${msg}`);
          }
        } catch (err) {
          failed.push(`${name}: ${errorText(err)}`);
          // Every send after it would fail the same way (and so would the LinkedIn sender's
          // start: it isn't tried, so the summary toast is the only one).
          if (isStaleSession(err)) {
            staleStop = true;
            break;
          }
        }
      }
      run.i = run.n;
      run.key = null;
      if (emails.length) {
        const done = auto ? `Sent ${pluralize(ok, 'email')}.` : `Created ${pluralize(ok, 'Gmail draft')}.`;
        if (stopped) toast(`${done} Stopped: ${stopped}`, 'err');
        else if (failed.length) toast(`${done} ${fmtNum(failed.length)} failed:\n${failed.join('\n')}`, 'err');
        else toast(done, 'ok');
      }
      // (An error, as the emails' "Stopped:" is: it stays until dismissed.)
      if (gate) toast(`No LinkedIn invites went out. ${gatePlain(gate)}`, 'err');
      if (liGo && !staleStop) await startLinkedinSender(p, step);
      // Send now stays off until the queue shows what went out, so nothing goes twice.
      store.refresh();
      if (active) await active.reload();
    } finally {
      run = null;
      runChanged();
    }
  }

  // Send all's LinkedIn part: one bulk sender for the queue. Every note it will send is saved
  // first; if one can't be, nothing starts (the sender would send the older text).
  async function startLinkedinSender(p, step) {
    // A Send invite started while the dialog was open is that send's. When that leaves nothing,
    // say so: the confirm promised invites, and they are going out, just not from here.
    const queue = p.queued.filter((it) => !rowSending(it));
    if (!queue.length) {
      const n = p.queued.length;
      toast(
        n === 1
          ? 'No LinkedIn bulk send started: the invite is already being sent from its draft.'
          : `No LinkedIn bulk send started: all ${fmtNum(n)} invites are already being sent from their drafts.`,
      );
      return;
    }
    step('Starting the LinkedIn sender…');
    const unsavedNotes = [];
    for (const it of queue) {
      const reason = await unsavedEdit(it.key);
      if (reason) unsavedNotes.push(`${labelsOf(it).org} (${reason})`);
    }
    if (unsavedNotes.length) {
      toast(`LinkedIn invites not started — your edit couldn’t be saved: ${unsavedNotes.join(', ')}`, 'err');
      return;
    }
    try {
      const r = await api.post('/api/drafts/linkedin/send-all', {});
      if (r && r.sending) {
        // What it should get through today, and the queue it starts from: the poller reports it
        // finished once that many have left the queue (or the cap is reached).
        const keys = queue.map((it) => it.key);
        writeStore('sessionStorage', BULK_KEY, JSON.stringify({ at: Date.now(), want: Math.min(p.liUpTo, keys.length), keys }));
        toast('Sending on LinkedIn — one invite at a time, with pauses between them.', 'ok');
      } else {
        toast('Couldn’t start the LinkedIn bulk send.', 'err');
      }
    } catch (err) {
      toast(`The LinkedIn bulk send didn’t start: ${errorText(err)}`, 'err');
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
    // The status (the LinkedIn session, the caps), then the queue: a send that went out has left a
    // queue asked for after the status that counts it, so a cap it used up itself is never taken
    // for the reason it stopped.
    await store.refresh();
    if (!alive) return;
    const fresh = await load();
    if (!alive) return;
    const watched = [...rowSends.values()].filter((v) => !v.timedOut).length;
    let changed = false;
    for (const [key, v] of rowSends) {
      if (v.timedOut) continue;
      const it = fresh ? find(key) : null;
      const why = it ? rowStopped(it, watched) : null;
      if (fresh && !it) {
        rowSends.delete(key);
        toast(`Invite to ${v.who} sent on LinkedIn.`, 'ok');
        store.refresh();
      } else if (why) {
        // The sender gave up on it: the watch ends, and the draft offers what still works.
        rowSends.delete(key);
        changed = true;
        toast(`The invite to ${v.who} wasn’t sent. ${why}`, 'err');
      } else if (Date.now() - v.at > ROW_TIMEOUT_MS) {
        // Out of time, whether or not the queue could be read meanwhile (a server that stopped
        // answering): the button stays off (it may still go out), and now says it didn't confirm.
        v.timedOut = true;
        changed = true;
        toast(`The invite to ${v.who} didn’t confirm. Check it in LinkedIn, or reload this page to try again.`);
      }
    }
    if (changed) {
      renderList();
      refreshActions();
    }
    scheduleRowPoll();
  }

  /**
   * Why the sender gave up on a row's invite that's still queued, as a sentence, or null. Nothing
   * reports a failed send back, but some show: it parked the draft (LinkedIn wants the member's
   * email; it failed too often), LinkedIn signed out, or a cap was used up. A cap counts only
   * while this is the one send being watched: with others going out, one of them may have used it
   * up while this one, already past its check, still goes.
   */
  function rowStopped(it, watched) {
    if (it.parked) return capitalize(it.parked);
    const c = caps();
    if (c.session) return gatePlain(c.session);
    if (c.liCap && watched === 1 && !liBlocked()) return `${capReached(c)}.`;
    return null;
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
        // (An error: it stays until dismissed, since the user is often away while it runs.)
        else toast(`LinkedIn bulk send stopped: ${sent}. ${gatePlain(gate)}`, 'err');
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

  /** `since`: the clock when this copy of the queue was asked for. */
  function applyDrafts(rows, since) {
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
      if (old) {
        it.savedAt = old.savedAt;
        // Keep an unsaved edit over the server's copy (its save is still on the way), and a saved
        // one over a copy asked for before that save landed (it may predate it). Otherwise the
        // server's text wins: the agent or a schedule may have rewritten the draft.
        const dirty = isDirty(old);
        if (dirty || old.savedAt > since) {
          it.subject = old.subject;
          it.body = old.body;
          if (!dirty) it.saved = old.saved;
        }
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
    const since = ++clock;
    loading++;
    try {
      const rows = await api.get('/api/drafts', { signal: ctl.signal });
      if (!alive || seq !== s.loadSeq) return false;
      const vis = visibleItems();
      const prevIndex = vis.findIndex((it) => it.key === s.key);
      const focusWasInDetail = !!d && (d.el.contains(document.activeElement) || document.activeElement === document.body);
      const first = s.items === null;
      s.error = null;
      applyDrafts(Array.isArray(rows) ? rows : [], since);
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
    else if (before !== s.key) loadDetails(find(s.key).domain);
    if (urlChanged && s.key) syncUrl({ replace: true });
    else if (urlChanged) deselect();
    if (urlChanged && focusOnVanish && s.key) {
      if (wide.matches || !d) {
        focusOption(s.key);
      } else {
        // Phone: the list is hidden behind the draft that took its place, so the keyboard (and a
        // screen reader, which reads its name out) goes there, scrolled to its top.
        d.name.focus({ preventScroll: true });
        d.el.scrollIntoView({ block: 'start' });
      }
    }
  }

  function retry() {
    // Try again from the keyboard: the button goes with the panel, so the keyboard is placed again
    // once the reload lands (it would otherwise drop to the top of the page).
    const refocus = body.contains(document.activeElement);
    s.error = null;
    renderHeader();
    renderBody();
    start({ refocus });
  }

  /** After Try again: the keyboard on what's there now, unless it has moved on meanwhile. Failed
   *  again: Try again. The list: the open draft's row (a phone's open draft: its name), or the
   *  first row. Nothing waiting: the empty state's link. */
  function focusAfterRetry() {
    const el = document.activeElement;
    if (el && el !== document.body && document.contains(el)) return;
    if (!s.items) {
      const again = body.querySelector('.drafts-panel button');
      if (again) again.focus();
    } else if (!s.items.length) {
      const link = body.querySelector('.drafts-panel a');
      if (link) link.focus();
    } else if (d && !wide.matches) {
      d.name.focus({ preventScroll: true });
    } else {
      focusOption(s.key);
    }
  }

  // The selected draft's company details: the query that sourced it ("Sourced by") and its
  // contacts (the role beside the contact's name). Names come with the queue itself.
  function loadDetails(domain) {
    if (details.has(domain)) return;
    if (companyCtl) companyCtl.abort();
    const mine = new AbortController();
    companyCtl = mine;
    api.get(`/api/companies/${enc(domain)}`, { signal: mine.signal }).then(
      (res) => {
        const company = (res && res.company) || {};
        details.set(domain, { source_query: company.source_query || null, contacts: (res && res.contacts) || [] });
        if (alive) refreshLabels();
      },
      () => {
        /* the detail goes without: no source line, no role */
      },
    );
  }

  function refreshLabels() {
    const it = s.key ? find(s.key) : null;
    if (it) fillHead(it);
  }

  // ---- Toasts clear of the actions ----
  //
  // Toasts stack up from the bottom right, which is where a draft's action bar can be: pinned to
  // the pane's bottom edge under a long draft, or anywhere mid-pane under a short one (a LinkedIn
  // note), in one row or two. When the stack in its usual place would cover the bar, it moves to
  // just above the bar instead (an error toast stays until dismissed: it would block Send and
  // Discard). drafts.css reads the lift; it's set on <html> because #toasts is #app's sibling.
  //
  // On a phone the bar is the last thing on the page, under the toasts wherever it's scrolled:
  // the page gets room below it as tall as the stack (--drafts-toast-room), so scrolled to the
  // end the bar sits clear above them.
  const LIFT_VAR = '--drafts-toast-lift';
  const ROOM_VAR = '--drafts-toast-room';
  const rootStyle = document.documentElement.style;
  const tokenPx = (name, fallback) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback;
  const TOAST_EDGE = tokenPx('--space-4', 16); // components.css: #toasts' usual distance from the bottom
  const TOAST_GAP = tokenPx('--space-2', 8); // between the bar and the lifted stack
  const ldDetail = ld.querySelector('.ld-detail');
  const liftRO = typeof ResizeObserver === 'function' ? new ResizeObserver(() => placeToasts()) : null;
  const varNow = { [LIFT_VAR]: '', [ROOM_VAR]: '' }; // what each one is set to now
  let liftFrame = 0;

  function setVar(name, px) {
    const v = px > 0 ? `${Math.ceil(px)}px` : '';
    if (v === varNow[name]) return;
    varNow[name] = v;
    if (v) rootStyle.setProperty(name, v);
    else rootStyle.removeProperty(name);
  }
  const setLift = (px) => setVar(LIFT_VAR, px);
  const setRoom = (px) => setVar(ROOM_VAR, px);

  function placeToasts() {
    const host = document.getElementById('toasts');
    const foot = alive && d && d.foot && d.foot.isConnected ? d.foot : null;
    if (!host || !foot || !host.firstElementChild) {
      // (No toast showing: nothing to move. The next one resizes the stack, which calls back here
      // before it's painted.)
      setLift(0);
      setRoom(0);
      return;
    }
    if (!wide.matches) {
      setLift(0);
      setRoom(TOAST_EDGE + host.offsetHeight + TOAST_GAP);
      return;
    }
    setRoom(0);
    const vh = document.documentElement.clientHeight;
    const bar = foot.getBoundingClientRect();
    const col = host.getBoundingClientRect();
    const onScreen = bar.bottom > 0 && bar.top < vh;
    const underColumn = bar.right > col.left && bar.left < col.right;
    // The stack's top edge in its usual place, bottom right.
    const usualTop = vh - TOAST_EDGE - host.offsetHeight;
    const covers = onScreen && underColumn && bar.bottom + TOAST_GAP > usualTop;
    setLift(covers ? vh - bar.top + TOAST_GAP : 0);
  }

  // Scrolling the page (a short window) or resizing it moves the bar: once a frame is enough.
  function placeToastsSoon() {
    if (liftFrame) return;
    liftFrame = requestAnimationFrame(() => {
      liftFrame = 0;
      placeToasts();
    });
  }

  // What moves the bar or the stack: the stack growing or shrinking, the pane changing size (the
  // window, the header above it wrapping), the draft above the bar (banners, a resized editor),
  // and the bar itself (its actions wrapping onto a second row). Called whenever the detail is
  // rendered, to follow the new draft's elements.
  function watchToasts() {
    if (liftRO) {
      liftRO.disconnect();
      const host = document.getElementById('toasts');
      for (const el of [host, ldDetail, d && d.el, d && d.foot]) if (el) liftRO.observe(el);
    }
    placeToasts();
  }

  window.addEventListener('resize', placeToastsSoon);
  window.addEventListener('scroll', placeToastsSoon, { capture: true, passive: true });

  function unwatchToasts() {
    if (liftRO) liftRO.disconnect();
    cancelAnimationFrame(liftFrame);
    liftFrame = 0;
    window.removeEventListener('resize', placeToastsSoon);
    window.removeEventListener('scroll', placeToastsSoon, { capture: true });
    setLift(0);
    setRoom(0);
  }

  // ---- Store, URL updates, unmount ----

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
    placeToasts();
  };
  wide.addEventListener('change', onWide);

  function update(c) {
    if (!alive) return false;
    // Still here (a newer route won over a leave that was under way): a later leave saves again.
    leaveQueued.clear();
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

  // A send an earlier mount of this screen started landed after it was left: show what it left
  // behind (opened in LinkedIn, an email no longer on its way, an invite to watch). Until the
  // queue first loads there's nothing to show it on; that load shows it.
  function onStateChanged() {
    if (!alive || !s.items) return;
    renderBody();
    refreshActions();
    if (!rowTimer) scheduleRowPoll();
  }

  function destroy() {
    alive = false;
    // Normally beforeLeave has saved everything already; this catches typing since then.
    saveOnLeave();
    ctl.abort();
    if (companyCtl) companyCtl.abort();
    clearTimeout(rowTimer);
    clearTimeout(bulkTimer);
    filterToUrl.cancel();
    unbindKeys();
    unsubscribe();
    wide.removeEventListener('change', onWide);
    window.removeEventListener('pagehide', onPageHide);
    unwatchToasts();
  }

  // ---- Start ----

  // The first load (or Try again after it failed), then the pollers a send left running.
  // `refocus`: Try again was pressed from the keyboard.
  function start({ refocus = false } = {}) {
    load().then((fresh) => {
      if (alive && refocus) focusAfterRetry();
      if (!alive || !fresh) return;
      scheduleRowPoll();
      if (bulkStart() && !bulkTimer) {
        if (Date.now() - bulkStart() > BULK_TIMEOUT_MS) endBulk();
        else scheduleBulkPoll();
      }
    });
  }

  renderHeader();
  renderBody();
  start();

  return {
    update,
    beforeLeave: saveOnLeave,
    destroy,
    runChanged: onRunChanged,
    stateChanged: onStateChanged,
    reload: (opts) => load(opts),
    saveFirst: saveBeforeAction,
  };
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
  // Leaving by the sidebar, search or Back: the router waits (up to 1.5s) for the last saves, so
  // the next screen, or a reload right after, already sees the edit.
  beforeLeave() {
    return active ? active.beforeLeave() : undefined;
  },
};

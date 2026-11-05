// Agent (spec §5.6): the conversation list (search; "Your chats" / "Scheduled runs"), the
// transcript (agent text through the safe markdown subset, consecutive tool calls folded into
// "Worked · N steps" groups) and the composer (Enter sends, Shift+Enter is a newline, Stop closes
// the stream, which makes the server cancel the turn at its next event).
//
// Routes: #/agent is a new conversation, #/agent/<chat_id> an existing one, and
// #/agent?prompt=<text> fills the composer without sending (the Pipeline and Home hand-offs),
// only when the app was already running: one in the address the page loads with (a hand-off
// opened in a new tab, a link from elsewhere) waits in a notice above the composer for a click.
// Scheduled-run conversations are a read-only log, polled every 2s while the run is writing to
// them (a failed poll is tried again, less often, and the header says updates aren't arriving).
// Leaving the screen closes the stream, stops the poll and aborts every pending request;
// text typed but not sent waits in the composer for the screen to come back.
// While a turn streams, links inside this screen (other conversations, New chat, Settings) ask
// before they stop it; the sidebar can't be intercepted, so the composer says so instead.
//
// Server contract (inventory "Chat"): POST /api/chats/new clears the server's active
// conversation and POST /api/chats/:id/activate selects one; POST /api/chat {message} → {run}
// starts a turn in the conversation that is active when the request arrives (a new one if none
// is), and /api/chat/stream?run= streams its events once. So before each turn this view makes
// the conversation on screen the active one. A turn whose stream nobody claims keeps running
// (holding the server's one-turn lock) until a 45s reaper, so a turn this view gives up on is
// still claimed once and closed as soon as it connects, which cancels it.

import { api, errorText, isStaleSession, openStream } from '../core/api.js';
import { fmtNum, fmtRelative, h, runStatus } from '../core/dom.js';
import { renderMarkdown } from '../core/markdown.js';
import { href } from '../core/router.js';
import { confirmDialog, setBusy } from '../core/ui.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/emptyState.js';
import { listDetail } from '../components/listDetail.js';

const title = 'Agent';

const POLL_MS = 2000;
// After failed polls, the most ticks the next try waits (16s).
const POLL_BACKOFF_TICKS = 8;
// How often relative times ("just now", "2h ago") are brought up to date while the screen is open.
const TICK_MS = 30_000;
// After `done` the server still saves the reply (or deletes a failed first turn) before it
// closes the stream; wait for that close, but never longer than this.
const SETTLE_MS = 2000;
// A first turn stopped or cut off early may still be queued behind the server's one-turn lock
// (another tab's turn, or a stopped one finishing a long step), so its conversation isn't saved
// until that lock frees. Look for it again, less and less often: for ADOPT_PATIENCE_MS, and for a
// stopped turn up to ADOPT_WAIT_MS, its "Stopped" note saying what it waits for meanwhile.
const ADOPT_FIRST_GAP_MS = 700;
const ADOPT_MAX_GAP_MS = 5000;
const ADOPT_PATIENCE_MS = 2000;
const ADOPT_WAIT_MS = 120000;
const STOPPED_WAITING = "Stopped. The agent is busy with another turn; this conversation is saved once it's free.";
const STOPPED_DETACHED =
  "Stopped. The agent is still busy with another turn, so your message is saved as a conversation of its own once it's free.";
// A failed first turn: the server keeps nothing of it (keepFailed()).
const FAILED_BACK = "This conversation wasn't saved. Your message is back in the composer.";
// A scheduled run whose log is empty.
const EMPTY_RUN = 'It ended before the agent started.';
const LIST_PAGE = 50;
// How long the search waits for typing to pause before it says what it found.
const SAY_FOUND_MS = 300;
const MAX_INPUT_PX = 200;
const TITLE_CHARS = 60;
// The most of a dropped hand-off's first line its notice quotes (excerpt()).
const OFFER_CHARS = 120;
// Only the titles the server gives a run's log: "Scheduled run — <schedule>", "Manual run", and
// a bare "Scheduled run" from older versions. A chat whose first message starts with those words
// ("Manual run from yesterday found nothing…") is still the user's own.
const RUN_TITLE = /^(?:Scheduled run(?: — |$)|Manual run$)/;
const RUN_PREFIX = /^Scheduled run\s+—\s+/;
// What keeps keyboard focus in the transcript (a poll redraw puts it back by position).
const FOCUSABLE = 'a[href], button, summary';

const STARTERS = [
  {
    title: 'Source companies',
    // Pipeline's "Find companies" words: the company profile says which market, not the starter.
    text: 'Find 20 companies that match my company profile and add them to the pipeline.',
  },
  {
    title: 'Find founders',
    text: "Find the founders and their emails for the companies I sourced but haven't enriched yet.",
  },
  {
    title: 'Write drafts',
    text: 'Write intro emails for every company with a verified founder email, using my company profile.',
  },
  {
    title: 'Review the week',
    text: "Summarize this week: what was sourced, what's waiting in Drafts, and who replied.",
  },
];

const ICONS = {
  send: ['M12 19V5', 'M6 11l6-6 6 6'],
  stop: ['M8 8h8v8H8z'],
  plus: ['M12 5v14', 'M5 12h14'],
  list: ['M4 6h16', 'M4 12h16', 'M4 18h10'],
  caret: ['M9 6l6 6-6 6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  cross: ['M7 7l10 10', 'M17 7L7 17'],
  dash: ['M8 12h8'],
  alert: ['M12 3l9.5 17h-19L12 3z', 'M12 10v4', 'M12 17.5v.01'],
  lock: ['M7 11V8a5 5 0 0 1 10 0v3', 'M5.5 11h13v9.5h-13z'],
  link: ['M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1', 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
};

// A tool step's glyph and the words a screen reader hears after its name, by state (toolGroup).
const STEP_GLYPHS = { ok: 'check', done: 'check', fail: 'cross', none: 'dash' };
const STEP_WORDS = { fail: ' (failed)', pending: ' (running)', none: ' (no result)' };

function icon(name, size = 16) {
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
    },
    ICONS[name].map((d) => h('path', { d })),
  );
}

const isRun = (t) => RUN_TITLE.test(t || '');
const isAbort = (err) => !!err && err.name === 'AbortError';
const enc = encodeURIComponent;

/** The list label: runs drop the "Scheduled run —" prefix their section already says. */
function listTitle(t) {
  if (!t) return 'Untitled conversation';
  return t.replace(RUN_PREFIX, '') || t;
}

/** The title the server gives a new conversation (chat_store::title_from): the first message,
 *  trimmed, on one line, cut at 60 characters plus "…". */
function titleFrom(text) {
  const one = String(text).trim().replace(/\n/g, ' ');
  const chars = [...one];
  return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('')}…` : one;
}

/** When a stored conversation last got a message (the newest one's created_at), or null. */
function lastAt(d) {
  const msgs = d && Array.isArray(d.messages) ? d.messages : [];
  return (msgs.length && msgs[msgs.length - 1].created_at) || null;
}

/** A ?prompt= in the address, or ''. */
function promptOf(query) {
  const p = query && typeof query.prompt === 'string' ? query.prompt : '';
  return p.trim() ? p : '';
}

// A ?prompt= is only taken from inside the running app. One Enter would send text the user may
// not have read (and may not see: it can sit below the composer's fold), so two others are
// dropped. One in the address the page loaded with came from a link on another site or a
// bookmark: the navigation entry keeps that hash (changing only the hash later doesn't). One set
// by another window holding this one (a site that opened coldtrail can later change just the
// hash, which loads nothing) comes with no click or key press here. The in-app hand-offs
// (Pipeline, Home, Setup) follow one in this window, as every link or button does. A dropped one
// isn't lost without a word, though: those hand-offs are links, and one opened in a new tab
// arrives in the address it loads with. A notice above the composer shows it, and its button is
// the click that puts it there (offer()).
const loadHash = (() => {
  try {
    const entry = performance.getEntriesByType('navigation')[0];
    return entry ? new URL(entry.name).hash : location.hash;
  } catch (_) {
    return location.hash;
  }
})();
let firstRoute = true;

/**
 * The ?prompt= hand-off: { prompt } to put in the composer, or { dropped } when it came from
 * outside the app (each '' when there is none).
 */
function handOff(query) {
  const fromLoad = firstRoute && location.hash === loadHash;
  firstRoute = false;
  const ua = navigator.userActivation; // where a browser lacks it, the load check stands alone
  const p = promptOf(query);
  return fromLoad || (ua && !ua.isActive) ? { prompt: '', dropped: p } : { prompt: p, dropped: '' };
}

/** What a dropped hand-off's notice quotes: its first line with text, cut short, and "…" when
 *  there is more (a run of blank lines can hide the rest below the composer's fold). */
function excerpt(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const first = lines[0].trim();
  const chars = [...first];
  if (chars.length > OFFER_CHARS) return `${chars.slice(0, OFFER_CHARS).join('').trimEnd()}…`;
  return lines.length > 1 ? `${first} …` : first;
}

/** What the composer footer says the turn runs on: [agent, model]. */
function agentLabel(status) {
  if (!status) return null;
  if (status.provider === 'openai') return ['Your own model', status.model || 'no model set'];
  const a = (status.agents || []).find((x) => x.kind === status.provider);
  const name = a ? a.label : status.provider || 'No agent';
  if (status.provider === 'opencode') return [name, status.opencode_model || 'default model'];
  return [name, 'default model'];
}

/** Why a turn would fail before it starts, or null when the agent looks ready. */
function agentProblem(status) {
  if (!status) return null;
  if (status.provider === 'openai') return status.base_url ? null : "Your own model isn't set up yet.";
  const a = (status.agents || []).find((x) => x.kind === status.provider);
  if (!a) return 'No agent is selected.';
  if (!a.present) return `${a.label} isn't installed on this machine.`;
  if (!a.authed) return `${a.label} isn't signed in.`;
  return null;
}

// The mounted screen's route handler, so update() can keep the DOM when only the chat changes.
let instance = null;
// Text typed but not sent when the screen went away: the composer gets it back next time (the
// old UI kept its composer across views). A ?prompt= hand-off replaces it.
let unsent = '';

export default {
  title,
  css: true,
  // mount() places focus itself: the composer for a ?prompt= hand-off, else the heading.
  autofocus: false,
  /** Same screen, another conversation or a ?prompt=: keep the DOM (list, scroll, composer). */
  update(ctx) {
    return instance ? instance.update(ctx) : false;
  },
  mount(root, ctx) {
    const { store, nav } = ctx;
    const ctl = new AbortController();
    const signal = ctl.signal;
    const timers = new Set();
    const streams = new Set(); // every EventSource this screen opened, ended on unmount

    let gone = false;
    let currentId = null; // the conversation on screen; null = a new one
    let current = null; // { id, title, run, running, missing }
    let pendingTitle = null; // a new conversation's title while its first message is on its way
    let mode = 'compose'; // compose | readonly | blocked | none
    let openSeq = 0; // bumps whenever the conversation on screen changes
    let chats = [];
    let listState = 'loading'; // loading | ready | error
    let listError = '';
    let listSeq = 0;
    let filter = '';
    const shown = { mine: LIST_PAGE, runs: LIST_PAGE };
    let turn = null; // the live turn, if any
    let adopting = null; // settles once a new conversation's id is known
    let activating = null; // settles once the last POST …/activate this screen sent has answered
    let waiting = false; // a send() is waiting for one of those two
    let poll = null;
    let runInfo = null; // the /api/runs row of the open run conversation
    let warnFor = null; // the problem the warning above the composer shows, if any
    let listRefocus = false; // the list's Try again had focus: give it to what replaces it

    // ---- Skeleton ----

    const newBtn = h(
      'button',
      { type: 'button', class: 'btn btn-primary', onClick: (e) => startNewChat(e.currentTarget) },
      icon('plus'),
      'New chat',
    );
    const listToggle = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-secondary agent-list-toggle',
        'aria-expanded': 'false',
        'aria-controls': 'agent-list',
        onClick: () => setListOpen(!wrap.classList.contains('is-list-open')),
      },
      icon('list'),
      'Conversations',
    );

    const search = h('input', {
      type: 'search',
      class: 'input agent-search-input',
      placeholder: 'Search conversations',
      'aria-label': 'Search conversations',
      autocomplete: 'off',
      spellcheck: 'false',
      onInput: () => {
        filter = search.value.trim().toLowerCase();
        renderList();
        cancel(sayFoundTimer);
        sayFoundTimer = later(sayFound, SAY_FOUND_MS);
      },
    });
    const navEl = h('nav', { class: 'agent-nav', 'aria-label': 'Conversations' });
    // The search's outcome, for screen readers. The list's own: on a phone the conversation pane
    // (and its announcer) is hidden while the list is open.
    const listStatus = h('div', { class: 'sr-only', role: 'status' });
    let sayFoundTimer = null;
    const listPane = h(
      'div',
      { class: 'agent-list', id: 'agent-list' },
      h('div', { class: 'agent-search' }, icon('search', 15), search),
      navEl,
      listStatus,
    );

    const headTitle = h('h2', { class: 'agent-chat-title' });
    const headMeta = h('p', { class: 'agent-chat-meta' });
    const headBadges = h('div', { class: 'agent-chat-badges' });
    const head = h(
      'div',
      { class: 'agent-chat-head' },
      h('div', { class: 'agent-chat-titles' }, headTitle, headMeta),
      headBadges,
    );

    const logInner = h('div', { class: 'agent-log-inner' });
    const log = h(
      'div',
      { class: 'agent-log', role: 'region', 'aria-label': 'Conversation', tabindex: '0' },
      logInner,
    );

    const input = h('textarea', {
      id: 'agent-input',
      class: 'agent-input',
      rows: '1',
      placeholder: 'Ask for companies, founders or drafts…',
      'aria-describedby': 'agent-hint',
      onInput: () => grow(),
      onKeydown: (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
        e.preventDefault();
        send();
      },
    });
    const sendButton = h(
      'button',
      { type: 'submit', class: 'btn btn-primary agent-send' },
      icon('send'),
      'Send',
    );
    const stopButton = h(
      'button',
      { type: 'button', class: 'btn btn-secondary agent-stop', hidden: true, onClick: () => stop() },
      icon('stop'),
      'Stop',
    );
    const modelLink = h('a', { class: 'agent-model', href: '#/settings?tab=agent', title: 'Change the agent in Settings' });
    // On a narrow composer the key hint gives way to the model label (agent.css); the input
    // still describes it to screen readers.
    const hint = h(
      'span',
      { class: 'agent-hint agent-hint-keys', id: 'agent-hint' },
      h('kbd', { class: 'kbd' }, 'Enter'),
      ' to send, ',
      h('kbd', { class: 'kbd' }, 'Shift+Enter'),
      ' for a new line',
    );
    const busyHint = h(
      'span',
      { class: 'agent-hint agent-hint-busy', id: 'agent-hint-busy', hidden: true },
      'Leaving this conversation stops the agent.',
    );
    const inputBar = h('div', { class: 'agent-input-bar' });
    const warn = h('div', { class: 'agent-warn', hidden: true });
    const form = h(
      'form',
      {
        class: 'agent-composer',
        onSubmit: (e) => {
          e.preventDefault();
          send();
        },
      },
      warn,
      h(
        'div',
        { class: 'agent-input-box' },
        h('label', { class: 'sr-only', for: 'agent-input' }, 'Message the agent'),
        input,
        inputBar,
      ),
    );
    inputBar.append(modelLink, hint, busyHint, sendButton, stopButton);
    // A ?prompt= hand-off this screen didn't take (handOff()), quoted above the footer with the
    // click that puts it in the composer. It stays, whatever conversation shows, until used or
    // dismissed.
    let offered = '';
    const offerText = h('p', { class: 'agent-offer-text' });
    const offerEl = h(
      'div',
      { class: 'agent-offer', role: 'group', 'aria-label': 'Message from a link' },
      icon('link'),
      offerText,
      h(
        'div',
        { class: 'agent-offer-actions' },
        h(
          'button',
          { type: 'button', class: 'btn btn-secondary btn-sm', onClick: (e) => takeOffer(e.currentTarget) },
          'Put it in the composer',
        ),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => dismissOffer() }, 'Dismiss'),
      ),
    );
    const foot = h('div', { class: 'agent-foot' }, form);
    const announcer = h('div', { class: 'sr-only', role: 'status' });

    const chatPane = h('section', { class: 'agent-chat', 'aria-label': 'Chat' }, head, log, foot, announcer);
    const layout = listDetail({ list: listPane, detail: chatPane });
    layout.classList.add('agent-body');

    const wrap = h(
      'div',
      { class: 'agent' },
      h(
        'header',
        { class: 'page-head' },
        h(
          'div',
          { class: 'page-head-text' },
          h('h1', {}, title),
          h('p', { class: 'page-desc' }, 'Ask the agent to source companies, find founders and write drafts.'),
        ),
        h('div', { class: 'page-actions' }, listToggle, newBtn),
      ),
      layout,
    );
    root.append(wrap);

    // Links on this screen (another conversation, Settings, Schedules) ask first while a turn
    // streams: following one stops the agent. Plain left clicks only; a new tab leaves it be.
    wrap.addEventListener('click', (e) => {
      if (!turn || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest('a[href^="#/"]') : null;
      const to = a && a.getAttribute('href');
      if (!to || to === location.hash) return;
      e.preventDefault();
      confirmLeave(a).then((ok) => {
        if (ok && !gone) nav.navigate(to);
      });
    });

    // ---- Small helpers ----

    /**
     * openStream, remembered so leaving the screen ends it whatever state the turn is in.
     * release() ends it once the server has claimed the run, at once if it already has: closing
     * a stream that hasn't connected yet can leave the run unclaimed, running on until the
     * server's reaper. Nothing is delivered after release().
     */
    function stream(url, { onEvent, onError } = {}) {
      let open = false;
      let released = false;
      const s = openStream(url, {
        onOpen: () => {
          open = true;
          if (released) s.close();
        },
        onEvent: (ev) => {
          if (released) s.close();
          else if (onEvent) onEvent(ev);
        },
        onError: () => {
          streams.delete(s);
          if (!released && onError) onError();
        },
      });
      const close = s.close;
      s.close = () => {
        streams.delete(s);
        close();
      };
      s.release = () => {
        released = true;
        if (open) s.close();
      };
      streams.add(s);
      return s;
    }

    function later(fn, ms) {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!gone) fn();
      }, ms);
      timers.add(id);
      return id;
    }

    function cancel(id) {
      if (id == null) return;
      clearTimeout(id);
      timers.delete(id);
    }

    /**
     * Resolves after `ms`, or as soon as another conversation is put on screen (wakeNaps());
     * never, if the screen goes away first.
     */
    const wakers = new Set();
    function nap(ms) {
      return new Promise((resolve) => {
        const done = () => {
          wakers.delete(done);
          cancel(id);
          resolve();
        };
        const id = later(done, ms);
        wakers.add(done);
      });
    }
    function wakeNaps() {
      for (const done of [...wakers]) done();
    }

    /** Where the router would put focus: the screen's heading. */
    function focusHeading() {
      const h1 = wrap.querySelector('h1');
      h1.setAttribute('tabindex', '-1');
      h1.focus({ preventScroll: true });
    }

    /**
     * After a control that had focus was replaced (a Try again that reloads, for one): focus `el`,
     * unless the user has put focus somewhere else meanwhile.
     */
    function regainFocus(el) {
      const now = document.activeElement;
      if (el && (!now || now === document.body || !now.isConnected)) el.focus({ preventScroll: true });
    }

    function announce(text) {
      announcer.textContent = text;
    }

    function grow() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_PX)}px`;
    }

    /**
     * Put `text` in the composer and focus it: the caret at the end (a starter, to add to it),
     * or for a hand-off at the start, scrolled to the top, so a long one is read from its start.
     * It goes in as an edit the browser can undo, so Cmd/Ctrl+Z brings back a draft it replaced
     * (a value set from code can't be undone); setting the value is only the fallback.
     */
    function fill(text, { atStart = false } = {}) {
      input.focus();
      let edited = false;
      // Only into the composer: one that can't take focus (hidden behind the list on a phone)
      // would send the edit to whatever has it.
      if (document.activeElement === input) {
        input.select();
        try {
          edited = document.execCommand('insertText', false, text);
        } catch (_) {
          edited = false;
        }
      }
      if (!edited || input.value !== text) input.value = text;
      grow();
      const at = atStart ? 0 : input.value.length;
      input.setSelectionRange(at, at);
      if (atStart) input.scrollTop = 0;
    }

    const phone = window.matchMedia('(max-width: 899px)');

    function setListOpen(open) {
      wrap.classList.toggle('is-list-open', open);
      listToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && phone.matches) search.focus();
    }

    // ---- Scrolling: follow new output while the reader is at the bottom ----

    const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    function toBottom() {
      log.scrollTop = log.scrollHeight;
    }
    function follow(fn) {
      const stick = nearBottom();
      fn();
      if (stick) toBottom();
    }

    // ---- Transcript pieces ----

    function userMsg(text) {
      return h('div', { class: 'agent-msg agent-msg-user' }, h('div', { class: 'agent-bubble' }, text));
    }

    function agentMsg(raw, live = false) {
      const el = h('div', { class: ['agent-msg', 'agent-msg-agent', live && 'is-live'] });
      el.innerHTML = renderMarkdown(raw); // the only HTML path: escaped first, safe subset only
      return el;
    }

    /** A problem in the transcript; `live` (one that just happened) is announced. */
    function errorRow(message, { live = true, cls = null } = {}) {
      return h(
        'div',
        { class: ['agent-error', ...[].concat(cls)], role: live ? 'alert' : null },
        icon('alert'),
        h('p', { class: 'agent-error-text' }, message),
      );
    }

    function noteRow(text) {
      return h('p', { class: 'agent-note' }, text);
    }

    function workingRow(text = 'Working…') {
      return h(
        'div',
        { class: 'agent-working' },
        h('span', { class: 'agent-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('span', {}, text),
      );
    }

    function briefRow(text) {
      const dry = /^DRY RUN\b/.test(text);
      return h(
        'details',
        { class: 'agent-brief' },
        h('summary', {}, icon('caret', 14), h('span', {}, 'Run brief')),
        h('div', { class: 'agent-brief-body' }, dry ? badge('Dry run: drafts only', 'accent') : null, h('p', {}, text)),
      );
    }

    /**
     * A "Worked · N steps" group, closed by default. add(name, state) appends a step: 'pending'
     * (live, not finished), 'ok' / 'fail' (a live result), or 'done' (from history, where the
     * outcome isn't stored). end(ok) settles the oldest pending step, so parallel calls pair
     * with their results in order. setRunning(on) switches the "Working…" label. close() ends a
     * live group: a step still pending then never gets its result (Stop, a lost connection, the
     * agent moving on) and becomes 'none'.
     */
    function toolGroup({ running = false } = {}) {
      const steps = [];
      const label = h('span', { class: 'agent-tools-label' });
      const list = h('ol', { class: 'agent-steps', hidden: true });
      const toggle = h(
        'button',
        {
          type: 'button',
          class: 'agent-tools-head',
          'aria-expanded': 'false',
          onClick: () => {
            const show = toggle.getAttribute('aria-expanded') !== 'true';
            toggle.setAttribute('aria-expanded', show ? 'true' : 'false');
            list.hidden = !show;
          },
        },
        h('span', { class: 'agent-tools-caret', 'aria-hidden': 'true' }, icon('caret', 14)),
        h('span', { class: 'agent-tools-dot', 'aria-hidden': 'true' }),
        label,
      );
      const el = h('div', { class: 'agent-tools' }, toggle, list);
      let isRunning = running;

      function setState(step, state) {
        step.state = state;
        step.row.dataset.state = state;
        step.glyph.replaceChildren(STEP_GLYPHS[state] ? icon(STEP_GLYPHS[state], 14) : '');
        step.word.textContent = STEP_WORDS[state] || '';
      }

      function sync() {
        const failed = steps.filter((s) => s.state === 'fail').length;
        const n = steps.length;
        const count = `${fmtNum(n)} ${n === 1 ? 'step' : 'steps'}`;
        label.textContent = isRunning
          ? `Working… · ${count}`
          : `Worked · ${count}${failed ? ` · ${fmtNum(failed)} failed` : ''}`;
        el.classList.toggle('is-running', isRunning);
      }

      const g = {
        el,
        add(name, state = 'pending') {
          const step = {
            row: null,
            glyph: h('span', { class: 'agent-step-icon', 'aria-hidden': 'true' }),
            word: h('span', { class: 'sr-only' }),
            state: null,
          };
          step.row = h('li', { class: 'agent-step' }, step.glyph, h('span', { class: 'agent-step-name' }, name || 'tool'), step.word);
          steps.push(step);
          list.append(step.row);
          setState(step, state);
          sync();
        },
        end(ok) {
          const step = steps.find((s) => s.state === 'pending');
          if (step) setState(step, ok ? 'ok' : 'fail');
          sync();
        },
        /** History: the last stored step of a run that is still going hasn't finished. */
        pendLast() {
          if (steps.length) setState(steps[steps.length - 1], 'pending');
        },
        setRunning(on) {
          isRunning = !!on;
          sync();
        },
        close() {
          for (const s of steps) if (s.state === 'pending') setState(s, 'none');
          g.setRunning(false);
        },
      };
      sync();
      return g;
    }

    // ---- Header ----

    function renderHead() {
      headBadges.replaceChildren();
      headMeta.replaceChildren();
      headTitle.removeAttribute('title');
      if (!currentId && pendingTitle) {
        // The first message is on its way: the server saves the conversation under this title
        // as the turn starts. The real details come once it has (settle()).
        headTitle.textContent = pendingTitle;
        headTitle.title = pendingTitle;
        return;
      }
      if (!currentId) {
        headTitle.textContent = 'New conversation';
        headMeta.textContent = 'Saved once you send the first message.';
        return;
      }
      if (!current) {
        headTitle.replaceChildren(h('span', { class: 'skeleton agent-skel-title' }));
        return;
      }
      if (current.missing) {
        headTitle.textContent = 'Conversation not found';
        return;
      }
      if (current.failed) {
        headTitle.textContent = 'Conversation'; // it didn't load: the transcript says why
        return;
      }
      headTitle.textContent = current.title || 'Untitled conversation';
      if (current.title) headTitle.title = current.title;
      const listed = chats.find((c) => c.id === currentId);
      if (current.run) {
        if (current.running) {
          // The run history only gets this run's row when it ends. When the run last wrote
          // shows whether it is still going (a run that died can leave `running` set).
          headMeta.textContent = runningMeta();
          const live = badge('Running', 'accent');
          // Pulsing only while updates arrive (runningMeta() says why they don't).
          if (!current.stalled) live.prepend(h('span', { class: 'agent-live-dot', 'aria-hidden': 'true' }));
          headBadges.append(live);
        } else if (runInfo) {
          // /api/runs `started_at` is written when the run ends: it is the finish time. Each
          // part stays on one line when a narrow header wraps them.
          const parts = [
            `Finished ${fmtRelative(runInfo.started_at)}`,
            `${fmtNum(runInfo.sourced)} sourced`,
            `${fmtNum(runInfo.enriched)} enriched`,
            `${fmtNum(runInfo.drafted)} drafted`,
            `${fmtNum(runInfo.sent)} sent`,
          ];
          // Each "·" stays with the part before it: a wrapped line never starts with one.
          const last = parts.length - 1;
          parts.forEach((p, i) => headMeta.append(i ? ' ' : '', h('span', { class: 'agent-meta-part' }, i < last ? `${p} ·` : p)));
          const [text, tone] = runStatus(runInfo.status);
          headBadges.append(badge(text, tone));
          if (runInfo.trigger === 'dry') headBadges.append(badge('Dry run', 'neutral'));
        } else if (listed && listed.updated_at) {
          headMeta.textContent = `Updated ${fmtRelative(listed.updated_at)}`;
        }
        headBadges.append(badge('Read-only', 'neutral'));
      } else if (listed && listed.updated_at) {
        headMeta.textContent = `Updated ${fmtRelative(listed.updated_at)}`;
      }
    }

    /** A running run's meta line: live, and when it last wrote to its log; or why it isn't live. */
    function runningMeta() {
      if (current && current.stalled) return current.stalled;
      const listed = chats.find((c) => c.id === currentId);
      const at = (current && current.lastAt) || (listed && listed.updated_at) || null;
      return at ? `Updates as the run works · last update ${fmtRelative(at)}` : 'Updates as the run works';
    }

    // ---- Composer modes and status ----

    function renderAgentInfo() {
      const { status } = store.get();
      const label = agentLabel(status);
      modelLink.replaceChildren();
      if (label) {
        modelLink.append(label[0], ' · ', h('span', { class: 'mono' }, label[1]));
        modelLink.hidden = false;
      } else {
        modelLink.hidden = true;
      }
      const problem = agentProblem(status);
      // Rebuilt only when it says something else: the store refreshes every 30s and after each
      // turn, and a rebuild would take keyboard focus off its link.
      if (problem === warnFor) return;
      warnFor = problem;
      warn.hidden = !problem;
      warn.replaceChildren();
      if (problem) {
        warn.append(
          icon('alert'),
          h('span', {}, `${problem} Turns will fail until it's ready.`),
          h('a', { href: '#/settings?tab=agent' }, 'Set up the agent'),
        );
      }
    }

    function setMode(next, message) {
      mode = next;
      foot.replaceChildren();
      if (offered) foot.append(offerEl); // a dropped hand-off's notice stays above whatever comes
      if (next === 'compose') {
        foot.append(form);
        grow(); // its height was measured while it was out of the page, if it was
      } else if (next === 'readonly') {
        foot.append(
          h(
            'div',
            { class: 'agent-readonly' },
            icon('lock'),
            h('p', {}, 'Scheduled runs are a read-only log. To ask about this run, start a new chat.'),
            h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: () => startNewChat() }, 'Start a new chat'),
          ),
        );
      } else if (next === 'blocked') {
        foot.append(
          h(
            'div',
            { class: 'agent-readonly' },
            icon('lock'),
            h('p', {}, `This conversation can't be continued: ${message}`),
            h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: () => startNewChat() }, 'Start a new chat'),
          ),
        );
      }
    }

    /** While a turn runs: Stop in place of Send, and the hint about leaving. */
    function setLive(busy) {
      // Keep keyboard users on a control: Stop replaces Send under their focus, and back.
      const focused = document.activeElement;
      sendButton.hidden = busy;
      stopButton.hidden = !busy;
      hint.hidden = busy;
      busyHint.hidden = !busy;
      // On a narrow composer the warning takes the model label's place while it shows.
      inputBar.classList.toggle('is-busy', busy);
      input.setAttribute('aria-describedby', busy ? 'agent-hint-busy' : 'agent-hint');
      log.setAttribute('aria-busy', busy ? 'true' : 'false');
      if (busy && focused === sendButton) stopButton.focus();
      if (!busy && focused === stopButton) input.focus();
    }

    /** Quote a dropped hand-off above the composer, in place of one quoted before. */
    function offer(text) {
      offered = text;
      offerText.replaceChildren(
        'A link opened this screen with a message for the agent: ',
        h('span', { class: 'agent-offer-quote' }, `“${excerpt(text)}”`),
      );
      if (!offerEl.isConnected) foot.prepend(offerEl);
    }

    function clearOffer() {
      offered = '';
      offerEl.remove();
    }

    function dismissOffer() {
      clearOffer();
      // Its buttons are gone: focus goes to the composer it was about, or the heading.
      if (mode === 'compose') input.focus();
      else focusHeading();
    }

    /**
     * The click a dropped hand-off was waiting for: it goes where one from inside the app goes, a
     * new conversation's composer, read from its start, not sent.
     */
    async function takeOffer(btn) {
      const text = offered;
      // Leaving the conversation on screen stops a turn streaming there: ask first.
      if (turn && currentId !== null && !(await confirmLeave(btn))) return;
      if (gone || offered !== text) return;
      clearOffer();
      if (currentId === null) {
        fill(text, { atStart: true });
        return;
      }
      nav.navigate('#/agent').then(() => {
        if (!gone) fill(text, { atStart: true });
      });
    }

    // ---- Conversation list ----

    function listSkeleton() {
      return h(
        'div',
        { class: 'agent-list-loading', 'aria-hidden': 'true' },
        [0, 1, 2, 3].map(() =>
          h('div', { class: 'agent-skel-item' }, h('span', { class: 'skeleton' }), h('span', { class: 'skeleton agent-skel-meta' })),
        ),
      );
    }

    function listSection(key, label, rows) {
      const labelId = `agent-sec-${key}`;
      const limit = shown[key];
      const items = rows.slice(0, limit).map((c) =>
        h(
          'li',
          {},
          h(
            'a',
            {
              class: 'agent-item',
              href: href(['agent', c.id]),
              'data-id': c.id,
              'aria-current': c.id === currentId ? 'page' : null,
              title: c.title || null,
              onClick: () => {
                if (c.id === currentId) setListOpen(false);
              },
            },
            h('span', { class: 'agent-item-title' }, listTitle(c.title)),
            h('span', { class: 'agent-item-meta' }, fmtRelative(c.updated_at)),
          ),
        ),
      );
      const more =
        rows.length > limit
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost btn-sm agent-more',
                onClick: () => {
                  shown[key] += LIST_PAGE;
                  renderList();
                  // The button is gone: keyboard focus goes to the first conversation it revealed.
                  const items = navEl.querySelectorAll(`[aria-labelledby="${labelId}"] .agent-item`);
                  if (items[limit]) items[limit].focus();
                },
              },
              `Show ${fmtNum(Math.min(LIST_PAGE, rows.length - limit))} more`,
            )
          : null;
      return h(
        'section',
        { class: 'agent-section' },
        h('h2', { class: 'agent-section-title eyebrow', id: labelId }, label),
        h('ul', { class: 'agent-items', 'aria-labelledby': labelId }, items),
        more,
      );
    }

    function renderList() {
      // Keep focus on the same conversation when the list redraws under it.
      const focused = navEl.contains(document.activeElement) ? document.activeElement.getAttribute('data-id') : null;
      navEl.removeAttribute('aria-busy');
      if (listState === 'loading') {
        navEl.setAttribute('aria-busy', 'true');
        navEl.replaceChildren(listSkeleton());
        return;
      }
      drawList(focused);
      if (listRefocus) {
        // Try again had focus, and the placeholders took its place: the first conversation (or
        // the next Try again, or the search box) gets it once the list is back.
        listRefocus = false;
        regainFocus(navEl.querySelector('.agent-item, .btn') || search);
      }
    }

    /** The loaded list, or why there is none; `focused`: the data-id of the item that had focus. */
    function drawList(focused) {
      if (listState === 'error') {
        navEl.replaceChildren(
          h(
            'div',
            { class: 'agent-list-msg' },
            h('p', { class: 'agent-list-msg-title' }, "Couldn't load conversations"),
            h('p', { class: 'agent-list-msg-body' }, listError),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-secondary btn-sm',
                onClick: (e) => {
                  listRefocus = e.currentTarget === document.activeElement;
                  listState = 'loading';
                  renderList();
                  loadList();
                },
              },
              'Try again',
            ),
          ),
        );
        return;
      }
      if (!chats.length) {
        navEl.replaceChildren(
          h(
            'div',
            { class: 'agent-list-msg' },
            h('p', { class: 'agent-list-msg-title' }, 'No conversations yet'),
            h('p', { class: 'agent-list-msg-body' }, 'Your chats and the logs of scheduled runs appear here.'),
          ),
        );
        return;
      }
      const mine = chats.filter((c) => !isRun(c.title) && matches(c));
      const runs = chats.filter((c) => isRun(c.title) && matches(c));
      if (filter && !mine.length && !runs.length) {
        navEl.replaceChildren(
          h('div', { class: 'agent-list-msg' }, h('p', { class: 'agent-list-msg-body' }, `No conversations match “${search.value.trim()}”`)),
        );
        return;
      }
      const parts = [];
      if (mine.length || !filter) parts.push(mine.length ? listSection('mine', 'Your chats', mine) : emptySection('Your chats', 'Start one with New chat.'));
      if (runs.length || !filter) {
        parts.push(
          runs.length
            ? listSection('runs', 'Scheduled runs', runs)
            : emptySection('Scheduled runs', h('span', {}, 'Runs from your ', h('a', { href: '#/schedules' }, 'schedules'), ' appear here.')),
        );
      }
      navEl.replaceChildren(...parts);
      if (focused) {
        const again = [...navEl.querySelectorAll('.agent-item')].find((a) => a.getAttribute('data-id') === focused);
        if (again) again.focus({ preventScroll: true });
      }
    }

    /** Whether conversation `c` is one the search keeps. */
    function matches(c) {
      return !filter || (c.title || '').toLowerCase().includes(filter);
    }

    /** Once typing pauses: what the search left in the list (which only redraws), said aloud. */
    function sayFound() {
      sayFoundTimer = null;
      if (listState !== 'ready') return;
      const n = chats.filter(matches).length;
      if (!chats.length) listStatus.textContent = 'No conversations yet';
      else if (!n) listStatus.textContent = `No conversations match “${search.value.trim()}”`;
      else listStatus.textContent = `${fmtNum(n)} ${n === 1 ? 'conversation' : 'conversations'}`;
    }

    function emptySection(label, body) {
      return h(
        'section',
        { class: 'agent-section' },
        h('h2', { class: 'agent-section-title eyebrow' }, label),
        h('p', { class: 'agent-section-empty' }, body),
      );
    }

    /** Bring the relative times ("just now", "2h ago") in the list and the header up to date. */
    function refreshTimes() {
      for (const a of navEl.querySelectorAll('.agent-item')) {
        const c = chats.find((x) => x.id === a.getAttribute('data-id'));
        const meta = a.querySelector('.agent-item-meta');
        if (c && meta) meta.textContent = fmtRelative(c.updated_at);
      }
      renderHead();
    }

    function markCurrent() {
      for (const a of navEl.querySelectorAll('.agent-item')) {
        if (a.getAttribute('data-id') === currentId) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
    }

    /** Fetch /api/chats; a failed refresh keeps the list already on screen. Resolves to it. */
    async function loadList() {
      const seq = ++listSeq;
      try {
        const rows = await api.get('/api/chats', { signal });
        if (gone || seq !== listSeq) return chats;
        chats = Array.isArray(rows) ? rows : [];
        listState = 'ready';
        renderList();
        if (current && !current.missing) renderHead();
      } catch (err) {
        if (gone || isAbort(err) || seq !== listSeq) return chats;
        if (listState !== 'ready') {
          listState = 'error';
          listError = errorText(err);
          renderList();
        }
      }
      return chats;
    }

    // ---- Transcript: a new conversation, a stored one, and states ----

    function welcomeBody() {
      const { status } = store.get();
      const sends = status && (status.auto_send || status.linkedin_auto_send);
      return h(
        'p',
        { class: 'agent-welcome-body' },
        'It works from your company profile: it sources companies, finds the founders and writes drafts. ',
        sends
          ? 'Auto-send is on, so it can also send drafts within your daily caps.'
          : 'Nothing is sent without you: drafts wait in Drafts for review.',
      );
    }

    function welcome() {
      return h(
        'div',
        { class: 'agent-welcome' },
        // Under the conversation's own h2 ("New conversation").
        h('h3', { class: 'agent-welcome-title' }, 'What should the agent work on?'),
        welcomeBody(),
        h(
          'ul',
          { class: 'agent-starters', 'aria-label': 'Starter prompts' },
          STARTERS.map((s) =>
            h(
              'li',
              {},
              h(
                'button',
                { type: 'button', class: 'agent-starter', onClick: () => fill(s.text) },
                h('span', { class: 'agent-starter-title' }, s.title),
                h(
                  'span',
                  {
                    class: 'agent-starter-text',
                    // Cut to two lines beside the list (agent.css): hovering a cut one shows it
                    // whole. The title sits on the text, not the button, so a screen reader
                    // (which reads the whole text already) doesn't hear it twice.
                    onPointerenter: (e) => {
                      const el = e.currentTarget;
                      if (el.scrollHeight > el.clientHeight + 1) el.title = s.text;
                      else el.removeAttribute('title');
                    },
                  },
                  s.text,
                ),
              ),
            ),
          ),
        ),
      );
    }

    function showWelcome() {
      logInner.replaceChildren(welcome());
      logInner.classList.add('is-empty');
    }

    function clearWelcome() {
      if (!logInner.classList.contains('is-empty')) return;
      logInner.classList.remove('is-empty');
      logInner.replaceChildren();
    }

    function logSkeleton() {
      logInner.classList.remove('is-empty');
      logInner.replaceChildren(
        h(
          'div',
          { class: 'agent-log-loading', 'aria-hidden': 'true' },
          h('span', { class: 'skeleton agent-skel-bubble' }),
          h('span', { class: 'skeleton' }),
          h('span', { class: 'skeleton' }),
          h('span', { class: 'skeleton agent-skel-short' }),
        ),
      );
    }

    function logState(node) {
      logInner.classList.add('is-empty');
      logInner.replaceChildren(node);
    }

    // The transcript's disclosures: "Worked · N steps" buttons and the run brief's summary.
    const disclosures = () => [...logInner.querySelectorAll('.agent-tools-head, details.agent-brief > summary')];
    const isOpen = (el) => (el.tagName === 'SUMMARY' ? el.parentElement.open : el.getAttribute('aria-expanded') === 'true');
    function openDisclosure(el) {
      if (el.tagName === 'SUMMARY') {
        el.parentElement.open = true;
        return;
      }
      el.setAttribute('aria-expanded', 'true');
      const steps = el.parentElement.querySelector('.agent-steps');
      if (steps) steps.hidden = false;
    }

    /**
     * Render stored messages: tool rows fold into groups, a run's brief folds away. `keep` (a
     * poll redraw of a run that is still writing): what the reader opened stays open, and the
     * control they were on keeps focus. A run only ever adds to its log, so positions hold.
     */
    function renderStored(d, { keep = false } = {}) {
      const run = isRun(d.title);
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      if (!msgs.length && !d.running) {
        logState(
          emptyState({
            title: run ? 'This run recorded nothing' : 'No messages yet',
            // showRunNote() drops the second sentence once it has the run's own reason.
            body: run
              ? `${EMPTY_RUN} The run history in Schedules shows how it finished.`
              : 'Send a message to start this conversation.',
            action: run ? { label: 'Open Schedules', href: '#/schedules' } : null,
            level: 3,
          }),
        );
        return;
      }
      const opened = keep ? disclosures().map(isOpen) : [];
      const focusAt = keep ? [...logInner.querySelectorAll(FOCUSABLE)].indexOf(document.activeElement) : -1;

      const els = [];
      let group = null;
      let briefShown = false;
      for (const m of msgs) {
        if (m.role === 'tool') {
          if (!group) {
            group = toolGroup();
            els.push(group.el);
          }
          group.add(m.content, 'done');
          continue;
        }
        group = null;
        if (m.role === 'user' && run && !briefShown) {
          briefShown = true;
          els.push(briefRow(m.content));
        } else if (m.role === 'user') {
          els.push(userMsg(m.content));
        } else {
          els.push(agentMsg(m.content));
        }
      }
      if (d.running) {
        if (group) {
          // Still on the last step (tool rows are stored when they start).
          group.pendLast();
          group.setRunning(true);
        } else {
          els.push(workingRow(msgs.length ? 'Working…' : 'Starting the run…'));
        }
      }
      logInner.classList.remove('is-empty');
      logInner.replaceChildren(...els);
      if (keep) {
        disclosures().forEach((el, i) => {
          if (opened[i]) openDisclosure(el);
        });
        const again = focusAt >= 0 ? logInner.querySelectorAll(FOCUSABLE)[focusAt] : null;
        if (again) again.focus({ preventScroll: true });
      }
    }

    // ---- Opening conversations ----

    function stopPoll() {
      if (poll != null) clearInterval(poll);
      poll = null;
    }

    /** End the live turn's stream without ceremony (switching conversations, leaving). */
    function dropTurn() {
      const t = turn;
      if (!t) return;
      turn = null;
      t.abandoned = true;
      if (t.stream) t.stream.release();
      cancel(t.settleTimer);
      if (t.resolveAdopt) t.resolveAdopt();
      setLive(false);
      // The server keeps what the turn wrote so far: list it.
      loadList();
    }

    /** While a turn streams, ask before leaving it (that stops the agent). Resolves to go on. */
    function confirmLeave(opener) {
      if (!turn) return Promise.resolve(true);
      return confirmDialog({
        title: 'Stop the agent?',
        body: 'The agent is still working on this conversation. Leaving stops it; what it wrote so far is saved.',
        confirmText: 'Stop and leave',
        cancelText: 'Stay',
        opener,
        signal, // closes (as Stay) if the screen goes away meanwhile
      });
    }

    async function startNewChat(opener) {
      if (turn && !(await confirmLeave(opener))) return;
      if (gone) return;
      const fresh = currentId === null && parseRoute().id === null;
      if (fresh) {
        newConversation();
        input.focus();
        return;
      }
      nav.navigate('#/agent').then(() => {
        if (!gone) input.focus();
      });
    }

    function newConversation({ keepList = false } = {}) {
      openSeq++;
      wakeNaps();
      dropTurn();
      stopPoll();
      currentId = null;
      current = null;
      pendingTitle = null;
      runInfo = null;
      setMode('compose');
      renderHead();
      showWelcome();
      markCurrent();
      if (!keepList) setListOpen(false);
    }

    /**
     * Put conversation `id` on screen. `retry`: its Try again had focus, and the placeholders took
     * its place: once it has loaded, the transcript gets focus (or the action of what it shows).
     */
    async function openChat(id, { retry = false } = {}) {
      const seq = ++openSeq;
      wakeNaps();
      dropTurn();
      stopPoll();
      currentId = id;
      current = null;
      pendingTitle = null;
      runInfo = null;
      setMode('none');
      renderHead();
      logSkeleton();
      markCurrent();
      const pickedFromList = wrap.classList.contains('is-list-open');
      setListOpen(false);
      if (pickedFromList) log.focus({ preventScroll: true });
      loadList();
      let d;
      try {
        d = await api.get(`/api/chats/${enc(id)}`, { signal });
      } catch (err) {
        if (gone || isAbort(err) || seq !== openSeq) return;
        current = { id, title: null, missing: false, failed: true, run: false, running: false };
        renderHead();
        logState(
          h(
            'div',
            { class: 'agent-load-error' },
            emptyState({
              title: "Couldn't open this conversation",
              body: errorText(err),
              action: {
                label: 'Try again',
                onClick: (e) => openChat(id, { retry: e.currentTarget === document.activeElement }),
              },
              level: 3,
            }),
          ),
        );
        if (retry) regainFocus(logInner.querySelector('.empty-action .btn'));
        return;
      }
      if (gone || seq !== openSeq) return;
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      if (!d.title && !msgs.length && !d.running) {
        current = { id, title: null, missing: true, run: false, running: false };
        renderHead();
        logState(
          emptyState({
            title: 'This conversation doesn’t exist',
            body: 'It may have been a link from another workspace. Start a new chat instead.',
            // A button, not a link: startNewChat() puts focus in the composer it opens.
            action: { label: 'Start a new chat', onClick: (e) => startNewChat(e.currentTarget) },
            level: 3,
          }),
        );
        if (retry) regainFocus(logInner.querySelector('.empty-action .btn'));
        return;
      }
      const run = isRun(d.title);
      current = { id, title: d.title, run, running: !!d.running, missing: false, lastAt: lastAt(d) };
      renderHead();
      renderStored(d);
      // The footer (a run's note, or the composer) goes in before the transcript scrolls to its
      // end: it takes its height from the transcript, which would otherwise open short of the end.
      setMode(run ? 'readonly' : 'compose');
      toBottom();
      if (retry) regainFocus(log);
      if (d.running) startPoll(id, seq, d);
      if (run) {
        loadRunInfo(id, seq);
        return;
      }
      // As before: the conversation on screen becomes the server's active one. The composer
      // shows now; a message sent before this answers waits for it (send()), so it can't start
      // a turn that a failed activation would then take the composer away from.
      const p = api.post(`/api/chats/${enc(id)}/activate`, {}, { signal }).then(
        () => null,
        (err) => err,
      );
      activating = p;
      const err = await p;
      if (activating === p) activating = null;
      if (!err || gone || isAbort(err) || seq !== openSeq) return;
      follow(() => setMode('blocked', errorText(err)));
    }

    async function loadRunInfo(id, seq) {
      try {
        const runs = await api.get('/api/runs', { signal });
        if (gone || seq !== openSeq) return;
        runInfo = (Array.isArray(runs) ? runs : []).find((r) => r.chat_id === id) || null;
        renderHead();
        showRunNote();
      } catch (_) {
        // Optional detail: the transcript stands without it.
      }
    }

    /**
     * Why a finished run didn't succeed (the run history's note), at the end of its log. In a
     * run that recorded nothing it goes under the explanation, in place of the pointer to the
     * run history, which would only say the same thing.
     */
    function showRunNote() {
      for (const old of logInner.querySelectorAll('.agent-run-note')) old.remove();
      if (!current || !current.run || current.running || !runInfo || !runInfo.note) return;
      if (runInfo.status === 'ok') return;
      const [label, tone] = runStatus(runInfo.status);
      const cls = ['agent-run-note', tone === 'warn' && 'is-warn'];
      const row = errorRow(`${label}: ${runInfo.note}`, { live: false, cls });
      const empty = logInner.querySelector('.empty-state');
      if (empty) {
        const body = empty.querySelector('.empty-body');
        if (body) body.textContent = EMPTY_RUN;
        empty.insertBefore(row, empty.querySelector('.empty-action'));
        return;
      }
      follow(() => logInner.append(row));
    }

    const signature = (d) => JSON.stringify([d.running, d.messages]);

    function startPoll(id, seq, first) {
      stopPoll();
      let last = signature(first);
      let busy = false;
      let failures = 0;
      let skip = 0; // ticks to wait before the next try after a failed one
      poll = setInterval(async () => {
        if (gone || seq !== openSeq) {
          stopPoll();
          return;
        }
        if (busy || document.hidden) return;
        if (skip > 0) {
          skip--;
          return;
        }
        busy = true;
        try {
          const d = await api.get(`/api/chats/${enc(id)}`, { signal });
          if (gone || seq !== openSeq) return;
          failures = 0;
          const stalled = !!current.stalled;
          current.stalled = null;
          const sig = signature(d);
          current.lastAt = lastAt(d);
          if (sig !== last) {
            last = sig;
            current.running = !!d.running;
            follow(() => renderStored(d, { keep: true }));
            renderHead();
          } else if (stalled) {
            renderHead(); // live again: the meta line and the pulsing badge come back
          } else if (current.running) {
            headMeta.textContent = runningMeta(); // "last update 1m ago" moves on with the clock
          }
          if (!d.running) {
            stopPoll();
            loadList();
            loadRunInfo(id, seq);
            store.refresh();
          }
        } catch (err) {
          if (gone || isAbort(err) || seq !== openSeq) return;
          // The run goes on regardless, so the header stops saying it updates live. A stale
          // session won't come back by itself; anything else (coldtrail restarting, a busy
          // database) is tried again, less often each time: after 1, 2, 4, then every 8 ticks.
          if (isStaleSession(err)) {
            stopPoll();
            current.stalled = `Stopped updating. ${errorText(err)}`;
          } else {
            failures++;
            skip = Math.min(2 ** (failures - 1), POLL_BACKOFF_TICKS) - 1;
            current.stalled = "Couldn't get the latest update. Trying again…";
          }
          renderHead();
        } finally {
          busy = false;
        }
      }, POLL_MS);
    }

    // ---- A turn: send, stream, stop, settle ----

    async function send() {
      if (turn || waiting || mode !== 'compose') return;
      if (!input.value.trim()) {
        input.focus();
        return;
      }
      // A conversation that just started may still be getting its id, and the one just opened
      // may still be becoming the server's active one: the message waits for both, so it lands
      // in the conversation on screen. Send says it's busy meanwhile.
      if (adopting || activating) {
        const before = openSeq;
        waiting = true;
        setBusy(sendButton, true);
        try {
          await adopting;
          await activating;
        } finally {
          waiting = false;
          setBusy(sendButton, false);
        }
        // Another conversation was opened meanwhile: the text stays in the composer, unsent.
        if (openSeq !== before) return;
      }
      if (gone || turn || mode !== 'compose') return;
      const text = input.value.trim();
      if (!text) return;
      const seq = openSeq;
      const fresh = currentId === null;
      const t = {
        seq,
        fresh,
        text,
        title: titleFrom(text),
        // What the list held before this turn, if it had loaded: settle() may look for the new
        // conversation among the rest.
        known: listState === 'ready' ? new Set(chats.map((c) => c.id)) : null,
        bubble: null,
        stream: null,
        group: null,
        live: null,
        working: null,
        note: null,
        sawError: false,
        done: false,
        ok: false,
        stopped: false,
        dropped: false,
        abandoned: false,
        settled: false,
        settleTimer: null,
        sent: null, // settles true once the server has the message, false if it never will
        resolveSent: null,
        resolveAdopt: null,
      };
      t.sent = new Promise((resolve) => {
        t.resolveSent = resolve;
      });
      turn = t;
      if (fresh) {
        const p = new Promise((resolve) => {
          t.resolveAdopt = resolve;
        });
        adopting = p;
        p.then(() => {
          if (adopting === p) adopting = null;
        });
      }

      if (fresh) {
        // The server starts a conversation of its own for this message, so nothing still on
        // screen is part of it: a failed first turn (deleted, its message back in the composer),
        // a message Stop kept back, the welcome. The transcript shows what a reload would.
        logInner.classList.remove('is-empty');
        logInner.replaceChildren();
      } else {
        clearWelcome();
      }
      t.bubble = userMsg(text);
      t.working = workingRow();
      logInner.append(t.bubble, t.working);
      toBottom();
      input.value = '';
      grow();
      setLive(true);
      announce('The agent is working.');
      if (fresh) {
        pendingTitle = t.title;
        renderHead();
      }

      let run;
      try {
        // New conversation → clear the server's active pointer; else make this one active.
        if (fresh) await api.post('/api/chats/new', {}, { signal });
        else await api.post(`/api/chats/${enc(currentId)}/activate`, {}, { signal });
        if (gone || t.abandoned || t.stopped) {
          // Left, or stopped, before anything started: send nothing.
          t.resolveSent(false);
          if (t.stopped) takeBack(t, null);
          return;
        }
        // Not on the screen's signal: once the server has the message the turn runs, so this
        // view needs its id even after it leaves, to claim it and so cancel it (below).
        ({ run } = await api.post('/api/chat', { message: text }));
      } catch (err) {
        t.resolveSent(false);
        // Stopped first: whatever happened since (even leaving the screen), the text comes back.
        if (t.stopped) takeBack(t, null);
        else if (!gone && !isAbort(err) && !t.abandoned) takeBack(t, `Couldn't start the turn: ${errorText(err)}`);
        return;
      }
      t.resolveSent(true);
      const url = `/api/chat/stream?run=${enc(run)}`;
      if (gone || t.abandoned || t.stopped) {
        // Stopped, or left for another conversation or screen, while it was starting: claim the
        // stream and close it as soon as it connects, so the server cancels the turn at its
        // first step instead of running it unobserved until its reaper.
        stream(url).release();
        return;
      }
      t.stream = stream(url, { onEvent: (ev) => onEvent(t, ev), onError: () => onStreamEnd(t) });
    }

    /**
     * Nothing reached the agent (the turn couldn't start, or Stop came first): the message goes
     * back into the composer, unless something new is being typed there, in which case its
     * bubble stays, marked as not sent. `error` says why; without one, it was stopped.
     */
    function takeBack(t, error) {
      if (gone) {
        // Stopped, then the screen went away: the text waits for it with what was being typed,
        // unless something else was.
        if (!unsent.trim()) unsent = t.text;
        return;
      }
      if (turn === t) {
        turn = null;
        setLive(false);
      }
      if (t.seq !== openSeq) {
        // Stopped, then another conversation opened: that one's transcript isn't told about it,
        // but the composer (which every conversation shares) gets the text back if it is empty.
        if (!input.value.trim()) {
          input.value = t.text;
          grow();
          announce('Stopped before it was sent. Your message is back in the composer.');
        }
        settle(t);
        return;
      }
      hideWorking(t);
      if (t.note) t.note.remove();
      t.note = null;
      const restore = !input.value.trim();
      if (restore) {
        input.value = t.text;
        grow();
        t.bubble.remove();
      } else {
        t.bubble.classList.add('is-unsent');
        t.bubble.append(h('span', { class: 'agent-unsent' }, 'Not sent'));
      }
      const row = error
        ? errorRow(error)
        : noteRow(restore ? 'Stopped before it was sent. Your message is back in the composer.' : 'Stopped before it was sent.');
      if (!logInner.children.length) {
        showWelcome();
        logInner.prepend(row);
      } else {
        follow(() => logInner.append(row));
      }
      announce(error ? '' : 'Stopped before it was sent.');
      settle(t);
    }

    /**
     * A first turn that failed leaves nothing on the server. Its text goes back into the composer
     * to send again (and so also waits there if the screen goes away), unless something new is
     * being typed there, in which case its bubble says it wasn't saved. → whether it went back.
     */
    function keepFailed(t) {
      if (!input.value.trim()) {
        input.value = t.text;
        grow();
        logInner.append(noteRow(FAILED_BACK));
        return true;
      }
      t.bubble.classList.add('is-unsent');
      t.bubble.append(h('span', { class: 'agent-unsent' }, 'Not saved'));
      return false;
    }

    function hideWorking(t) {
      if (t.working) t.working.remove();
      t.working = null;
    }

    function closeGroup(t) {
      if (t.group) t.group.close();
      t.group = null;
    }

    function finishLive(t) {
      if (t.live) t.live.el.classList.remove('is-live');
      t.live = null;
    }

    function onEvent(t, ev) {
      if (gone || t !== turn || !ev || typeof ev !== 'object') return;
      follow(() => {
        switch (ev.type) {
          case 'text': {
            if (typeof ev.text !== 'string') return;
            hideWorking(t);
            closeGroup(t);
            if (!t.live) {
              t.live = { raw: '', el: agentMsg('', true) };
              logInner.append(t.live.el);
            }
            t.live.raw += ev.text;
            t.live.el.innerHTML = renderMarkdown(t.live.raw);
            break;
          }
          case 'tool_start': {
            finishLive(t);
            hideWorking(t);
            if (!t.group) {
              t.group = toolGroup({ running: true });
              logInner.append(t.group.el);
            }
            t.group.add(String(ev.name || 'tool'));
            break;
          }
          case 'tool_end':
            if (t.group) t.group.end(ev.ok !== false);
            break;
          case 'error':
            t.sawError = true;
            finishLive(t);
            closeGroup(t);
            hideWorking(t);
            logInner.append(errorRow(String(ev.message || 'The agent reported an error.')));
            break;
          case 'done': {
            t.done = true;
            t.ok = !!ev.ok;
            if (!t.ok && !t.sawError) logInner.append(errorRow('The agent stopped without finishing this turn.'));
            endTurn(t);
            // A failed first turn: the server discards its conversation, message and all.
            const back = !t.ok && t.fresh && keepFailed(t);
            announce(t.ok ? 'The agent finished.' : `The turn ended with an error.${back ? ` ${FAILED_BACK}` : ''}`);
            // The server closes the stream once it has saved the turn; settle then.
            t.settleTimer = later(() => settle(t), SETTLE_MS);
            break;
          }
          default:
            break;
        }
      });
    }

    function onStreamEnd(t) {
      if (gone) return;
      if (t.done || t.stopped) {
        settle(t);
        return;
      }
      if (t !== turn) return;
      // The stream went away before the turn finished.
      t.dropped = true;
      follow(() => logInner.append(errorRow('Lost the connection to the agent before it finished. What it wrote so far is saved.')));
      endTurn(t);
      announce('The connection to the agent was lost.');
      settle(t);
    }

    function endTurn(t) {
      finishLive(t);
      closeGroup(t);
      hideWorking(t);
      if (turn === t) turn = null;
      setLive(false);
    }

    function stop() {
      const t = turn;
      if (!t) return;
      t.stopped = true;
      if (t.stream) t.stream.release();
      follow(() => {
        endTurn(t);
        t.note = noteRow('Stopped');
        logInner.append(t.note);
      });
      announce('Stopped.');
      settle(t);
    }

    // Still the new conversation this turn started on screen.
    const onScreen = (t) => !gone && t.fresh && t.seq === openSeq && currentId === null;

    /**
     * After a turn: refresh counts and the list; a new conversation takes its id and address
     * once the server has saved it. That needs the server to have taken the message, so a turn
     * stopped while it was starting waits here to learn whether it did.
     */
    async function settle(t) {
      if (t.settled) return;
      t.settled = true;
      cancel(t.settleTimer);
      if (t.stream) t.stream.release();
      store.refresh();
      const sent = await t.sent;
      if (gone) return;
      // A failed first turn leaves nothing behind (the server deletes it).
      const saved = sent && (t.ok || t.stopped || t.dropped);
      let hit = null;
      if (saved && onScreen(t)) hit = await findChat(t);
      else await loadList();
      if (onScreen(t)) {
        if (hit) {
          adopt(hit);
          if (t.note && t.note.textContent === STOPPED_WAITING) t.note.textContent = 'Stopped';
        } else if (saved && t.stopped) {
          detach();
        } else if (pendingTitle !== null) {
          pendingTitle = null;
          renderHead();
        }
      }
      if (t.resolveAdopt) t.resolveAdopt();
    }

    /**
     * The conversation a new turn's message went to: the server's active one, with the title it
     * gives the first message. If another tab has made something else active since, one with
     * that title that wasn't listed before the turn (never a run's log). A turn cut off early
     * may not be saved until the server's one-turn lock frees: look again a few times, and for a
     * stopped one keep looking, less often as time goes on, while it is on screen (a message sent
     * meanwhile waits for it, so it lands there too). After a while the "Stopped" note says what
     * this waits for.
     */
    async function findChat(t) {
      const start = Date.now();
      const limit = t.stopped ? ADOPT_WAIT_MS : ADOPT_PATIENCE_MS;
      let gap = ADOPT_FIRST_GAP_MS;
      for (;;) {
        const rows = await loadList();
        if (!onScreen(t)) return null;
        const hit =
          rows.find((c) => c.active && c.title === t.title) ||
          (t.known && rows.find((c) => c.title === t.title && !isRun(c.title) && !t.known.has(c.id)));
        // A finished turn's conversation is there already, if it is anywhere.
        if (hit || t.ok) return hit || null;
        const waited = Date.now() - start;
        if (waited >= limit) return null;
        if (waited >= ADOPT_PATIENCE_MS && t.note && t.note.textContent !== STOPPED_WAITING) {
          t.note.textContent = STOPPED_WAITING;
          announce(STOPPED_WAITING);
        }
        await nap(gap);
        gap = Math.min(Math.round(gap * 1.5), ADOPT_MAX_GAP_MS);
      }
    }

    /**
     * A stopped first turn's conversation still isn't saved after all that: showing the next
     * message under it would be wrong (it would start another conversation), so the screen
     * starts a new one and says where the stopped message goes.
     */
    function detach() {
      newConversation({ keepList: true });
      logInner.prepend(noteRow(STOPPED_DETACHED));
      announce(STOPPED_DETACHED);
    }

    /** The new conversation on screen is now `c`: its title, its place in the list, its address. */
    function adopt(c) {
      currentId = c.id;
      current = { id: c.id, title: c.title, run: false, running: false, missing: false };
      pendingTitle = null;
      renderHead();
      markCurrent();
      // In place of #/agent, so Back doesn't return to an empty new conversation. Silent: the
      // screen already shows it.
      nav.navigate(href(['agent', c.id]), { replace: true, silent: true });
    }

    // ---- Routing ----

    function parseRoute() {
      const m = location.hash.match(/^#\/agent(?:\/([^?]*))?/);
      return { id: m && m[1] ? decodeURIComponent(m[1]) : null };
    }

    /**
     * The conversation a route shows: a ?prompt= hand-off always gets a new one (it fills the
     * composer and never sends). One that came with the page load is dropped (handOff()): the
     * route shows what it would without it, and `dropped` is offered above the composer. Either
     * way the prompt leaves the address bar, so a refresh won't refill it, and the address without
     * it takes the place of the one it came on, so Back skips that.
     */
    function target(c) {
      const { prompt, dropped } = handOff(c.query);
      const id = prompt ? null : c.path[1] || null;
      if (prompt || dropped) nav.navigate(href(id ? ['agent', id] : ['agent']), { replace: true, silent: true });
      return { id, prompt, dropped };
    }

    function route(c) {
      const { id, prompt, dropped } = target(c);
      if (id !== currentId) {
        if (id) openChat(id);
        else newConversation();
      }
      if (prompt) {
        // In place of whatever was typed, as the old hand-off did (Cmd/Ctrl+Z brings that back),
        // and of a notice offering an earlier one.
        clearOffer();
        fill(prompt, { atStart: true });
      } else if (dropped) {
        offer(dropped);
      }
    }

    // ---- Start ----

    renderAgentInfo();
    const unsubscribe = store.subscribe(({ summary }) => {
      renderAgentInfo();
      const body = logInner.querySelector('.agent-welcome-body');
      if (body) body.replaceWith(welcomeBody());
      // A run that started since the list loaded: show it.
      const running = summary && summary.running;
      if (running && listState === 'ready' && !chats.some((c) => c.id === running.chat_id)) loadList();
    });
    const onPhoneChange = () => {
      if (!phone.matches) setListOpen(false);
    };
    phone.addEventListener('change', onPhoneChange);
    // Relative times move on while the screen is open, as on Schedules.
    const ticker = setInterval(refreshTimes, TICK_MS);

    renderList();
    renderHead();
    const start = target(ctx);
    if (start.id) {
      openChat(start.id);
    } else {
      showWelcome();
      loadList();
    }
    if (start.dropped) offer(start.dropped);
    if (start.prompt) {
      fill(start.prompt, { atStart: true }); // the hand-off: focus goes to the composer
    } else {
      if (unsent) {
        input.value = unsent;
        grow();
      }
      focusHeading();
    }
    unsent = '';

    const self = {
      update(c) {
        if (gone) return false;
        route(c);
        return true;
      },
    };
    instance = self;

    return () => {
      gone = true;
      if (instance === self) instance = null;
      unsent = input.value.trim() ? input.value : '';
      openSeq++;
      turn = null;
      // A stream still connecting closes once it has (so its run is claimed, and cancelled).
      for (const s of [...streams]) s.release();
      streams.clear();
      stopPoll();
      clearInterval(ticker);
      for (const id of timers) clearTimeout(id);
      timers.clear();
      ctl.abort();
      unsubscribe();
      phone.removeEventListener('change', onPhoneChange);
    };
  },
};

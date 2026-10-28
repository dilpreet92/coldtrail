// Agent (spec §5.6): the conversation list (search; "Your chats" / "Scheduled runs"), the
// transcript (agent text through the safe markdown subset, consecutive tool calls folded into
// "Worked · N steps" groups) and the composer (Enter sends, Shift+Enter is a newline, Stop closes
// the stream, which makes the server cancel the turn at its next event).
//
// Routes: #/agent is a new conversation, #/agent/<chat_id> an existing one, and
// #/agent?prompt=<text> fills the composer without sending (the Pipeline hand-off).
// Scheduled-run conversations are a read-only log, polled every 2s while the run is writing to
// them. Leaving the screen closes the stream, stops the poll and aborts every pending request.
// While a turn streams, links inside this screen (other conversations, New chat, Settings) ask
// before they stop it; the sidebar can't be intercepted, so the composer says so instead.
//
// Server contract (inventory "Chat"): POST /api/chats/new clears the server's active
// conversation and POST /api/chats/:id/activate selects one; POST /api/chat {message} → {run}
// starts a turn in the active conversation, and /api/chat/stream?run= streams its events once.
// So before each turn this view makes the conversation on screen the active one. A turn whose
// stream nobody claims keeps running (holding the server's one-turn lock) until a 45s reaper, so
// a turn this view gives up on is still claimed once and closed, which cancels it.

import { api, openStream } from '../core/api.js';
import { fmtNum, fmtRelative, h } from '../core/dom.js';
import { renderMarkdown } from '../core/markdown.js';
import { href } from '../core/router.js';
import { confirmDialog } from '../core/ui.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/emptyState.js';
import { listDetail } from '../components/listDetail.js';

const title = 'Agent';

const POLL_MS = 2000;
// After `done` the server still saves the reply (or deletes a failed first turn) before it
// closes the stream; wait for that close, but never longer than this.
const SETTLE_MS = 2000;
const LIST_PAGE = 50;
const MAX_INPUT_PX = 200;
const RUN_TITLE = /^(Scheduled run|Manual run)\b/;
const RUN_PREFIX = /^Scheduled run\s+—\s+/;

const STARTERS = [
  {
    title: 'Source companies',
    text: 'Find 20 seed-stage B2B SaaS companies that fit my company profile and add them to the pipeline.',
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
  alert: ['M12 3l9.5 17h-19L12 3z', 'M12 10v4', 'M12 17.5v.01'],
  lock: ['M7 11V8a5 5 0 0 1 10 0v3', 'M5.5 11h13v9.5h-13z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
};

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
const errText = (err) => (err && err.message) || String(err);
const enc = encodeURIComponent;

/** The list label: runs drop the "Scheduled run —" prefix their section already says. */
function listTitle(t) {
  if (!t) return 'Untitled conversation';
  return t.replace(RUN_PREFIX, '') || t;
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

// The same words as the run history on Schedules.
const RUN_STATUS = {
  ok: ['Succeeded', 'ok'],
  error: ['Failed', 'danger'],
  auth_failed: ['Sign-in failed', 'warn'],
  running: ['Running', 'accent'],
};

// The mounted screen's route handler, so update() can keep the DOM when only the chat changes.
let instance = null;

export default {
  title,
  css: true,
  /** Same screen, another conversation or a ?prompt=: keep the DOM (list, scroll, composer). */
  update(ctx) {
    return instance ? instance.update(ctx) : false;
  },
  mount(root, ctx) {
    const { store, nav } = ctx;
    const ctl = new AbortController();
    const signal = ctl.signal;
    const timers = new Set();
    const streams = new Set(); // every EventSource this screen opened, closed on unmount

    let gone = false;
    let currentId = null; // the conversation on screen; null = a new one
    let current = null; // { id, title, run, running, missing }
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
    let poll = null;
    let runInfo = null; // the /api/runs row of the open run conversation

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
      },
    });
    const navEl = h('nav', { class: 'agent-nav', 'aria-label': 'Conversations' });
    const listPane = h(
      'div',
      { class: 'agent-list', id: 'agent-list' },
      h('div', { class: 'agent-search' }, icon('search', 15), search),
      navEl,
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

    /** openStream, remembered so leaving the screen closes it whatever state the turn is in. */
    function stream(url, handlers) {
      const s = openStream(url, {
        onEvent: handlers.onEvent,
        onError: () => {
          streams.delete(s);
          handlers.onError();
        },
      });
      const close = s.close;
      s.close = () => {
        streams.delete(s);
        close();
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

    function announce(text) {
      announcer.textContent = text;
    }

    function grow() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_PX)}px`;
    }

    function fill(text) {
      input.value = text;
      grow();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
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

    function errorRow(message) {
      return h(
        'div',
        { class: 'agent-error', role: 'alert' },
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
     * with their results in order. setRunning(on) switches the "Working…" label.
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
        const glyph = state === 'ok' || state === 'done' ? icon('check', 14) : state === 'fail' ? icon('cross', 14) : '';
        step.glyph.replaceChildren(glyph);
        step.word.textContent = state === 'fail' ? ' (failed)' : state === 'pending' ? ' (running)' : '';
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
      headTitle.textContent = current.title || 'Untitled conversation';
      if (current.title) headTitle.title = current.title;
      const listed = chats.find((c) => c.id === currentId);
      if (current.run) {
        const parts = [];
        if (runInfo) {
          // /api/runs `started_at` is written when the run ends: it is the finish time.
          parts.push(`Finished ${fmtRelative(runInfo.started_at)}`);
          parts.push(
            `${fmtNum(runInfo.sourced)} sourced · ${fmtNum(runInfo.enriched)} enriched · ` +
              `${fmtNum(runInfo.drafted)} drafted · ${fmtNum(runInfo.sent)} sent`,
          );
        } else if (listed && listed.updated_at) {
          parts.push(`Updated ${fmtRelative(listed.updated_at)}`);
        }
        headMeta.textContent = parts.join(' · ') || (current.running ? 'Running now' : '');
        if (current.running) {
          const live = badge('Running', 'accent');
          live.prepend(h('span', { class: 'agent-live-dot', 'aria-hidden': 'true' }));
          headBadges.append(live);
        } else if (runInfo && RUN_STATUS[runInfo.status]) {
          const [text, tone] = RUN_STATUS[runInfo.status];
          headBadges.append(badge(text, tone));
        } else if (runInfo && runInfo.status) {
          headBadges.append(badge(runInfo.status, 'neutral'));
        }
        if (runInfo && runInfo.trigger === 'dry') headBadges.append(badge('Dry run', 'neutral'));
        headBadges.append(badge('Read-only', 'neutral'));
      } else if (listed && listed.updated_at) {
        headMeta.textContent = `Updated ${fmtRelative(listed.updated_at)}`;
      }
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
      if (next === 'compose') {
        foot.append(form);
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

    function setBusy(busy) {
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
                onClick: () => {
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
      const match = (c) => !filter || (c.title || '').toLowerCase().includes(filter);
      const mine = chats.filter((c) => !isRun(c.title) && match(c));
      const runs = chats.filter((c) => isRun(c.title) && match(c));
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

    function emptySection(label, body) {
      return h(
        'section',
        { class: 'agent-section' },
        h('h2', { class: 'agent-section-title eyebrow' }, label),
        h('p', { class: 'agent-section-empty' }, body),
      );
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
          listError = errText(err);
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
        h('h2', { class: 'agent-welcome-title' }, 'What should the agent work on?'),
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
                h('span', { class: 'agent-starter-text' }, s.text),
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

    /** Render stored messages: tool rows fold into groups, a run's brief folds away. */
    function renderStored(d, { keep = false } = {}) {
      const run = isRun(d.title);
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      if (!msgs.length && !d.running) {
        logState(
          emptyState({
            title: run ? 'This run recorded nothing' : 'No messages yet',
            body: run
              ? 'It ended before the agent started. The run history in Schedules shows how it finished.'
              : 'Send a message to start this conversation.',
            action: run ? { label: 'Open Schedules', href: '#/schedules' } : null,
          }),
        );
        return;
      }
      // A poll redraws everything: keep open whatever the reader opened.
      const disclosures = () => [...logInner.querySelectorAll('.agent-tools-head, details.agent-brief')];
      const opened = keep
        ? disclosures().map((el) => (el.tagName === 'DETAILS' ? el.open : el.getAttribute('aria-expanded') === 'true'))
        : [];

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
          if (!opened[i]) return;
          if (el.tagName === 'DETAILS') el.open = true;
          else el.click();
        });
      }
    }

    // ---- Opening conversations ----

    function stopPoll() {
      if (poll != null) clearInterval(poll);
      poll = null;
    }

    /** Close the live turn's stream without ceremony (switching conversations, leaving). */
    function dropTurn() {
      const t = turn;
      if (!t) return;
      turn = null;
      t.abandoned = true;
      if (t.stream) t.stream.close();
      cancel(t.settleTimer);
      if (t.resolveAdopt) t.resolveAdopt();
      setBusy(false);
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

    function newConversation() {
      openSeq++;
      dropTurn();
      stopPoll();
      currentId = null;
      current = null;
      runInfo = null;
      setMode('compose');
      renderHead();
      showWelcome();
      markCurrent();
      setListOpen(false);
    }

    async function openChat(id) {
      const seq = ++openSeq;
      dropTurn();
      stopPoll();
      currentId = id;
      current = null;
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
        current = { id, title: null, missing: false, run: false, running: false };
        headTitle.textContent = 'Conversation';
        logState(
          h(
            'div',
            { class: 'agent-load-error' },
            emptyState({
              title: "Couldn't open this conversation",
              body: errText(err),
              action: { label: 'Try again', onClick: () => openChat(id) },
            }),
          ),
        );
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
            action: { label: 'Start a new chat', href: '#/agent' },
          }),
        );
        return;
      }
      const run = isRun(d.title);
      current = { id, title: d.title, run, running: !!d.running, missing: false };
      renderHead();
      renderStored(d);
      toBottom();
      setMode(run ? 'readonly' : 'compose');
      if (d.running) startPoll(id, seq, d);
      if (run) {
        loadRunInfo(id, seq);
        return;
      }
      // As before: the conversation on screen becomes the server's active one.
      try {
        await api.post(`/api/chats/${enc(id)}/activate`, {}, { signal });
      } catch (err) {
        if (gone || isAbort(err) || seq !== openSeq) return;
        setMode('blocked', errText(err));
      }
    }

    async function loadRunInfo(id, seq) {
      try {
        const runs = await api.get('/api/runs', { signal });
        if (gone || seq !== openSeq) return;
        runInfo = (Array.isArray(runs) ? runs : []).find((r) => r.chat_id === id) || null;
        renderHead();
      } catch (_) {
        // Optional detail: the transcript stands without it.
      }
    }

    const signature = (d) => JSON.stringify([d.running, d.messages]);

    function startPoll(id, seq, first) {
      stopPoll();
      let last = signature(first);
      let busy = false;
      poll = setInterval(async () => {
        if (gone || seq !== openSeq) {
          stopPoll();
          return;
        }
        if (busy || document.hidden) return;
        busy = true;
        try {
          const d = await api.get(`/api/chats/${enc(id)}`, { signal });
          if (gone || seq !== openSeq) return;
          const sig = signature(d);
          if (sig !== last) {
            last = sig;
            current.running = !!d.running;
            follow(() => renderStored(d, { keep: true }));
            renderHead();
          }
          if (!d.running) {
            stopPoll();
            loadList();
            loadRunInfo(id, seq);
            store.refresh();
          }
        } catch (err) {
          // As before, a failed poll stops quietly; reopening the conversation resumes it.
          if (!isAbort(err)) stopPoll();
        } finally {
          busy = false;
        }
      }, POLL_MS);
    }

    // ---- A turn: send, stream, stop, settle ----

    async function send() {
      if (turn || mode !== 'compose') return;
      if (!input.value.trim()) {
        input.focus();
        return;
      }
      if (adopting) await adopting; // a conversation that just started is still getting its id
      if (gone || turn || mode !== 'compose') return;
      const text = input.value.trim();
      if (!text) return;
      const seq = openSeq;
      const fresh = currentId === null;
      const t = {
        seq,
        fresh,
        prevIds: new Set(chats.map((c) => c.id)),
        stream: null,
        group: null,
        live: null,
        working: null,
        sawError: false,
        done: false,
        ok: false,
        stopped: false,
        dropped: false,
        settled: false,
        settleTimer: null,
        resolveAdopt: null,
      };
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

      clearWelcome();
      const bubble = userMsg(text);
      t.working = workingRow();
      logInner.append(bubble, t.working);
      toBottom();
      input.value = '';
      grow();
      setBusy(true);
      announce('The agent is working.');

      let run;
      try {
        // New conversation → clear the server's active pointer; else make this one active.
        if (fresh) await api.post('/api/chats/new', {}, { signal });
        else await api.post(`/api/chats/${enc(currentId)}/activate`, {}, { signal });
        if (gone || t.abandoned) return; // left before anything started: send nothing
        // Not on the screen's signal: once the server has the message the turn runs, so this
        // view needs its id even after it leaves, to claim it and so cancel it (below).
        ({ run } = await api.post('/api/chat', { message: text }));
      } catch (err) {
        if (gone || isAbort(err) || t.abandoned) return;
        // Nothing reached the agent: take the message back and say why. (Stop may have ended
        // this turn already, and a newer one may be running.)
        if (turn === t) {
          turn = null;
          setBusy(false);
        }
        bubble.remove();
        hideWorking(t);
        if (!input.value) {
          input.value = text;
          grow();
        }
        const row = errorRow(`Couldn't start the turn: ${errText(err)}`);
        if (!logInner.children.length) {
          showWelcome();
          logInner.prepend(row);
        } else {
          follow(() => logInner.append(row));
        }
        announce('');
        if (t.resolveAdopt) t.resolveAdopt();
        return;
      }
      const url = `/api/chat/stream?run=${enc(run)}`;
      if (gone || t.abandoned || t.stopped) {
        // Stopped, or left for another conversation or screen, while it was starting: claim the
        // stream once and close it at its first event, so the server cancels the turn there
        // instead of running it unobserved until its reaper.
        const s = stream(url, { onEvent: () => s.close(), onError: () => {} });
        return;
      }
      t.stream = stream(url, { onEvent: (ev) => onEvent(t, ev), onError: () => onStreamEnd(t) });
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
          case 'done':
            t.done = true;
            t.ok = !!ev.ok;
            if (!t.ok && !t.sawError) logInner.append(errorRow('The agent stopped without finishing this turn.'));
            endTurn(t);
            announce(t.ok ? 'The agent finished.' : 'The turn ended with an error.');
            // The server closes the stream once it has saved the turn; settle then.
            t.settleTimer = later(() => settle(t), SETTLE_MS);
            break;
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
      setBusy(false);
    }

    function stop() {
      const t = turn;
      if (!t) return;
      t.stopped = true;
      if (t.stream) t.stream.close();
      follow(() => {
        endTurn(t);
        logInner.append(noteRow('Stopped'));
      });
      announce('Stopped.');
      settle(t);
    }

    /** After a turn: refresh counts and the list; a new conversation takes its address. */
    async function settle(t) {
      if (t.settled) return;
      t.settled = true;
      cancel(t.settleTimer);
      if (t.stream && !t.stopped) t.stream.close();
      store.refresh();
      if (gone) return;
      const rows = await loadList();
      if (!gone && t.fresh && t.seq === openSeq && currentId === null && (t.ok || t.stopped || t.dropped)) {
        const hit = rows.find((c) => c.active) || rows.find((c) => !t.prevIds.has(c.id));
        if (hit) {
          currentId = hit.id;
          current = { id: hit.id, title: hit.title, run: false, running: false, missing: false };
          renderHead();
          markCurrent();
          nav.navigate(href(['agent', hit.id]), { replace: true });
        }
      }
      if (t.resolveAdopt) t.resolveAdopt();
    }

    // ---- Routing ----

    function parseRoute() {
      const m = location.hash.match(/^#\/agent(?:\/([^?]*))?/);
      return { id: m && m[1] ? decodeURIComponent(m[1]) : null };
    }

    function applyPrompt(query) {
      const prompt = query && typeof query.prompt === 'string' ? query.prompt : '';
      if (!prompt.trim()) return;
      if (mode !== 'compose') {
        // A run log, a missing or a closed conversation can't take it: start a new one.
        if (currentId === null) newConversation();
        else {
          // In place of this address, so Back skips it; after mount, so update() takes it.
          queueMicrotask(() => {
            if (!gone) nav.navigate(href(['agent'], { prompt }), { replace: true });
          });
          return;
        }
      }
      // After the router's own focus move, and out of the address bar so a refresh won't refill it.
      queueMicrotask(() => {
        if (gone) return;
        fill(prompt);
        nav.setQuery({ prompt: null }, { replace: true });
      });
    }

    function route(c) {
      const id = c.path[1] || null;
      if (id !== currentId) {
        if (id) openChat(id);
        else newConversation();
      }
      applyPrompt(c.query);
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

    renderList();
    renderHead();
    if (ctx.path[1]) {
      openChat(ctx.path[1]);
    } else {
      showWelcome();
      loadList();
    }
    applyPrompt(ctx.query);

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
      openSeq++;
      turn = null;
      for (const s of streams) s.close();
      streams.clear();
      stopPoll();
      for (const id of timers) clearTimeout(id);
      timers.clear();
      ctl.abort();
      unsubscribe();
      phone.removeEventListener('change', onPhoneChange);
    };
  },
};

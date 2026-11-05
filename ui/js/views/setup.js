// First-run setup (spec §5.1) at #/setup and #/setup/<step>: a full page without the shell.
// Four steps, then "You're set":
//   agent        the agent cards, opencode's model, your own model, Test connection (agentPanel)
//   canonical    Connect Canonical (coldtrail's own OAuth); required
//   company      the company profile: Company profile's own editor and checklist
//                (mountProfileEditor, starting from its PROFILE_TEMPLATE)
//   destination  Gmail (app password first, more options folded) and LinkedIn; may be skipped
// Continue is gated on exactly what `onboarded` needs: a present provider, a Canonical token and
// a non-empty profile. Each step is a URL, so back/forward and refresh keep the place; a step
// that needs an earlier one first rewrites the address (silently) to the step it shows instead.
// A bare #/setup, where the app sends an unfinished workspace, keeps its address and shows the
// first step to do (remembered in the history entry, so back/forward return to it).
//
// Everything dynamic reaches the DOM through h() (text nodes); nothing here parses HTML.
// Moving between steps keeps everything running: saves, connect requests (a step shown again
// waits on a connect still running) and the LinkedIn sign-in poll (a sign-in that finishes after
// Skip for now still counts). Leaving the screen aborts in-flight reads, stops that poll and
// drops a sign-in still waiting on a browser approval, saying so in a toast (Settings can't see
// it, and it would hold the callback port every other sign-in needs); saves and the other
// connect requests already sent still land. One sign-in waits at a time (they share that port).
// A pending profile edit is saved first: the router waits for it (beforeLeave), and moving
// between steps hands it to the editor's exit save. Opened again once onboarded (Settings → Run
// guided setup), the header links back to Settings.
//
// agentPanel(root, ctx) is exported for Settings → Agent; see its JSDoc below.

import { api, errorText, isStaleSession } from '../core/api.js';
import { fmtNum, h } from '../core/dom.js';
import { ensureViewCss, href } from '../core/router.js';
import { copyText, isBusy, setBusy, toast } from '../core/ui.js';
import { badge } from '../components/badge.js';
import { searchSelect } from '../components/searchSelect.js';
import { wordmark } from '../shell.js';
import { mountProfileEditor, PROFILE_TEMPLATE } from './company.js';

const LINKEDIN_POLL_MS = 2000;

const STARTER_PROMPT =
  'Find 10 companies that fit my company profile, find the best person to contact at each, and draft a first email to each of them.';

const STEPS = [
  {
    id: 'agent',
    label: 'Agent',
    title: 'Choose your agent',
    desc: 'coldtrail drives an AI agent that finds companies, looks up the right people and writes your drafts. Use an agent you already have, or your own model.',
    required: true,
  },
  {
    id: 'canonical',
    label: 'Canonical',
    title: 'Connect Canonical',
    desc: 'coldtrail finds companies through Canonical, a verified company search that also covers the long tail. It works the same with every agent.',
    required: true,
  },
  {
    id: 'company',
    label: 'Company',
    title: 'Describe your company',
    desc: 'The agent writes every email and LinkedIn note from this profile and only claims what it says. It saves as you type and stays on this computer.',
    required: true,
  },
  {
    id: 'destination',
    label: 'Outreach',
    title: 'Choose where outreach goes',
    desc: 'Connect Gmail, LinkedIn or both. You can skip this and connect them later in Settings.',
    required: false,
  },
];

// ---- Small helpers ----

const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7',
  alert: ['M12 3l9.5 17h-19L12 3z', 'M12 10v4', 'M12 17.5v.01'],
  copy: ['M9 9h11v11H9z', 'M15 9V4H4v11h5'],
  terminal: ['M4 17l6-5-6-5', 'M12 19h8'],
  server: ['M4 4h16v7H4z', 'M4 13h16v7H4z', 'M8 7.5h.01', 'M8 16.5h.01'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  person: ['M15 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20', 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19 8v6', 'M22 11h-6'],
  chat: ['M4 5h16v11H9l-5 4z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
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
    [].concat(ICONS[name]).map((d) => h('path', { d })),
  );
}

/**
 * Put a one-line message into `el` (a live region that stays in the DOM): tone '' (neutral),
 * 'ok', 'err' or 'busy' (with a spinner). Text only; '' clears it. A wait whose button already
 * spins (setBusy) explains itself in a neutral message: one spinner per wait.
 */
function say(el, text, tone = '') {
  el.dataset.tone = text ? tone : '';
  if (!text) {
    el.replaceChildren();
    return;
  }
  const mark =
    tone === 'ok' ? icon('check', 14) : tone === 'err' ? icon('alert', 14) : tone === 'busy' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null;
  el.replaceChildren(...(mark ? [mark] : []), h('span', {}, String(text)));
}

const aborted = (err) => !!err && err.name === 'AbortError';
// What went wrong, for a message on the screen: errorText (core/api.js) gives a stale session
// only the fix, since the app's session banner already says the rest.
/** An OAuth wait the user stopped. The server may still hold the callback port meanwhile. */
const STOPPED = 'Stopped waiting. If connecting again fails, restart coldtrail and try once more.';
/** The server couldn't listen for an approval: a wait setup doesn't know about holds the port. */
const PORT_HELD =
  'Another sign-in may still be waiting, maybe in Settings → Connections or another coldtrail tab: finish or cancel it there, or restart coldtrail, then try again.';
/** The OAuth waits (jobs under these keys): what each is called, and the step it's shown on. */
const WAITS = {
  canonical: { name: 'Canonical approval', step: 'canonical' },
  'gmail-google': { name: 'Google sign-in', step: 'destination' },
  'gmail-client': { name: 'Google sign-in', step: 'destination' },
};

function extLink(url, text) {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);
}

/** Is the provider coldtrail would run present? (StatusDto has no provider_ready field.) */
export function providerReady(status) {
  if (!status) return false;
  if (status.provider === 'openai') return !!status.base_url;
  const a = (status.agents || []).find((x) => x.kind === status.provider);
  return !!(a && a.present);
}

// ---- Agent panel (shared with Settings → Agent) ----

const OWN = 'openai';
const AGENT_INFO = {
  claude: {
    desc: "Anthropic's coding agent. Uses your Claude subscription.",
    install: 'npm i -g @anthropic-ai/claude-code',
    login: 'claude',
    loginNote: 'then type /login',
  },
  codex: {
    desc: "OpenAI's coding agent. Uses your ChatGPT plan or an API key.",
    install: 'npm i -g @openai/codex',
    login: 'codex login',
  },
  opencode: {
    desc: 'Open-source agent. Uses the model providers you sign it into.',
    install: 'curl -fsSL https://opencode.ai/install | bash',
    login: 'opencode auth login',
  },
  [OWN]: { desc: 'Any OpenAI-compatible endpoint, including Ollama on this computer.' },
};
const OLLAMA = { base: 'http://localhost:11434/v1', model: 'llama3.1' };

let apUid = 0;

/**
 * The agent chooser: Setup's step 1, reused by Settings → Agent. Renders into `root` (replacing
 * its children) and works on its own, with no wizard around it:
 *
 *   - one card per agent CLI in `status.agents` (Claude Code, Codex CLI, opencode) plus "Your own
 *     model"; each says Ready / Sign in needed / Not installed and, when something's missing,
 *     shows the install or sign-in command with a copy button. "Check again" re-reads status.
 *   - choosing an installed CLI saves it at once: POST /api/onboarding/provider {provider}.
 *     A CLI that isn't installed can't be chosen (the server would refuse it).
 *   - opencode: a searchable model picker fed by GET /api/provider/opencode/models (free text
 *     when the list is empty or fails); a choice saves {provider:'opencode', opencode_model}
 *     ('' = opencode's default).
 *   - Your own model: the base URL / model / API key form; Save posts {provider:'openai',
 *     base_url, model, api_key|null} (a blank key keeps the stored one). Choosing the card only
 *     opens the form; the provider switches on Save. Until then the panel is pending().
 *   - Test connection: POST /api/provider/probe on the saved provider, result shown inline; a
 *     CLI that fails it also gets its sign-in command (its "signed in" state is only a file check).
 *     A result, or a test still running, is about the agent and model it ran on: saving another
 *     one clears it and frees the button.
 *   Saves go out one at a time, in the order they were made, so the last choice is the one kept.
 *   Status reads are numbered: one that answers after a later one was applied is dropped.
 *
 * ctx (all optional):
 *   status     the StatusDto (GET /api/status) to render first. Without it the panel shows a
 *              loading state and calls refresh().
 *   refresh()  → Promise<StatusDto>: how to get fresh status. Called after every save, by "Check
 *              again", and when no status was given. Default: GET /api/status. A host with a
 *              store can pass `() => store.refresh().then((s) => s.status)`.
 *   onChange(status, change) runs after each save lands, with the fresh status; change is
 *              { what: 'provider' | 'model' | 'byok', provider }.
 *   onPending(pending) runs when pending() changes.
 *   signal     an AbortSignal; aborting it is destroy().
 *
 * Returns { el, update(status), settled(), pending(), destroy() }. update(status) re-renders
 * from a status the host already has (typing in the form and the last test result are kept).
 * settled() → Promise<boolean> waits for the saves already made (a model typed just before the
 * host moves on is saved when the field loses focus) and says whether they all landed.
 * pending() → true while "Your own model" is the chosen card but its form isn't what's in use
 * (nothing saved since it was chosen, or a field changed since): a host that moves on would leave
 * it behind. A save on its way doesn't count (settled() waits for it). destroy() aborts reads and
 * the probe and empties `root`; a save already made still lands. The panel loads
 * css/views/setup.css itself (ensureViewCss) and stays invisible until it has.
 */
export function agentPanel(root, ctx = {}) {
  const styled = ensureViewCss('setup');
  const uid = `ap-${++apUid}`;
  const ctl = new AbortController();
  const { signal } = ctl;
  const refresh = typeof ctx.refresh === 'function' ? ctx.refresh : () => api.get('/api/status', { signal });

  let status = ctx.status || null;
  let view = status ? status.provider : null; // the card shown as chosen: a CLI kind or 'openai'
  let saving = null; // the CLI kind being saved
  let models = null; // null | { state: 'loading' | 'ready' | 'empty' | 'error', list, message }
  let byokDirty = false;
  let probeFor = null; // the configuration (probeKey) the shown result, or the running test, is about
  let probeRun = 0; // numbers each test, so one answering after a reset is dropped
  let pendingShown = false; // pending() as onPending last heard it
  let destroyed = false;
  const cards = new Map(); // kind → { el, pick, badgeSlot, cmd }
  // Saves, each → Promise<boolean> (true = it landed). They run one after another in the order
  // they were made: every save names a provider, so two racing could land out of order and undo
  // the later choice (a model typed, then another card clicked). Sent without `signal`: leaving
  // the panel right after one (Continue, a progress link) must not drop it.
  const inflight = new Set();
  let queue = Promise.resolve(true);
  const track = (send) => {
    const p = queue.then(send).then(
      (ok) => ok !== false,
      () => false,
    );
    queue = p;
    inflight.add(p);
    p.then(() => inflight.delete(p));
    return p;
  };

  const emit = (what, provider) => {
    if (typeof ctx.onChange !== 'function') return;
    try {
      ctx.onChange(status, { what, provider });
    } catch (err) {
      console.error(err);
    }
  };

  // Status reads, numbered: one that answers after a later one was applied is older news (a
  // "Check again" landing after a card's save) and comes back as null.
  let reads = 0;
  let readApplied = 0;
  async function read() {
    const n = ++reads;
    const fresh = await refresh();
    if (n < readApplied) return null;
    readApplied = n;
    return fresh;
  }

  // What a test result is about: the agent and, for opencode or your own model, its model.
  const probeKey = (s) =>
    s.provider === 'opencode' ? `opencode|${s.opencode_model || ''}` : s.provider === OWN ? `${OWN}|${s.base_url || ''}|${s.model || ''}` : s.provider;

  const pending = () => !!status && view === OWN && !isBusy(byokSave) && (byokDirty || status.provider !== OWN);
  function notePending() {
    const now = pending();
    if (now === pendingShown || destroyed) return;
    pendingShown = now;
    if (typeof ctx.onPending !== 'function') return;
    try {
      ctx.onPending(now);
    } catch (err) {
      console.error(err);
    }
  }

  // ---- Shell of the panel ----

  const loading = h(
    'div',
    { class: 'ap-loading', role: 'status' },
    h('span', { class: 'sr-only' }, 'Loading agents…'),
    [0, 1, 2, 3].map(() => h('span', { class: 'skeleton ap-skeleton', 'aria-hidden': 'true' })),
  );
  const loadError = h('div', { class: 'ap-load-error', role: 'alert', hidden: true });
  const grid = h('div', { class: 'ap-grid', role: 'group', 'aria-label': 'Agent' });
  const recheckBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: recheck }, 'Check again');
  const recheck_ = h('div', { class: 'ap-recheck', hidden: true }, h('span', {}, 'Installed an agent or signed in from your terminal?'), recheckBtn);
  const pickError = h('p', { class: 'ap-msg', role: 'status' });

  // opencode model picker
  const modelHintId = `${uid}-model-hint`;
  const modelSelect = searchSelect({
    options: [],
    value: (status && status.opencode_model) || '',
    placeholder: "opencode's default model",
    label: 'Model',
    freeText: true,
    onChange: saveModel,
  });
  modelSelect.input.setAttribute('aria-describedby', modelHintId);
  const modelHint = h('p', { class: 'field-hint', id: modelHintId });
  const modelStatus = h('p', { class: 'ap-msg', role: 'status' });
  const modelBox = h('div', { class: 'ap-model', hidden: true }, modelSelect, h('div', { class: 'ap-model-foot' }, modelHint, modelStatus));

  // Your own model
  const field = (label, input, extra = null) =>
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: input.id }, label), input, extra);
  const baseInput = h('input', {
    class: 'input',
    id: `${uid}-base`,
    type: 'url',
    inputmode: 'url',
    placeholder: OLLAMA.base,
    autocomplete: 'off',
    spellcheck: 'false',
    onInput: () => {
      byokDirty = true;
      setBaseError('');
      notePending();
    },
  });
  const baseError = h('p', { class: 'field-error', id: `${uid}-base-error`, hidden: true });
  const modelInput = h('input', {
    class: 'input',
    id: `${uid}-model`,
    type: 'text',
    placeholder: OLLAMA.model,
    autocomplete: 'off',
    spellcheck: 'false',
    onInput: () => {
      byokDirty = true;
      notePending();
    },
  });
  const keyInput = h('input', {
    class: 'input',
    id: `${uid}-key`,
    type: 'password',
    autocomplete: 'new-password',
    spellcheck: 'false',
    onInput: () => {
      byokDirty = true;
      notePending();
    },
  });
  const byokNote = h('p', { class: 'ap-byok-note' });
  const byokSave = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
  const byokStatus = h('p', { class: 'ap-msg', role: 'status' });
  const byokForm = h(
    'form',
    { class: 'ap-byok', 'aria-label': 'Your own model', novalidate: true, hidden: true, onSubmit: saveByok },
    byokNote,
    h(
      'div',
      { class: 'ap-byok-fields' },
      field('Base URL', baseInput, baseError),
      field('Model', modelInput),
      field('API key', keyInput),
    ),
    h(
      'div',
      { class: 'ap-actions' },
      byokSave,
      h('button', { type: 'button', class: 'btn btn-ghost', onClick: fillOllama }, 'Use local Ollama'),
      byokStatus,
    ),
  );

  // Test connection
  const testBtn = h('button', { type: 'button', class: 'btn btn-secondary', onClick: runProbe }, 'Test connection');
  const testNote = h('p', { class: 'ap-test-note' });
  const testResult = h('p', { class: 'ap-msg ap-test-result', role: 'status' });
  // A CLI that failed the test: its sign-in command, whatever its auth file says.
  const testCmd = h('div', { class: 'ap-cmd ap-test-cmd', hidden: true });
  const testBox = h('div', { class: 'ap-test', hidden: true }, h('div', { class: 'ap-test-row' }, testBtn, testNote), testResult, testCmd);

  const details = h('div', { class: 'ap-details', hidden: true }, modelBox, byokForm, testBox);
  const el = h('div', { class: 'ap' }, loading, loadError, grid, recheck_, pickError, details);
  // Unstyled for a moment on another screen is worse than blank for a moment.
  el.style.visibility = 'hidden';
  styled.then(() => el.style.removeProperty('visibility'));
  root.replaceChildren(el);

  // ---- Cards ----

  const agentOf = (kind) => ((status && status.agents) || []).find((a) => a.kind === kind) || null;
  const nameOf = (kind) => (kind === OWN ? 'Your own model' : (agentOf(kind) || {}).label || kind);

  function buildCard(kind) {
    const info = AGENT_INFO[kind] || { desc: '' };
    const name = nameOf(kind);
    const descId = `${uid}-${kind}-desc`;
    const nameId = `${uid}-${kind}-name`;
    const stateId = `${uid}-${kind}-state`;
    const badgeSlot = h('span', { class: 'ap-state', id: stateId });
    const pick = h(
      'button',
      {
        type: 'button',
        class: 'ap-pick',
        'aria-pressed': 'false',
        // Read as "opencode, Ready" with the blurb as its description.
        'aria-labelledby': `${nameId} ${stateId}`,
        'aria-describedby': descId,
        onClick: () => choose(kind),
      },
      h('span', { class: 'ap-icon' }, icon(kind === OWN ? 'server' : 'terminal', 18)),
      h('span', { class: 'ap-text' }, h('span', { class: 'ap-name', id: nameId }, name), h('span', { class: 'ap-desc', id: descId }, info.desc), badgeSlot),
      h('span', { class: 'ap-radio', 'aria-hidden': 'true' }),
    );
    const cmd = h('div', { class: 'ap-cmd', hidden: true });
    const card = h('div', { class: 'ap-card', 'data-kind': kind }, pick, cmd);
    return { el: card, pick, badgeSlot, cmd, name };
  }

  function commandRow(row, label, command, note) {
    if (row.dataset.command === command && row.dataset.label === label) return;
    row.dataset.command = command;
    row.dataset.label = label;
    const copyLabel = h('span', {}, 'Copy');
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-secondary btn-sm ap-copy',
        'aria-label': `Copy “${command}”`,
        onClick: async () => {
          const ok = await copyText(command);
          copyLabel.textContent = ok ? 'Copied' : 'Copy failed';
          btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed');
          clearTimeout(btn._t);
          btn._t = setTimeout(() => {
            copyLabel.textContent = 'Copy';
            btn.setAttribute('aria-label', `Copy “${command}”`);
          }, 2000);
        },
      },
      icon('copy', 14),
      copyLabel,
    );
    const words = command.split(' ').flatMap((w, i) => (i ? [' ', h('span', { class: 'ap-cmd-word' }, w)] : [h('span', { class: 'ap-cmd-word' }, w)]));
    row.replaceChildren(
      h('div', { class: 'ap-cmd-head' }, h('span', { class: 'ap-cmd-label' }, label), btn),
      h('div', { class: 'ap-cmd-text' }, h('code', {}, words), note ? h('span', { class: 'ap-cmd-note' }, note) : null),
    );
  }

  function renderCard(kind) {
    const c = cards.get(kind);
    const a = agentOf(kind);
    const info = AGENT_INFO[kind] || {};
    const chosen = view === kind && (kind === OWN || !!(a && a.present));
    c.pick.setAttribute('aria-pressed', chosen ? 'true' : 'false');
    c.el.classList.toggle('is-chosen', chosen);
    c.el.classList.toggle('is-saving', saving === kind);
    if (saving === kind) c.pick.setAttribute('aria-busy', 'true');
    else c.pick.removeAttribute('aria-busy');

    let state;
    let cmd = null;
    if (kind === OWN) {
      // In use, saved for later (a CLI is in use; the form opens with it), or nothing saved.
      if (!status.base_url) state = badge('Not set up');
      else state = status.provider === OWN ? badge('Configured', 'ok') : badge('Saved');
    } else if (!a || !a.present) {
      state = badge('Not installed');
      if (info.install) cmd = ['Install', info.install, null];
    } else if (!a.authed) {
      state = badge('Sign in needed', 'warn');
      if (info.login) cmd = ['Sign in', info.login, info.loginNote];
    } else {
      state = badge('Ready', 'ok');
    }
    const unavailable = kind !== OWN && (!a || !a.present);
    if (unavailable) c.pick.setAttribute('aria-disabled', 'true');
    else c.pick.removeAttribute('aria-disabled');
    c.el.classList.toggle('is-unavailable', unavailable);
    c.badgeSlot.replaceChildren(state);
    c.cmd.hidden = !cmd;
    if (cmd) commandRow(c.cmd, ...cmd);
    else delete c.cmd.dataset.command;
  }

  function renderCards() {
    const kinds = [...(status.agents || []).map((a) => a.kind), OWN];
    if (kinds.join() !== [...cards.keys()].join()) {
      cards.clear();
      for (const kind of kinds) cards.set(kind, buildCard(kind));
      grid.replaceChildren(...[...cards.values()].map((c) => c.el));
    } else {
      // Labels can change (e.g. a status from a different host); keep the element.
      for (const kind of kinds) {
        const c = cards.get(kind);
        c.name = nameOf(kind);
        const nameEl = c.el.querySelector('.ap-name');
        if (nameEl.textContent !== c.name) nameEl.textContent = c.name;
      }
    }
    for (const kind of kinds) renderCard(kind);
    recheck_.hidden = !(status.agents || []).some((a) => !a.present || !a.authed);
  }

  // ---- Details below the cards ----

  function hideTestCmd() {
    const copy = testCmd.querySelector('.ap-copy');
    if (copy) clearTimeout(copy._t);
    testCmd.hidden = true;
    testCmd.replaceChildren();
    delete testCmd.dataset.command;
  }

  function renderDetails() {
    const saved = status.provider;
    const ready = providerReady(status);
    const showModel = view === 'opencode' && saved === 'opencode';
    const showByok = view === OWN;
    const showTest = view === saved && ready;
    modelBox.hidden = !showModel;
    byokForm.hidden = !showByok;
    testBox.hidden = !showTest;
    details.hidden = !(showModel || showByok || showTest);

    if (showModel) {
      if (document.activeElement !== modelSelect.input) modelSelect.setValue(status.opencode_model || '');
      if (!models) loadModels();
    }
    if (showByok) {
      if (!byokDirty) {
        baseInput.value = status.base_url || '';
        modelInput.value = status.model || '';
      }
      keyInput.placeholder = status.key_set ? 'Saved. Leave blank to keep it.' : 'Leave blank for local Ollama';
      const current = saved === OWN ? null : cards.get(saved);
      byokNote.textContent = current
        ? `coldtrail keeps using ${current.name} until you save.`
        : 'Saved here. Change any field and save again to update it.';
    }
    if (showTest) {
      const label = saved === OWN ? 'your model' : (cards.get(saved) || {}).name || saved;
      testNote.textContent = `Sends one tiny request to check that ${label} answers.`;
    }
    // A result, or a test still running, says nothing about another agent or model once that's
    // the one saved.
    if (probeFor !== null && probeFor !== probeKey(status)) resetProbe();
  }

  function render() {
    if (!status) return;
    loading.hidden = true;
    loadError.hidden = true;
    grid.hidden = false;
    renderCards();
    renderDetails();
    notePending();
  }

  // ---- Actions ----

  async function load() {
    loading.hidden = false;
    loadError.hidden = true;
    grid.hidden = true;
    try {
      const fresh = await read();
      if (destroyed) return;
      if (fresh) {
        status = fresh;
        view = status.provider;
      }
      render();
    } catch (err) {
      if (destroyed || aborted(err)) return;
      loading.hidden = true;
      loadError.hidden = false;
      // A stale session: the app's banner explains it, and retrying can't help.
      loadError.replaceChildren(
        h('p', {}, h('strong', {}, "Couldn't load your agents. "), errorText(err)),
        isStaleSession(err) ? null : h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: load }, 'Try again'),
      );
    }
  }

  async function recheck() {
    if (isBusy(recheckBtn)) return;
    setBusy(recheckBtn, true, { label: 'Checking…' });
    try {
      // Older than a save's re-read that landed first (a card chosen meanwhile): nothing new.
      const fresh = await read();
      if (destroyed || !fresh) return;
      status = fresh;
      if (view !== OWN && saving == null) view = status.provider;
      render();
    } catch (err) {
      if (!destroyed && !aborted(err)) say(pickError, `Couldn't check again: ${errorText(err)}`, 'err');
    } finally {
      if (!destroyed) setBusy(recheckBtn, false);
    }
  }

  function choose(kind) {
    if (!status || saving) return;
    say(pickError, '');
    if (kind === OWN) {
      view = OWN;
      render();
      return;
    }
    const a = agentOf(kind);
    if (!a || !a.present) return;
    if (status.provider === kind) {
      view = kind;
      render();
      return;
    }
    // Shown as chosen (and saving) at once; sent once the saves before it have landed.
    const before = view;
    view = kind;
    saving = kind;
    render();
    track(() => sendProvider(kind, before));
  }

  async function sendProvider(kind, before) {
    let saved = false;
    try {
      await api.post('/api/onboarding/provider', { provider: kind });
      saved = true;
      const fresh = await read();
      if (destroyed) return true;
      if (fresh) status = fresh;
      saving = null;
      view = status.provider;
      render();
      emit('provider', kind);
    } catch (err) {
      if (destroyed || aborted(err)) return saved;
      saving = null;
      if (!saved) view = before;
      render();
      const name = (cards.get(kind) || {}).name || kind;
      say(pickError, saved ? `Switched to ${name}, but couldn't re-check your agents: ${errorText(err)}` : `Couldn't switch to ${name}: ${errorText(err)}`, 'err');
    }
    return saved;
  }

  async function loadModels() {
    models = { state: 'loading', list: [] };
    renderModelHint();
    try {
      const r = await api.get('/api/provider/opencode/models', { signal });
      if (destroyed) return;
      const list = Array.isArray(r.models) ? r.models.map(String) : [];
      models = { state: list.length ? 'ready' : 'empty', list, message: r.message || '' };
    } catch (err) {
      if (destroyed || aborted(err)) return;
      models = { state: 'error', list: [], message: errorText(err) };
    }
    modelSelect.setOptions(models.list.map((m) => ({ value: m, label: m })));
    renderModelHint();
  }

  function renderModelHint() {
    const typeIt = 'Type a model id, like provider/model.';
    let text;
    if (!models || models.state === 'loading') text = 'Loading the models opencode can use…';
    else if (models.state === 'ready')
      text = `${fmtNum(models.list.length)} ${models.list.length === 1 ? 'model' : 'models'} from opencode. Leave it empty to use opencode's default.`;
    else if (models.state === 'empty') text = `${(models.message || "opencode didn't list any models").replace(/\.$/, '')}. ${typeIt}`;
    else text = `Couldn't load the model list: ${models.message.replace(/\.$/, '')}. ${typeIt}`;
    modelHint.textContent = text;
  }

  // A typed model is committed when the field loses focus, which is also what pressing Continue
  // (or another card) right away does: the step change must not drop this save (see `track`).
  function saveModel(value) {
    say(modelStatus, 'Saving…', 'busy');
    return track(() => sendModel(value));
  }

  async function sendModel(value) {
    let saved = false;
    try {
      await api.post('/api/onboarding/provider', { provider: 'opencode', opencode_model: value });
      saved = true;
      const fresh = await read();
      if (destroyed) return true;
      if (fresh) status = fresh;
      render();
      say(modelStatus, value ? 'Model saved' : "Using opencode's default model", 'ok');
      emit('model', 'opencode');
    } catch (err) {
      if (destroyed || aborted(err)) return saved;
      if (saved) {
        say(modelStatus, 'Model saved', 'ok');
      } else {
        modelSelect.setValue((status && status.opencode_model) || '');
        say(modelStatus, `Couldn't save the model: ${errorText(err)}`, 'err');
      }
    }
    return saved;
  }

  function setBaseError(text) {
    baseError.textContent = text;
    baseError.hidden = !text;
    if (text) {
      baseInput.setAttribute('aria-invalid', 'true');
      baseInput.setAttribute('aria-describedby', baseError.id);
    } else {
      baseInput.removeAttribute('aria-invalid');
      baseInput.removeAttribute('aria-describedby');
    }
  }

  function fillOllama() {
    baseInput.value = OLLAMA.base;
    if (!modelInput.value.trim()) modelInput.value = OLLAMA.model;
    byokDirty = true;
    setBaseError('');
    notePending();
  }

  function saveByok(e) {
    e.preventDefault();
    if (isBusy(byokSave)) return;
    const base = baseInput.value.trim();
    if (!base) {
      setBaseError('Enter the base URL of an OpenAI-compatible endpoint.');
      baseInput.focus();
      return;
    }
    if (!/^https?:\/\/\S+$/i.test(base)) {
      setBaseError('Enter a URL that starts with http:// or https://.');
      baseInput.focus();
      return;
    }
    setBaseError('');
    say(byokStatus, '');
    setBusy(byokSave, true, { label: 'Saving…' });
    notePending();
    const key = keyInput.value.trim();
    track(() => sendByok({ provider: OWN, base_url: base, model: modelInput.value.trim(), api_key: key || null }));
  }

  async function sendByok(body) {
    let saved = false;
    try {
      await api.post('/api/onboarding/provider', body);
      saved = true;
      keyInput.value = '';
      byokDirty = false;
      // The key may have changed with nothing else: a result from before is about the old one.
      resetProbe();
      const fresh = await read();
      if (destroyed) return true;
      if (fresh) status = fresh;
      view = OWN;
      setBusy(byokSave, false);
      render();
      say(byokStatus, 'Saved. coldtrail now uses your own model.', 'ok');
      emit('byok', OWN);
    } catch (err) {
      if (destroyed || aborted(err)) return saved;
      setBusy(byokSave, false);
      notePending();
      say(byokStatus, saved ? 'Saved. coldtrail now uses your own model.' : `Couldn't save: ${errorText(err)}`, saved ? 'ok' : 'err');
    }
    return saved;
  }

  /** Forget the shown result and free the button; a test still running is dropped when it answers. */
  function resetProbe() {
    probeRun++;
    probeFor = null;
    say(testResult, '');
    hideTestCmd();
    setBusy(testBtn, false);
  }

  async function runProbe() {
    if (isBusy(testBtn) || !status) return;
    const provider = status.provider;
    const run = ++probeRun;
    probeFor = probeKey(status);
    hideTestCmd();
    setBusy(testBtn, true, { label: 'Testing…' });
    say(testResult, 'Running a quick check. This can take up to a minute.');
    try {
      const r = await api.post('/api/provider/probe', {}, { signal });
      if (destroyed || run !== probeRun) return;
      say(testResult, r.message || (r.ok ? 'It answered.' : "It didn't answer."), r.ok ? 'ok' : 'err');
      // "Ready" only means an auth file exists: a CLI whose login lapsed fails here, so offer
      // the way back in.
      const info = AGENT_INFO[provider];
      if (!r.ok && provider !== OWN && info && info.login) {
        commandRow(testCmd, 'Signed out? Sign in again', info.login, info.loginNote);
        testCmd.hidden = false;
      }
    } catch (err) {
      if (destroyed || aborted(err) || run !== probeRun) return;
      say(testResult, errorText(err), 'err');
    } finally {
      if (!destroyed && run === probeRun) setBusy(testBtn, false);
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    ctl.abort();
    for (const btn of el.querySelectorAll('.ap-copy')) clearTimeout(btn._t);
    root.replaceChildren();
  }

  if (ctx.signal) {
    if (ctx.signal.aborted) destroy();
    else ctx.signal.addEventListener('abort', destroy, { once: true });
  }

  if (status) render();
  else if (!destroyed) load();

  return {
    el,
    update(next) {
      if (destroyed || !next) return;
      const first = !status;
      status = next;
      if (first || saving == null) {
        if (first || view !== OWN) view = status.provider;
      }
      render();
    },
    settled() {
      return Promise.all([...inflight]).then((all) => all.every(Boolean));
    },
    pending,
    destroy,
  };
}

// ---- The Setup screen ----

let current = null; // the mounted screen's { update(ctx), beforeLeave() }

function mountSetup(root, ctx) {
  const viewCtl = new AbortController();
  const store = ctx.store || null;
  const nav = ctx.nav;
  let status = (store && store.get().status) || null;
  let step = null;
  let scope = null; // the shown step's { ctl, cleanups, api }
  let requested = ctx.path[1] || '';
  // Connections confirmed this session by an ok response, in case status lags behind.
  const local = { canonical: false, gmail: false, linkedin: false };

  const progress = h('nav', { class: 'setup-progress', 'aria-label': 'Setup progress' });
  const main = h('div', { class: 'setup-main' });
  const exit = h('a', { class: 'btn btn-ghost btn-sm setup-exit', href: '#/settings', hidden: true }, 'Back to Settings');
  const page = h(
    'div',
    { class: 'setup' },
    h(
      'header',
      { class: 'setup-top' },
      wordmark(),
      h('span', { class: 'setup-top-sep', 'aria-hidden': 'true' }),
      h('h1', { class: 'setup-h1' }, 'Setup'),
      exit,
    ),
    h('div', { class: 'setup-body' }, progress, main),
  );
  root.replaceChildren(page);
  // Opened again once onboarded (Settings → Run guided setup), the screen has no sidebar: link
  // back. Decided by the first status it has, so a first run doesn't grow one on the way through.
  let exitDecided = false;
  function renderExit() {
    if (exitDecided || !status) return;
    exitDecided = true;
    exit.hidden = !status.onboarded;
  }

  // ---- Status ----

  const canonicalOn = () => !!(status && (status.discovery_connected || local.canonical));
  const gmailOn = () => !!(status && (status.destination_connected || local.gmail));
  const linkedinOn = () => !!(status && (local.linkedin || (status.linkedin_connected && !status.linkedin_reconnect_needed)));
  const doneOf = (id) => {
    if (!status) return false;
    if (id === 'agent') return providerReady(status);
    if (id === 'canonical') return canonicalOn();
    if (id === 'company') return !!status.product_set;
    if (id === 'destination') return gmailOn() || linkedinOn();
    return false;
  };
  const reachable = (i) => STEPS.slice(0, i).every((s) => !s.required || doneOf(s.id));
  const firstIncomplete = () => {
    const s = STEPS.find((x) => x.required && !doneOf(x.id));
    return s ? s.id : null;
  };

  function resolveStep(want) {
    const first = firstIncomplete();
    if (want === 'done') return first || 'done';
    const i = STEPS.findIndex((s) => s.id === want);
    if (i >= 0) return reachable(i) ? want : first;
    // A bare #/setup: the step this history entry showed before (back, forward, reload) …
    if (!want) {
      const kept = bareStep();
      const k = STEPS.findIndex((s) => s.id === kept);
      if (k >= 0 && reachable(k)) return kept;
    }
    // … else a fresh workspace starts at 1, and a returning one at its first gap.
    if (!canonicalOn() && !status.product_set) return 'agent';
    return first || 'agent';
  }

  // A bare #/setup keeps its address (the app sends an unfinished workspace there), so the step
  // it shows rides along in the history entry's state instead. The router never reads it.
  function bareStep() {
    try {
      const st = history.state;
      return st && typeof st === 'object' ? st.setupStep || '' : '';
    } catch (_) {
      return '';
    }
  }
  function rememberBare(id) {
    try {
      const st = history.state && typeof history.state === 'object' ? history.state : {};
      if (st.setupStep !== id) history.replaceState({ ...st, setupStep: id }, '');
    } catch (_) {
      /* no history: a reload starts over at the first gap */
    }
  }

  // Point the address at the step shown. Silent: the router only learns the new hash (so a
  // later visit to the asked-for address is a real change) and doesn't hand it back to update().
  function setAddress(id) {
    const to = href(['setup', id]);
    if (location.hash === to) return;
    nav.navigate(to, { replace: true, silent: true });
  }

  // Status reads, numbered: one that answers after a later one was applied is older news (a
  // "Check again" landing after a save's re-read) and leaves `status` as it is.
  let statusReads = 0;
  let statusApplied = 0;
  /** → the newest status read so far (this one, unless a later one answered first). */
  async function fetchStatus() {
    const n = ++statusReads;
    const fresh = await api.get('/api/status', { signal: viewCtl.signal });
    if (n > statusApplied) {
      statusApplied = n;
      status = fresh;
    }
    return status;
  }

  /** Re-read status after a change and let the shown step and the progress catch up. */
  async function refreshStatus() {
    try {
      await fetchStatus();
    } catch (err) {
      if (aborted(err)) return;
      throw err;
    }
    renderProgress();
    if (scope && scope.api && scope.api.onStatus) scope.api.onStatus();
  }

  // ---- Connect requests ----

  // Connect requests outlive the step that sent them, as in Settings: the server holds an OAuth
  // connect open for the whole browser approval, and dropping it would stop the callback listener
  // the approval comes back to. So they go out without the step's signal (only Cancel stops a
  // wait), one that connects counts whatever is shown when it lands, and a step shown again
  // waits on the one still running instead of starting another. They don't outlive the screen,
  // though: unlike Settings' waits, which its module keeps, nothing could show or cancel one
  // left behind (Settings doesn't know about these), and it would keep the server listening on
  // the one callback port (8765) every sign-in needs. So unmounting drops the OAuth waits (see
  // the end of mountSetup); the app-password check, which holds no port, still lands.
  const jobs = new Map(); // key → { ctl: AbortController | null, done: Promise<{ r } | { err }> }

  /**
   * Send `send(signal)` under `key`; the signal is Cancel's (with `cancellable`, an OAuth wait),
   * else none. An ok answer marks `confirms` connected (confirmed) before anything waiting on
   * `done` runs. The shown step hears when the job starts and ends (jobsChanged).
   */
  function startJob(key, send, { cancellable = false, confirms = null } = {}) {
    const ctl = cancellable ? new AbortController() : null;
    const job = { ctl, done: null };
    job.done = Promise.resolve()
      .then(() => send(ctl ? ctl.signal : undefined))
      .then(
        (r) => {
          if (confirms && !(r && r.ok === false)) confirmed(confirms);
          return { r };
        },
        (err) => ({ err }),
      )
      .finally(() => {
        if (jobs.get(key) === job) jobs.delete(key);
        jobsChanged();
      });
    jobs.set(key, job);
    jobsChanged();
    return job;
  }

  /** A job started or ended: the shown step updates what depends on it (holdFor). */
  function jobsChanged() {
    if (viewCtl.signal.aborted) return;
    if (scope && scope.api && scope.api.onJobs) scope.api.onJobs();
  }

  /** The OAuth wait other than `key`'s that is open now, if any: one at a time, as they share the port. */
  const otherWait = (key) => {
    for (const [k, job] of jobs) if (k !== key && job.ctl) return k;
    return null;
  };

  /**
   * An OAuth button while another sign-in waits: it stays focusable, dimmed (aria-disabled), and
   * a press says why (held()). A busy button is left alone (setBusy owns it meanwhile).
   */
  function holdFor(btn, key) {
    if (isBusy(btn)) return;
    if (otherWait(key)) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
  }

  /** True, saying so in `msg`, when another sign-in's wait keeps `key` from starting now. */
  function held(key, msg) {
    const other = otherWait(key);
    if (!other) return false;
    const w = WAITS[other];
    const where = w.step === step ? '' : ` on step ${STEPS.findIndex((s) => s.id === w.step) + 1}`;
    say(msg, `Finish or cancel the ${w.name}${where} first: only one sign-in can wait at a time.`, 'err');
    return true;
  }

  /** A connection an ok answer confirmed: it counts at once (status can lag), on any step. */
  function confirmed(kind) {
    local[kind] = true;
    if (viewCtl.signal.aborted) return;
    renderProgress();
    if (scope && scope.api && scope.api.onStatus) scope.api.onStatus();
    refreshStatus().catch(() => {});
  }

  /**
   * Show `job` on a card until it lands: `btn` busy with `label`, `text` under it and, for a job
   * that can be cancelled, `cancel` (waitCancel). Then `then(outcome)`, if the card is still shown.
   */
  function follow(sc, job, { btn, out, cancel = null, label, text }, then) {
    if (cancel && job.ctl) cancel.start(job.ctl);
    setBusy(btn, true, { label });
    say(out, text);
    job.done.then((o) => {
      if (scope !== sc) return;
      if (cancel) cancel.end();
      setBusy(btn, false);
      then(o);
    });
  }

  /** What a landed job that didn't connect says, as say()'s [text, tone]; null when it did. */
  function failure(o, fallback) {
    if (o.err) return aborted(o.err) ? [STOPPED] : [errorText(o.err), 'err'];
    if (o.r && o.r.ok === false) {
      const msg = o.r.message || fallback;
      // The server couldn't listen for the approval: a wait setup doesn't know about holds the
      // port (setup's own are one at a time and end with the screen).
      return [/callback port/i.test(msg) ? `${msg.replace(/\.\s*$/, '')}. ${PORT_HELD}` : msg, 'err'];
    }
    return null;
  }

  // ---- LinkedIn sign-in ----

  // LinkedIn signs in through a Chrome window the server opens and watches, so no request is held
  // open here: the screen polls the server's view of the sign-in instead. The poll is the
  // screen's, not the step's: a sign-in that finishes after the step was left (Skip for now, a
  // progress link) still counts, on the progress and the finish screen. It stops on unmount.
  const li = { waiting: false, seq: 0, timer: null, card: null }; // card: the shown card's { started(), ended(outcome) }

  /** The server's view of the sign-in, read with `signal` (null when it can't be read). */
  function liState(signal) {
    return api.get('/api/destination/linkedin/status', { signal }).catch(() => null);
  }

  function liStop() {
    li.waiting = false;
    li.seq++;
    clearTimeout(li.timer);
    li.timer = null;
  }

  /** A sign-in window is open (just now, or since before this screen): poll until it ends. */
  function liWatch() {
    liStop();
    li.waiting = true;
    liNext(li.seq);
    if (li.card) li.card.started();
  }

  function liNext(seq) {
    li.timer = setTimeout(() => liTick(seq), LINKEDIN_POLL_MS);
  }

  async function liTick(seq) {
    let s;
    try {
      s = await api.get('/api/destination/linkedin/status', { signal: viewCtl.signal });
    } catch (err) {
      if (aborted(err) || seq !== li.seq) return;
      // Every later poll would get the same 401: stop, and point at the fix.
      if (isStaleSession(err)) liEnd({ err });
      else liNext(seq); // a hiccup: try again next tick
      return;
    }
    if (seq !== li.seq) return;
    if (s.connected && !s.reconnect_needed) liEnd({ connected: true });
    else if (!s.waiting) liEnd({ connected: false });
    else liNext(seq);
  }

  /** The sign-in ended: the card, if one is shown, says how; a connection counts on any step. */
  function liEnd(outcome) {
    liStop();
    if (outcome.connected) local.linkedin = true;
    if (li.card) li.card.ended(outcome);
    if (outcome.connected) confirmed('linkedin');
  }

  // ---- Progress ----

  function renderProgress() {
    if (!status) {
      progress.hidden = true;
      return;
    }
    progress.hidden = false;
    const at = step === 'done' ? STEPS.length : STEPS.findIndex((s) => s.id === step);
    const items = STEPS.map((s, i) => {
      const isDone = doneOf(s.id);
      const isCurrent = s.id === step;
      // Done steps and the ones already passed link back; later steps wait for Continue.
      const linked = !isCurrent && (isDone || i < at) && reachable(i);
      const dot = h('span', { class: 'setup-dot', 'aria-hidden': 'true' }, isDone && !isCurrent ? icon('check', 14) : String(i + 1));
      const parts = [dot, h('span', { class: 'setup-step-label' }, s.label), isDone ? h('span', { class: 'sr-only' }, ', done') : null];
      const node =
        linked
          ? h('a', { class: 'setup-step-link', href: href(['setup', s.id]) }, parts)
          : h('span', { class: 'setup-step-link', 'aria-current': isCurrent ? 'step' : null }, parts);
      return h('li', { class: ['setup-step', isDone && 'is-done', isCurrent && 'is-current'] }, node);
    });
    progress.replaceChildren(h('ol', { class: 'setup-steps' }, items));
  }

  // ---- Showing a step ----

  function teardownStep() {
    if (!scope) return;
    for (const fn of scope.cleanups) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
    scope.ctl.abort();
    scope = null;
  }

  function focusTitle() {
    const t = main.querySelector('.setup-title');
    if (t) t.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function show(want, { focus = false } = {}) {
    renderExit();
    const target = resolveStep(want);
    // A bare #/setup stays bare; a step that needs an earlier one first names the one shown.
    if (!want) rememberBare(target);
    else if (target !== want) setAddress(target);
    if (target === step && scope) {
      renderProgress();
      return;
    }
    teardownStep();
    step = target;
    scope = { ctl: new AbortController(), cleanups: [], api: null };
    renderProgress();
    main.replaceChildren(target === 'done' ? doneScreen(scope) : stepCard(target, scope));
    if (focus) focusTitle();
  }

  function go(id) {
    nav.navigate(['setup', id]);
  }

  // ---- Loading / error ----

  function renderLoading() {
    progress.hidden = true;
    main.replaceChildren(
      h(
        'section',
        { class: 'setup-card setup-loading', role: 'status', 'aria-busy': 'true' },
        h('span', { class: 'sr-only' }, 'Loading setup…'),
        h('span', { class: 'skeleton setup-sk setup-sk-eyebrow', 'aria-hidden': 'true' }),
        h('span', { class: 'skeleton setup-sk setup-sk-title', 'aria-hidden': 'true' }),
        h('span', { class: 'skeleton setup-sk setup-sk-line', 'aria-hidden': 'true' }),
        h('span', { class: 'skeleton setup-sk setup-sk-block', 'aria-hidden': 'true' }),
      ),
    );
  }

  /** Focus has nowhere to be: what had it was replaced (Try again's card) and nothing took it since. */
  const focusLost = () => !document.activeElement || document.activeElement === document.body;

  /** `focus`: put focus on this card's Try again (the last one had it, and this load failed too). */
  function renderLoadError(err, { focus = false } = {}) {
    progress.hidden = true;
    // A stale session: the app's banner above says what happened (once, as the alert), and
    // retrying can't work until the tab is reopened, so the card only points at the fix.
    const stale = isStaleSession(err);
    const again = stale ? null : h('button', { type: 'button', class: 'btn btn-secondary', onClick: (e) => load(e.currentTarget === document.activeElement) }, 'Try again');
    const retry = again ? h('div', { class: 'setup-error-actions' }, again) : null;
    main.replaceChildren(
      h(
        'section',
        { class: ['setup-card', 'setup-error', stale && 'is-stale'] },
        h(
          'div',
          { class: 'setup-error-body', role: stale ? null : 'alert' },
          icon('alert', 20),
          h('div', {}, h('h2', { class: 'setup-error-title' }, "Setup couldn't load"), h('p', {}, errorText(err))),
        ),
        retry,
      ),
    );
    if (focus && again) again.focus();
  }

  /**
   * Read status and show the asked-for step. `refocus`: Try again had focus when pressed; the
   * card it sat on is gone, so focus moves on to what the load shows (the step's title, or the
   * next Try again if this load failed too) unless something else took it meanwhile.
   */
  async function load(refocus = false) {
    renderLoading();
    try {
      await fetchStatus();
    } catch (err) {
      if (aborted(err)) return;
      renderLoadError(err, { focus: refocus && focusLost() });
      return;
    }
    step = null;
    show(requested, { focus: refocus && focusLost() });
  }

  // ---- A step card: eyebrow, title, description, content, footer ----

  function stepCard(id, sc) {
    const i = STEPS.findIndex((s) => s.id === id);
    const def = STEPS[i];
    const content = h('div', { class: 'setup-content' });
    const hint = h('p', { class: 'setup-hint', id: 'setup-hint', 'aria-live': 'polite' });
    const next = h('button', { type: 'button', class: 'btn btn-primary', onClick: onContinue }, 'Continue');
    const skip = def.id === 'destination' ? h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => go('done') }, 'Skip for now') : null;
    const back = i > 0 ? h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => go(STEPS[i - 1].id) }, 'Back') : null;
    const card = h(
      'section',
      { class: ['setup-card', `setup-card-${id}`], 'aria-labelledby': 'setup-title' },
      h(
        'div',
        { class: 'setup-card-main' },
        h('p', { class: 'setup-eyebrow' }, `Step ${i + 1} of ${STEPS.length}`),
        h('h2', { class: 'setup-title', id: 'setup-title', tabindex: '-1' }, def.title),
        h('p', { class: 'setup-desc' }, def.desc),
        content,
      ),
      h('div', { class: 'setup-foot' }, h('div', { class: 'setup-foot-start' }, back), h('div', { class: 'setup-foot-end' }, hint, skip, next)),
    );

    let busy = false;
    const helpers = {
      gate: () => refreshGate(),
      showError: (text) => setHint(text, true),
    };
    const builders = { agent: agentStep, canonical: canonicalStep, company: companyStep, destination: destinationStep };
    sc.api = builders[id](content, sc, helpers);

    function setHint(text, error = false) {
      hint.textContent = text || '';
      hint.classList.toggle('is-error', !!(text && error));
    }

    function refreshGate() {
      if (!sc.api) return { ok: false, reason: '' };
      const g = sc.api.gate();
      const skipping = !!(sc.api.canSkip && sc.api.canSkip());
      if (skip) skip.hidden = !skipping;
      next.hidden = skipping;
      if (g.ok) {
        next.removeAttribute('aria-disabled');
        // An ok gate can still carry a note (e.g. a saved blank template): shown, not blocking.
        if (g.note) next.setAttribute('aria-describedby', 'setup-hint');
        else next.removeAttribute('aria-describedby');
        setHint(g.note || '');
      } else {
        next.setAttribute('aria-disabled', 'true');
        next.setAttribute('aria-describedby', 'setup-hint');
        setHint(g.reason, hint.classList.contains('is-error'));
      }
      return g;
    }

    async function onContinue() {
      if (busy) return;
      const g = sc.api.gate();
      if (!g.ok) {
        // Re-announce the reason as an error.
        setHint('');
        setHint(g.reason, true);
        return;
      }
      busy = true;
      setBusy(next, true);
      try {
        if (sc.api.beforeContinue && !(await sc.api.beforeContinue())) return;
        if (scope !== sc) return;
        go(i + 1 < STEPS.length ? STEPS[i + 1].id : 'done');
      } finally {
        busy = false;
        if (next.isConnected) {
          setBusy(next, false);
          // The gate may have changed meanwhile; keep the hint (it may hold the reason it stopped).
          if (sc.api.gate().ok) next.removeAttribute('aria-disabled');
          else next.setAttribute('aria-disabled', 'true');
        }
      }
    }

    refreshGate();
    return card;
  }

  // ---- Step 1: agent ----

  function agentStep(content, sc, step_) {
    const box = h('div', { class: 'setup-agent' });
    content.append(box);
    const panel = agentPanel(box, {
      status,
      signal: sc.ctl.signal,
      refresh: async () => {
        const s = await fetchStatus();
        renderProgress();
        return s;
      },
      onChange: () => step_.gate(),
      // "Your own model" chosen but not saved: Continue would leave it behind, typed key and all.
      onPending: () => step_.gate(),
    });
    const reason = 'Choose an installed agent, or save your own model, to continue.';
    const unsaved = 'Save your own model, or choose another agent, to continue.';
    return {
      gate: () => (panel.pending() ? { ok: false, reason: unsaved } : providerReady(status) ? { ok: true } : { ok: false, reason }),
      // A model typed just before Continue was sent when the field lost focus, and a Save pressed
      // just before is on its way: let them land (and stop here if one didn't, while its error is
      // still on screen).
      async beforeContinue() {
        if (!(await panel.settled())) {
          step_.showError("Your agent change didn't save. See the message above.");
          return false;
        }
        if (panel.pending()) {
          step_.showError(unsaved);
          return false;
        }
        if (!providerReady(status)) {
          step_.showError(reason);
          return false;
        }
        return true;
      },
      leave: () => panel.settled(),
      onStatus: () => {
        panel.update(status);
        step_.gate();
      },
    };
  }

  // ---- Step 2: Canonical ----

  /** A Cancel for an OAuth wait: hidden until `start(ctl)`, aborts ctl, and puts focus back on `btn`. */
  function waitCancel(btn) {
    let ctl = null;
    const cancelBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost',
        hidden: true,
        onClick: () => {
          if (!ctl) return;
          if (document.activeElement === cancelBtn) btn.focus({ preventScroll: true });
          ctl.abort();
        },
      },
      'Cancel',
    );
    return {
      el: cancelBtn,
      start(waitCtl) {
        ctl = waitCtl;
        cancelBtn.hidden = false;
      },
      end() {
        ctl = null;
        cancelBtn.hidden = true;
      },
    };
  }

  function canonicalStep(content, sc, step_) {
    const badgeSlot = h('span', { class: 'setup-conn-state' });
    const btn = h('button', { type: 'button', class: 'btn', onClick: connect });
    const cancel = waitCancel(btn);
    const msg = h('p', { class: 'setup-msg', role: 'status' });
    const note = h('p', { class: 'setup-conn-note' });
    content.append(
      h(
        'section',
        { class: 'setup-conn', 'aria-labelledby': 'setup-canonical-title' },
        connHead('search', 'setup-canonical-title', 'Canonical', note, badgeSlot),
        h('div', { class: 'setup-conn-body' }, h('div', { class: 'setup-row' }, btn, cancel.el), msg),
      ),
    );

    function render() {
      const on = canonicalOn();
      badgeSlot.replaceChildren(on ? badge('Connected', 'ok') : badge('Not connected'));
      note.textContent = on
        ? 'coldtrail can search Canonical for companies that match your searches.'
        : "Connecting opens Canonical's consent page in your browser. Approve it there and come back.";
      if (!isBusy(btn)) {
        btn.className = on ? 'btn btn-secondary' : 'btn btn-primary';
        btn.textContent = on ? 'Reconnect' : 'Connect Canonical';
      }
      holdFor(btn, 'canonical');
    }

    function wait(job) {
      const text = "Approve coldtrail in the browser tab that opened. This page updates when you're done.";
      follow(sc, job, { btn, out: msg, cancel, label: 'Waiting for approval…', text }, (o) => {
        const failed = failure(o, "Couldn't connect to Canonical.");
        if (failed) say(msg, ...failed);
        else say(msg, 'Canonical is connected.', 'ok');
        render();
        step_.gate();
      });
    }

    function connect() {
      if (isBusy(btn) || jobs.has('canonical') || held('canonical', msg)) return;
      const send = (signal) => api.post('/api/discovery/canonical/connect', {}, { signal });
      wait(startJob('canonical', send, { cancellable: true, confirms: 'canonical' }));
    }

    render();
    // Left while the consent tab was open, and back: still waiting on that approval.
    const running = jobs.get('canonical');
    if (running) wait(running);
    return {
      gate: () => (canonicalOn() ? { ok: true } : { ok: false, reason: 'Connect Canonical to continue.' }),
      onStatus: () => {
        render();
        step_.gate();
      },
      onJobs: render,
    };
  }

  // ---- Step 3: company profile ----

  const isTemplate = (doc) => doc.trim() === PROFILE_TEMPLATE.trim();

  function companyStep(content, sc, step_) {
    const box = h('div', { class: 'setup-company' });
    content.append(box);
    // Company profile's own editor and checklist: it loads product.md (showing the template for
    // an empty one), saves as you type and never saves a blank profile.
    const editor = mountProfileEditor(box, {
      store: store || undefined,
      // Its "Checklist" title sits under this step's h2.
      headingLevel: 3,
      onChange: () => step_.gate(),
    });
    // Leaving the step hands an edit still waiting to the editor's exit save (the next editor
    // waits for it); leaving the screen flushes it first (leave(), through beforeLeave).
    sc.cleanups.push(() => editor.dispose());

    function gate() {
      const s = editor.state();
      if (!s.loaded) {
        if (s.status !== 'load-error') return { ok: false, reason: 'Loading your profile…' };
        // On a stale session the editor offers no Try again: its card points at the fix instead.
        return isStaleSession({ message: s.error })
          ? { ok: false, reason: "Your profile didn't load." }
          : { ok: false, reason: "Your profile didn't load. Try again above." };
      }
      if (s.empty) return { ok: false, reason: 'Write a few lines about your company to continue.' };
      if (isTemplate(s.doc)) {
        // The untouched template doesn't count, unless it's what product.md now holds (typed
        // into and undone): the workspace then counts it as set, so Continue must agree.
        if (s.template || s.status !== 'saved') return { ok: false, reason: "Fill in the template with your company's details to continue." };
        return { ok: true, note: 'This is still the blank template. Drafts stay generic until you fill it in.' };
      }
      return { ok: true };
    }

    return {
      gate,
      async beforeContinue() {
        const s = await editor.flush();
        if (s.status === 'error') {
          step_.showError(`Couldn't save your profile: ${errorText({ message: s.error })}`);
          return false;
        }
        const g = gate();
        if (!g.ok) {
          step_.showError(g.reason);
          return false;
        }
        try {
          await fetchStatus();
        } catch (err) {
          if (aborted(err)) return false;
          step_.showError(errorText(err));
          return false;
        }
        renderProgress();
        if (!status.product_set) {
          step_.showError("Your profile didn't save. Try again.");
          return false;
        }
        return true;
      },
      leave: () => editor.flush(),
    };
  }

  // ---- Step 4: where outreach goes ----

  function connHead(iconName, titleId, title, note, badgeSlot) {
    return h(
      'div',
      { class: 'setup-conn-head' },
      h('span', { class: 'setup-conn-icon' }, icon(iconName, 18)),
      h(
        'div',
        { class: 'setup-conn-text' },
        h('div', { class: 'setup-conn-titlerow' }, h('h3', { class: 'setup-conn-title', id: titleId, tabindex: '-1' }, title), badgeSlot),
        note,
      ),
    );
  }

  function textField(id, label, attrs) {
    const input = h('input', { class: 'input', id, autocomplete: 'off', spellcheck: 'false', ...attrs });
    const el = h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), input);
    return { el, input };
  }

  /** A button row with its message right under it (a live region that stays in the DOM). */
  function action(id, ...buttons) {
    const msg = h('p', { class: 'setup-msg', id, role: 'status' });
    return { el: h('div', { class: 'setup-action' }, h('div', { class: 'setup-row' }, buttons), msg), msg };
  }

  function gmailCard(sc, onChange) {
    const badgeSlot = h('span', { class: 'setup-conn-state' });
    const note = h('p', { class: 'setup-conn-note' });
    // The outcome, on the card itself: a connected card folds its forms away.
    const msg = h('p', { class: 'setup-msg setup-conn-msg', role: 'status' });

    const email = textField('setup-gmail-email', 'Gmail address', { type: 'email', autocomplete: 'email', placeholder: 'you@gmail.com' });
    const pw = textField('setup-gmail-pw', 'App password', { type: 'password', placeholder: '16 characters, spaces are fine' });
    const apBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Connect Gmail');
    const ap = action('setup-gmail-ap-msg', apBtn);
    const apForm = h(
      'form',
      { class: 'setup-form', novalidate: true, 'aria-label': 'Connect Gmail with an app password', onSubmit: connectAppPassword },
      h('div', { class: 'setup-fields' }, email.el, pw.el),
      ap.el,
    );
    const howTo = h(
      'details',
      { class: 'setup-details' },
      h('summary', {}, 'How to get an app password'),
      h(
        'ol',
        { class: 'setup-howto' },
        h('li', {}, 'Turn on 2-Step Verification in your ', extLink('https://myaccount.google.com/security', 'Google Account security settings'), '.'),
        h('li', {}, 'Open ', extLink('https://myaccount.google.com/apppasswords', 'App passwords'), ', name it “coldtrail” and select Create.'),
        h('li', {}, 'Copy the 16-character password Google shows you.'),
        h('li', {}, 'In Gmail, open Settings → Forwarding and POP/IMAP, select Enable IMAP and save.'),
      ),
    );

    const googleBtn = h('button', { type: 'button', class: 'btn btn-secondary', onClick: connectGoogle }, 'Sign in with Google');
    const googleCancel = waitCancel(googleBtn);
    const google = action('setup-gmail-google-msg', googleBtn, googleCancel.el);
    const googleBlock = h('div', { class: 'setup-more-block' }, h('p', {}, 'Sign in with Google instead of an app password.'), google.el);
    const clientId = textField('setup-gmail-client-id', 'Client ID', { type: 'text', placeholder: '….apps.googleusercontent.com' });
    const clientSecret = textField('setup-gmail-client-secret', 'Client secret', { type: 'password', placeholder: 'GOCSPX-…' });
    const byoBtn = h('button', { type: 'submit', class: 'btn btn-secondary' }, 'Save and connect');
    const byoCancel = waitCancel(byoBtn);
    const byo = action('setup-gmail-client-msg', byoBtn, byoCancel.el);
    const byoForm = h(
      'form',
      { class: 'setup-form setup-more-block', novalidate: true, 'aria-label': 'Connect Gmail with your own OAuth client', onSubmit: connectOwnClient },
      h('p', {}, 'Use your own Google OAuth client (a Desktop app):'),
      h(
        'ol',
        { class: 'setup-howto' },
        h('li', {}, 'In the ', extLink('https://console.cloud.google.com/', 'Google Cloud Console'), ', create or pick a project and enable the Gmail API.'),
        h('li', {}, 'Set up the OAuth consent screen (External, Testing), add yourself as a test user and add the gmail.compose scope.'),
        h('li', {}, 'Create an OAuth client ID of type Desktop app and paste its ID and secret here.'),
      ),
      h('div', { class: 'setup-fields' }, clientId.el, clientSecret.el),
      byo.el,
    );
    const more = h('details', { class: 'setup-details' }, h('summary', {}, 'More options'), h('div', { class: 'setup-more' }, googleBlock, byoForm));
    const forms = h('div', { class: 'setup-gmail-forms' }, apForm, howTo, more);
    const reconnect = h('details', { class: 'setup-details' }, h('summary', {}, 'Use different credentials'));
    const body = h('div', { class: 'setup-conn-body' });

    const el = h(
      'section',
      { class: 'setup-conn', 'aria-labelledby': 'setup-gmail-title' },
      connHead('mail', 'setup-gmail-title', 'Gmail', note, badgeSlot),
      body,
      msg,
    );

    const clearMessages = () => [msg, ap.msg, google.msg, byo.msg].forEach((m) => say(m, ''));

    let shownOn = null;
    function render() {
      const on = gmailOn();
      badgeSlot.replaceChildren(on ? badge('Connected', 'ok') : badge('Not connected'));
      googleBlock.hidden = !status.gmail_client_configured;
      holdFor(googleBtn, 'gmail-google');
      holdFor(byoBtn, 'gmail-client');
      if (on) {
        note.textContent = status.auto_send
          ? `Auto-send is on: Send on the Drafts screen emails people right away, up to ${fmtNum(status.daily_send_cap)} a day. Change it in Settings → Sending.`
          : 'coldtrail saves each email as a draft in your Gmail. You review and send it there.';
      } else {
        note.textContent = 'coldtrail puts each email in your Gmail drafts. An app password is the quickest way in: no Google Cloud project needed.';
      }
      if (shownOn === on) return;
      shownOn = on;
      if (on) {
        reconnect.append(forms);
        body.replaceChildren(reconnect);
      } else {
        body.replaceChildren(forms);
      }
    }

    /** Mark a field invalid (described by its form's message) or valid again. */
    function invalid(input, on, msgEl) {
      if (on) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', msgEl.id);
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      }
    }

    // After a connect (startJob already counted it): the outcome on the card.
    function connected(text) {
      clearMessages();
      say(msg, text, 'ok');
      render();
      onChange();
      // The form that had focus folded away under "Use different credentials": land on the card.
      // Focus the user moved on meanwhile (LinkedIn, Back) stays where they put it.
      const at = document.activeElement;
      if (!at || at === document.body || (el.contains(at) && at.closest('details:not([open])'))) {
        el.querySelector('.setup-conn-title').focus({ preventScroll: true });
      }
    }

    function waitAppPassword(job) {
      follow(sc, job, { btn: apBtn, out: ap.msg, label: 'Checking…', text: 'Checking the app password with Gmail…' }, (o) => {
        const failed = failure(o, "Couldn't connect Gmail.");
        if (failed) {
          say(ap.msg, ...failed);
          return;
        }
        pw.input.value = '';
        connected('Gmail is connected.');
      });
    }

    function connectAppPassword(e) {
      e.preventDefault();
      if (isBusy(apBtn)) return;
      const addr = email.input.value.trim();
      const pass = pw.input.value.trim();
      invalid(email.input, !addr, ap.msg);
      invalid(pw.input, !pass, ap.msg);
      clearMessages();
      if (!addr || !pass) {
        say(ap.msg, 'Enter your Gmail address and the app password.', 'err');
        (addr ? pw.input : email.input).focus();
        return;
      }
      const send = () => api.post('/api/destination/gmail/app-password', { email: addr, app_password: pass });
      waitAppPassword(startJob('gmail-ap', send, { confirms: 'gmail' }));
    }

    // The Google wait, started from "Sign in with Google" or after saving your own client.
    const googleWays = {
      google: { btn: googleBtn, out: google.msg, cancel: googleCancel },
      client: { btn: byoBtn, out: byo.msg, cancel: byoCancel },
    };
    function waitGoogle(way, job) {
      const { out } = googleWays[way];
      const text = "Approve coldtrail in the Google tab that opened. This page updates when you're done.";
      follow(sc, job, { ...googleWays[way], label: 'Waiting for Google…', text }, (o) => {
        const failed = failure(o, "Couldn't connect Gmail.");
        if (failed) say(out, ...failed);
        else connected('Gmail is connected.');
      });
    }

    function oauth(way) {
      const send = (signal) => api.post('/api/destination/gmail/connect', { callback_port: 8765 }, { signal });
      waitGoogle(way, startJob(`gmail-${way}`, send, { cancellable: true, confirms: 'gmail' }));
    }

    function connectGoogle() {
      if (isBusy(googleBtn)) return;
      clearMessages();
      if (!held('gmail-google', google.msg)) oauth('google');
    }

    async function connectOwnClient(e) {
      e.preventDefault();
      if (isBusy(byoBtn)) return;
      clearMessages();
      if (held('gmail-client', byo.msg)) return;
      const id = clientId.input.value.trim();
      invalid(clientId.input, !id, byo.msg);
      if (!id) {
        say(byo.msg, 'Paste your client ID first.', 'err');
        clientId.input.focus();
        return;
      }
      setBusy(byoBtn, true, { label: 'Saving…' });
      try {
        // No signal: a save that went out lands even if the step goes.
        await api.post('/api/destination/gmail/client', { client_id: id, client_secret: clientSecret.input.value.trim() });
      } catch (err) {
        if (scope !== sc) return;
        setBusy(byoBtn, false);
        say(byo.msg, errorText(err), 'err');
        return;
      }
      // Left meanwhile: the client is saved, and Google's tab waits for a press here.
      if (scope !== sc) return;
      setBusy(byoBtn, false);
      if (held('gmail-client', byo.msg)) {
        // Another sign-in started while this saved: the client is saved; this waits its turn.
        holdFor(byoBtn, 'gmail-client');
        return;
      }
      oauth('client'); // stays busy straight on, now waiting for Google
    }

    /** Open the folds around `node` (More options, Use different credentials). */
    function unfold(node) {
      for (let d = node.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    }

    render();
    // Left while a check or a Google wait was running, and back: wait on it here too, in view.
    const checking = jobs.get('gmail-ap');
    if (checking) {
      unfold(apBtn);
      waitAppPassword(checking);
    }
    for (const way of Object.keys(googleWays)) {
      const job = jobs.get(`gmail-${way}`);
      if (!job) continue;
      unfold(googleWays[way].btn);
      waitGoogle(way, job);
    }

    return { el, render };
  }

  function linkedinCard(sc, onChange) {
    const badgeSlot = h('span', { class: 'setup-conn-state' });
    const note = h('p', { class: 'setup-conn-note' });
    const msg = h('p', { class: 'setup-msg', role: 'status' });
    const btn = h('button', { type: 'button', class: 'btn btn-secondary', onClick: connect }, 'Connect LinkedIn');
    const row = h('div', { class: 'setup-row' }, btn);
    const el = h(
      'section',
      { class: 'setup-conn', 'aria-labelledby': 'setup-linkedin-title' },
      connHead('person', 'setup-linkedin-title', 'LinkedIn', note, badgeSlot),
      h('div', { class: 'setup-conn-body' }, row, msg),
    );
    let starting = false; // Connect pressed, the server's answer not back yet

    function render() {
      const on = linkedinOn();
      const reconnect = !on && status.linkedin_reconnect_needed;
      if (li.waiting) badgeSlot.replaceChildren(badge('Waiting for sign-in', 'accent'));
      else if (on) badgeSlot.replaceChildren(badge('Connected', 'ok'));
      else if (reconnect) badgeSlot.replaceChildren(badge('Reconnect needed', 'warn'));
      else badgeSlot.replaceChildren(badge('Not connected'));
      // What actually happens to a connection request, like the Gmail card says for email.
      const how = status.linkedin_auto_send
        ? `Auto-send is on: coldtrail sends connection requests itself, up to ${fmtNum(status.linkedin_daily_cap)} a day and ${fmtNum(status.linkedin_weekly_cap)} a week. Change it in Settings → Sending.`
        : 'coldtrail opens each connection request in a LinkedIn window for you to review and send.';
      note.textContent = on
        ? how
        : reconnect
          ? 'Your LinkedIn session expired. Reconnect to keep sending invites.'
          : `${how} Connecting opens Chrome at LinkedIn's sign-in page.`;
      row.hidden = (on && !starting) || li.waiting;
      if (!starting && !li.waiting && !isBusy(btn)) btn.textContent = reconnect ? 'Reconnect LinkedIn' : 'Connect LinkedIn';
    }

    /** The screen follows an open sign-in (started just now, or before this card was shown). */
    function showWaiting() {
      say(msg, "Sign in to LinkedIn in the Chrome window that opened. This page updates when you're done.", 'busy');
      // The button hides while waiting: keep keyboard focus on the card.
      const hadFocus = document.activeElement === btn;
      render();
      if (hadFocus) el.querySelector('.setup-conn-title').focus({ preventScroll: true });
    }

    /** How the sign-in ended (the screen's poll says); a connection already counts (liEnd). */
    function ended(o) {
      if (o.err) say(msg, errorText(o.err), 'err');
      else if (o.connected) say(msg, 'LinkedIn is connected.', 'ok');
      else say(msg, "LinkedIn sign-in didn't finish: the window was closed or it timed out. Try again.", 'err');
      render();
      onChange();
    }

    async function connect() {
      if (starting || li.waiting || isBusy(btn)) return;
      starting = true;
      setBusy(btn, true, { label: 'Opening Chrome…' });
      say(msg, '');
      let open = false;
      let error = null;
      try {
        // No signal: this starts the sign-in task on the server, which should start either way,
        // and the screen follows it even if this step is gone by the time it answers.
        const r = await api.post('/api/destination/linkedin/connect', {});
        // Chrome may be busy with this user's own sign-in, opened before this screen (another
        // tab, a reload): then wait for that one instead.
        open = !(r && r.status === 'busy') || !!((await liState(viewCtl.signal)) || {}).waiting;
      } catch (err) {
        error = err;
      }
      if (viewCtl.signal.aborted) return;
      if (scope === sc) {
        starting = false;
        setBusy(btn, false);
      }
      if (open) {
        if (!li.waiting) liWatch(); // shows it here, through li.card, if this card is still up
        return;
      }
      if (scope !== sc) return;
      say(msg, error ? errorText(error) : 'Chrome is busy with another LinkedIn task. Try again in a moment.', 'err');
      render();
    }

    const me = { started: showWaiting, ended };
    li.card = me;
    sc.cleanups.push(() => {
      if (li.card === me) li.card = null;
    });
    // A sign-in the screen follows already is shown at once. Else the server knows of one opened
    // before this screen (another tab, a reload), and of one that finished where nothing here
    // watched it, while the status this screen has still says otherwise: count that one.
    if (li.waiting) showWaiting();
    else {
      liState(sc.ctl.signal).then((s) => {
        if (!s || scope !== sc || starting || li.waiting) return;
        if (s.waiting) liWatch();
        else if (s.connected && !s.reconnect_needed && !linkedinOn()) confirmed('linkedin');
      });
    }
    return { el, render };
  }

  function destinationStep(content, sc, step_) {
    const changed = () => {
      renderProgress();
      step_.gate();
    };
    const gmail = gmailCard(sc, changed);
    const linkedin = linkedinCard(sc, changed);
    content.append(h('div', { class: 'setup-stack' }, gmail.el, linkedin.el));
    gmail.render();
    linkedin.render();
    return {
      gate: () => ({ ok: true }),
      canSkip: () => !(gmailOn() || linkedinOn()),
      onStatus: () => {
        gmail.render();
        linkedin.render();
        step_.gate();
      },
      onJobs: () => gmail.render(),
    };
  }

  // ---- Finish ----

  function doneScreen(sc) {
    const homeBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: goHome }, 'Go to Home', icon('arrow', 16));
    const back = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => go('destination') }, 'Back');
    const nextItem = (to, iconName, title, text) =>
      h(
        'li',
        {},
        h(
          'a',
          { class: 'setup-next-item', href: to },
          h('span', { class: 'setup-next-icon' }, icon(iconName, 18)),
          h('span', { class: 'setup-next-text' }, h('span', { class: 'setup-next-title' }, title), h('span', { class: 'setup-next-desc' }, text)),
          h('span', { class: 'setup-next-go' }, icon('arrow', 16)),
        ),
      );
    async function goHome() {
      if (isBusy(homeBtn)) return;
      setBusy(homeBtn, true);
      if (store) await store.refresh();
      if (scope !== sc) return;
      nav.navigate('#/home');
    }
    const next = h(
      'ul',
      { class: 'setup-next' },
      nextItem(
        href(['agent'], { prompt: STARTER_PROMPT }),
        'chat',
        'Find your first companies',
        'Open the agent with a starter request filled in. Nothing runs until you send it.',
      ),
      // ?new=1: Schedules opens its New schedule dialog straight away.
      nextItem(href(['schedules'], { new: '1' }), 'clock', 'Create a schedule', 'Run the agent every day or week so new companies and drafts are waiting for you.'),
    );
    const note = h(
      'p',
      { class: 'setup-note' },
      "Gmail and LinkedIn aren't connected yet. Connect them any time in ",
      h('a', { href: '#/settings?tab=connections' }, 'Settings → Connections'),
      '.',
    );
    const card = h(
      'section',
      { class: 'setup-card setup-done', 'aria-labelledby': 'setup-title' },
      h(
        'div',
        { class: 'setup-card-main' },
        h('span', { class: 'setup-done-mark', 'aria-hidden': 'true' }, icon('check', 22)),
        h('h2', { class: 'setup-title', id: 'setup-title', tabindex: '-1' }, "You're set"),
        h('p', { class: 'setup-desc' }, 'coldtrail is ready to find companies and write drafts. Two good first steps:'),
        next,
      ),
      h('div', { class: 'setup-foot' }, h('div', { class: 'setup-foot-start' }, back), h('div', { class: 'setup-foot-end' }, homeBtn)),
    );
    // A connect sent before skipping here can still land (startJob, the LinkedIn poll): the note
    // follows it.
    function renderNote() {
      if (gmailOn() || linkedinOn()) note.remove();
      else if (!note.parentNode) next.after(note);
    }
    renderNote();
    sc.api = { onStatus: renderNote };
    return card;
  }

  // ---- Start ----

  const instance = {
    update(next) {
      if (next.path[0] !== 'setup') return false;
      requested = next.path[1] || '';
      if (status) show(requested, { focus: true });
      return true;
    },
    // Leaving the screen: let the shown step finish what it was saving (a profile edit inside the
    // autosave delay, a model typed just before) before the next screen mounts.
    beforeLeave() {
      const leave = scope && scope.api && scope.api.leave;
      return leave ? leave() : undefined;
    },
  };
  current = instance;

  if (status) {
    show(requested);
    // The store's copy can be up to 30s old: re-read it and let the step catch up (and open
    // the asked-for step, address and all, if the stale copy had sent the address elsewhere).
    refreshStatus()
      .then(() => {
        if (requested && requested !== step && resolveStep(requested) === requested) {
          setAddress(requested);
          show(requested);
        }
      })
      .catch(() => {});
  } else {
    load();
  }

  return () => {
    teardownStep();
    liStop();
    viewCtl.abort();
    // An OAuth wait still open: drop it, so the server stops listening on the callback port (see
    // "Connect requests"), and say so where the user went. One at a time (held), so one toast.
    const waiting = [...jobs].find(([, job]) => job.ctl);
    for (const [, job] of jobs) if (job.ctl) job.ctl.abort();
    if (waiting) {
      toast(
        `Stopped waiting for the ${WAITS[waiting[0]].name} because you left setup. Close its browser tab and connect again in Settings → Connections.`,
      );
    }
    if (current === instance) current = null;
  };
}

export default {
  title: 'Setup',
  css: true,
  mount: mountSetup,
  update(ctx) {
    return current ? current.update(ctx) : false;
  },
  beforeLeave(to) {
    return current ? current.beforeLeave(to) : undefined;
  },
};

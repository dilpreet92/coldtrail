// First-run setup (spec §5.1) at #/setup and #/setup/<step>: a full page without the shell.
// Four steps, then "You're set":
//   agent        the agent cards, opencode's model, your own model, Test connection (agentPanel)
//   canonical    Connect Canonical (coldtrail's own OAuth); required
//   company      the company profile (a plain editor until Task 20 swaps in mountProfileEditor)
//   destination  Gmail (app password first, more options folded) and LinkedIn; may be skipped
// Continue is gated on exactly what `onboarded` needs: a present provider, a Canonical token and
// a non-empty profile. Each step is a URL, so back/forward and refresh keep the place; a step
// that needs an earlier one first sends the address (through the router) to that earlier step.
// A bare #/setup, where the app sends an unfinished workspace, keeps its address and shows the
// first step to do (remembered in the history entry, so back/forward return to it).
//
// Everything dynamic reaches the DOM through h() (text nodes); nothing here parses HTML.
// Leaving the screen aborts in-flight reads and stops the LinkedIn poll; saves already sent
// still land, and a pending profile edit is saved first.
//
// agentPanel(root, ctx) is exported for Settings → Agent; see its JSDoc below.

import { api } from '../core/api.js';
import { debounce, fmtNum, h } from '../core/dom.js';
import { href } from '../core/router.js';
import { badge } from '../components/badge.js';
import { searchSelect } from '../components/searchSelect.js';

const CSS_HREF = '/assets/css/views/setup.css';
const PROFILE_SAVE_MS = 800;
const LINKEDIN_POLL_MS = 2000;

/** The company profile template: the sections the drafting agent reads, with the CTA in the
 *  `- Link:` form product::cta_link() parses (the old template's bare URL was never picked up). */
export const PROFILE_TEMPLATE = `# Your company — profile

## What we do

## Who we help

## Pain / value

## Proof / differentiator

## Offer

## Call to Action
- Link: https://yourproduct.com/?utm_content={slug}

## Voice & sign-off
`;

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
    desc: 'The agent writes every email and LinkedIn note from this profile and only claims what it says. It stays on this computer.',
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
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
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

const spinner = () => h('span', { class: 'su-spin', 'aria-hidden': 'true' });

/**
 * Put a one-line message into `el` (a live region that stays in the DOM): tone '' (neutral),
 * 'ok', 'err' or 'busy'. Text only; '' clears it.
 */
function say(el, text, tone = '') {
  el.dataset.tone = text ? tone : '';
  if (!text) {
    el.replaceChildren();
    return;
  }
  const mark = tone === 'ok' ? icon('check', 14) : tone === 'err' ? icon('alert', 14) : tone === 'busy' ? spinner() : null;
  el.replaceChildren(...(mark ? [mark] : []), h('span', {}, String(text)));
}

/**
 * Mark a button busy without disabling it (a disabled button drops focus): it ignores presses
 * while `data-busy` is set and shows `label` meanwhile. Returns a function that restores it.
 */
function busyButton(btn, label) {
  const prev = [...btn.childNodes];
  btn.dataset.busy = 'true';
  btn.setAttribute('aria-disabled', 'true');
  btn.setAttribute('aria-busy', 'true');
  btn.replaceChildren(spinner(), h('span', {}, label));
  return () => {
    delete btn.dataset.busy;
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('aria-busy');
    btn.replaceChildren(...prev);
  };
}
const isBusy = (btn) => btn.dataset.busy === 'true';
const aborted = (err) => err && err.name === 'AbortError';
const errText = (err) => (err && err.message) || String(err);
/** A 401: the app's session banner already says so in full, so screens only point at the fix. */
const staleSession = (err) => !!err && err.status === 401;
const REOPEN = 'Reopen coldtrail from your terminal.';

function extLink(url, text) {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);
}

/** Copy to the clipboard: the async API, else a hidden textarea + execCommand. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const active = document.activeElement;
    const ta = h('textarea', { class: 'sr-only', readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (__) {
      ok = false;
    }
    ta.remove();
    if (active && active.focus) active.focus({ preventScroll: true });
    return ok;
  }
}

function ensureStylesheet() {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`link[rel="stylesheet"][href="${CSS_HREF}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', href: CSS_HREF }));
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
 *     opens the form; the provider switches on Save.
 *   - Test connection: POST /api/provider/probe on the saved provider, result shown inline.
 *
 * ctx (all optional):
 *   status     the StatusDto (GET /api/status) to render first. Without it the panel shows a
 *              loading state and calls refresh().
 *   refresh()  → Promise<StatusDto>: how to get fresh status. Called after every save, by "Check
 *              again", and when no status was given. Default: GET /api/status. A host with a
 *              store can pass `() => store.refresh().then((s) => s.status)`.
 *   onChange(status, change) runs after each save lands, with the fresh status; change is
 *              { what: 'provider' | 'model' | 'byok', provider }.
 *   signal     an AbortSignal; aborting it is destroy().
 *
 * Returns { el, update(status), settled(), destroy() }. update(status) re-renders from a status
 * the host already has (typing in the form and the last test result are kept). settled() →
 * Promise<boolean> waits for the saves already sent (a model typed just before the host moves
 * on is saved when the field loses focus) and says whether they all landed. destroy() aborts
 * reads and the probe and empties `root`; a save already sent still lands. The panel loads
 * css/views/setup.css itself when the page hasn't.
 */
export function agentPanel(root, ctx = {}) {
  ensureStylesheet();
  const uid = `ap-${++apUid}`;
  const ctl = new AbortController();
  const { signal } = ctl;
  const refresh = typeof ctx.refresh === 'function' ? ctx.refresh : () => api.get('/api/status', { signal });

  let status = ctx.status || null;
  let view = status ? status.provider : null; // the card shown as chosen: a CLI kind or 'openai'
  let saving = null; // the CLI kind being saved
  let models = null; // null | { state: 'loading' | 'ready' | 'empty' | 'error', list, message }
  let byokDirty = false;
  let probeFor = null; // the provider the shown test result is about
  let destroyed = false;
  const cards = new Map(); // kind → { el, pick, badgeSlot, cmd }
  // Saves in flight, each → Promise<boolean> (true = it landed). Saves are sent without
  // `signal`: leaving the panel right after one (Continue, a progress link) must not drop it.
  const inflight = new Set();
  const track = (promise) => {
    const p = promise.then(
      (ok) => ok !== false,
      () => false,
    );
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
  const testBox = h('div', { class: 'ap-test', hidden: true }, h('div', { class: 'ap-test-row' }, testBtn, testNote), testResult);

  const details = h('div', { class: 'ap-details', hidden: true }, modelBox, byokForm, testBox);
  const el = h('div', { class: 'ap' }, loading, loadError, grid, recheck_, pickError, details);
  root.replaceChildren(el);

  // ---- Cards ----

  const agentOf = (kind) => ((status && status.agents) || []).find((a) => a.kind === kind) || null;

  function buildCard(kind) {
    const a = agentOf(kind);
    const info = AGENT_INFO[kind] || { desc: '' };
    const name = kind === OWN ? 'Your own model' : (a && a.label) || kind;
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
    if (row.dataset.command === command) return;
    row.dataset.command = command;
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
        const a = agentOf(kind);
        const name = kind === OWN ? 'Your own model' : (a && a.label) || kind;
        const c = cards.get(kind);
        const nameEl = c.el.querySelector('.ap-name');
        if (nameEl.textContent !== name) nameEl.textContent = name;
      }
    }
    for (const kind of kinds) renderCard(kind);
    recheck_.hidden = !(status.agents || []).some((a) => !a.present || !a.authed);
  }

  // ---- Details below the cards ----

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
      if (probeFor !== saved) {
        say(testResult, '');
        probeFor = null;
      }
    }
  }

  function render() {
    if (!status) return;
    loading.hidden = true;
    loadError.hidden = true;
    grid.hidden = false;
    renderCards();
    renderDetails();
  }

  // ---- Actions ----

  async function load() {
    loading.hidden = false;
    loadError.hidden = true;
    grid.hidden = true;
    try {
      const fresh = await refresh();
      if (destroyed) return;
      status = fresh;
      view = status.provider;
      render();
    } catch (err) {
      if (destroyed || aborted(err)) return;
      loading.hidden = true;
      loadError.hidden = false;
      // A stale session: the app's banner explains it, and retrying can't help.
      loadError.replaceChildren(
        h('p', {}, h('strong', {}, "Couldn't load your agents. "), staleSession(err) ? REOPEN : errText(err)),
        staleSession(err) ? null : h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: load }, 'Try again'),
      );
    }
  }

  async function recheck() {
    if (isBusy(recheckBtn)) return;
    const done = busyButton(recheckBtn, 'Checking…');
    try {
      const fresh = await refresh();
      if (destroyed) return;
      status = fresh;
      if (view !== OWN) view = status.provider;
      render();
    } catch (err) {
      if (!destroyed && !aborted(err)) say(pickError, `Couldn't check again: ${errText(err)}`, 'err');
    } finally {
      if (!destroyed) done();
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
    track(saveProvider(kind));
  }

  async function saveProvider(kind) {
    const before = view;
    view = kind;
    saving = kind;
    render();
    let saved = false;
    try {
      await api.post('/api/onboarding/provider', { provider: kind });
      saved = true;
      const fresh = await refresh();
      if (destroyed) return true;
      status = fresh;
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
      say(pickError, saved ? `Switched to ${name}, but couldn't re-check your agents: ${errText(err)}` : `Couldn't switch to ${name}: ${errText(err)}`, 'err');
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
      models = { state: 'error', list: [], message: errText(err) };
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
  // right away does: the step change must not drop this save (see `inflight`).
  function saveModel(value) {
    return track(sendModel(value));
  }

  async function sendModel(value) {
    say(modelStatus, 'Saving…', 'busy');
    let saved = false;
    try {
      await api.post('/api/onboarding/provider', { provider: 'opencode', opencode_model: value });
      saved = true;
      const fresh = await refresh();
      if (destroyed) return true;
      status = fresh;
      render();
      say(modelStatus, value ? 'Model saved' : "Using opencode's default model", 'ok');
      emit('model', 'opencode');
    } catch (err) {
      if (destroyed || aborted(err)) return saved;
      if (saved) {
        say(modelStatus, 'Model saved', 'ok');
      } else {
        modelSelect.setValue((status && status.opencode_model) || '');
        say(modelStatus, `Couldn't save the model: ${errText(err)}`, 'err');
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
    track(sendByok(base));
  }

  async function sendByok(base) {
    say(byokStatus, '');
    const done = busyButton(byokSave, 'Saving…');
    const key = keyInput.value.trim();
    let saved = false;
    try {
      await api.post('/api/onboarding/provider', { provider: OWN, base_url: base, model: modelInput.value.trim(), api_key: key || null });
      saved = true;
      keyInput.value = '';
      byokDirty = false;
      const fresh = await refresh();
      if (destroyed) return true;
      status = fresh;
      view = OWN;
      done();
      render();
      say(byokStatus, 'Saved. coldtrail now uses your own model.', 'ok');
      emit('byok', OWN);
    } catch (err) {
      if (destroyed || aborted(err)) return saved;
      done();
      say(byokStatus, saved ? 'Saved. coldtrail now uses your own model.' : `Couldn't save: ${errText(err)}`, saved ? 'ok' : 'err');
    }
    return saved;
  }

  async function runProbe() {
    if (isBusy(testBtn) || !status) return;
    const provider = status.provider;
    probeFor = provider;
    const done = busyButton(testBtn, 'Testing…');
    say(testResult, 'Running a quick check. This can take up to a minute.', 'busy');
    try {
      const r = await api.post('/api/provider/probe', {}, { signal });
      if (destroyed || probeFor !== provider) return;
      say(testResult, r.message || (r.ok ? 'It answered.' : "It didn't answer."), r.ok ? 'ok' : 'err');
    } catch (err) {
      if (destroyed || aborted(err)) return;
      say(testResult, errText(err), 'err');
    } finally {
      if (!destroyed) done();
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    ctl.abort();
    for (const c of cards.values()) {
      const btn = c.cmd.querySelector('.ap-copy');
      if (btn) clearTimeout(btn._t);
    }
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
    destroy,
  };
}

// ---- The Setup screen ----

let current = null; // the mounted screen's { update(ctx) }

function brand() {
  return h(
    'span',
    { class: 'setup-brand' },
    h(
      'svg',
      { viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { d: 'M3 17l5-5 4 3 8-9' }),
      h('circle', { cx: '20', cy: '6', r: '1.5' }),
    ),
    h('span', {}, 'coldtrail'),
  );
}

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
  const page = h(
    'div',
    { class: 'setup' },
    h('header', { class: 'setup-top' }, brand(), h('span', { class: 'setup-top-sep', 'aria-hidden': 'true' }), h('h1', { class: 'setup-h1' }, 'Setup')),
    h('div', { class: 'setup-body' }, progress, main),
  );
  root.replaceChildren(page);

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

  // Point the address at the step shown, through the router so it remembers the new hash (a
  // later visit to the same address is then a real change). The router hands the new address
  // straight back to update(), which leaves it to the show() already under way.
  let rewriting = false;
  function setAddress(id) {
    const to = href(['setup', id]);
    if (location.hash === to) return;
    rewriting = true;
    try {
      Promise.resolve(nav.navigate(to, { replace: true })).catch((err) => console.error(err));
    } finally {
      rewriting = false;
    }
  }

  async function fetchStatus() {
    status = await api.get('/api/status', { signal: viewCtl.signal });
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

  function renderLoadError(err) {
    progress.hidden = true;
    // A stale session: the app's banner above says what happened (once, as the alert), and
    // retrying can't work until the tab is reopened, so the card only points at the fix.
    const stale = staleSession(err);
    const retry = stale ? null : h('div', { class: 'setup-error-actions' }, h('button', { type: 'button', class: 'btn btn-secondary', onClick: load }, 'Try again'));
    main.replaceChildren(
      h(
        'section',
        { class: ['setup-card', 'setup-error', stale && 'is-stale'] },
        h(
          'div',
          { class: 'setup-error-body', role: stale ? null : 'alert' },
          icon('alert', 20),
          h('div', {}, h('h2', { class: 'setup-error-title' }, "Setup couldn't load"), h('p', {}, stale ? REOPEN : errText(err))),
        ),
        retry,
      ),
    );
  }

  async function load() {
    renderLoading();
    try {
      await fetchStatus();
    } catch (err) {
      if (aborted(err)) return;
      renderLoadError(err);
      return;
    }
    step = null;
    show(requested);
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
      { class: 'setup-card', 'aria-labelledby': 'setup-title' },
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
      if (!sc.api) return { ok: false, reason: "" };
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
      const done = busyButton(next, 'Continue');
      try {
        if (sc.api.beforeContinue && !(await sc.api.beforeContinue())) return;
        if (scope !== sc) return;
        go(i + 1 < STEPS.length ? STEPS[i + 1].id : 'done');
      } finally {
        busy = false;
        if (next.isConnected) done();
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
    });
    const reason = 'Choose an installed agent, or save your own model, to continue.';
    return {
      gate: () => (providerReady(status) ? { ok: true } : { ok: false, reason }),
      // A model typed just before Continue was sent when the field lost focus: let it land
      // (and stop here if it didn't, while its error is still on screen).
      async beforeContinue() {
        if (!(await panel.settled())) {
          step_.showError("Your agent change didn't save. See the message above.");
          return false;
        }
        if (!providerReady(status)) {
          step_.showError(reason);
          return false;
        }
        return true;
      },
      onStatus: () => {
        panel.update(status);
        step_.gate();
      },
    };
  }

  // ---- Step 2: Canonical ----

  function canonicalStep(content, sc, step_) {
    const badgeSlot = h('span', { class: 'setup-conn-state' });
    const btn = h('button', { type: 'button', class: 'btn', onClick: connect });
    const msg = h('p', { class: 'setup-msg', role: 'status' });
    const note = h('p', { class: 'setup-conn-note' });
    content.append(
      h(
        'section',
        { class: 'setup-conn', 'aria-labelledby': 'setup-canonical-title' },
        connHead('search', 'setup-canonical-title', 'Canonical', note, badgeSlot),
        h('div', { class: 'setup-conn-body' }, h('div', { class: 'setup-row' }, btn), msg),
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
    }

    async function connect() {
      if (isBusy(btn)) return;
      const done = busyButton(btn, 'Waiting for approval…');
      say(msg, "Approve coldtrail in the browser tab that opened. This page updates when you're done.", 'busy');
      try {
        const r = await api.post('/api/discovery/canonical/connect', {}, { signal: sc.ctl.signal });
        done();
        if (r && r.ok === false) {
          say(msg, r.message || "Couldn't connect to Canonical.", 'err');
        } else {
          local.canonical = true;
          say(msg, 'Canonical is connected.', 'ok');
          await refreshStatus().catch(() => {});
        }
      } catch (err) {
        if (aborted(err)) return;
        done();
        say(msg, errText(err), 'err');
      }
      render();
      renderProgress();
      step_.gate();
    }

    render();
    return {
      gate: () => (canonicalOn() ? { ok: true } : { ok: false, reason: 'Connect Canonical to continue.' }),
      onStatus: () => {
        render();
        step_.gate();
      },
    };
  }

  // ---- Step 3: company profile ----

  function companyStep(content, sc, step_) {
    const saveState = h('span', { class: 'setup-save', role: 'status' });
    const area = h('textarea', {
      id: 'setup-profile',
      class: 'input setup-profile',
      spellcheck: 'false',
      rows: '18',
      'aria-describedby': 'setup-profile-hint',
    });
    const hint = h('p', { class: 'field-hint', id: 'setup-profile-hint' }, 'Markdown. It saves as you type; refine it any time under Company profile.');
    const loadingEl = h(
      'div',
      { class: 'setup-profile-loading', role: 'status' },
      h('span', { class: 'sr-only' }, 'Loading your profile…'),
      [0, 1, 2, 3, 4].map(() => h('span', { class: 'skeleton setup-sk setup-sk-line', 'aria-hidden': 'true' })),
    );
    const errorEl = h('div', { class: 'setup-inline-error', role: 'alert', hidden: true });
    const editor = h(
      'div',
      { class: 'field setup-profile-field', hidden: true },
      h('div', { class: 'setup-profile-head' }, h('label', { class: 'field-label', for: 'setup-profile' }, 'Company profile'), saveState),
      area,
      hint,
    );
    content.append(loadingEl, errorEl, editor);

    let loaded = false;
    let loadFailed = false;
    let saveError = null;
    let inflight = null;
    let savedDoc = null; // the text product.md holds, as far as this page knows

    function setSave(state, text = '') {
      saveState.dataset.state = state;
      if (state === 'saving') saveState.textContent = 'Saving…';
      else if (state === 'saved') saveState.textContent = 'Saved';
      else if (state === 'error') saveState.textContent = `Couldn't save: ${text}`;
      else saveState.textContent = text;
    }

    function persist(doc) {
      setSave('saving');
      const p = api.post('/api/company', { doc }).then(
        () => {
          if (inflight === p) {
            savedDoc = doc;
            saveError = null;
            setSave('saved');
            step_.gate();
          }
        },
        (err) => {
          saveError = err;
          setSave('error', errText(err));
        },
      );
      inflight = p;
      return p;
    }
    const save = debounce(() => persist(area.value), PROFILE_SAVE_MS);

    async function flush() {
      const pending = save.flush();
      await (pending || inflight);
      return !saveError;
    }

    area.addEventListener('input', () => {
      saveError = null;
      setSave('pending', 'Unsaved changes');
      save();
      step_.gate();
    });
    // Leaving the step (or the screen) saves a pending edit first.
    sc.cleanups.push(() => save.flush());

    async function loadDoc() {
      loadingEl.hidden = false;
      errorEl.hidden = true;
      editor.hidden = true;
      loadFailed = false;
      step_.gate();
      try {
        const r = await api.get('/api/company', { signal: sc.ctl.signal });
        const doc = (r && r.doc) || '';
        savedDoc = doc;
        area.value = doc.trim() ? doc : PROFILE_TEMPLATE;
        setSave('', doc.trim() ? '' : 'Fill in the template');
        loaded = true;
        loadingEl.hidden = true;
        editor.hidden = false;
      } catch (err) {
        if (aborted(err)) return;
        loadFailed = true;
        loadingEl.hidden = true;
        errorEl.hidden = false;
        // A stale session: the app's banner explains it, and retrying can't help.
        errorEl.replaceChildren(
          icon('alert', 16),
          h('p', {}, `Couldn't load your profile: ${staleSession(err) ? REOPEN : errText(err)}`),
          staleSession(err) ? null : h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: loadDoc }, 'Try again'),
        );
      }
      step_.gate();
    }
    loadDoc();

    return {
      gate() {
        if (loadFailed) return { ok: false, reason: "Your profile didn't load. Try again above." };
        if (!loaded) return { ok: false, reason: 'Loading your profile…' };
        if (!area.value.trim()) return { ok: false, reason: 'Write a few lines about your company to continue.' };
        if (area.value === PROFILE_TEMPLATE) {
          // The untouched template doesn't count, unless it's what product.md now holds (typed
          // into and undone): the workspace then counts it as set, so Continue must agree.
          if (savedDoc !== PROFILE_TEMPLATE) return { ok: false, reason: "Fill in the template with your company's details to continue." };
          return { ok: true, note: "This is still the blank template. Drafts stay generic until you fill it in." };
        }
        return { ok: true };
      },
      async beforeContinue() {
        if (!(await flush())) {
          step_.showError(`Couldn't save your profile: ${errText(saveError)}`);
          return false;
        }
        try {
          await fetchStatus();
        } catch (err) {
          if (aborted(err)) return false;
          step_.showError(errText(err));
          return false;
        }
        renderProgress();
        if (!status.product_set) {
          step_.showError("Your profile didn't save. Try again.");
          return false;
        }
        return true;
      },
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

  function gmailCard(sc, onChange) {
    const badgeSlot = h('span', { class: 'setup-conn-state' });
    const note = h('p', { class: 'setup-conn-note' });
    const msg = h('p', { class: 'setup-msg', role: 'status' });

    const email = textField('setup-gmail-email', 'Gmail address', { type: 'email', autocomplete: 'email', placeholder: 'you@gmail.com' });
    const pw = textField('setup-gmail-pw', 'App password', { type: 'password', placeholder: '16 characters, spaces are fine' });
    const apBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Connect Gmail');
    const apForm = h(
      'form',
      { class: 'setup-form', novalidate: true, 'aria-label': 'Connect Gmail with an app password', onSubmit: connectAppPassword },
      h('div', { class: 'setup-fields' }, email.el, pw.el),
      h('div', { class: 'setup-row' }, apBtn),
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
    const googleBlock = h('div', { class: 'setup-more-block' }, h('p', {}, 'Sign in with Google instead of an app password.'), h('div', { class: 'setup-row' }, googleBtn));
    const clientId = textField('setup-gmail-client-id', 'Client ID', { type: 'text', placeholder: '….apps.googleusercontent.com' });
    const clientSecret = textField('setup-gmail-client-secret', 'Client secret', { type: 'password', placeholder: 'GOCSPX-…' });
    const byoBtn = h('button', { type: 'submit', class: 'btn btn-secondary' }, 'Save and connect');
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
      h('div', { class: 'setup-row' }, byoBtn),
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

    let shownOn = null;
    function render() {
      const on = gmailOn();
      badgeSlot.replaceChildren(on ? badge('Connected', 'ok') : badge('Not connected'));
      googleBlock.hidden = !status.gmail_client_configured;
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

    function invalid(input, on) {
      if (on) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }

    async function connected(text) {
      local.gmail = true;
      say(msg, text, 'ok');
      await refreshStatus().catch(() => {});
      render();
      onChange();
      // The form that had focus folded away under "Use different credentials": land on the card.
      const at = document.activeElement;
      if (!el.contains(at) || at.closest('details:not([open])')) el.querySelector('.setup-conn-title').focus({ preventScroll: true });
    }

    async function connectAppPassword(e) {
      e.preventDefault();
      if (isBusy(apBtn)) return;
      const addr = email.input.value.trim();
      const pass = pw.input.value.trim();
      invalid(email.input, !addr);
      invalid(pw.input, !pass);
      if (!addr || !pass) {
        say(msg, 'Enter your Gmail address and the app password.', 'err');
        (addr ? pw.input : email.input).focus();
        return;
      }
      const done = busyButton(apBtn, 'Checking…');
      say(msg, 'Checking the app password with Gmail…', 'busy');
      try {
        const r = await api.post('/api/destination/gmail/app-password', { email: addr, app_password: pass }, { signal: sc.ctl.signal });
        done();
        if (r && r.ok === false) {
          say(msg, r.message || "Couldn't connect Gmail.", 'err');
          return;
        }
        pw.input.value = '';
        await connected('Gmail is connected.');
      } catch (err) {
        if (aborted(err)) return;
        done();
        say(msg, errText(err), 'err');
      }
    }

    async function oauth(btn) {
      const done = busyButton(btn, 'Waiting for Google…');
      say(msg, "Approve coldtrail in the Google tab that opened. This page updates when you're done.", 'busy');
      try {
        const r = await api.post('/api/destination/gmail/connect', { callback_port: 8765 }, { signal: sc.ctl.signal });
        done();
        if (r && r.ok === false) {
          say(msg, r.message || "Couldn't connect Gmail.", 'err');
          return;
        }
        await connected('Gmail is connected.');
      } catch (err) {
        if (aborted(err)) return;
        done();
        say(msg, errText(err), 'err');
      }
    }

    function connectGoogle() {
      if (!isBusy(googleBtn)) oauth(googleBtn);
    }

    async function connectOwnClient(e) {
      e.preventDefault();
      if (isBusy(byoBtn)) return;
      const id = clientId.input.value.trim();
      invalid(clientId.input, !id);
      if (!id) {
        say(msg, 'Paste your client ID first.', 'err');
        clientId.input.focus();
        return;
      }
      const done = busyButton(byoBtn, 'Saving…');
      try {
        await api.post('/api/destination/gmail/client', { client_id: id, client_secret: clientSecret.input.value.trim() }, { signal: sc.ctl.signal });
      } catch (err) {
        if (aborted(err)) return;
        done();
        say(msg, errText(err), 'err');
        return;
      }
      done();
      await oauth(byoBtn);
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
    let phase = 'idle'; // idle | starting | waiting
    let timer = null;
    let pollSeq = 0;
    let restore = null;

    function render() {
      const on = linkedinOn();
      const reconnect = !on && status.linkedin_reconnect_needed;
      if (phase === 'waiting') badgeSlot.replaceChildren(badge('Waiting for sign-in', 'accent'));
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
      row.hidden = (on && phase === 'idle') || phase === 'waiting';
      if (phase === 'idle' && !isBusy(btn)) btn.textContent = reconnect ? 'Reconnect LinkedIn' : 'Connect LinkedIn';
    }

    function stop() {
      pollSeq++;
      clearTimeout(timer);
      timer = null;
    }

    function finish() {
      stop();
      phase = 'idle';
      if (restore) {
        restore();
        restore = null;
      }
    }

    function schedule(seq) {
      timer = setTimeout(() => tick(seq), LINKEDIN_POLL_MS);
    }

    async function tick(seq) {
      let s;
      try {
        s = await api.get('/api/destination/linkedin/status', { signal: sc.ctl.signal });
      } catch (err) {
        if (aborted(err) || seq !== pollSeq) return;
        schedule(seq); // a hiccup: try again next tick
        return;
      }
      if (seq !== pollSeq) return;
      if (s.connected && !s.reconnect_needed) {
        finish();
        local.linkedin = true;
        say(msg, 'LinkedIn is connected.', 'ok');
        render();
        onChange();
        refreshStatus().catch(() => {});
      } else if (!s.waiting) {
        finish();
        say(msg, "LinkedIn sign-in didn't finish: the window was closed or it timed out. Try again.", 'err');
        render();
      } else {
        schedule(seq);
      }
    }

    async function connect() {
      if (phase !== 'idle' || isBusy(btn)) return;
      phase = 'starting';
      restore = busyButton(btn, 'Opening Chrome…');
      say(msg, '');
      try {
        const r = await api.post('/api/destination/linkedin/connect', {}, { signal: sc.ctl.signal });
        if (r && r.status === 'busy') {
          finish();
          say(msg, 'Chrome is busy with another LinkedIn task. Try again in a moment.', 'err');
          render();
          return;
        }
        phase = 'waiting';
        restore();
        restore = null;
        say(msg, "Sign in to LinkedIn in the Chrome window that opened. This page updates when you're done.", 'busy');
        // The button hides while waiting: keep keyboard focus on the card.
        const hadFocus = document.activeElement === btn;
        render();
        if (hadFocus) el.querySelector('.setup-conn-title').focus({ preventScroll: true });
        stop();
        schedule(pollSeq);
      } catch (err) {
        if (aborted(err)) return;
        finish();
        say(msg, errText(err), 'err');
        render();
      }
    }

    sc.cleanups.push(stop);
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
    };
  }

  // ---- Finish ----

  function doneScreen(sc) {
    const homeBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: goHome }, 'Go to Home', icon('arrow', 16));
    const back = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => go('destination') }, 'Back');
    const destOn = gmailOn() || linkedinOn();
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
      busyButton(homeBtn, 'Go to Home');
      if (store) await store.refresh();
      if (scope !== sc) return;
      nav.navigate('#/home');
    }
    return h(
      'section',
      { class: 'setup-card setup-done', 'aria-labelledby': 'setup-title' },
      h(
        'div',
        { class: 'setup-card-main' },
        h('span', { class: 'setup-done-mark', 'aria-hidden': 'true' }, icon('check', 22)),
        h('h2', { class: 'setup-title', id: 'setup-title', tabindex: '-1' }, "You're set"),
        h('p', { class: 'setup-desc' }, 'coldtrail is ready to find companies and write drafts. Two good first steps:'),
        h(
          'ul',
          { class: 'setup-next' },
          nextItem(
            href(['agent'], { prompt: STARTER_PROMPT }),
            'chat',
            'Find your first companies',
            'Open the agent with a starter request filled in. Nothing runs until you send it.',
          ),
          nextItem('#/schedules', 'clock', 'Create a schedule', 'Run the agent every day or week so new companies and drafts are waiting for you.'),
        ),
        destOn
          ? null
          : h(
              'p',
              { class: 'setup-note' },
              "Gmail and LinkedIn aren't connected yet. Connect them any time in ",
              h('a', { href: '#/settings?tab=connections' }, 'Settings → Connections'),
              '.',
            ),
      ),
      h('div', { class: 'setup-foot' }, h('div', { class: 'setup-foot-start' }, back), h('div', { class: 'setup-foot-end' }, homeBtn)),
    );
  }

  // ---- Start ----

  const instance = {
    update(next) {
      if (next.path[0] !== 'setup') return false;
      // setAddress() fixing the address for the step being shown: keep what was asked for.
      if (rewriting) return true;
      requested = next.path[1] || '';
      if (status) show(requested, { focus: true });
      return true;
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
    viewCtl.abort();
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
};

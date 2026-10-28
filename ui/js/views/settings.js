// Settings (spec §5.9) at #/settings?tab=agent|connections|sending|enrichment|appearance.
//
//   agent        Setup's agentPanel: the agent cards, opencode's model, your own model, Test
//                connection (one module, so both screens behave the same), plus a warning when
//                the saved opencode model is no longer one opencode offers (every run would fail)
//   connections  Canonical (coldtrail's own OAuth), Gmail (app password first; Google sign-in
//                and your own OAuth client under "More options"), LinkedIn (connect, reconnect,
//                disconnect, and the poll that follows a sign-in in Chrome)
//   sending      email and LinkedIn auto-send: switches that ask before turning ON (never before
//                OFF), caps that save on Enter or when the field is left (asking first when a cap
//                goes up while auto-send is on; a raise nobody could confirm because the screen
//                was going isn't saved, and a toast says so), today's usage, and a line saying
//                what actually happens with the current setting
//   enrichment   the OSINT installers (theHarvester, SpiderFoot) with what each still needs
//   appearance   System / Light / Dark through core/theme.js (kept in this browser)
//
// Every tab but Appearance reads /api/status: the store's copy when it has one (refreshed at
// once, since it can be 30s old), else its own request, with loading and error states. Saves,
// connects and installs are sent without the view's AbortSignal, so leaving the screen never
// drops one (Canonical and Google sign-in hold their request open until the browser approval
// comes back); reads, the probe and the LinkedIn poll stop on unmount. Leaving waits briefly
// (router beforeLeave) for switch, cap and model saves, so the next screen sees them.
// Everything dynamic reaches the DOM through h() (text nodes); nothing here parses HTML.

import { api, errorText, isStaleSession } from '../core/api.js';
import { debounce, fmtNum, h } from '../core/dom.js';
import { ensureViewCss, href } from '../core/router.js';
import { getThemePref, setThemePref } from '../core/theme.js';
import { confirmDialog, isBusy, setBusy, toast } from '../core/ui.js';
import { badge } from '../components/badge.js';
import { switchEl } from '../components/switch.js';
import { tabs } from '../components/tabs.js';
import { agentPanel } from './setup.js';

const TITLE = 'Settings';
const TABS = [
  { id: 'agent', label: 'Agent' },
  { id: 'connections', label: 'Connections' },
  { id: 'sending', label: 'Sending' },
  { id: 'enrichment', label: 'Enrichment' },
  { id: 'appearance', label: 'Appearance' },
];
const TAB_DESC = {
  agent: 'The AI agent coldtrail drives to find companies, look up the right people and write your drafts.',
  connections: 'Where companies come from and where your outreach goes.',
  sending: 'What coldtrail may send without asking you first, and how much a day.',
  enrichment: "Optional tools the agent uses to find people's email addresses. Without them it uses coldtrail's built-in web finder.",
  appearance: 'How coldtrail looks in this browser.',
};
const DEFAULT_TAB = 'agent';
const tabOf = (query) => (TABS.some((t) => t.id === query.tab) ? query.tab : DEFAULT_TAB);

const LINKEDIN_POLL_MS = 2000;
const CAP_SAVE_MS = 300;
const CAP_MIN = 1;
const CAP_MAX = 500;
const SENDING_TAB = href(['settings'], { tab: 'sending' });
const CONNECTIONS_TAB = href(['settings'], { tab: 'connections' });

// ---- Small helpers ----

const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7',
  alert: ['M12 3l9.5 17h-19L12 3z', 'M12 10v4', 'M12 17.5v.01'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-3.5-3.5'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  person: ['M15 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20', 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19 8v6', 'M22 11h-6'],
  tool: ['M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-2-2 1.5-1.5a4 4 0 0 1-5-5L6 11l-2-2 8-8 2 2z'],
  scan: ['M4 8V5a1 1 0 0 1 1-1h3', 'M16 4h3a1 1 0 0 1 1 1v3', 'M20 16v3a1 1 0 0 1-1 1h-3', 'M8 20H5a1 1 0 0 1-1-1v-3', 'M11 16a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M14.5 14.5L17 17'],
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

/** One line into a live region that stays in the DOM: tone '' | 'ok' | 'err' | 'busy'; '' clears. */
function say(el, text, tone = '') {
  el.dataset.tone = text ? tone : '';
  if (!text) {
    el.replaceChildren();
    return;
  }
  const mark =
    tone === 'ok'
      ? icon('check', 14)
      : tone === 'err'
        ? icon('alert', 14)
        : tone === 'busy'
          ? h('span', { class: 'spinner', 'aria-hidden': 'true' })
          : null;
  el.replaceChildren(...(mark ? [mark] : []), h('span', {}, String(text)));
}

const aborted = (err) => !!err && err.name === 'AbortError';

function extLink(url, text) {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);
}

let uid = 0;

// ---- The screen ----

let active = null; // the mounted screen: { stay(query), beforeLeave() }

function mountSettings(root, ctx) {
  const id = `st-${++uid}`;
  const ctl = new AbortController();
  const { signal } = ctl;
  const store = ctx.store || null;
  const nav = ctx.nav;

  let status = (store && store.get().status) || null;
  let loadError = null; // the error of the last failed status read, while there is no status
  let loading = false;
  let saving = 0; // saves in flight: the store's periodic copy may predate them, so it waits
  let tab = tabOf(ctx.query);
  let gone = false;
  // The router asked to leave: nothing new may ask a question now. Cleared when the route change
  // was overtaken and the screen stays (update(), e.g. Back while the leave was still waiting).
  let leaving = false;
  // Connections a response confirmed this session, in case status lags behind (or, for an
  // intercepted or failed re-read, never catches up). null = trust status.
  const local = { canonical: null, gmail: null, linkedin: null };
  // tab id → { el, built: null | { update(), destroy?(), flush?(), settled?() } }
  const panes = new Map();
  // Switch and cap saves (each with its status re-read) that leaving the screen waits for.
  const pending = new Set();
  const track = (promise) => {
    const settled = Promise.resolve(promise).then(
      () => {},
      () => {},
    );
    pending.add(settled);
    settled.then(() => pending.delete(settled));
    return promise;
  };

  // The Agent tab is Setup's panel, styled by setup.css: start loading it now, whatever the tab.
  const setupCss = ensureViewCss('setup');

  // ---- Page frame ----

  const panelId = `${id}-panel`;
  const tabList = tabs({
    items: TABS,
    active: tab,
    label: 'Settings sections',
    panelId,
    onChange: (t) => nav.setQuery({ tab: t }),
  });
  const desc = h('p', { class: 'page-desc' });
  const panel = h('div', { class: 'st-panel', id: panelId, role: 'tabpanel' });
  for (const t of TABS) {
    const el = h('div', { class: 'st-pane', 'data-tab': t.id, hidden: true });
    panes.set(t.id, { el, built: null });
    panel.append(el);
  }
  const tabsWrap = h('div', { class: 'st-tabs' }, tabList);
  root.append(
    h(
      'div',
      { class: 'settings' },
      h(
        'header',
        { class: 'page-head' },
        h('div', { class: 'page-head-text' }, h('h1', {}, TITLE), desc),
        h('div', { class: 'page-actions' }, h('a', { class: 'btn btn-secondary', href: '#/setup' }, 'Run guided setup')),
      ),
      tabsWrap,
      panel,
    ),
  );

  // On a phone the five tabs scroll sideways: tabs() keeps the chosen one in view and fades the
  // edge with more (data-more on the list).

  // ---- Status ----

  const canonicalOn = () => (local.canonical != null ? local.canonical : !!(status && status.discovery_connected));
  const gmailOn = () => (local.gmail != null ? local.gmail : !!(status && status.destination_connected));
  const linkedinOn = () =>
    local.linkedin != null ? local.linkedin : !!(status && status.linkedin_connected && !status.linkedin_reconnect_needed);
  const linkedinReconnect = () => local.linkedin == null && !!(status && status.linkedin_reconnect_needed);

  /** Take a new status: every built tab re-renders (typed values are kept), the shown one builds. */
  function apply(next, { except = null } = {}) {
    if (!next || gone) return;
    status = next;
    loadError = null;
    for (const [t, p] of panes) {
      if (p.built && p.built !== except && p.built.update) p.built.update();
      else if (!p.built && t === tab) showPane(t);
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    loadError = null;
    showPane(tab);
    try {
      apply(await api.get('/api/status', { signal }));
    } catch (err) {
      if (aborted(err) || gone) return;
      if (!status) loadError = err;
    } finally {
      loading = false;
    }
    if (!gone) showPane(tab);
  }

  /**
   * Refresh the store's copy (the sidebar's dots and counts, and the next screen) without waiting
   * for it: nothing on this screen does, but leaving does (track). Its status is no newer than
   * the one just applied, so the screen ignores the store meanwhile (saving).
   */
  function refreshStore() {
    if (!store) return;
    saving++;
    track(Promise.resolve(store.refresh()).finally(() => saving--));
  }

  /** Re-read status after a change, then refresh the store. Never throws: a failed re-read keeps what is shown. */
  async function sync({ except = null } = {}) {
    try {
      const fresh = await api.get('/api/status', { signal });
      apply(fresh, { except });
      refreshStore();
      return fresh;
    } catch (err) {
      if (!aborted(err) && !gone) console.warn('settings: status re-read failed', err);
      return null;
    }
  }

  /** Run a save: the store's periodic copy is ignored while it is in flight. */
  async function saveWith(fn) {
    saving++;
    try {
      return await fn();
    } finally {
      saving--;
    }
  }

  const unsubscribe = store
    ? store.subscribe((snap) => {
        if (snap.status && !saving) apply(snap.status);
      })
    : () => {};

  // ---- Tabs ----

  function setTab(t) {
    tab = t;
    tabList.setActive(t);
    desc.textContent = TAB_DESC[t];
    const btn = tabList.querySelector(`[data-id="${t}"]`);
    if (btn) panel.setAttribute('aria-labelledby', btn.id);
    for (const [k, p] of panes) p.el.hidden = k !== t;
    showPane(t);
  }

  function showPane(t) {
    const p = panes.get(t);
    if (!p || p.built) return;
    if (t !== 'appearance' && !status) {
      p.el.replaceChildren(loading || !loadError ? loadingState() : errorState(loadError));
      return;
    }
    const builders = { agent: buildAgent, connections: buildConnections, sending: buildSending, enrichment: buildEnrichment, appearance: buildAppearance };
    p.el.replaceChildren();
    p.built = builders[t](p.el);
  }

  function loadingState() {
    return h(
      'div',
      { class: 'st-loading', role: 'status' },
      h('span', { class: 'sr-only' }, 'Loading your settings…'),
      [0, 1, 2].map(() =>
        h(
          'div',
          { class: 'st-card st-skeleton-card', 'aria-hidden': 'true' },
          h('span', { class: 'skeleton st-sk-icon' }),
          h('span', { class: 'st-sk-lines' }, h('span', { class: 'skeleton st-sk-title' }), h('span', { class: 'skeleton st-sk-line' })),
        ),
      ),
    );
  }

  function errorState(err) {
    // A stale session: the app's banner says what happened (once, as the alert), and retrying
    // can't work until the tab is reopened, so this only points at the fix.
    const stale = isStaleSession(err);
    return h(
      'div',
      { class: ['st-load-error', stale && 'is-stale'], role: stale ? null : 'alert' },
      icon('alert', 18),
      h('div', { class: 'st-load-error-text' }, h('p', { class: 'st-load-error-title' }, "Couldn't load your settings"), h('p', {}, errorText(err))),
      stale ? null : h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: load }, 'Try again'),
    );
  }

  // ---- A card: icon, title + state badge, note, body, message ----

  function card({ key, iconName, iconNode = null, title }) {
    const titleId = `${id}-${key}-title`;
    const badgeSlot = h('span', { class: 'st-card-state' });
    const note = h('p', { class: 'st-card-note' });
    const body = h('div', { class: 'st-card-body' });
    const msg = h('p', { class: 'st-msg', role: 'status' });
    const el = h(
      'section',
      { class: 'st-card', 'aria-labelledby': titleId, 'data-card': key },
      h(
        'div',
        { class: 'st-card-head' },
        h('span', { class: 'st-card-icon' }, iconNode || icon(iconName, 18)),
        h(
          'div',
          { class: 'st-card-text' },
          h('div', { class: 'st-card-titlerow' }, h('h2', { class: 'st-card-title', id: titleId, tabindex: '-1' }, title), badgeSlot),
          note,
        ),
      ),
      body,
      msg,
    );
    const focusTitle = () => el.querySelector('.st-card-title').focus({ preventScroll: true });
    return { el, badgeSlot, note, body, msg, focusTitle, titleId };
  }

  // ---- Agent ----

  function buildAgent(el) {
    const box = h('div', { class: 'st-agent' }, loadingState());
    el.append(box);
    let panelApi = null;
    // What `opencode models` offers: null (not known yet), 'loading', or the list ([] when it
    // couldn't be read: then nothing is known, and nothing is said).
    let offered = null;
    let watching = false; // the list comes from the panel's picker (watchList), not a request here
    const warnId = `${id}-model-warn`;
    const warn = h('p', { class: 'st-notice st-model-warn', id: warnId, hidden: true });

    const built = {
      update: () => {
        if (panelApi) panelApi.update(status);
        checkModel();
      },
      destroy: () => {
        if (panelApi) panelApi.destroy();
      },
      // Model and provider saves the panel has sent (it saves without the view's signal).
      settled: () => (panelApi ? panelApi.settled() : Promise.resolve(true)),
    };

    // The panel draws itself once setup.css is in (usually already, so no skeleton flashes).
    setupCss.then(() => {
      if (gone || panes.get('agent').built !== built) return;
      panelApi = agentPanel(box, {
        status,
        signal,
        // A save inside the panel re-reads status; everything else on the screen follows. The
        // panel confirms the save once this returns, so the store refresh isn't waited for.
        refresh: async () => {
          saving++;
          try {
            const fresh = await api.get('/api/status', { signal });
            apply(fresh, { except: built });
            checkModel();
            refreshStore();
            return fresh;
          } finally {
            saving--;
          }
        },
      });
      watching = watchList();
      placeWarning();
      checkModel();
    });

    // The warning sits under the model picker (inside the panel's model box, so it shows and
    // hides with it) and is read with the field. Without that box, it goes above the panel.
    function placeWarning() {
      const modelBox = box.querySelector('.ap-model');
      const picker = modelBox && modelBox.querySelector('.search-select');
      if (picker) picker.after(warn);
      else if (modelBox) modelBox.append(warn);
      else box.before(warn);
      const input = modelBox && modelBox.querySelector('input');
      if (input) {
        const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
        if (!ids.includes(warnId)) input.setAttribute('aria-describedby', [warnId, ...ids].join(' '));
      }
    }

    // The panel loads the list for its picker (GET /api/provider/opencode/models) whenever the
    // saved provider is opencode. The check reads it from there, through the picker's own
    // setOptions, so it never asks a second time (each ask can start an `opencode models` run on
    // the server). Without that picker it asks itself (loadOffered).
    function watchList() {
      const picker = box.querySelector('.ap-model .search-select');
      if (!picker || typeof picker.setOptions !== 'function') return false;
      const setOptions = picker.setOptions;
      picker.setOptions = (list) => {
        setOptions(list);
        offered = (list || []).map((o) => String(o && typeof o === 'object' ? o.value : o)).filter(Boolean);
        if (!gone) checkModel();
      };
      return true;
    }

    async function loadOffered() {
      offered = 'loading';
      let list = [];
      try {
        const r = await api.get('/api/provider/opencode/models', { signal });
        list = Array.isArray(r && r.models) ? r.models.map(String) : [];
      } catch (err) {
        if (aborted(err) || gone) return;
      }
      offered = list;
      if (!gone) checkModel();
    }

    // A saved model that opencode no longer lists (it retired it, or it was mistyped) makes every
    // opencode run fail, chats and schedules alike, so it is called out by the picker.
    function checkModel() {
      if (!panelApi) return; // the panel (and its list) isn't up yet
      const model = status && status.provider === 'opencode' ? String(status.opencode_model || '').trim() : '';
      if (model && offered == null && !watching) loadOffered();
      const retired = !!model && Array.isArray(offered) && offered.length > 0 && !offered.includes(model);
      warn.hidden = !retired;
      if (!retired) {
        // Emptied too: the picker's description reads this element even while it's hidden.
        warn.replaceChildren();
        return;
      }
      warn.replaceChildren(
        icon('alert', 14),
        h(
          'span',
          { class: 'st-notice-text' },
          h('span', { class: 'st-notice-lead' }, h('span', { class: 'mono' }, model), " isn't offered by opencode anymore — pick another model."),
          ' ',
          h('span', {}, 'Chats and scheduled runs fail until you do.'),
        ),
      );
    }

    return built;
  }

  // ---- Connections ----

  function buildConnections(el) {
    const canonical = canonicalCard();
    const gmail = gmailCard();
    const linkedin = linkedinCard();
    el.append(h('div', { class: 'st-stack' }, canonical.el, gmail.el, linkedin.el));
    const update = () => {
      canonical.render();
      gmail.render();
      linkedin.render();
    };
    update();
    return { update, destroy: () => linkedin.stop() };
  }

  function canonicalCard() {
    const c = card({ key: 'canonical', iconName: 'search', title: 'Canonical' });
    const btn = h('button', { type: 'button', class: 'btn', onClick: connect });
    c.body.append(h('div', { class: 'st-row' }, btn));

    function render() {
      const on = canonicalOn();
      c.badgeSlot.replaceChildren(on ? badge('Connected', 'ok') : badge('Not connected'));
      c.note.textContent = on
        ? 'coldtrail searches Canonical for companies that match your searches.'
        : "coldtrail finds companies through Canonical. Connecting opens Canonical's consent page in your browser.";
      if (!isBusy(btn)) {
        btn.className = on ? 'btn btn-secondary' : 'btn btn-primary';
        btn.textContent = on ? 'Reconnect' : 'Connect Canonical';
      }
    }

    async function connect() {
      if (isBusy(btn)) return;
      setBusy(btn, true, { label: 'Waiting for approval…' });
      say(c.msg, "Approve coldtrail in the browser tab that opened. This page updates when you're done.", 'busy');
      await saveWith(async () => {
        try {
          // No signal: the server holds this request open for the whole browser approval, and
          // dropping it would stop the callback listener the approval comes back to.
          const r = await api.post('/api/discovery/canonical/connect', {});
          if (gone) return;
          setBusy(btn, false);
          if (r && r.ok === false) {
            say(c.msg, r.message || "Couldn't connect to Canonical.", 'err');
          } else {
            local.canonical = true;
            say(c.msg, 'Canonical is connected.', 'ok');
          }
        } catch (err) {
          if (gone) return;
          setBusy(btn, false);
          say(c.msg, errorText(err), 'err');
        }
      });
      if (gone) return;
      render();
      await sync();
    }

    return { el: c.el, render };
  }

  function textField(fid, label, attrs) {
    const input = h('input', { class: 'input', id: fid, autocomplete: 'off', spellcheck: 'false', ...attrs });
    const el = h('div', { class: 'field' }, h('label', { class: 'field-label', for: fid }, label), input);
    return { el, input };
  }

  function invalid(input, on) {
    if (on) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function gmailCard() {
    const c = card({ key: 'gmail', iconName: 'mail', title: 'Gmail' });

    const email = textField(`${id}-gmail-email`, 'Gmail address', { type: 'email', autocomplete: 'email', placeholder: 'you@gmail.com' });
    const pw = textField(`${id}-gmail-pw`, 'App password', { type: 'password', autocomplete: 'new-password', placeholder: '16 characters, spaces are fine' });
    const apBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Connect Gmail');
    const apForm = h(
      'form',
      { class: 'st-form', novalidate: true, 'aria-label': 'Connect Gmail with an app password', onSubmit: connectAppPassword },
      h('div', { class: 'st-fields' }, email.el, pw.el),
      h('div', { class: 'st-row' }, apBtn),
    );
    const howTo = h(
      'details',
      { class: 'st-details' },
      h('summary', {}, 'How to get an app password'),
      h(
        'ol',
        { class: 'st-howto' },
        h('li', {}, 'Turn on 2-Step Verification in your ', extLink('https://myaccount.google.com/security', 'Google Account security settings'), '.'),
        h('li', {}, 'Open ', extLink('https://myaccount.google.com/apppasswords', 'App passwords'), ', name it “coldtrail” and select Create.'),
        h('li', {}, 'Copy the 16-character password Google shows you.'),
        h('li', {}, 'In Gmail, open Settings → Forwarding and POP/IMAP, select Enable IMAP and save.'),
      ),
    );

    const googleBtn = h('button', { type: 'button', class: 'btn btn-secondary', onClick: connectGoogle }, 'Sign in with Google');
    const googleBlock = h('div', { class: 'st-more-block' }, h('p', {}, 'Sign in with Google instead of an app password.'), h('div', { class: 'st-row' }, googleBtn));
    const clientId = textField(`${id}-gmail-client-id`, 'Client ID', { type: 'text', placeholder: '….apps.googleusercontent.com' });
    const clientSecret = textField(`${id}-gmail-client-secret`, 'Client secret', { type: 'password', autocomplete: 'new-password', placeholder: 'GOCSPX-…' });
    const byoBtn = h('button', { type: 'submit', class: 'btn btn-secondary' }, 'Save and connect');
    const byoForm = h(
      'form',
      { class: 'st-form st-more-block', novalidate: true, 'aria-label': 'Connect Gmail with your own OAuth client', onSubmit: connectOwnClient },
      h('p', {}, 'Use your own Google OAuth client (a Desktop app):'),
      h(
        'ol',
        { class: 'st-howto' },
        h('li', {}, 'In the ', extLink('https://console.cloud.google.com/', 'Google Cloud Console'), ', create or pick a project and enable the Gmail API.'),
        h('li', {}, 'Set up the OAuth consent screen (External, Testing), add yourself as a test user and add the gmail.compose scope.'),
        h('li', {}, 'Create an OAuth client ID of type Desktop app and paste its ID and secret here.'),
      ),
      h('div', { class: 'st-fields' }, clientId.el, clientSecret.el),
      h('div', { class: 'st-row' }, byoBtn),
    );
    const more = h('details', { class: 'st-details' }, h('summary', {}, 'More options'), h('div', { class: 'st-more' }, googleBlock, byoForm));
    const forms = h('div', { class: 'st-gmail-forms' }, apForm, howTo, more);
    const reconnect = h('details', { class: 'st-details st-reconnect' }, h('summary', {}, 'Use different credentials'));

    let shownOn = null;
    function render() {
      const on = gmailOn();
      c.badgeSlot.replaceChildren(on ? badge('Connected', 'ok') : badge('Not connected'));
      googleBlock.hidden = !status.gmail_client_configured;
      if (on && status.auto_send) {
        c.note.replaceChildren(
          `Auto-send is on: Send now on the Drafts screen and the agent email people right away, up to ${fmtNum(status.daily_send_cap)} a day in total. `,
          h('a', { href: SENDING_TAB }, 'Change it under Sending'),
          '.',
        );
      } else {
        c.note.textContent = on
          ? 'coldtrail saves each email as a draft in your Gmail. You review and send it there.'
          : 'coldtrail puts each email in your Gmail drafts. An app password is the quickest way in: no Google Cloud project needed.';
      }
      if (shownOn === on) return;
      shownOn = on;
      if (on) {
        reconnect.append(forms);
        c.body.replaceChildren(reconnect);
      } else {
        c.body.replaceChildren(forms);
      }
    }

    async function connected(text) {
      local.gmail = true;
      say(c.msg, text, 'ok');
      render();
      // The form that had focus folded away under "Use different credentials": land on the card.
      const at = document.activeElement;
      if (!c.el.contains(at) || at.closest('details:not([open])')) c.focusTitle();
      await sync();
    }

    async function connectAppPassword(e) {
      e.preventDefault();
      if (isBusy(apBtn)) return;
      const addr = email.input.value.trim();
      const pass = pw.input.value.trim();
      invalid(email.input, !addr);
      invalid(pw.input, !pass);
      if (!addr || !pass) {
        say(c.msg, 'Enter your Gmail address and the app password.', 'err');
        (addr ? pw.input : email.input).focus();
        return;
      }
      setBusy(apBtn, true, { label: 'Checking…' });
      say(c.msg, 'Checking the app password with Gmail…', 'busy');
      let ok = false;
      await saveWith(async () => {
        try {
          const r = await api.post('/api/destination/gmail/app-password', { email: addr, app_password: pass });
          if (gone) return;
          setBusy(apBtn, false);
          if (r && r.ok === false) say(c.msg, r.message || "Couldn't connect Gmail.", 'err');
          else ok = true;
        } catch (err) {
          if (gone) return;
          setBusy(apBtn, false);
          say(c.msg, errorText(err), 'err');
        }
      });
      if (!ok || gone) return;
      pw.input.value = '';
      await connected('Gmail is connected.');
    }

    async function oauth(btn) {
      setBusy(btn, true, { label: 'Waiting for Google…' });
      say(c.msg, "Approve coldtrail in the Google tab that opened. This page updates when you're done.", 'busy');
      let ok = false;
      await saveWith(async () => {
        try {
          // No signal: the server holds this request open until Google's approval comes back.
          const r = await api.post('/api/destination/gmail/connect', { callback_port: 8765 });
          if (gone) return;
          setBusy(btn, false);
          if (r && r.ok === false) say(c.msg, r.message || "Couldn't connect Gmail.", 'err');
          else ok = true;
        } catch (err) {
          if (gone) return;
          setBusy(btn, false);
          say(c.msg, errorText(err), 'err');
        }
      });
      if (ok && !gone) await connected('Gmail is connected.');
    }

    function connectGoogle() {
      if (!isBusy(googleBtn)) oauth(googleBtn);
    }

    async function connectOwnClient(e) {
      e.preventDefault();
      if (isBusy(byoBtn)) return;
      const cid = clientId.input.value.trim();
      invalid(clientId.input, !cid);
      if (!cid) {
        say(c.msg, 'Paste your client ID first.', 'err');
        clientId.input.focus();
        return;
      }
      setBusy(byoBtn, true, { label: 'Saving…' });
      say(c.msg, '');
      try {
        await saveWith(() => api.post('/api/destination/gmail/client', { client_id: cid, client_secret: clientSecret.input.value.trim() }));
      } catch (err) {
        if (gone) return;
        setBusy(byoBtn, false);
        say(c.msg, errorText(err), 'err');
        return;
      }
      if (gone) return;
      await oauth(byoBtn); // stays busy straight on, now waiting for Google
    }

    return { el: c.el, render };
  }

  function linkedinCard() {
    const c = card({ key: 'linkedin', iconName: 'person', title: 'LinkedIn' });
    const connectBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: connect }, 'Connect LinkedIn');
    const disconnectBtn = h('button', { type: 'button', class: 'btn btn-secondary', onClick: disconnect }, 'Disconnect');
    const row = h('div', { class: 'st-row' }, connectBtn, disconnectBtn);
    c.body.append(row);
    let phase = 'idle'; // idle | starting | waiting
    let timer = null;
    let pollSeq = 0;

    function render() {
      const on = linkedinOn();
      const reconnect = !on && linkedinReconnect();
      if (phase === 'waiting') c.badgeSlot.replaceChildren(badge('Waiting for sign-in', 'accent'));
      else if (on) c.badgeSlot.replaceChildren(badge('Connected', 'ok'));
      else if (reconnect) c.badgeSlot.replaceChildren(badge('Reconnect needed', 'warn'));
      else c.badgeSlot.replaceChildren(badge('Not connected'));
      // What actually happens to a connection request, as the Gmail card says for email.
      const how = status.linkedin_auto_send
        ? `Auto-send is on: coldtrail sends connection requests itself, up to ${fmtNum(status.linkedin_daily_cap)} a day and ${fmtNum(status.linkedin_weekly_cap)} a week.`
        : 'coldtrail opens each connection request in a LinkedIn window for you to review and send.';
      if (reconnect) c.note.textContent = 'Your LinkedIn session expired. Reconnect to keep sending invites.';
      else if (on) c.note.textContent = how;
      else c.note.textContent = `${how} Connecting opens Chrome at LinkedIn's sign-in page.`;
      row.hidden = phase === 'waiting';
      connectBtn.hidden = on && phase === 'idle';
      disconnectBtn.hidden = !(on || reconnect) || phase !== 'idle';
      if (phase === 'idle' && !isBusy(connectBtn)) {
        connectBtn.textContent = reconnect ? 'Reconnect LinkedIn' : 'Connect LinkedIn';
        connectBtn.className = reconnect || !on ? 'btn btn-primary' : 'btn btn-secondary';
      }
    }

    function stop() {
      pollSeq++;
      clearTimeout(timer);
      timer = null;
    }

    function finish() {
      stop();
      phase = 'idle';
      setBusy(connectBtn, false);
    }

    function schedule(seq) {
      timer = setTimeout(() => tick(seq), LINKEDIN_POLL_MS);
    }

    async function tick(seq) {
      let s;
      try {
        s = await api.get('/api/destination/linkedin/status', { signal });
      } catch (err) {
        if (aborted(err) || seq !== pollSeq || gone) return;
        if (isStaleSession(err)) {
          // Every later poll would get the same 401: stop, and point at the fix.
          finish();
          say(c.msg, errorText(err), 'err');
          render();
          return;
        }
        schedule(seq); // a hiccup: try again next tick
        return;
      }
      if (seq !== pollSeq || gone) return;
      if (s.connected && !s.reconnect_needed) {
        finish();
        local.linkedin = true;
        say(c.msg, 'LinkedIn is connected.', 'ok');
        render();
        sync();
      } else if (!s.waiting) {
        // The sign-in task ended without a session: the window was closed, it timed out, or
        // Chrome couldn't start. Polling on would wait forever.
        finish();
        say(c.msg, "LinkedIn sign-in didn't finish: the window was closed or it timed out. Try again.", 'err');
        render();
      } else {
        schedule(seq);
      }
    }

    async function connect() {
      if (phase !== 'idle' || isBusy(connectBtn)) return;
      phase = 'starting';
      setBusy(connectBtn, true, { label: 'Opening Chrome…' });
      say(c.msg, '');
      try {
        // No signal: this starts the sign-in task on the server, which should start either way.
        const r = await api.post('/api/destination/linkedin/connect', {});
        if (gone) return;
        if (r && r.status === 'busy') {
          finish();
          say(c.msg, 'Chrome is busy with another LinkedIn task. Try again in a moment.', 'err');
          render();
          return;
        }
        phase = 'waiting';
        setBusy(connectBtn, false);
        say(c.msg, "Sign in to LinkedIn in the Chrome window that opened. This page updates when you're done.", 'busy');
        // The buttons hide while waiting: keep keyboard focus on the card.
        const hadFocus = document.activeElement === connectBtn;
        render();
        if (hadFocus) c.focusTitle();
        stop();
        schedule(pollSeq);
      } catch (err) {
        if (gone) return;
        finish();
        say(c.msg, errorText(err), 'err');
        render();
      }
    }

    async function disconnect() {
      if (phase !== 'idle' || isBusy(disconnectBtn)) return;
      const yes = await confirmDialog({
        title: 'Disconnect LinkedIn?',
        body: "coldtrail can't send invites until you connect again. Your sign-in stays in coldtrail's Chrome profile, so reconnecting may be quick.",
        confirmText: 'Disconnect',
        danger: true,
        opener: disconnectBtn,
        signal, // leaving the screen closes it, as a cancel
      });
      if (!yes || gone) return;
      setBusy(disconnectBtn, true, { label: 'Disconnecting…' });
      say(c.msg, '');
      try {
        await saveWith(() => api.post('/api/destination/linkedin/disconnect', {}));
      } catch (err) {
        if (gone) return;
        setBusy(disconnectBtn, false);
        say(c.msg, errorText(err), 'err');
        return;
      }
      if (gone) return;
      setBusy(disconnectBtn, false);
      local.linkedin = false;
      say(c.msg, 'LinkedIn is disconnected.', 'ok');
      const hadFocus = document.activeElement === disconnectBtn;
      render();
      if (hadFocus) connectBtn.focus();
      await sync();
      // Status now agrees: let it speak again (a later reconnect elsewhere shows up).
      if (status && !status.linkedin_connected) local.linkedin = null;
    }

    render();
    return { el: c.el, render, stop };
  }

  // ---- Sending ----

  /** A whole number from CAP_MIN to CAP_MAX, else null. */
  function parseCap(raw) {
    const s = String(raw ?? '').trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return n >= CAP_MIN && n <= CAP_MAX ? n : null;
  }

  function capInput(fid, label, unit, describedBy) {
    const unitId = `${fid}-unit`;
    const input = h('input', {
      class: 'input st-cap-input',
      id: fid,
      type: 'number',
      inputmode: 'numeric',
      min: String(CAP_MIN),
      max: String(CAP_MAX),
      step: '1',
      // The unit, the hint and any error are read with the field.
      'aria-describedby': [unitId, ...describedBy].join(' '),
    });
    const el = h(
      'div',
      { class: 'field st-cap' },
      h('label', { class: 'field-label', for: fid }, label),
      h('div', { class: 'st-cap-row' }, input, h('span', { class: 'st-cap-unit', id: unitId }, unit)),
    );
    return { el, input };
  }

  /**
   * One channel's auto-send card. cfg: key, title, icon, switchLabel, path, enabled(status) and
   * caps(status), fields [{ key, label, unit }], hint, check(caps) → { text, fields } | null,
   * describe(on, caps), confirm(caps) and raise(caps) → dialog text (turning on; a cap going up
   * while on), unraised(saved) → the toast when a raise is dropped on the way out (nobody was
   * there to confirm it), body(on, caps) → the request body, limit(caps) → "Up to …",
   * usage(caps) → today's sends as [part, …] ([] = none known), connected() and notConnected()
   * → { text, link }: the notice shown while the channel can't send.
   */
  function sendingCard(cfg) {
    const c = card({ key: cfg.key, iconName: cfg.icon, title: cfg.title });
    const errId = `${id}-${cfg.key}-cap-error`;
    const hintId = `${id}-${cfg.key}-cap-hint`;
    let on = cfg.enabled(status);
    let toggling = false; // the switch is mid-change (its confirm open, or its save in flight)
    let chain = Promise.resolve();
    let lastSent = null; // the caps last sent, as JSON (so a re-commit of the same values is a no-op)
    // Per field, the value this screen last put there or saved from it. A field showing anything
    // else holds an edit that isn't saved yet (say, typed and left while its save waits out the
    // debounce), which a status refresh landing meanwhile must not overwrite.
    const synced = {};
    const markSynced = (caps) => {
      for (const f of fields) synced[f.key] = String(caps[f.key]);
    };

    const sw = switchEl({
      checked: on,
      label: cfg.switchLabel,
      description: cfg.describe(on, cfg.caps(status)),
      // Turning on asks first; the switch stays off (and busy) while it asks. Off never asks.
      confirm: (next) => (next ? askTurnOn() : true),
      onChange: toggle,
    });
    async function askTurnOn() {
      toggling = true; // until toggle() is done with it, or the answer is no
      const yes = await confirmDialog({ ...cfg.confirm(effectiveCaps()), confirmText: 'Turn on', opener: sw.button, signal });
      if (!yes || gone) toggling = false;
      return yes && !gone;
    }
    const swDesc = sw.querySelector('.switch-desc');
    const fields = cfg.fields.map((f) => ({ ...f, ...capInput(`${id}-${cfg.key}-${f.key}`, f.label, f.unit, [hintId, errId]) }));
    const capError = h('p', { class: 'field-error', id: errId, hidden: true });
    const usage = h('p', { class: 'st-usage', hidden: true });
    const notice = h('p', { class: 'st-notice', hidden: true });
    c.body.append(
      sw,
      h(
        'div',
        { class: 'st-caps' },
        h('div', { class: 'st-cap-fields' }, fields.map((f) => f.el)),
        capError,
        h('p', { class: 'field-hint', id: hintId }, cfg.hint),
        usage,
      ),
      notice,
    );

    const shownCaps = () => {
      const out = {};
      for (const f of fields) out[f.key] = parseCap(f.input.value);
      return out;
    };
    // The caps to use now: what's typed when it's valid, else what's saved.
    const effectiveCaps = () => {
      const typed = shownCaps();
      const saved = cfg.caps(status);
      const out = {};
      for (const f of fields) out[f.key] = typed[f.key] ?? saved[f.key];
      return cfg.check(out) ? saved : out;
    };

    function setError(text, culprits = []) {
      capError.textContent = text;
      capError.hidden = !text;
      for (const f of fields) invalid(f.input, !!text && culprits.includes(f.key));
    }

    function renderText() {
      const caps = effectiveCaps();
      swDesc.textContent = cfg.describe(on, caps);
      // Each part stays whole when the line wraps (phones).
      const parts = cfg.usage(caps);
      usage.replaceChildren(...parts.flatMap((part, i) => [i ? ' · ' : '', h('span', { class: 'st-usage-part' }, part)]));
      usage.hidden = !parts.length;
      const off = !cfg.connected();
      notice.hidden = !off;
      if (off) {
        const why = cfg.notConnected();
        notice.replaceChildren(icon('alert', 14), h('span', {}, why.text, ' ', h('a', { href: CONNECTIONS_TAB }, why.link)));
      }
    }

    function render() {
      if (!toggling) {
        on = cfg.enabled(status);
        sw.setChecked(on);
      }
      const saved = cfg.caps(status);
      for (const f of fields) {
        // Never overwrite what someone is typing, an edit still waiting to save, or a value they
        // still have to fix.
        const edited = f.key in synced && f.input.value !== synced[f.key];
        if (document.activeElement === f.input || edited || f.input.getAttribute('aria-invalid') === 'true') continue;
        f.input.value = synced[f.key] = String(saved[f.key]);
      }
      lastSent = JSON.stringify(saved);
      renderText();
    }

    // Requests go one at a time, in order. prepare() → the body (null: send nothing) runs when
    // its turn comes, so it sees what the requests before it did.
    function send(prepare) {
      const run = chain.then(() =>
        saveWith(async () => {
          const body = await prepare();
          if (body != null) await api.post(cfg.path, body);
        }),
      );
      chain = run.catch(() => {});
      return run;
    }

    async function toggle(next) {
      toggling = true;
      try {
        const caps = effectiveCaps();
        say(c.msg, '');
        try {
          await track(send(() => cfg.body(next, caps)));
        } catch (err) {
          if (!gone) say(c.msg, `Couldn't turn auto-send ${next ? 'on' : 'off'}: ${errorText(err)}`, 'err');
          return false; // the switch goes back
        }
        if (gone) return true;
        on = next;
        lastSent = JSON.stringify(caps);
        markSynced(caps);
        say(c.msg, `${cfg.title} auto-send is ${next ? 'on' : 'off'}.`, 'ok');
        renderText();
        track(sync());
        return true;
      } finally {
        toggling = false;
      }
    }

    async function commit() {
      saveCaps.cancel();
      const typed = shownCaps();
      const bad = fields.filter((f) => typed[f.key] == null).map((f) => f.key);
      if (bad.length) {
        setError(`Enter a whole number from ${CAP_MIN} to ${CAP_MAX}.`, bad);
        return;
      }
      const problem = cfg.check(typed);
      if (problem) {
        setError(problem.text, problem.fields);
        return;
      }
      setError('');
      renderText();
      const key = JSON.stringify(typed);
      if (key === lastSent) {
        markSynced(typed);
        return;
      }
      lastSent = key;
      say(c.msg, 'Saving…', 'busy');
      let kept = null; // the saved caps, when a raise wasn't confirmed
      let unasked = false; // ... because the screen was going, so nobody could answer
      try {
        await send(async () => {
          // Auto-send as it is now, not as this screen last saw it: it may have been turned off
          // elsewhere (the CLI, another tab), and saving a cap must never turn it back on.
          // No signal: a save that started finishes even if the screen goes.
          const now = await api.get('/api/status');
          const enabled = cfg.enabled(now);
          const saved = cfg.caps(now);
          const raised = fields.filter((f) => typed[f.key] > saved[f.key]);
          if (enabled && raised.length) {
            // More sends without asking: confirm first. Never while leaving the screen; then
            // the raise isn't saved, and a toast (it outlives the screen) says so.
            if (!gone) say(c.msg, '');
            const ask = !leaving && !gone;
            const yes = ask && (await confirmDialog({ ...cfg.raise(typed), opener: raised[0].input, signal }));
            if (!yes || gone) {
              kept = saved;
              unasked = !ask || gone; // a dialog the screen's going closed was no answer either
              return null;
            }
            say(c.msg, 'Saving…', 'busy');
          }
          return cfg.body(enabled, typed);
        });
      } catch (err) {
        lastSent = null;
        if (!gone) say(c.msg, `Couldn't save the caps: ${errorText(err)}`, 'err');
        return;
      }
      if (unasked) toast(cfg.unraised(kept));
      if (gone) return;
      if (kept) {
        for (const f of fields) f.input.value = String(kept[f.key]);
        markSynced(kept);
        lastSent = JSON.stringify(kept);
        say(c.msg, `Not changed. ${cfg.limit(kept)}`);
        renderText();
        return;
      }
      markSynced(typed);
      say(c.msg, `Saved. ${cfg.limit(typed)}`, 'ok');
      await sync();
    }
    const commitCaps = () => track(commit());
    const saveCaps = debounce(commitCaps, CAP_SAVE_MS);

    for (const f of fields) {
      f.input.addEventListener('change', () => saveCaps());
      f.input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        commitCaps();
      });
      f.input.addEventListener('input', () => {
        // A fixed value clears the error as soon as it's valid again.
        if (f.input.getAttribute('aria-invalid') === 'true' && parseCap(f.input.value) != null) setError('');
        renderText();
      });
    }

    const built = {
      update: () => render(),
      // Caps typed and left, but still waiting out the debounce, save now.
      flush: () => saveCaps.flush(),
      destroy: () => saveCaps.flush(),
    };
    render();
    return { el: c.el, built };
  }

  function buildSending(el) {
    const email = sendingCard({
      key: 'email',
      title: 'Email',
      icon: 'mail',
      switchLabel: 'Auto-send emails',
      path: '/api/destination/auto-send',
      enabled: (s) => !!s.auto_send,
      caps: (s) => ({ daily: s.daily_send_cap }),
      fields: [{ key: 'daily', label: 'Daily cap', unit: 'emails a day' }],
      hint: 'coldtrail stops sending email for the day once it reaches this many.',
      check: () => null,
      // deliver::send applies the cap to every email send: Send now, and the agent's own sends.
      describe: (on, caps) =>
        on
          ? `Send now on the Drafts screen emails people right away, and the agent can send email itself in chats and scheduled runs — up to ${fmtNum(caps.daily)} emails a day in total.`
          : 'Drafts only: each email is saved to your Gmail drafts for you to review and send.',
      confirm: (caps) => ({
        title: 'Turn on email auto-send?',
        body: `Send now on the Drafts screen will email people right away, and the agent can send email itself in chats and scheduled runs — up to ${fmtNum(caps.daily)} emails a day in total. A sent email can't be taken back.`,
      }),
      raise: (caps) => ({
        title: `Raise the email cap to ${fmtNum(caps.daily)} a day?`,
        body: `Auto-send is on, so Send now and the agent can email up to ${fmtNum(caps.daily)} people a day without asking. A sent email can't be taken back.`,
        confirmText: 'Raise cap',
      }),
      unraised: (caps) =>
        `Email cap not raised: it stays at ${fmtNum(caps.daily)} a day. With auto-send on, a higher cap needs your confirmation under Settings → Sending.`,
      body: (on, caps) => ({ enabled: on, daily_cap: caps.daily }),
      limit: (caps) => `Up to ${fmtNum(caps.daily)} ${caps.daily === 1 ? 'email' : 'emails'} a day.`,
      usage: (caps) => (typeof status.email_sent_today === 'number' ? [`${fmtNum(status.email_sent_today)} of ${fmtNum(caps.daily)} sent today`] : []),
      connected: () => gmailOn() || !!status.gcloud_available,
      notConnected: () => ({ text: "Gmail isn't connected, so there's nothing to send through yet.", link: 'Connect Gmail' }),
    });
    const linkedin = sendingCard({
      key: 'linkedin',
      title: 'LinkedIn',
      icon: 'person',
      switchLabel: 'Auto-send LinkedIn invites',
      path: '/api/destination/linkedin/auto-send',
      enabled: (s) => !!s.linkedin_auto_send,
      caps: (s) => ({ daily: s.linkedin_daily_cap, weekly: s.linkedin_weekly_cap }),
      fields: [
        { key: 'daily', label: 'Daily cap', unit: 'invites a day' },
        { key: 'weekly', label: 'Weekly cap', unit: 'invites a week' },
      ],
      hint: 'Keep these low: LinkedIn can restrict accounts that send too many invites.',
      check: (caps) =>
        caps.daily != null && caps.weekly != null && caps.daily > caps.weekly
          ? { text: "The daily cap can't be more than the weekly cap.", fields: ['daily'] }
          : null,
      describe: (on, caps) =>
        on
          ? `coldtrail clicks Send on connection requests itself, up to ${fmtNum(caps.daily)} a day and ${fmtNum(caps.weekly)} a week, including on scheduled runs.`
          : 'coldtrail opens each connection request in a LinkedIn window for you to review and send.',
      confirm: (caps) => ({
        title: 'Turn on LinkedIn auto-send?',
        body: `coldtrail will click Send on connection requests itself, up to ${fmtNum(caps.daily)} a day and ${fmtNum(caps.weekly)} a week. LinkedIn can restrict accounts that send too many invites.`,
      }),
      raise: (caps) => ({
        title: 'Raise the LinkedIn caps?',
        body: `Auto-send is on, so coldtrail can send up to ${fmtNum(caps.daily)} invites a day and ${fmtNum(caps.weekly)} a week without asking. LinkedIn can restrict accounts that send too many invites.`,
        confirmText: 'Raise caps',
      }),
      unraised: (caps) =>
        `LinkedIn caps not raised: they stay at ${fmtNum(caps.daily)} a day and ${fmtNum(caps.weekly)} a week. With auto-send on, higher caps need your confirmation under Settings → Sending.`,
      body: (on, caps) => ({ enabled: on, weekly_cap: caps.weekly, daily_cap: caps.daily }),
      limit: (caps) => `Up to ${fmtNum(caps.daily)} ${caps.daily === 1 ? 'invite' : 'invites'} a day and ${fmtNum(caps.weekly)} a week.`,
      usage: (caps) => [
        `${fmtNum(status.linkedin_sent_today)} of ${fmtNum(caps.daily)} sent today`,
        `${fmtNum(status.linkedin_sent_7d)} of ${fmtNum(caps.weekly)} in the last 7 days`,
      ],
      connected: () => linkedinOn(),
      notConnected: () =>
        linkedinReconnect()
          ? { text: "Your LinkedIn session expired, so coldtrail can't send invites until you reconnect.", link: 'Reconnect LinkedIn' }
          : { text: "LinkedIn isn't connected, so coldtrail can't send invites yet.", link: 'Connect LinkedIn' },
    });
    el.append(h('div', { class: 'st-stack' }, email.el, linkedin.el));
    const cards = [email.built, linkedin.built];
    return {
      update: () => cards.forEach((b) => b.update()),
      flush: () => cards.forEach((b) => b.flush()),
      destroy: () => cards.forEach((b) => b.destroy()),
    };
  }

  // ---- Enrichment ----

  const TOOLS = [
    {
      key: 'the_harvester',
      title: 'theHarvester',
      icon: 'search',
      desc: 'Collects email addresses and names for a domain from public sources. The agent tries it first when it is installed.',
      installed: (o) => !!o.the_harvester,
      canInstall: (o) => !!o.the_harvester_can_install,
      how: 'Installs with pipx.',
      missing: () => 'Needs pipx to install.',
    },
    {
      key: 'spiderfoot',
      title: 'SpiderFoot',
      icon: 'scan',
      desc: 'A deeper OSINT scanner new enrichment runs can use. It installs inside your coldtrail workspace.',
      installed: (o) => !!o.spiderfoot,
      canInstall: (o) => !!o.spiderfoot_can_install,
      how: 'Installs with git and Python.',
      missing: () => 'Needs git and Python 3.10–3.12 to install.',
    },
  ];

  function buildEnrichment(el) {
    const rows = TOOLS.map(toolCard);
    const recheckBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: recheck }, 'Check again');
    const recheckMsg = h('p', { class: 'st-msg', role: 'status' });
    el.append(
      h('div', { class: 'st-stack' }, rows.map((r) => r.el)),
      h('div', { class: 'st-recheck' }, h('span', {}, 'Installed something from your terminal?'), recheckBtn),
      recheckMsg,
    );

    async function recheck() {
      if (isBusy(recheckBtn)) return;
      setBusy(recheckBtn, true, { label: 'Checking…' });
      say(recheckMsg, '');
      try {
        apply(await api.get('/api/status', { signal }));
      } catch (err) {
        if (!aborted(err) && !gone) say(recheckMsg, `Couldn't check again: ${errorText(err)}`, 'err');
      } finally {
        if (!gone) setBusy(recheckBtn, false);
      }
    }

    const update = () => rows.forEach((r) => r.render());
    update();
    return { update };
  }

  function toolCard(tool) {
    const c = card({ key: tool.key, iconName: tool.icon, title: tool.title });
    c.note.textContent = tool.desc;
    const btn = h('button', { type: 'button', class: 'btn btn-secondary', 'aria-label': `Install ${tool.title}`, onClick: install }, 'Install');
    const reason = h('p', { class: 'st-reason' });
    c.body.append(h('div', { class: 'st-row' }, btn, reason));

    function render() {
      const o = status.osint || {};
      const installed = tool.installed(o);
      const can = !installed && tool.canInstall(o);
      c.badgeSlot.replaceChildren(installed ? badge('Installed', 'ok') : badge('Not installed'));
      btn.hidden = !can && !isBusy(btn);
      reason.textContent = installed ? 'Ready. New enrichment runs use it.' : can ? tool.how : tool.missing(o);
    }

    async function install() {
      if (isBusy(btn)) return;
      setBusy(btn, true, { label: 'Installing…' });
      say(c.msg, `Installing ${tool.title}. This can take a few minutes.`, 'busy');
      let ok = false;
      await saveWith(async () => {
        try {
          // No signal: the install runs inside this request; leaving mustn't cut it off.
          const r = await api.post('/api/onboarding/osint/install', { tool: tool.key });
          if (gone) return;
          ok = !!(r && r.ok);
          say(c.msg, (r && r.message) || (ok ? `${tool.title} is installed.` : `${tool.title} didn't install.`), ok ? 'ok' : 'err');
        } catch (err) {
          if (gone) return;
          say(c.msg, errorText(err), 'err');
        } finally {
          if (!gone) setBusy(btn, false);
        }
      });
      if (gone) return;
      render();
      if (ok) await sync();
    }

    return { el: c.el, render };
  }

  // ---- Appearance ----

  const THEMES = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  function preview(kind) {
    // A tiny picture of the app (sidebar, title, rows) in that theme; decorative.
    const pane = (k) =>
      h(
        'span',
        { class: `st-pv st-pv-${k}` },
        h('span', { class: 'st-pv-side' }, h('span', { class: 'st-pv-dot' }), h('span', { class: 'st-pv-bar' }), h('span', { class: 'st-pv-bar' })),
        h('span', { class: 'st-pv-main' }, h('span', { class: 'st-pv-title' }), h('span', { class: 'st-pv-row' }), h('span', { class: 'st-pv-row' }), h('span', { class: 'st-pv-btn' })),
      );
    if (kind === 'system') return h('span', { class: 'st-preview st-preview-split', 'aria-hidden': 'true' }, pane('light'), pane('dark'));
    return h('span', { class: 'st-preview', 'aria-hidden': 'true' }, pane(kind));
  }

  function buildAppearance(el) {
    const name = `${id}-theme`;
    const hintId = `${id}-theme-hint`;
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const radios = THEMES.map((t) =>
      h('input', {
        type: 'radio',
        class: 'st-theme-radio',
        name,
        value: t.value,
        id: `${name}-${t.value}`,
        onChange: (e) => {
          if (e.target.checked) choose(t.value);
        },
      }),
    );
    const hint = h('p', { class: 'field-hint st-theme-hint', id: hintId });
    const c = card({ key: 'theme', iconNode: themeIcon(), title: 'Theme' });
    c.note.textContent = 'Saved in this browser.';
    c.body.append(
      h(
        'div',
        // Named by the card's title.
        { class: 'st-themes', role: 'radiogroup', 'aria-labelledby': c.titleId, 'aria-describedby': hintId },
        THEMES.map((t, i) =>
          h('label', { class: 'st-theme', for: radios[i].id }, preview(t.value), h('span', { class: 'st-theme-foot' }, radios[i], h('span', { class: 'st-theme-label' }, t.label))),
        ),
      ),
      hint,
    );
    el.append(c.el);

    function render() {
      const pref = getThemePref();
      radios.forEach((r) => {
        r.checked = r.value === pref;
        r.closest('.st-theme').classList.toggle('is-chosen', r.checked);
      });
      const now = media && media.matches ? 'dark' : 'light';
      hint.textContent = `System follows your computer's setting, which is ${now} right now.`;
    }

    function choose(value) {
      setThemePref(value);
      render();
    }

    const onMedia = () => render();
    if (media && media.addEventListener) media.addEventListener('change', onMedia);
    render();
    return {
      update: () => {},
      destroy: () => {
        if (media && media.removeEventListener) media.removeEventListener('change', onMedia);
      },
    };
  }

  function themeIcon() {
    return h(
      'svg',
      { viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
      h('circle', { cx: '12', cy: '12', r: '8' }),
      h('path', { d: 'M12 4v16' }),
      h('path', { d: 'M12 4a8 8 0 0 1 0 16z', fill: 'currentColor' }),
    );
  }

  // ---- Start ----

  setTab(tab);
  if (status) {
    // The store's copy can be up to 30s old.
    if (store) store.refresh();
    else sync();
  } else {
    load();
  }

  /**
   * The router is about to leave: caps still waiting out their debounce save now, and the switch,
   * cap and model saves under way get to land (and refresh the store) before the next screen
   * reads it. The router caps the wait.
   */
  async function beforeLeave() {
    leaving = true;
    for (const p of panes.values()) if (p.built && p.built.flush) p.built.flush();
    const agent = panes.get('agent').built;
    // The panel's saves first: each ends by starting a store refresh, which joins `pending`.
    if (agent && agent.settled) await Promise.allSettled([agent.settled()]);
    // A save that lands can start its status re-read and store refresh: wait for those too.
    while (pending.size) await Promise.all([...pending]);
  }

  /** The router keeps this screen (another tab, or a leave that was overtaken). */
  function stay(query) {
    leaving = false;
    setTab(tabOf(query));
  }

  const me = { stay, beforeLeave };
  active = me;
  return () => {
    gone = true;
    if (active === me) active = null;
    unsubscribe();
    for (const p of panes.values()) {
      if (p.built && p.built.destroy) {
        try {
          p.built.destroy();
        } catch (err) {
          console.error(err);
        }
      }
    }
    ctl.abort();
  };
}

export default {
  title: TITLE,
  css: true,
  mount: mountSettings,
  update(ctx) {
    if (!active || ctx.path[0] !== 'settings') return false;
    active.stay(ctx.query);
    return true;
  },
  beforeLeave() {
    return active ? active.beforeLeave() : undefined;
  },
};

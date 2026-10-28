// Schedules (spec §5.7; inventory "Cron"). One row per schedule: name, cadence, task, an enabled
// switch, next run, last run and a ⋯ menu (Run now, Dry run, Edit, Delete). Create/Edit is a
// dialog that previews the next three run times and says what the schedule may send. Below, the
// run history (the latest 50 runs, every schedule plus manual runs).
//
// Data: GET /api/schedules, /api/runs and /api/status, each loaded (and failing) on its own.
// No polling of its own: the shared store's 30s summary tells it when a run finished (last_run
// changes) or is running, and a 30s ticker keeps the relative times fresh. Unmount aborts
// requests, stops the ticker, unsubscribes and closes any dialog or menu this screen opened.
// Every dynamic string goes through h() (text nodes); nothing here builds HTML.

import { api } from '../core/api.js';
import { fmtDate, fmtNum, fmtRelative, h, pluralize, toDate } from '../core/dom.js';
import { href } from '../core/router.js';
import { openDialog, openMenu, toast } from '../core/ui.js';
import { badge } from '../components/badge.js';
import { emptyState } from '../components/emptyState.js';
import { switchEl } from '../components/switch.js';
import { table } from '../components/table.js';

const title = 'Schedules';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // the day picker starts on Monday
const TICK_MS = 30_000;
const RUN_TITLE_PREFIX = 'Scheduled run — ';
const DEFAULT_EMAIL_CAP = 20;
const DEFAULT_LINKEDIN_CAP = 15;

const TRIGGERS = { scheduled: 'Scheduled', manual: 'Manual', dry: 'Dry run' };
const RUN_STATUS = {
  ok: ['Succeeded', 'ok'],
  error: ['Failed', 'danger'],
  auth_failed: ['Sign-in failed', 'warn'],
};

const LINKEDIN_CAVEAT =
  'LinkedIn invites only go out if this computer is awake and unlocked and LinkedIn is connected ' +
  'when it runs; otherwise they stay in Drafts.';

// ---- Pure helpers (time rules match the OS timer and summary::next_run_at) ----

/** [hour, minute] from "HH:MM"; anything unreadable is 09:00, as on the server. */
function slot(time) {
  const m = /^\s*(\d{1,2}):(\d{1,2})\s*$/.exec(time || '');
  if (!m) return [9, 0];
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh <= 23 && mm <= 59 ? [hh, mm] : [9, 0];
}

/** The next `n` local times a schedule fires: today at HH:MM if still ahead, else tomorrow;
 *  weekly → the next matching weekday (+7 days once today's slot has passed; none → Monday). */
export function nextRuns({ freq, time, weekday }, n = 3, now = new Date()) {
  const [hh, mm] = slot(time);
  const first = new Date(now);
  first.setHours(hh, mm, 0, 0);
  if (freq === 'weekly') {
    const target = (weekday == null ? 1 : Number(weekday)) % 7;
    let add = (target - now.getDay() + 7) % 7;
    if (add === 0 && first <= now) add = 7;
    first.setDate(first.getDate() + add);
  } else if (first <= now) {
    first.setDate(first.getDate() + 1);
  }
  const step = freq === 'weekly' ? 7 : 1;
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(first);
    d.setDate(d.getDate() + i * step);
    return d;
  });
}

const pad = (v) => String(v).padStart(2, '0');

/** "HH:MM" (24-hour) from what was typed: "9", "930", "09:30", "9.30", "16h30"; else null. */
export function parseTime(v) {
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?$/i.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = m[2] == null ? 0 : Number(m[2]);
  return hh <= 23 && mm <= 59 ? `${pad(hh)}:${pad(mm)}` : null;
}
/** Local "YYYY-MM-DDTHH:MM" for <time datetime>. */
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "Fri, Oct 30, 16:30". */
export const runLabel = (d) => `${DAYS[d.getDay()]}, ${fmtDate(d, { time: true })}`;

/** "in 3h" within 48h, else the dated label. */
function nextText(d) {
  const rel = fmtRelative(d);
  return /^in |^just now$/.test(rel) ? rel : runLabel(d);
}

/** "Daily at 13:00" / "Weekly · Mon 09:00" (spec §5.7). */
export function cadenceLabel(s) {
  const [hh, mm] = slot(s.time);
  const t = `${pad(hh)}:${pad(mm)}`;
  if (s.freq === 'weekly') return `Weekly · ${DAYS[(s.weekday == null ? 1 : Number(s.weekday)) % 7]} ${t}`;
  return `Daily at ${t}`;
}

/**
 * What a run of any schedule may send, from /api/status (null = couldn't read it):
 * { text, caveat?, risky, unknown } — `risky` when Run now should ask first.
 */
export function sendingPolicy(st) {
  if (!st) {
    return {
      unknown: true,
      risky: true,
      text: "Couldn't read your sending settings, so check them before this runs.",
    };
  }
  const email = !!st.auto_send;
  const li = !!st.linkedin_auto_send;
  if (!email && !li) return { risky: false, text: 'Drafts only: nothing is sent automatically.' };
  const what = [
    email && pluralize(st.daily_send_cap || DEFAULT_EMAIL_CAP, 'email'),
    li && pluralize(st.linkedin_daily_cap || DEFAULT_LINKEDIN_CAP, 'LinkedIn invite'),
  ]
    .filter(Boolean)
    .join(' and ');
  let text = `Auto-send is on: this schedule can send up to ${what} a day without asking.`;
  if (email && !li) text += ' LinkedIn notes stay as drafts.';
  if (li && !email) text += ' Emails stay as drafts.';
  return { risky: true, what, text, caveat: li ? LINKEDIN_CAVEAT : null };
}

const listOf = (v, key) => (Array.isArray(v) ? v : (v && Array.isArray(v[key]) && v[key]) || []);
const nameOf = (s) => (s.name && s.name.trim() ? s.name : 'Untitled schedule');
const quoted = (s) => `“${nameOf(s)}”`;
const enc = encodeURIComponent;

let uid = 0;

// ---- Icons (inline stroke SVGs, 1.75px) ----

function icon(paths, size = 16) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    [].concat(paths).map((d) => h('path', { d })),
  );
}
// "⋯": three filled dots read better than hairline strokes at this size.
function dotsIcon() {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: '18', height: '18', fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false' },
    [5, 12, 19].map((cx) => h('circle', { cx: String(cx), cy: '12', r: '1.6' })),
  );
}

const ICON = {
  plus: 'M12 5v14M5 12h14',
  chevron: 'M6 9l6 6 6-6',
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  alert: ['M12 3l9.5 17h-19L12 3z', 'M12 10v4', 'M12 17.5v.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 7.5v.01'],
};

// ---- The screen ----

let current = null; // the mounted screen, for update()

function mountSchedules(root, ctx) {
  const { store, nav } = ctx;
  let alive = true;
  let schedules = null; // null while loading
  let runs = null;
  let status; // undefined while loading, null when it failed
  let errSchedules = null;
  let errRuns = null;
  const ctls = { schedules: null, runs: null, status: null };
  const overlays = new Set(); // dialogs and menus this screen opened
  const rowRefs = new Map(); // id → { s, nextCell, lastCell, row, menuBtn }
  const busyRows = new Set();
  let lastRunKey = runKey(store.get().summary);
  let running = runningOf(store.get().summary);

  // ---- Layout ----

  const newBtn = h(
    'button',
    { type: 'button', class: 'btn btn-primary', onClick: () => openEditor(null, newBtn) },
    icon(ICON.plus),
    'New schedule',
  );
  const desc = h('p', { class: 'page-desc' });
  const head = h(
    'div',
    { class: 'page-head' },
    h('div', { class: 'page-head-text' }, h('h1', {}, title), desc),
    h('div', { class: 'page-actions' }, newBtn),
  );

  const listBox = h('div', { class: 'sch-list', 'aria-busy': 'true' });
  const listSection = h('section', { class: 'sch-section' }, listBox);

  const historyTitleId = `sch-history-${++uid}`;
  const historyBody = h('div', { class: 'sch-history-body' });
  const historyDesc = h('p', { class: 'sch-section-desc' }, 'The latest 50 runs, newest first.');
  const historySection = h(
    'section',
    { class: 'sch-section sch-history', 'aria-labelledby': historyTitleId, 'aria-busy': 'true' },
    h(
      'div',
      { class: 'sch-section-head' },
      h('h2', { id: historyTitleId }, 'Run history'),
      historyDesc,
    ),
    historyBody,
  );

  root.append(head, listSection, historySection);
  renderDesc();
  renderList();
  renderHistory();

  // ---- Loading ----

  function fetchInto(key, path, onOk, onErr) {
    if (ctls[key]) ctls[key].abort();
    const ctl = new AbortController();
    ctls[key] = ctl;
    return api.get(path, { signal: ctl.signal }).then(
      (v) => {
        if (!alive || ctl.signal.aborted) return;
        ctls[key] = null;
        onOk(v);
      },
      (err) => {
        if (!alive || ctl.signal.aborted || (err && err.name === 'AbortError')) return;
        ctls[key] = null;
        onErr(err);
      },
    );
  }

  function loadSchedules({ announce = false } = {}) {
    return fetchInto(
      'schedules',
      '/api/schedules',
      (v) => {
        schedules = listOf(v, 'schedules');
        errSchedules = null;
        keepFocus(renderList);
      },
      (err) => {
        errSchedules = err;
        // A reload that fails keeps what's on screen; say why unless the banner already does.
        if (schedules && announce && err.status !== 401) toast(err.message, 'err');
        if (!schedules) keepFocus(renderList);
      },
    );
  }

  function loadRuns() {
    return fetchInto(
      'runs',
      '/api/runs',
      (v) => {
        runs = listOf(v, 'runs');
        errRuns = null;
        keepFocus(renderHistory);
      },
      (err) => {
        errRuns = err;
        if (!runs) renderHistory();
      },
    );
  }

  function loadStatus() {
    return fetchInto(
      'status',
      '/api/status',
      (v) => {
        status = v;
        renderDesc();
      },
      () => {
        // Keep a status the store already had; otherwise say we couldn't read it.
        if (!status) status = null;
        renderDesc();
      },
    );
  }

  function loadAll() {
    loadSchedules();
    loadRuns();
    loadStatus();
  }

  // ---- Page description: what runs may send ----

  function renderDesc() {
    const parts = ['Run coldtrail at set times, even when this app is closed.'];
    if (status) {
      const p = sendingPolicy(status);
      if (p.risky) parts.push(`Auto-send is on: runs can send up to ${p.what} a day. Dry runs never send.`);
      else parts.push('Auto-send is off, so runs only write drafts.');
    }
    desc.textContent = parts.join(' ');
  }

  // ---- Schedule rows ----

  // Re-rendering replaces rows; put focus back on the same control (by data-focus-key), or on
  // New schedule when that control is gone (a deleted row, the empty state's button).
  function keepFocus(fn) {
    const at = document.activeElement;
    const key = at && root.contains(at) && at.dataset ? at.dataset.focusKey : null;
    const inList = at && listBox.contains(at);
    fn();
    if (!alive) return;
    if (key) {
      const again = [...root.querySelectorAll('[data-focus-key]')].find((el) => el.dataset.focusKey === key);
      if (again) {
        again.focus({ preventScroll: true });
        return;
      }
    }
    if (inList && !listBox.contains(document.activeElement)) newBtn.focus({ preventScroll: true });
  }

  function errorBlock(what, err, retry) {
    return h(
      'div',
      { class: 'sch-error', role: 'alert' },
      icon(ICON.alert),
      h(
        'p',
        { class: 'sch-error-text' },
        `${what} didn't load.`,
        // The session banner already explains a 401; don't repeat it here.
        err && err.status !== 401 && err.message ? h('span', { class: 'sch-error-why' }, ` ${err.message}`) : null,
      ),
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: retry }, 'Try again'),
    );
  }

  function skeletonRows(n) {
    return Array.from({ length: n }, () =>
      h(
        'div',
        { class: 'sch-skel-row', 'aria-hidden': 'true' },
        h('span', { class: 'skeleton sch-skel-switch' }),
        h('span', { class: 'skeleton sch-skel-main' }),
        h('span', { class: 'skeleton sch-skel-cell' }),
        h('span', { class: 'skeleton sch-skel-cell' }),
      ),
    );
  }

  function renderList() {
    rowRefs.clear();
    listBox.setAttribute('aria-busy', schedules == null && !errSchedules ? 'true' : 'false');
    if (schedules == null) {
      listBox.className = 'sch-list is-placeholder';
      listBox.replaceChildren(
        ...(errSchedules
          ? [errorBlock('Schedules', errSchedules, () => {
            errSchedules = null;
            renderList();
            loadSchedules();
          })]
          : [h('span', { class: 'sr-only' }, 'Loading schedules…'), ...skeletonRows(2)]),
      );
      return;
    }
    if (!schedules.length) {
      listBox.className = 'sch-list is-placeholder';
      const create = h(
        'button',
        { type: 'button', class: 'btn btn-primary', onClick: () => openEditor(null, create) },
        icon(ICON.plus),
        'Create a schedule',
      );
      listBox.replaceChildren(
        emptyState({
          title: 'No schedules yet',
          body: 'A schedule runs coldtrail at a set time, daily or weekly, even when this app is closed. Each run sources, enriches and drafts, and sends only what auto-send allows.',
          action: create,
        }),
      );
      return;
    }
    listBox.className = 'sch-list';
    const header = h(
      'div',
      { class: 'sch-list-head', 'aria-hidden': 'true' },
      h('span', { class: 'sch-h-main' }, 'Schedule'),
      h('span', { class: 'sch-h-next' }, 'Next run'),
      h('span', { class: 'sch-h-last' }, 'Last run'),
    );
    listBox.replaceChildren(
      header,
      h('ul', { class: 'sch-rows', 'aria-label': 'Schedules' }, schedules.map(scheduleRow)),
    );
  }

  function taskBits(s) {
    if (s.task_mode === 'custom') {
      const prompt = s.prompt || '';
      return [
        h('span', { class: 'sch-task' }, badge('Custom', 'neutral')),
        prompt ? h('span', { class: 'sch-prompt', title: prompt }, prompt) : null,
      ];
    }
    return [h('span', { class: 'sch-task' }, badge('Agent decides', 'accent'))];
  }

  function nextContent(s) {
    if (!s.enabled) {
      return [
        h('span', { class: 'sch-paused' }, 'Paused'),
        h('span', { class: 'sch-sub' }, 'Turn it on to run'),
      ];
    }
    const d = nextRuns(s, 1)[0];
    const main = nextText(d);
    return [
      h('time', { class: 'sch-when', datetime: localIso(d), title: runLabel(d) }, main),
      // Within 48h the main line is relative ("in 3h"): say the exact time under it too.
      main === runLabel(d) ? null : h('span', { class: 'sch-sub' }, runLabel(d)),
    ];
  }

  function isRunning(s) {
    return !!running && running.title === `${RUN_TITLE_PREFIX}${s.name}`;
  }

  function lastContent(s) {
    if (isRunning(s)) {
      return [
        h('span', { class: 'sch-last-top' }, badge('Running', 'accent'), h('span', { class: 'sch-sub' }, 'now')),
        h('a', { class: 'sch-link', href: href(['agent', running.chat_id]), 'data-focus-key': `watch:${s.id}` }, 'Watch the run', h('span', { class: 'sr-only' }, ` (${nameOf(s)})`)),
      ];
    }
    const lr = s.last_run;
    if (!lr) return [h('span', { class: 'sch-none' }, 'No runs yet')];
    const [label, tone] = RUN_STATUS[lr.status] || [lr.status || 'Unknown', 'neutral'];
    const when = toDate(lr.started_at);
    const out = [
      h(
        'span',
        { class: 'sch-last-top' },
        badge(label, tone),
        when ? h('time', { class: 'sch-sub', datetime: when.toISOString(), title: fmtDate(when, { time: true }) }, fmtRelative(when)) : null,
      ),
      h(
        'span',
        { class: 'sch-counts' },
        // Each "N label ·" pair stays on one line, so a wrap never starts a line with "·".
        ['sourced', 'enriched', 'drafted', 'sent'].map((k, i, all) => [
          i ? ' ' : null,
          h('span', { class: 'sch-count' }, `${fmtNum(lr[k])} ${k}${i < all.length - 1 ? ' ·' : ''}`),
        ]),
      ),
    ];
    const links = [];
    if (lr.chat_id) {
      links.push(
        h(
          'a',
          { class: 'sch-link', href: href(['agent', lr.chat_id]), 'data-focus-key': `view:${s.id}` },
          'View run',
          h('span', { class: 'sr-only' }, ` (${nameOf(s)}, ${fmtDate(when, { time: true })})`),
        ),
      );
    }
    if (lr.status === 'auth_failed') {
      links.push(h('a', { class: 'sch-link', href: '#/settings?tab=agent', 'data-focus-key': `signin:${s.id}` }, 'Sign the agent in again'));
    }
    if (links.length) out.push(h('span', { class: 'sch-links' }, links));
    return out;
  }

  function scheduleRow(s) {
    const sw = switchEl({ checked: !!s.enabled, label: nameOf(s), onChange: (on) => toggle(s, on) });
    sw.classList.add('sch-switch');
    const text = sw.querySelector('.switch-text');
    if (text) text.classList.add('sr-only');
    sw.button.dataset.focusKey = `switch:${s.id}`;

    const menuBtn = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn sch-menu-btn',
        'aria-label': `Actions for ${nameOf(s)}`,
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        'data-focus-key': `menu:${s.id}`,
        onClick: () => rowMenu(s, menuBtn),
      },
      dotsIcon(),
    );
    const nextCell = h('div', { class: 'sch-cell sch-next' }, h('span', { class: 'sch-cell-label' }, 'Next run'), h('div', { class: 'sch-cell-body' }, nextContent(s)));
    const lastCell = h('div', { class: 'sch-cell sch-last' }, h('span', { class: 'sch-cell-label' }, 'Last run'), h('div', { class: 'sch-cell-body' }, lastContent(s)));
    const row = h(
      'li',
      { class: ['sch-row', !s.enabled && 'is-paused'], 'data-id': s.id },
      h('div', { class: 'sch-toggle' }, sw),
      h(
        'div',
        { class: 'sch-main' },
        h('div', { class: 'sch-name' }, nameOf(s)),
        h('div', { class: 'sch-meta' }, h('span', { class: 'sch-cadence' }, cadenceLabel(s)), taskBits(s)),
      ),
      nextCell,
      lastCell,
      h('div', { class: 'sch-actions' }, menuBtn),
    );
    rowRefs.set(s.id, { s, row, nextCell, lastCell, sw, menuBtn });
    return row;
  }

  function refreshRow(id) {
    const ref = rowRefs.get(id);
    if (!ref) return;
    const { s } = ref;
    ref.row.classList.toggle('is-paused', !s.enabled);
    ref.sw.setChecked(!!s.enabled);
    ref.nextCell.lastChild.replaceChildren(...nextContent(s));
    ref.lastCell.lastChild.replaceChildren(...lastContent(s));
  }

  // Keep "in 3h" / "2h ago" current. The next-run cell holds nothing focusable, so it is
  // rebuilt (the next run moves on once its slot passes); elsewhere only the text changes.
  function tick() {
    for (const { s, nextCell } of rowRefs.values()) nextCell.lastChild.replaceChildren(...nextContent(s));
    for (const t of root.querySelectorAll('.sch-last time[datetime], .sch-history time[datetime]')) {
      const d = toDate(t.getAttribute('datetime'));
      if (d) t.textContent = fmtRelative(d);
    }
  }

  // ---- Actions ----

  async function toggle(s, on) {
    await api.patch(`/api/schedules/${enc(s.id)}`, { enabled: on });
    if (!alive) return true;
    // The response's last_run is always null: keep the one on screen.
    s.enabled = on;
    refreshRow(s.id);
    if (on) toast(`${quoted(s)} is on. Next run ${runLabel(nextRuns(s, 1)[0])}.`, 'ok');
    else toast(`${quoted(s)} is paused. It won't run until you turn it back on.`, 'ok');
    store.refresh();
    return true;
  }

  function track(handle) {
    overlays.add(handle);
    return handle;
  }

  function rowMenu(s, btn) {
    const m = openMenu(btn, [
      { label: 'Run now', onSelect: () => start(s, btn, { dry: false }) },
      { label: 'Dry run', onSelect: () => start(s, btn, { dry: true }) },
      { label: 'Edit', onSelect: () => openEditor(s, btn) },
      { label: 'Delete', danger: true, onSelect: () => remove(s, btn) },
    ]);
    track(m);
  }

  /** A confirm (alertdialog) this screen owns, so leaving the screen closes it. */
  function ask({ title: t, body, confirmText, danger = false, opener }) {
    return new Promise((resolve) => {
      let yes = false;
      let dlg = null;
      dlg = openDialog({
        title: t,
        content: body,
        role: 'alertdialog',
        opener,
        actions: [
          { label: 'Cancel', kind: 'secondary', autofocus: danger },
          { label: confirmText, kind: danger ? 'danger' : 'primary', autofocus: !danger, onClick: () => { yes = true; } },
        ],
        onClose: () => {
          overlays.delete(dlg);
          resolve(yes && alive);
        },
      });
      track(dlg);
    });
  }

  // Run now / Dry run. One at a time per row (the button is busy until the run has started).
  async function start(s, btn, { dry }) {
    if (busyRows.has(s.id)) return;
    busyRows.add(s.id);
    btn.setAttribute('aria-busy', 'true');
    try {
      if (!dry) {
        // Ask with fresh settings: what this run may send is decided when it runs. A dry run
        // never asks: it can't send.
        let st = null;
        try {
          st = await api.get('/api/status');
        } catch (_) {
          st = null;
        }
        if (!alive) return;
        const p = sendingPolicy(st);
        if (p.risky) {
          const body = [
            h(
              'p',
              {},
              p.unknown
                ? "Couldn't check your auto-send settings, so this run sends whatever they allow."
                : `Auto-send is on, so this run can send up to ${p.what} without asking.`,
            ),
            p.caveat ? h('p', { class: 'text-3' }, p.caveat) : null,
            h('p', {}, 'Use Dry run to only write drafts.'),
          ];
          const ok = await ask({ title: `Run ${quoted(s)} now?`, body, confirmText: p.unknown ? 'Run now' : 'Run and allow sends', opener: btn });
          if (!ok) return;
        }
      }
      const res = await api.post(`/api/schedules/${enc(s.id)}/run`, { draft_only: dry });
      if (!alive) return;
      store.refresh();
      toast(dry ? `Dry run of ${quoted(s)} started. It only writes drafts.` : `${quoted(s)} is running.`, 'info');
      nav.navigate(href(['agent', res.chat_id]));
    } catch (err) {
      if (alive) toast((err && err.message) || String(err), 'err');
    } finally {
      busyRows.delete(s.id);
      btn.removeAttribute('aria-busy');
    }
  }

  async function remove(s, btn) {
    const ok = await ask({
      title: `Delete ${quoted(s)}?`,
      body: 'Its timer is removed and it stops running. Past runs stay in the run history.',
      confirmText: 'Delete schedule',
      danger: true,
      opener: btn,
    });
    if (!ok) return;
    try {
      await api.del(`/api/schedules/${enc(s.id)}`);
    } catch (err) {
      if (alive) toast((err && err.message) || String(err), 'err');
      return;
    }
    if (!alive) return;
    toast(`${quoted(s)} deleted.`, 'ok');
    if (schedules) schedules = schedules.filter((x) => x.id !== s.id);
    keepFocus(renderList);
    loadRuns(); // its past runs lose their schedule name
    store.refresh();
  }

  // ---- Create / edit dialog ----

  function openEditor(s, opener) {
    let editId = s ? s.id : null;
    const enabled = s ? !!s.enabled : true;
    const n = ++uid;
    const id = (k) => `sch-${k}-${n}`;
    let saved = null; // { schedule, created } once a save succeeded

    const field = (label, control, { hint, key } = {}) => {
      const err = h('p', { class: 'field-error', id: id(`${key}-err`), hidden: true });
      const hintEl = hint ? h('p', { class: 'field-hint', id: id(`${key}-hint`) }, hint) : null;
      if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
      const wrap = h('div', { class: 'field' }, h('label', { class: 'field-label', for: control.id || null }, label), control, hintEl, err);
      return { wrap, err, control, hintEl };
    };

    // Name
    const nameIn = h('input', { type: 'text', class: 'input', id: id('name'), value: s ? s.name : '', placeholder: 'e.g. Morning source + draft', autocomplete: 'off', maxlength: '120', 'data-autofocus': '' });
    const nameF = field('Name', nameIn, { key: 'name' });

    // Repeats: Daily | Weekly (a segmented radio group)
    const freqName = id('freq');
    const freqOpt = (value, label) =>
      h(
        'label',
        { class: 'sch-seg-opt' },
        h('input', { type: 'radio', name: freqName, value, checked: (s ? s.freq : 'daily') === value }),
        h('span', {}, label),
      );
    const freqGroup = h(
      'div',
      { class: 'sch-seg', role: 'radiogroup', 'aria-labelledby': id('freq-label') },
      freqOpt('daily', 'Daily'),
      freqOpt('weekly', 'Weekly'),
    );
    const freqField = h('div', { class: 'field sch-field-freq' }, h('span', { class: 'field-label', id: id('freq-label') }, 'Repeats'), freqGroup);

    // Day (weekly only)
    const daySel = h(
      'select',
      { class: 'input sch-select', id: id('day'), value: String(s && s.weekday != null ? Number(s.weekday) % 7 : 1) },
      WEEK_ORDER.map((d) => h('option', { value: String(d) }, DAY_NAMES[d])),
    );
    const dayF = field('Day', h('div', { class: 'sch-select-wrap' }, daySel, h('span', { class: 'sch-select-chevron' }, icon(ICON.chevron))), { key: 'day' });
    dayF.wrap.querySelector('label').setAttribute('for', daySel.id);
    dayF.wrap.classList.add('sch-field-day');

    // Time: a 24-hour "HH:MM" field (a native time input shows 12-hour AM/PM in many locales,
    // while every time on this screen and the OS timer is 24-hour local time).
    const [th, tm] = slot(s ? s.time : '09:00');
    const timeIn = h('input', {
      type: 'text',
      class: 'input sch-time',
      id: id('time'),
      value: `${pad(th)}:${pad(tm)}`,
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '5',
      placeholder: 'HH:MM',
    });
    const timeF = field('Time', timeIn, { key: 'time', hint: '24-hour, this computer’s time' });
    timeF.wrap.classList.add('sch-field-time');
    timeIn.addEventListener('blur', () => {
      const t = parseTime(timeIn.value);
      if (t && t !== timeIn.value) timeIn.value = t;
    });

    // Task: agent decides | custom instruction
    const taskName = id('task');
    const taskOpt = (value, label, help) =>
      h(
        'label',
        { class: 'sch-choice' },
        h('input', { type: 'radio', name: taskName, value, checked: (s ? s.task_mode : 'agent') === value, 'aria-describedby': id(`task-${value}-help`) }),
        h('span', { class: 'sch-choice-text' }, h('span', { class: 'sch-choice-label' }, label), h('span', { class: 'sch-choice-help', id: id(`task-${value}-help`) }, help)),
      );
    const taskGroup = h(
      'div',
      { class: 'sch-choices', role: 'radiogroup', 'aria-labelledby': id('task-label') },
      taskOpt('agent', 'Agent decides', 'Plans fresh searches from your company profile and skips companies already sourced.'),
      taskOpt('custom', 'Custom instruction', 'You write what every run should do.'),
    );
    const promptIn = h('textarea', { class: 'input', id: id('prompt'), rows: '3', placeholder: 'e.g. Source 20 companies like Linear and draft intros to the founders', value: s && s.prompt ? s.prompt : '' });
    const promptF = field('Instruction', promptIn, { key: 'prompt' });
    promptF.wrap.classList.add('sch-field-prompt');
    const taskField = h('div', { class: 'field' }, h('span', { class: 'field-label', id: id('task-label') }, 'Task'), taskGroup);

    // Preview + consequence
    const previewTitleId = id('preview');
    const previewHead = h('span', { class: 'field-label', id: previewTitleId }, 'Next 3 runs');
    const previewNote = h('p', { class: 'field-hint', hidden: enabled });
    previewNote.textContent = 'It’s paused, so these run once you turn it on.';
    const previewList = h('ol', { class: 'sch-preview', 'aria-labelledby': previewTitleId });
    const preview = h('div', { class: 'sch-preview-box' }, previewHead, previewList, previewNote);

    // This screen's own status read, else the shell's (still loading or failed here).
    const policy = sendingPolicy(status || store.get().status || null);
    const consequence = h(
      'div',
      { class: ['sch-consequence', policy.risky && 'is-risky'] },
      icon(policy.risky ? ICON.alert : ICON.info),
      h(
        'div',
        { class: 'sch-consequence-text' },
        h('p', {}, policy.text, ' ', h('a', { href: '#/settings?tab=sending', class: 'sch-link' }, 'Change in Settings')),
        policy.caveat ? h('p', { class: 'sch-caveat' }, policy.caveat) : null,
      ),
    );

    const formError = h('p', { class: 'sch-form-error', role: 'alert', hidden: true });
    const form = h(
      'form',
      { class: 'sch-form', novalidate: true },
      nameF.wrap,
      h('div', { class: 'sch-when-row' }, freqField, dayF.wrap, timeF.wrap),
      taskField,
      promptF.wrap,
      preview,
      consequence,
      formError,
    );

    const freq = () => (form.querySelector(`input[name="${freqName}"]:checked`) || {}).value || 'daily';
    const task = () => (form.querySelector(`input[name="${taskName}"]:checked`) || {}).value || 'agent';

    function sync() {
      const weekly = freq() === 'weekly';
      dayF.wrap.hidden = !weekly;
      promptF.wrap.hidden = task() !== 'custom';
      const time = parseTime(timeIn.value);
      const spec = { freq: freq(), time, weekday: weekly ? Number(daySel.value) : null };
      const times = time ? nextRuns(spec, 3) : [];
      previewList.replaceChildren(
        ...times.map((d, i) => {
          const rel = fmtRelative(d);
          return h(
            'li',
            {},
            h('span', { class: 'sch-run-at' }, runLabel(d)),
            i === 0 && /^in |^just now$/.test(rel) ? h('span', { class: 'sch-run-rel' }, rel) : null,
          );
        }),
      );
      if (!times.length) previewList.append(h('li', { class: 'sch-run-none' }, 'Enter a time to see when it runs.'));
    }

    function setError(f, msg) {
      f.err.textContent = msg;
      f.err.hidden = false;
      f.control.setAttribute('aria-invalid', 'true');
      f.control.setAttribute('aria-describedby', f.err.id);
      return f.control;
    }
    function clearError(f) {
      f.err.hidden = true;
      f.err.textContent = '';
      f.control.removeAttribute('aria-invalid');
      if (f.hintEl) f.control.setAttribute('aria-describedby', f.hintEl.id);
      else f.control.removeAttribute('aria-describedby');
    }
    const allFields = [nameF, timeF, promptF];
    nameIn.addEventListener('input', () => clearError(nameF));
    timeIn.addEventListener('input', () => {
      clearError(timeF);
      sync();
    });
    promptIn.addEventListener('input', () => clearError(promptF));
    form.addEventListener('change', () => {
      if (task() !== 'custom') clearError(promptF);
      sync();
    });

    async function save() {
      formError.hidden = true;
      allFields.forEach(clearError);
      const name = nameIn.value.trim();
      const f = freq();
      const time = parseTime(timeIn.value);
      const mode = task();
      const prompt = promptIn.value.trim();
      let first = null;
      if (!name) first = first || setError(nameF, 'Give it a name.');
      if (!time) first = first || setError(timeF, 'Enter a time like 09:00 or 16:30.');
      else timeIn.value = time;
      if (mode === 'custom' && !prompt) first = first || setError(promptF, 'Write what each run should do.');
      if (first) {
        first.focus();
        return false;
      }
      const body = {
        name,
        freq: f,
        time,
        weekday: f === 'weekly' ? Number(daySel.value) : null,
        task_mode: mode,
        prompt: mode === 'custom' ? prompt : null,
      };
      try {
        if (editId) {
          const res = await api.patch(`/api/schedules/${enc(editId)}`, body);
          saved = { schedule: res, created: !s };
        } else {
          const before = new Set((schedules || []).map((x) => x.id));
          try {
            const res = await api.post('/api/schedules', { ...body, enabled: true });
            saved = { schedule: res, created: true };
          } catch (err) {
            // The server writes the row before installing its timer: if that row exists now,
            // keep editing it so saving again can't create a duplicate.
            if (err && err.status >= 500) {
              const fresh = await api.get('/api/schedules').catch(() => null);
              const added = listOf(fresh, 'schedules').find((x) => !before.has(x.id) && x.name === name);
              if (added && alive) {
                editId = added.id;
                schedules = listOf(fresh, 'schedules');
                keepFocus(renderList);
                saveBtn.textContent = 'Save changes';
                throw Object.assign(new Error(`Saved, but its timer wasn't installed: ${err.message}`), { shown: true });
              }
            }
            throw err;
          }
        }
      } catch (err) {
        if (!alive) return false;
        formError.textContent = err && err.shown ? err.message : `Couldn't save: ${(err && err.message) || err}`;
        formError.hidden = false;
        return false;
      }
      return true;
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (saveBtn && !saveBtn.disabled) saveBtn.click();
    });
    // Enter in a one-line field saves (implicit submission needs a single text field).
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      if (saveBtn && !saveBtn.disabled) saveBtn.click();
    });

    sync();
    let dlg = null;
    dlg = openDialog({
      title: s ? 'Edit schedule' : 'New schedule',
      content: form,
      opener,
      actions: [
        { label: 'Cancel', kind: 'secondary' },
        { label: s ? 'Save changes' : 'Create schedule', kind: 'primary', onClick: save },
      ],
      onClose: () => {
        overlays.delete(dlg);
        if (saved && alive) afterSave(saved);
      },
    });
    track(dlg);
    dlg.el.classList.add('sch-dialog');
    const saveBtn = dlg.el.querySelector('.dialog-actions .btn-primary');
  }

  // Runs once the dialog has closed and focus is back on its opener, so re-rendering the list
  // can put focus back on the same row control.
  function afterSave({ schedule, created }) {
    const s = schedule;
    const at = (schedules || []).findIndex((x) => x.id === s.id);
    if (at >= 0) {
      s.last_run = schedules[at].last_run; // the response's last_run is always null
      schedules[at] = s;
    } else if (schedules) {
      schedules.push(s);
    } else {
      schedules = [s];
    }
    keepFocus(renderList);
    const when = s.enabled ? ` ${created ? 'First' : 'Next'} run ${runLabel(nextRuns(s, 1)[0])}.` : ' It’s paused.';
    toast(`${quoted(s)} ${created ? 'created' : 'saved'}.${when}`, 'ok');
    loadSchedules({ announce: true });
    store.refresh();
  }

  // ---- Run history ----

  function renderHistory() {
    historySection.setAttribute('aria-busy', runs == null && !errRuns ? 'true' : 'false');
    historyDesc.hidden = !(runs && runs.length);
    if (runs == null) {
      historyBody.replaceChildren(
        errRuns
          ? errorBlock('Run history', errRuns, () => {
            errRuns = null;
            renderHistory();
            loadRuns();
          })
          : h('div', { class: 'sch-history-skel' }, h('span', { class: 'sr-only' }, 'Loading run history…'), ...skeletonRows(3)),
      );
      return;
    }
    if (!runs.length) {
      historyBody.replaceChildren(h('div', { class: 'sch-history-empty' }, icon(ICON.clock, 18), h('p', {}, 'No runs yet. Runs show up here when they finish.')));
      return;
    }
    const num = (key, label) => ({ key, label, align: 'right', nowrap: true, render: (r) => h('span', { class: 'mono num' }, fmtNum(r[key])) });
    historyBody.replaceChildren(
      table({
        label: 'Run history',
        rows: runs,
        rowKey: (r) => `${r.started_at}|${r.chat_id || ''}|${r.schedule_name || ''}`,
        columns: [
          {
            key: 'started_at',
            label: 'Finished',
            nowrap: true,
            render: (r) => {
              const d = toDate(r.started_at);
              return d ? h('time', { class: 'mono', datetime: d.toISOString(), title: fmtDate(d, { time: true }) }, fmtRelative(d)) : '—';
            },
          },
          {
            key: 'schedule_name',
            label: 'Schedule',
            nowrap: true,
            render: (r) => (r.schedule_name ? h('span', { class: 'sch-run-name' }, r.schedule_name) : h('span', { class: 'text-3' }, 'No schedule')),
          },
          { key: 'trigger', label: 'Trigger', nowrap: true, render: (r) => TRIGGERS[r.trigger] || (r.trigger ? r.trigger : '—') },
          {
            key: 'status',
            label: 'Status',
            nowrap: true,
            render: (r) => {
              const [label, tone] = RUN_STATUS[r.status] || [r.status || 'Unknown', 'neutral'];
              return badge(label, tone);
            },
          },
          num('sourced', 'Sourced'),
          num('enriched', 'Enriched'),
          num('drafted', 'Drafted'),
          num('sent', 'Sent'),
          {
            key: 'view',
            label: h('span', { class: 'sr-only' }, 'Conversation'),
            nowrap: true,
            align: 'right',
            render: (r) =>
              r.chat_id
                ? h(
                  'a',
                  { class: 'sch-link', href: href(['agent', r.chat_id]), 'data-focus-key': `run:${r.chat_id}` },
                  'View run',
                  h('span', { class: 'sr-only' }, ` (${r.schedule_name || 'no schedule'}, ${fmtDate(r.started_at, { time: true })})`),
                )
                : null,
          },
        ],
      }),
    );
  }

  // ---- Shared store: a finished run or a live one updates the rows ----

  const unsubscribe = store.subscribe(({ summary, status: st }) => {
    if (!alive) return;
    if (st) {
      status = st;
      renderDesc();
    }
    const key = runKey(summary);
    if (summary && key !== lastRunKey) {
      lastRunKey = key;
      loadSchedules();
      loadRuns();
    }
    const now = runningOf(summary);
    if (summary && (now && now.chat_id) !== (running && running.chat_id)) {
      running = now;
      keepFocus(() => {
        for (const id of rowRefs.keys()) refreshRow(id);
      });
    }
  });

  const ticker = setInterval(tick, TICK_MS);
  loadAll();

  const self = {
    update(next) {
      if (next.query && next.query.new) {
        nav.setQuery({ new: null });
        if (![...overlays].length) openEditor(null, newBtn);
      }
    },
    unmount() {
      alive = false;
      clearInterval(ticker);
      unsubscribe();
      for (const ctl of Object.values(ctls)) if (ctl) ctl.abort();
      for (const o of [...overlays]) {
        try {
          o.close();
        } catch (_) {
          /* already closed */
        }
      }
      overlays.clear();
    },
  };
  // ?new=1 (e.g. from Home or the setup finish screen) opens the dialog once the screen is up.
  if (ctx.query && ctx.query.new) queueMicrotask(() => alive && self.update(ctx));
  return self;
}

function runKey(summary) {
  const lr = summary && summary.last_run;
  return lr ? `${lr.started_at}|${lr.status}|${lr.chat_id || ''}` : '';
}

function runningOf(summary) {
  return (summary && summary.running) || null;
}

export default {
  title,
  css: true,
  mount(root, ctx) {
    const screen = mountSchedules(root, ctx);
    current = screen;
    return () => {
      screen.unmount();
      if (current === screen) current = null;
    };
  },
  update(ctx) {
    if (!current) return false;
    current.update(ctx);
    return true;
  },
};

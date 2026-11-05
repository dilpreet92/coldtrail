// Feedback and overlays (spec §4): toasts, confirm/dialog, drawer, menu, plus busy buttons and
// copy-to-clipboard. Overlays live in #overlays, stack (Esc closes the top one), trap Tab inside,
// make the app behind a modal inert, and give focus back to whatever opened them: the `opener`
// option when given (a menu's anchor), else the element focused at open, else #view. Pass
// `opener` when the triggering control is known: WebKit does not focus a clicked button, so a
// mouse-opened overlay sees <body> focused. Dialogs, confirms, drawers and menus take an
// AbortSignal (`signal`) that closes them, so a view can tie them to its own lifetime. Dialogs and
// drawers take beforeClose(reason) to keep themselves open (unsaved typing). Every open overlay
// carries [data-overlay], which keys.js checks so page shortcuts stay off while one is open (⌘K
// closes the top one with closeTopOverlay() instead). Toasts on screen when a modal opens step
// aside (hidden) until it closes, so a sticky error never covers its buttons; toasts raised while
// it is open (its own action failing) show over it.
//
// Class hooks for components.css: .overlay (.overlay-dialog | .overlay-drawer: the backdrop),
// .dialog > .dialog-head (.dialog-title, .overlay-close) + .dialog-body + .dialog-actions
// (.btn.btn-<kind>); .drawer > .drawer-head (.drawer-title, .overlay-close) + .drawer-body;
// .menu > .menu-item (.menu-item-danger), positioned inline; .toast.toast-<info|ok|err> >
// .toast-text + .toast-close (multi-line text needs white-space: pre-line); .icon-btn;
// html.has-overlay while a modal is open; .spinner inside a .btn[aria-busy="true"] (setBusy).

import { h } from './dom.js';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(',');

const TOAST_MS = 4000;
const stack = []; // open overlays, topmost last
let uid = 0;
let appWasInert = false;

const nextId = (p) => `${p}-${++uid}`;

// Of a radio group only the checked radio takes Tab (or the first one when none is checked).
function radioSkipped(el, root) {
  if (el.type !== 'radio' || el.checked || !el.name) return false;
  const group = [...root.querySelectorAll('input[type="radio"]')].filter((r) => r.name === el.name);
  return group.some((r) => r.checked) || group[0] !== el;
}

/** Tabbable, visible elements inside `root`, in DOM order. */
function tabbables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.closest('[hidden],[inert]') &&
      el.getClientRects().length > 0 &&
      !radioSkipped(el, root),
  );
}

function icon(d) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d }),
  );
}
const CLOSE_ICON = 'M6 6l12 12M18 6L6 18';

/** content: string → <p>, Node → as is, array → each, null → nothing. */
function toNodes(content) {
  if (content == null || content === false) return [];
  if (Array.isArray(content)) return content.flatMap(toNodes);
  if (typeof content === 'object') return [content];
  return [h('p', {}, String(content))];
}

function overlayRoot() {
  let root = document.getElementById('overlays');
  if (!root) {
    root = h('div', { id: 'overlays' });
    document.body.append(root);
  }
  return root;
}

function topModalIndex() {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].modal) return i;
  return -1;
}

// The app (and any overlay under the top modal) is inert while a modal is open.
function syncInert() {
  const top = topModalIndex();
  const app = document.getElementById('app');
  if (app) {
    if (top >= 0 && !app.hasAttribute('data-overlay-inert')) {
      appWasInert = app.inert;
      app.setAttribute('data-overlay-inert', '');
      app.inert = true;
    } else if (top < 0 && app.hasAttribute('data-overlay-inert')) {
      app.removeAttribute('data-overlay-inert');
      app.inert = appWasInert;
    }
  }
  stack.forEach((o, i) => {
    o.el.inert = i < top;
  });
  document.documentElement.classList.toggle('has-overlay', top >= 0);
}

// Hide the toasts on screen and return them, for releaseToasts() once the modal holding them
// closes.
function holdToasts() {
  const host = document.getElementById('toasts');
  if (!host) return [];
  const shown = [...host.children].filter((t) => !t.hidden);
  for (const t of shown) t.hidden = true;
  return shown;
}

function releaseToasts(toasts) {
  for (const t of toasts) if (t.isConnected) t.hidden = false;
}

function restoreFocus(opener) {
  const target = opener && opener.isConnected ? opener : document.getElementById('view');
  if (target) {
    try {
      target.focus({ preventScroll: true });
    } catch (_) {
      /* not focusable */
    }
  }
}

function trapTab(e, panel) {
  const items = tabbables(panel);
  if (!items.length) {
    e.preventDefault();
    panel.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !panel.contains(at))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === last || !panel.contains(at))) {
    e.preventDefault();
    first.focus();
  }
}

function onKeydown(e) {
  const top = stack[stack.length - 1];
  if (!top || e.defaultPrevented) return;
  if (e.key === 'Escape' || e.key === 'Esc') {
    e.preventDefault();
    e.stopPropagation();
    top.close('escape');
    return;
  }
  if (top.onKey && top.onKey(e)) return;
  if (e.key === 'Tab') trapTab(e, top.panel);
}

// Focus may only be inside the top modal or an overlay above it (e.g. its menu) or a toast.
function onFocusIn(e) {
  const top = topModalIndex();
  if (top < 0) return;
  const t = e.target;
  if (stack.slice(top).some((o) => o.el.contains(t))) return;
  const toasts = document.getElementById('toasts');
  if (toasts && toasts.contains(t)) return;
  const panel = stack[top].panel;
  (tabbables(panel)[0] || panel).focus({ preventScroll: true });
}

// A press outside an open menu closes it (focus goes wherever the press puts it).
function onPointerDown(e) {
  for (const o of [...stack].reverse()) {
    if (o.kind !== 'menu') continue;
    if (o.el.contains(e.target) || (o.anchor && o.anchor.contains(e.target))) continue;
    o.close('outside', { restore: false });
  }
}

// Scroll / resize keep an open menu on its anchor; it closes once the anchor is gone or
// scrolled out of view. (Closing on any scroll would also catch a scroll event still queued
// from the click that opened it.)
function onViewportChange(e) {
  for (const o of [...stack]) {
    if (o.kind !== 'menu') continue;
    if (e.type === 'scroll' && o.el.contains(e.target)) continue;
    const r = o.anchor.getBoundingClientRect();
    const offscreen = r.bottom < 0 || r.top > window.innerHeight || (r.width === 0 && r.height === 0);
    if (!o.anchor.isConnected || offscreen) o.close('outside', { restore: false });
    else placeMenu(o.el, o.anchor);
  }
}

let listening = false;
function listen(on) {
  if (on === listening) return;
  listening = on;
  const fn = on ? 'addEventListener' : 'removeEventListener';
  document[fn]('keydown', onKeydown);
  document[fn]('focusin', onFocusIn);
  document[fn]('pointerdown', onPointerDown, true);
  window[fn]('resize', onViewportChange);
  window[fn]('scroll', onViewportChange, true);
}

// Ask beforeClose(reason) → whether to go on closing: true, false, or a Promise of either
// (`undefined` and anything but false count as yes). A throw or rejection is only a warning and
// lets the close go on, so a broken guard never traps the user in an overlay.
function askBeforeClose(beforeClose, reason) {
  let answer;
  try {
    answer = beforeClose(reason);
  } catch (err) {
    console.warn(err);
    return true;
  }
  if (answer && typeof answer.then === 'function') {
    return Promise.resolve(answer).then(
      (ok) => ok !== false,
      (err) => {
        console.warn(err);
        return true;
      },
    );
  }
  return answer !== false;
}

/**
 * Put an overlay on the stack. el: the root appended to #overlays; panel: the element that
 * holds focus; opener: where focus goes back on close (default: the element focused now).
 * beforeClose(reason): asked first by every close but a forced one (see askBeforeClose); while
 * its Promise is pending further closes are ignored. Returns the entry with
 * close(reason, { restore = true, force = false }).
 */
function pushOverlay({ el, panel, modal, kind, anchor = null, opener = null, onKey = null, onClose = null, beforeClose = null, initialFocus }) {
  const active = document.activeElement;
  const entry = { el, panel, modal, kind, anchor, onKey, closed: false, asking: false, toasts: [] };
  entry.opener = opener || (active && active !== document.body ? active : null);
  entry.close = (reason = 'api', { restore = true, force = false } = {}) => {
    if (entry.closed) return;
    if (beforeClose && !force) {
      if (entry.asking) return;
      const go = askBeforeClose(beforeClose, reason);
      if (go === false) return;
      if (go !== true) {
        entry.asking = true;
        go.then((ok) => {
          entry.asking = false;
          if (ok) entry.close(reason, { restore, force: true });
        });
        return;
      }
    }
    entry.closed = true;
    const i = stack.indexOf(entry);
    const wasTop = i === stack.length - 1;
    stack.splice(i, 1);
    // An overlay opened from this one now returns focus to this one's opener instead.
    if (!wasTop && stack[i] && stack[i].opener && el.contains(stack[i].opener)) stack[i].opener = entry.opener;
    // The toasts it held come back, unless a modal opened over it is still open: that one holds
    // them now.
    const above = stack.slice(i).filter((o) => o.modal).pop();
    if (above) above.toasts.push(...entry.toasts);
    else releaseToasts(entry.toasts);
    el.remove();
    syncInert();
    if (!stack.length) listen(false);
    if (wasTop && restore) restoreFocus(entry.opener);
    if (onClose) {
      try {
        onClose(reason);
      } catch (err) {
        console.error(err);
      }
    }
  };
  if (modal) entry.toasts = holdToasts();
  overlayRoot().append(el);
  stack.push(entry);
  listen(true);
  syncInert();
  const target = (initialFocus && initialFocus()) || panel;
  try {
    target.focus({ preventScroll: true });
  } catch (_) {
    /* not focusable */
  }
  return entry;
}

// Close an overlay when `signal` aborts, as a code close ('api') that beforeClose can't stop (the
// owner is going away). Returns the listener's remover.
function closeOnAbort(signal, close) {
  if (!signal) return () => {};
  if (signal.aborted) {
    close('api', { force: true });
    return () => {};
  }
  const onAbort = () => close('api', { force: true });
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** Close the overlay on top as Esc would (reason 'escape'). → whether one was open. */
export function closeTopOverlay(reason = 'escape') {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close(reason);
  return true;
}

function closeButton(onClick) {
  return h('button', { type: 'button', class: 'icon-btn overlay-close', 'aria-label': 'Close', onClick }, icon(CLOSE_ICON));
}

// Backdrop click closes, but only when the press also started on the backdrop (so a text
// selection dragged out of the panel doesn't close it).
function closeOnBackdrop(backdrop, close) {
  let downOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => {
    downOnBackdrop = e.target === backdrop;
  });
  backdrop.addEventListener('click', (e) => {
    if (downOnBackdrop && e.target === backdrop) close('backdrop');
    downOnBackdrop = false;
  });
}

/**
 * toast(text, kind = 'info' | 'ok' | 'err'). Info and ok toasts leave after 4s (paused while
 * hovered or focused); errors stay until closed. Text only (newlines kept by CSS).
 * Returns { close, el }.
 */
export function toast(text, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const k = kind === 'ok' || kind === 'err' ? kind : 'info';
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  const el = h(
    'div',
    { class: `toast toast-${k}`, role: k === 'err' ? 'alert' : null },
    h('div', { class: 'toast-text' }, text == null ? '' : String(text)),
    h('button', { type: 'button', class: 'icon-btn toast-close', 'aria-label': 'Dismiss', onClick: close }, icon(CLOSE_ICON)),
  );
  if (k !== 'err') {
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(close, TOAST_MS);
    };
    const hold = () => clearTimeout(timer);
    el.addEventListener('mouseenter', hold);
    el.addEventListener('focusin', hold);
    el.addEventListener('mouseleave', () => {
      if (!el.contains(document.activeElement)) arm();
    });
    el.addEventListener('focusout', (e) => {
      if (!el.contains(e.relatedTarget)) arm();
    });
    arm();
  }
  host.append(el);
  return { close, el };
}

/**
 * openDialog({ title, content, actions: [{ label, kind = 'secondary', onClick?, autofocus? }],
 * onClose?(reason), beforeClose?(reason), opener?, signal? }) → { close, el }. An action without
 * onClick just closes. Otherwise the dialog closes after onClick unless it returns (or resolves
 * to) false; while a returned Promise is pending the buttons are disabled, and if it rejects the
 * dialog stays open and its message is shown as an error toast. Initial focus: [data-autofocus] /
 * [autofocus], else the first field in the body, else the first action. Aborting `signal` closes
 * it ('api').
 *
 * beforeClose(reason) runs before any other close: reason is 'escape' (Esc, or ⌘K through
 * closeTopOverlay), 'backdrop' (a click beside the panel), 'button' (the × close button) or 'api'
 * (handle.close() from code). Returning false, or a Promise that resolves to false, keeps the
 * dialog open; while that Promise is pending other close attempts are ignored. A throw or a
 * rejection is logged as a warning and the dialog closes. Not asked when an action closes it (its
 * onClick decides), when `signal` aborts, or for handle.close(reason, { force: true }).
 * handle.close(reason = 'api', { force = false }).
 */
export function openDialog({ title, content, actions = [], onClose, beforeClose = null, role = 'dialog', opener = null, signal = null }) {
  const titleId = nextId('dialog-title');
  const bodyId = nextId('dialog-body');
  let entry;
  let unlisten = () => {};
  const handle = { close: (reason = 'api', { force = false } = {}) => entry.close(reason, { force }) };

  const buttons = actions.map((a) =>
    h('button', { type: 'button', class: `btn btn-${a.kind || 'secondary'}`, 'data-autofocus': a.autofocus ? '' : null }, a.label),
  );
  const setActionsBusy = (busy) => {
    // Disabling the focused button would drop focus to <body>; keep it in the dialog.
    if (busy && buttons.includes(document.activeElement)) panel.focus({ preventScroll: true });
    for (const b of buttons) b.disabled = busy;
    panel.setAttribute('aria-busy', busy ? 'true' : 'false');
  };
  actions.forEach((a, i) => {
    buttons[i].addEventListener('click', async () => {
      if (!a.onClick) {
        entry.close('action', { force: true });
        return;
      }
      let result;
      try {
        result = a.onClick(handle);
        if (result && typeof result.then === 'function') {
          setActionsBusy(true);
          result = await result;
        }
      } catch (err) {
        if (entry.closed) return;
        setActionsBusy(false);
        toast((err && err.message) || String(err), 'err');
        return;
      }
      if (entry.closed) return;
      setActionsBusy(false);
      if (result !== false) entry.close('action', { force: true });
    });
  });

  const body = h('div', { class: 'dialog-body', id: bodyId }, toNodes(content));
  const panel = h(
    'div',
    {
      class: 'dialog',
      role,
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      'aria-describedby': role === 'alertdialog' ? bodyId : null,
      tabindex: '-1',
    },
    h('div', { class: 'dialog-head' }, h('h2', { class: 'dialog-title', id: titleId }, title), closeButton(() => entry.close('button'))),
    body,
    buttons.length ? h('div', { class: 'dialog-actions' }, buttons) : null,
  );
  const backdrop = h('div', { class: 'overlay overlay-dialog', 'data-overlay': 'dialog' }, panel);
  entry = pushOverlay({
    el: backdrop,
    panel,
    modal: true,
    kind: 'dialog',
    opener,
    beforeClose,
    onClose: (reason) => {
      unlisten();
      if (onClose) onClose(reason);
    },
    initialFocus: () =>
      panel.querySelector('[data-autofocus],[autofocus]') || tabbables(body)[0] || buttons[0] || null,
  });
  closeOnBackdrop(backdrop, entry.close);
  unlisten = closeOnAbort(signal, entry.close);
  return { close: handle.close, el: panel };
}

/**
 * confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false,
 * opener?, signal? }) → Promise<boolean>: true only when the confirm button is pressed. Every
 * confirm opens on Cancel, danger or not: what it guards (a send, auto-send, a higher cap) can't
 * be taken back, so an Enter pressed twice or held never confirms; Tab reaches the confirm
 * button. `danger` makes that button red. Aborting `signal` (e.g. the view's, on unmount) closes
 * it with false; an already aborted one never opens.
 */
export function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false, opener = null, signal = null }) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve(false);
      return;
    }
    let confirmed = false;
    openDialog({
      title,
      content: body,
      role: 'alertdialog',
      opener,
      signal,
      actions: [
        { label: cancelText, kind: 'secondary', autofocus: true },
        { label: confirmText, kind: danger ? 'danger' : 'primary', onClick: () => { confirmed = true; } },
      ],
      onClose: () => resolve(confirmed),
    });
  });
}

/**
 * openDrawer({ title, content, onClose?(reason), beforeClose?(reason), opener?, signal? }) →
 * { close, el, body, setTitle }. A right-side modal panel; reason is 'escape' | 'backdrop' |
 * 'button' | 'api' (close() from code, or `signal` aborting), so a route-driven drawer can update
 * the URL only for user closes. beforeClose works as for openDialog: false (or a Promise of false)
 * keeps the drawer open; a `signal` abort and close(reason, { force: true }) skip it.
 * close(reason = 'api', { force = false }).
 */
export function openDrawer({ title, content, onClose, beforeClose = null, opener = null, signal = null }) {
  const titleId = nextId('drawer-title');
  let entry;
  let unlisten = () => {};
  const heading = h('h2', { class: 'drawer-title', id: titleId }, title);
  const body = h('div', { class: 'drawer-body' }, toNodes(content));
  const panel = h(
    'aside',
    { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'drawer-head' }, heading, closeButton(() => entry.close('button'))),
    body,
  );
  const backdrop = h('div', { class: 'overlay overlay-drawer', 'data-overlay': 'drawer' }, panel);
  entry = pushOverlay({
    el: backdrop,
    panel,
    modal: true,
    kind: 'drawer',
    opener,
    beforeClose,
    onClose: (reason) => {
      unlisten();
      if (onClose) onClose(reason);
    },
    initialFocus: () => panel.querySelector('[data-autofocus],[autofocus]'),
  });
  closeOnBackdrop(backdrop, entry.close);
  unlisten = closeOnAbort(signal, entry.close);
  return {
    close: (reason = 'api', { force = false } = {}) => entry.close(reason, { force }),
    el: panel,
    body,
    setTitle: (t) => heading.replaceChildren(String(t ?? '')),
  };
}

function placeMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const gap = 4;
  const edge = 8;
  // Right-align under anchors in the right half (row ⋯ menus), left-align otherwise.
  let left = r.left + r.width / 2 > vw / 2 ? r.right - mw : r.left;
  left = Math.max(edge, Math.min(left, vw - mw - edge));
  let top = r.bottom + gap;
  if (top + mh > vh - edge && r.top - gap - mh >= edge) top = r.top - gap - mh;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(edge, top))}px`;
}

/**
 * openMenu(anchor, [{ label, onSelect, danger?, disabled? }], { signal?, onClose? } = {}) →
 * { close }. Opens below the anchor (flips up near the bottom). Arrow keys / Home / End / Tab move
 * between items, Enter or Space picks one, Esc closes and refocuses the anchor, a press outside
 * closes. Calling it again for the anchor of the open menu closes that menu (toggle).
 * signal: aborting it closes the menu ('api'; focus goes back to the anchor if it is still in the
 * page); an already aborted one never opens it. onClose(reason) runs once the menu has closed,
 * however it closed: 'select' (before the item's onSelect runs) | 'escape' | 'outside' (a press
 * elsewhere, or the anchor scrolled away) | 'toggle' (its anchor pressed again, or another menu
 * opened) | 'api' (close() or the signal).
 */
export function openMenu(anchor, items, { signal = null, onClose = null } = {}) {
  const open = stack.find((o) => o.kind === 'menu');
  if (open) {
    const same = open.anchor === anchor;
    open.close('toggle', { restore: same });
    if (same) return { close() {} };
  }
  if (signal && signal.aborted) return { close() {} };
  let entry;
  let unlisten = () => {};
  const buttons = items.map((it) =>
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        tabindex: '-1',
        class: ['menu-item', it.danger && 'menu-item-danger'],
        disabled: !!it.disabled,
        onClick: () => {
          entry.close('select');
          if (it.onSelect) it.onSelect();
        },
      },
      it.label,
    ),
  );
  const menu = h('div', { class: 'menu', role: 'menu', tabindex: '-1', 'data-overlay': 'menu', style: 'position: fixed; top: 0; left: 0' }, buttons);
  const enabled = () => buttons.filter((b) => !b.disabled);
  const move = (delta, to = null) => {
    const list = enabled();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    let i;
    if (to === 'first') i = 0;
    else if (to === 'last') i = list.length - 1;
    else i = at < 0 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
    list[i].focus();
  };
  const onKey = (e) => {
    const keys = { ArrowDown: [1], ArrowUp: [-1], Home: [0, 'first'], End: [0, 'last'], Tab: [e.shiftKey ? -1 : 1] };
    const k = keys[e.key];
    if (!k) return false;
    e.preventDefault();
    move(...k);
    return true;
  };
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');
  entry = pushOverlay({
    el: menu,
    panel: menu,
    modal: false,
    kind: 'menu',
    anchor,
    opener: anchor,
    onKey,
    onClose: (reason) => {
      unlisten();
      anchor.setAttribute('aria-expanded', 'false');
      if (onClose) onClose(reason);
    },
    initialFocus: () => {
      placeMenu(menu, anchor);
      return enabled()[0] || null;
    },
  });
  unlisten = closeOnAbort(signal, entry.close);
  return { close: () => entry.close('api') };
}

// ---- Busy buttons ----

const busyState = new WeakMap(); // button → { nodes, ariaDisabled } from before it was busy
const pressGuarded = new WeakSet();

/** True while setBusy(button, true) is in effect. */
export function isBusy(button) {
  return !!button && button.getAttribute('aria-busy') === 'true';
}

/**
 * setBusy(button, on, { label }?) marks a button busy without disabling it (a disabled button
 * drops focus to <body>): aria-busy + aria-disabled, a leading .spinner, and presses ignored until
 * setBusy(button, false) puts back what it showed before (and its own aria-disabled). `label`
 * replaces the text meanwhile ("Saving…"). components.css keeps a busy .btn at full strength,
 * unlike a disabled one.
 */
export function setBusy(button, on, { label } = {}) {
  if (!button) return;
  if (!pressGuarded.has(button)) {
    pressGuarded.add(button);
    // Capture listeners on the target run before its own click handlers.
    button.addEventListener(
      'click',
      (e) => {
        if (!isBusy(button)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
  }
  if (on) {
    let state = busyState.get(button);
    if (!state) {
      state = { nodes: [...button.childNodes], ariaDisabled: button.getAttribute('aria-disabled') };
      busyState.set(button, state);
    }
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    const spinner = h('span', { class: 'spinner', 'aria-hidden': 'true' });
    if (label != null) button.replaceChildren(spinner, h('span', {}, String(label)));
    else button.replaceChildren(spinner, ...state.nodes);
    return;
  }
  const state = busyState.get(button);
  if (!state) return;
  busyState.delete(button);
  button.removeAttribute('aria-busy');
  if (state.ariaDisabled == null) button.removeAttribute('aria-disabled');
  else button.setAttribute('aria-disabled', state.ariaDisabled);
  button.replaceChildren(...state.nodes);
}

// ---- Clipboard ----

/**
 * copyText(text) → Promise<boolean>: whether it reached the clipboard. The Clipboard API, else a
 * hidden textarea + execCommand('copy') (placed in the open overlay, if any, since the app behind
 * a modal is inert); focus goes back where it was.
 */
export async function copyText(text) {
  const value = text == null ? '' : String(text);
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) {
    /* denied or unavailable: try the fallback */
  }
  const active = document.activeElement;
  const top = stack[stack.length - 1];
  const ta = h('textarea', { class: 'sr-only', readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
  ta.value = value;
  (top ? top.panel : document.body).append(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ok = document.execCommand('copy') === true;
  } catch (_) {
    ok = false;
  }
  ta.remove();
  if (active && active !== document.body && typeof active.focus === 'function') {
    try {
      active.focus({ preventScroll: true });
    } catch (_) {
      /* not focusable */
    }
  }
  return ok;
}

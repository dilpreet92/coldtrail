// Keyboard shortcuts (spec §4, §5.4): ⌘K / Ctrl+K, J/K, Enter, Esc, ⌘/Ctrl+Enter. Plain keys are
// ignored while the user is typing, and every key is ignored while an overlay (dialog, drawer,
// menu) is open, or while the shell holds the page's keys (holdPageKeys: the phone menu covers
// the page): the overlay or menu owns the keyboard then. The exception is ⌘K / Ctrl+K (global
// search): its handler still runs and decides. If it can act it calls clearOverlay() first, which
// closes the overlay on top as Esc would; if it can't (Setup hides the search) it returns false
// and the overlay and the browser's own shortcut are left alone. Only one bindKeys map (the
// shell's) should bind mod+k.

import { closeTopOverlay } from './ui.js';

// Shortcuts that still work from inside a text field.
const WHILE_TYPING = new Set(['mod+k', 'escape', 'mod+enter']);
// Shortcuts whose handler runs even while an overlay is open (it calls clearOverlay() itself).
const OVER_OVERLAYS = new Set(['mod+k']);
const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const CONTROL_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const CONTROL_ROLES = new Set(['button', 'link', 'switch', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'combobox']);

const normalize = (combo) => combo.toLowerCase().replace(/\besc\b/, 'escape');

let held = false;

/**
 * holdPageKeys(true) turns every shortcut but mod+k off, as an open overlay does, until
 * holdPageKeys(false). For the shell's phone menu: it covers the page (made inert) without being
 * an overlay, so J must not move the selection behind it. (Not [data-overlay]: clearOverlay()
 * would then never see the overlays cleared.)
 */
export function holdPageKeys(on) {
  held = !!on;
}

/** "mod+k", "shift+j", "escape" … from a KeyboardEvent (mod = ⌘ or Ctrl). */
export function comboOf(e) {
  let key = String(e.key || '').toLowerCase();
  if (key === 'esc') key = 'escape';
  if (key === ' ') key = 'space';
  const mods = [];
  if (e.metaKey || e.ctrlKey) mods.push('mod');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  return [...mods, key].join('+');
}

/** True when keystrokes go into a text field or contenteditable. */
export function isTyping(target) {
  return !!target && (target.isContentEditable === true || TEXT_TAGS.has(target.tagName));
}

// Enter on a button, link or ARIA control keeps its native action.
function isControl(target) {
  if (!target) return false;
  if (CONTROL_TAGS.has(target.tagName)) return true;
  const role = typeof target.getAttribute === 'function' ? target.getAttribute('role') : null;
  return CONTROL_ROLES.has(role);
}

/**
 * For a mod+k handler that is going to act: close the overlay on top as Esc would → true when no
 * overlay is left open (go on), false while another is still open (stop and return true: the
 * next press closes that one). With nothing open it just returns true.
 */
export function clearOverlay() {
  if (!document.querySelector('[data-overlay]')) return true;
  closeTopOverlay('escape');
  return !document.querySelector('[data-overlay]');
}

/**
 * bindKeys({ 'mod+k': fn, j: fn, k: fn, escape: fn, enter: fn, 'mod+enter': fn }) → unbind.
 * fn(event) runs and the event is consumed (preventDefault) unless fn returns false. While an
 * overlay is open (or holdPageKeys holds the keys) only mod+k runs, and its fn deals with the
 * overlay (see clearOverlay).
 */
export function bindKeys(map) {
  const handlers = new Map(Object.entries(map).map(([k, fn]) => [normalize(k), fn]));
  const onKeydown = (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const combo = comboOf(e);
    const fn = handlers.get(combo);
    if (!fn) return;
    if (isTyping(e.target) && !WHILE_TYPING.has(combo)) return;
    if (combo === 'enter' && isControl(e.target)) return;
    if (!OVER_OVERLAYS.has(combo) && (held || document.querySelector('[data-overlay]'))) return;
    if (fn(e) !== false) e.preventDefault();
  };
  document.addEventListener('keydown', onKeydown);
  return () => document.removeEventListener('keydown', onKeydown);
}

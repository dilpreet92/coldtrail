// Keyboard shortcuts (spec §4, §5.4): ⌘K / Ctrl+K, J/K, Enter, Esc, ⌘/Ctrl+Enter. Plain keys are
// ignored while the user is typing, and every key is ignored while an overlay (dialog, drawer,
// menu) is open: the overlay owns the keyboard then.

// Shortcuts that still work from inside a text field.
const WHILE_TYPING = new Set(['mod+k', 'escape', 'mod+enter']);
const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const CONTROL_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const CONTROL_ROLES = new Set(['button', 'link', 'switch', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'combobox']);

const normalize = (combo) => combo.toLowerCase().replace(/\besc\b/, 'escape');

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
 * bindKeys({ 'mod+k': fn, j: fn, k: fn, escape: fn, enter: fn, 'mod+enter': fn }) → unbind.
 * fn(event) runs and the event is consumed (preventDefault) unless fn returns false.
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
    if (document.querySelector('[data-overlay]')) return;
    if (fn(e) !== false) e.preventDefault();
  };
  document.addEventListener('keydown', onKeydown);
  return () => document.removeEventListener('keydown', onKeydown);
}

// Searchable select (spec §5.1, §5.3): a combobox input over a listbox (ARIA 1.2 pattern, focus
// stays in the input and aria-activedescendant names the active option). A click or ArrowDown
// opens it; typing filters labels and values case-insensitively; Enter picks the active option,
// else the only/first match, else (with `freeText`) what was typed; Esc closes and puts back the
// chosen label. Options are text, never HTML. The list opens under the input (above it when
// there is more room there) and stays inside the viewport: the room it has is set on the
// component as --ss-room-x / --ss-room-y, and .ss-up marks it opening upwards. A `pinned`
// option ("All sources") heads the list while nothing is typed and is never matched by typing.

import { fmtNum, h } from '../core/dom.js';

const MAX_SHOWN = 200;
const LIST_MAX = 280; // px, the list's height when there is room (components.css)
const EDGE = 8; // px kept clear of the viewport's edges
let uid = 0;

function svg(d, size = 16) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d }),
  );
}

const labelText = (o) => String(o.label ?? o.value ?? '');

/**
 * The options whose label or value contains `text` (trimmed, any case); all for blank text.
 * Options with `pinned: true` come first (in their own order) for blank text and are left out
 * for any other text.
 */
export function filterOptions(options, text) {
  const q = String(text ?? '').trim().toLowerCase();
  if (!q) return [...options.filter((o) => o.pinned), ...options.filter((o) => !o.pinned)];
  return options.filter(
    (o) => !o.pinned && (labelText(o).toLowerCase().includes(q) || String(o.value ?? '').toLowerCase().includes(q)),
  );
}

/**
 * searchSelect({ options: [{ value, label?, count?, pinned? }], value, placeholder?, label,
 * onChange(value), freeText = false, hideLabel = false, clearable = true, disabled = false }) → el.
 * onChange runs when the chosen value changes ('' when cleared). With freeText, leaving the field
 * also keeps what was typed. Methods: el.setOptions(options), el.setValue(value) (no onChange),
 * el.setDisabled(bool); el.input is the combobox.
 *
 * `pinned: true` marks a row that stands for "no choice", like Pipeline's
 * `{ value: '', label: 'All sources', pinned: true }`: it heads the list while the field is blank,
 * typed text never matches it (so Enter after typing picks the first real match, and typing its
 * label doesn't pick it), and while it is the chosen value the field shows the placeholder rather
 * than its label, with no clear button. Give it the value that means "nothing chosen" (''):
 * picking it then fires onChange('') only when something else was chosen, never again when it
 * already is.
 */
export function searchSelect({
  options = [],
  value = '',
  placeholder = '',
  label,
  onChange,
  freeText = false,
  hideLabel = false,
  clearable = true,
  disabled: initiallyDisabled = false,
}) {
  let disabled = !!initiallyDisabled;
  const id = `ss-${++uid}`;
  let opts = options.slice();
  let current = value == null ? '' : String(value);
  let shown = [];
  let active = -1;
  let open = false;

  const labelEl = h('label', { class: ['ss-label', hideLabel && 'sr-only'], id: `${id}-label`, for: `${id}-input` }, label);
  const input = h('input', {
    type: 'text',
    id: `${id}-input`,
    class: 'input ss-input',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-controls': `${id}-list`,
    'aria-autocomplete': 'list',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: placeholder || null,
    disabled,
  });
  const clearBtn = h(
    'button',
    { type: 'button', class: 'icon-btn ss-clear', 'aria-label': `Clear ${label}`, onClick: clearValue },
    svg('M6 6l12 12M18 6L6 18', 14),
  );
  const chevron = h('span', { class: 'ss-chevron' }, svg('M6 9l6 6 6-6'));
  const listbox = h('ul', { class: 'ss-list', role: 'listbox', id: `${id}-list`, 'aria-labelledby': `${id}-label`, hidden: true });
  const empty = h('div', { class: 'ss-empty', id: `${id}-empty`, hidden: true });
  // The empty message is read out as it appears or changes ("No matches", "Press Enter to use
  // “x”"): a live region has to be in the page before its text changes, so this one always is.
  // aria-live without role="status", so it doesn't count as a status message of the form around.
  const said = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  // The popup lives in the control, so it lines up with the input whatever the label does.
  const control = h('div', { class: 'ss-control' }, input, clearBtn, chevron, listbox, empty);
  const el = h('div', { class: 'search-select' }, labelEl, control, said);

  const optionFor = (v) => opts.find((o) => String(o.value) === v);
  const displayOf = (v) => {
    const o = optionFor(v);
    if (o) return o.pinned ? '' : labelText(o);
    return freeText ? v : '';
  };
  // Nothing to clear: no value, or the pinned "no choice" row.
  const blank = () => current === '' || !!(optionFor(current) || {}).pinned;
  const syncClear = () => {
    clearBtn.hidden = !clearable || blank() || disabled;
  };

  function showValue() {
    input.value = displayOf(current);
    syncClear();
  }

  // Open downwards unless the room below is short and there is more above; tell the CSS how much
  // room there is so the list never runs off screen.
  function place() {
    if (listbox.hidden && empty.hidden) return;
    const r = control.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const below = vh - r.bottom - EDGE;
    const above = r.top - EDGE;
    const up = below < Math.min(LIST_MAX, 160) && above > below;
    el.classList.toggle('ss-up', up);
    el.style.setProperty('--ss-room-y', `${Math.max(0, Math.floor((up ? above : below) - 4))}px`);
    el.style.setProperty('--ss-room-x', `${Math.max(Math.floor(r.width), Math.floor(vw - r.left - EDGE))}px`);
  }

  function onViewport() {
    if (!el.isConnected) {
      listen(false);
      return;
    }
    place();
  }
  let listening = false;
  function listen(on) {
    if (on === listening) return;
    listening = on;
    const fn = on ? 'addEventListener' : 'removeEventListener';
    window[fn]('resize', onViewport);
    window[fn]('scroll', onViewport, true);
  }

  function render() {
    listbox.replaceChildren(
      ...shown.map((o, i) =>
        h(
          'li',
          {
            role: 'option',
            id: `${id}-opt-${i}`,
            class: ['ss-option', i === active && 'is-active', String(o.value) === current && 'is-chosen'],
            'aria-selected': i === active ? 'true' : 'false',
            onMousedown: (e) => e.preventDefault(), // keep focus in the input
            onClick: () => pick(String(o.value)),
          },
          h('span', { class: 'ss-option-label' }, labelText(o)),
          o.count == null ? null : h('span', { class: 'ss-option-count' }, fmtNum(o.count)),
        ),
      ),
    );
    const typed = input.value.trim();
    const visible = open && shown.length > 0;
    listbox.hidden = !visible;
    empty.hidden = !open || shown.length > 0;
    if (!shown.length) empty.textContent = freeText && typed ? `Press Enter to use “${typed}”` : 'No matches';
    const message = empty.hidden ? '' : empty.textContent;
    if (said.textContent !== message) said.textContent = message;
    // The message describes the field while it shows, beside any description a view gave it.
    const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== empty.id);
    if (message) ids.unshift(empty.id);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');
    input.setAttribute('aria-expanded', visible ? 'true' : 'false');
    listen(open);
    place();
    if (active >= 0 && shown[active]) {
      input.setAttribute('aria-activedescendant', `${id}-opt-${active}`);
      const li = listbox.children[active];
      if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  // Open with every option (click, ArrowDown) or with the ones matching what was typed. `keep`:
  // the value to stay highlighted, when it is still shown.
  function openWith(filterText, activeIndex = -1, keep = null) {
    open = true;
    shown = filterOptions(opts, filterText).slice(0, MAX_SHOWN);
    const kept = keep == null ? -1 : shown.findIndex((o) => String(o.value) === keep);
    active = kept >= 0 ? kept : Math.min(activeIndex, shown.length - 1);
    render();
  }

  function close() {
    if (!open) return;
    open = false;
    active = -1;
    shown = [];
    render();
  }

  function pick(v) {
    const changed = v !== current;
    current = v;
    close();
    showValue();
    if (changed && onChange) onChange(v);
  }

  function clearValue() {
    pick('');
    input.focus();
  }

  // Enter with nothing active: what was typed decides.
  function commitTyped() {
    const typed = input.value.trim();
    if (!typed) return false;
    const exact = opts.find((o) => !o.pinned && (labelText(o).toLowerCase() === typed.toLowerCase() || String(o.value) === typed));
    if (exact) pick(String(exact.value));
    else if (freeText) pick(typed);
    else if (shown.length) pick(String(shown[0].value));
    else return false;
    return true;
  }

  input.addEventListener('click', () => {
    if (!open) openWith('');
  });
  input.addEventListener('input', () => openWith(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        openWith('');
        const at = shown.findIndex((o) => String(o.value) === current);
        active = at >= 0 ? at : e.key === 'ArrowDown' ? 0 : shown.length - 1;
        render();
        return;
      }
      if (!shown.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = active < 0 ? (step > 0 ? 0 : shown.length - 1) : (active + step + shown.length) % shown.length;
      render();
    } else if (e.key === 'Enter') {
      if (!open && !freeText) return;
      e.preventDefault();
      if (open && active >= 0 && shown[active]) pick(String(shown[active].value));
      else if (!commitTyped()) close();
    } else if (e.key === 'Escape') {
      if (!open && input.value === displayOf(current)) return; // let a dialog close
      e.preventDefault();
      e.stopPropagation();
      close();
      showValue();
    }
  });
  el.addEventListener('focusout', (e) => {
    if (el.contains(e.relatedTarget)) return;
    // Free text keeps what was typed (an exact option match picks that option).
    if (freeText && input.value.trim() !== displayOf(current).trim() && commitTyped()) return;
    close();
    showValue();
  });

  el.setOptions = (list) => {
    // Options that arrive while the user is typing must not replace what they typed, nor move the
    // highlight off the option they went to (Enter would pick another one).
    const typing = document.activeElement === input && input.value !== displayOf(current);
    const highlighted = open && active >= 0 && shown[active] ? String(shown[active].value) : null;
    opts = (list || []).slice();
    if (typing) syncClear();
    else showValue();
    if (open) openWith(typing ? input.value : '', -1, highlighted);
  };
  el.setValue = (v) => {
    current = v == null ? '' : String(v);
    showValue();
  };
  el.setDisabled = (on) => {
    disabled = !!on;
    input.disabled = disabled;
    if (disabled) close();
    showValue();
  };
  el.input = input;
  showValue();
  return el;
}

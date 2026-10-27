// Searchable select (spec §5.1, §5.3): a combobox input over a listbox (ARIA 1.2 pattern, focus
// stays in the input and aria-activedescendant names the active option). A click or ArrowDown
// opens it; typing filters labels and values case-insensitively; Enter picks the active option,
// else the only/first match, else (with `freeText`) what was typed; Esc closes and puts back the
// chosen label. Options are text, never HTML.

import { fmtNum, h } from '../core/dom.js';

const MAX_SHOWN = 200;
let uid = 0;

function svg(d, size = 16) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d }),
  );
}

const labelText = (o) => String(o.label ?? o.value ?? '');

/** The options whose label or value contains `text` (trimmed, any case); all for blank text. */
export function filterOptions(options, text) {
  const q = String(text ?? '').trim().toLowerCase();
  if (!q) return options.slice();
  return options.filter((o) => labelText(o).toLowerCase().includes(q) || String(o.value ?? '').toLowerCase().includes(q));
}

/**
 * searchSelect({ options: [{ value, label?, count? }], value, placeholder?, label, onChange(value),
 * freeText = false, hideLabel = false, clearable = true, disabled = false }) → el.
 * onChange runs when the chosen value changes ('' when cleared). With freeText, leaving the field
 * also keeps what was typed. Methods: el.setOptions(options), el.setValue(value) (no onChange);
 * el.input is the combobox.
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
  disabled = false,
}) {
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
  const empty = h('div', { class: 'ss-empty', hidden: true });
  const el = h('div', { class: 'search-select' }, labelEl, h('div', { class: 'ss-control' }, input, clearBtn, chevron), listbox, empty);

  const optionFor = (v) => opts.find((o) => String(o.value) === v);
  const displayOf = (v) => {
    const o = optionFor(v);
    if (o) return labelText(o);
    return freeText ? v : '';
  };

  function showValue() {
    input.value = displayOf(current);
    clearBtn.hidden = !clearable || current === '' || disabled;
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
    input.setAttribute('aria-expanded', visible ? 'true' : 'false');
    if (active >= 0 && shown[active]) {
      input.setAttribute('aria-activedescendant', `${id}-opt-${active}`);
      const li = listbox.children[active];
      if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  // Open with every option (click, ArrowDown) or with the ones matching what was typed.
  function openWith(filterText, activeIndex = -1) {
    open = true;
    shown = filterOptions(opts, filterText).slice(0, MAX_SHOWN);
    active = Math.min(activeIndex, shown.length - 1);
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
    const exact = opts.find((o) => labelText(o).toLowerCase() === typed.toLowerCase() || String(o.value) === typed);
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
    // Options that arrive while the user is typing must not replace what they typed.
    const typing = document.activeElement === input && input.value !== displayOf(current);
    opts = (list || []).slice();
    if (typing) clearBtn.hidden = !clearable || current === '' || disabled;
    else showValue();
    if (open) openWith(typing ? input.value : '');
  };
  el.setValue = (v) => {
    current = v == null ? '' : String(v);
    showValue();
  };
  el.input = input;
  showValue();
  return el;
}

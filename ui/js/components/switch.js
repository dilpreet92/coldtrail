// On/off switch (spec §5.7, §5.9): <button role="switch" aria-checked> with a visible label (a
// press on it toggles too) and an optional description. It flips at once and waits for
// onChange: resolving to false puts it back quietly (e.g. a cancelled confirm), rejecting puts
// it back and shows the error as a toast.

import { h } from '../core/dom.js';
import { toast } from '../core/ui.js';

let uid = 0;

/**
 * switchEl({ checked, label, description?, disabled?, onChange?(checked) → Promise|boolean|void })
 * → the row (.switch-row). Presses are ignored while onChange is pending (aria-busy).
 * Methods: el.setChecked(bool) (no onChange); el.button is the switch.
 */
export function switchEl({ checked = false, label, description, disabled = false, onChange }) {
  const id = `switch-${++uid}`;
  const labelId = `${id}-label`;
  const descId = description ? `${id}-desc` : null;
  let value = !!checked;
  let busy = false;

  const btn = h(
    'button',
    {
      type: 'button',
      role: 'switch',
      id,
      class: 'switch',
      'aria-checked': String(value),
      'aria-labelledby': labelId,
      'aria-describedby': descId,
      disabled,
    },
    h('span', { class: 'switch-thumb', 'aria-hidden': 'true' }),
  );
  const row = h(
    'div',
    { class: 'switch-row' },
    btn,
    h(
      'div',
      { class: 'switch-text' },
      h('label', { class: 'switch-label', id: labelId, for: id }, label),
      description ? h('p', { class: 'switch-desc', id: descId }, description) : null,
    ),
  );

  const set = (v) => {
    value = v;
    btn.setAttribute('aria-checked', String(v));
  };
  const setBusy = (on) => {
    busy = on;
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  };

  btn.addEventListener('click', async () => {
    if (busy) return;
    const prev = value;
    set(!prev);
    if (!onChange) return;
    let res;
    try {
      res = onChange(value);
      if (res && typeof res.then === 'function') {
        setBusy(true);
        res = await res;
      }
    } catch (err) {
      setBusy(false);
      set(prev);
      toast((err && err.message) || String(err), 'err');
      return;
    }
    setBusy(false);
    if (res === false) set(prev);
  });

  row.setChecked = (v) => set(!!v);
  row.button = btn;
  return row;
}

// Tabs (spec §5.3–§5.5, §5.9): a tablist of buttons with optional counts. Arrow keys, Home and
// End move between tabs and select as they go (automatic activation); only the selected tab is a
// tab stop. The component keeps its own selection, so a view does not rebuild it on change (that
// would drop focus): call setActive / setCounts on the returned element instead.

import { fmtNum, h } from '../core/dom.js';

let uid = 0;

/**
 * tabs({ items: [{ id, label, count? }], active, onChange(id), label, panelId? }) → the tablist.
 * onChange runs only when the selection changes. `panelId` sets aria-controls on every tab (give
 * the panel role="tabpanel"). Methods: el.setActive(id) (no onChange), el.setCounts({ id: n }).
 */
export function tabs({ items, active, onChange, label, panelId }) {
  const base = `tabs-${++uid}`;
  let current = items.some((it) => it.id === active) ? active : items[0] && items[0].id;
  const buttons = new Map();
  const counts = new Map();

  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': label || null });
  items.forEach((it, i) => {
    const count = h('span', { class: 'tab-count' }, it.count == null ? '' : fmtNum(it.count));
    count.hidden = it.count == null;
    const b = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: 'tab',
        id: `${base}-${i}`,
        'data-id': String(it.id),
        'aria-controls': panelId || null,
        onClick: () => select(it.id, false),
      },
      h('span', { class: 'tab-label' }, it.label),
      count,
    );
    buttons.set(it.id, b);
    counts.set(it.id, count);
    list.append(b);
  });

  function sync() {
    for (const [id, b] of buttons) {
      const on = id === current;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  function select(id, focus) {
    const b = buttons.get(id);
    if (!b) return;
    if (focus) b.focus();
    if (id === current) return;
    current = id;
    sync();
    if (onChange) onChange(id);
  }

  list.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const ids = items.map((it) => it.id);
    const at = ids.findIndex((id) => buttons.get(id) === document.activeElement);
    if (at < 0) return;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ids.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(ids[(to + ids.length) % ids.length], true);
  });

  list.setActive = (id) => {
    if (!buttons.has(id)) return;
    current = id;
    sync();
  };
  list.setCounts = (map) => {
    for (const [id, n] of Object.entries(map || {})) {
      const el = counts.get(id);
      if (!el) continue;
      el.textContent = n == null ? '' : fmtNum(n);
      el.hidden = n == null;
    }
  };
  sync();
  return list;
}

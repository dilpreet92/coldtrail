// Tabs (spec §5.3–§5.5, §5.9): a tablist of buttons with optional counts. Arrow keys, Home and
// End move between tabs and select as they go (automatic activation); only the selected tab is a
// tab stop. The component keeps its own selection, so a view does not rebuild it on change (that
// would drop focus): call setActive / setCounts on the returned element instead. When the tabs
// don't fit (phones) the list scrolls sideways: the selected tab is kept in view, and the edge
// with more tabs fades out (data-more="start" / "end" / "start end" on the list).

import { fmtNum, h } from '../core/dom.js';

let uid = 0;
const FADE = 24; // px kept clear of the faded edge when a tab is scrolled into view

/**
 * tabs({ items: [{ id, label, count? }], active, onChange(id), label, panelId? }) → the tablist.
 * Ids may be strings or numbers. onChange(id) runs only when the selection changes. `panelId`
 * sets aria-controls on every tab (give the panel role="tabpanel"). Methods: el.setActive(id) (no
 * onChange), el.setCounts({ id: n }) (null hides a count).
 */
export function tabs({ items, active, onChange, label, panelId }) {
  const base = `tabs-${++uid}`;
  // Everything is keyed by String(id): setCounts' object keys are always strings.
  const key = (id) => String(id);
  const keys = items.map((it) => key(it.id));
  const itemOf = new Map(items.map((it) => [key(it.id), it]));
  let current = itemOf.has(key(active)) ? key(active) : keys[0];
  const buttons = new Map();
  const counts = new Map();

  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': label || null });
  items.forEach((it, i) => {
    const k = key(it.id);
    const count = h('span', { class: 'tab-count' }, it.count == null ? '' : fmtNum(it.count));
    count.hidden = it.count == null;
    const b = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: 'tab',
        id: `${base}-${i}`,
        'data-id': k,
        'aria-controls': panelId || null,
        onClick: () => select(k, false),
      },
      h('span', { class: 'tab-label' }, it.label),
      count,
    );
    buttons.set(k, b);
    counts.set(k, count);
    list.append(b);
  });

  function sync() {
    for (const [k, b] of buttons) {
      const on = k === current;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  // Which edges have tabs scrolled out of sight.
  function syncMore() {
    const max = list.scrollWidth - list.clientWidth;
    const more = [];
    if (max > 1) {
      if (list.scrollLeft > 1) more.push('start');
      if (list.scrollLeft < max - 1) more.push('end');
    }
    if (more.length) list.setAttribute('data-more', more.join(' '));
    else list.removeAttribute('data-more');
  }

  // Scroll the list (only the list, never the page) so the tab clears the faded edges.
  function reveal(k) {
    const b = buttons.get(k);
    if (!b || list.scrollWidth <= list.clientWidth + 1) return;
    const l = list.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    if (r.left < l.left + FADE) list.scrollLeft -= l.left + FADE - r.left;
    else if (r.right > l.right - FADE) list.scrollLeft += r.right - (l.right - FADE);
    syncMore();
  }

  function select(k, focus) {
    const b = buttons.get(k);
    if (!b) return;
    if (focus) b.focus();
    reveal(k);
    if (k === current) return;
    current = k;
    sync();
    if (onChange) onChange(itemOf.get(k).id);
  }

  list.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = keys.findIndex((k) => buttons.get(k) === document.activeElement);
    if (at < 0) return;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: keys.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(keys[(to + keys.length) % keys.length], true);
  });
  list.addEventListener('scroll', syncMore, { passive: true });
  if (typeof ResizeObserver === 'function') {
    // The first callback comes once the list is laid out: bring a deep-linked tab into view then.
    let placed = false;
    new ResizeObserver(() => {
      if (!placed && list.clientWidth > 0) {
        placed = true;
        reveal(current);
      }
      syncMore();
    }).observe(list);
  }

  list.setActive = (id) => {
    const k = key(id);
    if (!buttons.has(k)) return;
    current = k;
    sync();
    reveal(k);
  };
  list.setCounts = (map) => {
    for (const [id, n] of Object.entries(map || {})) {
      const el = counts.get(key(id));
      if (!el) continue;
      el.textContent = n == null ? '' : fmtNum(n);
      el.hidden = n == null;
    }
  };
  sync();
  return list;
}

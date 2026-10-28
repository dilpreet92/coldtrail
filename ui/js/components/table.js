// Data table (spec §5.3, §5.5, §5.7): a sticky header inside a scroll box (sideways at narrow
// widths; give it `maxHeight` and long tables scroll under the header), and rows that open with a
// click or Enter when `onRowClick` is given. Cell content is a Node or text, never parsed HTML.
// The scroll box is positioned, so .sr-only text in a cell stays inside it.

import { h } from '../core/dom.js';

// A press on one of these inside a row does its own job, not the row's.
const INTERACTIVE =
  'a[href],button,input,select,textarea,label,summary,[role="button"],[role="switch"],[role="menuitem"],[role="checkbox"],[contenteditable="true"]';

function baseClass(col) {
  return [col.nowrap && 'nowrap', col.align && `align-${col.align}`];
}

function cell(col, row) {
  const v = col.render ? col.render(row) : row[col.key];
  return v == null || v === false ? '' : v;
}

/**
 * table({ columns: [{ key, label, render?(row) → Node|string, nowrap?, align?: 'left'|'right'|
 * 'center', width? }], rows, rowKey (property name or row → key), onRowClick?(row, event),
 * empty? (text or Node shown when there are no rows), label? (the table's accessible name),
 * maxHeight? (CSS length: the box scrolls vertically under the sticky header), rowFocus = true,
 * cellClass?(col, row) → class(es), roles = false }) → the scroll box.
 * Rows carry `data-key`; clickable rows get class `is-clickable` and are tab stops unless
 * rowFocus is false (a click still opens the row; a link or button inside is the keyboard stop).
 * cellClass adds classes to each cell (row is null for the header cells). roles: true sets
 * explicit table/rowgroup/row/columnheader/cell roles, for CSS that restyles rows as cards
 * (display changes drop a table's built-in semantics).
 */
export function table({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty = 'Nothing to show yet',
  label,
  maxHeight,
  rowFocus = true,
  cellClass,
  roles = false,
}) {
  const keyOf = typeof rowKey === 'function' ? rowKey : (r) => (rowKey == null ? undefined : r[rowKey]);
  const classes = (col, row) => [...baseClass(col), ...[].concat(cellClass ? cellClass(col, row) : [])];
  const role = (r) => (roles ? r : null);

  const head = h(
    'thead',
    { role: role('rowgroup') },
    h(
      'tr',
      { role: role('row') },
      columns.map((col) =>
        h(
          'th',
          { scope: 'col', role: role('columnheader'), class: classes(col, null), style: col.width ? { width: col.width } : null },
          col.label ?? '',
        ),
      ),
    ),
  );

  const body = h('tbody', { role: role('rowgroup') });
  if (!rows.length) {
    body.append(
      h('tr', { class: 'table-empty', role: role('row') }, h('td', { colspan: String(columns.length), role: role('cell') }, empty)),
    );
  }
  for (const row of rows) {
    const tr = h(
      'tr',
      { 'data-key': keyOf(row), role: role('row') },
      columns.map((col) => h('td', { class: classes(col, row), role: role('cell') }, cell(col, row))),
    );
    if (onRowClick) {
      if (rowFocus) tr.tabIndex = 0;
      tr.classList.add('is-clickable');
      tr.addEventListener('click', (e) => {
        const hit = e.target.closest(INTERACTIVE);
        if (hit && hit !== tr && tr.contains(hit)) return;
        // Selecting text in a row is not a click on it.
        const sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed && tr.contains(sel.anchorNode)) return;
        onRowClick(row, e);
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.target !== tr || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        onRowClick(row, e);
      });
    }
    body.append(tr);
  }

  const tbl = h('table', { class: 'table', role: role('table'), 'aria-label': label || null }, head, body);
  const wrap = h('div', { class: 'table-wrap', style: maxHeight ? { maxHeight } : null }, tbl);

  // A box that scrolls must be reachable by keyboard (arrow keys scroll it once focused), so it
  // becomes a named, focusable region only while its content overflows.
  if (typeof ResizeObserver === 'function') {
    const sync = () => {
      const scrolls = wrap.scrollWidth > wrap.clientWidth + 1 || wrap.scrollHeight > wrap.clientHeight + 1;
      if (scrolls) {
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('aria-label', label || 'Table');
      } else {
        wrap.removeAttribute('tabindex');
        wrap.removeAttribute('role');
        wrap.removeAttribute('aria-label');
      }
    };
    const ro = new ResizeObserver(sync);
    ro.observe(wrap);
    ro.observe(tbl);
  }
  return wrap;
}

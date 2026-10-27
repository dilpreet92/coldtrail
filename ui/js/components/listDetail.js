// List + detail (spec §5.4, §5.6): two columns from 900px; below that one column, with the
// detail on top while an item is selected (so picking a draft on a phone shows it first).
// Give the element a height in the view's CSS and each side scrolls on its own.

import { h } from '../core/dom.js';

/**
 * listDetail({ list, detail, selected = false }) → el (.list-detail > .ld-list + .ld-detail).
 * `list` / `detail` are Nodes the view keeps filling. el.setSelected(bool) flips the narrow order.
 */
export function listDetail({ list, detail, selected = false }) {
  const el = h(
    'div',
    { class: ['list-detail', selected && 'has-selection'] },
    h('div', { class: 'ld-list' }, list),
    h('div', { class: 'ld-detail' }, detail),
  );
  el.setSelected = (on) => el.classList.toggle('has-selection', !!on);
  return el;
}

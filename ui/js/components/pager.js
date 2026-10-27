// Pager (spec §5.3): "1–50 of 6,131" plus previous / next. It moves its own page at once and
// keeps its buttons, so focus stays put while the view fetches: confirm with el.update(...)
// rather than rebuilding it.

import { fmtNum, h } from '../core/dom.js';

function chevron(d) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d }),
  );
}

/** "1–50 of 6,131"; "0 of 0" with nothing to show (also for a page past the end). */
export function pagerLabel(page, per, total) {
  const from = (page - 1) * per + 1;
  if (!total || from > total) return `0 of ${fmtNum(total || 0)}`;
  return `${fmtNum(from)}–${fmtNum(Math.min(page * per, total))} of ${fmtNum(total)}`;
}

/**
 * pager({ page, per, total, onChange(page), label = 'Pages' }) → <nav class="pager">.
 * el.update({ page?, per?, total? }) re-renders in place.
 */
export function pager({ page, per, total, onChange, label = 'Pages' }) {
  let state = { page: Math.max(1, page || 1), per: per || 50, total: total || 0 };
  const lastPage = () => Math.max(1, Math.ceil(state.total / state.per));

  const range = h('span', { class: 'pager-range', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'icon-btn pager-btn', 'aria-label': 'Previous page', onClick: () => go(-1) }, chevron('M15 6l-6 6 6 6'));
  const next = h('button', { type: 'button', class: 'icon-btn pager-btn', 'aria-label': 'Next page', onClick: () => go(1) }, chevron('M9 6l6 6-6 6'));
  const el = h('nav', { class: 'pager', 'aria-label': label, tabindex: '-1' }, range, h('div', { class: 'pager-btns' }, prev, next));

  function render() {
    const focused = document.activeElement;
    range.textContent = pagerLabel(state.page, state.per, state.total);
    prev.disabled = state.page <= 1;
    next.disabled = state.page >= lastPage();
    // A button that just became disabled drops focus; hand it to the other one.
    if ((focused === prev && prev.disabled) || (focused === next && next.disabled)) {
      const other = focused === prev ? next : prev;
      (other.disabled ? el : other).focus({ preventScroll: true });
    }
  }

  function go(delta) {
    const n = state.page + delta;
    if (n < 1 || n > lastPage()) return;
    state = { ...state, page: n };
    render();
    if (onChange) onChange(n);
  }

  el.update = (patch) => {
    state = { ...state, ...patch };
    state.page = Math.max(1, state.page || 1);
    render();
  };
  render();
  return el;
}

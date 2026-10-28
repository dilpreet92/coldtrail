// Empty state (spec §5.2–§5.6): what this screen will show and how to get there, with at most
// one primary action.

import { h } from '../core/dom.js';

/**
 * emptyState({ title, body?, action?, level = 2 }) → el. action: a Node, { label, href } (a link
 * styled as the primary button) or { label, onClick }. level: the title's heading level (2–6), e.g.
 * 3 inside a drawer or dialog whose own title is the h2.
 */
export function emptyState({ title, body, action, level = 2 } = {}) {
  const n = Number(level);
  const tag = Number.isInteger(n) && n >= 2 && n <= 6 ? `h${n}` : 'h2';
  let act = null;
  if (action && typeof Node !== 'undefined' && action instanceof Node) act = action;
  else if (action && action.href) act = h('a', { class: 'btn btn-primary', href: action.href }, action.label);
  else if (action && action.onClick) {
    act = h('button', { type: 'button', class: 'btn btn-primary', onClick: action.onClick }, action.label);
  }
  return h(
    'div',
    { class: 'empty-state' },
    h(tag, { class: 'empty-title' }, title),
    body ? h('p', { class: 'empty-body' }, body) : null,
    act ? h('div', { class: 'empty-action' }, act) : null,
  );
}

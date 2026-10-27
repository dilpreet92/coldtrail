// Empty state (spec §5.2–§5.6): what this screen will show and how to get there, with at most
// one primary action.

import { h } from '../core/dom.js';

/**
 * emptyState({ title, body?, action? }) → el. action: a Node, { label, href } (a link styled as
 * the primary button) or { label, onClick }.
 */
export function emptyState({ title, body, action } = {}) {
  let act = null;
  if (action && typeof Node !== 'undefined' && action instanceof Node) act = action;
  else if (action && action.href) act = h('a', { class: 'btn btn-primary', href: action.href }, action.label);
  else if (action && action.onClick) {
    act = h('button', { type: 'button', class: 'btn btn-primary', onClick: action.onClick }, action.label);
  }
  return h(
    'div',
    { class: 'empty-state' },
    h('h2', { class: 'empty-title' }, title),
    body ? h('p', { class: 'empty-body' }, body) : null,
    act ? h('div', { class: 'empty-action' }, act) : null,
  );
}

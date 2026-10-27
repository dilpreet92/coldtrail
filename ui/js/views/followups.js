// Placeholder so the route resolves; the Follow-ups screen (spec §5.5) replaces it.

import { h } from '../core/dom.js';

const title = 'Follow-ups';

export default {
  title,
  mount(root) {
    root.append(h('h1', {}, title));
  },
};

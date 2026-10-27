// Placeholder so the route resolves; the Home screen (spec §5.2) replaces it.

import { h } from '../core/dom.js';

const title = 'Home';

export default {
  title,
  mount(root) {
    root.append(h('h1', {}, title));
  },
};

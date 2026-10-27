// Placeholder so the route resolves; the Settings screen (spec §5.9) replaces it.

import { h } from '../core/dom.js';

const title = 'Settings';

export default {
  title,
  mount(root) {
    root.append(h('h1', {}, title));
  },
};

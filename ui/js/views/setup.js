// Placeholder so the route resolves; the Setup screen (spec §5.1) replaces it.

import { h } from '../core/dom.js';

const title = 'Setup';

export default {
  title,
  mount(root) {
    root.append(h('h1', {}, title));
  },
};

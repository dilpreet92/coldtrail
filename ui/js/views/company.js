// Placeholder so the route resolves; the Company profile screen (spec §5.8) replaces it.

import { h } from '../core/dom.js';

const title = 'Company profile';

export default {
  title,
  mount(root) {
    root.append(h('h1', {}, title));
  },
};

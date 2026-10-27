// Placeholder so the route resolves; the Pipeline screen (spec §5.3) replaces it.

import { h } from '../core/dom.js';

const title = 'Pipeline';

export default {
  title,
  mount(root) {
    root.append(h('h1', {}, title));
  },
};

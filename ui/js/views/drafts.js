// Placeholder so the route resolves; the Drafts screen (spec §5.4) replaces it.

import { h } from '../core/dom.js';

const title = 'Drafts';

export default {
  title,
  mount(root) {
    root.append(h('h1', {}, title));
  },
};

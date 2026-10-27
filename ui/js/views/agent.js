// Placeholder so the route resolves; the Agent screen (spec §5.6) replaces it.

import { h } from '../core/dom.js';

const title = 'Agent';

export default {
  title,
  mount(root) {
    root.append(h('h1', {}, title));
  },
};

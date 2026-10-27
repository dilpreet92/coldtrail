// Placeholder so the route resolves; the Schedules screen (spec §5.7) replaces it.

import { h } from '../core/dom.js';

const title = 'Schedules';

export default {
  title,
  mount(root) {
    root.append(h('h1', {}, title));
  },
};

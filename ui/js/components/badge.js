// Status badge (spec §2): a short label in a pill. The tone only adds colour; the text always
// says the state, so colour is never the only signal.

import { h } from '../core/dom.js';

const TONES = new Set(['neutral', 'accent', 'ok', 'warn', 'danger']);

/** badge(text, tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger') → <span class="badge …">. */
export function badge(text, tone = 'neutral') {
  const t = TONES.has(tone) ? tone : 'neutral';
  return h('span', { class: `badge badge-${t}` }, text == null ? '' : String(text));
}

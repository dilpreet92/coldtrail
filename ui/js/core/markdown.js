// Safe markdown subset for agent text (spec §5.6). Everything is HTML-escaped FIRST; only the
// tags written below are ever produced: p, br, ul/ol/li, strong, em, code, pre, and a (http/https
// only, new tab, rel=noopener noreferrer). Headings become bold paragraphs so agent replies don't
// add to the page's heading outline. Pure: no DOM, importable from Node.

import { esc } from './format.js';

const FENCE = /^\s*```/;
const ITEM = /^\s{0,3}(?:([-*])|(\d{1,9})\.)\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

/** Inline formatting on raw (unescaped) text: `code`, [t](http…), **bold**, *italic*. */
function inline(raw) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = esc(raw);
  // Code spans first, so nothing inside them is formatted.
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  // Links: the URL is already escaped (quotes included), so it cannot leave the attribute.
  s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (m, text, url) =>
    /^https?:\/\/[^\s/]/i.test(url)
      ? keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`)
      : m,
  );
  s = s.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

/** Render agent text to an HTML string using only the safe subset above. */
export function renderMarkdown(text) {
  if (text == null) return '';
  const lines = String(text).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul'|'ol', start, items: [rawText] }

  const endPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const endList = () => {
    if (!list) return;
    const start = list.tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
    out.push(`<${list.tag}${start}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      endPara();
      endList();
      const body = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      endPara();
      endList();
      continue;
    }

    const item = line.match(ITEM);
    if (item) {
      endPara();
      const tag = item[1] ? 'ul' : 'ol';
      if (list && list.tag !== tag) endList();
      if (!list) list = { tag, start: item[2] ? Number(item[2]) : 1, items: [] };
      list.items.push(item[3]);
      continue;
    }

    // An indented line right after an item continues it.
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    endList();

    const heading = line.match(HEADING);
    if (heading) {
      endPara();
      out.push(`<p><strong>${inline(heading[1])}</strong></p>`);
      continue;
    }

    para.push(line.trim());
  }
  endPara();
  endList();
  return out.join('');
}

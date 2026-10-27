// DOM helpers. Every dynamic string reaches the page as a text node through h() / text(); nothing
// here parses HTML. Browser globals are only touched inside functions, so Node can import this.

export * from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'ellipse', 'defs', 'use']);

function setAttr(el, key, v) {
  if (key.startsWith('aria-')) {
    // aria-* booleans are the strings "true"/"false"; only null/undefined omits them.
    if (v != null) el.setAttribute(key, String(v));
    return;
  }
  if (key.startsWith('on')) {
    // Only real listeners; a string would be an inline handler (and CSP blocks those anyway).
    if (typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
    return;
  }
  if (v == null || v === false) return;
  if (key === 'class' || key === 'className') {
    const c = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
    if (c) el.setAttribute('class', c);
  } else if (key === 'style') {
    if (typeof v === 'string') el.setAttribute('style', v);
    else Object.assign(el.style, v);
  } else if (key === 'htmlFor') {
    el.setAttribute('for', String(v));
  } else {
    el.setAttribute(key, v === true ? '' : String(v));
  }
}

function appendAll(el, kids) {
  for (const c of kids) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) appendAll(el, c);
    else if (typeof c === 'object') el.append(c);
    else el.append(String(c));
  }
}

/**
 * Create an element. attrs: `class` (string or array), `style` (string or object), `on<Event>`
 * listeners, `aria-*` / `data-*`, boolean attributes (true → present, false/null → absent),
 * `value` (set as a property, after children so a <select> can pick its option).
 * Children: strings/numbers → text, arrays flattened, null/false skipped, Nodes appended.
 */
export function h(tag, attrs, ...children) {
  const svg = SVG_TAGS.has(tag);
  const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  let value;
  let hasValue = false;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'value' && !svg) {
        hasValue = v != null;
        value = v;
      } else {
        setAttr(el, k, v);
      }
    }
  }
  appendAll(el, children);
  if (hasValue) el.value = String(value);
  return el;
}

/** A text node (never parsed as HTML). */
export function text(s) {
  return document.createTextNode(s == null ? '' : String(s));
}

/** Remove every child; returns the element. */
export function clear(el) {
  el.replaceChildren();
  return el;
}

/**
 * Debounce: the returned function runs `fn` once, `ms` after the last call, with the last
 * arguments. `.flush()` runs a pending call now and returns its result (undefined when nothing
 * is pending) — use it before navigating away so an edit is never dropped. `.cancel()` drops it.
 */
export function debounce(fn, ms) {
  let timer = null;
  let pending = null; // { self, args }
  const run = () => {
    clearTimeout(timer);
    timer = null;
    if (!pending) return undefined;
    const { self, args } = pending;
    pending = null;
    return fn.apply(self, args);
  };
  function debounced(...args) {
    pending = { self: this, args };
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }
  debounced.flush = run;
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return debounced;
}

// Static checks on the browser shell: index.html, design tokens, base styles and bundled fonts.
// Reads the files from disk (no server, no browser). Run with `node --test tests/js/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const UI = fileURLToPath(new URL('../../ui/', import.meta.url));
const read = (rel) => readFileSync(join(UI, rel), 'utf8');

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;";

// Spec §2 color tokens: [light, dark].
const TOKENS = {
  '--bg': ['#FAFAF9', '#0F1012'],
  '--surface': ['#FFFFFF', '#17181B'],
  '--surface-2': ['#F5F5F4', '#1F2024'],
  '--border': ['#E7E5E4', '#2A2C31'],
  '--border-strong': ['#D6D3D1', '#3A3D44'],
  '--text': ['#1C1917', '#ECECEE'],
  '--text-2': ['#57534E', '#A6A8AE'],
  '--text-3': ['#78716C', '#8A8D94'],
  '--accent': ['#1D4ED8', '#5B8CFF'],
  '--accent-soft': ['#EFF6FF', '#1B2440'],
  '--accent-ink': ['#1E3A8A', '#C9D7FF'],
  '--ok': ['#15803D', '#3FB27F'],
  '--warn': ['#B45309', '#E0A23B'],
  '--danger': ['#B91C1C', '#F07070'],
};

// ---- tiny parsers (enough for our own hand-written files) ----

/** Flat list of CSS rules: { selector, parents: [at-rule preludes], decls: Map }. */
function cssRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let i = 0;
  function block(parents) {
    let start = i;
    while (i < src.length) {
      const c = src[i];
      if (c === '{') {
        const prelude = src.slice(start, i).trim();
        i++;
        if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
          block([...parents, prelude]);
        } else {
          const end = src.indexOf('}', i);
          const decls = new Map();
          for (const d of src.slice(i, end).split(';')) {
            const at = d.indexOf(':');
            if (at > 0) decls.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
          }
          rules.push({ selector: prelude, parents, decls });
          i = end + 1;
        }
        start = i;
      } else if (c === '}') {
        i++;
        return;
      } else if (c === ';') {
        i++;
        start = i;
      } else {
        i++;
      }
    }
  }
  block([]);
  return rules;
}

const findRule = (rules, selector, parents = []) =>
  rules.find((r) => r.selector === selector && r.parents.join('|') === parents.join('|'));

/** Element tree of an HTML document: { tag, attrs, children }. */
function htmlTree(html) {
  const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'col', 'wbr']);
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!doctype[^>]*>/i, '');
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, closing, rawTag, rest] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      while (stack.length > 1 && stack.pop().tag !== tag);
      continue;
    }
    const attrs = {};
    for (const a of rest.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    const el = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!VOID.has(tag) && !rest.trim().endsWith('/')) stack.push(el);
  }
  return root;
}

const all = (node, pred, out = []) => {
  for (const c of node.children) {
    if (pred(c)) out.push(c);
    all(c, pred, out);
  }
  return out;
};
const byId = (node, id) => all(node, (e) => e.attrs.id === id)[0];
const assetPath = (href) => join(UI, href.replace(/^\/assets\//, ''));

// WCAG relative luminance / contrast ratio for #RRGGBB.
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((k) => {
      const v = parseInt(hex.slice(k, k + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---- index.html ----

test('index.html carries the exact CSP and color-scheme meta', () => {
  const doc = htmlTree(read('index.html'));
  const metas = all(doc, (e) => e.tag === 'meta');
  const csp = metas.filter((m) => (m.attrs['http-equiv'] || '').toLowerCase() === 'content-security-policy');
  assert.equal(csp.length, 1, 'one CSP meta');
  assert.equal(csp[0].attrs.content, CSP);
  const scheme = metas.find((m) => m.attrs.name === 'color-scheme');
  assert.ok(scheme, 'color-scheme meta present');
  assert.equal(scheme.attrs.content, 'light dark');
});

test('index.html has no inline script and boots /assets/js/main.js as a module', () => {
  const html = read('index.html');
  const doc = htmlTree(html);
  const scripts = all(doc, (e) => e.tag === 'script');
  assert.ok(scripts.length > 0, 'has a script');
  for (const s of scripts) assert.ok(s.attrs.src, `script without src: ${JSON.stringify(s.attrs)}`);
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    assert.equal(m[1].trim(), '', 'script element has inline content');
  }
  const main = scripts.filter((s) => s.attrs.src === '/assets/js/main.js');
  assert.equal(main.length, 1);
  assert.equal(main[0].attrs.type, 'module');
  // CSP forbids inline handlers anyway; keep them out of the markup.
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handler attribute');
  assert.doesNotMatch(html, /app\.js|app\.css/, 'legacy UI is no longer referenced');
});

test('index.html loads tokens, base, components stylesheets in order', () => {
  const doc = htmlTree(read('index.html'));
  const sheets = all(doc, (e) => e.tag === 'link' && e.attrs.rel === 'stylesheet').map((l) => l.attrs.href);
  assert.deepEqual(sheets, ['/assets/css/tokens.css', '/assets/css/base.css', '/assets/css/components.css']);
});

test('index.html shell roots: #app > aside#nav + div.main > header#topbar + main#view', () => {
  const doc = htmlTree(read('index.html'));
  const body = all(doc, (e) => e.tag === 'body')[0];
  assert.ok(body, 'has body');
  const app = byId(body, 'app');
  assert.ok(app, '#app');
  assert.equal(app.tag, 'div');
  const kids = app.children.map((c) => `${c.tag}#${c.attrs.id || ''}.${c.attrs.class || ''}`);
  assert.deepEqual(kids, ['aside#nav.', 'div#.main'], '#app children');
  const main = app.children[1];
  assert.deepEqual(
    main.children.map((c) => `${c.tag}#${c.attrs.id}`),
    ['header#topbar', 'main#view'],
    '.main children',
  );
  assert.equal(main.children[1].attrs.tabindex, '-1', '#view is programmatically focusable');

  const overlays = byId(body, 'overlays');
  assert.equal(overlays?.tag, 'div', 'div#overlays');
  const toasts = byId(body, 'toasts');
  assert.equal(toasts?.tag, 'div', 'div#toasts');
  assert.equal(toasts.attrs['aria-live'], 'polite');
  for (const el of [overlays, toasts]) {
    assert.ok(!all(app, (e) => e === el).length, `#${el.attrs.id} sits outside #app`);
  }
});

test('index.html only references local files that exist', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i, 'no third-party URLs');
  const doc = htmlTree(html);
  const refs = all(doc, (e) => e.tag === 'script' || e.tag === 'link')
    .map((e) => e.attrs.src || e.attrs.href)
    .filter((u) => u && !u.startsWith('data:'));
  assert.ok(refs.length >= 4);
  for (const u of refs) {
    assert.match(u, /^\/assets\//, `served from /assets: ${u}`);
    assert.ok(existsSync(assetPath(u)), `missing file for ${u}`);
  }
});

// ---- tokens.css ----

test('tokens.css defines every spec §2 color token with exact light and dark values', () => {
  const rules = cssRules(read('css/tokens.css'));
  const light = findRule(rules, ':root');
  const dark = findRule(rules, ':root[data-theme="dark"]');
  assert.ok(light, ':root block');
  assert.ok(dark, ':root[data-theme="dark"] block');
  for (const [name, [l, d]] of Object.entries(TOKENS)) {
    assert.equal(light.decls.get(name)?.toUpperCase(), l, `${name} light`);
    assert.equal(dark.decls.get(name)?.toUpperCase(), d, `${name} dark`);
  }
});

test('tokens.css: system-dark block matches the explicit dark block exactly', () => {
  const rules = cssRules(read('css/tokens.css'));
  const sys = findRule(rules, ':root:not([data-theme="light"])', ['@media (prefers-color-scheme: dark)']);
  const dark = findRule(rules, ':root[data-theme="dark"]');
  assert.ok(sys, '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }');
  assert.deepEqual(Object.fromEntries(sys.decls), Object.fromEntries(dark.decls));
  assert.equal(dark.decls.get('color-scheme'), 'dark');
});

test('tokens.css declares both variable fonts from local files', () => {
  const rules = cssRules(read('css/tokens.css'));
  const faces = rules.filter((r) => r.selector === '@font-face');
  const want = { Geist: 'Geist-Variable.woff2', 'Geist Mono': 'GeistMono-Variable.woff2' };
  for (const [family, file] of Object.entries(want)) {
    const face = faces.find((f) => f.decls.get('font-family')?.replace(/['"]/g, '') === family);
    assert.ok(face, `@font-face ${family}`);
    assert.match(face.decls.get('src'), new RegExp(`^url\\(['"]?/assets/fonts/${file}['"]?\\) format\\(['"]woff2['"]\\)$`));
    assert.equal(face.decls.get('font-weight'), '100 900');
    assert.equal(face.decls.get('font-display'), 'swap');
  }
});

test('token text colors meet 4.5:1 on --bg and --surface in both themes', () => {
  const rules = cssRules(read('css/tokens.css'));
  const light = findRule(rules, ':root').decls;
  const dark = new Map([...light, ...findRule(rules, ':root[data-theme="dark"]').decls]);
  const fgs = ['--text', '--text-2', '--text-3', '--accent', '--accent-ink', '--ok', '--warn', '--danger'];
  for (const [theme, t] of [['light', light], ['dark', dark]]) {
    for (const fg of fgs) {
      for (const bg of ['--bg', '--surface']) {
        const r = contrast(t.get(fg), t.get(bg));
        assert.ok(r >= 4.5, `${theme} ${fg} on ${bg} = ${r.toFixed(2)}`);
      }
    }
    const onAccent = contrast(t.get('--on-accent'), t.get('--accent'));
    assert.ok(onAccent >= 4.5, `${theme} --on-accent on --accent = ${onAccent.toFixed(2)}`);
    assert.ok(contrast(t.get('--accent-ink'), t.get('--accent-soft')) >= 4.5, `${theme} accent-ink on accent-soft`);
  }
});

// ---- base.css / components.css ----

test('base.css: body ground and type, focus ring, sidebar width', () => {
  const rules = cssRules(read('css/base.css'));
  const tokens = findRule(cssRules(read('css/tokens.css')), ':root').decls;
  const resolve = (v) => v.replace(/var\((--[a-z0-9-]+)\)/g, (_, n) => tokens.get(n) ?? `var(${n})`);
  const body = findRule(rules, 'body');
  assert.ok(body, 'body rule');
  assert.equal(body.decls.get('background'), 'var(--bg)');
  assert.equal(resolve(body.decls.get('font')), "14px/1.45 'Geist', system-ui, sans-serif");
  const focus = findRule(rules, ':focus-visible');
  assert.ok(focus, ':focus-visible rule');
  assert.equal(focus.decls.get('outline'), '2px solid var(--accent)');
  assert.equal(focus.decls.get('outline-offset'), '2px');
  const mono = rules.find((r) => !r.parents.length && r.selector.split(/\s*,\s*/).includes('.mono'));
  assert.ok(mono, '.mono rule');
  assert.equal(mono.decls.get('font-family'), 'var(--font-mono)');
  assert.match(tokens.get('--font-mono'), /^'Geist Mono',/);
  const app = findRule(rules, '#app');
  assert.ok(app, '#app rule');
  assert.match(resolve(app.decls.get('grid-template-columns') || ''), /^232px /);
});

test('base.css: heading scale (spec §2: page titles 22px/600, section titles 15–16px/600)', () => {
  const rules = cssRules(read('css/base.css'));
  const heading = (tag) =>
    rules.find((r) => !r.parents.length && r.selector.split(/\s*,\s*/).includes(tag) && r.decls.has('font-size'));
  for (const [tag, size] of [['h1', '22px'], ['h2', '16px'], ['h3', '15px']]) {
    const r = heading(tag);
    assert.ok(r, `${tag} rule`);
    assert.equal(r.decls.get('font-size'), size, `${tag} font-size`);
    assert.equal(r.decls.get('font-weight'), '600', `${tag} font-weight`);
    assert.ok(r.selector.split(/\s*,\s*/).includes(`.${tag}`), `.${tag} shares the ${tag} rule`);
  }
});

test('components.css exists (filled in by the component task)', () => {
  assert.ok(existsSync(join(UI, 'css/components.css')));
});

// ---- fonts ----

test('bundled fonts are real woff2 files with the OFL license', () => {
  for (const f of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2']) {
    const p = join(UI, 'fonts', f);
    assert.ok(existsSync(p), `${f} exists`);
    assert.ok(statSync(p).size > 10 * 1024, `${f} > 10 KB`);
    assert.equal(readFileSync(p).subarray(0, 4).toString('latin1'), 'wOF2', `${f} woff2 signature`);
  }
  assert.match(read('fonts/OFL.txt'), /SIL Open Font License/);
});

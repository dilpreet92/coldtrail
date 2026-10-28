// Company profile (spec §5.8): `#/company?tab=profile|contacted`.
//
// Profile: product.md in a markdown editor that saves as you type, beside a checklist of the
// sections the agent drafts from. The checklist reads headings the way the backend does — the
// call-to-action check mirrors `product::cta_link()` line for line, so a ticked CTA is one the
// LinkedIn note path will really pick up. Already contacted: contacted.toml, validated by the
// server on save; plain domains (one per line) are turned into entries first.
//
// `mountProfileEditor` is exported for the Setup wizard's company step: it assumes nothing about
// the page around it (it loads its own stylesheet) and cleans up when its root leaves the
// document or when dispose() is called.

import { api } from '../core/api.js';
import { debounce, h, pluralize } from '../core/dom.js';
import { store as sharedStore } from '../core/store.js';
import { tabs } from '../components/tabs.js';

const TITLE = 'Company profile';
const CSS_HREF = '/assets/css/views/company.css';
const SAVE_DELAY_MS = 600;

/** The example link the template ships with; still present means "not your link yet". */
export const EXAMPLE_LINK = 'https://yourproduct.com/?utm_content={slug}';
const EXAMPLE_HOST = 'yourproduct.com';

/**
 * What an empty profile starts from (shown, not saved, until the user edits it). One heading per
 * checklist section, and the call to action in the one format `product::cta_link()` reads:
 * a `- Link:` list item under `## Call to Action` (a bare URL line there is never picked up).
 */
export const PROFILE_TEMPLATE = `# <Your company> — profile

## What we do


## Who we help


## The pain / value


## Proof / differentiator


## Offer


## Call to Action
- Link: ${EXAMPLE_LINK}

## Voice & sign-off

`;

// ---------------------------------------------------------------------------------------------
// Checklist analysis (pure)

const SECTIONS = [
  { id: 'product', label: 'What you do', heading: 'What we do', match: /product|what we do/i, hint: 'What you sell, in a sentence or two.' },
  { id: 'audience', label: 'Who you help', heading: 'Who we help', match: /audience|who we help/i, hint: 'The companies and roles it’s for.' },
  { id: 'pain', label: 'Pain or value', heading: 'The pain / value', match: /pain|value/i, hint: 'The problem you remove, in your buyer’s words.' },
  { id: 'proof', label: 'Proof', heading: 'Proof / differentiator', match: /proof|differentiat/i, hint: 'Numbers, customers or what sets you apart. The agent won’t invent any.' },
  { id: 'offer', label: 'Offer', heading: 'Offer', match: /offer/i, hint: 'What you’re offering: a pilot, a call, credits.' },
];
const CTA = {
  id: 'cta',
  label: 'Call to action link',
  heading: 'Call to Action',
  hint: 'A “- Link:” line under “## Call to Action”. LinkedIn notes end with it; {slug} becomes each company’s tag.',
};

// "[add your link]" or "- Offer: [confirm your offer]": template filler, not content.
const PLACEHOLDER = /^(?:[-*+]\s+)?(?:[^:[\]]{1,40}:\s*)?\[[^\]]*\]$/;
const COMMENT = /^<!--.*-->$/;
const BARE_URL = /^<?(https?:\/\/\S+?)>?$/i;

const isHeading = (t) => t.startsWith('#');
const headingText = (t) => t.replace(/^#+/, '').trim();
const isContent = (line) => {
  const t = line.trim();
  return t !== '' && !isHeading(t) && !PLACEHOLDER.test(t) && !COMMENT.test(t);
};

/** product.rs `link_line_value`: `- Link: <value>` → value; a blank or "[…]" value → null;
 *  any other line → undefined. */
function linkLineValue(t) {
  if (!t.startsWith('-')) return undefined;
  const rest = t.slice(1).trimStart();
  if (rest.length < 5 || rest.slice(0, 5).toLowerCase() !== 'link:') return undefined;
  const value = rest.slice(5).trim();
  return value === '' || value.startsWith('[') ? null : value;
}

function sectionItem(s, lines, heads) {
  const base = { id: s.id, label: s.label, hint: s.hint, heading: s.heading };
  let emptyAt = null; // the first matching heading, when none of them has content yet
  for (let k = 0; k < heads.length; k++) {
    const hd = heads[k];
    if (hd.title || !s.match.test(hd.text)) continue;
    // The section runs to the next heading of the same or a higher level.
    const next = heads.slice(k + 1).find((nx) => nx.level <= hd.level);
    const body = lines.slice(hd.line + 1, next ? next.line : lines.length);
    if (body.some(isContent)) return { ...base, state: 'done', found: hd.text };
    if (emptyAt === null) emptyAt = hd.text;
  }
  if (emptyAt !== null) return { ...base, state: 'empty', found: emptyAt };
  return { ...base, state: 'missing', fix: { kind: 'append' } };
}

// Mirrors product.rs `parse_cta_link`: any line starting with "#" is a heading; the section is
// the lines after a heading equal (ignoring ASCII case) to "call to action"; the first valid
// `- Link:` value in it wins.
function ctaItem(lines) {
  const base = { id: CTA.id, label: CTA.label, hint: CTA.hint, heading: CTA.heading };
  let inSection = false;
  let headingLine = -1;
  let near = null;
  let bare = null;
  let placeholder = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (isHeading(t)) {
      const text = headingText(t);
      inSection = text.toLowerCase() === 'call to action';
      if (inSection && headingLine < 0) headingLine = i;
      if (!inSection && near === null && /call to action|\bcta\b/i.test(text)) near = { line: i, text };
      continue;
    }
    if (!inSection) continue;
    const value = linkLineValue(t);
    if (value === null) {
      if (!placeholder) placeholder = { line: i, text: t.slice(t.toLowerCase().indexOf('link:') + 5).trim() };
    } else if (value !== undefined) {
      if (!/^https?:\/\//i.test(value)) {
        return { ...base, state: 'warn', link: value, hint: 'The link should start with https:// or http:// so it opens from a note.', fix: { kind: 'select-link', line: i, text: value } };
      }
      if (value.toLowerCase().includes(EXAMPLE_HOST)) {
        return { ...base, state: 'warn', example: true, link: value, hint: 'LinkedIn notes end with this example link until you replace it with your own; keep {slug} for tracking.', fix: { kind: 'select-link', line: i, text: value } };
      }
      return { ...base, state: 'done', link: value };
    } else if (!bare) {
      const m = t.match(BARE_URL);
      if (m) bare = { line: i, url: m[1] };
    }
  }
  if (headingLine >= 0) {
    if (bare) {
      return { ...base, state: 'warn', hint: 'Start the line with “- Link:”. A bare URL isn’t used in LinkedIn notes.', fix: { kind: 'link-line', line: bare.line, url: bare.url } };
    }
    if (placeholder) {
      const fix = placeholder.text ? { kind: 'select-link', line: placeholder.line, text: placeholder.text } : undefined;
      return { ...base, state: 'warn', hint: 'The “- Link:” line still has placeholder text. Put your URL there.', fix };
    }
    return { ...base, state: 'warn', hint: 'Add a “- Link:” line under the heading with the URL notes should end with.', fix: { kind: 'insert-link', line: headingLine } };
  }
  if (near) {
    return { ...base, state: 'warn', found: near.text, hint: 'Name the heading exactly “Call to Action” so its link is found.', fix: { kind: 'rename', line: near.line } };
  }
  return { ...base, state: 'missing', fix: { kind: 'append' } };
}

/**
 * Which profile sections are covered. A section counts when a heading names it (case-insensitive:
 * product / what we do; audience / who we help; pain / value; proof / differentiator; offer) and
 * something other than "[placeholder]" text sits under it. The document's first heading, when it
 * is level 1, is its title rather than a section if it names no section, only sections that later
 * headings name too ("# Acme Product" above "## What we do"), or holds nothing but subsections
 * ("# Acme product profile" above "## What it does"); in a profile written all in level-1
 * headings, "# What we do" is the section. The call to action counts only with a
 * `- Link: http(s)://…` line under a heading that reads exactly "Call to Action"; `example` marks
 * one still pointing at the template's example site.
 * @param {string} doc
 * @returns {{ items: Array<{ id: string, label: string, state: 'done'|'empty'|'missing'|'warn',
 *   hint: string, heading: string, found?: string, link?: string, example?: boolean,
 *   fix?: object }>, done: number, total: number }}
 */
export function analyzeProfile(doc) {
  const lines = String(doc ?? '').split('\n');
  const heads = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!isHeading(t)) return;
    const level = t.match(/^#+/)[0].length;
    heads.push({ line: i, level, text: headingText(t), title: false });
  });
  const [first, ...rest] = heads;
  if (first && first.level === 1) {
    const named = SECTIONS.filter((s) => s.match.test(first.text));
    const namedLater = named.every((s) => rest.some((hd) => s.match.test(hd.text)));
    // Nothing of its own before a deeper heading: it wraps the whole document, so its name
    // ("Acme product profile", "Offerpad") says nothing about which sections are written.
    const next = rest[0];
    const wrapsOnly = next !== undefined && next.level > first.level && !lines.slice(first.line + 1, next.line).some(isContent);
    first.title = namedLater || wrapsOnly;
  }
  const items = [...SECTIONS.map((s) => sectionItem(s, lines, heads)), ctaItem(lines)];
  return { items, done: items.filter((it) => it.state === 'done').length, total: items.length };
}

// ---------------------------------------------------------------------------------------------
// Small DOM helpers

let uid = 0;

const ICONS = {
  check: ['M20 6L9 17l-5-5'],
  done: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.5 12.5l2.5 2.5 4.5-5'],
  todo: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  warn: ['M12 3.5l9 16h-18l9-16z', 'M12 10v4', 'M12 17v.01'],
  error: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8v5', 'M12 16v.01'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  plus: ['M12 5v14', 'M5 12h14'],
};

function icon(name, size = 16) {
  return h(
    'svg',
    { class: `icon icon-${name}`, viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    ICONS[name].map((d) => h('path', { d })),
  );
}

/** Load this view's stylesheet when the editor is mounted outside the Company route. */
function ensureCss() {
  if (typeof document === 'undefined') return;
  const has = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.getAttribute('href') === CSS_HREF);
  if (!has) document.head.append(h('link', { rel: 'stylesheet', href: CSS_HREF }));
}

/** A textarea's value always uses "\n"; compare the server's text the same way. */
const lf = (s) => String(s || '').replace(/\r\n?/g, '\n');

function skeletonLines(widths) {
  return h('div', { class: 'cp-skeleton', 'aria-hidden': 'true' }, widths.map((w) => h('span', { class: 'skeleton', style: `width:${w}%` })));
}

const isSave = (e) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 's';

/** Browsers cap the bodies of in-flight keepalive requests at 64 KiB in total; leave headroom. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;
const fitsKeepalive = (doc) => new Blob([JSON.stringify({ doc })]).size <= KEEPALIVE_MAX_BYTES;

/** Start offset of line `n` in `text` (lines split on "\n"). */
function lineStart(text, n) {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return at;
}
function lineEnd(text, n) {
  const start = lineStart(text, n);
  const nl = text.indexOf('\n', start);
  return nl < 0 ? text.length : nl;
}

/** Replace [start, end) in a textarea as if typed: keeps undo where the browser allows and fires
 *  `input`, so autosave and the checklist follow. */
function replaceRange(ta, start, end, text, select = null) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let done = false;
  try {
    done = document.execCommand('insertText', false, text);
  } catch (_) {
    done = false;
  }
  if (!done || ta.value.slice(start, start + text.length) !== text) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (select) ta.setSelectionRange(start + select[0], start + select[1]);
}

// ---------------------------------------------------------------------------------------------
// Profile editor

/** Profile text an editor was closed with before the server had it; the next editor offers it
 *  back unless the file has it by then. */
let profileDraft = null;

const STATUS_TEXT = {
  loading: 'Loading…',
  'load-error': 'Not loaded',
  template: 'Template · not saved yet',
  saving: 'Saving…',
  dirty: 'Unsaved changes',
  saved: 'Saved',
  empty: "Not saved: the profile can't be empty",
};
const STATUS_ICON = { saved: 'check', error: 'error', empty: 'warn', 'load-error': 'error' };

/**
 * Mount the company profile editor (product.md) into `root`: a markdown textarea that autosaves
 * (600ms after typing stops, ⌘S / Ctrl+S saves at once) with a save indicator, and the section
 * checklist beside it. An empty profile shows PROFILE_TEMPLATE, unsaved until the user edits it.
 * It never saves before the profile has loaded, and never saves a blank profile (an empty
 * product.md would send the workspace back to setup). Works on any page: it adds its own
 * stylesheet, and needs only the session cookie.
 *
 * Cleanup: removing `root` (or the editor) from the document, or calling dispose(), saves any
 * edit the server doesn't have yet (one waiting, or one whose save failed), aborts loads and
 * removes every listener and timer. After that onChange stops. Until that last save lands, the
 * text is kept in memory: the next editor mounted on this page restores it (and saves it) if the
 * file still lacks it, with a notice and a Discard. Closing or reloading the tab sends unsaved
 * text with a keepalive request; when the text is too big for one (over 60 KiB) or the last save
 * failed, the browser asks before leaving instead.
 *
 * @param {HTMLElement} root  Where the editor is appended.
 * @param {{ onChange?: (state: ProfileState) => void, store?: { refresh(): unknown } }} [opts]
 *   onChange runs after the load, on every edit and whenever the save status changes.
 *   `store` is refreshed after the first save of a previously empty profile (default: the
 *   shared store), so setup/onboarding state catches up.
 * @returns {{ el: HTMLElement, ready: Promise<ProfileState>, state(): ProfileState,
 *   flush(): Promise<ProfileState>, focus(): void, dispose(): void }}
 *   ready resolves once the profile has loaded (after a retry if the first load fails) or the
 *   editor is disposed; it never rejects. flush() saves now and resolves when every save has settled. dispose() also removes
 *   the editor from `root`.
 *
 * @typedef {{ doc: string, loaded: boolean, empty: boolean, template: boolean, persisted: boolean,
 *   status: 'loading'|'load-error'|'template'|'saving'|'dirty'|'saved'|'error'|'empty',
 *   error: string|null,
 *   checklist: { done: number, total: number, items: object[] } }} ProfileState
 *   `persisted`: the server holds a non-blank profile (what /api/status calls product_set).
 */
export function mountProfileEditor(root, { onChange, store = sharedStore } = {}) {
  ensureCss();
  const id = `pe-${++uid}`;
  const ac = new AbortController();
  let disposed = false;
  let loaded = false;
  let template = false;
  let persisted = ''; // what the server holds (as far as we know)
  let pending = false; // a debounced save is waiting
  let inflight = null; // the running save loop
  let again = false;
  let lastError = null;
  let status = 'loading';
  let analysis = analyzeProfile('');
  let checklistSig = '';
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const ta = h('textarea', {
    class: 'pe-text',
    id: `${id}-text`,
    spellcheck: 'false',
    autocapitalize: 'off',
    'aria-label': 'Company profile',
    'aria-describedby': `${id}-status`,
    placeholder: 'Describe your company in markdown. The agent writes every message from this.',
  });
  ta.hidden = true;
  const statusIcon = h('span', { class: 'pe-status-icon' });
  const statusText = h('span', { class: 'pe-status-text' });
  const statusEl = h('span', { class: 'pe-status', id: `${id}-status`, role: 'status', 'data-state': 'loading' }, statusIcon, statusText);
  const retryBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: () => saveNow() }, 'Retry');
  retryBtn.hidden = true;
  const flagBtn = h(
    'button',
    {
      type: 'button',
      class: 'pe-flag',
      'aria-label': 'Replace example link: LinkedIn notes end with it until you do',
      title: 'LinkedIn notes end with the example link until you replace it',
      onClick: () => applyFix(CTA.id, 'select-link'),
    },
    icon('warn', 14),
    h('span', { class: 'pe-flag-text pe-flag-long', 'aria-hidden': 'true' }, 'Replace example link'),
    h('span', { class: 'pe-flag-text pe-flag-short', 'aria-hidden': 'true' }, 'Example link'),
  );
  flagBtn.hidden = true;
  let restoredFrom = null; // what the file held when a restored draft replaced it
  const discardBtn = h('button', { type: 'button', class: 'cp-text-btn', onClick: () => discardRestored() }, 'Discard');
  const restored = h('p', { class: 'pe-restored' }, h('span', {}, 'Your unsaved changes from earlier are back.'), discardBtn);
  restored.hidden = true;
  const skeleton = skeletonLines([38, 0, 22, 64, 0, 26, 71, 58, 0, 30, 49]);
  const loadError = h('div', { class: 'pe-load-error cp-load-error', role: 'alert' });
  loadError.hidden = true;

  const main = h(
    'div',
    { class: 'pe-main cp-card' },
    h(
      'div',
      { class: 'cp-bar' },
      h('span', { class: 'cp-file' }, icon('file', 14), h('span', { class: 'mono' }, 'product.md')),
      flagBtn,
      h('span', { class: 'cp-bar-end' }, statusEl, retryBtn),
    ),
    restored,
    h('div', { class: 'pe-body' }, skeleton, loadError, ta),
  );

  const progressEl = h('span', { class: 'pe-progress' });
  const meter = h('span', { class: 'pe-meter', 'aria-hidden': 'true' });
  const list = h('ul', { class: 'pe-list', 'aria-label': 'Profile checklist' });
  const checkSkeleton = skeletonLines([70, 52, 64, 45, 58, 66]);
  const checkNote = h('p', { class: 'pe-check-note' }, 'Shows once your profile loads.');
  for (const node of [progressEl, meter, list, checkNote]) node.hidden = true;
  const aside = h(
    'section',
    { class: 'pe-check cp-card', 'aria-labelledby': `${id}-check-title` },
    h('div', { class: 'pe-check-head' }, h('h2', { class: 'pe-check-title', id: `${id}-check-title` }, 'Checklist'), progressEl),
    meter,
    h('p', { class: 'pe-check-desc' }, 'Sections the agent looks for, found by their headings. It only uses what you write here.'),
    checkSkeleton,
    checkNote,
    list,
  );

  const el = h('div', { class: 'pe' }, h('div', { class: 'cp-grid' }, main, aside));
  root.append(el);

  // ---- state ----------------------------------------------------------------------------

  const same = (a, b) => a.trimStart() === b.trimStart();

  function state() {
    const doc = loaded ? ta.value : '';
    return {
      doc,
      loaded,
      empty: !doc.trim(),
      template,
      persisted: persisted.trim() !== '',
      status,
      error: lastError ? lastError.message || String(lastError) : null,
      checklist: { done: analysis.done, total: analysis.total, items: analysis.items.map(({ fix, ...it }) => ({ ...it })) },
    };
  }

  function emit() {
    if (disposed || !onChange) return;
    try {
      onChange(state());
    } catch (err) {
      console.error(err);
    }
  }

  function computeStatus() {
    if (!loaded) return status === 'load-error' ? 'load-error' : 'loading';
    const v = ta.value;
    if (!v.trim()) return 'empty';
    if (template) return 'template';
    if (pending || inflight) return 'saving';
    if (lastError) return 'error';
    return same(v, persisted) ? 'saved' : 'dirty';
  }

  function renderStatus() {
    status = computeStatus();
    statusEl.dataset.state = status;
    main.dataset.state = status;
    const text = status === 'error' ? `Couldn't save: ${(lastError && lastError.message) || lastError}` : STATUS_TEXT[status];
    if (statusText.textContent !== text) statusText.textContent = text;
    if (status === 'empty') statusEl.title = 'An empty profile would send coldtrail back to setup, so the last saved version is kept.';
    else if (status === 'error') statusEl.title = text;
    else statusEl.removeAttribute('title');
    statusIcon.replaceChildren(STATUS_ICON[status] ? icon(STATUS_ICON[status], 14) : '');
    retryBtn.hidden = status !== 'error';
  }

  // ---- checklist ------------------------------------------------------------------------

  /** Apply section `id`'s `kind` of fix to the text as it is now. The checklist is only redrawn
   *  when a section's state changes, so the line numbers it was drawn with can be out of date
   *  (lines added above a warning); a fix that no longer applies does nothing. */
  function applyFix(id, kind) {
    const v = ta.value;
    const it = analyzeProfile(v).items.find((x) => x.id === id);
    const fix = it && it.fix;
    if (!fix || fix.kind !== kind) return;
    if (fix.kind === 'append') {
      const sep = v === '' ? '' : v.endsWith('\n\n') ? '' : v.endsWith('\n') ? '\n' : '\n\n';
      const block = it.id === CTA.id ? `## ${CTA.heading}\n- Link: ${EXAMPLE_LINK}\n` : `## ${it.heading}\n`;
      replaceRange(ta, v.length, v.length, sep + block);
    } else if (fix.kind === 'link-line') {
      const start = lineStart(v, fix.line);
      replaceRange(ta, start, lineEnd(v, fix.line), `- Link: ${fix.url}`);
    } else if (fix.kind === 'insert-link') {
      const end = lineEnd(v, fix.line);
      const line = `\n- Link: ${EXAMPLE_LINK}`;
      const host = line.indexOf(EXAMPLE_HOST);
      replaceRange(ta, end, end, line, [host, host + EXAMPLE_HOST.length]);
    } else if (fix.kind === 'rename') {
      const start = lineStart(v, fix.line);
      const hashes = v.slice(start).trimStart().match(/^#+/)[0];
      replaceRange(ta, start, lineEnd(v, fix.line), `${hashes} ${CTA.heading}`);
    } else if (fix.kind === 'select-link') {
      const start = lineStart(v, fix.line);
      const line = v.slice(start, lineEnd(v, fix.line));
      const at = line.lastIndexOf(fix.text);
      ta.focus();
      if (at >= 0) ta.setSelectionRange(start + at, start + at + fix.text.length);
    }
  }

  const FIX_LABEL = {
    append: (it) => ['Add', `Add ${it.heading} section`],
    'link-line': () => ['Fix link line', 'Fix link line'],
    'insert-link': () => ['Add link line', 'Add link line'],
    rename: () => ['Rename heading', 'Rename heading'],
    'select-link': () => ['Edit link', 'Edit link'],
  };
  const STATE_WORD = { done: 'Done', empty: 'Empty', missing: 'Missing', warn: 'Needs a fix' };

  function renderChecklist() {
    if (!loaded) return;
    const sig = JSON.stringify(analysis.items.map((it) => [it.id, it.state, it.found, it.link, it.hint, it.fix && it.fix.kind]));
    progressEl.textContent = `${analysis.done} of ${analysis.total} covered`;
    if (sig === checklistSig) return;
    checklistSig = sig;
    meter.replaceChildren(...analysis.items.map((it) => h('span', { class: 'pe-meter-seg', 'data-state': it.state })));
    list.replaceChildren(
      ...analysis.items.map((it) => {
        let detail;
        if (it.state === 'done' && it.link) {
          detail = h('p', { class: 'pe-item-hint pe-item-link mono', title: it.link }, it.link);
        } else if (it.state === 'done') {
          detail = h('p', { class: 'pe-item-hint' }, `Under “${it.found}”`);
        } else if (it.state === 'empty') {
          detail = h('p', { class: 'pe-item-hint' }, it.hint);
        } else if (it.state === 'missing') {
          detail = h('p', { class: 'pe-item-hint' }, it.hint);
        } else {
          detail = [
            h('p', { class: 'pe-item-hint' }, it.hint),
            it.link ? h('p', { class: 'pe-item-hint pe-item-link mono', title: it.link }, it.link) : null,
          ];
        }
        const fixKind = it.fix && it.fix.kind;
        const [text, label] = fixKind ? FIX_LABEL[fixKind](it) : [];
        let fixBtn = null;
        if (fixKind === 'append') {
          // A light suggestion: a compact "+ Add" beside the label.
          fixBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm pe-item-add', 'aria-label': label, onClick: () => applyFix(it.id, fixKind) }, icon('plus', 14), text);
        } else if (fixKind) {
          // A real problem: the fix sits under its explanation.
          fixBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm pe-item-fix', onClick: () => applyFix(it.id, fixKind) }, text);
        }
        return h(
          'li',
          { class: 'pe-item', 'data-section': it.id, 'data-state': it.state },
          h('span', { class: 'pe-item-icon' }, icon(it.state === 'done' ? 'done' : it.state === 'warn' ? 'warn' : 'todo')),
          h(
            'div',
            { class: 'pe-item-text' },
            h('span', { class: 'pe-item-label' }, it.label, h('span', { class: 'sr-only' }, `: ${STATE_WORD[it.state]}`)),
            detail,
          ),
          fixBtn,
        );
      }),
    );
  }

  function analyze() {
    analysis = analyzeProfile(ta.value);
    renderChecklist();
    renderFlag();
  }

  // Once the profile is really in use (not the untouched template), a call to action still on
  // the example site is flagged in the file bar too: every LinkedIn note would end with it.
  function renderFlag() {
    const cta = analysis.items.find((it) => it.id === CTA.id);
    flagBtn.hidden = !(loaded && !template && cta && cta.example);
  }

  // ---- saving ---------------------------------------------------------------------------

  /** Save until the server has what the editor shows (or a save fails). Never sends a blank,
   *  unloaded or untouched-template profile. */
  function saveNow() {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        again = false;
        const doc = ta.value;
        if (!loaded || template || !doc.trim()) break;
        if (same(doc, persisted) && !lastError) break;
        lastError = null;
        renderStatus();
        try {
          await api.post('/api/company', { doc });
          const wasEmpty = persisted.trim() === '';
          persisted = doc.trimStart();
          if (wasEmpty && store && typeof store.refresh === 'function') store.refresh();
        } catch (err) {
          lastError = err;
          break;
        }
      } while (again);
    })().finally(() => {
      inflight = null;
      if (!disposed) {
        renderStatus();
        emit();
      }
    });
    renderStatus();
    return inflight;
  }

  const queueSave = debounce(() => {
    pending = false;
    return saveNow();
  }, SAVE_DELAY_MS);

  function flush() {
    const p = pending ? queueSave.flush() : saveNow();
    return Promise.resolve(p).then(() => (inflight ? inflight : null)).then(() => state());
  }

  ta.addEventListener('input', () => {
    if (!loaded) return;
    template = false;
    pending = true;
    queueSave();
    analyze();
    renderStatus();
    emit();
  });
  ta.addEventListener('keydown', (e) => {
    if (!isSave(e)) return;
    e.preventDefault();
    flush();
  });

  // ---- loading --------------------------------------------------------------------------

  function show(doc) {
    persisted = doc;
    template = !doc.trim();
    ta.value = template ? PROFILE_TEMPLATE : doc;
    // Text an earlier editor couldn't save as it closed comes back (and saves), unless the file
    // has it by now.
    const draft = profileDraft;
    profileDraft = null;
    if (draft && !same(draft.doc, doc)) {
      // A blank file can't be saved back, so there's nothing to discard to.
      restoredFrom = doc.trim() ? doc : null;
      discardBtn.hidden = restoredFrom === null;
      template = false;
      ta.value = draft.doc;
      restored.hidden = false;
      pending = true;
      queueSave();
    }
    loaded = true;
    skeleton.hidden = true;
    checkSkeleton.hidden = true;
    checkNote.hidden = true;
    loadError.hidden = true;
    ta.hidden = false;
    for (const node of [progressEl, meter, list]) node.hidden = false;
    analyze();
    renderStatus();
    emit();
    resolveReady(state());
  }

  /** Back to what the file held before the restored draft, as an edit: it saves like one, and
   *  undo brings the draft back. */
  function discardRestored() {
    if (restoredFrom === null) return;
    const doc = restoredFrom;
    restoredFrom = null;
    restored.hidden = true;
    replaceRange(ta, 0, ta.value.length, doc, [0, 0]);
  }

  function load() {
    status = 'loading';
    skeleton.hidden = false;
    checkSkeleton.hidden = false;
    checkNote.hidden = true;
    loadError.hidden = true;
    renderStatus();
    api.get('/api/company', { signal: ac.signal }).then(
      (res) => {
        if (!disposed) show(lf(res && res.doc));
      },
      (err) => {
        if (disposed || (err && err.name === 'AbortError')) return;
        status = 'load-error';
        skeleton.hidden = true;
        checkSkeleton.hidden = true;
        checkNote.hidden = false;
        loadError.replaceChildren(
          h('span', { class: 'cp-load-error-icon' }, icon('error', 18)),
          h(
            'div',
            { class: 'cp-load-error-text' },
            h('p', { class: 'cp-load-error-title' }, "Couldn't load your profile."),
            h('p', { class: 'cp-load-error-detail' }, (err && err.message) || String(err)),
            h('p', { class: 'cp-load-error-detail' }, 'Nothing was changed. Editing stays off until it loads, so the saved profile isn’t overwritten.'),
          ),
          h('button', { type: 'button', class: 'btn btn-secondary', onClick: load }, 'Try again'),
        );
        loadError.hidden = false;
        renderStatus();
        emit();
      },
    );
  }

  // Coming back to the tab: pick up edits made elsewhere (another tab, the agent) unless there
  // is unsaved work here or the user is typing.
  function onVisibility() {
    if (document.hidden || disposed || !loaded) return;
    if (pending || inflight || lastError || document.activeElement === ta) return;
    if (!template && !same(ta.value, persisted)) return;
    const shown = ta.value;
    const known = persisted;
    api.get('/api/company', { signal: ac.signal }).then(
      (res) => {
        const doc = lf(res && res.doc);
        // Anything that happened here meanwhile (an edit, a save) wins over this older answer.
        if (disposed || pending || inflight || document.activeElement === ta) return;
        if (ta.value !== shown || persisted !== known) return;
        if (!doc.trim() || same(doc, persisted)) return;
        persisted = doc;
        template = false;
        ta.value = doc;
        analyze();
        renderStatus();
        emit();
      },
      () => {},
    );
  }

  // Closing or reloading the tab: a keepalive save on pagehide (below) carries the text past the
  // page, but only up to the browser's keepalive budget, and a save that just failed may fail
  // again. In those cases start the save now and ask the user to stay while it runs.
  function onBeforeUnload(e) {
    if (disposed || !loaded || template) return;
    const doc = ta.value;
    if (!doc.trim() || (same(doc, persisted) && !lastError)) return;
    if (!lastError && fitsKeepalive(doc)) return;
    flush();
    e.preventDefault();
    e.returnValue = '';
  }

  // Closing or reloading the tab inside the debounce window, during a save or after a failed
  // one: send the text with keepalive so it outlives the page.
  function onPageHide() {
    if (disposed || !loaded || template) return;
    const doc = ta.value;
    if (!doc.trim() || (!pending && !inflight && !lastError)) return;
    queueSave.cancel();
    pending = false;
    try {
      fetch('/api/company', {
        method: 'POST',
        credentials: 'same-origin',
        // Over the budget the browser refuses keepalive outright; a plain request may still land.
        keepalive: fitsKeepalive(doc),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doc }),
      }).then(
        // Only seen when the page comes back from the back/forward cache.
        (r) => {
          if (!r.ok || disposed) return;
          persisted = doc.trimStart();
          lastError = null;
          renderStatus();
          emit();
        },
        () => {},
      );
    } catch (_) {
      /* the page is going away */
    }
  }

  let wasConnected = el.isConnected;
  const observer = new MutationObserver(() => {
    if (el.isConnected) wasConnected = true;
    else if (wasConnected) dispose();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('pagehide', onPageHide);

  function dispose() {
    if (disposed) return;
    // Leaving with text the server doesn't have yet (a save waiting, running or failed): save it
    // now. No question can be asked here, so until that save lands the text is also kept for the
    // next editor, which puts it back if the file still lacks it.
    const doc = loaded && !template ? ta.value : '';
    if (doc.trim() && (pending || inflight || lastError || !same(doc, persisted))) {
      queueSave.cancel();
      pending = false;
      const draft = { doc };
      profileDraft = draft;
      saveNow().then(() => {
        if (!lastError && profileDraft === draft) profileDraft = null;
      });
    }
    disposed = true;
    queueSave.cancel();
    ac.abort();
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('pagehide', onPageHide);
    el.remove();
    resolveReady(state());
  }

  renderChecklist();
  load();

  return {
    el,
    ready,
    state,
    flush,
    focus: () => ta.focus(),
    dispose,
  };
}

// ---------------------------------------------------------------------------------------------
// Already contacted (contacted.toml)

const DOMAIN_TOKEN = /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})\.?(?::\d+)?(?:\/\S*)?$/i;
const KEY_LINE = /^\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_.-]+))\s*=/;
const TABLE_LINE = /^\s*\[\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_.-]+))\s*\]\s*(?:#.*)?$/;
/** Any table or array-of-tables header: past the first one, a `key = …` line is no longer top level. */
const HEADER_LINE = /^\s*\[\[?[^\]\n]*\]\]?\s*(?:#.*)?$/;
const isComment = (line) => line.trim().startsWith('#');

/** The domains on a line that holds only domains or links, else null. A link's "?query" or
 *  "#fragment" is dropped first, so "acme.com/p?x=1" is a link, not a `key = value` line. */
function lineDomains(line) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const bare = t.replace(/[?#][^\s,;]*/g, '');
  if (/[=[\]{}"']/.test(bare)) return null;
  const domains = bare.split(/[\s,;]+/).filter(Boolean).map((tok) => {
    const m = tok.match(DOMAIN_TOKEN);
    return m ? m[1].toLowerCase() : null;
  });
  return domains.length && domains.every(Boolean) ? domains : null;
}

/**
 * Turn lines that are only domains ("acme.com", "https://www.acme.com/x?ref=1", "a.com, b.io")
 * into contacted.toml entries with status "sent"; every other line is left for the server to
 * judge. Domains already listed (or repeated) are dropped and counted in `skipped`. Entries made
 * from lines below a `[table]` header move up above it: there they would be keys of that table,
 * which the parser accepts and seeding then ignores.
 * @returns {{ text: string, added: number, skipped: number }}
 */
export function normalizeContacted(raw) {
  const lines = String(raw ?? '').split('\n');
  const known = new Set();
  for (const line of lines) {
    const m = line.match(TABLE_LINE) || line.match(KEY_LINE);
    if (m) known.add((m[1] || m[2] || m[3]).toLowerCase());
  }
  const firstHeader = lines.findIndex((line) => HEADER_LINE.test(line));
  let added = 0;
  let skipped = 0;
  let headerAt = -1; // where the first header landed in `out`
  const out = [];
  const hoisted = [];
  lines.forEach((line, i) => {
    if (i === firstHeader) headerAt = out.length;
    const domains = lineDomains(line);
    if (!domains) {
      out.push(line);
      return;
    }
    const fresh = domains.filter((d) => !known.has(d) && known.add(d));
    added += fresh.length;
    skipped += domains.length - fresh.length;
    const entries = fresh.map((d) => `"${d}" = { status = "sent" }`);
    (firstHeader >= 0 && i > firstHeader ? hoisted : out).push(...entries);
  });
  if (hoisted.length) {
    // Just after the last top-level line: above the header's own comments and blank lines.
    let at = headerAt;
    while (at > 0 && isComment(out[at - 1])) at--;
    while (at > 0 && !out[at - 1].trim()) at--;
    const block = [...hoisted];
    if (at > 0 && isComment(out[at - 1])) block.unshift(''); // keep the file's header comment apart
    if (at === headerAt || out[at].trim()) block.push('');
    out.splice(at, 0, ...block);
  }
  return { text: out.join('\n'), added, skipped };
}

/** Entries in a contacted.toml: top-level `key = …` lines plus `[table]` headers. */
function countEntries(text) {
  let n = 0;
  let inTable = false;
  for (const line of String(text).split('\n')) {
    if (TABLE_LINE.test(line)) {
      n++;
      inTable = true;
    } else if (!inTable && KEY_LINE.test(line)) {
      n++;
    }
  }
  return n;
}

/** "Saved: 1 domain added, 1 already listed. The list has 3 domains." (counts from normalizeContacted). */
function savedMessage({ added, skipped }, total) {
  const what = [];
  if (added) what.push(`${pluralize(added, 'domain')} added`);
  if (skipped) what.push(`${added ? skipped : pluralize(skipped, 'domain')} already listed`);
  const head = what.length ? `Saved: ${what.join(', ')}.` : 'Saved.';
  return total ? `${head} The list has ${pluralize(total, 'domain')}.` : `${head} The list is empty.`;
}

/** Unsaved Already contacted text from a screen the user left; offered back on the next visit. */
let contactedDraft = null;

function mountContacted(root) {
  const id = `ac-${++uid}`;
  const ac = new AbortController();
  let saved = null;
  let busy = false;
  let disposed = false;

  const errorEl = h('p', { class: 'field-error ac-error', id: `${id}-error` });
  errorEl.hidden = true;
  const hintId = `${id}-hint`;
  const ta = h('textarea', {
    class: 'ac-text',
    id: `${id}-text`,
    spellcheck: 'false',
    autocapitalize: 'off',
    'aria-label': 'Already contacted domains',
    'aria-describedby': hintId,
    placeholder: 'acme.com\nbeta.io',
  });
  ta.hidden = true;
  const stateEl = h('span', { class: 'ac-state' });
  const msg = h('p', { class: 'ac-msg', role: 'status' });
  const discardBtn = h('button', { type: 'button', class: 'cp-text-btn', onClick: () => discard() }, 'Discard');
  const restored = h('p', { class: 'ac-restored' }, h('span', {}, 'Your unsaved changes from earlier are back.'), discardBtn);
  restored.hidden = true;
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true, onClick: () => save() }, 'Save');
  const foot = h(
    'div',
    { class: 'ac-foot' },
    h('div', { class: 'ac-feedback' }, errorEl, restored, msg, h('p', { class: 'field-hint', id: hintId }, 'One domain per line, or contacted.toml entries.')),
    saveBtn,
  );
  foot.hidden = true;
  const skeleton = skeletonLines([62, 48, 0, 55, 40]);
  const loadError = h('div', { class: 'ac-load-error cp-load-error', role: 'alert' });
  loadError.hidden = true;

  const main = h(
    'div',
    { class: 'ac-main cp-card' },
    h(
      'div',
      { class: 'cp-bar' },
      h('span', { class: 'cp-file' }, icon('file', 14), h('span', { class: 'mono' }, 'contacted.toml')),
      h('span', { class: 'cp-bar-end' }, stateEl),
    ),
    h('div', { class: 'ac-body' }, skeleton, loadError, ta),
    foot,
  );

  const code = (s) => h('code', {}, s);
  const help = h(
    'section',
    { class: 'ac-help cp-card', 'aria-labelledby': `${id}-help-title` },
    h('h2', { class: 'pe-check-title', id: `${id}-help-title` }, 'How this list works'),
    h('p', { class: 'ac-help-text' }, 'Domains you contacted before or outside coldtrail. Once they’re loaded into the pipeline, sourcing skips them, so nobody hears from you twice.'),
    h('p', { class: 'ac-help-label' }, 'Paste domains or links, or write entries:'),
    h('pre', { class: 'ac-example' }, 'acme.com\nhttps://www.beta.io/about\n"gamma.dev" = { status = "skip" }'),
    h('p', { class: 'ac-help-text' }, 'Domains and links are saved as ', code('status = "sent"'), ', already contacted. Use ', code('"skip"'), ' for companies you never want to contact.'),
    h('p', { class: 'ac-help-text' }, 'Saving writes ', code('contacted.toml'), ' on this machine. Run ', code('coldtrail seed'), ' in a terminal to load it into the pipeline.'),
  );

  const el = h('div', { class: 'ac' }, h('div', { class: 'cp-grid' }, main, help));
  root.append(el);

  function setInvalid(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
    if (message) {
      ta.setAttribute('aria-invalid', 'true');
      ta.setAttribute('aria-describedby', `${errorEl.id} ${hintId}`);
    } else {
      ta.removeAttribute('aria-invalid');
      ta.setAttribute('aria-describedby', hintId);
    }
  }

  const isDirty = () => saved !== null && ta.value !== saved;

  function renderState() {
    const dirty = isDirty();
    saveBtn.disabled = busy || !dirty;
    stateEl.textContent = busy ? 'Saving…' : dirty ? 'Unsaved changes' : saved !== null ? 'Saved' : '';
    stateEl.dataset.state = busy ? 'saving' : dirty ? 'dirty' : 'saved';
    if (!dirty) restored.hidden = true;
  }

  async function save() {
    if (busy || saved === null) return;
    const result = normalizeContacted(ta.value);
    const { text } = result;
    busy = true;
    ta.readOnly = true;
    msg.replaceChildren();
    setInvalid('');
    renderState();
    try {
      await api.post('/api/onboarding/contacted', { toml: text });
      if (disposed) return;
      saved = text;
      ta.value = text;
      const n = countEntries(text);
      msg.replaceChildren(savedMessage(result, n), ...(n ? [' Run ', code('coldtrail seed'), ' to load them into the pipeline.'] : []));
    } catch (err) {
      if (disposed) return;
      setInvalid(`Not saved: ${(err && err.message) || err}`);
    } finally {
      busy = false;
      ta.readOnly = false;
      if (!disposed) renderState();
    }
  }

  function discard() {
    ta.value = saved;
    setInvalid('');
    msg.replaceChildren();
    renderState();
    ta.focus();
  }

  ta.addEventListener('input', () => {
    if (!errorEl.hidden) setInvalid('');
    if (msg.firstChild) msg.replaceChildren();
    renderState();
  });
  // There is no autosave here (the server may reject the text), so ask before a close or reload
  // drops it. Leaving for another screen keeps it instead (see dispose).
  const onBeforeUnload = (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  ta.addEventListener('keydown', (e) => {
    if (!isSave(e)) return;
    e.preventDefault();
    if (!saveBtn.disabled) save();
  });

  function load() {
    skeleton.hidden = false;
    loadError.hidden = true;
    api.get('/api/onboarding/files', { signal: ac.signal }).then(
      (res) => {
        if (disposed) return;
        saved = String((res && res.contacted) || '');
        ta.value = saved;
        // Edits left unsaved on an earlier visit come back, unless the file already has them.
        const draft = contactedDraft;
        contactedDraft = null;
        if (draft !== null && draft !== saved && normalizeContacted(draft).text !== saved) {
          ta.value = draft;
          restored.hidden = false;
        }
        skeleton.hidden = true;
        ta.hidden = false;
        foot.hidden = false;
        renderState();
      },
      (err) => {
        if (disposed || (err && err.name === 'AbortError')) return;
        skeleton.hidden = true;
        loadError.replaceChildren(
          h('span', { class: 'cp-load-error-icon' }, icon('error', 18)),
          h(
            'div',
            { class: 'cp-load-error-text' },
            h('p', { class: 'cp-load-error-title' }, "Couldn't load the list."),
            h('p', { class: 'cp-load-error-detail' }, (err && err.message) || String(err)),
          ),
          h('button', { type: 'button', class: 'btn btn-secondary', onClick: load }, 'Try again'),
        );
        loadError.hidden = false;
      },
    );
  }

  load();
  return {
    dispose() {
      if (disposed) return;
      // Leaving the screen (no prompt is possible there): keep unsaved text for the next visit.
      // An unsaved draft that never loaded stays as it was.
      if (saved !== null) contactedDraft = isDirty() ? ta.value : null;
      disposed = true;
      ac.abort();
      window.removeEventListener('beforeunload', onBeforeUnload);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The view

const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'contacted', label: 'Already contacted' },
];
const tabOf = (query) => (query && query.tab === 'contacted' ? 'contacted' : 'profile');
/** The page description follows the tab: only the profile saves as you type. */
const TAB_DESC = {
  profile: 'The agent writes every email and LinkedIn note from this profile. It stays on this machine and saves as you type.',
  contacted: 'Companies you’ve already reached. Once loaded with coldtrail seed, sourcing skips them. The list stays on this machine and saves when you press Save.',
};

let active = null; // the mounted view: { setTab }

export default {
  title: TITLE,
  css: true,
  mount(root, ctx) {
    const panelId = `company-panel-${++uid}`;
    const tabList = tabs({
      items: TABS,
      active: tabOf(ctx.query),
      label: 'Company profile sections',
      panelId,
      onChange: (tab) => ctx.nav.setQuery({ tab: tab === 'profile' ? null : tab }),
    });
    const profilePane = h('div', { class: 'cp-pane' });
    const contactedPane = h('div', { class: 'cp-pane' });
    const panel = h('div', { class: 'cp-panel', id: panelId, role: 'tabpanel' }, profilePane, contactedPane);
    const desc = h('p', { class: 'page-desc' });

    root.append(
      h(
        'div',
        { class: 'company' },
        h('header', { class: 'page-head' }, h('div', { class: 'page-head-text' }, h('h1', {}, TITLE), desc)),
        h('div', { class: 'cp-tabs' }, tabList),
        panel,
      ),
    );

    const editor = mountProfileEditor(profilePane, { store: ctx.store });
    let contacted = null;

    function setTab(tab) {
      tabList.setActive(tab);
      desc.textContent = TAB_DESC[tab];
      profilePane.hidden = tab !== 'profile';
      contactedPane.hidden = tab !== 'contacted';
      const btn = tabList.querySelector(`[data-id="${tab}"]`);
      if (btn) panel.setAttribute('aria-labelledby', btn.id);
      if (tab === 'contacted' && !contacted) contacted = mountContacted(contactedPane);
    }
    setTab(tabOf(ctx.query));

    const me = { setTab };
    active = me;
    return () => {
      if (active === me) active = null;
      editor.dispose();
      if (contacted) contacted.dispose();
    };
  },
  update(ctx) {
    if (!active || ctx.path[0] !== 'company') return false;
    active.setTab(tabOf(ctx.query));
    return true;
  },
};

// Company profile (spec §5.8): `#/company?tab=profile|contacted`.
//
// Profile: product.md in a markdown editor that saves as you type, beside a checklist of the
// sections the agent drafts from. The checklist reads headings the way the backend does — the
// call-to-action check mirrors `product::cta_link()` line for line, so a ticked CTA is one the
// LinkedIn note path will really pick up. Already contacted: contacted.toml, validated by the
// server on save; plain domains (one per line) are turned into entries first.
//
// `mountProfileEditor` is exported for the Setup wizard's company step, with PROFILE_TEMPLATE:
// it needs only the app's tokens and base styles around it (it loads its own stylesheet), and
// cleans up when its root leaves the document or when dispose() is called.

import { api, errorText, isStaleSession } from '../core/api.js';
import { debounce, h, pluralize } from '../core/dom.js';
import { ensureViewCss } from '../core/router.js';
import { store as sharedStore } from '../core/store.js';
import { setBusy } from '../core/ui.js';
import { tabs } from '../components/tabs.js';

const TITLE = 'Company profile';
const SAVE_DELAY_MS = 600;
/** How long a new editor waits for the previous one's exit save before it loads the file. */
const EXIT_SAVE_WAIT_MS = 3000;

/** The example link the template ships with. product::cta_link() ignores it (any scheme, port or
 *  subdomain of EXAMPLE_HOST), so until it is replaced LinkedIn notes go out without a link. */
export const EXAMPLE_LINK = 'https://yourproduct.com/?utm_content={slug}';
const EXAMPLE_HOST = 'yourproduct.com';

/**
 * The one company profile template (the Setup wizard uses it too). What an empty profile starts
 * from: shown, not saved, until the user edits it. One heading per checklist section, and the call
 * to action in the one format `product::cta_link()` reads: a `- Link:` list item under
 * `## Call to Action` (a bare URL line there is never picked up).
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
/** A link line in another list style ("* Link: …", "+ Link: …"): cta_link() skips it. */
const OTHER_LINK_LINE = /^[*+]\s*link:\s*(\S.*)$/i;

/** A markdown heading: one to six "#" and then a space or nothing, so "#1 rated on G2" is text.
 *  (The call-to-action check alone uses product.rs's looser rule, see ctaItem.) */
const isHeading = (t) => /^#{1,6}(?:\s|$)/.test(t);
const headingText = (t) => t.replace(/^#+/, '').trim();
const isContent = (line) => {
  const t = line.trim();
  return t !== '' && !isHeading(t) && !PLACEHOLDER.test(t) && !COMMENT.test(t);
};

/** product.rs `link_line_value`, before its example-link test: `- Link: <value>` → value; a
 *  blank or "[…]" value → null; any other line → undefined. */
function linkLineValue(t) {
  if (!t.startsWith('-')) return undefined;
  const rest = t.slice(1).trimStart();
  if (rest.length < 5 || rest.slice(0, 5).toLowerCase() !== 'link:') return undefined;
  const value = rest.slice(5).trim();
  return value === '' || value.startsWith('[') ? null : value;
}

/** product.rs `is_example_link`: the template's example site, with any scheme, port, user or
 *  subdomain ("notyourproduct.com" is someone's real site). */
function isExampleLink(value) {
  let v = String(value).replace(/^<+/, '');
  const scheme = v.indexOf('://');
  if (scheme >= 0) v = v.slice(scheme + 3);
  const authority = v.split(/[/?#>]/)[0];
  const host = authority.split('@').pop().split(':')[0].replace(/\.+$/, '').toLowerCase();
  return host === EXAMPLE_HOST || host.endsWith(`.${EXAMPLE_HOST}`);
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

// Mirrors product.rs `parse_cta_link`: any line starting with "#" is a heading (no space needed);
// the section is the lines after a heading equal (ignoring ASCII case) to "call to action"; the
// first `- Link:` value in it that is neither "[placeholder]" text nor the example link wins.
function ctaItem(lines) {
  const base = { id: CTA.id, label: CTA.label, hint: CTA.hint, heading: CTA.heading };
  let inSection = false;
  let headingLine = -1;
  let near = null;
  let misformed = null; // a link the parser skips: a bare URL, or "* Link:" / "+ Link:"
  let placeholder = null;
  let example = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('#')) {
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
      if (isExampleLink(value)) {
        if (!example) example = { line: i, text: value };
        continue;
      }
      // cta_link() takes it as it is; a note can only open it as a web link.
      if (!/^https?:\/\//i.test(value)) {
        return { ...base, state: 'warn', link: value, hint: 'The link should start with https:// or http:// so it opens from a note.', fix: { kind: 'select-link', line: i, text: value } };
      }
      return { ...base, state: 'done', link: value };
    } else if (!misformed) {
      const m = t.match(OTHER_LINK_LINE) || t.match(BARE_URL);
      if (m) misformed = { line: i, url: m[1].trim(), bare: !OTHER_LINK_LINE.test(t) };
    }
  }
  if (headingLine >= 0) {
    if (misformed) {
      const why = misformed.bare ? 'A bare URL isn’t used in LinkedIn notes.' : 'Only a line starting with “-” is used in LinkedIn notes.';
      return { ...base, state: 'warn', hint: `Start the line with “- Link:”. ${why}`, fix: { kind: 'link-line', line: misformed.line, url: misformed.url } };
    }
    if (example) {
      return {
        ...base,
        state: 'warn',
        example: true,
        link: example.text,
        hint: 'Replace the example link with your real URL (keep {slug} to tag each company). Until then, LinkedIn notes go out without a link.',
        fix: { kind: 'select-link', line: example.line, text: example.text },
      };
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
 * headings, "# What we do" is the section. Headings need a space after their "#"s, as in
 * markdown. The call to action counts only with a `- Link: http(s)://…` line under a heading that
 * reads exactly "Call to Action", read the way product::cta_link() reads it: the template's
 * example link doesn't count (`example` marks a profile whose only link is that one).
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

/** Settles when `promise` does or after `ms`, whichever comes first; never rejects. */
function settled(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve(promise).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/** A notice that screen readers announce when it appears: a live region that stays in the page
 *  (empty takes no space) and gets the notice put in or taken out. */
function liveNotice(cls) {
  const region = h('div', { class: `cp-live ${cls}-live`, role: 'status' });
  return { region, show: (node) => region.replaceChildren(node), hide: () => region.replaceChildren() };
}

/** A textarea's value always uses "\n"; compare the server's text the same way. */
const lf = (s) => String(s || '').replace(/\r\n?/g, '\n');

function skeletonLines(widths) {
  return h('div', { class: 'cp-skeleton', 'aria-hidden': 'true' }, widths.map((w) => h('span', { class: 'skeleton', style: `width:${w}%` })));
}

/** Fill `box` with a failed load: what didn't load, why, an optional note, and Try again. On a
 *  stale session the shell's banner (an alert) already says what happened, once: the card gives
 *  the short pointer at the fix, isn't an alert itself, and has no Try again (nothing loads
 *  until the tab is reopened). */
function showLoadError(box, { title, err, note, retry }) {
  const stale = isStaleSession(err);
  if (stale) box.removeAttribute('role');
  else box.setAttribute('role', 'alert');
  const parts = [
    h('span', { class: 'cp-load-error-icon' }, icon('error', 18)),
    h(
      'div',
      { class: 'cp-load-error-text' },
      h('p', { class: 'cp-load-error-title' }, title),
      h('p', { class: 'cp-load-error-detail' }, errorText(err)),
      note ? h('p', { class: 'cp-load-error-detail' }, note) : null,
    ),
  ];
  if (!stale) parts.push(h('button', { type: 'button', class: 'btn btn-secondary', onClick: retry }, 'Try again'));
  box.replaceChildren(...parts);
  box.hidden = false;
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
/** The save a closing editor started (settles, never rejects): the next editor loads after it,
 *  so it neither reads the file from before that save nor offers back text that just landed. */
let exitSave = null;

const STATUS_TEXT = {
  loading: 'Loading…',
  'load-error': 'Not loaded',
  template: 'Template · not saved yet',
  saving: 'Saving…',
  dirty: 'Unsaved changes',
  saved: 'Saved',
  empty: 'Not saved: the profile can’t be empty',
};
const STATUS_ICON = { saved: 'check', error: 'error', empty: 'warn', 'load-error': 'error' };

/**
 * Mount the company profile editor (product.md) into `root`: a markdown textarea that autosaves
 * (600ms after typing stops, ⌘S / Ctrl+S saves at once) with a save indicator, and the section
 * checklist beside it. An empty profile shows PROFILE_TEMPLATE, unsaved until the user edits it.
 * It never saves before the profile has loaded, and never saves a blank profile (an empty
 * product.md would send the workspace back to setup). Works on any page of the app (it needs the
 * app's tokens and base styles, and the session cookie): it adds its own stylesheet and stays
 * invisible until that has loaded.
 *
 * Cleanup: removing `root` (or the editor) from the document, or calling dispose(), saves any
 * edit the server doesn't have yet (one waiting, or one whose save failed), aborts loads and
 * removes every listener and timer. After that onChange stops. Until that last save lands, the
 * text is kept in memory: the next editor mounted on this page waits for that save (up to 3s),
 * then restores the text (and saves it) if the file still lacks it, with a notice and a Discard.
 * Closing or reloading the tab sends unsaved text with a keepalive request; when the text is too
 * big for one (over 60 KiB) or the last save failed, the browser asks before leaving instead.
 *
 * A stale session (401): the load card and the save state give the short "Reopen coldtrail from
 * your terminal." (the shell's banner says the rest) and offer no Try again or Retry.
 *
 * @param {HTMLElement} root  Where the editor is appended.
 * @param {{ onChange?: (state: ProfileState) => void, store?: { refresh(): unknown },
 *   headingLevel?: number }} [opts]
 *   onChange runs after the load, on every edit and whenever the save status changes.
 *   `store` is refreshed after the first save of a previously empty profile (default: the
 *   shared store), so setup/onboarding state catches up.
 *   `headingLevel`: the checklist title's heading level, 2–6 (default 2; anything else gives 2).
 *   It looks the same at every level. Setup, whose step heading is an h2, passes 3.
 * @returns {{ el: HTMLElement, ready: Promise<ProfileState>, state(): ProfileState,
 *   flush(): Promise<ProfileState>, focus(): void, dispose(): void }}
 *   ready resolves once the profile has loaded (after a retry if the first load fails) or the
 *   editor is disposed; it never rejects. flush() saves now and resolves when every save has
 *   settled (a view's beforeLeave can await it). dispose() also removes the editor from `root`.
 *
 * @typedef {{ doc: string, loaded: boolean, empty: boolean, template: boolean, persisted: boolean,
 *   status: 'loading'|'load-error'|'template'|'saving'|'dirty'|'saved'|'error'|'empty',
 *   error: string|null,
 *   checklist: { done: number, total: number, items: object[] } }} ProfileState
 *   `persisted`: the server holds a non-blank profile (what /api/status calls product_set).
 *   `error`: why the last save failed, or (status 'load-error') why the load failed: the
 *   request's message, which is api.js's SESSION_EXPIRED on a stale session; else null.
 */
export function mountProfileEditor(root, { onChange, store = sharedStore, headingLevel = 2 } = {}) {
  const id = `pe-${++uid}`;
  const level = Number(headingLevel);
  const titleTag = Number.isInteger(level) && level >= 2 && level <= 6 ? `h${level}` : 'h2';
  const ac = new AbortController();
  let disposed = false;
  let loaded = false;
  let template = false;
  let persisted = ''; // what the server holds (as far as we know)
  let pending = false; // a debounced save is waiting
  let inflight = null; // the running save loop
  let again = false;
  let lastError = null; // why the last save failed
  let loadFailure = null; // why the last load failed
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
      'aria-label': 'Replace example link: LinkedIn notes go out without a link until you do',
      title: 'LinkedIn notes go out without a link until you replace the example link',
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
  const restoredNotice = liveNotice('pe-restored');
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
    restoredNotice.region,
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
    h('div', { class: 'pe-check-head' }, h(titleTag, { class: 'pe-check-title', id: `${id}-check-title` }, 'Checklist'), progressEl),
    meter,
    h('p', { class: 'pe-check-desc' }, 'Sections the agent looks for, found by their headings. It only uses what you write here.'),
    checkSkeleton,
    checkNote,
    list,
  );

  const el = h('div', { class: 'pe' }, h('div', { class: 'cp-grid' }, main, aside));
  // Unstyled for a moment outside the Company route (the Setup wizard) is worse than a blank one.
  el.style.visibility = 'hidden';
  const styled = ensureViewCss('company').then(() => el.style.removeProperty('visibility'));
  root.append(el);

  // ---- state ----------------------------------------------------------------------------

  const same = (a, b) => a.trimStart() === b.trimStart();

  function state() {
    const doc = loaded ? ta.value : '';
    const err = lastError || (status === 'load-error' ? loadFailure : null);
    return {
      doc,
      loaded,
      empty: !doc.trim(),
      template,
      persisted: persisted.trim() !== '',
      status,
      error: err ? err.message || String(err) : null,
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
    // A stale session: the short pointer (the banner says the rest) and no Retry, which can't
    // work until the tab is reopened (typing still saves, should the session come back).
    const text = status === 'error' ? `Couldn’t save: ${errorText(lastError)}` : STATUS_TEXT[status];
    if (statusText.textContent !== text) statusText.textContent = text;
    if (status === 'empty') statusEl.title = 'An empty profile would send coldtrail back to setup, so the last saved version is kept.';
    else if (status === 'error') statusEl.title = text;
    else statusEl.removeAttribute('title');
    statusIcon.replaceChildren(STATUS_ICON[status] ? icon(STATUS_ICON[status], 14) : '');
    retryBtn.hidden = status !== 'error' || isStaleSession(lastError);
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
    'select-link': (it) => (it.example ? ['Replace link', 'Replace link'] : ['Edit link', 'Edit link']),
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
        // A light suggestion: a compact "+ Add" at the end of the label's line, leaving the hint
        // the panel's full width. A real problem: the fix sits under its explanation.
        const addBtn =
          fixKind === 'append'
            ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm pe-item-add', 'aria-label': label, onClick: () => applyFix(it.id, fixKind) }, icon('plus', 14), text)
            : null;
        const fixBtn =
          fixKind && fixKind !== 'append'
            ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm pe-item-fix', onClick: () => applyFix(it.id, fixKind) }, text)
            : null;
        return h(
          'li',
          { class: 'pe-item', 'data-section': it.id, 'data-state': it.state },
          h('span', { class: 'pe-item-icon' }, icon(it.state === 'done' ? 'done' : it.state === 'warn' ? 'warn' : 'todo')),
          h(
            'div',
            { class: 'pe-item-text' },
            h('div', { class: 'pe-item-head' }, h('span', { class: 'pe-item-label' }, it.label, h('span', { class: 'sr-only' }, `: ${STATE_WORD[it.state]}`)), addBtn),
            detail,
            fixBtn,
          ),
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
  // the example site is flagged in the file bar too: until it's replaced, LinkedIn notes go out
  // without a link.
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
    // has it by now (load() waited for that editor's last save).
    const draft = profileDraft;
    profileDraft = null;
    if (draft && !same(draft.doc, doc)) {
      // A blank file can't be saved back, so there's nothing to discard to.
      restoredFrom = doc.trim() ? doc : null;
      discardBtn.hidden = restoredFrom === null;
      template = false;
      ta.value = draft.doc;
      restoredNotice.show(restored);
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
    restoredNotice.hide();
    replaceRange(ta, 0, ta.value.length, doc, [0, 0]);
  }

  function load() {
    status = 'loading';
    skeleton.hidden = false;
    checkSkeleton.hidden = false;
    checkNote.hidden = true;
    loadError.hidden = true;
    renderStatus();
    // An editor closed just before this one may still be saving: read the file once that save
    // has landed (or failed: then its text comes back), not before.
    const before = exitSave ? settled(exitSave, EXIT_SAVE_WAIT_MS) : null;
    Promise.resolve(before)
      .then(() => (disposed ? null : api.get('/api/company', { signal: ac.signal })))
      .then((res) => {
        if (!disposed) show(lf(res && res.doc));
      }, loadFailed);
  }

  function loadFailed(err) {
    if (disposed || (err && err.name === 'AbortError')) return;
    status = 'load-error';
    loadFailure = err;
    skeleton.hidden = true;
    checkSkeleton.hidden = true;
    checkNote.hidden = false;
    showLoadError(loadError, {
      title: 'Couldn’t load your profile.',
      err,
      note: 'Nothing was changed. Editing stays off until it loads, so the saved profile isn’t overwritten.',
      retry: load,
    });
    renderStatus();
    emit();
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
    // next editor, which waits for this save and puts the text back only if it failed.
    const doc = loaded && !template ? ta.value : '';
    if (doc.trim() && (pending || inflight || lastError || !same(doc, persisted))) {
      queueSave.cancel();
      pending = false;
      const draft = { doc };
      profileDraft = draft;
      const saving = saveNow().then(() => {
        if (!lastError && profileDraft === draft) profileDraft = null;
        if (exitSave === saving) exitSave = null;
      });
      exitSave = saving;
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
    // An invisible textarea can't take focus: wait for the stylesheet if it's still coming.
    focus: () => {
      if (el.style.visibility) styled.then(() => ta.focus());
      else ta.focus();
    },
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
 * @returns {{ text: string, added: number, skipped: number, from: number[] }} `from[k]`: the line
 *   of `raw` that line k of `text` came from (-1 for a blank line put between moved entries), so
 *   a parse error's line number can be found in what the user typed.
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
  const from = [];
  const hoisted = [];
  const hoistedFrom = [];
  lines.forEach((line, i) => {
    if (i === firstHeader) headerAt = out.length;
    const domains = lineDomains(line);
    if (!domains) {
      out.push(line);
      from.push(i);
      return;
    }
    const fresh = domains.filter((d) => !known.has(d) && known.add(d));
    added += fresh.length;
    skipped += domains.length - fresh.length;
    const entries = fresh.map((d) => `"${d}" = { status = "sent" }`);
    const hoist = firstHeader >= 0 && i > firstHeader;
    (hoist ? hoisted : out).push(...entries);
    (hoist ? hoistedFrom : from).push(...entries.map(() => i));
  });
  if (hoisted.length) {
    // Just after the last top-level line: above the header's own comments and blank lines.
    let at = headerAt;
    while (at > 0 && isComment(out[at - 1])) at--;
    while (at > 0 && !out[at - 1].trim()) at--;
    const block = [...hoisted];
    const blockFrom = [...hoistedFrom];
    if (at > 0 && isComment(out[at - 1])) {
      block.unshift(''); // keep the file's header comment apart
      blockFrom.unshift(-1);
    }
    if (at === headerAt || out[at].trim()) {
      block.push('');
      blockFrom.push(-1);
    }
    out.splice(at, 0, ...block);
    from.splice(at, 0, ...blockFrom);
  }
  return { text: out.join('\n'), added, skipped, from };
}

/** The TOML parser's snippet ("  |", "4 | text", "  |     ^") with line `from` shown as line
 *  `to`; the gutter is re-padded to the new number's width so the "^" still lines up. A snippet
 *  in another shape is left as it is. */
function renumber(snippet, from, to) {
  const lines = snippet.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${from} | `));
  if (at < 0) return snippet;
  const gutter = `${' '.repeat(from.length + 1)}|`;
  return lines
    .map((l, i) => {
      if (i === at) return to + l.slice(from.length);
      return l.startsWith(gutter) ? ' '.repeat(to.length + 1) + l.slice(from.length + 1) : l;
    })
    .join('\n');
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
  let loadFailed = false;
  let disposed = false;

  // A rejected save: the server's reason (an alert, so it's heard even though focus stays on
  // Save), then the parser's snippet as it printed it, and a way to the line it names.
  const errorEl = h('p', { class: 'field-error ac-error', id: `${id}-error`, role: 'alert' });
  const errorSnippet = h('pre', { class: 'ac-error-snippet' });
  const gotoBtn = h('button', { type: 'button', class: 'cp-text-btn ac-error-goto', onClick: () => gotoError() });
  const errorMore = h('div', { class: 'ac-error-more' }, errorSnippet, gotoBtn);
  const errorBox = h('div', { class: 'ac-error-box' }, errorEl, errorMore);
  for (const node of [errorBox, errorEl, errorMore]) node.hidden = true;
  let errorAt = null; // { line, col } the rejected text's parse error points at, in the textarea
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
  // Like the profile's save state: an icon once it's saved, the words always.
  const stateIcon = h('span', { class: 'pe-status-icon' });
  const stateText = h('span', { class: 'ac-state-text' });
  const stateEl = h('span', { class: 'ac-state' }, stateIcon, stateText);
  const msg = h('p', { class: 'ac-msg', role: 'status' });
  const discardBtn = h('button', { type: 'button', class: 'cp-text-btn', onClick: () => discard() }, 'Discard');
  const restored = h('p', { class: 'ac-restored' }, h('span', {}, 'Your unsaved changes from earlier are back.'), discardBtn);
  const restoredNotice = liveNotice('ac-restored');
  // aria-disabled rather than disabled while there's nothing to save, so focus stays on it after a
  // save (a disabled button drops focus to the page).
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary ac-save', 'aria-disabled': 'true', onClick: () => save() }, 'Save');
  const foot = h(
    'div',
    { class: 'ac-foot' },
    errorBox,
    h('div', { class: 'ac-feedback' }, msg, h('p', { class: 'field-hint', id: hintId }, 'One domain per line, or contacted.toml entries.')),
    saveBtn,
  );
  foot.hidden = true;
  const skeleton = skeletonLines([62, 48, 0, 55, 40]);
  const loadError = h('div', { class: 'ac-load-error cp-load-error', role: 'alert' });
  loadError.hidden = true;

  // The restored-draft notice sits under the file bar, as on the profile tab: its live region is
  // on screen from the start (the footer stays hidden until the list loads), so the notice put in
  // it on load is announced.
  const main = h(
    'div',
    { class: 'ac-main cp-card' },
    h(
      'div',
      { class: 'cp-bar' },
      h('span', { class: 'cp-file' }, icon('file', 14), h('span', { class: 'mono' }, 'contacted.toml')),
      h('span', { class: 'cp-bar-end' }, stateEl),
    ),
    restoredNotice.region,
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

  // The card is sized to fill the screen. What shows up around the text box (a rejected save's
  // reason above Save, the restored-draft notice) takes its height from the box, down to the
  // box's minimum, so the card still fits and Save stays in view. Kept up to date as they come,
  // go and re-wrap when the window is resized.
  function fit() {
    const error = errorBox.hidden ? 0 : errorBox.getBoundingClientRect().height + (parseFloat(getComputedStyle(foot).rowGap) || 0);
    const extra = Math.ceil(restoredNotice.region.getBoundingClientRect().height + error);
    main.style.setProperty('--ac-extra-h', `${extra}px`);
  }
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  if (resized) for (const node of [errorBox, restoredNotice.region]) resized.observe(node);

  function clearError() {
    errorEl.replaceChildren();
    errorSnippet.replaceChildren();
    for (const node of [errorBox, errorEl, errorMore]) node.hidden = true;
    errorAt = null;
    ta.removeAttribute('aria-invalid');
    ta.setAttribute('aria-describedby', hintId);
    fit();
  }

  /** The server's reason for refusing `result.text` (normalizeContacted's output): the first line
   *  in words; the rest ("  |", "2 | …", "  |  ^", what the parser expected) kept as printed,
   *  except that a line number is given as the line in the text as typed. */
  function showError(message, result) {
    const [head, ...rest] = String(message).replace(/\s+$/, '').split('\n');
    let first = head;
    let snippet = rest.join('\n');
    errorAt = locate(head, result);
    if (errorAt && errorAt.line !== errorAt.sent) {
      // Domain lines above it became several entries (or moved): the parser counted lines of
      // text the user never sees. Give the line as typed, so the reason, its snippet and "Go to
      // line" all name the line the textarea shows.
      const n = String(errorAt.line + 1);
      first = head.replace(/\bline \d+, column \d+/, errorAt.exact ? `line ${n}, column ${errorAt.col + 1}` : `line ${n}`);
      snippet = renumber(snippet, String(errorAt.sent + 1), n);
    }
    errorSnippet.textContent = snippet;
    errorSnippet.hidden = !snippet;
    gotoBtn.textContent = errorAt ? `Go to line ${errorAt.line + 1}` : '';
    gotoBtn.hidden = !errorAt;
    errorMore.hidden = !snippet && !errorAt;
    errorEl.textContent = `Not saved: ${first}`;
    errorEl.hidden = false;
    errorBox.hidden = false;
    ta.setAttribute('aria-invalid', 'true');
    ta.setAttribute('aria-describedby', `${errorEl.id} ${hintId}`);
    fit();
    // Where the text box can't give up enough (a short window, a phone, a box made taller by
    // hand), bring the reason and Save into view: focus stays on Save.
    foot.scrollIntoView({ block: 'nearest' });
  }

  /** "… at line N, column M" in the text that was sent → that place in the text as typed (domain
   *  lines become entries, and may move, before sending). The column only holds on a line that
   *  was sent unchanged (`exact`). `sent`: the line in the text that was sent. */
  function locate(message, result) {
    const m = /\bline (\d+), column (\d+)/.exec(message);
    if (!m) return null;
    const k = Number(m[1]) - 1;
    const line = result.from[k];
    if (line == null || line < 0) return null;
    const exact = result.text.split('\n')[k] === ta.value.split('\n')[line];
    return { line, sent: k, exact, col: exact ? Math.max(0, Number(m[2]) - 1) : 0 };
  }

  function gotoError() {
    if (!errorAt) return;
    const v = ta.value;
    const at = Math.min(lineStart(v, errorAt.line) + errorAt.col, lineEnd(v, errorAt.line));
    ta.focus();
    ta.setSelectionRange(at, at);
  }

  const isDirty = () => saved !== null && ta.value !== saved;

  function renderState() {
    const dirty = isDirty();
    if (!busy) {
      if (dirty) saveBtn.removeAttribute('aria-disabled');
      else saveBtn.setAttribute('aria-disabled', 'true');
    }
    const state = busy ? 'saving' : dirty ? 'dirty' : saved !== null ? 'saved' : loadFailed ? 'load-error' : 'loading';
    stateText.textContent = { saving: 'Saving…', dirty: 'Unsaved changes', saved: 'Saved', 'load-error': 'Not loaded', loading: '' }[state];
    stateIcon.replaceChildren(state === 'saved' ? icon('check', 14) : state === 'load-error' ? icon('error', 14) : '');
    stateEl.dataset.state = state;
    if (!dirty) restoredNotice.hide();
  }

  async function save() {
    if (busy || !isDirty()) return;
    const result = normalizeContacted(ta.value);
    const { text } = result;
    busy = true;
    ta.readOnly = true;
    setBusy(saveBtn, true);
    msg.replaceChildren();
    clearError();
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
      // A stale session: the short pointer, since the shell's banner says the rest.
      showError(errorText(err), result);
    } finally {
      busy = false;
      ta.readOnly = false;
      setBusy(saveBtn, false);
      if (!disposed) renderState();
    }
  }

  function discard() {
    ta.value = saved;
    clearError();
    msg.replaceChildren();
    renderState();
    ta.focus();
  }

  ta.addEventListener('input', () => {
    if (!errorEl.hidden) clearError();
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
    save();
  });

  function load() {
    skeleton.hidden = false;
    loadError.hidden = true;
    loadFailed = false;
    renderState();
    api.get('/api/onboarding/files', { signal: ac.signal }).then(
      (res) => {
        if (disposed) return;
        // The textarea turns "\r\n" into "\n": compare the file's text the same way.
        saved = lf(res && res.contacted);
        ta.value = saved;
        // Edits left unsaved on an earlier visit come back, unless the file already has them.
        const draft = contactedDraft;
        contactedDraft = null;
        if (draft !== null && draft !== saved && normalizeContacted(draft).text !== saved) {
          ta.value = draft;
          restoredNotice.show(restored);
        }
        skeleton.hidden = true;
        ta.hidden = false;
        foot.hidden = false;
        renderState();
      },
      (err) => {
        if (disposed || (err && err.name === 'AbortError')) return;
        skeleton.hidden = true;
        loadFailed = true;
        showLoadError(loadError, { title: 'Couldn’t load the list.', err, retry: load });
        renderState();
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
      if (resized) resized.disconnect();
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
/** The page description follows the tab: only the profile saves as you type. Each fits one line
 *  wherever the editor and its side panel sit side by side (the screen is sized to fit then);
 *  the help panel says the list stays on this machine. */
const TAB_DESC = {
  profile: 'The agent writes every email and LinkedIn note from this profile. It stays on this machine and saves as you type.',
  contacted: 'Companies you’ve already reached. Once loaded with coldtrail seed, sourcing skips them. The list saves when you press Save.',
};

let active = null; // the mounted view: { setTab, flush }

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
    // Both tabs' descriptions share one spot, the other tab's invisible: the header keeps the
    // taller one's height, so the tabs below don't jump when one wraps to more lines.
    const descs = TABS.map((t) => h('span', { class: 'cp-desc-text', 'data-tab': t.id }, TAB_DESC[t.id]));
    const desc = h('p', { class: 'page-desc cp-desc' }, descs);

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
      for (const d of descs) d.toggleAttribute('data-off', d.dataset.tab !== tab);
      profilePane.hidden = tab !== 'profile';
      contactedPane.hidden = tab !== 'contacted';
      const btn = tabList.querySelector(`[data-id="${tab}"]`);
      if (btn) panel.setAttribute('aria-labelledby', btn.id);
      if (tab === 'contacted' && !contacted) contacted = mountContacted(contactedPane);
    }
    setTab(tabOf(ctx.query));

    const me = { setTab, flush: () => editor.flush() };
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
  // Leaving the screen: the router waits (up to 1.5s) for an edit inside the autosave delay to be
  // saved before the next screen mounts. Unmounting still saves anything left after that.
  beforeLeave() {
    return active ? active.flush() : undefined;
  },
};

// Overlay focus return (ui/js/core/ui.js) against a small fake DOM. In WebKit a mouse click does
// not focus the button, so an overlay opened by mouse sees document.activeElement === <body>;
// these tests open overlays from that state and check where Esc sends focus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMenu, openDialog, openDrawer, confirmDialog } from '../../ui/js/core/ui.js';

/** Install globals for the duration of `fn`, then restore whatever was there. */
async function withGlobals(globals, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  }
}

class El extends EventTarget {
  constructor(doc, tag) {
    super();
    this.doc = doc;
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this.style = {};
    this.inert = false;
    const classes = new Set();
    this.classList = { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...nodes) {
    for (const n of nodes) {
      if (n instanceof El) {
        n.remove();
        n.parent = this;
      }
      this.children.push(typeof n === 'string' ? { text: n } : n);
    }
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(n) {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  get isConnected() { return this.doc.documentElement.contains(this); }
  focus() { this.doc.activeElement = this; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 40, bottom: 30, width: 30, height: 20 }; }
  get offsetWidth() { return 120; }
  get offsetHeight() { return 80; }
}

function fakeDom() {
  const doc = new EventTarget();
  doc.createElement = (t) => new El(doc, t);
  doc.createElementNS = (_ns, t) => new El(doc, t);
  doc.createTextNode = (s) => ({ text: s });
  doc.documentElement = new El(doc, 'html');
  doc.documentElement.clientWidth = 1000;
  doc.documentElement.clientHeight = 800;
  doc.body = new El(doc, 'body');
  doc.documentElement.append(doc.body);
  doc.activeElement = doc.body;
  doc.getElementById = (id) => {
    const walk = (el) => {
      if (el.attrs.id === id) return el;
      for (const c of el.children) {
        const hit = c instanceof El && walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(doc.documentElement);
  };
  const win = new EventTarget();
  win.innerHeight = 800;

  const el = (tag, id) => {
    const e = new El(doc, tag);
    if (id) e.setAttribute('id', id);
    return e;
  };
  const app = el('div', 'app');
  const view = el('main', 'view');
  const trigger = el('button');
  const other = el('button');
  view.append(trigger, other);
  app.append(view);
  doc.body.append(app);
  return { doc, win, view, trigger, other };
}

function pressEscape(doc) {
  const e = new Event('keydown', { cancelable: true });
  e.key = 'Escape';
  doc.dispatchEvent(e);
}

test('menu: Esc refocuses the anchor even when the click did not focus it', async () => {
  const { doc, win, trigger } = fakeDom();
  await withGlobals({ document: doc, window: win }, () => {
    doc.activeElement = doc.body; // WebKit: clicking the anchor left focus on <body>
    openMenu(trigger, [{ label: 'Edit' }, { label: 'Delete', danger: true }]);
    assert.equal(doc.activeElement.attrs.role, 'menuitem', 'the first item takes focus');
    assert.equal(trigger.attrs['aria-expanded'], 'true');
    pressEscape(doc);
    assert.equal(doc.activeElement, trigger);
    assert.equal(trigger.attrs['aria-expanded'], 'false');
  });
});

test('dialog, drawer and confirm return focus to an explicit opener', async () => {
  const { doc, win, trigger } = fakeDom();
  await withGlobals({ document: doc, window: win }, async () => {
    doc.activeElement = doc.body;
    openDialog({ title: 'T', content: 'x', actions: [{ label: 'OK' }], opener: trigger });
    assert.notEqual(doc.activeElement, doc.body, 'focus moved into the dialog');
    assert.ok(doc.documentElement.classList.contains('has-overlay'));
    pressEscape(doc);
    assert.equal(doc.activeElement, trigger, 'dialog');
    assert.ok(!doc.documentElement.classList.contains('has-overlay'));

    doc.activeElement = doc.body;
    openDrawer({ title: 'T', content: 'x', opener: trigger });
    pressEscape(doc);
    assert.equal(doc.activeElement, trigger, 'drawer');

    doc.activeElement = doc.body;
    const answer = confirmDialog({ title: 'Delete?', body: 'Sure?', danger: true, opener: trigger });
    pressEscape(doc);
    assert.equal(await answer, false);
    assert.equal(doc.activeElement, trigger, 'confirm');
  });
});

test('without an opener, focus returns to the element focused at open, else #view', async () => {
  const { doc, win, view, other } = fakeDom();
  await withGlobals({ document: doc, window: win }, () => {
    other.focus(); // keyboard-opened: the trigger has focus
    openDialog({ title: 'T', content: 'x', actions: [{ label: 'OK' }] });
    pressEscape(doc);
    assert.equal(doc.activeElement, other);

    doc.activeElement = doc.body;
    openDrawer({ title: 'T', content: 'x' });
    pressEscape(doc);
    assert.equal(doc.activeElement, view);
  });
});

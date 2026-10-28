// Overlays and feedback helpers (ui/js/core/ui.js, and keys.js over an open overlay) against a
// small fake DOM. In WebKit a mouse click does not focus the button, so an overlay opened by mouse
// sees document.activeElement === <body>; these tests open overlays from that state and check
// where Esc sends focus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMenu, openDialog, openDrawer, confirmDialog, closeTopOverlay, copyText, setBusy, isBusy } from '../../ui/js/core/ui.js';
import { bindKeys, clearOverlay } from '../../ui/js/core/keys.js';

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
  prepend(...nodes) {
    const rest = this.children;
    this.children = [];
    this.append(...nodes);
    this.children.push(...rest);
  }
  replaceChildren(...nodes) {
    for (const c of this.children) if (c instanceof El) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  get childNodes() { return [...this.children]; }
  get textContent() { return this.children.map((c) => (c instanceof El ? c.textContent : c.text)).join(''); }
  select() { this.doc.selection = { el: this, text: this.value }; }
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
  const find = (pred) => {
    const walk = (el) => {
      if (pred(el)) return el;
      for (const c of el.children) {
        const hit = c instanceof El && walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(doc.documentElement);
  };
  doc.getElementById = (id) => find((el) => el.attrs.id === id);
  doc.querySelector = (sel) => (sel === '[data-overlay]' ? find((el) => 'data-overlay' in el.attrs) : null);
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

test('closeTopOverlay closes the overlay on top as Esc would', async () => {
  const { doc, win, trigger } = fakeDom();
  await withGlobals({ document: doc, window: win }, () => {
    assert.equal(closeTopOverlay(), false, 'nothing open');
    const reasons = [];
    openDrawer({ title: 'D', content: 'x', opener: trigger, onClose: (r) => reasons.push(['drawer', r]) });
    openDialog({ title: 'T', content: 'x', actions: [{ label: 'OK' }], onClose: (r) => reasons.push(['dialog', r]) });
    assert.equal(closeTopOverlay(), true);
    assert.deepEqual(reasons, [['dialog', 'escape']]);
    assert.ok(doc.querySelector('[data-overlay]'), 'the drawer is still open');
    closeTopOverlay();
    assert.deepEqual(reasons.at(-1), ['drawer', 'escape']);
    assert.equal(doc.activeElement, trigger);
    assert.equal(doc.querySelector('[data-overlay]'), null);
  });
});

test('mod+k reaches its handler over an overlay; clearOverlay() closes the top one, then it runs', async () => {
  const { doc, win, trigger } = fakeDom();
  await withGlobals({ document: doc, window: win }, () => {
    const hits = [];
    let canAct = true;
    // Like the shell's handler: decline when it can't act, else clear the overlays first.
    const unbind = bindKeys({
      'mod+k': () => {
        if (!canAct) return false;
        if (!clearOverlay()) return true;
        hits.push('mod+k');
        return true;
      },
      j: () => hits.push('j'),
    });
    const press = (key, mods = {}) => {
      const e = new Event('keydown', { cancelable: true });
      Object.assign(e, { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, mods);
      Object.defineProperty(e, 'target', { value: doc.activeElement });
      doc.dispatchEvent(e);
      return e;
    };
    try {
      const reasons = [];
      openDrawer({ title: 'D', content: 'x', opener: trigger, onClose: (r) => reasons.push(r) });
      press('j');
      assert.deepEqual(hits, [], 'page keys stay off while a drawer is open');

      // A handler that can't act (Setup hides the search) leaves the overlay and the key alone.
      canAct = false;
      const declined = press('k', { metaKey: true });
      assert.deepEqual(reasons, [], 'the drawer stays open');
      assert.ok(doc.querySelector('[data-overlay]'));
      assert.equal(declined.defaultPrevented, false, "the browser's own shortcut is not blocked");
      canAct = true;

      const e = press('k', { metaKey: true });
      assert.deepEqual(reasons, ['escape'], 'closed as Esc would close it');
      assert.deepEqual(hits, ['mod+k']);
      assert.ok(e.defaultPrevented);

      // Two overlays: only the top one closes; the next press reaches the one under it.
      openDrawer({ title: 'D', content: 'x', opener: trigger });
      openDialog({ title: 'T', content: 'x', actions: [{ label: 'OK' }] });
      hits.length = 0;
      const e2 = press('k', { ctrlKey: true });
      assert.deepEqual(hits, [], 'still behind the drawer');
      assert.ok(e2.defaultPrevented, 'the key is used up either way');
      assert.ok(doc.querySelector('[data-overlay]'), 'the drawer is still open');
      press('k', { ctrlKey: true });
      assert.deepEqual(hits, ['mod+k']);
      assert.equal(doc.querySelector('[data-overlay]'), null);
      assert.equal(clearOverlay(), true, 'nothing open: go on');
    } finally {
      unbind();
    }

    // A second map binding mod+k without clearOverlay() doesn't close anything on its own.
    const other = bindKeys({ 'mod+k': () => false });
    try {
      openDrawer({ title: 'D', content: 'x', opener: trigger });
      press('k', { metaKey: true });
      assert.ok(doc.querySelector('[data-overlay]'), 'binding mod+k no longer closes overlays by itself');
      closeTopOverlay();
    } finally {
      other();
    }
  });
});

test('dialog, confirm and drawer close when their signal aborts (a view unmounting)', async () => {
  const { doc, win, trigger } = fakeDom();
  await withGlobals({ document: doc, window: win }, async () => {
    const ctl = new AbortController();
    const answer = confirmDialog({ title: 'Delete?', body: 'Sure?', danger: true, opener: trigger, signal: ctl.signal });
    assert.ok(doc.querySelector('[data-overlay]'));
    ctl.abort();
    assert.equal(await answer, false);
    assert.equal(doc.querySelector('[data-overlay]'), null);

    assert.equal(await confirmDialog({ title: 'Again?', body: 'x', signal: ctl.signal }), false, 'already aborted: never opens');
    assert.equal(doc.querySelector('[data-overlay]'), null);

    const reasons = [];
    const ctl2 = new AbortController();
    openDrawer({ title: 'D', content: 'x', signal: ctl2.signal, onClose: (r) => reasons.push(r) });
    openDialog({ title: 'T', content: 'x', signal: ctl2.signal, onClose: (r) => reasons.push(r) });
    ctl2.abort();
    assert.deepEqual(reasons.sort(), ['api', 'api'], 'a code close, not a user one');
    assert.equal(doc.querySelector('[data-overlay]'), null);
  });
});

/** The first element under `root` (depth first) whose class list has `cls`. */
function byClass(root, cls) {
  const walk = (el) => {
    if (String(el.attrs.class || '').split(' ').includes(cls)) return el;
    for (const c of el.children) {
      const hit = c instanceof El && walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

function click(el) {
  el.dispatchEvent(new Event('mousedown'));
  el.dispatchEvent(new Event('click'));
}

test('beforeClose(reason) can keep a dialog or drawer open; actions, signal and force skip it', async () => {
  const { doc, win, trigger } = fakeDom();
  await withGlobals({ document: doc, window: win }, async () => {
    for (const open of [openDialog, openDrawer]) {
      const asked = [];
      const closed = [];
      let allow = false;
      const handle = open({
        title: 'Edit schedule',
        content: 'x',
        actions: [{ label: 'Cancel' }],
        opener: trigger,
        beforeClose: (reason) => {
          asked.push(reason);
          return allow;
        },
        onClose: (reason) => closed.push(reason),
      });
      const backdrop = doc.querySelector('[data-overlay]');
      click(backdrop);
      pressEscape(doc);
      click(byClass(backdrop, 'overlay-close'));
      handle.close();
      assert.equal(closeTopOverlay(), true, 'there was one to ask');
      assert.deepEqual(asked, ['backdrop', 'escape', 'button', 'api', 'escape'], open.name);
      assert.deepEqual(closed, [], 'still open');
      assert.ok(doc.querySelector('[data-overlay]'));

      // A yes closes it, with the reason it was asked about; focus goes back as usual.
      allow = true;
      click(backdrop);
      assert.deepEqual(closed, ['backdrop']);
      assert.equal(doc.querySelector('[data-overlay]'), null);
      assert.equal(doc.activeElement, trigger);

      // force: true skips the question.
      allow = false;
      asked.length = 0;
      const h2 = open({ title: 'T', content: 'x', beforeClose: (r) => { asked.push(r); return false; }, onClose: (r) => closed.push(r) });
      h2.close('api', { force: true });
      assert.deepEqual(asked, []);
      assert.deepEqual(closed.at(-1), 'api');
      assert.equal(doc.querySelector('[data-overlay]'), null);

      // A signal abort always closes (the owner is going away).
      const ctl = new AbortController();
      open({ title: 'T', content: 'x', signal: ctl.signal, beforeClose: (r) => { asked.push(r); return false; }, onClose: (r) => closed.push(r) });
      ctl.abort();
      assert.deepEqual(asked, []);
      assert.equal(closed.at(-1), 'api');
      assert.equal(doc.querySelector('[data-overlay]'), null);
    }

    // A dialog's action buttons close it without asking: their onClick decides.
    const asked = [];
    const closed = [];
    openDialog({
      title: 'T',
      content: 'x',
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: () => true }],
      beforeClose: (r) => { asked.push(r); return false; },
      onClose: (r) => closed.push(r),
    });
    click(byClass(doc.querySelector('[data-overlay]'), 'btn-secondary'));
    assert.deepEqual(asked, []);
    assert.deepEqual(closed, ['action']);
    assert.equal(doc.querySelector('[data-overlay]'), null);
  });
});

test('beforeClose may answer with a Promise; other closes wait; a broken guard never traps', async () => {
  const { doc, win, trigger } = fakeDom();
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a);
  try {
    await withGlobals({ document: doc, window: win }, async () => {
      let answer;
      const asked = [];
      const closed = [];
      openDialog({
        title: 'T',
        content: 'x',
        opener: trigger,
        beforeClose: (r) => {
          asked.push(r);
          return new Promise((resolve) => { answer = resolve; });
        },
        onClose: (r) => closed.push(r),
      });
      pressEscape(doc);
      pressEscape(doc);
      click(doc.querySelector('[data-overlay]'));
      assert.deepEqual(asked, ['escape'], 'asked once while the answer is pending');
      answer(false);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(closed, []);
      assert.ok(doc.querySelector('[data-overlay]'), 'a false answer keeps it open');

      click(doc.querySelector('[data-overlay]'));
      assert.deepEqual(asked, ['escape', 'backdrop'], 'asked again once answered');
      answer(true);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(closed, ['backdrop']);
      assert.equal(doc.querySelector('[data-overlay]'), null);
      assert.equal(doc.activeElement, trigger);

      // A guard that throws, or rejects, only warns: the drawer still closes.
      openDrawer({ title: 'T', content: 'x', beforeClose: () => { throw new Error('guard bug'); }, onClose: (r) => closed.push(r) });
      pressEscape(doc);
      assert.equal(closed.at(-1), 'escape');
      openDrawer({ title: 'T', content: 'x', beforeClose: () => Promise.reject(new Error('guard rejected')), onClose: (r) => closed.push(r) });
      pressEscape(doc);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(closed.slice(-2), ['escape', 'escape']);
      assert.equal(doc.querySelector('[data-overlay]'), null);
      assert.deepEqual(warned.map((w) => w[0].message), ['guard bug', 'guard rejected']);

      // Without beforeClose nothing changes: undefined answers count as yes too.
      openDialog({ title: 'T', content: 'x', beforeClose: () => undefined, onClose: (r) => closed.push(r) });
      pressEscape(doc);
      assert.equal(closed.at(-1), 'escape');
    });
  } finally {
    console.warn = warn;
  }
});

test('openMenu takes a signal that closes it and an onClose(reason) callback', async () => {
  const { doc, win, trigger, other } = fakeDom();
  await withGlobals({ document: doc, window: win }, () => {
    const reasons = [];
    const order = [];
    const ctl = new AbortController();
    openMenu(trigger, [{ label: 'Edit', onSelect: () => order.push('select') }], {
      signal: ctl.signal,
      onClose: (r) => { reasons.push(r); order.push(`close:${r}`); },
    });
    assert.ok(doc.querySelector('[data-overlay]'));
    ctl.abort();
    assert.deepEqual(reasons, ['api']);
    assert.equal(doc.querySelector('[data-overlay]'), null);
    assert.equal(trigger.attrs['aria-expanded'], 'false');
    assert.equal(doc.activeElement, trigger, 'focus back on the anchor');

    // An aborted signal never opens it.
    const none = openMenu(trigger, [{ label: 'Edit' }], { signal: ctl.signal, onClose: (r) => reasons.push(r) });
    assert.equal(doc.querySelector('[data-overlay]'), null);
    none.close();
    assert.deepEqual(reasons, ['api'], 'nothing to close');

    // Every way it closes reports why; picking an item reports before onSelect runs.
    const ctl2 = new AbortController();
    openMenu(trigger, [{ label: 'Edit', onSelect: () => order.push('select') }], { signal: ctl2.signal, onClose: (r) => { reasons.push(r); order.push(`close:${r}`); } });
    click(byClass(doc.querySelector('[data-overlay]'), 'menu-item'));
    assert.deepEqual(order.slice(-2), ['close:select', 'select']);
    ctl2.abort();
    assert.deepEqual(reasons, ['api', 'select'], 'a closed menu ignores its signal');

    const m = openMenu(trigger, [{ label: 'Edit' }], { onClose: (r) => reasons.push(r) });
    pressEscape(doc);
    openMenu(trigger, [{ label: 'Edit' }], { onClose: (r) => reasons.push(r) });
    openMenu(other, [{ label: 'Edit' }], { onClose: (r) => reasons.push(r) }); // another menu: the first goes
    m.close(); // already closed: nothing
    closeTopOverlay();
    assert.deepEqual(reasons, ['api', 'select', 'escape', 'toggle', 'escape']);
    assert.equal(doc.querySelector('[data-overlay]'), null);

    // The two-argument form is unchanged.
    openMenu(trigger, [{ label: 'Edit' }]);
    pressEscape(doc);
    assert.equal(doc.activeElement, trigger);
  });
});

test('copyText: the Clipboard API, else a hidden textarea + execCommand', async () => {
  const { doc, win, other } = fakeDom();
  const written = [];
  let clipboardFails = false;
  const nav = { clipboard: { writeText: async (t) => { if (clipboardFails) throw new Error('denied'); written.push(t); } } };
  const execs = [];
  let execResult = true;
  doc.execCommand = (cmd) => {
    const ta = doc.selection && doc.selection.el;
    let inOverlay = false;
    for (let p = ta && ta.parent; p; p = p.parent) if ('data-overlay' in p.attrs) inOverlay = true;
    execs.push([cmd, ta && ta.value, doc.activeElement === ta, inOverlay]);
    return execResult;
  };
  await withGlobals({ document: doc, window: win, navigator: nav }, async () => {
    assert.equal(await copyText('npm i -g opencode-ai'), true);
    assert.deepEqual(written, ['npm i -g opencode-ai']);

    clipboardFails = true;
    other.focus();
    assert.equal(await copyText('claude login'), true);
    assert.deepEqual(execs, [['copy', 'claude login', true, false]], 'copied from a focused, selected textarea');
    assert.equal(doc.activeElement, other, 'focus goes back');
    assert.equal(doc.body.children.filter((c) => c.tagName === 'TEXTAREA').length, 0, 'the textarea is removed');

    // Inside a dialog the textarea goes in the dialog (the app behind it is inert).
    const dlg = openDialog({ title: 'T', content: 'x', actions: [{ label: 'OK' }] });
    await copyText('codex login');
    assert.deepEqual(execs.at(-1), ['copy', 'codex login', true, true]);
    dlg.close();

    execResult = false;
    assert.equal(await copyText('x'), false, 'says when nothing was copied');
  });
  await withGlobals({ document: doc, window: win, navigator: {} }, async () => {
    execResult = true;
    assert.equal(await copyText('no api'), true, 'no Clipboard API at all');
  });
});

test('setBusy marks a button busy without disabling it, and puts it back', async () => {
  const { doc, win } = fakeDom();
  await withGlobals({ document: doc, window: win }, () => {
    const btn = doc.createElement('button');
    btn.append('Save');
    btn.setAttribute('aria-disabled', 'false');
    assert.equal(isBusy(btn), false);
    setBusy(btn, true);
    assert.equal(isBusy(btn), true);
    assert.equal(btn.attrs['aria-busy'], 'true');
    assert.equal(btn.attrs['aria-disabled'], 'true');
    assert.ok(!('disabled' in btn.attrs), 'never disabled: focus stays on it');
    assert.equal(btn.children[0].attrs.class, 'spinner');
    assert.equal(btn.children[0].attrs['aria-hidden'], 'true');
    assert.equal(btn.textContent, 'Save');
    setBusy(btn, true, { label: 'Saving…' });
    assert.equal(btn.children.filter((c) => c.attrs && c.attrs.class === 'spinner').length, 1, 'one spinner');
    assert.equal(btn.textContent, 'Saving…');
    setBusy(btn, false);
    assert.equal(isBusy(btn), false);
    assert.ok(!('aria-busy' in btn.attrs));
    assert.equal(btn.attrs['aria-disabled'], 'false', 'its own aria-disabled comes back');
    assert.deepEqual(btn.children, [{ text: 'Save' }]);
    setBusy(btn, false); // not busy: nothing to do
    assert.deepEqual(btn.children, [{ text: 'Save' }]);

    const plain = doc.createElement('button');
    plain.append('Test');
    setBusy(plain, true, { label: 'Testing…' });
    setBusy(plain, false);
    assert.ok(!('aria-disabled' in plain.attrs));
    assert.equal(plain.textContent, 'Test');
  });
});

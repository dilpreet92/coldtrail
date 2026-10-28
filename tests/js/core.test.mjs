// Browser-only core modules (dom, api, store, keys, theme) against small fakes of the globals
// they touch. Every test installs its fakes and removes them in `finally`, so the other files
// in this process still see plain Node.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { h, debounce, esc as domEsc } from '../../ui/js/core/dom.js';
import { esc } from '../../ui/js/core/format.js';
import { api, SESSION_EXPIRED, initToken, token, openStream } from '../../ui/js/core/api.js';
import { store } from '../../ui/js/core/store.js';
import { bindKeys, comboOf } from '../../ui/js/core/keys.js';
import { getThemePref, setThemePref, applyTheme } from '../../ui/js/core/theme.js';

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

const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---- dom ----

test('dom re-exports the format helpers', () => {
  assert.equal(domEsc, esc);
});

test('debounce collapses calls, and flush / cancel act on the pending call', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = [];
    const d = debounce((v) => { calls.push(v); return `saved ${v}`; }, 600);
    d(1);
    d(2);
    mock.timers.tick(599);
    assert.deepEqual(calls, []);
    mock.timers.tick(1);
    assert.deepEqual(calls, [2], 'one call with the last arguments');

    d(3);
    assert.equal(d.flush(), 'saved 3', 'flush runs the pending call now and returns its result');
    assert.deepEqual(calls, [2, 3]);
    mock.timers.tick(600);
    assert.deepEqual(calls, [2, 3], 'flushed call does not run again');
    assert.equal(d.flush(), undefined, 'nothing pending: flush is a no-op');

    d(4);
    d.cancel();
    mock.timers.tick(600);
    assert.deepEqual(calls, [2, 3]);
  } finally {
    mock.timers.reset();
  }
});

class El {
  constructor(tag, ns = null) { this.tag = tag; this.ns = ns; this.attrs = {}; this.children = []; this.events = {}; this.style = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.events[t] ||= []).push(f); }
  append(...n) { this.children.push(...n); }
}
class SelectEl extends El {
  get value() { return this._v; }
  set value(v) { this._v = this.children.length ? String(v) : ''; } // like a real <select>: needs options first
}
const fakeDocument = () => ({
  createElement: (t) => (t === 'select' ? new SelectEl(t) : new El(t)),
  createElementNS: (ns, t) => new El(t, ns),
  createTextNode: (s) => ({ text: s }),
});

test('h(): attributes, events, children; strings stay text', async () => {
  await withGlobals({ document: fakeDocument() }, () => {
    const click = () => {};
    const el = h(
      'button',
      {
        class: ['btn', null, 'btn-primary'],
        style: 'width: 10px',
        onClick: click,
        onmouseover: 'alert(1)',
        'aria-pressed': false,
        'aria-hidden': true,
        'data-id': 7,
        disabled: true,
        hidden: false,
        title: null,
      },
      '<img src=x onerror=1>',
      0,
      null,
      false,
      ['a', ['b']],
    );
    assert.equal(el.attrs.class, 'btn btn-primary');
    assert.equal(el.attrs.style, 'width: 10px');
    assert.deepEqual(el.events.click, [click]);
    assert.equal(el.events.mouseover, undefined, 'string handlers are ignored');
    assert.equal(el.attrs.onmouseover, undefined, 'and never become inline handler attributes');
    assert.equal(el.attrs['aria-pressed'], 'false');
    assert.equal(el.attrs['aria-hidden'], 'true');
    assert.equal(el.attrs['data-id'], '7');
    assert.equal(el.attrs.disabled, '');
    assert.ok(!('hidden' in el.attrs));
    assert.ok(!('title' in el.attrs));
    assert.deepEqual(el.children, ['<img src=x onerror=1>', '0', 'a', 'b'], 'strings are appended as text, never parsed');

    const sel = h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B'));
    assert.equal(sel.value, 'b', 'value is applied after the options exist');

    const svg = h('svg', { viewBox: '0 0 24 24' }, h('path', { d: 'M0 0' }));
    assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
    assert.equal(svg.children[0].ns, 'http://www.w3.org/2000/svg');
    assert.equal(svg.attrs.viewBox, '0 0 24 24');
  });
});

// ---- api ----

function fakeFetch(handler) {
  const calls = [];
  const fn = async (path, init = {}) => {
    calls.push({ path, init });
    return handler(path, init);
  };
  fn.calls = calls;
  return fn;
}

test('api.get: JSON on success, raw text or statusText on failure', async () => {
  const fetch = fakeFetch((path) => {
    if (path === '/ok') return Response.json({ a: 1 });
    if (path === '/boom') return new Response('database is locked', { status: 500 });
    return new Response('', { status: 404, statusText: 'Not Found' });
  });
  await withGlobals({ fetch, window: new EventTarget() }, async () => {
    const ctrl = new AbortController();
    assert.deepEqual(await api.get('/ok', { signal: ctrl.signal }), { a: 1 });
    assert.equal(fetch.calls[0].init.credentials, 'same-origin');
    assert.equal(fetch.calls[0].init.signal, ctrl.signal);
    await assert.rejects(api.get('/boom'), (e) => e.message === 'database is locked' && e.status === 500);
    await assert.rejects(api.get('/missing'), (e) => e.message === 'Not Found' && e.status === 404);
  });
});

test('api.post / patch / del: JSON bodies, message-or-text errors, ok:false does not throw', async () => {
  const fetch = fakeFetch((path) => {
    if (path === '/json-err') return Response.json({ message: 'channel must be email or linkedin' }, { status: 400 });
    if (path === '/text-err') return new Response('Failed to deserialize the JSON body', { status: 422 });
    if (path === '/empty') return new Response('', { status: 200 });
    if (path === '/soft') return Response.json({ ok: false, message: 'no pending draft' });
    return Response.json({ ok: true });
  });
  await withGlobals({ fetch, window: new EventTarget() }, async () => {
    assert.deepEqual(await api.post('/x'), { ok: true });
    const post = fetch.calls.at(-1).init;
    assert.equal(post.method, 'POST');
    assert.equal(post.credentials, 'same-origin');
    assert.equal(post.headers['content-type'], 'application/json');
    assert.equal(post.body, '{}', 'an empty object is always sent');

    await api.post('/x', { a: 1 });
    assert.equal(fetch.calls.at(-1).init.body, '{"a":1}');
    await api.patch('/x', { enabled: false });
    assert.equal(fetch.calls.at(-1).init.method, 'PATCH');
    assert.equal(fetch.calls.at(-1).init.body, '{"enabled":false}');

    await api.del('/x');
    const del = fetch.calls.at(-1).init;
    assert.equal(del.method, 'DELETE');
    assert.equal(del.body, undefined, 'DELETE sends no body');
    assert.equal(del.headers, undefined, 'and no content-type');

    await assert.rejects(api.post('/json-err', {}), { message: 'channel must be email or linkedin' });
    await assert.rejects(api.del('/text-err'), { message: 'Failed to deserialize the JSON body' });
    assert.deepEqual(await api.post('/empty'), {});
    assert.deepEqual(await api.post('/soft'), { ok: false, message: 'no pending draft' });
  });
});

test('401 throws SESSION_EXPIRED and fires coldtrail:session-expired once', async () => {
  assert.equal(SESSION_EXPIRED, "This tab's session is stale — reopen coldtrail from the URL your terminal printed.");
  const win = new EventTarget();
  const events = [];
  win.addEventListener('coldtrail:session-expired', (e) => events.push(e));
  const fetch = fakeFetch(() => new Response('unauthorized', { status: 401 }));
  await withGlobals({ fetch, window: win }, async () => {
    await assert.rejects(api.get('/api/summary'), (e) => e.message === SESSION_EXPIRED && e.status === 401);
    await assert.rejects(api.post('/api/chat', { message: 'hi' }), { message: SESSION_EXPIRED });
    await assert.rejects(api.patch('/api/schedules/x', {}), { message: SESSION_EXPIRED });
    await assert.rejects(api.del('/api/drafts/a.com?channel=email'), { message: SESSION_EXPIRED });
    assert.equal(events.length, 1);
    assert.equal(events[0].detail.message, SESSION_EXPIRED);
  });
});

test('api helpers pass keepalive through for saves sent as the page goes away', async () => {
  const fetch = fakeFetch(() => Response.json({ ok: true }));
  await withGlobals({ fetch, window: new EventTarget() }, async () => {
    await api.post('/x', { a: 1 }, { keepalive: true });
    assert.equal(fetch.calls.at(-1).init.keepalive, true);
    await api.patch('/x', {}, { keepalive: true });
    assert.equal(fetch.calls.at(-1).init.keepalive, true);
    await api.del('/x', { keepalive: true });
    assert.equal(fetch.calls.at(-1).init.keepalive, true);
    await api.get('/x', { keepalive: true });
    assert.equal(fetch.calls.at(-1).init.keepalive, true);
    await api.post('/x', {});
    assert.ok(!('keepalive' in fetch.calls.at(-1).init), 'off unless asked for');
  });
});

test('openStream calls onOpen once the stream is connected', async () => {
  const sources = [];
  class FakeEventSource {
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.closed = true; }
  }
  await withGlobals({ document: { cookie: '' }, EventSource: FakeEventSource }, () => {
    let opened = 0;
    const s = openStream('/api/chat/stream?run=r2', { onOpen: () => opened++ });
    sources[0].onopen();
    assert.equal(opened, 1);
    s.close();
    sources[0].onopen();
    assert.equal(opened, 1, 'nothing after close');
    openStream('/api/x'); // onOpen is optional
    sources[1].onopen?.();
  });
});

test('initToken moves ?t= into the cookie and keeps the hash; openStream appends it', async () => {
  const cookies = [];
  const replaced = [];
  const sources = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = 0; sources.push(this); }
    close() { this.closed++; }
  }
  const jar = new Map([['other', '1'], ['ct_token', 'from-cookie']]);
  const doc = {
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(v) {
      cookies.push(v);
      const [pair] = v.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    },
  };
  await withGlobals({ document: doc, EventSource: FakeEventSource, location: { href: 'http://127.0.0.1:7777/?t=tok123&x=1#/pipeline?q=a%20b' }, history: { state: null, replaceState: (_s, _t, url) => replaced.push(url) } }, async () => {
    assert.equal(token(), 'from-cookie', 'before boot the cookie is used');
    initToken();
    assert.deepEqual(cookies, ['ct_token=tok123;path=/;samesite=strict']);
    assert.deepEqual(replaced, ['/?x=1#/pipeline?q=a%20b'], 'only t= is removed; the hash survives');
    assert.equal(token(), 'tok123', 'captured in memory');

    const events = [];
    let errors = 0;
    const s = openStream('/api/chat/stream?run=r1', { onEvent: (e) => events.push(e), onError: () => errors++ });
    const es = sources[0];
    assert.equal(es.url, '/api/chat/stream?run=r1&t=tok123');
    es.onmessage({ data: '{"type":"text","text":"hi"}' });
    es.onmessage({ data: 'not json' });
    es.onmessage({ data: '{"type":"done"}' });
    assert.deepEqual(events, [{ type: 'text', text: 'hi' }, { type: 'done' }]);
    es.onerror();
    assert.equal(errors, 1);
    assert.equal(es.closed, 1, 'an error closes the stream (no auto-reconnect)');
    es.onerror();
    es.onmessage({ data: '{"type":"text","text":"late"}' });
    s.close();
    assert.equal(errors, 1);
    assert.equal(events.length, 2, 'nothing is delivered after close');
    assert.equal(es.closed, 1, 'close is idempotent');

    openStream('/api/x', {});
    assert.equal(sources[1].url, '/api/x?t=tok123');

    // The server restarted and a fresh tab rewrote the shared cookie: streams follow the cookie,
    // like fetch does.
    jar.set('ct_token', 'tok456');
    assert.equal(token(), 'tok456', 'the current cookie wins over the boot token');
    openStream('/api/x', {});
    assert.equal(sources[2].url, '/api/x?t=tok456');
    jar.delete('ct_token');
    assert.equal(token(), 'tok123', 'no cookie: the boot token');
  });

  // No ?t=: nothing is written.
  const cookies2 = [];
  await withGlobals({ document: { get cookie() { return ''; }, set cookie(v) { cookies2.push(v); } }, location: { href: 'http://127.0.0.1:7777/#/home' }, history: { replaceState: () => assert.fail('no rewrite without a token') } }, () => {
    initToken();
    assert.deepEqual(cookies2, []);
  });
});

// ---- store ----

test('store: refresh loads summary + status, coalesces, notifies, never rejects', async () => {
  let n = 0;
  let fail = false;
  const gates = [];
  const fetch = fakeFetch((path) => new Promise((resolve) => {
    gates.push(() => {
      if (fail && path === '/api/summary') return resolve(new Response('nope', { status: 500 }));
      resolve(Response.json(path === '/api/summary' ? { counts: { companies: ++n } } : { onboarded: true }));
    });
  }));
  const open = async () => { while (gates.length) gates.shift()(); await flush(); };
  await withGlobals({ fetch, window: new EventTarget() }, async () => {
    const seen = [];
    const unsub = store.subscribe((s) => seen.push(s.summary.counts.companies));

    const p1 = store.refresh();
    const p2 = store.refresh();
    const p3 = store.refresh();
    assert.deepEqual(fetch.calls.map((c) => c.path).sort(), ['/api/status', '/api/summary']);
    await open(); // first round
    assert.equal(fetch.calls.length, 4, 'calls made during a refresh queue exactly one more round');
    await open(); // queued round
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    assert.equal(a.summary.counts.companies, 1);
    assert.equal(b.summary.counts.companies, 2, 'later callers see data fetched after they asked');
    assert.equal(c.summary.counts.companies, 2);
    assert.deepEqual(store.get(), { summary: { counts: { companies: 2 } }, status: { onboarded: true } });
    assert.deepEqual(seen, [1, 2]);

    fail = true;
    const p4 = store.refresh();
    await open();
    const s4 = await p4;
    assert.equal(s4.summary.counts.companies, 2, 'a failed fetch keeps the last good value');

    unsub();
    fail = false;
    const p5 = store.refresh();
    await open();
    await p5;
    assert.deepEqual(seen, [1, 2, 2], 'no calls after unsubscribe');
  });
});

test('store.start polls every 30s while visible and refreshes on return', async () => {
  const docListeners = {};
  const doc = {
    hidden: false,
    addEventListener: (t, f) => { docListeners[t] = f; },
    removeEventListener: (t) => { delete docListeners[t]; },
  };
  const fetch = fakeFetch((path) => Response.json(path === '/api/summary' ? { counts: {} } : {}));
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withGlobals({ fetch, document: doc, window: new EventTarget() }, async () => {
      store.start();
      store.start(); // idempotent
      await flush();
      assert.equal(fetch.calls.length, 2, 'immediate refresh');
      mock.timers.tick(30_000);
      await flush();
      assert.equal(fetch.calls.length, 4, 'polls after 30s');

      doc.hidden = true;
      docListeners.visibilitychange();
      mock.timers.tick(90_000);
      await flush();
      assert.equal(fetch.calls.length, 4, 'paused while hidden');

      doc.hidden = false;
      docListeners.visibilitychange();
      await flush();
      assert.equal(fetch.calls.length, 6, 'refreshes on return');
      mock.timers.tick(30_000);
      await flush();
      assert.equal(fetch.calls.length, 8, 'and resumes polling');

      store.stop();
      mock.timers.tick(60_000);
      await flush();
      assert.equal(fetch.calls.length, 8);
      assert.equal(docListeners.visibilitychange, undefined);
    });
  } finally {
    mock.timers.reset();
  }
});

// ---- keys ----

test('comboOf normalizes modifiers and key names', () => {
  const ev = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
  assert.equal(comboOf(ev('k', { metaKey: true })), 'mod+k');
  assert.equal(comboOf(ev('K', { ctrlKey: true })), 'mod+k');
  assert.equal(comboOf(ev('Enter', { metaKey: true })), 'mod+enter');
  assert.equal(comboOf(ev('Escape')), 'escape');
  assert.equal(comboOf(ev('Esc')), 'escape');
  assert.equal(comboOf(ev('j')), 'j');
  assert.equal(comboOf(ev('J', { shiftKey: true })), 'shift+j');
});

test('bindKeys: ignored while typing except mod+k / escape / mod+enter', async () => {
  let listener = null;
  let overlay = null;
  const doc = {
    addEventListener: (t, f) => { assert.equal(t, 'keydown'); listener = f; },
    removeEventListener: (t, f) => { if (listener === f) listener = null; },
    querySelector: (sel) => (sel === '[data-overlay]' ? overlay : null),
  };
  const node = (tagName, role = null, editable = false) => ({ tagName, isContentEditable: editable, getAttribute: (k) => (k === 'role' ? role : null) });
  const body = node('BODY');
  const input = node('INPUT');
  const press = (key, target = body, mods = {}) => {
    const e = { key, target, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...mods, preventDefault() { this.defaultPrevented = true; } };
    listener(e);
    return e;
  };
  await withGlobals({ document: doc }, () => {
    const hits = [];
    const unbind = bindKeys({
      j: () => hits.push('j'),
      k: () => hits.push('k'),
      'mod+k': () => hits.push('mod+k'),
      Escape: () => hits.push('escape'),
      enter: () => hits.push('enter'),
      'mod+enter': () => { hits.push('mod+enter'); return false; },
    });
    assert.ok(press('j').defaultPrevented, 'a handled key is consumed');
    press('k');
    press('j', input);
    press('k', node('TEXTAREA'));
    press('j', node('SELECT'));
    press('j', node('DIV', null, true));
    assert.deepEqual(hits, ['j', 'k'], 'plain keys are ignored while typing');

    press('k', input, { metaKey: true });
    press('Escape', input);
    const me = press('Enter', node('TEXTAREA'), { ctrlKey: true });
    assert.deepEqual(hits.slice(2), ['mod+k', 'escape', 'mod+enter']);
    assert.equal(me.defaultPrevented, false, 'a handler returning false leaves the event alone');

    hits.length = 0;
    press('Enter', node('BUTTON'));
    press('Enter', node('A'));
    press('Enter', node('DIV', 'switch'));
    assert.deepEqual(hits, [], 'Enter on a control keeps its native action');
    press('Enter');
    assert.deepEqual(hits, ['enter']);

    hits.length = 0;
    press('J', body, { shiftKey: true });
    press('j', body, { defaultPrevented: true });
    overlay = {};
    press('j');
    press('Escape', input);
    assert.deepEqual(hits, [], 'shifted, already-handled, and behind-an-overlay keys are ignored');
    press('k', input, { metaKey: true });
    overlay = null;
    assert.deepEqual(hits, ['mod+k'], 'mod+k reaches its handler over an overlay (the handler deals with it)');

    unbind();
    assert.equal(listener, null);
  });
});

// ---- theme ----

test('theme: system by default, persists light/dark, survives a broken localStorage', async () => {
  const attrs = {};
  const root = {
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
  };
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  await withGlobals({ localStorage: storage, document: { documentElement: root } }, () => {
    assert.equal(getThemePref(), 'system');
    mem.set('ct-theme', 'bogus');
    assert.equal(getThemePref(), 'system', 'unknown values fall back to system');
    mem.set('ct-theme', 'dark');
    assert.equal(getThemePref(), 'dark', 'legacy light/dark values carry over');
    applyTheme();
    assert.equal(attrs['data-theme'], 'dark');

    setThemePref('light');
    assert.equal(mem.get('ct-theme'), 'light');
    assert.equal(attrs['data-theme'], 'light');
    setThemePref('system');
    assert.ok(!mem.has('ct-theme'), 'system clears the stored value');
    assert.ok(!('data-theme' in attrs), 'system follows the OS via CSS');
  });

  const broken = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  await withGlobals({ localStorage: broken, document: { documentElement: root } }, () => {
    setThemePref('dark');
    assert.equal(attrs['data-theme'], 'dark', 'still applies for this session');
    assert.equal(getThemePref(), 'dark');
  });
});

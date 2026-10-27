// Hash router (ui/js/core/router.js): parse/href round-trips, plus the mount / update / unmount
// lifecycle against a small fake browser (location, history, document, window).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, href, navigate, setQuery, startRouter } from '../../ui/js/core/router.js';

test('parseHash / href round-trip a deep link with an encoded query', () => {
  const r = parseHash('#/pipeline/acme.com?q=a%20b&page=2');
  assert.deepEqual(r, { path: ['pipeline', 'acme.com'], query: { q: 'a b', page: '2' } });
  assert.equal(href(r.path, r.query), '#/pipeline/acme.com?q=a%20b&page=2');
});

test('empty hash is home', () => {
  for (const h of ['', '#', '#/', undefined, null]) {
    assert.deepEqual(parseHash(h), { path: ['home'], query: {} }, JSON.stringify(h));
  }
  assert.deepEqual(parseHash('#/?q=x'), { path: ['home'], query: { q: 'x' } });
});

test('href drops empty query values and accepts a single segment', () => {
  assert.equal(href(['drafts'], { tab: '', q: null, x: undefined }), '#/drafts');
  assert.equal(href(['pipeline'], { stage: 'sent', q: '', page: 2 }), '#/pipeline?stage=sent&page=2');
  assert.equal(href('settings', { tab: 'agent' }), '#/settings?tab=agent');
  assert.equal(href(['agent']), '#/agent');
});

test('path segments and query values are decoded and re-encoded', () => {
  const r = parseHash('#/drafts/a%2Fb.com?q=c%2B%2B&x=%26%3D');
  assert.deepEqual(r, { path: ['drafts', 'a/b.com'], query: { q: 'c++', x: '&=' } });
  assert.equal(href(r.path, r.query), '#/drafts/a%2Fb.com?q=c%2B%2B&x=%26%3D');
  assert.equal(parseHash('#/x?q=a+b').query.q, 'a+b', 'a literal + is not a space');
  assert.deepEqual(parseHash('#/x?flag').query, { flag: '' });
  assert.deepEqual(parseHash('#/bad%E0%A4%A?q=%E0%A4%A').path, ['bad%E0%A4%A'], 'malformed escapes stay raw');
  assert.equal(parseHash('#/bad?q=%E0%A4%A').query.q, '%E0%A4%A');
  assert.deepEqual(parseHash('#pipeline').path, ['pipeline'], 'a missing slash still routes');
});

// ---- lifecycle against a fake browser ----

class FakeEl {
  constructor(tag, env) { this.tag = tag; this.env = env; this.attrs = {}; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener() {}
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
  querySelector(sel) {
    for (const c of this.children) {
      if (typeof c !== 'object') continue;
      if (c.tag === sel) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
  get textContent() { return this.children.map((c) => (typeof c === 'object' ? c.textContent : String(c))).join(''); }
  focus() { this.env.focused = this; }
}

function fakeBrowser(hash = '') {
  const env = { pushes: 0, replaces: 0, listeners: {}, focused: null, links: [] };
  const loc = { hash };
  env.location = loc;
  env.go = (h) => { // what the browser does on back/forward or a typed hash
    loc.hash = h;
    for (const f of env.listeners.hashchange || []) f();
  };
  const saved = {};
  const globals = {
    location: loc,
    history: {
      pushState(_s, _t, url) { env.pushes++; loc.hash = url; },
      replaceState(_s, _t, url) { env.replaces++; loc.hash = url; },
    },
    window: {
      addEventListener(t, f) { (env.listeners[t] ||= []).push(f); },
      removeEventListener(t, f) { env.listeners[t] = (env.listeners[t] || []).filter((x) => x !== f); },
      scrollTo() {},
    },
    document: {
      title: '',
      head: { append: (el) => env.links.push(el) },
      createElement: (tag) => new FakeEl(tag, env),
      createTextNode: (s) => String(s),
    },
  };
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  env.document = globals.document;
  env.restore = () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  };
  env.root = new FakeEl('main', env);
  return env;
}

const seen = { ctx: null }; // the ctx of the latest mount

/** A view module that records its lifecycle into `log`. */
function view(name, log, { css = false, update } = {}) {
  return {
    default: {
      title: name[0].toUpperCase() + name.slice(1),
      css,
      mount(root, ctx) {
        log.push(['mount', name, ctx.path.join('/'), { ...ctx.query }]);
        seen.ctx = ctx;
        const h1 = root.env.document.createElement('h1');
        h1.append(name);
        root.append(h1);
        return () => log.push(['unmount', name]);
      },
      ...(update ? { update: (ctx) => { log.push(['update', name, ctx.path.join('/'), { ...ctx.query }]); return update(ctx); } } : {}),
    },
  };
}

test('router mounts, updates in place, remounts, and falls back to home', async () => {
  const env = fakeBrowser('');
  const log = [];
  const routed = [];
  const store = { get: () => ({}) };
  let releaseSlow;
  const routes = {
    home: async () => view('home', log),
    pipeline: async () => view('pipeline', log, { css: true, update: (ctx) => ctx.path[0] === 'pipeline' }),
    drafts: async () => view('drafts', log, { css: true }),
    slow: () => new Promise((resolve) => { releaseSlow = () => resolve(view('slow', log)); }),
  };
  let router;
  try {
    router = startRouter({ routes, root: env.root, store, onRoute: (r) => routed.push(r.name) });
    await router.ready;
    assert.deepEqual(log, [['mount', 'home', 'home', {}]]);
    assert.equal(env.document.title, 'Home · coldtrail');
    assert.equal(env.focused?.tag, 'h1', 'focuses the view heading');
    assert.equal(env.focused.getAttribute('tabindex'), '-1');
    assert.equal(seen.ctx.store, store, 'ctx carries the store');
    assert.equal(seen.ctx.nav.navigate, navigate);
    assert.equal(seen.ctx.nav.setQuery, setQuery);
    assert.equal(seen.ctx.nav.href, href);

    await navigate('#/pipeline/acme.com?q=a');
    assert.deepEqual(log.slice(1), [['unmount', 'home'], ['mount', 'pipeline', 'pipeline/acme.com', { q: 'a' }]]);
    assert.equal(env.location.hash, '#/pipeline/acme.com?q=a');
    assert.equal(env.pushes, 1);
    assert.equal(env.document.title, 'Pipeline · coldtrail');
    assert.deepEqual(env.links.map((l) => l.attrs.href), ['/assets/css/views/pipeline.css']);
    assert.equal(env.links[0].attrs.rel, 'stylesheet');

    // Same view + update() → true: no remount, query merged, history entry replaced.
    log.length = 0;
    env.focused = null;
    await setQuery({ q: 'b', page: 2 });
    assert.equal(env.location.hash, '#/pipeline/acme.com?q=b&page=2');
    assert.equal(env.replaces, 1);
    assert.deepEqual(log, [['update', 'pipeline', 'pipeline/acme.com', { q: 'b', page: '2' }]]);
    assert.equal(env.focused, null, 'an in-place update keeps focus where it is');
    await setQuery({ q: null });
    assert.equal(env.location.hash, '#/pipeline/acme.com?page=2', 'null removes a key');

    // Navigating to the hash we're on is a no-op.
    log.length = 0;
    await navigate('#/pipeline/acme.com?page=2');
    assert.deepEqual(log, []);
    assert.equal(env.pushes, 1);

    // Back/forward (hashchange) is handled.
    log.length = 0;
    env.go('#/drafts');
    await router.idle();
    assert.deepEqual(log, [['unmount', 'pipeline'], ['mount', 'drafts', 'drafts', {}]]);

    // Each view stylesheet is injected once.
    await navigate(['pipeline']);
    await navigate('#/drafts', { replace: true });
    assert.deepEqual(env.links.map((l) => l.attrs.href), ['/assets/css/views/pipeline.css', '/assets/css/views/drafts.css']);

    // Unknown route → home, and the address bar says so.
    log.length = 0;
    await navigate('#/nope/x?y=1');
    assert.equal(env.location.hash, '#/home');
    assert.deepEqual(log, [['unmount', 'drafts'], ['mount', 'home', 'home', {}]]);

    // A slow view that loses the race never mounts.
    log.length = 0;
    const pending = navigate('#/slow');
    await navigate('#/drafts');
    releaseSlow();
    await pending;
    assert.deepEqual(log, [['unmount', 'home'], ['mount', 'drafts', 'drafts', {}]]);
    assert.equal(env.document.title, 'Drafts · coldtrail');

    assert.deepEqual(routed.slice(0, 2), ['home', 'pipeline']);
    assert.ok(routed.includes('slow'));

    // stop() unmounts and detaches.
    log.length = 0;
    router.stop();
    assert.deepEqual(log, [['unmount', 'drafts']]);
    assert.equal((env.listeners.hashchange || []).length, 0);
    assert.equal((env.listeners.popstate || []).length, 0);
  } finally {
    router?.stop();
    env.restore();
  }
});

test('a view whose mount throws shows an error instead of a blank screen', async () => {
  const env = fakeBrowser('#/broken');
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a);
  let router;
  try {
    router = startRouter({
      routes: {
        home: async () => view('home', []),
        broken: async () => ({ default: { title: 'Broken', mount() { throw new Error('kaboom'); } } }),
      },
      root: env.root,
      store: {},
    });
    await router.ready;
    assert.match(env.root.textContent, /kaboom/);
    assert.equal(errors.length, 1);
  } finally {
    console.error = origError;
    router?.stop();
    env.restore();
  }
});

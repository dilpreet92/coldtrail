// Hash router (ui/js/core/router.js): parse/href round-trips, plus the mount / update / unmount
// lifecycle against a small fake browser (location, history, document, window).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, href, navigate, setQuery, startRouter, ensureViewCss } from '../../ui/js/core/router.js';

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

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
  constructor(tag, env) { this.tag = tag; this.env = env; this.attrs = {}; this.children = []; this.listeners = {}; this.sheet = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  fire(t) {
    if (t === 'load') this.sheet = {};
    for (const f of [...(this.listeners[t] || [])]) f({ type: t });
  }
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
  contains(n) { return n === this || this.children.some((c) => typeof c === 'object' && c.contains(n)); }
  focus() { this.env.focused = this; }
}

/** cssMode: 'load' (a stylesheet loads right after it is added) | 'manual' (the test fires it). */
function fakeBrowser(hash = '', { cssMode = 'load' } = {}) {
  const env = { pushes: 0, replaces: 0, listeners: {}, focused: null, links: [], scrolls: 0 };
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
      scrollTo() { env.scrolls++; },
    },
    document: {
      title: '',
      head: {
        append: (el) => {
          env.links.push(el);
          if (cssMode === 'load') setImmediate(() => el.fire('load'));
        },
      },
      querySelectorAll: (sel) => (sel === 'link[rel="stylesheet"]' ? env.links.filter((l) => l.attrs.rel === 'stylesheet') : []),
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
function view(name, log, { css = false, update, ...extra } = {}) {
  return {
    default: {
      title: name[0].toUpperCase() + name.slice(1),
      css,
      ...extra,
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

test('a view mounts only once its stylesheet has loaded, failed, or 1.5s passed', async () => {
  const env = fakeBrowser('', { cssMode: 'manual' });
  const log = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  let router;
  try {
    router = startRouter({
      routes: {
        home: async () => view('home', log),
        styled: async () => view('styled', log, { css: true }),
        broken: async () => view('broken', log, { css: true }),
        slowcss: async () => view('slowcss', log, { css: true }),
      },
      root: env.root,
      store: {},
    });
    await router.ready;
    log.length = 0;

    const p1 = navigate('#/styled');
    await flush();
    assert.deepEqual(log, [], 'the old screen stays while the stylesheet loads');
    const link = env.links.at(-1);
    assert.equal(link.attrs.href, '/assets/css/views/styled.css');
    link.fire('load');
    await p1;
    assert.deepEqual(log, [['unmount', 'home'], ['mount', 'styled', 'styled', {}]]);

    log.length = 0;
    const p2 = navigate('#/broken');
    await flush();
    assert.deepEqual(log, []);
    env.links.at(-1).fire('error'); // a missing stylesheet doesn't keep the screen out
    await p2;
    assert.deepEqual(log, [['unmount', 'styled'], ['mount', 'broken', 'broken', {}]]);

    log.length = 0;
    const p3 = navigate('#/slowcss');
    await flush();
    mock.timers.tick(1499);
    await flush();
    assert.deepEqual(log, []);
    mock.timers.tick(1);
    await p3;
    assert.deepEqual(log, [['unmount', 'broken'], ['mount', 'slowcss', 'slowcss', {}]], 'capped at 1.5s');

    // A stylesheet that already settled is not waited for again.
    log.length = 0;
    await navigate('#/styled');
    assert.deepEqual(log, [['unmount', 'slowcss'], ['mount', 'styled', 'styled', {}]]);
    assert.equal(env.links.filter((l) => l.attrs.href === '/assets/css/views/styled.css').length, 1);
  } finally {
    router?.stop();
    mock.timers.reset();
    env.restore();
  }
});

test('ensureViewCss adds one link per view and reuses a link a view added itself', async () => {
  const env = fakeBrowser('', { cssMode: 'manual' });
  try {
    const a = ensureViewCss('reused-a');
    assert.equal(ensureViewCss('reused-a'), a, 'one load per view');
    assert.deepEqual(env.links.map((l) => [l.attrs.rel, l.attrs.href]), [['stylesheet', '/assets/css/views/reused-a.css']]);
    let settled = false;
    a.then(() => { settled = true; });
    await flush();
    assert.equal(settled, false);
    env.links[0].fire('load');
    await flush();
    assert.equal(settled, true);

    // A view module reused elsewhere already added (and loaded) its stylesheet.
    const own = env.document.createElement('link');
    own.setAttribute('rel', 'stylesheet');
    own.setAttribute('href', '/assets/css/views/reused-b.css');
    own.sheet = {};
    env.links.push(own);
    await ensureViewCss('reused-b');
    assert.equal(env.links.length, 2, 'no duplicate link');

    // Added but still loading: waits for it.
    const pending = env.document.createElement('link');
    pending.setAttribute('rel', 'stylesheet');
    pending.setAttribute('href', '/assets/css/views/reused-c.css');
    env.links.push(pending);
    let done = false;
    ensureViewCss('reused-c').then(() => { done = true; });
    await flush();
    assert.equal(done, false);
    pending.fire('load');
    await flush();
    assert.equal(done, true);
    assert.equal(env.links.length, 3);
  } finally {
    env.restore();
  }
});

test('navigate({ silent: true }) rewrites the address without re-dispatching the view', async () => {
  const env = fakeBrowser('#/setup');
  const log = [];
  let router;
  try {
    router = startRouter({
      routes: { home: async () => view('home', log), setup: async () => view('setup', log, { update: () => true }) },
      root: env.root,
      store: {},
    });
    await router.ready;
    log.length = 0;
    await navigate('#/setup/agent', { replace: true, silent: true });
    assert.equal(env.location.hash, '#/setup/agent');
    assert.equal(env.replaces, 1);
    assert.deepEqual(log, [], 'neither update() nor mount()');
    // The router knows the new address: going there again is a no-op, a real change is not.
    await navigate('#/setup/agent');
    assert.deepEqual(log, []);
    await setQuery({ x: '1' }, { silent: true });
    assert.equal(env.location.hash, '#/setup/agent?x=1');
    assert.deepEqual(log, []);
    env.go('#/setup/company');
    await router.idle();
    assert.deepEqual(log, [['update', 'setup', 'setup/company', {}]]);
    log.length = 0;
    await navigate('#/setup/done', { silent: true });
    assert.equal(env.pushes, 1, 'pushes unless replace');
    assert.deepEqual(log, []);
  } finally {
    router?.stop();
    env.restore();
  }
});

test('beforeLeave() runs before unmount on a route change, awaited up to 1.5s', async () => {
  const env = fakeBrowser('#/editor');
  const log = [];
  let release;
  let mode = 'wait';
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a);
  mock.timers.enable({ apis: ['setTimeout'] });
  let router;
  try {
    const editor = view('editor', log, {
      update: (ctx) => ctx.query.keep === '1',
      beforeLeave(to) {
        log.push(['beforeLeave', 'editor', to.name, to.path.join('/')]);
        if (mode === 'wait') return new Promise((r) => { release = () => { log.push(['saved']); r(); }; });
        if (mode === 'hang') return new Promise(() => {});
        if (mode === 'reject') return Promise.reject(new Error('save failed'));
        throw new Error('bug');
      },
    });
    router = startRouter({
      routes: { home: async () => view('home', log), editor: async () => editor },
      root: env.root,
      store: {},
    });
    await router.ready;
    log.length = 0;

    // Kept by update(): not leaving, so no beforeLeave.
    await navigate('#/editor?keep=1');
    assert.deepEqual(log, [['update', 'editor', 'editor', { keep: '1' }]]);

    log.length = 0;
    const p = navigate('#/home');
    await flush();
    assert.deepEqual(log, [['beforeLeave', 'editor', 'home', 'home']]);
    release();
    await p;
    assert.deepEqual(log.slice(1), [['saved'], ['unmount', 'editor'], ['mount', 'home', 'home', {}]]);

    // update() saying no (a remount of the same view) is leaving too.
    await navigate('#/editor');
    log.length = 0;
    mode = 'hang';
    const p2 = navigate('#/editor/x');
    await flush();
    assert.deepEqual(log, [['update', 'editor', 'editor/x', {}], ['beforeLeave', 'editor', 'editor', 'editor/x']]);
    mock.timers.tick(1500);
    await p2;
    assert.deepEqual(log.slice(2), [['unmount', 'editor'], ['mount', 'editor', 'editor/x', {}]], 'a hung hook is capped');

    for (const m of ['reject', 'throw']) {
      mode = m;
      log.length = 0;
      await navigate('#/home');
      assert.deepEqual(log.slice(1), [['unmount', 'editor'], ['mount', 'home', 'home', {}]], `${m}: still leaves`);
      await navigate('#/editor');
    }
    assert.equal(warnings.length, 2, 'failures are reported as warnings, not errors');
  } finally {
    console.warn = origWarn;
    router?.stop();
    mock.timers.reset();
    env.restore();
  }
});

test('a view with autofocus: false keeps the heading from taking focus', async () => {
  const env = fakeBrowser('#/composer');
  let router;
  try {
    router = startRouter({
      routes: { home: async () => view('home', []), composer: async () => view('composer', [], { autofocus: false }) },
      root: env.root,
      store: {},
    });
    await router.ready;
    assert.equal(env.focused, null);
    assert.equal(env.scrolls, 1, 'still scrolled to the top');
    await navigate('#/home');
    assert.equal(env.focused?.tag, 'h1');
  } finally {
    router?.stop();
    env.restore();
  }
});

test('a screen that mounts late leaves focus the user moved meanwhile, and otherwise takes it', async () => {
  const env = fakeBrowser('#/home');
  // document.activeElement: what has focus, else <body>.
  const body = new FakeEl('body', env);
  env.document.body = body;
  Object.defineProperty(env.document, 'activeElement', { get: () => env.focused || body, configurable: true });
  const searchBox = new FakeEl('input', env); // the top bar's search: outside the view root
  const navLink = new FakeEl('a', env);
  const gates = [];
  const slow = (mod) => () => new Promise((resolve) => { gates.push(() => resolve(mod)); });
  const broken = { default: { title: 'Agent', mount() { throw new Error('kaboom'); } } };
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a);
  let router;
  const release = async () => { while (gates.length) gates.shift()(); await router.idle(); };
  try {
    router = startRouter({
      routes: {
        home: async () => view('home', []),
        drafts: slow(view('drafts', [])),
        pipeline: slow(view('pipeline', [])),
        company: slow(view('company', [])),
        agent: slow(broken),
      },
      root: env.root,
      store: {},
    });
    await router.ready;

    // ⌘K while Drafts loads: the search keeps focus once Drafts has mounted.
    env.focused = null; // choosing a search result blurred the box
    navigate('#/drafts');
    await flush();
    searchBox.focus();
    const before = env.scrolls;
    await release();
    assert.equal(env.root.textContent, 'drafts', 'Drafts mounted');
    assert.equal(env.focused, searchBox, 'the heading did not take focus from the search');
    assert.equal(env.scrolls, before + 1, 'the new screen still starts at the top');

    // Focus still where the change began (the nav link that was clicked) goes to the heading.
    navLink.focus();
    navigate('#/pipeline');
    await flush();
    await release();
    assert.equal(env.focused?.tag, 'h1');
    assert.equal(env.focused.textContent, 'pipeline');

    // So does focus left on <body> …
    env.focused = null;
    navigate('#/drafts');
    await flush();
    await release();
    assert.equal(env.focused?.textContent, 'drafts');

    // … or on an element the change took away (the old screen's).
    const oldButton = new FakeEl('button', env);
    oldButton.isConnected = false;
    navigate('#/company');
    await flush();
    oldButton.focus();
    await release();
    assert.equal(env.focused?.textContent, 'company');

    // A screen that fails to mount doesn't take focus from the search either.
    navLink.focus();
    navigate('#/agent');
    await flush();
    searchBox.focus();
    await release();
    assert.equal(env.root.textContent, "This screen didn't loadkaboom");
    assert.equal(env.focused, searchBox);
    // Retried from the nav link, untouched meanwhile: its error heading takes focus.
    navLink.focus();
    navigate('#/agent');
    await flush();
    await release();
    assert.equal(env.focused?.tag, 'h1');
    assert.equal(errors.length, 2);
  } finally {
    console.error = origError;
    router?.stop();
    env.restore();
  }
});

test('navigating to the current address after a failed mount mounts it again', async () => {
  const env = fakeBrowser('#/flaky');
  const origError = console.error;
  console.error = () => {};
  let imports = 0;
  let mounts = 0;
  let router;
  try {
    router = startRouter({
      routes: {
        home: async () => view('home', []),
        flaky: async () => {
          imports++;
          return { default: { title: 'Flaky', mount(root) { if (++mounts === 1) throw new Error('mount failed'); root.append('ok'); } } };
        },
      },
      root: env.root,
      store: {},
    });
    await router.ready;
    assert.match(env.root.textContent, /mount failed/);
    await navigate('#/flaky');
    assert.equal(mounts, 2, 'the mount is retried');
    assert.equal(env.root.textContent, 'ok');
    await navigate('#/flaky');
    assert.equal(mounts, 2, 'a screen that loaded is not reloaded');
    assert.equal(imports, 2);
  } finally {
    console.error = origError;
    router?.stop();
    env.restore();
  }
});

test('a screen whose module failed to load says to reload, takes focus, and reloads the page on a retry', async () => {
  const env = fakeBrowser('#/home');
  env.reloads = [];
  env.location.reload = () => { env.reloads.push(env.location.hash); };
  const navLink = new FakeEl('a', env);
  Object.defineProperty(env.document, 'activeElement', { get: () => env.focused, configurable: true });
  const origError = console.error;
  const errors = [];
  console.error = (e) => errors.push(e);
  const log = [];
  const asked = [];
  let router;
  try {
    router = startRouter({
      routes: {
        home: async () => view('home', log),
        drafts: async () => view('drafts', log),
        flaky: async () => {
          asked.push('flaky');
          throw new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1/assets/js/views/flaky.js');
        },
        settings: async () => {
          asked.push('settings');
          return view('settings', log);
        },
      },
      root: env.root,
      store: {},
    });
    await router.ready;
    await navigate('#/drafts');
    await navigate('#/home');
    navLink.focus();
    env.document.title = 'Home · coldtrail';
    await navigate('#/flaky');
    assert.deepEqual(asked, ['flaky']);
    const text = env.root.textContent;
    assert.match(text, /^This screen didn't load/);
    assert.match(text, /Check that coldtrail is still running/);
    assert.doesNotMatch(text, /dynamically imported module/, 'the raw error stays in the console');
    assert.equal(env.document.title, "This screen didn't load · coldtrail", 'the tab title says so too');
    assert.equal(errors.length, 1);
    assert.equal(env.focused?.tag, 'h1', 'its heading takes focus, as after a failed mount');
    const reload = env.root.querySelector('button');
    assert.equal(reload?.textContent, 'Reload');
    reload.listeners.click[0]({ type: 'click' });
    assert.deepEqual(env.reloads, ['#/flaky']);

    // A failed import() stays failed, for every module that imports it too, so the nav link (the
    // same address) loads the page again rather than asking for the module in place.
    await navigate('#/flaky');
    assert.deepEqual(asked, ['flaky'], 'not imported in place again');
    assert.deepEqual(env.reloads, ['#/flaky', '#/flaky']);
    // So does any screen that hasn't loaded on this page (Settings imports Setup, which imports
    // Company profile: a failed Company profile breaks it too)…
    await navigate('#/settings');
    assert.deepEqual(asked, ['flaky']);
    assert.deepEqual(env.reloads, ['#/flaky', '#/flaky', '#/settings']);
    // …while screens that loaded before still open in place.
    await navigate('#/drafts');
    assert.equal(env.root.textContent, 'drafts');
    assert.equal(env.reloads.length, 3);
    assert.equal(env.document.title, 'Drafts · coldtrail');
  } finally {
    console.error = origError;
    router?.stop();
    env.restore();
  }
});

test('a failed mount is retried even when the view has update() (it is remounted, not updated)', async () => {
  const env = fakeBrowser('#/home');
  const origError = console.error;
  console.error = () => {};
  const mounts = { sync: 0, async: 0 };
  const updates = { sync: 0, async: 0 };
  // Like home.js: update() always keeps the DOM. The first mount throws (sync) or rejects (async).
  const flaky = (kind) => async () => ({
    default: {
      title: kind,
      mount(root) {
        const n = ++mounts[kind];
        if (kind === 'sync') {
          if (n === 1) throw new Error('mount failed');
          root.append('ok');
          return undefined;
        }
        return n === 1 ? Promise.reject(new Error('async mount failed')) : (root.append('ok'), Promise.resolve(() => {}));
      },
      update: () => {
        updates[kind]++;
        return true;
      },
    },
  });
  let router;
  try {
    router = startRouter({ routes: { home: flaky('sync'), other: flaky('async') }, root: env.root, store: {} });
    await router.ready;
    assert.match(env.root.textContent, /mount failed/);
    await navigate('#/home');
    assert.equal(mounts.sync, 2, 'the failed screen is mounted again');
    assert.equal(updates.sync, 0, 'not updated in place');
    assert.equal(env.root.textContent, 'ok');
    await navigate('#/home?x=1');
    assert.equal(updates.sync, 1, 'a screen that loaded updates in place again');
    assert.equal(mounts.sync, 2);

    await navigate('#/other');
    await flush();
    assert.match(env.root.textContent, /async mount failed/);
    await navigate('#/other');
    await flush();
    assert.equal(mounts.async, 2, 'a rejected async mount is retried');
    assert.equal(updates.async, 0);
    assert.equal(env.root.textContent, 'ok');
  } finally {
    console.error = origError;
    router?.stop();
    env.restore();
  }
});

test('redirect() can send a route elsewhere before the view loads', async () => {
  const env = fakeBrowser('#/drafts');
  const log = [];
  let needsSetup = true;
  let asyncCheck = null;
  let router;
  try {
    router = startRouter({
      routes: {
        home: async () => view('home', log),
        drafts: async () => view('drafts', log, { update: () => true }),
        setup: async () => view('setup', log),
        loop: async () => view('loop', log),
      },
      root: env.root,
      store: {},
      redirect: ({ name }) => {
        log.push(['redirect', name]);
        if (name === 'loop') return '#/loop?again=1';
        if (name === 'setup' || !needsSetup) return null;
        if (asyncCheck) return asyncCheck.then(() => (needsSetup ? '#/setup' : null));
        return '#/setup';
      },
    });
    await router.ready;
    assert.equal(env.location.hash, '#/setup');
    assert.deepEqual(log, [['redirect', 'drafts'], ['redirect', 'setup'], ['mount', 'setup', 'setup', {}]], 'drafts never loads');

    // An async answer: the current screen stays until it comes, and the target never flashes.
    log.length = 0;
    let answer;
    asyncCheck = new Promise((r) => { answer = r; });
    const p = navigate('#/drafts');
    await flush();
    assert.deepEqual(log, [['redirect', 'drafts']]);
    needsSetup = false;
    answer();
    await p;
    assert.equal(env.location.hash, '#/drafts');
    assert.deepEqual(log.slice(1), [['unmount', 'setup'], ['mount', 'drafts', 'drafts', {}]]);

    // In-place updates with a synchronous answer stay synchronous.
    log.length = 0;
    asyncCheck = null;
    navigate('#/drafts/a.com');
    assert.deepEqual(log, [['redirect', 'drafts'], ['update', 'drafts', 'drafts/a.com', {}]]);
    await router.idle();

    // A redirect that keeps redirecting stops instead of looping.
    log.length = 0;
    await navigate('#/loop');
    assert.equal(env.location.hash, '#/loop?again=1');
    assert.equal(log.filter((l) => l[0] === 'mount').length, 1);
  } finally {
    router?.stop();
    env.restore();
  }
});

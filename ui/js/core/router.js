// Hash router (spec §3): "#/<view>/<id>?<query>" → a view module from js/views/. A view module's
// default export is { title, css?, autofocus?, mount(root, ctx) → unmount | void,
// update?(ctx) → boolean, beforeLeave?(to) → Promise | void };
// ctx = { path, query, store, nav: { navigate, setQuery, href } }. When the route stays on the
// same view and update(ctx) returns true, the view keeps its DOM (drawer, selection, query);
// otherwise the view is leaving: beforeLeave({ name, path, query }) runs first (to flush a pending
// save; awaited up to 1.5s, and a failure never blocks the change), then the old view is
// unmounted (it must stop its pollers/streams) and the new one mounted. A view with css: true
// mounts only once css/views/<name>.css has loaded or failed (or 1.5s passed), so a screen never
// paints unstyled; the old screen stays meanwhile. After mount the view's h1 takes focus, unless
// the view sets autofocus: false to put focus somewhere else itself, or the user has put focus
// somewhere else (⌘K and typing in the search) while the screen was loading.

import { h } from './dom.js';
import { store as sharedStore } from './store.js';

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
};

/** "#/pipeline/acme.com?q=a%20b" → { path: ['pipeline', 'acme.com'], query: { q: 'a b' } }.
 *  Components are percent-decoded ("+" stays "+"); an empty hash is home. */
export function parseHash(hash) {
  let s = hash == null ? '' : String(hash);
  if (s.startsWith('#')) s = s.slice(1);
  if (s.startsWith('/')) s = s.slice(1);
  const qi = s.indexOf('?');
  const path = (qi < 0 ? s : s.slice(0, qi)).split('/').filter(Boolean).map(decode);
  const query = {};
  if (qi >= 0) {
    for (const pair of s.slice(qi + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = decode(eq < 0 ? pair : pair.slice(0, eq));
      if (k && k !== '__proto__') query[k] = eq < 0 ? '' : decode(pair.slice(eq + 1));
    }
  }
  return { path: path.length ? path : ['home'], query };
}

/** Inverse of parseHash. `path` is an array of segments (or an "a/b" string); query values
 *  that are null, undefined or "" are left out. */
export function href(path, query = {}) {
  const segs = (Array.isArray(path) ? path : String(path ?? '').split('/'))
    .filter((p) => p != null && p !== '')
    .map((p) => encodeURIComponent(String(p)));
  const qs = Object.entries(query || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `#/${segs.join('/')}${qs ? `?${qs}` : ''}`;
}

const nav = { navigate, setQuery, href };
// The most a route change waits for a view's stylesheet, or for its beforeLeave().
const WAIT_MS = 1500;
// Redirects in a row the router follows (stops a redirect() that keeps answering another route).
const MAX_REDIRECTS = 5;
const cssLoads = new Map(); // view name → Promise, settled once its stylesheet is usable
let active = null; // the running router

function toHash(to) {
  if (Array.isArray(to)) return href(to);
  if (to && typeof to === 'object') return href(to.path, to.query);
  const s = String(to ?? '');
  if (s.startsWith('#')) return s;
  return `#${s.startsWith('/') ? '' : '/'}${s}`;
}

/**
 * Go to a route ("#/drafts/a.com", "/drafts", ['drafts', 'a.com'] or { path, query }).
 * Pushes a history entry unless `replace`. Resolves once the view has mounted/updated.
 * `silent` only rewrites the address (and the router's idea of it): no update(), no mount, no
 * onRoute. For a view correcting its own address from mount() or update() (a default step, an
 * auto-selected item) without being handed it straight back.
 */
export function navigate(to, { replace = false, silent = false } = {}) {
  const hash = toHash(to);
  if (hash !== location.hash) {
    if (replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
  }
  if (silent) {
    if (active) active.hash = location.hash;
    return Promise.resolve();
  }
  return route();
}

/** Merge `patch` into the current query (null / "" removes a key); replaces the history
 *  entry by default so filters and typing don't flood back/forward. `silent` as for navigate. */
export function setQuery(patch, { replace = true, silent = false } = {}) {
  const { path, query } = parseHash(location.hash);
  const next = { ...query };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null || v === '') delete next[k];
    else next[k] = v;
  }
  return navigate(href(path, next), { replace, silent });
}

function route() {
  const r = active;
  if (!r) return Promise.resolve();
  // popstate and hashchange both fire on back/forward; handle each address once. A screen that
  // failed to load is tried again.
  if (location.hash === r.hash && !r.failed) return r.pending;
  r.pending = handle(r);
  return r.pending;
}

function unmountCurrent(r) {
  const cur = r.current;
  r.current = null;
  if (!cur) return;
  cur.gone = true;
  if (cur.unmount) {
    try {
      cur.unmount();
    } catch (err) {
      console.error(err);
    }
  }
}

function showError(r, err) {
  r.failed = true;
  // A view whose mount failed is mounted again on a retry, never updated in place.
  if (r.current) r.current.failed = true;
  r.root.replaceChildren(
    h('h1', {}, "This screen didn't load"),
    h('p', { class: 'text-2' }, (err && err.message) || String(err)),
  );
}

// The screen's module never arrived (coldtrail was down or restarting): say what to do, not the
// browser's "Failed to fetch dynamically imported module" (that goes to the console).
function showLoadError(r) {
  r.failed = true;
  document.title = "This screen didn't load · coldtrail";
  r.root.replaceChildren(
    h('h1', {}, "This screen didn't load"),
    h('p', { class: 'text-2' }, "Its code couldn't be downloaded. Check that coldtrail is still running, then reload."),
    h('p', {}, h('button', { type: 'button', class: 'btn btn-primary', onClick: () => location.reload() }, 'Reload')),
  );
}

/** Settles when `value` (a Promise or not) settles or after `ms`, whichever comes first; never
 *  rejects (onError sees a rejection). */
function within(value, ms, onError) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve(value).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        onError(err);
        resolve();
      },
    );
  });
}

/**
 * Add css/views/<name>.css to the page once → Promise that resolves when it has loaded or failed,
 * or after 1.5s; never rejects. A matching <link> already in the page is reused. For a view
 * module used outside its own route (Setup's agentPanel inside Settings); the router calls it
 * for every view with css: true.
 */
export function ensureViewCss(name) {
  const key = String(name);
  let loaded = cssLoads.get(key);
  if (loaded) return loaded;
  const url = `/assets/css/views/${key}.css`;
  let link =
    typeof document.querySelectorAll === 'function'
      ? [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.getAttribute('href') === url)
      : null;
  if (link && link.sheet) {
    loaded = Promise.resolve();
  } else {
    const fresh = !link;
    if (fresh) link = h('link', { rel: 'stylesheet', href: url });
    loaded = new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        link.removeEventListener('load', done);
        link.removeEventListener('error', done);
        resolve();
      };
      const timer = setTimeout(done, WAIT_MS);
      link.addEventListener('load', done);
      link.addEventListener('error', done);
    });
    if (fresh) document.head.append(link);
  }
  cssLoads.set(key, loaded);
  return loaded;
}

// The leaving view's beforeLeave(to), capped; its failure is only a warning.
function leave(cur, to) {
  if (!cur || typeof cur.view.beforeLeave !== 'function') return Promise.resolve();
  let res;
  try {
    res = cur.view.beforeLeave(to);
  } catch (err) {
    console.warn(err);
    return Promise.resolve();
  }
  return within(res, WAIT_MS, (err) => console.warn(err));
}

/**
 * Whether the screen just mounted may take focus: only if the user hasn't moved it since the
 * route change began (`from` is what was focused then). Focus still on `from`, on nothing
 * (<body>), on an element the change removed (the old screen's), or inside the new screen
 * counts as not moved; focus anywhere else (the search box, another sidebar link) was put there
 * while the screen loaded, and stays.
 */
function focusUnmoved(from, root) {
  if (typeof document === 'undefined') return true;
  const now = document.activeElement;
  if (!now || now === from || now === document.body || now === document.documentElement) return true;
  if (now.isConnected === false) return true;
  return !!root && typeof root.contains === 'function' && root.contains(now);
}

// Move focus to the new screen's heading so keyboard and screen-reader users land on it.
function focusHeading(root) {
  const h1 = root.querySelector('h1');
  if (h1 && !h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
  try {
    (h1 || root).focus({ preventScroll: true });
  } catch (_) {
    /* not focusable */
  }
  window.scrollTo(0, 0);
}

// `from`: what had focus when this route change began (kept across redirects).
async function handle(r, redirects = 0, from = typeof document === 'undefined' ? null : document.activeElement) {
  r.hash = location.hash;
  r.failed = false;
  const seq = ++r.seq;
  let { path, query } = parseHash(r.hash);
  let name = path[0];
  if (!Object.prototype.hasOwnProperty.call(r.routes, name)) {
    // Unknown route: show Home, and make the address bar say so.
    name = Object.prototype.hasOwnProperty.call(r.routes, 'home') ? 'home' : Object.keys(r.routes)[0];
    path = [name];
    query = {};
    history.replaceState(null, '', href(path));
    r.hash = location.hash;
  }

  // redirect() may send the route elsewhere before anything loads. A synchronous answer keeps an
  // in-place update synchronous (views that rewrite their address from update() rely on it).
  if (r.redirect && redirects < MAX_REDIRECTS) {
    let to = null;
    try {
      to = r.redirect({ name, path, query });
      if (to && typeof to.then === 'function') {
        to = await to;
        if (seq !== r.seq || active !== r) return;
      }
    } catch (err) {
      console.error(err);
      to = null;
    }
    if (to != null && to !== false) {
      const hash = toHash(to);
      if (hash !== location.hash) {
        history.replaceState(null, '', hash);
        return handle(r, redirects + 1, from);
      }
    }
  }

  const ctx = { path, query, store: r.store, nav };
  if (r.onRoute) {
    try {
      r.onRoute({ name, path, query });
    } catch (err) {
      console.error(err);
    }
  }

  const cur = r.current;
  if (cur && !cur.failed && cur.name === name && typeof cur.view.update === 'function') {
    let kept = false;
    try {
      kept = cur.view.update(ctx) === true;
    } catch (err) {
      console.error(err);
    }
    if (kept) return;
  }

  // Leaving: let the current view flush while the next one loads.
  const leaving = leave(cur, { name, path, query });
  if (r.loadFailed && !r.loaded.has(name)) {
    // The browser keeps a failed import() failed for the page's life: for its URL, and for every
    // module that imports it (Settings imports Setup, which imports Company profile). A screen
    // that hasn't loaded on this page yet can't be trusted to load in place, so load the page
    // again at its address, as the Reload button does.
    await leaving;
    if (seq !== r.seq || active !== r) return;
    r.failed = true;
    location.reload();
    return;
  }
  let view;
  try {
    view = (await r.routes[name]()).default;
    r.loaded.add(name);
  } catch (err) {
    r.loadFailed = true;
    await leaving;
    if (seq !== r.seq || active !== r) return;
    console.error(err);
    unmountCurrent(r);
    showLoadError(r);
    if (focusUnmoved(from, r.root)) focusHeading(r.root);
    else window.scrollTo(0, 0);
    return;
  }
  await Promise.all([leaving, view.css ? ensureViewCss(name) : null]);
  if (seq !== r.seq || active !== r) return; // a newer route won the race

  unmountCurrent(r);
  document.title = `${view.title} · coldtrail`;
  r.root.replaceChildren();
  const entry = { name, view, unmount: null, gone: false, failed: false };
  r.current = entry;
  try {
    const res = view.mount(r.root, ctx);
    if (typeof res === 'function') {
      entry.unmount = res;
    } else if (res && typeof res.then === 'function') {
      // Tolerate an async mount: run its unmount as soon as it arrives if we already left.
      res.then(
        (fn) => {
          if (typeof fn !== 'function') return;
          if (entry.gone) fn();
          else entry.unmount = fn;
        },
        (err) => {
          console.error(err);
          if (r.current === entry) showError(r, err);
        },
      );
    }
  } catch (err) {
    console.error(err);
    showError(r, err);
  }
  // A view that places focus itself still gets its error heading focused if it failed. Focus the
  // user moved while the screen loaded stays where they put it; the new screen still starts at
  // the top.
  if ((view.autofocus === false && !r.failed) || !focusUnmoved(from, r.root)) window.scrollTo(0, 0);
  else focusHeading(r.root);
}

/**
 * Start routing. routes[name]() → import('../views/<name>.js'); unknown routes show `home`.
 * A screen that failed to mount is mounted again when the current address is navigated to again
 * (its nav link). Once a screen's code failed to download, any screen that hasn't loaded on this
 * page yet (the failed one included) is opened by reloading the page at its address: the browser
 * keeps a failed import() failed, for every module that imports it too.
 * redirect({ name, path, query }) → a route (anything navigate takes) | null, or a Promise of
 * one, runs first on every route change: a route replaces the address and is routed instead, and
 * the screen on show stays until the answer comes, so the original target never flashes.
 * onRoute({ name, path, query }) runs on every route change, before the view loads.
 * Returns { ready, idle(), stop() }: `ready` settles after the first view mounts, idle() after
 * the latest route change, stop() unmounts and detaches.
 */
export function startRouter({ routes, root, onRoute, redirect, store = sharedStore }) {
  if (active) active.stop();
  const r = { routes, root, onRoute, redirect, store, hash: null, seq: 0, failed: false, current: null, loaded: new Set(), loadFailed: false, pending: Promise.resolve() };
  const onChange = () => {
    route();
  };
  r.stop = () => {
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
    if (active === r) active = null;
    r.seq++;
    unmountCurrent(r);
  };
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  active = r;
  const ready = route();
  return { ready, idle: () => r.pending, stop: r.stop };
}

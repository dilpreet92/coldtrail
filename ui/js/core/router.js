// Hash router (spec §3): "#/<view>/<id>?<query>" → a view module from js/views/. A view module's
// default export is { title, css?, mount(root, ctx) → unmount | void, update?(ctx) → boolean };
// ctx = { path, query, store, nav: { navigate, setQuery, href } }. When the route stays on the
// same view and update(ctx) returns true, the view keeps its DOM (drawer, selection, query);
// otherwise the old view is unmounted (it must stop its pollers/streams) and the new one mounted.

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
const cssLoaded = new Set();
let active = null; // the running router

function toHash(to) {
  if (Array.isArray(to)) return href(to);
  if (to && typeof to === 'object') return href(to.path, to.query);
  const s = String(to ?? '');
  if (s.startsWith('#')) return s;
  return `#${s.startsWith('/') ? '' : '/'}${s}`;
}

/** Go to a route ("#/drafts/a.com", "/drafts", ['drafts', 'a.com'] or { path, query }).
 *  Pushes a history entry unless `replace`. Resolves once the view has mounted/updated. */
export function navigate(to, { replace = false } = {}) {
  const hash = toHash(to);
  if (hash !== location.hash) {
    if (replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
  }
  return route();
}

/** Merge `patch` into the current query (null / "" removes a key); replaces the history
 *  entry by default so filters and typing don't flood back/forward. */
export function setQuery(patch, { replace = true } = {}) {
  const { path, query } = parseHash(location.hash);
  const next = { ...query };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null || v === '') delete next[k];
    else next[k] = v;
  }
  return navigate(href(path, next), { replace });
}

function route() {
  const r = active;
  if (!r) return Promise.resolve();
  // popstate and hashchange both fire on back/forward; handle each address once.
  if (location.hash === r.hash) return r.pending;
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

function showError(root, err) {
  root.replaceChildren(
    h('h1', {}, "This screen didn't load"),
    h('p', { class: 'text-2' }, (err && err.message) || String(err)),
  );
}

function ensureCss(name) {
  if (cssLoaded.has(name)) return;
  cssLoaded.add(name);
  document.head.append(h('link', { rel: 'stylesheet', href: `/assets/css/views/${name}.css` }));
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

async function handle(r) {
  r.hash = location.hash;
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
  const ctx = { path, query, store: r.store, nav };
  if (r.onRoute) {
    try {
      r.onRoute({ name, path, query });
    } catch (err) {
      console.error(err);
    }
  }

  const cur = r.current;
  if (cur && cur.name === name && typeof cur.view.update === 'function') {
    let kept = false;
    try {
      kept = cur.view.update(ctx) === true;
    } catch (err) {
      console.error(err);
    }
    if (kept) return;
  }

  let view;
  try {
    view = (await r.routes[name]()).default;
  } catch (err) {
    if (seq !== r.seq || active !== r) return;
    console.error(err);
    unmountCurrent(r);
    showError(r.root, err);
    return;
  }
  if (seq !== r.seq || active !== r) return; // a newer route won the race

  unmountCurrent(r);
  if (view.css) ensureCss(name);
  document.title = `${view.title} · coldtrail`;
  r.root.replaceChildren();
  const entry = { name, view, unmount: null, gone: false };
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
          if (r.current === entry) showError(r.root, err);
        },
      );
    }
  } catch (err) {
    console.error(err);
    showError(r.root, err);
  }
  focusHeading(r.root);
}

/**
 * Start routing. routes[name] = () => import('../views/<name>.js'); unknown routes show `home`.
 * onRoute({ name, path, query }) runs on every route change, before the view loads.
 * Returns { ready, idle(), stop() }: `ready` settles after the first view mounts, idle() after
 * the latest route change, stop() unmounts and detaches.
 */
export function startRouter({ routes, root, onRoute, store = sharedStore }) {
  if (active) active.stop();
  const r = { routes, root, onRoute, store, hash: null, seq: 0, current: null, pending: Promise.resolve() };
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

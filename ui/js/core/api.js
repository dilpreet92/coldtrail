// fetch wrapper for /api (same error semantics as the legacy getJSON/postJSON helpers) plus the
// session token bootstrap and an SSE helper. Browser globals are only touched inside functions.

// A 401 means the loopback token didn't match — usually a browser tab left open from an older
// run. Give an actionable message instead of the raw "unauthorized".
export const SESSION_EXPIRED = "This tab's session is stale — reopen coldtrail from the URL your terminal printed.";

let bootToken = '';
let expiredAnnounced = false;

/**
 * Move a first-load `?t=<token>` into the `ct_token` cookie (exactly as before: raw value,
 * path=/, samesite=strict, session cookie) and keep it in memory, then drop `t` from the address
 * bar. Unlike the old UI this keeps `location.hash`, so a deep link survives the first load.
 */
export function initToken() {
  const u = new URL(location.href);
  const t = u.searchParams.get('t');
  if (!t) return;
  bootToken = t;
  document.cookie = `ct_token=${t};path=/;samesite=strict`;
  u.searchParams.delete('t');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
}

/** The session token: captured at boot, else the cookie, else "". */
export function token() {
  if (bootToken) return bootToken;
  const m = document.cookie.match(/(?:^|;\s*)ct_token=([^;]+)/);
  return m ? m[1] : '';
}

function sessionExpired() {
  if (expiredAnnounced) return;
  expiredAnnounced = true;
  window.dispatchEvent(new CustomEvent('coldtrail:session-expired', { detail: { message: SESSION_EXPIRED } }));
}

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function getJSON(path, { signal } = {}) {
  const r = await fetch(path, { credentials: 'same-origin', signal });
  if (r.status === 401) {
    sessionExpired();
    throw fail(SESSION_EXPIRED, 401);
  }
  if (!r.ok) throw fail((await r.text()) || r.statusText, r.status);
  return r.json();
}

// Error responses are plain text (ApiErr → 500, axum rejections → 4xx), so read the body once
// and surface `message` from JSON, else the raw text, else the status text. A 200 with
// {ok:false,message} is returned as-is: callers check `ok` themselves.
async function send(method, path, body, { signal } = {}) {
  const init = { method, credentials: 'same-origin', signal };
  if (method !== 'DELETE') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body || {});
  }
  const r = await fetch(path, init);
  if (r.status === 401) {
    sessionExpired();
    throw fail(SESSION_EXPIRED, 401);
  }
  const raw = await r.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = {};
  }
  if (!r.ok) throw fail((data && data.message) || raw || r.statusText, r.status);
  return data;
}

/**
 * get(path, {signal}) → parsed JSON. post(path, body, {signal}), patch(path, body) send JSON
 * (an empty object when body is missing); del(path) sends no body. All throw Error(message)
 * with `.status` on failure, and SESSION_EXPIRED on 401 (after firing the window event
 * `coldtrail:session-expired` once per page).
 */
export const api = {
  get: getJSON,
  post: (path, body, opts) => send('POST', path, body, opts),
  patch: (path, body, opts) => send('PATCH', path, body, opts),
  del: (path, opts) => send('DELETE', path, undefined, opts),
};

/**
 * Open an EventSource on `path` (with `t=<token>` appended) and hand each JSON `message` event
 * to onEvent. Any error closes it for good (no auto-reconnect into a finished run) and calls
 * onError once. close() is idempotent; nothing is delivered after it.
 */
export function openStream(path, { onEvent, onError } = {}) {
  const t = token();
  const url = t ? `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}` : path;
  const es = new EventSource(url);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };
  es.onmessage = (m) => {
    if (closed) return;
    let ev;
    try {
      ev = JSON.parse(m.data);
    } catch (_) {
      return;
    }
    if (onEvent) onEvent(ev);
  };
  es.onerror = () => {
    if (closed) return;
    close();
    if (onError) onError();
  };
  return { close };
}

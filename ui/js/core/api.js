// fetch wrapper for /api (same error semantics as the legacy getJSON/postJSON helpers) plus the
// session token bootstrap and an SSE helper. Browser globals are only touched inside functions.

// A 401 means the loopback token didn't match — usually a browser tab left open from an older
// run. Give an actionable message instead of the raw "unauthorized".
export const SESSION_EXPIRED = "This tab's session is stale — reopen coldtrail from the URL your terminal printed.";

/** The short pointer a screen shows where a request failed on a stale session. The shell's
 *  banner already says SESSION_EXPIRED in full, once, so screens don't repeat the sentence. */
export const SESSION_REOPEN = 'Reopen coldtrail from your terminal.';

/** True when `err` came from a stale session: a 401 from api.get/post/patch/del, or any error
 *  carrying the SESSION_EXPIRED message. */
export const isStaleSession = (err) => !!err && (err.status === 401 || err.message === SESSION_EXPIRED);

// The request never got an answer: coldtrail stopped (its terminal was closed) or is restarting.
// The browser's own words for that ("Failed to fetch", "Load failed", "NetworkError when…") say
// nothing to the user, so api.js throws this instead.
export const OFFLINE = "coldtrail isn't responding. Check that it's still running in your terminal.";

/** The short pointer a screen shows where a request got no answer. The shell's banner says OFFLINE
 *  in full while it lasts, so screens don't repeat the sentence. */
export const OFFLINE_SHORT = "coldtrail isn't responding.";

/** True when `err` is api.js's error for a request that got no answer (see OFFLINE). */
export const isOffline = (err) => !!err && err.offline === true;

/**
 * The text to show for a failed request: SESSION_REOPEN ('Reopen coldtrail from your terminal.')
 * for a stale session (see isStaleSession), OFFLINE_SHORT for a request that got no answer (see
 * isOffline), else err.message, else String(err) ('' for null or undefined).
 */
export function errorText(err) {
  if (isStaleSession(err)) return SESSION_REOPEN;
  if (isOffline(err)) return OFFLINE_SHORT;
  return (err && err.message) || (err == null ? '' : String(err));
}

let bootToken = '';
// What the latest answer (or its absence) said is wrong with this tab: 'expired' (a 401),
// 'offline' (no answer) or null. Each change is announced once on window, so the shell's banner
// comes and goes with it.
let trouble = null;
let staleToken = null; // the token the 401 behind 'expired' refused

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

/**
 * The session token: the ct_token cookie (shared by every tab, and rewritten when coldtrail is
 * reopened after a server restart, so streams use the credential fetch() sends), else the one
 * captured at boot, else "".
 */
export function token() {
  const cookie = typeof document === 'undefined' ? '' : document.cookie;
  const m = String(cookie || '').match(/(?:^|;\s*)ct_token=([^;]+)/);
  return m ? m[1] : bootToken;
}

const TROUBLE_EVENTS = {
  expired: ['coldtrail:session-expired', SESSION_EXPIRED],
  offline: ['coldtrail:offline', OFFLINE],
};

// `kind`: 'expired' | 'offline' | null (an answer that wasn't a 401: the tab works again).
function setTrouble(kind) {
  if (kind === trouble) return;
  trouble = kind;
  const [type, message] = kind ? TROUBLE_EVENTS[kind] : ['coldtrail:reconnected', null];
  window.dispatchEvent(new CustomEvent(type, { detail: { message } }));
}

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// fetch(), with a request that got no answer turned into OFFLINE. An abort is passed on as is.
async function request(path, init) {
  const sent = token(); // what the cookie carries with this request
  let r;
  try {
    r = await fetch(path, init);
  } catch (err) {
    if ((init.signal && init.signal.aborted) || !(err instanceof TypeError)) throw err;
    setTrouble('offline');
    const e = new Error(OFFLINE, { cause: err });
    e.offline = true;
    throw e;
  }
  if (r.status === 401) {
    // A 401 to a token the tab has since replaced (coldtrail reopened meanwhile) says nothing now.
    if (sent === token()) {
      staleToken = sent;
      setTrouble('expired');
    }
    throw fail(SESSION_EXPIRED, 401);
  }
  // An answer: coldtrail is up. A stale session is over only once another token gets one (coldtrail
  // reopened from the terminal rewrote the shared cookie), not because some other request passed.
  if (trouble === 'offline' || (trouble === 'expired' && sent !== staleToken)) setTrouble(null);
  return r;
}

async function getJSON(path, { signal, keepalive } = {}) {
  const init = { credentials: 'same-origin', signal };
  if (keepalive) init.keepalive = true;
  const r = await request(path, init);
  if (!r.ok) throw fail((await r.text()) || r.statusText, r.status);
  return r.json();
}

// Error responses are plain text (ApiErr → 500, axum rejections → 4xx), so read the body once
// and surface `message` from JSON, else the raw text, else the status text. A 200 with
// {ok:false,message} is returned as-is: callers check `ok` themselves.
async function send(method, path, body, { signal, keepalive } = {}) {
  const init = { method, credentials: 'same-origin', signal };
  if (keepalive) init.keepalive = true;
  if (method !== 'DELETE') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body || {});
  }
  const r = await request(path, init);
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
 * get(path, opts) → parsed JSON. post(path, body, opts), patch(path, body, opts) send JSON (an
 * empty object when body is missing); del(path, opts) sends no body. opts: { signal, keepalive }
 * (keepalive: the request outlives the page, for a save sent as the tab closes; browsers cap
 * keepalive bodies at 64 KiB in total). All throw Error(message) with `.status` on failure,
 * SESSION_EXPIRED on 401, and OFFLINE (with `.offline` true, no `.status`) when no answer came; an
 * aborted request rejects with the abort as before. Window events say when that changes, once
 * each time: `coldtrail:session-expired` at the first 401, `coldtrail:offline` at the first request
 * without an answer (both with detail.message), and `coldtrail:reconnected` when that is over:
 * at the first answer after no answer (coldtrail is back), or at the first answer that isn't a 401
 * to a token other than the one refused (coldtrail was reopened from the terminal, which rewrites
 * the shared cookie).
 */
export const api = {
  get: getJSON,
  post: (path, body, opts) => send('POST', path, body, opts),
  patch: (path, body, opts) => send('PATCH', path, body, opts),
  del: (path, opts) => send('DELETE', path, undefined, opts),
};

/**
 * Open an EventSource on `path` (with `t=<token>` appended) and hand each JSON `message` event
 * to onEvent. onOpen runs once it is connected (the server has the stream). Any error closes it
 * for good (no auto-reconnect into a finished run) and calls onError once. close() is
 * idempotent; nothing is delivered after it.
 */
export function openStream(path, { onEvent, onError, onOpen } = {}) {
  const t = token();
  const url = t ? `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}` : path;
  const es = new EventSource(url);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };
  es.onopen = () => {
    if (closed || !onOpen) return;
    onOpen();
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

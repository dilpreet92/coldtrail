// Shared live state for the shell and views (spec §4): /api/summary + /api/status, refreshed
// every 30s while the tab is visible and after any mutating action (call store.refresh()).

import { api } from './api.js';

const INTERVAL_MS = 30_000;

const state = { summary: null, status: null };
const subscribers = new Set();
// Date.now() when the summary / status on hand arrived (0: never).
const landedAt = { summary: 0, status: 0 };
let inflight = null;
let queued = null;
let timer = null;
let started = false;
let loadedOnce = false; // a load has finished (well or not)

const snapshot = () => ({ summary: state.summary, status: state.status });

async function load() {
  const [summary, status] = await Promise.allSettled([api.get('/api/summary'), api.get('/api/status')]);
  // A failed fetch keeps the last good value; a stale session is reported by api.js.
  const now = Date.now();
  if (summary.status === 'fulfilled') {
    state.summary = summary.value;
    landedAt.summary = now;
  }
  if (status.status === 'fulfilled') {
    state.status = status.value;
    landedAt.status = now;
  }
  loadedOnce = true;
  const snap = snapshot();
  if (summary.status === 'fulfilled' || status.status === 'fulfilled') {
    for (const fn of [...subscribers]) {
      try {
        fn(snap);
      } catch (err) {
        console.error(err);
      }
    }
  }
  return snap;
}

/** Fetch both now. Calls made while a fetch is running share one follow-up fetch, so a
 *  refresh after a mutation always sees data requested after it. Never rejects. */
function refresh() {
  if (inflight) {
    if (!queued) {
      queued = inflight.then(() => {
        queued = null;
        return refresh();
      });
    }
    return queued;
  }
  inflight = load().finally(() => {
    inflight = null;
  });
  return inflight;
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

function startTimer() {
  stopTimer();
  timer = setInterval(() => {
    if (!document.hidden) refresh();
  }, INTERVAL_MS);
}

function onVisibility() {
  if (document.hidden) {
    stopTimer();
  } else {
    refresh();
    startTimer();
  }
}

export const store = {
  /** Current { summary, status } (null until the first fetch lands). */
  get: snapshot,
  /** fn(snapshot) after every successful refresh; returns unsubscribe. Not called immediately. */
  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
  refresh,
  /**
   * When the summary on hand arrived, as a Date.now() timestamp; 0 until one has. `which` =
   * 'status' asks the same of the status. A failed refresh keeps the old value and its time, so
   * `Date.now() - store.fetchedAt()` is the age of what store.get() returns.
   */
  fetchedAt(which = 'summary') {
    return which === 'status' ? landedAt.status : landedAt.summary;
  },
  /**
   * → Promise<snapshot> that settles once the first load has finished, whether or not it worked
   * (check snapshot.summary). Already settled after that; starts a fetch when none has run yet.
   * Never rejects.
   */
  ready() {
    if (loadedOnce) return Promise.resolve(snapshot());
    return inflight || refresh();
  },
  /** Fetch now, then every 30s; paused while the tab is hidden, refreshed when it returns. */
  start() {
    if (started) return;
    started = true;
    document.addEventListener('visibilitychange', onVisibility);
    refresh();
    if (!document.hidden) startTimer();
  },
  stop() {
    started = false;
    stopTimer();
    document.removeEventListener('visibilitychange', onVisibility);
  },
};

/**
 * store.subscriberCount() → how many subscribers are attached now. For tests that check a screen
 * unsubscribes when it unmounts; non-enumerable, so it stays out of the store's listed API.
 */
Object.defineProperty(store, 'subscriberCount', { value: () => subscribers.size });

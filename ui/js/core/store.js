// Shared live state for the shell and views (spec §4): /api/summary + /api/status, refreshed
// every 30s while the tab is visible and after any mutating action (call store.refresh()).

import { api } from './api.js';

const INTERVAL_MS = 30_000;

const state = { summary: null, status: null };
const subscribers = new Set();
let inflight = null;
let queued = null;
let timer = null;
let started = false;

const snapshot = () => ({ summary: state.summary, status: state.status });

async function load() {
  const [summary, status] = await Promise.allSettled([api.get('/api/summary'), api.get('/api/status')]);
  // A failed fetch keeps the last good value; a stale session is reported by api.js.
  if (summary.status === 'fulfilled') state.summary = summary.value;
  if (status.status === 'fulfilled') state.status = status.value;
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

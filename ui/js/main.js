// Boot (spec §6): session token, theme, the shell and the shared store, then the router.
// A workspace that isn't set up goes to #/setup: checked against the first status before any
// screen mounts, and again on every later route change outside setup (against fresh status, so a
// setup that just finished isn't sent back). Background refreshes never move the user.

import { initToken } from './core/api.js';
import { navigate, parseHash, startRouter } from './core/router.js';
import { store } from './core/store.js';
import { applyTheme } from './core/theme.js';
import { mountShell } from './shell.js';

const ROUTES = {
  setup: () => import('./views/setup.js'),
  home: () => import('./views/home.js'),
  pipeline: () => import('./views/pipeline.js'),
  drafts: () => import('./views/drafts.js'),
  followups: () => import('./views/followups.js'),
  agent: () => import('./views/agent.js'),
  schedules: () => import('./views/schedules.js'),
  company: () => import('./views/company.js'),
  settings: () => import('./views/settings.js'),
};

// How long the first screen waits for /api/status when the server neither answers nor refuses.
const FIRST_LOAD_MS = 3000;

initToken();
applyTheme();
const shell = mountShell({ store, navigate });

const firstLoad = new Promise((resolve) => {
  const off = store.subscribe(() => {
    off();
    resolve();
  });
  window.addEventListener('coldtrail:session-expired', resolve, { once: true });
  setTimeout(resolve, FIRST_LOAD_MS);
});
store.start();
await firstLoad;

const needsSetup = () => {
  const { status } = store.get();
  return !!status && status.onboarded === false;
};
const routeName = () => parseHash(location.hash).path[0];

if (needsSetup() && routeName() !== 'setup') history.replaceState(null, '', '#/setup');

startRouter({
  routes: ROUTES,
  root: document.getElementById('view'),
  onRoute: ({ name }) => {
    shell.setRoute(name);
    if (name === 'setup' || !needsSetup()) return;
    store.refresh().then(() => {
      if (needsSetup() && routeName() === name) navigate('#/setup', { replace: true });
    });
  },
});

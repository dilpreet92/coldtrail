// Boot (spec §6): session token, theme, the shell and the shared store, then the router.
//
// Setup is for a workspace that was never set up: one with no company profile (status.product_set
// false: product.md missing or empty) and no companies (summary.counts.companies 0). Both only
// change by using coldtrail, so a workspace that ever got going keeps them. status.onboarded alone
// is not the rule: it is also false once a working setup loses something it can reconnect (a
// Canonical token that lapsed, an agent CLI uninstalled or signed out), and sending that user to
// #/setup on every screen would lock them out of Drafts, Follow-ups and Settings. Those problems
// show in the shell's connection dots and Home's needs-you list instead.
// The check runs before any screen mounts, so the screen asked for never flashes: at boot against
// the first status, then on every route change outside setup through the router's redirect().
// A cached "not set up" is re-checked against fresh status first, so a setup that just finished
// isn't sent back. Background refreshes never move the user.

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
  window.addEventListener('coldtrail:offline', resolve, { once: true });
  setTimeout(resolve, FIRST_LOAD_MS);
});
store.start();
await firstLoad;

const needsSetup = () => {
  const { status, summary } = store.get();
  if (!status || status.onboarded !== false || status.product_set) return false;
  const companies = summary && summary.counts ? Number(summary.counts.companies) || 0 : 0;
  return companies === 0;
};

if (needsSetup() && parseHash(location.hash).path[0] !== 'setup') history.replaceState(null, '', '#/setup');

startRouter({
  routes: ROUTES,
  root: document.getElementById('view'),
  // Synchronous unless the cached status says "not set up", so in-place updates stay in place.
  redirect: ({ name }) => {
    if (name === 'setup' || !needsSetup()) return null;
    return store.refresh().then(() => (needsSetup() ? '#/setup' : null));
  },
  onRoute: ({ name }) => shell.setRoute(name),
});

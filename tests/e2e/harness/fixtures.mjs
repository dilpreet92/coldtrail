// Playwright fixtures for the e2e suite.
//
//   import { test, expect } from '../harness/fixtures.mjs';
//   test.use({ seed: 'empty' });                       // optional: 'full' (default) | 'empty' | 'onboarded'
//   test('…', async ({ app, server }) => { await app.goto('#/pipeline'); … });
//
// `server` is one isolated `coldtrail serve` (harness/server.mjs) shared by the tests of a spec
// file: the first test of a file (or the first after a `seed` change) starts a fresh server, so
// every spec file begins from a pristine workspace no matter what earlier files changed. Tests in
// one file run in order and see each other's changes. Because it can be restarted per file it is
// a test-scoped fixture: use it in tests and `beforeEach`, not `beforeAll`.
//
// `app` opens the app for one test with the side-effect intercepts installed, and fails the test
// on any console.error or uncaught page error (allow-list one with `app.allowConsole(/regex/)`).
import { test as base, expect } from '@playwright/test';

import { interceptSideEffects } from './intercept.mjs';
import { startServer } from './server.mjs';

export const test = base.extend({
  seed: ['full', { option: true }],

  // Worker-lifetime holder for the current spec file's server; stops it when the worker ends.
  _servers: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const holder = { key: null, server: null };
      await use(holder);
      await holder.server?.stop();
    },
    { scope: 'worker', timeout: 30_000 },
  ],

  server: async ({ seed, _servers }, use, testInfo) => {
    const key = `${testInfo.file}\n${seed}`;
    if (_servers.key !== key) {
      const previous = _servers.server;
      _servers.key = null;
      _servers.server = null;
      await previous?.stop();
      _servers.server = await startServer({ seed });
      _servers.key = key;
    }
    await use(_servers.server);
  },

  app: async ({ page, server }, use) => {
    const { calls } = await interceptSideEffects(page);
    const allowed = [];
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.stack || err.message || err}`));

    await use({
      page,
      server,
      calls,
      /** Open the app at a route, e.g. `goto('#/drafts')`; '' opens the default route. */
      goto: (hash = '') => page.goto(server.url(hash)),
      /** Let console errors / page errors matching `re` through for this test. */
      allowConsole: (re) => {
        allowed.push(re);
      },
    });

    const unexpected = problems.filter((p) => !allowed.some((re) => re.test(p)));
    expect(unexpected, 'console errors or uncaught page errors during the test').toEqual([]);
  },
});

export { expect };

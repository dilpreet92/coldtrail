// @ts-check
import { defineConfig, devices } from '@playwright/test';

// One worker, no retries: every spec drives a real `coldtrail serve` (started by
// harness/server.mjs in a throwaway COLDTRAIL_HOME), so tests run one at a time and a failure is
// never papered over by a rerun. Build the binary first: `cargo build` at the repo root.
export default defineConfig({
  testDir: 'specs',
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});

// @ts-check
const { defineConfig } = require("@playwright/test");

// Points at a coldtrail server the test runner starts itself (see README-style notes in
// linkedin.spec.js) — set COLDTRAIL_UI_BASE_URL to the printed "http://127.0.0.1:<port>/?t=<token>"
// URL (or just the origin; the spec appends its own query params per-request).
module.exports = defineConfig({
  testDir: __dirname,
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.COLDTRAIL_UI_BASE_URL || "http://127.0.0.1:8799",
    trace: "retain-on-failure",
  },
});

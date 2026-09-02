// @ts-check
//
// Playwright spec for the LinkedIn destination card (ui/index.html + ui/app.js) and the
// LinkedIn rendering in the Drafts tab. LinkedIn runs in ASSIST mode: the destination card is a
// static explanation (no Connect / auto-send controls), and on the Drafts screen "Open in LinkedIn"
// asks the backend to open the prospect's profile in the user's own browser (returns {opened:true}),
// "Copy note" copies the note to the clipboard, and a ✓/✗ pair confirms whether it sent. The assist
// endpoint is still route-intercepted below: against a live server it calls `open::that`, which
// would really pop a browser tab, so this spec must NEVER let a request reach it unmocked.
//
// How to run this against a live coldtrail server (there is no CI wiring for this yet — see the
// task-7 report for why):
//
//   cargo build
//   home=$(mktemp -d)
//   COLDTRAIL_HOME="$home" ./target/debug/coldtrail serve --port 8799 --no-open &
//   # the process prints "http://127.0.0.1:8799/?t=<TOKEN>" to stdout — grab <TOKEN> from that
//   cd tests/ui && npm install && COLDTRAIL_TOKEN=<TOKEN> COLDTRAIL_UI_BASE_URL=http://127.0.0.1:8799 npx playwright test
//   kill %1
//
const { test, expect } = require("@playwright/test");

const TOKEN = process.env.COLDTRAIL_TOKEN || "";

const LINKEDIN_DRAFT = {
  domain: "acme.com",
  to: "https://www.linkedin.com/in/janedoe",
  subject: null,
  body: "Hi Jane, would love to connect about our founder outreach tool.",
  status: "draft_pending",
  gmail_draft_id: null,
  channel: "linkedin",
};

// A fully-onboarded /api/status: the real endpoint only flips the UI out of the first-run
// wizard (which shows one setup step at a time) once Canonical is genuinely OAuth-connected —
// not something this hermetic spec can do. Stubbing status with onboarded:true puts the app
// straight into flat Settings mode, where every panel (including Destination/LinkedIn) is on
// screen at once, so the LinkedIn card is reachable without driving the wizard through its
// other, unrelated steps first. This is a read-only GET with no side effects either way.
const STATUS_STUB = {
  provider: "claude",
  agents: [{ kind: "claude", label: "Claude Code", present: true, authed: true }],
  canonical_wired: true,
  gmail_wired: true,
  message_customized: false,
  product_set: true,
  contacted_customized: false,
  onboarded: true,
  base_url: null,
  model: null,
  key_set: false,
  discovery_connected: true,
  destination_connected: true,
  auto_send: false,
  daily_send_cap: 20,
  osint: {
    the_harvester: false,
    the_harvester_can_install: false,
    spiderfoot: false,
    spiderfoot_can_install: false,
    pipx: false,
  },
  gmail_client_configured: false,
  gcloud_available: false,
  linkedin_connected: false,
  linkedin_reconnect_needed: false,
  linkedin_auto_send: false,
  linkedin_weekly_cap: 40,
  linkedin_daily_cap: 10,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: STATUS_STUB }));

  // --- LinkedIn destination endpoints ---------------------------------------------------
  await page.route("**/api/destination/linkedin/connect", (route) =>
    route.fulfill({ json: { status: "waiting" } })
  );
  let statusCalls = 0;
  await page.route("**/api/destination/linkedin/status", (route) => {
    statusCalls += 1;
    const body =
      statusCalls === 1
        ? { connected: false, reconnect_needed: false, waiting: true }
        : { connected: true, reconnect_needed: false, waiting: false };
    route.fulfill({ json: body });
  });
  await page.route("**/api/destination/linkedin/auto-send", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/destination/linkedin/disconnect", (route) => route.fulfill({ json: { ok: true } }));

  // --- Drafts LinkedIn endpoints ---------------------------------------------------------
  await page.route("**/api/drafts/*/linkedin/assist", (route) => route.fulfill({ json: { opened: true } }));
  await page.route("**/api/drafts/*/linkedin/confirm", (route) => route.fulfill({ json: { ok: true } }));
  // The bare per-domain save endpoint ("persist edits first") — one path segment after the
  // domain, so this does not shadow the two routes above (which have two extra segments).
  await page.route("**/api/drafts/*", (route, request) => {
    if (request.method() === "POST") return route.fulfill({ json: { ok: true } });
    return route.continue();
  });
  // The drafts list itself — stubbed to guarantee exactly one linkedin-channel row regardless
  // of whatever the real (freshly-created, empty) backend DB happens to contain.
  await page.route("**/api/drafts", (route) => route.fulfill({ json: [LINKEDIN_DRAFT] }));

  await page.goto(`/?t=${TOKEN}`);
});

test("LinkedIn destination card: assist-mode copy, no connect/auto-send controls", async ({ page }) => {
  await page.click('[data-nav="onboarding"]');
  // The card is now a static assist-mode explanation — the badge says so.
  await expect(page.locator("#li-conn-badge")).toContainText("assist mode");
  // The CDP-managed controls are gone: no Connect/Reconnect, Disconnect, or auto-send toggle/caps.
  await expect(page.locator("#li-connect")).toHaveCount(0);
  await expect(page.locator("#li-disconnect")).toHaveCount(0);
  await expect(page.locator("#li-as-toggle")).toHaveCount(0);
  await expect(page.locator("#li-as-weekly")).toHaveCount(0);
  await expect(page.locator("#li-as-daily")).toHaveCount(0);
});

test("Drafts: a LinkedIn draft shows its badge + char count + Copy note + Open-in-LinkedIn, then confirms", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click('[data-nav="drafts"]');
  const card = page.locator('.draft[data-channel="linkedin"]');
  await expect(card).toBeVisible();
  await expect(card.locator(".status.s-linkedin")).toHaveText("LinkedIn");

  const counter = card.locator(".li-charcount");
  await expect(counter).toHaveText(`${LINKEDIN_DRAFT.body.length}/300`);
  await expect(counter).not.toHaveClass(/over/);

  const note = card.locator(".li-note");
  await note.fill("x".repeat(310));
  await expect(counter).toHaveText("310/300");
  await expect(counter).toHaveClass(/over/);

  // Copy note: writes the note to the clipboard and flips its label to a "Copied" affordance.
  await note.fill("Hi Jane, let's connect.");
  const copyBtn = card.locator(".li-copy");
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();
  await expect(copyBtn).toContainText("Copied");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe("Hi Jane, let's connect.");

  // Open in LinkedIn: POSTs assist -> {opened:true}, then the row re-renders with the "Did it
  // send?" ✓/✗ pair instead of the Copy note / Open buttons.
  const assistBtn = card.locator(".li-assist");
  await expect(assistBtn).toBeVisible();
  await assistBtn.click();
  await expect(card.locator(".li-confirm-q")).toBeVisible();
  await expect(card.locator(".li-yes")).toBeVisible();
  await expect(card.locator(".li-no")).toBeVisible();
  await expect(card.locator(".li-assist")).toHaveCount(0);
  await expect(card.locator(".li-copy")).toHaveCount(0);
});

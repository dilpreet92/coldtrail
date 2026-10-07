// @ts-check
//
// Playwright spec for the LinkedIn destination card (ui/index.html + ui/app.js) and the
// LinkedIn rendering in the Drafts tab. Everything the LinkedIn feature can do to a real
// browser/backend — connect (launches a real, human-visible Chrome window), assist (drives that
// window), disconnect, and auto-send — is route-intercepted below. This spec must NEVER let a
// real request reach `/api/destination/linkedin/connect` or `/api/drafts/:domain/linkedin/assist`
// unmocked: if a route pattern here is wrong and one of those falls through, the coldtrail
// backend really would try to launch Chrome.
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
  linkedin_sent_7d: 3,
  linkedin_sent_today: 1,
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
  await page.route("**/api/drafts/*/linkedin/assist", (route) => route.fulfill({ json: { staged: true } }));
  await page.route("**/api/drafts/*/linkedin/confirm", (route) => route.fulfill({ json: { ok: true } }));
  // The LinkedIn bulk "Send all" endpoint — never a real send, just the {sending:true} ack. This
  // route pattern has no wildcard path segment after "linkedin/", so it does NOT shadow (and is
  // not shadowed by) the per-domain `/api/drafts/*/linkedin/send` route below.
  await page.route("**/api/drafts/linkedin/send-all", (route) => route.fulfill({ json: { sending: true } }));
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

test("LinkedIn destination card: Connect goes waiting -> connected, then caps POST", async ({ page }) => {
  await page.click('[data-nav="onboarding"]');
  const connectBtn = page.locator("#li-connect");
  await expect(connectBtn).toBeVisible();

  await connectBtn.click();
  await expect(page.locator("#li-body")).toContainText("waiting for login");

  // The poll (every 2s) flips to connected on its 2nd call — allow real time for it.
  await expect(page.locator("#li-conn-badge")).toContainText("connected", { timeout: 10_000 });
  await expect(page.locator("#li-disconnect")).toBeVisible();
  await expect(page.locator("#li-as-toggle")).toBeVisible();

  // Turning the toggle on shows a confirm() — accept it — then it POSTs to auto-send.
  page.once("dialog", (d) => d.accept());
  const [req] = await Promise.all([
    page.waitForRequest(
      (r) => r.url().includes("/api/destination/linkedin/auto-send") && r.method() === "POST"
    ),
    page.locator("#li-as-toggle").check(),
  ]);
  const posted = req.postDataJSON();
  expect(posted.enabled).toBe(true);
  expect(typeof posted.weekly_cap).toBe("number");
  expect(typeof posted.daily_cap).toBe("number");
});

test("Drafts: channel tabs default to All, and filter to the LinkedIn/Email rows", async ({ page }) => {
  await page.click('[data-nav="drafts"]');

  // Default tab is "All" — the stubbed LinkedIn draft shows without picking a tab, and its
  // "Send all" button counts the one pending LinkedIn draft (no email drafts in this stub).
  await expect(page.locator("#drafts-tabs .chip[data-t='all']")).toHaveAttribute("aria-pressed", "true");
  const card = page.locator('.draft[data-channel="linkedin"]');
  await expect(card).toBeVisible();
  await expect(page.locator("#bulk-all-send")).toHaveText("Send all (1)");

  // Email tab: no email drafts in this stub, so the list goes empty and there's no email
  // "Send all" bulk button (email's requires >=2 pending, same threshold as before tabs existed).
  await page.click("#drafts-tabs .chip[data-t='email']");
  await expect(page.locator("#drafts-tabs .chip[data-t='email']")).toHaveAttribute("aria-pressed", "true");
  await expect(card).toHaveCount(0);
  await expect(page.locator(".drafts .empty")).toBeVisible();
  await expect(page.locator("#drafts-bulk #bulk-draft")).toHaveCount(0);

  // LinkedIn tab: the stats line reflects the LinkedIn caps/counts from /api/status, not Gmail's.
  // Its own "Send all" button is present (count = 1) but DISABLED, since the stub has
  // linkedin_auto_send:false — the button stays on the tab with a hint rather than disappearing.
  await page.click("#drafts-tabs .chip[data-t='linkedin']");
  await expect(card).toBeVisible();
  await expect(page.locator("#warmup")).toContainText("1/10 today");
  await expect(page.locator("#warmup")).toContainText("3/40 this week");
  const liBulkBtn = page.locator("#bulk-li-send");
  await expect(liBulkBtn).toHaveText("Send all (1)");
  await expect(liBulkBtn).toBeDisabled();
  await expect(page.locator("#drafts-bulk .hint")).toContainText("Enable LinkedIn auto-send");
});

test("Drafts: LinkedIn tab Send-all is enabled and posts to send-all when auto-send is on", async ({ page }) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { ...STATUS_STUB, linkedin_auto_send: true } })
  );
  await page.click('[data-nav="drafts"]');
  await page.click("#drafts-tabs .chip[data-t='linkedin']");

  const liBulkBtn = page.locator("#bulk-li-send");
  await expect(liBulkBtn).toBeEnabled();
  await expect(page.locator("#drafts-bulk .hint")).toHaveCount(0);

  page.once("dialog", (d) => d.accept());
  const [req] = await Promise.all([
    page.waitForRequest(
      (r) => r.url().includes("/api/drafts/linkedin/send-all") && r.method() === "POST"
    ),
    liBulkBtn.click(),
  ]);
  expect(req.method()).toBe("POST");
  // The button reports it's working and stays disabled so a re-click can't spawn a second
  // `send-pending linkedin` process while one is already in flight.
  await expect(page.locator("#bulk-li-msg")).toContainText("Sending on LinkedIn");
  await expect(liBulkBtn).toBeDisabled();
});

test("Drafts: All tab Send-all sends only email when LinkedIn auto-send is off (confirm says so)", async ({
  page,
}) => {
  await page.click('[data-nav="drafts"]');
  // Default tab is "all"; the confirm dialog text is the only way to see the intended plan
  // (LinkedIn is skipped) without actually dispatching any request — capture it and dismiss.
  let dialogMessage = "";
  page.once("dialog", (d) => { dialogMessage = d.message(); d.dismiss(); });
  await page.locator("#bulk-all-send").click();
  expect(dialogMessage).toContain("enable LinkedIn auto-send");
});

test("Drafts: a LinkedIn draft shows its badge + live char count + Open-in-LinkedIn, then stages", async ({
  page,
}) => {
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

  const assistBtn = card.locator(".li-assist");
  await expect(assistBtn).toBeVisible();
  await assistBtn.click();

  // After {staged:true}, the row re-renders with the "Did it send?" ✓/✗ pair instead of the
  // assist button.
  await expect(card.locator(".li-confirm-q")).toBeVisible();
  await expect(card.locator(".li-yes")).toBeVisible();
  await expect(card.locator(".li-no")).toBeVisible();
  await expect(card.locator(".li-assist")).toHaveCount(0);
});

test("Drafts: a parked LinkedIn draft says why auto-send skips it and is left out of Send all", async ({
  page,
}) => {
  const parked = {
    ...LINKEDIN_DRAFT,
    domain: "franklin.example",
    to: "https://www.linkedin.com/in/gary",
    auto_skip: "LinkedIn asks for their email to connect — use Open in LinkedIn and enter it there, or delete this draft",
  };
  await page.route("**/api/drafts", (route) => route.fulfill({ json: [LINKEDIN_DRAFT, parked] }));
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { ...STATUS_STUB, linkedin_auto_send: true } })
  );
  await page.click('[data-nav="drafts"]');
  await page.click("#drafts-tabs .chip[data-t='linkedin']");

  const parkedCard = page.locator('.draft[data-domain="franklin.example"]');
  await expect(parkedCard.locator(".li-autoskip")).toContainText("Auto-send skipped: LinkedIn asks for their email");
  // The other draft carries no note.
  await expect(page.locator('.draft[data-domain="acme.com"] .li-autoskip')).toHaveCount(0);
  // send-pending skips parked drafts, so the bulk button only counts the sendable one.
  await expect(page.locator("#bulk-li-send")).toHaveText("Send all (1)");
});

test("Drafts: Open in LinkedIn on an already-invited profile says so instead of erroring", async ({ page }) => {
  await page.route("**/api/drafts/*/linkedin/assist", (route) =>
    route.fulfill({ json: { already_invited: true } })
  );
  await page.click('[data-nav="drafts"]');
  await page.locator('.draft[data-channel="linkedin"] .li-assist').click();
  await expect(page.locator(".toast").last()).toContainText("Already invited on LinkedIn");
});

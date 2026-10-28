// Settings (spec §5.9) at #/settings?tab=agent|connections|sending|enrichment|appearance: the tabs
// and their addresses; Agent (Setup's agentPanel: cards, the opencode model, Test connection, and
// the warning when opencode no longer offers the saved model); Connections (Canonical, Gmail with
// the app password first and more options folded, LinkedIn connect / reconnect / disconnect and
// its sign-in poll; connect requests outlive the screen); Sending (email and LinkedIn auto-send
// switches that confirm before turning on, caps that save on commit, refuse bad values, ask
// before going up while auto-send is on and never turn it back on, today's usage, a consequence
// line for each, and caps saved on the way out); Enrichment (the OSINT installers, intercepted);
// Appearance (System / Light / Dark, kept in this browser). Also: loading, error and stale-session
// states, keyboard use, hostile text, the poll stopping on unmount and on a stale session, and
// every tab accessible in light and dark and at phone width.
//
// Tests share one server (the `full` seed) and run in order; each one puts back any setting it
// changes, so none depends on another.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { SEED } from '../harness/seed.mjs';
import { SESSION_EXPIRED } from '../../../ui/js/core/api.js';
import { fmtNum } from '../../../ui/js/core/format.js';

const TABS = ['agent', 'connections', 'sending', 'enrichment', 'appearance'];
const TAB_LABELS = ['Agent', 'Connections', 'Sending', 'Enrichment', 'Appearance'];

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashIs = (hash) => new RegExp(`${reEscape(hash)}$`);
const statusPath = (url) => url.pathname === '/api/status';

const view = (page) => page.locator('#view');
const tabList = (page) => view(page).getByRole('tablist', { name: 'Settings sections' });
const tab = (page, label) => tabList(page).getByRole('tab', { name: new RegExp(`^${reEscape(label)}`) });
const panel = (page) => view(page).getByRole('tabpanel');
const region = (page, name) => panel(page).getByRole('region', { name, exact: true });
const emailSwitch = (page) => panel(page).getByRole('switch', { name: 'Auto-send emails' });
const linkedinSwitch = (page) => panel(page).getByRole('switch', { name: 'Auto-send LinkedIn invites' });
const confirmBox = (page) => page.getByRole('alertdialog');
const goHome = (page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).click();
const EMAIL_ON = (cap) =>
  `Send now on the Drafts screen emails people right away, and the agent can send email itself in chats and scheduled runs — up to ${cap} emails a day in total.`;

/** GET a token-guarded API path from the test (not the page). */
async function getJSON(request, server, path) {
  const res = await request.get(server.apiUrl(path));
  expect(res.status(), `GET ${path}: ${await res.text()}`).toBe(200);
  return res.json();
}

async function postJSON(request, server, path, data) {
  const res = await request.post(server.apiUrl(path), { data });
  expect(res.status(), `POST ${path}: ${await res.text()}`).toBe(200);
  return res.json();
}

/** Put the sending settings back to the workspace defaults. */
async function resetSending(request, server) {
  await postJSON(request, server, '/api/destination/auto-send', { enabled: false, daily_cap: 20 });
  await postJSON(request, server, '/api/destination/linkedin/auto-send', { enabled: false, weekly_cap: 80, daily_cap: 15 });
}

/** Rewrite every /api/status answer on this page through `patch(status)`. */
async function patchStatus(page, patch) {
  await page.route(statusPath, async (route) => {
    try {
      const res = await route.fetch();
      const status = await res.json();
      await route.fulfill({ response: res, json: patch(status) });
    } catch (err) {
      // A read that a reload (or the end of the test) cut off: nothing waits for it.
      if (!/disposed|closed|ended/i.test(String(err))) throw err;
    }
  });
}

/** coldtrail's persisted LinkedIn session, in this server's sandboxed secrets dir. */
const linkedinStateFile = (server) => join(server.secretsDir, 'linkedin-state.json');
function setLinkedinState(server, state) {
  const file = linkedinStateFile(server);
  if (state) writeFileSync(file, JSON.stringify(state));
  else rmSync(file, { force: true });
}

/** Count POSTs to `path` the page sends. */
function countRequests(page, path, method = 'POST') {
  const seen = [];
  page.on('request', (req) => {
    if (req.method() === method && new URL(req.url()).pathname === path) seen.push(req.postDataJSON());
  });
  return seen;
}

/** Press Tab until `target` has focus; fails after `max` presses. */
async function tabTo(page, target, { back = false, max = 60 } = {}) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  await expect(target).toBeFocused();
}

/** The page never scrolls sideways at this width. */
async function expectNoSideScroll(page, width) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

/** The chosen tab sits wholly inside the (sideways-scrolling) tab list. */
const selectedTabInView = (page) =>
  tabList(page).evaluate((list) => {
    const b = list.querySelector('[aria-selected="true"]').getBoundingClientRect();
    const l = list.getBoundingClientRect();
    return b.left >= l.left - 0.5 && b.right <= l.right + 0.5;
  });

/** The Agent tab has its cards and the opencode model. */
async function agentReady(page) {
  await expect(panel(page).locator('.ap-card .ap-name')).toHaveText(['Claude Code', 'Codex CLI', 'opencode', 'Your own model']);
}

test('first load shows a loading state, then the Agent tab', async ({ app, page }) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(statusPath, async (route) => {
    await held;
    await route.fallback();
  });
  await app.goto('#/settings');
  // The shell waits up to 3s for a first status, then mounts the screen without one.
  const loading = panel(page).getByRole('status').filter({ hasText: 'Loading your settings' });
  await expect(loading).toBeVisible({ timeout: 15_000 });
  await expect(view(page).locator('h1')).toHaveText('Settings');
  await expect(page).toHaveTitle('Settings · coldtrail');
  await expect(page.getByRole('navigation', { name: 'Main' }).locator('[aria-current="page"]')).toHaveText('Settings');
  release();

  await agentReady(page);
  await expect(loading).toHaveCount(0);
  await expect(tabList(page).getByRole('tab')).toHaveText(TAB_LABELS);
  await expect(tab(page, 'Agent')).toHaveAttribute('aria-selected', 'true');
  await expect(view(page).locator('.page-desc')).toHaveText(
    'The AI agent coldtrail drives to find companies, look up the right people and write your drafts.',
  );
  await expect(panel(page).locator('.ap-card[data-kind="opencode"] .ap-pick')).toHaveAttribute('aria-pressed', 'true');
  // Setup stays one click away.
  await expect(view(page).getByRole('link', { name: 'Run guided setup' })).toHaveAttribute('href', '#/setup');
});

test('status that fails to load shows the error and a retry; Appearance still works', async ({ app, page }) => {
  app.allowConsole(/status of 500/);
  let fail = true;
  await page.route(statusPath, (route) =>
    fail ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'workspace is not readable' }) : route.fallback(),
  );
  await app.goto('#/settings?tab=sending');
  const alert = panel(page).getByRole('alert').filter({ hasText: 'workspace is not readable' });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText("Couldn't load your settings");
  await expect(emailSwitch(page)).toHaveCount(0);

  // Appearance needs nothing from the server.
  await tab(page, 'Appearance').click();
  await expect(panel(page).getByRole('radio', { name: 'Dark' })).toBeVisible();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);

  await tab(page, 'Sending').click();
  fail = false;
  await panel(page).getByRole('button', { name: 'Try again' }).click();
  await expect(emailSwitch(page)).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('stale session points at the fix once', async ({ app, page, context }) => {
  app.allowConsole(/status of 401/);
  await app.goto('#/settings?tab=connections');
  await expect(region(page, 'Canonical')).toBeVisible();
  // An old tab after a restart: the cookie no longer matches (here: it's gone).
  await context.clearCookies();
  await page.reload();
  const card = panel(page).locator('.st-load-error');
  await expect(card).toContainText("Couldn't load your settings", { timeout: 15_000 });
  await expect(card).toContainText('Reopen coldtrail from your terminal.');
  await expect(page.locator('.session-banner')).toHaveText(SESSION_EXPIRED);
  // The banner says it, once and as the only alert; the card can't retry until the tab is reopened.
  const body = await page.locator('body').innerText();
  expect(body.split(SESSION_EXPIRED).length - 1).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page);
  }
});

test('tabs deep link', async ({ app, page }) => {
  const marks = {
    agent: () => panel(page).locator('.ap-card').first(),
    connections: () => region(page, 'Canonical'),
    sending: () => emailSwitch(page),
    enrichment: () => region(page, 'theHarvester'),
    appearance: () => panel(page).getByRole('radiogroup', { name: 'Theme' }),
  };
  for (const [i, id] of TABS.entries()) {
    await app.goto(`#/settings?tab=${id}`);
    await expect(tab(page, TAB_LABELS[i])).toHaveAttribute('aria-selected', 'true');
    await expect(marks[id]()).toBeVisible();
    // Only the chosen tab's content is on screen, and the panel is named by its tab.
    await expect(panel(page)).toHaveAccessibleName(TAB_LABELS[i]);
    await expect(tabList(page).locator('[aria-selected="true"]')).toHaveCount(1);
  }

  // A bare address and an unknown tab both open Agent.
  await app.goto('#/settings');
  await expect(tab(page, 'Agent')).toHaveAttribute('aria-selected', 'true');
  await app.goto('#/settings?tab=nope');
  await expect(tab(page, 'Agent')).toHaveAttribute('aria-selected', 'true');
  await agentReady(page);

  // Clicking a tab puts it in the address (replacing the entry, so Back leaves Settings).
  await tab(page, 'Connections').click();
  await expect(page).toHaveURL(hashIs('#/settings?tab=connections'));
  await expect(marks.connections()).toBeVisible();
  await expect(panel(page).locator('.ap-card').first()).toBeHidden();

  // Arrow keys move between tabs and select as they go.
  await tab(page, 'Connections').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Sending')).toBeFocused();
  await expect(page).toHaveURL(hashIs('#/settings?tab=sending'));
  await expect(marks.sending()).toBeVisible();
  await page.keyboard.press('End');
  await expect(page).toHaveURL(hashIs('#/settings?tab=appearance'));
  await page.keyboard.press('Home');
  await expect(page).toHaveURL(hashIs('#/settings?tab=agent'));

  // The sidebar's connection dots open their tab without reloading the screen.
  await view(page).evaluate((el) => {
    el.dataset.mark = 'kept';
  });
  await page.locator('#nav .conn').filter({ hasText: 'Gmail' }).click();
  await expect(page).toHaveURL(hashIs('#/settings?tab=connections'));
  await expect(tab(page, 'Connections')).toHaveAttribute('aria-selected', 'true');
  await expect(marks.connections()).toBeVisible();
  await expect(view(page)).toHaveAttribute('data-mark', 'kept');
  await expect(view(page).locator('.page-desc')).toHaveText('Where companies come from and where your outreach goes.');
});

test('opencode model change persists', async ({ app, page, request, server }) => {
  await app.goto('#/settings?tab=agent');
  await agentReady(page);
  const model = panel(page).getByRole('combobox', { name: 'Model' });
  await expect(model).toHaveValue('fake/model-a');
  await expect(panel(page).locator('.ap-model .field-hint')).toContainText('3 models from opencode');
  // opencode offers the saved model: nothing to warn about.
  await expect(panel(page).locator('.st-model-warn')).toBeHidden();

  await model.click();
  await expect(panel(page).getByRole('option')).toHaveText(['fake/model-a', 'fake/model-b', 'opencode/free-c']);
  await panel(page).getByRole('option', { name: 'fake/model-b' }).click();
  await expect(panel(page).locator('.ap-model [role="status"]')).toHaveText('Model saved');
  expect((await getJSON(request, server, '/api/status')).opencode_model).toBe('fake/model-b');

  await page.reload();
  await expect(model).toHaveValue('fake/model-b');

  // Test connection runs the probe against the (fake) opencode.
  await panel(page).getByRole('button', { name: 'Test connection' }).click();
  await expect(panel(page).locator('.ap-test-result')).toHaveText('opencode is signed in and responding.', { timeout: 30_000 });

  await postJSON(request, server, '/api/onboarding/provider', { provider: 'opencode', opencode_model: 'fake/model-a' });
});

test('a saved model opencode no longer offers is called out by the picker', async ({ app, page, request, server }) => {
  // opencode retired the saved model (fake/model-a): its list doesn't have it any more.
  let served = 0;
  await page.route('**/api/provider/opencode/models', (route) => {
    served++;
    return route.fulfill({ json: { models: ['fake/model-b', 'opencode/free-c'], message: null } });
  });
  try {
    await app.goto('#/settings?tab=agent');
    await agentReady(page);
    const model = panel(page).getByRole('combobox', { name: 'Model' });
    await expect(model).toHaveValue('fake/model-a');
    const warn = panel(page).locator('.ap-model .st-model-warn');
    await expect(warn).toBeVisible();
    await expect(warn).toHaveText(
      "fake/model-a isn't offered by opencode anymore — pick another model. Chats and scheduled runs fail until you do.",
    );
    // Read with the field, too.
    await expect(model).toHaveAccessibleDescription(/fake\/model-a isn't offered by opencode anymore/);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectAccessible(page);
    }

    // Picking one it offers saves it, and the warning goes.
    await model.click();
    await panel(page).getByRole('option', { name: 'fake/model-b' }).click();
    await expect(panel(page).locator('.ap-model [role="status"]')).toHaveText('Model saved');
    await expect(warn).toBeHidden();
    await expect(model).not.toHaveAccessibleDescription(/isn't offered/);
    expect((await getJSON(request, server, '/api/status')).opencode_model).toBe('fake/model-b');

    // Set elsewhere to a model it doesn't offer: the warning follows status.
    await postJSON(request, server, '/api/onboarding/provider', { provider: 'opencode', opencode_model: 'fake/model-a' });
    await page.reload();
    await expect(warn).toBeVisible();

    // A list that can't be read says nothing either way.
    app.allowConsole(/status of 500/);
    await page.unroute('**/api/provider/opencode/models');
    served = 0;
    await page.route('**/api/provider/opencode/models', (route) => {
      served++;
      return route.fulfill({ status: 500, contentType: 'text/plain', body: 'opencode crashed' });
    });
    await page.reload();
    await agentReady(page);
    // Both the picker and the warning have asked (and been refused).
    await expect.poll(() => served).toBeGreaterThanOrEqual(2);
    await expect(model).toHaveValue('fake/model-a');
    await expect(warn).toBeHidden();
  } finally {
    await postJSON(request, server, '/api/onboarding/provider', { provider: 'opencode', opencode_model: 'fake/model-a' });
  }
});

test('enabling email auto-send asks to confirm and persists', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  await app.goto('#/settings?tab=sending');
  const email = region(page, 'Email');
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(email.locator('.switch-desc')).toHaveText('Drafts only: each email is saved to your Gmail drafts for you to review and send.');
  // Gmail isn't connected in this workspace: the card says so and links to the fix.
  await expect(email.locator('.st-notice')).toContainText("Gmail isn't connected");
  await expect(email.getByRole('link', { name: 'Connect Gmail' })).toHaveAttribute('href', '#/settings?tab=connections');

  await emailSwitch(page).click();
  const dialog = confirmBox(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Turn on email auto-send?');
  // While it asks, the switch still says off.
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false');
  // The cap counts every email send: Send now, and the agent's own in chats and scheduled runs.
  await expect(dialog).toContainText(
    "Send now on the Drafts screen will email people right away, and the agent can send email itself in chats and scheduled runs — up to 20 emails a day in total. A sent email can't be taken back.",
  );
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(email.locator('.switch-desc')).toHaveText(EMAIL_ON(20));
  await expect(email.locator('.st-msg')).toHaveText('Email auto-send is on.');
  await expect(emailSwitch(page)).toBeFocused();
  let status = await getJSON(request, server, '/api/status');
  expect(status.auto_send).toBe(true);
  expect(status.daily_send_cap).toBe(20);

  await page.reload();
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'true');

  // Turning it off doesn't ask.
  await emailSwitch(page).click();
  await expect(confirmBox(page)).toHaveCount(0);
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(email.locator('.st-msg')).toHaveText('Email auto-send is off.');
  await expect.poll(async () => (await getJSON(request, server, '/api/status')).auto_send).toBe(false);
  status = await getJSON(request, server, '/api/status');
  expect(status.daily_send_cap).toBe(20);
});

test('cancelling the confirm leaves it off', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  const emailPosts = countRequests(page, '/api/destination/auto-send');
  const linkedinPosts = countRequests(page, '/api/destination/linkedin/auto-send');
  await app.goto('#/settings?tab=sending');

  await emailSwitch(page).click();
  await expect(confirmBox(page)).toBeVisible();
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await confirmBox(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmBox(page)).toHaveCount(0);
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false');

  // Esc is a cancel too.
  await linkedinSwitch(page).click();
  await expect(confirmBox(page).getByRole('heading')).toHaveText('Turn on LinkedIn auto-send?');
  await page.keyboard.press('Escape');
  await expect(confirmBox(page)).toHaveCount(0);
  await expect(linkedinSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(linkedinSwitch(page)).toBeFocused();

  const status = await getJSON(request, server, '/api/status');
  expect(status.auto_send).toBe(false);
  expect(status.linkedin_auto_send).toBe(false);
  expect(emailPosts).toEqual([]);
  expect(linkedinPosts).toEqual([]);
});

test('email daily cap saves and refuses bad values', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  const posts = countRequests(page, '/api/destination/auto-send');
  await app.goto('#/settings?tab=sending');
  const email = region(page, 'Email');
  const cap = email.getByLabel('Daily cap');
  await expect(cap).toHaveValue('20');
  // Today's email sends against the cap (the seed's, as the server counts them).
  await expect(email.locator('.st-usage')).toHaveText(`${fmtNum(SEED.capUsage.emailToday)} of 20 sent today`);

  for (const bad of ['0', '501', '2.5']) {
    await cap.fill(bad);
    await cap.press('Enter');
    await expect(cap).toHaveAttribute('aria-invalid', 'true');
    await expect(email.locator('.field-error')).toHaveText('Enter a whole number from 1 to 500.');
  }
  expect(posts).toEqual([]);

  await cap.fill('35');
  // The usage line follows what's typed, before it's saved.
  await expect(email.locator('.st-usage')).toHaveText(`${fmtNum(SEED.capUsage.emailToday)} of 35 sent today`);
  await cap.press('Enter');
  await expect(email.locator('.st-msg')).toHaveText('Saved. Up to 35 emails a day.');
  await expect(cap).not.toHaveAttribute('aria-invalid', /.*/);
  await expect(email.locator('.field-error')).toBeHidden();
  // Saving the cap keeps auto-send as it was.
  expect(posts).toEqual([{ enabled: false, daily_cap: 35 }]);
  let status = await getJSON(request, server, '/api/status');
  expect(status.daily_send_cap).toBe(35);
  expect(status.auto_send).toBe(false);

  // The confirm names the cap that will apply.
  await emailSwitch(page).click();
  await expect(confirmBox(page)).toContainText('up to 35 emails a day');
  await page.keyboard.press('Escape');

  // A cap typed and then left (blur) saves too.
  await cap.fill('12');
  await email.getByRole('heading', { name: 'Email' }).click();
  await expect(email.locator('.st-msg')).toHaveText('Saved. Up to 12 emails a day.');
  status = await getJSON(request, server, '/api/status');
  expect(status.daily_send_cap).toBe(12);
  await page.reload();
  await expect(cap).toHaveValue('12');
  await resetSending(request, server);
});

test('LinkedIn caps save', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  const posts = countRequests(page, '/api/destination/linkedin/auto-send');
  await app.goto('#/settings?tab=sending');
  const li = region(page, 'LinkedIn');
  const daily = li.getByLabel('Daily cap');
  const weekly = li.getByLabel('Weekly cap');
  await expect(daily).toHaveValue('15');
  await expect(weekly).toHaveValue('80');
  await expect(li.locator('.switch-desc')).toHaveText(
    'coldtrail opens each connection request in a LinkedIn window for you to review and send.',
  );
  await expect(li.locator('.st-notice')).toContainText("LinkedIn isn't connected");

  // A daily cap above the weekly one is refused.
  await daily.fill('90');
  await daily.press('Enter');
  await expect(daily).toHaveAttribute('aria-invalid', 'true');
  await expect(li.locator('.field-error')).toHaveText("The daily cap can't be more than the weekly cap.");
  expect(posts).toEqual([]);

  await daily.fill('10');
  await daily.press('Enter');
  await expect(li.locator('.st-msg')).toHaveText('Saved. Up to 10 invites a day and 80 a week.');
  await weekly.fill('50');
  await weekly.press('Enter');
  await expect(li.locator('.st-msg')).toHaveText('Saved. Up to 10 invites a day and 50 a week.');
  expect(posts).toEqual([
    { enabled: false, weekly_cap: 80, daily_cap: 10 },
    { enabled: false, weekly_cap: 50, daily_cap: 10 },
  ]);
  let status = await getJSON(request, server, '/api/status');
  expect([status.linkedin_daily_cap, status.linkedin_weekly_cap, status.linkedin_auto_send]).toEqual([10, 50, false]);

  // Turning it on confirms with the caps, then says what happens.
  await linkedinSwitch(page).click();
  await expect(confirmBox(page)).toContainText(
    'coldtrail will click Send on connection requests itself, up to 10 a day and 50 a week. LinkedIn can restrict accounts that send too many invites.',
  );
  await confirmBox(page).getByRole('button', { name: 'Turn on' }).click();
  await expect(linkedinSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(li.locator('.switch-desc')).toHaveText(
    'coldtrail clicks Send on connection requests itself, up to 10 a day and 50 a week, including on scheduled runs.',
  );
  status = await getJSON(request, server, '/api/status');
  expect(status.linkedin_auto_send).toBe(true);

  await page.reload();
  await expect(daily).toHaveValue('10');
  await expect(weekly).toHaveValue('50');
  await expect(linkedinSwitch(page)).toHaveAttribute('aria-checked', 'true');
  // Today's and this week's invites (the seed's) against the caps.
  await expect(li.locator('.st-usage')).toHaveText(
    `${fmtNum(SEED.capUsage.linkedinToday)} of 10 sent today · ${fmtNum(SEED.capUsage.linkedin7d)} of 50 in the last 7 days`,
  );
  await resetSending(request, server);
});

test('a cap save keeps auto-send as it is now, even when the screen is behind', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  await postJSON(request, server, '/api/destination/auto-send', { enabled: true, daily_cap: 20 });
  try {
    const posts = countRequests(page, '/api/destination/auto-send');
    // Every status this screen reads says auto-send is on, until `behind` goes false.
    let behind = true;
    await page.route(statusPath, async (route) => {
      if (!behind) return route.fallback();
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), auto_send: true } });
    });
    await app.goto('#/settings?tab=sending');
    const email = region(page, 'Email');
    await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'true');

    // Turned off elsewhere (the CLI, another tab); this screen hasn't heard.
    await postJSON(request, server, '/api/destination/auto-send', { enabled: false });
    await expect(email.locator('.switch-desc')).toHaveText(EMAIL_ON(20));
    behind = false;

    // Saving a cap reads auto-send afresh and must not turn it back on.
    await email.getByLabel('Daily cap').fill('18');
    await email.getByLabel('Daily cap').press('Enter');
    await expect(email.locator('.st-msg')).toHaveText('Saved. Up to 18 emails a day.');
    expect(posts).toEqual([{ enabled: false, daily_cap: 18 }]);
    expect((await getJSON(request, server, '/api/status')).auto_send).toBe(false);
    // … and the screen catches up.
    await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(email.locator('.switch-desc')).toHaveText('Drafts only: each email is saved to your Gmail drafts for you to review and send.');
  } finally {
    await resetSending(request, server);
  }
});

test('raising a cap while auto-send is on asks first', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  await postJSON(request, server, '/api/destination/auto-send', { enabled: true, daily_cap: 20 });
  await postJSON(request, server, '/api/destination/linkedin/auto-send', { enabled: true, weekly_cap: 80, daily_cap: 15 });
  try {
    const emailPosts = countRequests(page, '/api/destination/auto-send');
    const linkedinPosts = countRequests(page, '/api/destination/linkedin/auto-send');
    await app.goto('#/settings?tab=sending');
    const email = region(page, 'Email');
    const cap = email.getByLabel('Daily cap');
    await expect(cap).toHaveValue('20');
    await expect(email.locator('.switch-desc')).toHaveText(EMAIL_ON(20));

    // Up: it asks, naming the new cap. Cancel keeps the saved one.
    await cap.fill('40');
    await expect(email.locator('.switch-desc')).toHaveText(EMAIL_ON(40));
    await cap.press('Enter');
    const dialog = confirmBox(page);
    await expect(dialog.getByRole('heading')).toHaveText('Raise the email cap to 40 a day?');
    await expect(dialog).toContainText(
      "Auto-send is on, so Send now and the agent can email up to 40 people a day without asking. A sent email can't be taken back.",
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(cap).toHaveValue('20');
    await expect(cap).toBeFocused();
    await expect(email.locator('.st-msg')).toHaveText('Not changed. Up to 20 emails a day.');
    await expect(email.locator('.switch-desc')).toHaveText(EMAIL_ON(20));
    expect(emailPosts).toEqual([]);

    // Confirmed: saved, and auto-send stays on.
    await cap.fill('40');
    await cap.press('Enter');
    await confirmBox(page).getByRole('button', { name: 'Raise cap' }).click();
    await expect(email.locator('.st-msg')).toHaveText('Saved. Up to 40 emails a day.');
    expect(emailPosts).toEqual([{ enabled: true, daily_cap: 40 }]);

    // Down never asks.
    await cap.fill('25');
    await cap.press('Enter');
    await expect(email.locator('.st-msg')).toHaveText('Saved. Up to 25 emails a day.');
    await expect(confirmBox(page)).toHaveCount(0);
    expect(emailPosts).toEqual([
      { enabled: true, daily_cap: 40 },
      { enabled: true, daily_cap: 25 },
    ]);
    let status = await getJSON(request, server, '/api/status');
    expect([status.auto_send, status.daily_send_cap]).toEqual([true, 25]);

    // LinkedIn: either cap going up asks; Esc is a cancel.
    const li = region(page, 'LinkedIn');
    await li.getByLabel('Weekly cap').fill('100');
    await li.getByLabel('Weekly cap').press('Enter');
    await expect(confirmBox(page).getByRole('heading')).toHaveText('Raise the LinkedIn caps?');
    await expect(confirmBox(page)).toContainText('coldtrail can send up to 15 invites a day and 100 a week without asking.');
    await page.keyboard.press('Escape');
    await expect(confirmBox(page)).toHaveCount(0);
    await expect(li.getByLabel('Weekly cap')).toHaveValue('80');
    await expect(li.locator('.st-msg')).toHaveText('Not changed. Up to 15 invites a day and 80 a week.');
    expect(linkedinPosts).toEqual([]);
    status = await getJSON(request, server, '/api/status');
    expect([status.linkedin_auto_send, status.linkedin_daily_cap, status.linkedin_weekly_cap]).toEqual([true, 15, 80]);
  } finally {
    await resetSending(request, server);
  }
});

test('leaving the screen saves a cap that was typed and left', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  try {
    const posts = countRequests(page, '/api/destination/auto-send');
    await app.goto('#/settings?tab=sending');
    const cap = region(page, 'Email').getByLabel('Daily cap');
    await expect(cap).toHaveValue('20');
    // Typed, then straight to another screen (the save was still waiting out its debounce).
    await cap.fill('33');
    await goHome(page);
    await expect(view(page).locator('.settings')).toHaveCount(0);
    // The router waited for it.
    expect(posts).toEqual([{ enabled: false, daily_cap: 33 }]);
    expect((await getJSON(request, server, '/api/status')).daily_send_cap).toBe(33);

    // With auto-send on, a raise left that way isn't saved, and nothing asks on the way out.
    await postJSON(request, server, '/api/destination/auto-send', { enabled: true, daily_cap: 33 });
    await app.goto('#/settings?tab=sending');
    await expect(cap).toHaveValue('33');
    await cap.fill('90');
    await goHome(page);
    await expect(view(page).locator('.settings')).toHaveCount(0);
    await expect(confirmBox(page)).toHaveCount(0);
    expect(posts).toEqual([{ enabled: false, daily_cap: 33 }]);
    expect((await getJSON(request, server, '/api/status')).daily_send_cap).toBe(33);
  } finally {
    await resetSending(request, server);
  }
});

test('osint install calls the (intercepted) endpoint', async ({ app, page }) => {
  let osint = { the_harvester: false, the_harvester_can_install: true, spiderfoot: false, spiderfoot_can_install: false, pipx: true };
  await patchStatus(page, (s) => ({ ...s, osint }));
  await app.goto('#/settings?tab=enrichment');
  const harvester = region(page, 'theHarvester');
  const spiderfoot = region(page, 'SpiderFoot');
  await expect(harvester.locator('.badge')).toHaveText('Not installed');
  await expect(spiderfoot.locator('.badge')).toHaveText('Not installed');
  await expect(spiderfoot).toContainText('Needs git and Python 3.10–3.12 to install.');
  await expect(spiderfoot.getByRole('button', { name: /Install/ })).toHaveCount(0);

  // The install takes a while: the button says so while it runs.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/onboarding/osint/install', async (route) => {
    await held;
    await route.fallback(); // the harness's intercept answers {ok:true, message:"installed"}
  });
  await harvester.getByRole('button', { name: 'Install theHarvester' }).click();
  await expect(harvester.locator('.st-msg')).toHaveText('Installing theHarvester. This can take a few minutes.');
  await expect(harvester.getByRole('button', { name: /Install/ })).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(harvester.locator('.st-msg')).toHaveText('installed');
  expect(app.calls).toEqual([{ method: 'POST', path: '/api/onboarding/osint/install', body: { tool: 'the_harvester' } }]);

  // A failed install says why and can be tried again.
  await page.unroute('**/api/onboarding/osint/install');
  await page.route('**/api/onboarding/osint/install', (route) =>
    route.fulfill({ json: { ok: false, message: 'pipx install theHarvester failed: no network' } }),
  );
  await harvester.getByRole('button', { name: 'Install theHarvester' }).click();
  await expect(harvester.locator('.st-msg')).toHaveText('pipx install theHarvester failed: no network');
  await expect(harvester.getByRole('button', { name: 'Install theHarvester' })).not.toHaveAttribute('aria-busy', /.*/);

  // Installed, and pipx missing: the rows say so after Check again.
  osint = { the_harvester: true, the_harvester_can_install: false, spiderfoot: false, spiderfoot_can_install: false, pipx: false };
  await panel(page).getByRole('button', { name: 'Check again' }).click();
  await expect(harvester.locator('.badge')).toHaveText('Installed');
  await expect(harvester.getByRole('button', { name: /Install/ })).toHaveCount(0);
  osint = { the_harvester: false, the_harvester_can_install: false, spiderfoot: true, spiderfoot_can_install: false, pipx: false };
  await panel(page).getByRole('button', { name: 'Check again' }).click();
  await expect(harvester).toContainText('Needs pipx to install.');
  await expect(spiderfoot.locator('.badge')).toHaveText('Installed');
});

test('connections connect through the intercepted routes', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  await app.goto('#/settings?tab=connections');
  const canonical = region(page, 'Canonical');
  const gmail = region(page, 'Gmail');
  const linkedin = region(page, 'LinkedIn');

  // Canonical is connected in this workspace; reconnecting runs the (intercepted) OAuth.
  await expect(canonical.locator('.badge')).toHaveText('Connected');
  await canonical.getByRole('button', { name: 'Reconnect' }).click();
  await expect(canonical.locator('.st-msg')).toHaveText('Canonical is connected.');

  // Gmail: inline validation, then the (intercepted) app-password check.
  await expect(gmail.locator('.badge').first()).toHaveText('Not connected');
  await gmail.getByRole('button', { name: 'Connect Gmail' }).click();
  await expect(gmail.locator('.st-msg')).toHaveText('Enter your Gmail address and the app password.');
  await expect(gmail.getByLabel('Gmail address', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(gmail.getByLabel('Gmail address', { exact: true })).toBeFocused();
  await gmail.getByLabel('Gmail address', { exact: true }).fill('dee@example.com');
  await gmail.getByLabel('App password', { exact: true }).fill('abcd efgh ijkl mnop');
  await gmail.getByLabel('App password', { exact: true }).press('Enter');
  await expect(gmail.locator('.badge').first()).toHaveText('Connected');
  await expect(gmail.locator('.st-msg')).toHaveText('Gmail is connected.');
  await expect(gmail.locator('.st-card-note')).toHaveText('coldtrail saves each email as a draft in your Gmail. You review and send it there.');

  // The own-OAuth-client path checks for a client id before saving anything.
  await gmail.getByText('Use different credentials').click();
  await gmail.getByText('More options').click();
  await gmail.getByRole('button', { name: 'Save and connect' }).click();
  await expect(gmail.locator('.st-msg')).toHaveText('Paste your client ID first.');

  // LinkedIn: the sign-in window never opens here, so the server reports it isn't waiting.
  await expect(linkedin.locator('.badge').first()).toHaveText('Not connected');
  await linkedin.getByRole('button', { name: 'Connect LinkedIn' }).click();
  await expect(linkedin.locator('.st-msg')).toHaveText("LinkedIn sign-in didn't finish: the window was closed or it timed out. Try again.", { timeout: 15_000 });
  await expect(linkedin.getByRole('button', { name: 'Connect LinkedIn' })).toBeVisible();

  // Busy browser.
  await page.route('**/api/destination/linkedin/connect', (route) => route.fulfill({ json: { status: 'busy' } }));
  await linkedin.getByRole('button', { name: 'Connect LinkedIn' }).click();
  await expect(linkedin.locator('.st-msg')).toHaveText('Chrome is busy with another LinkedIn task. Try again in a moment.');
  await page.unroute('**/api/destination/linkedin/connect');

  // A sign-in that finishes: waiting, then connected.
  let finished = false;
  await page.route('**/api/destination/linkedin/status', (route) =>
    route.fulfill({ json: { connected: finished, reconnect_needed: false, waiting: !finished } }),
  );
  await linkedin.getByRole('button', { name: 'Connect LinkedIn' }).click();
  await expect(linkedin.locator('.badge').first()).toHaveText('Waiting for sign-in');
  await expect(linkedin.locator('.st-msg')).toContainText('Sign in to LinkedIn in the Chrome window');
  // The buttons are away while it waits, and so is their (empty) row: the message sits under
  // the note at the usual distance.
  await expect(linkedin.locator('.st-card-body')).toBeHidden();
  const gap = await linkedin.evaluate(
    (card) => card.querySelector('.st-msg').getBoundingClientRect().top - card.querySelector('.st-card-head').getBoundingClientRect().bottom,
  );
  expect(gap).toBeCloseTo(12, 0);
  finished = true;
  await expect(linkedin.locator('.badge').first()).toHaveText('Connected', { timeout: 15_000 });
  await expect(linkedin.locator('.st-msg')).toHaveText('LinkedIn is connected.');

  expect(app.calls.map((c) => c.path)).toEqual([
    '/api/discovery/canonical/connect',
    '/api/destination/gmail/app-password',
    '/api/destination/linkedin/connect',
    '/api/destination/linkedin/connect',
  ]);
  expect(app.calls[1].body).toEqual({ email: 'dee@example.com', app_password: 'abcd efgh ijkl mnop' });
});

test('LinkedIn disconnect asks first; reconnect-needed says so', async ({ app, page, server }) => {
  setLinkedinState(server, { connected: true, reconnect_needed: false });
  try {
    await app.goto('#/settings?tab=connections');
    const linkedin = region(page, 'LinkedIn');
    await expect(linkedin.locator('.badge').first()).toHaveText('Connected');
    await expect(linkedin.getByRole('button', { name: 'Connect LinkedIn' })).toHaveCount(0);

    const disconnect = linkedin.getByRole('button', { name: 'Disconnect' });
    await disconnect.click();
    await expect(confirmBox(page).getByRole('heading')).toHaveText('Disconnect LinkedIn?');
    await confirmBox(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(linkedin.locator('.badge').first()).toHaveText('Connected');
    expect(existsSync(linkedinStateFile(server))).toBe(true);

    await disconnect.click();
    await confirmBox(page).getByRole('button', { name: 'Disconnect' }).click();
    await expect(linkedin.locator('.badge').first()).toHaveText('Not connected');
    await expect(linkedin.locator('.st-msg')).toHaveText('LinkedIn is disconnected.');
    await expect(linkedin.getByRole('button', { name: 'Connect LinkedIn' })).toBeVisible();
    expect(existsSync(linkedinStateFile(server))).toBe(false);

    // A session LinkedIn logged out: amber, and Reconnect is the action.
    setLinkedinState(server, { connected: true, reconnect_needed: true });
    await page.reload();
    await expect(linkedin.locator('.badge').first()).toHaveText('Reconnect needed');
    await expect(linkedin.locator('.st-card-note')).toHaveText('Your LinkedIn session expired. Reconnect to keep sending invites.');
    await expect(linkedin.getByRole('button', { name: 'Reconnect LinkedIn' })).toBeVisible();
    expect(JSON.parse(readFileSync(linkedinStateFile(server), 'utf8')).reconnect_needed).toBe(true);
    // Sending says the same, and points at the fix.
    await tab(page, 'Sending').click();
    const notice = region(page, 'LinkedIn').locator('.st-notice');
    await expect(notice).toContainText("Your LinkedIn session expired, so coldtrail can't send invites until you reconnect.");
    await expect(notice.getByRole('link', { name: 'Reconnect LinkedIn' })).toHaveAttribute('href', '#/settings?tab=connections');
  } finally {
    setLinkedinState(server, null);
  }
});

test('leaving settings stops the LinkedIn poll', async ({ app, page }) => {
  await page.clock.install();
  // Count status polls in the page itself, so nothing is missed between screens.
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.__liPolls = 0;
    window.fetch = function (input, init) {
      const url = String((input && input.url) || input);
      if (url.includes('/api/destination/linkedin/status')) window.__liPolls++;
      return orig.call(this, input, init);
    };
  });
  await page.route('**/api/destination/linkedin/status', (route) =>
    route.fulfill({ json: { connected: false, reconnect_needed: false, waiting: true } }),
  );
  const polls = () => page.evaluate(() => window.__liPolls);
  await app.goto('#/settings?tab=connections');
  const linkedin = region(page, 'LinkedIn');
  await linkedin.getByRole('button', { name: 'Connect LinkedIn' }).click();
  await expect(linkedin.locator('.badge').first()).toHaveText('Waiting for sign-in');
  await page.clock.runFor(2_100);
  await expect.poll(polls).toBeGreaterThanOrEqual(1);

  // Another tab of Settings keeps polling (same screen) …
  await tab(page, 'Sending').click();
  const during = await polls();
  await page.clock.runFor(4_200);
  await expect.poll(polls).toBeGreaterThan(during);

  // … leaving the screen stops it.
  await page.evaluate(() => {
    location.hash = '#/home';
  });
  await expect(view(page).locator('.settings')).toHaveCount(0);
  const before = await polls();
  await page.clock.runFor(20_000);
  expect(await polls()).toBe(before);
});

test('a stale session stops the LinkedIn sign-in poll', async ({ app, page }) => {
  app.allowConsole(/status of 401/);
  await page.clock.install();
  let polls = 0;
  await page.route('**/api/destination/linkedin/status', (route) => {
    polls++;
    return route.fulfill({ status: 401, contentType: 'text/plain', body: 'unauthorized' });
  });
  await app.goto('#/settings?tab=connections');
  const linkedin = region(page, 'LinkedIn');
  await linkedin.getByRole('button', { name: 'Connect LinkedIn' }).click();
  await expect(linkedin.locator('.badge').first()).toHaveText('Waiting for sign-in');
  await page.clock.runFor(2_100);
  // One refused poll is enough: it says how to fix it and offers Connect again.
  await expect(linkedin.locator('.st-msg')).toHaveText('Reopen coldtrail from your terminal.');
  await expect(linkedin.locator('.badge').first()).toHaveText('Not connected');
  await expect(linkedin.getByRole('button', { name: 'Connect LinkedIn' })).toBeVisible();
  expect(polls).toBe(1);
  await page.clock.runFor(20_000);
  expect(polls).toBe(1);
});

test('connect requests outlive the screen', async ({ app, page }) => {
  // Canonical's connect is held open by the server until the browser approval comes back:
  // moving to another screen meanwhile must not drop it (that would stop the callback listener).
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/discovery/canonical/connect', async (route) => {
    await held;
    await route.fallback(); // the harness's intercept answers {ok:true}
  });
  const failed = [];
  page.on('requestfailed', (req) => {
    if (new URL(req.url()).pathname === '/api/discovery/canonical/connect') failed.push(req.failure());
  });
  await app.goto('#/settings?tab=connections');
  const canonical = region(page, 'Canonical');
  await canonical.getByRole('button', { name: 'Reconnect' }).click();
  await expect(canonical.getByRole('button', { name: 'Waiting for approval…' })).toHaveAttribute('aria-busy', 'true');
  await expect(canonical.locator('.st-msg')).toContainText('Approve coldtrail in the browser tab that opened.');

  await goHome(page);
  await expect(view(page).locator('.settings')).toHaveCount(0);
  const finished = page.waitForEvent('requestfinished', (req) => new URL(req.url()).pathname === '/api/discovery/canonical/connect');
  release();
  await finished;
  expect(failed).toEqual([]);
  expect(app.calls.map((c) => c.path)).toEqual(['/api/discovery/canonical/connect']);
});

test('appearance persists across reload', async ({ app, page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await app.goto('#/settings?tab=appearance');
  const group = panel(page).getByRole('radiogroup', { name: 'Theme' });
  const html = page.locator('html');
  await expect(group.getByRole('radio', { name: 'System' })).toBeChecked();
  await expect(html).not.toHaveAttribute('data-theme', /.*/);
  await expect(panel(page)).toContainText("System follows your computer's setting, which is light right now.");

  await group.getByRole('radio', { name: 'Dark' }).check();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 16, 18)');
  await page.reload();
  await expect(group.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  // Keyboard: arrow keys move through the options and apply them.
  await group.getByRole('radio', { name: 'Dark' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(group.getByRole('radio', { name: 'Light' })).toBeChecked();
  await expect(html).toHaveAttribute('data-theme', 'light');
  // Light holds even when the computer is dark.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(group.getByRole('radio', { name: 'Light' })).toBeChecked();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(250, 250, 249)');

  // System again: the preference is forgotten and the computer's setting rules.
  await group.getByRole('radio', { name: 'System' }).check();
  await expect(html).not.toHaveAttribute('data-theme', /.*/);
  expect(await page.evaluate(() => localStorage.getItem('ct-theme'))).toBeNull();
  await expect(panel(page)).toContainText('which is dark right now');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 16, 18)');
});

test('keyboard-only: tabs, switch and confirm', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  await app.goto('#/settings?tab=agent');
  await agentReady(page);
  // Into the tab list, then across to Sending with the arrow keys.
  await tabTo(page, tab(page, 'Agent'));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Sending')).toBeFocused();
  await expect(emailSwitch(page)).toBeVisible();
  // Tab moves into the panel and on to the switch; Space asks, Enter confirms.
  await tabTo(page, emailSwitch(page));
  await page.keyboard.press('Space');
  await expect(confirmBox(page)).toBeVisible();
  await expect(confirmBox(page).getByRole('button', { name: 'Turn on' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(region(page, 'Email').locator('.st-msg')).toHaveText('Email auto-send is on.');
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await expect(emailSwitch(page)).toBeFocused();
  await expect.poll(async () => (await getJSON(request, server, '/api/status')).auto_send).toBe(true);
  // Off again with Space: no confirm.
  await page.keyboard.press('Space');
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await getJSON(request, server, '/api/status')).auto_send).toBe(false);
  // The cap takes typing and Enter.
  await tabTo(page, region(page, 'Email').getByLabel('Daily cap'));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('25');
  await page.keyboard.press('Enter');
  await expect(region(page, 'Email').locator('.st-msg')).toHaveText('Saved. Up to 25 emails a day.');
  await resetSending(request, server);
});

test('hostile text from the server renders as text', async ({ app, page }) => {
  const evil = '<img src=x onerror=window.__xss=1>';
  await patchStatus(page, (s) => ({
    ...s,
    agents: s.agents.map((a) => (a.kind === 'codex' ? { ...a, label: `${evil} CLI` } : a)),
    osint: { the_harvester: false, the_harvester_can_install: true, spiderfoot: false, spiderfoot_can_install: true, pipx: true },
  }));
  await page.route('**/api/onboarding/osint/install', (route) =>
    route.fulfill({ json: { ok: false, message: '<img src=x onerror=window.__xss=2> failed' } }),
  );
  await page.route('**/api/discovery/canonical/connect', (route) =>
    route.fulfill({ json: { ok: false, message: '<b>nope</b><img src=x onerror=window.__xss=3>' } }),
  );
  await app.goto('#/settings?tab=agent');
  await expect(panel(page).locator('.ap-card[data-kind="codex"] .ap-name')).toHaveText(`${evil} CLI`);

  await tab(page, 'Enrichment').click();
  await region(page, 'SpiderFoot').getByRole('button', { name: 'Install SpiderFoot' }).click();
  await expect(region(page, 'SpiderFoot').locator('.st-msg')).toHaveText('<img src=x onerror=window.__xss=2> failed');

  await tab(page, 'Connections').click();
  await region(page, 'Canonical').getByRole('button', { name: 'Reconnect' }).click();
  await expect(region(page, 'Canonical').locator('.st-msg')).toHaveText('<b>nope</b><img src=x onerror=window.__xss=3>');

  expect(await view(page).locator('img, b').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('every tab is accessible in light and dark and fits a phone', async ({ app, page, request, server }) => {
  await resetSending(request, server);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [i, id] of TABS.entries()) {
      await app.goto(`#/settings?tab=${id}`);
      await expect(tab(page, TAB_LABELS[i])).toHaveAttribute('aria-selected', 'true');
      if (id === 'agent') {
        await agentReady(page);
        await panel(page).getByRole('combobox', { name: 'Model' }).click();
        await expect(panel(page).getByRole('option').first()).toBeVisible();
        await page.keyboard.press('Escape');
      }
      if (id === 'connections') {
        await expect(region(page, 'Gmail')).toBeVisible();
        await region(page, 'Gmail').getByText('How to get an app password').click();
        await region(page, 'Gmail').getByText('More options').click();
      }
      if (id === 'sending') {
        await expect(emailSwitch(page)).toBeVisible();
        // A refused value shows its inline error.
        await region(page, 'Email').getByLabel('Daily cap').fill('0');
        await region(page, 'Email').getByLabel('Daily cap').press('Enter');
        await expect(region(page, 'Email').locator('.field-error')).toBeVisible();
      }
      if (id === 'enrichment') await expect(region(page, 'theHarvester')).toBeVisible();
      if (id === 'appearance') await expect(panel(page).getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
      await expectAccessible(page);
    }
    // The confirm dialog too.
    await app.goto('#/settings?tab=sending');
    await emailSwitch(page).click();
    await expect(confirmBox(page)).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press('Escape');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [i, id] of TABS.entries()) {
      await app.goto(`#/settings?tab=${id}`);
      await expect(tab(page, TAB_LABELS[i])).toHaveAttribute('aria-selected', 'true');
      if (id === 'agent') {
        await agentReady(page);
        await panel(page).locator('.ap-card[data-kind="openai"] .ap-pick').click();
      }
      if (id === 'connections') await region(page, 'Gmail').getByText('More options').click();
      if (id === 'sending') {
        await expect(linkedinSwitch(page)).toBeVisible();
        // The usage line wraps between its parts, never inside one.
        const parts = region(page, 'LinkedIn').locator('.st-usage-part');
        await expect(parts).toHaveCount(2);
        expect(await parts.evaluateAll((els) => els.map((el) => el.getClientRects().length))).toEqual([1, 1]);
      }
      if (id === 'enrichment') await expect(region(page, 'SpiderFoot')).toBeVisible();
      if (id === 'appearance') await expect(panel(page).getByRole('radio', { name: 'Dark' })).toBeVisible();
      await expectNoSideScroll(page, 390);
      // The tabs scroll sideways here: a deep link brings its tab into view.
      await expect.poll(() => selectedTabInView(page)).toBe(true);
      await expectAccessible(page);
    }
  }
  // The edge with more tabs fades (tabs.js marks it): the start from Appearance, the end from
  // Agent, both when scrolled part way.
  await expect(tabList(page)).toHaveAttribute('data-more', 'start');
  await tab(page, 'Agent').click();
  await expect.poll(() => selectedTabInView(page)).toBe(true);
  await expect(tabList(page)).toHaveAttribute('data-more', 'end');
  await tabList(page).evaluate((list) => {
    list.scrollLeft = (list.scrollWidth - list.clientWidth) / 2;
  });
  await expect(tabList(page)).toHaveAttribute('data-more', 'start end');
  await tab(page, 'Sending').click();
  await expect.poll(() => selectedTabInView(page)).toBe(true);

  // The menu still opens at phone width.
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

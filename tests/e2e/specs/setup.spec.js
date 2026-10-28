// First-run setup (spec §5.1) on an empty workspace: the four steps (agent with the opencode model
// picker and Test connection, Canonical, the company profile, where outreach goes) and the
// "You're set" screen; Continue gating; the address (a bare #/setup stays bare, a step that isn't
// open yet names the one shown); copy buttons; keyboard-only completion; loading, error and
// stale-session states; saves that outlive the step; the outreach copy following auto-send; the
// LinkedIn poll stopping on unmount; hostile text staying text; and the exported agentPanel
// working outside the wizard (Settings reuses it).
//
// Tests share one server and run in order: the early ones leave the workspace as they found it,
// "walks all four steps to Home" onboards it, and the later ones build on that.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { PRODUCT_MD } from '../harness/seed.mjs';
import { SESSION_EXPIRED } from '../../../ui/js/core/api.js';
import { fmtNum } from '../../../ui/js/core/format.js';

test.use({ seed: 'empty' });

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashIs = (hash) => new RegExp(`${reEscape(hash)}$`);

const TITLES = {
  agent: 'Choose your agent',
  canonical: 'Connect Canonical',
  company: 'Describe your company',
  destination: 'Choose where outreach goes',
  done: "You're set",
};
const TEMPLATE_CTA = '## Call to Action\n- Link: https://yourproduct.com/?utm_content={slug}';

const view = (page) => page.locator('#view');
const stepTitle = (page, step) => view(page).getByRole('heading', { level: 2, name: TITLES[step], exact: true });
const card = (page, kind) => view(page).locator(`.ap-card[data-kind="${kind}"]`);
const pick = (page, kind) => card(page, kind).locator('.ap-pick');
const foot = (page) => view(page).locator('.setup-foot');
const continueBtn = (page) => foot(page).getByRole('button', { name: 'Continue', exact: true });
const statusPath = (url) => url.pathname === '/api/status';

/** GET a token-guarded API path from the test (not the page). */
async function getJSON(request, server, path) {
  const res = await request.get(server.apiUrl(path));
  expect(res.status(), `GET ${path}: ${await res.text()}`).toBe(200);
  return res.json();
}

/**
 * Store the fake (never used) Canonical token the harness's onboarded seed writes, in this
 * server's sandboxed secrets file: what a finished Canonical OAuth leaves behind.
 */
function storeCanonicalToken(server) {
  mkdirSync(server.secretsDir, { recursive: true });
  const file = join(server.secretsDir, 'secrets.toml');
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (prev.includes('[tokens.canonical]')) return;
  writeFileSync(
    file,
    `${prev.trimEnd()}\n\n[tokens.canonical]\naccess = "e2e-fake-canonical-access-token"\n` +
      'token_endpoint = "https://canonical.invalid/oauth/token"\nclient_id = "coldtrail-e2e"\n',
    { mode: 0o600 },
  );
}

/**
 * The real Canonical connect ends by storing an OAuth token; the intercepted one can't, so the
 * test stores it and answers the request the way the intercept does.
 */
async function connectCanonicalLikeOAuth(page, server, calls) {
  await page.route('**/api/discovery/canonical/connect', async (route) => {
    calls.push(route.request().postDataJSON());
    storeCanonicalToken(server);
    await route.fulfill({ json: { ok: true, message: null } });
  });
}

/**
 * Make the workspace onboarded whatever ran before (a failed test restarts the worker, and with
 * it the server): opencode as the agent, a Canonical token, and a company profile unless one
 * is set. The same files the harness's `onboarded` seed writes, in this server's sandbox.
 */
async function onboard(request, server, { profile = true } = {}) {
  const res = await request.post(server.apiUrl('/api/onboarding/provider'), { data: { provider: 'opencode' } });
  expect(res.status()).toBe(200);
  storeCanonicalToken(server);
  const file = join(server.home, 'product.md');
  if (profile && !(existsSync(file) && readFileSync(file, 'utf8').trim())) writeFileSync(file, PRODUCT_MD);
}

/** Press Tab (Shift+Tab with back) until `target` has focus; fails after `max` presses. */
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

test('first load shows a loading state, then step 1 of 4', async ({ app, page }) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(statusPath, async (route) => {
    await held;
    await route.fallback();
  });
  await app.goto('#/setup');
  // The shell waits up to 3s for a first status, then mounts the screen without one.
  const loading = view(page).getByRole('status').filter({ hasText: 'Loading setup' });
  await expect(loading).toBeVisible({ timeout: 15_000 });
  await expect(view(page).locator('h1')).toHaveText('Setup');
  release();

  await expect(stepTitle(page, 'agent')).toBeVisible();
  await expect(loading).toHaveCount(0);
  // A bare #/setup on a fresh workspace starts at step 1 and keeps its address (the app sends an
  // unfinished workspace to #/setup and expects it to stay there).
  await expect(page).toHaveURL(hashIs('#/setup'));
  await expect(view(page).getByText('Step 1 of 4', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Setup · coldtrail');
  // Full page: no sidebar, no top bar.
  await expect(page.locator('#nav')).toBeHidden();
  await expect(page.locator('#topbar')).toBeHidden();

  const progress = view(page).getByRole('navigation', { name: 'Setup progress' });
  await expect(progress.getByRole('listitem')).toHaveText([/Agent/, /Canonical/, /Company/, /Outreach/]);
  await expect(progress.locator('[aria-current="step"]')).toContainText('Agent');
  // Steps that need an earlier one first aren't links yet.
  await expect(progress.getByRole('link')).toHaveCount(0);

  // The four agent cards, in order, with their state.
  await expect(view(page).locator('.ap-card .ap-name')).toHaveText(['Claude Code', 'Codex CLI', 'opencode', 'Your own model']);
  await expect(pick(page, 'opencode')).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page, 'opencode').locator('.badge')).toHaveText('Ready');
  await expect(card(page, 'claude').locator('.badge')).toHaveText('Sign in needed');
  await expect(card(page, 'openai').locator('.badge')).toHaveText('Not set up');
  // Each card reads as its name and state, with the blurb as its description.
  await expect(pick(page, 'opencode')).toHaveAccessibleName('opencode Ready');
  await expect(pick(page, 'opencode')).toHaveAccessibleDescription(/Open-source agent/);
  // The configured opencode is present, so step 1 can continue; there's nowhere to go back to.
  await expect(continueBtn(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(foot(page).getByRole('button', { name: 'Back' })).toHaveCount(0);
});

test('status that fails to load shows the error and a retry', async ({ app, page }) => {
  app.allowConsole(/status of 500/);
  let fail = true;
  await page.route(statusPath, (route) =>
    fail ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'workspace is not readable' }) : route.fallback(),
  );
  await app.goto('#/setup');
  const alert = view(page).getByRole('alert').filter({ hasText: 'workspace is not readable' });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText("Setup couldn't load");
  fail = false;
  await view(page).getByRole('button', { name: 'Try again' }).click();
  await expect(stepTitle(page, 'agent')).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('stale session shows the session message once', async ({ app, page, context }) => {
  app.allowConsole(/status of 401/);
  await app.goto('#/setup');
  await expect(stepTitle(page, 'agent')).toBeVisible();
  // An old tab after a restart: the cookie no longer matches (here: it's gone).
  await context.clearCookies();
  await page.reload();
  const errorCard = view(page).locator('.setup-error');
  await expect(errorCard).toContainText("Setup couldn't load", { timeout: 15_000 });
  await expect(errorCard).toContainText('Reopen coldtrail from your terminal.');
  await expect(page.locator('.session-banner')).toHaveText(SESSION_EXPIRED);
  // The banner says it, once and as the only alert; the card can't retry until the tab is reopened.
  const body = await page.locator('body').innerText();
  expect(body.split(SESSION_EXPIRED).length - 1).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(errorCard.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page);
  }
});

test('copy buttons put the login command on the clipboard', async ({ app, page, context, server }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
  await app.goto('#/setup/agent');
  await expect(stepTitle(page, 'agent')).toBeVisible();
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  // Present but signed out: the sign-in command, with a copy button.
  await expect(card(page, 'codex').locator('.badge')).toHaveText('Sign in needed');
  await expect(card(page, 'codex').locator('code')).toHaveText('codex login');
  await card(page, 'codex').getByRole('button', { name: 'Copy “codex login”' }).click();
  await expect(card(page, 'codex').getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await clipboard()).toBe('codex login');

  await expect(card(page, 'claude').locator('code')).toHaveText('claude');
  await expect(card(page, 'claude')).toContainText('then type /login');
  await card(page, 'claude').getByRole('button', { name: 'Copy “claude”' }).click();
  expect(await clipboard()).toBe('claude');
  // A signed-in agent shows no command.
  await expect(card(page, 'opencode').locator('code')).toHaveCount(0);

  // Not installed: the install command instead, and the card can't be chosen.
  await page.route(statusPath, async (route) => {
    const res = await route.fetch();
    const status = await res.json();
    status.agents = status.agents.map((a) => (a.kind === 'codex' ? { ...a, present: false, authed: false } : a));
    await route.fulfill({ response: res, json: status });
  });
  await view(page).getByRole('button', { name: 'Check again' }).click();
  await expect(card(page, 'codex').locator('.badge')).toHaveText('Not installed');
  await expect(card(page, 'codex').locator('code')).toHaveText('npm i -g @openai/codex');
  await expect(pick(page, 'codex')).toHaveAttribute('aria-disabled', 'true');
  await card(page, 'codex').getByRole('button', { name: 'Copy “npm i -g @openai/codex”' }).click();
  expect(await clipboard()).toBe('npm i -g @openai/codex');
  await pick(page, 'codex').click({ force: true });
  await expect(pick(page, 'codex')).toHaveAttribute('aria-pressed', 'false');
  await expect(pick(page, 'opencode')).toHaveAttribute('aria-pressed', 'true');
});

test('model list loading, empty and error states fall back to free text', async ({ app, page, request, server }) => {
  app.allowConsole(/status of 500/);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/provider/opencode/models', async (route) => {
    await held;
    await route.fulfill({ json: { models: [], message: "opencode isn't installed or didn't respond" } });
  });
  await app.goto('#/setup/agent');
  const model = view(page).getByRole('combobox', { name: 'Model' });
  const hint = view(page).locator('.ap-model .field-hint');
  await expect(model).toHaveValue('fake/model-a');
  await expect(hint).toContainText('Loading the models opencode can use');
  release();
  await expect(hint).toContainText("opencode isn't installed or didn't respond");
  await expect(hint).toContainText('Type a model id');

  // Free text still saves.
  await model.fill('custom/model-x');
  await model.press('Enter');
  await expect(view(page).locator('.ap-model [role="status"]')).toHaveText('Model saved');
  expect((await getJSON(request, server, '/api/status')).opencode_model).toBe('custom/model-x');

  // A failed listing says so, and typing still works.
  await page.unroute('**/api/provider/opencode/models');
  await page.route('**/api/provider/opencode/models', (route) =>
    route.fulfill({ status: 500, contentType: 'text/plain', body: 'models exploded' }),
  );
  await page.reload();
  await expect(model).toHaveValue('custom/model-x');
  await expect(hint).toContainText("Couldn't load the model list: models exploded");

  // Clearing it goes back to opencode's default; then restore the seeded model.
  await view(page).getByRole('button', { name: 'Clear Model' }).click();
  await expect(view(page).locator('.ap-model [role="status"]')).toHaveText("Using opencode's default model");
  expect((await getJSON(request, server, '/api/status')).opencode_model).toBeNull();
  await model.fill('fake/model-a');
  await model.press('Enter');
  await expect(view(page).locator('.ap-model [role="status"]')).toHaveText('Model saved');
  expect((await getJSON(request, server, '/api/status')).opencode_model).toBe('fake/model-a');
});

test('a model typed just before Continue still saves', async ({ app, page, request, server }) => {
  // Hold the save, as a slow server would, so leaving the step can't outrun it.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const saves = [];
  await page.route('**/api/onboarding/provider', async (route) => {
    saves.push(route.request().postDataJSON());
    await held;
    await route.fallback();
  });
  await app.goto('#/setup/agent');
  const model = view(page).getByRole('combobox', { name: 'Model' });
  await expect(model).toHaveValue('fake/model-a');
  await model.fill('custom/typed-model');
  // Continue at once: leaving the field sends the save, and Continue waits for it to land.
  await continueBtn(page).click();
  await expect.poll(() => saves.length).toBe(1);
  await expect(continueBtn(page)).toHaveAttribute('aria-busy', 'true');
  await expect(stepTitle(page, 'agent')).toBeVisible();
  release();
  await expect(stepTitle(page, 'canonical')).toBeVisible();
  await expect(page).toHaveURL(hashIs('#/setup/canonical'));
  expect(saves).toEqual([{ provider: 'opencode', opencode_model: 'custom/typed-model' }]);
  expect((await getJSON(request, server, '/api/status')).opencode_model).toBe('custom/typed-model');

  // Put the seeded model back for the tests after this one.
  const res = await request.post(server.apiUrl('/api/onboarding/provider'), {
    data: { provider: 'opencode', opencode_model: 'fake/model-a' },
  });
  expect(res.status()).toBe(200);
});

test('your own model: the form checks the URL, saves, tests and switches back', async ({ app, page, request, server }) => {
  const probes = [];
  // The probe would call the endpoint for real (it may be a live local Ollama): answer it here.
  await page.route('**/api/provider/probe', async (route) => {
    probes.push(route.request().method());
    await route.fulfill({ json: { ok: true, message: 'Your model is signed in and responding.' } });
  });
  await app.goto('#/setup/agent');
  await pick(page, 'openai').click();
  await expect(pick(page, 'openai')).toHaveAttribute('aria-pressed', 'true');
  const form = view(page).getByRole('form', { name: 'Your own model' });
  await expect(form).toBeVisible();
  // Nothing saved yet: the agent in use doesn't change, and says so.
  await expect(form).toContainText('coldtrail keeps using opencode until you save');
  await expect(view(page).getByRole('button', { name: 'Test connection' })).toHaveCount(0);

  const base = form.getByLabel('Base URL');
  await base.fill('localhost:11434');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(base).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('.field-error')).toHaveText('Enter a URL that starts with http:// or https://.');
  await expect(base).toBeFocused();

  await base.fill('');
  await form.getByRole('button', { name: 'Use local Ollama' }).click();
  await expect(base).toHaveValue('http://localhost:11434/v1');
  await expect(form.getByLabel('Model')).toHaveValue('llama3.1');
  await expect(form.locator('.field-error')).toBeHidden();
  await expect(base).not.toHaveAttribute('aria-invalid', /.*/);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('status')).toHaveText('Saved. coldtrail now uses your own model.');
  await expect(card(page, 'openai').locator('.badge')).toHaveText('Configured');
  const saved = await getJSON(request, server, '/api/status');
  expect(saved.provider).toBe('openai');
  expect(saved.base_url).toBe('http://localhost:11434/v1');
  expect(saved.model).toBe('llama3.1');
  expect(saved.key_set).toBe(false);

  await view(page).getByRole('button', { name: 'Test connection' }).click();
  await expect(view(page).locator('.ap-test-result')).toHaveText('Your model is signed in and responding.');
  expect(probes).toEqual(['POST']);

  // Back to opencode: one click saves it, and its model pin is kept.
  await pick(page, 'opencode').click();
  await expect(pick(page, 'opencode')).toHaveAttribute('aria-pressed', 'true');
  await expect(form).toBeHidden();
  await expect(view(page).getByRole('combobox', { name: 'Model' })).toHaveValue('fake/model-a');
  const back = await getJSON(request, server, '/api/status');
  expect(back.provider).toBe('opencode');
  expect(back.opencode_model).toBe('fake/model-a');
  // The endpoint stays saved for later: the card says so, and reopening it shows the URL.
  expect(back.base_url).toBe('http://localhost:11434/v1');
  await expect(card(page, 'openai').locator('.badge')).toHaveText('Saved');
  await page.reload();
  await expect(card(page, 'openai').locator('.badge')).toHaveText('Saved');
  await pick(page, 'openai').click();
  await expect(form.getByLabel('Base URL')).toHaveValue('http://localhost:11434/v1');
});

test('walks all four steps to Home', async ({ app, page, request, server }) => {
  const canonicalCalls = [];
  await connectCanonicalLikeOAuth(page, server, canonicalCalls);
  await app.goto('#/setup');
  await expect(stepTitle(page, 'agent')).toBeVisible();
  await expect(page).toHaveURL(hashIs('#/setup'));

  // 1 · Agent: choose opencode, pick a model from its list, test the connection.
  await pick(page, 'opencode').click();
  await expect(pick(page, 'opencode')).toHaveAttribute('aria-pressed', 'true');
  const model = view(page).getByRole('combobox', { name: 'Model' });
  await expect(model).toHaveValue('fake/model-a');
  await model.click();
  await expect(view(page).getByRole('option', { name: 'fake/model-a' })).toBeVisible();
  await expect(view(page).getByRole('option')).toHaveText(['fake/model-a', 'fake/model-b', 'opencode/free-c']);
  await view(page).getByRole('option', { name: 'fake/model-b' }).click();
  await expect(model).toHaveValue('fake/model-b');
  await expect(view(page).locator('.ap-model [role="status"]')).toHaveText('Model saved');
  expect((await getJSON(request, server, '/api/status')).opencode_model).toBe('fake/model-b');

  const test_ = view(page).getByRole('button', { name: 'Test connection' });
  await test_.click();
  await expect(view(page).locator('.ap-test-result')).toHaveText('opencode is signed in and responding.', { timeout: 30_000 });
  await expect(test_).toBeEnabled();
  await continueBtn(page).click();

  // 2 · Canonical: required; connecting turns it into Connected.
  await expect(page).toHaveURL(hashIs('#/setup/canonical'));
  await expect(stepTitle(page, 'canonical')).toBeFocused();
  await expect(view(page).getByText('Step 2 of 4', { exact: true })).toBeVisible();
  await expect(continueBtn(page)).toHaveAttribute('aria-disabled', 'true');
  await view(page).getByRole('button', { name: 'Connect Canonical' }).click();
  await expect(view(page).locator('.setup-conn .badge')).toHaveText('Connected');
  expect(canonicalCalls).toEqual([{}]);
  await expect(view(page).getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await expect(continueBtn(page)).not.toHaveAttribute('aria-disabled', 'true');
  // The first steps are now links back.
  await expect(view(page).getByRole('navigation', { name: 'Setup progress' }).getByRole('link')).toHaveCount(1);
  // Back returns to the bare #/setup and the step it showed (not the next gap, Company);
  // forward comes back here.
  await page.goBack();
  await expect(page).toHaveURL(hashIs('#/setup'));
  await expect(stepTitle(page, 'agent')).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(hashIs('#/setup/canonical'));
  await expect(stepTitle(page, 'canonical')).toBeVisible();
  await continueBtn(page).click();

  // 3 · Company: the corrected template is there to fill in; it autosaves.
  await expect(page).toHaveURL(hashIs('#/setup/company'));
  const profile = view(page).getByRole('textbox', { name: 'Company profile' });
  await expect(profile).toHaveValue(new RegExp(reEscape(TEMPLATE_CTA)));
  await expect(continueBtn(page)).toHaveAttribute('aria-disabled', 'true');
  await profile.fill(PRODUCT_MD);
  await expect(view(page).locator('.setup-save')).toHaveText('Saved');
  await expect(continueBtn(page)).not.toHaveAttribute('aria-disabled', 'true');
  await continueBtn(page).click();
  expect(readFileSync(join(server.home, 'product.md'), 'utf8')).toBe(PRODUCT_MD);

  // 4 · Where outreach goes: skip it.
  await expect(page).toHaveURL(hashIs('#/setup/destination'));
  await expect(view(page).getByText('Step 4 of 4', { exact: true })).toBeVisible();
  await expect(continueBtn(page)).toHaveCount(0);
  await foot(page).getByRole('button', { name: 'Skip for now' }).click();

  // You're set: two suggested next steps, then Home.
  await expect(page).toHaveURL(hashIs('#/setup/done'));
  await expect(stepTitle(page, 'done')).toBeFocused();
  const agentLink = view(page).getByRole('link', { name: /Find your first companies/ });
  await expect(agentLink).toHaveAttribute('href', /^#\/agent\?prompt=.+/);
  await expect(view(page).getByRole('link', { name: /Create a schedule/ })).toHaveAttribute('href', '#/schedules');
  await expect(view(page)).toContainText("Gmail and LinkedIn aren't connected yet");
  const status = await getJSON(request, server, '/api/status');
  expect(status.onboarded).toBe(true);
  await view(page).getByRole('button', { name: 'Go to Home' }).click();
  await expect(page).toHaveURL(hashIs('#/home'));
  await expect(page.locator('.setup')).toHaveCount(0);
  await expect(page.locator('#nav')).toBeVisible();
});

test('cannot continue without a provider/profile', async ({ app, page, request, server }) => {
  await onboard(request, server);
  writeFileSync(join(server.home, 'product.md'), PRODUCT_MD);
  // No agent CLI on this machine and no own model saved.
  await page.route(statusPath, async (route) => {
    const res = await route.fetch();
    const status = await res.json();
    status.provider = 'claude';
    status.agents = status.agents.map((a) => ({ ...a, present: false, authed: false }));
    status.onboarded = false;
    await route.fulfill({ response: res, json: status });
  });
  await app.goto('#/setup/agent');
  await expect(stepTitle(page, 'agent')).toBeVisible();
  for (const kind of ['claude', 'codex', 'opencode']) {
    await expect(card(page, kind).locator('.badge')).toHaveText('Not installed');
  }
  const hint = foot(page).locator('.setup-hint');
  await expect(continueBtn(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(hint).toHaveText('Choose an installed agent, or save your own model, to continue.');
  await continueBtn(page).click({ force: true });
  await expect(page).toHaveURL(hashIs('#/setup/agent'));
  await expect(hint).toHaveClass(/is-error/);
  // Later steps can't be reached by URL either: the address names the step shown, and asking
  // again is a real change for the router (it sends the address back again).
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => {
      location.hash = '#/setup/company';
    });
    await expect(page).toHaveURL(hashIs('#/setup/agent'));
    await expect(stepTitle(page, 'agent')).toBeVisible();
  }
  await page.unroute(statusPath);

  // An emptied profile can't continue (and the empty profile is what's saved).
  await app.goto('#/setup/company');
  const profile = view(page).getByRole('textbox', { name: 'Company profile' });
  await expect(profile).toHaveValue(PRODUCT_MD);
  await profile.fill('');
  await expect(view(page).locator('.setup-save')).toHaveText('Saved');
  await expect(continueBtn(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(hint).toHaveText('Write a few lines about your company to continue.');
  await continueBtn(page).click({ force: true });
  await expect(page).toHaveURL(hashIs('#/setup/company'));
  await expect(hint).toHaveClass(/is-error/);
  expect((await getJSON(request, server, '/api/status')).product_set).toBe(false);

  // An untouched template doesn't count either.
  await page.reload();
  await expect(profile).toHaveValue(new RegExp(reEscape(TEMPLATE_CTA)));
  await expect(continueBtn(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(hint).toHaveText("Fill in the template with your company's details to continue.");

  // Typed into and undone, the template is what's saved, and the workspace counts it as set:
  // Continue agrees with that (and the progress row), with a note that it's still blank.
  const template = await profile.inputValue();
  await profile.fill(`${template}x`);
  await expect(view(page).locator('.setup-save')).toHaveText('Saved');
  await profile.fill(template);
  await expect(view(page).locator('.setup-save')).toHaveText('Saved');
  await expect(continueBtn(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(hint).toHaveText('This is still the blank template. Drafts stay generic until you fill it in.');
  await expect(hint).not.toHaveClass(/is-error/);
  expect((await getJSON(request, server, '/api/status')).product_set).toBe(true);
});

test('keyboard-only completion', async ({ app, page, request, server }) => {
  await onboard(request, server, { profile: false });
  await app.goto('#/setup/agent');
  await expect(stepTitle(page, 'agent')).toBeVisible();

  // 1 · Agent
  await tabTo(page, pick(page, 'opencode'));
  await page.keyboard.press('Space');
  await expect(pick(page, 'opencode')).toHaveAttribute('aria-pressed', 'true');
  await tabTo(page, continueBtn(page));
  await page.keyboard.press('Enter');

  // 2 · Canonical (connected earlier): focus lands on the step's title.
  await expect(stepTitle(page, 'canonical')).toBeFocused();
  await tabTo(page, continueBtn(page));
  await page.keyboard.press('Enter');

  // 3 · Company: replace the template by typing.
  await expect(stepTitle(page, 'company')).toBeFocused();
  const profile = view(page).getByRole('textbox', { name: 'Company profile' });
  await tabTo(page, profile);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('# Fieldnote\n\nWe turn call notes into follow-up plans.');
  await tabTo(page, continueBtn(page));
  await page.keyboard.press('Enter');

  // 4 · Skip, then Home.
  await expect(stepTitle(page, 'destination')).toBeFocused();
  await tabTo(page, foot(page).getByRole('button', { name: 'Skip for now' }));
  await page.keyboard.press('Enter');
  await expect(stepTitle(page, 'done')).toBeFocused();
  await tabTo(page, view(page).getByRole('button', { name: 'Go to Home' }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(hashIs('#/home'));
  const status = await getJSON(request, server, '/api/status');
  expect(status.product_set).toBe(true);
  expect(status.onboarded).toBe(true);
  expect(readFileSync(join(server.home, 'product.md'), 'utf8')).toBe('# Fieldnote\n\nWe turn call notes into follow-up plans.');
});

test('a profile that fails to load says so and can be retried', async ({ app, page, request, server }) => {
  app.allowConsole(/status of 500/);
  await onboard(request, server);
  let fail = true;
  await page.route('**/api/company', (route) =>
    fail && route.request().method() === 'GET'
      ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'product.md is unreadable' })
      : route.fallback(),
  );
  await app.goto('#/setup/company');
  await expect(stepTitle(page, 'company')).toBeVisible();
  await expect(view(page).getByRole('alert')).toContainText("Couldn't load your profile: product.md is unreadable");
  // The footer gives the reason Continue waits, not a load that has already ended.
  const hint = foot(page).locator('.setup-hint');
  await expect(hint).toHaveText("Your profile didn't load. Try again above.");
  await expect(continueBtn(page)).toHaveAttribute('aria-disabled', 'true');

  fail = false;
  await view(page).getByRole('button', { name: 'Try again' }).click();
  const profile = view(page).getByRole('textbox', { name: 'Company profile' });
  await expect(profile).toHaveValue(readFileSync(join(server.home, 'product.md'), 'utf8'));
  await expect(view(page).getByRole('alert')).toHaveCount(0);
  await expect(continueBtn(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expect(hint).toHaveText('');
});

test('a stale first status opens the asked-for step once fresh status arrives', async ({ app, page, request, server }) => {
  await onboard(request, server);
  // The app's first status says Canonical and the profile aren't done (the store's copy can be
  // up to 30s old); the fresh one Setup asks for next is held until the address has moved.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let n = 0;
  await page.route(statusPath, async (route) => {
    n += 1;
    if (n === 1) {
      const res = await route.fetch();
      const status = await res.json();
      await route.fulfill({ response: res, json: { ...status, discovery_connected: false, product_set: false, onboarded: false } });
      return;
    }
    if (n === 2) await held;
    await route.fallback();
  });
  await app.goto('#/setup/company');
  await expect(stepTitle(page, 'canonical')).toBeVisible();
  await expect(page).toHaveURL(hashIs('#/setup/canonical'));
  release();
  // Fresh status: the asked-for step opens, and the address names it again.
  await expect(stepTitle(page, 'company')).toBeVisible();
  await expect(page).toHaveURL(hashIs('#/setup/company'));
  // The router knows the address moved: going to Canonical by URL is a real change.
  await page.evaluate(() => {
    location.hash = '#/setup/canonical';
  });
  await expect(stepTitle(page, 'canonical')).toBeVisible();
});

test('outreach step connects Gmail with an app password and LinkedIn', async ({ app, page, request, server }) => {
  await onboard(request, server);
  await app.goto('#/setup/destination');
  await expect(stepTitle(page, 'destination')).toBeVisible();
  const gmail = view(page).getByRole('region', { name: 'Gmail' });
  const linkedin = view(page).getByRole('region', { name: 'LinkedIn' });
  await expect(gmail.locator('.badge').first()).toHaveText('Not connected');
  // Auto-send is off: LinkedIn requests open for the user to send.
  await expect(linkedin.locator('.setup-conn-note')).toHaveText(
    "coldtrail opens each connection request in a LinkedIn window for you to review and send. Connecting opens Chrome at LinkedIn's sign-in page.",
  );

  // Gmail: inline validation, then the (intercepted) app-password check.
  await gmail.getByRole('button', { name: 'Connect Gmail' }).click();
  await expect(gmail.locator('.setup-msg')).toHaveText('Enter your Gmail address and the app password.');
  await expect(gmail.getByLabel('Gmail address', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(app.calls).toEqual([]);
  await gmail.getByLabel('Gmail address', { exact: true }).fill('dee@example.com');
  await gmail.getByLabel('App password', { exact: true }).fill('abcd efgh ijkl mnop');
  await gmail.getByLabel('App password', { exact: true }).press('Enter');
  await expect(gmail.locator('.badge').first()).toHaveText('Connected');
  await expect(gmail).toContainText('coldtrail saves each email as a draft in your Gmail');
  expect(app.calls).toEqual([
    { method: 'POST', path: '/api/destination/gmail/app-password', body: { email: 'dee@example.com', app_password: 'abcd efgh ijkl mnop' } },
  ]);
  // Something is connected, so the step continues instead of skipping.
  await expect(continueBtn(page)).toBeVisible();
  await expect(foot(page).getByRole('button', { name: 'Skip for now' })).toHaveCount(0);

  // The own-OAuth-client path checks for a client id before saving anything.
  await gmail.getByText('Use different credentials').click();
  await gmail.getByText('More options').click();
  await gmail.getByRole('button', { name: 'Save and connect' }).click();
  await expect(gmail.locator('.setup-msg')).toHaveText('Paste your client ID first.');

  // LinkedIn: the sign-in window never opens here, so the server reports it isn't waiting:
  // the card says the sign-in didn't finish instead of waiting forever.
  await linkedin.getByRole('button', { name: 'Connect LinkedIn' }).click();
  await expect(linkedin.locator('.setup-msg')).toHaveText("LinkedIn sign-in didn't finish: the window was closed or it timed out. Try again.", { timeout: 15_000 });
  await expect(linkedin.getByRole('button', { name: 'Connect LinkedIn' })).toBeEnabled();

  // Busy browser.
  await page.route('**/api/destination/linkedin/connect', (route) => route.fulfill({ json: { status: 'busy' } }));
  await linkedin.getByRole('button', { name: 'Connect LinkedIn' }).click();
  await expect(linkedin.locator('.setup-msg')).toHaveText('Chrome is busy with another LinkedIn task. Try again in a moment.');
  await page.unroute('**/api/destination/linkedin/connect');

  // A sign-in that finishes: waiting, then connected.
  let finished = false;
  await page.route('**/api/destination/linkedin/status', (route) =>
    route.fulfill({ json: { connected: finished, reconnect_needed: false, waiting: !finished } }),
  );
  await linkedin.getByRole('button', { name: 'Connect LinkedIn' }).click();
  await expect(linkedin.locator('.badge').first()).toHaveText('Waiting for sign-in');
  await expect(linkedin.locator('.setup-msg')).toContainText('Sign in to LinkedIn in the Chrome window');
  finished = true;
  await expect(linkedin.locator('.badge').first()).toHaveText('Connected', { timeout: 15_000 });
  await expect(linkedin.locator('.setup-msg')).toHaveText('LinkedIn is connected.');

  await continueBtn(page).click();
  await expect(stepTitle(page, 'done')).toBeVisible();
  await expect(view(page)).not.toContainText("aren't connected yet");
});

test('outreach copy says what auto-send does', async ({ app, page, request, server }) => {
  await onboard(request, server);
  const caps = { daily_send_cap: 1500, linkedin_daily_cap: 1200, linkedin_weekly_cap: 4000 };
  let connected = false;
  await page.route(statusPath, async (route) => {
    try {
      const res = await route.fetch();
      const status = await res.json();
      await route.fulfill({
        response: res,
        json: {
          ...status,
          ...caps,
          auto_send: true,
          linkedin_auto_send: true,
          destination_connected: connected,
          linkedin_connected: connected,
          linkedin_reconnect_needed: false,
        },
      });
    } catch (err) {
      // A read that the reload (or the end of the test) cut off: nothing waits for it.
      if (!/disposed|closed|ended/i.test(String(err))) throw err;
    }
  });
  await app.goto('#/setup/destination');
  const gmail = view(page).getByRole('region', { name: 'Gmail' });
  const linkedin = view(page).getByRole('region', { name: 'LinkedIn' });
  const linkedinAuto =
    `Auto-send is on: coldtrail sends connection requests itself, up to ${fmtNum(caps.linkedin_daily_cap)} a day ` +
    `and ${fmtNum(caps.linkedin_weekly_cap)} a week. Change it in Settings → Sending.`;
  await expect(linkedin.locator('.setup-conn-note')).toHaveText(`${linkedinAuto} Connecting opens Chrome at LinkedIn's sign-in page.`);
  await expect(linkedin).not.toContainText('for you to review and send');

  connected = true;
  await page.reload();
  await expect(linkedin.locator('.badge').first()).toHaveText('Connected');
  await expect(linkedin.locator('.setup-conn-note')).toHaveText(linkedinAuto);
  await expect(gmail.locator('.setup-conn-note')).toHaveText(
    `Auto-send is on: Send on the Drafts screen emails people right away, up to ${fmtNum(caps.daily_send_cap)} a day. Change it in Settings → Sending.`,
  );
});

test('leaving setup stops the LinkedIn poll', async ({ app, page, request, server }) => {
  await onboard(request, server);
  await page.clock.install();
  // Count status polls in the page itself, so nothing is missed between steps.
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
  await app.goto('#/setup/destination');
  const linkedin = view(page).getByRole('region', { name: 'LinkedIn' });
  await linkedin.getByRole('button', { name: 'Connect LinkedIn' }).click();
  await expect(linkedin.locator('.badge').first()).toHaveText('Waiting for sign-in');
  await page.clock.runFor(2_100);
  await expect.poll(polls).toBeGreaterThanOrEqual(1);

  await page.evaluate(() => {
    location.hash = '#/home';
  });
  await expect(page.locator('.setup')).toHaveCount(0);
  const before = await polls();
  await page.clock.runFor(20_000);
  expect(await polls()).toBe(before);
});

test('agentPanel works outside the wizard', async ({ app, page, request, server }) => {
  await onboard(request, server);
  await app.goto('#/home');
  await expect(page.locator('#nav')).toBeVisible();
  await page.evaluate(async () => {
    document.getElementById('ap-sandbox')?.remove();
    const box = document.createElement('div');
    box.id = 'ap-sandbox';
    document.body.append(box);
    const { agentPanel } = await import('/assets/js/views/setup.js');
    window.__apChanges = [];
    window.__ap = agentPanel(box, { onChange: (status, change) => window.__apChanges.push([change.what, status.provider]) });
  });
  const box = page.locator('#ap-sandbox');
  // No status given: it fetches its own, and loads its own stylesheet.
  await expect(box.locator('.ap-card .ap-name')).toHaveText(['Claude Code', 'Codex CLI', 'opencode', 'Your own model']);
  await expect(page.locator('link[rel="stylesheet"][href="/assets/css/views/setup.css"]')).toHaveCount(1);
  expect(await box.locator('.ap-card').first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('8px');

  await box.locator('.ap-card[data-kind="codex"] .ap-pick').click();
  await expect(box.locator('.ap-card[data-kind="codex"] .ap-pick')).toHaveAttribute('aria-pressed', 'true');
  expect((await getJSON(request, server, '/api/status')).provider).toBe('codex');
  await box.locator('.ap-card[data-kind="opencode"] .ap-pick').click();
  await expect(box.getByRole('combobox', { name: 'Model' })).toBeVisible();
  expect(await page.evaluate(() => window.__apChanges)).toEqual([
    ['provider', 'codex'],
    ['provider', 'opencode'],
  ]);

  // update(status) re-renders from a status the host already has.
  await page.evaluate(async () => {
    const res = await fetch('/api/status');
    const status = await res.json();
    status.agents = status.agents.map((a) => (a.kind === 'claude' ? { ...a, authed: true } : a));
    window.__ap.update(status);
  });
  await expect(box.locator('.ap-card[data-kind="claude"] .badge')).toHaveText('Ready');

  // destroy() empties the root and stops it.
  await page.evaluate(() => window.__ap.destroy());
  await expect(box.locator('.ap')).toHaveCount(0);
});

test('hostile text from the server renders as text', async ({ app, page }) => {
  const evil = '<img src=x onerror=window.__xss=1>';
  await page.route(statusPath, async (route) => {
    const res = await route.fetch();
    const status = await res.json();
    status.agents = status.agents.map((a) => (a.kind === 'codex' ? { ...a, label: `${evil} CLI` } : a));
    await route.fulfill({ response: res, json: status });
  });
  await page.route('**/api/provider/opencode/models', (route) =>
    route.fulfill({ json: { models: [evil, 'fake/<b>bold</b>'], message: null } }),
  );
  await page.route('**/api/provider/probe', (route) =>
    route.fulfill({ json: { ok: false, message: `<img src=x onerror=window.__xss=2> failed` } }),
  );
  await app.goto('#/setup/agent');
  await expect(card(page, 'codex').locator('.ap-name')).toHaveText(`${evil} CLI`);
  await view(page).getByRole('combobox', { name: 'Model' }).click();
  await expect(view(page).getByRole('option')).toHaveText([evil, 'fake/<b>bold</b>']);
  await page.keyboard.press('Escape');
  await view(page).getByRole('button', { name: 'Test connection' }).click();
  await expect(view(page).locator('.ap-test-result')).toHaveText('<img src=x onerror=window.__xss=2> failed');
  expect(await view(page).locator('img').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('every step is accessible in light and dark and fits a phone', async ({ app, page, request, server }) => {
  await onboard(request, server);
  const steps = ['agent', 'canonical', 'company', 'destination', 'done'];
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const step of steps) {
      await app.goto(`#/setup/${step}`);
      await expect(stepTitle(page, step)).toBeVisible();
      if (step === 'agent') {
        await view(page).getByRole('combobox', { name: 'Model' }).click();
        await expect(view(page).getByRole('option').first()).toBeVisible();
        await page.keyboard.press('Escape');
      }
      if (step === 'destination') {
        await view(page).getByText('How to get an app password').click();
        await view(page).getByText('More options').click();
      }
      await expectAccessible(page);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const step of steps) {
    await app.goto(`#/setup/${step}`);
    await expect(stepTitle(page, step)).toBeVisible();
    if (step === 'agent') await pick(page, 'openai').click();
    if (step === 'destination') await view(page).getByText('More options').click();
    await expectNoSideScroll(page, 390);
  }
  await expectAccessible(page);
});

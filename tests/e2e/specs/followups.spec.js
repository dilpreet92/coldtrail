// Follow-ups (spec §5.5): everyone already contacted, by state — Due / Awaiting / Replied /
// Bounced — from GET /api/followups; row actions Draft follow-up (a real call to the fake agent)
// and Mark replied / Mark bounced; the header action Check for replies (a real call to the fake
// agent) with its progress state. Also the loading, error and empty states of both data sources
// (/api/followups and /api/drafts), hostile text, long lists, the keyboard, leaving mid-turn,
// accessibility in light and dark, and phone width.
//
// Tests in this file share one server and run in order. Three change data: "mark replied …" (a
// Due row → Replied), "keyboard …" (an Awaiting row → Bounced) and "a reply check reports …" (an
// Awaiting row each → Replied and → Bounced). Every test before them sees the seed as built, and
// every test after them derives what it expects from the server.
import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { COMPANIES, SEED } from '../harness/seed.mjs';
import { fmtNum } from '../../../ui/js/core/format.js';

test.describe.configure({ timeout: 90_000 });

// An agent turn through the fake opencode is quick, but the machine may be busy.
const AGENT_MS = 45_000;

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashIs = (hash) => new RegExp(`${reEscape(hash)}$`);
/** The hash route as { path, ...query } (query order doesn't matter). */
const routeOf = (page) => {
  const hash = new URL(page.url()).hash.slice(1);
  const [path, qs = ''] = hash.split('?');
  return { path, ...Object.fromEntries(new URLSearchParams(qs)) };
};

/** The seeded follow-up companies in one state. */
const seeded = (state) => COMPANIES.filter((c) => c.followup === state);
/** `/api/followups` → `to`: the largest contact email of the domain, or null. */
const emailOf = (c) => c.contacts.map((k) => k.email).filter(Boolean).sort().pop() ?? null;
/** Contacts a reply check covers: due or awaiting, with an email. */
const CHECKABLE = [...seeded('due'), ...seeded('awaiting')].filter(emailOf).length;

const STATES = [
  ['due', 'Due'],
  ['awaiting', 'Awaiting'],
  ['replied', 'Replied'],
  ['bounced', 'Bounced'],
];

const tablist = (page) => page.getByRole('tablist', { name: 'Follow-up state' });
const tab = (page, label) => tablist(page).getByRole('tab', { name: new RegExp(`^${label}\\b`) });
const rows = (page) => page.locator('.fu-content table tbody tr:not(.table-empty)');
const row = (page, domain) => page.locator(`.fu-content tr[data-key="${domain}"]`);
const checkBtn = (page) => page.locator('[data-action="check"]');
const notice = (page) => page.locator('.fu-notice');
const toastWith = (page, text) => page.locator('#toasts .toast').filter({ hasText: text });
const navCount = (page) =>
  page.getByRole('navigation', { name: 'Main' }).locator('a[data-route="followups"] .nav-count');

/** Follow-ups has mounted and its list has landed. */
async function ready(page) {
  await expect(page.locator('#view h1')).toHaveText('Follow-ups');
  await expect(page.locator('.fu-content')).toHaveAttribute('aria-busy', 'false');
}

/** Hold matching requests until release(); then they reach the real server. */
async function hold(page, matcher) {
  let release;
  const gate = new Promise((r) => (release = r));
  const seen = [];
  await page.route(matcher, async (route) => {
    seen.push(route.request());
    await gate;
    await route.continue();
  });
  return { release: () => release(), seen };
}

const isList = (url) => url.pathname === '/api/followups';

test('tabs show seeded counts', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);
  await expect(page).toHaveTitle('Follow-ups · coldtrail');

  const list = tablist(page);
  await expect(list.getByRole('tab')).toHaveCount(4);
  for (const [state, label] of STATES) {
    await expect(tab(page, label).locator('.tab-count')).toHaveText(fmtNum(SEED.followups[state]));
  }
  // Due is the default tab and lists exactly the seeded due companies.
  await expect(tab(page, 'Due')).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page)).toHaveCount(SEED.followups.due);
  const shown = await rows(page).evaluateAll((trs) => trs.map((tr) => tr.dataset.key).sort());
  expect(shown).toEqual(seeded('due').map((c) => c.domain).sort());
  await expect(navCount(page)).toHaveText(fmtNum(SEED.counts.followups_due));

  // A tab is part of the URL, survives a reload, and deep links work.
  await tab(page, 'Awaiting').click();
  await expect(page).toHaveURL(hashIs('#/followups?tab=awaiting'));
  await expect(rows(page)).toHaveCount(SEED.followups.awaiting);
  await page.reload();
  await ready(page);
  await expect(tab(page, 'Awaiting')).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page)).toHaveCount(SEED.followups.awaiting);

  await page.goto(app.server.url('#/followups?tab=bounced'));
  await ready(page);
  await expect(tab(page, 'Bounced')).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page)).toHaveCount(SEED.followups.bounced);
  // Replied and bounced rows have nothing left to do.
  await expect(page.locator('.fu-content table').getByRole('button')).toHaveCount(0);

  // Back to Due: the address bar drops the default tab.
  await tab(page, 'Due').click();
  await expect(page).toHaveURL(hashIs('#/followups'));
  await expect(rows(page)).toHaveCount(SEED.followups.due);
});

test('rows show the contact, touches and time since the last send', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);

  // The due company with two sends (14 and 9 days ago).
  const twice = seeded('due').find((c) => c.outreach.length === 2);
  const r = row(page, twice.domain);
  await expect(r.getByRole('link', { name: twice.domain })).toHaveAttribute('href', `#/pipeline/${twice.domain}`);
  await expect(r).toContainText(emailOf(twice));
  await expect(r.locator('td').nth(1)).toHaveText('2');
  await expect(r.locator('td').nth(2)).toHaveText('9 days');
  await expect(r.locator('.badge')).toHaveText('Due');
  await expect(r.getByRole('button', { name: `Draft follow-up, ${twice.domain}` })).toBeVisible();
  await expect(r.getByRole('button', { name: `Mark replied, ${twice.domain}` })).toBeVisible();
  await expect(r.getByRole('button', { name: `Mark bounced, ${twice.domain}` })).toBeVisible();

  // A LinkedIn-only send has no email to follow up on, so it can't get a drafted follow-up.
  await tab(page, 'Awaiting').click();
  const linkedin = seeded('awaiting').find((c) => !emailOf(c) && c.outreach.length === 1);
  const li = row(page, linkedin.domain);
  await expect(li).toContainText('No email on file');
  await expect(li.getByRole('button', { name: /^Draft follow-up/ })).toHaveCount(0);
  await expect(li.getByRole('button', { name: `Mark replied, ${linkedin.domain}` })).toBeVisible();

  // Three touches with no reply: the sequence is over, and the row says so.
  const done = seeded('awaiting').find((c) => c.outreach.length === 3);
  await expect(row(page, done.domain).locator('td').nth(1)).toHaveText('3');
  await expect(row(page, done.domain)).toContainText('No more follow-ups');
  // A due row says which follow-up it would be.
  await tab(page, 'Due').click();
  await expect(row(page, twice.domain).locator('.fu-state')).toHaveText('DueFollow-up 2 of 2');

  // The filter recounts the tabs and points at a match under another tab.
  const filter = page.getByRole('searchbox', { name: 'Filter follow-ups' });
  await filter.fill(done.domain);
  await expect(tab(page, 'Awaiting').locator('.tab-count')).toHaveText('1');
  await expect(tab(page, 'Due').locator('.tab-count')).toHaveText('0');
  await expect(page.locator('.fu-content .empty-state')).toContainText('Nothing under Due, but 1 under Awaiting.');
  await tab(page, 'Awaiting').click();
  await expect(rows(page)).toHaveCount(1);
  await expect.poll(() => routeOf(page)).toEqual({ path: '/followups', tab: 'awaiting', q: done.domain });
  await filter.fill('');
  await expect(tab(page, 'Due').locator('.tab-count')).toHaveText(fmtNum(SEED.followups.due));
});

test('draft follow-up shows progress then a result', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);
  const target = seeded('due').find((c) => emailOf(c));
  const r = row(page, target.domain);
  const gate = await hold(page, `**/api/followups/${target.domain}/draft`);

  await r.getByRole('button', { name: `Draft follow-up, ${target.domain}` }).click();
  // Progress: the button says what is happening, and the row can't be changed meanwhile.
  const busy = r.locator('[data-action="draft"]');
  await expect(busy).toHaveText('Drafting…');
  await expect(busy).toHaveAttribute('aria-busy', 'true');
  await expect(busy).toHaveAttribute('aria-disabled', 'true');
  await expect(r.locator('[data-action="replied"]')).toHaveAttribute('aria-disabled', 'true');
  // A second press while it runs does not start another turn.
  await busy.click({ force: true });
  expect(gate.seen).toHaveLength(1);

  // The real request goes to the fake agent, and the result comes back as a toast.
  const response = page.waitForResponse((res) => res.url().endsWith(`/api/followups/${target.domain}/draft`));
  gate.release();
  expect(await (await response).json()).toMatchObject({ ok: true });
  await expect(toastWith(page, `Follow-up drafted for ${target.domain}. Review it in Drafts.`)).toBeVisible({ timeout: AGENT_MS });
  await expect(r.locator('[data-action="draft"]')).toHaveText('Draft follow-up');
  await expect(r.locator('[data-action="draft"]')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(r.locator('[data-action="replied"]')).not.toHaveAttribute('aria-disabled', 'true');
});

test('a failed draft says so, and a waiting draft replaces the button', async ({ app, page }) => {
  const [first, second] = seeded('due').filter((c) => emailOf(c));
  await page.route(`**/api/followups/${first.domain}/draft`, (route) =>
    route.fulfill({ json: { ok: false, message: 'Could not reach **Gmail** — try `opencode auth login`.' } }),
  );
  // /api/drafts says the second company already has a draft waiting.
  await page.route('**/api/drafts', async (route) => {
    const res = await route.fetch();
    const drafts = await res.json();
    drafts.unshift({ domain: second.domain, to: emailOf(second), subject: 'Re: hi', body: 'Following up', status: 'draft_pending', gmail_draft_id: null, channel: 'email', auto_skip: null });
    await route.fulfill({ response: res, json: drafts });
  });
  await app.goto('#/followups');
  await ready(page);

  await row(page, first.domain).getByRole('button', { name: `Draft follow-up, ${first.domain}` }).click();
  // The agent's text goes through the markdown renderer: no stray ** or backticks.
  const err = toastWith(page, `Couldn't draft a follow-up for ${first.domain}.`);
  await expect(err).toBeVisible();
  await expect(err).toContainText('Could not reach Gmail — try opencode auth login.');
  await expect(err).toHaveAttribute('role', 'alert');
  await err.getByRole('button', { name: 'Dismiss' }).click();

  const review = row(page, second.domain).getByRole('link', { name: `Review draft, ${second.domain}` });
  await expect(review).toHaveAttribute('href', `#/drafts/${second.domain}`);
  await expect(row(page, second.domain).getByRole('button', { name: /^Draft follow-up/ })).toHaveCount(0);
});

test('check for replies shows progress and completes', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);
  await expect(checkBtn(page)).toHaveText('Check for replies');
  const gate = await hold(page, '**/api/followups/check');

  await checkBtn(page).click();
  await expect(checkBtn(page)).toHaveText('Checking…');
  await expect(checkBtn(page)).toHaveAttribute('aria-busy', 'true');
  await expect(checkBtn(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(checkBtn(page)).toBeFocused(); // a busy button keeps focus
  await expect(notice(page)).toContainText(`Checking Gmail for replies from ${CHECKABLE} contacts…`);
  await expect(notice(page).locator('.fu-elapsed')).toHaveText(/^0:0\d$/);
  await checkBtn(page).click({ force: true });
  expect(gate.seen).toHaveLength(1);

  const response = page.waitForResponse((res) => res.url().endsWith('/api/followups/check'));
  gate.release();
  const body = await (await response).json();
  expect(body.ok).toBe(true);
  await expect(notice(page)).toContainText('Reply check finished', { timeout: AGENT_MS });
  // The fake agent marks nothing: the result says so from the list itself, whatever text the
  // provider returned (opencode turns return none; any that is returned renders as agent text).
  await expect(notice(page).locator('.fu-changes')).toHaveText('No new replies or bounces.');
  if (body.message) await expect(notice(page).locator('.fu-md')).toContainText(body.message.split('\n')[0]);
  else await expect(notice(page).locator('.fu-md')).toHaveCount(0);
  await expect(checkBtn(page)).toHaveText('Check for replies');
  await expect(checkBtn(page)).not.toHaveAttribute('aria-disabled', 'true');
  // The fake agent marks nothing, so the counts hold.
  await expect(tab(page, 'Due').locator('.tab-count')).toHaveText(fmtNum(SEED.followups.due));

  // The result stays until dismissed, even across a visit elsewhere.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await page.goBack();
  await ready(page);
  await expect(notice(page)).toContainText('Reply check finished');
  await notice(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice(page)).toHaveCount(0);
});

test('reply check results that need attention are shown as such', async ({ app, page }) => {
  // A BYOK provider can't scan Gmail: the server says why, with ok:false.
  const byok =
    'Reply-checking scans your Gmail via the Claude/Codex connector. On BYOK/Ollama, mark replies with the Replied / Bounced buttons for now.';
  await page.route('**/api/followups/check', (route) => route.fulfill({ json: { ok: false, message: byok } }));
  await app.goto('#/followups');
  await ready(page);
  await checkBtn(page).click();
  await expect(notice(page)).toHaveClass(/fu-notice-warn/);
  await expect(notice(page)).toContainText("Couldn't check for replies");
  await expect(notice(page)).toContainText(byok);

  // A server error is an error, with its text.
  app.allowConsole(/Failed to load resource/);
  await page.unroute('**/api/followups/check');
  await page.route('**/api/followups/check', (route) => route.fulfill({ status: 500, body: 'database is locked' }));
  await checkBtn(page).click();
  await expect(notice(page)).toHaveClass(/fu-notice-err/);
  await expect(notice(page)).toContainText('Reply check failed');
  await expect(notice(page)).toContainText('database is locked');
  await notice(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice(page)).toHaveCount(0);
});

test('mark replied moves the row to Replied', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);
  const target = seeded('due')[0];

  await row(page, target.domain).getByRole('button', { name: `Mark replied, ${target.domain}` }).click();
  await expect(toastWith(page, `Marked ${target.domain} as replied.`)).toBeVisible();
  await expect(row(page, target.domain)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(SEED.followups.due - 1);
  await expect(tab(page, 'Due').locator('.tab-count')).toHaveText(fmtNum(SEED.followups.due - 1));
  await expect(tab(page, 'Replied').locator('.tab-count')).toHaveText(fmtNum(SEED.followups.replied + 1));
  // The sidebar's due count follows.
  await expect(navCount(page)).toHaveText(fmtNum(SEED.counts.followups_due - 1));
  // Focus stays in the table, on the next row's same action.
  await expect(page.locator('.fu-content [data-action="replied"]:focus')).toHaveCount(1);

  await tab(page, 'Replied').click();
  await expect(row(page, target.domain).locator('.badge')).toHaveText('Replied');
  await expect(rows(page)).toHaveCount(SEED.followups.replied + 1);

  // It holds on the server.
  const fresh = await page.request.get(app.server.apiUrl('/api/followups'));
  expect((await fresh.json()).find((f) => f.domain === target.domain).state).toBe('replied');
});

test('keyboard: arrows switch tabs, Enter runs a row action', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);
  const awaiting = (await (await page.request.get(app.server.apiUrl('/api/followups'))).json()).filter((f) => f.state === 'awaiting');

  await tab(page, 'Due').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Awaiting')).toBeFocused();
  await expect(tab(page, 'Awaiting')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(hashIs('#/followups?tab=awaiting'));
  await expect(rows(page)).toHaveCount(awaiting.length);
  await page.keyboard.press('End');
  await expect(tab(page, 'Bounced')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'Awaiting')).toHaveAttribute('aria-selected', 'true');

  // Tab order: tabs → filter → the first row's company link → its actions.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('searchbox', { name: 'Filter follow-ups' })).toBeFocused();
  await page.keyboard.press('Tab');
  const first = awaiting[0].domain;
  await expect(row(page, first).getByRole('link', { name: first })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(row(page, first).getByRole('button', { name: `Mark replied, ${first}` })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(row(page, first).getByRole('button', { name: `Mark bounced, ${first}` })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toastWith(page, `Marked ${first} as bounced.`)).toBeVisible();
  await expect(row(page, first)).toHaveCount(0);
  await expect(page.locator('.fu-content [data-action="bounced"]:focus')).toHaveCount(1);
});

test('a reply check reports who replied or bounced', async ({ app, page }) => {
  await app.goto('#/followups?tab=awaiting');
  await ready(page);
  const list = async () => (await (await page.request.get(app.server.apiUrl('/api/followups'))).json());
  const [a, b] = (await list()).filter((f) => f.state === 'awaiting' && f.to);
  // Stand in for the agent: it marks one reply and one bounce, then reports.
  await page.route('**/api/followups/check', async (route) => {
    const mark = (domain, value) =>
      page.request.post(app.server.apiUrl(`/api/followups/${domain}/mark`), { data: { value } });
    await mark(a.domain, 'replied');
    await mark(b.domain, 'bounced');
    await route.fulfill({ json: { ok: true, message: 'Marked **2** contacts.' } });
  });
  await checkBtn(page).click();
  await expect(notice(page).locator('.fu-changes')).toHaveText(`1 new reply (${a.domain}) and 1 bounce (${b.domain}).`);
  await expect(notice(page).locator('.fu-md strong')).toHaveText('2');
  await expect(row(page, a.domain)).toHaveCount(0);
  await expect(row(page, b.domain)).toHaveCount(0);
  const after = await list();
  const count = (state) => fmtNum(after.filter((f) => f.state === state).length);
  await expect(tab(page, 'Replied').locator('.tab-count')).toHaveText(count('replied'));
  await expect(tab(page, 'Bounced').locator('.tab-count')).toHaveText(count('bounced'));
});

test('filter narrows the list and long lists show 100 rows at a time', async ({ app, page }) => {
  const many = Array.from({ length: 250 }, (_, i) => ({
    domain: `company-${String(i + 1).padStart(3, '0')}.example`,
    to: `founder@company-${String(i + 1).padStart(3, '0')}.example`,
    days: 4 + (i % 9),
    touches: 1,
    state: 'due',
  }));
  await page.route(isList, (route) => route.fulfill({ json: many }));
  await app.goto('#/followups');
  await ready(page);

  await expect(tab(page, 'Due').locator('.tab-count')).toHaveText('250');
  await expect(rows(page)).toHaveCount(100);
  const more = page.getByRole('button', { name: 'Show more' });
  await expect(page.locator('.fu-more')).toContainText('Showing 100 of 250');
  await more.click();
  await expect(rows(page)).toHaveCount(200);
  await expect(more).toBeFocused();
  await more.click();
  await expect(rows(page)).toHaveCount(250);
  await expect(more).toHaveCount(0);

  const filter = page.getByRole('searchbox', { name: 'Filter follow-ups' });
  await filter.fill('COMPANY-12');
  await expect(rows(page)).toHaveCount(10); // company-120 … company-129, any case
  await expect(tab(page, 'Due').locator('.tab-count')).toHaveText('10');
  await expect(page).toHaveURL(hashIs('#/followups?q=COMPANY-12'));
  await filter.fill('nobody-here');
  await expect(page.locator('.fu-content')).toContainText('No follow-ups match “nobody-here”');
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(rows(page)).toHaveCount(100);
  await expect(filter).toHaveValue('');
  await expect(filter).toBeFocused();
  await expect(page).toHaveURL(hashIs('#/followups'));
});

test('loading, error and retry', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  let fail = true;
  const gate = { release: null };
  const held = new Promise((r) => (gate.release = r));
  await page.route(isList, async (route) => {
    await held;
    if (fail) await route.fulfill({ status: 500, body: 'database is locked' });
    else await route.continue();
  });
  await app.goto('#/followups');
  await expect(page.locator('#view h1')).toHaveText('Follow-ups');
  // Loading: a busy region with placeholder rows, and tabs without counts yet.
  await expect(page.locator('.fu-content')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.fu-content .skeleton').first()).toBeVisible();
  await expect(tab(page, 'Due').locator('.tab-count')).toBeHidden();

  gate.release();
  await expect(page.locator('.fu-content')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.fu-content')).toContainText("Couldn't load follow-ups");
  await expect(page.locator('.fu-content')).toContainText('database is locked');

  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await ready(page);
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator('.fu-content')).not.toContainText("Couldn't load follow-ups");
});

test('a drafts list that fails to load only hides the draft hint', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  await page.route('**/api/drafts', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await app.goto('#/followups');
  await ready(page);
  const fresh = (await (await page.request.get(app.server.apiUrl('/api/followups'))).json()).filter((f) => f.state === 'due');
  await expect(rows(page)).toHaveCount(fresh.length);
  await expect(page.locator('.fu-content')).not.toContainText("Couldn't load");
});

test('hostile follow-up data renders as text', async ({ app, page }) => {
  const evil = '<img src=x onerror=window.__xss=1>.example';
  await page.route(isList, (route) =>
    route.fulfill({
      json: [
        { domain: evil, to: '"><script>window.__xss=2</script>@x.example', days: 5, touches: 1, state: 'due' },
        { domain: 'weird.example', to: null, days: 1, touches: 1, state: '<b onmouseover=window.__xss=3>odd</b>' },
      ],
    }),
  );
  await page.route('**/api/followups/check', (route) =>
    route.fulfill({ json: { ok: true, message: 'Marked **1** replied. <img src=x onerror=window.__xss=4> [docs](javascript:window.__xss=5)' } }),
  );
  await app.goto('#/followups');
  await ready(page);
  await expect(row(page, evil).getByRole('link', { name: evil })).toBeVisible();
  await expect(row(page, evil)).toContainText('"><script>window.__xss=2</script>@x.example');
  await checkBtn(page).click();
  const md = notice(page).locator('.fu-md');
  await expect(md).toContainText('<img src=x onerror=window.__xss=4>');
  await expect(md.locator('strong')).toHaveText('1');
  await expect(md.locator('img, script, a')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('leaving mid-check stops the screen timers and the result waits', async ({ app, page }) => {
  // Count the live intervals this screen's module started: its elapsed-time ticker must not
  // outlive it. (Counted by the creating stack, so other screens' timers don't matter.)
  await page.addInitScript(() => {
    const live = new Map();
    const set = window.setInterval;
    const clear = window.clearInterval;
    window.setInterval = function (...args) {
      const id = set.apply(this, args);
      live.set(id, new Error().stack || '');
      return id;
    };
    window.clearInterval = function (id) {
      live.delete(id);
      return clear.call(this, id);
    };
    window.__intervalsFrom = (needle) => [...live.values()].filter((s) => s.includes(needle)).length;
  });
  const ours = () => page.evaluate(() => window.__intervalsFrom('views/followups.js'));
  const nav = page.getByRole('navigation', { name: 'Main' });

  await app.goto('#/home');
  await expect(page.locator('#view h1')).toHaveText('Home');
  await nav.getByRole('link', { name: /^Follow-ups\b/ }).click();
  await ready(page);
  expect(await ours()).toBe(0);
  const gate = await hold(page, '**/api/followups/check');
  await checkBtn(page).click();
  await expect(checkBtn(page)).toHaveText('Checking…');
  await expect.poll(ours).toBe(1);

  await nav.getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect.poll(ours).toBe(0);

  // Coming back mid-check shows it still running.
  await page.goBack();
  await ready(page);
  await expect(checkBtn(page)).toHaveText('Checking…');
  await expect(notice(page)).toContainText('Checking Gmail for replies');
  await expect.poll(ours).toBe(1);
  await page.goForward();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect.poll(ours).toBe(0);

  // It finishes while elsewhere: a toast says so, and the result is waiting on Follow-ups.
  gate.release();
  await expect(toastWith(page, 'Reply check finished. The summary is on Follow-ups.')).toBeVisible({ timeout: AGENT_MS });
  expect(await ours()).toBe(0);
  await page.goBack();
  await ready(page);
  await expect(notice(page)).toContainText('Reply check finished');
  await expect(checkBtn(page)).toHaveText('Check for replies');
  expect(await ours()).toBe(0);
});

test('follow-ups is accessible in light and dark', async ({ app, page }) => {
  await page.route('**/api/followups/check', (route) =>
    route.fulfill({ json: { ok: true, message: 'Checked **8** contacts.\n\n- 1 replied\n- 0 bounced' } }),
  );
  await app.goto('#/followups');
  await ready(page);
  await checkBtn(page).click();
  await expect(notice(page)).toContainText('Reply check finished');

  await page.emulateMedia({ colorScheme: 'light' });
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
  // Every tab's table, and a warning notice, in dark.
  for (const [, label] of STATES.slice(1)) {
    await tab(page, label).click();
    await expect(tab(page, label)).toHaveAttribute('aria-selected', 'true');
    await expectAccessible(page);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await expectAccessible(page);
});

test('phone width: no horizontal scroll and the actions stay reachable', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.goto('#/followups');
  await ready(page);
  const scrollWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
  await expect.poll(scrollWidth).toBeLessThanOrEqual(390);

  const first = rows(page).first();
  const domain = await first.getAttribute('data-key');
  const action = first.getByRole('button', { name: `Mark bounced, ${domain}` });
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeInViewport();
  await expect(checkBtn(page)).toBeInViewport();

  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expectAccessible(page);
  await expect.poll(scrollWidth).toBeLessThanOrEqual(390);
});

test.describe('new workspace', () => {
  test.use({ seed: 'onboarded' });

  test('empty workspace explains how follow-ups start', async ({ app, page }) => {
    await app.goto('#/followups');
    await ready(page);
    const empty = page.locator('.fu-content .empty-state');
    await expect(empty.getByRole('heading', { name: 'No one to follow up with yet' })).toBeVisible();
    await expect(empty.getByRole('link', { name: 'Review drafts' })).toHaveAttribute('href', '#/drafts');
    for (const [, label] of STATES) await expect(tab(page, label).locator('.tab-count')).toHaveText('0');

    // The real check has nothing to do and says so.
    await checkBtn(page).click();
    await expect(notice(page)).toContainText('Nothing is awaiting a reply.', { timeout: AGENT_MS });

    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

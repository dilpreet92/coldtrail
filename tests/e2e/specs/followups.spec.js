// Follow-ups (spec §5.5): everyone already contacted, by state — Due / Awaiting / Replied /
// Bounced — from GET /api/followups; row actions Draft follow-up (a real call to the fake agent)
// and Mark replied / Mark bounced; the header action Check for replies (a real call to the fake
// agent) with its progress state. Also the loading, error and empty states of both data sources
// (/api/followups and /api/drafts), hostile text, long lists, the keyboard, leaving mid-turn,
// accessibility in light and dark, and phone width.
//
// Tests in this file share one server and run in order. Six change data: "mark replied …" (a
// Due row → Replied), "keyboard …" (an Awaiting row → Bounced), "a reply check reports …" (an
// Awaiting row each → Replied and → Bounced), "a mark made by hand during a check …" (a Due row →
// Replied), "changes made elsewhere …" (an Awaiting row → Bounced) and "a reply check credits
// only …" (an Awaiting row → Bounced, a Due row → Replied). Every test before them sees the seed
// as built, and every test after them derives what it expects from the server. The last two
// before "new workspace" add companies of their own.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
const markDialog = (page, domain, value) => page.getByRole('alertdialog', { name: `Mark ${domain} as ${value}?` });

/** Press a row's Mark replied / Mark bounced and confirm (a mark always asks first). */
async function markRow(page, domain, value) {
  await row(page, domain).getByRole('button', { name: `Mark ${value}, ${domain}` }).click();
  const dialog = markDialog(page, domain, value);
  await dialog.getByRole('button', { name: `Mark ${value}` }).click();
  await expect(dialog).toHaveCount(0);
}

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

/** Write to the throwaway workspace DB (the server only ever runs in a temp COLDTRAIL_HOME). */
function dbExec(server, sql) {
  const db = new DatabaseSync(join(server.home, 'outreach.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(sql);
  } finally {
    db.close();
  }
}

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
  await expect(li.locator('.fu-email')).toHaveText('Reached on LinkedIn');
  await expect(li.getByRole('button', { name: /^Draft follow-up/ })).toHaveCount(0);
  await expect(li.getByRole('button', { name: `Mark replied, ${linkedin.domain}` })).toBeVisible();
  // …so it doesn't promise a next touch either ("Due in 3 days" would never come to anything).
  await expect(li.locator('.fu-state')).toHaveText('Awaiting reply');
  // An awaiting row with an email says when its follow-up comes due.
  const soon = seeded('awaiting').find((c) => emailOf(c) && c.outreach.length === 1);
  await expect(row(page, soon.domain).locator('.fu-hint')).toHaveText(/^Due in \d+ days?$/);

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

test('a filter from the address without a tab opens the tab that holds its match', async ({ app, page }) => {
  const now = await (await page.request.get(app.server.apiUrl('/api/followups'))).json();
  const awaiting = now.find((f) => f.state === 'awaiting' && f.to);
  const due = now.find((f) => f.state === 'due');
  const replied = now.find((f) => f.state === 'replied');

  // Pipeline's drawer can't tell Due from Awaiting, so it links a sent company by domain alone.
  await app.goto(`#/pipeline/${awaiting.domain}`);
  await page.getByRole('dialog').getByRole('link', { name: 'Open in Follow-ups' }).click();
  await ready(page);
  await expect(tab(page, 'Awaiting')).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, awaiting.domain)).toBeVisible();
  // The address names the tab, in place: Back still returns to the drawer.
  await expect.poll(() => routeOf(page)).toEqual({ path: '/followups', tab: 'awaiting', q: awaiting.domain });
  await page.goBack();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Open in Follow-ups' })).toBeVisible();

  // A match under Due stays on Due, the default, which the address leaves out.
  await page.goto(app.server.url(`#/followups?q=${due.domain}`));
  await ready(page);
  await expect(tab(page, 'Due')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, due.domain)).toBeVisible();
  expect(routeOf(page)).toEqual({ path: '/followups', q: due.domain });
  // No match anywhere: Due, and the empty state says so.
  await page.goto(app.server.url('#/followups?q=nobody-here'));
  await ready(page);
  await expect(tab(page, 'Due')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.fu-content .empty-state')).toContainText('No follow-ups match “nobody-here”');
  expect(routeOf(page)).toEqual({ path: '/followups', q: 'nobody-here' });

  // A tab the address names is kept, match or not.
  await page.goto(app.server.url(`#/followups?tab=bounced&q=${awaiting.domain}`));
  await ready(page);
  await expect(tab(page, 'Bounced')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.fu-content .empty-state')).toContainText('Nothing under Bounced, but 1 under Awaiting.');

  // The same for a filter that arrives while the screen is open.
  await page.evaluate((d) => {
    location.hash = `#/followups?q=${d}`;
  }, replied.domain);
  await expect(tab(page, 'Replied')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, replied.domain)).toBeVisible();
  await expect.poll(() => routeOf(page)).toEqual({ path: '/followups', tab: 'replied', q: replied.domain });
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
  // A second press while it runs does not start another turn (counted again once it's over).
  await expect.poll(() => gate.seen.length).toBe(1);
  await busy.click({ force: true });

  // The real request goes to the fake agent. Its turn ends well (ok:true) but it never runs
  // `coldtrail followup`, so no draft exists: the toast says what actually happened.
  const response = page.waitForResponse((res) => res.url().endsWith(`/api/followups/${target.domain}/draft`));
  gate.release();
  expect(await (await response).json()).toMatchObject({ ok: true });
  const none = toastWith(page, `The agent finished, but no follow-up draft was saved for ${target.domain}.`);
  await expect(none).toBeVisible({ timeout: AGENT_MS });
  await expect(none).toHaveAttribute('role', 'alert');
  expect(gate.seen).toHaveLength(1);
  await expect(toastWith(page, 'Follow-up drafted for')).toHaveCount(0);
  await expect(r.locator('[data-action="draft"]')).toHaveText('Draft follow-up');
  await expect(r.locator('[data-action="draft"]')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(r.locator('[data-action="replied"]')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(r.getByRole('link', { name: /^Review draft/ })).toHaveCount(0);
});

test('a saved follow-up draft is confirmed and replaces the button', async ({ app, page }) => {
  const target = seeded('due').filter((c) => emailOf(c))[1];
  // Stand in for an agent that does save a draft: once the turn ends, Drafts has it.
  let saved = false;
  await page.route(`**/api/followups/${target.domain}/draft`, (route) => {
    saved = true;
    return route.fulfill({ json: { ok: true, message: 'Follow-up drafted — review it in Drafts.' } });
  });
  await page.route('**/api/drafts', async (route) => {
    const res = await route.fetch();
    const drafts = await res.json();
    if (saved) drafts.unshift({ domain: target.domain, to: emailOf(target), subject: 'Re: hi', body: 'Following up', status: 'draft_pending', gmail_draft_id: null, channel: 'email', auto_skip: null, contact_name: null, company_name: null });
    await route.fulfill({ response: res, json: drafts });
  });
  await app.goto('#/followups');
  await ready(page);
  const r = row(page, target.domain);
  // From the keyboard: Enter on Draft follow-up, and focus ends on the button's replacement.
  await r.getByRole('button', { name: `Draft follow-up, ${target.domain}` }).focus();
  await page.keyboard.press('Enter');
  await expect(toastWith(page, `Follow-up drafted for ${target.domain}. Review it in Drafts.`)).toBeVisible();
  const review = r.getByRole('link', { name: `Review draft, ${target.domain}` });
  await expect(review).toHaveAttribute('href', `#/drafts/${target.domain}?channel=email`);
  await expect(r.getByRole('button', { name: /^Draft follow-up/ })).toHaveCount(0);
  await expect(review).toBeFocused();
});

test('Review draft opens the email follow-up, not the company’s LinkedIn note', async ({ app, page }) => {
  const target = seeded('due').filter((c) => emailOf(c))[3];
  // The company has a follow-up and a newer LinkedIn note waiting (listed first), and Drafts
  // last showed its LinkedIn tab.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ct-drafts-tab', 'linkedin');
    } catch (_) {
      /* storage blocked: the note is still listed first */
    }
  });
  const draft = { domain: target.domain, gmail_draft_id: null, status: 'draft_pending', auto_skip: null, contact_name: null, company_name: null };
  await page.route('**/api/drafts', async (route) => {
    const res = await route.fetch();
    const drafts = await res.json();
    drafts.unshift(
      { ...draft, channel: 'linkedin', to: 'https://www.linkedin.com/in/someone', subject: null, body: 'Hi, a LinkedIn note' },
      { ...draft, channel: 'email', to: emailOf(target), subject: 'Re: hi', body: 'Following up on my note' },
    );
    await route.fulfill({ response: res, json: drafts });
  });
  await app.goto('#/followups');
  await ready(page);
  await row(page, target.domain).getByRole('link', { name: `Review draft, ${target.domain}` }).click();
  await expect(page).toHaveURL(hashIs(`#/drafts/${target.domain}?channel=email`));
  await expect(page.locator('#view [role="option"][aria-selected="true"]')).toHaveAttribute('data-key', `email:${target.domain}`);
  await expect(page.getByRole('textbox', { name: 'Subject' })).toHaveValue('Re: hi');
});

test('a draft made elsewhere is not taken for the agent’s', async ({ app, page }) => {
  const target = seeded('due').filter((c) => emailOf(c))[2];
  // The screen's list predates a follow-up written elsewhere: its first /api/drafts doesn't
  // have it, every later one does. The agent's turn then ends well without saving another.
  let loads = 0;
  await page.route('**/api/drafts', async (route) => {
    const res = await route.fetch();
    const drafts = await res.json();
    if (loads++ > 0) drafts.unshift({ domain: target.domain, to: emailOf(target), subject: 'Re: hi', body: 'Following up', status: 'draft_pending', gmail_draft_id: null, channel: 'email', auto_skip: null, contact_name: null, company_name: null });
    await route.fulfill({ response: res, json: drafts });
  });
  await page.route(`**/api/followups/${target.domain}/draft`, (route) =>
    route.fulfill({ json: { ok: true, message: 'Follow-up drafted — review it in Drafts.' } }),
  );
  await app.goto('#/followups');
  await ready(page);
  const r = row(page, target.domain);
  await r.getByRole('button', { name: `Draft follow-up, ${target.domain}` }).click();
  const none = toastWith(page, `The agent finished, but no new follow-up draft was saved for ${target.domain}. An earlier one is waiting in Drafts.`);
  await expect(none).toBeVisible();
  await expect(none).toHaveAttribute('role', 'alert');
  await expect(toastWith(page, 'Follow-up drafted for')).toHaveCount(0);
  // The waiting draft is linked now.
  await expect(r.getByRole('link', { name: `Review draft, ${target.domain}` })).toHaveAttribute('href', `#/drafts/${target.domain}?channel=email`);
});

test('a failed draft says so, and a waiting draft replaces the button', async ({ app, page }) => {
  const [first, second, third] = seeded('due').filter((c) => emailOf(c));
  await page.route(`**/api/followups/${first.domain}/draft`, (route) =>
    route.fulfill({ json: { ok: false, message: 'Could not reach **Gmail** — try `opencode auth login`.' } }),
  );
  // /api/drafts says the second company already has a draft waiting.
  await page.route('**/api/drafts', async (route) => {
    const res = await route.fetch();
    const drafts = await res.json();
    drafts.unshift({ domain: second.domain, to: emailOf(second), subject: 'Re: hi', body: 'Following up', status: 'draft_pending', gmail_draft_id: null, channel: 'email', auto_skip: null });
    // A LinkedIn draft for the third is not an email follow-up: that row can still get one.
    drafts.unshift({ domain: third.domain, to: 'https://www.linkedin.com/in/someone', subject: null, body: 'Hi again', status: 'draft_pending', gmail_draft_id: null, channel: 'linkedin', auto_skip: null });
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
  await expect(review).toHaveAttribute('href', `#/drafts/${second.domain}?channel=email`);
  await expect(row(page, second.domain).getByRole('button', { name: /^Draft follow-up/ })).toHaveCount(0);
  await expect(row(page, third.domain).getByRole('button', { name: `Draft follow-up, ${third.domain}` })).toBeVisible();
  await expect(row(page, third.domain).getByRole('link', { name: /^Review draft/ })).toHaveCount(0);
});

test('check for replies shows progress and completes', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);
  await expect(checkBtn(page)).toHaveText('Check for replies');
  const gate = await hold(page, '**/api/followups/check');

  await checkBtn(page).click();
  await expect(checkBtn(page)).toHaveText('Checking for replies…');
  await expect(checkBtn(page)).toHaveAttribute('aria-busy', 'true');
  await expect(checkBtn(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(checkBtn(page)).toBeFocused(); // a busy button keeps focus
  await expect(notice(page)).toContainText(`Checking Gmail for replies from ${CHECKABLE} contacts…`);
  await expect(notice(page).locator('.fu-elapsed')).toHaveText(/^0:0\d$/);
  await expect.poll(() => gate.seen.length).toBe(1);
  await checkBtn(page).click({ force: true });

  const response = page.waitForResponse((res) => res.url().endsWith('/api/followups/check'));
  gate.release();
  const body = await (await response).json();
  expect(body.ok).toBe(true);
  await expect(notice(page)).toContainText('Reply check finished', { timeout: AGENT_MS });
  // The second press started nothing: still one check.
  expect(gate.seen).toHaveLength(1);
  // The fake agent marks nothing: the result says so from the list itself, and then shows the
  // agent's own final text (opencode turns return it), rendered as agent text.
  await expect(notice(page).locator('.fu-changes')).toHaveText('Nothing was marked replied or bounced.');
  expect(body.message).toMatch(/^Fake agent reply: Check Gmail/);
  await expect(notice(page).locator('.fu-md')).toContainText('Fake agent reply: Check Gmail');
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

test('a reply check claims only what coldtrail saw, and says when it finished', async ({ app, page }) => {
  // An agent turn can end well without reading anything (or fail and say nothing): the result
  // reports what changed in the list, not that no one replied.
  await page.clock.install();
  await page.route('**/api/followups/check', (route) => route.fulfill({ json: { ok: true, message: null } }));
  await app.goto('#/followups');
  await ready(page);
  await checkBtn(page).click();
  await expect(notice(page)).toContainText('Reply check finished');
  await expect(notice(page).locator('.fu-changes')).toHaveText('Nothing was marked replied or bounced.');
  await expect(notice(page)).toContainText('The agent did not report anything.');
  await expect(notice(page)).not.toContainText(/no new repl/i);

  // When, as everywhere else: relative, with the date and time on hover, and kept current.
  const finished = notice(page).locator('.fu-notice-meta time');
  await expect(finished).toHaveText('Finished just now');
  await expect(finished).toHaveAttribute('title', /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/);
  await page.clock.fastForward('05:00');
  await expect(finished).toHaveText('Finished 5m ago');
});

test('mark replied asks first, then moves the row to Replied', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);
  const target = seeded('due')[0];
  const marks = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/followups\/[^/]+\/mark$/.test(new URL(req.url()).pathname)) marks.push(req.url());
  });

  // Nothing is marked until the confirm says so: Cancel leaves the row as it was.
  const button = row(page, target.domain).getByRole('button', { name: `Mark replied, ${target.domain}` });
  await button.click();
  const dialog = markDialog(page, target.domain, 'replied');
  await expect(dialog).toContainText(`${target.domain} moves to Replied and gets no more follow-ups.`);
  await expect(dialog).toContainText('coldtrail can’t undo this.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  expect(marks).toEqual([]);

  // From the keyboard: Enter opens the confirm (focus moves into it), Enter on its Mark replied
  // marks.
  const index = await rows(page).evaluateAll((trs, d) => trs.findIndex((tr) => tr.dataset.key === d), target.domain);
  await page.keyboard.press('Enter');
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Mark replied' }).press('Enter');
  await expect(toastWith(page, `Marked ${target.domain} as replied.`)).toBeVisible();
  await expect(row(page, target.domain)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(SEED.followups.due - 1);
  await expect(tab(page, 'Due').locator('.tab-count')).toHaveText(fmtNum(SEED.followups.due - 1));
  await expect(tab(page, 'Replied').locator('.tab-count')).toHaveText(fmtNum(SEED.followups.replied + 1));
  // The sidebar's due count follows.
  await expect(navCount(page)).toHaveText(fmtNum(SEED.counts.followups_due - 1));
  // Focus stays in the table, on the company link of the row now in its place: never another
  // company's Mark replied, which one more Enter would press.
  const next = await rows(page).nth(Math.min(index, SEED.followups.due - 2)).getAttribute('data-key');
  await expect(row(page, next).getByRole('link', { name: next })).toBeFocused();
  expect(marks).toHaveLength(1);

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
  const bounce = row(page, first).getByRole('button', { name: `Mark bounced, ${first}` });
  await expect(bounce).toBeFocused();
  const marks = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/followups\/[^/]+\/mark$/.test(new URL(req.url()).pathname)) marks.push(req.url());
  });

  // A bounce asks first with Cancel focused, so Enter pressed again and again (or held) marks
  // nothing.
  const dialog = markDialog(page, first, 'bounced');
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(bounce).toBeFocused();
  }
  expect(marks).toEqual([]);

  // Enter, Tab to the confirm, Enter.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Mark bounced' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toastWith(page, `Marked ${first} as bounced.`)).toBeVisible();
  await expect(row(page, first)).toHaveCount(0);
  // Focus goes to the next company's link, not its Mark bounced.
  const next = awaiting[1].domain;
  await expect(row(page, next).getByRole('link', { name: next })).toBeFocused();
  expect(marks).toHaveLength(1);
});

test('a mark confirmed after the row was marked elsewhere is not sent', async ({ app, page }) => {
  // While the confirm is open, a reply check (or another tab) marks the company replied.
  let replied = false;
  const one = { domain: 'twice.example', to: 'founder@twice.example', days: 6, touches: 1 };
  await page.route(isList, (route) => route.fulfill({ json: [{ ...one, state: replied ? 'replied' : 'due' }] }));
  const marks = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/followups\/[^/]+\/mark$/.test(new URL(req.url()).pathname)) marks.push(req.url());
  });
  await app.goto('#/followups');
  await ready(page);
  await row(page, one.domain).getByRole('button', { name: `Mark bounced, ${one.domain}` }).click();
  const dialog = markDialog(page, one.domain, 'bounced');
  await expect(dialog).toBeVisible();
  replied = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(tab(page, 'Replied').locator('.tab-count')).toHaveText('1');

  // Confirming doesn't turn the reply into a bounce.
  await dialog.getByRole('button', { name: 'Mark bounced' }).click();
  await expect(toastWith(page, `${one.domain} is already marked replied.`)).toBeVisible();
  expect(marks).toEqual([]);
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
  await expect(notice(page).locator('.fu-changes')).toHaveText(`Marked 1 replied (${a.domain}) and 1 bounced (${b.domain}).`);
  await expect(notice(page).locator('.fu-md strong')).toHaveText('2');
  await expect(row(page, a.domain)).toHaveCount(0);
  await expect(row(page, b.domain)).toHaveCount(0);
  const after = await list();
  const count = (state) => fmtNum(after.filter((f) => f.state === state).length);
  await expect(tab(page, 'Replied').locator('.tab-count')).toHaveText(count('replied'));
  await expect(tab(page, 'Bounced').locator('.tab-count')).toHaveText(count('bounced'));
});

test('a mark made by hand during a check is not credited to it', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);
  const list = async () => (await (await page.request.get(app.server.apiUrl('/api/followups'))).json());
  const target = (await list()).find((f) => f.state === 'due' && f.to);
  const gate = await hold(page, '**/api/followups/check');
  await checkBtn(page).click();
  await expect(checkBtn(page)).toHaveText('Checking for replies…');

  // While the agent reads Gmail, the user marks a reply they already know about.
  await markRow(page, target.domain, 'replied');
  await expect(toastWith(page, `Marked ${target.domain} as replied.`)).toBeVisible();
  await expect(row(page, target.domain)).toHaveCount(0);

  // The fake agent marks nothing, so the check found nothing: the hand mark isn't its finding.
  gate.release();
  await expect(notice(page).locator('.fu-changes')).toHaveText('Nothing was marked replied or bounced.', { timeout: AGENT_MS });
  expect((await list()).find((f) => f.domain === target.domain).state).toBe('replied');
});

test('a failed mark is reported even after leaving the screen', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  await app.goto('#/followups');
  await ready(page);
  const domain = await rows(page).first().getAttribute('data-key');
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route(`**/api/followups/${domain}/mark`, async (route) => {
    await gate;
    await route.fulfill({ status: 500, body: 'database is locked' });
  });
  await markRow(page, domain, 'bounced');
  await expect(row(page, domain).locator('[data-action="bounced"]')).toHaveAttribute('aria-busy', 'true');
  await expect(row(page, domain).locator('[data-action="replied"]')).toHaveAttribute('aria-disabled', 'true');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  release();
  const err = toastWith(page, `Couldn't mark ${domain} as bounced.`);
  await expect(err).toBeVisible();
  await expect(err).toContainText('database is locked');
  await expect(err).toHaveAttribute('role', 'alert');
});

test('changes made elsewhere reach the open list', async ({ app, page }) => {
  const list = async () => (await (await page.request.get(app.server.apiUrl('/api/followups'))).json());
  const before = await list();
  const count = (state, d = 0) => fmtNum(before.filter((f) => f.state === state).length + d);
  const target = before.find((f) => f.state === 'awaiting');
  const due = before.find((f) => f.state === 'due' && f.to);
  // Drafts gains a follow-up for the due company once `drafted` is set (written on another screen),
  // and the summary counts it.
  let drafted = false;
  await page.route('**/api/drafts', async (route) => {
    const res = await route.fetch();
    const drafts = await res.json();
    if (drafted) drafts.unshift({ domain: due.domain, to: due.to, subject: 'Re: hi', body: 'Following up', status: 'draft_pending', gmail_draft_id: null, channel: 'email', auto_skip: null, contact_name: null, company_name: null });
    await route.fulfill({ response: res, json: drafts });
  });
  await page.route('**/api/summary', async (route) => {
    const res = await route.fetch();
    const summary = await res.json();
    if (drafted) {
      summary.counts.drafts += 1;
      summary.counts.drafts_email += 1;
    }
    await route.fulfill({ response: res, json: summary });
  });
  await app.goto('#/followups');
  await ready(page);
  await expect(row(page, due.domain).getByRole('button', { name: `Draft follow-up, ${due.domain}` })).toBeVisible();
  const summary = async () => (await (await page.request.get(app.server.apiUrl('/api/summary'))).json()).counts;
  const countsBefore = await summary();

  // A chat turn bounces an awaiting contact (none of the summary's counts move), and a draft is
  // written elsewhere.
  await page.request.post(app.server.apiUrl(`/api/followups/${target.domain}/mark`), { data: { value: 'bounced' } });
  const countsAfter = await summary();
  expect([countsAfter.followups_due, countsAfter.replied, countsAfter.sent]).toEqual([countsBefore.followups_due, countsBefore.replied, countsBefore.sent]);
  drafted = true;

  // The store's next refresh (every 30s, or on coming back to the tab) brings both in.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(row(page, due.domain).getByRole('link', { name: `Review draft, ${due.domain}` })).toBeVisible();
  await expect(tab(page, 'Awaiting').locator('.tab-count')).toHaveText(count('awaiting', -1));
  await expect(tab(page, 'Bounced').locator('.tab-count')).toHaveText(count('bounced', 1));
});

test('a background refresh reloads the drafts list only when the draft count moves', async ({ app, page }) => {
  const drafts = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/drafts') drafts.push(req);
  });
  let extra = 0;
  await page.route('**/api/summary', async (route) => {
    const res = await route.fetch();
    const summary = await res.json();
    summary.counts.drafts_email += extra;
    await route.fulfill({ response: res, json: summary });
  });
  await app.goto('#/followups');
  await ready(page);
  expect(drafts).toHaveLength(1);
  // The store refreshes (every 30s, or on coming back to the tab): the list is asked again,
  // but with the same number of email drafts the heavy drafts list is not.
  const refresh = async () => {
    const list = page.waitForResponse((res) => isList(new URL(res.url())));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await list;
    // One more round trip, so a drafts request sent alongside the list has been seen.
    await page.evaluate(() => fetch('/assets/js/core/api.js').then((res) => res.text()));
  };
  await refresh();
  expect(drafts).toHaveLength(1);
  // A draft made or discarded elsewhere moves the count: then it is.
  extra = 1;
  await refresh();
  expect(drafts).toHaveLength(2);
  await refresh();
  expect(drafts).toHaveLength(2);
});

test('a reply check credits only what changed after it started', async ({ app, page }) => {
  await app.goto('#/followups');
  await ready(page);
  const list = async () => (await (await page.request.get(app.server.apiUrl('/api/followups'))).json());
  const now = await list();
  const outside = now.find((f) => f.state === 'awaiting');
  const mine = now.find((f) => f.state === 'due' && f.to);
  // A chat turn bounces someone after this list loaded, and the screen hasn't refreshed since.
  await page.request.post(app.server.apiUrl(`/api/followups/${outside.domain}/mark`), { data: { value: 'bounced' } });
  // A hand mark finishes, but the list reload after it is slow: the check starts before it lands.
  const gate = await hold(page, isList);
  await markRow(page, mine.domain, 'replied');
  await expect(toastWith(page, `Marked ${mine.domain} as replied.`)).toBeVisible();
  await expect.poll(() => gate.seen.length).toBe(1);
  await expect(row(page, mine.domain)).toBeVisible();
  await checkBtn(page).click();
  gate.release();

  // The fake agent marks nothing: neither change is the check's.
  await expect(notice(page).locator('.fu-changes')).toHaveText('Nothing was marked replied or bounced.', { timeout: AGENT_MS });
  await expect(row(page, mine.domain)).toHaveCount(0);
  const after = await list();
  expect(after.find((f) => f.domain === outside.domain).state).toBe('bounced');
  expect(after.find((f) => f.domain === mine.domain).state).toBe('replied');
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
  // What the filter leaves is said to screen readers too, through the screen's status line.
  const live = page.locator('#view').getByRole('status');
  await filter.fill('COMPANY-12');
  await expect(rows(page)).toHaveCount(10); // company-120 … company-129, any case
  await expect(tab(page, 'Due').locator('.tab-count')).toHaveText('10');
  await expect(page).toHaveURL(hashIs('#/followups?q=COMPANY-12'));
  await expect(live).toHaveText('10 follow-ups under Due match “COMPANY-12”.');
  await filter.fill('nobody-here');
  await expect(page.locator('.fu-content')).toContainText('No follow-ups match “nobody-here”');
  await expect(live).toHaveText('No follow-ups match “nobody-here”. No domain or emailed address under any tab contains that text.');
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(rows(page)).toHaveCount(100);
  await expect(filter).toHaveValue('');
  await expect(filter).toBeFocused();
  await expect(page).toHaveURL(hashIs('#/followups'));
  await expect(live).toHaveText('250 follow-ups under Due.');
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
  // The filter can be typed into meanwhile.
  const filter = page.getByRole('searchbox', { name: 'Filter follow-ups' });
  await expect(filter).toBeVisible();

  gate.release();
  await expect(page.locator('.fu-content')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.fu-content')).toContainText("Couldn't load follow-ups");
  await expect(page.locator('.fu-content')).toContainText('database is locked');
  // Nothing loaded, so there is nothing to filter.
  await expect(filter).toBeHidden();

  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await ready(page);
  await expect(rows(page).first()).toBeVisible();
  await expect(filter).toBeVisible();
  await expect(page.locator('.fu-content')).not.toContainText("Couldn't load follow-ups");
});

test('a stale session says what to do, without repeating the banner', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  // The token no longer matches: every request is refused, not just the list.
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.fulfill({ status: 401, body: 'unauthorized' }));
  await app.goto('#/followups');
  // The shell's banner gives the whole sentence once; the screen only says what to do.
  await expect(page.locator('.session-banner')).toContainText("This tab's session is stale");
  const content = page.locator('.fu-content');
  await expect(content).toContainText("Couldn't load follow-ups");
  await expect(content.locator('.empty-state')).toContainText('Reopen coldtrail from your terminal.');
  await expect(content).not.toContainText("This tab's session is stale");
  await checkBtn(page).click();
  await expect(notice(page)).toHaveClass(/fu-notice-err/);
  await expect(notice(page)).toContainText('Reply check failed');
  await expect(notice(page)).toContainText('Reopen coldtrail from your terminal.');
  await expect(notice(page)).not.toContainText("This tab's session is stale");
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
  // A state this UI doesn't know is still listed (under Awaiting), with its raw label as text.
  await expect(tab(page, 'Awaiting').locator('.tab-count')).toHaveText('1');
  await tab(page, 'Awaiting').click();
  const odd = row(page, 'weird.example');
  await expect(odd.locator('.badge')).toHaveText('<b onmouseover=window.__xss=3>odd</b>');
  await expect(odd.locator('b')).toHaveCount(0);
  await tab(page, 'Due').click();
  await checkBtn(page).click();
  const md = notice(page).locator('.fu-md');
  await expect(md).toContainText('<img src=x onerror=window.__xss=4>');
  await expect(md.locator('strong')).toHaveText('1');
  await expect(md.locator('img, script, a')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('names every object inherits are neither tabs nor states', async ({ app, page }) => {
  // A row's state turns into "constructor" during a reply check.
  let checked = false;
  const one = { domain: 'proto.example', to: 'founder@proto.example', days: 5, touches: 1 };
  await page.route(isList, (route) => route.fulfill({ json: [{ ...one, state: checked ? 'constructor' : 'due' }] }));
  await page.route('**/api/followups/check', (route) => {
    checked = true;
    return route.fulfill({ json: { ok: true, message: 'Done.' } });
  });

  // From the address, on opening the screen and on a change while it is open: the default tab.
  await app.goto('#/followups?tab=constructor');
  await ready(page);
  await expect(tab(page, 'Due')).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page)).toHaveCount(1);
  for (const name of ['toString', 'hasOwnProperty', 'valueOf']) {
    await page.goto(app.server.url(`#/followups?tab=${name}`));
    await expect(tab(page, 'Due')).toHaveAttribute('aria-selected', 'true');
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('.fu-content .skeleton')).toHaveCount(0);
  }

  // From the server: listed under Awaiting with its raw label, and the check still finishes.
  await checkBtn(page).click();
  await expect(notice(page).locator('.fu-changes')).toHaveText('Nothing was marked replied or bounced.');
  await expect(checkBtn(page)).toHaveText('Check for replies');
  await expect(tab(page, 'Awaiting').locator('.tab-count')).toHaveText('1');
  await tab(page, 'Awaiting').click();
  await expect(row(page, one.domain).locator('.badge')).toHaveText('constructor');
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
  await expect(checkBtn(page)).toHaveText('Checking for replies…');
  await expect.poll(ours).toBe(1);

  await nav.getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect.poll(ours).toBe(0);

  // Coming back mid-check shows it still running.
  await page.goBack();
  await ready(page);
  await expect(checkBtn(page)).toHaveText('Checking for replies…');
  await expect(notice(page)).toContainText('Checking Gmail for replies');
  await expect.poll(ours).toBe(1);
  await page.goForward();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect.poll(ours).toBe(0);

  // It finishes while elsewhere: a toast says what it found, and the result is waiting on
  // Follow-ups.
  gate.release();
  await expect(
    toastWith(page, 'Reply check finished: nothing was marked replied or bounced. The details are on Follow-ups.'),
  ).toBeVisible({ timeout: AGENT_MS });
  expect(await ours()).toBe(0);
  await page.goBack();
  await ready(page);
  await expect(notice(page)).toContainText('Reply check finished');
  await expect(notice(page).locator('.fu-changes')).toHaveText('Nothing was marked replied or bounced.');
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

test('the tabs sit as far under the page head as on Pipeline', async ({ app, page }) => {
  // From the head's bottom edge to the selected tab's top: the same on every tabbed screen.
  const gap = (list) =>
    list.locator('[aria-selected="true"]').evaluate((el) =>
      Math.round(el.getBoundingClientRect().top - document.querySelector('#view .page-head').getBoundingClientRect().bottom),
    );
  await app.goto('#/pipeline');
  const stages = page.getByRole('tablist', { name: 'Stage' });
  await expect(stages).toBeVisible();
  const pipeline = await gap(stages);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Follow-ups\b/ }).click();
  await ready(page);
  expect(await gap(tablist(page))).toBe(pipeline);
});

test('laptop widths: the table fits without scrolling sideways, even with long names', async ({ app, page }) => {
  // Names as long as the table shows in full, on a Due row (all three actions, one of them busy),
  // beside a Due row reached only on LinkedIn (the widest next step), and on an Awaiting row with
  // the widest state and time.
  const long = 'a-company-with-a-forty-character-name.io';
  const email = 'jonathan.whitfield@brightwater-analytics.com';
  await page.route(isList, (route) =>
    route.fulfill({
      json: [
        { domain: long, to: email, days: 9, touches: 2, state: 'due' },
        { domain: `b${long.slice(1)}`, to: email, days: 6, touches: 1, state: 'due' },
        { domain: `d${long.slice(1)}`, to: null, days: 12, touches: 1, state: 'due' },
        { domain: `c${long.slice(1)}`, to: email, days: 0, touches: 3, state: 'awaiting' },
      ],
    }),
  );
  // The second row's bounce never lands, so its Mark bounced stays busy (spinner and all).
  await page.route(`**/api/followups/b${long.slice(1)}/mark`, () => {});
  await app.goto('#/followups');
  await ready(page);
  await markRow(page, `b${long.slice(1)}`, 'bounced');
  await expect(row(page, `b${long.slice(1)}`).locator('[data-action="bounced"]')).toHaveAttribute('aria-busy', 'true');
  await expect(row(page, `d${long.slice(1)}`).locator('.fu-hint')).toHaveText('Follow up on LinkedIn');

  // Every width from just over the card layout to a wide window, with the sidebar beside it.
  const sideways = [];
  for (const label of ['Due', 'Awaiting']) {
    if (label !== 'Due') await tab(page, label).click();
    for (let width = 1180; width <= 1480; width += 10) {
      await page.setViewportSize({ width, height: 900 });
      const over = await page.locator('.fu-content').evaluate((el) => {
        const wrap = el.querySelector('.table-wrap');
        return wrap.scrollWidth - wrap.clientWidth;
      });
      if (over > 0) sideways.push(`${label} at ${width}px: ${over}px`);
    }
  }
  expect(sideways).toEqual([]);
  // A cut name is still there in full, on hover.
  await expect(row(page, `c${long.slice(1)}`).locator('.fu-email')).toHaveAttribute('title', email);
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
  // The cards keep the next step ("Follow-up 1 of 2"), under the badge.
  await expect(first.locator('.fu-hint')).toBeVisible();
  await expect(first.locator('.fu-hint')).toHaveText(/^Follow-up \d of 2$/);

  // The filter goes under the tabs, and the rule stays under the tabs (the selected tab's
  // underline sits on it), not under the filter.
  const box = async (loc) => loc.boundingBox();
  const [list, filter] = [await box(tablist(page)), await box(page.locator('.fu-filter'))];
  expect(filter.y).toBeGreaterThanOrEqual(list.y + list.height);
  expect(await tablist(page).evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe('1px');
  expect(await page.locator('.fu-tools').evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe('0px');
  const selected = await box(tab(page, 'Due'));
  expect(Math.abs(selected.y + selected.height - (list.y + list.height))).toBeLessThanOrEqual(1.5);

  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expectAccessible(page);
  await expect.poll(scrollWidth).toBeLessThanOrEqual(390);
});

test('small phone: card text wraps in place, and the tabs show there are more', async ({ app, page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const fresh = 'just-now.example';
  await page.route(isList, (route) =>
    route.fulfill({
      json: [
        { domain: fresh, to: `founder@${fresh}`, days: 0, touches: 1, state: 'awaiting' },
        { domain: 'a-company-name-far-too-long-for-a-phone.example', to: 'someone.with.a.long.name@a-company-name-far-too-long-for-a-phone.example', days: 2, touches: 1, state: 'awaiting' },
        { domain: 'due.example', to: 'founder@due.example', days: 6, touches: 1, state: 'due' },
        { domain: 'reached-on-linkedin.example', to: null, days: 6, touches: 1, state: 'due' },
      ],
    }),
  );
  await app.goto('#/followups?tab=awaiting');
  await ready(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  // "Less than a day since the last send" wraps inside its card instead of running past it.
  const overflowing = () =>
    page.locator('.fu-content td').evaluateAll((tds) => tds.filter((td) => td.scrollWidth > td.clientWidth + 1).map((td) => td.className));
  await expect.poll(overflowing).toEqual([]);
  const days = row(page, fresh).locator('.fu-c-days');
  await expect(days).toContainText('Less than a day');
  expect(await days.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(20); // two lines

  // The tabs with their counts are wider than the screen: the edge fade says there is more.
  const list = tablist(page);
  const [scroll, client] = await list.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(scroll).toBeGreaterThan(client);
  await expect(list).toHaveAttribute('data-more', /\bend\b/);

  // The widest next step fits its card too.
  await tab(page, 'Due').click();
  await expect(row(page, 'reached-on-linkedin.example').locator('.fu-hint')).toHaveText('Follow up on LinkedIn');
  await expect.poll(overflowing).toEqual([]);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

// The next two tests add companies of their own to the workspace (no test after them uses the
// full seed's server).

test('a company reached only on LinkedIn says so, even with an email on file', async ({ app, page }) => {
  const domain = 'li-only.example';
  dbExec(
    app.server,
    `INSERT INTO companies (domain, name, status) VALUES ('${domain}', 'Li Only', 'sent');
     INSERT INTO contacts (id, domain, founder_name, email, linkedin_url) VALUES
       (95001, '${domain}', 'Lia Park', 'lia@${domain}', 'https://www.linkedin.com/in/lia-park');
     INSERT INTO outreach (domain, contact_id, channel, subject, body, status, created_at, sent_at) VALUES
       ('${domain}', 95001, 'linkedin', '', 'Hi Lia', 'sent', datetime('now', '-6 days'), datetime('now', '-6 days'));`,
  );
  // `to` is the address an email went to: none, though the contact has one.
  const listed = (await (await page.request.get(app.server.apiUrl('/api/followups'))).json()).find((f) => f.domain === domain);
  expect(listed).toMatchObject({ to: null, touches: 1, state: 'due' });

  await app.goto('#/followups');
  await ready(page);
  const r = row(page, domain);
  await expect(r.locator('.fu-email')).toHaveText('Reached on LinkedIn');
  await expect(r).not.toContainText('No email on file');
  // Due, with no email to follow up on: the row says how to follow up instead.
  await expect(r.locator('.fu-state')).toHaveText('DueFollow up on LinkedIn');
  await expect(r.getByRole('button', { name: /^Draft follow-up/ })).toHaveCount(0);
  await expect(r.getByRole('button', { name: `Mark replied, ${domain}` })).toBeVisible();

  // The filter goes by the address an email went to, and the no-match text says no more than that.
  await page.getByRole('searchbox', { name: 'Filter follow-ups' }).fill(`lia@${domain}`);
  const empty = page.locator('.fu-content .empty-state');
  await expect(empty).toContainText(`No follow-ups match “lia@${domain}”`);
  await expect(empty).toContainText('No domain or emailed address under any tab contains that text.');
});

test('a mark names every waiting draft it deletes', async ({ app, page }) => {
  // Each company was emailed 5–7 days ago (Due). Waiting: a follow-up already in Gmail plus a
  // LinkedIn note; a follow-up only in coldtrail; nothing; and, once the list is on screen, a
  // LinkedIn note edited by hand.
  dbExec(
    app.server,
    `INSERT INTO companies (domain, name, status) VALUES
       ('note.example', 'Note', 'sent'), ('ingmail.example', 'In Gmail', 'sent'),
       ('pending.example', 'Pending', 'sent'), ('clean.example', 'Clean', 'sent');
     INSERT INTO contacts (id, domain, founder_name, email, linkedin_url) VALUES
       (95011, 'note.example', 'Nora Lee', 'nora@note.example', 'https://www.linkedin.com/in/nora-lee'),
       (95012, 'ingmail.example', 'Gil Ames', 'gil@ingmail.example', 'https://www.linkedin.com/in/gil-ames'),
       (95013, 'pending.example', 'Pat Moss', 'pat@pending.example', NULL),
       (95014, 'clean.example', 'Cy Lane', 'cy@clean.example', NULL);
     INSERT INTO outreach (domain, contact_id, channel, subject, body, status, gmail_draft_id, created_at, sent_at) VALUES
       ('note.example', 95011, 'email', 'Quick idea', 'Hi Nora', 'sent', NULL, datetime('now', '-5 days'), datetime('now', '-5 days')),
       ('ingmail.example', 95012, 'email', 'Hello', 'Hi Gil', 'sent', NULL, datetime('now', '-6 days'), datetime('now', '-6 days')),
       ('ingmail.example', 95012, 'email', 'Re: Hello', 'Following up', 'drafted', 'r-gmail-1', datetime('now'), NULL),
       ('ingmail.example', 95012, 'linkedin', '', 'Hi Gil', 'draft_pending', NULL, datetime('now'), NULL),
       ('pending.example', 95013, 'email', 'Hey', 'Hi Pat', 'sent', NULL, datetime('now', '-7 days'), datetime('now', '-7 days')),
       ('pending.example', 95013, 'email', 'Re: Hey', 'Following up', 'draft_pending', NULL, datetime('now'), NULL),
       ('clean.example', 95014, 'email', 'Hi', 'Hi Cy', 'sent', NULL, datetime('now', '-6 days'), datetime('now', '-6 days'));`,
  );
  const body = (domain, value) => markDialog(page, domain, value).locator('.dialog-body');
  const ask = async (domain, value) => {
    await row(page, domain).getByRole('button', { name: `Mark ${value}, ${domain}` }).click();
    await expect(markDialog(page, domain, value)).toBeVisible();
  };
  const cancel = async (domain, value) => {
    await markDialog(page, domain, value).getByRole('button', { name: 'Cancel' }).click();
    await expect(markDialog(page, domain, value)).toHaveCount(0);
  };
  await app.goto('#/followups');
  await ready(page);
  // Written after the list loaded (a scheduled run, another tab).
  dbExec(
    app.server,
    `INSERT INTO outreach (domain, contact_id, channel, subject, body, status, created_at) VALUES
       ('note.example', 95011, 'linkedin', '', 'Hi Nora, a note I edited by hand', 'draft_pending', datetime('now'));`,
  );

  await ask('ingmail.example', 'bounced');
  await expect(body('ingmail.example', 'bounced')).toHaveText(
    'ingmail.example moves to Bounced and gets no more follow-ups. Its follow-up draft and LinkedIn note are deleted. The copy in your Gmail Drafts stays there. coldtrail can’t undo this.',
  );
  await cancel('ingmail.example', 'bounced');
  await ask('pending.example', 'replied');
  await expect(body('pending.example', 'replied')).toHaveText(
    'pending.example moves to Replied and gets no more follow-ups. Its follow-up draft is deleted. coldtrail can’t undo this.',
  );
  await cancel('pending.example', 'replied');
  await ask('clean.example', 'replied');
  await expect(body('clean.example', 'replied')).toHaveText('clean.example moves to Replied and gets no more follow-ups. coldtrail can’t undo this.');
  await cancel('clean.example', 'replied');

  // Drafts is asked as the confirm opens, so a note written since the list loaded is named too.
  await ask('note.example', 'replied');
  await expect(body('note.example', 'replied')).toHaveText(
    'note.example moves to Replied and gets no more follow-ups. Its LinkedIn note is deleted. coldtrail can’t undo this.',
  );
  // And it is.
  await markDialog(page, 'note.example', 'replied').getByRole('button', { name: 'Mark replied' }).click();
  await expect(toastWith(page, 'Marked note.example as replied.')).toBeVisible();
  expect(app.server.query("SELECT channel, status FROM outreach WHERE domain = 'note.example'")).toEqual([{ channel: 'email', status: 'replied' }]);

  // When Drafts can't be read at all, the confirm still says what a mark does to a waiting draft.
  app.allowConsole(/Failed to load resource/);
  await page.route('**/api/drafts', (route) => route.fulfill({ status: 500, body: 'database is locked' }));
  await page.reload();
  await ready(page);
  await ask('clean.example', 'bounced');
  await expect(body('clean.example', 'bounced')).toHaveText(
    'clean.example moves to Bounced and gets no more follow-ups. Any draft waiting for it is deleted too. coldtrail can’t undo this.',
  );
  await cancel('clean.example', 'bounced');
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

    // The real check has nothing to do and says so. With no one to count, the progress line
    // doesn't say "from 0 contacts".
    const gate = await hold(page, '**/api/followups/check');
    await checkBtn(page).click();
    await expect(notice(page).locator('.fu-notice-title')).toHaveText('Checking Gmail for replies…');
    gate.release();
    await expect(notice(page)).toContainText('Nothing is awaiting a reply.', { timeout: AGENT_MS });

    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

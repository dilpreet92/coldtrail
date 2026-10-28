// Drafts (spec §5.4): the review queue. Tabs with counts, a filter, a list that renders at most
// 100 rows at a time, J/K/Enter/Esc, autosave (flushed before switching drafts), email vs LinkedIn
// detail, the parked banner, Discard, the Send all dialog with exact counts and its one-run-at-a-
// time guard, the first-send confirm, Open in LinkedIn + "Did it send?", the LinkedIn pollers
// (finished at the cap, stopped on leaving), drafts arriving while the screen is open, and the
// phone list keeping its place.
//
// Tests share one server in order, so the read-only and count-sensitive tests come first and
// each mutating test uses its own draft. Every LinkedIn route that would drive Chrome is
// intercepted by the harness (assist, send, send-all); confirm and discard are real.
//
// coldtrail sends LinkedIn invites itself only 08:00–20:00 local and with a connected session,
// so every test that expects it to pins the page's clock to the morning (`daytime`) and reports
// a connected session (`LI_AUTO`): none of them depend on when the suite runs.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { COMPANIES, SEED } from '../harness/seed.mjs';
import { fmtNum } from '../../../ui/js/core/format.js';

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashIs = (hash) => new RegExp(`${reEscape(hash)}$`);

const list = (page) => page.getByRole('listbox', { name: 'Drafts' });
const options = (page) => list(page).getByRole('option');
const selected = (page) => list(page).locator('[role="option"][aria-selected="true"]');
const optionFor = (page, domain) => list(page).locator(`[role="option"][data-domain="${domain}"]`);
const detail = (page) => page.locator('.draft');
const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}\\b`) });
const toast = (page) => page.locator('#toasts .toast');
const saveState = (page) => detail(page).locator('.draft-save');
const note = (page) => detail(page).getByRole('textbox', { name: 'Connection note' });
const emailBody = (page) => detail(page).getByRole('textbox', { name: 'Body' });

const person = (domain) => COMPANIES.find((c) => c.domain === domain).contacts[0].founder_name;
const firstName = (domain) => person(domain).split(' ')[0];

// Drafts the tests act on, each used by one mutating test only.
const pendingEmail = SEED.emailDrafts.filter((d) => d.status === 'draft_pending');
const plainEmail = pendingEmail.filter((d) => d.domain !== SEED.xss.domain);
const inGmail = SEED.emailDrafts.filter((d) => d.status === 'drafted');
const sendableLinkedin = SEED.linkedinDrafts.filter((d) => !d.parked);
const EMAIL = {
  autosave: plainEmail[0],
  quickSwitch: plainEmail[1],
  quickClick: plainEmail[2],
  sendNow: plainEmail[3],
  discard: plainEmail[4],
  discardFails: plainEmail[5],
  twice: plainEmail[6],
  // (plainEmail[7] is SEED.drafts.order[40], the phone test's row: left alone.)
  leaveRetry: plainEmail[8],
};
const LI = {
  autosave: sendableLinkedin[0],
  counter: sendableLinkedin[1],
  assistYes: sendableLinkedin[2],
  assistNo: sendableLinkedin[3],
  invited: sendableLinkedin[4],
  rowSend: sendableLinkedin[5],
  unconfirmed: sendableLinkedin[6],
  waits: sendableLinkedin[7],
  late: sendableLinkedin[8],
  evening: sendableLinkedin[9],
  discardOpening: sendableLinkedin[10],
};
const ROW_TIMEOUT_MS = 240_000; // drafts.js: how long a per-row LinkedIn send is watched
const FILTER_URL_MS = 250; // drafts.js: the filter reaches the URL this long after the last key

/** Stop the page's clock (installed with `page.clock.install()` before the page loaded): no
 *  timer fires on its own until `page.clock.runFor()` or `page.clock.resume()`. */
async function freeze(page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

/** The filter as the URL holds it (`q`), or null. */
const urlFilter = (page) => page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] || '').get('q'));

/** LinkedIn auto-send on, with a connected session (the seeded workspace never connected one). */
const LI_AUTO = { linkedin_auto_send: true, linkedin_connected: true };

/** Today at `hour`:00 in this machine's time zone (the browser's and the server's). */
function todayAt(hour) {
  const t = new Date();
  t.setHours(hour, 0, 0, 0);
  return t;
}

// A route handler still answering when a test ends (say the /api/status a screen reads as it
// mounts) would fail the test with "Response has been disposed" as the page closes under it.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

/** Pin the page's clock (time still runs) inside LinkedIn's 08:00–20:00 sending hours. */
const daytime = (page) => page.clock.install({ time: todayAt(11) });

/** The list has rendered (the first load finished). */
async function listReady(page) {
  await expect(options(page).first()).toBeVisible();
}

/** Answer /api/status with the real body plus `patch` (e.g. LinkedIn auto-send on), or plus
 *  what `patch()` returns at the time of each request. */
async function patchStatus(page, patch) {
  await page.route(
    (url) => url.pathname === '/api/status',
    async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, ...(typeof patch === 'function' ? patch() : patch) } });
    },
  );
}

/** Add an older copy of a domain's pending draft, as pressing Draft follow-up twice leaves one
 *  (`draft::followup_add` always inserts). */
function addOlderDraft(server, domain) {
  const db = new DatabaseSync(join(server.home, 'outreach.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const { changes } = db
      .prepare(
        `INSERT INTO outreach (domain, contact_id, channel, subject, body, status, created_at)
         SELECT domain, contact_id, channel, 'Following up', body, 'draft_pending', datetime(created_at, '-1 minute')
         FROM outreach WHERE domain = ? AND status = 'draft_pending' LIMIT 1`,
      )
      .run(domain);
    expect(changes).toBe(1);
  } finally {
    db.close();
  }
}

async function realStatus(request, server) {
  const res = await request.get(server.apiUrl('/api/status'));
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function emailAutoSend(request, server, enabled) {
  const res = await request.post(server.apiUrl('/api/destination/auto-send'), { data: { enabled } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

// Every read of the workspace DB goes through `rowsNow`: the page's own requests keep the server
// writing while a test asserts, and the harness's `query` has no busy timeout, so a read can hit
// "database is locked". expect.poll doesn't retry a callback that throws, so a locked read
// returns undefined and the poll tries again.
function rowsNow(server, sql, ...params) {
  try {
    return server.query(sql, ...params);
  } catch (err) {
    if (/locked|busy/i.test(String(err && err.message))) return undefined;
    throw err;
  }
}

/** Assert on rows from the workspace DB, retried until they match: `await dbRows(…).toEqual(…)`. */
const dbRows = (server, sql, ...params) => expect.poll(() => rowsNow(server, sql, ...params));

const OUTREACH_SQL = 'SELECT channel, status, body, subject FROM outreach WHERE domain = ? ORDER BY id';
/** A domain's outreach rows, for `await outreach(server, domain).toEqual([…])`. */
const outreach = (server, domain) => dbRows(server, OUTREACH_SQL, domain);

/** The stored body of a domain's first outreach row (undefined while locked), for expect.poll. */
function storedBody(server, domain) {
  const rows = rowsNow(server, OUTREACH_SQL, domain);
  return rows && rows[0] ? rows[0].body : undefined;
}

test('lists seeded drafts with tab counts and the caps line', async ({ app, page, server, request }) => {
  await app.goto('#/drafts');
  await listReady(page);
  await expect(page.locator('#view h1')).toHaveText('Drafts');
  await expect(page.locator('.page-desc')).toContainText(`${fmtNum(SEED.counts.drafts)} waiting for review.`);

  await expect(tab(page, 'All').locator('.tab-count')).toHaveText(fmtNum(SEED.counts.drafts));
  await expect(tab(page, 'Email').locator('.tab-count')).toHaveText(fmtNum(SEED.drafts.email));
  await expect(tab(page, 'LinkedIn').locator('.tab-count')).toHaveText(fmtNum(SEED.drafts.linkedin));
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true');
  await expect(options(page)).toHaveCount(SEED.counts.drafts);

  // Server order (newest first), company names from the companies lookup, channel tags.
  await expect(options(page).nth(1)).toHaveAttribute('data-domain', SEED.drafts.order[1]);
  const li = optionFor(page, LI.autosave.domain);
  await expect(li.locator('.draft-row-title')).toHaveText(LI.autosave.name);
  await expect(li.locator('.chan-tag')).toHaveText('LinkedIn');
  const email = optionFor(page, EMAIL.autosave.domain);
  await expect(email.locator('.chan-tag')).toHaveText('Email');
  // An email draft names its recipient (the contact the email goes to).
  await expect(email.locator('.draft-row-sub')).toContainText(person(EMAIL.autosave.domain));
  await expect(optionFor(page, SEED.drafts.parked.domain).locator('.draft-row-tags')).toContainText('Parked');
  await expect(optionFor(page, inGmail[0].domain).locator('.draft-row-tags')).toContainText('In Gmail');

  // The caps line on the LinkedIn tab states today's and this week's usage against the caps.
  const st = await realStatus(request, server);
  await tab(page, 'LinkedIn').click();
  await expect(page).toHaveURL(/#\/drafts\/[^?]+\?tab=linkedin$/);
  const stats = page.locator('.drafts-stats');
  await expect(stats).toContainText(`${SEED.capUsage.linkedinToday}/${st.linkedin_daily_cap} today`);
  await expect(stats).toContainText(`${SEED.capUsage.linkedin7d}/${st.linkedin_weekly_cap} this week`);
  await expect(stats).toContainText('Auto-send off');
  await expect(options(page)).toHaveCount(SEED.drafts.linkedin);
});

test('send all dialog states exact counts', async ({ app, page, server, request }) => {
  const st = await realStatus(request, server);
  const pending = pendingEmail.length;
  const sendable = SEED.drafts.linkedinSendable;
  const { linkedinToday: today, linkedin7d: week } = SEED.capUsage;
  const upTo = Math.min(sendable, st.linkedin_daily_cap - today, st.linkedin_weekly_cap - week);

  let status = {}; // on top of the real /api/status
  await daytime(page);
  await patchStatus(page, () => status);
  await app.goto('#/drafts');
  await listReady(page);
  const sendAll = page.getByRole('button', { name: 'Send all…' });

  // Both auto-sends off (the seeded config): emails become Gmail drafts, LinkedIn stays put.
  await sendAll.click();
  let dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  await expect(dialog).toBeVisible();
  // Focus starts on Cancel, not on the Settings link in the list (Enter there would leave).
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog.locator('.sendall-email')).toContainText(
    `Create ${pending} Gmail drafts. Nothing is sent: they wait in your Gmail Drafts for you to send.`,
  );
  await expect(dialog.locator('.sendall-email')).toContainText(`${inGmail.length} already in Gmail are left out.`);
  await expect(dialog.locator('.sendall-linkedin')).toContainText(
    `LinkedIn auto-send is off, so ${sendable} invites stay here.`,
  );
  await expect(dialog.getByRole('link', { name: 'Settings → Sending' })).toHaveAttribute('href', '#/settings?tab=sending');
  await expect(dialog.getByRole('button', { name: `Create ${pending} Gmail drafts`, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(sendAll).toBeFocused();

  // Both on: the email cap and LinkedIn's daily/weekly usage bound what goes out today.
  status = { auto_send: true, ...LI_AUTO };
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  await expect(dialog.locator('.sendall-email')).toContainText(
    `Up to ${pending} emails today (cap ${st.daily_send_cap} a day).`,
  );
  await expect(dialog.locator('.sendall-linkedin')).toContainText(
    `Up to ${upTo} of ${sendable} LinkedIn invites today (${today}/${st.linkedin_daily_cap} today, ` +
      `${week}/${st.linkedin_weekly_cap} this week); 1 parked draft excluded.`,
  );
  await expect(
    dialog.getByRole('button', { name: `Send ${pending} emails and ${upTo} invites`, exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // When the status reports today's email sends (`email_sent_today`, not served yet: see
  // deliver::sent_today), the line counts them against the cap, as spec §5.4 words it.
  const emailToday = SEED.capUsage.emailToday;
  const emailUpTo = Math.min(pending, st.daily_send_cap - emailToday);
  status = { auto_send: true, ...LI_AUTO, email_sent_today: emailToday };
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  await expect(dialog.locator('.sendall-email')).toContainText(
    `Up to ${emailUpTo} emails today (cap ${st.daily_send_cap}, ${emailToday} already sent).`,
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Today's cap used up: no email is offered, the invites still are.
  status = { auto_send: true, ...LI_AUTO, email_sent_today: st.daily_send_cap };
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  await expect(dialog.locator('.sendall-email')).toContainText(
    `None go out today: the email cap is reached (${st.daily_send_cap} of ${st.daily_send_cap} sent).`,
  );
  await expect(dialog.getByRole('button', { name: `Send ${upTo} invites`, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  status = { auto_send: true, ...LI_AUTO };

  // The LinkedIn tab's Send all covers LinkedIn only.
  await tab(page, 'LinkedIn').click();
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  await expect(dialog.locator('.sendall-email')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: `Send ${upTo} invites`, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Nothing was sent or started.
  expect(app.calls).toEqual([]);
  await dbRows(server, "SELECT count(*) AS n FROM outreach WHERE status IN ('draft_pending','drafted')").toEqual([
    { n: SEED.counts.drafts },
  ]);
});

test('send all runs once, even when its dialog closes or the screen is left mid-run', async ({ app, page }) => {
  const pending = pendingEmail.length;
  await patchStatus(page, { auto_send: true });
  // Every send waits at the gate, so the run is still going while the test looks around.
  const sends = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => /^\/api\/drafts\/[^/]+\/send$/.test(url.pathname),
    async (route) => {
      sends.push(new URL(route.request().url()).pathname);
      await gate;
      await route.fulfill({ json: { ok: true, message: 'Sent.' } });
    },
  );
  await app.goto('#/drafts?tab=email');
  await listReady(page);
  const sendAll = page.locator('.page-actions .btn');
  const push = detail(page).locator('[data-action="push"]');
  await expect(sendAll).toHaveText('Send all…');
  await expect(push).toBeEnabled();

  await sendAll.click();
  const dialog = page.getByRole('dialog', { name: 'Send all email drafts' });
  await dialog.getByRole('button', { name: `Send ${pending} emails`, exact: true }).click();
  await expect(dialog.locator('.sendall-progress')).toHaveText(`Sending 1 of ${pending}…`);
  expect(sends).toHaveLength(1);

  // Esc closes the dialog; the run carries on, Send all shows how far it got and can't start
  // another, and Send now waits too.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(sendAll).toHaveText(`Sending email 1 of ${pending}…`);
  await expect(sendAll).toBeDisabled();
  await expect(sendAll).toBeFocused();
  await expect(push).toBeDisabled();
  await expect(detail(page).locator('.draft-hint')).toHaveText('Send all is sending your emails, one at a time.');
  await tab(page, 'All').click();
  await expect(sendAll).toBeDisabled();

  // Leave and come back: the new screen knows about the run.
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(hashIs('#/home'));
  await page.goBack();
  await listReady(page);
  await expect(sendAll).toHaveText(`Sending email 1 of ${pending}…`);
  await expect(sendAll).toBeDisabled();
  await expect(push).toBeDisabled();

  release();
  await expect(page.locator('#toasts .toast', { hasText: `Sent ${pending} emails.` })).toBeVisible();
  await expect(sendAll).toHaveText('Send all…');
  await expect(sendAll).toBeEnabled();
  await expect(push).toBeEnabled();
  // One send per email draft: none twice.
  expect([...sends].sort()).toEqual(pendingEmail.map((d) => `/api/drafts/${d.domain}/send`).sort());
});

test('J/K moves selection and URL', async ({ app, page }) => {
  const order = SEED.drafts.order;
  await app.goto('#/drafts');
  await listReady(page);
  // On a desktop the first draft opens at once.
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[0]}`));
  await expect(selected(page)).toHaveAttribute('data-domain', order[0]);

  await page.keyboard.press('j');
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[1]}`));
  await expect(selected(page)).toHaveAttribute('data-domain', order[1]);
  await expect(detail(page).locator('.draft-meta')).toContainText(order[1]);
  await page.keyboard.press('j');
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[2]}`));
  await page.keyboard.press('k');
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[1]}`));
  await expect(selected(page)).toHaveCount(1);

  // Enter jumps into the editor, Esc returns to the list on the selected draft.
  await page.keyboard.press('Enter');
  await expect(detail(page).locator('[data-editor]')).toBeFocused();
  await page.keyboard.press('j'); // typing, not moving
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[1]}`));
  await page.keyboard.press('Backspace'); // put the seeded text back
  await page.keyboard.press('Escape');
  await expect(selected(page)).toBeFocused();
  await expect(selected(page)).toHaveAttribute('data-domain', order[1]);

  // Arrow keys move inside the list too; Enter on a row opens its editor.
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[2]}`));
  await expect(selected(page)).toBeFocused();
  await page.keyboard.press('k');
  await page.keyboard.press('k');
  await page.keyboard.press('k'); // stops at the top
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[0]}`));
  await page.keyboard.press('Enter');
  await expect(detail(page).locator('[data-editor]')).toBeFocused();
  await page.keyboard.press('Escape');

  // A click selects, and the selection survives a reload.
  await optionFor(page, order[4]).click();
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[4]}`));
  await page.reload();
  await expect(selected(page)).toHaveAttribute('data-domain', order[4]);
});

test('hostile names and subjects render as text', async ({ app, page }) => {
  await app.goto(`#/drafts/${SEED.xss.domain}`);
  await listReady(page);
  const row = optionFor(page, SEED.xss.domain);
  await expect(row.locator('.draft-row-title')).toHaveText(SEED.xss.name);
  await expect(detail(page).getByRole('textbox', { name: 'Subject' })).toHaveValue(SEED.xss.subject);
  await expect(emailBody(page)).toHaveValue(SEED.xss.body);
  await expect(detail(page).locator('.draft-name')).toHaveText(SEED.xss.founder);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('#view img, #view script').count()).toBe(0);
});

test('tabs and filter narrow the list and live in the URL', async ({ app, page }) => {
  await page.clock.install();
  await app.goto('#/drafts?tab=email');
  await listReady(page);
  await expect(tab(page, 'Email')).toHaveAttribute('aria-selected', 'true');
  await expect(options(page)).toHaveCount(SEED.drafts.email);
  await expect(page.locator('.page-desc')).toContainText('Create Gmail draft puts it in your Gmail Drafts');

  const filter = page.getByRole('searchbox', { name: 'Filter drafts' });
  const target = EMAIL.autosave;
  await filter.fill(target.name.split(' ')[0].toLowerCase());
  await expect(optionFor(page, target.domain)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]q=${target.name.split(' ')[0].toLowerCase()}`));
  const shown = await options(page).count();
  expect(shown).toBeLessThan(SEED.drafts.email);

  // Arrow down from the filter lands on the list.
  await filter.press('ArrowDown');
  await expect(selected(page)).toBeFocused();

  // A name of two words: the URL keeps the filter trimmed, and catching up with it never takes
  // a space out of the box, even one left there past the URL's debounce. (The page's clock stands
  // still, so the debounce fires exactly when the test lets it.)
  const [word, rest] = target.name.split(' ');
  await expect(optionFor(page, target.domain).locator('.draft-row-title')).toHaveText(target.name);
  await freeze(page);
  await filter.fill('');
  await filter.pressSequentially(` ${word} `);
  await page.clock.runFor(FILTER_URL_MS + 50);
  await expect.poll(() => urlFilter(page)).toBe(word);
  await expect(filter).toHaveValue(` ${word} `);
  await filter.pressSequentially(rest);
  await page.clock.runFor(FILTER_URL_MS + 50);
  await expect.poll(() => urlFilter(page)).toBe(target.name);
  await expect(filter).toHaveValue(` ${target.name}`);
  await expect(options(page)).toHaveCount(1);
  await expect(optionFor(page, target.domain)).toBeVisible();
  await page.clock.resume();

  await filter.fill('zzzz-no-such-draft');
  await expect(options(page)).toHaveCount(0);
  await expect(page.getByText('No drafts match “zzzz-no-such-draft”')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(options(page)).toHaveCount(SEED.drafts.email);
  await expect(page).not.toHaveURL(/[?&]q=/);

  // Keyboard: arrow keys move between tabs.
  await tab(page, 'Email').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'LinkedIn')).toHaveAttribute('aria-selected', 'true');
  await expect(options(page)).toHaveCount(SEED.drafts.linkedin);
  await expect(page).toHaveURL(/[?&]tab=linkedin/);

  // A tab with nothing on it says so and offers the way back.
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      const res = await route.fetch();
      const rows = (await res.json()).filter((d) => d.channel === 'linkedin');
      await route.fulfill({ response: res, json: rows });
    },
  );
  await app.goto('#/drafts?tab=email');
  await expect(page.getByText('No email drafts waiting')).toBeVisible();
  await page.getByRole('button', { name: 'Show all drafts' }).click();
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true');
  await expect(options(page)).toHaveCount(SEED.drafts.linkedin);
});

test('a draft written while the screen is open shows up, with its company name', async ({ app, page }) => {
  // The agent drafts one more while Drafts is open: until then neither the queue, the summary
  // counts nor the companies lookup have it.
  const late = LI.late;
  let written = false;
  const patchJson = (match, patch) =>
    page.route(match, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: written ? body : patch(body) });
    });
  await patchJson(
    (url) => url.pathname === '/api/drafts',
    (rows) => rows.filter((r) => r.domain !== late.domain),
  );
  await patchJson(
    (url) => url.pathname === '/api/summary',
    (body) => ({
      ...body,
      counts: { ...body.counts, drafts: body.counts.drafts - 1, drafts_linkedin: body.counts.drafts_linkedin - 1 },
    }),
  );
  await patchJson(
    (url) => url.pathname === '/api/companies' && url.searchParams.get('stage') === 'drafted',
    (body) => ({ ...body, rows: body.rows.filter((r) => r.domain !== late.domain) }),
  );
  await app.goto('#/drafts');
  await listReady(page);
  const count = tab(page, 'All').locator('.tab-count');
  const before = Number(await count.textContent());
  await expect(optionFor(page, late.domain)).toHaveCount(0);

  written = true;
  // The shell's summary refresh (as on its 30s timer, or when the tab comes back into view).
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(count).toHaveText(String(before + 1));
  await expect(optionFor(page, late.domain).locator('.draft-row-title')).toHaveText(late.name);
});

test('a follow-up draft on a company already sent to shows its names', async ({ app, page }) => {
  // Draft follow-up leaves the company at "sent", so the drafted-companies lookup doesn't name it.
  const fu = COMPANIES.find((c) => c.followup === 'due' && c.status === 'sent' && c.contacts[0].email);
  const who = fu.contacts[0];
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      const res = await route.fetch();
      const rows = await res.json();
      const followup = {
        domain: fu.domain, to: who.email, subject: `Re: Quick idea for ${fu.name}`, body: `Hi, following up.`,
        status: 'draft_pending', gmail_draft_id: null, channel: 'email', auto_skip: null,
      };
      await route.fulfill({ response: res, json: [...rows, followup] });
    },
  );
  await app.goto('#/drafts?tab=email');
  await listReady(page);
  const row = optionFor(page, fu.domain);
  await expect(row.locator('.draft-row-title')).toHaveText(fu.name);
  await expect(row.locator('.draft-row-sub')).toHaveText(`${who.founder_name} · ${fu.domain}`);
});

test('a company with drafts on both channels warns that edits are shared', async ({ app, page }) => {
  // The server saves an edit per company, not per channel, so each draft says so.
  const e = EMAIL.autosave;
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      const res = await route.fetch();
      const rows = await res.json();
      const li = rows.find((r) => r.channel === 'linkedin' && !r.auto_skip);
      await route.fulfill({ response: res, json: [...rows, { ...li, domain: e.domain }] });
    },
  );
  await app.goto(`#/drafts/${e.domain}?channel=email`);
  await listReady(page);
  await expect(emailBody(page)).toBeVisible();
  const shared = detail(page).locator('.draft-shared');
  await expect(shared).toContainText('Edits here change both drafts.');
  await expect(shared).toContainText('also has a LinkedIn note waiting');
  await app.goto(`#/drafts/${e.domain}?channel=linkedin`);
  await expect(note(page)).toBeVisible();
  await expect(detail(page).locator('.draft-shared')).toContainText('also has an email waiting');
  // A draft with no twin on the other channel has no such warning.
  await optionFor(page, EMAIL.quickSwitch.domain).click();
  await expect(emailBody(page)).toBeVisible();
  await expect(detail(page).locator('.draft-shared')).toHaveCount(0);
});

test('renders at most 100 rows', async ({ app, page }) => {
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      const res = await route.fetch();
      const real = await res.json();
      const template = real.find((d) => d.channel === 'email' && d.status === 'draft_pending');
      const rows = Array.from({ length: 150 }, (_, i) => ({
        ...template,
        domain: `bulk-${String(i).padStart(3, '0')}.example`,
        to: `founder@bulk-${i}.example`,
        subject: `Bulk draft ${i}`,
      }));
      await route.fulfill({ response: res, json: rows });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/companies/bulk-'),
    (route) =>
      route.fulfill({
        json: {
          company: { domain: 'bulk.example', name: 'Bulk Co', status: 'drafted', first_seen: '', founder: null, email: null, source_query: 'Q9', linkedin: false },
          contacts: [],
          outreach: [],
        },
      }),
  );
  await app.goto('#/drafts');
  await listReady(page);
  await expect(options(page)).toHaveCount(100);
  await expect(tab(page, 'All').locator('.tab-count')).toHaveText('150');
  await expect(page.locator('.drafts-shown')).toHaveText('100 of 150 shown');
  const more = page.getByRole('button', { name: 'Show 50 more' });
  await more.click();
  await expect(options(page)).toHaveCount(150);
  await expect(more).toHaveCount(0);
  await optionFor(page, 'bulk-149.example').click();
  await expect(page).toHaveURL(hashIs('#/drafts/bulk-149.example'));

  // J past the 100th row is never blocked: the next row renders, selected and in view, and the
  // URL keeps in step.
  await app.goto('#/drafts/bulk-099.example');
  await expect(selected(page)).toHaveAttribute('data-domain', 'bulk-099.example');
  await expect(options(page)).toHaveCount(100);
  await page.keyboard.press('j');
  await expect(page).toHaveURL(hashIs('#/drafts/bulk-100.example'));
  await expect(selected(page)).toHaveAttribute('data-domain', 'bulk-100.example');
  await expect(selected(page)).toBeInViewport();
  await expect(detail(page).locator('.draft-meta')).toContainText('bulk-100.example');
});

test('edit autosaves and survives reload', async ({ app, page, server }) => {
  const d = LI.autosave;
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  await expect(note(page)).toHaveValue(d.body);
  const text = `${d.body}\nP.S. edited in the e2e suite.`;
  await note(page).fill(text);
  await expect(saveState(page)).toHaveText('Saving…');
  await expect(saveState(page)).toHaveText('Saved');
  await outreach(server, d.domain).toEqual([
    expect.objectContaining({ channel: 'linkedin', status: 'draft_pending', body: text }),
  ]);
  await page.reload();
  await expect(note(page)).toHaveValue(text);

  // Email drafts autosave subject and body together.
  const e = EMAIL.autosave;
  await optionFor(page, e.domain).click();
  const subject = detail(page).getByRole('textbox', { name: 'Subject' });
  await expect(subject).toHaveValue(e.subject);
  await subject.fill(`${e.subject} (v2)`);
  await expect(saveState(page)).toHaveText('Saved');
  await page.reload();
  await expect(detail(page).getByRole('textbox', { name: 'Subject' })).toHaveValue(`${e.subject} (v2)`);
  await outreach(server, e.domain).toEqual([expect.objectContaining({ subject: `${e.subject} (v2)` })]);
});

test('edit then immediately J still saves', async ({ app, page, server }) => {
  // The page's clock stands still from each edit until it has been saved, so the 600ms autosave
  // can never fire on its own: only the flush on leaving the draft (or the screen) saves it.
  const d = EMAIL.quickSwitch;
  await page.clock.install();
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  const index = await options(page).evaluateAll((els, dom) => els.findIndex((el) => el.dataset.domain === dom), d.domain);
  const next = await options(page).nth(index + 1).getAttribute('data-domain');
  const text = 'Hi there,\n\nRewritten and switched away within the debounce.\n\n— Dee';
  const saved = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/drafts/${d.domain}`));
  await freeze(page);
  await emailBody(page).fill(text);
  await page.keyboard.press('Escape');
  await page.keyboard.press('j');
  await expect(page).toHaveURL(hashIs(`#/drafts/${next}`));
  expect((await saved).postDataJSON()).toEqual({ subject: d.subject, body: text });
  await expect.poll(() => storedBody(server, d.domain)).toBe(text);
  await page.clock.resume();
  await page.reload();
  await optionFor(page, d.domain).click();
  await expect(emailBody(page)).toHaveValue(text);

  // A click on another draft right after typing flushes the edit too.
  const c = EMAIL.quickClick;
  await optionFor(page, c.domain).click();
  await expect(emailBody(page)).toBeEditable();
  await freeze(page);
  await emailBody(page).fill('Clicked away at once.');
  await optionFor(page, d.domain).click();
  await expect.poll(() => storedBody(server, c.domain)).toBe('Clicked away at once.');

  // Leaving the screen flushes as well.
  await optionFor(page, c.domain).click();
  await emailBody(page).fill('Left the screen at once.');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(hashIs('#/home'));
  await expect.poll(() => storedBody(server, c.domain)).toBe('Left the screen at once.');
  await page.clock.resume();
});

test('an edit whose save failed is saved again on leaving the screen', async ({ app, page, server }) => {
  app.allowConsole(/Failed to load resource/);
  const d = EMAIL.leaveRetry;
  let saveFails = true;
  await page.route(
    (url) => url.pathname === `/api/drafts/${d.domain}`,
    (route) => (route.request().method() === 'POST' && saveFails ? route.fulfill({ status: 500, body: 'disk full' }) : route.fallback()),
  );
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  // The save fails once; nothing is waiting to try it again while the draft stays open.
  const text = 'Saved on the way out.';
  await emailBody(page).fill(text);
  await expect(saveState(page)).toHaveText('Couldn’t save: disk full');
  await expect(page.locator('#toasts .toast-err', { hasText: 'Couldn’t save your edit: disk full' })).toHaveCount(1);
  saveFails = false;
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(hashIs('#/home'));
  await expect.poll(() => storedBody(server, d.domain)).toBe(text);

  // Still failing on the way out: the edit is lost with the screen, and a toast says which one.
  await page.goBack();
  await expect(emailBody(page)).toHaveValue(text);
  saveFails = true;
  await emailBody(page).fill('Lost on the way out.');
  await expect(saveState(page)).toHaveText('Couldn’t save: disk full');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(hashIs('#/home'));
  await expect(page.locator('#toasts .toast-err', { hasText: `Your edit to ${d.name} wasn’t saved: disk full` })).toBeVisible();
  await expect.poll(() => storedBody(server, d.domain)).toBe(text);
});

test('LinkedIn counter blocks send over 300', async ({ app, page }) => {
  const d = LI.counter;
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  const counter = detail(page).locator('.draft-count');
  await expect(counter).toHaveText(`${d.body.length} / 300`);
  const sendInvite = detail(page).getByRole('button', { name: `Send invite to ${firstName(d.domain)}` });
  const openIn = detail(page).getByRole('button', { name: 'Open in LinkedIn' });
  await expect(sendInvite).toBeEnabled();
  // The CTA link in the note is shown on its own line.
  await expect(detail(page).locator('.draft-link a')).toHaveAttribute('href', d.body.split('\n').pop());

  await note(page).fill('x'.repeat(310));
  await expect(counter).toHaveText('310 / 300');
  await expect(counter).toHaveClass(/is-over/);
  await expect(detail(page).getByText('Shorten the note to 300 characters or fewer to send it.')).toBeVisible();
  await expect(sendInvite).toBeDisabled();
  await expect(openIn).toBeDisabled();
  await expect(note(page)).toHaveAttribute('aria-invalid', 'true');

  await note(page).fill(d.body);
  await expect(counter).not.toHaveClass(/is-over/);
  await expect(sendInvite).toBeEnabled();
  await expect(openIn).toBeEnabled();
  await expect(saveState(page)).toHaveText('Saved');
});

test('parked draft shows banner and no Send invite', async ({ app, page }) => {
  const parked = SEED.drafts.parked;
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  await app.goto(`#/drafts/${parked.domain}`);
  await listReady(page);
  const banner = detail(page).locator('.draft-banner');
  await expect(banner).toHaveText(`Auto-send skipped: ${parked.reason}`);
  await expect(detail(page).getByRole('button', { name: /^Send invite/ })).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: 'Open in LinkedIn' })).toBeVisible();

  // Another LinkedIn draft has no banner and can be sent.
  await optionFor(page, LI.autosave.domain).click();
  await expect(detail(page).locator('.draft-banner')).toHaveCount(0);
  await expect(detail(page).getByRole('button', { name: /^Send invite to / })).toBeVisible();

  // Send all leaves the parked draft out.
  await tab(page, 'LinkedIn').click();
  await page.getByRole('button', { name: 'Send all…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  await expect(dialog.locator('.sendall-linkedin')).toContainText(`of ${SEED.drafts.linkedinSendable} LinkedIn invites`);
  await expect(dialog.locator('.sendall-linkedin')).toContainText('1 parked draft excluded');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('outside LinkedIn’s sending hours or signed out, no invite is promised and Open in LinkedIn still works', async ({ app, page }) => {
  // coldtrail's sender sends nothing outside 08:00–20:00 local or with LinkedIn signed out, so
  // neither Send all nor Send invite offers to; Open in LinkedIn, the manual path, has no hours.
  const d = LI.evening;
  await page.clock.install({ time: todayAt(21) });
  let status = LI_AUTO;
  await patchStatus(page, () => status);
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);

  // All tab: the emails are still offered, the LinkedIn invites aren't.
  const sendAll = page.getByRole('button', { name: 'Send all…' });
  await sendAll.click();
  let dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  await expect(dialog.locator('.sendall-linkedin')).toContainText(
    'LinkedIn invites go out between 08:00 and 20:00 your time, so none go out now.',
  );
  await expect(dialog.getByRole('button', { name: /^Create \d+ Gmail drafts$/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /invite/i })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // LinkedIn tab: nothing to confirm.
  await tab(page, 'LinkedIn').click();
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  await expect(dialog).toContainText('Nothing goes out from here right now');
  await expect(dialog.locator('.sendall-linkedin')).toContainText('so none go out now.');
  await expect(dialog.getByRole('button', { name: /^Send/ })).toHaveCount(0);
  await dialog.getByText('Close', { exact: true }).click();
  await expect(dialog).toBeHidden();

  // The draft: Send invite waits for the morning and says so; Open in LinkedIn is the main action.
  const hint = detail(page).locator('.draft-hint');
  const invite = detail(page).getByRole('button', { name: `Send invite to ${firstName(d.domain)}` });
  const openIn = detail(page).getByRole('button', { name: 'Open in LinkedIn' });
  await expect(hint).toContainText('between 08:00 and 20:00 your time, so Send invite waits until then.');
  await expect(invite).toBeDisabled();
  await expect(openIn).toBeEnabled();
  await expect(openIn).toHaveClass(/btn-primary/);
  await expectAccessible(page);

  // Morning: the next status refresh brings Send invite back.
  await page.clock.setSystemTime(todayAt(11));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(invite).toBeEnabled();
  await expect(hint).toHaveCount(0);

  // Signed out: the same, with the way to reconnect.
  status = { ...LI_AUTO, linkedin_reconnect_needed: true };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(hint).toContainText('LinkedIn is signed out, so Send invite is off. Reconnect it in Settings → Connections.');
  await expect(hint.getByRole('link', { name: 'Settings → Connections' })).toHaveAttribute('href', '#/settings?tab=connections');
  await expect(invite).toBeDisabled();
  await expect(openIn).toBeEnabled();
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  await expect(dialog.locator('.sendall-linkedin')).toContainText(
    'LinkedIn is signed out, so none go out now. Reconnect it in Settings → Connections.',
  );
  await expect(dialog.getByRole('button', { name: /^Send/ })).toHaveCount(0);
  await dialog.getByText('Close', { exact: true }).click();
  await expect(dialog).toBeHidden();

  // Never connected: the same, with the way to connect.
  status = { ...LI_AUTO, linkedin_connected: false };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(hint).toContainText('LinkedIn isn’t connected, so Send invite is off. Connect it in Settings → Connections.');
  await expect(openIn).toBeEnabled();

  // Nothing was started.
  expect(app.calls).toEqual([]);
});

test('LinkedIn send all posts once and stays disabled while sending', async ({ app, page, server, request }) => {
  const st = await realStatus(request, server);
  const { linkedinToday: today, linkedin7d: week } = SEED.capUsage;
  const upTo = Math.min(SEED.drafts.linkedinSendable, st.linkedin_daily_cap - today, st.linkedin_weekly_cap - week);
  let capped = false; // the status says today's LinkedIn cap is used up
  await daytime(page);
  await patchStatus(page, () => (capped ? { ...LI_AUTO, linkedin_sent_today: st.linkedin_daily_cap } : LI_AUTO));
  await app.goto('#/drafts?tab=linkedin');
  await listReady(page);
  const sendAll = page.getByRole('button', { name: 'Send all…' });
  await sendAll.click();
  const dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  await dialog.getByRole('button', { name: `Send ${upTo} invites`, exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(toast(page).last()).toContainText('Sending on LinkedIn');
  expect(app.calls.filter((c) => c.path === '/api/drafts/linkedin/send-all')).toHaveLength(1);

  // While it runs the button can't start a second sender, even after a reload. Open in LinkedIn
  // (the manual path) never waits for it.
  const busy = page.getByRole('button', { name: 'Sending on LinkedIn…' });
  await expect(busy).toBeDisabled();
  await expect(detail(page).getByRole('button', { name: 'Open in LinkedIn' })).toBeEnabled();
  await page.reload();
  await listReady(page);
  await expect(page.getByRole('button', { name: 'Sending on LinkedIn…' })).toBeDisabled();
  await expect(detail(page).getByRole('button', { name: 'Open in LinkedIn' })).toBeEnabled();
  // The Email tab's Send all is still free.
  await tab(page, 'Email').click();
  await expect(page.getByRole('button', { name: 'Send all…' })).toBeEnabled();
  expect(app.calls.filter((c) => c.path === '/api/drafts/linkedin/send-all')).toHaveLength(1);

  // The sender stops at the cap, with sendable drafts still queued: once as many invites as it
  // could send today have left the queue, it has finished.
  const sent = new Set(sendableLinkedin.slice(0, upTo).map((d) => d.domain));
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      const res = await route.fetch();
      const rows = (await res.json()).filter((r) => !(r.channel === 'linkedin' && sent.has(r.domain)));
      await route.fulfill({ response: res, json: rows });
    },
  );
  await tab(page, 'LinkedIn').click();
  // (The poller looks every 3s.)
  await expect(page.locator('#toasts .toast', { hasText: `LinkedIn bulk send finished: ${upTo} invites sent.` })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Send all…' })).toBeEnabled();
  await expect(options(page)).toHaveCount(SEED.drafts.linkedin - upTo);

  // A run the cap cuts short (nothing leaves the queue): the poller refreshes the status itself,
  // so it finishes within a few polls rather than at the shared store's 30s refresh.
  await page.getByRole('button', { name: 'Send all…' }).click();
  await page.getByRole('dialog', { name: 'Send all LinkedIn invites' }).getByRole('button', { name: /^Send \d+ invites?$/ }).click();
  await expect(page.getByRole('button', { name: 'Sending on LinkedIn…' })).toBeDisabled();
  capped = true;
  await expect(
    page.locator('#toasts .toast', { hasText: 'LinkedIn bulk send stopped at your LinkedIn cap: 0 invites sent.' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Send all…' })).toBeEnabled();
  expect(app.calls.filter((c) => c.path === '/api/drafts/linkedin/send-all')).toHaveLength(2);
});

test('Open in LinkedIn shows Did it send ✓/✗ and ✓ marks sent', async ({ app, page, server }) => {
  const yes = LI.assistYes;
  await app.goto(`#/drafts/${yes.domain}`);
  await listReady(page);
  await detail(page).getByRole('button', { name: 'Open in LinkedIn' }).click();
  await expect(toast(page).last()).toContainText('Opened in LinkedIn');
  expect(app.calls.map((c) => c.path)).toContain(`/api/drafts/${yes.domain}/linkedin/assist`);
  const ask = detail(page).locator('.draft-ask');
  await expect(ask).toContainText('Did it send?');
  await expect(ask.getByRole('button', { name: 'Yes, it sent' })).toBeFocused();
  await expect(detail(page).getByRole('button', { name: 'Open in LinkedIn' })).toHaveCount(0);
  // The row says Opened, still a pill on the selected row's tint.
  const opened = optionFor(page, yes.domain).locator('.badge', { hasText: 'Opened' });
  await expect(opened).toBeVisible();
  const fills = await opened.evaluate((b) => [getComputedStyle(b).backgroundColor, getComputedStyle(b.closest('[role="option"]')).backgroundColor]);
  expect(fills[0]).not.toBe(fills[1]);

  await ask.getByRole('button', { name: 'Yes, it sent' }).click();
  await expect(toast(page).last()).toContainText('Marked sent.');
  await expect(optionFor(page, yes.domain)).toHaveCount(0);
  await outreach(server, yes.domain).toEqual([expect.objectContaining({ channel: 'linkedin', status: 'sent' })]);
  // The selection moved on to a draft that is still waiting.
  await expect(selected(page)).toHaveCount(1);

  // ✗ keeps the draft and brings Open in LinkedIn back.
  const no = LI.assistNo;
  await optionFor(page, no.domain).click();
  await detail(page).getByRole('button', { name: 'Open in LinkedIn' }).click();
  await detail(page).getByRole('button', { name: 'No, it didn’t' }).click();
  await expect(toast(page).last()).toContainText('Not sent — you can try again.');
  await expect(detail(page).getByRole('button', { name: 'Open in LinkedIn' })).toBeVisible();
  await outreach(server, no.domain).toEqual([expect.objectContaining({ status: 'draft_pending' })]);
});

test('discarding a draft that opened in LinkedIn meanwhile closes that window first', async ({ app, page, server }) => {
  // Discard pressed while Open in LinkedIn is still opening the window: the window opens (the
  // server now holds it, and the browser lock, until it hears back) while the discard dialog is up.
  const d = LI.discardOpening;
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  await page.route(
    (url) => url.pathname === `/api/drafts/${d.domain}/linkedin/assist`,
    async (route) => {
      await opened;
      await route.fulfill({ json: { staged: true } });
    },
  );
  const sent = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() !== 'GET' && path.startsWith(`/api/drafts/${d.domain}`)) sent.push(`${r.method()} ${path} ${r.postData() || ''}`.trim());
  });
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  await detail(page).getByRole('button', { name: 'Open in LinkedIn' }).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…' })).toBeDisabled();
  await detail(page).getByRole('button', { name: 'Discard' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Discard this draft?' });
  await expect(confirm).toBeVisible();
  open();
  await expect(detail(page).locator('.draft-ask')).toContainText('Did it send?');

  await confirm.getByRole('button', { name: 'Discard draft' }).click();
  await expect(toast(page).last()).toContainText(`Draft discarded. ${d.name} is now skipped.`);
  await expect(optionFor(page, d.domain)).toHaveCount(0);
  // "It didn't send" reaches the server before the delete, so the window closes at once.
  expect(sent).toEqual([
    `POST /api/drafts/${d.domain}/linkedin/assist {}`,
    `POST /api/drafts/${d.domain}/linkedin/confirm {"sent":false}`,
    `DELETE /api/drafts/${d.domain}`,
  ]);
  await outreach(server, d.domain).toEqual([]);
});

test('already invited response toasts and refreshes', async ({ app, page }) => {
  const d = LI.invited;
  await page.route(
    (url) => url.pathname === `/api/drafts/${d.domain}/linkedin/assist`,
    (route) => route.fulfill({ json: { already_invited: true } }),
  );
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  const refreshed = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/drafts');
  await detail(page).getByRole('button', { name: 'Open in LinkedIn' }).click();
  await expect(toast(page).last()).toContainText('Already invited on LinkedIn (Pending) — marked as sent.');
  await refreshed;
  await expect(detail(page).locator('.draft-ask')).toHaveCount(0);
});

test('email Send now shows the no-send error clearly', async ({ app, page, server, request }) => {
  const d = EMAIL.sendNow;
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  await emailAutoSend(request, server, true);
  try {
    await app.goto(`#/drafts/${d.domain}`);
    await listReady(page);
    const send = detail(page).getByRole('button', { name: `Send now to ${firstName(d.domain)}` });
    await send.click();
    // The first send of the session asks first.
    const confirm = page.getByRole('alertdialog', { name: 'Send this email now?' });
    await expect(confirm).toContainText(d.to);
    await confirm.getByRole('button', { name: 'Send now' }).click();
    const err = page.locator('#toasts .toast-err');
    await expect(err).toHaveText('Email not sent — dry run: sending is disabled for this run');
    await expect(send).toBeEnabled();
    await outreach(server, d.domain).toEqual([expect.objectContaining({ status: 'draft_pending' })]);

    // Not asked again in this session.
    await err.getByRole('button', { name: 'Dismiss' }).click();
    await send.click();
    await expect(page.locator('#toasts .toast-err')).toHaveCount(1);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    // A LinkedIn invite does something else entirely: its first Send invite still asks.
    const li = LI.counter;
    await optionFor(page, li.domain).click();
    await detail(page).getByRole('button', { name: `Send invite to ${firstName(li.domain)}` }).click();
    const ask = page.getByRole('alertdialog', { name: 'Send this LinkedIn invite?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
    expect(app.calls).toEqual([]);
  } finally {
    await emailAutoSend(request, server, false);
  }
});

test('an email already in Gmail offers Open Gmail and Mark sent', async ({ app, page, server }) => {
  const d = inGmail[0];
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  await expect(detail(page).locator('.draft-head .badge')).toContainText(['In Gmail']);
  await expect(detail(page).getByRole('link', { name: 'Open Gmail' })).toHaveAttribute(
    'href',
    'https://mail.google.com/mail/u/0/#drafts',
  );
  await expect(detail(page).getByRole('textbox')).toHaveCount(0);
  await detail(page).getByRole('button', { name: 'Mark sent' }).click();
  await expect(toast(page).last()).toContainText(`Marked ${d.name} as sent.`);
  await expect(optionFor(page, d.domain)).toHaveCount(0);
  await outreach(server, d.domain).toEqual([expect.objectContaining({ status: 'sent' })]);
});

test('discard removes the draft and skips the company', async ({ app, page, server }) => {
  const d = EMAIL.discard;
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  const before = Number(await tab(page, 'All').locator('.tab-count').textContent());
  const index = await options(page).evaluateAll((els, dom) => els.findIndex((el) => el.dataset.domain === dom), d.domain);
  const next = await options(page).nth(index + 1).getAttribute('data-domain');

  await detail(page).getByRole('button', { name: 'Discard' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Discard this draft?' });
  await expect(confirm).toContainText(d.name);
  await confirm.getByRole('button', { name: 'Discard draft' }).click();
  await expect(toast(page).last()).toContainText(`Draft discarded. ${d.name} is now skipped.`);
  await expect(optionFor(page, d.domain)).toHaveCount(0);
  await expect(page).toHaveURL(hashIs(`#/drafts/${next}`));
  await expect(tab(page, 'All').locator('.tab-count')).toHaveText(String(before - 1));
  await outreach(server, d.domain).toEqual([]);
  await dbRows(server, 'SELECT status FROM companies WHERE domain = ?', d.domain).toEqual([{ status: 'skip' }]);

  // Cancel keeps it.
  await detail(page).getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('alertdialog', { name: 'Discard this draft?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(optionFor(page, next)).toHaveCount(1);
});

test('a discard that fails keeps the unsaved edit and saves it', async ({ app, page, server }) => {
  app.allowConsole(/Failed to load resource/);
  const d = EMAIL.discardFails;
  let saveFails = true;
  await page.route(
    (url) => url.pathname === `/api/drafts/${d.domain}`,
    (route) => {
      const method = route.request().method();
      if (method === 'DELETE') return route.fulfill({ status: 500, body: 'database is locked' });
      if (method === 'POST' && saveFails) return route.fulfill({ status: 500, body: 'disk full' });
      return route.fallback();
    },
  );
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  // An edit whose save failed is still waiting to be saved when Discard is pressed.
  const text = 'Kept when the discard failed.';
  await emailBody(page).fill(text);
  await expect(saveState(page)).toContainText('Couldn’t save');
  saveFails = false;

  await detail(page).getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('alertdialog', { name: 'Discard this draft?' }).getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.locator('#toasts .toast-err', { hasText: 'Draft not discarded' })).toBeVisible();
  await expect(optionFor(page, d.domain)).toHaveCount(1);
  await expect(emailBody(page)).toHaveValue(text);
  await expect(saveState(page)).toHaveText('Saved');
  await expect.poll(() => storedBody(server, d.domain)).toBe(text);
});

test('two drafts on one channel count as two, and Discard deletes both', async ({ app, page, server }) => {
  const d = EMAIL.twice;
  addOlderDraft(server, d.domain);
  const [{ n }] = server.query("SELECT count(*) AS n FROM outreach WHERE status IN ('draft_pending','drafted')");
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);

  // The counts are the server's (rows), so the tab and the sidebar agree; the list folds the two
  // into one row that says so.
  const all = tab(page, 'All').locator('.tab-count');
  await expect(all).toHaveText(fmtNum(n));
  await expect(page.locator('#nav a[data-route="drafts"] .nav-count')).toHaveText(fmtNum(n));
  await expect(options(page)).toHaveCount(n - 1);
  await expect(optionFor(page, d.domain).locator('.draft-row-tags')).toContainText('2 drafts');
  const dupes = detail(page).locator('.draft-dupes');
  await expect(dupes).toContainText('2 drafts wait for this company on this channel.');
  await expect(dupes).toContainText('Edits change both. Discard deletes both.');
  // The newest is the one on screen (and the one that sends).
  await expect(detail(page).getByRole('textbox', { name: 'Subject' })).toHaveValue(d.subject);

  await detail(page).getByRole('button', { name: 'Discard' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Discard both drafts?' });
  await expect(confirm).toContainText('Both emails to');
  await confirm.getByRole('button', { name: 'Discard both' }).click();
  await expect(toast(page).last()).toContainText(`2 drafts discarded. ${d.name} is now skipped.`);
  await expect(optionFor(page, d.domain)).toHaveCount(0);
  await expect(all).toHaveText(fmtNum(n - 2));
  await outreach(server, d.domain).toEqual([]);
});

test('leaving the screen stops its pollers', async ({ app, page }) => {
  const d = LI.rowSend;
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  const polls = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/drafts') polls.push(r.url());
  });
  await app.goto(`#/drafts/${d.domain}?tab=linkedin`);
  await listReady(page);

  // A per-row Send invite (first send of the session: confirm) polls for the invite going out.
  await detail(page).getByRole('button', { name: `Send invite to ${firstName(d.domain)}` }).click();
  await page.getByRole('alertdialog', { name: 'Send this LinkedIn invite?' }).getByRole('button', { name: 'Send invite' }).click();
  await expect(toast(page).last()).toContainText('Sending on LinkedIn');
  await expect(detail(page).getByRole('button', { name: 'Sending…' })).toBeDisabled();
  // And a bulk send polls the queue.
  await page.getByRole('button', { name: 'Send all…' }).click();
  await page.getByRole('dialog', { name: 'Send all LinkedIn invites' }).getByRole('button', { name: /^Send \d+ invites$/ }).click();
  await expect(page.getByRole('button', { name: 'Sending on LinkedIn…' })).toBeDisabled();

  // A poll that brings nothing new leaves the rows and the draft's head as they are (no rebuild
  // under a click or the keyboard focus): mark them, and the marks are still there after polls.
  const row = optionFor(page, d.domain);
  await expect(row.locator('.draft-row-tags')).toContainText('Sending');
  await row.evaluate((el) => {
    el.dataset.probe = 'kept';
  });
  await detail(page).locator('.draft-meta a').first().evaluate((el) => {
    el.dataset.probe = 'kept';
  });
  let seen = polls.length;
  await page.clock.runFor(6_500);
  await expect.poll(() => polls.length).toBeGreaterThan(seen + 1);
  // Each poller asks again only once its last answer has been applied, so five more requests
  // from the two of them mean earlier polls have landed on the screen.
  await expect.poll(() => polls.length, { timeout: 20_000 }).toBeGreaterThan(seen + 4);
  await expect(row).toHaveAttribute('data-probe', 'kept');
  await expect(detail(page).locator('.draft-meta a').first()).toHaveAttribute('data-probe', 'kept');

  // (A screen that doesn't read the drafts queue, so every request after this would be a leak.)
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(hashIs('#/settings'));
  await expect(page.locator('#view h1')).not.toHaveText('Drafts');
  seen = polls.length;
  await page.clock.runFor(20_000);
  await page.evaluate(() => fetch('/api/status').then((r) => r.status));
  expect(polls.length).toBe(seen);
});

test('a row send that never confirms says so; Send invite waits for a bulk send', async ({ app, page }) => {
  const d = LI.unconfirmed;
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  await app.goto(`#/drafts/${d.domain}?tab=linkedin`);
  await listReady(page);
  await detail(page).getByRole('button', { name: `Send invite to ${firstName(d.domain)}` }).click();
  await page.getByRole('alertdialog', { name: 'Send this LinkedIn invite?' }).getByRole('button', { name: 'Send invite' }).click();
  const hint = detail(page).locator('.draft-hint');
  await expect(hint).toHaveText('coldtrail is sending this invite in the LinkedIn window.');

  // The invite never leaves the queue: after the watch runs out the copy says so, and the button
  // stays off (it may still have gone out).
  await page.clock.runFor(ROW_TIMEOUT_MS);
  await expect(hint).toHaveText('The send didn’t confirm. Check the invite in LinkedIn, or reload this page to try again.', {
    timeout: 15_000,
  });
  await expect(detail(page).getByRole('button', { name: 'Not confirmed' })).toBeDisabled();
  await expect(optionFor(page, d.domain).locator('.draft-row-tags')).toContainText('Unconfirmed');

  // While a bulk send runs, another draft's Send invite waits for it (the sender may send that
  // one too); Open in LinkedIn, the manual path, doesn't.
  const other = LI.waits;
  await optionFor(page, other.domain).click();
  const openIn = detail(page).getByRole('button', { name: 'Open in LinkedIn' });
  const invite = detail(page).getByRole('button', { name: `Send invite to ${firstName(other.domain)}` });
  await expect(invite).toBeEnabled();
  await page.getByRole('button', { name: 'Send all…' }).click();
  await page.getByRole('dialog', { name: 'Send all LinkedIn invites' }).getByRole('button', { name: /^Send \d+ invites$/ }).click();
  await expect(page.getByRole('button', { name: 'Sending on LinkedIn…' })).toBeDisabled();
  await expect(invite).toBeDisabled();
  await expect(openIn).toBeEnabled();
  const wait = detail(page).locator('.draft-hint');
  await expect(wait).toContainText('Send invite waits for the LinkedIn bulk send to finish.');

  // A bulk send the screen can't see the end of has a way out: Stop waiting frees Send invite
  // and Send all, and forgets the run (it isn't back after a reload).
  await wait.getByRole('button', { name: 'Stop waiting' }).click();
  await expect(invite).toBeEnabled();
  await expect(invite).toBeFocused();
  await expect(detail(page).locator('.draft-hint')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send all…' })).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem('ct-li-bulk'))).toBeNull();
});

test('loading, error and retry', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      await gate;
      await route.fallback();
    },
  );
  await app.goto('#/drafts');
  await expect(page.locator('.drafts-body')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.drafts-body .skeleton').first()).toBeVisible();
  release();
  await listReady(page);
  await expect(page.locator('.drafts-body')).not.toHaveAttribute('aria-busy', 'true');

  await page.unrouteAll({ behavior: 'wait' });
  let fail = true;
  await page.route(
    (url) => url.pathname === '/api/drafts',
    (route) => (fail ? route.fulfill({ status: 500, body: 'database is locked' }) : route.fallback()),
  );
  await app.goto('#/drafts');
  await expect(page.getByRole('heading', { name: 'Couldn’t load drafts' })).toBeVisible();
  await expect(page.getByText('database is locked')).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await listReady(page);
});

test('secondary lookups failing still leave a usable screen', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  await page.route(
    (url) => url.pathname === '/api/companies' || url.pathname.startsWith('/api/companies/'),
    (route) => route.fulfill({ status: 500, body: 'boom' }),
  );
  const d = LI.autosave;
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  // Without names the rows fall back to the domain and the recipient; the editor still works.
  await expect(optionFor(page, d.domain).locator('.draft-row-title')).toHaveText(d.domain);
  await expect(detail(page).locator('.draft-name')).toHaveText(d.domain);
  await expect(note(page)).toBeEditable();
  await expect(detail(page).locator('.draft-source')).toBeHidden();
});

test('drafts is accessible in light and dark', async ({ app, page }) => {
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await app.goto(`#/drafts/${EMAIL.autosave.domain}`);
    await listReady(page);
    await expect(detail(page).locator('.draft-source')).toBeVisible();
    await expectAccessible(page);
    await app.goto(`#/drafts/${SEED.drafts.parked.domain}`);
    await expect(detail(page).locator('.draft-banner')).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Send all…' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press('Escape');
  }
});

test('a draft’s actions stay in view on laptop screens, and the filter hint fits', async ({ app, page }) => {
  // The email editor is taller than the detail pane on common laptop screens: the pane scrolls,
  // and the actions stay pinned to its bottom edge.
  const d = EMAIL.autosave;
  for (const [width, height, hash] of [
    [1366, 768, `#/drafts/${d.domain}?tab=email`],
    [1280, 800, `#/drafts/${d.domain}`],
    [1440, 900, `#/drafts/${d.domain}?tab=email`],
  ]) {
    await page.setViewportSize({ width, height });
    await app.goto(hash);
    await listReady(page);
    await expect(emailBody(page)).toBeVisible();
    await expect(detail(page).locator('[data-action="push"]'), `${width}×${height}`).toBeInViewport({ ratio: 1 });
    await expect(detail(page).getByRole('button', { name: 'Discard' }), `${width}×${height}`).toBeInViewport({ ratio: 1 });
  }

  // The filter's placeholder fits the narrowest list column (264px, from 900 to ~1100px wide).
  await page.setViewportSize({ width: 1024, height: 768 });
  await app.goto('#/drafts');
  await listReady(page);
  const fit = await page.getByRole('searchbox', { name: 'Filter drafts' }).evaluate((input) => {
    const cs = getComputedStyle(input);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { text: Math.ceil(ctx.measureText(input.placeholder).width), room };
  });
  expect(fit.text).toBeLessThanOrEqual(fit.room);
});

test('phone width: list then draft, no horizontal scroll', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scrollWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
  await app.goto('#/drafts');
  await listReady(page);
  // No draft opens by itself on a phone: the list comes first.
  await expect(page).toHaveURL(hashIs('#/drafts'));
  await expect(detail(page)).toHaveCount(0);
  expect(await scrollWidth()).toBeLessThanOrEqual(390);

  // A draft far down the list (the page is scrolled well past its top to reach it).
  const d = SEED.drafts.order[40];
  const row = optionFor(page, d);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page).toHaveURL(hashIs(`#/drafts/${d}`));
  await expect(detail(page)).toBeVisible();
  await expect(list(page)).toBeHidden();
  expect(await scrollWidth()).toBeLessThanOrEqual(390);
  await expectAccessible(page);

  // Back to the list, whichever way: the list keeps its place, and the row is focused in view.
  await page.getByRole('button', { name: 'All drafts' }).click();
  await expect(page).toHaveURL(hashIs('#/drafts'));
  await expect(list(page)).toBeVisible();
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
  expect(await scrollWidth()).toBeLessThanOrEqual(390);

  await row.click();
  await expect(detail(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(hashIs('#/drafts'));
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();

  await row.click();
  await expect(detail(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(hashIs('#/drafts'));
  await expect(list(page)).toBeVisible();
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
});

test.describe('empty workspace', () => {
  test.use({ seed: 'onboarded' });

  test('explains where drafts come from', async ({ app, page }) => {
    await app.goto('#/drafts');
    await expect(page.getByRole('heading', { name: 'No drafts waiting' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Agent' })).toHaveAttribute('href', '#/agent');
    await expect(page.getByRole('button', { name: 'Send all…' })).toBeDisabled();
    await expect(tab(page, 'All').locator('.tab-count')).toHaveText('0');
    await page.emulateMedia({ colorScheme: 'light' });
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

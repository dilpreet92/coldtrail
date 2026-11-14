// Drafts (spec §5.4): the review queue. Tabs with counts, a filter, a list that renders at most
// 100 rows at a time, names from the queue itself, J/K/Enter/Esc, autosave per channel (flushed
// before switching drafts and before leaving the screen, which waits for it), the open draft kept
// in step with the server, email vs LinkedIn detail, the parked banner, Discard, the Send all
// dialog with exact counts and its one-run-at-a-time guard, the first-send confirm, no send over
// an edit that couldn't be saved, Open in LinkedIn + "Did it send?", the LinkedIn pollers
// (finished at the cap, timed out even when the queue can't be read, ended when the sender gives
// up, stopped on leaving), Send invite off at a used-up cap, a draft's text read-only while it goes
// out, drafts arriving while the screen is open, a stale session, and the phone list keeping its
// place (and the keyboard's, when a draft leaves).
//
// Tests share one server and run in order, so the read-only and count-sensitive tests come first
// (later ones take counts from the server, not the seed). The drafts the others act on are named
// below (EMAIL, LI), and several are used by more than one test, so two rules keep them safe to
// share:
//   - A draft a test sends, marks sent or discards for real leaves the queue for good, so no
//     later test uses it. A test that changes the status of a draft other tests use, or adds a
//     row, puts it back (the status reset, the row deleted) in a `finally`.
//   - An edit stays: the server now has that text. A test reads a draft's text from the screen or
//     the database, and asserts the seeded text only where no earlier test edits that draft.
// Every LinkedIn route that would drive Chrome is intercepted by the harness (assist, send,
// send-all); confirm and discard are real.
//
// coldtrail sends LinkedIn invites itself only 08:00–20:00 local and with a connected session,
// so every test that expects it to pins the page's clock to the morning (`daytime`) and reports
// a connected session (`LI_AUTO`): none of them depend on when the suite runs.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { COMPANIES, SEED } from '../harness/seed.mjs';
import { SESSION_EXPIRED, SESSION_REOPEN } from '../../../ui/js/core/api.js';
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
/** A domain's pending draft on `channel` as the seed wrote it: { subject, body, … }. */
const seeded = (domain, channel) =>
  COMPANIES.find((c) => c.domain === domain).outreach.find((o) => o.channel === channel && o.status === 'draft_pending');

// Drafts the tests act on. Some are used by more than one test: see the rules at the top.
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
  discardOther: inGmail[1],
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
  offline: sendableLinkedin[11],
  ownRow: sendableLinkedin[12],
  stale: sendableLinkedin[13],
  rowSent: sendableLinkedin[14],
  assistAway: sendableLinkedin[15],
  capped: sendableLinkedin[16],
  parkedSend: sendableLinkedin[17],
  signedOutSend: sendableLinkedin[18],
  cappedSend: sendableLinkedin[19],
  lockOpen: sendableLinkedin[20],
  phoneDiscard: sendableLinkedin[21],
  phoneYes: sendableLinkedin[22],
  assistSignedOut: sendableLinkedin[23],
};
const ROW_TIMEOUT_MS = 240_000; // drafts.js: how long a per-row LinkedIn send is watched
const FILTER_URL_MS = 250; // drafts.js: the filter reaches the URL this long after the last key

/** Stop the page's clock (installed with `page.clock.install()` before the page loaded): no
 *  timer fires on its own until `page.clock.runFor()` or `page.clock.resume()`. */
async function freeze(page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

/** How many LinkedIn invites the open Send all dialog counts as sendable ("Up to 14 of 37 …"). */
async function sendableIn(dialog) {
  const text = (await dialog.locator('.sendall-linkedin').textContent()).replace(/\u00a0/g, ' ');
  const m = text.match(/ of (\d+) LinkedIn invites?|Up to (\d+) LinkedIn invites?/);
  expect(m, text).toBeTruthy();
  return Number(m[1] || m[2]);
}

/** The filter as the URL holds it (`q`), or null. */
const urlFilter = (page) => page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] || '').get('q'));

/** LinkedIn connected (the seeded workspace never connected it, so Open in LinkedIn is off
 *  without it). Open in LinkedIn and Send invite are intercepted: nothing reaches LinkedIn. */
const LI_ON = { linkedin_connected: true };

/** LinkedIn auto-send on, with a connected session. */
const LI_AUTO = { linkedin_auto_send: true, ...LI_ON };

/** Gmail connected (the seeded workspace has no app password, Gmail sign-in or gcloud login, so
 *  Create Gmail draft and Send now are off without it). The sends themselves are routed or meet
 *  the harness's NO_SEND: nothing reaches Gmail. */
const GMAIL = { destination_connected: true };

/** What the header says when the queue couldn't load. */
const ERROR_DESC = 'Drafts the agent writes wait here for your review.';

/** Show a toast as the screen's own error toasts do (they stay until dismissed). */
const errorToast = (page, text) => page.evaluate((t) => import('/assets/js/core/ui.js').then((m) => m.toast(t, 'err')), text);

/** A request that sends one email draft (Create Gmail draft, Send now, or Send all's). */
const isEmailSend = (url) => /^\/api\/drafts\/[^/]+\/send$/.test(url.pathname);

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

/** Insert a pending draft for `domain` whose contact is that of the domain's first row matching
 *  `where` (SQL), newest in the queue → its id, for deleteDraft. */
function insertDraft(server, domain, { where, channel = 'email', subject = '', body }) {
  const db = new DatabaseSync(join(server.home, 'outreach.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const { changes, lastInsertRowid } = db
      .prepare(
        `INSERT INTO outreach (domain, contact_id, channel, subject, body, status, created_at)
         SELECT domain, contact_id, ?, ?, ?, 'draft_pending', datetime('now')
         FROM outreach WHERE domain = ? AND ${where} ORDER BY id LIMIT 1`,
      )
      .run(channel, subject, body, domain);
    expect(changes).toBe(1);
    return Number(lastInsertRowid);
  } finally {
    db.close();
  }
}

/** Run one write on the workspace DB, as the agent or a schedule would. */
function writeDb(server, sql, ...params) {
  const db = new DatabaseSync(join(server.home, 'outreach.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).run(...params).changes;
  } finally {
    db.close();
  }
}

const deleteDraft = (server, id) => writeDb(server, 'DELETE FROM outreach WHERE id = ?', id);

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
// writing while a test asserts. The harness's `query` waits up to 5s for the server's lock; a
// read that still finds the database locked returns undefined, so the poll tries again rather
// than failing (expect.poll doesn't retry a callback that throws).
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
  const companyLookups = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/companies')) companyLookups.push(url);
  });
  await app.goto('#/drafts');
  await listReady(page);
  await expect(page.locator('#view h1')).toHaveText('Drafts');
  await expect(page.locator('.page-desc')).toContainText(`${fmtNum(SEED.counts.drafts)} waiting for review.`);

  await expect(tab(page, 'All').locator('.tab-count')).toHaveText(fmtNum(SEED.counts.drafts));
  await expect(tab(page, 'Email').locator('.tab-count')).toHaveText(fmtNum(SEED.drafts.email));
  await expect(tab(page, 'LinkedIn').locator('.tab-count')).toHaveText(fmtNum(SEED.drafts.linkedin));
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true');
  await expect(options(page)).toHaveCount(SEED.counts.drafts);

  // Server order (newest first); each row names the person, then "Company · domain" (both from
  // the queue itself), and its channel.
  await expect(options(page).nth(1)).toHaveAttribute('data-domain', SEED.drafts.order[1]);
  const li = optionFor(page, LI.autosave.domain);
  await expect(li.locator('.draft-row-title')).toHaveText(person(LI.autosave.domain));
  await expect(li.locator('.draft-row-sub')).toHaveText(`${LI.autosave.name} · ${LI.autosave.domain}`);
  await expect(li.locator('.chan-tag')).toHaveText('LinkedIn');
  const email = optionFor(page, EMAIL.autosave.domain);
  await expect(email.locator('.chan-tag')).toHaveText('Email');
  await expect(email.locator('.draft-row-title')).toHaveText(person(EMAIL.autosave.domain));
  await expect(email.locator('.draft-row-sub')).toHaveText(`${EMAIL.autosave.name} · ${EMAIL.autosave.domain}`);
  // No lookup per company: the queue carries the names.
  expect(companyLookups.filter((u) => !u.pathname.startsWith('/api/companies/'))).toEqual([]);
  await expect(optionFor(page, SEED.drafts.parked.domain).locator('.draft-row-tags')).toContainText('Parked');
  await expect(optionFor(page, inGmail[0].domain).locator('.draft-row-tags')).toContainText('In Gmail');

  // The caps line on the LinkedIn tab states today's usage and the last 7 days' (the weekly cap
  // is a rolling one, as Settings → Sending says) against the caps.
  const st = await realStatus(request, server);
  await tab(page, 'LinkedIn').click();
  await expect(page).toHaveURL(/#\/drafts\/[^?]+\?tab=linkedin$/);
  const stats = page.locator('.drafts-stats');
  await expect(stats).toContainText(`${SEED.capUsage.linkedinToday}/${st.linkedin_daily_cap} today`);
  await expect(stats).toContainText(`${SEED.capUsage.linkedin7d}/${st.linkedin_weekly_cap} in the last 7 days`);
  await expect(stats).not.toContainText('this week');
  await expect(stats).toContainText('Auto-send off');
  await expect(options(page)).toHaveCount(SEED.drafts.linkedin);
});

test('send all dialog states exact counts', async ({ app, page, server, request }) => {
  const st = await realStatus(request, server);
  const pending = pendingEmail.length;
  const sendable = SEED.drafts.linkedinSendable;
  const { linkedinToday: today, linkedin7d: week } = SEED.capUsage;
  const upTo = Math.min(sendable, st.linkedin_daily_cap - today, st.linkedin_weekly_cap - week);

  let status = {}; // on top of the real /api/status, with Gmail and LinkedIn connected
  await daytime(page);
  await patchStatus(page, () => ({ ...GMAIL, ...LI_ON, ...status }));
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

  // Both on: the email cap (less today's sends, which the server reports as
  // `email_sent_today`) and LinkedIn's daily/weekly usage bound what goes out today.
  const emailToday = SEED.capUsage.emailToday;
  expect(st.email_sent_today).toBe(emailToday);
  const emailUpTo = Math.min(pending, st.daily_send_cap - emailToday);
  status = { auto_send: true, ...LI_AUTO };
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  await expect(dialog.locator('.sendall-email')).toContainText(
    `Up to ${emailUpTo} emails today (cap ${st.daily_send_cap}, ${emailToday} already sent).`,
  );
  await expect(dialog.locator('.sendall-linkedin')).toContainText(
    `Up to ${upTo} of ${sendable} LinkedIn invites today (${today}/${st.linkedin_daily_cap} today, ` +
      `${week}/${st.linkedin_weekly_cap} in the last 7 days); 1 parked draft excluded.`,
  );
  await expect(
    dialog.getByRole('button', { name: `Send ${pending} emails and ${upTo} invites`, exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A server that doesn't report today's sends: the line falls back to the plain cap.
  status = { auto_send: true, ...LI_AUTO, email_sent_today: null };
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  await expect(dialog.locator('.sendall-email')).toContainText(
    `Up to ${pending} emails today (cap ${st.daily_send_cap} a day).`,
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

  // Leaving the screen with the dialog open (as the browser's Back does) closes it.
  await sendAll.click();
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#/home';
  });
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Nothing was sent or started.
  expect(app.calls).toEqual([]);
  await dbRows(server, "SELECT count(*) AS n FROM outreach WHERE status IN ('draft_pending','drafted')").toEqual([
    { n: SEED.counts.drafts },
  ]);
});

test('send all runs once, even when its dialog closes or the screen is left mid-run', async ({ app, page }) => {
  const pending = pendingEmail.length;
  await patchStatus(page, { ...GMAIL, auto_send: true });
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

  // J from one of the draft's actions moves on with the keyboard still in the draft (on the next
  // one's heading), not dropped to the top of the page.
  await detail(page).getByRole('button', { name: 'Discard' }).focus();
  await page.keyboard.press('j');
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[1]}`));
  await expect(detail(page).locator('.draft-name')).toBeFocused();
  await page.keyboard.press('k');
  await expect(page).toHaveURL(hashIs(`#/drafts/${order[0]}`));
  await expect(detail(page).locator('.draft-name')).toBeFocused();

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
  await expect(row.locator('.draft-row-title')).toHaveText(SEED.xss.founder);
  await expect(row.locator('.draft-row-sub')).toHaveText(`${SEED.xss.name} · ${SEED.xss.domain}`);
  await expect(detail(page).getByRole('textbox', { name: 'Subject' })).toHaveValue(SEED.xss.subject);
  await expect(emailBody(page)).toHaveValue(SEED.xss.body);
  await expect(detail(page).locator('.draft-name')).toHaveText(SEED.xss.founder);
  await expect(detail(page).locator('.draft-meta')).toContainText(SEED.xss.name);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('#view img, #view script').count()).toBe(0);
});

test('tabs and filter narrow the list and live in the URL', async ({ app, page }) => {
  await page.clock.install();
  await patchStatus(page, GMAIL);
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
  await expect(optionFor(page, target.domain).locator('.draft-row-sub')).toHaveText(`${target.name} · ${target.domain}`);
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

  // The tab chosen last is the one a plain #/drafts opens on, from another screen or after a
  // reload.
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(hashIs('#/home'));
  await app.goto('#/drafts');
  await expect(tab(page, 'LinkedIn')).toHaveAttribute('aria-selected', 'true');
  await expect(options(page)).toHaveCount(SEED.drafts.linkedin);
  await app.goto('#/home');
  await page.reload();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await app.goto('#/drafts');
  await expect(tab(page, 'LinkedIn')).toHaveAttribute('aria-selected', 'true');
  await expect(options(page)).toHaveCount(SEED.drafts.linkedin);

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

test('a draft written while the screen is open shows up, with its names', async ({ app, page }) => {
  // The agent drafts one more while Drafts is open: until then neither the queue nor the summary
  // counts have it.
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
  await app.goto('#/drafts');
  await listReady(page);
  const count = tab(page, 'All').locator('.tab-count');
  const before = Number(await count.textContent());
  await expect(optionFor(page, late.domain)).toHaveCount(0);

  written = true;
  // The shell's summary refresh (as on its 30s timer, or when the tab comes back into view).
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(count).toHaveText(String(before + 1));
  await expect(optionFor(page, late.domain).locator('.draft-row-title')).toHaveText(person(late.domain));
  await expect(optionFor(page, late.domain).locator('.draft-row-sub')).toHaveText(`${late.name} · ${late.domain}`);
});

test('a follow-up draft on a company already sent to shows its names', async ({ app, page, server }) => {
  // Draft follow-up leaves the company at "sent"; the queue still names its contact and company.
  const fu = COMPANIES.find((c) => c.followup && c.status === 'sent' && c.contacts[0].email);
  const who = fu.contacts[0];
  const id = insertDraft(server, fu.domain, { where: "status = 'sent'", subject: `Re: Quick idea for ${fu.name}`, body: 'Hi, following up.' });
  try {
    await app.goto('#/drafts?tab=email');
    await listReady(page);
    const row = optionFor(page, fu.domain);
    await expect(row.locator('.draft-row-title')).toHaveText(who.founder_name);
    await expect(row.locator('.draft-row-sub')).toHaveText(`${fu.name} · ${fu.domain}`);
    await row.click();
    await expect(detail(page).locator('.draft-name')).toHaveText(who.founder_name);
    await expect(detail(page).locator('.draft-meta')).toContainText(fu.name);
  } finally {
    deleteDraft(server, id);
  }
});

test('a company with an email and a LinkedIn draft saves each one on its own', async ({ app, page, server }) => {
  // The seed has no company with drafts on both channels, and no API writes a second draft for a
  // company (the agent does, through the CLI), so the test adds the LinkedIn note to the database
  // as the agent would. Saves then go to the real server, which keeps each channel's text apart.
  // The email is EMAIL.autosave's, which a later test opens too: its text is put back at the end.
  const e = EMAIL.autosave;
  const original = seeded(e.domain, 'email');
  const k = COMPANIES.find((c) => c.domain === e.domain).contacts[0];
  expect(k.linkedin_url).toBeTruthy();
  const noteText = `Hi ${k.founder_name.split(' ')[0]}, glad to connect.`;
  const id = insertDraft(server, e.domain, { where: "channel = 'email'", channel: 'linkedin', body: noteText });
  const saves = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === `/api/drafts/${e.domain}`) saves.push(r.postDataJSON());
  });
  try {
    await app.goto(`#/drafts/${e.domain}?channel=email`);
    await listReady(page);
    await expect(optionFor(page, e.domain)).toHaveCount(2);
    // Each draft names its own channel in the address, and nothing warns about shared text.
    await expect(emailBody(page)).toBeVisible();
    await expect(page).toHaveURL(hashIs(`#/drafts/${e.domain}?channel=email`));
    await expect(detail(page).locator('.draft-banner')).toHaveCount(0);

    const emailText = 'Hi there,\n\nThe email, edited on its own.\n\n— Dee';
    await emailBody(page).fill(emailText);
    await expect(saveState(page)).toHaveText('Saved');
    expect(saves.at(-1)).toEqual({ channel: 'email', subject: e.subject, body: emailText });

    // The LinkedIn note still has its own text, and its edit leaves the email alone.
    await optionFor(page, e.domain).filter({ has: page.locator('.chan-tag-linkedin') }).click();
    await expect(page).toHaveURL(hashIs(`#/drafts/${e.domain}?channel=linkedin`));
    await expect(note(page)).toHaveValue(noteText);
    const edited = `${noteText} (edited)`;
    await note(page).fill(edited);
    await expect(saveState(page)).toHaveText('Saved');
    expect(saves.at(-1)).toEqual({ channel: 'linkedin', body: edited });
    await dbRows(server, 'SELECT channel, subject, body FROM outreach WHERE domain = ? ORDER BY id', e.domain).toEqual([
      { channel: 'email', subject: e.subject, body: emailText },
      { channel: 'linkedin', subject: '', body: edited },
    ]);

    // After a reload each draft still shows its own text.
    await page.reload();
    await expect(note(page)).toHaveValue(edited);
    await optionFor(page, e.domain).filter({ has: page.locator('.chan-tag-email') }).click();
    await expect(emailBody(page)).toHaveValue(emailText);
  } finally {
    deleteDraft(server, id);
    writeDb(
      server,
      "UPDATE outreach SET subject = ?, body = ? WHERE domain = ? AND channel = 'email' AND status = 'draft_pending'",
      original.subject,
      original.body,
      e.domain,
    );
  }
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

  // Email drafts autosave subject and body together. (This one is as seeded: no earlier test
  // left its edit behind.)
  const e = EMAIL.autosave;
  await optionFor(page, e.domain).click();
  const subject = detail(page).getByRole('textbox', { name: 'Subject' });
  await expect(subject).toHaveValue(e.subject);
  await expect(emailBody(page)).toHaveValue(seeded(e.domain, 'email').body);
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
  expect((await saved).postDataJSON()).toEqual({ channel: 'email', subject: d.subject, body: text });
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

  // Leaving the screen by another nav item flushes as well, and the next screen waits for that
  // save (the router's beforeLeave): with the save held, Drafts stays; once it lands, the next
  // screen shows, and a reload straight after still has the edit.
  await optionFor(page, c.domain).click();
  await expect(emailBody(page)).toBeEditable();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let posted = 0;
  await page.route(
    (url) => url.pathname === `/api/drafts/${c.domain}`,
    async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posted++;
      await held;
      return route.fallback();
    },
  );
  await freeze(page);
  await emailBody(page).fill('Left the screen at once.');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(hashIs('#/settings'));
  await expect.poll(() => posted).toBe(1);
  await expect(page.locator('#view h1')).toHaveText('Drafts');
  release();
  await page.clock.resume();
  await expect(page.locator('#view h1')).toHaveText('Settings');
  await page.reload();
  await expect(page.locator('#view h1')).toHaveText('Settings');
  await expect.poll(() => storedBody(server, c.domain)).toBe('Left the screen at once.');
  await app.goto(`#/drafts/${c.domain}`);
  await expect(emailBody(page)).toHaveValue('Left the screen at once.');
  expect(posted).toBe(1);
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

test('the open draft shows what the server now has, but never an older copy over a save', async ({ app, page, server }) => {
  const d = EMAIL.quickSwitch;
  await patchStatus(page, GMAIL); // Send all's dialog then has a Cancel (there's something to send)
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  const subject = detail(page).getByRole('textbox', { name: 'Subject' });
  await expect(emailBody(page)).toBeEditable();
  // Send all… reloads the queue before its dialog opens.
  const reloadQueue = async () => {
    await page.getByRole('button', { name: 'Send all…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send all drafts' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  };

  // The agent (or a schedule) rewrites the open draft in place: with no edit of the user's
  // waiting, the editor shows the new text, so what a send sends is what's on screen.
  writeDb(
    server,
    "UPDATE outreach SET subject = 'Rewritten subject', body = 'REWRITTEN BY AGENT' WHERE domain = ? AND status = 'draft_pending'",
    d.domain,
  );
  await reloadQueue();
  await expect(emailBody(page)).toHaveValue('REWRITTEN BY AGENT');
  await expect(subject).toHaveValue('Rewritten subject');

  // A queue asked for before the user's edit was saved, and answered after: the saved edit stays.
  let fetched = false;
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      const res = await route.fetch(); // the queue as it is now, before the save
      const json = await res.json();
      fetched = true;
      await held;
      await route.fulfill({ response: res, json });
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Send all…' }).click();
  await expect.poll(() => fetched).toBe(true);
  const mine = 'Hi,\n\nMy own words, saved while an older copy of the queue was on its way.';
  await emailBody(page).fill(mine);
  await expect(saveState(page)).toHaveText('Saved');
  release();
  const dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(emailBody(page)).toHaveValue(mine);
  await reloadQueue();
  await expect(emailBody(page)).toHaveValue(mine);
  await expect.poll(() => storedBody(server, d.domain)).toBe(mine);

  // An edit that couldn't be saved is kept over a rewrite (its save is tried again before any send).
  app.allowConsole(/Failed to load resource/);
  await page.route(
    (url) => url.pathname === `/api/drafts/${d.domain}`,
    (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'disk full' }) : route.fallback()),
  );
  await emailBody(page).fill('Unsaved, and kept.');
  await expect(saveState(page)).toHaveText('Couldn’t save: disk full');
  writeDb(server, "UPDATE outreach SET body = 'REWRITTEN AGAIN' WHERE domain = ? AND status = 'draft_pending'", d.domain);
  await reloadQueue();
  await expect(emailBody(page)).toHaveValue('Unsaved, and kept.');
});

test('LinkedIn counter blocks send over 300', async ({ app, page }) => {
  const d = LI.counter;
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  await app.goto(`#/drafts/${d.domain}`);
  await listReady(page);
  const counter = detail(page).locator('.draft-count');
  await expect(counter).toHaveText(`${d.body.length} / 300`);
  // A screen reader hears the count, and the error only while there is one.
  const overText = 'Shorten the note to 300 characters or fewer to send it.';
  await expect(note(page)).toHaveAccessibleDescription(`${d.body.length} / 300`);
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
  await expect(note(page)).toHaveAccessibleDescription(`310 / 300 ${overText}`);

  await note(page).fill(d.body);
  await expect(counter).not.toHaveClass(/is-over/);
  await expect(note(page)).toHaveAccessibleDescription(`${d.body.length} / 300`);
  await expect(note(page)).not.toHaveAttribute('aria-invalid');
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

test('outside LinkedIn’s sending hours no invite is promised, and signed out nothing is opened in LinkedIn either', async ({ app, page }) => {
  // coldtrail's sender sends nothing outside 08:00–20:00 local or with LinkedIn signed out, so
  // neither Send all nor Send invite offers to. Open in LinkedIn, the manual path, has no hours,
  // but it drives the same Chrome profile: signed out or never connected, it's off too.
  const d = LI.evening;
  await page.clock.install({ time: todayAt(21) });
  let status = LI_AUTO;
  await patchStatus(page, () => ({ ...GMAIL, ...status }));
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

  // Signed out: neither button works (both would find LinkedIn's sign-in page), and the hint says
  // how to reconnect.
  status = { ...LI_AUTO, linkedin_reconnect_needed: true };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(hint).toHaveText(
    'LinkedIn is signed out, so Open in LinkedIn and Send invite are off. Reconnect it in Settings → Connections.',
  );
  await expect(hint.getByRole('link', { name: 'Settings → Connections' })).toHaveAttribute('href', '#/settings?tab=connections');
  await expect(invite).toBeDisabled();
  await expect(openIn).toBeDisabled();
  await expect(page.locator('.page-desc')).toHaveText(
    /^[\d,]+ waiting for review\. Reconnect LinkedIn in Settings → Connections to send them from here\.$/,
  );
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
  await expect(hint).toHaveText(
    'LinkedIn isn’t connected, so Open in LinkedIn and Send invite are off. Connect it in Settings → Connections.',
  );
  await expect(invite).toBeDisabled();
  await expect(openIn).toBeDisabled();

  // Nothing was started.
  expect(app.calls).toEqual([]);
});

test('with LinkedIn never connected, Open in LinkedIn is off and the screen says where to connect it', async ({ app, page }) => {
  // The seeded workspace never connected LinkedIn and has auto-send off. Open in LinkedIn would
  // launch coldtrail's Chrome profile, which isn't signed in, and come back "signed out": it's off,
  // as Create Gmail draft is without Gmail, and nothing offers to open the notes one by one.
  const d = LI.evening;
  let status = {};
  await patchStatus(page, () => status);
  await app.goto(`#/drafts/${d.domain}?tab=linkedin`);
  await listReady(page);
  const openIn = detail(page).getByRole('button', { name: 'Open in LinkedIn' });
  const hint = detail(page).locator('.draft-hint');
  await expect(openIn).toBeDisabled();
  await expect(openIn).toHaveClass(/btn-primary/);
  await expect(hint).toHaveText('LinkedIn isn’t connected, so Open in LinkedIn is off. Connect it in Settings → Connections.');
  await expect(hint.getByRole('link', { name: 'Settings → Connections' })).toHaveAttribute('href', '#/settings?tab=connections');
  await expect(detail(page).getByRole('button', { name: /Send invite/ })).toHaveCount(0);
  const desc = page.locator('.page-desc');
  await expect(desc).toHaveText(
    /^[\d,]+ waiting for review\. Connect LinkedIn in Settings → Connections to open them in LinkedIn from here\.$/,
  );
  await expectAccessible(page);
  // A press does nothing.
  await openIn.click({ force: true });

  // Send all leaves the invites out and says why: nothing to confirm on this tab.
  const sendAll = page.getByRole('button', { name: 'Send all…' });
  await sendAll.click();
  let dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  await expect(dialog).toContainText('Nothing goes out from here right now');
  const line = dialog.locator('.sendall-linkedin');
  await expect(line).toHaveClass(/is-off/);
  await expect(line).toContainText('LinkedIn isn’t connected, so none go out now. Connect it in Settings → Connections.');
  await expect(line).not.toContainText('open each one');
  await dialog.getByText('Close', { exact: true }).click();
  await expect(dialog).toBeHidden();

  // All: one sentence says what to connect.
  await tab(page, 'All').click();
  await expect(desc).toContainText('Connect Gmail and LinkedIn in Settings → Connections to use them from here.');

  // Connected: Open in LinkedIn is back, with nothing in its way.
  status = LI_ON;
  await tab(page, 'LinkedIn').click();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(openIn).toBeEnabled();
  await expect(hint).toHaveCount(0);
  await expect(desc).toContainText('Open in LinkedIn fills in your note; you click Send there.');
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  await expect(dialog.locator('.sendall-linkedin')).toContainText('or open each one in LinkedIn.');
  await dialog.getByText('Close', { exact: true }).click();

  // Nothing was opened.
  expect(app.calls).toEqual([]);
});

test('at a used-up LinkedIn cap Send invite waits and says until when; Open in LinkedIn still works', async ({
  app,
  page,
  server,
  request,
}) => {
  // The sender refuses at either cap before it sends anything, and the screen would never hear
  // why: Send invite isn't offered there, as Send all already doesn't.
  const d = LI.capped;
  const { linkedin_sent_today: today, linkedin_sent_7d: week } = await realStatus(request, server);
  await daytime(page);
  let caps = { linkedin_daily_cap: today }; // today's cap used up
  await patchStatus(page, () => ({ ...LI_AUTO, ...caps }));
  await app.goto(`#/drafts/${d.domain}?tab=linkedin`);
  await listReady(page);
  await expect(page.locator('.drafts-stats')).toContainText(`${today}/${today} today`);
  const hint = detail(page).locator('.draft-hint');
  const invite = detail(page).getByRole('button', { name: `Send invite to ${firstName(d.domain)}` });
  const openIn = detail(page).getByRole('button', { name: 'Open in LinkedIn' });
  await expect(hint).toHaveText(
    `The daily LinkedIn cap is reached (${today} of ${today} sent today), so Send invite waits until tomorrow. ` +
      'Open in LinkedIn works any time; raise the cap in Settings → Sending.',
  );
  await expect(hint.getByRole('link', { name: 'Settings → Sending' })).toHaveAttribute('href', '#/settings?tab=sending');
  await expect(invite).toBeDisabled();
  await expect(openIn).toBeEnabled();
  await expect(openIn).toHaveClass(/btn-primary/);
  await invite.click({ force: true }); // a press does nothing
  await expectAccessible(page);

  // The weekly cap is a rolling one: it frees up as the week's invites get older.
  caps = { linkedin_weekly_cap: week };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(hint).toHaveText(
    `The weekly LinkedIn cap is reached (${week} of ${week} sent in the last 7 days), so Send invite waits until some of ` +
      'them are more than a week old. Open in LinkedIn works any time; raise the cap in Settings → Sending.',
  );
  await expect(invite).toBeDisabled();

  // Room again: Send invite is back.
  caps = {};
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(invite).toBeEnabled();
  await expect(hint).toHaveCount(0);
  expect(app.calls).toEqual([]);
});

test('LinkedIn send all posts once and stays disabled while sending', async ({ app, page, server, request }) => {
  const st = await realStatus(request, server);
  const { linkedinToday: today, linkedin7d: week } = SEED.capUsage;
  const upTo = Math.min(SEED.drafts.linkedinSendable, st.linkedin_daily_cap - today, st.linkedin_weekly_cap - week);
  let capped = false; // the status says today's LinkedIn cap is used up
  let signedOut = false;
  await daytime(page);
  await patchStatus(page, () => ({
    ...LI_AUTO,
    ...(capped ? { linkedin_sent_today: st.linkedin_daily_cap } : {}),
    ...(signedOut ? { linkedin_reconnect_needed: true } : {}),
  }));
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

  // A run LinkedIn signing out stops says so in an error, which stays until it's dismissed: the
  // invites go out over minutes, and the user is usually away meanwhile.
  capped = false;
  await page.getByRole('button', { name: 'Send all…' }).click();
  await page.getByRole('dialog', { name: 'Send all LinkedIn invites' }).getByRole('button', { name: /^Send \d+ invites?$/ }).click();
  await expect(page.getByRole('button', { name: 'Sending on LinkedIn…' })).toBeDisabled();
  signedOut = true;
  await expect(page.locator('#toasts .toast-err')).toHaveText(
    ['LinkedIn bulk send stopped: 0 invites sent. LinkedIn is signed out: reconnect it in Settings → Connections.'],
    { timeout: 20_000 },
  );
  expect(app.calls.filter((c) => c.path === '/api/drafts/linkedin/send-all')).toHaveLength(3);
});

test('Send all confirmed after 20:00 sends no invite, and says so until dismissed', async ({ app, page }) => {
  // The dialog opened in the evening, inside the sender's hours, and sat open past 20:00.
  await page.clock.install({ time: new Date(todayAt(20).getTime() - 60_000) });
  await patchStatus(page, LI_AUTO);
  await app.goto('#/drafts?tab=linkedin');
  await listReady(page);
  await page.getByRole('button', { name: 'Send all…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  const go = dialog.getByRole('button', { name: /^Send \d+ invites$/ });
  await expect(go).toBeVisible();
  await page.clock.setSystemTime(todayAt(20));
  await go.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toasts .toast-err')).toHaveText([
    'No LinkedIn invites went out. LinkedIn invites go out between 08:00 and 20:00 your time.',
  ]);
  expect(app.calls).toEqual([]);
});

test('Open in LinkedIn shows Did it send ✓/✗ and ✓ marks sent', async ({ app, page, server }) => {
  const yes = LI.assistYes;
  await patchStatus(page, LI_ON);
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
  await patchStatus(page, LI_ON);
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
  await patchStatus(page, LI_ON);
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
  await patchStatus(page, { ...LI_AUTO, ...GMAIL });
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

test('a send never goes out over an edit that couldn’t be saved, and says so', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  const d = EMAIL.sendNow;
  const li = LI.counter;
  await patchStatus(page, { ...GMAIL, ...LI_ON });
  const failing = new Set([d.domain, li.domain]);
  await page.route(
    (url) => failing.has(url.pathname.split('/')[3]) && /^\/api\/drafts\/[^/]+$/.test(url.pathname),
    (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'database is locked' }) : route.fallback()),
  );
  const sends = [];
  await page.route(
    (url) => /^\/api\/drafts\/[^/]+\/send$/.test(url.pathname),
    (route) => {
      sends.push(new URL(route.request().url()).pathname);
      return route.fulfill({ json: { ok: true, message: 'Created in your Gmail Drafts.' } });
    },
  );
  await app.goto(`#/drafts/${d.domain}?tab=email`);
  await listReady(page);
  await emailBody(page).fill('An edit the server never gets.');
  await expect(saveState(page)).toHaveText('Couldn’t save: database is locked');
  const errors = page.locator('#toasts .toast-err');
  // (Error toasts stay until dismissed: each check clears them, so it counts only its own press's.)
  const dismissErrors = async () => {
    for (let n = await errors.count(); n > 0; n--) await errors.first().getByRole('button', { name: 'Dismiss' }).click();
    await expect(errors).toHaveCount(0);
  };
  await expect(errors).toHaveText(['Couldn’t save your edit: database is locked']);
  await dismissErrors();

  // Create Gmail draft tries the save again; when it still fails nothing is sent, and every press
  // says why (not just the first), in one toast.
  const push = detail(page).getByRole('button', { name: 'Create Gmail draft' });
  const notSent = 'Gmail draft not created — your edit couldn’t be saved: database is locked';
  await push.click();
  await expect(errors).toHaveText([notSent]);
  await dismissErrors();
  await expect(push).toBeEnabled();
  await push.click();
  await expect(errors).toHaveText([notSent]);
  await dismissErrors();
  expect(sends).toEqual([]);

  // Send all sends the others and leaves this one out, saying why.
  await page.getByRole('button', { name: 'Send all…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send all email drafts' });
  await dialog.getByRole('button', { name: /^Create \d+ Gmail drafts$/ }).click();
  await expect(errors.filter({ hasText: `${d.name}: your edit couldn’t be saved (database is locked)` })).toHaveCount(1);
  expect(sends.length).toBeGreaterThan(0);
  expect(sends).not.toContain(`/api/drafts/${d.domain}/send`);
  await dismissErrors();

  // Open in LinkedIn: the same.
  await app.goto(`#/drafts/${li.domain}?tab=linkedin`);
  await expect(note(page)).toBeEditable();
  await note(page).fill(`${li.body} (unsaved)`);
  await expect(saveState(page)).toHaveText('Couldn’t save: database is locked');
  await expect(errors).toHaveText(['Couldn’t save your edit: database is locked']);
  await dismissErrors();
  await detail(page).getByRole('button', { name: 'Open in LinkedIn' }).click();
  await expect(errors).toHaveText(['LinkedIn not opened — your edit couldn’t be saved: database is locked']);
  expect(app.calls).toEqual([]);
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
  await detail(page).getByRole('button', { name: 'Mark sent' }).press('Enter');
  await expect(toast(page).last()).toContainText(`Marked ${d.name} as sent.`);
  await expect(optionFor(page, d.domain)).toHaveCount(0);
  // The keyboard moves on to the draft that took its place, not to the top of the page.
  await expect(selected(page)).toBeFocused();
  await outreach(server, d.domain).toEqual([expect.objectContaining({ status: 'sent' })]);
});

test('with Gmail not connected, no email is offered to Gmail, and the screen says where to connect it', async ({
  app,
  page,
  server,
  request,
}) => {
  // The seeded workspace has no app password, no Gmail sign-in and no gcloud login: the server
  // can neither create a Gmail draft nor send, so neither is offered.
  const st = await realStatus(request, server);
  expect([st.destination_connected, st.gcloud_available]).toEqual([false, false]);
  let status = {};
  await daytime(page);
  await patchStatus(page, () => status);
  const sends = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && isEmailSend(new URL(r.url()))) sends.push(r.url());
  });
  const d = EMAIL.sendNow;
  await app.goto(`#/drafts/${d.domain}?tab=email`);
  await listReady(page);
  const desc = page.locator('.page-desc');
  await expect(desc).toContainText('Connect Gmail in Settings → Connections to put them in your Gmail Drafts from here.');
  await expect(desc).not.toContainText('Create Gmail draft puts it');
  const push = detail(page).locator('[data-action="push"]');
  const hint = detail(page).locator('.draft-hint');
  await expect(push).toHaveText('Create Gmail draft');
  await expect(push).toBeDisabled();
  await expect(hint).toHaveText('Gmail isn’t connected, so Create Gmail draft is off. Connect it in Settings → Connections.');
  await expect(hint.getByRole('link', { name: 'Settings → Connections' })).toHaveAttribute('href', '#/settings?tab=connections');
  await expectAccessible(page);

  // Send all leaves the emails out and says why: nothing to confirm on this tab.
  const sendAll = page.getByRole('button', { name: 'Send all…' });
  await sendAll.click();
  let dialog = page.getByRole('dialog', { name: 'Send all email drafts' });
  await expect(dialog).toContainText('Nothing goes out from here right now');
  await expect(dialog.locator('.sendall-email')).toHaveClass(/is-off/);
  await expect(dialog.locator('.sendall-email')).toContainText(
    'Gmail isn’t connected, so no Gmail drafts can be created. Connect it in Settings → Connections.',
  );
  await expect(dialog.getByRole('button', { name: /Gmail draft|^Send/ })).toHaveCount(0);
  await dialog.getByText('Close', { exact: true }).click();
  await expect(dialog).toBeHidden();

  // All, with LinkedIn auto-send on: only the invites are offered.
  status = LI_AUTO;
  await tab(page, 'All').click();
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  await expect(dialog.locator('.sendall-email')).toHaveClass(/is-off/);
  await expect(dialog.getByRole('button', { name: /^Send \d+ invites$/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Gmail|email/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // Email auto-send on: Send now is off the same way.
  status = { ...LI_AUTO, auto_send: true };
  await tab(page, 'Email').click();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(push).toHaveText(`Send now to ${firstName(d.domain)}`);
  await expect(push).toBeDisabled();
  await expect(hint).toHaveText('Gmail isn’t connected, so Send now is off. Connect it in Settings → Connections.');
  await expect(desc).toContainText('Connect Gmail in Settings → Connections to send them from here.');

  // A gcloud login reaches Gmail too: Create Gmail draft is back.
  status = { gcloud_available: true };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(push).toHaveText('Create Gmail draft');
  await expect(push).toBeEnabled();
  await expect(hint).toHaveCount(0);
  await expect(desc).toContainText('Create Gmail draft puts it in your Gmail Drafts');

  expect(sends).toEqual([]);
  expect(app.calls).toEqual([]);
});

test('with today’s email cap used up, Send now waits for tomorrow and says so', async ({ app, page }) => {
  let sentToday = 20;
  await patchStatus(page, () => ({ ...GMAIL, auto_send: true, daily_send_cap: 20, email_sent_today: sentToday }));
  const sends = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && isEmailSend(new URL(r.url()))) sends.push(r.url());
  });
  const d = EMAIL.sendNow;
  await app.goto(`#/drafts/${d.domain}?tab=email`);
  await listReady(page);
  const stats = page.locator('.drafts-stats');
  await expect(stats).toHaveText('Auto-send on · 20/20 today');
  const push = detail(page).locator('[data-action="push"]');
  const hint = detail(page).locator('.draft-hint');
  await expect(push).toHaveText(`Send now to ${firstName(d.domain)}`);
  await expect(push).toBeDisabled();
  await expect(hint).toHaveText(
    'The daily email cap is reached (20 of 20 sent), so Send now waits until tomorrow. Raise the cap in Settings → Sending.',
  );
  await expect(hint.getByRole('link', { name: 'Settings → Sending' })).toHaveAttribute('href', '#/settings?tab=sending');
  await tab(page, 'All').click();
  await expect(stats).toContainText('Email auto-send on · 20/20 today · LinkedIn');
  await tab(page, 'Email').click();

  // The cap raised (or a new day): the next status refresh brings Send now back.
  sentToday = 3;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(push).toBeEnabled();
  await expect(hint).toHaveCount(0);
  await expect(stats).toHaveText('Auto-send on · 3/20 today');
  expect(sends).toEqual([]);
});

test('Create Gmail draft puts the email in Gmail, even when it lands after leaving and coming back', async ({
  app,
  page,
  server,
}) => {
  // The send is routed (the harness has no Gmail): it does to the row what the server does (marks
  // it drafted), then answers as the server does. Both drafts' own tests ran earlier; the rows
  // are put back at the end.
  const [stay, away] = [EMAIL.quickClick, EMAIL.leaveRetry];
  await patchStatus(page, GMAIL);
  const sends = [];
  let hold = null; // what the next send waits for
  await page.route(isEmailSend, async (route) => {
    const domain = new URL(route.request().url()).pathname.split('/')[3];
    sends.push(domain);
    if (hold) await hold;
    writeDb(server, "UPDATE outreach SET status = 'drafted' WHERE domain = ? AND channel = 'email' AND status = 'draft_pending'", domain);
    await route.fulfill({ json: { ok: true, message: 'Created in your Gmail Drafts — open Gmail to review and send.' } });
  });
  const created = toast(page).filter({ hasText: 'Created in your Gmail Drafts — open Gmail to review and send.' });
  const push = detail(page).locator('[data-action="push"]');
  try {
    await app.goto(`#/drafts/${stay.domain}?tab=email`);
    await listReady(page);
    await expect(push).toHaveText('Create Gmail draft');
    await push.focus();
    await page.keyboard.press('Enter');
    await expect(created).toBeVisible();
    await expect(optionFor(page, stay.domain).locator('.draft-row-tags')).toContainText('In Gmail');
    await expect(detail(page).locator('.draft-head .badge')).toContainText(['In Gmail']);
    await expect(detail(page).getByRole('link', { name: 'Open Gmail' })).toBeVisible();
    await expect(detail(page).getByRole('button', { name: 'Mark sent' })).toBeEnabled();
    await expect(push).toHaveCount(0);
    // The draft was drawn again around its new state: the keyboard is on it (its heading), not
    // dropped to the top of the page, and not on Mark sent, where a second Enter would mark it
    // sent before it went out.
    await expect(detail(page).locator('.draft-name')).toBeFocused();
    expect(sends).toEqual([stay.domain]);
    await created.getByRole('button', { name: 'Dismiss' }).click();

    // Left and opened again while it's on its way: the screen showing when it lands shows it, and
    // offers no second Create Gmail draft (that would make a second copy in Gmail).
    let release;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    await optionFor(page, away.domain).click();
    await expect(push).toHaveText('Create Gmail draft');
    await push.click();
    await expect(push).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.locator('#view h1')).toHaveText('Home'); // Drafts has unmounted
    await page.goBack();
    await listReady(page);
    await expect(selected(page)).toHaveAttribute('data-domain', away.domain);
    await expect(push).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(created).toBeVisible();
    await expect(optionFor(page, away.domain).locator('.draft-row-tags')).toContainText('In Gmail');
    await expect(detail(page).getByRole('link', { name: 'Open Gmail' })).toBeVisible();
    await expect(detail(page).getByRole('button', { name: 'Mark sent' })).toBeEnabled();
    await expect(push).toHaveCount(0);
    expect(sends).toEqual([stay.domain, away.domain]);
  } finally {
    writeDb(
      server,
      "UPDATE outreach SET status = 'draft_pending' WHERE domain IN (?, ?) AND channel = 'email' AND status = 'drafted'",
      stay.domain,
      away.domain,
    );
  }
});

test('Send now sends the email, and it leaves the queue', async ({ app, page, server }) => {
  // Routed as above: the row is marked sent, and the answer is the server's.
  const d = EMAIL.quickSwitch;
  await patchStatus(page, { ...GMAIL, auto_send: true });
  const sends = [];
  await page.route(isEmailSend, async (route) => {
    const domain = new URL(route.request().url()).pathname.split('/')[3];
    sends.push(domain);
    writeDb(server, "UPDATE outreach SET status = 'sent' WHERE domain = ? AND channel = 'email' AND status = 'draft_pending'", domain);
    await route.fulfill({ json: { ok: true, message: `sent to ${d.to} (3/20 today)` } });
  });
  try {
    await app.goto(`#/drafts/${d.domain}?tab=email`);
    await listReady(page);
    const index = await options(page).evaluateAll((els, dom) => els.findIndex((el) => el.dataset.domain === dom), d.domain);
    const next = await options(page).nth(index + 1).getAttribute('data-domain');
    await detail(page).getByRole('button', { name: `Send now to ${firstName(d.domain)}` }).press('Enter');
    await page.getByRole('alertdialog', { name: 'Send this email now?' }).getByRole('button', { name: 'Send now' }).click();
    // In the screen's words, not the server's status line.
    await expect(toast(page).filter({ hasText: `Sent to ${person(d.domain)}.` })).toBeVisible();
    await expect(toast(page).filter({ hasText: 'today)' })).toHaveCount(0);
    await expect(optionFor(page, d.domain)).toHaveCount(0);
    // The selection, and the keyboard, move on to the draft that took its place.
    await expect(page).toHaveURL(hashIs(`#/drafts/${next}?tab=email`));
    await expect(optionFor(page, next)).toBeFocused();
    expect(sends).toEqual([d.domain]);
  } finally {
    writeDb(server, "UPDATE outreach SET status = 'draft_pending' WHERE domain = ? AND channel = 'email' AND status = 'sent'", d.domain);
  }
});

test('a row’s Send invite that goes out says so, and the draft leaves the list', async ({ app, page }) => {
  const d = LI.rowSent;
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  let sent = false; // the sender has sent it: the queue no longer has it
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      const res = await route.fetch();
      const rows = (await res.json()).filter((r) => !(sent && r.channel === 'linkedin' && r.domain === d.domain));
      await route.fulfill({ response: res, json: rows });
    },
  );
  await app.goto(`#/drafts/${d.domain}?tab=linkedin`);
  await listReady(page);
  await detail(page).getByRole('button', { name: `Send invite to ${firstName(d.domain)}` }).click();
  await page.getByRole('alertdialog', { name: 'Send this LinkedIn invite?' }).getByRole('button', { name: 'Send invite' }).click();
  await expect(detail(page).getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(optionFor(page, d.domain).locator('.draft-row-tags')).toContainText('Sending');
  // Its toasts say whose invite it is: several can be going out, and they land after the user has
  // moved on to another draft.
  await expect(toast(page).filter({ hasText: `Sending on LinkedIn to ${person(d.domain)}` })).toBeVisible();

  const refreshed = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/summary');
  sent = true;
  // (The row's poller looks every 2s.)
  await expect(toast(page).filter({ hasText: `Invite to ${person(d.domain)} sent on LinkedIn.` })).toBeVisible();
  await expect(optionFor(page, d.domain)).toHaveCount(0);
  await expect(selected(page)).toHaveCount(1);
  await refreshed; // the sidebar's counts catch up
  expect(app.calls.map((c) => c.path)).toEqual([`/api/drafts/${d.domain}/linkedin/send`]);
});

test('Open in LinkedIn landing after leaving and coming back asks Did it send?', async ({ app, page }) => {
  const d = LI.assistAway;
  await patchStatus(page, LI_ON);
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
  await app.goto(`#/drafts/${d.domain}?tab=linkedin`);
  await listReady(page);
  await detail(page).getByRole('button', { name: 'Open in LinkedIn' }).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…' })).toBeDisabled();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('#view h1')).toHaveText('Home'); // Drafts has unmounted
  await page.goBack();
  await listReady(page);
  await expect(selected(page)).toHaveAttribute('data-domain', d.domain);
  open();
  await expect(toast(page).filter({ hasText: 'Opened in LinkedIn' })).toBeVisible();
  // At once, not at the next status refresh (30s).
  await expect(detail(page).locator('.draft-ask')).toContainText('Did it send?');
  await expect(optionFor(page, d.domain).locator('.draft-row-tags')).toContainText('Opened');
  await detail(page).getByRole('button', { name: 'No, it didn’t' }).click();
  await expect(detail(page).getByRole('button', { name: 'Open in LinkedIn' })).toBeVisible();
});

test('Send all saves an edit made on the screen opened since it started, and leaves out one that can’t be saved', async ({
  app,
  page,
  server,
}) => {
  // Send all outlives the screen that started it. Left and opened again mid-run, the new screen
  // holds the edits: one still waiting on its 600ms autosave is saved before its email goes, and
  // one whose save failed keeps its email back, as on the screen that started the run. (Both
  // drafts are discarded by later tests: their text is free to change.)
  app.allowConsole(/Failed to load resource/);
  const [failing, waiting] = [EMAIL.discard, EMAIL.twice];
  await patchStatus(page, GMAIL);
  await page.route(
    (url) => url.pathname === `/api/drafts/${failing.domain}`,
    (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'disk full' }) : route.fallback()),
  );
  // Each send, with the text the server had for it when it was asked: the first waits at the gate,
  // so the run is still going while the test leaves and comes back.
  const sends = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(isEmailSend, async (route) => {
    const domain = new URL(route.request().url()).pathname.split('/')[3];
    const rows = rowsNow(server, "SELECT body FROM outreach WHERE domain = ? AND channel = 'email' AND status = 'draft_pending'", domain);
    sends.push({ domain, body: rows && rows[0] ? rows[0].body : undefined });
    if (sends.length === 1) await gate;
    await route.fulfill({ json: { ok: true, message: 'Created in your Gmail Drafts — open Gmail to review and send.' } });
  });
  await app.goto('#/drafts?tab=email');
  await listReady(page);
  // The run goes through the emails in list order: both are still ahead of it while it waits.
  const pendingDomains = new Set(pendingEmail.map((e) => e.domain));
  const order = (await options(page).evaluateAll((els) => els.map((el) => el.dataset.domain))).filter((dom) => pendingDomains.has(dom));
  expect(order.indexOf(failing.domain)).toBeGreaterThan(0);
  expect(order.indexOf(waiting.domain)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Send all…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send all email drafts' });
  await dialog.getByRole('button', { name: `Create ${order.length} Gmail drafts`, exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('#view h1')).toHaveText('Home'); // Drafts has unmounted
  await page.goBack();
  await listReady(page);
  await expect(page.locator('.page-actions .btn')).toHaveText(`Creating draft 1 of ${order.length}…`);

  // On the new screen: an edit whose save fails, then one still waiting on its autosave when the
  // run gets to it.
  await optionFor(page, failing.domain).click();
  await emailBody(page).fill('An edit the server never gets.');
  await expect(saveState(page)).toHaveText('Couldn’t save: disk full');
  await optionFor(page, waiting.domain).click();
  const text = 'Saved before Send all sent it.';
  await emailBody(page).fill(text);
  release();

  const summary = page.locator('#toasts .toast-err', { hasText: `${failing.name}: your edit couldn’t be saved (disk full)` });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(`Created ${order.length - 1} Gmail drafts. 1 failed:`);
  expect(sends.map((s) => s.domain)).not.toContain(failing.domain);
  expect(sends).toHaveLength(order.length - 1);
  expect(sends.find((s) => s.domain === waiting.domain)).toEqual({ domain: waiting.domain, body: text });
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
  // Nothing has gone out to it yet, so it's skipped.
  await expect(confirm).toContainText(`${d.name} is marked Skip, so it isn’t drafted again.`);
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

test('discarding one channel’s draft keeps the company while its other draft waits, and says so', async ({ app, page, server }) => {
  // A company nothing has gone out to, with an email and a LinkedIn note waiting: discarding the
  // email leaves the note to review and send, so the server doesn't skip the company, and neither
  // the confirm nor the toast says it does.
  const d = EMAIL.discardOther;
  const stage = COMPANIES.find((c) => c.domain === d.domain).status;
  const id = insertDraft(server, d.domain, { where: "status = 'drafted'", channel: 'linkedin', body: 'Hi, a short note.' });
  try {
    await app.goto(`#/drafts/${d.domain}?tab=email`);
    await listReady(page);
    await expect(selected(page)).toHaveAttribute('data-domain', d.domain);
    await expect(selected(page)).toContainText('Email');
    await detail(page).getByRole('button', { name: 'Discard' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Discard this draft?' });
    await expect(confirm).toContainText(`${d.name}’s LinkedIn note still waits, so it stays in Drafts.`);
    await expect(confirm).not.toContainText('Skip');
    await confirm.getByRole('button', { name: 'Discard draft' }).click();
    await expect(toast(page).last()).toContainText(`Draft discarded. ${d.name}’s LinkedIn note still waits in Drafts.`);
    await expect(toast(page).last()).not.toContainText('skipped');
    await outreach(server, d.domain).toEqual([{ channel: 'linkedin', status: 'draft_pending', body: 'Hi, a short note.', subject: '' }]);
    await dbRows(server, 'SELECT status FROM companies WHERE domain = ?', d.domain).toEqual([{ status: stage }]);
  } finally {
    deleteDraft(server, id);
  }
});

test('discarding a follow-up keeps the company in Follow-ups, and says so', async ({ app, page, server, request }) => {
  // Draft follow-up writes a draft for a company already written to. Discarding it leaves what
  // went out alone: the company keeps its stage (no Skip) and stays due in Follow-ups.
  const fu = COMPANIES.filter((c) => c.followup === 'due' && c.status === 'sent' && c.contacts[0].email)[1];
  const who = fu.contacts[0].founder_name;
  const id = insertDraft(server, fu.domain, { where: "status = 'sent'", subject: `Re: Quick idea for ${fu.name}`, body: 'Hi, following up.' });
  try {
    await app.goto(`#/drafts/${fu.domain}`);
    await listReady(page);
    await expect(detail(page).locator('.draft-name')).toHaveText(who);
    await detail(page).getByRole('button', { name: 'Discard' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Discard this draft?' });
    await expect(confirm).toContainText(
      `The email to ${who} is deleted. You’ve already been in touch with ${fu.name}, so it stays in Follow-ups.`,
    );
    await expect(confirm).not.toContainText('Skip');
    await confirm.getByRole('button', { name: 'Discard draft' }).click();
    await expect(toast(page).last()).toContainText(`Draft discarded. ${fu.name} stays in Follow-ups.`);
    await expect(toast(page).last()).not.toContainText('skipped');
    await expect(optionFor(page, fu.domain)).toHaveCount(0);
    await dbRows(server, 'SELECT status FROM companies WHERE domain = ?', fu.domain).toEqual([{ status: 'sent' }]);
    await dbRows(server, "SELECT count(*) AS n FROM outreach WHERE domain = ? AND status IN ('draft_pending', 'drafted')", fu.domain).toEqual([
      { n: 0 },
    ]);
    const followups = await (await request.get(server.apiUrl('/api/followups'))).json();
    expect(followups.find((f) => f.domain === fu.domain)).toEqual(expect.objectContaining({ state: 'due' }));
  } finally {
    deleteDraft(server, id); // (already gone when the discard went through)
  }
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
  const sendAll = page.getByRole('button', { name: 'Send all…' });
  await sendAll.click();
  let dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  const before = await sendableIn(dialog);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // A per-row Send invite (first send of the session: confirm) polls for the invite going out.
  await detail(page).getByRole('button', { name: `Send invite to ${firstName(d.domain)}` }).click();
  await page.getByRole('alertdialog', { name: 'Send this LinkedIn invite?' }).getByRole('button', { name: 'Send invite' }).click();
  await expect(toast(page).last()).toContainText('Sending on LinkedIn');
  await expect(detail(page).getByRole('button', { name: 'Sending…' })).toBeDisabled();
  // And a bulk send polls the queue. The invite already going out is that send's: Send all
  // neither counts it nor queues it.
  await sendAll.click();
  dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  await expect(dialog.locator('.sendall-linkedin')).toContainText('1 parked draft and 1 already sending excluded');
  expect(await sendableIn(dialog)).toBe(before - 1);
  await dialog.getByRole('button', { name: /^Send \d+ invites$/ }).click();
  await expect(page.getByRole('button', { name: 'Sending on LinkedIn…' })).toBeDisabled();
  const bulk = await page.evaluate(() => JSON.parse(sessionStorage.getItem('ct-li-bulk')));
  expect(bulk.keys).toHaveLength(before - 1);
  expect(bulk.keys).not.toContain(`linkedin:${d.domain}`);

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
  await expect(
    toast(page).filter({ hasText: `The invite to ${person(d.domain)} didn’t confirm. Check it in LinkedIn, or reload this page to try again.` }),
  ).toBeVisible();
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

test('a row send stops waiting on time even while the queue can’t be read', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  const d = LI.offline;
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  await app.goto(`#/drafts/${d.domain}?tab=linkedin`);
  await listReady(page);
  await detail(page).getByRole('button', { name: `Send invite to ${firstName(d.domain)}` }).click();
  await page.getByRole('alertdialog', { name: 'Send this LinkedIn invite?' }).getByRole('button', { name: 'Send invite' }).click();
  await expect(detail(page).getByRole('button', { name: 'Sending…' })).toBeDisabled();

  // The server stops answering for the queue: the watch still runs out, and says so.
  const polls = [];
  await page.route(
    (url) => url.pathname === '/api/drafts',
    (route) => {
      polls.push(Date.now());
      return route.fulfill({ status: 503, body: 'coldtrail isn’t answering' });
    },
  );
  await page.clock.runFor(ROW_TIMEOUT_MS);
  await expect(detail(page).locator('.draft-hint')).toHaveText(
    'The send didn’t confirm. Check the invite in LinkedIn, or reload this page to try again.',
    { timeout: 15_000 },
  );
  await expect(detail(page).getByRole('button', { name: 'Not confirmed' })).toBeDisabled();
  await expect(optionFor(page, d.domain).locator('.draft-row-tags')).toContainText('Unconfirmed');
  expect(polls.length).toBeGreaterThan(0);
  // …and stops asking.
  const seen = polls.length;
  await page.clock.runFor(10_000);
  await page.evaluate(() => fetch('/api/status').then((r) => r.status));
  expect(polls.length).toBe(seen);
});

test('Send all says so when every invite it would start is already going out from its draft', async ({ app, page }) => {
  // One LinkedIn note waits. Its own Send invite is still on its way when Send all opens (so the
  // dialog counts it), and has started by the time Send all is confirmed: that send owns it, so
  // the bulk sender has nothing to start, and the screen says so rather than nothing at all.
  const d = LI.ownRow;
  await daytime(page);
  await patchStatus(page, LI_AUTO);
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      const res = await route.fetch();
      const rows = (await res.json()).filter((r) => r.channel !== 'linkedin' || r.domain === d.domain);
      await route.fulfill({ response: res, json: rows });
    },
  );
  let start;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  await page.route(
    (url) => url.pathname === `/api/drafts/${d.domain}/linkedin/send`,
    async (route) => {
      await started;
      await route.fulfill({ json: { sending: true } });
    },
  );
  await app.goto(`#/drafts/${d.domain}?tab=linkedin`);
  await listReady(page);
  await expect(options(page)).toHaveCount(1);
  await detail(page).getByRole('button', { name: `Send invite to ${firstName(d.domain)}` }).click();
  await page.getByRole('alertdialog', { name: 'Send this LinkedIn invite?' }).getByRole('button', { name: 'Send invite' }).click();
  await expect(detail(page).locator('[data-action="invite"]')).toHaveAttribute('aria-busy', 'true');

  await page.getByRole('button', { name: 'Send all…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send all LinkedIn invites' });
  const confirm = dialog.getByRole('button', { name: 'Send 1 invite', exact: true });
  await expect(confirm).toBeVisible();
  start();
  await expect(optionFor(page, d.domain).locator('.draft-row-tags')).toContainText('Sending');
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(
    toast(page).filter({ hasText: 'No LinkedIn bulk send started: the invite is already being sent from its draft.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send all…' })).toBeEnabled();
  expect(app.calls.filter((c) => c.path === '/api/drafts/linkedin/send-all')).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('ct-li-bulk'))).toBeNull();
});

test('a row’s Send invite the sender gives up on says why at once: parked, signed out or at the cap', async ({
  app,
  page,
  server,
  request,
}) => {
  // The sender drives the invite in the background and leaves the screen no answer, but what it
  // gives up on shows: a draft it parks (LinkedIn wants the member's email), LinkedIn signed out,
  // a cap reached. The watch ends there, rather than "Sending…" for 4 minutes and then "didn't
  // confirm", and the toast (an error: it stays) names whose invite it was.
  const NEEDS_EMAIL = 'LinkedIn asks for their email to connect. Use Open in LinkedIn and enter it there, or discard this draft.';
  await daytime(page);
  let status = {};
  await patchStatus(page, () => ({ ...LI_AUTO, ...status }));
  const errors = page.locator('#toasts .toast-err');
  const sending = detail(page).getByRole('button', { name: 'Sending…' });
  const openIn = detail(page).getByRole('button', { name: 'Open in LinkedIn' });

  // Parked: LinkedIn wants the member's email.
  const parked = LI.parkedSend;
  await app.goto(`#/drafts/${parked.domain}?tab=linkedin`);
  await listReady(page);
  await detail(page).getByRole('button', { name: `Send invite to ${firstName(parked.domain)}` }).click();
  await page.getByRole('alertdialog', { name: 'Send this LinkedIn invite?' }).getByRole('button', { name: 'Send invite' }).click();
  await expect(sending).toBeDisabled();
  try {
    writeDb(
      server,
      "UPDATE outreach SET auto_skip = ? WHERE domain = ? AND channel = 'linkedin' AND status = 'draft_pending'",
      NEEDS_EMAIL,
      parked.domain,
    );
    await expect(errors).toHaveText([`The invite to ${person(parked.domain)} wasn’t sent. ${NEEDS_EMAIL}`]);
    await expect(detail(page).locator('.draft-banner')).toContainText(NEEDS_EMAIL);
    await expect(sending).toHaveCount(0);
    await expect(openIn).toBeEnabled();
    await expect(detail(page).getByRole('button', { name: /Send invite/ })).toHaveCount(0);
    await expect(optionFor(page, parked.domain).locator('.draft-row-tags')).toHaveText(/^LinkedIn\s*Parked$/);
  } finally {
    writeDb(server, "UPDATE outreach SET auto_skip = NULL WHERE domain = ? AND channel = 'linkedin'", parked.domain);
  }
  await errors.getByRole('button', { name: 'Dismiss' }).click();

  // Signed out (the sender found LinkedIn's sign-in page).
  const signedOut = LI.signedOutSend;
  await optionFor(page, signedOut.domain).click();
  await detail(page).getByRole('button', { name: `Send invite to ${firstName(signedOut.domain)}` }).click(); // (confirmed already)
  await expect(sending).toBeDisabled();
  status = { linkedin_reconnect_needed: true };
  await expect(errors).toHaveText([
    `The invite to ${person(signedOut.domain)} wasn’t sent. LinkedIn is signed out: reconnect it in Settings → Connections.`,
  ]);
  await expect(detail(page).locator('.draft-hint')).toHaveText(
    'LinkedIn is signed out, so Open in LinkedIn and Send invite are off. Reconnect it in Settings → Connections.',
  );
  await expect(sending).toHaveCount(0);
  await errors.getByRole('button', { name: 'Dismiss' }).click();

  // The cap: another send (a schedule's, say) used the last of today's before this one's turn.
  status = {};
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // (signed in again)
  const capped = LI.cappedSend;
  await optionFor(page, capped.domain).click();
  const invite = detail(page).getByRole('button', { name: `Send invite to ${firstName(capped.domain)}` });
  await expect(invite).toBeEnabled();
  await invite.click();
  await expect(sending).toBeDisabled();
  const today = (await realStatus(request, server)).linkedin_sent_today;
  status = { linkedin_daily_cap: today };
  await expect(errors).toHaveText([
    `The invite to ${person(capped.domain)} wasn’t sent. The daily LinkedIn cap is reached (${today} of ${today} sent today).`,
  ]);
  await expect(detail(page).locator('.draft-hint')).toContainText('The daily LinkedIn cap is reached');
  await expect(openIn).toBeEnabled();
  expect(app.calls.map((c) => c.path)).toEqual(
    [parked, signedOut, capped].map((d) => `/api/drafts/${d.domain}/linkedin/send`),
  );
});

test('a draft on its way out can’t be edited, so what goes out is what it shows', async ({ app, page }) => {
  // The server sends the text it has stored. While an email is being put in Gmail or sent (by
  // itself or by Send all), or a note is opening in LinkedIn, waiting on "Did it send?" or being
  // sent by coldtrail, an edit would never reach Gmail or LinkedIn: the editor is read-only and
  // says why, until that's over.
  await daytime(page);
  let auto = false;
  await patchStatus(page, () => ({ ...GMAIL, ...LI_AUTO, auto_send: auto }));
  const held = []; // the email sends asked for, each held until released
  let release = () => {};
  await page.route(
    (url) => isEmailSend(url),
    async (route) => {
      held.push(new URL(route.request().url()).pathname);
      await new Promise((resolve) => {
        release = resolve;
      });
      await route.fulfill({ json: { ok: false, message: 'COLDTRAIL_NO_SEND is set: dry run, nothing sent' } });
    },
  );
  const d = pendingEmail[0];
  await app.goto(`#/drafts/${d.domain}?tab=email`);
  await listReady(page);
  const subject = detail(page).getByRole('textbox', { name: 'Subject' });
  const lock = detail(page).locator('.draft-lock');
  await expect(emailBody(page)).toBeEditable();
  await expect(lock).toBeHidden();

  // Create Gmail draft.
  await detail(page).getByRole('button', { name: 'Create Gmail draft' }).click();
  await expect(detail(page).getByRole('button', { name: 'Creating…' })).toBeVisible();
  const creating = 'Being put in your Gmail Drafts: edits are off until it’s there.';
  await expect(lock).toHaveText(creating);
  await expect(emailBody(page)).not.toBeEditable();
  await expect(subject).not.toBeEditable();
  await expect(emailBody(page)).toHaveAccessibleDescription(creating);
  release();
  // It didn't go: editing is back.
  await expect(toast(page).filter({ hasText: 'Gmail draft not created' })).toBeVisible();
  await expect(emailBody(page)).toBeEditable();
  await expect(subject).toBeEditable();
  await expect(lock).toBeHidden();
  await expect(emailBody(page)).toHaveAccessibleDescription('');

  // Send now.
  auto = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await detail(page).getByRole('button', { name: /^Send now/ }).click();
  await page.getByRole('alertdialog', { name: 'Send this email now?' }).getByRole('button', { name: 'Send now' }).click();
  await expect(lock).toHaveText('Being sent: edits are off while it goes out.');
  await expect(emailBody(page)).not.toBeEditable();
  release();
  await expect(emailBody(page)).toBeEditable();

  // Send all, while it works on this email.
  await page.getByRole('button', { name: 'Send all…' }).click();
  await page.getByRole('dialog', { name: 'Send all email drafts' }).getByRole('button', { name: /^Send \d+ emails$/ }).click();
  await expect.poll(() => held.length).toBe(3);
  expect(held[2]).toBe(`/api/drafts/${d.domain}/send`);
  await expect(lock).toHaveText('Being sent: edits are off while it goes out.');
  await expect(emailBody(page)).not.toBeEditable();
  release();
  await expect(toast(page).filter({ hasText: 'Sent 0 emails. Stopped:' })).toBeVisible();
  await expect(emailBody(page)).toBeEditable();
  await expect(lock).toBeHidden();

  // A LinkedIn note: opening in LinkedIn, then open there until "Did it send?" is answered.
  const li = LI.lockOpen;
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  await page.route(
    (url) => url.pathname === `/api/drafts/${li.domain}/linkedin/assist`,
    async (route) => {
      await opened;
      await route.fulfill({ json: { staged: true } });
    },
  );
  await tab(page, 'LinkedIn').click();
  await optionFor(page, li.domain).click();
  await expect(note(page)).toBeEditable();
  await detail(page).getByRole('button', { name: 'Open in LinkedIn' }).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…' })).toBeVisible();
  await expect(lock).toHaveText('Being opened in LinkedIn: edits are off until it’s open.');
  await expect(note(page)).not.toBeEditable();
  open();
  await expect(detail(page).locator('.draft-ask')).toContainText('Did it send?');
  const staged = 'This note is open in LinkedIn: change it there if you need to. Editing here is off until you answer Did it send?';
  await expect(lock).toHaveText(staged);
  await expect(note(page)).not.toBeEditable();
  await expect(note(page)).toHaveAccessibleDescription(new RegExp(`^\\d+ / 300 ${reEscape(staged)}$`));
  await detail(page).getByRole('button', { name: 'No, it didn’t' }).click();
  await expect(note(page)).toBeEditable();
  await expect(lock).toBeHidden();
  await expect(note(page)).toHaveAccessibleDescription(/^\d+ \/ 300$/);

  // …and while coldtrail sends it (its watch ends when it leaves the queue, or gives up).
  await detail(page).getByRole('button', { name: `Send invite to ${firstName(li.domain)}` }).click();
  await page.getByRole('alertdialog', { name: 'Send this LinkedIn invite?' }).getByRole('button', { name: 'Send invite' }).click();
  await expect(detail(page).getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(lock).toHaveText('Being sent on LinkedIn: edits are off while it goes out.');
  await expect(note(page)).not.toBeEditable();
});

test('Open in LinkedIn finding LinkedIn signed out turns it off at once, and says how to reconnect', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  const d = LI.assistSignedOut;
  let signedOut = false;
  await patchStatus(page, () => (signedOut ? { ...LI_ON, linkedin_reconnect_needed: true } : LI_ON));
  await page.route(
    (url) => url.pathname === `/api/drafts/${d.domain}/linkedin/assist`,
    (route) => {
      signedOut = true; // the server records it, then says so
      return route.fulfill({ status: 409, body: 'LinkedIn is signed out — reconnect it in Settings → Connections' });
    },
  );
  await app.goto(`#/drafts/${d.domain}?tab=linkedin`);
  await listReady(page);
  const openIn = detail(page).getByRole('button', { name: 'Open in LinkedIn' });
  await openIn.click();
  await expect(page.locator('#toasts .toast-err')).toHaveText([
    'LinkedIn not opened. LinkedIn is signed out: reconnect it in Settings → Connections.',
  ]);
  // At once, not at the next status refresh (30s): nothing offers to open it again.
  await expect(openIn).toBeDisabled();
  await expect(detail(page).locator('.draft-hint')).toHaveText(
    'LinkedIn is signed out, so Open in LinkedIn is off. Reconnect it in Settings → Connections.',
  );
  await expect(page.locator('.page-desc')).toContainText('Reconnect LinkedIn in Settings → Connections');
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
  // Until the queue arrives the tabs count what the sidebar does (the summary's), never a 0, and
  // the counts don't jump when it lands.
  await expect(page.locator('.page-desc')).toHaveText('Loading the review queue…');
  const barTop = async () => (await page.locator('.drafts-bar').boundingBox()).y;
  const loadingTop = await barTop();
  const nav = page.locator('#nav a[data-route="drafts"] .nav-count');
  await expect(nav).toHaveText(/^[1-9]/);
  await expect(tab(page, 'All').locator('.tab-count')).toHaveText((await nav.textContent()).trim());
  const linkedin = tab(page, 'LinkedIn').locator('.tab-count');
  await expect(linkedin).toHaveText(/^[1-9]/);
  const linkedinCount = (await linkedin.textContent()).trim();
  release();
  await listReady(page);
  await expect(linkedin).toHaveText(linkedinCount);
  await expect(page.locator('.drafts-body')).not.toHaveAttribute('aria-busy', 'true');
  // The longer description that replaces the loading line doesn't push the tabs and the list
  // down, and neither does a tab whose description is shorter.
  await expect(page.locator('.page-desc')).toContainText('waiting for review.');
  expect(await barTop()).toBe(loadingTop);
  await tab(page, 'LinkedIn').click();
  await expect(page.locator('.page-desc')).toContainText('Connect LinkedIn in Settings → Connections');
  expect(await barTop()).toBe(loadingTop);
  await tab(page, 'All').click();

  await page.unrouteAll({ behavior: 'wait' });
  let fail = true;
  await page.route(
    (url) => url.pathname === '/api/drafts',
    (route) => (fail ? route.fulfill({ status: 500, body: 'database is locked' }) : route.fallback()),
  );
  await app.goto('#/drafts');
  await expect(page.getByRole('heading', { name: 'Couldn’t load drafts' })).toBeVisible();
  await expect(page.getByText('database is locked')).toBeVisible();
  // It's announced, as every screen's load error is.
  await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t load drafts' })).toContainText('database is locked');
  // The header no longer says it's loading, and keeps its place: the title, Send all and the tabs
  // don't move.
  await expect(page.locator('.page-desc')).toHaveText(ERROR_DESC);
  await expect(page.getByText('Loading the review queue…')).toHaveCount(0);
  expect(await barTop()).toBe(loadingTop);
  // Try again from the keyboard: failing again, the keyboard stays on Try again; then the list
  // lands with the keyboard on the open draft's row, never back at the top of the page.
  const tryAgain = page.getByRole('button', { name: 'Try again' });
  await tryAgain.focus();
  await page.keyboard.press('Enter');
  await expect(tryAgain).toBeFocused();
  fail = false;
  await page.keyboard.press('Enter');
  await listReady(page);
  await expect(selected(page)).toBeFocused();

  // Phone: onto the first row of the list.
  fail = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await app.goto('#/drafts');
  await tryAgain.focus();
  fail = false;
  await page.keyboard.press('Enter');
  await listReady(page);
  await expect(options(page).first()).toBeFocused();
});

test('a stale session says to reopen coldtrail, and offers no Try again', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  // The queue can't load: the shell's banner has the full sentence (once); the screen says what
  // to do, and has no Try again (it can't work until coldtrail is reopened).
  let stale = true;
  await page.route(
    (url) => url.pathname === '/api/drafts',
    (route) => (stale ? route.fulfill({ status: 401, body: 'Unauthorized' }) : route.fallback()),
  );
  await app.goto('#/drafts');
  const panel = page.locator('.drafts-panel');
  await expect(panel.getByRole('heading', { name: 'Couldn’t load drafts' })).toBeVisible();
  await expect(panel).toContainText(SESSION_REOPEN);
  await expect(panel.getByRole('button')).toHaveCount(0);
  await expect(panel).not.toHaveAttribute('role', 'alert'); // (the shell's banner is the alert)
  await expect(page.getByText(SESSION_EXPIRED)).toHaveCount(1);
  await expect(page.locator('.page-desc')).toHaveText(ERROR_DESC);

  // An edit whose save meets a stale session: the same pointer beside the editor and in the toast.
  stale = false;
  const d = LI.stale;
  await page.route(
    (url) => url.pathname === `/api/drafts/${d.domain}`,
    (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 401, body: 'Unauthorized' }) : route.fallback()),
  );
  await app.goto(`#/drafts/${d.domain}`);
  await expect(note(page)).toBeEditable();
  await note(page).fill(`${d.body} (stale)`);
  await expect(saveState(page)).toHaveText(`Couldn’t save: ${SESSION_REOPEN}`);
  await expect(page.locator('#toasts .toast-err')).toHaveText([`Couldn’t save your edit: ${SESSION_REOPEN}`]);
  await expect(page.getByText(SESSION_EXPIRED)).toHaveCount(1);
});

test('Send all stops at a stale session, and doesn’t try the LinkedIn sender after it', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  await daytime(page);
  await patchStatus(page, { ...LI_AUTO, ...GMAIL });
  // The first email meets a stale session; so would the LinkedIn sender's start.
  const sends = [];
  let bulkStarts = 0;
  await page.route(
    (url) => /^\/api\/drafts\/[^/]+\/send$/.test(url.pathname),
    (route) => {
      sends.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 401, body: 'Unauthorized' });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/drafts/linkedin/send-all',
    (route) => {
      bulkStarts++;
      return route.fulfill({ status: 401, body: 'Unauthorized' });
    },
  );
  await app.goto('#/drafts');
  await listReady(page);
  await page.getByRole('button', { name: 'Send all…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send all drafts' });
  const go = dialog.getByRole('button', { name: /^Create \d+ Gmail drafts and send \d+ invites$/ });
  await go.click();
  await expect(dialog).toBeHidden(); // the run is over
  // One toast says what happened, and what to do.
  await expect(toast(page)).toHaveText([
    new RegExp(`^Created 0 Gmail drafts\\. 1 failed:\\s+.+: ${reEscape(SESSION_REOPEN)}$`),
  ]);
  expect(sends).toHaveLength(1);
  expect(bulkStarts).toBe(0);
  await expect(page.getByText(SESSION_EXPIRED)).toHaveCount(1);
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
  // The names come with the queue; without the company's details there is no source line.
  await expect(optionFor(page, d.domain).locator('.draft-row-title')).toHaveText(person(d.domain));
  await expect(detail(page).locator('.draft-name')).toHaveText(person(d.domain));
  await expect(note(page)).toBeEditable();
  await expect(detail(page).locator('.draft-source')).toBeHidden();
  // Discard can't tell whether anything has gone out to the company, so it says what happens
  // either way.
  await detail(page).getByRole('button', { name: 'Discard' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Discard this draft?' });
  await expect(confirm).toContainText(`If nothing has gone out to ${d.name} yet, it’s marked Skip, so it isn’t drafted again.`);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();

  // A draft whose contact and company have no names falls back to the domain and recipient.
  await page.route(
    (url) => url.pathname === '/api/drafts',
    async (route) => {
      const res = await route.fetch();
      const rows = (await res.json()).map((r) => (r.domain === d.domain ? { ...r, contact_name: null, company_name: '  ' } : r));
      await route.fulfill({ response: res, json: rows });
    },
  );
  await page.reload();
  const row = optionFor(page, d.domain);
  await expect(row.locator('.draft-row-title')).toHaveText(d.domain);
  await expect(row.locator('.draft-row-sub')).toHaveText(d.to.replace(/^https:\/\/(www\.)?linkedin\.com\//, ''));
  await expect(detail(page).locator('.draft-name')).toHaveText(d.domain);
  await expect(note(page)).toBeEditable();
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

test('on laptop screens a draft’s actions stay in view and clear of toasts, and its details, note and the filter hint fit', async ({
  app,
  page,
}) => {
  await daytime(page);
  // LinkedIn drafts show their full bar, Send invite included; emails their usual one.
  let gmail = true;
  await patchStatus(page, () => ({ ...LI_AUTO, ...(gmail ? GMAIL : {}) }));
  const showError = (text) => errorToast(page, text);
  const clearToasts = async () => {
    while (await toast(page).count()) await toast(page).first().getByRole('button', { name: 'Dismiss' }).click();
  };
  // Where the toasts are against the draft's action bar: all on screen, none over any part of the
  // bar, and in their usual place (bottom right) whenever the stack fits there below the bar.
  // (They're placed when the stack resizes, before it's painted: polled, not read once.)
  const placement = () =>
    page.evaluate(() => {
      const vh = document.documentElement.clientHeight;
      const host = document.getElementById('toasts');
      const stack = host.getBoundingClientRect();
      const bar = document.querySelector('.draft-foot').getBoundingClientRect();
      const toasts = [...host.querySelectorAll('.toast')].map((t) => t.getBoundingClientRect());
      const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const edge = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-4'));
      const lifted = stack.bottom < vh - edge - 0.5;
      const fitsBelow = bar.bottom + 8 <= vh - edge - stack.height;
      return {
        toasts: toasts.length,
        onScreen: toasts.every((t) => t.top >= 0 && t.bottom <= vh),
        overBar: toasts.some((t) => hit(t, bar)),
        usualWhenItFits: !fitsBelow || !lifted,
        lifted,
      };
    });
  const clear = (n) => ({ toasts: n, onScreen: true, overBar: false, usualWhenItFits: true, lifted: expect.any(Boolean) });

  // An email's body takes the room the pane has left above the actions, which sit at the pane's
  // bottom edge (pinned there when a short window makes the pane scroll). Toasts (an error stays
  // until dismissed) stack above them rather than over Send and Discard.
  const d = EMAIL.autosave;
  for (const [width, height, hash] of [
    [1366, 768, `#/drafts/${d.domain}?tab=email`],
    [1280, 800, `#/drafts/${d.domain}`],
    [1440, 900, `#/drafts/${d.domain}?tab=email`],
  ]) {
    const at = `${width}×${height}`;
    await page.setViewportSize({ width, height });
    await app.goto(hash);
    await listReady(page);
    await expect(emailBody(page)).toBeVisible();
    await expect(detail(page).locator('[data-action="push"]'), at).toBeInViewport({ ratio: 1 });
    await expect(detail(page).getByRole('button', { name: 'Discard' }), at).toBeInViewport({ ratio: 1 });
    await showError('Couldn’t save your edit: disk full');
    await expect.poll(placement, at).toEqual({ ...clear(1), lifted: true });
    const shown = await page.locator('#toasts .toast-err').boundingBox();
    const foot = await detail(page).locator('.draft-foot').boundingBox();
    expect(shown.y + shown.height, at).toBeLessThanOrEqual(foot.y);
    await clearToasts();
  }

  // With Gmail not connected (as setup's "Skip for now" leaves it) the hint takes a line of its own
  // above the buttons, which keep to one row, and the body ends at the bar rather than running
  // under it, leaving most of a laptop's pane to read it in.
  gmail = false;
  const foot = () =>
    page.evaluate(() => {
      const bar = document.querySelector('.draft-foot').getBoundingClientRect();
      const hint = document.querySelector('.draft-foot .draft-hint').getBoundingClientRect();
      const text = document.getElementById('draft-body');
      const body = text.getBoundingClientRect();
      const cs = getComputedStyle(text);
      const buttons = [...document.querySelectorAll('.draft-foot .btn')].map((b) => b.getBoundingClientRect());
      return {
        buttonRows: new Set(buttons.map((b) => Math.round(b.top))).size,
        hintAbove: buttons.every((b) => b.top >= hint.bottom),
        bodyClear: body.bottom <= bar.top + 0.5,
        // Whole lines of the body on show.
        bodyLines: Math.floor(
          (text.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight),
        ),
      };
    });
  for (const [width, height, lines] of [
    [1366, 768, 4],
    [1440, 900, 9],
    [1920, 1080, 17],
  ]) {
    const at = `no Gmail ${width}×${height}`;
    await page.setViewportSize({ width, height });
    await app.goto(`#/drafts/${d.domain}?tab=email`);
    await expect(detail(page).locator('.draft-hint')).toContainText('Gmail isn’t connected');
    const m = await foot();
    expect(m, at).toEqual({ buttonRows: 1, hintAbove: true, bodyClear: true, bodyLines: expect.any(Number) });
    expect(m.bodyLines, at).toBeGreaterThanOrEqual(lines);
  }
  // A short window: the hint is still above the buttons, on one row.
  await page.setViewportSize({ width: 1024, height: 768 });
  await app.goto(`#/drafts/${d.domain}?tab=email`);
  await expect(detail(page).locator('.draft-hint')).toContainText('Gmail isn’t connected');
  expect(await foot()).toEqual(expect.objectContaining({ buttonRows: 1, hintAbove: true }));
  gmail = true;

  // A LinkedIn note is short (300 characters at most): its bar sits mid-pane, in one row or, from
  // 900 to ~1000px wide, two. The toasts stay below it where there's room, and move above it where
  // there isn't, never over Discard, Open in LinkedIn or Send invite.
  const li = LI.autosave;
  for (const [width, height] of [
    [1366, 768],
    [1440, 790],
    [1280, 800],
    [1100, 800],
    [1280, 720],
    [960, 720],
    [1440, 900],
  ]) {
    const at = `LinkedIn ${width}×${height}`;
    await page.setViewportSize({ width, height });
    await app.goto(`#/drafts/${li.domain}`);
    await expect(note(page)).toBeVisible();
    await expect(detail(page).getByRole('button', { name: `Send invite to ${firstName(li.domain)}` })).toBeVisible();
    await showError('Couldn’t save your edit: disk full');
    await expect.poll(placement, at).toEqual(clear(1));
    // Plenty of room below the bar: the toast stays where toasts always are.
    if (height === 900) expect((await placement()).lifted, at).toBe(false);
    if (width === 960) {
      const rows = await detail(page)
        .locator('.draft-foot button')
        .evaluateAll((bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size);
      expect(rows, `${at}: the bar wraps`).toBeGreaterThan(1);
    }
    if (width === 1280 && height === 720) {
      // A taller stack moves as one.
      await showError('Your edit to Acme wasn’t saved: disk full\nTry again in a moment.');
      await expect.poll(placement, at).toEqual(clear(2));
    }
    await clearToasts();
  }

  // Leaving the screen puts the toasts back in their usual place.
  await page.setViewportSize({ width: 1366, height: 768 });
  await app.goto(`#/drafts/${d.domain}`);
  await expect(emailBody(page)).toBeVisible();
  await showError('Couldn’t save your edit: disk full');
  await expect.poll(placement).toEqual({ ...clear(1), lifted: true });
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page).toHaveURL(hashIs('#/home'));
  await expect
    .poll(() =>
      page.evaluate(() => ({
        lift: document.documentElement.style.getPropertyValue('--drafts-toast-lift'),
        gap: document.documentElement.clientHeight - document.getElementById('toasts').getBoundingClientRect().bottom,
      })),
    )
    .toEqual({ lift: '', gap: 16 });
  await clearToasts();

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

  // At this width a LinkedIn draft's details wrap onto more lines: none starts or ends on a "·"
  // (each item draws its own in front, and the one before an item that starts a line is clipped).
  await app.goto(`#/drafts/${LI.autosave.domain}`);
  await expect(note(page)).toBeVisible();
  const meta = detail(page).locator('.draft-meta');
  await expect(meta.getByRole('link')).toHaveCount(2);
  const layout = await meta.evaluate((p) => {
    const clip = p.getBoundingClientRect().left;
    let top = null;
    let lines = 0;
    const dots = [];
    for (const item of p.querySelectorAll('.draft-meta-item')) {
      const box = item.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(item);
      const sep = parseFloat(getComputedStyle(item, '::before').width);
      const startsLine = top === null || box.top > top + 1;
      if (startsLine) {
        lines++;
        top = box.top;
      }
      // The "·" sits in the middle of its box, just before the text: shown only inside the clip.
      dots.push({ startsLine, shown: text.getBoundingClientRect().left - sep / 2 > clip });
    }
    return { lines, dots };
  });
  expect(layout.lines).toBeGreaterThan(1);
  expect(layout.dots.map((x) => x.shown)).toEqual(layout.dots.map((x) => !x.startsLine));
  // A focused link's ring (base.css: 2px wide, 2px out) isn't cut off by either clip.
  const RING = 4;
  for (const link of await meta.getByRole('link').all()) {
    const room = await link.evaluate((a, ring) => {
      const r = a.getBoundingClientRect();
      const item = a.closest('.draft-meta-item').getBoundingClientRect();
      const row = a.closest('.draft-meta').getBoundingClientRect();
      return [
        r.left - ring >= Math.max(item.left, row.left) - 0.5,
        r.right + ring <= Math.min(item.right, row.right) + 0.5,
        r.top - ring >= item.top - 0.5,
        r.bottom + ring <= item.bottom + 0.5,
      ];
    }, RING);
    expect(room).toEqual([true, true, true, true]);
  }
  // The note shows in full, with no scrolling inside it.
  expect(await note(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
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

  // The draft's actions are the last thing on the page, where the toasts are: an error toast (it
  // stays until dismissed) never leaves them out of reach. Scrolled to the end, they're clear of it.
  await row.click();
  await expect(detail(page)).toBeVisible();
  await errorToast(
    page,
    'Gmail draft not created — a long reason that wraps onto several lines of the toast, as the server’s own messages can, so the stack is tall.',
  );
  const atTheEnd = () =>
    page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const toasts = [...document.querySelectorAll('#toasts .toast')].map((t) => t.getBoundingClientRect());
      const buttons = [...document.querySelectorAll('.draft-foot .btn')].map((b) => b.getBoundingClientRect());
      return { toasts: toasts.length, buttons: buttons.length, covered: buttons.some((b) => toasts.some((t) => hit(t, b))) };
    });
  await expect.poll(atTheEnd).toEqual({ toasts: 1, buttons: expect.any(Number), covered: false });
  expect((await atTheEnd()).buttons).toBeGreaterThan(1);
  expect(await scrollWidth()).toBeLessThanOrEqual(390);
  // Dismissed: the room goes with it.
  await toast(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--drafts-toast-room')))
    .toBe('');
});

test('phone width: a draft that leaves the queue hands over to the next one, at its name', async ({ app, page }) => {
  // On a phone the list is hidden while a draft is open, so when Discard or "Yes, it sent" takes
  // the draft away, the keyboard (and a screen reader, which reads the name out) goes to the draft
  // that took its place, scrolled into view below the top bar.
  await page.setViewportSize({ width: 390, height: 844 });
  await patchStatus(page, LI_ON);
  const name = detail(page).locator('.draft-name');
  const clearOfTopBar = () =>
    page.evaluate(() => {
      const h = document.querySelector('.draft-name').getBoundingClientRect();
      const bar = document.getElementById('topbar').getBoundingClientRect();
      return h.top >= bar.bottom && h.bottom <= document.documentElement.clientHeight;
    });

  const gone = LI.phoneDiscard;
  await app.goto(`#/drafts/${gone.domain}?tab=linkedin`);
  await expect(name).toHaveText(person(gone.domain));
  await detail(page).getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('alertdialog', { name: 'Discard this draft?' }).getByRole('button', { name: 'Discard draft' }).click();
  await expect(toast(page).filter({ hasText: 'Draft discarded.' })).toBeVisible();
  await expect(name).not.toHaveText(person(gone.domain));
  await expect(page).not.toHaveURL(new RegExp(reEscape(gone.domain)));
  await expect(name).toBeFocused();
  expect(await clearOfTopBar()).toBe(true);

  const sent = LI.phoneYes;
  await app.goto(`#/drafts/${sent.domain}?tab=linkedin`);
  await expect(name).toHaveText(person(sent.domain));
  await detail(page).getByRole('button', { name: 'Open in LinkedIn' }).click();
  await detail(page).getByRole('button', { name: 'Yes, it sent' }).click();
  await expect(toast(page).filter({ hasText: 'Marked sent.' })).toBeVisible();
  await expect(name).not.toHaveText(person(sent.domain));
  await expect(name).toBeFocused();
  expect(await clearOfTopBar()).toBe(true);
});

test.describe('empty workspace', () => {
  test.use({ seed: 'onboarded' });

  test('explains where drafts come from', async ({ app, page }) => {
    let auto = false;
    await patchStatus(page, () => ({ auto_send: auto }));
    await app.goto('#/drafts');
    await expect(page.getByRole('heading', { name: 'No drafts waiting' })).toBeVisible();
    const openAgent = page.getByRole('link', { name: 'Open Agent' });
    await expect(openAgent).toHaveAttribute('href', '#/agent');
    // A status refresh (every 30s) leaves the empty state, and the keyboard on its link, alone.
    await openAgent.focus();
    auto = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.drafts-stats')).toContainText('Email auto-send on'); // it landed
    await expect(openAgent).toBeFocused();
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

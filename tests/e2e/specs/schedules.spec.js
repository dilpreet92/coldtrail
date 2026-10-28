// Schedules (spec §5.7; inventory "Cron"): schedule rows with cadence, task, an enabled switch,
// next and last run and a ⋯ menu (Run now, Dry run, Edit, Delete); the create/edit dialog with
// the next three run times and what the schedule may send; and the run history. Every server is
// the harness's (COLDTRAIL_NO_TIMERS=1), so saving a schedule writes its row but never installs
// a launchd/systemd timer; `no plist is written` proves it by only listing the real folder.
//
// Tests share one server in order: the toggle, edit, create, delete and run tests each leave the
// workspace as the next one expects (see the comments at each).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { SEED } from '../harness/seed.mjs';
import { SESSION_EXPIRED } from '../../../ui/js/core/api.js';
import { fmtDate, fmtNum, fmtRelative } from '../../../ui/js/core/format.js';

const LUNCH = SEED.schedules.lunch;
const WEEKLY = SEED.schedules.weekly;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TRIGGER = { scheduled: 'Scheduled', manual: 'Manual', dry: 'Dry run' };
const STATUS = { ok: 'Succeeded', error: 'Failed', auth_failed: 'Sign-in failed' };

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashIs = (hash) => new RegExp(`${reEscape(hash)}$`);

/**
 * The next `n` times a schedule fires, in local time: the server's rule (`summary::next_run_at`,
 * the OS timer's calendar): today at HH:MM if still ahead, else tomorrow; weekly → the next
 * matching weekday (+7 days when today's slot has passed); a bad time → 09:00; no weekday → Mon.
 */
function nextRuns({ freq, time, weekday }, n = 3, now = new Date()) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(time || '');
  const [hh, mm] = m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? [Number(m[1]), Number(m[2])] : [9, 0];
  const first = new Date(now);
  first.setHours(hh, mm, 0, 0);
  if (freq === 'weekly') {
    let add = (((weekday ?? 1) % 7) - now.getDay() + 7) % 7;
    if (add === 0 && first <= now) add = 7;
    first.setDate(first.getDate() + add);
  } else if (first <= now) {
    first.setDate(first.getDate() + 1);
  }
  const step = freq === 'weekly' ? 7 : 1;
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(first);
    d.setDate(d.getDate() + i * step);
    return d;
  });
}

/** "Fri, Oct 30, 16:30": how the screen names one run time. */
const runLabel = (d) => `${DAYS[d.getDay()]}, ${fmtDate(d, { time: true })}`;
/** The next-run cell: relative within 48h ("in 3h"), else the dated label. */
const nextText = (d) => {
  const rel = fmtRelative(d);
  return /^in |^just now$/.test(rel) ? rel : runLabel(d);
};
const cadence = (s) =>
  s.freq === 'weekly' ? `Weekly · ${DAYS[(s.weekday ?? 1) % 7]} ${s.time}` : `Daily at ${s.time}`;
const counts = (r) =>
  `${fmtNum(r.sourced)} sourced · ${fmtNum(r.enriched)} enriched · ${fmtNum(r.drafted)} drafted · ${fmtNum(r.sent)} sent`;

/** The row for the schedule named exactly `name`. */
const toastWith = (page, text) => page.locator('.toast').filter({ hasText: text });

const row = (page, name) =>
  page.locator('.sch-row').filter({ has: page.locator('.sch-name').getByText(name, { exact: true }) });

async function ready(page) {
  await expect(page.locator('#view h1')).toHaveText('Schedules');
  await expect(page.locator('.sch-list')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.sch-history')).toHaveAttribute('aria-busy', 'false');
}

async function openRowMenu(page, name) {
  await row(page, name).getByRole('button', { name: `Actions for ${name}` }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

/**
 * Rows from a read-only query against the workspace DB. The server (or a run it spawned) may be
 * mid-write, so a "database is locked" read is retried briefly.
 */
async function dbRows(server, sql, ...params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return server.query(sql, ...params);
    } catch (err) {
      if (!/locked|busy/i.test(String(err && err.message)) || attempt >= 100) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** Send a JSON body to a token-guarded API path and return its JSON (asserting a 200). */
async function sendJSON(request, server, method, path, data) {
  const res = await request.fetch(server.apiUrl(path), { method, data });
  expect(res.status(), `${method} ${path}: ${await res.text()}`).toBe(200);
  return res.json();
}

/** Every request the page makes to a path matching `re` (method + parsed body). */
function recordRequests(page, re) {
  const seen = [];
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (!re.test(path)) return;
    let body = null;
    try {
      body = req.postData() ? JSON.parse(req.postData()) : null;
    } catch {
      body = req.postData();
    }
    seen.push({ method: req.method(), path, body });
  });
  return seen;
}

/** Serve GET /api/schedules with `edit(list)` applied to what the server answered. */
async function patchSchedules(page, edit) {
  await page.route('**/api/schedules', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const list = await res.json();
    edit(list);
    return route.fulfill({ response: res, json: list });
  });
}

/** Serve GET /api/summary merged with `patch()` (what is running, what finished last). */
async function patchSummary(page, patch) {
  await page.route('**/api/summary*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), ...patch() } });
  });
}

/** Have the shared store poll the summary now (as its 30s timer would). */
const refreshStore = (page) =>
  page.evaluate(async () => {
    const { store } = await import('/assets/js/core/store.js');
    await store.refresh();
  });

/** Where an OS timer for schedule `id` would land under `home` if one were installed. */
function timerFiles(home, id) {
  if (process.platform === 'darwin') return [join(home, 'Library/LaunchAgents', `ai.coldtrail.run.${id}.plist`)];
  if (process.platform === 'linux') {
    const dir = join(home, '.config/systemd/user');
    return [join(dir, `coldtrail-${id}.timer`), join(dir, `coldtrail-${id}.service`)];
  }
  return [];
}

/** Press Tab until `target` has focus (at most `max` presses). */
async function tabTo(page, target, max = 30) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/**
 * The run history fits its box at this width (a table when there is room, else one card per
 * run): it never scrolls sideways, and the first run's status and counts and every View run link
 * are inside the box and on screen.
 */
async function historyFits(page) {
  const width = page.viewportSize().width;
  const wrap = page.locator('.sch-history .table-wrap');
  const [scroll, client] = await wrap.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(scroll, `run history scrolls sideways at ${width}px`).toBeLessThanOrEqual(client + 1);
  const box = await wrap.boundingBox();
  const right = Math.min(width, box.x + box.width);
  const first = page.getByRole('table', { name: 'Run history' }).locator('tbody tr').first();
  const views = await page.locator('.sch-history').getByRole('link', { name: /^View run/ }).all();
  for (const el of [first.locator('.badge'), first.locator('td').nth(7), ...views]) {
    const b = await el.boundingBox();
    expect(b.x + b.width, `${await el.textContent()} at ${width}px`).toBeLessThanOrEqual(right + 0.5);
  }
}

/** Whether a note is cut short on screen (its clamp hides lines). */
const clamped = (note) => note.evaluate((el) => el.scrollHeight > el.clientHeight + 1);

test('lists seeded schedules with next run', async ({ app, page, server, request }) => {
  await app.goto('#/schedules');
  await ready(page);
  await expect(page).toHaveTitle('Schedules · coldtrail');
  await expect(page.locator('.page-desc')).toContainText('Auto-send is off, so runs only write drafts.');

  const list = page.getByRole('list', { name: 'Schedules' });
  await expect(list.locator('.sch-row .sch-name')).toHaveText([LUNCH.name, WEEKLY.name]);

  // Lunch Source: daily, the agent decides, on, next run soon, last run failed.
  const lunch = row(page, LUNCH.name);
  // A name too long for the row is cut short on screen; the tooltip has all of it.
  await expect(lunch.locator('.sch-name')).toHaveAttribute('title', LUNCH.name);
  await expect(lunch.locator('.sch-cadence')).toHaveText('Daily at 13:00');
  await expect(lunch.locator('.sch-task .badge')).toHaveText('Agent decides');
  await expect(lunch.getByRole('switch', { name: LUNCH.name })).toHaveAttribute('aria-checked', 'true');
  const next = nextRuns(LUNCH)[0];
  const nextAt = lunch.locator('.sch-next time');
  await expect(nextAt).toHaveAttribute('title', runLabel(next));
  await expect(async () => expect(await nextAt.textContent()).toBe(nextText(next))).toPass({ timeout: 40_000 });
  // The same time the server reports for the shell's schedule chip.
  const summary = await (await request.get(server.apiUrl('/api/summary'))).json();
  expect(summary.next_schedule.name).toBe(LUNCH.name);
  expect(fmtDate(summary.next_schedule.next_at, { time: true })).toBe(fmtDate(next, { time: true }));

  const lunchRuns = SEED.runs.filter((r) => r.schedule_name === LUNCH.name);
  const lastLunch = lunchRuns[lunchRuns.length - 1];
  const last = lunch.locator('.sch-last');
  await expect(last.locator('.badge')).toHaveText(STATUS[lastLunch.status]);
  await expect(last.locator('.badge')).toHaveClass(/badge-danger/);
  // It failed before doing anything: the row says why (the server's note), not a line of zeros.
  const listed = await (await request.get(server.apiUrl('/api/schedules'))).json();
  const why = listed.find((s) => s.id === LUNCH.id).last_run.note;
  expect(why).toBeTruthy();
  await expect(last.locator('.sch-note')).toHaveText(why);
  await expect(last.locator('.sch-note')).toHaveAttribute('title', why);
  await expect(last.locator('.sch-counts')).toHaveCount(0);
  // Not a sign-in problem, so no sign-in link.
  await expect(last.getByRole('link', { name: 'Sign the agent in again' })).toHaveCount(0);
  // A run with no conversation has nothing to view.
  await expect(last.getByRole('link', { name: /^View run/ })).toHaveCount(0);

  // Weekly custom: weekly, a custom instruction, paused (so no next run), last run a dry run.
  const weekly = row(page, WEEKLY.name);
  await expect(weekly.locator('.sch-cadence')).toHaveText('Weekly · Mon 09:00');
  await expect(weekly.locator('.sch-task .badge')).toHaveText('Custom');
  await expect(weekly.locator('.sch-prompt')).toHaveText(WEEKLY.prompt);
  await expect(weekly.getByRole('switch', { name: WEEKLY.name })).toHaveAttribute('aria-checked', 'false');
  await expect(weekly.locator('.sch-next')).toContainText('Paused');
  await expect(weekly.locator('.sch-next time')).toHaveCount(0);
  const lastWeekly = SEED.runs.filter((r) => r.schedule_name === WEEKLY.name).pop();
  await expect(weekly.locator('.sch-last .badge')).toHaveText(STATUS[lastWeekly.status]);
  await expect(weekly.locator('.sch-last')).toContainText(counts(lastWeekly));
  await expect(weekly.locator('.sch-last .sch-note')).toHaveCount(0);
});

test('run history lists the latest runs, newest first', async ({ app, page, server, request }) => {
  await app.goto('#/schedules');
  await ready(page);
  const history = page.getByRole('table', { name: 'Run history' });
  const rows = history.locator('tbody tr');
  const newest = [...SEED.runs].reverse();
  await expect(rows).toHaveCount(newest.length);
  await expect(history.locator('thead th')).toHaveText([
    'Finished', 'Schedule', 'Trigger', 'Status', 'Sourced', 'Enriched', 'Drafted', 'Sent', 'Conversation',
  ]);
  await expect(rows.locator('td:nth-child(2)')).toHaveText(newest.map((r) => r.schedule_name ?? 'No schedule'));
  await expect(rows.locator('td:nth-child(3)')).toHaveText(newest.map((r) => TRIGGER[r.trigger]));
  await expect(rows.locator('td:nth-child(4) .badge')).toHaveText(newest.map((r) => STATUS[r.status]));
  for (const [i, key] of ['sourced', 'enriched', 'drafted', 'sent'].entries()) {
    await expect(rows.locator(`td:nth-child(${5 + i})`)).toHaveText(newest.map((r) => fmtNum(r[key])));
  }
  // A failed run says why under its status (the newest seeded run failed with a note).
  const api = await (await request.get(server.apiUrl('/api/runs'))).json();
  const notes = api.filter((r) => r.note).map((r) => r.note);
  expect(notes.length).toBeGreaterThan(0);
  await expect(rows.locator('td:nth-child(4) .sch-note')).toHaveText(notes);
  await expect(rows.first().locator('.sch-note')).toHaveText(api[0].note);

  // Finished: relative within 48h, the absolute time on hover.
  const first = rows.first().locator('td').first().locator('time');
  await expect(first).toHaveAttribute('title', fmtDate(api[0].started_at, { time: true }));
  await expect(first).toHaveText(fmtRelative(api[0].started_at));

  // View run only where the run has a conversation; it opens that conversation.
  const links = history.getByRole('link', { name: /^View run/ });
  await expect(links).toHaveCount(newest.filter((r) => r.chat_id).length);
  await expect(links.first()).toHaveAttribute('href', `#/agent/${SEED.chats.scheduled.id}`);
  await links.first().click();
  await expect(page).toHaveURL(hashIs(`#/agent/${SEED.chats.scheduled.id}`));
  await expect(page.locator('#view h1')).toHaveText('Agent');
});

test('a failed run says why; only a sign-in failure links to the agent settings', async ({ app, page }) => {
  // 'error' covers every failure but sign-in (a retired model, a server error, a timeout).
  const RETIRED = 'Model muse-spark-1.3-contributor-free has been deprecated.';
  const SIGNED_OUT = 'opencode is not signed in. Run `opencode auth login`, then try again.';
  await patchSchedules(page, (list) => {
    for (const s of list) {
      if (s.id === LUNCH.id) s.last_run = { ...s.last_run, status: 'error', note: RETIRED };
      if (s.id === WEEKLY.id) s.last_run = { ...s.last_run, status: 'auth_failed', note: SIGNED_OUT };
    }
  });
  await page.route('**/api/runs', async (route) => {
    const res = await route.fetch();
    const list = await res.json();
    list[0] = { ...list[0], status: 'auth_failed', note: SIGNED_OUT };
    list[1] = { ...list[1], status: 'error', note: `  ${RETIRED}\n  ` };
    await route.fulfill({ response: res, json: list });
  });
  await app.goto('#/schedules');
  await ready(page);

  const lunch = row(page, LUNCH.name).locator('.sch-last');
  await expect(lunch.locator('.badge')).toHaveText('Failed');
  await expect(lunch.locator('.badge')).toHaveClass(/badge-danger/);
  await expect(lunch.locator('.sch-note')).toHaveText(RETIRED);
  await expect(lunch.getByRole('link', { name: 'Sign the agent in again' })).toHaveCount(0);

  const weekly = row(page, WEEKLY.name).locator('.sch-last');
  await expect(weekly.locator('.badge')).toHaveText('Sign-in failed');
  await expect(weekly.locator('.badge')).toHaveClass(/badge-warn/);
  await expect(weekly.locator('.sch-note')).toHaveText(SIGNED_OUT);
  // It got some work done first, so its counts still show.
  await expect(weekly.locator('.sch-counts')).toBeVisible();
  const signIn = weekly.getByRole('link', { name: 'Sign the agent in again' });
  await expect(signIn).toHaveAttribute('href', '#/settings?tab=agent');
  await expect(page.locator('#view').getByRole('link', { name: 'Sign the agent in again' })).toHaveCount(1);

  // The history says why too (the note trimmed), and keeps the plain status for the rest.
  const rows = page.getByRole('table', { name: 'Run history' }).locator('tbody tr');
  await expect(rows.nth(0).locator('.badge')).toHaveText('Sign-in failed');
  await expect(rows.nth(0).locator('.sch-note')).toHaveText(SIGNED_OUT);
  await expect(rows.nth(1).locator('.badge')).toHaveText('Failed');
  await expect(rows.nth(1).locator('.sch-note')).toHaveText(RETIRED);
  await expect(rows.nth(1).locator('.sch-note')).toHaveAttribute('title', RETIRED);
  await expect(rows.nth(2).locator('.sch-note')).toHaveCount(0);
});

test('run history fits laptop widths: a table when there is room, else cards that show the whole note', async ({ app, page }) => {
  // The widest a run gets: a failed run with a long note, a long name and big counts, and the
  // same from last year (its date gains the year).
  const NAME = 'Morning source + draft (EU fintech)';
  const NOTE = 'opencode run failed: provider returned HTTP 503 Service Unavailable while streaming the first turn; retried 3 times.';
  const LONG = `${NOTE} The provider said: upstream connect error or disconnect/reset before headers, reset reason: overflow. Try again later.`;
  const LAST_YEAR = `${new Date().getFullYear() - 1}-12-30 12:42:00`; // SQLite UTC
  const wide = { status: 'error', note: NOTE, schedule_name: NAME, trigger: 'scheduled', sourced: 1234, enriched: 345, drafted: 120, sent: 25, chat_id: SEED.chats.scheduled.id };
  await page.route('**/api/runs', async (route) => {
    const res = await route.fetch();
    const list = await res.json();
    list.unshift({ ...list[0], ...wide }, { ...list[0], ...wide, started_at: LAST_YEAR });
    await route.fulfill({ response: res, json: list });
  });
  await patchSchedules(page, (list) => {
    for (const s of list) if (s.id === LUNCH.id) s.last_run = { ...s.last_run, status: 'error', note: LONG };
  });
  await app.goto('#/schedules');
  await ready(page);
  const rows = page.getByRole('table', { name: 'Run history' }).locator('tbody tr');
  await expect(rows.nth(0).locator('.sch-run-name')).toHaveText(NAME);
  await expect(rows.nth(1).locator('time')).toHaveText(fmtDate(LAST_YEAR, { time: true }));
  await expect(rows.nth(1).locator('time')).toContainText(`, ${new Date().getFullYear() - 1}, `);
  const cards = () => rows.first().evaluate((el) => getComputedStyle(el).display === 'flex');
  const rowNote = row(page, LUNCH.name).locator('.sch-note');
  // A schedule's last-run counts ("10 sourced · 4 enriched · 4 drafted · 0 sent") keep to one
  // line wherever the rows are laid out in columns (1024px and up).
  const weeklyCounts = row(page, WEEKLY.name).locator('.sch-counts');
  const oneLine = () => weeklyCounts.evaluate((el) => el.getBoundingClientRect().height < 1.5 * parseFloat(getComputedStyle(el).lineHeight));

  // 1440 and 1400 (about the narrowest box a table gets) have room for the table; laptop widths
  // from 1366 down get cards. The table's note is cut to two lines (the tooltip has it); a
  // card's note shows in full.
  for (const [width, table] of [[1440, true], [1400, true], [1366, false], [1280, false], [1240, false], [1200, false], [1024, false], [390, false]]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(cards, { message: `cards at ${width}px` }).toBe(!table);
    await historyFits(page);
    await expect(rows.nth(0).locator('td').nth(8).getByRole('link', { name: /^View run/ })).toBeVisible();
    expect(await clamped(rows.nth(0).locator('.sch-note')), `note cut short at ${width}px`).toBe(table);
    await expect(rows.nth(0).locator('.sch-note')).toHaveAttribute('title', NOTE);
    if (width >= 1024) expect(await oneLine(), `schedule counts wrap at ${width}px`).toBe(true);
  }
  // The schedule's own row: three lines beside its columns, all of it once the row stacks.
  expect(await clamped(rowNote)).toBe(false);
  await expect(rowNote).toHaveText(LONG);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => clamped(rowNote)).toBe(true);
  await expect(rowNote).toHaveAttribute('title', LONG);
});

test('shows loading, then an error with a retry, for each source', async ({ app, page }) => {
  app.allowConsole(/status of 500/);
  let failSchedules = true;
  let releaseRuns;
  const runsGate = new Promise((resolve) => {
    releaseRuns = resolve;
  });
  await page.route('**/api/schedules', (route) =>
    failSchedules && route.request().method() === 'GET'
      ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'database is locked' })
      : route.continue(),
  );
  await page.route('**/api/runs', async (route) => {
    await runsGate;
    await route.continue();
  });
  await app.goto('#/schedules');

  // Run history is still loading: a busy placeholder, not an empty state.
  const history = page.locator('.sch-history');
  await expect(history).toHaveAttribute('aria-busy', 'true');
  await expect(history.locator('.skeleton').first()).toBeVisible();
  await expect(history.getByText('No runs yet')).toHaveCount(0);

  // Schedules failed: say so (with the reason) and offer a retry, never an empty list.
  const list = page.locator('.sch-list');
  await expect(list.getByRole('alert')).toContainText("Schedules didn't load. database is locked");
  await expect(list.getByText('No schedules yet')).toHaveCount(0);

  releaseRuns();
  await expect(history).toHaveAttribute('aria-busy', 'false');
  await expect(history.locator('tbody tr')).toHaveCount(SEED.runs.length);

  failSchedules = false;
  await list.getByRole('button', { name: 'Try again' }).click();
  await expect(list.locator('.sch-row')).toHaveCount(2);
  await expect(list.getByRole('alert')).toHaveCount(0);

  // Sending settings that can't be read never claim "nothing is sent".
  await page.route('**/api/status', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }));
  await page.reload();
  await ready(page);
  await expect(page.locator('.page-desc')).not.toContainText('Auto-send');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await expect(dialog.locator('.sch-consequence')).toContainText("Couldn't read your sending settings");
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // ...and Run now asks first, since it can't tell what this run may send.
  const runs = recordRequests(page, /\/run$/);
  await openRowMenu(page, LUNCH.name);
  await page.getByRole('menuitem', { name: 'Run now' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Run “${LUNCH.name}” now?` });
  await expect(confirm).toContainText("Couldn't check your auto-send settings");
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect(runs).toEqual([]);
});

test('stale session shows the banner, not an empty list', async ({ app, page }) => {
  app.allowConsole(/401|Unauthorized/i);
  await app.goto('#/schedules');
  await ready(page);
  await page.context().clearCookies();
  await page.reload();
  await expect(page.locator('.session-banner')).toHaveText(SESSION_EXPIRED);
  // The banner says why at length; each failed part says what to do, in short.
  await expect(page.locator('.sch-list').getByRole('alert')).toContainText("Schedules didn't load. Reopen coldtrail from your terminal.");
  await expect(page.locator('.sch-history').getByRole('alert')).toContainText("Run history didn't load. Reopen coldtrail from your terminal.");
  await expect(page.locator('#view').getByText(SESSION_EXPIRED)).toHaveCount(0);
  await expect(page.getByText('No schedules yet')).toHaveCount(0);
});

test('a switch pressed on a stale session goes back and says to reopen coldtrail', async ({ app, page, server }) => {
  app.allowConsole(/401|Unauthorized/i);
  await app.goto('#/schedules');
  await ready(page);
  await page.route(`**/api/schedules/${LUNCH.id}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 401, contentType: 'text/plain', body: 'unauthorized' })
      : route.continue(),
  );
  const reads = recordRequests(page, /^\/api\/schedules$/);
  const sw = row(page, LUNCH.name).getByRole('switch', { name: LUNCH.name });
  await sw.click();
  await expect(page.locator('.session-banner')).toHaveText(SESSION_EXPIRED);
  await expect(page.locator('.toast-err .toast-text')).toHaveText(`Couldn't pause “${LUNCH.name}”: Reopen coldtrail from your terminal.`);
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  // Nothing was stored, and a stale session can't read the list either: no reload is tried.
  expect(reads).toEqual([]);
  expect((await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', LUNCH.id))[0].enabled).toBe(1);
});

// Leaves Lunch Source enabled, as seeded.
test('toggle disables and survives reload', async ({ app, page, server }) => {
  const enabled = async () => (await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', LUNCH.id))[0].enabled;
  const patches = recordRequests(page, /^\/api\/schedules\/[^/]+$/);
  await app.goto('#/schedules');
  await ready(page);
  const lunch = row(page, LUNCH.name);
  const sw = lunch.getByRole('switch', { name: LUNCH.name });
  const chip = page.locator('#topbar .chip');
  await expect(chip).toContainText(`${LUNCH.name} · next`);

  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(toastWith(page, `“${LUNCH.name}” is paused.`)).toBeVisible();
  await expect(lunch.locator('.sch-next')).toContainText('Paused');
  await expect.poll(enabled).toBe(0);
  expect(patches.filter((p) => p.method === 'PATCH').map((p) => p.body)).toEqual([{ enabled: false }]);
  // Nothing enabled any more: the shell's chip says so without a reload.
  await expect(chip).toHaveText('No schedule');
  // The last run line is untouched by the PATCH response's last_run: null.
  await expect(lunch.locator('.sch-last .badge')).toHaveText('Failed');

  await page.reload();
  await ready(page);
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(lunch.locator('.sch-next')).toContainText('Paused');

  // Back on, from the keyboard.
  await sw.focus();
  await page.keyboard.press('Space');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect.poll(enabled).toBe(1);
  await expect(toastWith(page, `“${LUNCH.name}” is on. Next run ${runLabel(nextRuns(LUNCH)[0])}.`)).toBeVisible();
  await expect(lunch.locator('.sch-next time')).toHaveAttribute('title', runLabel(nextRuns(LUNCH)[0]));
  await expect(chip).toContainText(`${LUNCH.name} · next`);
});

test('a failed toggle puts the switch back and says why', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  await page.route(`**/api/schedules/${LUNCH.id}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'launchctl bootstrap: Operation not permitted' })
      : route.continue(),
  );
  await app.goto('#/schedules');
  await ready(page);
  const sw = row(page, LUNCH.name).getByRole('switch', { name: LUNCH.name });
  await sw.click();
  await expect(page.locator('.toast-err .toast-text')).toHaveText(
    `Couldn't pause “${LUNCH.name}”: launchctl bootstrap: Operation not permitted`,
  );
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect((await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', LUNCH.id))[0].enabled).toBe(1);
  await expect(row(page, LUNCH.name).locator('.sch-next time')).toBeVisible();
});

// Leaves Lunch Source enabled, as seeded.
test('a reload already on its way never undoes what a failed toggle showed', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  const enabled = async () => (await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', LUNCH.id))[0].enabled;
  // A run finished (the store's summary has a newer last run), so the screen reloads its list:
  // that GET is answered with the list as it was (Lunch Source on), but only once released.
  let hold = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let fetched;
  const staleReady = new Promise((resolve) => {
    fetched = resolve;
  });
  await page.route('**/api/schedules', async (route) => {
    if (route.request().method() !== 'GET' || !hold) return route.continue();
    hold = false;
    const res = await route.fetch();
    const json = await res.json();
    fetched(route.request());
    await gate;
    await route.fulfill({ response: res, json }).catch(() => {}); // the page dropped it: nothing to answer
  });
  // Pausing it stores `enabled`, then removing the timer fails (a 500 after the write).
  await page.route(`**/api/schedules/${LUNCH.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const res = await route.fetch();
    expect(res.status()).toBe(200);
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'launchctl bootout: Input/output error' });
  });
  await app.goto('#/schedules');
  await ready(page);
  const lunch = row(page, LUNCH.name);
  const sw = lunch.getByRole('switch', { name: LUNCH.name });
  await expect(sw).toHaveAttribute('aria-checked', 'true');

  await patchSummary(page, () => ({
    last_run: { started_at: '2099-01-01 00:00:00', status: 'ok', schedule_name: LUNCH.name, chat_id: null, sourced: 1, drafted: 1, sent: 0 },
  }));
  hold = true;
  await refreshStore(page);
  const stale = await staleReady;
  const outcome = new Promise((resolve) => {
    page.on('requestfailed', (r) => r === stale && resolve('dropped'));
    page.on('requestfinished', (r) => r === stale && resolve('answered'));
  });

  await sw.click();
  await expect(page.locator('.toast-err .toast-text')).toHaveText(
    `“${LUNCH.name}” is paused, but its timer couldn't be removed, so it may still run: launchctl bootout: Input/output error`,
  );
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  // The older reload is dropped once the fresh list is shown, so its answer (Lunch Source on)
  // never lands.
  release();
  expect(await outcome).toBe('dropped');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(lunch.locator('.sch-next')).toContainText('Paused');
  expect(await enabled()).toBe(0);

  await page.unroute(`**/api/schedules/${LUNCH.id}`);
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect.poll(enabled).toBe(1);
});

// Leaves Lunch Source enabled, as seeded.
test('a toggle whose timer step fails shows what was stored', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  const enabled = async () => (await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', LUNCH.id))[0].enabled;
  // The server stores `enabled`, then removing the timer fails (a 500 after the write).
  await page.route(`**/api/schedules/${LUNCH.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const res = await route.fetch();
    expect(res.status()).toBe(200);
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'launchctl bootout: Input/output error' });
  });
  await app.goto('#/schedules');
  await ready(page);
  const lunch = row(page, LUNCH.name);
  const sw = lunch.getByRole('switch', { name: LUNCH.name });
  await sw.click();
  await expect(page.locator('.toast-err .toast-text')).toHaveText(
    `“${LUNCH.name}” is paused, but its timer couldn't be removed, so it may still run: launchctl bootout: Input/output error`,
  );
  // The switch shows what is stored (off), not the state before the press.
  expect(await enabled()).toBe(0);
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(lunch.locator('.sch-next')).toContainText('Paused');
  await expect(sw).toBeFocused();
  await expect(page.locator('#topbar .chip')).toHaveText('No schedule');

  await page.unroute(`**/api/schedules/${LUNCH.id}`);
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect.poll(enabled).toBe(1);
});

// Leaves Lunch Source at 07:45.
test('edit changes time', async ({ app, page, server }) => {
  await app.goto('#/schedules');
  await ready(page);
  const menuBtn = row(page, LUNCH.name).getByRole('button', { name: `Actions for ${LUNCH.name}` });
  await openRowMenu(page, LUNCH.name);
  await expect(page.getByRole('menuitem')).toHaveText(['Run now', 'Dry run', 'Edit', 'Delete']);
  await page.getByRole('menuitem', { name: 'Edit' }).click();

  const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(LUNCH.name);
  await expect(dialog.getByRole('radio', { name: 'Daily' })).toBeChecked();
  await expect(dialog.getByLabel('Time', { exact: true })).toHaveValue('13:00');
  await expect(dialog.getByRole('radio', { name: 'Agent decides' })).toBeChecked();
  await expect(dialog.getByLabel('Day', { exact: true })).toBeHidden();
  await expect(dialog.getByLabel('Instruction', { exact: true })).toBeHidden();

  // The preview follows the time as it's typed.
  await dialog.getByLabel('Time', { exact: true }).fill('07:45');
  const edited = { ...LUNCH, time: '07:45' };
  const preview = dialog.getByRole('list', { name: 'Next 3 runs' }).locator('.sch-run-at');
  await expect(preview).toHaveText(nextRuns(edited).map(runLabel));

  const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/schedules/${LUNCH.id}`));
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  // Editing never sends `enabled`: the schedule keeps its on/off state.
  expect(JSON.parse((await patch).postData())).toEqual({
    name: LUNCH.name, freq: 'daily', time: '07:45', weekday: null, task_mode: 'agent', prompt: null,
  });
  await expect(dialog).toBeHidden();
  await expect(menuBtn).toBeFocused();
  await expect(toastWith(page, `“${LUNCH.name}” saved. Next run ${runLabel(nextRuns(edited)[0])}.`)).toBeVisible();
  const lunch = row(page, LUNCH.name);
  await expect(lunch.locator('.sch-cadence')).toHaveText('Daily at 07:45');
  await expect(lunch.locator('.sch-next time')).toHaveAttribute('title', runLabel(nextRuns(edited)[0]));
  await expect(lunch.locator('.sch-last .badge')).toHaveText('Failed');
  expect(await dbRows(server, 'SELECT time, enabled FROM schedules WHERE id = ?', LUNCH.id)).toEqual([{ time: '07:45', enabled: 1 }]);
  await page.reload();
  await ready(page);
  await expect(row(page, LUNCH.name).locator('.sch-cadence')).toHaveText('Daily at 07:45');
});

// Leaves Lunch Source at 07:45.
test('an edit whose timer step fails says it was saved and shows it', async ({ app, page, server, request }) => {
  app.allowConsole(/status of 500/);
  // The server stores the edit, then installing the timer fails (a 500 after the write).
  await page.route(`**/api/schedules/${LUNCH.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const res = await route.fetch();
    expect(res.status()).toBe(200);
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'launchctl bootstrap: Input/output error' });
  });
  try {
    await app.goto('#/schedules');
    await ready(page);
    await openRowMenu(page, LUNCH.name);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
    await dialog.getByLabel('Time', { exact: true }).fill('08:15');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toHaveText("Saved, but its timer wasn't updated: launchctl bootstrap: Input/output error");
    // The dialog stays open to try again; the row behind already shows what was stored.
    await expect(dialog).toBeVisible();
    await expect(row(page, LUNCH.name).locator('.sch-cadence')).toHaveText('Daily at 08:15');
    expect(await dbRows(server, 'SELECT time FROM schedules WHERE id = ?', LUNCH.id)).toEqual([{ time: '08:15' }]);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, LUNCH.name).locator('.sch-cadence')).toHaveText('Daily at 08:15');

    // A save that failed before anything was stored still says "Couldn't save".
    await page.unroute(`**/api/schedules/${LUNCH.id}`);
    await page.route(`**/api/schedules/${LUNCH.id}`, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'database is locked' })
        : route.continue(),
    );
    await openRowMenu(page, LUNCH.name);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await dialog.getByLabel('Time', { exact: true }).fill('11:11');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toHaveText("Couldn't save: database is locked");
    await expect(row(page, LUNCH.name).locator('.sch-cadence')).toHaveText('Daily at 08:15');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // Saving it unchanged: what is stored matches the form whether or not the write happened, so
    // the error is never put down to the timer.
    await openRowMenu(page, LUNCH.name);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(dialog.getByLabel('Time', { exact: true })).toHaveValue('08:15');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toHaveText("Couldn't save: database is locked");
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await sendJSON(request, server, 'PATCH', `/api/schedules/${LUNCH.id}`, { time: '07:45' });
  }
});

// Adds "Friday fintechs".
test('create weekly custom schedule shows next 3 runs and persists', async ({ app, page, server }) => {
  await app.goto('#/schedules');
  await ready(page);
  const newBtn = page.getByRole('button', { name: 'New schedule' });
  await newBtn.click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  const name = dialog.getByLabel('Name', { exact: true });
  await expect(name).toBeFocused();

  // Defaults: daily at 09:00, the agent decides; the day and instruction are hidden.
  await expect(dialog.getByRole('radio', { name: 'Daily' })).toBeChecked();
  await expect(dialog.getByLabel('Time', { exact: true })).toHaveValue('09:00');
  await expect(dialog.getByRole('radio', { name: 'Agent decides' })).toBeChecked();
  await expect(dialog.getByLabel('Day', { exact: true })).toBeHidden();
  await expect(dialog.getByLabel('Instruction', { exact: true })).toBeHidden();
  const preview = dialog.getByRole('list', { name: 'Next 3 runs' }).locator('.sch-run-at');
  await expect(preview).toHaveText(nextRuns({ freq: 'daily', time: '09:00' }).map(runLabel));
  await expect(dialog.locator('.sch-consequence')).toContainText('Drafts only: nothing is sent automatically.');

  await name.fill('Friday fintechs');
  await dialog.getByRole('radio', { name: 'Weekly' }).check();
  const day = dialog.getByLabel('Day', { exact: true });
  await expect(day).toBeVisible();
  // Weekdays run Monday first, as the old form did.
  await expect(day.locator('option')).toHaveText(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  await day.selectOption({ label: 'Friday' });
  await dialog.getByLabel('Time', { exact: true }).fill('16:30');
  await dialog.getByRole('radio', { name: 'Custom instruction' }).check();
  const instruction = dialog.getByLabel('Instruction', { exact: true });
  await expect(instruction).toBeVisible();
  await instruction.fill('Find 10 fintechs in Lisbon and draft intros');
  const spec = { freq: 'weekly', time: '16:30', weekday: 5 };
  await expect(preview).toHaveText(nextRuns(spec).map(runLabel));

  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/schedules'));
  await dialog.getByRole('button', { name: 'Create schedule' }).click();
  expect(JSON.parse((await post).postData())).toEqual({
    name: 'Friday fintechs', freq: 'weekly', time: '16:30', weekday: 5, task_mode: 'custom',
    prompt: 'Find 10 fintechs in Lisbon and draft intros', enabled: true,
  });
  await expect(dialog).toBeHidden();
  await expect(newBtn).toBeFocused();
  await expect(toastWith(page, `“Friday fintechs” created. First run ${runLabel(nextRuns(spec)[0])}.`)).toBeVisible();

  const created = row(page, 'Friday fintechs');
  await expect(page.locator('.sch-row .sch-name')).toHaveText([LUNCH.name, WEEKLY.name, 'Friday fintechs']);
  await expect(created.locator('.sch-cadence')).toHaveText('Weekly · Fri 16:30');
  await expect(created.locator('.sch-task .badge')).toHaveText('Custom');
  await expect(created.getByRole('switch', { name: 'Friday fintechs' })).toHaveAttribute('aria-checked', 'true');
  await expect(created.locator('.sch-next time')).toHaveAttribute('title', runLabel(nextRuns(spec)[0]));
  await expect(created.locator('.sch-last')).toContainText('No runs yet');

  expect(
    await dbRows(server, "SELECT enabled, freq, time, weekday, task_mode, prompt FROM schedules WHERE name = 'Friday fintechs'"),
  ).toEqual([{ enabled: 1, freq: 'weekly', time: '16:30', weekday: 5, task_mode: 'custom', prompt: 'Find 10 fintechs in Lisbon and draft intros' }]);
  await page.reload();
  await ready(page);
  await expect(row(page, 'Friday fintechs').locator('.sch-cadence')).toHaveText('Weekly · Fri 16:30');
});

test('the form says what is missing, inline', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  const posts = recordRequests(page, /^\/api\/schedules$/);
  await app.goto('#/schedules');
  await ready(page);
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  const create = dialog.getByRole('button', { name: 'Create schedule' });
  const name = dialog.getByLabel('Name', { exact: true });

  await create.click();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription('Give it a name.');
  await expect(name).toBeFocused();

  await name.fill('Validation check');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('radio', { name: 'Custom instruction' }).check();
  await create.click();
  const instruction = dialog.getByLabel('Instruction', { exact: true });
  await expect(instruction).toHaveAttribute('aria-invalid', 'true');
  await expect(instruction).toHaveAccessibleDescription('Write what each run should do.');
  await expect(instruction).toBeFocused();
  await instruction.fill('   ');
  await create.click();
  await expect(instruction).toBeFocused();

  await dialog.getByRole('radio', { name: 'Agent decides' }).check();
  await dialog.getByLabel('Time', { exact: true }).fill('');
  await create.click();
  await expect(dialog.getByLabel('Time', { exact: true })).toHaveAccessibleDescription('Enter a time like 09:00 or 16:30.');
  await dialog.getByLabel('Time', { exact: true }).fill('25:00');
  await create.click();
  await expect(dialog.getByLabel('Time', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  // Typed shorthand is read as 24-hour time.
  await dialog.getByLabel('Time', { exact: true }).fill('930');
  await expect(dialog.getByRole('list', { name: 'Next 3 runs' }).locator('.sch-run-at').first()).toHaveText(
    runLabel(nextRuns({ freq: 'daily', time: '09:30' })[0]),
  );
  expect(posts.filter((p) => p.method === 'POST')).toEqual([]);

  // A server error shows in the dialog, which stays open with what was typed.
  await dialog.getByLabel('Time', { exact: true }).fill('10:15');
  await page.route('**/api/schedules', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'time out of range' })
      : route.continue(),
  );
  await create.click();
  await expect(dialog.getByRole('alert')).toHaveText("Couldn't save: time out of range");
  await expect(name).toHaveValue('Validation check');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await dbRows(server, "SELECT id FROM schedules WHERE name = 'Validation check'")).toEqual([]);
});

test('a timer error after saving never creates a duplicate', async ({ app, page, server, request }) => {
  app.allowConsole(/status of 500/);
  // The server writes the row, then the timer install fails (the response is a 500).
  await page.route('**/api/schedules', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const res = await route.fetch();
    expect(res.status()).toBe(200);
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'launchctl bootstrap: Input/output error' });
  });
  const sent = recordRequests(page, /^\/api\/schedules(\/[^/]+)?$/);
  await app.goto('#/schedules');
  await ready(page);
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByLabel('Name', { exact: true }).fill('Half saved');
  await dialog.getByRole('button', { name: 'Create schedule' }).click();
  // The row exists, so the dialog now edits it (its title says so): saving again updates
  // instead of creating.
  const edit = page.getByRole('dialog', { name: 'Edit schedule' });
  await expect(edit.getByRole('alert')).toHaveText(
    "Saved, but its timer wasn't installed: launchctl bootstrap: Input/output error",
  );
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'Half saved')).toBeVisible();
  await expect(edit.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await page.unroute('**/api/schedules');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  const rows = await dbRows(server, "SELECT id FROM schedules WHERE name = 'Half saved'");
  expect(rows).toHaveLength(1);
  expect(sent.filter((s) => s.method !== 'GET').map((s) => [s.method, s.path])).toEqual([
    ['POST', '/api/schedules'],
    ['PATCH', `/api/schedules/${rows[0].id}`],
  ]);
  await sendJSON(request, server, 'DELETE', `/api/schedules/${rows[0].id}`);
});

test('a failed create never takes over an older schedule with the same name', async ({ app, page, server, request }) => {
  app.allowConsole(/status of 500/);
  const fields = { name: 'Twin', freq: 'daily', time: '09:00', weekday: null, task_mode: 'agent', prompt: null };
  const older = await sendJSON(request, server, 'POST', '/api/schedules', { ...fields, enabled: false });
  let listLoads = 0;
  let writeRow = false;
  await page.route('**/api/schedules', async (route) => {
    const method = route.request().method();
    // The screen's own list never loads, so it can't know which schedules were there before.
    if (method === 'GET') {
      listLoads += 1;
      return listLoads === 1
        ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'database is locked' })
        : route.continue();
    }
    if (method !== 'POST') return route.continue();
    if (writeRow) expect((await route.fetch()).status()).toBe(200);
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'launchctl bootstrap: Input/output error' });
  });
  const sent = recordRequests(page, /^\/api\/schedules(\/[^/]+)?$/);
  try {
    await app.goto('#/schedules');
    await expect(page.locator('.sch-list').getByRole('alert')).toContainText("Schedules didn't load.");
    await page.getByRole('button', { name: 'New schedule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await dialog.getByLabel('Name', { exact: true }).fill(fields.name);

    // Nothing was written: the older "Twin" is not mistaken for this one.
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect(dialog.getByRole('alert')).toHaveText("Couldn't save: launchctl bootstrap: Input/output error");
    await expect(dialog.getByRole('button', { name: 'Create schedule' })).toBeVisible();

    // The row was written before the timer failed: the dialog goes on editing that new row.
    writeRow = true;
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit schedule' });
    await expect(edit.getByRole('alert')).toHaveText("Saved, but its timer wasn't installed: launchctl bootstrap: Input/output error");
    const twins = await dbRows(server, "SELECT id FROM schedules WHERE name = 'Twin'");
    expect(twins).toHaveLength(2);
    const newer = twins.find((t) => t.id !== older.id);
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit).toBeHidden();
    expect(sent.filter((r) => r.method === 'PATCH').map((r) => r.path)).toEqual([`/api/schedules/${newer.id}`]);
    // The older one is as it was.
    expect(await dbRows(server, 'SELECT enabled, time FROM schedules WHERE id = ?', older.id)).toEqual([{ enabled: 0, time: '09:00' }]);
  } finally {
    await page.unroute('**/api/schedules');
    for (const { id } of await dbRows(server, "SELECT id FROM schedules WHERE name = 'Twin'")) {
      await sendJSON(request, server, 'DELETE', `/api/schedules/${id}`);
    }
  }
});

test('a changed form is not lost to a stray click beside the dialog', async ({ app, page }) => {
  await app.goto('#/schedules');
  await ready(page);
  const newBtn = page.getByRole('button', { name: 'New schedule' });
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  const beside = () => page.locator('.overlay-dialog').click({ position: { x: 8, y: 8 } });
  const TEXT = 'Source 30 climate startups in Lisbon and draft intros to their founders';
  const typeSomething = async () => {
    await newBtn.click();
    await dialog.getByRole('radio', { name: 'Custom instruction' }).check();
    await dialog.getByLabel('Instruction', { exact: true }).fill(TEXT);
  };

  // Untouched, a click beside it closes it.
  await newBtn.click();
  await expect(dialog).toBeVisible();
  await beside();
  await expect(dialog).toBeHidden();

  // With something typed, it stays open; Cancel, Esc and Close still close it.
  await typeSomething();
  await beside();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Instruction', { exact: true })).toHaveValue(TEXT);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(newBtn).toBeFocused();

  await typeSomething();
  await beside();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(newBtn).toBeFocused();

  await typeSomething();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  // Changed back to how it opened, a click beside it closes it again.
  await newBtn.click();
  await dialog.getByLabel('Name', { exact: true }).fill('x');
  await dialog.getByLabel('Name', { exact: true }).fill('');
  await beside();
  await expect(dialog).toBeHidden();
});

test('closing the dialog while it saves still says how the save went', async ({ app, page, server, request }) => {
  app.allowConsole(/status of 500/);
  // Hold each create until released (a timer install can be slow); the second one fails.
  const gates = [];
  let creates = 0;
  await page.route('**/api/schedules', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const n = creates++;
    await new Promise((resolve) => gates.push(resolve));
    if (n === 0) return route.continue();
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'database is locked' });
  });
  const newBtn = page.getByRole('button', { name: 'New schedule' });
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  const createAndLeave = async (name, leave) => {
    const held = gates.length + 1;
    await newBtn.click();
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect.poll(() => gates.length).toBe(held);
    await expect(dialog.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
    await leave();
    await expect(dialog).toBeHidden();
    gates.at(-1)();
  };
  try {
    await app.goto('#/schedules');
    await ready(page);

    // Esc while it saves: once stored, the row shows up and a toast says it was created.
    await createAndLeave('Closed early', () => page.keyboard.press('Escape'));
    await expect(toastWith(page, '“Closed early” created.')).toBeVisible();
    await expect(row(page, 'Closed early')).toBeVisible();
    expect(await dbRows(server, "SELECT id FROM schedules WHERE name = 'Closed early'")).toHaveLength(1);

    // Close while it saves, and the save fails: a toast says so (the dialog's message is gone).
    await createAndLeave('Never stored', () => dialog.getByRole('button', { name: 'Close' }).click());
    await expect(page.locator('.toast-err .toast-text')).toHaveText("Couldn't save “Never stored”: database is locked");
    await expect(row(page, 'Never stored')).toHaveCount(0);
  } finally {
    for (const resolve of gates) resolve();
    await page.unroute('**/api/schedules');
    for (const { id } of await dbRows(server, "SELECT id FROM schedules WHERE name IN ('Closed early', 'Never stored')")) {
      await sendJSON(request, server, 'DELETE', `/api/schedules/${id}`);
    }
  }
});

test('a list reload that fails after a save keeps the new row and says why', async ({ app, page, server, request }) => {
  app.allowConsole(/status of 500/);
  // Every read of the list after the create fails.
  let created = false;
  await page.route('**/api/schedules', async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      const res = await route.fetch();
      created = true;
      return route.fulfill({ response: res });
    }
    if (method === 'GET' && created) return route.fulfill({ status: 500, contentType: 'text/plain', body: 'database is locked' });
    return route.continue();
  });
  try {
    await app.goto('#/schedules');
    await ready(page);
    await page.getByRole('button', { name: 'New schedule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await dialog.getByLabel('Name', { exact: true }).fill('Reload check');
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect(dialog).toBeHidden();
    await expect(toastWith(page, '“Reload check” created.')).toBeVisible();
    await expect(page.locator('.toast-err .toast-text')).toHaveText("Couldn't reload the schedules: database is locked");
    await expect(row(page, 'Reload check')).toBeVisible();
    await expect(page.locator('.sch-list').getByRole('alert')).toHaveCount(0);
  } finally {
    await page.unroute('**/api/schedules');
    for (const { id } of await dbRows(server, "SELECT id FROM schedules WHERE name = 'Reload check'")) {
      await sendJSON(request, server, 'DELETE', `/api/schedules/${id}`);
    }
  }
});

test('no plist is written', async ({ app, page, server }) => {
  await app.goto('#/schedules');
  await ready(page);
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByLabel('Name', { exact: true }).fill('Timer check');
  await dialog.getByLabel('Time', { exact: true }).fill('06:10');
  await dialog.getByRole('button', { name: 'Create schedule' }).click();
  await expect(dialog).toBeHidden();
  const [{ id }] = await dbRows(server, "SELECT id FROM schedules WHERE name = 'Timer check'");

  // Pausing and resuming runs the server's remove and install paths too.
  const sw = row(page, 'Timer check').getByRole('switch', { name: 'Timer check' });
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', id))[0].enabled).toBe(1);

  // The real LaunchAgents folder is only listed (read-only): no plist for this schedule.
  if (process.platform === 'darwin') {
    const real = join(homedir(), 'Library/LaunchAgents');
    const listing = existsSync(real) ? readdirSync(real) : [];
    expect(listing).not.toContain(`ai.coldtrail.run.${id}.plist`);
  }
  // Nor in the server's sandboxed HOME, where an install would actually land...
  for (const file of timerFiles(server.userHome, id)) expect(existsSync(file), file).toBe(false);
  // ...because the server took the logged no-op path.
  expect(readFileSync(join(server.home, 'coldtrail.log'), 'utf8')).toContain('timers disabled (COLDTRAIL_NO_TIMERS)');

  // Deleting it removes the row (and touches no timer either).
  await openRowMenu(page, 'Timer check');
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete schedule' }).click();
  await expect(row(page, 'Timer check')).toHaveCount(0);
  expect(await dbRows(server, 'SELECT id FROM schedules WHERE id = ?', id)).toEqual([]);
  if (process.platform === 'darwin') {
    const real = join(homedir(), 'Library/LaunchAgents');
    expect(existsSync(real) ? readdirSync(real) : []).not.toContain(`ai.coldtrail.run.${id}.plist`);
  }
});

// Removes "Weekly custom".
test('delete asks and removes', async ({ app, page, server }) => {
  const deletes = recordRequests(page, /^\/api\/schedules\/[^/]+$/);
  await app.goto('#/schedules');
  await ready(page);
  const menuBtn = row(page, WEEKLY.name).getByRole('button', { name: `Actions for ${WEEKLY.name}` });

  await openRowMenu(page, WEEKLY.name);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete “${WEEKLY.name}”?` });
  await expect(confirm).toContainText('Its timer is removed and it stops running. Past runs stay in the run history.');
  // A destructive confirm starts on Cancel.
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(menuBtn).toBeFocused();
  await expect(row(page, WEEKLY.name)).toHaveCount(1);
  expect(deletes.filter((d) => d.method === 'DELETE')).toEqual([]);

  await openRowMenu(page, WEEKLY.name);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await confirm.getByRole('button', { name: 'Delete schedule' }).click();
  await expect(row(page, WEEKLY.name)).toHaveCount(0);
  await expect(toastWith(page, `“${WEEKLY.name}” deleted.`)).toBeVisible();
  expect(deletes.filter((d) => d.method === 'DELETE').map((d) => d.path)).toEqual([`/api/schedules/${WEEKLY.id}`]);
  expect(await dbRows(server, 'SELECT id FROM schedules WHERE id = ?', WEEKLY.id)).toEqual([]);
  // Focus lands somewhere useful, not on <body>.
  await expect(page.getByRole('button', { name: 'New schedule' })).toBeFocused();
  // Its past run stays in the history, no longer tied to a schedule.
  const dry = page.getByRole('table', { name: 'Run history' }).locator('tbody tr').filter({ hasText: 'Dry run' });
  await expect(dry.locator('td:nth-child(2)')).toHaveText('No schedule');
});

test('a failed delete keeps the row and says which schedule and why', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  await page.route(`**/api/schedules/${LUNCH.id}`, (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'database is locked' })
      : route.continue(),
  );
  await app.goto('#/schedules');
  await ready(page);
  const menuBtn = row(page, LUNCH.name).getByRole('button', { name: `Actions for ${LUNCH.name}` });
  await openRowMenu(page, LUNCH.name);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete schedule' }).click();
  await expect(page.locator('.toast-err .toast-text')).toHaveText(`Couldn't delete “${LUNCH.name}”: database is locked`);
  await expect(row(page, LUNCH.name)).toHaveCount(1);
  await expect(menuBtn).toBeFocused();
  expect(await dbRows(server, 'SELECT id FROM schedules WHERE id = ?', LUNCH.id)).toHaveLength(1);
});

test('a run that fails to start frees its row and says why, even after the list was rebuilt', async ({ app, page }) => {
  app.allowConsole(/status of 500/);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/schedules/${LUNCH.id}/run`, async (route) => {
    await gate;
    await route.fulfill({ status: 500, contentType: 'text/plain', body: 'could not start the agent' });
  });
  let patch = {};
  await patchSummary(page, () => patch);
  await app.goto('#/schedules');
  await ready(page);
  const menuBtn = row(page, LUNCH.name).getByRole('button', { name: `Actions for ${LUNCH.name}` });
  const drawn = await menuBtn.elementHandle();
  await openRowMenu(page, LUNCH.name);
  await page.getByRole('menuitem', { name: 'Dry run' }).click();
  await expect(menuBtn).toHaveAttribute('aria-busy', 'true');

  // A run finishes while this one starts: every row is rebuilt, and this row's new ⋯ button is
  // busy too (a press on it would do nothing).
  patch = { last_run: { started_at: '2099-01-04 00:00:00', status: 'ok', schedule_name: LUNCH.name, chat_id: null, sourced: 1, drafted: 1, sent: 0 } };
  await refreshStore(page);
  await expect.poll(() => drawn.evaluate((el) => el.isConnected)).toBe(false);
  await expect(menuBtn).toHaveAttribute('aria-busy', 'true');
  await expect(menuBtn.locator('.spinner')).toBeVisible();

  release();
  await expect(toastWith(page, `Couldn't start a dry run of “${LUNCH.name}”: could not start the agent`)).toBeVisible();
  await expect(menuBtn).not.toHaveAttribute('aria-busy', 'true');
  await expect(menuBtn.locator('.spinner')).toHaveCount(0);
  await expect(page).toHaveURL(hashIs('#/schedules'));

  // Run now (auto-send is off, so it doesn't ask) says the same.
  await openRowMenu(page, LUNCH.name);
  await page.getByRole('menuitem', { name: 'Run now' }).click();
  await expect(toastWith(page, `Couldn't start “${LUNCH.name}”: could not start the agent`)).toBeVisible();
  await expect(menuBtn).not.toHaveAttribute('aria-busy', 'true');
});

// Turns email and LinkedIn auto-send on, then off again.
test('consequence note reflects auto-send settings', async ({ app, page, server, request }) => {
  const runs = recordRequests(page, /\/run$/);
  const setEmail = (enabled) => sendJSON(request, server, 'POST', '/api/destination/auto-send', { enabled, daily_cap: 25 });
  const setLinkedin = (enabled) =>
    sendJSON(request, server, 'POST', '/api/destination/linkedin/auto-send', { enabled, daily_cap: 12, weekly_cap: 60 });
  const note = async () => {
    await page.getByRole('button', { name: 'New schedule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  try {
    await app.goto('#/schedules');
    await ready(page);
    let dialog = await note();
    await expect(dialog.locator('.sch-consequence')).toHaveText(/^Drafts only: nothing is sent automatically\./);
    await expect(dialog.locator('.sch-caveat')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await setEmail(true);
    await page.reload();
    await ready(page);
    await expect(page.locator('.page-desc')).toContainText('Auto-send is on: runs can send up to 25 emails a day. Dry runs never send.');
    dialog = await note();
    await expect(dialog.locator('.sch-consequence')).toContainText(
      'Auto-send is on: this schedule can send up to 25 emails a day without asking. LinkedIn notes stay as drafts.',
    );
    await expect(dialog.locator('.sch-consequence').getByRole('link', { name: 'Change in Settings' })).toHaveAttribute(
      'href', '#/settings?tab=sending',
    );
    await page.keyboard.press('Escape');

    await setLinkedin(true);
    await page.reload();
    await ready(page);
    dialog = await note();
    await expect(dialog.locator('.sch-consequence')).toContainText(
      'Auto-send is on: this schedule can send up to 25 emails and 12 LinkedIn invites a day without asking.',
    );
    await expect(dialog.locator('.sch-caveat')).toContainText(
      "LinkedIn invites only go out if this computer is awake and unlocked and LinkedIn is connected when it runs; otherwise they stay in Drafts.",
    );
    await page.keyboard.press('Escape');

    // Run now states what this run may send, and Cancel sends nothing.
    await openRowMenu(page, LUNCH.name);
    await page.getByRole('menuitem', { name: 'Run now' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Run “${LUNCH.name}” now?` });
    await expect(confirm).toContainText('Auto-send is on, so this run can send up to 25 emails and 12 LinkedIn invites without asking.');
    await expect(confirm).toContainText('Use Dry run to only write drafts.');
    await expect(confirm.getByRole('button', { name: 'Run and allow sends' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    expect(runs).toEqual([]);

    // Accepting starts it and opens the run (the server's COLDTRAIL_NO_SEND: nothing goes out).
    await openRowMenu(page, LUNCH.name);
    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/schedules/${LUNCH.id}/run`));
    const response = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/schedules/${LUNCH.id}/run`));
    await page.getByRole('menuitem', { name: 'Run now' }).click();
    await confirm.getByRole('button', { name: 'Run and allow sends' }).click();
    expect(JSON.parse((await post).postData())).toEqual({ draft_only: false });
    const { chat_id: chatId } = await (await response).json();
    await expect(page).toHaveURL(hashIs(`#/agent/${chatId}`));
    await expect
      .poll(() => dbRows(server, 'SELECT trigger FROM scheduled_runs WHERE chat_id = ?', chatId), { timeout: 60_000 })
      .toEqual([{ trigger: 'manual' }]);

    await setEmail(false);
    await app.goto('#/schedules');
    await ready(page);
    dialog = await note();
    await expect(dialog.locator('.sch-consequence')).toContainText(
      'Auto-send is on: this schedule can send up to 12 LinkedIn invites a day without asking. Emails stay as drafts.',
    );
    await expect(dialog.locator('.sch-caveat')).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await setEmail(false);
    await setLinkedin(false);
  }
});

test('dry run opens the run conversation', async ({ app, page, server }) => {
  await app.goto('#/schedules');
  await ready(page);
  await openRowMenu(page, LUNCH.name);
  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/schedules/${LUNCH.id}/run`));
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/schedules/${LUNCH.id}/run`));
  await page.getByRole('menuitem', { name: 'Dry run' }).click();
  // No confirm: a dry run can't send.
  expect(JSON.parse((await post).postData())).toEqual({ draft_only: true });
  const { chat_id: chatId } = await (await response).json();
  await expect(page).toHaveURL(hashIs(`#/agent/${chatId}`));
  await expect(page.locator('#view h1')).toHaveText('Agent');
  expect(await dbRows(server, 'SELECT title FROM chat_sessions WHERE id = ?', chatId)).toEqual([
    { title: `Scheduled run — ${LUNCH.name}` },
  ]);

  // The run (the fake agent, never a model) finishes and lands in the history as a dry run.
  await expect
    .poll(() => dbRows(server, 'SELECT trigger FROM scheduled_runs WHERE chat_id = ?', chatId), { timeout: 60_000 })
    .toEqual([{ trigger: 'dry' }]);
  await app.goto('#/schedules');
  await ready(page);
  const first = page.getByRole('table', { name: 'Run history' }).locator('tbody tr').first();
  await expect(first.locator('td:nth-child(2)')).toHaveText(LUNCH.name);
  await expect(first.locator('td:nth-child(3)')).toHaveText('Dry run');
  await expect(first.getByRole('link', { name: /^View run/ })).toHaveAttribute('href', `#/agent/${chatId}`);
  await expect(row(page, LUNCH.name).locator('.sch-last').getByRole('link', { name: /^View run/ })).toHaveAttribute(
    'href', `#/agent/${chatId}`,
  );
});

test('run now with auto-send off starts at once and opens the run', async ({ app, page, server }) => {
  // Hold the start, to see the row while it is starting.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/schedules/${LUNCH.id}/run`, async (route) => {
    await gate;
    await route.continue();
  });
  await app.goto('#/schedules');
  await ready(page);
  await openRowMenu(page, LUNCH.name);
  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/schedules/${LUNCH.id}/run`));
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/schedules/${LUNCH.id}/run`));
  await page.getByRole('menuitem', { name: 'Run now' }).click();
  expect(JSON.parse((await post).postData())).toEqual({ draft_only: false });
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  // While it starts, the row's ⋯ button is busy (a spinner) and ignores presses.
  const menuBtn = row(page, LUNCH.name).getByRole('button', { name: `Actions for ${LUNCH.name}` });
  await expect(menuBtn).toHaveAttribute('aria-busy', 'true');
  await expect(menuBtn.locator('.spinner')).toBeVisible();
  await menuBtn.click({ force: true });
  await expect(page.getByRole('menu')).toHaveCount(0);
  release();
  const { chat_id: chatId } = await (await response).json();
  await expect(page).toHaveURL(hashIs(`#/agent/${chatId}`));
  await expect
    .poll(() => dbRows(server, 'SELECT trigger FROM scheduled_runs WHERE chat_id = ?', chatId), { timeout: 60_000 })
    .toEqual([{ trigger: 'manual' }]);
});

test('a live run shows on its row, and a finished one refreshes the screen', async ({ app, page }) => {
  // The shared store's summary says what is running and what finished last.
  let patch = { running: { chat_id: SEED.chats.scheduled.id, title: `Scheduled run — ${LUNCH.name}` } };
  await page.route('**/api/summary*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), ...patch } });
  });
  await app.goto('#/schedules');
  await ready(page);
  const last = row(page, LUNCH.name).locator('.sch-last');
  await expect(last.locator('.badge')).toHaveText('Running');
  await expect(last.getByRole('link', { name: /^Watch the run/ })).toHaveAttribute('href', `#/agent/${SEED.chats.scheduled.id}`);
  await expect(page.locator('.sch-row .badge', { hasText: 'Running' })).toHaveCount(1);
  // A second run of the same schedule can't be started on top of it.
  await openRowMenu(page, LUNCH.name);
  await expect(page.getByRole('menuitem', { name: 'Run now' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Dry run' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // The run ends: no running chat, a newer last run. The screen reloads its lists by itself.
  const reloaded = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/runs');
  patch = {
    running: null,
    last_run: { started_at: '2099-01-01 00:00:00', status: 'ok', schedule_name: LUNCH.name, chat_id: null, sourced: 1, drafted: 1, sent: 0 },
  };
  await page.evaluate(async () => {
    const { store } = await import('/assets/js/core/store.js');
    await store.refresh();
  });
  await reloaded;
  await expect(last.locator('.badge')).not.toHaveText('Running');
  await expect(last.getByRole('link', { name: /^Watch the run/ })).toHaveCount(0);
  await openRowMenu(page, LUNCH.name);
  await expect(page.getByRole('menuitem', { name: 'Run now' })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: 'Dry run' })).toBeEnabled();
  await page.keyboard.press('Escape');
});

test('closing a dialog after the list was rebuilt puts focus back on the row', async ({ app, page }) => {
  let patch = {};
  await patchSummary(page, () => patch);
  await app.goto('#/schedules');
  await ready(page);
  const menuBtn = row(page, LUNCH.name).getByRole('button', { name: `Actions for ${LUNCH.name}` });
  const drawn = await menuBtn.elementHandle();
  await openRowMenu(page, LUNCH.name);
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
  await expect(dialog).toBeVisible();

  // A run finishes meanwhile: the screen reloads its lists, which rebuilds every row.
  patch = { last_run: { started_at: '2099-01-02 00:00:00', status: 'ok', schedule_name: LUNCH.name, chat_id: null, sourced: 2, drafted: 1, sent: 0 } };
  await refreshStore(page);
  await expect.poll(() => drawn.evaluate((el) => el.isConnected)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(menuBtn).toBeFocused();

  // The same for a confirm (Delete, then Cancel).
  const before = await menuBtn.elementHandle();
  await openRowMenu(page, LUNCH.name);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  patch = { last_run: { ...patch.last_run, started_at: '2099-01-03 00:00:00' } };
  await refreshStore(page);
  await expect.poll(() => before.evaluate((el) => el.isConnected)).toBe(false);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(menuBtn).toBeFocused();
});

test('?new=1 opens the dialog after a row menu was used, and never stacks a second one', async ({ app, page }) => {
  await app.goto('#/schedules');
  await ready(page);
  const setHash = (hash) => page.evaluate((h) => { location.hash = h; }, hash);
  const dialogs = page.getByRole('dialog');

  await openRowMenu(page, LUNCH.name);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await setHash('#/schedules?new=1');
  await expect(page).toHaveURL(hashIs('#/schedules'));
  await expect(page.getByRole('dialog', { name: 'New schedule' })).toBeVisible();

  // Already open: the flag is dropped and no second dialog opens.
  await setHash('#/schedules?new=1');
  await expect(page).toHaveURL(hashIs('#/schedules'));
  await expect(dialogs).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialogs).toHaveCount(0);

  // With a row menu open, the menu gives way to the dialog.
  await openRowMenu(page, LUNCH.name);
  await setHash('#/schedules?new=1');
  await expect(page.getByRole('dialog', { name: 'New schedule' })).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialogs).toHaveCount(0);

  // A menu closed by pressing its own button again, then another row's menu: the one open
  // gives way, whichever it is.
  const menuButtons = page.locator('.sch-menu-btn');
  await expect(menuButtons).not.toHaveCount(1);
  await menuButtons.first().click();
  await expect(page.getByRole('menu')).toBeVisible();
  await menuButtons.first().click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await menuButtons.nth(1).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(menuButtons.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await setHash('#/schedules?new=1');
  await expect(page.getByRole('dialog', { name: 'New schedule' })).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(menuButtons.nth(1)).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(dialogs).toHaveCount(0);
});

test('relative times stay current while the screen is open', async ({ app, page }) => {
  await page.clock.install();
  // A weekly schedule three days out (its next run is a date, not "in …"), last run 5½ min ago.
  const now = new Date();
  const far = {
    id: 'e2e-far-weekly', name: 'Far off', enabled: true, freq: 'weekly', time: '10:00',
    weekday: (now.getDay() + 3) % 7, task_mode: 'agent', prompt: null,
    last_run: {
      started_at: new Date(now.getTime() - 5.5 * 60_000).toISOString(), status: 'ok',
      sourced: 3, enriched: 2, drafted: 1, sent: 0, chat_id: null, note: null,
    },
  };
  await patchSchedules(page, (list) => list.push(far));
  await app.goto('#/schedules');
  await ready(page);
  const r = row(page, far.name);
  const label = runLabel(nextRuns(far, 1, now)[0]);
  await expect(r.locator('.sch-next time')).toHaveText(label);
  await expect(r.locator('.sch-last time')).toHaveText('5m ago');

  // The 30s ticker moves the relative times on, and redraws the next run cleanly.
  await page.clock.runFor(60_000);
  await expect(r.locator('.sch-last time')).toHaveText('6m ago');
  await expect(r.locator('.sch-next time')).toHaveText(label);
  await expect(r.locator('.sch-next .sch-cell-body')).toHaveText(label);
});

test('keyboard only: create, open the menu, delete', async ({ app, page, server }) => {
  await app.goto('#/schedules');
  await ready(page);
  const newBtn = page.getByRole('button', { name: 'New schedule' });
  await tabTo(page, newBtn);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  await page.keyboard.type('Keyboard run');
  // Frequency: Tab into the radio group, arrow to Weekly.
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('radio', { name: 'Daily' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: 'Weekly' })).toBeChecked();
  await expect(dialog.getByLabel('Day', { exact: true })).toBeVisible();
  // Task: arrow to Custom instruction, then type it.
  await tabTo(page, dialog.getByRole('radio', { name: 'Agent decides' }));
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('radio', { name: 'Custom instruction' })).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Instruction', { exact: true })).toBeFocused();
  await page.keyboard.type('Source 5 climate startups');
  // Enter in the name field submits the form.
  await dialog.getByLabel('Name', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(newBtn).toBeFocused();
  expect(await dbRows(server, "SELECT freq, weekday, task_mode, prompt FROM schedules WHERE name = 'Keyboard run'")).toEqual([
    { freq: 'weekly', weekday: 1, task_mode: 'custom', prompt: 'Source 5 climate startups' },
  ]);

  // The row menu: Enter opens it on its first item, arrows move, Esc closes back to the button.
  const menuBtn = row(page, 'Keyboard run').getByRole('button', { name: 'Actions for Keyboard run' });
  await tabTo(page, menuBtn, 60);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Run now' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeFocused();
  await page.keyboard.press('Enter');
  const edit = page.getByRole('dialog', { name: 'Edit schedule' });
  await expect(edit.getByLabel('Name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(edit).toBeHidden();
  await expect(menuBtn).toBeFocused();

  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Delete “Keyboard run”?' });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm.getByRole('button', { name: 'Delete schedule' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row(page, 'Keyboard run')).toHaveCount(0);
  expect(await dbRows(server, "SELECT id FROM schedules WHERE name = 'Keyboard run'")).toEqual([]);
});

test('hostile names and instructions render as text', async ({ app, page, server, request }) => {
  const hostile = '<img src=x onerror=window.__xss=1>';
  const prompt = '<script>window.__xss=2</script> <b>find</b> fintechs';
  const created = await sendJSON(request, server, 'POST', '/api/schedules', {
    name: hostile, enabled: false, freq: 'daily', time: '10:00', weekday: null, task_mode: 'custom', prompt,
  });
  try {
    await app.goto('#/schedules');
    await ready(page);
    const r = row(page, hostile);
    await expect(r.locator('.sch-name')).toHaveText(hostile);
    await expect(r.locator('.sch-prompt')).toHaveText(prompt);
    await expect(r.getByRole('switch', { name: hostile })).toBeVisible();
    await expect(page.locator('#view img, #view script, #view b')).toHaveCount(0);

    await openRowMenu(page, hostile);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(hostile);
    await expect(dialog.getByLabel('Instruction', { exact: true })).toHaveValue(prompt);
    await page.keyboard.press('Escape');

    await openRowMenu(page, hostile);
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('alertdialog').locator('.dialog-title')).toHaveText(`Delete “${hostile}”?`);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#overlays img, #overlays script')).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  } finally {
    await sendJSON(request, server, 'DELETE', `/api/schedules/${created.id}`);
  }
});

test('leaving the screen stops its timers and drops late answers', async ({ app, page }) => {
  // Count the intervals the Schedules view starts and hasn't cleared.
  await page.addInitScript(() => {
    const live = new Set();
    const set = window.setInterval;
    const clear = window.clearInterval;
    window.setInterval = function (...args) {
      const id = set.apply(window, args);
      if ((new Error().stack || '').includes('/views/schedules.js')) live.add(id);
      return id;
    };
    window.clearInterval = function (id) {
      live.delete(id);
      return clear.call(window, id);
    };
    window.__scheduleIntervals = () => live.size;
  });
  await app.goto('#/schedules');
  await ready(page);
  expect(await page.evaluate(() => window.__scheduleIntervals())).toBeGreaterThan(0);
  // A dialog left open is closed with the screen.
  await page.getByRole('button', { name: 'New schedule' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.__scheduleIntervals())).toBe(0);
  await expect(page.locator('#app')).not.toHaveAttribute('inert', /.*/);

  // So is a row menu left open.
  await page.evaluate(() => { location.hash = '#/schedules'; });
  await ready(page);
  await openRowMenu(page, LUNCH.name);
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect(page.locator('#overlays [data-overlay]')).toHaveCount(0);
  await expect(page.locator('#view h1')).toBeFocused();

  // Answers that arrive after leaving are dropped: nothing paints into the next screen.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/runs', async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  const settled = new Promise((resolve) => {
    const done = (req) => {
      if (new URL(req.url()).pathname === '/api/runs') resolve();
    };
    page.on('requestfailed', done);
    page.on('requestfinished', done);
  });
  await page.evaluate(() => { location.hash = '#/schedules'; });
  await expect(page.locator('.sch-history')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('#view h1')).toHaveText('Home');
  release();
  await settled;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator('#view .sch-history, #view .sch-row')).toHaveCount(0);
  expect(await page.evaluate(() => window.__scheduleIntervals())).toBe(0);
});

test('schedules are accessible in light and dark, and fit 390px', async ({ app, page }) => {
  // The run history fits its box at each width (laptop widths with the widest runs: the test
  // above), so a run's status and counts never sit off to the side.
  await page.emulateMedia({ colorScheme: 'light' });
  await app.goto('#/schedules');
  await ready(page);
  await historyFits(page);
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);

  // With the menu open, then the dialog (custom + weekly shows every field).
  await openRowMenu(page, LUNCH.name);
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByRole('radio', { name: 'Weekly' }).check();
  await dialog.getByRole('radio', { name: 'Custom instruction' }).check();
  await dialog.getByRole('button', { name: 'Create schedule' }).click();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expectAccessible(page);
  await page.keyboard.press('Escape');

  const sideScroll = () => page.evaluate(() => document.documentElement.scrollWidth);
  await page.setViewportSize({ width: 1024, height: 768 });
  await ready(page);
  await historyFits(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  expect(await sideScroll()).toBeLessThanOrEqual(390);
  await historyFits(page);
  // Every row's controls stay on screen.
  for (const sw of await page.getByRole('switch').all()) {
    const box = await sw.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  const lastMenu = page.locator('.sch-row').last().getByRole('button', { name: /^Actions for / });
  const box = await lastMenu.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expectAccessible(page);
  await page.getByRole('button', { name: 'New schedule' }).click();
  await page.getByRole('dialog').getByRole('radio', { name: 'Weekly' }).check();
  expect(await sideScroll()).toBeLessThanOrEqual(390);
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
});

test.describe('new workspace', () => {
  test.use({ seed: 'onboarded' });

  test('empty states lead to the first schedule', async ({ app, page }) => {
    await app.goto('#/schedules');
    await ready(page);
    const list = page.locator('.sch-list');
    await expect(list.getByRole('heading', { name: 'No schedules yet' })).toBeVisible();
    await expect(list).toContainText('A schedule runs coldtrail at a set time, daily or weekly, even when this app is closed.');
    await expect(page.locator('.sch-history')).toContainText('No runs yet. Runs show up here when they finish.');
    await expect(page.getByRole('table', { name: 'Run history' })).toHaveCount(0);
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page);

    await list.getByRole('button', { name: 'Create a schedule' }).click();
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await dialog.getByLabel('Name', { exact: true }).fill('First run');
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.sch-row .sch-name')).toHaveText(['First run']);
    await expect(list.getByRole('heading', { name: 'No schedules yet' })).toHaveCount(0);
    await expect(page.locator('#topbar .chip')).toContainText('First run · next');

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('?new=1 opens the new schedule dialog', async ({ app, page }) => {
    await app.goto('#/schedules?new=1');
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await expect(dialog).toBeVisible();
    // The screen's heading doesn't take focus from it.
    await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
    // The address loses the flag, so back/refresh don't reopen it.
    await expect(page).toHaveURL(hashIs('#/schedules'));
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

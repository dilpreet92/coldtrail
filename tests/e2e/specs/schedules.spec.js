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
/** A run's name as Home gives it too: a run with no schedule name is named by its trigger (a
 *  timer-fired one had a schedule that is gone since). */
const runName = (r) =>
  r.schedule_name ??
  (r.trigger === 'scheduled' ? 'Deleted schedule' : r.trigger === 'manual' || r.trigger === 'dry' ? 'Manual run' : 'No schedule');

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
/** The next-run cell: relative within 48h ("in 3h"; under a minute away "in under a minute"),
 *  else the dated label. */
const nextText = (d) => {
  const rel = fmtRelative(d);
  if (rel === 'just now') return 'in under a minute';
  return /^in /.test(rel) ? rel : runLabel(d);
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
  await expect(rows.locator('td:nth-child(2)')).toHaveText(newest.map(runName));
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

test('a run with no schedule has the name Home gives it', async ({ app, page }) => {
  // /api/runs leaves the name out both for a run nobody scheduled and for one whose schedule is
  // gone: the newest run here was fired by a deleted schedule's timer, the next is a dry run.
  await page.route('**/api/runs', async (route) => {
    const res = await route.fetch();
    const list = await res.json();
    list[0] = { ...list[0], schedule_name: null, trigger: 'scheduled' };
    list[1] = { ...list[1], schedule_name: null, trigger: 'dry' };
    await route.fulfill({ response: res, json: list });
  });
  const newest = [...SEED.runs].reverse();
  newest[0] = { ...newest[0], schedule_name: null, trigger: 'scheduled' };
  newest[1] = { ...newest[1], schedule_name: null, trigger: 'dry' };
  expect(newest.slice(0, 4).map(runName)).toEqual(['Deleted schedule', 'Manual run', WEEKLY.name, 'Manual run']);

  await app.goto('#/home');
  const recent = page.getByRole('region', { name: 'Recent runs' });
  const onHome = recent.locator('.home-run-name');
  await expect(onHome).toHaveText(newest.slice(0, 5).map(runName));
  const homeNames = await onHome.allTextContents();

  // Home's "All runs" opens this history: each run keeps its name.
  await recent.getByRole('link', { name: 'All runs' }).click();
  await expect(page).toHaveURL(hashIs('#/schedules'));
  await ready(page);
  const rows = page.getByRole('table', { name: 'Run history' }).locator('tbody tr');
  await expect(rows.locator('td:nth-child(2)')).toHaveText(newest.map(runName));
  expect((await rows.locator('td:nth-child(2)').allTextContents()).slice(0, homeNames.length)).toEqual(homeNames);
  // The run's link names it the same way for assistive tech.
  await expect(rows.nth(1).getByRole('link', { name: /^View run/ })).toHaveAccessibleName(/^View run \(Manual run, /);
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

test('Try again keeps keyboard focus in the part it reloads, however the retry goes', async ({ app, page }) => {
  app.allowConsole(/status of 500/);
  const parts = [
    { path: '**/api/schedules', part: page.locator('.sch-list'), first: () => page.locator('.sch-row').first().getByRole('switch') },
    { path: '**/api/runs', part: page.locator('.sch-history'), first: () => page.locator('.sch-history').getByRole('link', { name: /^View run/ }).first() },
  ];
  for (const { path, part, first } of parts) {
    // 'fail' answers a 500 at once; 'hold-fail' and 'hold-ok' wait for release() first.
    let mode = 'fail';
    const held = [];
    const release = () => held.splice(0).forEach((resolve) => resolve());
    await page.route(path, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const now = mode;
      if (now !== 'fail') await new Promise((resolve) => held.push(resolve));
      if (now === 'hold-ok') return route.continue().catch(() => {});
      return route.fulfill({ status: 500, contentType: 'text/plain', body: 'database is locked' }).catch(() => {});
    });
    await app.goto('#/schedules');
    const retry = part.getByRole('button', { name: 'Try again' });
    await retry.focus();

    // While it reloads, focus waits on the part (never on the page); it fails again: the new Try again.
    mode = 'hold-fail';
    await page.keyboard.press('Enter');
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(part).toBeFocused();
    release();
    await expect(retry).toBeFocused();

    // It loads: focus goes on to the first control there.
    mode = 'hold-ok';
    await page.keyboard.press('Enter');
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(part).toBeFocused();
    release();
    await expect(first()).toBeFocused();
    await page.unroute(path);
  }
});

test('the loading placeholder fits 390px, and is about as tall as the rows it stands for', async ({ app, page }) => {
  // The seeded workspace has two schedules, one with a last run and one without: the placeholder
  // shows two rows. Run history (loaded first) moves by less than a third of a row when they land.
  for (const [width, rowHeight] of [[1440, 90], [390, 200]]) {
    await page.setViewportSize({ width, height: 844 });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/api/schedules', async (route) => {
      await gate;
      await route.continue().catch(() => {});
    });
    await app.goto('#/schedules');
    const list = page.locator('.sch-list');
    await expect(list).toHaveAttribute('aria-busy', 'true');
    await expect(list.locator('.sch-skel-row').first()).toBeVisible();
    await expect(page.locator('.sch-history')).toHaveAttribute('aria-busy', 'false');
    // The page never scrolls sideways, and every bar stays inside the card.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const card = await list.boundingBox();
    for (const bar of await list.locator('.skeleton').all()) {
      const box = await bar.boundingBox();
      if (box) expect(box.x + box.width, await bar.getAttribute('class')).toBeLessThanOrEqual(card.x + card.width);
    }
    const historyTop = async () => (await page.locator('.sch-history').boundingBox()).y;
    const loading = await historyTop();
    release();
    await ready(page);
    expect(Math.abs((await historyTop()) - loading), `Run history moved at ${width}px`).toBeLessThanOrEqual(rowHeight / 3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.unroute('**/api/schedules');
  }
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

// Leaves Lunch Source enabled, as seeded.
test('a reload already on its way never undoes a toggle or a delete that worked', async ({ app, page, server, request }) => {
  const enabled = async () => (await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', LUNCH.id))[0].enabled;
  // Each time a run finishes (the store's summary has a newer last run) the screen reloads its
  // list. staleRead() makes that GET read the list now and answer only once released, so the
  // answer is from before whatever the test does meanwhile.
  let finished = 0;
  let hold = null;
  await patchSummary(page, () =>
    finished
      ? { last_run: { started_at: `2099-01-0${finished} 00:00:00`, status: 'ok', schedule_name: LUNCH.name, chat_id: null, sourced: 1, drafted: 1, sent: 0 } }
      : {},
  );
  await page.route('**/api/schedules', async (route) => {
    if (route.request().method() !== 'GET' || !hold) return route.continue();
    const held = hold;
    hold = null;
    const res = await route.fetch();
    const json = await res.json();
    held.read(route.request());
    await held.gate;
    await route.fulfill({ response: res, json }).catch(() => {}); // the page dropped it: nothing to answer
  });
  async function staleRead() {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const read = new Promise((resolve) => {
      hold = { gate, read: resolve };
    });
    finished += 1;
    await refreshStore(page);
    const req = await read;
    const outcome = new Promise((resolve) => {
      page.on('requestfailed', (r) => r === req && resolve('dropped'));
      page.on('requestfinished', (r) => r === req && resolve('answered'));
    });
    return { release, outcome };
  }
  const throwaway = await sendJSON(request, server, 'POST', '/api/schedules', {
    name: 'Throwaway', enabled: false, freq: 'daily', time: '10:00', weekday: null, task_mode: 'agent', prompt: null,
  });
  try {
    await app.goto('#/schedules');
    await ready(page);
    const lunch = row(page, LUNCH.name);
    const sw = lunch.getByRole('switch', { name: LUNCH.name });
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    // A reload that read the list before the pause answers after it: the pause stays on screen.
    let stale = await staleRead();
    await sw.click();
    await expect(toastWith(page, `“${LUNCH.name}” is paused.`)).toBeVisible();
    await expect.poll(enabled).toBe(0);
    stale.release();
    expect(await stale.outcome).toBe('dropped');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(lunch.locator('.sch-next')).toContainText('Paused');
    await expect(page.locator('#topbar .chip')).toHaveText('No schedule');

    // One that answers while the switch is still saving rebuilds the row from the list as it was:
    // the new switch still shows the press and ignores presses until the save is done, then the
    // row shows what was stored.
    const patches = recordRequests(page, /^\/api\/schedules\/[^/]+$/);
    let releasePatch;
    const patchGate = new Promise((resolve) => {
      releasePatch = resolve;
    });
    await page.route(`**/api/schedules/${LUNCH.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const res = await route.fetch(); // stored now; the answer waits (a slow timer install)
      await patchGate;
      await route.fulfill({ response: res });
    });
    stale = await staleRead();
    await sw.click();
    await expect.poll(enabled).toBe(1);
    const pressed = await sw.elementHandle();
    stale.release();
    expect(await stale.outcome).toBe('answered');
    await expect.poll(() => pressed.evaluate((el) => el.isConnected)).toBe(false); // rebuilt
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(sw).toHaveAttribute('aria-busy', 'true');
    await sw.click(); // a second press while the first saves would race it
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    releasePatch();
    await expect(toastWith(page, `“${LUNCH.name}” is on.`)).toBeVisible();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(sw).not.toHaveAttribute('aria-busy', 'true');
    await expect(lunch.locator('.sch-next time')).toHaveAttribute('title', runLabel(nextRuns(LUNCH)[0]));
    expect(await enabled()).toBe(1);
    expect(patches.filter((p) => p.method === 'PATCH').map((p) => p.body)).toEqual([{ enabled: true }]);
    await page.unroute(`**/api/schedules/${LUNCH.id}`);

    // A reload that read the list before a delete answers after it: the row stays gone.
    stale = await staleRead();
    await openRowMenu(page, 'Throwaway');
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete schedule' }).click();
    await expect(toastWith(page, '“Throwaway” deleted.')).toBeVisible();
    expect(await dbRows(server, 'SELECT id FROM schedules WHERE id = ?', throwaway.id)).toEqual([]);
    stale.release();
    expect(await stale.outcome).toBe('dropped');
    await expect(page.locator('.sch-list')).toHaveAttribute('aria-busy', 'false');
    await expect(row(page, 'Throwaway')).toHaveCount(0);
    await expect(row(page, LUNCH.name)).toHaveCount(1);
  } finally {
    await page.unroute('**/api/schedules');
    for (const { id } of await dbRows(server, 'SELECT id FROM schedules WHERE id = ?', throwaway.id)) {
      await sendJSON(request, server, 'DELETE', `/api/schedules/${id}`);
    }
  }
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

// Leaves Lunch Source named as seeded.
test('renaming a schedule renames its runs in the run history', async ({ app, page }) => {
  await app.goto('#/schedules');
  await ready(page);
  // /api/runs names each run by its schedule's name now.
  const named = (name) => page.locator('.sch-history .sch-run-name').filter({ hasText: new RegExp(`^${reEscape(name)}$`) });
  const lunchRuns = await named(LUNCH.name).count();
  expect(lunchRuns).toBeGreaterThan(0);
  const rename = async (from, to) => {
    await openRowMenu(page, from);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
    await dialog.getByLabel('Name', { exact: true }).fill(to);
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, to)).toBeVisible();
  };
  await rename(LUNCH.name, 'Midday Source');
  await expect(named('Midday Source')).toHaveCount(lunchRuns);
  await expect(named(LUNCH.name)).toHaveCount(0);
  await rename('Midday Source', LUNCH.name);
  await expect(named(LUNCH.name)).toHaveCount(lunchRuns);
  await expect(named('Midday Source')).toHaveCount(0);
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

test('"Change in Settings" asks before it drops a changed form', async ({ app, page, server }) => {
  await app.goto('#/schedules');
  await ready(page);
  const newBtn = page.getByRole('button', { name: 'New schedule' });
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  const link = page.getByRole('dialog').getByRole('link', { name: 'Change in Settings' });
  const TEXT = 'Source 20 seed-stage fintechs in Berlin and draft intros to the founders, one per company';

  // Untouched, it just opens Settings → Sending: nothing is lost.
  await newBtn.click();
  await link.click();
  await expect(page).toHaveURL(hashIs('#/settings?tab=sending'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await app.goto('#/schedules');
  await ready(page);

  // With something typed, it asks first; "Keep editing" (or Esc) leaves the form as it was.
  await newBtn.click();
  await dialog.getByLabel('Name', { exact: true }).fill('Friday founders');
  await dialog.getByRole('radio', { name: 'Custom instruction' }).check();
  await dialog.getByLabel('Instruction', { exact: true }).fill(TEXT);
  await link.click();
  const confirm = page.getByRole('alertdialog', { name: 'Discard this schedule and open Settings?' });
  await expect(confirm).toContainText('It isn’t saved yet. To keep it, create it first, then change sending in Settings.');
  await expect(confirm.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(confirm).toBeHidden();
  await expect(page).toHaveURL(hashIs('#/schedules'));
  await expect(link).toBeFocused();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Friday founders');
  await expect(dialog.getByLabel('Instruction', { exact: true })).toHaveValue(TEXT);
  await link.press('Enter');
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(dialog.getByLabel('Instruction', { exact: true })).toHaveValue(TEXT);

  // Discarding opens Settings, and nothing was saved.
  await link.click();
  await confirm.getByRole('button', { name: 'Discard and open Settings' }).click();
  await expect(page).toHaveURL(hashIs('#/settings?tab=sending'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await dbRows(server, "SELECT id FROM schedules WHERE name = 'Friday founders'")).toEqual([]);

  // Editing a schedule: the question is about the changes.
  await app.goto('#/schedules');
  await ready(page);
  await openRowMenu(page, LUNCH.name);
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit schedule' });
  await edit.getByLabel('Time', { exact: true }).fill('11:15');
  await link.click();
  const confirmEdit = page.getByRole('alertdialog', { name: 'Discard your changes and open Settings?' });
  await expect(confirmEdit).toContainText(`Your changes to “${LUNCH.name}” aren’t saved yet. To keep them, save first, then change sending in Settings.`);
  await confirmEdit.getByRole('button', { name: 'Keep editing' }).click();
  await expect(edit.getByLabel('Time', { exact: true })).toHaveValue('11:15');
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(edit).toBeHidden();
  expect((await dbRows(server, 'SELECT time FROM schedules WHERE id = ?', LUNCH.id))[0].time).not.toBe('11:15');
});

test('a changed form closed by ⌘K or by leaving the screen comes back; Cancel, Esc and Close drop it', async ({ app, page, server }) => {
  // From Home by the sidebar, so Back has somewhere in the app to go.
  await app.goto('#/home');
  await expect(page.locator('#view h1')).toHaveText('Home');
  await page.locator('#nav a.nav-item[data-route="schedules"]').click();
  await ready(page);
  const newBtn = page.getByRole('button', { name: 'New schedule' });
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  const nameIn = dialog.getByLabel('Name', { exact: true });
  const custom = dialog.getByRole('radio', { name: 'Custom instruction' });
  const instruction = dialog.getByLabel('Instruction', { exact: true });
  const back = dialog.locator('.sch-restored');
  const beside = () => page.locator('.overlay-dialog').click({ position: { x: 8, y: 8 } });
  const TEXT = 'Source 20 companies like Acme and draft intros to their founders';
  const keptNew = toastWith(page, '“Like Acme” isn’t created yet. What you typed comes back when you open New schedule.');
  const typeSomething = async () => {
    await nameIn.fill('Like Acme');
    await custom.check();
    await instruction.fill(TEXT);
  };

  // ⌘K (search) closes the dialog as Esc does, but it isn't a choice to drop the form: it's kept.
  await newBtn.click();
  await typeSomething();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.search-input')).toBeFocused();
  await expect(keptNew).toBeVisible();
  await keptNew.getByRole('button', { name: 'Dismiss' }).click();
  // New schedule brings it back and says so. It is still unsaved: a click beside it keeps it open.
  await newBtn.click();
  await expect(nameIn).toHaveValue('Like Acme');
  await expect(custom).toBeChecked();
  await expect(instruction).toHaveValue(TEXT);
  await expect(back).toHaveText('Your unsaved schedule from earlier is back. Discard');
  await expect(dialog).toHaveAttribute('aria-describedby', await back.getAttribute('id'));
  await beside();
  await expect(dialog).toBeVisible();

  // Back leaves the screen, which closes the dialog: it's kept, and the screen it lands on says so.
  await page.goBack();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(keptNew).toBeVisible();
  await keptNew.getByRole('button', { name: 'Dismiss' }).click();
  await page.goForward();
  await ready(page);
  await newBtn.click();
  await expect(nameIn).toHaveValue('Like Acme');
  await expect(instruction).toHaveValue(TEXT);

  // Discard empties the form for good: untouched now, a click beside it closes it, and nothing
  // comes back.
  await back.getByRole('button', { name: 'Discard' }).click();
  await expect(back).toBeHidden();
  await expect(dialog).not.toHaveAttribute('aria-describedby', /./);
  await expect(nameIn).toBeFocused();
  await expect(nameIn).toHaveValue('');
  await expect(dialog.getByRole('radio', { name: 'Agent decides' })).toBeChecked();
  await expect(instruction).toBeHidden();
  await beside();
  await expect(dialog).toBeHidden();
  await newBtn.click();
  await expect(nameIn).toHaveValue('');
  await expect(back).toBeHidden();

  // Cancel, Esc and Close are a choice to drop it: nothing is kept, and nothing says it was.
  const closes = [
    () => dialog.getByRole('button', { name: 'Cancel' }).click(),
    () => page.keyboard.press('Escape'),
    () => dialog.getByRole('button', { name: 'Close' }).click(),
  ];
  for (const close of closes) {
    await typeSomething();
    await close();
    await expect(dialog).toBeHidden();
    await newBtn.click();
    await expect(nameIn).toHaveValue('');
    await expect(back).toBeHidden();
  }
  await expect(toastWith(page, 'isn’t created yet')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // An edit is kept the same way, for Edit of that schedule only.
  const stored = (await dbRows(server, 'SELECT time FROM schedules WHERE id = ?', LUNCH.id))[0].time;
  const edit = page.getByRole('dialog', { name: 'Edit schedule' });
  const time = edit.getByLabel('Time', { exact: true });
  const openEdit = async () => {
    await openRowMenu(page, LUNCH.name);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(edit).toBeVisible();
  };
  await openEdit();
  await time.fill('11:15');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(edit).toBeHidden();
  await expect(toastWith(page, `Your changes to “${LUNCH.name}” aren’t saved yet. They come back when you edit it again.`)).toBeVisible();
  await newBtn.click();
  await expect(nameIn).toHaveValue('');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await openEdit();
  await expect(time).toHaveValue('11:15');
  await expect(edit.locator('.sch-restored')).toHaveText('Your unsaved changes from earlier are back. Discard');
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await openEdit();
  await expect(time).toHaveValue(stored);
  await expect(edit.locator('.sch-restored')).toBeHidden();
  await edit.getByRole('button', { name: 'Cancel' }).click();

  // Nothing was saved.
  expect(await dbRows(server, "SELECT id FROM schedules WHERE name = 'Like Acme'")).toEqual([]);
  expect((await dbRows(server, 'SELECT time FROM schedules WHERE id = ?', LUNCH.id))[0].time).toBe(stored);
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

    // Close while it saves, and the save fails: a toast says so (the dialog's message is gone),
    // and New schedule brings back what wasn't stored.
    await createAndLeave('Never stored', () => dialog.getByRole('button', { name: 'Close' }).click());
    await expect(page.locator('.toast-err .toast-text')).toHaveText(
      "Couldn't save “Never stored”: database is locked\nWhat you typed comes back when you open New schedule.",
    );
    await expect(row(page, 'Never stored')).toHaveCount(0);
    await newBtn.click();
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Never stored');
    await expect(dialog.locator('.sch-restored')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  } finally {
    for (const resolve of gates) resolve();
    await page.unroute('**/api/schedules');
    for (const { id } of await dbRows(server, "SELECT id FROM schedules WHERE name IN ('Closed early', 'Never stored')")) {
      await sendJSON(request, server, 'DELETE', `/api/schedules/${id}`);
    }
  }
});

test('a save that ends after leaving the screen still says how it went', async ({ app, page, server, request }) => {
  app.allowConsole(/status of 500/);
  // Hold each create and edit until released (a timer install can be slow). With `timerFails`
  // the server stores it and the answer is then a 500, as when its timer step fails.
  const gates = [];
  let timerFails = false;
  const hold = async (route) => {
    await new Promise((resolve) => gates.push(resolve));
    if (!timerFails) return route.continue();
    const res = await route.fetch();
    expect(res.status()).toBe(200);
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'launchctl bootstrap: Input/output error' });
  };
  const one = /\/api\/schedules\/[^/]+$/;
  await page.route('**/api/schedules', (route) => (route.request().method() === 'POST' ? hold(route) : route.continue()));
  await page.route(one, (route) => (route.request().method() === 'PATCH' ? hold(route) : route.continue()));
  const edited = await sendJSON(request, server, 'POST', '/api/schedules', {
    name: 'Edited, then left', enabled: true, freq: 'daily', time: '10:00', weekday: null, task_mode: 'agent', prompt: null,
  });
  const dialog = page.getByRole('dialog');
  const home = page.locator('#nav a.nav-item[data-route="home"]');
  const leftHome = () => expect(page.locator('#view h1')).toHaveText('Home');
  try {
    // Create, Esc while it saves (the dialog's outcome now comes by toast), then the sidebar.
    // The row is stored, but its timer isn't: the toast says so, on the screen now open.
    await app.goto('#/schedules');
    await ready(page);
    await page.getByRole('button', { name: 'New schedule' }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Left after Esc');
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect.poll(() => gates.length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await home.click();
    await leftHome();
    timerFails = true;
    gates[0]();
    await expect(
      toastWith(page, "“Left after Esc” was saved, but its timer wasn't installed: launchctl bootstrap: Input/output error"),
    ).toBeVisible();
    expect(await dbRows(server, "SELECT enabled FROM schedules WHERE name = 'Left after Esc'")).toEqual([{ enabled: 1 }]);

    // Create, then the address changes with the dialog still open (Back), which closes it. The
    // save goes on, and once it is stored a toast says so.
    await app.goto('#/schedules');
    await ready(page);
    await page.getByRole('button', { name: 'New schedule' }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Left with it open');
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect.poll(() => gates.length).toBe(2);
    await page.evaluate(() => { location.hash = '#/home'; });
    await leftHome();
    await expect(dialog).toHaveCount(0);
    timerFails = false;
    gates[1]();
    const first = runLabel(nextRuns({ freq: 'daily', time: '09:00' })[0]);
    await expect(toastWith(page, `“Left with it open” created. First run ${first}.`)).toBeVisible();
    expect(await dbRows(server, "SELECT enabled FROM schedules WHERE name = 'Left with it open'")).toEqual([{ enabled: 1 }]);

    // An edit stored before its timer step failed, left the same way.
    await app.goto('#/schedules');
    await ready(page);
    await openRowMenu(page, edited.name);
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await dialog.getByLabel('Time', { exact: true }).fill('10:30');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => gates.length).toBe(3);
    await page.evaluate(() => { location.hash = '#/home'; });
    await leftHome();
    timerFails = true;
    gates[2]();
    await expect(
      toastWith(page, `“${edited.name}” was saved, but its timer wasn't updated: launchctl bootstrap: Input/output error`),
    ).toBeVisible();
    expect(await dbRows(server, 'SELECT time FROM schedules WHERE id = ?', edited.id)).toEqual([{ time: '10:30' }]);
  } finally {
    for (const resolve of gates) resolve();
    await page.unroute('**/api/schedules');
    await page.unroute(one);
    const names = ['Left after Esc', 'Left with it open', edited.name];
    for (const { id } of await dbRows(server, `SELECT id FROM schedules WHERE name IN (${names.map(() => '?').join(', ')})`, ...names)) {
      await sendJSON(request, server, 'DELETE', `/api/schedules/${id}`);
    }
  }
});

test('a toggle, run or delete that ends after leaving the screen still says how it went', async ({ app, page, server, request }) => {
  app.allowConsole(/status of 500/);
  // Hold each toggle, run and delete until released, then answer as `answer` says: 'ok'
  // (stored), 'timer' (stored, then a 500 as when the timer step fails) or 'fail' (a 500, nothing
  // stored). A run that starts is only answered as started: no agent is spawned.
  const gates = [];
  let answer = 'ok';
  const one = /\/api\/schedules\/[^/]+(\/run)?$/;
  await page.route(one, async (route) => {
    const method = route.request().method();
    if (method !== 'PATCH' && method !== 'DELETE' && method !== 'POST') return route.continue();
    await new Promise((resolve) => gates.push(resolve));
    if (answer === 'ok') return method === 'POST' ? route.fulfill({ json: { chat_id: 'never-opened' } }) : route.continue();
    if (answer === 'timer') {
      const res = await route.fetch();
      expect(res.status()).toBe(200);
      return route.fulfill({ status: 500, contentType: 'text/plain', body: 'launchctl bootout: Input/output error' });
    }
    return route.fulfill({ status: 500, contentType: 'text/plain', body: method === 'POST' ? 'could not start the agent' : 'database is locked' });
  });
  const s = await sendJSON(request, server, 'POST', '/api/schedules', {
    name: 'Left behind', enabled: true, freq: 'daily', time: '10:00', weekday: null, task_mode: 'agent', prompt: null,
  });
  const stored = () => dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', s.id);
  const home = page.locator('#nav a.nav-item[data-route="home"]');
  /** On Schedules, `act` on the row; leave by the sidebar while the server holds it; then let
   *  it answer as `how` says. */
  async function leaveDuring(act, how) {
    await app.goto('#/schedules');
    await ready(page);
    const held = gates.length + 1;
    await act(row(page, s.name));
    await expect.poll(() => gates.length).toBe(held);
    await home.click();
    await expect(page.locator('#view h1')).toHaveText('Home');
    answer = how;
    gates.at(-1)();
  }
  const press = (r) => r.getByRole('switch', { name: s.name }).click();
  async function dryRun(r) {
    await r.getByRole('button', { name: `Actions for ${s.name}` }).click();
    await page.getByRole('menuitem', { name: 'Dry run' }).click();
  }
  async function del(r) {
    await r.getByRole('button', { name: `Actions for ${s.name}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete schedule' }).click();
  }
  try {
    // Paused, but its timer couldn't be removed: said as it is on the screen, never "Couldn't
    // pause" (which would say it still runs as before).
    await leaveDuring(press, 'timer');
    await expect(
      toastWith(page, `“${s.name}” is paused, but its timer couldn't be removed, so it may still run: launchctl bootout: Input/output error`),
    ).toBeVisible();
    await expect(toastWith(page, "Couldn't pause")).toHaveCount(0);
    expect(await stored()).toEqual([{ enabled: 0 }]);

    // Turned back on, and it worked.
    await leaveDuring(press, 'ok');
    await expect(toastWith(page, `“${s.name}” is on. Next run ${runLabel(nextRuns(s)[0])}.`)).toBeVisible();
    expect(await stored()).toEqual([{ enabled: 1 }]);

    // A dry run that couldn't start says so; one that started says so too, and the screen open
    // now stays open (it isn't swapped for the run's conversation).
    await leaveDuring(dryRun, 'fail');
    await expect(toastWith(page, `Couldn't start a dry run of “${s.name}”: could not start the agent`)).toBeVisible();
    await leaveDuring(dryRun, 'ok');
    await expect(toastWith(page, `Dry run of “${s.name}” started. It only writes drafts.`)).toBeVisible();
    await expect(page).toHaveURL(hashIs('#/home'));
    await expect(page.locator('#view h1')).toHaveText('Home');

    // A delete that fails: the schedule stays (and keeps running), and a toast says so.
    await leaveDuring(del, 'fail');
    await expect(toastWith(page, `Couldn't delete “${s.name}”: database is locked`)).toBeVisible();
    expect(await stored()).toEqual([{ enabled: 1 }]);

    // One that works.
    await leaveDuring(del, 'ok');
    await expect(toastWith(page, `“${s.name}” deleted.`)).toBeVisible();
    expect(await stored()).toEqual([]);
  } finally {
    for (const resolve of gates) resolve();
    await page.unroute(one);
    for (const { id } of await dbRows(server, 'SELECT id FROM schedules WHERE id = ?', s.id)) {
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
  // Each toggle answers slowly, as a real timer install can: the switch ignores presses while one
  // is saving, so each press below waits for the one before to be stored.
  await page.route(/\/api\/schedules\/[^/]+$/, async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await app.goto('#/schedules');
  await ready(page);
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByLabel('Name', { exact: true }).fill('Timer check');
  await dialog.getByLabel('Time', { exact: true }).fill('06:10');
  await dialog.getByRole('button', { name: 'Create schedule' }).click();
  await expect(dialog).toBeHidden();
  const [{ id }] = await dbRows(server, "SELECT id FROM schedules WHERE name = 'Timer check'");
  const enabled = async () => (await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', id))[0].enabled;

  // Pausing and resuming runs the server's remove and install paths too.
  const sw = row(page, 'Timer check').getByRole('switch', { name: 'Timer check' });
  await sw.click();
  await expect(toastWith(page, '“Timer check” is paused.')).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(sw).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(enabled).toBe(0);
  await sw.click();
  await expect(toastWith(page, '“Timer check” is on.')).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(sw).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(enabled).toBe(1);

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
  // No run of it is going on: only what deleting it does.
  await expect(confirm.locator('.dialog-body p')).toHaveText(["Its timer is removed, so it won't run again. Past runs stay in the run history."]);
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
  // Its past run stays in the history, no longer tied to a schedule: a dry run someone started,
  // named as Home names it.
  const dry = page.getByRole('table', { name: 'Run history' }).locator('tbody tr').filter({ hasText: 'Dry run' });
  await expect(dry.locator('td:nth-child(2)')).toHaveText('Manual run');
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
  // The run it starts gets up to 60s to finish below: more than the default 30s per test.
  test.setTimeout(90_000);
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
  // The run it starts gets up to 60s to finish below: more than the default 30s per test.
  test.setTimeout(90_000);
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
  // The run it starts gets up to 60s to finish below: more than the default 30s per test.
  test.setTimeout(90_000);
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

test("focus on a row's run link stays on its row when the run starts or ends", async ({ app, page }) => {
  // Lunch Source's last run gets a conversation (`chat`), so its row has a View run link.
  let chat = SEED.chats.berlin.id;
  let patch = {};
  await patchSchedules(page, (list) => {
    const lunch = list.find((s) => s.id === LUNCH.id);
    if (lunch && lunch.last_run) lunch.last_run.chat_id = chat;
  });
  await patchSummary(page, () => patch);
  await app.goto('#/schedules');
  await ready(page);
  const lunch = row(page, LUNCH.name);
  const view = lunch.getByRole('link', { name: /^View run/ });
  const watch = lunch.getByRole('link', { name: /^Watch the run/ });
  const running = { chat_id: SEED.chats.scheduled.id, title: `Scheduled run — ${LUNCH.name}` };
  await view.focus();

  // A run starts: View run becomes Watch the run, and focus goes with it; it ends: back again.
  patch = { running };
  await refreshStore(page);
  await expect(watch).toBeFocused();
  patch = { running: null };
  await refreshStore(page);
  await expect(view).toBeFocused();

  // A run ends that left nothing to view: focus stays on the row, on its ⋯ button.
  patch = { running };
  await refreshStore(page);
  await expect(watch).toBeFocused();
  chat = null;
  const reloaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/schedules');
  patch = {
    running: null,
    last_run: { started_at: '2099-01-04 00:00:00', status: 'ok', schedule_name: LUNCH.name, chat_id: null, sourced: 1, drafted: 1, sent: 0 },
  };
  await refreshStore(page);
  await reloaded;
  await expect(view).toHaveCount(0);
  await expect(lunch.getByRole('button', { name: `Actions for ${LUNCH.name}` })).toBeFocused();
});

// Leaves Lunch Source enabled, as seeded.
test('deleting or pausing a schedule while it runs says the run goes on', async ({ app, page, server }) => {
  const enabled = async () => (await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', LUNCH.id))[0].enabled;
  // The shared store's summary says a run of Lunch Source is going on. A run is its own process:
  // deleting or pausing the schedule removes its timer but never stops that run.
  await patchSummary(page, () => ({ running: { chat_id: SEED.chats.scheduled.id, title: `Scheduled run — ${LUNCH.name}` } }));
  await app.goto('#/schedules');
  await ready(page);
  const lunch = row(page, LUNCH.name);
  await expect(lunch.locator('.sch-last .badge')).toHaveText('Running');

  await openRowMenu(page, LUNCH.name);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete “${LUNCH.name}”?` });
  await expect(confirm.locator('.dialog-body p')).toHaveText([
    "Its timer is removed, so it won't run again. Past runs stay in the run history.",
    "The run going on now isn't stopped: it finishes, and can still send what auto-send allows.",
  ]);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();

  const sw = lunch.getByRole('switch', { name: LUNCH.name });
  await sw.click();
  await expect(
    toastWith(page, `“${LUNCH.name}” is paused. The run going on now isn't stopped: it finishes, and then it won't run until you turn it back on.`),
  ).toBeVisible();
  await expect.poll(enabled).toBe(0);
  await sw.click();
  await expect(toastWith(page, `“${LUNCH.name}” is on.`)).toBeVisible();
  await expect.poll(enabled).toBe(1);
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

test('?new=1 opens the dialog after a row menu was used, and never stacks a second one', async ({ app, page, server, request }) => {
  // Two rows' menus are used below: this test brings its own second row rather than count on
  // one an earlier test left.
  const second = await sendJSON(request, server, 'POST', '/api/schedules', {
    name: 'Second row', enabled: false, freq: 'daily', time: '10:00', weekday: null, task_mode: 'agent', prompt: null,
  });
  try {
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
    expect(await menuButtons.count()).toBeGreaterThanOrEqual(2);
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
  } finally {
    await sendJSON(request, server, 'DELETE', `/api/schedules/${second.id}`);
  }
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

test('a run less than a minute away is "in under a minute", never "just now"', async ({ app, page }) => {
  // 12:59:30 here, and a daily schedule at 13:00.
  const now = new Date();
  now.setHours(12, 59, 30, 0);
  await page.clock.setFixedTime(now);
  const soon = {
    id: 'e2e-soon', name: 'Almost time', enabled: true, freq: 'daily', time: '13:00', weekday: null,
    task_mode: 'agent', prompt: null, last_run: null,
  };
  await patchSchedules(page, (list) => list.push(soon));
  await app.goto('#/schedules');
  await ready(page);
  const at = runLabel(nextRuns(soon, 1, now)[0]);
  const next = row(page, soon.name).locator('.sch-next');
  await expect(next.locator('time')).toHaveText('in under a minute');
  await expect(next.locator('time')).toHaveAttribute('title', at);
  await expect(next.locator('.sch-sub')).toHaveText(at);

  // The dialog's preview says the same of its first run.
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByLabel('Time', { exact: true }).fill('13:00');
  const first = dialog.getByRole('list', { name: 'Next 3 runs' }).locator('li').first();
  await expect(first.locator('.sch-run-at')).toHaveText(at);
  await expect(first.locator('.sch-run-rel')).toHaveText('in under a minute');
  await expect(dialog.getByText('just now')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
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
    // The card's button is the one primary action: the header's New schedule (the same thing)
    // is hidden while there are no schedules.
    const newBtn = page.getByRole('button', { name: 'New schedule' });
    await expect(newBtn).toHaveCount(0);
    await expect(page.locator('#view .btn-primary:visible')).toHaveText(['Create a schedule']);
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
    // The card's button is gone with the empty state: focus moves to the header's, back now.
    await expect(newBtn).toBeVisible();
    await expect(newBtn).toBeFocused();
    await expect(page.locator('#topbar .chip')).toContainText('First run · next');

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('?new=1 opens the new schedule dialog', async ({ app, page, server, request }) => {
    // From an empty list: remove the schedule the test above created.
    for (const { id } of await dbRows(server, 'SELECT id FROM schedules')) {
      await sendJSON(request, server, 'DELETE', `/api/schedules/${id}`);
    }
    await app.goto('#/schedules?new=1');
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await expect(dialog).toBeVisible();
    // The screen's heading doesn't take focus from it.
    await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
    // The address loses the flag, so back/refresh don't reopen it.
    await expect(page).toHaveURL(hashIs('#/schedules'));
    await expect(page.locator('.sch-list .empty-state')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // It opened while the list loaded, from the header's button, hidden since (no schedules):
    // focus goes to the empty list's button instead of being lost.
    await expect(page.locator('.sch-list').getByRole('button', { name: 'Create a schedule' })).toBeFocused();
  });
});

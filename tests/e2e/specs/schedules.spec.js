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

// Several tests end on another screen (a run opens in Agent). That screen's own stylesheet is its
// task's business: if it isn't there yet, serve it empty instead of failing these tests on the
// 404. Schedules' own stylesheet is never stood in for.
test.beforeEach(async ({ page }) => {
  await page.route('**/assets/css/views/*.css', async (route) => {
    if (route.request().url().endsWith('/schedules.css')) return route.continue();
    const res = await route.fetch();
    if (res.status() === 404) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.fulfill({ response: res });
  });
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

test('lists seeded schedules with next run', async ({ app, page, server, request }) => {
  await app.goto('#/schedules');
  await ready(page);
  await expect(page).toHaveTitle('Schedules · coldtrail');
  await expect(page.locator('.page-desc')).toContainText('Auto-send is off, so runs only write drafts.');

  const list = page.getByRole('list', { name: 'Schedules' });
  await expect(list.locator('.sch-row .sch-name')).toHaveText([LUNCH.name, WEEKLY.name]);

  // Lunch Source: daily, the agent decides, on, next run soon, last run failed.
  const lunch = row(page, LUNCH.name);
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
  await expect(last).toContainText(counts(lastLunch));
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
  await expect(rows.locator('td:nth-child(4)')).toHaveText(newest.map((r) => STATUS[r.status]));
  for (const [i, key] of ['sourced', 'enriched', 'drafted', 'sent'].entries()) {
    await expect(rows.locator(`td:nth-child(${5 + i})`)).toHaveText(newest.map((r) => fmtNum(r[key])));
  }

  // Finished: relative within 48h, the absolute time on hover.
  const api = await (await request.get(server.apiUrl('/api/runs'))).json();
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
  await expect(page.locator('.sch-list').getByRole('alert')).toContainText("Schedules didn't load.");
  await expect(page.locator('.sch-history').getByRole('alert')).toContainText("Run history didn't load.");
  // The banner already says why; the screen doesn't repeat it.
  await expect(page.locator('#view').getByText(SESSION_EXPIRED)).toHaveCount(0);
  await expect(page.getByText('No schedules yet')).toHaveCount(0);
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
  await expect(page.locator('.toast-err')).toContainText('launchctl bootstrap: Operation not permitted');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect((await dbRows(server, 'SELECT enabled FROM schedules WHERE id = ?', LUNCH.id))[0].enabled).toBe(1);
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
  await expect(dialog.getByRole('alert')).toHaveText(
    "Saved, but its timer wasn't installed: launchctl bootstrap: Input/output error",
  );
  // The row exists, so the dialog now edits it: saving again updates instead of creating.
  await expect(row(page, 'Half saved')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await page.unroute('**/api/schedules');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();
  const rows = await dbRows(server, "SELECT id FROM schedules WHERE name = 'Half saved'");
  expect(rows).toHaveLength(1);
  expect(sent.filter((s) => s.method !== 'GET').map((s) => [s.method, s.path])).toEqual([
    ['POST', '/api/schedules'],
    ['PATCH', `/api/schedules/${rows[0].id}`],
  ]);
  await sendJSON(request, server, 'DELETE', `/api/schedules/${rows[0].id}`);
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
    // A dry run never asks: it can't send.
    expect(runs).toEqual([]);

    await setEmail(false);
    await page.reload();
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
  await app.goto('#/schedules');
  await ready(page);
  await openRowMenu(page, LUNCH.name);
  const post = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/schedules/${LUNCH.id}/run`));
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/schedules/${LUNCH.id}/run`));
  await page.getByRole('menuitem', { name: 'Run now' }).click();
  expect(JSON.parse((await post).postData())).toEqual({ draft_only: false });
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
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
  await page.emulateMedia({ colorScheme: 'light' });
  await app.goto('#/schedules');
  await ready(page);
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
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  expect(await sideScroll()).toBeLessThanOrEqual(390);
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
    // The address loses the flag, so back/refresh don't reopen it.
    await expect(page).toHaveURL(hashIs('#/schedules'));
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

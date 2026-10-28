// Home (spec §5.2): "Needs you" cards, the stat line, the funnel, recent runs and top searches
// over the seeded workspace; the getting-started list for a workspace with no companies; and the
// loading / error / hostile-data / live-update / unmount behaviour of each data source
// (/api/summary through the shared store, /api/runs, /api/companies?per=1).
//
// The other screens are stubbed in these tests (stubViews) so Home's links are checked by where
// they land, independent of how far those screens are built.
import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { SEED } from '../harness/seed.mjs';
import { SESSION_EXPIRED, SESSION_REOPEN } from '../../../ui/js/core/api.js';
import { fmtDate, fmtNum, fmtRelative, runStatus } from '../../../ui/js/core/format.js';
import { FRESH_MS, nextRunWhen, runKeys, runNote, searchesCaption } from '../../../ui/js/views/home.js';

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashIs = (hash) => new RegExp(`${reEscape(hash)}$`);
const PCT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const pct = (part, whole) => (whole ? PCT.format(part / whole) : '—');
const HOUR = 3_600_000;
const pad = (n) => String(n).padStart(2, '0');
/** A Date as the summary's next_at: zone-less local time, "2026-10-28T13:30". */
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** A Date as SQLite's datetime('now') writes it (UTC, space separator), like /api/runs started_at. */
const sqliteUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

const STAGE_LABELS = ['Sourced', 'Contact found', 'Drafted', 'Sent', 'Replied'];
// The shared run-status wording (core/format.js), the same on Schedules.
const statusLabel = (status) => runStatus(status)[0];
const TRIGGERS = { scheduled: 'Scheduled', manual: 'Manual', dry: 'Dry run' };
const OTHER_VIEWS = ['pipeline', 'drafts', 'followups', 'agent', 'schedules', 'company', 'settings'];

/**
 * Serve a stand-in module for every other screen: an h1 with its name, and the query it was
 * opened with in window.__stub, so a test checks where Home sends the user without depending on
 * the real screens.
 */
async function stubViews(page) {
  await page.route(new RegExp(`/assets/js/views/(${OTHER_VIEWS.join('|')})\\.js$`), (route) => {
    const name = new URL(route.request().url()).pathname.match(/views\/(\w+)\.js$/)[1];
    route.fulfill({
      contentType: 'text/javascript; charset=utf-8',
      body: `export default { title: ${JSON.stringify(`Stub ${name}`)}, mount(root, ctx) {
        window.__stub = { name: ${JSON.stringify(name)}, path: ctx.path, query: ctx.query };
        const h1 = document.createElement('h1'); h1.textContent = ${JSON.stringify(`Stub ${name}`)};
        root.append(h1);
      } };`,
    });
  });
}

/** What the last stubbed screen was mounted with (null before any). */
const stubbed = (page) => page.evaluate(() => window.__stub ?? null);

/** Home is up with the seeded numbers in place. */
async function homeReady(page) {
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect(page.locator('.home-stats .home-stat-value').first()).toHaveText(fmtNum(SEED.counts.companies));
}

/** Does a click at the element's centre land on it (or inside it), not on something on top? */
const hitsItself = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || el.contains(hit);
  });
};

const needsYou = (page) => page.getByRole('region', { name: 'Needs you' });
const card = (page, name) => needsYou(page).getByRole('link', { name });
const refreshStore = (page) =>
  page.evaluate(async () => {
    const { store } = await import('/assets/js/core/store.js');
    await store.refresh();
  });

// Home's pure helpers, run here in Node (no browser, no server): the edges the seeded screens
// rarely reach.
test.describe('helpers', () => {
  const now = new Date(2026, 9, 28, 9, 0); // Oct 28, 09:00 local
  const at = (ms) => new Date(now.getTime() + ms);

  test('nextRunWhen: relative within 48h, then the date; a late timer is "any minute now"', () => {
    expect(nextRunWhen(null, now)).toBeNull();
    expect(nextRunWhen('not a date', now)).toBeNull();
    // Already due (the timer is late), or under a minute away.
    expect(nextRunWhen(at(-5 * 60_000).toISOString(), now).text).toBe('any minute now');
    expect(nextRunWhen(at(59_000).toISOString(), now).text).toBe('any minute now');
    expect(nextRunWhen(at(60_000).toISOString(), now).text).toBe('in 1m');
    // The summary's next_at is zone-less local time.
    const soon = at(5.5 * HOUR);
    expect(nextRunWhen(localIso(soon), now)).toEqual({
      text: 'in 5h',
      datetime: new Date(soon.getFullYear(), soon.getMonth(), soon.getDate(), soon.getHours(), soon.getMinutes()).toISOString(),
      title: fmtDate(soon, { time: true, now }),
    });
    // The 48h boundary: relative up to it, the date and time from it on.
    expect(nextRunWhen(at(48 * HOUR - 60_000).toISOString(), now).text).toBe('in 47h');
    expect(nextRunWhen(at(48 * HOUR).toISOString(), now).text).toBe(`on ${fmtDate(at(48 * HOUR), { time: true, now })}`);
  });

  test("runNote: a failed run's first non-blank line, the whole note for the tooltip", () => {
    expect(runNote({ status: 'error', note: '\n  Model retired.  \n\nPick another.' })).toEqual({
      line: 'Model retired.',
      full: 'Model retired.  \n\nPick another.',
    });
    expect(runNote({ status: 'auth_failed', note: 'not signed in' })).toEqual({ line: 'not signed in', full: 'not signed in' });
    // Nothing to say: an all-blank or missing note, or a run that worked or is still going.
    for (const r of [
      { status: 'error', note: ' \n\t\n ' },
      { status: 'error', note: null },
      { status: 'error' },
      { status: 'ok', note: 'x' },
      { status: 'running', note: 'x' },
      null,
    ]) {
      expect(runNote(r), JSON.stringify(r)).toBeNull();
    }
  });

  test('runKeys: one key per run that survives newer runs, unique when two runs share one', () => {
    const a = { started_at: '2026-10-27 09:00:00', chat_id: 'c1' };
    const b = { started_at: '2026-10-27 09:00:00', chat_id: null };
    expect(runKeys([a, b, { ...a }, { ...a }, {}])).toEqual([
      '2026-10-27 09:00:00|c1',
      '2026-10-27 09:00:00|',
      '2026-10-27 09:00:00|c1#1',
      '2026-10-27 09:00:00|c1#2',
      '|',
    ]);
    // A newer run on top leaves the keys of the runs below it as they were.
    const newer = { started_at: '2026-10-28 08:00:00', chat_id: 'c9' };
    expect(runKeys([newer, a, b]).slice(1)).toEqual(runKeys([a, b]));
  });

  test('searchesCaption: what the top-searches list leaves out', () => {
    expect(searchesCaption({ shown: 3, searches: 3, total: 40, found: 40 })).toBe('');
    expect(searchesCaption({ shown: 8, searches: 1200, total: 5000, found: 5000 })).toBe('Showing the top 8 of 1,200 searches.');
    expect(searchesCaption({ shown: 2, searches: 2, total: 41, found: 40 })).toBe('1 company has no search recorded.');
    expect(searchesCaption({ shown: 8, searches: 9, total: 2045, found: 45 })).toBe(
      'Showing the top 8 of 9 searches. 2,000 companies have no search recorded.',
    );
    // More found than the total (counts read a moment apart) is nothing to explain.
    expect(searchesCaption({ shown: 1, searches: 1, total: 4, found: 5 })).toBe('');
  });
});

test('numbers match the seed', async ({ app, page, server, request }) => {
  await app.goto('#/home');
  await homeReady(page);
  await expect(page).toHaveTitle('Home · coldtrail');
  await expect(page.locator('#nav [aria-current="page"] .nav-label')).toHaveText('Home');

  // Stat line: companies, contacts, sent, replies, reply rate (replies ÷ sent).
  const stats = page.getByRole('region', { name: 'At a glance' });
  await expect(stats.locator('.home-stat-label')).toHaveText(['Companies', 'Contacts', 'Sent', 'Replies', 'Reply rate']);
  await expect(stats.locator('.home-stat-value')).toHaveText([
    fmtNum(SEED.counts.companies),
    fmtNum(SEED.counts.contacts),
    fmtNum(SEED.counts.sent),
    fmtNum(SEED.counts.replied),
    pct(SEED.counts.replied, SEED.counts.sent),
  ]);

  // Needs you: the failed last run first (with why it failed, from its note), then drafts,
  // follow-ups due and replies.
  const runs = await (await request.get(server.apiUrl('/api/runs'))).json();
  const cards = needsYou(page).getByRole('link');
  await expect(cards).toHaveCount(4);
  const lastRun = SEED.runs.at(-1);
  expect(lastRun.status).toBe('error');
  expect(runs[0].note).toBeTruthy();
  await expect(cards.nth(0)).toContainText('Last run failed');
  await expect(cards.nth(0)).toContainText(`The last run (${lastRun.schedule_name}) ended with an error: ${runs[0].note}`);
  await expect(cards.nth(1).locator('.home-ny-num')).toHaveText(fmtNum(SEED.counts.drafts));
  await expect(cards.nth(1)).toContainText('drafts waiting');
  await expect(cards.nth(1)).toContainText(`${SEED.counts.drafts_email} email · ${SEED.counts.drafts_linkedin} LinkedIn`);
  await expect(cards.nth(2).locator('.home-ny-num')).toHaveText(fmtNum(SEED.counts.followups_due));
  await expect(cards.nth(2)).toContainText('follow-ups due');
  await expect(cards.nth(3).locator('.home-ny-num')).toHaveText(fmtNum(SEED.counts.replied));
  await expect(cards.nth(3)).toContainText('replies');
  expect(await cards.evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual([
    '#/schedules',
    '#/drafts',
    '#/followups?tab=due',
    '#/followups?tab=replied',
  ]);

  // Funnel: the five stages in order, companies per stage and the share of the stage before.
  const funnel = page.getByRole('table', { name: 'Funnel' });
  const fRows = funnel.locator('tbody tr');
  await expect(fRows).toHaveCount(5);
  await expect(fRows.locator('.home-funnel-stage')).toHaveText(STAGE_LABELS);
  await expect(fRows.locator('.home-funnel-count')).toHaveText(SEED.funnel.map(([, n]) => fmtNum(n)));
  await expect(fRows.locator('.home-funnel-rate')).toHaveText(
    SEED.funnel.map(([, n], i) => (i === 0 ? '' : pct(n, SEED.funnel[i - 1][1]))),
  );
  // Bars are relative to the companies sourced.
  const widths = await fRows.locator('.home-funnel-fill').evaluateAll((els) => els.map((e) => parseFloat(e.style.width)));
  expect(widths[0]).toBe(100);
  SEED.funnel.forEach(([, n], i) => expect(widths[i]).toBeCloseTo((n / SEED.funnel[0][1]) * 100, 1));

  // Recent runs: the last five, newest first, with status (and why a run failed), counts and a
  // link to the run.
  const expected = SEED.runs.slice().reverse().slice(0, 5);
  const runTable = page.getByRole('table', { name: 'Recent runs' });
  await expect(runTable.locator('th')).toHaveText(['Run', 'Trigger', 'Status', 'Sourced', 'Drafted', 'Sent', 'When', 'Conversation']);
  const rRows = runTable.locator('tbody tr');
  await expect(rRows).toHaveCount(expected.length);
  for (const [i, r] of expected.entries()) {
    const cells = rRows.nth(i).locator('td');
    // The seed's one run with no schedule is a manual one (a deleted schedule is its own test).
    if (!r.schedule_name) expect(r.trigger).toBe('manual');
    await expect(cells.nth(0).locator('.home-run-name')).toHaveText(r.schedule_name ?? 'Manual run');
    if (r.status === 'ok') await expect(cells.nth(0).locator('.home-run-note')).toHaveCount(0);
    else await expect(cells.nth(0).locator('.home-run-note')).toHaveText(`Why it failed: ${runs[i].note}`);
    await expect(cells.nth(1)).toHaveText(TRIGGERS[r.trigger]);
    await expect(cells.nth(2)).toHaveText(statusLabel(r.status));
    await expect(cells.nth(2).locator('.badge')).toHaveClass(new RegExp(`badge-${runStatus(r.status)[1]}`));
    await expect(cells.nth(3)).toHaveText(fmtNum(r.sourced));
    await expect(cells.nth(4)).toHaveText(fmtNum(r.drafted));
    await expect(cells.nth(5)).toHaveText(fmtNum(r.sent));
    await expect(cells.nth(6).locator('time')).toHaveText(fmtRelative(runs[i].started_at));
    await expect(cells.nth(6).locator('time')).toHaveAttribute('title', fmtDate(runs[i].started_at, { time: true }));
    if (r.chat_id) {
      await expect(cells.nth(7).getByRole('link', { name: 'View run' })).toHaveAttribute('href', `#/agent/${r.chat_id}`);
    } else {
      await expect(cells.nth(7).getByRole('link')).toHaveCount(0);
    }
  }
  await expect(page.getByRole('region', { name: 'Recent runs' }).getByRole('link', { name: 'All runs' })).toHaveAttribute('href', '#/schedules');

  // Top searches: every source query (at most 8), most companies first.
  const searches = page.getByRole('table', { name: 'Top searches' });
  const sRows = searches.locator('tbody tr');
  const top = SEED.queries.slice(0, 8);
  await expect(sRows).toHaveCount(top.length);
  await expect(sRows.locator('td:nth-child(1)')).toHaveText(top.map(([q]) => q));
  await expect(sRows.locator('td:nth-child(2)')).toHaveText(top.map(([, n]) => fmtNum(n)));
  await expect(sRows.locator('td:nth-child(3)')).toHaveText(top.map(([, n]) => pct(n, SEED.companies)));
  await expect(sRows.first().getByRole('link')).toHaveAttribute('href', `#/pipeline?query=${top[0][0]}`);
  // Every seeded company came from one of these searches: nothing to add under the table.
  await expect(page.getByRole('region', { name: 'Top searches' }).locator('.home-caption')).toHaveCount(0);

  // Every number on screen is data, so it is set in the mono face.
  const mono = await page.locator('.home-stats .home-stat-value').first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(mono).toMatch(/Geist Mono/);
});

test('needs-you links navigate', async ({ app, page }) => {
  await stubViews(page);
  await app.goto('#/home');
  await homeReady(page);

  await card(page, /drafts waiting/).click();
  await expect(page).toHaveURL(hashIs('#/drafts'));
  await expect(page.locator('#view h1')).toHaveText('Stub drafts');

  await page.goBack();
  await homeReady(page);
  await card(page, /follow-ups due/).click();
  await expect(page).toHaveURL(hashIs('#/followups?tab=due'));
  await expect(page.locator('#view h1')).toHaveText('Stub followups');
  await expect.poll(() => stubbed(page)).toMatchObject({ name: 'followups', query: { tab: 'due' } });

  await page.goBack();
  await homeReady(page);
  await card(page, /replies/).click();
  await expect(page).toHaveURL(hashIs('#/followups?tab=replied'));
  await expect.poll(() => stubbed(page)).toMatchObject({ name: 'followups', query: { tab: 'replied' } });

  await page.goBack();
  await homeReady(page);
  await card(page, /Last run failed/).click();
  await expect(page).toHaveURL(hashIs('#/schedules'));

  // Keyboard only: Tab reaches the cards in order (after the header action) and Enter opens one.
  await page.goBack();
  await homeReady(page);
  await page.locator('#view h1').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Ask the agent' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card(page, /Last run failed/)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card(page, /drafts waiting/)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(hashIs('#/drafts'));

  // The header action opens the agent.
  await page.goBack();
  await homeReady(page);
  await page.getByRole('link', { name: 'Ask the agent' }).click();
  await expect(page).toHaveURL(hashIs('#/agent'));
});

test('top search row opens filtered pipeline', async ({ app, page }) => {
  await stubViews(page);
  await app.goto('#/home');
  await homeReady(page);
  const searches = page.getByRole('table', { name: 'Top searches' });
  const sRows = searches.locator('tbody tr');
  await expect(sRows).toHaveCount(Math.min(8, SEED.queries.length));
  const [q2] = SEED.queries[1];

  // The rows open Pipeline without covering anything else. A link stretched over its row with
  // an absolute ::after needs a positioned <tr>, which WebKit doesn't support: there the last
  // row's link covered the whole page. So nothing in Home's tables is an overlay or a positioned
  // row, and a click on each control lands on that control.
  const overlays = await page.locator('#view .home').evaluate((home) =>
    [...home.querySelectorAll('table, table *')].flatMap((el) => {
      const found = [];
      if (el.tagName === 'TR' && getComputedStyle(el).position !== 'static') found.push(`positioned <tr> ${el.dataset.key}`);
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (!['none', 'normal'].includes(cs.content) && /absolute|fixed/.test(cs.position)) {
          found.push(`${el.tagName.toLowerCase()}.${el.className}${pseudo}`);
        }
      }
      return found;
    }),
  );
  expect(overlays).toEqual([]);
  for (const target of [
    page.getByRole('link', { name: 'Ask the agent' }),
    card(page, /drafts waiting/),
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Pipeline\b/ }),
    page.getByRole('region', { name: 'At a glance' }).locator('.home-stat').first(),
    page.getByRole('table', { name: 'Funnel' }).locator('tbody tr').first().locator('td').first(),
  ]) {
    expect(await hitsItself(target)).toBe(true);
  }
  for (let i = 0; i < (await sRows.count()); i++) {
    expect(await hitsItself(sRows.nth(i).locator('td').nth(1)), `search row ${i + 1}`).toBe(true);
  }

  // A click anywhere on the row opens Pipeline filtered by that search (a real mouse click on
  // the Companies cell, away from the search's link).
  const box = await sRows.nth(1).locator('td').nth(1).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(hashIs(`#/pipeline?query=${q2}`));
  await expect.poll(() => stubbed(page)).toEqual({ name: 'pipeline', path: ['pipeline'], query: { query: q2 } });

  // From the keyboard: one stop per row, the search's link (the rows themselves aren't stops),
  // then Enter.
  await page.goBack();
  await homeReady(page);
  const [q1] = SEED.queries[0];
  await expect(sRows.first()).not.toHaveAttribute('tabindex');
  await searches.getByRole('link', { name: q1, exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(searches.getByRole('link', { name: q2, exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(searches.getByRole('link', { name: q1, exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(hashIs(`#/pipeline?query=${q1}`));

  // The section's own link opens the whole pipeline.
  await page.goBack();
  await homeReady(page);
  await page.getByRole('region', { name: 'Top searches' }).getByRole('link', { name: 'Open pipeline' }).click();
  await expect(page).toHaveURL(hashIs('#/pipeline'));
});

test('shows loading states until each source answers', async ({ app, page }) => {
  const gates = {};
  const hold = (name) => {
    let open;
    gates[name] = new Promise((r) => (open = r));
    gates[name].open = open;
    return gates[name];
  };
  const runsGate = hold('runs');
  const companiesGate = hold('companies');
  const summaryGate = hold('summary');
  await page.route('**/api/runs*', async (route) => {
    await runsGate;
    await route.continue();
  });
  await page.route('**/api/companies?*', async (route) => {
    await companiesGate;
    await route.continue();
  });
  await page.route('**/api/summary*', async (route) => {
    await summaryGate;
    await route.continue();
  });
  await app.goto('#/home');
  await expect(page.locator('#view h1')).toHaveText('Home');

  // No summary yet: the summary sections are placeholders, marked busy.
  const busy = page.locator('#view [aria-busy="true"]');
  await expect(busy.first()).toBeVisible();
  await expect(page.locator('#view')).toContainText('Loading');
  await expect(page.locator('#view .skeleton').first()).toBeVisible();
  summaryGate.open();
  await homeReady(page);

  // Runs and searches still waiting: each says so in its own section.
  await expect(page.getByRole('region', { name: 'Recent runs' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('region', { name: 'Recent runs' })).toContainText('Loading recent runs');
  await expect(page.getByRole('region', { name: 'Top searches' })).toHaveAttribute('aria-busy', 'true');
  runsGate.open();
  await expect(page.getByRole('table', { name: 'Recent runs' }).locator('tbody tr')).toHaveCount(5);
  await expect(page.getByRole('region', { name: 'Recent runs' })).not.toHaveAttribute('aria-busy', 'true');
  companiesGate.open();
  await expect(page.getByRole('table', { name: 'Top searches' }).locator('tbody tr')).toHaveCount(8);
  await expect(busy).toHaveCount(0);
});

test('errors show in place with a retry', async ({ app, page }) => {
  // The browser logs each failed request as a console error.
  app.allowConsole(/status of 500/);
  const fail = { summary: true, runs: true, companies: true };
  const failing = (key, message) => async (route) => {
    if (fail[key]) await route.fulfill({ status: 500, contentType: 'text/plain', body: message });
    else await route.continue();
  };
  await page.route('**/api/summary*', failing('summary', 'database is locked'));
  await page.route('**/api/runs*', failing('runs', 'no such table: scheduled_runs'));
  await page.route('**/api/companies?*', failing('companies', 'Invalid column type Null'));
  await app.goto('#/home');
  await expect(page.locator('#view h1')).toHaveText('Home');

  const summaryErr = page.locator('#view .home-error').filter({ hasText: "Couldn't load your workspace summary" });
  await expect(summaryErr).toBeVisible();
  await expect(summaryErr).toContainText('database is locked');
  await expect(summaryErr).toHaveAttribute('role', 'alert');

  fail.summary = false;
  await summaryErr.getByRole('button', { name: 'Try again' }).click();
  await homeReady(page);

  // Runs and searches failed on their own; the rest of Home is fine.
  const runs = page.getByRole('region', { name: 'Recent runs' });
  const searches = page.getByRole('region', { name: 'Top searches' });
  await expect(runs).toContainText("Couldn't load recent runs");
  await expect(runs).toContainText('no such table: scheduled_runs');
  await expect(searches).toContainText("Couldn't load top searches");
  await expect(searches).toContainText('Invalid column type Null');
  await expect(page.getByRole('table', { name: 'Funnel' })).toBeVisible();

  // Wide, the retry sits on the right; on a phone it drops under the text, lined up with it
  // (not under the icon).
  const retry = runs.getByRole('button', { name: 'Try again' });
  const errTitle = runs.locator('.home-error-title');
  const titleBox = await errTitle.boundingBox();
  expect((await retry.boundingBox()).x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => Math.round((await retry.boundingBox()).x - (await errTitle.boundingBox()).x)).toBe(0);
  await page.setViewportSize({ width: 1440, height: 900 });

  fail.runs = false;
  await runs.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('table', { name: 'Recent runs' }).locator('tbody tr')).toHaveCount(5);
  await expect(searches).toContainText("Couldn't load top searches");

  fail.companies = false;
  await searches.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('table', { name: 'Top searches' }).locator('tbody tr')).toHaveCount(8);
  // Focus stays in the section that was retried, on something that still exists.
  await expect(page.getByRole('heading', { name: 'Top searches' })).toBeFocused();
  await expect(page.locator('#view .home-error')).toHaveCount(0);
});

test('a stale session points to the terminal; the banner says the rest once', async ({ app, page }) => {
  app.allowConsole(/status of 401/);
  await page.route('**/api/runs*', (route) => route.fulfill({ status: 401, contentType: 'text/plain', body: 'unauthorized' }));
  await app.goto('#/home');
  await homeReady(page);

  const runs = page.getByRole('region', { name: 'Recent runs' });
  const err = runs.locator('.home-error');
  await expect(err).toContainText("Couldn't load recent runs");
  await expect(err.locator('.home-error-detail')).toHaveText(SESSION_REOPEN);
  // The full sentence is the shell's banner, said once, not repeated in the section.
  await expect(page.locator('.session-banner')).toHaveText(SESSION_EXPIRED);
  await expect(page.getByText(SESSION_EXPIRED)).toHaveCount(1);
});

test('quiet and edge states: nothing needs you, no runs, no sends', async ({ app, page }) => {
  await page.route('**/api/summary*', async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    s.counts = { ...s.counts, drafts: 0, drafts_email: 0, drafts_linkedin: 0, followups_due: 0, replied: 0, sent: 0 };
    s.attention = [];
    s.last_run = null;
    s.next_schedule = null;
    await route.fulfill({ response: res, json: s });
  });
  await page.route('**/api/runs*', (route) => route.fulfill({ json: [] }));
  await app.goto('#/home');
  await expect(page.locator('#view h1')).toHaveText('Home');

  await expect(needsYou(page)).toContainText('Nothing needs you right now');
  await expect(needsYou(page).getByRole('link')).toHaveCount(0);
  // Nothing sent: the reply rate is a dash, not 0% or NaN.
  await expect(page.locator('.home-stats .home-stat-value').nth(4)).toHaveText('—');
  const runs = page.getByRole('region', { name: 'Recent runs' });
  await expect(runs).toContainText('No runs yet');
  await expect(runs.getByRole('link', { name: 'Create a schedule' })).toHaveAttribute('href', '#/schedules');
});

test('a run with no schedule name says why', async ({ app, page }) => {
  // /api/runs gives no schedule name both for a run nobody scheduled and for one whose schedule
  // was deleted since; the trigger tells them apart.
  const cases = [
    { trigger: 'scheduled', name: 'Deleted schedule', triggerText: TRIGGERS.scheduled },
    { trigger: 'manual', name: 'Manual run', triggerText: TRIGGERS.manual },
    { trigger: 'dry', name: 'Manual run', triggerText: TRIGGERS.dry },
    { trigger: null, name: 'No schedule', triggerText: '—' },
  ];
  await page.route('**/api/runs*', async (route) => {
    const res = await route.fetch();
    const runs = await res.json();
    cases.forEach((c, i) => Object.assign(runs[i], { trigger: c.trigger, schedule_name: null }));
    await route.fulfill({ response: res, json: runs });
  });
  await app.goto('#/home');
  await homeReady(page);
  const rows = page.getByRole('table', { name: 'Recent runs' }).locator('tbody tr');
  await expect(rows).toHaveCount(5);
  for (const [i, c] of cases.entries()) {
    await expect(rows.nth(i).locator('.home-run-name')).toHaveText(c.name);
    await expect(rows.nth(i).locator('.home-run-name')).toHaveClass(/is-muted/);
    await expect(rows.nth(i).locator('td').nth(1)).toHaveText(c.triggerText);
  }
  // The fifth keeps its schedule's name.
  await expect(rows.nth(4).locator('.home-run-name')).toHaveText(SEED.runs.slice().reverse()[4].schedule_name);
  await expect(rows.nth(4).locator('.home-run-name')).not.toHaveClass(/is-muted/);
});

test('hostile text from the server renders as text', async ({ app, page }) => {
  const evil = '<img src=x onerror=window.__xss=1>';
  await page.route('**/api/summary*', async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    s.attention = [
      { kind: 'linkedin_reconnect', message: `${evil} signed out`, target: 'javascript:window.__xss=2' },
      ...s.attention,
    ];
    await route.fulfill({ response: res, json: s });
  });
  await page.route('**/api/runs*', async (route) => {
    const res = await route.fetch();
    const runs = await res.json();
    runs[0].schedule_name = evil;
    runs[0].status = '<b>odd</b>';
    runs[0].note = `${evil} broke\n<script>window.__xss=4</script>`;
    runs[1].chat_id = '../../x"><img src=x onerror=window.__xss=3>';
    await route.fulfill({ response: res, json: runs });
  });
  await page.route('**/api/companies?*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.queries = [[evil, 7], [null, 3], ...body.queries];
    await route.fulfill({ response: res, json: body });
  });
  await app.goto('#/home');
  await homeReady(page);

  const warn = card(page, /LinkedIn signed out/);
  await expect(warn).toContainText(`${evil} signed out`);
  // A target that isn't an app route never becomes the link.
  await expect(warn).toHaveAttribute('href', '#/settings?tab=connections');
  const runRow = page.getByRole('table', { name: 'Recent runs' }).locator('tbody tr').first();
  await expect(runRow.locator('.home-run-name')).toHaveText(evil);
  // A status the app doesn't know shows as it is, in a neutral badge; its note is text too.
  await expect(runRow.locator('td').nth(2)).toHaveText('<b>odd</b>');
  await expect(runRow.locator('.badge')).toHaveClass(/badge-neutral/);
  await expect(runRow.locator('.home-run-note')).toHaveText(`Why it failed: ${evil} broke`);
  await expect(runRow.locator('.home-run-note')).toHaveAttribute('title', `${evil} broke\n<script>window.__xss=4</script>`);
  const viewLink = page.getByRole('table', { name: 'Recent runs' }).locator('tbody tr').nth(1).getByRole('link', { name: 'View run' });
  await expect(viewLink).toHaveAttribute('href', `#/agent/${encodeURIComponent('../../x"><img src=x onerror=window.__xss=3>')}`);
  const searches = page.getByRole('table', { name: 'Top searches' });
  await expect(searches.getByRole('link', { name: evil })).toHaveAttribute('href', `#/pipeline?query=${encodeURIComponent(evil)}`);
  // A company sourced outside any search has nothing to filter by: text, not a link, and the
  // row doesn't open anything.
  const noSearch = searches.locator('tbody tr').nth(1);
  await expect(noSearch).toContainText('No search recorded');
  await expect(noSearch.getByRole('link')).toHaveCount(0);
  await expect(noSearch).not.toHaveClass(/is-clickable/);
  await noSearch.locator('td').nth(1).click();
  await expect(page).toHaveURL(hashIs('#/home'));
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect(page.locator('#view img, #view script, #view b')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('updates live from the store and stops when you leave', async ({ app, page }) => {
  await stubViews(page);
  let patch = null;
  await page.route('**/api/summary*', async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    if (patch) {
      s.counts = { ...s.counts, ...patch.counts };
      s.last_run = { ...s.last_run, started_at: patch.started_at };
    }
    await route.fulfill({ response: res, json: s });
  });
  // The page's clock runs as usual until the test moves it on (to age the store's numbers).
  await page.clock.install();
  // Count /api/runs and /api/summary fetches in the page: a subscriber's fetch starts
  // synchronously inside store.refresh(), so the counts are exact once refresh() resolves.
  await page.addInitScript(() => {
    window.__fetches = { runs: 0, summary: 0 };
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/runs')) window.__fetches.runs++;
      if (url.includes('/api/summary')) window.__fetches.summary++;
      return realFetch(input, init);
    };
  });
  const fetches = () => page.evaluate(() => ({ ...window.__fetches }));
  // The store's test hook: a view that forgets to unsubscribe shows up as one too many.
  const subscribers = () =>
    page.evaluate(async () => (await import('/assets/js/core/store.js')).store.subscriberCount());
  await app.goto('#/home');
  await homeReady(page);
  await expect(page.getByRole('table', { name: 'Recent runs' }).locator('tbody tr')).toHaveCount(5);
  // A cold load asks for the summary once: Home shows what the store fetched just before it.
  expect(await fetches()).toEqual({ runs: 1, summary: 1 });

  // A store refresh with new numbers and a newer run updates the cards and refetches the runs.
  patch = { counts: { drafts: 99, drafts_email: 59 }, started_at: '2026-10-27 09:00:00' };
  await refreshStore(page);
  await expect(card(page, /drafts waiting/).locator('.home-ny-num')).toHaveText('99');
  await expect(card(page, /drafts waiting/)).toContainText(`59 email · ${SEED.counts.drafts_linkedin} LinkedIn`);
  expect((await fetches()).runs).toBe(2);

  // A refresh that changes nothing keeps the focused card focused.
  await card(page, /drafts waiting/).focus();
  await refreshStore(page);
  await expect(card(page, /drafts waiting/)).toBeFocused();

  // Leave Home: it unsubscribes, and later store updates no longer reach it (no refetch, no
  // errors).
  const withHome = await subscribers();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Pipeline\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Stub pipeline');
  await expect.poll(subscribers).toBe(withHome - 1);
  patch = { counts: { drafts: 7 }, started_at: '2026-10-27 10:00:00' };
  await refreshStore(page);
  await expect(page.locator('#view h1')).toHaveText('Stub pipeline');
  await expect(page.locator('#view .home')).toHaveCount(0);
  expect((await fetches()).runs).toBe(2);

  // Come back once the store's numbers are no longer fresh (store.fetchedAt() is more than
  // FRESH_MS ago): Home shows them at once, asks for new ones, and subscribes once again.
  const before = await fetches();
  await page.clock.fastForward(FRESH_MS + 1000);
  await page.goBack();
  await homeReady(page);
  await expect(card(page, /drafts waiting/).locator('.home-ny-num')).toHaveText('7');
  await expect.poll(async () => (await fetches()).summary).toBe(before.summary + 1);
  expect(await subscribers()).toBe(withHome);
});

test('home is accessible in light and dark, and fits a phone', async ({ app, page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await app.goto('#/home');
  await homeReady(page);
  await expect(page.getByRole('table', { name: 'Top searches' }).locator('tbody tr')).toHaveCount(8);
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);

  // The three count cards stay on one row down to the narrowest content area above the phone
  // breakpoint (a 900px window, where the sidebar still shows; and 700px, where it doesn't).
  const countCards = needsYou(page).locator('.home-ny-list > li');
  await expect(countCards).toHaveCount(3);
  for (const width of [900, 700]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => countCards.evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size), `${width}px`)
      .toBe(1);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await homeReady(page);
  // A phone stacks them.
  await expect.poll(() => countCards.evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().left))).size)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // On a phone the eight run columns don't fit, so each run is a card with the same facts and
  // its link on screen: nothing in Home scrolls sideways inside its box.
  const recent = page.getByRole('region', { name: 'Recent runs' });
  await expect(recent.getByRole('table')).toHaveCount(0);
  const list = recent.getByRole('list', { name: 'Recent runs' });
  const cards = list.getByRole('listitem');
  const expected = SEED.runs.slice().reverse().slice(0, 5);
  const listBox = await list.boundingBox();
  await expect(cards).toHaveCount(expected.length);
  for (const [i, r] of expected.entries()) {
    const c = cards.nth(i);
    await expect(c).toContainText(r.schedule_name ?? 'Manual run');
    await expect(c).toContainText(statusLabel(r.status));
    await expect(c).toContainText(TRIGGERS[r.trigger]);
    await expect(c).toContainText(`${fmtNum(r.sourced)} sourced · ${fmtNum(r.drafted)} drafted · ${fmtNum(r.sent)} sent`);
    const link = c.getByRole('link', { name: /^View run/ });
    if (r.chat_id) {
      await expect(link).toHaveAttribute('href', `#/agent/${r.chat_id}`);
      // Inside the card list's box (not scrolled or clipped away) and inside the window.
      const box = await link.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(listBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(Math.min(390, listBox.x + listBox.width));
    } else {
      await expect(link).toHaveCount(0);
    }
  }
  const sideways = await page.locator('#view .home').evaluate((home) =>
    [...home.querySelectorAll('.table-wrap, .home-run-cards')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.closest('section')?.getAttribute('aria-labelledby')),
  );
  expect(sideways).toEqual([]);
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expectAccessible(page);

  // Back to a wide window: the table returns.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(recent.getByRole('table', { name: 'Recent runs' }).locator('tbody tr')).toHaveCount(expected.length);
  await expect(recent.getByRole('list', { name: 'Recent runs' })).toHaveCount(0);
});

test('failed runs say why, in the table and on a phone', async ({ app, page }) => {
  const why = 'Model anthropic/claude-3-opus has been deprecated.';
  const more = 'Pick another model in Settings.';
  await page.route('**/api/runs*', async (route) => {
    const res = await route.fetch();
    const runs = await res.json();
    runs[0].note = `\n${why}\n${more}`; // the seed's newest run failed ('error')
    Object.assign(runs[1], { status: 'auth_failed', note: 'opencode: not signed in' });
    Object.assign(runs[2], { status: 'ok', note: 'a note on a run that worked' });
    await route.fulfill({ response: res, json: runs });
  });
  await app.goto('#/home');
  await homeReady(page);
  const rows = page.getByRole('table', { name: 'Recent runs' }).locator('tbody tr');
  await expect(rows).toHaveCount(5);

  // Under the run's name: the note's first line (screen readers hear what it is), the whole
  // note on hover.
  const note = rows.nth(0).locator('.home-run-note');
  await expect(note).toHaveText(`Why it failed: ${why}`);
  await expect(note).toHaveAttribute('title', `${why}\n${more}`);
  await expect(rows.nth(0).locator('.badge')).toHaveText('Failed');
  // A sign-in failure, in the shared wording and tone (Schedules says it the same way).
  await expect(rows.nth(1).locator('.home-run-note')).toHaveText('Why it failed: opencode: not signed in');
  await expect(rows.nth(1).locator('.badge')).toHaveText('Sign-in failed');
  await expect(rows.nth(1).locator('.badge')).toHaveClass(/badge-warn/);
  // A run that worked shows no note.
  await expect(rows.nth(2).locator('.home-run-note')).toHaveCount(0);
  await expect(rows.nth(2).locator('.badge')).toHaveText('Succeeded');

  // On a phone each card says it too.
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = page.getByRole('list', { name: 'Recent runs' }).getByRole('listitem');
  await expect(cards.nth(0).locator('.home-run-card-note')).toHaveText(`Why it failed: ${why}`);
  await expect(cards.nth(1).locator('.home-run-card-note')).toHaveText('Why it failed: opencode: not signed in');
  await expect(cards.nth(2).locator('.home-run-card-note')).toHaveCount(0);
});

test('recent runs never scroll sideways: a table where it fits, else cards', async ({ app, page }) => {
  const long = 'A schedule name long enough to need more room than the run column has to give it';
  await page.route('**/api/runs*', async (route) => {
    const res = await route.fetch();
    const runs = await res.json();
    runs[0].schedule_name = long;
    runs[0].note = 'word '.repeat(80);
    await route.fulfill({ response: res, json: runs });
  });
  // Chromium reports a ResizeObserver loop (a redraw inside the observer that resizes what it
  // observes) only as a window 'error' event, never to the console, so the app fixture can't see
  // it: collect those here.
  await page.addInitScript(() => {
    window.__windowErrors = [];
    window.addEventListener('error', (e) => window.__windowErrors.push(String(e.message)));
  });
  await app.goto('#/home');
  await homeReady(page);
  const recent = page.getByRole('region', { name: 'Recent runs' });
  const sideways = () =>
    recent.evaluate((s) => [...s.querySelectorAll('.table-wrap, .home-run-cards')].filter((el) => el.scrollWidth > el.clientWidth + 1).length);
  // The section's width decides, not the window's: from 900px up the sidebar takes 232px, so a
  // 1024px window leaves less room than an 899px one.
  for (const [width, shape] of [
    [1440, 'table'],
    [1280, 'table'],
    [1024, 'cards'],
    [899, 'table'],
    [760, 'cards'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    if (shape === 'table') {
      await expect(recent.getByRole('table', { name: 'Recent runs' })).toBeVisible();
      await expect(recent.getByRole('list', { name: 'Recent runs' })).toHaveCount(0);
      // The long name is cut short in place, with the full name as its tooltip.
      const name = recent.locator('tbody tr').first().locator('.home-run-name');
      await expect(name).toHaveAttribute('title', long);
      expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth), `${width}px: name ellipsized`).toBe(true);
    } else {
      await expect(recent.getByRole('list', { name: 'Recent runs' })).toBeVisible();
      await expect(recent.getByRole('table')).toHaveCount(0);
    }
    await expect.poll(sideways, `${width}px: nothing scrolls sideways`).toBe(0);
    // The run's link is on screen, inside the section.
    const link = recent.getByRole('link', { name: /^View run/ });
    const [lb, sb] = [await link.boundingBox(), await recent.boundingBox()];
    expect(lb.x + lb.width, `${width}px: link inside the section`).toBeLessThanOrEqual(sb.x + sb.width + 0.5);
  }
  // Swapping table and cards changes the section's height; that happens a frame after the
  // observer fires, so no switch is a ResizeObserver loop.
  expect(await page.evaluate(() => window.__windowErrors)).toEqual([]);
});

test('a focused run link keeps focus when a newer run arrives', async ({ app, page }) => {
  let newer = null;
  await page.route('**/api/runs*', async (route) => {
    const res = await route.fetch();
    const runs = await res.json();
    await route.fulfill({ response: res, json: newer ? [newer, ...runs] : runs });
  });
  await page.route('**/api/summary*', async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    if (newer) s.last_run = { ...s.last_run, started_at: newer.started_at, status: newer.status };
    await route.fulfill({ response: res, json: s });
  });
  await app.goto('#/home');
  await homeReady(page);
  const rows = page.getByRole('table', { name: 'Recent runs' }).locator('tbody tr');
  await expect(rows).toHaveCount(5);
  const at = SEED.runs.slice().reverse().findIndex((r) => r.chat_id);
  expect(at).toBeGreaterThanOrEqual(0);
  await rows.nth(at).getByRole('link', { name: /^View run/ }).focus();

  // A run newer than all of them pushes every row down one; the same run's link keeps focus.
  newer = { started_at: sqliteUtc(new Date()), status: 'ok', sourced: 3, enriched: 1, drafted: 1, sent: 0, chat_id: null, trigger: 'manual', schedule_name: null, note: null };
  await refreshStore(page);
  await expect(rows.first().locator('.home-run-name')).toHaveText('Manual run');
  await expect(rows.nth(at + 1).getByRole('link', { name: /^View run/ })).toBeFocused();
});

test('with no runs yet, says when the next schedule runs', async ({ app, page }) => {
  // 5½ hours away: "in 5h" (relative within 48h, as the top bar's chip says it).
  const at = localIso(new Date(Date.now() + 5.5 * HOUR));
  await page.route('**/api/summary*', async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    s.next_schedule = { id: 'x', name: 'Lunch <b>Source</b>', next_at: at };
    await route.fulfill({ response: res, json: s });
  });
  await page.route('**/api/runs*', (route) => route.fulfill({ json: [] }));
  await app.goto('#/home');
  await homeReady(page);
  const runs = page.getByRole('region', { name: 'Recent runs' });
  await expect(runs.getByRole('heading', { name: 'No runs yet', level: 3 })).toBeVisible();
  await expect(runs).toContainText('Lunch <b>Source</b> runs next in 5h. What it adds shows up here.');
  await expect(runs.locator('time')).toHaveAttribute('title', fmtDate(at, { time: true }));
  await expect(runs.getByRole('link', { name: 'Open Schedules' })).toHaveAttribute('href', '#/schedules');
});

test('top searches say what the list leaves out, and few cards share the row', async ({ app, page }) => {
  const unlisted = 45;
  const extra = [
    ['Q9', 20],
    ['Q10', 10],
  ];
  await page.route('**/api/companies?*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.queries = [...body.queries, ...extra];
    body.total += 30 + unlisted; // the two extra searches, and companies no search found
    await route.fulfill({ response: res, json: body });
  });
  // Only drafts wait on the human: one card, as wide as the row (no empty columns beside it).
  await page.route('**/api/summary*', async (route) => {
    const res = await route.fetch();
    const s = await res.json();
    s.counts = { ...s.counts, followups_due: 0, replied: 0 };
    s.attention = [];
    await route.fulfill({ response: res, json: s });
  });
  await app.goto('#/home');
  await homeReady(page);

  const top = page.getByRole('region', { name: 'Top searches' });
  const total = SEED.companies + 30 + unlisted;
  await expect(top.locator('tbody tr')).toHaveCount(8);
  await expect(top.locator('.home-caption')).toHaveText(
    `Showing the top 8 of ${SEED.queries.length + extra.length} searches. ${unlisted} companies have no search recorded.`,
  );
  await expect(top.locator('tbody tr').first().locator('td').nth(2)).toHaveText(pct(SEED.queries[0][1], total));

  const list = needsYou(page).getByRole('list');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  const [cardBox, listBox] = [await card(page, /drafts waiting/).boundingBox(), await list.boundingBox()];
  expect(Math.abs(cardBox.width - listBox.width)).toBeLessThanOrEqual(1);
});

// Last: a different seed restarts the server.
test.describe('new workspace', () => {
  test.use({ seed: 'onboarded' });

  test('empty workspace shows getting started', async ({ app, page }) => {
    await stubViews(page);
    await app.goto('#/home');
    await expect(page.locator('#view h1')).toHaveText('Home');
    const start = page.getByRole('region', { name: 'Get started' });
    await expect(start).toBeVisible();
    const steps = start.getByRole('listitem');
    await expect(steps.locator('h3')).toHaveText([
      'Find companies with the agent',
      'Review drafts',
      'Create a schedule',
      'Connect where outreach goes',
    ]);
    // No dashboard for an empty workspace.
    await expect(page.getByRole('region', { name: 'At a glance' })).toHaveCount(0);
    await expect(page.getByRole('table')).toHaveCount(0);

    const actions = start.getByRole('link');
    expect(await actions.evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual([
      expect.stringMatching(/^#\/agent\?prompt=.+/),
      '#/drafts',
      '#/schedules',
      '#/settings?tab=connections',
    ]);
    // The actions line up as one column: the same width, the same left edge.
    const boxes = await actions.evaluateAll((els) => els.map((a) => a.getBoundingClientRect()).map((r) => [Math.round(r.left), Math.round(r.width)]));
    expect(new Set(boxes.map(String)).size, JSON.stringify(boxes)).toBe(1);
    // The agent step opens Agent with a starter prompt to send (it is never sent for you).
    await actions.first().click();
    await expect(page.locator('#view h1')).toHaveText('Stub agent');
    await expect.poll(() => stubbed(page)).toMatchObject({ name: 'agent', query: { prompt: expect.stringMatching(/^Find \d+ companies/) } });

    await page.goBack();
    await expect(start).toBeVisible();
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(start).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expectAccessible(page);
  });

  test('a connected destination and a schedule mark their steps', async ({ app, page }) => {
    await page.route('**/api/status*', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), destination_connected: true } });
    });
    let nextAt = localIso(new Date(Date.now() + 5.5 * HOUR));
    await page.route('**/api/summary*', async (route) => {
      const res = await route.fetch();
      const s = await res.json();
      s.next_schedule = { id: 'x', name: 'Morning <b>Source</b>', next_at: nextAt };
      await route.fulfill({ response: res, json: s });
    });
    await app.goto('#/home');
    const start = page.getByRole('region', { name: 'Get started' });
    await expect(start.getByRole('listitem')).toHaveCount(3);
    await expect(start).not.toContainText('Connect where outreach goes');
    const schedule = start.getByRole('listitem').nth(2);
    await expect(schedule).toContainText('Done');
    // Within 48h the time is relative (spec §5.10), with the date and time as its tooltip.
    await expect(schedule.locator('p')).toHaveText('Morning <b>Source</b> runs next in 5h.');
    await expect(schedule.locator('time')).toHaveAttribute('title', fmtDate(nextAt, { time: true }));

    // Further out it is the date and time.
    nextAt = localIso(new Date(Date.now() + 4 * 24 * HOUR));
    await refreshStore(page);
    await expect(schedule.locator('p')).toHaveText(`Morning <b>Source</b> runs next on ${fmtDate(nextAt, { time: true })}.`);
  });
});

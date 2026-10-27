// The app shell (spec §4) and the shared components every screen builds on: grouped sidebar with
// live counts and connection dots, hash routing with back/forward, ⌘K search, the schedule chip,
// theme, the phone-width menu, the stale-session banner, and the redirect into setup for a new
// workspace. The views here are still placeholders; Phase 3 replaces them.
import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { COMPANIES, SEED } from '../harness/seed.mjs';
import { SESSION_EXPIRED } from '../../../ui/js/core/api.js';
import { fmtDate, fmtNum } from '../../../ui/js/core/format.js';

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashIs = (hash) => new RegExp(`${reEscape(hash)}$`);

/** The shell is up: the first view mounted and the store's first summary landed. */
async function shellReady(page) {
  await expect(page.locator('#view h1')).toBeVisible();
  await expect(page.locator('#nav .nav-count:not([hidden])').first()).toBeVisible();
}

/**
 * Mount components into a #sandbox box inside #view: `build(box)` runs in the page (it is
 * serialized, so it can only use its own scope and `import()` the component modules) and can
 * record callbacks in `window.__calls`.
 */
async function sandbox(page, build) {
  await expect(page.locator('#view h1')).toBeVisible(); // the router has mounted the screen
  await page.evaluate(() => {
    document.getElementById('sandbox')?.remove();
    const box = document.createElement('div');
    box.id = 'sandbox';
    document.getElementById('view').append(box);
    window.__calls = [];
  });
  await page.evaluate(`(${build.toString()})(document.getElementById('sandbox'))`);
}

const calls = (page) => page.evaluate(() => window.__calls);

test('nav shows grouped items with seeded counts', async ({ app, page }) => {
  await app.goto('#/home');
  await shellReady(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const groups = nav.locator('.nav-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).locator('.nav-group-label')).toHaveText('Workspace');
  await expect(groups.nth(0).locator('.nav-label')).toHaveText([
    'Home', 'Pipeline', 'Drafts', 'Follow-ups', 'Agent', 'Schedules',
  ]);
  await expect(groups.nth(1).locator('.nav-group-label')).toHaveText('Setup');
  await expect(groups.nth(1).locator('.nav-label')).toHaveText(['Company profile', 'Settings']);

  const link = (name) => nav.getByRole('link', { name: new RegExp(`^${reEscape(name)}\\b`) });
  await expect(link('Pipeline').locator('.nav-count')).toHaveText(fmtNum(SEED.counts.companies));
  await expect(link('Drafts').locator('.nav-count')).toHaveText(fmtNum(SEED.counts.drafts));
  await expect(link('Drafts').locator('.nav-count')).toHaveClass(/nav-count-strong/);
  await expect(link('Follow-ups').locator('.nav-count')).toHaveText(fmtNum(SEED.counts.followups_due));
  await expect(link('Home').locator('.nav-count')).toHaveCount(0);
  await expect(link('Home')).toHaveAttribute('aria-current', 'page');
  await expect(link('Pipeline')).not.toHaveAttribute('aria-current', /.*/);
  // Counts are read out with what they count, not as bare numbers.
  await expect(link('Drafts')).toHaveAccessibleName(`Drafts, ${SEED.counts.drafts} waiting`);

  // Connection dots: label + state word, each linking to its Settings tab.
  const conns = page.locator('#nav .conn');
  await expect(conns.locator('.conn-label')).toHaveText(['Agent · opencode', 'Canonical', 'Gmail', 'LinkedIn']);
  expect(await conns.evaluateAll((els) => els.map((a) => [a.getAttribute('href'), a.dataset.state]))).toEqual([
    ['#/settings?tab=agent', 'ok'],
    ['#/settings?tab=connections', 'ok'],
    ['#/settings?tab=connections', 'none'],
    ['#/settings?tab=connections', 'none'],
  ]);
  // Colour is never the only signal: a state that isn't fine says so in words.
  await expect(conns.nth(2).locator('.conn-state')).toHaveText('Connect');
  await expect(conns.nth(0)).toHaveAccessibleName('Agent · opencode: ready');
});

test('connection dots turn amber for problems only the human can fix', async ({ app, page }) => {
  await page.route('**/api/status*', async (route) => {
    const res = await route.fetch();
    const status = await res.json();
    status.linkedin_connected = true;
    status.linkedin_reconnect_needed = true;
    status.agents = status.agents.map((a) => (a.kind === 'opencode' ? { ...a, present: false } : a));
    await route.fulfill({ response: res, json: status });
  });
  await app.goto('#/home');
  await shellReady(page);
  const conns = page.locator('#nav .conn');
  await expect(conns.nth(0)).toHaveAttribute('data-state', 'warn');
  await expect(conns.nth(0).locator('.conn-state')).toHaveText('Not installed');
  await expect(conns.nth(3)).toHaveAttribute('data-state', 'warn');
  await expect(conns.nth(3).locator('.conn-state')).toHaveText('Reconnect');
});

test('deep link #/pipeline loads Pipeline and back/forward works', async ({ app, page }) => {
  await app.goto('#/pipeline');
  const h1 = page.locator('#view h1');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const current = nav.locator('[aria-current="page"] .nav-label');
  await expect(h1).toHaveText('Pipeline');
  await expect(page).toHaveTitle('Pipeline · coldtrail');
  await expect(current).toHaveText('Pipeline');
  // The token left the address bar but the route stayed.
  expect(new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).hash).toBe('#/pipeline');

  await nav.getByRole('link', { name: /^Drafts\b/ }).click();
  await expect(page).toHaveURL(hashIs('#/drafts'));
  await expect(h1).toHaveText('Drafts');
  await expect(current).toHaveText('Drafts');

  await page.goBack();
  await expect(page).toHaveURL(hashIs('#/pipeline'));
  await expect(h1).toHaveText('Pipeline');
  await expect(current).toHaveText('Pipeline');

  await page.goForward();
  await expect(page).toHaveURL(hashIs('#/drafts'));
  await expect(h1).toHaveText('Drafts');

  // Refresh keeps the screen; an item route highlights its section.
  await page.goto(page.url().replace(/#.*$/, '#/pipeline/acme.example?q=a%20b'));
  await expect(h1).toHaveText('Pipeline');
  await expect(current).toHaveText('Pipeline');
  await page.reload();
  await expect(h1).toHaveText('Pipeline');

  // Every section has a screen at its route.
  const routes = {
    home: 'Home', pipeline: 'Pipeline', drafts: 'Drafts', followups: 'Follow-ups', agent: 'Agent',
    schedules: 'Schedules', company: 'Company profile', settings: 'Settings',
  };
  for (const [route, title] of Object.entries(routes)) {
    await page.evaluate((r) => { location.hash = `#/${r}`; }, route);
    await expect(h1).toHaveText(title);
    await expect(page).toHaveTitle(`${title} · coldtrail`);
  }

  // Unknown routes land on Home and say so in the address bar.
  await page.evaluate(() => { location.hash = '#/nowhere'; });
  await expect(page).toHaveURL(hashIs('#/home'));
  await expect(h1).toHaveText('Home');
});

test('⌘K focuses search and results navigate to a company', async ({ app, page }) => {
  await app.goto('#/home');
  await shellReady(page);
  const search = page.getByRole('combobox', { name: 'Search' });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute('aria-expanded', 'false');

  // A company with an email draft: it shows up as a company and as a draft.
  const draft = SEED.emailDrafts.find((d) => d.domain !== SEED.xss.domain);
  await search.fill(draft.domain);
  const companies = page.getByRole('group', { name: 'Companies' });
  const drafts = page.getByRole('group', { name: 'Drafts' });
  await expect(companies.getByRole('option').first()).toContainText(draft.name);
  await expect(companies.getByRole('option').first()).toContainText(draft.domain);
  await expect(drafts.getByRole('option').first()).toContainText(draft.domain);
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  // The first result is active, so Enter opens it.
  await expect(search).toHaveAttribute('aria-activedescendant', /.+/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(hashIs(`#/pipeline/${draft.domain}`));
  await expect(page.locator('#view h1')).toHaveText('Pipeline');
  await expect(search).toHaveAttribute('aria-expanded', 'false');

  // Arrow keys move through the groups; a click on a draft opens Drafts.
  await page.keyboard.press('ControlOrMeta+k');
  await search.fill(draft.domain);
  await expect(drafts.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', /.+/);
  await drafts.getByRole('option').first().click();
  await expect(page).toHaveURL(hashIs(`#/drafts/${draft.domain}`));

  // People: a contact's name finds their company (a name only one contact has).
  const nameCount = new Map();
  for (const k of COMPANIES.flatMap((c) => c.contacts)) {
    nameCount.set(k.founder_name, (nameCount.get(k.founder_name) || 0) + 1);
  }
  const person = COMPANIES.find(
    (c) =>
      c.contacts.length === 1 &&
      c.contacts[0].email &&
      nameCount.get(c.contacts[0].founder_name) === 1 &&
      !c.name.includes('<'),
  );
  const founder = person.contacts[0].founder_name;
  await page.keyboard.press('ControlOrMeta+k');
  await search.fill(founder);
  const people = page.getByRole('group', { name: 'People' });
  await expect(people.getByRole('option').filter({ hasText: person.domain })).toContainText(founder);

  // Enter straight after changing the query opens a result for the new query, not a stale one.
  await search.fill(draft.domain);
  await expect(companies.getByRole('option').first()).toContainText(draft.domain);
  await search.fill(person.domain);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(hashIs(`#/pipeline/${person.domain}`));

  // Esc closes the results; nothing matches shows a plain message.
  await page.keyboard.press('ControlOrMeta+k');
  await search.fill(founder);
  await expect(people.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('option')).toHaveCount(0);
  await search.fill('zzzz-no-such-company');
  await expect(page.locator('.search-status')).toHaveText('No matches for “zzzz-no-such-company”');

  // Hostile names in results are text.
  await search.fill(SEED.xss.domain);
  await expect(companies.getByRole('option').first()).toContainText(SEED.xss.name);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('schedule chip shows next Lunch Source run', async ({ app, page, server, request }) => {
  const summary = await (await request.get(server.apiUrl('/api/summary'))).json();
  expect(summary.next_schedule.name).toBe(SEED.schedules.lunch.name);
  await app.goto('#/home');
  const chip = page.locator('#topbar .chip');
  await expect(chip).toHaveText(/^Lunch Source · next (in \d+[mh]|.+)$/);
  await expect(chip).toHaveAttribute('href', '#/schedules');
  await expect(chip).toHaveAttribute('title', `Next run ${fmtDate(summary.next_schedule.next_at, { time: true })}`);
  await chip.click();
  await expect(page).toHaveURL(hashIs('#/schedules'));
});

test('schedule chip shows a running run, or that nothing is scheduled', async ({ app, page }) => {
  let patch = { running: { chat_id: SEED.chats.scheduled.id, title: SEED.chats.scheduled.title } };
  await page.route('**/api/summary*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), ...patch } });
  });
  await app.goto('#/home');
  const chip = page.locator('#topbar .chip');
  await expect(chip).toHaveText(`Running · ${SEED.chats.scheduled.title}`);
  await expect(chip).toHaveAttribute('href', `#/agent/${SEED.chats.scheduled.id}`);
  await expect(chip.locator('.chip-dot')).toHaveClass(/is-live/);

  patch = { running: null, next_schedule: null };
  await page.reload();
  await expect(chip).toHaveText('No schedule');
  await expect(chip).toHaveAttribute('href', '#/schedules');
});

test('theme follows system then persists Light/Dark', async ({ app, page }) => {
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await app.goto('#/home');
  await shellReady(page);
  expect(await theme()).toBeNull();
  await expect.poll(bg).toBe('rgb(15, 16, 18)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(bg).toBe('rgb(250, 250, 249)');

  await page.evaluate(() => localStorage.setItem('ct-theme', 'dark'));
  await page.reload();
  await shellReady(page);
  expect(await theme()).toBe('dark');
  await expect.poll(bg).toBe('rgb(15, 16, 18)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => localStorage.setItem('ct-theme', 'light'));
  await page.reload();
  await shellReady(page);
  expect(await theme()).toBe('light');
  await expect.poll(bg).toBe('rgb(250, 250, 249)');
  await page.evaluate(() => localStorage.removeItem('ct-theme'));
});

test('phone width: menu button opens nav, no horizontal scroll', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.goto('#/home');
  await expect(page.locator('#view h1')).toHaveText('Home');
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();
  expect(await noSideScroll()).toBeLessThanOrEqual(390);

  await menu.click();
  await expect(nav).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  const focusInNav = () => page.evaluate(() => document.getElementById('nav').contains(document.activeElement));
  await expect.poll(focusInNav).toBe(true);
  // Tab stays inside the open menu.
  for (let i = 0; i < 16; i++) await page.keyboard.press('Tab');
  expect(await focusInNav()).toBe(true);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Tab');
  expect(await focusInNav()).toBe(true);
  expect(await noSideScroll()).toBeLessThanOrEqual(390);

  // Esc closes it and gives focus back to the button.
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');

  // Picking a screen closes it.
  await menu.click();
  await nav.getByRole('link', { name: /^Pipeline\b/ }).click();
  await expect(page).toHaveURL(hashIs('#/pipeline'));
  await expect(page.locator('#view h1')).toHaveText('Pipeline');
  await expect(nav).toBeHidden();

  // The backdrop closes it too.
  await menu.click();
  await expect(nav).toBeVisible();
  await page.mouse.click(380, 400);
  await expect(nav).toBeHidden();

  // Search and the schedule chip fit; results fit.
  await page.getByRole('combobox', { name: 'Search' }).fill(SEED.emailDrafts[1].domain);
  await expect(page.getByRole('option').first()).toBeVisible();
  expect(await noSideScroll()).toBeLessThanOrEqual(390);
  await expectAccessible(page);
});

test('stale token shows session banner', async ({ app, page }) => {
  // The 401s the stale tab gets are logged by the browser as failed resources.
  app.allowConsole(/401|Unauthorized/i);
  await app.goto('#/home');
  await shellReady(page);
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.context().clearCookies();
  await page.reload();
  const banner = page.locator('.session-banner');
  await expect(banner).toHaveText(SESSION_EXPIRED);
  await expect(banner).toHaveAttribute('role', 'alert');
  // Once, however many calls fail and wherever the user goes.
  await page.evaluate(() => { location.hash = '#/drafts'; });
  await expect(page.locator('#view h1')).toHaveText('Drafts');
  await page.evaluate(async () => {
    const { store } = await import('/assets/js/core/store.js');
    await store.refresh();
  });
  await expect(banner).toHaveCount(1);
  await expect(banner).toHaveText(SESSION_EXPIRED);
});

test('shell is accessible', async ({ app, page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await app.goto('#/home');
  await shellReady(page);
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);

  // With the search results open, in both themes.
  await page.getByRole('combobox', { name: 'Search' }).fill(SEED.emailDrafts[1].domain);
  await expect(page.getByRole('option').first()).toBeVisible();
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expectAccessible(page);
});

test.describe('components', () => {
  test('table renders text, opens rows with Enter or click, and shows an empty state', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { table } = await import('/assets/js/components/table.js');
      box.append(table({
        label: 'Companies',
        columns: [
          { key: 'name', label: 'Company' },
          { key: 'n', label: 'Contacts', align: 'right', nowrap: true, render: (r) => String(r.n) },
          { key: 'go', label: 'Actions', render: (r) => {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = 'Skip ' + r.id;
            b.addEventListener('click', () => window.__calls.push('button ' + r.id));
            return b;
          } },
        ],
        rows: [{ id: 'a', name: '<img src=x onerror=window.__xss=1>', n: 3 }, { id: 'b', name: 'Beta', n: 5 }],
        rowKey: 'id',
        onRowClick: (row) => window.__calls.push('row ' + row.id),
      }));
      const empty = table({ columns: [{ key: 'x', label: 'X' }], rows: [], rowKey: 'x', empty: 'Nothing here yet' });
      empty.id = 'empty-table';
      box.append(empty);
    });
    const t = page.locator('#sandbox .table-wrap').first();
    await expect(t.locator('th')).toHaveText(['Company', 'Contacts', 'Actions']);
    await expect(t.locator('th').nth(0)).toHaveAttribute('scope', 'col');
    await expect(t.locator('tbody tr').nth(0).locator('td').nth(0)).toHaveText('<img src=x onerror=window.__xss=1>');
    await expect(t.locator('tbody tr').nth(0)).toHaveAttribute('data-key', 'a');
    await expect(t.locator('td').nth(1)).toHaveClass(/align-right/);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await t.locator('tbody tr').nth(1).focus();
    await page.keyboard.press('Enter');
    await t.locator('tbody tr').nth(0).click();
    // A control inside the row does its own job only.
    await t.getByRole('button', { name: 'Skip b' }).click();
    expect(await calls(page)).toEqual(['row b', 'row a', 'button b']);
    await expect(page.locator('#empty-table td')).toHaveText('Nothing here yet');
  });

  test('tabs move with arrow keys and report the change', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { tabs } = await import('/assets/js/components/tabs.js');
      box.append(tabs({
        label: 'Channel',
        items: [{ id: 'all', label: 'All', count: 1200 }, { id: 'email', label: 'Email', count: 12 }, { id: 'li', label: 'LinkedIn' }],
        active: 'all',
        onChange: (id) => window.__calls.push(id),
      }));
    });
    const list = page.getByRole('tablist', { name: 'Channel' });
    const tab = (name) => list.getByRole('tab', { name: new RegExp(`^${name}`) });
    await expect(tab('All')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('All').locator('.tab-count')).toHaveText('1,200');
    await expect(tab('Email')).toHaveAttribute('tabindex', '-1');
    await tab('All').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab('Email')).toBeFocused();
    await expect(tab('Email')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('All')).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('End');
    await expect(tab('LinkedIn')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tab('All')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tab('LinkedIn')).toBeFocused();
    await tab('Email').click();
    // Re-clicking the active tab is not a change.
    await tab('Email').click();
    expect(await calls(page)).toEqual(['email', 'li', 'all', 'li', 'email']);
  });

  test('switch toggles, waits, and reverts when the change fails', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { switchEl } = await import('/assets/js/components/switch.js');
      box.append(switchEl({
        checked: false,
        label: 'Auto-send email',
        description: 'Sends up to 20 emails a day without asking.',
        onChange: async (on) => {
          window.__calls.push(on);
          await new Promise((r) => setTimeout(r, 150));
          if (window.__mode === 'fail') throw new Error('Could not save the setting');
          if (window.__mode === 'cancel') return false;
        },
      }));
    });
    const sw = page.getByRole('switch', { name: 'Auto-send email' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(sw).toHaveAccessibleDescription('Sends up to 20 emails a day without asking.');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(sw).toHaveAttribute('aria-busy', 'true');
    await expect(sw).not.toHaveAttribute('aria-busy', 'true');

    await page.evaluate(() => { window.__mode = 'fail'; });
    await sw.click();
    await expect(page.locator('.toast-err')).toContainText('Could not save the setting');
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    await page.evaluate(() => { window.__mode = 'cancel'; });
    await page.getByText('Auto-send email').click(); // the label toggles it too
    await expect(sw).not.toHaveAttribute('aria-busy', 'true');
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    await page.evaluate(() => { window.__mode = ''; });
    await sw.focus();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(await calls(page)).toEqual([true, false, false, false]);
  });

  test('pager states the range and moves pages', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { pager } = await import('/assets/js/components/pager.js');
      const p = pager({ page: 1, per: 50, total: 6131, onChange: (n) => { window.__calls.push(n); p.update({ page: n, per: 50, total: 6131 }); } });
      box.append(p);
      window.__pager = p;
    });
    const pg = page.locator('#sandbox .pager');
    const prev = pg.getByRole('button', { name: 'Previous page' });
    const next = pg.getByRole('button', { name: 'Next page' });
    await expect(pg.locator('.pager-range')).toHaveText('1–50 of 6,131');
    await expect(prev).toBeDisabled();
    await next.click();
    await expect(pg.locator('.pager-range')).toHaveText('51–100 of 6,131');
    await expect(next).toBeFocused();
    await prev.click();
    expect(await calls(page)).toEqual([2, 1]);
    await page.evaluate(() => window.__pager.update({ page: 123, per: 50, total: 6131 }));
    await expect(pg.locator('.pager-range')).toHaveText('6,101–6,131 of 6,131');
    await expect(next).toBeDisabled();
    await page.evaluate(() => window.__pager.update({ page: 1, per: 50, total: 0 }));
    await expect(pg.locator('.pager-range')).toHaveText('0 of 0');
    await expect(next).toBeDisabled();
    await expect(prev).toBeDisabled();
  });

  test('search select filters as you type and picks with the keyboard', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { searchSelect } = await import('/assets/js/components/searchSelect.js');
      box.append(searchSelect({
        label: 'Sourced by',
        placeholder: 'All sources',
        value: '',
        options: [
          { value: 'Q1', label: 'fintech founders in Berlin', count: 400 },
          { value: 'Q2', label: 'health startups', count: 200 },
          { value: 'Q3', label: '<b>robotics</b>', count: 5 },
        ],
        onChange: (v) => window.__calls.push(v),
      }));
      const free = searchSelect({ label: 'Model', value: 'fake/model-a', freeText: true,
        options: [{ value: 'fake/model-a', label: 'fake/model-a' }], onChange: (v) => window.__calls.push(v) });
      free.id = 'free';
      window.__free = free;
      box.append(free);
    });
    const box = page.getByRole('combobox', { name: 'Sourced by' });
    await expect(box).toHaveAttribute('placeholder', 'All sources');
    await box.click();
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    const listbox = page.getByRole('listbox', { name: 'Sourced by' });
    await expect(listbox.getByRole('option')).toHaveCount(3);
    await expect(listbox.getByRole('option').nth(0)).toContainText('400');
    await expect(listbox.getByRole('option').nth(2)).toContainText('<b>robotics</b>');
    await box.fill('HEAL');
    await expect(listbox.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('health startups');
    await expect(box).toHaveAttribute('aria-expanded', 'false');

    // Esc closes and puts back the chosen label.
    await box.fill('fin');
    await expect(listbox.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(box).toHaveAttribute('aria-expanded', 'false');
    await expect(box).toHaveValue('health startups');

    // Clicking an option picks it; Clear empties the choice.
    await box.click();
    await box.fill('');
    await listbox.getByRole('option', { name: /fintech/ }).click();
    await expect(box).toHaveValue('fintech founders in Berlin');
    await page.locator('#sandbox').getByRole('button', { name: 'Clear Sourced by' }).click();
    await expect(box).toHaveValue('');

    // Free text: Enter takes what was typed when nothing matches.
    const model = page.getByRole('combobox', { name: 'Model' });
    await expect(model).toHaveValue('fake/model-a');
    await model.fill('custom/model-z');
    // Options arriving late (the model list) leave what was typed alone.
    await page.evaluate(() =>
      window.__free.setOptions([{ value: 'fake/model-a' }, { value: 'fake/model-b' }]),
    );
    await expect(model).toHaveValue('custom/model-z');
    await page.keyboard.press('Enter');
    await expect(model).toHaveValue('custom/model-z');
    expect(await calls(page)).toEqual(['Q2', 'Q1', '', 'custom/model-z']);
  });

  test('list/detail, badge and empty state', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { listDetail } = await import('/assets/js/components/listDetail.js');
      const { badge } = await import('/assets/js/components/badge.js');
      const { emptyState } = await import('/assets/js/components/emptyState.js');
      const list = document.createElement('div'); list.textContent = 'the list'; list.id = 'ld-list';
      const detail = document.createElement('div'); detail.textContent = 'the detail'; detail.id = 'ld-detail';
      const ld = listDetail({ list, detail });
      window.__ld = ld;
      box.append(ld, badge('Sent', 'ok'), badge('<i>x</i>'),
        emptyState({ title: 'No drafts yet', body: 'Ask the agent to draft some.', action: { label: 'Open Agent', href: '#/agent' } }));
    });
    const sb = page.locator('#sandbox');
    await expect(sb.locator('.badge')).toHaveText(['Sent', '<i>x</i>']);
    await expect(sb.locator('.badge').nth(0)).toHaveClass(/badge-ok/);
    await expect(sb.locator('.badge').nth(1)).toHaveClass(/badge-neutral/);
    await expect(sb.locator('.empty-state')).toContainText('No drafts yet');
    await expect(sb.getByRole('link', { name: 'Open Agent' })).toHaveAttribute('href', '#/agent');

    const top = (id) => page.locator(id).evaluate((el) => el.getBoundingClientRect().top);
    const left = (id) => page.locator(id).evaluate((el) => el.getBoundingClientRect().left);
    // Wide: side by side.
    expect(await top('#ld-list')).toBe(await top('#ld-detail'));
    expect(await left('#ld-list')).toBeLessThan(await left('#ld-detail'));
    // Narrow, with a selection: stacked, detail first.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.__ld.setSelected(true));
    expect(await top('#ld-detail')).toBeLessThan(await top('#ld-list'));
    await page.evaluate(() => window.__ld.setSelected(false));
    expect(await top('#ld-list')).toBeLessThan(await top('#ld-detail'));
  });

  test('components are accessible in light and dark', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('#/home');
    await shellReady(page);
    await sandbox(page, async (box) => {
      const c = (n) => import('/assets/js/components/' + n + '.js');
      const [{ table }, { tabs }, { switchEl }, { pager }, { searchSelect }, { badge }, { emptyState }, { listDetail }] =
        await Promise.all(['table', 'tabs', 'switch', 'pager', 'searchSelect', 'badge', 'emptyState', 'listDetail'].map(c));
      const rows = Array.from({ length: 4 }, (_, i) => ({ id: 'r' + i, name: 'Company ' + i, stage: ['ok', 'warn', 'danger', 'accent'][i] }));
      box.append(
        tabs({ label: 'Stage', items: [{ id: 'a', label: 'All', count: 4 }, { id: 'b', label: 'Sent', count: 1 }], active: 'a', onChange() {} }),
        searchSelect({ label: 'Sourced by', placeholder: 'All sources', options: [{ value: 'Q1', label: 'Q1', count: 3 }], value: '', onChange() {} }),
        table({ label: 'Companies', rowKey: 'id', rows, onRowClick() {}, columns: [
          { key: 'name', label: 'Company' },
          { key: 'stage', label: 'Stage', render: (r) => badge(r.stage, r.stage) },
        ] }),
        pager({ page: 1, per: 50, total: 120, onChange() {} }),
        switchEl({ checked: true, label: 'Auto-send', description: 'Sends without asking.', onChange() {} }),
        badge('Neutral'),
        listDetail({ list: document.createElement('div'), detail: document.createElement('div') }),
        emptyState({ title: 'Nothing yet', body: 'Run a schedule to fill this.' }),
      );
    });
    await expectAccessible(page);
    await page.getByRole('combobox', { name: 'Sourced by' }).click();
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page);
  });
});

// Last: a different seed restarts the server.
test.describe('empty workspace', () => {
  test.use({ seed: 'empty' });

  test('empty workspace redirects to setup', async ({ app, page }) => {
    await app.goto('#/pipeline');
    await expect(page).toHaveURL(hashIs('#/setup'));
    await expect(page.locator('#view h1')).toHaveText('Setup');
    // Setup is a full page: no sidebar, no top bar.
    await expect(page.locator('#nav')).toBeHidden();
    await expect(page.locator('#topbar')).toBeHidden();
    // Leaving setup before it's done comes back to it.
    await page.evaluate(() => { location.hash = '#/drafts'; });
    await expect(page).toHaveURL(hashIs('#/setup'));
    await expect(page.locator('#view h1')).toHaveText('Setup');
    await expectAccessible(page);
  });
});

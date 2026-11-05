// The app shell (spec §4) and the shared components every screen builds on: grouped sidebar with
// live counts and connection dots, hash routing with back/forward, ⌘K search, the schedule chip,
// theme, the phone-width menu, the stale-session banner, and the redirect into setup for a
// workspace that was never set up.
import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { COMPANIES, SEED } from '../harness/seed.mjs';
import { OFFLINE, OFFLINE_SHORT, SESSION_EXPIRED, SESSION_REOPEN } from '../../../ui/js/core/api.js';
import { fmtDate, fmtNum, fmtRelative } from '../../../ui/js/core/format.js';

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
  // The spoken name starts with the words on screen (WCAG 2.5.3, label in name).
  await expect(conns.nth(2)).toHaveAccessibleName('Gmail: Connect');
  await expect(conns.nth(1)).toHaveAccessibleName('Canonical: connected');
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
  await expect(conns.nth(0)).toHaveAccessibleName('Agent · opencode: Not installed');
  await expect(conns.nth(3)).toHaveAttribute('data-state', 'warn');
  await expect(conns.nth(3).locator('.conn-state')).toHaveText('Reconnect');
  await expect(conns.nth(3)).toHaveAccessibleName('LinkedIn: Reconnect');
});

test('connection link names start with their visible words', async ({ app, page }) => {
  await page.route('**/api/status*', async (route) => {
    const res = await route.fetch();
    const status = await res.json();
    status.agents = status.agents.map((a) => (a.kind === 'opencode' ? { ...a, present: true, authed: false } : a));
    await route.fulfill({ response: res, json: status });
  });
  await app.goto('#/home');
  await shellReady(page);
  const agent = page.locator('#nav .conn').nth(0);
  await expect(agent.locator('.conn-state')).toHaveText('Sign in');
  await expect(agent).toHaveAccessibleName('Agent · opencode: Sign in');
  await expect(agent).toHaveAttribute('title', 'Agent · opencode: Sign in');
});

test('connection links keep focus while the store refreshes them', async ({ app, page }) => {
  let gmail = false;
  await page.route('**/api/status*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), destination_connected: gmail } });
  });
  await app.goto('#/home');
  await shellReady(page);
  const refresh = () =>
    page.evaluate(async () => {
      const { store } = await import('/assets/js/core/store.js');
      await store.refresh();
    });
  const conns = page.locator('#nav .conn');
  const link = conns.nth(2);
  await expect(link).toHaveAccessibleName('Gmail: Connect');
  await link.focus();
  await page.evaluate(() => { window.__focused = document.activeElement; });

  // The state changes in place: the same link, still focused, says the new state.
  gmail = true;
  await refresh();
  await expect(link).toHaveAccessibleName('Gmail: connected');
  await expect(link).toHaveAttribute('data-state', 'ok');
  await expect(link).toHaveAttribute('title', 'Gmail: connected');
  await expect(link.locator('.conn-state')).toHaveText('');
  await expect(link).toBeFocused();
  expect(await page.evaluate(() => window.__focused === document.activeElement)).toBe(true);
  // Tab goes on from there, not from the first link.
  await page.keyboard.press('Tab');
  await expect(conns.nth(3)).toBeFocused();

  // Phone: focus stays inside the open menu, so Esc still closes it.
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await menu.click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await link.focus();
  gmail = false;
  await refresh();
  await expect(link).toHaveAccessibleName('Gmail: Connect');
  await expect(link.locator('.conn-state')).toHaveText('Connect');
  await expect(link).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  await expect(menu).toBeFocused();
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

  // Drafts opens its first draft (the seed has some), rewriting #/drafts to #/drafts/<domain>
  // in place once its list has loaded: wait for that before taking the address back and forth.
  await nav.getByRole('link', { name: /^Drafts\b/ }).click();
  await expect(page).toHaveURL(/#\/drafts\/[^/?#]+$/);
  await expect(h1).toHaveText('Drafts');
  await expect(current).toHaveText('Drafts');
  const draftsHash = new URL(page.url()).hash;

  await page.goBack();
  await expect(page).toHaveURL(hashIs('#/pipeline'));
  await expect(h1).toHaveText('Pipeline');
  await expect(current).toHaveText('Pipeline');

  await page.goForward();
  await expect(page).toHaveURL(hashIs(draftsHash));
  await expect(h1).toHaveText('Drafts');
  await expect(current).toHaveText('Drafts');

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

test('search finds a draft by the contact and company the Drafts list names it by', async ({ app, page, server, request }) => {
  const drafts = await (await request.get(server.apiUrl('/api/drafts'))).json();
  const named = (d) => d.contact_name && d.company_name && !/[<>]/.test(d.contact_name + d.company_name);
  const once = (d) => drafts.filter((x) => x.contact_name === d.contact_name).length === 1;
  const li = drafts.find((d) => d.channel === 'linkedin' && named(d) && once(d));
  const email = drafts.find((d) => d.channel === 'email' && named(d) && once(d));
  expect(li && email).toBeTruthy();
  await app.goto('#/home');
  await shellReady(page);
  const search = page.getByRole('combobox', { name: 'Search' });
  const found = page.getByRole('group', { name: 'Drafts' }).getByRole('option');

  // A LinkedIn note: by the person's full name, labelled as the list labels it.
  await search.fill(li.contact_name);
  await expect(found).toHaveCount(1);
  await expect(found.locator('.search-opt-name')).toHaveText(`${li.contact_name} · ${li.company_name}`);
  await expect(found.locator('.search-opt-meta')).toHaveText(`LinkedIn note · ${li.domain}`);

  // An email: by the company name too, with its subject.
  await search.fill(email.contact_name);
  await expect(found).toHaveCount(1);
  await expect(found.locator('.search-opt-name')).toHaveText(`${email.contact_name} · ${email.company_name}`);
  await expect(found.locator('.search-opt-meta')).toHaveText(`Email · ${email.domain} · ${email.subject}`);
  await search.fill(email.company_name);
  await expect(found.filter({ hasText: email.contact_name })).toHaveCount(1);
  await found.filter({ hasText: email.contact_name }).click();
  await expect(page).toHaveURL(hashIs(`#/drafts/${email.domain}`));
});

test('a draft result opens that draft when the company has an email and a LinkedIn note', async ({ app, page, server, request }) => {
  const drafts = await (await request.get(server.apiUrl('/api/drafts'))).json();
  const named = (d) => d.contact_name && d.company_name && !/[<>]/.test(d.contact_name + d.company_name);
  const email = drafts.find(
    (d) => d.channel === 'email' && d.status === 'draft_pending' && named(d) && !drafts.some((x) => x.domain === d.domain && x !== d),
  );
  expect(email).toBeTruthy();
  // The same company has a LinkedIn note waiting too, newer than the email.
  const note = { ...email, channel: 'linkedin', to: 'https://www.linkedin.com/in/lina-note', contact_name: 'Lina Note', subject: null, body: 'Hi Lina, a quick hello.' };
  await page.route('**/api/drafts', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: [note, ...(await res.json())] });
  });
  await app.goto('#/home');
  await shellReady(page);
  const search = page.getByRole('combobox', { name: 'Search' });
  const found = page.getByRole('group', { name: 'Drafts' }).getByRole('option');
  const detail = page.locator('.draft');
  const open = async (meta, channel, who, editor, other) => {
    await page.keyboard.press('ControlOrMeta+k');
    await search.fill(email.company_name);
    await expect(found).toHaveCount(2);
    await found.filter({ has: page.locator('.search-opt-meta', { hasText: meta }) }).click();
    await expect(page).toHaveURL(hashIs(`#/drafts/${email.domain}?channel=${channel}`));
    await expect(detail).toContainText(who);
    await expect(detail.getByRole('textbox', { name: editor })).toBeVisible();
    await expect(detail.getByRole('textbox', { name: other })).toHaveCount(0);
  };
  await open(/^Email · /, 'email', email.contact_name, 'Body', 'Connection note');
  await open(/^LinkedIn note/, 'linkedin', 'Lina Note', 'Connection note', 'Body');
});

test('schedule chip shows next Lunch Source run', async ({ app, page, server, request }) => {
  const summary = await (await request.get(server.apiUrl('/api/summary'))).json();
  expect(summary.next_schedule.name).toBe(SEED.schedules.lunch.name);
  await app.goto('#/home');
  const chip = page.locator('#topbar .chip');
  // "<name> · next <relative>": a daily run is always within 48h, so it counts down ("in 3h",
  // "in under a minute" in its last minute).
  await expect(chip).toHaveText(/^Lunch Source · next in (\d+[mh]|under a minute)$/);
  const text = await chip.textContent();
  const now = Date.now();
  const nextAt = summary.next_schedule.next_at;
  // Rendered a moment ago: allow a minute or hour boundary in between.
  const expected = [-120, -60, 0, 60].map((s) => `Lunch Source · next ${fmtRelative(nextAt, new Date(now + s * 1000))}`);
  expect(expected).toContain(text);
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

test('on a phone the schedule chip says when, and the search hint fits', async ({ app, page, server, request }) => {
  const summary = await (await request.get(server.apiUrl('/api/summary'))).json();
  const name = summary.next_schedule.name;
  await page.setViewportSize({ width: 390, height: 844 });
  await app.goto('#/home');
  const chip = page.locator('#topbar .chip');
  const search = page.getByRole('combobox', { name: 'Search' });
  await expect(chip).toHaveText(/^Next in (\d+[mh]|under a minute)$/);
  const shown = await chip.textContent();
  await expect(chip).toHaveAttribute('aria-label', `${shown} · ${name}`);
  // Nothing cut off: the time is what the chip is for.
  const cut = (loc) => loc.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(await cut(chip.locator('.chip-text'))).toBe(false);
  await expect(search).toHaveAttribute('placeholder', 'Search');
  const hintFits = await search.evaluate((el) => {
    const ctx = document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return ctx.measureText(el.placeholder).width <= el.clientWidth;
  });
  expect(hintFits).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // Wider, it names the schedule again.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(chip).toHaveText(new RegExp(`^${reEscape(name)} · next `));
  expect(await chip.getAttribute('aria-label')).toBeNull();
  await expect(search).toHaveAttribute('placeholder', 'Search companies, people, drafts');
});

test('a pinned theme is on the page before the app code runs', async ({ app, page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await app.goto('#/home');
  await shellReady(page);
  await page.evaluate(() => localStorage.setItem('ct-theme', 'dark'));
  // Hold main.js: what is on screen meanwhile is the first paint.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/assets/js/main.js', async (route) => {
    await held;
    await route.continue();
  });
  await page.reload({ waitUntil: 'commit' });
  await expect.poll(() => page.evaluate(() => document.readyState !== 'loading' && !!document.body)).toBe(true);
  expect(await page.evaluate(() => document.getElementById('nav').childElementCount)).toBe(0); // the app hasn't run
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 16, 18)');
  release();
  await shellReady(page);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  await page.evaluate(() => localStorage.removeItem('ct-theme'));
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
  // The search, like every screen, only points the way: the banner says it in full, once.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('acme');
  await expect(page.locator('.search-status')).toHaveText(SESSION_REOPEN);
  await expect(page.getByText(SESSION_EXPIRED)).toHaveCount(1);
});

test('the stale-session banner goes once the tab works again', async ({ app, page, server }) => {
  app.allowConsole(/401|Unauthorized/i);
  await app.goto('#/home');
  await shellReady(page);
  await page.context().clearCookies();
  await page.reload();
  const banner = page.locator('.session-banner');
  await expect(banner).toHaveText(SESSION_EXPIRED);
  // coldtrail reopened from the terminal in another tab: the shared cookie is good again.
  const url = new URL(server.base);
  await page.context().addCookies([{ name: 'ct_token', value: server.token, domain: url.hostname, path: '/' }]);
  await page.evaluate(async () => {
    const { store } = await import('/assets/js/core/store.js');
    await store.refresh();
  });
  await expect(banner).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Drafts\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Drafts');
  // And a later stale session is told again.
  await page.context().clearCookies();
  await page.evaluate(async () => {
    const { store } = await import('/assets/js/core/store.js');
    await store.refresh();
  });
  await expect(banner).toHaveText(SESSION_EXPIRED);
  await expect(banner).toHaveCount(1);
});

test('with coldtrail not answering, one banner says so and screens say it plainly', async ({ app, page }) => {
  // The browser logs each refused request.
  app.allowConsole(/ERR_CONNECTION_REFUSED|Failed to load resource/);
  await app.goto('#/home');
  await shellReady(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  // Load Follow-ups once, so only its data is missing later.
  await nav.getByRole('link', { name: /^Follow-ups\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Follow-ups');
  await nav.getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');

  // As when its terminal was closed: every API request is refused.
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  const banner = page.locator('.session-banner');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search' }).fill('acme');
  await expect(page.locator('.search-status')).toHaveText(OFFLINE_SHORT);
  await expect(banner).toHaveText(OFFLINE);
  await expect(banner).toHaveAttribute('role', 'alert');
  await page.keyboard.press('Escape');
  await nav.getByRole('link', { name: /^Follow-ups\b/ }).click();
  await expect(page.locator('#view')).toContainText("Couldn't load follow-ups");
  await expect(page.locator('#view')).toContainText(OFFLINE_SHORT);
  await expect(page.locator('body')).not.toContainText(/Failed to fetch|NetworkError|Load failed/);
  await expect(banner).toHaveCount(1);

  // Back: the next answer takes the banner away.
  await page.unroute('**/api/**');
  await page.evaluate(async () => {
    const { store } = await import('/assets/js/core/store.js');
    await store.refresh();
  });
  await expect(banner).toHaveCount(0);
});

test('page shortcuts stay off while the phone menu covers the page', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.goto('#/drafts');
  await expect(page.getByRole('listbox', { name: 'Drafts' }).getByRole('option').first()).toBeVisible();
  await expect(page).toHaveURL(hashIs('#/drafts'));
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await menu.click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect(page).toHaveURL(hashIs('#/drafts'));
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  // ⌘K still works: it closes the menu and focuses the search.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused();
  // With the menu closed, J moves through the drafts again.
  await page.getByRole('combobox', { name: 'Search' }).blur();
  await page.keyboard.press('j');
  await expect(page).not.toHaveURL(hashIs('#/drafts'));
});

test('phone menu: a link to the screen on show closes the menu and keeps focus in view', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await app.goto('#/home');
  await expect(page.locator('#view h1')).toHaveText('Home');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  const h1 = page.locator('#view h1');

  // The wordmark, on Home.
  await menu.click();
  await page.locator('#nav .wordmark').click();
  await expect(nav).toBeHidden();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(h1).toBeFocused();
  // Home's own link.
  await menu.click();
  await nav.getByRole('link', { name: /^Home\b/ }).click();
  await expect(nav).toBeHidden();
  await expect(h1).toBeFocused();
  // A connection dot to the Settings tab on show.
  await page.evaluate(() => { location.hash = '#/settings?tab=connections'; });
  await expect(h1).toHaveText('Settings');
  await menu.click();
  await page.locator('#nav .conn').filter({ hasText: 'Gmail' }).click();
  await expect(nav).toBeHidden();
  await expect(h1).toBeFocused();
  // A new screen still takes focus on its heading.
  await menu.click();
  await nav.getByRole('link', { name: /^Drafts\b/ }).click();
  await expect(h1).toHaveText('Drafts');
  await expect(h1).toBeFocused();
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

test('⌘K from inside a drawer or dialog closes it and focuses search', async ({ app, page }) => {
  await app.goto('#/home');
  await shellReady(page);
  const search = page.getByRole('combobox', { name: 'Search' });
  for (const kind of ['drawer', 'dialog']) {
    await page.evaluate(async (k) => {
      const ui = await import('/assets/js/core/ui.js');
      if (k === 'drawer') ui.openDrawer({ title: 'Acme', content: 'Company details' });
      else ui.openDialog({ title: 'Send all?', content: 'Sends 12 emails.', actions: [{ label: 'Cancel' }] });
    }, kind);
    await expect(page.locator('[data-overlay]')).toHaveCount(1);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('[data-overlay]')).toHaveCount(0);
    await expect(search).toBeFocused();
    await search.blur();
  }

  // Setup hides the top bar: ⌘K has nothing to focus there, so it leaves the dialog (and the
  // browser's own shortcut) alone.
  await app.goto('#/setup');
  await expect(page.locator('#app')).toHaveAttribute('data-route', 'setup');
  await expect(page.locator('#view h1')).toBeVisible();
  await page.evaluate(async () => {
    const ui = await import('/assets/js/core/ui.js');
    ui.openDialog({ title: 'Skip this step?', content: 'You can finish it later.', actions: [{ label: 'Cancel' }] });
    window.__prevented = null;
    document.addEventListener('keydown', (e) => { if (e.key === 'k') setTimeout(() => { window.__prevented = e.defaultPrevented; }); });
  });
  await expect(page.locator('[data-overlay]')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+k');
  await expect.poll(() => page.evaluate(() => window.__prevented)).toBe(false);
  await expect(page.locator('[data-overlay]')).toHaveCount(1);
});

test('a screen that failed to load is tried again from its nav link', async ({ app, page }) => {
  app.allowConsole(/kaboom/);
  // Follow-ups whose mount fails until window.__ok is set.
  await page.route('**/assets/js/views/followups.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export default { title: 'Follow-ups', mount(root) {
        if (!window.__ok) throw new Error('kaboom');
        const h = document.createElement('h1'); h.textContent = 'Follow-ups'; root.append(h);
      } };`,
    }),
  );
  await app.goto('#/home');
  await shellReady(page);
  const link = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Follow-ups\b/ });
  await link.click();
  await expect(page.locator('#view h1')).toHaveText("This screen didn't load");
  await expect(page.locator('#view')).toContainText('kaboom');
  await page.evaluate(() => { window.__ok = true; });
  await link.click();
  await expect(page.locator('#view h1')).toHaveText('Follow-ups');
  await expect(page).toHaveURL(hashIs('#/followups'));
});

test('a screen whose code failed to download is fetched again, from its nav link or Reload', async ({ app, page }) => {
  // The browser logs the refused request; the router logs the failed import.
  app.allowConsole(/ERR_CONNECTION_REFUSED|Failed to load resource|dynamically imported module/);
  // The first download of each held screen is refused, as while coldtrail restarts.
  const asked = { followups: [], schedules: [] };
  for (const name of Object.keys(asked)) {
    await page.route(`**/assets/js/views/${name}.js*`, async (route) => {
      asked[name].push(new URL(route.request().url()).search);
      if (asked[name].length === 1) await route.abort('connectionrefused');
      else await route.continue();
    });
  }
  await app.goto('#/home');
  await shellReady(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const h1 = page.locator('#view h1');

  // The error says what to do, in words, and takes focus like any new screen.
  const link = nav.getByRole('link', { name: /^Follow-ups\b/ });
  await link.click();
  await expect(h1).toHaveText("This screen didn't load");
  await expect(h1).toBeFocused();
  await expect(page.locator('#view')).toContainText('Check that coldtrail is still running');
  await expect(page.locator('#view')).not.toContainText('dynamically imported module');
  // The nav link asks for it again (loading the page afresh: the failure sticks to its URL), and
  // it comes.
  await link.click();
  await expect(h1).toHaveText('Follow-ups');
  expect(asked.followups.length).toBe(2);
  // Leaving and coming back uses the copy that loaded.
  await nav.getByRole('link', { name: /^Drafts\b/ }).click();
  await expect(h1).toHaveText('Drafts');
  await link.click();
  await expect(h1).toHaveText('Follow-ups');
  expect(asked.followups.length).toBe(2);

  // Reload works too.
  await nav.getByRole('link', { name: /^Schedules\b/ }).click();
  await expect(h1).toHaveText("This screen didn't load");
  await page.locator('#view').getByRole('button', { name: 'Reload' }).click();
  await expect(h1).toHaveText('Schedules');
  await expect(page).toHaveURL(hashIs('#/schedules'));
  expect(asked.schedules).toEqual(['', '']);
});

test('a screen whose code failed to download breaks no screen that imports it', async ({ app, page }) => {
  app.allowConsole(/ERR_CONNECTION_REFUSED|Failed to load resource|dynamically imported module/);
  // Company profile's first download is refused. Settings imports Setup, which imports it.
  let asked = 0;
  await page.route('**/assets/js/views/company.js*', async (route) => {
    if (++asked === 1) await route.abort('connectionrefused');
    else await route.continue();
  });
  await app.goto('#/home');
  await shellReady(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const h1 = page.locator('#view h1');
  await nav.getByRole('link', { name: /^Company profile\b/ }).click();
  await expect(h1).toHaveText("This screen didn't load");
  await expect(page).toHaveTitle("This screen didn't load · coldtrail");

  // Settings hadn't loaded yet: it comes, and Company profile with it.
  await nav.getByRole('link', { name: /^Settings\b/ }).click();
  await expect(h1).toHaveText('Settings');
  await expect(page).toHaveTitle('Settings · coldtrail');
  await nav.getByRole('link', { name: /^Company profile\b/ }).click();
  await expect(h1).toHaveText('Company profile');
  // A connection dot goes to Settings in place now.
  await page.locator('#nav .conn').filter({ hasText: 'Gmail' }).click();
  await expect(h1).toHaveText('Settings');
  await expect(page).toHaveURL(hashIs('#/settings?tab=connections'));
  expect(asked).toBe(2);
});

/** Hold a view module's download until the returned release() is called, so its screen mounts
 *  late (as on a loaded machine). */
async function holdView(page, name) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(`**/assets/js/views/${name}.js`, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

test('a screen that mounts late leaves focus where the user moved it meanwhile', async ({ app, page }) => {
  const release = await holdView(page, 'followups');
  await app.goto('#/home');
  await shellReady(page);
  const search = page.getByRole('combobox', { name: 'Search' });
  const companies = page.getByRole('group', { name: 'Companies' });
  const draft = SEED.emailDrafts.find((d) => d.domain !== SEED.xss.domain);

  // Off to Follow-ups, whose module is held: Home stays on screen meanwhile.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Follow-ups\b/ }).click();
  await expect(page).toHaveURL(hashIs('#/followups'));
  await expect(page.locator('#view h1')).toHaveText('Home');

  // ⌘K and a search while it loads.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await search.fill(draft.domain);
  await expect(companies.getByRole('option').first()).toContainText(draft.domain);

  release();
  // The router decides about focus in the same task that mounts the screen, so once its heading
  // shows, any theft has already happened.
  await expect(page.locator('#view h1')).toHaveText('Follow-ups');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  await expect(search).toBeFocused();
  await expect(search).toHaveValue(draft.domain);
  await expect(search).toHaveAttribute('aria-expanded', 'true');
  await expect(companies.getByRole('option').first()).toBeVisible();

  // The results still work: Enter opens the company.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(hashIs(`#/pipeline/${draft.domain}`));
});

test('a new screen focuses its heading when the user left focus alone', async ({ app, page }) => {
  await app.goto('#/home');
  await shellReady(page);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // A plain navigation.
  await nav.getByRole('link', { name: /^Schedules\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Schedules');
  await expect(page.locator('#view h1')).toBeFocused();

  // A slow one, with focus left on the link that was clicked.
  const release = await holdView(page, 'company');
  const link = nav.getByRole('link', { name: 'Company profile' });
  await link.click();
  await expect(page).toHaveURL(hashIs('#/company'));
  await expect(link).toBeFocused();
  release();
  await expect(page.locator('#view h1')).toHaveText('Company profile');
  await expect(page.locator('#view h1')).toBeFocused();

  // A search result: choosing it leaves nothing focused, so the heading takes focus.
  const search = page.getByRole('combobox', { name: 'Search' });
  const draft = SEED.emailDrafts.find((d) => d.domain !== SEED.xss.domain);
  await page.keyboard.press('ControlOrMeta+k');
  await search.fill(draft.domain);
  const drafts = page.getByRole('group', { name: 'Drafts' });
  await drafts.getByRole('option').first().click();
  await expect(page).toHaveURL(hashIs(`#/drafts/${draft.domain}`));
  await expect(page.locator('#view h1')).toHaveText('Drafts');
  await expect(page.locator('#view h1')).toBeFocused();
});

test('the shell exports its wordmark for full-page screens', async ({ app, page }) => {
  await app.goto('#/home');
  await shellReady(page);
  const mark = await page.evaluate(async () => {
    const { wordmark } = await import('/assets/js/shell.js');
    const a = wordmark();
    return { tag: a.tagName, cls: a.className, href: a.getAttribute('href'), text: a.textContent, svg: !!a.querySelector('svg[aria-hidden="true"]') };
  });
  expect(mark).toEqual({ tag: 'A', cls: 'wordmark', href: '#/home', text: 'coldtrail', svg: true });
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
        // Pending until the test lets it go, so the wait is there to see however slow the machine.
        onChange: async (on) => {
          window.__calls.push(on);
          await new Promise((r) => { window.__release = r; });
          if (window.__mode === 'fail') throw new Error('Could not save the setting');
          if (window.__mode === 'cancel') return false;
        },
      }));
    });
    const release = () => page.evaluate(() => window.__release());
    const sw = page.getByRole('switch', { name: 'Auto-send email' });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(sw).toHaveAccessibleDescription('Sends up to 20 emails a day without asking.');
    // It flips at once and is busy until onChange settles.
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(sw).toHaveAttribute('aria-busy', 'true');
    await release();
    await expect(sw).not.toHaveAttribute('aria-busy', 'true');
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    // A failure puts it back and says why.
    await page.evaluate(() => { window.__mode = 'fail'; });
    await sw.click();
    await expect(sw).toHaveAttribute('aria-busy', 'true');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await release();
    await expect(page.locator('.toast-err')).toContainText('Could not save the setting');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(sw).not.toHaveAttribute('aria-busy', 'true');

    // Resolving to false puts it back quietly.
    await page.evaluate(() => { window.__mode = 'cancel'; });
    await page.getByText('Auto-send email').click(); // the label toggles it too
    await expect(sw).toHaveAttribute('aria-busy', 'true');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await release();
    await expect(sw).not.toHaveAttribute('aria-busy', 'true');
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    await page.evaluate(() => { window.__mode = ''; });
    await sw.focus();
    await page.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-busy', 'true');
    await release();
    await expect(sw).not.toHaveAttribute('aria-busy', 'true');
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

  test('search select keeps the highlighted option when its options are refreshed', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { searchSelect } = await import('/assets/js/components/searchSelect.js');
      const opts = (extra) => [
        { value: '', label: 'All sources', pinned: true },
        ...['Q1', 'Q2', 'Q3', 'Q4', ...extra].map((v, i) => ({ value: v, label: v, count: 100 - i })),
      ];
      window.__opts = opts;
      const el = searchSelect({ label: 'Sourced by', placeholder: 'All sources', value: '', options: opts([]), onChange: (v) => window.__calls.push(v) });
      window.__ss = el;
      box.append(el);
    });
    const box = page.getByRole('combobox', { name: 'Sourced by' });
    const active = () => box.evaluate((el) => document.getElementById(el.getAttribute('aria-activedescendant') || '')?.textContent ?? null);

    // Typed, then moved to Q3; a background refresh adds a source and changes the counts.
    await box.click();
    await box.fill('Q');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    expect(await active()).toMatch(/^Q3/);
    await page.evaluate(() => window.__ss.setOptions(window.__opts(['Q5'])));
    expect(await active()).toMatch(/^Q3/);
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    expect(await calls(page)).toEqual(['Q3']);

    // Opened with the arrow keys, nothing typed.
    await box.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await active()).toMatch(/^Q4/);
    await page.evaluate(() => window.__ss.setOptions(window.__opts(['Q5', 'Q6'])));
    expect(await active()).toMatch(/^Q4/);
    await page.keyboard.press('Enter');
    expect(await calls(page)).toEqual(['Q3', 'Q4']);

    // A highlighted option that went away leaves nothing highlighted (Enter then goes by what was typed).
    await box.fill('Q6');
    await page.keyboard.press('ArrowDown');
    expect(await active()).toMatch(/^Q6/);
    await page.evaluate(() => window.__ss.setOptions(window.__opts(['Q5'])));
    expect(await active()).toBeNull();
  });

  test('search select reads out "No matches" and the free-text hint', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { searchSelect } = await import('/assets/js/components/searchSelect.js');
      box.append(searchSelect({ label: 'Sourced by', value: '', options: [{ value: 'Q1', label: 'fintech' }], onChange() {} }));
      box.append(searchSelect({ label: 'Model', value: '', freeText: true, options: [{ value: 'fake/a' }], onChange() {} }));
    });
    const status = (name) => page.locator('#sandbox .search-select').filter({ has: page.getByRole('combobox', { name }) }).locator('[aria-live="polite"]');
    const source = page.getByRole('combobox', { name: 'Sourced by' });
    // The live region is there before anything is said, so the first message is heard.
    await expect(status('Sourced by')).toHaveText('');
    await source.fill('zzzz-nothing');
    await expect(status('Sourced by')).toHaveText('No matches');
    const described = await source.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    await expect(page.locator(`[id="${described}"]`)).toHaveText('No matches');
    await expect(page.locator(`[id="${described}"]`)).toBeVisible();
    await source.fill('fin');
    await expect(status('Sourced by')).toHaveText('');
    expect(await source.getAttribute('aria-describedby')).toBeNull();

    // A description the view gave the field stays, with the message beside it while it shows.
    const model = page.getByRole('combobox', { name: 'Model' });
    await model.evaluate((el) => el.setAttribute('aria-describedby', 'model-hint'));
    await model.fill('custom/x');
    await expect(status('Model')).toHaveText('Press Enter to use “custom/x”');
    await expect(model).toHaveAttribute('aria-describedby', /^\S+-empty model-hint$/);
    await page.keyboard.press('Escape');
    await expect(status('Model')).toHaveText('');
    await expect(model).toHaveAttribute('aria-describedby', 'model-hint');
    await expectAccessible(page);
  });

  test('the focus ring of a tab goes around its label and count, not through them', async ({ app, page }) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await app.goto('#/home');
      await sandbox(page, async (box) => {
        const { tabs } = await import('/assets/js/components/tabs.js');
        box.append(tabs({ label: 'Stage', items: ['All', 'Bounced', 'Skipped'].map((label, i) => ({ id: label, label, count: [1200, 2, 60][i] })), active: 'All', onChange() {} }));
      });
      const list = page.getByRole('tablist', { name: 'Stage' });
      const sandboxLeft = await page.locator('#sandbox').evaluate((el) => el.getBoundingClientRect().left);
      await list.getByRole('tab', { name: /^All/ }).focus();
      await page.keyboard.press('ArrowRight'); // keyboard focus: :focus-visible
      for (const name of ['Bounced', 'All']) {
        if (name === 'All') await page.keyboard.press('ArrowLeft');
        const tab = list.getByRole('tab', { name: new RegExp(`^${name}`) });
        await expect(tab).toBeFocused();
        const g = await tab.evaluate((b) => {
          const ring = getComputedStyle(b, '::after');
          const box = b.getBoundingClientRect();
          const l = b.parentElement.getBoundingClientRect();
          const text = [b.querySelector('.tab-label').getBoundingClientRect(), b.querySelector('.tab-count').getBoundingClientRect()];
          const inset = (v) => parseFloat(v);
          return {
            width: ring.borderTopWidth,
            color: ring.borderTopColor,
            // The ring's inner edges, and the text's extent.
            innerLeft: box.left + inset(ring.left) + parseFloat(ring.borderLeftWidth),
            innerRight: box.right - inset(ring.right) - parseFloat(ring.borderRightWidth),
            outerLeft: box.left + inset(ring.left),
            outerRight: box.right - inset(ring.right),
            textLeft: text[0].left,
            textRight: text[1].right,
            listLeft: l.left,
            labelLeft: text[0].left,
          };
        });
        expect(g.width).toBe('2px');
        expect(g.color).toBe('rgb(29, 78, 216)');
        expect(g.innerLeft, `${name} at ${width}: ring clear of the label`).toBeLessThanOrEqual(g.textLeft - 1);
        expect(g.innerRight, `${name} at ${width}: ring clear of the count`).toBeGreaterThanOrEqual(g.textRight + 1);
        expect(g.outerLeft, 'not clipped by the tablist').toBeGreaterThanOrEqual(g.listLeft - 0.5);
        if (name === 'All') expect(Math.abs(g.labelLeft - sandboxLeft), 'the first label stays in line with the content').toBeLessThanOrEqual(0.5);
      }
    }
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

  test('empty state takes a heading level; table rows can skip the tab stop and carry roles and cell classes', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { emptyState } = await import('/assets/js/components/emptyState.js');
      const { table } = await import('/assets/js/components/table.js');
      const inDrawer = emptyState({ title: 'No contacts yet', level: 3 });
      inDrawer.id = 'es-3';
      const plain = emptyState({ title: 'Nothing yet', level: 9 });
      plain.id = 'es-2';
      const t = table({
        label: 'Runs',
        rowKey: 'id',
        rowFocus: false,
        roles: true,
        cellClass: (col, row) => (row ? `c-${col.key}` : `h-${col.key}`),
        rows: [{ id: 'r1', name: 'Lunch Source' }],
        columns: [
          { key: 'name', label: 'Schedule' },
          { key: 'go', label: 'Open', render: (r) => {
            const a = document.createElement('a');
            a.href = '#/home?run=' + r.id;
            a.textContent = 'View run';
            return a;
          } },
        ],
        onRowClick: (row) => window.__calls.push('row ' + row.id),
      });
      t.id = 'tbl';
      box.append(inDrawer, plain, t);
    });
    await expect(page.locator('#es-3 h3.empty-title')).toHaveText('No contacts yet');
    await expect(page.locator('#es-2 h2.empty-title')).toHaveText('Nothing yet');
    const t = page.locator('#tbl');
    const row = t.locator('tbody tr');
    await expect(row).not.toHaveAttribute('tabindex', /.*/);
    await expect(row).toHaveClass(/is-clickable/);
    await row.locator('td').first().click();
    expect(await calls(page)).toEqual(['row r1']);
    // The link is the keyboard stop.
    await expect(row.getByRole('link', { name: 'View run' })).toHaveAttribute('href', '#/home?run=r1');
    await expect(t.locator('table')).toHaveAttribute('role', 'table');
    await expect(t.locator('thead')).toHaveAttribute('role', 'rowgroup');
    await expect(t.locator('tbody')).toHaveAttribute('role', 'rowgroup');
    await expect(row).toHaveAttribute('role', 'row');
    await expect(t.locator('th').first()).toHaveAttribute('role', 'columnheader');
    await expect(t.locator('td').first()).toHaveAttribute('role', 'cell');
    await expect(t.locator('th').first()).toHaveClass(/h-name/);
    await expect(t.locator('td').nth(1)).toHaveClass(/c-go/);
    // Default tables keep their rows as tab stops and add no roles.
    await sandbox(page, async (box) => {
      const { table } = await import('/assets/js/components/table.js');
      box.append(table({ rowKey: 'id', rows: [{ id: 'a' }], columns: [{ key: 'id', label: 'Id' }], onRowClick() {} }));
    });
    await expect(page.locator('#sandbox tbody tr')).toHaveAttribute('tabindex', '0');
    await expect(page.locator('#sandbox table')).not.toHaveAttribute('role', /.*/);
  });

  test('text hidden in a sideways-scrolling table stays inside it on a phone', async ({ app, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { table } = await import('/assets/js/components/table.js');
      const t = table({
        label: 'Run history',
        rowKey: 'id',
        rows: [{ id: 'r1' }, { id: 'r2' }],
        columns: [
          { key: 'a', label: 'When', render: () => 'Oct 27, 13:00 and a long cell' },
          { key: 'b', label: 'What', render: () => 'A long description of what the run did today' },
          { key: 'c', label: 'Open', render: (r) => {
            const s = document.createElement('span');
            s.className = 'sr-only';
            s.textContent = 'View run ' + r.id + ' with a long hidden label for screen readers';
            return s;
          } },
        ],
      });
      t.querySelector('table').style.minWidth = '760px';
      box.append(t);
    });
    await expect(page.locator('#sandbox .table-wrap')).toHaveCSS('position', 'relative');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('a switch with confirm asks before it flips', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { switchEl } = await import('/assets/js/components/switch.js');
      box.append(switchEl({
        checked: false,
        label: 'Auto-send LinkedIn',
        confirm: (next) => {
          window.__calls.push('ask ' + next);
          if (!next) return true; // only turning it on asks
          return new Promise((r) => { window.__answer = r; });
        },
        onChange: (on) => { window.__calls.push(on); },
      }));
    });
    const sw = page.getByRole('switch', { name: 'Auto-send LinkedIn' });
    await sw.click();
    // Still off while it asks, and busy.
    await expect(sw).toHaveAttribute('aria-busy', 'true');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click(); // ignored while asking
    await page.evaluate(() => window.__answer(false));
    await expect(sw).not.toHaveAttribute('aria-busy', 'true');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(await calls(page)).toEqual(['ask true']);

    await sw.click();
    await page.evaluate(() => window.__answer(true));
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click(); // turning off: confirm says yes at once
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(await calls(page)).toEqual(['ask true', 'ask true', true, 'ask false', false]);
  });

  test('tabs keep the chosen tab in view, fade the edge with more, and count numeric ids', async ({ app, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { tabs } = await import('/assets/js/components/tabs.js');
      const t = tabs({
        label: 'Sections',
        items: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: n, label: 'Section number ' + n, count: n === 3 ? 1 : null })),
        active: 1,
        onChange: (id) => window.__calls.push(id),
      });
      window.__tabs = t;
      box.append(t);
    });
    const list = page.getByRole('tablist', { name: 'Sections' });
    const tab = (n) => list.getByRole('tab', { name: new RegExp(`^Section number ${n}\\b`) });
    await page.evaluate(() => window.__tabs.setCounts({ 3: 1200, 5: 7 }));
    await expect(tab(3).locator('.tab-count')).toHaveText('1,200');
    await expect(tab(5).locator('.tab-count')).toHaveText('7');
    await expect(list).toHaveAttribute('data-more', 'end');

    const inView = (n) =>
      tab(n).evaluate((b) => {
        const l = b.parentElement.getBoundingClientRect();
        const r = b.getBoundingClientRect();
        return r.left >= l.left - 1 && r.right <= l.right + 1;
      });
    expect(await inView(8)).toBe(false);
    await page.evaluate(() => window.__tabs.setActive(8));
    await expect(tab(8)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => inView(8)).toBe(true);
    await expect(list).toHaveAttribute('data-more', 'start');
    // Keyboard selection scrolls too.
    await tab(8).focus();
    await page.keyboard.press('Home');
    await expect.poll(() => inView(1)).toBe(true);
    expect(await calls(page)).toEqual([1]);
    await expect(list).toHaveAttribute('data-more', 'end');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('a deep-linked tab stays in view when counts arrive later and widen the tabs', async ({ app, page }) => {
    // As Pipeline at #/pipeline?stage=skip: the tabs mount, then the stage counts land.
    for (const width of [390, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await app.goto('#/home');
      await sandbox(page, async (box) => {
        const { tabs } = await import('/assets/js/components/tabs.js');
        const labels = ['All', 'New', 'Contact found', 'In Gmail', 'Sent', 'Replied', 'Follow-up due', 'Bounced', 'Skipped'];
        box.style.maxWidth = '728px';
        const t = tabs({ label: 'Stage', items: labels.map((label, i) => ({ id: 's' + i, label })), active: 's8', onChange() {} });
        window.__tabs = t;
        box.append(t);
      });
      const list = page.getByRole('tablist', { name: 'Stage' });
      const skipped = list.getByRole('tab', { name: /^Skipped/ });
      const inView = () =>
        skipped.evaluate((b) => {
          const l = b.parentElement.getBoundingClientRect();
          const r = b.getBoundingClientRect();
          return r.left >= l.left - 1 && r.right <= l.right + 1;
        });
      await expect.poll(inView, { message: `placed at ${width}` }).toBe(true);
      await page.evaluate(() => window.__tabs.setCounts({ s0: 1200, s1: 590, s2: 320, s3: 120, s4: 99, s5: 12, s6: 4, s7: 3, s8: 60 }));
      await expect(skipped.locator('.tab-count')).toHaveText('60');
      await expect.poll(inView, { message: `after the counts at ${width}` }).toBe(true);
      await expect(list).toHaveAttribute('data-more', /start/);
      // Counts that change nothing leave a strip the user scrolled alone.
      await list.evaluate((l) => { l.scrollLeft = 0; });
      await page.evaluate(() => window.__tabs.setCounts({ s0: 1200, s8: 60 }));
      expect(await list.evaluate((l) => l.scrollLeft)).toBe(0);
    }
  });

  test('toasts on screen step aside while a dialog is open and come back when it closes', async ({ app, page }) => {
    for (const size of [{ width: 390, height: 844 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(size);
      await app.goto('#/home');
      await expect(page.locator('#view h1')).toBeVisible();
      await page.evaluate(async () => {
        const ui = await import('/assets/js/core/ui.js');
        window.__ui = ui;
        ui.toast(`Gmail draft not created — ${'Gmail isn’t connected, so coldtrail can’t create drafts there. '.repeat(6)}`, 'err');
      });
      const sticky = page.locator('.toast', { hasText: 'Gmail draft not created' });
      await expect(sticky).toBeVisible();
      await page.evaluate(() => {
        const p = (t) => Object.assign(document.createElement('p'), { textContent: t });
        window.__ui.openDialog({
          title: 'Send all drafts',
          content: [p('Creates 10 Gmail drafts, one per email in the queue.'), p('LinkedIn notes stay here.'), p('Nothing is sent.'), p('You can still edit each draft in Gmail.')],
          actions: [{ label: 'Cancel' }, { label: 'Create 10 Gmail drafts', kind: 'primary', onClick: () => { window.__created = true; } }],
        });
      });
      const dialog = page.getByRole('dialog', { name: 'Send all drafts' });
      await expect(dialog).toBeVisible();
      await expect(sticky).toBeHidden();
      // Nothing covers the dialog's buttons: a real click reaches the confirm button.
      await dialog.getByRole('button', { name: 'Create 10 Gmail drafts' }).click({ timeout: 2000 });
      await expect(dialog).toHaveCount(0);
      expect(await page.evaluate(() => window.__created)).toBe(true);
      await expect(sticky).toBeVisible();

      // A toast raised while a dialog is open (its action failed) shows over it.
      await page.evaluate(() => {
        window.__ui.openDialog({ title: 'Rename', content: 'x', actions: [{ label: 'Cancel' }] });
        window.__ui.toast('Could not rename it', 'err');
      });
      await expect(sticky).toBeHidden();
      await expect(page.locator('.toast', { hasText: 'Could not rename it' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(sticky).toBeVisible();
      await expect(page.locator('.toast', { hasText: 'Could not rename it' })).toBeVisible();
      await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
    }
  });

  test('a confirm dialog starts on Cancel, so Enter never confirms by accident', async ({ app, page }) => {
    await app.goto('#/home');
    await shellReady(page);
    const ask = (opts) =>
      page.evaluate(async (o) => {
        const { confirmDialog } = await import('/assets/js/core/ui.js');
        window.__answer = confirmDialog(o);
      }, opts);
    for (const opts of [
      { title: 'Send this email now?', body: 'It goes out right away.', confirmText: 'Send now' },
      { title: 'Delete Lunch Source?', body: 'Its timer is removed.', confirmText: 'Delete schedule', danger: true },
    ]) {
      await ask(opts);
      const dlg = page.getByRole('alertdialog', { name: opts.title });
      await expect(dlg.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dlg).toHaveCount(0);
      expect(await page.evaluate(() => window.__answer)).toBe(false);
    }
    // Confirming takes a deliberate move to the confirm button.
    await ask({ title: 'Turn on email auto-send?', body: 'Sends without asking.', confirmText: 'Turn on' });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Turn on' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__answer)).toBe(true);
  });

  test('hovered rows keep their small grey text at 4.5:1', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('#/pipeline');
    await shellReady(page);
    const text2 = 'rgb(87, 83, 78)';
    const nav = page.getByRole('navigation', { name: 'Main' });
    const hovered = async (el, part, color) => {
      await el.hover();
      await expect(el.locator(part)).toHaveCSS('color', color);
    };
    await hovered(nav.getByRole('link', { name: /^Follow-ups\b/ }), '.nav-count', text2);
    // The Drafts badge and the current item keep their own colours.
    await hovered(nav.getByRole('link', { name: /^Drafts\b/ }), '.nav-count', 'rgb(255, 255, 255)');
    await hovered(nav.getByRole('link', { name: /^Pipeline\b/ }), '.nav-count', 'rgb(30, 58, 138)');
    await hovered(page.locator('#nav .conn').nth(2), '.conn-state', text2);

    const search = page.getByRole('combobox', { name: 'Search' });
    await search.fill(SEED.emailDrafts[1].domain);
    const second = page.getByRole('option').nth(1);
    await expect(second).not.toHaveClass(/is-active/);
    await hovered(second, '.search-opt-meta', text2);
    await search.fill('');

    await sandbox(page, async (box) => {
      const { searchSelect } = await import('/assets/js/components/searchSelect.js');
      box.append(searchSelect({ label: 'Source list', value: '', options: [{ value: 'Q1', label: 'Q1', count: 3 }, { value: 'Q2', label: 'Q2', count: 4 }], onChange() {} }));
    });
    const box = page.locator('#sandbox');
    await box.getByRole('combobox', { name: 'Source list' }).click();
    const opt = box.locator('.ss-option').nth(1);
    await expect(opt).not.toHaveClass(/is-active/);
    await hovered(opt, '.ss-option-count', text2);
  });

  test('search select can be disabled later and opens under its input, inside the viewport', async ({ app, page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await app.goto('#/home');
    await page.addStyleTag({ content: '#sandbox .wide .ss-list { right: auto; width: max-content; }' });
    await sandbox(page, async (box) => {
      const { searchSelect } = await import('/assets/js/components/searchSelect.js');
      const long = (n) => 'A very long saved search that runs well past the edge of the screen number ' + n;
      const top = searchSelect({ label: 'Model', options: [{ value: 'a', label: 'fake/model-a' }], onChange() {} });
      top.id = 'ss-top';
      top.classList.add('wide');
      top.style.cssText = 'position: fixed; top: 80px; right: 16px; width: 220px';
      top.setAttribute('data-x', '1');
      top.querySelector('input').setAttribute('data-x', '1');
      const options = Array.from({ length: 12 }, (_, i) => ({ value: 'q' + i, label: long(i) }));
      top.setOptions(options);
      const low = searchSelect({ label: 'Sourced by', options, value: '', onChange() {} });
      low.id = 'ss-low';
      low.style.cssText = 'position: fixed; bottom: 16px; left: 16px; width: 260px';
      window.__ss = top;
      box.append(top, low);
    });
    const vw = 1000;
    const vh = 700;
    const rect = (sel) => page.locator(sel).evaluate((el) => el.getBoundingClientRect().toJSON());

    const model = page.getByRole('combobox', { name: 'Model' });
    await model.click();
    const listTop = page.getByRole('listbox', { name: 'Model' });
    await expect(listTop).toBeVisible();
    const input = await rect('#ss-top input');
    const lb = await listTop.evaluate((el) => el.getBoundingClientRect().toJSON());
    expect(Math.abs(lb.top - input.bottom)).toBeLessThanOrEqual(8); // under the input, not the label
    expect(lb.right).toBeLessThanOrEqual(vw);
    expect(lb.left).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');

    // Near the bottom of the screen it opens upwards.
    const source = page.getByRole('combobox', { name: 'Sourced by' });
    await source.click();
    const listLow = page.getByRole('listbox', { name: 'Sourced by' });
    await expect(listLow).toBeVisible();
    const lowInput = await rect('#ss-low input');
    const lb2 = await listLow.evaluate((el) => el.getBoundingClientRect().toJSON());
    expect(lb2.bottom).toBeLessThanOrEqual(lowInput.top);
    expect(lb2.top).toBeGreaterThanOrEqual(0);
    expect(lb2.bottom).toBeLessThanOrEqual(vh);
    await page.keyboard.press('Escape');

    // Disabled after it was built: no typing, no clear button, and back again.
    await page.evaluate(() => { window.__ss.setValue('a'); window.__ss.setDisabled(true); });
    await expect(model).toBeDisabled();
    await expect(page.locator('#ss-top').getByRole('button', { name: 'Clear Model' })).toBeHidden();
    await page.evaluate(() => window.__ss.setDisabled(false));
    await expect(model).toBeEnabled();
    await expect(page.locator('#ss-top').getByRole('button', { name: 'Clear Model' })).toBeVisible();
  });

  test('search select: a pinned row heads the blank list and is never matched by typing', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { searchSelect } = await import('/assets/js/components/searchSelect.js');
      const ss = searchSelect({
        label: 'Sourced by',
        placeholder: 'All sources',
        value: '',
        options: [
          { value: 'all-hands', label: 'All-hands tooling', count: 7 },
          { value: '', label: 'All sources', pinned: true },
          { value: 'berlin', label: 'fintech founders in Berlin', count: 400 },
        ],
        onChange: (v) => window.__calls.push(v),
      });
      window.__ss = ss;
      box.append(ss);
    });
    const box = page.getByRole('combobox', { name: 'Sourced by' });
    const listbox = page.getByRole('listbox', { name: 'Sourced by' });
    const options = listbox.getByRole('option');
    const clear = page.locator('#sandbox').getByRole('button', { name: 'Clear Sourced by' });

    // Chosen and blank: the field shows the placeholder, with nothing to clear.
    await expect(box).toHaveValue('');
    await expect(box).toHaveAttribute('placeholder', 'All sources');
    await expect(clear).toBeHidden();

    // Blank: the pinned row comes first, marked as the choice.
    await box.click();
    await expect(options).toHaveText(['All sources', 'All-hands tooling7', 'fintech founders in Berlin400']);
    await expect(options.first()).toHaveClass(/is-chosen/);

    // Typed text never matches it, so Enter takes the first real match.
    await box.fill('all');
    await expect(options).toHaveText(['All-hands tooling7']);
    await box.fill('All sources');
    await expect(options).toHaveCount(0);
    await box.fill('ALL');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('All-hands tooling');
    await expect(clear).toBeVisible();

    // Picking it from another value fires onChange('') and shows the placeholder again.
    await box.click();
    await expect(options.first()).toHaveText('All sources');
    await options.first().click();
    await expect(box).toHaveValue('');
    await expect(clear).toBeHidden();

    // Picking it again when it is already the choice fires nothing: by mouse or by keyboard.
    await box.click();
    await options.first().click();
    await box.press('ArrowDown');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('');
    expect(await calls(page)).toEqual(['all-hands', '']);

    // setValue('') and setOptions keep the placeholder showing.
    await page.evaluate(() => {
      window.__ss.setValue('berlin');
      window.__ss.setValue('');
      window.__ss.setOptions([{ value: '', label: 'All sources', pinned: true }, { value: 'x', label: 'x' }]);
    });
    await expect(box).toHaveValue('');
    expect(await calls(page)).toEqual(['all-hands', '']);
  });

  test('busy buttons ignore presses but stay legible, with a spinner', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { setBusy } = await import('/assets/js/core/ui.js');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-primary';
      b.textContent = 'Save';
      b.addEventListener('click', () => window.__calls.push('click'));
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'btn btn-primary';
      off.textContent = 'Off';
      off.disabled = true;
      window.__busy = (on) => setBusy(b, on, { label: 'Saving…' });
      box.append(b, off);
    });
    const save = page.locator('#sandbox .btn').first();
    await save.click();
    await page.evaluate(() => window.__busy(true));
    await expect(save).toHaveText('Saving…');
    await expect(save).toHaveAttribute('aria-busy', 'true');
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await save.click({ force: true }); // Playwright itself won't press an aria-disabled button
    await save.focus();
    await page.keyboard.press('Enter');
    expect(await calls(page)).toEqual(['click']);
    await expect(save).toBeFocused();
    await expect(save).toHaveCSS('opacity', '1');
    await expect(page.locator('#sandbox .btn').nth(1)).toHaveCSS('opacity', '0.55');
    const spinner = save.locator('.spinner');
    await expect(spinner).toBeVisible();
    expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');
    await page.evaluate(() => window.__busy(false));
    await expect(save).toHaveText('Save');
    await save.click();
    expect(await calls(page)).toEqual(['click', 'click']);
  });

  test('a busy button keeps its resting colours on hover, whatever its variant', async ({ app, page }) => {
    await app.goto('#/home');
    await sandbox(page, async (box) => {
      const { setBusy } = await import('/assets/js/core/ui.js');
      for (const v of ['primary', 'secondary', 'danger', 'ghost']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn btn-${v}`;
        b.textContent = v;
        box.append(b);
        setBusy(b, true);
      }
      const idle = document.createElement('button');
      idle.type = 'button';
      idle.className = 'btn btn-primary';
      idle.textContent = 'idle';
      box.append(idle);
    });
    const btns = page.locator('#sandbox .btn');
    await expect(btns).toHaveCount(5);
    const colours = (b) => b.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
    for (let i = 0; i < 4; i++) {
      const b = btns.nth(i);
      await page.mouse.move(0, 0);
      const rest = await colours(b);
      await b.hover({ force: true });
      expect(await b.evaluate((el) => el.matches(':hover'))).toBe(true);
      expect(await colours(b), await b.textContent()).toEqual(rest);
    }
    // Not busy: hover still shows.
    const idle = btns.nth(4);
    await page.mouse.move(0, 0);
    const rest = await colours(idle);
    await idle.hover();
    expect(await colours(idle)).not.toEqual(rest);
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

test('a workspace that was set up before is never sent back to setup', async ({ app, page }) => {
  // The Canonical token lapsed: the server no longer counts the workspace as onboarded.
  await page.route('**/api/status*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), onboarded: false, discovery_connected: false } });
  });
  await app.goto('#/pipeline');
  await expect(page.locator('#view h1')).toHaveText('Pipeline');
  await page.evaluate(() => { location.hash = '#/followups'; });
  await expect(page.locator('#view h1')).toHaveText('Follow-ups');
  await expect(page).toHaveURL(hashIs('#/followups'));
  // The shell's connection dot is where reconnecting starts.
  await expect(page.locator('#nav .conn').nth(1)).toHaveAccessibleName('Canonical: Connect');
});

// A record of every #view heading shown, to prove a screen never flashed.
async function recordHeadings(page) {
  await page.addInitScript(() => {
    window.__headings = [];
    new MutationObserver(() => {
      const h1 = document.querySelector('#view h1');
      const t = h1 && h1.textContent;
      if (t && window.__headings[window.__headings.length - 1] !== t) window.__headings.push(t);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

// Last: a different seed restarts the server.
test.describe('empty workspace', () => {
  test.use({ seed: 'empty' });

  test('empty workspace redirects to setup', async ({ app, page }) => {
    await recordHeadings(page);
    // A slow server after the first status: a screen that loads before the check could flash.
    let statusCalls = 0;
    await page.route('**/api/status*', async (route) => {
      if (statusCalls++ > 0) await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });
    const draftLoads = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/drafts')) draftLoads.push(r.url());
    });
    const setupUrl = /#\/setup(\/[a-z]+)?$/;
    await app.goto('#/pipeline');
    await expect(page).toHaveURL(setupUrl);
    await expect(page.locator('#view h1')).toHaveText('Setup');
    // Setup is a full page: no sidebar, no top bar.
    await expect(page.locator('#nav')).toBeHidden();
    await expect(page.locator('#topbar')).toBeHidden();
    // Leaving setup before it's done comes back to it, without the other screen ever showing.
    await page.evaluate(() => { location.hash = '#/drafts'; });
    await expect(page).toHaveURL(setupUrl);
    await expect(page.locator('#view h1')).toHaveText('Setup');
    await page.evaluate(() => { location.hash = '#/home'; });
    await expect(page).toHaveURL(setupUrl);
    await expect(page.locator('#view h1')).toHaveText('Setup');
    expect(await page.evaluate(() => window.__headings)).toEqual(['Setup']);
    expect(draftLoads).toEqual([]);
    await expectAccessible(page);
  });

  test('a workspace with companies but no profile yet is not sent to setup', async ({ app, page }) => {
    // Never set up means no company profile and no companies: data from before is a used workspace.
    await page.route('**/api/summary*', async (route) => {
      const res = await route.fetch();
      const summary = await res.json();
      await route.fulfill({ response: res, json: { ...summary, counts: { ...summary.counts, companies: 3 } } });
    });
    await app.goto('#/pipeline');
    await expect(page.locator('#view h1')).toHaveText('Pipeline');
    await expect(page).toHaveURL(hashIs('#/pipeline'));
  });
});

// Pipeline (spec §5.3): the server-paged companies table (search, stage tabs, "Sourced by"
// filter, pager — all in the URL) and the company drawer at #/pipeline/<domain> (contacts,
// outreach history, Ask agent, Skip / Restore). Numbers come from the seed plan, never literals.
import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { COMPANIES, SEED } from '../harness/seed.mjs';
import { fmtNum } from '../../../ui/js/core/format.js';
import { parseHash } from '../../../ui/js/core/router.js';

const PER = 50;

// What each company status reads as (spec §5.10 sentence case; inventory "Friendly stage labels").
const STAGE = {
  sourced: 'Sourced',
  named: 'Name only',
  emailed: 'Contact found',
  drafted: 'In Gmail',
  sent: 'Sent',
  replied: 'Replied',
  bounced: 'Bounced',
  skip: 'Skipped',
};
const STAGE_ORDER = Object.keys(STAGE);

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Spec §5.10 dates: relative within 48h ("2h ago"), else "Oct 9" in the table (the year only
// outside this one); the exact time goes in the title, and the drawer shows "Oct 9, 13:00".
const SHORT_WHEN = /^(just now|\d+[mh] ago|[A-Z][a-z]{2} \d{1,2}(, \d{4})?)$/;
const DATED = /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/;
const DATED_TIME = /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?, \d{2}:\d{2}$/;
const hashIs = (hash) => new RegExp(`${reEscape(hash)}$`);
const stageCount = (status) => (SEED.stages.find(([s]) => s === status) || [null, 0])[1];
const label = (c) => (c.name ? `${c.name} (${c.domain})` : c.domain);

/** Companies the server's `q` matches: name, domain, or a contact's name / email (any case). */
function matching(q) {
  const needle = q.toLowerCase();
  return COMPANIES.filter((c) =>
    [c.name, c.domain, ...c.contacts.flatMap((k) => [k.founder_name, k.email])].some(
      (s) => s && s.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Replace another screen's module with a bare page titled `title`, so tests that leave the
 * Pipeline don't depend on (or get console errors from) what that screen does on mount.
 */
async function stubView(page, name, title) {
  await page.route(`**/assets/js/views/${name}.js`, (rt) =>
    rt.fulfill({
      contentType: 'text/javascript',
      body: `export default { title: ${JSON.stringify(title)}, mount(root) { const h = document.createElement('h1'); h.textContent = ${JSON.stringify(title)}; root.append(h); } };`,
    }),
  );
}

/** The route the page is on, parsed. */
const route = (page) => parseHash(new URL(page.url()).hash);

function ui(page) {
  const table = page.getByRole('table', { name: 'Companies' });
  return {
    h1: page.locator('#view h1'),
    table,
    rows: table.locator('tbody tr'),
    tabs: page.getByRole('tablist', { name: 'Stage' }),
    tab: (name) => page.getByRole('tablist', { name: 'Stage' }).getByRole('tab', { name: new RegExp(`^${reEscape(name)}\\b`) }),
    filter: page.getByRole('searchbox', { name: 'Filter companies' }),
    source: page.getByRole('combobox', { name: 'Sourced by' }),
    range: page.getByRole('navigation', { name: 'Pages' }).locator('.pager-range'),
    prev: page.getByRole('button', { name: 'Previous page' }),
    next: page.getByRole('button', { name: 'Next page' }),
    drawer: page.getByRole('dialog'),
    search: page.getByRole('combobox', { name: 'Search' }),
  };
}

/** The first page has rendered (rows in, not loading). */
async function listReady(page, n = PER) {
  const { rows, table } = ui(page);
  await expect(rows).toHaveCount(n);
  await expect(table).not.toHaveAttribute('aria-busy', 'true');
}

/** A row's cell texts by column. */
async function rowCells(row) {
  return row.locator('td').evaluateAll((tds) => tds.map((td) => td.innerText.replace(/\s+/g, ' ').trim()));
}

// ---- Empty workspace (seed `onboarded`: set up, no companies) ----

test.describe('empty workspace', () => {
  test.use({ seed: 'onboarded' });

  test('shows how to get companies, with no filters to fiddle with', async ({ app, page }) => {
    await stubView(page, 'agent', 'Agent');
    await app.goto('#/pipeline');
    const { h1, tabs, table } = ui(page);
    await expect(h1).toHaveText('Pipeline');
    const empty = page.locator('.pipeline .empty-state');
    await expect(empty.getByRole('heading', { name: 'No companies yet' })).toBeVisible();
    const find = empty.getByRole('link', { name: 'Find companies' });
    await expect(find).toBeVisible();
    await expect(tabs).toHaveCount(0);
    await expect(table).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(0);

    // The action opens Agent with a prompt to review, never sends it.
    await find.click();
    const r = route(page);
    expect(r.path).toEqual(['agent']);
    expect(r.query.prompt).toMatch(/^Find \d+ companies/);
    await expect(page.locator('#view h1')).toHaveText('Agent');
  });

  test('an unknown company link says so without a failed request', async ({ app, page }) => {
    // The fixture fails the test on any console error, which includes a 404 resource load.
    await app.goto('#/pipeline/nope.example');
    const { drawer } = ui(page);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('nope.example');
    // The empty state's heading sits under the drawer's own h2.
    await expect(drawer.getByRole('heading', { level: 3 })).toHaveText('No company at nope.example');
    await drawer.getByRole('button', { name: 'Back to pipeline' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(hashIs('#/pipeline'));
  });

  test('empty workspace is accessible and fits a phone', async ({ app, page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await app.goto('#/pipeline');
    await expect(page.locator('.pipeline .empty-state')).toBeVisible();
    await expectAccessible(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.pipeline .empty-state')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

// ---- Full seed ----

test('first page renders 50 rows and total', async ({ app, page, server, request }) => {
  await app.goto('#/pipeline');
  const { h1, rows, range, prev, next, tab, source } = ui(page);
  await expect(h1).toHaveText('Pipeline');
  await listReady(page);
  // Review Focus 4: never the whole workspace in the DOM.
  expect(await page.locator('#view tr').count()).toBeLessThanOrEqual(PER + 1);
  await expect(range).toHaveText(`1–${PER} of ${fmtNum(SEED.companies)}`);
  await expect(prev).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect(page.locator('.pipeline .page-desc')).toContainText(`${fmtNum(SEED.companies)} companies`);

  // Newest first, with every column filled from the row.
  const headers = await page.getByRole('table', { name: 'Companies' }).locator('thead th').allInnerTexts();
  expect(headers).toEqual(['Company', 'Contact', 'Stage', 'Sourced by', 'First seen']);
  for (let i = 0; i < 4; i++) {
    const c = COMPANIES[i];
    const cells = await rowCells(rows.nth(i));
    expect(cells[0]).toBe(`${c.name} ${c.domain}`);
    expect(cells[2]).toBe(STAGE[c.status]);
    expect(cells[3]).toBe(c.source_query);
    // The newest companies are hours old: "1h ago", with the exact time on hover.
    expect(cells[4]).toMatch(SHORT_WHEN);
    expect(cells[4]).toMatch(/^\d+h ago$/);
    await expect(rows.nth(i).locator('td').nth(4).locator('[title]')).toHaveAttribute('title', DATED_TIME);
  }
  // Contact: the server's best emailed contact with its address, and a LinkedIn flag.
  const apiRows = (await (await request.get(server.apiUrl(`/api/companies?per=${PER}`))).json()).rows;
  for (let i = 0; i < 6; i++) {
    const r = apiRows[i];
    const cell = (await rowCells(rows.nth(i)))[1];
    if (r.founder) expect(cell).toContain(r.founder);
    if (r.email) expect(cell).toContain(r.email);
    if (r.linkedin) expect(cell).toContain('LinkedIn');
    else expect(cell).not.toContain('LinkedIn');
    if (!r.email && !r.linkedin) expect(cell).toBe('No contact yet');
  }
  expect(apiRows[0].email).toBeNull();
  expect(apiRows[3].linkedin).toBe(true);

  // Stage tabs: All + every stage, counts from the server.
  await expect(tab('All')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('All').locator('.tab-count')).toHaveText(fmtNum(SEED.companies));
  for (const s of STAGE_ORDER) {
    await expect(tab(STAGE[s]).locator('.tab-count')).toHaveText(fmtNum(stageCount(s)));
  }

  // "Sourced by" lists "All sources", then every source query with its count, most first.
  await source.click();
  const options = page.getByRole('listbox', { name: 'Sourced by' }).getByRole('option');
  await expect(options).toHaveCount(SEED.queries.length + 1);
  await expect(options.first()).toHaveText('All sources');
  for (let i = 0; i < SEED.queries.length; i++) {
    const [q, n] = SEED.queries[i];
    await expect(options.nth(i + 1)).toHaveText(`${q}${fmtNum(n)}`);
  }
  await page.keyboard.press('Escape');
});

test('search narrows and updates URL', async ({ app, page }) => {
  await app.goto('#/pipeline');
  const { rows, filter, range } = ui(page);
  await listReady(page);

  const q = 'acme';
  const hits = matching(q);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.length).toBeLessThan(PER);
  await filter.fill(q);
  await expect(page).toHaveURL(hashIs(`#/pipeline?q=${q}`));
  await expect(rows).toHaveCount(hits.length);
  await expect(range).toHaveText(`1–${hits.length} of ${hits.length}`);
  await expect(rows.first()).toContainText(hits[0].domain);
  await expect(ui(page).tab('All').locator('.tab-count')).toHaveText(fmtNum(hits.length));

  // A contact's name finds their company too.
  const person = COMPANIES.find((c) => c.contacts.length === 1 && c.contacts[0].email && !c.name.includes('<'));
  await filter.fill(person.contacts[0].founder_name);
  await expect(rows.filter({ hasText: person.domain })).toHaveCount(1);
  await expect(rows).toHaveCount(Math.min(PER, matching(person.contacts[0].founder_name).length));

  // The filter survives a reload (it lives in the URL).
  await filter.fill(q);
  await expect(page).toHaveURL(hashIs(`#/pipeline?q=${q}`));
  await page.reload();
  await expect(ui(page).filter).toHaveValue(q);
  await expect(ui(page).rows).toHaveCount(hits.length);

  // Nothing matches: say so, and offer the way out.
  await ui(page).filter.fill('zzzz-no-such-company');
  const empty = page.locator('.pipeline .empty-state');
  await expect(empty.getByRole('heading', { name: 'No companies match these filters' })).toBeVisible();
  await empty.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(hashIs('#/pipeline'));
  await expect(ui(page).filter).toHaveValue('');
  await listReady(page);
});

test('stage and source filters combine', async ({ app, page }) => {
  await app.goto('#/pipeline');
  const { rows, tab, source, range } = ui(page);
  await listReady(page);

  await tab(STAGE.emailed).click();
  await expect(page).toHaveURL(hashIs('#/pipeline?stage=emailed'));
  await expect(tab(STAGE.emailed)).toHaveAttribute('aria-selected', 'true');
  await expect(range).toHaveText(`1–${PER} of ${fmtNum(stageCount('emailed'))}`);
  const stages = await rows.locator('td:nth-child(3)').allInnerTexts();
  expect(new Set(stages)).toEqual(new Set([STAGE.emailed]));

  // Sourced by Q3, picked by typing: both filters apply; the stage counts follow the source.
  await source.click();
  await source.fill('Q3');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(hashIs('#/pipeline?stage=emailed&query=Q3'));
  const both = COMPANIES.filter((c) => c.status === 'emailed' && c.source_query === 'Q3');
  await expect(rows).toHaveCount(Math.min(PER, both.length));
  await expect(range).toHaveText(`1–${Math.min(PER, both.length)} of ${fmtNum(both.length)}`);
  const sources = await rows.locator('td:nth-child(4)').allInnerTexts();
  expect(new Set(sources)).toEqual(new Set(['Q3']));
  const inQ3 = COMPANIES.filter((c) => c.source_query === 'Q3');
  await expect(tab('All').locator('.tab-count')).toHaveText(fmtNum(inQ3.length));
  await expect(tab(STAGE.sourced).locator('.tab-count')).toHaveText(
    fmtNum(inQ3.filter((c) => c.status === 'sourced').length),
  );

  // Arrow keys move between stage tabs (pipeline order) and filter as they go.
  await tab(STAGE.emailed).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(hashIs('#/pipeline?stage=named&query=Q3'));
  await expect(tab(STAGE.named)).toBeFocused();
  await expect(rows.first()).toContainText(STAGE.named);

  // "All sources" drops the source and keeps the stage; the picker shows its placeholder again.
  await source.click();
  await page.getByRole('listbox', { name: 'Sourced by' }).getByRole('option', { name: 'All sources' }).click();
  await expect(page).toHaveURL(hashIs('#/pipeline?stage=named'));
  await expect(source).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Clear Sourced by' })).toBeHidden();
  await expect(range).toHaveText(`1–${PER} of ${fmtNum(stageCount('named'))}`);

  // So does the clear button.
  await source.click();
  await source.fill('Q3');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(hashIs('#/pipeline?stage=named&query=Q3'));
  await page.getByRole('button', { name: 'Clear Sourced by' }).click();
  await expect(page).toHaveURL(hashIs('#/pipeline?stage=named'));
  await expect(range).toHaveText(`1–${PER} of ${fmtNum(stageCount('named'))}`);
  await tab('All').click();
  await expect(page).toHaveURL(hashIs('#/pipeline'));
});

test('pager moves pages', async ({ app, page }) => {
  await app.goto('#/pipeline');
  const { rows, range, prev, next } = ui(page);
  await listReady(page);

  await next.click();
  await expect(page).toHaveURL(hashIs('#/pipeline?page=2'));
  await expect(range).toHaveText(`${PER + 1}–${2 * PER} of ${fmtNum(SEED.companies)}`);
  await expect(rows.first()).toContainText(COMPANIES[PER].domain);
  await expect(rows).toHaveCount(PER);
  await expect(prev).toBeEnabled();
  await prev.click();
  await expect(page).toHaveURL(hashIs('#/pipeline'));
  await expect(rows.first()).toContainText(COMPANIES[0].domain);

  // The last page, by URL; past the end lands on the last page.
  const last = Math.ceil(SEED.companies / PER);
  await page.evaluate((n) => { location.hash = `#/pipeline?page=${n}`; }, last);
  await expect(range).toHaveText(`${fmtNum((last - 1) * PER + 1)}–${fmtNum(SEED.companies)} of ${fmtNum(SEED.companies)}`);
  await expect(next).toBeDisabled();
  await expect(rows.last()).toContainText(COMPANIES[SEED.companies - 1].domain);
  // The oldest companies were sourced weeks ago: a date, not "Nh ago".
  expect((await rowCells(rows.last()))[4]).toMatch(DATED);
  await page.evaluate(() => { location.hash = '#/pipeline?page=999'; });
  await expect(page).toHaveURL(hashIs(`#/pipeline?page=${last}`));
  await expect(range).toHaveText(`${fmtNum((last - 1) * PER + 1)}–${fmtNum(SEED.companies)} of ${fmtNum(SEED.companies)}`);

  // A new filter starts again at page 1.
  await expect(next).toBeDisabled();
  await prev.click();
  await expect(page).toHaveURL(hashIs(`#/pipeline?page=${last - 1}`));
  await ui(page).tab(STAGE.named).click();
  await expect(page).toHaveURL(hashIs('#/pipeline?stage=named'));
  await expect(range).toHaveText(`1–${PER} of ${fmtNum(stageCount('named'))}`);
});

test('drawer shows contacts and outreach, Esc closes, URL updates', async ({ app, page }) => {
  // Two contacts: one verified email, one LinkedIn-only (verified first).
  const quarry = COMPANIES.find((c) => c.domain === 'quarry-security.example');
  expect(quarry.contacts.map((k) => Boolean(k.email))).toEqual([true, false]);
  await app.goto(`#/pipeline?q=${quarry.domain}`);
  const { rows, drawer, filter } = ui(page);
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(page).toHaveURL(hashIs(`#/pipeline/${quarry.domain}?q=${quarry.domain}`));
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(quarry.name);
  const site = drawer.getByRole('link', { name: quarry.domain });
  await expect(site).toHaveAttribute('href', `https://${quarry.domain}`);
  await expect(site).toHaveAttribute('rel', /noopener/);
  await expect(drawer.locator('.cd-stage')).toHaveText(STAGE[quarry.status]);

  const contacts = drawer.getByRole('list', { name: 'Contacts' }).getByRole('listitem');
  await expect(contacts).toHaveCount(2);
  const [first, second] = quarry.contacts;
  await expect(contacts.nth(0)).toContainText(first.founder_name);
  await expect(contacts.nth(0)).toContainText(first.role);
  await expect(contacts.nth(0)).toContainText(first.email);
  await expect(contacts.nth(0)).toContainText(first.email_confidence === 'direct' ? 'Direct' : 'Inferred');
  await expect(contacts.nth(0)).toContainText('MX ok');
  await expect(contacts.nth(0).getByRole('link', { name: /LinkedIn/ })).toHaveAttribute('href', first.linkedin_url);
  await expect(contacts.nth(1)).toContainText(second.founder_name);
  await expect(contacts.nth(1)).toContainText('No email');
  await expect(contacts.nth(1).getByRole('link', { name: /LinkedIn/ })).toHaveAttribute('target', '_blank');
  await expect(drawer).toContainText('Nothing drafted or sent yet');
  await expect(drawer.locator('.cd-details')).toContainText(quarry.source_query);
  // First seen reads like the table ("2h ago"), with the exact time on hover.
  const seen = drawer.locator('.cd-details dd').nth(1);
  await expect(seen).toHaveText(/^\d+h ago$/);
  await expect(seen).toHaveAttribute('title', DATED_TIME);

  // Focus is in the drawer; Esc closes it, the URL drops the domain and focus returns to the row.
  expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(hashIs(`#/pipeline?q=${quarry.domain}`));
  await expect(rows.first()).toBeFocused();

  // Outreach history: newest first, channel + status + subject + dates (deep link).
  const wren = COMPANIES.find((c) => c.domain === 'wren-capital.example');
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, wren.domain);
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(wren.name);
  const outreach = drawer.getByRole('list', { name: 'Outreach' }).getByRole('listitem');
  await expect(outreach).toHaveCount(wren.outreach.length);
  const newestFirst = [...wren.outreach].reverse();
  for (let i = 0; i < newestFirst.length; i++) {
    await expect(outreach.nth(i)).toContainText(newestFirst[i].subject);
    await expect(outreach.nth(i)).toContainText('Email');
    await expect(outreach.nth(i)).toContainText(STAGE[newestFirst[i].status]);
    await expect(outreach.nth(i)).toContainText(/Sent /);
  }
  // Its next step is in Follow-ups, not another draft: filtered to it, since a sent company can
  // be under Due or Awaiting there.
  await expect(drawer.getByRole('link', { name: 'Open in Follow-ups' })).toHaveAttribute('href', `#/followups?q=${wren.domain}`);
  // Sourced weeks ago: the date and time.
  await expect(drawer.locator('.cd-details dd').nth(1)).toHaveText(DATED_TIME);

  // A replied company opens on Follow-ups' Replied tab.
  const replied = COMPANIES.find((c) => c.status === 'replied');
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, replied.domain);
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(replied.name);
  await expect(drawer.getByRole('link', { name: 'Open in Follow-ups' })).toHaveAttribute(
    'href',
    `#/followups?tab=replied&q=${replied.domain}`,
  );
  await page.goBack();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(wren.name);

  // Reload keeps the drawer, with focus in it; the close button and browser Back both close it.
  await page.reload();
  await expect(ui(page).drawer.getByRole('heading', { level: 2 })).toHaveText(wren.name);
  await expect(ui(page).drawer.getByRole('list', { name: 'Outreach' })).toBeVisible();
  expect(await ui(page).drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await ui(page).drawer.getByRole('button', { name: 'Close' }).click();
  await expect(ui(page).drawer).toHaveCount(0);
  await expect(page).toHaveURL(hashIs('#/pipeline'));

  await filter.fill(quarry.domain);
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(drawer).toBeVisible();
  await page.goBack();
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(hashIs(`#/pipeline?q=${quarry.domain}`));
  await page.goForward();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(quarry.name);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

test('skip then restore updates the badge', async ({ app, page, server }) => {
  const c = COMPANIES[0]; // sourced, no contacts: restore brings it back to sourced
  expect(c.status).toBe('sourced');
  await app.goto('#/pipeline');
  const { rows, drawer, tab } = ui(page);
  await listReady(page);
  await rows.first().click();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(c.name);

  await drawer.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('#toasts')).toContainText(`Skipped ${c.name}`);
  await expect(drawer.locator('.cd-stage')).toHaveText(STAGE.skip);
  await expect(drawer.getByRole('button', { name: 'Restore' })).toBeVisible();
  expect(server.query('SELECT status FROM companies WHERE domain = ?', c.domain)).toEqual([{ status: 'skip' }]);

  // The table behind it caught up.
  await page.keyboard.press('Escape');
  await expect(rows.first().locator('td').nth(2)).toHaveText(STAGE.skip);
  await expect(tab(STAGE.skip).locator('.tab-count')).toHaveText(fmtNum(stageCount('skip') + 1));
  await expect(tab(STAGE.sourced).locator('.tab-count')).toHaveText(fmtNum(stageCount('sourced') - 1));

  await rows.first().click();
  await drawer.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#toasts')).toContainText(`Restored ${c.name}`);
  await expect(drawer.locator('.cd-stage')).toHaveText(STAGE.sourced);
  await expect(drawer.getByRole('button', { name: 'Skip' })).toBeVisible();
  expect(server.query('SELECT status FROM companies WHERE domain = ?', c.domain)).toEqual([{ status: 'sourced' }]);
  await page.keyboard.press('Escape');
  await expect(rows.first().locator('td').nth(2)).toHaveText(STAGE.sourced);
  await expect(tab(STAGE.skip).locator('.tab-count')).toHaveText(fmtNum(stageCount('skip')));
});

test('ask agent opens Agent with a prefilled prompt', async ({ app, page }) => {
  await stubView(page, 'agent', 'Agent');
  const lists = [];
  page.on('request', (r) => {
    if (/\/api\/companies\?/.test(r.url())) lists.push(new URL(r.url()).searchParams.get('q'));
  });
  // emailed → draft; sourced → enrich (inventory "Row actions by status").
  const emailed = COMPANIES.find((c) => c.domain === 'quarry-security.example');
  await app.goto(`#/pipeline/${emailed.domain}`);
  const { drawer } = ui(page);
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(emailed.name);
  // A deep link to a company on the first page needs only the list and its detail: no search
  // for the domain.
  await expect(drawer.getByRole('list', { name: 'Contacts' })).toBeVisible();
  expect(lists).toEqual([null]);
  await expect(drawer.getByRole('button', { name: 'Ask agent to enrich' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Ask agent to draft' }).click();
  await expect(drawer).toHaveCount(0);
  let r = route(page);
  expect(r.path).toEqual(['agent']);
  expect(r.query.prompt).toBe(`Draft personalized outreach for ${label(emailed)}.`);
  await expect(page.locator('#view h1')).toHaveText('Agent');

  const sourced = COMPANIES.find((c) => c.status === 'sourced');
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, sourced.domain);
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(sourced.name);
  await drawer.getByRole('button', { name: 'Ask agent to enrich' }).click();
  r = route(page);
  expect(r.path).toEqual(['agent']);
  expect(r.query.prompt).toBe(`Find a founder contact for ${label(sourced)}, then draft personalized outreach.`);

  // A drafted company points at its draft instead.
  const drafted = COMPANIES.find((c) => c.status === 'drafted' && !c.name.includes('<'));
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, drafted.domain);
  await expect(drawer.getByRole('link', { name: 'Open in Drafts' })).toHaveAttribute('href', `#/drafts/${drafted.domain}`);
  await expect(drawer.getByRole('button', { name: 'Skip' })).toHaveCount(0);
});

test('hostile company name renders as text', async ({ app, page }) => {
  const x = SEED.xss;
  await app.goto('#/pipeline');
  const { rows, drawer } = ui(page);
  await listReady(page);
  const row = rows.filter({ hasText: x.domain });
  await expect(row).toHaveCount(1);
  await expect(row.locator('td').first()).toContainText(x.name);
  await row.click();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(x.name);
  const contacts = drawer.getByRole('list', { name: 'Contacts' }).getByRole('listitem');
  await expect(contacts.first()).toContainText(x.founder);
  const outreach = drawer.getByRole('list', { name: 'Outreach' }).getByRole('listitem');
  await expect(outreach.first()).toContainText(x.subject);
  await expect(drawer.getByRole('link', { name: 'Open in Drafts' })).toBeVisible();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('#view img, #overlays img').count()).toBe(0);
  expect(await page.locator('#view script, #overlays script').count()).toBe(0);
});

test('unknown company says not found without a failed request', async ({ app, page }) => {
  await app.goto('#/pipeline/nope.example?q=a%20b');
  const { drawer, filter } = ui(page);
  await expect(drawer).toContainText('No company at nope.example');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(hashIs('#/pipeline?q=a%20b'));
  await expect(filter).toHaveValue('a b');
});

test('loading, error and retry states for the list and the drawer', async ({ app, page }) => {
  app.allowConsole(/status of 500/);
  const { rows, table, drawer } = ui(page);

  // Loading: skeleton rows, marked busy, until the page lands.
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route(/\/api\/companies\?/, async (rt) => {
    await gate;
    await rt.continue();
  });
  await app.goto('#/pipeline');
  await expect(page.locator('.pipeline [aria-busy="true"] .skeleton').first()).toBeVisible();
  release();
  await listReady(page);
  await page.unroute(/\/api\/companies\?/);

  // Error: the server's message, and Try again.
  await page.route(/\/api\/companies\?/, (rt) => rt.fulfill({ status: 500, contentType: 'text/plain', body: 'database is locked' }));
  await page.reload();
  const err = page.locator('.pipeline .pl-error');
  await expect(err).toContainText('Couldn’t load companies');
  await expect(err).toContainText('database is locked');
  await expect(table).toHaveCount(0);
  await page.unroute(/\/api\/companies\?/);
  await err.getByRole('button', { name: 'Try again' }).click();
  await listReady(page);

  // A later load keeps the rows under a moving bar: one solid accent segment (spec §2: no
  // gradients).
  let releaseTab;
  const tabGate = new Promise((r) => { releaseTab = r; });
  await page.route(/\/api\/companies\?/, async (rt) => {
    await tabGate;
    await rt.continue();
  });
  await ui(page).tab(STAGE.emailed).click();
  const results = page.locator('.pipeline .pl-results');
  await expect(results).toHaveClass(/is-loading/);
  await expect(table).toHaveAttribute('aria-busy', 'true');
  const bar = await results.evaluate((el) => {
    const cs = getComputedStyle(el, '::after');
    const probe = document.createElement('i');
    probe.style.color = 'var(--accent)';
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { image: cs.backgroundImage, color: cs.backgroundColor, accent };
  });
  expect(bar.image).toBe('none');
  expect(bar.color).toBe(bar.accent);
  releaseTab();
  await expect(table).toHaveAttribute('aria-busy', 'false');
  await expect(results).not.toHaveClass(/is-loading/);
  await page.unroute(/\/api\/companies\?/);

  // A filter change while the list is loading: only the latest answer is shown.
  await ui(page).tab(STAGE.replied).click();
  await expect(rows).toHaveCount(stageCount('replied'));

  // Drawer: loading skeleton, then an error with Try again.
  const granite = COMPANIES[1];
  let releaseDetail;
  const detailGate = new Promise((r) => { releaseDetail = r; });
  await page.route(`**/api/companies/${granite.domain}`, async (rt) => {
    await detailGate;
    await rt.fulfill({ status: 500, contentType: 'text/plain', body: 'disk I/O error' });
  });
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, granite.domain);
  await expect(drawer.locator('[aria-busy="true"] .skeleton').first()).toBeVisible();
  releaseDetail();
  await expect(drawer).toContainText('Couldn’t load this company');
  await expect(drawer).toContainText('disk I/O error');
  await page.unroute(`**/api/companies/${granite.domain}`);
  await drawer.getByRole('button', { name: 'Try again' }).click();
  await expect(drawer.getByRole('list', { name: 'Contacts' }).getByRole('listitem')).toHaveCount(granite.contacts.length);
});

test('keyboard: J/K move rows, Enter opens, Esc returns, / filters', async ({ app, page }) => {
  await app.goto('#/pipeline');
  const { rows, drawer, filter } = ui(page);
  await listReady(page);
  await page.keyboard.press('j');
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect(rows.nth(2)).toBeFocused();
  await page.keyboard.press('k');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(COMPANIES[1].name);
  await expect(page).toHaveURL(hashIs(`#/pipeline/${COMPANIES[1].domain}`));
  // J/K belong to the drawer's page, not the open drawer.
  await page.keyboard.press('j');
  await expect(page).toHaveURL(hashIs(`#/pipeline/${COMPANIES[1].domain}`));
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(rows.nth(1)).toBeFocused();

  await page.keyboard.press('/');
  await expect(filter).toBeFocused();
  await page.keyboard.type('acme');
  await expect(page).toHaveURL(hashIs('#/pipeline?q=acme'));
  // Esc in the filter clears it (and the URL) before it leaves the field.
  await page.keyboard.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(page).toHaveURL(hashIs('#/pipeline'));
  await listReady(page);
  await expect(rows.first()).toContainText(COMPANIES[0].domain);
  // Enter on a focused row opens it.
  await rows.first().focus();
  await page.keyboard.press('Enter');
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
});

test('⌘K from an open drawer closes it and focuses search', async ({ app, page }) => {
  const c = COMPANIES[1];
  await app.goto(`#/pipeline/${c.domain}`);
  const { drawer, search } = ui(page);
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(c.name);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(drawer).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(page).toHaveURL(hashIs('#/pipeline'));
  // And global search can open another company's drawer from here.
  await search.fill(COMPANIES[3].domain);
  await expect(page.getByRole('group', { name: 'Companies' }).getByRole('option').first()).toContainText(COMPANIES[3].domain);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(hashIs(`#/pipeline/${COMPANIES[3].domain}`));
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(COMPANIES[3].name);
});

test('leaving the screen aborts loads and drops a pending search', async ({ app, page }) => {
  // Record every fetch and whether its signal was aborted.
  await page.addInitScript(() => {
    const real = window.fetch;
    window.__fetches = [];
    window.fetch = (input, init = {}) => {
      window.__fetches.push({ url: String(input), signal: init.signal || null });
      return real(input, init);
    };
  });
  const pending = (page) =>
    page.evaluate(() =>
      window.__fetches.filter((f) => f.url.startsWith('/api/companies')).map((f) => ({ url: f.url, aborted: !!(f.signal && f.signal.aborted) })),
    );
  await stubView(page, 'home', 'Home');

  // A list load that never answers is aborted when the user leaves.
  await page.route(/\/api\/companies\?/, () => {});
  await app.goto('#/pipeline');
  await expect(page.locator('.pipeline [aria-busy="true"]').first()).toBeVisible();
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect.poll(async () => (await pending(page)).every((f) => f.aborted)).toBe(true);
  expect((await pending(page)).length).toBeGreaterThan(0);
  await page.unroute(/\/api\/companies\?/);

  // A drawer load in flight is aborted too.
  await page.route(/\/api\/companies\/[^?]+$/, () => {});
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, COMPANIES[1].domain);
  await expect(ui(page).drawer).toBeVisible();
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(ui(page).drawer).toHaveCount(0);
  await expect.poll(async () => (await pending(page)).every((f) => f.aborted || !/\/api\/companies\/[^?]+$/.test(f.url))).toBe(true);
  await page.unroute(/\/api\/companies\/[^?]+$/);

  // Typing then leaving inside the debounce window never searches.
  await page.clock.install();
  await page.evaluate(() => { location.hash = '#/pipeline'; });
  await listReady(page);
  await ui(page).filter.fill('zebra');
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('#view h1')).toHaveText('Home');
  await page.clock.runFor(2000);
  expect((await pending(page)).some((f) => f.url.includes('q=zebra'))).toBe(false);
});

test('pipeline is accessible in light and dark, and fits 390px', async ({ app, page }) => {
  const c = COMPANIES.find((x) => x.domain === 'quarry-security.example');
  await page.emulateMedia({ colorScheme: 'light' });
  await app.goto('#/pipeline');
  await listReady(page);
  await expectAccessible(page);
  // With the source picker open.
  await ui(page).source.click();
  await expect(page.getByRole('listbox', { name: 'Sourced by' })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');

  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, c.domain);
  await expect(ui(page).drawer.getByRole('list', { name: 'Contacts' })).toBeVisible();
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(ui(page).drawer).toHaveCount(0);
  await expectAccessible(page);

  // Phone width: no sideways page scroll, with the list, the drawer, and a filter applied.
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await listReady(page);
  expect(await noSideScroll()).toBeLessThanOrEqual(390);
  await expectAccessible(page);
  await ui(page).tab(STAGE.emailed).click();
  await expect(page).toHaveURL(hashIs('#/pipeline?stage=emailed'));
  expect(await noSideScroll()).toBeLessThanOrEqual(390);
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, c.domain);
  await expect(ui(page).drawer.getByRole('list', { name: 'Contacts' })).toBeVisible();
  expect(await noSideScroll()).toBeLessThanOrEqual(390);
  const box = await ui(page).drawer.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await expectAccessible(page);
});

// ---- Edge cases (these last: they change companies and put them back) ----

test('a status the screen does not know points to Follow-ups', async ({ app, page }) => {
  const c = COMPANIES[1];
  await page.route(`**/api/companies/${c.domain}`, async (rt) => {
    const res = await rt.fetch();
    const body = await res.json();
    body.company.status = 'paused_by_hand';
    await rt.fulfill({ response: res, json: body });
  });
  await app.goto(`#/pipeline/${c.domain}`);
  const { drawer } = ui(page);
  await expect(drawer.locator('.cd-stage')).toHaveText('paused_by_hand');
  // Inventory "Row actions by status": anything not handled goes to Follow-ups, filtered to it.
  await expect(drawer.getByRole('link', { name: 'Open in Follow-ups' })).toHaveAttribute('href', `#/followups?q=${c.domain}`);
  await expect(drawer.locator('.cd-actions .btn')).toHaveCount(1);
});

test('a Name only company without an email says the name is known', async ({ app, page }) => {
  // The row's contact is the best one with an email; the seed has no named company without
  // one, so make the first row such a company.
  await page.route(/\/api\/companies\?/, async (rt) => {
    const res = await rt.fetch();
    const body = await res.json();
    Object.assign(body.rows[0], { status: 'named', founder: null, email: null, linkedin: false });
    await rt.fulfill({ response: res, json: body });
  });
  await app.goto('#/pipeline');
  const { rows } = ui(page);
  await listReady(page);
  const cells = await rowCells(rows.first());
  expect(cells[1]).toBe('Name found, no email yet');
  expect(cells[2]).toBe(STAGE.named);
  // A sourced company with no contact at all still says so.
  expect(COMPANIES[4].contacts).toHaveLength(0);
  expect((await rowCells(rows.nth(4)))[1]).toBe('No contact yet');
});

test('a row pressed right after typing opens with the search applied', async ({ app, page }) => {
  await app.goto('#/pipeline');
  const { rows, filter, drawer } = ui(page);
  await listReady(page);
  // Hold the page's clock, so the 250ms search debounce can't fire on its own.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const c = COMPANIES[0];
  const q = c.name.split(' ')[0].toLowerCase();
  expect(matching(q)[0].domain).toBe(c.domain);
  await filter.fill(q);
  await rows.first().click();
  // The press applied the search first, so the drawer route carries it.
  await expect(page).toHaveURL(hashIs(`#/pipeline/${c.domain}?q=${q}`));
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(c.name);
  await expect(rows).toHaveCount(Math.min(PER, matching(q).length));
  // Closing goes back to that list entry rather than adding one: Forward opens it again.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(hashIs(`#/pipeline?q=${q}`));
  await expect(filter).toHaveValue(q);
  await page.goForward();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(c.name);
});

test('skipping under a stage filter keeps focus in the list', async ({ app, page, server }) => {
  const sourced = COMPANIES.filter((c) => c.status === 'sourced');
  const [, target, next] = sourced;
  expect(target.contacts).toHaveLength(0); // so Restore makes it Sourced again
  await app.goto('#/pipeline?stage=sourced');
  const { rows, drawer } = ui(page);
  await listReady(page);
  await rows.nth(1).click();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(target.name);

  await drawer.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('#toasts')).toContainText(`Skipped ${target.name}`);
  await expect(drawer.locator('.cd-stage')).toHaveText(STAGE.skip);
  // Focus stays on the action slot through the save (busy, not disabled) and the refresh.
  await expect(drawer.getByRole('button', { name: 'Restore' })).toBeFocused();

  // The row left the filtered list; Esc lands on the row now in its place, not on the page.
  await expect(rows.filter({ hasText: target.domain })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(hashIs('#/pipeline?stage=sourced'));
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toContainText(next.domain);

  // Put it back.
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, target.domain);
  await drawer.getByRole('button', { name: 'Restore' }).click();
  await expect(drawer.locator('.cd-stage')).toHaveText(STAGE.sourced);
  expect(server.query('SELECT status FROM companies WHERE domain = ?', target.domain)).toEqual([{ status: 'sourced' }]);
});

test('a Skip refresh that lands after the drawer moved on is dropped', async ({ app, page, server }) => {
  // Record the drawer's detail reads and whether each was aborted.
  await page.addInitScript(() => {
    const real = window.fetch;
    window.__details = [];
    window.fetch = (input, init = {}) => {
      if (!init.method && /\/api\/companies\/[^/?]+$/.test(String(input))) {
        window.__details.push({ url: String(input), signal: init.signal || null });
      }
      return real(input, init);
    };
  });
  const reads = (domain) =>
    page.evaluate(
      (d) => window.__details.filter((f) => f.url.endsWith(`/${d}`)).map((f) => !!(f.signal && f.signal.aborted)),
      domain,
    );
  const a = COMPANIES.filter((c) => c.status === 'sourced' && !c.contacts.length)[2];
  const b = COMPANIES.find((c) => c.domain === 'quarry-security.example');
  await app.goto(`#/pipeline/${a.domain}`);
  const { drawer } = ui(page);
  await expect(drawer.getByRole('button', { name: 'Skip' })).toBeVisible();

  // Hold the re-read that follows the Skip.
  let release;
  const gate = new Promise((r) => { release = r; });
  let held = 0;
  let done = false;
  await page.route(`**/api/companies/${a.domain}`, async (rt) => {
    held++;
    await gate;
    await rt.continue().catch(() => {});
    done = true;
  });
  await drawer.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('#toasts')).toContainText(`Skipped ${a.name}`);
  await expect.poll(() => held).toBe(1);

  // Back/forward-style move to another company while it is held: that read is aborted.
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, b.domain);
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(b.name);
  await expect(drawer.getByRole('list', { name: 'Contacts' }).getByRole('listitem')).toHaveCount(b.contacts.length);
  await expect.poll(() => reads(a.domain)).toEqual([false, true]);
  release();
  await expect.poll(() => done).toBe(true);
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText(b.name);
  await expect(drawer.locator('.cd-stage')).toHaveText(STAGE[b.status]);
  await expect(drawer.getByRole('link', { name: b.domain })).toBeVisible();
  await page.unroute(`**/api/companies/${a.domain}`);

  // Put it back.
  await page.evaluate((d) => { location.hash = `#/pipeline/${d}`; }, a.domain);
  await expect(drawer.locator('.cd-stage')).toHaveText(STAGE.skip);
  await drawer.getByRole('button', { name: 'Restore' }).click();
  await expect(drawer.locator('.cd-stage')).toHaveText(STAGE.sourced);
  expect(server.query('SELECT status FROM companies WHERE domain = ?', a.domain)).toEqual([{ status: 'sourced' }]);
});

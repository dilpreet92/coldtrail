// Company profile (spec §5.8): the product.md editor (autosave, the section checklist, the
// corrected template), the "Already contacted" list (contacted.toml), and the exported
// `mountProfileEditor` that the Setup wizard mounts on its own. Every test starts from the seeded
// profile (PRODUCT_MD) and the stock contacted.toml, and asserts what reached the disk.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { PRODUCT_MD } from '../harness/seed.mjs';
import { REPO_DIR } from '../harness/server.mjs';

/** The stock contacted.toml every workspace starts with (src/setup.rs writes it). */
const CONTACTED_TEMPLATE = readFileSync(join(REPO_DIR, 'templates/contacted.toml'), 'utf8');
/** The example CTA link the empty-profile template carries (product::cta_link's format). */
const EXAMPLE_LINK = 'https://yourproduct.com/?utm_content={slug}';

const productOnDisk = (server) => readFileSync(join(server.home, 'product.md'), 'utf8');
const contactedOnDisk = (server) => readFileSync(join(server.home, 'contacted.toml'), 'utf8');

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hashIs = (hash) => new RegExp(`${reEscape(hash)}$`);

const editor = (page) => page.getByRole('textbox', { name: 'Company profile' });
const saveStatus = (page) => page.locator('.pe-status');
const checklist = (page) => page.getByRole('list', { name: 'Profile checklist' });
const item = (page, id) => checklist(page).locator(`li[data-section="${id}"]`);
const progress = (page) => page.locator('.pe-progress');
const contactedBox = (page) => page.getByRole('textbox', { name: 'Already contacted domains' });
const SECTIONS = ['product', 'audience', 'pain', 'proof', 'offer', 'cta'];

/** POST a JSON body to a token-guarded API path (asserting a 200). */
async function post(request, server, path, data) {
  const res = await request.post(server.apiUrl(path), { data });
  expect(res.status(), `POST ${path}: ${await res.text()}`).toBe(200);
}

/** Every `POST /api/company` body the page sends from now on. */
function recordSaves(page) {
  const saves = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/company') saves.push(r.postDataJSON());
  });
  return saves;
}

/** Put the caret at the end of the editor and type `text` (newlines press Enter). */
async function typeAtEnd(page, text) {
  const ed = editor(page);
  await ed.focus();
  await ed.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type(text);
}

/** Put the caret straight after the first `anchor` in the editor and type `text`. */
async function typeAfter(page, anchor, text) {
  const ed = editor(page);
  await ed.focus();
  await ed.evaluate((el, a) => {
    const at = el.value.indexOf(a) + a.length;
    el.setSelectionRange(at, at);
  }, anchor);
  await page.keyboard.type(text);
}

/** The text selected in the profile editor. */
const selectedText = (page) => editor(page).evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));

/** How the profile's file bar is laid out: the file name clear of the save state, whose text
 *  isn't cut off, and no sideways page scroll. */
function fileBarLayout(page) {
  return page.locator('.pe-main .cp-bar').evaluate((bar) => {
    // The name's text, not its box: a squeezed box lets the text run out over the status.
    const name = bar.querySelector('.cp-file .mono').getBoundingClientRect();
    const status = bar.querySelector('.pe-status').getBoundingClientRect();
    const text = bar.querySelector('.pe-status-text');
    return {
      nameClear: name.right <= status.left || name.bottom <= status.top,
      textCut: text.scrollWidth > text.clientWidth + 1,
      sideScroll: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

/** Open the Company profile and wait for the seeded profile to load. */
async function openProfile(app, page, hash = '#/company') {
  await app.goto(hash);
  await expect(page.locator('#view h1')).toHaveText('Company profile');
  await expect(editor(page)).toHaveValue(PRODUCT_MD);
}

/** Replace another screen's module with a bare stub, so leaving this one doesn't depend on it. */
async function stubView(page, name, title) {
  await page.route(`**/assets/js/views/${name}.js`, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `export default { title: ${JSON.stringify(title)}, mount(root) {
        const h = document.createElement('h1'); h.textContent = ${JSON.stringify(title)}; root.append(h);
      } };`,
    }),
  );
}

test.beforeEach(async ({ request, server }) => {
  await post(request, server, '/api/company', { doc: PRODUCT_MD });
  await post(request, server, '/api/onboarding/contacted', { toml: CONTACTED_TEMPLATE });
});

test('autosave persists after reload', async ({ app, page, server }) => {
  await openProfile(app, page);
  await expect(page).toHaveTitle('Company profile · coldtrail');
  await expect(saveStatus(page)).toHaveText('Saved');
  await expect(progress(page)).toHaveText('6 of 6 covered');
  const saves = recordSaves(page);

  const added = '\n## Team\nTwo founders, both ex-sales.';
  await typeAtEnd(page, added);
  await expect.poll(() => productOnDisk(server)).toBe(PRODUCT_MD + added);
  await expect(saveStatus(page)).toHaveText('Saved');
  // Debounced: a handful of saves for the whole burst, the last one carrying everything.
  expect(saves.length).toBeGreaterThan(0);
  expect(saves.length).toBeLessThan(added.length / 4);
  expect(saves.at(-1)).toEqual({ doc: PRODUCT_MD + added });

  // ⌘S / Ctrl+S saves straight away.
  await editor(page).press('End');
  await page.keyboard.type(' Based in Leeds.');
  await editor(page).press('ControlOrMeta+s');
  await expect.poll(() => productOnDisk(server)).toBe(`${PRODUCT_MD + added} Based in Leeds.`);

  await page.reload();
  await expect(editor(page)).toHaveValue(`${PRODUCT_MD + added} Based in Leeds.`);
  await expect(saveStatus(page)).toHaveText('Saved');
});

test('an edit made just before leaving the screen is still saved', async ({ app, page, server }) => {
  await stubView(page, 'home', 'Home');
  await openProfile(app, page);
  // One input event, then leave inside the debounce window: unmounting flushes the save.
  await editor(page).fill(`${PRODUCT_MD}\nLeft in a hurry.`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
  await expect(page).toHaveURL(hashIs('#/home'));
  await expect.poll(() => productOnDisk(server)).toBe(`${PRODUCT_MD}\nLeft in a hurry.`);
});

test('an edit made just before closing or reloading the tab is still saved', async ({ app, page, server }) => {
  // A paused clock holds the 600ms autosave, so only the page-exit path can save the edit.
  await page.clock.install();
  await openProfile(app, page);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  const saves = recordSaves(page);

  const typed = `${PRODUCT_MD}\nTyped, then reloaded.`;
  await editor(page).fill(typed);
  await expect(saveStatus(page)).toHaveText('Saving…');
  expect(saves).toEqual([]); // still waiting out the debounce
  // pagehide sends it with keepalive, so it outlives the page (a request from the unloading
  // document that page.on('request') doesn't report: the file on disk is the proof).
  await page.reload();
  await expect.poll(() => productOnDisk(server)).toBe(typed);
  await page.clock.resume();
  await expect(editor(page)).toHaveValue(typed);
  await expect(saveStatus(page)).toHaveText('Saved');

  // Too big for a keepalive request (browsers cap them at 64 KiB): leaving asks first, and the
  // save runs while the question is up.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  const big = `${PRODUCT_MD}\n${'Notes from a long discovery call. '.repeat(2200)}`;
  expect(Buffer.byteLength(JSON.stringify({ doc: big }))).toBeGreaterThan(64 * 1024);
  await editor(page).fill(big);
  await editor(page).press('End'); // a real key press: browsers only ask after user input
  await expect(saveStatus(page)).toHaveText('Saving…');
  const dialog = page.waitForEvent('dialog');
  const reload = page.reload();
  const question = await dialog;
  expect(question.type()).toBe('beforeunload');
  await expect.poll(() => productOnDisk(server)).toBe(big);
  await question.accept();
  await reload;
  await page.clock.resume();
  await expect(editor(page)).toHaveValue(big);
});

test('checklist ticks sections as typed', async ({ app, page, server }) => {
  await openProfile(app, page);
  await editor(page).fill('# Acme\n\n');
  await expect(progress(page)).toHaveText('0 of 6 covered');
  for (const id of SECTIONS) await expect(item(page, id)).toHaveAttribute('data-state', 'missing');

  // A heading alone doesn't count: the section needs something under it.
  await typeAtEnd(page, '## What we do\n');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'empty');
  await expect(item(page, 'product').getByRole('button')).toHaveCount(0); // the heading is there already
  await typeAtEnd(page, 'Acme turns call notes into follow-up plans.\n\n');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'done');
  await expect(progress(page)).toHaveText('1 of 6 covered');

  await typeAtEnd(page, '## Who we help\nSeed-stage founders who sell.\n\n');
  await expect(item(page, 'audience')).toHaveAttribute('data-state', 'done');
  await typeAtEnd(page, '## Pain\nLeads go cold.\n\n## Proof\n40 design partners.\n\n');
  await expect(item(page, 'pain')).toHaveAttribute('data-state', 'done');
  await expect(item(page, 'proof')).toHaveAttribute('data-state', 'done');
  // Bracketed placeholder text is not content.
  await typeAtEnd(page, '## Offer\n- Offer: [confirm your offer]\n');
  await expect(item(page, 'offer')).toHaveAttribute('data-state', 'empty');
  await typeAtEnd(page, 'A free 30-day pilot.\n\n');
  await expect(item(page, 'offer')).toHaveAttribute('data-state', 'done');
  await expect(progress(page)).toHaveText('5 of 6 covered');

  await typeAtEnd(page, '## Call to Action\n- Link: https://acme.example/?utm_content={slug}\n');
  await expect(item(page, 'cta')).toHaveAttribute('data-state', 'done');
  await expect(item(page, 'cta')).toContainText('https://acme.example/?utm_content={slug}');
  await expect(progress(page)).toHaveText('6 of 6 covered');
  await expect.poll(() => productOnDisk(server)).toContain('- Link: https://acme.example/?utm_content={slug}');

  // Missing sections can be added from the checklist: the heading lands at the end, caret below.
  await editor(page).fill('# Acme\n\n## What we do\nNotes to plans.\n');
  await item(page, 'offer').getByRole('button', { name: 'Add Offer section' }).click();
  await expect(editor(page)).toHaveValue('# Acme\n\n## What we do\nNotes to plans.\n\n## Offer\n');
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('A free pilot.');
  await expect(item(page, 'offer')).toHaveAttribute('data-state', 'done');
  await expect.poll(() => productOnDisk(server)).toBe('# Acme\n\n## What we do\nNotes to plans.\n\n## Offer\nA free pilot.');
});

test('a level-1 heading is a section unless it titles the profile', async ({ app, page }) => {
  await openProfile(app, page);
  // Written all in level-1 headings: "# What we do" is the section, not the document's title.
  await editor(page).fill('# What we do\nWe sell widgets.\n\n# Who we help\nShops.\n');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'done');
  await expect(item(page, 'product')).toContainText('Under “What we do”');
  await expect(item(page, 'product').getByRole('button')).toHaveCount(0); // no duplicate "+ Add"
  await expect(item(page, 'audience')).toHaveAttribute('data-state', 'done');
  await expect(progress(page)).toHaveText('2 of 6 covered');

  // A title that names a section ("Product") which a later heading also names is still a title:
  // its section is the empty "## What we do", not the whole document under the title.
  await editor(page).fill('# Acme Product Profile\n\n## What we do\n\n## Offer\nA free pilot.\n');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'empty');
  await expect(item(page, 'offer')).toHaveAttribute('data-state', 'done');
  await expect(progress(page)).toHaveText('1 of 6 covered');

  // A title with nothing of its own above its subsections is a title even when no later heading
  // names its section: "product profile" and "Offerpad" don't tick What you do or Offer.
  await editor(page).fill('# Acme product profile\n\n## What it does\nWidgets.\n');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'missing');
  await expect(progress(page)).toHaveText('0 of 6 covered');
  await editor(page).fill('# Offerpad\n\n## What we do\nWe buy homes.\n');
  await expect(item(page, 'offer')).toHaveAttribute('data-state', 'missing');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'done');
  await expect(progress(page)).toHaveText('1 of 6 covered');

  // Text of its own under the first heading makes it a section; so does having level-1
  // siblings (an empty one is then empty, not missing, so there's no duplicate "+ Add").
  await editor(page).fill('# Product\nWidgets for shops.\n\n## Pricing\nFrom $10.\n');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'done');
  await expect(item(page, 'product')).toContainText('Under “Product”');
  await editor(page).fill('# What we do\n\n# Who we help\nShops.\n');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'empty');
  await expect(item(page, 'product').getByRole('button')).toHaveCount(0);
  await expect(item(page, 'audience')).toHaveAttribute('data-state', 'done');
});

test('CTA without - Link: stays unticked with a hint', async ({ app, page, server }) => {
  await openProfile(app, page);
  const cta = item(page, 'cta');

  // A bare URL under the heading (the old template) is never picked up for LinkedIn notes.
  const bare = '# Acme\n\n## Call to action\nhttps://acme.example/?utm_content={slug}\n';
  await editor(page).fill(bare);
  await expect(cta).toHaveAttribute('data-state', 'warn');
  await expect(cta).toContainText('Start the line with “- Link:”');
  await expect(progress(page)).toHaveText('0 of 6 covered');
  await cta.getByRole('button', { name: 'Fix link line' }).click();
  await expect(editor(page)).toHaveValue('# Acme\n\n## Call to action\n- Link: https://acme.example/?utm_content={slug}\n');
  await expect(cta).toHaveAttribute('data-state', 'done');
  await expect.poll(() => productOnDisk(server)).toContain('- Link: https://acme.example/?utm_content={slug}');

  // Heading with no link line at all: add one (the example link, ready to replace).
  await editor(page).fill('# Acme\n\n## Call to Action\n\n## Voice\nShort.\n');
  await expect(cta).toHaveAttribute('data-state', 'warn');
  await expect(cta).toContainText('Add a “- Link:” line');
  await cta.getByRole('button', { name: 'Add link line' }).click();
  await expect(editor(page)).toHaveValue(`# Acme\n\n## Call to Action\n- Link: ${EXAMPLE_LINK}\n\n## Voice\nShort.\n`);
  // The example link is not the user's: still unticked until it's replaced.
  await expect(cta).toHaveAttribute('data-state', 'warn');
  await expect(cta).toContainText('LinkedIn notes end with this example link until you replace it');
  // The line was added with the example site selected.
  await expect(editor(page)).toBeFocused();
  expect(await selectedText(page)).toBe('yourproduct.com');

  // The example link is flagged beside the file name too, since notes would end with it; the
  // flag selects the link, ready to type over.
  const flag = page.getByRole('button', { name: /^Replace example link/ });
  await expect(flag).toBeVisible();
  await expect(flag).toHaveAccessibleName('Replace example link: LinkedIn notes end with it until you do');
  await expect(flag).toHaveText('Replace example link', { useInnerText: true });
  await flag.click();
  await expect(editor(page)).toBeFocused();
  expect(await selectedText(page)).toBe(EXAMPLE_LINK);
  await page.keyboard.type('https://acme.example/?utm_content={slug}');
  await expect(cta).toHaveAttribute('data-state', 'done');
  await expect(flag).toBeHidden();
  await expect.poll(() => productOnDisk(server)).toBe('# Acme\n\n## Call to Action\n- Link: https://acme.example/?utm_content={slug}\n\n## Voice\nShort.\n');

  // A placeholder value, and a heading that isn't exactly "Call to Action", don't count either.
  await editor(page).fill('## Call to Action\n- Link: [add your link]\n');
  await expect(cta).toHaveAttribute('data-state', 'warn');
  await expect(cta).toContainText('placeholder');
  await editor(page).fill('## Call to action (CTA)\n- Link: https://acme.example/\n');
  await expect(cta).toHaveAttribute('data-state', 'warn');
  await expect(cta).toContainText('exactly “Call to Action”');
  await cta.getByRole('button', { name: 'Rename heading' }).click();
  await expect(editor(page)).toHaveValue('## Call to Action\n- Link: https://acme.example/\n');
  await expect(cta).toHaveAttribute('data-state', 'done');

  // http:// works too (what the hint says); anything else is flagged.
  await editor(page).fill('## Call to Action\n- Link: http://acme.example/\n');
  await expect(cta).toHaveAttribute('data-state', 'done');
  await editor(page).fill('## Call to Action\n- Link: acme.example/\n');
  await expect(cta).toHaveAttribute('data-state', 'warn');
  await expect(cta).toContainText('should start with https:// or http://');
});

test('checklist fixes apply to the text as it is now, after lines are added above them', async ({ app, page, server }) => {
  await openProfile(app, page);
  const cta = item(page, 'cta');
  const intro = '# Acme\n\n## What we do\nWe sell widgets.\n';
  const more = '\nTo shops in Leeds.'; // one line more above the warning; its state stays the same
  const grown = '# Acme\n\n## What we do\nWe sell widgets.\nTo shops in Leeds.\n';

  // A bare URL (the old template): the fix rewrites that line, wherever it is now.
  await editor(page).fill(`${intro}\n## Call to action\nhttps://acme.example/?utm_content={slug}\n`);
  await expect(cta.getByRole('button', { name: 'Fix link line' })).toBeVisible();
  await typeAfter(page, 'We sell widgets.', more);
  await cta.getByRole('button', { name: 'Fix link line' }).click();
  const fixed = `${grown}\n## Call to action\n- Link: https://acme.example/?utm_content={slug}\n`;
  await expect(editor(page)).toHaveValue(fixed);
  await expect(cta).toHaveAttribute('data-state', 'done');
  await expect.poll(() => productOnDisk(server)).toBe(fixed);

  // A near-miss heading: the rename lands on the heading, not on the line now above it.
  await editor(page).fill(`${intro}\n## CTA\n- Link: https://acme.example/\n`);
  await expect(cta.getByRole('button', { name: 'Rename heading' })).toBeVisible();
  await typeAfter(page, 'We sell widgets.', more);
  await cta.getByRole('button', { name: 'Rename heading' }).click();
  const renamed = `${grown}\n## Call to Action\n- Link: https://acme.example/\n`;
  await expect(editor(page)).toHaveValue(renamed);
  await expect(cta).toHaveAttribute('data-state', 'done');
  await expect.poll(() => productOnDisk(server)).toBe(renamed);

  // A heading with no link line: the line goes straight under the heading.
  await editor(page).fill(`${intro}\n## Call to Action\n\n## Voice\nShort.\n`);
  await expect(cta.getByRole('button', { name: 'Add link line' })).toBeVisible();
  await typeAfter(page, 'We sell widgets.', more);
  await cta.getByRole('button', { name: 'Add link line' }).click();
  const added = `${grown}\n## Call to Action\n- Link: ${EXAMPLE_LINK}\n\n## Voice\nShort.\n`;
  await expect(editor(page)).toHaveValue(added);
  expect(await selectedText(page)).toBe('yourproduct.com');
  await expect.poll(() => productOnDisk(server)).toBe(added);

  // "Edit link" selects the link itself.
  await typeAfter(page, 'To shops in Leeds.', '\nAnd online.');
  await cta.getByRole('button', { name: 'Edit link' }).click();
  await expect(editor(page)).toBeFocused();
  expect(await selectedText(page)).toBe(EXAMPLE_LINK);
});

test('an edit whose save failed is saved on leaving, or kept for the next visit', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  await stubView(page, 'home', 'Home');
  let failures = 1;
  await page.route('**/api/company', (route) => {
    if (route.request().method() !== 'POST' || failures === 0) return route.fallback();
    failures--;
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'disk full' });
  });
  const restored = page.locator('.pe-restored');
  const leave = async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
    await expect(page.locator('#view h1')).toHaveText('Home');
  };
  const comeBack = async () => {
    await page.goBack();
    await expect(page.locator('#view h1')).toHaveText('Company profile');
  };
  await openProfile(app, page);

  // The save fails once and the user leaves without typing again: leaving saves it.
  const first = `${PRODUCT_MD}\nFirst try.`;
  await editor(page).fill(first);
  await expect(saveStatus(page)).toContainText("Couldn't save: disk full");
  await leave();
  await expect.poll(() => productOnDisk(server)).toBe(first);
  await comeBack();
  await expect(editor(page)).toHaveValue(first);
  await expect(saveStatus(page)).toHaveText('Saved');
  await expect(restored).toBeHidden();

  // Saving still fails on the way out: the text waits in memory, comes back on the next visit
  // and is saved then.
  failures = 2;
  const second = `${first}\nSecond try.`;
  await editor(page).fill(second);
  await expect(saveStatus(page)).toContainText("Couldn't save: disk full");
  await leave();
  await expect.poll(() => failures).toBe(0);
  expect(productOnDisk(server)).toBe(first);
  await comeBack();
  await expect(editor(page)).toHaveValue(second);
  await expect(restored).toHaveText(/^Your unsaved changes from earlier are back\./);
  await expect.poll(() => productOnDisk(server)).toBe(second);
  await expect(saveStatus(page)).toHaveText('Saved');
  await expectAccessible(page);

  // Discard goes back to what the file held before, and saves that.
  await restored.getByRole('button', { name: 'Discard' }).click();
  await expect(restored).toBeHidden();
  await expect(editor(page)).toHaveValue(first);
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => productOnDisk(server)).toBe(first);
  await expect(saveStatus(page)).toHaveText('Saved');

  // Once saved, nothing comes back on the next visit.
  await leave();
  await comeBack();
  await expect(editor(page)).toHaveValue(first);
  await expect(restored).toBeHidden();
});

test('empty profile shows the corrected template', async ({ app, page, server }) => {
  const saves = recordSaves(page);
  // An empty product.md would send the workspace back to setup, so serve it to this page only.
  await page.route('**/api/company', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { doc: '' } }) : route.fallback(),
  );
  await app.goto('#/company');
  const ed = editor(page);
  await expect(ed).toHaveValue(/^# /);
  const template = await ed.inputValue();
  for (const heading of ['## What we do', '## Who we help', '## The pain / value', '## Proof / differentiator', '## Offer']) {
    expect(template).toContain(`\n${heading}\n`);
  }
  // The corrected CTA: a "- Link:" line under "## Call to Action", never a bare URL line.
  expect(template).toContain(`\n## Call to Action\n- Link: ${EXAMPLE_LINK}\n`);
  expect(template).not.toMatch(/^https?:\/\//m);
  await expect(saveStatus(page)).toHaveText('Template · not saved yet');
  await expect(progress(page)).toHaveText('0 of 6 covered');
  await expect(item(page, 'cta')).toHaveAttribute('data-state', 'warn');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'empty');
  // Nothing is saved yet, so the example link isn't flagged in the file bar (the checklist says it).
  const flag = page.getByRole('button', { name: /^Replace example link/ });
  await expect(flag).toBeHidden();
  // Even an explicit ⌘S doesn't save the untouched template.
  await ed.press('ControlOrMeta+s');
  await page.evaluate(() => fetch('/api/status')); // anything ⌘S sent goes out before this
  await expect(saveStatus(page)).toHaveText('Template · not saved yet');
  expect(saves).toEqual([]);

  // Typing saves the whole document, template included.
  await ed.focus();
  await ed.evaluate((el) => {
    const at = el.value.indexOf('## What we do\n') + '## What we do\n'.length;
    el.setSelectionRange(at, at);
  });
  await page.keyboard.type('We turn notes into plans.');
  await expect(item(page, 'product')).toHaveAttribute('data-state', 'done');
  await expect.poll(() => productOnDisk(server)).toContain('## What we do\nWe turn notes into plans.');
  expect(productOnDisk(server)).toContain(`## Call to Action\n- Link: ${EXAMPLE_LINK}`);
  await expect(saveStatus(page)).toHaveText('Saved');
  // Now notes really would end with the example link: the file bar says so.
  await expect(flag).toBeVisible();
});

test('a blank profile is never saved', async ({ app, page, server }) => {
  await stubView(page, 'home', 'Home');
  await openProfile(app, page);
  const saves = recordSaves(page);
  await editor(page).fill('  \n');
  await expect(saveStatus(page)).toHaveText("Not saved: the profile can't be empty");
  await expect(progress(page)).toHaveText('0 of 6 covered');
  await editor(page).press('ControlOrMeta+s');
  await expect(saveStatus(page)).toHaveText("Not saved: the profile can't be empty");

  // The next real edit is the first thing that reaches the server.
  await editor(page).fill('# Back again\n');
  await editor(page).press('ControlOrMeta+s');
  await expect(saveStatus(page)).toHaveText('Saved');
  expect(saves).toEqual([{ doc: '# Back again\n' }]);
  expect(productOnDisk(server)).toBe('# Back again\n');

  // Blank again, then leave: nothing is flushed.
  await editor(page).fill('');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await page.evaluate(() => fetch('/api/status'));
  expect(saves).toEqual([{ doc: '# Back again\n' }]);
  expect(productOnDisk(server)).toBe('# Back again\n');
});

test('loading, load errors and save errors', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  const saves = recordSaves(page);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let failLoad = true;
  let failSave = true;
  await page.route('**/api/company', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await gate;
      if (failLoad) {
        failLoad = false;
        return route.fulfill({ status: 500, contentType: 'text/plain', body: 'disk unavailable' });
      }
    } else if (method === 'POST' && failSave) {
      failSave = false;
      return route.fulfill({ status: 500, contentType: 'text/plain', body: 'disk full: No space left on device (os error 28)' });
    }
    return route.fallback();
  });

  // Loading: a placeholder, no editable text.
  await app.goto('#/company');
  await expect(saveStatus(page)).toHaveText('Loading…');
  await expect(page.locator('.pe-main .skeleton').first()).toBeVisible();
  await expect(editor(page)).toBeHidden();

  // Load error: the message and a retry, and still nothing to type into (no blind overwrite).
  release();
  const loadError = page.locator('.pe-load-error');
  await expect(loadError).toContainText("Couldn't load your profile");
  await expect(loadError).toContainText('disk unavailable');
  await expect(editor(page)).toBeHidden();
  await loadError.getByRole('button', { name: 'Try again' }).click();
  await expect(editor(page)).toHaveValue(PRODUCT_MD);
  expect(saves).toEqual([]);

  // Save error: shown in the status with a retry; the text is kept.
  await editor(page).fill(`${PRODUCT_MD}\nNew line.`);
  await expect(saveStatus(page)).toContainText("Couldn't save: disk full");
  await expect(editor(page)).toHaveValue(`${PRODUCT_MD}\nNew line.`);
  expect(productOnDisk(server)).toBe(PRODUCT_MD);
  // The whole reason is on screen, clear of the file name, on a laptop and on a phone.
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await page.setViewportSize({ width, height });
    expect(await fileBarLayout(page), `file bar at ${width}px`).toEqual({ nameClear: true, textCut: false, sideScroll: false });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(saveStatus(page)).toHaveText('Saved');
  expect(productOnDisk(server)).toBe(`${PRODUCT_MD}\nNew line.`);
});

test('picks up edits made elsewhere when the tab is shown again, never over unsaved work', async ({ app, page, request, server }) => {
  await openProfile(app, page);
  const elsewhere = `${PRODUCT_MD}\n## Team\nEdited in another tab.\n`;
  await post(request, server, '/api/company', { doc: elsewhere });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(editor(page)).toHaveValue(elsewhere);
  await expect(saveStatus(page)).toHaveText('Saved');

  // An edit still waiting to be saved here is kept, and then saved over the other version.
  await post(request, server, '/api/company', { doc: `${PRODUCT_MD}\nThird version.` });
  const local = `${elsewhere}Local edit.`;
  await editor(page).fill(local);
  await page.locator('#view h1').focus();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => productOnDisk(server)).toBe(local);
  await expect(editor(page)).toHaveValue(local);
  await expect(saveStatus(page)).toHaveText('Saved');
});

test('a profile with Windows line endings loads as saved', async ({ app, page, request, server }) => {
  await post(request, server, '/api/company', { doc: PRODUCT_MD.replace(/\n/g, '\r\n') });
  await app.goto('#/company');
  await expect(editor(page)).toHaveValue(PRODUCT_MD);
  await expect(saveStatus(page)).toHaveText('Saved');
  await expect(progress(page)).toHaveText('6 of 6 covered');
});

test('hostile profile text renders as text', async ({ app, page, request, server }) => {
  const hostile =
    '# <img src=x onerror=window.__xss=1>\n\n## Offer\n<script>window.__xss=2</script> A pilot.\n\n' +
    '## Call to Action\n- Link: javascript:window.__xss=3\n';
  await post(request, server, '/api/company', { doc: hostile });
  await app.goto('#/company');
  await expect(editor(page)).toHaveValue(hostile);
  await expect(item(page, 'offer')).toHaveAttribute('data-state', 'done');
  // Not an http(s) link: shown as text with a warning, never as a link.
  await expect(item(page, 'cta')).toHaveAttribute('data-state', 'warn');
  await expect(item(page, 'cta')).toContainText('javascript:window.__xss=3');
  await expect(item(page, 'cta')).toContainText('should start with https:// or http://');
  await expect(page.locator('#view a[href^="javascript"]')).toHaveCount(0);
  await expect(page.locator('#view img, #view script')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('already contacted saves and rejects invalid input', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  await app.goto('#/company?tab=contacted');
  await expect(page.getByRole('tab', { name: 'Already contacted' })).toHaveAttribute('aria-selected', 'true');
  const box = contactedBox(page);
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();

  // Plain domains, one per line (pasted URLs and repeats included), become entries.
  await box.fill('acme.example\nhttps://www.Beta.example/about\nacme.example, gamma.example\n');
  await expect(save).toBeEnabled();
  await expect(page.locator('.ac-state')).toHaveText('Unsaved changes');
  await save.click();
  const saved =
    '"acme.example" = { status = "sent" }\n"beta.example" = { status = "sent" }\n' +
    '"gamma.example" = { status = "sent" }\n';
  const seedHint = ' Run coldtrail seed to load them into the pipeline.';
  await expect(page.locator('.ac-msg')).toHaveText(`Saved: 3 domains added, 1 already listed. The list has 3 domains.${seedHint}`);
  await expect(box).toHaveValue(saved);
  expect(contactedOnDisk(server)).toBe(saved);
  await expect(save).toBeDisabled();

  // Domains pasted under existing TOML entries join them; ones already listed are skipped, and
  // the message says so rather than counting them as saved.
  await box.fill(`${CONTACTED_TEMPLATE}delta.example\nanother-co.io\n`);
  await save.click();
  await expect(page.locator('.ac-msg')).toHaveText(`Saved: 1 domain added, 1 already listed. The list has 3 domains.${seedHint}`);
  const merged = `${CONTACTED_TEMPLATE}"delta.example" = { status = "sent" }\n`;
  await expect(box).toHaveValue(merged);
  expect(contactedOnDisk(server)).toBe(merged);

  // A link with a query string is still a domain. Pasted below a [table] header, its entry moves
  // above the header: inside the table it would be a key that seeding silently ignores.
  await box.fill(`${merged}["table.example"]\nstatus = "skip"\nhttps://query.example/pricing?plan=pro&ref=x\n`);
  await save.click();
  await expect(page.locator('.ac-msg')).toHaveText(`Saved: 1 domain added. The list has 5 domains.${seedHint}`);
  const hoisted = `${merged}"query.example" = { status = "sent" }\n\n["table.example"]\nstatus = "skip"\n`;
  await expect(box).toHaveValue(hoisted);
  expect(contactedOnDisk(server)).toBe(hoisted);

  // Invalid input: the server's reason inline, the field marked, the file untouched.
  await box.fill('"broken = {\nnot a domain\n');
  await save.click();
  const error = page.locator('.ac-error');
  await expect(error).toHaveText(/^Not saved: invalid contacted\.toml/);
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  await expect(box).toHaveAttribute('aria-describedby', new RegExp(await error.getAttribute('id')));
  expect(contactedOnDisk(server)).toBe(hoisted);
  // Editing clears the error.
  await box.press('End');
  await page.keyboard.type(' ');
  await expect(error).toBeHidden();
  await expect(box).not.toHaveAttribute('aria-invalid', 'true');

  await page.reload(); // the "leave with unsaved changes?" question is accepted
  await expect(contactedBox(page)).toHaveValue(hoisted);
});

test('already contacted keeps unsaved edits when you leave, and asks before a close', async ({ app, page, server }) => {
  await stubView(page, 'home', 'Home');
  await app.goto('#/company?tab=contacted');
  const box = contactedBox(page);
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const restored = page.locator('.ac-restored');
  const leaveAndReturn = async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
    await expect(page.locator('#view h1')).toHaveText('Home');
    await page.goBack();
    await expect(page.getByRole('tab', { name: 'Already contacted' })).toHaveAttribute('aria-selected', 'true');
  };

  // No autosave here, and nothing to save it on the way out: the text waits for the next visit.
  const draft = `${CONTACTED_TEMPLATE}kept.example\n`;
  await box.fill(draft);
  await leaveAndReturn();
  await expect(box).toHaveValue(draft);
  await expect(restored).toHaveText(/Your unsaved changes from earlier are back\./);
  await expect(page.locator('.ac-state')).toHaveText('Unsaved changes');
  await expect(save).toBeEnabled();
  expect(contactedOnDisk(server)).toBe(CONTACTED_TEMPLATE);
  await expectAccessible(page);

  // Discard goes back to the saved file.
  await restored.getByRole('button', { name: 'Discard' }).click();
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);
  await expect(box).toBeFocused();
  await expect(restored).toBeHidden();
  await expect(save).toBeDisabled();

  // Kept again, then saved: the notice goes and nothing comes back on the next visit.
  await box.fill(draft);
  await leaveAndReturn();
  await expect(box).toHaveValue(draft);
  await save.click();
  await expect(page.locator('.ac-msg')).toContainText('Saved: 1 domain added.');
  await expect(restored).toBeHidden();
  const savedText = `${CONTACTED_TEMPLATE}"kept.example" = { status = "sent" }\n`;
  expect(contactedOnDisk(server)).toBe(savedText);
  await leaveAndReturn();
  await expect(box).toHaveValue(savedText);
  await expect(restored).toBeHidden();

  // Closing or reloading with unsaved text asks first.
  await box.press('End');
  await page.keyboard.type('\nlast.example');
  const dialog = page.waitForEvent('dialog');
  const reload = page.reload();
  const question = await dialog;
  expect(question.type()).toBe('beforeunload');
  await question.accept();
  await reload;
  await expect(contactedBox(page)).toHaveValue(savedText);
});

test('already contacted: loading and load error', async ({ app, page }) => {
  app.allowConsole(/status of 500/);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.route('**/api/onboarding/files', async (route) => {
    await gate;
    if (fail) {
      fail = false;
      return route.fulfill({ status: 500, contentType: 'text/plain', body: 'cannot read contacted.toml' });
    }
    return route.fallback();
  });
  await openProfile(app, page);
  // The list only loads when its tab opens.
  await page.getByRole('tab', { name: 'Already contacted' }).click();
  await expect(page).toHaveURL(hashIs('#/company?tab=contacted'));
  await expect(page.locator('.ac-main .skeleton').first()).toBeVisible();
  await expect(contactedBox(page)).toBeHidden();
  release();
  const loadError = page.locator('.ac-load-error');
  await expect(loadError).toContainText("Couldn't load the list");
  await expect(loadError).toContainText('cannot read contacted.toml');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  await loadError.getByRole('button', { name: 'Try again' }).click();
  await expect(contactedBox(page)).toHaveValue(CONTACTED_TEMPLATE);
});

test('tabs deep link, follow the URL and work from the keyboard', async ({ app, page }) => {
  await app.goto('#/company?tab=contacted');
  const profileTab = page.getByRole('tab', { name: 'Profile' });
  const contactedTab = page.getByRole('tab', { name: 'Already contacted' });
  await expect(contactedTab).toHaveAttribute('aria-selected', 'true');
  await expect(contactedBox(page)).toBeVisible();
  await expect(editor(page)).toBeHidden();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await contactedTab.getAttribute('id'));
  // The page description follows the tab: only the profile saves as you type.
  const desc = page.locator('#view .page-desc');
  await expect(desc).toContainText('saves when you press Save');
  await expect(desc).not.toContainText('as you type');
  // Saving only writes the file; skipping starts once it's loaded into the pipeline.
  await expect(desc).toContainText('Once loaded with coldtrail seed, sourcing skips them.');

  await contactedTab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(profileTab).toBeFocused();
  await expect(profileTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(hashIs('#/company'));
  await expect(editor(page)).toHaveValue(PRODUCT_MD);
  await expect(contactedBox(page)).toBeHidden();
  await expect(desc).toContainText('saves as you type');
  // Tab moves from the tab list straight into the editor.
  await page.keyboard.press('Tab');
  await expect(editor(page)).toBeFocused();

  // The address bar drives the tab too.
  await page.evaluate(() => {
    location.hash = '#/company?tab=contacted';
  });
  await expect(contactedTab).toHaveAttribute('aria-selected', 'true');
  await expect(contactedBox(page)).toBeVisible();
  // The editor kept its state across the switch (it was never remounted).
  await page.evaluate(() => {
    location.hash = '#/company';
  });
  await expect(editor(page)).toHaveValue(PRODUCT_MD);
});

test('mountProfileEditor works standalone and cleans up', async ({ app, page, server }) => {
  await openProfile(app, page); // sets the session cookie
  // A bare same-origin page: no shell, router, store or app stylesheet.
  await page.goto(`${server.base}/assets/fonts/OFL.txt`);
  const requests = [];
  page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.evaluate(async () => {
    document.body.replaceChildren();
    const { mountProfileEditor } = await import('/assets/js/views/company.js');
    const host = document.createElement('div');
    host.id = 'host';
    document.body.append(host);
    window.__changes = [];
    window.__editor = mountProfileEditor(host, {
      onChange: (s) => window.__changes.push({ doc: s.doc, status: s.status, done: s.checklist.done, persisted: s.persisted }),
    });
    await window.__editor.ready;
  });
  await expect(page.locator('link[href="/assets/css/views/company.css"]')).toHaveCount(1);
  await expect(editor(page)).toHaveValue(PRODUCT_MD);
  expect((await page.evaluate(() => window.__changes)).at(-1)).toEqual({ doc: PRODUCT_MD, status: 'saved', done: 6, persisted: true });

  // onChange follows typing; flush() saves now and resolves once the server has it.
  await typeAtEnd(page, '\nStandalone.');
  expect((await page.evaluate(() => window.__changes)).at(-1).doc).toBe(`${PRODUCT_MD}\nStandalone.`);
  const state = await page.evaluate(() => window.__editor.flush());
  expect(state).toMatchObject({ status: 'saved', persisted: true, doc: `${PRODUCT_MD}\nStandalone.` });
  expect(productOnDisk(server)).toBe(`${PRODUCT_MD}\nStandalone.`);

  // Removing the root flushes a pending edit and stops everything it started.
  await typeAtEnd(page, ' Then removed.');
  await page.evaluate(() => document.getElementById('host').remove());
  await expect.poll(() => productOnDisk(server)).toBe(`${PRODUCT_MD}\nStandalone. Then removed.`);
  const changesAfterRemoval = (await page.evaluate(() => window.__changes)).length;
  const mark = requests.length;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.evaluate(() => fetch('/api/status')); // anything those triggered would be sent before this
  expect(requests.slice(mark)).toEqual(['GET /api/status']);
  expect((await page.evaluate(() => window.__changes)).length).toBe(changesAfterRemoval);

  // dispose() takes the editor out of its root.
  const left = await page.evaluate(async () => {
    const { mountProfileEditor } = await import('/assets/js/views/company.js');
    const host = document.createElement('div');
    document.body.append(host);
    const ed = mountProfileEditor(host);
    await ed.ready;
    ed.dispose();
    return host.childElementCount;
  });
  expect(left).toBe(0);
});

test('accessible in light and dark, and fits a phone', async ({ app, page, request, server }) => {
  app.allowConsole(/status of 500/);
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth);
  for (const scheme of ['light', 'dark']) {
    await post(request, server, '/api/company', { doc: PRODUCT_MD });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProfile(app, page);
    await expectAccessible(page);
    // A warning, its file-bar flag and the "Add" buttons are on screen too.
    await editor(page).fill(`# Acme\n\n## Call to Action\n- Link: ${EXAMPLE_LINK}\n`);
    await expect(item(page, 'cta')).toHaveAttribute('data-state', 'warn');
    await expect(page.locator('.pe-flag')).toBeVisible();
    await expectAccessible(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(editor(page)).toBeVisible();
    expect(await noSideScroll()).toBeLessThanOrEqual(390);
    // On a phone the flag still fits beside the file name and the save state.
    await expect(saveStatus(page)).toHaveText('Saved');
    expect(await fileBarLayout(page)).toEqual({ nameClear: true, textCut: false, sideScroll: false });
    await expect(page.locator('.pe-flag')).toHaveText('Example link', { useInnerText: true });
    await expectAccessible(page);

    await page.getByRole('tab', { name: 'Already contacted' }).click();
    await expect(contactedBox(page)).toBeVisible();
    expect(await noSideScroll()).toBeLessThanOrEqual(390);
    await contactedBox(page).fill('not a domain');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.ac-error')).toBeVisible();
    expect(await noSideScroll()).toBeLessThanOrEqual(390);
    await expectAccessible(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectAccessible(page);
  }
});

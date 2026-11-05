// Company profile (spec §5.8): the product.md editor (autosave, the section checklist, the
// corrected template), the "Already contacted" list (contacted.toml), and the exported
// `mountProfileEditor` that the Setup wizard mounts on its own. Every test starts from the seeded
// profile (PRODUCT_MD) and the stock contacted.toml, and asserts what reached the disk.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SESSION_EXPIRED, SESSION_REOPEN } from '../../../ui/js/core/api.js';
import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { COMPANIES, PRODUCT_MD } from '../harness/seed.mjs';
import { REPO_DIR } from '../harness/server.mjs';

/** The stock contacted.toml every workspace starts with (src/setup.rs writes it). */
const CONTACTED_TEMPLATE = readFileSync(join(REPO_DIR, 'templates/contacted.toml'), 'utf8');
/** The example CTA link the empty-profile template carries (product::cta_link's format). */
const EXAMPLE_LINK = 'https://yourproduct.com/?utm_content={slug}';

const productOnDisk = (server) => readFileSync(join(server.home, 'product.md'), 'utf8');
const contactedOnDisk = (server) => readFileSync(join(server.home, 'contacted.toml'), 'utf8');
/** Edit contacted.toml the way a text editor would: straight on disk, nothing told. */
const editContactedOnDisk = (server, text) => writeFileSync(join(server.home, 'contacted.toml'), text);
/** What a save's message adds when the list isn't empty. */
const SEED_HINT = ' Run coldtrail seed to add the ones that aren’t in your pipeline yet.';

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

/** Reload the tab and answer the "leave site?" question if one comes: accepted, or dismissed with
 *  `stay` (the page stays as it is). Resolves to the question's type, or null if none was asked. */
async function reloadAnswering(page, { stay = false } = {}) {
  let asked = null;
  const answer = (dialog) => {
    asked = dialog.type();
    return stay ? dialog.dismiss() : dialog.accept();
  };
  page.on('dialog', answer);
  try {
    if (stay) {
      // A reload the question cancels never finishes: start it from the page, and wait for the
      // question instead.
      const question = page.waitForEvent('dialog');
      await page.evaluate(() => setTimeout(() => location.reload(), 0));
      await question;
      await expect.poll(() => asked).not.toBe(null);
    } else {
      await page.reload();
    }
  } finally {
    page.off('dialog', answer);
  }
  return asked;
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

test('an edit made just before leaving the screen is saved before the next screen shows', async ({ app, page, server }) => {
  await stubView(page, 'home', 'Home');
  // A slow disk: the save takes half a second.
  await page.route('**/api/company', async (route) => {
    if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 500));
    return route.fallback();
  });
  await openProfile(app, page);
  // One input event, then leave inside the debounce window: the router's beforeLeave flushes the
  // save, and the next screen mounts once it has landed.
  await editor(page).fill(`${PRODUCT_MD}\nLeft in a hurry.`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect(page).toHaveURL(hashIs('#/home'));
  expect(productOnDisk(server)).toBe(`${PRODUCT_MD}\nLeft in a hurry.`);
});

test('coming straight back while the last save is still landing shows the saved text, no restore notice', async ({ app, page, server }) => {
  await stubView(page, 'home', 'Home');
  // Slower than the router waits for beforeLeave (1.5s): the closing editor's own save carries it.
  await page.route('**/api/company', async (route) => {
    if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 2200));
    return route.fallback();
  });
  await openProfile(app, page);
  const typed = `${PRODUCT_MD}\nSaved on the way out.`;
  await editor(page).fill(typed);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  expect(productOnDisk(server)).toBe(PRODUCT_MD); // still on its way
  await page.evaluate(() => {
    window.__sawRestored = false;
    new MutationObserver(() => {
      if (document.querySelector('.pe-restored')) window.__sawRestored = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.goBack();
  await expect(page.locator('#view h1')).toHaveText('Company profile');
  // The new editor reads the file once that save has landed: the text is simply saved.
  await expect(editor(page)).toHaveValue(typed);
  await expect(saveStatus(page)).toHaveText('Saved');
  expect(productOnDisk(server)).toBe(typed);
  await expect(page.locator('.pe-restored')).toBeHidden();
  expect(await page.evaluate(() => window.__sawRestored)).toBe(false);
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
  await typeAtEnd(page, '## Pain\nLeads go cold.\n\n## Proof\n');
  await expect(item(page, 'proof')).toHaveAttribute('data-state', 'empty');
  // A markdown heading needs a space after its "#"s: "#1 rated…" is the section's text.
  await typeAtEnd(page, '#1 rated on G2 for call notes.\n\n');
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
  // The example link is not the user's (cta_link() ignores it): unticked until it's replaced.
  await expect(cta).toHaveAttribute('data-state', 'warn');
  await expect(cta).toContainText('Replace the example link with your real URL');
  await expect(cta).toContainText('Until then, LinkedIn notes go out without a link.');
  await expect(cta.getByRole('button', { name: 'Replace link' })).toBeVisible();
  // The line was added with the example site selected.
  await expect(editor(page)).toBeFocused();
  expect(await selectedText(page)).toBe('yourproduct.com');

  // The example link is flagged beside the file name too, since notes go out without a link
  // until it's replaced; the flag selects the link, ready to type over.
  const flag = page.getByRole('button', { name: /^Replace example link/ });
  await expect(flag).toBeVisible();
  await expect(flag).toHaveAccessibleName('Replace example link: LinkedIn notes go out without a link until you do');
  await expect(flag).toHaveText('Replace example link', { useInnerText: true });
  await flag.click();
  await expect(editor(page)).toBeFocused();
  expect(await selectedText(page)).toBe(EXAMPLE_LINK);
  await page.keyboard.type('https://acme.example/?utm_content={slug}');
  await expect(cta).toHaveAttribute('data-state', 'done');
  await expect(flag).toBeHidden();
  await expect.poll(() => productOnDisk(server)).toBe('# Acme\n\n## Call to Action\n- Link: https://acme.example/?utm_content={slug}\n\n## Voice\nShort.\n');

  // As cta_link() reads it: the example is skipped and a real link after it counts; only the
  // example's own host (and its subdomains) is the example.
  await editor(page).fill(`## Call to Action\n- Link: ${EXAMPLE_LINK}\n- Link: https://acme.example/?utm_content={slug}\n`);
  await expect(cta).toHaveAttribute('data-state', 'done');
  await expect(cta).toContainText('https://acme.example/?utm_content={slug}');
  await expect(flag).toBeHidden();
  await editor(page).fill('## Call to Action\n- Link: https://go.YourProduct.com:8443/x\n');
  await expect(cta).toHaveAttribute('data-state', 'warn');
  await expect(flag).toBeVisible();
  await editor(page).fill('## Call to Action\n- Link: https://notyourproduct.com/?utm_content={slug}\n');
  await expect(cta).toHaveAttribute('data-state', 'done');

  // A "* Link:" or "+ Link:" line is skipped like a bare URL; the fix makes it a "- Link:" line.
  await editor(page).fill('# Acme\n\n## Call to Action\n* Link: https://acme.example/\n');
  await expect(cta).toHaveAttribute('data-state', 'warn');
  await expect(cta).toContainText('Start the line with “- Link:”');
  await cta.getByRole('button', { name: 'Fix link line' }).click();
  await expect(editor(page)).toHaveValue('# Acme\n\n## Call to Action\n- Link: https://acme.example/\n');
  await expect(cta).toHaveAttribute('data-state', 'done');
  await editor(page).fill('## Call to Action\n+ link:   https://acme.example/b\n');
  await cta.getByRole('button', { name: 'Fix link line' }).click();
  await expect(editor(page)).toHaveValue('## Call to Action\n- Link: https://acme.example/b\n');
  await expect(cta).toHaveAttribute('data-state', 'done');

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

  // "Replace link" selects the example link itself.
  await typeAfter(page, 'To shops in Leeds.', '\nAnd online.');
  await cta.getByRole('button', { name: 'Replace link' }).click();
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
  await expect(saveStatus(page)).toContainText('Couldn’t save: disk full');
  await leave();
  await expect.poll(() => productOnDisk(server)).toBe(first);
  await comeBack();
  await expect(editor(page)).toHaveValue(first);
  await expect(saveStatus(page)).toHaveText('Saved');
  await expect(restored).toBeHidden();

  // Saving still fails on the way out (the autosave, the router's beforeLeave flush and the
  // unmount's own try): the text waits in memory, comes back on the next visit and is saved then.
  failures = 3;
  const second = `${first}\nSecond try.`;
  await editor(page).fill(second);
  await expect(saveStatus(page)).toContainText('Couldn’t save: disk full');
  await leave();
  await expect.poll(() => failures).toBe(0);
  expect(productOnDisk(server)).toBe(first);
  await comeBack();
  await expect(editor(page)).toHaveValue(second);
  await expect(restored).toHaveText(/^Your unsaved changes from earlier are back\./);
  // Announced: the notice arrives in a live region.
  await expect(page.getByRole('status').filter({ has: restored })).toBeVisible();
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

  // Typing after a restore makes the text the user's own: the notice goes with its Discard,
  // which would otherwise put back the file from before the restore over the new typing.
  failures = 3;
  const third = `${first}\nThird try.`;
  await editor(page).fill(third);
  await expect(saveStatus(page)).toContainText('Couldn’t save: disk full');
  await leave();
  await expect.poll(() => failures).toBe(0);
  await comeBack();
  await expect(editor(page)).toHaveValue(third);
  await expect(restored).toBeVisible();
  await expect.poll(() => productOnDisk(server)).toBe(third);
  const more = '\n## Team\nTwo founders, typed after the restore.';
  await typeAtEnd(page, more);
  await expect(restored).toBeHidden();
  await expect.poll(() => productOnDisk(server)).toBe(third + more);
  await expect(saveStatus(page)).toHaveText('Saved');
  await expect(editor(page)).toHaveValue(third + more);
});

test('a profile edit kept from a screen you left still asks before a close, from any screen, while its save fails', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  await stubView(page, 'home', 'Home');
  let failures = 0;
  await page.route('**/api/company', (route) => {
    if (route.request().method() !== 'POST' || failures === 0) return route.fallback();
    failures--;
    return route.fulfill({ status: 500, contentType: 'text/plain', body: 'disk full' });
  });
  const restored = page.locator('.pe-restored');
  /** Type `doc` while every save on the way out fails (the autosave, the router's beforeLeave
   *  flush and the unmount's own try), and leave for Home: the text is held in memory only. */
  const typeAndLeave = async (doc) => {
    failures = 3;
    await editor(page).fill(doc);
    await editor(page).press('End'); // a real key press: browsers only ask after user input
    await expect(saveStatus(page)).toContainText('Couldn’t save: disk full');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
    await expect(page.locator('#view h1')).toHaveText('Home');
    await expect.poll(() => failures).toBe(0);
  };
  await openProfile(app, page);

  // Reloading from Home asks; staying keeps the text, which comes back (and saves) on the next visit.
  const first = `${PRODUCT_MD}\nHeld while the disk was full.`;
  await typeAndLeave(first);
  expect(productOnDisk(server)).toBe(PRODUCT_MD);
  expect(await reloadAnswering(page, { stay: true })).toBe('beforeunload');
  await expect(page.locator('#view h1')).toHaveText('Home');
  await page.goBack();
  await expect(editor(page)).toHaveValue(first);
  await expect(restored).toHaveText(/^Your unsaved changes from earlier are back\./);
  await expect.poll(() => productOnDisk(server)).toBe(first);
  await expect(saveStatus(page)).toHaveText('Saved');

  // Leaving anyway: the page sends the text as it goes (the disk is back by then).
  const second = `${first}\nSent on the way out.`;
  await typeAndLeave(second);
  expect(productOnDisk(server)).toBe(first);
  expect(await reloadAnswering(page)).toBe('beforeunload');
  await expect.poll(() => productOnDisk(server)).toBe(second);
  await page.goBack();
  await expect(editor(page)).toHaveValue(second);
  await expect(restored).toBeHidden();

  // Nothing held: leaving and reloading asks nothing.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  expect(await reloadAnswering(page)).toBe(null);
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
  // The saved call to action is still the example, so notes go out without a link: the file bar
  // says so now.
  await expect(flag).toBeVisible();
});

test('a blank profile is never saved', async ({ app, page, server }) => {
  await stubView(page, 'home', 'Home');
  await openProfile(app, page);
  const saves = recordSaves(page);
  await editor(page).fill('  \n');
  await expect(saveStatus(page)).toHaveText('Not saved: the profile can’t be empty');
  await expect(progress(page)).toHaveText('0 of 6 covered');
  await editor(page).press('ControlOrMeta+s');
  await expect(saveStatus(page)).toHaveText('Not saved: the profile can’t be empty');

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
  let failLoads = 2;
  let failSave = true;
  await page.route('**/api/company', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await gate;
      if (failLoads > 0) {
        failLoads--;
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
  await expect(loadError).toContainText('Couldn’t load your profile');
  await expect(loadError).toContainText('disk unavailable');
  await expect(editor(page)).toBeHidden();
  // Try again from the keyboard: focus stays with it (on a new Try again if it fails again), and
  // goes on into the text once it loads, never back to the page.
  const tryAgain = loadError.getByRole('button', { name: 'Try again' });
  await tryAgain.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => failLoads).toBe(0);
  await expect(tryAgain).not.toHaveAttribute('aria-busy', 'true'); // the new one
  await expect(loadError).toContainText('disk unavailable');
  await expect(tryAgain).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(editor(page)).toHaveValue(PRODUCT_MD);
  await expect(editor(page)).toBeFocused();
  expect(saves).toEqual([]);

  // Save error: shown in the status with a retry; the text is kept.
  await editor(page).fill(`${PRODUCT_MD}\nNew line.`);
  await expect(saveStatus(page)).toContainText('Couldn’t save: disk full');
  await expect(editor(page)).toHaveValue(`${PRODUCT_MD}\nNew line.`);
  expect(productOnDisk(server)).toBe(PRODUCT_MD);
  // The whole reason is on screen, clear of the file name, on a laptop and on a phone.
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await page.setViewportSize({ width, height });
    expect(await fileBarLayout(page), `file bar at ${width}px`).toEqual({ nameClear: true, textCut: false, sideScroll: false });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // Retry hides as the save starts: from the keyboard, focus goes on into the text.
  await page.getByRole('button', { name: 'Retry', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(saveStatus(page)).toHaveText('Saved');
  await expect(editor(page)).toBeFocused();
  expect(productOnDisk(server)).toBe(`${PRODUCT_MD}\nNew line.`);
});

test('a stale session is explained once, by the banner', async ({ app, page, context, server }) => {
  app.allowConsole(/status of 401/);
  /** How often the banner's sentence is in the page, hidden text included. */
  const timesSaid = () => page.evaluate((s) => document.body.textContent.split(s).length - 1, SESSION_EXPIRED);
  const banner = page.locator('.session-banner');

  // Loading after a restart (the cookie no longer matches; here it's gone): each tab says what
  // didn't load and points at the fix. No banner sentence again, no Try again that can't work
  // until the tab is reopened, and the banner is the only alert.
  await app.goto('#/company?tab=contacted');
  await expect(contactedBox(page)).toHaveValue(CONTACTED_TEMPLATE);
  await context.clearCookies();
  await page.reload();
  // The card's whole text: what didn't load and the pointer, nothing else.
  const listError = page.locator('.ac-load-error');
  await expect(listError).toHaveText(`Couldn’t load the list.${SESSION_REOPEN}`);
  await expect(page.locator('.ac-state')).toHaveText('Not loaded');
  await expect(banner).toHaveText(SESSION_EXPIRED);
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Profile' }).click();
  const loadError = page.locator('.pe-load-error');
  await expect(loadError).toHaveText(
    `Couldn’t load your profile.${SESSION_REOPEN}Nothing was changed. Editing stays off until it loads, so the saved profile isn’t overwritten.`,
  );
  await expect(saveStatus(page)).toHaveText('Not loaded');
  await expect(editor(page)).toBeHidden();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(await timesSaid()).toBe(1);
  await expectAccessible(page);

  // Saving once the session has gone stale: the text stays, the save state says why in short,
  // and there's no Retry. The same on the Already contacted tab.
  await app.goto('#/company?tab=contacted');
  await expect(contactedBox(page)).toHaveValue(CONTACTED_TEMPLATE);
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(editor(page)).toHaveValue(PRODUCT_MD);
  await context.clearCookies();
  await typeAtEnd(page, '\nTyped after a restart.');
  await expect(saveStatus(page)).toHaveText(`Couldn’t save: ${SESSION_REOPEN}`);
  await expect(banner).toHaveText(SESSION_EXPIRED);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(editor(page)).toHaveValue(`${PRODUCT_MD}\nTyped after a restart.`);
  expect(productOnDisk(server)).toBe(PRODUCT_MD);
  expect(await timesSaid()).toBe(1);

  await page.getByRole('tab', { name: 'Already contacted' }).click();
  await contactedBox(page).fill(`${CONTACTED_TEMPLATE}kept.example\n`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.ac-error')).toHaveText(`Not saved: ${SESSION_REOPEN}`);
  await expect(page.getByRole('button', { name: /^Go to line/ })).toHaveCount(0);
  await expect(page.locator('.ac-error-snippet')).toBeHidden();
  expect(contactedOnDisk(server)).toBe(CONTACTED_TEMPLATE);
  expect(await timesSaid()).toBe(1);
  await expectAccessible(page);
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
  // Hold the first save, to see it in progress.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/onboarding/contacted', async (route) => {
    await gate;
    return route.fallback();
  });
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
  await save.focus();
  await page.keyboard.press('Enter');
  // While it saves: busy (a spinner, presses ignored), focus kept, the text read-only.
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save.locator('.spinner')).toBeVisible();
  await expect(save).toBeFocused();
  await expect(page.locator('.ac-state')).toHaveText('Saving…');
  await expect(box).not.toBeEditable();
  release();
  const saved =
    '"acme.example" = { status = "sent" }\n"beta.example" = { status = "sent" }\n' +
    '"gamma.example" = { status = "sent" }\n';
  const seedHint = SEED_HINT;
  await expect(page.locator('.ac-msg')).toHaveText(`Saved: 3 domains added, 1 already listed. The list has 3 domains.${seedHint}`);
  await expect(box).toHaveValue(saved);
  expect(contactedOnDisk(server)).toBe(saved);
  // Nothing left to save: dimmed, but still focused (a disabled button would drop focus).
  await expect(save).toBeDisabled();
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  await expect(save).toBeFocused();
  await page.keyboard.press('Enter'); // does nothing
  await expect(page.locator('.ac-msg')).toHaveText(`Saved: 3 domains added, 1 already listed. The list has 3 domains.${seedHint}`);

  // Domains pasted under existing TOML entries join them; ones already listed are skipped, and
  // the message says so rather than counting them as saved.
  await box.fill(`${saved}delta.example\ngamma.example\n`);
  await save.click();
  await expect(page.locator('.ac-msg')).toHaveText(`Saved: 1 domain added, 1 already listed. The list has 4 domains.${seedHint}`);
  const merged = `${saved}"delta.example" = { status = "sent" }\n`;
  await expect(box).toHaveValue(merged);
  expect(contactedOnDisk(server)).toBe(merged);

  // A link with a query string is still a domain. Pasted below a [table] header, its entry moves
  // above the header: inside the table it would be a key that seeding silently ignores. An entry
  // typed in contacted.toml form (the table) counts as added too.
  await box.fill(`${merged}["table.example"]\nstatus = "skip"\nhttps://query.example/pricing?plan=pro&ref=x\n`);
  await save.click();
  await expect(page.locator('.ac-msg')).toHaveText(`Saved: 2 domains added. The list has 6 domains.${seedHint}`);
  const hoisted = `${merged}"query.example" = { status = "sent" }\n\n["table.example"]\nstatus = "skip"\n`;
  await expect(box).toHaveValue(hoisted);
  expect(contactedOnDisk(server)).toBe(hoisted);

  // Invalid input: the server's reason inline (announced), the parser's snippet as printed, the
  // field marked, the file untouched.
  await box.fill('"broken = {\nnot a domain\n');
  await save.click();
  const error = page.locator('.ac-error');
  await expect(error).toHaveText('Not saved: invalid contacted.toml: TOML parse error at line 1, column 12');
  await expect(page.locator('.ac-main').getByRole('alert')).toHaveText('Not saved: invalid contacted.toml: TOML parse error at line 1, column 12');
  const snippet = page.locator('.ac-error-snippet');
  await expect(snippet).toBeVisible();
  expect(await snippet.textContent()).toBe('  |\n1 | "broken = {\n  |            ^\ninvalid basic string');
  expect(await snippet.evaluate((el) => [getComputedStyle(el).whiteSpace, getComputedStyle(el).fontFamily])).toEqual([
    'pre-wrap',
    expect.stringContaining('Geist Mono'),
  ]);
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  await expect(box).toHaveAttribute('aria-describedby', new RegExp(await error.getAttribute('id')));
  expect(contactedOnDisk(server)).toBe(hoisted);
  // "Go to line" puts the caret where the parser stopped.
  await page.getByRole('button', { name: 'Go to line 1' }).click();
  await expect(box).toBeFocused();
  expect(await box.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([11, 11]);

  // Domains become entries before sending, so the parser counts lines of text that isn't on
  // screen (line 4 here). The reason, its snippet and "Go to line" all give the line as typed.
  const typed = 'acme.example\nbeta.example, gamma.example\n"broken = {\n';
  await box.fill(typed);
  await save.click();
  await expect(error).toHaveText('Not saved: invalid contacted.toml: TOML parse error at line 3, column 12');
  expect(await snippet.textContent()).toBe('  |\n3 | "broken = {\n  |            ^\ninvalid basic string');
  await page.getByRole('button', { name: 'Go to line 3' }).click();
  const at = typed.indexOf('"broken = {') + '"broken = {'.length;
  expect(await box.evaluate((el) => [el.selectionStart, el.selectionEnd])).toEqual([at, at]);
  await expect(box).toHaveValue(typed);
  // Line 10 as sent is line 9 as typed: the snippet's gutter narrows, and its "^" still lines up.
  const nine = `a.example, b.example\n${'# note\n'.repeat(7)}"broken = {\n`;
  await box.fill(nine);
  await save.click();
  await expect(error).toHaveText('Not saved: invalid contacted.toml: TOML parse error at line 9, column 12');
  expect(await snippet.textContent()).toBe('  |\n9 | "broken = {\n  |            ^\ninvalid basic string');
  await expect(page.getByRole('button', { name: 'Go to line 9' })).toBeVisible();
  await box.fill(typed);
  await save.click();
  await expect(error).toContainText('line 3, column 12');
  // Editing clears the error.
  await box.press('End');
  await page.keyboard.type(' ');
  await expect(error).toBeHidden();
  await expect(snippet).toBeHidden();
  await expect(box).not.toHaveAttribute('aria-invalid', 'true');

  await page.reload(); // the "leave with unsaved changes?" question is accepted
  await expect(contactedBox(page)).toHaveValue(hoisted);
});

test('a rejected save keeps its reason, the snippet and Save on screen', async ({ app, page }) => {
  app.allowConsole(/status of 500/);
  await app.goto('#/company?tab=contacted');
  const box = contactedBox(page);
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const error = page.locator('.ac-error');
  const snippet = page.locator('.ac-error-snippet');
  const goto = page.getByRole('button', { name: /^Go to line/ });
  /** Where the file bar sits against the sticky top bar, and how tall the text box is. */
  const layout = () =>
    page.evaluate(() => ({
      barTop: document.querySelector('.ac-main .cp-bar').getBoundingClientRect().top,
      topbar: document.getElementById('topbar').getBoundingClientRect().bottom,
      text: document.querySelector('.ac-text').getBoundingClientRect().height,
    }));
  // Laptop screens the card fills (it shrinks its text box to make room), a short window (the
  // page scrolls to the error instead) and a phone.
  for (const [width, height, fits] of [[1440, 900, true], [1024, 768, true], [1280, 560, false], [390, 844, false]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await box.fill('acme.example\n"broken = {\n');
    const before = await layout();
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(error).toBeVisible();
    await expect(save).toBeFocused();
    for (const [name, node] of [['Save', save], ['snippet', snippet], ['Go to line', goto], ['reason', error]]) {
      await expect(node, `${name} at ${width}x${height}`).toBeInViewport({ ratio: 1 });
    }
    if (fits) {
      // Still one screen: the file bar hasn't gone under the top bar.
      const after = await layout();
      expect(after.barTop, `file bar at ${width}x${height}`).toBeGreaterThanOrEqual(after.topbar);
      expect(after.text).toBeLessThan(before.text);
      expect(after.text).toBeGreaterThanOrEqual(240);
    }
    // Typing clears the error, and the text box gets its height back.
    await box.press('End');
    await page.keyboard.type(' ');
    await expect(error).toBeHidden();
    expect((await layout()).text).toBe(before.text);
  }
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
  // The notice's live region is on screen, empty, before the list loads and the notice goes in,
  // so screen readers announce it (a region shown together with its text may not be).
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/onboarding/files', async (route) => {
    await gate;
    return route.fallback();
  });
  await leaveAndReturn();
  await expect(page.locator('.ac-main .skeleton').first()).toBeVisible();
  const region = page.locator('.ac-restored-live');
  await expect(region).toHaveAttribute('role', 'status');
  await expect(region).toBeEmpty();
  expect(await region.evaluate((el) => el.checkVisibility())).toBe(true);
  release();
  await page.unroute('**/api/onboarding/files');
  await expect(box).toHaveValue(draft);
  await expect(region).toContainText('Your unsaved changes from earlier are back.');
  // The notice's height comes out of the text box: the card still fits the screen.
  await expect(save).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(900);
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

test('already contacted text kept from a visit still asks before a close, from any screen, and its tab says it’s waiting', async ({ app, page, server }) => {
  await stubView(page, 'pipeline', 'Pipeline');
  await app.goto('#/company?tab=contacted');
  const box = contactedBox(page);
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);
  const marked = page.getByRole('tab', { name: 'Already contacted, unsaved changes' });
  await expect(page.getByRole('tab', { name: 'Already contacted' })).toBeVisible();
  await expect(marked).toHaveCount(0);

  // Typed (real keys: browsers only ask after user input), then left by the help panel's link.
  await box.focus();
  await box.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type('kept.example');
  const draft = `${CONTACTED_TEMPLATE}kept.example`;
  await expect(page.locator('.ac-state')).toHaveText('Unsaved changes');
  await expect(marked).toBeVisible();
  await page.locator('.ac-help').getByRole('link', { name: 'Pipeline' }).click();
  await expect(page.locator('#view h1')).toHaveText('Pipeline');

  // The text lives only in this page now: reloading from there asks, and staying keeps it.
  expect(await reloadAnswering(page, { stay: true })).toBe('beforeunload');
  await expect(page.locator('#view h1')).toHaveText('Pipeline');

  // Back through the sidebar, the Profile tab opens: the list's tab says its changes are waiting.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Company profile\b/ }).click();
  await expect(page).toHaveURL(hashIs('#/company'));
  await expect(page.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
  await expect(marked).toBeVisible();
  await expect(page.locator('.cp-tab-unsaved')).toBeVisible();
  await expectAccessible(page);
  await marked.click();
  await expect(box).toHaveValue(draft);
  await expect(page.locator('.ac-restored')).toHaveText(/^Your unsaved changes from earlier are back\./);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.ac-msg')).toContainText('Saved: 1 domain added.');
  await expect(marked).toHaveCount(0);
  expect(contactedOnDisk(server)).toBe(`${CONTACTED_TEMPLATE}"kept.example" = { status = "sent" }`);

  // Saved: nothing is held any more, so leaving and reloading asks nothing.
  await page.locator('.ac-help').getByRole('link', { name: 'Pipeline' }).click();
  await expect(page.locator('#view h1')).toHaveText('Pipeline');
  expect(await reloadAnswering(page)).toBe(null);
});

test('a contacted.toml with Windows line endings loads as saved', async ({ app, page, request, server }) => {
  await stubView(page, 'home', 'Home');
  const crlf = CONTACTED_TEMPLATE.replace(/\n/g, '\r\n');
  await post(request, server, '/api/onboarding/contacted', { toml: crlf });
  await app.goto('#/company?tab=contacted');
  const box = contactedBox(page);
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);
  await expect(page.locator('.ac-state')).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  // Nothing is kept as "unsaved" on the way out, so nothing comes back.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await page.goBack();
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);
  await expect(page.locator('.ac-restored')).toBeHidden();
  await expect(page.locator('.ac-state')).toHaveText('Saved');
  expect(contactedOnDisk(server)).toBe(crlf);
});

test('already contacted picks up edits made to the file elsewhere, and never saves over them', async ({ app, page, server }) => {
  await stubView(page, 'home', 'Home');
  await app.goto('#/company?tab=contacted');
  const box = contactedBox(page);
  const state = page.locator('.ac-state');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const notice = page.locator('.ac-restored');
  const msg = page.locator('.ac-msg');
  const visible = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);

  // Edited in a text editor while the tab was in the background: shown once it's back.
  const v1 = `${CONTACTED_TEMPLATE}"hand-added.example" = { status = "skip" }\n`;
  editContactedOnDisk(server, v1);
  await visible();
  await expect(box).toHaveValue(v1);
  await expect(state).toHaveText('Saved');
  // ...and when the tab comes back from the Profile tab.
  const v2 = `${v1}"second-hand.example" = { status = "sent" }\n`;
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(editor(page)).toBeVisible();
  editContactedOnDisk(server, v2);
  await page.getByRole('tab', { name: 'Already contacted' }).click();
  await expect(box).toHaveValue(v2);

  // Changed on disk while there are unsaved edits here: those edits stay on screen, and Save
  // writes nothing. It shows the file's new version with these edits added, to check and save.
  await box.fill(`${v2}new-one.example\n`);
  const v3 = `${v2}"third-hand.example" = { status = "skip" }\n`;
  editContactedOnDisk(server, v3);
  await visible();
  await expect(box).toHaveValue(`${v2}new-one.example\n`);
  await save.click();
  // (Changed since it was read here, by whatever changed it: another coldtrail tab, the agent,
  // a text editor. The notice doesn't guess which.)
  await expect(notice).toHaveText(/^contacted\.toml changed since you opened it, so nothing was saved\./);
  await expect(page.getByRole('status').filter({ has: notice })).toBeVisible();
  expect(contactedOnDisk(server)).toBe(v3);
  await expect(box).toHaveValue(`${v3}new-one.example\n`);
  await expect(state).toHaveText('Unsaved changes');
  await expect(save).toBeEnabled();
  await expect(save).toBeFocused();
  await expectAccessible(page);
  await save.click();
  const v4 = `${v3}"new-one.example" = { status = "sent" }\n`;
  await expect(msg).toHaveText(`Saved: 1 domain added. The list has 6 domains.${SEED_HINT}`);
  expect(contactedOnDisk(server)).toBe(v4);
  await expect(notice).toBeHidden();

  // A domain removed here and one added on disk: both changes are kept. "Discard your changes"
  // keeps the file as it is on disk instead.
  await box.fill(v4.replace('"second-hand.example" = { status = "sent" }\n', ''));
  const v5 = `${v4}"fourth-hand.example" = { status = "sent" }\n`;
  editContactedOnDisk(server, v5);
  await save.click();
  await expect(notice).toBeVisible();
  await expect(box).toHaveValue(v5.replace('"second-hand.example" = { status = "sent" }\n', ''));
  await notice.getByRole('button', { name: 'Discard your changes' }).click();
  await expect(box).toHaveValue(v5);
  await expect(box).toBeFocused();
  await expect(state).toHaveText('Saved');
  await expect(notice).toBeHidden();
  expect(contactedOnDisk(server)).toBe(v5);

  // Unsaved text kept from an earlier visit comes back on top of what the file holds by then.
  await box.fill(`${v5}kept.example\n`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home\b/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  const v6 = `${v5}"fifth-hand.example" = { status = "skip" }\n`;
  editContactedOnDisk(server, v6);
  await page.goBack();
  await expect(box).toHaveValue(`${v6}kept.example\n`);
  await expect(notice).toHaveText(/^Your unsaved changes from earlier are back\./);
  await save.click();
  await expect(msg).toContainText('Saved: 1 domain added. The list has 9 domains.');
  const v7 = `${v6}"kept.example" = { status = "sent" }\n`;
  expect(contactedOnDisk(server)).toBe(v7);

  // Changed on disk to just what was typed here (another tab saved the same entry first):
  // nothing is written, and the message says the file has it already.
  const v8 = `${v7}"twice.example" = { status = "skip" }\n`;
  await box.fill(v8);
  editContactedOnDisk(server, v8);
  await save.click();
  await expect(msg).toHaveText('contacted.toml changed since you opened it and already has your changes, so nothing was saved.');
  await expect(state).toHaveText('Saved');
  await expect(notice).toBeHidden();
  expect(contactedOnDisk(server)).toBe(v8);
});

test('mergeContacted puts this tab’s changes on top of the file’s new version', async ({ app, page }) => {
  await app.goto('#/company?tab=contacted');
  await expect(contactedBox(page)).toHaveValue(CONTACTED_TEMPLATE);
  const merged = await page.evaluate(async () => {
    const { mergeContacted } = await import('/assets/js/views/company.js');
    const base = 'a\nb\nc\nd\n';
    return {
      // Nothing changed on one side: the other side as it is.
      onlyMine: mergeContacted(base, 'a\nb\nx\nc\nd\n', base),
      onlyTheirs: mergeContacted(base, base, 'a\nb\nc\nd\ny\n'),
      // Added at the same spot: theirs first, then mine.
      sameSpot: mergeContacted(base, 'a\nb\nx\nc\nd\n', 'a\nb\ny\nc\nd\n'),
      // Mine removes b and adds at the end; theirs adds at the top and removes d.
      both: mergeContacted(base, 'a\nc\nd\nx\n', 'y\na\nb\nc\n'),
      // A line both changed comes out twice, for the user to settle before saving.
      clash: mergeContacted(base, 'a\nB1\nc\nd\n', 'a\nB2\nc\nd\n'),
    };
  });
  expect(merged).toEqual({
    onlyMine: 'a\nb\nx\nc\nd\n',
    onlyTheirs: 'a\nb\nc\nd\ny\n',
    sameSpot: 'a\nb\ny\nx\nc\nd\n',
    both: 'y\na\nc\nx\n',
    clash: 'a\nB2\nB1\nc\nd\n',
  });
});

test('pasted email addresses and notes become entries; other words get a plain reason', async ({ app, page, server }) => {
  app.allowConsole(/status of 500/);
  await app.goto('#/company?tab=contacted');
  const box = contactedBox(page);
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const msg = page.locator('.ac-msg');

  // An email address stands for its domain; a note after a domain, in the file's own comment
  // style, stays with its entry.
  await box.fill(`${CONTACTED_TEMPLATE}john@acme-mail.example\nold-client.example  # met at SaaStr\n<jane@beta-mail.example>, mailto:sam@gamma-mail.example\n`);
  await save.click();
  await expect(msg).toHaveText(`Saved: 4 domains added. The list has 6 domains.${SEED_HINT}`);
  const saved =
    `${CONTACTED_TEMPLATE}"acme-mail.example" = { status = "sent" }\n` +
    '"old-client.example" = { status = "sent" } # met at SaaStr\n' +
    '"beta-mail.example" = { status = "sent" }\n"gamma-mail.example" = { status = "sent" }\n';
  expect(contactedOnDisk(server)).toBe(saved);
  await expect(box).toHaveValue(saved);

  // A line that's neither: said in words, not as the parser's TOML expectations.
  await box.fill('acme.example\nJane Doe <jane@delta.example>\n');
  await save.click();
  await expect(page.locator('.ac-error')).toHaveText('Not saved: line 2 isn’t a domain, a link, an email address or a contacted.toml entry.');
  await expect(page.locator('.ac-error-snippet')).toBeHidden();
  await page.getByRole('button', { name: 'Go to line 2' }).click();
  await expect(box).toBeFocused();
  expect(contactedOnDisk(server)).toBe(saved);

  // Big pastes: every count with thousands separators.
  const fresh = Array.from({ length: 1500 }, (_, i) => `co-${i}.example`);
  await box.fill(`${[...fresh, ...fresh.slice(0, 1200)].join('\n')}\n`);
  await save.click();
  await expect(msg).toHaveText(`Saved: 1,500 domains added, 1,200 already listed. The list has 1,500 domains.${SEED_HINT}`);
});

test('after a save, companies already in the pipeline are named: seeding won’t change them', async ({ app, page, server }) => {
  // (Not the seed's hostile-text company: a plain domain reads better in the message.)
  const at = (status) => COMPANIES.find((c) => c.status === status && c.domain !== 'xss.example').domain;
  const [drafted, sourced, skipped] = [at('drafted'), at('sourced'), at('skip')];
  await app.goto('#/company?tab=contacted');
  const box = contactedBox(page);
  await expect(box).toHaveValue(CONTACTED_TEMPLATE);
  // The help says what seeding does, and what it doesn't.
  const help = page.locator('.ac-help');
  await expect(help).toContainText('Seeding adds the ones that aren’t in your pipeline yet, so sourcing never brings them in.');
  await expect(help).toContainText('Seeding doesn’t change a company that’s already there: skip it on Pipeline instead.');
  await expect(help).not.toContainText('nobody hears from you twice');
  await expect(help.getByRole('link', { name: 'Pipeline' })).toHaveAttribute('href', '#/pipeline');

  // A company that's skipped there already isn't named; nor is one the pipeline doesn't have.
  await box.fill(`${CONTACTED_TEMPLATE}${drafted}\n"${sourced}" = { status = "skip" }\n${skipped}\nbrand-new.example\n`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const msg = page.locator('.ac-msg');
  await expect(msg).toHaveText(
    `Saved: 4 domains added. The list has 6 domains.${SEED_HINT} Already in your pipeline, so seeding won’t change them: ${drafted}, ${sourced}. Open each to skip it.`,
  );
  await expect(msg.getByRole('link', { name: drafted })).toHaveAttribute('href', `#/pipeline/${drafted}`);
  await expect(msg.getByRole('link', { name: sourced })).toHaveAttribute('href', `#/pipeline/${sourced}`);
  expect(contactedOnDisk(server)).toContain(`"${sourced}" = { status = "skip" }`);

  // Only what this save added is looked up.
  await box.focus();
  await box.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type(at('emailed'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(msg).toHaveText(
    `Saved: 1 domain added. The list has 7 domains.${SEED_HINT} ${at('emailed')} is already in your pipeline, so seeding won’t change it. Open it to skip it.`,
  );
  await expectAccessible(page);
});

test('already contacted: loading and load error', async ({ app, page }) => {
  app.allowConsole(/status of 500/);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let fails = 2;
  await page.route('**/api/onboarding/files', async (route) => {
    await gate;
    if (fails > 0) {
      fails--;
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
  // Nothing to press while it loads (the footer only keeps its room).
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  release();
  const loadError = page.locator('.ac-load-error');
  await expect(loadError).toContainText('Couldn’t load the list');
  await expect(loadError).toContainText('cannot read contacted.toml');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  // The file bar says so too, as on the profile tab.
  const state = page.locator('.ac-state');
  await expect(state).toHaveText('Not loaded');
  await expect(state).toHaveAttribute('data-state', 'load-error');
  await expect(state.locator('svg')).toBeVisible();
  // Try again from the keyboard: focus stays with it (on a new Try again if it fails again), and
  // goes on into the list once it loads, never back to the page.
  const tryAgain = loadError.getByRole('button', { name: 'Try again' });
  await tryAgain.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => fails).toBe(0);
  await expect(tryAgain).not.toHaveAttribute('aria-busy', 'true'); // the new one
  await expect(loadError).toContainText('cannot read contacted.toml');
  await expect(tryAgain).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(contactedBox(page)).toHaveValue(CONTACTED_TEMPLATE);
  await expect(contactedBox(page)).toBeFocused();
  await expect(state).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
});

test('already contacted keeps its layout while it loads, so the help panel doesn’t jump on a phone', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/onboarding/files', async (route) => {
    await gate;
    return route.fallback();
  });
  await app.goto('#/company?tab=contacted');
  await expect(page.locator('.ac-main .skeleton').first()).toBeVisible();
  const helpTop = () => page.locator('.ac-help').evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const loading = await helpTop();
  release();
  await expect(contactedBox(page)).toHaveValue(CONTACTED_TEMPLATE);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  expect(Math.abs((await helpTop()) - loading)).toBeLessThanOrEqual(1);
});

test('tabs deep link, follow the URL and work from the keyboard', async ({ app, page }) => {
  await app.goto('#/company?tab=contacted');
  const profileTab = page.getByRole('tab', { name: 'Profile' });
  const contactedTab = page.getByRole('tab', { name: 'Already contacted' });
  await expect(contactedTab).toHaveAttribute('aria-selected', 'true');
  await expect(contactedBox(page)).toBeVisible();
  await expect(editor(page)).toBeHidden();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await contactedTab.getAttribute('id'));
  // The page description follows the tab: only the profile saves as you type. (The other tab's
  // is there too, invisible, holding its room: only rendered text counts.)
  const desc = page.locator('#view .page-desc');
  const shown = { useInnerText: true };
  await expect(desc).toContainText('saves when you press Save', shown);
  await expect(desc).not.toContainText('as you type', shown);
  // Saving only writes the file; skipping starts once it's loaded into the pipeline.
  await expect(desc).toContainText('Once loaded with coldtrail seed, sourcing skips them.', shown);
  // At 1024px this description takes two lines and the profile's one: the tabs stay put anyway.
  await page.setViewportSize({ width: 1024, height: 768 });
  const tabsTop = () => page.getByRole('tablist').evaluate((el) => el.getBoundingClientRect().top);
  const top = await tabsTop();

  await contactedTab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(profileTab).toBeFocused();
  await expect(profileTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(hashIs('#/company'));
  await expect(editor(page)).toHaveValue(PRODUCT_MD);
  await expect(contactedBox(page)).toBeHidden();
  await expect(desc).toContainText('saves as you type', shown);
  await expect(desc).not.toContainText('press Save', shown);
  expect(await tabsTop()).toBe(top);
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await expect(editor(page)).toBeVisible();
  // No app stylesheet here, so no `[hidden] { display: none !important }` from base.css: what is
  // hidden stays hidden all the same.
  for (const hidden of ['.pe-flag', '.cp-skeleton', '.cp-load-error', '.pe-check-note', '.pe-main .btn']) {
    await expect(page.locator(hidden).first(), hidden).toBeHidden();
  }
  await expect(page.locator('.pe-restored')).toBeHidden();
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

  // The checklist heading fits the page around it (Setup puts the editor under an h2 step
  // heading): an h2 unless `headingLevel` says 2–6 otherwise, and the same look at any level.
  const levels = await page.evaluate(async () => {
    const { mountProfileEditor } = await import('/assets/js/views/company.js');
    const out = [];
    for (const headingLevel of [3, 6, '4', 1, 7, 2.5, undefined]) {
      const host = document.createElement('div');
      document.body.append(host);
      const ed = mountProfileEditor(host, headingLevel === undefined ? {} : { headingLevel });
      await ed.ready;
      const title = ed.el.querySelector('.pe-check-title');
      const look = getComputedStyle(title);
      out.push([title.tagName, title.textContent, look.fontSize, look.fontWeight, look.lineHeight].join(' '));
      ed.dispose();
    }
    return out;
  });
  const look = levels[0].split(' ').slice(2).join(' ');
  expect(levels).toEqual(['H3', 'H6', 'H4', 'H2', 'H2', 'H2', 'H2'].map((tag) => `${tag} Checklist ${look}`));
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

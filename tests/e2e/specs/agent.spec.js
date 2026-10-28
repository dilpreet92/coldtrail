// @ts-check
//
// Agent screen (spec §5.6): the conversation list (Your chats / Scheduled runs, search), the
// transcript (safe markdown, "Worked · N steps" tool groups), the composer (Enter sends,
// Shift+Enter is a newline, Stop closes the stream), starter prompts, the Pipeline hand-off
// (#/agent?prompt=… fills the composer and never sends), read-only scheduled runs that poll while
// running, and cleanup of streams and polls when the screen goes away (Review Focus 5).
//
// Every turn goes to the fake opencode (tests/e2e/fake-bin/opencode): a plain message gets one
// tool step and "Fake agent reply: <first 40 chars>", SLOW streams 20 steps 0.4s apart, FAIL
// ends in an error event.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { SEED } from '../harness/seed.mjs';

const { berlin, scheduled, notes } = SEED.chats;
const RUN_PREFIX = 'Scheduled run — ';
const CHAT_URL = /#\/agent\/[0-9a-f-]{36}$/;

// ---- Page instrumentation (installed before the app loads) ----

/** Record every EventSource the page opens, so a test can check they were all closed. */
async function trackStreams(page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.__streams = [];
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        window.__streams.push(this);
      }
    };
  });
}

/** How many tracked EventSources are not closed yet (readyState 2 = CLOSED). */
const openStreams = (page) =>
  page.evaluate(() => (window.__streams || []).filter((s) => s.readyState !== 2).length);
const streamCount = (page) => page.evaluate(() => (window.__streams || []).length);

/** Record live setInterval handles with their delay, so a test can see a poller stop. */
async function trackIntervals(page) {
  await page.addInitScript(() => {
    const set = window.setInterval.bind(window);
    const clear = window.clearInterval.bind(window);
    window.__intervals = new Map();
    window.setInterval = (fn, ms, ...rest) => {
      const id = set(fn, ms, ...rest);
      window.__intervals.set(id, ms);
      return id;
    };
    window.clearInterval = (id) => {
      window.__intervals.delete(id);
      return clear(id);
    };
  });
}

/** Live 2-second pollers (the run-transcript poll; the store polls every 30s). */
const runPolls = (page) =>
  page.evaluate(() => [...(window.__intervals || new Map()).values()].filter((ms) => ms === 2000).length);

/** Write to the throwaway workspace DB (the server only ever runs in a temp COLDTRAIL_HOME). */
function dbRun(server, sql, ...params) {
  const db = new DatabaseSync(join(server.home, 'outreach.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/**
 * Read the workspace DB. Like `server.query`, but it waits out the server's write locks (the
 * harness helper has no busy timeout, so it can throw "database is locked" mid-turn).
 */
function dbAll(server, sql, ...params) {
  const db = new DatabaseSync(join(server.home, 'outreach.db'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).all(...params).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/** POSTs to /api/chat (a turn started) seen by the page. */
function chatPosts(page) {
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat') posts.push(r.postDataJSON());
  });
  return posts;
}

/**
 * Hold back the POST /api/chat whose message contains `marker` until release(): the server
 * hasn't started that turn yet. `held` settles once the page has sent it.
 */
async function holdTurn(page, marker) {
  let release = () => {};
  let onHeld = () => {};
  const gate = new Promise((r) => (release = r));
  const held = new Promise((r) => (onHeld = r));
  await page.route('**/api/chat', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && (req.postData() || '').includes(marker)) {
      onHeld();
      await gate;
    }
    await route.fallback();
  });
  return { held, release };
}

/** A turn's stream being claimed (the view opens /api/chat/stream?run=…). */
const streamClaimed = (page) => page.waitForRequest((r) => new URL(r.url()).pathname === '/api/chat/stream');

/** Agent replies the server saved with this text (0 when the turn was cancelled first). */
const savedReplies = (server, text) =>
  dbAll(server, "SELECT count(*) AS n FROM chat_messages WHERE role = 'assistant' AND content = ?", text)[0].n;

// ---- Locators ----

const composer = (page) => page.getByRole('textbox', { name: 'Message the agent' });
const transcript = (page) => page.getByRole('region', { name: 'Conversation' });
const convNav = (page) => page.getByRole('navigation', { name: 'Conversations' });
const section = (page, name) => convNav(page).getByRole('list', { name });
const sendBtn = (page) => page.getByRole('button', { name: 'Send', exact: true });
const stopBtn = (page) => page.getByRole('button', { name: 'Stop', exact: true });
const chatTitle = (page) => page.locator('.agent-chat-title');

async function openAgent(app, page, hash = '#/agent') {
  await app.goto(hash);
  await expect(page.locator('#view h1')).toHaveText('Agent');
}

async function send(page, text) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

const idFromUrl = (page) => decodeURIComponent(new URL(page.url()).hash.split('/')[2] || '');

// ---- Tests (one server, in order) ----

test('lists conversations in sections, opens one by URL, and filters by search', async ({ app, page }) => {
  await openAgent(app, page);
  await expect(page).toHaveTitle('Agent · coldtrail');
  // Without a ?prompt= hand-off, focus lands on the heading, as on every screen.
  await expect(page.locator('#view h1')).toBeFocused();
  const mine = section(page, 'Your chats');
  const runs = section(page, 'Scheduled runs');
  // Most recently updated first; runs drop the "Scheduled run —" prefix their section says.
  await expect(mine.locator('.agent-item-title')).toHaveText([berlin.title, notes.title]);
  await expect(runs.locator('.agent-item-title')).toHaveText([scheduled.title.slice(RUN_PREFIX.length)]);
  await expect(mine.getByRole('link').first()).toHaveAttribute('href', `#/agent/${berlin.id}`);
  // Relative times in the meta line.
  await expect(mine.locator('.agent-item-meta').first()).toHaveText('1h ago');
  // A new conversation is current: nothing in the list is.
  await expect(convNav(page).locator('[aria-current="page"]')).toHaveCount(0);
  await expect(chatTitle(page)).toHaveText('New conversation');

  await mine.getByRole('link', { name: new RegExp(notes.title) }).click();
  await expect(page).toHaveURL(new RegExp(`#/agent/${notes.id}$`));
  await expect(chatTitle(page)).toHaveText(notes.title);
  await expect(mine.getByRole('link', { name: new RegExp(notes.title) })).toHaveAttribute('aria-current', 'page');
  await expect(transcript(page).locator('.agent-msg-agent')).toHaveText(
    'Done — 6 LinkedIn notes are in Drafts, each under 240 characters.',
  );

  // Back returns to the new conversation; forward reopens the chat.
  await page.goBack();
  await expect(page).toHaveURL(/#\/agent$/);
  await expect(chatTitle(page)).toHaveText('New conversation');
  await page.goForward();
  await expect(chatTitle(page)).toHaveText(notes.title);

  const search = page.getByRole('searchbox', { name: 'Search conversations' });
  await search.fill('linkedin');
  await expect(convNav(page).locator('.agent-item-title')).toHaveText([notes.title]);
  await expect(runs).toHaveCount(0);
  await search.fill('lunch');
  await expect(convNav(page).locator('.agent-item-title')).toHaveText(['Lunch Source']);
  await search.fill('zzz nothing');
  await expect(convNav(page).getByText('No conversations match “zzz nothing”')).toBeVisible();
  await search.fill('');
  await expect(convNav(page).locator('.agent-item-title')).toHaveCount(3);
});

test('markdown renders and scripts do not', async ({ app, page }) => {
  const activated = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/chats/${berlin.id}/activate`,
  );
  await openAgent(app, page, `#/agent/${berlin.id}`);
  await activated; // a regular chat becomes the server's active conversation, as before
  await expect(chatTitle(page)).toHaveText(berlin.title);
  const log = transcript(page);
  await expect(log.locator('.agent-msg-user')).toHaveText([berlin.title]);
  const reply = log.locator('.agent-msg-agent');
  await expect(reply.locator('strong')).toHaveText(['24', '11']);
  await expect(reply.locator('li')).toHaveText([
    '9 email drafts are waiting in Drafts',
    '2 LinkedIn notes are ready to send',
  ]);
  await expect(reply.locator('code')).toHaveText('coldtrail find-emails 20');
  const link = reply.getByRole('link', { name: 'the Canonical docs' });
  await expect(link).toHaveAttribute('href', 'https://trycanonical.ai/docs');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('target', '_blank');
  // The hostile tag is text, not an element.
  await expect(reply).toContainText('<img src=x onerror=window.__xss=5>');
  await expect(log.locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  // The two stored tool rows collapse into one group, closed by default.
  const toggle = log.getByRole('button', { name: 'Worked · 2 steps' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(log.locator('.agent-steps')).toBeHidden();
  await toggle.press('Enter'); // keyboard opens it
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(log.locator('.agent-step-name')).toHaveText([
    '$ coldtrail source "fintech startups in Berlin" "Berl…',
    '$ coldtrail find-emails 20',
  ]);
  await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(log.locator('.agent-steps')).toBeHidden();

  // A regular chat can be continued.
  await expect(composer(page)).toBeEditable();
  await expect(page.locator('.agent-readonly')).toHaveCount(0);
});

test('scheduled run conversation opens read-only', async ({ app, page }) => {
  const activations = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/activate$/.test(new URL(r.url()).pathname)) activations.push(r.url());
  });
  await openAgent(app, page);
  await section(page, 'Scheduled runs').getByRole('link', { name: /Lunch Source/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/agent/${scheduled.id}$`));
  await expect(chatTitle(page)).toHaveText(scheduled.title);
  const head = page.locator('.agent-chat-head');
  await expect(head.getByText('Read-only', { exact: true })).toBeVisible();
  // The run's outcome from the run history, in the words Schedules uses. Its time is when it
  // finished (/api/runs `started_at` is written at the end of a run).
  const run = SEED.runs.find((r) => r.chat_id === scheduled.id);
  await expect(head.getByText('Succeeded', { exact: true })).toBeVisible();
  await expect(page.locator('.agent-chat-meta')).toHaveText(
    new RegExp(
      `^Finished \\S.* · ${run.sourced} sourced · ${run.enriched} enriched · ${run.drafted} drafted · ${run.sent} sent$`,
    ),
  );

  // No composer: a note says how to follow up instead.
  await expect(composer(page)).toHaveCount(0);
  await expect(sendBtn(page)).toHaveCount(0);
  const note = page.locator('.agent-readonly');
  await expect(note).toContainText('Scheduled runs are a read-only log');
  // The automated brief is folded away; the steps are one group; the report renders.
  const log = transcript(page);
  const brief = log.locator('details.agent-brief');
  await expect(brief.locator('summary')).toHaveText('Run brief');
  await expect(brief).not.toHaveAttribute('open', /.*/);
  await expect(log.locator('.agent-msg-user')).toHaveCount(0);
  await expect(log.getByRole('button', { name: 'Worked · 3 steps' })).toBeVisible();
  await expect(log.locator('.agent-msg-agent ol li')).toHaveCount(2);
  expect(activations).toEqual([]); // nothing will be sent here, so it is not made active

  // "Start a new chat" leaves the run for a fresh conversation.
  await note.getByRole('button', { name: 'Start a new chat' }).click();
  await expect(page).toHaveURL(/#\/agent$/);
  await expect(composer(page)).toBeFocused();
});

test('a failed run says why it ended', async ({ app, page, server }) => {
  // The seeded failed run has no conversation: give it one that recorded nothing.
  const id = 'run-failed-log';
  dbRun(
    server,
    "INSERT INTO chat_sessions (id, agent_session_id, title, created_at, updated_at) VALUES (?, 'ses-run-failed', 'Scheduled run — Lunch Source', datetime('now', '-1 day'), datetime('now', '-1 day'))",
    id,
  );
  dbRun(server, "UPDATE scheduled_runs SET chat_id = ? WHERE status = 'error'", id);
  const empty = transcript(page).locator('.empty-state');
  try {
    await openAgent(app, page, `#/agent/${id}`);
    const head = page.locator('.agent-chat-head');
    await expect(head.getByText('Failed', { exact: true })).toBeVisible();
    const log = transcript(page);
    // Inside the conversation, under its h2.
    await expect(log.getByRole('heading', { level: 3, name: 'This run recorded nothing' })).toBeVisible();
    // The reason sits under the explanation, before the action, in place of a pointer to the
    // run history (which would only say the same thing).
    await expect(empty.locator('.agent-run-note')).toHaveText('Failed: opencode exited with status 1');
    await expect(empty.locator('.empty-body')).toHaveText('It ended before the agent started.');
    expect(await empty.evaluate((el) => [...el.children].map((c) => c.className))).toEqual([
      'empty-title',
      'empty-body',
      'agent-error agent-run-note',
      'empty-action',
    ]);
    await expect(empty.getByRole('link', { name: 'Open Schedules' })).toHaveAttribute('href', '#/schedules');
    await expect(log.getByRole('alert')).toHaveCount(0); // stored, not news: not announced

    // A sign-in failure reads, and is toned, like its badge.
    dbRun(server, "UPDATE scheduled_runs SET status = 'auth_failed' WHERE chat_id = ?", id);
    await page.reload();
    await expect(head.getByText('Sign-in failed', { exact: true })).toBeVisible();
    await expect(log.locator('.agent-run-note')).toHaveText('Sign-in failed: opencode exited with status 1');
    await expect(log.locator('.agent-run-note')).toHaveClass(/\bis-warn\b/);

    // A run with no recorded reason points to the run history instead.
    dbRun(server, 'UPDATE scheduled_runs SET note = NULL WHERE chat_id = ?', id);
    await page.reload();
    await expect(head.getByText('Sign-in failed', { exact: true })).toBeVisible();
    await expect(empty.locator('.empty-body')).toHaveText(
      'It ended before the agent started. The run history in Schedules shows how it finished.',
    );
    await expect(log.locator('.agent-run-note')).toHaveCount(0);
  } finally {
    dbRun(server, "UPDATE scheduled_runs SET status = 'error', note = 'opencode exited with status 1' WHERE chat_id = ?", id);
    dbRun(server, "UPDATE scheduled_runs SET chat_id = NULL WHERE chat_id = ?", id);
    dbRun(server, 'DELETE FROM chat_sessions WHERE id = ?', id);
  }
});

test('a running scheduled run polls until it finishes and stops polling when you leave', async ({ app, page, server }) => {
  await trackIntervals(page);
  dbRun(server, 'UPDATE chat_sessions SET running = 1 WHERE id = ?', scheduled.id);
  let added = null;
  try {
    // The top-bar chip links a live run to its conversation.
    await app.goto('#/home');
    const chip = page.locator('#topbar .chip');
    await expect(chip).toContainText(`Running · ${scheduled.title}`);
    await chip.click();
    await expect(page).toHaveURL(new RegExp(`#/agent/${scheduled.id}$`));
    const head = page.locator('.agent-chat-head');
    const meta = page.locator('.agent-chat-meta');
    await expect(head.getByText('Running', { exact: true })).toBeVisible();
    // A live run has no outcome yet: no finish time or status from an earlier row. When it last
    // wrote shows whether it is still going (this one's last step is two days old).
    await expect(meta).toHaveText(/^Updates as the run works · last update [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d$/);
    await expect(head.getByText('Succeeded', { exact: true })).toHaveCount(0);
    await expect(page.locator('.agent-readonly')).toBeVisible();
    await expect(transcript(page).locator('.agent-working')).toBeVisible();
    await expect.poll(() => runPolls(page)).toBe(1);

    // The reader opens the brief, and the steps with the keyboard.
    const log = transcript(page);
    await log.locator('details.agent-brief summary').click();
    const worked = log.getByRole('button', { name: 'Worked · 3 steps' });
    await worked.focus();
    await page.keyboard.press('Enter');
    await expect(worked).toHaveAttribute('aria-expanded', 'true');

    // The run writes a new step: the poll shows it as live work.
    added = dbRun(
      server,
      "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'tool', '$ coldtrail status', datetime('now'))",
      scheduled.id,
    ).lastInsertRowid;
    const live = log.getByRole('button', { name: 'Working… · 1 step' });
    await expect(live).toBeVisible();
    await expect(meta).toHaveText('Updates as the run works · last update just now');
    // The redraw kept what the reader opened, and their place: focus is still on the steps.
    await expect(worked).toBeFocused();
    await expect(worked).toHaveAttribute('aria-expanded', 'true');
    await expect(log.locator('.agent-step-name').first()).toBeVisible();
    await expect(log.locator('details.agent-brief')).toHaveAttribute('open', '');

    // The run finishes: the badge goes, the group closes, the poll stops.
    dbRun(server, 'UPDATE chat_sessions SET running = 0 WHERE id = ?', scheduled.id);
    await expect(head.getByText('Running', { exact: true })).toHaveCount(0);
    await expect(head.getByText('Succeeded', { exact: true })).toBeVisible();
    await expect(meta).toHaveText(/^Finished /);
    await expect(transcript(page).getByRole('button', { name: 'Worked · 1 step' })).toBeVisible();
    await expect(transcript(page).locator('.agent-working')).toHaveCount(0);
    await expect.poll(() => runPolls(page)).toBe(0);

    // Running again, then leave the screen: the poll goes with it.
    dbRun(server, 'UPDATE chat_sessions SET running = 1 WHERE id = ?', scheduled.id);
    await page.reload();
    await expect(head.getByText('Running', { exact: true })).toBeVisible();
    await expect.poll(() => runPolls(page)).toBe(1);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home/ }).click();
    await expect(page.locator('#view h1')).toHaveText('Home');
    await expect.poll(() => runPolls(page)).toBe(0);
  } finally {
    dbRun(server, 'UPDATE chat_sessions SET running = 0 WHERE id = ?', scheduled.id);
    if (added != null) dbRun(server, 'DELETE FROM chat_messages WHERE id = ?', added);
  }
});

test('new chat streams a fake reply with a tool group', async ({ app, page, server }) => {
  await trackStreams(page);
  await openAgent(app, page);
  await expect(page.getByRole('heading', { name: 'What should the agent work on?' })).toBeVisible();
  await expect(page.locator('.agent-model')).toHaveText('opencode · fake/model-a');
  await expect(page.locator('.agent-model')).toHaveAttribute('href', '#/settings?tab=agent');

  await send(page, 'Hello there agent');
  const log = transcript(page);
  await expect(log.locator('.agent-msg-user')).toHaveText(['Hello there agent']);
  await expect(composer(page)).toHaveValue('');
  await expect(log.locator('.agent-msg-agent')).toHaveText(['Fake agent reply: Hello there agent']);
  const toggle = log.getByRole('button', { name: 'Worked · 1 step' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(log.locator('.agent-step-name')).toHaveText(['$ coldtrail status']);
  await expect(log.locator('.agent-step')).toHaveAttribute('data-state', 'ok');
  // The tool group sits between the question and the answer.
  await expect(log.locator('.agent-msg-user, .agent-tools, .agent-msg-agent')).toHaveClass([
    /agent-msg-user/,
    /agent-tools/,
    /agent-msg-agent/,
  ]);

  // The new conversation gets its own address and shows up in the list, current.
  await expect(page).toHaveURL(CHAT_URL);
  const id = idFromUrl(page);
  const item = section(page, 'Your chats').getByRole('link', { name: /Hello there agent/ });
  await expect(item).toHaveAttribute('aria-current', 'page');
  await expect(item).toHaveAttribute('href', `#/agent/${id}`);
  await expect(chatTitle(page)).toHaveText('Hello there agent');
  await expect(sendBtn(page)).toBeEnabled();
  await expect.poll(() => openStreams(page)).toBe(0);
  await expect
    .poll(() => dbAll(server, 'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id', id))
    .toEqual([
      { role: 'user', content: 'Hello there agent' },
      { role: 'assistant', content: 'Fake agent reply: Hello there agent' },
    ]);

  // A second turn continues the same conversation.
  await send(page, 'And a follow-up');
  await expect(log.locator('.agent-msg-agent')).toHaveText([
    'Fake agent reply: Hello there agent',
    'Fake agent reply: And a follow-up',
  ]);
  await expect(page).toHaveURL(new RegExp(`#/agent/${id}$`));
  await expect
    .poll(() => dbAll(server, 'SELECT count(*) AS n FROM chat_messages WHERE session_id = ?', id))
    .toEqual([{ n: 4 }]);
  expect(await streamCount(page)).toBe(2);

  // A reload shows what was saved (tool steps of web chats are not stored).
  await page.reload();
  await expect(transcript(page).locator('.agent-msg-user')).toHaveText(['Hello there agent', 'And a follow-up']);
  await expect(transcript(page).locator('.agent-msg-agent')).toHaveCount(2);
});

test('streamed text renders markdown safely and tool results pair with their steps', async ({ app, page }) => {
  // A canned stream (no server turn): two parallel tool calls, one failing, then markdown.
  const events = [
    { type: 'tool_start', name: 'Bash', input: {} },
    { type: 'tool_start', name: 'WebSearch', input: {} },
    { type: 'tool_end', ok: true },
    { type: 'tool_end', ok: false },
    { type: 'text', text: 'Sourced **3** companies:\n\n- one\n- two\n\n' },
    { type: 'text', text: '<img src=x onerror=window.__xss=7> and [docs](javascript:alert(1))' },
    { type: 'done', ok: true, result: null },
  ];
  await page.route('**/api/chat', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { run: 'canned-run' } })
      : route.fallback(),
  );
  await page.route('**/api/chat/stream?*', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
    }),
  );
  await openAgent(app, page);
  await send(page, 'Canned stream please');
  const log = transcript(page);
  const reply = log.locator('.agent-msg-agent');
  await expect(reply.locator('strong')).toHaveText('3');
  await expect(reply.locator('li')).toHaveText(['one', 'two']);
  await expect(reply).toContainText('<img src=x onerror=window.__xss=7> and [docs](javascript:alert(1))');
  await expect(log.locator('img, script, a[href^="javascript"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  const toggle = log.getByRole('button', { name: 'Worked · 2 steps · 1 failed' });
  await toggle.click();
  await expect(log.locator('.agent-step-name')).toHaveText(['Bash', 'WebSearch']);
  expect(await log.locator('.agent-step').evaluateAll((els) => els.map((e) => e.dataset.state))).toEqual([
    'ok',
    'fail',
  ]);
  await expect(sendBtn(page)).toBeEnabled();
});

test('Stop ends a SLOW turn and re-enables the composer', async ({ app, page }) => {
  await trackStreams(page);
  await openAgent(app, page);
  await send(page, 'Please go SLOW today');
  const log = transcript(page);
  await expect(log.locator('.agent-msg-user')).toHaveText(['Please go SLOW today']);
  // The header names the conversation the message is starting, not "Saved once you send…".
  await expect(chatTitle(page)).toHaveText('Please go SLOW today');
  await expect(page.locator('.agent-chat-meta')).toBeEmpty();
  const headHeight = () => page.locator('.agent-chat-head').evaluate((el) => el.getBoundingClientRect().height);
  const pendingHeight = await headHeight();
  // Live: the group counts steps as they land and says it is working.
  await expect(log.getByRole('button', { name: /^Working… · ([2-9]|1\d) steps$/ })).toBeVisible();
  await expect(sendBtn(page)).toHaveCount(0);
  await expect(composer(page)).toBeEditable(); // the next message can be typed meanwhile

  await stopBtn(page).click();
  await expect(stopBtn(page)).toHaveCount(0);
  await expect(sendBtn(page)).toBeEnabled();
  await expect(log.locator('.agent-note')).toHaveText('Stopped');
  await expect(log.getByRole('button', { name: /^Worked · \d+ steps$/ })).toBeVisible();
  await expect(log.locator('.agent-working')).toHaveCount(0);
  await expect.poll(() => openStreams(page)).toBe(0);
  // The stopped conversation keeps its address.
  await expect(page).toHaveURL(CHAT_URL);
  const id = idFromUrl(page);

  await expect(chatTitle(page)).toHaveText('Please go SLOW today');
  await expect(page.locator('.agent-chat-meta')).toHaveText(/^Updated /);
  // The meta line arriving doesn't move the transcript down.
  expect(await headHeight()).toBeCloseTo(pendingHeight, 1);

  // The server cancelled the turn, so the next one is answered right away, in the same chat.
  await send(page, 'Next question');
  await expect(log.locator('.agent-msg-agent').last()).toHaveText('Fake agent reply: Next question');
  await expect(page).toHaveURL(new RegExp(`#/agent/${id}$`));
});

test('Stop before the message is sent keeps it from the agent and gives it back', async ({ app, page }) => {
  const posts = chatPosts(page);
  /** Hold POST /api/chats/new (the step before the message goes out) until release(). */
  const holdNew = async () => {
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    let onHeld = () => {};
    const held = new Promise((r) => (onHeld = r));
    await page.route('**/api/chats/new', async (route) => {
      onHeld();
      await gate;
      await route.fallback();
    });
    return { held, release };
  };
  await openAgent(app, page);
  const log = transcript(page);
  const note = log.locator('.agent-note');

  let gate = await holdNew();
  await send(page, 'Not yet, stop me');
  await gate.held;
  await stopBtn(page).click();
  await expect(note).toHaveText('Stopped');
  gate.release();
  // Nothing went out: the message is back in the composer, the conversation is still new.
  await expect(note).toHaveText('Stopped before it was sent. Your message is back in the composer.');
  await expect(composer(page)).toHaveValue('Not yet, stop me');
  await expect(log.locator('.agent-msg-user')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What should the agent work on?' })).toBeVisible();
  await expect(chatTitle(page)).toHaveText('New conversation');
  await expect(page).toHaveURL(/#\/agent$/);
  await page.unroute('**/api/chats/new');
  expect(posts).toEqual([]);

  // Sending it now works, in a conversation of its own.
  await composer(page).press('Enter');
  await expect(log.locator('.agent-msg-agent')).toHaveText('Fake agent reply: Not yet, stop me');
  await expect(page).toHaveURL(CHAT_URL);
  expect(posts).toEqual([{ message: 'Not yet, stop me' }]);

  // Stopped while something new is being typed: that stays, and the bubble says it wasn't sent.
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  gate = await holdNew();
  await send(page, 'Second thoughts');
  await gate.held;
  await stopBtn(page).click();
  await composer(page).fill('Something else');
  gate.release();
  await expect(note).toHaveText('Stopped before it was sent.');
  await expect(log.locator('.agent-msg-user.is-unsent')).toContainText('Second thoughts');
  await expect(log.locator('.agent-msg-user.is-unsent .agent-unsent')).toHaveText('Not sent');
  await expect(composer(page)).toHaveValue('Something else');
  await expect(page).toHaveURL(/#\/agent$/);
  await page.unroute('**/api/chats/new');
  expect(posts).toEqual([{ message: 'Not yet, stop me' }]);
});

test('Stop while the message is on its way: the conversation it started stays on screen', async ({ app, page, server }) => {
  // More than 60 characters and two lines: the server titles it with the first 60 on one line.
  const text = 'Hold this SLOW message while a scheduled run starts, then stop it\nplease';
  const title = `${text.replace('\n', ' ').slice(0, 60)}…`;
  const sneaky = 'run-started-meanwhile';
  const turn = await holdTurn(page, 'Hold this SLOW message');
  try {
    await openAgent(app, page);
    await send(page, text);
    await turn.held; // the server hasn't got it yet
    await expect(chatTitle(page)).toHaveText(title);
    await stopBtn(page).click();
    await expect(sendBtn(page)).toBeVisible();
    // A scheduled run starts meanwhile: a new conversation too, but not this one.
    dbRun(
      server,
      "INSERT INTO chat_sessions (id, agent_session_id, title, created_at, updated_at) VALUES (?, 'ses-sneaky', 'Scheduled run — Sneaky', datetime('now'), datetime('now'))",
      sneaky,
    );
    const claimed = streamClaimed(page);
    turn.release();
    await claimed; // the view claims the turn, which cancels it
    await expect(page).toHaveURL(CHAT_URL);
    const id = idFromUrl(page);
    expect(id).not.toBe(sneaky);
    expect(dbAll(server, 'SELECT title FROM chat_sessions WHERE id = ?', id)).toEqual([{ title }]);
    await expect(chatTitle(page)).toHaveText(title);
    await expect(section(page, 'Your chats').locator('[aria-current="page"]')).toHaveAttribute('href', `#/agent/${id}`);
    await expect(section(page, 'Scheduled runs').locator('[aria-current="page"]')).toHaveCount(0);

    // The next message continues that conversation.
    await page.unroute('**/api/chat');
    await send(page, 'Next after stop');
    await expect(transcript(page).locator('.agent-msg-agent').last()).toHaveText('Fake agent reply: Next after stop');
    expect(dbAll(server, "SELECT session_id FROM chat_messages WHERE role = 'user' AND content = 'Next after stop'")).toEqual([
      { session_id: id },
    ]);
    await expect(page).toHaveURL(new RegExp(`#/agent/${id}$`));
    // The stopped turn kept its message but was cancelled before it wrote a reply.
    await expect
      .poll(() => dbAll(server, 'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id', id))
      .toEqual([
        { role: 'user', content: text },
        { role: 'user', content: 'Next after stop' },
        { role: 'assistant', content: 'Fake agent reply: Next after stop' },
      ]);
  } finally {
    dbRun(server, 'DELETE FROM chat_sessions WHERE id = ?', sneaky);
  }
});

test('a first turn stopped while another holds the server keeps its conversation once the server is free', async ({
  app,
  page,
  server,
  request,
}) => {
  test.setTimeout(60_000);
  // Another tab's turns hold the server's one-turn lock: two SLOW ones (20 steps × 0.4s each)
  // whose streams nobody claims. The conversation this screen starts is only saved once its
  // turn gets the lock, long after Stop.
  const blocker = 'Hold the lock SLOW, from another tab';
  await request.post(server.apiUrl('/api/chats/new'));
  for (const message of [blocker, `${blocker} again`]) {
    expect((await request.post(server.apiUrl('/api/chat'), { data: { message } })).ok()).toBe(true);
  }
  const blockerChat = () => dbAll(server, 'SELECT id FROM chat_sessions WHERE title = ?', blocker);
  try {
    await expect.poll(() => blockerChat().length).toBe(1); // the first one has the lock
    await openAgent(app, page);
    const text = 'Queued behind the other tab';
    const claimed = streamClaimed(page);
    await send(page, text);
    await claimed; // the server has the message; its turn waits for the lock
    await stopBtn(page).click();
    const log = transcript(page);
    const note = log.locator('.agent-note');
    await expect(note).toHaveText('Stopped');
    // The wait outlasts the first looks: the note says what it is waiting for, and the screen
    // still shows the conversation the message started.
    await expect(note).toHaveText("Stopped. The agent is busy with another turn; this conversation is saved once it's free.");
    await expect(chatTitle(page)).toHaveText(text);
    await expect(page).toHaveURL(/#\/agent$/);

    // The lock frees: the stopped turn's conversation is saved and takes the screen's address.
    await expect(page).toHaveURL(CHAT_URL, { timeout: 30_000 });
    const id = idFromUrl(page);
    await expect(note).toHaveText('Stopped');
    await expect(chatTitle(page)).toHaveText(text);
    await expect(section(page, 'Your chats').locator('[aria-current="page"]')).toHaveAttribute('href', `#/agent/${id}`);

    // The next message continues it: one transcript on screen, one conversation on the server.
    await send(page, 'Follow-up after the wait');
    await expect(log.locator('.agent-msg-agent').last()).toHaveText('Fake agent reply: Follow-up after the wait');
    await expect(page).toHaveURL(new RegExp(`#/agent/${id}$`));
    const userRows = dbAll(
      server,
      "SELECT session_id, content FROM chat_messages WHERE role = 'user' AND content IN (?, ?) ORDER BY id",
      text,
      'Follow-up after the wait',
    );
    expect(userRows).toEqual([
      { session_id: id, content: text },
      { session_id: id, content: 'Follow-up after the wait' },
    ]);
  } finally {
    for (const { id } of blockerChat()) {
      dbRun(server, 'DELETE FROM chat_messages WHERE session_id = ?', id);
      dbRun(server, 'DELETE FROM chat_sessions WHERE id = ?', id);
    }
  }
});

test('a stopped first turn still not saved after two minutes leaves a new conversation on screen', async ({ app, page }) => {
  // As if another tab's turn held the server all that time: the list never shows the stopped
  // turn's conversation, and the clock skips the wait.
  const text = 'Never listed, SLOW';
  await page.clock.install();
  await page.route('**/api/chats', async (route) => {
    const res = await route.fetch();
    const rows = (await res.json()).filter((/** @type {{ title: string }} */ c) => c.title !== text);
    await route.fulfill({ response: res, json: rows });
  });
  await openAgent(app, page);
  const claimed = streamClaimed(page);
  await send(page, text);
  await claimed;
  await stopBtn(page).click();
  const log = transcript(page);
  const note = log.locator('.agent-note');
  await expect(note).toHaveText("Stopped. The agent is busy with another turn; this conversation is saved once it's free.");
  await page.clock.fastForward('02:10');
  // The next message would start another conversation, so the screen doesn't show it under
  // this one: it starts afresh and says where the stopped message goes.
  await expect(note).toHaveText(
    "Stopped. The agent is still busy with another turn, so your message is saved as a conversation of its own once it's free.",
  );
  await expect(chatTitle(page)).toHaveText('New conversation');
  await expect(log.locator('.agent-msg-user')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What should the agent work on?' })).toBeVisible();
  await expect(page).toHaveURL(/#\/agent$/);

  await page.unroute('**/api/chats');
  await send(page, 'A fresh start');
  await expect(log.locator('.agent-msg-user')).toHaveText(['A fresh start']);
  await expect(log.locator('.agent-msg-agent')).toHaveText('Fake agent reply: A fresh start');
  await expect(page).toHaveURL(CHAT_URL);
});

test('a message stopped before it was sent comes back after you move on', async ({ app, page }) => {
  const posts = chatPosts(page);
  /** Hold POST /api/chats/new (the step before the message goes out) until release(). */
  const holdNew = async () => {
    let release = () => {};
    const gate = new Promise((r) => (release = r));
    let onHeld = () => {};
    const held = new Promise((r) => (onHeld = r));
    await page.route('**/api/chats/new', async (route) => {
      onHeld();
      await gate;
      // The page may have given up on it (leaving the screen aborts it).
      await route.fallback().catch(() => {});
    });
    return { held, release };
  };
  const mainNav = page.getByRole('navigation', { name: 'Main' });
  await openAgent(app, page);

  // Stopped, then another conversation opened before the server answered: the composer, which
  // every conversation shares, gets the text back; that conversation's transcript isn't told.
  let gate = await holdNew();
  await send(page, 'Stopped, then I opened another chat');
  await gate.held;
  await stopBtn(page).click();
  await section(page, 'Your chats').getByRole('link', { name: new RegExp(notes.title) }).click();
  await expect(chatTitle(page)).toHaveText(notes.title);
  gate.release();
  await expect(composer(page)).toHaveValue('Stopped, then I opened another chat');
  await expect(transcript(page).locator('.agent-note, .agent-msg-user.is-unsent')).toHaveCount(0);
  await page.unroute('**/api/chats/new');

  // Stopped, then the screen went away: the text waits in the composer for it.
  await composer(page).fill('');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(chatTitle(page)).toHaveText('New conversation');
  gate = await holdNew();
  await send(page, 'Stopped, then I left');
  await gate.held;
  await stopBtn(page).click();
  await mainNav.getByRole('link', { name: /^Home/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  gate.release();
  await mainNav.getByRole('link', { name: 'Agent', exact: true }).click();
  await expect(page.locator('#view h1')).toHaveText('Agent');
  await expect(composer(page)).toHaveValue('Stopped, then I left');
  await page.unroute('**/api/chats/new');
  expect(posts).toEqual([]);
});

test('FAIL turn shows the error', async ({ app, page, server }) => {
  await openAgent(app, page);
  await send(page, 'Please FAIL now');
  const log = transcript(page);
  await expect(log.getByRole('alert')).toContainText('Fake failure');
  await expect(sendBtn(page)).toBeEnabled();
  await expect(log.locator('.agent-working')).toHaveCount(0);
  // The server discarded the failed first turn: the header is back to a new conversation.
  await expect(chatTitle(page)).toHaveText('New conversation');
  // A failed first turn leaves no conversation behind, so the address stays "new".
  await expect
    .poll(() => dbAll(server, "SELECT count(*) AS n FROM chat_sessions WHERE title = 'Please FAIL now'"))
    .toEqual([{ n: 0 }]);
  await expect(page).toHaveURL(/#\/agent$/);
  await page.reload();
  await expect(section(page, 'Your chats').locator('.agent-item-title').first()).toBeVisible();
  await expect(convNav(page).getByRole('link', { name: /Please FAIL now/ })).toHaveCount(0);
});

test('navigating away mid-stream leaves no console errors', async ({ app, page }) => {
  await trackStreams(page);
  await openAgent(app, page);
  await send(page, 'Walk away SLOW');
  await expect(transcript(page).getByRole('button', { name: /^Working… · \d+ steps?$/ })).toBeVisible();
  expect(await openStreams(page)).toBe(1);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  await expect.poll(() => openStreams(page)).toBe(0);

  // Coming back works, and the server is free again (the abandoned turn was cancelled). The
  // message that was sent isn't offered again.
  await page.goBack();
  await expect(page.locator('#view h1')).toHaveText('Agent');
  await expect(composer(page)).toHaveValue('');
  await send(page, 'Back again');
  await expect(transcript(page).locator('.agent-msg-agent').last()).toHaveText('Fake agent reply: Back again');
  // The fixture fails this test on any console error or uncaught page error.
});

test('leaving a turn asks first, and a turn left while it starts is cancelled on the server', async ({ app, page, server }) => {
  // A SLOW turn takes 20 × 0.4s. Left unclaimed it would hold the server's one-turn lock that
  // long (or until a 45s reaper), and the next turn would wait for it; claimed and closed, it
  // stops at its next step without saving a reply.
  const first = await holdTurn(page, 'Abandon me SLOW');
  await openAgent(app, page);
  await send(page, 'Abandon me SLOW');
  await first.held; // the server hasn't seen it yet
  await expect(stopBtn(page)).toBeVisible();
  await expect(page.locator('.agent-hint-busy')).toHaveText('Leaving this conversation stops the agent.');

  // Another conversation, or New chat, asks first; Stay keeps the turn.
  const runLink = section(page, 'Scheduled runs').getByRole('link', { name: /Lunch Source/ });
  const dialog = page.getByRole('alertdialog', { name: 'Stop the agent?' });
  await runLink.click();
  await expect(dialog).toContainText('Leaving stops it');
  await dialog.getByRole('button', { name: 'Stay' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(runLink).toBeFocused();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await dialog.getByRole('button', { name: 'Stay' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/agent$/);
  await expect(stopBtn(page)).toBeVisible();

  // Stop and leave opens the run while the turn is still starting.
  await runLink.click();
  await dialog.getByRole('button', { name: 'Stop and leave' }).click();
  await expect(page).toHaveURL(new RegExp(`#/agent/${scheduled.id}$`));
  await expect(page.locator('.agent-readonly')).toBeVisible();
  // The message reaches the server only now: the view claims the turn's stream to cancel it.
  let claimed = streamClaimed(page);
  first.release();
  await claimed;
  await page.locator('.agent-readonly').getByRole('button', { name: 'Start a new chat' }).click();
  await send(page, 'After the switch');
  await expect(transcript(page).locator('.agent-msg-agent')).toHaveText('Fake agent reply: After the switch');
  expect(savedReplies(server, 'Fake agent reply: Abandon me SLOW')).toBe(0);
  await expect(page).toHaveURL(CHAT_URL);
  await page.unroute('**/api/chat');

  // Leaving the screen (the sidebar can't ask) while a turn starts cancels it the same way.
  const second = await holdTurn(page, 'Leave me SLOW');
  await send(page, 'Leave me SLOW');
  await second.held;
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Home/ }).click();
  await expect(page.locator('#view h1')).toHaveText('Home');
  claimed = streamClaimed(page);
  second.release();
  await claimed;
  await page.goBack();
  await expect(page.locator('#view h1')).toHaveText('Agent');
  await send(page, 'Back after leaving');
  await expect(transcript(page).locator('.agent-msg-agent').last()).toHaveText('Fake agent reply: Back after leaving');
  expect(savedReplies(server, 'Fake agent reply: Leave me SLOW')).toBe(0);
  await page.unroute('**/api/chat');
});

test('prompt query prefills composer without sending', async ({ app, page }) => {
  const posts = chatPosts(page);
  const prompt = 'Find founders and emails for acme-robotics.example, then draft an intro.';
  await openAgent(app, page, `#/agent?prompt=${encodeURIComponent(prompt)}`);
  await expect(composer(page)).toHaveValue(prompt);
  await expect(composer(page)).toBeFocused();
  // The prompt leaves the address bar (a refresh won't refill it); nothing was sent.
  await expect(page).toHaveURL(/#\/agent$/);
  await expect(page.getByRole('heading', { name: 'What should the agent work on?' })).toBeVisible();
  await expect(section(page, 'Your chats').locator('.agent-item').first()).toBeVisible();
  expect(posts).toEqual([]);

  // Arriving while another conversation is open starts a new one with the prompt.
  await section(page, 'Your chats').getByRole('link', { name: new RegExp(berlin.title) }).click();
  await expect(chatTitle(page)).toHaveText(berlin.title);
  await page.evaluate((p) => {
    location.hash = `#/agent?prompt=${encodeURIComponent(p)}`;
  }, 'Enrich beta.example');
  await expect(composer(page)).toHaveValue('Enrich beta.example');
  await expect(chatTitle(page)).toHaveText('New conversation');
  await expect(transcript(page).locator('.agent-msg-user')).toHaveCount(0);
  expect(posts).toEqual([]);

  // The user still presses Enter to send it.
  await composer(page).press('Enter');
  await expect(transcript(page).locator('.agent-msg-agent')).toHaveText('Fake agent reply: Enrich beta.example');
  expect(posts).toEqual([{ message: 'Enrich beta.example' }]);
});

test('a prompt on a conversation address opens a new chat, and Back skips that address', async ({ app, page }) => {
  const posts = chatPosts(page);
  await app.goto('#/home');
  await expect(page.locator('#view h1')).toHaveText('Home');
  await page.evaluate((id) => {
    location.hash = `#/agent/${id}?prompt=${encodeURIComponent('Hello from a link')}`;
  }, berlin.id);
  await expect(composer(page)).toHaveValue('Hello from a link');
  await expect(chatTitle(page)).toHaveText('New conversation');
  await expect(page).toHaveURL(/#\/agent$/);
  expect(posts).toEqual([]);
  // The redirect replaced the address it came from: one Back is Home, not a loop.
  await page.goBack();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator('#view h1')).toHaveText('Home');
});

test('text typed but not sent waits in the composer while you are away', async ({ app, page }) => {
  const mainNav = page.getByRole('navigation', { name: 'Main' });
  const away = async () => {
    await mainNav.getByRole('link', { name: /^Home/ }).click();
    await expect(page.locator('#view h1')).toHaveText('Home');
  };
  const back = async () => {
    await mainNav.getByRole('link', { name: 'Agent', exact: true }).click();
    await expect(page.locator('#view h1')).toHaveText('Agent');
  };
  await openAgent(app, page);
  await composer(page).fill('Half a thought about\nBerlin');
  await away();
  await back();
  await expect(composer(page)).toHaveValue('Half a thought about\nBerlin');
  expect(await composer(page).evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(44);
  await expect(page.locator('#view h1')).toBeFocused(); // focus still lands on the heading

  // Also when coming back to a conversation that opens first.
  await away();
  await page.evaluate((id) => {
    location.hash = `#/agent/${id}`;
  }, notes.id);
  await expect(chatTitle(page)).toHaveText(notes.title);
  await expect(composer(page)).toHaveValue('Half a thought about\nBerlin');

  // A hand-off from another screen replaces it, as the old composer did.
  await away();
  await page.evaluate(() => {
    location.hash = `#/agent?prompt=${encodeURIComponent('Enrich gamma.example')}`;
  });
  await expect(composer(page)).toHaveValue('Enrich gamma.example');
  await expect(composer(page)).toBeFocused();

  // Cleared text stays cleared.
  await composer(page).fill('');
  await away();
  await back();
  await expect(composer(page)).toHaveValue('');
});

test('starter prompts and Shift+Enter fill the composer; only Enter sends', async ({ app, page }) => {
  const posts = chatPosts(page);
  await openAgent(app, page);
  const starters = page.getByRole('list', { name: 'Starter prompts' }).getByRole('button');
  await expect(starters).toHaveCount(4);
  // Keyboard: Tab reaches a starter, Enter fills the composer and moves focus there.
  await starters.nth(1).focus();
  await page.keyboard.press('Enter');
  const text = await starters.nth(1).locator('.agent-starter-text').textContent();
  await expect(composer(page)).toHaveValue(text || '');
  await expect(composer(page)).toBeFocused();
  await starters.nth(0).click();
  const first = await starters.nth(0).locator('.agent-starter-text').textContent();
  await expect(composer(page)).toHaveValue(first || '');

  await composer(page).fill('line one');
  await composer(page).press('Shift+Enter');
  await composer(page).pressSequentially('line two');
  await expect(composer(page)).toHaveValue('line one\nline two');
  // The box grows with its text.
  const tall = await composer(page).evaluate((el) => el.getBoundingClientRect().height);
  expect(tall).toBeGreaterThan(44);
  expect(posts).toEqual([]);

  // An empty message is not sent.
  await composer(page).fill('   ');
  await composer(page).press('Enter');
  await sendBtn(page).click();
  expect(posts).toEqual([]);

  await composer(page).fill('line one\nline two');
  await composer(page).press('Enter');
  await expect(transcript(page).locator('.agent-msg-user')).toHaveText(['line one\nline two']);
  await expect.poll(() => posts).toEqual([{ message: 'line one\nline two' }]);
  await expect(transcript(page).locator('.agent-msg-agent')).toHaveCount(1);
});

test('a starter cut short beside the list shows its whole text on hover', async ({ app, page }) => {
  const starters = page.getByRole('list', { name: 'Starter prompts' }).getByRole('button');
  const first = starters.first().locator('.agent-starter-text');
  const cut = () => first.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  const full = 'Find 20 seed-stage B2B SaaS companies that fit my company profile and add them to the pipeline.';
  const hover = async () => {
    await page.mouse.move(0, 0);
    await first.hover();
  };

  // A laptop: two columns beside the list, each description cut to two lines.
  await page.setViewportSize({ width: 1024, height: 768 });
  await openAgent(app, page);
  await expect(first).toHaveText(full);
  expect(await cut()).toBe(true);
  await hover();
  await expect(first).toHaveAttribute('title', full);
  // On the text, not the button: a screen reader hears it once, in the button's name.
  await expect(starters.first()).toHaveAccessibleDescription('');

  // Wide enough to show it whole: no tooltip repeating it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(cut).toBe(false);
  await hover();
  await expect(first).not.toHaveAttribute('title', /.*/);

  // A phone: one column, and the transcript scrolls, so nothing is cut.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(cut).toBe(false);
});

test('hostile text in a message renders as text everywhere', async ({ app, page }) => {
  await openAgent(app, page);
  const hostile = '<img src=x onerror=window.__xss=9>';
  await send(page, hostile);
  const log = transcript(page);
  await expect(log.locator('.agent-msg-user')).toHaveText([hostile]);
  await expect(log.locator('.agent-msg-agent')).toHaveText(`Fake agent reply: ${hostile}`);
  await expect(page).toHaveURL(CHAT_URL);
  // updated_at has one-second resolution, so find it as the current item, not by position.
  await expect(section(page, 'Your chats').locator('[aria-current="page"] .agent-item-title')).toHaveText(hostile);
  await expect(chatTitle(page)).toHaveText(hostile);
  await expect(page.locator('#view img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('loading, error and retry states', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource: the server responded with a status of 500/);

  // The list shows placeholders while it loads.
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route('**/api/chats', async (route) => {
    await gate;
    await route.fallback();
  });
  await openAgent(app, page);
  await expect(page.locator('.agent-list .skeleton').first()).toBeVisible();
  release();
  await expect(section(page, 'Your chats').locator('.agent-item').first()).toBeVisible();
  await page.unroute('**/api/chats');

  // The list fails, then recovers on Try again.
  await page.route('**/api/chats', (route) => route.fulfill({ status: 500, body: 'database is locked' }));
  await page.reload();
  const listPane = page.locator('.agent-list');
  await expect(listPane.getByText("Couldn't load conversations")).toBeVisible();
  await expect(listPane.getByText('database is locked')).toBeVisible();
  await page.unroute('**/api/chats');
  await listPane.getByRole('button', { name: 'Try again' }).click();
  await expect(section(page, 'Your chats').locator('.agent-item').first()).toBeVisible();

  // A conversation fails to open, then opens on Try again.
  await page.route(`**/api/chats/${notes.id}`, (route) => route.fulfill({ status: 500, body: 'disk I/O error' }));
  await section(page, 'Your chats').getByRole('link', { name: new RegExp(notes.title) }).click();
  const log = transcript(page);
  await expect(log.getByText("Couldn't open this conversation")).toBeVisible();
  await expect(log.getByText('disk I/O error')).toBeVisible();
  await page.unroute(`**/api/chats/${notes.id}`);
  await log.getByRole('button', { name: 'Try again' }).click();
  await expect(log.locator('.agent-msg-agent')).toHaveText(
    'Done — 6 LinkedIn notes are in Drafts, each under 240 characters.',
  );

  // A conversation the server can't resume opens, but says why it can't be continued.
  await page.route(`**/api/chats/${berlin.id}/activate`, (route) =>
    route.fulfill({ status: 500, body: `conversation ${berlin.id} not found or has no session` }),
  );
  await section(page, 'Your chats').getByRole('link', { name: new RegExp(berlin.title) }).click();
  await expect(log.locator('.agent-msg-agent')).toBeVisible();
  await expect(page.locator('.agent-readonly')).toContainText(
    `This conversation can't be continued: conversation ${berlin.id} not found or has no session`,
  );
  await expect(composer(page)).toHaveCount(0);
  await page.unroute(`**/api/chats/${berlin.id}/activate`);

  // Starting a turn fails: nothing was sent, so the text goes back into the composer.
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(chatTitle(page)).toHaveText('New conversation');
  await page.route('**/api/chat', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, body: 'no workspace found' })
      : route.fallback(),
  );
  await send(page, 'This will not start');
  await expect(log.getByRole('alert')).toContainText("Couldn't start the turn: no workspace found");
  await expect(composer(page)).toHaveValue('This will not start');
  await expect(log.locator('.agent-msg-user')).toHaveCount(0);
  await expect(sendBtn(page)).toBeEnabled();
  await page.unroute('**/api/chat');
});

test('a stale session says what to do, without repeating the banner', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource/);
  const stale = (route) => route.fulfill({ status: 401, body: 'unauthorized' });
  await page.route('**/api/chats', stale);
  await page.route(`**/api/chats/${notes.id}`, stale);
  await openAgent(app, page);
  // The shell's banner gives the whole sentence once; the screen only says what to do.
  await expect(page.locator('.session-banner')).toContainText("This tab's session is stale");
  const listPane = page.locator('.agent-list');
  await expect(listPane.getByText("Couldn't load conversations")).toBeVisible();
  await expect(listPane.locator('.agent-list-msg-body')).toHaveText('Reopen coldtrail from your terminal.');

  await page.evaluate((id) => {
    location.hash = `#/agent/${id}`;
  }, notes.id);
  const log = transcript(page);
  await expect(log.getByText("Couldn't open this conversation")).toBeVisible();
  await expect(log.locator('.empty-body')).toHaveText('Reopen coldtrail from your terminal.');

  await page.route('**/api/chat', (route) => (route.request().method() === 'POST' ? stale(route) : route.fallback()));
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await send(page, 'Sent from a stale tab');
  await expect(log.getByRole('alert')).toHaveText("Couldn't start the turn: Reopen coldtrail from your terminal.");
  await expect(composer(page)).toHaveValue('Sent from a stale tab');
  await expect(page.locator('#view')).not.toContainText("This tab's session is stale");
});

test('a message sent while the conversation is still being opened waits for it', async ({ app, page }) => {
  app.allowConsole(/Failed to load resource: the server responded with a status of 500/);
  const posts = chatPosts(page);
  let release = () => {};
  const gate = new Promise((r) => (release = r));
  await page.route(`**/api/chats/${notes.id}/activate`, async (route) => {
    await gate;
    await route.fulfill({ status: 500, body: `conversation ${notes.id} not found or has no session` });
  });
  await openAgent(app, page, `#/agent/${notes.id}`);
  const log = transcript(page);
  await expect(log.locator('.agent-msg-agent')).toBeVisible();
  // The composer is there while the server makes this conversation active; Send waits for it.
  await send(page, 'Too early');
  await expect(sendBtn(page)).toHaveAttribute('aria-busy', 'true');
  await expect(stopBtn(page)).toBeHidden();
  await expect(log.locator('.agent-msg-user')).toHaveCount(1);
  // It can't be: no turn starts, and the footer says why.
  release();
  await expect(page.locator('.agent-readonly')).toContainText("This conversation can't be continued");
  await expect(log.locator('.agent-msg-user')).toHaveCount(1); // only the stored message
  await expect(log.locator('.agent-working')).toHaveCount(0);
  expect(posts).toEqual([]);
});

test('an agent that is not ready says so above the composer', async ({ app, page }) => {
  await page.route('**/api/status', async (route) => {
    const res = await route.fetch();
    const status = await res.json();
    status.agents = status.agents.map((a) => (a.kind === 'opencode' ? { ...a, authed: false } : a));
    await route.fulfill({ response: res, json: status });
  });
  await openAgent(app, page);
  const warn = page.locator('.agent-warn');
  await expect(warn).toContainText("opencode isn't signed in");
  await expect(warn.getByRole('link', { name: 'Set up the agent' })).toHaveAttribute('href', '#/settings?tab=agent');
});

test('an unknown conversation says so', async ({ app, page }) => {
  await openAgent(app, page, '#/agent/no-such-chat');
  await expect(page.getByRole('heading', { name: 'This conversation doesn’t exist' })).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  await page.locator('.agent-log').getByRole('link', { name: 'Start a new chat' }).click();
  await expect(page).toHaveURL(/#\/agent$/);
  await expect(composer(page)).toBeVisible();
});

test('long lists show 50 per section, then Show more', async ({ app, page, server }) => {
  const db = new DatabaseSync(join(server.home, 'outreach.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const insert = db.prepare(
      "INSERT INTO chat_sessions (id, agent_session_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime('now', ?), datetime('now', ?))",
    );
    db.exec('BEGIN');
    for (let i = 0; i < 55; i++) {
      const ago = `-${10 + i} days`;
      insert.run(`bulk-${i}`, `ses-bulk-${i}`, `${RUN_PREFIX}Bulk ${i}`, ago, ago);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  try {
    await openAgent(app, page);
    const runs = section(page, 'Scheduled runs');
    await expect(runs.getByRole('link')).toHaveCount(50);
    const more = page.getByRole('button', { name: 'Show 6 more' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(runs.getByRole('link')).toHaveCount(56);
    await expect(page.getByRole('button', { name: /^Show \d+ more$/ })).toHaveCount(0);
    // Focus lands on the first conversation it revealed.
    await expect(runs.getByRole('link').nth(50)).toBeFocused();
  } finally {
    dbRun(server, "DELETE FROM chat_sessions WHERE id LIKE 'bulk-%'");
  }
});

test('agent screen is accessible in light and dark', async ({ app, page }) => {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    await page.emulateMedia({ colorScheme: scheme });
    await openAgent(app, page);
    await expect(page.getByRole('list', { name: 'Starter prompts' })).toBeVisible();
    await expect(section(page, 'Your chats').locator('.agent-item').first()).toBeVisible();
    await expectAccessible(page);

    await openAgent(app, page, `#/agent/${berlin.id}`);
    await transcript(page).getByRole('button', { name: 'Worked · 2 steps' }).click();
    await expect(transcript(page).locator('.agent-step').first()).toBeVisible();
    await expectAccessible(page);

    await openAgent(app, page, `#/agent/${scheduled.id}`);
    await expect(page.locator('.agent-readonly')).toBeVisible();
    await transcript(page).locator('details.agent-brief summary').click();
    await expectAccessible(page);
  }
});

/** The composer footer: each item's box, and whether the bar overflows the composer. */
const footer = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { width: r.width, full: el.scrollWidth <= Math.ceil(r.width) };
    };
    const bar = /** @type {HTMLElement} */ (document.querySelector('.agent-input-bar'));
    return {
      model: box('.agent-model'),
      keys: box('.agent-hint-keys'),
      overflow: bar.scrollWidth > bar.clientWidth,
    };
  });

test('the composer footer keeps "<agent> · <model>" beside the list at laptop widths', async ({ app, page }) => {
  const label = 'opencode · fake/model-a';
  for (const width of [900, 1024, 1100, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await openAgent(app, page);
    const model = page.locator('.agent-model');
    await expect(model).toBeVisible();
    await expect(model).toHaveText(label);
    const f = await footer(page);
    expect(f.overflow, `footer overflows at ${width}px`).toBe(false);
    // Never squeezed to nothing (it is a link in the tab order): at least 12ch.
    expect(f.model && f.model.width, `model label width at ${width}px`).toBeGreaterThan(80);
    // From 1024px it fits whole; the key hint gives way first, and shows whenever both fit.
    if (width >= 1024) expect(f.model && f.model.full, `model label cut at ${width}px`).toBe(true);
    if (f.keys && f.keys.width > 0) expect(f.keys.full).toBe(true);
  }
  // Wide: everything on one line.
  await expect(page.locator('.agent-hint-keys')).toBeVisible();

  // While a turn runs at 1024px, the warning about leaving shows whole, with Stop.
  await page.setViewportSize({ width: 1024, height: 800 });
  await send(page, 'Laptop SLOW turn');
  const busy = page.locator('.agent-hint-busy');
  await expect(busy).toBeVisible();
  await expect(stopBtn(page)).toBeVisible();
  expect(await busy.evaluate((el) => el.scrollWidth <= Math.ceil(el.getBoundingClientRect().width))).toBe(true);
  expect((await footer(page)).overflow).toBe(false);
  await stopBtn(page).click();
  await expect(sendBtn(page)).toBeVisible();
  await expect(page.locator('.agent-model')).toBeVisible();
});

test('a run conversation header shows whole beside the list at laptop widths', async ({ app, page }) => {
  const run = SEED.runs.find((r) => r.chat_id === scheduled.id);
  /** Each header line's box: is it cut, and does it stay inside the header? */
  const lines = () =>
    page.evaluate(() => {
      const head = /** @type {HTMLElement} */ (document.querySelector('.agent-chat-head')).getBoundingClientRect();
      return ['.agent-chat-title', '.agent-chat-meta', '.agent-chat-badges'].map((sel) => {
        const el = /** @type {HTMLElement} */ (document.querySelector(sel));
        const r = el.getBoundingClientRect();
        return { sel, cut: el.scrollWidth > el.clientWidth + 1, inside: r.left >= head.left && r.right <= head.right + 0.5 };
      });
    });
  for (const width of [960, 1024, 1100, 1280, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await openAgent(app, page, `#/agent/${scheduled.id}`);
    await expect(page.locator('.agent-chat-head').getByText('Succeeded', { exact: true })).toBeVisible();
    await expect(page.locator('.agent-chat-meta')).toContainText(`${run.sent} sent`);
    for (const line of await lines()) {
      expect(line.cut, `${line.sel} cut at ${width}px`).toBe(false);
      expect(line.inside, `${line.sel} outside the header at ${width}px`).toBe(true);
    }
  }
});

test('phone width: conversations toggle, no horizontal scroll', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth);
  await openAgent(app, page);
  await expect(composer(page)).toBeVisible();
  expect(await noSideScroll()).toBeLessThanOrEqual(390);
  // The list hides behind a toggle so the conversation gets the screen.
  await expect(convNav(page)).toBeHidden();
  const toggle = page.getByRole('button', { name: 'Conversations' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(convNav(page)).toBeVisible();
  expect(await noSideScroll()).toBeLessThanOrEqual(390);
  await section(page, 'Your chats').getByRole('link', { name: new RegExp(berlin.title) }).click();
  await expect(chatTitle(page)).toHaveText(berlin.title);
  await expect(convNav(page)).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(transcript(page).locator('.agent-msg-agent')).toBeVisible();
  // The wrapped header has no empty badge row under a chat's title and time.
  const headGap = await page.evaluate(() => {
    const head = /** @type {HTMLElement} */ (document.querySelector('.agent-chat-head'));
    const titles = /** @type {HTMLElement} */ (document.querySelector('.agent-chat-titles'));
    return head.getBoundingClientRect().bottom - titles.getBoundingClientRect().bottom;
  });
  expect(headGap).toBeLessThan(14); // its 12px padding and 1px border
  // The composer stays on screen.
  const box = await composer(page).boundingBox();
  expect(box && box.y + box.height).toBeLessThanOrEqual(844);
  await transcript(page).getByRole('button', { name: 'Worked · 2 steps' }).click();
  expect(await noSideScroll()).toBeLessThanOrEqual(390);
  await expectAccessible(page);

  await openAgent(app, page, `#/agent/${scheduled.id}`);
  await expect(page.locator('.agent-readonly')).toBeVisible();
  expect(await noSideScroll()).toBeLessThanOrEqual(390);

  // Idle: the model label, not the key hint; while a turn runs, the warning about leaving
  // (phone users get it too) and Stop, all inside the screen.
  await openAgent(app, page);
  await expect(page.locator('.agent-model')).toBeVisible();
  await expect(page.locator('.agent-hint-keys')).toBeHidden();
  await send(page, 'Phone SLOW turn');
  await expect(page.locator('.agent-hint-busy')).toBeVisible();
  await expect(page.locator('.agent-hint-busy')).toHaveText('Leaving this conversation stops the agent.');
  const stop = await stopBtn(page).boundingBox();
  expect(stop && stop.x + stop.width).toBeLessThanOrEqual(390);
  expect((await footer(page)).overflow).toBe(false);
  expect(await noSideScroll()).toBeLessThanOrEqual(390);
  await stopBtn(page).click();
  await expect(sendBtn(page)).toBeVisible();
});

test.describe('empty workspace', () => {
  test.use({ seed: 'onboarded' });

  test('no conversations yet shows a clear empty list and the starters', async ({ app, page }) => {
    await openAgent(app, page);
    await expect(convNav(page).getByText('No conversations yet')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Starter prompts' }).getByRole('button')).toHaveCount(4);
    // Auto-send is off in this workspace: the welcome says nothing goes out.
    await expect(page.locator('.agent-welcome')).toContainText('Nothing is sent without you');
    await expectAccessible(page);
  });
});

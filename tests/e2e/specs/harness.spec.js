// @ts-check
//
// Self-tests for the e2e harness: the isolated server and its cleanup, the deterministic seed, the
// fake agent CLIs, the side-effect intercepts, the console guard and the accessibility helper.
// Every other spec trusts these pieces, so each one is proven here against the real
// `coldtrail serve`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { seriousViolations, expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { interceptSideEffects, SIDE_EFFECT_ROUTES } from '../harness/intercept.mjs';
import { PRODUCT_MD, SEED } from '../harness/seed.mjs';
import { E2E_DIR, FAKE_BIN, serverEnv, startServer, sweepStale } from '../harness/server.mjs';

/** GET a token-guarded API path and return its JSON (asserting a 200). */
async function getJSON(request, server, path) {
  const res = await request.get(server.apiUrl(path));
  expect(res.status(), `GET ${path}: ${await res.text()}`).toBe(200);
  return res.json();
}

/** Send a JSON body to a token-guarded API path and return its JSON (asserting a 200). */
async function sendJSON(request, server, method, path, data = {}) {
  const res = await request.fetch(server.apiUrl(path), { method, data });
  expect(res.status(), `${method} ${path}: ${await res.text()}`).toBe(200);
  return res.json();
}

/** One agent turn through `/api/chat` + its SSE stream: every event the browser would see. */
async function chatTurn(request, server, message) {
  const { run } = await sendJSON(request, server, 'POST', '/api/chat', { message });
  const res = await request.get(server.apiUrl(`/api/chat/stream?run=${encodeURIComponent(run)}`));
  expect(res.status()).toBe(200);
  return (await res.text())
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length)));
}

/** Run a fake-bin script (`opencode` by default) directly and collect its output. */
function runFake(args, env = {}, name = 'opencode') {
  return new Promise((resolveRun, reject) => {
    const child = spawn(join(FAKE_BIN, name), args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => resolveRun({ code, lines: out.split('\n').filter(Boolean), err }));
  });
}

/** Is `pid` a live process (or an unreaped zombie)? */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Start a server from a separate Node process, the way a test worker would. `info` resolves to
 * the server's pid, base URL and three directories once the child reports them; `exit` to how
 * the child ended. The child is returned at once, so a caller can always kill it.
 */
function serverInChild() {
  const serverUrl = pathToFileURL(join(E2E_DIR, 'harness/server.mjs')).href;
  const script = `
    import { startServer } from ${JSON.stringify(serverUrl)};
    const s = await startServer({ seed: 'empty' });
    const dirs = [s.home, s.secretsDir, s.userHome];
    console.log(JSON.stringify({ pid: s.pid, base: s.base, dirs }));
    setInterval(() => {}, 60_000);
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = new Promise((resolveExit) =>
    child.once('exit', (code, signal) => resolveExit({ code, signal })),
  );
  const info = new Promise((resolveInfo, reject) => {
    let out = '';
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      out += d;
      const end = out.indexOf('\n');
      if (end < 0) return;
      try {
        resolveInfo(JSON.parse(out.slice(0, end)));
      } catch (e) {
        reject(e);
      }
    });
    exit.then(({ code, signal }) =>
      reject(new Error(`server child exited (${code ?? signal}) early:\n${out}\n${err}`)),
    );
  });
  return { child, exit, info };
}

/** Where an OS timer for schedule `id` would land under `home` if one were installed. */
function timerFiles(home, id) {
  if (process.platform === 'darwin') {
    return [join(home, 'Library/LaunchAgents', `ai.coldtrail.run.${id}.plist`)];
  }
  if (process.platform === 'linux') {
    const dir = join(home, '.config/systemd/user');
    return [join(dir, `coldtrail-${id}.timer`), join(dir, `coldtrail-${id}.service`)];
  }
  return [];
}

test('server starts isolated with seed', async ({ server, request }) => {
  const realWorkspace = resolve(homedir(), '.coldtrail');
  for (const dir of [server.home, server.secretsDir, server.userHome]) {
    expect(existsSync(dir), dir).toBe(true);
    expect(resolve(dir).startsWith(realWorkspace), dir).toBe(false);
  }
  // The server's HOME is the sandbox, not the user's.
  expect(server.userHome).not.toBe(homedir());

  const summary = await getJSON(request, server, '/api/summary');
  expect(summary.counts.companies).toBe(SEED.companies);

  const status = await getJSON(request, server, '/api/status');
  expect(status).toMatchObject({
    provider: 'opencode',
    opencode_model: 'fake/model-a',
    onboarded: true,
    product_set: true,
    discovery_connected: true,
    destination_connected: false,
    auto_send: false,
  });
  // All three agent CLIs are the fake-bin copies, so the cards read the same on every machine:
  // present everywhere, and only opencode signed in (through the sandboxed HOME's auth file).
  expect(status.agents).toEqual([
    { kind: 'claude', label: 'Claude Code', present: true, authed: false },
    { kind: 'codex', label: 'Codex CLI', present: true, authed: false },
    { kind: 'opencode', label: 'opencode', present: true, authed: true },
  ]);

  // The API is still guarded: no token, no data.
  expect((await request.get(`${server.base}/api/summary`)).status()).toBe(401);
});

test('seed matches the exported SEED constants', async ({ server, request }) => {
  const summary = await getJSON(request, server, '/api/summary');
  expect(summary.counts).toEqual(SEED.counts);
  expect(summary.funnel).toEqual(SEED.funnel);
  expect(summary.last_run).toMatchObject({ status: 'error', schedule_name: 'Lunch Source' });
  expect(summary.attention.map((a) => a.kind)).toEqual(['last_run_failed']);
  expect(summary.next_schedule).toMatchObject({
    id: SEED.schedules.lunch.id,
    name: SEED.schedules.lunch.name,
  });
  expect(summary.running).toBeNull();

  const first = await getJSON(request, server, '/api/companies');
  expect(first.total).toBe(SEED.companies);
  expect(first.rows).toHaveLength(50);
  expect(first.stages).toEqual(SEED.stages);
  expect(first.queries).toEqual(SEED.queries);
  expect(first.rows.map((r) => r.domain)).toContain(SEED.xss.domain);
  const q1 = await getJSON(request, server, '/api/companies?query=Q1&per=1');
  expect(q1.total).toBe(400);
  const xss = await getJSON(request, server, `/api/companies?q=${SEED.xss.domain}`);
  expect(xss.rows.map((r) => r.name)).toEqual([SEED.xss.name]);

  const drafts = await getJSON(request, server, '/api/drafts');
  expect(drafts.map((d) => d.domain)).toEqual(SEED.drafts.order);
  expect(drafts.filter((d) => d.channel === 'email')).toHaveLength(SEED.drafts.email);
  expect(drafts.filter((d) => d.channel === 'linkedin')).toHaveLength(SEED.drafts.linkedin);
  expect(drafts.filter((d) => d.auto_skip).map((d) => [d.domain, d.auto_skip])).toEqual([
    [SEED.drafts.parked.domain, SEED.drafts.parked.reason],
  ]);

  const followups = await getJSON(request, server, '/api/followups');
  const byState = {};
  for (const f of followups) byState[f.state] = (byState[f.state] || 0) + 1;
  expect(byState).toEqual(SEED.followups);

  const schedules = await getJSON(request, server, '/api/schedules');
  expect(schedules).toMatchObject([
    { ...SEED.schedules.lunch, last_run: { status: 'error' } },
    { ...SEED.schedules.weekly, last_run: { status: 'ok' } },
  ]);

  const runs = await getJSON(request, server, '/api/runs');
  expect(runs.map((r) => r.status)).toEqual(SEED.runs.map((r) => r.status).reverse());

  const chats = await getJSON(request, server, '/api/chats');
  expect(chats.map((c) => c.title)).toEqual(SEED.chats.list.map((c) => c.title));
  const scheduled = await getJSON(request, server, `/api/chats/${SEED.chats.scheduled.id}`);
  expect(scheduled.title).toBe('Scheduled run — Lunch Source');
  expect(scheduled.running).toBe(false);
  expect(new Set(scheduled.messages.map((m) => m.role))).toEqual(
    new Set(['user', 'tool', 'assistant']),
  );

  expect(await getJSON(request, server, '/api/company')).toEqual({ doc: PRODUCT_MD });
});

test('fake opencode answers models', async ({ server, request }) => {
  const res = await getJSON(request, server, '/api/provider/opencode/models');
  expect(res.models).toEqual(['fake/model-a', 'fake/model-b', 'opencode/free-c']);
  expect(res.message).toBeNull();
});

test('fake opencode turns parse through the real provider code', async ({ server, request }) => {
  const probe = await sendJSON(request, server, 'POST', '/api/provider/probe');
  expect(probe).toEqual({ ok: true, message: 'opencode is signed in and responding.' });

  // Quotes, a backslash, markup and non-ASCII must all survive the fake's JSON encoding.
  const message = 'Quote "this" \\ and <b>tags</b> — ünïcode, then a long tail of words';
  expect(await chatTurn(request, server, message)).toEqual([
    { type: 'tool_start', name: '$ coldtrail status', input: { command: 'coldtrail status' } },
    { type: 'tool_end', ok: true },
    { type: 'text', text: `Fake agent reply: ${[...message].slice(0, 40).join('')}` },
    { type: 'done', ok: true, result: null },
  ]);

  expect(await chatTurn(request, server, 'Please FAIL this turn')).toEqual([
    { type: 'error', message: 'Fake failure' },
    { type: 'done', ok: false, result: null },
  ]);
});

test('serverEnv drops inherited credentials and puts fake-bin first', () => {
  const kept = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', FAKE_OPENCODE_STEP_DELAY: '0' };
  const dropped = {
    COLDTRAIL_API_KEY: 'real-key',
    COLDTRAIL_HOME: '/real/.coldtrail',
    GOOGLE_APPLICATION_CREDENTIALS: '/real/adc.json',
    ANTHROPIC_API_KEY: 'real-key',
    ANTHROPIC_BASE_URL: 'https://api.example',
    OPENAI_API_KEY: 'real-key',
    CLAUDE_CONFIG_DIR: '/real/.claude',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDECODE: '1',
    CODEX_HOME: '/real/.codex',
    OPENCODE_CONFIG: '/real/opencode.json',
  };
  expect(serverEnv({ home: '/w', userHome: '/u' }, { ...kept, ...dropped })).toEqual({
    LANG: 'en_US.UTF-8',
    FAKE_OPENCODE_STEP_DELAY: '0',
    PATH: `${FAKE_BIN}${delimiter}/usr/bin:/bin`,
    COLDTRAIL_HOME: '/w',
    COLDTRAIL_NO_SEND: '1',
    COLDTRAIL_NO_TIMERS: '1',
    COLDTRAIL_NO_UPDATE: '1',
    HOME: '/u',
    GOOGLE_APPLICATION_CREDENTIALS: '/u/no-gcloud-adc.json',
  });
});

test('claude and codex are fail-closed stubs, never the real CLIs', async ({ server, request }) => {
  // Straight from fake-bin: a model turn refuses, and `claude mcp` reads as "not configured".
  const claudeTurn = ['-p', 'Reply with exactly: ok', '--output-format', 'stream-json'];
  expect(await runFake(claudeTurn, {}, 'claude')).toEqual({
    code: 1,
    lines: [],
    err: 'fake claude: real agents are disabled in e2e\n',
  });
  expect(await runFake(['exec', '--json', 'Reply with exactly: ok'], {}, 'codex')).toEqual({
    code: 1,
    lines: [],
    err: 'fake codex: real agents are disabled in e2e\n',
  });
  for (const sub of ['get', 'add', 'remove']) {
    const mcp = await runFake(['mcp', sub, 'canonical'], {}, 'claude');
    expect(mcp, `claude mcp ${sub}`).toMatchObject({ code: 1, lines: [] });
  }

  // Through the server: either can be chosen (both are "installed"), and Test connection reaches
  // the stub, not a model.
  try {
    for (const name of ['claude', 'codex']) {
      await sendJSON(request, server, 'POST', '/api/onboarding/provider', { provider: name });
      expect((await getJSON(request, server, '/api/status')).provider).toBe(name);
      expect(await sendJSON(request, server, 'POST', '/api/provider/probe')).toEqual({
        ok: false,
        message: `fake ${name}: real agents are disabled in e2e`,
      });
    }
  } finally {
    await sendJSON(request, server, 'POST', '/api/onboarding/provider', { provider: 'opencode' });
  }
  expect(await getJSON(request, server, '/api/status')).toMatchObject({
    provider: 'opencode',
    opencode_model: 'fake/model-a',
  });
});

test('fake opencode SLOW turn streams 20 tool steps before its reply', async () => {
  // The step delay is 0.4s by default; shrink it so this self-test stays quick.
  const { code, lines } = await runFake(
    ['run', '--format', 'json', '--auto', '-m', 'fake/model-a', '--', 'SLOW please'],
    { FAKE_OPENCODE_STEP_DELAY: '0' },
  );
  expect(code).toBe(0);
  const events = lines.map((l) => JSON.parse(l));
  expect(events.map((e) => e.type)).toEqual([
    'step_start',
    ...Array(20).fill('tool_use'),
    'text',
    'step_finish',
  ]);
  expect(events[0].sessionID).toMatch(/^ses_fake_\d+$/);
  expect(events.find((e) => e.type === 'text').part.text).toBe('Fake agent reply: SLOW please');

  const models = await runFake(['models']);
  expect(models).toMatchObject({ code: 0, lines: ['fake/model-a', 'fake/model-b', 'opencode/free-c'] });
});

test('timers are disabled', async ({ server, request }) => {
  const created = await sendJSON(request, server, 'POST', '/api/schedules', {
    name: 'Harness timer check',
    enabled: true,
    freq: 'weekly',
    time: '07:30',
    weekday: 3,
    task_mode: 'agent',
    prompt: null,
  });
  try {
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    // Toggling runs both the install and the remove path.
    await sendJSON(request, server, 'PATCH', `/api/schedules/${created.id}`, { enabled: false });
    await sendJSON(request, server, 'PATCH', `/api/schedules/${created.id}`, { enabled: true });

    // Neither the real home nor the server's sandboxed HOME got a timer file.
    for (const home of [homedir(), server.userHome]) {
      for (const file of timerFiles(home, created.id)) expect(existsSync(file), file).toBe(false);
    }
    if (process.platform === 'darwin') {
      const loaded = spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout;
      expect(loaded).not.toContain(`ai.coldtrail.run.${created.id}`);
    }
    // ...because the server took the logged no-op path, not because the write failed.
    const log = readFileSync(join(server.home, 'coldtrail.log'), 'utf8');
    expect(log).toContain('timers disabled (COLDTRAIL_NO_TIMERS)');
  } finally {
    await sendJSON(request, server, 'DELETE', `/api/schedules/${created.id}`);
  }
});

test('sends are blocked', async ({ server, request }) => {
  const draft = SEED.emailDrafts.find(
    (d) => d.status === 'draft_pending' && d.domain !== SEED.xss.domain,
  );
  // With auto-send off the button only makes a Gmail draft; turn it on to reach the send gate.
  // No daily_cap: it is optional, and sending one would leave it in the workspace config.
  const autoSend = (enabled) =>
    sendJSON(request, server, 'POST', '/api/destination/auto-send', { enabled });
  await autoSend(true);
  try {
    const res = await request.post(server.apiUrl(`/api/drafts/${draft.domain}/send`), { data: {} });
    // The send route reports a refused send as a 200 {ok:false, message} (its existing contract).
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      message: 'dry run: sending is disabled for this run',
    });
    expect(server.query('SELECT status, sent_at FROM outreach WHERE domain = ?', draft.domain)).toEqual([
      { status: 'draft_pending', sent_at: null },
    ]);
  } finally {
    await autoSend(false);
  }
  // The toggle left no other setting behind for the tests after this one.
  expect(readFileSync(join(server.home, 'config.toml'), 'utf8')).not.toContain('daily_send_cap');
});

test('server.query waits out a write lock instead of failing', async ({ server }) => {
  // A read that lands while the server writes (right after an agent turn or a run) gets SQLite's
  // "database is locked" at once unless the connection has a busy timeout.
  expect(server.query('PRAGMA busy_timeout')).toEqual([{ timeout: 5000 }]);
  expect(server.query('SELECT count(*) AS n FROM companies')).toEqual([{ n: SEED.counts.companies }]);
});

test('a route handler still running when the test ends does not fail it', async ({ app, page }) => {
  // A smoke guard, not a proof: it passes with or without the fixture's unrouteAll (the race it
  // guards against is timing-dependent); the next test proves the routes are removed. End the
  // test while a status request sits in its handler between route.fetch() and reading the
  // response: the app fixture unroutes on the way out and ignores what such a handler throws once
  // the page is gone ("Response has been disposed").
  let fetched;
  const inHandler = new Promise((r) => { fetched = r; });
  await page.route('**/api/status*', async (route) => {
    const res = await route.fetch();
    fetched();
    await new Promise((r) => setTimeout(r, 500));
    await route.fulfill({ response: res, json: { ...(await res.json()) } });
  });
  await app.goto('#/home');
  await inHandler;
});

// A `page` override's teardown runs after the app fixture's (app depends on page), while the page
// is still open: there, a route the test left behind must no longer answer.
const afterApp = test.extend({
  page: async ({ page }, use) => {
    await use(page);
    const body = await page.evaluate(() => fetch('/__unroute-probe').then((r) => r.text()));
    expect(body, 'a route the test left behind still answers after the app fixture').not.toBe('routed-probe');
  },
});

afterApp('the app fixture removes the routes a test left behind', async ({ app, page }) => {
  await page.route('**/__unroute-probe', (route) => route.fulfill({ status: 200, body: 'routed-probe' }));
  await app.goto('#/home');
  expect(await page.evaluate(() => fetch('/__unroute-probe').then((r) => r.text()))).toBe('routed-probe');
});

test('side-effect routes are intercepted and never reach the server', async ({ page, server }) => {
  // Registered first, so it runs last: any /api call the intercepts don't answer is aborted
  // here, and a broken pattern fails this test instead of launching Chrome or an OAuth flow.
  const leaked = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      leaked.push(route.request().url());
      return route.abort();
    },
  );
  const { calls } = await interceptSideEffects(page);
  // Any same-origin page without scripts will do; the app itself would make its own API calls.
  await page.goto(`${server.base}/assets/fonts/OFL.txt`);

  const samples = SIDE_EFFECT_ROUTES.map((r) => r.sample);
  const results = await page.evaluate(async (paths) => {
    const out = [];
    for (const path of paths) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: path }),
      });
      out.push({ status: res.status, json: await res.json() });
    }
    return out;
  }, samples);

  expect(leaked).toEqual([]);
  expect(results).toEqual(SIDE_EFFECT_ROUTES.map((r) => ({ status: 200, json: r.response })));
  expect(calls).toEqual(samples.map((path) => ({ method: 'POST', path, body: { from: path } })));
});

test('app opens the token URL with intercepts installed', async ({ app }) => {
  await app.goto('#/home');
  await expect(app.page.locator('#app')).toBeAttached();
  expect(new URL(app.page.url()).hash).toBe('#/home');
  const reply = await app.page.evaluate(() =>
    fetch('/api/destination/linkedin/connect', { method: 'POST', body: '{}' }).then((r) => r.json()),
  );
  expect(reply).toEqual({ status: 'waiting' });
  expect(app.calls).toEqual([
    { method: 'POST', path: '/api/destination/linkedin/connect', body: {} },
  ]);
});

// These two mark themselves as failing only on their last line. Anything that goes wrong before
// it (say `app.goto` throws) is an ordinary failure; past it, the guard has collected exactly the
// self-test's problem, so the app fixture's teardown check on that list is all that can fail them.
test('a console.error fails the test', async ({ app }) => {
  await app.goto('');
  expect(app.problems()).toEqual([]);
  await app.page.evaluate(() => console.error('harness self-test: unexpected error'));
  await expect
    .poll(() => app.problems())
    .toEqual(['console.error: harness self-test: unexpected error']);
  test.fail(true, 'the app fixture must turn a console.error into a failure');
});

test('an uncaught page error fails the test', async ({ app }) => {
  await app.goto('');
  expect(app.problems()).toEqual([]);
  await app.page.evaluate(() => {
    setTimeout(() => {
      throw new Error('harness self-test: uncaught');
    });
  });
  await expect
    .poll(() => app.problems())
    .toEqual([expect.stringMatching(/^pageerror: Error: harness self-test: uncaught\b/)]);
  test.fail(true, 'the app fixture must turn a pageerror into a failure');
});

test('allowConsole lets an expected console.error through', async ({ app }) => {
  app.allowConsole(/expected harness noise/);
  await app.goto('');
  const logged = app.page.waitForEvent('console', (m) => m.text() === 'expected harness noise');
  await app.page.evaluate(() => console.error('expected harness noise'));
  await logged;
  expect(app.problems()).toEqual([]);
});

test('a11y helper reports serious violations and honours exclude', async ({ page }) => {
  const dot = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const doc = (body) =>
    '<!doctype html><html lang="en"><head><title>a11y check</title></head>' +
    `<body><main>${body}</main></body></html>`;

  await page.setContent(doc(`<h1>Clean</h1><img src="${dot}" alt="dot"><button>Save</button>`));
  expect(await seriousViolations(page)).toEqual([]);
  await expectAccessible(page);

  await page.setContent(doc(`<h1>Broken</h1><img src="${dot}"><button></button>`));
  const ids = (await seriousViolations(page)).map((v) => v.id).sort();
  expect(ids).toEqual(['button-name', 'image-alt']);
  expect(await seriousViolations(page, { exclude: ['img', 'button'] })).toEqual([]);
});

test('empty and onboarded seeds start clean, and stop() removes everything', async ({ request }) => {
  test.setTimeout(60_000);
  for (const seed of ['empty', 'onboarded']) {
    const s = await startServer({ seed });
    try {
      const status = await getJSON(request, s, '/api/status');
      expect(status).toMatchObject({
        provider: 'opencode',
        opencode_model: 'fake/model-a',
        onboarded: seed === 'onboarded',
        product_set: seed === 'onboarded',
        discovery_connected: seed === 'onboarded',
      });
      const summary = await getJSON(request, s, '/api/summary');
      expect(summary.counts.companies).toBe(0);
      expect(summary.funnel.map(([, n]) => n)).toEqual([0, 0, 0, 0, 0]);
    } finally {
      await s.stop();
    }
    for (const dir of [s.home, s.secretsDir, s.userHome]) expect(existsSync(dir), dir).toBe(false);
    await expect(request.get(s.apiUrl('/api/status'), { timeout: 2_000 })).rejects.toThrow();
  }
});

test('a test process ended by SIGINT, SIGTERM or SIGHUP takes its server with it', async ({
  request,
}) => {
  test.setTimeout(60_000);
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const started = signals.map(() => serverInChild());
  try {
    const infos = await Promise.all(started.map((s) => s.info));
    for (const info of infos) {
      expect(pidAlive(info.pid)).toBe(true);
      expect((await request.get(`${info.base}/api/status`)).status()).toBe(401);
    }
    signals.forEach((signal, i) => started[i].child.kill(signal));
    for (const [i, info] of infos.entries()) {
      // Cleaned up, then the signal re-raised: the process still ends by that signal.
      expect(await started[i].exit).toEqual({ code: null, signal: signals[i] });
      for (const dir of info.dirs) expect(existsSync(dir), dir).toBe(false);
      await expect.poll(() => pidAlive(info.pid), { message: `server ${info.pid}` }).toBe(false);
      await expect(request.get(`${info.base}/api/status`, { timeout: 2_000 })).rejects.toThrow();
    }
  } finally {
    // SIGTERM, not SIGKILL: a child still running after a failure cleans up after itself too.
    for (const { child } of started) child.kill('SIGTERM');
  }
});

test('sweepStale cleans up after a test process killed outright', async ({ request }) => {
  test.setTimeout(60_000);
  const { child, exit, info: started } = serverInChild();
  try {
    const info = await started;
    child.kill('SIGKILL');
    expect(await exit).toEqual({ code: null, signal: 'SIGKILL' });
    // Nothing in the dead process could clean up: the server and its directories are orphaned.
    expect(pidAlive(info.pid)).toBe(true);
    for (const dir of info.dirs) expect(existsSync(dir), dir).toBe(true);

    expect(sweepStale()).toContain(info.dirs[0]);
    await expect.poll(() => pidAlive(info.pid), { message: `server ${info.pid}` }).toBe(false);
    for (const dir of info.dirs) expect(existsSync(dir), dir).toBe(false);
    await expect(request.get(`${info.base}/api/status`, { timeout: 2_000 })).rejects.toThrow();
  } finally {
    child.kill('SIGKILL');
    sweepStale(); // whatever an early failure left behind
  }
});

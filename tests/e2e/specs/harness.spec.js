// @ts-check
//
// Self-tests for the e2e harness: the isolated server, the deterministic seed, the fake opencode,
// the side-effect intercepts, the console guard and the accessibility helper. Every other spec
// trusts these pieces, so each one is proven here against the real `coldtrail serve`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { seriousViolations, expectAccessible } from '../harness/a11y.mjs';
import { test, expect } from '../harness/fixtures.mjs';
import { interceptSideEffects, SIDE_EFFECT_ROUTES } from '../harness/intercept.mjs';
import { PRODUCT_MD, SEED } from '../harness/seed.mjs';
import { FAKE_BIN, startServer } from '../harness/server.mjs';

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

/** Run fake-bin/opencode directly and collect its stdout lines. */
function runFake(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(join(FAKE_BIN, 'opencode'), args, {
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
  // Present through fake-bin on PATH, signed in through the sandboxed HOME's auth file.
  expect(status.agents.find((a) => a.kind === 'opencode')).toMatchObject({
    present: true,
    authed: true,
  });

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
  const autoSend = (enabled) =>
    sendJSON(request, server, 'POST', '/api/destination/auto-send', { enabled, daily_cap: 20 });
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

test('a console.error fails the test', async ({ app }) => {
  test.fail(true, 'the app fixture must turn a console.error into a failure');
  await app.goto('');
  await app.page.evaluate(() => console.error('harness self-test: unexpected error'));
});

test('an uncaught page error fails the test', async ({ app }) => {
  test.fail(true, 'the app fixture must turn a pageerror into a failure');
  await app.goto('');
  await app.page.evaluate(() => {
    setTimeout(() => {
      throw new Error('harness self-test: uncaught');
    });
  });
  await app.page.waitForTimeout(100);
});

test('allowConsole lets an expected console.error through', async ({ app }) => {
  app.allowConsole(/expected harness noise/);
  await app.goto('');
  await app.page.evaluate(() => console.error('expected harness noise'));
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

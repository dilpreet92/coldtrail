#!/usr/bin/env node
// Record the README demo (docs/demo.mp4 + docs/demo.gif) from the real app.
//
//   cargo build && node tests/e2e/demo/record.mjs --out docs
//
// It starts `target/debug/coldtrail serve` in a throwaway workspace seeded by seed.mjs (fictional
// Ledgerlane data), with the e2e harness's isolation: COLDTRAIL_HOME, secrets and HOME are fresh
// temp dirs, sending / OS timers / self-update are off, inherited credentials are dropped, and
// this directory's bin/ is first on PATH (a scripted `opencode`; the harness's refusing `claude`
// and `codex` come next). Nothing touches ~/.coldtrail, a real model, Gmail, Canonical or
// LinkedIn. Chromium (Playwright) then plays the story at 1280x800 in the light theme with a
// visible cursor, and ffmpeg turns the captured frames into an H.264 MP4 and a two-pass GIF.
//
// Frames come from Playwright's screencast (JPEG, quality 95) rather than `recordVideo`, whose
// fixed 1 Mbit/s VP8 encode blurs small UI text; the MP4 and GIF are both encoded from them.
//
// Options:
//   --out <dir>        where demo.mp4 / demo.gif go (required)
//   --bin <path>       coldtrail binary (default target/debug/coldtrail)
//   --gif-fps <n>      GIF frame rate (default 15)
//   --gif-width <px>   GIF width (default 1280)
//   --frames <n>       also write n evenly spaced stills (frame-XX.png) for review (default 0)
//   --headed           show the browser while recording
//   --keep             keep the raw frames and the workspace (paths are printed)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { chromium } from '@playwright/test';

import { DEFAULT_BIN, serverEnv } from '../harness/server.mjs';
import { PROFILE_ADDITION, PROFILE_ANCHOR, seedDemo } from './seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEMO_BIN = join(HERE, 'bin');
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(existsSync) ?? 'ffmpeg';
const URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([A-Za-z0-9-]+)/;
const VIEWPORT = { width: 1280, height: 800 };
const PROMPT = 'Find seed-stage fintech companies in Europe and draft intros';

// ---------------------------------------------------------------------------------------------
// The demo server

const cleanups = [];
let cleaned = false;
function cleanupAll() {
  if (cleaned) return;
  cleaned = true;
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
}
process.on('exit', cleanupAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanupAll();
    process.exit(130);
  });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

/**
 * Seed a temp workspace and start `coldtrail serve` on it.
 * @returns {Promise<{ url(hash?: string): string, home: string, output(): string, stop(): void }>}
 */
export async function startDemoServer({ bin = DEFAULT_BIN, keep = false } = {}) {
  if (!existsSync(bin)) throw new Error(`coldtrail binary not found at ${bin}; run \`cargo build\` first`);
  const home = mkdtempSync(join(tmpdir(), 'coldtrail-demo-'));
  const secretsDir = `${home}.secrets`;
  const userHome = `${home}.user`;
  const dirs = [home, secretsDir, userHome];
  const real = resolve(homedir(), '.coldtrail');
  for (const dir of dirs) {
    const abs = resolve(dir);
    if (abs === real || abs.startsWith(`${real}/`)) throw new Error(`refusing to use ${dir}: inside ~/.coldtrail`);
  }
  if (!keep) cleanups.push(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const env = serverEnv({ home, userHome });
  // The scripted opencode first; the harness's fail-closed claude / codex right after it.
  env.PATH = [DEMO_BIN, env.PATH].join(delimiter);
  seedDemo({ home, secretsDir, userHome, bin, env });

  const port = await freePort();
  const child = spawn(bin, ['serve', '--port', String(port), '--no-open'], {
    env,
    cwd: home,
    detached: true, // its own process group, so stopping it also ends any agent turn it spawned
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const kill = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  };
  cleanups.push(kill);

  let output = '';
  const keepOut = (chunk) => {
    output = (output + chunk).slice(-64 * 1024);
  };
  child.stdout.setEncoding('utf8').on('data', keepOut);
  child.stderr.setEncoding('utf8').on('data', keepOut);
  const [, actualPort, token] = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`coldtrail serve printed no URL:\n${output}`)), 20_000);
    const check = () => {
      const m = output.match(URL_RE);
      if (m) {
        clearTimeout(timer);
        child.stdout.off('data', check);
        ok(m);
      }
    };
    child.stdout.on('data', check);
    child.once('exit', (code, sig) => {
      clearTimeout(timer);
      fail(new Error(`coldtrail serve exited (${code ?? sig}):\n${output}`));
    });
  });
  const base = `http://127.0.0.1:${actualPort}`;
  return {
    home,
    url: (hash = '') => `${base}/?t=${token}${hash}`,
    output: () => output,
    stop: kill,
  };
}

// ---------------------------------------------------------------------------------------------
// The visible cursor (an init script: the app's CSP blocks inline <script>, not this)

const CURSOR_SCRIPT = `(() => {
  if (window.__demoCursor) return;
  window.__demoCursor = true;
  const mount = () => {
    const style = document.createElement('style');
    style.textContent = \`
      #demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        width: 24px; height: 24px; will-change: transform; }
      #demo-cursor svg { display: block; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); transition: transform .08s ease-out; transform-origin: 4px 3px; }
      #demo-cursor.is-down svg { transform: scale(.86); }
      .demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 36px; height: 36px;
        margin: -18px 0 0 -18px; border-radius: 50%; background: rgba(56, 102, 230, .30);
        animation: demo-ripple .5s ease-out forwards; }
      @keyframes demo-ripple { from { transform: scale(.35); opacity: 1; } to { transform: scale(1.35); opacity: 0; } }
    \`;
    const el = document.createElement('div');
    el.id = 'demo-cursor';
    el.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4.5 2.5v17.2l4.6-4.4 2.9 6.6 3-1.3-2.9-6.5h6.4z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.append(style, el);
    const place = (x, y) => {
      el.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)';
      try { sessionStorage.setItem('demo-cursor', JSON.stringify({ x, y })); } catch (_) {}
    };
    let start = { x: 1010, y: 600 };
    try { start = JSON.parse(sessionStorage.getItem('demo-cursor')) || start; } catch (_) {}
    place(start.x, start.y);
    addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);
    addEventListener('mousedown', (e) => {
      el.classList.add('is-down');
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.documentElement.append(r);
      setTimeout(() => r.remove(), 600);
    }, true);
    addEventListener('mouseup', () => el.classList.remove('is-down'), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();`;

// The demo is filmed in the light theme whatever the machine prefers.
const THEME_SCRIPT = `try { localStorage.setItem('ct-theme', 'light'); } catch (_) {}`;

// ---------------------------------------------------------------------------------------------
// Driving the page like a person

function director(page) {
  let at = { x: 1010, y: 600 };
  const wait = (ms) => page.waitForTimeout(ms);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  /** Glide the cursor to a point (or a locator's centre, nudged by dx/dy) over ~0.35–0.8s. */
  async function moveTo(target, { dx = 0, dy = 0, ms } = {}) {
    let to = target;
    if (typeof target.boundingBox === 'function') {
      await target.waitFor({ state: 'visible' });
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    to = { x: Math.round(to.x + dx), y: Math.round(to.y + dy) };
    const dist = Math.hypot(to.x - at.x, to.y - at.y);
    const duration = ms ?? Math.min(650, Math.max(300, dist * 0.7));
    // Time-based, so each step's round trip doesn't stretch the glide.
    const from = at;
    const t0 = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - t0) / duration);
      const k = ease(t);
      await page.mouse.move(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
      if (t >= 1) break;
      await wait(12);
    }
    at = to;
  }

  /** Move to the target, then click where the cursor is. */
  async function click(target, opts = {}) {
    await moveTo(target, opts);
    await wait(opts.settle ?? 140);
    await page.mouse.down();
    await wait(70);
    await page.mouse.up();
  }

  return { wait, moveTo, click, get at() { return at; } };
}

/** The story: Company profile → Agent run → Pipeline → Drafts → Home. */
async function play(page, server, mark) {
  const d = director(page);
  const nav = (name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(`^${name}\\b`) });

  // a. Company profile: the ticked checklist, then a sentence typed in that saves.
  await page.goto(server.url('#/company'));
  const editor = page.getByRole('textbox', { name: 'Company profile' });
  await editor.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('Ledgerlane'));
  await page.waitForLoadState('networkidle');
  await d.wait(300);
  mark('company');
  await d.wait(700);
  // Put the caret after "…still reconcile by hand." and point at it.
  const caret = await editor.evaluate((ta, anchor) => {
    const i = ta.value.indexOf(anchor) + anchor.length;
    // Where that spot sits in the textarea, measured with a mirror element.
    const cs = getComputedStyle(ta);
    const mirror = document.createElement('div');
    for (const p of ['font', 'letterSpacing', 'lineHeight', 'padding', 'border', 'boxSizing', 'wordWrap', 'overflowWrap', 'tabSize']) mirror.style[p] = cs[p];
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', width: `${ta.offsetWidth}px` });
    mirror.textContent = ta.value.slice(0, i);
    const end = document.createElement('span');
    end.textContent = '​';
    mirror.append(end);
    document.body.append(mirror);
    const r = ta.getBoundingClientRect();
    const m = end.getBoundingClientRect();
    const mr = mirror.getBoundingClientRect();
    mirror.remove();
    return { i, x: r.left + (m.left - mr.left) - ta.scrollLeft, y: r.top + (m.top - mr.top) - ta.scrollTop + m.height / 2 };
  }, PROFILE_ANCHOR);
  await d.click({ x: caret.x + 2, y: caret.y });
  await editor.evaluate((ta, i) => {
    ta.focus();
    ta.setSelectionRange(i, i);
  }, caret.i);
  await d.moveTo({ x: caret.x + 60, y: caret.y + 52 }, { ms: 300 }); // out of the text's way
  await editor.pressSequentially(PROFILE_ADDITION, { delay: 16 });
  await page.getByText('Saved', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await d.wait(800);

  // b. Agent: ask for a run and watch it work.
  mark('agent');
  await d.click(nav('Agent'));
  const input = page.getByRole('textbox', { name: 'Message the agent' });
  await input.waitFor({ state: 'visible' });
  await page.getByText('What should the agent work on?').waitFor({ state: 'visible' });
  await d.wait(350);
  await d.click(input);
  await input.pressSequentially(PROMPT, { delay: 20 });
  await d.wait(300);
  await d.click(page.getByRole('button', { name: 'Send', exact: true }));
  // Open the step list as soon as it appears, so the work is visible as it streams.
  mark('run');
  const steps = page.locator('.agent-tools-head').first();
  await steps.waitFor({ state: 'visible', timeout: 15_000 });
  await d.wait(200);
  await d.click(steps);
  await d.moveTo({ x: 1150, y: 520 }, { ms: 450 });
  await page.getByText(/^Worked · \d+ steps/).first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.agent-msg').filter({ hasText: 'Nothing was sent.' }).first().waitFor({ state: 'visible', timeout: 10_000 });
  mark('done');
  await d.wait(800);
  // Fold the steps away: the request, "Worked · N steps" and the summary on one screen.
  await page.getByRole('region', { name: 'Conversation' }).evaluate((el) => el.scrollTo({ top: 0, behavior: 'smooth' }));
  await d.wait(450);
  await d.click(steps);
  await d.moveTo({ x: 1160, y: 590 }, { ms: 400 });
  await d.wait(1800);

  // c. Pipeline: the new companies on top; open one.
  mark('pipeline');
  await d.click(nav('Pipeline'));
  const row = page.locator('.pl-company-name', { hasText: 'Railyard Finance' }).first();
  await row.waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  await d.wait(700);
  await d.click(row);
  const drawer = page.getByRole('dialog');
  await drawer.waitFor({ state: 'visible' });
  await drawer.getByText('Jonas Albrecht').first().waitFor({ state: 'visible' });
  await d.moveTo({ x: 1000, y: 610 }, { ms: 450 });
  await d.wait(1700);
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await d.wait(200);

  // d. Drafts: read the Railyard intro, scrolling its body to the ask and sign-off.
  mark('drafts');
  await d.click(nav('Drafts'));
  const list = page.getByRole('listbox', { name: 'Drafts' });
  await list.waitFor({ state: 'visible' });
  const option = list.getByRole('option').filter({ hasText: 'Railyard Finance' }).first();
  await option.waitFor({ state: 'visible' });
  await d.wait(400);
  await d.click(option);
  const detail = page.getByRole('region', { name: 'Selected draft' });
  const body = detail.getByRole('textbox', { name: 'Body' });
  await body.waitFor({ state: 'visible' });
  await page.waitForFunction((el) => el.value.includes('Hi Jonas'), await body.elementHandle(), { timeout: 5000 });
  await d.moveTo(body, { dx: 250, dy: 40, ms: 500 });
  await d.wait(1400);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 22);
    await d.wait(40);
  }
  await d.moveTo({ x: 1150, y: 560 }, { ms: 300 }); // off the resize grip and the buttons
  await d.wait(1800);

  // e. Home: the funnel.
  mark('home');
  await d.click(nav('Home'));
  await page.getByRole('heading', { name: 'Home', level: 1 }).waitFor({ state: 'visible' });
  await page.getByText('Funnel', { exact: true }).waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  await d.moveTo({ x: 980, y: 160 }, { ms: 500 }); // along the header, clear of the cards
  await d.wait(1900);
  mark('end');
}

// ---------------------------------------------------------------------------------------------
// Capture and encode

function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed:\n${r.stderr || r.error?.message}`);
  return r;
}

/** An ffconcat list of the frames between start and end (ms), each shown until the next. */
function concatList(frames, start, end, dir) {
  const kept = frames.filter((f) => f.t >= start && f.t <= end);
  // The last frame before `start` opens the clip, so it never begins on nothing.
  const before = frames.filter((f) => f.t < start).at(-1);
  if (before) kept.unshift({ ...before, t: start });
  const lines = ['ffconcat version 1.0'];
  kept.forEach((f, i) => {
    const next = i + 1 < kept.length ? kept[i + 1].t : end;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, (next - f.t) / 1000).toFixed(3)}`);
  });
  lines.push(`file '${kept.at(-1).file}'`); // the concat demuxer drops the last duration otherwise
  const list = join(dir, 'frames.ffconcat');
  writeFileSync(list, `${lines.join('\n')}\n`);
  return { list, seconds: (end - start) / 1000, count: kept.length };
}

function encode({ list, seconds }, out, { gifFps, gifWidth, stills }) {
  const mp4 = join(out, 'demo.mp4');
  const gif = join(out, 'demo.gif');
  const palette = join(dirname(list), 'palette.png');
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', list,
    // The frames are full-range JPEGs: convert to limited-range yuv420p, which every player expects.
    '-vf', `fps=30,scale=${VIEWPORT.width}:${VIEWPORT.height}:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p`,
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-tune', 'stillimage',
    '-movflags', '+faststart', '-t', seconds.toFixed(3), mp4,
  ]);
  const scale = `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos`;
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `${scale},palettegen=max_colors=192:stats_mode=diff`, '-t', seconds.toFixed(3), palette]);
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', list, '-i', palette,
    '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0', '-t', seconds.toFixed(3), gif,
  ]);
  const files = [];
  for (let i = 0; i < stills; i++) {
    const at = ((i + 0.5) * seconds) / stills;
    const file = join(out, `frame-${String(i + 1).padStart(2, '0')}.png`);
    ffmpeg(['-ss', at.toFixed(2), '-i', mp4, '-frames:v', '1', file]);
    files.push(file);
  }
  return { mp4, gif, stills: files };
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      bin: { type: 'string', default: DEFAULT_BIN },
      'gif-fps': { type: 'string', default: '15' },
      'gif-width': { type: 'string', default: String(VIEWPORT.width) },
      frames: { type: 'string', default: '0' },
      headed: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
    },
  });
  if (!values.out) {
    console.error('usage: node tests/e2e/demo/record.mjs --out <dir> [--frames 8] [--headed] [--keep]');
    process.exit(2);
  }
  const out = resolve(values.out);
  const real = resolve(homedir(), '.coldtrail');
  if (out === real || out.startsWith(`${real}/`)) throw new Error('refusing to write inside ~/.coldtrail');
  mkdirSync(out, { recursive: true });

  const work = mkdtempSync(join(tmpdir(), 'coldtrail-demo-frames-'));
  if (!values.keep) cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  const server = await startDemoServer({ bin: resolve(values.bin), keep: values.keep });
  console.log(`workspace: ${server.home}`);

  const browser = await chromium.launch({ headless: !values.headed });
  cleanups.push(() => browser.close().catch(() => {}));
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'no-preference' });
  await context.addInitScript(THEME_SCRIPT);
  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();

  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const frames = [];
  let n = 0;
  const marks = {};
  await page.screencast.start({
    size: VIEWPORT,
    quality: 95,
    onFrame: ({ data }) => {
      const file = join(work, `f${String(++n).padStart(5, '0')}.jpg`);
      writeFileSync(file, data);
      frames.push({ t: Date.now(), file });
    },
  });
  try {
    await play(page, server, (name) => {
      marks[name] = Date.now();
    });
  } catch (err) {
    await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
    console.error(server.output().slice(-4000));
    throw err;
  } finally {
    await page.screencast.stop().catch(() => {});
  }
  await context.close();
  await browser.close();

  const order = Object.entries(marks).sort((x, y) => x[1] - y[1]);
  console.log(order.map(([k, t], i) => (i + 1 < order.length ? `${k} ${((order[i + 1][1] - t) / 1000).toFixed(1)}s` : null)).filter(Boolean).join(' · '));
  const clip = concatList(frames, marks.company, marks.end, work);
  console.log(`captured ${frames.length} frames; ${clip.count} in a ${clip.seconds.toFixed(1)}s clip`);
  const files = encode(clip, out, {
    gifFps: Number(values['gif-fps']),
    gifWidth: Number(values['gif-width']),
    stills: Number(values.frames),
  });
  const mb = (f) => `${(statSync(f).size / 1024 / 1024).toFixed(2)} MB`;
  console.log(`${files.mp4}  ${mb(files.mp4)}`);
  console.log(`${files.gif}  ${mb(files.gif)}`);
  for (const f of files.stills) console.log(f);
  if (problems.length) {
    console.log(`\n${problems.length} browser problem(s):`);
    for (const p of problems) console.log(`  ${p}`);
  } else {
    console.log('no console errors');
  }
  if (values.keep) console.log(`kept frames in ${work}`);
  server.stop();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => {
      cleanupAll();
      process.exit(0);
    },
    (err) => {
      console.error(err);
      cleanupAll();
      process.exit(1);
    },
  );
}

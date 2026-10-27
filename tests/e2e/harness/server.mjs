// Start a real `coldtrail serve` in a throwaway workspace for the e2e suite.
//
// Isolation, all of it on every server:
//   - COLDTRAIL_HOME is a fresh mkdtemp dir; secrets land beside it in `<home>.secrets`.
//   - COLDTRAIL_NO_SEND / NO_TIMERS / NO_UPDATE are set: no email or LinkedIn send, no launchd /
//     systemd timer, no self-update.
//   - tests/e2e/fake-bin is first on PATH, so `opencode` is the canned fake, never a model.
//   - HOME is a sandbox dir too (`<home>.user`), so nothing the server derives from the user's
//     home is real: no gcloud ADC (GOOGLE_APPLICATION_CREDENTIALS also points at a missing file),
//     no ~/Library/LaunchAgents, no agent auth files. The fake opencode is "signed in" there.
//   - Inherited COLDTRAIL_* variables (an API key, a real home) are dropped.
// `stop()` kills the server's whole process group and deletes all three directories.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { PRODUCT_MD, seed as seedWorkspace } from './seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = resolve(HERE, '..');
export const REPO_DIR = resolve(E2E_DIR, '../..');
export const FAKE_BIN = join(E2E_DIR, 'fake-bin');
export const DEFAULT_BIN = join(REPO_DIR, 'target/debug/coldtrail');

const SEEDS = ['full', 'empty', 'onboarded'];
const URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([A-Za-z0-9-]+)/;
const START_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 64 * 1024;

const CONFIG_TOML = 'agent = "opencode"\nopencode_model = "fake/model-a"\n';
// A stored (fake) Canonical token is what makes the workspace count as connected. It is never
// used: nothing in the suite sources, and the endpoint is unresolvable (.invalid).
const SECRETS_TOML = `[tokens.canonical]
access = "e2e-fake-canonical-access-token"
token_endpoint = "https://canonical.invalid/oauth/token"
client_id = "coldtrail-e2e"
`;

// Servers still running, killed if the test process exits without stopping them.
const live = new Set();
let exitHookInstalled = false;

/**
 * Start an isolated server.
 * @param {{ seed?: 'full'|'empty'|'onboarded', bin?: string }} [opts]
 *   `empty`: config only (opencode + fake model), not onboarded. `onboarded`: plus a company
 *   profile and a Canonical token, no data. `full`: plus the deterministic workspace (seed.mjs).
 */
export async function startServer({ seed = 'full', bin = DEFAULT_BIN } = {}) {
  if (!SEEDS.includes(seed)) throw new Error(`startServer: unknown seed "${seed}"`);
  if (!existsSync(bin)) throw new Error(`coldtrail binary not found at ${bin}; run \`cargo build\` first`);

  const home = mkdtempSync(join(tmpdir(), 'coldtrail-e2e-'));
  const secretsDir = `${home}.secrets`;
  const userHome = `${home}.user`;
  const dirs = [home, secretsDir, userHome];
  const realWorkspace = resolve(homedir(), '.coldtrail');
  for (const dir of dirs) {
    if (resolve(dir) === realWorkspace || resolve(dir).startsWith(realWorkspace + '/')) {
      throw new Error(`refusing to use ${dir}: it is inside the real coldtrail workspace`);
    }
  }

  let child;
  try {
    mkdirSync(join(userHome, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(userHome, '.local/share/opencode/auth.json'), '{}\n');
    writeFileSync(join(home, 'config.toml'), CONFIG_TOML);
    const env = serverEnv({ home, userHome });

    // Any DB-touching subcommand creates the schema (with its migrations); this one sends
    // nothing for the email channel, and NO_SEND is set regardless.
    const init = spawnSync(bin, ['send-pending', 'email'], {
      env,
      cwd: home,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (init.status !== 0) {
      const why = init.error?.message ?? init.status ?? init.signal;
      throw new Error(`schema init failed (${why}):\n${init.stdout}\n${init.stderr}`);
    }
    if (seed !== 'empty') {
      writeFileSync(join(home, 'product.md'), PRODUCT_MD);
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(join(secretsDir, 'secrets.toml'), SECRETS_TOML, { mode: 0o600 });
    }
    if (seed === 'full') seedWorkspace(home);

    const port = await freePort();
    child = spawn(bin, ['serve', '--port', String(port), '--no-open'], {
      env,
      cwd: home,
      // Its own process group, so stop() also ends anything it spawned (agent turns, runs).
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    live.add(child);
    installExitHook();

    // Keep draining both pipes for the server's whole life (a full pipe would block it) and
    // keep the tail for error messages.
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk).slice(-OUTPUT_LIMIT);
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);

    const [, actualPort, token] = await new Promise((resolveUrl, reject) => {
      const timer = setTimeout(() => {
        done();
        reject(new Error(`coldtrail serve printed no URL within ${START_TIMEOUT_MS}ms:\n${output}`));
      }, START_TIMEOUT_MS);
      const onData = () => {
        const m = output.match(URL_RE);
        if (m) {
          done();
          resolveUrl(m);
        }
      };
      const onExit = (code, signal) => {
        done();
        reject(new Error(`coldtrail serve exited (${code ?? signal}) before printing its URL:\n${output}`));
      };
      const onError = (err) => {
        done();
        reject(new Error(`coldtrail serve failed to start: ${err.message}`));
      };
      const done = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      child.stdout.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
      onData();
    });

    const base = `http://127.0.0.1:${actualPort}`;
    let stopped = false;
    return {
      seed,
      base,
      token,
      home,
      secretsDir,
      userHome,
      pid: child.pid,
      /** The app URL with the session token, optionally at a route: `url('#/pipeline')`. */
      url(hash = '') {
        const h = !hash ? '' : hash.startsWith('#') ? hash : hash.startsWith('/') ? `#${hash}` : `#/${hash}`;
        return `${base}/?t=${token}${h}`;
      },
      /** An API URL carrying the token, for direct requests: `apiUrl('/api/summary')`. */
      apiUrl(path) {
        return `${base}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
      },
      /** Rows from a read-only query against the workspace DB (for asserting server-side state). */
      query(sql, ...params) {
        const db = new DatabaseSync(join(home, 'outreach.db'), { readOnly: true });
        try {
          return db.prepare(sql).all(...params).map((row) => ({ ...row }));
        } finally {
          db.close();
        }
      },
      /** The last ~64 KB of the server's stdout + stderr. */
      output: () => output,
      /** Kill the server (and its children) and delete the workspace, secrets and sandbox HOME. */
      async stop() {
        if (stopped) return;
        stopped = true;
        await kill(child);
        live.delete(child);
        removeAll(dirs);
      },
    };
  } catch (err) {
    if (child) {
      await kill(child);
      live.delete(child);
    }
    removeAll(dirs);
    throw err;
  }
}

/** The server's environment: the caller's, minus coldtrail/Google credentials, plus isolation. */
function serverEnv({ home, userHome }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('COLDTRAIL_') || k === 'GOOGLE_APPLICATION_CREDENTIALS') continue;
    env[k] = v;
  }
  return {
    ...env,
    COLDTRAIL_HOME: home,
    COLDTRAIL_NO_SEND: '1',
    COLDTRAIL_NO_TIMERS: '1',
    COLDTRAIL_NO_UPDATE: '1',
    PATH: [FAKE_BIN, process.env.PATH].filter(Boolean).join(delimiter),
    HOME: userHome,
    GOOGLE_APPLICATION_CREDENTIALS: join(userHome, 'no-gcloud-adc.json'),
  };
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

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function exited(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

async function kill(child) {
  signalGroup(child, 'SIGTERM');
  if (!(await exited(child, 5_000))) {
    signalGroup(child, 'SIGKILL');
    await exited(child, 5_000);
  }
  // Agent turns or runs it spawned share its group; make sure none outlive it.
  try {
    process.kill(-child.pid, 0); // throws once the whole group is gone
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // group already empty
  }
}

function removeAll(dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of live) signalGroup(child, 'SIGKILL');
  });
}

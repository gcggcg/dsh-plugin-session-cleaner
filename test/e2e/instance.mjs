/**
 * Isolated DSH Web instance lifecycle for the E2E harness.
 *
 * The instance boots the packaged desktop distribution's CLI as Node
 * (`ELECTRON_RUN_AS_NODE=1`) against a private DSH home, prints an
 * authenticated `?token=` URL, and is always torn down by process tree.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLI, ELECTRON, HOME, PLUGIN_PACKAGE, PLUGIN_ROOT, PORT, PROFILE, PROFILE_DIR, SEED } from './config.mjs';

const PID_FILE = join(HOME, 'e2e-instance.pid');
const LOG_FILE = join(HOME, 'e2e-instance.log');
const FIXTURES_FILE = join(HOME, 'e2e-archived-fixtures.json');
/** Read-only source of the local account files that keep the isolated GUI signed in. */
const CREDENTIALS_SOURCE = process.env.DSH_E2E_CREDENTIALS_SOURCE ?? join(homedir(), '.dsh');
/** Account files copied into the isolated home (never modified at the source). */
const CREDENTIAL_FILES = ['.credentials.yaml', '.anonymous-user-id'];

/** Minimal web profile definition used when the isolated home has none yet. */
const PROFILE_FILES = {
  'cordis.yml': '# dsh profile root — composed from the bundle patch layers.\n[]\n',
  'cordis.patch.yml': [
    '# E2E profile layer: suppress the first-run welcome notice so the sidebar is',
    '# reachable immediately; everything else is the shipped web profile.',
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '  config:',
    '    welcomeNoticeVersion: 2026-09-28.1',
    '',
  ].join('\n'),
  'pnpm-workspace.yaml': 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
};

/**
 * Create or repair the isolated profile and link this plugin into it.
 * @returns {Promise<string>} the profile directory.
 */
export async function ensureProfile() {
  await mkdir(PROFILE_DIR, { recursive: true });
  for (const [name, contents] of Object.entries(PROFILE_FILES)) {
    const path = join(PROFILE_DIR, name);
    if (!existsSync(path)) await writeFile(path, contents);
  }
  const packagePath = join(PROFILE_DIR, 'package.json');
  const manifest = existsSync(packagePath)
    ? JSON.parse(await readFile(packagePath, 'utf8'))
    : { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  manifest.name = `dsh-profile-${PROFILE}`;
  manifest.private = true;
  manifest.dependencies ??= {};
  // Older isolated homes may still carry the pre-scope link; drop it so the
  // loader never sees two rows for the same bundle.
  delete manifest.dependencies['dsh-plugin-session-cleaner'];
  manifest.dependencies[PLUGIN_PACKAGE] = `link:${PLUGIN_ROOT}`;
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  for (const required of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) if (!bundles.includes(required)) bundles.push(required);
  const keptBundles = bundles.filter((entry) => entry !== 'dsh-plugin-session-cleaner');
  if (!keptBundles.includes(PLUGIN_PACKAGE)) keptBundles.push(PLUGIN_PACKAGE);
  manifest.dsh.profile.bundles = keptBundles;
  await writeFile(packagePath, JSON.stringify(manifest, null, 2) + '\n');

  const nodeModules = join(PROFILE_DIR, 'node_modules');
  await mkdir(nodeModules, { recursive: true });
  const link = join(nodeModules, ...PLUGIN_PACKAGE.split('/'));
  if (!existsSync(link)) {
    const { symlink } = await import('node:fs/promises');
    await mkdir(join(link, '..'), { recursive: true });
    try {
      await symlink(PLUGIN_ROOT, link, 'junction');
    } catch (error) {
      throw new Error(`cannot link the plugin into the isolated profile at ${link}: ${String(error)}`);
    }
  }
  return PROFILE_DIR;
}

/**
 * Restore sessions + workspace bookkeeping from the seed snapshot.
 *
 * The seed's own `archivedSessionIds` may reference sessions without local logs
 * (ghosts that never render), so a deterministic archived-visibility fixture is
 * seeded too: for each workspace, the first session that (a) is listed in that
 * workspace, (b) has a log directory in the seed, and (c) is not pinned, is
 * marked archived. Those ids are written to `e2e-archived-fixtures.json` for
 * the suite to assert against.
 *
 * @returns {Promise<boolean>} whether a seed snapshot was available.
 */
export async function resetHome() {
  if (!existsSync(SEED)) return false;
  await rm(join(HOME, 'sessions'), { recursive: true, force: true });
  await mkdir(join(HOME, 'storages'), { recursive: true });
  await cp(join(SEED, 'sessions'), join(HOME, 'sessions'), { recursive: true });
  for (const name of ['workspace.json', 'session_projcache']) {
    const source = join(SEED, 'storages', name);
    if (!existsSync(source)) continue;
    await rm(join(HOME, 'storages', name), { recursive: true, force: true });
    await cp(source, join(HOME, 'storages', name), { recursive: true });
  }
  const fixtures = await seedArchivedFixtures();
  await writeFile(FIXTURES_FILE, JSON.stringify({ fixtures }, null, 2) + '\n');
  await seedCredentials();
  return true;
}

/**
 * Copy the local account files into the isolated home so opening a session does
 * not raise the account/onboarding modal mid-suite (the source files are only
 * read, never modified).
 */
async function seedCredentials() {
  for (const name of CREDENTIAL_FILES) {
    const source = join(CREDENTIALS_SOURCE, name);
    if (!existsSync(source)) continue;
    await cp(source, join(HOME, name));
  }
}

/**
 * Mark one log-backed session per workspace as archived in the isolated home.
 * @returns {Promise<Array<{ id: string, workspaceKey: string }>>} the fixture rows.
 */
async function seedArchivedFixtures() {
  const workspaceFile = join(HOME, 'storages', 'workspace.json');
  if (!existsSync(workspaceFile)) return [];
  const json = JSON.parse(await readFile(workspaceFile, 'utf8'));
  const archived = new Set(json.global.archivedSessionIds ?? []);
  const pinned = new Set(json.global.pinnedSessionIds ?? []);
  const sessionsRoot = join(HOME, 'sessions');
  const onDisk = new Set();
  if (existsSync(sessionsRoot)) {
    for (const project of await readdir(sessionsRoot)) {
      for (const entry of await readdir(join(sessionsRoot, project))) onDisk.add(entry);
    }
  }
  const fixtures = [];
  for (const [workspaceId, workspace] of Object.entries(json.tables.workspaces ?? {})) {
    for (const sessionId of workspace.sessionIds ?? []) {
      if (archived.has(sessionId) || pinned.has(sessionId) || !onDisk.has(sessionId)) continue;
      archived.add(sessionId);
      fixtures.push({ id: sessionId, workspaceKey: `workspace:${workspaceId}` });
      break;
    }
  }
  json.global.archivedSessionIds = [...archived];
  await writeFile(workspaceFile, JSON.stringify(json, null, 2) + '\n');
  return fixtures;
}

/**
 * The archived fixtures seeded by the last {@link resetHome}.
 * @returns {Promise<Array<{ id: string, workspaceKey: string }>>} fixture rows.
 */
export async function archivedFixtures() {
  try {
    return JSON.parse(await readFile(FIXTURES_FILE, 'utf8')).fixtures ?? [];
  } catch {
    return [];
  }
}

/**
 * Kill a previous instance recorded in `.tmp-test/home/e2e-instance.pid`.
 * @returns {Promise<boolean>} whether a process was terminated.
 */
export async function stopInstance() {
  if (!existsSync(PID_FILE)) return false;
  const raw = (await readFile(PID_FILE, 'utf8')).trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  await rm(PID_FILE, { force: true });
  return true;
}

/**
 * Boot the isolated instance and wait for its authenticated URL.
 * @param {{ port?: number, timeoutMs?: number }} [options] - overrides.
 * @returns {Promise<{ url: string, origin: string, pid: number, stop: () => Promise<void> }>}
 */
export async function startInstance({ port = PORT, timeoutMs = 90000 } = {}) {
  await stopInstance();
  await ensureProfile();
  // A stale pid file must never be left behind if boot fails midway.
  const child = spawn(ELECTRON, [CLI, '--profile', PROFILE, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: HOME,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await mkdir(HOME, { recursive: true });
  await writeFile(PID_FILE, String(child.pid));

  let output = '';
  const deadline = Date.now() + timeoutMs;
  const url = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      void writeFile(LOG_FILE, output).catch(() => {});
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(output);
      if (match !== null) resolve(match[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`isolated DSH exited before printing a URL (code ${String(code)})\n${output.slice(-4000)}`)));
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for the isolated DSH URL after ${String(timeoutMs)}ms\n${output.slice(-4000)}`));
      }
    }, 500);
  });
  // Give the HTTP listener a moment to accept the authenticated redirect.
  const origin = new URL(url).origin;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(origin + '/', { redirect: 'manual' });
      if (response.status < 500) break;
    } catch {
      /* listener not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    url,
    origin,
    pid: child.pid,
    async stop() {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      await stopInstance();
    },
  };
}

/** @returns {Promise<number>} the recorded instance pid, or 0. */
export async function recordedPid() {
  if (!existsSync(PID_FILE)) return 0;
  try {
    return Number((await readFile(PID_FILE, 'utf8')).trim()) || 0;
  } catch {
    return 0;
  }
}

/** @returns whether the isolated home has a usable seed snapshot. */
export async function hasSeed() {
  try {
    await access(join(SEED, 'sessions'));
    return true;
  } catch {
    return false;
  }
}

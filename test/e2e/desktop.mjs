/**
 * Real Desktop-shell harness for the session-cleaner E2E checks.
 *
 * The reported failures ("sessions cannot be deleted", "cannot show/hide
 * archived sessions") only happen in the packaged Electron shell, whose page
 * origin is `dsh-app://app` instead of `http://127.0.0.1:<port>`. This module
 * boots a SECOND Desktop instance safely:
 *
 *   - its own DSH home     (`.tmp-test/desktop-home`, seeded like the web E2E home)
 *   - its own Electron userData (`--user-data-dir=.tmp-test/desktop-userdata`)
 *   - its own CDP port      (`--remote-debugging-port=9333`)
 *
 * so it can never collide with the already running Desktop app (whose DSH home
 * contains `E:\app\deepseek-harness-data` and which must never be killed), and
 * it is always torn down by its own process tree.
 *
 * The profile directory (`<home>/profiles/desktop`) is a copy of the user's real
 * Desktop profile with this plugin linked in; `node_modules` is composed from
 * junctions into the real profile's `node_modules` (never written to) so every
 * third-party plugin the user has installed loads exactly as it does at home.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ELECTRON, PLUGIN_ROOT, SEED, TEMP_ROOT, playwright } from './config.mjs';

/** Isolated DSH home for the second Desktop instance. */
export const DESKTOP_HOME = join(TEMP_ROOT, 'desktop-home');
/** Isolated Electron userData (single-instance lock + localStorage live here). */
export const DESKTOP_USERDATA = join(TEMP_ROOT, 'desktop-userdata');
/** Profile the second Desktop instance boots. */
export const DESKTOP_PROFILE = join(DESKTOP_HOME, 'profiles', 'desktop');
export const DESKTOP_PID_FILE = join(TEMP_ROOT, 'desktop-instance.pid');
export const DESKTOP_LOG = join(TEMP_ROOT, 'desktop-instance.log');
export const DESKTOP_DIAGNOSTIC = join(TEMP_ROOT, 'desktop-diagnostic.txt');
/** Page origin served by the Electron shell (not an HTTP origin). */
export const DESKTOP_ORIGIN = 'dsh-app://app';

const realHome = process.env.DSH_E2E_REAL_HOME ?? join(homedir(), '.dsh');
const realProfile = process.env.DSH_E2E_REAL_PROFILE ?? join(realHome, 'profiles', 'desktop');

/** Profile manifest files copied from the user's real Desktop profile. */
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml'];
/** DSH home root files that make the isolated home look like a signed-in one. */
const HOME_FILES = ['.credentials.yaml', '.anonymous-user-id'];

/**
 * Build (or rebuild) the isolated Desktop home and profile.
 *
 * @param {{ pluginRoot?: string, keepUserData?: boolean }} [options] - `pluginRoot`
 *   is the plugin checkout the profile links to (defaults to this repo; the
 *   reproduction run points it at a frozen baseline snapshot).
 * @returns {Promise<{ home: string, profile: string }>}
 */
export async function buildDesktopHome({ pluginRoot = PLUGIN_ROOT, keepUserData = true } = {}) {
  if (!existsSync(ELECTRON)) throw new Error(`packaged Desktop launcher missing: ${ELECTRON}`);
  if (!existsSync(join(SEED, 'sessions'))) throw new Error(`no seed snapshot under ${SEED}; run "node scripts/setup-e2e.mjs" first`);
  if (!existsSync(realProfile)) throw new Error(`the user's real Desktop profile is missing: ${realProfile}`);

  await rm(DESKTOP_HOME, { recursive: true, force: true });
  if (!keepUserData) await rm(DESKTOP_USERDATA, { recursive: true, force: true });
  await mkdir(join(DESKTOP_HOME, 'storages'), { recursive: true });

  // Session store + workspace bookkeeping: same snapshot as the web E2E home.
  await cp(join(SEED, 'sessions'), join(DESKTOP_HOME, 'sessions'), { recursive: true });
  for (const name of ['workspace.json', 'session_projcache']) {
    const source = join(SEED, 'storages', name);
    if (existsSync(source)) await cp(source, join(DESKTOP_HOME, 'storages', name), { recursive: true });
  }
  for (const name of HOME_FILES) {
    const source = join(realHome, name);
    if (existsSync(source)) await cp(source, join(DESKTOP_HOME, name));
  }

  // Profile: a copy of the user's real Desktop profile (same plugins, same
  // cordis patch layers) except that the session-cleaner link points at the
  // checkout under test.
  await mkdir(DESKTOP_PROFILE, { recursive: true });
  for (const name of PROFILE_FILES) {
    const source = join(realProfile, name);
    if (existsSync(source)) await cp(source, join(DESKTOP_PROFILE, name));
  }
  const manifestPath = join(DESKTOP_PROFILE, 'package.json');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : { name: 'dsh-profile-desktop', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  manifest.name = 'dsh-profile-desktop';
  manifest.private = true;
  manifest.dependencies ??= {};
  manifest.dependencies['dsh-plugin-session-cleaner'] = `link:${pluginRoot}`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  await linkProfileModules({ pluginRoot });
  return { home: DESKTOP_HOME, profile: DESKTOP_PROFILE };
}

/**
 * Compose the profile's `node_modules` from junctions/references into the real
 * profile's modules: every package resolves as installed, but the
 * session-cleaner package is a junction to the checkout under test.
 * Nothing under the real profile is ever modified.
 *
 * @param {{ pluginRoot: string }} options - plugin checkout to link.
 */
async function linkProfileModules({ pluginRoot }) {
  const destination = join(DESKTOP_PROFILE, 'node_modules');
  const source = join(realProfile, 'node_modules');
  if (!existsSync(source)) throw new Error(`the user's real Desktop profile has no node_modules: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      await cp(from, to);
      continue;
    }
    if (entry.name === '@deepseek-ai' || entry.name.startsWith('@')) {
      // Scope directories are materialized so a nested link can be replaced.
      await mkdir(to, { recursive: true });
      for (const child of await readdir(from, { withFileTypes: true })) {
        const childFrom = join(from, child.name);
        const childTo = join(to, child.name);
        if (child.isDirectory() || child.isSymbolicLink()) await symlink(childFrom, childTo, 'junction');
        else await cp(childFrom, childTo);
      }
      continue;
    }
    if (entry.name === 'dsh-plugin-session-cleaner') {
      await symlink(pluginRoot, to, 'junction');
      continue;
    }
    await symlink(from, to, 'junction');
  }
  // The plugin under test is always reachable by name.
  const pluginLink = join(destination, 'dsh-plugin-session-cleaner');
  if (!existsSync(pluginLink)) await symlink(pluginRoot, pluginLink, 'junction');
}

/**
 * Boot the isolated Desktop instance and wait for its CDP endpoint.
 *
 * @param {{ port?: number, timeoutMs?: number }} [options] - CDP port (default 9333).
 * @returns {Promise<{ pid: number, port: number, log: string }>}
 */
export async function launchDesktop({ port = Number(process.env.DSH_E2E_DESKTOP_PORT ?? '9333'), timeoutMs = 180000 } = {}) {
  await stopDesktop();
  await mkdir(DESKTOP_USERDATA, { recursive: true });
  await rm(DESKTOP_DIAGNOSTIC, { force: true });
  await rm(DESKTOP_LOG, { force: true });

  const output = createWriteStream(DESKTOP_LOG);
  // The tool shells that run this harness are themselves spawned by the
  // packaged Electron binary in Node mode, so `ELECTRON_RUN_AS_NODE=1` is
  // inherited. It must be stripped or the host application would boot as Node
  // and reject every Chromium switch ("bad option: --user-data-dir").
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_NO_ATTACH_CONSOLE;
  delete environment.ELECTRON_ENABLE_LOGGING;
  // The harness shell exports its own session coordinates (DSH_HOME,
  // DSH_PROFILE_DIR, DSH_SESSION_ID, DSH_WEB_URL, ...); a child application
  // must not inherit another instance's home or session identity.
  for (const key of Object.keys(environment)) if (key.startsWith('DSH_')) delete environment[key];
  const child = spawn(ELECTRON, [`--user-data-dir=${DESKTOP_USERDATA}`, `--remote-debugging-port=${String(port)}`], {
    cwd: DESKTOP_HOME,
    env: {
      ...environment,
      DSH_HOME: DESKTOP_HOME,
      DSH_PROFILE: 'desktop',
      DSH_PROFILE_DIR: DESKTOP_PROFILE,
      DSH_DESKTOP_DIAGNOSTIC_FILE: DESKTOP_DIAGNOSTIC,
      DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  await writeFile(DESKTOP_PID_FILE, String(child.pid));

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + timeoutMs;
  const endpoint = `http://127.0.0.1:${String(port)}`;
  for (;;) {
    if (exited) {
      throw new Error(`Desktop instance exited before its CDP endpoint was ready\n${(await readText(DESKTOP_LOG)).slice(-6000)}`);
    }
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${endpoint}/json/version\n${(await readText(DESKTOP_LOG)).slice(-6000)}`);
    }
    await delay(500);
  }
  return { pid: child.pid, port, log: DESKTOP_LOG };
}

/**
 * Attach Playwright to the running Desktop instance over CDP.
 *
 * @param {{ port?: number }} [options] - CDP port (default 9333).
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function connectDesktop({ port = Number(process.env.DSH_E2E_DESKTOP_PORT ?? '9333') } = {}) {
  const { chromium } = playwright();
  return chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
}

/**
 * Wait for the shell's `dsh-app://app` page and dismiss any first-run surface.
 *
 * @param browser - Playwright browser attached over CDP.
 * @param {{ timeoutMs?: number }} [options] - how long to wait for the app page.
 * @returns {Promise<import('playwright-core').Page>}
 */
export async function appPage(browser, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const url = page.url();
        if (url.startsWith(`${DESKTOP_ORIGIN}/`) || url === DESKTOP_ORIGIN) return page;
      }
    }
    if (Date.now() > deadline) {
      const pages = browser.contexts().flatMap((context) => context.pages().map((page) => page.url()));
      throw new Error(`no ${DESKTOP_ORIGIN} page appeared; open pages: ${JSON.stringify(pages)}\n${(await readText(DESKTOP_LOG)).slice(-4000)}`);
    }
    await delay(500);
  }
}

/**
 * Skip the Desktop welcome/onboarding window when the isolated home opens one.
 *
 * @param browser - Playwright browser attached over CDP.
 * @returns {Promise<boolean>} whether a welcome window was dismissed.
 */
export async function skipWelcome(browser) {
  let dismissed = false;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      if (url.startsWith(`${DESKTOP_ORIGIN}/`) || url === DESKTOP_ORIGIN) continue;
      const skip = page.locator('button', { hasText: /稍后配置|Set up later|关闭|Close/ }).first();
      if ((await skip.count()) > 0) {
        await skip.click({ force: true }).catch(() => {});
        dismissed = true;
        await delay(1500);
      }
    }
  }
  return dismissed;
}

/**
 * Kill only the Desktop process tree this harness spawned and verify it is gone.
 *
 * @returns {Promise<{ killed: boolean, leftovers: string[] }>}
 */
export async function stopDesktop() {
  let pid = 0;
  if (existsSync(DESKTOP_PID_FILE)) {
    pid = Number((await readFile(DESKTOP_PID_FILE, 'utf8')).trim()) || 0;
  }
  if (pid > 0) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else {
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
    await rm(DESKTOP_PID_FILE, { force: true });
  }
  // Give Windows a moment to reap the tree, then make sure no process of this
  // isolated instance survives. Never touch the pre-existing Desktop app.
  let leftovers = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    leftovers = desktopProcessesWithOurUserData();
    if (leftovers.length === 0) break;
    for (const candidate of leftovers) {
      spawnSync('taskkill', ['/PID', String(candidate), '/T', '/F'], { stdio: 'ignore' });
    }
    await delay(500);
  }
  return { killed: pid > 0, leftovers };
}

/**
 * PIDs of the packaged Desktop app whose command line names this harness's
 * isolated userData directory. Restricted to the app executable so the probe
 * process (whose own command line contains the search needle) never matches,
 * and so the pre-existing Desktop app can never match either.
 *
 * @returns {number[]} matching pids.
 */
function desktopProcessesWithOurUserData() {
  if (process.platform !== 'win32') return [];
  const needle = String(DESKTOP_USERDATA).replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.ProcessId -ne ${String(process.pid)} } | ForEach-Object { $_.ProcessId }`;
  const result = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 });
  return (result.stdout ?? '')
    .split(/\r?\n/u)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/**
 * Whether the given executable runs with this harness's isolated userData.
 * Used to assert the second instance is ours before it is killed.
 *
 * @param {number} pid - candidate process id.
 * @returns {boolean} whether the process belongs to this harness.
 */
export function isOurDesktopProcess(pid) {
  if (process.platform !== 'win32') return false;
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}").CommandLine`;
  const result = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 });
  return (result.stdout ?? '').includes(DESKTOP_USERDATA) || (result.stdout ?? '').includes('desktop-home');
}

/** @param {number} ms - delay. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} path - file to read leniently. @returns {Promise<string>} */
async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/** @returns the canonical real path of a directory (junctions resolved). */
export function realDir(path) {
  return existsSync(path) ? realpathSync.native(path) : path;
}

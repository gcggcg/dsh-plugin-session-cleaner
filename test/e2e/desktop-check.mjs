#!/usr/bin/env node
/**
 * Optional REAL Desktop-shell checks (`dsh-app://app`) — skippable.
 *
 * The reported failures only happened inside the packaged Electron shell, so
 * these checks boot a SECOND Desktop instance and drive the real sidebar there:
 *
 *   - deletion of a session this process has opened (attached, idle) succeeds,
 *     the row disappears without a reload, and the log directory + projection
 *     cache are removed;
 *   - cold deletion keeps working and also removes the projection cache;
 *   - with the built-in archived filter pre-set to `show` (the reporting user's
 *     persisted state) and every per-workspace toggle off, archived sessions are
 *     driven back to `default`/hidden; enabling a workspace shows only its
 *     archived sessions; disabling hides them again and a reload keeps them
 *     hidden.
 *
 * The instance is isolated: its own `--user-data-dir` (`.tmp-test/desktop-userdata`),
 * its own DSH home (`.tmp-test/desktop-home`) and its own CDP port. Only that
 * process tree is ever killed; the user's running Desktop app is never touched.
 *
 * Skipped (exit 0) when the packaged Desktop distribution, the user's real
 * Desktop profile or the E2E seed snapshot are unavailable.
 *
 * Usage: node test/e2e/desktop-check.mjs
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ELECTRON, PLUGIN_ROOT, TEMP_ROOT } from './config.mjs';
import {
  DESKTOP_HOME,
  DESKTOP_LOG,
  DESKTOP_ORIGIN,
  DESKTOP_PROFILE,
  DESKTOP_USERDATA,
  appPage,
  buildDesktopHome,
  connectDesktop,
  launchDesktop,
  skipWelcome,
  stopDesktop,
} from './desktop.mjs';
import { closeMenu, dismissModals, menuItems, openSessionMenu, openWorkspaceMenu, sessionRows } from './browser.mjs';

const REAL_HOME = process.env.DSH_E2E_REAL_HOME ?? join(homedir(), '.dsh');
const REAL_PROFILE = join(REAL_HOME, 'profiles', 'desktop');
const SEED = join(TEMP_ROOT, 'seed');
const SHOW_TOGGLE = '显示归档会话';
const HIDE_TOGGLE = '隐藏归档会话';
const DELETE = '删除会话';

if (!existsSync(ELECTRON)) {
  console.log(`SKIP: packaged Desktop app not found (${ELECTRON})`);
  process.exit(0);
}
if (!existsSync(REAL_PROFILE)) {
  console.log(`SKIP: the user's real Desktop profile is missing (${REAL_PROFILE})`);
  process.exit(0);
}
if (!existsSync(join(SEED, 'sessions'))) {
  console.log(`SKIP: no E2E seed snapshot (${join(SEED, 'sessions')}); run "node scripts/setup-e2e.mjs" first`);
  process.exit(0);
}

const results = [];
/** @param ms - delay. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one named check.
 * @param name - check label.
 * @param fn - async assertion body.
 */
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name}\n${String(error?.stack ?? error)}`);
  }
}

/** On-disk artifact locations of one session in the isolated home. */
async function diskOf(sessionId) {
  const dirs = [];
  const root = join(DESKTOP_HOME, 'sessions');
  if (existsSync(root)) {
    for (const project of await readdir(root)) {
      const candidate = join(root, project, sessionId);
      if (existsSync(candidate)) dirs.push(candidate);
    }
  }
  const projCache = join(DESKTOP_HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  return { dirs, projCache: existsSync(projCache) ? projCache : null };
}

/** Mark one log-backed, unpinned session per workspace as archived (deterministic fixtures). */
async function seedArchivedFixtures() {
  const path = join(DESKTOP_HOME, 'storages', 'workspace.json');
  const json = JSON.parse(await readFile(path, 'utf8'));
  const archived = new Set(json.global.archivedSessionIds ?? []);
  const pinned = new Set(json.global.pinnedSessionIds ?? []);
  const onDisk = new Set();
  const sessionsRoot = join(DESKTOP_HOME, 'sessions');
  for (const project of await readdir(sessionsRoot)) {
    for (const entry of await readdir(join(sessionsRoot, project))) onDisk.add(entry);
  }
  const fixtures = [];
  for (const [workspaceId, workspace] of Object.entries(json.tables.workspaces ?? {})) {
    for (const id of workspace.sessionIds ?? []) {
      if (archived.has(id) || pinned.has(id) || !onDisk.has(id)) continue;
      archived.add(id);
      fixtures.push({ id, workspaceKey: `workspace:${workspaceId}` });
      break;
    }
  }
  json.global.archivedSessionIds = [...archived];
  await writeFile(path, JSON.stringify(json, null, 2) + '\n');
  return fixtures;
}

/** Expand every workspace group so all session rows render. */
async function expandAllGroups(page) {
  for (let round = 0; round < 4; round += 1) {
    const collapsed = await page.evaluate(() =>
      [...document.querySelectorAll('[data-row-key^="workspace:"]')]
        .filter((row) => row.getAttribute('aria-expanded') !== 'true')
        .map((row) => row.getAttribute('data-row-key')),
    );
    if (collapsed.length === 0) break;
    for (const key of collapsed) {
      await page.locator(`[data-row-key="${key}"]`).first().click({ position: { x: 60, y: 10 }, force: true }).catch(() => {});
      await delay(600);
    }
  }
  await delay(800);
}

/** Wait for the sidebar, dismiss overlays and expand every group. */
async function waitSidebar(page) {
  await page.waitForSelector('[data-row-key^="workspace:"]', { timeout: 120000 });
  await delay(1500);
  await dismissModals(page);
  await expandAllGroups(page);
  await delay(1000);
  await dismissModals(page);
}

/** Row snapshot with layout-based visibility (CSS-hidden rows are not visible). */
function rowSnapshot(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-row-key^="session:"]')].map((row) => {
      const rects = row.getClientRects().length;
      const computedDisplay = getComputedStyle(row).display;
      return {
        key: row.getAttribute('data-row-key'),
        archived: row.hasAttribute('aria-description'),
        computedDisplay,
        visible: rects > 0 && computedDisplay !== 'none',
        buttons: row.querySelectorAll('button').length,
        workspaceKey: (() => {
          const section = row.closest('[style*="--dsh-workspace-indent"]');
          const workspace = section === null ? null : section.querySelector('[data-row-key^="workspace:"]');
          return workspace === null ? null : workspace.getAttribute('data-row-key');
        })(),
      };
    }),
  );
}

/** Whether an archived row exists and is visibly rendered. */
function archivedVisible(rows, id) {
  const row = rows.find((candidate) => candidate.key === `session:${id}`);
  return row !== undefined && row.visible;
}

/** The user's persisted sidebar view state, as it was when the bugs were reported. */
const USER_VIEW_STATE = {
  groupBy: 'workspace',
  orderBy: 'updated',
  groupExpansion: {},
  sessionOrderByAccount: {},
  archivedFilter: 'show',
};

/** Install the reporting user's persisted state, then reload so the store hydrates. */
async function seedUserViewState(page) {
  await page.evaluate(
    ({ view, plugin }) => {
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify(view));
      localStorage.setItem('dsh.session-cleaner.workspace-archived', plugin);
    },
    { view: USER_VIEW_STATE, plugin: '{"enabled":{},"restoreFilter":null}' },
  );
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await waitSidebar(page);
}

/** Enable/disable one workspace's archived-session toggle. */
async function setWorkspaceToggle(page, workspaceKey, enabled) {
  await openWorkspaceMenu(page, workspaceKey);
  const items = await menuItems(page);
  const label = enabled ? SHOW_TOGGLE : HIDE_TOGGLE;
  assert.ok(items?.includes(label), `workspace menu must offer ${label}: ${JSON.stringify(items)}`);
  await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: label }).first().click({ force: true });
  await delay(2200);
}

/** The visible plugin dialog (if any). */
function readDialog(page) {
  return page.evaluate(() => {
    const element = document.querySelector('[role="dialog"], [class*="_modal"]');
    return element === null ? null : { text: (element.innerText ?? '').replace(/\s+/gu, ' ').trim() };
  });
}

/**
 * Delete one session through its row menu and confirm.
 * @returns {Promise<object>} the observed dialog after confirmation.
 */
async function deleteViaMenu(page, sessionKey) {
  await openSessionMenu(page, sessionKey);
  const items = await menuItems(page);
  assert.ok(items?.includes(DELETE), `delete item missing from ${JSON.stringify(items)}`);
  await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: DELETE }).first().click({ force: true });
  await delay(800);
  assert.ok((await readDialog(page)) !== null, 'confirmation dialog did not open');
  await page.locator('[role="dialog"] button, [class*="_modal"] button').filter({ hasText: /^删\s*除$/u }).first().click({ force: true });
  await delay(4500);
  await dismissModals(page);
  return readDialog(page);
}

let browser;
let fixtures = [];
try {
  await stopDesktop().catch(() => {});
  await buildDesktopHome({ pluginRoot: PLUGIN_ROOT, keepUserData: false });
  fixtures = await seedArchivedFixtures();
  console.log(`fixtures: ${JSON.stringify(fixtures)}`);
  const instance = await launchDesktop();
  console.log(`desktop instance pid ${instance.pid}; CDP port ${instance.port}; log ${DESKTOP_LOG}`);
  browser = await connectDesktop();
  const page = await appPage(browser);

  /** Network evidence for the plugin route. */
  const apiCalls = [];
  const pageErrors = [];
  page.on('response', (response) => {
    if (!response.url().includes('/api/session-cleaner')) return;
    void response
      .json()
      .then((body) => apiCalls.push({ url: response.url(), status: response.status(), body }))
      .catch(() => apiCalls.push({ url: response.url(), status: response.status(), body: null }));
  });
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 800)));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await skipWelcome(browser);
    const ready = await page.waitForSelector('[data-row-key^="workspace:"]', { timeout: 20000 }).then(() => true).catch(() => false);
    if (ready) break;
    await delay(1500);
  }
  await waitSidebar(page);

  await check('the plugin loads in the real Desktop shell (origin dsh-app://app)', async () => {
    assert.equal(page.url().startsWith(`${DESKTOP_ORIGIN}/`), true, `unexpected page url ${page.url()}`);
    assert.equal(
      await page.evaluate(() => document.querySelector('style[data-plugin="dsh-plugin-session-cleaner"]') !== null),
      true,
      'plugin stylesheet is missing: the client bundle did not load',
    );
    const workspaceKeys = await page.evaluate(() =>
      [...document.querySelectorAll('[data-row-key^="workspace:"]')]
        .filter((row) => row.querySelectorAll('button').length >= 2)
        .map((row) => row.getAttribute('data-row-key')),
    );
    assert.ok(workspaceKeys.length > 0, 'the isolated home must expose at least one workspace');
    await openWorkspaceMenu(page, workspaceKeys[0]);
    const items = await menuItems(page);
    await closeMenu(page);
    assert.ok(items?.includes(SHOW_TOGGLE) || items?.includes(HIDE_TOGGLE), `toggle missing from ${JSON.stringify(items)}`);
  });

  await seedUserViewState(page);
  const toggleFixture = fixtures.find((fixture) => fixture.workspaceKey !== 'workspace:') ?? fixtures[0];
  assert.ok(toggleFixture !== undefined, 'the isolated home must seed at least one archived fixture');

  await check('all toggles off drive the built-in "show" filter back to default and hide archived sessions', async () => {
    const view = JSON.parse(await page.evaluate(() => localStorage.getItem('dsh.workspace.view.v5') ?? '{}'));
    assert.equal(view.archivedFilter, 'default', 'the plugin must override the stale built-in "show" filter while every toggle is off');
    const rows = await rowSnapshot(page);
    assert.deepEqual(
      rows.filter((row) => row.archived && row.visible).map((row) => row.key),
      [],
      'archived sessions must be hidden while every per-workspace toggle is off',
    );
  });

  await check('enabling a workspace shows only its archived sessions and disabling hides them again', async () => {
    await setWorkspaceToggle(page, toggleFixture.workspaceKey, true);
    let rows = await rowSnapshot(page);
    assert.equal(archivedVisible(rows, toggleFixture.id), true, 'the enabled workspace\'s archived session must become visible');
    for (const other of fixtures.filter((fixture) => fixture.id !== toggleFixture.id)) {
      assert.equal(archivedVisible(rows, other.id), false, `archived session ${other.id} of another workspace must stay hidden`);
    }
    await setWorkspaceToggle(page, toggleFixture.workspaceKey, false);
    rows = await rowSnapshot(page);
    assert.deepEqual(
      rows.filter((row) => row.archived && row.visible).map((row) => row.key),
      [],
      'turning the last toggle off must hide archived sessions again',
    );
  });

  await check('the archived-visibility state stays hidden after a reload', async () => {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await waitSidebar(page);
    const rows = await rowSnapshot(page);
    assert.deepEqual(
      rows.filter((row) => row.archived && row.visible).map((row) => row.key),
      [],
      'archived sessions must stay hidden after a reload with every toggle off',
    );
  });

  await check('deleting a session this process has opened succeeds without a restart', async () => {
    const rows = await rowSnapshot(page);
    const candidates = [];
    for (const row of rows) {
      if (row.buttons < 1 || row.archived) continue;
      const id = row.key.slice('session:'.length);
      const disk = await diskOf(id);
      if (disk.dirs.length > 0) candidates.push({ ...row, id, disk });
    }
    const target = candidates[0];
    assert.ok(target !== undefined, 'no ordinary session available to open and delete');
    await page.locator(`[data-row-key="${target.key}"]`).first().click({ force: true });
    await delay(4500);
    await dismissModals(page);
    const current = await page.evaluate(() => localStorage.getItem('dsh.sessions.current') ?? '');
    assert.ok(current.includes(target.id), `the opened session must become current (current=${current})`);

    const dialog = await deleteViaMenu(page, target.key);
    assert.equal(dialog, null, `deleting an attached idle session must not be refused: ${JSON.stringify(dialog)}`);
    assert.equal((await rowSnapshot(page)).some((row) => row.key === target.key), false, 'the row must disappear without a reload');
    const disk = await diskOf(target.id);
    assert.deepEqual(disk.dirs, [], 'the session log directory must be removed');
    assert.equal(disk.projCache, null, 'the projection cache must be removed');
    const api = apiCalls.at(-1);
    assert.equal(api?.status, 200, `expected a 200 delete response, got ${JSON.stringify(api)}`);
  });

  await check('cold deletion keeps working and also removes the projection cache', async () => {
    const rows = await rowSnapshot(page);
    const candidates = [];
    for (const row of rows) {
      if (row.buttons < 1 || row.archived) continue;
      const id = row.key.slice('session:'.length);
      const disk = await diskOf(id);
      if (disk.dirs.length > 0) candidates.push({ ...row, id, disk });
    }
    const target = candidates[0];
    assert.ok(target !== undefined, 'no cold session available to delete');
    const dialog = await deleteViaMenu(page, target.key);
    assert.equal(dialog, null, `cold delete must not fail: ${JSON.stringify(dialog)}`);
    assert.equal((await rowSnapshot(page)).some((row) => row.key === target.key), false, 'the deleted row must disappear');
    const disk = await diskOf(target.id);
    assert.deepEqual(disk.dirs, [], 'the session log directory must be removed');
    assert.equal(disk.projCache, null, 'the projection cache must be removed');
    const api = apiCalls.at(-1);
    assert.equal(api?.status, 200, `expected a 200 delete response, got ${JSON.stringify(api)}`);
  });

  await check('the Desktop shell logged no unexpected page errors', async () => {
    assert.deepEqual(pageErrors, []);
  });
} catch (error) {
  results.push({ name: 'desktop harness', ok: false, error });
  console.log(`FAIL desktop harness\n${String(error?.stack ?? error)}`);
} finally {
  await browser?.close().catch(() => {});
  const stopped = await stopDesktop().catch(() => ({ killed: false, leftovers: [] }));
  console.log('teardown:', JSON.stringify(stopped));
  if (stopped.leftovers.length > 0) console.log(`WARN: leftover isolated-desktop processes: ${stopped.leftovers.join(', ')}`);
}

console.log(`\ndesktop: ${DESKTOP_HOME}`);
console.log(`profile: ${DESKTOP_PROFILE}`);
console.log(`userData: ${DESKTOP_USERDATA}`);
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} desktop checks passed`);
if (failed.length > 0) process.exitCode = 1;

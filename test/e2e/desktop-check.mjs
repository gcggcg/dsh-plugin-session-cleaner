#!/usr/bin/env node
/**
 * Optional REAL Desktop-shell checks (`dsh-app://app`) — skippable.
 *
 * The user reports only happen inside the packaged Electron shell, so these
 * checks boot a SECOND Desktop instance and drive the real sidebar there:
 *
 *   - the ONE global "show archived sessions" switch is injected into the
 *     sidebar panel list directly below 自动化任务 (the old per-workspace folder
 *     menu toggle is gone). Default OFF hides every archived session and drives
 *     the built-in archived filter to `default`; ONE click ON shows every
 *     archived session of every workspace and of the ungrouped bucket and drives
 *     the filter to `show`; ONE click OFF hides them again; the state survives a
 *     reload in both directions; manually choosing the built-in
 *     `全部对话（显示已归档）` view option cannot resurrect them while OFF;
 *   - deletion of a session this process has opened (attached, idle) succeeds,
 *     the row disappears without a reload, and the log directory + projection
 *     cache are removed; cold deletion keeps working and also removes the
 *     projection cache.
 *
 * The instance is isolated: its own `--user-data-dir` (`.tmp-test/desktop-userdata`),
 * its own DSH home (`.tmp-test/desktop-home`) and its own CDP port. Only that
 * process tree is ever killed; the user's running Desktop app is never touched.
 *
 * Skipped (exit 0) when the packaged Desktop distribution, the user's real
 * Desktop profile or the E2E seed snapshot are unavailable.
 *
 * Usage: node test/e2e/desktop-check.mjs
 *   (use DSH_E2E_REAL_HOME / DSH_E2E_REAL_PROFILE to point at the real Desktop
 *   home/profile when it does not live under the OS home directory)
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ELECTRON, PLUGIN_ROOT, TEMP_ROOT } from './config.mjs';
import {
  ARCHIVE_HIDE_LABEL,
  ARCHIVE_SHOW_LABEL,
  ARCHIVE_VISIBLE_KEY,
  LEGACY_ARCHIVE_KEY,
  archiveToggle,
  clickArchiveToggle,
  closeMenu,
  dismissModals,
  menuItems,
  openSessionMenu,
  openWorkspaceMenu,
  sessionRows,
  setArchiveVisible,
  visibleArchivedKeys,
  waitForArchiveSwitch,
  waitForArchivedFilter,
  waitForArchivedRows,
} from './browser.mjs';
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

const REAL_HOME = process.env.DSH_E2E_REAL_HOME ?? join(homedir(), '.dsh');
const REAL_PROFILE = process.env.DSH_E2E_REAL_PROFILE ?? join(REAL_HOME, 'profiles', 'desktop');
const SEED = join(TEMP_ROOT, 'seed');
const DELETE = '删除会话';
const ARCHIVE = '归档会话';
const UNARCHIVE = '取消归档';
const VIEW_OPTION_SHOW = '全部对话（显示已归档）';

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

/** Every session row that exposes an action menu, with its disk state. */
async function actionableRows(page) {
  const rows = await rowSnapshot(page);
  const out = [];
  for (const row of rows) {
    if (row.buttons < 1) continue;
    const id = row.key.slice('session:'.length);
    out.push({ ...row, id, disk: await diskOf(id) });
  }
  return out;
}

/** The user's persisted sidebar view state, as it was when the bugs were reported. */
const USER_VIEW_STATE = {
  groupBy: 'workspace',
  orderBy: 'updated',
  groupExpansion: {},
  sessionOrderByAccount: {},
  archivedFilter: 'show',
};

/** Install the reporting user's persisted (stale) state, then reload so the store hydrates. */
async function seedStaleUserState(page) {
  await page.evaluate(
    ({ view, legacyKey, newKey }) => {
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify(view));
      localStorage.setItem(legacyKey, '{"enabled":{"legacy-workspace":true},"restoreFilter":"show"}');
      localStorage.removeItem(newKey);
    },
    { view: USER_VIEW_STATE, legacyKey: LEGACY_ARCHIVE_KEY, newKey: ARCHIVE_VISIBLE_KEY },
  );
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await waitSidebar(page);
  await waitForArchiveSwitch(page);
}

/**
 * Assert the switch rendered the expected state (checked flag, label, storage).
 * @param page - Playwright page.
 * @param state - `archiveToggle(page)` result.
 * @param visible - expected visibility.
 * @param {{ allowAbsent?: boolean }} [options] - `allowAbsent` accepts an absent
 *   storage key for the factory-default OFF state (absent already means hidden);
 *   after any click the state must be persisted as '0'/'1'.
 */
async function assertSwitchState(page, state, visible, { allowAbsent = false } = {}) {
  assert.equal(state.present, true, 'the global archive switch is not injected');
  assert.equal(state.checked, visible, `switch aria-checked must be ${String(visible)}`);
  assert.equal(state.label, visible ? ARCHIVE_HIDE_LABEL : ARCHIVE_SHOW_LABEL, 'switch aria-label must name the next action');
  if (visible) assert.equal(state.stored, '1', `localStorage ${ARCHIVE_VISIBLE_KEY} must be '1' while shown`);
  else if (allowAbsent && state.stored === null) {
    // Factory default: no key yet (absent already means hidden). Still never '1'.
  } else assert.equal(state.stored, '0', `localStorage ${ARCHIVE_VISIBLE_KEY} must be '0' while hidden`);
  const guard = await page.evaluate(() => document.documentElement.getAttribute('data-session-cleaner-archived-guard'));
  if (visible) assert.notEqual(guard, 'all', 'the root archived-row guard must be lifted while the switch is ON');
  else assert.equal(guard, 'all', 'the root archived-row guard must hide archived rows while the switch is OFF');
}

/** The visible plugin dialog (if any). */
function readDialog(page) {
  return page.evaluate(() => {
    const element = document.querySelector('[role="dialog"], [class*="_modal"]');
    return element === null ? null : { text: (element.innerText ?? '').replace(/\s+/gu, ' ').trim() };
  });
}

/** Archive one session through the app's built-in row menu. */
async function archiveViaBuiltin(page, sessionKey) {
  await openSessionMenu(page, sessionKey);
  const items = await menuItems(page);
  assert.ok(items?.some((text) => text.includes(ARCHIVE)), `built-in archive action missing: ${JSON.stringify(items)}`);
  await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: ARCHIVE }).first().click({ force: true });
  await delay(1200);
  const stopAndArchive = page.locator('button', { hasText: '停止并归档' }).first();
  if ((await stopAndArchive.count()) > 0 && (await stopAndArchive.isVisible())) {
    await stopAndArchive.click({ force: true });
    await delay(1400);
  }
  await delay(1500);
}

/** Unarchive one session through the app's built-in row menu (switch must be ON). */
async function unarchiveViaBuiltin(page, sessionKey) {
  await openSessionMenu(page, sessionKey);
  const items = await menuItems(page);
  assert.ok(items?.some((text) => text.includes(UNARCHIVE)), `built-in unarchive action missing: ${JSON.stringify(items)}`);
  await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: UNARCHIVE }).first().click({ force: true });
  await delay(2000);
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
let ungroupedArchivedId = null;
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

  await check('the plugin loads in the real Desktop shell and injects the switch below 自动化任务', async () => {
    assert.equal(page.url().startsWith(`${DESKTOP_ORIGIN}/`), true, `unexpected page url ${page.url()}`);
    assert.equal(
      await page.evaluate(() => document.querySelector('style[data-plugin="dsh-plugin-session-cleaner"]') !== null),
      true,
      'plugin stylesheet is missing: the client bundle did not load',
    );
    const state = await waitForArchiveSwitch(page);
    assert.equal(state.count, 1, `exactly one switch container expected, found ${state.count}`);
    assert.equal(state.inPanelList, true, 'the switch container must live inside nav[class*="panelList"]');
    assert.ok(
      /自动化|Automation|Schedul/iu.test(state.precedingRowLabel ?? ''),
      `the switch must sit directly below 自动化任务, but the preceding panel row was ${JSON.stringify(state.precedingRowLabel)}`,
    );
    assert.equal(state.pillVisible, true, `the switch must render a visible pill (nav width ${String(state.navWidth)}px)`);

    // The old per-workspace folder-menu toggle must be gone.
    const workspaceKeys = await page.evaluate(() =>
      [...document.querySelectorAll('[data-row-key^="workspace:"]')]
        .filter((row) => row.querySelectorAll('button').length >= 2)
        .map((row) => row.getAttribute('data-row-key')),
    );
    assert.ok(workspaceKeys.length > 0, 'the isolated home must expose at least one workspace');
    await openWorkspaceMenu(page, workspaceKeys[0]);
    const items = await menuItems(page);
    await closeMenu(page);
    assert.ok(items?.includes('重命名') && items?.includes('删除工作区'), `unexpected workspace menu: ${JSON.stringify(items)}`);
    for (const label of [ARCHIVE_SHOW_LABEL, ARCHIVE_HIDE_LABEL]) {
      assert.equal(items?.includes(label), false, `the workspace menu must no longer offer ${label}: ${JSON.stringify(items)}`);
    }
  });

  await seedStaleUserState(page);
  assert.ok(fixtures.length >= 2, `the isolated home must seed at least two archived fixtures, found ${fixtures.length}`);

  await check('the archive switch defaults to OFF and hides archived sessions (stale "show" filter overridden)', async () => {
    const state = await archiveToggle(page);
    await assertSwitchState(page, state, false, { allowAbsent: true });
    assert.notEqual(state.legacy, null, 'precondition: the stale legacy per-workspace key must still be present');
    await waitForArchivedFilter(page, 'default');
    assert.deepEqual(await visibleArchivedKeys(page), [], 'no archived session may be visible while the switch is OFF');
  });

  const ungroupedCandidate = (await actionableRows(page)).find(
    (row) => !row.archived && row.workspaceKey === 'workspace:' && row.disk.dirs.length > 0 && /^session-/u.test(row.id),
  );
  if (ungroupedCandidate !== undefined) {
    await archiveViaBuiltin(page, ungroupedCandidate.key);
    ungroupedArchivedId = ungroupedCandidate.id;
    console.log(`note: archived ungrouped fixture ${ungroupedArchivedId} through the built-in menu`);
  } else {
    console.log('note: no ungrouped session available; the ON check covers workspace groups only');
  }
  const fixtureIds = [...fixtures.map((fixture) => fixture.id), ...(ungroupedArchivedId === null ? [] : [ungroupedArchivedId])];

  await check('ONE click shows archived sessions of every workspace and the ungrouped bucket', async () => {
    const before = await archiveToggle(page);
    assert.equal(before.checked, false, 'precondition: the switch must be OFF before the ON click');
    const after = await clickArchiveToggle(page);
    await assertSwitchState(page, after, true);
    assert.equal(after.legacy, null, 'the legacy per-workspace key must be removed once the new state is persisted');
    await waitForArchivedFilter(page, 'show');
    const rows = await waitForArchivedRows(page, fixtureIds, true);
    for (const id of fixtureIds) {
      const row = rows.find((candidate) => candidate.key === `session:${id}`);
      assert.ok(row !== undefined, `archived session ${id} is not rendered while the switch is ON`);
      assert.equal(row.visible, true, `archived session ${id} must be visible while the switch is ON`);
    }
  });

  await check('ONE click hides them again and reports the switch unchecked', async () => {
    const before = await archiveToggle(page);
    assert.equal(before.checked, true, 'precondition: the switch must be ON before the OFF click');
    const after = await clickArchiveToggle(page);
    await assertSwitchState(page, after, false);
    await waitForArchivedFilter(page, 'default');
    await waitForArchivedRows(page, fixtureIds, false);
    assert.deepEqual(await visibleArchivedKeys(page), [], 'no archived session may be visible after the OFF click');
  });

  await check('manually choosing the built-in "show archived" view option cannot resurrect them', async () => {
    const trigger = page.locator('button[aria-label="视图选项"], button[aria-label="View options"]').first();
    await trigger.click({ force: true });
    await delay(500);
    await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: VIEW_OPTION_SHOW }).first().click({ force: true });
    await waitForArchivedFilter(page, 'default');
    await waitForArchivedRows(page, fixtureIds, false);
    assert.deepEqual(await visibleArchivedKeys(page), [], 'archived sessions must be re-hidden although the user picked the built-in "show" filter');
  });

  await check('the switch state persists across reloads (ON stays visible, OFF stays hidden)', async () => {
    await setArchiveVisible(page, true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await waitSidebar(page);
    await waitForArchiveSwitch(page);
    await waitForArchivedFilter(page, 'show');
    await waitForArchivedRows(page, fixtureIds, true);
    let state = await archiveToggle(page);
    await assertSwitchState(page, state, true);

    await setArchiveVisible(page, false);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await waitSidebar(page);
    await waitForArchiveSwitch(page);
    await waitForArchivedFilter(page, 'default');
    await waitForArchivedRows(page, fixtureIds, false);
    state = await archiveToggle(page);
    await assertSwitchState(page, state, false);
  });

  if (ungroupedArchivedId !== null) {
    await setArchiveVisible(page, true);
    await waitForArchivedRows(page, [ungroupedArchivedId], true);
    await unarchiveViaBuiltin(page, `session:${ungroupedArchivedId}`);
    await setArchiveVisible(page, false);
    await waitForArchivedFilter(page, 'default');
  }

  await check('deleting a session this process has opened succeeds without a restart', async () => {
    const candidates = (await actionableRows(page)).filter((row) => !row.archived && row.disk.dirs.length > 0);
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
    const candidates = (await actionableRows(page)).filter((row) => !row.archived && row.disk.dirs.length > 0);
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

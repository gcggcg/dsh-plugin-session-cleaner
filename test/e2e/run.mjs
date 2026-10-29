/**
 * End-to-end suite for the session-cleaner plugin.
 *
 * Boots an isolated DSH Web instance (private DSH home, seeded session logs),
 * drives the real sidebar with Playwright, and verifies both features:
 *   1. the ONE global "show archived sessions" switch injected into the sidebar
 *      panel list directly below 自动化任务 (it replaced the old per-workspace
 *      folder-menu toggle, which the user found unreliable);
 *   2. permanent session deletion (session row menu + host route).
 *
 * The archived-visibility checks use log-backed archived fixtures seeded into
 * the isolated home (at least one per workspace, plus one ungrouped session
 * archived through the app's own row menu) and lock the agreed contract:
 *   - the switch exists exactly once, lives in `nav[class*="panelList"]` right
 *     after the 自动化任务 row, and is a `button[role="switch"]` with a visible
 *     pill and the localized action label;
 *   - default OFF: archived sessions are not visible and the built-in
 *     `dsh.workspace.view.v5` archived filter is driven to `default` (even when
 *     a stale `show` was pre-seeded);
 *   - ONE click ON: every archived session of every workspace and of the
 *     ungrouped bucket becomes visible, the built-in filter becomes `show`, the
 *     switch reports `aria-checked="true"`/隐藏归档会话, and localStorage holds
 *     `dsh.session-cleaner.archived-visible = "1"` while the legacy
 *     per-workspace key is removed;
 *   - ONE click OFF: everything is hidden again, the filter returns to
 *     `default`, the switch reports unchecked, and storage holds `"0"`;
 *   - manually choosing the built-in 全部对话（显示已归档） view option cannot
 *     resurrect archived sessions while the switch is OFF;
 *   - the state survives reloads in both directions.
 *
 * The deletion checks lock the earlier regressions:
 *   - a session that this process has OPENED (attached, idle) is deletable
 *     without restarting DSH;
 *   - deletion removes the log directory, the projection cache and every
 *     workspace reference, and the row disappears without a reload.
 *
 * Prerequisites: `node scripts/setup-e2e.mjs` (playwright-core + seed snapshot),
 * plus the packaged DSH desktop distribution on this machine.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { HOME, PORT, hasPackagedDsh } from './config.mjs';
import {
  ARCHIVE_HIDE_LABEL,
  ARCHIVE_SHOW_LABEL,
  ARCHIVE_VISIBLE_KEY,
  archiveToggle,
  clickArchiveToggle,
  closeMenu,
  dismissModals,
  expandWorkspaceGroups,
  launchBrowser,
  menuItems,
  openApp,
  openSessionMenu,
  openWorkspaceMenu,
  pickViewOption,
  readArchivedFilter,
  sessionRows,
  setArchiveVisible,
  visibleArchivedKeys,
  waitForArchiveSwitch,
  waitForArchivedFilter,
  waitForArchivedRows,
} from './browser.mjs';
import { archivedFixtures, hasSeed, resetHome, startInstance } from './instance.mjs';

const DELETE = '删除会话';
const ARCHIVE = '归档会话';
const UNARCHIVE = '取消归档';
const VIEW_OPTION_SHOW = '全部对话（显示已归档）';

const results = [];

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

/** @param ms - delay. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** On-disk artifact locations of one session id. */
async function sessionOnDisk(sessionId) {
  const dirs = [];
  const root = join(HOME, 'sessions');
  if (existsSync(root)) {
    for (const project of await readdir(root)) {
      const candidate = join(root, project, sessionId);
      if (existsSync(candidate)) dirs.push(candidate);
    }
  }
  const projCache = join(HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  return { dirs, projCache: existsSync(projCache) ? projCache : null };
}

/** Every sidebar session row that exposes an action menu, with its disk state. */
async function actionableRows(page) {
  const rows = await sessionRows(page);
  const out = [];
  for (const row of rows) {
    if (row.buttons < 1) continue;
    const id = row.key.slice('session:'.length);
    out.push({ ...row, id, disk: await sessionOnDisk(id) });
  }
  return out;
}

/** The currently visible plugin dialog (if any) with its localized error. */
function readDialog(page) {
  return page.evaluate(() => {
    const element = document.querySelector('[role="dialog"], [class*="_modal"]');
    if (element === null) return null;
    return {
      text: (element.innerText ?? '').replace(/\s+/gu, ' ').trim(),
      alert: (element.querySelector('[role="alert"]')?.textContent ?? '').trim() || null,
    };
  });
}

/** Confirm the plugin's destructive dialog. */
async function confirmDelete(page) {
  await page.locator('[role="dialog"] button, [class*="_modal"] button').filter({ hasText: /^删\s*除$/u }).first().click({ force: true });
  await delay(3500);
}

/** Reload the GUI, re-expand the workspace groups and wait for the archive switch. */
async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-row-key^="workspace:"]', { timeout: 60000 });
  await delay(2000);
  await dismissModals(page);
  await expandWorkspaceGroups(page);
  await waitForArchiveSwitch(page);
}

/**
 * Archive one session through the app's own built-in row menu.
 * @param page - Playwright page.
 * @param sessionKey - `session:<id>` row key of an unarchived session.
 * @returns the menu items that were offered.
 */
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
  return items;
}

/**
 * Unarchive one session through the app's own built-in row menu (requires the
 * global switch to be ON so the archived row is rendered).
 * @param page - Playwright page.
 * @param sessionKey - `session:<id>` row key of an archived session.
 * @returns the menu items that were offered.
 */
async function unarchiveViaBuiltin(page, sessionKey) {
  await openSessionMenu(page, sessionKey);
  const items = await menuItems(page);
  assert.ok(items?.some((text) => text.includes(UNARCHIVE)), `built-in unarchive action missing: ${JSON.stringify(items)}`);
  await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: UNARCHIVE }).first().click({ force: true });
  await delay(2000);
  return items;
}

/**
 * Assert the switch rendered the expected state (checked flag, label, storage).
 * @param state - `archiveToggle(page)` result.
 * @param visible - expected visibility.
 * @param {{ allowAbsent?: boolean }} [options] - `allowAbsent` accepts an absent
 *   storage key for the factory-default OFF state (absent already means hidden);
 *   after any click the state must be persisted as '0'/'1'.
 */
async function assertSwitchState(page, state, visible, { allowAbsent = false } = {}) {
  assert.equal(state.present, true, 'the global archive switch is not injected');
  assert.equal(state.checked, visible, `switch aria-checked must be ${String(visible)}`);
  assert.equal(state.ariaChecked, visible ? 'true' : 'false', 'aria-checked attribute mismatch');
  assert.equal(state.label, visible ? ARCHIVE_HIDE_LABEL : ARCHIVE_SHOW_LABEL, 'switch aria-label must name the next action');
  assert.equal(state.title, visible ? ARCHIVE_HIDE_LABEL : ARCHIVE_SHOW_LABEL, 'switch title must name the next action');
  if (visible) assert.equal(state.stored, '1', `localStorage ${ARCHIVE_VISIBLE_KEY} must be '1' while shown`);
  else if (allowAbsent && state.stored === null) {
    // Factory default: no key yet (absent already means hidden). Still never '1'.
  } else assert.equal(state.stored, '0', `localStorage ${ARCHIVE_VISIBLE_KEY} must be '0' while hidden`);
  const guard = await page.evaluate(() => document.documentElement.getAttribute('data-session-cleaner-archived-guard'));
  if (visible) assert.notEqual(guard, 'all', 'the root archived-row guard must be lifted while the switch is ON');
  else assert.equal(guard, 'all', 'the root archived-row guard must hide archived rows while the switch is OFF');
}

if (!hasPackagedDsh()) {
  console.error('SKIP: packaged DeepSeek Harness distribution not found (set DSH_E2E_ELECTRON / DSH_E2E_CLI)');
  process.exit(0);
}
if (!(await hasSeed())) {
  console.error('SKIP: no seed snapshot under .tmp-test/seed; run "node scripts/setup-e2e.mjs" first');
  process.exit(0);
}

await resetHome();
const fixtures = await archivedFixtures();
const instance = await startInstance({ port: PORT });
const browser = await launchBrowser();
let page;
let errors = [];

try {
  const opened = await openApp(browser, instance.url);
  page = opened.page;
  errors = opened.errors;

  // ── 1. plugin loaded + the single injected switch ──────────────────────
  await check('plugin injects exactly one archive switch below 自动化任务 in the sidebar panel list', async () => {
    assert.ok(
      await page.evaluate(() => document.querySelector('style[data-plugin="dsh-plugin-session-cleaner"]') !== null),
      'plugin stylesheet is missing: the client bundle did not load',
    );
    const state = await waitForArchiveSwitch(page);
    assert.equal(state.count, 1, `exactly one [${'data-session-cleaner-archive-toggle'}] container expected, found ${state.count}`);
    assert.equal(state.inPanelList, true, 'the switch container must live inside nav[class*="panelList"]');
    assert.ok(state.panelRowLabels.length >= 2, `the panel list must render its rows: ${JSON.stringify(state.panelRowLabels)}`);
    assert.ok(
      state.panelRowLabels.some((label) => /自动化|Automation|Schedul/iu.test(label ?? '')),
      `the sidebar must expose the 自动化任务 panel row: ${JSON.stringify(state.panelRowLabels)}`,
    );
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
    assert.ok(workspaceKeys.length > 0, 'seed must provide at least one real workspace');
    await openWorkspaceMenu(page, workspaceKeys[0]);
    const items = await menuItems(page);
    await closeMenu(page);
    assert.ok(items !== null, 'workspace menu did not open');
    assert.ok(items.includes('重命名') && items.includes('删除工作区'), `unexpected workspace menu: ${JSON.stringify(items)}`);
    for (const label of [ARCHIVE_SHOW_LABEL, ARCHIVE_HIDE_LABEL]) {
      assert.equal(items.includes(label), false, `the workspace menu must no longer offer ${label}: ${JSON.stringify(items)}`);
    }
  });

  // ── 2. default OFF ─────────────────────────────────────────────────────
  await check('the archive switch defaults to OFF and hides every archived session', async () => {
    assert.ok(fixtures.length >= 2, `the isolated home must seed at least two log-backed archived fixtures, found ${fixtures.length}`);
    const state = await archiveToggle(page);
    await assertSwitchState(page, state, false, { allowAbsent: true });
    assert.notEqual(state.legacy, null, 'precondition: the stale legacy per-workspace key must still be present on first load');
    const filter = await waitForArchivedFilter(page, 'default');
    assert.equal(filter, 'default', 'the built-in archived filter must be driven to "default" while the switch is OFF');
    assert.deepEqual(await visibleArchivedKeys(page), [], 'no archived session may be visible while the switch is OFF');
  });

  // An ungrouped session is archived through the app's own menu so the ON check
  // also covers the ungrouped bucket ("all archived sessions everywhere").
  const ungroupedCandidate = (await actionableRows(page)).find(
    (row) => !row.archived && row.workspaceKey === 'workspace:' && row.disk.dirs.length > 0 && /^session-/u.test(row.id),
  );
  let ungroupedArchivedId = null;
  if (ungroupedCandidate !== undefined) {
    const items = await archiveViaBuiltin(page, ungroupedCandidate.key);
    ungroupedArchivedId = ungroupedCandidate.id;
    console.log(`note: archived ungrouped fixture ${ungroupedArchivedId} through the built-in menu (${JSON.stringify(items.slice(0, 2))}…)`);
  } else {
    console.log('note: no ungrouped session available; the ON check covers workspace groups only');
  }
  const fixtureIds = [...fixtures.map((fixture) => fixture.id), ...(ungroupedArchivedId === null ? [] : [ungroupedArchivedId])];
  const fixtureWorkspaces = new Set(fixtures.map((fixture) => fixture.workspaceKey));
  assert.ok(fixtureWorkspaces.size >= 2, `archived fixtures must span at least two workspaces, got ${JSON.stringify([...fixtureWorkspaces])}`);

  // ── 3. ONE click ON ────────────────────────────────────────────────────
  await check('ONE click shows every archived session of every workspace (and the ungrouped bucket)', async () => {
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
      assert.equal(row.archived, true, `archived session ${id} must still be rendered as archived`);
      assert.equal(row.visible, true, `archived session ${id} must be visible while the switch is ON`);
    }
  });

  // ── 4. ONE click OFF ───────────────────────────────────────────────────
  await check('ONE click hides them again and reports the switch unchecked', async () => {
    const before = await archiveToggle(page);
    assert.equal(before.checked, true, 'precondition: the switch must be ON before the OFF click');
    const after = await clickArchiveToggle(page);
    await assertSwitchState(page, after, false);
    await waitForArchivedFilter(page, 'default');
    await waitForArchivedRows(page, fixtureIds, false);
    assert.deepEqual(await visibleArchivedKeys(page), [], 'no archived session may be visible after the OFF click');
  });

  // ── 5. manual built-in view option cannot resurrect them ───────────────
  await check('manually choosing 全部对话（显示已归档） cannot resurrect archived sessions while the switch is OFF', async () => {
    await pickViewOption(page, VIEW_OPTION_SHOW);
    await waitForArchivedFilter(page, 'default');
    await waitForArchivedRows(page, fixtureIds, false);
    const state = await archiveToggle(page);
    await assertSwitchState(page, state, false);
    assert.deepEqual(await visibleArchivedKeys(page), [], 'the plugin must re-hide archived sessions although the user picked the built-in "show" filter');
    assert.equal(await readArchivedFilter(page), 'default', 'the built-in filter must be driven back to "default" while the switch is OFF');
  });

  // ── 6. reload persistence in both directions ───────────────────────────
  await check('the switch state persists across reloads (ON stays visible, OFF stays hidden)', async () => {
    await setArchiveVisible(page, true);
    await reloadApp(page);
    await waitForArchivedFilter(page, 'show');
    await waitForArchivedRows(page, fixtureIds, true);
    let state = await archiveToggle(page);
    await assertSwitchState(page, state, true);

    await setArchiveVisible(page, false);
    await reloadApp(page);
    await waitForArchivedFilter(page, 'default');
    await waitForArchivedRows(page, fixtureIds, false);
    state = await archiveToggle(page);
    await assertSwitchState(page, state, false);
    assert.deepEqual(await visibleArchivedKeys(page), [], 'archived sessions must stay hidden after a reload with the switch OFF');
  });

  // ── restore the ungrouped fixture so the delete checks have two targets ─
  if (ungroupedArchivedId !== null) {
    await setArchiveVisible(page, true);
    await waitForArchivedRows(page, [ungroupedArchivedId], true);
    const items = await unarchiveViaBuiltin(page, `session:${ungroupedArchivedId}`);
    console.log(`note: unarchived the ungrouped fixture again through the built-in menu (${JSON.stringify(items.slice(0, 3))}…)`);
    await setArchiveVisible(page, false);
    await waitForArchivedFilter(page, 'default');
  }

  // ── 7. deleting a session that this process has OPENED (attached) ──────
  let attachedDeletedId = null;
  await check('deleting a session that this process has opened succeeds without a restart', async () => {
    const candidates = (await actionableRows(page)).filter((row) => !row.archived && row.disk.dirs.length > 0);
    const target = candidates.find((row) => row.workspaceKey !== null) ?? candidates[0];
    assert.ok(target !== undefined, 'no ordinary session available to open and delete');

    await page.locator(`[data-row-key="${target.key}"]`).first().click({ force: true });
    await delay(4000);
    await dismissModals(page);
    const current = await page.evaluate(() => localStorage.getItem('dsh.sessions.current') ?? '');
    assert.ok(current.includes(target.id), `the opened session must become the current one (current=${current})`);
    assert.ok(
      await page.evaluate(() => document.querySelector('textarea, [contenteditable="true"]') !== null),
      'the conversation view did not open',
    );

    await openSessionMenu(page, target.key);
    const items = await menuItems(page);
    assert.ok(items?.includes(DELETE), `delete item missing from ${JSON.stringify(items)}`);
    await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: DELETE }).first().click({ force: true });
    await delay(700);
    assert.ok((await readDialog(page)) !== null, 'confirmation dialog did not open');
    await confirmDelete(page);

    assert.equal(await readDialog(page), null, 'deleting an attached idle session must not be refused with a restart dialog');
    const remaining = await sessionRows(page);
    assert.equal(remaining.some((row) => row.key === target.key), false, 'the deleted row must disappear from the sidebar without a reload');
    const bodyText = await page.evaluate(() => document.body.innerText ?? '');
    assert.ok(bodyText.includes('会话已删除'), 'success toast must be shown');

    const disk = await sessionOnDisk(target.id);
    assert.deepEqual(disk.dirs, [], 'session log directory must be removed from disk');
    assert.equal(disk.projCache, null, 'projection cache must be removed from disk');
    assert.ok(
      await page.evaluate(() => document.querySelector('textarea, [contenteditable="true"]') !== null),
      'the app must recover the conversation view after deleting the open session',
    );
    attachedDeletedId = target.id;
  });

  // ── 8. cold delete (control): dialog, row, log dir, projection cache ───
  const coldCandidates = (await actionableRows(page)).filter(
    (row) => !row.archived && row.disk.dirs.length > 0 && row.id !== attachedDeletedId,
  );
  const deleteTarget = coldCandidates[0];
  assert.ok(deleteTarget !== undefined, 'no cold ordinary session available for deletion');

  await check('session row menu gains the destructive delete action with confirmation', async () => {
    await openSessionMenu(page, deleteTarget.key);
    const items = await menuItems(page);
    assert.ok(items?.includes(DELETE), `delete item missing from ${JSON.stringify(items)}`);
    await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: DELETE }).first().click({ force: true });
    await delay(700);
    const dialog = await page.evaluate(() => {
      const element = document.querySelector('[role="dialog"], [class*="_modal"]');
      return element === null
        ? null
        : { text: element.innerText ?? '', buttons: [...element.querySelectorAll('button')].map((button) => (button.textContent ?? '').trim()) };
    });
    assert.ok(dialog !== null, 'confirmation dialog did not open');
    assert.ok(dialog.text.includes('删除会话'), 'dialog must name the action');
    assert.ok(dialog.buttons.includes('删除') && dialog.buttons.includes('取消'), 'dialog must offer confirm/cancel');
    await page.screenshot({ path: join(HOME, '..', 'e2e-delete-dialog.png') }).catch(() => {});
    await confirmDelete(page);

    const remaining = await sessionRows(page);
    assert.equal(remaining.some((row) => row.key === deleteTarget.key), false, 'deleted row must disappear from the sidebar');
    const bodyText = await page.evaluate(() => document.body.innerText ?? '');
    assert.ok(bodyText.includes('会话已删除'), 'success toast must be shown');

    const disk = await sessionOnDisk(deleteTarget.id);
    assert.deepEqual(disk.dirs, [], 'session log directory must be removed from disk');
    assert.equal(disk.projCache, null, 'projection cache must be removed from disk');
    const workspaceJson = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'));
    const members = Object.values(workspaceJson.tables.workspaces).some((workspace) => (workspace.sessionIds ?? []).includes(deleteTarget.id));
    assert.equal(members, false, 'workspace bookkeeping must no longer reference the deleted session');
    assert.equal((workspaceJson.global.archivedSessionIds ?? []).includes(deleteTarget.id), false);
    assert.equal((workspaceJson.global.pinnedSessionIds ?? []).includes(deleteTarget.id), false);
  });

  // ── 9. host route ──────────────────────────────────────────────────────
  await check('host route answers health and rejects malformed/unknown ids', async () => {
    const health = await page.evaluate(async () => {
      const response = await fetch('/api/session-cleaner/health');
      return { status: response.status, body: await response.json() };
    });
    assert.deepEqual(health, { status: 200, body: { ok: true, plugin: 'session-cleaner' } });
    const invalid = await page.evaluate(async () => {
      const response = await fetch('/api/session-cleaner/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: '../escape' }),
      });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'session/invalid');
    const unknown = await page.evaluate(async () => {
      const response = await fetch('/api/session-cleaner/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-00000000-0000-4000-8000-000000000000' }),
      });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'session/not-found');
  });

  await check('the delete route rejects unauthenticated callers', async () => {
    const response = await fetch(`${instance.origin}/api/session-cleaner/health`);
    assert.notEqual(response.status, 200, 'a bare HTTP request without the browser cookie must not be authorized');
    assert.ok([401, 403].includes(response.status), `unexpected unauthenticated status ${response.status}`);
  });

  await check('the browser page logged no unexpected errors', async () => {
    // The deliberate 400/404 requests above make Chromium log a
    // "Failed to load resource" console entry; telemetry WebSocket noise is
    // desktop-only and unrelated to this plugin.
    const relevant = errors.filter(
      (line) => !/favicon/i.test(line) && !/Failed to load resource/i.test(line) && !/\/ingest/u.test(line),
    );
    assert.deepEqual(relevant, []);
  });
} finally {
  await browser.close().catch(() => {});
  await instance.stop().catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} E2E checks passed`);
if (failed.length > 0) process.exitCode = 1;

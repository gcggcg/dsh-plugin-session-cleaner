/**
 * End-to-end suite for the session-cleaner plugin.
 *
 * Boots an isolated DSH Web instance (private DSH home, seeded session logs),
 * drives the real sidebar with Playwright, and verifies both features:
 *   1. per-workspace archived-session toggle (workspace folder menu);
 *   2. permanent session deletion (session row menu + host route).
 *
 * The archived-visibility checks reproduce the reporting user's persisted state
 * (`archivedFilter: "show"`, every per-workspace toggle off) with two log-backed
 * archived fixtures seeded into the isolated home, and lock these regressions:
 *   - "all per-workspace toggles off" hides archived sessions even when the
 *     built-in view filter shows them (the reported "cannot hide" bug);
 *   - enabling one workspace shows only that workspace's archived sessions;
 *     disabling it hides them again, without and with a reload.
 *
 * The deletion checks lock these regressions:
 *   - a session that this process has OPENED (attached, idle) is deletable
 *     without restarting DSH (the reported "cannot delete" bug);
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
  closeMenu,
  dismissModals,
  expandWorkspaceGroups,
  launchBrowser,
  menuItems,
  openApp,
  openSessionMenu,
  openWorkspaceMenu,
  pickViewOption,
  sessionRows,
} from './browser.mjs';
import { archivedFixtures, hasSeed, resetHome, startInstance } from './instance.mjs';

const SHOW_TOGGLE = '显示归档会话';
const HIDE_TOGGLE = '隐藏归档会话';
const DELETE = '删除会话';

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

/** Whether an archived row exists and is visibly rendered. */
function archivedVisible(rows, id) {
  const row = rows.find((candidate) => candidate.key === `session:${id}`);
  return row !== undefined && row.visible;
}

/** Enable/disable one workspace folder's archived-session toggle. */
async function setWorkspaceToggle(page, workspaceKey, enabled) {
  await openWorkspaceMenu(page, workspaceKey);
  const items = await menuItems(page);
  const label = enabled ? SHOW_TOGGLE : HIDE_TOGGLE;
  assert.ok(items?.includes(label), `workspace menu must offer ${label}: ${JSON.stringify(items)}`);
  await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: label }).first().click({ force: true });
  await delay(1800);
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

/** Reload the GUI and re-expand the workspace groups. */
async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-row-key^="workspace:"]', { timeout: 60000 });
  await delay(2000);
  await dismissModals(page);
  await expandWorkspaceGroups(page);
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

  await check('plugin is loaded and decorates the workspace folder menu with the archived-visibility toggle', async () => {
    assert.ok(
      await page.evaluate(() => document.querySelector('style[data-plugin="dsh-plugin-session-cleaner"]') !== null),
      'plugin stylesheet is missing: the client bundle did not load',
    );
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
    assert.ok(items.includes(SHOW_TOGGLE) || items.includes(HIDE_TOGGLE), `toggle missing from ${JSON.stringify(items)}`);
    assert.ok(
      items.indexOf(SHOW_TOGGLE) > items.indexOf('重命名') || items.indexOf(HIDE_TOGGLE) > items.indexOf('重命名'),
      'toggle is placed after rename',
    );
  });

  await check('all per-workspace toggles off override the stale built-in "show" filter (reported "cannot hide" bug)', async () => {
    assert.ok(fixtures.length >= 2, `the isolated home must seed at least two log-backed archived fixtures, found ${fixtures.length}`);
    const view = JSON.parse(await page.evaluate(() => localStorage.getItem('dsh.workspace.view.v5') ?? '{}'));
    assert.equal(
      view.archivedFilter,
      'default',
      'with every per-workspace toggle off the plugin must drive the built-in archived filter back to "default" (the user had it on "show")',
    );
    const rows = await sessionRows(page);
    assert.deepEqual(
      rows.filter((row) => row.archived && row.visible).map((row) => row.key),
      [],
      'no archived session may be visible while every per-workspace toggle is off',
    );
  });

  await check('manually picking the built-in "show archived" filter cannot resurrect archived sessions while toggles are off', async () => {
    await pickViewOption(page, '全部对话（显示已归档）');
    await delay(2000);
    const rows = await sessionRows(page);
    assert.deepEqual(
      rows.filter((row) => row.archived && row.visible).map((row) => row.key),
      [],
      'the plugin must re-hide archived sessions although the user picked the built-in "show" filter',
    );
    const view = JSON.parse(await page.evaluate(() => localStorage.getItem('dsh.workspace.view.v5') ?? '{}'));
    assert.equal(view.archivedFilter, 'default', 'the plugin must keep the built-in filter on "default" while every toggle is off');
  });

  const toggleFixture = fixtures.find((fixture) => fixture.workspaceKey !== 'workspace:') ?? fixtures[0];
  const otherFixtures = fixtures.filter((fixture) => fixture.id !== toggleFixture.id);

  await check('enabling one workspace shows only its archived sessions', async () => {
    await setWorkspaceToggle(page, toggleFixture.workspaceKey, true);
    const rows = await sessionRows(page);
    assert.equal(archivedVisible(rows, toggleFixture.id), true, 'the enabled workspace\'s archived session must become visible');
    for (const other of otherFixtures) {
      assert.equal(archivedVisible(rows, other.id), false, `archived session ${other.id} of another workspace must stay hidden`);
    }
    await openWorkspaceMenu(page, toggleFixture.workspaceKey);
    const items = await menuItems(page);
    assert.ok(items?.includes(HIDE_TOGGLE), `the toggle label must flip while enabled: ${JSON.stringify(items)}`);
    await closeMenu(page);
  });

  await check('disabling the last workspace toggle hides archived sessions again', async () => {
    await setWorkspaceToggle(page, toggleFixture.workspaceKey, false);
    const rows = await sessionRows(page);
    assert.deepEqual(
      rows.filter((row) => row.archived && row.visible).map((row) => row.key),
      [],
      'turning the last toggle off must hide every archived session, not restore the built-in "show" filter',
    );
  });

  await check('the archived-visibility state survives a reload', async () => {
    await reloadApp(page);
    let rows = await sessionRows(page);
    assert.deepEqual(
      rows.filter((row) => row.archived && row.visible).map((row) => row.key),
      [],
      'archived sessions must stay hidden after a reload with every toggle off',
    );

    await setWorkspaceToggle(page, toggleFixture.workspaceKey, true);
    await reloadApp(page);
    rows = await sessionRows(page);
    assert.equal(archivedVisible(rows, toggleFixture.id), true, 'a persisted ON toggle must show its archived session after a reload');
    for (const other of otherFixtures) {
      assert.equal(archivedVisible(rows, other.id), false, `only the enabled workspace's archived sessions may show after a reload (${other.id})`);
    }
    await setWorkspaceToggle(page, toggleFixture.workspaceKey, false);
  });

  // ── deleting a session that this process has OPENED (attached, idle) ───
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

  // ── cold delete (control): dialog, row, log dir, projection cache ──────
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

/**
 * End-to-end suite for the session-cleaner plugin.
 *
 * Boots an isolated DSH Web instance (private DSH home, seeded session logs),
 * drives the real sidebar with Playwright, and verifies both features:
 *   1. per-workspace archived-session toggle (workspace folder menu);
 *   2. permanent session deletion (session row menu + host route).
 *
 * Prerequisites: `node scripts/setup-e2e.mjs` (playwright-core + seed snapshot),
 * plus the packaged DSH desktop distribution on this machine.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { HOME, PORT, hasPackagedDsh } from './config.mjs';
import { closeMenu, launchBrowser, menuItems, openApp, openSessionMenu, openWorkspaceMenu, pickViewOption, sessionRows } from './browser.mjs';
import { hasSeed, resetHome, startInstance } from './instance.mjs';

const SHOW_ARCHIVED = '全部对话（显示已归档）';
const HIDE_ARCHIVED = '隐藏已归档';
const UNARCHIVE = '取消归档';
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

/**
 * Ensure at least one archived session row exists and return it.
 *
 * The seed snapshot may come from a DSH home whose archive set references
 * sessions without local logs, so the suite can create the fixture itself by
 * archiving a cold session through the built-in row menu.
 * @param page - Playwright page.
 * @returns the archived row record.
 */
async function ensureArchivedRow(page) {
  await pickViewOption(page, SHOW_ARCHIVED);
  let rows = await sessionRows(page);
  let archived = rows.filter((row) => row.archived && row.workspaceKey !== null);
  if (archived.length > 0) return archived[0];

  await pickViewOption(page, HIDE_ARCHIVED);
  rows = await sessionRows(page);
  const candidate = rows.find((row) => row.buttons > 0 && !row.archived);
  assert.ok(candidate !== undefined, 'no cold session available to create the archived fixture');
  await openSessionMenu(page, candidate.key);
  const items = await menuItems(page);
  assert.ok(items?.some((text) => text.includes('归档会话')), `built-in archive action missing: ${JSON.stringify(items)}`);
  await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: '归档会话' }).first().click({ force: true });
  await page.waitForTimeout(900);
  const stopAndArchive = page.locator('button', { hasText: '停止并归档' }).first();
  if ((await stopAndArchive.count()) > 0 && (await stopAndArchive.isVisible())) await stopAndArchive.click({ force: true });
  await page.waitForTimeout(1500);
  await pickViewOption(page, SHOW_ARCHIVED);
  rows = await sessionRows(page);
  archived = rows.filter((row) => row.archived && row.workspaceKey !== null);
  assert.ok(archived.length > 0, 'could not create an archived session fixture');
  return archived[0];
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
const instance = await startInstance({ port: PORT });
const browser = await launchBrowser();
let page;
let errors = [];

try {
  const opened = await openApp(browser, instance.url);
  page = opened.page;
  errors = opened.errors;

  // ── 0. plugin is loaded ────────────────────────────────────────────────
  const workspaceKeys = await page.evaluate(() =>
    [...document.querySelectorAll('[data-row-key^="workspace:"]')]
      .filter((row) => row.querySelectorAll('button').length >= 2)
      .map((row) => row.getAttribute('data-row-key')),
  );
  assert.ok(workspaceKeys.length > 0, 'seed must provide at least one real workspace');

  await check('workspace folder menu gains the archived-visibility toggle', async () => {
    await openWorkspaceMenu(page, workspaceKeys[0]);
    const items = await menuItems(page);
    await closeMenu(page);
    assert.ok(items !== null, 'workspace menu did not open');
    assert.ok(items.includes(SHOW_TOGGLE) || items.includes(HIDE_TOGGLE), `toggle missing from ${JSON.stringify(items)}`);
    assert.ok(items.indexOf(SHOW_TOGGLE) > items.indexOf('重命名') || items.indexOf(HIDE_TOGGLE) > items.indexOf('重命名'), 'toggle is placed after rename');
  });

  // ── discover (or create) an archived session and its workspace ─────────
  const archivedRow = await ensureArchivedRow(page);
  const archivedKey = archivedRow.key;
  const archivedWorkspace = archivedRow.workspaceKey;
  await pickViewOption(page, HIDE_ARCHIVED);
  let rows;

  await check('enabling a workspace toggle shows only that workspace\'s archived sessions', async () => {
    await openWorkspaceMenu(page, archivedWorkspace);
    const items = await menuItems(page);
    assert.ok(items?.includes(SHOW_TOGGLE), `toggle item missing: ${JSON.stringify(items)}`);
    await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: SHOW_TOGGLE }).first().click({ force: true });
    await page.waitForTimeout(1500);

    rows = await sessionRows(page);
    const target = rows.find((row) => row.key === archivedKey);
    assert.ok(target !== undefined, 'archived session did not render after enabling the toggle');
    assert.notEqual(target.display, 'none', 'enabled workspace archived row must be visible');
    assert.equal(target.visible, true);

    const hiddenOthers = rows.filter((row) => row.archived && row.workspaceKey !== archivedWorkspace && row.key !== archivedKey);
    for (const row of hiddenOthers) {
      assert.equal(row.display, 'none', `archived row ${row.key} in another workspace must stay hidden`);
    }

    await openWorkspaceMenu(page, archivedWorkspace);
    const onItems = await menuItems(page);
    assert.ok(onItems?.includes(HIDE_TOGGLE), `toggle label must flip while enabled: ${JSON.stringify(onItems)}`);
    await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: HIDE_TOGGLE }).first().click({ force: true });
    await page.waitForTimeout(1200);
    rows = await sessionRows(page);
    assert.equal(rows.some((row) => row.archived && row.display !== 'none'), false, 'disabling the last toggle must restore the archived filter');
  });

  await check('the workspace toggle survives a page reload', async () => {
    await openWorkspaceMenu(page, archivedWorkspace);
    await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: SHOW_TOGGLE }).first().click({ force: true });
    await page.waitForTimeout(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-row-key^="workspace:"]', { timeout: 60000 });
    await page.waitForTimeout(2500);
    const { dismissModals } = await import('./browser.mjs');
    await dismissModals(page);
    rows = await sessionRows(page);
    const target = rows.find((row) => row.key === archivedKey);
    assert.ok(target !== undefined, 'archived session must come back after reload while the toggle is persisted');
    assert.notEqual(target.display, 'none');
    await openWorkspaceMenu(page, archivedWorkspace);
    await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: HIDE_TOGGLE }).first().click({ force: true });
    await page.waitForTimeout(1200);
  });

  // ── prepare a cold, non-archived session for deletion ─────────────────
  await pickViewOption(page, SHOW_ARCHIVED);
  await openSessionMenu(page, archivedKey);
  let items = await menuItems(page);
  assert.ok(items?.includes(UNARCHIVE), `archived row must offer ${UNARCHIVE}: ${JSON.stringify(items)}`);
  await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: UNARCHIVE }).first().click({ force: true });
  await page.waitForTimeout(1500);
  await pickViewOption(page, HIDE_ARCHIVED);
  rows = await sessionRows(page);
  const deleteTarget = rows.find((row) => row.buttons > 0 && !row.archived);
  assert.ok(deleteTarget !== undefined, 'no cold ordinary session available for deletion');

  await check('session row menu gains the destructive delete action with confirmation', async () => {
    await openSessionMenu(page, deleteTarget.key);
    items = await menuItems(page);
    assert.ok(items?.includes(DELETE), `delete item missing from ${JSON.stringify(items)}`);
    await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: DELETE }).first().click({ force: true });
    await page.waitForTimeout(700);
    const dialog = await page.evaluate(() => {
      const element = document.querySelector('[role="dialog"], [class*="_modal"]');
      return element === null ? null : { text: element.innerText ?? '', buttons: [...element.querySelectorAll('button')].map((button) => (button.textContent ?? '').trim()) };
    });
    assert.ok(dialog !== null, 'confirmation dialog did not open');
    assert.ok(dialog.text.includes('删除会话'), 'dialog must name the action');
    assert.ok(dialog.buttons.includes('删除') && dialog.buttons.includes('取消'), 'dialog must offer confirm/cancel');
    await page.screenshot({ path: join(HOME, '..', 'e2e-delete-dialog.png') }).catch(() => {});
    await page.locator('[role="dialog"] button, [class*="_modal"] button').filter({ hasText: /^删除$/ }).first().click({ force: true });
    await page.waitForTimeout(3000);

    const remaining = await sessionRows(page);
    assert.equal(remaining.some((row) => row.key === deleteTarget.key), false, 'deleted row must disappear from the sidebar');
    const bodyText = await page.evaluate(() => document.body.innerText ?? '');
    assert.ok(bodyText.includes('会话已删除'), 'success toast must be shown');

    const sessionId = deleteTarget.key.slice('session:'.length);
    const projectRoot = join(HOME, 'sessions');
    let dirs = [];
    for (const project of await readdir(projectRoot)) {
      if (existsSync(join(projectRoot, project, sessionId))) dirs.push(join(projectRoot, project, sessionId));
    }
    assert.deepEqual(dirs, [], 'session log directory must be removed from disk');
    const workspaceJson = JSON.parse(await readFile(join(HOME, 'storages', 'workspace.json'), 'utf8'));
    const members = Object.values(workspaceJson.tables.workspaces).some((workspace) => (workspace.sessionIds ?? []).includes(sessionId));
    assert.equal(members, false, 'workspace bookkeeping must no longer reference the deleted session');
    assert.equal((workspaceJson.global.archivedSessionIds ?? []).includes(sessionId), false);
    assert.equal((workspaceJson.global.pinnedSessionIds ?? []).includes(sessionId), false);
  });

  await check('host route answers health and rejects malformed ids', async () => {
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
        body: JSON.stringify({ sessionId: 'session-does-not-exist' }),
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
    // The two deliberate 400/404 requests above make Chromium log a
    // "Failed to load resource" console entry; those are expected probes.
    const relevant = errors.filter((line) => !/favicon/i.test(line) && !/Failed to load resource/i.test(line));
    assert.deepEqual(relevant, []);
  });
} finally {
  await browser.close().catch(() => {});
  await instance.stop().catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} E2E checks passed`);
if (failed.length > 0) process.exitCode = 1;

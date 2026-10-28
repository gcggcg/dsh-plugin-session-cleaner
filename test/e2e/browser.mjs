/**
 * Browser helpers for the isolated E2E harness: launch Chromium, open the
 * authenticated GUI, dismiss first-run modals, and read the sidebar surfaces
 * through the same DOM contracts the plugin itself relies on.
 */
import { chromiumExecutable, playwright } from './config.mjs';

/**
 * Launch headless Chromium from the local Playwright browser cache.
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function launchBrowser() {
  const { chromium } = playwright();
  return chromium.launch({ executablePath: chromiumExecutable(), headless: true });
}

/**
 * Open the GUI and wait until the sidebar session list is mounted.
 * @param browser - Playwright browser.
 * @param url - authenticated instance URL.
 * @returns {Promise<{ page, errors: string[] }>}
 */
export async function openApp(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 500));
  });
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 800)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('[data-row-key^="workspace:"]', { timeout: 90000 });
  await page.waitForTimeout(2000);
  await dismissModals(page);
  return { page, errors };
}

/**
 * Dismiss the first-run/login modal stack (isolated homes have no credentials).
 * @param page - Playwright page.
 */
export async function dismissModals(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await page.locator('[class*="_mask_"]').count()) === 0) return;
    const close = page.locator('button[aria-label="关闭"], button[aria-label="Close"]').first();
    if ((await close.count()) > 0 && (await close.isVisible())) await close.click({ force: true });
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
}

/**
 * Read every session row's identity, archive state and plugin hiding state.
 * @param page - Playwright page.
 * @returns rows with workspace keys and display.
 */
export function sessionRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-row-key^="session:"]')].map((row) => ({
      key: row.getAttribute('data-row-key'),
      title: (row.querySelector('[class*="_title"]')?.textContent ?? '').trim(),
      archived: row.hasAttribute('aria-description'),
      display: row.style.display,
      visible: row.getClientRects().length > 0,
      buttons: row.querySelectorAll('button').length,
      workspaceKey: (() => {
        const section = row.closest('[style*="--dsh-workspace-indent"]');
        const workspace = section === null ? null : section.querySelector('[data-row-key^="workspace:"]');
        return workspace === null ? null : workspace.getAttribute('data-row-key');
      })(),
    })),
  );
}

/** @returns the currently open portaled menu item labels, or null. */
export function menuItems(page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-menu-material]');
    return card === null ? null : [...card.querySelectorAll('button[role="menuitem"]')].map((button) => (button.textContent ?? '').trim());
  });
}

/**
 * Hover a workspace folder row and open its `...` menu.
 * @param page - Playwright page.
 * @param workspaceKey - `workspace:<id>` row key.
 */
export async function openWorkspaceMenu(page, workspaceKey) {
  const row = page.locator(`[data-row-key="${workspaceKey}"]`);
  await row.hover();
  await page.waitForTimeout(250);
  await row.locator('button').first().click({ force: true });
  await page.waitForTimeout(650);
}

/**
 * Hover a session row and open its `...` menu.
 * @param page - Playwright page.
 * @param sessionKey - `session:<id>` row key.
 */
export async function openSessionMenu(page, sessionKey) {
  const row = page.locator(`[data-row-key="${sessionKey}"]`);
  await row.hover();
  await page.waitForTimeout(250);
  await row.locator('button').first().click({ force: true });
  await page.waitForTimeout(650);
}

/**
 * Open the built-in view-options menu and click one item by its localized text.
 * @param page - Playwright page.
 * @param text - item text (e.g. `全部对话（显示已归档）`).
 */
export async function pickViewOption(page, text) {
  const trigger = page.locator('button[aria-label="视图选项"], button[aria-label="View options"]').first();
  await trigger.click({ force: true });
  await page.waitForTimeout(450);
  await page.locator('[data-menu-material] button[role="menuitem"]', { hasText: text }).first().click({ force: true });
  await page.waitForTimeout(1200);
}

/** Close whatever portaled menu is open. */
export async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

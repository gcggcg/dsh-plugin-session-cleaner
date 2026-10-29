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

/** Sidebar view state the suite starts from: the user's `archivedFilter: "show"` state. */
export const INITIAL_VIEW_STATE = {
  groupBy: 'workspace',
  orderBy: 'updated',
  groupExpansion: {},
  sessionOrderByAccount: {},
  archivedFilter: 'show',
};

/**
 * Open the GUI and wait until the sidebar session list is mounted.
 *
 * The persisted sidebar view state is preset to the user's real state
 * (`archivedFilter: "show"`) before the app store initializes, so archived rows
 * render exactly as they do for the reporting user; then every workspace group
 * is expanded so those rows are in the DOM.
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
  // Preset the persisted sidebar view state before the app store initializes.
  // The one-shot marker keeps a later `page.reload()` from re-presetting it, so
  // the persistence checks observe what the app and the plugin actually stored.
  await page.addInitScript((state) => {
    try {
      if (sessionStorage.getItem('__dshE2EViewPreset') === '1') return;
      sessionStorage.setItem('__dshE2EViewPreset', '1');
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify(state));
    } catch {
      /* storage may be unavailable on an intermediate document */
    }
  }, INITIAL_VIEW_STATE);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('[data-row-key^="workspace:"]', { timeout: 90000 });
  await page.waitForTimeout(2000);
  await dismissModals(page);
  await expandWorkspaceGroups(page);
  return { page, errors };
}

/**
 * Expand every collapsed workspace group (and the ungrouped bucket) so all
 * session rows are rendered, then wait for the list to settle.
 * @param page - Playwright page.
 */
export async function expandWorkspaceGroups(page) {
  for (let round = 0; round < 4; round += 1) {
    const collapsed = await page.evaluate(() =>
      [...document.querySelectorAll('[data-row-key^="workspace:"]')]
        .filter((row) => row.getAttribute('aria-expanded') !== 'true')
        .map((row) => row.getAttribute('data-row-key')),
    );
    if (collapsed.length === 0) break;
    for (const key of collapsed) {
      await page.locator(`[data-row-key="${key}"]`).first().click({ position: { x: 60, y: 10 }, force: true }).catch(() => {});
      await page.waitForTimeout(600);
    }
  }
  await page.waitForTimeout(800);
}

/**
 * Dismiss the first-run/login modal stack (isolated homes have no credentials).
 * @param page - Playwright page.
 */
export async function dismissModals(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await page.locator('[class*="_mask_"]').count()) === 0) return;
    const close = page.locator('button[aria-label="关闭"], button[aria-label="Close"]').first();
    if ((await close.count()) > 0 && (await close.isVisible())) {
      await close.click({ force: true });
    } else {
      const caption = page
        .locator('button')
        .filter({ hasText: /^(关闭|稍后配置|跳过|Close|Set up later|Skip)$/u })
        .first();
      if ((await caption.count()) > 0 && (await caption.isVisible())) await caption.click({ force: true });
      else await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(500);
  }
}

/**
 * Read every session row's identity, archive state and plugin hiding state.
 *
 * Visibility is judged by layout (`getComputedStyle` + client rects), not only
 * by the inline `display` property: the plugin may hide rows through a CSS
 * attribute rule instead of an inline style, and a hidden row must not count as
 * visible either way.
 * @param page - Playwright page.
 * @returns rows with workspace keys and display.
 */
export function sessionRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-row-key^="session:"]')].map((row) => {
      const rects = row.getClientRects().length;
      const computedDisplay = getComputedStyle(row).display;
      return {
        key: row.getAttribute('data-row-key'),
        title: (row.querySelector('[class*="_title"]')?.textContent ?? '').trim(),
        archived: row.hasAttribute('aria-description'),
        display: row.style.display,
        computedDisplay,
        hiddenAttr:
          row.hasAttribute('data-session-cleaner-archived-hidden') || row.hasAttribute('data-session-cleaner-hidden'),
        rects,
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

/**
 * Open one session in the main view by clicking its sidebar row.
 * @param page - Playwright page.
 * @param sessionKey - `session:<id>` row key.
 */
export async function openSessionRow(page, sessionKey) {
  await page.locator(`[data-row-key="${sessionKey}"]`).first().click({ force: true });
  await page.waitForTimeout(3500);
  await dismissModals(page);
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

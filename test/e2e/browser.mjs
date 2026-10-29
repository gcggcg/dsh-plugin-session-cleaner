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

/** Plugin-owned container of the injected global archive switch. */
export const ARCHIVE_TOGGLE_ATTR = 'data-session-cleaner-archive-toggle';
/** localStorage key holding the global archive visibility ('1' shown, '0'/absent hidden). */
export const ARCHIVE_VISIBLE_KEY = 'dsh.session-cleaner.archived-visible';
/** Pre-switch per-workspace state; the plugin must remove it and must never honour it. */
export const LEGACY_ARCHIVE_KEY = 'dsh.session-cleaner.workspace-archived';
/** Switch labels: the aria-label names the action the next click performs. */
export const ARCHIVE_SHOW_LABEL = '显示归档会话';
export const ARCHIVE_HIDE_LABEL = '隐藏归档会话';

/**
 * Open the GUI and wait until the sidebar session list is mounted.
 *
 * The persisted sidebar view state is preset to the user's real state
 * (`archivedFilter: "show"`) before the app store initializes, so a stale
 * built-in filter can prove that the plugin drives it back to `default` while
 * the global archive switch is OFF. A stale legacy per-workspace key is seeded
 * too, to prove the plugin ignores (and later removes) it.
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
      localStorage.removeItem('dsh.session-cleaner.archived-visible');
      localStorage.setItem('dsh.session-cleaner.workspace-archived', '{"enabled":{"legacy-workspace":true},"restoreFilter":"show"}');
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

/** @param ms - milliseconds to wait. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an async predicate until it returns a truthy value.
 * @param predicate - async predicate.
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options] - poll limits.
 * @returns the truthy result.
 */
export async function waitUntil(predicate, { timeoutMs = 8000, intervalMs = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/**
 * Read the injected global archive switch: container, button state, pill,
 * placement inside the sidebar panel list, and the persisted storage keys.
 * @param page - Playwright page.
 * @returns switch state object; `present: false` when the row is not injected.
 */
export function archiveToggle(page) {
  return page.evaluate((attr) => {
    const containers = [...document.querySelectorAll(`[${attr}]`)];
    const container = containers[0] ?? null;
    const nav = container === null ? null : container.closest('nav[class*="panelList"]');
    const button = container === null ? null : container.querySelector('button[role="switch"]');
    const pill = container === null ? null : container.querySelector('.spc-archive-switch');
    const precedingRowLabel = (() => {
      if (container === null || nav === null) return null;
      for (let node = container.previousElementSibling; node !== null; node = node.previousElementSibling) {
        const direct = node.getAttribute('aria-label');
        if (direct !== null && direct.length > 0) return direct;
        const nested = node.querySelector?.('button[aria-label]');
        if (nested !== null && nested !== undefined) return nested.getAttribute('aria-label');
      }
      return null;
    })();
    const rowLabels =
      nav === null
        ? []
        : [...nav.querySelectorAll('button[aria-label]')]
            .filter((row) => row.getAttribute('aria-haspopup') !== 'menu' && row.getAttribute('aria-expanded') === null)
            .map((row) => row.getAttribute('aria-label'));
    return {
      count: containers.length,
      present: container !== null,
      inPanelList: container !== null && nav !== null && nav.contains(container),
      navWidth: nav === null ? null : Math.round(nav.getBoundingClientRect().width),
      ariaChecked: button === null ? null : button.getAttribute('aria-checked'),
      checked: button !== null && button.getAttribute('aria-checked') === 'true',
      label: button === null ? null : button.getAttribute('aria-label'),
      title: container === null ? null : (container.querySelector('.spc-archive-title')?.textContent ?? '').trim() || null,
      precedingRowLabel,
      panelRowLabels: rowLabels,
      pillVisible: pill !== null && pill.getClientRects().length > 0,
      guard: document.documentElement.getAttribute('data-session-cleaner-archived-guard'),
      stored: localStorage.getItem('dsh.session-cleaner.archived-visible'),
      legacy: localStorage.getItem('dsh.session-cleaner.workspace-archived'),
    };
  }, ARCHIVE_TOGGLE_ATTR);
}

/**
 * Wait until the injected archive switch is mounted.
 * @param page - Playwright page.
 * @param timeout - timeout in ms.
 * @returns the switch state.
 */
export async function waitForArchiveSwitch(page, timeout = 30000) {
  await page.locator(`[${ARCHIVE_TOGGLE_ATTR}] button[role="switch"]`).first().waitFor({ state: 'attached', timeout });
  return waitUntil(async () => {
    const state = await archiveToggle(page);
    return state.present ? state : null;
  }, { timeoutMs: timeout, label: 'injected archive switch' });
}

/**
 * Click the global archive switch exactly once and wait for the state to flip.
 * @param page - Playwright page.
 * @param {{ timeoutMs?: number }} [options] - settle budget.
 * @returns the switch state after the click.
 */
export async function clickArchiveToggle(page, { timeoutMs = 15000 } = {}) {
  const before = await archiveToggle(page);
  if (!before.present) throw new Error('the global archive switch is not injected');
  await page.locator(`[${ARCHIVE_TOGGLE_ATTR}] button[role="switch"]`).first().click({ force: true });
  const expected = before.checked !== true;
  await waitUntil(async () => {
    const state = await archiveToggle(page);
    return state.checked === expected ? state : null;
  }, { timeoutMs, label: `archive switch aria-checked=${String(expected)}` });
  await page.waitForTimeout(600);
  return archiveToggle(page);
}

/**
 * Drive the global archive switch to the requested state with a SINGLE click
 * (idempotent: no click when the switch already reports the wanted state).
 * @param page - Playwright page.
 * @param visible - wanted visibility.
 * @returns the switch state after settling.
 */
export async function setArchiveVisible(page, visible) {
  const before = await archiveToggle(page);
  if (!before.present) throw new Error('the global archive switch is not injected');
  if (before.checked === visible) return before;
  return clickArchiveToggle(page);
}

/** @returns the app's persisted archived filter (`default` | `show` | `only` | null). */
export function readArchivedFilter(page) {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('dsh.workspace.view.v5');
      if (raw === null || raw === '') return null;
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && typeof parsed.archivedFilter === 'string' ? parsed.archivedFilter : null;
    } catch {
      return null;
    }
  });
}

/**
 * Wait for the app's built-in archived filter to reach a value.
 * @param page - Playwright page.
 * @param value - expected filter.
 * @param timeoutMs - timeout in ms.
 * @returns the filter value.
 */
export async function waitForArchivedFilter(page, value, timeoutMs = 10000) {
  await waitUntil(async () => ((await readArchivedFilter(page)) === value ? value : null), {
    timeoutMs,
    label: `archivedFilter=${value}`,
  });
  return value;
}

/** @returns the archived session rows that are visibly rendered right now. */
export async function visibleArchivedKeys(page) {
  const rows = await sessionRows(page);
  return rows.filter((row) => row.archived && row.visible).map((row) => row.key);
}

/**
 * Wait until every listed archived session row is visible (or until none is,
 * when `visible` is false).
 * @param page - Playwright page.
 * @param ids - archived session ids to check.
 * @param visible - expected visibility.
 * @param timeoutMs - timeout in ms.
 * @returns the final rows snapshot.
 */
export async function waitForArchivedRows(page, ids, visible, timeoutMs = 12000) {
  return waitUntil(async () => {
    const rows = await sessionRows(page);
    const states = ids.map((id) => rows.find((row) => row.key === `session:${id}`));
    const allMatch = states.every((row) => (visible ? row !== undefined && row.visible : row === undefined || !row.visible));
    return allMatch ? rows : null;
  }, { timeoutMs, label: `archived rows visible=${String(visible)}` });
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

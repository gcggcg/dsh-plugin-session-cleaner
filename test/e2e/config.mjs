/**
 * Shared configuration for the isolated E2E harness.
 *
 * The harness runs a SECOND DeepSeek Harness Web instance from the packaged
 * desktop distribution, against a private DSH home under `.tmp-test/`, so unit
 * work and the user's real `~/.dsh` (and the running GUI) are never touched.
 *
 * Every path can be overridden by environment variables; the defaults target
 * the machine this plugin was developed on.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Published package name; the bundle patch and the client module id must match it. */
export const PLUGIN_PACKAGE = '@estelle-ge/dsh-plugin-session-cleaner';
export const TEMP_ROOT = process.env.DSH_E2E_TEMP ?? join(PLUGIN_ROOT, '.tmp-test');
export const HOME = process.env.DSH_E2E_HOME ?? join(TEMP_ROOT, 'home');
export const SEED = process.env.DSH_E2E_SEED ?? join(TEMP_ROOT, 'seed');
export const PROFILE = process.env.DSH_E2E_PROFILE ?? 'e2e';
export const PORT = Number(process.env.DSH_E2E_PORT ?? '54180');
export const PROFILE_DIR = join(HOME, 'profiles', PROFILE);

/** Packaged desktop distribution (Electron binary + dsh CLI entry inside app.asar). */
export const ELECTRON = process.env.DSH_E2E_ELECTRON ?? 'E:\\Deepseek-Harness\\DeepSeek Harness.exe';
export const CLI =
  process.env.DSH_E2E_CLI ??
  'E:\\Deepseek-Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';

/** Chromium shipped by the local Playwright browser cache. */
export function chromiumExecutable() {
  if (process.env.DSH_E2E_CHROMIUM !== undefined) return process.env.DSH_E2E_CHROMIUM;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? 'C:\\Users\\hp\\AppData\\Local\\ms-playwright';
  for (const directory of ['chromium-1217', 'chromium-1200']) {
    for (const sub of ['chrome-win64\\chrome.exe', 'chrome-win\\chrome.exe', 'chrome-linux\\chrome', 'chrome-mac\\Chromium.app\\Contents\\MacOS\\Chromium']) {
      const candidate = join(cache, directory, sub);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`no Chromium build found under ${cache}; set DSH_E2E_CHROMIUM`);
}

/**
 * Load `playwright-core` from the harness scratch install.
 * @returns playwright-core module.
 */
export function playwright() {
  const require = createRequire(join(TEMP_ROOT, 'package.json'));
  try {
    return require('playwright-core');
  } catch (error) {
    throw new Error(`playwright-core is not installed under ${TEMP_ROOT}; run "node scripts/setup-e2e.mjs" first (${String(error)})`);
  }
}

/**
 * Whether the packaged launcher and CLI exist on this machine.
 * Plain Node cannot stat paths inside `app.asar`, so the CLI is detected
 * through its containing archive instead.
 * @returns true when the E2E environment can be booted.
 */
export function hasPackagedDsh() {
  const asar = CLI.split(/[\\/]app\.asar[\\/]/u)[0] + (process.platform === 'win32' ? '\\app.asar' : '/app.asar');
  return existsSync(ELECTRON) && existsSync(asar);
}

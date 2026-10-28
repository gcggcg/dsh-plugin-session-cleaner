#!/usr/bin/env node
/**
 * One-time (and repeatable) setup for the isolated E2E environment:
 *
 * 1. installs `playwright-core` into `.tmp-test/` (no browser download: the
 *    harness points at the machine's existing Playwright Chromium cache);
 * 2. creates a seed snapshot of the local DSH sessions if none exists, so the
 *    isolated instance has real workspaces, archived sessions and a cold
 *    session to delete (copied from `%USERPROFILE%\.dsh`; never modified);
 * 3. creates/repairs the isolated `e2e` profile with this plugin linked into it.
 *
 * The seed snapshot and isolated home stay under `.tmp-test/` (gitignored).
 * Pass `--refresh-seed` to recopy the session seed from the real DSH home.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SEED, TEMP_ROOT } from '../test/e2e/config.mjs';
import { ensureProfile } from '../test/e2e/instance.mjs';

const refreshSeed = process.argv.includes('--refresh-seed');

async function ensurePackages() {
  const packagePath = join(TEMP_ROOT, 'package.json');
  await mkdir(TEMP_ROOT, { recursive: true });
  if (!existsSync(packagePath)) {
    await writeFile(
      packagePath,
      JSON.stringify(
        {
          name: 'dsh-plugin-session-cleaner-e2e',
          private: true,
          type: 'module',
          description: 'Scratch install for the isolated DSH Web test instance harness.',
          dependencies: { 'playwright-core': '^1.59.1' },
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (existsSync(join(TEMP_ROOT, 'node_modules', 'playwright-core', 'package.json'))) {
    console.log('playwright-core: already installed');
    return;
  }
  console.log('installing playwright-core into', TEMP_ROOT);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: TEMP_ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm install failed with status ${String(result.status)}`);
}

/**
 * Copy the local DSH session store into the seed snapshot.
 * @returns {Promise<boolean>} whether a seed exists afterwards.
 */
async function ensureSeed() {
  if (existsSync(join(SEED, 'sessions')) && existsSync(join(SEED, 'storages', 'workspace.json')) && !refreshSeed) {
    console.log('session seed: already present at', SEED);
    return true;
  }
  const sourceHome = process.env.DSH_E2E_SEED_SOURCE ?? join(homedir(), '.dsh');
  const sessions = join(sourceHome, 'sessions');
  const workspaceJson = join(sourceHome, 'storages', 'workspace.json');
  if (!existsSync(sessions) || !existsSync(workspaceJson)) {
    console.error(`\nNo DSH session store found at ${sourceHome}.`);
    console.error('The E2E suite needs a few real sessions to exercise the sidebar.');
    console.error('Run DeepSeek Harness Desktop at least once (or set DSH_E2E_SEED_SOURCE to a DSH home), then rerun this script.\n');
    return false;
  }
  await rm(SEED, { recursive: true, force: true });
  await mkdir(join(SEED, 'storages'), { recursive: true });
  await cp(sessions, join(SEED, 'sessions'), { recursive: true });
  await cp(workspaceJson, join(SEED, 'storages', 'workspace.json'));
  const projcache = join(sourceHome, 'storages', 'session_projcache');
  if (existsSync(projcache)) await cp(projcache, join(SEED, 'storages', 'session_projcache'), { recursive: true });
  console.log('session seed: copied to', SEED);
  return true;
}

await ensurePackages();
const seeded = await ensureSeed();
const profile = await ensureProfile();
console.log('\nE2E environment ready.');
console.log('  profile:', profile);
console.log('  seed:', seeded ? SEED : '(missing — E2E will skip the sidebar assertions)');
console.log('  start with: node test/e2e/run.mjs');

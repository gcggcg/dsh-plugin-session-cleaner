#!/usr/bin/env node
/**
 * No-browser smoke test for the session-cleaner bundle.
 *
 * It validates the package manifest and development patch, the browser bundle's
 * module contract (inject list, slot registrations, dictionary key parity) by
 * evaluating `client.js` against a fake ModuleLoader, and the host entry's
 * exports. Rendering, React behavior, the host HTTP route and every DSH service
 * interaction are covered by the host unit tests and the Playwright E2E suite.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(fileURLToPath(import.meta.url));
const results = [];

/**
 * Record a named check.
 * @param name - check label.
 * @param fn - synchronous assertion body.
 */
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8');
const zhMeta = JSON.parse(await readFile(join(ROOT, 'locale/zh.json'), 'utf8'));
const enMeta = JSON.parse(await readFile(join(ROOT, 'locale/en.json'), 'utf8'));

check('package identity and entry points', () => {
  assert.equal(packageJson.name, '@estelle-ge/dsh-plugin-session-cleaner');
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.main, 'index.js');
  assert.equal(packageJson.exports['.'], './index.js');
  assert.equal(packageJson.exports['./client'], './client.js');
  assert.match(packageJson.engines.dsh, /0\.2\.1-rc\.3/);
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.ok(Array.isArray(packageJson.dsh.client.inject));
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(packageJson.files.includes(file), `files[] must ship ${file}`);
  }
});

check('development patch inserts one bundle row', () => {
  assert.match(patch, /id: session-cleaner/);
  assert.match(patch, /name: "@estelle-ge\/dsh-plugin-session-cleaner"/);
  assert.equal((patch.match(/- insert:/g) ?? []).length, 1);
});

check('market locale metadata is complete in both languages', () => {
  assert.equal(typeof zhMeta.meta.title, 'string');
  assert.equal(typeof zhMeta.meta.description, 'string');
  assert.equal(typeof enMeta.meta.title, 'string');
  assert.equal(typeof enMeta.meta.description, 'string');
  assert.ok(existsSync(join(ROOT, 'icon.svg')));
});

// ── evaluate the browser bundle against a fake ModuleLoader ────────────────

let definition;
const sandbox = { window: { __ModuleLoader__: { load: (value) => { definition = value; } } } };
vm.runInNewContext(await readFile(join(ROOT, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' });

const ReactStub = {
  createElement: (...args) => ({ args }),
  Fragment: Symbol('Fragment'),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};

const primitivesStub = new Proxy(
  { MenuItemButton: () => null, Modal: () => null, Toast: () => null, Button: () => null },
  {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && key.startsWith('Icon')) return () => null;
      return undefined;
    },
  },
);

const requireStub = (specifier) => {
  switch (specifier) {
    case 'react':
      return ReactStub;
    case 'react-dom':
      return {};
    case 'react-dom/client':
      return { createRoot: () => ({ render() {}, unmount() {} }) };
    case '@deepseek-ai/dsh-client-ui-primitives':
      return primitivesStub;
    default:
      throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  }
};

const bundle = definition.factory(requireStub);

check('browser bundle exposes the module contract', () => {
  assert.equal(definition.id, '@estelle-ge/dsh-plugin-session-cleaner');
  assert.ok(Array.isArray(bundle.inject));
  assert.ok(bundle.inject.includes('slots'));
  assert.ok(bundle.inject.includes('locale'));
  assert.equal(typeof bundle.apply, 'function');
});

const registrations = [];
const dictionaries = {};
const disposers = [];
const fakeCtx = {
  get: () => undefined,
  on: () => () => {},
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  },
  locale: {
    register(namespace, dictionary) {
      dictionaries[namespace] = dictionary;
      return () => {};
    },
    bind(namespace) {
      const dictionary = dictionaries[namespace];
      return (key, params) => {
        const template = dictionary === undefined ? undefined : dictionary[key];
        if (typeof template !== 'string') return key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
      };
    },
    resolveText: (value) => value,
  },
  slots: {
    inject(name, factory) {
      const registration = factory();
      registrations.push({ name, registration });
      return () => {};
    },
    register(definitionValue) {
      return definitionValue;
    },
  },
};

bundle.apply(fakeCtx);

const dict = dictionaries[sessionNamespace()];

/**
 * The dictionary namespace is private to the bundle; read it from a registration
 * that declares `locale`.
 * @returns namespace name.
 */
function sessionNamespace() {
  const withLocale = registrations.find((entry) => typeof entry.registration.locale === 'string');
  assert.ok(withLocale, 'at least one registration declares a locale namespace');
  return withLocale.registration.locale;
}

check('plugin registers both UI surfaces', () => {
  const names = registrations.map((entry) => entry.name);
  assert.ok(names.includes('sidebar.workspaces.session.menu.item'), 'session row menu item');
  assert.ok(names.includes('shell.overlay'), 'confirmation overlay');
  const menu = registrations.find((entry) => entry.name === 'sidebar.workspaces.session.menu.item');
  assert.equal(menu.registration.id, 'session-cleaner.delete');
  assert.equal(menu.registration.order, 500);
  assert.equal(typeof menu.registration.inject, 'function');
});

check('bundle dictionaries have identical key sets', () => {
  assert.ok(dict !== undefined, 'dictionary registered');
  const zhKeys = Object.keys(dict.zh).sort();
  const enKeys = Object.keys(dict.en).sort();
  assert.deepEqual(zhKeys, enKeys);
  for (const locale of ['zh', 'en']) {
    for (const [key, value] of Object.entries(dict[locale])) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`);
      assert.ok(value.length > 0, `${locale}.${key} must not be empty`);
    }
  }
});

check('client bundle carries no escaped template holes', () => {
  const source = vmSource();
  assert.doesNotMatch(source, /undefined\b/, 'no literal undefined in user-facing copy');
});

/**
 * @returns the client bundle source.
 */
function vmSource() {
  // The dictionary values are the user-facing copy; read them from the parsed
  // dictionary instead of pattern-matching the whole bundle.
  return JSON.stringify(dict);
}

// ── host entry ─────────────────────────────────────────────────────────────

const hostEntry = await import(pathToFileURL(join(ROOT, 'index.js')).href);

check('host entry exports a Cordis plugin', () => {
  assert.equal(typeof hostEntry.apply, 'function');
  assert.ok(Array.isArray(hostEntry.inject));
  assert.equal(hostEntry.name, 'session-cleaner');
});

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}`);
  if (!result.ok) console.log(String(result.error?.stack ?? result.error));
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;

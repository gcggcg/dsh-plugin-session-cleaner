/**
 * Shared fixtures for the host unit tests: a fake plugin context, a fake Web
 * server, a fake connection fence, a temporary sessions root, real HTTP
 * servers, and small deterministic helpers.
 *
 * The tests exercise the production modules only — nothing here is imported by
 * the plugin bundle.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../../src/host/plugin.js';
import { sessionDir } from '../../src/host/encoding.js';

/** Collection of `ctx.logger` calls for assertions. */
export function createLogCollector() {
  const entries = [];
  return {
    entries,
    info(message) {
      entries.push({ level: 'info', message: String(message) });
    },
    warn(message) {
      entries.push({ level: 'warn', message: String(message) });
    },
    debug(message) {
      entries.push({ level: 'debug', message: String(message) });
    },
    error(message) {
      entries.push({ level: 'error', message: String(message) });
    },
  };
}

/**
 * Minimal Cordis-like host context: lazy `get`, broadcast `emit`, waterfall
 * with the same `(payload, fallback)` shape the workspace registry uses.
 */
export function createFakeContext({ services = {}, waterfall, logger = createLogCollector() } = {}) {
  const serviceMap = new Map(Object.entries(services));
  const emitted = [];
  const ctx = {
    services: serviceMap,
    emitted,
    logger,
    get(name) {
      return serviceMap.get(name);
    },
    emit(event, ...args) {
      emitted.push({ event, args });
    },
    async waterfall(name, payload, fallback) {
      if (typeof waterfall === 'function') return waterfall(name, payload, fallback);
      return typeof fallback === 'function' ? fallback() : fallback;
    },
  };
  defineServiceAccessors(ctx);
  return ctx;
}

/**
 * Mirror Cordis inject semantics for the fake context: an injected service is
 * readable as a plain property as well as through `get()`.
 * @param ctx - fake context.
 */
export function defineServiceAccessors(ctx) {
  for (const name of ctx.services.keys()) {
    if (name in ctx) continue;
    Object.defineProperty(ctx, name, {
      configurable: true,
      enumerable: false,
      get: () => ctx.services.get(name),
    });
  }
}

/** Minimal `ctx.webServer` with duplicate-route detection like the real one. */
export function createFakeWebServer() {
  const routes = new Map();
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      routes.set(route.path, route);
      return () => {
        routes.delete(route.path);
      };
    },
  };
}

/** The `connection` service's trust fence, scripted per test. */
export function createConnectionService(rejection) {
  const calls = [];
  return {
    calls,
    requestRejection(request) {
      calls.push(request);
      return typeof rejection === 'function' ? rejection(request) : rejection;
    },
  };
}

/**
 * Run the real plugin `apply` against a fake context and return its installed
 * route (plus captured inject/effect bookkeeping).
 */
export function installPluginHarness(options = {}) {
  const ctx = createFakeContext(options);
  const webServer = options.webServer ?? createFakeWebServer();
  ctx.services.set('webServer', webServer);
  defineServiceAccessors(ctx);

  const injected = [];
  const effects = [];
  ctx.inject = (deps, callback) => {
    injected.push([...deps]);
    return callback(ctx);
  };
  ctx.effect = (callback, label) => {
    const disposer = callback();
    effects.push({ label, disposer });
    return disposer;
  };

  apply(ctx);
  return {
    ctx,
    webServer,
    injected,
    effects,
    route: webServer.routes.get('/api/session-cleaner'),
  };
}

/** Create an isolated sessions root and remove it after the test. */
export async function createTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-cleaner-'));
  if (typeof t?.after === 'function') t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * Create the directory layout the JSONL backend would create for one session.
 * @returns {Promise<string>} the session directory.
 */
export async function createStoredSession(root, { id, cwd, formatVersion = 4, contents = 'fixture\n' } = {}) {
  const directory = sessionDir(root, cwd, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `session.v${String(formatVersion)}.jsonl.zstd`), contents);
  return directory;
}

/** A fake JSONL persistence service backed by a Map of stored snapshots. */
export function createFakePersistence({ root, snapshots = new Map(), stat } = {}) {
  return {
    root,
    async stat(id) {
      if (typeof stat === 'function') return stat(id);
      return snapshots.get(id);
    },
  };
}

/** Snapshot shape `stat()` returns for one stored session. */
export function snapshotFor(id, cwd) {
  return {
    header: cwd === undefined ? { id } : { id, cwd },
    revision: 'test-revision',
  };
}

/** Fake `sessions`/`agents` services with scripted liveness. */
export function createLiveStore(liveIds = []) {
  const ids = new Set(liveIds);
  return {
    get(id) {
      return ids.has(id) ? { id } : undefined;
    },
  };
}

/**
 * Start a real loopback HTTP server that serves one route handler, so tests
 * assert actual status lines, headers, and bodies instead of a mock response.
 * @returns {Promise<{ origin: string, server: import('node:http').Server }>}
 */
export async function startRouteServer(t, handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      } catch {
        /* the response is already committed */
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  if (typeof t?.after === 'function') {
    t.after(async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    });
  }
  const address = server.address();
  return { origin: `http://127.0.0.1:${String(address.port)}`, server };
}

/** Fetch one request and parse a JSON body when present. */
export async function requestJson(origin, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    ...body === undefined ? {} : { body },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** POST a JSON body to the route under test. */
export function postJson(origin, path, value, headers = {}) {
  return requestJson(origin, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
}

/** Whether a path exists (used to prove presence/removal of fixtures). */
export { existsSync };

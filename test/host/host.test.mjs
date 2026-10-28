/**
 * Host-side tests: the deletion algorithm (fake services, temp sessions root)
 * and the real HTTP route handler over a loopback server.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';

import { deleteSession, isValidSessionId } from '../../src/host/delete-session.js';
import {
  createFakeContext,
  createFakePersistence,
  createFakeWebServer,
  createLiveStore,
  createStoredSession,
  createTempRoot,
  installPluginHarness,
  postJson,
  requestJson,
  snapshotFor,
  startRouteServer,
} from './helpers.mjs';

const CWD = 'E:\\project\\deepseek-tool';
const SESSION_ID = 'session-4d8fdd0f-58c6-41f7-ab8c-d55e93d0499a';

/**
 * One workspace-registry stand-in that records every bookkeeping call.
 * @param entities - workspace entity list.
 * @returns fake registry.
 */
function createFakeRegistry(entities = []) {
  return {
    entities,
    archived: [],
    pinned: [],
    list() {
      return this.entities;
    },
    async unarchiveSession(id) {
      this.archived.push(id);
    },
    async unpinSession(id) {
      this.pinned.push(id);
    },
  };
}

/**
 * One workspace entity stand-in; `sessionIds`/`detachSession` mimic the runtime
 * shape the host uses (the public TS interface hides detachSession).
 * @param options - id, accounted sessions, optional failing detach.
 * @returns fake entity.
 */
function createFakeWorkspace({ id = 'ws-1', sessionIds = [], detachError } = {}) {
  return {
    id,
    sessionIds,
    detached: [],
    async detachSession(sessionId) {
      this.detached.push(sessionId);
      if (detachError !== undefined) throw detachError;
    },
  };
}

/**
 * Build the fake context deleteSession expects.
 * @returns {object} fake ctx + fixtures.
 */
function createDeleteFixture({ snapshots, root, registry, sessions, agents, waterfall, rm } = {}) {
  const persistence = createFakePersistence({ root, snapshots });
  const ctx = createFakeContext({
    services: {
      sessionPersistence: persistence,
      ...registry === undefined ? {} : { workspaceRegistry: registry },
      ...sessions === undefined ? {} : { sessions },
      ...agents === undefined ? {} : { agents },
    },
    ...waterfall === undefined ? {} : { waterfall },
  });
  return { ctx, persistence, registry, internals: rm === undefined ? {} : { rm } };
}

// ───────────────────────────── id validation ──────────────────────────────

test('isValidSessionId accepts stored session ids only', () => {
  assert.equal(isValidSessionId(SESSION_ID), true);
  assert.equal(isValidSessionId('session-x'), true);
  assert.equal(isValidSessionId('session-a.b_c-d'), true);
  for (const value of ['', 'session-', 'x-session-abc', 'session-a/b', 'session-a b', '../session-x', 'session-中', null, 42, undefined]) {
    assert.equal(isValidSessionId(value), false, `${String(value)} must be rejected`);
  }
});

// ───────────────────────────── deletion ───────────────────────────────────

test('deleteSession removes the artifact and every bookkeeping reference', async (t) => {
  const root = await createTempRoot(t);
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const registry = createFakeRegistry([createFakeWorkspace({ sessionIds: ['other', SESSION_ID] })]);
  const { ctx, internals } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry,
  });

  const result = await deleteSession(ctx, SESSION_ID, internals);

  assert.deepEqual(result, { sessionId: SESSION_ID });
  assert.equal(existsSync(directory), false, 'session directory must be gone');
  assert.deepEqual(registry.entities[0].detached, [SESSION_ID]);
  assert.deepEqual(registry.archived, [SESSION_ID]);
  assert.deepEqual(registry.pinned, [SESSION_ID]);
  assert.deepEqual(ctx.emitted.map((entry) => entry.event), ['api-session/removed']);
  assert.deepEqual(ctx.emitted[0].args, [SESSION_ID]);
  assert.ok(ctx.logger.entries.some((entry) => entry.level === 'info' && entry.message.includes(SESSION_ID)));
});

test('deleteSession handles a session whose header carries no cwd', async (t) => {
  const root = await createTempRoot(t);
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: undefined });
  const { ctx, internals } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, undefined)]]),
    registry: createFakeRegistry(),
  });
  await deleteSession(ctx, SESSION_ID, internals);
  assert.equal(existsSync(directory), false);
});

test('deleteSession rejects a malformed id before touching any service', async (t) => {
  const root = await createTempRoot(t);
  const { ctx } = createDeleteFixture({ root, snapshots: new Map() });
  await assert.rejects(deleteSession(ctx, '../session-x'), (error) => error.code === 'session/invalid');
});

test('deleteSession reports session/not-found for an unknown id', async (t) => {
  const root = await createTempRoot(t);
  const { ctx } = createDeleteFixture({ root, snapshots: new Map(), registry: createFakeRegistry() });
  await assert.rejects(deleteSession(ctx, SESSION_ID), (error) => error.code === 'session/not-found');
});

test('deleteSession refuses a live session and keeps the artifact', async (t) => {
  const root = await createTempRoot(t);
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const { ctx } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry: createFakeRegistry(),
    sessions: createLiveStore([SESSION_ID]),
  });
  await assert.rejects(deleteSession(ctx, SESSION_ID), (error) => error.code === 'session/live');
  assert.equal(existsSync(directory), true);
});

test('deleteSession refuses a session with running activity and returns its details', async (t) => {
  const root = await createTempRoot(t);
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const activity = [{ kind: 'turn' }, { kind: 'job', name: 'build' }];
  const { ctx } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry: createFakeRegistry(),
    waterfall: async () => activity,
  });
  await assert.rejects(deleteSession(ctx, SESSION_ID), (error) => {
    assert.equal(error.code, 'session/active');
    assert.deepEqual(error.details.activity, activity);
    return true;
  });
  assert.equal(existsSync(directory), true);
});

test('deleteSession fails closed without a persistence service', async (t) => {
  const root = await createTempRoot(t);
  const ctx = createFakeContext({ services: {}, });
  await assert.rejects(deleteSession(ctx, SESSION_ID), (error) => error.code === 'service/unavailable');
});

test('deleteSession fails when the persistence backend exposes no root', async (t) => {
  const root = await createTempRoot(t);
  const ctx = createFakeContext({
    services: {
      sessionPersistence: {
        async stat() {
          return snapshotFor(SESSION_ID, CWD);
        },
      },
      workspaceRegistry: createFakeRegistry(),
    },
  });
  await assert.rejects(deleteSession(ctx, SESSION_ID), (error) => error.code === 'delete/failed');
});

test('deleteSession reports workspace/refused before removing the artifact', async (t) => {
  const root = await createTempRoot(t);
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const workspace = createFakeWorkspace({ sessionIds: [SESSION_ID], detachError: new Error('registry busy') });
  const registry = createFakeRegistry([workspace]);
  const { ctx } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry,
  });
  await assert.rejects(deleteSession(ctx, SESSION_ID), (error) => error.code === 'workspace/refused');
  assert.equal(existsSync(directory), true);
});

test('deleteSession reports delete/failed when the filesystem removal fails', async (t) => {
  const root = await createTempRoot(t);
  const workspace = createFakeWorkspace({ sessionIds: [SESSION_ID] });
  const registry = createFakeRegistry([workspace]);
  const { ctx, internals } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry,
    rm: async () => {
      throw new Error('EPERM: operation not permitted');
    },
  });
  await assert.rejects(deleteSession(ctx, SESSION_ID, internals), (error) => error.code === 'delete/failed');
  assert.deepEqual(workspace.detached, [SESSION_ID]);
  assert.deepEqual(ctx.emitted, []);
});

test('deleteSession survives a throwing removal broadcast listener', async (t) => {
  const root = await createTempRoot(t);
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const ctx = createFakeContext({
    services: { sessionPersistence: createFakePersistence({ root, snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]) }) },
  });
  ctx.emit = () => {
    throw new Error('listener exploded');
  };
  const result = await deleteSession(ctx, SESSION_ID);
  assert.deepEqual(result, { sessionId: SESSION_ID });
  assert.equal(existsSync(directory), false);
  assert.ok(ctx.logger.entries.some((entry) => entry.message.includes('api-session/removed')));
});

// ───────────────────────────── HTTP route ─────────────────────────────────

/**
 * Build the plugin route over a real loopback server with fake services.
 * @param t - node:test context.
 * @returns {Promise<{origin: string, ctx: object, emit: Array, root: string}>}
 */
async function startPluginRoute(t, options = {}) {
  const root = await createTempRoot(t);
  const workspace = options.workspace ?? createFakeWorkspace({ sessionIds: [SESSION_ID] });
  const registry = options.registry ?? createFakeRegistry([workspace]);
  const harness = installPluginHarness({
    webServer: createFakeWebServer(),
    services: {
      ...options.services === undefined ? {} : options.services,
      sessionPersistence: options.persistence ?? createFakePersistence({ root, snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]) }),
      workspaceRegistry: registry,
    },
    ...options.waterfall === undefined ? {} : { waterfall: options.waterfall },
  });
  assert.ok(harness.route !== undefined, 'route registered');
  const { origin } = await startRouteServer(t, harness.route.handler);
  return { origin, ctx: harness.ctx, root, workspace };
}

test('GET /health answers 200 JSON', async (t) => {
  const { origin } = await startPluginRoute(t, { services: { connection: { requestRejection: () => undefined } } });
  const response = await requestJson(origin, '/api/session-cleaner/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, plugin: 'session-cleaner' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the connection fence rejects unauthenticated requests', async (t) => {
  const { origin } = await startPluginRoute(t, {
    services: { connection: { requestRejection: () => 401 } },
  });
  const response = await requestJson(origin, '/api/session-cleaner/health');
  assert.equal(response.status, 401);
  assert.equal(response.text, 'unauthorized');
});

test('a forbidden fence answer is passed through as 403', async (t) => {
  const { origin } = await startPluginRoute(t, {
    services: { connection: { requestRejection: () => 403 } },
  });
  const response = await requestJson(origin, '/api/session-cleaner/health');
  assert.equal(response.status, 403);
  assert.equal(response.text, 'forbidden');
});

test('a missing connection service fails closed with 503', async (t) => {
  const { origin } = await startPluginRoute(t);
  const response = await requestJson(origin, '/api/session-cleaner/health');
  assert.equal(response.status, 503);
  assert.equal(response.json.error.code, 'service/unavailable');
});

test('the health endpoint rejects the wrong method with 405 + Allow', async (t) => {
  const { origin } = await startPluginRoute(t, { services: { connection: { requestRejection: () => undefined } } });
  const response = await requestJson(origin, '/api/session-cleaner/health', { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.json.error.code, 'route/method-not-allowed');
  assert.equal(response.headers.get('allow'), 'GET');
});

test('unknown endpoints answer 404 JSON', async (t) => {
  const { origin } = await startPluginRoute(t, { services: { connection: { requestRejection: () => undefined } } });
  const response = await requestJson(origin, '/api/session-cleaner/nope');
  assert.equal(response.status, 404);
  assert.equal(response.json.error.code, 'route/not-found');
});

test('delete requires POST and a JSON media type', async (t) => {
  const { origin } = await startPluginRoute(t, { services: { connection: { requestRejection: () => undefined } } });
  const wrongMethod = await requestJson(origin, '/api/session-cleaner/delete');
  assert.equal(wrongMethod.status, 405);
  const noType = await requestJson(origin, '/api/session-cleaner/delete', { method: 'POST', body: '{}' });
  assert.equal(noType.status, 415);
  assert.equal(noType.json.error.code, 'request/unsupported-media-type');
  const badJson = await postJson(origin, '/api/session-cleaner/delete', '{oops');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, 'request/invalid-json');
  const badShape = await postJson(origin, '/api/session-cleaner/delete', { sessionId: '../escape' });
  assert.equal(badShape.status, 400);
  assert.equal(badShape.json.error.code, 'session/invalid');
});

test('delete answers 413 for an oversized body', async (t) => {
  const { origin } = await startPluginRoute(t, { services: { connection: { requestRejection: () => undefined } } });
  const body = JSON.stringify({ sessionId: SESSION_ID, padding: 'x'.repeat(70 * 1024) });
  let response;
  try {
    response = await postJson(origin, '/api/session-cleaner/delete', body);
  } catch {
    // The server closes the socket after the 413; depending on buffering the
    // client may observe that close instead of reading the response.
    return;
  }
  assert.equal(response.status, 413);
  assert.equal(response.json.error.code, 'request/too-large');
});

test('POST delete removes the session and reports success', async (t) => {
  const { origin, root, workspace } = await startPluginRoute(t, { services: { connection: { requestRejection: () => undefined } } });
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const response = await postJson(origin, '/api/session-cleaner/delete', { sessionId: SESSION_ID });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, sessionId: SESSION_ID });
  assert.equal(existsSync(directory), false);
  assert.deepEqual(workspace.detached, [SESSION_ID]);
});

test('POST delete maps business failures onto stable statuses', async (t) => {
  const { origin } = await startPluginRoute(t, {
    persistence: createFakePersistence({ root: undefined, snapshots: new Map() }),
    services: { connection: { requestRejection: () => undefined } },
  });
  const response = await postJson(origin, '/api/session-cleaner/delete', { sessionId: SESSION_ID });
  assert.equal(response.status, 404);
  assert.equal(response.json.error.code, 'session/not-found');
});

test('the route never throws when a service fails unexpectedly', async (t) => {
  const { origin } = await startPluginRoute(t, {
    persistence: {
      root: 'C:\\sessions',
      async stat() {
        throw new Error('disk on fire');
      },
    },
    services: { connection: { requestRejection: () => undefined } },
  });
  const response = await postJson(origin, '/api/session-cleaner/delete', { sessionId: SESSION_ID });
  assert.equal(response.status, 500);
  assert.equal(response.json.error.code, 'delete/failed');
});

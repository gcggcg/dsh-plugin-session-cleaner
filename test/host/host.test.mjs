/**
 * Host-side tests: the deletion algorithm (fake services, temp sessions root)
 * and the real HTTP route handler over a loopback server.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, rm as removePath } from 'node:fs/promises';
import { join } from 'node:path';

import { deleteSession, isPathContained, isValidSessionId, sameFileName } from '../../src/host/delete-session.js';
import {
  createFakeAgent,
  createFakeAgentStore,
  createFakeContext,
  createFakePersistence,
  createFakeWebServer,
  createLiveStore,
  createStoredSession,
  createTempHome,
  createTempRoot,
  installPluginHarness,
  postJson,
  requestJson,
  snapshotFor,
  startRouteServer,
  writeProjectionCache,
  writeSearchIndex,
} from './helpers.mjs';

const CWD = 'E:\\project\\deepseek-tool';
const SESSION_ID = 'session-4d8fdd0f-58c6-41f7-ab8c-d55e93d0499a';
const UUID = '4d8fdd0f-58c6-41f7-ab8c-d55e93d0499a';

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

test('isValidSessionId accepts the shipped stored session id forms only', () => {
  for (const value of [
    `session-${UUID}`,
    `sess_${UUID}`,
    UUID,
    `session-${UUID.toUpperCase()}`,
    'session-00000000-0000-0000-0000-000000000000',
  ]) {
    assert.equal(isValidSessionId(value), true, `${value} must be accepted`);
  }
  for (const value of [
    '',
    'session-',
    'sess_',
    'session-x',
    'session-a.b_c-d',
    'x-session-abc',
    'session-a/b',
    'session-a b',
    '../session-x',
    'session-中',
    `session-${UUID.slice(0, -1)}`,
    `${UUID}x`,
    `${UUID}-extra`,
    ` ${UUID}`,
    `session-${UUID}-session`,
    null,
    42,
    undefined,
  ]) {
    assert.equal(isValidSessionId(value), false, `${String(value)} must be rejected`);
  }
});

test('isPathContained keeps targets inside their root, across separators and case', async (t) => {
  const root = await createTempRoot(t);
  assert.equal(isPathContained(root, join(root, 'sessions', `session-${UUID}`)), true);
  assert.equal(isPathContained(root, root), true);
  assert.equal(isPathContained(root, join(root, '..', 'outside')), false);
  assert.equal(isPathContained(root, `${root}-evil`), false);
  assert.equal(isPathContained(root, join(root, '..', '..', 'escape', 'x')), false);
});

test('sameFileName folds case only on case-insensitive filesystems', () => {
  const upper = `session-${UUID.toUpperCase()}`;
  const lower = `session-${UUID}`;
  assert.equal(sameFileName(lower, lower), true, 'identical names always match');
  assert.equal(sameFileName(upper, upper), true, 'identical names always match');
  if (process.platform === 'win32') {
    assert.equal(sameFileName(upper, lower), true, 'Windows filesystems are case-insensitive');
    assert.equal(sameFileName(lower, upper), true);
  } else {
    assert.equal(sameFileName(upper, lower), false, 'POSIX keeps the exact spelling');
  }
  assert.equal(sameFileName(lower, `session-${UUID.slice(0, -1)}`), false, 'different ids never match');
  assert.equal(sameFileName(lower, 'session-other'), false);
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

test('deleteSession deletes an attached-but-idle session', async (t) => {
  const root = await createTempRoot(t);
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const idleAgent = createFakeAgent({ status: 'idle' });
  const registry = createFakeRegistry();
  const { ctx, internals } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry,
    sessions: createLiveStore([SESSION_ID]),
    agents: createFakeAgentStore(new Map([[SESSION_ID, idleAgent]])),
  });

  const result = await deleteSession(ctx, SESSION_ID, internals);

  assert.deepEqual(result, { sessionId: SESSION_ID });
  assert.equal(existsSync(directory), false, 'the attached session artifact must be gone');
  assert.equal(idleAgent.cancelCalls.length, 0, 'an idle agent must not be cancelled');
  assert.deepEqual(registry.archived, [SESSION_ID], 'bookkeeping is still cleared');
  assert.deepEqual(ctx.emitted.map((entry) => entry.event), ['api-session/removed']);
  assert.ok(
    ctx.logger.entries.some((entry) => entry.level === 'info' && entry.message.includes('attached')),
    'the attached-but-idle decision is logged',
  );
});

test('deleteSession cancels a running agent, waits for idle, then deletes', async (t) => {
  const root = await createTempRoot(t);
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const agent = createFakeAgent({
    status: 'running',
    onCancel: (self) => {
      self.status = 'idle';
    },
  });
  const registry = createFakeRegistry([createFakeWorkspace({ sessionIds: [SESSION_ID] })]);
  const { ctx, internals } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry,
    sessions: createLiveStore([SESSION_ID]),
    agents: createFakeAgentStore(new Map([[SESSION_ID, agent]])),
  });

  const result = await deleteSession(ctx, SESSION_ID, { ...internals, stopTimeoutMs: 2000 });

  assert.deepEqual(result, { sessionId: SESSION_ID });
  assert.equal(agent.cancelCalls.length, 1, 'the running agent is cancelled once');
  assert.deepEqual(agent.cancelCalls[0].cause, { kind: 'user' });
  assert.deepEqual(agent.cancelCalls[0].options, { keepInbox: false });
  assert.equal(existsSync(directory), false);
  assert.deepEqual(registry.archived, [SESSION_ID]);
});

test('deleteSession refuses a running agent that never stops and deletes nothing', async (t) => {
  const root = await createTempRoot(t);
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const agent = createFakeAgent({ status: 'running' }); // cancel leaves it running
  const workspace = createFakeWorkspace({ sessionIds: [SESSION_ID] });
  const registry = createFakeRegistry([workspace]);
  const removable = [];
  const { ctx } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry,
    agents: createFakeAgentStore(new Map([[SESSION_ID, agent]])),
    rm: async (target) => {
      removable.push(target);
    },
  });

  await assert.rejects(deleteSession(ctx, SESSION_ID, { stopTimeoutMs: 0 }), (error) => {
    assert.equal(error.code, 'session/active');
    assert.deepEqual(error.details.activity, [{ kind: 'agent' }]);
    assert.match(error.message, /nothing was deleted/);
    return true;
  });
  assert.equal(agent.cancelCalls.length, 1, 'cancellation was attempted');
  assert.equal(existsSync(directory), true, 'the artifact is untouched');
  assert.deepEqual(removable, [], 'nothing was removed');
  assert.deepEqual(workspace.detached, [], 'bookkeeping is untouched');
  assert.deepEqual(registry.archived, []);
  assert.deepEqual(ctx.emitted, []);
});

test('deleteSession accepts bare-uuid, sess_ and uppercase-hex id forms', async (t) => {
  for (const id of [UUID, `sess_${UUID}`, `session-${UUID.toUpperCase()}`]) {
    const root = await createTempRoot(t);
    const directory = await createStoredSession(root, { id, cwd: CWD });
    const { ctx, internals } = createDeleteFixture({
      root,
      snapshots: new Map([[id, snapshotFor(id, CWD)]]),
      registry: createFakeRegistry(),
    });
    const result = await deleteSession(ctx, id, internals);
    assert.deepEqual(result, { sessionId: id });
    assert.equal(existsSync(directory), false, `${id} directory removed`);
  }
});

test('deleteSession locates the artifact by id even when the stored cwd is stale', async (t) => {
  const root = await createTempRoot(t);
  // The directory lives under the project key of the ORIGINAL cwd, while the
  // stored header now reports a different cwd: only a directory scan finds it.
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: 'E:\\original\\project' });
  const staleCwd = 'E:\\moved\\project';
  const { ctx, internals } = createDeleteFixture({
    root,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, staleCwd)]]),
    registry: createFakeRegistry(),
  });

  await deleteSession(ctx, SESSION_ID, internals);

  assert.equal(existsSync(directory), false, 'the scanned directory is the deletion target');
});

test('deleteSession matches a case-differing on-disk directory name on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await createTempRoot(t);
  const storedId = `session-${UUID.toUpperCase()}`;
  const requestedId = `session-${UUID}`;
  const directory = await createStoredSession(root, { id: storedId, cwd: CWD });
  const { ctx, internals } = createDeleteFixture({
    root,
    snapshots: new Map([[requestedId, snapshotFor(requestedId, CWD)]]),
    registry: createFakeRegistry(),
  });

  await deleteSession(ctx, requestedId, internals);

  assert.equal(existsSync(directory), false, 'the real (upper-case) directory is removed, not refused as escaping the root');
});

test('deleteSession never removes a session-shaped directory outside the sessions root', async (t) => {
  const { home, sessionsRoot } = await createTempHome(t);
  const outside = join(home, 'elsewhere', SESSION_ID);
  await mkdir(outside, { recursive: true });
  const { ctx, internals } = createDeleteFixture({
    root: sessionsRoot,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry: createFakeRegistry(),
  });

  const result = await deleteSession(ctx, SESSION_ID, internals);

  assert.deepEqual(result, { sessionId: SESSION_ID });
  assert.equal(existsSync(outside), true, 'a look-alike outside the root is never touched');
});

test('deleteSession removes the projection cache and derived search indexes', async (t) => {
  const { sessionsRoot, storagesRoot } = await createTempHome(t);
  const directory = await createStoredSession(sessionsRoot, { id: SESSION_ID, cwd: CWD });
  const cacheFile = await writeProjectionCache(storagesRoot, SESSION_ID);
  const survivorCache = await writeProjectionCache(storagesRoot, `session-${UUID.replace(/.$/, '0')}`);
  const indexFile = await writeSearchIndex(storagesRoot);
  const { ctx, internals } = createDeleteFixture({
    root: sessionsRoot,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry: createFakeRegistry(),
  });

  await deleteSession(ctx, SESSION_ID, internals);

  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(cacheFile), false, 'projection cache record removed');
  assert.equal(existsSync(indexFile), false, 'search index removed');
  assert.equal(existsSync(`${indexFile}-wal`), false, 'wal sidecar removed');
  assert.equal(existsSync(`${indexFile}-shm`), false, 'shm sidecar removed');
  assert.equal(existsSync(survivorCache), true, "another session's cache record survives");
  assert.equal(existsSync(join(storagesRoot, 'workspace.json')), true, 'durable bookkeeping files survive');
});

test('deleteSession reports derived-artifact failures as warnings, not failures', async (t) => {
  const { sessionsRoot, storagesRoot } = await createTempHome(t);
  const directory = await createStoredSession(sessionsRoot, { id: SESSION_ID, cwd: CWD });
  const cacheFile = await writeProjectionCache(storagesRoot, SESSION_ID);
  const { ctx } = createDeleteFixture({
    root: sessionsRoot,
    snapshots: new Map([[SESSION_ID, snapshotFor(SESSION_ID, CWD)]]),
    registry: createFakeRegistry(),
  });

  const result = await deleteSession(ctx, SESSION_ID, {
    rm: async (target, options) => {
      if (target === cacheFile) throw new Error('EBUSY: resource busy or locked');
      return removePath(target, options);
    },
  });

  assert.deepEqual(result, { sessionId: SESSION_ID }, 'the delete still succeeds');
  assert.equal(existsSync(directory), false, 'the log directory is gone');
  assert.equal(existsSync(cacheFile), true, 'the locked cache record is left behind');
  assert.ok(
    ctx.logger.entries.some((entry) => entry.level === 'warn' && entry.message.includes('projection cache')),
    'the cache failure is reported as a warning',
  );
  assert.deepEqual(ctx.emitted.map((entry) => entry.event), ['api-session/removed']);
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

test('POST delete succeeds for a session that is attached but idle', async (t) => {
  const { origin, root } = await startPluginRoute(t, {
    services: { connection: { requestRejection: () => undefined }, sessions: createLiveStore([SESSION_ID]) },
  });
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const response = await postJson(origin, '/api/session-cleaner/delete', { sessionId: SESSION_ID });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, sessionId: SESSION_ID });
  assert.equal(existsSync(directory), false, 'attached no longer means undeletable');
});

test('POST delete answers a 409 stable code for a session whose agent will not stop', async (t) => {
  const { origin, root } = await startPluginRoute(t, {
    services: {
      connection: { requestRejection: () => undefined },
      agents: createFakeAgentStore(new Map([[SESSION_ID, createFakeAgent({ status: 'running' })]])),
    },
  });
  const directory = await createStoredSession(root, { id: SESSION_ID, cwd: CWD });
  const previous = process.env.DSH_SESSION_CLEANER_STOP_MS;
  process.env.DSH_SESSION_CLEANER_STOP_MS = '500';
  let response;
  try {
    response = await postJson(origin, '/api/session-cleaner/delete', { sessionId: SESSION_ID });
  } finally {
    if (previous === undefined) delete process.env.DSH_SESSION_CLEANER_STOP_MS;
    else process.env.DSH_SESSION_CLEANER_STOP_MS = previous;
  }
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'session/active');
  assert.deepEqual(response.json.error.details.activity, [{ kind: 'agent' }]);
  assert.equal(existsSync(directory), true);
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

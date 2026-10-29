/**
 * Permanent Session deletion: the only stateful operation the browser half
 * cannot perform itself.
 *
 * Contract (DESIGN.md § Feature 1): resolve services lazily so the plugin
 * loads even when an optional service is absent; a running Agent is stopped
 * first, while a Session that is merely attached (idle) to this host is
 * deleted like any cold one; remove every workspace/global bookkeeping
 * reference before the files; delete exactly the JSONL backend's session
 * directory plus the derived projection cache and search indexes; and finally
 * tell every connected browser to drop the row.
 *
 * @module dsh-plugin-session-cleaner/host/delete-session
 */

import { readdir, rm as removePath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { sessionDir } from './encoding.js';
import { SessionCleanerError, messageOf } from './errors.js';

/**
 * The shipped DSH session-id grammar. Three forms coexist on disk:
 * - `session-<uuid>` — user Sessions writing the current log generation,
 * - `sess_<uuid>`    — legacy user Sessions still found in real homes,
 * - `<uuid>`         — subagent/delegated child Sessions.
 *
 * Anything else is not a Session id and is never a deletion target.
 */
export const SESSION_ID_PATTERN =
  /^(?:(?:session-|sess_))?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Default budget for a cancelled Agent to leave `running` before deletion gives up. */
export const DEFAULT_STOP_TIMEOUT_MS = 8000;

/** Environment override for {@link DEFAULT_STOP_TIMEOUT_MS} (operators/tests). */
export const STOP_TIMEOUT_ENV = 'DSH_SESSION_CLEANER_STOP_MS';

/** Poll cadence while waiting for a cancelled Agent to settle. */
const STOP_POLL_INTERVAL_MS = 120;

/**
 * Entries that prove a directory is DSH's `<home>/storages` tree. The derived
 * projection cache and search indexes are only touched beside a directory
 * carrying one of these, so an unusual custom sessions root cannot make this
 * module delete unrelated `.db` files.
 */
const STORAGES_MARKERS = Object.freeze(['session_projcache', 'workspace.json', 'schedule.json']);

/** A derived SQLite search index file; these indexes are rebuilt from logs on demand. */
const SEARCH_INDEX_PATTERN = /\.(?:db|sqlite|sqlite3)$/i;

/** Whether comparison of two resolved paths is case-insensitive (Windows). */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32';

/**
 * Whether two single path segments name the same file on this platform.
 *
 * Windows filesystems are case-insensitive, so a Session id may legitimately be
 * spelled with a different hex case than the on-disk directory name; POSIX
 * keeps the exact spelling.
 *
 * @param {string} left - one path segment.
 * @param {string} right - the other path segment.
 * @returns {boolean} true when both name the same file on this platform.
 */
export function sameFileName(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return CASE_INSENSITIVE_PATHS ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Whether `value` is an acceptable Session id for deletion.
 * @param {unknown} value - candidate id.
 * @returns {boolean} true for a string matching {@link SESSION_ID_PATTERN}.
 */
export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/**
 * Whether `target` is `root` itself or lives underneath it.
 *
 * Both arguments are resolved first; on Windows the comparison is
 * case-insensitive, matching the filesystem. The path is compared
 * component-wise (a trailing separator is required for the prefix), so
 * `/home/sessions-evil` is not contained in `/home/sessions`.
 *
 * @param {string} root - the allowed root directory.
 * @param {string} target - the candidate path.
 * @returns {boolean} true when `target` is inside `root`.
 */
export function isPathContained(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false;
  const base = comparablePath(root);
  const candidate = comparablePath(target);
  if (candidate === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return candidate.startsWith(prefix);
}

/**
 * Permanently delete one stored Session.
 *
 * Order matters (DESIGN.md § Deletion algorithm): the artifact is located and
 * the live services inspected before anything is mutated; a running Agent is
 * cancelled and awaited; residual activity is refused; workspace/global
 * bookkeeping is detached before the files disappear; finally the row is
 * removed from every connected browser.
 *
 * @param {object} ctx - host plugin context; services are read lazily.
 * @param {string} sessionId - the Session id to delete.
 * @param {{ rm?: typeof removePath, stopTimeoutMs?: number, sleep?: (ms: number) => Promise<void> }} [internals]
 *   test seams; production callers omit this.
 * @returns {Promise<{ sessionId: string }>} the deleted Session id.
 * @throws {SessionCleanerError} with a stable code for every expected failure.
 */
export async function deleteSession(ctx, sessionId, internals = {}) {
  if (!isValidSessionId(sessionId)) {
    throw new SessionCleanerError('session/invalid', `session id ${JSON.stringify(safeIdForMessage(sessionId))} is not an accepted session id`, {
      details: { reason: 'malformed-session-id' },
    });
  }

  const persistence = optionalService(ctx, 'sessionPersistence');
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    throw new SessionCleanerError('service/unavailable', 'session persistence is unavailable, so no stored session can be deleted', {
      details: { service: 'sessionPersistence' },
    });
  }

  const snapshot = await statStoredSession(ctx, persistence, sessionId);
  const cwd = storedCwd(snapshot, sessionId);
  const root = sessionsRoot(persistence, sessionId);
  const directory = await locateSessionDirectory(root, cwd, sessionId);

  const live = readLiveServices(ctx, sessionId);
  const agentRunning = live.agent !== undefined && live.agent !== null && agentStatus(live.agent) === 'running';
  if (live.session !== undefined) {
    // An attached Session stays in this process' Session store after the user
    // navigates away; the JSONL backend's Windows write lock is a named kernel
    // semaphore (no open lock file) and libuv opens logs with FILE_SHARE_DELETE,
    // so its idle artifact can be removed here. The `api-session/removed`
    // broadcast below drops the stale row client-side.
    logInfo(
      ctx,
      agentRunning
        ? `session-cleaner: session "${sessionId}" is attached and its agent is running; stopping it before deletion`
        : `session-cleaner: session "${sessionId}" is attached but idle in this host; deleting it without a restart`,
    );
  }
  await stopRunningAgent(ctx, sessionId, live.agent, internals);
  await assertNoActivity(ctx, sessionId);

  await detachWorkspaceBookkeeping(ctx, sessionId);

  const remove = typeof internals.rm === 'function' ? internals.rm : removePath;
  try {
    await remove(directory, { recursive: true, force: true });
  } catch (error) {
    throw new SessionCleanerError('delete/failed', `cannot remove session "${sessionId}" from disk: ${messageOf(error)}`, {
      details: { sessionId },
      cause: error,
    });
  }

  // Derived data is disposable but must not outlive its log: a stale
  // projection-cache record can resurrect the deleted Session's title and
  // metadata after a restart, and a stale search index keeps serving it.
  await removeDerivedArtifacts(ctx, root, sessionId, remove);

  emitRemoved(ctx, sessionId);
  logInfo(ctx, `session-cleaner: deleted session "${sessionId}"`);
  return { sessionId };
}

/** Resolve one path for comparison, folding case on case-insensitive filesystems. */
function comparablePath(value) {
  const resolved = resolve(value);
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

/** Read one persistence service without treating a missing optional peer as fatal. */
function optionalService(ctx, name) {
  if (typeof ctx?.get !== 'function') return undefined;
  return ctx.get(name);
}

/** Read `sessionPersistence.stat(id)`, mapping the backend's not-found to the stable code. */
async function statStoredSession(ctx, persistence, sessionId) {
  let snapshot;
  try {
    snapshot = await persistence.stat(sessionId);
  } catch (error) {
    if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') {
      throw new SessionCleanerError('session/not-found', `no stored session "${sessionId}" exists`, { details: { sessionId }, cause: error });
    }
    throw new SessionCleanerError('delete/failed', `cannot read session "${sessionId}" from persistence: ${messageOf(error)}`, {
      details: { sessionId },
      cause: error,
    });
  }
  if (snapshot === undefined || snapshot === null) {
    throw new SessionCleanerError('session/not-found', `no stored session "${sessionId}" exists`, { details: { sessionId } });
  }
  if (typeof snapshot !== 'object' || typeof snapshot.header !== 'object' || snapshot.header === null) {
    throw new SessionCleanerError('delete/failed', `session persistence returned no header for session "${sessionId}"`, {
      details: { sessionId },
    });
  }
  return snapshot;
}

/** The stored header's cwd, which selects the fallback project directory. */
function storedCwd(snapshot, sessionId) {
  const { cwd } = snapshot.header;
  if (cwd === undefined) return undefined;
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new SessionCleanerError('delete/failed', `session "${sessionId}" carries an unusable project directory in its header`, {
      details: { sessionId },
    });
  }
  return cwd;
}

/** The JSONL backend's sessions root, without which the artifact cannot be located. */
function sessionsRoot(persistence, sessionId) {
  const root = persistence.root;
  if (typeof root !== 'string' || root.length === 0) {
    throw new SessionCleanerError('delete/failed', 'the session persistence backend exposes no sessions root, so its artifact cannot be located', {
      details: { sessionId },
    });
  }
  return resolve(root);
}

/**
 * Find the session directory.
 *
 * The directory listing is the authority: the backend looks a Session up by
 * scanning `<root>/<projectDir>/<encodeSegment(id)>` (its own `findLog` scans
 * every project directory rather than deriving one from a header), so the
 * delete scans one workspace level deep for a child directory named after the
 * id (case-folded on Windows, where the filesystem is case-insensitive). That
 * stays correct when the stored header's `cwd` is stale or was normalized
 * differently, and it returns the directory's real spelling. The deterministic
 * `projectKey`/`encodeSegment` computation remains as the fallback (for an
 * unmaterialized Session, whose artifact legitimately does not exist yet).
 *
 * @returns {Promise<string>} the contained absolute directory to remove.
 */
async function locateSessionDirectory(root, cwd, sessionId) {
  const scanned = await scanSessionsRoot(root, sessionId);
  if (scanned !== undefined) return assertContainedSessionDirectory(root, scanned, sessionId);

  // `stat()` proved the Session record exists, but that includes a
  // created-but-unmaterialized Session (whose artifact legitimately does not
  // exist yet) and a log removed between `stat` and this scan. The
  // deterministic path is right for the former and a `force` no-op for the
  // latter, so it can never delete the wrong artifact: every accepted id maps
  // to exactly one such path, and the containment/name checks still apply to it.
  return assertContainedSessionDirectory(root, computedSessionDirectory(root, cwd, sessionId), sessionId);
}

/** Scan `<root>/<projectDir>/<id>` one workspace level deep; `undefined` when absent. */
async function scanSessionsRoot(root, sessionId) {
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw new SessionCleanerError('delete/failed', `cannot scan the sessions root for session "${sessionId}": ${messageOf(error)}`, {
      details: { sessionId },
      cause: error,
    });
  }

  const matches = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch (error) {
      // A project directory can be pruned while the scan walks the root.
      if (isMissingPathError(error)) continue;
      throw new SessionCleanerError('delete/failed', `cannot inspect the session directory for "${sessionId}": ${messageOf(error)}`, {
        details: { sessionId },
        cause: error,
      });
    }
    for (const entry of entries) {
      // The listing is the authority: match the real on-disk name (case-folded
      // on Windows) and return its actual spelling, never a reconstructed one.
      if (!entry.isDirectory() || !sameFileName(entry.name, sessionId)) continue;
      matches.push(join(projectPath, entry.name));
    }
  }

  if (matches.length > 1) {
    throw new SessionCleanerError('delete/failed', `session "${sessionId}" appears in more than one project directory; refusing to choose one`, {
      details: { sessionId },
    });
  }
  return matches[0];
}

/** The backend's own path layout, used when no on-disk directory was found. */
function computedSessionDirectory(root, cwd, sessionId) {
  try {
    return sessionDir(root, cwd, sessionId);
  } catch (error) {
    throw new SessionCleanerError('delete/failed', `cannot locate the stored session "${sessionId}": ${messageOf(error)}`, {
      details: { sessionId },
      cause: error,
    });
  }
}

/** Prove the resolved directory is a direct child of a project directory under `root`. */
function assertContainedSessionDirectory(root, directory, sessionId) {
  const target = resolve(directory);
  const rootPath = resolve(root);
  const relativePath = relative(rootPath, target);
  const escapes =
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);
  if (escapes || target === rootPath || !isPathContained(rootPath, target) || !sameFileName(basename(target), sessionId)) {
    throw new SessionCleanerError('delete/failed', `the resolved session directory for "${sessionId}" escapes the sessions root`, {
      details: { sessionId },
    });
  }
  return target;
}

/** Whether an fs error just means "that path does not exist". */
function isMissingPathError(error) {
  const code = error?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Read the live Session and Agent for `id` (each optional). A service that
 * throws is a hard failure: deletion must not guess about live ownership.
 */
function readLiveServices(ctx, sessionId) {
  const live = { session: undefined, agent: undefined };
  for (const [serviceName, key] of [['sessions', 'session'], ['agents', 'agent']]) {
    const service = optionalService(ctx, serviceName);
    if (service === undefined || typeof service.get !== 'function') continue;
    try {
      live[key] = service.get(sessionId);
    } catch (error) {
      throw new SessionCleanerError('delete/failed', `cannot check whether session "${sessionId}" is live: ${messageOf(error)}`, {
        details: { sessionId },
        cause: error,
      });
    }
  }
  return live;
}

/**
 * Stop a running Agent before its log is removed: a live turn would keep
 * appending to a log that no longer exists and leave a half Session behind.
 * `agents.get(id)` returns the bare Agent (the handle disposer belongs to its
 * creator), so cancellation is the correct lever. Waits up to the stop budget
 * for the Agent to leave `running`; a still-running Agent refuses deletion.
 */
async function stopRunningAgent(ctx, sessionId, agent, internals) {
  if (agent === undefined || agent === null) return;
  if (agentStatus(agent) !== 'running') return;

  logInfo(ctx, `session-cleaner: stopping the running agent for session "${sessionId}" before deletion`);
  const cancel = cancellationCall(agent);
  if (cancel === undefined) {
    throw activeAgentError(sessionId, 'the live agent exposes no cancellation method');
  }
  try {
    cancel();
  } catch (error) {
    // The poll below is the authority: a cancellation that throws can still
    // have aborted the turn.
    logWarn(ctx, `session-cleaner: cancelling the agent for session "${sessionId}" threw: ${messageOf(error)}`);
  }

  const timeoutMs = stopTimeoutMs(internals);
  const sleep = typeof internals.sleep === 'function' ? internals.sleep : sleepFor;
  if (!await waitForAgentIdle(agent, timeoutMs, sleep)) {
    throw activeAgentError(sessionId, `the agent was still running ${String(timeoutMs)} ms after it was cancelled`);
  }
  logInfo(ctx, `session-cleaner: agent for session "${sessionId}" stopped`);
}

/** The Agent's cancellation lever, normalized across the shipped Agent API. */
function cancellationCall(agent) {
  if (typeof agent.cancel === 'function') return () => agent.cancel({ kind: 'user' }, { keepInbox: false });
  if (typeof agent.abort === 'function') return () => agent.abort();
  if (typeof agent.interrupt === 'function') return () => agent.interrupt();
  return undefined;
}

/** Poll the Agent's status until it leaves `running` or `timeoutMs` elapses. */
async function waitForAgentIdle(agent, timeoutMs, sleep) {
  if (agentStatus(agent) !== 'running') return true;
  if (!(timeoutMs > 0)) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(STOP_POLL_INTERVAL_MS);
    if (agentStatus(agent) !== 'running') return true;
  }
  return agentStatus(agent) !== 'running';
}

/** The Agent's status, defensively read (`undefined` when the getter throws). */
function agentStatus(agent) {
  try {
    return agent.status;
  } catch {
    return undefined;
  }
}

/** The stop budget: test seam first, then the environment override, then the default. */
function stopTimeoutMs(internals) {
  if (typeof internals.stopTimeoutMs === 'number' && Number.isFinite(internals.stopTimeoutMs) && internals.stopTimeoutMs >= 0) {
    return internals.stopTimeoutMs;
  }
  const configured = Number(process.env[STOP_TIMEOUT_ENV]);
  if (Number.isFinite(configured) && configured >= 500 && configured <= 60000) return configured;
  return DEFAULT_STOP_TIMEOUT_MS;
}

/** Build the `session/active` failure for an Agent that could not be stopped. */
function activeAgentError(sessionId, reason) {
  return new SessionCleanerError('session/active', `session "${sessionId}" is running and could not be stopped (${reason}); nothing was deleted`, {
    details: { sessionId, activity: [{ kind: 'agent' }], reason },
  });
}

/** Default sleep between Agent status polls. */
function sleepFor(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Refuse deletion while any `workspace/session-activity` provider reports work. */
async function assertNoActivity(ctx, sessionId) {
  if (typeof ctx?.waterfall !== 'function') return;
  let activity;
  try {
    activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
  } catch (error) {
    throw new SessionCleanerError('delete/failed', `cannot determine whether session "${sessionId}" is active: ${messageOf(error)}`, {
      details: { sessionId },
      cause: error,
    });
  }
  if (Array.isArray(activity) && activity.length > 0) {
    throw new SessionCleanerError('session/active', `session "${sessionId}" is active (${describeActivity(activity)}); nothing was deleted`, {
      details: { sessionId, activity },
    });
  }
}

/** Short activity summary for logs; the structured array is in `details`. */
function describeActivity(activity) {
  return activity
    .map((entry) => (entry !== null && typeof entry === 'object' && typeof entry.kind === 'string' ? entry.kind : 'unknown'))
    .join(', ');
}

/**
 * Detach the Session from every workspace and drop it from the registry-global
 * archive/pin sets. Every failure is reported as `workspace/refused`; the
 * filesystem is not touched until this completes.
 */
async function detachWorkspaceBookkeeping(ctx, sessionId) {
  const registry = optionalService(ctx, 'workspaceRegistry');
  if (registry === undefined) return;

  for (const method of ['list', 'unarchiveSession', 'unpinSession']) {
    if (typeof registry[method] !== 'function') {
      throw workspaceRefused(sessionId, `the workspace registry does not expose ${method}()`);
    }
  }

  let entities;
  try {
    entities = registry.list();
  } catch (error) {
    throw workspaceRefused(sessionId, `cannot list workspaces: ${messageOf(error)}`, error);
  }
  if (!Array.isArray(entities)) throw workspaceRefused(sessionId, 'the workspace registry returned a non-array workspace list');

  for (const entity of entities) {
    let sessionIds;
    try {
      sessionIds = entity?.sessionIds;
    } catch (error) {
      throw workspaceRefused(sessionId, `cannot read a workspace's session accounting: ${messageOf(error)}`, error);
    }
    if (!Array.isArray(sessionIds) || !sessionIds.includes(sessionId)) continue;
    if (typeof entity.detachSession !== 'function') {
      throw workspaceRefused(sessionId, `workspace "${safeWorkspaceId(entity)}" does not expose detachSession()`);
    }
    try {
      await entity.detachSession(sessionId);
    } catch (error) {
      throw workspaceRefused(sessionId, `cannot detach the session from workspace "${safeWorkspaceId(entity)}": ${messageOf(error)}`, error);
    }
  }

  try {
    await registry.unarchiveSession(sessionId);
    await registry.unpinSession(sessionId);
  } catch (error) {
    throw workspaceRefused(sessionId, `cannot clear the archived/pinned bookkeeping for the session: ${messageOf(error)}`, error);
  }
}

/** Build one `workspace/refused` failure. */
function workspaceRefused(sessionId, message, cause) {
  return new SessionCleanerError('workspace/refused', `workspace bookkeeping for session "${sessionId}" could not be updated: ${message}`, {
    details: { sessionId },
    ...cause === undefined ? {} : { cause },
  });
}

/**
 * Remove the Session's derived data: its projection-cache record and the
 * SQLite search indexes, both of which the harness rebuilds from the surviving
 * logs. A stale projection-cache record is the dangerous one (it can revive a
 * deleted Session's title/metadata after a restart), so it is attempted first.
 *
 * These live in `<dsh home>/storages`, i.e. beside the sessions root. The
 * sibling directory is only treated as that tree when it carries one of
 * {@link STORAGES_MARKERS}; every removal is contained to it, and every
 * failure is a warning, never a fatal error (the log itself is already gone).
 */
async function removeDerivedArtifacts(ctx, root, sessionId, remove) {
  const storages = join(dirname(resolve(root)), 'storages');
  if (comparablePath(storages) === comparablePath(root)) return;

  let entries;
  try {
    entries = await readdir(storages, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      logInfo(ctx, `session-cleaner: no DSH storages directory beside the sessions root; skipping projection cache and search index cleanup for "${sessionId}"`);
    } else {
      logWarn(ctx, `session-cleaner: cannot scan the storages directory for derived artifacts of "${sessionId}": ${messageOf(error)}`);
    }
    return;
  }

  if (!entries.some((entry) => STORAGES_MARKERS.includes(entry.name))) {
    logInfo(ctx, `session-cleaner: the directory beside the sessions root is not a DSH storages tree; skipping derived artifact cleanup for "${sessionId}"`);
    return;
  }

  const cacheFile = join(storages, 'session_projcache', 'sessions', `${sessionId}.json`);
  if (isPathContained(storages, cacheFile) && resolve(cacheFile) !== resolve(storages)) {
    await removeOne(ctx, remove, cacheFile, 'projection cache record');
  }

  for (const entry of entries) {
    if (!entry.isFile() || !SEARCH_INDEX_PATTERN.test(entry.name)) continue;
    const indexFile = join(storages, entry.name);
    if (!isPathContained(storages, indexFile) || resolve(indexFile) === resolve(storages)) continue;
    const removed = await removeOne(ctx, remove, indexFile, 'derived search index');
    if (!removed) continue;
    // SQLite WAL sidecars are meaningless without their database.
    for (const suffix of ['-wal', '-shm']) {
      await removeOne(ctx, remove, `${indexFile}${suffix}`, 'derived search index sidecar');
    }
  }
}

/** Best-effort single removal; a missing path is success, a failure is a warning. */
async function removeOne(ctx, remove, target, label) {
  try {
    await remove(target, { force: true });
    return true;
  } catch (error) {
    logWarn(ctx, `session-cleaner: could not remove the ${label} ${JSON.stringify(target)}: ${messageOf(error)}`);
    return false;
  }
}

/** Broadcast removal to every connected browser; a listener failure must not fail the delete. */
function emitRemoved(ctx, sessionId) {
  if (typeof ctx?.emit !== 'function') return;
  try {
    ctx.emit('api-session/removed', sessionId);
  } catch (error) {
    logWarn(ctx, `session-cleaner: api-session/removed listener failed for "${sessionId}": ${messageOf(error)}`);
  }
}

/** Feature-detected info log (the harness logger always exposes warn). */
function logInfo(ctx, message) {
  const logger = ctx?.logger;
  if (logger === undefined) return;
  if (typeof logger.info === 'function') logger.info(message);
  else if (typeof logger.warn === 'function') logger.warn(message);
}

/** Feature-detected warning log. */
function logWarn(ctx, message) {
  const logger = ctx?.logger;
  if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message);
}

/** A short, safe rendering of a rejected id for logs (never the raw upstream string list). */
function safeIdForMessage(value) {
  if (typeof value !== 'string') return value === undefined ? 'undefined' : typeof value;
  return value.length > 64 ? `${value.slice(0, 64)}…` : value;
}

/** A safe workspace id for failure messages. */
function safeWorkspaceId(entity) {
  return typeof entity?.id === 'string' ? entity.id : 'unknown';
}

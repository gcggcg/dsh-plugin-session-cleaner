/**
 * Permanent Session deletion: the only stateful operation the browser half
 * cannot perform itself.
 *
 * Contract (DESIGN.md § Feature 1): resolve services lazily so the plugin
 * loads even when an optional service is absent, refuse to touch a Session
 * that a live Agent or running work still owns, remove every workspace/global
 * bookkeeping reference before the files, delete exactly the JSONL backend's
 * session directory, and finally tell every connected browser to drop the row.
 *
 * @module dsh-plugin-session-cleaner/host/delete-session
 */

import { rm as removePath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { sessionDir } from './encoding.js';
import { SessionCleanerError, messageOf } from './errors.js';

/** The one accepted Session id shape (see task/design contract). */
export const SESSION_ID_PATTERN = /^session-[A-Za-z0-9._-]{1,160}$/;

/**
 * Whether `value` is an acceptable Session id for deletion.
 * @param {unknown} value - candidate id.
 * @returns {boolean} true for a string matching {@link SESSION_ID_PATTERN}.
 */
export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/**
 * Permanently delete one stored Session.
 *
 * Order matters: the live/activity checks and the path computation run before
 * any bookkeeping write, and every reference is detached before the artifact
 * disappears (DESIGN.md § Deletion algorithm).
 *
 * @param {object} ctx - host plugin context; services are read lazily.
 * @param {string} sessionId - the Session id to delete.
 * @param {{ rm?: typeof removePath }} [internals] - test seams; production
 *   callers omit this.
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
  const directory = resolveSessionDirectory(root, cwd, sessionId);

  assertNotLive(ctx, sessionId);
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

  emitRemoved(ctx, sessionId);
  logInfo(ctx, `session-cleaner: deleted session "${sessionId}"`);
  return { sessionId };
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

/** The stored header's cwd, which selects the project directory. */
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

/** Compute the backend's session directory and prove it stays under the root. */
function resolveSessionDirectory(root, cwd, sessionId) {
  let directory;
  try {
    directory = sessionDir(root, cwd, sessionId);
  } catch (error) {
    throw new SessionCleanerError('delete/failed', `cannot locate the stored session "${sessionId}": ${messageOf(error)}`, {
      details: { sessionId },
      cause: error,
    });
  }
  const relativePath = relative(root, directory);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new SessionCleanerError('delete/failed', `the computed session directory for "${sessionId}" escapes the sessions root`, {
      details: { sessionId },
    });
  }
  return directory;
}

/** Refuse deletion while this process holds a live Session or Agent for the id. */
function assertNotLive(ctx, sessionId) {
  for (const serviceName of ['sessions', 'agents']) {
    const service = optionalService(ctx, serviceName);
    if (service === undefined || typeof service.get !== 'function') continue;
    let live;
    try {
      live = service.get(sessionId);
    } catch (error) {
      throw new SessionCleanerError('delete/failed', `cannot check whether session "${sessionId}" is live: ${messageOf(error)}`, {
        details: { sessionId },
        cause: error,
      });
    }
    if (live !== undefined) {
      throw new SessionCleanerError('session/live', `session "${sessionId}" is live in this process and cannot be deleted`, {
        details: { sessionId },
      });
    }
  }
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
    throw new SessionCleanerError('session/active', `session "${sessionId}" is active (${describeActivity(activity)})`, {
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

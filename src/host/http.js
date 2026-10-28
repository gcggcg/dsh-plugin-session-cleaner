/**
 * HTTP half of the host plugin: one authenticated route on `ctx.webServer`
 * that serves `GET /api/session-cleaner/health` and
 * `POST /api/session-cleaner/delete`.
 *
 * Safety properties (DESIGN.md § Feature 1):
 * - every request passes the built-in connection fence first, exactly like the
 *   `/api` bridge (`401`/`403` plain text when it rejects);
 * - only `POST` + `application/json` bodies of at most 64 KiB are accepted;
 * - answers are JSON with stable error codes, never thrown out of the handler.
 *
 * @module dsh-plugin-session-cleaner/host/http
 */

import { SessionCleanerError, messageOf } from './errors.js';
import { deleteSession, isValidSessionId } from './delete-session.js';

/** Route prefix registered on the Web server. */
export const ROUTE_PREFIX = '/api/session-cleaner';

/** Maximum accepted request body size (64 KiB, per DESIGN.md). */
export const MAX_BODY_BYTES = 64 * 1024;

const HEALTH_ENDPOINT = '/health';
const DELETE_ENDPOINT = '/delete';

/**
 * Build the Web-server handler bound to one plugin context.
 * @param {object} ctx - host plugin context (services read lazily per request).
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 *   a handler that always answers and never rejects.
 */
export function createSessionCleanerHandler(ctx) {
  return async function handleSessionCleanerRequest(req, res) {
    try {
      await dispatch(ctx, req, res);
    } catch (error) {
      logWarn(ctx, `session-cleaner: unexpected failure while serving ${String(req?.url)}: ${messageOf(error)}`);
      try {
        if (!res.writableEnded && !res.headersSent) {
          if (error instanceof SessionCleanerError) sendError(res, error.status, error.code, error.message, error.details);
          else sendError(res, 500, 'gateway/internal', 'the session cleaner failed unexpectedly');
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch {
        try {
          res.destroy();
        } catch {
          /* the socket is already gone */
        }
      }
    }
  };
}

/** Authenticate, route, and answer one request. */
async function dispatch(ctx, req, res) {
  if (!authenticate(ctx, req, res)) return;

  const pathname = requestPath(req);
  if (pathname === undefined) {
    sendError(res, 404, 'route/not-found', `no ${ROUTE_PREFIX} endpoint matched the request path`);
    return;
  }
  const endpoint = endpointOf(pathname);
  if (endpoint === undefined || endpoint === '') {
    sendError(res, 404, 'route/not-found', `no ${ROUTE_PREFIX} endpoint at ${pathname}`, { path: pathname });
    return;
  }
  if (endpoint === HEALTH_ENDPOINT) {
    handleHealth(req, res);
    return;
  }
  if (endpoint === DELETE_ENDPOINT) {
    await handleDelete(ctx, req, res);
    return;
  }
  sendError(res, 404, 'route/not-found', `no ${ROUTE_PREFIX} endpoint at ${pathname}`, { path: pathname });
}

/**
 * Apply the exact browser-cookie / Host / Origin fence of the built-in `/api`
 * bridge. A missing fence service fails closed: without it no request may be
 * trusted.
 * @returns {boolean} whether dispatch may continue.
 */
function authenticate(ctx, req, res) {
  let connection;
  try {
    connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
  } catch (error) {
    logWarn(ctx, `session-cleaner: cannot read the connection service: ${messageOf(error)}`);
    sendText(res, 403, 'forbidden');
    return false;
  }
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    logWarn(ctx, 'session-cleaner: connection service unavailable; refusing the request');
    sendError(res, 503, 'service/unavailable', 'the web connection service is unavailable, so requests cannot be authenticated', {
      service: 'connection',
    });
    return false;
  }

  let rejection;
  try {
    rejection = connection.requestRejection(req);
  } catch (error) {
    logWarn(ctx, `session-cleaner: the request trust check failed: ${messageOf(error)}`);
    sendText(res, 403, 'forbidden');
    return false;
  }
  if (rejection === undefined) return true;
  if (typeof rejection === 'number' && rejection >= 400 && rejection <= 599) {
    sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
  } else {
    sendText(res, 403, 'forbidden');
  }
  return false;
}

/** Parse the request target pathname; `undefined` for an unparsable target. */
function requestPath(req) {
  const raw = typeof req?.url === 'string' ? req.url : '/';
  try {
    return new URL(raw, 'http://dsh.internal').pathname;
  } catch {
    return undefined;
  }
}

/** Map a pathname to its endpoint under {@link ROUTE_PREFIX}; `undefined` when unmatched. */
function endpointOf(pathname) {
  if (pathname === ROUTE_PREFIX) return '';
  if (pathname.startsWith(`${ROUTE_PREFIX}/`)) return pathname.slice(ROUTE_PREFIX.length);
  return undefined;
}

/** `GET /api/session-cleaner/health` — a cheap readiness probe for tests. */
function handleHealth(req, res) {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, ['GET']);
    return;
  }
  sendJson(res, 200, { ok: true, plugin: 'session-cleaner' });
}

/** `POST /api/session-cleaner/delete` — permanently remove one stored Session. */
async function handleDelete(ctx, req, res) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, ['POST']);
    return;
  }
  if (requestMediaType(req) !== 'application/json') {
    sendError(res, 415, 'request/unsupported-media-type', 'this endpoint accepts application/json bodies only', {
      expected: 'application/json',
    });
    return;
  }

  const read = await readRequestBody(req, MAX_BODY_BYTES);
  if (read.tooLarge === true) {
    sendError(res, 413, 'request/too-large', `the request body exceeds the ${String(MAX_BODY_BYTES)}-byte limit`, { limitBytes: MAX_BODY_BYTES }, { connection: 'close' });
    return;
  }
  if (read.aborted === true) return;
  if (read.error !== undefined) {
    sendError(res, 400, 'request/invalid-body', `the request body could not be read: ${messageOf(read.error)}`);
    return;
  }

  const payload = parseJsonBody(read.body);
  if (payload === undefined) {
    sendError(res, 400, 'request/invalid-json', 'the request body is not valid JSON', { expected: '{"sessionId":"..."}' });
    return;
  }
  const sessionId = plainObject(payload) ? payload.sessionId : undefined;
  if (!isValidSessionId(sessionId)) {
    sendError(res, 400, 'session/invalid', 'the request body must be a JSON object with a well-formed sessionId', {
      reason: 'malformed-session-id',
    });
    return;
  }

  try {
    const result = await deleteSession(ctx, sessionId);
    sendJson(res, 200, { ok: true, sessionId: result.sessionId });
  } catch (error) {
    if (error instanceof SessionCleanerError) {
      logWarn(ctx, `session-cleaner: delete rejected for "${sessionId}": ${error.code}: ${error.message}`);
      sendError(res, error.status, error.code, error.message, error.details);
      return;
    }
    logWarn(ctx, `session-cleaner: delete failed for "${sessionId}": ${messageOf(error)}`);
    sendError(res, 500, 'delete/failed', `the session could not be deleted: ${messageOf(error)}`);
  }
}

/** Request content type without parameters, lowercased; `''` when absent. */
function requestMediaType(req) {
  const raw = req?.headers?.['content-type'];
  if (typeof raw !== 'string') return '';
  return raw.split(';', 1)[0].trim().toLowerCase();
}

/** Parse the request body as JSON; `undefined` when it is not JSON. */
function parseJsonBody(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Whether `value` is a non-null, non-array object. */
function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Buffer at most `limit` request bytes.
 * @param {import('node:http').IncomingMessage} req - the request body stream.
 * @param {number} limit - maximum buffered bytes.
 * @returns {Promise<{ body?: Buffer, tooLarge?: true, aborted?: true, error?: unknown }>}
 *   the body or a classified failure; never rejects.
 */
function readRequestBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
      resolve(result);
    };
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > limit) {
        // Stop buffering; the 413 answer closes the connection, so the rest of
        // the body is discarded with the socket instead of being retained.
        try {
          req.pause();
        } catch {
          /* the stream is already gone */
        }
        settle({ tooLarge: true });
        return;
      }
      chunks.push(buffer);
    }
    function onEnd() {
      settle({ body: Buffer.concat(chunks) });
    }
    function onError(error) {
      settle({ error });
    }
    function onAborted() {
      settle({ aborted: true });
    }
    function onClose() {
      if (req.readableEnded !== true) settle({ aborted: true });
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
  });
}

/** Send a JSON response unless the response is already committed. */
function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded === true) return;
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  };
  try {
    res.writeHead(status, headers);
    res.end(body);
  } catch {
    try {
      res.destroy();
    } catch {
      /* the socket is already gone */
    }
  }
}

/** Send a stable-code failure response. */
function sendError(res, status, code, message, details, extraHeaders = {}) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  sendJson(res, status, { ok: false, error }, extraHeaders);
}

/** Send a plain-text response (the connection fence's own rejection shape). */
function sendText(res, status, text) {
  if (res.writableEnded === true) return;
  try {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  } catch {
    try {
      res.destroy();
    } catch {
      /* the socket is already gone */
    }
  }
}

/** Send a `405` with a stable code and the `Allow` header. */
function sendMethodNotAllowed(res, allow) {
  sendError(res, 405, 'route/method-not-allowed', `method not allowed; this endpoint accepts ${allow.join(', ')}`, { allow }, {
    allow: allow.join(', '),
  });
}

/** Feature-detected warning log. */
function logWarn(ctx, message) {
  const logger = ctx?.logger;
  if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message);
}

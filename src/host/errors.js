/**
 * Stable error taxonomy for the `/api/session-cleaner` route. The browser
 * half localizes every code; the raw `message` exists for logs and for
 * developers, never as display text.
 *
 * Every failure the route can report is one of these codes. Codes listed in
 * DESIGN.md (`session/*`, `workspace/refused`, `delete/failed`) describe
 * deletion outcomes; the `request/*`, `route/*`, `service/*` and
 * `gateway/internal` families describe transport or environment failures the
 * client only needs as a generic fallback.
 *
 * @module dsh-plugin-session-cleaner/host/errors
 */

/** HTTP status for each stable code. */
export const ERROR_STATUSES = Object.freeze({
  'session/invalid': 400,
  'session/not-found': 404,
  'session/live': 409,
  'session/active': 409,
  'workspace/refused': 500,
  'delete/failed': 500,
  'request/invalid-json': 400,
  'request/invalid-body': 400,
  'request/too-large': 413,
  'request/unsupported-media-type': 415,
  'route/not-found': 404,
  'route/method-not-allowed': 405,
  'service/unavailable': 503,
  'gateway/internal': 500,
});

/** A stable, client-facing failure with a code and an HTTP status. */
export class SessionCleanerError extends Error {
  /**
   * @param {string} code - one of {@link ERROR_STATUSES}.
   * @param {string} message - human-readable developer message.
   * @param {{ status?: number, details?: unknown, cause?: unknown }} [options]
   *   optional status override, structured details for the response body, and
   *   the underlying failure.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SessionCleanerError';
    /** Stable code the client switches on. */
    this.code = code;
    /** HTTP status to answer with. */
    this.status = options.status ?? ERROR_STATUSES[code] ?? 500;
    /** Optional structured details, safe to serialize into the response. */
    this.details = options.details;
  }
}

/**
 * Build the JSON-serializable `error` member of a failure response.
 * @param {unknown} error - a thrown value.
 * @param {string} [fallbackCode] - code used for non-{@link SessionCleanerError}s.
 * @returns {{ code: string, message: string, details?: unknown }} the wire form.
 */
export function errorPayload(error, fallbackCode = 'gateway/internal') {
  if (error instanceof SessionCleanerError) {
    return {
      code: error.code,
      message: error.message,
      ...error.details === undefined ? {} : { details: error.details },
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Best-effort message of an arbitrary thrown value.
 * @param {unknown} error - a thrown value.
 * @returns {string} its message.
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

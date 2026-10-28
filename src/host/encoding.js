/**
 * Session-log path layout, copied faithfully from the installed
 * `@deepseek-ai/dsh-session-persistence-jsonl` 0.2.1-rc.3 build
 * (`lib/index.js`, `encodeSegment` / `projectKey` / `projectDir` /
 * `sessionDir`). Those helpers are module-private there, so the session
 * cleaner carries its own copy: deleting a session requires addressing
 * exactly the directory the backend writes, including its escaping rules
 * for arbitrary code units, `..`/`.`, and the readable project key.
 *
 * The algorithms (and their comments) intentionally mirror the reference
 * implementation; when the backend's on-disk layout changes, this module
 * must change with it.
 *
 * @module dsh-plugin-session-cleaner/host/encoding
 */

import { join } from 'node:path';

/** One literal, filesystem-safe path character. */
const SAFE_SEGMENT_CHARACTER = /^[A-Za-z0-9._-]$/;

/**
 * Encode an arbitrary string as a single safe path segment, injectively over
 * ALL JS (UTF-16) strings — including lone surrogates. A Session id is an
 * unvalidated branded string in the backend, so this neutralizes `../`,
 * absolute paths, NUL, and separators before any filesystem use. Safe code
 * units remain literal; every other unit, including `~`, becomes `~XXXX`.
 * Operating on code units preserves lone surrogates, while special-casing
 * `.` and `..` prevents traversal by an otherwise safe whole segment.
 *
 * @param {string} raw - the string to encode; must be non-empty.
 * @returns {string} the escaped single path segment, decodable back to `raw`.
 * @throws {Error} when `raw` is empty.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string') throw new TypeError('cannot encode a non-string path segment');
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && SAFE_SEGMENT_CHARACTER.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * Build the readable directory key for a project path.
 * Filesystem separators and drive separators become `-`; unsafe code units use
 * the same `~XXXX` escape as session ids. The key is bounded for filesystem
 * component limits. Separator replacement and truncation are intentionally
 * lossy, following the common human-navigable project-directory convention.
 *
 * @param {string} cwd - the session's project directory.
 * @returns {string} a single filesystem-safe project directory name.
 * @throws {Error} when `cwd` is empty.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string') throw new TypeError('cannot encode a non-string project path');
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && SAFE_SEGMENT_CHARACTER.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * The configured root's human-navigable project directory. A configured root
 * may be local or shared; this grouping does not prescribe its deployment.
 *
 * @param {string} root - the backend's session root directory.
 * @param {string | undefined} cwd - the session's project directory;
 *   `undefined` selects `_no-cwd`.
 * @returns {string} the project directory path under `root`.
 */
export function projectDir(root, cwd) {
  if (cwd === undefined) return join(root, '_no-cwd');
  return join(root, projectKey(cwd));
}

/**
 * The directory owned by one session.
 *
 * @param {string} root - the backend's session root directory.
 * @param {string | undefined} cwd - the session's project directory.
 * @param {string} id - the session id, encoded to one safe path segment.
 * @returns {string} the session directory beneath its project directory.
 */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

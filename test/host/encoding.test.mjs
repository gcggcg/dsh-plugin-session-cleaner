/**
 * Encoding tests for the session-log path layout copied from the installed
 * `@deepseek-ai/dsh-session-persistence-jsonl` backend.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeSegment, projectDir, projectKey, sessionDir } from '../../src/host/encoding.js';

test('projectKey mirrors the readable project-directory convention', () => {
  assert.equal(projectKey('E:\\project\\deepseek-tool'), '--E-project-deepseek-tool--');
  assert.equal(projectKey('/tmp/a'), '--tmp-a--');
  assert.equal(projectKey('E:\\project\\视频\\game\\session-plugin-view'), '--E-project-~89C6~9891-game-session-plugin-view--');
  assert.equal(projectKey('C:\\'), '--C---');
  assert.equal(projectKey('///'), '--root--');
  assert.equal(projectKey('C:work'), '--C-work--');
});

test('projectKey replaces separator runs with one dash and canonicalizes leading dashes', () => {
  assert.equal(projectKey('a\\\\b'), '--a-b--');
  assert.equal(projectKey('a::b'), '--a-b--');
  assert.equal(projectKey('---lead'), '--lead--');
});

test('projectKey bounds the readable component', () => {
  const key = projectKey(`E:\\${'x'.repeat(400)}`);
  assert.ok(key.length <= 4 + 251, `key length ${String(key.length)}`);
  assert.ok(key.startsWith('--'));
  assert.ok(key.endsWith('--'));
});

test('projectKey rejects non-strings and empty paths', () => {
  assert.throws(() => projectKey(''), /empty project path/);
  assert.throws(() => projectKey(undefined), TypeError);
});

test('encodeSegment keeps safe ids literal', () => {
  assert.equal(encodeSegment('session-4d8fdd0f-58c6-41f7-ab8c-d55e93d0499a'), 'session-4d8fdd0f-58c6-41f7-ab8c-d55e93d0499a');
  assert.equal(encodeSegment('session_a.b-c'), 'session_a.b-c');
});

test('encodeSegment neutralizes traversal, separators, and unsafe code units', () => {
  assert.equal(encodeSegment('.'), '~002E');
  assert.equal(encodeSegment('..'), '~002E~002E');
  assert.equal(encodeSegment('a/b'), 'a~002Fb');
  assert.equal(encodeSegment('a\\b'), 'a~005Cb');
  assert.equal(encodeSegment('~'), '~007E');
  assert.equal(encodeSegment('a b'), 'a~0020b');
  assert.equal(encodeSegment('\n'), '~000A');
  assert.equal(encodeSegment('中'), '~4E2D');
});

test('encodeSegment rejects empty ids', () => {
  assert.throws(() => encodeSegment(''), /empty path segment/);
});

test('projectDir/sessionDir follow <root>/<projectKey>/<encoded id>', () => {
  const root = 'C:\\sessions';
  const id = 'session-abc';
  assert.equal(sessionDir(root, 'E:\\project\\deepseek-tool', id), `${root}\\--E-project-deepseek-tool--\\session-abc`);
  assert.equal(sessionDir(root, undefined, id), `${root}\\_no-cwd\\session-abc`);
  assert.equal(projectDir(root, undefined), `${root}\\_no-cwd`);
});

test('sessionDir output stays inside the sessions root', () => {
  const root = 'C:\\sessions';
  const id = 'session-abc';
  for (const cwd of ['E:\\project\\deepseek-tool', '/tmp/a', undefined]) {
    const directory = sessionDir(root, cwd, id);
    assert.ok(directory.startsWith(`${root}\\`), `${directory} escapes ${root}`);
    assert.ok(!directory.includes(`..\\`), 'no traversal segment');
  }
});

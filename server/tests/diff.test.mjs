// Unit tests for the unified-diff engine used by proposals, previews,
// and the change history. Pure computation - no server needed.
// Usage: npm test   (runs: node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unifiedDiff, splitLines } from '../src/workspace/diff.js';

test('splitLines handles trailing newline, CRLF, and empty input', () => {
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a'), ['a']);
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
});

test('identical texts produce an empty diff', () => {
  const text = 'same\nlines\n';
  assert.equal(unifiedDiff(text, text), '');
});

test('produces an exact unified diff for a single changed line', () => {
  const before = 'line1\nline2\nline3\n';
  const after = 'line1\nline changed\nline3\nline4\n';
  const diff = unifiedDiff(before, after, { oldPath: 'src/example.js', newPath: 'src/example.js' });
  assert.equal(
    diff,
    '--- a/src/example.js\n'
    + '+++ b/src/example.js\n'
    + '@@ -1,3 +1,4 @@\n'
    + ' line1\n'
    + '-line2\n'
    + '+line changed\n'
    + ' line3\n'
    + '+line4\n',
  );
});

test('new file (old text empty) yields a pure-addition hunk', () => {
  const diff = unifiedDiff('', 'a\nb\n', { oldPath: 'x.js', newPath: 'x.js' });
  assert.match(diff, /^--- a\/x\.js\n\+\+\+ b\/x\.js\n@@ -0,0 \+1,2 @@\n\+a\n\+b\n$/);
});

test('deleted content yields a pure-removal hunk', () => {
  const diff = unifiedDiff('a\nb\n', '', { oldPath: 'x.js', newPath: 'x.js' });
  assert.match(diff, /@@ -1,2 \+0,0 @@\n-a\n-b\n$/);
});

test('only a trailing-newline difference is reported honestly', () => {
  const diff = unifiedDiff('a', 'a\n', { oldPath: 'x.js', newPath: 'x.js' });
  assert.match(diff, /no line-level differences/);
  assert.ok(!diff.includes('@@ -1,'));
});

test('oversized input falls back to a header note instead of stalling', () => {
  const oldText = Array.from({ length: 10 }, (_, i) => `old ${i}`).join('\n');
  const newText = Array.from({ length: 10 }, (_, i) => `new ${i}`).join('\n');
  const diff = unifiedDiff(oldText, newText, { oldPath: 'big.js', newPath: 'big.js', maxLines: 5 });
  assert.match(diff, /too large for a line-by-line diff/);
  assert.ok(!diff.includes('\n-'), 'fallback must not emit diff lines');
});

test('context lines are limited to three around each change', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const after = before.replace('line 10\n', 'line TEN\n');
  const diff = unifiedDiff(before, after, { oldPath: 'n.js', newPath: 'n.js' });
  const body = diff.split('\n').filter((l) => /^[-+ ]/.test(l) && !/^[-+]{3}/.test(l));
  assert.equal(body.length, 1 + 3 + 3 + 1, 'change + 3 context on each side');
  assert.ok(body.includes('-line 10'));
  assert.ok(body.includes('+line TEN'));
  assert.ok(body.includes(' line 7'), 'context starts three lines above');
  assert.ok(body.includes(' line 13'), 'context ends three lines below');
});

test('rejects non-string inputs', () => {
  assert.throws(() => unifiedDiff(null, 'x'), TypeError);
  assert.throws(() => unifiedDiff('x', undefined), TypeError);
});

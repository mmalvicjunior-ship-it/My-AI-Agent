// Fragment-based bootstrap delivery tests.
//
// The setup URL carries the bootstrap token in a URL fragment
// (#bootstrap=<token>) instead of the query string: fragments are never sent
// to any server, so the token cannot appear in Vercel, proxy, CDN, or
// application logs, and never appears in a Referer header. These tests pin
// the shared extraction logic used by the frontend and the server-side
// contract (the 403 error points operators at the fragment form).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { extractBootstrapToken } from '../../apps/web/src/bootstrapToken.js';
import { createApp } from '../src/index.js';
import { config } from '../src/config.js';

test('extracts the token from a URL fragment', () => {
  assert.equal(extractBootstrapToken('#bootstrap=test-bootstrap-token'), 'test-bootstrap-token');
});

test('fragment order and unrelated parameters do not confuse the extraction', () => {
  assert.equal(extractBootstrapToken('#mode=register&bootstrap=tok'), 'tok');
  assert.equal(extractBootstrapToken('#bootstrap=first&other=second'), 'first');
});

test('returns empty when the fragment is missing or carries no token', () => {
  assert.equal(extractBootstrapToken(''), '');
  assert.equal(extractBootstrapToken('#'), '');
  assert.equal(extractBootstrapToken('#other=1'), '');
  assert.equal(extractBootstrapToken('#bootstrap='), '');
  assert.equal(extractBootstrapToken(undefined), '');
  assert.equal(extractBootstrapToken(null), '');
});

test('accepts a fragment without the leading hash and trims whitespace', () => {
  assert.equal(extractBootstrapToken('bootstrap= spaced-token '), 'spaced-token');
});

test('decodes percent-encoded values', () => {
  assert.equal(extractBootstrapToken('#bootstrap=abc%20def'), 'abc def');
});

test('a query-string token is NOT honoured (fragment-only delivery)', () => {
  // The frontend never reads window.location.search now; this pins the helper
  // to fragment input so a future refactor cannot silently re-accept the
  // query form.
  assert.equal(extractBootstrapToken('?bootstrap=nope'), '');
});

test('first-account bootstrap error message points at the fragment setup URL', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-fragment-'));
  const originalDbPath = config.databasePath;
  const originalWorkspaceRoot = config.workspaceRoot;
  config.databasePath = path.join(tempDir, 'fresh.db');
  config.workspaceRoot = path.join(tempDir, 'workspaces');
  let server;
  try {
    const created = createApp({ provider: null });
    server = created.app.listen(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    const res = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'correct-horse-battery' }),
    });
    const data = await res.json();
    assert.equal(res.status, 403);
    assert.match(data.error, /#bootstrap=<token>/, 'the error must reference the fragment setup URL');
    assert.doesNotMatch(data.error, /\?bootstrap=/, 'the error must not point at the query-string form');
  } finally {
    server?.closeAllConnections?.();
    server?.close();
    config.databasePath = originalDbPath;
    config.workspaceRoot = originalWorkspaceRoot;
  }
}, { timeout: 30_000 });

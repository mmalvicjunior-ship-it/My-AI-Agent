// The project folder picker must stay confined to PROJECT_IMPORT_ROOT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/index.js';

let importRoot;
let server;
let base;

async function request(pathname, { token } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const res = await fetch(base + pathname, { headers });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

before(async () => {
  importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-import-'));
  fs.mkdirSync(path.join(importRoot, 'alpha'));
  fs.mkdirSync(path.join(importRoot, 'beta'));
  fs.mkdirSync(path.join(importRoot, 'alpha', 'nested'));
  fs.writeFileSync(path.join(importRoot, 'notes.txt'), 'not a directory');

  const created = createApp({ auth: false, projectImportRoot: importRoot });
  server = created.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(importRoot, { recursive: true, force: true });
});

test('lists only directories inside the import root', async () => {
  const { status, data } = await request('/api/projects/browse');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.path, fs.realpathSync(importRoot));
  assert.deepEqual(data.directories.map((entry) => entry.name), ['alpha', 'beta']);
  assert.equal(data.parent, null);
});

test('navigates into a subfolder and reports its parent', async () => {
  const { status, data } = await request(`/api/projects/browse?path=${encodeURIComponent(path.join(importRoot, 'alpha'))}`);
  assert.equal(status, 200);
  assert.deepEqual(data.directories.map((entry) => entry.name), ['nested']);
  assert.equal(data.parent, fs.realpathSync(importRoot));
});

test('rejects paths outside the import root', async () => {
  const { status } = await request(`/api/projects/browse?path=${encodeURIComponent(os.tmpdir())}`);
  assert.equal(status, 403);
});

test('rejects a file path', async () => {
  const { status } = await request(`/api/projects/browse?path=${encodeURIComponent(path.join(importRoot, 'notes.txt'))}`);
  assert.equal(status, 400);
});

test('reports disabled imports clearly', async () => {
  const disabled = createApp({ auth: false, projectImportRoot: '' });
  const local = disabled.app.listen(0);
  await new Promise((resolve) => local.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${local.address().port}/api/projects/browse`);
    const data = await res.json();
    assert.equal(res.status, 403);
    assert.equal(data.code, 'IMPORT_DISABLED');
  } finally {
    local.close();
  }
});

test('requires authentication when auth is enabled', async () => {
  const secured = createApp({ projectImportRoot: importRoot });
  const local = secured.app.listen(0);
  await new Promise((resolve) => local.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${local.address().port}/api/projects/browse`);
    assert.equal(res.status, 401);
  } finally {
    local.close();
  }
});

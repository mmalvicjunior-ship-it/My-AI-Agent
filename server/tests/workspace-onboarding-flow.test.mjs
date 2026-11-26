// Workspace onboarding regressions: opening an existing folder is idempotent,
// selection starts the existing safe scan, scan state is reported, and owned
// workspaces stay isolated. No AI/provider request is used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/index.js';
import { mockProvider } from '../src/ai/mock.js';
import { authorizeFirstAccount } from './setup-authorization.mjs';
import {
  shouldStartWorkspaceScan,
  upsertProject,
  workspaceScanStatus,
  workspaceScanSummary,
} from '../../apps/web/src/workspaceUiHelpers.js';

let server;
let base;
let importRoot;
const tempDirs = [];

async function request(method, route, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + route, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function register(email) {
  const setupToken = await authorizeFirstAccount(base);
  const result = await request('POST', '/api/auth/register', {
    body: { email, password: 'long-enough-password', setupToken },
  });
  assert.equal(result.status, 201);
  return result.data;
}

function makeFixture(name) {
  const root = fs.mkdtempSync(path.join(importRoot, `myai-onboarding-${name}-`));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "fixture" }\n');
  fs.writeFileSync(path.join(root, 'vite.config.js'), 'export default {};\n');
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const answer = 42;\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'ignored');
  return root;
}

before(async () => {
  // Dedicated sibling of the test workspace/database directories: the import
  // root must not contain (or live inside) either of them.
  importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-onboarding-imports-'));
  tempDirs.push(importRoot);
  const created = createApp({ provider: mockProvider, projectImportRoot: importRoot });
  server = created.app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${created.app.address?.()?.port || server.address().port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

test('opening an existing project returns one owned record and can be reopened without duplicates', async () => {
  const account = await register(`open-${Date.now()}@example.com`);
  const root = makeFixture('open');
  const first = await request('POST', '/api/projects', {
    token: account.token,
    body: { name: 'Opened app', path: root },
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.existing, undefined);

  const reopened = await request('POST', '/api/projects', {
    token: account.token,
    body: { name: 'Opened app', path: root },
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.existing, true);
  assert.equal(reopened.data.project.id, first.data.project.id);

  const listed = await request('GET', '/api/projects', { token: account.token });
  assert.equal(listed.data.projects.filter((project) => project.id === first.data.project.id).length, 1);
});

test('a verified selection starts exactly the existing safe scan and reports learned metadata', async () => {
  const account = await register(`scan-${Date.now()}@example.com`);
  const root = makeFixture('scan');
  const opened = await request('POST', '/api/projects', {
    token: account.token,
    body: { name: 'Scanned app', path: root },
  });
  const projectId = String(opened.data.project.id);
  assert.equal(shouldStartWorkspaceScan({ authenticated: true, projectId, workspaceReady: true }), true);
  assert.equal(shouldStartWorkspaceScan({ authenticated: false, projectId, workspaceReady: true }), false);
  assert.equal(shouldStartWorkspaceScan({ authenticated: true, projectId, workspaceReady: false }), false);

  const tree = await request('GET', `/api/projects/${projectId}/tree`, { token: account.token });
  assert.equal(tree.status, 200);
  assert.deepEqual(tree.data.files, ['package.json', 'src/index.js', 'vite.config.js']);
  const summary = workspaceScanSummary(tree.data);
  assert.equal(summary.fileCount, 3);
  assert.equal(summary.manifestCount, 1);
  assert.ok(summary.languageHints.includes('JavaScript'));
  assert.ok(summary.frameworkHints.includes('Vite'));

  const complete = workspaceScanStatus({ hasProject: true, result: tree.data });
  assert.equal(complete.status, 'complete');
  assert.match(complete.message, /3 files/);
  assert.equal(workspaceScanStatus({ hasProject: true, loading: true }).status, 'scanning');
  assert.equal(workspaceScanStatus({ hasProject: false }).status, 'unavailable');
});

test('a failed scan is visible and a retry succeeds after the workspace is restored', async () => {
  const account = await register(`retry-${Date.now()}@example.com`);
  const root = makeFixture('retry');
  const opened = await request('POST', '/api/projects', {
    token: account.token,
    body: { name: 'Retry app', path: root },
  });
  const projectId = opened.data.project.id;

  fs.rmSync(root, { recursive: true, force: true });
  const failed = await request('GET', `/api/projects/${projectId}/tree`, { token: account.token });
  assert.notEqual(failed.status, 200);
  const failedView = workspaceScanStatus({ hasProject: true, error: 'scan failed' });
  assert.equal(failedView.status, 'failed');

  makeFixture('retry-restored');
  // Recreate the exact registered path; ownership and root_path stay unchanged.
  const restored = path.dirname(root);
  assert.ok(restored);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const restored = true;\n');
  const retried = await request('GET', `/api/projects/${projectId}/tree`, { token: account.token });
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.data.files, ['src/index.js']);
});

test('project ownership blocks another account from opening or scanning a workspace', async () => {
  const owner = await register(`owner-${Date.now()}@example.com`);
  const other = await register(`other-${Date.now()}@example.com`);
  const root = makeFixture('owned');
  const opened = await request('POST', '/api/projects', {
    token: owner.token,
    body: { name: 'Private app', path: root },
  });
  const projectId = opened.data.project.id;

  const hiddenTree = await request('GET', `/api/projects/${projectId}/tree`, { token: other.token });
  assert.equal(hiddenTree.status, 404);
  const ownList = await request('GET', '/api/projects', { token: other.token });
  assert.equal(ownList.data.projects.some((project) => project.id === projectId), false);

  // Another account may import the same server folder as its own project; it
  // gets a distinct record and cannot reuse the first account's record.
  const otherOpened = await request('POST', '/api/projects', {
    token: other.token,
    body: { name: 'My copy', path: root },
  });
  assert.equal(otherOpened.status, 201);
  assert.notEqual(otherOpened.data.project.id, projectId);
});

test('an imported root swapped for a symlink is refused instead of following the new target', async () => {
  const owner = await register(`symlink-${Date.now()}@example.com`);
  const root = makeFixture('symlink');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-onboarding-outside-'));
  tempDirs.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'DO-NOT-EXPOSE\n');

  const opened = await request('POST', '/api/projects', {
    token: owner.token,
    body: { name: 'Symlink target', path: root },
  });
  assert.equal(opened.status, 201);
  const projectId = opened.data.project.id;

  const original = `${root}-original`;
  fs.renameSync(root, original);
  fs.symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const tree = await request('GET', `/api/projects/${projectId}/tree`, { token: owner.token });
    assert.equal(tree.status, 403);
    assert.match(tree.data?.error || '', /root changed/i);
    assert.equal(JSON.stringify(tree.data).includes('DO-NOT-EXPOSE'), false);
  } finally {
    fs.unlinkSync(root);
    fs.renameSync(original, root);
  }
});

test('an idempotent reopen refreshes the existing list row without duplicating it', () => {
  const existing = [{ id: 7, name: 'Old name', root_path: 'C:\\projects\\app' }];
  const reopened = { id: 7, name: 'Renamed app' };
  const next = upsertProject(existing, reopened);
  assert.equal(next.length, 1);
  assert.deepEqual(next[0], { id: 7, name: 'Renamed app', root_path: 'C:\\projects\\app' });
  assert.equal(upsertProject(next, { id: 8, name: 'Other' }).length, 2);
});

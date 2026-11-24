// Focused coverage for bounded, owner-safe project discovery and opening.
// No AI/provider request is made; the mock provider only keeps createApp happy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config.js';
import { createApp } from '../src/index.js';
import { mockProvider } from '../src/ai/mock.js';
import {
  collectProjectCandidates,
  decodeDiscoveryId,
  dedupeProjectCandidates,
  discoveryDedupeKey,
  encodeDiscoveryId,
  revalidateProjectCandidates,
} from '../src/workspace/project-discovery.js';
import {
  projectUnderstandingPaths,
  workspaceUnderstandingSummary,
} from '../../apps/web/src/workspaceUiHelpers.js';

let importRoot;
let outsideRoot;
let server;
let base;
let emailCounter = 0;
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

async function register(label = 'user') {
  emailCounter += 1;
  const result = await request('POST', '/api/auth/register', {
    body: {
      email: `${label}-${Date.now()}-${emailCounter}@example.com`,
      password: 'long-enough-password',
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}

function writeProject(parent, name, { manifest = 'package.json', extra = [] } = {}) {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, manifest), `{ "name": "${name}" }\n`);
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export const answer = 42;\n');
  for (const file of extra) fs.writeFileSync(path.join(dir, file), `# ${name}\n`);
  return dir;
}

function findDiscovery(data, name) {
  return data.projects.find((project) => project.name === name);
}

before(async () => {
  importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-discover-'));
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-discover-outside-'));
  tempDirs.push(importRoot, outsideRoot);

  writeProject(importRoot, 'alpha-app', { extra: ['README.md', 'AGENTS.md'] });
  writeProject(path.join(importRoot, 'nested'), 'python-app', { manifest: 'pyproject.toml' });
  writeProject(path.join(importRoot, 'out'), 'ignored-out-app');
  writeProject(path.join(importRoot, 'tmp'), 'ignored-tmp-app');

  const hidden = writeProject(importRoot, '.hidden-app');
  void hidden;
  const dependency = writeProject(path.join(importRoot, 'node_modules'), 'ignored-app');
  void dependency;
  writeProject(outsideRoot, 'secret-app');
  fs.symlinkSync(outsideRoot, path.join(importRoot, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');

  const created = createApp({ provider: mockProvider, projectImportRoot: importRoot });
  server = created.app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${created.app.address?.()?.port || server.address().port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  try {
    fs.unlinkSync(path.join(importRoot, 'linked-outside'));
  } catch { /* best effort */ }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

test('discovery IDs encode only canonical relative paths', () => {
  const id = encodeDiscoveryId('alpha-app/src');
  assert.match(id, /^v1\.[A-Za-z0-9_-]+$/);
  assert.equal(decodeDiscoveryId(id), 'alpha-app/src');
  assert.equal(decodeDiscoveryId('not-an-id'), null);
  assert.equal(encodeDiscoveryId('../outside'), null);
  assert.equal(encodeDiscoveryId(path.join(importRoot, 'alpha-app')), null);
  assert.equal(decodeDiscoveryId(`v1.${Buffer.from('../outside').toString('base64url')}`), null);
  assert.equal(decodeDiscoveryId(`v1.${Buffer.from('a/../b').toString('base64url')}`), null);
  assert.equal(decodeDiscoveryId(`v1.${Buffer.from('C:/secret').toString('base64url')}`), null);
  assert.equal(decodeDiscoveryId(`v1.${Buffer.from('/etc/passwd').toString('base64url')}`), null);
});

test('candidate dedupe uses the canonical real path', () => {
  const first = { relativePath: 'alpha-app', realPath: '/tmp/alpha-app' };
  const second = { relativePath: 'alias/alpha-app', realPath: '/tmp/alpha-app' };
  const third = { relativePath: 'beta-app', realPath: '/tmp/beta-app' };
  assert.equal(dedupeProjectCandidates([first, second, third]).length, 2);
  assert.equal(discoveryDedupeKey('/tmp/alpha-app'), discoveryDedupeKey('/tmp/alpha-app'));
});

test('enumeration stays bounded and skips hidden, ignored, and symlink entries', () => {
  const { candidates, truncated } = collectProjectCandidates({ root: importRoot });
  const relative = candidates.map((candidate) => candidate.relativePath);
  assert.equal(truncated, false);
  assert.ok(relative.includes('alpha-app'));
  assert.ok(relative.includes('nested/python-app'));
  assert.equal(relative.some((entry) => entry.startsWith('.')), false);
  assert.equal(relative.some((entry) => entry.startsWith('node_modules/')), false);
  assert.equal(relative.some((entry) => entry.startsWith('out/') || entry.startsWith('tmp/')), false);
  assert.equal(relative.includes('linked-outside'), false);
  assert.ok(candidates.every((candidate) => candidate.depth <= 2));
});

test('revalidation drops candidates swapped or moved after enumeration', () => {
  const inside = { realPath: path.join(importRoot, 'alpha-app') };
  const outside = { realPath: path.join(outsideRoot, 'secret-app') };
  assert.deepEqual(
    revalidateProjectCandidates({ candidates: [inside, outside], root: importRoot }),
    [inside],
  );
  assert.deepEqual(revalidateProjectCandidates({
    candidates: [inside],
    root: importRoot,
    realpath: () => path.join(outsideRoot, 'secret-app'),
  }), []);
  assert.deepEqual(revalidateProjectCandidates({
    candidates: [inside],
    root: importRoot,
    realpath: () => path.join(importRoot, 'nested', 'python-app'),
  }), []);
});

test('discovery reads markers from the revalidated canonical path', () => {
  const indexSource = fs.readFileSync(
    fileURLToPath(new URL('../src/index.js', import.meta.url)),
    'utf8',
  );
  assert.match(indexSource, /revalidateProjectCandidates\(\{/);
  assert.match(indexSource, /inspectProjectMarkers\(\{ absolutePath: candidate\.realPath \}\)/);
});

test('discovery and opening reject an import root overlapping workspace or database directories', async () => {
  const unsafeRoot = path.dirname(config.workspaceRoot);
  const unsafeApp = createApp({ auth: false, projectImportRoot: unsafeRoot });
  const local = unsafeApp.app.listen(0);
  await once(local, 'listening');
  try {
    const discovery = await fetch(`http://127.0.0.1:${local.address().port}/api/projects/discover`);
    const discoveryData = await discovery.json();
    assert.equal(discovery.status, 403);
    assert.equal(discoveryData.code, 'IMPORT_UNSAFE');

    const opened = await fetch(`http://127.0.0.1:${local.address().port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Unsafe import', path: path.join(unsafeRoot, 'src') }),
    });
    const openedData = await opened.json();
    assert.equal(opened.status, 403);
    assert.equal(openedData.code, 'IMPORT_UNSAFE');
  } finally {
    local.closeAllConnections?.();
    local.close();
  }
});

test('discovery requires authentication', async () => {
  const response = await fetch(`${base}/api/projects/discover`);
  assert.equal(response.status, 401);
});

test('authenticated discovery returns only safe metadata from the authorized root', async () => {
  const account = await register('discover');
  const { status, data } = await request('GET', '/api/projects/discover', { token: account.token });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  const alpha = findDiscovery(data, 'Alpha App');
  const python = findDiscovery(data, 'Python App');
  assert.ok(alpha);
  assert.ok(python);
  assert.match(alpha.discoveryId, /^v1\./);
  assert.ok(alpha.technologies.includes('Node.js'));
  assert.ok(python.technologies.includes('Python'));
  assert.ok(alpha.markers.includes('package.json'));
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes(importRoot), false);
  assert.equal(serialized.includes(outsideRoot), false);
  assert.equal(serialized.includes('secret-app'), false);
  for (const project of data.projects) {
    assert.equal(Object.hasOwn(project, 'path'), false);
    assert.equal(Object.hasOwn(project, 'rootPath'), false);
  }
});

test('discovery reports a clear configuration error when no root is set', async () => {
  const disabled = createApp({ auth: false, projectImportRoot: '' });
  const local = disabled.app.listen(0);
  await once(local, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${local.address().port}/api/projects/discover`);
    const data = await response.json();
    assert.equal(response.status, 403);
    assert.equal(data.code, 'DISCOVERY_NOT_CONFIGURED');
  } finally {
    local.closeAllConnections?.();
    local.close();
  }
});

test('discovery returns an empty list for an authorized root with no projects', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-discover-empty-'));
  tempDirs.push(emptyRoot);
  const localApp = createApp({ auth: false, projectImportRoot: emptyRoot });
  const local = localApp.app.listen(0);
  await once(local, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${local.address().port}/api/projects/discover`);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(data.projects, []);
    assert.equal(data.count, 0);
  } finally {
    local.closeAllConnections?.();
    local.close();
  }
});

test('refreshing discovery picks up a newly added project', async () => {
  const account = await register('refresh');
  const before = await request('GET', '/api/projects/discover', { token: account.token });
  assert.equal(findDiscovery(before.data, 'Fresh App'), undefined);
  writeProject(importRoot, 'fresh-app');
  const after = await request('GET', '/api/projects/discover', { token: account.token });
  assert.equal(after.status, 200);
  assert.ok(findDiscovery(after.data, 'Fresh App'));
});

test('a discovered project opens, reopens without duplicates, scans, and stays owner-scoped', async () => {
  const owner = await register('owner');
  const other = await register('other');
  const discovered = await request('GET', '/api/projects/discover', { token: owner.token });
  const alpha = findDiscovery(discovered.data, 'Alpha App');
  assert.ok(alpha);

  const opened = await request('POST', '/api/projects', {
    token: owner.token,
    body: { name: alpha.name, discoveryId: alpha.discoveryId },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  const projectId = opened.data.project.id;

  const reopened = await request('POST', '/api/projects', {
    token: owner.token,
    body: { name: alpha.name, discoveryId: alpha.discoveryId },
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.existing, true);
  assert.equal(reopened.data.project.id, projectId);

  const ownerList = await request('GET', '/api/projects', { token: owner.token });
  assert.equal(ownerList.data.projects.filter((project) => project.id === projectId).length, 1);

  const ownerView = await request('GET', '/api/projects/discover', { token: owner.token });
  assert.equal(findDiscovery(ownerView.data, 'Alpha App').alreadyOpenedProjectId, projectId);
  const otherView = await request('GET', '/api/projects/discover', { token: other.token });
  assert.equal(findDiscovery(otherView.data, 'Alpha App').alreadyOpenedProjectId, null);

  const hiddenTree = await request('GET', `/api/projects/${projectId}/tree`, { token: other.token });
  assert.equal(hiddenTree.status, 404);
  const tree = await request('GET', `/api/projects/${projectId}/tree`, { token: owner.token });
  assert.equal(tree.status, 200);
  assert.ok(tree.data.files.includes('package.json'));
  assert.ok(tree.data.files.includes('README.md'));
  assert.ok(tree.data.files.includes('src/index.js'));
  assert.ok(tree.data.languageHints.includes('JavaScript'));

  const paths = projectUnderstandingPaths(tree.data);
  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('AGENTS.md'));
  assert.ok(paths.includes('package.json'));
  assert.equal(paths.includes('src/index.js'), false);
  const summary = workspaceUnderstandingSummary({ result: tree.data, readPaths: paths });
  assert.match(summary, /Understood project:/);
  assert.match(summary, /README\.md/);

  for (const filePath of paths) {
    const file = await request('GET', `/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`, { token: owner.token });
    assert.equal(file.status, 200, `Could not read ${filePath}`);
    assert.equal(typeof file.data.content, 'string');
  }
});

test('discovery IDs cannot escape through traversal or a symlink', async () => {
  const account = await register('escape');
  const traversal = await request('POST', '/api/projects', {
    token: account.token,
    body: { name: 'Traversal', discoveryId: `v1.${Buffer.from('../outside-root').toString('base64url')}` },
  });
  assert.equal(traversal.status, 400);

  const outsideId = encodeDiscoveryId('linked-outside');
  const symlink = await request('POST', '/api/projects', {
    token: account.token,
    body: { name: 'Symlink', discoveryId: outsideId },
  });
  assert.equal(symlink.status, 403);
});

test('creating a managed new workspace still works with a name only', async () => {
  const account = await register('new-workspace');
  const created = await request('POST', '/api/projects', {
    token: account.token,
    body: { name: 'Fresh workspace' },
  });
  assert.equal(created.status, 201);
  assert.ok(created.data.project.id);
  const tree = await request('GET', `/api/projects/${created.data.project.id}/tree`, { token: account.token });
  assert.equal(tree.status, 200);
});

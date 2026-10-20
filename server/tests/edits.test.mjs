// Automated tests for human file editing: preview-before-write, create/
// replace, delete, change history, and pending proposal listing with diffs.
// Usage: npm test   (runs: node --test)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';

const servers = [];
const tempDirs = [];

const qsOf = (p, extra) => {
  const qs = new URLSearchParams();
  if (p !== undefined) qs.set('path', p);
  if (extra) for (const [k, v] of Object.entries(extra)) qs.set(k, v);
  return `?${qs}`;
};

async function startServer() {
  const { app, tools } = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;

  const call = async (method, url, body) => {
    const init = body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(url, init);
    let data = null;
    try {
      data = await res.json();
    } catch { /* non-JSON */ }
    return { status: res.status, data };
  };

  return {
    tools,
    post: (body) => call('POST', base, body),
    put: (id, p, content, extra) => call('PUT', `${base}/${id}/file${qsOf(p, extra)}`, { content }),
    putRaw: (id, p, body, extra) => call('PUT', `${base}/${id}/file${qsOf(p, extra)}`, body),
    del: (id, p) => call('DELETE', `${base}/${id}/file${qsOf(p)}`),
    readFile: (id, p) => call('GET', `${base}/${id}/file${qsOf(p)}`),
    changes: (id, extra) => call('GET', `${base}/${id}/changes${extra ? `?${new URLSearchParams(extra)}` : ''}`),
    proposals: (id) => call('GET', `${base}/${id}/proposals`),
    apply: (id, proposalId) => call('POST', `${base}/${id}/proposals/${proposalId}/apply`),
  };
}

after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

async function makeProject(api, name = 'Edits Test Project') {
  const { status, data } = await api.post({ name });
  assert.equal(status, 201);
  return data.project.id;
}

function workspaceDir(id) {
  return path.join(config.workspaceRoot, String(id));
}

// ---------------------------------------------------------------------------
// PUT: create and replace with diffs
// ---------------------------------------------------------------------------
test('PUT creates a missing file with a create diff (201)', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  const content = 'export const answer = 42;\n';

  const res = await api.put(id, 'src/new.js', content);
  assert.equal(res.status, 201);
  assert.equal(res.data.created, true);
  assert.equal(res.data.action, 'create');
  assert.equal(res.data.path, 'src/new.js');
  assert.match(res.data.diff, /--- a\/src\/new\.js/);
  assert.match(res.data.diff, /\+export const answer = 42;/);
  assert.ok(!res.data.diff.includes('\n-'), 'a pure create has no removals');
  assert.equal(
    fs.readFileSync(path.join(workspaceDir(id), 'src', 'new.js'), 'utf8'),
    content,
    'parent folders are created and content written exactly',
  );
});

test('PUT replaces an existing file with an update diff (200)', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  fs.writeFileSync(path.join(workspaceDir(id), 'app.js'), 'const a = 1;\nconst keep = 2;\n');

  const res = await api.put(id, 'app.js', 'const a = 9;\nconst keep = 2;\n');
  assert.equal(res.status, 200);
  assert.equal(res.data.created, false);
  assert.equal(res.data.action, 'update');
  assert.match(res.data.diff, /-const a = 1;/);
  assert.match(res.data.diff, /\+const a = 9;/);
  assert.match(res.data.diff, / const keep = 2;/, 'unchanged lines stay as context');
  assert.equal(fs.readFileSync(path.join(workspaceDir(id), 'app.js'), 'utf8'), 'const a = 9;\nconst keep = 2;\n');
});

// ---------------------------------------------------------------------------
// PUT preview: dry runs never touch the disk
// ---------------------------------------------------------------------------
test('preview=1 returns the diff for an update without writing', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  fs.writeFileSync(path.join(workspaceDir(id), 'app.js'), 'before\n');

  const res = await api.put(id, 'app.js', 'after\n', { preview: '1' });
  assert.equal(res.status, 200);
  assert.equal(res.data.preview, true);
  assert.equal(res.data.action, 'update');
  assert.match(res.data.diff, /-before/);
  assert.match(res.data.diff, /\+after/);
  assert.equal(fs.readFileSync(path.join(workspaceDir(id), 'app.js'), 'utf8'), 'before\n',
    'preview must not modify the file');
});

test('preview=1 for a new file reports create and writes nothing', async () => {
  const api = await startServer();
  const id = await makeProject(api);

  const res = await api.put(id, 'fresh.js', 'hello\n', { preview: '1' });
  assert.equal(res.status, 200);
  assert.equal(res.data.preview, true);
  assert.equal(res.data.action, 'create');
  assert.match(res.data.diff, /\+hello/);
  assert.equal(fs.existsSync(path.join(workspaceDir(id), 'fresh.js')), false,
    'preview must not create the file');
  const history = await api.changes(id);
  assert.equal(history.data.changes.length, 0, 'preview records no history');
});

test('preview cannot approve a write that PUT would refuse (credentials)', async () => {
  const api = await startServer();
  const id = await makeProject(api);

  const preview = await api.put(id, '.env', 'SECRET=x\n', { preview: '1' });
  assert.equal(preview.status, 403);
  const write = await api.put(id, '.env', 'SECRET=x\n');
  assert.equal(write.status, 403);
  assert.equal(fs.existsSync(path.join(workspaceDir(id), '.env')), false);
});

// ---------------------------------------------------------------------------
// PUT validation: paths, bodies, guards
// ---------------------------------------------------------------------------
test('PUT rejects bad paths, bodies, and project ids', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  fs.mkdirSync(path.join(workspaceDir(id), 'src'));

  assert.equal((await api.putRaw(id, undefined, { content: 'x' })).status, 400, 'missing path');
  assert.equal((await api.putRaw(id, 'x.js', {})).status, 400, 'missing content');
  assert.equal((await api.putRaw(id, 'x.js', { content: 42 })).status, 400, 'non-string content');

  const traversal = await api.put(id, '../evil.js', 'escape');
  assert.equal(traversal.status, 403, 'traversal');
  assert.equal((await api.put(id, '..\\evil.js', 'escape')).status, 403, 'win traversal');
  assert.equal((await api.put(id, 'C:\\Windows\\win.ini', 'x')).status, 400, 'absolute path');
  assert.equal((await api.put(id, 'src\0.js', 'x')).status, 400, 'null byte');
  assert.equal((await api.put(id, 'src', 'x')).status, 400, 'directory target');
  assert.equal((await api.put(id, '.env', 'SECRET=1')).status, 403, 'credential file');
  assert.equal((await api.put(99999999, 'x.js', 'x')).status, 404, 'unknown project');
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
test('DELETE removes a file, returns its old text, and records history', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  const content = 'goodbye\n';
  fs.writeFileSync(path.join(workspaceDir(id), 'old.txt'), content);

  const res = await api.del(id, 'old.txt');
  assert.equal(res.status, 200);
  assert.equal(res.data.type, 'file');
  assert.equal(res.data.previous, content);
  assert.match(res.data.diff, /-goodbye/);
  assert.equal(fs.existsSync(path.join(workspaceDir(id), 'old.txt')), false);
  assert.equal((await api.readFile(id, 'old.txt')).status, 404, 'file is really gone');
});

test('DELETE refuses non-empty directories, the root, links out, and credentials', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  fs.mkdirSync(path.join(workspaceDir(id), 'src'));
  fs.writeFileSync(path.join(workspaceDir(id), 'src', 'keep.js'), 'keep\n');
  fs.writeFileSync(path.join(workspaceDir(id), '.env'), 'SECRET=1\n');

  assert.match((await api.del(id, 'src')).data.error, /not empty/i, 'non-empty dir stays');
  assert.equal((await api.del(id, '.')).status, 400, 'project root never deletable');
  assert.equal((await api.del(id, '../outside')).status, 403, 'traversal');
  assert.equal((await api.del(id, 'C:\\Windows')).status, 400, 'absolute');
  assert.equal((await api.del(id, '.env')).status, 403, 'credential file');
  assert.equal((await api.del(id, 'missing.txt')).status, 404, 'missing file');
  assert.equal(fs.existsSync(path.join(workspaceDir(id), 'src', 'keep.js')), true, 'nothing was removed');
});

test('DELETE removes an empty directory', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  fs.mkdirSync(path.join(workspaceDir(id), 'scratch'));

  const res = await api.del(id, 'scratch');
  assert.equal(res.status, 200);
  assert.equal(res.data.type, 'directory');
  assert.equal(fs.existsSync(path.join(workspaceDir(id), 'scratch')), false);
});

// ---------------------------------------------------------------------------
// Change history
// ---------------------------------------------------------------------------
test('change history lists create, update, and delete newest-first with diffs', async () => {
  const api = await startServer();
  const id = await makeProject(api);

  await api.put(id, 'log.txt', 'v1\n');
  await api.put(id, 'log.txt', 'v2\n');
  await api.del(id, 'log.txt');

  const { status, data } = await api.changes(id);
  assert.equal(status, 200);
  assert.equal(data.changes.length, 3);
  assert.deepEqual(data.changes.map((c) => c.action), ['delete', 'update', 'create'],
    'newest first');
  assert.ok(data.changes.every((c) => c.source === 'user'));
  assert.ok(data.changes.every((c) => typeof c.diff === 'string' && c.diff.includes('@@')));
  assert.ok(data.changes.every((c) => c.path === 'log.txt'));
  assert.ok(data.changes.every((c) => typeof c.created_at === 'string'));

  const limited = await api.changes(id, { limit: 1 });
  assert.equal(limited.data.changes.length, 1, 'limit is honored');
  assert.equal((await api.changes(99999999)).status, 404, 'unknown project');
});

// ---------------------------------------------------------------------------
// Agent proposals: staged -> listed with diff -> applied -> history
// ---------------------------------------------------------------------------
test('agent proposals carry diffs, list over HTTP, apply once, then disappear', async () => {
  const api = await startServer();
  const id = await makeProject(api);

  // Stage a create proposal through the app's own tools instance.
  const staged = await api.tools.execute('create_file', {
    projectId: id,
    path: 'proposed.js',
    content: 'export const staged = true;\n',
  });
  assert.equal(staged.status, 'awaiting_user_approval');
  assert.match(staged.diff, /--- a\/proposed\.js/);
  assert.match(staged.diff, /\+export const staged = true;/);
  assert.equal(fs.existsSync(path.join(workspaceDir(id), 'proposed.js')), false,
    'staging must not write the file');

  // The pending proposal is visible over HTTP with the same diff.
  const listed = await api.proposals(id);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.proposals.length, 1);
  assert.equal(listed.data.proposals[0].type, 'file');
  assert.equal(listed.data.proposals[0].action, 'create');
  assert.equal(listed.data.proposals[0].path, 'proposed.js');
  assert.equal(listed.data.proposals[0].diff, staged.diff);

  // Approval writes the file and records an agent-sourced change.
  const applied = await api.apply(id, staged.proposalId);
  assert.equal(applied.status, 201);
  assert.equal(applied.data.file.path, 'proposed.js');
  assert.match(applied.data.file.diff, /\+export const staged = true;/);
  assert.equal(fs.readFileSync(path.join(workspaceDir(id), 'proposed.js'), 'utf8'),
    'export const staged = true;\n');

  const history = await api.changes(id);
  assert.equal(history.data.changes[0].source, 'agent');
  assert.equal(history.data.changes[0].action, 'create');

  // Applied proposals are gone; re-applying returns 404.
  assert.equal((await api.proposals(id)).data.proposals.length, 0);
  assert.equal((await api.apply(id, staged.proposalId)).status, 404);
  assert.equal((await api.apply(id, 'no-such-proposal')).status, 404);
});

test('update proposals diff old vs new content and record an agent update', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  fs.writeFileSync(path.join(workspaceDir(id), 'config.js'), 'mode = "dev"\n');

  const staged = await api.tools.execute('propose_file_change', {
    projectId: id,
    path: 'config.js',
    content: 'mode = "prod"\n',
  });
  assert.equal(staged.status, 'awaiting_user_approval');
  assert.match(staged.diff, /-mode = "dev"/);
  assert.match(staged.diff, /\+mode = "prod"/);

  const applied = await api.apply(id, staged.proposalId);
  assert.equal(applied.status, 201);
  assert.equal(fs.readFileSync(path.join(workspaceDir(id), 'config.js'), 'utf8'), 'mode = "prod"\n');

  const history = await api.changes(id);
  assert.equal(history.data.changes[0].action, 'update');
  assert.equal(history.data.changes[0].source, 'agent');
});

// Automated tests for the project workspace: listing, reading, and
// path-safety (traversal / absolute paths / symlinks / size / binary).
// Usage: npm test   (runs: node --test)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import {
  createTextFile,
  MAX_READ_BYTES,
  readTextFile,
  scanDirectory,
  searchWorkspace,
  WorkspaceError,
} from '../src/workspace/files.js';

const servers = [];
const tempDirs = [];

async function startServer() {
  const server = createApp().app.listen(0);
  await once(server, 'listening');
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  return {
    async post(body) {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    },
    async get(id, queryPath) {
      const qs = new URLSearchParams();
      if (queryPath !== undefined) qs.set('path', queryPath);
      const res = await fetch(`${base}/${id}/files?${qs}`);
      let data = null;
      try {
        data = await res.json();
      } catch { /* non-JSON */ }
      return { status: res.status, data };
    },
    async readFile(id, queryPath) {
      const qs = new URLSearchParams();
      if (queryPath !== undefined) qs.set('path', queryPath);
      const res = await fetch(`${base}/${id}/file?${qs}`);
      let data = null;
      try {
        data = await res.json();
      } catch { /* non-JSON */ }
      return { status: res.status, data };
    },
    async getTree(id) {
      const res = await fetch(`${base}/${id}/tree`);
      return { status: res.status, data: await res.json() };
    },
    async search(id, query) {
      const res = await fetch(`${base}/${id}/search?q=${encodeURIComponent(query)}`);
      return { status: res.status, data: await res.json() };
    },
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

async function makeProject(api, name = 'Workspace Test Project') {
  const { status, data } = await api.post({ name });
  assert.equal(status, 201);
  return data.project.id;
}

// ---------------------------------------------------------------------------
// Project creation and workspace folder
// ---------------------------------------------------------------------------
test('creating a project creates its workspace folder', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  assert.ok(fs.existsSync(path.join(config.workspaceRoot, String(id))));
});

test('imports an existing directory as a project and scans searchable source files', async () => {
  const api = await startServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-existing-project-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export function answer() { return 42; }\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'ignored');

  const { status, data } = await api.post({ name: 'Imported project', path: root });
  assert.equal(status, 201);
  const tree = await api.getTree(data.project.id);
  assert.equal(tree.status, 200);
  assert.deepEqual(tree.data.files, ['src/index.js']);
  const search = await api.search(data.project.id, 'answer');
  assert.equal(search.status, 200);
  assert.equal(search.data.results[0].path, 'src/index.js');
});

// ---------------------------------------------------------------------------
// Listing and reading (happy path)
// ---------------------------------------------------------------------------
test('lists the project root with fixtures', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  const dir = path.join(config.workspaceRoot, String(id));

  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n');

  const { status, data } = await api.get(id);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.path, '.');
  const names = data.items.map((i) => i.name).sort();
  assert.deepEqual(names, ['README.md', 'index.js', 'src']);
  const src = data.items.find((i) => i.name === 'src');
  assert.equal(src.type, 'directory');
  const index = data.items.find((i) => i.name === 'index.js');
  assert.equal(index.type, 'file');
  assert.equal(index.size, 'export const x = 1;\n'.length);
  // directories sort first
  assert.equal(data.items[0].type, 'directory');
});

test('lists a subdirectory', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  const dir = path.join(config.workspaceRoot, String(id));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(1);\n');

  const { status, data } = await api.get(id, 'src');
  assert.equal(status, 200);
  assert.equal(data.path, 'src');
  assert.deepEqual(data.items.map((i) => i.name), ['app.js']);
});

test('reads a file with exact content', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  const dir = path.join(config.workspaceRoot, String(id));
  fs.mkdirSync(path.join(dir, 'src'));
  const content = 'function add(a, b) {\n  return a + b;\n}\n';
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), content);

  const { status, data } = await api.readFile(id, 'src/math.js');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.path, 'src/math.js');
  assert.equal(data.content, content);
});

// ---------------------------------------------------------------------------
// Path-safety: traversal, absolute paths, weird input
// ---------------------------------------------------------------------------
test('rejects path traversal attempts (403)', async () => {
  const api = await startServer();
  const id = await makeProject(api);

  const attacks = [
    '../',
    '../../package.json',
    '../../../../Windows/win.ini',
    'src/../../../.env.example',
    '..',
  ];
  for (const attack of attacks) {
    const listed = await api.get(id, attack);
    assert.equal(listed.status, 403, `list "${attack}" should be 403`);
    assert.equal(listed.data.ok, false);
    const read = await api.readFile(id, attack);
    assert.equal(read.status, 403, `read "${attack}" should be 403`);
  }
});

test('rejects absolute paths (400)', async () => {
  const api = await startServer();
  const id = await makeProject(api);

  for (const attack of ['C:\\Windows\\win.ini', 'C:/Windows/win.ini', '/etc/passwd', '\\\\server\\share\\x']) {
    const read = await api.readFile(id, attack);
    assert.equal(read.status, 400, `read "${attack}" should be 400`);
    assert.match(read.data.error, /relative|absolute/i);
  }
});

test('rejects null bytes and non-string paths (400)', async () => {
  const api = await startServer();
  const id = await makeProject(api);

  const nul = await api.readFile(id, 'index.js\0.png');
  assert.equal(nul.status, 400);
  const missing = await api.readFile(id, '');
  assert.equal(missing.status, 400);
  const noPath = await api.readFile(id, undefined);
  assert.equal(noPath.status, 400);
});

test('harmless relative paths that stay inside are allowed', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  const dir = path.join(config.workspaceRoot, String(id));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'ok.js'), 'ok\n');

  const { status, data } = await api.readFile(id, 'src/../src/ok.js');
  assert.equal(status, 200);
  assert.equal(data.content, 'ok\n');
});

// ---------------------------------------------------------------------------
// Missing targets and bad ids
// ---------------------------------------------------------------------------
test('missing file -> 404, missing directory -> 404, bad project id -> 404', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  fs.mkdirSync(path.join(config.workspaceRoot, String(id), 'src')); // exists, but is a directory

  const noFile = await api.readFile(id, 'does-not-exist.txt');
  assert.equal(noFile.status, 404);
  const noDir = await api.get(id, 'no-such-dir');
  assert.equal(noDir.status, 404);
  const badId = await api.get(99999999);
  assert.equal(badId.status, 404);
  const notANumber = await api.get('abc');
  assert.equal(notANumber.status, 404);
  const readDir = await api.readFile(id, 'src');
  assert.equal(readDir.status, 400); // exists but is a directory
});

// ---------------------------------------------------------------------------
// Size and binary guards
// ---------------------------------------------------------------------------
test('rejects files larger than the read limit (413)', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  const dir = path.join(config.workspaceRoot, String(id));
  fs.writeFileSync(path.join(dir, 'big.txt'), Buffer.alloc(MAX_READ_BYTES + 1, 0x61));

  const { status, data } = await api.readFile(id, 'big.txt');
  assert.equal(status, 413);
  assert.match(data.error, /too large/i);
});

test('rejects binary files (415)', async () => {
  const api = await startServer();
  const id = await makeProject(api);
  const dir = path.join(config.workspaceRoot, String(id));
  fs.writeFileSync(path.join(dir, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

  const { status, data } = await api.readFile(id, 'image.bin');
  assert.equal(status, 415);
  assert.match(data.error, /binary/i);
});

// ---------------------------------------------------------------------------
// Symlink/junction escape - the real-world bypass attempt
// ---------------------------------------------------------------------------
test('blocks reads through a symlink pointing outside the workspace', async (t) => {
  const api = await startServer();
  const id = await makeProject(api);
  const projectDirPath = path.join(config.workspaceRoot, String(id));

  // An "outside" directory holding a secret file.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-outside-'));
  tempDirs.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');

  let linkCreated = false;
  try {
    fs.symlinkSync(outside, path.join(projectDirPath, 'escape'), 'junction');
    linkCreated = true;
  } catch {
    t.diagnostic('symlink/junction creation not permitted on this system - link test skipped');
  }
  if (!linkCreated) return;

  const read = await api.readFile(id, 'escape/secret.txt');
  assert.equal(read.status, 403, 'reading through an escaping link must be 403');
  assert.ok(!JSON.stringify(read.data).includes('TOP SECRET'));
});

test('scanner excludes dependency, build, and credential files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-scan-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'function greet() {}\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=hidden');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'ignored.js'), 'ignored');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'ignored');
  fs.writeFileSync(path.join(root, 'dist', 'built.js'), 'ignored');

  const scan = scanDirectory(root);
  assert.deepEqual(scan.files, ['src/app.js']);
  assert.equal(searchWorkspace(root, 'greet').results[0].path, 'src/app.js');
  assert.throws(() => readTextFile(root, '.env'), (error) => error instanceof WorkspaceError && error.status === 403);
});

test('new-file proposals are path-safe and never overwrite existing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-create-'));
  tempDirs.push(root);
  const created = createTextFile(root, 'new.js', 'export const answer = 42;\n');
  assert.equal(created.path, 'new.js');
  assert.equal(fs.readFileSync(path.join(root, 'new.js'), 'utf8'), 'export const answer = 42;\n');
  assert.throws(() => createTextFile(root, 'new.js', 'overwrite'), /already exists/);
  assert.throws(() => createTextFile(root, '../outside.js', 'escape'), /escapes/);
  assert.throws(() => createTextFile(root, '.env', 'SECRET=x'), /credential/);
});

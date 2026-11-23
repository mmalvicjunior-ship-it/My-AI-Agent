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
import { config, redactSecrets } from '../src/config.js';
import {
  createTextFile,
  isSensitiveFile,
  MAX_READ_BYTES,
  MAX_SCAN_FILES,
  readTextFile,
  scanDirectory,
  searchWorkspace,
  WorkspaceError,
} from '../src/workspace/files.js';

const servers = [];
const tempDirs = [];

async function startServer() {
  // Imported fixtures live in the OS temp directory; allow that as the safe
  // import root while keeping the managed workspace root off-limits.
  const server = createApp({ auth: false, projectImportRoot: os.tmpdir() }).app.listen(0);
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
  fs.writeFileSync(path.join(dir, '..notes'), 'dots\n');

  const { status, data } = await api.readFile(id, 'src/../src/ok.js');
  assert.equal(status, 200);
  assert.equal(data.content, 'ok\n');

  // A real filename beginning with two dots is not a traversal attempt.
  const dotted = await api.readFile(id, '..notes');
  assert.equal(dotted.status, 200);
  assert.equal(dotted.data.content, 'dots\n');
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

test('scanner recursively maps the workspace with the real result shape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-map-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'server', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'server', 'services'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  for (const file of [
    'package.json',
    'src/index.js',
    'src/components/Button.tsx',
    'server/routes/auth.js',
    'server/services/authService.js',
    'tests/auth.test.js',
    'docs/README.md',
  ]) {
    fs.writeFileSync(path.join(root, file), 'export default {};\n');
  }

  const scan = scanDirectory(root);
  assert.deepEqual(scan.files, [
    'docs/README.md',
    'package.json',
    'server/routes/auth.js',
    'server/services/authService.js',
    'src/components/Button.tsx',
    'src/index.js',
    'tests/auth.test.js',
  ]);
  assert.deepEqual(scan.manifests, ['package.json']);
  assert.ok(scan.directories.includes('src/components'));
  assert.ok(scan.projectMap.entryPoints.includes('src/index.js'));
  assert.ok(scan.projectMap.routes.includes('server/routes/auth.js'));
  assert.ok(scan.projectMap.components.includes('src/components/Button.tsx'));
  assert.ok(scan.projectMap.services.includes('server/services/authService.js'));
  assert.ok(scan.projectMap.tests.includes('tests/auth.test.js'));
  assert.ok(scan.projectMap.docs.includes('docs/README.md'));
  assert.ok(scan.languageHints.includes('JavaScript'));
  assert.ok(scan.languageHints.includes('TypeScript'));
  assert.ok(scan.frameworkHints.includes('React'));
  assert.deepEqual(scan.projectTypes, ['Node.js']);
  assert.equal(scan.skipped, 0);
  assert.deepEqual(scan.errors, []);
  assert.equal(scan.truncated, false);
  assert.deepEqual(scan.limits, {
    maxFiles: MAX_SCAN_FILES,
    maxDepth: 12,
    maxDirectories: 1000,
    maxHintsPerCategory: 25,
  });
});

test('root .gitignore is applied without exposing its contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-gitignore-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'generated'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '# comment\n*.log\n!important.log\ngenerated/\n/root-only.txt\n');
  for (const file of [
    'debug.log',
    'important.log',
    'generated/gen.js',
    'root-only.txt',
    'src/root-only.txt',
    'src/app.js',
  ]) {
    fs.writeFileSync(path.join(root, file), 'ok\n');
  }

  const scan = scanDirectory(root);
  assert.ok(scan.files.includes('.gitignore'));
  assert.ok(scan.files.includes('important.log'));
  assert.ok(scan.files.includes('src/root-only.txt'));
  assert.ok(scan.files.includes('src/app.js'));
  assert.equal(scan.files.includes('debug.log'), false);
  assert.equal(scan.files.includes('generated/gen.js'), false);
  assert.equal(scan.files.includes('root-only.txt'), false);
  assert.equal(JSON.stringify(scan).includes('# comment'), false);
});

test('credential filtering is precise and keeps false-positive source paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-credentials-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'token-service'), { recursive: true });
  fs.mkdirSync(path.join(root, 'credentials'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const allowed = [
    'src/tokens.js',
    'token-service/auth.js',
    'src/passwordReset.js',
    'docs/credentials.md',
    'credentials/notes.txt',
  ];
  const denied = [
    '.env',
    'config.env.local',
    'client_secret.json',
    'id_ed25519',
    'server.key',
    'secrets.txt',
    'secrets.conf',
    'credentials.json',
    'api_secret.txt',
    '.npmrc',
    'token',
    'password',
    'db_password',
  ];
  for (const file of [...allowed, ...denied]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'value\n');
  }

  const scan = scanDirectory(root);
  for (const file of allowed) assert.ok(scan.files.includes(file), `${file} should be scanned`);
  for (const file of denied) assert.equal(scan.files.includes(file), false, `${file} must be excluded`);
  assert.equal(isSensitiveFile('src/tokens.js'), false);
  assert.equal(isSensitiveFile('token-service'), false);
  assert.equal(isSensitiveFile('client_secret.json'), true);
  assert.equal(isSensitiveFile('api_secret.txt'), true);
  assert.equal(isSensitiveFile('.env.production'), true);
  assert.equal(isSensitiveFile('token'), true);
  assert.equal(isSensitiveFile('password'), true);
  assert.equal(isSensitiveFile('db_password'), true);
  assert.equal(isSensitiveFile('secrets.conf'), true);
  assert.ok(scan.skipped >= denied.length);
});

test('read_file and search_files redact embedded credentials before model context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-redaction-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const secrets = [
    'sk-test-secret-key-1234567890',
    'clientSecretValue123456',
    'eyJabc1234567890.defghijklmnop.qrs1234567890',
    'Authorization: Bearer abcdefghijklmnopqrst',
  ];
  fs.writeFileSync(path.join(root, 'src', 'config.js'), [
    `const apiKey = "${secrets[0]}";`,
    `const clientSecret = "${secrets[1]}";`,
    `const token = "${secrets[2]}";`,
    `const header = "${secrets[3]}";`,
    'export const answer = 42;',
  ].join('\n'));

  const read = readTextFile(root, 'src/config.js');
  assert.equal(read.redacted, true);
  for (const secret of secrets) {
    assert.equal(read.content.includes(secret), false, `${secret} must be redacted`);
  }
  assert.match(read.content, /answer = 42/);

  const secretSearch = searchWorkspace(root, secrets[0]);
  assert.deepEqual(secretSearch.results, []);
  const normalSearch = searchWorkspace(root, 'answer');
  assert.equal(normalSearch.results[0].path, 'src/config.js');
  for (const secret of secrets) {
    assert.equal(JSON.stringify(normalSearch).includes(secret), false);
  }
});

test('reviewer credential formats are redacted before read_file and search_files results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-reviewer-redaction-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const secrets = [
    'hunter2',
    'abcdef123456',
    's3cr3tValue123456',
    'dbSecretValue123456',
  ];
  fs.writeFileSync(path.join(root, 'src', 'reviewer-secrets.js'), [
    `password: ${secrets[0]}`,
    `password = ${secrets[0]}`,
    `token: ${secrets[1]}`,
    `token = ${secrets[1]}`,
    `secret: ${secrets[2]}`,
    `secret = ${secrets[2]}`,
    `db_password: ${secrets[3]}`,
    `db_password = ${secrets[3]}`,
    'export const answer = 42;',
  ].join('\n'));

  const read = readTextFile(root, 'src/reviewer-secrets.js');
  const readResult = JSON.stringify(read);
  assert.equal(read.redacted, true);
  assert.ok(readResult.includes('[redacted]'));
  assert.match(read.content, /answer = 42/);
  for (const secret of secrets) {
    assert.equal(readResult.includes(secret), false, `read_file leaked ${secret}`);
  }

  const search = searchWorkspace(root, 'password');
  const searchResult = JSON.stringify(search);
  assert.ok(search.results.length > 0);
  assert.ok(searchResult.includes('[redacted]'));
  for (const secret of secrets) {
    assert.equal(searchResult.includes(secret), false, `search_files leaked ${secret}`);
  }
});

test('config redaction handles spaces around credential separators', () => {
  assert.equal(redactSecrets('PASSWORD = spacedPassword123'), 'PASSWORD = [redacted]');
  assert.equal(redactSecrets('TOKEN : spacedToken123'), 'TOKEN : [redacted]');
  assert.equal(redactSecrets('SECRET=spacedSecret123'), 'SECRET=[redacted]');
  assert.equal(redactSecrets('DB_PASSWORD = dbSpaced123'), 'DB_PASSWORD = [redacted]');
});

test('scan limits are reported and never presented as complete', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-limits-'));
  tempDirs.push(root);
  for (let index = 0; index < 4; index += 1) {
    fs.writeFileSync(path.join(root, `file-${index}.js`), 'ok\n');
  }
  const counted = scanDirectory(root, '.', { maxFiles: 2 });
  assert.equal(counted.files.length, 2);
  assert.equal(counted.truncated, true);
  assert.equal(counted.limits.maxFiles, 2);
  assert.ok(counted.skipped >= 2);

  fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'deep.js'), 'deep\n');
  const limitedDepth = scanDirectory(root, '.', { maxDepth: 1 });
  assert.equal(limitedDepth.files.includes('a/b/c/deep.js'), false);
  assert.equal(limitedDepth.truncated, true);
  assert.equal(limitedDepth.limits.maxDepth, 1);
});

test('oversized root .gitignore is ignored with a reported error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-bigignore-'));
  tempDirs.push(root);
  fs.writeFileSync(path.join(root, '.gitignore'), Buffer.alloc(64 * 1024 + 1, 0x61));
  fs.writeFileSync(path.join(root, 'app.js'), 'ok\n');
  const scan = scanDirectory(root);
  assert.ok(scan.files.includes('app.js'));
  assert.ok(scan.files.includes('.gitignore'));
  assert.equal(scan.errors.length, 1);
  assert.match(scan.errors[0], /exceeds/);
  assert.equal(scan.truncated, false);
});

test('scanner skips symlinked directories without following them outside the workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-scan-link-'));
  tempDirs.push(root);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-scan-outside-'));
  tempDirs.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET SCAN');
  fs.writeFileSync(path.join(root, 'app.js'), 'ok\n');

  let linkCreated = false;
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
    linkCreated = true;
  } catch {
    t.diagnostic('symlink/junction creation not permitted on this system - scan link test skipped');
  }
  if (!linkCreated) return;

  const scan = scanDirectory(root);
  assert.deepEqual(scan.files, ['app.js']);
  assert.equal(JSON.stringify(scan).includes('TOP SECRET SCAN'), false);
});

test('symlinked root .gitignore is rejected without following the link', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-gitignore-link-'));
  tempDirs.push(root);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-gitignore-outside-'));
  tempDirs.push(outside);
  fs.writeFileSync(path.join(outside, '.gitignore'), '*.js\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'ok\n');

  let linkCreated = false;
  try {
    fs.symlinkSync(path.join(outside, '.gitignore'), path.join(root, '.gitignore'), 'file');
    linkCreated = true;
  } catch {
    t.diagnostic('symlink creation not permitted on this system - .gitignore symlink test skipped');
  }
  if (!linkCreated) return;

  const scan = scanDirectory(root);
  assert.ok(scan.files.includes('app.js'), 'external .gitignore patterns must not be applied');
  assert.equal(scan.files.includes('.gitignore'), false, 'the symlink itself is skipped');
  assert.deepEqual(scan.errors, []);
});

test('scanning and searching never modify workspace files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-readonly-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const answer = 42;\n');
  const snapshot = (directory) => fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return { name: entry.name, type: 'directory', children: snapshot(absolute) };
    return { name: entry.name, type: 'file', content: fs.readFileSync(absolute, 'utf8') };
  });
  const before = snapshot(root);

  scanDirectory(root);
  searchWorkspace(root, 'answer');

  assert.deepEqual(snapshot(root), before);
});

// Authorization tests: one account must never reach another account's
// projects, files, proposals, commands, or tasks. Also verifies that imported
// server paths are confined to PROJECT_IMPORT_ROOT (disabled by default).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { createTask, savePlan } from '../src/tasks/store.js';

const tempDirs = [];
let server;
let db;
let tools;
let base;
let importRoot;
let outsideDir;
let alice;
let bob;
let aliceProject;
let bobProject;
let bobTask;
let bobProposal;

async function request(method, pathname, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + pathname, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, data };
}

async function register(email) {
  const { status, data } = await request('POST', '/api/auth/register', {
    body: { email, password: 'correct-horse-battery', bootstrapToken: 'test-bootstrap-token' },
  });
  assert.equal(status, 201, `could not register ${email}: ${JSON.stringify(data)}`);
  return data;
}

async function createProject(token, name) {
  const { status, data } = await request('POST', '/api/projects', { token, body: { name } });
  assert.equal(status, 201, `could not create ${name}: ${JSON.stringify(data)}`);
  return data.project.id;
}

before(async () => {
  importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-authz-import-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-authz-outside-'));
  tempDirs.push(importRoot, outsideDir);
  fs.mkdirSync(path.join(importRoot, 'allowed'));

  const seen = [];
  const spyProvider = {
    name: 'spy',
    model: 'spy-1',
    async chat({ tools: offeredTools, projectId }) {
      seen.push({ hasTools: Boolean(offeredTools), projectId });
      return { text: 'ok', provider: 'spy', model: 'spy-1' };
    },
  };
  globalThis.__authzSeen = seen;

  const created = createApp({ provider: spyProvider, projectImportRoot: importRoot });
  db = created.db;
  tools = created.tools;
  server = created.app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  alice = await register('alice-authz@example.com');
  bob = await register('bob-authz@example.com');

  aliceProject = await createProject(alice.token, 'Alice project');
  bobProject = await createProject(bob.token, 'Bob project');

  bobTask = createTask(db, { projectId: bobProject, instruction: 'Read the workspace' });
  bobProposal = tools.stageFileChange({
    projectId: bobProject,
    kind: 'create',
    path: 'private.js',
    content: 'export const secret = true;\n',
  });
  savePlan(db, bobTask.id, {
    version: 1,
    summary: 'Waiting for approval',
    proposals: [{ id: bobProposal.id }],
    currentStep: 0,
    repairAttempt: 0,
  });
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test('project listings are scoped to the authenticated owner', async () => {
  const a = await request('GET', '/api/projects', { token: alice.token });
  assert.equal(a.status, 200);
  const aIds = a.data.projects.map((project) => project.id);
  assert.ok(aIds.includes(aliceProject));
  assert.ok(!aIds.includes(bobProject));

  const b = await request('GET', '/api/projects', { token: bob.token });
  const bIds = b.data.projects.map((project) => project.id);
  assert.ok(bIds.includes(bobProject));
  assert.ok(!bIds.includes(aliceProject));
});

test('a user cannot read another user project files, tree, search, history, or proposals', async () => {
  const paths = [
    `/api/projects/${bobProject}/files`,
    `/api/projects/${bobProject}/file?path=private.js`,
    `/api/projects/${bobProject}/tree`,
    `/api/projects/${bobProject}/search?q=secret`,
    `/api/projects/${bobProject}/changes`,
    `/api/projects/${bobProject}/proposals`,
  ];
  for (const pathname of paths) {
    const { status, data } = await request('GET', pathname, { token: alice.token });
    assert.equal(status, 404, `GET ${pathname} must not reveal another user's project`);
    assert.equal(data.ok, false);
  }
});

test('a user cannot write or delete files in another user project', async () => {
  const target = path.join(config.workspaceRoot, String(bobProject), 'owned.js');

  const write = await request('PUT', `/api/projects/${bobProject}/file?path=owned.js`, {
    token: alice.token,
    body: { content: 'overwritten\n' },
  });
  assert.equal(write.status, 404);
  assert.equal(fs.existsSync(target), false, 'no foreign file may be written');

  const remove = await request('DELETE', `/api/projects/${bobProject}/file?path=private.js`, {
    token: alice.token,
  });
  assert.equal(remove.status, 404);
});

test('a user cannot apply, reject, or run another user proposals and commands', async () => {
  const proposalId = bobProposal.id;
  const apply = await request('POST', `/api/projects/${bobProject}/proposals/${proposalId}/apply`, {
    token: alice.token,
  });
  assert.equal(apply.status, 404);

  const reject = await request('POST', `/api/projects/${bobProject}/proposals/${proposalId}/reject`, {
    token: alice.token,
  });
  assert.equal(reject.status, 404);

  const run = await request('POST', `/api/projects/${bobProject}/commands/${proposalId}/run`, {
    token: alice.token,
  });
  assert.equal(run.status, 404);

  // Bob still owns the untouched pending proposal.
  const bobList = await request('GET', `/api/projects/${bobProject}/proposals`, { token: bob.token });
  assert.equal(bobList.status, 200);
  assert.ok(bobList.data.proposals.some((proposal) => proposal.proposalId === proposalId));
});

test('a user cannot create, list, inspect, or cancel another user tasks', async () => {
  const create = await request('POST', '/api/tasks', {
    token: alice.token,
    body: { projectId: bobProject, instruction: 'Do something in Bob workspace' },
  });
  assert.equal(create.status, 404);

  const list = await request('GET', '/api/tasks', { token: alice.token });
  assert.equal(list.status, 200);
  assert.ok(!list.data.tasks.some((task) => task.id === bobTask.id));

  const detail = await request('GET', `/api/tasks/${bobTask.id}`, { token: alice.token });
  assert.equal(detail.status, 404);

  const cancel = await request('POST', `/api/tasks/${bobTask.id}/cancel`, { token: alice.token });
  assert.equal(cancel.status, 404);

  // The owner still sees the same task.
  const owned = await request('GET', `/api/tasks/${bobTask.id}`, { token: bob.token });
  assert.equal(owned.status, 200);
  assert.equal(owned.data.task.id, bobTask.id);
});

test("a user cannot read another user's task proposal projection", async () => {
  const foreign = await request('GET', `/api/tasks/${bobTask.id}`, { token: alice.token });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.ok, false);
  assert.equal('proposals' in foreign.data, false);

  const owned = await request('GET', `/api/tasks/${bobTask.id}`, { token: bob.token });
  assert.equal(owned.status, 200);
  assert.equal(owned.data.proposals.length, 1);
  assert.equal(owned.data.proposals[0].proposalId, bobProposal.id);
  assert.equal(owned.data.proposals[0].status, 'pending');
});

test('chat does not arm workspace tools for another user project', async () => {
  const seen = globalThis.__authzSeen;
  const foreign = await request('POST', '/api/chat', {
    token: alice.token,
    body: { message: 'hi', projectId: bobProject },
  });
  assert.equal(foreign.status, 200);
  assert.deepEqual(seen.at(-1), { hasTools: false, projectId: null });

  const own = await request('POST', '/api/chat', {
    token: alice.token,
    body: { message: 'hi', projectId: aliceProject },
  });
  assert.equal(own.status, 200);
  assert.deepEqual(seen.at(-1), { hasTools: true, projectId: aliceProject });
});

test('imports outside the configured safe root are rejected', async () => {
  const outside = await request('POST', '/api/projects', {
    token: alice.token,
    body: { name: 'Outside import', path: outsideDir },
  });
  assert.equal(outside.status, 403);
  assert.match(outside.data.error, /import root/i);

  const relative = await request('POST', '/api/projects', {
    token: alice.token,
    body: { name: 'Relative import', path: 'relative/path' },
  });
  assert.equal(relative.status, 400);

  const missing = await request('POST', '/api/projects', {
    token: alice.token,
    body: { name: 'Missing import', path: path.join(importRoot, 'does-not-exist') },
  });
  assert.equal(missing.status, 404);
});

test('imports inside the configured safe root succeed', async () => {
  const { status, data } = await request('POST', '/api/projects', {
    token: alice.token,
    body: { name: 'Allowed import', path: path.join(importRoot, 'allowed') },
  });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
});

test('import paths that are ancestors of the managed workspace root are rejected', async () => {
  // The test environment places WORKSPACE_ROOT somewhere under os.tmpdir().
  // Importing os.tmpdir() would therefore be an ancestor of every managed
  // workspace and must be rejected, even though it is not inside the workspace.
  const broad = createApp({ provider: null, projectImportRoot: os.tmpdir() });
  const broadServer = broad.app.listen(0);
  await once(broadServer, 'listening');
  const broadBase = `http://127.0.0.1:${broadServer.address().port}`;
  try {
    const res = await fetch(`${broadBase}/api/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ name: 'Workspace ancestor', path: os.tmpdir() }),
    });
    const data = await res.json();
    assert.equal(res.status, 403);
    assert.match(data.error, /ancestor of the managed workspace root/i);
  } finally {
    broadServer.closeAllConnections?.();
    broadServer.close();
  }
});

test('import paths that are ancestors of the database directory are rejected', async () => {
  // A dedicated nested DB path, unrelated to the workspace root, so the
  // database-ancestor check fires before (and independently from) the
  // workspace-ancestor check.
  const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-f3-db-ancestor-'));
  tempDirs.push(dbRoot);
  const dbSub = path.join(dbRoot, 'nested', 'database-dir');
  fs.mkdirSync(dbSub, { recursive: true });
  const originalDatabasePath = config.databasePath;
  const originalWorkspaceRoot = config.workspaceRoot;
  try {
    config.databasePath = path.join(dbSub, 'app.db');
    config.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-f3-ws-'));

    const broad = createApp({ provider: null, projectImportRoot: os.tmpdir() });
    const broadServer = broad.app.listen(0);
    await once(broadServer, 'listening');
    const broadBase = `http://127.0.0.1:${broadServer.address().port}`;
    const dbDir = path.dirname(config.databasePath);
    try {
      // Register a fresh user on this app so the request is authenticated.
      const reg = await fetch(`${broadBase}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'db-ancestor@example.com', password: 'correct-horse-battery', bootstrapToken: 'test-bootstrap-token' }),
      });
      const regData = await reg.json();
      assert.equal(reg.status, 201);
      const token = regData.token;

      const res = await fetch(`${broadBase}/api/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: 'DB ancestor', path: dbDir }),
      });
      const data = await res.json();
      assert.equal(res.status, 403);
      assert.match(data.error, /ancestor of the database directory/i);
    } finally {
      broadServer.closeAllConnections?.();
      broadServer.close();
    }
  } finally {
    config.databasePath = originalDatabasePath;
    config.workspaceRoot = originalWorkspaceRoot;
  }
});

test('import paths inside the managed workspace root are rejected', async () => {
  const broad = createApp({ provider: null, projectImportRoot: os.tmpdir() });
  const broadServer = broad.app.listen(0);
  await once(broadServer, 'listening');
  const broadBase = `http://127.0.0.1:${broadServer.address().port}`;
  try {
    const inside = path.join(config.workspaceRoot, String(aliceProject));
    const res = await fetch(`${broadBase}/api/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ name: 'Workspace child', path: inside }),
    });
    const data = await res.json();
    assert.equal(res.status, 403);
    assert.match(data.error, /workspace root/i);
  } finally {
    broadServer.closeAllConnections?.();
    broadServer.close();
  }
});

test('the managed workspace tree can never be imported, even from a broad import root', async () => {
  // A broad import root (the OS temp directory) still must not expose the
  // workspace tree that contains every user's project files.
  const broad = createApp({ provider: null, projectImportRoot: os.tmpdir() });
  const broadServer = broad.app.listen(0);
  await once(broadServer, 'listening');
  const broadBase = `http://127.0.0.1:${broadServer.address().port}`;
  try {
    const res = await fetch(`${broadBase}/api/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({
        name: 'Workspace import',
        path: path.join(config.workspaceRoot, String(bobProject)),
      }),
    });
    const data = await res.json();
    assert.equal(res.status, 403);
    assert.match(data.error, /workspace root/i);
  } finally {
    broadServer.closeAllConnections?.();
    broadServer.close();
  }
});

test('imports are disabled when PROJECT_IMPORT_ROOT is not configured', async () => {
  const strict = createApp({ provider: null, projectImportRoot: '' });
  const strictServer = strict.app.listen(0);
  await once(strictServer, 'listening');
  const strictBase = `http://127.0.0.1:${strictServer.address().port}`;
  try {
    const res = await fetch(`${strictBase}/api/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ name: 'Disabled import', path: importRoot }),
    });
    const data = await res.json();
    assert.equal(res.status, 403);
    assert.match(data.error, /disabled/i);
  } finally {
    strictServer.closeAllConnections?.();
    strictServer.close();
  }
});

// End-to-end object-storage integration tests. Everything runs locally:
// PGlite for SQL and an in-memory S3 stand-in for workspace files. No Neon,
// Render, Vercel, or production resource is contacted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { authorizeFirstAccount } from './setup-authorization.mjs';

const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-import-'));
process.env.PROJECT_IMPORT_ROOT = importRoot;
process.env.DATABASE_BACKEND = 'pglite';
process.env.WORKSPACE_STORAGE = 'memory';
process.env.AI_PROVIDER = 'openai';
process.env.AI_API_KEY = 'test-openrouter-key';
process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
process.env.AI_MODEL = 'test-openrouter-model';
process.env.GOOGLE_CLIENT_ID = 'test-google-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.test/api/auth/google/callback';

const { createApp } = await import('../src/index.js');
const { config, safeSummary, redactSecrets } = await import('../src/config.js');
const { getWorkspaceDriver } = await import('../src/workspace/storage-driver.js');
const { createS3Client } = await import('../src/storage/s3-client.js');
const { createStorageBridge } = await import('../src/storage/bridge.js');
const { isDuplicateEmailError } = await import('../src/routes/auth.js');

// The real OpenRouter-compatible adapter is constructed from test-only config,
// but no chat request is made, so no provider network call occurs.
const created = createApp();
const { app, db, tools } = created;
const driver = getWorkspaceDriver();
const server = app.listen(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

let token = '';

async function request(method, urlPath, { body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + urlPath, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, data };
}

after(() => {
  server.closeAllConnections?.();
  server.close();
  try { driver.close(); } catch { /* best effort */ }
  try { db.close(); } catch { /* best effort */ }
  try { fs.rmSync(importRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

function changeCount(projectId, filePath) {
  return db.prepare('SELECT COUNT(*) AS n FROM file_changes WHERE project_id = ? AND path = ?')
    .get(projectId, filePath).n;
}

test('storage configuration is explicit, summarized safely, and redacted', () => {
  assert.equal(config.databaseBackend, 'pglite');
  assert.equal(config.workspaceStorage, 'memory');
  const summary = JSON.stringify(safeSummary());
  assert.ok(!summary.includes('test-google-secret'));
  assert.ok(!summary.includes('test-openrouter-key'));
  const redacted = redactSecrets(
    'DATABASE_URL=postgres://user:pass@db.test/db WORKSPACE_S3_SECRET_KEY=supersecret',
  );
  assert.ok(!redacted.includes('pass@db.test'));
  assert.ok(!redacted.includes('supersecret'));
});

test('OpenRouter-compatible configuration is reported without using the network', async () => {
  const { status, data } = await request('GET', '/api/health', { auth: false });
  assert.equal(status, 200);
  assert.equal(data.aiProvider, 'openai');
  assert.match(data.providers.openai.label, /OpenRouter/);
  assert.equal(data.providers.openai.configured, true);
});

test('first account registration, login, session verification and logout use Postgres', async () => {
  const setupToken = await authorizeFirstAccount(base);
  const registered = await request('POST', '/api/auth/register', {
    auth: false,
    body: {
      email: 'storage-user@example.test',
      password: 'correct-horse-battery',
      setupToken,
    },
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.user.isAdmin, false, 'public registration is always ordinary');
  token = registered.data.token;

  const me = await request('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'storage-user@example.test');

  const login = await request('POST', '/api/auth/login', {
    auth: false,
    body: { email: 'storage-user@example.test', password: 'correct-horse-battery' },
  });
  assert.equal(login.status, 200);
  const registeredToken = token;
  token = login.data.token;
  const logout = await request('POST', '/api/auth/logout');
  assert.equal(logout.status, 200);
  const loggedOut = await request('GET', '/api/auth/me');
  assert.equal(loggedOut.status, 401);
  // Keep the still-valid registration token for the remaining tests.
  token = registeredToken;
});

test('Google OAuth configuration and authorization initiation work with Postgres', async () => {
  const response = await request('POST', '/api/auth/google/start', { body: {} });
  assert.equal(response.status, 200);
  const url = new URL(response.data.url);
  assert.equal(url.searchParams.get('client_id'), config.googleClientId);
  assert.equal(url.searchParams.get('redirect_uri'), config.googleRedirectUri);
  assert.ok(url.searchParams.get('state'));
});

test('projects and workspace files are persisted through the object-storage driver', async () => {
  const createdProject = await request('POST', '/api/projects', { body: { name: 'Object storage project' } });
  assert.equal(createdProject.status, 201);
  const id = createdProject.data.project.id;

  const query = (p) => `?${new URLSearchParams({ path: p })}`;
  const written = await request('PUT', `/api/projects/${id}/file${query('src/app.js')}`, {
    body: { content: 'export const answer = 42;\n' },
  });
  assert.equal(written.status, 201);
  assert.equal(written.data.action, 'create');

  const read = await request('GET', `/api/projects/${id}/file${query('src/app.js')}`);
  assert.equal(read.status, 200);
  assert.equal(read.data.content, 'export const answer = 42;\n');

  const listed = await request('GET', `/api/projects/${id}/files?path=src`);
  assert.equal(listed.status, 200);
  assert.ok(listed.data.items.some((entry) => entry.name === 'app.js'));

  const tree = await request('GET', `/api/projects/${id}/tree`);
  assert.ok(tree.data.files.includes('src/app.js'));

  const search = await request('GET', `/api/projects/${id}/search?q=answer`);
  assert.ok(search.data.results.some((entry) => entry.path === 'src/app.js'));

  assert.equal(driver.readObject(id, 'src/app.js').content, 'export const answer = 42;\n');
});

test('tasks, proposals, file changes and approvals work through both adapters', async () => {
  const project = await request('POST', '/api/projects', { body: { name: 'Proposal project' } });
  const id = project.data.project.id;

  const proposal = tools.stageFileChange({
    projectId: id,
    kind: 'create',
    path: 'src/generated.js',
    content: 'export const generated = true;\n',
  });
  assert.equal(proposal.status, 'pending');

  const pending = await request('GET', `/api/projects/${id}/proposals`);
  assert.equal(pending.status, 200);
  assert.ok(pending.data.proposals.some((entry) => entry.proposalId === proposal.id));

  const applied = await request('POST', `/api/projects/${id}/proposals/${proposal.id}/apply`);
  assert.equal(applied.status, 201);
  const read = await request('GET', `/api/projects/${id}/file?${new URLSearchParams({ path: 'src/generated.js' })}`);
  assert.equal(read.data.content, 'export const generated = true;\n');
  assert.equal(driver.readObject(id, 'src/generated.js').content, 'export const generated = true;\n');

  const changes = await request('GET', `/api/projects/${id}/changes`);
  assert.ok(changes.data.changes.some((entry) => entry.path === 'src/generated.js' && entry.source === 'agent'));

  const task = await request('POST', '/api/tasks', {
    body: { projectId: id, instruction: 'Inspect the workspace' },
  });
  assert.equal(task.status, 201);
  assert.equal(task.data.task.status, 'queued');

  const tasks = await request('GET', `/api/tasks?projectId=${id}`);
  assert.ok(tasks.data.tasks.some((entry) => entry.id === task.data.task.id));

  const detail = await request('GET', `/api/tasks/${task.data.task.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.steps, []);

  const cancelled = await request('POST', `/api/tasks/${task.data.task.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.task.status, 'cancelled');
});

test('failed object writes restore the local cache and record no history', async () => {
  const project = await request('POST', '/api/projects', { body: { name: 'Failure project' } });
  const id = project.data.project.id;
  const before = changeCount(id, 'src/failed.js');
  driver.failNextPut('injected object storage outage');

  const response = await request('PUT', `/api/projects/${id}/file?${new URLSearchParams({ path: 'src/failed.js' })}`, {
    body: { content: 'should not be durable\n' },
  });
  assert.equal(response.status, 503);
  assert.match(response.data.error, /object storage write failed/i);
  assert.throws(
    () => driver.readObject(id, 'src/failed.js'),
    (error) => error.code === 'ENOENT',
  );
  const read = await request('GET', `/api/projects/${id}/file?${new URLSearchParams({ path: 'src/failed.js' })}`);
  assert.equal(read.status, 404, 'a failed write must not appear in the local cache');
  assert.equal(changeCount(id, 'src/failed.js'), before);
});

test('failed updates and deletes restore the previous local file and history', async () => {
  const project = await request('POST', '/api/projects', { body: { name: 'Restore project' } });
  const id = project.data.project.id;
  const query = (p) => `?${new URLSearchParams({ path: p })}`;
  const original = 'export const value = 1;\n';
  assert.equal((await request('PUT', `/api/projects/${id}/file${query('src/restore.js')}`, {
    body: { content: original },
  })).status, 201);
  const before = changeCount(id, 'src/restore.js');

  driver.failNextPut('injected update failure');
  const failedUpdate = await request('PUT', `/api/projects/${id}/file${query('src/restore.js')}`, {
    body: { content: 'export const value = 2;\n' },
  });
  assert.equal(failedUpdate.status, 503);
  assert.equal(driver.readObject(id, 'src/restore.js').content, original);
  assert.equal((await request('GET', `/api/projects/${id}/file${query('src/restore.js')}`)).data.content, original);
  assert.equal(changeCount(id, 'src/restore.js'), before);

  driver.failNextDelete('injected delete failure');
  const failedDelete = await request('DELETE', `/api/projects/${id}/file${query('src/restore.js')}`);
  assert.equal(failedDelete.status, 503);
  assert.equal(driver.readObject(id, 'src/restore.js').content, original);
  assert.equal((await request('GET', `/api/projects/${id}/file${query('src/restore.js')}`)).data.content, original);
  assert.equal(changeCount(id, 'src/restore.js'), before);
});

test('S3 client signs path-style requests with AWS Signature V4', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: new URL(url), init };
    return { status: 200, headers: new Headers(), text: async () => '' };
  };
  try {
    const client = createS3Client({
      workspaceS3Endpoint: 'https://s3.example.test',
      workspaceS3Bucket: 'test-bucket',
      workspaceS3Region: 'auto',
      workspaceS3AccessKey: 'test-access-key',
      workspaceS3SecretKey: 'test-secret-key',
      workspaceS3Prefix: 'workspaces',
    });
    await client.put('1/a.txt', 'hello');
    assert.equal(captured.url.pathname, '/test-bucket/workspaces/1/a.txt');
    assert.match(captured.init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
    assert.match(captured.init.headers.Authorization, /auto\/s3\/aws4_request/);
    assert.ok(captured.init.headers['x-amz-content-sha256']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('S3 client lists with a query prefix and returns workspace-relative names', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  const xml = [
    '<ListBucketResult>',
    '<Contents><Key>workspaces/8/src/app.js</Key><Size>12</Size></Contents>',
    '<Contents><Key>workspaces/8/src/100% &amp; &lt;tag&gt;.txt</Key><Size>7</Size></Contents>',
    '<CommonPrefixes><Prefix>workspaces/8/src/nested/</Prefix></CommonPrefixes>',
    '</ListBucketResult>',
  ].join('');
  globalThis.fetch = async (url, init) => {
    captured = { url: new URL(url), init };
    return { status: 200, headers: new Headers(), text: async () => xml };
  };
  try {
    const client = createS3Client({
      workspaceS3Endpoint: 'https://s3.example.test',
      workspaceS3Bucket: 'test-bucket',
      workspaceS3Region: 'auto',
      workspaceS3AccessKey: 'test-access-key',
      workspaceS3SecretKey: 'test-secret-key',
      workspaceS3Prefix: 'workspaces',
    });
    const listing = await client.list('8');
    assert.equal(captured.url.pathname, '/test-bucket');
    assert.equal(captured.url.searchParams.get('list-type'), '2');
    assert.equal(captured.url.searchParams.get('prefix'), 'workspaces/8/');
    assert.equal(captured.url.searchParams.get('delimiter'), '/');
    assert.match(captured.url.search, /^\?delimiter=%2F&list-type=2&max-keys=1000&prefix=/);
    assert.deepEqual(listing, {
      entries: [
        { name: 'src/app.js', size: 12 },
        { name: 'src/100% & <tag>.txt', size: 7 },
      ],
      prefixes: ['src/nested'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('S3 signing uses RFC 3986 encoding for special filenames', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: new URL(url), init };
    return { status: 200, headers: new Headers(), text: async () => '' };
  };
  try {
    const client = createS3Client({
      workspaceS3Endpoint: 'https://s3.example.test',
      workspaceS3Bucket: 'test-bucket',
      workspaceS3Region: 'auto',
      workspaceS3AccessKey: 'test-access-key',
      workspaceS3SecretKey: 'test-secret-key',
      workspaceS3Prefix: 'workspaces',
    });
    await client.put("1/it's (a)*! & 100%.txt", 'hello');
    assert.equal(
      captured.url.pathname,
      '/test-bucket/workspaces/1/it%27s%20%28a%29%2A%21%20%26%20100%25.txt',
    );
    assert.match(captured.init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('S3 listing follows continuation tokens past 1000 objects', async () => {
  const originalFetch = globalThis.fetch;
  const allKeys = Array.from(
    { length: 1001 },
    (_unused, index) => `workspaces/9/src/file-${String(index).padStart(4, '0')}.js`,
  );
  let calls = 0;
  let secondToken = null;
  globalThis.fetch = async (url) => {
    calls += 1;
    const token = new URL(url).searchParams.get('continuation-token');
    if (!token) {
      const contents = allKeys.slice(0, 1000)
        .map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`)
        .join('');
      return {
        status: 200,
        headers: new Headers(),
        text: async () => `<ListBucketResult>${contents}<IsTruncated>true</IsTruncated><NextContinuationToken>page-2</NextContinuationToken></ListBucketResult>`,
      };
    }
    secondToken = token;
    const contents = allKeys.slice(1000)
      .map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`)
      .join('');
    return {
      status: 200,
      headers: new Headers(),
      text: async () => `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
    };
  };
  try {
    const client = createS3Client({
      workspaceS3Endpoint: 'https://s3.example.test',
      workspaceS3Bucket: 'test-bucket',
      workspaceS3Region: 'auto',
      workspaceS3AccessKey: 'test-access-key',
      workspaceS3SecretKey: 'test-secret-key',
      workspaceS3Prefix: 'workspaces',
    });
    const listing = await client.list('9');
    assert.equal(calls, 2);
    assert.equal(secondToken, 'page-2');
    assert.equal(listing.entries.length, 1001);
    assert.equal(listing.entries[0].name, 'src/file-0000.js');
    assert.equal(listing.entries.at(-1).name, 'src/file-1000.js');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cache rehydration prunes stale files and keeps the old cache on partial failure', async () => {
  const project = await request('POST', '/api/projects', { body: { name: 'Cache recovery project' } });
  const id = project.data.project.id;
  await request('PUT', `/api/projects/${id}/file?${new URLSearchParams({ path: 'src/kept.js' })}`, {
    body: { content: 'export const kept = true;\n' },
  });
  const root = driver.prepare(id);
  const stale = path.join(root, 'stale.js');
  fs.writeFileSync(stale, 'stale\n');

  driver.forgetPrepared(id);
  assert.equal((await request('GET', `/api/projects/${id}/files`)).status, 200);
  assert.equal(fs.existsSync(stale), false, 'stale cache files must be pruned during hydration');

  fs.writeFileSync(stale, 'stale-again\n');
  driver.failNextHydrationGet('injected hydration read failure');
  driver.forgetPrepared(id);
  assert.throws(() => driver.prepare(id), /injected hydration read failure/);
  assert.equal(fs.existsSync(stale), true, 'a failed hydration must leave the old cache intact');
  const cacheBase = path.join(config.workspaceRoot, '.object-cache');
  assert.deepEqual(
    fs.readdirSync(cacheBase).filter((name) => name.startsWith(`.hydrate-${id}-`)),
    [],
    'a failed hydration must not leave temporary directories behind',
  );

  driver.forgetPrepared(id);
  const recovered = driver.prepare(id);
  assert.equal(fs.existsSync(path.join(recovered, 'src', 'kept.js')), true);
  assert.equal(fs.existsSync(stale), false);
});

test('importing an existing directory is rejected while object storage is enabled', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  const response = await request('POST', '/api/projects', {
    body: { name: 'Unsupported import', path: importRoot },
  });
  assert.equal(response.status, 400);
  assert.match(response.data.error, /object storage/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, before);
});

test('project creation rolls back when workspace preparation fails', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  driver.failNextPrepare('injected workspace prepare failure');
  const response = await request('POST', '/api/projects', { body: { name: 'Rollback project' } });
  assert.equal(response.status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, before);

  const retry = await request('POST', '/api/projects', { body: { name: 'Rollback project retry' } });
  assert.equal(retry.status, 201);
});

test('PostgreSQL duplicate registration is a 409 and recognizes SQLSTATE 23505', async () => {
  assert.equal(isDuplicateEmailError({ code: '23505' }), true);
  assert.equal(isDuplicateEmailError({ message: 'duplicate key value violates unique constraint "users_email_key"' }), true);

  const email = 'Duplicate.User@Example.test';
  const first = await request('POST', '/api/auth/register', {
    auth: false,
    body: { email, password: 'correct-horse-battery' },
  });
  assert.equal(first.status, 201);
  const second = await request('POST', '/api/auth/register', {
    auth: false,
    body: { email: email.toLowerCase(), password: 'correct-horse-battery' },
  });
  assert.equal(second.status, 409);
});

test('worker fatal errors are propagated immediately and remain fatal', () => {
  const bridge = createStorageBridge({
    config: { workspaceStorage: 'local' },
    backend: 'object',
    timeoutMs: 3000,
    heartbeatTimeoutMs: 1000,
  });
  try {
    assert.throws(() => bridge.call('__testCrash'), /Simulated storage worker crash/);
    assert.throws(() => bridge.call('ping'), /Simulated storage worker crash/);
  } finally {
    bridge.close();
  }
});

test('worker serialization failures are propagated instead of timing out', () => {
  const bridge = createStorageBridge({
    config: { workspaceStorage: 'local' },
    backend: 'object',
    timeoutMs: 3000,
    heartbeatTimeoutMs: 1000,
  });
  try {
    assert.throws(() => bridge.call('__testHugeResponse'), /bridge buffer limit/);
  } finally {
    bridge.close();
  }
});

test('worker timeouts report a timeout without killing the worker', async () => {
  const bridge = createStorageBridge({
    config: { workspaceStorage: 'local' },
    backend: 'object',
    timeoutMs: 400,
    heartbeatTimeoutMs: 2000,
  });
  try {
    assert.throws(() => bridge.call('__testSleep', { ms: 1000 }), /Timed out waiting for storage request/);
    // The request is still running in the worker; a follow-up call is only
    // expected to succeed once that slow request has finished.
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(bridge.call('ping'), { ok: true });
  } finally {
    bridge.close();
  }
});

test('a stopped worker heartbeat is detected before the full timeout', () => {
  const bridge = createStorageBridge({
    config: { workspaceStorage: 'local' },
    backend: 'object',
    timeoutMs: 5000,
    heartbeatTimeoutMs: 300,
  });
  try {
    assert.throws(() => bridge.call('__testAbandon'), /stopped responding/);
  } finally {
    bridge.close();
  }
});

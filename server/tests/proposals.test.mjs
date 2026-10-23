// Regression tests for persistent workspace proposals.
//
// A "restart" is simulated by creating a second app against the same temporary
// SQLite database (tests/setup-test-env.mjs points DATABASE_PATH at a temp file)
// and therefore a fresh tools instance with no in-memory proposal state. The
// startup recovery path that runs on a real boot runs here too.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { createApp } from '../src/index.js';
import { mockProvider } from '../src/ai/mock.js';
import { config } from '../src/config.js';

const servers = [];

async function boot() {
  const created = createApp({ provider: mockProvider });
  const server = created.app.listen(0);
  await once(server, 'listening');
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, urlPath, body) => {
    const init = body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(base + urlPath, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON response */
    }
    return { status: res.status, data };
  };
  return { ...created, base, call };
}

after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

async function createProject(app, name) {
  const { status, data } = await app.call('POST', '/api/projects', { name });
  assert.equal(status, 201, `could not create project: ${JSON.stringify(data)}`);
  return data.project.id;
}

function workspaceOf(projectId) {
  return path.join(config.workspaceRoot, String(projectId));
}

const proposalsPath = (projectId) => `/api/projects/${projectId}/proposals`;
const applyPath = (projectId, proposalId) => `${proposalsPath(projectId)}/${proposalId}/apply`;
const rejectPath = (projectId, proposalId) => `${proposalsPath(projectId)}/${proposalId}/reject`;
const runPath = (projectId, proposalId) => `/api/projects/${projectId}/commands/${proposalId}/run`;

function rowFor(app, proposalId) {
  return app.db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
}

function historyCount(app, projectId) {
  return app.db
    .prepare('SELECT COUNT(*) AS c FROM file_changes WHERE project_id = ?')
    .get(projectId).c;
}

test('a staged create survives a restart and is applied exactly once', async () => {
  const first = await boot();
  const projectId = await createProject(first, 'persist-create');
  const staged = await first.tools.execute('create_file', {
    projectId,
    path: 'src/persisted.js',
    content: 'export const persisted = true;\n',
  });

  // The proposal is a real, durable row before any restart.
  const stored = rowFor(first, staged.proposalId);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.kind, 'create');
  assert.equal(stored.project_id, projectId);
  assert.equal(stored.content, 'export const persisted = true;\n');

  const second = await boot(); // restart

  const listed = await second.call('GET', proposalsPath(projectId));
  assert.equal(listed.status, 200);
  assert.equal(listed.data.proposals.length, 1);
  assert.equal(listed.data.proposals[0].proposalId, staged.proposalId);
  assert.equal(listed.data.proposals[0].action, 'create');
  assert.equal(listed.data.proposals[0].diff, staged.diff);

  const applied = await second.call('POST', applyPath(projectId, staged.proposalId));
  assert.equal(applied.status, 201);
  assert.equal(applied.data.file.path, 'src/persisted.js');
  assert.equal(
    fs.readFileSync(path.join(workspaceOf(projectId), 'src', 'persisted.js'), 'utf8'),
    'export const persisted = true;\n',
  );

  // The original app instance also sees it as gone, and a duplicate apply 404s.
  assert.equal((await first.call('GET', proposalsPath(projectId))).data.proposals.length, 0);
  assert.equal((await first.call('POST', applyPath(projectId, staged.proposalId))).status, 404);
  assert.equal(rowFor(first, staged.proposalId).status, 'applied');
  assert.equal(historyCount(first, projectId), 1);
});

test('an update proposal keeps its reviewed original across a restart', async () => {
  const first = await boot();
  const projectId = await createProject(first, 'persist-update');
  fs.mkdirSync(workspaceOf(projectId), { recursive: true });
  fs.writeFileSync(path.join(workspaceOf(projectId), 'config.js'), 'mode = "dev"\n');

  const staged = await first.tools.execute('propose_file_change', {
    projectId,
    path: 'config.js',
    content: 'mode = "prod"\n',
  });

  const second = await boot();
  const applied = await second.call('POST', applyPath(projectId, staged.proposalId));

  assert.equal(applied.status, 201);
  assert.equal(fs.readFileSync(path.join(workspaceOf(projectId), 'config.js'), 'utf8'), 'mode = "prod"\n');
  assert.equal(rowFor(second, staged.proposalId).status, 'applied');
  assert.equal(historyCount(second, projectId), 1);
  assert.equal(
    first.db.prepare('SELECT action, source FROM file_changes WHERE project_id = ?').get(projectId).action,
    'update',
  );
});

test('a discard survives a restart and stays unappliable', async () => {
  const first = await boot();
  const projectId = await createProject(first, 'persist-discard');
  const staged = await first.tools.execute('create_file', {
    projectId,
    path: 'discarded.js',
    content: 'export const discarded = true;\n',
  });

  const second = await boot();
  const rejected = await second.call('POST', rejectPath(projectId, staged.proposalId));
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.status, 'rejected');
  assert.equal(rowFor(second, staged.proposalId).status, 'rejected');

  // A third boot must not resurrect it.
  const third = await boot();
  assert.equal((await third.call('GET', proposalsPath(projectId))).data.proposals.length, 0);
  assert.equal((await third.call('POST', applyPath(projectId, staged.proposalId))).status, 404);
  assert.equal((await third.call('POST', rejectPath(projectId, staged.proposalId))).status, 404);
  assert.equal(fs.existsSync(path.join(workspaceOf(projectId), 'discarded.js')), false);
  assert.equal(historyCount(third, projectId), 0);
});

test('stale content is refused after a restart and the proposal stays discardable', async () => {
  const first = await boot();
  const projectId = await createProject(first, 'persist-stale');
  const file = path.join(workspaceOf(projectId), 'stale.js');
  fs.writeFileSync(file, 'value = 1\n');

  const staged = await first.tools.execute('propose_file_change', {
    projectId,
    path: 'stale.js',
    content: 'value = 2\n',
  });

  const second = await boot();
  fs.writeFileSync(file, 'value = 3\n'); // changed behind the proposal's back

  const applied = await second.call('POST', applyPath(projectId, staged.proposalId));
  assert.equal(applied.status, 409);
  assert.match(applied.data.error, /changed since the proposal/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'value = 3\n');
  assert.equal(rowFor(second, staged.proposalId).status, 'pending');
  assert.equal((await second.call('GET', proposalsPath(projectId))).data.proposals.length, 1);

  assert.equal((await second.call('POST', rejectPath(projectId, staged.proposalId))).status, 200);
  assert.equal(historyCount(second, projectId), 0);
});

test('simultaneous applications write once and record one history entry', async () => {
  const app = await boot();
  const projectId = await createProject(app, 'duplicate-apply');
  const staged = await app.tools.execute('create_file', {
    projectId,
    path: 'once.js',
    content: 'export const once = true;\n',
  });

  const [first, second] = await Promise.all([
    app.call('POST', applyPath(projectId, staged.proposalId)),
    app.call('POST', applyPath(projectId, staged.proposalId)),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [201, 404]);
  assert.equal(
    fs.readFileSync(path.join(workspaceOf(projectId), 'once.js'), 'utf8'),
    'export const once = true;\n',
  );
  assert.equal(historyCount(app, projectId), 1);
  assert.equal(rowFor(app, staged.proposalId).status, 'applied');
});

test('another project cannot apply or discard a foreign proposal', async () => {
  const app = await boot();
  const ownerId = await createProject(app, 'foreign-owner');
  const otherId = await createProject(app, 'foreign-other');

  const staged = await app.tools.execute('create_file', {
    projectId: ownerId,
    path: 'owned.js',
    content: 'export const owned = true;\n',
  });

  assert.equal((await app.call('POST', applyPath(otherId, staged.proposalId))).status, 404);
  assert.equal((await app.call('POST', rejectPath(otherId, staged.proposalId))).status, 404);
  assert.equal(rowFor(app, staged.proposalId).status, 'pending');
  assert.equal((await app.call('GET', proposalsPath(ownerId))).data.proposals.length, 1);
  assert.equal(fs.existsSync(path.join(workspaceOf(ownerId), 'owned.js')), false);

  assert.equal((await app.call('POST', rejectPath(ownerId, staged.proposalId))).status, 200);
});

test('a command proposal survives a restart and runs only once', async () => {
  const first = await boot();
  const projectId = await createProject(first, 'persist-command');
  fs.writeFileSync(path.join(workspaceOf(projectId), 'package.json'),
    JSON.stringify({ scripts: { test: 'node --version' } }));

  const staged = await first.tools.execute('run_command', { projectId, command: 'npm_test' });
  const second = await boot();

  const listed = await second.call('GET', proposalsPath(projectId));
  assert.equal(listed.data.proposals[0].type, 'command');
  assert.equal(listed.data.proposals[0].command, 'npm_test');

  const run = await second.call('POST', runPath(projectId, staged.proposalId));
  assert.equal(run.status, 200);
  assert.equal(run.data.result.exitCode, 0);
  assert.equal(rowFor(second, staged.proposalId).status, 'applied');

  assert.equal((await second.call('POST', runPath(projectId, staged.proposalId))).status, 404);
  assert.equal((await first.call('POST', runPath(projectId, staged.proposalId))).status, 404);
});

test('recovery finalizes an interrupted create whose write already landed', async () => {
  const first = await boot();
  const projectId = await createProject(first, 'crash-after-write');
  const staged = await first.tools.execute('create_file', {
    projectId,
    path: 'landed.js',
    content: 'export const landed = true;\n',
  });

  // Simulate a crash after the write but before the final transaction.
  first.db.prepare("UPDATE proposals SET status = 'applying' WHERE id = ?").run(staged.proposalId);
  fs.mkdirSync(workspaceOf(projectId), { recursive: true });
  fs.writeFileSync(path.join(workspaceOf(projectId), 'landed.js'), 'export const landed = true;\n');

  const restarted = await boot();
  const recovered = rowFor(restarted, staged.proposalId);
  assert.equal(recovered.status, 'applied');
  assert.equal(fs.readFileSync(path.join(workspaceOf(projectId), 'landed.js'), 'utf8'),
    'export const landed = true;\n');
  assert.equal((await restarted.call('POST', applyPath(projectId, staged.proposalId))).status, 404);
  // The finalization transaction ran exactly once, so history is not duplicated.
  assert.equal(historyCount(restarted, projectId), 1);
});

test('recovery returns an interrupted create to pending when nothing was written', async () => {
  const first = await boot();
  const projectId = await createProject(first, 'crash-before-write');
  const staged = await first.tools.execute('create_file', {
    projectId,
    path: 'not-yet.js',
    content: 'export const later = true;\n',
  });
  first.db.prepare("UPDATE proposals SET status = 'applying' WHERE id = ?").run(staged.proposalId);

  const restarted = await boot();
  assert.equal(rowFor(restarted, staged.proposalId).status, 'pending');
  assert.equal((await restarted.call('GET', proposalsPath(projectId))).data.proposals.length, 1);
  assert.equal(fs.existsSync(path.join(workspaceOf(projectId), 'not-yet.js')), false);

  const applied = await restarted.call('POST', applyPath(projectId, staged.proposalId));
  assert.equal(applied.status, 201);
  assert.equal(historyCount(restarted, projectId), 1);
});

test('recovery never overwrites a file that conflicts with an interrupted update', async () => {
  const first = await boot();
  const projectId = await createProject(first, 'crash-conflict');
  const file = path.join(workspaceOf(projectId), 'conflict.js');
  fs.writeFileSync(file, 'value = 1\n');

  const staged = await first.tools.execute('propose_file_change', {
    projectId,
    path: 'conflict.js',
    content: 'value = 2\n',
  });
  first.db.prepare("UPDATE proposals SET status = 'applying' WHERE id = ?").run(staged.proposalId);
  fs.writeFileSync(file, 'value = 9\n');

  const restarted = await boot();
  const recovered = rowFor(restarted, staged.proposalId);
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error, /no longer matches the reviewed version/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'value = 9\n');
  assert.equal((await restarted.call('POST', applyPath(projectId, staged.proposalId))).status, 404);
  assert.equal((await restarted.call('GET', proposalsPath(projectId))).data.proposals.length, 0);
});

test('an interrupted command is marked unknown and never re-run', async () => {
  const first = await boot();
  const projectId = await createProject(first, 'crash-command');
  fs.writeFileSync(path.join(workspaceOf(projectId), 'package.json'),
    JSON.stringify({ scripts: { test: 'node write-marker.js' } }));
  fs.writeFileSync(path.join(workspaceOf(projectId), 'write-marker.js'),
    "require('node:fs').writeFileSync('ran.txt', 'ran');\n");

  const staged = await first.tools.execute('run_command', { projectId, command: 'npm_test' });
  first.db.prepare("UPDATE proposals SET status = 'applying' WHERE id = ?").run(staged.proposalId);

  const restarted = await boot();
  const recovered = rowFor(restarted, staged.proposalId);
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.error, /side effects are unknown/);
  assert.equal(fs.existsSync(path.join(workspaceOf(projectId), 'ran.txt')), false);
  assert.equal((await restarted.call('POST', runPath(projectId, staged.proposalId))).status, 404);
});

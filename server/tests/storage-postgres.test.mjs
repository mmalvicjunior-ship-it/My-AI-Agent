// Local PostgreSQL-compatibility tests. PGlite runs a real Postgres engine
// in-process, so these tests exercise the SQL adapter without creating a Neon
// project, touching production data, or using the network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-pglite-'));
process.env.PGLITE_DATA_DIR = pgliteDir;
process.env.DATABASE_BACKEND = 'pglite';
process.env.WORKSPACE_STORAGE = 'local';

const { openDb } = await import('../src/db/index.js');
const { createPostgresDb, POSTGRES_SCHEMA_SQL } = await import('../src/storage/postgres-db.js');
const {
  createTask,
  getTask,
  appendStep,
  listTasks,
  listSteps,
  savePlan,
  loadPlan,
} = await import('../src/tasks/store.js');
const auth = await import('../src/auth/index.js');
const {
  stageProposal,
  listPendingProposals,
  claimProposal,
  completeProposal,
  rejectProposal,
  getProposal,
} = await import('../src/proposals/store.js');

const db = openDb();

after(() => {
  try { db.close(); } catch { /* best effort */ }
  try { fs.rmSync(pgliteDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('PGlite schema and idempotent migrations expose every required table/column', () => {
  const { all } = db.prepare(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  );
  const tables = new Set(all().map((row) => row.table_name));
  for (const table of [
    'projects', 'users', 'oauth_states', 'sessions', 'chat_messages',
    'file_changes', 'tasks', 'task_steps', 'proposals',
  ]) {
    assert.ok(tables.has(table), `missing ${table}`);
  }

  const tasks = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
  for (const column of ['plan_json', 'autonomous', 'status', 'created_at']) {
    assert.ok(tasks.has(column), `missing tasks.${column}`);
  }
  const proposals = new Set(db.prepare('PRAGMA table_info(proposals)').all().map((row) => row.name));
  assert.ok(proposals.has('result_json'));
});

test('SQL adapter translates placeholders, RETURNING, changes, and timestamps', () => {
  const created = db.prepare('INSERT INTO projects (name, owner_id) VALUES (?, ?)').run('postgres-adapter', null);
  assert.equal(created.changes, 1);
  assert.ok(Number(created.lastInsertRowid) > 0);

  const row = db.prepare('SELECT id, name, created_at FROM projects WHERE id = ?').get(created.lastInsertRowid);
  assert.equal(row.name, 'postgres-adapter');
  assert.ok(!Number.isNaN(Date.parse(row.created_at)), `unparseable timestamp: ${row.created_at}`);

  const all = db.prepare('SELECT id FROM projects WHERE name = ?').all('postgres-adapter');
  assert.equal(all.length, 1);

  const updated = db.prepare('UPDATE projects SET name = ? WHERE id = ?').run('renamed', created.lastInsertRowid);
  assert.equal(updated.changes, 1);
});

test('SQL adapter preserves transaction rollback semantics', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO projects (name) VALUES (?)').run('rollback-check');
  db.exec('ROLLBACK');
  const after = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  assert.equal(after, before);
});

test('tasks, plans, and ordered steps work through the Postgres adapter', () => {
  const project = db.prepare('INSERT INTO projects (name) VALUES (?)').run('task-project');
  const task = createTask(db, { projectId: project.lastInsertRowid, instruction: 'Do local work' });
  assert.equal(task.status, 'queued');
  assert.equal(Number(task.project_id), Number(project.lastInsertRowid));

  savePlan(db, task.id, { steps: [{ id: 'one' }], currentStep: 0 });
  assert.deepEqual(loadPlan(db, task.id).steps, [{ id: 'one' }]);

  assert.equal(appendStep(db, task.id, { title: 'Inspected files' }), 1);
  assert.equal(appendStep(db, task.id, { title: 'Prepared proposal' }), 2);
  assert.equal(listSteps(db, task.id).length, 2);
  assert.equal(getTask(db, task.id).last_step, 'Prepared proposal');
  assert.equal(listTasks(db, { projectId: project.lastInsertRowid }).length, 1);
});

test('proposal state machine and file-change history commit atomically', () => {
  const project = db.prepare('INSERT INTO projects (name) VALUES (?)').run('proposal-project');
  const proposal = stageProposal(db, {
    projectId: project.lastInsertRowid,
    kind: 'create',
    path: 'src/new.js',
    content: 'export const ok = true;\n',
  });
  assert.ok(proposal.id);
  assert.equal(listPendingProposals(db, project.lastInsertRowid).length, 1);
  assert.equal(claimProposal(db, project.lastInsertRowid, proposal.id), true);

  const completed = completeProposal(db, proposal, {
    path: 'src/new.js',
    action: 'create',
    diff: '@@ +1 @@\n+export const ok = true;',
  });
  assert.equal(completed, true);
  assert.equal(getProposal(db, proposal.id).status, 'applied');
  assert.equal(listPendingProposals(db, project.lastInsertRowid).length, 0);

  const changes = db.prepare(
    'SELECT path, action, source FROM file_changes WHERE project_id = ?',
  ).all(project.lastInsertRowid);
  assert.deepEqual(changes, [{ path: 'src/new.js', action: 'create', source: 'agent' }]);

  const rejected = stageProposal(db, { projectId: project.lastInsertRowid, kind: 'command', command: 'npm_test' });
  assert.equal(rejectProposal(db, project.lastInsertRowid, rejected.id), true);
  assert.equal(getProposal(db, rejected.id).status, 'rejected');
});

test('authentication sessions and case-insensitive emails work on Postgres', () => {
  const email = 'postgres-user@example.test';
  const created = db.prepare(
    'INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)',
  ).run(email, auth.hashPassword('correct-horse-battery'), 1);
  const userId = Number(created.lastInsertRowid);
  assert.ok(userId > 0);

  assert.throws(
    () => db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .run('POSTGRES-USER@example.test', 'x'),
    /duplicate key|UNIQUE/i,
  );

  assert.equal(auth.normalizeEmail(email), email);
  const session = auth.createSession(db, userId, 1);
  const user = auth.findSessionUser(db, session.token);
  assert.equal(user.id, userId);
  assert.equal(user.email, email);
  assert.equal(user.isAdmin, true);

  assert.equal(auth.deleteSession(db, session.token), true);
  assert.equal(auth.findSessionUser(db, session.token), null);

  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run('expired-hash', userId, new Date(0).toISOString(), new Date(0).toISOString());
  assert.ok(auth.deleteExpiredSessions(db) >= 1);
});

test('OAuth state rows can be inserted and atomically consumed', () => {
  const stateHash = auth.hashToken('local-state-value');
  db.prepare(
    'INSERT INTO oauth_states (state_hash, bootstrap_ok, allow_create, expires_at) VALUES (?, ?, ?, ?)',
  ).run(stateHash, 1, 1, new Date(Date.now() + 60_000).toISOString());
  const consumed = db.prepare(
    'DELETE FROM oauth_states WHERE state_hash = ? RETURNING bootstrap_ok, allow_create',
  ).get(stateHash);
  assert.deepEqual(consumed, { bootstrap_ok: 1, allow_create: 1 });
  assert.equal(db.prepare('SELECT state_hash FROM oauth_states WHERE state_hash = ?').get(stateHash), null);
});

test('multi-statement exec uses the simple query protocol', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exec_probe (id BIGSERIAL PRIMARY KEY, value TEXT);
    INSERT INTO exec_probe (value) VALUES ('first');
    INSERT INTO exec_probe (value) VALUES ('second');
  `);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM exec_probe').get().n >= 2);
});

test('ORDER BY rowid maps to insertion order rather than clock order', () => {
  db.prepare('INSERT INTO projects (name, created_at) VALUES (?, ?)')
    .run('rowid-later', '2030-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO projects (name, created_at) VALUES (?, ?)')
    .run('rowid-earlier', '2000-01-01T00:00:00.000Z');
  const rows = db.prepare(
    "SELECT name FROM projects WHERE name IN ('rowid-later', 'rowid-earlier') ORDER BY rowid ASC",
  ).all();
  assert.deepEqual(rows.map((row) => row.name), ['rowid-later', 'rowid-earlier']);
});

test('legacy mixed-case email rows are still found by case-insensitive lookup', () => {
  const mixed = 'Legacy.Mixed@Example.test';
  db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(mixed, 'not-a-real-hash', 0);
  const found = db.prepare('SELECT email FROM users WHERE lower(email) = ?')
    .get(mixed.toLowerCase());
  assert.equal(found.email, mixed);
  db.prepare('DELETE FROM users WHERE lower(email) = ?').run(mixed.toLowerCase());
});

test('closing the Postgres facade ends its client and rejects later calls', () => {
  const closeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-pglite-close-'));
  const extra = createPostgresDb({
    databaseBackend: 'pglite',
    pgliteDataDir: closeDir,
    workspaceStorage: 'local',
  });
  try {
    extra.exec(POSTGRES_SCHEMA_SQL);
    assert.ok(extra.prepare('SELECT 1 AS ok').get().ok);
    assert.doesNotThrow(() => extra.close());
    assert.doesNotThrow(() => extra.close());
    assert.throws(() => extra.prepare('SELECT 1 AS ok').get(), /closed/i);
  } finally {
    try { extra.close(); } catch { /* best effort */ }
    fs.rmSync(closeDir, { recursive: true, force: true });
  }
});

test('reopening a populated database reruns migrations idempotently', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  db.close();
  const reopened = openDb();
  try {
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM projects').get().n, before);
    assert.ok(reopened.prepare('PRAGMA table_info(proposals)').all().some((row) => row.name === 'result_json'));
  } finally {
    reopened.close();
  }
});

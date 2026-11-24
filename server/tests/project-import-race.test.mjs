// Concurrency regression coverage for imported projects. The DB-level unique
// import_key (SQLite here, PGlite in storage-postgres.test.mjs) makes a stale
// SELECT/INSERT pair idempotent instead of creating two owned records.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const { openDb } = await import('../src/db/index.js');
const { findOrCreateImportedProject } = await import('../src/index.js');

const db = openDb();
after(() => {
  try { db.close(); } catch { /* best effort */ }
});

function countFor(key) {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM projects WHERE import_key = ?').get(key).count);
}

test('repeated imports of the same canonical root reuse one owned record', () => {
  const rootPath = path.join(process.cwd(), 'test-import-root', 'same-app');
  const first = findOrCreateImportedProject(db, { name: 'First name', rootPath, ownerId: 7 });
  assert.equal(first.existing, false);
  assert.ok(Number.isSafeInteger(first.project.id));

  const second = findOrCreateImportedProject(db, { name: 'Renamed', rootPath, ownerId: 7 });
  assert.equal(second.existing, true);
  assert.equal(second.project.id, first.project.id);
  assert.equal(countFor(JSON.stringify([7, rootPath])), 1);
});

test('bypass imports stay idempotent and different owners may import the same root', () => {
  const rootPath = path.join(process.cwd(), 'test-import-root', 'shared-app');
  const bypassFirst = findOrCreateImportedProject(db, { name: 'Bypass', rootPath, ownerId: null });
  const bypassSecond = findOrCreateImportedProject(db, { name: 'Bypass again', rootPath, ownerId: null });
  assert.equal(bypassFirst.existing, false);
  assert.equal(bypassSecond.existing, true);
  assert.equal(bypassSecond.project.id, bypassFirst.project.id);
  assert.equal(countFor(JSON.stringify([0, rootPath])), 1);

  const other = findOrCreateImportedProject(db, { name: 'Other owner', rootPath, ownerId: 8 });
  assert.equal(other.existing, false);
  assert.equal(countFor(JSON.stringify([8, rootPath])), 1);
});

test('a stale lookup that loses the insert race reuses the winning row', () => {
  const rootPath = path.join(process.cwd(), 'test-import-root', 'raced-app');
  const winner = findOrCreateImportedProject(db, { name: 'Winner', rootPath, ownerId: 9 });
  assert.equal(winner.existing, false);

  const originalPrepare = db.prepare.bind(db);
  let lookups = 0;
  db.prepare = (sql, ...args) => {
    const statement = originalPrepare(sql, ...args);
    if (/SELECT id, name, root_path FROM projects WHERE owner_id/.test(sql)) {
      const originalGet = statement.get.bind(statement);
      statement.get = (...params) => {
        lookups += 1;
        // The first check ran before another process inserted the winner.
        if (lookups === 1) return undefined;
        return originalGet(...params);
      };
    }
    return statement;
  };

  try {
    const loser = findOrCreateImportedProject(db, { name: 'Loser', rootPath, ownerId: 9 });
    assert.equal(loser.existing, true);
    assert.equal(loser.project.id, winner.project.id);
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(countFor(JSON.stringify([9, rootPath])), 1);
});

test('the database rejects a direct duplicate import_key insert', () => {
  const rootPath = path.join(process.cwd(), 'test-import-root', 'direct-app');
  const key = JSON.stringify([11, rootPath]);
  db.prepare('INSERT INTO projects (name, root_path, owner_id, import_key) VALUES (?, ?, ?, ?)')
    .run('Direct A', rootPath, 11, key);
  assert.throws(() => db.prepare(
    'INSERT INTO projects (name, root_path, owner_id, import_key) VALUES (?, ?, ?, ?)',
  ).run('Direct B', rootPath, 11, key), /UNIQUE constraint failed: projects\.import_key/i);
  assert.equal(countFor(key), 1);
});

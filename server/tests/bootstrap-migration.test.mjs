// Migration tests for the is_admin column on existing (legacy) databases.
//
// openDb() must add the column to databases created before roles existed,
// promote the earliest account (MIN(id)) exactly once, and finish the
// promotion even when a previous boot was interrupted between the column add
// and the promotion UPDATE. It must never change which account is already
// the administrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDb } from '../src/db/index.js';
import { config } from '../src/config.js';

function createLegacyDb(dbPath, { withAdminColumn }) {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      ${withAdminColumn ? ', is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1))' : ''}
    );
  `);
  legacy.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('first@example.com', 'hash-one');
  legacy.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('second@example.com', 'hash-two');
  legacy.close();
}

function withTempDb(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-migration-'));
  const originalDbPath = config.databasePath;
  const originalWorkspaceRoot = config.workspaceRoot;
  const dbPath = path.join(tempDir, 'legacy.db');
  config.databasePath = dbPath;
  config.workspaceRoot = path.join(tempDir, 'workspaces');
  try {
    return fn(dbPath);
  } finally {
    config.databasePath = originalDbPath;
    config.workspaceRoot = originalWorkspaceRoot;
    // Do not delete the temp dir: SQLite may hold the file open on Windows;
    // leaving it behind is consistent with the rest of the suite.
  }
}

function adminRows(db) {
  return db.prepare('SELECT email, is_admin FROM users ORDER BY id').all();
}

test('legacy database without the column: the earliest account becomes the only administrator', () => {
  withTempDb((dbPath) => {
    createLegacyDb(dbPath, { withAdminColumn: false });
    const db = openDb();
    try {
      const rows = adminRows(db);
      assert.deepEqual(rows.map((row) => row.is_admin), [1, 0]);
    } finally {
      db.close();
    }
  });
});

test('the promotion is idempotent across repeated boots', () => {
  withTempDb((dbPath) => {
    createLegacyDb(dbPath, { withAdminColumn: false });
    openDb().close();
    openDb().close();
    const db = openDb();
    try {
      assert.deepEqual(adminRows(db).map((row) => row.is_admin), [1, 0]);
    } finally {
      db.close();
    }
  });
});

test('interrupted migration (column exists, promotion lost) recovers on the next boot', () => {
  withTempDb((dbPath) => {
    // Simulates a crash between the ALTER TABLE and the promotion UPDATE:
    // the column exists but no account is an administrator yet.
    createLegacyDb(dbPath, { withAdminColumn: true });
    const db = openDb();
    try {
      assert.deepEqual(adminRows(db).map((row) => row.is_admin), [1, 0],
        'the promotion completes itself instead of leaving a database with no administrator');
    } finally {
      db.close();
    }
  });
});

test('an account that is already an administrator is never reassigned', () => {
  withTempDb((dbPath) => {
    createLegacyDb(dbPath, { withAdminColumn: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run('second@example.com');
    legacy.close();

    const db = openDb();
    try {
      assert.deepEqual(adminRows(db).map((row) => row.is_admin), [0, 1],
        'the existing administrator keeps the role; nobody else is promoted');
    } finally {
      db.close();
    }
  });
});

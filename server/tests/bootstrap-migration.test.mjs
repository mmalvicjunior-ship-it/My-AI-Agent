// Migration tests for the is_admin column on existing (legacy) databases.
//
// openDb() adds the column to databases created before roles existed, but no
// startup code promotes an account to administrator. The first administrator
// comes only from the owner-only /api/auth/admin/provision endpoint. Existing
// administrators are preserved, and legacy duplicate admins are collapsed so
// the single-admin index can be created.
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

test('legacy database without the column promotes nobody', () => {
  withTempDb((dbPath) => {
    createLegacyDb(dbPath, { withAdminColumn: false });
    const db = openDb();
    try {
      assert.deepEqual(adminRows(db).map((row) => row.is_admin), [0, 0]);
    } finally {
      db.close();
    }
  });
});

test('repeated boots never create an administrator by themselves', () => {
  withTempDb((dbPath) => {
    createLegacyDb(dbPath, { withAdminColumn: false });
    openDb().close();
    openDb().close();
    const db = openDb();
    try {
      assert.deepEqual(adminRows(db).map((row) => row.is_admin), [0, 0]);
    } finally {
      db.close();
    }
  });
});

test('a database with the column but no administrator stays that way', () => {
  withTempDb((dbPath) => {
    // Simulates an old interrupted migration: the column exists but no account
    // is an administrator. Startup must not guess which account to promote.
    createLegacyDb(dbPath, { withAdminColumn: true });
    const db = openDb();
    try {
      assert.deepEqual(adminRows(db).map((row) => row.is_admin), [0, 0]);
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

test('legacy duplicate administrators are collapsed without promoting anyone', () => {
  withTempDb((dbPath) => {
    createLegacyDb(dbPath, { withAdminColumn: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('UPDATE users SET is_admin = 1');
    legacy.close();

    const db = openDb();
    try {
      assert.deepEqual(adminRows(db).map((row) => row.is_admin), [1, 0]);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c, 1);
    } finally {
      db.close();
    }
  });
});

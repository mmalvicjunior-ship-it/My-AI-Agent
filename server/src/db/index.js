// Lightweight persistence using Node's built-in SQLite (zero extra dependencies).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Opens (and initializes, if needed) the local SQLite database.
 * The path comes from config (DATABASE_PATH in the project-root .env,
 * defaults to server/data/app.db) which lives in a git-ignored folder.
 */
export function openDb() {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new DatabaseSync(config.databasePath);

  // Wait up to 5s for concurrent connections instead of failing with
  // "database is locked" (parallel test processes / multi-instance safety).
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      root_path  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const projectColumns = db.prepare('PRAGMA table_info(projects)').all();
  if (!projectColumns.some((column) => column.name === 'root_path')) {
    db.exec('ALTER TABLE projects ADD COLUMN root_path TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

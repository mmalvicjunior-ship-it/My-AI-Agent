// Lightweight persistence using Node's built-in SQLite (zero extra dependencies).
import { DatabaseSync } from 'node:sqlite';
import { ensurePlanColumn, ensureAutonomyColumn } from '../tasks/store.js';
import { ensureResultColumn } from '../proposals/store.js';
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

  // History of every file write/delete (human edits and approved agent
  // proposals) with the unified diff that was shown at the time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_changes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      path       TEXT NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
      source     TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'agent')),
      diff       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Background coding tasks. The queue lives in SQLite (not in the browser or
  // an HTTP request) so a task keeps its status, progress and history across
  // restarts; the in-process runner (src/tasks/runner.js) executes them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id       INTEGER NOT NULL,
      instruction      TEXT NOT NULL,
      autonomy         TEXT NOT NULL DEFAULT 'propose'
                       CHECK (autonomy IN ('supervised', 'propose', 'approved_autonomous', 'allow_writes', 'allow_writes_and_commands')),
      status           TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'waiting_approval', 'provider_paused', 'completed', 'failed', 'cancelled')),
      last_step        TEXT,
      error            TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      started_at       TEXT,
      finished_at      TEXT
    );
  `);

  // Ensure the plan_json column exists on the tasks table (idempotent migration).
  ensurePlanColumn(db);
  // Ensure autonomous mode column exists on the tasks table (idempotent migration).
  ensureAutonomyColumn(db);

  // Safe idempotent migration: add 'provider_paused' and new autonomy modes for older DBs.
  const tasksSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='tasks' AND type='table'").get();
  if (tasksSchema && tasksSchema.sql && (!tasksSchema.sql.includes('provider_paused') || !tasksSchema.sql.includes('approved_autonomous'))) {
    // Recreate tasks table with updated status constraint, preserving all data.
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        instruction TEXT NOT NULL,
        autonomy TEXT NOT NULL DEFAULT 'propose'
          CHECK (autonomy IN ('supervised', 'propose', 'approved_autonomous', 'allow_writes', 'allow_writes_and_commands')),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'waiting_approval', 'provider_paused', 'completed', 'failed', 'cancelled')),
        last_step TEXT,
        error TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        finished_at TEXT,
        plan_json TEXT,
        autonomous INTEGER NOT NULL DEFAULT 0
      );
    `);
    const cols = db.prepare('PRAGMA table_info(tasks)').all();
    const colNames = cols.map(c => c.name);
    const insertCols = ['id','project_id','instruction','autonomy','status','last_step','error','cancel_requested','created_at','updated_at','started_at','finished_at'];
    const safeCols = insertCols.filter(c => colNames.includes(c));
    const colList = safeCols.join(', ');
    try {
      db.exec(`INSERT INTO tasks_new (${colList}) SELECT ${colList} FROM tasks;`);
    } catch {
      const basicCols = ['id','project_id','instruction','autonomy','status','last_step','error','cancel_requested','created_at','updated_at','started_at','finished_at'];
      const basicList = basicCols.filter(c => colNames.includes(c)).join(', ');
      if (basicList) db.exec(`INSERT INTO tasks_new (${basicList}) SELECT ${basicList} FROM tasks;`);
    }
    db.exec('DROP TABLE tasks;');
    db.exec('ALTER TABLE tasks_new RENAME TO tasks;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, id);');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_steps (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL,
      seq        INTEGER NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'note',
      title      TEXT NOT NULL,
      detail     TEXT,
      status     TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'running', 'done', 'failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps (task_id, seq)');

  // Staged workspace proposals (file creates/updates and approved commands).
  // Persisting them lets the user approve a proposal after a server restart.
  // `status` is also the crash guard: an application is claimed
  // (pending -> applying) before any file is touched, and a row left in
  // `applying` is reconciled at startup instead of being repeated.
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id               TEXT PRIMARY KEY,
      project_id       INTEGER NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('create', 'update', 'command')),
      path             TEXT,
      content          TEXT,
      original_content TEXT,
      diff             TEXT,
      command          TEXT,
      command_path     TEXT,
      status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'applying', 'applied', 'rejected', 'failed', 'interrupted')),
      error            TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at      TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_proposals_project_status
      ON proposals (project_id, status, created_at)
  `);

  // Ensure the result_json column exists on the proposals table (idempotent
  // migration). It stores a safe, size-limited command outcome so a task can
  // report a real test result later.
  ensureResultColumn(db);

  return db;
}

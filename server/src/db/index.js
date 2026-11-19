// Lightweight persistence using Node's built-in SQLite (zero extra dependencies).
import { DatabaseSync } from 'node:sqlite';
import { ensurePlanColumn, ensureAutonomyColumn } from '../tasks/store.js';
import { ensureResultColumn } from '../proposals/store.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createPostgresDb, POSTGRES_SCHEMA_SQL } from '../storage/postgres-db.js';

function openPersistentDb() {
  const db = createPostgresDb(config);
  db.exec(POSTGRES_SCHEMA_SQL);
  // Idempotent first-account promotion, matching the SQLite migration.
  db.exec(`UPDATE users SET is_admin = 1
           WHERE id = (SELECT MIN(id) FROM users)
             AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)`);
  ensurePlanColumn(db);
  ensureAutonomyColumn(db);
  ensureResultColumn(db);
  return db;
}

/**
 * Opens (and initializes, if needed) the configured database.
 * The path comes from config (DATABASE_PATH in the project-root .env,
 * defaults to server/data/app.db) which lives in a git-ignored folder.
 */
export function openDb() {
  if (config.databaseBackend !== 'sqlite') return openPersistentDb();
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
  // Per-user ownership. Existing rows migrate with owner_id = NULL and are
  // adopted by the first account created after authentication is enabled.
  if (!projectColumns.some((column) => column.name === 'owner_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN owner_id INTEGER');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id, id)');

  // Accounts. Passwords are scrypt hashes; the raw password is never stored.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1))
    );
  `);
  // Migration for databases created before roles existed. Both steps run in
  // one transaction and the promotion is idempotent, so re-running on every
  // boot is safe:
  //   1. add the is_admin column if it is missing (existing rows stay 0);
  //   2. promote the earliest account (MIN(id)) to administrator exactly
  //      once, and only while no administrator exists.
  // The promotion deliberately runs on every boot, not only when the column
  // was just added: if a previous boot crashed between the ALTER TABLE and
  // the promotion UPDATE, the next boot completes it instead of leaving a
  // database with no administrator. The promotion never reassigns an account
  // that is already an administrator. SQLite cannot add a CHECK constraint
  // via ALTER TABLE on an existing column; values are only ever written as
  // 0/1 by the server, so the migrated column is safe without one.
  // NOTE: on a legacy database with several accounts, "earliest" is MIN(id),
  // which may not be the intended administrator. Verify after deploying and
  // correct out of band if needed (see docs/FIRST-ACCOUNT-BOOTSTRAP.md).
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  const hasAdminColumn = userColumns.some((column) => column.name === 'is_admin');
  db.exec('BEGIN');
  try {
    if (!hasAdminColumn) {
      db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`UPDATE users SET is_admin = 1
             WHERE id = (SELECT MIN(id) FROM users)
               AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* best effort: the transaction rolls back on close */ }
    throw error;
  }

  // Google sign-in: link the stable Google "sub" to the account that uses it.
  // SQLite unique indexes treat NULLs as distinct, so password-only accounts
  // (google_sub unset) never collide.
  const userColumnsFinal = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumnsFinal.some((column) => column.name === 'google_sub')) {
    db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub)');
  // Match the Postgres schema and keep case-insensitive email lookups indexed
  // even for legacy rows that were stored with mixed case.
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email))');

  // One-time OAuth state values for the Google sign-in flow. Only the
  // SHA-256 hash of each state is stored, and rows are consumed (deleted)
  // on use. `allow_create` captures the outcome of the server-side checks
  // made when the flow was started, so the callback never re-trusts a
  // browser-supplied verdict.
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash   TEXT PRIMARY KEY,
      bootstrap_ok INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap_ok IN (0, 1)),
      allow_create INTEGER NOT NULL DEFAULT 0 CHECK (allow_create IN (0, 1)),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    );
  `);

  // Bearer sessions. Only the SHA-256 hash of each token is stored, so a leaked
  // database file cannot be replayed as a live session.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash   TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL,
      last_used_at TEXT
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)');

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

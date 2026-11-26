// Postgres-shaped synchronous database facade used by Neon Free (or PGlite in
// local tests). It intentionally implements only the small node:sqlite surface
// the application uses: exec(), prepare().run/get/all(), and close().

import { createStorageBridge } from './bridge.js';

const NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z'`;

export const POSTGRES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    root_path  TEXT,
    owner_id   BIGINT,
    import_key TEXT,
    created_at TEXT NOT NULL DEFAULT (${NOW})
  );
  CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id, id);
  -- Additive migration for databases created before concurrent imports were
  -- made idempotent. Existing rows keep import_key = NULL and are untouched.
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS import_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_import_key ON projects (import_key);

  CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (${NOW}),
    is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
    google_sub    TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users (google_sub);
  -- Resolve legacy duplicate administrators only; no account is promoted at
  -- startup. The first administrator comes from /api/auth/admin/provision.
  UPDATE users SET is_admin = 0
   WHERE is_admin = 1
     AND id <> (SELECT MIN(id) FROM users WHERE is_admin = 1);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_admin ON users (is_admin) WHERE is_admin = 1;

  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash       TEXT PRIMARY KEY,
    allow_create     INTEGER NOT NULL DEFAULT 0 CHECK (allow_create IN (0, 1)),
    setup_authorized INTEGER NOT NULL DEFAULT 0 CHECK (setup_authorized IN (0, 1)),
    setup_grant_hash TEXT,
    created_at       TEXT NOT NULL DEFAULT (${NOW}),
    expires_at       TEXT NOT NULL
  );
  ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS setup_authorized
    INTEGER NOT NULL DEFAULT 0 CHECK (setup_authorized IN (0, 1));
  ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS setup_grant_hash TEXT;
  DELETE FROM oauth_states WHERE setup_authorized = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_states_single_setup
    ON oauth_states (setup_authorized) WHERE setup_authorized = 1;

  -- The owner setup credential is independent of the administrator token. Only
  -- its SHA-256 hash is stored; expiry starts on first exchange and consumption
  -- happens only after a successful first account is created.
  CREATE TABLE IF NOT EXISTS setup_credentials (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    credential_hash TEXT NOT NULL UNIQUE,
    grant_hash      TEXT,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    consumed_at     TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_setup_credentials_grant
    ON setup_credentials (grant_hash) WHERE grant_hash IS NOT NULL;

  -- First-account grants: one short-lived, single-use opaque authorization.
  -- The raw value never reaches this table; only its SHA-256 hash is stored.
  -- bound_state_hash permits one active flow while allowing a failed callback
  -- to retry with the same grant.
  CREATE TABLE IF NOT EXISTS setup_authorizations (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    token_hash       TEXT NOT NULL UNIQUE,
    bound_state_hash TEXT,
    created_at       TEXT NOT NULL DEFAULT (${NOW}),
    expires_at       TEXT NOT NULL
  );
  ALTER TABLE setup_authorizations ADD COLUMN IF NOT EXISTS bound_state_hash TEXT;
  CREATE INDEX IF NOT EXISTS idx_setup_authorizations_expires
    ON setup_authorizations (expires_at);

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash           TEXT PRIMARY KEY,
    user_id              BIGINT NOT NULL,
    created_at           TEXT NOT NULL DEFAULT (${NOW}),
    expires_at           TEXT NOT NULL,
    absolute_expires_at  TEXT,
    last_used_at         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id         BIGSERIAL PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE IF NOT EXISTS file_changes (
    id         BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL,
    path       TEXT NOT NULL,
    action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    source     TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'agent')),
    diff       TEXT,
    created_at TEXT NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id               BIGSERIAL PRIMARY KEY,
    project_id       BIGINT NOT NULL,
    instruction      TEXT NOT NULL,
    autonomy         TEXT NOT NULL DEFAULT 'propose'
                     CHECK (autonomy IN ('supervised', 'propose', 'approved_autonomous', 'allow_writes', 'allow_writes_and_commands')),
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'waiting_approval', 'provider_paused', 'completed', 'failed', 'cancelled')),
    last_step        TEXT,
    error            TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (${NOW}),
    updated_at       TEXT NOT NULL DEFAULT (${NOW}),
    started_at       TEXT,
    finished_at      TEXT,
    plan_json        TEXT,
    autonomous       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, id);

  CREATE TABLE IF NOT EXISTS task_steps (
    id         BIGSERIAL PRIMARY KEY,
    task_id    BIGINT NOT NULL,
    seq        INTEGER NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'note',
    title      TEXT NOT NULL,
    detail     TEXT,
    status     TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    created_at TEXT NOT NULL DEFAULT (${NOW})
  );
  CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps (task_id, seq);

  CREATE TABLE IF NOT EXISTS proposals (
    id               TEXT PRIMARY KEY,
    project_id       BIGINT NOT NULL,
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
    created_at       TEXT NOT NULL DEFAULT (${NOW}),
    updated_at       TEXT NOT NULL DEFAULT (${NOW}),
    finished_at      TEXT,
    result_json      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_project_status
    ON proposals (project_id, status, created_at);
`;

/**
 * Additive migration for persistent stores created before bounded sliding
 * renewal. Existing sessions retain their old hard expiry as the cap instead
 * of being silently extended.
 */
export function ensureSessionAbsoluteExpiryColumn(db) {
  db.exec('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS absolute_expires_at TEXT');
  db.exec('UPDATE sessions SET absolute_expires_at = expires_at WHERE absolute_expires_at IS NULL');
}

export function createPostgresDb(config) {
  const backend = config.databaseBackend === 'pglite' ? 'pglite' : 'pg';
  const bridge = createStorageBridge({
    config,
    backend,
    timeoutMs: config.storageBridgeTimeoutMs,
  });

  function exec(sql) {
    return bridge.call('sql', { sql, params: [], mode: 'exec' });
  }

  function prepare(sql) {
    return {
      run(...params) {
        return bridge.call('sql', { sql, params, mode: 'run' });
      },
      get(...params) {
        return bridge.call('sql', { sql, params, mode: 'get' });
      },
      all(...params) {
        return bridge.call('sql', { sql, params, mode: 'all' });
      },
    };
  }

  return {
    dialect: 'postgres',
    backend,
    exec,
    prepare,
    bridge,
    close() {
      // Ask the worker to end its pg/PGlite client before terminating it, so
      // sockets and WASM resources are released on every open/close cycle.
      try { bridge.call('close'); } catch { /* best effort during shutdown */ }
      bridge.close();
    },
  };
}

// First-account setup authorization.
//
// FIRST_ACCOUNT_SETUP_TOKEN is a distinct owner credential used only to open
// the first-account setup flow. BOOTSTRAP_TOKEN is reserved exclusively for
// administrator provisioning and is never accepted here. The owner credential
// is exchanged server-side for a short-lived opaque grant; only SHA-256 hashes
// of the credential, grant, and bound OAuth state are persisted. The raw
// values never reach Google, the logs, or browser storage.
import crypto from 'node:crypto';
import { hashToken } from './index.js';

const SETUP_TTL_MS = 10 * 60 * 1000;

export { SETUP_TTL_MS };

// HttpOnly retry cookie used only by /api/auth/google/start while the first
// account is still missing. It carries a fresh random handle, never the owner
// credential or the opaque setup grant. Only its hash is stored server-side.
export const SETUP_RETRY_COOKIE = 'myai_setup_retry';

export function createSetupRetryHandle() {
  return crypto.randomBytes(32).toString('hex');
}

export function setupRetryHash(value) {
  return hashToken(typeof value === 'string' ? value.trim() : '');
}

function nowIso() {
  return new Date().toISOString();
}

/** Opaque, high-entropy value returned to the browser once; never persisted raw. */
export function createSetupToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function setupCredentialHash(value) {
  return hashToken(typeof value === 'string' ? value.trim() : '');
}

export function countUsers(db) {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
}

/**
 * Activates the owner setup credential and replaces any prior grant. The
 * credential's expiry starts on first use; the opaque grant inherits the
 * remaining lifetime. Re-exchanging an already consumed or expired credential
 * fails closed, so a completed setup cannot be reopened with the same secret.
 */
export function issueSetupAuthorization(db, credentialHash) {
  const existing = db.prepare(
    'SELECT credential_hash, created_at, expires_at, consumed_at FROM setup_credentials WHERE id = 1',
  ).get();

  let createdAt;
  let expiresAt;
  if (existing && existing.credential_hash === credentialHash) {
    if (existing.consumed_at) return { status: 'consumed' };
    if (Date.parse(existing.expires_at) <= Date.now()) return { status: 'expired' };
    createdAt = existing.created_at;
    expiresAt = existing.expires_at;
  } else {
    createdAt = nowIso();
    expiresAt = new Date(Date.now() + SETUP_TTL_MS).toISOString();
    db.prepare(`
      INSERT INTO setup_credentials (id, credential_hash, grant_hash, created_at, expires_at, consumed_at)
      VALUES (1, ?, NULL, ?, ?, NULL)
      ON CONFLICT (id) DO UPDATE SET
        credential_hash = excluded.credential_hash,
        grant_hash = NULL,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        consumed_at = NULL
    `).run(credentialHash, createdAt, expiresAt);
  }

  // A new grant invalidates every state issued by an older grant. This keeps a
  // single active setup-authorized OAuth state even when the setup page reloads.
  db.prepare('DELETE FROM oauth_states WHERE setup_authorized = 1').run();

  const token = createSetupToken();
  const retryHandle = createSetupRetryHandle();
  const tokenHash = hashToken(token);
  const retryHash = setupRetryHash(retryHandle);
  db.prepare(`
    INSERT INTO setup_authorizations
      (id, token_hash, retry_handle_hash, bound_state_hash, created_at, expires_at)
    VALUES (1, ?, ?, NULL, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      token_hash = excluded.token_hash,
      retry_handle_hash = excluded.retry_handle_hash,
      bound_state_hash = NULL,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).run(tokenHash, retryHash, createdAt, expiresAt);
  db.prepare('UPDATE setup_credentials SET grant_hash = ?, consumed_at = NULL WHERE id = 1').run(tokenHash);

  return { status: 'ok', token, retryHandle, expiresAt };
}

/**
 * Validates a grant without consuming it. A password registration requires an
 * unbound grant; a Google flow may rebind the same grant to a fresh state so a
 * failed callback can be retried without a new owner secret.
 */
export function checkSetupGrant(db, token, { requireUnbound = false, expectedStateHash = undefined } = {}) {
  if (typeof token !== 'string' || !token.trim()) return null;
  const tokenHash = hashToken(token.trim());
  const row = db.prepare(`
    SELECT a.token_hash, a.expires_at, a.bound_state_hash, c.expires_at AS credential_expires_at
    FROM setup_authorizations a
    JOIN setup_credentials c ON c.id = 1 AND c.grant_hash = a.token_hash
    WHERE a.id = 1 AND a.token_hash = ? AND c.consumed_at IS NULL
  `).get(tokenHash);
  return checkGrantRow(row, { requireUnbound, expectedStateHash });
}

/** Same validation as checkSetupGrant, for the hash carried by an OAuth state. */
export function checkSetupGrantHash(db, tokenHash, { expectedStateHash = undefined } = {}) {
  if (typeof tokenHash !== 'string' || !tokenHash) return null;
  const row = db.prepare(`
    SELECT a.token_hash, a.expires_at, a.bound_state_hash, c.expires_at AS credential_expires_at
    FROM setup_authorizations a
    JOIN setup_credentials c ON c.id = 1 AND c.grant_hash = a.token_hash
    WHERE a.id = 1 AND a.token_hash = ? AND c.consumed_at IS NULL
  `).get(tokenHash);
  return checkGrantRow(row, { expectedStateHash });
}

/**
 * Validates the HttpOnly retry cookie handle. It is useful only while the
 * same still-unconsumed setup grant is valid; it inherits that grant's expiry
 * and can never outlive or replace it. A matched but expired handle is cleared
 * server-side as well as expiring in the browser.
 */
export function checkSetupRetryAuthorization(db, handle) {
  if (typeof handle !== 'string' || !handle.trim()) return null;
  const hash = setupRetryHash(handle);
  const row = db.prepare(`
    SELECT a.token_hash, a.expires_at, c.expires_at AS credential_expires_at, c.consumed_at
    FROM setup_authorizations a
    JOIN setup_credentials c ON c.id = 1 AND c.grant_hash = a.token_hash
    WHERE a.id = 1 AND a.retry_handle_hash = ?
  `).get(hash);
  if (!row) return null;
  const expiresAtMs = Math.min(Date.parse(row.expires_at), Date.parse(row.credential_expires_at));
  if (!Number.isFinite(expiresAtMs) || row.consumed_at || expiresAtMs <= Date.now()) {
    clearSetupRetryHandle(db);
    return null;
  }
  return { grantHash: row.token_hash, expiresAt: new Date(expiresAtMs).toISOString() };
}

/** Invalidates the retry record without touching the setup grant itself. */
export function clearSetupRetryHandle(db) {
  db.prepare('UPDATE setup_authorizations SET retry_handle_hash = NULL WHERE id = 1').run();
}

function checkGrantRow(row, { requireUnbound = false, expectedStateHash = undefined } = {}) {
  if (!row) return null;
  const grantExpiry = Date.parse(row.expires_at);
  const credentialExpiry = Date.parse(row.credential_expires_at);
  const expiresAtMs = Math.min(grantExpiry, credentialExpiry);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
  if (requireUnbound && row.bound_state_hash !== null) return null;
  if (expectedStateHash !== undefined && row.bound_state_hash !== expectedStateHash) return null;
  return {
    tokenHash: row.token_hash,
    boundStateHash: row.bound_state_hash,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/** Binds a grant to one OAuth state, replacing any previous retry binding. */
export function bindSetupGrant(db, tokenHash, stateHash) {
  db.prepare(
    'UPDATE setup_authorizations SET bound_state_hash = ? WHERE id = 1 AND token_hash = ?',
  ).run(stateHash, tokenHash);
}

/**
 * Atomically consumes a grant after a successful first-account insert. The
 * owner credential is marked consumed in the same statement sequence, so it
 * cannot be exchanged for another grant on this database.
 */
export function consumeSetupGrant(db, token) {
  const grant = checkSetupGrant(db, token, { requireUnbound: true });
  return grant ? consumeGrantHash(db, grant.tokenHash) : false;
}

export function consumeSetupGrantHash(db, tokenHash, stateHash) {
  const grant = checkSetupGrantHash(db, tokenHash, { expectedStateHash: stateHash });
  return grant ? consumeGrantHash(db, grant.tokenHash) : false;
}

function consumeGrantHash(db, tokenHash) {
  // Both statements are conditional. If a concurrent writer replaced or already
  // consumed the grant, the row counts make this a no-op instead of a false
  // success that could create a second first account.
  db.prepare(
    'UPDATE setup_authorizations SET retry_handle_hash = NULL WHERE id = 1 AND token_hash = ?',
  ).run(tokenHash);
  const deleted = db.prepare('DELETE FROM setup_authorizations WHERE id = 1 AND token_hash = ?').run(tokenHash);
  if (!deleted?.changes) return false;
  const updated = db.prepare(
    'UPDATE setup_credentials SET grant_hash = NULL, consumed_at = ? WHERE id = 1 AND grant_hash = ?',
  ).run(nowIso(), tokenHash);
  return Boolean(updated?.changes);
}

/** Clears setup state once setup is complete or the owner re-exchanges. */
export function clearSetupAuthorizations(db) {
  db.prepare('DELETE FROM setup_authorizations').run();
  db.prepare('DELETE FROM oauth_states WHERE setup_authorized = 1').run();
  db.prepare(
    'UPDATE setup_credentials SET grant_hash = NULL, consumed_at = COALESCE(consumed_at, ?) WHERE id = 1',
  ).run(nowIso());
}

/**
 * Serializes first-account checks with the write that follows them. SQLite uses
 * an immediate transaction, so two concurrent first registrations cannot both
 * observe an empty users table. Postgres uses an explicit table lock because a
 * plain READ COMMITTED transaction would let two app processes both see an
 * empty table before either insert commits. Scrypt work is done before this
 * transaction opens, so the lock is held only for short database work.
 */
export function withWriteTransaction(db, fn) {
  const postgres = db.dialect === 'postgres';
  db.exec(postgres ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    if (postgres) db.exec('LOCK TABLE users IN EXCLUSIVE MODE');
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* best effort: the transaction is doomed */ }
    throw error;
  }
}

// Authentication and per-user project ownership.
//
// Zero extra dependencies: passwords use Node's built-in scrypt, session
// tokens are random 256-bit values, and only the SHA-256 hash of each token is
// stored in SQLite. Raw tokens never touch the database or any log line.
import crypto from 'node:crypto';
import { config } from '../config.js';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 254;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DAY_MS = 24 * 60 * 60 * 1000;
// Existing architecture has one opaque DB-backed token per sign-in. We renew
// that same session on activity, bounded by an absolute lifetime so continuous
// use cannot keep a token alive forever. No new token type is introduced.
const SESSION_ABSOLUTE_MULTIPLIER = 3;
const SESSION_ABSOLUTE_MAX_DAYS = 90;

function absoluteSessionDays(days) {
  const configured = Number.isFinite(days) && days > 0 ? days : 30;
  return Math.max(configured, Math.min(configured * SESSION_ABSOLUTE_MULTIPLIER, SESSION_ABSOLUTE_MAX_DAYS));
}

// Stand-in hash used when an email is unknown, so a failed login costs the same
// scrypt work as a wrong password and does not reveal whether the account exists.
const DUMMY_SALT = Buffer.alloc(16, 7);
const DUMMY_HASH = crypto.scryptSync('not-the-password', DUMMY_SALT, SCRYPT_KEYLEN, {
  N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
});

/** A user object used only by tests that build the app with `{ auth: false }`. */
export const BYPASS_USER = Object.freeze({ id: 0, email: 'local-bypass', bypass: true });

export function isBypassUser(user) {
  return Boolean(user && user.bypass === true);
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null;
  if (!EMAIL_PATTERN.test(email)) return null;
  return email;
}

/** Returns null when the password is acceptable, otherwise a public message. */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltHex, hashHex] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Performs the same work as a real verification so unknown-email logins do not
 * complete noticeably faster than wrong-password logins.
 */
export function burnPasswordCheck(password) {
  try {
    crypto.scryptSync(typeof password === 'string' ? password : '', DUMMY_SALT, SCRYPT_KEYLEN, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    // Ignore: this is only a timing equalizer.
  }
  crypto.timingSafeEqual(DUMMY_HASH, DUMMY_HASH);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Creates a session and returns the raw token exactly once. */
export function createSession(db, userId, days = config.authSessionDays) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const sessionDays = Number.isFinite(days) && days > 0 ? days : config.authSessionDays;
  const expiresAt = new Date(now.getTime() + sessionDays * DAY_MS).toISOString();
  // Legacy rows migrated with absolute_expires_at = expires_at, so they never
  // gain extra lifetime. New sessions get a bounded sliding window.
  const absoluteExpiresAt = new Date(
    now.getTime() + absoluteSessionDays(sessionDays) * DAY_MS,
  ).toISOString();
  db.prepare(
    `INSERT INTO sessions
       (token_hash, user_id, created_at, expires_at, absolute_expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    userId,
    now.toISOString(),
    expiresAt,
    absoluteExpiresAt,
    now.toISOString(),
  );
  return { token, expiresAt, absoluteExpiresAt };
}

/**
 * Resolves a raw bearer token to its user. A live session is renewed for the
 * configured window on each authenticated request, but never past its absolute
 * expiry. Expired, malformed, or unknown tokens are rejected and never renewed.
 */
export function findSessionUser(db, token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const tokenHash = hashToken(token);
  const row = db.prepare(`
    SELECT s.token_hash, s.expires_at, s.absolute_expires_at,
           u.id, u.email, u.created_at, u.is_admin
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash);
  if (!row) return null;
  const now = Date.now();
  const absoluteMs = Date.parse(row.absolute_expires_at || row.expires_at);
  if (Date.parse(row.expires_at) <= now || absoluteMs <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  const renewedMs = Math.min(
    now + config.authSessionDays * DAY_MS,
    Number.isFinite(absoluteMs) ? absoluteMs : now,
  );
  const renewedExpiresAt = new Date(renewedMs).toISOString();
  db.prepare('UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE token_hash = ?')
    .run(renewedExpiresAt, new Date(now).toISOString(), tokenHash);
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    isAdmin: Boolean(row.is_admin),
    expiresAt: renewedExpiresAt,
    absoluteExpiresAt: row.absolute_expires_at || row.expires_at,
  };
}

export function deleteSession(db, token) {
  if (typeof token !== 'string' || token.length < 20) return false;
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)).changes > 0;
}

export function deleteExpiredSessions(db) {
  const now = new Date().toISOString();
  return db.prepare(`
    DELETE FROM sessions
    WHERE expires_at <= ?
       OR (absolute_expires_at IS NOT NULL AND absolute_expires_at <= ?)
  `).run(now, now).changes;
}

/** Reads `Authorization: Bearer <token>` without logging or echoing it. */
export function bearerToken(req) {
  const header = typeof req.get === 'function' ? req.get('authorization') : req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Express middleware: rejects anonymous requests with 401 and attaches
 * `req.user` (and `req.authToken`) for authenticated requests.
 */
export function requireAuth(db) {
  return (req, res, next) => {
    const token = bearerToken(req);
    const user = token ? findSessionUser(db, token) : null;
    if (!user) {
      // `code` lets the web client tell a real session failure apart from an
      // upstream AI provider that also answers 401 (see /api/chat).
      return res.status(401).json({
        ok: false,
        code: 'AUTH_REQUIRED',
        error: 'Authentication required.',
      });
    }
    req.user = user;
    req.authToken = token;
    return next();
  };
}

/** Test-only middleware that marks every request as the local bypass user. */
export function bypassAuth() {
  return (req, res, next) => {
    req.user = BYPASS_USER;
    req.authToken = null;
    next();
  };
}

/**
 * Looks up a project only if it belongs to the current user.
 * In bypass mode (tests only) any existing project is visible.
 */
export function findOwnedProject(db, user, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) return null;
  if (isBypassUser(user)) {
    return db.prepare('SELECT id, owner_id FROM projects WHERE id = ?').get(id) ?? null;
  }
  if (!user || !Number.isInteger(user.id)) return null;
  return db
    .prepare('SELECT id, owner_id FROM projects WHERE id = ? AND owner_id = ?')
    .get(id, user.id) ?? null;
}

/** Assigns legacy projects that predate accounts to the first registered user. */
export function claimUnclaimedProjects(db, userId) {
  return db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL').run(userId).changes;
}

/**
 * Small in-memory limiter for register/login attempts. No dependency and no
 * persistence: a restart simply clears the counters. Expired entries are
 * swept once the map grows past a size cap so long-running processes do not
 * accumulate stale keys.
 */
export function createAttemptLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map();
  const MAX_ENTRIES = 5_000;
  return function hit(key) {
    const now = Date.now();
    if (attempts.size > MAX_ENTRIES) {
      for (const [entryKey, entry] of attempts) {
        if (entry.resetAt <= now) attempts.delete(entryKey);
      }
    }
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }
    entry.count += 1;
    if (entry.count > max) {
      return { allowed: false, retryAfterMs: entry.resetAt - now };
    }
    return { allowed: true };
  };
}

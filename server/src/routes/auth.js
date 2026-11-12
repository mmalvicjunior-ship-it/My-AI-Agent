// Account endpoints: register, login, logout and session verification.
// Mounted at /api/auth before the global authentication middleware so that
// these routes are the only public write endpoints besides /api/health.
import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import {
  bearerToken,
  createAttemptLimiter,
  createSession,
  deleteSession,
  findSessionUser,
  hashPassword,
  normalizeEmail,
  validatePassword,
  verifyPassword,
  burnPasswordCheck,
  claimUnclaimedProjects,
} from '../auth/index.js';

function publicUser(row) {
  return { id: row.id, email: row.email };
}

function clientKey(req) {
  // req.ip honors the `trust proxy` setting configured on the app, so this is
  // the client IP for one trusted proxy hop and the socket address when the
  // server is reached directly. It never blindly adopts client-supplied
  // X-Forwarded-For entries beyond the trusted hop count.
  return `${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

/**
 * Compares two strings without leaking length or prefix through timing.
 * Returns false for empty inputs, so a missing expected token never passes.
 */
function tokensEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string'
    || provided === '' || expected === '') {
    return false;
  }
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

/** 429 responder: always carries a Retry-After header (seconds) and body field. */
function rejectRateLimited(res, limit, message) {
  const retryAfterSeconds = Math.max(1, Math.ceil((limit.retryAfterMs ?? 15 * 60 * 1000) / 1000));
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({ ok: false, error: message, retryAfterSeconds });
}

export function createAuthRouter({ db }) {
  const router = express.Router();
  const registerLimiter = createAttemptLimiter({ max: 10 });
  // Login brute-force is counted per (IP, email) pair so one client hammering
  // an account does not lock out every other account on a shared proxy or
  // CGNAT address. A coarser per-IP backstop still caps password spraying
  // from one source at 50 attempts per window.
  const loginLimiter = createAttemptLimiter({ max: 10 });
  const loginBackstopLimiter = createAttemptLimiter({ max: 50 });

  router.post('/register', (req, res) => {
    const limit = registerLimiter(clientKey(req));
    if (!limit.allowed) {
      return rejectRateLimited(res, limit, 'Too many registration attempts. Try again later.');
    }

    // Bootstrap protection: while the users table is empty, nobody can register
    // without the server-side BOOTSTRAP_TOKEN. This applies even when
    // ALLOW_REGISTRATION=false, so initial account creation can never be
    // locked out by an ordinary env flag, and an unknown public visitor can
    // never become the first account.
    const userCount = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
    if (userCount === 0) {
      const provided = typeof req.body?.bootstrapToken === 'string' ? req.body.bootstrapToken.trim() : '';
      if (!tokensEqual(provided, config.bootstrapToken)) {
        return res.status(403).json({
          ok: false,
          error: 'Creating the first account requires the server bootstrap token. Set BOOTSTRAP_TOKEN in the server environment and enter it on the registration form.',
        });
      }
    } else if (!config.allowRegistration) {
      return res.status(403).json({ ok: false, error: 'Registration is disabled on this server.' });
    }

    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ ok: false, error: 'A valid email address is required.' });
    }
    const passwordError = validatePassword(req.body?.password);
    if (passwordError) {
      return res.status(400).json({ ok: false, error: passwordError });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'An account with this email already exists.' });
    }

    let userId;
    try {
      const result = db
        .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
        .run(email, hashPassword(req.body.password));
      userId = Number(result.lastInsertRowid);
    } catch (error) {
      // Unique constraint race with another registration for the same email.
      if (String(error?.message || '').includes('UNIQUE')) {
        return res.status(409).json({ ok: false, error: 'An account with this email already exists.' });
      }
      throw error;
    }

    // The first account adopts pre-authentication projects so existing local
    // data remains reachable. Later accounts never inherit another user's data.
    if (userCount === 0) claimUnclaimedProjects(db, userId);

    const session = createSession(db, userId, config.authSessionDays);
    return res.status(201).json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: userId, email },
    });
  });

  router.post('/login', (req, res) => {
    const ip = clientKey(req);
    const backstop = loginBackstopLimiter(ip);
    if (!backstop.allowed) {
      return rejectRateLimited(res, backstop, 'Too many login attempts from this address. Try again later.');
    }
    const email = normalizeEmail(req.body?.email);
    const limit = email ? loginLimiter(`${ip}:${email}`) : { allowed: true };
    if (!limit.allowed) {
      return rejectRateLimited(res, limit, 'Too many login attempts. Try again later.');
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required.' });
    }

    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
    if (!user) {
      burnPasswordCheck(password);
      return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
    }
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
    }

    const session = createSession(db, user.id, config.authSessionDays);
    return res.json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: publicUser(user),
    });
  });

  // Idempotent: a missing or already-invalid token still reports success and
  // never reveals whether the token existed.
  router.post('/logout', (req, res) => {
    const token = bearerToken(req);
    if (token) deleteSession(db, token);
    return res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const token = bearerToken(req);
    const user = token ? findSessionUser(db, token) : null;
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Authentication required.' });
    }
    return res.json({ ok: true, user: publicUser(user) });
  });

  return router;
}

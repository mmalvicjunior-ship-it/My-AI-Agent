// Account endpoints: register, login, logout and session verification.
// Mounted at /api/auth before the global authentication middleware so that
// these routes are the only public write endpoints besides /api/health.
import crypto from 'node:crypto';
import express from 'express';
import { config, redactSecrets } from '../config.js';
import {
  bearerToken,
  createAttemptLimiter,
  createSession,
  deleteSession,
  findSessionUser,
  hashPassword,
  hashToken,
  normalizeEmail,
  validatePassword,
  verifyPassword,
  burnPasswordCheck,
  claimUnclaimedProjects,
} from '../auth/index.js';
import {
  googleAuthorizeUrl,
  verifyGoogleIdentity,
  createOAuthState,
  STATE_TTL_MS,
} from '../auth/google.js';

function publicUser(row) {
  // row may be either a raw database row (is_admin) or the session projection
  // returned by findSessionUser (isAdmin). Normalize to one public shape.
  const rawAdmin = row.is_admin === undefined ? row.isAdmin : row.is_admin;
  return { id: row.id, email: row.email, isAdmin: Boolean(rawAdmin) };
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
  // Google sign-in has its own bucket so a broken third party can never lock
  // out email/password authentication.
  const googleLimiter = createAttemptLimiter({ max: 20 });

  /** True only when every value needed for the Google flow is configured. */
  function googleConfigured(cfg) {
    return Boolean(cfg.googleClientId && cfg.googleClientSecret && cfg.googleRedirectUri);
  }


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
          error: 'Creating the first account requires the server bootstrap token. Provide it via the setup URL (#bootstrap=<token>) when registering the first account.',
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
      // The first account becomes the administrator; later accounts are
      // ordinary users and can never self-promote to admin.
      const isAdmin = userCount === 0;
      const result = db
        .prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)')
        .run(email, hashPassword(req.body.password), isAdmin ? 1 : 0);
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
      user: { id: userId, email, isAdmin: userCount === 0 },
    });
  });

  router.post('/google/start', (req, res) => {
    const limit = googleLimiter(clientKey(req));
    if (!limit.allowed) {
      return rejectRateLimited(res, limit, 'Too many sign-in attempts. Try again later.');
    }
    if (!googleConfigured(config)) {
      return res.status(503).json({ ok: false, error: 'Google sign-in is not configured on this server.' });
    }
    const userCount = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
    const provided = typeof req.body?.bootstrapToken === 'string' ? req.body.bootstrapToken.trim() : '';
    // The FIRST account is always governed by the bootstrap protection, even
    // when it is created through Google. Fail here, not after a round trip.
    if (userCount === 0 && !tokensEqual(provided, config.bootstrapToken)) {
      return res.status(403).json({
        ok: false,
        error: 'Creating the first account requires the server bootstrap token. Provide it via the setup URL (#bootstrap=<token>) when registering the first account.',
      });
    }
    const bootstrapOk = userCount === 0 ? 1 : 0;
    const allowCreate = (userCount === 0 ? bootstrapOk === 1 : Boolean(config.allowRegistration)) ? 1 : 0;

    const state = createOAuthState();
    // One-time state, stored only as a SHA-256 hash, valid for 10 minutes.
    db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(new Date().toISOString());
    db.prepare('INSERT INTO oauth_states (state_hash, bootstrap_ok, allow_create, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(state), bootstrapOk, allowCreate, new Date(Date.now() + STATE_TTL_MS).toISOString());
    return res.json({
      ok: true,
      url: googleAuthorizeUrl({ clientId: config.googleClientId, redirectUri: config.googleRedirectUri, state }),
    });
  });

  router.get('/google/callback', async (req, res) => {
    const limit = googleLimiter(clientKey(req));
    if (!limit.allowed) {
      return rejectRateLimited(res, limit, 'Too many sign-in attempts. Try again later.');
    }
    const origin = typeof config.appOrigin === 'string' ? config.appOrigin.replace(/\/+$/, '') : '';
    const redirectWithError = (code) => res.redirect(302, `${origin}/#auth_error=${encodeURIComponent(code)}`);
    if (!googleConfigured(config)) return redirectWithError('google_not_configured');

    // Google reports user cancellation through the `error` query parameter.
    if (typeof req.query.error === 'string' && req.query.error) return redirectWithError('google_cancelled');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) return redirectWithError('google_state');

    // Consume the state atomically: the row is deleted and returned in one
    // statement, so a replayed or concurrent second callback finds nothing.
    const stateHash = hashToken(state);
    const stateRow = db.prepare(
      'DELETE FROM oauth_states WHERE state_hash = ? RETURNING bootstrap_ok, allow_create, expires_at',
    ).get(stateHash);
    if (!stateRow) return redirectWithError('google_state');
    if (new Date(stateRow.expires_at).getTime() <= Date.now()) return redirectWithError('google_state');

    let identity;
    try {
      identity = await verifyGoogleIdentity({
        code,
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: config.googleRedirectUri,
      });
    } catch (error) {
      return redirectWithError(error && error.code ? error.code : 'google_identity_invalid');
    }

    try {
      const normalized = normalizeEmail(identity.email);
      if (!normalized) return redirectWithError('google_identity_invalid');

      const finish = (userId) => {
        const session = createSession(db, userId, config.authSessionDays);
        return res.redirect(302, `${origin}/#auth_token=${session.token}&auth_expires=${encodeURIComponent(session.expiresAt)}`);
      };

      const bySub = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(identity.sub);
      if (bySub) return finish(bySub.id);

      const existing = db.prepare('SELECT id, google_sub FROM users WHERE email = ?').get(normalized);
      if (existing) {
        // Never silently link a password account to a Google identity.
        return redirectWithError(existing.google_sub ? 'google_identity_conflict' : 'google_account_exists');
      }

      const userCount = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
      if (userCount === 0) {
        if (stateRow.bootstrap_ok !== 1) return redirectWithError('google_bootstrap_required');
      } else if (stateRow.allow_create !== 1) {
        return redirectWithError('google_registration_disabled');
      }
      const isAdmin = userCount === 0 ? 1 : 0;
      // Google-only accounts get an unusable random password hash: password
      // sign-in is impossible for them; only Google sign-in works.
      const shadowHash = hashPassword(crypto.randomBytes(32).toString('hex'));
      const result = db
        .prepare('INSERT INTO users (email, password_hash, is_admin, google_sub) VALUES (?, ?, ?, ?)')
        .run(normalized, shadowHash, isAdmin, identity.sub);
      const userId = Number(result.lastInsertRowid);
      // The first account adopts pre-authentication projects, like email sign-up.
      if (isAdmin) claimUnclaimedProjects(db, userId);
      return finish(userId);
    } catch (error) {
      console.error('[auth] Google callback failed:', redactSecrets(String(error?.message || error)));
      return redirectWithError('google_identity_invalid');
    }
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

    const user = db.prepare('SELECT id, email, password_hash, is_admin FROM users WHERE email = ?').get(email);
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
      return res.status(401).json({
        ok: false,
        code: 'AUTH_REQUIRED',
        error: 'Authentication required.',
      });
    }
    return res.json({ ok: true, user: publicUser(user) });
  });

  return router;
}

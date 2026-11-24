// Account endpoints: registration, login, logout, session verification, and
// the owner-only first-administrator provisioning endpoint.
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

/** PostgreSQL reports unique violations as SQLSTATE 23505, not "UNIQUE". */
export function isDuplicateEmailError(error) {
  return error?.code === '23505' || /unique constraint/i.test(String(error?.message || ''));
}

const SINGLE_ADMIN_INDEX = 'idx_users_single_admin';

/** True only for the single-admin index, never for email/google_sub collisions. */
export function isSingleAdminViolation(error) {
  const message = String(error?.message || '');
  if (error?.code !== '23505' && !/unique constraint/i.test(message)) return false;
  return message.includes(SINGLE_ADMIN_INDEX)
    || /UNIQUE constraint failed:\s*users\.is_admin/i.test(message);
}

/**
 * Inserts a user with an explicit role. Only the owner-only provisioning
 * endpoint may pass requestAdmin=true; every public path passes false.
 * The database has a unique partial index on is_admin=1, so a lost provisioning
 * race can never produce a second administrator.
 */
export function createUserWithRole(db, { email, passwordHash, googleSub = null, requestAdmin = false }) {
  const hasGoogleSub = typeof googleSub === 'string' && googleSub.length > 0;
  const sql = hasGoogleSub
    ? 'INSERT INTO users (email, password_hash, is_admin, google_sub) VALUES (?, ?, ?, ?)'
    : 'INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)';
  const values = hasGoogleSub
    ? [email, passwordHash, requestAdmin ? 1 : 0, googleSub]
    : [email, passwordHash, requestAdmin ? 1 : 0];
  const insert = (params) => Number(db.prepare(sql).run(...params).lastInsertRowid);

  try {
    return { id: insert(values), isAdmin: Boolean(requestAdmin) };
  } catch (error) {
    if (!requestAdmin || !isSingleAdminViolation(error)) throw error;
    // Another provisioning attempt committed first. This request must never
    // create a second administrator.
    const retry = [...values];
    retry[2] = 0;
    return { id: insert(retry), isAdmin: false };
  }
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
  // First-administrator provisioning is owner-only and must not share a bucket
  // with ordinary registration traffic.
  const adminProvisionLimiter = createAttemptLimiter({ max: 10 });

  /** True only when every value needed for the Google flow is configured. */
  function googleConfigured(cfg) {
    return Boolean(cfg.googleClientId && cfg.googleClientSecret && cfg.googleRedirectUri);
  }


  router.post('/register', (req, res) => {
    const limit = registerLimiter(clientKey(req));
    if (!limit.allowed) {
      return rejectRateLimited(res, limit, 'Too many registration attempts. Try again later.');
    }

    if (!config.allowRegistration) {
      return res.status(403).json({
        ok: false,
        error: 'New registrations are currently closed. Please contact your administrator.',
      });
    }

    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ ok: false, error: 'A valid email address is required.' });
    }
    const passwordError = validatePassword(req.body?.password);
    if (passwordError) {
      return res.status(400).json({ ok: false, error: passwordError });
    }

    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'An account with this email already exists.' });
    }

    let created;
    try {
      // Public registration can never create an administrator, including when
      // this is the first account or the client sends a role field.
      created = createUserWithRole(db, {
        email,
        passwordHash: hashPassword(req.body.password),
        googleSub: null,
        requestAdmin: false,
      });
    } catch (error) {
      // Unique constraint race with another registration for the same email.
      if (isDuplicateEmailError(error)) {
        return res.status(409).json({ ok: false, error: 'An account with this email already exists.' });
      }
      throw error;
    }

    // Pre-authentication projects are claimed only by the provisioned
    // administrator, never by an arbitrary public registration.

    const session = createSession(db, created.id, config.authSessionDays);
    return res.status(201).json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: created.id, email, isAdmin: false },
    });
  });

  router.post('/google/start', (req, res) => {
    const limit = googleLimiter(clientKey(req));
    if (!limit.allowed) {
      return rejectRateLimited(res, limit, 'Too many sign-in attempts. Try again later.');
    }
    if (!googleConfigured(config)) {
      return res.status(503).json({
        ok: false,
        error: 'Google sign-in is temporarily unavailable. Please try again later.',
      });
    }
    // Ordinary Google sign-in never needs a setup token. New accounts are
    // governed only by the server's registration setting.
    const allowCreate = config.allowRegistration ? 1 : 0;

    const state = createOAuthState();
    // One-time state, stored only as a SHA-256 hash, valid for 10 minutes.
    db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(new Date().toISOString());
    db.prepare('INSERT INTO oauth_states (state_hash, allow_create, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(state), allowCreate, new Date(Date.now() + STATE_TTL_MS).toISOString());
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
      'DELETE FROM oauth_states WHERE state_hash = ? RETURNING allow_create, expires_at',
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

      const existing = db.prepare('SELECT id, google_sub FROM users WHERE lower(email) = ?').get(normalized);
      if (existing) {
        // Never silently link a password account to a Google identity.
        return redirectWithError(existing.google_sub ? 'google_identity_conflict' : 'google_account_exists');
      }

      if (stateRow.allow_create !== 1) {
        return redirectWithError('google_registration_disabled');
      }
      // Google-only accounts get an unusable random password hash: password
      // sign-in is impossible for them; only Google sign-in works. They are
      // always ordinary users; administrators are provisioned separately.
      const shadowHash = hashPassword(crypto.randomBytes(32).toString('hex'));
      let created;
      try {
        created = createUserWithRole(db, {
          email: normalized,
          passwordHash: shadowHash,
          googleSub: identity.sub,
          requestAdmin: false,
        });
      } catch (error) {
        // A concurrent flow may have created the same identity or email between
        // the lookups and the insert. Re-check instead of trusting stale reads.
        if (isDuplicateEmailError(error)) {
          const bySubAfter = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(identity.sub);
          if (bySubAfter) return finish(bySubAfter.id);
          const byEmailAfter = db.prepare('SELECT google_sub FROM users WHERE lower(email) = ?').get(normalized);
          if (byEmailAfter) {
            return redirectWithError(byEmailAfter.google_sub ? 'google_identity_conflict' : 'google_account_exists');
          }
        }
        throw error;
      }
      return finish(created.id);
    } catch (error) {
      console.error('[auth] Google callback failed:', redactSecrets(String(error?.message || error)));
      return redirectWithError('google_identity_invalid');
    }
  });

  /**
   * Owner-only first-administrator provisioning.
   *
   * This is the secure replacement for the old "first account becomes admin"
   * behavior. Ordinary sign-up and Google sign-in never call it and never need
   * a token. The operator supplies the existing server-side BOOTSTRAP_TOKEN
   * directly to this endpoint, either to create a password administrator or to
   * promote an already verified account. It stops working as soon as one
   * administrator exists.
   */
  router.post('/admin/provision', (req, res) => {
    const limit = adminProvisionLimiter(clientKey(req));
    if (!limit.allowed) {
      return rejectRateLimited(res, limit, 'Too many setup attempts. Try again later.');
    }

    const provided = typeof req.body?.bootstrapToken === 'string' ? req.body.bootstrapToken.trim() : '';
    if (!tokensEqual(provided, config.bootstrapToken)) {
      return res.status(403).json({
        ok: false,
        error: 'Administrator setup requires the server setup token.',
      });
    }

    const adminCount = Number(
      db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1').get().count,
    );
    if (adminCount > 0) {
      return res.status(409).json({ ok: false, error: 'Administrator setup is already complete.' });
    }

    const email = normalizeEmail(req.body?.email);
    const googleSub = typeof req.body?.googleSub === 'string' ? req.body.googleSub.trim() : '';

    let existing = null;
    if (email) {
      existing = db.prepare('SELECT id, email, google_sub FROM users WHERE lower(email) = ?').get(email);
    } else if (googleSub) {
      existing = db.prepare('SELECT id, email, google_sub FROM users WHERE google_sub = ?').get(googleSub);
    }

    if (googleSub && existing && existing.google_sub !== googleSub) {
      return res.status(409).json({
        ok: false,
        error: 'That Google identity does not match the account for this email.',
      });
    }

    if (existing) {
      try {
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ? AND is_admin = 0').run(existing.id);
        claimUnclaimedProjects(db, existing.id);
      } catch (error) {
        if (isSingleAdminViolation(error)) {
          return res.status(409).json({ ok: false, error: 'Administrator setup is already complete.' });
        }
        throw error;
      }
      // Existing sessions stay valid: role is read from the database on every
      // request. No new session is minted for a promotion.
      return res.json({
        ok: true,
        created: false,
        user: { id: existing.id, email: existing.email, isAdmin: true },
      });
    }

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: 'Provide an email address for the administrator account.',
      });
    }
    if (googleSub) {
      return res.status(400).json({
        ok: false,
        error: 'A Google identity must sign in once before it can be promoted.',
      });
    }
    const passwordError = validatePassword(req.body?.password);
    if (passwordError) {
      return res.status(400).json({ ok: false, error: passwordError });
    }

    let created;
    let session;
    try {
      created = createUserWithRole(db, {
        email,
        passwordHash: hashPassword(req.body.password),
        googleSub: null,
        requestAdmin: true,
      });
      claimUnclaimedProjects(db, created.id);
      session = createSession(db, created.id, config.authSessionDays);
    } catch (error) {
      if (isSingleAdminViolation(error)) {
        return res.status(409).json({ ok: false, error: 'Administrator setup is already complete.' });
      }
      if (isDuplicateEmailError(error)) {
        return res.status(409).json({ ok: false, error: 'An account with this email already exists.' });
      }
      throw error;
    }

    return res.status(201).json({
      ok: true,
      created: true,
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: created.id, email, isAdmin: true },
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

    const user = db.prepare('SELECT id, email, password_hash, is_admin FROM users WHERE lower(email) = ?').get(email);
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
    // Renewed expiry is metadata only (never a token or secret). The web client
    // stores it so browser refreshes reflect the current DB-backed session.
    return res.json({
      ok: true,
      user: publicUser(user),
      expiresAt: user.expiresAt,
      absoluteExpiresAt: user.absoluteExpiresAt,
    });
  });

  return router;
}

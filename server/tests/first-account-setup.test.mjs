// First-account setup and Google registration security regressions.
//
// These tests exercise the public endpoints, never internal implementation
// shortcuts. They cover the owner-secret exchange, short-lived one-time setup
// authorizations, first-account gates for both email/password and Google,
// duplicate/returning-user handling, privilege boundaries, and per-account
// isolation. All Google calls are mocked; no network or provider request runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { hashToken } from '../src/auth/index.js';
import { withWriteTransaction } from '../src/auth/setup.js';
import {
  authorizeFirstAccount,
  TEST_BOOTSTRAP_TOKEN,
  TEST_SETUP_CREDENTIAL,
} from './setup-authorization.mjs';

const CLIENT_ID = 'first-account-client';
const CLIENT_SECRET = 'first-account-secret';
const REDIRECT_URI = 'http://localhost:5173/api/auth/google/callback';
const PASSWORD = 'correct-horse-battery';

async function withFreshApp(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-first-account-'));
  const original = {
    databasePath: config.databasePath,
    workspaceRoot: config.workspaceRoot,
    allowRegistration: config.allowRegistration,
  };
  config.databasePath = path.join(tempDir, 'fresh.db');
  config.workspaceRoot = path.join(tempDir, 'workspaces');
  config.allowRegistration = true;
  let server;
  try {
    const created = createApp({ provider: null });
    server = created.app.listen(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn({ base, db: created.db });
  } finally {
    server?.closeAllConnections?.();
    server?.close();
    config.databasePath = original.databasePath;
    config.workspaceRoot = original.workspaceRoot;
    config.allowRegistration = original.allowRegistration;
    // Temp files are intentionally left behind where Windows keeps a handle.
  }
}

async function request(base, method, pathname, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, data, headers: res.headers };
}

function setGoogleConfig() {
  const original = {
    googleClientId: config.googleClientId,
    googleClientSecret: config.googleClientSecret,
    googleRedirectUri: config.googleRedirectUri,
    appOrigin: config.appOrigin,
  };
  config.googleClientId = CLIENT_ID;
  config.googleClientSecret = CLIENT_SECRET;
  config.googleRedirectUri = REDIRECT_URI;
  config.appOrigin = '';
  return () => {
    config.googleClientId = original.googleClientId;
    config.googleClientSecret = original.googleClientSecret;
    config.googleRedirectUri = original.googleRedirectUri;
    config.appOrigin = original.appOrigin;
  };
}

function mockGoogleClaims(claims) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ id_token: 'test.id.token' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (target.startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
      return new Response(JSON.stringify(claims), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(url, options);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function claimsFor(sub, email, verified = 'true') {
  return {
    sub,
    email,
    email_verified: verified,
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
  };
}

async function callback(base, state) {
  const res = await fetch(
    `${base}/api/auth/google/callback?${new URLSearchParams({ code: 'test-code', state })}`,
    { redirect: 'manual' },
  );
  return {
    status: res.status,
    headers: res.headers,
    fragment: new URLSearchParams(String(res.headers.get('location') || '').split('#')[1] || ''),
  };
}

async function issueSetup(base, setupCredential = TEST_SETUP_CREDENTIAL) {
  const res = await request(base, 'POST', '/api/auth/setup/authorize', {
    body: { setupCredential },
  });
  return { status: res.status, data: res.data, headers: res.headers, token: res.data?.setupToken };
}

async function register(base, body) {
  return request(base, 'POST', '/api/auth/register', { body });
}

async function startGoogle(base, setupToken) {
  const body = setupToken ? { setupToken } : {};
  return request(base, 'POST', '/api/auth/google/start', { body });
}

function userCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
}

function adminCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c);
}

test('setup status and the independent owner credential exchange stay secret-free', async () => {
  await withFreshApp(async ({ base, db }) => {
    const status = await request(base, 'GET', '/api/auth/setup/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.data, { ok: true, required: true });

    const wrong = await issueSetup(base, 'not-the-owner-secret');
    assert.equal(wrong.status, 403);
    assert.match(wrong.data.error, /setup authorization/i);
    assert.doesNotMatch(wrong.data.error, /BOOTSTRAP_TOKEN|not-the-owner-secret/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM setup_authorizations').get().c, 0);

    // The administrator token is a different secret and must never open setup.
    const adminTokenAsSetup = await issueSetup(base, TEST_BOOTSTRAP_TOKEN);
    assert.equal(adminTokenAsSetup.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM setup_authorizations').get().c, 0);
    const wrongField = await request(base, 'POST', '/api/auth/setup/authorize', {
      body: { bootstrapToken: TEST_BOOTSTRAP_TOKEN },
    });
    assert.equal(wrongField.status, 403, 'the old bootstrapToken field is no longer accepted');

    const first = await issueSetup(base);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.ok(first.token);
    assert.equal(typeof first.data.expiresAt, 'string');
    assert.doesNotMatch(JSON.stringify(first.data), /test-bootstrap-token|test-first-account-setup-token|bootstrap/i);
    const grant = db.prepare('SELECT token_hash FROM setup_authorizations').get();
    assert.equal(grant.token_hash, hashToken(first.token));
    assert.notEqual(grant.token_hash, first.token);
    const credential = db.prepare('SELECT credential_hash, grant_hash FROM setup_credentials').get();
    assert.equal(credential.credential_hash, hashToken(TEST_SETUP_CREDENTIAL));
    assert.equal(credential.grant_hash, hashToken(first.token));
    assert.notEqual(credential.credential_hash, TEST_SETUP_CREDENTIAL);

    const second = await issueSetup(base);
    assert.equal(second.status, 200);
    assert.notEqual(second.token, first.token);
    const rows = db.prepare('SELECT id, token_hash FROM setup_authorizations').all();
    assert.equal(rows.length, 1, 'only one setup grant may be active');
    assert.equal(rows[0].id, 1);
    assert.equal(rows[0].token_hash, hashToken(second.token));
  });
}, { timeout: 30_000 });

test('first password registration needs a valid setup authorization', async () => {
  await withFreshApp(async ({ base, db }) => {
    const missing = await register(base, { email: 'first@example.com', password: PASSWORD });
    assert.equal(missing.status, 403);
    assert.match(missing.data.error, /setup link/i);
    assert.doesNotMatch(missing.data.error, /BOOTSTRAP_TOKEN|bootstrapToken|#bootstrap=/i);

    const forged = await register(base, {
      email: 'first@example.com', password: PASSWORD, setupToken: TEST_BOOTSTRAP_TOKEN,
    });
    assert.equal(forged.status, 403);
    assert.match(forged.data.error, /invalid|expired/i);
    const credentialAsGrant = await register(base, {
      email: 'first@example.com', password: PASSWORD, setupCredential: TEST_SETUP_CREDENTIAL,
    });
    assert.equal(credentialAsGrant.status, 403, 'the owner credential is not itself a grant');
    assert.equal(userCount(db), 0, 'neither a missing nor forged grant creates an account');

    const setupToken = await authorizeFirstAccount(base);
    const created = await register(base, {
      email: 'First.User@Example.com', password: PASSWORD, setupToken, isAdmin: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.user.isAdmin, false);
    assert.equal(adminCount(db), 0);

    const status = await request(base, 'GET', '/api/auth/setup/status');
    assert.deepEqual(status.data, { ok: true, required: false });
    const me = await request(base, 'GET', '/api/auth/me', { token: created.data.token });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.isAdmin, false);
  });
}, { timeout: 30_000 });

test('expired, consumed, and stale setup authorizations are all rejected', async () => {
  const restoreGoogle = setGoogleConfig();
  try {
    await withFreshApp(async ({ base, db }) => {
      const expired = await issueSetup(base);
      assert.equal(expired.status, 200);
      const past = new Date(Date.now() - 60_000).toISOString();
      db.prepare('UPDATE setup_authorizations SET expires_at = ?').run(past);
      const afterExpiry = await register(base, {
        email: 'expired@example.com', password: PASSWORD, setupToken: expired.token,
      });
      assert.equal(afterExpiry.status, 403);
      assert.match(afterExpiry.data.error, /invalid|expired/i);
      assert.equal(userCount(db), 0);

      // The owner credential itself expires after its first exchange and
      // cannot be exchanged again once expired or consumed.
      db.prepare('UPDATE setup_credentials SET expires_at = ?').run(past);
      const expiredCredential = await issueSetup(base);
      assert.equal(expiredCredential.status, 403);
      assert.match(expiredCredential.data.error, /invalid|expired/i);

      // Re-arm the test-only expiry so the following cases start from a valid
      // credential; a real deployment would require a new configured secret.
      db.prepare('UPDATE setup_credentials SET expires_at = ?').run(
        new Date(Date.now() + 60_000).toISOString(),
      );
      const consumed = await issueSetup(base);
      const started = await startGoogle(base, consumed.token);
      assert.equal(started.status, 200, 'a valid grant may authorize a Google flow');
      assert.equal(userCount(db), 0, 'starting OAuth does not itself create an account');
      const replay = await register(base, {
        email: 'replay@example.com', password: PASSWORD, setupToken: consumed.token,
      });
      assert.equal(replay.status, 403, 'a grant bound to OAuth cannot authorize a password account');
      assert.equal(userCount(db), 0);

      const stale = await issueSetup(base);
      const first = await register(base, {
        email: 'owner@example.com', password: PASSWORD, setupToken: stale.token,
      });
      assert.equal(first.status, 201);
      assert.notEqual(db.prepare('SELECT consumed_at FROM setup_credentials').get().consumed_at, null);
      const staleReuse = await register(base, {
        email: 'late@example.com', password: PASSWORD, setupToken: stale.token,
      });
      assert.equal(staleReuse.status, 201, 'later accounts ignore stale grants and follow ALLOW_REGISTRATION');
      assert.equal(userCount(db), 2);

      const afterCompletion = await issueSetup(base);
      assert.equal(afterCompletion.status, 409);
      assert.match(afterCompletion.data.error, /already complete/i);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM setup_authorizations').get().c, 0);
    });
  } finally {
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('Google receives only a random state, never the owner secret or setup authorization', async () => {
  const restoreGoogle = setGoogleConfig();
  try {
    await withFreshApp(async ({ base, db }) => {
      const missing = await startGoogle(base);
      assert.equal(missing.status, 403);
      assert.match(missing.data.error, /setup link/i);

      const grant = await issueSetup(base);
      const started = await startGoogle(base, grant.token);
      assert.equal(started.status, 200, JSON.stringify(started.data));
      const url = new URL(started.data.url);
      assert.equal(url.origin, 'https://accounts.google.com');
      const state = url.searchParams.get('state');
      assert.ok(state);
      assert.notEqual(state, grant.token);
      for (const value of [
        grant.token, TEST_SETUP_CREDENTIAL, TEST_BOOTSTRAP_TOKEN, 'bootstrap', 'setupToken',
      ]) {
        assert.ok(!String(url).includes(value), `Google URL must not carry ${value}`);
      }

      const row = db.prepare(
        'SELECT allow_create, setup_authorized, setup_grant_hash FROM oauth_states WHERE state_hash = ?',
      ).get(hashToken(state));
      assert.equal(Number(row.setup_authorized), 1);
      assert.equal(row.setup_grant_hash, hashToken(grant.token));
      const grantRow = db.prepare('SELECT bound_state_hash FROM setup_authorizations').get();
      assert.equal(grantRow.bound_state_hash, hashToken(state));
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM setup_authorizations').get().c, 1,
        'the grant survives a failed callback so the owner can retry');
    });
  } finally {
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('a Google callback cannot create the first account without setup authorization', async () => {
  const restoreGoogle = setGoogleConfig();
  const restoreFetch = mockGoogleClaims(claimsFor('google-sub-no-setup', 'nosetup@example.com'));
  try {
    await withFreshApp(async ({ base, db }) => {
      const unauthorizedState = 'state-without-setup';
      db.prepare(
        `INSERT INTO oauth_states (state_hash, allow_create, setup_authorized, expires_at)
         VALUES (?, 1, 0, ?)`,
      ).run(hashToken(unauthorizedState), new Date(Date.now() + 60_000).toISOString());

      const result = await callback(base, unauthorizedState);
      assert.equal(result.status, 302);
      assert.equal(result.fragment.get('auth_error'), 'google_setup_required');
      assert.equal(userCount(db), 0, 'an injected state must not bypass the setup gate');
    });
  } finally {
    restoreFetch();
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('a valid first Google account is ordinary and returning sign-in needs no setup', async () => {
  const restoreGoogle = setGoogleConfig();
  const restoreFetch = mockGoogleClaims(claimsFor('google-sub-owner', 'google-owner@example.com'));
  try {
    await withFreshApp(async ({ base, db }) => {
      const setupToken = await authorizeFirstAccount(base);
      const started = await startGoogle(base, setupToken);
      assert.equal(started.status, 200);
      const state = new URL(started.data.url).searchParams.get('state');
      const first = await callback(base, state);
      assert.ok(first.fragment.get('auth_token'));
      assert.equal(first.fragment.get('auth_error'), null);
      assert.equal(userCount(db), 1);
      assert.equal(adminCount(db), 0, 'Google registration never creates an admin');
      assert.equal(db.prepare('SELECT is_admin FROM users').get().is_admin, 0);

      config.allowRegistration = false;
      const returningStart = await startGoogle(base);
      assert.equal(returningStart.status, 200, 'returning users do not need a setup grant');
      const returningState = new URL(returningStart.data.url).searchParams.get('state');
      const returning = await callback(base, returningState);
      assert.ok(returning.fragment.get('auth_token'));
      assert.equal(userCount(db), 1, 'a returning Google identity must not create a duplicate');

      const me = await request(base, 'GET', '/api/auth/me', { token: returning.fragment.get('auth_token') });
      assert.equal(me.status, 200);
      assert.equal(me.data.user.email, 'google-owner@example.com');
      assert.equal(me.data.user.isAdmin, false);
    });
  } finally {
    restoreFetch();
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('an existing password account is never silently linked to a Google identity', async () => {
  const restoreGoogle = setGoogleConfig();
  try {
    await withFreshApp(async ({ base, db }) => {
      const setupToken = await authorizeFirstAccount(base);
      const registered = await register(base, {
        email: 'owner@example.com', password: PASSWORD, setupToken,
      });
      assert.equal(registered.status, 201);

      const restoreFetch = mockGoogleClaims(claimsFor('google-sub-new', 'owner@example.com'));
      try {
        const started = await startGoogle(base);
        assert.equal(started.status, 200);
        const state = new URL(started.data.url).searchParams.get('state');
        const result = await callback(base, state);
        assert.equal(result.fragment.get('auth_error'), 'google_account_exists');
        const row = db.prepare('SELECT google_sub FROM users WHERE email = ?').get('owner@example.com');
        assert.equal(row.google_sub, null);
        assert.equal(userCount(db), 1);
      } finally {
        restoreFetch();
      }
    });
  } finally {
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('a second Google identity cannot claim an email already linked to Google', async () => {
  const restoreGoogle = setGoogleConfig();
  try {
    await withFreshApp(async ({ base, db }) => {
      const setupToken = await authorizeFirstAccount(base);
      const registered = await register(base, {
        email: 'first-owner@example.com', password: PASSWORD, setupToken,
      });
      assert.equal(registered.status, 201);

      let restoreFetch = mockGoogleClaims(claimsFor('google-sub-a', 'person@example.com'));
      try {
        const firstStart = await startGoogle(base);
        const first = await callback(base, new URL(firstStart.data.url).searchParams.get('state'));
        assert.ok(first.fragment.get('auth_token'));
      } finally {
        restoreFetch();
      }

      restoreFetch = mockGoogleClaims(claimsFor('google-sub-b', 'person@example.com'));
      try {
        const secondStart = await startGoogle(base);
        const second = await callback(base, new URL(secondStart.data.url).searchParams.get('state'));
        assert.equal(second.fragment.get('auth_error'), 'google_identity_conflict');
      } finally {
        restoreFetch();
      }

      assert.equal(userCount(db), 2);
      const row = db.prepare('SELECT google_sub FROM users WHERE email = ?').get('person@example.com');
      assert.equal(row.google_sub, 'google-sub-a');
    });
  } finally {
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('setup authorization never grants administrator privileges', async () => {
  await withFreshApp(async ({ base, db }) => {
    const setupToken = await authorizeFirstAccount(base);
    const registered = await register(base, {
      email: 'owner@example.com',
      password: PASSWORD,
      setupToken,
      isAdmin: true,
      is_admin: 1,
      admin: true,
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.data.user.isAdmin, false);
    assert.equal(adminCount(db), 0);

    const forgedAdmin = await request(base, 'POST', '/api/auth/admin/provision', {
      body: { email: 'owner@example.com', bootstrapToken: setupToken },
    });
    assert.equal(forgedAdmin.status, 403, 'a setup grant is not the owner secret');
    assert.equal(adminCount(db), 0);

    const provisioned = await request(base, 'POST', '/api/auth/admin/provision', {
      body: { email: 'owner@example.com', bootstrapToken: TEST_BOOTSTRAP_TOKEN },
    });
    assert.equal(provisioned.status, 200);
    assert.equal(provisioned.data.user.isAdmin, true);
    assert.equal(adminCount(db), 1);
  });
}, { timeout: 30_000 });

test('the first account session is scoped like every other account', async () => {
  await withFreshApp(async ({ base, db }) => {
    const setupToken = await authorizeFirstAccount(base);
    const first = await register(base, {
      email: 'first@example.com', password: PASSWORD, setupToken,
    });
    assert.equal(first.status, 201);
    const second = await register(base, {
      email: 'second@example.com', password: PASSWORD,
    });
    assert.equal(second.status, 201);

    const created = await request(base, 'POST', '/api/projects', {
      token: first.data.token, body: { name: 'First account project' },
    });
    assert.equal(created.status, 201);
    const projectId = created.data.project.id;

    const own = await request(base, 'GET', `/api/projects/${projectId}/files`, { token: first.data.token });
    assert.equal(own.status, 200);
    const foreign = await request(base, 'GET', `/api/projects/${projectId}/files`, { token: second.data.token });
    assert.equal(foreign.status, 404, 'the second account cannot see the first account project');
    assert.equal(userCount(db), 2);
  });
}, { timeout: 30_000 });

test('missing or conflicting credentials fail closed in both owner flows', async () => {
  const original = config.firstAccountSetupToken;
  try {
    config.firstAccountSetupToken = '';
    await withFreshApp(async ({ base, db }) => {
      const missing = await issueSetup(base);
      assert.equal(missing.status, 503);
      assert.match(missing.data.error, /FIRST_ACCOUNT_SETUP_TOKEN/);
      assert.doesNotMatch(missing.data.error, /test-first-account-setup-token|test-bootstrap-token/);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM setup_authorizations').get().c, 0);
    });

    config.firstAccountSetupToken = config.bootstrapToken;
    await withFreshApp(async ({ base, db }) => {
      const conflict = await issueSetup(base);
      assert.equal(conflict.status, 503);
      assert.match(conflict.data.error, /unique|different from the administrator/i);

      // The same shared value must not become an administrator credential when
      // the two configured secrets are accidentally identical.
      const admin = await request(base, 'POST', '/api/auth/admin/provision', {
        body: {
          bootstrapToken: TEST_BOOTSTRAP_TOKEN,
          email: 'conflict-admin@example.com',
          password: PASSWORD,
        },
      });
      assert.equal(admin.status, 503);
      assert.match(admin.data.error, /unique|different from the administrator/i);
      assert.equal(adminCount(db), 0);
    });
  } finally {
    config.firstAccountSetupToken = original;
  }
}, { timeout: 30_000 });

test('the owner setup credential is consumed after one successful first account', async () => {
  await withFreshApp(async ({ base, db }) => {
    const setupToken = await authorizeFirstAccount(base);
    const created = await register(base, {
      email: 'single@example.com', password: PASSWORD, setupToken,
    });
    assert.equal(created.status, 201);
    assert.notEqual(db.prepare('SELECT consumed_at FROM setup_credentials').get().consumed_at, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM setup_authorizations').get().c, 0);

    // Test-only reset of the account gate: the consumed credential row remains,
    // so the public exchange must still reject it.
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM users').run();
    const reuse = await issueSetup(base);
    assert.equal(reuse.status, 403);
    assert.match(reuse.data.error, /invalid|expired/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM setup_authorizations').get().c, 0);
  });
}, { timeout: 30_000 });

test('one setup authorization cannot leave two active OAuth states', async () => {
  const restoreGoogle = setGoogleConfig();
  const restoreFetch = mockGoogleClaims(claimsFor('google-sub-single', 'single-google@example.com'));
  try {
    await withFreshApp(async ({ base, db }) => {
      const grant = await issueSetup(base);
      const firstStart = await startGoogle(base, grant.token);
      const secondStart = await startGoogle(base, grant.token);
      assert.equal(firstStart.status, 200);
      assert.equal(secondStart.status, 200);
      const firstState = new URL(firstStart.data.url).searchParams.get('state');
      const secondState = new URL(secondStart.data.url).searchParams.get('state');
      assert.notEqual(firstState, secondState);

      const rows = db.prepare('SELECT state_hash FROM oauth_states WHERE setup_authorized = 1').all();
      assert.equal(rows.length, 1, 'the second start replaces the first state');
      assert.equal(rows[0].state_hash, hashToken(secondState));

      const stale = await callback(base, firstState);
      assert.equal(stale.fragment.get('auth_error'), 'google_state');
      assert.equal(userCount(db), 0);

      const success = await callback(base, secondState);
      assert.ok(success.fragment.get('auth_token'));
      assert.equal(userCount(db), 1);
      assert.equal(adminCount(db), 0);
      assert.equal(db.prepare('SELECT consumed_at FROM setup_credentials').get().consumed_at !== null, true);
    });
  } finally {
    restoreFetch();
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('a failed Google callback creates no account and leaves the grant retryable', async () => {
  const restoreGoogle = setGoogleConfig();
  const originalFetch = globalThis.fetch;
  try {
    await withFreshApp(async ({ base, db }) => {
      const grant = await issueSetup(base);
      const failedStart = await startGoogle(base, grant.token);
      assert.equal(failedStart.status, 200);
      const failedState = new URL(failedStart.data.url).searchParams.get('state');

      globalThis.fetch = async (url, options) => {
        if (String(url) === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400, headers: { 'content-type': 'application/json' },
          });
        }
        return originalFetch(url, options);
      };
      const failed = await callback(base, failedState);
      assert.equal(failed.fragment.get('auth_error'), 'google_unavailable');
      assert.equal(userCount(db), 0, 'a failed callback must not create an account');
      assert.equal(adminCount(db), 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM setup_authorizations').get().c, 1,
        'the grant survives an upstream failure');
      assert.equal(db.prepare('SELECT consumed_at FROM setup_credentials').get().consumed_at, null);

      globalThis.fetch = originalFetch;
      const restoreSuccess = mockGoogleClaims(claimsFor('google-sub-retry', 'retry@example.com'));
      try {
        const retryStart = await startGoogle(base, grant.token);
        assert.equal(retryStart.status, 200, 'the same grant can start a fresh OAuth state');
        const retryState = new URL(retryStart.data.url).searchParams.get('state');
        const retry = await callback(base, retryState);
        assert.ok(retry.fragment.get('auth_token'));
        assert.equal(userCount(db), 1);
        assert.equal(adminCount(db), 0);
        assert.notEqual(db.prepare('SELECT consumed_at FROM setup_credentials').get().consumed_at, null);
      } finally {
        restoreSuccess();
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('credential-bearing auth responses are never cacheable', async () => {
  const restoreGoogle = setGoogleConfig();
  const restoreFetch = mockGoogleClaims(claimsFor('google-sub-cache', 'cache@example.com'));
  try {
    await withFreshApp(async ({ base }) => {
      const grant = await issueSetup(base);
      assert.equal(grant.headers.get('cache-control'), 'no-store');

      const created = await register(base, {
        email: 'first@example.com', password: PASSWORD, setupToken: grant.token,
      });
      assert.equal(created.status, 201);
      assert.equal(created.headers.get('cache-control'), 'no-store');

      const login = await request(base, 'POST', '/api/auth/login', {
        body: { email: 'first@example.com', password: PASSWORD },
      });
      assert.equal(login.status, 200);
      assert.equal(login.headers.get('cache-control'), 'no-store');

      const admin = await request(base, 'POST', '/api/auth/admin/provision', {
        body: { email: 'first@example.com', bootstrapToken: TEST_BOOTSTRAP_TOKEN },
      });
      assert.equal(admin.status, 200);
      assert.equal(admin.headers.get('cache-control'), 'no-store');

      const started = await startGoogle(base);
      assert.equal(started.status, 200);
      assert.equal(started.headers.get('cache-control'), 'no-store');
      const state = new URL(started.data.url).searchParams.get('state');
      const cb = await callback(base, state);
      assert.equal(cb.headers.get('cache-control'), 'no-store');
    });
  } finally {
    restoreFetch();
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('expensive scrypt work finishes before write transactions open', async () => {
  const originalScrypt = crypto.scryptSync;
  await withFreshApp(async ({ base, db }) => {
    const originalExec = db.exec.bind(db);
    let inTransaction = false;
    let hashedInsideTransaction = false;
    db.exec = (sql) => {
      const text = String(sql);
      if (/^\s*BEGIN/i.test(text)) inTransaction = true;
      if (/^\s*(COMMIT|ROLLBACK)/i.test(text)) inTransaction = false;
      return originalExec(sql);
    };
    crypto.scryptSync = (...args) => {
      if (inTransaction) hashedInsideTransaction = true;
      return originalScrypt(...args);
    };
    try {
      const setupToken = await authorizeFirstAccount(base);
      const created = await register(base, {
        email: 'hash-order@example.com', password: PASSWORD, setupToken,
      });
      assert.equal(created.status, 201);
      assert.equal(hashedInsideTransaction, false, 'password hashing must precede BEGIN IMMEDIATE');
    } finally {
      crypto.scryptSync = originalScrypt;
      db.exec = originalExec;
    }
  });

  const restoreGoogle = setGoogleConfig();
  const restoreFetch = mockGoogleClaims(claimsFor('google-sub-hash-order', 'hash-order-google@example.com'));
  try {
    await withFreshApp(async ({ base, db }) => {
      const originalExec = db.exec.bind(db);
      let inTransaction = false;
      let hashedInsideTransaction = false;
      db.exec = (sql) => {
        const text = String(sql);
        if (/^\s*BEGIN/i.test(text)) inTransaction = true;
        if (/^\s*(COMMIT|ROLLBACK)/i.test(text)) inTransaction = false;
        return originalExec(sql);
      };
      crypto.scryptSync = (...args) => {
        if (inTransaction) hashedInsideTransaction = true;
        return originalScrypt(...args);
      };
      try {
        const setupToken = await authorizeFirstAccount(base);
        const started = await startGoogle(base, setupToken);
        assert.equal(started.status, 200);
        const state = new URL(started.data.url).searchParams.get('state');
        const result = await callback(base, state);
        assert.ok(result.fragment.get('auth_token'));
        assert.equal(hashedInsideTransaction, false, 'shadow hashing must precede BEGIN IMMEDIATE');
      } finally {
        crypto.scryptSync = originalScrypt;
        db.exec = originalExec;
      }
    });
  } finally {
    restoreFetch();
    restoreGoogle();
  }
}, { timeout: 30_000 });

test('postgres write transactions serialize first-account checks with an explicit lock', () => {
  const calls = [];
  const db = {
    dialect: 'postgres',
    exec(sql) { calls.push(sql); },
  };

  assert.equal(withWriteTransaction(db, () => 'done'), 'done');
  assert.deepEqual(calls, [
    'BEGIN',
    'LOCK TABLE users IN EXCLUSIVE MODE',
    'COMMIT',
  ]);

  calls.length = 0;
  assert.throws(
    () => withWriteTransaction(db, () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.deepEqual(calls, [
    'BEGIN',
    'LOCK TABLE users IN EXCLUSIVE MODE',
    'ROLLBACK',
  ]);
});

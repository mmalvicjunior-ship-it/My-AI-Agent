// Google sign-in tests (mocked OAuth).
//
// The Google token + tokeninfo endpoints are replaced with fixtures so no
// network calls ever happen. Each test runs against a fresh temporary
// database (the shared config.databasePath is swapped for the duration of
// the test), so Google accounts, password accounts, and admin flags are all
// created in isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'http://localhost:5173/api/auth/google/callback';

function claimsFor(sub, email, { aud = CLIENT_ID, emailVerified = 'true', iss = 'https://accounts.google.com' } = {}) {
  return { aud, iss, email_verified: emailVerified, email, sub };
}

/**
 * Replaces globalThis.fetch with a fixture for the Google endpoints and
 * delegates everything else (including this file's HTTP calls to the app)
 * to the real fetch. Returns a counter of upstream calls.
 */
function mockGoogle({ tokenStatus = 200, tokenBody = null, tokeninfoStatus = 200, tokeninfoBody = null } = {}) {
  const realFetch = globalThis.fetch.bind(globalThis);
  const calls = { token: 0, tokeninfo: 0 };
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') {
      calls.token += 1;
      const body = tokenStatus === 200
        ? (tokenBody ?? { id_token: 'test.id.token' })
        : (tokenBody ?? { error: 'invalid_grant' });
      return new Response(JSON.stringify(body), { status: tokenStatus, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
      calls.tokeninfo += 1;
      const body = tokeninfoStatus === 200
        ? (tokeninfoBody ?? claimsFor('google-sub-1', 'user@example.com'))
        : (tokeninfoBody ?? { error: 'invalid_token' });
      return new Response(JSON.stringify(body), { status: tokeninfoStatus, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, options);
  };
  return calls;
}

function withTempDb(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-google-'));
  const originalDbPath = config.databasePath;
  const originalWorkspaceRoot = config.workspaceRoot;
  config.databasePath = path.join(tempDir, 'fresh.db');
  config.workspaceRoot = path.join(tempDir, 'workspaces');
  return fn().finally(() => {
    config.databasePath = originalDbPath;
    config.workspaceRoot = originalWorkspaceRoot;
    // Temp dir intentionally left behind (Windows file locking), consistent
    // with the rest of the suite.
  });
}

async function withApp(fn) {
  const created = createApp({ provider: null });
  const server = created.app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ created, db: created.db, base, server });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

function setGoogleConfig({ clientId = CLIENT_ID, secret = CLIENT_SECRET, redirectUri = REDIRECT_URI, appOrigin = '' } = {}) {
  const original = {
    googleClientId: config.googleClientId,
    googleClientSecret: config.googleClientSecret,
    googleRedirectUri: config.googleRedirectUri,
    appOrigin: config.appOrigin,
  };
  config.googleClientId = clientId;
  config.googleClientSecret = secret;
  config.googleRedirectUri = redirectUri;
  config.appOrigin = appOrigin;
  return () => {
    config.googleClientId = original.googleClientId;
    config.googleClientSecret = original.googleClientSecret;
    config.googleRedirectUri = original.googleRedirectUri;
    config.appOrigin = original.appOrigin;
  };
}

function setAllowRegistration(value) {
  const original = config.allowRegistration;
  config.allowRegistration = value;
  return () => { config.allowRegistration = original; };
}

async function request(method, base, pathname, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

function startGoogle(base, body = {}) {
  return request('POST', base, '/api/auth/google/start', { body });
}

async function callback(base, { code = 'test-code', state, error } = {}) {
  const params = new URLSearchParams();
  if (error) params.set('error', error);
  if (code) params.set('code', code);
  if (state) params.set('state', state);
  return fetch(`${base}/api/auth/google/callback?${params.toString()}`, { redirect: 'manual' });
}

const errorLocation = (res) => new URLSearchParams(String(res.headers.get('location') || '').split('#')[1] || '');
const authFragment = (res) => new URLSearchParams(String(res.headers.get('location') || '').split('#')[1] || '');

async function registerAdmin(base) {
  const res = await request('POST', base, '/api/auth/register', {
    body: { email: 'admin@example.com', password: 'correct-horse-battery', bootstrapToken: 'test-bootstrap-token' },
  });
  assert.equal(res.status, 201);
  return res;
}

const stateFrom = (startResult) => {
  const url = new URL(startResult.data.url);
  const state = url.searchParams.get('state');
  assert.ok(state, 'the authorize URL carries a state parameter');
  return state;
};

test('google/start returns 503 when Google is not configured', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig({ clientId: '', secret: '', redirectUri: '' });
    try {
      await withApp(async ({ base, db }) => {
        const res = await startGoogle(base, {});
        assert.equal(res.status, 503);
        assert.match(res.data.error, /not configured/i);
        const cbRes = await callback(base, { state: 'anything' });
        assert.equal(cbRes.status, 302);
        assert.equal(errorLocation(cbRes).get('auth_error'), 'google_not_configured');
        assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c), 0);
      });
    } finally {
      restore();
    }
  });
}, { timeout: 30_000 });

test('google/start refuses the first account without the bootstrap token', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    try {
      await withApp(async ({ base, db }) => {
        const res = await startGoogle(base, {});
        assert.equal(res.status, 403);
        assert.match(res.data.error, /bootstrap token/i);
        assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c), 0);

        const wrong = await startGoogle(base, { bootstrapToken: 'not-the-token' });
        assert.equal(wrong.status, 403);
      });
    } finally {
      restore();
    }
  });
}, { timeout: 30_000 });

test('the first account can be created through Google with the bootstrap token and becomes the administrator', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-admin', 'boss@example.com') });
    try {
      await withApp(async ({ base, db }) => {
        const start = await startGoogle(base, { bootstrapToken: 'test-bootstrap-token' });
        assert.equal(start.status, 200);
        assert.equal(start.data.ok, true);
        const state = stateFrom(start);

        const cb = await callback(base, { code: 'valid-code', state });
        assert.equal(cb.status, 302);
        const fragment = authFragment(cb);
        assert.ok(fragment.get('auth_token'), 'the callback redirects with a session token in the fragment');

        const row = db.prepare('SELECT email, is_admin, google_sub FROM users').get();
        assert.equal(row.email, 'boss@example.com');
        assert.equal(row.is_admin, 1, 'the first Google-created account must be the administrator');
        assert.equal(row.google_sub, 'google-sub-admin');

        const me = await request('GET', base, '/api/auth/me', { token: fragment.get('auth_token') });
        assert.equal(me.status, 200);
        assert.equal(me.data.user.email, 'boss@example.com');
        assert.equal(me.data.user.isAdmin, true);
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('two bootstrap-authorized Google starts still create only one administrator', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const originalFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-first-admin', 'first-admin@example.com') });
    try {
      await withApp(async ({ base, db }) => {
        // Both flows start while the database is empty and carry a valid token.
        const start1 = await startGoogle(base, { bootstrapToken: 'test-bootstrap-token' });
        const start2 = await startGoogle(base, { bootstrapToken: 'test-bootstrap-token' });
        assert.equal(start1.status, 200);
        assert.equal(start2.status, 200);
        const state1 = stateFrom(start1);
        const state2 = stateFrom(start2);

        const cb1 = await callback(base, { code: 'code-one', state: state1 });
        assert.ok(authFragment(cb1).get('auth_token'));

        const previousFetch = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
          if (String(url).startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
            return new Response(JSON.stringify(claimsFor('google-sub-second-user', 'second-user@example.com')), {
              status: 200, headers: { 'content-type': 'application/json' },
            });
          }
          return previousFetch(url, options);
        };

        const cb2 = await callback(base, { code: 'code-two', state: state2 });
        assert.ok(authFragment(cb2).get('auth_token'));

        const rows = db.prepare('SELECT email, is_admin FROM users ORDER BY id').all();
        assert.deepEqual(rows.map((row) => ({ email: row.email, is_admin: row.is_admin })), [
          { email: 'first-admin@example.com', is_admin: 1 },
          { email: 'second-user@example.com', is_admin: 0 },
        ]);
      });
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('a new Google user (after bootstrap) is a normal non-administrator account', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-user', 'person@example.com') });
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);
        const start = await startGoogle(base, {});
        assert.equal(start.status, 200);
        const state = stateFrom(start);

        const cb = await callback(base, { code: 'valid-code', state });
        assert.equal(cb.status, 302);
        assert.ok(authFragment(cb).get('auth_token'));

        const row = db.prepare('SELECT is_admin FROM users WHERE email = ?').get('person@example.com');
        assert.equal(row.is_admin, 0, 'Google-created accounts must never be administrators');
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('the same Google identity signs in twice without creating a duplicate account', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-repeat', 'repeat@example.com') });
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);
        const start1 = await startGoogle(base, {});
        const state1 = stateFrom(start1);
        const cb1 = await callback(base, { code: 'code-one', state: state1 });
        assert.ok(authFragment(cb1).get('auth_token'));
        const countAfterFirst = Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c);

        const start2 = await startGoogle(base, {});
        const state2 = stateFrom(start2);
        const cb2 = await callback(base, { code: 'code-two', state: state2 });
        assert.ok(authFragment(cb2).get('auth_token'));
        const countAfterSecond = Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c);

        assert.equal(countAfterFirst, 2);
        assert.equal(countAfterSecond, 2, 'signing in again must not create a duplicate account');
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('an existing email/password account is NOT auto-linked to a Google identity', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);
        // A password account that already exists BEFORE any Google flow runs.
        const reg = await request('POST', base, '/api/auth/register', {
          body: { email: 'owner@example.com', password: 'correct-horse-battery' },
        });
        assert.equal(reg.status, 201);

        // A Google identity claims the same email.
        mockGoogle({ tokeninfoBody: claimsFor('google-sub-new', 'owner@example.com') });
        const start = await startGoogle(base, {});
        const state = stateFrom(start);
        const cb = await callback(base, { code: 'valid-code', state });
        assert.equal(cb.status, 302);
        assert.equal(errorLocation(cb).get('auth_error'), 'google_account_exists');

        const row = db.prepare('SELECT google_sub FROM users WHERE email = ?').get('owner@example.com');
        assert.equal(row.google_sub, null, 'the password account must remain unlinked');
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('a different Google identity cannot claim an email already linked to Google', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-A', 'person@example.com') });
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);

        // First flow: create the Google account linked to google-sub-A.
        const start1 = await startGoogle(base, {});
        const cb1 = await callback(base, { code: 'code-one', state: stateFrom(start1) });
        assert.ok(authFragment(cb1).get('auth_token'));

        // Second flow with a DIFFERENT sub claiming the same email.
        globalThis.fetch = (() => {
          const prev = globalThis.fetch;
          return async (url, options) => {
            if (String(url).startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
              return new Response(JSON.stringify(claimsFor('google-sub-B', 'person@example.com')), {
                status: 200, headers: { 'content-type': 'application/json' },
              });
            }
            return prev(url, options);
          };
        })();
        const start2 = await startGoogle(base, {});
        const cb2 = await callback(base, { code: 'code-two', state: stateFrom(start2) });
        assert.equal(cb2.status, 302);
        assert.equal(errorLocation(cb2).get('auth_error'), 'google_identity_conflict');
        const rows = db.prepare('SELECT google_sub FROM users WHERE email = ?').all('person@example.com');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].google_sub, 'google-sub-A');
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('invalid, unknown and already-consumed state values are rejected', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-x', 'state@example.com') });
    try {
      await withApp(async ({ base }) => {
        await registerAdmin(base);

        const unknown = await callback(base, { code: 'code', state: 'bogus-state' });
        assert.equal(errorLocation(unknown).get('auth_error'), 'google_state');

        const start = await startGoogle(base, {});
        const state = stateFrom(start);
        const first = await callback(base, { code: 'code-one', state });
        assert.ok(authFragment(first).get('auth_token'));

        const replay = await callback(base, { code: 'code-two', state });
        assert.equal(errorLocation(replay).get('auth_error'), 'google_state',
          'a consumed state must never be replayable');
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('a cancelled Google login redirects with google_cancelled', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    try {
      await withApp(async ({ base }) => {
        const res = await callback(base, { code: undefined, error: 'access_denied' });
        assert.equal(res.status, 302);
        assert.equal(errorLocation(res).get('auth_error'), 'google_cancelled');
      });
    } finally {
      restore();
    }
  });
}, { timeout: 30_000 });

test('an unverified Google email is rejected and no account is created', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-unverified', 'unverified@example.com', { emailVerified: 'false' }) });
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);
        const start = await startGoogle(base, {});
        const state = stateFrom(start);
        const cb = await callback(base, { code: 'valid-code', state });
        assert.equal(cb.status, 302);
        assert.equal(errorLocation(cb).get('auth_error'), 'google_unverified_email');
        assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get('unverified@example.com').c), 0);
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('a token whose audience does not match the client ID is rejected', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-aud', 'aud@example.com', { aud: 'some-other-client' }) });
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);
        const start = await startGoogle(base, {});
        const state = stateFrom(start);
        const cb = await callback(base, { code: 'valid-code', state });
        assert.equal(errorLocation(cb).get('auth_error'), 'google_identity_invalid');
        assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get('aud@example.com').c), 0);
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('a failed tokeninfo response is rejected', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoStatus: 400, tokeninfoBody: { error: 'invalid_token' } });
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);
        const start = await startGoogle(base, {});
        const state = stateFrom(start);
        const cb = await callback(base, { code: 'valid-code', state });
        assert.equal(errorLocation(cb).get('auth_error'), 'google_identity_invalid');
        assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get('aud@example.com').c), 0);
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('GOOGLE sign-up is refused when registration is disabled', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreRegistration = setAllowRegistration(false);
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-blocked', 'blocked@example.com') });
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);
        const start = await startGoogle(base, {});
        assert.equal(start.status, 200, 'start is allowed; the verdict is enforced at the callback');
        const cb = await callback(base, { code: 'valid-code', state: stateFrom(start) });
        assert.equal(errorLocation(cb).get('auth_error'), 'google_registration_disabled');
        assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get('blocked@example.com').c), 0);
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restoreRegistration();
      restore();
    }
  });
}, { timeout: 30_000 });

test('a Google-created account cannot sign in with the password form', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: claimsFor('google-sub-g', 'googleonly@example.com') });
    try {
      await withApp(async ({ base }) => {
        await registerAdmin(base);
        const start = await startGoogle(base, {});
        const cb = await callback(base, { code: 'valid-code', state: stateFrom(start) });
        assert.ok(authFragment(cb).get('auth_token'));

        const login = await request('POST', base, '/api/auth/login', {
          body: { email: 'googleonly@example.com', password: 'correct-horse-battery' },
        });
        assert.equal(login.status, 401, 'Google-only accounts have an unusable password hash');
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

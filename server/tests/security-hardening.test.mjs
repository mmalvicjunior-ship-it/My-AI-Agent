// Security-hardening tests for the Google OAuth flow and APP_ORIGIN handling.
//
// Covers: APP_ORIGIN startup validation, expired OAuth state rejection,
// atomic one-time state consumption, Google's boolean email_verified claim,
// missing identity claims, and the /google rate limit. The Google token and
// tokeninfo endpoints are replaced with fixtures; no network calls happen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config, validateAppOrigin } from '../src/config.js';
import { authorizeFirstAccount } from './setup-authorization.mjs';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'http://localhost:5173/api/auth/google/callback';

function baseClaims(overrides = {}) {
  return {
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    email_verified: 'true',
    email: 'user@example.com',
    sub: 'google-sub-hardening',
    ...overrides,
  };
}

function mockGoogle({ tokeninfoBody, tokeninfoStatus = 200, tokenStatus = 200 } = {}) {
  const realFetch = globalThis.fetch.bind(globalThis);
  const calls = { token: 0, tokeninfo: 0 };
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') {
      calls.token += 1;
      const ok = tokenStatus === 200;
      return new Response(JSON.stringify(ok ? { id_token: 'test.id.token' } : { error: 'invalid_grant' }), {
        status: tokenStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
      calls.tokeninfo += 1;
      const body = tokeninfoStatus === 200
        ? (tokeninfoBody ?? baseClaims())
        : (tokeninfoBody ?? { error: 'invalid_token' });
      return new Response(JSON.stringify(body), {
        status: tokeninfoStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, options);
  };
  return calls;
}

function withTempDb(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-hardening-'));
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

async function request(method, base, pathname, { body, token } = {}) {
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
  return { status: res.status, data, headers: res.headers };
}

async function callback(base, { code = 'test-code', state } = {}) {
  const params = new URLSearchParams();
  if (code) params.set('code', code);
  if (state) params.set('state', state);
  return fetch(`${base}/api/auth/google/callback?${params.toString()}`, { redirect: 'manual' });
}

const fragmentFrom = (res) => new URLSearchParams(String(res.headers.get('location') || '').split('#')[1] || '');

async function registerAdmin(base) {
  const setupToken = await authorizeFirstAccount(base);
  const res = await request('POST', base, '/api/auth/register', {
    body: { email: 'admin@example.com', password: 'correct-horse-battery', setupToken },
  });
  assert.equal(res.status, 201);
  return res;
}

const stateFrom = (startResult) => new URL(startResult.data.url).searchParams.get('state');

// --- APP_ORIGIN validation --------------------------------------------------

test('validateAppOrigin accepts an empty value (same-origin mode)', () => {
  assert.equal(validateAppOrigin(''), '');
  assert.equal(validateAppOrigin('   '), '');
  assert.equal(validateAppOrigin(undefined), '');
});

test('validateAppOrigin normalizes a valid https origin', () => {
  assert.equal(validateAppOrigin('https://app.example.com'), 'https://app.example.com');
  assert.equal(validateAppOrigin('https://app.example.com/'), 'https://app.example.com');
  assert.equal(validateAppOrigin('https://Example.COM'), 'https://example.com');
});

test('validateAppOrigin permits http only for localhost development', () => {
  assert.equal(validateAppOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(validateAppOrigin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  assert.equal(validateAppOrigin('http://dev.localhost:5173'), 'http://dev.localhost:5173');
  assert.throws(() => validateAppOrigin('http://app.example.com'), /https:/);
  assert.throws(() => validateAppOrigin('http://192.168.1.10'), /https:/);
});

test('validateAppOrigin rejects credentials, paths, query and fragment', () => {
  assert.throws(() => validateAppOrigin('https://user:pass@example.com'), /credentials/);
  assert.throws(() => validateAppOrigin('https://example.com/app'), /path/);
  assert.throws(() => validateAppOrigin('https://example.com/?x=1'), /query/);
  assert.throws(() => validateAppOrigin('https://example.com/#frag'), /query/);
  assert.throws(() => validateAppOrigin('not-a-url'), /valid absolute URL/);
  assert.throws(() => validateAppOrigin('ftp://example.com'), /https:/);
});

// --- Expired / atomic state handling ----------------------------------------

test('an OAuth state older than its TTL is rejected', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle();
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);
        const start = await request('POST', base, '/api/auth/google/start', { body: {} });
        const state = stateFrom(start);

        // Age the stored row past its 10-minute TTL.
        db.prepare('UPDATE oauth_states SET expires_at = ?')
          .run(new Date(Date.now() - 60_000).toISOString());

        const cb = await callback(base, { state });
        assert.equal(fragmentFrom(cb).get('auth_error'), 'google_state');
        assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c), 1,
          'the expired flow must not create an account');
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('state consumption is atomic: a replayed state never yields a second session', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle();
    try {
      await withApp(async ({ base }) => {
        await registerAdmin(base);
        const start = await request('POST', base, '/api/auth/google/start', { body: {} });
        const state = stateFrom(start);

        // Two parallel callbacks with the same state: exactly one may succeed.
        const [first, second] = await Promise.all([
          callback(base, { state }),
          callback(base, { state }),
        ]);
        const results = [fragmentFrom(first), fragmentFrom(second)];
        const successes = results.filter((fragment) => fragment.get('auth_token'));
        const failures = results.filter((fragment) => fragment.get('auth_error') === 'google_state');
        assert.equal(successes.length, 1, 'exactly one callback may consume the state');
        assert.equal(failures.length, 1, 'the concurrent replay must be rejected');

        // And a sequential replay after success is rejected as well.
        const replay = await callback(base, { state });
        assert.equal(fragmentFrom(replay).get('auth_error'), 'google_state');
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

// --- Identity validation ------------------------------------------------------

test('a boolean email_verified: true claim is accepted', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    const restoreFetch = globalThis.fetch;
    mockGoogle({ tokeninfoBody: baseClaims({ email_verified: true, email: 'boolean@example.com', sub: 'google-sub-boolean' }) });
    try {
      await withApp(async ({ base, db }) => {
        await registerAdmin(base);
        const start = await request('POST', base, '/api/auth/google/start', { body: {} });
        const state = stateFrom(start);
        const cb = await callback(base, { state });
        assert.ok(fragmentFrom(cb).get('auth_token'), 'boolean true must be treated as verified');
        assert.equal(db.prepare('SELECT email FROM users WHERE email = ?').get('boolean@example.com').email,
          'boolean@example.com');
      });
    } finally {
      globalThis.fetch = restoreFetch;
      restore();
    }
  });
}, { timeout: 30_000 });

test('missing subject or email claims are rejected', async () => {
  for (const [label, override] of [
    ['missing sub', { sub: undefined }],
    ['missing email', { email: undefined }],
  ]) {
    await withTempDb(async () => {
      const restore = setGoogleConfig();
      const restoreFetch = globalThis.fetch;
      mockGoogle({ tokeninfoBody: baseClaims(override) });
      try {
        await withApp(async ({ base, db }) => {
          await registerAdmin(base);
          const start = await request('POST', base, '/api/auth/google/start', { body: {} });
          const state = stateFrom(start);
          const cb = await callback(base, { state });
          assert.equal(fragmentFrom(cb).get('auth_error'), 'google_identity_invalid', label);
          assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c), 1,
            'no account may be created from an incomplete identity');
        });
      } finally {
        globalThis.fetch = restoreFetch;
        restore();
      }
    });
  }
}, { timeout: 30_000 });

// --- Rate limiting ------------------------------------------------------------

test('/api/auth/google endpoints rate-limit after 20 requests per window', async () => {
  await withTempDb(async () => {
    const restore = setGoogleConfig();
    try {
      await withApp(async ({ base }) => {
        await registerAdmin(base);
        let lastStatus = 0;
        for (let attempt = 0; attempt < 21; attempt += 1) {
          const res = await request('POST', base, '/api/auth/google/start', { body: {} });
          lastStatus = res.status;
        }
        assert.equal(lastStatus, 429, 'the 21st start request within the window must be limited');

        const limited = await request('POST', base, '/api/auth/google/start', { body: {} });
        assert.equal(limited.status, 429);
        assert.match(limited.data.error, /Too many/i);
        assert.ok(Number(limited.data.retryAfterSeconds) >= 1);
        assert.ok(limited.headers.get('retry-after'), 'Retry-After header is present');

        const limitedCallback = await callback(base, { state: 'x' });
        assert.equal(limitedCallback.status, 429, 'the callback shares the same limiter bucket');
      });
    } finally {
      restore();
    }
  });
}, { timeout: 60_000 });

// First-account Google retry authorization regressions.
//
// The retry cookie must let a browser survive the full-page Google redirect
// without ever exposing the owner credential or setup grant to JavaScript,
// browser storage, response bodies, URLs, or logs. All Google traffic is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { hashToken } from '../src/auth/index.js';
import {
  authorizeFirstAccount,
  TEST_BOOTSTRAP_TOKEN,
  TEST_SETUP_CREDENTIAL,
} from './setup-authorization.mjs';

const CLIENT_ID = 'retry-cookie-client';
const CLIENT_SECRET = 'retry-cookie-secret';
const REDIRECT_URI = 'http://localhost:5173/api/auth/google/callback';
const PASSWORD = 'correct-horse-battery';
const COOKIE_NAME = 'myai_setup_retry';
const SETUP_REQUIRED = 'Creating the first account requires the owner-provided setup link. Open that link again and try once.';
const SETUP_INVALID = /invalid or has expired/i;

async function withFreshApp(fn, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-retry-cookie-'));
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
    // Simulate the single trusted Vercel/Render proxy by default. Tests that
    // need plain HTTP or an untrusted peer override `trustProxy`.
    const created = createApp({ provider: null, trustProxy: 'loopback', ...options });
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
  }
}

async function request(
  base,
  method,
  pathname,
  { body, cookie, redirect, headers: extraHeaders = {}, forwardedProto = 'https' } = {},
) {
  const headers = { ...extraHeaders };
  if (forwardedProto) headers['x-forwarded-proto'] = forwardedProto;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const options = {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  if (redirect) options.redirect = redirect;
  const res = await fetch(base + pathname, options);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, data, headers: res.headers };
}

function setCookieHeader(res) {
  return String(res.headers.get('set-cookie') || '');
}

function cookiePair(setCookie) {
  return String(setCookie).split(';')[0].trim();
}

function cookieAttributes(setCookie) {
  const attrs = {};
  for (const part of String(setCookie).split(';').slice(1)) {
    const index = part.indexOf('=');
    const key = (index < 0 ? part.trim() : part.slice(0, index).trim()).toLowerCase();
    const value = index < 0 ? '' : part.slice(index + 1).trim();
    attrs[key] = value;
  }
  return attrs;
}

function isClearCookie(setCookie) {
  const attrs = cookieAttributes(setCookie);
  return /1970|max-age=0/i.test(String(setCookie)) || attrs['max-age'] === '0';
}

async function issueSetupWithCookie(base, requestOptions = {}) {
  const res = await request(base, 'POST', '/api/auth/setup/authorize', {
    body: { setupCredential: TEST_SETUP_CREDENTIAL },
    ...requestOptions,
  });
  const setCookie = setCookieHeader(res);
  const pair = cookiePair(setCookie);
  const handle = decodeURIComponent(pair.split('=')[1] || '');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(pair.startsWith(`${COOKIE_NAME}=`), 'setup authorization must set the retry cookie');
  assert.ok(handle, 'retry handle must be present in the cookie only');
  return { res, setCookie, cookie: pair, handle, setupToken: res.data.setupToken };
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

function claimsFor(sub, email, verified = 'true') {
  return {
    sub,
    email,
    email_verified: verified,
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
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

async function startGoogle(base, { cookie, setupToken } = {}) {
  const body = setupToken ? { setupToken } : {};
  return request(base, 'POST', '/api/auth/google/start', { body, cookie });
}

function stateFrom(start) {
  return new URL(start.data.url).searchParams.get('state');
}

async function callback(base, { code = 'test-code', state, error, forwardedProto = 'https' } = {}) {
  const params = new URLSearchParams();
  if (code) params.set('code', code);
  if (state) params.set('state', state);
  if (error) params.set('error', error);
  const headers = forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {};
  const res = await fetch(`${base}/api/auth/google/callback?${params}`, { redirect: 'manual', headers });
  const location = String(res.headers.get('location') || '');
  return {
    status: res.status,
    location,
    headers: res.headers,
    fragment: new URLSearchParams(location.split('#')[1] || ''),
  };
}

function userCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
}

test('a trusted HTTPS proxy request marks the retry cookie Secure', async () => {
  await withFreshApp(async ({ base }) => {
    const setup = await issueSetupWithCookie(base);
    assert.equal(cookieAttributes(setup.setCookie).secure, '', 'trusted X-Forwarded-Proto must set Secure');
  });
});

test('plain local HTTP leaves the retry cookie non-Secure', async () => {
  await withFreshApp(async ({ base }) => {
    const setup = await issueSetupWithCookie(base, { forwardedProto: '' });
    assert.equal(cookieAttributes(setup.setCookie).secure, undefined, 'plain HTTP must stay usable');
  }, { trustProxy: false });
});

test('an untrusted forwarded-protocol header cannot force Secure', async () => {
  await withFreshApp(async ({ base }) => {
    const setup = await issueSetupWithCookie(base);
    assert.equal(cookieAttributes(setup.setCookie).secure, undefined, 'untrusted proxy headers must be ignored');
  }, { trustProxy: false });
});

test('successful setup authorization sets a narrow HttpOnly retry cookie with only a hash stored', async () => {
  await withFreshApp(async ({ db, base }) => {
    const setup = await issueSetupWithCookie(base);
    const attrs = cookieAttributes(setup.setCookie);

    assert.equal(attrs.httponly, '', 'cookie must be HttpOnly');
    assert.equal(attrs.secure, '', 'hosted configuration must mark the cookie Secure');
    assert.equal(attrs.samesite.toLowerCase(), 'lax');
    assert.equal(attrs.path, '/api/auth');
    assert.equal(attrs.domain, undefined, 'cookie must not be shared across hosts');
    assert.ok(attrs.expires, 'cookie must have an explicit expiry');
    const maxAge = Number(attrs['max-age']);
    assert.ok(maxAge > 0 && maxAge <= 600, 'cookie lifetime must match the setup grant');
    assert.ok(!JSON.stringify(setup.res.data).includes(setup.handle), 'handle must not be in the response body');

    const row = db.prepare('SELECT token_hash, retry_handle_hash, expires_at FROM setup_authorizations WHERE id = 1').get();
    assert.equal(row.retry_handle_hash, hashToken(setup.handle));
    assert.notEqual(row.retry_handle_hash, setup.handle);
    assert.equal(row.token_hash, hashToken(setup.setupToken));
  });
});

test('missing body grant and missing retry cookie still returns SETUP_REQUIRED_ERROR', async () => {
  const restore = setGoogleConfig();
  try {
    await withFreshApp(async ({ base, db }) => {
      const started = await startGoogle(base);
      assert.equal(started.status, 403);
      assert.equal(started.data.error, SETUP_REQUIRED);
      assert.equal(userCount(db), 0);
    });
  } finally { restore(); }
});

test('an invalid retry cookie is rejected and cleared', async () => {
  const restore = setGoogleConfig();
  try {
    await withFreshApp(async ({ base, db }) => {
      await issueSetupWithCookie(base);
      const started = await startGoogle(base, { cookie: `${COOKIE_NAME}=not-a-real-handle` });
      assert.equal(started.status, 403);
      assert.match(started.data.error, SETUP_INVALID);
      assert.ok(isClearCookie(setCookieHeader(started)), 'invalid cookie must be cleared');
      assert.equal(userCount(db), 0);
    });
  } finally { restore(); }
});

test('an expired retry cookie is rejected, invalidated, and cleared', async () => {
  const restore = setGoogleConfig();
  try {
    await withFreshApp(async ({ base, db }) => {
      const setup = await issueSetupWithCookie(base);
      db.prepare('UPDATE setup_authorizations SET expires_at = ? WHERE id = 1')
        .run(new Date(Date.now() - 60_000).toISOString());

      const started = await startGoogle(base, { cookie: setup.cookie });
      assert.equal(started.status, 403);
      assert.match(started.data.error, SETUP_INVALID);
      assert.ok(isClearCookie(setCookieHeader(started)));
      const row = db.prepare('SELECT retry_handle_hash FROM setup_authorizations WHERE id = 1').get();
      assert.equal(row.retry_handle_hash, null, 'expired server-side retry record must be cleared');
      assert.equal(userCount(db), 0);
    });
  } finally { restore(); }
});

test('a cookie-backed start authorizes Google only while no user exists', async () => {
  const restore = setGoogleConfig();
  try {
    await withFreshApp(async ({ base, db }) => {
      const setup = await issueSetupWithCookie(base);
      const started = await startGoogle(base, { cookie: setup.cookie });
      assert.equal(started.status, 200, JSON.stringify(started.data));

      const state = stateFrom(started);
      const grantHash = db.prepare('SELECT token_hash FROM setup_authorizations WHERE id = 1').get().token_hash;
      const row = db.prepare(
        'SELECT setup_authorized, setup_grant_hash FROM oauth_states WHERE state_hash = ?',
      ).get(hashToken(state));
      assert.equal(Number(row.setup_authorized), 1);
      assert.equal(row.setup_grant_hash, grantHash);
      assert.ok(!String(started.data.url).includes(setup.handle), 'handle must never reach Google');
      assert.ok(!String(started.data.url).includes(setup.setupToken), 'grant must never reach Google');
      assert.ok(!String(started.data.url).includes(TEST_SETUP_CREDENTIAL), 'owner credential must never reach Google');
    });
  } finally { restore(); }
});

test('a retry cookie cannot authorize ordinary password registration', async () => {
  await withFreshApp(async ({ base, db }) => {
    const setup = await issueSetupWithCookie(base);
    const registered = await request(base, 'POST', '/api/auth/register', {
      body: { email: 'first@example.com', password: PASSWORD },
      cookie: setup.cookie,
    });
    assert.equal(registered.status, 403);
    assert.equal(registered.data.error, SETUP_REQUIRED);
    assert.equal(userCount(db), 0);
  });
});

test('failed and cancelled Google callbacks remain retryable within the original expiry', async () => {
  const restore = setGoogleConfig();
  const originalFetch = globalThis.fetch;
  try {
    await withFreshApp(async ({ base, db }) => {
      const setup = await issueSetupWithCookie(base);
      const expiresBefore = db.prepare('SELECT expires_at FROM setup_authorizations WHERE id = 1').get().expires_at;

      const first = await startGoogle(base, { cookie: setup.cookie });
      assert.equal(first.status, 200);
      assert.ok(stateFrom(first));

      const cancelled = await callback(base, { error: 'access_denied' });
      assert.equal(cancelled.fragment.get('auth_error'), 'google_cancelled');
      assert.equal(userCount(db), 0);
      const afterCancel = await startGoogle(base, { cookie: setup.cookie });
      assert.equal(afterCancel.status, 200, 'the cookie must survive an explicit cancellation');

      globalThis.fetch = async (url, options) => {
        if (String(url) === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400, headers: { 'content-type': 'application/json' },
          });
        }
        return originalFetch(url, options);
      };
      const failed = await callback(base, { state: stateFrom(afterCancel) });
      assert.equal(failed.fragment.get('auth_error'), 'google_unavailable');
      assert.equal(userCount(db), 0);

      globalThis.fetch = originalFetch;
      const restoreClaims = mockGoogleClaims(claimsFor('google-sub-retry', 'retry@example.com'));
      try {
        const retry = await startGoogle(base, { cookie: setup.cookie });
        assert.equal(retry.status, 200, 'the cookie must survive a failed callback');
        const expiresAfter = db.prepare('SELECT expires_at FROM setup_authorizations WHERE id = 1').get().expires_at;
        assert.equal(expiresAfter, expiresBefore, 'retry must not extend the original expiry');
        const ok = await callback(base, { state: stateFrom(retry) });
        assert.ok(ok.fragment.get('auth_token'));
        assert.equal(userCount(db), 1);
      } finally { restoreClaims(); }
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('successful password first-account creation consumes the retry record and clears the cookie', async () => {
  await withFreshApp(async ({ base, db }) => {
    const setup = await issueSetupWithCookie(base);
    const created = await request(base, 'POST', '/api/auth/register', {
      body: { email: 'owner@example.com', password: PASSWORD, setupToken: setup.setupToken },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.ok(isClearCookie(setCookieHeader(created)), 'success must clear the retry cookie');
    assert.equal(cookieAttributes(setCookieHeader(created)).secure, '', 'clear must match the trusted HTTPS request');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM setup_authorizations').get().c, 0);
    assert.notEqual(db.prepare('SELECT consumed_at FROM setup_credentials WHERE id = 1').get().consumed_at, null);
  });
});

test('a used retry cookie cannot create additional accounts after the first account exists', async () => {
  const restore = setGoogleConfig();
  const originalFetch = globalThis.fetch;
  try {
    await withFreshApp(async ({ base, db }) => {
      const setup = await issueSetupWithCookie(base);
      const restoreFirst = mockGoogleClaims(claimsFor('google-sub-first', 'first@example.com'));
      try {
        const first = await startGoogle(base, { cookie: setup.cookie });
        const created = await callback(base, { state: stateFrom(first) });
        assert.ok(created.fragment.get('auth_token'));
        assert.ok(isClearCookie(setCookieHeader(created)));
      } finally { restoreFirst(); }
      assert.equal(userCount(db), 1);

      config.allowRegistration = false;
      const restoreSecond = mockGoogleClaims(claimsFor('google-sub-second', 'second@example.com'));
      try {
        const second = await startGoogle(base, { cookie: setup.cookie });
        assert.equal(second.status, 200, 'an existing user may still start an ordinary sign-in');
        const blocked = await callback(base, { state: stateFrom(second) });
        assert.equal(blocked.fragment.get('auth_error'), 'google_registration_disabled');
      } finally { restoreSecond(); }
      assert.equal(userCount(db), 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('retry cookie and owner credentials cannot reach administrator provisioning', async () => {
  await withFreshApp(async ({ base, db }) => {
    const setup = await issueSetupWithCookie(base);

    const cookieOnly = await request(base, 'POST', '/api/auth/admin/provision', { cookie: setup.cookie });
    assert.equal(cookieOnly.status, 403);

    const setupAsAdmin = await request(base, 'POST', '/api/auth/admin/provision', {
      body: { bootstrapToken: TEST_SETUP_CREDENTIAL, email: 'admin@example.com', password: PASSWORD },
    });
    assert.equal(setupAsAdmin.status, 403);

    const adminAsSetup = await request(base, 'POST', '/api/auth/setup/authorize', {
      body: { setupCredential: TEST_BOOTSTRAP_TOKEN },
    });
    assert.equal(adminAsSetup.status, 403);
    assert.equal(userCount(db), 0);
  });
});

test('a real setup credential still exchanges successfully (separation sanity check)', async () => {
  await withFreshApp(async ({ base }) => {
    const granted = await authorizeFirstAccount(base);
    assert.ok(granted, 'the owner setup credential must remain valid');
  });
});

test('a stale body token from another tab does not clear the newer retry cookie', async () => {
  const restore = setGoogleConfig();
  try {
    await withFreshApp(async ({ base, db }) => {
      const olderTab = await issueSetupWithCookie(base);
      const newerTab = await issueSetupWithCookie(base);

      const stale = await startGoogle(base, {
        setupToken: olderTab.setupToken,
        cookie: newerTab.cookie,
      });
      assert.equal(stale.status, 403);
      assert.match(stale.data.error, SETUP_INVALID);
      assert.equal(
        isClearCookie(setCookieHeader(stale)),
        false,
        'a stale body token must not clear the newer tab cookie',
      );

      const retry = await startGoogle(base, { cookie: newerTab.cookie });
      assert.equal(retry.status, 200, 'the newer tab cookie must remain usable');
      assert.ok(stateFrom(retry));
      assert.equal(userCount(db), 0);
    });
  } finally {
    restore();
  }
});

test('a stale retry cookie is cleared once another session creates the first account', async () => {
  const restore = setGoogleConfig();
  const originalFetch = globalThis.fetch;
  try {
    await withFreshApp(async ({ base, db }) => {
      const otherBrowser = await issueSetupWithCookie(base);
      const firstBrowser = await issueSetupWithCookie(base);

      const start = await startGoogle(base, { setupToken: firstBrowser.setupToken });
      assert.equal(start.status, 200, JSON.stringify(start.data));
      const restoreClaims = mockGoogleClaims(claimsFor('google-sub-owner', 'owner@example.com'));
      try {
        const created = await callback(base, { state: stateFrom(start) });
        assert.ok(created.fragment.get('auth_token'));
      } finally {
        restoreClaims();
      }
      assert.equal(userCount(db), 1);

      const staleCookieStart = await startGoogle(base, { cookie: otherBrowser.cookie });
      assert.equal(staleCookieStart.status, 200, 'existing-user sign-in must remain unaffected');
      assert.ok(
        isClearCookie(setCookieHeader(staleCookieStart)),
        'terminal first-account state must clear the stale cookie',
      );
      assert.equal(
        cookieAttributes(setCookieHeader(staleCookieStart)).secure,
        '',
        'clear must match the trusted HTTPS request',
      );
      const stateHash = hashToken(stateFrom(staleCookieStart));
      const row = db.prepare('SELECT setup_authorized FROM oauth_states WHERE state_hash = ?').get(stateHash);
      assert.equal(Number(row.setup_authorized), 0, 'the stale cookie must not authorize another first account');
      assert.equal(userCount(db), 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

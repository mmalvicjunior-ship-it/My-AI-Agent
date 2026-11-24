// Regression coverage for bounded renewal of the existing DB-backed sessions.
// There is no refresh-token system in this branch: the same opaque bearer token
// is verified and its already-bounded expiry is extended on active use.
// All fetch calls are mocked or local; no OAuth/provider request is made.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { mockProvider } from '../src/ai/mock.js';
import { createSession, deleteExpiredSessions, findSessionUser, hashToken } from '../src/auth/index.js';
import {
  __resetAuthCallbackRunnerForTests,
  bumpAuthEpoch,
  chooseAuthTokenForInitialization,
  createAuthCallbackRunner,
  readAuthEpoch,
  renewExistingSession,
  shouldApplyRenewalResult,
} from '../../apps/web/src/authFlow.js';

let server;
let db;
let base;

async function request(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json().catch(() => null) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function meResponse(user, expiresAt = '2031-01-01T00:00:00.000Z') {
  return {
    status: 200,
    ok: true,
    json: async () => ({ ok: true, user, expiresAt, absoluteExpiresAt: '2032-01-01T00:00:00.000Z' }),
  };
}

before(async () => {
  const created = createApp({ provider: mockProvider });
  db = created.db;
  server = created.app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
});

beforeEach(() => {
  __resetAuthCallbackRunnerForTests();
});

test('an active session renews its sliding expiry but never exceeds its absolute cap', async () => {
  const email = `renewal-${Date.now()}@example.com`;
  const registered = await request('POST', '/api/auth/register', { body: { email, password: 'long-enough-password' } });
  assert.equal(registered.status, 201);
  const token = registered.data.token;
  const original = db.prepare('SELECT token_hash, expires_at, absolute_expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
  assert.ok(original.absolute_expires_at);
  assert.ok(Date.parse(original.absolute_expires_at) > Date.parse(original.expires_at));

  // Simulate a token near the end of its sliding window without waiting days.
  const nearExpiry = new Date(Date.now() + 1000).toISOString();
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(nearExpiry, original.token_hash);

  const user = findSessionUser(db, token);
  assert.equal(user.id, registered.data.user.id);
  const renewed = db.prepare('SELECT expires_at, absolute_expires_at FROM sessions WHERE token_hash = ?').get(original.token_hash);
  assert.ok(Date.parse(renewed.expires_at) > Date.parse(nearExpiry));
  assert.ok(Date.parse(renewed.expires_at) <= Date.parse(renewed.absolute_expires_at));

  // /api/auth/me uses the same renewal path and returns expiry metadata only.
  const me = await request('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, registered.data.user.id);
  assert.ok(Date.parse(me.data.expiresAt) > Date.now());
  assert.ok(!JSON.stringify(me.data).includes(token));
});

test('the absolute expiry still ends a continuously used session', async () => {
  const email = `absolute-${Date.now()}@example.com`;
  const registered = await request('POST', '/api/auth/register', { body: { email, password: 'long-enough-password' } });
  const token = registered.data.token;
  const row = db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(hashToken(token));
  const absolute = new Date(Date.now() + 1000).toISOString();
  db.prepare('UPDATE sessions SET expires_at = ?, absolute_expires_at = ? WHERE token_hash = ?')
    .run(new Date(Date.now() + 86400000).toISOString(), absolute, row.token_hash);

  const user = findSessionUser(db, token);
  assert.equal(user.id, registered.data.user.id);
  const capped = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(row.token_hash);
  assert.equal(capped.expires_at, absolute);

  db.prepare('UPDATE sessions SET absolute_expires_at = ? WHERE token_hash = ?')
    .run(new Date(Date.now() - 1000).toISOString(), row.token_hash);
  assert.equal(findSessionUser(db, token), null);
  assert.equal(db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(row.token_hash), undefined);
});

test('expired or malformed bearer credentials are rejected and deleted', async () => {
  const email = `expired-${Date.now()}@example.com`;
  const registered = await request('POST', '/api/auth/register', { body: { email, password: 'long-enough-password' } });
  const token = registered.data.token;
  const row = db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(hashToken(token));
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run(new Date(Date.now() - 1000).toISOString(), row.token_hash);

  assert.equal(findSessionUser(db, token), null);
  assert.equal(findSessionUser(db, 'too-short'), null);
  assert.equal(findSessionUser(db, 'a'.repeat(50)), null);
  assert.equal(db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(row.token_hash), undefined);

  const me = await request('GET', '/api/auth/me', { token });
  assert.equal(me.status, 401);
  assert.equal(me.data.code, 'AUTH_REQUIRED');
});

test('cleanup removes sessions whose absolute lifetime ended even if sliding expiry is future', () => {
  const userRow = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const session = createSession(db, userRow.id, 1);
  const row = db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(hashToken(session.token));
  db.prepare('UPDATE sessions SET expires_at = ?, absolute_expires_at = ? WHERE token_hash = ?')
    .run(new Date(Date.now() + 86400000).toISOString(), new Date(Date.now() - 1000).toISOString(), row.token_hash);
  deleteExpiredSessions(db);
  assert.equal(db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(row.token_hash), undefined);
});

test('restoring a browser session verifies the stored token and adopts renewed expiry', async () => {
  const user = { id: 'account-a', email: 'a@example.com' };
  let calls = 0;
  const result = await renewExistingSession({
    token: 'stored-token',
    expectedUserId: user.id,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.match(url, /\/api\/auth\/me$/);
      assert.equal(init.headers.Authorization, 'Bearer stored-token');
      return meResponse(user);
    },
    state: {},
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'authenticated');
  assert.equal(result.user.id, user.id);
  assert.equal(result.expiresAt, '2031-01-01T00:00:00.000Z');
  assert.equal(chooseAuthTokenForInitialization({ storedToken: 'stored-token' }), 'stored-token');
});

test('an invalid stored token reports one failure and never starts a retry loop', async () => {
  let calls = 0;
  const result = await renewExistingSession({
    token: 'expired-token',
    fetchImpl: async () => {
      calls += 1;
      return { status: 401, ok: false, json: async () => ({ ok: false, code: 'AUTH_REQUIRED' }) };
    },
    state: {},
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'auth_required');
});

test('a network failure keeps the stored session without automatic retries', async () => {
  let calls = 0;
  const result = await renewExistingSession({
    token: 'offline-token',
    fetchImpl: async () => { calls += 1; throw new Error('offline'); },
    state: {},
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'unavailable');
});

test('only one renewal request is in flight per token and a switched token is superseded', async () => {
  const gate = deferred();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await gate.promise;
    return meResponse({ id: 'account-a' });
  };
  const state = { inFlightToken: null };
  const first = renewExistingSession({ token: 'token-a', fetchImpl, state });
  const duplicate = await renewExistingSession({ token: 'token-a', fetchImpl, state });
  const switched = await renewExistingSession({ token: 'token-b', fetchImpl, state });
  assert.equal(duplicate.status, 'in_flight');
  assert.equal(switched.status, 'superseded');
  assert.equal(calls, 1);
  gate.resolve();
  assert.equal((await first).status, 'authenticated');
});

test('sign-out during an active renewal prevents the result from restoring a workspace', async () => {
  const authenticated = { status: 'authenticated', user: { id: 'account-a' } };
  assert.equal(shouldApplyRenewalResult({
    result: authenticated,
    generationAtStart: 1,
    currentGeneration: 1,
    requestToken: 'token-a',
    currentToken: 'token-a',
  }), true);
  assert.equal(shouldApplyRenewalResult({
    result: authenticated,
    generationAtStart: 1,
    currentGeneration: 2, // explicit sign-out incremented the generation
    requestToken: 'token-a',
    currentToken: 'token-a',
  }), false);
  assert.equal(shouldApplyRenewalResult({
    result: authenticated,
    generationAtStart: 1,
    currentGeneration: 1,
    requestToken: 'token-a',
    currentToken: 'token-b', // account switched during renewal
  }), false);
  assert.equal(shouldApplyRenewalResult({
    result: authenticated,
    generationAtStart: 1,
    currentGeneration: 1,
    requestToken: 'token-a',
    currentToken: null,
  }), false);
});

test('a renewal response for another account is rejected before workspace restoration', async () => {
  const result = await renewExistingSession({
    token: 'token-a',
    expectedUserId: 'account-a',
    fetchImpl: async () => meResponse({ id: 'account-b' }),
    state: {},
  });
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'identity_mismatch');
});

test('sign-out or account switching during callback verification drops the stale result', async () => {
  let generation = 1;
  let authenticated = 0;
  let errors = 0;
  let cleared = 0;
  const gate = deferred();
  const runner = createAuthCallbackRunner({
    fetchImpl: async () => {
      await gate.promise;
      generation += 1; // sign-out/account switch while /me was in flight
      return meResponse({ id: 'account-a' });
    },
    getTransitionGeneration: () => generation,
    onAuthenticated: () => { authenticated += 1; },
    onError: () => { errors += 1; },
    clearHash: () => { cleared += 1; },
  });
  const pending = runner.run('#auth_token=fresh-token');
  gate.resolve();
  const result = await pending;
  assert.equal(result.status, 'stale');
  assert.equal(authenticated, 0);
  assert.equal(errors, 0);
  assert.equal(cleared, 0);
});

test('a cross-tab account selection during verification supersedes the callback', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
  const gate = deferred();
  let authenticated = 0;
  let cleared = 0;
  const runner = createAuthCallbackRunner({
    fetchImpl: async () => {
      await gate.promise;
      return meResponse({ id: 'account-a' });
    },
    storage,
    getAuthEpoch: () => readAuthEpoch(storage),
    onAuthenticated: () => { authenticated += 1; },
    clearHash: () => { cleared += 1; },
  });
  const pending = runner.run('#auth_token=fresh-token');
  bumpAuthEpoch(storage); // newer account selected in a different tab
  gate.resolve();
  const result = await pending;
  assert.equal(result.status, 'superseded');
  assert.equal(authenticated, 0);
  assert.equal(cleared, 1);
});

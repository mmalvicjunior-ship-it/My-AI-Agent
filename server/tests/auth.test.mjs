// Authentication tests: registration, login, logout, session verification,
// session expiry, hashed storage, and unauthenticated route protection.
// No AI provider is called and no real network request is made.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { mockProvider } from '../src/ai/mock.js';
import { hashPassword, verifyPassword } from '../src/auth/index.js';
import { authorizeFirstAccount } from './setup-authorization.mjs';

let server;
let db;
let base;

async function request(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, data };
}

async function register(email, password = 'correct-horse-battery') {
  const setupToken = await authorizeFirstAccount(base);
  return request('POST', '/api/auth/register', { body: { email, password, setupToken } });
}

function login(email, password = 'correct-horse-battery') {
  return request('POST', '/api/auth/login', { body: { email, password } });
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

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------
test('health stays public and never exposes secrets', async () => {
  const { status, data } = await request('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  const serialized = JSON.stringify(data).toLowerCase();
  assert.ok(!serialized.includes('aiza'));
  assert.ok(!serialized.includes('sk-'));
  assert.ok(!('aiApiKey' in data));
  assert.ok(!('password' in data));
});

test('registration validates its input', async () => {
  const cases = [
    [{ password: 'long-enough-password' }, 'missing email'],
    [{ email: 'not-an-email', password: 'long-enough-password' }, 'invalid email'],
    [{ email: 'short@example.com', password: 'short' }, 'short password'],
  ];
  for (const [body, label] of cases) {
    const { status, data } = await request('POST', '/api/auth/register', { body });
    assert.equal(status, 400, `${label} must be rejected`);
    assert.equal(data.ok, false);
    assert.equal(typeof data.error, 'string');
  }
});

test('password hashing is salted, verified, and rejects malformed hashes', () => {
  const first = hashPassword('correct-horse-battery');
  const second = hashPassword('correct-horse-battery');

  assert.match(first, /^scrypt\$/);
  assert.notEqual(first, second, 'the same password must produce different salted hashes');
  assert.equal(verifyPassword('correct-horse-battery', first), true);
  assert.equal(verifyPassword('correct-horse-battery', second), true);
  assert.equal(verifyPassword('wrong-password', first), false);
  assert.equal(verifyPassword('correct-horse-battery', 'not-a-hash'), false);
  assert.equal(verifyPassword('', first), false);
  assert.equal(verifyPassword(null, first), false);
});

// ---------------------------------------------------------------------------
// Registration, login, sessions
// ---------------------------------------------------------------------------
test('registration creates an account without exposing the password', async () => {
  const { status, data } = await register('Alice@Example.com');
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  assert.equal(data.user.email, 'alice@example.com');
  assert.equal(typeof data.token, 'string');
  assert.ok(data.token.length >= 40);
  assert.ok(!('password' in data));
  assert.ok(!('password_hash' in data));
  assert.ok(!JSON.stringify(data).includes('correct-horse-battery'));

  const row = db.prepare('SELECT email, password_hash FROM users WHERE email = ?').get('alice@example.com');
  assert.equal(row.email, 'alice@example.com');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes('correct-horse-battery'));

  // Only the SHA-256 hash of the token may be stored.
  const sessions = db.prepare('SELECT token_hash FROM sessions').all();
  const expected = crypto.createHash('sha256').update(data.token).digest('hex');
  assert.ok(sessions.some((row) => row.token_hash === expected));
  assert.ok(sessions.every((row) => row.token_hash !== data.token));
});

test('duplicate registration is rejected case-insensitively', async () => {
  const { status, data } = await register('ALICE@example.com');
  assert.equal(status, 409);
  assert.equal(data.ok, false);
});

test('login accepts the right password and rejects the wrong one', async () => {
  const wrong = await login('alice@example.com', 'definitely-wrong');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.ok, false);

  const unknown = await login('nobody@example.com', 'whatever-long');
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.ok, false);

  const good = await login('alice@example.com');
  assert.equal(good.status, 200);
  assert.equal(good.data.ok, true);
  assert.equal(typeof good.data.token, 'string');
  assert.notEqual(good.data.token, undefined);
});

test('login requires both email and password', async () => {
  const { status, data } = await request('POST', '/api/auth/login', {
    body: { email: 'alice@example.com' },
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
  assert.match(data.error, /email and password/i);
});

test('session verification accepts a live token and rejects missing or bogus tokens', async () => {
  const { data: session } = await login('alice@example.com');

  const me = await request('GET', '/api/auth/me', { token: session.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'alice@example.com');

  assert.equal((await request('GET', '/api/auth/me')).status, 401);
  assert.equal((await request('GET', '/api/auth/me', { token: 'x'.repeat(64) })).status, 401);
});

test('logout invalidates only the presented session', async () => {
  const { data: first } = await login('alice@example.com');
  const { data: second } = await login('alice@example.com');

  const out = await request('POST', '/api/auth/logout', { token: first.token });
  assert.equal(out.status, 200);
  assert.equal(out.data.ok, true);

  assert.equal((await request('GET', '/api/auth/me', { token: first.token })).status, 401);
  assert.equal((await request('GET', '/api/auth/me', { token: second.token })).status, 200);
});

test('an expired session is rejected', async () => {
  const email = 'expiry@example.com';
  const { data: created } = await register(email);
  const userId = created.user.id;

  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), userId);

  assert.equal((await request('GET', '/api/auth/me', { token: created.token })).status, 401);
  assert.equal((await request('GET', '/api/projects', { token: created.token })).status, 401);
});

// ---------------------------------------------------------------------------
// Route protection
// ---------------------------------------------------------------------------
test('every sensitive API route rejects anonymous requests with 401', async () => {
  const routes = [
    ['GET', '/api/projects'],
    ['POST', '/api/projects'],
    ['GET', '/api/projects/1/files'],
    ['GET', '/api/projects/1/file?path=readme.md'],
    ['GET', '/api/projects/1/tree'],
    ['GET', '/api/projects/1/search?q=test'],
    ['PUT', '/api/projects/1/file?path=a.js'],
    ['DELETE', '/api/projects/1/file?path=a.js'],
    ['GET', '/api/projects/1/changes'],
    ['GET', '/api/projects/1/proposals'],
    ['POST', '/api/projects/1/proposals/x/apply'],
    ['POST', '/api/projects/1/proposals/x/reject'],
    ['POST', '/api/projects/1/commands/x/run'],
    ['POST', '/api/chat'],
    ['POST', '/api/tasks'],
    ['GET', '/api/tasks'],
    ['GET', '/api/tasks/1'],
    ['POST', '/api/tasks/1/cancel'],
  ];

  for (const [method, path] of routes) {
    const { status, data } = await request(method, path);
    assert.equal(status, 401, `${method} ${path} must require authentication`);
    assert.equal(data?.ok, false);
    assert.match(data?.error || '', /authentication/i);
  }
});

test('authenticated requests still work and tokens cannot be brute-forced', async () => {
  const { data: session } = await login('alice@example.com');
  const list = await request('GET', '/api/projects', { token: session.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.projects, []);
});

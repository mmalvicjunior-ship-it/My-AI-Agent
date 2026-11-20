// Role-based auth regression tests.
//
// Verifies the first-account bootstrap flow, the is_admin flag, and that
// ordinary users can never register as administrators:
//   1. First account requires BOOTSTRAP_TOKEN (unchanged behavior).
//   2. The first account is created through the normal register endpoint and
//      receives is_admin=true; later accounts always receive is_admin=false.
//   3. A client-supplied is_admin field is ignored on every registration.
//   4. Login and /api/auth/me expose isAdmin so the frontend can redirect by
//      actual account role.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { createUserWithRole } from '../src/routes/auth.js';

const servers = [];
let base;
let db;

async function request(method, pathname, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* non-JSON response */ }
  return { status: res.status, data };
}

before(async () => {
  const created = createApp({ provider: null });
  db = created.db;
  const server = created.app.listen(0);
  await once(server, 'listening');
  servers.push(server);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

test('first account registers normally with the bootstrap token and becomes admin', async () => {
  const originalAllow = config.allowRegistration;
  try {
    config.allowRegistration = false; // flag must not lock out initial creation
    const res = await request('POST', '/api/auth/register', {
      body: { email: 'admin@example.com', password: 'correct-horse-battery', bootstrapToken: 'test-bootstrap-token' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.user.isAdmin, true, 'the first account must be the administrator');
    assert.ok(res.data.token, 'first account receives a session token');
  } finally {
    config.allowRegistration = originalAllow;
  }
});

test('second account registers normally and is never an administrator', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: 'user@example.com', password: 'correct-horse-battery' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.user.isAdmin, false, 'later accounts must not be administrators');
});

test('client-supplied is_admin is ignored on registration', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: 'evil@example.com', password: 'correct-horse-battery', isAdmin: true, is_admin: true, admin: true },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.user.isAdmin, false, 'a client cannot self-promote to administrator');
});

test('login and /me expose the real account role', async () => {
  const adminLogin = await request('POST', '/api/auth/login', {
    body: { email: 'admin@example.com', password: 'correct-horse-battery' },
  });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.data.user.isAdmin, true);

  const me = await request('GET', '/api/auth/me', { token: adminLogin.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.isAdmin, true);

  const userLogin = await request('POST', '/api/auth/login', {
    body: { email: 'user@example.com', password: 'correct-horse-battery' },
  });
  assert.equal(userLogin.status, 200);
  assert.equal(userLogin.data.user.isAdmin, false);

  const meUser = await request('GET', '/api/auth/me', { token: userLogin.data.token });
  assert.equal(meUser.status, 200);
  assert.equal(meUser.data.user.isAdmin, false);
});

test('only one administrator can exist and a lost first-account race is downgraded', () => {
  const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1').all();
  assert.equal(admins.length, 1, 'the database must contain exactly one administrator');

  assert.throws(
    () => db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, 1)')
      .run('second-admin@example.com', 'not-a-real-hash'),
    /UNIQUE constraint failed: users\.is_admin|idx_users_single_admin/i,
  );

  // Simulates the request that sees an empty table but inserts after another
  // first-account attempt has already committed.
  const lostRace = createUserWithRole(db, {
    email: 'race-loser@example.com',
    passwordHash: 'not-a-real-hash',
    googleSub: null,
    requestAdmin: true,
  });
  assert.equal(lostRace.isAdmin, false, 'the losing request must become an ordinary user');
  const stored = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(lostRace.id);
  assert.equal(stored.is_admin, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c, 1);
});

test('first-account registration still fails without a valid bootstrap token', async () => {
  // Fresh, empty database: the bootstrap path must still fail closed, proving
  // that the URL-based flow cannot bypass server-side validation.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-authrole-'));
  const tempDbPath = path.join(tempDir, 'fresh.db');
  const originalDbPath = config.databasePath;
  const originalWorkspaceRoot = config.workspaceRoot;
  config.databasePath = tempDbPath;
  config.workspaceRoot = path.join(tempDir, 'workspaces');
  let freshServer;
  try {
    const created = createApp({ provider: null });
    freshServer = created.app.listen(0);
    await once(freshServer, 'listening');
    const freshBase = `http://127.0.0.1:${freshServer.address().port}`;

    const noToken = await fetch(`${freshBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'correct-horse-battery' }),
    });
    const noTokenData = await noToken.json();
    assert.equal(noToken.status, 403);
    assert.match(noTokenData.error, /bootstrap token/i);

    const wrongToken = await fetch(`${freshBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'correct-horse-battery', bootstrapToken: 'not-the-token' }),
    });
    const wrongTokenData = await wrongToken.json();
    assert.equal(wrongToken.status, 403);
    assert.match(wrongTokenData.error, /bootstrap token/i);

    const adminRes = await fetch(`${freshBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.com', password: 'correct-horse-battery', bootstrapToken: 'test-bootstrap-token' }),
    });
    const adminData = await adminRes.json();
    assert.equal(adminRes.status, 201);
    assert.equal(adminData.user.isAdmin, true, 'the first account must be the administrator');
  } finally {
    freshServer?.closeAllConnections?.();
    freshServer?.close();
    config.databasePath = originalDbPath;
    config.workspaceRoot = originalWorkspaceRoot;
    // Do not delete the temp dir: SQLite may still hold the fresh DB open on
    // Windows; leaving it is safe and consistent with test-suite behavior.
  }
}, { timeout: 30_000 });

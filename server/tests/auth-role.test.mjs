// Role-based auth regression tests.
//
// Verifies that public registration never grants admin, that client-supplied
// role fields are ignored, and that the owner-only provisioning endpoint is
// the sole source of administrator privileges:
//   1. First and later public accounts are ordinary users.
//   2. A client cannot self-promote with isAdmin/is_admin/admin fields.
//   3. Provisioning promotes an existing account and existing sessions see it.
//   4. The database still permits only one administrator.
//   5. On a fresh database, ordinary registration needs no token while
//      administrator provisioning remains token-gated.
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
let firstAccountToken;

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

test('the first public account registers without a token and is not an admin', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: 'admin@example.com', password: 'correct-horse-battery' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.user.isAdmin, false, 'public registration never grants admin');
  assert.ok(res.data.token, 'the first public account receives a session token');
  firstAccountToken = res.data.token;
});

test('later public accounts are never administrators', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: 'user@example.com', password: 'correct-horse-battery' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.user.isAdmin, false, 'later accounts must not be administrators');
});

test('client-supplied role fields are ignored on registration', async () => {
  const res = await request('POST', '/api/auth/register', {
    body: { email: 'evil@example.com', password: 'correct-horse-battery', isAdmin: true, is_admin: true, admin: true },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.user.isAdmin, false, 'a client cannot self-promote to administrator');
});

test('owner-only provisioning promotes an existing account and updates its role', async () => {
  const provision = await request('POST', '/api/auth/admin/provision', {
    body: {
      email: 'admin@example.com',
      bootstrapToken: 'test-bootstrap-token',
      isAdmin: false,
    },
  });
  assert.equal(provision.status, 200, JSON.stringify(provision.data));
  assert.equal(provision.data.created, false);
  assert.equal(provision.data.user.isAdmin, true);

  const me = await request('GET', '/api/auth/me', { token: firstAccountToken });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.isAdmin, true, 'the existing session sees the promoted role');
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

test('only one administrator can exist and a lost provisioning race is downgraded', () => {
  const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1').all();
  assert.equal(admins.length, 1, 'the database must contain exactly one administrator');

  assert.throws(
    () => db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, 1)')
      .run('second-admin@example.com', 'not-a-real-hash'),
    /UNIQUE constraint failed: users\.is_admin|idx_users_single_admin/i,
  );

  // Simulates a provisioning request that saw no admin but inserts after
  // another provisioning request committed.
  const lostRace = createUserWithRole(db, {
    email: 'race-loser@example.com',
    passwordHash: 'not-a-real-hash',
    googleSub: null,
    requestAdmin: true,
  });
  assert.equal(lostRace.isAdmin, false, 'the losing request must not create a second admin');
  const stored = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(lostRace.id);
  assert.equal(stored.is_admin, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c, 1);
});

test('a fresh database allows ordinary registration but keeps provisioning token-gated', async () => {
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

    const first = await fetch(`${freshBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.com', password: 'correct-horse-battery' }),
    });
    const firstData = await first.json();
    assert.equal(first.status, 201, 'ordinary registration needs no bootstrap token');
    assert.equal(firstData.user.isAdmin, false);

    for (const bootstrapToken of [undefined, 'not-the-token']) {
      const denied = await fetch(`${freshBase}/api/auth/admin/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'fresh-admin@example.com', password: 'correct-horse-battery', bootstrapToken }),
      });
      assert.equal(denied.status, 403);
    }

    const provisioned = await fetch(`${freshBase}/api/auth/admin/provision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'fresh-admin@example.com',
        password: 'correct-horse-battery',
        bootstrapToken: 'test-bootstrap-token',
      }),
    });
    const provisionedData = await provisioned.json();
    assert.equal(provisioned.status, 201);
    assert.equal(provisionedData.user.isAdmin, true);
  } finally {
    freshServer?.closeAllConnections?.();
    freshServer?.close();
    config.databasePath = originalDbPath;
    config.workspaceRoot = originalWorkspaceRoot;
    // Do not delete the temp dir: SQLite may still hold the fresh DB open on
    // Windows; leaving it is safe and consistent with test-suite behavior.
  }
}, { timeout: 30_000 });

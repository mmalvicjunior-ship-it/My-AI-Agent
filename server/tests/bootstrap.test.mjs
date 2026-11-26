// Administrator provisioning regression tests.
//
// The first account is authorized by the owner setup link and is always an
// ordinary user. The existing BOOTSTRAP_TOKEN is also used by the owner-only
// POST /api/auth/admin/provision endpoint, which works while there is no
// administrator and stops working once one exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { authorizeFirstAccount } from './setup-authorization.mjs';

async function withFreshApp(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-admin-'));
  const originalDbPath = config.databasePath;
  const originalWorkspaceRoot = config.workspaceRoot;
  config.databasePath = path.join(tempDir, 'fresh.db');
  config.workspaceRoot = path.join(tempDir, 'workspaces');
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
    config.databasePath = originalDbPath;
    config.workspaceRoot = originalWorkspaceRoot;
    // Temp files are left in place on Windows, where SQLite may keep a handle.
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
  try {
    data = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, data };
}

function adminCount(db) {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1').get().count);
}

test('ordinary registration with valid setup authorization stays non-admin', async () => {
  await withFreshApp(async ({ base, db }) => {
    const setupToken = await authorizeFirstAccount(base);
    const res = await request(base, 'POST', '/api/auth/register', {
      body: {
        email: 'first@example.com',
        password: 'correct-horse-battery',
        setupToken,
        isAdmin: true,
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.isAdmin, false, 'public registration never grants admin');
    assert.ok(res.data.token);
    assert.equal(adminCount(db), 0, 'no administrator is inferred from the first account');
  });
}, { timeout: 30_000 });

test('admin provisioning is refused without a valid server token', async () => {
  await withFreshApp(async ({ base, db }) => {
    const originalToken = config.bootstrapToken;
    try {
      config.bootstrapToken = '';
      const unconfigured = await request(base, 'POST', '/api/auth/admin/provision', {
        body: { email: 'admin@example.com', password: 'correct-horse-battery' },
      });
      assert.equal(unconfigured.status, 403);
      assert.doesNotMatch(unconfigured.data.error, /BOOTSTRAP_TOKEN|bootstrapToken|#bootstrap=/i);

      config.bootstrapToken = originalToken;
      const missing = await request(base, 'POST', '/api/auth/admin/provision', {
        body: { email: 'admin@example.com', password: 'correct-horse-battery' },
      });
      assert.equal(missing.status, 403);

      const wrong = await request(base, 'POST', '/api/auth/admin/provision', {
        body: { email: 'admin@example.com', password: 'correct-horse-battery', bootstrapToken: 'not-the-token' },
      });
      assert.equal(wrong.status, 403);
      assert.equal(adminCount(db), 0);
    } finally {
      config.bootstrapToken = originalToken;
    }
  });
}, { timeout: 30_000 });

test('admin provisioning creates the first administrator with the server token', async () => {
  await withFreshApp(async ({ base, db }) => {
    const res = await request(base, 'POST', '/api/auth/admin/provision', {
      body: {
        email: 'admin@example.com',
        password: 'correct-horse-battery',
        bootstrapToken: 'test-bootstrap-token',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.created, true);
    assert.equal(res.data.user.isAdmin, true);
    assert.ok(res.data.token, 'a newly created admin receives a session');
    assert.equal(adminCount(db), 1);

    const me = await request(base, 'GET', '/api/auth/me', { token: res.data.token });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.isAdmin, true);
  });
}, { timeout: 30_000 });

test('admin provisioning stops after one administrator exists', async () => {
  await withFreshApp(async ({ base, db }) => {
    const first = await request(base, 'POST', '/api/auth/admin/provision', {
      body: {
        email: 'admin@example.com',
        password: 'correct-horse-battery',
        bootstrapToken: 'test-bootstrap-token',
      },
    });
    assert.equal(first.status, 201);

    const second = await request(base, 'POST', '/api/auth/admin/provision', {
      body: {
        email: 'second-admin@example.com',
        password: 'correct-horse-battery',
        bootstrapToken: 'test-bootstrap-token',
      },
    });
    assert.equal(second.status, 409);
    assert.match(second.data.error, /already complete/i);
    assert.equal(adminCount(db), 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 1);
  });
}, { timeout: 30_000 });

test('admin provisioning promotes an existing account without invalidating its session', async () => {
  await withFreshApp(async ({ base, db }) => {
    const setupToken = await authorizeFirstAccount(base);
    const registered = await request(base, 'POST', '/api/auth/register', {
      body: { email: 'owner@example.com', password: 'correct-horse-battery', setupToken },
    });
    assert.equal(registered.status, 201);
    const sessionToken = registered.data.token;

    const before = await request(base, 'GET', '/api/auth/me', { token: sessionToken });
    assert.equal(before.data.user.isAdmin, false);

    const provisioned = await request(base, 'POST', '/api/auth/admin/provision', {
      body: { email: 'owner@example.com', bootstrapToken: 'test-bootstrap-token' },
    });
    assert.equal(provisioned.status, 200);
    assert.equal(provisioned.data.created, false);
    assert.equal(provisioned.data.user.isAdmin, true);
    assert.equal(provisioned.data.token, undefined, 'promotion does not mint a new session');

    const after = await request(base, 'GET', '/api/auth/me', { token: sessionToken });
    assert.equal(after.status, 200, 'the existing session remains valid');
    assert.equal(after.data.user.isAdmin, true, 'the role is read from the database');
    assert.equal(adminCount(db), 1);
  });
}, { timeout: 30_000 });

test('admin provisioning can promote a verified Google identity by googleSub', async () => {
  await withFreshApp(async ({ base, db }) => {
    db.prepare('INSERT INTO users (email, password_hash, is_admin, google_sub) VALUES (?, ?, 0, ?)')
      .run('google-owner@example.com', 'shadow-hash', 'google-sub-owner');

    const mismatch = await request(base, 'POST', '/api/auth/admin/provision', {
      body: { email: 'google-owner@example.com', googleSub: 'wrong-sub', bootstrapToken: 'test-bootstrap-token' },
    });
    assert.equal(mismatch.status, 409);
    assert.equal(adminCount(db), 0);

    const promoted = await request(base, 'POST', '/api/auth/admin/provision', {
      body: { googleSub: 'google-sub-owner', bootstrapToken: 'test-bootstrap-token' },
    });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.data.user.email, 'google-owner@example.com');
    assert.equal(promoted.data.user.isAdmin, true);
    assert.equal(adminCount(db), 1);
  });
}, { timeout: 30_000 });

test('admin provisioning rejects malformed identity and password requests', async () => {
  await withFreshApp(async ({ base, db }) => {
    const noIdentity = await request(base, 'POST', '/api/auth/admin/provision', {
      body: { bootstrapToken: 'test-bootstrap-token' },
    });
    assert.equal(noIdentity.status, 400);

    const newGoogleSub = await request(base, 'POST', '/api/auth/admin/provision', {
      body: { googleSub: 'not-signed-in-yet', bootstrapToken: 'test-bootstrap-token' },
    });
    assert.equal(newGoogleSub.status, 400);

    const weakPassword = await request(base, 'POST', '/api/auth/admin/provision', {
      body: { email: 'admin@example.com', password: 'short', bootstrapToken: 'test-bootstrap-token' },
    });
    assert.equal(weakPassword.status, 400);

    const clientRole = await request(base, 'POST', '/api/auth/admin/provision', {
      body: {
        email: 'admin@example.com',
        password: 'correct-horse-battery',
        bootstrapToken: 'test-bootstrap-token',
        isAdmin: false,
        is_admin: 0,
      },
    });
    assert.equal(clientRole.status, 201);
    assert.equal(clientRole.data.user.isAdmin, true, 'client fields cannot downgrade provisioning');
    assert.equal(adminCount(db), 1);
  });
}, { timeout: 30_000 });

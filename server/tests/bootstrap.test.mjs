// Bootstrap regression tests: while the users table is empty, the FIRST
// account may only be created with the server-side BOOTSTRAP_TOKEN. This stops
// an unknown public visitor from registering before the administrator, and it
// works even with ALLOW_REGISTRATION=false. After the first account exists,
// only ALLOW_REGISTRATION governs new accounts; existing accounts always log in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';

const servers = [];
let base;

async function request(method, pathname, { body } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, data };
}

before(async () => {
  const created = createApp({ provider: null });
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

// IMPORTANT: this file relies on execution order. The database is empty when
// the suite starts and the first successful registration is the bootstrap.
// ALLOW_REGISTRATION is pinned to false throughout tests 1-4 to prove the
// bootstrap path can never be locked out by that flag.
test('first account is refused while BOOTSTRAP_TOKEN is not configured', async () => {
  const originalToken = config.bootstrapToken;
  const originalAllow = config.allowRegistration;
  try {
    config.allowRegistration = false;
    config.bootstrapToken = ''; // deployment without the variable set
    const res = await request('POST', '/api/auth/register', {
      body: { email: 'nobody@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /bootstrap token/i);
  } finally {
    config.bootstrapToken = originalToken;
    config.allowRegistration = originalAllow;
  }
});

test('first account is refused without the token, and with a wrong token', async () => {
  const originalAllow = config.allowRegistration;
  try {
    config.allowRegistration = false;
    const missing = await request('POST', '/api/auth/register', {
      body: { email: 'nobody@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(missing.status, 403);
    assert.match(missing.data.error, /bootstrap token/i);

    const wrong = await request('POST', '/api/auth/register', {
      body: { email: 'nobody@example.com', password: 'correct-horse-battery', bootstrapToken: 'not-the-token' },
    });
    assert.equal(wrong.status, 403);
    assert.match(wrong.data.error, /bootstrap token/i);
  } finally {
    config.allowRegistration = originalAllow;
  }
});

test('first account is created with the correct token', async () => {
  const originalAllow = config.allowRegistration;
  try {
    config.allowRegistration = false; // flag must not lock out initial creation
    const res = await request('POST', '/api/auth/register', {
      body: { email: 'admin@example.com', password: 'correct-horse-battery', bootstrapToken: 'test-bootstrap-token' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.ok(res.data.token, 'first account receives a session token');
  } finally {
    config.allowRegistration = originalAllow;
  }
});

test('after bootstrap, ALLOW_REGISTRATION=false refuses new accounts; the first account still logs in', async () => {
  const original = config.allowRegistration;
  try {
    config.allowRegistration = false;
    const refused = await request('POST', '/api/auth/register', {
      body: { email: 'second@example.com', password: 'correct-horse-battery', bootstrapToken: 'test-bootstrap-token' },
    });
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /disabled/i);

    const login = await request('POST', '/api/auth/login', {
      body: { email: 'admin@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200, 'existing account logs in while registration is disabled');
    assert.ok(login.data.token);
  } finally {
    config.allowRegistration = original;
  }
});

test('after bootstrap, registration ignores the token and follows ALLOW_REGISTRATION', async () => {
  const original = config.allowRegistration;
  try {
    config.allowRegistration = true;
    const res = await request('POST', '/api/auth/register', {
      body: { email: 'second@example.com', password: 'correct-horse-battery' },
    });
    assert.equal(res.status, 201, 'later accounts do not need the bootstrap token');
  } finally {
    config.allowRegistration = original;
  }
}, { timeout: 30_000 });

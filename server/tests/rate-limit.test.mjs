// F4 regression tests: the login/register rate limiter must not global-lock
// every client sharing a reverse proxy (Render, Vercel). The client IP is
// derived from at most TRUST_PROXY / `trustProxy` X-Forwarded-For hops, so
// spoofed leading XFF entries are ignored; login attempts are keyed per
// (IP, email) with a per-IP backstop against password spraying. A 429 always
// carries a Retry-After header and a retryAfterSeconds body field.
//
// Also verifies that registration can be closed after accounts exist while
// existing accounts can still log in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { authorizeFirstAccount } from './setup-authorization.mjs';

const servers = [];
let base;

async function request(method, pathname, { body, xff } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (xff) headers['x-forwarded-for'] = xff;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
}

const reg = async (email, xff) => {
  const setupToken = await authorizeFirstAccount(base);
  return request('POST', '/api/auth/register', {
    xff,
    body: { email, password: 'correct-horse-battery', setupToken },
  });
};
const badLogin = (email, xff) => request('POST', '/api/auth/login', {
  xff,
  body: { email, password: 'definitely-wrong-password' },
});

before(async () => {
  const created = createApp({ provider: null, trustProxy: 1 });
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

test('login brute force locks the attacker out of that account only, with Retry-After', async () => {
  const email = `brute-${Date.now()}@example.com`;
  const xff = '203.0.113.10';
  const created = await reg(email, xff);
  assert.equal(created.status, 201, JSON.stringify(created.data));

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const res = await badLogin(email, xff);
    assert.equal(res.status, 401, `attempt ${attempt}`);
  }
  const blocked = await badLogin(email, xff);
  assert.equal(blocked.status, 429, '11th wrong password from the same client is rate limited');
  assert.ok(blocked.retryAfter, '429 carries a Retry-After header');
  const retryAfter = Number(blocked.retryAfter);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After is whole seconds >= 1, got ${blocked.retryAfter}`);
  assert.ok(Number.isInteger(blocked.data.retryAfterSeconds) && blocked.data.retryAfterSeconds >= 1,
    'body exposes retryAfterSeconds');
});

test('a different account on the same proxy IP is not locked out by the brute force above', async () => {
  const xff = '203.0.113.10';
  const victim = `victim-${Date.now()}@example.com`;
  const bystander = `bystander-${Date.now()}@example.com`;
  assert.equal((await reg(victim, xff)).status, 201);
  assert.equal((await reg(bystander, xff)).status, 201);

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    assert.equal((await badLogin(victim, xff)).status, 401);
  }
  assert.equal((await badLogin(victim, xff)).status, 429, 'victim account is locked');

  // Bystander on the same proxy IP: targeted limiter is per (IP, email).
  const res = await badLogin(bystander, xff);
  assert.equal(res.status, 401, 'bystander is not 429-blocked');

  // Same account, different source IP: also clean.
  const elsewhere = await badLogin(victim, '203.0.113.11');
  assert.equal(elsewhere.status, 401, 'same account from another IP is not 429-blocked');
});

test('spoofed X-Forwarded-For prefix does not defeat the limiter when one hop is trusted', async () => {
  const email = `xff-${Date.now()}@example.com`;
  const realHop = '203.0.113.77';
  assert.equal((await reg(email, `10.9.9.9, ${realHop}`)).status, 201);

  // Attacker tries to launder their source IP through a spoofed prefix.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    assert.equal((await badLogin(email, `10.${attempt}.${attempt}.${attempt}, ${realHop}`)).status, 401);
  }
  const blocked = await badLogin(email, `10.11.11.11, ${realHop}`);
  assert.equal(blocked.status, 429, 'the trusted hop (rightmost) is what counts');
});

test('registration limiter returns 429 with Retry-After and does not affect other IPs', async () => {
  const xff = '203.0.113.30';
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const res = await request('POST', '/api/auth/register', { xff, body: { email: 'not-an-email', password: 'x'.repeat(9) } });
    assert.equal(res.status, 400, `attempt ${attempt}`);
  }
  const blocked = await request('POST', '/api/auth/register', { xff, body: { email: 'not-an-email', password: 'x'.repeat(9) } });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.retryAfter && Number(blocked.retryAfter) >= 1, 'registration 429 carries Retry-After');

  // Another IP can still register.
  const other = await request('POST', '/api/auth/register', {
    xff: '203.0.113.31',
    body: { email: `elsewhere-${Date.now()}@example.com`, password: 'correct-horse-battery' },
  });
  assert.equal(other.status, 201, JSON.stringify(other.data));
});

test('per-IP backstop caps password spraying across many accounts', async () => {
  const xff = '203.0.113.40';
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const res = await badLogin(`spray-${attempt}-${Date.now()}@example.com`, xff);
    assert.equal(res.status, 401, `attempt ${attempt}`);
  }
  const blocked = await badLogin(`spray-extra-${Date.now()}@example.com`, xff);
  assert.equal(blocked.status, 429, 'spray across accounts from one IP is capped at 50/window');
  assert.ok(blocked.retryAfter && Number(blocked.retryAfter) >= 1, 'backstop 429 carries Retry-After');
}, { timeout: 60000 });

test('registration can be disabled after accounts exist and existing accounts can still log in', async () => {
  const email = `bootstrap-${Date.now()}@example.com`;
  const xff = '203.0.113.50';
  const created = await reg(email, xff);
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const original = config.allowRegistration;
  try {
    config.allowRegistration = false; // what ALLOW_REGISTRATION=false achieves in production

    const refused = await reg(`blocked-${Date.now()}@example.com`, xff);
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /closed|not being accepted|contact your administrator/i);

    const login = await request('POST', '/api/auth/login', {
      xff,
      body: { email, password: 'correct-horse-battery' },
    });
    assert.equal(login.status, 200, 'existing accounts can log in while registration is disabled');
    assert.ok(login.data.token, 'login issues a token');

    const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${login.data.token}` } });
    assert.equal(me.status, 200, 'token resolves while registration is disabled');
  } finally {
    config.allowRegistration = original;
  }
});

// Regression coverage for the "chat redirects me to the login screen" bug.
//
// The chat endpoint relays an upstream AI provider 401 when the provider's own
// API key is rejected. The web client must treat that as a chat error, not as
// an expired user session. Real session failures are tagged AUTH_REQUIRED.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/index.js';
import { createOpenAIProvider } from '../src/ai/openai.js';
import { AUTH_REQUIRED_CODE, isSessionExpiredResponse } from '../../apps/web/src/authResponse.js';

let server;
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
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

before(async () => {
  const failingProvider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async () => Response.json(
      { error: { code: 'invalid_api_key', message: 'private upstream detail' } },
      { status: 401 },
    ),
  });
  const created = createApp({ provider: failingProvider, providerName: 'openai' });
  server = created.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('session 401s are tagged AUTH_REQUIRED', async () => {
  const projects = await request('GET', '/api/projects');
  assert.equal(projects.status, 401);
  assert.equal(projects.data.code, AUTH_REQUIRED_CODE);

  const me = await request('GET', '/api/auth/me');
  assert.equal(me.status, 401);
  assert.equal(me.data.code, AUTH_REQUIRED_CODE);
});

test('a provider 401 on /api/chat is not a session failure', async () => {
  const email = `redirect-${Date.now()}@example.com`;
  const registered = await request('POST', '/api/auth/register', {
    body: { email, password: 'correct-horse-battery' },
  });
  assert.equal(registered.status, 201, registered.data?.error);
  const { token } = registered.data;

  const chat = await request('POST', '/api/chat', { token, body: { message: 'hi' } });
  assert.equal(chat.status, 401);
  assert.equal(chat.data.ok, false);
  assert.equal(chat.data.code, undefined);
  assert.match(chat.data.error, /rejected the API key/);

  // The user's own session is still valid after the provider failure.
  const me = await request('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
});

test('client only signs out for real session 401s', () => {
  assert.equal(isSessionExpiredResponse({ status: 401, code: AUTH_REQUIRED_CODE, url: '/api/chat' }), true);
  assert.equal(isSessionExpiredResponse({ status: 401, code: null, url: '/api/chat' }), false);
  assert.equal(isSessionExpiredResponse({ status: 401, code: null, url: '/api/projects' }), true);
  assert.equal(isSessionExpiredResponse({ status: 401, code: null, url: 'http://localhost:5173/api/tasks?status=queued' }), true);
  assert.equal(isSessionExpiredResponse({ status: 403, code: AUTH_REQUIRED_CODE, url: '/api/projects' }), false);
  assert.equal(isSessionExpiredResponse({ status: 200, code: null, url: '/api/chat' }), false);
});

// Automated tests for POST /api/chat - no API key, no network, no extra deps.
// Usage: npm test  (runs: node --test tests/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { normalizeChatInput, MAX_MESSAGE_CHARS, MAX_MESSAGES } from '../src/routes/chat.js';

const servers = [];

async function startServer(app) {
  const server = app.listen(0);
  await once(server, 'listening');
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async post(path, body) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* non-JSON response */
      }
      return { status: res.status, data };
    },
  };
}

after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

// ---------------------------------------------------------------------------
// 1. Normal chat requests (mock provider, offline)
// ---------------------------------------------------------------------------
test('normal single message returns a mock reply', async () => {
  const api = await startServer(createApp().app);
  const { status, data } = await api.post('/api/chat', { message: 'Hello agent' });

  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.provider, 'mock');
  assert.equal(typeof data.reply, 'string');
  assert.ok(data.reply.length > 0);
  assert.match(data.reply, /Hello agent/);
});

test('messages array form is accepted', async () => {
  const api = await startServer(createApp().app);
  const { status, data } = await api.post('/api/chat', {
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Explain this error' },
      { role: 'assistant', content: 'Which error?' },
      { role: 'user', content: 'The one in my logs' },
    ],
  });

  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.reply.length > 0);
});

test('boundary: message of exactly MAX_MESSAGE_CHARS is accepted', async () => {
  const api = await startServer(createApp().app);
  const { status } = await api.post('/api/chat', { message: 'x'.repeat(MAX_MESSAGE_CHARS) });
  assert.equal(status, 200);
});

test('response never contains an API key', async () => {
  const savedKey = config.aiApiKey;
  config.aiApiKey = 'sk-test-SECRET-must-not-leak';
  try {
    const api = await startServer(createApp().app);
    const { data } = await api.post('/api/chat', { message: 'hi' });
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes('sk-test-SECRET-must-not-leak'));
    assert.ok(!('aiApiKey' in data));
    assert.ok(!('apiKey' in data));
  } finally {
    config.aiApiKey = savedKey;
  }
});

// ---------------------------------------------------------------------------
// 2. Invalid input -> 400 with a clear error
// ---------------------------------------------------------------------------
test('invalid inputs return 400 with clear errors', async () => {
  const api = await startServer(createApp().app);
  const longMessage = 'x'.repeat(MAX_MESSAGE_CHARS + 1);
  const tooMany = new Array(MAX_MESSAGES + 1).fill({ role: 'user', content: 'hi' });

  const cases = [
    [{}, 'missing both fields'],
    [{ message: 123 }, 'non-string message'],
    [{ message: '' }, 'empty message'],
    [{ message: '   ' }, 'whitespace-only message'],
    [{ message: longMessage }, 'message over the limit'],
    [{ messages: 'nope' }, 'messages not an array'],
    [{ messages: [] }, 'empty messages array'],
    [{ messages: tooMany }, 'too many messages'],
    [{ messages: [{ role: 'banana', content: 'hi' }] }, 'invalid role'],
    [{ messages: [{ role: 'user', content: 42 }] }, 'non-string content'],
    [{ messages: [{ role: 'user', content: '' }] }, 'empty content'],
    ['{not valid json', 'malformed JSON body'],
    [{ message: 'a', messages: [{ role: 'user', content: 'b' }] }, 'both fields at once'],
  ];

  for (const [body, label] of cases) {
    const { status, data } = await api.post('/api/chat', body);
    assert.equal(status, 400, `${label} should return 400`);
    assert.equal(data?.ok, false, `${label} should return ok:false`);
    assert.equal(typeof data?.error, 'string', `${label} should include an error message`);
    assert.ok(data.error.length > 0, `${label} error should not be empty`);
  }
});

test('validator unit checks mirror the HTTP behavior', () => {
  assert.equal(normalizeChatInput(undefined).ok, false);
  assert.equal(normalizeChatInput({ message: 'ok' }).ok, true);
  assert.equal(normalizeChatInput({ message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }).ok, false);
  assert.equal(normalizeChatInput({ messages: [] }).ok, false);
});

// ---------------------------------------------------------------------------
// 3. Provider problems -> 503 (unavailable) or 502 (failed), secrets redacted
// ---------------------------------------------------------------------------
test('unavailable provider returns 503 with a clear error', async () => {
  const api = await startServer(createApp({ provider: null, providerName: 'nonexistent' }).app);
  const { status, data } = await api.post('/api/chat', { message: 'hi' });

  assert.equal(status, 503);
  assert.equal(data.ok, false);
  assert.match(data.error, /nonexistent/);
});

test('provider failure returns 502 and redacts secrets from logs and response', async () => {
  const savedKey = config.aiApiKey;
  const secret = 'sk-test-SECRET-in-error-message';
  config.aiApiKey = secret;

  const failingProvider = {
    name: 'failing',
    model: 'none',
    chat: async () => {
      throw new Error(`Upstream rejected key ${secret}`);
    },
  };

  const logged = [];
  const savedConsoleError = console.error;
  console.error = (...args) => logged.push(args.join(' '));

  try {
    const api = await startServer(createApp({ provider: failingProvider }).app);
    const { status, data } = await api.post('/api/chat', { message: 'hi' });

    assert.equal(status, 502);
    assert.equal(data.ok, false);
    assert.ok(!JSON.stringify(data).includes(secret), 'response must not contain the secret');

    const logText = logged.join('\n');
    assert.ok(logText.includes('[redacted]'), 'log must show the redaction marker');
    assert.ok(!logText.includes(secret), 'log must not contain the secret');
  } finally {
    console.error = savedConsoleError;
    config.aiApiKey = savedKey;
  }
});

test('malformed provider result is treated as a provider error', async () => {
  const brokenProvider = { name: 'broken', model: 'none', chat: async () => ({}) };
  const api = await startServer(createApp({ provider: brokenProvider }).app);
  const { status, data } = await api.post('/api/chat', { message: 'hi' });

  assert.equal(status, 502);
  assert.equal(data.ok, false);
});

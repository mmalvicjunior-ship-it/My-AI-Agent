// Automated tests for POST /api/chat - no API key, no network, no extra deps.
// Usage: npm test  (runs: node --test tests/)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { mockProvider } from '../src/ai/mock.js';
import { createOpenAIProvider } from '../src/ai/openai.js';
import { createGeminiProvider } from '../src/ai/gemini.js';
import { createFallbackProvider } from '../src/ai/fallback.js';
import {
  normalizeChatInput,
  normalizeChatProvider,
  CHAT_PROVIDER_IDS,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES,
} from '../src/routes/chat.js';

const servers = [];

async function startServer(app) {
  const server = app.listen(0);
  await once(server, 'listening');
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async get(path) {
      const res = await fetch(base + path);
      return { status: res.status, data: await res.json() };
    },
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
  const api = await startServer(createApp({ auth: false, provider: mockProvider }).app);
  const { status, data } = await api.post('/api/chat', { message: 'hie' });

  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.provider, 'mock');
  assert.equal(typeof data.reply, 'string');
  assert.ok(data.reply.length > 0);
  assert.match(data.reply, /Hello! How can I help you today/);
});

test('messages array form is accepted', async () => {
  const api = await startServer(createApp({ auth: false, provider: mockProvider }).app);
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
  const api = await startServer(createApp({ auth: false, provider: mockProvider }).app);
  const { status } = await api.post('/api/chat', { message: 'x'.repeat(MAX_MESSAGE_CHARS) });
  assert.equal(status, 200);
});

test('response never contains an API key', async () => {
  const savedKey = config.aiApiKey;
  config.aiApiKey = 'sk-test-SECRET-must-not-leak';
  try {
    const api = await startServer(createApp({ auth: false, provider: mockProvider }).app);
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
  const api = await startServer(createApp({ auth: false }).app);
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
  assert.deepEqual(
    normalizeChatInput({ message: '  exact prompt  ' }).messages,
    [{ role: 'user', content: '  exact prompt  ' }],
  );
  assert.equal(normalizeChatInput({ message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }).ok, false);
  assert.equal(normalizeChatInput({ messages: [] }).ok, false);
});

test('chat only offers workspace tools for a project that actually exists', async () => {
  const { app, tools } = createApp({ auth: false, provider: mockProvider });
  const api = await startServer(app);
  const created = await api.post('/api/projects', { name: 'Chat Tools Test' });
  const projectId = created.data.project.id;

  const seen = [];
  const spyProvider = {
    name: 'spy',
    model: 'spy-1',
    async chat({ tools: offeredTools, projectId: offeredProjectId }) {
      seen.push({ hasTools: Boolean(offeredTools), projectId: offeredProjectId });
      return { text: 'ok', provider: 'spy', model: 'spy-1' };
    },
  };
  const spyApi = await startServer(createApp({ auth: false, provider: spyProvider, tools }).app);

  const withProject = await spyApi.post('/api/chat', { message: 'hi', projectId });
  assert.equal(withProject.status, 200);
  assert.deepEqual(seen.at(-1), { hasTools: true, projectId }, 'an existing project arms the tools');

  const withoutProject = await spyApi.post('/api/chat', { message: 'hi' });
  assert.equal(withoutProject.status, 200);
  assert.deepEqual(seen.at(-1), { hasTools: false, projectId: null }, 'no project means no tools');

  const missingProject = await spyApi.post('/api/chat', { message: 'hi', projectId: 99999999 });
  assert.equal(missingProject.status, 200);
  assert.deepEqual(seen.at(-1), { hasTools: false, projectId: null }, 'a missing project must not arm the tools');

  for (const badId of [0, -3, 2.5, 'abc']) {
    const { status, data } = await spyApi.post('/api/chat', { message: 'hi', projectId: badId });
    assert.equal(status, 400, `projectId ${badId} must be rejected`);
    assert.match(data.error, /valid workspace/);
  }
});

test('chat debug logs identify provider without exposing prompt by default', async () => {
  const savedDebugSetting = config.debugChatPrompts;
  const logged = [];
  const savedConsoleLog = console.log;
  config.debugChatPrompts = false;
  console.log = (...args) => logged.push(args.join(' '));

  try {
    const api = await startServer(createApp({ auth: false, provider: mockProvider }).app);
    const message = 'private prompt text';
    const { status } = await api.post('/api/chat', { message });
    const output = logged.join('\n');

    assert.equal(status, 200);
    assert.match(output, /\[chat\] Active provider: mock/);
    assert.match(output, /\[hidden; 19 characters\]/);
    assert.ok(!output.includes(message));
  } finally {
    console.log = savedConsoleLog;
    config.debugChatPrompts = savedDebugSetting;
  }
});

test('OpenAI request preserves the exact prompt and full conversation history', async () => {
  let upstreamMessages;
  let upstreamTemperature;
  const history = [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
  ];
  const exactPrompt = '  follow these exact instructions  ';
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      upstreamMessages = body.messages;
      upstreamTemperature = body.temperature;
      return Response.json({
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'Instructions followed.' } }],
      });
    },
  });
  const api = await startServer(createApp({ auth: false, provider }).app);
  const { status, data } = await api.post('/api/chat', {
    messages: [...history, { role: 'user', content: exactPrompt }],
  });

  assert.equal(status, 200);
  assert.equal(data.reply, 'Instructions followed.');
  assert.deepEqual(upstreamMessages.slice(1), [
    ...history,
    { role: 'user', content: exactPrompt },
  ]);
  assert.equal(upstreamTemperature, 0.7);
});

test('chat switches providers per request without replacing the startup provider', async () => {
  const calls = [];
  const startupProvider = {
    name: 'openai',
    model: 'startup-model',
    async chat() {
      calls.push('startup');
      return { text: 'OpenRouter reply', provider: 'openai', model: 'startup-model' };
    },
  };
  const geminiProvider = {
    name: 'gemini',
    model: 'gemini-model',
    async chat() {
      calls.push('gemini');
      return { text: 'Gemini reply', provider: 'gemini', model: 'gemini-model' };
    },
  };
  const api = await startServer(createApp({ auth: false, provider: startupProvider,
    providerName: 'openai',
    providerResolver: (name) => (name === 'gemini' ? geminiProvider : startupProvider),
  }).app);

  const defaultRequest = await api.post('/api/chat', { message: 'hi' });
  assert.equal(defaultRequest.status, 200);
  assert.equal(defaultRequest.data.provider, 'openai');
  assert.equal(defaultRequest.data.reply, 'OpenRouter reply');

  const geminiRequest = await api.post('/api/chat', { message: 'hi', provider: 'gemini' });
  assert.equal(geminiRequest.status, 200);
  assert.equal(geminiRequest.data.provider, 'gemini');
  assert.equal(geminiRequest.data.reply, 'Gemini reply');
  assert.deepEqual(calls, ['startup', 'gemini']);
});

test('chat rejects unknown providers instead of silently using the startup provider', async () => {
  let called = false;
  const startupProvider = {
    name: 'mock',
    model: 'mock',
    async chat() {
      called = true;
      return { text: 'should not run', provider: 'mock', model: 'mock' };
    },
  };
  const api = await startServer(createApp({ auth: false, provider: startupProvider }).app);

  for (const provider of ['anthropic', 'OPENAI?', '', 123, {}]) {
    const { status, data } = await api.post('/api/chat', { message: 'hi', provider });
    assert.equal(status, 400, `provider ${JSON.stringify(provider)} must be rejected`);
    assert.equal(data.ok, false);
    assert.match(data.error, /provider/i);
  }
  assert.equal(called, false);
});

test('provider override validator only accepts the two switchable providers', () => {
  assert.deepEqual(CHAT_PROVIDER_IDS, ['openai', 'gemini']);
  assert.deepEqual(normalizeChatProvider(undefined), { ok: true, provider: null });
  assert.deepEqual(normalizeChatProvider('openai'), { ok: true, provider: 'openai' });
  assert.deepEqual(normalizeChatProvider(' Gemini '), { ok: true, provider: 'gemini' });
  assert.equal(normalizeChatProvider('mock').ok, false);
  assert.equal(normalizeChatProvider('').ok, false);
  assert.equal(normalizeChatProvider(42).ok, false);
});

test('health reports Gemini key status without exposing either key', async () => {
  const savedGeminiKey = config.geminiApiKey;
  const savedAiKey = config.aiApiKey;
  config.geminiApiKey = '';
  config.aiApiKey = 'sk-openrouter-secret-present';

  try {
    const provider = createGeminiProvider({ apiKey: '' });
    const api = await startServer(createApp({ auth: false, provider, providerName: 'gemini' }).app);
    const { status, data } = await api.get('/api/health');

    assert.equal(status, 200);
    assert.equal(data.aiProvider, 'gemini');
    assert.equal(data.providerLabel, 'Google Gemini');
    assert.equal(data.aiConfigured, false);
    assert.match(data.aiWarning, /GEMINI_API_KEY is missing/);
    assert.equal(data.providers.gemini.configured, false);
    assert.equal(data.providers.openai.configured, true);

    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes('sk-openrouter-secret-present'));
    assert.ok(!serialized.includes('apiKey'));
  } finally {
    config.geminiApiKey = savedGeminiKey;
    config.aiApiKey = savedAiKey;
  }
});

test('health exposes only safe per-provider labels and configured flags', async () => {
  const savedGeminiKey = config.geminiApiKey;
  const savedAiKey = config.aiApiKey;
  config.geminiApiKey = 'AIzaSyGeminiHealthSecret1234567890';
  config.aiApiKey = 'sk-openrouter-health-secret';

  try {
    const provider = createOpenAIProvider({
      apiKey: config.aiApiKey,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const api = await startServer(createApp({ auth: false, provider, providerName: 'openai' }).app);
    const { status, data } = await api.get('/api/health');

    assert.equal(status, 200);
    assert.equal(data.providers.openai.label, 'OpenRouter');
    assert.equal(data.providers.openai.configured, true);
    assert.equal(data.providers.gemini.label, 'Google Gemini');
    assert.equal(data.providers.gemini.configured, true);

    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes(config.aiApiKey));
    assert.ok(!serialized.includes(config.geminiApiKey));
    assert.ok(!serialized.includes('apiKey'));
  } finally {
    config.geminiApiKey = savedGeminiKey;
    config.aiApiKey = savedAiKey;
  }
});

// ---------------------------------------------------------------------------
// 3. Provider problems -> 503 (unavailable) or 502 (failed), secrets redacted
// ---------------------------------------------------------------------------
test('unavailable provider returns 503 with a clear error', async () => {
  const api = await startServer(createApp({ auth: false, provider: null, providerName: 'nonexistent' }).app);
  const { status, data } = await api.post('/api/chat', { message: 'hi' });

  assert.equal(status, 503);
  assert.equal(data.ok, false);
  assert.match(data.error, /nonexistent/);
});

test('health reports when OpenAI is selected without an API key', async () => {
  const savedKey = config.aiApiKey;
  config.aiApiKey = '';
  try {
    const provider = createOpenAIProvider({ apiKey: '' });
    const api = await startServer(createApp({ auth: false, provider, providerName: 'openai' }).app);
    const { status, data } = await api.get('/api/health');

    assert.equal(status, 200);
    assert.equal(data.aiProvider, 'openai');
    assert.equal(data.aiConfigured, false);
    assert.match(data.aiWarning, /AI_API_KEY is missing/);
    assert.ok(!JSON.stringify(data).includes('apiKey'));
  } finally {
    config.aiApiKey = savedKey;
  }
});

test('health names the real service behind an OpenAI-compatible base URL', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  const api = await startServer(createApp({ auth: false, provider, providerName: 'openai' }).app);
  const { status, data } = await api.get('/api/health');

  assert.equal(status, 200);
  assert.equal(data.aiProvider, 'openai');
  assert.equal(data.providerLabel, 'OpenRouter');
  assert.ok(!JSON.stringify(data).includes('test-key'));
});

test('OpenAI missing key returns a clear configuration error without mock fallback', async () => {
  const provider = createOpenAIProvider({ apiKey: '' });
  const api = await startServer(createApp({ auth: false, provider, providerName: 'openai' }).app);
  const { status, data } = await api.post('/api/chat', { message: 'hi' });

  assert.equal(status, 503);
  assert.equal(data.ok, false);
  assert.match(data.error, /AI_API_KEY/);
});

test('OpenAI authentication and quota errors reach the user safely', async (t) => {
  for (const [statusCode, code, expected] of [
    [401, 'invalid_api_key', /rejected the API key/],
    [429, 'insufficient_quota', /no available API quota/],
  ]) {
    await t.test(`${statusCode} ${code}`, async () => {
      const provider = createOpenAIProvider({
        apiKey: 'test-key',
        fetchImpl: async () => Response.json(
          { error: { code, message: 'private upstream detail' } },
          { status: statusCode },
        ),
      });
      const api = await startServer(createApp({ auth: false, provider, providerName: 'openai' }).app);
      const { status, data } = await api.post('/api/chat', { message: 'hi' });

      assert.equal(status, statusCode);
      assert.equal(data.ok, false);
      assert.match(data.error, expected);
      assert.ok(data.error.includes('private upstream detail'));
      assert.ok(!JSON.stringify(data).includes('test-key'));
    });
  }
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
    const api = await startServer(createApp({ auth: false, provider: failingProvider }).app);
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
  const api = await startServer(createApp({ auth: false, provider: brokenProvider }).app);
  const { status, data } = await api.post('/api/chat', { message: 'hi' });

  assert.equal(status, 502);
  assert.equal(data.ok, false);
});

test('chat reports the actual provider/model when Gemini falls back to OpenRouter', async () => {
  const primary = {
    name: 'gemini',
    model: 'gemini-3.8-flash',
    async chat() {
      const error = new Error('Gemini daily quota is exhausted.');
      error.statusCode = 429;
      error.category = 'QUOTA_EXHAUSTED';
      error.errorType = 'QUOTA_EXHAUSTED';
      error.fallbackEligible = true;
      error.publicMessage = 'Google Gemini daily quota is exhausted.';
      throw error;
    },
  };
  const fallback = {
    name: 'openai',
    model: 'particle-ai/particle-1:free',
    async chat() {
      return {
        text: 'OpenRouter reply.',
        provider: 'openai',
        model: 'particle-ai/particle-1:free',
      };
    },
  };
  const provider = createFallbackProvider({ primary, fallback, log: { warn() {} } });
  const api = await startServer(createApp({
    auth: false,
    provider,
    providerName: 'gemini',
  }).app);

  const { status, data } = await api.post('/api/chat', { message: 'hi', provider: 'gemini' });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.provider, 'openai');
  assert.equal(data.model, 'particle-ai/particle-1:free');
  assert.equal(data.reply, 'OpenRouter reply.');
  assert.deepEqual(data.fallback, {
    from: 'gemini',
    fromModel: 'gemini-3.8-flash',
    reason: 'QUOTA_EXHAUSTED',
    retryAfterMs: null,
  });
});

test('chat exposes quota error category and Retry-After without exposing secrets', async () => {
  const secret = 'sk-test-secret-should-never-appear';
  const provider = {
    name: 'gemini',
    model: 'gemini-3.8-flash',
    async chat() {
      const error = new Error(`Gemini quota failed with ${secret}`);
      error.statusCode = 429;
      error.category = 'QUOTA_EXHAUSTED';
      error.errorType = 'QUOTA_EXHAUSTED';
      error.retryable = false;
      error.fallbackEligible = false;
      error.retryAfterMs = 3_600_000;
      error.publicMessage = 'Google Gemini daily quota is exhausted. No further Gemini requests will be made.';
      throw error;
    },
  };
  const api = await startServer(createApp({ auth: false, provider, providerName: 'gemini' }).app);

  const { status, data } = await api.post('/api/chat', { message: 'hi', provider: 'gemini' });
  assert.equal(status, 429);
  assert.equal(data.errorCategory, 'QUOTA_EXHAUSTED');
  assert.equal(data.retryAfterSeconds, 3600);
  assert.match(data.error, /daily quota is exhausted/i);
  assert.ok(!JSON.stringify(data).includes(secret));
});

test('health exposes explicit fallback configuration without exposing keys', async () => {
  const savedFallback = config.aiFallbackProvider;
  const savedAiKey = config.aiApiKey;
  config.aiFallbackProvider = 'openai';
  config.aiApiKey = 'sk-openrouter-health-fallback-secret';

  try {
    const provider = createGeminiProvider({ apiKey: 'gemini-test-key' });
    const api = await startServer(createApp({ auth: false, provider, providerName: 'gemini' }).app);
    const { status, data } = await api.get('/api/health');

    assert.equal(status, 200);
    assert.equal(data.fallbackProvider, 'openai');
    assert.equal(data.fallbackConfigured, true);
    assert.ok(!JSON.stringify(data).includes(config.aiApiKey));
    assert.ok(!JSON.stringify(data).includes('gemini-test-key'));
  } finally {
    config.aiFallbackProvider = savedFallback;
    config.aiApiKey = savedAiKey;
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mockProvider } from '../src/ai/mock.js';
import { createGeminiProvider } from '../src/ai/gemini.js';
import { createHuggingFaceProvider } from '../src/ai/huggingface.js';
import { createOpenAIProvider } from '../src/ai/openai.js';
import { createOllamaProvider } from '../src/ai/ollama.js';
import { getProvider, listProviders } from '../src/ai/index.js';
import { createChatRouter } from '../src/routes/chat.js';

test('offline provider responds naturally to a greeting', async () => {
  const result = await mockProvider.chat({
    messages: [{ role: 'user', content: 'hie' }],
  });

  assert.equal(result.text, 'Hello! How can I help you today?');
  assert.equal(result.provider, 'mock');
});

test('offline provider handles project follow-ups without repeating offline notices', async () => {
  const result = await mockProvider.chat({
    messages: [
      { role: 'user', content: 'I am building an app.' },
      { role: 'assistant', content: 'What kind of app?' },
      { role: 'user', content: 'lets work on project' },
    ],
  });

  assert.match(result.text, /Absolutely/);
  assert.match(result.text, /what are you building/i);
  assert.doesNotMatch(result.text, /offline mode|following along with our conversation/i);
});

test('offline provider handles polite affirmation', async () => {
  const result = await mockProvider.chat({
    messages: [{ role: 'user', content: 'ok you are fine' }],
  });

  assert.match(result.text, /Glad we’re good/);
});

test('offline provider answers basic arithmetic', async () => {
  const result = await mockProvider.chat({
    messages: [{ role: 'user', content: 'what is 2 plus 2?' }],
  });

  assert.equal(result.text, '2 plus 2 = 4.');
});

test('offline provider gives a practical tip', async () => {
  const result = await mockProvider.chat({
    messages: [{ role: 'user', content: 'Give me a coding tip.' }],
  });

  assert.match(result.text, /one small end-to-end path/i);
});

test('provider selection never falls back silently for a real provider without a key', () => {
  const settings = { aiApiKey: '', aiModel: '' };
  assert.equal(getProvider('gemini', settings).name, 'gemini');
  assert.equal(getProvider('openai', settings).name, 'openai');
  assert.equal(getProvider('huggingface', settings).name, 'huggingface');
  assert.equal(getProvider('ollama', settings).name, 'ollama');
  assert.equal(getProvider('unsupported', settings), null);
  assert.deepEqual(listProviders(), ['mock', 'openai', 'gemini', 'huggingface', 'ollama']);
});

test('provider selection uses configured API key and model', () => {
  const settings = { aiApiKey: 'test-key', aiModel: 'custom-model' };

  assert.deepEqual(
    { ...getProvider('gemini', settings), chat: undefined },
    { name: 'gemini', model: 'custom-model', chat: undefined },
  );
  assert.deepEqual(
    { ...getProvider('openai', settings), chat: undefined },
    { name: 'openai', model: 'custom-model', chat: undefined },
  );
  assert.deepEqual(
    { ...getProvider('huggingface', settings), chat: undefined },
    { name: 'huggingface', model: 'custom-model', chat: undefined },
  );
  assert.deepEqual(
    { ...getProvider('ollama', settings), chat: undefined },
    { name: 'ollama', model: 'custom-model', chat: undefined },
  );
});

test('OpenAI provider clearly rejects missing API key instead of falling back', async () => {
  const provider = getProvider('openai', { aiApiKey: '', aiModel: '' });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.match(error.publicMessage, /AI_API_KEY/);
      return true;
    },
  );
});

test('Gemini provider clearly rejects missing API key instead of falling back', async () => {
  const provider = getProvider('gemini', { aiApiKey: '', aiModel: '' });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.match(error.publicMessage, /Google AI API key/);
      return true;
    },
  );
});

test('OpenAI adapter forwards history, model, and API key', async () => {
  let request;
  const provider = createOpenAIProvider({
    apiKey: 'test-openai-key',
    model: 'test-model',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        model: 'test-model-response',
        choices: [{ message: { content: 'Hello from OpenAI.' } }],
      });
    },
  });
  const messages = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'Can you help?' },
  ];

  const result = await provider.chat({ messages });

  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-openai-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'test-model',
    messages: [
      {
        role: 'system',
        content: "You are a helpful, capable AI assistant. Always follow the user's instructions carefully and answer their requests directly.",
      },
      ...messages,
    ],
    temperature: 0.7,
  });
  assert.equal(result.text, 'Hello from OpenAI.');
  assert.equal(result.model, 'test-model-response');
});

test('Gemini adapter maps assistant turns and forwards system instructions', async () => {
  let request;
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    model: 'test-model',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'from Gemini.' }] } }],
      });
    },
  });
  const messages = [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'Can you help?' },
  ];

  const result = await provider.chat({ messages });
  const body = JSON.parse(request.options.body);

  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
  assert.equal(request.options.headers['x-goog-api-key'], 'test-gemini-key');
  assert.deepEqual(body.systemInstruction, {
    parts: [
      { text: "You are a helpful coding assistant. Follow the user's instructions directly. When a project workspace is selected, inspect relevant files with tools before proposing changes, use create_file for new files and propose_file_change for edits to existing files. All file changes and commands require explicit user approval; use only the provided safe command tools. Never claim a tool succeeded unless its result confirms success." },
      { text: 'Be concise.' },
    ],
  });
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'Hi' }] },
    { role: 'model', parts: [{ text: 'Hello!' }] },
    { role: 'user', parts: [{ text: 'Can you help?' }] },
  ]);
  assert.equal(result.text, 'Hello from Gemini.');
});

test('Gemini adapter runs function calls and returns approval proposals', async () => {
  const requests = [];
  const executed = [];
  const tools = {
    declarations: [{ functionDeclarations: [{ name: 'create_file' }] }],
    execute: async (name, args) => {
      executed.push({ name, args });
      return { proposalId: 'proposal-1', path: 'src/new.js', status: 'awaiting_user_approval' };
    },
  };
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    model: 'test-model',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                functionCall: {
                  name: 'create_file',
                  args: { path: 'src/new.js', content: 'export const value = 1;' },
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'I staged the new file for your review.' }] } }],
      });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Create a new JS file.' }],
    tools,
    projectId: 42,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools[0].functionDeclarations[0].name, 'create_file');
  assert.deepEqual(executed, [{
    name: 'create_file',
    args: { path: 'src/new.js', content: 'export const value = 1;', projectId: 42 },
  }]);
  assert.equal(requests[1].contents[2].parts[0].functionResponse.name, 'create_file');
  assert.equal(result.text, 'I staged the new file for your review.');
  assert.equal(result.toolActivity[0].proposal.content, 'export const value = 1;');
});

test('Ollama adapter sends chat history to its local API', async () => {
  let request;
  const provider = createOllamaProvider({
    model: 'llama3',
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({ model: 'llama3', message: { content: 'Hello from Ollama.' } });
    },
  });
  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }],
  });

  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(request.body.stream, false);
  assert.deepEqual(request.body.messages, [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' },
  ]);
  assert.equal(result.text, 'Hello from Ollama.');
});

test('Gemini adapter returns sanitized upstream HTTP errors', async () => {
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-secret',
    model: 'gemini-1.5-flash',
    fetchImpl: async () => Response.json({
      error: { message: 'API key not valid: test-gemini-secret', status: 'UNAUTHENTICATED' },
    }, { status: 400 }),
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.publicMessage, /rejected/);
      assert.ok(!error.publicMessage.includes('test-gemini-secret'));
      return true;
    },
  );
});

test('Hugging Face adapter sends OpenAI-compatible chat completion requests', async () => {
  let request;
  const provider = createHuggingFaceProvider({
    apiKey: 'test-hf-key',
    model: 'meta-llama/Meta-Llama-3-8B-Instruct',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        model: 'hf-selected-model',
        choices: [{ message: { content: 'Hello from Hugging Face.' } }],
      });
    },
  });
  const messages = [
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'Can you help?' },
  ];

  const result = await provider.chat({ messages });

  assert.equal(request.url, 'https://router.huggingface.co/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-hf-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'meta-llama/Meta-Llama-3-8B-Instruct',
    messages: [
      {
        role: 'system',
        content: "You are a helpful, capable AI assistant. Always follow the user's instructions carefully and answer their requests directly.",
      },
      ...messages,
    ],
    temperature: 0.7,
  });
  assert.equal(result.text, 'Hello from Hugging Face.');
  assert.equal(result.provider, 'huggingface');
  assert.equal(result.model, 'hf-selected-model');
});

test('Hugging Face adapter returns sanitized upstream HTTP errors', async () => {
  const provider = createHuggingFaceProvider({
    apiKey: 'hf-test-secret',
    fetchImpl: async () => Response.json({
      error: { message: 'Invalid model or token hf-test-secret', code: 'invalid_request' },
    }, { status: 401 }),
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.match(error.publicMessage, /Invalid model or token \[redacted\]/);
      assert.ok(!error.publicMessage.includes('hf-test-secret'));
      return true;
    },
  );
});

test('provider adapters report upstream status without exposing response body', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async () => new Response('secret upstream detail', { status: 401 }),
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.message, 'OpenAI request failed with status 401.');
      assert.ok(!error.message.includes('secret upstream detail'));
      return true;
    },
  );
});

test('OpenAI errors redact masked API-key fragments returned by upstream', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'sk-project-test-secret',
    fetchImpl: async () => Response.json({
      error: {
        message: 'Incorrect API key provided: key_8MF9********yrx5.',
        code: 'invalid_api_key',
      },
    }, { status: 401 }),
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.match(error.publicMessage, /\[redacted credential\]/);
      assert.ok(!error.publicMessage.includes('key_8MF9'));
      return true;
    },
  );
});

test('OpenAI adapter gives clear authentication and quota errors', async (t) => {
  for (const [status, code, expected] of [
    [401, 'invalid_api_key', /rejected the API key/],
    [429, 'insufficient_quota', /no available API quota/],
    [429, 'rate_limit_exceeded', /rate limit/],
  ]) {
    await t.test(`${status} ${code}`, async () => {
      const provider = createOpenAIProvider({
        apiKey: 'test-key',
        fetchImpl: async () => Response.json(
          { error: { code, message: 'private upstream detail' } },
          { status },
        ),
      });

      await assert.rejects(
        provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
        (error) => {
          assert.equal(error.statusCode, status);
          assert.match(error.publicMessage, expected);
          assert.ok(error.publicMessage.includes('private upstream detail'));
          assert.ok(!error.publicMessage.includes('test-key'));
          return true;
        },
      );
    });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mockProvider } from '../src/ai/mock.js';
import { createGeminiProvider } from '../src/ai/gemini.js';
import { createFallbackProvider } from '../src/ai/fallback.js';
import { createHuggingFaceProvider } from '../src/ai/huggingface.js';
import { createOpenAIProvider } from '../src/ai/openai.js';
import { createOllamaProvider } from '../src/ai/ollama.js';
import { getProvider, listProviders } from '../src/ai/index.js';
import { createChatRouter } from '../src/routes/chat.js';
import { config, redactSecrets, safeSummary } from '../src/config.js';
import { NO_WORKSPACE_SYSTEM_INSTRUCTION, WORKSPACE_SYSTEM_INSTRUCTION } from '../src/ai/tool-response.js';

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
    { name: 'openai', displayName: 'OpenAI', model: 'custom-model', chat: undefined },
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

test('provider selection keeps OpenRouter and Gemini credentials independent', () => {
  const settings = {
    aiProvider: 'openai',
    aiApiKey: 'openrouter-key',
    aiModel: 'openrouter-model',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    geminiApiKey: 'gemini-key',
    geminiModel: 'gemini-test-model',
  };

  const openai = getProvider('openai', settings);
  assert.equal(openai.name, 'openai');
  assert.equal(openai.displayName, 'OpenRouter');
  assert.equal(openai.model, 'openrouter-model');

  const gemini = getProvider('gemini', settings);
  assert.equal(gemini.name, 'gemini');
  assert.equal(gemini.model, 'gemini-test-model');
});

test('OpenRouter uses the verified free default when AI_MODEL is unset', () => {
  const provider = getProvider('openai', {
    aiProvider: 'openai',
    aiApiKey: 'test-openrouter-key',
    aiModel: '',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
  });

  assert.equal(provider.model, 'particle-ai/particle-1:free');
});

test('explicit AI_MODEL still overrides the OpenRouter default', () => {
  const provider = getProvider('openai', {
    aiProvider: 'openai',
    aiApiKey: 'test-openrouter-key',
    aiModel: 'custom/model:free',
    openaiBaseUrl: 'https://openrouter.ai/api/v1/',
  });

  assert.equal(provider.model, 'custom/model:free');
});

test('non-OpenRouter OpenAI-compatible endpoints keep the generic default', () => {
  const provider = getProvider('openai', {
    aiProvider: 'openai',
    aiApiKey: 'test-key',
    aiModel: '',
    openaiBaseUrl: 'https://api.example.com/v1',
  });

  assert.equal(provider.model, 'gpt-4o-mini');
});

test('the retired model is never selected as an adapter default', () => {
  const retiredModel = ['cohere', 'north-mini-code:free'].join('/');

  for (const openaiBaseUrl of ['', 'https://openrouter.ai/api/v1']) {
    const provider = getProvider('openai', {
      aiProvider: 'openai',
      aiApiKey: 'test-key',
      aiModel: '',
      openaiBaseUrl,
    });
    assert.notEqual(provider.model, retiredModel);
  }
});

test('OpenRouter selected model is sent in the chat completion request body', async () => {
  let requestBody;
  const provider = createOpenAIProvider({
    apiKey: 'test-openrouter-key',
    model: 'particle-ai/particle-1:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return Response.json({
        model: 'particle-ai/particle-1:free',
        choices: [{ message: { content: 'Hello via OpenRouter.' } }],
      });
    },
  });

  const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });

  assert.equal(requestBody.model, 'particle-ai/particle-1:free');
  assert.equal(result.model, 'particle-ai/particle-1:free');
});

test('Gemini keeps legacy shared AI_API_KEY/AI_MODEL settings working', () => {
  // Existing Gemini-only deployments configured the key/model through the
  // shared variables, so those must continue to work.
  const legacySelected = {
    aiProvider: 'gemini',
    aiApiKey: 'legacy-gemini-key',
    aiModel: 'legacy-gemini-model',
    geminiApiKey: '',
    geminiModel: '',
  };
  assert.equal(getProvider('gemini', legacySelected).model, 'legacy-gemini-model');

  // Settings objects that predate the split have no Gemini-specific fields.
  const oldShape = { aiApiKey: 'legacy-key', aiModel: 'custom-model' };
  assert.equal(getProvider('gemini', oldShape).model, 'custom-model');
});

test('Gemini never receives the OpenRouter key when keys are independent', async () => {
  const provider = getProvider('gemini', {
    aiProvider: 'openai',
    aiApiKey: 'openrouter-key',
    aiModel: 'openrouter-model',
    geminiApiKey: '',
    geminiModel: '',
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.match(error.publicMessage, /Google AI API key/);
      return true;
    },
  );
});

test('OpenRouter never receives a legacy Gemini-only key when switching providers', async () => {
  const provider = getProvider('openai', {
    aiProvider: 'gemini',
    aiApiKey: 'legacy-gemini-key',
    aiModel: 'legacy-gemini-model',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    geminiApiKey: '',
    geminiModel: '',
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.match(error.publicMessage, /AI_API_KEY/);
      return true;
    },
  );
});

test('secret redaction and safe summaries cover both provider keys', () => {
  const savedAiKey = config.aiApiKey;
  const savedGeminiKey = config.geminiApiKey;
  config.aiApiKey = 'sk-openrouter-secret-value';
  config.geminiApiKey = 'AIzaSyGeminiSecretValue1234567890';

  try {
    const otherGoogleKey = 'AIzaSyOtherGoogleKey1234567890abcdef';
    const safe = redactSecrets(
      `openrouter=${config.aiApiKey} gemini=${config.geminiApiKey} other=${otherGoogleKey}`,
    );

    assert.ok(!safe.includes(config.aiApiKey));
    assert.ok(!safe.includes(config.geminiApiKey));
    assert.ok(!safe.includes(otherGoogleKey));
    assert.match(safe, /\[redacted/);

    const summary = JSON.stringify(safeSummary());
    assert.ok(!summary.includes(config.aiApiKey));
    assert.ok(!summary.includes(config.geminiApiKey));
    assert.match(summary, /hidden/);
  } finally {
    config.aiApiKey = savedAiKey;
    config.geminiApiKey = savedGeminiKey;
  }
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
        content: NO_WORKSPACE_SYSTEM_INSTRUCTION,
      },
      ...messages,
    ],
    temperature: 0.7,
  });
  assert.equal(result.text, 'Hello from OpenAI.');
  assert.equal(result.model, 'test-model-response');
});

test('OpenAI adapter sends no tools when no workspace is selected', async () => {
  let body;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'I can only use this conversation.' } }] });
    },
  });

  const result = await provider.chat({ messages: [{ role: 'user', content: 'List my files.' }] });

  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
  assert.match(body.messages[0].content, /no workspace tools/i);
  assert.match(body.messages[0].content, /cannot inspect the whole PC/i);
  assert.match(body.messages[0].content, /read or write files/i);
  assert.match(body.messages[0].content, /browse the web/i);
  assert.deepEqual(result.toolActivity, []);
});

test('OpenAI adapter tells the model that staged changes are not yet applied', async () => {
  let body;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'staged' } }] });
    },
  });

  await provider.chat({
    messages: [{ role: 'user', content: 'create a file' }],
    tools: { declarations: [{ functionDeclarations: [{ name: 'create_file' }] }], execute: async () => ({}) },
    projectId: 7,
  });

  const instruction = body.messages[0].content;
  assert.match(instruction, /awaiting/i);
  assert.match(instruction, /approval/i);
  assert.match(instruction, /never say that you created/i);
  assert.match(instruction, /cannot browse the web/i);
  assert.match(instruction, /list_files once for the requested directory/i);
});

test('OpenAI adapter supports an OpenRouter-compatible base URL', async () => {
  let requestUrl;
  const provider = createOpenAIProvider({
    apiKey: 'test-openrouter-key',
    model: 'meta-llama/llama-3.1-8b-instruct:free',
    baseUrl: 'https://openrouter.ai/api/v1/',
    fetchImpl: async (url) => {
      requestUrl = url;
      return Response.json({
        model: 'meta-llama/llama-3.1-8b-instruct:free',
        choices: [{ message: { content: 'Hello via OpenRouter.' } }],
      });
    },
  });

  const result = await provider.chat({ messages: [{ role: 'user', content: 'Hello' }] });

  assert.equal(requestUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(result.text, 'Hello via OpenRouter.');
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'meta-llama/llama-3.1-8b-instruct:free');
});

test('OpenAI adapter names OpenRouter in upstream errors', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'test-openrouter-key',
    model: 'particle-ai/particle-1:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore: new Map(),
    fetchImpl: async () => Response.json({
      error: { message: 'Rate limit exceeded: free-models-per-day.' },
    }, { status: 429 }),
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.match(error.publicMessage, /OpenRouter/);
      assert.match(error.publicMessage, /free-models-per-day/);
      assert.ok(!error.publicMessage.includes('test-openrouter-key'));
      return true;
    },
  );
});

test('OpenAI adapter logs redacted OpenRouter diagnostics without the API key', async () => {
  const secret = 'sk-test-openrouter-secret-123';
  const logs = [];
  const originalError = console.error;
  const provider = createOpenAIProvider({
    apiKey: secret,
    model: 'particle-ai/particle-1:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore: new Map(),
    fetchImpl: async () => Response.json({
      error: {
        message: 'Rate limit exceeded',
        metadata: {
          error_type: 'rate_limit_exceeded',
          provider_code: 'provider-429',
        },
      },
    }, {
      status: 429,
      headers: {
        'Retry-After': '12',
        'X-RateLimit-Limit': '20',
        'X-RateLimit-Remaining': '0',
      },
    }),
  });

  console.error = (...args) => logs.push(args.join(' '));
  try {
    await assert.rejects(
      provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
      (error) => {
        assert.equal(error.category, 'RATE_LIMITED');
        assert.equal(error.retryAfterSeconds, 12);
        return true;
      },
    );
  } finally {
    console.error = originalError;
  }

  const log = logs.join('\n');
  assert.match(log, /provider=OpenRouter/);
  assert.match(log, /model=particle-ai\/particle-1:free/);
  assert.match(log, /category=RATE_LIMITED/);
  assert.match(log, /metadata=.*rate_limit_exceeded/);
  assert.match(log, /rateLimit=.*"remaining":"0"/);
  assert.match(log, /retryAfterSeconds=12/);
  assert.match(log, /detail="OpenRouter rate limit was reached/);
  assert.ok(!log.includes(secret));
});

test('OpenAI adapter reports that the configured model cannot call tools', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'some-model-without-tools',
    fetchImpl: async () => Response.json({
      error: { message: 'This model does not support tools.' },
    }, { status: 400 }),
  });

  await assert.rejects(
    provider.chat({
      messages: [{ role: 'user', content: 'List the files.' }],
      tools: { declarations: [{ functionDeclarations: [{ name: 'list_files' }] }], execute: async () => ({}) },
      projectId: 42,
    }),
    (error) => {
      assert.match(error.publicMessage, /some-model-without-tools/);
      assert.match(error.publicMessage, /cannot call tools/i);
      assert.match(error.publicMessage, /AI_MODEL/);
      return true;
    },
  );
});

test('OpenAI adapter runs workspace tools and returns staged approval activity', async () => {
  const requests = [];
  const executed = [];
  const tools = {
    declarations: [{
      functionDeclarations: [{
        name: 'create_file',
        description: 'Stage a new file.',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: { type: 'STRING' },
            content: { type: 'STRING' },
          },
          required: ['path', 'content'],
        },
      }],
    }],
    execute: async (name, args) => {
      executed.push({ name, args });
      return { proposalId: 'proposal-1', path: args.path, status: 'awaiting_user_approval' };
    },
  };
  const provider = createOpenAIProvider({
    apiKey: 'test-openrouter-key',
    model: 'test-model',
    baseUrl: 'https://openrouter.ai/api/v1',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          model: 'test-model',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'create_file',
                  arguments: JSON.stringify({ path: 'src/new.js', content: 'export const value = 1;' }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        model: 'test-model',
        choices: [{ message: { content: 'I staged the new file for your review.' } }],
      });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Create a new JS file.' }],
    tools,
    projectId: 42,
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools[0], {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Stage a new file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  });
  assert.equal(requests[0].tool_choice, 'auto');
  assert.deepEqual(executed, [{
    name: 'create_file',
    args: { path: 'src/new.js', content: 'export const value = 1;', projectId: 42 },
  }]);
  const assistantTurn = requests[1].messages.at(-2);
  assert.equal(assistantTurn.role, 'assistant');
  assert.equal(assistantTurn.content, null);
  assert.deepEqual(assistantTurn.tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: {
      name: 'create_file',
      arguments: JSON.stringify({ path: 'src/new.js', content: 'export const value = 1;' }),
    },
  }]);
  const toolTurn = requests[1].messages.at(-1);
  assert.equal(toolTurn.role, 'tool');
  assert.equal(toolTurn.tool_call_id, 'call-1', 'the tool result must match its tool_call_id');
  assert.deepEqual(JSON.parse(toolTurn.content), {
    result: { proposalId: 'proposal-1', path: 'src/new.js', status: 'awaiting_user_approval' },
  });
  assert.equal(result.text, 'I staged the new file for your review.');
  assert.deepEqual(result.toolActivity[0], {
    tool: 'create_file',
    status: 'awaiting approval',
    proposal: {
      proposalId: 'proposal-1',
      path: 'src/new.js',
      status: 'awaiting_user_approval',
      content: 'export const value = 1;',
    },
    projectId: 42,
  });
});

test('OpenAI adapter converts nested tool declarations into valid JSON Schema', async () => {
  let body;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    },
  });

  await provider.chat({
    messages: [{ role: 'user', content: 'do the thing' }],
    tools: {
      declarations: [{
        functionDeclarations: [{
          name: 'propose_file_change',
          description: 'Stage an edit.',
          parameters: {
            type: 'OBJECT',
            properties: {
              projectId: { type: 'INTEGER', description: 'Workspace id.' },
              path: { type: 'STRING' },
              content: { type: 'STRING' },
              options: {
                type: 'OBJECT',
                properties: {
                  encoding: { type: 'STRING' },
                  lineEndings: { type: 'ARRAY', items: { type: 'STRING' } },
                },
                required: ['encoding'],
              },
              nullablePath: { type: ['STRING', 'null'] },
            },
            required: ['projectId', 'path', 'content'],
          },
        }],
      }],
      execute: async () => ({}),
    },
    projectId: 42,
  });

  assert.deepEqual(body.tools[0], {
    type: 'function',
    function: {
      name: 'propose_file_change',
      description: 'Stage an edit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          options: {
            type: 'object',
            properties: {
              encoding: { type: 'string' },
              lineEndings: { type: 'array', items: { type: 'string' } },
            },
            required: ['encoding'],
          },
          nullablePath: { type: ['string', 'null'] },
        },
        required: ['path', 'content'],
      },
    },
  });
  assert.ok(!JSON.stringify(body.tools).includes('projectId'), 'the model must not be asked for a workspace id');
});

test('OpenAI adapter stages safe commands for approval without running them', async () => {
  const requests = [];
  const executed = [];
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-cmd',
                type: 'function',
                function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm_test' }) },
              }],
            },
          }],
        });
      }
      return Response.json({ choices: [{ message: { content: 'The test command is staged for approval.' } }] });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Run the tests.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'run_command' }] }],
      execute: async (name, args) => {
        executed.push({ name, args });
        return { proposalId: 'command-1', command: args.command, status: 'awaiting_user_approval' };
      },
    },
    projectId: 42,
  });

  assert.deepEqual(executed, [{ name: 'run_command', args: { command: 'npm_test', projectId: 42 } }]);
  assert.deepEqual(result.toolActivity[0], {
    tool: 'run_command',
    status: 'awaiting approval',
    commandApproval: {
      proposalId: 'command-1',
      command: 'npm_test',
      status: 'awaiting_user_approval',
    },
    projectId: 42,
  });
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), {
    result: { proposalId: 'command-1', command: 'npm_test', status: 'awaiting_user_approval' },
  });
});

test('OpenAI adapter notes that a staged change was not applied', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!body.messages.some((message) => message.role === 'assistant')) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-stage',
                type: 'function',
                function: {
                  name: 'create_file',
                  arguments: JSON.stringify({ path: 'notes.txt', content: 'hello' }),
                },
              }],
            },
          }],
        });
      }
      // A reply that claims the file already exists must not be left uncorrected.
      return Response.json({ choices: [{ message: { content: "I've created notes.txt." } }] });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Create notes.txt.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'create_file' }] }],
      execute: async () => ({
        proposalId: 'proposal-9',
        path: 'notes.txt',
        status: 'awaiting_user_approval',
        note: 'NOTHING HAS BEEN WRITTEN.',
      }),
    },
    projectId: 42,
  });

  assert.equal(result.toolActivity[0].status, 'awaiting approval');
  assert.match(result.text, /staged and waiting for your approval/i);
  assert.match(result.text, /Nothing has been written or run yet/i);
  assert.ok(!/I've created notes\.txt/i.test(result.text), result.text);
});

test('OpenAI adapter removes a false completion claim but keeps the rest of the reply', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!body.messages.some((message) => message.role === 'assistant')) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-stage',
                type: 'function',
                function: {
                  name: 'create_file',
                  arguments: JSON.stringify({ path: 'notes.txt', content: 'hello' }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            content: "I've created notes.txt with the word hello. The rest of the project is untouched.",
          },
        }],
      });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Create notes.txt.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'create_file' }] }],
      execute: async () => ({ proposalId: 'proposal-9', path: 'notes.txt', status: 'awaiting_user_approval' }),
    },
    projectId: 42,
  });

  assert.ok(!/I've created/i.test(result.text), result.text);
  assert.match(result.text, /The rest of the project is untouched\./);
  assert.match(result.text, /Nothing has been written or run yet/i);
});

test('OpenAI adapter keeps a future statement about a staged change', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!body.messages.some((message) => message.role === 'assistant')) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-stage',
                type: 'function',
                function: {
                  name: 'create_file',
                  arguments: JSON.stringify({ path: 'notes.txt', content: 'hello' }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({ choices: [{ message: { content: 'I will create the file once you approve it.' } }] });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Create notes.txt.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'create_file' }] }],
      execute: async () => ({ proposalId: 'proposal-9', path: 'notes.txt', status: 'awaiting_user_approval' }),
    },
    projectId: 42,
  });

  assert.match(result.text, /I will create the file once you approve it\./);
});

test('OpenAI adapter does not let a reply claim a failed write succeeded', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!body.messages.some((message) => message.role === 'assistant')) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-fail',
                type: 'function',
                function: {
                  name: 'create_file',
                  arguments: JSON.stringify({ path: 'notes.txt', content: 'hello' }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({ choices: [{ message: { content: "I've created notes.txt." } }] });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Create notes.txt.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'create_file' }] }],
      execute: async () => {
        const error = new Error('notes.txt already exists.');
        error.publicMessage = 'notes.txt already exists.';
        throw error;
      },
    },
    projectId: 42,
  });

  assert.equal(result.toolActivity[0].status, 'failed');
  assert.ok(!/I've created/i.test(result.text), result.text);
});

test('OpenAI adapter leaves a reply that already mentions approval unchanged', async () => {
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (!body.messages.some((message) => message.role === 'assistant')) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-stage',
                type: 'function',
                function: {
                  name: 'create_file',
                  arguments: JSON.stringify({ path: 'notes.txt', content: 'hello' }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({ choices: [{ message: { content: 'The file is staged and awaits your approval.' } }] });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Create notes.txt.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'create_file' }] }],
      execute: async () => ({ proposalId: 'proposal-9', path: 'notes.txt', status: 'awaiting_user_approval' }),
    },
    projectId: 42,
  });

  assert.equal(result.text, 'The file is staged and awaits your approval.');
});

test('OpenAI adapter reports a failing tool clearly without failing the request', async () => {
  const requests = [];
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-missing',
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'missing.js' }) },
              }],
            },
          }],
        });
      }
      return Response.json({ choices: [{ message: { content: 'That file does not exist.' } }] });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Read missing.js' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'read_file' }] }],
      execute: async () => {
        const error = new Error('Path not found: missing.js');
        error.publicMessage = 'Path not found: missing.js';
        throw error;
      },
    },
    projectId: 42,
  });

  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), { error: 'Path not found: missing.js' });
  assert.equal(result.toolActivity[0].status, 'failed');
  assert.equal(result.text, 'That file does not exist.');
});

test('OpenAI adapter reports malformed tool arguments without executing them', async () => {
  const requests = [];
  let executed = false;
  const provider = createOpenAIProvider({
    apiKey: 'test-openrouter-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-invalid',
                type: 'function',
                function: { name: 'read_file', arguments: '{bad json' },
              }],
            },
          }],
        });
      }
      return Response.json({
        choices: [{ message: { content: 'I could not read the file because the tool arguments were invalid.' } }],
      });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Read a file.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'read_file' }] }],
      execute: async () => { executed = true; },
    },
    projectId: 42,
  });

  assert.equal(executed, false);
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), {
    error: 'Tool arguments were not valid JSON.',
  });
  assert.equal(result.toolActivity[0].status, 'failed');
  assert.match(result.text, /arguments were invalid/);
});

test('OpenAI adapter rejects tool arguments that are missing or not an object', async () => {
  for (const [label, argumentsValue, expectedError] of [
    ['missing arguments', undefined, 'Tool arguments were missing.'],
    ['array arguments', '[1, 2]', 'OpenAI returned invalid tool arguments.'],
    ['null arguments', 'null', 'OpenAI returned invalid tool arguments.'],
  ]) {
    const requests = [];
    let executed = false;
    const provider = createOpenAIProvider({
      apiKey: 'test-key',
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        if (requests.length === 1) {
          return Response.json({
            choices: [{
              message: {
                tool_calls: [{
                  id: 'call-bad-args',
                  type: 'function',
                  function: { name: 'read_file', arguments: argumentsValue },
                }],
              },
            }],
          });
        }
        return Response.json({ choices: [{ message: { content: 'I could not run that tool.' } }] });
      },
    });

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Read a file.' }],
      tools: {
        declarations: [{ functionDeclarations: [{ name: 'read_file' }] }],
        execute: async () => { executed = true; },
      },
      projectId: 42,
    });

    assert.equal(executed, false, `${label} must not reach the tool`);
    assert.deepEqual(
      JSON.parse(requests[1].messages.at(-1).content),
      { error: expectedError },
      `${label} must be reported clearly`,
    );
    assert.equal(result.toolActivity[0].status, 'failed');
  }
});

test('OpenAI adapter treats equivalent path spellings as the same tool call', async () => {
  const requests = [];
  let executions = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length <= 2) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: `call-${requests.length}`,
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: requests.length === 1
                    ? JSON.stringify({ path: 'src/app.js' })
                    : JSON.stringify({ path: './src/app.js' }),
                },
              }],
            },
          }],
        });
      }
      assert.equal(body.tools, undefined, 'the final answer request must not offer tools');
      return Response.json({ choices: [{ message: { content: 'The file content is above.' } }] });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Read src/app.js.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'read_file' }] }],
      execute: async () => {
        executions += 1;
        return { path: 'src/app.js', content: 'export const value = 1;' };
      },
    },
    projectId: 42,
  });

  assert.equal(executions, 1, 'an equivalent path must not be executed twice');
  assert.equal(result.toolActivity[1].reused, true);
  assert.equal(result.toolActivity[1].status, 'completed');
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), {
    result: { path: 'src/app.js', content: 'export const value = 1;' },
  });
});

test('OpenAI adapter stops and finalizes when a model repeats an identical tool call', async () => {
  let requests = 0;
  let executions = 0;
  const requestBodies = [];
  const provider = createOpenAIProvider({
    apiKey: 'test-openrouter-key',
    fetchImpl: async (_url, options) => {
      requests += 1;
      const body = JSON.parse(options.body);
      requestBodies.push(body);
      if (requests <= 2) {
        assert.ok(body.tools, 'tools should be available before the duplicate is detected');
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: `call-${requests}`,
                type: 'function',
                function: {
                  name: 'list_files',
                  arguments: requests === 1 ? '{}' : '{"path":"."}',
                },
              }],
            },
          }],
        });
      }
      assert.equal(body.tools, undefined, 'the final answer request must not offer tools');
      return Response.json({
        choices: [{ message: { content: 'The workspace listing is complete.' } }],
      });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'List the project files.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'list_files' }] }],
      execute: async () => {
        executions += 1;
        return { path: '.', items: [{ name: 'src', type: 'directory' }], total: 1, truncated: false };
      },
    },
    projectId: 42,
  });

  assert.equal(requests, 3);
  assert.equal(executions, 1);
  assert.match(result.text, /listing is complete/);
  assert.equal(result.toolActivity[0].status, 'completed');
  assert.equal(result.toolActivity[1].status, 'completed');
  assert.equal(result.toolActivity[1].reused, true);
  assert.deepEqual(JSON.parse(requestBodies[1].messages.at(-1).content), {
    result: { path: '.', items: [{ name: 'src', type: 'directory' }], total: 1, truncated: false },
  });
});

test('OpenAI adapter bounds workspace tool-call rounds', async () => {
  let calls = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-openrouter-key',
    fetchImpl: async () => {
      calls += 1;
      return Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: `call-${calls}`,
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: `file-${calls}` }) },
            }],
          },
        }],
      });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Read a file.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'read_file' }] }],
      execute: async () => ({ status: 'ok' }),
    },
    projectId: 42,
  });

  assert.equal(calls, 7);
  assert.match(result.text, /maximum of 6 workspace tool-call rounds/);
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
      { text: NO_WORKSPACE_SYSTEM_INSTRUCTION },
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
        cooldownStore: new Map(),
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

test('Gemini adapter uses supported default model gemini-3.8-flash', async () => {
  let request;
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Hello from Gemini 3.8 Flash.' }] } }],
      });
    },
  });
  const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.ok(request.url.includes('gemini-3.8-flash'), 'Default model should be gemini-3.8-flash');
  assert.equal(result.text, 'Hello from Gemini 3.8 Flash.');
});

test('OpenRouter retries transient 429 and 502 responses with bounded attempts', async () => {
  let calls = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/retry-model:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxAttempts: 3,
    retryDelaysMs: [0, 0],
    jitterMs: 0,
    cooldownStore: new Map(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ error: { message: 'too many requests' } }, { status: 429 });
      }
      if (calls === 2) {
        return Response.json({ error: { message: 'temporary gateway failure' } }, { status: 502 });
      }
      return Response.json({ choices: [{ message: { content: 'Recovered.' } }] });
    },
  });

  const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(result.text, 'Recovered.');
  assert.equal(calls, 3);
});

test('OpenRouter retries 503 and 504 but never retries authentication or invalid requests', async () => {
  for (const status of [503, 504]) {
    let calls = 0;
    const provider = createOpenAIProvider({
      apiKey: 'test-key',
      model: `test/transient-${status}:free`,
      baseUrl: 'https://openrouter.ai/api/v1',
      maxAttempts: 2,
      retryDelaysMs: [0],
      jitterMs: 0,
      cooldownStore: new Map(),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ error: { message: 'temporary failure' } }, { status });
        }
        return Response.json({ choices: [{ message: { content: 'Recovered.' } }] });
      },
    });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    assert.equal(result.text, 'Recovered.');
    assert.equal(calls, 2);
  }

  for (const status of [401, 400]) {
    let calls = 0;
    const provider = createOpenAIProvider({
      apiKey: 'test-key',
      model: `test/permanent-${status}:free`,
      baseUrl: 'https://openrouter.ai/api/v1',
      retryDelaysMs: [0],
      jitterMs: 0,
      cooldownStore: new Map(),
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ error: { message: 'rejected' } }, { status });
      },
    });
    await assert.rejects(provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }));
    assert.equal(calls, 1);
  }
});

test('OpenRouter records model cooldowns and honors Retry-After', async () => {
  const cooldownStore = new Map();
  let calls = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/cooldown-model:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxAttempts: 2,
    retryDelaysMs: [0],
    jitterMs: 0,
    cooldownStore,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(
        { error: { message: 'too many requests' } },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    },
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.category, 'RATE_LIMITED');
      assert.equal(error.retryAfterMs, 60_000);
      return true;
    },
  );
  assert.equal(calls, 1, 'long Retry-After must not be ignored');
  assert.ok(cooldownStore.has('https://openrouter.ai/api/v1::test/cooldown-model:free'));

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi again' }] }),
    (error) => {
      assert.equal(error.category, 'RATE_LIMITED');
      assert.match(error.publicMessage, /cooling down/i);
      return true;
    },
  );
  assert.equal(calls, 1, 'cooldown must prevent repeated provider calls');
});

test('OpenRouter retries never repeat a tool that already executed', async () => {
  let calls = 0;
  const executed = [];
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/tool-retry-model:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxAttempts: 3,
    retryDelaysMs: [0, 0],
    jitterMs: 0,
    cooldownStore: new Map(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ error: { message: 'too many requests' } }, { status: 429 });
      }
      if (calls === 2) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'call-read',
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
              }],
            },
          }],
        });
      }
      return Response.json({ choices: [{ message: { content: 'Done.' } }] });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Read the file.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'read_file' }] }],
      execute: async (name, args) => {
        executed.push({ name, args });
        return { path: args.path, size: 1 };
      },
    },
    projectId: 42,
  });

  assert.equal(result.text, 'Done.');
  assert.equal(executed.length, 1, 'tool execution must not be replayed');
  assert.equal(calls, 3);
});

test('Gemini registry default is gemini-3.8-flash while OpenRouter stays optional', () => {
  const settings = {
    aiProvider: 'gemini',
    aiApiKey: 'test-key',
    aiModel: '',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    geminiApiKey: 'test-gemini-key',
    geminiModel: '',
  };

  const gemini = getProvider('gemini', settings);
  assert.equal(gemini.model, 'gemini-3.8-flash');

  const openRouter = getProvider('openai', settings);
  assert.equal(openRouter.name, 'openai');
  assert.equal(openRouter.model, 'particle-ai/particle-1:free');
});

test('Gemini daily quota exhaustion is not retried and starts a cooldown', async () => {
  let calls = 0;
  const cooldownStore = new Map();
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    retryDelaysMs: [0, 0],
    jitterMs: 0,
    cooldownStore,
    fetchImpl: async () => {
      calls += 1;
      return Response.json({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Resource has been exhausted (e.g. check quota).',
        },
      }, { status: 429 });
    },
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.category, 'QUOTA_EXHAUSTED');
      assert.equal(error.retryable, false);
      assert.equal(error.fallbackEligible, true);
      assert.match(error.publicMessage, /quota|exhausted/i);
      return true;
    },
  );
  assert.equal(calls, 1, 'daily quota must never be retried');
  const cooldown = cooldownStore.get('gemini:gemini-3.8-flash');
  assert.ok(cooldown);
  assert.equal(cooldown.category, 'QUOTA_EXHAUSTED');

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi again' }] }),
    (error) => {
      assert.equal(error.category, 'QUOTA_EXHAUSTED');
      assert.match(error.publicMessage, /No further Gemini requests|cooldown/i);
      return true;
    },
  );
  assert.equal(calls, 1, 'cooldown must prevent repeated quota calls');
});

test('Gemini retries HTTP 503 with bounded backoff and succeeds when capacity returns', async () => {
  let calls = 0;
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    retryDelaysMs: [0, 0],
    jitterMs: 0,
    cooldownStore: new Map(),
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        return Response.json({
          error: { message: 'This model is currently experiencing high demand.' },
        }, { status: 503 });
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Recovered reply.' }] } }],
      });
    },
  });

  const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(result.text, 'Recovered reply.');
  assert.equal(calls, 3);
});

test('Gemini stops after the retry limit when HTTP 503 persists', async () => {
  let calls = 0;
  const cooldownStore = new Map();
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    maxAttempts: 3,
    retryDelaysMs: [0, 0],
    jitterMs: 0,
    cooldownStore,
    fetchImpl: async () => {
      calls += 1;
      return Response.json({
        error: { message: 'This model is currently experiencing high demand.' },
      }, { status: 503 });
    },
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.category, 'CAPACITY_UNAVAILABLE');
      assert.equal(error.fallbackEligible, true);
      assert.match(error.publicMessage, /capacity|temporarily unavailable/i);
      return true;
    },
  );
  assert.equal(calls, 3, 'retry count must be capped');
  assert.ok(cooldownStore.has('gemini:gemini-3.8-flash'));
});

test('Gemini does not retry when Retry-After exceeds the interactive cap', async () => {
  let calls = 0;
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    retryDelaysMs: [0, 0],
    jitterMs: 0,
    cooldownStore: new Map(),
    fetchImpl: async () => {
      calls += 1;
      return Response.json(
        { error: { message: 'too many requests' } },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    },
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.category, 'RATE_LIMITED');
      assert.equal(error.retryAfterMs, 60_000);
      return true;
    },
  );
  assert.equal(calls, 1, 'a long Retry-After must not be ignored');
});

test('Gemini retries timeouts with a bounded attempt count', async () => {
  let calls = 0;
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    maxAttempts: 2,
    retryDelaysMs: [0],
    jitterMs: 0,
    cooldownStore: new Map(),
    fetchImpl: async () => {
      calls += 1;
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    },
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => {
      assert.equal(error.category, 'NETWORK_TIMEOUT');
      assert.equal(error.statusCode, 504);
      assert.equal(error.fallbackEligible, true);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test('explicit fallback returns the actual OpenRouter provider and model', async () => {
  let fallbackCalls = 0;
  const primary = {
    name: 'gemini',
    model: 'gemini-3.8-flash',
    async chat() {
      const error = new Error('Gemini daily quota is exhausted.');
      error.category = 'QUOTA_EXHAUSTED';
      error.errorType = 'QUOTA_EXHAUSTED';
      error.fallbackEligible = true;
      error.publicMessage = 'Gemini daily quota is exhausted.';
      throw error;
    },
  };
  const fallback = {
    name: 'openai',
    model: 'particle-ai/particle-1:free',
    async chat() {
      fallbackCalls += 1;
      return {
        text: 'Fallback reply.',
        provider: 'openai',
        model: 'particle-ai/particle-1:free',
      };
    },
  };
  const wrapped = createFallbackProvider({
    primary,
    fallback,
    log: { warn() {} },
  });

  const result = await wrapped.chat({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'particle-ai/particle-1:free');
  assert.equal(result.text, 'Fallback reply.');
  assert.deepEqual(result.fallback, {
    from: 'gemini',
    fromModel: 'gemini-3.8-flash',
    reason: 'QUOTA_EXHAUSTED',
    retryAfterMs: null,
  });
  assert.equal(fallbackCalls, 1);
});

test('explicit fallback is disabled after tool execution or for invalid credentials', async () => {
  let fallbackCalls = 0;
  const fallback = {
    name: 'openai',
    model: 'particle-ai/particle-1:free',
    async chat() {
      fallbackCalls += 1;
      return { text: 'should not run', provider: 'openai', model: 'particle-ai/particle-1:free' };
    },
  };

  const afterTools = new Error('Provider failed after a tool ran.');
  afterTools.category = 'CAPACITY_UNAVAILABLE';
  afterTools.fallbackEligible = true;
  afterTools.toolActivity = [{ tool: 'read_file', status: 'completed' }];
  const wrappedAfterTools = createFallbackProvider({
    primary: { name: 'gemini', model: 'gemini-3.8-flash', async chat() { throw afterTools; } },
    fallback,
    log: { warn() {} },
  });
  await assert.rejects(
    wrappedAfterTools.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => error === afterTools,
  );

  const invalidKey = new Error('API key not valid.');
  invalidKey.category = 'INVALID_API_KEY';
  invalidKey.fallbackEligible = false;
  const wrappedInvalidKey = createFallbackProvider({
    primary: { name: 'gemini', model: 'gemini-3.8-flash', async chat() { throw invalidKey; } },
    fallback,
    log: { warn() {} },
  });
  await assert.rejects(
    wrappedInvalidKey.chat({ messages: [{ role: 'user', content: 'Hi' }] }),
    (error) => error === invalidKey,
  );

  assert.equal(fallbackCalls, 0);
});

test('Gemini primary and OpenRouter fallback share one caller retry budget', async () => {
  let geminiCalls = 0;
  let openRouterCalls = 0;
  const primary = createGeminiProvider({
    apiKey: 'test-gemini-key',
    model: 'gemini-3.8-flash',
    cooldownStore: new Map(),
    retryDelaysMs: [0, 0],
    jitterMs: 0,
    fetchImpl: async () => {
      geminiCalls += 1;
      return Response.json(
        { error: { message: 'This model is currently experiencing high demand.' } },
        { status: 503 },
      );
    },
  });
  const fallback = createOpenAIProvider({
    apiKey: 'test-openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'test/fallback-budget:free',
    cooldownStore: new Map(),
    fetchImpl: async () => {
      openRouterCalls += 1;
      return Response.json({
        choices: [{ message: { content: 'Fallback reply.' } }],
      });
    },
  });
  const wrapped = createFallbackProvider({
    primary,
    fallback,
    log: { warn() {} },
  });

  const result = await wrapped.chat({
    messages: [{ role: 'user', content: 'Hi' }],
    retryState: { attemptsUsed: 0, exhausted: false },
  });

  assert.equal(geminiCalls, 1);
  assert.equal(openRouterCalls, 1);
  assert.equal(result.text, 'Fallback reply.');
  assert.deepEqual(result.retryState, { attemptsUsed: 2, exhausted: false });
  assert.equal(result.fallback.from, 'gemini');
});

test('an exhausted caller retry state prevents fallback HTTP calls', async () => {
  let geminiCalls = 0;
  let openRouterCalls = 0;
  const primary = createGeminiProvider({
    apiKey: 'test-gemini-key',
    model: 'gemini-3.8-flash',
    cooldownStore: new Map(),
    fetchImpl: async () => {
      geminiCalls += 1;
      return Response.json(
        { error: { message: 'This model is currently experiencing high demand.' } },
        { status: 503 },
      );
    },
  });
  const fallback = createOpenAIProvider({
    apiKey: 'test-openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'test/fallback-exhausted:free',
    cooldownStore: new Map(),
    fetchImpl: async () => {
      openRouterCalls += 1;
      return Response.json({ choices: [{ message: { content: 'Should not happen.' } }] });
    },
  });
  const wrapped = createFallbackProvider({
    primary,
    fallback,
    log: { warn() {} },
  });

  await assert.rejects(
    wrapped.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      retryState: { attemptsUsed: 4, exhausted: false },
    }),
    (error) => {
      assert.deepEqual(error.retryState, { attemptsUsed: 5, exhausted: true });
      assert.equal(error.retryBudgetExhausted, true);
      return true;
    },
  );
  assert.equal(geminiCalls, 1);
  assert.equal(openRouterCalls, 0, 'an exhausted budget must not trigger fallback HTTP');
});

test('a stale concurrent success cannot clear a newer OpenRouter failure cooldown', async () => {
  const cooldownStore = new Map();
  const key = 'https://openrouter.ai/api/v1::test/concurrent:free';
  let signalSlowFetchStarted;
  const slowFetchStarted = new Promise((resolve) => { signalSlowFetchStarted = resolve; });
  let releaseSlowFetch;
  const slowFetchGate = new Promise((resolve) => { releaseSlowFetch = resolve; });

  const slowProvider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/concurrent:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxAttempts: 1,
    cooldownStore,
    fetchImpl: async () => {
      signalSlowFetchStarted();
      await slowFetchGate;
      return Response.json({ choices: [{ message: { content: 'Slow success.' } }] });
    },
  });
  const failingProvider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/concurrent:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxAttempts: 1,
    cooldownStore,
    fetchImpl: async () => Response.json(
      { error: { message: 'too many requests' } },
      { status: 429, headers: { 'Retry-After': '60' } },
    ),
  });

  const slowCall = slowProvider.chat({ messages: [{ role: 'user', content: 'Slow' }] });
  await slowFetchStarted;
  await assert.rejects(failingProvider.chat({ messages: [{ role: 'user', content: 'Fail' }] }));
  assert.ok(cooldownStore.has(key), 'the failure must record a cooldown');

  releaseSlowFetch();
  const slowResult = await slowCall;
  assert.equal(slowResult.text, 'Slow success.');
  assert.ok(
    cooldownStore.has(key),
    'a stale success must not clear a newer failure cooldown',
  );
});

test('a caller-supplied retryState limits the adapter to one HTTP attempt per call', async () => {
  let calls = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/caller-retries:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    maxAttempts: 5,
    retryDelaysMs: [0, 0, 0, 0],
    jitterMs: 0,
    cooldownStore: new Map(),
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ error: { message: 'too many requests' } }, { status: 429 });
    },
  });

  const retryState = { attemptsUsed: 0, exhausted: false };
  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }], retryState }),
    (error) => {
      assert.ok(error.retryState, 'the adapter must report its retry state to the caller');
      assert.equal(error.retryState.attemptsUsed, 1, 'the caller-owned HTTP attempt must be counted');
      assert.equal(error.retryState.exhausted, false);
      return true;
    },
  );
  assert.equal(calls, 1, 'the executor owns retries; the adapter makes one HTTP attempt');
  assert.deepEqual(retryState, { attemptsUsed: 0, exhausted: false }, 'caller state must not be mutated');
});

test('the adapter refuses HTTP calls when the caller retry budget is exhausted', async () => {
  let calls = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/exhausted-caller:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore: new Map(),
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: 'Should not happen.' } }] });
    },
  });

  await assert.rejects(
    provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      retryState: { attemptsUsed: 5, exhausted: true },
    }),
    (error) => {
      assert.equal(error.retryBudgetExhausted, true);
      return true;
    },
  );
  assert.equal(calls, 0, 'an exhausted budget must not consume provider quota');
});

test('Gemini honors a caller-supplied retryState with one HTTP attempt per call', async () => {
  let calls = 0;
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    maxAttempts: 3,
    retryDelaysMs: [0, 0],
    jitterMs: 0,
    cooldownStore: new Map(),
    fetchImpl: async () => {
      calls += 1;
      return Response.json(
        { error: { message: 'This model is currently experiencing high demand.' } },
        { status: 503 },
      );
    },
  });

  const retryState = { attemptsUsed: 0, exhausted: false };
  await assert.rejects(
    provider.chat({ messages: [{ role: 'user', content: 'Hi' }], retryState }),
    (error) => {
      assert.ok(error.retryState, 'the adapter must report its retry state to the caller');
      assert.equal(error.retryState.attemptsUsed, 1, 'the caller-owned HTTP attempt must be counted');
      return true;
    },
  );
  assert.equal(calls, 1, 'the executor owns retries; Gemini makes one HTTP attempt');
  assert.deepEqual(retryState, { attemptsUsed: 0, exhausted: false });
});

test('Gemini refuses HTTP calls when the caller retry budget is exhausted', async () => {
  let calls = 0;
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    cooldownStore: new Map(),
    fetchImpl: async () => {
      calls += 1;
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Should not happen.' }] } }],
      });
    },
  });

  await assert.rejects(
    provider.chat({
      messages: [{ role: 'user', content: 'Hi' }],
      retryState: { attemptsUsed: 5, exhausted: true },
    }),
    (error) => {
      assert.equal(error.retryBudgetExhausted, true);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('Gemini preserves the strongest cooldown when concurrent failures arrive out of order', async () => {
  const cooldownStore = new Map();
  const key = 'gemini:gemini-3.8-flash';
  let signalQuotaFetchStarted;
  const quotaFetchStarted = new Promise((resolve) => { signalQuotaFetchStarted = resolve; });
  let releaseQuotaFetch;
  const quotaFetchGate = new Promise((resolve) => { releaseQuotaFetch = resolve; });
  let signalCapacityFetchStarted;
  const capacityFetchStarted = new Promise((resolve) => { signalCapacityFetchStarted = resolve; });
  let releaseCapacityFetch;
  const capacityFetchGate = new Promise((resolve) => { releaseCapacityFetch = resolve; });

  const quotaProvider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    maxAttempts: 1,
    cooldownStore,
    fetchImpl: async () => {
      signalQuotaFetchStarted();
      await quotaFetchGate;
      return Response.json({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Resource has been exhausted (e.g. check quota).',
        },
      }, { status: 429 });
    },
  });
  const capacityProvider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    maxAttempts: 1,
    cooldownStore,
    fetchImpl: async () => {
      signalCapacityFetchStarted();
      await capacityFetchGate;
      return Response.json(
        { error: { message: 'This model is currently experiencing high demand.' } },
        { status: 503 },
      );
    },
  });

  const quotaCall = quotaProvider.chat({ messages: [{ role: 'user', content: 'Quota' }] });
  const capacityCall = capacityProvider.chat({ messages: [{ role: 'user', content: 'Capacity' }] });
  await Promise.all([quotaFetchStarted, capacityFetchStarted]);

  // The long quota cooldown lands first.
  releaseQuotaFetch();
  await assert.rejects(quotaCall);
  const quotaCooldown = cooldownStore.get(key);
  assert.ok(quotaCooldown);
  assert.equal(quotaCooldown.category, 'QUOTA_EXHAUSTED');

  // A shorter capacity cooldown arrives later and must not replace it.
  releaseCapacityFetch();
  await assert.rejects(capacityCall);
  assert.equal(
    cooldownStore.get(key),
    quotaCooldown,
    'a shorter capacity cooldown must not replace a longer quota cooldown',
  );
});

test('every caller-owned OpenAI tool round consumes one shared attempt', async () => {
  let calls = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/tool-budget:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore: new Map(),
    retryDelaysMs: [0],
    jitterMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: `call-${calls}`,
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: `file-${calls}` }),
              },
            }],
          },
        }],
      });
    },
  });

  await assert.rejects(
    provider.chat({
      messages: [{ role: 'user', content: 'Inspect every file.' }],
      tools: {
        declarations: [{ functionDeclarations: [{ name: 'read_file' }] }],
        execute: async () => ({ status: 'ok' }),
      },
      retryState: { attemptsUsed: 0, exhausted: false },
    }),
    (error) => {
      assert.equal(error.retryState.attemptsUsed, 5, 'five HTTP rounds consume five shared attempts');
      assert.equal(error.retryState.exhausted, true);
      assert.equal(error.toolActivity.length, 5, 'tool activity must travel with a terminal failure');
      return true;
    },
  );
  assert.equal(calls, 5, 'no sixth HTTP round may start after the budget is exhausted');
});

test('Gemini primary plus OpenRouter fallback tool rounds share one caller budget', async () => {
  let geminiCalls = 0;
  let openRouterCalls = 0;
  const primary = createGeminiProvider({
    apiKey: 'test-gemini-key',
    cooldownStore: new Map(),
    fetchImpl: async () => {
      geminiCalls += 1;
      return Response.json(
        { error: { message: 'Quota exceeded for today.' } },
        { status: 429 },
      );
    },
  });
  const fallback = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/fallback-tools:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore: new Map(),
    fetchImpl: async () => {
      openRouterCalls += 1;
      if (openRouterCalls === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'fallback-call-1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ path: 'src/app.js' }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({ choices: [{ message: { content: 'Fallback finished after tools.' } }] });
    },
  });
  const wrapped = createFallbackProvider({ primary, fallback, log: { warn() {} } });

  const result = await wrapped.chat({
    messages: [{ role: 'user', content: 'Inspect the project.' }],
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'read_file' }] }],
      execute: async () => ({ status: 'ok' }),
    },
    retryState: { attemptsUsed: 0, exhausted: false },
  });

  assert.equal(geminiCalls, 1, 'the primary request consumes one attempt');
  assert.equal(openRouterCalls, 2, 'each fallback tool round consumes one attempt');
  assert.deepEqual(result.retryState, { attemptsUsed: 3, exhausted: false });
});

test('a shared OpenAI cooldown short-circuits without consuming a caller attempt', async () => {
  const cooldownStore = new Map();
  let calls = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/shared-cooldown:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore,
    fetchImpl: async () => {
      calls += 1;
      return Response.json(
        { error: { message: 'too many requests' } },
        { status: 429, headers: { 'Retry-After': '3600' } },
      );
    },
  });
  const args = { messages: [{ role: 'user', content: 'Hi' }], retryState: { attemptsUsed: 0, exhausted: false } };

  await assert.rejects(provider.chat(args), (error) => {
    assert.equal(error.retryState.attemptsUsed, 1, 'the real HTTP request consumes one attempt');
    assert.ok(error.retryAfterMs > 3_500_000, 'the error must report the persisted cooldown');
    return true;
  });
  assert.equal(calls, 1);

  await assert.rejects(provider.chat(args), (error) => {
    assert.equal(error.providerCooldownShortCircuit, true);
    assert.equal(error.retryState.attemptsUsed, 0, 'no HTTP request means no attempt consumed');
    return true;
  });
  assert.equal(calls, 1, 'a cooldown short-circuit must not call the provider');
});

test('a shorter Retry-After cannot shorten a stronger OpenAI cooldown', async () => {
  const cooldownStore = new Map();
  const key = 'https://openrouter.ai/api/v1::test/strong-cooldown:free';
  let calls = 0;
  let signalFetchStarted;
  const fetchStarted = new Promise((resolve) => { signalFetchStarted = resolve; });
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/strong-cooldown:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore,
    fetchImpl: async () => {
      calls += 1;
      signalFetchStarted();
      await fetchGate;
      return Response.json(
        { error: { message: 'too many requests' } },
        { status: 429, headers: { 'Retry-After': '1' } },
      );
    },
  });

  const pending = provider.chat({
    messages: [{ role: 'user', content: 'Hi' }],
    retryState: { attemptsUsed: 0, exhausted: false },
  });
  await fetchStarted;
  // A concurrent failure established a stronger cooldown while this request was
  // in flight; the later, weaker Retry-After must not shorten it.
  cooldownStore.set(key, { until: Date.now() + 3_600_000, token: 99 });
  releaseFetch();

  await assert.rejects(pending, (error) => {
    assert.ok(
      error.retryAfterMs > 3_500_000,
      'the error must report the effective cooldown, not the shorter upstream header',
    );
    assert.equal(cooldownStore.get(key).token, 99, 'the stronger cooldown must be preserved');
    return true;
  });
  assert.equal(calls, 1);
});

test('a rethrown cooldown error is not applied twice when the clock advances', async () => {
  const cooldownStore = new Map();
  const key = 'https://openrouter.ai/api/v1::test/double-cooldown:free';
  let calls = 0;
  let signalFetchStarted;
  const fetchStarted = new Promise((resolve) => { signalFetchStarted = resolve; });
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/double-cooldown:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore,
    fetchImpl: async () => {
      calls += 1;
      signalFetchStarted();
      await fetchGate;
      return Response.json(
        { error: { message: 'too many requests' } },
        { status: 429, headers: { 'Retry-After': '1' } },
      );
    },
  });

  const pending = provider.chat({
    messages: [{ role: 'user', content: 'Hi' }],
    retryState: { attemptsUsed: 0, exhausted: false },
  });
  await fetchStarted;
  cooldownStore.set(key, { until: Date.now() + 3_600_000, token: 123 });

  // Force a measurable gap between the first and any second cooldown write.
  // The old double-apply bug replaced the stronger entry with a fresh, weaker
  // until value because time had advanced; the fix skips the second write.
  const realNow = Date.now;
  let nowCalls = 0;
  Date.now = () => {
    nowCalls += 1;
    return realNow() + (nowCalls > 2 ? 25 : 0);
  };
  try {
    releaseFetch();
    await assert.rejects(pending, (error) => {
      assert.equal(cooldownStore.get(key).token, 123, 'the stronger cooldown entry must remain untouched');
      assert.equal(error.cooldownApplied, true);
      assert.ok(error.retryAfterMs > 3_500_000);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    Date.now = realNow;
  }
});

test('a shorter Retry-After cannot shorten a stronger Gemini cooldown', async () => {
  const cooldownStore = new Map();
  const key = 'gemini:test/strong-cooldown';
  let calls = 0;
  let signalFetchStarted;
  const fetchStarted = new Promise((resolve) => { signalFetchStarted = resolve; });
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    model: 'test/strong-cooldown',
    cooldownStore,
    fetchImpl: async () => {
      calls += 1;
      signalFetchStarted();
      await fetchGate;
      return Response.json(
        { error: { message: 'This model is currently experiencing high demand.' } },
        { status: 503, headers: { 'Retry-After': '1' } },
      );
    },
  });

  const pending = provider.chat({
    messages: [{ role: 'user', content: 'Hi' }],
    retryState: { attemptsUsed: 0, exhausted: false },
  });
  await fetchStarted;
  cooldownStore.set(key, {
    until: Date.now() + 3_600_000,
    category: 'QUOTA_EXHAUSTED',
  });
  releaseFetch();

  await assert.rejects(pending, (error) => {
    assert.ok(
      error.retryAfterMs > 3_500_000,
      'Gemini must report the effective cooldown it persisted',
    );
    return true;
  });
  assert.equal(calls, 1);
});

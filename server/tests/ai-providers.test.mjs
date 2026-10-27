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
        content: 'You are MyAI, a coding assistant. Answer clearly and accurately. You have access only to this conversation: no project workspace is selected, so you have no workspace tools. You cannot read or write files, run commands, browse the web, or reach any external service. Say so plainly if a request needs workspace access or the web. Never claim to have applied a change, run a command, accessed external tools, or browsed the web.',
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
  assert.match(body.messages[0].content, /cannot read or write files/i);
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
    model: 'cohere/north-mini-code:free',
    baseUrl: 'https://openrouter.ai/api/v1',
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

test('Gemini adapter uses supported default model gemini-2.5-flash', async () => {
  let request;
  const provider = createGeminiProvider({
    apiKey: 'test-gemini-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Hello from Gemini 2.5 Flash.' }] } }],
      });
    },
  });
  const result = await provider.chat({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.ok(request.url.includes('gemini-2.5-flash'), 'Default model should be gemini-2.5-flash');
  assert.equal(result.text, 'Hello from Gemini 2.5 Flash.');
});

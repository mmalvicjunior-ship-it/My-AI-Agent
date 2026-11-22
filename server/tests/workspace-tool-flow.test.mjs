// Mocked regression tests for approved-workspace inspection across adapters.
// No live provider or network access is used.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/index.js';
import { openDb } from '../src/db/index.js';
import { createWorkspaceTools, stripServerManagedProjectId, geminiToolDeclarations } from '../src/ai/tools.js';
import { createGeminiProvider } from '../src/ai/gemini.js';
import { createOpenAIProvider } from '../src/ai/openai.js';
import { createFallbackProvider } from '../src/ai/fallback.js';

const db = openDb();
const servers = [];

async function startServer(app) {
  const server = app.listen(0);
  await once(server, 'listening');
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async post(route, body) {
      const response = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    },
  };
}

after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

function makeProject(prefix = 'workspace-flow') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const inserted = db
    .prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
    .run(prefix, root);
  return { id: Number(inserted.lastInsertRowid), root };
}

test('chat response states whether an approved workspace was available', async () => {
  const seen = [];
  const spyProvider = {
    name: 'spy',
    model: 'spy-1',
    async chat({ tools, projectId }) {
      seen.push({ hasTools: Boolean(tools), projectId });
      return { text: 'ok', provider: 'spy', model: 'spy-1' };
    },
  };
  const api = await startServer(createApp({ auth: false, provider: spyProvider }).app);
  const projectId = (await api.post('/api/projects', { name: 'Workspace Metadata Test' })).data.project.id;

  const withWorkspace = await api.post('/api/chat', { message: 'Inspect my project.', projectId });
  assert.equal(withWorkspace.status, 200);
  assert.deepEqual(withWorkspace.data.workspace, {
    available: true,
    projectId,
    requested: true,
    reason: null,
  });
  assert.deepEqual(seen.at(-1), { hasTools: true, projectId });

  const withoutWorkspace = await api.post('/api/chat', { message: 'Check my PC.' });
  assert.equal(withoutWorkspace.status, 200);
  assert.deepEqual(withoutWorkspace.data.workspace, {
    available: false,
    projectId: null,
    requested: false,
    reason: 'no_workspace_selected',
  });
  assert.deepEqual(seen.at(-1), { hasTools: false, projectId: null });

  const rejectedWorkspace = await api.post('/api/chat', { message: 'Inspect my project.', projectId: 99999999 });
  assert.equal(rejectedWorkspace.status, 200);
  assert.equal(rejectedWorkspace.data.workspace.available, false);
  assert.equal(rejectedWorkspace.data.workspace.reason, 'workspace_unavailable');
});

test('model-facing declarations hide projectId but keep every workspace tool', () => {
  const declarations = stripServerManagedProjectId(geminiToolDeclarations);
  const functions = declarations.flatMap((group) => group.functionDeclarations || []);
  const names = functions.map((fn) => fn.name).sort();

  assert.deepEqual(names, [
    'create_file',
    'list_files',
    'propose_file_change',
    'read_file',
    'run_command',
    'search_files',
  ]);
  for (const fn of functions) {
    const properties = fn.parameters?.properties || {};
    const required = fn.parameters?.required || [];
    assert.equal(Object.hasOwn(properties, 'projectId'), false, `${fn.name} must not ask the model for projectId`);
    assert.equal(required.includes('projectId'), false, `${fn.name} must not require projectId`);
  }

  const tools = createWorkspaceTools({ db });
  const modelFunctions = tools.declarations.flatMap((group) => group.functionDeclarations || []);
  assert.ok(modelFunctions.every((fn) => !Object.hasOwn(fn.parameters?.properties || {}, 'projectId')));
});

test('Gemini tool results are passed back with matching call ids', async () => {
  const requests = [];
  const executed = [];
  const tools = {
    declarations: stripServerManagedProjectId(geminiToolDeclarations),
    async execute(name, args) {
      executed.push({ name, args });
      if (name === 'list_files') return { path: '.', entries: ['src/app.js'] };
      if (name === 'read_file') return { path: 'src/app.js', content: 'const broken = ;' };
      if (name === 'search_files') return { query: 'broken', results: [{ path: 'src/app.js', line: 1 }] };
      throw new Error(`Unexpected tool ${name}`);
    },
  };
  const calls = [
    { name: 'list_files', args: {}, id: 'call-list' },
    { name: 'read_file', args: { path: 'src/app.js' }, id: 'call-read' },
    { name: 'search_files', args: { query: 'broken' }, id: 'call-search' },
  ];
  const provider = createGeminiProvider({
    apiKey: 'test-key',
    model: 'test-model',
    cooldownStore: new Map(),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const index = requests.length - 1;
      if (index < calls.length) {
        return Response.json({
          candidates: [{ content: { role: 'model', parts: [{ functionCall: calls[index] }] } }],
        });
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'I found a syntax error at src/app.js:1.' }] } }],
      });
    },
  });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'Find errors in my code.' }],
    tools,
    projectId: 17,
  });

  assert.equal(requests.length, 4);
  assert.deepEqual(executed.map((call) => call.name), ['list_files', 'read_file', 'search_files']);
  assert.ok(executed.every((call) => call.args.projectId === 17), 'server owns the workspace id');
  assert.equal(requests[0].tools[0].functionDeclarations.length, 6);
  assert.equal(requests[0].tools[0].functionDeclarations[0].parameters.properties.projectId, undefined);
  for (let index = 0; index < calls.length; index += 1) {
    const responsePart = requests[index + 1].contents
      .flatMap((content) => content.parts || [])
      .map((part) => part.functionResponse)
      .filter(Boolean)
      .at(-1);
    assert.equal(responsePart.id, calls[index].id);
    assert.equal(responsePart.name, calls[index].name);
  }
  assert.match(result.text, /syntax error/);
  assert.deepEqual(result.toolActivity.map((item) => item.status), ['completed', 'completed', 'completed']);
});

test('OpenRouter fallback runs the same workspace tools with the coding prompt', async () => {
  const executed = [];
  const openAIRequests = [];
  const tools = {
    declarations: stripServerManagedProjectId(geminiToolDeclarations),
    async execute(name, args) {
      executed.push({ name, args });
      return { path: '.', entries: ['README.md', 'server/index.js'] };
    },
  };
  const primary = createGeminiProvider({
    apiKey: 'test-key',
    model: 'gemini-test',
    maxAttempts: 1,
    cooldownStore: new Map(),
    fetchImpl: async () => Response.json(
      { error: { message: 'rate limit exceeded', code: 'rate_limit_exceeded' } },
      { status: 429, headers: { 'retry-after': '1' } },
    ),
  });
  const fallback = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'openrouter-test-model',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      openAIRequests.push(body);
      if (openAIRequests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call-or-list',
                type: 'function',
                function: { name: 'list_files', arguments: '{}' },
              }],
            },
          }],
        });
      }
      return Response.json({
        model: 'openrouter-test-model',
        choices: [{ message: { content: 'Your workspace contains README.md and server/index.js.' } }],
      });
    },
  });
  const provider = createFallbackProvider({ primary, fallback, log: { warn() {} } });

  const result = await provider.chat({
    messages: [{ role: 'user', content: 'What files are in my workspace?' }],
    tools,
    projectId: 11,
  });

  assert.equal(result.fallback.from, 'gemini');
  assert.deepEqual(executed, [{ name: 'list_files', args: { projectId: 11 } }]);
  assert.equal(openAIRequests.length, 2);
  assert.match(openAIRequests[0].messages[0].content, /selected approved project workspace/i);
  assert.match(openAIRequests[0].messages[0].content, /cannot inspect the whole PC/i);
  assert.equal(openAIRequests[0].tools[0].function.parameters.properties.projectId, undefined);
  assert.equal(openAIRequests[1].messages.at(-1).role, 'tool');
  assert.match(result.text, /README\.md/);
});

test('unavailable tools produce honest capability statements on both adapters', async () => {
  const prompts = [];
  const openAI = createOpenAIProvider({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      prompts.push(JSON.parse(options.body).messages[0].content);
      return Response.json({ choices: [{ message: { content: 'I cannot inspect your PC.' } }] });
    },
  });
  await openAI.chat({ messages: [{ role: 'user', content: 'Check my PC.' }] });

  const gemini = createGeminiProvider({
    apiKey: 'test-key',
    cooldownStore: new Map(),
    fetchImpl: async (_url, options) => {
      prompts.push(JSON.parse(options.body).systemInstruction.parts[0].text);
      return Response.json({ candidates: [{ content: { parts: [{ text: 'I cannot inspect your PC.' }] } }] });
    },
  });
  await gemini.chat({ messages: [{ role: 'user', content: 'Check my PC.' }] });

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /no workspace tools/i);
  assert.match(prompts[0], /cannot inspect the whole PC/i);
  assert.match(prompts[0], /only inside an approved workspace/i);
  assert.match(prompts[1], /cannot inspect the whole PC/i);
  assert.match(prompts[1], /only that approved workspace/i);
});

test('restricted workspace actions stay staged and whole-PC paths stay unavailable', async () => {
  const project = makeProject('workspace-safety');
  const tools = createWorkspaceTools({ db });
  try {
    fs.writeFileSync(path.join(project.root, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));

    const stagedFile = await tools.execute('create_file', {
      projectId: project.id,
      path: 'notes.txt',
      content: 'safe\n',
    });
    assert.equal(stagedFile.status, 'awaiting_user_approval');
    assert.equal(fs.existsSync(path.join(project.root, 'notes.txt')), false);

    const stagedCommand = await tools.execute('run_command', {
      projectId: project.id,
      command: 'npm_test',
    });
    assert.equal(stagedCommand.status, 'awaiting_user_approval');

    await assert.rejects(
      tools.execute('run_command', { projectId: project.id, command: 'powershell -Command whoami' }),
      /allowlist/,
    );
    await assert.rejects(
      tools.execute('read_file', { projectId: project.id, path: '../../.env' }),
      /escapes|relative/,
    );
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('web client keeps the workspace signal and hides workspace starters without a project', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), '..', 'apps', 'web', 'src', 'App.jsx'),
    'utf8',
  );
  assert.match(source, /workspace: result\.workspace \|\| null/);
  assert.match(source, /workspaceStatusMessage\(message\.workspace\)/);
  assert.match(source, /\(activeProject \? starters : \[\]\)/);
});

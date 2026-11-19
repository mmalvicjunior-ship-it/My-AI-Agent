// Stage 3: the background task executor is read-only.
//
// These tests exercise the real task runner, the real workspace tools and the
// real OpenAI-compatible adapter (with a stubbed fetch), against the isolated
// temporary database/workspace provided by tests/setup-test-env.mjs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db/index.js';
import { createWorkspaceTools } from '../src/ai/tools.js';
import { createOpenAIProvider } from '../src/ai/openai.js';
import { createTaskRunner } from '../src/tasks/runner.js';
import { createTaskExecutor } from '../src/tasks/executor.js';
import {
  appendStep,
  createTask,
  getTask,
  listSteps,
  loadPlan,
  requestCancel,
  savePlan,
} from '../src/tasks/store.js';

const db = openDb();
const silentLogger = { info() {}, error() {} };
const runners = [];
const tempRoots = [];

function makeProject(prefix = 'task-executor') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempRoots.push(root);
  const inserted = db
    .prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
    .run(prefix, root);
  return { id: Number(inserted.lastInsertRowid), root };
}

function makeProvider(chat, overrides = {}) {
  return {
    name: 'fake',
    model: 'fake-1',
    supportsTools: true,
    chat,
    ...overrides,
  };
}

function makePlanProvider(plan) {
  let calls = 0;
  return makeProvider(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        text: JSON.stringify({ summary: 'Inspected workspace.', needsChanges: true }),
        provider: 'fake',
        model: 'fake-1',
      };
    }
    return { text: JSON.stringify(plan), provider: 'fake', model: 'fake-1' };
  });
}

function makeExecutor(provider, options = {}) {
  return createTaskExecutor({
    db,
    provider,
    tools: createWorkspaceTools({ db }),
    logger: silentLogger,
    retryDelaysMs: [0, 0],
    ...options,
  });
}

function makeRunner(executor, options = {}) {
  const runner = createTaskRunner({
    db,
    executor,
    logger: silentLogger,
    cancelPollMs: 10,
    pollIntervalMs: 10,
    ...options,
  });
  runners.push(runner);
  return runner;
}

function proposalCount(projectId) {
  return db.prepare('SELECT COUNT(*) AS c FROM proposals WHERE project_id = ?').get(projectId).c;
}

beforeEach(() => {
  db.exec('DELETE FROM task_steps; DELETE FROM tasks; DELETE FROM proposals;');
});

afterEach(() => {
  for (const runner of runners.splice(0)) runner.stop();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runs a read-only task, records tool progress and stores the result', async () => {
  const project = makeProject();
  const sentinel = 'SECRET_SENTINEL_FILE_CONTENT';
  fs.mkdirSync(path.join(project.root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(project.root, 'src', 'app.js'),
    `export const hello = "${sentinel}";\n`,
  );

  let listed;
  let read;
  let searched;
  let declarationNames;
  const provider = makeProvider(async ({ tools, projectId }) => {
    declarationNames = tools.declarations
      .flatMap((group) => group.functionDeclarations.map((declaration) => declaration.name))
      .sort();
    listed = await tools.execute('list_files', { projectId });
    read = await tools.execute('read_file', { projectId, path: 'src/app.js' });
    searched = await tools.execute('search_files', { projectId, query: 'hello' });
    return { text: 'Found the greeting in src/app.js.', provider: 'fake', model: 'fake-1' };
  });

  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Find the greeting and summarise it.',
    autonomy: 'propose',
  });
  const runner = makeRunner(makeExecutor(provider));
  const result = await runner.tick();

  assert.equal(result.status, 'completed');
  assert.equal(result.error, null);
  assert.equal(result.last_step, 'Result ready');

  assert.deepEqual(declarationNames, ['list_files', 'read_file', 'search_files']);
  assert.ok(listed.files.includes('src/app.js'));
  assert.match(read.content, /SECRET_SENTINEL_FILE_CONTENT/);
  assert.ok(searched.results.length >= 1);

  const steps = listSteps(db, task.id);
  const title = (value) => steps.some((step) => step.title === value);
  assert.ok(title('Agent started'));
  assert.ok(title('Listed .'));
  assert.ok(title('Read src/app.js'));
  assert.ok(title('Searched for "hello"'));
  assert.ok(title('Result ready'));
  assert.ok(steps.every((step) => !String(step.detail || '').includes(sentinel)),
    'file contents must never be copied into task steps');

  const resultStep = steps.find((step) => step.kind === 'result');
  assert.match(resultStep.detail, /Found the greeting/);
  assert.equal(proposalCount(project.id), 0);
  assert.deepEqual(fs.readdirSync(project.root).sort(), ['src']);
  assert.deepEqual(fs.readdirSync(path.join(project.root, 'src')), ['app.js']);
});

test('refuses create_file, propose_file_change and run_command without side effects', async () => {
  const project = makeProject();
  fs.writeFileSync(path.join(project.root, 'app.js'), 'export const value = 1;\n');

  const refusals = [];
  const provider = makeProvider(async ({ tools, projectId }) => {
    const attempts = [
      ['create_file', { path: 'evil.js', content: 'export const evil = true;\n' }],
      ['propose_file_change', { path: 'app.js', content: 'export const value = 2;\n' }],
      ['run_command', { command: 'npm_test' }],
    ];
    for (const [name, args] of attempts) {
      try {
        await tools.execute(name, { projectId, ...args });
        refusals.push({ name, status: 200 });
      } catch (error) {
        refusals.push({ name, status: error.status, message: error.message });
      }
    }
    return { text: 'I could not change anything in read-only mode.', provider: 'fake', model: 'fake-1' };
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Change the app.' });
  const result = await makeRunner(makeExecutor(provider)).tick();

  assert.equal(result.status, 'completed');
  assert.deepEqual(refusals.map((entry) => entry.status), [403, 403, 403]);
  assert.ok(refusals.every((entry) => /read-only/i.test(entry.message)));
  assert.equal(fs.existsSync(path.join(project.root, 'evil.js')), false);
  assert.equal(fs.readFileSync(path.join(project.root, 'app.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(proposalCount(project.id), 0, 'refused tools must not stage proposals');

  const steps = listSteps(db, task.id);
  assert.ok(steps.some((step) => step.title === 'Refused create_file' && step.status === 'failed'));
  assert.ok(steps.some((step) => step.title === 'Refused propose_file_change' && step.status === 'failed'));
  assert.ok(steps.some((step) => step.title === 'Refused run_command' && step.status === 'failed'));
});

test('fails honestly before calling a provider that cannot use workspace tools', async () => {
  const project = makeProject();
  let called = false;
  const provider = makeProvider(async () => {
    called = true;
    return { text: 'should not run' };
  }, { name: 'mock', supportsTools: false, model: 'offline' });

  const task = createTask(db, { projectId: project.id, instruction: 'Inspect the project.' });
  const result = await makeRunner(makeExecutor(provider)).tick();

  assert.equal(called, false);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /does not support workspace tools/);
  assert.equal(listSteps(db, task.id).some((step) => step.kind === 'result'), false);
});

test('retries a rate limit once and completes', async () => {
  const project = makeProject();
  let attempts = 0;
  const provider = makeProvider(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('rate limited');
      error.statusCode = 429;
      error.publicMessage = 'Provider rate limit was reached.';
      error.retryAfterMs = 0;
      throw error;
    }
    return { text: 'Recovered after the retry.', provider: 'fake', model: 'fake-1' };
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Summarise the project.' });
  const result = await makeRunner(makeExecutor(provider)).tick();

  assert.equal(result.status, 'completed');
  assert.equal(attempts, 2);
  const steps = listSteps(db, task.id);
  const retry = steps.find((step) => step.title === 'Retrying provider (2/3)');
  assert.ok(retry);
  assert.match(retry.detail, /rate limit/i);
  assert.equal(steps.find((step) => step.kind === 'result').title, 'Result ready');
});

test('stops after three attempts and reports the rate limit honestly', async () => {
  const project = makeProject();
  let attempts = 0;
  const provider = makeProvider(async () => {
    attempts += 1;
    const error = new Error('rate limited');
    error.statusCode = 429;
    error.publicMessage = 'Provider rate limit was reached.';
    throw error;
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Summarise the project.' });
  const result = await makeRunner(makeExecutor(provider)).tick();

  assert.equal(attempts, 3);
  assert.equal(result.status, 'provider_paused');
  assert.match(result.error, /rate limit/i);
  assert.match(result.error, /after 3 attempts/);
  const retrySteps = listSteps(db, task.id)
    .filter((step) => /^Retrying provider/.test(step.title));
  assert.equal(retrySteps.length, 2);
  assert.equal(listSteps(db, task.id).some((step) => step.kind === 'result'), false);
});

test('does not retry a non-transient provider error', async () => {
  const project = makeProject();
  let attempts = 0;
  const provider = makeProvider(async () => {
    attempts += 1;
    const error = new Error('unauthorised');
    error.statusCode = 401;
    error.publicMessage = 'The provider rejected the API key.';
    throw error;
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Inspect the project.' });
  const result = await makeRunner(makeExecutor(provider)).tick();

  assert.equal(attempts, 1);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /rejected the API key/);
  assert.equal(listSteps(db, task.id).some((step) => /^Retrying provider/.test(step.title)), false);
});

test('cancellation aborts the in-flight provider call and records cancelled', async () => {
  const project = makeProject();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let abortObserved = false;

  const provider = makeProvider(({ signal }) => {
    markStarted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        abortObserved = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Wait for a slow provider.' });
  const runner = makeRunner(makeExecutor(provider));
  const running = runner.tick();
  await started;

  const { accepted } = requestCancel(db, getTask(db, task.id));
  assert.equal(accepted, true);

  const result = await running;
  assert.equal(abortObserved, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error, null);
  assert.equal(listSteps(db, task.id).some((step) => step.kind === 'result'), false);
});

test('the real OpenAI adapter gets only read tools and records progress', async () => {
  const project = makeProject();
  fs.writeFileSync(path.join(project.root, 'notes.txt'), 'hello from the notes\n');

  const bodies = [];
  let calls = 0;
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        model: 'stub-model',
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'search_files', arguments: JSON.stringify({ query: 'hello' }) },
            }],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      model: 'stub-model',
      choices: [{ message: { content: 'Found one match in notes.txt.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'stub-model',
    baseUrl: 'https://stub.example/v1',
    fetchImpl,
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Find hello.' });
  const result = await makeRunner(makeExecutor(provider)).tick();

  assert.equal(result.status, 'completed');
  assert.equal(calls, 2);
  assert.deepEqual(
    (bodies[0].tools || []).map((tool) => tool.function.name).sort(),
    ['list_files', 'read_file', 'search_files'],
  );
  const steps = listSteps(db, task.id);
  const searchStep = steps.find((step) => step.title === 'Searched for "hello"');
  assert.ok(searchStep);
  assert.match(searchStep.detail, /1 match/);
  assert.deepEqual(steps.find((step) => step.kind === 'result').detail, 'Found one match in notes.txt.');
});

test('the real OpenAI adapter request aborts when the task is cancelled', async () => {
  const project = makeProject();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let abortObserved = false;

  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      abortObserved = true;
      reject(init.signal.reason ?? new Error('aborted'));
    }, { once: true });
    markStarted();
  });

  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'stub-model',
    baseUrl: 'https://stub.example/v1',
    fetchImpl,
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Wait for the provider.' });
  const runner = makeRunner(makeExecutor(provider));
  const running = runner.tick();
  await started;

  requestCancel(db, getTask(db, task.id));
  const result = await running;

  assert.equal(abortObserved, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(listSteps(db, task.id).some((step) => step.kind === 'result'), false);
});

test('a model-supplied projectId cannot read another project', async () => {
  const owner = makeProject('task-owner');
  const foreign = makeProject('task-foreign');
  fs.writeFileSync(path.join(foreign.root, 'foreign.txt'), 'FOREIGN_SECRET_CONTENT\n');

  let failure = null;
  const provider = makeProvider(async ({ tools }) => {
    try {
      await tools.execute('read_file', { projectId: foreign.id, path: 'foreign.txt' });
    } catch (error) {
      failure = error.message;
    }
    return { text: 'I could not access that file.', provider: 'fake', model: 'fake-1' };
  });

  const task = createTask(db, { projectId: owner.id, instruction: 'Read the other project.' });
  const result = await makeRunner(makeExecutor(provider)).tick();

  assert.equal(result.status, 'completed');
  assert.ok(failure);
  assert.match(failure, /not found/i);
  assert.equal(fs.existsSync(path.join(owner.root, 'foreign.txt')), false);
  const steps = listSteps(db, task.id);
  assert.ok(steps.every((step) => !String(step.detail || '').includes('FOREIGN_SECRET_CONTENT')));
});

test('refreshes saved plan progress during finalize without a ReferenceError', async () => {
  const project = makeProject('plan-progress');
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Continue planned work.',
    autonomy: 'propose',
  });
  savePlan(db, task.id, {
    version: 1,
    summary: 'Continue a three-step plan',
    steps: [
      { tool: 'read_file', path: 'one.js', goal: 'one' },
      { tool: 'read_file', path: 'two.js', goal: 'two' },
      { tool: 'read_file', path: 'three.js', goal: 'three' },
    ],
    currentStep: 0,
    repairAttempt: 0,
    proposals: [],
  });

  let providerCalls = 0;
  const provider = makeProvider(async () => {
    providerCalls += 1;
    return { text: 'The provider should not be called during finalize.' };
  });

  const result = await makeExecutor(provider)({
    task,
    addStep: (step) => appendStep(db, task.id, step),
    phase: 'finalize',
  });

  assert.equal(providerCalls, 0);
  assert.equal(result.status, 'waiting_approval');

  const saved = loadPlan(db, task.id);
  assert.equal(saved.currentStep, 1);
  assert.equal(saved.repairAttempt, 0);
  assert.equal(saved.summary, 'Continue a three-step plan');
  assert.equal(saved.steps.length, 3);

  const steps = listSteps(db, task.id);
  assert.equal(steps.some((step) => step.title === 'Run failed'), false);
  const continuation = steps.find((step) => step.title === 'Continuation');
  assert.ok(continuation);
  assert.equal(continuation.status, 'done');
  assert.match(continuation.detail, /Plan step 2 of 3/);
  const resultStep = steps.find((step) => step.kind === 'result');
  assert.ok(resultStep);
  assert.equal(resultStep.status, 'done');
});

test('finalizes a completed plan when no steps or repair attempts remain', async () => {
  const project = makeProject('plan-complete');
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Finish planned work.',
    autonomy: 'propose',
  });
  savePlan(db, task.id, {
    version: 1,
    summary: 'Completed plan',
    steps: [{ tool: 'read_file', path: 'only.js', goal: 'only' }],
    currentStep: 0,
    repairAttempt: 3,
    proposals: [],
  });

  let providerCalls = 0;
  const provider = makeProvider(async () => {
    providerCalls += 1;
    return { text: 'The provider should not be called during finalize.' };
  });

  const result = await makeExecutor(provider)({
    task,
    addStep: (step) => appendStep(db, task.id, step),
    phase: 'finalize',
  });

  assert.equal(providerCalls, 0);
  assert.equal(result.status, 'completed');
  assert.equal(result.error, null);

  const saved = loadPlan(db, task.id);
  assert.equal(saved.currentStep, 0);
  assert.equal(saved.repairAttempt, 3);

  const steps = listSteps(db, task.id);
  assert.ok(steps.some((step) => step.kind === 'result' && step.title === 'Result ready'));
  assert.equal(steps.some((step) => step.title === 'Continuation'), false);
});

test('reports finalize failures honestly without claiming completion', async () => {
  const project = makeProject('plan-failure');
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Finish planned work with a staging failure.',
    autonomy: 'propose',
  });
  savePlan(db, task.id, {
    version: 1,
    summary: 'Plan with a staging failure',
    steps: [{ tool: 'read_file', path: 'only.js', goal: 'only' }],
    currentStep: 0,
    repairAttempt: 3,
    proposals: [],
    stagingFailures: ['File change src/missing.js could not be staged: blocked by guard'],
  });

  let providerCalls = 0;
  const provider = makeProvider(async () => {
    providerCalls += 1;
    return { text: 'The provider should not be called during finalize.' };
  });

  const result = await makeExecutor(provider)({
    task,
    addStep: (step) => appendStep(db, task.id, step),
    phase: 'finalize',
  });

  assert.equal(providerCalls, 0);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /One or more proposed steps were rejected, failed, or had an unknown outcome/);

  const steps = listSteps(db, task.id);
  const resultStep = steps.find((step) => step.kind === 'result');
  assert.ok(resultStep);
  assert.match(resultStep.detail, /^Task incomplete\./);
  assert.match(resultStep.detail, /blocked by guard/);
  assert.equal(steps.some((step) => step.title === 'Continuation'), false);
});

test('autonomous task leaves a staged file create pending and unapplied', async () => {
  const project = makeProject('phase2-create');
  const provider = makePlanProvider({
    summary: 'Create a new file',
    changes: [{
      kind: 'create',
      path: 'created-by-task.js',
      content: 'export const value = 1;\n',
      goal: 'create file',
    }],
    commands: [],
  });
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Create created-by-task.js.',
    autonomy: 'approved_autonomous',
    autonomous: true,
  });
  const steps = [];

  const result = await makeExecutor(provider)({
    task,
    addStep: (step) => steps.push(step),
    phase: 'plan',
  });

  assert.equal(result.status, 'waiting_approval');
  assert.equal(proposalCount(project.id), 1);
  const proposal = db
    .prepare('SELECT kind, status, path FROM proposals WHERE project_id = ?')
    .get(project.id);
  assert.equal(proposal.kind, 'create');
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.path, 'created-by-task.js');
  assert.equal(fs.existsSync(path.join(project.root, 'created-by-task.js')), false);
  assert.equal(steps.some((step) => step.title === 'Auto-applied proposal'), false);
  assert.ok(steps.some((step) => step.title === 'Waiting for approval'));
});

test('autonomous task leaves a staged file edit pending and does not modify the file', async () => {
  const project = makeProject('phase2-edit');
  const original = 'export const value = 0;\n';
  fs.writeFileSync(path.join(project.root, 'existing.js'), original);
  const provider = makePlanProvider({
    summary: 'Edit an existing file',
    changes: [{
      kind: 'update',
      path: 'existing.js',
      content: 'export const value = 1;\n',
      goal: 'update value',
    }],
    commands: [],
  });
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Update existing.js.',
    autonomy: 'allow_writes_and_commands',
    autonomous: true,
  });
  const steps = [];

  const result = await makeExecutor(provider)({
    task,
    addStep: (step) => steps.push(step),
    phase: 'plan',
  });

  assert.equal(result.status, 'waiting_approval');
  const proposal = db
    .prepare('SELECT kind, status FROM proposals WHERE project_id = ?')
    .get(project.id);
  assert.equal(proposal.kind, 'update');
  assert.equal(proposal.status, 'pending');
  assert.equal(fs.readFileSync(path.join(project.root, 'existing.js'), 'utf8'), original);
  assert.equal(steps.some((step) => step.title === 'Auto-applied proposal'), false);
});

test('autonomous task leaves a staged command pending and does not execute it', async () => {
  const project = makeProject('phase2-command');
  fs.writeFileSync(path.join(project.root, 'marker.js'), "require('fs').writeFileSync('WAS_EXECUTED', 'yes');\n");
  fs.writeFileSync(
    path.join(project.root, 'package.json'),
    `${JSON.stringify({ scripts: { test: 'node marker.js' } }, null, 2)}\n`,
  );
  const provider = makePlanProvider({
    summary: 'Run the project tests',
    changes: [],
    commands: [{ command: 'npm_test', goal: 'verify the change' }],
  });
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Run the tests.',
    autonomy: 'approved_autonomous',
    autonomous: true,
  });
  const steps = [];

  const result = await makeExecutor(provider)({
    task,
    addStep: (step) => steps.push(step),
    phase: 'plan',
  });

  assert.equal(result.status, 'waiting_approval');
  const proposal = db
    .prepare('SELECT kind, status, result_json FROM proposals WHERE project_id = ?')
    .get(project.id);
  assert.equal(proposal.kind, 'command');
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.result_json, null);
  assert.equal(fs.existsSync(path.join(project.root, 'WAS_EXECUTED')), false);
  assert.equal(steps.some((step) => step.title === 'Auto-applied proposal'), false);
});

test('autonomous tasks still receive only the read-only provider tool surface', async () => {
  const project = makeProject('phase2-readonly');
  fs.writeFileSync(path.join(project.root, 'file.js'), 'export const value = 1;\n');
  let declarationNames = [];
  let refusedError = null;
  const provider = makeProvider(async ({ tools, projectId }) => {
    declarationNames = tools.declarations
      .flatMap((group) => group.functionDeclarations.map((declaration) => declaration.name))
      .sort();
    try {
      await tools.execute('create_file', {
        projectId,
        path: 'blocked.js',
        content: 'This must never be staged by a direct tool call.',
      });
    } catch (error) {
      refusedError = error;
    }
    return {
      text: 'Read-only inspection complete.',
      provider: 'fake',
      model: 'fake-1',
    };
  });
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Inspect the project.',
    autonomy: 'approved_autonomous',
    autonomous: true,
  });
  const steps = [];

  const result = await makeExecutor(provider)({
    task,
    addStep: (step) => steps.push(step),
    phase: 'plan',
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(declarationNames, ['list_files', 'read_file', 'search_files']);
  assert.equal(refusedError?.status, 403);
  assert.equal(fs.existsSync(path.join(project.root, 'blocked.js')), false);
  assert.equal(proposalCount(project.id), 0);
  assert.ok(steps.some((step) => step.title === 'Refused create_file'));
});

test('empty recovery-only plan does not strand a paused task in waiting_approval', async () => {
  const project = makeProject('empty-recovery');
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Resume after the provider quota reset.',
    autonomy: 'propose',
  });
  savePlan(db, task.id, {
    version: 1,
    summary: 'Provider paused before planning',
    steps: [],
    currentStep: 0,
    repairAttempt: 0,
    proposals: [],
  });
  db.prepare("UPDATE tasks SET status = 'provider_paused', error = ? WHERE id = ?")
    .run('Rate limit exceeded: free-models-per-day.', task.id);

  let providerCalls = 0;
  const provider = makeProvider(async () => {
    providerCalls += 1;
    return {
      text: JSON.stringify({ summary: 'Nothing to change after recovery.', needsChanges: false }),
      provider: 'fake',
      model: 'fake-1',
    };
  });

  const result = await makeExecutor(provider)({
    task: getTask(db, task.id),
    addStep: (step) => appendStep(db, task.id, step),
    phase: 'continue',
  });

  assert.equal(providerCalls, 1, 'recovery should re-plan instead of finalizing empty metadata');
  assert.equal(result.status, 'completed');
  assert.notEqual(result.status, 'waiting_approval');
  const steps = listSteps(db, task.id);
  assert.equal(steps.some((step) => step.title === 'Continuation'), false);
});

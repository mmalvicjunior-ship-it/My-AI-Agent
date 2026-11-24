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
import { DatabaseSync } from 'node:sqlite';

import { openDb } from '../src/db/index.js';
import { consumeProviderAttempt, normalizeRetryState } from '../src/ai/retry-policy.js';
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
  const { db: executorDb = db, ...rest } = options;
  return createTaskExecutor({
    db: executorDb,
    provider,
    tools: createWorkspaceTools({ db: executorDb }),
    logger: silentLogger,
    retryDelaysMs: [0, 0],
    ...rest,
  });
}

function makeRunner(executor, options = {}) {
  const { db: runnerDb = db, ...rest } = options;
  const runner = createTaskRunner({
    db: runnerDb,
    executor,
    logger: silentLogger,
    cancelPollMs: 10,
    pollIntervalMs: 10,
    ...rest,
  });
  runners.push(runner);
  return runner;
}

/** Isolated SQLite queue for tests that must not observe other top-level tests. */
function makeIsolatedDb() {
  const localDb = new DatabaseSync(':memory:');
  localDb.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      root_path TEXT,
      owner_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      autonomy TEXT NOT NULL DEFAULT 'propose',
      autonomous INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      last_step TEXT,
      error TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      plan_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE task_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      path TEXT,
      content TEXT,
      original_content TEXT,
      diff TEXT,
      command TEXT,
      command_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
  `);
  return localDb;
}

function makeLocalProject(localDb, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempRoots.push(root);
  const inserted = localDb
    .prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
    .run(prefix, root);
  return { id: Number(inserted.lastInsertRowid), root };
}

function proposalCount(projectId) {
  return db.prepare('SELECT COUNT(*) AS c FROM proposals WHERE project_id = ?').get(projectId).c;
}

/** Deterministically expire a persisted recovery schedule without sleeping. */
function makeRecoveryReady(taskId) {
  makeRecoveryReadyIn(db, taskId);
}

function makeRecoveryReadyIn(localDb, taskId) {
  const plan = loadPlan(localDb, taskId);
  assert.ok(plan?.recovery?.nextRetryAt, 'the task must have a persisted retry time');
  plan.recovery.nextRetryAt = new Date(Date.now() - 1).toISOString();
  savePlan(localDb, taskId, plan);
}

function transientProviderError({
  statusCode = 429,
  category = 'RATE_LIMITED',
  publicMessage = 'Provider rate limit was reached.',
  retryAfterMs,
  attemptsUsed = 1,
  toolActivity,
} = {}) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.category = category;
  error.publicMessage = publicMessage;
  error.retryable = true;
  error.fallbackEligible = false;
  error.retryState = {
    attemptsUsed,
    exhausted: attemptsUsed >= 5,
  };
  if (retryAfterMs !== undefined) {
    error.retryAfterMs = retryAfterMs;
    error.retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
  }
  if (toolActivity) error.toolActivity = toolActivity;
  return error;
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

test('a 429 with a long Retry-After pauses and resumes after the scheduled time', async () => {
  const project = makeProject();
  let calls = 0;
  const provider = makeProvider(async ({ retryState }) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(retryState.attemptsUsed, 0);
      throw transientProviderError({
        publicMessage: 'Provider rate limit was reached.',
        retryAfterMs: 120_000,
      });
    }
    assert.equal(retryState.attemptsUsed, 1, 'the resumed task must reload the persisted budget');
    return {
      text: JSON.stringify({ summary: 'Recovered after the scheduled retry.', needsChanges: false }),
      provider: 'fake',
      model: 'fake-1',
      retryState: { attemptsUsed: 2, exhausted: false },
    };
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Summarise the project.' });
  const runner = makeRunner(makeExecutor(provider));

  const paused = await runner.tick();
  assert.equal(paused.status, 'provider_paused');
  assert.equal(calls, 1, 'the long cooldown must not be spent in-process');

  const recovery = loadPlan(db, task.id).recovery;
  assert.equal(recovery.reason, 'provider_rate_limited');
  assert.equal(recovery.category, 'RATE_LIMITED');
  assert.equal(recovery.retryAttempt, 1);
  assert.deepEqual(recovery.retryState, { attemptsUsed: 1, exhausted: false });
  const scheduledMs = new Date(recovery.nextRetryAt).getTime() - Date.now();
  assert.ok(
    scheduledMs > 118_000 && scheduledMs <= 126_000,
    `the original 120s Retry-After must be persisted (got ${scheduledMs}ms)`,
  );
  assert.equal(await runner.tick(), null, 'the task must not resume before its retry time');

  makeRecoveryReady(task.id);
  const resumed = await runner.tick();
  assert.equal(resumed.status, 'completed');
  assert.equal(calls, 2);
  const steps = listSteps(db, task.id);
  assert.equal(steps.some((step) => /^Retrying provider/.test(step.title)), false);
  assert.ok(steps.some((step) => step.title === 'Provider rate limited'));
  assert.equal(steps.find((step) => step.kind === 'result').title, 'Result ready');
});

test('persistent 503 failures follow bounded recovery and terminate at the limit', async () => {
  const project = makeProject();
  const seenAttempts = [];
  const provider = makeProvider(async ({ retryState }) => {
    const attemptsUsed = (retryState?.attemptsUsed ?? 0) + 1;
    seenAttempts.push(attemptsUsed);
    throw transientProviderError({
      statusCode: 503,
      category: 'CAPACITY_UNAVAILABLE',
      publicMessage: 'Provider is temporarily at capacity.',
      attemptsUsed,
    });
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Summarise the project.' });
  const runner = makeRunner(makeExecutor(provider));

  for (let expected = 1; expected <= 4; expected += 1) {
    const paused = await runner.tick();
    assert.equal(paused.status, 'provider_paused');
    assert.equal(loadPlan(db, task.id).recovery.retryAttempt, expected);
    makeRecoveryReady(task.id);
  }

  const failed = await runner.tick();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /recovery reached its limit/i);
  assert.deepEqual(seenAttempts, [1, 2, 3, 4, 5]);
  const recovery = loadPlan(db, task.id).recovery;
  assert.equal(recovery.reason, 'provider_recovery_exhausted');
  assert.equal(recovery.retryAttempt, 5);
  assert.equal(recovery.terminal, true);
  assert.equal(await runner.tick(), null);
  assert.equal(seenAttempts.length, 5, 'a failed task must never be retried again');
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

test('quota exhaustion terminates without repeated provider requests', async () => {
  const project = makeProject();
  let calls = 0;
  const provider = makeProvider(async () => {
    calls += 1;
    const error = new Error('quota reached');
    error.statusCode = 429;
    error.category = 'QUOTA_EXHAUSTED';
    error.publicMessage = 'OpenRouter daily quota reached.';
    error.retryable = false;
    error.fallbackEligible = false;
    error.retryState = { attemptsUsed: 1, exhausted: false };
    throw error;
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Inspect the project.' });
  const runner = makeRunner(makeExecutor(provider));

  const failed = await runner.tick();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /quota is exhausted/i);
  assert.equal(calls, 1);
  const recovery = loadPlan(db, task.id).recovery;
  assert.equal(recovery.reason, 'provider_quota_exhausted');
  assert.equal(recovery.terminal, true);
  assert.equal(recovery.nextRetryAt, undefined);

  assert.equal(await runner.tick(), null);
  assert.equal(calls, 1, 'quota exhaustion must not burn more requests');
});

test('a failure after read-only tool activity does not re-run the tool', async () => {
  const project = makeProject();
  let providerCalls = 0;
  let toolCalls = 0;
  const tools = {
    declarations: [],
    async execute(name) {
      toolCalls += 1;
      assert.equal(name, 'list_files');
      return [{ path: 'src/app.js' }];
    },
  };
  const provider = makeProvider(async ({ tools: activeTools }) => {
    providerCalls += 1;
    await activeTools.execute('list_files', {});
    throw transientProviderError({
      statusCode: 503,
      category: 'CAPACITY_UNAVAILABLE',
      publicMessage: 'Provider failed after tool execution.',
      toolActivity: [{ tool: 'list_files', status: 'completed' }],
    });
  });

  const task = createTask(db, { projectId: project.id, instruction: 'Inspect the project.' });
  const failed = await makeRunner(makeExecutor(provider, { tools })).tick();

  assert.equal(failed.status, 'failed');
  assert.equal(providerCalls, 1);
  assert.equal(toolCalls, 1, 'the read-only tool must never execute twice for one task');
  assert.equal(listSteps(db, task.id).filter((step) => step.kind === 'tool').length, 1);
  assert.equal(loadPlan(db, task.id)?.recovery?.nextRetryAt, undefined);
});

test('a resumed ordered plan keeps completed steps and does not stage duplicates', async () => {
  const project = makeProject();
  const proposalId = 'resume-completed-step';
  db.prepare(
    `INSERT INTO proposals (id, project_id, kind, path, status) VALUES (?, ?, 'create', ?, 'applied')`,
  ).run(proposalId, project.id, 'src/first.js');

  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Continue the saved plan.',
    autonomy: 'propose',
  });
  savePlan(db, task.id, {
    version: 1,
    summary: 'Two-step ordered plan',
    mode: 'ordered',
    steps: [
      { tool: 'create_file', path: 'src/first.js', content: 'first' },
      { tool: 'create_file', path: 'src/second.js', content: 'second' },
    ],
    currentStep: 1,
    repairAttempt: 0,
    currentProposalId: proposalId,
    proposals: [{ id: proposalId }],
    recovery: {
      reason: 'provider_rate_limited',
      category: 'RATE_LIMITED',
      retryAttempt: 2,
      retryState: { attemptsUsed: 2, exhausted: false },
      nextRetryAt: new Date(Date.now() - 1).toISOString(),
    },
  });
  db.prepare("UPDATE tasks SET status = 'provider_paused', error = ? WHERE id = ?")
    .run('Rate limit reached.', task.id);

  let providerCalls = 0;
  const provider = makeProvider(async () => {
    providerCalls += 1;
    return { text: 'should not be called', provider: 'fake', model: 'fake-1' };
  });

  const resumed = await makeRunner(makeExecutor(provider)).tick();
  assert.equal(resumed.status, 'completed');
  assert.equal(providerCalls, 0, 'a saved ordered plan must resume from storage, not re-plan');
  assert.equal(proposalCount(project.id), 1, 'a completed step must not be staged again');
  const plan = loadPlan(db, task.id);
  assert.equal(plan.currentStep, 2);
  assert.deepEqual(plan.proposals, [{ id: proposalId }]);
});

test('multiple eligible tasks progress independently', async () => {
  const project = makeProject();
  const states = new Map([
    ['First task', { calls: 0 }],
    ['Second task', { calls: 0 }],
  ]);
  const provider = makeProvider(async ({ messages }) => {
    const instruction = messages.find((message) => message.role === 'user')?.content;
    const state = states.get(instruction);
    assert.ok(state, `unexpected task instruction: ${instruction}`);
    state.calls += 1;
    if (state.calls === 1) {
      throw transientProviderError({ retryAfterMs: 120_000 });
    }
    return {
      text: JSON.stringify({ summary: 'Done.', needsChanges: false }),
      provider: 'fake',
      model: 'fake-1',
    };
  });
  const runner = makeRunner(makeExecutor(provider));

  const first = createTask(db, { projectId: project.id, instruction: 'First task' });
  const second = createTask(db, { projectId: project.id, instruction: 'Second task' });

  assert.equal((await runner.tick()).status, 'provider_paused');
  assert.equal((await runner.tick()).status, 'provider_paused');
  assert.equal(getTask(db, first.id).status, 'provider_paused');
  assert.equal(getTask(db, second.id).status, 'provider_paused');

  makeRecoveryReady(second.id);
  const secondResult = await runner.tick();
  assert.equal(secondResult.id, second.id);
  assert.equal(secondResult.status, 'completed');
  assert.equal(getTask(db, first.id).status, 'provider_paused');

  makeRecoveryReady(first.id);
  const firstResult = await runner.tick();
  assert.equal(firstResult.id, first.id);
  assert.equal(firstResult.status, 'completed');
  assert.deepEqual([...states.values()].map((state) => state.calls), [2, 2]);
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

test('cancellation during staging discards the staged proposal', async () => {
  const project = makeProject('cancel-staging');
  const provider = makePlanProvider({
    summary: 'Create a file',
    changes: [{ kind: 'create', path: 'cancel-me.js', content: 'export const x = 1;\n', goal: 'create' }],
    commands: [],
  });
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Create cancel-me.js.',
    autonomy: 'approved_autonomous',
    autonomous: true,
  });
  const controller = new AbortController();

  const tools = createWorkspaceTools({ db });
  const originalStageFileChange = tools.stageFileChange;
  tools.stageFileChange = async (...args) => {
    const proposal = await originalStageFileChange(...args);
    controller.abort();
    return proposal;
  };
  const executor = createTaskExecutor({
    db,
    provider,
    tools,
    logger: silentLogger,
    retryDelaysMs: [0, 0],
  });

  await assert.rejects(
    executor({ task, signal: controller.signal, addStep: () => {}, phase: 'plan' }),
    /cancelled/i,
  );

  const proposal = db
    .prepare('SELECT status FROM proposals WHERE project_id = ?')
    .get(project.id);
  assert.ok(proposal, 'a proposal was staged');
  assert.equal(proposal.status, 'rejected', 'staged proposal must be discarded on cancellation');
  assert.equal(fs.existsSync(path.join(project.root, 'cancel-me.js')), false);
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

test('offline end-to-end: real adapter tool rounds run through executor, runner and SQLite', async () => {
  const localDb = makeIsolatedDb();
  const project = makeLocalProject(localDb, 'e2e-tools');
  fs.mkdirSync(path.join(project.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project.root, 'src', 'app.js'), 'export const value = 1;\n');

  let calls = 0;
  let toolExecutions = 0;
  let lastResult;
  const realProvider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/e2e-tools:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore: new Map(),
    retryDelaysMs: [0],
    jitterMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'e2e-call-1',
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
      if (calls === 2) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'e2e-call-2',
                type: 'function',
                function: {
                  name: 'list_files',
                  arguments: JSON.stringify({ path: '.' }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({ summary: 'Inspected app.js and the project root.', needsChanges: false }),
          },
        }],
      });
    },
  });
  const provider = {
    ...realProvider,
    async chat(args) {
      const result = await realProvider.chat(args);
      lastResult = result;
      return result;
    },
  };
  const executor = makeExecutor(provider, {
    db: localDb,
    tools: {
      declarations: [{
        functionDeclarations: [
          { name: 'read_file' },
          { name: 'list_files' },
        ],
      }],
      async execute(name) {
        toolExecutions += 1;
        if (name === 'read_file') return { content: 'export const value = 1;' };
        return { files: ['src/app.js'] };
      },
    },
  });

  const task = createTask(localDb, {
    projectId: project.id,
    instruction: 'Inspect the project and summarize it.',
  });
  const result = await makeRunner(executor, { db: localDb }).tick();

  assert.equal(result.status, 'completed');
  assert.equal(calls, 3, 'two tool rounds plus the final answer are three HTTP requests');
  assert.equal(toolExecutions, 2);
  assert.deepEqual(lastResult.retryState, { attemptsUsed: 3, exhausted: false });
  assert.equal(lastResult.toolActivity.length, 2);
  const steps = listSteps(localDb, task.id);
  assert.ok(steps.some((step) => step.title === 'Read src/app.js'));
  assert.ok(steps.some((step) => step.title === 'Listed .'));
  assert.ok(steps.some((step) => step.title === 'Inspection complete'));
});

test('a successful tool-heavy inspection leaves a fresh budget for plan generation', async () => {
  const localDb = makeIsolatedDb();
  const project = makeLocalProject(localDb, 'budget-two-phases');
  let calls = 0;
  let planBudget = null;
  const provider = makeProvider(async ({ retryState }) => {
    calls += 1;
    const state = normalizeRetryState(retryState);
    if (state.exhausted) throw new Error('safeChat started with an exhausted budget');
    if (calls === 2) planBudget = { ...state };
    if (calls === 1) {
      // Simulate a successful adapter call whose four tool rounds plus final
      // answer consumed the entire shared budget.
      let inspectionBudget = state;
      for (let i = 0; i < 5; i += 1) inspectionBudget = consumeProviderAttempt(inspectionBudget);
      return {
        text: JSON.stringify({ summary: 'Inspected project.', needsChanges: true }),
        toolActivity: Array.from({ length: 4 }, (_, index) => ({ name: 'read_file', summary: `read-${index}` })),
        retryState: inspectionBudget,
      };
    }
    return {
      text: JSON.stringify({
        summary: 'Create a small file.',
        changes: [{
          kind: 'create',
          path: 'created-by-budget.js',
          content: 'export const ok = true;\n',
          goal: 'verify second-phase budget',
        }],
        commands: [],
      }),
      retryState: consumeProviderAttempt(state),
    };
  });

  const executor = makeExecutor(provider, { db: localDb });
  const task = createTask(localDb, {
    projectId: project.id,
    instruction: 'Inspect and then create a small file.',
    autonomy: 'approved_autonomous',
    autonomous: true,
  });
  const result = await executor({
    task,
    addStep: () => {},
    phase: 'continue',
  });

  assert.equal(calls, 2, 'one inspection call and one plan call reach the provider');
  assert.deepEqual(planBudget, { attemptsUsed: 0, exhausted: false });
  assert.equal(result.status, 'waiting_approval');
});

test('offline end-to-end: a real adapter failure after tools stays terminal', async () => {
  const localDb = makeIsolatedDb();
  const project = makeLocalProject(localDb, 'e2e-tool-failure');
  let calls = 0;
  let toolExecutions = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/e2e-tool-failure:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore: new Map(),
    retryDelaysMs: [0],
    jitterMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'e2e-fail-call',
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
      return Response.json(
        { error: { message: 'too many requests' } },
        { status: 429, headers: { 'Retry-After': '3600' } },
      );
    },
  });
  const executor = makeExecutor(provider, {
    db: localDb,
    tools: {
      declarations: [{ functionDeclarations: [{ name: 'read_file' }] }],
      async execute() {
        toolExecutions += 1;
        return { content: 'export const value = 1;' };
      },
    },
  });

  const task = createTask(localDb, {
    projectId: project.id,
    instruction: 'Inspect the project after a tool call.',
  });
  const result = await makeRunner(executor, { db: localDb }).tick();

  assert.equal(result.status, 'failed');
  assert.equal(calls, 2, 'the failed request must not be replayed');
  assert.equal(toolExecutions, 1, 'the read-only tool must not run twice');
  assert.equal(loadPlan(localDb, task.id)?.recovery?.nextRetryAt, undefined);
  assert.equal(await makeRunner(executor, { db: localDb }).tick(), null);
  assert.equal(calls, 2);
});

test('multiple tasks share a real model cooldown without burning HTTP attempts', async () => {
  const localDb = makeIsolatedDb();
  const cooldownStore = new Map();
  const cooldownKey = 'https://openrouter.ai/api/v1::test/shared-task-cooldown:free';
  let calls = 0;
  const provider = createOpenAIProvider({
    apiKey: 'test-key',
    model: 'test/shared-task-cooldown:free',
    baseUrl: 'https://openrouter.ai/api/v1',
    cooldownStore,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { error: { message: 'too many requests' } },
          { status: 429, headers: { 'Retry-After': '3600' } },
        );
      }
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({ summary: 'Recovered after the shared cooldown.', needsChanges: false }),
          },
        }],
      });
    },
  });
  const executor = makeExecutor(provider, { db: localDb });
  const runner = makeRunner(executor, { db: localDb });
  const project = makeLocalProject(localDb, 'shared-cooldown');
  const first = createTask(localDb, { projectId: project.id, instruction: 'First task.' });
  const second = createTask(localDb, { projectId: project.id, instruction: 'Second task.' });

  const firstPause = await runner.tick();
  const secondPause = await runner.tick();

  assert.equal(firstPause.status, 'provider_paused');
  // The second queued task is short-circuited immediately and paused with the
  // same future retry time; its persisted state proves no HTTP attempt burned.
  assert.equal(secondPause.status, 'provider_paused');
  assert.equal(getTask(localDb, second.id).status, 'provider_paused');
  assert.equal(calls, 1, 'the second task must be short-circuited by the shared cooldown');
  assert.equal(loadPlan(localDb, first.id).recovery.retryState.attemptsUsed, 1);
  assert.deepEqual(loadPlan(localDb, second.id).recovery.retryState, { attemptsUsed: 0, exhausted: false });
  assert.equal(loadPlan(localDb, second.id).recovery.retryAttempt, 1);

  cooldownStore.delete(cooldownKey);
  makeRecoveryReadyIn(localDb, first.id);
  makeRecoveryReadyIn(localDb, second.id);
  assert.equal((await runner.tick()).status, 'completed');
  assert.equal((await runner.tick()).status, 'completed');
  assert.equal(calls, 3, 'each resumed task makes exactly one real HTTP request');
});

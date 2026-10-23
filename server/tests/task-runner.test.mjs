// Tests for the background task runner: claiming, progress, cancellation and
// restart recovery. Everything runs in-process against the temporary test DB.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { openDb } from '../src/db/index.js';
import { createTaskRunner, NO_EXECUTOR_ERROR } from '../src/tasks/runner.js';
import {
  INTERRUPTED_ERROR,
  createTask,
  getTask,
  listSteps,
  requestCancel,
} from '../src/tasks/store.js';

const db = openDb();
const projectId = Number(
  db.prepare('INSERT INTO projects (name) VALUES (?)').run('task-runner-test').lastInsertRowid,
);

const silentLogger = { info() {}, error() {} };
const runners = [];

function makeRunner(options = {}) {
  const runner = createTaskRunner({ db, logger: silentLogger, ...options });
  runners.push(runner);
  return runner;
}

async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await delay(5);
  }
  throw new Error('Timed out waiting for condition');
}

beforeEach(() => {
  db.exec('DELETE FROM task_steps; DELETE FROM tasks;');
});

afterEach(() => {
  for (const runner of runners.splice(0)) runner.stop();
});

test('claims a queued task, runs the executor and records ordered steps', async () => {
  const seen = [];
  const runner = makeRunner({
    executor: async ({ task, addStep }) => {
      seen.push(task.instruction);
      addStep({ kind: 'plan', title: 'Read the failing test' });
      addStep({ kind: 'tool', title: 'Ran npm test', detail: '2 passing' });
    },
  });
  const task = createTask(db, { projectId, instruction: 'Fix the failing test' });

  const result = await runner.tick();

  assert.equal(result.status, 'completed');
  assert.equal(seen[0], 'Fix the failing test');
  assert.equal(typeof result.started_at, 'string');
  assert.equal(typeof result.finished_at, 'string');
  assert.equal(result.error, null);
  assert.equal(result.last_step, 'Ran npm test');

  const steps = listSteps(db, task.id);
  assert.deepEqual(steps.map((step) => step.title), [
    'Run started',
    'Read the failing test',
    'Ran npm test',
  ]);
  assert.deepEqual(steps.map((step) => step.seq), [1, 2, 3]);
});

test('returns null when the queue is empty', async () => {
  const runner = makeRunner({ executor: async () => {} });
  assert.equal(await runner.tick(), null);
});

test('fails honestly when no executor is connected and does not retry', async () => {
  const runner = makeRunner();
  const task = createTask(db, { projectId, instruction: 'Do the work' });

  const result = await runner.tick();
  assert.equal(result.status, 'failed');
  assert.equal(result.error, NO_EXECUTOR_ERROR);
  assert.match(result.error, /not connected/);

  const steps = listSteps(db, task.id);
  assert.equal(steps.at(-1).title, 'Run failed');
  assert.equal(steps.at(-1).status, 'failed');

  assert.equal(await runner.tick(), null);
  assert.equal(getTask(db, task.id).status, 'failed');
});

test('records an executor failure with its message', async () => {
  const runner = makeRunner({
    executor: async () => {
      throw new Error('Provider request failed (429 rate limit).');
    },
  });
  const task = createTask(db, { projectId, instruction: 'Do the work' });

  const result = await runner.tick();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /429 rate limit/);
  assert.equal(listSteps(db, task.id).at(-1).title, 'Run failed');
});

test('two runners never claim the same queued task', async () => {
  let calls = 0;
  const executor = async () => {
    calls += 1;
    await delay(10);
  };
  const first = makeRunner({ executor });
  const second = makeRunner({ executor });
  const task = createTask(db, { projectId, instruction: 'Only once' });

  const results = await Promise.all([first.tick(), second.tick()]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(calls, 1);
  assert.equal(getTask(db, task.id).status, 'completed');
  assert.equal(listSteps(db, task.id).length, 1);
});

test('a queued task cancelled before the runner sees it is never executed', async () => {
  let calls = 0;
  const runner = makeRunner({ executor: async () => { calls += 1; } });
  const task = createTask(db, { projectId, instruction: 'Never mind' });

  requestCancel(db, getTask(db, task.id));

  assert.equal(await runner.tick(), null);
  assert.equal(calls, 0);
  assert.equal(getTask(db, task.id).status, 'cancelled');
});

test('cancelling a running task aborts the executor and records cancelled', async () => {
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let sawAbort = false;

  const runner = makeRunner({
    cancelPollMs: 10,
    executor: async ({ signal, addStep }) => {
      addStep({ kind: 'tool', title: 'Running tests' });
      signalStarted();
      await new Promise((resolve) => {
        if (signal.aborted) {
          sawAbort = true;
          return resolve();
        }
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        }, { once: true });
      });
    },
  });
  const task = createTask(db, { projectId, instruction: 'Long job' });
  const running = runner.tick();

  await started;
  const response = requestCancel(db, getTask(db, task.id));
  assert.equal(response.accepted, true);

  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(sawAbort, true);
  assert.equal(getTask(db, task.id).status, 'cancelled');
  assert.deepEqual(listSteps(db, task.id).map((step) => step.title), [
    'Run started',
    'Running tests',
    'Cancelled',
  ]);
});

test('a cancellation is honoured even when the executor ignores the abort signal', async () => {
  const runner = makeRunner({
    cancelPollMs: 10,
    executor: async () => {
      await delay(40);
    },
  });
  const task = createTask(db, { projectId, instruction: 'Stubborn job' });
  const running = runner.tick();

  await waitFor(() => getTask(db, task.id).status === 'running');
  requestCancel(db, getTask(db, task.id));

  const result = await running;
  assert.equal(result.status, 'cancelled');
});

test('recovery marks an interrupted task failed and never resumes it', async () => {
  let calls = 0;
  const runner = makeRunner({ executor: async () => { calls += 1; } });
  const task = createTask(db, { projectId, instruction: 'Interrupted job' });
  db.prepare("UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?")
    .run(task.id);

  assert.equal(runner.recoverInterrupted(), 1);

  const recovered = getTask(db, task.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error, INTERRUPTED_ERROR);
  assert.equal(typeof recovered.finished_at, 'string');

  const steps = listSteps(db, task.id);
  assert.equal(steps.at(-1).title, 'Run interrupted');
  assert.equal(steps.at(-1).status, 'failed');

  assert.equal(await runner.tick(), null);
  assert.equal(calls, 0);
  assert.equal(getTask(db, task.id).status, 'failed');
});

test('recovery finishes a cancellation that was requested before the restart', async () => {
  const runner = makeRunner({ executor: async () => {} });
  const task = createTask(db, { projectId, instruction: 'Was stopping' });
  db.prepare(`
    UPDATE tasks SET status = 'running', cancel_requested = 1, started_at = datetime('now')
    WHERE id = ?
  `).run(task.id);

  runner.recoverInterrupted();

  const recovered = getTask(db, task.id);
  assert.equal(recovered.status, 'cancelled');
  assert.equal(recovered.error, null);
  assert.equal(listSteps(db, task.id).at(-1).title, 'Cancelled after restart');
});

test('recovery leaves waiting_approval tasks alone for the approval stage', async () => {
  const runner = makeRunner({ executor: async () => {} });
  const task = createTask(db, { projectId, instruction: 'Needs approval' });
  db.prepare("UPDATE tasks SET status = 'waiting_approval' WHERE id = ?").run(task.id);

  runner.recoverInterrupted();

  assert.equal(getTask(db, task.id).status, 'waiting_approval');
});

test('start() recovers, then processes queued work until stopped', async () => {
  let calls = 0;
  let markStarted;
  const executorStarted = new Promise((resolve) => { markStarted = resolve; });
  const runner = makeRunner({
    pollIntervalMs: 10,
    executor: async () => {
      calls += 1;
      markStarted();
    },
  });
  const task = createTask(db, { projectId, instruction: 'Poll me' });

  runner.start();
  await executorStarted;
  await waitFor(() => getTask(db, task.id).status === 'completed');
  runner.stop();

  const later = createTask(db, { projectId, instruction: 'Not while stopped' });
  await delay(30);
  assert.equal(getTask(db, later.id).status, 'queued');
  assert.equal(await runner.tick(), null);
  assert.equal(calls, 1);
});

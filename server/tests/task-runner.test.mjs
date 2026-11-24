// Tests for the background task runner: claiming, progress, cancellation and
// restart recovery. Everything runs in-process against the temporary test DB.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { claimReadyWaitingTask, loadPlan, savePlan } from '../src/tasks/store.js';

import { RETRY_POLICY } from '../src/ai/retry-policy.js';
import { openDb } from '../src/db/index.js';
import { createTaskRunner, NO_EXECUTOR_ERROR } from '../src/tasks/runner.js';
import {
  INTERRUPTED_ERROR,
  createTask,
  finishTask,
  getTask,
  listSteps,
  requestCancel,
  setProviderPaused,
  setWaitingApproval,
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

test('rate-limited tasks pause with recovery metadata and resume after the cooldown expires', async () => {
  let attempts = 0;
  const runner = makeRunner({
    executor: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('rate limited');
        error.statusCode = 429;
        error.category = 'RATE_LIMITED';
        error.publicMessage = 'OpenRouter rate limit reached.';
        error.retryAfterMs = 120_000;
        throw error;
      }
    },
  });
  const task = createTask(db, { projectId, instruction: 'Pause on rate limit' });

  const paused = await runner.tick();
  assert.equal(paused.status, 'provider_paused');
  const recovery = loadPlan(db, task.id).recovery;
  assert.equal(recovery.reason, 'provider_rate_limited');
  assert.equal(recovery.retryAttempt, 1);
  assert.ok(new Date(recovery.nextRetryAt).getTime() > Date.now());
  assert.equal(await runner.tick(), null, 'a task must not resume before its cooldown');

  const plan = loadPlan(db, task.id);
  plan.recovery.nextRetryAt = new Date(Date.now() - 1).toISOString();
  savePlan(db, task.id, plan);

  const resumed = await runner.tick();
  assert.equal(resumed.status, 'completed');
  assert.equal(getTask(db, task.id).status, 'completed');
});

test('quota exhaustion fails terminally without recording a retry time', async () => {
  const runner = makeRunner({
    executor: async () => {
      const error = new Error('quota reached');
      error.statusCode = 429;
      error.category = 'QUOTA_EXHAUSTED';
      error.publicMessage = 'OpenRouter daily quota reached.';
      throw error;
    },
  });
  const task = createTask(db, { projectId, instruction: 'Pause on quota' });

  const failed = await runner.tick();
  assert.equal(failed.status, 'failed');
  const recovery = loadPlan(db, task.id).recovery;
  assert.equal(recovery.reason, 'provider_quota_exhausted');
  assert.equal(recovery.terminal, true);
  assert.equal(recovery.nextRetryAt, undefined);
  assert.equal(recovery.providerRetryAfterMs, undefined);
  assert.ok(listSteps(db, task.id).some((step) => step.title === 'Provider quota reached'));
});

test('the runner fails paused tasks that exhausted recovery before claiming them', async () => {
  const runner = makeRunner({ executor: async () => {} });
  const task = createTask(db, { projectId, instruction: 'Exhausted recovery' });
  savePlan(db, task.id, {
    recovery: {
      reason: 'provider_rate_limited',
      retryAttempt: RETRY_POLICY.maxRecoveryAttempts,
      retryState: { attemptsUsed: RETRY_POLICY.maxProviderAttempts, exhausted: true },
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  db.prepare("UPDATE tasks SET status = 'provider_paused' WHERE id = ?").run(task.id);

  assert.equal(await runner.tick(), null);
  assert.equal(getTask(db, task.id).status, 'failed');
  assert.ok(listSteps(db, task.id).some((step) => step.title === 'Recovery attempts exhausted'));
});

test('an older paused task with a distant cooldown does not block a younger ready task', async () => {
  let calls = 0;
  const runner = makeRunner({ executor: async () => { calls += 1; } });

  const older = createTask(db, { projectId, instruction: 'Older distant cooldown' });
  savePlan(db, older.id, {
    recovery: {
      reason: 'provider_rate_limited',
      retryAttempt: 1,
      nextRetryAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  });
  db.prepare("UPDATE tasks SET status = 'provider_paused' WHERE id = ?").run(older.id);

  const younger = createTask(db, { projectId, instruction: 'Younger ready' });
  savePlan(db, younger.id, {
    recovery: {
      reason: 'provider_rate_limited',
      retryAttempt: 1,
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  db.prepare("UPDATE tasks SET status = 'provider_paused' WHERE id = ?").run(younger.id);

  const result = await runner.tick();
  assert.ok(result, 'a ready task must be claimed');
  assert.equal(result.id, younger.id);
  assert.equal(calls, 1);
  assert.equal(getTask(db, older.id).status, 'provider_paused');
});

test('an older waiting-approval task with a pending proposal does not block a younger ready task', async () => {
  const older = createTask(db, { projectId, instruction: 'Older pending proposal' });
  const olderProposalId = 'older-pending-proposal';
  db.prepare(`INSERT INTO proposals (id, project_id, kind, path, status) VALUES (?, ?, 'create', 'a.txt', 'pending')`)
    .run(olderProposalId, projectId);
  savePlan(db, older.id, { proposals: [{ id: olderProposalId }] });
  db.prepare("UPDATE tasks SET status = 'waiting_approval' WHERE id = ?").run(older.id);

  const younger = createTask(db, { projectId, instruction: 'Younger terminal proposal' });
  const youngerProposalId = 'younger-terminal-proposal';
  db.prepare(`INSERT INTO proposals (id, project_id, kind, path, status) VALUES (?, ?, 'create', 'b.txt', 'applied')`)
    .run(youngerProposalId, projectId);
  savePlan(db, younger.id, { proposals: [{ id: youngerProposalId }] });
  db.prepare("UPDATE tasks SET status = 'waiting_approval' WHERE id = ?").run(younger.id);

  const claimed = claimReadyWaitingTask(db);
  assert.ok(claimed, 'a ready waiting task must be claimable');
  assert.equal(claimed.id, younger.id);
  assert.equal(getTask(db, older.id).status, 'waiting_approval');
});

test('cancelling a waiting-approval task rejects its staged proposals', async () => {
  const task = createTask(db, { projectId, instruction: 'Cancel staged work' });
  const proposalId = 'staged-then-cancelled';
  db.prepare(`INSERT INTO proposals (id, project_id, kind, path, status) VALUES (?, ?, 'create', 'cancel.txt', 'pending')`)
    .run(proposalId, projectId);
  savePlan(db, task.id, { proposals: [{ id: proposalId }] });
  db.prepare("UPDATE tasks SET status = 'waiting_approval' WHERE id = ?").run(task.id);

  const { accepted } = requestCancel(db, getTask(db, task.id));
  assert.equal(accepted, true);
  assert.equal(getTask(db, task.id).status, 'cancelled');
  const proposal = db.prepare('SELECT status FROM proposals WHERE id = ?').get(proposalId);
  assert.equal(proposal.status, 'rejected', 'staged proposals must not survive cancellation');
});

test('a cancelled paused task is never resumed even when its retry time has passed', async () => {
  let calls = 0;
  const runner = makeRunner({ executor: async () => { calls += 1; } });
  const task = createTask(db, { projectId, instruction: 'Cancelled while paused' });
  savePlan(db, task.id, {
    recovery: {
      reason: 'provider_rate_limited',
      retryAttempt: 1,
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  db.prepare("UPDATE tasks SET status = 'provider_paused' WHERE id = ?").run(task.id);

  requestCancel(db, getTask(db, task.id));
  assert.equal(await runner.tick(), null);
  assert.equal(calls, 0);
  assert.equal(getTask(db, task.id).status, 'cancelled');
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

test('cancellation wins when it lands before waiting_approval is persisted', async () => {
  const proposalId = 'cancel-before-waiting';
  const runner = makeRunner({
    executor: ({ db: taskDb, task }) => {
      taskDb
        .prepare("INSERT INTO proposals (id, project_id, kind, path, status) VALUES (?, ?, 'create', 'race.txt', 'pending')")
        .run(proposalId, projectId);
      savePlan(taskDb, task.id, { proposals: [{ id: proposalId }] });
      // The running task is cancelled after the proposal was staged but before
      // the runner can publish the waiting_approval transition.
      requestCancel(taskDb, getTask(taskDb, task.id));
      return { status: 'waiting_approval' };
    },
  });
  const task = createTask(db, { projectId, instruction: 'Stage then cancel.' });

  const result = await runner.tick();

  assert.equal(result.status, 'cancelled');
  assert.equal(getTask(db, task.id).status, 'cancelled');
  const proposal = db.prepare('SELECT status FROM proposals WHERE id = ?').get(proposalId);
  assert.equal(proposal.status, 'rejected', 'a lost race must not leave a reviewable proposal');
  const steps = listSteps(db, task.id);
  assert.equal(steps.some((step) => step.title === 'Waiting for approval'), false);
  assert.ok(steps.some((step) => step.title === 'Cancelled'));
});

test('cancellation wins when it lands before a provider pause is persisted', async () => {
  const runner = makeRunner({
    executor: ({ db: taskDb, task }) => {
      requestCancel(taskDb, getTask(taskDb, task.id));
      const error = new Error('rate limited after cancellation');
      error.statusCode = 429;
      error.category = 'RATE_LIMITED';
      error.publicMessage = 'Provider rate limit reached.';
      error.retryable = true;
      error.retryAfterMs = 360_000;
      throw error;
    },
  });
  const task = createTask(db, { projectId, instruction: 'Pause then cancel.' });

  const result = await runner.tick();

  assert.equal(result.status, 'cancelled');
  assert.equal(getTask(db, task.id).status, 'cancelled');
  assert.equal(loadPlan(db, task.id)?.recovery?.nextRetryAt, undefined);
  const steps = listSteps(db, task.id);
  assert.equal(steps.some((step) => step.title === 'Provider rate limited'), false);
  assert.ok(steps.some((step) => step.title === 'Cancelled'));
});

test('store transitions and terminal writes refuse to overwrite a cancellation flag', () => {
  const task = createTask(db, { projectId, instruction: 'Cancelled mid-transition.' });
  db.prepare("UPDATE tasks SET status = 'running', cancel_requested = 1 WHERE id = ?").run(task.id);

  assert.equal(setWaitingApproval(db, task.id), null);
  assert.equal(setProviderPaused(db, task.id, {
    error: 'rate limited',
    recovery: { reason: 'provider_rate_limited', retryAttempt: 1 },
  }), null);
  assert.equal(finishTask(db, task.id, 'completed', null, { requireNoCancel: true }), null);
  assert.equal(getTask(db, task.id).status, 'running', 'only the cancellation owner may finalize');
});

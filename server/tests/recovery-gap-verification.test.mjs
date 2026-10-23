// Focused gap verification: interrupted recovery, bounded repair cap, accurate final report.
// Uses its own isolated temp workspace and the default openDb from setup-test-env.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db/index.js';
import { createTask, getTask, listSteps, finishTask, appendStep, savePlan, loadPlan } from '../src/tasks/store.js';
import { createTaskRunner } from '../src/tasks/runner.js';

const silentLogger = { info() {}, error() {} };

function makeProject(prefix = 'recovery-test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  // Use same DB that setup-test-env initialized (openDb() with no args uses temp DB)
  // We rely on the global DB handle used by other tests.
  const db = openDb();
  const inserted = db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run(prefix, root);
  return { id: Number(inserted.lastInsertRowid), root };
}

test('interrupted running tasks become failed after recoverInterrupted; waiting_approval untouched', () => {
  const proj = makeProject('recovery-interrupt');
  const db = openDb();
  const task = createTask(db, { projectId: proj.id, instruction: 'do work' });
  db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
  const runner = createTaskRunner({ db, logger: silentLogger });
  const interrupted = runner.recoverInterrupted();
  assert.equal(interrupted, 1);
  const row = getTask(db, task.id);
  assert.equal(row.status, 'failed');
  assert.ok(row.error?.includes('Interrupted') || row.error?.includes('restart'), 'interrupted error reported');
  assert.ok(listSteps(db, task.id).some(s => s.title === 'Run interrupted'), 'interruption step recorded');
});

test('waiting_approval tasks survive recoverInterrupted unchanged', () => {
  const proj = makeProject('recovery-wait');
  const db = openDb();
  const task = createTask(db, { projectId: proj.id, instruction: 'wait' });
  db.prepare("UPDATE tasks SET status = 'waiting_approval', plan_json = '{\"currentStep\":0,\"repairAttempt\":1}' WHERE id = ?").run(task.id);
  const runner = createTaskRunner({ db, logger: silentLogger });
  const interrupted = runner.recoverInterrupted();
  assert.equal(interrupted, 0);
  const row = getTask(db, task.id);
  assert.equal(row.status, 'waiting_approval');
  assert.deepEqual(JSON.parse(row.plan_json || '{}'), { currentStep: 0, repairAttempt: 1 });
});

test('bounded repair caps repairAttempt at 3', async () => {
  const { advancePlanProgress } = await import('../src/tasks/store.js');
  const proj = makeProject('recovery-cap');
  const db = openDb();
  const task = createTask(db, { projectId: proj.id, instruction: 'repair' });
  const plan = { steps: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }], currentStep: 2, repairAttempt: 2 };
  db.prepare(`UPDATE tasks SET plan_json = ? WHERE id = ?`).run(JSON.stringify(plan), task.id);
  const updated = advancePlanProgress(plan, { repairAttempt: 10, currentStep: 99 });
  assert.equal(updated.repairAttempt, 3, 'repairAttempt capped at 3');
  assert.equal(updated.currentStep, 4, 'currentStep capped at steps.length');
});

test('final report accurate when repair fails after max attempts', () => {
  const proj = makeProject('recovery-final');
  const db = openDb();
  const task = createTask(db, { projectId: proj.id, instruction: 'fail' });
  appendStep(db, task.id, { kind: 'note', title: 'Repair exhausted', detail: 'Repair exhausted after 3 attempts', status: 'failed' });
  finishTask(db, task.id, 'failed', 'Repair exhausted after 3 attempts');
  const row = getTask(db, task.id);
  assert.equal(row.status, 'failed');
  assert.ok(row.error?.includes('Repair'), 'final report includes repair failure reason');
  assert.ok(listSteps(db, task.id).some(s => s.status === 'failed' && s.title === 'Repair exhausted'), 'failed step recorded');
});

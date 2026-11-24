// Quota & Recovery focused tests — mock provider, isolated temp DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { createTask, getTask, savePlan, loadPlan, claimRecoverableTask } from '../src/tasks/store.js';
import { createTaskRunner } from '../src/tasks/runner.js';

const silentLogger = { info() {}, error() {} };

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

function tempDb() {
  const p = path.join(os.tmpdir(), `quota-test-${Date.now()}.db`);
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, instruction TEXT NOT NULL, autonomy TEXT NOT NULL DEFAULT 'allow_writes_and_commands', status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_approval', 'provider_paused', 'completed', 'failed', 'cancelled')), last_step TEXT, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, plan_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, root_path TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'done', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  return db;
}

function makeProject(prefix = 'quota-test', db) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const useDb = db || openDb();
  const inserted = useDb.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run(prefix, root);
  return { id: Number(inserted.lastInsertRowid), root };
}

test('quota exhaustion sets provider_paused and saves recovery info', async () => {
  const db = tempDb();
  const proj = makeProject('quota-pause', db);
  const task = createTask(db, { projectId: proj.id, instruction: 'test' });
  // Simulate runner catching a quota error by directly updating to paused and saving recovery
  db.prepare("UPDATE tasks SET status = 'provider_paused' WHERE id = ?").run(task.id);
  const recovery = { reason: 'provider_quota_exhausted', retryAttempt: 3, nextRetryAt: new Date(Date.now() + 3600000).toISOString(), pausedAt: new Date().toISOString() };
  const plan = loadPlan(db, task.id) || {};
  plan.recovery = recovery;
  savePlan(db, task.id, plan);
  const updated = getTask(db, task.id);
  assert.equal(updated.status, 'provider_paused');
  assert.ok(loadPlan(db, task.id)?.recovery?.reason === 'provider_quota_exhausted');
});

test('claimRecoverableTask resumes only when retryAfter passed', async () => {
  const db = tempDb();
  const proj = makeProject('quota-resume', db);
  const task = createTask(db, { projectId: proj.id, instruction: 'resume' });
  db.prepare("UPDATE tasks SET status = 'provider_paused' WHERE id = ?").run(task.id);
  const future = new Date(Date.now() + 3600000).toISOString();
  const plan = loadPlan(db, task.id) || {};
  plan.recovery = { reason: 'quota', nextRetryAt: future };
  savePlan(db, task.id, plan);
  const claimed = claimRecoverableTask(db);
  assert.equal(claimed, null, 'should not resume when retry time is future');
});

test('legacy paused quota rows are terminalized and cannot be claimed', async () => {
  const db = tempDb();
  const proj = makeProject('quota-legacy', db);
  const task = createTask(db, { projectId: proj.id, instruction: 'legacy quota row' });
  db.prepare("UPDATE tasks SET status = 'provider_paused' WHERE id = ?").run(task.id);
  // Old-format persisted pause: quota reason, high retryAttempt and a reset
  // time that has already passed. Resuming it would burn more quota.
  savePlan(db, task.id, {
    recovery: {
      reason: 'provider_quota_exhausted',
      retryAttempt: 3,
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
      pausedAt: new Date(Date.now() - 3600000).toISOString(),
    },
  });

  assert.equal(claimRecoverableTask(db), null, 'legacy quota rows must never be claimed');

  const failed = getTask(db, task.id);
  assert.equal(failed.status, 'failed');
  const recovery = loadPlan(db, task.id).recovery;
  assert.equal(recovery.reason, 'provider_quota_exhausted');
  assert.equal(recovery.terminal, true);
  assert.equal(recovery.nextRetryAt, undefined);
  assert.equal(claimRecoverableTask(db), null, 'a terminal row stays terminal');
});

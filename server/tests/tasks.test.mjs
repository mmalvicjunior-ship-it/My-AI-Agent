// Tests for the background task queue API: POST/GET /api/tasks and cancel.
// No AI provider is involved here; these cover the durable status model only.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { mockProvider } from '../src/ai/mock.js';
import { MAX_INSTRUCTION_CHARS, createTask } from '../src/tasks/store.js';

let server;
let db;
let base;
let projectId;

async function request(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, data };
}

before(async () => {
  const created = createApp({ provider: mockProvider });
  db = created.db;
  server = created.app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  const project = db.prepare('INSERT INTO projects (name) VALUES (?)').run('tasks-api-test');
  projectId = Number(project.lastInsertRowid);
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
});

beforeEach(() => {
  db.exec('DELETE FROM task_steps; DELETE FROM tasks;');
});

function postTask(overrides = {}) {
  return request('POST', '/api/tasks', {
    projectId,
    instruction: 'Fix the failing test',
    ...overrides,
  });
}

test('creates a queued task with the default autonomy', async () => {
  const { status, data } = await postTask({ instruction: '  Fix the failing test  ' });

  assert.equal(status, 201);
  assert.equal(data.ok, true);
  assert.equal(data.task.project_id, projectId);
  assert.equal(data.task.instruction, 'Fix the failing test');
  assert.equal(data.task.status, 'queued');
  assert.equal(data.task.autonomy, 'propose');
  assert.equal(data.task.cancel_requested, 0);
  assert.equal(data.task.last_step, null);
  assert.equal(data.task.error, null);
  assert.equal(typeof data.task.created_at, 'string');
});

test('accepts an explicit autonomy level', async () => {
  const { status, data } = await postTask({ autonomy: 'propose' });
  assert.equal(status, 201);
  assert.equal(data.task.autonomy, 'propose');
});

test('rejects an unknown project', async () => {
  const { status, data } = await postTask({ projectId: 999_999 });
  assert.equal(status, 404);
  assert.equal(data.ok, false);
  assert.match(data.error, /Project not found/);
});

test('rejects missing, empty and oversized instructions', async () => {
  const missing = await request('POST', '/api/tasks', { projectId });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /Instruction is required/);

  const blank = await postTask({ instruction: '   ' });
  assert.equal(blank.status, 400);

  const long = await postTask({ instruction: 'x'.repeat(MAX_INSTRUCTION_CHARS + 1) });
  assert.equal(long.status, 400);
  assert.match(long.data.error, new RegExp(String(MAX_INSTRUCTION_CHARS)));
});

test('rejects an unknown autonomy level', async () => {
  const { status, data } = await postTask({ autonomy: 'full-auto' });
  assert.equal(status, 400);
  assert.match(data.error, /Autonomy must be one of/);
});

test('lists tasks newest first and filters by project and status', async () => {
  await postTask({ instruction: 'first' });
  await postTask({ instruction: 'second' });

  const all = await request('GET', `/api/tasks?projectId=${projectId}`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.tasks.map((task) => task.instruction), ['second', 'first']);
  assert.equal(all.data.tasks[0].step_count, 0);

  const other = db.prepare('INSERT INTO projects (name) VALUES (?)').run('other-project');
  const otherId = Number(other.lastInsertRowid);
  createTask(db, { projectId: otherId, instruction: 'elsewhere' });

  const filtered = await request('GET', `/api/tasks?projectId=${projectId}`);
  assert.equal(filtered.data.tasks.length, 2);
  assert.ok(filtered.data.tasks.every((task) => task.project_id === projectId));

  const queued = await request('GET', `/api/tasks?status=queued&limit=1`);
  assert.equal(queued.data.tasks.length, 1);
});

test('rejects invalid list filters', async () => {
  const badProject = await request('GET', '/api/tasks?projectId=abc');
  assert.equal(badProject.status, 400);

  const badStatus = await request('GET', '/api/tasks?status=exploded');
  assert.equal(badStatus.status, 400);
  assert.match(badStatus.data.error, /status/);
});

test('returns task detail with steps and 404 for unknown ids', async () => {
  const created = await postTask();
  const detail = await request('GET', `/api/tasks/${created.data.task.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.steps, []);
  assert.equal(detail.data.task.id, created.data.task.id);

  const missing = await request('GET', '/api/tasks/424242');
  assert.equal(missing.status, 404);

  const junk = await request('GET', '/api/tasks/not-a-number');
  assert.equal(junk.status, 404);
});

test('cancels a queued task immediately and records the reason', async () => {
  const created = await postTask();
  const id = created.data.task.id;

  const cancelled = await request('POST', `/api/tasks/${id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.cancelling, false);
  assert.equal(cancelled.data.task.status, 'cancelled');
  assert.equal(cancelled.data.task.cancel_requested, 1);
  assert.equal(typeof cancelled.data.task.finished_at, 'string');

  const detail = await request('GET', `/api/tasks/${id}`);
  assert.equal(detail.data.steps.length, 1);
  assert.equal(detail.data.steps[0].title, 'Cancelled before it ran');

  const again = await request('POST', `/api/tasks/${id}/cancel`);
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already cancelled/);
});

test('asks a running task to stop without faking the final state', async () => {
  const created = await postTask();
  const id = created.data.task.id;
  db.prepare("UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?").run(id);

  const response = await request('POST', `/api/tasks/${id}/cancel`);
  assert.equal(response.status, 200);
  assert.equal(response.data.cancelling, true);
  // The runner owns the transition to 'cancelled'; the route only records intent.
  assert.equal(response.data.task.status, 'running');
  assert.equal(response.data.task.cancel_requested, 1);
});

test('refuses to cancel a finished task', async () => {
  const created = await postTask();
  const id = created.data.task.id;
  db.prepare("UPDATE tasks SET status = 'completed', finished_at = datetime('now') WHERE id = ?").run(id);

  const { status, data } = await request('POST', `/api/tasks/${id}/cancel`);
  assert.equal(status, 409);
  assert.match(data.error, /already completed/);
});

test('returns 404 when cancelling an unknown task', async () => {
  const { status } = await request('POST', '/api/tasks/987654/cancel');
  assert.equal(status, 404);
});

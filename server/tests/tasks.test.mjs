// Tests for the background task queue API: POST/GET /api/tasks and cancel.
// No AI provider is involved here; these cover the durable status model only.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

import { createApp } from '../src/index.js';
import { config } from '../src/config.js';
import { mockProvider } from '../src/ai/mock.js';
import { MAX_INSTRUCTION_CHARS, createTask, savePlan } from '../src/tasks/store.js';
import { stageProposal } from '../src/proposals/store.js';

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
  const created = createApp({ auth: false, provider: mockProvider });
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
  db.exec('DELETE FROM task_steps; DELETE FROM tasks; DELETE FROM proposals; DELETE FROM file_changes;');
});

function postTask(overrides = {}) {
  return request('POST', '/api/tasks', {
    projectId,
    instruction: 'Fix the failing test',
    ...overrides,
  });
}

function projectRoot(id = projectId) {
  return path.join(config.workspaceRoot, String(id));
}

function makeWaitingTask(instruction, linkedProposals) {
  const task = createTask(db, { projectId, instruction, autonomy: 'propose' });
  savePlan(db, task.id, {
    version: 1,
    summary: 'Waiting for approval',
    proposals: linkedProposals,
    currentStep: 0,
    repairAttempt: 0,
  });
  db.prepare("UPDATE tasks SET status = 'waiting_approval' WHERE id = ?").run(task.id);
  return task;
}

function proposedFile({ path: filePath, content = 'export const value = 1;\n', originalContent = null, kind = 'create' }) {
  return stageProposal(db, {
    projectId,
    kind,
    path: filePath,
    content,
    originalContent,
  });
}

function proposedCommand(command, commandPath = null) {
  return stageProposal(db, {
    projectId,
    kind: 'command',
    command,
    commandPath,
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

test('accepts an explicit autonomy level without granting privileges', async () => {
  const { status, data } = await postTask({ autonomy: 'propose' });
  assert.equal(status, 201);
  assert.equal(data.task.autonomy, 'propose');
  assert.equal(data.task.autonomous, 0);
});

test('ignores client-supplied privileged autonomy fields', async () => {
  const attempts = [
    { autonomy: 'approved_autonomous' },
    { autonomy: 'allow_writes_and_commands' },
    { autonomous: true },
    { autonomy: 'approved_autonomous', autonomous: true },
  ];

  for (const overrides of attempts) {
    const { status, data } = await postTask({
      instruction: 'Create a file without asking',
      ...overrides,
    });
    assert.equal(status, 201, JSON.stringify(data));
    assert.equal(data.task.autonomy, 'propose');
    assert.equal(data.task.autonomous, 0);

    const stored = db
      .prepare('SELECT autonomy, autonomous FROM tasks WHERE id = ?')
      .get(data.task.id);
    assert.equal(stored.autonomy, 'propose');
    assert.equal(stored.autonomous, 0);
  }
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

test('task detail projects linked proposals without applying or running them', async () => {
  fs.mkdirSync(projectRoot(), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot(), 'package.json'),
    `${JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('WAS_EXECUTED','yes')\"" } }, null, 2)}\n`,
  );
  const fileProposal = proposedFile({ path: 'reviewed.js' });
  const commandProposal = proposedCommand('npm_test');
  const other = db.prepare('INSERT INTO projects (name) VALUES (?)').run('foreign-projection-project');
  const foreignProposal = stageProposal(db, {
    projectId: Number(other.lastInsertRowid),
    kind: 'create',
    path: 'foreign.js',
    content: 'not yours\n',
  });
  const task = makeWaitingTask('Review staged work', [
    { id: fileProposal.id, kind: 'create', path: 'reviewed.js' },
    commandProposal.id,
    foreignProposal.id,
  ]);

  const detail = await request('GET', `/api/tasks/${task.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.proposals.length, 2);
  assert.equal(detail.data.proposals.some((proposal) => proposal.proposalId === foreignProposal.id), false);

  const file = detail.data.proposals.find((proposal) => proposal.proposalId === fileProposal.id);
  assert.equal(file.type, 'file');
  assert.equal(file.action, 'create');
  assert.equal(file.path, 'reviewed.js');
  assert.equal(file.status, 'pending');
  assert.equal(file.expired, false);
  assert.match(file.diff, /export const value = 1/);
  assert.equal('content' in file, false);
  assert.equal('original_content' in file, false);

  const command = detail.data.proposals.find((proposal) => proposal.proposalId === commandProposal.id);
  assert.equal(command.type, 'command');
  assert.equal(command.command, 'npm_test');
  assert.equal(command.path, null);
  assert.equal(command.status, 'pending');
  assert.equal(command.result, null);

  assert.equal(fs.existsSync(path.join(projectRoot(), 'reviewed.js')), false);
  assert.equal(fs.existsSync(path.join(projectRoot(), 'WAS_EXECUTED')), false);
  assert.equal(db.prepare('SELECT status FROM proposals WHERE id = ?').get(fileProposal.id).status, 'pending');
  assert.equal(db.prepare('SELECT status FROM proposals WHERE id = ?').get(commandProposal.id).status, 'pending');
});

test('task API omits plan_json and exposes only safe linked proposal ids', async () => {
  const proposal = proposedFile({
    path: 'private-plan.js',
    content: 'TOP_SECRET_PLAN_CONTENT\n',
  });
  const task = makeWaitingTask('Hide the saved plan', [proposal.id]);

  const detail = await request('GET', `/api/tasks/${task.id}`);
  assert.equal(detail.status, 200);
  assert.equal('plan_json' in detail.data.task, false);
  assert.equal(JSON.stringify(detail.data.task).includes('TOP_SECRET_PLAN_CONTENT'), false);
  assert.deepEqual(detail.data.task.linkedProposalIds, [proposal.id]);

  const list = await request('GET', `/api/tasks?projectId=${projectId}`);
  assert.equal(list.status, 200);
  assert.equal('plan_json' in list.data.tasks[0], false);
  assert.deepEqual(list.data.tasks[0].linkedProposalIds, [proposal.id]);

  const created = await postTask({ instruction: 'A brand new task' });
  assert.equal(created.status, 201);
  assert.equal('plan_json' in created.data.task, false);
  assert.deepEqual(created.data.task.linkedProposalIds, []);
});

test('task detail reflects an applied file proposal after explicit approval', async () => {
  fs.mkdirSync(projectRoot(), { recursive: true });
  const proposal = proposedFile({ path: 'applied.js' });
  const task = makeWaitingTask('Apply the proposed file', [{ id: proposal.id }]);

  const applied = await request('POST', `/api/projects/${projectId}/proposals/${proposal.id}/apply`);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));

  const detail = await request('GET', `/api/tasks/${task.id}`);
  const view = detail.data.proposals[0];
  assert.equal(view.status, 'applied');
  assert.equal(view.expired, false);
  assert.equal(view.path, 'applied.js');
  assert.equal(typeof view.finished_at, 'string');
  assert.equal(fs.existsSync(path.join(projectRoot(), 'applied.js')), true);

  const duplicate = await request('POST', `/api/projects/${projectId}/proposals/${proposal.id}/apply`);
  assert.equal(duplicate.status, 404);
});

test('task detail reflects a rejected proposal after explicit rejection', async () => {
  const proposal = proposedFile({ path: 'rejected.js' });
  const task = makeWaitingTask('Reject the proposed file', [proposal.id]);

  const rejected = await request('POST', `/api/projects/${projectId}/proposals/${proposal.id}/reject`);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.status, 'rejected');

  const detail = await request('GET', `/api/tasks/${task.id}`);
  const view = detail.data.proposals[0];
  assert.equal(view.status, 'rejected');
  assert.equal(view.expired, false);
  assert.equal(typeof view.finished_at, 'string');
  assert.equal(fs.existsSync(path.join(projectRoot(), 'rejected.js')), false);

  const lateApply = await request('POST', `/api/projects/${projectId}/proposals/${proposal.id}/apply`);
  assert.equal(lateApply.status, 404);
});

test('task detail reflects a command result after explicit command approval', async () => {
  fs.mkdirSync(projectRoot(), { recursive: true });
  fs.writeFileSync(path.join(projectRoot(), 'ok.js'), 'export const ok = true;\n');
  const proposal = proposedCommand('node_check', 'ok.js');
  const task = makeWaitingTask('Run the proposed command', [{ id: proposal.id }]);

  const run = await request('POST', `/api/projects/${projectId}/commands/${proposal.id}/run`);
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.result.exitCode, 0);

  const detail = await request('GET', `/api/tasks/${task.id}`);
  const view = detail.data.proposals[0];
  assert.equal(view.status, 'applied');
  assert.equal(view.type, 'command');
  assert.equal(view.result.command, 'node_check');
  assert.equal(view.result.exitCode, 0);
  assert.equal(typeof view.finished_at, 'string');

  const duplicate = await request('POST', `/api/projects/${projectId}/commands/${proposal.id}/run`);
  assert.equal(duplicate.status, 404);
});

test('task detail marks an expired pending proposal and approval returns 410', async () => {
  fs.mkdirSync(projectRoot(), { recursive: true });
  const proposal = proposedFile({ path: 'expired.js' });
  db.prepare("UPDATE proposals SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(proposal.id);
  const task = makeWaitingTask('Review an expired proposal', [proposal.id]);

  const detail = await request('GET', `/api/tasks/${task.id}`);
  assert.equal(detail.data.proposals[0].status, 'pending');
  assert.equal(detail.data.proposals[0].expired, true);

  const apply = await request('POST', `/api/projects/${projectId}/proposals/${proposal.id}/apply`);
  assert.equal(apply.status, 410);
  assert.match(apply.data.error, /expired/i);
  assert.equal(fs.existsSync(path.join(projectRoot(), 'expired.js')), false);
  assert.equal(db.prepare('SELECT status FROM proposals WHERE id = ?').get(proposal.id).status, 'pending');
});

test('invalid and foreign proposal ids cannot be approved through a task project', async () => {
  const unknown = await request('POST', `/api/projects/${projectId}/proposals/no-such-proposal/apply`);
  assert.equal(unknown.status, 404);

  const other = db.prepare('INSERT INTO projects (name) VALUES (?)').run('foreign-approval-project');
  const foreignId = Number(other.lastInsertRowid);
  const foreign = stageProposal(db, {
    projectId: foreignId,
    kind: 'create',
    path: 'foreign.js',
    content: 'export const foreign = true;\n',
  });

  const crossProject = await request('POST', `/api/projects/${projectId}/proposals/${foreign.id}/apply`);
  assert.equal(crossProject.status, 404);
  assert.equal(db.prepare('SELECT status FROM proposals WHERE id = ?').get(foreign.id).status, 'pending');
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

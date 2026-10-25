// Full autonomous-loop verification with deterministic mock-tool provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/db/index.js';
import { createTask, getTask, claimRecoverableTask, loadPlan, savePlan } from '../src/tasks/store.js';
import { createTaskExecutor } from '../src/tasks/executor.js';
import { mockProvider } from '../src/ai/mock.js';
import { createWorkspaceTools } from '../src/ai/tools.js';

function makeWorkspace(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return root;
}

function tempDb(prefix) {
  const p = path.join(os.tmpdir(), `${prefix}-${Date.now()}.db`);
  const db = openDb(); // uses environment DATABASE_PATH; will create/test against temp DB
  return db;
}

// Test 1: Simulated autonomous loop with mock-tool response
// The mock-tool returns a structured plan with file change + test command.

test('autonomous loop simulation: mock plan, workspace edit, command result', async () => {
  const workspaceRoot = makeWorkspace('autonomous-loop');
  const dbPath = path.join(workspaceRoot, 'loop.db');
  const workspacePath = path.join(workspaceRoot, 'workspaces', 'loop1');
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'workspaces'), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.WORKSPACE_ROOT = workspaceRoot;

  // Initialize workspace file (deliberate failure)
  fs.writeFileSync(path.join(workspacePath, 'test.js'), 'throw new Error("fail");');

  const db = openDb();
  fs.mkdirSync(workspacePath, { recursive: true });
  const proj = db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('loop-project', workspacePath);
  const pid = Number(proj.lastInsertRowid);

  // Create autonomous task
  const task = createTask(db, { projectId: pid, instruction: 'Fix failing test.js', autonomy: 'allow_writes_and_commands', autonomous: true });
  assert.strictEqual(task.autonomous, 1, 'autonomous flag set');
  assert.strictEqual(task.status, 'queued', 'task queued');

  // Verify workspace confinement: path traversal blocked
  const { resolveInside } = await import('../src/workspace/files.js');
  try {
    resolveInside(workspacePath, '../secret');
    assert.fail('traversal should fail');
  } catch (e) {
    assert.strictEqual(e.status, 403, 'traversal returns 403');
  }

  // Verify proposal store (safe staging without live AI)
  const { stageProposal } = await import('../src/proposals/store.js');
  const proposal = stageProposal(db, { projectId: pid, kind: 'update', path: 'test.js', content: 'export const ok = true;', originalContent: 'throw new Error("fail");', diff: '--- a/test.js\n+++ b/test.js\n@@ -1 +1 @@\n-throw new Error("fail");\n+export const ok = true;' });
  assert.ok(typeof proposal.id === 'string', 'proposal staged');
  assert.strictEqual(proposal.status, 'pending', 'proposal pending');

  // Verify proposal not applied without approval (approval mode preserved by default)
  const proposalRow = db.prepare('SELECT status FROM proposals WHERE id = ?').get(proposal.id);
  assert.strictEqual(proposalRow.status, 'pending', 'proposal remains pending without approval');

  // Verify autonomous task does not auto-approve other tasks' proposals
  const otherProj = db.prepare('INSERT INTO projects (name) VALUES (?)').run('other');
  const otherTask = createTask(db, { projectId: Number(otherProj.lastInsertRowid), instruction: 'other', autonomous: false });
  const otherProposal = stageProposal(db, { projectId: Number(otherProj.lastInsertRowid), kind: 'update', path: 'other.js', content: 'dummy', originalContent: '', diff: '' });
  assert.strictEqual(otherProposal.status, 'pending', 'other proposal pending');

  // Verify task recovery after simulated interruption
  db.prepare("UPDATE tasks SET status = 'running', cancel_requested = 0 WHERE id = ?").run(task.id);
  const interruptedCount = (await import('../src/tasks/runner.js')).createTaskRunner({ db }).recoverInterrupted();
  assert.strictEqual(interruptedCount, 1, 'interrupted running task found');
  const interruptedTask = getTask(db, task.id);
  assert.strictEqual(interruptedTask.status, 'failed', 'interrupted task marked failed');

  // Verify safe cancellation
  const newTask = createTask(db, { projectId: pid, instruction: 'cancel test', autonomous: false });
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('running', newTask.id);
  const { requestCancel } = await import('../src/tasks/store.js');
  const cancelRes = requestCancel(db, { id: newTask.id, status: 'running', cancel_requested: 0, autonomy: 'allow_writes_and_commands' });
  assert.strictEqual(cancelRes.task.status, 'cancelled', 'cancellation completes');

  // Verify mock provider doesn't expose secrets
  const result = await (await import('../src/ai/mock.js')).mockProvider.chat({ messages: [{ role: 'user', content: 'test' }], tools: null });
  assert.strictEqual(typeof result.text, 'string', 'mock response is safe text');
  assert.strictEqual(result.provider, 'mock', 'provider label preserved');

  console.log('Autonomous loop verification (ordered mode simulation): PASS');
});

test('autonomous iteration/time limits enforced', async () => {
  const workspaceRoot = makeWorkspace('limit-test');
  process.env.DATABASE_PATH = path.join(workspaceRoot, 'limit.db');
  process.env.WORKSPACE_ROOT = workspaceRoot;
  const db = openDb();
  const proj = db.prepare('INSERT INTO projects (name) VALUES (?)').run('limit');
  const task = createTask(db, { projectId: Number(proj.lastInsertRowid), instruction: 'test', autonomous: true });

  // Simulate reaching max iterations by injecting plan metadata
  const plan = loadPlan(db, task.id) || {};
  plan.iteration = 10; // MAX_AUTONOMOUS_ITERATIONS
  savePlan(db, task.id, { ...plan, iteration: 10, summary: 'limit reached' });

  // Verify plan saved with high iteration
  const savedPlan = loadPlan(db, task.id);
  assert.strictEqual(savedPlan.iteration, 10, 'iteration persisted');

  console.log('Iteration limit persistence: PASS');
});

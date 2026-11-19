// Python integration regressions. These exercise the existing approval path:
// stage a `kind='command'` proposal, require explicit approval, then let the
// backend runner verify the pinned path/digest before spawning Python.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createWorkspaceTools } from '../src/ai/tools.js';
import { openDb } from '../src/db/index.js';
import { stageProposal } from '../src/proposals/store.js';
import { createTaskExecutor } from '../src/tasks/executor.js';
import { createTaskRunner } from '../src/tasks/runner.js';
import { createTask } from '../src/tasks/store.js';

const db = openDb();
const silentLogger = { info() {}, error() {} };
const tempRoots = [];

after(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

function makeProject(prefix = 'myai-python') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempRoots.push(root);
  const inserted = db
    .prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
    .run(prefix, root);
  return { id: Number(inserted.lastInsertRowid), root };
}

function writePython(project, source, name = 'run.py') {
  const target = path.join(project.root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return target;
}

function statusOf(projectId, proposalId) {
  return db.prepare('SELECT * FROM proposals WHERE id = ? AND project_id = ?').get(proposalId, projectId);
}

async function stagePythonRun(tools, project, source, name = 'run.py') {
  writePython(project, source, name);
  return tools.execute('run_command', { projectId: project.id, command: 'python_run', path: name });
}

test('a missing Python interpreter fails before spawn with an actionable error', async () => {
  const project = makeProject('myai-python-no-interpreter');
  const tools = createWorkspaceTools({ db, pythonBin: 'definitely-not-a-python-executable' });
  const staged = await stagePythonRun(
    tools,
    project,
    "from pathlib import Path\nPath('RAN').write_text('yes')\n",
  );

  assert.throws(
    () => tools.runApprovedCommand(project.id, staged.proposalId),
    (error) => error.status === 502 && /PYTHON_BIN/i.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(project.root, 'RAN')), false);
  assert.equal(statusOf(project.id, staged.proposalId).status, 'pending');
});

test('python_run staging pins the canonical path and SHA-256 digest before approval', async () => {
  const project = makeProject('myai-python-stage');
  const tools = createWorkspaceTools({ db });
  writePython(project, "from pathlib import Path\nPath('RAN').write_text('yes')\n");

  const staged = await tools.execute('run_command', {
    projectId: project.id,
    command: 'python_run',
    path: './nested/../run.py',
  });

  assert.equal(staged.status, 'awaiting_user_approval');
  assert.equal(staged.path, 'run.py');
  assert.match(staged.contentSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(project.root, 'RAN')), false, 'staging must not execute Python');

  const row = statusOf(project.id, staged.proposalId);
  assert.equal(row.status, 'pending');
  assert.equal(row.command_path, 'run.py');
  assert.equal(row.content, staged.contentSha256);
});

test('approved python_run returns the standard result shape and cannot be replayed', async () => {
  const project = makeProject('myai-python-ok');
  const tools = createWorkspaceTools({ db });
  const staged = await stagePythonRun(
    tools,
    project,
    "from pathlib import Path\nwith Path('RUNS.txt').open('a', encoding='utf-8') as f:\n    f.write('1\\n')\nprint('PY RUN OK')\n",
  );

  const result = tools.runApprovedCommand(project.id, staged.proposalId);
  assert.deepEqual(Object.keys(result).sort(), ['command', 'exitCode', 'stderr', 'stdout']);
  assert.equal(result.command, 'python_run');
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /PY RUN OK/);
  assert.match(fs.readFileSync(path.join(project.root, 'RUNS.txt'), 'utf8'), /^1\r?\n$/);

  assert.throws(
    () => tools.runApprovedCommand(project.id, staged.proposalId),
    /not found/i,
    'a second approval attempt must be rejected by the atomic claim',
  );
  assert.match(fs.readFileSync(path.join(project.root, 'RUNS.txt'), 'utf8'), /^1\r?\n$/);

  const row = statusOf(project.id, staged.proposalId);
  assert.equal(row.status, 'applied');
  assert.match(row.result_json, /PY RUN OK/);
});

test('rejected python_run never spawns the interpreter', async () => {
  const project = makeProject('myai-python-reject');
  const tools = createWorkspaceTools({ db });
  const staged = await stagePythonRun(
    tools,
    project,
    "from pathlib import Path\nPath('RAN').write_text('yes')\n",
  );

  tools.rejectProposal(project.id, staged.proposalId);
  assert.throws(() => tools.runApprovedCommand(project.id, staged.proposalId), /not found/i);
  assert.equal(fs.existsSync(path.join(project.root, 'RAN')), false);
  assert.equal(statusOf(project.id, staged.proposalId).status, 'rejected');
});

test('content changed after approval is rejected and remains safely retryable', async () => {
  const project = makeProject('myai-python-tamper');
  const tools = createWorkspaceTools({ db });
  const staged = await stagePythonRun(tools, project, "print('original')\n");

  writePython(project, "from pathlib import Path\nPath('TAMPERED').write_text('yes')\n");

  assert.throws(
    () => tools.runApprovedCommand(project.id, staged.proposalId),
    (error) => error.status === 409 && /content changed/i.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(project.root, 'TAMPERED')), false);
  assert.equal(statusOf(project.id, staged.proposalId).status, 'pending',
    'a pre-flight digest mismatch must release the claim for a fresh proposal');
});

test('a directly constructed python_run proposal without a digest is refused', async () => {
  const project = makeProject('myai-python-no-digest');
  const tools = createWorkspaceTools({ db });
  writePython(project, "from pathlib import Path\nPath('RAN').write_text('yes')\n");
  const proposal = stageProposal(db, {
    projectId: project.id,
    kind: 'command',
    command: 'python_run',
    commandPath: 'run.py',
  });

  assert.throws(
    () => tools.runApprovedCommand(project.id, proposal.id),
    (error) => error.status === 409 && /digest/i.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(project.root, 'RAN')), false);
  assert.equal(statusOf(project.id, proposal.id).status, 'pending');
});

test('python_run rejects traversal, absolute, missing, wrong-extension, large, and hard-linked files', async () => {
  const project = makeProject('myai-python-paths');
  const tools = createWorkspaceTools({ db });
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-python-outside-'));
  tempRoots.push(outsideRoot);
  const outsideFile = path.join(outsideRoot, 'outside.py');
  fs.writeFileSync(outsideFile, "print('outside')\n");
  fs.linkSync(outsideFile, path.join(project.root, 'linked.py'));
  fs.writeFileSync(path.join(project.root, 'oversize.py'), `# ${'x'.repeat(1024 * 1024 + 1)}\n`);

  const cases = [
    ['../escape.py', /escapes/],
    [path.join(project.root, 'run.py'), /relative/],
    ['missing.py', /not found/i],
    ['notes.txt', /\.py/],
    ['oversize.py', /too large/i],
    ['linked.py', /hard link/i],
  ];
  for (const [badPath, pattern] of cases) {
    await assert.rejects(
      tools.execute('run_command', { projectId: project.id, command: 'python_run', path: badPath }),
      pattern,
      `expected ${badPath} to be refused at staging time`,
    );
  }
  assert.equal(tools.listProposals(project.id).proposals.length, 0,
    'an invalid Python approval must not be presented to the user');
});

test('python_check parses syntax without executing project code', async () => {
  const project = makeProject('myai-python-syntax');
  const tools = createWorkspaceTools({ db });
  const source = "from pathlib import Path\nPath('CHECK_RAN').write_text('yes')\nprint('missing paren'\n";
  writePython(project, source);
  const staged = await tools.execute('run_command', {
    projectId: project.id,
    command: 'python_check',
    path: 'run.py',
  });

  const result = tools.runApprovedCommand(project.id, staged.proposalId);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /SyntaxError/);
  assert.equal(fs.existsSync(path.join(project.root, 'CHECK_RAN')), false,
    'python_check must parse, not execute');
});

test('python_run reports runtime errors as structured results', async () => {
  const project = makeProject('myai-python-runtime');
  const tools = createWorkspaceTools({ db });
  const staged = await stagePythonRun(tools, project, "raise RuntimeError('boom')\n");

  const result = tools.runApprovedCommand(project.id, staged.proposalId);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /RuntimeError: boom/);
  assert.equal(typeof result.stdout, 'string');
});

test('python_run timeout kills the direct process and fails the proposal', async () => {
  const project = makeProject('myai-python-timeout');
  const tools = createWorkspaceTools({ db, pythonRunTimeoutMs: 500 });
  const staged = await stagePythonRun(
    tools,
    project,
    "import time\nprint('started', flush=True)\ntime.sleep(5)\nopen('LATE.txt', 'w').write('late')\n",
  );

  assert.throws(
    () => tools.runApprovedCommand(project.id, staged.proposalId),
    (error) => error.status === 504 && /timed out/i.test(error.message),
  );
  assert.equal(statusOf(project.id, staged.proposalId).status, 'failed');
  await delay(1200);
  assert.equal(fs.existsSync(path.join(project.root, 'LATE.txt')), false,
    'a timed-out Python process must not continue writing after the timeout');
});

test('combined stdout/stderr output limit is enforced after execution', async () => {
  const project = makeProject('myai-python-output');
  const tools = createWorkspaceTools({ db, pythonRunMaxOutputBytes: 128 });
  const staged = await stagePythonRun(
    tools,
    project,
    "import sys\nsys.stdout.write('a' * 100)\nsys.stderr.write('b' * 100)\n",
  );

  assert.throws(
    () => tools.runApprovedCommand(project.id, staged.proposalId),
    (error) => error.status === 413 && /combined stdout\/stderr limit/i.test(error.message),
  );
  assert.equal(statusOf(project.id, staged.proposalId).status, 'failed');
  assert.equal(statusOf(project.id, staged.proposalId).result_json, null);
});

test('generated Python does not inherit backend secrets from the environment', async () => {
  const secret = 'never-hand-this-to-generated-python';
  process.env.MYAI_PYTHON_INTEGRATION_SECRET = secret;
  try {
    const project = makeProject('myai-python-env');
    const tools = createWorkspaceTools({ db });
    const staged = await stagePythonRun(
      tools,
      project,
      "import os\nprint('secret=' + os.environ.get('MYAI_PYTHON_INTEGRATION_SECRET', ''))\n",
    );

    const result = tools.runApprovedCommand(project.id, staged.proposalId);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /secret=$/m);
    assert.equal(result.stdout.includes(secret), false);
  } finally {
    delete process.env.MYAI_PYTHON_INTEGRATION_SECRET;
  }
});

test('a python_run approval cannot be used from another project', async () => {
  const owner = makeProject('myai-python-owner');
  const other = makeProject('myai-python-other');
  const tools = createWorkspaceTools({ db });
  const staged = await stagePythonRun(
    tools,
    owner,
    "from pathlib import Path\nPath('RAN').write_text('yes')\n",
  );

  assert.throws(() => tools.runApprovedCommand(other.id, staged.proposalId), /not found/i);
  assert.equal(fs.existsSync(path.join(owner.root, 'RAN')), false);
  assert.equal(statusOf(owner.id, staged.proposalId).status, 'pending');
});

test('the task system stages python_run for approval and finalizes after execution', async () => {
  const project = makeProject('myai-python-task');
  const tools = createWorkspaceTools({ db, allowProjectCommands: true });
  const source = "from pathlib import Path\nPath('TASK_RAN').write_text('yes')\nprint('task python ok')\n";
  writePython(project, source);

  let calls = 0;
  const provider = {
    name: 'fake',
    model: 'fake-1',
    supportsTools: true,
    chat: async () => {
      calls += 1;
      if (calls === 1) {
        return { text: JSON.stringify({ summary: 'inspected', needsChanges: true }) };
      }
      return {
        text: JSON.stringify({
          summary: 'run python',
          changes: [],
          commands: [{ command: 'python_run', path: 'run.py', goal: 'verify' }],
        }),
      };
    },
  };
  const task = createTask(db, {
    projectId: project.id,
    instruction: 'Run the approved Python check.',
    autonomy: 'propose',
  });
  const executor = createTaskExecutor({
    db,
    provider,
    tools,
    logger: silentLogger,
    retryDelaysMs: [0, 0],
  });
  const runner = createTaskRunner({
    db,
    executor,
    logger: silentLogger,
    cancelPollMs: 10,
    pollIntervalMs: 10,
  });

  try {
    const planning = await runner.tick();
    assert.equal(planning.status, 'waiting_approval');
    const proposal = db
      .prepare("SELECT * FROM proposals WHERE project_id = ? AND kind = 'command' AND command = 'python_run'")
      .get(project.id);
    assert.ok(proposal, 'the task planner must stage a Python proposal, not execute it');
    assert.equal(proposal.status, 'pending');
    assert.equal(fs.existsSync(path.join(project.root, 'TASK_RAN')), false);

    tools.runApprovedCommand(project.id, proposal.id);
    const finalized = await runner.tick();
    assert.notEqual(finalized.status, 'waiting_approval');
    assert.equal(fs.readFileSync(path.join(project.root, 'TASK_RAN'), 'utf8'), 'yes');
  } finally {
    runner.stop();
  }
});

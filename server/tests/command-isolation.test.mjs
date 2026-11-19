// F1 regression tests: project `npm_*` commands and python_run are disabled in
// multi-user (auth-enabled) deployments until a real sandbox exists. Only
// `node_check` and `python_check` (non-executing syntax checks) survive. The same
// restriction is enforced by `runSafeCommand` and `stageCommand`, so neither the
// HTTP approval flow nor the background task executor can run arbitrary project
// code. python_run remains available only in trusted single-user mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { openDb } from '../src/db/index.js';
import { createWorkspaceTools } from '../src/ai/tools.js';
import { createTaskRunner } from '../src/tasks/runner.js';
import { createTaskExecutor } from '../src/tasks/executor.js';
import { createTask, listSteps } from '../src/tasks/store.js';
import { createApp } from '../src/index.js';
import { config } from '../src/config.js';

const servers = [];
const tempDirs = [];
let db = openDb();
const silentLogger = { info() {}, error() {} };

process.env.MYAI_TEST_SECRET = 'do-not-leak-this-secret';

let server;
let base;
let tools; // multi-user tools: auth-enabled createApp disables npm_* scripts

async function request(method, pathname, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + pathname, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* non-JSON response */ }
  return { status: res.status, data };
}

async function register(email) {
  const { status, data } = await request('POST', '/api/auth/register', {
    body: { email, password: 'correct-horse-battery', bootstrapToken: 'test-bootstrap-token' },
  });
  assert.equal(status, 201, `could not register ${email}: ${JSON.stringify(data)}`);
  return data;
}

async function createProject(token, name) {
  const { status, data } = await request('POST', '/api/projects', { token, body: { name } });
  assert.equal(status, 201, `could not create ${name}: ${JSON.stringify(data)}`);
  return data.project.id;
}

function workspaceDir(id) {
  return path.join(config.workspaceRoot, String(id));
}

async function startAuthServer() {
  const created = createApp({ provider: null }); // auth defaults on -> npm_* disabled
  db = created.db;
  tools = created.tools;
  server = created.app.listen(0);
  await once(server, 'listening');
  servers.push(server);
  base = `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  await startAuthServer();
});

after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

test('multi-user tools only expose non-executing checks in run_command declarations', () => {
  const decl = tools.declarations[0].functionDeclarations.find((d) => d.name === 'run_command');
  assert.deepEqual(decl.parameters.properties.command.enum, ['node_check', 'python_check']);
});

test('ordinary account cannot stage npm_test via auth-enabled app', async () => {
  const alice = await register('alice-ci@example.com');
  const projectId = await createProject(alice.token, 'CI project');

  const projectRoot = workspaceDir(projectId);
  const leakScript = 'node -e "require(\'fs\').writeFileSync(\'LEAK.txt\', process.env.MYAI_TEST_SECRET || \'marker\')"';
  fs.writeFileSync(path.join(projectRoot, 'package.json'),
    JSON.stringify({ scripts: { test: leakScript } }));

  await assert.rejects(
    tools.execute('run_command', { projectId, command: 'npm_test' }),
    /multi-user/,
    'staging npm_test must be refused with multi-user message',
  );
  // No proposal row may remain for a refused command.
  const row = db.prepare('SELECT id FROM proposals WHERE project_id = ? AND kind = ? AND command = ?').get(projectId, 'command', 'npm_test');
  assert.equal(row, undefined, 'no pending npm_test proposal after refusal');
  assert.equal(fs.existsSync(path.join(projectRoot, 'LEAK.txt')), false, 'arbitrary script must never execute');
});

test('node_check still runs in multi-user mode', async () => {
  const alice = await register('alice-nc@example.com');
  const projectId = await createProject(alice.token, 'node-check project');

  const projectRoot = workspaceDir(projectId);
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'ok.js'), 'export const answer = 1;\n');

  const staged = await tools.execute('run_command', { projectId, command: 'node_check', path: 'ok.js' });
  assert.equal(staged.status, 'awaiting_user_approval');
  assert.match(staged.note, /awaiting approval/);

  const res = await request('POST', `/api/projects/${projectId}/commands/${staged.proposalId}/run`, { token: alice.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.result.exitCode, 0, 'node_check succeeds without executing scripts');
});

test('background task executor cannot stage or run npm_test under autonomous autonomy', async () => {
  const autonomousTools = createWorkspaceTools({ db, allowProjectCommands: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-autonomous-'));
  tempDirs.push(root);
  const inserted = db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('autonomous', root);
  const projectId = Number(inserted.lastInsertRowid);
  fs.mkdirSync(projectId ? path.join(root) : root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('LEAK2.txt', process.env.MYAI_TEST_SECRET || 'marker')"` } }));

  let callCount = 0;
  const provider = {
    name: 'fake',
    model: 'fake-1',
    supportsTools: true,
    chat: async ({ tools }) => {
      callCount += 1;
      assert.ok(typeof tools?.execute === 'function');
      if (callCount === 1) {
        return { text: JSON.stringify({ summary: 'inspect', needsChanges: true }), provider: 'fake', model: 'fake-1' };
      }
      return {
        text: JSON.stringify({
          summary: 'verify',
          changes: [],
          commands: [{ command: 'npm_test', goal: 'verify' }],
        }),
        provider: 'fake',
        model: 'fake-1',
      };
    },
  };

  const task = createTask(db, { projectId, instruction: 'verify the project', autonomy: 'allow_writes_and_commands' });
  const executor = createTaskExecutor({ db, provider, tools: autonomousTools, logger: silentLogger, retryDelaysMs: [0, 0] });
  const runner = createTaskRunner({ db, executor, logger: silentLogger, cancelPollMs: 10, pollIntervalMs: 10 });
  try {
    const result = await runner.tick();
    assert.ok(result.status === 'completed' || result.status === 'failed');
  } finally {
    runner.stop();
  }

  const steps = listSteps(db, task.id);
  assert.ok(steps.some((step) => step.title === 'Failed to stage command (npm_test)'), JSON.stringify(steps));
  const proposals = db.prepare('SELECT id FROM proposals WHERE project_id = ? AND kind = ? AND command = ?').all(projectId, 'command', 'npm_test');
  assert.deepEqual(proposals, [], 'no npm_test proposal may be staged in autonomous multi-user mode');
  assert.equal(fs.existsSync(path.join(root, 'LEAK2.txt')), false, 'autonomous mode must never execute npm scripts');
});

test('python_check parses a .py file without executing it in multi-user mode', async () => {
  const alice = await register('alice-pycheck@example.com');
  const projectId = await createProject(alice.token, 'Python check project');
  const projectRoot = workspaceDir(projectId);
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'side_effect.py'),
    "from pathlib import Path\nPath('PY_CHECK_RAN').write_text('yes')\n",
  );

  const staged = await tools.execute('run_command', {
    projectId,
    command: 'python_check',
    path: 'side_effect.py',
  });
  assert.equal(staged.status, 'awaiting_user_approval');

  const res = await request('POST', `/api/projects/${projectId}/commands/${staged.proposalId}/run`, {
    token: alice.token,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.result.exitCode, 0, 'valid Python should pass ast.parse');
  assert.equal(fs.existsSync(path.join(projectRoot, 'PY_CHECK_RAN')), false,
    'python_check must parse, not execute, project code');
});

test('ordinary account cannot stage python_run via auth-enabled app', async () => {
  const alice = await register('alice-pyrun@example.com');
  const projectId = await createProject(alice.token, 'Python run project');
  const projectRoot = workspaceDir(projectId);
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'run.py'), "print('must not run')\n");

  await assert.rejects(
    tools.execute('run_command', { projectId, command: 'python_run', path: 'run.py' }),
    /multi-user/,
    'python_run must be refused without a sandbox',
  );
  const row = db.prepare(
    'SELECT id FROM proposals WHERE project_id = ? AND kind = ? AND command = ?',
  ).get(projectId, 'command', 'python_run');
  assert.equal(row, undefined, 'no pending python_run proposal after refusal');
});

test('trusted single-user mode can run an explicitly approved python_run', async () => {
  const trustedTools = createWorkspaceTools({ db, allowProjectCommands: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-trusted-python-'));
  tempDirs.push(root);
  const inserted = db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('trusted-python', root);
  const projectId = Number(inserted.lastInsertRowid);
  fs.writeFileSync(
    path.join(root, 'run.py'),
    "from pathlib import Path\nPath('RAN.txt').write_text('ran')\nprint('python_run ok')\n",
  );

  const staged = await trustedTools.execute('run_command', {
    projectId,
    command: 'python_run',
    path: 'run.py',
  });
  assert.equal(staged.status, 'awaiting_user_approval');
  const result = trustedTools.runApprovedCommand(projectId, staged.proposalId);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /python_run ok/);
  assert.equal(fs.readFileSync(path.join(root, 'RAN.txt'), 'utf8'), 'ran');
});

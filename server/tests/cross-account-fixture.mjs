// Shared backend checks for the two-account cross-account regression suite.
// Each calling test file owns its own process/env (SQLite or PGlite), so these
// checks never touch production data or a shared browser session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { createTask, savePlan } from '../src/tasks/store.js';
import { authorizeFirstAccount } from './setup-authorization.mjs';

const PASSWORD = 'synthetic-cross-account-password';

export function runCrossAccountBackendChecks({ label, createApp, cleanup = () => {} }) {
  const tempDirs = [];
  const seenChatProjects = [];
  const seenChatTools = [];
  let server;
  let db;
  let base;
  let tools;
  let accountA;
  let accountB;
  let projectA;
  let projectB;
  let taskA;
  let taskB;
  let proposalA;

  const provider = {
    name: 'cross-account-spy',
    model: 'local-test',
    async chat({ projectId, tools } = {}) {
      seenChatProjects.push(projectId ?? null);
      seenChatTools.push(Boolean(tools));
      return { text: 'Local synthetic reply.', provider: 'cross-account-spy', model: 'local-test' };
    },
  };

  async function request(method, pathname, { token, body } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(base + pathname, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }

  async function register(email) {
    const setupToken = await authorizeFirstAccount(base);
    const result = await request('POST', '/api/auth/register', {
      body: { email, password: PASSWORD, setupToken },
    });
    assert.equal(result.status, 201, `${label}: registration failed with HTTP ${result.status}`);
    return { ...result.data, email: result.data.user.email };
  }

  async function createProject(token, name) {
    const result = await request('POST', '/api/projects', {
      token,
      body: { name },
    });
    assert.equal(result.status, 201, `${label}: project creation failed with HTTP ${result.status}`);
    return result.data.project.id;
  }

  before(async () => {
    const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-cross-account-import-'));
    tempDirs.push(importRoot);

    const created = createApp({ provider, projectImportRoot: importRoot });
    db = created.db;
    tools = created.tools;
    server = created.app.listen(0);
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    accountA = await register(`account-a-${suffix}@synthetic.test`);
    accountB = await register(`account-b-${suffix}@synthetic.test`);
    projectA = await createProject(accountA.token, `Account A workspace ${suffix}`);
    projectB = await createProject(accountB.token, `Account B workspace ${suffix}`);

    const createdA = await request('POST', '/api/tasks', {
      token: accountA.token,
      body: { projectId: projectA, instruction: 'Synthetic task owned by account A' },
    });
    assert.equal(createdA.status, 201, `${label}: task A creation failed with HTTP ${createdA.status}`);
    taskA = createdA.data.task;

    const createdB = await request('POST', '/api/tasks', {
      token: accountB.token,
      body: { projectId: projectB, instruction: 'Synthetic task owned by account B' },
    });
    assert.equal(createdB.status, 201, `${label}: task B creation failed with HTTP ${createdB.status}`);
    taskB = createdB.data.task;

    proposalA = tools.stageFileChange({
      projectId: projectA,
      kind: 'create',
      path: 'account-a-only.js',
      content: 'export const owner = "account-a";\n',
    });
    savePlan(db, taskA.id, {
      version: 1,
      summary: 'Synthetic pending proposal for account A',
      proposals: [{ id: proposalA.id }],
      currentStep: 0,
      repairAttempt: 0,
    });
  });

  after(async () => {
    // Node runs after() hooks even when a test fails. Keep cleanup in finally
    // so a shutdown error cannot leave PGlite workers or temp data behind.
    try {
      if (server) {
        server.closeAllConnections?.();
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      try {
        db?.close?.();
      } catch {
        /* Best effort cleanup during shutdown. */
      }
      for (const dir of tempDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* Best effort cleanup of isolated temp data. */
        }
      }
      await cleanup();
    }
  });

  test(`${label}: each account sees only its own projects, tasks, and chat scope`, async () => {
    const listA = await request('GET', '/api/projects', { token: accountA.token });
    const listB = await request('GET', '/api/projects', { token: accountB.token });
    assert.equal(listA.status, 200);
    assert.equal(listB.status, 200);
    const idsA = listA.data.projects.map((project) => project.id);
    const idsB = listB.data.projects.map((project) => project.id);
    assert.ok(idsA.includes(projectA));
    assert.ok(!idsA.includes(projectB));
    assert.ok(idsB.includes(projectB));
    assert.ok(!idsB.includes(projectA));

    const tasksA = await request('GET', `/api/tasks?projectId=${projectA}`, { token: accountA.token });
    const tasksB = await request('GET', `/api/tasks?projectId=${projectB}`, { token: accountB.token });
    assert.equal(tasksA.status, 200);
    assert.equal(tasksB.status, 200);
    assert.ok(tasksA.data.tasks.some((task) => task.id === taskA.id));
    assert.ok(!tasksA.data.tasks.some((task) => task.id === taskB.id));
    assert.ok(tasksB.data.tasks.some((task) => task.id === taskB.id));
    assert.ok(!tasksB.data.tasks.some((task) => task.id === taskA.id));

    const chatA = await request('POST', '/api/chat', {
      token: accountA.token,
      body: { messages: [{ role: 'user', content: 'Synthetic chat from A' }], projectId: projectA },
    });
    assert.equal(chatA.status, 200);
    assert.equal(seenChatProjects.at(-1), Number(projectA));
    assert.equal(seenChatTools.at(-1), true);
    assert.equal(chatA.data.workspace.available, true);
    assert.equal(chatA.data.workspace.projectId, Number(projectA));

    const chatB = await request('POST', '/api/chat', {
      token: accountB.token,
      body: { messages: [{ role: 'user', content: 'Synthetic chat from B' }], projectId: projectB },
    });
    assert.equal(chatB.status, 200);
    assert.equal(seenChatProjects.at(-1), Number(projectB));
    assert.equal(seenChatTools.at(-1), true);
    assert.equal(chatB.data.workspace.available, true);
    assert.equal(chatB.data.workspace.projectId, Number(projectB));

    const foreignChat = await request('POST', '/api/chat', {
      token: accountB.token,
      body: { messages: [{ role: 'user', content: 'Synthetic foreign chat' }], projectId: projectA },
    });
    assert.equal(foreignChat.status, 200);
    assert.equal(seenChatProjects.at(-1), null, `${label}: B must not arm A's workspace for chat`);
    assert.equal(seenChatTools.at(-1), false, `${label}: B must not receive A's workspace tools`);
    assert.equal(foreignChat.data.workspace.available, false);
    assert.equal(foreignChat.data.workspace.projectId, null);
    assert.equal(foreignChat.data.workspace.reason, 'workspace_unavailable');
  });

  test(`${label}: direct API requests cannot reach another owner's data`, async () => {
    const deniedPaths = [
      `/api/projects/${projectA}/tree`,
      `/api/projects/${projectA}/files`,
      `/api/projects/${projectA}/file?path=account-a-only.js`,
      `/api/projects/${projectA}/search?q=owner`,
      `/api/projects/${projectA}/proposals`,
      `/api/tasks/${taskA.id}`,
    ];
    for (const pathname of deniedPaths) {
      const result = await request('GET', pathname, { token: accountB.token });
      assert.equal(result.status, 404, `${label}: GET ${pathname} must be owner-scoped`);
      assert.equal(result.data?.ok, false);
    }

    const beforeTasks = await request('GET', `/api/tasks?projectId=${projectA}`, { token: accountA.token });
    const beforeDetail = await request('GET', `/api/tasks/${taskA.id}`, { token: accountA.token });
    assert.equal(beforeTasks.status, 200);
    assert.equal(beforeDetail.status, 200);
    const proposalSummary = (detail) => (detail.data.proposals || []).map((proposal) => ({
      proposalId: proposal.proposalId,
      status: proposal.status,
      result: proposal.result ?? null,
      error: proposal.error ?? null,
    }));

    const forbiddenMutations = [
      ['POST', '/api/tasks', { projectId: projectA, instruction: 'Foreign synthetic task' }],
      ['POST', `/api/tasks/${taskA.id}/cancel`, undefined],
      ['POST', `/api/projects/${projectA}/proposals/${proposalA.id}/apply`, undefined],
      ['POST', `/api/projects/${projectA}/proposals/${proposalA.id}/reject`, undefined],
      ['POST', `/api/projects/${projectA}/commands/${proposalA.id}/run`, undefined],
    ];
    for (const [method, pathname, body] of forbiddenMutations) {
      const result = await request(method, pathname, { token: accountB.token, body });
      assert.equal(result.status, 404, `${label}: ${method} ${pathname} must be owner-scoped`);
      assert.equal(result.data?.ok, false);
    }

    // A denial must be more than a status code: read A's records back and
    // prove that none of the rejected mutations changed them.
    const owned = await request('GET', `/api/tasks/${taskA.id}`, { token: accountA.token });
    const afterTasks = await request('GET', `/api/tasks?projectId=${projectA}`, { token: accountA.token });
    assert.equal(owned.status, 200);
    assert.equal(afterTasks.status, 200);
    assert.equal(owned.data.task.id, taskA.id);
    assert.equal(owned.data.task.status, beforeDetail.data.task.status);
    assert.deepEqual(
      afterTasks.data.tasks.map((task) => task.id),
      beforeTasks.data.tasks.map((task) => task.id),
      `${label}: a foreign task POST must not create a record`,
    );
    assert.ok(
      !afterTasks.data.tasks.some((task) => task.instruction === 'Foreign synthetic task'),
      `${label}: no foreign synthetic task may be stored`,
    );
    assert.deepEqual(proposalSummary(owned), proposalSummary(beforeDetail),
      `${label}: foreign proposal/command decisions must not change A's plan`);
    assert.equal(owned.data.proposals.length, 1);
    assert.equal(owned.data.proposals[0].proposalId, proposalA.id);
    assert.equal(owned.data.proposals[0].status, 'pending');
  });

  test(`${label}: logout ends a session and login restores only that account`, async () => {
    const logout = await request('POST', '/api/auth/logout', { token: accountA.token });
    assert.equal(logout.status, 200, `${label}: logout failed with HTTP ${logout.status}`);

    const expired = await request('GET', '/api/auth/me', { token: accountA.token });
    assert.equal(expired.status, 401);
    assert.equal(expired.data?.code, 'AUTH_REQUIRED');

    const otherSession = await request('GET', '/api/auth/me', { token: accountB.token });
    assert.equal(otherSession.status, 200, `${label}: logging out A must not end B`);

    const relogin = await request('POST', '/api/auth/login', {
      body: { email: accountA.email, password: PASSWORD },
    });
    assert.equal(relogin.status, 200, `${label}: login failed with HTTP ${relogin.status}`);
    const restored = await request('GET', '/api/auth/me', { token: relogin.data.token });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.user.id, accountA.user.id);

    const projects = await request('GET', '/api/projects', { token: relogin.data.token });
    assert.equal(projects.status, 200);
    const ids = projects.data.projects.map((project) => project.id);
    assert.ok(ids.includes(projectA));
    assert.ok(!ids.includes(projectB));

    const tasks = await request('GET', '/api/tasks', { token: relogin.data.token });
    assert.equal(tasks.status, 200);
    assert.ok(tasks.data.tasks.some((task) => task.id === taskA.id));
    assert.ok(!tasks.data.tasks.some((task) => task.id === taskB.id));
  });
}

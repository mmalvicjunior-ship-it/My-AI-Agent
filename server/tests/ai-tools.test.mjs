import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorkspaceTools } from '../src/ai/tools.js';

test('create_file stages a new file and only writes after approval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-tools-'));
  const project = { id: 910001, name: 'tool-test', root_path: root };
  const db = {
    prepare() {
      return { get: (id) => (id === project.id ? project : null) };
    },
  };
  const tools = createWorkspaceTools({ db });

  try {
    const proposal = tools.execute('create_file', {
      projectId: project.id,
      path: 'src/new.js',
      content: 'export const value = 42;\n',
    });
    return proposal.then((staged) => {
      assert.equal(staged.status, 'awaiting_user_approval');
      assert.equal(fs.existsSync(path.join(root, 'src', 'new.js')), false);
      const applied = tools.applyProposal(project.id, staged.proposalId);
      assert.equal(applied.path, 'src/new.js');
      assert.equal(fs.readFileSync(path.join(root, 'src', 'new.js'), 'utf8'), 'export const value = 42;\n');
      assert.throws(() => tools.applyProposal(project.id, staged.proposalId), /not found/);
    }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
});

test('run_command rejects anything outside the safe command allowlist', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-tools-'));
  const project = { id: 910002, name: 'tool-test', root_path: root };
  const db = {
    prepare() {
      return { get: (id) => (id === project.id ? project : null) };
    },
  };
  const tools = createWorkspaceTools({ db });
  try {
    await assert.rejects(
      tools.execute('run_command', { projectId: project.id, command: 'powershell -Command whoami' }),
      /allowlist/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run_command stages approved npm scripts without executing before approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-command-'));
  const project = { id: 910003, name: 'tool-test', root_path: root };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const db = {
    prepare() {
      return { get: (id) => (id === project.id ? project : null) };
    },
  };
  const tools = createWorkspaceTools({ db });
  try {
    const staged = await tools.execute('run_command', { projectId: project.id, command: 'npm_test' });
    assert.equal(staged.status, 'awaiting_user_approval');
    const result = tools.runApprovedCommand(project.id, staged.proposalId);
    assert.equal(result.exitCode, 0);
    assert.throws(() => tools.runApprovedCommand(project.id, staged.proposalId), /not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('existing-file changes require approval and reject stale proposals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-file-change-'));
  const project = { id: 910004, name: 'tool-test', root_path: root };
  fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'approved.js'), 'export const ready = false;\n');
  const db = {
    prepare() {
      return { get: (id) => (id === project.id ? project : null) };
    },
  };
  const tools = createWorkspaceTools({ db });

  try {
    const approved = await tools.execute('propose_file_change', {
      projectId: project.id,
      path: 'approved.js',
      content: 'export const ready = true;\n',
    });
    assert.equal(approved.originalContent, 'export const ready = false;\n');
    assert.equal(fs.readFileSync(path.join(root, 'approved.js'), 'utf8'), 'export const ready = false;\n');
    tools.applyProposal(project.id, approved.proposalId);
    assert.equal(fs.readFileSync(path.join(root, 'approved.js'), 'utf8'), 'export const ready = true;\n');

    const proposal = await tools.execute('propose_file_change', {
      projectId: project.id,
      path: 'app.js',
      content: 'export const value = 2;\n',
    });
    assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 3;\n');
    assert.throws(
      () => tools.applyProposal(project.id, proposal.proposalId),
      /changed since the proposal/,
    );
    assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'export const value = 3;\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

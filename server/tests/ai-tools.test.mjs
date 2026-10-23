import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorkspaceTools } from '../src/ai/tools.js';
import { openDb } from '../src/db/index.js';

// Proposals are persisted now, so these tests use the real (temporary, see
// tests/setup-test-env.mjs) SQLite database instead of a stub.
const db = openDb();

function makeProject(prefix = 'tool-test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const inserted = db
    .prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
    .run(prefix, root);
  return { id: Number(inserted.lastInsertRowid), root };
}

test('create_file stages a new file and only writes after approval', () => {
  const project = makeProject();
  const tools = createWorkspaceTools({ db });

  try {
    const proposal = tools.execute('create_file', {
      projectId: project.id,
      path: 'src/new.js',
      content: 'export const value = 42;\n',
    });
    return proposal.then((staged) => {
      assert.equal(staged.status, 'awaiting_user_approval');
      assert.equal(fs.existsSync(path.join(project.root, 'src', 'new.js')), false);
      const applied = tools.applyProposal(project.id, staged.proposalId);
      assert.equal(applied.path, 'src/new.js');
      assert.equal(fs.readFileSync(path.join(project.root, 'src', 'new.js'), 'utf8'), 'export const value = 42;\n');
      assert.throws(() => tools.applyProposal(project.id, staged.proposalId), /not found/);
    }).finally(() => fs.rmSync(project.root, { recursive: true, force: true }));
  } catch (error) {
    fs.rmSync(project.root, { recursive: true, force: true });
    throw error;
  }
});

test('create_file refuses paths that could never be applied', async () => {
  const project = makeProject('myai-bad-path');
  const tools = createWorkspaceTools({ db });
  try {
    const cases = [
      ['../escape.js', /escapes/],
      ['C:\\Windows\\Temp\\escape.js', /valid relative/],
      ['.env', /credential/],
    ];
    for (const [badPath, pattern] of cases) {
      await assert.rejects(
        tools.execute('create_file', { projectId: project.id, path: badPath, content: 'nope\n' }),
        pattern,
        `expected ${badPath} to be refused at staging time`,
      );
    }
    assert.equal(tools.listProposals(project.id).proposals.length, 0,
      'an impossible path must not be left as a pending proposal');
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('run_command rejects anything outside the safe command allowlist', async () => {
  const project = makeProject();
  const tools = createWorkspaceTools({ db });
  try {
    await assert.rejects(
      tools.execute('run_command', { projectId: project.id, command: 'powershell -Command whoami' }),
      /allowlist/,
    );
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('run_command stages approved npm scripts without executing before approval', async () => {
  const project = makeProject('myai-command');
  fs.writeFileSync(path.join(project.root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --version' } }));
  const tools = createWorkspaceTools({ db });
  try {
    const staged = await tools.execute('run_command', { projectId: project.id, command: 'npm_test' });
    assert.equal(staged.status, 'awaiting_user_approval');
    const result = tools.runApprovedCommand(project.id, staged.proposalId);
    assert.equal(result.exitCode, 0);
    assert.throws(() => tools.runApprovedCommand(project.id, staged.proposalId), /not found/);
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('a discarded proposal is removed and can never be applied or run', async () => {
  const project = makeProject('myai-discard');
  fs.writeFileSync(path.join(project.root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --version' } }));
  const tools = createWorkspaceTools({ db });
  try {
    const staged = await tools.execute('create_file', {
      projectId: project.id,
      path: 'gone.js',
      content: 'export const gone = true;\n',
    });
    assert.equal(tools.listProposals(project.id).proposals.length, 1);

    assert.deepEqual(
      tools.rejectProposal(project.id, staged.proposalId),
      { proposalId: staged.proposalId, status: 'rejected' },
    );
    assert.equal(tools.listProposals(project.id).proposals.length, 0);
    assert.throws(() => tools.applyProposal(project.id, staged.proposalId), /not found/i);
    assert.equal(fs.existsSync(path.join(project.root, 'gone.js')), false);

    // Commands use the same store, so a discarded command cannot be run either.
    const command = await tools.execute('run_command', { projectId: project.id, command: 'npm_test' });
    assert.equal(tools.rejectProposal(project.id, command.proposalId).status, 'rejected');
    assert.throws(() => tools.runApprovedCommand(project.id, command.proposalId), /not found/i);

    // Rejecting an unknown proposal, or one that belongs to another project, is a 404.
    assert.throws(() => tools.rejectProposal(project.id, 'no-such-proposal'), /not found/i);
    const keep = await tools.execute('create_file', {
      projectId: project.id,
      path: 'kept.js',
      content: 'export const kept = true;\n',
    });
    assert.throws(() => tools.rejectProposal(project.id + 999999, keep.proposalId), /not found/i);
    assert.equal(tools.listProposals(project.id).proposals.length, 1);
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

test('existing-file changes require approval and reject stale proposals', async () => {
  const project = makeProject('myai-file-change');
  fs.writeFileSync(path.join(project.root, 'app.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(project.root, 'approved.js'), 'export const ready = false;\n');
  const tools = createWorkspaceTools({ db });

  try {
    const approved = await tools.execute('propose_file_change', {
      projectId: project.id,
      path: 'approved.js',
      content: 'export const ready = true;\n',
    });
    assert.equal(approved.originalContent, 'export const ready = false;\n');
    assert.equal(fs.readFileSync(path.join(project.root, 'approved.js'), 'utf8'), 'export const ready = false;\n');
    tools.applyProposal(project.id, approved.proposalId);
    assert.equal(fs.readFileSync(path.join(project.root, 'approved.js'), 'utf8'), 'export const ready = true;\n');

    const proposal = await tools.execute('propose_file_change', {
      projectId: project.id,
      path: 'app.js',
      content: 'export const value = 2;\n',
    });
    assert.equal(fs.readFileSync(path.join(project.root, 'app.js'), 'utf8'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(project.root, 'app.js'), 'export const value = 3;\n');
    assert.throws(
      () => tools.applyProposal(project.id, proposal.proposalId),
      /changed since the proposal/,
    );
    assert.equal(fs.readFileSync(path.join(project.root, 'app.js'), 'utf8'), 'export const value = 3;\n');
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true });
  }
});

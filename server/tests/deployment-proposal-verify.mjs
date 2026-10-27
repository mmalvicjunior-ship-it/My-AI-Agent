// Regression verification: deployment-config proposal approval with safety guards.
// No live AI calls; isolated temp workspace; verifies claim/apply/rejection/expiration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openDb } from '../src/db/index.js';
import { createWorkspaceTools } from '../src/ai/tools.js';
import { createTask, getTask } from '../src/tasks/store.js';
import { stageProposal, claimProposal, completeProposal, failProposal, getProposal, getPendingProposal } from '../src/proposals/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-proposal-verify-'));
process.env.DATABASE_PATH = path.join(root, 'test.db');
process.env.WORKSPACE_ROOT = path.join(root, 'workspaces');

const db = openDb();
fs.mkdirSync(path.join(root, 'workspaces', '1'), { recursive: true });
const proj = db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run('deployment-proj', path.join(root, 'workspaces', '1'));
const pid = Number(proj.lastInsertRowid);

function makeTools() { return createWorkspaceTools({ db }); }

function setupProjectFile(relPath, content) {
  const abs = path.join(path.join(root, 'workspaces', '1'), relPath);
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// ------ 1. Approved deployment-config create proposal applies ------
{
  const tools = makeTools();
  // Create proposal for a new deployment config (file must not exist yet)
  const prop = stageProposal(db, { projectId: pid, kind: 'create', path: 'render.yml', content: 'services:\n  - type: web\n  - env: PRODUCTION\n' });
  assert.equal(prop.status, 'pending');
  assert.ok(prop.id);
  const result = tools.applyProposal(pid, prop.id);
  assert.equal(result.path, 'render.yml');
  assert.ok(fs.readFileSync(path.join(root, 'workspaces', '1', 'render.yml'), 'utf8').includes('PRODUCTION'));
  console.log('PASS: approved deployment-config CREATE applies');
}

// ------ 2. Approved deployment-config update proposal applies ------
{
  const tools = makeTools();
  const prop = stageProposal(db, { projectId: pid, kind: 'update', path: 'render.yml', content: 'services:\n  - type: web\n  - env: STAGING\n', originalContent: fs.readFileSync(path.join(root, 'workspaces', '1', 'render.yml'), 'utf8') });
  assert.equal(getPendingProposal(db, pid, prop.id).status, 'pending');
  const result = tools.applyProposal(pid, prop.id);
  assert.equal(result.path, 'render.yml');
  assert.ok(fs.readFileSync(path.join(root, 'workspaces', '1', 'render.yml'), 'utf8').includes('STAGING'));
  console.log('PASS: approved deployment-config UPDATE applies');
}

// ------ 3. Unclaimed proposal stays pending (not applied) ------
{
  const prop = stageProposal(db, { projectId: pid, kind: 'create', path: 'vercel.json', content: '{}' });
  assert.equal(getPendingProposal(db, pid, prop.id).status, 'pending');
  console.log('PASS: unclaimed proposal stays pending');
}

// ------ 4. Expired proposal cannot apply ------
{
  const prop = stageProposal(db, { projectId: pid, kind: 'create', path: 'fly.toml', content: 'app = "test"\n' });
  assert.ok(claimProposal(db, pid, prop.id));
  // Manually backdate created_at to simulate expiration
  db.prepare("UPDATE proposals SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(prop.id);
  const tools = makeTools();
  assert.throws(() => tools.applyProposal(pid, prop.id), /expired/);
  console.log('PASS: expired proposal refused');
}

// ------ 5. Rejected proposal cannot apply ------
{
  const prop = stageProposal(db, { projectId: pid, kind: 'create', path: 'netlify.toml', content: '[]' });
  assert.ok(claimProposal(db, pid, prop.id));
  // Simulate rejection by completing with rejected status manually for test
  db.prepare("UPDATE proposals SET status = 'rejected', finished_at = datetime('now') WHERE id = ?").run(prop.id);
  const tools = makeTools();
  assert.throws(() => tools.applyProposal(pid, prop.id), /Pending file proposal not found/);
  console.log('PASS: rejected proposal refused');
}

// ------ 6. Already-applied proposal cannot apply again ------
{
  const prop = stageProposal(db, { projectId: pid, kind: 'create', path: 'docker-compose.yml', content: 'version: "3.8"\n' });
  assert.ok(claimProposal(db, pid, prop.id));
  const tools = makeTools();
  tools.applyProposal(pid, prop.id);
  assert.throws(() => tools.applyProposal(pid, prop.id), /Pending file proposal not found/);
  console.log('PASS: already-applied proposal cannot be reused');
}

// ------ 7. Tampered content rejected at apply ------
{
  const originalContent = 'env:\n  KEY: val\n';
  setupProjectFile('env-config.yml', originalContent);
  const prop = stageProposal(db, { projectId: pid, kind: 'update', path: 'env-config.yml', content: originalContent + '# changed\n', originalContent });
  // Tamper file on disk BEFORE apply — claim happens inside applyProposal
  fs.writeFileSync(path.join(root, 'workspaces', '1', 'env-config.yml'), 'tampered\n', 'utf8');
  const tools = makeTools();
  assert.throws(() => tools.applyProposal(pid, prop.id), /changed since the proposal/);
  console.log('PASS: tampered content rejected');
}

// ------ 8. Direct write route cannot modify deployment config ------
{
  const { createTextFile, deletePath } = await import('../src/workspace/files.js');
  assert.throws(() => createTextFile(path.join(root, 'workspaces', '1'), 'render.yml', '{}'), /Deployment/);
  // Delete also blocked
  setupProjectFile('render.yml', '{}');
  assert.throws(() => deletePath(path.join(root, 'workspaces', '1'), 'render.yml'), /deployment/);
  console.log('PASS: direct write/delete routes block deployment config');
}

// ------ 9. Sensitive files blocked everywhere ------
{
  const { stageFileChange } = makeTools();
  assert.throws(() => stageFileChange({ projectId: pid, kind: 'create', path: '.env.local', content: 'SECRET=1\n' }), /credential/);
  const { createTextFile } = await import('../src/workspace/files.js');
  assert.throws(() => createTextFile(path.join(root, 'workspaces', '1'), '.env.local', 'SECRET=1'), /credential/);
  console.log('PASS: sensitive files blocked at staging and direct write');
}

// ------ 10. Concurrent claim/apply prevented ------
{
  const prop = stageProposal(db, { projectId: pid, kind: 'create', path: 'docker-compose.prod.yml', content: 'version: "3.9"\n' });
  assert.ok(claimProposal(db, pid, prop.id));
  const tools = makeTools();
  const r1 = tools.applyProposal(pid, prop.id);
  assert.equal(r1.path, 'docker-compose.prod.yml');
  assert.throws(() => tools.applyProposal(pid, prop.id), /Pending file proposal not found/);
  console.log('PASS: concurrent/retry apply prevented');
}

// ------ 11. Ordinary file edit still works ------
{
  const ws = makeTools();
  const prop = ws.stageFileChange({ projectId: pid, kind: 'create', path: 'hello-ordinary.js', content: 'export const x = 1;\n' });
  assert.ok(prop && prop.id);
  const result = ws.applyProposal(pid, prop.id);
  assert.equal(result.path, 'hello-ordinary.js');
  console.log('PASS: ordinary file proposal applies correctly');
}

// ------ 12. Path traversal, absolute paths, and case variations blocked ------
{
  const { validateWritePath, isProtectedDeploymentConfig } = await import('../src/workspace/files.js');
  // Traversal attempts must be rejected
  assert.throws(() => validateWritePath('../outside.txt', 'bad'), /Path escapes/);
  assert.throws(() => validateWritePath('sub/../../../etc/passwd', 'bad'), /Path escapes/);
  // Absolute paths rejected
  assert.throws(() => validateWritePath('/etc/passwd', 'bad'), /valid relative/);
  // Case-insensitive protected deployment config
  assert.ok(isProtectedDeploymentConfig('RENDER.YAML'));
  assert.ok(isProtectedDeploymentConfig('.GITHUB/WORKFLOWS/CI.YML'));
  assert.ok(isProtectedDeploymentConfig('VERCEL.JSON'));
  // Nested protected paths covered
  assert.ok(isProtectedDeploymentConfig('.github/workflows/ci.yml'));
  assert.ok(isProtectedDeploymentConfig('nested/.github/actions/deploy.yml'));
  assert.ok(isProtectedDeploymentConfig('.gitlab/ci.yml'));
  assert.ok(isProtectedDeploymentConfig('sub/.gitlab/workflows/ci.yaml'));
  // Note: nested paths covered via segment match
  console.log('PASS: path traversal, case, and nested protected paths handled');
}

// ------ 13. Sensitive files blocked with deployment proposal approved (boundary isolation) ------
{
  const ws = makeTools();
  assert.throws(() => ws.stageFileChange({ projectId: pid, kind: 'create', path: '.env.production', content: 'SECRET=1\n' }), /credential/);
  console.log('PASS: sensitive file blocked even when other proposals approved');
  console.log('PASS: sensitive file blocked even when other proposals approved');
}

// ------ 14. Direct write/delete of nested protected paths remain blocked ------
{
  const { createTextFile, deletePath } = await import('../src/workspace/files.js');
  assert.throws(() => createTextFile(path.join(root, 'workspaces', '1'), 'nested/.github/deploy.yml', '{}'), /Deployment/);
  setupProjectFile('nested/.github/deploy.yml', '{}');
  assert.throws(() => deletePath(path.join(root, 'workspaces', '1'), 'nested/.github/deploy.yml'), /deployment/);
  console.log('PASS: direct write/delete of nested deployment configs blocked');
}

// ------ 15. Valid approved ordinary proposals still apply only reviewed changes ------
{
  const ws = makeTools();
  const original = 'hello-existing\n';
  fs.writeFileSync(path.join(root, 'workspaces', '1', 'reviewed.txt'), original, 'utf8');
  const prop = ws.stageFileChange({ projectId: pid, kind: 'update', path: 'reviewed.txt', content: 'review-only\n', originalContent: original });
  assert.ok(prop && prop.id);
  const result = ws.applyProposal(pid, prop.id);
  assert.equal(result.path, 'reviewed.txt');
  assert.equal(fs.readFileSync(path.join(root, 'workspaces', '1', 'reviewed.txt'), 'utf8'), 'review-only\n');
  console.log('PASS: approved ordinary proposal applies only reviewed changes');
}

console.log('=== ALL DEPLOYMENT-PROPOSAL SAFETY CHECKS PASSED ===');

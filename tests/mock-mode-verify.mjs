// Focused offline verification for mock-mode communication and simulation safety.
// No external AI requests are made. This verifies that simulated replies clearly
// state they are offline/mock, and that no real workspace changes occur.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { mockProvider } from '../server/src/ai/mock.js';
import { mockToolProvider } from '../server/src/ai/mock-tool.js';
import { resolveInside } from '../server/src/workspace/files.js';

async function testMockCommunicatesSimulated() {
  const result = await mockProvider.chat({ messages: [{ role: 'user', content: 'fix my broken code' }] });
  assert.strictEqual(result.provider, 'mock');
  assert.strictEqual(result.model, 'offline');
  assert(typeof result.text === 'string');
  assert(result.text.includes('offline mock provider') || result.text.includes('simulated/mock mode'),
    'Mock provider must clearly indicate it is offline/simulated when asked about fixes');
  assert(result.text.includes('no real code was generated or fixed'),
    'Mock provider must explicitly deny generating or fixing real code');
  console.log('PASS: mock provider clearly communicates simulated mode for fix requests');
}

async function testMockToolCommunicatesSimulated() {
  const result = await mockToolProvider.chat({
    messages: [{ role: 'user', content: 'autonomous fix test' }],
    projectId: 1,
    signal: new AbortController().signal,
  });
  assert.strictEqual(result.provider, 'mock-tool');
  assert.strictEqual(result.model, 'offline');
  const parsed = JSON.parse(result.text);
  assert.strictEqual(parsed.needsChanges, true);
  assert(typeof parsed.summary === 'string');
  assert(parsed.summary.includes('simulated only') || parsed.summary.includes('simulated'),
    'Mock-tool summary must clearly say it is simulated');
  assert(!parsed.summary.includes('fixed'),
    'Mock-tool must never claim a real fix was applied');
  console.log('PASS: mock-tool provider clearly states simulated mode and denies real fixes');
}

function testWorkspaceContainment() {
  // Verify that workspace operations cannot escape their authorized directory.
  const root = path.resolve('tests/temp-workspace-check');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'allowed.txt'), 'ok');

  // Relative path inside root should succeed.
  const inside = resolveInside(root, 'allowed.txt');
  assert.strictEqual(path.basename(inside.absolute), 'allowed.txt');

  // Absolute paths must be refused.
  assert.throws(() => resolveInside(root, '/etc/passwd'), /Absolute paths are not allowed/);

  // Traversal must be refused.
  assert.throws(() => resolveInside(root, '../outside'), /Path escapes/);

  console.log('PASS: workspace containment verified (absolute and traversal paths refused)');
}

async function runAll() {
  await testMockCommunicatesSimulated();
  await testMockToolCommunicatesSimulated();
  testWorkspaceContainment();
  console.log('PASS: all mock-mode verification tests completed (simulated — not real AI coding)');
}

runAll().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});

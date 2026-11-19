// Pure Task Center helper tests. These run under the existing server test
// runner so no frontend test framework or dependency is required.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  diffLines,
  isProposalActionable,
  linkedProposalIds,
  normalizeDecisionError,
  pendingCountForTask,
  proposalDecisionLabel,
  proposalStatusLabel,
  proposalTypeLabel,
} from '../../apps/web/src/taskProposalHelpers.js';

test('linkedProposalIds handles plan strings, object entries, and malformed plans', () => {
  assert.deepEqual(linkedProposalIds({ plan_json: '{"proposals":["a",{"id":"b"},null,7]}' }), ['a', 'b']);
  assert.deepEqual(linkedProposalIds({ plan_json: { proposals: [{ id: 'x' }, 'y'] } }), ['x', 'y']);
  assert.deepEqual(linkedProposalIds({ plan_json: 'not json' }), []);
  assert.deepEqual(linkedProposalIds({}), []);
  assert.deepEqual(linkedProposalIds({ plan_json: { proposals: null } }), []);
});

test('linkedProposalIds prefers the safe API list over legacy plan_json', () => {
  const task = {
    linkedProposalIds: ['safe-1', '', 'safe-2', 7],
    plan_json: { proposals: ['legacy-only'] },
  };
  assert.deepEqual(linkedProposalIds(task), ['safe-1', 'safe-2']);
  assert.deepEqual(linkedProposalIds({ linkedProposalIds: [] }), []);
});

test('pendingCountForTask counts only linked pending proposal ids', () => {
  const task = { plan_json: '{"proposals":["a",{"id":"b"},"c"]}' };
  assert.equal(pendingCountForTask(task, new Set(['a', 'c', 'unrelated'])), 2);
  assert.equal(pendingCountForTask(task, ['b']), 1);
  assert.equal(pendingCountForTask(task, []), 0);
});

test('proposal labels describe type, status, and action', () => {
  const file = { type: 'file', action: 'create', status: 'pending' };
  const edit = { type: 'file', action: 'update', status: 'applied' };
  const command = { type: 'command', status: 'applied' };

  assert.equal(proposalTypeLabel(file), 'File · Create');
  assert.equal(proposalTypeLabel(edit), 'File · Edit');
  assert.equal(proposalTypeLabel(command), 'Command');

  assert.equal(proposalStatusLabel(file), 'Awaiting approval');
  assert.equal(proposalStatusLabel({ ...file, expired: true }), 'Expired');
  assert.equal(proposalStatusLabel(edit), 'Applied');
  assert.equal(proposalStatusLabel(command), 'Ran');
  assert.equal(proposalStatusLabel({ status: 'rejected' }), 'Rejected');

  assert.equal(proposalDecisionLabel(file, 'approve'), 'Apply file');
  assert.equal(proposalDecisionLabel(command, 'approve'), 'Run command');
  assert.equal(proposalDecisionLabel(command, 'reject'), 'Reject');

  const pythonRun = { type: 'command', command: 'python_run', status: 'pending' };
  const pythonCheck = { type: 'command', command: 'python_check', status: 'pending' };
  assert.equal(proposalTypeLabel(pythonRun), 'Python · Run');
  assert.equal(proposalTypeLabel(pythonCheck), 'Python · Check');
  assert.equal(proposalDecisionLabel(pythonRun, 'approve'), 'Run Python file');
  assert.equal(proposalDecisionLabel(pythonCheck, 'approve'), 'Run Python check');
});

test('isProposalActionable blocks terminal, expired, unknown, and busy proposals', () => {
  const pending = { proposalId: 'p1', type: 'file', status: 'pending' };
  assert.equal(isProposalActionable(pending), true);
  assert.equal(isProposalActionable(pending, 'p2'), true);
  assert.equal(isProposalActionable(pending, 'p1'), false);
  assert.equal(isProposalActionable({ ...pending, expired: true }), false);
  assert.equal(isProposalActionable({ ...pending, status: 'applied' }), false);
  assert.equal(isProposalActionable({ ...pending, status: 'interrupted' }), false);
  assert.equal(isProposalActionable({ ...pending, type: 'unknown' }), false);
  assert.equal(isProposalActionable(null), false);
});

test('normalizeDecisionError maps authorization, expiry, server, and network failures', () => {
  assert.deepEqual(normalizeDecisionError({}, 401).code, 'unauthorized');
  assert.equal(normalizeDecisionError({}, 404).code, 'unavailable');
  assert.equal(normalizeDecisionError({}, 410).code, 'expired');
  assert.equal(normalizeDecisionError({}, 500).code, 'server');
  assert.match(normalizeDecisionError({}, 410).message, /expired/i);
  assert.equal(normalizeDecisionError({ status: 503 }).code, 'server');
  assert.equal(normalizeDecisionError(new Error('custom')).message, 'custom');
  assert.equal(normalizeDecisionError(null).code, 'network');
});

test('diffLines classifies unified diff rows and caps long output', () => {
  const diff = '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new\n unchanged';
  const result = diffLines(diff, 10);
  assert.deepEqual(result.lines.map((line) => line.type), [
    'meta', 'meta', 'meta', 'remove', 'add', 'context',
  ]);
  assert.equal(result.lines[3].text, '-old');
  assert.equal(result.truncated, false);

  const capped = diffLines(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'), 5);
  assert.equal(capped.lines.length, 5);
  assert.equal(capped.truncated, true);
});

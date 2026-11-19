// Pure workspace UI helpers are tested under the server runner because the web
// workspace has no test framework. No React or browser APIs are imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_LIST_LIMIT,
  buildPromptWithAttachment,
  quickActionsFor,
  responseScopeKey,
} from '../../apps/web/src/workspaceUiHelpers.js';

test('task history requests use the API maximum instead of the old 20-item cap', () => {
  assert.equal(TASK_LIST_LIMIT, 100);
});

test('buildPromptWithAttachment embeds a source file only when one is attached', () => {
  assert.equal(buildPromptWithAttachment('Review this.'), 'Review this.');
  assert.equal(buildPromptWithAttachment('Review this.', null), 'Review this.');
  assert.equal(buildPromptWithAttachment('Review this.', { name: 'app.js' }), 'Review this.');

  const prompt = buildPromptWithAttachment('Review this.', {
    name: 'app.js',
    content: 'export const answer = 42;\n',
  });
  assert.match(prompt, /^Review this\./);
  assert.match(prompt, /attached source file "app\.js"/);
  assert.match(prompt, /```\nexport const answer = 42;\n```$/);
});

test('responseScopeKey separates accounts and projects', () => {
  assert.equal(responseScopeKey(null, null), 'anonymous:');
  assert.equal(responseScopeKey('user-1', '7'), 'user-1:7');
  assert.notEqual(responseScopeKey('user-1', '7'), responseScopeKey('user-2', '7'));
  assert.notEqual(responseScopeKey('user-1', '7'), responseScopeKey('user-1', '8'));
});

test('quick actions are empty without a project and hide npm scripts in multi-user mode', () => {
  assert.deepEqual(quickActionsFor(), []);
  assert.deepEqual(quickActionsFor({ hasProject: false, npmScriptsEnabled: true }), []);

  const multiUser = quickActionsFor({ hasProject: true, npmScriptsEnabled: false });
  assert.deepEqual(multiUser.map((action) => action.label), [
    'Inspect project',
    'Find issues',
    'Explain code',
  ]);
  assert.equal(multiUser.some((action) => action.label === 'Run Tests'), false);
});

test('quick actions offer Run Tests only in trusted mode and mention the selected file', () => {
  const trusted = quickActionsFor({
    hasProject: true,
    npmScriptsEnabled: true,
    selectedFile: 'src/app.js',
  });
  assert.deepEqual(trusted.map((action) => action.label), [
    'Inspect project',
    'Find issues',
    'Explain code',
    'Run Tests',
  ]);
  const explain = trusted.find((action) => action.label === 'Explain code');
  assert.match(explain.prompt, /src\/app\.js/);
  const runTests = trusted.find((action) => action.label === 'Run Tests');
  assert.match(runTests.prompt, /stage the safe npm_test check for approval/i);
});

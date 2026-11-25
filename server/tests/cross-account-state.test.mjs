// Two-account regression coverage for the confirmed frontend state leakage.
// Pure state models exercise the real shared helpers and the request-lifecycle
// rules without a React/DOM framework; static assertions tie those rules to the
// handlers in App.jsx. The backend half uses two synthetic accounts and an
// isolated SQLite database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  captureWorkspaceResponseScope,
  isCurrentRequestLifecycle,
  isCurrentWorkspaceResponseScope,
  isCurrentWorkspaceSessionScope,
  responseScopeKey,
} from '../../apps/web/src/workspaceUiHelpers.js';
import { createApp } from '../src/index.js';
import { runCrossAccountBackendChecks } from './cross-account-fixture.mjs';

const APP_SOURCE = fs.readFileSync(
  fileURLToPath(new URL('../../apps/web/src/App.jsx', import.meta.url)),
  'utf8',
);

function topLevelBlock(name) {
  const start = APP_SOURCE.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `missing handler ${name} in App.jsx`);
  const next = APP_SOURCE.indexOf('\n  const ', start + 10);
  return APP_SOURCE.slice(start, next === -1 ? APP_SOURCE.length : next);
}

const clearSource = topLevelBlock('clearWorkspaceState');

function accountScope({ id, token = 'token-a', generation = 1, projectId = '7', authenticated = true }) {
  return captureWorkspaceResponseScope({
    authenticated,
    userId: id,
    token,
    projectId,
    generation,
  });
}

function currentSessionView(scope, projectId) {
  return accountScope({
    id: scope.userId,
    token: scope.token,
    generation: scope.generation,
    projectId,
  });
}

function applyDelayedResult({ request, current, ok = true, value = null }) {
  if (!isCurrentWorkspaceResponseScope({ current, request })) return { applied: false };
  if (!ok) return { applied: false, error: value };
  return { applied: true, value };
}

function clearedView(view, next) {
  return {
    ...view,
    ...next,
    input: '',
    taskInput: '',
    generating: false,
    taskSubmitting: false,
    taskLoading: false,
    taskDetail: null,
    focusTaskId: null,
    toast: null,
    retryRequest: null,
    projects: [],
    projectId: '',
    workspaceFiles: [],
    projectProposals: [],
  };
}

test('the shared scope snapshot distinguishes accounts, sessions, generations, and projects', () => {
  const request = accountScope({ id: 'account-a', token: 'token-a', generation: 1, projectId: '7' });
  const sameA = accountScope({ id: 'account-a', token: 'token-a', generation: 1, projectId: '7' });
  const accountB = accountScope({ id: 'account-b', token: 'token-b', generation: 3, projectId: '8' });

  assert.equal(isCurrentWorkspaceResponseScope({ current: sameA, request }), true);
  assert.equal(isCurrentWorkspaceResponseScope({ current: accountB, request }), false);
  assert.equal(responseScopeKey('account-a', '7'), 'account-a:7');
  assert.notEqual(responseScopeKey('account-a', '7'), responseScopeKey('account-b', '7'));

  assert.equal(isCurrentWorkspaceResponseScope({
    current: accountScope({ id: 'account-a', token: 'token-a', generation: 2, projectId: '7' }),
    request,
  }), false, 'a newer session generation must invalidate the old request');
  assert.equal(isCurrentWorkspaceResponseScope({
    current: accountScope({ id: 'account-a', token: 'token-a', generation: 1, projectId: '8' }),
    request,
  }), false, 'a different selected project must invalidate the old request');
  assert.equal(isCurrentWorkspaceResponseScope({
    current: captureWorkspaceResponseScope({ authenticated: false, generation: 1, projectId: '7' }),
    request,
  }), false, 'sign-out must invalidate the old request');
});

test('session-only scope accepts cross-project targets but rejects account/session changes', () => {
  const requestA = accountScope({ id: 'account-a', token: 'token-a', generation: 2, projectId: '7' });
  const currentBSelected = currentSessionView(requestA, '8');

  assert.equal(
    isCurrentWorkspaceResponseScope({ current: currentBSelected, request: requestA }),
    false,
    'full response scope must not apply project A data while B is selected',
  );
  assert.equal(
    isCurrentWorkspaceSessionScope({ current: currentBSelected, request: requestA }),
    true,
    'an action explicitly targeting A remains valid while B is selected',
  );

  for (const current of [
    accountScope({ id: 'account-b', token: 'token-b', generation: 2, projectId: '7' }),
    accountScope({ id: 'account-a', token: 'token-rotated', generation: 2, projectId: '7' }),
    accountScope({ id: 'account-a', token: 'token-a', generation: 3, projectId: '7' }),
    accountScope({ id: 'account-a', token: 'token-a', generation: 2, projectId: '7', authenticated: false }),
  ]) {
    assert.equal(
      isCurrentWorkspaceSessionScope({ current, request: requestA }),
      false,
      'account, token, generation and sign-out changes must invalidate the action',
    );
  }
});

test('request-lifecycle ownership separates stale responses from newer requests', () => {
  const first = { id: 'first' };
  const second = { id: 'second' };

  assert.equal(isCurrentRequestLifecycle(first, first), true);
  assert.equal(isCurrentRequestLifecycle(first, second), false);
  assert.equal(isCurrentRequestLifecycle(null, first), false);
});

test('delayed account A success and failure are both discarded after switching to B', () => {
  const requestA = accountScope({ id: 'account-a', token: 'token-a', generation: 1, projectId: '7' });
  const currentB = accountScope({ id: 'account-b', token: 'token-b', generation: 3, projectId: '8' });

  const success = applyDelayedResult({
    request: requestA,
    current: currentB,
    value: { task: { id: 101, title: 'Account A only' }, toast: 'Task created in Account A' },
  });
  assert.deepEqual(success, { applied: false }, 'A task must not appear in B');

  const failure = applyDelayedResult({
    request: requestA,
    current: currentB,
    ok: false,
    value: 'Account A provider error',
  });
  assert.deepEqual(failure, { applied: false }, 'A error toast must not appear in B');

  const sameSession = accountScope({ id: 'account-a', token: 'token-a', generation: 1, projectId: '7' });
  const valid = applyDelayedResult({ request: requestA, current: sameSession, value: 'kept' });
  assert.deepEqual(valid, { applied: true, value: 'kept' }, 'current-account results still apply');
});

// The next three models mirror App.jsx's separation of response application
// from request-lifecycle cleanup. They use the real helpers above, so dropping
// or reversing a guard changes these results.
function createChatWorkflow() {
  const state = { generating: false, controller: null, applied: [] };
  const start = (scope) => {
    state.generating = true;
    state.controller = { scope };
    return state.controller;
  };
  const complete = ({ controller, responseScope, currentScope, ok = true, value = null }) => {
    let applied = false;
    if (isCurrentWorkspaceResponseScope({ current: currentScope, request: responseScope })) {
      applied = true;
      state.applied.push(ok ? value : { error: value });
    }
    if (isCurrentRequestLifecycle(state.controller, controller)) {
      state.controller = null;
      state.generating = false;
    }
    return { applied };
  };
  return { state, start, complete };
}

function createTaskSubmitWorkflow(initialDraft) {
  const state = {
    submitting: false,
    requestRef: 0,
    draft: initialDraft,
    tasks: [],
    toast: null,
  };
  const start = () => {
    const requestId = ++state.requestRef;
    state.submitting = true;
    return requestId;
  };
  const complete = ({ requestId, requestScope, currentScope, ok = true, result = null, error = null }) => {
    let applied = false;
    if (isCurrentWorkspaceResponseScope({ current: currentScope, request: requestScope })) {
      applied = true;
      if (ok && result) {
        state.draft = '';
        state.tasks.push(result.task);
        state.toast = { message: 'Task created.' };
        state.submitting = false;
      } else if (!ok) {
        state.toast = { message: error };
      }
    }
    if (isCurrentRequestLifecycle(state.requestRef, requestId)) state.submitting = false;
    return { applied };
  };
  return { state, start, complete };
}

function createProposalWorkflow() {
  const state = { toasts: [], refreshedProjects: [] };
  const decide = ({ requestScope, currentScope, ok = true, result = null, error = null }) => {
    if (!isCurrentWorkspaceSessionScope({ current: currentScope, request: requestScope })) return false;
    state.toasts.push({ message: ok ? `Applied ${result?.file?.path || 'proposal'}` : error });
    if (ok) state.refreshedProjects.push(requestScope.projectId);
    return true;
  };
  return { state, decide };
}

test('chat completion after a same-account project switch unlocks without applying stale content', () => {
  const workflow = createChatWorkflow();
  const requestScope = accountScope({ id: 'a', token: 't1', generation: 1, projectId: '7' });
  const controller = workflow.start(requestScope);
  assert.equal(workflow.state.generating, true);

  const result = workflow.complete({
    controller,
    responseScope: requestScope,
    currentScope: currentSessionView(requestScope, '8'),
    value: { reply: 'project A reply' },
  });

  assert.equal(result.applied, false);
  assert.deepEqual(workflow.state.applied, []);
  assert.equal(workflow.state.generating, false, 'a stale project switch must not leave chat stuck');
  assert.equal(workflow.state.controller, null);
});

test('chat completion after a token/generation change unlocks and stays isolated', () => {
  for (const currentScope of [
    accountScope({ id: 'a', token: 't2', generation: 1, projectId: '7' }),
    accountScope({ id: 'a', token: 't1', generation: 2, projectId: '7' }),
    accountScope({ id: 'b', token: 't2', generation: 2, projectId: '7' }),
  ]) {
    const workflow = createChatWorkflow();
    const requestScope = accountScope({ id: 'a', token: 't1', generation: 1, projectId: '7' });
    const controller = workflow.start(requestScope);
    const result = workflow.complete({
      controller,
      responseScope: requestScope,
      currentScope,
      ok: false,
      value: 'A provider error',
    });

    assert.equal(result.applied, false);
    assert.equal(workflow.state.generating, false);
    assert.deepEqual(workflow.state.applied, []);
  }
});

test('an older chat completion cannot clear a newer request loading state', () => {
  const workflow = createChatWorkflow();
  const firstScope = accountScope({ id: 'a', token: 't1', generation: 1, projectId: '7' });
  const secondScope = accountScope({ id: 'a', token: 't1', generation: 1, projectId: '8' });
  const first = workflow.start(firstScope);
  const second = workflow.start(secondScope);

  workflow.complete({
    controller: first,
    responseScope: firstScope,
    currentScope: secondScope,
  });
  assert.equal(workflow.state.generating, true, 'the old completion must not clear the newer request');
  assert.equal(workflow.state.controller, second);

  assert.equal(workflow.state.controller, second);
  workflow.complete({
    controller: second,
    responseScope: secondScope,
    currentScope: secondScope,
  });
  assert.equal(workflow.state.generating, false);
  assert.equal(workflow.state.controller, null);
});

test('task creation after a project switch unlocks without applying a stale task or clearing the new draft', () => {
  const workflow = createTaskSubmitWorkflow('draft for project B');
  const requestScope = accountScope({ id: 'a', token: 't1', generation: 1, projectId: '7' });
  const requestId = workflow.start();

  const result = workflow.complete({
    requestId,
    requestScope,
    currentScope: currentSessionView(requestScope, '8'),
    result: { task: { id: 101, instruction: 'Account A task' } },
  });

  assert.equal(result.applied, false);
  assert.equal(workflow.state.submitting, false, 'a stale task submit must not stay disabled');
  assert.equal(workflow.state.draft, 'draft for project B');
  assert.deepEqual(workflow.state.tasks, []);
  assert.equal(workflow.state.toast, null);
});

test('delayed task failure after an account switch is discarded without clearing a newer submission', () => {
  const workflow = createTaskSubmitWorkflow('first draft');
  const requestScope = accountScope({ id: 'a', token: 't1', generation: 1, projectId: '7' });
  const firstId = workflow.start();
  workflow.state.draft = 'second draft';
  const secondId = workflow.start();

  workflow.complete({
    requestId: firstId,
    requestScope,
    currentScope: accountScope({ id: 'b', token: 't2', generation: 2, projectId: '8' }),
    ok: false,
    error: 'A task failure',
  });

  assert.equal(workflow.state.submitting, true, 'the old failure must not clear the newer submit');
  assert.equal(workflow.state.draft, 'second draft');
  assert.equal(workflow.state.toast, null);

  workflow.complete({
    requestId: secondId,
    requestScope,
    currentScope: currentSessionView(requestScope, '7'),
    ok: false,
    error: 'Second task failure',
  });
  assert.equal(workflow.state.submitting, false);
  assert.deepEqual(workflow.state.toast, { message: 'Second task failure' });
});

test('proposal decisions target their own project while another project is selected', () => {
  const workflow = createProposalWorkflow();
  const requestScope = accountScope({ id: 'a', token: 't1', generation: 4, projectId: '7' });
  const selectedProjectB = currentSessionView(requestScope, '8');

  assert.equal(workflow.decide({
    requestScope,
    currentScope: selectedProjectB,
    result: { file: { path: 'a-only.js' } },
  }), true);
  assert.deepEqual(workflow.state.refreshedProjects, ['7']);
  assert.deepEqual(workflow.state.toasts, [{ message: 'Applied a-only.js' }]);

  const afterAccountSwitch = workflow.decide({
    requestScope,
    currentScope: accountScope({ id: 'b', token: 't2', generation: 5, projectId: '8' }),
    result: { file: { path: 'a-only.js' } },
  });
  assert.equal(afterAccountSwitch, false);
  assert.deepEqual(workflow.state.refreshedProjects, ['7'], 'no refresh for the wrong account');
  assert.equal(workflow.state.toasts.length, 1, 'no misleading success toast after an account switch');
});

test('cross-project proposal failure is visible to the same session but hidden from a new account', () => {
  const workflow = createProposalWorkflow();
  const requestScope = accountScope({ id: 'a', token: 't1', generation: 4, projectId: '7' });

  assert.equal(workflow.decide({
    requestScope,
    currentScope: currentSessionView(requestScope, '8'),
    ok: false,
    error: 'A proposal failed',
  }), true);
  assert.deepEqual(workflow.state.toasts, [{ message: 'A proposal failed' }]);
  assert.deepEqual(workflow.state.refreshedProjects, []);

  const switched = createProposalWorkflow();
  assert.equal(switched.decide({
    requestScope,
    currentScope: accountScope({ id: 'b', token: 't2', generation: 5, projectId: '8' }),
    ok: false,
    error: 'A proposal failed',
  }), false);
  assert.deepEqual(switched.state.toasts, []);
});

test('account cleanup clears drafts, loading flags, selection, details, and notifications', () => {
  const staleA = {
    input: 'unsent chat draft for A',
    taskInput: 'unsent task draft for A',
    generating: true,
    taskSubmitting: true,
    taskLoading: true,
    taskDetail: { task: { id: 101 } },
    focusTaskId: 101,
    toast: { message: 'Task created in Account A' },
    retryRequest: { prompt: 'A prompt' },
    projects: [{ id: 7, name: 'Account A' }],
    projectId: '7',
    workspaceFiles: ['private.js'],
    projectProposals: [{ proposalId: 'a-only' }],
  };
  const nextB = clearedView(staleA, {
    userId: 'account-b',
    token: 'token-b',
    generation: 3,
    projectId: '',
  });

  assert.equal(nextB.input, '');
  assert.equal(nextB.taskInput, '');
  assert.equal(nextB.generating, false);
  assert.equal(nextB.taskSubmitting, false);
  assert.equal(nextB.taskLoading, false);
  assert.equal(nextB.taskDetail, null);
  assert.equal(nextB.focusTaskId, null);
  assert.equal(nextB.toast, null);
  assert.equal(nextB.retryRequest, null);
  assert.deepEqual(nextB.projects, []);
  assert.equal(nextB.projectId, '');
  assert.deepEqual(nextB.workspaceFiles, []);
  assert.deepEqual(nextB.projectProposals, []);

  for (const pattern of [
    /workspaceGenerationRef\.current \+= 1/,
    /controllerRef\.current\?\.abort\(\)/,
    /controllerRef\.current = null/,
    /workspaceRequestRef\.current \+= 1/,
    /taskSubmitRequestRef\.current \+= 1/,
    /sessionsLoadedRef\.current = false/,
    /sessionsNamespaceRef\.current = null/,
    /setSessions\(\[\]\)/,
    /setActiveId\(null\)/,
    /setInput\(''\)/,
    /setTaskInput\(''\)/,
    /setGenerating\(false\)/,
    /setTaskSubmitting\(false\)/,
    /setTaskLoading\(false\)/,
    /setTasksError\(null\)/,
    /setTaskDetail\(null\)/,
    /setFocusTaskId\(null\)/,
    /setRetryRequest\(null\)/,
    /setToast\(null\)/,
    /setWorkspaceFiles\(\[\]\)/,
    /setProjectProposals\(\[\]\)/,
    /setSelectedFile\(null\)/,
    /setFileContent\(''\)/,
    /setWorkspaceLoading\(false\)/,
    /setProjectUnderstanding\(null\)/,
    /persistActiveProjectId\(userId, ''\)/,
  ]) {
    assert.match(clearSource, pattern, `clearWorkspaceState must contain ${pattern}`);
  }
});

test('handlers use the right guard for their target and separate lifecycle cleanup', () => {
  const fullScopeGuarded = [
    'requestReply',
    'createTask',
    'cancelTask',
    'loadProjects',
    'loadTasks',
    'loadTaskDetail',
    'loadWorkspaceFiles',
    'openWorkspaceFile',
    'searchWorkspaceCode',
    'createProject',
  ];
  for (const name of fullScopeGuarded) {
    const source = topLevelBlock(name);
    assert.match(source, /readWorkspaceScope\(/, `${name} must capture a response scope`);
    assert.match(source, /isCurrentWorkspaceScope\(/, `${name} must verify the response scope`);
  }

  const sessionGuarded = [
    'applyFileProposal',
    'discardFileProposal',
    'rejectWorkspaceCommand',
    'runApprovedWorkspaceCommand',
    'postTaskProposalDecision',
    'applyTaskProposal',
    'rejectTaskProposal',
    'runTaskProposal',
    'refreshAfterProposalDecision',
  ];
  for (const name of sessionGuarded) {
    const source = topLevelBlock(name);
    assert.match(source, /readWorkspaceScope\(/, `${name} must capture the target project scope`);
    assert.match(source, /isCurrentWorkspaceSession\(/, `${name} must validate the session, not the selected tab`);
  }

  assert.match(topLevelBlock('applyFileProposal'), /isCurrentView\(\)/,
    'editor updates must still require the target project to be the active view');
  assert.match(topLevelBlock('refreshAfterProposalDecision'), /explicitProjectId/,
    'task detail refresh must remain bound to the task target project');
  assert.match(topLevelBlock('refreshAfterProposalDecision'), /isCurrentView\(\)/,
    'workspace file refresh must not overwrite another selected project');

  // A full-scope guard must compare the request to the project selected now.
  // Passing the request's own target back as the scope makes a project switch
  // invisible and reintroduces H1/H2 state leakage.
  const selectedViewGuarded = [
    ['requestReply', /isCurrentWorkspaceScope\(requestScope, requestScope\.projectId\)/],
    ['createTask', /isCurrentWorkspaceScope\(requestScope, requestProjectId\)/],
    ['applyFileProposal', /isCurrentWorkspaceScope\(requestScope, requestProjectId\)/],
    ['refreshAfterProposalDecision', /isCurrentWorkspaceScope\(requestScope, workspaceId\)/],
  ];
  for (const [name, selfTargetPattern] of selectedViewGuarded) {
    const source = topLevelBlock(name);
    assert.match(source, /isCurrentWorkspaceScope\(requestScope\)/,
      `${name} must compare against the currently selected project`);
    assert.doesNotMatch(source, selfTargetPattern,
      `${name} must not compare a request scope with its own project ID`);
  }

  const successAndFailureGuarded = [
    'requestReply',
    'createTask',
    'applyFileProposal',
    'discardFileProposal',
    'rejectWorkspaceCommand',
    'runApprovedWorkspaceCommand',
    'cancelTask',
    'applyTaskProposal',
    'rejectTaskProposal',
    'runTaskProposal',
  ];
  for (const name of successAndFailureGuarded) {
    const source = topLevelBlock(name);
    const checks = source.match(/!isCurrent(?:WorkspaceScope|WorkspaceSession|Scope|Session|View)?\(\)/g) || [];
    assert.ok(checks.length >= 2, `${name} must guard both success and error paths`);
    assert.match(source, /catch \(error\)/, `${name} must have a guarded error path`);
  }

  assert.match(topLevelBlock('requestReply'), /isCurrentRequestLifecycle\(controllerRef\.current, controller\)/,
    'chat cleanup must be owned by the matching controller even for stale responses');
  const createTaskSource = topLevelBlock('createTask');
  assert.match(createTaskSource, /taskSubmitRequestRef\.current/);
  assert.match(createTaskSource, /isCurrentRequestLifecycle\(taskSubmitRequestRef\.current, requestId\)/,
    'task cleanup must be owned by the matching submission even for stale responses');
  assert.match(createTaskSource, /Preserve the original immediate cleanup[\s\S]{0,140}setTaskSubmitting\(false\)/,
    'task submission must unlock immediately after a successful POST');

  const applyAuthSource = topLevelBlock('applyAuth');
  assert.match(applyAuthSource, /workspaceGenerationRef\.current \+= 1/);
  assert.match(applyAuthSource, /controllerRef\.current\?\.abort\(\)/);
  assert.match(applyAuthSource, /setGenerating\(false\)/);

  assert.match(APP_SOURCE, /const workspaceGenerationRef = useRef\(0\)/);
  assert.match(APP_SOURCE, /const taskSubmitRequestRef = useRef\(0\)/);
  assert.match(APP_SOURCE, /const isCurrentWorkspaceScope = useCallback/);
  assert.match(APP_SOURCE, /const isCurrentWorkspaceSession = useCallback/);
  assert.match(APP_SOURCE, /sessionsStorageKey\(authUserId\)/);
});

runCrossAccountBackendChecks({ label: 'SQLite', createApp });

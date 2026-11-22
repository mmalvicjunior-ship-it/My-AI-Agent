// Regression coverage for account-safe project selection and chat payloads.
// Pure helpers are imported from the web app; no live AI request is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeProjectIdForPersistence,
  chatRequestContext,
  matchingProjectId,
  selectRestoredProjectId,
  validatedChatProjectId,
  workspaceStatusMessage,
} from '../../apps/web/src/workspaceUiHelpers.js';

const ACCOUNT_B_PROJECTS = [{ id: 8, name: 'Account B project' }];

test('a project from another account is never sent to /api/chat', () => {
  const context = chatRequestContext({
    authToken: 'account-b-token',
    projects: ACCOUNT_B_PROJECTS,
    projectId: '7',
    activeProject: null,
    projectsLoaded: true,
    retryRequest: { projectId: '7', prompt: 'old prompt' },
  });
  assert.deepEqual(context, { token: 'account-b-token', projectId: null });
  assert.equal(validatedChatProjectId({
    projects: ACCOUNT_B_PROJECTS,
    projectId: '7',
    projectsLoaded: true,
  }), null);
  assert.equal(validatedChatProjectId({
    projects: ACCOUNT_B_PROJECTS,
    projectId: '8',
    projectsLoaded: true,
  }), 8);
});

test('active-project persistence waits until the account projects are loaded', () => {
  const activeProject = { id: 7, name: 'Account A project' };
  assert.equal(activeProjectIdForPersistence({
    projectsLoaded: false,
    activeProject,
  }), null);
  assert.equal(activeProjectIdForPersistence({
    projectsLoaded: true,
    activeProject: null,
  }), null);
  assert.equal(activeProjectIdForPersistence({
    projectsLoaded: true,
    activeProject,
  }), 7);
});

test('project restoration ignores stale and cross-account IDs', () => {
  assert.equal(selectRestoredProjectId({
    projects: ACCOUNT_B_PROJECTS,
    currentProjectId: '7',
    storedProjectId: '7',
    projectsLoaded: true,
  }), '8');
  assert.equal(selectRestoredProjectId({
    projects: [],
    currentProjectId: '7',
    storedProjectId: '7',
    projectsLoaded: true,
  }), '');
  assert.equal(selectRestoredProjectId({
    projects: ACCOUNT_B_PROJECTS,
    currentProjectId: '',
    storedProjectId: '',
    projectsLoaded: false,
  }), '');
  assert.equal(matchingProjectId(ACCOUNT_B_PROJECTS, '8'), 8);
  assert.equal(matchingProjectId(ACCOUNT_B_PROJECTS, '7'), null);
});

test('workspace banner distinguishes unavailable and unselected workspaces', () => {
  assert.equal(workspaceStatusMessage({ available: true, reason: null }), null);
  assert.match(
    workspaceStatusMessage({ available: false, reason: 'workspace_unavailable' }),
    /no longer available/i,
  );
  assert.match(
    workspaceStatusMessage({ available: false, reason: 'no_workspace_selected' }),
    /No approved workspace was selected/i,
  );
});

test('refresh and a new chat keep auth and the validated active project', () => {
  const projects = [{ id: 7, name: 'Kept project' }, { id: 8, name: 'Other project' }];
  const beforeRefresh = chatRequestContext({
    authToken: 'stored-token',
    projects,
    projectId: '7',
    activeProject: projects[0],
    projectsLoaded: true,
  });
  const afterRefresh = chatRequestContext({
    authToken: 'stored-token',
    projects,
    projectId: '7',
    activeProject: projects[0],
    projectsLoaded: true,
  });
  const afterNewChat = chatRequestContext({
    authToken: 'stored-token',
    projects,
    projectId: '7',
    activeProject: projects[0],
    projectsLoaded: true,
  });
  assert.deepEqual(beforeRefresh, { token: 'stored-token', projectId: 7 });
  assert.deepEqual(afterRefresh, beforeRefresh);
  assert.deepEqual(afterNewChat, beforeRefresh);
});

test('a retry after auth restoration uses current project scope, not retry state', () => {
  const staleRetry = { projectId: '7', prompt: 'sent before sign-out', history: [] };
  const currentProjects = [{ id: 9, name: 'Restored account project' }];
  const context = chatRequestContext({
    authToken: 'restored-token',
    projects: currentProjects,
    projectId: '9',
    activeProject: currentProjects[0],
    projectsLoaded: true,
    retryRequest: staleRetry,
  });
  assert.deepEqual(context, { token: 'restored-token', projectId: 9 });
  assert.notEqual(context.projectId, staleRetry.projectId);
});

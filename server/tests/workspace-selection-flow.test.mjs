// Regression coverage for account-safe project selection and chat payloads.
// Pure helpers are imported from the web app; no live AI request is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  activeProjectIdForPersistence,
  chatRequestContext,
  discoveredProjectRows,
  isCurrentProjectCreationScope,
  matchingProjectId,
  projectUnderstandingPaths,
  responseScopeKey,
  selectRestoredProjectId,
  validatedChatProjectId,
  verifiedWorkspaceProject,
  workspaceLoadingMessage,
  workspaceSelectionState,
  workspaceStatusMessage,
  workspaceUnderstandingSummary,
} from '../../apps/web/src/workspaceUiHelpers.js';

const APP_SOURCE = fs.readFileSync(
  fileURLToPath(new URL('../../apps/web/src/App.jsx', import.meta.url)),
  'utf8',
);
const ACCOUNT_B_PROJECTS = [{ id: 8, name: 'Account B project' }];

// These small models mirror the state fields guarded in App.jsx. They let the
// pure guard decisions be exercised as state transitions without adding a
// React/DOM test framework to the web workspace.
function applyProjectCreationResult({ state, request, response, current }) {
  const currentRequest = isCurrentProjectCreationScope({
    authenticated: current.authenticated,
    currentUserId: current.userId,
    requestUserId: request.userId,
    currentGeneration: current.generation,
    requestGeneration: request.generation,
    currentScope: current.scope,
    requestScope: request.scope,
  });
  if (!currentRequest) return { applied: false, state };
  return {
    applied: true,
    state: {
      ...state,
      projects: [response.project, ...state.projects],
      projectId: String(response.project.id),
      scope: request.scope,
      persistedProjectId: String(response.project.id),
      loading: false,
      loadError: null,
      projectBusy: false,
    },
  };
}

function attemptSendWhileLoading(loading) {
  const message = workspaceLoadingMessage(loading);
  return message ? { submitted: false, message } : { submitted: true, message: null };
}

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
  }), '');
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

test('an active project outside the loaded authorized list is rejected', () => {
  const foreignActiveProject = { id: 99, name: 'Foreign project' };
  assert.equal(validatedChatProjectId({
    projects: ACCOUNT_B_PROJECTS,
    projectId: '99',
    activeProject: foreignActiveProject,
    projectsLoaded: true,
  }), null);
  assert.deepEqual(chatRequestContext({
    authToken: 'account-b-token',
    projects: ACCOUNT_B_PROJECTS,
    projectId: '99',
    activeProject: foreignActiveProject,
    projectsLoaded: true,
  }), { token: 'account-b-token', projectId: null });
});

test('workspace selection states stay distinct and never invent a project', () => {
  const loading = workspaceSelectionState({ loading: true, projects: [] });
  assert.equal(loading.status, 'loading');
  assert.equal(loading.ready, false);
  assert.match(loading.message, /Loading your authorized projects/i);

  const loadError = workspaceSelectionState({ loadError: 'network', projects: [] });
  assert.equal(loadError.status, 'load_error');
  assert.equal(loadError.ready, false);
  assert.match(loadError.message, /Could not load your authorized projects/i);

  const empty = workspaceSelectionState({ projects: [], projectsLoaded: true });
  assert.equal(empty.status, 'no_projects');
  assert.equal(empty.ready, false);
  assert.equal(empty.projectId, null);
  assert.match(empty.message, /No authorized projects/i);

  const needsSelection = workspaceSelectionState({
    projects: [{ id: 7, name: 'Seven' }, { id: 8, name: 'Eight' }],
    projectId: '',
    activeProject: null,
  });
  assert.equal(needsSelection.status, 'needs_selection');
  assert.equal(needsSelection.ready, false);
  assert.match(needsSelection.message, /Select an authorized project/i);
});

test('one authorized project is safe to restore; multiple projects respect selection', () => {
  const single = [{ id: 12, name: 'Only project' }];
  assert.equal(selectRestoredProjectId({
    projects: single,
    currentProjectId: '',
    storedProjectId: '',
    projectsLoaded: true,
  }), '12');

  const multiple = [{ id: 7, name: 'Seven' }, { id: 8, name: 'Eight' }];
  const selected = selectRestoredProjectId({
    projects: multiple,
    currentProjectId: '8',
    storedProjectId: '7',
    projectsLoaded: true,
  });
  assert.equal(selected, '8');
  const ready = workspaceSelectionState({
    projects: multiple,
    projectId: '8',
    activeProject: multiple[1],
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.ready, true);
  assert.equal(ready.projectId, 8);
  assert.match(ready.message, /Workspace ready: Eight/);
});

test('stale restored selection requires an explicit choice instead of reusing another project', () => {
  const projects = [{ id: 8, name: 'Current project' }];
  const staleId = '7';
  const next = selectRestoredProjectId({
    projects,
    currentProjectId: '',
    storedProjectId: staleId,
    projectsLoaded: true,
  });
  assert.equal(next, '');
  const state = workspaceSelectionState({
    projects,
    projectId: next,
    activeProject: null,
    staleRestoredProjectId: staleId,
  });
  assert.equal(state.status, 'stale_selection');
  assert.equal(state.ready, false);
  assert.equal(state.projectId, null);
  assert.match(state.message, /no longer available/i);
  assert.match(state.message, /choose a project/i);
  assert.equal(chatRequestContext({
    projects,
    projectId: staleId,
    activeProject: null,
    projectsLoaded: true,
  }).projectId, null);
});

test('account switching never reuses a previous account project ID', () => {
  const previousToken = 'account-a-token';
  const nextToken = 'account-b-token';
  const previousProjects = [{ id: 7, name: 'Account A' }];
  const nextProjects = [{ id: 8, name: 'Account B' }];
  const before = chatRequestContext({
    authToken: previousToken,
    projects: previousProjects,
    projectId: '7',
    activeProject: previousProjects[0],
    projectsLoaded: true,
  });
  const after = chatRequestContext({
    authToken: nextToken,
    projects: nextProjects,
    projectId: '7',
    activeProject: previousProjects[0],
    projectsLoaded: true,
    retryRequest: { projectId: '7' },
  });
  assert.deepEqual(before, { token: previousToken, projectId: 7 });
  assert.deepEqual(after, { token: nextToken, projectId: null });
  assert.equal(selectRestoredProjectId({
    projects: nextProjects,
    currentProjectId: '7',
    storedProjectId: '7',
    projectsLoaded: true,
  }), '');
});

test('App.jsx waits for project loading, tracks load failure, and revalidates chat scope', () => {
  assert.match(APP_SOURCE, /const \[projectsLoading, setProjectsLoading\]/);
  assert.match(APP_SOURCE, /const \[projectsLoadError, setProjectsLoadError\]/);
  assert.match(APP_SOURCE, /projectsLoadedRef\.current = false;\s*\n\s*setProjectsLoadError/);
  assert.match(APP_SOURCE, /projectsLoaded: !projectsLoading && !projectsLoadError/);
  assert.match(APP_SOURCE, /const loadingMessage = workspaceLoadingMessage\(projectsLoading\)/);
  assert.match(APP_SOURCE, /onClick=\{loadProjects\}>Retry</);
  assert.match(APP_SOURCE, /workspaceSelection\.message/);
  assert.match(APP_SOURCE, /setStaleRestoredProjectId\(''\)/);
});

test('a createProject response from account A is discarded after a switch to account B', () => {
  const request = { userId: 1, generation: 4, scope: responseScopeKey(1, null) };
  const response = { project: { id: 7, name: 'Account A project' } };
  const accountAState = {
    projects: [{ id: 6, name: 'Older account A project' }],
    projectId: '6',
    scope: responseScopeKey(1, null),
    persistedProjectId: '6',
    loading: false,
    loadError: null,
    projectBusy: true,
  };
  const currentA = {
    authenticated: true,
    userId: 1,
    generation: 4,
    scope: responseScopeKey(1, null),
  };
  const appliedForA = applyProjectCreationResult({ state: accountAState, request, response, current: currentA });
  assert.equal(appliedForA.applied, true);
  assert.deepEqual(appliedForA.state.projects.map((project) => project.id), [7, 6]);
  assert.equal(appliedForA.state.projectId, '7');
  assert.equal(appliedForA.state.scope, request.scope);
  assert.equal(appliedForA.state.persistedProjectId, '7');
  assert.equal(appliedForA.state.projectBusy, false);

  const accountBState = {
    projects: [{ id: 8, name: 'Account B project' }],
    projectId: '8',
    scope: responseScopeKey(2, null),
    persistedProjectId: '8',
    loading: false,
    loadError: null,
    projectBusy: false,
  };
  const expectedBState = {
    ...accountBState,
    projects: [...accountBState.projects],
  };
  const currentB = {
    authenticated: true,
    userId: 2,
    generation: 6,
    scope: responseScopeKey(2, null),
  };
  const afterSwitch = applyProjectCreationResult({ state: accountBState, request, response, current: currentB });
  assert.equal(afterSwitch.applied, false);
  assert.deepEqual(afterSwitch.state, expectedBState);
  assert.equal(afterSwitch.state.persistedProjectId, '8');
  assert.equal(afterSwitch.state.scope, responseScopeKey(2, null));

  const afterSignOut = applyProjectCreationResult({
    state: accountBState,
    request,
    response,
    current: { authenticated: false, userId: null, generation: 7, scope: null },
  });
  assert.equal(afterSignOut.applied, false);
  assert.deepEqual(afterSignOut.state, expectedBState);

  const afterNewerGeneration = applyProjectCreationResult({
    state: accountAState,
    request,
    response,
    current: { authenticated: true, userId: 1, generation: 5, scope: responseScopeKey(1, null) },
  });
  assert.equal(afterNewerGeneration.applied, false);
  assert.deepEqual(afterNewerGeneration.state, accountAState);

  assert.match(APP_SOURCE, /const requestUserId = authRef\.current\?\.user\?\.id \?\? null/);
  assert.match(APP_SOURCE, /let requestGeneration = projectsLoadGenerationRef\.current/);
  assert.match(APP_SOURCE, /const isCurrentRequest = \(\) => isCurrentProjectCreationScope/);
  assert.match(APP_SOURCE, /if \(!isCurrentRequest\(\)\) return;/);
  assert.match(APP_SOURCE, /projectsScopeRef\.current = requestScope/);
  assert.match(APP_SOURCE, /persistActiveProjectId\(requestUserId,/);
});

test('chat and task creation loading guards cover sendMessage, regenerate, Retry, and createTask but clear when ready', () => {
  const loadingMessage = workspaceLoadingMessage(true);
  assert.match(loadingMessage, /Loading your authorized projects/i);
  assert.equal(workspaceLoadingMessage(false), null);

  for (const path of ['sendMessage', 'regenerate', 'toast Retry']) {
    const blocked = attemptSendWhileLoading(true);
    assert.equal(blocked.submitted, false, path);
    assert.equal(blocked.message, loadingMessage, path);

    const ready = attemptSendWhileLoading(false);
    assert.equal(ready.submitted, true, path);
    assert.equal(ready.message, null, path);
  }

  const guardCalls = APP_SOURCE.match(/workspaceLoadingMessage\(projectsLoading\)/g) || [];
  assert.equal(guardCalls.length, 4);
  assert.match(APP_SOURCE, /const requestReply = useCallback\(async[\s\S]*?const loadingMessage = workspaceLoadingMessage\(projectsLoading\)/);
  assert.match(APP_SOURCE, /const sendMessage = useCallback\(async[\s\S]*?const loadingMessage = workspaceLoadingMessage\(projectsLoading\)/);
  assert.match(APP_SOURCE, /const regenerate = \(messageIndex\) => \{[\s\S]*?const loadingMessage = workspaceLoadingMessage\(projectsLoading\)/);
  assert.match(APP_SOURCE, /const createTask = useCallback\(async[\s\S]*?const loadingMessage = workspaceLoadingMessage\(projectsLoading\)/);
  assert.match(APP_SOURCE, /if \(!workspaceSelection\.ready \|\| !visibleProject\) \{[\s\S]*?Select an authorized project before starting a task/);
  assert.match(APP_SOURCE, /onClick=\{\(\) => requestReply\(retryRequest\)\}>Retry</);
});

test('failed reload hides the prior workspace without erasing the saved selection until retry succeeds', () => {
  const projects = [{ id: 7, name: 'Account A project' }];
  const storage = new Map([['account-1', '7']]);

  const beforeFailure = workspaceSelectionState({
    projects,
    projectId: '7',
    activeProject: projects[0],
  });
  assert.equal(beforeFailure.ready, true);
  assert.equal(verifiedWorkspaceProject({ projects, selection: beforeFailure })?.id, 7);

  const failed = workspaceSelectionState({
    loadError: 'network',
    projects,
    projectId: '7',
    activeProject: projects[0],
  });
  assert.equal(failed.status, 'load_error');
  assert.equal(failed.ready, false);
  assert.equal(failed.projectId, null);
  assert.match(failed.message, /Could not load your authorized projects/i);
  assert.equal(verifiedWorkspaceProject({ projects, selection: failed }), null);
  assert.equal(storage.get('account-1'), '7');
  assert.equal(activeProjectIdForPersistence({
    projectsLoaded: false,
    activeProject: projects[0],
  }), null);
  assert.equal(chatRequestContext({
    authToken: 'account-a-token',
    projects,
    projectId: '7',
    activeProject: projects[0],
    projectsLoaded: false,
  }).projectId, null);

  const afterRetry = workspaceSelectionState({
    projects,
    projectId: '7',
    activeProject: projects[0],
  });
  assert.equal(afterRetry.status, 'ready');
  assert.equal(afterRetry.ready, true);
  assert.equal(afterRetry.projectId, 7);
  assert.equal(verifiedWorkspaceProject({ projects, selection: afterRetry })?.id, 7);
  const persisted = activeProjectIdForPersistence({
    projectsLoaded: true,
    activeProject: projects[0],
  });
  storage.set('account-1', String(persisted));
  assert.equal(storage.get('account-1'), '7');

  assert.match(APP_SOURCE, /const visibleProject = verifiedWorkspaceProject/);
  assert.match(APP_SOURCE, /visibleProject \? visibleProject\.name : workspaceSelection\.status === 'load_error'/);
  assert.match(APP_SOURCE, /Workspace unavailable/);
  assert.match(APP_SOURCE, /placeholder=\{visibleProject/);
  assert.match(APP_SOURCE, /onClick=\{loadProjects\}>Retry</);
});

test('discovered picker rows dedupe invalid entries and list opened projects first', () => {
  const rows = discoveredProjectRows([
    { discoveryId: 'v1.beta', name: 'Beta', technologies: ['Node.js'] },
    { discoveryId: 'v1.opened', name: 'Alpha', alreadyOpenedProjectId: 9 },
    { discoveryId: 'v1.beta', name: 'Beta duplicate' },
    { discoveryId: '', name: 'Invalid' },
  ]);
  assert.deepEqual(rows.map((row) => row.discoveryId), ['v1.opened', 'v1.beta']);
  assert.equal(rows[0].alreadyOpenedProjectId, 9);
  assert.deepEqual(rows[1].technologies, ['Node.js']);
});

test('post-scan understanding uses only allowlisted files that the scan found', () => {
  const result = {
    files: ['README.md', 'AGENTS.md', 'src/index.js', 'package.json', '.env.local'],
    manifests: ['package.json'],
    languageHints: ['JavaScript'],
    frameworkHints: ['Vite'],
    projectTypes: ['Node.js'],
    truncated: false,
  };
  const paths = projectUnderstandingPaths(result);
  assert.deepEqual(paths, ['README.md', 'AGENTS.md', 'package.json']);
  const summary = workspaceUnderstandingSummary({ result, readPaths: paths });
  assert.match(summary, /Understood project:/);
  assert.match(summary, /Node\.js/);
  assert.match(summary, /README\.md, AGENTS\.md, package\.json/);
});

test('the picker sends opaque discovery IDs and keeps new workspaces name-only', () => {
  assert.match(APP_SOURCE, /const createProject = async \(\{ name, path: existingPath, discoveryId \} = \{\}\)/);
  assert.match(APP_SOURCE, /discoveryId: trimmedDiscoveryId/);
  assert.match(APP_SOURCE, /projectUnderstandingPaths\(result\)/);
  assert.match(APP_SOURCE, /workspaceUnderstandingSummary\(\{ result, readPaths \}\)/);
  const dialogSource = fs.readFileSync(
    fileURLToPath(new URL('../../apps/web/src/ProjectDialog.jsx', import.meta.url)),
    'utf8',
  );
  assert.match(dialogSource, /<h2 id="project-dialog-title">Open a project<\/h2>/);
  assert.match(dialogSource, /Choose a project and let your agent understand its codebase\./);
  assert.match(dialogSource, /\/api\/projects\/discover/);
  assert.match(dialogSource, /discoveryId: selected\.discoveryId/);
  assert.match(dialogSource, /New workspace/);
  assert.equal(dialogSource.includes('/api/projects/browse'), false);
});

// Pure helpers for small workflow rules in the workspace UI.
// Kept free of React and browser APIs so the server test runner can verify them.

export const TASK_LIST_LIMIT = 100;

/** Full prompt sent to the API when a source file is attached in the composer. */
export function buildPromptWithAttachment(prompt, attachment) {
  const text = typeof prompt === 'string' ? prompt : '';
  if (!attachment || typeof attachment.name !== 'string' || typeof attachment.content !== 'string') {
    return text;
  }
  // Avoid an empty line before the closing fence for files that end in \n.
  const source = attachment.content.replace(/\r?\n$/, '');
  return `${text}\n\nReview the attached source file "${attachment.name}":\n\`\`\`\n${source}\n\`\`\``;
}

/**
 * Scope key for a workspace response. Every async reader captures this before
 * a request and drops the result if the account or project changed meanwhile.
 */
export function responseScopeKey(userId, projectId) {
  return `${userId || 'anonymous'}:${projectId || ''}`;
}

/**
 * Quick actions that are actually usable in the current mode. npm_* scripts
 * are disabled in multi-user deployments, so "Run tests" is only offered when
 * the backend reports that scripts are enabled.
 */
export function quickActionsFor({ hasProject = false, npmScriptsEnabled = false, selectedFile = null } = {}) {
  if (!hasProject) return [];
  const target = selectedFile ? `the selected file ${selectedFile}` : 'the project’s main entry point';
  const actions = [
    {
      label: 'Inspect project',
      prompt: 'Inspect this project using the read-only file tools and summarize its structure, entry points, and test setup. Do not change files.',
    },
    {
      label: 'Find issues',
      prompt: 'Inspect this project for likely bugs or failing-test risks, then propose the smallest focused fixes for my approval. Do not change files yet.',
    },
    {
      label: 'Explain code',
      prompt: `Explain ${target}. Inspect it first if needed, and do not change files.`,
    },
  ];
  if (npmScriptsEnabled) {
    actions.push({
      label: 'Run Tests',
      prompt: 'Inspect this project, stage the safe npm_test check for approval, and explain how to interpret its result. Do not claim it ran until I approve it.',
    });
  }
  return actions;
}

/** Inserts or refreshes one project by ID without duplicating an existing row. */
export function upsertProject(projects, project) {
  const list = Array.isArray(projects) ? projects : [];
  if (project === null || project === undefined || project.id === null || project.id === undefined) return list;
  const index = list.findIndex((item) => String(item?.id) === String(project.id));
  if (index === -1) return [project, ...list];
  const next = [...list];
  next[index] = { ...next[index], ...project };
  return next;
}

/** Root-level instructions/manifests read after a safe scan, in priority order. */
export const PROJECT_UNDERSTANDING_FILES = Object.freeze([
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
]);

function fileName(filePath) {
  return String(filePath || '').split('/').pop() || '';
}

/** Filters and dedupes server discovery results before they reach the picker. */
export function normalizeDiscoveredProjects(projects = []) {
  const seen = new Set();
  return (Array.isArray(projects) ? projects : []).filter((project) => {
    const id = typeof project?.discoveryId === 'string' ? project.discoveryId.trim() : '';
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((project) => ({
    discoveryId: project.discoveryId,
    name: typeof project.name === 'string' && project.name.trim() ? project.name.trim() : 'Project',
    description: typeof project.description === 'string' ? project.description : '',
    technologies: Array.isArray(project.technologies)
      ? project.technologies.filter((item) => typeof item === 'string' && item).slice(0, 4)
      : [],
    markers: Array.isArray(project.markers)
      ? project.markers.filter((item) => typeof item === 'string' && item).slice(0, 6)
      : [],
    alreadyOpenedProjectId: project.alreadyOpenedProjectId ?? null,
  }));
}

/** Picker rows: previously opened projects first, then alphabetical order. */
export function discoveredProjectRows(projects = []) {
  return normalizeDiscoveredProjects(projects).sort((a, b) => {
    const openedA = a.alreadyOpenedProjectId !== null ? 0 : 1;
    const openedB = b.alreadyOpenedProjectId !== null ? 0 : 1;
    return openedA - openedB || a.name.localeCompare(b.name);
  });
}

/** Chooses only allowlisted root files that the scan actually found. */
export function projectUnderstandingPaths({ files = [], manifests = [] } = {}) {
  const available = [...(Array.isArray(files) ? files : []), ...(Array.isArray(manifests) ? manifests : [])]
    .filter((file) => typeof file === 'string' && file && !file.includes('/'));
  const paths = [];
  for (const wanted of PROJECT_UNDERSTANDING_FILES) {
    const match = available.find((file) => fileName(file).toLowerCase() === wanted.toLowerCase());
    if (match && !paths.includes(match)) paths.push(match);
    if (paths.length >= 6) break;
  }
  return paths;
}

/** Brief completion summary from the existing scan result and safe doc reads. */
export function workspaceUnderstandingSummary({ result = null, readPaths = [] } = {}) {
  const summary = workspaceScanSummary(result);
  const hints = [
    ...(Array.isArray(summary.projectTypes) ? summary.projectTypes : []),
    ...summary.frameworkHints,
    ...summary.languageHints,
  ].slice(0, 4);
  const docs = (Array.isArray(readPaths) ? readPaths : [])
    .map(fileName)
    .filter(Boolean)
    .slice(0, 6);
  const parts = [`${summary.fileCount} files indexed`];
  if (hints.length) parts.push(hints.join(', '));
  if (docs.length) parts.push(`read ${docs.join(', ')}`);
  if (summary.truncated) parts.push('partial scan');
  return `Understood project: ${parts.join(' · ')}.`;
}

/** Positive numeric ID for a project that exists in the current list. */
export function matchingProjectId(projects, projectId) {
  const wanted = projectId === null || projectId === undefined || projectId === '' ? null : String(projectId);
  if (wanted === null) return null;
  const match = (Array.isArray(projects) ? projects : []).find(
    (project) => String(project?.id) === wanted,
  );
  if (!match) return null;
  const id = Number(match.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Chooses a restored project only from the account's loaded project list. It
 * never keeps a project ID that belongs to a previous account or a deleted
 * project.
 */
export function selectRestoredProjectId({
  projects = [],
  currentProjectId = '',
  storedProjectId = '',
  projectsLoaded = false,
} = {}) {
  if (!projectsLoaded || !Array.isArray(projects) || projects.length === 0) return '';
  // A saved ID that is gone or belongs to another account must force an
  // explicit choice. Silently adopting another project hides the stale state.
  if (storedProjectId && matchingProjectId(projects, storedProjectId) === null) return '';
  if (matchingProjectId(projects, currentProjectId) !== null) return String(currentProjectId);
  const stored = matchingProjectId(projects, storedProjectId);
  if (stored !== null) return String(stored);
  return String(projects[0].id);
}

/** Active-project persistence waits for a validated selection after loading. */
export function activeProjectIdForPersistence({ projectsLoaded = false, activeProject = null } = {}) {
  if (!projectsLoaded || !activeProject) return null;
  return matchingProjectId([activeProject], activeProject.id);
}

/** Only a validated project from the current account may reach /api/chat. */
export function validatedChatProjectId({
  projects = [],
  projectId = '',
  activeProject = null,
  projectsLoaded = false,
} = {}) {
  if (!projectsLoaded) return null;
  const candidate = activeProject || null;
  if (candidate) {
    const candidateId = matchingProjectId([candidate], candidate.id);
    // The active project must also be present in the account's loaded list.
    // Validating the object alone would let a stale or foreign project through.
    if (candidateId === null || matchingProjectId(projects, candidateId) === null) return null;
    if (projectId && String(candidateId) !== String(projectId)) return null;
    return candidateId;
  }
  return matchingProjectId(projects, projectId);
}

/** Chat request context: always current auth/project state, never retry state. */
export function chatRequestContext({
  authToken = null,
  projects = [],
  projectId = '',
  activeProject = null,
  projectsLoaded = false,
  retryRequest = null,
} = {}) {
  // Retry only carries the prompt/history. Workspace scope is revalidated from
  // the current account and project list after auth is restored.
  void retryRequest;
  return {
    token: authToken || null,
    projectId: validatedChatProjectId({ projects, projectId, activeProject, projectsLoaded }),
  };
}

/**
 * User-visible workspace selection state. Keep loading, load failure, empty
 * ownership, stale restoration, missing selection, and ready states distinct
 * so none of them are mistaken for a provider or backend failure.
 */
export function workspaceSelectionState({
  loading = false,
  loadError = null,
  projects = [],
  projectId = '',
  activeProject = null,
  staleRestoredProjectId = '',
} = {}) {
  if (loading) {
    return {
      status: 'loading',
      ready: false,
      projectId: null,
      message: 'Loading your authorized projects…',
    };
  }
  if (loadError) {
    return {
      status: 'load_error',
      ready: false,
      projectId: null,
      message: 'Could not load your authorized projects. Retry or reload the page.',
    };
  }

  const list = Array.isArray(projects) ? projects : [];
  if (list.length === 0) {
    return {
      status: 'no_projects',
      ready: false,
      projectId: null,
      message: 'No authorized projects are available. Add a project or ask an administrator to assign one.',
    };
  }

  const stale = Boolean(staleRestoredProjectId)
    && matchingProjectId(list, staleRestoredProjectId) === null;
  if (stale) {
    return {
      status: 'stale_selection',
      ready: false,
      projectId: null,
      message: 'Your previously selected project is no longer available. Choose a project from the list or open one.',
    };
  }

  const validated = validatedChatProjectId({
    projects: list,
    projectId,
    activeProject,
    projectsLoaded: true,
  });
  if (validated === null) {
    return {
      status: 'needs_selection',
      ready: false,
      projectId: null,
      message: 'Select an authorized project to let the agent inspect its files.',
    };
  }

  const project = list.find((item) => String(item.id) === String(validated)) || activeProject;
  const projectName = project?.name || String(validated);
  return {
    status: 'ready',
    ready: true,
    projectId: validated,
    message: `Workspace ready: ${projectName}`,
  };
}

/** Only a verified selection may be shown as the currently active workspace. */
export function verifiedWorkspaceProject({ projects = [], selection = null } = {}) {
  if (!selection?.ready || selection.projectId === null || selection.projectId === undefined) return null;
  const list = Array.isArray(projects) ? projects : [];
  return list.find((project) => String(project?.id) === String(selection.projectId)) || null;
}

/** Shared message for send paths that are temporarily blocked by project loading. */
export function workspaceLoadingMessage(loading = false) {
  return loading ? 'Loading your authorized projects. Try again in a moment.' : null;
}

/**
 * Guards an async project creation against an account switch, a newer project
 * load, a scope change, or sign-out that happened while the request was in
 * flight. A stale response must be discarded rather than applied.
 */
export function isCurrentProjectCreationScope({
  authenticated = false,
  currentUserId = null,
  requestUserId = null,
  currentGeneration = 0,
  requestGeneration = 0,
  currentScope = null,
  requestScope = null,
} = {}) {
  return Boolean(authenticated)
    && currentUserId === requestUserId
    && currentGeneration === requestGeneration
    && currentScope === requestScope;
}

/**
 * Turns the existing path-safe /tree response into a small, user-visible
 * summary of what the agent can see. Missing metadata stays absent; no extra
 * scan is started by the UI.
 */
export function workspaceScanSummary(result = null) {
  const files = Array.isArray(result?.files) ? result.files : [];
  const directories = Array.isArray(result?.directories) ? result.directories : [];
  const manifests = Array.isArray(result?.manifests) ? result.manifests : [];
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  return {
    fileCount: files.length,
    directoryCount: directories.length,
    manifestCount: manifests.length,
    manifestNames: manifests.map((file) => fileName(file)),
    languageHints: Array.isArray(result?.languageHints) ? result.languageHints : [],
    frameworkHints: Array.isArray(result?.frameworkHints) ? result.frameworkHints : [],
    projectTypes: Array.isArray(result?.projectTypes) ? result.projectTypes : [],
    skipped: Number.isFinite(result?.skipped) ? result.skipped : 0,
    truncated: Boolean(result?.truncated),
    errorCount: errors.length,
  };
}

/** Scanning progress/result state shared by the welcome banner and files dock. */
export function workspaceScanStatus({
  hasProject = false,
  loading = false,
  error = null,
  result = null,
} = {}) {
  if (!hasProject) {
    return {
      status: 'unavailable',
      message: 'Select an authorized project to let the agent inspect its files.',
      summary: null,
    };
  }
  if (loading) {
    return {
      status: 'scanning',
      message: 'Scanning the selected workspace with the safe file scanner…',
      summary: null,
    };
  }
  if (error) {
    return {
      status: 'failed',
      message: 'Workspace scan failed. Retry to let the agent inspect the files.',
      summary: null,
    };
  }
  if (result) {
    const summary = workspaceScanSummary(result);
    const hints = [...summary.frameworkHints, ...summary.languageHints].slice(0, 4);
    const details = [`${summary.fileCount} files`, `${summary.directoryCount} folders`];
    if (hints.length) details.push(hints.join(', '));
    if (summary.truncated) details.push('partial scan');
    return {
      status: 'complete',
      message: `Workspace ready: ${details.join(' · ')}.`,
      summary,
    };
  }
  return {
    status: 'idle',
    message: 'Workspace selected. Preparing the safe file scan…',
    summary: null,
  };
}

/**
 * Only a verified, authenticated selection may start the existing safe scan.
 * This prevents scans during project loading, after sign-out, or for a stale
 * project ID that belongs to another account.
 */
export function shouldStartWorkspaceScan({
  authenticated = false,
  projectId = '',
  workspaceReady = false,
} = {}) {
  const id = Number(projectId);
  return Boolean(
    authenticated
    && workspaceReady
    && projectId !== ''
    && Number.isInteger(id)
    && id > 0,
  );
}

/** Human-readable workspace banner text derived from the backend reason. */
export function workspaceStatusMessage(workspace) {
  if (!workspace || workspace.available) return null;
  if (workspace.reason === 'workspace_unavailable') {
    return 'The selected workspace is no longer available. Choose a different project to let the agent inspect its files.';
  }
  return 'No approved workspace was selected, so file inspection tools were unavailable. Select a project to let the agent inspect its files.';
}

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
  const validated = candidate
    ? matchingProjectId([candidate], candidate.id)
    : matchingProjectId(projects, projectId);
  if (validated === null) return null;
  if (candidate && projectId && String(candidate.id) !== String(projectId)) return null;
  return validated;
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

/** Human-readable workspace banner text derived from the backend reason. */
export function workspaceStatusMessage(workspace) {
  if (!workspace || workspace.available) return null;
  if (workspace.reason === 'workspace_unavailable') {
    return 'The selected workspace is no longer available. Choose a different project to let the agent inspect its files.';
  }
  return 'No approved workspace was selected, so file inspection tools were unavailable. Select a project to let the agent inspect its files.';
}

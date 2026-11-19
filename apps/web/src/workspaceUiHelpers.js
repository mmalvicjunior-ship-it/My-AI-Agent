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

// Pure helpers for the Task Center approval interface.
// No React or browser APIs here so these rules can be tested with node:test.

export const TERMINAL_PROPOSAL_STATUSES = new Set([
  'applied',
  'rejected',
  'failed',
  'interrupted',
]);

export function linkedProposalIds(task) {
  // The task API now omits plan_json (it may contain proposed file contents)
  // and returns only this safe list. Keep the legacy shape readable for older
  // cached responses.
  if (Array.isArray(task?.linkedProposalIds)) {
    return task.linkedProposalIds.filter((id) => typeof id === 'string' && id);
  }
  let plan = task?.plan_json;
  if (typeof plan === 'string') {
    try {
      plan = JSON.parse(plan);
    } catch {
      return [];
    }
  }
  if (!plan || !Array.isArray(plan.proposals)) return [];

  const ids = [];
  for (const entry of plan.proposals) {
    const id = entry && typeof entry === 'object' ? entry.id : entry;
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function pendingCountForTask(task, pendingIds) {
  const pending = pendingIds instanceof Set ? pendingIds : new Set(pendingIds || []);
  return linkedProposalIds(task).filter((id) => pending.has(id)).length;
}

function isPythonCommand(proposal) {
  return proposal?.command === 'python_check' || proposal?.command === 'python_run';
}

export function proposalTypeLabel(proposal) {
  if (proposal?.type === 'command' && isPythonCommand(proposal)) {
    return proposal.command === 'python_run' ? 'Python · Run' : 'Python · Check';
  }
  if (proposal?.type === 'command') return 'Command';
  if (proposal?.type === 'file') {
    return proposal.action === 'update' ? 'File · Edit' : 'File · Create';
  }
  return proposal?.type || 'Proposal';
}

export function proposalStatusLabel(proposal) {
  if (proposal?.status === 'pending' && proposal.expired) return 'Expired';
  const labels = {
    pending: 'Awaiting approval',
    applying: 'Processing',
    applied: proposal?.type === 'command' ? 'Ran' : 'Applied',
    rejected: 'Rejected',
    failed: 'Failed',
    interrupted: 'Interrupted',
  };
  return labels[proposal?.status] || proposal?.status || 'Unknown';
}

export function proposalDecisionLabel(proposal, decision) {
  if (decision === 'reject') return 'Reject';
  if (proposal?.type === 'command' && isPythonCommand(proposal)) {
    return proposal.command === 'python_run' ? 'Run Python file' : 'Run Python check';
  }
  if (proposal?.type === 'command') return 'Run command';
  return 'Apply file';
}

export function isProposalActionable(proposal, busyProposalId = null) {
  if (!proposal || proposal.status !== 'pending' || proposal.expired) return false;
  if (proposal.type !== 'file' && proposal.type !== 'command') return false;
  if (busyProposalId && String(busyProposalId) === String(proposal.proposalId)) return false;
  return true;
}

export function normalizeDecisionError(error, responseStatus = null) {
  const status = responseStatus ?? error?.status ?? error?.statusCode ?? null;
  if (status === 401) {
    return { code: 'unauthorized', message: 'Your session expired. Sign in again.' };
  }
  if (status === 404) {
    return { code: 'unavailable', message: 'This proposal is no longer available. Its status will be refreshed.' };
  }
  if (status === 410) {
    return { code: 'expired', message: 'This proposal expired. Nothing was applied or run.' };
  }
  if (typeof status === 'number' && status >= 500) {
    return { code: 'server', message: 'The server could not complete that action. No change was made.' };
  }
  if (error && typeof error.message === 'string' && error.message) {
    return { code: 'error', message: error.message };
  }
  return { code: 'network', message: 'Could not reach the server. No change was made.' };
}

export function diffLines(diff = '', limit = 400) {
  const rows = String(diff ?? '').split('\n').map((line) => line.replace(/\r$/, ''));
  const lines = rows.slice(0, limit).map((text) => {
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('@@')) {
      return { type: 'meta', text };
    }
    if (text.startsWith('+')) return { type: 'add', text };
    if (text.startsWith('-')) return { type: 'remove', text };
    return { type: 'context', text };
  });
  return { lines, truncated: rows.length > limit };
}

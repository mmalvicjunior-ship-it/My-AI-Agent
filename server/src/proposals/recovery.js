// Startup reconciliation for proposals that were mid-application when the
// previous process stopped.
//
// Nothing here writes, spawns, or retries. Each `applying` row is classified
// by reading the target file (or, for a command, by admitting that the outcome
// is unknowable) and is then moved to exactly one terminal/pending state.
import {
  WorkspaceError,
  getProjectRoot,
  readTextFile,
} from '../workspace/files.js';
import {
  completeProposal,
  failProposal,
  interruptProposal,
  listApplyingProposals,
  releaseClaim,
} from './store.js';

const CREATE_CONFLICT =
  'The server stopped while creating this file, and the file now exists with different content. The create was not retried; review the file and stage a fresh proposal if needed.';

const UPDATE_CONFLICT =
  'The server stopped while updating this file, and its content no longer matches the reviewed version. The update was not retried; review the file and stage a fresh proposal if needed.';

const COMMAND_UNKNOWN =
  'The server stopped while this command was running. It was not retried automatically because its side effects are unknown; check the workspace and stage it again if needed.';

function readCurrentContent(db, row, workspaceRoot) {
  const root = getProjectRoot(db, workspaceRoot, row.project_id);
  try {
    return readTextFile(root, row.path).content;
  } catch (error) {
    if (error instanceof WorkspaceError && error.status === 404) return null;
    throw error;
  }
}

function reconcile(db, row, workspaceRoot) {
  if (row.kind === 'command') {
    interruptProposal(db, row.id, COMMAND_UNKNOWN);
    return 'interrupted';
  }

  const current = readCurrentContent(db, row, workspaceRoot);

  if (row.kind === 'create') {
    if (current === null) {
      // Nothing was written before the crash: safe to offer for approval again.
      releaseClaim(db, row.id);
      return 'pending';
    }
    if (current === row.content) {
      // The write landed but the final history/status transaction did not.
      completeProposal(db, row, { path: row.path, action: 'create', diff: row.diff });
      return 'applied';
    }
    failProposal(db, row.id, CREATE_CONFLICT);
    return 'failed';
  }

  // kind === 'update'
  if (current === row.content) {
    completeProposal(db, row, { path: row.path, action: 'update', diff: row.diff });
    return 'applied';
  }
  if (current === row.original_content) {
    releaseClaim(db, row.id);
    return 'pending';
  }
  failProposal(db, row.id, UPDATE_CONFLICT);
  return 'failed';
}

/**
 * Reconciles every proposal left in `applying`. Safe to call more than once:
 * each transition is conditional on the row still being `applying`.
 * Runs synchronously at app construction (boot), before any request is served.
 */
export function recoverInterruptedProposals({ db, workspaceRoot, logger = console }) {
  const rows = listApplyingProposals(db);
  const counts = { applied: 0, pending: 0, failed: 0, interrupted: 0 };

  for (const row of rows) {
    try {
      counts[reconcile(db, row, workspaceRoot)] += 1;
    } catch (error) {
      // A missing/changed workspace, an unreadable file, or a path that is no
      // longer valid: never guess, never retry. Fail the proposal instead.
      failProposal(
        db,
        row.id,
        `The interrupted application could not be verified: ${error?.message || error}`,
      );
      counts.failed += 1;
    }
  }

  if (rows.length > 0) {
    logger?.info?.(
      `[proposals] recovered ${rows.length} interrupted proposal(s): `
      + `${counts.applied} applied, ${counts.pending} pending, `
      + `${counts.failed} failed, ${counts.interrupted} interrupted`,
    );
  }

  return { total: rows.length, ...counts };
}

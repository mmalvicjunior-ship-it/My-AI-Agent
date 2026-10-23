// SQLite-backed workspace proposals.
//
// The store owns the proposal state machine so the tools, the HTTP routes and
// startup recovery all agree on what is allowed:
//
//   pending --claim--> applying --finalize--> applied
//                          |--release (write refused)--> pending
//                          |--fail (conflict)----------> failed
//                          `--interrupt (unknown)------> interrupted
//   pending --discard-------------------------------> rejected
//
// Only `pending` rows are visible through the existing proposal API, so an
// applied, discarded or failed proposal still answers 404 exactly like the
// previous in-memory map did.
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../config.js';

export const PROPOSAL_KINDS = Object.freeze(['create', 'update', 'command']);

export const PROPOSAL_STATUSES = Object.freeze([
  'pending',
  'applying',
  'applied',
  'rejected',
  'failed',
  'interrupted',
]);

const INSERT_SQL = `
  INSERT INTO proposals
    (id, project_id, kind, path, content, original_content, diff, command, command_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const RESULT_COLUMN = 'result_json';

export function ensureResultColumn(db) {
  const columns = db.prepare('PRAGMA table_info(proposals)').all().map((c) => c.name);
  if (!columns.includes(RESULT_COLUMN)) {
    db.exec(`ALTER TABLE proposals ADD COLUMN ${RESULT_COLUMN} TEXT`);
  }
}

/**
 * Finds an existing pending proposal that already describes the same change.
 * Used to keep a retry or a resumed run from staging the same work twice.
 * Only `pending` rows match: an applied proposal is never repeated.
 */
export function findPendingProposal(db, projectId, kind, path = null, content = null, command = null) {
  const row = db
    .prepare(`
      SELECT id, path, content, command
      FROM proposals
      WHERE project_id = ? AND kind = ? AND status = 'pending'
      ORDER BY rowid ASC
      LIMIT 1
    `)
    .get(Number(projectId), kind);
  if (!row) return null;
  if ((row.path ?? null) !== (path ?? null)) return null;
  if ((row.command ?? null) !== (command ?? null)) return null;
  if ((row.content ?? null) !== (content ?? null)) return null;
  return getProposal(db, row.id);
}

export function getProposal(db, id) {
  return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) ?? null;
}

export function stageProposal(db, {
  projectId,
  kind,
  path = null,
  content = null,
  originalContent = null,
  diff = null,
  command = null,
  commandPath = null,
}) {
  const id = randomUUID();
  db.prepare(INSERT_SQL).run(
    id,
    Number(projectId),
    kind,
    path,
    content,
    originalContent,
    diff,
    command,
    commandPath,
  );
  return getProposal(db, id);
}

/** Pending proposals for one project, in staging order. */
export function listPendingProposals(db, projectId) {
  return db
    .prepare(`
      SELECT * FROM proposals
      WHERE project_id = ? AND status = 'pending'
      ORDER BY rowid ASC
    `)
    .all(Number(projectId));
}

export function getPendingProposal(db, projectId, proposalId) {
  if (typeof proposalId !== 'string' || proposalId === '') return null;
  return db
    .prepare(`
      SELECT * FROM proposals
      WHERE id = ? AND project_id = ? AND status = 'pending'
    `)
    .get(proposalId, Number(projectId)) ?? null;
}

/** Rows left mid-application by a previous process. */
export function listApplyingProposals(db) {
  return db
    .prepare("SELECT * FROM proposals WHERE status = 'applying' ORDER BY rowid ASC")
    .all();
}

/**
 * Atomically moves one pending proposal to `applying`.
 * Returns false when it was already claimed, applied, rejected, or belongs to
 * another project, so a second click (or a second request) cannot write twice.
 */
export function claimProposal(db, projectId, proposalId) {
  const result = db
    .prepare(`
      UPDATE proposals
      SET status = 'applying', error = NULL, updated_at = datetime('now')
      WHERE id = ? AND project_id = ? AND status = 'pending'
    `)
    .run(proposalId, Number(projectId));
  return result.changes === 1;
}

/** Returns a claimed proposal to `pending` when nothing was written. */
export function releaseClaim(db, proposalId) {
  const result = db
    .prepare(`
      UPDATE proposals
      SET status = 'pending', error = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'applying'
    `)
    .run(proposalId);
  return result.changes === 1;
}

function inTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original error is the useful one.
    }
    throw error;
  }
}

/**
 * Finalizes a claimed proposal. The status transition and the `file_changes`
 * audit row commit together, so a crash can never leave a proposal marked
 * applied without history, nor history without the applied status.
 */
export function completeProposal(db, proposal, { path = null, action = null, diff = null, result = null } = {}) {
  return inTransaction(db, () => {
    // The optional result payload (command exit code / trimmed output) is stored
    // as JSON so a task can report an actual test outcome later. It is
    // redacted and size-limited by the caller before it reaches this point.
    const resultJson = result === null || result === undefined ? null : redactSecrets(JSON.stringify(result));
    const update = db
      .prepare(`
        UPDATE proposals
        SET status = 'applied',
            error = NULL,
            result_json = ?,
            finished_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ? AND status = 'applying'
      `)
      .run(resultJson, proposal.id);
    if (update.changes !== 1) return false; // another process already finalized it
    if (proposal.kind !== 'command' && action) {
      db.prepare('INSERT INTO file_changes (project_id, path, action, source, diff) VALUES (?, ?, ?, ?, ?)')
        .run(Number(proposal.project_id), path, action, 'agent', diff || null);
    }
    return true;
  });
}

export function rejectProposal(db, projectId, proposalId) {
  if (typeof proposalId !== 'string' || proposalId === '') return false;
  const result = db
    .prepare(`
      UPDATE proposals
      SET status = 'rejected', finished_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND project_id = ? AND status = 'pending'
    `)
    .run(proposalId, Number(projectId));
  return result.changes === 1;
}

/** Terminal failure: known not to be retryable, so it is never applied again. */
export function failProposal(db, proposalId, error) {
  const result = db
    .prepare(`
      UPDATE proposals
      SET status = 'failed',
          error = ?,
          finished_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ? AND status = 'applying'
    `)
    .run(redactSecrets(String(error || 'Unknown failure.')), proposalId);
  return result.changes === 1;
}

/** Terminal unknown outcome (for example a command that was mid-run at crash). */
export function interruptProposal(db, proposalId, error) {
  const result = db
    .prepare(`
      UPDATE proposals
      SET status = 'interrupted',
          error = ?,
          finished_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ? AND status = 'applying'
    `)
    .run(redactSecrets(String(error || 'Outcome unknown after an interrupted run.')), proposalId);
  return result.changes === 1;
}

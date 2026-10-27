// Persistence helpers for the background task queue.
// Kept separate from the routes and the runner so both share one definition of
// the status transitions and never disagree about what a task is allowed to do.
import { redactSecrets } from '../config.js';

export const TASK_STATUSES = Object.freeze([
  'queued',
  'running',
  'waiting_approval',
  'provider_paused',
  'completed',
  'failed',
  'cancelled',
]);

/** Persisted task plan stored alongside each task.
 *  Batch plans contain metadata. Ordered plans additionally retain the
 *  redacted pending step payload needed to continue after user approval.
 *  Null when no plan has been set.
 */
export const TASK_PLAN_COLUMN = 'plan_json';
export const TASK_AUTONOMOUS_COLUMN = 'autonomous';

/** Ensure the tasks table has the plan column.
 *  Safe to call repeatedly; does nothing if the column already exists.
 */
export function ensurePlanColumn(db) {
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!columns.includes(TASK_PLAN_COLUMN)) {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${TASK_PLAN_COLUMN} TEXT`);
  }
}

/** Ensure the tasks table has the autonomous column (idempotent migration). */
export function ensureAutonomyColumn(db) {
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!columns.includes(TASK_AUTONOMOUS_COLUMN)) {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${TASK_AUTONOMOUS_COLUMN} INTEGER NOT NULL DEFAULT 0`);
  }
}

/** Serialise a plan object into the JSON column.
 * The plan is expected to be a plain object (or null). Ordered step payloads
 * are persisted for continuation, so callers must redact configured secrets
 * and enforce the byte limit before storing.
 */
export const MAX_PLAN_BYTES = 64 * 1024;

export function savePlan(db, taskId, plan) {
  ensurePlanColumn(db);
  if (plan === null || plan === undefined) {
    db.prepare(
      `UPDATE tasks SET ${TASK_PLAN_COLUMN} = NULL WHERE id = ?`,
    ).run(taskId);
    return null;
  }
  if (typeof plan !== 'object') {
    throw new TypeError('A task plan must be a JSON-serialisable object or null.');
  }
  let json;
  try {
    json = JSON.stringify(plan);
  } catch (error) {
    throw new TypeError(`A task plan must be JSON-serialisable: ${error?.message || error}`);
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_PLAN_BYTES) {
    throw new TypeError(`Task plan exceeds the ${MAX_PLAN_BYTES} byte limit.`);
  }
  db.prepare(
    `UPDATE tasks SET ${TASK_PLAN_COLUMN} = ? WHERE id = ?`,
  ).run(json, taskId);
  return plan;
}

/** Increments the multi-step / repair progress recorded in a plan without
 * touching file contents. Returns the new progress (a number of remaining
 * steps to consume before the task can be considered fully complete). */
export function advancePlanProgress(plan, { currentStep = 0, repairAttempt = 0 } = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (typeof currentStep === 'number') {
    plan.currentStep = Math.min(Number(currentStep), steps.length);
  }
  if (typeof repairAttempt === 'number') {
    const cap = 3; // MAX_REPAIR_ATTEMPTS
    plan.repairAttempt = Math.min(Math.max(Number(repairAttempt), 0), cap);
  }
  return plan;
}

// Update a stored plan with progress (incremented currentStep / repairAttempt)
// without recreating the whole plan.
export function refreshPlanProgress(db, taskId, patch = {}) {
  const plan = loadPlan(db, taskId);
  if (!plan || typeof plan !== 'object') return null;
  advancePlanProgress(plan, patch);
  savePlan(db, taskId, plan);
  return plan;
}

/** Deserialise the plan JSON from a task row.
 *  Returns null when the column is NULL or the task does not exist.
 */
export function loadPlan(db, taskId) {
  const row = db.prepare(`SELECT ${TASK_PLAN_COLUMN} FROM tasks WHERE id = ?`).get(taskId);
  if (!row) return null;
  const json = row[TASK_PLAN_COLUMN];
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Statuses where the task can still make progress (or still be cancelled).
export const ACTIVE_TASK_STATUSES = Object.freeze(['queued', 'running', 'waiting_approval', 'provider_paused']);

export const AUTONOMY_LEVELS = Object.freeze([
  'supervised',
  'propose',
  'approved_autonomous',
  'allow_writes',
  'allow_writes_and_commands',
]);

// Default: Propose mode. The agent can independently inspect the workspace,
// read files, search code, prepare a plan, and stage change proposals. It must
// wait for user approval before applying changes or executing commands.
export const DEFAULT_AUTONOMY = 'propose';

/**
 * Validates whether a task has permission for autonomous execution.
 * Only 'approved_autonomous' (or legacy 'allow_writes_and_commands' when explicitly flagged)
 * is permitted autonomous execution; 'propose' and 'supervised' always require approval.
 */
export function isAutonomousTask(task) {
  if (!task || typeof task !== 'object') return false;
  const autonomy = task.autonomy || DEFAULT_AUTONOMY;
  if (autonomy === 'propose' || autonomy === 'supervised') return false;
  const flag = task.autonomous === 1 || task.autonomous === true;
  return (autonomy === 'approved_autonomous' || autonomy === 'allow_writes_and_commands') && flag;
}

export const MAX_INSTRUCTION_CHARS = 20_000;

export const INTERRUPTED_ERROR =
  'Interrupted by a server restart before it finished. The last step may not have completed, so the task was not resumed automatically.';

export function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
}

export function createTask(db, { projectId, instruction, autonomy = DEFAULT_AUTONOMY, autonomous = false }) {
  const safeAutonomy = AUTONOMY_LEVELS.includes(autonomy) ? autonomy : DEFAULT_AUTONOMY;
  const isAutoApproved = safeAutonomy === 'approved_autonomous' || (safeAutonomy === 'allow_writes_and_commands' && Boolean(autonomous));
  const effectiveAutonomous = (safeAutonomy === 'propose' || safeAutonomy === 'supervised') ? 0 : (isAutoApproved ? 1 : 0);

  // Backward-compatible: some isolated test DBs create the tasks table without
  // the autonomous column, so only include it when it already exists.
  const hasAutonomousColumn = db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === TASK_AUTONOMOUS_COLUMN);
  if (hasAutonomousColumn) {
    const result = db
      .prepare(`INSERT INTO tasks (project_id, instruction, autonomy, ${TASK_AUTONOMOUS_COLUMN}) VALUES (?, ?, ?, ?)`)
      .run(projectId, instruction, safeAutonomy, effectiveAutonomous);
    return getTask(db, Number(result.lastInsertRowid));
  }
  // Existing DBs without the column: safe default to approval mode (no autonomous).
  const result = db
    .prepare('INSERT INTO tasks (project_id, instruction, autonomy) VALUES (?, ?, ?)')
    .run(projectId, instruction, safeAutonomy);
  return getTask(db, Number(result.lastInsertRowid));
}

export function listTasks(db, { projectId = null, status = null, limit = 20 } = {}) {
  const clauses = [];
  const params = [];
  if (projectId !== null) {
    clauses.push('t.project_id = ?');
    params.push(projectId);
  }
  if (status !== null) {
    clauses.push('t.status = ?');
    params.push(status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  return db
    .prepare(`
      SELECT t.*,
             (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.id) AS step_count
      FROM tasks t
      ${where}
      ORDER BY t.id DESC
      LIMIT ?
    `)
    .all(...params);
}

export function listSteps(db, taskId) {
  return db
    .prepare(`
      SELECT id, task_id, seq, kind, title, detail, status, created_at
      FROM task_steps
      WHERE task_id = ?
      ORDER BY seq ASC, id ASC
    `)
    .all(taskId);
}

export function appendStep(db, taskId, { kind = 'note', title, detail = null, status = 'done' }) {
  const next = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_steps WHERE task_id = ?')
    .get(taskId);
  const seq = Number(next?.seq ?? 1);
  db.prepare(
    'INSERT INTO task_steps (task_id, seq, kind, title, detail, status) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(taskId, seq, kind, title, detail, status);
  // "Last completed step" is denormalised so a task list needs no join.
  db.prepare("UPDATE tasks SET last_step = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title, taskId);
  return seq;
}

// Atomically moves one queued task to running. Returns null when another
// caller (or another runner) already claimed it.
export const TERMINAL_PROPOSAL_STATUSES = new Set(['applied', 'rejected', 'failed', 'interrupted']);

export function setWaitingApproval(db, taskId) {
  const result = db
    .prepare("UPDATE tasks SET status = 'waiting_approval', error = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'running'")
    .run(taskId);
  if (result.changes === 0) return null;
  return getTask(db, taskId);
}

export function claimReadyWaitingTask(db) {
  const rows = db
    .prepare("SELECT id, plan_json FROM tasks WHERE status = 'waiting_approval' ORDER BY id LIMIT 1")
    .all();
  for (const row of rows) {
    let proposalIds = [];
    try {
      const plan = JSON.parse(row.plan_json || '{}');
      proposalIds = Array.isArray(plan.proposals) ? plan.proposals.map(p => p?.id || p).filter(Boolean) : [];
    } catch {}
    if (!proposalIds.length) continue;
    const placeholders = proposalIds.map(() => '?').join(',');
    const statusRows = db
      .prepare(`SELECT id, status FROM proposals WHERE id IN (${placeholders})`)
      .all(...proposalIds);
    if (statusRows.length !== proposalIds.length) continue;
    if (statusRows.every(r => TERMINAL_PROPOSAL_STATUSES.has(r.status))) {
      const update = db
        .prepare("UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'waiting_approval'")
        .run(row.id);
      if (update.changes === 1) return getTask(db, row.id);
    }
  }
  return null;
}

export function claimNextQueued(db) {
  const candidate = db
    .prepare("SELECT id FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1")
    .get();
  if (!candidate) return null;
  const result = db
    .prepare(`
      UPDATE tasks
      SET status = 'running',
          started_at = COALESCE(started_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ? AND status = 'queued'
    `)
    .run(candidate.id);
  if (result.changes !== 1) return null;
  return getTask(db, candidate.id);
}

export function finishTask(db, taskId, status, error = null) {
  const safeError = error ? redactSecrets(String(error)) : null;
  db.prepare(`
    UPDATE tasks
    SET status = ?,
        error = ?,
        finished_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(status, safeError, taskId);
  return getTask(db, taskId);
}

export function isCancelRequested(db, taskId) {
  const row = db.prepare('SELECT cancel_requested FROM tasks WHERE id = ?').get(taskId);
  return Boolean(row?.cancel_requested);
}

/**
 * Records a cancellation request.
 * - queued / waiting_approval: nothing is executing, so the task becomes
 *   cancelled immediately.
 * - running: the runner owns the final transition. It observes the flag,
 *   aborts the in-flight step and then records `cancelled`.
 * - completed / failed / cancelled: returns the task unchanged so the route can
 *   answer 409 instead of pretending anything happened.
 */
export function requestCancel(db, task) {
  if (!ACTIVE_TASK_STATUSES.includes(task.status)) {
    return { task, accepted: false };
  }
  if (task.status === 'running') {
    db.prepare(`
      UPDATE tasks
      SET cancel_requested = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(task.id);
    return { task: getTask(db, task.id), accepted: true };
  }
  db.prepare(`
    UPDATE tasks
    SET status = 'cancelled',
        cancel_requested = 1,
        finished_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(task.id);
  appendStep(db, task.id, {
    kind: 'note',
    title: 'Cancelled before it ran',
    detail: 'No work was performed for this task.',
    status: 'done',
  });
  return { task: getTask(db, task.id), accepted: true };
}

/* Quota & Recovery persistence (plan_json-based, no schema change) */
export function saveRecoveryInfo(db, taskId, info = {}) {
  const plan = loadPlan(db, taskId) || {};
  plan.recovery = { ...(plan.recovery || {}), ...info, updatedAt: new Date().toISOString() };
  savePlan(db, taskId, plan);
  return plan.recovery;
}

export function loadRecoveryInfo(db, taskId) {
  const plan = loadPlan(db, taskId);
  return plan?.recovery || null;
}

export function claimRecoverableTask(db) {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT id, plan_json FROM tasks WHERE status = 'provider_paused' ORDER BY id LIMIT 1
  `).all();
  for (const row of rows) {
    let rec = null;
    try {
      const plan = JSON.parse(row.plan_json || '{}');
      rec = plan.recovery || null;
    } catch {}
    const retryAt = rec?.nextRetryAt ? Number(new Date(rec.nextRetryAt).getTime()) : null;
    // Cancellation takes priority over recovery scheduling. A task that was
    // cancelled while paused is not resumed, even if its retry time passed.
    if (Number(row.cancel_requested || 0)) continue;
    // Conservative: resume only if retry time is known and passed, or unknown but
    // we allow one bounded availability check (avoids repeated quota-consuming requests).
    if (retryAt !== null && retryAt <= now) {
      const update = db.prepare("UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'provider_paused'").run(row.id);
      if (update.changes === 1) return getTask(db, row.id);
    }
    // Unknown reset: do not resume automatically to avoid consuming quota.
  }
  return null;
}

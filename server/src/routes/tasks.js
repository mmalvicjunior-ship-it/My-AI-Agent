// Background coding-task API.
// Stage 1 is the queue itself: create, inspect, list and cancel. Execution is
// handled by src/tasks/runner.js, never by the HTTP request that created a task.
import express from 'express';
import { redactSecrets } from '../config.js';
import {
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY,
  MAX_INSTRUCTION_CHARS,
  TASK_STATUSES,
  createTask,
  getTask,
  listSteps,
  listTasks,
  loadPlan,
  requestCancel,
} from '../tasks/store.js';
import { getProposal } from '../proposals/store.js';
import { isProposalExpired } from '../ai/tools.js';
import { unifiedDiff } from '../workspace/diff.js';
import { findOwnedProject, isBypassUser } from '../auth/index.js';

function parseTaskId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sendError(res, err, label) {
  console.error(`[tasks] ${label}:`, redactSecrets(`${err.name}: ${err.message}`));
  return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
}

function linkedProposalIds(plan) {
  if (!plan || !Array.isArray(plan.proposals)) return [];
  const ids = [];
  for (const entry of plan.proposals) {
    const id = entry && typeof entry === 'object' ? entry.id : entry;
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function parseProposalResult(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeRecovery(plan) {
  const rec = plan?.recovery;
  if (!rec || typeof rec !== 'object') return null;
  const reason = typeof rec.reason === 'string' ? rec.reason.slice(0, 120) : null;
  const nextRetryAt = typeof rec.nextRetryAt === 'string' ? rec.nextRetryAt : null;
  const pausedAt = typeof rec.pausedAt === 'string' ? rec.pausedAt : null;
  const retryAttempt = Number.isFinite(Number(rec.retryAttempt)) ? Number(rec.retryAttempt) : null;
  if (!reason && !nextRetryAt && !pausedAt && retryAttempt === null) return null;
  return {
    ...(reason ? { reason } : {}),
    ...(nextRetryAt ? { nextRetryAt } : {}),
    ...(pausedAt ? { pausedAt } : {}),
    ...(retryAttempt !== null ? { retryAttempt } : {}),
  };
}

/**
 * Task rows contain the full saved plan, which can include proposed file
 * contents. Never send it over HTTP: expose only the linked proposal ids the
 * Task Center needs to match pending proposals, plus safe recovery metadata.
 */
function publicTask(db, task) {
  if (!task || typeof task !== 'object') return task;
  const plan = loadPlan(db, task.id);
  const { plan_json: _planJson, ...safe } = task;
  const recovery = safeRecovery(plan);
  return {
    ...safe,
    linkedProposalIds: linkedProposalIds(plan),
    ...(recovery ? { recovery } : {}),
  };
}

/**
 * Build a read-only, task-scoped proposal view from the proposal IDs recorded
 * in the task plan. Never returns stored file contents, and never performs an
 * apply, reject, or command run.
 */
function projectTaskProposals(db, task) {
  const ids = linkedProposalIds(loadPlan(db, task.id));
  if (ids.length === 0) return [];

  const projected = [];
  for (const proposalId of ids) {
    const row = getProposal(db, proposalId);
    if (!row || Number(row.project_id) !== Number(task.project_id)) continue;

    const common = {
      proposalId: row.id,
      status: row.status,
      expired: row.status === 'pending' && isProposalExpired(row),
      error: row.error ?? null,
      finished_at: row.finished_at ?? null,
    };

    if (row.kind === 'command') {
      projected.push({
        ...common,
        type: 'command',
        command: row.command ?? null,
        path: row.command_path ?? null,
        ...(row.content ? { contentSha256: row.content } : {}),
        result: parseProposalResult(row.result_json),
      });
      continue;
    }

    const diff = row.diff ?? (row.kind === 'update'
      ? unifiedDiff(row.original_content ?? '', row.content ?? '', { oldPath: row.path, newPath: row.path })
      : unifiedDiff('', row.content ?? '', { oldPath: row.path, newPath: row.path }));
    projected.push({
      ...common,
      type: 'file',
      action: row.kind,
      path: row.path ?? null,
      diff,
    });
  }
  return projected;
}

export function createTasksRouter({ db }) {
  const router = express.Router();

  // Create a task: POST /api/tasks
  //   { projectId, instruction } -> 201, task stays 'queued'
  // Autonomy is server-controlled; client-supplied values are validated only
  // for backward-compatible error messages and never grant execution privileges.
  router.post('/', (req, res) => {
    const project = findOwnedProject(db, req.user, req.body?.projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });

    const instruction = typeof req.body?.instruction === 'string'
      ? req.body.instruction.trim()
      : '';
    if (!instruction) {
      return res.status(400).json({ ok: false, error: 'Instruction is required.' });
    }
    if (instruction.length > MAX_INSTRUCTION_CHARS) {
      return res.status(400).json({
        ok: false,
        error: `Instruction must be at most ${MAX_INSTRUCTION_CHARS} characters (received ${instruction.length}).`,
      });
    }

    const requestedAutonomy = req.body?.autonomy;
    if (requestedAutonomy !== undefined
      && requestedAutonomy !== null
      && !AUTONOMY_LEVELS.includes(requestedAutonomy)) {
      return res.status(400).json({
        ok: false,
        error: `Autonomy must be one of: ${AUTONOMY_LEVELS.join(', ')}.`,
      });
    }
    const autonomy = DEFAULT_AUTONOMY;
    const autonomous = false;

    try {
      const task = createTask(db, { projectId: project.id, instruction, autonomy, autonomous });
      return res.status(201).json({ ok: true, task: publicTask(db, task) });
    } catch (err) {
      return sendError(res, err, 'create');
    }
  });

  // List tasks: GET /api/tasks?projectId=1&status=queued&limit=20
  router.get('/', (req, res) => {
    let projectId = null;
    if (req.query.projectId !== undefined) {
      projectId = parseTaskId(req.query.projectId);
      if (projectId === null) {
        return res.status(400).json({ ok: false, error: 'Query parameter "projectId" must be a positive integer.' });
      }
      if (!findOwnedProject(db, req.user, projectId)) {
        return res.status(404).json({ ok: false, error: 'Project not found.' });
      }
    }
    let status = null;
    if (req.query.status !== undefined) {
      status = String(req.query.status);
      if (!TASK_STATUSES.includes(status)) {
        return res.status(400).json({
          ok: false,
          error: `Query parameter "status" must be one of: ${TASK_STATUSES.join(', ')}.`,
        });
      }
    }
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 20;

    try {
      const tasks = listTasks(db, {
        projectId,
        status,
        limit,
        ownerId: isBypassUser(req.user) ? null : req.user.id,
      });
      return res.json({ ok: true, tasks: tasks.map((task) => publicTask(db, task)) });
    } catch (err) {
      return sendError(res, err, 'list');
    }
  });

  // Task detail with its execution history: GET /api/tasks/:id
  router.get('/:id', (req, res) => {
    const id = parseTaskId(req.params.id);
    if (id === null) return res.status(404).json({ ok: false, error: 'Task not found.' });
    try {
      const task = getTask(db, id);
      if (!task || !findOwnedProject(db, req.user, task.project_id)) {
        return res.status(404).json({ ok: false, error: 'Task not found.' });
      }
      return res.json({
        ok: true,
        task: publicTask(db, task),
        steps: listSteps(db, id),
        proposals: projectTaskProposals(db, task),
      });
    } catch (err) {
      return sendError(res, err, 'detail');
    }
  });

  // Cancel: POST /api/tasks/:id/cancel
  // Queued / waiting tasks stop immediately; a running task is asked to stop
  // and the runner records the final `cancelled` state.
  router.post('/:id/cancel', (req, res) => {
    const id = parseTaskId(req.params.id);
    if (id === null) return res.status(404).json({ ok: false, error: 'Task not found.' });
    try {
      const task = getTask(db, id);
      if (!task || !findOwnedProject(db, req.user, task.project_id)) {
        return res.status(404).json({ ok: false, error: 'Task not found.' });
      }
      const { task: updated, accepted } = requestCancel(db, task);
      if (!accepted) {
        return res.status(409).json({
          ok: false,
          error: `Task is already ${task.status} and cannot be cancelled.`,
          task: publicTask(db, task),
        });
      }
      return res.json({
        ok: true,
        task: publicTask(db, updated),
        // A running task finishes cancelling on the runner's next check.
        cancelling: updated.status === 'running',
      });
    } catch (err) {
      return sendError(res, err, 'cancel');
    }
  });

  return router;
}

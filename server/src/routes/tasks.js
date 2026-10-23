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
  requestCancel,
} from '../tasks/store.js';

function findProject(db, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) return null;
  return db.prepare('SELECT id FROM projects WHERE id = ?').get(id) ?? null;
}

function parseTaskId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sendError(res, err, label) {
  console.error(`[tasks] ${label}:`, redactSecrets(`${err.name}: ${err.message}`));
  return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
}

export function createTasksRouter({ db }) {
  const router = express.Router();

  // Create a task: POST /api/tasks
  //   { projectId, instruction, autonomy? }  -> 201, task stays 'queued'
  router.post('/', (req, res) => {
    const project = findProject(db, req.body?.projectId);
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

    const autonomy = req.body?.autonomy ?? DEFAULT_AUTONOMY;
    if (!AUTONOMY_LEVELS.includes(autonomy)) {
      return res.status(400).json({
        ok: false,
        error: `Autonomy must be one of: ${AUTONOMY_LEVELS.join(', ')}.`,
      });
    }

    try {
      const task = createTask(db, { projectId: project.id, instruction, autonomy });
      return res.status(201).json({ ok: true, task });
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
      const tasks = listTasks(db, { projectId, status, limit });
      return res.json({ ok: true, tasks });
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
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found.' });
      return res.json({ ok: true, task, steps: listSteps(db, id) });
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
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found.' });
      const { task: updated, accepted } = requestCancel(db, task);
      if (!accepted) {
        return res.status(409).json({
          ok: false,
          error: `Task is already ${task.status} and cannot be cancelled.`,
          task,
        });
      }
      return res.json({
        ok: true,
        task: updated,
        // A running task finishes cancelling on the runner's next check.
        cancelling: updated.status === 'running',
      });
    } catch (err) {
      return sendError(res, err, 'cancel');
    }
  });

  return router;
}

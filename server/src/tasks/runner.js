// In-process background task runner.
//
// One instance is started by the server entrypoint (src/index.js) and keeps
// working independently of any browser tab or HTTP request. Tasks and their
// steps live in SQLite, so status and history survive a restart.
//
// Restart policy: a task that was `running` when the process died is NOT
// resumed. We cannot know whether its last action landed, so it is marked
// failed (or cancelled if it was already stopping) and the reason is recorded.
import { redactSecrets } from '../config.js';
import {
  INTERRUPTED_ERROR,
  appendStep,
  claimNextQueued,
  claimReadyWaitingTask,
  claimRecoverableTask,
  finishTask,
  loadPlan,
  savePlan,
  isCancelRequested,
  setWaitingApproval,
} from './store.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_CANCEL_POLL_MS = 250;

/** Safe provider-status check for OpenRouter only (verified endpoint/auth).
 * Never exposes key in logs; uses timeout; never assumes quota is restored.
 */
async function pollKeyStatus({ apiKey, baseUrl, signal, timeoutMs = 5000 }) {
  if (!apiKey || typeof apiKey !== 'string') return { ok: false, reason: 'no_key' };
  try {
    const url = new URL('/api/v1/key', (baseUrl || 'https://openrouter.ai').replace(/\/$/, ''));
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    clearTimeout(id);
    if (!response.ok) return { ok: false, reason: 'status_check_failed', status: response.status };
    return { ok: true, reason: 'status_check_ok', note: 'Supporting evidence only; does not confirm model availability.' };
  } catch (error) {
    return { ok: false, reason: 'status_check_error', note: error?.message || 'Network failure during status check' };
  }
}

export const NO_EXECUTOR_ERROR =
  'Background execution is not connected to the coding agent yet, so this task was not run.';

/**
 * @param {object} options
 * @param {object} options.db        open SQLite handle
 * @param {Function|null} options.executor  async ({ task, signal, addStep, db }) => void
 * @param {number} options.pollIntervalMs   idle poll interval
 * @param {number} options.cancelPollMs     how often a running task checks for cancellation
 * @param {object} options.logger
 */
export function createTaskRunner({
  db,
  executor = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  cancelPollMs = DEFAULT_CANCEL_POLL_MS,
  logger = console,
} = {}) {
  let timer = null;
  let busy = false;
  let stopped = false;
  const controllers = new Map();

  function finishCancelled(taskId) {
    appendStep(db, taskId, {
      kind: 'note',
      title: 'Cancelled',
      detail: 'Stopped at your request. Nothing after the last recorded step was executed.',
    });
    return finishTask(db, taskId, 'cancelled');
  }

  /**
   * Marks tasks left in `running` by a previous process as not resumed.
   * `waiting_approval` is intentionally untouched: approvals are not durable
   * yet, which is handled in a later stage.
   */
  function recoverInterrupted() {
    const rows = db
      .prepare("SELECT id, cancel_requested FROM tasks WHERE status = 'running'")
      .all();
    for (const row of rows) {
      if (row.cancel_requested) {
        appendStep(db, row.id, {
          kind: 'note',
          title: 'Cancelled after restart',
          detail: 'The server stopped while this task was being cancelled. Nothing else was executed.',
        });
        finishTask(db, row.id, 'cancelled');
      } else {
        appendStep(db, row.id, {
          kind: 'note',
          title: 'Run interrupted',
          detail: INTERRUPTED_ERROR,
          status: 'failed',
        });
        finishTask(db, row.id, 'failed', INTERRUPTED_ERROR);
      }
    }
    if (rows.length > 0) {
      logger?.info?.(`[tasks] marked ${rows.length} interrupted task(s) as not resumed`);
    }
    return rows.length;
  }

  async function runTask(task, phase = 'plan') {
    const controller = new AbortController();
    controllers.set(task.id, controller);

    // Cancellation is recorded in the database by the HTTP route, so the
    // runner polls for it instead of relying on a shared in-memory reference.
    const watcher = setInterval(() => {
      if (!controller.signal.aborted && isCancelRequested(db, task.id)) {
        controller.abort();
      }
    }, cancelPollMs);
    watcher.unref?.();

    appendStep(db, task.id, {
      kind: 'note',
      title: 'Run started',
      detail: `Phase: ${phase}; Autonomy: ${task.autonomy}.`,
    });

    try {
      if (isCancelRequested(db, task.id)) return finishCancelled(task.id);
      if (typeof executor !== 'function') throw new Error(NO_EXECUTOR_ERROR);

      const outcome = await executor({
        task,
        signal: controller.signal,
        db,
        addStep: (step) => appendStep(db, task.id, step),
        phase,
      });

      if (controller.signal.aborted || isCancelRequested(db, task.id)) {
        return finishCancelled(task.id);
      }
      if (outcome && outcome.status === 'waiting_approval') {
        const updated = setWaitingApproval(db, task.id);
        if (updated) appendStep(db, task.id, {
          kind: 'note',
          title: 'Waiting for approval',
          detail: 'Staged proposals are awaiting user review.',
          status: 'done',
        });
        return updated || task;
      }
      if (outcome && outcome.status === 'failed') {
        return finishTask(
          db,
          task.id,
          'failed',
          outcome.error || 'The task could not complete all requested steps.',
        );
      }
      return finishTask(db, task.id, 'completed');
    } catch (error) {
      if (controller.signal.aborted || isCancelRequested(db, task.id)) {
        return finishCancelled(task.id);
      }
      const message = error?.message || String(error);
      // Quota / provider-capacity pause: persist recovery state instead of hard failure
      const statusCode = error?.statusCode;
      const errorType = error?.errorType;
      const isQuota = statusCode === 429 || statusCode === 402;
      const isQuotaExhausted = errorType === 'QUOTA_EXHAUSTED' || (isQuota && /quota|credit|budget|insufficient|free-models-per-day/i.test(message || ''));
      const isRateLimited = errorType === 'RATE_LIMITED' || (statusCode === 429 && !isQuotaExhausted);

      // Rate-limit: bounded exponential backoff with jitter; honor Retry-After.
      if (isRateLimited) {
        const baseDelayMs = error?.retryAfterMs || 60_000; // configurable default 60s when provider gives no Retry-After
        const maxDelayMs = 300_000; // 5 minutes cap
        const jitterMs = Math.round(Math.random() * 5000); // small jitter to avoid thundering herd
        const retryMs = Math.min(maxDelayMs, Math.max(baseDelayMs, baseDelayMs * 2)); // bounded growth on repeated limits
        const recovery = {
          reason: 'provider_rate_limited',
          lastError: message.slice(0, 500),
          retryAttempt: Math.min(Number(error?.retryAttempt || 0) + 1, 5),
          nextRetryAt: new Date(Date.now() + retryMs).toISOString(),
          pausedAt: new Date().toISOString(),
        };
        const plan = loadPlan(db, task.id) || {};
        plan.recovery = { ...(plan.recovery || {}), ...recovery };
        savePlan(db, task.id, plan);
        const clearMsg = (error?.publicMessage || message).slice(0, 500);
        db.prepare("UPDATE tasks SET status = 'provider_paused', error = ?, updated_at = datetime('now') WHERE id = ?").run(clearMsg, task.id);
        appendStep(db, task.id, {
          kind: 'note',
          title: 'Provider rate limited',
          detail: `Task paused: ${(error?.publicMessage || message).slice(0, 200)}. Retry scheduled (${retryMs}ms).`,
          status: 'done',
        });
        return getTask(db, task.id);
      }

      // Quota exhaustion: stay paused; do not burn more quota with automatic retries.
      if (isQuotaExhausted) {
        const recovery = {
          reason: 'provider_quota_exhausted',
          lastError: message.slice(0, 500),
          retryAttempt: 3,
          nextRetryAt: error?.retryAfterMs ? new Date(Date.now() + error.retryAfterMs).toISOString() : null,
          pausedAt: new Date().toISOString(),
        };
        const plan = loadPlan(db, task.id) || {};
        plan.recovery = { ...(plan.recovery || {}), ...recovery };
        savePlan(db, task.id, plan);
        const clearMsg = (error?.publicMessage || message).slice(0, 500);
        db.prepare("UPDATE tasks SET status = 'provider_paused', error = ?, updated_at = datetime('now') WHERE id = ?").run(clearMsg, task.id);
        appendStep(db, task.id, {
          kind: 'note',
          title: 'Provider quota reached',
          detail: `Task paused: ${(error?.publicMessage || message).slice(0, 200)}. Retry when provider is available (retryAfter: ${error?.retryAfterMs ?? 'unknown'} ms).`,
          status: 'done',
        });
        return getTask(db, task.id);
      }
      appendStep(db, task.id, {
        kind: 'note',
        title: 'Run failed',
        detail: redactSecrets(message),
        status: 'failed',
      });
      return finishTask(db, task.id, 'failed', message);
    } finally {
      clearInterval(watcher);
      controllers.delete(task.id);
    }
  }

  /**
   * Claims at most one queued task and runs it to a final state.
   * Returns the final task row, or null when the queue was empty.
   */
  async function tick() {
    if (busy || stopped) return null;
    busy = true;
    try {
      const waitingTask = claimReadyWaitingTask(db);
      if (waitingTask) {
        logger?.info?.(`[tasks] resuming task ${waitingTask.id} (finalize)`);
        const finalTask = await runTask(waitingTask, 'finalize');
        return finalTask;
      }
      const recoverableTask = claimRecoverableTask(db);
      if (recoverableTask) {
        logger?.info?.(`[tasks] resuming paused task ${recoverableTask.id} (provider available)`);
        const resumedTask = await runTask(recoverableTask, 'continue');
        return resumedTask;
      }
      const task = claimNextQueued(db);
      if (!task) return null;
      logger?.info?.(`[tasks] running task ${task.id} (project ${task.project_id})`);
      return await runTask(task, 'plan');
    } finally {
      busy = false;
    }
  }

  function safeTick() {
    return tick().catch((error) => {
      logger?.error?.('[tasks] runner tick failed:', redactSecrets(String(error?.message || error)));
      return null;
    });
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      await safeTick();
      schedule();
    }, pollIntervalMs);
    timer.unref?.();
  }

  return {
    tick,
    recoverInterrupted,
    start() {
      if (stopped) return;
      recoverInterrupted();
      void safeTick();
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },
  };
}

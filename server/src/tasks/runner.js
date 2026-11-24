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
import { RETRY_POLICY, cappedRetryAfterMs } from '../ai/retry-policy.js';
import {
  INTERRUPTED_ERROR,
  appendStep,
  claimNextQueued,
  claimReadyWaitingTask,
  claimRecoverableTask,
  failExhaustedRecoverableTasks,
  finishTask,
  loadPlan,
  savePlan,
  isCancelRequested,
  rejectTaskProposals,
  setProviderPaused,
  setWaitingApproval,
  getTask,
} from './store.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_CANCEL_POLL_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 300_000;

function recoveryDelayMs(error) {
  // Provider-supplied resets are authoritative but bounded separately from
  // interactive waits so a malicious header cannot pause a task for a year.
  const resetMs = cappedRetryAfterMs(error?.retryAfterMs, RETRY_POLICY.taskRetryAfterCapMs);
  if (resetMs !== null) return Math.max(DEFAULT_RETRY_DELAY_MS, resetMs);
  const retryAttempt = Math.min(
    Math.max(Number(error?.retryAttempt) || 1, 1),
    RETRY_POLICY.maxRecoveryAttempts,
  );
  const exponential = DEFAULT_RETRY_DELAY_MS * (2 ** (retryAttempt - 1));
  return Math.min(MAX_RETRY_DELAY_MS, exponential);
}

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
    const current = getTask(db, taskId);
    if (current?.status === 'cancelled') return current;
    // Cancellation may land after an executor staged a proposal but before the
    // waiting_approval transition. Reject it here so nothing remains reviewable.
    rejectTaskProposals(db, taskId);
    appendStep(db, taskId, {
      kind: 'note',
      title: 'Cancelled',
      detail: 'Stopped at your request. Nothing after the last recorded step was executed.',
    });
    return finishTask(db, taskId, 'cancelled');
  }

  /** Terminal writes must not overwrite a cancellation that landed mid-race. */
  function finishTerminal(taskId, status, error = null) {
    const finished = finishTask(db, taskId, status, error, { requireNoCancel: true });
    return finished || finishCancelled(taskId);
  }

  function finishProviderFailure(taskId, title, detail) {
    appendStep(db, taskId, {
      kind: 'note',
      title,
      detail: redactSecrets(detail).slice(0, 500),
      status: 'failed',
    });
    return finishTerminal(taskId, 'failed', detail);
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
        if (updated) {
          appendStep(db, task.id, {
            kind: 'note',
            title: 'Waiting for approval',
            detail: 'Staged proposals are awaiting user review.',
            status: 'done',
          });
          return updated;
        }
        // A cancellation landed between the executor result and this write.
        return finishCancelled(task.id);
      }
      if (outcome && outcome.status === 'failed') {
        return finishTerminal(
          task.id,
          'failed',
          outcome.error || 'The task could not complete all requested steps.',
        );
      }
      return finishTerminal(task.id, 'completed');
    } catch (error) {
      if (controller.signal.aborted || isCancelRequested(db, task.id)) {
        return finishCancelled(task.id);
      }
      const message = error?.message || String(error);
      const statusCode = Number(error?.statusCode);
      const category = String(error?.category || error?.errorType || '');
      const isInvalidKey = category === 'INVALID_API_KEY' || [401, 403].includes(statusCode);
      const isInvalidRequest = category === 'REQUEST_ERROR' || [400, 404, 422].includes(statusCode);
      const isQuotaExhausted = category === 'QUOTA_EXHAUSTED'
        || statusCode === 402
        || (statusCode === 429 && /quota|credit|budget|insufficient|free-models-per-day/i.test(message || ''));
      const isRateLimited = category === 'RATE_LIMITED' || (statusCode === 429 && !isQuotaExhausted);
      const isTransientProviderFailure = category === 'CAPACITY_UNAVAILABLE'
        || category === 'PROVIDER_ERROR'
        || category === 'NETWORK_TIMEOUT'
        || category === 'NETWORK_ERROR'
        || [502, 503, 504].includes(statusCode);

      if (isInvalidKey || isInvalidRequest) {
        const clearMsg = (error?.publicMessage || message).slice(0, 500);
        appendStep(db, task.id, {
          kind: 'note',
          title: 'Run failed',
          detail: redactSecrets(clearMsg),
          status: 'failed',
        });
        return finishTerminal(task.id, 'failed', clearMsg);
      }

      const clearMsg = redactSecrets((error?.publicMessage || message).slice(0, 500));

      if (isRateLimited || isTransientProviderFailure) {
        const plan = loadPlan(db, task.id) || {};
        const sharedState = error?.retryState || plan.recovery?.retryState || null;
        const usedFromState = Number(sharedState?.attemptsUsed);
        const previousAttempt = Math.min(
          Number(plan.recovery?.retryAttempt || 0),
          RETRY_POLICY.maxRecoveryAttempts,
        );
        // A cooldown short-circuit consumes no HTTP attempt, so the shared
        // attempt count alone cannot bound pause/resume cycles. Use the greater
        // of the HTTP budget used and the prior recovery cycle + 1.
        const retryAttempt = Math.min(
          RETRY_POLICY.maxRecoveryAttempts,
          Number.isFinite(usedFromState)
            ? Math.max(usedFromState, previousAttempt + 1)
            : previousAttempt + 1,
        );

        if (error?.retryable === false || retryAttempt >= RETRY_POLICY.maxRecoveryAttempts) {
          const detail = `${clearMsg} Automatic provider recovery reached its limit; the task was not completed.`;
          plan.recovery = {
            ...(plan.recovery || {}),
            reason: 'provider_recovery_exhausted',
            category: category || 'PROVIDER_ERROR',
            lastError: redactSecrets(message).slice(0, 500),
            retryAttempt: RETRY_POLICY.maxRecoveryAttempts,
            retryState: sharedState || { attemptsUsed: RETRY_POLICY.maxProviderAttempts, exhausted: true },
            terminal: true,
            pausedAt: new Date().toISOString(),
          };
          savePlan(db, task.id, plan);
          return finishProviderFailure(
            task.id,
            'Provider recovery exhausted',
            detail,
          );
        }

        const jitterMs = Math.round(Math.random() * 5000);
        const retryMs = recoveryDelayMs({ ...error, retryAttempt }) + jitterMs;
        const recovery = {
          reason: 'provider_rate_limited',
          category: category || (isRateLimited ? 'RATE_LIMITED' : 'PROVIDER_ERROR'),
          lastError: redactSecrets(message).slice(0, 500),
          retryAttempt,
          retryState: sharedState || { attemptsUsed: retryAttempt, exhausted: false },
          nextRetryAt: new Date(Date.now() + retryMs).toISOString(),
          pausedAt: new Date().toISOString(),
        };
        plan.recovery = { ...(plan.recovery || {}), ...recovery };
        const paused = setProviderPaused(db, task.id, {
          error: clearMsg,
          recovery: plan.recovery,
        });
        if (!paused) return finishCancelled(task.id);
        appendStep(db, task.id, {
          kind: 'note',
          title: isRateLimited ? 'Provider rate limited' : 'Provider temporarily unavailable',
          detail: `Task paused: ${clearMsg.slice(0, 200)}. Automatic retry #${retryAttempt} scheduled in ${retryMs}ms.`,
          status: 'done',
        });
        return paused;
      }

      // Quota exhaustion is terminal: retrying only burns more quota. The task
      // fails with a safe explanation instead of remaining in a paused limbo.
      if (isQuotaExhausted) {
        const retryAfterMs = cappedRetryAfterMs(error?.retryAfterMs, RETRY_POLICY.taskRetryAfterCapMs);
        const plan = loadPlan(db, task.id) || {};
        plan.recovery = {
          ...(plan.recovery || {}),
          reason: 'provider_quota_exhausted',
          category: 'QUOTA_EXHAUSTED',
          lastError: redactSecrets(message).slice(0, 500),
          retryAttempt: RETRY_POLICY.maxRecoveryAttempts,
          retryState: error?.retryState || plan.recovery?.retryState
            || { attemptsUsed: RETRY_POLICY.maxProviderAttempts, exhausted: true },
          terminal: true,
          pausedAt: new Date().toISOString(),
          ...(retryAfterMs === null ? {} : { providerRetryAfterMs: retryAfterMs }),
        };
        savePlan(db, task.id, plan);
        const detail = `${clearMsg} Provider quota is exhausted; automatic retries were stopped to avoid further rejected requests.`;
        return finishProviderFailure(task.id, 'Provider quota reached', detail);
      }
      appendStep(db, task.id, {
        kind: 'note',
        title: 'Run failed',
        detail: clearMsg,
        status: 'failed',
      });
      return finishTerminal(task.id, 'failed', clearMsg);
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
      failExhaustedRecoverableTasks(db);
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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  diffLines,
  isProposalActionable,
  normalizeDecisionError,
  pendingCountForTask,
  proposalDecisionLabel,
  proposalStatusLabel,
  proposalTypeLabel,
} from './taskProposalHelpers.js';

function statusBadgeClass(status) {
  const map = {
    queued: 'status-queued',
    running: 'status-running',
    waiting_approval: 'status-waiting',
    provider_paused: 'status-paused',
    completed: 'status-completed',
    failed: 'status-failed',
    cancelled: 'status-cancelled',
  };
  return map[status] || 'status-unknown';
}

function stepStatusClass(status) {
  const map = {
    queued: 'step-queued',
    running: 'step-running',
    completed: 'step-completed',
    failed: 'step-failed',
  };
  return map[status] || 'step-unknown';
}

function statusLabel(status, autonomous = false) {
  const map = {
    queued: autonomous ? 'Queued (autonomous)' : 'Queued',
    running: autonomous ? 'Running (autonomous)' : 'Running',
    waiting_approval: autonomous ? 'Waiting (autonomous)' : 'Waiting for approval',
    provider_paused: autonomous ? 'Paused (quota/retry, autonomous)' : 'Paused (quota/retry)',
    completed: autonomous ? 'Completed (autonomous)' : 'Completed',
    failed: autonomous ? 'Failed (autonomous)' : 'Failed',
    cancelled: autonomous ? 'Cancelled (autonomous)' : 'Cancelled',
  };
  return map[status] || status;
}

function formatTimestamp(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

function proposalStatusClass(proposal) {
  if (proposal?.status === 'pending' && proposal.expired) return 'proposal-expired';
  const map = {
    pending: 'proposal-pending',
    applying: 'proposal-processing',
    applied: 'proposal-applied',
    rejected: 'proposal-rejected',
    failed: 'proposal-failed',
    interrupted: 'proposal-failed',
  };
  return map[proposal?.status] || 'proposal-unknown';
}

function ProposalCard({ proposal, busyProposalId, onDecision }) {
  const diff = diffLines(proposal.diff);
  const busy = String(busyProposalId) === String(proposal.proposalId);
  const canDecide = proposal.status === 'pending' && !proposal.expired;
  const enabled = isProposalActionable(proposal, busyProposalId);
  const resultText = proposal.result
    ? [
      Number.isFinite(proposal.result.exitCode) ? `Exit code: ${proposal.result.exitCode}` : null,
      proposal.result.stdout,
      proposal.result.stderr,
    ].filter(Boolean).join('\n').slice(0, 4000)
    : null;

  let note = 'Decision recorded. No further action is available here.';
  if (proposal.status === 'pending' && proposal.expired) {
    note = 'The approval window expired. Nothing was applied or run.';
  } else if (proposal.status === 'pending' && proposal.type === 'file') {
    note = 'Nothing has been written. Review the diff, then explicitly approve or reject.';
  } else if (proposal.status === 'pending' && proposal.type === 'command' && proposal.command === 'python_run') {
    note = 'Nothing has been run. Approval is required before this exact Python file can execute.';
  } else if (proposal.status === 'pending' && proposal.type === 'command') {
    note = 'Nothing has been run. Approval is required before this command can execute.';
  } else if (proposal.status === 'rejected') {
    note = 'Rejected. Nothing was applied or run.';
  }

  return (
    <article className={`task-proposal ${proposalStatusClass(proposal)}`}>
      <div className="task-proposal-head">
        <div className="task-proposal-identity">
          <strong>{proposalTypeLabel(proposal)}</strong>
          <span className="task-proposal-target">
            {proposal.type === 'command' ? <code>{proposal.command}</code> : <code>{proposal.path}</code>}
          </span>
        </div>
        <span className={`task-proposal-status ${proposalStatusClass(proposal)}`}>
          {proposalStatusLabel(proposal)}
        </span>
      </div>

      {proposal.type === 'file' && (
        <div className="task-proposal-diff" aria-label={`Proposed changes to ${proposal.path || 'file'}`}>
          {diff.lines.length === 0 ? (
            <pre>No diff was provided for this proposal.</pre>
          ) : (
            <pre>
              {diff.lines.map((line, index) => (
                <span className={`diff-${line.type}`} key={index}>{`${line.text}\n`}</span>
              ))}
              {diff.truncated ? '\n… diff preview limited to 400 lines' : ''}
            </pre>
          )}
        </div>
      )}

      {proposal.type === 'command' && (
        <div className="task-proposal-command">
          <code>{proposal.command}</code>
          {proposal.path && <span>Path: <code>{proposal.path}</code></span>}
          {proposal.contentSha256 && (
            <span>File digest: <code>{String(proposal.contentSha256).slice(0, 19)}…</code></span>
          )}
        </div>
      )}

      <p className="task-proposal-note">{note}</p>

      {resultText && (
        <pre className="task-proposal-result">{resultText}</pre>
      )}

      {proposal.error && (
        <div className="task-error" role="alert">{proposal.error}</div>
      )}

      {canDecide && (
        <div className="task-proposal-actions">
          <button
            type="button"
            className="task-proposal-approve"
            disabled={!enabled}
            onClick={() => onDecision('approve')}
          >
            {busy ? 'Working…' : proposalDecisionLabel(proposal, 'approve')}
          </button>
          <button
            type="button"
            className="task-proposal-reject"
            disabled={!enabled}
            onClick={() => onDecision('reject')}
          >
            {busy ? 'Working…' : 'Reject'}
          </button>
        </div>
      )}
    </article>
  );
}

/**
 * Task panel for the workspace dock.
 *
 * Shows the task list for the active project and swaps to a single task's
 * detail (steps + approval-gated proposals) so the narrow dock stays readable.
 * Nothing is applied or executed here without an explicit approval click.
 */
export default function TaskCenter({
  projectId,
  activeProjectName = '',
  taskInput,
  setTaskInput,
  taskSubmitting,
  createTask,
  tasks,
  projectProposals,
  taskStatusFilter,
  setTaskStatusFilter,
  tasksError,
  taskLoading,
  loadTasks,
  loadTaskDetail,
  setTaskDetail,
  taskDetail,
  taskDetailError,
  cancelTask,
  refreshTasks,
  applyTaskProposal,
  rejectTaskProposal,
  runTaskProposal,
  focusTaskId = null,
  onFocusTask,
  onNewProject,
  hasProjects = false,
}) {
  const timerRef = useRef(null);
  const proposalActionRef = useRef(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [polling, setPolling] = useState(false);
  const [busyProposalId, setBusyProposalId] = useState(null);
  const [proposalError, setProposalError] = useState(null);

  const activeTask = tasks.find((t) => String(t.id) === String(selectedTaskId));
  const detail = taskDetail || {};
  const detailProposals = Array.isArray(detail.proposals) ? detail.proposals : [];
  const pendingIds = useMemo(
    () => new Set((projectProposals || []).map((proposal) => String(proposal.proposalId)).filter(Boolean)),
    [projectProposals],
  );
  const waitingCount = tasks.filter((task) => task.status === 'waiting_approval').length;
  const totalPending = tasks.reduce(
    (sum, task) => sum + pendingCountForTask(task, pendingIds),
    0,
  );

  const isTerminal = (status) =>
    status === 'completed' || status === 'failed' || status === 'cancelled';
  const isActive = (status) =>
    status === 'queued' || status === 'running' || status === 'waiting_approval' || status === 'provider_paused';

  // Opening a task from elsewhere in the app (welcome screen, task badge).
  useEffect(() => {
    if (!focusTaskId) return;
    setSelectedTaskId(focusTaskId);
    setProposalError(null);
    loadTaskDetail(focusTaskId);
    onFocusTask?.();
  }, [focusTaskId, loadTaskDetail, onFocusTask]);

  // A task selection belongs to one project; clear it when the project changes.
  useEffect(() => {
    setSelectedTaskId(null);
    setProposalError(null);
  }, [projectId]);

  useEffect(() => {
    if (selectedTaskId && isActive(activeTask?.status) && !busyProposalId) {
      setPolling(true);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        loadTaskDetail(selectedTaskId).then(() => loadTasks());
      }, 2000);
    } else {
      setPolling(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [selectedTaskId, activeTask?.status, busyProposalId, loadTaskDetail, loadTasks]);

  const handleCreateTask = async () => {
    if (!projectId) return;
    setProposalError(null);
    try {
      await createTask();
    } catch {
      // Errors surface through tasksError and the app toast.
    }
  };

  const handleSelectTask = (taskId) => {
    setSelectedTaskId(taskId);
    setProposalError(null);
    loadTaskDetail(taskId);
  };

  const handleBackToList = () => {
    setSelectedTaskId(null);
    setTaskDetail(null);
    setProposalError(null);
  };

  const handleToggleWaiting = () => {
    const nextFilter = taskStatusFilter === 'waiting_approval' ? null : 'waiting_approval';
    setTaskStatusFilter(nextFilter);
    setSelectedTaskId(null);
    setTaskDetail(null);
    setProposalError(null);
    loadTasks(nextFilter);
  };

  const handleProposalDecision = async (proposal, decision) => {
    if (!activeTask || proposalActionRef.current) return;
    const key = String(proposal.proposalId);
    if (!isProposalActionable(proposal)) {
      setProposalError(normalizeDecisionError({ message: 'This proposal is no longer actionable.' }));
      await loadTaskDetail(activeTask.id);
      await loadTasks(taskStatusFilter);
      return;
    }

    proposalActionRef.current = key;
    setBusyProposalId(key);
    setProposalError(null);
    try {
      if (decision === 'reject') {
        await rejectTaskProposal(activeTask, proposal);
      } else if (proposal.type === 'command') {
        await runTaskProposal(activeTask, proposal);
      } else {
        await applyTaskProposal(activeTask, proposal);
      }
    } catch (error) {
      const normalized = normalizeDecisionError(error, error.status);
      setProposalError(normalized);
      try {
        await loadTaskDetail(activeTask.id);
        await loadTasks(taskStatusFilter);
      } catch {
        // Keep the normalized error visible if the refresh itself fails.
      }
    } finally {
      proposalActionRef.current = null;
      setBusyProposalId(null);
    }
  };

  if (!projectId) {
    return (
      <div className="panel-empty">
        <div className="panel-empty-icon">✓</div>
        <h3>{hasProjects ? 'No project selected' : 'No projects yet'}</h3>
        <p>
          {hasProjects
            ? 'Tasks run against the active project. Add or select a project first.'
            : 'Create or import a workspace before starting background tasks.'}
        </p>
        <button type="button" className="primary-button" onClick={onNewProject}>Add a project</button>
      </div>
    );
  }

  if (selectedTaskId) {
    const task = taskDetail?.task || activeTask || null;
    const running = task && isActive(task.status) && !isTerminal(task.status);
    return (
      <section className="task-panel" aria-label="Task detail">
        <header className="panel-head">
          <button type="button" className="ghost-button" onClick={handleBackToList}>← All tasks</button>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              if (selectedTaskId) loadTaskDetail(selectedTaskId);
              loadTasks();
            }}
            title="Refresh task"
            aria-label="Refresh task"
            disabled={taskLoading}
          >
            ↻
          </button>
        </header>

        <div className="task-detail-scroll">
          <div className="task-detail-title">
            <h3>{task?.instruction || `Task #${selectedTaskId}`}</h3>
            <div className="task-detail-badges">
              <span className={`task-status ${statusBadgeClass(task?.status)}`}>
                {statusLabel(task?.status, task?.autonomous === 1 || task?.autonomous === true)}
              </span>
              {polling && <span className="task-polling">live</span>}
            </div>
          </div>

          <div className="task-detail-section">
            <div className="task-detail-row">
              <strong>Created</strong>
              <span>{formatTimestamp(task?.created_at)}</span>
            </div>
            <div className="task-detail-row">
              <strong>Updated</strong>
              <span>{formatTimestamp(task?.updated_at)}</span>
            </div>
            <div className="task-detail-row">
              <strong>Steps</strong>
              <span>{task?.step_count ?? taskDetail?.steps?.length ?? 0}</span>
            </div>
            {task?.error && (
              <div className="task-detail-row">
                <strong>Error</strong>
                <span className="task-error">{task.error}</span>
              </div>
            )}
          </div>

          <div className="task-detail-section">
            <div className="section-heading">
              <strong>Proposals</strong>
              <span>{detailProposals.length ? `${detailProposals.length} linked` : 'None'}</span>
            </div>
            {detailProposals.length === 0 ? (
              <div className="task-empty">This task has not staged any proposals.</div>
            ) : (
              <div className="task-proposal-list">
                {detailProposals.map((proposal) => (
                  <ProposalCard
                    key={proposal.proposalId}
                    proposal={proposal}
                    busyProposalId={busyProposalId}
                    onDecision={(decision) => handleProposalDecision(proposal, decision)}
                  />
                ))}
              </div>
            )}
            {proposalError && (
              <div className="task-error" role="alert">{proposalError.message}</div>
            )}
          </div>

          <div className="task-detail-section">
            <div className="section-heading">
              <strong>Step history</strong>
            </div>
            <div className="task-steps-list">
              {!taskDetail?.steps?.length ? (
                <div className="task-empty">No step history yet.</div>
              ) : (
                taskDetail.steps.map((step) => (
                  <div key={step.id} className="task-step">
                    <div className="task-step-header">
                      <span className="task-step-seq">#{step.seq}</span>
                      <span className="task-step-title">{step.title}</span>
                      <span className={`task-step-status ${stepStatusClass(step.status)}`}>
                        {step.status}
                      </span>
                    </div>
                    {step.detail && <div className="task-step-detail">{step.detail}</div>}
                  </div>
                ))
              )}
            </div>
          </div>

          {taskDetailError && <div className="task-error" role="alert">{taskDetailError}</div>}
        </div>

        {running && (
          <footer className="task-detail-footer">
            <button
              type="button"
              className="ghost-button danger"
              onClick={() => cancelTask(task.id)}
              aria-label="Cancel task"
            >
              Cancel task
            </button>
          </footer>
        )}
      </section>
    );
  }

  return (
    <section className="task-panel" aria-label="Tasks">
      <header className="panel-head">
        <div>
          <span className="panel-eyebrow">Background work</span>
          <strong title={activeProjectName}>{activeProjectName || 'Tasks'}</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={refreshTasks}
          aria-label="Refresh tasks"
          title="Refresh tasks"
          disabled={taskLoading}
        >
          {taskLoading ? '…' : '↻'}
        </button>
      </header>

      <div className="task-panel-scroll">
        <form
          className="task-create-form"
          onSubmit={(event) => { event.preventDefault(); handleCreateTask(); }}
        >
          <textarea
            className="task-input"
            value={taskInput}
            onChange={(event) => setTaskInput(event.target.value)}
            placeholder="Describe a coding task, e.g. add tests for the parser…"
            rows={3}
            disabled={taskSubmitting}
            aria-label="Task instruction"
          />
          <div className="task-create-actions">
            <span className="task-hint">{taskInput.length.toLocaleString()} / 20,000</span>
            <button
              type="submit"
              className="primary-button"
              disabled={!taskInput.trim() || taskSubmitting}
            >
              {taskSubmitting ? 'Starting…' : 'Start task'}
            </button>
          </div>
          {tasksError && <div className="task-error" role="alert">{tasksError}</div>}
          {tasks.some((t) => t.status === 'provider_paused') && (
            <div className="provider-status-warning" role="alert">
              <span className="provider-status-icon">⏸</span>
              <div>
                <strong>Provider paused</strong>
                <span>A previous task hit a quota or rate limit. Check the task error for details. New submissions are allowed but may also pause.</span>
              </div>
            </div>
          )}
        </form>

        <div className="task-approval-summary" role="status">
          <span><strong>{waitingCount}</strong> waiting</span>
          <span><strong>{totalPending}</strong> pending</span>
          <button
            type="button"
            className="text-icon-button"
            onClick={handleToggleWaiting}
            aria-pressed={taskStatusFilter === 'waiting_approval'}
          >
            {taskStatusFilter === 'waiting_approval' ? 'Show all' : 'Waiting only'}
          </button>
        </div>

        <div className="task-list">
          {taskLoading && tasks.length === 0 ? (
            <div className="task-empty">Refreshing tasks…</div>
          ) : tasks.length === 0 ? (
            <div className="task-empty">
              {taskStatusFilter === 'waiting_approval'
                ? 'No tasks are waiting for approval.'
                : 'No tasks yet in this project.'}
            </div>
          ) : (
            tasks.map((task) => {
              const pending = pendingCountForTask(task, pendingIds);
              const needsApproval = task.status === 'waiting_approval' || pending > 0;
              return (
                <button
                  type="button"
                  key={task.id}
                  className={`task-card ${needsApproval ? 'needs-approval' : ''}`}
                  onClick={() => handleSelectTask(task.id)}
                  aria-label={task.instruction}
                >
                  <div className="task-card-header">
                    <span className="task-title">{task.instruction}</span>
                    <span className={`task-status ${statusBadgeClass(task.status)}`}>
                      {statusLabel(task.status, task.autonomous === 1 || task.autonomous === true)}
                    </span>
                  </div>
                  <span className="task-meta">
                    {formatTimestamp(task.created_at)}
                    {task.last_step ? ` · ${task.last_step}` : ''}
                  </span>
                  {needsApproval && (
                    <span className="task-approval-note">
                      Approval required {pending > 0 ? `· ${pending} pending` : '— open to review'}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

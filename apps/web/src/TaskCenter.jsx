import React, { useCallback, useEffect, useRef, useState } from 'react';

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

function statusColor(status) {
  const map = {
    queued: '#b9a7ff',
    running: '#b9a7ff',
    waiting_approval: '#f5d79f',
    provider_paused: '#f5d79f',
    completed: '#82d7a8',
    failed: '#e5484d',
    cancelled: '#94a3b8',
  };
  return map[status] || '#94a3b8';
}

export default function TaskCenter({
  projectId,
  taskInput,
  setTaskInput,
  taskSubmitting,
  createTask,
  tasks,
  setTasks,
  tasksError,
  taskLoading,
  loadTasks,
  loadTaskDetail,
  setTaskDetail,
  taskDetail,
  taskDetailError,
  cancelTask,
  refreshTasks,
}) {
  const timerRef = useRef(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [polling, setPolling] = useState(false);

  const activeTask = tasks.find((t) => String(t.id) === String(selectedTaskId));
  const detail = taskDetail || {};

  const isTerminal = (status) =>
    status === 'completed' || status === 'failed' || status === 'cancelled';
  const isActive = (status) =>
    status === 'queued' || status === 'running' || status === 'waiting_approval' || status === 'provider_paused';

  useEffect(() => {
    if (selectedTaskId && isActive(activeTask?.status)) {
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
  }, [selectedTaskId, activeTask?.status, loadTaskDetail, loadTasks]);

  const handleCreateTask = async () => {
    if (!projectId) return;
    try {
      await createTask();
      setTaskInput('');
      setSelectedTaskId(null);
      setTaskDetail(null);
    } catch (err) {
      // Preserve UI; error shown via tasksError/app toast
    }
  };

  const handleSelectTask = (taskId) => {
    setSelectedTaskId(taskId);
    loadTaskDetail(taskId);
  };

  return (
    <section className="task-center" aria-label="Task Center">
      <div className="file-panel-heading">
        <div>
          <strong>Task Center</strong>
          <span>Create, track, and manage coding tasks</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="icon-button text-icon-button"
            onClick={refreshTasks}
            aria-label="Refresh tasks"
            title="Refresh"
            disabled={taskLoading}
            style={{ opacity: taskLoading ? 0.5 : 1, transition: 'opacity 0.2s' }}
          >
            {taskLoading ? '⏳' : '↻'}
          </button>
        </div>
      </div>

      <div className="task-center-card">
        <div className="workspace-file-list">
          {!projectId && (
            <div style={{ padding: '8px 10px', color: '#94a3b8', fontSize: 10 }}>
              Select workspace from sidebar to create tasks
            </div>
          )}
          <form
            className="task-create-form"
            onSubmit={(e) => { e.preventDefault(); handleCreateTask(); }}
            disabled={!projectId}
          >
            <textarea
              className="task-input"
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              placeholder="Describe a coding task (e.g. add a utility function)..."
              rows={3}
              disabled={!projectId || taskSubmitting}
              aria-label="Task instruction"
            />
            <div className="task-create-actions">
              <span className="task-hint">{taskInput.length} / 20000</span>
              {taskSubmitting ? (
                <button type="button" className="send-button stop-button" disabled>
                  ↻
                </button>
              ) : (
                <button type="submit" className="send-button" disabled={!projectId || !taskInput.trim()} aria-label="Create task">
                  →
                </button>
              )}
            </div>
            {tasksError && (
              <div className="task-error" role="alert">{tasksError}</div>
            )}
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
        </div>
      </div>

      <div className="task-center-card">
        <div className="file-panel-heading">
          <div>
            <strong>Tasks</strong>
            <span>
              {tasks.length} total{taskLoading && ' · refreshing…'}
            </span>
          </div>
        </div>
        <div className="task-list">
          {taskLoading && tasks.length === 0 ? (
            <div className="task-empty">
              <span>Refreshing tasks…</span>
            </div>
          ) : tasks.length === 0 ? (
            <div className="task-empty">
              <span>No tasks yet in this workspace.</span>
            </div>
          ) : (
            tasks.map((task) => {
              const isSelected = String(task.id) === String(selectedTaskId);
              return (
                <div
                  key={task.id}
                  className={`task-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleSelectTask(task.id)}
                  aria-label={task.instruction}
                >
                  <div className="task-card-header">
                    <div className="task-title">{task.instruction}</div>
                    <span
                      className={`task-status ${statusBadgeClass(task.status)}`}
                      style={{ color: statusColor(task.status) }}
                    >
                      {statusLabel(task.status, task.autonomous === 1 || task.autonomous === true)}
                    </span>
                  </div>
                  <div className="task-card-body">
                    <span className="task-meta">
                      Created {task.created_at ? new Date(task.created_at).toLocaleString() : '—'}
                      {task.last_step ? ` · Last step: ${task.last_step}` : ''}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {taskDetail && (
        <div className="task-center-card">
          <div className="file-panel-heading">
            <div>
              <strong>Task detail</strong>
              <span>Task #{taskDetail.task?.id}</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {activeTask &&
                isActive(activeTask.status) && (
                  <button
                    className="text-icon-button"
                    onClick={() => cancelTask(taskDetail.task.id)}
                    disabled={false}
                    aria-label="Cancel task"
                    title="Cancel task"
                  >
                    Cancel
                  </button>
                )}
            </div>
          </div>
          <div className="task-detail">
            <div className="task-detail-section">
              <div className="task-detail-row">
                <strong>Status</strong>
                <span style={{ color: statusColor(taskDetail.task?.status) }}>
                  {statusLabel(taskDetail.task?.status)}
                </span>
              </div>
              <div className="task-detail-row">
                <strong>Steps</strong>
                <span>{taskDetail.task?.step_count ?? taskDetail.steps?.length ?? 0}</span>
              </div>
              <div className="task-detail-row">
                <strong>Plan</strong>
                <span className="task-plan-summary">
                  {taskDetail.task?.plan_json ? 'Saved (see steps below)' : '—'}
                </span>
              </div>
              <div className="task-detail-row">
                <strong>Error</strong>
                <span className={taskDetail.task?.error ? 'task-error' : 'task-muted'}>
                  {taskDetail.task?.error || '—'}
                </span>
              </div>
            </div>

            <div className="task-detail-section">
              <strong>Step history</strong>
              <div className="task-steps-list">
                {taskDetail.steps.length === 0 ? (
                  <div className="task-empty">No step history yet.</div>
                ) : (
                  taskDetail.steps.map((step) => (
                    <div key={step.id} className="task-step">
                      <div className="task-step-header">
                        <span className="task-step-seq">#{step.seq}</span>
                        <span className="task-step-title">{step.title}</span>
                        <span
                          className={`task-step-status ${stepStatusClass(step.status)}`}
                          style={{ color: statusColor(step.status) }}
                        >
                          {step.status}
                        </span>
                      </div>
                      {step.detail && <div className="task-step-detail">{step.detail}</div>}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          {taskDetailError && <div className="task-error" role="alert">{taskDetailError}</div>}
        </div>
      )}
    </section>
  );
}

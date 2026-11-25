import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import hljs from './highlight';
import TaskCenter from './TaskCenter';
import AuthScreen from './AuthScreen';
import ProjectDialog from './ProjectDialog';
import WorkspaceFiles from './WorkspaceFiles';
import {
  bumpAuthEpoch,
  chooseAuthTokenForInitialization,
  createAuthCallbackRunner,
  googleErrorMessage,
  parseAuthFragment,
  readAuthEpoch,
  renewExistingSession,
  shouldApplyRenewalResult,
  shouldClearWorkspaceForAuthChange,
  shouldSignOutFor401,
} from './authFlow.js';
import {
  TASK_LIST_LIMIT,
  activeProjectIdForPersistence,
  buildPromptWithAttachment,
  captureWorkspaceResponseScope,
  chatRequestContext,
  isCurrentProjectCreationScope,
  isCurrentRequestLifecycle,
  isCurrentWorkspaceResponseScope,
  isCurrentWorkspaceSessionScope,
  matchingProjectId,
  projectUnderstandingPaths,
  quickActionsFor,
  responseScopeKey,
  selectRestoredProjectId,
  shouldStartWorkspaceScan,
  upsertProject,
  verifiedWorkspaceProject,
  workspaceLoadingMessage,
  workspaceScanStatus,
  workspaceUnderstandingSummary,
  workspaceSelectionState,
  workspaceStatusMessage,
} from './workspaceUiHelpers.js';

const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE_URL) ? import.meta.env.VITE_API_BASE_URL.replace(/\/$/, '') : '';
const AUTH_KEY = 'myai.auth.v1';

function readStoredAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string' && parsed.token) return parsed;
  } catch {
    /* Ignore unreadable or legacy storage. */
  }
  return null;
}

function persistAuth(auth) {
  try {
    if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    /* Storage may be unavailable in private browsing; the session still works. */
  }
}

// A new token or a different account invalidates any callback verification in
// flight in another tab. Cosmetic updates to the same session do not.
function authEpochIdentity(auth) {
  if (!auth) return '';
  return `${auth.user?.id ?? ''}:${auth.token ?? ''}`;
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

function statusBadgeClass(status) {
  const map = {
    queued: 'status-queued',
    running: 'status-running',
    waiting_approval: 'status-waiting',
    completed: 'status-completed',
    failed: 'status-failed',
    cancelled: 'status-cancelled',
  };
  return map[status] || 'status-unknown';
}

function stepStatusClass(status) {
  const map = {
    done: 'step-done',
    running: 'step-running',
    failed: 'step-failed',
  };
  return map[status] || 'step-unknown';
}

// Chat history is namespaced per authenticated account so two accounts that
// share a browser never see each other's conversations. The legacy global
// key is migrated into the signed-in account's namespace on first load.
const STORAGE_KEY = 'myai.chat-sessions.v1';
function sessionsStorageKey(userId) {
  return userId === null || userId === undefined ? `${STORAGE_KEY}.anonymous` : `${STORAGE_KEY}.${userId}`;
}
const THEME_KEY = 'myai.theme';
const PROVIDER_KEY = 'myai.provider';
const MAX_CHARS = 20_000;
const CHAT_PROVIDER_IDS = new Set(['openai', 'gemini']);
const PROVIDER_LABELS = { openai: 'OpenRouter', gemini: 'Google Gemini' };
const FALLBACK_REASON_LABELS = {
  QUOTA_EXHAUSTED: 'The daily quota was exhausted.',
  RATE_LIMITED: 'The rate limit was reached.',
  CAPACITY_UNAVAILABLE: 'The model was temporarily at capacity.',
  NETWORK_TIMEOUT: 'The request timed out.',
  NETWORK_ERROR: 'The provider could not be reached.',
  PROVIDER_ERROR: 'The provider was temporarily unavailable.',
};
const ERROR_CATEGORY_LABELS = {
  QUOTA_EXHAUSTED: 'Provider quota is exhausted.',
  RATE_LIMITED: 'Provider rate limit reached.',
  CAPACITY_UNAVAILABLE: 'Provider is temporarily at capacity.',
  PROVIDER_ERROR: 'Provider is temporarily unavailable.',
  NETWORK_TIMEOUT: 'Provider request timed out.',
  NETWORK_ERROR: 'Provider could not be reached.',
  INVALID_API_KEY: 'Provider API key was rejected.',
  REQUEST_ERROR: 'Provider rejected the request.',
};

function formatRetryDelay(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const value = Math.ceil(seconds);
  if (value < 60) return `${value} second(s)`;
  if (value < 3600) return `${Math.ceil(value / 60)} minute(s)`;
  return `${Math.ceil(value / 3600)} hour(s)`;
}

function providerErrorToast(error) {
  const base = error.message || 'Something went wrong. Please try again.';
  const extras = [];
  if (error.category) {
    extras.push(ERROR_CATEGORY_LABELS[error.category] || `Error category: ${error.category}.`);
  }
  if (error.retryAfterSeconds) {
    const delay = formatRetryDelay(error.retryAfterSeconds);
    if (delay) extras.push(`Retry after about ${delay}.`);
  }
  if (error.fallbackAttempted) {
    const from = PROVIDER_LABELS[error.fallbackFrom] || error.fallbackFrom || 'The primary provider';
    const reason = FALLBACK_REASON_LABELS[error.fallbackReason]
      || (error.fallbackReason ? `Reason: ${error.fallbackReason}.` : '');
    extras.push(`Fallback also failed: ${from} was unavailable. ${reason}`.trim());
  }
  return extras.length ? `${base} ${extras.join(' ')}` : base;
}

const ACTIVE_PROJECT_KEY = 'myai.active-project.v1';

function activeProjectStorageKey(userId) {
  return userId === null || userId === undefined
    ? `${ACTIVE_PROJECT_KEY}.anonymous`
    : `${ACTIVE_PROJECT_KEY}.${userId}`;
}

function readActiveProjectId(userId) {
  try {
    return localStorage.getItem(activeProjectStorageKey(userId)) || '';
  } catch {
    return '';
  }
}

function persistActiveProjectId(userId, projectId) {
  try {
    const key = activeProjectStorageKey(userId);
    if (projectId) localStorage.setItem(key, String(projectId));
    else localStorage.removeItem(key);
  } catch {
    /* The selection still works for this page even if storage is unavailable. */
  }
}

function readProvider() {
  try {
    const stored = localStorage.getItem(PROVIDER_KEY);
    return CHAT_PROVIDER_IDS.has(stored) ? stored : '';
  } catch (error) {
    console.warn('Could not restore the AI provider choice.', error);
    return '';
  }
}

const starters = [
  { icon: '⌕', title: 'Explore this project', hint: 'Structure, entry points and how to run it', prompt: 'Inspect this project. Summarize its structure, main entry points, and how to run it. Then suggest the most useful next step.' },
  { icon: '◈', title: 'Plan a feature', hint: 'Files to change and the steps to get there', prompt: 'Help me plan a small feature for this project. Inspect the relevant files first, then outline the files to change and the steps to implement it.' },
  { icon: '⚒', title: 'Fix a bug', hint: 'Find the cause, then propose a focused fix', prompt: 'I have a bug in this project. Inspect the code, identify the likely cause, and propose a focused fix. Do not change files until I approve.' },
  { icon: '✓', title: 'Add tests', hint: 'Cover important behaviour, approval first', prompt: 'Inspect this project and propose tests for its most important behavior. Explain what each test covers and wait for approval before writing files.' },
];

const initialSession = () => ({
  id: crypto.randomUUID(),
  title: 'New conversation',
  messages: [],
  updatedAt: Date.now(),
});

function readSessions(namespace) {
  try {
    const stored = JSON.parse(localStorage.getItem(namespace) || '[]');
    if (Array.isArray(stored) && stored.length) {
      const validSessions = stored.filter((session) => session && typeof session.id === 'string'
        && Array.isArray(session.messages));
      if (validSessions.length) return validSessions;
    }
  } catch (error) {
    console.warn('Could not restore saved conversations.', error);
  }
  return [initialSession()];
}

function Icon({ name, size = 18 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  const paths = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>,
    moon: <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    stop: <><rect x="5" y="5" width="14" height="14" rx="3" /></>,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" /></>,
    thumbsUp: <><path d="M7 10v12M15 5.9 14 10h5.6a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 18.2 21H7V10l4.2-7a2 2 0 0 1 3.8 1.1Z" /><path d="M3 10h4v12H3z" /></>,
    thumbsDown: <><path d="M7 14V2M15 18.1 14 14h5.6a2 2 0 0 0 2-2.4l-1.4-7A2 2 0 0 0 18.2 3H7v11l4.2 7a2 2 0 0 0 3.8-1.1Z" /><path d="M3 2h4v12H3z" /></>,
    trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16l-1 4Z" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    arrowDown: <><path d="M12 5v14m-7-7 7 7 7-7" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" /><path d="m19 14 1.1 2.9L23 18l-2.9 1.1L19 22l-1.1-2.9L15 18l2.9-1.1L19 14Z" /></>,
    folder: <><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>,
  };
  return <svg {...common}>{paths[name] || paths.spark}</svg>;
}

function formatMarkdown(content) {
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }) => {
    const language = lang?.split(/\s+/)[0] || 'code';
    const label = language.length > 16 ? language.slice(0, 16) : language;
    const safeLanguage = language.replace(/[^a-zA-Z0-9_-]/g, '');
    const escaped = text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    return `<div class="code-block"><div class="code-toolbar"><span class="code-language">${label}</span><button class="copy-code" type="button" aria-label="Copy code">Copy code</button></div><pre><code class="language-${safeLanguage}">${escaped}</code></pre></div>`;
  };
  return DOMPurify.sanitize(marked.parse(content, { renderer, breaks: true }), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['class', 'aria-label'],
  });
}

function diffPreviewLines(originalContent = '', proposedContent = '') {
  const original = originalContent.split('\n');
  const proposed = proposedContent.split('\n');
  let prefix = 0;
  while (prefix < original.length && prefix < proposed.length && original[prefix] === proposed[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < original.length - prefix
    && suffix < proposed.length - prefix
    && original[original.length - suffix - 1] === proposed[proposed.length - suffix - 1]
  ) suffix += 1;
  const lines = [
    ...original.slice(0, prefix).map((line) => ({ type: 'context', line })),
    ...original.slice(prefix, original.length - suffix).map((line) => ({ type: 'remove', line })),
    ...proposed.slice(prefix, proposed.length - suffix).map((line) => ({ type: 'add', line })),
    ...(suffix ? original.slice(original.length - suffix).map((line) => ({ type: 'context', line })) : []),
  ];
  return { lines: lines.slice(0, 500), truncated: lines.length > 500 };
}

// Agent tool activity states. "awaiting approval" is deliberately distinct
// from "running": a staged change is not applied until the user approves it.
const TOOL_STATUS_VIEW = {
  completed: { className: 'completed', icon: '✓', label: 'done' },
  failed: { className: 'failed', icon: '!', label: 'failed' },
  'awaiting approval': { className: 'awaiting', icon: '⏸', label: 'awaiting approval' },
  running: { className: 'running', icon: '…', label: 'running' },
};

function Message({ message, index, sessionId, onCopy, onRegenerate, onFeedback, onApplyProposal, onDiscardProposal, onRunCommand, onRejectCommand }) {
  const articleRef = useRef(null);

  useEffect(() => {
    articleRef.current?.querySelectorAll('pre code').forEach((block) => {
      if (!block.dataset.highlighted) hljs.highlightElement(block);
    });
  }, [message.content]);

  const handleCodeCopy = async (event) => {
    const button = event.target.closest('.copy-code');
    if (!button) return;
    const code = button.closest('.code-block')?.querySelector('pre code')?.textContent;
    if (code === undefined) return;
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = 'Copied';
      button.classList.add('copied');
      window.setTimeout(() => {
        button.textContent = 'Copy code';
        button.classList.remove('copied');
      }, 1600);
    } catch (error) {
      console.error('Could not copy code to clipboard.', error);
    }
  };

  if (message.role === 'user') {
    return (
      <article className="message-row user-row">
        <div className="user-bubble">{message.content}</div>
      </article>
    );
  }

  return (
    <article className="message-row assistant-row" ref={articleRef}>
      <div className="assistant-mark"><Icon name="spark" size={15} /></div>
      <div className="assistant-content">
        <div
          className="markdown-body"
          onClick={handleCodeCopy}
          dangerouslySetInnerHTML={{ __html: formatMarkdown(message.content) }}
        />
        {message.fallback && (
          <div className="tool-activity" aria-label="Provider fallback">
            <span className="tool-activity-item completed">
              {PROVIDER_LABELS[message.fallback.from] || message.fallback.from} was unavailable; answered by {PROVIDER_LABELS[message.provider] || message.provider}. {FALLBACK_REASON_LABELS[message.fallback.reason] || 'An alternative provider was used.'}
            </span>
          </div>
        )}
        {workspaceStatusMessage(message.workspace) && (
          <div className="tool-activity" aria-label="Workspace availability">
            <span className="tool-activity-item failed">
              {workspaceStatusMessage(message.workspace)}
            </span>
          </div>
        )}
        {message.toolActivity?.length > 0 && (
          <div className="tool-activity" aria-label="Agent actions">
            {message.toolActivity.map((activity, activityIndex) => {
              const status = TOOL_STATUS_VIEW[activity.status] || TOOL_STATUS_VIEW.running;
              const approvalCommand = activity.commandApproval?.command;
              const isPythonApproval = approvalCommand === 'python_check' || approvalCommand === 'python_run';
              return (
              <div key={`${activity.tool}-${activityIndex}`} className="tool-activity-group">
                <span className={`tool-activity-item ${status.className}`}>
                  {status.icon} {activity.tool} · {status.label}{activity.reused ? ' · reused previous result' : ''}
                </span>
                {activity.detail && (
                  <span className="tool-activity-item" aria-label="Tool details">{activity.detail}</span>
                )}
                {activity.proposal && (
                  <div className="diff-proposal">
                    <div className="file-panel-heading">
                      <strong>{activity.proposal.originalContent === undefined ? 'New file' : 'File changes'}: {activity.proposal.path}</strong>
                      {!activity.proposalState && (
                        <>
                          <button onClick={() => onApplyProposal(sessionId, index, activityIndex, activity.projectId, activity.proposal.proposalId)}>Apply file</button>
                          <button onClick={() => onDiscardProposal(sessionId, index, activityIndex, activity.projectId, activity.proposal.proposalId)}>Discard</button>
                        </>
                      )}
                      {activity.proposalState === 'applied' && <span className="proposal-state">Applied</span>}
                      {activity.proposalState === 'discarded' && <span className="proposal-state">Discarded — nothing was written</span>}
                    </div>
                    {(() => {
                      const preview = diffPreviewLines(activity.proposal.originalContent, activity.proposal.content);
                      return (
                        <pre>{preview.lines.map((entry, lineIndex) => (
                          <span className={`diff-${entry.type}`} key={lineIndex}>{entry.type === 'add' ? '+' : entry.type === 'remove' ? '-' : ' '} {entry.line}{'\n'}</span>
                        ))}{preview.truncated ? '\n… diff preview limited to 500 lines' : ''}</pre>
                      );
                    })()}
                  </div>
                )}
                {activity.commandApproval && (
                  <div className="command-approval">
                    <span>
                      {isPythonApproval ? 'Python approval required' : 'Command approval required'}:{' '}
                      <code>{activity.commandApproval.command}</code>
                      {activity.commandApproval.path && <> · <code>{activity.commandApproval.path}</code></>}
                      {activity.commandApproval.contentSha256 && (
                        <> · digest <code>{String(activity.commandApproval.contentSha256).slice(0, 19)}…</code></>
                      )}
                    </span>
                    {!activity.commandResult && !activity.commandState && (
                      <>
                        <button onClick={() => onRunCommand(sessionId, index, activityIndex, activity.projectId, activity.commandApproval.proposalId)}>
                          {isPythonApproval ? 'Run approved Python operation' : 'Run approved command'}
                        </button>
                        <button onClick={() => onRejectCommand(sessionId, index, activityIndex, activity.projectId, activity.commandApproval.proposalId)}>
                          Reject
                        </button>
                      </>
                    )}
                    {activity.commandState === 'rejected' && (
                      <span className="proposal-state">Rejected — nothing was run</span>
                    )}
                    {activity.commandResult && (
                      <pre>Exit code: {activity.commandResult.exitCode}{'\n'}{activity.commandResult.stdout}{activity.commandResult.stderr}</pre>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
        <div className="message-actions">
          <button className="icon-action" onClick={() => onCopy(message.content)} aria-label="Copy message" title="Copy message"><Icon name="copy" size={15} /></button>
          <button className="icon-action" onClick={() => onRegenerate(index)} aria-label="Regenerate response" title="Regenerate response"><Icon name="refresh" size={15} /></button>
          <span className="action-divider" />
          <button className={`icon-action ${message.feedback === 'up' ? 'selected' : ''}`} onClick={() => onFeedback(index, 'up')} aria-label="Helpful" title="Helpful"><Icon name="thumbsUp" size={15} /></button>
          <button className={`icon-action ${message.feedback === 'down' ? 'selected' : ''}`} onClick={() => onFeedback(index, 'down')} aria-label="Not helpful" title="Not helpful"><Icon name="thumbsDown" size={15} /></button>
        </div>
      </div>
    </article>
  );
}

function App() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  // Which storage namespace the current `sessions` state belongs to, and
  // whether the load effect has run yet (guards the persist effect).
  const sessionsNamespaceRef = useRef(null);
  const sessionsLoadedRef = useRef(false);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia('(max-width: 560px)').matches);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark');
  const [selectedProvider, setSelectedProvider] = useState(readProvider);
  const [health, setHealth] = useState({
    online: false,
    provider: null,
    providerLabel: null,
    providers: null,
    fallbackProvider: null,
    npmScriptsEnabled: false,
    warning: 'Checking AI provider configuration…',
  });
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsLoadError, setProjectsLoadError] = useState(null);
  const [staleRestoredProjectId, setStaleRestoredProjectId] = useState('');
  const [toast, setToast] = useState(null);
  const [retryRequest, setRetryRequest] = useState(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceScan, setWorkspaceScan] = useState({ status: 'idle', error: null, result: null });
  const [projectUnderstanding, setProjectUnderstanding] = useState(null);
  const [scanRequest, setScanRequest] = useState(0);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [fileSearch, setFileSearch] = useState('');
  const [codeSearchResults, setCodeSearchResults] = useState([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(() => window.matchMedia('(min-width: 1101px)').matches);
  const [workspaceTab, setWorkspaceTab] = useState('files');
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState(null);
  const [focusTaskId, setFocusTaskId] = useState(null);
  const [taskInput, setTaskInput] = useState('');
  const [tasks, setTasks] = useState([]);
  const [projectProposals, setProjectProposals] = useState([]);
  const [taskStatusFilter, setTaskStatusFilter] = useState(null);
  const [tasksError, setTasksError] = useState(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [taskDetail, setTaskDetail] = useState(null);
  const [taskDetailError, setTaskDetailError] = useState(null);
  const [attachment, setAttachment] = useState(null);
  const [diffPreview, setDiffPreview] = useState(false);
  const initialAuthFragment = parseAuthFragment(window.location.hash);
  const [auth, setAuth] = useState(() => readStoredAuth());
  const [authChecking, setAuthChecking] = useState(
    () => Boolean(readStoredAuth()) || initialAuthFragment.present,
  );
  const [authError, setAuthError] = useState(
    () => (initialAuthFragment.error ? googleErrorMessage(initialAuthFragment.error) : null),
  );
  const authRef = useRef(auth);
  // Incremented on every sign-out/account switch and on a newly accepted auth
  // result. Async callbacks compare it before touching workspace state.
  const authTransitionGenerationRef = useRef(0);
  // Dedicated workspace generation: every account/session change invalidates
  // all outstanding workspace requests, even those started by a direct login
  // that did not go through clearSession().
  const workspaceGenerationRef = useRef(0);
  const renewalStateRef = useRef({ inFlightToken: null });
  const authUserId = auth?.user?.id ?? null;
  const activeProject = projects.find((project) => String(project.id) === String(projectId)) || null;
  const workspaceSelection = workspaceSelectionState({
    loading: projectsLoading,
    loadError: projectsLoadError,
    projects,
    projectId,
    activeProject,
    staleRestoredProjectId,
  });
  const visibleProject = verifiedWorkspaceProject({ projects, selection: workspaceSelection });
  const workspaceScanView = workspaceScanStatus({
    hasProject: Boolean(visibleProject),
    loading: workspaceLoading,
    error: workspaceScan.error,
    result: workspaceScan.result,
  });
  const projectsLoadedRef = useRef(false);
  const projectsScopeRef = useRef(null);
  const projectsLoadGenerationRef = useRef(0);
  const previousAuthUserIdRef = useRef(authUserId);
  const waitingTaskCount = tasks.filter((task) => task.status === 'waiting_approval').length;
  // Keep the latest task query inputs available to the stable loadTasks
  // callback so automatic loads do not re-run when only the filter changes.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const taskStatusFilterRef = useRef(taskStatusFilter);
  taskStatusFilterRef.current = taskStatusFilter;
  const taskLoadScopeRef = useRef(null);
  const taskLoadGenerationRef = useRef(0);
  const workspaceRequestRef = useRef(0);
  const workspaceFileRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const taskDetailRequestRef = useRef(0);
  const taskSubmitRequestRef = useRef(0);
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  const messageListRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const controllerRef = useRef(null);
  const wasAtBottomRef = useRef(true);

  const applyAuth = useCallback((next) => {
    const previous = authRef.current;
    const changed = authEpochIdentity(previous) !== authEpochIdentity(next);
    authRef.current = next;
    persistAuth(next);
    setAuth(next);
    if (changed) {
      bumpAuthEpoch();
      // Directly accepting a new login (without an explicit clearSession)
      // must also invalidate every request started by the previous session.
      workspaceGenerationRef.current += 1;
      // Abort a pending chat so a same-user token change cannot leave the
      // composer busy. The matching request's own finally still clears the
      // controller and generating flag.
      controllerRef.current?.abort();
      setGenerating(false);
    }
  }, []);

  // Captures the current account/token/generation/project before a request.
  // Every guarded handler compares this snapshot again before applying a
  // result or an error.
  const readWorkspaceScope = useCallback((scopeProjectId = projectIdRef.current) => captureWorkspaceResponseScope({
    authenticated: Boolean(authRef.current),
    userId: authRef.current?.user?.id ?? null,
    token: authRef.current?.token ?? null,
    projectId: scopeProjectId,
    generation: workspaceGenerationRef.current,
  }), []);

  const isCurrentWorkspaceScope = useCallback((request, scopeProjectId = projectIdRef.current) => (
    isCurrentWorkspaceResponseScope({
      current: readWorkspaceScope(scopeProjectId),
      request,
    })
  ), [readWorkspaceScope]);

  // For an explicitly targeted project, only the account/session must remain
  // valid. The target project itself is validated by the URL and server.
  const isCurrentWorkspaceSession = useCallback((request) => (
    isCurrentWorkspaceSessionScope({
      current: readWorkspaceScope(request?.projectId),
      request,
    })
  ), [readWorkspaceScope]);

  // One cleanup path for sign-out, confirmed session expiry, and account
  // changes. Everything derived from the old account or project is discarded.
  const clearWorkspaceState = useCallback((userId = null) => {
    // Invalidate outstanding work first; their later success/error callbacks
    // will fail the shared scope check instead of painting the new account.
    workspaceGenerationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    workspaceRequestRef.current += 1;
    workspaceFileRequestRef.current += 1;
    searchRequestRef.current += 1;
    taskDetailRequestRef.current += 1;
    taskSubmitRequestRef.current += 1;

    persistActiveProjectId(userId, '');
    // Drop loaded conversations without writing the empty state into the old
    // account's storage namespace. The authUserId effect reloads the new one.
    sessionsLoadedRef.current = false;
    sessionsNamespaceRef.current = null;
    setSessions([]);
    setActiveId(null);
    setInput('');
    setTaskInput('');
    setGenerating(false);
    projectsLoadedRef.current = false;
    projectsScopeRef.current = null;
    projectsLoadGenerationRef.current += 1;
    setProjects([]);
    setProjectId('');
    setProjectsLoading(true);
    setProjectsLoadError(null);
    setStaleRestoredProjectId('');
    setWorkspaceFiles([]);
    setWorkspaceLoading(false);
    setWorkspaceScan({ status: 'idle', error: null, result: null });
    setProjectUnderstanding(null);
    setSelectedFile(null);
    setFileContent('');
    setFileSearch('');
    setCodeSearchResults([]);
    setProjectDialogOpen(false);
    setProjectBusy(false);
    setProjectError(null);
    setTasks([]);
    setProjectProposals([]);
    setTaskStatusFilter(null);
    setTasksError(null);
    setTaskLoading(false);
    setTaskSubmitting(false);
    setTaskDetail(null);
    setTaskDetailError(null);
    setFocusTaskId(null);
    setRetryRequest(null);
    setToast(null);
    setAttachment(null);
    setDiffPreview(false);
  }, []);

  const clearSession = useCallback((userId = null, { keepError = false } = {}) => {
    authTransitionGenerationRef.current += 1;
    clearWorkspaceState(userId);
    if (!keepError) setAuthError(null);
    applyAuth(null);
  }, [applyAuth, clearWorkspaceState]);

  const signOut = useCallback(async () => {
    const current = authRef.current;
    if (current?.token) {
      try {
        await globalThis.fetch(`${API_BASE}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${current.token}` },
        });
      } catch {
        /* Best effort: local sign-out still happens. */
      }
    }
    clearSession(current?.user?.id ?? null);
  }, [clearSession]);

  // Every API call goes through here so the bearer token is attached in one
  // place. A 401 only ends the session when it belongs to the token that made
  // the request, so a slow old response cannot sign out a newer Google token.
  const apiFetch = useCallback(async (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    const current = authRef.current;
    const requestToken = current?.token ?? null;
    if (requestToken) headers.set('Authorization', `Bearer ${requestToken}`);
    const response = await globalThis.fetch(input, { ...init, headers });
    if (response.status === 401 && requestToken) {
      let code = null;
      try {
        code = (await response.clone().json())?.code ?? null;
      } catch {
        /* Body was not JSON; fall back to the request path. */
      }
      if (shouldSignOutFor401({
        status: response.status,
        code,
        url: String(input),
        requestToken,
        currentToken: authRef.current?.token ?? null,
      })) {
        clearSession(current?.user?.id ?? null);
      }
    }
    return response;
  }, [clearSession]);

  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  // The callback runner is created once per mounted app instance. Refs keep its
  // handlers current without recreating it during React StrictMode remounts.
  const applyAuthRef = useRef(applyAuth);
  applyAuthRef.current = applyAuth;
  const clearSessionRef = useRef(clearSession);
  clearSessionRef.current = clearSession;
  const authCallbackRunnerRef = useRef(null);
  if (!authCallbackRunnerRef.current) {
    authCallbackRunnerRef.current = createAuthCallbackRunner({
      apiBase: API_BASE,
      fetchImpl: (...args) => globalThis.fetch(...args),
      getTransitionGeneration: () => authTransitionGenerationRef.current,
      getCurrentAuth: () => authRef.current,
      getAuthEpoch: () => readAuthEpoch(),
      onSettled: () => setAuthChecking(false),
      clearHash: () => {
        if (window.history?.replaceState) {
          window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
        }
      },
      onAuthenticated: (token, user, expiresAt) => {
        setAuthError(null);
        setAuthChecking(false);
        authTransitionGenerationRef.current += 1;
        applyAuthRef.current({ token, user, expiresAt });
      },
      onError: (message) => {
        setAuthError(message);
        setAuthChecking(false);
        clearSessionRef.current(readStoredAuth()?.user?.id ?? null, { keepError: true });
      },
    });
  }

  // Google callback verification happens here, before the Login/workspace
  // decision. A callback token always beats a stale token in localStorage.
  // Without a callback, the stored token is verified exactly as before.
  useEffect(() => {
    const fragment = parseAuthFragment(window.location.hash);
    if (fragment.present) {
      setAuthChecking(true);
      authCallbackRunnerRef.current.run(window.location.hash);
      return undefined;
    }

    let cancelled = false;
    const generation = authTransitionGenerationRef.current;
    const stored = readStoredAuth();
    const token = chooseAuthTokenForInitialization({
      callbackToken: null,
      storedToken: stored?.token ?? null,
    });
    if (!token) {
      setAuthChecking(false);
      return undefined;
    }
    setAuthChecking(true);
    (async () => {
      try {
        const result = await renewExistingSession({
          token,
          expectedUserId: stored?.user?.id ?? null,
          apiBase: API_BASE,
          endpoint: '/api/auth/me',
          fetchImpl: globalThis.fetch,
          state: renewalStateRef.current,
        });
        // A sign-out or account switch during renewal must discard the result.
        if (cancelled || !shouldApplyRenewalResult({
          result,
          generationAtStart: generation,
          currentGeneration: authTransitionGenerationRef.current,
          requestToken: token,
          currentToken: authRef.current?.token ?? null,
        })) return;
        if (result.status === 'invalid') {
          if (result.reason === 'identity_mismatch') {
            setAuthError('Your saved session did not match this account. Sign in again.');
          }
          clearSession(stored?.user?.id ?? null, { keepError: result.reason === 'identity_mismatch' });
        } else if (result.status === 'authenticated') {
          setAuthError(null);
          applyAuth({
            ...stored,
            token,
            user: result.user,
            expiresAt: result.expiresAt ?? stored?.expiresAt,
          });
        }
        // "unavailable"/"in_flight" keep the stored session without retrying.
      } catch {
        /* Server unreachable: keep the stored session. */
      } finally {
        if (!cancelled) setAuthChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyAuth, clearSession]);

  // A different account must never inherit the previous account's workspace.
  useEffect(() => {
    const previous = previousAuthUserIdRef.current;
    previousAuthUserIdRef.current = authUserId;
    if (shouldClearWorkspaceForAuthChange(previous, authUserId)) {
      clearWorkspaceState(previous);
    }
  }, [authUserId, clearWorkspaceState]);

  const activeSession = sessions.find((session) => session.id === activeId) || sessions[0];
  const messages = activeSession?.messages || [];
  const tokenEstimate = Math.ceil(input.length / 4);
  const selectedProviderStatus = selectedProvider ? health.providers?.[selectedProvider] : null;
  const selectedProviderWarning = health.online && selectedProviderStatus?.configured === false
    ? `${selectedProviderStatus.label || PROVIDER_LABELS[selectedProvider] || selectedProvider} is selected, but its API key is missing from the project-root .env.`
    : null;
  // Startup-provider warnings are irrelevant once a different, configured
  // provider is selected for chat. Keep offline warnings visible.
  const showStartupWarning = !health.online || !selectedProvider || selectedProvider === health.provider;
  const warningText = selectedProviderWarning || (showStartupWarning ? health.warning : null);
  const warningTitle = selectedProviderWarning
    ? `${selectedProviderStatus.label || PROVIDER_LABELS[selectedProvider] || selectedProvider} needs attention`
    : health.providerLabel
      ? `${health.providerLabel} needs attention`
      : health.provider === 'openai'
        ? 'OpenRouter needs attention'
        : health.provider === 'gemini'
          ? 'Google Gemini needs attention'
          : health.provider === 'huggingface'
            ? 'Hugging Face needs attention'
            : 'AI provider status';

  // Load the chat history that belongs to the signed-in account. Every
  // account gets its own namespace, so signing out and into a different
  // account can never reveal the previous account's conversations. The
  // legacy global key is migrated into this account's namespace exactly
  // once (kept on first account for continuity) and then removed.
  useEffect(() => {
    const namespace = sessionsStorageKey(authUserId);
    sessionsNamespaceRef.current = namespace;
    sessionsLoadedRef.current = false;
    try {
      const legacy = localStorage.getItem(STORAGE_KEY);
      if (legacy !== null) {
        if (authUserId !== null && localStorage.getItem(namespace) === null) {
          localStorage.setItem(namespace, legacy);
        }
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      console.warn('Could not migrate saved conversations into this account.', error);
    }
    const restored = readSessions(namespace);
    setSessions(restored);
    setActiveId(restored[0].id);
    sessionsLoadedRef.current = true;
  }, [authUserId]);

  useEffect(() => {
    if (!sessionsLoadedRef.current) return; // wait for the namespace load
    const namespace = sessionsNamespaceRef.current;
    if (!namespace) return;
    try {
      localStorage.setItem(namespace, JSON.stringify(sessions));
    } catch (error) {
      console.warn('Could not save conversations in this browser.', error);
    }
  }, [sessions]);

  // Restore only from the current account's loaded project list. A stale ID
  // from another account or a deleted project requires an explicit choice.
  useEffect(() => {
    if (!auth || !projectsLoadedRef.current) return;
    if (projectsScopeRef.current !== responseScopeKey(authUserId, null)) return;
    const storedProjectId = readActiveProjectId(authUserId);
    const hasUsableStoredProject = matchingProjectId(projects, storedProjectId) !== null;
    const next = selectRestoredProjectId({
      projects,
      currentProjectId: projectId,
      storedProjectId,
      projectsLoaded: true,
    });
    if (storedProjectId && !hasUsableStoredProject) {
      setStaleRestoredProjectId(storedProjectId);
      // A deleted or foreign saved project must not survive in this account's
      // storage, even when no replacement is available yet.
      if (!next) persistActiveProjectId(authUserId, '');
    } else {
      setStaleRestoredProjectId('');
    }
    if (next !== projectId) setProjectId(next);
  }, [auth, authUserId, projects, projectId]);

  // Do not write a pre-load or cross-account selection into storage.
  useEffect(() => {
    if (!auth || projectsScopeRef.current !== responseScopeKey(authUserId, null)) return;
    const validated = activeProjectIdForPersistence({
      projectsLoaded: projectsLoadedRef.current,
      activeProject,
    });
    if (validated !== null) persistActiveProjectId(authUserId, validated);
  }, [auth, authUserId, activeProject]);

  // Never leave one project's file or search results on screen after switching.
  useEffect(() => {
    setSelectedFile(null);
    setFileContent('');
    setFileSearch('');
    setCodeSearchResults([]);
  }, [projectId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // If the user has not chosen a provider yet, follow the backend default when
  // it is one of the switchable chat providers. An explicit choice always wins.
  useEffect(() => {
    if (selectedProvider) return;
    if (CHAT_PROVIDER_IDS.has(health.provider)) setSelectedProvider(health.provider);
  }, [health.provider, selectedProvider]);

  useEffect(() => {
    if (!CHAT_PROVIDER_IDS.has(selectedProvider)) return;
    try {
      localStorage.setItem(PROVIDER_KEY, selectedProvider);
    } catch (error) {
      console.warn('Could not save the AI provider choice in this browser.', error);
    }
  }, [selectedProvider]);

  const loadProjects = useCallback(async () => {
    const scope = responseScopeKey(authRef.current?.user?.id ?? null, null);
    const requestWorkspaceScope = readWorkspaceScope(null);
    const generation = ++projectsLoadGenerationRef.current;
    const isCurrent = () => generation === projectsLoadGenerationRef.current
      && isCurrentWorkspaceScope(requestWorkspaceScope, null);

    if (!authRef.current) {
      if (!isCurrent()) return;
      projectsLoadedRef.current = true;
      projectsScopeRef.current = null;
      setProjects([]);
      setProjectId('');
      setStaleRestoredProjectId('');
      setProjectsLoadError(null);
      setProjectsLoading(false);
      return;
    }

    projectsLoadedRef.current = false;
    projectsScopeRef.current = scope;
    setProjectsLoading(true);
    setProjectsLoadError(null);
    try {
      const response = await apiFetch(`${API_BASE}/api/projects`);
      if (!response.ok) throw new Error(`Projects request returned ${response.status}`);
      const data = await response.json();
      if (!isCurrent()) return;
      setProjects(Array.isArray(data.projects) ? data.projects : []);
      projectsLoadedRef.current = true;
      setProjectsLoading(false);
    } catch (error) {
      if (!isCurrent()) return;
      console.warn('Could not load projects.', error);
      // A failed load is never "loaded": chat scope stays blocked, but the UI
      // can now distinguish this from an empty authorized project list.
      projectsLoadedRef.current = false;
      setProjectsLoadError('Could not load your authorized projects.');
      setProjectsLoading(false);
    }
  }, [apiFetch, isCurrentWorkspaceScope, readWorkspaceScope]);

  useEffect(() => {
    let cancelled = false;
    const checkHealth = async () => {
      const requestScope = readWorkspaceScope(null);
      const isCurrent = () => !cancelled && isCurrentWorkspaceScope(requestScope, null);
      try {
        const response = await apiFetch(`${API_BASE}/api/health`);
        if (!response.ok) throw new Error(`Health check returned ${response.status}`);
        const data = await response.json();
        if (!isCurrent()) return;
        setHealth({
          online: true,
          provider: data.aiProvider || 'mock',
          providerLabel: data.providerLabel || null,
          providers: data.providers || null,
          fallbackProvider: data.fallbackProvider || null,
          npmScriptsEnabled: data.npmScriptsEnabled !== false,
          warning: data.aiWarning || null,
        });
      } catch (error) {
        if (!isCurrent()) return;
        setHealth({
          online: false,
          provider: null,
          providerLabel: null,
          providers: null,
          fallbackProvider: null,
          npmScriptsEnabled: false,
          warning: 'Cannot reach the AI server. Start or restart the backend and try again.',
        });
      }
    };
    checkHealth();
    loadProjects();
    const timer = window.setInterval(checkHealth, 15000);
    return () => {
      cancelled = true;
      projectsLoadGenerationRef.current += 1;
      window.clearInterval(timer);
    };
  }, [apiFetch, auth?.token, isCurrentWorkspaceScope, loadProjects, readWorkspaceScope]);

  // A verified selection (including a restored one after browser refresh)
  // starts the existing safe /tree scan automatically. `scanRequest` also lets
  // an explicit "open" of the same project rescan without changing selection.
  useEffect(() => {
    if (!shouldStartWorkspaceScan({
      authenticated: Boolean(authRef.current),
      projectId,
      workspaceReady: workspaceSelection.ready,
    })) return;
    loadWorkspaceFiles(projectId);
  }, [projectId, auth?.token, scanRequest, workspaceSelection.ready]);

  useEffect(() => {
    const list = messageListRef.current;
    if (list && wasAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length, generating]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 5500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const updateSession = useCallback((sessionId, updater) => {
    setSessions((current) => current.map((session) => (
      session.id === sessionId ? updater(session) : session
    )));
  }, []);

  const requestReply = useCallback(async ({ sessionId, prompt, history, attachment: requestAttachment = null }) => {
    if (generating) return;
    // Shared final guard for every send path, including regenerate and the
    // toast Retry button, so no caller can silently send without workspace scope.
    const loadingMessage = workspaceLoadingMessage(projectsLoading);
    if (loadingMessage) {
      setToast({ message: loadingMessage });
      return;
    }
    if (!health.online) {
      setRetryRequest({ sessionId, prompt, history, attachment: requestAttachment });
      setToast({ message: 'The API is offline. Check that the server is running, then retry.' });
      return;
    }
    setGenerating(true);
    setToast(null);
    const apiPrompt = buildPromptWithAttachment(prompt, requestAttachment);
    const controller = new AbortController();
    controllerRef.current = controller;
    const providerForRequest = CHAT_PROVIDER_IDS.has(selectedProvider)
      ? selectedProvider
      : (CHAT_PROVIDER_IDS.has(health.provider) ? health.provider : null);
    // Revalidate workspace scope from current account state on every send,
    // including retries after authentication is restored.
    const requestContext = chatRequestContext({
      authToken: authRef.current?.token ?? null,
      projects,
      projectId,
      activeProject,
      projectsLoaded: !projectsLoading && !projectsLoadError,
      retryRequest,
    });
    const requestScope = readWorkspaceScope(requestContext.projectId);
    // Compare against the project selected now, not the request's own target:
    // passing the target ID back to the guard would make every project switch
    // look current and let a delayed reply land in the wrong workspace.
    const isCurrent = () => isCurrentWorkspaceScope(requestScope);
    try {
      const response = await apiFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          messages: [...history, { role: 'user', content: apiPrompt }],
          ...(providerForRequest ? { provider: providerForRequest } : {}),
          ...(requestContext.projectId !== null ? { projectId: requestContext.projectId } : {}),
        }),
      });
      const result = await response.json();
      // A reply from an account/session that has since changed is discarded
      // before it can append a message or raise a toast for the new account.
      if (!isCurrent()) return;
      if (!response.ok || !result.ok) {
        const error = new Error(result.error || `Request failed (${response.status})`);
        error.status = response.status;
        error.category = result.errorCategory || null;
        const retryAfter = Number(result.retryAfterSeconds);
        error.retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
        error.fallbackAttempted = Boolean(result.fallbackAttempted);
        error.fallbackFrom = result.fallbackFrom || null;
        error.fallbackReason = result.fallbackReason || null;
        throw error;
      }
      updateSession(sessionId, (session) => ({
        ...session,
        messages: [...session.messages, {
          role: 'assistant',
          content: result.reply,
          provider: result.provider,
          model: result.model,
          toolActivity: result.toolActivity || [],
          fallback: result.fallback || null,
          workspace: result.workspace || null,
          feedback: null,
        }],
        updatedAt: Date.now(),
      }));
      setRetryRequest(null);
    } catch (error) {
      if (!isCurrent() || error.name === 'AbortError') return;
      setRetryRequest({ sessionId, prompt, history, attachment: requestAttachment });
      const toastMessage = providerErrorToast(error);
      setToast({ message: toastMessage });
      const providerToFlag = providerForRequest || selectedProvider || health.provider;
      if (['openai', 'gemini', 'huggingface', 'ollama'].includes(providerToFlag)
        && [401, 403, 429, 502, 503, 504].includes(error.status)) {
        setHealth((current) => ({ ...current, warning: toastMessage }));
      }
    } finally {
      // Lifecycle cleanup is independent from response application: a stale
      // response still finishes this request, but it cannot clear a newer one.
      if (isCurrentRequestLifecycle(controllerRef.current, controller)) {
        controllerRef.current = null;
        setGenerating(false);
      }
    }
  }, [activeProject, generating, health.online, health.provider, isCurrentWorkspaceScope,
    projects, projectId, projectsLoading, projectsLoadError, readWorkspaceScope, retryRequest,
    selectedProvider, updateSession]);

  const sendMessage = useCallback(async (value = input) => {
    const rawPrompt = typeof value === 'string' ? value : '';
    const displayPrompt = attachment ? `${rawPrompt}\n\n📎 ${attachment.name}` : rawPrompt;
    const prompt = buildPromptWithAttachment(rawPrompt, attachment);
    if (!rawPrompt.trim() || generating || !activeSession) return;
    const loadingMessage = workspaceLoadingMessage(projectsLoading);
    if (loadingMessage) {
      setToast({ message: loadingMessage });
      return;
    }
    if (prompt.length > MAX_CHARS) {
      setToast({ message: `Messages must be ${MAX_CHARS.toLocaleString()} characters or fewer.` });
      return;
    }
    const history = activeSession.messages.map(({ role, content }) => ({ role, content }));
    updateSession(activeSession.id, (session) => {
      const nextMessages = [...session.messages, {
        role: 'user',
        content: displayPrompt,
        ...(attachment ? { text: rawPrompt, attachment } : {}),
      }];
      return {
        ...session,
        title: session.messages.length === 0
          ? (displayPrompt.length > 36 ? `${displayPrompt.slice(0, 36)}…` : displayPrompt)
          : session.title,
        messages: nextMessages,
        updatedAt: Date.now(),
      };
    });
    setInput('');
    setAttachment(null);
    setDiffPreview(false);
    setRetryRequest(null);
    await requestReply({ sessionId: activeSession.id, prompt: rawPrompt, history, attachment });
  }, [activeSession, attachment, generating, input, projectsLoading, requestReply, updateSession]);

  const stopGeneration = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setGenerating(false);
  };

  const createSession = useCallback(() => {
    const session = initialSession();
    setSessions((current) => [session, ...current]);
    setActiveId(session.id);
    setInput('');
    setAttachment(null);
    setDiffPreview(false);
    setToast(null);
  }, []);

  useEffect(() => {
    const handleShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        createSession();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [createSession]);

  const renameSession = (session) => {
    const title = window.prompt('Rename conversation', session.title);
    if (title?.trim()) updateSession(session.id, (current) => ({ ...current, title: title.trim() }));
  };

  const deleteSession = (sessionId) => {
    const remaining = sessions.filter((session) => session.id !== sessionId);
    if (remaining.length) {
      setSessions(remaining);
      if (sessionId === activeId) setActiveId(remaining[0].id);
    } else {
      const fresh = initialSession();
      setActiveId(fresh.id);
      setSessions([fresh]);
    }
    if (sessionId === activeId) {
      setInput('');
    }
  };

  const clearHistory = () => {
    if (!window.confirm('Clear all saved conversations? This cannot be undone.')) return;
    const fresh = initialSession();
    setSessions([fresh]);
    setActiveId(fresh.id);
    setInput('');
  };

  const openProjectDialog = () => {
    setProjectError(null);
    setProjectDialogOpen(true);
  };

  const createProject = async ({ name, path: existingPath, discoveryId } = {}) => {
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      setProjectError('Project name is required.');
      return;
    }
    const trimmedDiscoveryId = typeof discoveryId === 'string' ? discoveryId.trim() : '';
    setProjectBusy(true);
    setProjectError(null);
    const requestUserId = authRef.current?.user?.id ?? null;
    const requestScope = responseScopeKey(requestUserId, null);
    // A `let` allows the successful POST to adopt a fresh generation: that
    // invalidates any older GET already in flight before it can erase the new
    // project, while keeping this request's later steps valid.
    let requestGeneration = projectsLoadGenerationRef.current;
    const isCurrentRequest = () => isCurrentProjectCreationScope({
      authenticated: Boolean(authRef.current),
      currentUserId: authRef.current?.user?.id ?? null,
      requestUserId,
      currentGeneration: projectsLoadGenerationRef.current,
      requestGeneration,
      currentScope: projectsScopeRef.current,
      requestScope,
    });
    const requestWorkspaceScope = readWorkspaceScope(null);
    const isCurrentSession = () => isCurrentWorkspaceScope(requestWorkspaceScope, null);
    try {
      const response = await apiFetch(`${API_BASE}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          ...(trimmedDiscoveryId ? { discoveryId: trimmedDiscoveryId } : {}),
          ...(!trimmedDiscoveryId && existingPath ? { path: existingPath } : {}),
        }),
      });
      // A response belonging to an account or load generation that is no
      // longer current must be discarded without touching newer UI state.
      if (!isCurrentRequest()) return;
      if (!isCurrentSession()) return;
      const result = await response.json();
      if (!isCurrentRequest()) return;
      if (!isCurrentSession()) return;
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not add the project.');
      setProjects((current) => upsertProject(current, result.project));
      setProjectId(String(result.project.id));
      // Invalidate older project-list loads now that the POST succeeded. Their
      // stale responses will fail the generation check in loadProjects().
      projectsLoadGenerationRef.current += 1;
      requestGeneration = projectsLoadGenerationRef.current;
      projectsLoadedRef.current = true;
      projectsScopeRef.current = requestScope;
      setProjectsLoading(false);
      setProjectsLoadError(null);
      setStaleRestoredProjectId('');
      // The next scoped file load starts before React commits the new project.
      projectIdRef.current = String(result.project.id);
      persistActiveProjectId(requestUserId, String(result.project.id));
      setProjectDialogOpen(false);
      setWorkspaceTab('files');
      setWorkspaceOpen(true);
      // Selection effect owns the scan, so one open produces exactly one scan.
      // Bump the request in case the idempotent POST reopened the same project.
      setScanRequest((value) => value + 1);
      if (!isCurrentRequest()) return;
      if (!isCurrentSession()) return;
      setToast({
        message: result.existing
          ? `Project “${result.project.name}” is already in your workspace.`
          : `Project “${result.project.name}” is ready.`,
      });
    } catch (error) {
      if (isCurrentRequest() && isCurrentSession()) setProjectError(error.message);
    } finally {
      if (isCurrentRequest() && isCurrentSession()) setProjectBusy(false);
    }
  };

  const selectProject = (id) => {
    if (matchingProjectId(projects, id) === null) return;
    setProjectId(String(id));
    setStaleRestoredProjectId('');
    setWorkspaceTab('files');
    setCodeSearchResults([]);
    setScanRequest((value) => value + 1);
  };

  const resumeTask = (taskId) => {
    setFocusTaskId(taskId);
    setWorkspaceTab('tasks');
    setWorkspaceOpen(true);
  };

  const loadTasks = useCallback(async (statusFilter = taskStatusFilterRef.current, scopeProjectId = projectIdRef.current) => {
    const currentScope = () => responseScopeKey(authRef.current?.user?.id ?? null, projectIdRef.current);
    const scope = responseScopeKey(authRef.current?.user?.id ?? null, scopeProjectId);
    const requestWorkspaceScope = readWorkspaceScope(scopeProjectId);
    if (taskLoadScopeRef.current !== scope) {
      // A different account or workspace must never keep the previous list on
      // screen while the new request is in flight.
      taskLoadScopeRef.current = scope;
      setTasks([]);
      setProjectProposals([]);
      setTaskDetail(null);
    }
    const generation = ++taskLoadGenerationRef.current;
    const isCurrent = () => generation === taskLoadGenerationRef.current
      && taskLoadScopeRef.current === currentScope()
      && isCurrentWorkspaceScope(requestWorkspaceScope, scopeProjectId);

    setTaskLoading(true);
    try {
      const params = new URLSearchParams();
      if (scopeProjectId) params.set('projectId', String(scopeProjectId));
      if (statusFilter) params.set('status', statusFilter);
      params.set('limit', String(TASK_LIST_LIMIT));
      const query = params.toString();
      const response = await apiFetch(`${API_BASE}/api/tasks${query ? `?${query}` : ''}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not load tasks.');
      if (!isCurrent()) return;
      setTasks(Array.isArray(result.tasks) ? result.tasks : []);

      let proposalError = null;
      if (scopeProjectId) {
        try {
          const proposalsResponse = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(scopeProjectId)}/proposals`);
          const proposalsResult = await proposalsResponse.json();
          if (!proposalsResponse.ok || !proposalsResult.ok) {
            throw new Error(proposalsResult.error || 'Could not load pending proposals.');
          }
          if (isCurrent()) {
            setProjectProposals(Array.isArray(proposalsResult.proposals) ? proposalsResult.proposals : []);
          }
        } catch (error) {
          proposalError = error.message;
        }
      } else {
        setProjectProposals([]);
      }
      if (!isCurrent()) return;
      setTasksError(proposalError);
    } catch (error) {
      if (isCurrent()) setTasksError(error.message);
    } finally {
      if (isCurrent()) setTaskLoading(false);
    }
  }, [apiFetch, isCurrentWorkspaceScope, readWorkspaceScope]);

  // Load the authenticated workspace's tasks immediately after session
  // verification, on page reload, and whenever the selected workspace changes.
  // loadTasks is stable and ignores filter changes, so this does not duplicate
  // the explicit loads performed by the filter, Refresh, create, and decision
  // handlers.
  useEffect(() => {
    if (authChecking || !auth) return;
    loadTasks();
  }, [authChecking, auth?.token, projectId, loadTasks]);

  // `explicitProjectId` is used by proposal decisions that target a project
  // other than the one currently selected. Those requests still require the
  // same authenticated session, but must not be discarded just because the
  // selected workspace changed.
  const loadTaskDetail = useCallback(async (taskId, { explicitProjectId = null } = {}) => {
    const requestId = ++taskDetailRequestRef.current;
    const targetProjectId = String(explicitProjectId ?? projectIdRef.current ?? '');
    const scope = responseScopeKey(authRef.current?.user?.id ?? null, targetProjectId);
    const requestWorkspaceScope = readWorkspaceScope(targetProjectId);
    const isCurrent = () => requestId === taskDetailRequestRef.current
      && (explicitProjectId
        ? isCurrentWorkspaceSession(requestWorkspaceScope)
        : responseScopeKey(authRef.current?.user?.id ?? null, projectIdRef.current) === scope
          && isCurrentWorkspaceScope(requestWorkspaceScope, targetProjectId));
    try {
      const response = await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(String(taskId))}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not load task.');
      // Ignore a response for a task the user already navigated away from, or
      // for an account/project that is no longer active.
      if (!isCurrent()) return;
      setTaskDetail({
        task: result.task,
        steps: Array.isArray(result.steps) ? result.steps : [],
        proposals: Array.isArray(result.proposals) ? result.proposals : [],
      });
      setTaskDetailError(null);
    } catch (error) {
      if (isCurrent()) setTaskDetailError(error.message);
    }
  }, [apiFetch, isCurrentWorkspaceScope, isCurrentWorkspaceSession, readWorkspaceScope]);

  const loadWorkspaceFiles = async (id = projectId) => {
    const requestId = ++workspaceRequestRef.current;
    const scope = responseScopeKey(authRef.current?.user?.id ?? null, id);
    const requestWorkspaceScope = readWorkspaceScope(id);
    const isCurrent = () => requestId === workspaceRequestRef.current
      && responseScopeKey(authRef.current?.user?.id ?? null, projectIdRef.current) === scope
      && isCurrentWorkspaceScope(requestWorkspaceScope, id);
    if (!id) {
      setWorkspaceFiles([]);
      setSelectedFile(null);
      setFileContent('');
      setWorkspaceLoading(false);
      setWorkspaceScan({ status: 'idle', error: null, result: null });
      setProjectUnderstanding(null);
      return;
    }
    setWorkspaceLoading(true);
    setWorkspaceScan({ status: 'scanning', error: null, result: null });
    setProjectUnderstanding(null);
    try {
      const response = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(id)}/tree`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not scan the project.');
      if (!isCurrent()) return;
      setWorkspaceFiles(Array.isArray(result.files) ? result.files : []);
      setWorkspaceScan({ status: 'complete', error: null, result });

      // The scan already built the file index and metadata. Read only a small
      // allowlist of root instruction/manifest files through the existing
      // owner-scoped, redacting file route; failures never fail the scan.
      const readPaths = [];
      for (const filePath of projectUnderstandingPaths(result)) {
        try {
          const fileResponse = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filePath)}`);
          const fileResult = await fileResponse.json().catch(() => null);
          if (!isCurrent()) return;
          if (fileResponse.ok && fileResult?.ok && typeof fileResult.content === 'string') {
            readPaths.push(filePath);
          }
        } catch {
          // Ignore an unreadable optional document; the scan remains complete.
        }
      }
      if (isCurrent()) setProjectUnderstanding(workspaceUnderstandingSummary({ result, readPaths }));
    } catch (error) {
      if (!isCurrent()) return;
      setWorkspaceScan({ status: 'failed', error: error.message, result: null });
      setToast({ message: `Workspace scan failed: ${error.message}` });
    } finally {
      if (isCurrent()) setWorkspaceLoading(false);
    }
  };

  const openWorkspaceFile = async (filePath) => {
    if (!projectId) return;
    const requestId = ++workspaceFileRequestRef.current;
    const openedProject = projectId;
    const scope = responseScopeKey(authRef.current?.user?.id ?? null, openedProject);
    const requestWorkspaceScope = readWorkspaceScope(openedProject);
    const isCurrent = () => requestId === workspaceFileRequestRef.current
      && responseScopeKey(authRef.current?.user?.id ?? null, projectIdRef.current) === scope
      && isCurrentWorkspaceScope(requestWorkspaceScope, openedProject);
    try {
      const response = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(openedProject)}/file?path=${encodeURIComponent(filePath)}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not open file.');
      // Ignore a slow response if the user or project changed meanwhile.
      if (!isCurrent()) return;
      setSelectedFile(result.path);
      setFileContent(result.content);
    } catch (error) {
      if (isCurrent()) setToast({ message: error.message });
    }
  };

  const searchWorkspaceCode = async () => {
    if (!projectId || fileSearch.trim().length < 2) return;
    const requestId = ++searchRequestRef.current;
    const searchedProject = projectId;
    const scope = responseScopeKey(authRef.current?.user?.id ?? null, searchedProject);
    const requestWorkspaceScope = readWorkspaceScope(searchedProject);
    const isCurrent = () => requestId === searchRequestRef.current
      && responseScopeKey(authRef.current?.user?.id ?? null, projectIdRef.current) === scope
      && isCurrentWorkspaceScope(requestWorkspaceScope, searchedProject);
    try {
      const response = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(searchedProject)}/search?q=${encodeURIComponent(fileSearch.trim())}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not search project code.');
      // Drop a response that arrived after an account/project switch or a newer search.
      if (!isCurrent()) return;
      setCodeSearchResults(Array.isArray(result.results) ? result.results : []);
    } catch (error) {
      if (isCurrent()) setToast({ message: error.message });
    }
  };

  const attachCodeFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.(?:js|tsx|py|html|json)$/i.test(file.name)) {
      setToast({ message: 'Attach a .js, .tsx, .py, .html, or .json file.' });
      return;
    }
    if (file.size > 12_000) {
      setToast({ message: 'For safe prompt size, code attachments must be 12 KB or smaller.' });
      return;
    }
    try {
      const content = await file.text();
      if (content.includes('\0')) throw new Error('Binary files cannot be attached.');
      setAttachment({ name: file.name, content });
      setDiffPreview(true);
      navigator.vibrate?.(12);
    } catch (error) {
      setToast({ message: error.message || 'Could not read this attachment.' });
    }
  };

  const startVoiceInput = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setToast({ message: 'Voice input is not supported by this browser.' });
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (transcript) setInput((current) => `${current}${current ? ' ' : ''}${transcript}`);
    };
    recognition.onerror = () => setToast({ message: 'Voice recognition failed. Please try again.' });
    recognition.start();
  };

  const runQuickAction = (action) => {
    navigator.vibrate?.(10);
    sendMessage(action.prompt);
  };

  // Records the outcome of a staged file proposal in the chat transcript so the
  // Apply/Discard buttons disappear and the user sees what happened.
  const markProposal = (sessionId, messageIndex, activityIndex, proposalState) => {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message, currentIndex) => (
        currentIndex === messageIndex
          ? {
            ...message,
            toolActivity: message.toolActivity.map((activity, currentActivityIndex) => (
              currentActivityIndex === activityIndex
                ? { ...activity, proposalState }
                : activity
            )),
          }
          : message
      )),
    }));
  };

  const applyFileProposal = async (sessionId, messageIndex, activityIndex, id, proposalId) => {
    const requestProjectId = String(id ?? projectIdRef.current);
    if (!requestProjectId) return;
    const requestScope = readWorkspaceScope(requestProjectId);
    const isCurrentSession = () => isCurrentWorkspaceSession(requestScope);
    // The editor belongs to the selected workspace. The action can still be
    // finalized for its target project while the user views another project.
    const isCurrentView = () => isCurrentWorkspaceScope(requestScope);
    const originalFile = selectedFileRef.current;
    try {
      const response = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(requestProjectId)}/proposals/${encodeURIComponent(proposalId)}/apply`, {
        method: 'POST',
      });
      const result = await response.json();
      if (!isCurrentSession()) return;
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not apply the proposed file.');
      markProposal(sessionId, messageIndex, activityIndex, 'applied');
      if (!isCurrentSession()) return;
      setToast({ message: `Applied changes to ${result.file.path}.` });
      // The loader keeps its own project guard, so a different selected
      // workspace never inherits this proposal's files.
      await loadWorkspaceFiles(requestProjectId);
      if (!isCurrentSession()) return;
      const fileResponse = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(requestProjectId)}/file?path=${encodeURIComponent(result.file.path)}`);
      const fileResult = await fileResponse.json();
      if (!isCurrentSession()) return;
      if (!fileResponse.ok || !fileResult.ok) throw new Error(fileResult.error || 'Created file but could not open it.');
      if (!isCurrentSession()) return;
      // Only swap the editor when the target project is still the active view
      // and the user has not selected another file while this ran.
      if (isCurrentView() && selectedFileRef.current === originalFile) {
        setSelectedFile(fileResult.path);
        setFileContent(fileResult.content);
      }
    } catch (error) {
      if (!isCurrentSession()) return;
      setToast({ message: error.message });
    }
  };

  const discardFileProposal = async (sessionId, messageIndex, activityIndex, id, proposalId) => {
    const requestProjectId = String(id ?? projectIdRef.current);
    if (!requestProjectId) return;
    const requestScope = readWorkspaceScope(requestProjectId);
    const isCurrentSession = () => isCurrentWorkspaceSession(requestScope);
    try {
      const response = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(requestProjectId)}/proposals/${encodeURIComponent(proposalId)}/reject`, {
        method: 'POST',
      });
      const result = await response.json();
      if (!isCurrentSession()) return;
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not discard the proposed file.');
      markProposal(sessionId, messageIndex, activityIndex, 'discarded');
      if (!isCurrentSession()) return;
      setToast({ message: 'Proposal discarded. Nothing was written.' });
    } catch (error) {
      if (!isCurrentSession()) return;
      setToast({ message: error.message });
    }
  };

  const markCommandState = (sessionId, messageIndex, activityIndex, commandState) => {
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message, currentIndex) => (
        currentIndex === messageIndex
          ? {
            ...message,
            toolActivity: message.toolActivity.map((activity, currentActivityIndex) => (
              currentActivityIndex === activityIndex
                ? { ...activity, commandState }
                : activity
            )),
          }
          : message
      )),
    }));
  };

  const rejectWorkspaceCommand = async (sessionId, messageIndex, activityIndex, id, proposalId) => {
    const requestProjectId = String(id ?? projectIdRef.current);
    if (!requestProjectId) return;
    const requestScope = readWorkspaceScope(requestProjectId);
    const isCurrentSession = () => isCurrentWorkspaceSession(requestScope);
    try {
      const response = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(requestProjectId)}/proposals/${encodeURIComponent(proposalId)}/reject`, {
        method: 'POST',
      });
      const result = await response.json();
      if (!isCurrentSession()) return;
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not reject the command.');
      markCommandState(sessionId, messageIndex, activityIndex, 'rejected');
      if (!isCurrentSession()) return;
      setToast({ message: 'Command rejected. Nothing was run.' });
    } catch (error) {
      if (!isCurrentSession()) return;
      setToast({ message: error.message });
    }
  };

  const runApprovedWorkspaceCommand = async (sessionId, messageIndex, activityIndex, id, proposalId) => {
    const requestProjectId = String(id ?? projectIdRef.current);
    if (!requestProjectId) return;
    const requestScope = readWorkspaceScope(requestProjectId);
    const isCurrentSession = () => isCurrentWorkspaceSession(requestScope);
    try {
      const response = await apiFetch(`${API_BASE}/api/projects/${encodeURIComponent(requestProjectId)}/commands/${encodeURIComponent(proposalId)}/run`, {
        method: 'POST',
      });
      const result = await response.json();
      if (!isCurrentSession()) return;
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not run the approved command.');
      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message, currentIndex) => (
          currentIndex === messageIndex
            ? {
              ...message,
              toolActivity: message.toolActivity.map((activity, currentActivityIndex) => (
                currentActivityIndex === activityIndex
                  ? { ...activity, commandResult: result.result }
                  : activity
              )),
            }
            : message
        )),
      }));
      if (!isCurrentSession()) return;
    } catch (error) {
      if (!isCurrentSession()) return;
      setToast({ message: error.message });
    }
  };

  const copyMessage = async (content) => {
    try {
      await navigator.clipboard.writeText(content);
      setToast({ message: 'Message copied to clipboard.' });
    } catch (error) {
      console.error('Could not copy message to clipboard.', error);
      setToast({ message: 'Could not access the clipboard.' });
    }
  };

  const regenerate = (messageIndex) => {
    if (generating || !activeSession) return;
    const loadingMessage = workspaceLoadingMessage(projectsLoading);
    if (loadingMessage) {
      setToast({ message: loadingMessage });
      return;
    }
    let lastUserIndex = -1;
    for (let i = messageIndex - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) return;
    const lastUserMessage = messages[lastUserIndex];
    const storedAttachment = lastUserMessage.attachment || null;
    // requestReply rebuilds the attached-file prompt; passing the stored
    // attachment here is what makes regeneration keep the original context.
    const rawPrompt = typeof lastUserMessage.text === 'string'
      ? lastUserMessage.text
      : lastUserMessage.content;
    updateSession(activeSession.id, (session) => ({
      ...session,
      messages: session.messages.slice(0, lastUserIndex + 1),
    }));
    requestReply({
      sessionId: activeSession.id,
      prompt: rawPrompt,
      history: messages.slice(0, lastUserIndex).map(({ role, content }) => ({ role, content })),
      attachment: storedAttachment,
    });
  };

  const setFeedback = (index, feedback) => {
    updateSession(activeSession.id, (session) => ({
      ...session,
      messages: session.messages.map((message, messageIndex) => (
        messageIndex === index
          ? { ...message, feedback: message.feedback === feedback ? null : feedback }
          : message
      )),
    }));
  };

  const onMessageScroll = () => {
    const list = messageListRef.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    wasAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom && messages.length > 0);
  };

  const refreshTasks = useCallback(async () => { await loadTasks(); }, [loadTasks]);

  const createTask = useCallback(async () => {
    const prompt = taskInput.trim();
    const loadingMessage = workspaceLoadingMessage(projectsLoading);
    if (loadingMessage) {
      setToast({ message: loadingMessage });
      return;
    }
    if (!workspaceSelection.ready || !visibleProject) {
      setToast({ message: workspaceSelection.message || 'Select an authorized project before starting a task.' });
      return;
    }
    if (!prompt) {
      setToast({ message: 'Describe a coding task before creating it.' });
      return;
    }
    if (prompt.length > 20_000) {
      setToast({ message: 'Tasks must be 20,000 characters or fewer.' });
      return;
    }
    const requestProjectId = String(visibleProject.id);
    const requestScope = readWorkspaceScope(requestProjectId);
    const requestId = ++taskSubmitRequestRef.current;
    // The selected project, not the request's own target, decides whether the
    // response still belongs on screen. This keeps a stale task from clearing
    // the draft the user typed after switching projects.
    const isCurrent = () => isCurrentWorkspaceScope(requestScope);
    const isCurrentRequest = () => isCurrentRequestLifecycle(taskSubmitRequestRef.current, requestId);
    const requestProjectName = visibleProject.name;
    setTaskSubmitting(true);
    try {
      const response = await apiFetch(`${API_BASE}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: Number(requestProjectId), instruction: prompt }),
      });
      const result = await response.json();
      // A delayed response from a previous account or project must not clear a
      // newer draft, add a task, focus it, or show a toast in the new view.
      if (!isCurrent()) return;
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not create task.');
      setTaskInput('');
      setTasks((current) => [result.task, ...current]);
      // Preserve the original immediate cleanup: the submit button unlocks
      // before the task detail request starts.
      setTaskSubmitting(false);
      // loadTaskDetail already sets the detail; do not overwrite it with an
      // empty shell after the real response arrives.
      await loadTaskDetail(result.task.id);
      if (!isCurrent()) return;
      setFocusTaskId(result.task.id);
      setWorkspaceTab('tasks');
      setWorkspaceOpen(true);
      setToast({ message: `Task created in ${requestProjectName}.` });
    } catch (error) {
      if (!isCurrent()) return;
      setToast({ message: error.message });
    } finally {
      // Lifecycle cleanup is independent from response application. A stale
      // project switch still unlocks this submit, but cannot clear a newer one.
      if (isCurrentRequest()) setTaskSubmitting(false);
    }
  }, [isCurrentRequestLifecycle, isCurrentWorkspaceScope, projectsLoading,
    readWorkspaceScope, workspaceSelection.ready, workspaceSelection.message,
    visibleProject, taskInput, loadTaskDetail]);

  const cancelTask = useCallback(async (taskId) => {
    const requestProjectId = projectIdRef.current;
    const requestScope = readWorkspaceScope(requestProjectId);
    const isCurrent = () => isCurrentWorkspaceScope(requestScope, requestProjectId);
    try {
      const response = await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(String(taskId))}/cancel`, { method: 'POST' });
      const result = await response.json();
      if (!isCurrent()) return;
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not cancel task.');
      await loadTasks();
      if (!isCurrent()) return;
      setTaskDetail(null);
      setToast({ message: 'Task cancelled.' });
    } catch (error) {
      if (!isCurrent()) return;
      setToast({ message: error.message });
    }
  }, [isCurrentWorkspaceScope, loadTasks, readWorkspaceScope]);

  const postTaskProposalDecision = useCallback(async (task, proposal, decision) => {
    const ownedProjectId = String(task?.project_id ?? projectId ?? '');
    if (!ownedProjectId || !proposal?.proposalId) throw new Error('Proposal information is unavailable.');
    const requestScope = readWorkspaceScope(ownedProjectId);
    const isCurrentSession = () => isCurrentWorkspaceSession(requestScope);

    const encodedProject = encodeURIComponent(ownedProjectId);
    const encodedProposal = encodeURIComponent(proposal.proposalId);
    let endpoint;
    if (decision === 'reject') {
      endpoint = `/api/projects/${encodedProject}/proposals/${encodedProposal}/reject`;
    } else if (proposal.type === 'command') {
      endpoint = `/api/projects/${encodedProject}/commands/${encodedProposal}/run`;
    } else {
      endpoint = `/api/projects/${encodedProject}/proposals/${encodedProposal}/apply`;
    }

    const response = await apiFetch(`${API_BASE}${endpoint}`, { method: 'POST' });
    const result = await response.json();
    if (!isCurrentSession()) return null;
    if (!response.ok || !result.ok) {
      const error = new Error(result.error || `Could not ${decision} the proposal.`);
      error.status = response.status;
      throw error;
    }
    return result;
  }, [apiFetch, isCurrentWorkspaceSession, projectId, readWorkspaceScope]);

  const refreshAfterProposalDecision = useCallback(async (task) => {
    const workspaceId = String(task?.project_id ?? projectIdRef.current ?? '');
    const requestScope = readWorkspaceScope(workspaceId);
    const isCurrentSession = () => isCurrentWorkspaceSession(requestScope);
    const isCurrentView = () => isCurrentWorkspaceScope(requestScope);
    // Task detail is tied to the task that was acted on, not to the selected
    // tab. The loader guards it by the authenticated session.
    await loadTaskDetail(task.id, { explicitProjectId: workspaceId });
    if (!isCurrentSession() || !isCurrentView()) return;
    await loadTasks();
    if (workspaceId) await loadWorkspaceFiles(workspaceId);
  }, [isCurrentWorkspaceScope, isCurrentWorkspaceSession, loadTaskDetail,
    loadTasks, readWorkspaceScope]);

  const applyTaskProposal = useCallback(async (task, proposal) => {
    const requestProjectId = String(task?.project_id ?? projectIdRef.current ?? '');
    const requestScope = readWorkspaceScope(requestProjectId);
    const isCurrentSession = () => isCurrentWorkspaceSession(requestScope);
    try {
      const result = await postTaskProposalDecision(task, proposal, 'apply');
      if (!result || !isCurrentSession()) return;
      setToast({ message: `Applied changes to ${result.file?.path || proposal.path || 'the proposed file'}.` });
      if (!isCurrentSession()) return;
      await refreshAfterProposalDecision(task);
    } catch (error) {
      if (!isCurrentSession()) return;
      setToast({ message: error.message });
      throw error;
    }
  }, [isCurrentWorkspaceSession, postTaskProposalDecision, readWorkspaceScope,
    refreshAfterProposalDecision]);

  const rejectTaskProposal = useCallback(async (task, proposal) => {
    const requestProjectId = String(task?.project_id ?? projectIdRef.current ?? '');
    const requestScope = readWorkspaceScope(requestProjectId);
    const isCurrentSession = () => isCurrentWorkspaceSession(requestScope);
    try {
      const result = await postTaskProposalDecision(task, proposal, 'reject');
      if (!result || !isCurrentSession()) return;
      setToast({ message: 'Proposal rejected. Nothing was applied or run.' });
      if (!isCurrentSession()) return;
      await refreshAfterProposalDecision(task);
    } catch (error) {
      if (!isCurrentSession()) return;
      setToast({ message: error.message });
      throw error;
    }
  }, [isCurrentWorkspaceSession, postTaskProposalDecision, readWorkspaceScope,
    refreshAfterProposalDecision]);

  const runTaskProposal = useCallback(async (task, proposal) => {
    const requestProjectId = String(task?.project_id ?? projectIdRef.current ?? '');
    const requestScope = readWorkspaceScope(requestProjectId);
    const isCurrentSession = () => isCurrentWorkspaceSession(requestScope);
    try {
      const result = await postTaskProposalDecision(task, proposal, 'run');
      if (!result || !isCurrentSession()) return;
      const exitCode = result.result?.exitCode;
      setToast({
        message: `Command completed${Number.isFinite(exitCode) ? ` with exit code ${exitCode}` : ''}.`,
      });
      if (!isCurrentSession()) return;
      await refreshAfterProposalDecision(task);
    } catch (error) {
      if (!isCurrentSession()) return;
      setToast({ message: error.message });
      throw error;
    }
  }, [isCurrentWorkspaceSession, postTaskProposalDecision, readWorkspaceScope,
    refreshAfterProposalDecision]);

  const quickActions = useMemo(() => quickActionsFor({
    hasProject: workspaceSelection.ready,
    npmScriptsEnabled: health.npmScriptsEnabled,
    selectedFile,
  }), [workspaceSelection.ready, health.npmScriptsEnabled, selectedFile]);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  if (authChecking) {
    return (
      <div className="auth-shell auth-loading-shell">
        <div className="auth-card auth-loading">Checking your session…</div>
      </div>
    );
  }

  if (!auth) {
    return (
      <AuthScreen
        apiBase={API_BASE}
        initialError={authError}
        onAuthenticated={(token, user, expiresAt) => applyAuth({ token, user, expiresAt })}
      />
    );
  }

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      {sidebarOpen && (
        <aside className="sidebar">
          <div className="sidebar-top">
            <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
              <span className="brand-mark"><Icon name="spark" size={19} /></span>
              <span>myai<span className="brand-dot">.</span></span>
            </a>
            <button className="icon-button sidebar-hide" onClick={() => setSidebarOpen(false)} aria-label="Collapse sidebar" title="Collapse sidebar"><Icon name="panel" /></button>
          </div>
          <button className="new-chat-button" onClick={createSession}>
            <Icon name="plus" size={17} /> <span>New chat</span> <kbd>⌘ K</kbd>
          </button>

          <div className="sidebar-section-heading">
            <span>Projects</span>
            <button className="text-icon-button" onClick={openProjectDialog} title="Open existing project" aria-label="Open existing project"><Icon name="folder" size={15} /></button>
          </div>
          <div className="project-list">
            {projects.length === 0 ? (
              <button type="button" className="project-empty" onClick={openProjectDialog}>
                <span className="project-empty-icon"><Icon name="folder" size={16} /></span>
                <span>
                  <strong>Open your first project</strong>
                  <small>Choose an existing folder or create a workspace</small>
                </span>
              </button>
            ) : projects.map((project) => {
              const isActive = Boolean(visibleProject && String(project.id) === String(visibleProject.id));
              const isUnavailable = !visibleProject
                && String(project.id) === String(projectId)
                && workspaceSelection.status === 'load_error';
              return (
                <button
                  type="button"
                  key={project.id}
                  className={`project-item ${isActive ? 'active' : ''}`}
                  onClick={() => selectProject(project.id)}
                  title={project.name}
                  aria-pressed={isActive}
                >
                  <span className="project-avatar">{(project.name || '?').charAt(0).toUpperCase()}</span>
                  <span className="project-copy">
                    <strong>{project.name}</strong>
                    <small>
                      {isActive
                        ? `Active · ${workspaceScanView.status === 'scanning' ? 'Scanning' : workspaceScanView.status === 'failed' ? 'Scan failed' : workspaceScanView.status === 'complete' ? 'Scanned' : 'Preparing'}`
                        : isUnavailable ? 'Unverified — retry' : 'Switch project'}
                    </small>
                  </span>
                  {isActive && <span className="project-active-dot" aria-label="Active" />}
                </button>
              );
            })}
            {projects.length > 0 && (
              <button type="button" className="project-add" onClick={openProjectDialog}>
                <Icon name="folder" size={14} /> Open project
              </button>
            )}
          </div>

          <div className="sidebar-section-heading">
            <span>Conversations</span>
            <button className="text-icon-button" onClick={clearHistory} title="Clear history" aria-label="Clear history"><Icon name="trash" size={15} /></button>
          </div>
          <nav className="history-list" aria-label="Conversation history">
            {sortedSessions.map((session) => (
              <div key={session.id} className={`history-item ${session.id === activeId ? 'active' : ''}`}>
                <button className="history-select" onClick={() => { setActiveId(session.id); setInput(''); }}>
                  <span className="history-title">{session.title}</span>
                </button>
                <div className="history-actions">
                  <button onClick={() => renameSession(session)} aria-label={`Rename ${session.title}`} title="Rename"><Icon name="edit" size={14} /></button>
                  <button onClick={() => deleteSession(session.id)} aria-label={`Delete ${session.title}`} title="Delete"><Icon name="trash" size={14} /></button>
                </div>
              </div>
            ))}
          </nav>

          <div className="sidebar-bottom">
            <div className="profile-row">
              <span className="avatar">{(auth.user?.email || '?').charAt(0).toUpperCase()}</span>
              <span className="profile-copy">
                <span className="profile-name" title={auth.user?.email || ''}>{auth.user?.email || 'Signed in'}</span>
                <span className="profile-plan">{visibleProject ? visibleProject.name : workspaceSelection.status === 'load_error' ? 'Workspace unavailable' : 'No project selected'}</span>
              </span>
              <span className={`profile-role${auth.user?.isAdmin ? ' is-admin' : ''}`}>{auth.user?.isAdmin ? 'Admin' : 'User'}</span>
              <button type="button" className="profile-logout" onClick={signOut} title="Sign out">Sign out</button>
            </div>
          </div>
        </aside>
      )}

      <main className="main-panel">
        <div className="chat-pane">
          <header className="topbar">
            <div className="topbar-left">
              {!sidebarOpen && <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="Show sidebar"><Icon name="panel" /></button>}
              <button
                type="button"
                className="topbar-project"
                onClick={() => { setWorkspaceTab('files'); setWorkspaceOpen(true); }}
                title={visibleProject ? `Open ${visibleProject.name}` : workspaceSelection.status === 'load_error' ? 'Workspace unavailable — retry project loading' : 'Add a project'}
              >
                <span className="topbar-project-icon"><Icon name="folder" size={15} /></span>
                <span className="topbar-project-copy">
                  <small>
                    {workspaceSelection.ready
                      ? `Active · ${workspaceScanView.status === 'scanning' ? 'Scanning' : workspaceScanView.status === 'failed' ? 'Scan failed' : workspaceScanView.status === 'complete' ? 'Scanned' : 'Preparing'}`
                      : workspaceSelection.status === 'load_error' ? 'Workspace unavailable' : 'No project selected'}
                  </small>
                  <strong>{visibleProject?.name || (workspaceSelection.status === 'load_error' ? 'Workspace unavailable' : 'No project selected')}</strong>
                </span>
                <Icon name="chevron" size={14} />
              </button>
            </div>
            <div className="topbar-right">
              <div className="model-select-wrap">
                <select
                  className="model-select"
                  value={selectedProvider}
                  onChange={(event) => setSelectedProvider(event.target.value)}
                  aria-label="Select AI provider"
                  title="Choose the provider used for chat"
                >
                  {!selectedProvider && <option value="" disabled>Backend default</option>}
                  <option value="openai">OpenRouter</option>
                  <option value="gemini">Google Gemini</option>
                </select>
              </div>
              <span className={`connection-status ${health.online ? 'online' : 'offline'}`}>
                <span className="status-dot" />{health.online ? 'Online' : 'Offline'}
              </span>
              <span className="topbar-divider" />
              <button
                className="icon-button"
                onClick={() => setWorkspaceOpen((value) => !value)}
                aria-label={workspaceOpen ? 'Hide files and tasks' : 'Show files and tasks'}
                title={workspaceOpen ? 'Hide files and tasks' : 'Show files and tasks'}
              >
                <Icon name="panel" />
              </button>
              <button className="icon-button theme-toggle" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
              </button>
              <button className="topbar-new-chat" onClick={createSession}><Icon name="plus" size={16} /><span>New chat</span></button>
            </div>
          </header>

          {warningText && (
            <div className="ai-warning" role="alert">
              <span className="ai-warning-icon">!</span>
              <div className="ai-warning-content">
                <strong>{warningTitle}</strong>
                <span>{warningText}</span>
              </div>
            </div>
          )}

          <section className="conversation" ref={messageListRef} onScroll={onMessageScroll} aria-label="Conversation">
            {messages.length === 0 ? (
              <div className="welcome">
                <div className="welcome-eyebrow"><span className="eyebrow-line" /> AI CODING WORKSPACE <span className="eyebrow-line" /></div>
                <div className="welcome-orb"><Icon name="spark" size={26} /></div>
                <h1>
                  {visibleProject
                    ? <>Build in <span>{visibleProject.name}</span></>
                    : <>What are we <span>building?</span></>}
                </h1>
                <p className="welcome-description">
                  {visibleProject
                    ? 'Describe a change in plain language. The agent can inspect this project, plan the work, and ask for approval before writing or running anything.'
                    : workspaceSelection.status === 'load_error'
                      ? 'The last project check failed. Retry to verify your workspace before asking the agent to inspect files.'
                      : 'Open an existing project to give the agent a workspace, or ask a general question below. Files stay isolated to the project you choose.'}
                </p>

                {visibleProject ? (
                  <div className="welcome-project">
                    <span className="welcome-project-icon"><Icon name="folder" size={16} /></span>
                    <div>
                      <small>Agent is working in</small>
                      <strong>{visibleProject.name}</strong>
                      <span className="welcome-project-scan">{workspaceScanView.message}</span>
                      {projectUnderstanding && (
                        <span className="welcome-project-understanding">{projectUnderstanding}</span>
                      )}
                    </div>
                    <button type="button" onClick={() => { setWorkspaceTab('files'); setWorkspaceOpen(true); }}>View files</button>
                  </div>
                ) : (
                  <div className="welcome-actions">
                    <button type="button" className="primary-button" onClick={openProjectDialog}><Icon name="folder" size={15} /> Open existing project</button>
                    <span>{workspaceSelection.status === 'load_error' ? 'use Retry above to verify the saved workspace, or ask a general question' : 'or switch to “New workspace” in the dialog'}</span>
                  </div>
                )}

                <div className="starter-grid">
                  {(visibleProject && workspaceSelection.ready ? starters : []).map((starter) => (
                    <button key={starter.title} className="starter-card" onClick={() => sendMessage(starter.prompt)}>
                      <span className="starter-icon">{starter.icon}</span>
                      <span className="starter-title">{starter.title}</span>
                      <span className="starter-prompt">{starter.hint}</span>
                      <span className="starter-arrow"><Icon name="chevron" size={15} /></span>
                    </button>
                  ))}
                </div>

                {tasks.length > 0 && (
                  <div className="recent-tasks">
                    <div className="recent-tasks-head">
                      <span>Recent tasks</span>
                      <button type="button" onClick={() => { setWorkspaceTab('tasks'); setWorkspaceOpen(true); }}>View all</button>
                    </div>
                    {tasks.slice(0, 3).map((task) => (
                      <button type="button" key={task.id} className="recent-task" onClick={() => resumeTask(task.id)}>
                        <span className={`recent-task-dot ${statusBadgeClass(task.status)}`} />
                        <span className="recent-task-title">{task.instruction}</span>
                        <span className="recent-task-status">{String(task.status || '').replaceAll('_', ' ')}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="message-thread">
                {messages.map((message, index) => (
                  <Message
                    key={`${activeId}-${index}`}
                    message={message}
                    index={index}
                    sessionId={activeId}
                    onCopy={copyMessage}
                    onRegenerate={regenerate}
                    onFeedback={setFeedback}
                    onApplyProposal={applyFileProposal}
                    onDiscardProposal={discardFileProposal}
                    onRunCommand={runApprovedWorkspaceCommand}
                    onRejectCommand={rejectWorkspaceCommand}
                  />
                ))}
                {generating && (
                  <div className="message-row assistant-row thinking-row">
                    <div className="assistant-mark"><Icon name="spark" size={15} /></div>
                    <div className="thinking-indicator" aria-label="Assistant is thinking"><span /><span /><span /></div>
                  </div>
                )}
              </div>
            )}
            <div ref={bottomRef} className="scroll-anchor" />
          </section>

          {showScrollButton && (
            <button
              className="scroll-bottom-button"
              onClick={() => {
                wasAtBottomRef.current = true;
                bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
              }}
            >
              <Icon name="arrowDown" size={15} /> Scroll to bottom
            </button>
          )}

          <div className="composer-dock">
            {workspaceSelection.message && (
              <div className="tool-activity" aria-label="Workspace selection status">
                <span className={`tool-activity-item ${workspaceSelection.ready ? 'completed' : workspaceSelection.status === 'loading' ? 'running' : 'failed'}`}>
                  {workspaceSelection.message}
                  {workspaceSelection.status === 'load_error' && (
                    <button type="button" onClick={loadProjects}>Retry</button>
                  )}
                </span>
              </div>
            )}
            {toast && (
              <div className="toast" role="status">
                <span className="toast-message">{toast.message}</span>
                {retryRequest && <button onClick={() => requestReply(retryRequest)}>Retry</button>}
                <button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss notification">×</button>
              </div>
            )}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                sendMessage();
              }}
            >
              {attachment && (
                <div className="attachment-chip">
                  <span>📎 {attachment.name}</span>
                  <button type="button" onClick={() => { setAttachment(null); setDiffPreview(false); }} aria-label="Remove attachment">×</button>
                  <button type="button" onClick={() => setDiffPreview((current) => !current)} aria-label="Toggle attached code preview">
                    {diffPreview ? 'Hide preview' : 'Preview'}
                  </button>
                </div>
              )}
              {diffPreview && attachment && (
                <div className="attachment-preview">
                  <strong>Attached source preview</strong>
                  <pre><code>{attachment.content}</code></pre>
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={visibleProject
                  ? `Describe what to build or change in ${visibleProject.name}…`
                  : workspaceSelection.status === 'load_error'
                    ? 'Workspace unavailable — retry project loading, or ask a general question…'
                    : 'Ask anything, or add a project to start coding…'}
                rows={1}
                aria-label="Message"
              />
              <input
                ref={attachmentInputRef}
                className="visually-hidden"
                type="file"
                accept=".js,.tsx,.py,.html,.json,text/javascript,application/json,text/html,text/x-python"
                onChange={attachCodeFile}
                aria-label="Attach source file"
              />
              <div className="composer-bottom">
                <div className="composer-actions">
                  <button type="button" className="composer-tool-button" onClick={() => attachmentInputRef.current?.click()} aria-label="Attach file or code">📎 Attach</button>
                  <button type="button" className="composer-tool-button voice-button" onClick={startVoiceInput} aria-label="Start voice dictation">🎙 Voice</button>
                </div>
                <span className="composer-hint"><kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>
                <div className="composer-tools">
                  <span className={`token-counter ${input.length > MAX_CHARS * 0.9 ? 'near-limit' : ''}`}>{input.length.toLocaleString()} / {MAX_CHARS.toLocaleString()} <span className="token-estimate">· ~{tokenEstimate} tokens</span></span>
                  {generating ? (
                    <button className="send-button stop-button" type="button" onClick={stopGeneration} aria-label="Stop generating" title="Stop generating"><Icon name="stop" size={15} /><span>Stop generating</span></button>
                  ) : (
                    <button className="send-button" type="submit" disabled={!input.trim() || input.length > MAX_CHARS || !health.online} aria-label="Send message" title="Send message"><Icon name="send" size={16} /></button>
                  )}
                </div>
              </div>
            </form>
            {visibleProject && workspaceSelection.ready && (
              <div className="quick-actions" aria-label="Quick actions">
                {quickActions.map((action) => (
                  <button key={action.label} type="button" onClick={() => runQuickAction(action)}>{action.label}</button>
                ))}
              </div>
            )}
            <p className="disclaimer">MyAI can make mistakes. Review changes before approving them.</p>
          </div>
        </div>

        {workspaceOpen && (
          <button type="button" className="dock-backdrop" onClick={() => setWorkspaceOpen(false)} aria-label="Close workspace panel" />
        )}
        <aside className={`workspace-dock ${workspaceOpen ? '' : 'closed'}`} aria-label="Workspace panel">
          <header className="workspace-dock-head">
            <div className="workspace-tabs" role="tablist" aria-label="Workspace view">
              <button
                type="button"
                role="tab"
                aria-selected={workspaceTab === 'files'}
                className={workspaceTab === 'files' ? 'active' : ''}
                onClick={() => setWorkspaceTab('files')}
              >
                Files
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={workspaceTab === 'tasks'}
                className={workspaceTab === 'tasks' ? 'active' : ''}
                onClick={() => setWorkspaceTab('tasks')}
              >
                Tasks
                {waitingTaskCount > 0 && <span className="tab-badge">{waitingTaskCount}</span>}
              </button>
            </div>
            <button type="button" className="icon-button" onClick={() => setWorkspaceOpen(false)} aria-label="Close workspace panel" title="Close panel">×</button>
          </header>
          <div className="workspace-dock-body">
            {workspaceTab === 'files' ? (
              <WorkspaceFiles
                project={visibleProject}
                files={workspaceFiles}
                selectedFile={selectedFile}
                content={fileContent}
                search={fileSearch}
                onSearchChange={setFileSearch}
                onSearch={searchWorkspaceCode}
                results={codeSearchResults}
                onOpenFile={openWorkspaceFile}
                onRefresh={() => loadWorkspaceFiles()}
                onNewProject={openProjectDialog}
                loading={workspaceLoading}
                scan={workspaceScanView}
              />
            ) : (
              <TaskCenter
                projectId={visibleProject?.id ?? ''}
                activeProjectName={visibleProject?.name || ''}
                taskInput={taskInput}
                setTaskInput={setTaskInput}
                taskSubmitting={taskSubmitting}
                createTask={createTask}
                tasks={tasks}
                setTasks={setTasks}
                projectProposals={projectProposals}
                taskStatusFilter={taskStatusFilter}
                setTaskStatusFilter={setTaskStatusFilter}
                tasksError={tasksError}
                taskLoading={taskLoading}
                loadTasks={loadTasks}
                loadTaskDetail={loadTaskDetail}
                setTaskDetail={setTaskDetail}
                taskDetail={taskDetail}
                taskDetailError={taskDetailError}
                cancelTask={cancelTask}
                refreshTasks={refreshTasks}
                applyTaskProposal={applyTaskProposal}
                rejectTaskProposal={rejectTaskProposal}
                runTaskProposal={runTaskProposal}
                focusTaskId={focusTaskId}
                onFocusTask={() => setFocusTaskId(null)}
                onNewProject={openProjectDialog}
                hasProjects={projects.length > 0}
              />
            )}
          </div>
        </aside>
      </main>

      <ProjectDialog
        open={projectDialogOpen}
        onClose={() => {
          if (projectBusy) return;
          setProjectDialogOpen(false);
          setProjectError(null);
        }}
        onCreate={createProject}
        apiFetch={apiFetch}
        apiBase={API_BASE}
        busy={projectBusy}
        error={projectError}
      />
    </div>
  );
}

export default App;

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import TaskCenter from './TaskCenter';

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

[
  ['javascript', javascript],
  ['typescript', typescript],
  ['python', python],
  ['json', json],
  ['bash', bash],
  ['css', css],
  ['xml', xml],
  ['sql', sql],
].forEach(([name, language]) => hljs.registerLanguage(name, language));

const STORAGE_KEY = 'myai.chat-sessions.v1';
const THEME_KEY = 'myai.theme';
const MAX_CHARS = 20_000;

const starters = [
  { icon: '⚡', title: 'Generate code', prompt: 'Write a small, well-documented utility function for a common programming task.' },
  { icon: '⌕', title: 'Debug & fix', prompt: 'I’m seeing an unexpected bug. Help me identify the likely cause and suggest a practical fix.' },
  { icon: '▤', title: 'Explain a concept', prompt: 'Explain a technical concept clearly, with a practical example.' },
  { icon: '✳', title: 'Brainstorm ideas', prompt: 'Help me brainstorm a few creative ideas for a project I’m working on.' },
];

const initialSession = () => ({
  id: crypto.randomUUID(),
  title: 'New conversation',
  messages: [],
  updatedAt: Date.now(),
});

function readSessions() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
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

function CodeViewer({ content, filePath }) {
  const extension = filePath?.split('.').pop()?.toLowerCase();
  const language = ({
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    json: 'json',
    html: 'xml',
    htm: 'xml',
    css: 'css',
    sql: 'sql',
  })[extension];
  const highlighted = language
    ? hljs.highlight(content, { language, ignoreIllegals: true }).value
    : hljs.highlightAuto(content).value;
  return <pre><code className={language ? `language-${language}` : undefined} dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>;
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

function Message({ message, index, sessionId, onCopy, onRegenerate, onFeedback, onApplyProposal, onDiscardProposal, onRunCommand }) {
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
        {message.toolActivity?.length > 0 && (
          <div className="tool-activity" aria-label="Agent actions">
            {message.toolActivity.map((activity, activityIndex) => {
              const status = TOOL_STATUS_VIEW[activity.status] || TOOL_STATUS_VIEW.running;
              return (
              <div key={`${activity.tool}-${activityIndex}`} className="tool-activity-group">
                <span className={`tool-activity-item ${status.className}`}>
                  {status.icon} {activity.tool} · {status.label}{activity.reused ? ' · reused previous result' : ''}
                </span>
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
                    <span>Command approval required: <code>{activity.commandApproval.command}</code></span>
                    {!activity.commandResult && (
                      <button onClick={() => onRunCommand(sessionId, index, activityIndex, activity.projectId, activity.commandApproval.proposalId)}>
                        Run approved command
                      </button>
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
  const [initialData] = useState(() => {
    const restoredSessions = readSessions();
    return { sessions: restoredSessions, activeId: restoredSessions[0].id };
  });
  const [sessions, setSessions] = useState(initialData.sessions);
  const [activeId, setActiveId] = useState(initialData.activeId);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia('(max-width: 560px)').matches);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark');
  const [health, setHealth] = useState({
    online: false,
    provider: null,
    providerLabel: null,
    warning: 'Checking AI provider configuration…',
  });
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [toast, setToast] = useState(null);
  const [retryRequest, setRetryRequest] = useState(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [fileSearch, setFileSearch] = useState('');
  const [codeSearchResults, setCodeSearchResults] = useState([]);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [taskInput, setTaskInput] = useState('');
  const [tasks, setTasks] = useState([]);
  const [tasksError, setTasksError] = useState(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [taskDetail, setTaskDetail] = useState(null);
  const [taskDetailError, setTaskDetailError] = useState(null);
  const [taskPollInterval, setTaskPollInterval] = useState(null);
  const [attachment, setAttachment] = useState(null);
  const [diffPreview, setDiffPreview] = useState(false);
  const messageListRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const controllerRef = useRef(null);
  const wasAtBottomRef = useRef(true);
  const activeSession = sessions.find((session) => session.id === activeId) || sessions[0];
  const messages = activeSession?.messages || [];
  const tokenEstimate = Math.ceil(input.length / 4);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (error) {
      console.warn('Could not save conversations in this browser.', error);
    }
  }, [sessions]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const checkHealth = async () => {
      try {
        const response = await fetch('/api/health');
        if (!response.ok) throw new Error(`Health check returned ${response.status}`);
        const data = await response.json();
        if (!cancelled) {
          setHealth({
            online: true,
            provider: data.aiProvider || 'mock',
            providerLabel: data.providerLabel || null,
            warning: data.aiWarning || null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setHealth({
            online: false,
            provider: null,
            providerLabel: null,
            warning: 'Cannot reach the AI server. Start or restart the backend and try again.',
          });
        }
      }
    };
    const loadProjects = async () => {
      try {
        const response = await fetch('/api/projects');
        if (!response.ok) throw new Error(`Projects request returned ${response.status}`);
        const data = await response.json();
        if (!cancelled) setProjects(Array.isArray(data.projects) ? data.projects : []);
      } catch (error) {
        console.warn('Could not load projects.', error);
      }
    };
    checkHealth();
    loadProjects();
    const timer = window.setInterval(checkHealth, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    loadWorkspaceFiles(projectId);
  }, [projectId]);

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

  const requestReply = useCallback(async ({ sessionId, prompt, history }) => {
    if (generating) return;
    if (!health.online) {
      setRetryRequest({ sessionId, prompt, history });
      setToast({ message: 'The API is offline. Check that the server is running, then retry.' });
      return;
    }
    setGenerating(true);
    setToast(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          messages: [...history, { role: 'user', content: prompt }],
          ...(projectId ? { projectId: Number(projectId) } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        const error = new Error(result.error || `Request failed (${response.status})`);
        error.status = response.status;
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
          feedback: null,
        }],
        updatedAt: Date.now(),
      }));
      setRetryRequest(null);
    } catch (error) {
      if (error.name === 'AbortError') return;
      setRetryRequest({ sessionId, prompt, history });
      setToast({ message: error.message || 'Something went wrong. Please try again.' });
      if (['openai', 'gemini', 'huggingface', 'ollama'].includes(health.provider)
        && [401, 403, 429, 502, 503, 504].includes(error.status)) {
        setHealth((current) => ({ ...current, warning: error.message }));
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setGenerating(false);
      }
    }
  }, [generating, health.online, health.provider, projectId, updateSession]);

  const sendMessage = useCallback(async (value = input) => {
    const displayPrompt = attachment ? `${value}\n\n📎 ${attachment.name}` : value;
    const prompt = attachment
      ? `${value}\n\nReview the attached source file "${attachment.name}":\n\`\`\`\n${attachment.content}\n\`\`\``
      : value;
    if (!prompt.trim() || generating || !activeSession) return;
    if (prompt.length > MAX_CHARS) {
      setToast({ message: `Messages must be ${MAX_CHARS.toLocaleString()} characters or fewer.` });
      return;
    }
    const history = activeSession.messages.map(({ role, content }) => ({ role, content }));
    updateSession(activeSession.id, (session) => {
      const nextMessages = [...session.messages, { role: 'user', content: displayPrompt }];
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
    await requestReply({ sessionId: activeSession.id, prompt, history });
  }, [activeSession, attachment, generating, input, requestReply, updateSession]);

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

  const createProject = async () => {
    const name = window.prompt('Name your workspace');
    if (!name?.trim()) return;
    const existingPath = window.prompt('Optional: enter the full path of an existing project folder on this PC. Leave blank to create a new workspace.');
    if (existingPath === null) return;
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          ...(existingPath.trim() ? { path: existingPath.trim() } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not create workspace.');
      setProjects((current) => [result.project, ...current]);
      setProjectId(String(result.project.id));
      await loadWorkspaceFiles(String(result.project.id));
      setToast({ message: `Workspace “${result.project.name}” created.` });
    } catch (error) {
      setToast({ message: error.message });
    }
  };

  const loadTasks = useCallback(async () => {
    setTaskLoading(true);
    try {
      const url = `/api/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`;
      const response = await fetch(url);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not load tasks.');
      setTasks(Array.isArray(result.tasks) ? result.tasks : []);
      setTasksError(null);
    } catch (error) {
      setTasksError(error.message);
    } finally {
      setTaskLoading(false);
    }
  }, [projectId]);

  const loadTaskDetail = useCallback(async (taskId) => {
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(String(taskId))}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not load task.');
      setTaskDetail({ task: result.task, steps: Array.isArray(result.steps) ? result.steps : [] });
      setTaskDetailError(null);
    } catch (error) {
      setTaskDetailError(error.message);
    }
  }, []);

  const loadWorkspaceFiles = async (id = projectId) => {
    if (!id) {
      setWorkspaceFiles([]);
      setSelectedFile(null);
      setFileContent('');
      return;
    }
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}/tree`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not scan the project.');
      setWorkspaceFiles(result.files);
    } catch (error) {
      setToast({ message: error.message });
    }
  };

  const openWorkspaceFile = async (filePath) => {
    if (!projectId) return;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not open file.');
      setSelectedFile(result.path);
      setFileContent(result.content);
    } catch (error) {
      setToast({ message: error.message });
    }
  };

  const searchWorkspaceCode = async () => {
    if (!projectId || fileSearch.trim().length < 2) return;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/search?q=${encodeURIComponent(fileSearch.trim())}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not search project code.');
      setCodeSearchResults(result.results);
    } catch (error) {
      setToast({ message: error.message });
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
    const prompt = action === 'Run Tests'
      ? 'Inspect this project, run its tests using the safe npm test tool, and fix any failing test if appropriate.'
      : action === 'Explain Code'
        ? `Explain the selected file ${selectedFile || '(no file selected)'}. Inspect it first if a workspace is selected.`
        : `Inspect the project formatter and format ${selectedFile || 'the project'} using only the safe npm_format tool if available.`;
    sendMessage(prompt);
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
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/apply`, {
        method: 'POST',
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not apply the proposed file.');
      markProposal(sessionId, messageIndex, activityIndex, 'applied');
      setToast({ message: `Applied changes to ${result.file.path}.` });
      await loadWorkspaceFiles(String(id));
      const fileResponse = await fetch(`/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(result.file.path)}`);
      const fileResult = await fileResponse.json();
      if (!fileResponse.ok || !fileResult.ok) throw new Error(fileResult.error || 'Created file but could not open it.');
      setProjectId(String(id));
      setSelectedFile(fileResult.path);
      setFileContent(fileResult.content);
    } catch (error) {
      setToast({ message: error.message });
    }
  };

  const discardFileProposal = async (sessionId, messageIndex, activityIndex, id, proposalId) => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}/reject`, {
        method: 'POST',
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not discard the proposed file.');
      markProposal(sessionId, messageIndex, activityIndex, 'discarded');
      setToast({ message: 'Proposal discarded. Nothing was written.' });
    } catch (error) {
      setToast({ message: error.message });
    }
  };

  const runApprovedWorkspaceCommand = async (sessionId, messageIndex, activityIndex, id, proposalId) => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}/commands/${encodeURIComponent(proposalId)}/run`, {
        method: 'POST',
      });
      const result = await response.json();
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
    } catch (error) {
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
    let lastUserIndex = -1;
    for (let i = messageIndex - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      messages: session.messages.slice(0, lastUserIndex + 1),
    }));
    requestReply({
      sessionId: activeSession.id,
      prompt: messages[lastUserIndex].content,
      history: messages.slice(0, lastUserIndex).map(({ role, content }) => ({ role, content })),
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
    if (!prompt) {
      setToast({ message: 'Describe a coding task before creating it.' });
      return;
    }
    if (prompt.length > 20_000) {
      setToast({ message: 'Tasks must be 20,000 characters or fewer.' });
      return;
    }
    setTaskSubmitting(true);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: projectId ? Number(projectId) : undefined, instruction: prompt }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not create task.');
      setTaskInput('');
      setTaskSubmitting(false);
      setTasks((current) => [result.task, ...current]);
      await loadTaskDetail(result.task.id);
      setTaskDetail({ task: result.task, steps: [] });
      setTaskCenterOpen(true);
      setToast({ message: 'Task created.' });
    } catch (error) {
      setTaskSubmitting(false);
      setToast({ message: error.message });
    }
  }, [projectId, taskInput, loadTasks, loadTaskDetail]);

  const cancelTask = useCallback(async (taskId) => {
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(String(taskId))}/cancel`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not cancel task.');
      await loadTasks();
      setTaskDetail(null);
      setToast({ message: 'Task cancelled.' });
    } catch (error) {
      setToast({ message: error.message });
    }
  }, [loadTasks]);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

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
            <span>Recent</span>
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
            <div className="workspace-label"><Icon name="folder" size={15} /><span>Workspace</span></div>
            <div className="workspace-controls">
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label="Select project workspace">
                <option value="">Personal workspace</option>
                {projects.map((project) => <option key={project.id} value={String(project.id)}>{project.name}</option>)}
              </select>
              <button className="icon-button workspace-add" onClick={createProject} title="Create workspace" aria-label="Create workspace"><Icon name="plus" size={16} /></button>
            </div>
            <div className="profile-row">
              <span className="avatar">M</span>
              <span className="profile-name">My workspace</span>
              <span className="profile-plan">Personal</span>
            </div>
          </div>
        </aside>
      )}

      <main className="main-panel">
        <div className="chat-pane">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="Show sidebar"><Icon name="panel" /></button>}
            <div className="model-select-wrap">
              <select
                className="model-select"
                value={health.provider || 'mock'}
                disabled
                aria-label="Configured AI provider"
              >
                <option value="mock">MyAI · Offline fallback</option>
                <option value="openai">OpenAI · Configured in .env</option>
                <option value="anthropic">Anthropic · Not implemented</option>
                <option value="gemini">Gemini · Configured in .env</option>
                <option value="huggingface">Hugging Face · Configured in .env</option>
                <option value="ollama">Ollama · Local model</option>
              </select>
            </div>
          </div>
          <div className="topbar-right">
            <span className={`connection-status ${health.online ? 'online' : 'offline'}`}>
              <span className="status-dot" />{health.online ? 'Online' : 'Offline'}
            </span>
            <span className="topbar-divider" />
            <button className="icon-button theme-toggle" onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button className="topbar-new-chat" onClick={createSession}><Icon name="plus" size={16} /><span>New chat</span></button>
          </div>
        </header>

        {health.warning && (
          <div className="ai-warning" role="alert">
            <span className="ai-warning-icon">!</span>
            <div className="ai-warning-content">
              <strong>{health.providerLabel
                ? `${health.providerLabel} needs attention`
                : health.provider === 'openai'
                  ? 'OpenAI needs attention'
                  : health.provider === 'huggingface'
                    ? 'Hugging Face needs attention'
                    : 'AI provider status'}</strong>
              <span>{health.warning}</span>
            </div>
          </div>
        )}

        <section className="conversation" ref={messageListRef} onScroll={onMessageScroll} aria-label="Conversation">
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-eyebrow"><span className="eyebrow-line" /> YOUR AI WORKSPACE <span className="eyebrow-line" /></div>
              <div className="welcome-orb"><Icon name="spark" size={26} /></div>
              <h1>What can I help you<br /><span>work through?</span></h1>
              <p className="welcome-description">A thoughtful space to build, explore, and figure things out.</p>
              <div className="starter-grid">
                {starters.map((starter) => (
                  <button key={starter.title} className="starter-card" onClick={() => sendMessage(starter.prompt)}>
                    <span className="starter-icon">{starter.icon}</span>
                    <span className="starter-title">{starter.title}</span>
                    <span className="starter-prompt">{starter.prompt.replace(/: ?$/, '')}</span>
                    <span className="starter-arrow"><Icon name="chevron" size={15} /></span>
                  </button>
                ))}
              </div>
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
              placeholder="Message MyAI…"
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
          <div className="quick-actions" aria-label="Quick actions">
            {['Run Tests', 'Format Code', 'Explain Code'].map((action) => (
              <button key={action} type="button" onClick={() => runQuickAction(action)}>{action}</button>
            ))}
          </div>
          <p className="disclaimer">MyAI can make mistakes. Check important information.</p>
        </div>
        <TaskCenter
          projectId={projectId}
          taskInput={taskInput}
          setTaskInput={setTaskInput}
          taskSubmitting={taskSubmitting}
          createTask={createTask}
          tasks={tasks}
          setTasks={setTasks}
          tasksError={tasksError}
          taskLoading={taskLoading}
          loadTasks={loadTasks}
          loadTaskDetail={loadTaskDetail}
          setTaskDetail={setTaskDetail}
          taskDetail={taskDetail}
          taskDetailError={taskDetailError}
          cancelTask={cancelTask}
          refreshTasks={refreshTasks}
        />
        </div>
      </main>
    </div>
  );
}

export default App;

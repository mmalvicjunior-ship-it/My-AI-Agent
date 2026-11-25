import React, { useCallback, useEffect, useRef, useState } from 'react';
import { discoveredProjectRows } from './workspaceUiHelpers.js';

/**
 * Project picker. Ordinary users choose a discovered project; the server maps
 * the opaque discovery ID back to an authorized directory and revalidates all
 * path boundaries. "New workspace" remains available as a secondary option.
 */
export default function ProjectDialog({
  open,
  onClose,
  onCreate,
  apiFetch,
  apiBase = '',
  busy = false,
  error = null,
}) {
  const [mode, setMode] = useState('discover');
  const [name, setName] = useState('');
  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [discoveryError, setDiscoveryError] = useState(null);
  const [configurationHint, setConfigurationHint] = useState(null);
  const [loading, setLoading] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [localError, setLocalError] = useState(null);
  const dialogRef = useRef(null);
  const nameRef = useRef(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setDiscoveryError(null);
    setConfigurationHint(null);
    try {
      const response = await apiFetch(`${apiBase}/api/projects/discover`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        const code = data?.code;
        if (code === 'DISCOVERY_NOT_CONFIGURED' || code === 'IMPORT_DISABLED' || code === 'IMPORT_UNSAFE') {
          setConfigurationHint(data?.error || 'Project discovery is not configured on this server.');
        }
        throw new Error(data?.error || 'Could not discover projects on the server.');
      }
      const rows = discoveredProjectRows(data.projects);
      setProjects(rows);
      setSelected((current) => rows.find((row) => row.discoveryId === current?.discoveryId) || null);
      setConfigurationHint(null);
    } catch (discoveryFailure) {
      setProjects([]);
      setSelected(null);
      setDiscoveryError(discoveryFailure.message);
    } finally {
      setLoading(false);
    }
  }, [apiBase, apiFetch]);

  useEffect(() => {
    if (!open) return;
    setMode('discover');
    setName('');
    setProjects([]);
    setSelected(null);
    setDiscoveryError(null);
    setConfigurationHint(null);
    setLoading(false);
    setAttempted(false);
    setLocalError(null);
  }, [open]);

  useEffect(() => {
    if (!open || attempted) return;
    setAttempted(true);
    loadProjects();
  }, [open, attempted, loadProjects]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;
    return () => {
      if (previouslyFocused?.isConnected && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    if (mode === 'new') {
      const timer = window.setTimeout(() => nameRef.current?.focus(), 30);
      return () => window.clearTimeout(timer);
    }
    dialogRef.current?.focus();
    return undefined;
  }, [open, mode]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Tab') return;
      const container = dialogRef.current;
      if (!container) return;
      const focusables = [...container.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!container.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, mode, busy]);

  if (!open) return null;

  const openSelectedProject = () => {
    if (!selected) {
      setLocalError('Choose a project to open.');
      return;
    }
    setLocalError(null);
    onCreate({ name: selected.name, discoveryId: selected.discoveryId });
  };

  const submitNewWorkspace = (event) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError('Give the workspace a name.');
      return;
    }
    setLocalError(null);
    onCreate({ name: trimmedName });
  };

  const message = localError || error;

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div
        className="project-dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
      >
        <header className="dialog-head">
          <div>
            <span className="dialog-eyebrow">Workspace</span>
            <h2 id="project-dialog-title">Open a project</h2>
            <p>Choose a project and let your agent understand its codebase.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </header>

        {mode === 'discover' ? (
          <div className="dialog-form">
            <div className="discovery-toolbar">
              <span>{loading ? 'Finding projects…' : projects.length ? `${projects.length} project${projects.length === 1 ? '' : 's'} found` : 'No projects found yet'}</span>
              <button type="button" className="ghost-button" onClick={loadProjects} disabled={busy || loading}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {configurationHint && (
              <div className="dialog-hint dialog-hint-warn">
                {configurationHint}
                <span>Ask an administrator to set PROJECT_IMPORT_ROOT to a dedicated folder containing projects.</span>
              </div>
            )}
            {!configurationHint && discoveryError && <div className="dialog-error" role="alert">{discoveryError}</div>}

            <div className="discovery-list">
              {loading && <div className="discovery-empty">Looking for likely projects on the server…</div>}
              {!loading && projects.length === 0 && !configurationHint && !discoveryError && (
                <div className="discovery-empty">
                  <strong>No projects found</strong>
                  <span>Place a project folder in the server’s authorized directory, then refresh.</span>
                </div>
              )}
              {!loading && projects.map((project) => (
                <button
                  type="button"
                  key={project.discoveryId}
                  className={`discovery-row ${selected?.discoveryId === project.discoveryId ? 'selected' : ''}`}
                  aria-pressed={selected?.discoveryId === project.discoveryId}
                  onClick={() => { setSelected(project); setLocalError(null); }}
                  disabled={busy}
                >
                  <span className="discovery-row-main">
                    <span className="discovery-name">{project.name}</span>
                    <span className="discovery-description">{project.description}</span>
                  </span>
                  <span className="discovery-row-meta">
                    {project.technologies.length > 0 && (
                      <span className="discovery-technologies">
                        {project.technologies.slice(0, 3).map((technology) => (
                          <span key={technology} className="discovery-badge">{technology}</span>
                        ))}
                      </span>
                    )}
                    {project.alreadyOpenedProjectId !== null && <span className="discovery-opened">Opened</span>}
                  </span>
                </button>
              ))}
            </div>

            {message && <div className="dialog-error" role="alert">{message}</div>}

            <div className="dialog-secondary-option">
              <button type="button" className="text-icon-button" onClick={() => { setMode('new'); setLocalError(null); }}>
                New workspace
              </button>
              <span>Create an empty managed workspace instead.</span>
            </div>

            <footer className="dialog-actions">
              <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="primary-button" onClick={openSelectedProject} disabled={busy || loading || !selected}>
                {busy ? 'Opening…' : 'Open project'}
              </button>
            </footer>
          </div>
        ) : (
          <form className="dialog-form" onSubmit={submitNewWorkspace}>
            <label className="dialog-field">
              <span>Workspace name</span>
              <input
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Portfolio site"
                maxLength={120}
                disabled={busy}
              />
            </label>
            <div className="dialog-hint">
              The agent gets a new isolated folder under the managed workspace root.
            </div>
            {message && <div className="dialog-error" role="alert">{message}</div>}
            <footer className="dialog-actions">
              <button type="button" className="ghost-button" onClick={() => { setMode('discover'); setLocalError(null); }} disabled={busy}>
                Back to projects
              </button>
              <button type="submit" className="primary-button" disabled={busy}>
                {busy ? 'Creating…' : 'Create workspace'}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}

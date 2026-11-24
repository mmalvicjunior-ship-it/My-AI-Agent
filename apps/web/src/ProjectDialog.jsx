import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Project creation dialog.
 *
 * Two safe paths. "Existing folder" is the default because opening a project
 * the user already has is the normal starting point:
 *  - "Existing folder": the user picks a directory through the server's
 *    read-only browser, which only lists folders inside PROJECT_IMPORT_ROOT.
 *  - "New workspace": the server creates an isolated folder under WORKSPACE_ROOT.
 *
 * Nothing here bypasses the server's path checks; the dialog only makes the
 * existing validation understandable.
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
  const [mode, setMode] = useState('existing');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [browse, setBrowse] = useState(null);
  const [browseError, setBrowseError] = useState(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseAttempted, setBrowseAttempted] = useState(false);
  const [localError, setLocalError] = useState(null);
  const nameRef = useRef(null);

  const loadFolder = useCallback(async (target) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const query = target ? `?path=${encodeURIComponent(target)}` : '';
      const response = await apiFetch(`${apiBase}/api/projects/browse${query}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || 'Could not browse folders on the server.');
      }
      setBrowse(data);
      setFolder(data.path);
    } catch (browseFailure) {
      setBrowse(null);
      setBrowseError(browseFailure.message);
    } finally {
      setBrowseLoading(false);
    }
  }, [apiBase, apiFetch]);

  useEffect(() => {
    if (!open) return;
    setMode('existing');
    setName('');
    setFolder('');
    setBrowse(null);
    setBrowseError(null);
    setBrowseAttempted(false);
    setLocalError(null);
    const timer = window.setTimeout(() => nameRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open || mode !== 'existing' || browse || browseLoading || browseAttempted) return;
    setBrowseAttempted(true);
    loadFolder('');
  }, [open, mode, browse, browseLoading, browseAttempted, loadFolder]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;

  const submit = (event) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setLocalError('Give the project a name.');
      return;
    }
    if (mode === 'existing' && !folder.trim()) {
      setLocalError('Choose a folder for the existing project.');
      return;
    }
    setLocalError(null);
    onCreate({
      name: trimmedName,
      ...(mode === 'existing' ? { path: folder.trim() } : {}),
    });
  };

  const message = localError || error;

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <header className="dialog-head">
          <div>
            <span className="dialog-eyebrow">Workspace</span>
            <h2 id="project-dialog-title">Open a project</h2>
            <p>Choose an existing folder to start scanning, or create a new workspace. The agent can only inspect the project you select here.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </header>

        <div className="dialog-tabs" role="tablist" aria-label="Project source">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'existing'}
            className={mode === 'existing' ? 'active' : ''}
            onClick={() => {
              setMode('existing');
              setLocalError(null);
              if (!browse && !browseLoading) setBrowseAttempted(false);
            }}
          >
            Existing folder
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'new'}
            className={mode === 'new' ? 'active' : ''}
            onClick={() => { setMode('new'); setLocalError(null); }}
          >
            New workspace
          </button>
        </div>

        <form className="dialog-form" onSubmit={submit}>
          <label className="dialog-field">
            <span>Project name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={mode === 'new' ? 'e.g. Portfolio site' : 'e.g. My existing app'}
              maxLength={120}
              disabled={busy}
            />
          </label>

          {mode === 'existing' && (
            <div className="dialog-field">
              <span>Project folder on the server</span>
              <div className="folder-path-row">
                <input
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                  placeholder="Choose a folder below or paste an absolute path"
                  disabled={busy}
                />
                <button type="button" className="ghost-button" onClick={() => loadFolder(folder || '')} disabled={busy || browseLoading}>
                  {browseLoading ? 'Loading…' : 'Open'}
                </button>
              </div>

              {browseError ? (
                <div className="dialog-hint dialog-hint-warn">
                  {browseError}
                  <span>Existing folders are only available when the server sets PROJECT_IMPORT_ROOT.</span>
                </div>
              ) : (
                <div className="folder-browser">
                  <div className="folder-browser-bar">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => browse?.parent && loadFolder(browse.parent)}
                      disabled={!browse?.parent || browseLoading || busy}
                    >
                      Up
                    </button>
                    <span className="folder-browser-path" title={browse?.path || folder}>
                      {browse?.path || folder || 'Allowed folders'}
                    </span>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => browse && setFolder(browse.path)}
                      disabled={!browse || busy}
                    >
                      Use this folder
                    </button>
                  </div>
                  <div className="folder-browser-list">
                    {browseLoading && <span className="folder-browser-empty">Reading folders…</span>}
                    {!browseLoading && browse?.directories?.length === 0 && (
                      <span className="folder-browser-empty">No subfolders here. You can use this folder.</span>
                    )}
                    {!browseLoading && browse?.directories?.map((entry) => (
                      <button
                        type="button"
                        key={entry.path}
                        className="folder-row"
                        onClick={() => loadFolder(entry.path)}
                        title={entry.path}
                      >
                        <span className="folder-row-icon" aria-hidden="true">▸</span>
                        <span>{entry.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {message && <div className="dialog-error" role="alert">{message}</div>}

          <footer className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? 'Opening…' : mode === 'existing' ? 'Open project' : 'Create project'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

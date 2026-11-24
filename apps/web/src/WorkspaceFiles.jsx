import React from 'react';
import CodeViewer from './CodeViewer';

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export default function WorkspaceFiles({
  project,
  files = [],
  selectedFile,
  content = '',
  search = '',
  onSearchChange,
  onSearch,
  results = [],
  onOpenFile,
  onRefresh,
  onNewProject,
  loading = false,
  scan = null,
}) {
  const scanView = scan || {
    status: loading ? 'scanning' : 'idle',
    message: loading ? 'Scanning project…' : null,
    summary: null,
  };
  const scanClasses = {
    scanning: 'scan-status scanning',
    complete: 'scan-status complete',
    failed: 'scan-status failed',
    unavailable: 'scan-status unavailable',
  };

  if (!project) {
    return (
      <div className="panel-empty">
        <div className="panel-empty-icon">⌂</div>
        <h3>No project selected</h3>
        <p>Create a workspace or choose an existing project. The agent can only read files inside the active project.</p>
        <button type="button" className="primary-button" onClick={onNewProject}>Add a project</button>
      </div>
    );
  }

  return (
    <div className="files-panel">
      <header className="panel-head">
        <div>
          <span className="panel-eyebrow">Project files</span>
          <strong title={project.name}>{project.name}</strong>
          <span className={scanClasses[scanView.status] || 'scan-status'}>{scanView.message}</span>
        </div>
        <button type="button" className="icon-button" onClick={onRefresh} title="Rescan project" aria-label="Rescan project">↻</button>
      </header>

      <form className="file-search-form" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search code…"
          aria-label="Search project code"
        />
        <button type="submit" className="ghost-button" disabled={search.trim().length < 2}>Find</button>
      </form>

      {scanView.status === 'complete' && scanView.summary && (
        <div className="scan-summary" aria-label="What the agent learned about this workspace">
          <span>{scanView.summary.fileCount} files</span>
          <span>{scanView.summary.directoryCount} folders</span>
          {scanView.summary.manifestCount > 0 && <span>{scanView.summary.manifestCount} manifests</span>}
          {scanView.summary.frameworkHints.slice(0, 3).map((hint) => <span key={`framework-${hint}`}>{hint}</span>)}
          {scanView.summary.languageHints.slice(0, 3).map((hint) => <span key={`language-${hint}`}>{hint}</span>)}
          {scanView.summary.truncated && <span>Partial scan</span>}
        </div>
      )}

      {scanView.status === 'failed' && (
        <button type="button" className="scan-retry" onClick={onRefresh}>Scan failed — retry</button>
      )}

      {results.length > 0 && (
        <div className="code-search-results" aria-label="Code search results">
          {results.map((result) => (
            <button
              type="button"
              key={`${result.path}:${result.line}`}
              onClick={() => onOpenFile(result.path)}
              title={`${result.path}:${result.line}`}
            >
              <code>{result.path}:{result.line}</code>
              <span>{result.content.trim() || ' '}</span>
            </button>
          ))}
        </div>
      )}

      <div className="file-tree" aria-label="Project files">
        {loading ? (
          <div className="file-tree-empty">Scanning project…</div>
        ) : files.length === 0 ? (
          <div className="file-tree-empty">This project is empty. Ask the agent to create the first files.</div>
        ) : files.map((filePath) => (
          <button
            type="button"
            key={filePath}
            className={`file-tree-item ${selectedFile === filePath ? 'selected' : ''}`}
            onClick={() => onOpenFile(filePath)}
            title={filePath}
          >
            <FileIcon />
            <span>{filePath}</span>
          </button>
        ))}
      </div>

      {selectedFile && (
        <section className="file-viewer" aria-label={`File ${selectedFile}`}>
          <header className="file-viewer-head">
            <span title={selectedFile}>{selectedFile}</span>
            <span className="file-viewer-meta">{content.split('\n').length} lines</span>
          </header>
          <CodeViewer content={content} filePath={selectedFile} />
        </section>
      )}
    </div>
  );
}

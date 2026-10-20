// Human file-editing endpoints: preview-before-write, create-or-replace,
// delete, proposal listing, and change history. All paths are confined to
// the project workspace by the shared guards in workspace/files.js.
import express from 'express';
import { config, redactSecrets } from '../config.js';
import {
  WorkspaceError,
  getProjectRoot,
  ensureDir,
  readTextFile,
  writeTextFile,
  deletePath,
  validateWritePath,
} from '../workspace/files.js';
import { unifiedDiff } from '../workspace/diff.js';

function findProject(db, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) return null;
  return db.prepare('SELECT id FROM projects WHERE id = ?').get(id) ?? null;
}

function sendError(res, err, label) {
  if (err instanceof WorkspaceError) {
    return res.status(err.status).json({ ok: false, error: err.message });
  }
  console.error(`[edits] ${label}:`, redactSecrets(`${err.name}: ${err.message}`));
  return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
}

function posixPath(p) {
  return String(p).split('\\').join('/');
}

export function createEditsRouter({ db, tools = null }) {
  const router = express.Router();

  // Create or replace a file:
  //   PUT /api/projects/:id/file?path=src/app.js        body: { content }
  //   PUT /api/projects/:id/file?path=...&preview=1     returns the diff only, writes nothing.
  router.put('/:id/file', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    if (typeof req.query.path !== 'string' || req.query.path.trim() === '') {
      return res.status(400).json({ ok: false, error: 'Query parameter "path" is required.' });
    }
    const content = req.body?.content;
    if (typeof content !== 'string') {
      return res.status(400).json({ ok: false, error: 'Request body must include "content" as text.' });
    }
    try {
      const root = getProjectRoot(db, config.workspaceRoot, project.id);
      ensureDir(root);
      const preview = req.query.preview === '1' || req.query.preview === 'true';

      if (preview) {
        // Compute what would change without touching the disk.
        let previous = null;
        let created = true;
        let displayPath = posixPath(req.query.path);
        try {
          const existing = readTextFile(root, req.query.path);
          previous = existing.content;
          created = false;
          displayPath = existing.path;
        } catch (err) {
          if (!(err instanceof WorkspaceError) || err.status !== 404) throw err;
          // Creating a new file: run the same path/credential checks the
          // real write would, so preview can never approve what PUT refuses.
          displayPath = posixPath(validateWritePath(req.query.path,
            'Credential or environment files cannot be edited through the workspace API.'));
        }
        const diff = unifiedDiff(previous ?? '', content, { oldPath: displayPath, newPath: displayPath });
        return res.json({
          ok: true,
          projectId: project.id,
          path: displayPath,
          preview: true,
          action: created ? 'create' : 'update',
          diff,
        });
      }

      const result = writeTextFile(root, req.query.path, content);
      const diff = unifiedDiff(result.previous ?? '', content, { oldPath: result.path, newPath: result.path });
      const action = result.created ? 'create' : 'update';
      db.prepare('INSERT INTO file_changes (project_id, path, action, source, diff) VALUES (?, ?, ?, ?, ?)')
        .run(project.id, result.path, action, 'user', diff || null);
      return res.status(result.created ? 201 : 200).json({
        ok: true,
        projectId: project.id,
        path: result.path,
        action,
        created: result.created,
        size: result.size,
        diff,
      });
    } catch (err) {
      return sendError(res, err, 'write');
    }
  });

  // Delete a file or empty directory:
  //   DELETE /api/projects/:id/file?path=src/old.js
  router.delete('/:id/file', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    if (typeof req.query.path !== 'string' || req.query.path.trim() === '') {
      return res.status(400).json({ ok: false, error: 'Query parameter "path" is required.' });
    }
    try {
      const root = getProjectRoot(db, config.workspaceRoot, project.id);
      ensureDir(root);
      const removed = deletePath(root, req.query.path);
      const diff = removed.type === 'file'
        ? unifiedDiff(removed.previous ?? '', '', { oldPath: removed.path, newPath: removed.path })
        : '';
      if (removed.type === 'file') {
        db.prepare('INSERT INTO file_changes (project_id, path, action, source, diff) VALUES (?, ?, ?, ?, ?)')
          .run(project.id, removed.path, 'delete', 'user', diff || null);
      }
      return res.json({ ok: true, projectId: project.id, ...removed, diff });
    } catch (err) {
      return sendError(res, err, 'delete');
    }
  });

  // Change history: GET /api/projects/:id/changes?limit=50
  router.get('/:id/changes', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
    try {
      const changes = db.prepare(
        'SELECT id, path, action, source, diff, created_at FROM file_changes WHERE project_id = ? ORDER BY id DESC LIMIT ?',
      ).all(project.id, limit);
      return res.json({ ok: true, projectId: project.id, changes });
    } catch (err) {
      return sendError(res, err, 'history');
    }
  });

  // Pending agent proposals (staged, not yet applied), with review diffs:
  //   GET /api/projects/:id/proposals
  router.get('/:id/proposals', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    if (!tools?.listProposals) {
      return res.status(503).json({ ok: false, error: 'Proposal listing is unavailable.' });
    }
    try {
      return res.json({ ok: true, projectId: project.id, ...tools.listProposals(project.id) });
    } catch (err) {
      return sendError(res, err, 'proposals');
    }
  });

  return router;
}

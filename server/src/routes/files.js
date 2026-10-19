// Project file browsing/reading endpoints - read-only in this slice.
// Mounted at /api/projects, every path is confined to the project workspace.
import express from 'express';
import { config, redactSecrets } from '../config.js';
import {
  WorkspaceError,
  projectDir,
  ensureDir,
  listDirectory,
  readTextFile,
} from '../workspace/files.js';

function findProject(db, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) return null;
  return db.prepare('SELECT id FROM projects WHERE id = ?').get(id) ?? null;
}

function sendError(res, err, label) {
  if (err instanceof WorkspaceError) {
    return res.status(err.status).json({ ok: false, error: err.message });
  }
  console.error(`[files] ${label}:`, redactSecrets(`${err.name}: ${err.message}`));
  return res.status(500).json({ ok: false, error: 'Unexpected server error.' });
}

export function createFilesRouter({ db }) {
  const router = express.Router();

  // List a directory: GET /api/projects/:id/files?path=src
  router.get('/:id/files', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    try {
      const dir = projectDir(config.workspaceRoot, project.id);
      ensureDir(dir); // older projects may predate automatic folder creation
      const listing = listDirectory(dir, typeof req.query.path === 'string' ? req.query.path : '.');
      return res.json({ ok: true, projectId: project.id, ...listing });
    } catch (err) {
      return sendError(res, err, 'list');
    }
  });

  // Read a file: GET /api/projects/:id/file?path=src/index.js
  router.get('/:id/file', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    if (typeof req.query.path !== 'string' || req.query.path.trim() === '') {
      return res.status(400).json({ ok: false, error: 'Query parameter "path" is required.' });
    }
    try {
      const dir = projectDir(config.workspaceRoot, project.id);
      ensureDir(dir);
      const file = readTextFile(dir, req.query.path);
      return res.json({ ok: true, projectId: project.id, ...file });
    } catch (err) {
      return sendError(res, err, 'read');
    }
  });

  return router;
}

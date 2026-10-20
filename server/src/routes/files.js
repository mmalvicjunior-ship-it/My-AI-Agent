// Project file browsing/reading endpoints - read-only in this slice.
// Mounted at /api/projects, every path is confined to the project workspace.
import express from 'express';
import fs from 'node:fs';
import { config, redactSecrets } from '../config.js';
import {
  WorkspaceError,
  projectDir,
  ensureDir,
  getProjectRoot,
  listDirectory,
  readTextFile,
  scanDirectory,
  searchWorkspace,
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

export function createFilesRouter({ db, tools = null }) {
  const router = express.Router();

  // List a directory: GET /api/projects/:id/files?path=src
  router.get('/:id/files', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    try {
      const dir = getProjectRoot(db, config.workspaceRoot, project.id);
      ensureDir(dir);
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
      const dir = getProjectRoot(db, config.workspaceRoot, project.id);
      ensureDir(dir);
      const file = readTextFile(dir, req.query.path);
      return res.json({ ok: true, projectId: project.id, ...file });
    } catch (err) {
      return sendError(res, err, 'read');
    }
  });

  router.get('/:id/tree', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    try {
      const dir = getProjectRoot(db, config.workspaceRoot, project.id);
      return res.json({ ok: true, projectId: project.id, ...scanDirectory(dir) });
    } catch (err) {
      return sendError(res, err, 'scan');
    }
  });

  router.get('/:id/search', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    try {
      const dir = getProjectRoot(db, config.workspaceRoot, project.id);
      return res.json({ ok: true, projectId: project.id, ...searchWorkspace(dir, req.query.q) });
    } catch (err) {
      return sendError(res, err, 'search');
    }
  });

  router.post('/:id/proposals/:proposalId/apply', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    if (!tools?.applyProposal) {
      return res.status(503).json({ ok: false, error: 'File proposal approval is unavailable.' });
    }
    try {
      const file = tools.applyProposal(project.id, req.params.proposalId);
      return res.status(201).json({ ok: true, file });
    } catch (err) {
      return sendError(res, err, 'apply proposal');
    }
  });

  router.post('/:id/commands/:proposalId/run', (req, res) => {
    const project = findProject(db, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    if (!tools?.runApprovedCommand) {
      return res.status(503).json({ ok: false, error: 'Command approval is unavailable.' });
    }
    try {
      return res.json({ ok: true, result: tools.runApprovedCommand(project.id, req.params.proposalId) });
    } catch (err) {
      return sendError(res, err, 'run approved command');
    }
  });

  return router;
}

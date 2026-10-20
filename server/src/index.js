import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { config, safeSummary, redactSecrets } from './config.js';
import { openDb } from './db/index.js';
import { getProvider } from './ai/index.js';
import { createChatRouter } from './routes/chat.js';
import { createFilesRouter } from './routes/files.js';
import { createEditsRouter } from './routes/edits.js';
import { createWorkspaceTools } from './ai/tools.js';
import { ensureDir, projectDir } from './workspace/files.js';

function localNetworkUrls(port) {
  return Object.values(os.networkInterfaces())
    .flatMap((interfaces) => interfaces || [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}`);
}

/**
 * Builds the Express application.
 * Routes will be split into separate files under src/routes/ as the app grows.
 */
export function createApp(options = {}) {
  const app = express();
  const db = openDb();

  // AI provider: injected by tests, otherwise resolved from AI_PROVIDER in .env
  const provider = 'provider' in options ? options.provider : getProvider(config.aiProvider);
  const providerName = 'providerName' in options ? options.providerName : config.aiProvider;
  const workspaceTools = createWorkspaceTools({ db });

  app.use(express.json({ limit: '1mb' }));

  // --- Health check -------------------------------------------------------
  app.get('/api/health', (req, res) => {
    const activeProvider = provider?.name ?? config.aiProvider;
    const keyConfigured = Boolean(config.aiApiKey);
    let aiWarning = null;

    if (activeProvider === 'mock') {
      aiWarning = 'The local Mock provider is active. Configure Gemini, OpenAI, Hugging Face, or Ollama in the project-root .env for AI-generated responses.';
    } else if (['openai', 'gemini', 'huggingface'].includes(activeProvider) && !keyConfigured) {
      const providerLabel = activeProvider === 'huggingface'
        ? 'Hugging Face'
        : activeProvider === 'openai' ? 'OpenAI' : 'Gemini';
      aiWarning = `${providerLabel} is selected, but AI_API_KEY is missing from the project-root .env.`;
    }

    res.json({
      ok: true,
      service: 'myai-agent-server',
      version: '0.1.0',
      aiProvider: activeProvider,
      aiConfigured: activeProvider === 'mock' || activeProvider === 'ollama' || keyConfigured,
      aiWarning,
    });
  });

  // --- Projects -----------------------------------------------------------
  app.get('/api/projects', (req, res) => {
    const rows = db.prepare('SELECT id, name, created_at FROM projects ORDER BY id DESC').all();
    res.json({ ok: true, projects: rows });
  });

  app.post('/api/projects', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ ok: false, error: 'Project name is required.' });
    }
    let rootPath = null;
    if (req.body?.path !== undefined) {
      if (typeof req.body.path !== 'string' || !path.isAbsolute(req.body.path)) {
        return res.status(400).json({ ok: false, error: 'Existing project path must be an absolute directory path on the server.' });
      }
      try {
        rootPath = fs.realpathSync(req.body.path);
        if (!fs.statSync(rootPath).isDirectory()) {
          return res.status(400).json({ ok: false, error: 'Existing project path must be a directory.' });
        }
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
          return res.status(404).json({ ok: false, error: 'Existing project directory was not found.' });
        }
        return res.status(400).json({ ok: false, error: 'Existing project directory could not be opened.' });
      }
    }
    const result = db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)').run(name, rootPath);
    const id = Number(result.lastInsertRowid);
    if (!rootPath) ensureDir(projectDir(config.workspaceRoot, id));
    res.status(201).json({ ok: true, project: { id, name } });
  });

  // --- Project files (path-safe; confined to the project workspace) --------
  app.use('/api/projects', createFilesRouter({ db, tools: workspaceTools }));

  // --- Human edits: preview/write/delete, change history, proposals --------
  app.use('/api/projects', createEditsRouter({ db, tools: workspaceTools }));

  // --- Chat (validated, routed through the pluggable AI adapter) ----------
  app.use('/api/chat', createChatRouter({ provider, providerName, tools: workspaceTools }));

  // --- Safety net for unknown API routes ----------------------------------
  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: 'Not found.' });
  });

  // --- Clear JSON errors for malformed or oversized bodies ----------------
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'Request body must be valid JSON.' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'Request body is too large (limit: 1mb).' });
    }
    return next(err);
  });

  return { app, db, tools: workspaceTools };
}

// Start the server only when this file is executed directly
// (allows tests to import createApp without binding a port).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  const onReady = () => {
    const shownHost = config.host || 'localhost';
    console.log(`[server] listening on http://${shownHost}:${config.port} (AI provider: ${config.aiProvider})`);
    console.log('[server] config:', safeSummary());
    for (const url of localNetworkUrls(config.port)) {
      console.log(`[server] network API: ${url}/api/health`);
    }
  };
  const server = config.host
    ? app.listen(config.port, config.host, onReady)
    : app.listen(config.port, onReady);

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[server] Port ${config.port} is already in use. Stop the process listening on that port, or set PORT for both backend and frontend, then restart both. On Windows, run "npm run dev:clean" from the project root to stop port 3001 and restart both services.`,
      );
      process.exitCode = 1;
      return;
    }
    console.error('[server] Error:', err);
    process.exitCode = 1;
  });
}

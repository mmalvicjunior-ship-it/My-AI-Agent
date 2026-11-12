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
import { createTasksRouter } from './routes/tasks.js';
import { createAuthRouter } from './routes/auth.js';
import { createWorkspaceTools } from './ai/tools.js';
import { createTaskRunner } from './tasks/runner.js';
import { createTaskExecutor } from './tasks/executor.js';
import { ensureDir, projectDir, isPathInside } from './workspace/files.js';
import { requireAuth, bypassAuth, isBypassUser } from './auth/index.js';

function realOrResolved(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function localNetworkUrls(port) {
  return Object.values(os.networkInterfaces())
    .flatMap((interfaces) => interfaces || [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}`);
}

/** Safe display name for the OpenAI-compatible adapter (for example OpenRouter). */
function openAICompatibleLabel() {
  if (!config.openaiBaseUrl) return 'OpenAI';
  try {
    const host = new URL(config.openaiBaseUrl).hostname.toLowerCase();
    if (!host || host === 'api.openai.com') return 'OpenAI';
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'OpenRouter';
    return `the API at ${host}`;
  } catch {
    return 'OpenAI';
  }
}

/**
 * Builds the Express application.
 * Routes will be split into separate files under src/routes/ as the app grows.
 */
export function createApp(options = {}) {
  const app = express();
  const db = openDb();

  // Rate limiter correctness behind a reverse proxy: derive the client IP
  // from X-Forwarded-For only for the configured number of trusted hops
  // (Render and Vercel place exactly one proxy in front of the app). This
  // keeps every client on its own IP bucket instead of sharing the proxy's
  // address, and a spoofed X-Forwarded-For from the client is ignored
  // because only the last `trustProxy` hops are trusted. A test may override
  // this with createApp({ trustProxy }).
  const trustProxy = 'trustProxy' in options ? options.trustProxy : config.trustProxy;
  app.set('trust proxy', trustProxy);

  // AI provider: injected by tests, otherwise resolved from AI_PROVIDER in .env.
  // Background tasks keep using this startup provider; chat requests may pick a
  // different provider per request through providerResolver.
  const provider = 'provider' in options ? options.provider : getProvider(config.aiProvider);
  const providerName = 'providerName' in options ? options.providerName : config.aiProvider;
  const providerResolver = 'providerResolver' in options
    ? options.providerResolver
    : (requestedName) => {
      if (!requestedName || requestedName === providerName) return provider;
      return getProvider(requestedName);
    };
  // Authentication is on unless a test explicitly opts out. The production
  // entry point calls createApp() with no options, so it can never run open.
  const authEnabled = options.auth !== false;
  const rawImportRoot = 'projectImportRoot' in options
    ? options.projectImportRoot
    : config.projectImportRoot;

  // Workspace tools: injectable by tests, otherwise the real path-safe toolset.
  // In multi-user (auth) deployments project npm scripts are disabled to avoid
  // running user-writable package.json scripts as the server user.
  const workspaceTools = 'tools' in options ? options.tools : createWorkspaceTools({ db, allowProjectCommands: !authEnabled });

  app.use(express.json({ limit: '1mb' }));

  // --- Health check -------------------------------------------------------
  app.get('/api/health', (req, res) => {
    const activeProvider = provider?.name ?? config.aiProvider;
    // When Gemini is the startup provider and no GEMINI_API_KEY is set, the
    // legacy shared AI_API_KEY remains a valid Gemini credential. In that case
    // it is not counted as an OpenRouter key, so the two providers never mix.
    const legacyGeminiKey = !config.geminiApiKey
      && config.aiProvider === 'gemini'
      && Boolean(config.aiApiKey);
    const openaiConfigured = Boolean(config.aiApiKey) && !legacyGeminiKey;
    const geminiConfigured = Boolean(config.geminiApiKey) || legacyGeminiKey;
    const keyConfigured = activeProvider === 'gemini' ? geminiConfigured : openaiConfigured;
    const activeLabel = provider?.displayName
      || (activeProvider === 'huggingface'
        ? 'Hugging Face'
        : activeProvider === 'openai' ? openAICompatibleLabel() : 'Gemini');
    let aiWarning = null;

    if (activeProvider === 'mock') {
      aiWarning = 'The local Mock provider is active. Configure Gemini, OpenAI, Hugging Face, or Ollama in the project-root .env for AI-generated responses.';
    } else if (['openai', 'gemini', 'huggingface'].includes(activeProvider) && !keyConfigured) {
      const keyName = activeProvider === 'gemini' ? 'GEMINI_API_KEY' : 'AI_API_KEY';
      aiWarning = `${activeLabel} is selected, but ${keyName} is missing from the project-root .env.`;
    }

    res.json({
      ok: true,
      service: 'myai-agent-server',
      version: '0.1.0',
      aiProvider: activeProvider,
      // The real service name (for example OpenRouter) so the UI can name it.
      providerLabel: provider?.displayName
        || (activeProvider === 'gemini' ? 'Google Gemini' : null),
      aiConfigured: activeProvider === 'mock' || activeProvider === 'ollama' || keyConfigured,
      aiWarning,
      // Safe per-provider status for the chat selector; never includes keys.
      providers: {
        openai: {
          label: provider?.name === 'openai'
            ? (provider.displayName || openAICompatibleLabel())
            : openAICompatibleLabel(),
          configured: openaiConfigured,
        },
        gemini: {
          label: 'Google Gemini',
          configured: geminiConfigured,
        },
      },
    });
  });

  // --- Accounts (public) --------------------------------------------------
  app.use('/api/auth', createAuthRouter({ db }));

  // Every route below this point requires a valid bearer session. /api/health
  // above stays public and never exposes credentials.
  if (authEnabled) app.use('/api', requireAuth(db));
  else app.use('/api', bypassAuth());

  // --- Projects -----------------------------------------------------------
  app.get('/api/projects', (req, res) => {
    const rows = isBypassUser(req.user)
      ? db.prepare('SELECT id, name, created_at FROM projects ORDER BY id DESC').all()
      : db.prepare('SELECT id, name, created_at FROM projects WHERE owner_id = ? ORDER BY id DESC').all(req.user.id);
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
      if (typeof rawImportRoot !== 'string' || rawImportRoot.trim() === '') {
        return res.status(403).json({
          ok: false,
          error: 'Importing existing server directories is disabled. Set PROJECT_IMPORT_ROOT on the server to allow it.',
        });
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

      const importRoot = realOrResolved(rawImportRoot);
      if (!isPathInside(importRoot, rootPath)) {
        return res.status(403).json({
          ok: false,
          error: 'Existing project path is outside the configured import root.',
        });
      }
      // The managed workspace tree holds every user's project files, so it can
      // never be registered as an importable project.
      if (isPathInside(realOrResolved(config.workspaceRoot), rootPath)) {
        return res.status(403).json({
          ok: false,
          error: 'Existing project path cannot be inside the managed workspace root.',
        });
      }
      // Ancestor check: if the import root is an ancestor of the managed
      // workspace or the database directory, the import would expose all
      // user projects or server secrets. Reject it.
      const workspaceRootReal = realOrResolved(config.workspaceRoot);
      const databaseDirReal = path.dirname(realOrResolved(config.databasePath));
      if (isPathInside(rootPath, workspaceRootReal)) {
        return res.status(403).json({
          ok: false,
          error: 'Existing project path cannot be an ancestor of the managed workspace root.',
        });
      }
      if (isPathInside(rootPath, databaseDirReal)) {
        return res.status(403).json({
          ok: false,
          error: 'Existing project path cannot be an ancestor of the database directory.',
        });
      }
    }
    const ownerId = isBypassUser(req.user) ? null : req.user.id;
    const result = db
      .prepare('INSERT INTO projects (name, root_path, owner_id) VALUES (?, ?, ?)')
      .run(name, rootPath, ownerId);
    const id = Number(result.lastInsertRowid);
    if (!rootPath) ensureDir(projectDir(config.workspaceRoot, id));
    res.status(201).json({ ok: true, project: { id, name } });
  });

  // --- Project files (path-safe; confined to the project workspace) --------
  app.use('/api/projects', createFilesRouter({ db, tools: workspaceTools }));

  // --- Human edits: preview/write/delete, change history, proposals --------
  app.use('/api/projects', createEditsRouter({ db, tools: workspaceTools }));

  // --- Chat (validated, routed through the pluggable AI adapter) ----------
  app.use('/api/chat', createChatRouter({ db, provider, providerName, tools: workspaceTools, providerResolver }));

  // --- Background tasks (durable queue; executed by src/tasks/runner.js) --
  app.use('/api/tasks', createTasksRouter({ db }));

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

  return { app, db, tools: workspaceTools, provider };
}

// Start the server only when this file is executed directly
// (allows tests to import createApp without binding a port).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, db, tools: workspaceTools, provider } = createApp();
  // Background queue: runs outside any HTTP request and is not started by
  // createApp(), so importing the app in tests never spawns a worker.
  const taskRunner = createTaskRunner({
    db,
    // Stage 3: read-only workspace inspection through the existing agent.
    executor: createTaskExecutor({ db, provider, tools: workspaceTools }),
  });
  taskRunner.start();
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

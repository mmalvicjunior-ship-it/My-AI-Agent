import express from 'express';
import { fileURLToPath } from 'node:url';
import { config, safeSummary, redactSecrets } from './config.js';
import { openDb } from './db/index.js';
import { getProvider } from './ai/index.js';
import { createChatRouter } from './routes/chat.js';

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

  app.use(express.json({ limit: '1mb' }));

  // --- Health check -------------------------------------------------------
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'myai-agent-server',
      version: '0.1.0',
      aiProvider: config.aiProvider,
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
    const result = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name);
    res.status(201).json({ ok: true, project: { id: Number(result.lastInsertRowid), name } });
  });

  // --- Chat (validated, routed through the pluggable AI adapter) ----------
  app.use('/api/chat', createChatRouter({ provider, providerName }));

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

  return { app, db };
}

// Start the server only when this file is executed directly
// (allows tests to import createApp without binding a port).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  const onReady = () => {
    const shownHost = config.host || 'localhost';
    // Log only non-sensitive startup info (secrets stay masked via safeSummary).
    console.log(`[server] listening on http://${shownHost}:${config.port} (AI provider: ${config.aiProvider})`);
    console.log('[server] config:', safeSummary());
  };
  if (config.host) {
    app.listen(config.port, config.host, onReady);
  } else {
    app.listen(config.port, onReady);
  }
}

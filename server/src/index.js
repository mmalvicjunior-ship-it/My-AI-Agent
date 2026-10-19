import express from 'express';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/index.js';

/**
 * Builds the Express application.
 * Routes will be split into separate files under src/routes/ as the app grows.
 */
export function createApp() {
  const app = express();
  const db = openDb();

  app.use(express.json({ limit: '1mb' }));

  // --- Health check -------------------------------------------------------
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'myai-agent-server',
      version: '0.1.0',
      aiProvider: process.env.AI_PROVIDER || 'mock',
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

  // --- Chat (placeholder until the AI adapter lands in Phase 3) -----------
  app.post('/api/chat', (req, res) => {
    res.status(503).json({
      ok: false,
      error: 'AI adapter not yet configured. Set AI_PROVIDER in server/.env (see .env.example).',
    });
  });

  // --- Safety net for unknown API routes ----------------------------------
  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: 'Not found.' });
  });

  return { app, db };
}

// Start the server only when this file is executed directly
// (allows tests to import createApp without binding a port).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  const port = Number(process.env.PORT) || 3001;
  app.listen(port, () => {
    // Log only non-sensitive startup info.
    console.log(`[server] listening on http://localhost:${port} (AI provider: ${process.env.AI_PROVIDER || 'mock'})`);
  });
}

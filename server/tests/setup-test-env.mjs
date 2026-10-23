// Test-only bootstrap, loaded before every test file (and `npm run smoke`) by:
//   node --test --import ./tests/setup-test-env.mjs
//   node --import ./tests/setup-test-env.mjs tests/smoke.mjs
//
// It points the app at a throwaway database and workspace root so running the
// suite never writes projects or file-change history into the real
// server/data/app.db (or leaves folders behind in server/workspaces).
//
// src/config.js calls process.loadEnvFile(), which does NOT override env vars
// that are already set, so these values take precedence over .env.
// Each test process gets its own directory, so parallel test files stay isolated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), `myai-test-${process.pid}-`));
process.env.DATABASE_PATH = path.join(root, 'test.db');
process.env.WORKSPACE_ROOT = path.join(root, 'workspaces');

// Windows keeps the SQLite file open until after the 'exit' handler runs, so a
// single run can leave its folder behind. Sweep up old ones (older than an hour,
// so a concurrent test run is never disturbed) instead of accumulating forever.
function pruneStaleTestRoots() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('myai-test-')) continue;
    const candidate = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(candidate).mtimeMs > cutoff) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Another process may still own it; try again on a later run.
    }
  }
}

pruneStaleTestRoots();

// Best effort: Windows may still hold the SQLite file open when the process
// exits, and a leftover temp folder must never fail an otherwise green run.
process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Ignored on purpose.
  }
});

// Postgres-backed half of the two-account regression suite. PGlite runs a real
// Postgres engine in-process, so no remote database, production data, or network
// access is used. Env vars are set before importing the app/config modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-cross-account-pglite-'));
process.env.DATABASE_BACKEND = 'pglite';
process.env.PGLITE_DATA_DIR = pgliteDir;
process.env.WORKSPACE_STORAGE = 'local';

const { createApp } = await import('../src/index.js');
const { runCrossAccountBackendChecks } = await import('./cross-account-fixture.mjs');

runCrossAccountBackendChecks({
  label: 'Postgres (PGlite)',
  createApp,
  cleanup: () => {
    try {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    } catch {
      /* Best effort cleanup of isolated temp data. */
    }
  },
});

// Guards the isolation set up by tests/setup-test-env.mjs. If this fails, the
// suite was started with plain `node --test` instead of `npm test`, which would
// write test projects into the real server/data/app.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { config } from '../src/config.js';

test('the suite runs against a temporary database and workspace root', () => {
  const tempRoot = path.resolve(os.tmpdir()).toLowerCase();
  const dbPath = path.resolve(config.databasePath).toLowerCase();
  const workspacePath = path.resolve(config.workspaceRoot).toLowerCase();

  assert.ok(
    dbPath.startsWith(tempRoot),
    `DATABASE_PATH should be inside ${tempRoot} during tests but was ${dbPath}. Run the suite with "npm test".`,
  );
  assert.ok(
    workspacePath.startsWith(tempRoot),
    `WORKSPACE_ROOT should be inside ${tempRoot} during tests but was ${workspacePath}. Run the suite with "npm test".`,
  );
  assert.ok(
    !dbPath.endsWith(path.join('server', 'data', 'app.db').toLowerCase()),
    'Tests must never use the production database.',
  );
});

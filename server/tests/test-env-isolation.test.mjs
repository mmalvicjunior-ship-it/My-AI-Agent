import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test bootstrap pins the original SQLite/local backends before config loads', async () => {
  assert.equal(process.env.DATABASE_BACKEND, 'sqlite');
  assert.equal(process.env.WORKSPACE_STORAGE, 'local');
  const { config } = await import('../src/config.js');
  assert.equal(config.databaseBackend, 'sqlite');
  assert.equal(config.workspaceStorage, 'local');
});

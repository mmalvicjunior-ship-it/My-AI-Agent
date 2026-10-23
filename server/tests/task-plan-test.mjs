// Stage 4 – plan persistence tests (isolated temporary database).
//
// These tests use their own disposable SQLite file in a temporary folder and
// never touch the production database (server/data/app.db).
import { test, beforeEach, afterEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ensurePlanColumn, savePlan, loadPlan } from '../src/tasks/store.js';

let db;
let dbPath;

/** Inserts a disposable task row and returns its real id. */
function insertTask(instruction = 'test task') {
  const result = db
    .prepare("INSERT INTO tasks (project_id, instruction, autonomy, status) VALUES (1, ?, 'propose', 'queued')")
    .run(instruction);
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskplan-'));
  dbPath = path.join(dir, 'test.db');
  db = new DatabaseSync(dbPath);
  // Create the tasks table exactly like openDb does (without the plan column),
  // so the migration has something real to migrate.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id       INTEGER NOT NULL,
      instruction      TEXT NOT NULL,
      autonomy         TEXT NOT NULL DEFAULT 'allow_writes_and_commands'
                       CHECK (autonomy IN ('propose', 'allow_writes', 'allow_writes_and_commands')),
      status           TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
      last_step        TEXT,
      error            TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      started_at       TEXT,
      finished_at      TEXT
    );
  `);
  // Migration: add plan persistence column safely
  ensurePlanColumn(db);
});

afterEach(() => {
  db.close?.();
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {}
});

test('ensurePlanColumn runs idempotently twice', () => {
  ensurePlanColumn(db);
  ensurePlanColumn(db); // second call must be a safe no-op
  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!columns.includes('plan_json')) throw new Error('plan_json column should exist');
  const planColumns = columns.filter((name) => name === 'plan_json');
  if (planColumns.length !== 1) throw new Error('plan_json column should exist exactly once');
});

test('ensurePlanColumn keeps existing task rows intact', () => {
  const id = insertTask('keep me');
  ensurePlanColumn(db);
  const row = db.prepare('SELECT instruction, status FROM tasks WHERE id = ?').get(id);
  if (!row || row.instruction !== 'keep me' || row.status !== 'queued') {
    throw new Error('existing task rows must survive the migration');
  }
});

test('savePlan stores a plan object and loadPlan retrieves it', () => {
  const id = insertTask('save test');
  const plan = { steps: [{ tool: 'read_file', path: 'src/app.js', goal: 'check imports' }] };
  savePlan(db, id, plan);
  const loaded = loadPlan(db, id);
  if (loaded === null) throw new Error('loaded plan should not be null');
  if (JSON.stringify(loaded) !== JSON.stringify(plan)) throw new Error('loaded plan differs from saved');
});

test('loadPlan returns null for a missing task', () => {
  const loaded = loadPlan(db, 999999); // never inserted
  if (loaded !== null) throw new Error('loadPlan should return null for a missing task');
});

test('loadPlan returns null when plan_json is absent', () => {
  const id = insertTask('no plan');
  const loaded = loadPlan(db, id);
  if (loaded !== null) throw new Error('loadPlan should return null when plan_json is NULL');
});

test('loadPlan gracefully handles malformed JSON in plan_json', () => {
  const id = insertTask('broken plan');
  db.prepare('UPDATE tasks SET plan_json = ? WHERE id = ?').run('{broken json', id);
  const loaded = loadPlan(db, id);
  if (loaded !== null) throw new Error('loadPlan should return null on malformed JSON');
});

test('savePlan with null plan clears the stored plan', () => {
  const id = insertTask('clear test');
  savePlan(db, id, { steps: [{ tool: 'list_files' }] });
  if (loadPlan(db, id) === null) throw new Error('plan should be present after savePlan');
  savePlan(db, id, null);
  if (loadPlan(db, id) !== null) throw new Error('loadPlan should return null after saving a null plan');
});

test('savePlan rejects invalid plan input without corrupting the task', () => {
  const id = insertTask('invalid test');

  // A primitive is not a plan.
  let threw = false;
  try {
    savePlan(db, id, 'not a plan');
  } catch (error) {
    threw = error instanceof TypeError;
  }
  if (!threw) throw new Error('savePlan should reject a non-object plan');

  // A circular structure cannot be serialised.
  const circular = { steps: [] };
  circular.steps.push(circular);
  threw = false;
  try {
    savePlan(db, id, circular);
  } catch (error) {
    threw = error instanceof TypeError;
  }
  if (!threw) throw new Error('savePlan should reject a circular plan');

  // Nothing was stored and the task row is untouched.
  if (loadPlan(db, id) !== null) throw new Error('no plan should have been stored');
  const row = db.prepare('SELECT instruction, status FROM tasks WHERE id = ?').get(id);
  if (!row || row.instruction !== 'invalid test' || row.status !== 'queued') {
    throw new Error('the task row must be unchanged after a rejected plan');
  }
});

test('savePlan on a missing task is a safe no-op', () => {
  savePlan(db, 999999, { steps: [{ tool: 'read_file' }] });
  if (loadPlan(db, 999999) !== null) throw new Error('loadPlan should return null for a missing task');
});

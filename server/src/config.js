import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(serverDir, '..');

// Load the project-root .env if present (Node built-in; no dotenv dependency).
const envPath = path.join(projectRoot, '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// Resolve a path that is relative to the server/ folder.
function resolveServerPath(value, fallback) {
  const raw = value || fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(serverDir, raw);
}

function portFromEnv() {
  const parsed = Number(process.env.PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3001;
}

export const config = {
  // Empty string = listen on all interfaces (lets a phone on the same Wi-Fi connect).
  // Set HOST=127.0.0.1 in .env to restrict access to this computer only.
  host: process.env.HOST || '',
  port: portFromEnv(),

  aiProvider: process.env.AI_PROVIDER || 'mock',
  aiApiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || '',

  databasePath: resolveServerPath(process.env.DATABASE_PATH, './data/app.db'),
  workspaceRoot: resolveServerPath(process.env.WORKSPACE_ROOT, './workspaces'),

  projectRoot,
  serverDir,
};

function mask(secret) {
  if (!secret) return '(not set)';
  return `(set, ${secret.length} chars, hidden)`;
}

// Config summary that is always safe to print - never includes secret values.
export function safeSummary() {
  return {
    host: config.host || '(all interfaces)',
    port: config.port,
    aiProvider: config.aiProvider,
    aiApiKey: mask(config.aiApiKey),
    aiModel: config.aiModel || '(not set)',
    databasePath: config.databasePath,
    workspaceRoot: config.workspaceRoot,
  };
}

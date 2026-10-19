import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(serverDir, '..');

// Load .env from the project root if present (Node built-in, no dotenv needed).
const envPath = path.join(projectRoot, '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function resolvePath(value, fallback) {
  const raw = value || fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(serverDir, raw);
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3001),

  aiProvider: process.env.AI_PROVIDER || '',
  aiApiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || '',

  databasePath: resolvePath(process.env.DATABASE_PATH, './data/myai-agent.sqlite'),
  workspaceRoot: resolvePath(process.env.WORKSPACE_ROOT, './workspaces'),

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
    host: config.host,
    port: config.port,
    aiProvider: config.aiProvider || '(not set)',
    aiApiKey: mask(config.aiApiKey),
    aiModel: config.aiModel || '(not set)',
    databasePath: config.databasePath,
    workspaceRoot: config.workspaceRoot,
  };
}

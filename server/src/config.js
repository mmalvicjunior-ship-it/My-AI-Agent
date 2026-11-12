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

function sessionDaysFromEnv() {
  const parsed = Number(process.env.AUTH_SESSION_DAYS);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 365 ? Math.floor(parsed) : 30;
}

/**
 * How many proxy hops to trust when Express derives the client IP from
 * X-Forwarded-For (used by the login/register rate limiter). Default is 1:
 * the single reverse proxy Render/Vercel place in front of the service.
 * "false"/"0" = the server is reached directly (use the socket IP). A plain
 * integer trusts that many hops. A comma-separated list trusts those CIDRs.
 * We never default to unconditionally trusting arbitrary X-Forwarded-For.
 */
function trustProxyFromEnv() {
  const raw = process.env.TRUST_PROXY;
  if (typeof raw !== 'string' || raw.trim() === '') return 1;
  const value = raw.trim().toLowerCase();
  if (['false', 'off', 'none'].includes(value)) return false;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  // Comma-separated proxy CIDRs/IPs, or Express keywords (loopback, linklocal, uniquelocal).
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

/**
 * Optional directory that may be registered through POST /api/projects?path=.
 * Empty means importing existing server directories is disabled, which is the
 * safe default: new workspaces are created under WORKSPACE_ROOT instead.
 */
function importRootFromEnv() {
  const raw = process.env.PROJECT_IMPORT_ROOT;
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(serverDir, raw);
}

export const config = {
  // Empty string = listen on all interfaces (lets a phone on the same Wi-Fi connect).
  // Set HOST=127.0.0.1 in .env to restrict access to this computer only.
  host: process.env.HOST || '',
  port: portFromEnv(),

  aiProvider: process.env.AI_PROVIDER || 'mock',
  // OpenRouter / OpenAI-compatible credentials (the active provider is "openai").
  aiApiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
  // Google Gemini credentials, kept independent so both providers can be
  // configured at the same time and selected per chat request.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || '',
  debugChatPrompts: process.env.DEBUG_CHAT_PROMPTS === 'true',

  databasePath: resolveServerPath(process.env.DATABASE_PATH, './data/app.db'),
  workspaceRoot: resolveServerPath(process.env.WORKSPACE_ROOT, './workspaces'),

  // Authentication defaults. Registration stays enabled so a fresh deployment
  // can create accounts after bootstrap; the FIRST account always requires
  // BOOTSTRAP_TOKEN (a server-side shared secret), so an unknown visitor can
  // never register before the administrator. Set ALLOW_REGISTRATION=false
  // once the administrator account exists.
  authSessionDays: sessionDaysFromEnv(),
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
  bootstrapToken: (process.env.BOOTSTRAP_TOKEN || '').trim(),
  // See trustProxyFromEnv: one trusted proxy hop by default.
  trustProxy: trustProxyFromEnv(),
  // Empty = importing existing server paths is disabled (see importRootFromEnv).
  projectImportRoot: importRootFromEnv(),

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
    geminiApiKey: mask(config.geminiApiKey),
    geminiModel: config.geminiModel || '(not set)',
    databasePath: config.databasePath,
    workspaceRoot: config.workspaceRoot,
    allowRegistration: config.allowRegistration,
    authSessionDays: config.authSessionDays,
    bootstrapToken: mask(config.bootstrapToken),
    trustProxy: config.trustProxy,
    projectImportRoot: config.projectImportRoot || '(imports disabled)',
  };
}

// Remove API keys, credentials, and tokens from any text before it is logged or stored.
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let safe = text;
  // Replace known configured secrets exactly, for both providers.
  for (const secret of [config.aiApiKey, config.geminiApiKey]) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  // Redact standard secret patterns: Bearer tokens, OpenAI/Anthropic/Google keys, GitHub PATs
  safe = safe
    .replace(/\b(?:sk-|key_|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_*.-]{8,}/gi, '[redacted credential]')
    // Google AI Studio keys start with "AIza".
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted credential]')
    .replace(/\bBearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]')
    .replace(/((?:AI_API_KEY|GEMINI_API_KEY|OPENROUTER_API_KEY|API_KEY|SECRET|PASSWORD|TOKEN))=["']?[^"'\s]+["']?/gi, '$1=[redacted]');
  return safe;
}

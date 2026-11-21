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

function positiveIntFromEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

// Explicit opt-in for a single alternative provider. Only OpenRouter is
// supported today; an empty or unknown value keeps fallback disabled.
function fallbackProviderFromEnv() {
  const value = (process.env.AI_FALLBACK_PROVIDER || '').trim().toLowerCase();
  return value === 'openai' ? 'openai' : '';
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

/**
 * Validates APP_ORIGIN: an absolute https origin (http allowed only for
 * localhost development), without credentials, path, query or fragment.
 * Empty string means same-origin relative redirects. Throws on anything else
 * so a misconfiguration fails closed at startup instead of later redirecting
 * session tokens to an attacker-controlled origin.
 */
export function validateAppOrigin(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`APP_ORIGIN must be a valid absolute URL, got: ${value}`);
  }
  const isHttps = url.protocol === 'https:';
  const isLocalHttp = url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.localhost'));
  if (!isHttps && !isLocalHttp) {
    throw new Error('APP_ORIGIN must use https: (http: is allowed only for localhost development).');
  }
  if (url.username || url.password) throw new Error('APP_ORIGIN must not contain credentials.');
  if (url.pathname && url.pathname !== '/') throw new Error('APP_ORIGIN must not contain a path.');
  if (url.search || url.hash) throw new Error('APP_ORIGIN must not contain a query string or fragment.');
  return url.origin;
}

export const config = {
  // Empty string = listen on all interfaces (lets a phone on the same Wi-Fi connect).
  // Set HOST=127.0.0.1 in .env to restrict access to this computer only.
  host: process.env.HOST || '',
  port: portFromEnv(),

  aiProvider: process.env.AI_PROVIDER || 'mock',
  // Optional explicit fallback for recognised Gemini quota/availability errors.
  aiFallbackProvider: fallbackProviderFromEnv(),
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

  // Optional persistent storage backends. Both remain disabled by default:
  // local SQLite + local workspace files are still the development/test path.
  // DATABASE_BACKEND=postgres uses Neon (or any PostgreSQL) over DATABASE_URL.
  // DATABASE_BACKEND=pglite is a local in-process Postgres-compatible test backend.
  databaseBackend: ['sqlite', 'postgres', 'pglite'].includes((process.env.DATABASE_BACKEND || '').toLowerCase())
    ? (process.env.DATABASE_BACKEND || '').toLowerCase()
    : 'sqlite',
  databaseUrl: (process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || '').trim(),
  databaseSsl: process.env.DATABASE_SSL !== 'false',
  databaseRejectUnauthorized: process.env.DATABASE_REJECT_UNAUTHORIZED !== 'false',
  // Local Postgres-compatible tests may reuse a file-backed PGlite directory.
  pgliteDataDir: (process.env.PGLITE_DATA_DIR || '').trim(),
  storageBridgeTimeoutMs: Number.isFinite(Number(process.env.STORAGE_BRIDGE_TIMEOUT_MS))
    && Number(process.env.STORAGE_BRIDGE_TIMEOUT_MS) > 0
    ? Number(process.env.STORAGE_BRIDGE_TIMEOUT_MS)
    : 60_000,

  // Workspace object storage. WORKSPACE_STORAGE=s3 uses an S3-compatible
  // endpoint (Neon Object Storage); "memory" is a local test-only stand-in.
  workspaceStorage: ['local', 's3', 'memory'].includes((process.env.WORKSPACE_STORAGE || '').toLowerCase())
    ? (process.env.WORKSPACE_STORAGE || '').toLowerCase()
    : 'local',
  workspaceS3Endpoint: (process.env.WORKSPACE_S3_ENDPOINT || '').trim(),
  workspaceS3Bucket: (process.env.WORKSPACE_S3_BUCKET || '').trim(),
  workspaceS3Region: (process.env.WORKSPACE_S3_REGION || 'auto').trim() || 'auto',
  workspaceS3AccessKey: (process.env.WORKSPACE_S3_ACCESS_KEY || '').trim(),
  workspaceS3SecretKey: (process.env.WORKSPACE_S3_SECRET_KEY || '').trim(),
  workspaceS3Prefix: (process.env.WORKSPACE_S3_PREFIX || 'workspaces').trim() || 'workspaces',

  // Optional Python 3 executable for python_check/python_run. The default is
  // `python` on Windows and `python3` elsewhere; no project code is executed
  // unless the user explicitly approves a python_run proposal.
  pythonBin: (process.env.PYTHON_BIN || '').trim()
    || (process.platform === 'win32' ? 'python' : 'python3'),
  // Hard limits for the backend-owned Python subprocess runner. These are not
  // sandbox controls: generated Python still runs with the server account's OS
  // privileges. They only bound wall-clock time and captured output.
  pythonRunTimeoutMs: positiveIntFromEnv('PYTHON_RUN_TIMEOUT_MS', 30_000, { min: 100, max: 600_000 }),
  pythonRunMaxOutputBytes: positiveIntFromEnv('PYTHON_RUN_MAX_OUTPUT_BYTES', 16_000, { min: 1, max: 1_048_576 }),

  // Authentication defaults. Registration stays enabled so ordinary users can
  // sign up normally, including on a fresh deployment. BOOTSTRAP_TOKEN is used
  // only by the owner-only /api/auth/admin/provision endpoint, never by public
  // registration or Google sign-in. Set ALLOW_REGISTRATION=false once the
  // administrator account exists to close public registration.
  authSessionDays: sessionDaysFromEnv(),
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
  bootstrapToken: (process.env.BOOTSTRAP_TOKEN || '').trim(),
  // Optional Google sign-in (authorization-code flow, server-side only).
  // Leave all three Google values empty to disable the "Continue with Google"
  // button. The client secret never leaves this server.
  googleClientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  googleClientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  googleRedirectUri: (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim(),
  // Base URL the OAuth callback redirects back to after login. Empty = same-
  // origin relative redirect (works behind the Vercel rewrite and the Vite dev
  // proxy). Set it only when the callback is reached on a different origin
  // than the frontend. Validated: absolute https origin (http only on
  // localhost), no credentials/path/query/fragment; invalid values fail
  // closed at startup.
  appOrigin: validateAppOrigin(process.env.APP_ORIGIN || ''),
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
    aiFallbackProvider: config.aiFallbackProvider || '(not set)',
    aiApiKey: mask(config.aiApiKey),
    aiModel: config.aiModel || '(not set)',
    geminiApiKey: mask(config.geminiApiKey),
    geminiModel: config.geminiModel || '(not set)',
    databasePath: config.databasePath,
    databaseBackend: config.databaseBackend,
    databaseUrl: mask(config.databaseUrl),
    workspaceRoot: config.workspaceRoot,
    workspaceStorage: config.workspaceStorage,
    workspaceS3Endpoint: config.workspaceS3Endpoint || '(not set)',
    workspaceS3Bucket: config.workspaceS3Bucket || '(not set)',
    workspaceS3Prefix: config.workspaceS3Prefix,
    pythonBin: config.pythonBin,
    pythonRunTimeoutMs: config.pythonRunTimeoutMs,
    pythonRunMaxOutputBytes: config.pythonRunMaxOutputBytes,
    allowRegistration: config.allowRegistration,
    authSessionDays: config.authSessionDays,
    bootstrapToken: mask(config.bootstrapToken),
    googleClientId: mask(config.googleClientId),
    googleClientSecret: mask(config.googleClientSecret),
    googleRedirectUri: config.googleRedirectUri || '(not set)',
    appOrigin: config.appOrigin || '(same origin)',
    trustProxy: config.trustProxy,
    projectImportRoot: config.projectImportRoot || '(imports disabled)',
  };
}

// Remove API keys, credentials, and tokens from any text before it is logged or stored.
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let safe = text;
  // Replace known configured secrets exactly, for both providers and Google.
  for (const secret of [
    config.aiApiKey,
    config.geminiApiKey,
    config.googleClientSecret,
    config.databaseUrl,
    config.workspaceS3SecretKey,
  ]) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  // Redact standard secret patterns: Bearer tokens, OpenAI/Anthropic/Google keys, GitHub PATs
  safe = safe
    .replace(/\b(?:sk-|key_|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_*.-]{8,}/gi, '[redacted credential]')
    // Google AI Studio keys start with "AIza".
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted credential]')
    .replace(/\bBearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]')
    .replace(/((?:AI_API_KEY|GEMINI_API_KEY|OPENROUTER_API_KEY|API_KEY|DATABASE_URL|NEON_DATABASE_URL|WORKSPACE_S3_SECRET_KEY|SECRET|PASSWORD|TOKEN))=["']?[^"'\s]+["']?/gi, '$1=[redacted]');
  return safe;
}

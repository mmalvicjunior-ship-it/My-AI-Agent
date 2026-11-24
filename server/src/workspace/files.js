// Path-safe workspace file operations.
// Every function here confines access to a single project directory:
// absolute paths, traversal ("../"), null bytes, and symlinks that point
// outside the authorized workspace are rejected with a WorkspaceError.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../config.js';
import { WorkspaceError } from './errors.js';
import { getWorkspaceDriver, afterWorkspaceWrite } from './storage-driver.js';

export { WorkspaceError };

export const MAX_READ_BYTES = 1024 * 1024; // 1 MiB per file read
export const MAX_LIST_ENTRIES = 1000;
export const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage']);
export const MAX_SCAN_FILES = 5000;
export const MAX_SCAN_DEPTH = 12;
export const MAX_SCAN_DIRECTORIES = 1000;
export const MAX_SCAN_HINTS = 25;
const BINARY_SNIFF_BYTES = 8000;
const MAX_GITIGNORE_BYTES = 64 * 1024;

// Extra generated/cache directories and private-key stores. These are never
// affected by .gitignore negations: security exclusions always win.
const SCAN_IGNORED_DIRECTORIES = new Set([
  ...IGNORED_DIRECTORIES,
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
  '.parcel-cache',
  '.svelte-kit',
  '.angular',
  '.gradle',
  '.idea',
  '.vscode',
  'out',
  'tmp',
  '.ssh',
  '.aws',
  '.kube',
  '.gnupg',
]);

const MANIFEST_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'pyproject.toml',
  'requirements.txt',
  'pipfile',
  'poetry.lock',
  'go.mod',
  'go.sum',
  'cargo.toml',
  'cargo.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gemfile',
  'gemfile.lock',
  'composer.json',
  'composer.lock',
  'mix.exs',
  'deno.json',
  'deno.jsonc',
]);

const EXTENSION_LANGUAGES = new Map([
  ['.js', 'JavaScript'], ['.jsx', 'JavaScript'], ['.mjs', 'JavaScript'], ['.cjs', 'JavaScript'],
  ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'],
  ['.py', 'Python'], ['.go', 'Go'], ['.rs', 'Rust'], ['.java', 'Java'],
  ['.kt', 'Kotlin'], ['.rb', 'Ruby'], ['.php', 'PHP'], ['.cs', 'C#'],
  ['.c', 'C'], ['.h', 'C'], ['.cpp', 'C++'], ['.hpp', 'C++'],
  ['.swift', 'Swift'], ['.scala', 'Scala'], ['.sh', 'Shell'], ['.sql', 'SQL'],
]);

const HINT_RULES = {
  entryPoints: /(^|\/)(?:index|main|app|server|bootstrap)\.[a-z0-9]+$|(?:\/|^)(?:app|main)\.(?:jsx|tsx)$/i,
  routes: /(?:^|\/)(?:routes?|router|pages|app|controllers?|handlers?)(?:\/|$)|route|handler/i,
  components: /(?:^|\/)(?:components?|widgets?|views?|ui)(?:\/|$)|\.(?:jsx|tsx)$/i,
  services: /(?:^|\/)(?:services?|lib|utils?|helpers?|clients?|sdk)(?:\/|$)|service/i,
  apis: /(?:^|\/)(?:api|apis|graphql|rest|controllers?)(?:\/|$)|endpoint/i,
  tests: /(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)|\.(?:test|spec)\.[a-z0-9]+$/i,
  docs: /(?:^|\/)(?:docs?|documentation)(?:\/|$)|\.md$/i,
};

/** Absolute directory that holds all project workspaces. */
export function projectDir(workspaceRoot, projectId) {
  return path.join(workspaceRoot, String(projectId));
}

export function getProjectRoot(db, workspaceRoot, projectId) {
  const project = db.prepare('SELECT id, root_path FROM projects WHERE id = ?').get(Number(projectId));
  if (!project) throw new WorkspaceError(404, 'Project not found.');
  const driver = getWorkspaceDriver();
  if (driver.mode !== 'local') return driver.prepare(project.id);
  const storedRoot = project.root_path;
  const root = storedRoot || projectDir(workspaceRoot, project.id);
  try {
    const resolved = fs.realpathSync(root);
    if (!fs.statSync(resolved).isDirectory()) throw new WorkspaceError(400, 'Project root is not a directory.');
    // Imported roots are stored as their canonical real path. If that path now
    // resolves somewhere else (for example a directory was swapped for a
    // symlink or junction), refuse it instead of silently adopting the new
    // target as this project's authorized workspace.
    if (storedRoot && path.resolve(resolved) !== path.resolve(storedRoot)) {
      throw new WorkspaceError(403, 'Project root changed after import; reopen the project.');
    }
    return resolved;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (error.code === 'ENOENT') throw new WorkspaceError(404, 'Project directory not found.');
    throw error;
  }
}

// Narrow, file-specific credential patterns. The old substring rule hid whole
// source trees such as `src/tokens.js` or `token-service/`. A basename is
// blocked only when it looks like an actual secret store; content redaction
// covers embedded credentials in ordinary source files.
const CREDENTIAL_FILE_EXTENSIONS = 'json|ya?ml|toml|ini|txt|csv|properties|conf';
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^.*\.env(?:\..*)?$/i,
  /\.(?:pem|key|p12|pfx|p8|jks|keystore|asc)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/i,
  /^\.(?:npmrc|netrc|htpasswd)$/i,
  /^(?:credentials?|secrets?|tokens?|passwords?|passwd|shadow|pwd|api[_-]?key|api[_-]?token|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|private[_-]?key|database[_-]?url|db[_-]?password)$/i,
  new RegExp(`^(?:.*[_-])?credentials\\.(?:${CREDENTIAL_FILE_EXTENSIONS})$`, 'i'),
  new RegExp(`^application[_-]?default[_-]?credentials\\.(?:${CREDENTIAL_FILE_EXTENSIONS})$`, 'i'),
  new RegExp(`^(?:client[_-]?secret|service[_-]?account|firebase[_-]?adminsdk)(?:[-_].*)?\\.(?:${CREDENTIAL_FILE_EXTENSIONS})$`, 'i'),
  new RegExp(`(?:^|[-_.])(?:secrets?|tokens?|passwords?|credentials?)(?:[-_.].*)?\\.(?:${CREDENTIAL_FILE_EXTENSIONS})$`, 'i'),
];

export function isSensitiveFile(fileName) {
  if (typeof fileName !== 'string') return false;
  const base = path.basename(fileName.replace(/\\/g, '/'));
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

export function isIgnoredWorkspaceDirectory(name) {
  return typeof name === 'string' && SCAN_IGNORED_DIRECTORIES.has(name);
}

export function isProtectedDeploymentConfig(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  const base = path.basename(normalized);
  if (/^(?:render\.ya?ml|vercel\.json|netlify\.toml|fly\.toml|docker-compose.*\.ya?ml|dockerfile.*)$/i.test(base)) {
    return true;
  }
  const segments = normalized.split('/');
  if (segments.includes('.github') || segments.includes('.gitlab')) {
    return true;
  }
  return false;
}

/**
 * Redacts credentials inside otherwise ordinary source files. The shared
 * config redactor handles configured keys and common provider tokens; these
 * extra patterns cover YAML/JSON config, private-key blocks, and JWTs.
 */
export function redactWorkspaceText(text) {
  if (typeof text !== 'string' || !text) return text;
  let safe = redactSecrets(text);
  safe = safe
    .replace(/(-----BEGIN [^-]*PRIVATE KEY-----)[\s\S]*?(-----END [^-]*PRIVATE KEY-----)/g, '$1[redacted credential]$2')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted credential]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted credential]')
    .replace(/(Authorization\s*:\s*(?:Basic|Bearer)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/(["']?)((?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|auth[_-]?token|session[_-]?token|database[_-]?url|db[_-]?password|password|passwd|pwd|secret|token))\1(\s*[:=]\s*)(["']?)([^\s"',;]+)\4/gi, '$1$2$1$3$4[redacted]$4');
  return safe;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Converts one root .gitignore line into a workspace-relative matcher. */
function gitignorePatternToRegExp(pattern) {
  const anchored = pattern.startsWith('/');
  const body = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  let source = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '*') {
      if (body[index + 1] === '*') {
        if (body[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  const prefix = anchored || body.includes('/') ? '' : '(?:.*/)?';
  return new RegExp(`^${prefix}(?:${source})(?:/.*)?$`);
}

/** Reads only the root .gitignore. Its contents are never returned to the model. */
function readRootGitignore(rootDir) {
  const gitignorePath = path.join(rootDir, '.gitignore');
  try {
    // lstat (not stat) so a symlink is rejected instead of following it out of
    // the workspace. Non-regular files are ignored without being read.
    const stat = fs.lstatSync(gitignorePath);
    if (!stat.isFile()) return { patterns: [], error: null };
    if (stat.size > MAX_GITIGNORE_BYTES) {
      return { patterns: [], error: `Root .gitignore exceeds ${MAX_GITIGNORE_BYTES} bytes and was ignored.` };
    }
    const patterns = fs.readFileSync(gitignorePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const negated = line.startsWith('!');
        const body = (negated ? line.slice(1) : line).replace(/\\/g, '/');
        if (!body) return null;
        try {
          return { negated, regex: gitignorePatternToRegExp(body) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { patterns, error: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { patterns: [], error: null };
    return { patterns: [], error: 'Root .gitignore could not be read and was ignored.' };
  }
}

function isIgnoredByGitignore(relativePath, patterns) {
  let ignored = false;
  for (const pattern of patterns) {
    if (pattern.regex.test(relativePath)) ignored = !pattern.negated;
  }
  return ignored;
}

function buildProjectHints(files, manifests) {
  const languages = new Set();
  const frameworks = new Set();
  const projectTypes = new Set();
  const projectMap = Object.fromEntries(Object.keys(HINT_RULES).map((key) => [key, []]));
  const manifestNames = new Set(manifests.map((file) => path.basename(file).toLowerCase()));

  if (manifestNames.has('package.json')) projectTypes.add('Node.js');
  if (manifestNames.has('pyproject.toml') || manifestNames.has('requirements.txt')) projectTypes.add('Python');
  if (manifestNames.has('go.mod')) projectTypes.add('Go');
  if (manifestNames.has('cargo.toml')) projectTypes.add('Rust');
  if (manifestNames.has('pom.xml') || manifestNames.has('build.gradle') || manifestNames.has('build.gradle.kts')) projectTypes.add('Java');
  if (manifestNames.has('gemfile')) projectTypes.add('Ruby');
  if (manifestNames.has('composer.json')) projectTypes.add('PHP');
  if (manifestNames.has('mix.exs')) projectTypes.add('Elixir');
  if (manifestNames.has('deno.json') || manifestNames.has('deno.jsonc')) projectTypes.add('Deno');

  for (const file of files) {
    const lower = file.toLowerCase();
    const extension = path.extname(lower);
    const language = EXTENSION_LANGUAGES.get(extension);
    if (language) languages.add(language);
    if (lower.includes('react') || /\.(?:jsx|tsx)$/.test(lower)) frameworks.add('React');
    if (/(?:^|\/)next\.config\.|(?:\/|^)app\//.test(lower)) frameworks.add('Next.js');
    if (/(?:^|\/)vite\.config\./.test(lower)) frameworks.add('Vite');
    if (/(?:^|\/)express(?:\/|$)/.test(lower)) frameworks.add('Express');
    if (/(?:^|\/)fastify(?:\/|$)/.test(lower)) frameworks.add('Fastify');
    if (/(?:^|\/)django(?:\/|$)/.test(lower)) frameworks.add('Django');
    if (/(?:^|\/)flask(?:\/|$)/.test(lower)) frameworks.add('Flask');
    for (const [key, rule] of Object.entries(HINT_RULES)) {
      if (projectMap[key].length < MAX_SCAN_HINTS && rule.test(file)) projectMap[key].push(file);
    }
  }

  return {
    languageHints: [...languages].sort(),
    frameworkHints: [...frameworks].sort(),
    projectTypes: [...projectTypes].sort(),
    projectMap,
  };
}

/** Creates a directory (and parents) if missing. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  // Reject only real parent traversal (".." itself or ".." + separator).
  // A plain name such as "..notes" is a legal file inside the workspace.
  return rel === '' || (rel !== '..'
    && !rel.startsWith(`..${path.sep}`)
    && !rel.startsWith('../')
    && !path.isAbsolute(rel));
}

/**
 * True when `target` is `root` itself or lives underneath it.
 * Used to confine imported project directories to PROJECT_IMPORT_ROOT.
 */
export function isPathInside(root, target) {
  return isInside(path.resolve(root), path.resolve(target));
}

/**
 * Destination safety for writes: the final path component itself must be a
 * plain file. A symlink or junction (even a dangling one) is refused, and so
 * is a regular file with more than one hard link — writing through either
 * would reach content outside the workspace without ever showing up as a
 * path escape in resolveInside() (which only checks existing links by
 * realpath, and cannot see a link that is itself the destination).
 *
 * `lstat` (not `stat`) is essential: `stat` would follow the link and the
 * check would silently pass for exactly the cases we must reject.
 */
function assertSafeDestination(root, destination) {
  let stat;
  try {
    stat = fs.lstatSync(destination);
  } catch (err) {
    if (err.code === 'ENOENT') return; // nothing there yet: a fresh create is fine
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new WorkspaceError(403, 'Writing through a symlink or junction is not allowed.');
  }
  if (stat.isFile() && stat.nlink > 1) {
    throw new WorkspaceError(403, 'Writing through a hard link is not allowed.');
  }
  const real = fs.realpathSync(destination);
  if (!isInside(root, real)) {
    throw new WorkspaceError(403, 'Path escapes the authorized workspace.');
  }
}

/**
 * Writes `content` to `destination` atomically by creating a fresh temporary
 * file in the same directory (exclusive create) and renaming it over the
 * destination. `rename` replaces the directory entry rather than following
 * it, so a destination that is swapped for a symlink or hard link between
 * validation and the write is never written through: the link itself is
 * replaced atomically, or (for a symlink created by another process at the
 * exact moment of the rename) the rename either succeeds on the entry we
 * validated or fails cleanly — the outside target is never opened.
 *
 * Residual risk that cannot be closed here: a hostile process that swaps a
 * *parent directory* for a symlink between path validation and the write.
 * Closing that requires openat2-style directory handles, which Node does not
 * portably expose. Workspace files are only writable by the same OS user, so
 * this is a documented limitation, not a regression.
 */
function writeFileAtomic(destination, content) {
  const directory = path.dirname(destination);
  const tempPath = path.join(directory, `.myai-tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o644);
    fs.writeSync(fd, content, null, 'utf8');
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, destination);
    return;
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* temp never created or already renamed */ }
    throw error;
  }
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Resolves a user-supplied relative path inside rootDir.
 * Returns { relative, absolute } where `absolute` is a fully resolved
 * real path (symlinks followed) proven to be inside rootDir.
 * Throws WorkspaceError: 400 invalid path, 403 escapes workspace, 404 missing.
 */
export function resolveInside(rootDir, relativePath = '.') {
  if (typeof relativePath !== 'string') {
    throw new WorkspaceError(400, 'Path must be a string.');
  }
  if (relativePath.includes('\0')) {
    throw new WorkspaceError(400, 'Path contains an invalid character.');
  }
  const rel = relativePath.trim() === '' ? '.' : relativePath;
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) {
    throw new WorkspaceError(400, 'Absolute paths are not allowed; use a path relative to the project root.');
  }

  const root = fs.realpathSync(rootDir); // rootDir must already exist
  const candidate = path.resolve(root, rel);
  if (!isInside(root, candidate)) {
    throw new WorkspaceError(403, 'Path escapes the authorized workspace.');
  }

  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (err) {
    if (err.code === 'ENOENT') throw new WorkspaceError(404, `Path not found: ${toPosix(rel)}`);
    throw new WorkspaceError(400, 'Path could not be resolved.');
  }
  // Symlinks/junctions must also land inside the workspace.
  if (!isInside(root, real)) {
    throw new WorkspaceError(403, 'Path escapes the authorized workspace (via link).');
  }

  return { relative: toPosix(path.relative(root, real)) || '.', absolute: real };
}

/** Lists a directory inside the workspace. Never follows links outside it. */
export function listDirectory(rootDir, relativePath = '.') {
  const target = resolveInside(rootDir, relativePath);
  let entries;
  try {
    entries = fs.readdirSync(target.absolute, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw new WorkspaceError(404, `Path not found: ${target.relative}`);
    if (err.code === 'ENOTDIR') throw new WorkspaceError(400, 'Path is not a directory.');
    throw err;
  }

  const items = entries
    .filter((entry) => !isIgnoredWorkspaceDirectory(entry.name)
      && !(isSensitiveFile(entry.name) && !entry.isDirectory()))
    .map((entry) => {
    const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
    let size;
    if (type === 'file') {
      try {
        size = fs.statSync(path.join(target.absolute, entry.name)).size;
      } catch {
        size = undefined; // entry vanished between readdir and stat
      }
    }
    return size === undefined ? { name: entry.name, type } : { name: entry.name, type, size };
    });

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    path: target.relative,
    items: items.slice(0, MAX_LIST_ENTRIES),
    truncated: items.length > MAX_LIST_ENTRIES,
    total: items.length,
  };
}

/** Reads a UTF-8 text file inside the workspace (size- and binary-checked). */
export function readTextFile(rootDir, relativePath) {
  const target = resolveInside(rootDir, relativePath);
  if (isSensitiveFile(path.basename(target.absolute))) {
    throw new WorkspaceError(403, 'Sensitive credential files cannot be read by the assistant.');
  }
  const stat = fs.statSync(target.absolute);
  if (stat.isDirectory()) {
    throw new WorkspaceError(400, 'Path is a directory, not a file.');
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new WorkspaceError(413, `File is too large to display (limit ${MAX_READ_BYTES} bytes).`);
  }
  const buffer = fs.readFileSync(target.absolute);
  const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) {
    throw new WorkspaceError(415, 'Binary files cannot be displayed as text.');
  }
  return {
    path: target.relative,
    size: stat.size,
    content: redactWorkspaceText(buffer.toString('utf8')),
    redacted: true,
  };
}

export function createTextFile(rootDir, relativePath, content, { allowDeployment = false } = {}) {
  if (typeof content !== 'string') throw new WorkspaceError(400, 'File content must be text.');
  if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
    throw new WorkspaceError(413, `File content exceeds the ${MAX_READ_BYTES}-byte limit.`);
  }
  const { destination, relative } = prepareWrite(rootDir, relativePath,
    'The assistant cannot create credential or environment files.', { allowDeployment });
  if (fs.existsSync(destination)) throw new WorkspaceError(409, 'File already exists; create_file will not overwrite it.');
  try {
    // 'wx' is an atomic exclusive create, so a concurrent create_file for the
    // same path loses cleanly with a 409 instead of a raw EEXIST failure.
    fs.writeFileSync(destination, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new WorkspaceError(409, 'File already exists; create_file will not overwrite it.');
    throw error;
  }
  afterWorkspaceWrite(rootDir, relative, 'create', null);
  return { path: relative, size: Buffer.byteLength(content, 'utf8') };
}

/**
 * Pure validation for a relative write path: shape, escape, and credential
 * checks with no filesystem side effects. Returns the normalized path.
 * Shared by prepareWrite (writes) and the preview route (dry runs).
 */
export function validateWritePath(relativePath, sensitiveMessage, { allowDeployment = false } = {}) {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')
    || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new WorkspaceError(400, 'Use a valid relative file path inside the project.');
  }
  const normalized = path.normalize(relativePath);
  if (normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new WorkspaceError(403, 'Path escapes the authorized workspace.');
  }
  if (isSensitiveFile(path.basename(normalized))) {
    throw new WorkspaceError(403, sensitiveMessage);
  }
  if (!allowDeployment && isProtectedDeploymentConfig(normalized)) {
    throw new WorkspaceError(403, 'Deployment, CI/CD, and cloud infrastructure configuration files cannot be modified through the assistant without explicit user approval.');
  }
  return normalized;
}

/**
 * Validates a relative path for writing and creates missing parent folders.
 * Returns { root, destination, relative } where `destination` is proven to be
 * inside the workspace root. Shared by createTextFile/writeTextFile so both
 * enforce identical traversal and credential-file guards.
 */
function prepareWrite(rootDir, relativePath, sensitiveMessage, { allowDeployment = false } = {}) {
  const normalized = validateWritePath(relativePath, sensitiveMessage, { allowDeployment });
  const root = fs.realpathSync(rootDir);
  const segments = normalized.split(path.sep);
  const parentSegments = segments.slice(0, -1);
  let parentPath = root;
  for (const segment of parentSegments) {
    const candidate = path.join(parentPath, segment);
    if (!fs.existsSync(candidate)) {
      // Ensure the parent path exists; if the candidate is a dangling symlink
      // then mkdir will fail with ENOTDIR, which is safe and consistent.
      try {
        fs.mkdirSync(candidate);
      } catch (err) {
        if (err.code === 'ENOTDIR') {
          // candidate was a broken symlink; treat it as an escape attempt.
          throw new WorkspaceError(403, 'Path escapes the authorized workspace.');
        }
        throw err;
      }
    }
    const real = fs.realpathSync(candidate);
    if (!isInside(root, real) || !fs.statSync(real).isDirectory()) {
      throw new WorkspaceError(403, 'Path escapes the authorized workspace.');
    }
    parentPath = real;
  }
  const destination = path.join(parentPath, segments.at(-1));
  assertSafeDestination(root, destination);
  return { root, destination, relative: toPosix(path.relative(rootDir, destination)) };
}

/**
 * Creates or replaces a UTF-8 text file inside the workspace (human edit path).
 * Returns { path, created, size, previous } — `previous` is the old text for
 * existing files (null when the file is new), so callers can build a diff.
 */
export function writeTextFile(rootDir, relativePath, content) {
  if (typeof content !== 'string') throw new WorkspaceError(400, 'File content must be text.');
  if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
    throw new WorkspaceError(413, `File content exceeds the ${MAX_READ_BYTES}-byte limit.`);
  }
  const { root, destination, relative } = prepareWrite(rootDir, relativePath,
    'Credential or environment files cannot be edited through the workspace API.');

  const exists = fs.existsSync(destination);
  let previous = null;
  if (exists) {
    const stat = fs.statSync(destination);
    if (stat.isDirectory()) throw new WorkspaceError(400, 'Path is a directory, not a file.');
    if (stat.size > MAX_READ_BYTES) {
      throw new WorkspaceError(413, `Existing file is too large to edit (limit ${MAX_READ_BYTES} bytes).`);
    }
    const buffer = fs.readFileSync(destination);
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      throw new WorkspaceError(415, 'Binary files cannot be edited as text.');
    }
    previous = buffer.toString('utf8');
  }
  // Re-check immediately before writing so a same-tick link swap is caught,
  // and write atomically (temp file + rename in the destination directory) so
  // a destination swapped for a link afterwards is never written through.
  assertSafeDestination(root, destination);
  writeFileAtomic(destination, content);
  afterWorkspaceWrite(rootDir, relative, exists ? 'update' : 'create', previous);
  return { path: relative, created: !exists, size: Buffer.byteLength(content, 'utf8'), previous };
}

/**
 * Deletes a file (or an empty directory) inside the workspace.
 * Directories that still contain entries are refused, credential files are
 * refused, and the project root itself can never be deleted.
 * Returns { path, type, size?, previous } — `previous` is the old text when
 * the deleted file was a readable text file (null otherwise).
 */
export function deletePath(rootDir, relativePath) {
  const target = resolveInside(rootDir, relativePath);
  if (target.relative === '.') {
    throw new WorkspaceError(400, 'The project root cannot be deleted.');
  }
  if (isSensitiveFile(path.basename(target.absolute)) || isProtectedDeploymentConfig(target.relative)) {
    throw new WorkspaceError(403, 'Credential, environment, and deployment configuration files cannot be deleted through the workspace API.');
  }
  const stat = fs.statSync(target.absolute);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(target.absolute);
    if (entries.length > 0) {
      throw new WorkspaceError(400, 'Directory is not empty; delete its files first.');
    }
    fs.rmdirSync(target.absolute);
    return { path: target.relative, type: 'directory', previous: null };
  }
  const buffer = fs.readFileSync(target.absolute);
  const binary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  fs.unlinkSync(target.absolute);
  afterWorkspaceWrite(rootDir, target.relative, 'delete', buffer);
  return {
    path: target.relative,
    type: 'file',
    size: stat.size,
    previous: binary ? null : buffer.toString('utf8'),
  };
}

export function replaceTextFile(rootDir, relativePath, expectedContent, content, { allowDeployment = false } = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
    throw new WorkspaceError(413, `Updated file must be text and no larger than ${MAX_READ_BYTES} bytes.`);
  }
  if (!allowDeployment && isProtectedDeploymentConfig(relativePath)) {
    throw new WorkspaceError(403, 'Deployment, CI/CD, and cloud infrastructure configuration files cannot be modified without explicit user approval.');
  }
  const target = resolveInside(rootDir, relativePath);
  const root = fs.realpathSync(rootDir);
  assertSafeDestination(root, target.absolute);
  const current = readTextFile(rootDir, relativePath);
  if (current.content !== expectedContent) {
    throw new WorkspaceError(409, 'File changed since the proposal was prepared. Re-read it and create a fresh proposal.');
  }
  // The 409 check above is advisory for content, never a path boundary; the
  // atomic rename is what guarantees no link is written through.
  writeFileAtomic(target.absolute, content);
  afterWorkspaceWrite(rootDir, target.relative, 'update', current.content);
  return { path: target.relative, size: Buffer.byteLength(content, 'utf8') };
}

/**
 * Recursively maps the selected workspace without ever leaving it.
 * The optional limits are used by tests; normal callers get the safe defaults.
 */
export function scanDirectory(rootDir, relativePath = '.', options = {}) {
  const root = resolveInside(rootDir, relativePath);
  const projectRoot = fs.realpathSync(rootDir);
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : MAX_SCAN_FILES;
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0 ? options.maxDepth : MAX_SCAN_DEPTH;
  const maxDirectories = Number.isInteger(options.maxDirectories) && options.maxDirectories > 0
    ? options.maxDirectories
    : MAX_SCAN_DIRECTORIES;
  const { patterns, error: gitignoreError } = readRootGitignore(projectRoot);
  const files = [];
  const directories = [];
  const errors = gitignoreError ? [gitignoreError] : [];
  let skipped = 0;
  let hitLimit = false;
  let hitDepth = false;

  const relativeToProjectRoot = (absolute) => toPosix(path.relative(projectRoot, absolute));
  const relativeToScanRoot = (absolute) => toPosix(path.relative(root.absolute, absolute)) || '.';

  const visit = (directory, depth) => {
    if (depth > maxDepth) {
      hitDepth = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      errors.push(`Could not read directory: ${relativeToScanRoot(directory)}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const isDirectory = entry.isDirectory();
      const isFile = entry.isFile();
      // Symlinks are neither: they are skipped here and never followed.
      if (!isDirectory && !isFile) {
        skipped += 1;
        continue;
      }
      if (isIgnoredWorkspaceDirectory(entry.name)
        || (isSensitiveFile(entry.name) && !isDirectory)) {
        skipped += 1;
        continue;
      }
      const projectRelative = relativeToProjectRoot(absolute) || entry.name;
      if (isIgnoredByGitignore(projectRelative, patterns)) {
        skipped += 1;
        continue;
      }
      const scanRelative = relativeToScanRoot(absolute);
      if (isDirectory) {
        if (directories.length >= maxDirectories) {
          hitLimit = true;
          skipped += 1;
          continue;
        }
        directories.push(scanRelative);
        visit(absolute, depth + 1);
      } else if (files.length >= maxFiles) {
        hitLimit = true;
        skipped += 1;
      } else {
        files.push(scanRelative);
      }
    }
  };
  visit(root.absolute, 0);

  files.sort((a, b) => a.localeCompare(b));
  directories.sort((a, b) => a.localeCompare(b));
  const manifests = files.filter((file) => MANIFEST_FILES.has(path.basename(file).toLowerCase()));
  return {
    path: root.relative,
    files,
    directories,
    manifests,
    ...buildProjectHints(files, manifests),
    skipped,
    errors,
    truncated: hitLimit || hitDepth,
    limits: {
      maxFiles,
      maxDepth,
      maxDirectories,
      maxHintsPerCategory: MAX_SCAN_HINTS,
    },
  };
}

export function searchWorkspace(rootDir, query, { maxResults = 50 } = {}) {
  if (typeof query !== 'string' || query.trim().length < 2) {
    throw new WorkspaceError(400, 'Search query must contain at least two characters.');
  }
  const scanned = scanDirectory(rootDir);
  const results = [];
  const needle = query.toLowerCase();
  for (const relativePath of scanned.files) {
    if (isSensitiveFile(path.basename(relativePath))) continue;
    const absolute = resolveInside(rootDir, relativePath).absolute;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) continue;
      const buffer = fs.readFileSync(absolute);
      if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
      const content = redactWorkspaceText(buffer.toString('utf8'));
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(needle)) {
          results.push({ path: relativePath, line: index + 1, content: line.slice(0, 300) });
        }
      });
    } catch (error) {
      if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
    }
    if (results.length >= maxResults) break;
  }
  return {
    results,
    truncated: scanned.truncated || results.length >= maxResults,
    limit: maxResults,
    redacted: true,
  };
}

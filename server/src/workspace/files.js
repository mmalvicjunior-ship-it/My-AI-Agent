// Path-safe workspace file operations.
// Every function here confines access to a single project directory:
// absolute paths, traversal ("../"), null bytes, and symlinks that point
// outside the authorized workspace are rejected with a WorkspaceError.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_READ_BYTES = 1024 * 1024; // 1 MiB per file read
export const MAX_LIST_ENTRIES = 1000;
export const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage']);
export const MAX_SCAN_FILES = 5000;
export const MAX_SCAN_DEPTH = 12;
const BINARY_SNIFF_BYTES = 8000;

export class WorkspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
  }
}

/** Absolute directory that holds all project workspaces. */
export function projectDir(workspaceRoot, projectId) {
  return path.join(workspaceRoot, String(projectId));
}

export function getProjectRoot(db, workspaceRoot, projectId) {
  const project = db.prepare('SELECT id, root_path FROM projects WHERE id = ?').get(Number(projectId));
  if (!project) throw new WorkspaceError(404, 'Project not found.');
  const root = project.root_path || projectDir(workspaceRoot, project.id);
  try {
    const resolved = fs.realpathSync(root);
    if (!fs.statSync(resolved).isDirectory()) throw new WorkspaceError(400, 'Project root is not a directory.');
    return resolved;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (error.code === 'ENOENT') throw new WorkspaceError(404, 'Project directory not found.');
    throw error;
  }
}

export function isSensitiveFile(fileName) {
  return /^(?:\.env(?:\..*)?|.*\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$/i.test(fileName)
    || /(?:secret|credential|token|password)/i.test(fileName);
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

/** Creates a directory (and parents) if missing. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
    .filter((entry) => !IGNORED_DIRECTORIES.has(entry.name) && !isSensitiveFile(entry.name))
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
  return { path: target.relative, size: stat.size, content: buffer.toString('utf8') };
}

export function createTextFile(rootDir, relativePath, content, { allowDeployment = false } = {}) {
  if (typeof content !== 'string') throw new WorkspaceError(400, 'File content must be text.');
  if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
    throw new WorkspaceError(413, `File content exceeds the ${MAX_READ_BYTES}-byte limit.`);
  }
  const { destination, relative } = prepareWrite(rootDir, relativePath,
    'The assistant cannot create credential or environment files.', { allowDeployment });
  if (fs.existsSync(destination)) throw new WorkspaceError(409, 'File already exists; create_file will not overwrite it.');
  fs.writeFileSync(destination, content, { encoding: 'utf8', flag: 'wx' });
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
    if (!fs.existsSync(candidate)) fs.mkdirSync(candidate);
    const real = fs.realpathSync(candidate);
    if (!isInside(root, real) || !fs.statSync(real).isDirectory()) {
      throw new WorkspaceError(403, 'Path escapes the authorized workspace.');
    }
    parentPath = real;
  }
  const destination = path.join(parentPath, segments.at(-1));
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
  const { destination, relative } = prepareWrite(rootDir, relativePath,
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
  fs.writeFileSync(destination, content, 'utf8');
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
  const current = readTextFile(rootDir, relativePath);
  if (current.content !== expectedContent) {
    throw new WorkspaceError(409, 'File changed since the proposal was prepared. Re-read it and create a fresh proposal.');
  }
  const target = resolveInside(rootDir, relativePath);
  fs.writeFileSync(target.absolute, content, 'utf8');
  return { path: target.relative, size: Buffer.byteLength(content, 'utf8') };
}

export function scanDirectory(rootDir, relativePath = '.') {
  const root = resolveInside(rootDir, relativePath);
  const files = [];
  const visit = (directory, depth) => {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_SCAN_FILES) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name) || isSensitiveFile(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (entry.isFile()) files.push(toPosix(path.relative(root.absolute, absolute)));
      if (files.length >= MAX_SCAN_FILES) break;
    }
  };
  visit(root.absolute, 0);
  return { path: root.relative, files, truncated: files.length >= MAX_SCAN_FILES };
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
    let stat;
    try {
      stat = fs.statSync(absolute);
      if (stat.size > MAX_READ_BYTES) continue;
      const content = fs.readFileSync(absolute, 'utf8');
      if (content.includes('\0')) continue;
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
  return { results, truncated: scanned.truncated || results.length >= maxResults };
}

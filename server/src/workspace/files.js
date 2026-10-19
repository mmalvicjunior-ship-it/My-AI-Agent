// Path-safe workspace file operations.
// Every function here confines access to a single project directory:
// absolute paths, traversal ("../"), null bytes, and symlinks that point
// outside the authorized workspace are rejected with a WorkspaceError.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_READ_BYTES = 1024 * 1024; // 1 MiB per file read
export const MAX_LIST_ENTRIES = 1000;
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

  const items = entries.map((entry) => {
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

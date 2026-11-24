// Bounded discovery of likely software projects inside an explicitly
// authorized import root. This module never walks outside that root, never
// reads file contents, and returns only relative/opaque identifiers to callers.
import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRECTORIES, isPathInside } from './files.js';

export const DISCOVERY_MAX_DEPTH = 2;
export const DISCOVERY_MAX_PROJECTS = 240;
export const DISCOVERY_MAX_ENTRIES_PER_DIRECTORY = 400;
export const DISCOVERY_MAX_MARKER_ENTRIES = 200;
export const DISCOVERY_MAX_ID_LENGTH = 512;
export const DISCOVERY_MAX_RELATIVE_PATH_LENGTH = 1024;

// Only these names are ever reported to a client. Directories are checked by
// name alone; their contents are never read during discovery.
const MARKER_NAMES = new Map([
  ['package.json', 'package.json'],
  ['pyproject.toml', 'pyproject.toml'],
  ['cargo.toml', 'Cargo.toml'],
  ['go.mod', 'go.mod'],
  ['pom.xml', 'pom.xml'],
  ['build.gradle', 'build.gradle'],
  ['build.gradle.kts', 'build.gradle'],
  ['.git', '.git'],
  ['src', 'src'],
  ['lib', 'lib'],
  ['app', 'app'],
  ['test', 'test'],
  ['tests', 'tests'],
  ['docs', 'docs'],
  ['doc', 'docs'],
]);

const STRONG_MARKERS = new Set([
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  '.git',
]);

const TECHNOLOGY_BY_MARKER = new Map([
  ['package.json', 'Node.js'],
  ['pyproject.toml', 'Python'],
  ['Cargo.toml', 'Rust'],
  ['go.mod', 'Go'],
  ['pom.xml', 'Java'],
  ['build.gradle', 'Java'],
  ['.git', 'Git'],
]);

const IGNORED_NAMES = new Set([
  ...IGNORED_DIRECTORIES,
  '.git',
  '.github',
  '.vscode',
  '.idea',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'out',
  'tmp',
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function safeRelativePath(root, absolute) {
  const relative = toPosix(path.relative(root, absolute));
  if (!relative || relative === '.' || relative.includes('\\')) return null;
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) return null;
  if (relative.startsWith('../') || relative === '..') return null;
  return relative;
}

/** Canonical dedupe key. Windows paths are case-insensitive. */
export function discoveryDedupeKey(realPath) {
  const resolved = path.resolve(realPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Enumerates candidate project directories under `root`. Only immediate
 * children and their immediate children are considered. Symlinks/junctions,
 * hidden names, ignored build/dependency folders, and anything resolving
 * outside `root` are skipped.
 */
export function collectProjectCandidates({
  root,
  readdir = (directory) => fs.readdirSync(directory, { withFileTypes: true }),
  lstat = (target) => fs.lstatSync(target),
  realpath = (target) => fs.realpathSync(target),
  stat = (target) => fs.statSync(target),
  isInside = (target) => isPathInside(root, target),
  maxDepth = DISCOVERY_MAX_DEPTH,
  maxProjects = DISCOVERY_MAX_PROJECTS,
  maxEntriesPerDirectory = DISCOVERY_MAX_ENTRIES_PER_DIRECTORY,
} = {}) {
  const rootPath = path.resolve(root);
  const candidates = [];
  const seen = new Set();
  let truncated = false;

  const visit = (directory, depth) => {
    if (depth >= maxDepth || candidates.length >= maxProjects) {
      if (candidates.length >= maxProjects) truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdir(directory);
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;
    const bounded = entries.slice(0, maxEntriesPerDirectory);
    if (entries.length > bounded.length) truncated = true;
    bounded.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));

    for (const entry of bounded) {
      if (candidates.length >= maxProjects) {
        truncated = true;
        break;
      }
      const name = String(entry?.name || '');
      if (!name || name.startsWith('.')) continue;
      if (IGNORED_NAMES.has(name.toLowerCase())) continue;
      const isDirectory = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false;
      const isSymbolicLink = typeof entry.isSymbolicLink === 'function' ? entry.isSymbolicLink() : false;
      if (!isDirectory || isSymbolicLink) continue;

      const absolutePath = path.join(directory, name);
      let realPath;
      try {
        const linkStat = lstat(absolutePath);
        if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) continue;
        realPath = realpath(absolutePath);
        if (!isInside(realPath)) continue;
        if (!stat(realPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const relativePath = safeRelativePath(rootPath, absolutePath);
      if (!relativePath) continue;

      const key = discoveryDedupeKey(realPath);
      if (seen.has(key)) continue;
      seen.add(key);
      const childDepth = depth + 1;
      candidates.push({ name, relativePath, absolutePath, realPath, depth: childDepth });
      if (childDepth < maxDepth) visit(absolutePath, childDepth);
    }
  };

  visit(rootPath, 0);
  return { candidates, truncated };
}

/** Removes repeated canonical targets while preserving discovery order. */
export function dedupeProjectCandidates(candidates = []) {
  const seen = new Set();
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    if (!candidate?.relativePath || !candidate?.realPath) return false;
    const key = discoveryDedupeKey(candidate.realPath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Rechecks every discovered canonical path immediately before it is used.
 * A directory swapped for a symlink/junction after enumeration cannot cause
 * marker names to be read from outside the authorized root.
 */
export function revalidateProjectCandidates({
  candidates = [],
  root,
  realpath = (target) => fs.realpathSync(target),
  isInside = (target) => isPathInside(root, target),
} = {}) {
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    if (!candidate?.realPath) return false;
    try {
      const current = realpath(candidate.realPath);
      return isInside(current) && path.resolve(current) === path.resolve(candidate.realPath);
    } catch {
      return false;
    }
  });
}

/** Reads allowlisted marker names only. No file content is opened. */
export function inspectProjectMarkers({
  absolutePath,
  readdir = (directory) => fs.readdirSync(directory, { withFileTypes: true }),
  maxEntries = DISCOVERY_MAX_MARKER_ENTRIES,
} = {}) {
  if (typeof absolutePath !== 'string' || !absolutePath) return { markers: [], entries: [] };
  let entries;
  try {
    entries = readdir(absolutePath);
  } catch {
    return { markers: [], entries: [] };
  }
  if (!Array.isArray(entries)) return { markers: [], entries: [] };
  const bounded = entries.slice(0, maxEntries);
  const markers = [];
  for (const entry of bounded) {
    const name = String(entry?.name || '');
    if (!name) continue;
    if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue;
    const canonical = MARKER_NAMES.get(name.toLowerCase());
    if (!canonical || markers.includes(canonical)) continue;
    const isDirectory = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false;
    if (canonical !== '.git' && (canonical === 'src' || canonical === 'lib' || canonical === 'app'
      || canonical === 'test' || canonical === 'tests' || canonical === 'docs')) {
      if (!isDirectory) continue;
    }
    markers.push(canonical);
  }
  return { markers, entries: bounded.map((entry) => entry?.name).filter(Boolean) };
}

function displayName(name) {
  const cleaned = String(name || '').replace(/[-_]+/g, ' ').trim();
  if (!cleaned) return 'Project';
  const title = cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
  return title.split(/\s+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** Turns allowlisted markers into safe display metadata. */
export function classifyProjectCandidate({ name = '', markers = [] } = {}) {
  const names = Array.isArray(markers) ? markers : [];
  const technologies = [];
  for (const marker of names) {
    const technology = TECHNOLOGY_BY_MARKER.get(marker);
    if (technology && !technologies.includes(technology)) technologies.push(technology);
  }
  const strong = names.filter((marker) => STRONG_MARKERS.has(marker));
  const focus = strong.length ? strong : names;
  const description = focus.length
    ? `Likely project · ${focus.slice(0, 3).join(', ')}`
    : 'Project folder';
  return { name: displayName(name), description, technologies, markers: names };
}

/** Opaque, relative-path-only identifier. Absolute paths never enter it. */
export function encodeDiscoveryId(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath
    || relativePath.length > DISCOVERY_MAX_RELATIVE_PATH_LENGTH
    || relativePath.includes('\0') || relativePath.includes('\\')) return null;
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return null;
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (path.posix.normalize(relativePath) !== relativePath) return null;
  const encoded = Buffer.from(relativePath, 'utf8').toString('base64url');
  const id = `v1.${encoded}`;
  return id.length <= DISCOVERY_MAX_ID_LENGTH ? id : null;
}

/** Strict inverse of encodeDiscoveryId; returns null for any unsafe value. */
export function decodeDiscoveryId(id) {
  if (typeof id !== 'string' || !id || id.length > DISCOVERY_MAX_ID_LENGTH) return null;
  const match = /^v1\.([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) return null;
  const encoded = match[1];
  let relativePath;
  try {
    relativePath = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!relativePath || relativePath.length > DISCOVERY_MAX_RELATIVE_PATH_LENGTH
    || relativePath.includes('\0') || relativePath.includes('\\')) return null;
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return null;
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (path.posix.normalize(relativePath) !== relativePath) return null;
  // Reject non-canonical base64url spellings of the same bytes.
  if (Buffer.from(relativePath, 'utf8').toString('base64url') !== encoded) return null;
  return relativePath;
}

/**
 * Builds the client-safe discovery payload. `ownedByRealPath` is keyed by
 * discoveryDedupeKey() and may only contain the requesting user's projects.
 */
export function buildDiscoveryResults({
  candidates = [],
  inspect = inspectProjectMarkers,
  ownedByRealPath = new Map(),
} = {}) {
  const results = [];
  for (const candidate of dedupeProjectCandidates(candidates)) {
    const inspection = inspect(candidate) || {};
    const classified = classifyProjectCandidate({ name: candidate.name, markers: inspection.markers });
    const discoveryId = encodeDiscoveryId(candidate.relativePath);
    if (!discoveryId) continue;
    results.push({
      discoveryId,
      name: classified.name,
      description: classified.description,
      technologies: classified.technologies,
      markers: classified.markers,
      alreadyOpenedProjectId: ownedByRealPath instanceof Map
        ? ownedByRealPath.get(discoveryDedupeKey(candidate.realPath)) ?? null
        : null,
    });
  }
  results.sort((a, b) => {
    const openedA = a.alreadyOpenedProjectId ? 0 : 1;
    const openedB = b.alreadyOpenedProjectId ? 0 : 1;
    return openedA - openedB || a.name.localeCompare(b.name);
  });
  return results;
}

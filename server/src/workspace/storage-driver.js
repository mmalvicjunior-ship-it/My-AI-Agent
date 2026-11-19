// Workspace storage adapters.
//
// local:      the original synchronous filesystem behavior (default).
// s3/memory:  a project workspace is mirrored into a per-project local cache
// directory, and every successful text write/delete is pushed back to the
// object store. The cache exists because the app (and `npm run` checks) need a
// real directory; the object store remains the durable source of truth.
//
// The mirror is pull-once-per-project per process. A single Render Free
// instance is assumed; multiple instances would need a lock or a shared cache.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createStorageBridge } from '../storage/bridge.js';
import { WorkspaceError } from './errors.js';

let singleton = null;

function normalizeRelative(relativePath) {
  const value = String(relativePath || '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    throw new WorkspaceError(400, 'Use a valid relative path inside the project.');
  }
  return normalized;
}

export function createWorkspaceDriver(cfg = config) {
  const mode = cfg.workspaceStorage || 'local';
  const noTestHooks = {
    failNextPut() {},
    failNextDelete() {},
    failNextPrepare() {},
    failNextHydrationGet() {},
    forgetPrepared() {},
  };
  if (mode === 'local') {
    return {
      mode,
      ...noTestHooks,
      prepare() { return null; },
      afterWrite() {},
      close() {},
    };
  }

  const bridge = createStorageBridge({
    config: cfg,
    backend: 'object',
    timeoutMs: cfg.storageBridgeTimeoutMs,
  });
  const prepared = new Set();
  const rootToProject = new Map();
  const cacheBase = path.join(cfg.workspaceRoot, '.object-cache');
  let nextPrepareFailure = null;
  let nextHydrationGetFailure = null;
  let nextDeleteFailure = null;

  function objectPrefix(projectId) {
    // The object store applies WORKSPACE_S3_PREFIX once. Keep this part
    // project-relative so both S3 and the in-memory test store agree.
    return String(projectId);
  }

  function objectKey(projectId, relativePath) {
    return `${objectPrefix(projectId)}/${normalizeRelative(relativePath)}`;
  }

  function cacheRoot(projectId) {
    return path.join(cacheBase, String(projectId));
  }

  function prepare(projectId) {
    const id = Number(projectId);
    const root = cacheRoot(id);
    if (prepared.has(id)) return root;

    fs.mkdirSync(cacheBase, { recursive: true });
    const tempRoot = fs.mkdtempSync(path.join(cacheBase, `.hydrate-${id}-`));
    try {
      if (nextPrepareFailure) {
        const message = nextPrepareFailure;
        nextPrepareFailure = null;
        throw new Error(message);
      }
      const listing = bridge.call('object', { op: 'list', prefix: objectPrefix(id) });
      for (const entry of listing.entries || []) {
        const relative = normalizeRelative(entry.name);
        const destination = path.join(tempRoot, ...relative.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (nextHydrationGetFailure) {
          const message = nextHydrationGetFailure;
          nextHydrationGetFailure = null;
          throw new Error(message);
        }
        const object = bridge.call('object', { op: 'get', key: objectKey(id, relative) });
        fs.writeFileSync(destination, String(object.content ?? ''), 'utf8');
      }

      // Swap only after a complete hydration, so a failure can never leave a
      // partially populated cache that looks authoritative after a restart.
      if (fs.existsSync(root)) {
        const backup = path.join(cacheBase, `.backup-${id}-${crypto.randomBytes(6).toString('hex')}`);
        fs.renameSync(root, backup);
        try {
          fs.renameSync(tempRoot, root);
        } catch (error) {
          fs.renameSync(backup, root);
          throw error;
        }
        fs.rmSync(backup, { recursive: true, force: true });
      } else {
        fs.renameSync(tempRoot, root);
      }
      prepared.add(id);
      rootToProject.set(path.resolve(root), id);
      return root;
    } catch (error) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      throw error;
    }
  }

  function restoreLocalFile(absolute, previousContent) {
    if (previousContent === null || previousContent === undefined) {
      try { fs.unlinkSync(absolute); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return;
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, previousContent);
  }

  function afterWrite(rootDir, relativePath, action = 'update', previousContent = null) {
    const id = rootToProject.get(path.resolve(rootDir));
    if (!id) return; // A local/imported path is not mirrored to object storage.
    const key = objectKey(id, relativePath);
    const absolute = path.join(path.resolve(rootDir), ...normalizeRelative(relativePath).split('/'));
    try {
      if (action === 'delete') {
        if (nextDeleteFailure) {
          const message = nextDeleteFailure;
          nextDeleteFailure = null;
          throw new Error(message);
        }
        bridge.call('object', { op: 'delete', key });
      } else {
        const content = fs.readFileSync(absolute, 'utf8');
        bridge.call('object', { op: 'put', key, content });
      }
    } catch (error) {
      // The local mutation already happened. Restore the exact pre-request
      // state so a failed remote write never looks successful on a later GET.
      try { restoreLocalFile(absolute, previousContent); } catch { /* keep the storage error */ }
      const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 503;
      throw new WorkspaceError(status, `Workspace object storage write failed: ${error.message}`);
    }
  }

  return {
    mode,
    prepare,
    afterWrite,
    readObject(projectId, relativePath) {
      return bridge.call('object', { op: 'get', key: objectKey(projectId, relativePath) });
    },
    // Test-only failure injection hooks; harmless no-ops in local mode.
    failNextPut(message) {
      bridge.call('object', { op: 'failNextPut', message });
    },
    failNextDelete(message = 'Injected object storage delete failure.') {
      nextDeleteFailure = message;
    },
    failNextPrepare(message = 'Injected workspace hydration failure.') {
      nextPrepareFailure = message;
    },
    failNextHydrationGet(message = 'Injected workspace hydration read failure.') {
      nextHydrationGetFailure = message;
    },
    forgetPrepared(projectId) {
      prepared.delete(Number(projectId));
      rootToProject.delete(path.resolve(cacheRoot(projectId)));
    },
    close() {
      bridge.close();
      prepared.clear();
      rootToProject.clear();
    },
  };
}

export function getWorkspaceDriver() {
  if (!singleton) {
    singleton = createWorkspaceDriver(config);
    if (singleton.mode !== 'local') {
      process.once('exit', () => {
        try { singleton?.close(); } catch { /* best effort during shutdown */ }
      });
    }
  }
  return singleton;
}

export function afterWorkspaceWrite(rootDir, relativePath, action, previousContent) {
  return getWorkspaceDriver().afterWrite(rootDir, relativePath, action, previousContent);
}

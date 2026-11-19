// Synchronous facade over asynchronous storage backends (Postgres / S3).
//
// The existing application is deliberately synchronous: it uses node:sqlite
// and synchronous fs calls, and 40+ tests call createApp()/openDb() without
// await. Rewriting the whole app to async would change behavior and break those
// call sites. Instead, this bridge runs the async drivers in a worker thread
// and blocks the calling thread on a SharedArrayBuffer handshake.
//
// IMPORTANT TRADE-OFF: while a remote query is in flight the Node event loop is
// blocked. This matches the current synchronous SQLite behavior (one query at
// a time), but remote latency is higher. This is acceptable for the low-traffic
// free-tier deployment this module targets; it is not intended for high
// concurrency. A zero-latency async path remains the native SQLite adapter.
//
// The worker publishes fatal errors and a heartbeat into the same shared
// memory, so a crash or stopped worker is reported while the caller is blocked
// instead of silently consuming the whole request timeout.

import { Worker } from 'node:worker_threads';

const CTRL_READY = 0;
const CTRL_REQUEST = 1;
const CTRL_RESPONSE = 2;
const CTRL_ERROR = 3;
const CTRL_FATAL = 5;
const CTRL_FATAL_LENGTH = 6;
const CTRL_LENGTH = 7;
const BUFFER_BYTES = 8 * 1024 * 1024; // 8 MiB request/response envelopes
const FATAL_BYTES = 4096; // Bounded, redacted fatal-error payload

let bridgeCounter = 0;

function redact(text, config) {
  if (typeof text !== 'string' || !text) return text;
  let safe = text;
  for (const secret of [config?.databaseUrl, config?.workspaceS3SecretKey]) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe
    .replace(/((?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(?:sk-|key_|ghp_|gho_|xox[baprs]-|AIza)[A-Za-z0-9_*.-]{8,}/gi, '[redacted credential]')
    .slice(0, 1000);
}

function readFatal(fatalBytes, fatalView, control, config, decoder) {
  if (Atomics.load(control, CTRL_FATAL) !== 1) return null;
  const length = Math.max(0, Math.min(fatalView.getUint32(0, true), fatalBytes.byteLength - 4));
  let payload = null;
  try {
    payload = JSON.parse(decoder.decode(fatalBytes.subarray(4, 4 + length)));
  } catch {
    // A malformed fatal payload still means the worker failed.
  }
  const error = new Error(redact(payload?.message || 'Storage worker failed.', config));
  error.name = payload?.name || 'StorageError';
  error.code = payload?.code || null;
  error.status = payload?.status || null;
  return error;
}

function waitFor({
  control,
  index,
  expected,
  timeoutMs,
  label,
  fatalBytes,
  fatalView,
  heartbeat,
  heartbeatTimeoutMs,
  config,
  decoder,
  localFatal,
  checkHeartbeat = true,
}) {
  const deadline = Date.now() + timeoutMs;
  let observed = Atomics.load(control, index);
  while (observed !== expected) {
    const sharedFatal = readFatal(fatalBytes, fatalView, control, config, decoder);
    if (sharedFatal) throw sharedFatal;
    const immediateFatal = localFatal?.();
    if (immediateFatal) throw immediateFatal;

    const now = Date.now();
    if (heartbeat && checkHeartbeat) {
      const lastBeat = Number(Atomics.load(heartbeat, 0));
      if (lastBeat > 0 && now - lastBeat > heartbeatTimeoutMs) {
        throw new Error(`Storage worker stopped responding while ${label}. Check the storage connection and worker status.`);
      }
    }
    const remaining = deadline - now;
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${label}. Check the storage connection and free-tier status.`);
    }
    // Capture the observed value before waiting: Atomics.wait does not remember
    // a notification that happens between the loop check and the wait call.
    Atomics.wait(control, index, observed, Math.min(remaining, 1000));
    observed = Atomics.load(control, index);
  }
  const sharedFatal = readFatal(fatalBytes, fatalView, control, config, decoder);
  if (sharedFatal) throw sharedFatal;
  const immediateFatal = localFatal?.();
  if (immediateFatal) throw immediateFatal;
}

function storageError(response) {
  const error = new Error(response?.error?.message || 'Storage operation failed.');
  error.name = response?.error?.name || 'StorageError';
  error.code = response?.error?.code;
  error.status = response?.error?.status;
  return error;
}

/**
 * Starts a storage worker and returns a synchronous `call()` function.
 * `backend` selects 'pg' (production), 'pglite' (local Postgres-compatible
 * tests), or 'memory' (in-process S3 stand-in for tests).
 */
export function createStorageBridge({
  config,
  backend = 'pg',
  timeoutMs = 60_000,
  heartbeatTimeoutMs,
} = {}) {
  const control = new Int32Array(new SharedArrayBuffer(CTRL_LENGTH * 4));
  const requestBuffer = new SharedArrayBuffer(BUFFER_BYTES);
  const responseBuffer = new SharedArrayBuffer(BUFFER_BYTES);
  const fatalBuffer = new SharedArrayBuffer(FATAL_BYTES);
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(8));
  const requestBytes = new Uint8Array(requestBuffer);
  const responseBytes = new Uint8Array(responseBuffer);
  const fatalBytes = new Uint8Array(fatalBuffer);
  const requestView = new DataView(requestBuffer);
  const responseView = new DataView(responseBuffer);
  const fatalView = new DataView(fatalBuffer);
  const decoder = new TextDecoder();
  const effectiveHeartbeatTimeoutMs = Number.isFinite(heartbeatTimeoutMs)
    ? Math.max(50, heartbeatTimeoutMs)
    // Long PGlite/WASM initialization can block the worker event loop for a
    // while under parallel test load, so the default must be generous.
    : Math.min(timeoutMs, 30_000);

  let closed = false;
  let fatalError = null;
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    workerData: {
      control: control.buffer,
      requestBuffer,
      responseBuffer,
      fatalBuffer,
      heartbeatBuffer: heartbeat.buffer,
      config,
      databaseBackend: backend,
      workspaceStorage: config?.workspaceStorage || 'local',
    },
    name: `myai-storage-${++bridgeCounter}`,
  });
  // The worker must not keep the HTTP process alive on shutdown.
  worker.unref();

  worker.on('error', (error) => {
    if (!fatalError) fatalError = new Error(redact(String(error?.message || error), config));
  });
  worker.on('exit', (code) => {
    if (closed || fatalError) return;
    if (Atomics.load(control, CTRL_FATAL) !== 1) {
      fatalError = new Error(redact(`Storage worker exited unexpectedly (code ${code}).`, config));
    }
  });

  const waitOptions = {
    control,
    fatalBytes,
    fatalView,
    heartbeat,
    heartbeatTimeoutMs: effectiveHeartbeatTimeoutMs,
    config,
    decoder,
    localFatal: () => fatalError,
  };

  try {
    waitFor({
      ...waitOptions,
      index: CTRL_READY,
      expected: 1,
      timeoutMs,
      label: 'storage worker startup',
      checkHeartbeat: false,
    });
  } catch (error) {
    worker.terminate();
    throw error;
  }

  const encoder = new TextEncoder();
  let sequence = 0;

  function call(method, payload = {}) {
    if (closed) throw new Error('Storage bridge is closed.');
    const immediateFatal = readFatal(fatalBytes, fatalView, control, config, decoder) || fatalError;
    if (immediateFatal) throw immediateFatal;

    sequence += 1;
    const encoded = encoder.encode(JSON.stringify({ sequence, method, payload }));
    if (encoded.length + 4 > requestBuffer.byteLength) {
      throw new Error('Storage request exceeds the bridge buffer limit.');
    }
    requestBytes.set(encoded, 4);
    requestView.setUint32(0, encoded.length, true);
    // Arm the heartbeat when the request is submitted. The worker may still be
    // finishing a CPU-heavy local operation, and a stale timestamp from before
    // that work must not be mistaken for a stopped worker.
    Atomics.store(heartbeat, 0, BigInt(Date.now()));
    Atomics.store(control, CTRL_REQUEST, sequence);
    Atomics.notify(control, CTRL_REQUEST);

    waitFor({ ...waitOptions, index: CTRL_RESPONSE, expected: sequence, timeoutMs, label: `storage request '${method}'` });

    const length = responseView.getUint32(0, true);
    if (length > responseBuffer.byteLength - 4) {
      throw new Error('Storage response exceeds the bridge buffer limit.');
    }
    const response = JSON.parse(decoder.decode(responseBytes.subarray(4, 4 + length)));
    if (response.sequence !== sequence) {
      throw new Error('Storage response sequence mismatch.');
    }
    if (response.error) throw storageError(response);
    return response.result;
  }

  return {
    call,
    close() {
      if (closed) return;
      closed = true;
      worker.terminate();
    },
  };
}

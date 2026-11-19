// Async storage worker behind the synchronous bridge.
//
// Owns exactly one SQL client (pg or PGlite) and one object store (S3 or the
// in-memory test stand-in). The bridge serializes requests, so no SQL lock
// arbitration is needed here.

import { workerData } from 'node:worker_threads';
import { createS3Client, createMemoryObjectStore } from './s3-client.js';

const CTRL_READY = 0;
const CTRL_REQUEST = 1;
const CTRL_RESPONSE = 2;
const CTRL_ERROR = 3;
const CTRL_FATAL = 5;
const CTRL_FATAL_LENGTH = 6;

const control = new Int32Array(workerData.control);
const requestBytes = new Uint8Array(workerData.requestBuffer);
const responseBytes = new Uint8Array(workerData.responseBuffer);
const fatalBytes = new Uint8Array(workerData.fatalBuffer);
const heartbeat = new BigInt64Array(workerData.heartbeatBuffer);
const requestView = new DataView(workerData.requestBuffer);
const responseView = new DataView(workerData.responseBuffer);
const fatalView = new DataView(workerData.fatalBuffer);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const storageConfig = workerData.config || {};
const databaseBackend = workerData.databaseBackend || storageConfig.databaseBackend || 'pg';
const workspaceStorage = workerData.workspaceStorage || storageConfig.workspaceStorage || 'local';

let sqlClient = null;
let objectStore = null;
let lastSequence = 0;
let heartbeatTimer = null;

function touchHeartbeat() {
  Atomics.store(heartbeat, 0, BigInt(Date.now()));
}

function redactMessage(message) {
  let safe = String(message || 'Storage worker failed.');
  for (const secret of [storageConfig.databaseUrl, storageConfig.workspaceS3SecretKey]) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe
    .replace(/((?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(?:sk-|key_|ghp_|gho_|xox[baprs]-|AIza)[A-Za-z0-9_*.-]{8,}/gi, '[redacted credential]')
    .slice(0, 1000);
}

function errorPayload(error) {
  return {
    name: error?.name || 'StorageError',
    message: redactMessage(error?.message || error),
    code: error?.code || null,
    status: error?.status || null,
  };
}

function signalFatal(error) {
  if (Atomics.load(control, CTRL_FATAL) === 1) return;
  let encoded;
  try {
    encoded = encoder.encode(JSON.stringify(errorPayload(error)));
  } catch {
    encoded = encoder.encode(JSON.stringify({ name: 'StorageError', message: 'Storage worker failed.' }));
  }
  const length = Math.min(encoded.length, fatalBytes.byteLength - 4);
  fatalBytes.set(encoded.subarray(0, length), 4);
  fatalView.setUint32(0, length, true);
  Atomics.store(control, CTRL_FATAL, 1);
  // Notify every slot a blocked caller might be watching. A notify on a
  // different index would otherwise add up to a one-second detection delay.
  Atomics.notify(control, CTRL_READY);
  Atomics.notify(control, CTRL_RESPONSE);
  Atomics.notify(control, CTRL_ERROR);
}

function serializable(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return value.map(serializable);
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = serializable(item);
    return result;
  }
  return value;
}

function writeResponse(response) {
  const encoded = encoder.encode(JSON.stringify(serializable(response)));
  if (encoded.length + 4 > responseBytes.byteLength) {
    throw new Error('Storage response exceeds the bridge buffer limit.');
  }
  responseBytes.set(encoded, 4);
  responseView.setUint32(0, encoded.length, true);
}

function failStartup(error) {
  try {
    writeResponse({ sequence: 0, error: errorPayload(error) });
  } catch {
    // The bridge reports the explicit fatal-error flag in any case.
  }
  signalFatal(error);
  Atomics.store(control, CTRL_ERROR, 1);
  Atomics.notify(control, CTRL_ERROR);
}

// SQL translation is intentionally narrow: it covers only the SQLite dialect
// constructs used by this codebase. Unknown SQL is passed through so Postgres
// errors surface clearly instead of being silently rewritten.
const NOW_SQL = 'to_char(now() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS\') || \'Z\'';
const INSERT_WITH_ID = /^\s*INSERT\s+INTO\s+(?:users|projects|tasks|task_steps|file_changes|chat_messages)\b/i;

function replacePlaceholders(sql) {
  let output = '';
  let index = 0;
  let placeholder = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'") {
      const end = sql.indexOf("'", index + 1);
      if (end === -1) {
        output += sql.slice(index);
        break;
      }
      output += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '"') {
      const end = sql.indexOf('"', index + 1);
      if (end === -1) {
        output += sql.slice(index);
        break;
      }
      output += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index + 2);
      const stop = end === -1 ? sql.length : end;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '?') {
      placeholder += 1;
      output += `$${placeholder}`;
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function tableInfoQuery(sql) {
  const match = /^\s*PRAGMA\s+table_info\s*\(\s*["'`]?([\w]+)["'`]?\s*\)\s*;?\s*$/i.exec(sql);
  if (!match) return null;
  return {
    sql: `SELECT column_name AS name
          FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1
          ORDER BY ordinal_position`,
    params: [match[1].toLowerCase()],
  };
}

function translateSql(sql, params = []) {
  const pragma = tableInfoQuery(sql);
  if (pragma) return { sql: pragma.sql, params: pragma.params, returnsRows: true };

  let translated = sql;
  translated = translated.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'BIGSERIAL PRIMARY KEY');
  translated = translated.replace(/COLLATE\s+NOCASE/gi, '');
  translated = translated.replace(/datetime\s*\(\s*'now'\s*\)/gi, NOW_SQL);
  // rowid is SQLite's insertion order. id is the equivalent BIGSERIAL column;
  // created_at can differ under clock skew, so it must not decide order.
  translated = translated.replace(
    /ORDER\s+BY\s+rowid\b(\s+(ASC|DESC))?/gi,
    (_match, direction) => `ORDER BY id${direction ? ` ${direction.trim().toUpperCase()}` : ' ASC'}`,
  );
  translated = translated.replace(/^\s*BEGIN\s+IMMEDIATE\b/gi, 'BEGIN');
  translated = translated.replace(
    /^([\s\S]*?\bALTER\s+TABLE\s+[\w."]+\s+ADD\s+COLUMN\s+)(?!IF\s+NOT\s+EXISTS\b)/i,
    '$1IF NOT EXISTS ',
  );

  const needsReturningId = INSERT_WITH_ID.test(translated) && !/\bRETURNING\b/i.test(translated);
  if (needsReturningId) {
    const trimmed = translated.trimEnd();
    translated = trimmed.endsWith(';')
      ? `${trimmed.slice(0, -1)} RETURNING id;`
      : `${trimmed} RETURNING id`;
  }

  return { sql: replacePlaceholders(translated), params, returnsRows: needsReturningId };
}

async function ensureSql() {
  if (sqlClient) return sqlClient;
  if (databaseBackend === 'object') {
    // Object-storage-only bridge (used by the workspace driver).
    sqlClient = null;
    return null;
  }
  if (databaseBackend === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    sqlClient = new PGlite(storageConfig.pgliteDataDir || 'memory://');
    await sqlClient.waitReady;
    return sqlClient;
  }
  if (databaseBackend === 'pg') {
    if (!storageConfig.databaseUrl) {
      throw new Error('DATABASE_URL is required when DATABASE_BACKEND=postgres.');
    }
    const pg = await import('pg');
    // int8 is returned as a string by node-postgres; normalize safe values so
    // callers see the same numeric ids they get from node:sqlite.
    pg.default?.types?.setTypeParser?.(20, (value) => {
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : value;
    });
    const Client = pg.default?.Client || pg.Client;
    const ssl = storageConfig.databaseSsl === false
      ? false
      : { rejectUnauthorized: storageConfig.databaseRejectUnauthorized !== false };
    sqlClient = new Client({
      connectionString: storageConfig.databaseUrl,
      ssl,
      connectionTimeoutMillis: storageConfig.storageBridgeTimeoutMs || 60_000,
      application_name: 'myai-agent-storage',
    });
    await sqlClient.connect();
    return sqlClient;
  }
  throw new Error(`Unsupported SQL backend: ${databaseBackend}`);
}

async function closeSql() {
  const client = sqlClient;
  sqlClient = null;
  if (!client) return;
  if (databaseBackend === 'pglite') {
    await client.close?.();
  } else {
    await client.end?.();
  }
}

async function ensureObjectStore() {
  if (objectStore) return objectStore;
  if (workspaceStorage === 'memory') {
    objectStore = createMemoryObjectStore(storageConfig);
  } else if (workspaceStorage === 's3') {
    objectStore = createS3Client(storageConfig);
  } else {
    objectStore = null;
  }
  return objectStore;
}

async function executeQuery(client, sql, params, mode) {
  // Multi-statement schema scripts must use the simple query protocol. Passing
  // an empty values array can switch node-postgres to the extended protocol,
  // which does not allow several statements in one query.
  if (mode === 'exec') {
    if (databaseBackend === 'pglite') await client.exec(sql);
    else await client.query(sql);
    return { rows: [], rowCount: 0 };
  }
  if (databaseBackend === 'pglite') {
    return params.length > 0
      ? client.query(sql, params)
      : (await client.exec(sql)).at(-1) || { rows: [], affectedRows: 0 };
  }
  return client.query(sql, params);
}

function resultInfo(result, translated) {
  const rows = Array.isArray(result?.rows) ? serializable(result.rows) : [];
  const changes = result?.rowCount ?? result?.affectedRows ?? (translated.returnsRows ? rows.length : 0);
  return {
    rows,
    changes,
    lastInsertRowid: translated.returnsRows && rows.length > 0 ? rows[0].id ?? null : null,
  };
}

async function handleSql(payload) {
  const client = await ensureSql();
  const translated = translateSql(payload.sql, payload.params || []);
  const result = await executeQuery(client, translated.sql, translated.params, payload.mode);
  if (payload.mode === 'exec') return { rows: [], changes: 0, lastInsertRowid: null };
  const info = resultInfo(result, translated);
  if (payload.mode === 'get') return info.rows[0] ?? null;
  if (payload.mode === 'all') return info.rows;
  return info;
}

async function handleObject(payload) {
  const store = await ensureObjectStore();
  if (!store) throw new Error('Object storage is not configured.');
  switch (payload.op) {
    case 'list':
      return store.list(payload.prefix || '', { recursive: payload.recursive !== false });
    case 'get': {
      const content = await store.get(payload.key);
      return { content };
    }
    case 'put':
      await store.put(payload.key, payload.content, { exclusive: Boolean(payload.exclusive) });
      return { ok: true };
    case 'head':
      return store.head(payload.key);
    case 'delete':
      await store.delete(payload.key);
      return { ok: true };
    case 'copy':
      await store.copy(payload.fromKey, payload.toKey);
      return { ok: true };
    case 'failNextPut':
      if (typeof store.failNextPut !== 'function') {
        throw new Error('This object store does not support failure injection.');
      }
      store.failNextPut(payload.message);
      return { ok: true };
    default:
      throw new Error(`Unknown object operation: ${payload.op}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function dispatch(request) {
  if (request.method === 'sql') return handleSql(request.payload || {});
  if (request.method === 'object') return handleObject(request.payload || {});
  if (request.method === 'close') {
    await closeSql();
    return { ok: true };
  }
  if (request.method === '__testSleep') {
    await delay(request.payload?.ms);
    return { ok: true };
  }
  if (request.method === '__testHugeResponse') {
    return { giant: 'x'.repeat(9 * 1024 * 1024) };
  }
  if (request.method === '__testAbandon') {
    // Simulates a worker that dies without publishing a fatal error: stop the
    // heartbeat and never answer so the bridge detects a stale worker.
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    // Leave the last heartbeat untouched so the bridge observes it going stale.
    await new Promise(() => {});
  }
  if (request.method === 'ping') return { ok: true };
  throw new Error(`Unknown storage method: ${request.method}`);
}

async function loop() {
  let sequence = 0;
  while (true) {
    // waitAsync keeps the worker event loop free while idle, so the heartbeat
    // timer keeps running and a blocked/stopped worker can be detected.
    await Atomics.waitAsync(control, CTRL_REQUEST, lastSequence).value;
    touchHeartbeat();
    sequence = Atomics.load(control, CTRL_REQUEST);
    if (sequence === lastSequence) continue;
    lastSequence = sequence;

    let response;
    try {
      const length = requestView.getUint32(0, true);
      if (length > requestBytes.byteLength - 4) {
        throw new Error('Storage request exceeds the bridge buffer limit.');
      }
      const request = JSON.parse(decoder.decode(requestBytes.subarray(4, 4 + length)));
      if (request.sequence !== sequence) throw new Error('Storage request sequence mismatch.');
      if (request.method === '__testCrash') {
        signalFatal(new Error('Simulated storage worker crash.'));
        return; // End the worker loop; the bridge sees the shared fatal flag.
      }
      response = { sequence, result: await dispatch(request) };
    } catch (error) {
      response = { sequence, error: errorPayload(error) };
    }
    try {
      writeResponse(response);
    } catch (error) {
      signalFatal(error);
      throw error;
    }
    Atomics.store(control, CTRL_RESPONSE, sequence);
    Atomics.notify(control, CTRL_RESPONSE);
  }
}

// Keep this timer referenced: it is what keeps the worker thread alive while
// it waits for requests. The bridge itself is unref'd from the main process.
heartbeatTimer = setInterval(touchHeartbeat, 1000);
touchHeartbeat();

try {
  await ensureSql();
  await ensureObjectStore();
  Atomics.store(control, CTRL_READY, 1);
  Atomics.notify(control, CTRL_READY);
  // Do not leave a top-level await pending: worker.terminate() would otherwise
  // report an unsettled-top-level-await warning during normal shutdown.
  loop().catch(failStartup);
} catch (error) {
  failStartup(error);
}

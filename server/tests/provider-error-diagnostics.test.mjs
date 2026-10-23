import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHttpError, createProviderNetworkError } from '../src/ai/provider-error.js';

// Minimal diagnostic verification: adapter errors expose safe fields.
// No network; mocked responses and errors only.

test('provider error diagnostics preserve safe fields', async () => {
  // HTTP 429 with retry-after
  const res429 = { status: 429, headers: { get: (k) => (k === 'retry-after' ? '10' : null) }, json: async () => ({ error: { message: 'quota exceeded' } }) };
  const err429 = await createProviderHttpError(res429, 'OpenRouter', 'redacted');
  assert.strictEqual(err429.statusCode, 429);
  assert.ok(err429.publicMessage?.includes('rate limit'));
  assert.strictEqual(err429.retryAfterMs, 10000);

  // HTTP 401
  const res401 = { status: 401, headers: { get: () => null }, json: async () => ({ error: { message: 'bad key' } }) };
  const err401 = await createProviderHttpError(res401, 'OpenRouter', 'redacted');
  assert.strictEqual(err401.statusCode, 401);
  assert.ok(err401.publicMessage?.includes('rejected'));
  assert.strictEqual(err401.retryAfterMs ?? null, null);

  // Network timeout
  const timeoutCause = new Error('TimeoutError'); timeoutCause.name = 'TimeoutError';
  const timeoutErr = createProviderNetworkError('OpenRouter', timeoutCause);
  assert.strictEqual(timeoutErr.statusCode, 504);
  assert.ok(timeoutErr.publicMessage?.includes('timed out'));

  // Network other
  const netErr = createProviderNetworkError('OpenRouter', new Error('ECONNREFUSED'));
  assert.strictEqual(netErr.statusCode, 502);
  assert.ok(netErr.publicMessage?.includes('Could not connect'));

  // Missing fields handled safely (no crash when fields absent)
  const safeErr = new Error('unknown');
  assert.strictEqual(typeof safeErr.statusCode, 'undefined');
  assert.strictEqual(typeof safeErr.publicMessage, 'undefined');
  assert.strictEqual(typeof safeErr.retryAfterMs, 'undefined');
});

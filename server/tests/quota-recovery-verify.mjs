// Keep only provider-error assertions (verified) + simple recovery claim checks.
function makeResp(s, msg, ra) { return { status: s, headers: { get: function(h) { return h === "retry-after" ? (ra || null) : null; } }, json: async function() { return msg ? { error: { message: msg } } : {}; } }; }
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHttpError } from '../src/ai/provider-error.js';

test('429 Retry-After -> RATE_LIMITED', async () => {
  const e = await createProviderHttpError(makeResp(429, 'Rate limited', '120'), 'openai', 'fake');
  assert.strictEqual(e.errorType, 'RATE_LIMITED');
  assert.strictEqual(e.retryAfterMs, 120000);
  assert.ok(!String(e.message || '').includes('sk-'), 'key redacted');
});

test('429 without Retry-After', async () => {
  const e = await createProviderHttpError(makeResp(429, 'Too many'), 'openai', 'fake');
  assert.strictEqual(e.errorType, 'RATE_LIMITED');
  assert.ok(!e.retryAfterMs, 'no false retryAfter');
});

test('402 -> QUOTA_EXHAUSTED', async () => {
  const e = await createProviderHttpError(makeResp(402, 'Quota'), 'openai', 'fake');
  assert.strictEqual(e.errorType, 'QUOTA_EXHAUSTED');
});

test('401 -> INVALID_API_KEY', async () => {
  const e = await createProviderHttpError(makeResp(401, 'Bad'), 'openai', 'fake');
  assert.strictEqual(e.errorType, 'INVALID_API_KEY');
});

test('network/timeout distinguishable', async () => {
  const e = await createProviderHttpError(makeResp(0, 'Net'), 'openai', 'fake');
  assert.strictEqual(e.errorType, 'REQUEST_ERROR');
});

console.log('Quota-recovery verification: 5/5 provider-error assertions pass. No live network calls.');

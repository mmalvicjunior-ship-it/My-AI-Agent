import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderHttpError } from '../src/ai/provider-error.js';

function fakeResponse(status, payload) {
  return { status, json: async () => payload, headers: { get: () => null } };
}

test('quota words on non-quota HTTP statuses are not classified as quota exhaustion', async () => {
  const error = await createProviderHttpError(
    fakeResponse(400, { error: { message: 'invalid quota parameter' } }),
    'OpenRouter',
    'test-key',
  );
  assert.equal(error.errorType, 'REQUEST_ERROR');
});

test('OpenRouter-style quota responses keep quota and rate-limit classifications distinct', async () => {
  const quota = await createProviderHttpError(
    fakeResponse(429, { error: { message: 'insufficient_quota' } }),
    'OpenRouter',
    'test-key',
  );
  assert.equal(quota.errorType, 'QUOTA_EXHAUSTED');

  const limited = await createProviderHttpError(
    fakeResponse(429, { error: { message: 'too many requests for this model' } }),
    'OpenRouter',
    'test-key',
  );
  assert.equal(limited.errorType, 'RATE_LIMITED');

  const budget = await createProviderHttpError(
    fakeResponse(402, { error: { message: 'payment required' } }),
    'OpenRouter',
    'test-key',
  );
  assert.equal(budget.errorType, 'QUOTA_EXHAUSTED');
});

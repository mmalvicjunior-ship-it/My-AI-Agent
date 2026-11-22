import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderHttpError,
  createProviderNetworkError,
  isFallbackEligibleProviderError,
  isRetryableProviderError,
} from '../src/ai/provider-error.js';

function fakeResponse(status, payload, headers = {}) {
  return {
    status,
    json: async () => payload,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
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
  assert.equal(quota.category, 'QUOTA_EXHAUSTED');
  assert.equal(quota.retryable, false);
  assert.equal(isRetryableProviderError(quota), false);
  assert.equal(isFallbackEligibleProviderError(quota), true);
  assert.match(quota.publicMessage, /daily quota|no available API quota/);

  const limited = await createProviderHttpError(
    fakeResponse(429, { error: { message: 'too many requests for this model' } }),
    'OpenRouter',
    'test-key',
  );
  assert.equal(limited.errorType, 'RATE_LIMITED');
  assert.equal(limited.category, 'RATE_LIMITED');
  assert.equal(limited.retryable, true);
  assert.equal(isFallbackEligibleProviderError(limited), true);

  const budget = await createProviderHttpError(
    fakeResponse(402, { error: { message: 'payment required' } }),
    'OpenRouter',
    'test-key',
  );
  assert.equal(budget.errorType, 'QUOTA_EXHAUSTED');
});

test('Google RESOURCE_EXHAUSTED responses are non-retryable daily quota failures', async () => {
  const error = await createProviderHttpError(
    fakeResponse(429, {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'Resource has been exhausted (e.g. check quota).',
      },
    }),
    'Gemini',
    'test-secret-key',
  );

  assert.equal(error.category, 'QUOTA_EXHAUSTED');
  assert.equal(error.errorType, 'QUOTA_EXHAUSTED');
  assert.equal(error.retryable, false);
  assert.equal(isFallbackEligibleProviderError(error), true);
  assert.match(error.publicMessage, /quota|exhausted/i);
  assert.ok(!error.publicMessage.includes('test-secret-key'));
});

test('HTTP 503 is a retryable capacity error with a clear public message', async () => {
  const error = await createProviderHttpError(
    fakeResponse(503, {
      error: { message: 'This model is currently experiencing high demand.' },
    }),
    'Gemini',
    'test-secret-key',
  );

  assert.equal(error.statusCode, 503);
  assert.equal(error.category, 'CAPACITY_UNAVAILABLE');
  assert.equal(error.errorType, 'PROVIDER_ERROR');
  assert.equal(error.retryable, true);
  assert.equal(isFallbackEligibleProviderError(error), true);
  assert.match(error.publicMessage, /temporarily unavailable|capacity/i);
});

test('Retry-After is exposed in milliseconds and seconds', async () => {
  const error = await createProviderHttpError(
    fakeResponse(429, { error: { message: 'too many requests' } }, { 'retry-after': '12' }),
    'Gemini',
    'test-key',
  );

  assert.equal(error.retryAfterMs, 12_000);
  assert.equal(error.retryAfterSeconds, 12);
});

test('invalid credentials are never fallback eligible', async () => {
  const error = await createProviderHttpError(
    fakeResponse(403, { error: { message: 'API key not valid' } }),
    'Gemini',
    'test-key',
  );

  assert.equal(error.category, 'INVALID_API_KEY');
  assert.equal(error.retryable, false);
  assert.equal(isFallbackEligibleProviderError(error), false);
});

test('network failures and timeouts are retryable and fallback eligible', () => {
  const timeout = createProviderNetworkError('Gemini', { name: 'TimeoutError' });
  assert.equal(timeout.category, 'NETWORK_TIMEOUT');
  assert.equal(timeout.statusCode, 504);
  assert.equal(timeout.retryable, true);
  assert.equal(isFallbackEligibleProviderError(timeout), true);

  const network = createProviderNetworkError('Gemini', new Error('ECONNRESET'));
  assert.equal(network.category, 'NETWORK_ERROR');
  assert.equal(network.statusCode, 502);
  assert.equal(network.retryable, true);
  assert.equal(isFallbackEligibleProviderError(network), true);
});

test('OpenRouter 429 metadata distinguishes transient rate limits from quota limits', async () => {
  const rateLimited = await createProviderHttpError(
    fakeResponse(429, {
      error: {
        message: 'Rate limit exceeded',
        metadata: { error_type: 'rate_limit_exceeded' },
      },
    }, {
      'retry-after': '12',
      'x-ratelimit-limit': '20',
      'x-ratelimit-remaining': '0',
    }),
    'OpenRouter',
    'test-key',
  );
  assert.equal(rateLimited.category, 'RATE_LIMITED');
  assert.equal(rateLimited.retryable, true);
  assert.equal(rateLimited.retryAfterSeconds, 12);
  assert.equal(rateLimited.providerDetails.classificationSource, 'rate_limit_metadata');
  assert.equal(rateLimited.providerDetails.retryAfterSource, 'retry-after');
  assert.deepEqual(rateLimited.providerDetails.rateLimit, { limit: '20', remaining: '0' });

  const keyLimit = await createProviderHttpError(
    fakeResponse(429, {
      error: {
        message: 'Rate limit exceeded',
        metadata: { limit_source: 'openrouter_key_limit' },
      },
    }),
    'OpenRouter',
    'test-key',
  );
  assert.equal(keyLimit.category, 'QUOTA_EXHAUSTED');
  assert.equal(keyLimit.retryable, false);
  assert.equal(keyLimit.providerDetails.classificationSource, 'quota_metadata');

  const inFlight = await createProviderHttpError(
    fakeResponse(429, {
      error: {
        message: 'Request rejected',
        metadata: {
          limit_source: 'openrouter_in_flight_budget',
          reason: 'in_flight_budget_exhausted',
        },
      },
    }),
    'OpenRouter',
    'test-key',
  );
  assert.equal(inFlight.category, 'RATE_LIMITED');
  assert.equal(inFlight.retryable, true);
  assert.equal(inFlight.providerDetails.classificationSource, 'in_flight_budget');
});

test('429 diagnostics redact secrets in allowlisted upstream metadata', async () => {
  const secret = 'sk-test-secret-123456';
  const error = await createProviderHttpError(
    fakeResponse(429, {
      error: {
        code: secret,
        message: 'Rate limit exceeded',
        metadata: { provider_code: secret },
      },
    }),
    'OpenRouter',
    'test-key',
  );

  assert.equal(error.providerDetails.upstreamCode, '[redacted credential]');
  assert.equal(error.providerDetails.metadata.provider_code, '[redacted credential]');
  assert.ok(!JSON.stringify(error.providerDetails).includes(secret));
  assert.ok(!error.publicMessage.includes(secret));
});

test('X-RateLimit-Reset supplies retry timing when Retry-After is absent', async () => {
  const reset = Date.now() + 9_000;
  const error = await createProviderHttpError(
    fakeResponse(429, { error: { message: 'Rate limit exceeded' } }, {
      'x-ratelimit-reset': String(reset),
    }),
    'OpenRouter',
    'test-key',
  );

  assert.equal(error.providerDetails.retryAfterSource, 'x-ratelimit-reset');
  assert.equal(error.retryAfterSeconds, 9);
});

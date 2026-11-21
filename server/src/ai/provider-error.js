function extractMessage(payload) {
  const message = payload?.error?.message ?? payload?.message ?? payload?.error;
  if (typeof message === 'string') return message;
  if (message && typeof message.message === 'string') return message.message;
  return '';
}

function extractCode(payload) {
  const code = payload?.error?.code ?? payload?.code;
  return typeof code === 'string' ? code : '';
}

function extractStatus(payload) {
  const status = payload?.error?.status ?? payload?.status;
  return typeof status === 'string' ? status : '';
}

function redactCredentialFragments(message, apiKey) {
  let safeMessage = apiKey ? message.replaceAll(apiKey, '[redacted]') : message;
  return safeMessage
    .replace(/\b(?:sk-|key_)[A-Za-z0-9_*.-]{4,}/gi, '[redacted credential]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

const DAILY_QUOTA_PATTERN = /\bfree[- ]models[- ]per[- ]day\b|\bdaily\s+quota\b|\bper[- ]day\b|\brpd\b/i;
const QUOTA_PATTERN = /\bquota\b|\bbudget\b|\bcredit\b|\bbilling\b|insufficient|exhausted|resource(?:s)?\s+(?:has|have)\s+been\s+exhausted/i;

function quotaScope(upstreamMessage, code, status) {
  const text = `${upstreamMessage} ${code} ${status}`;
  if (DAILY_QUOTA_PATTERN.test(text)) return 'daily';
  if (QUOTA_PATTERN.test(text)) return 'account';
  return '';
}

function retryAfterSeconds(retryAfterMs) {
  return Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.ceil(retryAfterMs / 1000)
    : null;
}

export async function createProviderHttpError(response, provider, apiKey) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const status = response.status;
  const upstreamMessage = redactCredentialFragments(extractMessage(payload), apiKey).slice(0, 500);
  const code = extractCode(payload);
  const upstreamStatus = extractStatus(payload);
  const scope = status === 429 ? quotaScope(upstreamMessage, code, upstreamStatus) : '';

  let category;
  let context;
  if (status === 401 || status === 403) {
    category = 'INVALID_API_KEY';
    context = `${provider} rejected the API key or credentials.`;
  } else if (status === 402) {
    category = 'QUOTA_EXHAUSTED';
    context = `${provider} credit or budget error; available credits may be exhausted.`;
  } else if (status === 429 && scope === 'daily') {
    category = 'QUOTA_EXHAUSTED';
    context = `${provider} daily quota is exhausted. No further ${provider} retries should burn more quota.`;
  } else if (status === 429 && scope === 'account') {
    category = 'QUOTA_EXHAUSTED';
    context = `${provider} account has no available API quota.`;
  } else if (status === 429) {
    category = 'RATE_LIMITED';
    context = `${provider} rate limit was reached; retrying with bounded backoff if possible.`;
  } else if (status === 503) {
    category = 'CAPACITY_UNAVAILABLE';
    context = `${provider} is temporarily unavailable because the model is at capacity.`;
  } else if (status >= 500) {
    category = 'PROVIDER_ERROR';
    context = `${provider} is temporarily unavailable.`;
  } else {
    category = 'REQUEST_ERROR';
    context = `${provider} request was rejected (HTTP ${status}).`;
  }

  const error = new Error(`${provider} request failed with status ${status}.`);
  error.statusCode = status >= 500 && status !== 503 ? 502 : status;
  error.publicMessage = upstreamMessage
    ? `${context} ${upstreamMessage}`
    : context;
  error.category = category;
  error.errorType = category === 'CAPACITY_UNAVAILABLE' || category === 'PROVIDER_ERROR'
    ? 'PROVIDER_ERROR'
    : category;
  error.retryable = category === 'RATE_LIMITED'
    || category === 'CAPACITY_UNAVAILABLE'
    || category === 'PROVIDER_ERROR';
  error.fallbackEligible = error.retryable || category === 'QUOTA_EXHAUSTED';

  let retryAfterMs = null;
  try {
    retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
  } catch {
    retryAfterMs = null;
  }
  if (retryAfterMs !== null) {
    error.retryAfterMs = retryAfterMs;
    error.retryAfterSeconds = retryAfterSeconds(retryAfterMs);
  }

  return error;
}

export function createProviderNetworkError(provider, cause) {
  const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
  const category = timedOut ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR';
  const error = new Error(`${provider} request could not be completed.`);
  error.statusCode = timedOut ? 504 : 502;
  error.publicMessage = timedOut
    ? `${provider} did not respond before the request timed out. Try again or select another provider.`
    : `Could not connect to ${provider}. Check your internet connection and try again, or select another provider.`;
  error.category = category;
  error.errorType = category;
  error.retryable = true;
  error.fallbackEligible = true;
  return error;
}

export function isRetryableProviderError(error) {
  return Boolean(error?.retryable);
}

export function isQuotaExhaustedError(error) {
  return error?.category === 'QUOTA_EXHAUSTED' || error?.errorType === 'QUOTA_EXHAUSTED';
}

export function isInvalidProviderKeyError(error) {
  return error?.category === 'INVALID_API_KEY' || error?.errorType === 'INVALID_API_KEY';
}

/**
 * Whether an explicit fallback provider may be used. Invalid credentials,
 * malformed requests and cancelled requests are never fallback-eligible.
 */
export function isFallbackEligibleProviderError(error) {
  if (isInvalidProviderKeyError(error)) return false;
  return Boolean(error?.fallbackEligible)
    || ['QUOTA_EXHAUSTED', 'RATE_LIMITED', 'CAPACITY_UNAVAILABLE', 'NETWORK_TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_ERROR']
      .includes(error?.category);
}

export { retryAfterSeconds };

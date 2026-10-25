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
  let context;
  if (status === 401 || status === 403) {
    context = `${provider} rejected the API key or credentials.`;
  } else if (status === 402) {
    context = `${provider} credit or budget error; available credits may be exhausted.`;
  } else if (status === 429 && /free-models-per-day/i.test(upstreamMessage || '')) {
    context = `${provider} free-model daily quota exhausted (free-models-per-day). No retries should burn more quota.`;
  } else if (status === 429 && code === 'insufficient_quota') {
    context = `${provider} account has no available API quota.`;
  } else if (status === 429) {
    context = `${provider} rate limit or quota was reached; verify available quota.`;
  } else if (status >= 500) {
    context = `${provider} is temporarily unavailable.`;
  } else {
    context = `${provider} request was rejected (HTTP ${status}).`;
  }

  const error = new Error(`${provider} request failed with status ${status}.`);
  error.statusCode = status >= 500 ? 502 : status;
  error.publicMessage = upstreamMessage
    ? `${context} ${upstreamMessage}`
    : context;

  // Let callers (the background executor) honor an explicit backoff window.
  let retryAfterMs = null;
  try {
    retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
  } catch {
    retryAfterMs = null;
  }
  if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;

  // Structured error classification for recovery logic (never exposes keys).
  const isQuotaDaily = status === 429 && /free-models-per-day/i.test(upstreamMessage || '');
  const isQuotaBudget = status === 402 || (status === 429 && /insufficient_quota/i.test(upstreamMessage || '') || /quota|budget|credit/i.test(upstreamMessage || ''));
  const isRateLimited = status === 429 && !isQuotaDaily && !isQuotaBudget;
  const isInvalidKey = status === 401 || status === 403;

  error.errorType = isQuotaDaily || isQuotaBudget ? 'QUOTA_EXHAUSTED'
    : isRateLimited ? 'RATE_LIMITED'
    : isInvalidKey ? 'INVALID_API_KEY'
    : (status >= 500 ? 'PROVIDER_ERROR' : 'REQUEST_ERROR');

  return error;
}

export function createProviderNetworkError(provider, cause) {
  const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
  const error = new Error(`${provider} request could not be completed.`);
  error.statusCode = timedOut ? 504 : 502;
  error.publicMessage = timedOut
    ? `${provider} did not respond before the request timed out. Try again.`
    : `Could not connect to ${provider}. Check your internet connection and try again.`;
  return error;
}

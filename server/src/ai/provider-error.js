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
    // Match the credential families redacted by config.redactSecrets so that
    // provider-supplied fields cannot reintroduce a key into a log line.
    .replace(/\b(?:sk-|key_)[A-Za-z0-9_*.-]{4,}/gi, '[redacted credential]')
    .replace(/\b(?:gh[pousr]_|xox[baprs]-)[A-Za-z0-9_*.-]{8,}/gi, '[redacted credential]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted credential]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
}

/** Redacts and flattens a value before it is safe to put in a log line. */
export function redactProviderDetail(value, apiKey) {
  return redactCredentialFragments(String(value ?? ''), apiKey)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

const SAFE_METADATA_FIELDS = [
  'error_type',
  'limit_source',
  'reason',
  'provider_code',
  'resets_at',
];
const RATE_LIMIT_HEADERS = {
  'x-ratelimit-limit': 'limit',
  'x-ratelimit-remaining': 'remaining',
  'x-ratelimit-reset': 'reset',
};

function safeScalar(value, apiKey) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  return redactProviderDetail(value, apiKey).slice(0, 200) || null;
}

/** Only allowlisted OpenRouter metadata fields are retained for diagnostics. */
function extractMetadata(payload, apiKey) {
  const metadata = payload?.error?.metadata ?? payload?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const safe = {};
  for (const field of SAFE_METADATA_FIELDS) {
    if (!Object.hasOwn(metadata, field)) continue;
    const value = safeScalar(metadata[field], apiKey);
    if (value !== null) safe[field] = value;
  }
  return safe;
}

/** Only allowlisted rate-limit headers are retained for diagnostics. */
function extractRateLimitHeaders(headers, apiKey) {
  const safe = {};
  for (const [headerName, field] of Object.entries(RATE_LIMIT_HEADERS)) {
    let value;
    try {
      value = headers?.get?.(headerName);
    } catch {
      continue;
    }
    const safeValue = safeScalar(value, apiKey);
    if (safeValue !== null) safe[field] = safeValue;
  }
  return safe;
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** X-RateLimit-Reset may be epoch ms, epoch seconds, or a delay in seconds. */
function parseRateLimitReset(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    if (numeric >= 1e12) return Math.max(0, Math.round(numeric - Date.now()));
    if (numeric >= 1e9) return Math.max(0, Math.round(numeric * 1000 - Date.now()));
    if (numeric >= 0) return Math.round(numeric * 1000);
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

const DAILY_QUOTA_PATTERN = /\bfree[- ]models[- ]per[- ]day\b|\bdaily\s+(?:quota|limit)\b|\bper[- ]day\b|\brpd\b/i;
const QUOTA_PATTERN = /\bquota\b|\bbudget\b|\bcredit\b|\bbilling\b|insufficient|exhausted|resource(?:s)?\s+(?:has|have)\s+been\s+exhausted/i;
const RATE_LIMIT_PATTERN = /rate[_ -]?limit|too[_ -]?many/i;
const IN_FLIGHT_PATTERN = /in[_\s-]?flight/i;
const NON_TRANSIENT_LIMIT_SOURCES = new Set([
  'openrouter_credits',
  'openrouter_key_limit',
  'openrouter_guardrail_budget',
  'openrouter_workspace_budget',
]);

function classify429({ provider, message, code, status, metadata }) {
  const metadataText = Object.entries(metadata)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  const text = `${message} ${code} ${status} ${metadataText}`;
  const limitSource = String(metadata.limit_source ?? '').toLowerCase();
  const reason = String(metadata.reason ?? '').toLowerCase();
  const errorType = String(metadata.error_type ?? '').toLowerCase();
  const signals = `${limitSource} ${reason} ${errorType}`;

  if (IN_FLIGHT_PATTERN.test(signals) || IN_FLIGHT_PATTERN.test(text)) {
    return {
      category: 'RATE_LIMITED',
      context: `${provider} rejected the request while its in-flight spending budget was full; retry after the indicated delay.`,
      source: 'in_flight_budget',
    };
  }
  if (DAILY_QUOTA_PATTERN.test(text)) {
    return {
      category: 'QUOTA_EXHAUSTED',
      context: `${provider} daily quota is exhausted. No further ${provider} retries should burn more quota.`,
      source: 'daily_quota',
    };
  }
  if (NON_TRANSIENT_LIMIT_SOURCES.has(limitSource)) {
    return {
      category: 'QUOTA_EXHAUSTED',
      context: `${provider} account has no available API quota.`,
      source: 'quota_metadata',
    };
  }
  if (RATE_LIMIT_PATTERN.test(signals) || RATE_LIMIT_PATTERN.test(text)) {
    return {
      category: 'RATE_LIMITED',
      context: `${provider} rate limit was reached; retrying with bounded backoff if possible.`,
      source: 'rate_limit_metadata',
    };
  }
  if (QUOTA_PATTERN.test(text)) {
    return {
      category: 'QUOTA_EXHAUSTED',
      context: `${provider} account has no available API quota.`,
      source: 'quota_metadata',
    };
  }
  return {
    category: 'RATE_LIMITED',
    context: `${provider} rate limit was reached; retrying with bounded backoff if possible.`,
    source: 'default',
  };
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
  const upstreamMessage = redactProviderDetail(extractMessage(payload), apiKey);
  const code = redactProviderDetail(extractCode(payload), apiKey).slice(0, 120);
  const upstreamStatus = redactProviderDetail(extractStatus(payload), apiKey).slice(0, 120);
  const metadata = extractMetadata(payload, apiKey);
  const rateLimit = extractRateLimitHeaders(response.headers, apiKey);
  let classification = { source: 'status' };

  let category;
  let context;
  if (status === 401 || status === 403) {
    category = 'INVALID_API_KEY';
    context = `${provider} rejected the API key or credentials.`;
  } else if (status === 402) {
    category = 'QUOTA_EXHAUSTED';
    context = `${provider} credit or budget error; available credits may be exhausted.`;
  } else if (status === 429) {
    classification = classify429({ provider, message: upstreamMessage, code, status, metadata });
    category = classification.category;
    context = classification.context;
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
  let retryAfterSource = null;
  try {
    const headerValue = response.headers?.get?.('retry-after');
    const parsed = parseRetryAfter(headerValue);
    if (parsed !== null) {
      retryAfterMs = parsed;
      retryAfterSource = 'retry-after';
    }
  } catch {
    retryAfterMs = null;
  }
  if (retryAfterMs === null && rateLimit.reset !== undefined) {
    retryAfterMs = parseRateLimitReset(rateLimit.reset);
    if (retryAfterMs !== null) retryAfterSource = 'x-ratelimit-reset';
  }
  if (retryAfterMs !== null) {
    error.retryAfterMs = retryAfterMs;
    error.retryAfterSeconds = retryAfterSeconds(retryAfterMs);
  }

  // Allowlisted, redacted fields for server logs only. They are never sent to
  // the browser and never include credentials, headers, or the raw body.
  error.providerDetails = {
    status,
    upstreamCode: code || null,
    upstreamStatus: upstreamStatus || null,
    metadata,
    rateLimit,
    classificationSource: classification.source,
    retryAfterSource,
  };

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

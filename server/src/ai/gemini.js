import {
  createProviderHttpError,
  createProviderNetworkError,
  isRetryableProviderError,
} from './provider-error.js';

const DEFAULT_MODEL = 'gemini-3.8-flash';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const SYSTEM_INSTRUCTION = "You are a helpful coding assistant. Follow the user's instructions directly. When a project workspace is selected, inspect relevant files with tools before proposing changes, use create_file for new files and propose_file_change for edits to existing files. All file changes and commands require explicit user approval; use only the provided safe command tools. Never claim a tool succeeded unless its result confirms success.";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 15_000;
const DEFAULT_JITTER_MS = 250;
const DEFAULT_CAPACITY_COOLDOWN_MS = 60_000;
const DEFAULT_NETWORK_COOLDOWN_MS = 30_000;
const MAX_DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Shared across provider instances so a quota cooldown still applies when the
// chat route resolves a fresh Gemini adapter for a per-request provider switch.
const DEFAULT_COOLDOWN_STORE = new Map();

/** External cancellation is not a provider timeout or network failure. */
function cancelledRequestError() {
  const error = new Error('The AI request was cancelled.');
  error.name = 'AbortError';
  error.statusCode = 499;
  error.retryable = false;
  error.fallbackEligible = false;
  return error;
}

function nextUtcMidnight(nowMs) {
  const date = new Date(nowMs);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
}

function wait(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(cancelledRequestError());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(cancelledRequestError());
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function cooldownError(model, entry, nowMs) {
  const remainingMs = Math.max(0, entry.until - nowMs);
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const error = new Error('Gemini is temporarily unavailable due to a provider cooldown.');
  error.category = entry.category;
  error.errorType = entry.category === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED' : 'PROVIDER_ERROR';
  error.statusCode = entry.category === 'QUOTA_EXHAUSTED' ? 429 : 503;
  error.retryable = false;
  error.fallbackEligible = true;
  error.retryAfterMs = remainingMs;
  error.retryAfterSeconds = seconds;
  error.publicMessage = entry.category === 'QUOTA_EXHAUSTED'
    ? `Google Gemini daily quota is exhausted. No further Gemini requests will be made for about ${seconds} second(s). Select OpenRouter to continue.`
    : `Google Gemini is temporarily unavailable for about ${seconds} second(s). Select OpenRouter to continue if it does not recover.`;
  return error;
}

export function createGeminiProvider({
  apiKey,
  model = DEFAULT_MODEL,
  fetchImpl = fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  jitterMs = DEFAULT_JITTER_MS,
  now = () => Date.now(),
  cooldownStore = DEFAULT_COOLDOWN_STORE,
}) {
  const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : DEFAULT_MAX_ATTEMPTS;
  const delays = Array.isArray(retryDelaysMs) && retryDelaysMs.length
    ? retryDelaysMs
    : DEFAULT_RETRY_DELAYS_MS;
  const cooldownKey = `gemini:${model}`;

  function setCooldown(error) {
    if (!error || !error.fallbackEligible) return;
    const currentMs = now();
    const requestedMs = Number(error.retryAfterMs);
    let until;

    if (error.category === 'QUOTA_EXHAUSTED' || error.errorType === 'QUOTA_EXHAUSTED') {
      const quotaUntil = Number.isFinite(requestedMs) && requestedMs > 0
        ? currentMs + requestedMs
        : nextUtcMidnight(currentMs);
      until = Math.min(currentMs + MAX_DAILY_COOLDOWN_MS, quotaUntil);
    } else if (error.category === 'CAPACITY_UNAVAILABLE' || error.category === 'PROVIDER_ERROR') {
      until = currentMs + Math.max(
        Number.isFinite(requestedMs) ? requestedMs : 0,
        DEFAULT_CAPACITY_COOLDOWN_MS,
      );
    } else if (error.category === 'NETWORK_TIMEOUT' || error.category === 'NETWORK_ERROR') {
      until = currentMs + Math.max(
        Number.isFinite(requestedMs) ? requestedMs : 0,
        DEFAULT_NETWORK_COOLDOWN_MS,
      );
    } else {
      return;
    }

    cooldownStore.set(cooldownKey, {
      until,
      category: error.category === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED' : error.category,
      publicMessage: error.publicMessage,
    });
  }

  async function pauseBeforeRetry(attempt, retryAfterMs, signal) {
    const requestedMs = Number(retryAfterMs);
    if (Number.isFinite(requestedMs) && requestedMs > MAX_RETRY_AFTER_MS) return false;
    const backoffMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
    const jitter = Number.isFinite(jitterMs) ? Math.max(0, jitterMs) : 0;
    const waitMs = Math.max(0, backoffMs, Number.isFinite(requestedMs) ? requestedMs : 0)
      + (jitter > 0 ? Math.round(Math.random() * jitter) : 0);
    await wait(waitMs, signal);
    return true;
  }

  async function requestGenerate(body, signal) {
    const url = `${API_URL}/${encodeURIComponent(model)}:generateContent`;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw cancelledRequestError();

      let response;
      try {
        const timeoutSignal = AbortSignal.timeout(60_000);
        const requestSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        });
      } catch (error) {
        if (signal?.aborted) throw cancelledRequestError();
        const networkError = createProviderNetworkError('Gemini', error);
        if (!isRetryableProviderError(networkError) || attempt >= attempts) {
          setCooldown(networkError);
          throw networkError;
        }
        if (!await pauseBeforeRetry(attempt, null, signal)) {
          setCooldown(networkError);
          throw networkError;
        }
        continue;
      }

      if (!response.ok) {
        const error = await createProviderHttpError(response, 'Gemini', apiKey);
        if (!isRetryableProviderError(error) || attempt >= attempts) {
          setCooldown(error);
          throw error;
        }
        if (!await pauseBeforeRetry(attempt, error.retryAfterMs, signal)) {
          setCooldown(error);
          throw error;
        }
        continue;
      }

      try {
        return await response.json();
      } catch {
        const error = new Error('Gemini returned an invalid response.');
        error.category = 'REQUEST_ERROR';
        error.errorType = 'REQUEST_ERROR';
        error.retryable = false;
        error.fallbackEligible = false;
        error.publicMessage = 'Google Gemini returned an invalid response. Please try again.';
        throw error;
      }
    }

    const error = new Error('Gemini request retry limit reached.');
    error.category = 'PROVIDER_ERROR';
    error.errorType = 'PROVIDER_ERROR';
    error.retryable = false;
    error.fallbackEligible = true;
    error.publicMessage = 'Google Gemini did not complete the request. Select OpenRouter to continue.';
    throw error;
  }

  return {
    name: 'gemini',
    model,

    async chat({ messages, tools, projectId, signal }) {
      if (!apiKey) {
        const error = new Error('Gemini is selected, but AI_API_KEY is not configured.');
        error.statusCode = 503;
        error.category = 'INVALID_API_KEY';
        error.errorType = 'INVALID_API_KEY';
        error.retryable = false;
        error.fallbackEligible = false;
        error.publicMessage = 'Gemini is selected but no API key is configured. Add a new Google AI API key to the project-root .env file and restart the server.';
        throw error;
      }

      const currentMs = now();
      const activeCooldown = cooldownStore.get(cooldownKey);
      if (activeCooldown) {
        if (activeCooldown.until > currentMs) {
          throw cooldownError(model, activeCooldown, currentMs);
        }
        cooldownStore.delete(cooldownKey);
      }

      const systemInstructions = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content);
      const contents = messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        }));
      const activity = [];
      const maxToolRounds = 6;

      try {
        for (let round = 0; round <= maxToolRounds; round += 1) {
          const body = {
            contents,
            systemInstruction: {
              parts: [
                { text: SYSTEM_INSTRUCTION },
                ...systemInstructions.map((text) => ({ text })),
              ],
            },
            ...(tools?.declarations?.length
              ? {
                tools: tools.declarations,
                toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
              }
              : {}),
          };

          const result = await requestGenerate(body, signal);
          const candidate = result?.candidates?.[0];
          const parts = candidate?.content?.parts || [];
          const functionCalls = parts.filter((part) => part.functionCall?.name);
          if (!functionCalls.length || !tools) {
            const text = parts
              .map((part) => part.text)
              .filter((part) => typeof part === 'string')
              .join('');
            if (!text) throw new Error('Gemini returned a response without message text.');
            return { text, provider: this.name, model, toolActivity: activity };
          }

          contents.push({ role: 'model', parts });
          const functionResponses = [];
          for (const part of functionCalls) {
            const { name, args = {} } = part.functionCall;
            activity.push({ tool: name, status: 'running' });
            try {
              const output = await tools.execute(name, { ...args, projectId });
              const requiresApproval = ['create_file', 'propose_file_change', 'run_command'].includes(name);
              Object.assign(activity[activity.length - 1], {
                status: requiresApproval ? 'awaiting approval' : 'completed',
                ...(['create_file', 'propose_file_change'].includes(name)
                  ? { proposal: { ...output, content: args.content }, projectId }
                  : {}),
                ...(name === 'run_command' ? { commandApproval: output, projectId } : {}),
              });
              const { originalContent, ...toolOutput } = output;
              functionResponses.push({ functionResponse: { name, response: { result: toolOutput } } });
            } catch (error) {
              const safeMessage = typeof error.publicMessage === 'string'
                ? error.publicMessage
                : error.message || 'Tool execution failed.';
              activity[activity.length - 1].status = 'failed';
              functionResponses.push({ functionResponse: { name, response: { error: safeMessage } } });
            }
          }
          contents.push({ role: 'user', parts: functionResponses });
        }

        throw new Error(`Gemini exceeded the maximum of ${maxToolRounds} tool-call rounds.`);
      } catch (error) {
        if (activity.length && !error.toolActivity) {
          error.toolActivity = [...activity];
        }
        throw error;
      }
    },
  };
}

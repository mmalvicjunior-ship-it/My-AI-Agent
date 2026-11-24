import {
  createProviderHttpError,
  createProviderNetworkError,
  isRetryableProviderError,
} from './provider-error.js';
import {
  consumeProviderAttempt,
  normalizeRetryState,
  remainingProviderAttempts,
} from './retry-policy.js';
import {
  FINAL_ANSWER_INSTRUCTION,
  NO_WORKSPACE_SYSTEM_INSTRUCTION,
  WORKSPACE_SYSTEM_INSTRUCTION,
  toolActivityDetail,
  toolResultMessage,
  trimToolResponse,
  withApprovalNotice,
} from './tool-response.js';

const DEFAULT_MODEL = 'gemini-3.8-flash';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_TOOL_ROUNDS = 6;
const ROUND_LIMIT_MESSAGE = `I reached the maximum of ${MAX_TOOL_ROUNDS} workspace tool-call rounds before producing a final answer. Please narrow the request and try again.`;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 15_000;
const DEFAULT_JITTER_MS = 250;
const DEFAULT_CAPACITY_COOLDOWN_MS = 60_000;
const DEFAULT_NETWORK_COOLDOWN_MS = 30_000;
const MAX_DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function attachRetryState(error, retryState) {
  if (error && typeof error === 'object') {
    error.retryState = normalizeRetryState(retryState);
    if (error.retryState.exhausted) {
      error.retryBudgetExhausted = true;
      error.retryable = false;
      error.fallbackEligible = false;
    }
  }
  return error;
}

function exhaustedRetryError(retryState) {
  const error = new Error('Gemini provider retry budget exhausted.');
  error.statusCode = 429;
  error.category = 'RATE_LIMITED';
  error.errorType = 'RATE_LIMITED';
  error.publicMessage = 'The provider retry budget was exhausted. The task was not completed.';
  return attachRetryState(error, retryState);
}

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
  // The cooldown check happens before any HTTP request, so this error consumed
  // no shared attempt. Fallback wrappers must not assume one was used.
  error.providerCooldownShortCircuit = true;
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

    // Concurrent failures can arrive out of order. Never let a shorter
    // capacity/network cooldown replace a longer quota cooldown (or any other
    // currently stronger cooldown). The error must report the effective wait so
    // a persisted nextRetryAt cannot be earlier than the cooldown still in force.
    const existing = cooldownStore.get(cooldownKey);
    if (existing && Number(existing.until) >= until) {
      const remaining = Math.max(0, Number(existing.until) - currentMs);
      error.retryAfterMs = remaining;
      error.retryAfterSeconds = Math.max(1, Math.ceil(remaining / 1000));
      return;
    }
    cooldownStore.set(cooldownKey, {
      until,
      category: error.category === 'QUOTA_EXHAUSTED' ? 'QUOTA_EXHAUSTED' : error.category,
      publicMessage: error.publicMessage,
    });
    error.retryAfterMs = Math.max(0, until - currentMs);
    error.retryAfterSeconds = Math.max(1, Math.ceil((until - currentMs) / 1000));
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

  async function requestGenerate(body, signal, retryState = null) {
    const url = `${API_URL}/${encodeURIComponent(model)}:generateContent`;
    const callerOwnsRetries = Boolean(retryState);
    // When the executor supplies a retryState it owns the whole budget, so
    // this adapter makes exactly one HTTP attempt per call. Without one, the
    // adapter keeps its existing bounded local retries for interactive chat.
    const maxAttemptsThisCall = callerOwnsRetries ? 1 : attempts;

    for (let attempt = 1; attempt <= maxAttemptsThisCall; attempt += 1) {
      if (signal?.aborted) throw cancelledRequestError();

      // The shared budget is consumed here, immediately before the HTTP call.
      // `retryState` is the caller's object so both success and error paths
      // report the same consumed state without another accounting layer.
      if (callerOwnsRetries) {
        if (retryState.exhausted) throw exhaustedRetryError(retryState);
        const next = consumeProviderAttempt(retryState);
        retryState.attemptsUsed = next.attemptsUsed;
        retryState.exhausted = next.exhausted;
      }

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
        if (!isRetryableProviderError(networkError) || attempt >= maxAttemptsThisCall) {
          setCooldown(networkError);
          throw callerOwnsRetries ? attachRetryState(networkError, retryState) : networkError;
        }
        if (!await pauseBeforeRetry(attempt, null, signal)) {
          setCooldown(networkError);
          throw callerOwnsRetries ? attachRetryState(networkError, retryState) : networkError;
        }
        continue;
      }

      if (!response.ok) {
        const error = await createProviderHttpError(response, 'Gemini', apiKey);
        if (!isRetryableProviderError(error) || attempt >= maxAttemptsThisCall) {
          setCooldown(error);
          throw callerOwnsRetries ? attachRetryState(error, retryState) : error;
        }
        if (!await pauseBeforeRetry(attempt, error.retryAfterMs, signal)) {
          setCooldown(error);
          throw callerOwnsRetries ? attachRetryState(error, retryState) : error;
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
        throw callerOwnsRetries ? attachRetryState(error, retryState) : error;
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

    async chat({ messages, tools, projectId, signal, retryState = null }) {
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

      const callerOwnsRetries = Boolean(retryState);
      let activeRetryState = callerOwnsRetries ? normalizeRetryState(retryState) : null;
      if (activeRetryState?.exhausted) {
        throw exhaustedRetryError(activeRetryState);
      }
      // Caller-owned attempts are consumed immediately before each HTTP request
      // in requestGenerate(). A cooldown short-circuit below therefore consumes
      // no shared budget.

      const hasTools = Boolean(tools?.declarations?.length && typeof tools.execute === 'function');
      const baseInstruction = hasTools ? WORKSPACE_SYSTEM_INSTRUCTION : NO_WORKSPACE_SYSTEM_INSTRUCTION;
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

      // A cooldown can be set by another task between tool rounds, so it must be
      // checked before every HTTP round, not just once at chat entry.
      function assertNoCooldown() {
        const currentMs = now();
        const entry = cooldownStore.get(cooldownKey);
        if (!entry) return;
        if (Number(entry.until) > currentMs) {
          const error = cooldownError(model, entry, currentMs);
          // Interactive chat treats an active cooldown as terminal. A task
          // caller can persist the remaining budget and resume after reset.
          if (callerOwnsRetries && remainingProviderAttempts(activeRetryState) > 0) {
            error.retryable = true;
          }
          throw callerOwnsRetries ? attachRetryState(error, activeRetryState) : error;
        }
        cooldownStore.delete(cooldownKey);
      }

      try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
          assertNoCooldown();
          if (callerOwnsRetries && activeRetryState.exhausted) {
            throw exhaustedRetryError(activeRetryState);
          }
          // On the final round the model is asked once for an answer without
          // tools, matching the OpenRouter adapter's round-limit behaviour.
          const forceFinalAnswer = round === MAX_TOOL_ROUNDS;
          const body = {
            contents,
            systemInstruction: {
              parts: [
                { text: baseInstruction },
                ...(forceFinalAnswer ? [{ text: FINAL_ANSWER_INSTRUCTION }] : []),
                ...systemInstructions.map((text) => ({ text })),
              ],
            },
            ...(!forceFinalAnswer && hasTools
              ? {
                tools: tools.declarations,
                toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
              }
              : {}),
          };

          const result = await requestGenerate(body, signal, activeRetryState);
          const candidate = result?.candidates?.[0];
          const parts = candidate?.content?.parts || [];
          const functionCalls = parts.filter((part) => part.functionCall?.name);
          if (!functionCalls.length || !hasTools || forceFinalAnswer) {
            const text = parts
              .map((part) => part.text)
              .filter((part) => typeof part === 'string')
              .join('');
            if (forceFinalAnswer && (functionCalls.length || !text)) {
              return {
                text: ROUND_LIMIT_MESSAGE,
                provider: this.name,
                model,
                toolActivity: activity,
                ...(callerOwnsRetries ? { retryState: normalizeRetryState(activeRetryState) } : {}),
              };
            }
            if (!text) {
              const error = new Error('Gemini returned a response without message text.');
              throw callerOwnsRetries ? attachRetryState(error, activeRetryState) : error;
            }
            return {
              text: withApprovalNotice(text, activity),
              provider: this.name,
              model,
              toolActivity: activity,
              ...(callerOwnsRetries ? { retryState: normalizeRetryState(activeRetryState) } : {}),
            };
          }

          contents.push({ role: 'model', parts });
          const functionResponses = [];
          for (const part of functionCalls) {
            const { name, args = {} } = part.functionCall;
            const callId = part.functionCall.id;
            const responseId = typeof callId === 'string' && callId ? { id: callId } : {};
            activity.push({ tool: name, status: 'running' });
            try {
              const output = await tools.execute(name, { ...args, projectId });
              const requiresApproval = ['create_file', 'propose_file_change', 'run_command'].includes(name);
              // Derive activity counts from the result actually sent to the
              // model, so transport trimming cannot inflate the UI numbers.
              const toolResponse = trimToolResponse(toolResultMessage(output));
              const detail = toolActivityDetail(name, toolResponse);
              Object.assign(activity[activity.length - 1], {
                status: requiresApproval ? 'awaiting approval' : 'completed',
                ...(detail ? { detail } : {}),
                ...(['create_file', 'propose_file_change'].includes(name)
                  ? { proposal: { ...output, content: args.content }, projectId }
                  : {}),
                ...(name === 'run_command' ? { commandApproval: output, projectId } : {}),
              });
              functionResponses.push({
                functionResponse: { name, ...responseId, response: toolResponse },
              });
            } catch (error) {
              const safeMessage = typeof error.publicMessage === 'string'
                ? error.publicMessage
                : error.message || 'Tool execution failed.';
              activity[activity.length - 1].status = 'failed';
              functionResponses.push({
                functionResponse: { name, ...responseId, response: { error: safeMessage } },
              });
            }
          }
          contents.push({ role: 'user', parts: functionResponses });
        }
      } catch (error) {
        if (activity.length && !error.toolActivity) {
          error.toolActivity = [...activity];
        }
        throw error;
      }
    },
  };
}

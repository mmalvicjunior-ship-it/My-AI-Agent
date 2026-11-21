import express from 'express';
import { config, redactSecrets } from '../config.js';
import { findOwnedProject } from '../auth/index.js';

export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_MESSAGES = 50;
const VALID_ROLES = new Set(['user', 'assistant', 'system']);
// Chat can be switched between the existing OpenRouter adapter and Gemini.
// Other providers remain selectable only through AI_PROVIDER at startup.
export const CHAT_PROVIDER_IDS = Object.freeze(['openai', 'gemini']);
const CHAT_PROVIDERS = new Set(CHAT_PROVIDER_IDS);

const bad = (error) => ({ ok: false, error });

/**
 * Validates the optional per-request provider override. Omitting it keeps the
 * startup provider (including mock/ollama and background-task behaviour).
 */
export function normalizeChatProvider(value) {
  if (value === undefined || value === null) return { ok: true, provider: null };
  if (typeof value !== 'string') {
    return bad('Field "provider" must be a string.');
  }
  const provider = value.trim().toLowerCase();
  if (!CHAT_PROVIDERS.has(provider)) {
    return bad(`Field "provider" must be one of: ${CHAT_PROVIDER_IDS.join(', ')}.`);
  }
  return { ok: true, provider };
}

/**
 * Validates and normalizes a chat request body.
 * Accepts either { message: "..." } or { messages: [{ role, content }, ...] }.
 * Returns { ok: true, messages } on success or { ok: false, error } on failure.
 */
export function normalizeChatInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('Request body must be a JSON object.');
  }

  let list;
  if (body.message !== undefined && body.messages !== undefined) {
    return bad('Provide either "message" or "messages", not both.');
  } else if (body.message !== undefined) {
    list = [{ role: 'user', content: body.message }];
  } else if (body.messages !== undefined) {
    if (!Array.isArray(body.messages)) return bad('Field "messages" must be an array.');
    list = body.messages;
  } else {
    return bad('Provide "message" (a string) or "messages" (an array of { role, content }).');
  }

  if (list.length === 0) return bad('The message list must not be empty.');
  if (list.length > MAX_MESSAGES) {
    return bad(`The message list must contain at most ${MAX_MESSAGES} messages.`);
  }

  const messages = [];
  for (const m of list) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return bad('Each message must be an object with "role" and "content".');
    }
    if (!VALID_ROLES.has(m.role)) {
      return bad('Each message "role" must be one of: user, assistant, system.');
    }
    if (typeof m.content !== 'string') {
      return bad('Each message "content" must be a string.');
    }
    if (m.content.trim() === '') {
      return bad('Message content must not be empty.');
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return bad(`Each message must be at most ${MAX_MESSAGE_CHARS} characters (received ${m.content.length}).`);
    }
    messages.push({ role: m.role, content: m.content });
  }

  return { ok: true, messages };
}

/**
 * Chat router: validates the complete conversation history, calls the
 * pluggable provider, and keeps secrets out of every response and log line.
 */
export function createChatRouter({
  db = null,
  provider,
  providerName = 'unset',
  tools = null,
  providerResolver = null,
}) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const normalized = normalizeChatInput(req.body);
    if (!normalized.ok) {
      console.warn(`[chat] Request rejected: provider=${providerName} status=400`);
      return res.status(400).json({ ok: false, error: normalized.error });
    }

    const requested = normalizeChatProvider(req.body?.provider);
    if (!requested.ok) {
      console.warn(`[chat] Request rejected: provider=${providerName} status=400`);
      return res.status(400).json({ ok: false, error: requested.error });
    }

    // Chat-only override. The startup provider (and therefore the background
    // task executor) is untouched.
    const activeProvider = requested.provider && typeof providerResolver === 'function'
      ? providerResolver(requested.provider)
      : provider;
    const activeProviderName = requested.provider || providerName;

    const latestUserMessage = [...normalized.messages]
      .reverse()
      .find((message) => message.role === 'user')?.content;
    const safeMessageLog = latestUserMessage === undefined
      ? '[no user message]'
      : config.debugChatPrompts
        ? redactSecrets(latestUserMessage)
        : `[hidden; ${latestUserMessage.length} characters]`;
    console.log('[chat] Received user message:', safeMessageLog);
    console.log('[chat] Active provider:', activeProvider?.name ?? config.aiProvider ?? activeProviderName);

    if (!activeProvider || typeof activeProvider.chat !== 'function') {
      return res.status(503).json({
        ok: false,
        error: `AI provider "${activeProviderName}" is not available. Choose openai or gemini for chat, or configure mock, huggingface, or ollama in the project-root .env (see .env.example).`,
      });
    }

    try {
      // The client sends prior user/assistant turns in this array so providers
      // can answer with conversation context instead of treating each prompt alone.
      const projectId = req.body?.projectId === undefined ? null : Number(req.body.projectId);
      if (projectId !== null && (!Number.isInteger(projectId) || projectId < 1)) {
        return res.status(400).json({ ok: false, error: 'projectId must identify a valid workspace.' });
      }
      // Workspace tools are only offered when the request names a project that
      // actually exists, so the model can never call tools for a missing one.
      const selectedProject = projectId === null ? null : findOwnedProject(db, req.user, projectId);
      if (projectId !== null && !selectedProject) {
        console.warn(`[chat] Request named workspace ${projectId}, which does not exist; continuing without workspace tools.`);
      }
      const result = await activeProvider.chat({
        messages: normalized.messages,
        tools: selectedProject ? tools : null,
        projectId: selectedProject ? projectId : null,
      });
      if (!result || typeof result.text !== 'string') {
        throw new Error('Provider returned a malformed result (missing text).');
      }
      console.info(`[chat] Request succeeded: provider=${result.provider ?? activeProvider.name ?? activeProviderName} status=200`);
      return res.json({
        ok: true,
        // Always report the provider/model that actually produced the reply.
        provider: result.provider ?? activeProvider.name ?? activeProviderName,
        model: result.model ?? activeProvider.model ?? null,
        reply: result.text,
        toolActivity: result.toolActivity || [],
        ...(result.fallback ? { fallback: result.fallback } : {}),
      });
    } catch (err) {
      // Log only a redacted one-liner; the client gets a generic message.
      const status = err.statusCode || 502;
      console.error(
        `[chat] Request failed: provider=${activeProvider.name ?? activeProviderName} status=${status}:`,
        redactSecrets(`${err.name}: ${err.message}`),
      );
      const body = {
        ok: false,
        error: typeof err.publicMessage === 'string'
          ? err.publicMessage
          : 'AI provider request failed. Details were logged on the server (secrets redacted).',
      };
      if (err.category || err.errorType) {
        body.errorCategory = err.category || err.errorType;
      }
      if (Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0) {
        body.retryAfterSeconds = Math.ceil(err.retryAfterMs / 1000);
      }
      if (err.fallbackAttempted) body.fallbackAttempted = true;
      return res.status(status).json(body);
    }
  });

  return router;
}

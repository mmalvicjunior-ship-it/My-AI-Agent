import express from 'express';
import { config, redactSecrets } from '../config.js';

export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_MESSAGES = 50;
const VALID_ROLES = new Set(['user', 'assistant', 'system']);

const bad = (error) => ({ ok: false, error });

/** Looks up a project row by id; returns null for missing/invalid ids. */
function findProject(db, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) return null;
  try {
    return db.prepare('SELECT id FROM projects WHERE id = ?').get(id) ?? null;
  } catch {
    return null;
  }
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
export function createChatRouter({ db = null, provider, providerName = 'unset', tools = null }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const normalized = normalizeChatInput(req.body);
    if (!normalized.ok) {
      console.warn(`[chat] Request rejected: provider=${providerName} status=400`);
      return res.status(400).json({ ok: false, error: normalized.error });
    }

    const latestUserMessage = [...normalized.messages]
      .reverse()
      .find((message) => message.role === 'user')?.content;
    const safeMessageLog = latestUserMessage === undefined
      ? '[no user message]'
      : config.debugChatPrompts
        ? redactSecrets(latestUserMessage)
        : `[hidden; ${latestUserMessage.length} characters]`;
    console.log('[chat] Received user message:', safeMessageLog);
    console.log('[chat] Active provider:', provider?.name ?? config.aiProvider ?? providerName);

    if (!provider || typeof provider.chat !== 'function') {
      return res.status(503).json({
        ok: false,
        error: `AI provider "${providerName}" is not available. Choose mock, gemini, openai, huggingface, or ollama in the project-root .env (see .env.example).`,
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
      const selectedProject = projectId === null ? null : findProject(db, projectId);
      if (projectId !== null && !selectedProject) {
        console.warn(`[chat] Request named workspace ${projectId}, which does not exist; continuing without workspace tools.`);
      }
      const result = await provider.chat({
        messages: normalized.messages,
        tools: selectedProject ? tools : null,
        projectId: selectedProject ? projectId : null,
      });
      if (!result || typeof result.text !== 'string') {
        throw new Error('Provider returned a malformed result (missing text).');
      }
      console.info(`[chat] Request succeeded: provider=${result.provider ?? provider.name ?? providerName} status=200`);
      return res.json({
        ok: true,
        provider: result.provider ?? provider.name ?? providerName,
        model: result.model ?? provider.model ?? null,
        reply: result.text,
        toolActivity: result.toolActivity || [],
      });
    } catch (err) {
      // Log only a redacted one-liner; the client gets a generic message.
      const status = err.statusCode || 502;
      console.error(
        `[chat] Request failed: provider=${provider.name ?? providerName} status=${status}:`,
        redactSecrets(`${err.name}: ${err.message}`),
      );
      return res.status(status).json({
        ok: false,
        error: typeof err.publicMessage === 'string'
          ? err.publicMessage
          : 'AI provider request failed. Details were logged on the server (secrets redacted).',
      });
    }
  });

  return router;
}

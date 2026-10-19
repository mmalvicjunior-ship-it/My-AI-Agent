import express from 'express';
import { redactSecrets } from '../config.js';

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_MESSAGES = 50;
const VALID_ROLES = new Set(['user', 'assistant', 'system']);

const bad = (error) => ({ ok: false, error });

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
 * Chat router: validates input, calls the pluggable provider, and keeps
 * secrets out of every response and log line.
 */
export function createChatRouter({ provider, providerName = 'unset' }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const normalized = normalizeChatInput(req.body);
    if (!normalized.ok) {
      return res.status(400).json({ ok: false, error: normalized.error });
    }

    if (!provider || typeof provider.chat !== 'function') {
      return res.status(503).json({
        ok: false,
        error: `AI provider "${providerName}" is not available. Set AI_PROVIDER=mock in the project-root .env (see .env.example).`,
      });
    }

    try {
      const result = await provider.chat({ messages: normalized.messages });
      if (!result || typeof result.text !== 'string') {
        throw new Error('Provider returned a malformed result (missing text).');
      }
      return res.json({
        ok: true,
        provider: result.provider ?? provider.name ?? providerName,
        model: result.model ?? provider.model ?? null,
        reply: result.text,
      });
    } catch (err) {
      // Log only a redacted one-liner; the client gets a generic message.
      console.error(
        `[chat] provider "${provider.name ?? providerName}" failed:`,
        redactSecrets(`${err.name}: ${err.message}`),
      );
      return res.status(502).json({
        ok: false,
        error: 'AI provider request failed. Details were logged on the server (secrets redacted).',
      });
    }
  });

  return router;
}

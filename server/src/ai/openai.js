import { createProviderHttpError, createProviderNetworkError } from './provider-error.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const API_URL = 'https://api.openai.com/v1/chat/completions';
const SYSTEM_INSTRUCTION = "You are a helpful, capable AI assistant. Always follow the user's instructions carefully and answer their requests directly.";

function configurationError() {
  const error = new Error('OpenAI is selected, but AI_API_KEY is not configured.');
  error.statusCode = 503;
  error.publicMessage = 'OpenAI is selected but no API key is configured. Add AI_API_KEY to the project-root .env file and restart the server.';
  return error;
}

export function createOpenAIProvider({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch }) {
  return {
    name: 'openai',
    model,

    async chat({ messages }) {
      if (!apiKey) throw configurationError();

      const systemMessages = messages.filter((message) => message.role === 'system');
      const conversationHistory = messages.filter((message) => message.role !== 'system');
      const requestMessages = [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        ...systemMessages,
        ...conversationHistory,
      ];
      const latestUserMessage = [...conversationHistory]
        .reverse()
        .find((message) => message.role === 'user');
      console.log(
        `[openai] Sending ${conversationHistory.length} conversation message(s) to ${model}; latest user message: ${latestUserMessage?.content.length ?? 0} characters.`,
      );

      let response;
      try {
        response = await fetchImpl(API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: requestMessages,
            temperature: 0.7,
          }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        throw createProviderNetworkError('OpenAI', error);
      }

      if (!response.ok) {
        throw await createProviderHttpError(response, 'OpenAI', apiKey);
      }

      const result = await response.json();
      const text = result?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error('OpenAI returned a response without message text.');
      }

      return { text, provider: this.name, model: result.model || model };
    },
  };
}

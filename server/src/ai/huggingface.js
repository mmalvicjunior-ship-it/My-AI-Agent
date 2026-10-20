import { createProviderHttpError, createProviderNetworkError } from './provider-error.js';

const DEFAULT_MODEL = 'meta-llama/Meta-Llama-3-8B-Instruct';
const API_URL = 'https://router.huggingface.co/v1/chat/completions';
const SYSTEM_INSTRUCTION = "You are a helpful, capable AI assistant. Always follow the user's instructions carefully and answer their requests directly.";

export function createHuggingFaceProvider({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch }) {
  return {
    name: 'huggingface',
    model,

    async chat({ messages }) {
      if (!apiKey) {
        const error = new Error('Hugging Face is selected, but AI_API_KEY is not configured.');
        error.statusCode = 503;
        error.publicMessage = 'Hugging Face is selected but no API key is configured. Add a Hugging Face token with Inference Providers permission to the project-root .env file and restart the server.';
        throw error;
      }

      const requestMessages = [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        ...messages,
      ];
      const latestUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === 'user');
      console.log(
        `[huggingface] Sending ${messages.length} conversation message(s) to ${model}; latest user message: ${latestUserMessage?.content.length ?? 0} characters.`,
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
        throw createProviderNetworkError('Hugging Face Inference Providers', error);
      }

      if (!response.ok) {
        throw await createProviderHttpError(response, 'Hugging Face Inference Providers', apiKey);
      }

      const result = await response.json();
      const text = result?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error('Hugging Face returned a response without message text.');
      }

      return { text, provider: this.name, model: result.model || model };
    },
  };
}

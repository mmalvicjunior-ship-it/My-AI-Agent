import { createProviderNetworkError } from './provider-error.js';

const DEFAULT_MODEL = 'llama3';
const API_URL = 'http://127.0.0.1:11434/api/chat';

export function createOllamaProvider({ model = DEFAULT_MODEL, fetchImpl = fetch } = {}) {
  return {
    name: 'ollama',
    model,
    async chat({ messages }) {
      let response;
      try {
        response = await fetchImpl(API_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            messages: messages.map(({ role, content }) => ({ role, content })),
          }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        const converted = createProviderNetworkError('Ollama', error);
        converted.publicMessage = 'Could not connect to Ollama at http://127.0.0.1:11434. Start Ollama and download the selected model.';
        throw converted;
      }
      if (!response.ok) {
        const error = new Error(`Ollama request failed with status ${response.status}.`);
        error.statusCode = response.status >= 500 ? 502 : response.status;
        error.publicMessage = `Ollama rejected the request (HTTP ${response.status}). Check that Ollama is running and the selected model is available.`;
        throw error;
      }
      const result = await response.json();
      if (typeof result?.message?.content !== 'string' || !result.message.content.trim()) {
        throw new Error('Ollama returned a response without message text.');
      }
      return { text: result.message.content, provider: this.name, model: result.model || model };
    },
  };
}

/**
 * Pluggable AI provider registry.
 *
 * Provider contract - a provider is a plain object:
 *   {
 *     name: string,                       // id used in config/responses
 *     model: string,                      // default model name
 *     chat({ messages, model? }): Promise<{
 *       text: string,                     // assistant reply
 *       provider: string,
 *       model: string,
 *     }>
 *   }
 *
 * `messages` is an array of { role: 'user' | 'assistant' | 'system', content: string }.
 *
 * Rules for every provider implementation:
 *   - Never log or return API keys or other secrets.
 *   - Throw a normal Error on failure; the route layer logs it redacted.
 *
 * To add a real provider later:
 *   1. create server/src/ai/<name>.js exporting an object that matches the contract
 *   2. import it here and register it: registry.set('<name>', <name>Provider)
 */
import { mockProvider } from './mock.js';
import { config } from '../config.js';
import { createGeminiProvider } from './gemini.js';
import { createHuggingFaceProvider } from './huggingface.js';
import { createOpenAIProvider } from './openai.js';
import { createOllamaProvider } from './ollama.js';

const providerFactories = new Map([
  ['openai', createOpenAIProvider],
  ['gemini', createGeminiProvider],
  ['huggingface', createHuggingFaceProvider],
  ['ollama', createOllamaProvider],
]);

/**
 * Resolves the configured provider. Select "mock" explicitly for offline
 * replies; a missing key for a real provider is reported as a configuration
 * error rather than silently switching providers.
 */
export function getProvider(name, settings = config) {
  if (name === 'mock') return mockProvider;

  const createProvider = providerFactories.get(name);
  if (!createProvider) return null;

  const defaults = {
    openai: 'gpt-4o-mini',
    gemini: 'gemini-flash-latest',
    huggingface: 'meta-llama/Meta-Llama-3-8B-Instruct',
    ollama: 'llama3',
  };
  return createProvider({
    apiKey: settings.aiApiKey,
    model: settings.aiModel || defaults[name],
    ...(name === 'openai' && settings.openaiBaseUrl
      ? { baseUrl: settings.openaiBaseUrl }
      : {}),
  });
}

/** Lists the provider names that are currently implemented. */
export function listProviders() {
  return ['mock', ...providerFactories.keys()];
}

// Providers whose adapters implement the workspace tool loop. A background task
// needs one of these; otherwise it could answer without ever inspecting files.
const TOOL_CAPABLE_PROVIDERS = new Set(['openai', 'gemini']);

/**
 * Whether a provider can execute workspace tools. Injected/test providers can
 * declare `supportsTools` explicitly; otherwise the adapter id decides.
 */
export function supportsWorkspaceTools(provider) {
  if (!provider || typeof provider.chat !== 'function') return false;
  if (typeof provider.supportsTools === 'boolean') return provider.supportsTools;
  return TOOL_CAPABLE_PROVIDERS.has(provider.name);
}

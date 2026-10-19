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

const registry = new Map([['mock', mockProvider]]);

/** Returns the provider for a name, or null if it is not implemented. */
export function getProvider(name) {
  return registry.get(name) ?? null;
}

/** Lists the provider names that are currently implemented. */
export function listProviders() {
  return [...registry.keys()];
}

/**
 * Mock AI provider - works with NO API key and NO network access.
 *
 * Contract (see ./index.js for details):
 *   chat({ messages }) -> Promise<{ text, provider, model }>
 */
export const mockProvider = {
  name: 'mock',
  model: 'mock-1',

  async chat({ messages }) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const preview = lastUser
      ? `${lastUser.content.slice(0, 160)}${lastUser.content.length > 160 ? '…' : ''}`
      : '(no user message)';

    const text = [
      `[mock provider] Received ${messages.length} message(s).`,
      `You said: "${preview}"`,
      `To use a real model, set AI_PROVIDER (and AI_API_KEY) in the project-root .env.`,
    ].join(' ');

    return { text, provider: this.name, model: this.model };
  },
};

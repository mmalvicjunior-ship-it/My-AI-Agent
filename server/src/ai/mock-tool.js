/** Deterministic mock tool-capable provider for autonomous-loop verification.
 * Does not replace the existing mockProvider; used only in isolated tests.
 * Never contacts OpenRouter or consumes quota.
 */
import { createTextFile, readTextFile, listDirectory } from '../workspace/files.js';

export const mockToolProvider = {
  name: 'mock-tool',
  displayName: 'Mock Tool (offline)',
  model: 'offline',
  supportsTools: true,

  async chat({ messages, tools, projectId, signal }) {
    if (signal?.aborted) throw new Error('Cancelled');

    const latest = messages.filter((m) => m.role === 'user').at(-1)?.content || '';
    const text = (latest.toLowerCase().includes('autonomous') || latest.toLowerCase().includes('fix') || latest.toLowerCase().includes('test'))
      ? '{"summary":"Mock autonomous plan","needsChanges":true,"changes":[{"kind":"update","path":"test.js","content":"// fixed\nexport const ok = true;\n","goal":"fix failing test"}],"commands":[{"command":"npm_test","goal":"verify fix"}]}'
      : '{"summary":"No changes needed","needsChanges":false}';

    return {
      text,
      provider: this.name,
      model: this.model,
      toolActivity: [],
    };
  },
};

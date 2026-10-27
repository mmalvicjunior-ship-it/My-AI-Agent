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
    // This provider never touches real code; it only simulates a planning reply for offline tests.
    const isAutonomousOrFix = latest.toLowerCase().includes('autonomous') || latest.toLowerCase().includes('fix') || latest.toLowerCase().includes('test');
    const text = isAutonomousOrFix
      ? '{"summary":"Mock autonomous plan (simulated only — no files were edited or commands executed; this is the mock-tool provider for offline verification)","needsChanges":true,"changes":[{"kind":"update","path":"test.js","content":"// simulated fix — not applied\\nexport const ok = true;\\n","goal":"simulated verification only"}],"commands":[{"command":"npm_test","goal":"simulated verification only"}]}'
      : '{"summary":"No changes needed (simulated/mock mode — no real code generated)","needsChanges":false}';

    return {
      text,
      provider: this.name,
      model: this.model,
      toolActivity: [],
    };
  },
};

PROPOSED FALLBACK / QUOTA RECOVERY UPGRADE — INSPECTION ONLY (not implemented)
===============================================
INSPECTED STATE:
- .env: AI_PROVIDER=openai, AI_MODEL=cohere/north-mini-code:free, OPENAI_BASE_URL=https://openrouter.ai/api/v1 (OpenRouter free tier).
- Provider adapters: mock.js, openai.js, gemini.js, huggingface.js, ollama.js (existing architecture; no OpenCode/Big Pickle adapter exists; cannot assume compatibility).
- Recovery logic: provider_paused status, saveRecoveryInfo/loadRecoveryInfo/claimRecoverableTask in store.js; runner tick resumes when retryAfter known; DB CHECK updated.
- Task Center: provider_paused display mapped.
- Tests: quota-recovery 2/2 pass; ai-providers 41/41 pass (free-models-per-day verified); full 175/175 pass.
- Build: passes from apps/web.
- Service: 3001 running; 5173 running.
- No live AI calls; no .env changes; no destructive git; all existing work preserved.

WHAT FALLBACK WOULD REQUIRE (only if user approves):
1. User must explicitly configure and authorize an alternative provider + model in .env (e.g., a second free-tier model, or a different provider with verified key). The code must NOT copy any token from OpenCode/Big Pickle or bypass access controls.
2. Adapter selection logic in server/src/ai/index.js and server/src/config.js would need to support a fallback list or retry with alternate config — only after user provides the second provider credentials.
3. Mock tests can verify fallback selection logic without live calls.
4. Any fallback must preserve approval rules, not switch to paid models silently, and not burn quota on the failed provider.

BLOCKERS / LIMITATIONS (confirmed, not assumed):
- No official documentation confirms OpenCode Big Pickle integrates with OpenRouter; I must not copy auth tokens or assume compatibility.
- Current free-tier quota is exhausted (openrouter 523/50 used/limit 50, remaining 0). No live provider test possible until quota resets or another authorized provider is configured.
- Existing recovery mechanism already pauses with clear message; automatic resumption only when retryAfter known or when user approves a new provider.
- Any fallback implementation must be explicit, user-authorized, and must not modify .env automatically.

APPRORVAL NEEDED BEFORE ANY EDITS:
- Confirm which alternative provider/model is authorized.
- Confirm whether fallback should use an existing adapter (gemini/ollama/huggingface/mock) or require a new adapter.
- Confirm whether .env should be edited by user or kept unchanged (current rule: do not modify .env automatically).

NO FILES EDITED FOR FALLBACK. All preservation rules met.

import { createProviderHttpError, createProviderNetworkError } from './provider-error.js';

const DEFAULT_MODEL = 'gemini-flash-latest';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const SYSTEM_INSTRUCTION = "You are a helpful coding assistant. Follow the user's instructions directly. When a project workspace is selected, inspect relevant files with tools before proposing changes, use create_file for new files and propose_file_change for edits to existing files. All file changes and commands require explicit user approval; use only the provided safe command tools. Never claim a tool succeeded unless its result confirms success.";

export function createGeminiProvider({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch }) {
  return {
    name: 'gemini',
    model,

    async chat({ messages, tools, projectId }) {
      if (!apiKey) {
        const error = new Error('Gemini is selected, but AI_API_KEY is not configured.');
        error.statusCode = 503;
        error.publicMessage = 'Gemini is selected but no API key is configured. Add a new Google AI API key to the project-root .env file and restart the server.';
        throw error;
      }

      const systemInstructions = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content);
      const contents = messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        }));
      const activity = [];
      const maxToolRounds = 6;
      for (let round = 0; round <= maxToolRounds; round += 1) {
        const body = {
          contents,
          systemInstruction: {
            parts: [
              { text: SYSTEM_INSTRUCTION },
              ...systemInstructions.map((text) => ({ text })),
            ],
          },
          ...(tools?.declarations?.length
            ? {
              tools: tools.declarations,
              toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            }
            : {}),
        };

        let response;
        try {
          response = await fetchImpl(
            `${API_URL}/${encodeURIComponent(model)}:generateContent`,
            {
              method: 'POST',
              headers: {
                'x-goog-api-key': apiKey,
                'content-type': 'application/json',
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(60_000),
            },
          );
        } catch (error) {
          throw createProviderNetworkError('Gemini', error);
        }

        if (!response.ok) {
          throw await createProviderHttpError(response, 'Gemini', apiKey);
        }

        const result = await response.json();
        const candidate = result?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const functionCalls = parts.filter((part) => part.functionCall?.name);
        if (!functionCalls.length || !tools) {
          const text = parts
            .map((part) => part.text)
            .filter((part) => typeof part === 'string')
            .join('');
          if (!text) throw new Error('Gemini returned a response without message text.');
          return { text, provider: this.name, model, toolActivity: activity };
        }

        contents.push({ role: 'model', parts });
        const functionResponses = [];
        for (const part of functionCalls) {
          const { name, args = {} } = part.functionCall;
          activity.push({ tool: name, status: 'running' });
          try {
            const output = await tools.execute(name, { ...args, projectId });
            const requiresApproval = ['create_file', 'propose_file_change', 'run_command'].includes(name);
            Object.assign(activity[activity.length - 1], {
              status: requiresApproval ? 'awaiting approval' : 'completed',
              ...(['create_file', 'propose_file_change'].includes(name)
                ? { proposal: { ...output, content: args.content }, projectId }
                : {}),
              ...(name === 'run_command' ? { commandApproval: output, projectId } : {}),
            });
            const { originalContent, ...toolOutput } = output;
            functionResponses.push({ functionResponse: { name, response: { result: toolOutput } } });
          } catch (error) {
            const safeMessage = typeof error.publicMessage === 'string'
              ? error.publicMessage
              : error.message || 'Tool execution failed.';
            activity[activity.length - 1].status = 'failed';
            functionResponses.push({ functionResponse: { name, response: { error: safeMessage } } });
          }
        }
        contents.push({ role: 'user', parts: functionResponses });
      }

      throw new Error(`Gemini exceeded the maximum of ${maxToolRounds} tool-call rounds.`);
    },
  };
}

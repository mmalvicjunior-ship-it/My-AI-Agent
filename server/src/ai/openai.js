import { createProviderHttpError, createProviderNetworkError } from './provider-error.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_RESULT_CHARS = 20_000;

// Tools whose result is only staged; the user must approve before anything is
// written or run.
const APPROVAL_TOOLS = new Set(['create_file', 'propose_file_change', 'run_command']);
const FILE_PROPOSAL_TOOLS = new Set(['create_file', 'propose_file_change']);
// Tools that take a workspace-relative path, used to normalize call signatures.
const PATH_ARGUMENT_TOOLS = new Set(['list_files', 'read_file', 'create_file', 'propose_file_change']);

const SYSTEM_INSTRUCTION = "You are MyAI, a coding assistant. Answer clearly and accurately. You have access only to this conversation: no project workspace is selected, so you have no workspace tools. You cannot read or write files, run commands, browse the web, or reach any external service. Say so plainly if a request needs workspace access or the web. Never claim to have applied a change, run a command, accessed external tools, or browsed the web.";
const CODING_SYSTEM_INSTRUCTION = "You are MyAI, a coding assistant working in the selected project workspace. The workspace tools listed for this request are the only tools you have: you cannot browse the web, reach any external service, or use tools that are not listed. Inspect relevant files with the tools before proposing changes. Use create_file for new files and propose_file_change for edits to existing files. Hard rule: a tool result with status \"awaiting_user_approval\" means nothing has been written or run yet. Describe it as staged and awaiting the user's approval, and never say that you created, wrote, updated, applied, ran, or executed it. File changes and commands require explicit user approval. Never claim a tool succeeded unless its result confirms success. After a tool returns enough information, stop calling tools and answer. Never repeat the same tool call with the same arguments. If the user asks to list files, call list_files once for the requested directory (the project root if unspecified), report the returned paths, and do not read file contents.";
const FINAL_ANSWER_INSTRUCTION = "Do not call any more tools. Use the tool results already in the conversation to answer. If you cannot complete the request from those results, say so clearly.";
const ROUND_LIMIT_MESSAGE = `I reached the maximum of ${MAX_TOOL_ROUNDS} workspace tool-call rounds before producing a final answer. Please narrow the request and try again.`;
const REPEAT_MESSAGE = 'I stopped after the model repeated an identical workspace tool call. I reused the existing result and did not execute it again.';
// A reply that already talks about the approval flow does not need the
// deterministic note appended.
const APPROVAL_MENTION = /approv|staged|awaiting|pending|review/i;
// Wording that already says the work is not done.
const PENDING_WORDING = /approv|staged|pending|awaiting|not been|has not|hasn['’]t|has yet|yet to|will be|to be applied/i;
// Past-tense verbs that assert the work already happened.
const COMPLETION_VERB = /\b(?:created|creates|wrote|written|saved|added|updated|applied|generated|modified|edited|implemented|executed|ran|run|made|done|completed|finished|populated|filled|inserted|deleted|removed|renamed|moved|copied|committed|deployed|installed)\b/i;
// A future statement is not a false completion claim.
const FUTURE_STATEMENT = /\b(?:will|shall|going to|about to|intend to|plan to|would like to)\b/i;
// Ways a sentence can refer to the pending work without naming it. The
// reference has to sit right after the verb so unrelated sentences survive.
const INDIRECT_REFERENCE = /\b(?:created|creates|wrote|written|saved|added|updated|applied|generated|modified|edited|implemented|executed|ran|run|made|completed|finished|populated|filled|inserted|deleted|removed|renamed|moved|copied|committed|deployed|installed)\b(?:\s+\w+){0,2}\s+(?:the|this|that)\s+(?:file|command|change|edit)\b/i;
const COMPLETION_ADVERB = /\b(?:successfully|already)\b/i;
// One sentence, including its trailing whitespace.
const SENTENCE_PATTERN = /[^.!?\n]*[.!?]+[ \t]*|[^.!?\n]+$/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces paths and other dotted tokens with dot-free placeholders so the
 * text can be split into sentences without cutting "notes.txt" in half.
 */
function protectTokens(text, labels) {
  const tokens = [];
  const originals = [];
  let result = text;

  const variants = [];
  for (const label of labels) {
    variants.push(label);
    const base = label.split(/[\\/]/).pop();
    if (base && base !== label) variants.push(base);
  }
  for (const variant of variants) {
    const pattern = new RegExp(escapeRegExp(variant), 'gi');
    if (!result.match(pattern)) continue;
    const token = `\u0001T${tokens.length}\u0001`;
    tokens.push(token);
    originals.push(variant);
    result = result.replace(pattern, token);
  }
  const labelTokens = new Set(tokens);

  result = result.replace(/\b[A-Za-z0-9_'-]+\.[A-Za-z0-9_'-]+\b/g, (match) => {
    const token = `\u0001T${tokens.length}\u0001`;
    tokens.push(token);
    originals.push(match);
    return token;
  });

  return { text: result, tokens, originals, labelTokens };
}

/** The labels of the staged work the user still has to approve. */
function pendingLabels(toolActivity) {
  return toolActivity
    .filter((item) => item.status === 'awaiting approval')
    .map((item) => item.proposal?.path || item.commandApproval?.command)
    .filter((label) => typeof label === 'string' && label.trim());
}

/** The labels of the work whose tool call failed, so the reply cannot claim it. */
function failedLabels(toolActivity) {
  return toolActivity
    .filter((item) => item.status === 'failed')
    .map((item) => item.proposal?.path)
    .filter((label) => typeof label === 'string' && label.trim());
}

/**
 * True when a sentence asserts that the pending work is already done.
 * Only completed work that names the pending path (or refers to it
 * indirectly) counts, so unrelated statements are left alone.
 */
function isFalseCompletionClaim(sentence, labelTokens) {
  if (!COMPLETION_VERB.test(sentence)) return false;
  if (PENDING_WORDING.test(sentence)) return false;
  if (FUTURE_STATEMENT.test(sentence)) return false;
  for (const token of labelTokens) {
    if (sentence.includes(token)) return true;
  }
  if (INDIRECT_REFERENCE.test(sentence)) return true;
  return COMPLETION_ADVERB.test(sentence);
}

/** Removes sentences that claim the pending work is already done. */
function removeFalseCompletionClaims(text, labels) {
  const guarded = protectTokens(text, labels);
  let removed = false;
  const cleaned = guarded.text.replace(SENTENCE_PATTERN, (sentence) => {
    if (!isFalseCompletionClaim(sentence, guarded.labelTokens)) return sentence;
    removed = true;
    return '';
  });
  if (!removed) return text;
  let restored = cleaned;
  guarded.tokens.forEach((token, index) => {
    restored = restored.split(token).join(guarded.originals[index]);
  });
  return restored.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Safety net: if a change is only staged, the reply must not read as if it was
 * already applied. Small models sometimes say "created" first and "staged"
 * later, so false completion claims are removed and an explicit note is added
 * when the reply never mentions the approval flow.
 */
function withApprovalNotice(text, toolActivity) {
  if (typeof text !== 'string' || !text.trim()) return text;
  const pending = pendingLabels(toolActivity);
  const labels = [...pending, ...failedLabels(toolActivity)];
  if (!labels.length) return text;
  const cleaned = removeFalseCompletionClaims(text, labels);
  if (!pending.length) return cleaned;
  if (APPROVAL_MENTION.test(cleaned)) return cleaned;
  const subject = pending.length > 1 ? `${pending.join(', ')} are` : `${pending[0]} is`;
  const note = `Nothing has been written or run yet: ${subject} staged and waiting for your approval in the app.`;
  return cleaned ? `${cleaned}\n\n${note}` : note;
}

/**
 * Converts a Gemini-style schema (upper-case type names) into a valid
 * OpenAI-compatible JSON Schema. Nested objects, arrays and type unions are
 * normalized too, so a nested "OBJECT"/"STRING" schema stays valid.
 */
function normalizeSchemaTypes(schema) {
  if (Array.isArray(schema)) return schema.map(normalizeSchemaTypes);
  if (!schema || typeof schema !== 'object') return schema;
  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type') {
      if (typeof value === 'string') {
        normalized.type = value.toLowerCase();
      } else if (Array.isArray(value)) {
        normalized.type = value.map((entry) => (typeof entry === 'string' ? entry.toLowerCase() : entry));
      } else {
        normalized.type = value;
      }
      continue;
    }
    normalized[key] = normalizeSchemaTypes(value);
  }
  return normalized;
}

/**
 * Removes the server-managed `projectId` property from a schema. The workspace
 * id is injected by the server, so the model never has to guess it and the
 * tool call cannot target another workspace.
 */
function removeProjectId(schema) {
  if (Array.isArray(schema)) return schema.map(removeProjectId);
  if (!schema || typeof schema !== 'object') return schema;
  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const properties = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        if (propertyName === 'projectId') continue;
        properties[propertyName] = removeProjectId(propertySchema);
      }
      cleaned.properties = properties;
      continue;
    }
    if (key === 'required' && Array.isArray(value)) {
      const required = value.filter((name) => name !== 'projectId');
      if (required.length) cleaned.required = required;
      continue;
    }
    cleaned[key] = removeProjectId(value);
  }
  return cleaned;
}

/** Builds the `parameters` JSON Schema for one OpenAI-compatible function. */
function toJsonSchema(parameters) {
  const schema = normalizeSchemaTypes(parameters && typeof parameters === 'object' ? parameters : {});
  const cleaned = removeProjectId(schema);
  if (!cleaned.type) cleaned.type = 'object';
  if (cleaned.type === 'object') {
    if (!cleaned.properties || typeof cleaned.properties !== 'object') cleaned.properties = {};
    if (cleaned.required && !Array.isArray(cleaned.required)) delete cleaned.required;
    if (Array.isArray(cleaned.required) && cleaned.required.length === 0) delete cleaned.required;
  }
  return cleaned;
}

/** Converts the shared tool declarations into OpenAI-compatible function tools. */
function openAIToolsFromDeclarations(declarations) {
  return (declarations || []).flatMap((declaration) => (
    declaration.functionDeclarations || []
  )).map((functionDeclaration) => ({
    type: 'function',
    function: {
      name: functionDeclaration.name,
      description: functionDeclaration.description,
      parameters: toJsonSchema(functionDeclaration.parameters),
    },
  }));
}

/** Parses tool arguments safely; malformed arguments never reach a tool. */
function parseToolArguments(argumentsValue) {
  if (argumentsValue && typeof argumentsValue === 'object') return argumentsValue;
  if (typeof argumentsValue !== 'string') {
    throw new Error('Tool arguments were missing.');
  }
  const trimmed = argumentsValue.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error('Tool arguments were not valid JSON.');
  }
}

/** Normalizes a workspace-relative path so equivalent spellings compare equal. */
function normalizePathArgument(value) {
  if (typeof value !== 'string') return value;
  const cleaned = value.trim().replace(/\\/g, '/');
  if (cleaned === '') return '.';
  const withoutTrailingSlash = cleaned.replace(/\/+$/, '');
  const withoutCurrentPrefix = withoutTrailingSlash.replace(/^\.\//, '');
  if (withoutCurrentPrefix === '' || withoutCurrentPrefix === '.') return '.';
  return withoutCurrentPrefix;
}

/** JSON with a stable key order, so argument order never changes a signature. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

/**
 * Signature of one tool call, used to detect repeats. `projectId` is ignored
 * (the server owns it) and equivalent path spellings - including a `list_files`
 * call with an omitted path versus "." - share one signature.
 */
function toolCallSignature(name, args) {
  const normalized = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'projectId') continue;
    normalized[key] = PATH_ARGUMENT_TOOLS.has(name) && key === 'path'
      ? normalizePathArgument(value)
      : value;
  }
  if (name === 'list_files' && !Object.hasOwn(normalized, 'path')) normalized.path = '.';
  return `${name}:${stableStringify(normalized)}`;
}

/** Serializes a tool result, trimming oversized payloads before they reach the model. */
function serializeToolResponse(response) {
  const serialized = JSON.stringify(response);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return serialized;
  const result = response?.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const trimmed = { ...result, truncated: true };
    if (typeof trimmed.content === 'string') {
      trimmed.content = `${trimmed.content.slice(0, MAX_TOOL_RESULT_CHARS)}\n[tool output truncated]`;
    }
    return JSON.stringify({ result: trimmed });
  }
  return JSON.stringify({
    error: `Tool output was larger than ${MAX_TOOL_RESULT_CHARS} characters and was trimmed before it was sent to the model.`,
  });
}

/**
 * Detects an upstream "this model cannot call tools" rejection so the user
 * gets an actionable message instead of a generic provider failure.
 */
async function detectToolSupportFailure(response) {
  try {
    const payload = await response.json();
    const message = payload?.error?.message ?? payload?.message ?? payload?.error;
    const text = typeof message === 'string' ? message : '';
    if (!text) return false;
    return /(?:does not|doesn't|cannot|can't|unable to|no)\s+(?:currently\s+)?(?:support|use|call)/i.test(text)
      && /(?:tool|function)/i.test(text);
  } catch {
    return false;
  }
}

/**
 * Human-readable provider name for error messages. The provider id stays
 * "openai" (it is the OpenAI-compatible adapter), but a custom base URL gets a
 * name of its own so OpenRouter users are not told about "OpenAI" errors.
 */
function providerLabel(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (!host || host === 'api.openai.com') return 'OpenAI';
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'OpenRouter';
    return `the API at ${host}`;
  } catch {
    return 'OpenAI';
  }
}

function configurationError() {
  const error = new Error('OpenAI is selected, but AI_API_KEY is not configured.');
  error.statusCode = 503;
  error.publicMessage = 'OpenAI is selected but no API key is configured. Add AI_API_KEY to the project-root .env file and restart the server.';
  return error;
}

/** External cancellation is not a provider timeout or network failure. */
function cancelledRequestError() {
  const error = new Error('The AI request was cancelled.');
  error.name = 'AbortError';
  error.statusCode = 499;
  return error;
}

export function createOpenAIProvider({
  apiKey,
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
}) {
  const apiUrl = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const providerName = providerLabel(baseUrl);
  return {
    name: 'openai',
    // The adapter id stays "openai"; the display name names the actual
    // service (for example OpenRouter) so errors do not mislead.
    displayName: providerName,
    model,

    async chat({ messages, tools, projectId, signal }) {
      if (!apiKey) throw configurationError();

      const systemMessages = messages.filter((message) => message.role === 'system');
      const conversationHistory = messages.filter((message) => message.role !== 'system');
      const hasTools = Boolean(tools?.declarations?.length && typeof tools.execute === 'function');
      const requestMessages = [
        { role: 'system', content: hasTools ? CODING_SYSTEM_INSTRUCTION : SYSTEM_INSTRUCTION },
        ...systemMessages,
        ...conversationHistory,
      ];
      const openAITools = hasTools ? openAIToolsFromDeclarations(tools.declarations) : [];
      const toolActivity = [];
      const toolResults = new Map();
      let finalAnswerReason = '';
      const latestUserMessage = [...conversationHistory]
        .reverse()
        .find((message) => message.role === 'user');
      console.log(
        `[openai] Sending ${conversationHistory.length} conversation message(s) to ${model}; latest user message: ${latestUserMessage?.content.length ?? 0} characters.`,
      );

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        // After a repeated call or on the last round the model is asked for a
        // final answer exactly once, with no tools attached.
        const forceFinalAnswer = Boolean(finalAnswerReason) || round === MAX_TOOL_ROUNDS;
        if (forceFinalAnswer && !requestMessages[0].content.includes(FINAL_ANSWER_INSTRUCTION)) {
          requestMessages[0].content += ` ${FINAL_ANSWER_INSTRUCTION}`;
        }

        let response;
        try {
          const timeoutSignal = AbortSignal.timeout(60_000);
          const requestSignal = signal
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal;
          response = await fetchImpl(apiUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: requestMessages,
              temperature: 0.7,
              ...(openAITools.length && !forceFinalAnswer
                ? { tools: openAITools, tool_choice: 'auto' }
                : {}),
            }),
            signal: requestSignal,
          });
        } catch (error) {
          if (signal?.aborted) throw cancelledRequestError();
          throw createProviderNetworkError(providerName, error);
        }

        if (!response.ok) {
          const toolSupportFailure = openAITools.length && typeof response.clone === 'function'
            ? await detectToolSupportFailure(response.clone())
            : false;
          const error = await createProviderHttpError(response, providerName, apiKey);
          if (toolSupportFailure) {
            error.publicMessage = `The configured model "${model}" cannot call tools on this provider, so workspace tools are unavailable for this request. OpenRouter model capabilities and free-tier availability vary; set AI_MODEL to a tool-capable model in the project-root .env.`;
          }
          throw error;
        }

        const result = await response.json();
        const message = result?.choices?.[0]?.message;
        const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        const fallbackText = finalAnswerReason || ROUND_LIMIT_MESSAGE;

        if (!toolCalls.length || !openAITools.length) {
          const text = message?.content;
          if (typeof text !== 'string' && forceFinalAnswer) {
            return {
              text: fallbackText,
              provider: this.name,
              model: result.model || model,
              toolActivity,
            };
          }
          if (typeof text !== 'string') {
            const error = new Error('OpenAI returned a response without message text.');
            error.publicMessage = 'The AI provider returned an empty response. Please try again.';
            throw error;
          }
          return {
            text: withApprovalNotice(text, toolActivity),
            provider: this.name,
            model: result.model || model,
            toolActivity,
          };
        }
        if (forceFinalAnswer) {
          return {
            text: fallbackText,
            provider: this.name,
            model: result.model || model,
            toolActivity,
          };
        }
        if (toolCalls.some((call) => (
          typeof call.id !== 'string'
          || !call.id
          || typeof call.function?.name !== 'string'
          || !call.function.name
        ))) {
          const error = new Error('OpenAI returned a malformed tool call.');
          error.publicMessage = 'The AI provider returned a malformed tool call. Please try again.';
          throw error;
        }

        // The assistant turn keeps the tool calls so every tool result can be
        // matched to its call by tool_call_id.
        requestMessages.push({
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : null,
          tool_calls: toolCalls,
        });
        for (const toolCall of toolCalls) {
          const functionName = toolCall.function.name;
          const activityItem = { tool: functionName, status: 'running' };
          toolActivity.push(activityItem);

          let toolResponse;
          try {
            const args = parseToolArguments(toolCall.function.arguments);
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              throw new Error('OpenAI returned invalid tool arguments.');
            }
            const signature = toolCallSignature(functionName, args);
            const previousResult = toolResults.get(signature);
            if (previousResult) {
              // Identical call: reuse the earlier result instead of running the
              // tool a second time, then ask for a final answer.
              activityItem.status = previousResult.status;
              activityItem.reused = true;
              toolResponse = previousResult.response;
              finalAnswerReason = REPEAT_MESSAGE;
            } else {
              try {
                const output = await tools.execute(functionName, { ...args, projectId });
                Object.assign(activityItem, {
                  status: APPROVAL_TOOLS.has(functionName) ? 'awaiting approval' : 'completed',
                  ...(FILE_PROPOSAL_TOOLS.has(functionName)
                    ? { proposal: { ...output, content: args.content }, projectId }
                    : {}),
                  ...(functionName === 'run_command' ? { commandApproval: output, projectId } : {}),
                });
                const { originalContent, ...safeOutput } = output;
                toolResponse = { result: safeOutput };
              } catch (error) {
                const safeMessage = typeof error.publicMessage === 'string'
                  ? error.publicMessage
                  : error.message || 'Tool execution failed.';
                activityItem.status = 'failed';
                // Keep the target so the reply cannot claim a failed write succeeded.
                if (FILE_PROPOSAL_TOOLS.has(functionName) && typeof args.path === 'string') {
                  activityItem.proposal = { path: args.path };
                }
                toolResponse = { error: safeMessage };
              }
              toolResults.set(signature, { response: toolResponse, status: activityItem.status });
            }
          } catch (error) {
            const safeMessage = typeof error.publicMessage === 'string'
              ? error.publicMessage
              : error.message || 'Tool execution failed.';
            activityItem.status = 'failed';
            toolResponse = { error: safeMessage };
          }

          requestMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: serializeToolResponse(toolResponse),
          });
        }
      }

      const error = new Error('OpenAI could not complete the final response after workspace tool calls.');
      error.publicMessage = ROUND_LIMIT_MESSAGE;
      throw error;
    },
  };
}

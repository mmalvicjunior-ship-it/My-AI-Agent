// Read-only background task executor.
//
// Stage 3 connects the durable task queue to the existing coding agent without
// any HTTP request or browser tab. It reuses the workspace tools and the
// provider adapters, but only exposes the three inspection tools:
//
//   read_file, list_files, search_files
//
// The filtered declarations are the first line of defence; the wrapper below is
// the second, so a hallucinated create_file/propose_file_change/run_command call
// is refused before it can reach the proposal store or spawn a process.
//
// Retry policy: at most three provider attempts (two retries) for transient
// failures only (HTTP 429, 502, 504). Auth/configuration errors, malformed
// responses, tool-support failures, and cancellation are never retried.
import { setTimeout as delay } from 'node:timers/promises';
import { redactSecrets } from '../config.js';
import { supportsWorkspaceTools } from '../ai/index.js';
import { WorkspaceError } from '../workspace/files.js';
import { loadPlan, savePlan } from './store.js';
import { describePlan, sanitizePlan, buildPlanMetadata, parseJsonReply } from './plan.js';

const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search_files']);
const MAX_PROVIDER_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000];
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RESULT_CHARS = 10_000;
const MAX_STEP_DETAIL_CHARS = 500;
const MAX_TITLE_VALUE_CHARS = 80;

const BACKGROUND_INSTRUCTION = [
  'You are MyAI running an unattended background task inside the user\'s selected project workspace.',
  'The only tools available to you are read_file, list_files, and search_files; all three are read-only.',
  'Use them to inspect the workspace when the request depends on its contents.',
  'Answer with a single JSON object and nothing else: {"summary":"brief factual summary","needsChanges":true|false}.',
  'Set needsChanges to true only when the request really needs file edits or an allowlisted project command; otherwise set it to false.',
  'Never claim that you created, edited, deleted, applied, staged, or ran anything.',
  'Do not invent file contents or paths. Do not include API keys, credentials, or environment variable values in your answer.',
].join(' ');

const REPAIR_INSTRUCTION = [
  'You are assisting a repair stage for background task errors.',
  'The previous verification command failed; inspect the error output.',
  'Propose the smallest justified fix using only the allowed read-only tools.',
  'Reply ONLY with a JSON object: {"summary":"brief","changes":[{"kind":"update","path":"...","content":"..."}],"commands":[]}.',
  'Never claim the fix was applied; it must be staged for user approval.',
  'Never include secrets or environment values.',
].join(' ');

const ASK_CONTINUE_INSTRUCTION = [
  'You have completed the current batch of work. Inspect the workspace briefly.',
  'Reply ONLY with JSON: {"done":true,"summary":"..."} if finished;',
  'or {"keepGoing":true,"summary":"...","changes":[...],"commands":[...]} if more work is needed.',
  'Keep changes minimal and justified. Never claim anything has been applied.',
].join(' ');

function cancelledError() {
  const error = new Error('The background task was cancelled.');
  error.name = 'AbortError';
  error.statusCode = 499;
  return error;
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Public, redacted provider failure text suitable for the task error column. */
function providerFailureMessage(error) {
  const message = typeof error?.publicMessage === 'string'
    ? error.publicMessage
    : error?.message || 'AI provider request failed.';
  return redactSecrets(String(message));
}

function isRetryable(error) {
  const status = Number(error?.statusCode);
  return status === 429 || status === 502 || status === 504;
}

function toolTitle(name, args = {}) {
  if (name === 'read_file') {
    return `Read ${typeof args.path === 'string' && args.path ? args.path : '(missing path)'}`;
  }
  if (name === 'list_files') {
    return `Listed ${typeof args.path === 'string' && args.path ? args.path : '.'}`;
  }
  if (name === 'search_files') {
    return `Searched for "${clip(args.query, MAX_TITLE_VALUE_CHARS)}"`;
  }
  return name;
}

/**
 * Compact progress detail. Deliberately contains counts/sizes only: file
 * contents and search result text must never be copied into task logs.
 */
function toolSummary(name, output) {
  if (name === 'read_file') {
    const bytes = Number(output?.size);
    return `${output?.path ?? 'file'} (${Number.isFinite(bytes) ? `${bytes} bytes` : 'read'})`;
  }
  if (name === 'list_files') {
    const count = Array.isArray(output?.files) ? output.files.length : 0;
    return `${count} entr${count === 1 ? 'y' : 'ies'} under ${output?.path ?? '.'}${output?.truncated ? ' (truncated)' : ''}`;
  }
  if (name === 'search_files') {
    const count = Array.isArray(output?.results) ? output.results.length : 0;
    return `${count} match${count === 1 ? '' : 'es'}${output?.truncated ? ' (truncated)' : ''}`;
  }
  return '';
}

/**
 * Builds the read-only view passed to the provider. The returned object has the
 * same `declarations`/`execute` shape the adapters already use.
 */
export function createReadOnlyTools({ tools, projectId, addStep, signal }) {
  const declarations = (Array.isArray(tools?.declarations) ? tools.declarations : [])
    .map((group) => ({
      ...group,
      functionDeclarations: (group.functionDeclarations || [])
        .filter((declaration) => READ_ONLY_TOOLS.has(declaration.name)),
    }))
    .filter((group) => group.functionDeclarations.length > 0);

  return {
    declarations,
    async execute(name, args = {}) {
      if (signal?.aborted) throw cancelledError();

      // Server‑side authorization guard – only the three read‑only tools are ever permitted.
      if (!isToolAllowedForTask(name)) {
        const message = `Background tasks are read-only in this stage. "${name}" is not available; only read_file, list_files, and search_files may be used.`;
        addStep({
          kind: 'tool',
          title: `Refused ${name}`,
          detail: message,
          status: 'failed',
        });
        throw new WorkspaceError(403, message);
      }

      // Always use the task's project, even if the model supplies another id.
      const toolArgs = { ...args, projectId };
      try {
        const output = await tools.execute(name, toolArgs);
        addStep({
          kind: 'tool',
          title: toolTitle(name, toolArgs),
          detail: clip(toolSummary(name, output), MAX_STEP_DETAIL_CHARS),
          status: 'done',
        });
        return output;
      } catch (error) {
        if (signal?.aborted) throw cancelledError();
        addStep({
          kind: 'tool',
          title: toolTitle(name, toolArgs),
          detail: clip(redactSecrets(error?.message || 'Tool execution failed.'), MAX_STEP_DETAIL_CHARS),
          status: 'failed',
        });
        throw error;
      }
    },
  };
}

/**
 * Server‑side guard that decides whether a tool may be executed for a given task.
 * The decision is based solely on the tool name – writes and commands are
 * never allowed regardless of the task's autonomy level. This prevents a
 * future autonomy level from unintentionally granting write/command power.
 * @param {string} toolName - name of the tool the model wants to call
 * @returns {boolean} true only for the three read‑only tools
 */
export function isToolAllowedForTask(toolName) {
  return READ_ONLY_TOOLS.has(toolName);
}

function parseStoredResult(resultJson) {
  try {
    const text = typeof resultJson === 'string' ? resultJson : JSON.stringify(resultJson);
    const parsed = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      exitCode: parsed.exitCode ?? null,
      stdout: parsed.stdout || '',
      stderr: parsed.stderr || '',
      command: parsed.command || null,
      summary: clip(String(parsed.stdout || parsed.stderr || ''), 800),
    };
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {object} options.db
 * @param {object} options.provider  resolved provider adapter
 * @param {object} options.tools     real workspace toolset
 * @param {number[]} options.retryDelaysMs  injected in tests to avoid waiting
 * @param {object} options.logger
 */
export function createTaskExecutor({
  db,
  provider = null,
  tools = null,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  logger = console,
} = {}) {
  const delays = Array.isArray(retryDelaysMs) && retryDelaysMs.length > 0
    ? retryDelaysMs
    : DEFAULT_RETRY_DELAYS_MS;

  /**
   * Finalizes a task whose staged proposals have all reached a terminal state.
   * It reports the real outcome of each proposal: what was applied, what was
   * rejected, what failed, and the recorded exit status of any approved
   * command. A pending proposal is never reported as applied.
   */
  async function finalizeTask(db, task, savedPlan, addStep, { final = true } = {}) {
    const plan = savedPlan && typeof savedPlan === 'object' ? savedPlan : null;
    const summary = describePlan(plan);
    if (summary) {
      addStep({
        kind: 'note',
        title: 'Plan summary',
        detail: clip(summary, MAX_STEP_DETAIL_CHARS),
      });
    }

    const proposalIds = Array.isArray(plan?.proposals)
      ? plan.proposals.map((entry) => (entry && typeof entry === 'object' ? entry.id : entry)).filter(Boolean)
      : [];

    const applied = [];
    const rejected = [];
    const failed = [];
    const unknown = [];
    const testResults = [];
    for (const failure of Array.isArray(plan?.stagingFailures) ? plan.stagingFailures : []) {
      if (typeof failure === 'string' && failure.trim()) failed.push(redactSecrets(failure));
    }

    for (const id of proposalIds) {
      const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
      if (!row) {
        unknown.push(id);
        continue;
      }
      const label = row.kind === 'command'
        ? `command ${row.command}`
        : `${row.kind} ${row.path}`;
      if (row.status === 'applied') {
        applied.push(label);
        addStep({
          kind: 'note',
          title: row.kind === 'command' ? `Command approved: ${row.command}` : `Change applied: ${row.path}`,
          detail: row.kind === 'command'
            ? 'The user approved this command and it was executed through the approved-command workflow.'
            : 'The user approved this change and it was written to the workspace.',
        });
        if (row.kind === 'command') {
          const result = parseStoredResult(row.result_json);
          if (result) {
            testResults.push({ command: row.command, exitCode: result.exitCode, output: result.summary });
            addStep({
              kind: 'note',
              title: `Command result: ${row.command}`,
              detail: clip(`Exit status ${result.exitCode}. ${result.summary}`, MAX_STEP_DETAIL_CHARS),
            });
          } else {
            testResults.push({ command: row.command, exitCode: null, output: 'No recorded output.' });
          }
        }
      } else if (row.status === 'rejected') {
        rejected.push(label);
        addStep({
          kind: 'note',
          title: row.kind === 'command' ? `Command rejected: ${row.command}` : `Change rejected: ${row.path}`,
          detail: 'The user declined this proposal, so nothing was changed.',
        });
      } else if (row.status === 'failed') {
        failed.push(label);
        addStep({
          kind: 'note',
          title: row.kind === 'command' ? `Command failed: ${row.command}` : `Change failed: ${row.path}`,
          detail: clip(redactSecrets(row.error || 'The proposal failed.'), MAX_STEP_DETAIL_CHARS),
          status: 'failed',
        });
      } else {
        unknown.push(label);
        addStep({
          kind: 'note',
          title: row.kind === 'command' ? `Command outcome unknown: ${row.command}` : `Change outcome unknown: ${row.path}`,
          detail: clip(redactSecrets(row.error || 'This proposal did not reach a known outcome.'), MAX_STEP_DETAIL_CHARS),
          status: 'failed',
        });
      }
    }

    const lines = [];
    lines.push(`Proposals applied: ${applied.length}${applied.length ? ` (${applied.join(', ')})` : ''}.`);
    lines.push(`Proposals rejected: ${rejected.length}${rejected.length ? ` (${rejected.join(', ')})` : ''}.`);
    lines.push(`Proposals failed: ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}.`);
    if (unknown.length) {
      lines.push(`Proposals with an unknown outcome: ${unknown.length}.`);
    }
    if (testResults.length) {
      const passed = testResults.filter((t) => Number(t.exitCode) === 0).length;
      lines.push(`Commands run: ${testResults.length}; exit status 0: ${passed}.`);
      for (const test of testResults) {
        lines.push(`- ${test.command}: exit ${test.exitCode === null ? 'unknown' : test.exitCode}${test.output ? ` — ${test.output}` : ''}`);
      }
    } else {
      lines.push('No commands were run.');
    }
    if (plan?.summary) lines.push(`Plan summary: ${redactSecrets(plan.summary)}`);

    const outcome = {
      applied, rejected, failed, unknown, testResults,
      summary: lines.join('\n'),
    };
    const incomplete = rejected.length > 0 || failed.length > 0 || unknown.length > 0;
    const failureMessage = incomplete
      ? clip(
        redactSecrets(`One or more proposed steps were rejected, failed, or had an unknown outcome.${failed.length ? ` ${failed.join('; ')}` : ''}`),
        MAX_STEP_DETAIL_CHARS,
      )
      : null;
    if (final) {
      addStep({
        kind: 'result',
        title: 'Result ready',
        detail: clip(
          `${incomplete ? 'Task incomplete. ' : ''}${outcome.summary}`,
          MAX_RESULT_CHARS,
        ),
      });
      return {
        status: incomplete ? 'failed' : 'completed',
        error: failureMessage,
        outcome,
      };
    }
    return {
      status: incomplete ? 'failed' : 'completed',
      error: failureMessage,
      outcome,
    };
  }

  return async function executeTask({ task, signal, addStep, phase = 'plan' }) {
    const project = db
      .prepare('SELECT id, name FROM projects WHERE id = ?')
      .get(task.project_id);
    if (!project) throw new Error('The task project no longer exists.');

    if (!provider || typeof provider.chat !== 'function') {
      const error = new Error('No AI provider is configured for background tasks.');
      error.statusCode = 503;
      error.publicMessage = 'No AI provider is configured. Select a tool-capable provider and restart the server.';
      throw error;
    }

    const providerLabel = provider.displayName || provider.name || 'AI provider';
    if (!supportsWorkspaceTools(provider)) {
      const message = `The configured AI provider (${providerLabel}) does not support workspace tools, so background tasks cannot inspect project files. Configure the OpenAI-compatible or Gemini provider.`;
      const error = new Error(message);
      error.statusCode = 503;
      error.publicMessage = message;
      throw error;
    }

    addStep({
      kind: 'note',
      title: 'Agent started',
      detail: `${providerLabel} (${provider.model || 'unknown model'}); read-only inspection. Autonomy "${task.autonomy}" is recorded, but edits and commands are disabled in this stage.`,
    });

    const readOnlyTools = createReadOnlyTools({
      tools,
      projectId: project.id,
      addStep,
      signal,
    });
    const messages = [
      {
        role: 'system',
        content: `${BACKGROUND_INSTRUCTION} Project: ${project.name}. Paths are workspace-relative.`,
      },
      { role: 'user', content: task.instruction },
    ];

    // Load any previously saved plan metadata (decision E: brief redacted
    // summary in the first step) and check whether the plan is complete.
    const savedPlan = loadPlan(db, task.id);
    if (savedPlan && typeof savedPlan === 'object') {
      const metaSummary = (savedPlan.summary || '').trim();
      addStep({
        kind: 'note',
        title: 'Loaded saved plan',
        detail: metaSummary ? clip(redactSecrets(metaSummary), MAX_STEP_DETAIL_CHARS) : 'Plan metadata restored; no proposal details saved yet.',
      });
    }

    async function stageOrderedStep(plan) {
      const index = Number(plan.currentStep);
      const step = plan.steps[index];
      if (!step || !['create_file', 'propose_file_change', 'run_command'].includes(step.tool)) {
        const message = `Ordered plan step ${index + 1} is missing or invalid; the task was not completed.`;
        addStep({ kind: 'note', title: 'Ordered plan failed', detail: message, status: 'failed' });
        throw new Error(message);
      }

      let proposal;
      try {
        if (step.tool === 'run_command') {
          proposal = tools.stageCommand
            ? await tools.stageCommand({
              projectId: project.id,
              command: step.command,
              path: step.path,
            })
            : await tools.execute('run_command', {
              projectId: project.id,
              command: step.command,
              path: step.path,
            });
        } else {
          const kind = step.tool === 'create_file' ? 'create' : 'update';
          proposal = tools.stageFileChange
            ? await tools.stageFileChange({
              projectId: project.id,
              kind,
              path: step.path,
              content: step.content,
            })
            : await tools.execute(step.tool, {
              projectId: project.id,
              path: step.path,
              content: step.content,
            });
        }
      } catch (error) {
        const detail = clip(redactSecrets(error?.message || String(error)), MAX_STEP_DETAIL_CHARS);
        addStep({
          kind: 'note',
          title: `Failed to stage ordered step ${index + 1}`,
          detail,
          status: 'failed',
        });
        throw new Error(`Ordered plan step ${index + 1} could not be staged: ${detail}`);
      }

      const proposalId = proposal?.id || proposal?.proposalId;
      if (typeof proposalId !== 'string' || !proposalId) {
        const message = `Ordered plan step ${index + 1} did not create a valid approval proposal.`;
        addStep({ kind: 'note', title: 'Ordered plan failed', detail: message, status: 'failed' });
        throw new Error(message);
      }
      plan.currentProposalId = proposalId;
      plan.proposals = Array.isArray(plan.proposals) ? plan.proposals : [];
      if (!plan.proposals.some((entry) => entry?.id === proposalId)) {
        plan.proposals.push({ id: proposalId });
      }
      savePlan(db, task.id, plan);
      addStep({
        kind: 'note',
        title: `Staged ordered step ${index + 1}`,
        detail: clip(`Awaiting approval: ${step.tool === 'run_command' ? step.command : step.path}${step.goal ? ` (${redactSecrets(step.goal)})` : ''}`, MAX_STEP_DETAIL_CHARS),
      });
      addStep({
        kind: 'note',
        title: 'Waiting for approval',
        detail: `Ordered step ${index + 1} of ${plan.steps.length} is staged for review.`,
      });
      return { status: 'waiting_approval' };
    }

    if (savedPlan?.mode === 'ordered') {
      if (!Array.isArray(savedPlan.steps) || savedPlan.steps.length === 0) {
        const message = 'The saved ordered plan has no executable steps; the task was not completed.';
        addStep({ kind: 'note', title: 'Ordered plan failed', detail: message, status: 'failed' });
        throw new Error(message);
      }
      const currentStep = Number(savedPlan.currentStep);
      if (!Number.isInteger(currentStep) || currentStep < 0 || currentStep > savedPlan.steps.length) {
        const message = 'The saved ordered plan has an invalid progress index; the task was not completed.';
        addStep({ kind: 'note', title: 'Ordered plan failed', detail: message, status: 'failed' });
        throw new Error(message);
      }

      if (savedPlan.currentProposalId) {
        const proposal = db.prepare('SELECT id, project_id, status FROM proposals WHERE id = ?')
          .get(savedPlan.currentProposalId);
        if (!proposal || Number(proposal.project_id) !== Number(project.id)) {
          const message = 'The current ordered-step proposal is missing or belongs to another project.';
          addStep({ kind: 'note', title: 'Ordered plan failed', detail: message, status: 'failed' });
          throw new Error(message);
        }
        if (!['applied', 'rejected', 'failed', 'interrupted'].includes(proposal.status)) {
          return { status: 'waiting_approval' };
        }
        if (proposal.status !== 'applied') {
          return finalizeTask(db, task, savedPlan, addStep);
        }

        savedPlan.currentStep += 1;
        savedPlan.currentProposalId = null;
        savePlan(db, task.id, savedPlan);
      }

      if (savedPlan.currentStep >= savedPlan.steps.length) {
        return finalizeTask(db, task, savedPlan, addStep);
      }
      return stageOrderedStep(savedPlan);
    }

    // If a saved plan has staged proposals that are not yet terminal,
    // we are still waiting for user approval (decision B: reuse available results).
    if (savedPlan && Array.isArray(savedPlan.proposals) && savedPlan.proposals.length > 0) {
      const proposalIds = savedPlan.proposals
        .map((entry) => (entry && typeof entry === 'object' ? entry.id : entry))
        .filter((id) => typeof id === 'string' && id.length > 0);
      if (proposalIds.length > 0) {
        try {
          const statusRows = db
            .prepare(`SELECT id, status FROM proposals WHERE id IN (${proposalIds.map(() => '?').join(',')})`)
            .all(...proposalIds);
          if (statusRows.length === proposalIds.length && statusRows.every((r) => ['applied','rejected','failed','interrupted'].includes(r.status))) {
            // All proposals reached a terminal outcome; proceed to finalize.
            return await finalizeTask(db, task, savedPlan, addStep);
          }
        } catch {
          // Ignore lookup errors; fall through to a normal plan/run.
        }
        const hasNonTerminal = proposalIds.some((id) => {
          const row = db.prepare('SELECT status FROM proposals WHERE id = ?').get(id);
          return !(row && ['applied','rejected','failed','interrupted'].includes(row.status));
        });
        if (hasNonTerminal) {
          addStep({
            kind: 'note',
            title: 'Plan already staged',
            detail: clip('Previously staged changes are still pending approval.', MAX_STEP_DETAIL_CHARS),
          });
          return { status: 'waiting_approval' };
        }
      }
    }

    // ----- Phase: plan / finalize / continue -----
    if (phase === 'finalize' || phase === 'continue') {
      const result = await finalizeTask(db, task, savedPlan, addStep);
      // S4-D continuation: if the saved plan has remaining steps or repair
      // attempts, persist progress and keep working instead of closing.
      if (phase === 'continue' || (savedPlan && typeof savedPlan === 'object')) {
        const steps = Array.isArray(savedPlan?.steps) ? savedPlan.steps : [];
        const currentStep = Number(savedPlan?.currentStep ?? 0);
        const repairAttempt = Number(savedPlan?.repairAttempt ?? 0);
        const hasRemaining = currentStep < steps.length - 1;
        const canRepair = repairAttempt < 3;
        if (hasRemaining || canRepair) {
          // Preserve progress; do not claim success if more work remains.
          const patch = {
            currentStep: hasRemaining ? currentStep + 1 : currentStep,
            repairAttempt: canRepair ? repairAttempt : repairAttempt,
          };
          const updated = refreshPlanProgress(db, task.id, patch);
          if (updated) {
            addStep({
              kind: 'note',
              title: 'Continuation',
              detail: `Plan step ${patch.currentStep + 1} of ${steps.length}; repair attempt ${patch.repairAttempt}.`,
            });
            return { status: 'waiting_approval' };
          }
        }
      }
      return result;
    }

    let lastError = null;

    // Helper for the provider call that respects retry budget and cancellation.
    async function safeChat(messages) {
      for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
        try {
          const result = await provider.chat({
            messages,
            // The provider always receives the read-only tool surface, so
            // `tools.execute` is never undefined for an adapter or a stub.
            tools: readOnlyTools,
            projectId: project.id,
            signal,
          });
          if (signal?.aborted || result?.text === undefined) throw cancelledError();
          return { result, attempt };
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw cancelledError();
          lastError = error;
          const msg = providerFailureMessage(error);
          if (!isRetryable(error) || attempt >= MAX_PROVIDER_ATTEMPTS) {
            addStep({
              kind: 'note',
              title: 'Agent failed',
              detail: clip(msg, MAX_STEP_DETAIL_CHARS),
              status: 'failed',
            });
            const failure = new Error(
              attempt > 1 ? `${msg} (after ${attempt} attempts)` : msg,
            );
            failure.statusCode = error?.statusCode;
            throw failure;
          }
          const baseDelay = delays[attempt - 1] ?? delays[delays.length - 1] ?? 0;
          const retryAfter = Number(error?.retryAfterMs);
          const waitMs = Math.min(
            MAX_RETRY_DELAY_MS,
            Math.max(baseDelay, Number.isFinite(retryAfter) ? retryAfter : 0),
          );
          addStep({
            kind: 'note',
            title: `Retrying provider (${attempt + 1}/${MAX_PROVIDER_ATTEMPTS})`,
            detail: `${clip(msg, MAX_STEP_DETAIL_CHARS)} Waiting ${waitMs} ms before retrying.`,
          });
          await delay(waitMs, undefined, { signal });
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Background task failed.');
    }

    // Call 1: inspect the workspace using the read-only tools.
    const inspectResult = await safeChat(messages);
    const inspectText = inspectResult.result?.text || '';
    if (inspectText.trim() && inspectResult.result?.toolActivity?.length > 0) {
      addStep({
        kind: 'note',
        title: 'Inspection complete',
        detail: clip(`Used ${inspectResult.result.toolActivity.length} read-only tool call(s) to inspect the project.`, MAX_STEP_DETAIL_CHARS),
      });
    }

    // The inspection reply decides whether a second call is needed at all
    // (decision B: reuse the available result and avoid extra calls).
    const inspection = parseJsonReply(inspectText);
    if (inspection.status === 'malformed') {
      addStep({
        kind: 'note',
        title: 'Plan parsing failed',
        detail: clip(redactSecrets(inspection.error || 'The provider returned JSON that could not be parsed.'), MAX_STEP_DETAIL_CHARS),
        status: 'failed',
      });
      const failure = new Error('The AI provider returned a reply that could not be parsed. The task was not completed successfully.');
      failure.statusCode = 400;
      throw failure;
    }

    const inspectionSummary = inspection.status === 'json'
      ? (typeof inspection.value?.summary === 'string' ? inspection.value.summary : '')
      : inspectText;
    const needsChanges = inspection.status === 'json'
      ? inspection.value?.needsChanges === true
      : false;

    // Nothing to change: finish with the inspection summary. A provider that
    // answered in plain prose keeps the previous read-only behaviour.
    if (!needsChanges) {
      addStep({
        kind: 'result',
        title: 'Result ready',
        detail: clip(redactSecrets(inspectionSummary), MAX_RESULT_CHARS),
      });
      return { status: 'completed' };
    }

    // Call 2: ask for the structured plan, informed by the inspection.
    const planMessages = [
      {
        role: 'system',
        content: `You are assisting a structured planning stage. The user instruction is: ${task.instruction}\nInspection summary: ${clip(inspectionSummary, 1200)}.\nRespond ONLY with a strict JSON object of this shape (no prose outside the JSON): {"summary":"redacted brief summary with no secrets","changes":[{"kind":"create"|"update","path":"relative/path.js","content":"full file content","goal":"brief reason"}],"commands":[{"command":"npm_test"|"npm_build"|"npm_lint"|"npm_format"|"node_check","path":"optional relative file","goal":"brief reason"}]}\nOnly include commands when the instruction asks to verify/test/build the project. Only include changes when the instruction asks for file edits. Never include secrets, API keys, environment values, or unnecessary file contents.`,
      },
      { role: 'user', content: 'Produce the structured plan JSON for this instruction.' },
    ];

    let planResult;
    try {
      planResult = await safeChat(planMessages);
    } catch (planError) {
      // If the plan generation fails, report honestly.
      addStep({
        kind: 'note',
        title: 'Agent failed (plan generation)',
        detail: clip(providerFailureMessage(planError), MAX_STEP_DETAIL_CHARS),
        status: 'failed',
      });
      throw planError;
    }

    const planText = (planResult.result?.text || '').trim();
    const parsedPlan = parseJsonReply(planText);

    // If the reply is plain prose (not JSON), treat it as the final result
    // (no proposed changes) — this keeps the existing read-only behaviour.
    if (parsedPlan.status === 'prose') {
      addStep({
        kind: 'note',
        title: 'Plan parsing failed',
        detail: clip(redactSecrets(planText), MAX_RESULT_CHARS),
        status: 'failed',
      });
      throw new Error('The AI provider did not return an actionable plan. The task was not completed.');
    }

    if (parsedPlan.status === 'malformed') {
      // Malformed JSON: record an honest failure and never claim success.
      addStep({
        kind: 'note',
        title: 'Plan parsing failed',
        detail: clip(redactSecrets(parsedPlan.error || 'The provider returned JSON that could not be parsed.'), MAX_STEP_DETAIL_CHARS),
        status: 'failed',
      });
      const failure = new Error('The AI provider returned a plan that could not be parsed. The task was not completed successfully.');
      failure.statusCode = 400;
      throw failure;
    }

    // Parsed JSON: sanitize, stage proposals, save metadata.
    const sanitized = sanitizePlan(parsedPlan.value);
    const orderedMode = Array.isArray(parsedPlan.value.steps);
    if (sanitized.problems.length > 0) {
      const message = `The AI provider returned an invalid plan: ${sanitized.problems.join(' ')}`;
      addStep({
        kind: 'note',
        title: 'Plan validation failed',
        detail: clip(redactSecrets(message), MAX_STEP_DETAIL_CHARS),
        status: 'failed',
      });
      throw new Error(message);
    }
    if (sanitized.steps.length === 0) {
      const message = 'The AI provider requested changes but returned no executable plan steps.';
      addStep({ kind: 'note', title: 'Plan validation failed', detail: message, status: 'failed' });
      throw new Error(message);
    }

    if (orderedMode) {
      const planMeta = buildPlanMetadata({
        summary: sanitized.summary,
        changes: sanitized.changes,
        commands: sanitized.commands,
        steps: sanitized.steps,
        mode: 'ordered',
      });
      savePlan(db, task.id, planMeta);
      return stageOrderedStep(planMeta);
    }

    const proposalIds = [];
    const stagingFailures = [];

    for (const change of sanitized.changes) {
      try {
        // The server-side staging path stages a proposal (does not write or run it).
        // It uses the existing proposal store and proposal state machine.
        const proposal = tools.stageFileChange ? await tools.stageFileChange({
          projectId: project.id,
          kind: change.kind,
          path: change.path,
          content: change.content,
        }) : await tools.execute(change.kind === 'update' ? 'propose_file_change' : 'create_file', {
          projectId: project.id,
          path: change.path,
          content: change.content,
        });
        proposalIds.push({ id: proposal.id, kind: change.kind, path: change.path });
        addStep({
          kind: 'note',
          title: `Staged ${change.kind === 'update' ? 'update' : 'create'}`,
          detail: clip(`Staged for approval: ${change.path}${change.goal ? ` (${redactSecrets(change.goal)})` : ''}`, MAX_STEP_DETAIL_CHARS),
        });
      } catch (stageErr) {
        stagingFailures.push(`File change ${change.path} could not be staged: ${redactSecrets(stageErr?.message || String(stageErr))}`);
        addStep({
          kind: 'note',
          title: `Failed to stage change (${change.kind})`,
          detail: clip(redactSecrets(stageErr?.message || String(stageErr)), MAX_STEP_DETAIL_CHARS),
          status: 'failed',
        });
        // Continue with remaining changes rather than aborting everything.
      }
    }

    for (const command of sanitized.commands) {
      try {
        const proposal = tools.stageCommand ? await tools.stageCommand({
          projectId: project.id,
          command: command.command,
          path: command.path,
        }) : await tools.execute('run_command', {
          projectId: project.id,
          command: command.command,
          path: command.path,
        });
        proposalIds.push({ id: proposal.id, kind: 'command', command: command.command, path: command.path });
        addStep({
          kind: 'note',
          title: `Staged command`,
          detail: clip(`Staged for approval: ${command.command}${command.path ? ` (${redactSecrets(command.path)})` : ''}${command.goal ? ` — ${redactSecrets(command.goal)}` : ''}`, MAX_STEP_DETAIL_CHARS),
        });
      } catch (stageErr) {
        stagingFailures.push(`Command ${command.command} could not be staged: ${redactSecrets(stageErr?.message || String(stageErr))}`);
        addStep({
          kind: 'note',
          title: `Failed to stage command (${command.command})`,
          detail: clip(redactSecrets(stageErr?.message || String(stageErr)), MAX_STEP_DETAIL_CHARS),
          status: 'failed',
        });
      }
    }

    // Save only metadata (paths, kinds, proposal ids) — never file contents.
    const planMeta = buildPlanMetadata({
      summary: sanitized.summary,
      changes: sanitized.changes,
      commands: sanitized.commands,
      steps: sanitized.steps,
      proposalIds,
    });
    if (stagingFailures.length > 0) {
      planMeta.stagingFailures = stagingFailures;
    }
    savePlan(db, task.id, planMeta);

    // If proposals were staged, the task must wait for approval.
    // The runner will observe the waiting_approval status and resume only
    // once the linked proposals reach a terminal outcome.
    if (proposalIds.length > 0) {
      addStep({
        kind: 'note',
        title: 'Waiting for approval',
        detail: `Staged ${proposalIds.length} proposal(s) for user review. The runner will resume this task when all proposals reach a terminal state.`,
      });
      return { status: 'waiting_approval' };
    }

    if (stagingFailures.length > 0) {
      return finalizeTask(db, task, planMeta, addStep);
    }

    // No proposals staged: finish with the final report.
    addStep({
      kind: 'result',
      title: 'Result ready',
      detail: clip(`Plan completed. Summary: ${redactSecrets(sanitized.summary || 'No file changes or commands were requested.')} Issues: ${sanitized.problems?.length ? sanitized.problems.join('; ') : 'none'}`, MAX_RESULT_CHARS),
    });
    return { status: 'completed' };
  };
}

// Structured-plan helpers for the background task orchestrator.
//
// The model is asked for a small JSON document. Parsing is deliberately
// defensive: a reply that contains no JSON at all is an ordinary answer, a
// reply that contains broken JSON is a malformed plan, and the two are never
// confused. Nothing here touches the filesystem, the network, or the
// database - it only shapes and validates plain data.
import { redactSecrets } from '../config.js';

export const PLAN_VERSION = 1;
export const MAX_PLAN_CHANGES = 20;
export const MAX_PLAN_COMMANDS = 5;
export const MAX_PLAN_STEPS = 20;
export const MAX_REPAIR_ATTEMPTS = 3;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_GOAL_CHARS = 300;

/** Extracts every JSON-looking block from a reply, fenced or bare. */
function jsonCandidates(text) {
  const candidates = [];
  const fencePattern = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let match = fencePattern.exec(text);
  while (match) {
    const body = match[1]?.trim();
    if (body) candidates.push(body);
    match = fencePattern.exec(text);
  }
  // A bare object is only treated as JSON when the reply starts with one, so
  // ordinary prose that happens to contain braces is not mistaken for a
  // malformed plan.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  }
  return candidates;
}

/**
 * Parses a model reply.
 * @returns {{status:'json'|'prose'|'malformed', value?:object, error?:string}}
 *   'json'     - a JSON object was found and parsed
 *   'prose'    - the reply contains no JSON at all (an ordinary answer)
 *   'malformed'- the reply contains JSON that does not parse
 */
export function parseJsonReply(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { status: 'prose' };
  }
  const candidates = jsonCandidates(text);
  if (candidates.length === 0) return { status: 'prose' };
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { status: 'json', value };
      }
    } catch {
      // Try the next candidate; a broken one is only reported when nothing else parses.
    }
  }
  return { status: 'malformed', error: 'The model reply contained JSON that could not be parsed.' };
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const clipped = trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  return redactSecrets(clipped);
}

/**
 * Validates the model's plan document.
 * Unknown or malformed entries are dropped (and reported) rather than being
 * passed on to the proposal store.
 *
 * Two shapes are supported:
 *  - `changes` / `commands`: one batch of concrete actions (S4-C behaviour).
 *  - `steps`: an ordered list of intents. A file step carries `content`, a
 *    command step carries `command`. The executor works through them one at a
 *    time, so a task can continue across several approval rounds.
 */
export function sanitizePlan(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const changes = [];
  const commands = [];
  const problems = [];

  const rawChanges = Array.isArray(source.changes) ? source.changes : [];
  if (rawChanges.length > MAX_PLAN_CHANGES) {
    problems.push(`Only the first ${MAX_PLAN_CHANGES} of ${rawChanges.length} file changes were kept.`);
  }
  for (const entry of rawChanges.slice(0, MAX_PLAN_CHANGES)) {
    if (!entry || typeof entry !== 'object') {
      problems.push('A file change entry was not an object and was skipped.');
      continue;
    }
    const kind = entry.kind === 'update' ? 'update' : entry.kind === 'create' ? 'create' : null;
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    const content = typeof entry.content === 'string' ? entry.content : null;
    if (!kind) {
      problems.push(`A file change for "${path || 'unknown path'}" had no usable kind and was skipped.`);
      continue;
    }
    if (!path) {
      problems.push('A file change without a path was skipped.');
      continue;
    }
    if (content === null) {
      problems.push(`The file change for "${path}" had no content and was skipped.`);
      continue;
    }
    changes.push({ kind, path, content, goal: cleanText(entry.goal, MAX_GOAL_CHARS) });
  }

  const rawCommands = Array.isArray(source.commands) ? source.commands : [];
  if (rawCommands.length > MAX_PLAN_COMMANDS) {
    problems.push(`Only the first ${MAX_PLAN_COMMANDS} of ${rawCommands.length} commands were kept.`);
  }
  for (const entry of rawCommands.slice(0, MAX_PLAN_COMMANDS)) {
    if (!entry || typeof entry !== 'object') {
      problems.push('A command entry was not an object and was skipped.');
      continue;
    }
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (!command) {
      problems.push('A command without a name was skipped.');
      continue;
    }
    commands.push({
      command,
      path: typeof entry.path === 'string' && entry.path.trim() ? entry.path.trim() : null,
      goal: cleanText(entry.goal, MAX_GOAL_CHARS),
    });
  }

  // Ordered steps. When present they define the multi-step workflow the
  // executor walks through, one approval round per step.
  const steps = [];
  const rawSteps = Array.isArray(source.steps) ? source.steps : [];
  if (rawSteps.length > MAX_PLAN_STEPS) {
    problems.push(`Only the first ${MAX_PLAN_STEPS} of ${rawSteps.length} steps were kept.`);
  }
  for (const entry of rawSteps.slice(0, MAX_PLAN_STEPS)) {
    if (!entry || typeof entry !== 'object') {
      problems.push('A step entry was not an object and was skipped.');
      continue;
    }
    const tool = entry.tool === 'propose_file_change' || entry.tool === 'create_file'
      ? 'file'
      : entry.tool === 'run_command' ? 'command' : null;
    if (!tool) {
      problems.push('A step with an unknown tool was skipped.');
      continue;
    }
    const goal = cleanText(entry.goal, MAX_GOAL_CHARS);
    if (tool === 'file') {
      const path = typeof entry.path === 'string' ? entry.path.trim() : '';
      const content = typeof entry.content === 'string' ? entry.content : null;
      if (!path) {
        problems.push('A file step without a path was skipped.');
        continue;
      }
      if (content === null) {
        problems.push(`The file step for "${path}" had no content and was skipped.`);
        continue;
      }
      steps.push({
        tool,
        kind: entry.tool === 'create_file' ? 'create' : 'update',
        path,
        content,
        goal,
      });
      continue;
    }
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (!command) {
      problems.push('A command step without a command name was skipped.');
      continue;
    }
    steps.push({
      tool,
      command,
      path: typeof entry.path === 'string' && entry.path.trim() ? entry.path.trim() : null,
      goal,
    });
  }

  // Unified ordered step list. Explicit `steps` win; otherwise the legacy
  // `changes` + `commands` pair is expanded into the same shape so the
  // executor always walks one ordered list.
  const unified = [];
  if (steps.length > 0) {
    unified.push(...steps);
  } else {
    for (const change of changes) {
      unified.push({
        tool: 'file',
        kind: change.kind,
        path: change.path,
        content: change.content,
        goal: change.goal,
      });
    }
    for (const command of commands) {
      unified.push({
        tool: 'command',
        command: command.command,
        path: command.path,
        goal: command.goal,
      });
    }
  }

  return {
    summary: cleanText(source.summary, MAX_SUMMARY_CHARS),
    changes,
    commands,
    steps: unified,
    problems,
  };
}

/**
 * Builds the plan payload persisted in `tasks.plan_json`.
 * Batch plans keep metadata and proposal ids. Ordered plans also retain their
 * validated, redacted pending step content so the runner can continue after
 * each approval without asking the model to regenerate completed work.
 */
export function buildPlanMetadata({
  summary,
  changes = [],
  commands = [],
  proposalIds = [],
  steps = [],
  currentStep = 0,
  currentProposalId = null,
  repairAttempt = 0,
  mode = 'batch',
  history = [],
}) {
  const orderedSteps = Array.isArray(steps) && steps.length > 0
    ? steps.map((step) => {
      if (step?.tool === 'command') {
        return {
          tool: 'run_command',
          command: step.command,
          path: step.path ?? null,
          goal: step.goal ?? '',
        };
      }
      const metadata = {
        tool: step?.kind === 'create' ? 'create_file' : 'propose_file_change',
        path: step?.path ?? null,
        goal: step?.goal ?? '',
      };
      if (mode === 'ordered' && typeof step?.content === 'string') {
        metadata.content = redactSecrets(step.content);
      }
      return metadata;
    })
    : [
      ...changes.map((change) => ({
        tool: change.kind === 'update' ? 'propose_file_change' : 'create_file',
        path: change.path,
        goal: change.goal,
      })),
      ...commands.map((command) => ({
        tool: 'run_command',
        command: command.command,
        path: command.path,
        goal: command.goal,
      })),
    ];

  return {
    version: PLAN_VERSION,
    summary: cleanText(summary, MAX_SUMMARY_CHARS),
    currentStep: Number(currentStep) || 0,
    currentProposalId: typeof currentProposalId === 'string' ? currentProposalId : null,
    repairAttempt: Math.min(Number(repairAttempt) || 0, MAX_REPAIR_ATTEMPTS),
    steps: orderedSteps,
    mode: mode === 'ordered' ? 'ordered' : mode === 'round' ? 'round' : 'batch',
    history: (Array.isArray(history) ? history : []).slice(0, 20).map((entry) => ({
      applied: (entry?.applied || []).map(String).filter(Boolean),
      rejected: (entry?.rejected || []).map(String).filter(Boolean),
      failed: (entry?.failed || []).map(String).filter(Boolean),
      unknown: (entry?.unknown || []).map(String).filter(Boolean),
      commands: (entry?.commands || []).map((c) => ({
        command: String(c?.command || '').trim(),
        exitCode: Number.isFinite(Number(c?.exitCode)) ? Number(c.exitCode) : null,
      })).filter((c) => !!c.command),
    })),
    proposals: proposalIds.map((entry) => {
      const id = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? entry.id : null);
      return { id };
    }).filter((entry) => typeof entry.id === 'string' && entry.id.length > 0),
  };
}

/** A short, redacted one-line summary of a stored plan, for task steps. */
export function describePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const summary = typeof plan.summary === 'string' ? plan.summary : '';
  const files = steps.filter((step) => step?.tool === 'create_file' || step?.tool === 'propose_file_change').length;
  const commands = steps.filter((step) => step?.tool === 'run_command').length;
  const parts = [];
  if (summary) parts.push(summary);
  parts.push(`${files} file change${files === 1 ? '' : 's'}`);
  parts.push(`${commands} command${commands === 1 ? '' : 's'}`);
  return cleanText(parts.join(' · '), 500);
}

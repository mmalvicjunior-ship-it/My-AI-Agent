import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  createTextFile,
  ensureDir,
  getProjectRoot,
  readTextFile,
  replaceTextFile,
  scanDirectory,
  searchWorkspace,
  WorkspaceError,
  validateWritePath,
} from '../workspace/files.js';
import { unifiedDiff } from '../workspace/diff.js';
import {
  claimProposal,
  completeProposal,
  failProposal,
  getPendingProposal,
  listPendingProposals,
  rejectProposal as rejectStoredProposal,
  releaseClaim,
  stageProposal,
  findPendingProposal,
} from '../proposals/store.js';
import { recoverInterruptedProposals } from '../proposals/recovery.js';

export const PROPOSAL_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export function isProposalExpired(proposal) {
  if (!proposal || !proposal.created_at) return false;
  const createdTime = new Date(proposal.created_at).getTime();
  if (Number.isNaN(createdTime)) return false;
  return (Date.now() - createdTime) > PROPOSAL_EXPIRATION_MS;
}

const MAX_COMMAND_OUTPUT = 16_000;
const commandNames = new Set(['npm_test', 'npm_build', 'npm_lint', 'npm_format', 'node_check']);

export const geminiToolDeclarations = [{
  functionDeclarations: [
    {
      name: 'create_file',
      description: 'Stage a new UTF-8 text file inside the selected project for user review. Existing files are never overwritten.',
      parameters: {
        type: 'OBJECT',
        properties: {
          projectId: { type: 'INTEGER', description: 'Active project workspace id.' },
          path: { type: 'STRING', description: 'Relative file path inside the selected workspace.' },
          content: { type: 'STRING', description: 'Complete contents for the new file.' },
        },
        required: ['projectId', 'path', 'content'],
      },
    },
    {
      name: 'propose_file_change',
      description: 'Stage a complete replacement for an existing source file. The user must review the diff and approve it before it is written.',
      parameters: {
        type: 'OBJECT',
        properties: {
          projectId: { type: 'INTEGER' },
          path: { type: 'STRING', description: 'Relative path to the existing file.' },
          content: { type: 'STRING', description: 'Complete proposed updated file content.' },
        },
        required: ['projectId', 'path', 'content'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 source or text file from the selected project workspace.',
      parameters: {
        type: 'OBJECT',
        properties: {
          projectId: { type: 'INTEGER' },
          path: { type: 'STRING', description: 'Relative file path.' },
        },
        required: ['projectId', 'path'],
      },
    },
    {
      name: 'list_files',
      description: 'List the relative file paths under one directory of the selected workspace, excluding dependencies, build output, and credentials. Call it once per request for the requested directory (the project root when unspecified) and report the returned paths. It returns paths only and never reads file contents.',
      parameters: {
        type: 'OBJECT',
        properties: {
          projectId: { type: 'INTEGER' },
          path: { type: 'STRING', description: 'Optional relative directory, defaults to project root.' },
        },
        required: ['projectId'],
      },
    },
    {
      name: 'search_files',
      description: 'Search source code in the selected project for a string, function name, or symbol.',
      parameters: {
        type: 'OBJECT',
        properties: {
          projectId: { type: 'INTEGER' },
          query: { type: 'STRING' },
        },
        required: ['projectId', 'query'],
      },
    },
    {
      name: 'run_command',
      description: 'Stage one safe predefined project check for user approval. This does not run arbitrary shell commands, and nothing is run until the user approves it.',
      parameters: {
        type: 'OBJECT',
        properties: {
          projectId: { type: 'INTEGER' },
          command: {
            type: 'STRING',
            enum: ['npm_test', 'npm_build', 'npm_lint', 'npm_format', 'node_check'],
          },
          path: { type: 'STRING', description: 'Required for node_check: source file path relative to project root.' },
        },
        required: ['projectId', 'command'],
      },
    },
  ],
}];

function projectRootFor(db, projectId, workspaceRoot) {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new WorkspaceError(400, 'Select a valid project workspace before asking the agent to use files.');
  }
  const root = getProjectRoot(db, workspaceRoot, projectId);
  ensureDir(root);
  return root;
}

function truncateOutput(value) {
  const text = String(value || '');
  return text.length > MAX_COMMAND_OUTPUT
    ? `${text.slice(0, MAX_COMMAND_OUTPUT)}\n[output truncated]`
    : text;
}

function runSafeCommand(root, command, relativePath) {
  if (!commandNames.has(command)) throw new WorkspaceError(400, 'Command is not in the safe command allowlist.');
  let executable;
  let args;
  if (command === 'node_check') {
    if (typeof relativePath !== 'string' || !/\.(?:js|mjs|cjs)$/i.test(relativePath)) {
      throw new WorkspaceError(400, 'node_check requires a relative .js, .mjs, or .cjs file path.');
    }
    const file = readTextFile(root, relativePath);
    args = ['--check', path.resolve(root, file.path)];
    executable = process.execPath;
  } else {
    const scriptKey = {
      npm_test: 'test',
      npm_build: 'build',
      npm_lint: 'lint',
      npm_format: 'format',
    }[command];
    const packageJsonPath = path.join(root, 'package.json');
    let packageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new WorkspaceError(400, 'This workspace has no package.json.');
      if (error instanceof SyntaxError) throw new WorkspaceError(400, 'The workspace package.json is invalid JSON.');
      throw error;
    }
    if (!packageJson.scripts?.[scriptKey]) {
      throw new WorkspaceError(400, `This workspace does not define an npm ${scriptKey} script.`);
    }
    args = ['run', scriptKey];
    executable = 'npm';
  }

  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_COMMAND_OUTPUT * 2,
    shell: process.platform === 'win32' && executable === 'npm',
    windowsHide: true,
  });
  if (result.error) {
    const error = new Error(result.error.code === 'ETIMEDOUT'
      ? 'Safe project command timed out after 30 seconds.'
      : `Could not run the safe project command: ${result.error.message}`);
    error.statusCode = 502;
    throw error;
  }
  return {
    command,
    exitCode: result.status,
    stdout: truncateOutput(result.stdout),
    stderr: truncateOutput(result.stderr),
  };
}

export function createWorkspaceTools({ db }) {
  // Finish or fail proposals left mid-application by a previous process before
  // any request can see them. This is read-only for the workspace.
  recoverInterruptedProposals({ db, workspaceRoot: config.workspaceRoot });

  /**
   * Stages a file change for review. Nothing is written: the proposal waits
   * for the user to approve it and is applied later by `applyProposal`.
   *
   * This is the single staging path used by both the interactive
   * `create_file`/`propose_file_change` tools and the background task
   * executor, so path validation, size limits, diffs, and the proposal
   * state machine behave identically in both places.
   */
  function stageFileChange({ projectId, kind = 'create', path, content }) {
    const root = projectRootFor(db, projectId, config.workspaceRoot);
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw new WorkspaceError(400, 'A file change requires a relative path and text content.');
    }
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
      throw new WorkspaceError(413, 'Proposed file content exceeds the 1 MiB limit.');
    }
    // Fail fast with the same pure guard the apply step uses, so a path that
    // can never be written (traversal, absolute, credentials) is never shown
    // to the user as "awaiting approval".
    validateWritePath(path, 'The assistant cannot create credential or environment files.', { allowDeployment: true });

    if (kind === 'update') {
      const original = readTextFile(root, path);
      const diff = unifiedDiff(original.content, content, { oldPath: original.path, newPath: original.path });
      const existing = findPendingProposal(db, projectId, 'update', original.path, content, null);
      if (existing) return existing;
      return stageProposal(db, {
        projectId,
        kind: 'update',
        path: original.path,
        content,
        originalContent: original.content,
        diff,
      });
    }

    const diff = unifiedDiff('', content, { oldPath: path, newPath: path });
    const existing = findPendingProposal(db, projectId, 'create', path, content, null);
    if (existing) return existing;
    return stageProposal(db, {
      projectId,
      kind: 'create',
      path,
      content,
      diff,
    });
  }

  /**
   * Stages one allowlisted command for review. Nothing is run: the proposal
   * waits for the user to approve it and is executed later by
   * `runApprovedCommand`.
   */
  function stageCommand({ projectId, command, path = null }) {
    projectRootFor(db, projectId, config.workspaceRoot);
    if (!commandNames.has(command)) throw new WorkspaceError(400, 'Command is not in the safe command allowlist.');
    const existing = findPendingProposal(db, projectId, 'command', null, null, command);
    if (existing) return existing;
    return stageProposal(db, {
      projectId,
      kind: 'command',
      command,
      commandPath: typeof path === 'string' ? path : null,
    });
  }

  return {
    declarations: geminiToolDeclarations,
    stageFileChange,
    stageCommand,
    async execute(name, args = {}) {
      const root = projectRootFor(db, args.projectId, config.workspaceRoot);
      switch (name) {
        case 'create_file': {
          const proposal = stageFileChange({ projectId: args.projectId, kind: 'create', path: args.path, content: args.content });
          return {
            proposalId: proposal.id,
            path: args.path,
            status: 'awaiting_user_approval',
            diff: proposal.diff,
            note: 'NOTHING HAS BEEN WRITTEN. This new file is staged only and is waiting for the user to approve it. Tell the user it is staged and awaiting approval; never say it was created, written, or applied.',
          };
        }
        case 'propose_file_change': {
          const proposal = stageFileChange({ projectId: args.projectId, kind: 'update', path: args.path, content: args.content });
          return {
            proposalId: proposal.id,
            path: proposal.path,
            status: 'awaiting_user_approval',
            diff: proposal.diff,
            note: 'NOTHING HAS BEEN CHANGED. This edit is staged only and is waiting for the user to approve it. Tell the user it is staged and awaiting approval; never say it was updated, applied, or written.',
            originalContent: proposal.original_content,
          };
        }
        case 'read_file':
          return readTextFile(root, args.path);
        case 'list_files':
          return scanDirectory(root, args.path || '.');
        case 'search_files':
          return searchWorkspace(root, args.query);
        case 'run_command': {
          const proposal = stageCommand({ projectId: args.projectId, command: args.command, path: args.path });
          return {
            proposalId: proposal.id,
            command: args.command,
            status: 'awaiting_user_approval',
            note: 'NOTHING HAS BEEN RUN. This command is staged only and is waiting for the user to approve it. Tell the user it is awaiting approval; never say it was run or executed.',
          };
        }
        default:
          throw new WorkspaceError(400, `Unknown workspace tool: ${name}`);
      }
    },
    applyProposal(projectId, proposalId) {
      const project = Number(projectId);
      const proposal = getPendingProposal(db, project, proposalId);
      if (!proposal || proposal.kind === 'command' || !proposal.path) {
        throw new WorkspaceError(404, 'Pending file proposal not found.');
      }
      if (isProposalExpired(proposal)) {
        throw new WorkspaceError(410, 'Proposal approval has expired. Staged changes must be approved within 24 hours.');
      }
      // Persisted claim: a second click, a concurrent request, or a restart
      // can never write the same proposal twice.
      if (!claimProposal(db, project, proposalId)) {
        throw new WorkspaceError(404, 'Pending file proposal not found.');
      }

      const isUpdate = proposal.kind === 'update';
      let applied;
      try {
        const root = projectRootFor(db, proposal.project_id, config.workspaceRoot);
        applied = isUpdate
          ? replaceTextFile(root, proposal.path, proposal.original_content, proposal.content, { allowDeployment: true })
          : createTextFile(root, proposal.path, proposal.content, { allowDeployment: true });
      } catch (error) {
        // The guards refused before writing (stale content, existing file,
        // unsafe path), so the proposal is safe to keep for retry or discard.
        releaseClaim(db, proposalId);
        throw error;
      }

      const diff = isUpdate
        ? unifiedDiff(proposal.original_content, proposal.content, { oldPath: applied.path, newPath: applied.path })
        : unifiedDiff('', proposal.content, { oldPath: applied.path, newPath: applied.path });
      // If this transaction fails the row stays 'applying' and startup
      // recovery reconciles it against the file instead of repeating the write.
      completeProposal(db, proposal, {
        path: applied.path,
        action: isUpdate ? 'update' : 'create',
        diff,
      });
      return { ...applied, diff };
    },
    /**
     * Discards a pending proposal (file or command) without touching the disk.
     * The row becomes `rejected`, so a later apply/run fails with 404 exactly
     * as the previous map deletion did.
     */
    rejectProposal(projectId, proposalId) {
      if (!rejectStoredProposal(db, Number(projectId), proposalId)) {
        throw new WorkspaceError(404, 'Pending proposal not found.');
      }
      return { proposalId, status: 'rejected' };
    },
    /** Pending proposals (file and command) for one project, with review diffs. */
    listProposals(projectId) {
      const proposals = listPendingProposals(db, Number(projectId)).map((proposal) => {
        if (proposal.kind === 'command') {
          return {
            proposalId: proposal.id,
            type: 'command',
            command: proposal.command,
            path: proposal.command_path ?? null,
            status: 'awaiting_user_approval',
          };
        }
        const isUpdate = proposal.kind === 'update';
        return {
          proposalId: proposal.id,
          type: 'file',
          action: proposal.kind,
          path: proposal.path,
          status: 'awaiting_user_approval',
          diff: proposal.diff ?? (isUpdate
            ? unifiedDiff(proposal.original_content, proposal.content, { oldPath: proposal.path, newPath: proposal.path })
            : unifiedDiff('', proposal.content, { oldPath: proposal.path, newPath: proposal.path })),
        };
      });
      return { proposals };
    },
    runApprovedCommand(projectId, proposalId) {
      const project = Number(projectId);
      const proposal = getPendingProposal(db, project, proposalId);
      if (!proposal || proposal.kind !== 'command' || !proposal.command) {
        throw new WorkspaceError(404, 'Pending command approval not found.');
      }
      if (isProposalExpired(proposal)) {
        throw new WorkspaceError(410, 'Command proposal approval has expired. Staged commands must be approved within 24 hours.');
      }
      if (!claimProposal(db, project, proposalId)) {
        throw new WorkspaceError(404, 'Pending command approval not found.');
      }

      let result;
      try {
        const root = projectRootFor(db, proposal.project_id, config.workspaceRoot);
        result = runSafeCommand(root, proposal.command, proposal.command_path);
      } catch (error) {
        if (error instanceof WorkspaceError) {
          // Pre-flight refusal (missing package.json, bad node_check path,
          // missing workspace): the command never started, so retry is safe.
          releaseClaim(db, proposalId);
        } else {
          // Timeout or spawn failure: it may have partially run. Never retry.
          failProposal(db, proposalId, error?.message || String(error));
        }
        throw error;
      }

      completeProposal(db, proposal, { result: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, command: result.command } });
      return result;
    },
  };
}
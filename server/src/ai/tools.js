import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
} from '../workspace/files.js';
import { unifiedDiff } from '../workspace/diff.js';

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
      description: 'List files recursively in the selected workspace, excluding dependencies, build output, and credentials.',
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
      description: 'Run one safe predefined project check. This does not run arbitrary shell commands.',
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

/** Persists one entry in the file_changes history table. */
function recordChange(db, projectId, relativePath, action, source, diffText) {
  db.prepare('INSERT INTO file_changes (project_id, path, action, source, diff) VALUES (?, ?, ?, ?, ?)')
    .run(Number(projectId), relativePath, action, source, diffText || null);
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
  const pendingProposals = new Map();
  return {
    declarations: geminiToolDeclarations,
    async execute(name, args = {}) {
      const root = projectRootFor(db, args.projectId, config.workspaceRoot);
      switch (name) {
        case 'create_file': {
          if (typeof args.path !== 'string' || typeof args.content !== 'string') {
            throw new WorkspaceError(400, 'create_file requires a relative path and text content.');
          }
          if (Buffer.byteLength(args.content, 'utf8') > 1024 * 1024) {
            throw new WorkspaceError(413, 'Proposed file content exceeds the 1 MiB limit.');
          }
          const proposalId = randomUUID();
          const diff = unifiedDiff('', args.content, { oldPath: args.path, newPath: args.path });
          const proposal = {
            projectId: args.projectId,
            path: args.path,
            content: args.content,
            diff,
          };
          pendingProposals.set(proposalId, proposal);
          return {
            proposalId,
            path: args.path,
            status: 'awaiting_user_approval',
            diff,
            note: 'File is staged only. Ask the user to review the diff and apply it.',
          };
        }
        case 'propose_file_change': {
          if (typeof args.path !== 'string' || typeof args.content !== 'string') {
            throw new WorkspaceError(400, 'propose_file_change requires a relative path and text content.');
          }
          if (Buffer.byteLength(args.content, 'utf8') > 1024 * 1024) {
            throw new WorkspaceError(413, 'Proposed file content exceeds the 1 MiB limit.');
          }
          const original = readTextFile(root, args.path);
          const proposalId = randomUUID();
          const diff = unifiedDiff(original.content, args.content, { oldPath: original.path, newPath: original.path });
          pendingProposals.set(proposalId, {
            projectId: args.projectId,
            path: original.path,
            content: args.content,
            originalContent: original.content,
            diff,
          });
          return {
            proposalId,
            path: original.path,
            status: 'awaiting_user_approval',
            diff,
            note: 'The update is staged only. Ask the user to review the diff and apply it.',
            originalContent: original.content,
          };
        }
        case 'read_file':
          return readTextFile(root, args.path);
        case 'list_files':
          return scanDirectory(root, args.path || '.');
        case 'search_files':
          return searchWorkspace(root, args.query);
        case 'run_command': {
          if (!commandNames.has(args.command)) throw new WorkspaceError(400, 'Command is not in the safe command allowlist.');
          const proposalId = randomUUID();
          pendingProposals.set(proposalId, {
            projectId: args.projectId,
            command: args.command,
            path: args.path,
          });
          return {
            proposalId,
            command: args.command,
            status: 'awaiting_user_approval',
            note: 'The command has not been run. Ask the user to approve it.',
          };
        }
        default:
          throw new WorkspaceError(400, `Unknown workspace tool: ${name}`);
      }
    },
    applyProposal(projectId, proposalId) {
      const proposal = pendingProposals.get(proposalId);
      if (!proposal || proposal.projectId !== Number(projectId) || !proposal.path || !('content' in proposal)) {
        throw new WorkspaceError(404, 'Pending file proposal not found.');
      }
      const root = projectRootFor(db, proposal.projectId, config.workspaceRoot);
      const isUpdate = 'originalContent' in proposal;
      const applied = isUpdate
        ? replaceTextFile(root, proposal.path, proposal.originalContent, proposal.content)
        : createTextFile(root, proposal.path, proposal.content);
      pendingProposals.delete(proposalId);
      const diff = isUpdate
        ? unifiedDiff(proposal.originalContent, proposal.content, { oldPath: applied.path, newPath: applied.path })
        : unifiedDiff('', proposal.content, { oldPath: applied.path, newPath: applied.path });
      recordChange(db, proposal.projectId, applied.path, isUpdate ? 'update' : 'create', 'agent', diff);
      return { ...applied, diff };
    },
    /** Pending proposals (file and command) for one project, with review diffs. */
    listProposals(projectId) {
      const id = Number(projectId);
      const proposals = [];
      for (const [proposalId, proposal] of pendingProposals) {
        if (proposal.projectId !== id) continue;
        if (proposal.command) {
          proposals.push({
            proposalId,
            type: 'command',
            command: proposal.command,
            path: proposal.path ?? null,
            status: 'awaiting_user_approval',
          });
          continue;
        }
        const isUpdate = 'originalContent' in proposal;
        proposals.push({
          proposalId,
          type: 'file',
          action: isUpdate ? 'update' : 'create',
          path: proposal.path,
          status: 'awaiting_user_approval',
          diff: proposal.diff ?? (isUpdate
            ? unifiedDiff(proposal.originalContent, proposal.content, { oldPath: proposal.path, newPath: proposal.path })
            : unifiedDiff('', proposal.content, { oldPath: proposal.path, newPath: proposal.path })),
        });
      }
      return { proposals };
    },
    runApprovedCommand(projectId, proposalId) {
      const proposal = pendingProposals.get(proposalId);
      if (!proposal || proposal.projectId !== Number(projectId) || !proposal.command) {
        throw new WorkspaceError(404, 'Pending command approval not found.');
      }
      const root = projectRootFor(db, proposal.projectId, config.workspaceRoot);
      const result = runSafeCommand(root, proposal.command, proposal.path);
      pendingProposals.delete(proposalId);
      return result;
    },
  };
}

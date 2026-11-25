// Backend-owned Python subprocess runner.
//
// This is NOT the supplied DeepSeek execution engine (that source was not
// available in the repository or workspace). It is a deliberately small,
// inspectable runner for the existing, already-approved `python_check` and
// `python_run` command proposals. It makes no sandbox claim: generated Python
// still runs with the OS privileges of the backend account.
//
// The trusted Node layer pins the approved relative path and SHA-256 digest in
// the existing proposal row, then revalidates both immediately before spawn.
// Only a sanitized environment is passed to the child so provider keys, session
// secrets, and storage credentials are not handed to generated code.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config } from '../config.js';
import { MAX_READ_BYTES, isSensitiveFile, resolveInside, WorkspaceError } from '../workspace/files.js';

const PYTHON_AST_CHECK = 'import ast, sys; ast.parse(open(sys.argv[1], "r", encoding="utf-8").read(), filename=sys.argv[1])';

// Benign operating-system variables needed by the interpreter on Windows and
// POSIX. Deliberately omitted: API keys, database URLs, session/bootstrap
// tokens, cloud credentials, HOME/USERPROFILE, and PYTHONPATH/PYTHONHOME.
const PASSTHROUGH_ENV_NAMES = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'OS',
];

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function normalizedRelative(value) {
  return toPosix(path.normalize(String(value || ''))).replace(/^\.\//, '');
}

function pythonEnvironment() {
  const env = {
    // Force UTF-8 decoding/encoding regardless of the host locale.
    PYTHONIOENCODING: 'utf-8',
    // Ignore user site-packages and do not leave __pycache__ files behind.
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const name of PASSTHROUGH_ENV_NAMES) {
    const value = process.env[name];
    if (typeof value === 'string' && value) env[name] = value;
  }
  return env;
}

function isWindowsAppsAlias(filePath) {
  return /[\\/]Microsoft\.WindowsApps[\\/]/i.test(filePath);
}

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

// spawnSync starts the resolved path directly (no shell), so only a real
// executable can be launched. Script launchers such as .cmd/.bat are unusable
// here even when PATH lists them before python.exe.
function isExecutableFile(filePath) {
  return /\.exe$/i.test(filePath) && isNonEmptyFile(filePath);
}

function hasInstallManagerTarget(candidate) {
  try {
    return fs.statSync(`${candidate}.__target__`).isFile();
  } catch {
    return false;
  }
}

function resolveInstallManagerTarget(candidate) {
  const targetFile = `${candidate}.__target__`;
  try {
    const target = fs.readFileSync(targetFile, 'utf8').trim();
    return target && path.isAbsolute(target) && isExecutableFile(target) ? target : null;
  } catch {
    return null;
  }
}

function resolveWindowsCandidate(candidate) {
  const resolved = path.resolve(candidate);
  // Python's Windows install-manager launchers carry a sibling __target__ file.
  // Resolve that real interpreter instead of spawning the launcher, which can
  // otherwise start an install flow when USERPROFILE/HOME are not inherited.
  // A launcher with an unusable target is rejected, not treated as a real
  // interpreter.
  if (hasInstallManagerTarget(resolved)) return resolveInstallManagerTarget(resolved);
  if (isWindowsAppsAlias(resolved)) return null;
  return isExecutableFile(resolved) ? resolved : null;
}

function defaultWhereRunner(executable) {
  return spawnSync('where.exe', [executable], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: pythonEnvironment(),
  });
}

/**
 * Resolves a configured Python command to a real executable before spawning.
 * On Windows this skips app execution aliases and install-manager launchers so
 * the sanitized child environment cannot trigger an installation prompt.
 * The optional whereRunner is injectable for deterministic tests.
 */
export function resolvePythonExecutable(pythonBin = config.pythonBin, { whereRunner = defaultWhereRunner } = {}) {
  const executable = typeof pythonBin === 'string' ? pythonBin.trim() : '';
  if (!executable) return executable;
  if (process.platform !== 'win32') return executable;

  const explicitPath = path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\');
  if (explicitPath) {
    const resolved = resolveWindowsCandidate(executable);
    if (resolved) return resolved;
    throw new WorkspaceError(502,
      'PYTHON_BIN does not resolve to a usable Python 3.12+ executable. On Windows, set it to a real python.exe rather than an app alias or install-manager launcher.');
  }

  const lookup = whereRunner(executable);
  if (lookup.error || lookup.status !== 0) {
    throw new WorkspaceError(502,
      `PYTHON_BIN could not be resolved to a Python 3.12+ executable: ${executable}. Set PYTHON_BIN to the absolute path of python.exe.`);
  }
  const candidates = String(lookup.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveWindowsCandidate(candidate);
    if (resolved) return resolved;
  }
  throw new WorkspaceError(502,
    'PYTHON_BIN resolved only to Windows launchers that cannot run with the sanitized subprocess environment. Set PYTHON_BIN to a real Python 3.12+ executable.');
}

function postExecutionError(status, message) {
  const error = new WorkspaceError(status, message);
  // The proposal runner uses this to distinguish "nothing started, safe to
  // retry" from "the process ran, so the approval must be finalized as failed".
  error.preflight = false;
  return error;
}

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
        stdio: 'ignore',
      });
      return !killed.error;
    }
    // The child was started detached, so it is its own process group leader.
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies that the configured interpreter exists and supports Python 3.12+.
 * Called before every Python proposal so a missing or stale PYTHON_BIN fails
 * with an actionable message instead of an opaque spawn error.
 */
export function assertPythonInterpreter(pythonBin = config.pythonBin) {
  const configured = typeof pythonBin === 'string' ? pythonBin.trim() : '';
  if (!configured) {
    throw new WorkspaceError(502, 'PYTHON_BIN is empty. Configure a Python 3.12+ executable before running Python commands.');
  }
  const executable = resolvePythonExecutable(configured);
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    env: pythonEnvironment(),
  });
  if (result.error) {
    const hint = result.error.code === 'ENOENT'
      ? ` Python was not found at PYTHON_BIN. Set PYTHON_BIN to a Python 3.12+ executable (on Windows, use the absolute path to python.exe).`
      : '';
    throw new WorkspaceError(502, `Could not start the Python interpreter: ${result.error.message}.${hint}`);
  }
  const versionText = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = versionText.match(/Python\s+(\d+)\.(\d+)/);
  if (!match) {
    throw new WorkspaceError(502, `PYTHON_BIN did not report a Python version: ${result.status}.`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 3 || (major === 3 && minor < 12)) {
    throw new WorkspaceError(502, `Python ${major}.${minor} is too old. Python 3.12 or newer is required.`);
  }
  return `${major}.${minor}`;
}

/**
 * Resolves and hashes one exact .py file inside the workspace.
 *
 * At staging time (`expectedPath`/`expectedDigest` omitted) this produces the
 * values stored in the existing proposal row. At execution time both values
 * are supplied and must still match, so a renamed, replaced, symlinked, hard-
 * linked, or edited file cannot be executed under a stale approval.
 */
export function inspectPythonFile(
  rootDir,
  relativePath,
  { expectedPath = null, expectedDigest = null } = {},
) {
  if (typeof relativePath !== 'string' || !/\.py$/i.test(relativePath)) {
    throw new WorkspaceError(400, 'A Python command requires a relative .py file path.');
  }
  const target = resolveInside(rootDir, relativePath);
  if (!/\.py$/i.test(target.relative)) {
    throw new WorkspaceError(400, 'A Python command requires a .py file path inside the workspace.');
  }
  if (expectedPath !== null && target.relative !== normalizedRelative(expectedPath)) {
    throw new WorkspaceError(409, 'The approved Python file path changed. Create a fresh proposal.');
  }
  if (isSensitiveFile(path.basename(target.absolute))) {
    throw new WorkspaceError(403, 'Sensitive credential files cannot be executed by the assistant.');
  }

  // resolveInside follows symlinks for containment; the final entry and each
  // parent segment must still be plain in-workspace directories/files.
  const linkStat = fs.lstatSync(target.absolute);
  if (linkStat.isSymbolicLink()) {
    throw new WorkspaceError(403, 'Python files reached through a symlink cannot be executed.');
  }
  if (linkStat.isFile() && linkStat.nlink > 1) {
    throw new WorkspaceError(403, 'Python files with multiple hard links cannot be executed.');
  }
  const stat = fs.statSync(target.absolute);
  if (!stat.isFile()) throw new WorkspaceError(400, 'The Python path is not a file.');
  if (stat.size > MAX_READ_BYTES) {
    throw new WorkspaceError(413, `Python file is too large to execute (limit ${MAX_READ_BYTES} bytes).`);
  }
  const buffer = fs.readFileSync(target.absolute);
  if (buffer.subarray(0, 8_000).includes(0)) {
    throw new WorkspaceError(415, 'Binary files cannot be executed as Python source.');
  }
  const digest = `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
  if (expectedDigest !== null && digest !== expectedDigest) {
    throw new WorkspaceError(409, 'The approved Python file content changed. Create a fresh proposal.');
  }
  return { path: target.relative, absolute: target.absolute, digest, size: stat.size };
}

/** Convenience wrapper used when staging a proposal. */
export function pinPythonFile(rootDir, relativePath) {
  return inspectPythonFile(rootDir, relativePath);
}

function runPythonProcess({ executable, args, cwd, timeoutMs, maxOutputBytes, label }) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-python-'));
  const stdoutPath = path.join(outputDir, 'stdout.txt');
  const stderrPath = path.join(outputDir, 'stderr.txt');
  let stdoutFd = null;
  let stderrFd = null;
  let result;
  try {
    stdoutFd = fs.openSync(stdoutPath, 'w');
    stderrFd = fs.openSync(stderrPath, 'w');
    result = spawnSync(executable, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      // Output is redirected to regular files so a surviving descendant cannot
      // keep stdio pipes open and stall spawnSync after the parent exits.
      stdio: ['ignore', stdoutFd, stderrFd],
      env: pythonEnvironment(),
      windowsHide: true,
      detached: true,
    });
  } finally {
    if (stdoutFd !== null) {
      try { fs.closeSync(stdoutFd); } catch { /* already closed */ }
    }
    if (stderrFd !== null) {
      try { fs.closeSync(stderrFd); } catch { /* already closed */ }
    }
  }

  if (result.error?.code === 'ETIMEDOUT') {
    killProcessTree(result.pid);
    throw postExecutionError(504, `${label} timed out after ${timeoutMs} ms.`);
  }
  if (result.error) {
    throw postExecutionError(502, `Could not run ${label}: ${result.error.message}.`);
  }

  try {
    const stdoutSize = fs.statSync(stdoutPath).size;
    const stderrSize = fs.statSync(stderrPath).size;
    if (stdoutSize + stderrSize > maxOutputBytes) {
      throw postExecutionError(
        413,
        `${label} output exceeded the ${maxOutputBytes}-byte combined stdout/stderr limit.`,
      );
    }
    return {
      exitCode: result.status,
      stdout: fs.readFileSync(stdoutPath, 'utf8'),
      stderr: fs.readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function runOptions(options = {}) {
  return {
    timeoutMs: options.timeoutMs ?? config.pythonRunTimeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? config.pythonRunMaxOutputBytes,
  };
}

/** Parses a pinned .py file without executing project code. */
export function runPythonCheck(
  rootDir,
  relativePath,
  { pythonBin = config.pythonBin, ...options } = {},
) {
  const file = inspectPythonFile(rootDir, relativePath);
  const executable = resolvePythonExecutable(pythonBin);
  assertPythonInterpreter(executable);
  const limits = runOptions(options);
  return runPythonProcess({
    executable,
    // -I keeps project directories off sys.path; -c executes only the constant
    // AST script above, never the contents of the target file.
    args: ['-I', '-c', PYTHON_AST_CHECK, file.absolute],
    // -I excludes the project directory from sys.path, so a project-local
    // sitecustomize.py is not imported even though cwd is the workspace.
    cwd: rootDir,
    label: 'python_check',
    ...limits,
  });
}

/** Executes the exact .py file whose path and digest were approved. */
export function runPythonFile(
  rootDir,
  relativePath,
  {
    expectedDigest,
    pythonBin = config.pythonBin,
    ...options
  } = {},
) {
  if (typeof expectedDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new WorkspaceError(409, 'This Python approval has no valid file digest. Create a fresh proposal.');
  }
  const file = inspectPythonFile(rootDir, relativePath, {
    expectedPath: relativePath,
    expectedDigest,
  });
  const executable = resolvePythonExecutable(pythonBin);
  assertPythonInterpreter(executable);
  const limits = runOptions(options);
  return runPythonProcess({
    executable,
    // -I ignores PYTHON* environment variables and excludes the script folder
    // from sys.path. This reduces startup surprises; it is not a sandbox.
    args: ['-I', file.absolute],
    cwd: rootDir,
    label: 'python_run',
    ...limits,
  });
}

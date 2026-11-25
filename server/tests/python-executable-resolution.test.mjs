// Windows executable-resolution regressions. These fixtures use fake launchers
// in temp directories, so no Python install manager, real Python install, or
// network path is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePythonExecutable } from '../src/python/executor.js';

const windowsOnly = { skip: process.platform !== 'win32' };

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myai-python-resolve-'));
}

function writeFixture(root, relativePath, content = 'fake executable') {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('Windows launchers resolve to their real interpreter target', windowsOnly, () => {
  const root = tempRoot();
  try {
    const aliasDir = path.join(root, 'WindowsApps');
    const launcherDir = path.join(root, 'Python', 'bin');
    const coreDir = path.join(root, 'Python', 'pythoncore-3.12-64');
    for (const dir of [aliasDir, launcherDir, coreDir]) fs.mkdirSync(dir, { recursive: true });

    // A Windows app execution alias is a zero-byte reparse point. An install-
    // manager launcher is a real file with a sibling __target__ pointer.
    const alias = path.join(aliasDir, 'python.exe');
    fs.writeFileSync(alias, '');
    const launcher = writeFixture(root, 'Python/bin/python.exe', 'launcher');
    const real = writeFixture(root, 'Python/pythoncore-3.12-64/python.exe', 'real interpreter');
    fs.writeFileSync(`${launcher}.__target__`, real);

    const calls = [];
    const resolved = resolvePythonExecutable('python', {
      whereRunner: (executable) => {
        calls.push(executable);
        return { status: 0, stdout: `${alias}\r\n${launcher}\r\n`, error: null };
      },
    });

    assert.equal(resolved, real);
    assert.deepEqual(calls, ['python']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit Windows app alias fails deterministically instead of being spawned', windowsOnly, () => {
  const root = tempRoot();
  try {
    const aliasDir = path.join(root, 'Microsoft', 'WindowsApps');
    fs.mkdirSync(aliasDir, { recursive: true });
    const alias = path.join(aliasDir, 'python.exe');
    fs.writeFileSync(alias, '');

    assert.throws(
      () => resolvePythonExecutable(alias),
      (error) => error.status === 502 && /real python\.exe/i.test(error.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a bare command that resolves to no real executable fails without a spawn fallback', windowsOnly, () => {
  assert.throws(
    () => resolvePythonExecutable('python', {
      whereRunner: () => ({ status: 1, stdout: '', stderr: 'not found', error: null }),
    }),
    (error) => error.status === 502 && /PYTHON_BIN/.test(error.message),
  );
});

test('.cmd and .bat candidates are skipped in favour of a real python.exe', windowsOnly, () => {
  const root = tempRoot();
  try {
    const cmd = writeFixture(root, 'cmd/python.cmd', 'script launcher');
    const bat = writeFixture(root, 'bat/python.bat', 'script launcher');
    const zeroByte = path.join(root, 'broken', 'python.exe');
    fs.mkdirSync(path.dirname(zeroByte), { recursive: true });
    fs.writeFileSync(zeroByte, '');
    const valid = writeFixture(root, 'valid/python.exe', 'real interpreter');

    const resolved = resolvePythonExecutable('python', {
      whereRunner: () => ({
        status: 0,
        stdout: `${cmd}\r\n${bat}\r\n${zeroByte}\r\n${valid}\r\n`,
        error: null,
      }),
    });

    assert.equal(resolved, valid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit non-.exe launcher is rejected while a real .exe is accepted', windowsOnly, () => {
  const root = tempRoot();
  try {
    const cmd = writeFixture(root, 'python.cmd', 'script launcher');
    const bat = writeFixture(root, 'python.bat', 'script launcher');
    const valid = writeFixture(root, 'python.exe', 'real interpreter');

    for (const launcher of [cmd, bat]) {
      assert.throws(
        () => resolvePythonExecutable(launcher),
        (error) => error.status === 502 && /real python\.exe/i.test(error.message),
        `${launcher} must not be spawned without a shell`,
      );
    }
    assert.equal(resolvePythonExecutable(valid), valid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an install-manager launcher with an unusable target is skipped', windowsOnly, () => {
  const root = tempRoot();
  try {
    const launcher = writeFixture(root, 'launcher/python.exe', 'launcher');
    const invalidTarget = writeFixture(root, 'target/python.cmd', 'script launcher');
    fs.writeFileSync(`${launcher}.__target__`, invalidTarget);
    const valid = writeFixture(root, 'valid/python.exe', 'real interpreter');

    const resolved = resolvePythonExecutable('python', {
      whereRunner: () => ({
        status: 0,
        stdout: `${launcher}\r\n${valid}\r\n`,
        stderr: '',
        error: null,
      }),
    });

    assert.equal(resolved, valid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

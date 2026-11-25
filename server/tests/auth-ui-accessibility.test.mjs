// Focused static checks for the scoped sign-in and accessibility changes.
// The repository has no React DOM test harness, so these checks inspect the
// shipped source without rendering it or making network requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testsDir, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

test('password visibility toggle is keyboard reachable and exposes its state', () => {
  const authScreen = read('apps/web/src/AuthScreen.jsx');

  assert.doesNotMatch(authScreen, /tabIndex=\{?-1\}?/, 'the password toggle must stay in the tab order');
  assert.match(authScreen, /aria-pressed=\{showPassword\}/);
  assert.match(authScreen, /aria-label=\{showPassword \? 'Hide password' : 'Show password'\}/);
});

test('hero headline keeps visual breaks and accessible whitespace', () => {
  const authScreen = read('apps/web/src/AuthScreen.jsx');

  assert.match(authScreen, /Describe it\.\{' '\}<br \/>Plan it\.\{' '\}<br \/><span>Ship it\.<\/span>/);
});

test('authentication mode uses accessible ordinary buttons instead of an incomplete tablist', () => {
  const authScreen = read('apps/web/src/AuthScreen.jsx');

  assert.doesNotMatch(authScreen, /role="tablist"|role="tab"/);
  assert.match(authScreen, /<div className="auth-tabs" role="group" aria-label="Authentication mode">/);
  assert.match(authScreen, /aria-pressed=\{!isRegister\}/);
  assert.match(authScreen, /aria-pressed=\{isRegister\}/);
  assert.match(authScreen, /onClick=\{\(\) => switchMode\('login'\)\}/);
  assert.match(authScreen, /onClick=\{\(\) => switchMode\('register'\)\}/);
});

test('sign-in footer is concise and adds no password recovery surface', () => {
  const authScreen = read('apps/web/src/AuthScreen.jsx');

  assert.match(authScreen, /Sessions persist across refreshes\. Sign out ends access\./);
  assert.doesNotMatch(authScreen, /Forgot password/i);
  assert.doesNotMatch(authScreen, /\/api\/auth\/(?:forgot|reset|recover)/i);
});

test('auth CSS keeps one brand per breakpoint and improves focus and readability', () => {
  const styles = read('apps/web/src/styles.css');

  assert.match(styles, /@media \(min-width: 901px\) \{\s*\.auth-panel \.auth-card > \.auth-brand \{ display: none; \}/);
  assert.match(styles, /\.auth-form input:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/);
  assert.match(styles, /\.auth-aside \{[^}]*--text-strong: #f3f3f4;[^}]*--muted: #b8bbc5;/);
  assert.match(styles, /\.auth-note \{[^}]*color: var\(--muted\);[^}]*font-size: 11px;/);
  assert.match(styles, /\.dialog-field > input:focus-visible[^{]*\{[^}]*outline: 2px solid var\(--accent\)/);
});

test('project dialog sets initial focus and restores the prior focus without a dependency', () => {
  const dialog = read('apps/web/src/ProjectDialog.jsx');

  assert.match(dialog, /import React, \{ useCallback, useEffect, useRef, useState \} from 'react';/);
  assert.doesNotMatch(dialog, /from ['"]focus-trap/);
  assert.match(dialog, /const dialogRef = useRef\(null\);/);
  assert.match(dialog, /ref=\{dialogRef\}/);
  assert.match(dialog, /tabIndex=\{-1\}/);
  assert.match(dialog, /const previouslyFocused = document\.activeElement/);
  assert.match(dialog, /previouslyFocused\.focus\(\)/);
  assert.match(dialog, /dialogRef\.current\?\.focus\(\)/);
  assert.match(dialog, /nameRef\.current\?\.focus\(\)/);
  assert.match(dialog, /event\.key\s*!==?\s*'Tab'/);
  assert.match(dialog, /event\.shiftKey && \(document\.activeElement === first \|\| document\.activeElement === container\)/);
});

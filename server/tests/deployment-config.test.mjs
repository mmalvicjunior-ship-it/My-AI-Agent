// Deployment configuration validation.
// Read-only checks of the manifests that ship with the repository. No network
// calls, no live AI requests, and no credential values are read or required.
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

// Verified by GET /api/health: this host returns the myai-agent-server service.
const VERIFIED_BACKEND = 'https://my-ai-agent-acqy.onrender.com';

test('Vercel keeps the same-origin /api rewrite to the verified Render service', () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.framework, 'vite');
  assert.equal(vercel.outputDirectory, 'apps/web/dist');

  const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
  const apiRewrites = rewrites.filter((entry) => entry.source === '/api/:path*');
  assert.equal(apiRewrites.length, 1, 'expected exactly one /api/:path* rewrite');
  assert.equal(apiRewrites[0].destination, `${VERIFIED_BACKEND}/api/:path*`);
});

test('Vercel config contains no credentials or direct frontend API base URL', () => {
  const text = read('vercel.json');
  assert.doesNotMatch(text, /AI_API_KEY|GEMINI_API_KEY|OPENROUTER_API_KEY|VITE_API_BASE_URL/);
  assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(text, /\bsk-[A-Za-z0-9_-]{8,}/);
});

test('Render keeps the persistent disk and durable database/workspace paths', () => {
  const yaml = read('render.yaml');
  assert.match(yaml, /mountPath: \/var\/data/);
  assert.match(yaml, /sizeGB: 1/);
  assert.match(yaml, /- key: DATABASE_PATH\n\s+value: \/var\/data\/app\.db/);
  assert.match(yaml, /- key: WORKSPACE_ROOT\n\s+value: \/var\/data\/workspaces/);
  assert.match(yaml, /healthCheckPath: \/api\/health/);
});

test('Render declares independent OpenRouter and Gemini credentials without inline secrets', () => {
  const yaml = read('render.yaml');
  assert.match(yaml, /- key: AI_PROVIDER\n\s+value: openai/);

  for (const key of ['AI_API_KEY', 'AI_MODEL', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GEMINI_MODEL']) {
    assert.match(
      yaml,
      new RegExp(`- key: ${key}\\n\\s+sync: false`),
      `${key} must be declared with sync: false`,
    );
  }

  assert.doesNotMatch(yaml, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(yaml, /\bsk-[A-Za-z0-9_-]{8,}/);
});

test('Render uses a Node version compatible with node:sqlite and Vite 7', () => {
  const yaml = read('render.yaml');
  assert.match(yaml, /- key: NODE_VERSION\n\s+value: "?22"?/);

  const pkg = JSON.parse(read('package.json'));
  const range = pkg.engines?.node || '';
  assert.ok(range.includes('22.12'), `package.json engines.node must require >=22.12, got "${range}"`);
});

test('frontend reads only the optional VITE_API_BASE_URL variable', () => {
  const app = read('apps/web/src/App.jsx');
  const names = [...app.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(names)], ['VITE_API_BASE_URL']);
});

test('.env.example documents both independent provider credential pairs', () => {
  const example = read('.env.example');
  for (const key of [
    'AI_PROVIDER',
    'AI_API_KEY',
    'AI_MODEL',
    'OPENAI_BASE_URL',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
    'DATABASE_PATH',
    'WORKSPACE_ROOT',
  ]) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), `${key} is missing from .env.example`);
  }
});

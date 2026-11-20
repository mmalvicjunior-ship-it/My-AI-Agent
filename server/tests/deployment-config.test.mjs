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

// This staging branch rewrites /api to the isolated free Render service, never
// to the production backend. The production branch keeps its own vercel.json.
const STAGING_BACKEND = 'https://my-ai-agent-staging-auth.onrender.com';

test('Vercel staging preview uses the isolated Render service', () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.framework, 'vite');
  assert.equal(vercel.outputDirectory, 'apps/web/dist');

  const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
  const apiRewrites = rewrites.filter((entry) => entry.source === '/api/:path*');
  assert.equal(apiRewrites.length, 1, 'expected exactly one /api/:path* rewrite');
  assert.equal(apiRewrites[0].destination, `${STAGING_BACKEND}/api/:path*`);
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

test('backend auth router registers the documented email/password and Google routes', () => {
  const auth = read('server/src/routes/auth.js');
  const routes = [...auth.matchAll(/router\.(?:get|post|put|patch|delete)\('([^']+)'/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(routes, ['/google/callback', '/google/start', '/login', '/logout', '/me', '/register']);
});

test('frontend exposes email/password and Google authentication', () => {
  const authScreen = read('apps/web/src/AuthScreen.jsx');
  const app = read('apps/web/src/App.jsx');

  assert.match(authScreen, /\/api\/auth\/\$\{mode\}/);
  assert.match(authScreen, /useState\('login'\)/);
  assert.match(authScreen, /const isRegister = mode === 'register'/);
  assert.match(authScreen, /type="email"/);
  assert.match(authScreen, /type=\{showPassword \? 'text' : 'password'\}/);
  assert.match(authScreen, /\/api\/auth\/google\/start/);
  assert.match(authScreen, /Continue with Google/);

  assert.match(app, /\/api\/auth\/me/);
  assert.match(app, /\/api\/auth\/logout/);
});

test('the setup fragment token is forwarded to the Google OAuth start contract', () => {
  const authScreen = read('apps/web/src/AuthScreen.jsx');
  const auth = read('server/src/routes/auth.js');

  // The setup link is a same-document navigation when pasted into an open tab,
  // so the token must be re-read on hashchange and at request time, not only on
  // the component's first mount.
  assert.match(authScreen, /addEventListener\('hashchange', processFragment\)/);
  assert.match(authScreen, /function bootstrapTokenFromLocation\(\)/);
  assert.match(authScreen, /const token = bootstrapTokenFromLocation\(\);/);
  assert.match(authScreen, /if \(token\) body\.bootstrapToken = token;/);
  assert.match(authScreen, /clearBootstrapFromLocation\(\);\s*\n\s*window\.location\.assign\(result\.url\)/);
  assert.doesNotMatch(authScreen, /console\.(log|debug|info)\([^)]*token/i);

  // Backend expects exactly bootstrapToken from config.bootstrapToken and
  // never accepts a client-supplied role.
  assert.match(auth, /req\.body\?\.bootstrapToken/);
  assert.match(auth, /tokensEqual\(provided, config\.bootstrapToken\)/);
});

test('frontend and backend authentication endpoints agree', () => {
  const sources = ['apps/web/src/App.jsx', 'apps/web/src/AuthScreen.jsx'].map(read).join('\n');
  const endpoints = [...sources.matchAll(/\/api\/auth\/([a-z][a-z0-9-]*)/gi)]
    .map((match) => match[1].toLowerCase());
  const allowed = new Set(['register', 'login', 'logout', 'me', 'google']);

  for (const endpoint of endpoints) {
    assert.ok(allowed.has(endpoint), `unexpected frontend auth endpoint: ${endpoint}`);
  }
  assert.ok(endpoints.includes('me'));
  assert.ok(endpoints.includes('logout'));

  const auth = read('server/src/routes/auth.js');
  for (const route of ['/register', '/login', '/logout', '/me']) {
    assert.match(auth, new RegExp(`router\\.(?:get|post)\\('${route.replace('/', '\\/')}'`));
  }
});

test('deployment configuration keeps Google OAuth optional and secret-free', () => {
  const example = read('.env.example');
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'APP_ORIGIN']) {
    assert.match(example, new RegExp(`^${key}=$`, 'm'), `${key} must be documented with an empty default in .env.example`);
  }
  assert.doesNotMatch(example, /GOOGLE_CLIENT_SECRET=\S+/, '.env.example must not contain a real Google client secret');
});

test('generated frontend assets contain no credential patterns', () => {
  const assetsDir = path.join(projectRoot, 'apps', 'web', 'dist', 'assets');
  if (!fs.existsSync(assetsDir)) return;

  for (const name of fs.readdirSync(assetsDir).filter((entry) => entry.endsWith('.js'))) {
    const bundle = fs.readFileSync(path.join(assetsDir, name), 'utf8');
    assert.doesNotMatch(bundle, /AIza[0-9A-Za-z_-]{20,}|\bsk-[A-Za-z0-9_-]{8,}/, `${name} must not contain credential patterns`);
  }
});

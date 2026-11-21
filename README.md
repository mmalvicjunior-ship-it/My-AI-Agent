# MyAI-Agent

A lightweight, original AI coding agent with:

- **Web interface** (React + Vite) for computers
- **Mobile interface** (React Native + Expo) for Android/iPhone
- **Backend** (Node.js + Express) with an AI-provider adapter (replaceable)
- **Educational trading simulator** (Phase 5, virtual money only)

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Environment inspection | ✅ Done |
| 2 | Environment fixes | ✅ Nothing to fix yet |
| 3 | Core agent (server + web + mobile) | 🔨 In progress — scaffold |
| 4 | AI adapter & chat | ⬜ Pending |
| 5 | Trading education simulator | ⬜ Pending (blocked until core works) |

## Quick start

```bash
npm install          # install dependencies for every workspace
npm run dev           # start backend and web app together
npm run dev:clean     # Windows: stop this project's port 3001 listener, then start both
```

Open `http://localhost:5173`. The first screen asks you to register or sign in;
see [Accounts and sessions](#accounts-and-sessions). If you already have the
backend running in another
terminal, stop it with Ctrl+C before running `npm run dev`; otherwise port 3001
will already be occupied. On Windows, `npm run dev:clean` verifies that a
process listening on port 3001 belongs to this project before stopping it and
restarting both services. If ownership cannot be verified, it exits without
stopping the process. The backend still reports a clear error if the port
remains occupied.

To start only the web app, use `npm run dev:web` from the repository root, or run
`npm run dev` from `apps/web/`. The web app proxies `/api` requests to the backend
on port 3001. Chat history is saved in the browser; the project selector uses the
backend project API.

To start only the backend, use `npm run dev:server` (or its `npm run server`
shortcut) from the repository root. The development command runs the server
without Node's built-in watcher to avoid overlapping restarts on a fixed port;
restart it manually after backend code changes.

### Accounts and sessions

The web app and API require an account. On first load the browser shows a
Sign in screen; open the **Create Account** tab to register with an email and
a password of at least 8 characters, then use the **Sign out** control in the
sidebar to end the session. Accounts are stored locally in SQLite.

- Passwords are hashed with Node's built-in `scrypt`; the raw password is never
  stored or logged. Session tokens are random 256-bit values, and only their
  SHA-256 hash is written to the database.
- The browser keeps the bearer token in `localStorage` (`myai.auth.v1`) and
  sends it as `Authorization: Bearer <token>` on every `/api` request. There is
  no cookie, so no CSRF token is needed. Clearing site data signs you out.
- Sessions expire after `AUTH_SESSION_DAYS` (default 30). Expired or revoked
  tokens receive `401` and return the UI to the sign-in screen.
- `/api/health` is the only public endpoint besides register/login/logout and
  the owner-only admin provisioning route. Every project, file, task,
  proposal, and command endpoint requires a session and is scoped to the owning
  account. Requesting another account's project returns `404`, not its contents.
- Ordinary registration and Google sign-in never require a token and always
  create ordinary users. The first administrator is provisioned separately by
  the owner through `POST /api/auth/admin/provision`, which reuses the
  server-side `BOOTSTRAP_TOKEN` and stops working once one admin exists. No
  startup migration promotes an arbitrary first visitor. The provisioned admin
  adopts projects that predate accounts (`owner_id IS NULL`) so existing local
  data stays reachable. See `docs/FIRST-ACCOUNT-BOOTSTRAP.md`.
- Optional Google sign-in (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_OAUTH_REDIRECT_URI`)
  uses Google's authorization-code flow entirely server-side: the browser is
  redirected straight to Google, Google calls back
  `/api/auth/google/callback`, and the server exchanges the code and validates
  the identity against Google's tokeninfo endpoint (verified email required)
  before issuing a normal session token. Google users are never administrators,
  existing email/password accounts are never auto-linked, and no client secret
  reaches the browser. Setup: `docs/GOOGLE-OAUTH.md`.
- Register/login are throttled in memory (10 attempts per 15 minutes per IP,
  with a per-IP registration limit and a login spray backstop; `TRUST_PROXY`
  controls how many proxy hops are trusted for client IPs). The counters reset
  when the server restarts.

These routes are public:

```text
POST /api/auth/register   { email, password } -> { token, expiresAt, user }
                          (always creates an ordinary user)
POST /api/auth/login      { email, password } -> { token, expiresAt, user }
POST /api/auth/logout     invalidates the presented session (idempotent)
GET  /api/auth/me         verifies a token and returns the current user
POST /api/auth/admin/provision
                          { bootstrapToken, email, [password|googleSub] }
                          owner-only; works only while no admin exists
GET  /api/health          provider status only; no credentials
```

### Configure real AI responses

Copy `.env.example` to `.env` in the repository root, then configure one provider:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key_here
# Optional; defaults to gemini-2.5-flash
GEMINI_MODEL=gemini-2.5-flash
```

Gemini can also use the legacy shared `AI_API_KEY`/`AI_MODEL` values when
`AI_PROVIDER=gemini`. The independent `GEMINI_*` variables are recommended so
OpenRouter and Gemini can both be configured at once.

Or use OpenAI:

```dotenv
AI_PROVIDER=openai
AI_API_KEY=your_openai_api_key_here
# Optional; defaults to gpt-4o-mini
AI_MODEL=gpt-4o-mini
```

For OpenRouter, use the OpenAI-compatible adapter with its API base URL and a
model available to your OpenRouter account:

```dotenv
AI_PROVIDER=openai
AI_API_KEY=your_openrouter_api_key_here
AI_MODEL=meta-llama/llama-3.1-8b-instruct:free
OPENAI_BASE_URL=https://openrouter.ai/api/v1
```

OpenRouter model availability and free-tier limits can change; choose a model
listed as available in your OpenRouter account if this example is unavailable.
The free tier allows a limited number of requests per day; when that limit is
reached the app reports the rate limit by name instead of failing silently, and
it never switches to a different model on its own.

With both `AI_API_KEY`/`AI_MODEL` (OpenRouter) and `GEMINI_API_KEY`/`GEMINI_MODEL`
configured, use the provider selector in the app's top bar to switch chat between
**OpenRouter** and **Google Gemini**. The choice is saved in the browser and is
sent with each chat request. This switch is chat-only: background tasks continue
using the startup `AI_PROVIDER`. Both API keys stay in the backend `.env`; the
browser only receives the provider name and whether it is configured.

Or use Hugging Face Inference Providers with a token that has Inference Providers permission:

```dotenv
AI_PROVIDER=huggingface
AI_API_KEY=your_huggingface_token_here
# Optional; defaults to meta-llama/Meta-Llama-3-8B-Instruct
AI_MODEL=meta-llama/Meta-Llama-3-8B-Instruct
```

Or use a local Ollama server (no API key required):

```dotenv
AI_PROVIDER=ollama
AI_MODEL=llama3
```

Install and start Ollama separately, then download the model with
`ollama pull llama3`. The adapter calls `http://127.0.0.1:11434/api/chat`.

Keep `.env` private and never commit or share a real API key. The providers use
Node's built-in `fetch`, so no additional AI SDK package is required. The server
loads `.env` from the repository root (`MyAI Agent/.env`), not `server/.env`.
The Vite `/api` proxy reads the same root `PORT` setting as the backend. If that
port is occupied, the backend exits with a clear error rather than switching to
a port the frontend cannot reach; stop the existing backend before restarting
`npm run dev`. Restart both services after editing `PORT` in `.env`. The checked-in example local
configuration uses `AI_PROVIDER=mock`; OpenAI selected without a key returns a
configuration error rather than silently substituting a mock reply.

Chat logs show the active provider and message length without printing prompt
text. To temporarily log prompt content while debugging locally, set
`DEBUG_CHAT_PROMPTS=true`; configured API keys are redacted, but other private
content may appear in the terminal.

For follow-up context, the web app sends the conversation as
`{ messages: [{ role, content }, ...] }` to `POST /api/chat`. The route validates
and passes the full array to the selected provider, which forwards previous user
and assistant turns to the AI API.

### Workspace coding tools

Create a workspace in the app. Importing an existing server directory through
`POST /api/projects` is **disabled by default**; it only works when the operator
sets `PROJECT_IMPORT_ROOT`, and the requested path must resolve inside that
root. Paths inside the managed `WORKSPACE_ROOT` are always rejected because that
tree holds every account's project files. The file scanner skips dependency/build
folders and credential files. Gemini can inspect/search files and request the
predefined `npm test`, `npm run build`, `npm run lint`, `npm run format`,
`node --check`, `python_check`, and `python_run` tools. `python_check` parses a
`.py` file without executing it. `python_run` executes an exact, digest-pinned
`.py` file only after the same approval used by command proposals; it is refused
in multi-user deployments. Generated Python is **not sandboxed** and runs with
the backend account's operating-system privileges.

OpenAI-compatible providers, including OpenRouter, can also use these workspace
tools when the selected model supports function calling. Workspace tools are
only offered when the request names a project that exists, so without a selected
workspace MyAI answers from the conversation alone and does not claim file,
command, web, or browsing access. OpenRouter model availability and function-calling
support vary by model and free tier — if the configured model cannot call tools,
MyAI reports the limitation as text instead of silently switching models.
The agent caps tool rounds at six and reuses the previous result when the model
repeats an identical call (including `list_files` with an omitted path versus
`.`), then asks for a final answer without tools rather than failing.

How the agent loop behaves:

- The shared Gemini-style tool declarations are converted to OpenAI-compatible
  JSON Schema (lower-case types, nested objects/arrays, type unions). The
  server-managed workspace id is removed from the schema, so the model never
  has to guess it and cannot target another workspace.
- The assistant turn is sent back with its `tool_calls`, and every tool result
  is sent as a `role: "tool"` message with the matching `tool_call_id`.
  Arguments that are not valid JSON never reach a tool; the model receives a
  clear error and the request still completes.
- Repeats are detected per request. Equivalent spellings of the same call -
  an omitted `list_files` path versus `.`, `./src/app.js` versus `src/app.js` -
  reuse the earlier result instead of running the tool again.
- If the model keeps calling tools, the agent asks once for a final answer
  with no tools attached. If that still produces nothing, it returns an honest
  explanation instead of a provider error or a false success.
- Nothing is written or run before you approve it. If a reply claims a staged
  change is already done, the server removes that claim and states that the
  change is still waiting for your approval, so a small model cannot report a
  staged edit as a finished one.

For a "list files" request the agent lists the requested directory once (the
project root by default), reports the returned paths, and does not read file
contents unless you ask it to.

Commands require an explicit user approval click before execution. New files
and proposed edits are staged as a diff and require an explicit **Apply file**
click; existing files are updated only if they have not changed since review
began. A staged change can also be rejected with **Discard**, which removes the
proposal without touching the file so it can never be applied afterwards.
Nothing is written or run until you approve it, and MyAI describes a
staged change as awaiting approval rather than as already applied. Paths that
could never be written (absolute paths, `../` traversal, credential files) are
refused when the change is staged instead of being offered for approval.
Uploaded source attachments are sent as prompt context and are not stored in
chat history.

Pending proposals are stored in the same SQLite database as the projects, so
they survive a backend restart: a staged change still lists, applies, or
discards after the server is restarted, without re-running the chat request.
Only pending proposals are listed; applied, discarded, and failed rows are
retained for audit but answer "Pending proposal not found." (404) exactly like a
discarded proposal always did. Applying a proposal claims it in the database
before touching the file, so a double click or simultaneous request writes once,
and the stale-content check still runs against the reviewed original. If the
server stops mid-application, startup recovery reads the target file instead of
retrying: a write that already landed is finalized (with exactly one history
entry), a write that never landed returns to pending, and a conflicting or
unknown state is marked failed. A command interrupted while running is never
retried automatically because its side effects are unknown.

### Background tasks

A coding task can be queued through the API and runs in the backend process,
independently of the browser tab that created it:

```text
POST /api/tasks                     { projectId, instruction }
GET  /api/tasks?projectId=1         list, newest first (optionally &status=&limit=)
GET  /api/tasks/:id                 task plus its ordered execution steps
POST /api/tasks/:id/cancel          stop a queued, running, or waiting task
```

`POST /api/tasks` always uses the server-controlled `propose` default; any
`autonomy` or `autonomous` fields in the request body are ignored for execution
privileges. Statuses are `queued`, `running`, `waiting_approval`,
`provider_paused`, `completed`, `failed`, and `cancelled`. Autonomy may let a
background task continue planning, research, and reading, but it never grants
write or command privileges. All AI-proposed file changes and commands are
staged as proposals and require explicit user approval. Tasks and steps are
stored in SQLite, so status and history survive a restart. A task that was
`running` when the server stopped is
marked `failed` with an "interrupted" reason and is never resumed
automatically: the last step may not have completed, so re-running it could
apply the same change twice. A queued task is cancelled immediately; a running
task records the cancellation request, aborts the in-flight provider request,
and is then marked `cancelled`. Provider calls are retried at most three times
in total, only for HTTP 429, 502, and 504 responses, with a bounded backoff (an
upstream `Retry-After` is honoured up to 30 seconds). Authentication,
configuration, malformed-response, and cancellation failures are never retried.

The runner starts with the server process (not with an HTTP request), so closing
the browser tab does not stop a task. Each task reuses the existing provider
adapter and workspace tools, but the only tools exposed to the agent are
`read_file`, `list_files`, and `search_files`. The tool declarations are filtered
and a second guard refuses any `create_file`, `propose_file_change`,
`run_command`, or other write/execute tool during background inspection. A
structured plan may stage one file-change or allowlisted-command proposal at a
time. Ordered plans persist their redacted pending steps so the runner can
continue only after the current proposal reaches a terminal approval outcome.
The task's project id is forced onto every inspection tool call, so a
model-supplied id cannot read another project. Reads that fail are recorded as
failed steps and reported to the agent; tool steps contain paths, sizes, and
counts rather than file contents. The final outcome is stored as a `Result
ready` step (truncated to 10,000 characters); rejected, failed, or unknown
proposal outcomes fail the task instead of reporting the requested work as
completed.

Background execution requires a provider that implements the workspace tool loop
(the OpenAI-compatible and Gemini adapters). With `mock`, Hugging Face, or
Ollama, the task fails before any provider request with an explicit explanation
instead of returning an answer that never inspected the files. There is no task
creation UI yet; use the API above. Background tasks never apply file changes or
execute commands themselves; those actions remain behind their proposal
approval endpoints.

The app is available to phones on the same Wi-Fi using the `[web] network URL`
printed at startup. Open that URL on the phone; API requests use the same-origin
Vite proxy to reach the backend. PWA installation is available through the
browser's Add to Home Screen option. Voice input depends on browser
`SpeechRecognition` support.

To run the web app production build, use `npm run build -w web`.

`npm test` runs the server suite against a throwaway SQLite database and
workspace folder, so it never adds test projects to `server/data/app.db` or
`server/workspaces/`. `npm run smoke` boots the server in-process and checks
`/api/health`.

### Deploy frontend to Vercel and backend to Render

The frontend and backend remain separate npm workspaces: `apps/web` is the
Vercel static site and `server` is the Render Node service. Keep the Vercel
project root set to the repository root (`.`) so it can use the root npm
lockfile and workspace dependencies. The root `vercel.json` builds only the
`web` workspace, serves `apps/web/dist`, and proxies `/api/*` requests to the
Render service.

#### Verified backend URL and rewrite

The live backend is `https://my-ai-agent-acqy.onrender.com`. This was verified
by requesting `GET /api/health` from that host, which returned the
`myai-agent-server` service; the previously documented
`https://myai-agent-malvic-backend.onrender.com` returned `404`. `vercel.json`
already rewrites `/api/*` to the verified origin, so browser requests remain
same-origin and the server does not need CORS middleware.

If you create a new Render service from the Blueprint (or rename the existing
one), confirm its URL in the Render dashboard and update the rewrite
destination. A different service name produces a different `onrender.com`
hostname. Keep the `/api/:path*` rewrite; do not replace it with a direct
frontend-to-Render URL.

#### Why `VITE_API_BASE_URL` must stay unset

When `VITE_API_BASE_URL` is unset, `apps/web/src/App.jsx` uses relative `/api`
paths and Vercel proxies them to Render. Setting it to the Render URL makes
every chat request cross-origin; the backend has no CORS or preflight handling,
so JSON POSTs would fail. Vite also inlines `VITE_*` values into the public
JavaScript bundle at build time, so a base URL change would require a frontend
redeploy. Leave it unset in Vercel.

#### Node.js version

`node:sqlite` requires Node.js 22.5 or newer, and Vite 7 requires Node.js
20.19+ or 22.12+. The repository declares `>=22.12`, `render.yaml` sets
`NODE_VERSION=22`, and the Vercel project should use Node.js 22.x. Node 22 LTS
is the supported production runtime for both services.

#### Render environment variables

Set these in the Render dashboard (or accept the Blueprint's `sync: false`
prompts). Never commit real values.

| Variable | Required | Notes |
| --- | --- | --- |
| `AI_PROVIDER` | Yes | `openai` starts the OpenRouter adapter and is the provider used by background tasks. |
| `AI_API_KEY` | Yes for OpenRouter | Secret OpenRouter key. Backend only. |
| `AI_MODEL` | Yes in practice | An OpenRouter model slug, for example `meta-llama/llama-3.1-8b-instruct:free`. The adapter's built-in `gpt-4o-mini` default is not a valid OpenRouter slug. |
| `OPENAI_BASE_URL` | Yes for OpenRouter | `https://openrouter.ai/api/v1` (the adapter appends `/chat/completions`). |
| `GEMINI_API_KEY` | Optional | Required only to use Gemini chat. Secret; backend only. |
| `GEMINI_MODEL` | Optional | Defaults to `gemini-2.5-flash`. |
| `DATABASE_PATH` | Yes | `/var/data/app.db` on the mounted disk. |
| `WORKSPACE_ROOT` | Yes | `/var/data/workspaces` on the mounted disk. |
| `AUTH_SESSION_DAYS` | No | Session lifetime in days (1-365). Defaults to `30`. |
| `BOOTSTRAP_TOKEN` | Yes before admin provisioning | Shared secret for the owner-only `/api/auth/admin/provision` endpoint. Set in the Render dashboard; never commit it. Not used by ordinary registration or Google sign-in. |
| `ALLOW_REGISTRATION` | No | Defaults to enabled. Set `false` after provisioning the administrator to close public registration. Existing accounts can always log in. |
| `GOOGLE_CLIENT_ID` | No | Google OAuth 2.0 client ID (Web application). Enables the "Continue with Google" button. Render only; never the frontend. |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth 2.0 client secret. Server-side only, never exposed to the browser. |
| `GOOGLE_OAUTH_REDIRECT_URI` | No | Exact authorized redirect URI. For the current Vercel app use `https://my-ai-agent-apps.vercel.app/api/auth/google/callback`. |
| `APP_ORIGIN` | No | Base URL the browser returns to after the Google callback. Empty = same-origin relative redirect. Must be an absolute https origin (http only on localhost) with no credentials, path, query or fragment; invalid values fail startup closed. |
| `PROJECT_IMPORT_ROOT` | No | Leave unset to disable importing existing server directories. When set, imports must resolve inside this directory; paths inside `WORKSPACE_ROOT` are always rejected. |
| `NODE_VERSION` | Recommended | `22`. |
| `PORT` | No | Render injects it; do not set it. |
| `HOST` | No | Leave unset so the server binds all interfaces. |
| `DEBUG_CHAT_PROMPTS` | No | Keep `false` in production. |

For the current OpenRouter setup keep `AI_PROVIDER=openai`,
`OPENAI_BASE_URL=https://openrouter.ai/api/v1`, the existing `AI_MODEL` value,
and the OpenRouter `AI_API_KEY` in Render only. `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, and optional `APP_ORIGIN`
also belong in Render only.

`AI_API_KEY`/`AI_MODEL`/`OPENAI_BASE_URL` configure OpenRouter.
`GEMINI_API_KEY`/`GEMINI_MODEL` configure Gemini independently, so both
providers can be available at once and the in-app selector can switch chat
between them. Background tasks keep using the startup `AI_PROVIDER`.

#### Optional persistent-storage and Python variables

The checked-in `render.yaml` intentionally keeps the original SQLite + local
workspace-disk configuration (`DATABASE_PATH=/var/data/app.db`,
`WORKSPACE_ROOT=/var/data/workspaces`, 1 GB disk). If you choose a managed
database or object storage instead, add these variables in the **Render backend
service** only; none belong in Vercel or in any `VITE_*` variable.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_BACKEND` | `sqlite` | `postgres` enables Neon/PostgreSQL; `pglite` is a local compatibility-test backend, not a production choice. |
| `DATABASE_URL` | empty | Required for `postgres`; accepts a Neon pooled or direct PostgreSQL URL. Secret. |
| `NEON_DATABASE_URL` | empty | Alias for `DATABASE_URL`; used only when `DATABASE_URL` is empty. Secret. |
| `DATABASE_SSL` | `true` | Set `false` only for a controlled local database without TLS. |
| `DATABASE_REJECT_UNAUTHORIZED` | `true` | Keep `true` for valid TLS certificates; `false` is for controlled local testing only. |
| `STORAGE_BRIDGE_TIMEOUT_MS` | `60000` | Timeout for the synchronous worker bridge used by the async Postgres/S3 drivers. |
| `WORKSPACE_STORAGE` | `local` | `s3` enables an S3-compatible endpoint; `memory` is a test-only stand-in. Imports of existing directories are rejected when this is not `local`. |
| `WORKSPACE_S3_ENDPOINT` | empty | S3-compatible HTTPS endpoint. Required for `s3`. |
| `WORKSPACE_S3_BUCKET` | empty | Bucket name. Required for `s3`. |
| `WORKSPACE_S3_REGION` | `auto` | Region for compatible providers that require one. |
| `WORKSPACE_S3_ACCESS_KEY` | empty | Access key ID. Secret; Render only. |
| `WORKSPACE_S3_SECRET_KEY` | empty | Secret access key. Secret; Render only. |
| `WORKSPACE_S3_PREFIX` | `workspaces` | Key prefix under which per-project files are stored. |
| `PGLITE_DATA_DIR` | empty | Optional local directory for PGlite compatibility tests; unused by `sqlite`/`postgres`. |
| `PYTHON_BIN` | `python` (Windows), `python3` otherwise | Python 3.12+ executable for `python_check`/`python_run`. `python_run` is refused in multi-user mode. On local Windows 3.12.10 use the absolute path `C:\Users\Malvic\AppData\Local\Python\pythoncore-3.12-64\python.exe`; that path is not valid on Render. |
| `PYTHON_RUN_TIMEOUT_MS` | `30000` | Backend subprocess timeout (100–600000 ms). On timeout the direct Python process and its process tree are forcibly terminated. |
| `PYTHON_RUN_MAX_OUTPUT_BYTES` | `16000` | Combined stdout/stderr cap (1–1048576 bytes). Exceeding it fails the proposal rather than returning partial output. |

These limits bound time and captured output; they are not a security sandbox.
The supplied DeepSeek execution-engine source (`execution_engine/`,
`engine_cli.py`, `node_integration/`, `tests/`, `pyproject.toml`) was not present
in the repository or accessible workspace, so no approval-proof signing,
interpreter-fingerprint protocol, task-document mode, stdin mode, or Windows Job
Object guarantee is claimed. The backend runner above uses the existing
persisted proposal claim instead.

Local PGlite and in-memory S3 tests verify driver contracts only; they are
**not** live Neon/PostgreSQL or real S3 verification. Confirm the managed
services, credentials, network access, and data migration separately before
switching a deployment away from the default SQLite/disk mode.

**Migration note:** if the Render service previously used `AI_PROVIDER=gemini`
with the Gemini key stored in `AI_API_KEY`, move that key to
`GEMINI_API_KEY` and put the OpenRouter key in `AI_API_KEY` before switching
the startup provider to `openai`. Otherwise OpenRouter would receive a Gemini
key. If Gemini is not configured, the selector still shows it, but the UI
reports that its key is missing and the request fails with a configuration
error; it never silently falls back to OpenRouter.

#### Vercel environment variables

No application environment variables are required. Leave `VITE_API_BASE_URL`
unset. The only Vercel settings are:

- Project root: repository root (`.`).
- Node.js version: 22.x.
- Build command and output directory: from `vercel.json`
  (`npm run build --workspace=web`, `apps/web/dist`).

`AI_API_KEY`, `GEMINI_API_KEY`, and `OPENROUTER_API_KEY` must never be added to
Vercel or prefixed with `VITE_`/`NEXT_PUBLIC_`. Vite inlines those values into
the public bundle. The browser only receives provider names and
configured/not-configured booleans from `/api/health`.

#### Persistent storage on Render

`render.yaml` mounts a 1 GB disk at `/var/data` and sets
`DATABASE_PATH=/var/data/app.db` and `WORKSPACE_ROOT=/var/data/workspaces`.
Render's default filesystem is ephemeral, so these paths are what make the
SQLite database and agent workspaces survive restarts and redeploys. Changing
the mount path requires moving the data first; do not point these variables
back at the relative defaults.

Operational limits:

- Use one Render instance only. SQLite and the local workspace directory are
  not safe for multiple instances or horizontal scaling.
- Render disks are not a managed backup service. Take periodic copies of
  `/var/data/app.db` and `/var/data/workspaces` and store them outside the
  service.
- The disk is 1 GB. Agent workspaces grow over time; monitor usage and increase
  the disk before it fills.
- A fresh deploy starts with an empty database and no workspaces, because
  `server/data/` and `server/workspaces/` are git-ignored. Migrate existing
  data deliberately if you need it in production.

**Deployment security notes:** every sensitive API route now requires a bearer
session and is scoped to the owning account, so one account cannot read, write,
approve, or run another account's projects. Imports of existing server
directories are off unless `PROJECT_IMPORT_ROOT` is configured. Before exposing
the service publicly:

- Generate a strong `BOOTSTRAP_TOKEN` and set it in the Render dashboard
  BEFORE the first deploy. Ordinary users sign in normally; the owner creates
  the single administrator with `POST /api/auth/admin/provision` (see
  `docs/FIRST-ACCOUNT-BOOTSTRAP.md`). Then set `ALLOW_REGISTRATION=false`.
- Keep `PROJECT_IMPORT_ROOT` unset unless you deliberately need directory
  imports; if set, point it at a dedicated folder, never the filesystem root or
  the workspace tree.
- Use HTTPS (Render provides it) because bearer tokens travel in the
  `Authorization` header. They are stored in browser `localStorage`, so a
  cross-site scripting bug could read them; keep the frontend dependencies
  patched and the bundle free of untrusted HTML.
- Treat `/var/data/app.db` as sensitive: it holds password and session hashes.
- Project files are user-writable, so approval prompts and project ownership are
  not an OS sandbox. Multi-user deployments allow only `node_check` and
  `python_check` (parsing, no execution); `npm_*` scripts and `python_run` are
  refused. `python_run` is available only in trusted single-user mode and still
  requires explicit approval. Do not describe this as a sandbox.

`createApp({ auth: false })` exists only for the automated tests. The production
entry point calls `createApp()` with no options, so a deployed server always
enforces authentication.

## Principles

- Minimal dependencies; no Docker, no emulators, no local AI models
- User approval required before risky commands or large changes
- Secrets live only in `.env` (never committed, never logged)
- Simulated trading results never imply real-world returns
# My-AI-Agent

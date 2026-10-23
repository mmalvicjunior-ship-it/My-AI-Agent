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

Open `http://localhost:5173`. If you already have the backend running in another
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

### Configure real AI responses

Copy `.env.example` to `.env` in the repository root, then configure one provider:

```dotenv
AI_PROVIDER=gemini
AI_API_KEY=your_gemini_api_key_here
# Optional; defaults to gemini-flash-latest
AI_MODEL=gemini-flash-latest
```

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

Create a workspace in the app, or import an existing directory by entering its
absolute path on the computer running the backend. The file scanner skips
dependency/build folders and credential files. Gemini can inspect/search files
and request the predefined `npm test`, `npm run build`, `npm run lint`,
`npm run format`, and `node --check` tools.

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
POST /api/tasks                     { projectId, instruction, autonomy? }
GET  /api/tasks?projectId=1         list, newest first (optionally &status=&limit=)
GET  /api/tasks/:id                 task plus its ordered execution steps
POST /api/tasks/:id/cancel          stop a queued, running, or waiting task
```

Statuses are `queued`, `running`, `waiting_approval`, `completed`, `failed`, and
`cancelled`; the default autonomy is `allow_writes_and_commands` (see
`server/src/tasks/store.js` for the three levels). Workspace inspection tools
remain read-only; file changes and allowlisted commands are staged as proposals
and always require the existing explicit approval workflow. The autonomy level
does not bypass that approval. Tasks and steps are stored in SQLite, so status and
history survive a restart. A task that was `running` when the server stopped is
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

## Principles

- Minimal dependencies; no Docker, no emulators, no local AI models
- User approval required before risky commands or large changes
- Secrets live only in `.env` (never committed, never logged)
- Simulated trading results never imply real-world returns
# My-AI-Agent

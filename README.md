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
`npm run format`, and `node --check` tools. Commands require an explicit user
approval click before execution. New files and proposed edits are staged as a
diff and require an explicit **Apply file** click; existing files are updated
only if they have not changed since review began. Uploaded source attachments
are sent as prompt context and are not stored in chat history.

The app is available to phones on the same Wi-Fi using the `[web] network URL`
printed at startup. Open that URL on the phone; API requests use the same-origin
Vite proxy to reach the backend. PWA installation is available through the
browser's Add to Home Screen option. Voice input depends on browser
`SpeechRecognition` support.

To run the web app production build, use `npm run build -w web`.

## Principles

- Minimal dependencies; no Docker, no emulators, no local AI models
- User approval required before risky commands or large changes
- Secrets live only in `.env` (never committed, never logged)
- Simulated trading results never imply real-world returns

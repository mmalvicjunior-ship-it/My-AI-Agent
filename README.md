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
npm install          # install workspace dependencies
npm run dev:server   # start backend on http://localhost:3001
npm run smoke        # run a quick server health check
```

## Principles

- Minimal dependencies; no Docker, no emulators, no local AI models
- User approval required before risky commands or large changes
- Secrets live only in `.env` (never committed, never logged)
- Simulated trading results never imply real-world returns

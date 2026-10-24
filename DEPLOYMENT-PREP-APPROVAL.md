# Deployment Prep — CORS + Persistent Storage (Approved Investigation Only; No Changes Applied Yet)

## 1. CORS — Inspect / Explain / Required Change

### How requests travel today
- **Local dev:** Vite dev server proxies `/api/*` → `127.0.0.1:3001` (`vite.config.js` proxy config). Same-origin.
- **Production (current vercel.json):** Vercel rewrites `/api/*` → `https://myai-agent-malvic-backend.onrender.com/api/*`. Browser sees Vercel domain; response comes back through Vercel edge. **Same-origin from browser perspective** — CORS headers not strictly required for this path.
- **Production (direct via VITE_API_BASE_URL set to Render URL):** Browser calls Render directly from Vercel domain → **cross-origin**. Server currently has **zero CORS middleware** (`express.json` only at `server/src/index.js`). Browser will block response without `Access-Control-Allow-Origin`.

### Recommended narrow fix (only if using direct base URL or as defense)
- File: `server/src/index.js`
- Add immediately after `express.json()` (line 39):
  ```js
  import cors from 'cors';
  app.use(cors({ origin: true }));  // allows any origin; narrow to Vercel domain if needed
  ```
- Also requires `cors` package in `server/package.json`.
- Alternative: instead of adding middleware, rely solely on Vercel rewrite (current `vercel.json`). Then CORS is unnecessary.

### Preservation note
- Existing routes / auth / JSON parsing preserved; `express.json({limit:'1mb'})` kept.
- No secrets changed; `.env` untouched.

## 2. Persistent Storage — Inspect / Explain / Required Change

### Current paths (no migration needed)
- DB: `server/src/config.js` resolves `databasePath` to `path.resolve(serverDir, './data/app.db')` = `server/data/app.db` (confirmed exists, 151KB).
- Workspaces: `workspaceRoot` = `path.resolve(serverDir, './workspaces')` = `server/workspaces` (confirmed exists, multiple project dirs).
- Both paths are relative to server folder; `process.env.DATABASE_PATH` / `WORKSPACE_ROOT` override the fallback, but **env variables alone do not make storage persistent** — they just redirect the file path.

### Render persistence requirement
Render's default filesystem is ephemeral (reset on redeploy/restart). To survive restarts/redeploys:
- **Option A (recommended):** Mount a Render Disk at `/data` (or a subpath) and set env vars to absolute paths on that disk (e.g., `DATABASE_PATH=/data/app.db`, `WORKSPACE_ROOT=/data/workspaces`). No data move needed if paths kept consistent.
- **Option B (simpler, no disk mount):** Use Render's managed PostgreSQL/SQLite external service or back up DB to object storage — but this requires architecture change (not needed now).

### No data migration required
- Existing DB file (`app.db`) and workspace folders stay at current relative paths.
- If Render Disk mounted at `/app/data` and `/app/workspaces` (matching repo root relative paths), data survives redeploy without migration.
- **Do NOT relocate database or recreate schema** — `provider_paused` CHECK and existing tables preserved.

### Required hosting setting (manual Render console step — not a file edit)
- Render dashboard → Service → Settings → Disk → Create / mount persistent disk at `/data` (or at repo-root relative paths).
- Set environment variables in Render dashboard: `DATABASE_PATH=/data/app.db`; `WORKSPACE_ROOT=/data/workspaces` (or keep relative if disk mounted at repo root).

## 3. Tests / Build / Verification (performed locally)
- `TaskCenter.jsx`: no undefined refs; `statusBadgeClass` + `stepStatusClass` defined.
- `App.jsx`: `API_BASE` uses `VITE_API_BASE_URL`; all fetch calls updated; local proxy preserved.
- Build: PASS (`✓ built in 14.53s` in `apps/web`).
- Quota-recovery tests: PASS (2/2, fail 0).
- Task-submission-quota regression: PASS.
- No `.env` edited; no live AI; no destructive git; services 3001/5173 not restarted.

## 4. Remaining manual steps (before deployment)
- [ ] Confirm Vercel workspace install passes (current `buildCommand` relies on root workspace; verify Vercel build logs show `vite` found).
- [ ] If using direct `VITE_API_BASE_URL` to Render: approve CORS middleware edit (`server/src/index.js` + `cors` dependency).
- [ ] If relying solely on rewrite (same-origin): CORS not required; skip middleware edit.
- [ ] Configure Render persistent disk + env vars (`DATABASE_PATH`, `WORKSPACE_ROOT`).
- [ ] Verify Render service starts with `npm run start -w server` and DB/workspaces are writable.
- [ ] Confirm `provider_paused` task survives Render restart (test after disk configured).
- [ ] Manual browser check at Vercel URL (optional; not claimed verified).

## 5. No destructive actions taken
- No DB overwritten/recreated.
- No workspace files moved/deleted.
- No `.env` change.
- No production settings changed.
- No push/deploy.
- No service restart.

MANUAL GUIDE — Render Persistent Disk Setup (Safe; Nothing Applied Yet)

IMPORTANT: Do NOT assume /data exists or contains anything. This guide instructs manual actions; no files changed automatically.

=== 1. Identify the Render service ===
- Log in to Render dashboard.
- Select the service named `myai-agent-malvic-backend` (or your backend service name matching the `vercel.json` Render URL).
- Confirm it is a Web Service running `node src/index.js` (or `npm start -w server`).
- Do NOT restart or redeploy yet.

=== 2. Back up existing data before any change ===
- From the Render dashboard, open a Shell (or download files via Render File System if available).
- Backup DB: `cp /app/server/data/app.db /tmp/app.db.backup-$(date +%F)` (or download to local machine using `scp` or Render's file download feature).
- Backup workspaces: `cp -r /app/server/workspaces /tmp/workspaces.backup-$(date +%F)`.
- Verify backup exists: `ls -l /tmp/app.db.backup-* /tmp/workspaces.backup-*`.
- Download backups to your local machine (`C:\Users\Malvic Moyo\OneDrive\Desktop\MyAI Agent`) before proceeding.
- Confirm `.env` secrets are preserved (Render Environment Variables section should list `AI_PROVIDER`, `AI_API_KEY` if used).

=== 3. Configure persistent disk ===
- In Render dashboard: Service → Settings → Disk.
- Click "Add Disk".
- Name: `myai-disk` (or any safe label).
- Mount Path: `/data` (this path will be mounted inside the service container; the server will access it via absolute path).
- Size: choose sufficient (e.g., 1GB) for DB + workspace growth.
- Click Save / Create.
- Note: This creates the disk but does NOT copy existing data into it.

=== 4. Verify current database/workspace paths ===
Before changing env vars, confirm the server resolves paths correctly:
- From a Render Shell (before redeploy), run:
  `node -e "import { config } from './server/src/config.js'; console.log('DB:', config.databasePath); console.log('WS:', config.workspaceRoot);"`
- Expected output (before env change): absolute paths pointing to `.../data/app.db` and `.../workspaces` inside `/app/` (or wherever the repo is deployed).
- Confirm `server/data/app.db` exists: `ls -l /app/server/data/app.db` (or the absolute equivalent shown by config).
- Confirm workspace contents: `ls /app/server/workspaces`.
- Do NOT assume `/data` has anything yet — it is empty initially.

=== 5. Copy data to persistent disk (manual, only after disk mounted) ===
Only after the disk is created AND before changing `DATABASE_PATH` / `WORKSPACE_ROOT`:
- From Render Shell:
  `cp /app/server/data/app.db /data/app.db`
  `cp -r /app/server/workspaces /data/workspaces`
- Verify copied data:
  `ls -l /data/app.db`
  `ls -l /data/workspaces`
  `sqlite3 /data/app.db "SELECT status FROM tasks WHERE status = 'provider_paused';"` (optional; verifies DB readable)
- Only after verification completes successfully: proceed to step 6.

=== 6. Set environment variables ===
In Render dashboard: Service → Environment.
Add (or edit) exactly these variables:
- `DATABASE_PATH` = `/data/app.db`
- `WORKSPACE_ROOT` = `/data/workspaces`
- Keep existing variables unchanged (`PORT`, `HOST`, `AI_PROVIDER`, `AI_API_KEY`, etc.).
- Do NOT set `DATABASE_PATH` or `WORKSPACE_ROOT` to relative paths (`./data/app.db`) unless the disk is mounted at `/app` (same as repo root) and you intend to keep the same relative path. The recommended absolute paths above (`/data/app.db`, `/data/workspaces`) work with mount path `/data`.
- Click Save.

=== 7. Verify after redeploy ===
Only redeploy after steps 2-6 complete and backups confirmed.
- After redeploy starts and service shows healthy:
  `node -e "import { config } from './server/src/config.js'; console.log('DB path:', config.databasePath); console.log('WS path:', config.workspaceRoot);"`
- Confirm output shows `/data/app.db` and `/data/workspaces`.
- Confirm existing data preserved:
  `sqlite3 /data/app.db ".mode table" "SELECT id, status FROM tasks WHERE status = 'provider_paused';"`
  `ls /data/workspaces`
- Confirm unfinished tasks survive: check `/data/app.db` for `provider_paused` rows matching previous test results.
- Confirm workspace files intact: compare directory listings with backup (`ls -R /data/workspaces` vs backup).
- Confirm services 3001 (local) and remote Render service both respond to `/api/health` without errors.

=== 8. Rollback / safety ===
If anything fails:
- Restore DB from backup: `cp /tmp/app.db.backup-* /data/app.db` (or to original server path).
- Restore workspaces from backup: `cp -r /tmp/workspaces.backup-*/* /data/workspaces/` (or to server/workspaces/).
- Revert env vars in Render dashboard to previous values (or remove them to fall back to `./data/app.db`).
- Restart service from Render dashboard.

=== What has NOT been done (per instructions)
- No Render disk created.
- No `.env` edited.
- No environment variables changed in Render or locally.
- No data copied/deleted/migrated.
- No services restarted or redeployed.
- No `server/src/index.js`, `server/src/config.js`, or `vercel.json` edited.
- No CORS middleware installed (separate request, not approved).
- No GitHub push or production deployment made.

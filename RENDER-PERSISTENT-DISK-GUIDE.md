MANUAL GUIDE — Render Persistent Disk Verification and Backup (Safe; nothing applied automatically)

CURRENT CONFIGURATION (verified 2026-11-12)
- Live backend URL: https://my-ai-agent-acqy.onrender.com
- The Render service name in the dashboard may differ from that hostname; match
  the service by its URL in the dashboard, not only by a guessed name.
- render.yaml mounts a 1 GB disk at /var/data and sets:
    DATABASE_PATH=/var/data/app.db
    WORKSPACE_ROOT=/var/data/workspaces
- Keep that mount path. Changing it requires migrating the database and
  workspaces first, otherwise the service starts with an empty database.
- Render's default filesystem is ephemeral; only files under the mounted disk
  survive restarts and redeploys.
- SQLite requires a single service instance. Do not scale the service to more
  than one instance while it uses this database file.
- Render disks are not a managed backup service. Copy the database and
  workspaces off the service periodically and keep those copies somewhere
  durable.

IMPORTANT: Do NOT assume /var/data exists or contains anything. These are manual
instructions; no files are changed automatically. Do not print, copy, or paste
API keys while following this guide.

=== 1. Identify the Render service ===
- Log in to the Render dashboard.
- Select the backend service whose URL is
  https://my-ai-agent-acqy.onrender.com (or confirm the current URL under the
  service's Settings).
- Confirm it is a Web Service started with:
    npm run start --workspace=server
- Confirm the health check path is /api/health.
- Do NOT restart or redeploy yet.

=== 2. Back up existing data before any change ===
- Open a Render Shell for the service.
- First confirm the paths the running code actually uses:
    node -e "import('./server/src/config.js').then(({config}) => { console.log('DB:', config.databasePath); console.log('WS:', config.workspaceRoot); })"
- Expected current output:
    DB: /var/data/app.db
    WS: /var/data/workspaces
- Back up the database:
    cp /var/data/app.db /tmp/app.db.backup-$(date +%F)
- Back up the workspaces:
    cp -r /var/data/workspaces /tmp/workspaces.backup-$(date +%F)
- Verify the backups exist:
    ls -l /tmp/app.db.backup-* /tmp/workspaces.backup-*
- Download the backups to your local machine before proceeding, if the files
  are needed. /tmp is not durable.
- If the paths printed by the node command are the old relative defaults under
  /app/server instead, use those exact paths as the backup source. Do not
  assume /var/data contains data before checking.

=== 3. Verify the persistent disk ===
- In the Render dashboard: Service -> Settings -> Disk.
- The service should have a disk mounted at /var/data with sufficient size
  (render.yaml requests 1 GB).
- If the disk is missing, add it at /var/data. The path must match the
  DATABASE_PATH and WORKSPACE_ROOT values below.
- Creating a disk does NOT copy existing files into it.

=== 4. Confirm environment variables ===
In the Render dashboard: Service -> Environment. Confirm:
- DATABASE_PATH = /var/data/app.db
- WORKSPACE_ROOT = /var/data/workspaces
- AI_PROVIDER = openai
- AI_API_KEY = (secret OpenRouter key; set in the dashboard only)
- AI_MODEL = (an OpenRouter model slug available to your account)
- OPENAI_BASE_URL = https://openrouter.ai/api/v1
- GEMINI_API_KEY = (secret Google AI key; optional, only for Gemini chat)
- GEMINI_MODEL = gemini-2.5-flash (optional)
- NODE_VERSION = 22
- Do not set PORT; Render injects it.
- Leave HOST unset so the server binds all interfaces.
- Keep DEBUG_CHAT_PROMPTS unset or false.
- Never place any of these values in the repository, vercel.json, or
  render.yaml. Secrets belong only in the dashboard.

=== 5. Copy existing data onto the disk (only if needed) ===
Only if the disk is newly created and the old data still exists under the
previous path:
- Stop writes first (do not run tasks or edit files during the copy).
- Copy the files:
    cp /app/server/data/app.db /var/data/app.db
    cp -r /app/server/workspaces /var/data/workspaces
- Verify the copy:
    ls -l /var/data/app.db
    ls -l /var/data/workspaces
- Make sure the copied database is not owned by a different user than the
  service process. If permissions look wrong, fix them before starting.
- Do not run two copies of the service against the same database.

=== 6. Deploy and verify ===
- Deploy the current revision (this is a dashboard action; no deployment is
  performed by this guide).
- Wait for the health check to pass at /api/health.
- Re-check the resolved paths:
    node -e "import('./server/src/config.js').then(({config}) => { console.log('DB path:', config.databasePath); console.log('WS path:', config.workspaceRoot); })"
- Confirm the output shows /var/data/app.db and /var/data/workspaces.
- Confirm the database is readable:
    ls -l /var/data/app.db
- Confirm workspaces are present:
    ls /var/data/workspaces
- Confirm unfinished tasks survive: check that previously queued or
  provider_paused rows are still present.
- Confirm workspace files match the backup listing (for example, compare
  `ls -R /var/data/workspaces` with the downloaded backup).
- Confirm /api/health reports the expected provider configuration without
  revealing any key values.

=== 7. Rollback / safety ===
If anything fails:
- Restore the database from the backup:
    cp /tmp/app.db.backup-* /var/data/app.db
- Restore workspaces from the backup:
    cp -r /tmp/workspaces.backup-*/* /var/data/workspaces/
- Revert environment variables in the Render dashboard to their previous
  values, or restore the relative defaults only if you intentionally want the
  ephemeral filesystem.
- Restart the service from the Render dashboard.
- Never delete the only copy of the database or workspaces during rollback.

=== 8. Ongoing backup policy ===
- Copy /var/data/app.db and /var/data/workspaces to durable storage on a
  schedule (for example, daily while the app is in active use).
- Keep at least one backup that predates the most recent deployment.
- Remember that Render disks are single-instance and are not a backup or
  high-availability service.

=== What has NOT been done (per instructions)
- No Render disk created or resized.
- No environment variables changed in Render or locally.
- No data copied, deleted, or migrated.
- No services restarted or redeployed.
- No API keys printed or exposed.
- No GitHub push or production deployment made.

# First-account bootstrap and disabling public registration

This procedure creates the first (administrator) account on a fresh
deployment and then closes public registration -- without ever blocking
initial account creation and without locking out existing accounts.

Applies to the Render deployment in `render.yaml` and to local self-hosting.
`BOOTSTRAP_TOKEN` is a shared secret between the operator and the server; it
is never logged, never stored in the browser, and never written into this
repository. `AUTH_SESSION_DAYS` and `ALLOW_REGISTRATION` are not secrets.

## Why the bootstrap token exists

Without it, a fresh deployment's sign-up page lets **anyone** who finds the
URL create the first account -- and that account silently adopts all
pre-authentication projects. The server therefore refuses to create the first
account unless the request carries `BOOTSTRAP_TOKEN`, compared in constant
time. This works even when `ALLOW_REGISTRATION=false`, so the flag can never
lock an operator out of their own initial account; only the first account is
protected, and only by the token.

- While the `users` table is empty: registration requires a correct
  `BOOTSTRAP_TOKEN`; if none is configured on the server, every attempt is
  refused (fail closed).
- After the first account exists: the token is ignored entirely and
  `ALLOW_REGISTRATION` alone governs new accounts.
- `POST /api/auth/login` and `GET /api/auth/me` never consult either setting;
  existing accounts can always sign in.
- The first account adopts pre-authentication projects (`owner_id IS NULL`).
  Later accounts never inherit anyone else's projects.

## Safe procedure on Render

1. **Before the first deploy -- generate a token.**
   Use a long random string (keep it out of the repository):

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   In the Render dashboard -> service -> Environment, create `BOOTSTRAP_TOKEN`
   with that value. `render.yaml` already declares `BOOTSTRAP_TOKEN` with
   `sync: false` (the blueprint carries no value -- you set it in the
   dashboard).

2. **Back up the database before deploying this version.**
   This release adds an `is_admin` column to `users` and runs an idempotent
   migration at startup. On a deployment that already has accounts, snapshot
   `/var/data/app.db` first (Render -> Disks -> download a snapshot, or copy
   the file) so the migration can be replayed or rolled back safely.

3. **Deploy, then register the first account.**
   Treat the setup URL below as a **secret link**: on a fresh deployment,
   anyone who holds it can create the first (administrator) account, so send
   it only to the administrator and never commit it, paste it into chat, or
   log it.

   Open the service URL with the token appended as a URL fragment:
   `https://<your-service-url>/#bootstrap=<token>`

   Fill in the administrator email and a strong unique password on the
   Create Account tab and submit. The fragment never travels to any server,
   proxy, CDN, or log, and never appears in a Referer header; the browser
   passes the token only into the registration request body, and it is
   removed from the address bar as soon as the page loads. The first account
   is created as the administrator; every later account is an ordinary user.

4. **Disable public registration.**
   In the Render dashboard -> Environment, set `ALLOW_REGISTRATION=false` and
   save (the service restarts). Existing sessions and future logins are
   unaffected. Registration now returns 403 for anyone else.

5. **Verify.**
   - Administrator sign-in -> works.
   - The sidebar shows the administrator account with an "Admin" badge.
   - On an upgraded database, confirm the intended account is the
     administrator (see "Upgrading a database that already has accounts"
     below) before closing registration.
   - New registration -> `403 "Registration is disabled on this server."`
   - `POST /api/auth/login` and `GET /api/auth/me` -> unaffected throughout.

6. **Remove the token and discard the setup URL.**
   After the first account exists, the token is never read again. Delete
   `BOOTSTRAP_TOKEN` from the Render environment entirely (leaving it set is
   also safe -- it is unused once an account exists), and stop sharing the
   setup URL; treat it as a secret for as long as the deployment stays fresh.

## Upgrading a database that already has accounts

This release adds an `is_admin` column to `users` and runs an idempotent
migration at startup, inside a single transaction:

1. If the column is missing, it is added (`ALTER TABLE users ADD COLUMN`);
   existing rows keep `is_admin = 0`.
2. The earliest account (`MIN(id)`) is promoted to administrator exactly
   once, and only while no administrator exists. If a previous boot was
   interrupted between the column add and the promotion, the next boot
   completes it instead of leaving a database with no administrator. An
   account that is already an administrator is never reassigned.

Two things operators must know:

- **"Earliest account" is a guess.** On a database that already held several
  accounts, the first row by `id` may not be the person who should be admin.
  The migration does not ask, and it never switches the admin to a different
  account once one is promoted.
- **Plan the fix out of band.** Before deploying, back up `/var/data/app.db`.
  After deploying, check the result:

  ```sql
  SELECT id, email, is_admin FROM users ORDER BY id;
  ```

  If the wrong account was promoted, correct it directly (it is read per
  request, so no restart is needed):

  ```sql
  UPDATE users SET is_admin = 0 WHERE id = <wrong-account-id>;
  UPDATE users SET is_admin = 1 WHERE id = <intended-account-id>;
  ```

  Keep the change minimal and do not add, delete, or reassign anything else.

## Emergency access

If the administrator account is lost:

1. Registering a brand-new account does **not** recover the lost account's
   data -- projects stay owned by the lost account id. Treat it as data loss
   and plan a restore.
2. As the operator with Render dashboard access and disk access to
   `/var/data/app.db`, reset or delete the account out-of-band (e.g. restore
   a known-good backup of `/var/data`), then sign in normally.
3. Only as a last resort and with full awareness of the impact, set
   `ALLOW_REGISTRATION=true` to let a replacement account register, then set
   it back to `false`. Document the intervention.

## Rules that must not be broken

- Never deploy an empty-database instance with `BOOTSTRAP_TOKEN` unset and
  expect the first account to register -- it will fail with 403 by design.
- Never commit `BOOTSTRAP_TOKEN`, `.env`, or database backups.
- Setting `ALLOW_REGISTRATION=false` before the first account exists does
  NOT lock out initial creation (the token governs it), but follow the
  documented order anyway to keep the process predictable.
- Keep `AUTH_SESSION_DAYS` small (default 30, max 365). If a session token
  is leaked, delete the `sessions` table; session tokens are stored hashed.

## Current defaults

- `ALLOW_REGISTRATION` defaults to `true` (after the first account exists,
  operators should flip it to `false` as documented above).
- `AUTH_SESSION_DAYS` defaults to `30` (max 365).
- `BOOTSTRAP_TOKEN` defaults to **empty** -- first-account registration is
  refused until one is configured, so a deployment can never come up open by
  accident.
- Login/register rate limiting is per client IP (one trusted proxy hop by
  default, see `TRUST_PROXY` in `.env.example`); a single attacker does not
  globally lock out all clients on a shared proxy.

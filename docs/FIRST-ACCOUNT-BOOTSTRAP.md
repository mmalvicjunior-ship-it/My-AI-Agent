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

2. **Deploy, then register the first account.**
   Open the service URL -> sign-up form -> fill in administrator email and a
   strong unique password, and paste the bootstrap token into the
   "Bootstrap token (first account only)" field. The token is sent only
   with this request and is not persisted anywhere.

3. **Disable public registration.**
   In the Render dashboard -> Environment, set `ALLOW_REGISTRATION=false` and
   save (the service restarts). Existing sessions and future logins are
   unaffected. Registration now returns 403 for anyone else.

4. **(Optional) Remove the token.**
   After the first account exists, the token is never read again. You may
   delete `BOOTSTRAP_TOKEN` from the environment entirely. Leaving it set is
   also safe -- it is unused once an account exists.

5. **Verify.**
   - Administrator sign-in -> works.
   - New registration -> `403 "Registration is disabled on this server."`
   - `POST /api/auth/login` and `GET /api/auth/me` -> unaffected throughout.

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

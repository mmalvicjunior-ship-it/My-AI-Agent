# First-account setup and administrator provisioning

This document describes the owner-controlled first-account gate and the separate
administrator provisioning flow. Ordinary users never see an administrator
control: the first account can be created with Google or email/password, but it
is always an ordinary user.

Applies to the Render deployment in `render.yaml` and to local self-hosting.
Two independent secrets are required:

| Secret | Accepted by | Purpose |
| --- | --- | --- |
| `FIRST_ACCOUNT_SETUP_TOKEN` | `POST /api/auth/setup/authorize` | Dedicated one-time first-account credential. It may appear only in the owner setup link fragment. |
| `BOOTSTRAP_TOKEN` | `POST /api/auth/admin/provision` | Owner-only administrator provisioning. It must never appear in a browser URL, request to Google, or frontend code. |

The two values must be different. If the setup credential is missing or the two
are identical, first-account setup and administrator provisioning both fail
closed with an owner-facing configuration message.

## Why this design

An earlier build made the first public account the administrator, so an unknown
visitor who found a fresh deployment could inherit administrative privileges
and pre-authentication projects. The two concepts are now separate:

- **First account creation** requires a short-lived authorization derived from
  the dedicated setup credential. It works for both email/password and Google,
  and always produces a normal user.
- **Later account creation** follows `ALLOW_REGISTRATION` as before.
- **Administrator creation** is a separate, owner-only server operation that
  accepts only `BOOTSTRAP_TOKEN`, never the setup credential.

No startup migration promotes an account to administrator. If a legacy database
already has one, it is preserved. If a legacy database somehow has several, the
migration demotes all but the earliest so the single-admin index can be
created; it never promotes a non-admin.

## Owner setup link

On a fresh deployment (`users` table empty), open the app once with the setup
credential in the URL fragment:

```text
https://<frontend-host>/#setup=<FIRST_ACCOUNT_SETUP_TOKEN>
```

Do **not** reuse `BOOTSTRAP_TOKEN` here. The browser behavior is deliberately
minimal:

1. `authFlow.js` reads and strips the `setup` fragment at module load, before
   React renders, using `history.replaceState`. Callback fragments are left for
   the ordinary Google callback runner.
2. `AuthScreen.jsx` exchanges that credential once through
   `POST /api/auth/setup/authorize` with body
   `{ "setupCredential": "<credential>" }`.
3. The server compares it in constant time with `FIRST_ACCOUNT_SETUP_TOKEN`,
   activates a 10-minute expiry on first use, and returns a random opaque setup
   grant. Only SHA-256 hashes of the credential and grant are persisted.
4. The grant is sent to `POST /api/auth/register` or bound to one server-side
   OAuth state before the browser leaves for Google. Google receives only the
   random `state` — never either secret or the opaque grant.
5. A grant is bound to at most one active OAuth flow. Starting another Google
   flow replaces the previous state. A failed callback does not consume the
   grant, so the owner can retry without reopening the setup link.
6. The grant and credential are consumed only after a first account is actually
   created. Missing, malformed, expired, consumed, or replayed values are
   rejected with a friendly error that never names or echoes a token.

The credential is not written to `localStorage`, `sessionStorage`, cookies,
logs, analytics, or generated frontend assets. The address bar shows it only
until the app module executes. Do not paste the setup link into chat, issues,
screenshots, or analytics.

## First-account rules

- `GET /api/auth/setup/status` is public and returns only
  `{ "ok": true, "required": true|false }`. It contains no secret.
- The setup link authorizes exactly one account, through either
  `POST /api/auth/register` or Google sign-in.
- Scrypt hashing completes before the database write transaction opens. The
  transaction rechecks first-account status, validates/consumes the grant, and
  inserts the user atomically in both SQLite and PostgreSQL.
- A Google-only account gets an unusable random password hash; password
  sign-in is impossible for it.
- Returning Google users sign in by stable `google_sub` and do not need a setup
  authorization, even when `ALLOW_REGISTRATION=false`.
- An existing email/password account is never auto-linked to a Google identity.
- Client-supplied role fields (`isAdmin`, `is_admin`, `admin`) are ignored on
  every public path.
- Pre-authentication projects are not claimed by an arbitrary first account;
  only the provisioned administrator adopts them.
- Credential-bearing responses set `Cache-Control: no-store`.

## Administrator provisioning endpoint

```text
POST /api/auth/admin/provision
Content-Type: application/json

{
  "bootstrapToken": "<BOOTSTRAP_TOKEN>",
  "email": "owner@example.com",
  "password": "a-long-unique-password"
}
```

Rules:

- `bootstrapToken` must match `BOOTSTRAP_TOKEN`, compared in constant time.
  Missing, wrong, or unconfigured tokens fail with `403`. A setup credential is
  never accepted here.
- The endpoint refuses every request once an administrator exists (`409`),
  even when the token is correct. There is no second administrator.
- To create a new password administrator, supply `email` and `password`.
  A session token is returned so the owner can sign in immediately.
- To promote an account that already signed in, supply `email` alone. The
  account's existing sessions stay valid and see the new role immediately.
- To promote an already verified Google account, supply `googleSub` (optionally
  with its matching `email`). A Google identity must have signed in at least
  once before it can be promoted.
- Client-supplied role fields are ignored.
- The endpoint is rate limited separately from public registration.
- Error messages are owner-facing and never include the token value.

The endpoint is intentionally not exposed in the frontend. The owner calls it
from a trusted shell or server-side automation, for example:

```powershell
Invoke-RestMethod -Method Post `
  -Uri 'https://<backend-host>/api/auth/admin/provision' `
  -Headers @{ 'Content-Type' = 'application/json' } `
  -Body (@{
    bootstrapToken = $env:MYAI_ADMIN_SETUP_TOKEN
    email = 'owner@example.com'
    password = 'a-long-unique-password'
  } | ConvertTo-Json)
```

Keep the token in an owner-controlled environment variable such as
`MYAI_ADMIN_SETUP_TOKEN`; do not paste it into source control, chat, browser
URLs, or analytics.

## Safe procedure on Render

1. **Set two different secrets before the first deploy.** Generate two long
   random strings and set `BOOTSTRAP_TOKEN` and `FIRST_ACCOUNT_SETUP_TOKEN` in
   the Render dashboard. `render.yaml` declares the administrator secret with
   `sync: false`, so the blueprint carries no value; add the setup secret in the
   dashboard as an owner-controlled `sync: false` variable.

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **Deploy with an empty user table.** Open the owner setup link once and
   create the first account with Google or email/password. Leave
   `ALLOW_REGISTRATION=true` if more accounts should be created later.
3. **Provision the administrator.** From a trusted shell, call
   `POST /api/auth/admin/provision` with `BOOTSTRAP_TOKEN` and either the email
   of an account that already exists or a new email/password pair.
4. **Verify.**
   - The promoted account sign-in works and shows the **Admin** badge.
   - A second provisioning attempt returns `409`.
   - Ordinary Google/password sign-up still works and shows **User**.
   - `GET /api/auth/me` reports the correct `isAdmin` value for each account.
5. **Close public registration if desired.** Set `ALLOW_REGISTRATION=false` in
   Render. Existing sessions and future logins are unaffected.
6. **Remove or rotate the secrets.** After provisioning, neither secret is
   needed for normal operation. Removing them is safe; the endpoint is closed
   by the single-admin guard anyway. Do not reuse either value elsewhere.

## Upgrading a database that already has accounts

The startup migration is intentionally conservative:

1. If the `is_admin` column is missing, it is added with `0` for every row.
2. No account is promoted, including the earliest account.
3. An existing administrator is preserved.
4. Multiple legacy administrators are reduced to one, so the
   `idx_users_single_admin` unique partial index can be enforced.
5. Setup-authorized OAuth states from an older build are discarded, and a unique
   partial index permits only one active setup-authorized state.

If you need to change which existing account is the administrator, do it
out-of-band after backing up the database:

```sql
UPDATE users SET is_admin = 0 WHERE is_admin = 1;
UPDATE users SET is_admin = 1 WHERE id = <intended-account-id>;
```

The role is read from the database on every request, so no restart is required.

## Emergency access

If the administrator account is lost:

1. Ordinary registration does **not** recover that account's data; projects
   stay owned by the lost account id. Plan a restore.
2. As the operator with Render dashboard/disk access, restore a known-good
   backup or repair the account out-of-band.
3. If no administrator exists at all, the provisioning endpoint can be used
   again with `BOOTSTRAP_TOKEN`. Document the intervention.

## Rules that must not be broken

- Never send either secret or the setup grant to Google.
- Never write a secret to logs, browser storage, analytics, or source control.
- Never grant admin from `/register`, `/login`, `/google/start`, the Google
  callback, or the setup exchange.
- Never accept `BOOTSTRAP_TOKEN` as a first-account setup credential.
- Never rely on a startup migration to choose an administrator.
- Keep exactly one administrator via `idx_users_single_admin`.
- Keep `AUTH_SESSION_DAYS` small (default 30, max 365). Session tokens are
  stored hashed; deleting the `sessions` table revokes all sessions.

## Remaining limitations

- The setup credential is carried once in a browser fragment. Stripping happens
  before React renders, but a browser extension or screenshot taken during
  initial navigation could still observe it. Treat the link as sensitive.
- The 10-minute expiry starts on the first successful exchange. If it expires
  before an account is created, configure a new `FIRST_ACCOUNT_SETUP_TOKEN`.
- A failed Google callback leaves the grant retryable, but its expiry is not
  extended by the retry. A new OAuth state inherits the grant's remaining time.

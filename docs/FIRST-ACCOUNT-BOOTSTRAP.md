# Administrator provisioning

This document describes the owner-controlled first-administrator flow. Ordinary
users never see any of it: Google sign-in and password sign-up work normally on
a fresh deployment and always create **ordinary** accounts.

Applies to the Render deployment in `render.yaml` and to local self-hosting.
`BOOTSTRAP_TOKEN` is a shared secret between the owner and the server. It is
never logged, never stored in the browser, never placed in a URL, and never
committed to this repository.

## Why this design

An earlier build made the first public account the administrator. That meant an
unknown visitor who found a fresh deployment could inherit administrative
privileges and pre-authentication projects. The redesign separates the two
concepts:

- **Account creation** is public (subject to `ALLOW_REGISTRATION`) and always
  produces a normal user.
- **Administrator creation** is a separate, owner-only server operation that
  reuses the existing `BOOTSTRAP_TOKEN`.

No startup migration promotes an account to administrator. If a legacy database
already has one, it is preserved. If a legacy database somehow has several, the
migration demotes all but the earliest so the single-admin index can be
created; it never promotes a non-admin.

## The provisioning endpoint

```text
POST /api/auth/admin/provision
Content-Type: application/json

{
  "bootstrapToken": "<server secret>",
  "email": "owner@example.com",
  "password": "a-long-unique-password"
}
```

Rules:

- `bootstrapToken` must match the server-side `BOOTSTRAP_TOKEN`, compared in
  constant time. Missing, wrong, or unconfigured tokens fail with `403`.
- The endpoint refuses every request once an administrator exists (`409`),
  even when the token is correct. There is no second administrator.
- To create a new password administrator, supply `email` and `password`.
  A session token is returned so the owner can sign in immediately.
- To promote an account that already signed in, supply `email` alone. The
  account's existing sessions stay valid and see the new role immediately.
- To promote an already verified Google account, supply `googleSub` (optionally
  with its matching `email`). A Google identity must have signed in at least
  once before it can be promoted.
- Client-supplied role fields (`isAdmin`, `is_admin`, `admin`) are ignored.
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

1. **Set the token before the first deploy.** Generate a long random string and
   set `BOOTSTRAP_TOKEN` in the Render dashboard. `render.yaml` declares it
   with `sync: false`, so the blueprint carries no value.

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **Deploy and let users sign in normally.** Leave `ALLOW_REGISTRATION=true`
   while accounts are being created. Google sign-in needs no setup URL, token,
   fragment, or special browser state.

3. **Provision the administrator.** From a trusted shell, call
   `POST /api/auth/admin/provision` with the token and either the email of an
   account that already exists or a new email/password pair.

4. **Verify.**
   - The promoted account sign-in works and shows the **Admin** badge.
   - A second provisioning attempt returns `409`.
   - Ordinary Google/password sign-up still works and shows **User**.
   - `GET /api/auth/me` reports the correct `isAdmin` value for each account.

5. **Close public registration if desired.** Set `ALLOW_REGISTRATION=false` in
   Render. Existing sessions and future logins are unaffected.

6. **Remove or rotate the token.** After provisioning, the token is no longer
   needed for normal operation. Removing it is safe; the endpoint is closed by
   the single-admin guard anyway. Do not reuse the value elsewhere.

## Upgrading a database that already has accounts

The startup migration is intentionally conservative:

1. If the `is_admin` column is missing, it is added with `0` for every row.
2. No account is promoted, including the earliest account.
3. An existing administrator is preserved.
4. Multiple legacy administrators are reduced to one, so the
   `idx_users_single_admin` unique partial index can be enforced.

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
   again with the token. Document the intervention.

## Rules that must not be broken

- Never put the token in a browser URL, fragment, or frontend bundle.
- Never grant admin from `/register`, `/login`, `/google/start`, or the Google
  callback.
- Never rely on a startup migration to choose an administrator.
- Keep exactly one administrator via `idx_users_single_admin`.
- Keep `AUTH_SESSION_DAYS` small (default 30, max 365). Session tokens are
  stored hashed; deleting the `sessions` table revokes all sessions.

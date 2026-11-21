# Google sign-in / sign-up

Optional OAuth 2.0 sign-in with Google, added on top of email/password
authentication. When the three `GOOGLE_*` variables are set, a
"Continue with Google" button appears on the sign-in/registration screen;
when they are not set, nothing changes and the button is never shown.

Google sign-in is a normal user flow. It needs no bootstrap token, setup URL,
URL fragment, or developer configuration from the person signing in.

## How it works (server-side authorization-code flow)

1. The browser calls `POST /api/auth/google/start` with an empty JSON body. The
   server creates a random one-time `state`, stores only its SHA-256 hash with a
   10-minute expiry, and returns Google's consent-screen URL. The frontend
   navigates there immediately.
2. Google redirects the browser back to the server callback
   `GET /api/auth/google/callback?code=...&state=...`.
3. The server exchanges the code for tokens (server-to-server, client secret
   never leaves the backend), then validates the identity with Google's own
   `tokeninfo` endpoint: audience must equal the client ID, issuer must be
   Google, `email_verified` must be true, and `sub`/`email` must be present.
   The email is taken only from Google's response — never from the frontend.
4. The server looks up the account by `google_sub`, or creates a new ordinary
   account, then issues the same bearer session token as email/password login.
   An administrator is never created here; see
   `docs/FIRST-ACCOUNT-BOOTSTRAP.md` for owner-only provisioning.
5. The browser lands back on the app with the token in the URL fragment
   (`#auth_token=...&auth_expires=...`), which the SPA verifies with
   `/api/auth/me` before applying. Fragments are never sent to any server, so
   the session token cannot appear in Vercel, Render, proxy, CDN, or
   application logs. Failures return as `#auth_error=<code>` and are shown as
   friendly application-level messages.

### Account rules

- Same Google `sub` -> normal sign-in; no duplicate accounts are created.
- An email that already exists as an email/password account is NOT linked
  automatically; the user is told the account exists and can sign in with
  their password instead (`google_account_exists`).
- A different Google `sub` claiming an email that is already linked to another
  Google identity is rejected (`google_identity_conflict`).
- Google-created accounts are **never** administrators, including the first
  account on a fresh deployment.
- Google registration respects `ALLOW_REGISTRATION=false`
  (`google_registration_disabled`); login for existing accounts is unaffected.
- Google-only accounts get an unusable password hash, so password sign-in is
  impossible for them.

## Google Cloud Console setup

Do this once per Google Cloud project. You need the exact redirect URI from
step 3 before creating the client ID.

1. Open https://console.cloud.google.com/ and pick (or create) the project
   that represents this app.
2. **APIs & Services -> OAuth consent screen**: choose External (or Internal if
   the app is only for your organization), fill in the app name, and add your
   own email under Test users while the app stays unverified.
3. Decide the authorized redirect URI. The recommended, same-origin form —
   which works through the existing Vercel rewrite of `/api/*` to the Render
   backend and through the Vite dev proxy — is:

   ```
   https://<your-vercel-app-url>/api/auth/google/callback
   ```

   Replace `<your-vercel-app-url>` with the deployed frontend host (no path
   suffix, no trailing slash, exact match including the scheme). For local
   development use `http://localhost:5173/api/auth/google/callback`.
4. **APIs & Services -> Credentials -> Create Credentials -> OAuth client ID**,
   type **Web application**. Under "Authorized redirect URIs" add exactly the
   URI from step 3 (add the localhost one too if you develop locally).
5. Copy the client ID and client secret. Put them in the Render backend
   environment and deploy again. Never commit them; never paste them into the
   frontend, into Vercel environment variables, or into chat/logs.

## Environment variables

All four belong on the backend (Render). Nothing Google-related needs to be
set on Vercel, because the frontend only ever calls same-origin `/api/...`
paths. `APP_ORIGIN` is the one exception and is usually unnecessary.

| Variable | Required | Where | Meaning |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Yes for Google login | Render | OAuth 2.0 client ID (Web application). |
| `GOOGLE_CLIENT_SECRET` | Yes for Google login | Render | OAuth 2.0 client secret. Server-side only. |
| `GOOGLE_OAUTH_REDIRECT_URI` | Yes for Google login | Render | Must exactly match an authorized redirect URI from step 4 above. |
| `APP_ORIGIN` | No | Render | Base URL used in the callback redirect (e.g. `https://example.com`). Empty = same-origin relative redirect, which is what you want with the Vercel rewrite. Set it only if the callback is reached on a different origin than the frontend. Must be an absolute https origin with no credentials, path, query or fragment (http: is accepted only for localhost development); invalid values fail startup closed. |

## Local development

- Run the backend with the three Google variables set (`.env` in `server/`),
  using `GOOGLE_OAUTH_REDIRECT_URI=http://localhost:5173/api/auth/google/callback`
  (the Vite dev server proxies `/api` to the backend port).
- Register `http://localhost:5173/api/auth/google/callback` in the Google
  Cloud Console client as well; a client ID may list several redirect URIs.

## Troubleshooting

The callback redirects to `/#auth_error=<code>` with these codes. The browser
shows a friendly message for each one; these names are internal diagnostics
only.

| Code | User-facing meaning |
| --- | --- |
| `google_not_configured` | Google sign-in is temporarily unavailable. |
| `google_cancelled` | The user cancelled on Google's consent screen. |
| `google_state` | The sign-in link expired or was already used; try again. |
| `google_identity_invalid` | Google identity could not be verified. |
| `google_unverified_email` | A verified Google email address is required. |
| `google_account_exists` | An email/password account already uses that email. |
| `google_identity_conflict` | That Google account is linked to a different account. |
| `google_registration_disabled` | New accounts are not being accepted right now. |
| `google_unavailable` | Google sign-in is temporarily unavailable. |

import React, { useState, useEffect } from 'react';
import { extractBootstrapToken } from './bootstrapToken.js';

// Friendly descriptions for the machine-readable error codes the Google
// callback uses in its redirect fragment (#auth_error=<code>).
const GOOGLE_ERRORS = {
  google_not_configured: 'Google sign-in is not configured on this server.',
  google_bootstrap_required: 'Creating the first account requires the server bootstrap token. Open the setup URL (#bootstrap=<token>) first.',
  google_registration_disabled: 'Registration is disabled on this server. Ask the administrator for an account.',
  google_account_exists: 'An account with this email already exists. Sign in with your password instead.',
  google_identity_conflict: 'This Google identity is already linked to a different account.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_state: 'That sign-in link expired or was already used. Please try again.',
  google_unverified_email: 'Your Google account email address is not verified.',
  google_unavailable: 'Google sign-in is unavailable right now. Please try again later.',
  google_identity_invalid: 'Google identity could not be verified. Please try again.',
};

/**
 * Sign-in / registration screen shown before the workspace loads.
 * The backend issues a bearer token; App.jsx stores it and attaches it to
 * every /api request. No token or password is ever written to logs.
 *
 * The bootstrap token may be provided via the URL fragment
 * #bootstrap=<token> for initial setup (first account only). Fragments never
 * reach any server, so the token cannot appear in any access log. It is read
 * automatically and can still be entered manually when no setup URL is used.
 *
 * The Google sign-in flow starts with POST /api/auth/google/start and returns
 * the user here with the session token in the URL fragment (#auth_token=...),
 * for the same reason: fragments never travel to any server or log.
 */
export default function AuthScreen({ apiBase = '', onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const isRegister = mode === 'register';

  // Read the URL fragment exactly once on mount: it may carry the one-time
  // bootstrap token (#bootstrap=...) or the result of the Google flow
  // (#auth_token=... / #auth_error=...). Whatever it holds, strip it from the
  // address bar as early as possible so it is not kept in browser history or
  // bookmarks.
  const [urlBootstrapToken, setUrlBootstrapToken] = useState('');
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || hash.length < 2) return undefined;
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    const authToken = params.get('auth_token');
    const authError = params.get('auth_error');
    const authExpires = params.get('auth_expires') || undefined;
    const fragmentBootstrapToken = extractBootstrapToken(hash);
    // Remove the fragment from the address bar now.
    window.history.replaceState({}, '', window.location.pathname + window.location.search);

    if (fragmentBootstrapToken) setUrlBootstrapToken(fragmentBootstrapToken);
    if (authError) setError(GOOGLE_ERRORS[authError] || 'Google sign-in failed. Please try again.');
    if (!authToken) return undefined;

    // Verify the fragment-carried session token against the trusted backend
    // before accepting it, then hand it to the app exactly like a password
    // login. No frontend copy of the user record is trusted.
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${apiBase}/api/auth/me`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok || !data.user) throw new Error('Could not verify the Google session.');
        if (!cancelled) onAuthenticated(authToken, data.user, authExpires);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Google sign-in could not be completed.');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchMode = (next) => {
    if (busy) return;
    setMode(next);
    setError(null);
    setPassword('');
    setShowPassword(false);
  };

  const startGoogle = async () => {
    setError(null);
    setGoogleBusy(true);
    try {
      const body = {};
      const token = bootstrapToken.trim() || urlBootstrapToken.trim();
      if (token) body.bootstrapToken = token;
      const response = await fetch(`${apiBase}/api/auth/google/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok || !result.url) {
        throw new Error(result.error || 'Could not start Google sign-in.');
      }
      window.location.assign(result.url);
    } catch (err) {
      setError(err.message || 'Could not start Google sign-in.');
      setGoogleBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      // Build the request body: always include email and password. If this is
      // registration and a bootstrap token was provided (manually or via the
      // setup URL fragment), include it automatically.
      const body = { email: email.trim(), password };
      const token = bootstrapToken.trim() || urlBootstrapToken.trim();
      if (isRegister && token) body.bootstrapToken = token;

      const response = await fetch(`${apiBase}/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok || !result.token) {
        throw new Error(result.error || `Request failed (${response.status})`);
      }
      setBootstrapToken('');
      onAuthenticated(result.token, result.user, result.expiresAt);
    } catch (err) {
      setError(err.message || 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <section className="auth-aside" aria-label="About MyAI">
        <div className="auth-aside-brand">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <span>myai<span className="brand-dot">.</span></span>
        </div>
        <div className="auth-aside-copy">
          <span className="auth-aside-eyebrow">AI coding workspace</span>
          <h2>Describe it.<br />Plan it.<br /><span>Ship it.</span></h2>
          <p>Work on a real project with an agent that inspects files, proposes changes and asks before it writes or runs anything.</p>
        </div>
        <ul className="auth-points">
          <li><span>01</span> Private projects and conversations</li>
          <li><span>02</span> Approval-gated edits and commands</li>
          <li><span>03</span> Inspect, plan, build and test in one place</li>
        </ul>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-brand">
            <span className="brand-mark" aria-hidden="true">✦</span>
            <span>myai<span className="brand-dot">.</span></span>
          </div>
          <h1>{isRegister ? 'Create your account' : 'Welcome back'}</h1>
          <p className="auth-subtitle">
            {isRegister
              ? 'Your projects and conversations stay private to this account.'
              : 'Sign in to continue to your workspaces.'}
          </p>

          <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              aria-selected={!isRegister}
              className={!isRegister ? 'active' : ''}
              onClick={() => switchMode('login')}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isRegister}
              className={isRegister ? 'active' : ''}
              onClick={() => switchMode('register')}
            >
              Register
            </button>
          </div>

          <button type="button" className="auth-google" onClick={startGoogle} disabled={googleBusy || busy}>
            {googleBusy ? (
              <span className="auth-google-spinner" aria-hidden="true" />
            ) : (
              <svg className="auth-google-mark" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
                <path fill="#FF3D00" d="M6.306 14.691 12.88 19.51C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
                <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 12 24c0-1.013.21-1.98.583-2.84l-6.573-5.089C5.778 18.624 4 21.185 4 24c0 11.045 8.955 20 20 20z" />
                <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
              </svg>
            )}
            <span>{googleBusy ? 'Redirecting to Google…' : 'Continue with Google'}</span>
          </button>
          <div className="auth-divider" aria-hidden="true"><span>or</span></div>

          <form className="auth-form" onSubmit={submit}>
            <label>
              <span>Email</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                disabled={busy}
                required
              />
            </label>
            <label>
              <span>Password</span>
              <div className="auth-password">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={isRegister ? 'At least 8 characters' : 'Your password'}
                  disabled={busy}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
            {isRegister && (
              <label>
                <span>Bootstrap token <em className="auth-optional">(first account only)</em></span>
                <input
                  type="password"
                  autoComplete="off"
                  value={bootstrapToken}
                  onChange={(event) => setBootstrapToken(event.target.value)}
                  placeholder="From the BOOTSTRAP_TOKEN server environment variable"
                  disabled={busy}
                />
              </label>
            )}

            {isRegister && urlBootstrapToken && (
              <div className="auth-bootstrap-hint">
                <span>Bootstrap token auto-injected from setup URL.</span>
              </div>
            )}

            {error && <div className="auth-error" role="alert">{error}</div>}

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
            </button>
          </form>

          <p className="auth-note">
            {isRegister
              ? 'The very first account requires the server bootstrap token and adopts projects created before accounts were enabled.'
              : 'Sessions stay signed in across refreshes and can be ended with Sign out.'}
          </p>
        </div>
      </section>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { extractBootstrapToken, stripBootstrapFromFragment } from './bootstrapToken.js';

// Friendly descriptions for the machine-readable error codes the Google
// callback uses in its redirect fragment (#auth_error=<code>).
// In-memory only: survives React remounts for the lifetime of the page, but is
// never written to storage or sent anywhere except the bootstrap request body.
let pendingBootstrapToken = '';

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
 * automatically from the operator's setup URL and is never shown in the form,
 * so ordinary users are never asked for an administrator secret.
 *
 * The Google sign-in flow starts with POST /api/auth/google/start and returns
 * the user here with the session token in the URL fragment (#auth_token=...),
 * for the same reason: fragments never travel to any server or log.
 */
export default function AuthScreen({ apiBase = '', onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const isRegister = mode === 'register';

  // The URL fragment may carry the one-time bootstrap token (#bootstrap=...)
  // or the result of the Google flow (#auth_token=... / #auth_error=...).
  // The bootstrap value is moved into memory and the fragment is stripped as
  // soon as it is seen, so it is never kept in the address bar.
  const [urlBootstrapToken, setUrlBootstrapToken] = useState('');

  // A setup link pasted into an already open tab only fires hashchange; it does
  // not remount this component. Capture the token on mount and on every hash
  // change, then read it from memory when the setup request is made.
  function captureBootstrapFragment() {
    const token = extractBootstrapToken(window.location.hash);
    if (!token) return;
    pendingBootstrapToken = token;
    setUrlBootstrapToken(token);

    const remaining = stripBootstrapFromFragment(window.location.hash);
    if (remaining !== window.location.hash && window.history?.replaceState) {
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}${remaining}`);
    }
  }

  function bootstrapTokenFromLocation() {
    return pendingBootstrapToken || urlBootstrapToken;
  }

  function clearBootstrapFromLocation() {
    pendingBootstrapToken = '';
    setUrlBootstrapToken('');
    const remaining = stripBootstrapFromFragment(window.location.hash);
    if (remaining === window.location.hash || !window.history?.replaceState) return;
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}${remaining}`);
  }

  useEffect(() => {
    let cancelled = false;
    let handledAuthToken = false;

    const processFragment = () => {
      const hash = window.location.hash;
      if (!hash || hash.length < 2) return;
      const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
      const authToken = params.get('auth_token');
      const authError = params.get('auth_error');
      const authExpires = params.get('auth_expires') || undefined;

      captureBootstrapFragment();
      if (authError) setError(GOOGLE_ERRORS[authError] || 'Google sign-in failed. Please try again.');
      if (!authToken || handledAuthToken) return;

      // An OAuth callback token is consumed immediately. A bootstrap token was
      // captured into memory above and already removed from the address bar.
      handledAuthToken = true;
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);

      // Verify the fragment-carried session token against the trusted backend
      // before accepting it, then hand it to the app exactly like a password
      // login. No frontend copy of the user record is trusted.
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
    };

    processFragment();
    window.addEventListener('hashchange', processFragment);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', processFragment);
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
      const token = bootstrapTokenFromLocation();
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
      clearBootstrapFromLocation();
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
      // Build the request body: always include email and password. Only the
      // operator's setup URL may inject the first-account bootstrap token.
      const body = { email: email.trim(), password };
      const token = bootstrapTokenFromLocation();
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
      clearBootstrapFromLocation();
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
            {isRegister && urlBootstrapToken && (
              <div className="auth-bootstrap-hint">
                <span>First-account setup detected. Your administrator secret will be applied automatically.</span>
              </div>
            )}

            {error && <div className="auth-error" role="alert">{error}</div>}

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
            </button>
          </form>

          <p className="auth-note">
            {isRegister
              ? 'New accounts can use Google or email and password. Projects created before accounts existed are adopted by the first account.'
              : 'Sessions stay signed in across refreshes and can be ended with Sign out.'}
          </p>
        </div>
      </section>
    </div>
  );
}

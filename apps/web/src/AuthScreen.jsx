import React, { useState } from 'react';

/**
 * Minimal sign-in / registration screen shown before the workspace loads.
 * The backend issues a bearer token; App.jsx stores it and attaches it to
 * every /api request. No token or password is ever written to logs.
 */
export default function AuthScreen({ apiBase = '', onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  const switchMode = (next) => {
    if (busy) return;
    setMode(next);
    setError(null);
    setPassword('');
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
      const body = { email: email.trim(), password };
      if (isRegister && bootstrapToken.trim()) body.bootstrapToken = bootstrapToken.trim();
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
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <span>myai<span className="brand-dot">.</span></span>
        </div>
        <h1>{isRegister ? 'Create your account' : 'Welcome back'}</h1>
        <p className="auth-subtitle">
          {isRegister
            ? 'Your projects and workspaces stay private to this account.'
            : 'Sign in to continue to your private workspaces.'}
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
            <input
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={isRegister ? 'At least 8 characters' : 'Your password'}
              disabled={busy}
              required
            />
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

          {error && <div className="auth-error" role="alert">{error}</div>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="auth-note">
          {isRegister
            ? 'The very first account requires the server bootstrap token and adopts projects created before accounts were enabled.'
            : 'Sessions expire automatically and can be ended with Sign out.'}
        </p>
      </div>
    </div>
  );
}

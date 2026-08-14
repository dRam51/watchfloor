import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from './AuthContext.tsx';

/**
 * Blocks rendering of `children` until a token has been entered. Submitting
 * only stores the value in memory (AuthContext) -- this component does not
 * itself validate the token against the API. The first real request either
 * succeeds or comes back 401, at which point the caller is expected to
 * clear the token (see web/src/App.tsx), which un-mounts `children` and
 * shows this gate again.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { token, setToken } = useAuth();
  const [draft, setDraft] = useState('');

  if (token) return <>{children}</>;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (trimmed.length > 0) setToken(trimmed);
  }

  return (
    <main className="auth-gate">
      <form className="auth-gate__form" onSubmit={handleSubmit}>
        <label className="auth-gate__label" htmlFor="wf-token">
          Watchfloor API token
        </label>
        <input
          id="wf-token"
          className="auth-gate__input touch-target"
          type="password"
          autoComplete="off"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button className="auth-gate__submit touch-target" type="submit">
          Connect
        </button>
        <p className="auth-gate__hint">
          Held in memory for this tab only. Never stored, never sent anywhere but this server.
        </p>
      </form>
    </main>
  );
}

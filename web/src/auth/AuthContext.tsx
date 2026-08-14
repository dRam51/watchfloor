import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface AuthContextValue {
  token: string | null;
  setToken: (token: string | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Holds WF_API_TOKEN in memory only, for this tab's lifetime -- never
 * localStorage, sessionStorage, or a cookie. See the task 7 report's
 * "browser authentication" section for the full reasoning; in short:
 *
 * - The built bundle is static JS anyone who can reach this host can read,
 *   so the token can never be a literal baked into it (import.meta.env
 *   substitution included -- that is still a literal in the shipped file).
 * - src/api/auth.ts (out of scope for this task) is the only thing that
 *   decides what counts as authorized, and it accepts exactly one shape --
 *   `Authorization: Bearer <token>` on every request except /health -- so
 *   there is no cookie-based alternative available without editing a file
 *   this task is not allowed to touch.
 * - §7.1 already bans browser storage for read/saved/dismissed state. This
 *   project treats the API credential itself as at least as sensitive as
 *   that (arguably more -- it is the one secret this frontend ever holds),
 *   so the same rule is applied here even though the brief did not
 *   literally require it for the token.
 *
 * The trade-off: a page reload clears the token and AuthGate asks again.
 * That is deliberate, not an oversight -- a token with no legitimate reason
 * to survive a reload should not get to. If that proves too annoying for
 * daily use, the fix is an explicit, opt-in "remember for this session"
 * checkbox backed by sessionStorage -- NOT silently switching the default.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const value = useMemo(() => ({ token, setToken }), [token]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

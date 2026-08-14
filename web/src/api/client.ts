/**
 * Every fetch the SPA makes goes through here, so "attach the bearer token"
 * happens in exactly one place rather than at each call site. See
 * web/src/auth/AuthContext.tsx for why `token` is a required parameter
 * rather than something this module reads from storage itself: it is held
 * in memory by React state and passed in explicitly, never persisted.
 *
 * Paths are relative ('/dashboard/header', not an absolute URL) because in
 * every environment this app runs in -- `vite` dev server or `vite
 * preview` -- the real API is reached through that server's own proxy
 * config (see vite.config.ts), never called cross-origin directly. See the
 * task 7 report for why the API itself is never the one serving these
 * static files.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    // src/api/auth.ts deliberately returns the same 401 for "missing" and
    // "wrong" token (no oracle distinguishing the two) -- this client does
    // not try to guess which; callers treat any non-2xx here as "this
    // request did not go through" and decide what to do (AuthGate's caller
    // clears the token and asks again on 401 specifically).
    throw new ApiError(`${path} responded ${response.status}`, response.status);
  }

  return (await response.json()) as T;
}

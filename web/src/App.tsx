import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext.tsx';
import { AuthGate } from './auth/AuthGate.tsx';
import { apiFetch, ApiError } from './api/client.ts';
import { Stream } from './components/Stream.tsx';
import { LaneBoard } from './components/LaneBoard.tsx';
import { useIsWideViewport } from './lib/viewport.ts';

/**
 * Shape of GET /api/dashboard/header (src/api/routes/dashboard.ts, M3 task 6).
 * Deliberately loose (`enrichmentSpend: unknown`) -- this task only needs
 * enough of the shape to prove the fetch path works end to end; a full
 * typed client is later tasks' concern, not scaffolding's.
 */
interface DashboardHeader {
  beats: Record<string, { lastRefreshAt: string | null; sourceCount: number }>;
  failingSources: number;
  enrichmentSpend: unknown;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: DashboardHeader };

function Dashboard() {
  const { token, setToken } = useAuth();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // §7.1: "Build the merged-stream view first and treat lanes as the
  // wide-viewport arrangement of it" -- exactly one of Stream/LaneBoard is
  // ever mounted (never both), so there is only ever one keyboard listener
  // and one set of live feed requests on the page at a time. ~700px per the
  // M3 task 10 brief; see lib/viewport.ts for why the guarded default is
  // narrow (Stream) rather than wide.
  const isWide = useIsWideViewport();

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setState({ status: 'loading' });

    apiFetch<DashboardHeader>('/api/dashboard/header', token)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A 401 means the token this tab is holding didn't work -- forget
        // it and let AuthGate ask again, rather than looping the same
        // failing request every render.
        if (error instanceof ApiError && error.status === 401) {
          setToken(null);
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'unknown error',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [token, setToken]);

  const beatCount = state.status === 'ready' ? Object.keys(state.data.beats).length : null;
  const sourceTotal =
    state.status === 'ready'
      ? Object.values(state.data.beats).reduce((sum, beat) => sum + beat.sourceCount, 0)
      : null;

  return (
    <main className="shell">
      <header className="shell__header">
        <h1 className="shell__title">WATCHFLOOR</h1>
        <p className="shell__subtitle">situational awareness -- six beats, one wall</p>
      </header>

      <section className="shell__status" aria-live="polite">
        {state.status === 'loading' && <p>connecting to api&hellip;</p>}
        {state.status === 'error' && (
          <p className="shell__status--error">api error: {state.message}</p>
        )}
        {state.status === 'ready' && (
          <p>
            {beatCount} beats configured &middot; {sourceTotal} sources tracked &middot;{' '}
            {state.data.failingSources} failing
          </p>
        )}
      </section>

      {/* `token` is narrowed to `string` here by the `&&` guard -- AuthGate
          only renders Dashboard once a token exists, but that fact isn't
          visible to the type checker from here, so this makes it explicit
          rather than asserting it away. */}
      {token &&
        (isWide ? (
          <LaneBoard token={token} onUnauthorized={() => setToken(null)} />
        ) : (
          <Stream token={token} onUnauthorized={() => setToken(null)} />
        ))}
    </main>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <Dashboard />
      </AuthGate>
    </AuthProvider>
  );
}

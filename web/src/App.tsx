import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext.tsx';
import { AuthGate } from './auth/AuthGate.tsx';
import { apiFetch, ApiError } from './api/client.ts';
import { Stream } from './components/Stream.tsx';
import { LaneBoard } from './components/LaneBoard.tsx';
import { SearchView } from './components/SearchView.tsx';
import { SourceHealthPage } from './components/SourceHealthPage.tsx';
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

/**
 * Which of the three views is showing. Deliberately a small union in state
 * rather than a router: the app has three views, and adding a routing
 * dependency for that is not justified (M3 task 11's brief said as much).
 *
 * `search` and `sources` were built standalone by task 11 while task 10 owned
 * App.tsx for the six-lane layout -- the same central-wiring pattern Wave 2's
 * routes used, where parallel tasks each export a component and one commit
 * mounts them.
 */
type View = 'items' | 'search' | 'sources';

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
  const [view, setView] = useState<View>('items');

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

      <nav className="shell__nav" aria-label="views">
        {/* Visible and tappable, not hover-revealed (§7.1). `/` also opens
            search, but the health page has no shortcut in §7's key list, so
            a pointer affordance is its only route in. */}
        <button
          type="button"
          className={`shell__nav-button${view === 'items' ? ' shell__nav-button--active' : ''}`}
          aria-current={view === 'items' ? 'page' : undefined}
          onClick={() => setView('items')}
        >
          items
        </button>
        <button
          type="button"
          className={`shell__nav-button${view === 'search' ? ' shell__nav-button--active' : ''}`}
          aria-current={view === 'search' ? 'page' : undefined}
          onClick={() => setView('search')}
        >
          search <kbd>/</kbd>
        </button>
        <button
          type="button"
          className={`shell__nav-button${view === 'sources' ? ' shell__nav-button--active' : ''}`}
          aria-current={view === 'sources' ? 'page' : undefined}
          onClick={() => setView('sources')}
        >
          source health
          {state.status === 'ready' && state.data.failingSources > 0 && (
            <span className="shell__nav-badge">{state.data.failingSources}</span>
          )}
        </button>
      </nav>

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
      {token && view === 'search' && (
        <SearchView
          token={token}
          onUnauthorized={() => setToken(null)}
          onClose={() => setView('items')}
        />
      )}

      {token && view === 'sources' && (
        <SourceHealthPage
          token={token}
          onUnauthorized={() => setToken(null)}
          onClose={() => setView('items')}
        />
      )}

      {token &&
        view === 'items' &&
        (isWide ? (
          <LaneBoard
            token={token}
            onUnauthorized={() => setToken(null)}
            onOpenSearch={() => setView('search')}
          />
        ) : (
          <Stream
            token={token}
            onUnauthorized={() => setToken(null)}
            onOpenSearch={() => setView('search')}
          />
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

import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext.tsx';
import { AuthGate } from './auth/AuthGate.tsx';
import { apiFetch, ApiError } from './api/client.ts';
import { Stream } from './components/Stream.tsx';
import { LaneBoard } from './components/LaneBoard.tsx';
import { SearchView } from './components/SearchView.tsx';
import { SourceHealthPage } from './components/SourceHealthPage.tsx';
import { EntityGraphView } from './components/EntityGraphView.tsx';
import { MapPanel } from './components/MapPanel.tsx';
import { AmbientView, isAmbientRequested } from './components/AmbientView.tsx';
import { startShellIntegration } from './shell/tauri.ts';
import {
  EnrichmentStatus,
  type EnrichmentStatusData,
  type EnrichmentSpendData,
} from './components/EnrichmentStatus.tsx';
import { useIsWideViewport } from './lib/viewport.ts';

/**
 * Shape of GET /api/dashboard/header (src/api/routes/dashboard.ts, M3 task 6).
 *
 * M5 task 14 typed the two enrichment fields, which M3 left as `unknown`
 * because nothing read them. Both are OPTIONAL: a response from a server
 * older than this task simply has no `enrichment` key, and the component
 * renders nothing rather than manufacturing a cost-policy claim out of an
 * absent field.
 */
interface DashboardHeader {
  beats: Record<string, { lastRefreshAt: string | null; sourceCount: number }>;
  failingSources: number;
  enrichmentSpend?: EnrichmentSpendData;
  enrichment?: EnrichmentStatusData;
}

/**
 * Which of the four views is showing. Deliberately a small union in state
 * rather than a router: the app has four views, and adding a routing
 * dependency for that is not justified (M3 task 11's brief said as much).
 *
 * `search` and `sources` were built standalone by task 11 while task 10 owned
 * App.tsx for the six-lane layout -- the same central-wiring pattern Wave 2's
 * routes used, where parallel tasks each export a component and one commit
 * mounts them.
 *
 * `entities` is M5 task 17's §7.4 graph, mounted here in the same commit that
 * built it rather than left for someone to notice. CLAUDE.md's table of
 * unreachable components opens with `registerItems` -- a correctly-built,
 * fully-tested component with no mount point -- and a view that is not in this
 * union is exactly that shape.
 */
type View = 'items' | 'search' | 'sources' | 'entities' | 'map';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: DashboardHeader };

function Dashboard() {
  const { token, setToken } = useAuth();

  // M8. The desktop shell's tray count and native notifications, started here
  // because this is the first component that holds a token — and the token is
  // the whole reason the polling lives in the webview rather than in Rust
  // (see web/src/shell/tauri.ts).
  //
  // Called UNCONDITIONALLY. `startShellIntegration` returns a no-op outside
  // Tauri and never imports `@tauri-apps/api` there, so the browser build
  // pays nothing. Guarding the call site instead would put the "is this the
  // shell?" test in two places, and the second one is the one that rots.
  //
  // Registered here and pinned by web/tests/shellWiring.test.ts, because this
  // project has now shipped TEN components that were correctly built, fully
  // tested and reachable from nothing (CLAUDE.md). A shell integration that
  // nothing calls is exactly that shape, and it would be invisible: the shell
  // would open, show the dashboard, and simply never notify.
  useEffect(() => {
    if (token === null) return;
    return startShellIntegration(token);
  }, [token]);
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
    <main
      className={[
        'shell',
        // §7's "one wall": the lane board and the map want the whole display,
        // where search/entities/source-health are columns of text that do not.
        // See `.shell--wall` in global.css for the measurement behind this.
        (view === 'items' && isWide) || view === 'map' ? 'shell--wall' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
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
          className={`shell__nav-button${view === 'entities' ? ' shell__nav-button--active' : ''}`}
          aria-current={view === 'entities' ? 'page' : undefined}
          onClick={() => setView('entities')}
        >
          entities
        </button>
        <button
          type="button"
          className={`shell__nav-button${view === 'map' ? ' shell__nav-button--active' : ''}`}
          aria-current={view === 'map' ? 'page' : undefined}
          onClick={() => setView('map')}
        >
          map
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

      {/* The map is a FULL-BLEED view, so the two header strips below it stand
          down while it is showing.

          Measured, not guessed: with the title, nav, status line and
          enrichment panel all stacked, the chrome took 460 of 720 viewport
          pixels and left the globe a 260px letterbox -- §7.4 asks for the
          showpiece view of the project and this was a marble in a black bar.
          Every other view is a list and is happy below the full header.

          §15's "the dashboard shows the feature as off" is unaffected: the
          items view, which is the dashboard, still shows it. */}
      {view !== 'map' && (
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
      )}

      {/* §15's third clause: "the dashboard shows the feature as off." Part of
          the header strip, beside the beat/source counts, rather than tucked
          onto the source-health page -- §7 puts today's enrichment spend in
          the header, and the policy that governs that spend belongs next to
          it. See EnrichmentStatus.tsx for why it is three lines and not one. */}
      {state.status === 'ready' && view !== 'map' && (
        <EnrichmentStatus
          status={state.data.enrichment ?? null}
          spend={state.data.enrichmentSpend ?? null}
        />
      )}

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

      {token && view === 'entities' && (
        <EntityGraphView
          token={token}
          onUnauthorized={() => setToken(null)}
          onClose={() => setView('items')}
        />
      )}

      {token && view === 'map' && (
        <MapPanel
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
  // §7.4's ambient mode, "launched from a menu item or `?ambient=1`". Read
  // once, at render, not held in state: this is a deployment choice for a
  // display that is never navigated, not a view to transition between.
  //
  // Still INSIDE AuthGate. A wall display is exactly the situation where it is
  // tempting to skip the token -- and exactly the situation where you should
  // not, because a screen left on in a room is the least supervised surface
  // this system has. §7.1's "read/saved/dismissed state is server-side" makes
  // no exception for it either.
  const ambient = isAmbientRequested();

  return (
    <AuthProvider>
      <AuthGate>{ambient ? <AmbientView /> : <Dashboard />}</AuthGate>
    </AuthProvider>
  );
}

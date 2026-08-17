import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';
import {
  fetchLocations,
  fetchMapPrefs,
  saveMapPrefs,
  type MapLocation,
  type MapPrefs,
} from '../api/map.ts';
import { useIsWideViewport } from '../lib/viewport.ts';
import './MapPanel.css';

/**
 * The §7.2 map's mount point, and the two things that must NOT live inside the
 * map chunk: the lazy boundary, and the phone answer.
 *
 * ## The lazy boundary
 *
 * §7.2: *"Code-split the entire map bundle behind a lazy route so the
 * daily-driver dashboard never pays for WebGL it isn't using."*
 *
 * `MapView.tsx` is the only module that imports `maplibre-gl`, and this is the
 * only module that imports `MapView.tsx` -- through a dynamic `import()`, so
 * Vite emits it as a separate chunk that is fetched the first time the map is
 * opened and never before. Pinned by `web/tests/mapLazy.test.ts`, which reads
 * the BUILT chunk graph rather than trusting the source.
 *
 * ## The phone answer, stated plainly
 *
 * §7.2: *"On phone widths, degrade to a static image plus a location list
 * rather than shipping a WebGL context to a phone browser for a view that's
 * hard to use there anyway."*
 *
 * Below the breakpoint this component **never calls the dynamic import at
 * all** -- so no WebGL context is created, no 800 KB chunk is fetched, and no
 * GPU is woken on a battery. That is stronger than hiding the canvas with CSS,
 * which is what "responsive" usually means and which would pay every cost for
 * a view nobody can use.
 *
 * The narrow view is a ranked list of facilities, and it is not a consolation
 * prize: it carries every number the map encodes -- which sites, in which
 * countries, with how many items and how stale the pin is -- exactly rather
 * than approximately, and it is tappable where a 6-pixel circle is not. What
 * it loses is spatial relationship, which is real and is said here rather than
 * hidden. Same reasoning, same breakpoint, and the same guarded default as
 * `EntityGraphView`'s ring-versus-list decision.
 */

const MapView = lazy(() => import('../map/MapView.tsx'));

export interface MapPanelProps {
  token: string;
  onUnauthorized: () => void;
  ambient?: boolean;
  onClose?: () => void;
}

type PrefsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; prefs: MapPrefs };

/**
 * Fill the viewport from wherever this component happens to start, down to the
 * bottom.
 *
 * Measured rather than expressed in CSS, because the distance from the top of
 * the page to the top of the map is not a constant this stylesheet can know:
 * the shell above it carries a title, a nav row, a status line, and an
 * enrichment panel that appears only when the API reports one. The first
 * version used `min-height: 60vh` and produced a globe cut off by the fold --
 * correct by the stylesheet, wrong on screen.
 *
 * `100dvh`, not `100vh`: on a phone browser the two differ by the height of a
 * chrome bar that appears and disappears as you scroll, and `vh` is the one
 * that leaves a gap.
 */
function useFillsViewport<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const measure = () => {
      const node = ref.current;
      if (node === null) return;
      node.style.setProperty('--map-top', `${Math.round(node.getBoundingClientRect().top)}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  return ref;
}

export function MapPanel({ token, onUnauthorized, ambient = false, onClose }: MapPanelProps) {
  const isWide = useIsWideViewport();
  const [state, setState] = useState<PrefsState>({ status: 'loading' });
  // Ambient mode already occupies a fixed full-screen grid cell, so the
  // measurement is off there -- it would fight a parent that is already exact.
  const fillRef = useFillsViewport<HTMLDivElement>(!ambient);

  useEffect(() => {
    let cancelled = false;
    fetchMapPrefs(token)
      .then((prefs) => {
        if (!cancelled) setState({ status: 'ready', prefs });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401) {
          onUnauthorized();
          return;
        }
        setState({ status: 'error', message: 'could not load map preferences' });
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized]);

  const onPrefsChange = useCallback(
    (next: MapPrefs) => {
      // Optimistic: the toggle should feel instant, and the server is the
      // authority for the NEXT load rather than for this frame. A failed save
      // means the choice does not survive a reload -- worth a silent retry-on-
      // next-toggle, not worth blocking the interaction.
      setState({ status: 'ready', prefs: next });
      void saveMapPrefs(token, next).catch(() => undefined);
    },
    [token],
  );

  if (state.status === 'loading') return <div className="mappanel__status">loading map…</div>;
  if (state.status === 'error') return <div className="mappanel__status">{state.message}</div>;

  if (!isWide) {
    return (
      <div ref={fillRef} className="mappanel">
        <NarrowMap token={token} onUnauthorized={onUnauthorized} onClose={onClose} />
      </div>
    );
  }

  return (
    <div ref={fillRef} className={`mappanel${ambient ? ' mappanel--ambient' : ''}`}>
      <Suspense fallback={<div className="mappanel__status">loading map…</div>}>
        <MapView
          token={token}
          onUnauthorized={onUnauthorized}
          prefs={state.prefs}
          onPrefsChange={onPrefsChange}
          ambient={ambient}
          {...(onClose !== undefined ? { onClose } : {})}
        />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The narrow view. No WebGL, no map chunk, no dynamic import.
// ---------------------------------------------------------------------------

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; locations: MapLocation[] };

function NarrowMap({
  token,
  onUnauthorized,
  onClose,
}: {
  token: string;
  onUnauthorized: () => void;
  onClose?: () => void;
}) {
  const [state, setState] = useState<ListState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchLocations(token)
      .then((r) => {
        if (!cancelled) setState({ status: 'ready', locations: r.locations });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401) {
          onUnauthorized();
          return;
        }
        setState({ status: 'error', message: 'could not load locations' });
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized]);

  if (state.status === 'loading') return <div className="mappanel__status">loading…</div>;
  if (state.status === 'error') return <div className="mappanel__status">{state.message}</div>;

  // Busiest first: on a small screen the ordering IS the information design,
  // since there is no spatial channel to carry it.
  const sorted = [...state.locations].sort(
    (a, b) => b.itemCount - a.itemCount || (a.name < b.name ? -1 : 1),
  );

  return (
    <section className="mappanel__narrow">
      <header>
        <h2>Infrastructure</h2>
        <p>
          {sorted.length} sites · list view — the interactive map needs a wider screen
        </p>
        {onClose !== undefined && (
          <button type="button" onClick={onClose}>
            close
          </button>
        )}
      </header>
      <ul>
        {sorted.map((l) => (
          <li key={l.id}>
            <div className="mappanel__row">
              <span className="mappanel__name">{l.name}</span>
              <span className="mappanel__count">{l.itemCount}</span>
            </div>
            <div className="mappanel__meta">
              {l.kind.replace(/_/g, ' ')} · {l.country}
              {l.city !== null && ` · ${l.city}`} · verified {l.verifiedAt}
              {/* §7.2 wants the UI to show how much to trust a pin. On the map
                  that is a hollow marker; here it is a word, because a list
                  has no shape channel to spend. */}
              {l.precision !== 'site' && ` · ${l.precision}-level`}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

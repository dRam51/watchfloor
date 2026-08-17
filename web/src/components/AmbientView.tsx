import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { apiFetch, ApiError } from '../api/client.ts';
import type { FeedItem } from '../api/types.ts';
import { MapPanel } from './MapPanel.tsx';
import { relativeTime } from '../lib/relativeTime.ts';
import './AmbientView.css';

/**
 * §7.4's ambient mode: *"a full-screen rotating globe + ticker + latest-flagged-items
 * view intended for an idle monitor or TV -- the literal wall display. No
 * interaction, auto-refreshing, launched from a menu item or `?ambient=1`."*
 *
 * ## Three rules this view follows that the dashboard does not
 *
 * **No interaction.** Not "fewer controls" -- none. The globe is constructed
 * with `interactive: false`, there is no nav, and nothing here is focusable.
 * A wall display that a cleaner can pan into the Pacific is a wall display
 * that is wrong every morning.
 *
 * **It refreshes itself.** The dashboard fetches when you act; this fetches on
 * a timer, because nobody is going to reload it. The interval is minutes, not
 * seconds: this is a laptop, and CLAUDE.md's whole scheduling design came from
 * measuring what a background poll costs.
 *
 * **It degrades to nothing gracefully.** A failed refresh keeps the last good
 * frame rather than showing an error banner on a television. The corpus does
 * not change fast enough for a stale minute to mislead anyone, and a wall
 * display whose failure mode is a red box is worse than one whose failure mode
 * is being slightly behind.
 *
 * The market ticker §7.4 also asks for is **M4b**, which is deferred pending
 * `config/portfolio.yaml`. Rather than invent a placeholder ribbon, the strip
 * carries what this system actually knows right now -- the latest flagged
 * items -- and says so. An empty ribbon labelled "markets" would be the
 * `not_configured`-versus-`[]` mistake the MCP tools were careful to avoid.
 */

interface FlaggedItem {
  itemKey: string;
  title: string;
  sourceId: string;
  beat: string;
  publishedAt: string | null;
}

interface FeedResponse {
  items: FeedItem[];
}

/** Five minutes. See the module doc on why this is not seconds. */
const REFRESH_MS = 5 * 60_000;
const TICKER_BEATS = ['cyber', 'ai', 'aisec', 'usnews'] as const;

export function AmbientView() {
  const { token, setToken } = useAuth();
  const [items, setItems] = useState<FlaggedItem[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;

    const load = () => {
      Promise.all(
        TICKER_BEATS.map((beat) =>
          apiFetch<FeedResponse>(`/api/feed?beat=${beat}&limit=6`, token).catch(
            (cause: unknown) => {
              if (cause instanceof ApiError && cause.status === 401) setToken(null);
              // One dead beat never blanks the wall. Same stance as
              // pollOneSource: an error in one lane is not an error in all.
              return { items: [] } as FeedResponse;
            },
          ),
        ),
      ).then((responses) => {
        if (cancelled) return;
        const merged = responses.flatMap((r, i) =>
          r.items.map((item) => ({
            itemKey: item.itemKey,
            title: item.title,
            sourceId: item.sourceId,
            beat: TICKER_BEATS[i]!,
            publishedAt: item.publishedAt,
          })),
        );
        if (merged.length === 0) return; // keep the last good frame
        // The feed is already ranked per beat; this only interleaves the four.
        // `publishedAt` is nullable (1,715 items in the first live corpus had
        // none), so a null sorts LAST rather than crashing the comparator or
        // silently floating to the top as an empty string would.
        merged.sort((a, b) => {
          if (a.publishedAt === b.publishedAt) return 0;
          if (a.publishedAt === null) return 1;
          if (b.publishedAt === null) return -1;
          return a.publishedAt < b.publishedAt ? 1 : -1;
        });
        setItems(merged.slice(0, 18));
        setLastUpdated(new Date().toISOString());
      });
    };

    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, setToken]);

  if (token === null) return null;

  return (
    <div className="ambient">
      <div className="ambient__globe">
        <MapPanel token={token} onUnauthorized={() => setToken(null)} ambient />
      </div>

      <aside className="ambient__rail">
        <header>
          <h1>watchfloor</h1>
          <p>
            {lastUpdated === null ? 'connecting…' : `updated ${relativeTime(lastUpdated)}`}
          </p>
        </header>
        <ul>
          {items.map((item) => (
            <li key={`${item.beat}:${item.itemKey}`}>
              <span className="ambient__beat">{item.beat}</span>
              <span className="ambient__title">{item.title}</span>
              <span className="ambient__meta">
                {item.sourceId} · {relativeTime(item.publishedAt)}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

/**
 * Whether this page load asked for ambient mode.
 *
 * Read once at module scope by the caller rather than watched: `?ambient=1` is
 * a deployment choice for a display that is never navigated, not a route to
 * transition between.
 */
export function isAmbientRequested(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('ambient') === '1';
}

import { useEffect, useRef, useState } from 'react';
import { fetchFeedFirstPage, fetchFeedNextPage } from '../api/feed.ts';
import { ApiError } from '../api/client.ts';
import { dismissItem, markItemRead, saveItem, unsaveItem } from '../api/itemState.ts';
import type { Beat, FeedItem } from '../api/types.ts';
import { BeatFilter } from './BeatFilter.tsx';
import { ItemRow } from './ItemRow.tsx';
import { prefersReducedMotion } from '../lib/motion.ts';

/**
 * The merged stream (M3 task 8) -- a single scrollable list of item rows
 * across all beats, with a beat filter chip row that refetches through the
 * API rather than filtering an in-memory array. This is deliberately the
 * ONLY view: §7.1 requires lanes (Task 10) to be a wide-viewport
 * ARRANGEMENT of this component, not a second component tree, so nothing
 * here may assume it is the only thing on the page or own page-level chrome
 * beyond its own list and filter row.
 *
 * PAGINATION: explicit "Load more", never infinite scroll (task brief,
 * constraints). No scroll listener, no IntersectionObserver -- the only way
 * a second page is requested is a click on `.stream__load-more`.
 */

const PAGE_SIZE = 25;

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

export interface StreamProps {
  token: string;
  onUnauthorized: () => void;
}

export function Stream({ token, onUnauthorized }: StreamProps) {
  const [beat, setBeat] = useState<Beat | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [dismissingKeys, setDismissingKeys] = useState<Set<string>>(new Set());
  // Bumped by the retry button to re-run the load effect without adding a
  // second source of truth for "which beat is selected".
  const [retryToken, setRetryToken] = useState(0);
  const dismissTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Changing the beat filter starts a FRESH page -- no cursor carried over,
  // because a cursor's `beat` is fixed at the instant it was minted (task
  // brief, point 2) and this is a deliberate new query, not a continuation.
  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: 'loading' });
    setItems([]);
    setNextCursor(null);

    fetchFeedFirstPage(token, { beat: beat ?? undefined, limit: PAGE_SIZE })
      .then((response) => {
        if (cancelled) return;
        setItems(response.items);
        setNextCursor(response.nextCursor);
        setLoadState({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setLoadState({
          status: 'error',
          message: error instanceof Error ? error.message : 'unknown error',
        });
      });

    return () => {
      cancelled = true;
    };
    // Deliberately excludes `onUnauthorized`: AuthContext's setToken (what
    // App.tsx passes as this prop) is stable across renders because it comes
    // straight from useState, but it is not memoized at this call site, so
    // listing it here would refetch on every parent render for no reason.
  }, [token, beat, retryToken]);

  useEffect(() => {
    const timers = dismissTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  function loadMore(): void {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    // The cursor is passed back VERBATIM -- no `beat`/`profile` reconstructed
    // from this component's own state (task brief, point 2; also enforced by
    // FeedCursorParams's type, which has no `beat` field to pass even if
    // this tried to).
    fetchFeedNextPage(token, { cursor: nextCursor, limit: PAGE_SIZE })
      .then((response) => {
        setItems((prev) => [...prev, ...response.items]);
        setNextCursor(response.nextCursor);
        setLoadingMore(false);
      })
      .catch((error: unknown) => {
        setLoadingMore(false);
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setLoadState({
          status: 'error',
          message: error instanceof Error ? error.message : 'unknown error',
        });
      });
  }

  function handleOpen(item: FeedItem): void {
    // Fire-and-forget: opening the link must never wait on this (§7.4,
    // "nothing visual may block or delay data"), and a failed read-mark is
    // not worth surfacing an error for -- the user's own action (opening the
    // article) already succeeded regardless of whether the server recorded it.
    markItemRead(token, item.itemKey)
      .then((state) => {
        setItems((prev) => prev.map((it) => (it.itemKey === item.itemKey ? { ...it, state } : it)));
      })
      .catch(() => {
        /* best-effort */
      });
  }

  function handleToggleSave(item: FeedItem): void {
    const wasSaved = item.state.savedAt !== null;
    const call = wasSaved ? unsaveItem(token, item.itemKey) : saveItem(token, item.itemKey);
    call
      .then((state) => {
        setItems((prev) => prev.map((it) => (it.itemKey === item.itemKey ? { ...it, state } : it)));
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) onUnauthorized();
        // Otherwise leave the row as it was -- no optimistic flip to undo.
      });
  }

  function handleDismiss(item: FeedItem): void {
    dismissItem(token, item.itemKey)
      .then(() => {
        setDismissingKeys((prev) => new Set(prev).add(item.itemKey));
        // Dismissal is IRREVERSIBLE (§7) -- this timer only delays the row's
        // removal from the DOM so the 150-200ms fade transition can play; it
        // never offers the user a way back. Respect prefers-reduced-motion by
        // removing immediately rather than "quickly" -- there is no motion to
        // wait out.
        const delay = prefersReducedMotion() ? 0 : 200;
        const timer = setTimeout(() => {
          setItems((prev) => prev.filter((it) => it.itemKey !== item.itemKey));
          setDismissingKeys((prev) => {
            const next = new Set(prev);
            next.delete(item.itemKey);
            return next;
          });
          dismissTimers.current.delete(timer);
        }, delay);
        dismissTimers.current.add(timer);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) onUnauthorized();
      });
  }

  return (
    <section className="stream" aria-label="Item stream">
      <BeatFilter value={beat} onChange={setBeat} />

      {loadState.status === 'loading' && <p className="stream__status">loading feed&hellip;</p>}

      {loadState.status === 'error' && (
        <p className="stream__status stream__status--error">
          feed error: {loadState.message}{' '}
          <button type="button" className="stream__retry touch-target" onClick={() => setRetryToken((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}

      {loadState.status === 'ready' && items.length === 0 && (
        <p className="stream__status">Nothing here right now.</p>
      )}

      {items.length > 0 && (
        <ul className="stream__list">
          {items.map((item) => (
            <ItemRow
              key={item.itemKey}
              item={item}
              dismissing={dismissingKeys.has(item.itemKey)}
              onOpen={handleOpen}
              onToggleSave={handleToggleSave}
              onDismiss={handleDismiss}
            />
          ))}
        </ul>
      )}

      {loadState.status === 'ready' && nextCursor !== null && (
        <button
          type="button"
          className="stream__load-more touch-target"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}

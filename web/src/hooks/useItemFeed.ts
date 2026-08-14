import { useEffect, useRef, useState } from 'react';
import { fetchFeedFirstPage, fetchFeedNextPage } from '../api/feed.ts';
import { ApiError } from '../api/client.ts';
import { dismissItem, markItemRead, saveItem, unsaveItem } from '../api/itemState.ts';
import type { Beat, FeedItem } from '../api/types.ts';
import { prefersReducedMotion } from '../lib/motion.ts';

/**
 * The fetch/paginate/mutate guts of "one list of item rows" -- extracted
 * from `Stream.tsx` (M3 task 8/9) so `Lane.tsx` (M3 task 10) can reuse the
 * EXACT SAME fetching, pagination, and open/save/dismiss logic for a
 * beat-fixed list, rather than re-implementing it. This is the concrete
 * form of the task-10 brief's ordering rule applied one level below the row:
 * "if you find yourself writing a lane-specific row, you have inverted the
 * order" -- the same is true of lane-specific FETCHING logic, which is why
 * this lives in one hook both `Stream` (merged/filterable) and `Lane`
 * (beat-fixed) call, rather than two parallel copies.
 *
 * Deliberately holds NO notion of "which row has focus" -- that stays with
 * whichever caller owns real DOM focus (`Stream`'s own `focusedItemKey`, or
 * M3 task 10's `LaneBoard` coordinator), via `onBeforeDismiss` below. A data
 * hook that also tracked focus would make Stream's and Lane's very different
 * focus-scoping rules (one list vs. six coordinated lists) someone else's
 * problem to reconcile from inside here.
 */

export type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

export interface UseItemFeedOptions {
  token: string;
  /** Fixed beat for a lane; omit (or pass `null`) for the merged/filterable stream. */
  beat?: Beat | null;
  onUnauthorized: () => void;
  pageSize: number;
  /**
   * Called SYNCHRONOUSLY -- before the dismiss request even goes out, let
   * alone before the row is scheduled for removal -- with the item, its
   * index, and the items array it was found in. A focused descendant inside
   * an `aria-hidden` ancestor is invalid, and once the removal timer below
   * actually splices the row out of `items`, its DOM node is gone with
   * nothing left to say where focus should go next; a caller that owns real
   * focus (and knows whether THIS item currently holds it) uses this to move
   * focus to a neighbor first, exactly as `Stream.tsx` did before this hook
   * existed. Optional because not every caller manages roving focus (none
   * do today, but a future read-only consumer might).
   */
  onBeforeDismiss?: (item: FeedItem, index: number, items: FeedItem[]) => void;
}

export interface UseItemFeedResult {
  items: FeedItem[];
  loadState: LoadState;
  loadingMore: boolean;
  nextCursor: string | null;
  dismissingKeys: Set<string>;
  loadMore: () => void;
  handleOpen: (item: FeedItem) => void;
  handleToggleSave: (item: FeedItem) => void;
  handleDismiss: (item: FeedItem) => void;
  /** Fetches a FRESH page 1 (a brand-new server `now`, discarding any frozen
   * cursor snapshot) -- never a page-2 request. See `Stream.tsx`'s original
   * comment on `refresh` (task 9) for why this is not `loadMore`. */
  refresh: () => void;
}

export function useItemFeed(options: UseItemFeedOptions): UseItemFeedResult {
  const { token, beat, onUnauthorized, pageSize, onBeforeDismiss } = options;

  const [items, setItems] = useState<FeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [dismissingKeys, setDismissingKeys] = useState<Set<string>>(new Set());
  // Bumped by `refresh()` to re-run the load effect without a second source
  // of truth for "which beat is selected" -- identical role to Stream's
  // pre-extraction `retryToken`.
  const [retryToken, setRetryToken] = useState(0);
  const dismissTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: 'loading' });
    setItems([]);
    setNextCursor(null);

    fetchFeedFirstPage(token, { beat: beat ?? undefined, limit: pageSize })
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
    // Deliberately excludes `onUnauthorized`/`pageSize` for the same reason
    // Stream's pre-extraction effect did: `onUnauthorized` is stable-enough
    // in practice but not memoized at call sites, and `pageSize` is a
    // per-caller constant (25 for Stream, a smaller value for Lane) that
    // never changes across a component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // The cursor is passed back VERBATIM -- FeedCursorParams has no
    // `beat`/`profile` field, so nothing here could reconstruct one even by
    // accident.
    fetchFeedNextPage(token, { cursor: nextCursor, limit: pageSize })
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
    // not worth surfacing an error for.
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
    const dismissedIndex = items.findIndex((it) => it.itemKey === item.itemKey);
    if (dismissedIndex !== -1) onBeforeDismiss?.(item, dismissedIndex, items);

    dismissItem(token, item.itemKey)
      .then(() => {
        setDismissingKeys((prev) => new Set(prev).add(item.itemKey));
        // Dismissal is IRREVERSIBLE (§7) -- this timer only delays the row's
        // removal from the DOM so the fade transition can play; it never
        // offers a way back. Respect prefers-reduced-motion by removing
        // immediately rather than "quickly".
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

  function refresh(): void {
    setRetryToken((n) => n + 1);
  }

  return {
    items,
    loadState,
    loadingMore,
    nextCursor,
    dismissingKeys,
    loadMore,
    handleOpen,
    handleToggleSave,
    handleDismiss,
    refresh,
  };
}

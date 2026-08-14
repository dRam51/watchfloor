import { useEffect, useRef, useState } from 'react';
import { fetchFeedFirstPage, fetchFeedNextPage } from '../api/feed.ts';
import { ApiError } from '../api/client.ts';
import { dismissItem, markItemRead, saveItem, unsaveItem } from '../api/itemState.ts';
import type { Beat, FeedItem } from '../api/types.ts';
import { BeatFilter } from './BeatFilter.tsx';
import { ItemRow } from './ItemRow.tsx';
import { SearchBox } from './SearchBox.tsx';
import { prefersReducedMotion } from '../lib/motion.ts';
import { beatForDigitKey, hasNavModifier, isEditableTarget, nextFocusIndex } from '../lib/keyboardNav.ts';

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
 *
 * KEYBOARD LAYER (M3 task 9, §7: "j/k move, o open in new tab, s save, x
 * dismiss, / search, 1-6 jump to lane, r refresh"). Every binding below
 * calls the SAME function its existing pointer affordance calls
 * (`handleOpen`/`handleToggleSave`/`handleDismiss`/`refresh`/`jumpToBeat`)
 * -- nothing here is a second implementation of an action that already
 * exists. See `focusedItemKey` for the real-focus model and `refresh` /
 * `jumpToBeat` for the two deliberate decisions (fresh ranking, not a
 * frozen page; beat-filter today, lane-extensible later).
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
  // Bumped by the retry button (and now `refresh`, below) to re-run the
  // load effect without adding a second source of truth for "which beat is
  // selected".
  const [retryToken, setRetryToken] = useState(0);
  const dismissTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // ---------------------------------------------------------------------
  // Real-focus model (task brief, decision 3). `focusedItemKey` is the ONE
  // piece of state a screen reader and a keyboard user both have to agree
  // with -- it is set ONLY from `ItemRow`'s `onFocusRow` callback, which
  // fires on a genuine DOM `focus` event on that row's toggle button,
  // never set directly by a keyboard handler "pretending" a row is
  // current. `j`/`k` (`moveFocus` below) don't set this state themselves;
  // they call `.focus()` on the target row's real button, and THAT is what
  // updates `focusedItemKey`, via the exact same `onFocusRow` path a mouse
  // click or a Tab keypress would use. One feedback loop, one truth.
  //
  // Keyed on `itemKey`, not array index: an index would go stale the
  // moment any EARLIER row left the array (e.g. a dismiss elsewhere in the
  // list shifts every later index down by one) without a matching DOM
  // focus event to correct it. Deriving the index fresh from `itemKey` on
  // every render is self-healing instead -- if the focused item is no
  // longer present at all, `focusedIndex` below becomes `null` and the
  // next `j`/`k` press re-enters the list rather than acting on a wrong row.
  const [focusedItemKey, setFocusedItemKey] = useState<string | null>(null);
  const rawFocusedIndex = focusedItemKey === null ? -1 : items.findIndex((it) => it.itemKey === focusedItemKey);
  const focusedIndex = rawFocusedIndex === -1 ? null : rawFocusedIndex;

  // Index -> toggle-button element, rebuilt fresh every render via each
  // ItemRow's `toggleRef` callback (see the map below) -- always correct
  // for whatever `items` currently is, so nothing here needs pruning when
  // the array shrinks.
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  /** Moves real DOM focus to `items[index]`'s toggle button and brings it
   * into view -- the only place a scroll is ever triggered by the keyboard
   * layer, so it is the only place that has to respect
   * prefers-reduced-motion (§7.4) and jsdom's lack of a real
   * `scrollIntoView` implementation (guarded, not assumed). */
  function focusRowAt(index: number): void {
    const el = rowRefs.current[index];
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }

  /** `j`/`k`. Pure index arithmetic lives in lib/keyboardNav.ts
   * (`nextFocusIndex`) so the "first press enters the list, clamp at the
   * edges, don't wrap" rules are unit-tested without a DOM. */
  function moveFocus(delta: 1 | -1): void {
    const next = nextFocusIndex(focusedIndex, delta, items.length);
    if (next !== null) focusRowAt(next);
  }

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
    // If this row currently holds real focus, move it to a neighbor BEFORE
    // marking the row aria-hidden and fading it out -- a focused descendant
    // inside an aria-hidden ancestor is invalid, and once the removal timer
    // below actually splices the row out of `items`, its DOM node is gone
    // and focus would otherwise fall back to <body> with nothing left to
    // tell `focusedItemKey` where to go. Synchronous, not deferred to the
    // timer: the keyboard `x` path (task brief) makes "the focused row gets
    // dismissed" the common case, not an edge case a mouse-only user rarely
    // hit.
    const dismissedIndex = items.findIndex((it) => it.itemKey === item.itemKey);
    if (dismissedIndex !== -1 && focusedItemKey === item.itemKey) {
      const neighborIndex = dismissedIndex < items.length - 1 ? dismissedIndex + 1 : dismissedIndex - 1;
      if (neighborIndex >= 0) focusRowAt(neighborIndex);
    }

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

  /**
   * `r` (task brief, decision 2). `nextCursor` freezes page 1's `now` so
   * pagination re-applies ONE consistent decay snapshot across every page
   * (docs/api.md, "nextCursor carries a frozen now") -- so refresh is
   * explicitly NOT "fetch the next page" (that would be `loadMore`, which
   * passes the frozen cursor back verbatim). Bumping `retryToken` re-runs
   * the load effect above, which calls `fetchFeedFirstPage` with no `now`
   * of its own -- the server computes a brand new "now" for that request,
   * discarding the old snapshot entirely and starting a fresh ranking. Also
   * the SAME function the (error-only) Retry button already used before
   * this task; it is now additionally always-visible and bound to `r`.
   */
  function refresh(): void {
    setRetryToken((n) => n + 1);
  }

  /**
   * `1`-`6` (task brief, decision 1). Digit -> beat parsing lives in
   * lib/keyboardNav.ts's `beatForDigitKey`; this function is the ONE place
   * that decides what selecting a beat actually DOES, kept deliberately
   * separate so Task 10 (six-lane layout) can extend it -- e.g. also
   * scrolling/focusing the corresponding lane column -- without touching
   * the digit-parsing code above it. Today, with no lanes yet, selecting a
   * beat IS filtering the merged stream, so this calls the exact same
   * `setBeat` the BeatFilter chips call.
   */
  function jumpToBeat(beat: Beat): void {
    setBeat(beat);
  }

  // Global keydown listener -- attached to `window` so it fires regardless
  // of which element currently has focus, EXCEPT text inputs (task brief,
  // decision 4/DoD 3: typing must never trigger navigation). Re-registered
  // each render since `items`/`focusedIndex` and the handler functions
  // above all close over current values rather than stale ones; a
  // `keydown` listener is cheap enough that this is not worth a ref-based
  // "latest values" workaround.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (hasNavModifier(event)) return; // let Cmd/Ctrl+R, Cmd/Ctrl+S, etc. through untouched
      if (isEditableTarget(event.target)) return; // never steal keys from a text field

      switch (event.key) {
        case 'j':
          event.preventDefault();
          moveFocus(1);
          return;
        case 'k':
          event.preventDefault();
          moveFocus(-1);
          return;
        case 'o': {
          if (focusedIndex === null) return;
          const item = items[focusedIndex];
          if (!item) return;
          event.preventDefault();
          // The anchor's own target="_blank" is what a pointer click uses to
          // open a new tab; window.open is the programmatic equivalent of
          // that same browser behavior. handleOpen is the literal same
          // function the anchor's onClick calls, so the read-mark half of
          // "open" is genuinely shared, not reimplemented.
          window.open(item.canonicalUrl, '_blank', 'noopener,noreferrer');
          handleOpen(item);
          return;
        }
        case 's': {
          if (focusedIndex === null) return;
          const item = items[focusedIndex];
          if (!item) return;
          event.preventDefault();
          handleToggleSave(item);
          return;
        }
        case 'x': {
          if (focusedIndex === null) return;
          const item = items[focusedIndex];
          if (!item) return;
          event.preventDefault();
          handleDismiss(item);
          return;
        }
        case 'r':
          event.preventDefault();
          refresh();
          return;
        case '/':
          // preventDefault BEFORE moving focus: the classic bug is doing
          // this in the other order (or not at all), which lets the browser
          // still insert the literal '/' into the field that just received
          // focus. Cancelling the key's default action here means there is
          // nothing left for the browser to insert anywhere.
          event.preventDefault();
          searchInputRef.current?.focus();
          return;
        default: {
          const digitBeat = beatForDigitKey(event.key);
          if (digitBeat) {
            event.preventDefault();
            jumpToBeat(digitBeat);
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // Every one of these is a plain function/value redefined on each render
    // (none memoized), so this dependency list re-runs the effect on every
    // render regardless of what is actually listed -- included explicitly
    // anyway so it is clear this is a deliberate "always fresh, never
    // stale" choice, not a missing-dependency oversight. A keydown listener
    // is cheap enough that add/remove-per-render is not worth a ref-based
    // "latest values" indirection.
  }, [items, focusedIndex, moveFocus, handleOpen, handleToggleSave, handleDismiss, refresh, jumpToBeat]);

  return (
    <section className="stream" aria-label="Item stream">
      <div className="stream__toolbar">
        <BeatFilter value={beat} onChange={setBeat} />
        <div className="stream__toolbar-actions">
          <SearchBox
            inputRef={(el) => {
              searchInputRef.current = el;
            }}
          />
          {/* Always visible -- not just on error (unlike the old Retry
              button below, which this same `refresh` now also backs). §7.1:
              every keyboard action needs a visible, tappable equivalent, and
              `r` had none before this task. */}
          <button type="button" className="stream__refresh touch-target" onClick={refresh} aria-label="Refresh feed">
            Refresh <span className="key-hint">r</span>
          </button>
        </div>
      </div>

      {loadState.status === 'loading' && <p className="stream__status">loading feed&hellip;</p>}

      {loadState.status === 'error' && (
        <p className="stream__status stream__status--error">
          feed error: {loadState.message}{' '}
          <button type="button" className="stream__retry touch-target" onClick={refresh}>
            Retry
          </button>
        </p>
      )}

      {loadState.status === 'ready' && items.length === 0 && (
        <p className="stream__status">Nothing here right now.</p>
      )}

      {items.length > 0 && (
        <ul className="stream__list">
          {items.map((item, index) => (
            <ItemRow
              key={item.itemKey}
              item={item}
              dismissing={dismissingKeys.has(item.itemKey)}
              // Roving tabindex (task brief, decision 3): exactly one row is
              // ever a Tab stop. While nothing has real focus yet, that's
              // row 0 -- a sensible, conventional entry point -- otherwise
              // it's whichever row `focusedIndex` (derived from real DOM
              // focus, never guessed) currently names.
              focused={focusedItemKey === item.itemKey}
              tabIndex={index === (focusedIndex ?? 0) ? 0 : -1}
              onFocusRow={() => setFocusedItemKey(item.itemKey)}
              toggleRef={(el) => {
                rowRefs.current[index] = el;
              }}
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLaneLayout, saveLaneLayout, type LaneLayoutEntry } from '../api/layout.ts';
import { ApiError } from '../api/client.ts';
import { BEATS, type Beat } from '../api/types.ts';
import { Lane, type LaneHandle } from './Lane.tsx';
import { SearchBox } from './SearchBox.tsx';
import { beatForDigitKey, hasNavModifier, isEditableTarget, nextFocusIndex } from '../lib/keyboardNav.ts';

/**
 * The six-lane wide-viewport arrangement of the merged stream (M3 task 10,
 * §7: "Six-lane layout, one lane per beat, each independently scrollable
 * and collapsible"). `App.tsx` mounts this INSTEAD OF `Stream` at >=~700px
 * (`lib/viewport.ts`) -- never both at once, so there is only ever one
 * keyboard listener and one set of live feed requests on the page.
 *
 * THE COORDINATION DESIGN (task brief, "the hard problem"):
 *
 * `Lane` mounts six times, each independently fetching/paginating its own
 * beat via the same `useItemFeed` hook `Stream` uses (see `Lane.tsx`). None
 * of them owns a `window` keydown listener. This component owns exactly
 * ONE, and drives whichever lane is relevant through a small imperative API
 * each `Lane` exposes via `useImperativeHandle` (`LaneHandle`) -- the same
 * relationship `Stream.tsx` already has with its own row refs, just fanned
 * out across six child instances instead of kept locally.
 *
 * THE FOCUS RECORD IS `{ beat, itemKey } | null`, NOT `itemKey` ALONE. An
 * item cross-listed across two beats (CLAUDE.md: "Beats belong to the item
 * -- unioned across every version sharing an item_key") can appear in TWO
 * lanes' lists at once with the identical `itemKey`. If the coordinator's
 * focus record were a bare itemKey and every lane painted `.item-row
 * --focused` whenever ITS OWN row matched that key, both lanes would light
 * up for one real DOM focus -- exactly the "two lanes believe they hold
 * focus" bug the task brief calls out. Tagging the record with which BEAT
 * produced the underlying `focus` event (via `handleItemFocus`, wired to
 * each `Lane`'s `onItemFocus`, itself wired to each `ItemRow`'s real
 * `onFocusRow`) is what keeps the single-focus invariant true even for a
 * cross-listed item: only the lane matching `focusedItem.beat` ever passes
 * a non-null `focusedItemKey` down to its own `Lane` instance (see the
 * `lanes.map` below), so only ONE `Lane`'s row can ever compare equal.
 */

export interface LaneBoardProps {
  token: string;
  onUnauthorized: () => void;
}

type LayoutLoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

interface FocusedItem {
  beat: Beat;
  itemKey: string;
}

export function LaneBoard({ token, onUnauthorized }: LaneBoardProps) {
  const [lanes, setLanes] = useState<LaneLayoutEntry[] | null>(null);
  const [layoutState, setLayoutState] = useState<LayoutLoadState>({ status: 'loading' });
  const [focusedItem, setFocusedItem] = useState<FocusedItem | null>(null);
  // Per-lane item counts, reported UP by each Lane (see Lane.tsx's
  // onItemCountChange) -- this is how the coordinator picks a default entry
  // lane (the first expanded, non-empty lane in display order) without
  // owning six independent fetch states itself. Never the source of truth
  // for rendering a lane's own rows -- that stays inside each Lane.
  const [itemCounts, setItemCounts] = useState<Partial<Record<Beat, number>>>({});

  const laneHandles = useRef<Partial<Record<Beat, LaneHandle | null>>>({});
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLayoutState({ status: 'loading' });

    fetchLaneLayout(token)
      .then((response) => {
        if (cancelled) return;
        setLanes(response.lanes);
        setLayoutState({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setLayoutState({ status: 'error', message: error instanceof Error ? error.message : 'unknown error' });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Stable by construction (a functional setState updater, nothing closed
  // over) -- passed into every Lane's effect dependency array, so it must
  // never change identity or each Lane's onItemCountChange effect would
  // re-fire on every LaneBoard render regardless of whether the count
  // actually changed, which (since it re-triggers a LaneBoard state update)
  // would loop.
  const handleItemCountChange = useCallback((beat: Beat, count: number) => {
    setItemCounts((prev) => (prev[beat] === count ? prev : { ...prev, [beat]: count }));
  }, []);

  // The ONE place a genuine DOM focus event becomes state (task brief:
  // "focusedItemKey is set only from a genuine DOM focus event, never
  // painted independently" -- Task 9's rule, preserved here one level up).
  const handleItemFocus = useCallback((beat: Beat, itemKey: string) => {
    setFocusedItem({ beat, itemKey });
  }, []);

  function persistLayout(next: LaneLayoutEntry[]): void {
    saveLaneLayout(token, next).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthorized();
        return;
      }
      // Reconcile with the server's actual last-known-good layout rather
      // than guessing what the pre-toggle state locally was -- the PUT is a
      // full replace, so "what it was before this click" is exactly what a
      // fresh GET returns if the write never landed.
      fetchLaneLayout(token)
        .then((response) => setLanes(response.lanes))
        .catch(() => {
          /* best-effort reconciliation; the next successful toggle retries */
        });
    });
  }

  // Optimistic: collapsing a lane is a purely-local display fact the owner
  // is expected to do constantly ("I expect to keep US news collapsed most
  // of the day", §7) -- waiting on a round trip before the column visibly
  // narrows would be exactly the kind of lag §7.4's "nothing visual may
  // block or delay data" warns against, even though that clause is written
  // about data rather than layout. `persistLayout` reconciles on failure.
  function handleToggleCollapse(beat: Beat): void {
    setLanes((prev) => {
      if (!prev) return prev;
      const next = prev.map((lane) => (lane.beat === beat ? { ...lane, collapsed: !lane.collapsed } : lane));
      persistLayout(next);
      return next;
    });
  }

  function refreshAll(): void {
    for (const beat of BEATS) laneHandles.current[beat]?.refresh();
  }

  // First lane (in current display order) that is expanded and has at
  // least one item -- the multi-lane analogue of Stream's "row 0 is the
  // default entry point". Lives here (not in a lane) because only the
  // coordinator has visibility across all six lanes' order AND counts.
  const defaultEntryBeat: Beat | null =
    lanes?.find((lane) => !lane.collapsed && (itemCounts[lane.beat] ?? 0) > 0)?.beat ?? null;

  /** `j`/`k`, scoped to whichever lane currently holds focus (task brief:
   * "j/k within the focused lane"). With nothing focused yet, both directions
   * enter via the SAME default-entry lane (j at its first row, k at its
   * last) -- deliberately simpler than "enter the true first/last lane in
   * board order", since with six independent lists there is no single
   * "last row overall" the way Stream's one list has; anchoring both
   * directions to one well-defined lane avoids that ambiguity while still
   * matching Stream's own "j enters at the top, k enters at the bottom"
   * shape for that one lane. */
  function moveFocus(delta: 1 | -1): void {
    if (focusedItem === null) {
      if (defaultEntryBeat === null) return;
      const handle = laneHandles.current[defaultEntryBeat];
      const count = itemCounts[defaultEntryBeat] ?? 0;
      if (!handle || count === 0) return;
      handle.focusRowAt(delta > 0 ? 0 : count - 1);
      return;
    }
    const handle = laneHandles.current[focusedItem.beat];
    if (!handle) return;
    const currentIndex = handle.indexOfItemKey(focusedItem.itemKey);
    const next = nextFocusIndex(currentIndex, delta, handle.itemCount);
    if (next !== null) handle.focusRowAt(next);
  }

  /** `1`-`6` -- jump BETWEEN lanes (task brief: extend `jumpToBeat`'s body
   * rather than how a keypress becomes a `Beat`, which still lives in
   * `beatForDigitKey`). Delegates entirely to that lane's own `focusEntry`,
   * which already knows how to land gracefully on a collapsed or empty lane. */
  function jumpToBeat(beat: Beat): void {
    laneHandles.current[beat]?.focusEntry();
  }

  function actOnFocused(kind: 'open' | 'save' | 'dismiss'): void {
    if (focusedItem === null) return;
    const handle = laneHandles.current[focusedItem.beat];
    if (!handle) return;
    const index = handle.indexOfItemKey(focusedItem.itemKey);
    if (index === null) return;
    if (kind === 'open') handle.openAt(index);
    else if (kind === 'save') handle.toggleSaveAt(index);
    else handle.dismissAt(index);
  }

  // The ONE keyboard listener for all six lanes -- see this file's own doc
  // comment above for why six independent listeners would be wrong. Mirrors
  // Stream.tsx's switch exactly (same keys, same modifier/editable-target
  // guards, same shared primitives from lib/keyboardNav.ts), just routed
  // through this board's coordinator functions instead of Stream's local
  // per-list ones.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (hasNavModifier(event)) return;
      if (isEditableTarget(event.target)) return;

      switch (event.key) {
        case 'j':
          event.preventDefault();
          moveFocus(1);
          return;
        case 'k':
          event.preventDefault();
          moveFocus(-1);
          return;
        case 'o':
          if (focusedItem === null) return;
          event.preventDefault();
          actOnFocused('open');
          return;
        case 's':
          if (focusedItem === null) return;
          event.preventDefault();
          actOnFocused('save');
          return;
        case 'x':
          if (focusedItem === null) return;
          event.preventDefault();
          actOnFocused('dismiss');
          return;
        case 'r':
          event.preventDefault();
          refreshAll();
          return;
        case '/':
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
    // Every value here is a plain function/value redefined each render (none
    // memoized) -- same "re-registered each render, cheap enough" choice
    // Stream.tsx documents on its own identical listener.
  }, [focusedItem, defaultEntryBeat, itemCounts, lanes]);

  return (
    <section className="lane-board" aria-label="Beat lanes">
      <div className="lane-board__toolbar">
        <SearchBox
          inputRef={(el) => {
            searchInputRef.current = el;
          }}
        />
        <button type="button" className="lane-board__refresh touch-target" onClick={refreshAll} aria-label="Refresh all lanes">
          Refresh all <span className="key-hint">r</span>
        </button>
      </div>

      {layoutState.status === 'loading' && <p className="lane-board__status">loading layout&hellip;</p>}

      {layoutState.status === 'error' && (
        <p className="lane-board__status lane-board__status--error">
          layout error: {layoutState.message}{' '}
          <button
            type="button"
            className="lane-board__retry touch-target"
            onClick={() => {
              setLayoutState({ status: 'loading' });
              fetchLaneLayout(token)
                .then((response) => {
                  setLanes(response.lanes);
                  setLayoutState({ status: 'ready' });
                })
                .catch((error: unknown) => {
                  if (error instanceof ApiError && error.status === 401) {
                    onUnauthorized();
                    return;
                  }
                  setLayoutState({ status: 'error', message: error instanceof Error ? error.message : 'unknown error' });
                });
            }}
          >
            Retry
          </button>
        </p>
      )}

      {layoutState.status === 'ready' && lanes && (
        <div
          className="lane-board__grid"
          style={{
            gridTemplateColumns: lanes.map((lane) => (lane.collapsed ? 'var(--lane-collapsed-width)' : 'minmax(0, 1fr)')).join(' '),
          }}
        >
          {lanes.map((lane) => (
            <Lane
              key={lane.beat}
              beat={lane.beat}
              collapsed={lane.collapsed}
              onToggleCollapse={handleToggleCollapse}
              token={token}
              onUnauthorized={onUnauthorized}
              focusedItemKey={focusedItem && focusedItem.beat === lane.beat ? focusedItem.itemKey : null}
              onItemFocus={handleItemFocus}
              onItemCountChange={handleItemCountChange}
              isDefaultEntry={focusedItem === null && lane.beat === defaultEntryBeat}
              ref={(handle) => {
                laneHandles.current[lane.beat] = handle;
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

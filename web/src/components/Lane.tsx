import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Beat, FeedItem } from '../api/types.ts';
import { FeedRow } from './FeedRow.tsx';
import { HeatStrip } from './HeatStrip.tsx';
import { prefersReducedMotion } from '../lib/motion.ts';
import { useItemFeed } from '../hooks/useItemFeed.ts';

/**
 * One lane column (M3 task 10) -- the wide-viewport ARRANGEMENT of a single
 * beat's slice of the merged stream, not a second row/list implementation.
 * The row is `FeedRow` -- the same dispatcher `Stream.tsx` uses, which picks
 * `ItemRow` or M4a's `RepoRow` from the item's own payload (never from this
 * lane's beat, so a cross-listed repo renders identically in both its lanes);
 * fetching/pagination/mutation come from the same `useItemFeed` hook
 * `Stream` calls, just with a beat fixed instead of filterable. If a future
 * change here only makes sense "because this is a lane", that is the
 * ordering-rule violation the task brief warns about.
 *
 * OWNS NO KEYBOARD LISTENER. `LaneBoard.tsx` is the one coordinator (task
 * brief, "the hard problem"): it owns the single real-focus record across
 * all six lanes and drives this component through the imperative handle
 * below (`LaneHandle`) rather than this component reacting to `window`
 * keydown events itself. Six of these mounted at once must never mean six
 * competing listeners.
 */

const LANE_PAGE_SIZE = 20;

const BEAT_LABELS: Record<Beat, string> = {
  ai: 'AI',
  cyber: 'Cyber',
  aisec: 'AI Security',
  repos: 'Repos',
  markets: 'Markets',
  usnews: 'US News',
};

export interface LaneHandle {
  /** How many rows this lane currently has loaded -- lets the coordinator
   * compute `nextFocusIndex` without reaching into this component's internals. */
  itemCount: number;
  /** This lane's own index for `itemKey`, or `null` if it is not (currently) in this lane's list -- a cross-listed item can be present in TWO lanes at once with the same key, so "is it here" must be asked per lane, never assumed from the key alone. */
  indexOfItemKey: (itemKey: string) => number | null;
  /** Moves real DOM focus to this lane's row at `index` and scrolls it into view. No-op if the lane is collapsed (no rows are rendered) or `index` is out of range. */
  focusRowAt: (index: number) => void;
  /** The `1`-`6` jump target: focuses this lane's first row if it is expanded and has at least one item; otherwise focuses this lane's own collapse-toggle button, so a keyboard user always lands on something real rather than nothing happening. Always scrolls the lane's header into view first. */
  focusEntry: () => void;
  openAt: (index: number) => void;
  toggleSaveAt: (index: number) => void;
  dismissAt: (index: number) => void;
  /** A fresh page 1 for this lane only -- see `useItemFeed`'s `refresh`. */
  refresh: () => void;
}

export interface LaneProps {
  beat: Beat;
  collapsed: boolean;
  onToggleCollapse: (beat: Beat) => void;
  token: string;
  onUnauthorized: () => void;
  /**
   * Already scoped by the coordinator to THIS lane: `null` unless the
   * board's single (beat, itemKey) focus record names this exact lane, in
   * which case it carries that itemKey. Comparing it against a row's own
   * `itemKey` below is therefore textually identical to `Stream.tsx`'s
   * original single-list comparison -- the six-lane disambiguation happens
   * once, in `LaneBoard`, not re-derived here.
   */
  focusedItemKey: string | null;
  /** Reports a genuine DOM focus event on one of this lane's rows, tagged with this lane's own beat -- see `ItemRow`'s `onFocusRow` and this file's own row map below. */
  onItemFocus: (beat: Beat, itemKey: string) => void;
  /** Reports this lane's current item count whenever it changes, so the coordinator can pick a default entry lane (first expanded, non-empty lane in display order) without owning each lane's fetch state itself. */
  onItemCountChange: (beat: Beat, count: number) => void;
  /** True only while nothing has real focus ANYWHERE on the board and this lane is the coordinator's chosen default entry point -- see `LaneBoard`'s own comment on why this can't be computed locally. */
  isDefaultEntry: boolean;
}

function EmptyOrErrorStatus({
  loadState,
  itemCount,
  onRetry,
}: {
  loadState: { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };
  itemCount: number;
  onRetry: () => void;
}) {
  if (loadState.status === 'loading') return <p className="lane__status">loading&hellip;</p>;
  if (loadState.status === 'error') {
    return (
      <p className="lane__status lane__status--error">
        error: {loadState.message}{' '}
        <button type="button" className="lane__retry touch-target" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }
  if (itemCount === 0) {
    // repos/markets sit here legitimately until M4a/M4b ship sources for
    // them (task brief, DoD 4) -- this is the SAME "ready, zero items"
    // status Stream.tsx already renders for the merged view, not a
    // lane-specific empty state invented for this task.
    return <p className="lane__status">Nothing here yet.</p>;
  }
  return null;
}

export const Lane = forwardRef<LaneHandle, LaneProps>(function Lane(
  { beat, collapsed, onToggleCollapse, token, onUnauthorized, focusedItemKey, onItemFocus, onItemCountChange, isDefaultEntry },
  ref,
) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const laneRootRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const collapseButtonRef = useRef<HTMLButtonElement | null>(null);

  const { items, loadState, loadingMore, nextCursor, dismissingKeys, loadMore, handleOpen, handleToggleSave, handleDismiss, refresh } =
    useItemFeed({
      token,
      beat,
      onUnauthorized,
      pageSize: LANE_PAGE_SIZE,
      onBeforeDismiss: (item, dismissedIndex, itemsAtDismiss) => {
        // Scoped entirely within this lane -- `focusedItemKey` arrives
        // already beat-matched by LaneBoard, so a dismiss in one lane can
        // never move focus into a different lane (task brief: "j/k within
        // the focused lane").
        if (focusedItemKey !== item.itemKey) return;
        const neighborIndex = dismissedIndex < itemsAtDismiss.length - 1 ? dismissedIndex + 1 : dismissedIndex - 1;
        if (neighborIndex >= 0) focusRowAt(neighborIndex);
      },
    });

  useEffect(() => {
    onItemCountChange(beat, items.length);
    // `onItemCountChange` is LaneBoard's `useCallback([], ...)` -- stable by
    // construction (a functional setState updater, no closed-over state) --
    // so this effect only re-fires when `beat`/`items.length` actually
    // change, never as a side effect of an unrelated LaneBoard re-render.
  }, [beat, items.length, onItemCountChange]);

  function focusRowAt(index: number): void {
    const el = rowRefs.current[index];
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }

  function scrollHeaderIntoView(): void {
    if (typeof headerRef.current?.scrollIntoView === 'function') {
      headerRef.current.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }

  useImperativeHandle(
    ref,
    (): LaneHandle => ({
      itemCount: items.length,
      indexOfItemKey: (itemKey: string) => {
        const index = items.findIndex((it) => it.itemKey === itemKey);
        return index === -1 ? null : index;
      },
      focusRowAt,
      focusEntry: () => {
        scrollHeaderIntoView();
        if (!collapsed && items.length > 0) {
          focusRowAt(0);
          return;
        }
        // Collapsed, or genuinely empty (repos/markets pre-M4): land on the
        // one real, tappable/focusable control this lane has rather than
        // silently doing nothing -- a keyboard user who presses "4" for an
        // empty Repos lane should feel that press land somewhere.
        collapseButtonRef.current?.focus({ preventScroll: true });
      },
      openAt: (index: number) => {
        const item = items[index];
        if (!item) return;
        // Same pairing Stream.tsx's "o" binding uses: window.open is the
        // programmatic equivalent of the Open link's own target="_blank",
        // and handleOpen (the mark-read half) is the literal same function
        // that link's onClick calls.
        window.open(item.canonicalUrl, '_blank', 'noopener,noreferrer');
        handleOpen(item);
      },
      toggleSaveAt: (index: number) => {
        const item = items[index];
        if (!item) return;
        handleToggleSave(item);
      },
      dismissAt: (index: number) => {
        const item = items[index];
        if (!item) return;
        handleDismiss(item);
      },
      refresh,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, collapsed, handleOpen, handleToggleSave, handleDismiss, refresh],
  );

  const focusedIndex = focusedItemKey === null ? -1 : items.findIndex((it) => it.itemKey === focusedItemKey);
  // Exactly one row across the WHOLE board is ever the Tab stop while
  // nothing has real focus yet -- `isDefaultEntry` arrives already decided
  // by LaneBoard (the first expanded, non-empty lane in display order), so
  // only that one lane's row 0 claims tabIndex 0 in that state. Every other
  // lane's rows are -1 until real focus actually lands on one of them; a
  // naive "every lane defaults its own row 0 to tabIndex 0" would give SIX
  // simultaneous Tab stops for one conceptual position, which is the same
  // class of bug as six lanes each believing they hold real focus.
  const defaultEntryIndex = focusedIndex === -1 && isDefaultEntry ? 0 : -1;

  return (
    <section
      className={`lane${collapsed ? ' lane--collapsed' : ''}`}
      ref={laneRootRef}
      aria-label={`${BEAT_LABELS[beat]} lane`}
    >
      <div className="lane__header" ref={headerRef}>
        <span className="lane__label">{BEAT_LABELS[beat]}</span>
        {!collapsed && loadState.status === 'ready' && (
          <span className="lane__count">
            {items.length}
            {nextCursor !== null ? '+' : ''}
          </span>
        )}
        <button
          type="button"
          ref={collapseButtonRef}
          className="lane__collapse-toggle touch-target"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${BEAT_LABELS[beat]} lane` : `Collapse ${BEAT_LABELS[beat]} lane`}
          onClick={() => onToggleCollapse(beat)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>

      {!collapsed && (
        <div className="lane__body">
          {/* M3 task 12, §7.4: "a thin 24h activity histogram at the top
              of each lane". Rendered unconditionally on `loadState` (not
              gated on `status === 'ready'` the way `.lane__count` is) --
              it derives purely from whatever `items` this lane already
              has (starts `[]` while loading, which reads as "quiet" via
              HeatStrip's own zero-item handling), so there is nothing to
              wait on and no extra request that could delay data (§7.4:
              "nothing visual may block or delay data"). */}
          <HeatStrip items={items} />
          <EmptyOrErrorStatus loadState={loadState} itemCount={items.length} onRetry={refresh} />

          {items.length > 0 && (
            <ul className="lane__list">
              {/* M4a task 8: `FeedRow`, not `ItemRow` directly. §7's repos
                  rows "differ" from news rows, and this lane holds whichever
                  the item actually is -- the choice is made once, on the
                  item's own payload, in FeedRow.tsx. Nothing lane-side
                  changes: the props below are the same ones ItemRow took,
                  forwarded untouched, so the roving tabindex, `toggleRef`
                  focus wiring and the (beat, itemKey) focus record all keep
                  working exactly as they did for a news row. */}
              {items.map((item: FeedItem, index: number) => (
                <FeedRow
                  key={item.itemKey}
                  item={item}
                  dismissing={dismissingKeys.has(item.itemKey)}
                  focused={focusedItemKey === item.itemKey}
                  tabIndex={index === (focusedIndex !== -1 ? focusedIndex : defaultEntryIndex) ? 0 : -1}
                  onFocusRow={() => onItemFocus(beat, item.itemKey)}
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
            <button type="button" className="lane__load-more touch-target" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </section>
  );
});

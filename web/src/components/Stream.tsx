import { useEffect, useRef, useState } from 'react';
import type { Beat, FeedItem } from '../api/types.ts';
import { BeatFilter } from './BeatFilter.tsx';
import { ItemRow } from './ItemRow.tsx';
import { SearchBox } from './SearchBox.tsx';
import { prefersReducedMotion } from '../lib/motion.ts';
import { beatForDigitKey, hasNavModifier, isEditableTarget, nextFocusIndex } from '../lib/keyboardNav.ts';
import { useItemFeed } from '../hooks/useItemFeed.ts';

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

export interface StreamProps {
  token: string;
  onUnauthorized: () => void;
}

export function Stream({ token, onUnauthorized }: StreamProps) {
  const [beat, setBeat] = useState<Beat | null>(null);

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

  // The fetch/paginate/mutate guts live in one shared hook (M3 task 10) so
  // `Lane.tsx`'s beat-fixed lists reuse the exact same logic rather than a
  // second implementation -- see hooks/useItemFeed.ts's own doc comment.
  // `onBeforeDismiss` is where this component's OWN concern (real focus)
  // plugs into the hook's generic "a dismiss is about to happen" moment,
  // unchanged in substance from before the extraction.
  const { items, loadState, loadingMore, nextCursor, dismissingKeys, loadMore, handleOpen, handleToggleSave, handleDismiss, refresh } =
    useItemFeed({
      token,
      beat,
      onUnauthorized,
      pageSize: PAGE_SIZE,
      onBeforeDismiss: (item, dismissedIndex, itemsAtDismiss) => {
        if (focusedItemKey !== item.itemKey) return;
        const neighborIndex = dismissedIndex < itemsAtDismiss.length - 1 ? dismissedIndex + 1 : dismissedIndex - 1;
        if (neighborIndex >= 0) focusRowAt(neighborIndex);
      },
    });

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

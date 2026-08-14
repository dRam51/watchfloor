import { BEATS, type Beat } from '../api/types.ts';

/**
 * Pure helpers for the global keyboard layer (M3 task 9, §7: "j/k move, o
 * open in new tab, s save, x dismiss, / search, 1-6 jump to lane, r
 * refresh"). Deliberately framework-free -- `Stream.tsx` is the only
 * consumer today, but Task 10 (six-lane layout) is expected to reuse these
 * exact functions rather than re-deriving them once more than one
 * scrollable list of rows exists on the page at once (see `beatForDigitKey`
 * and `nextFocusIndex` below for the specific extension points).
 */

// ---------------------------------------------------------------------------
// "Am I typing right now?" -- task brief, decision 4: "j must not scroll the
// feed while someone is typing a query." Checked against every keydown
// BEFORE any binding fires, not just before `/`.
// ---------------------------------------------------------------------------

/**
 * True when `target` is a form control (or `contenteditable` element) that
 * would consume ordinary keystrokes as text -- the exact set of elements a
 * global `j`/`k`/`o`/`s`/`x`/`r`/`1`-`6`/`/` handler must stay out of the way
 * of. `<button>` and `<a>` are deliberately NOT included: focusing an
 * item-row's toggle, Open link, Save, or Dismiss button must not suppress
 * navigation keys, or roving focus (Stream.tsx) would go dead the moment a
 * row control receives focus.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** True when a system/browser-owned modifier is held -- Cmd/Ctrl+R (real
 * reload), Cmd/Ctrl+S (browser "Save Page"), etc. must pass through
 * untouched rather than being shadowed by this app's bare-letter shortcuts.
 * Shift is deliberately excluded: none of this app's bindings use it, and
 * `event.key` already reflects a shifted keycap (e.g. `?` instead of `/`),
 * so a shifted key simply fails to match any binding on its own. */
export function hasNavModifier(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

// ---------------------------------------------------------------------------
// j/k -- roving focus index arithmetic. No DOM, no React: Stream.tsx (and
// eventually Task 10's lane container) supplies the "how many rows" and
// "which one is currently focused" and this just does the math, so the
// tricky "first press enters the list, doesn't skip past the edge" logic
// lives in one tested place.
// ---------------------------------------------------------------------------

/**
 * Given the currently-focused row index (`null` if no row has real focus
 * yet -- see Stream.tsx's `focusedItemKey`) and a direction, returns the
 * index to move real focus to, or `null` if there is nothing to focus
 * (`length === 0`).
 *
 * - Nothing focused yet: `j` (delta +1) enters at the first row, `k` (delta
 *   -1) enters at the last -- mirrors familiar list-navigation tools (mail
 *   clients, feed readers) rather than requiring a throwaway first press.
 * - Otherwise clamps at the edges rather than wrapping: repeatedly holding
 *   `j` at the bottom of the list should not cycle back to the top, which
 *   would be disorienting in a stream that is still loading more pages.
 */
export function nextFocusIndex(current: number | null, delta: 1 | -1, length: number): number | null {
  if (length === 0) return null;
  if (current === null) return delta > 0 ? 0 : length - 1;
  const next = current + delta;
  return Math.max(0, Math.min(length - 1, next));
}

// ---------------------------------------------------------------------------
// 1-6 -- digit to beat. Reuses api/types.ts's BEATS (Task 8's single
// hand-kept mirror of src/domain/item.ts's tuple) rather than a second
// literal list -- task brief: "do not hardcode a second list."
// ---------------------------------------------------------------------------

const DIGIT_KEYS = ['1', '2', '3', '4', '5', '6'] as const;

/** Maps a keydown's `event.key` to the beat it selects, or `null` for any
 * key outside `1`-`6`. Order matches `BEATS` exactly: `1` is `ai`, `6` is
 * `usnews`. */
export function beatForDigitKey(key: string): Beat | null {
  const index = DIGIT_KEYS.indexOf(key as (typeof DIGIT_KEYS)[number]);
  if (index === -1) return null;
  return BEATS[index] ?? null;
}

import { useEffect, useState } from 'react';

/**
 * The single "which arrangement of the merged stream is this?" test (M3
 * task 10, §7.1: "Build the merged-stream view first and treat lanes as the
 * wide-viewport arrangement of it"). ~700px per the task brief -- below it,
 * `App.tsx` renders Task 8/9's `Stream` (with its own beat-filter chip row);
 * at or above it, `LaneBoard` arranges the same rows into six columns.
 *
 * Framework-free at its core (`matchesWideViewport`), same shape as
 * `lib/motion.ts`'s `prefersReducedMotion` -- both read a `matchMedia`
 * query, both guard against it being absent (jsdom does not implement
 * `window.matchMedia` at all, verified against this repo's pinned jsdom;
 * `web/tests/motion.test.ts` stubs it for the same reason). The guarded
 * default (`false`, i.e. narrow/Stream) is deliberate: a host with no
 * `matchMedia` has no reliable way to know its own width, and Task 8's
 * stream is the one guaranteed-working view per §7.1's own ordering rule --
 * falling back to the MORE capable (lane) view on an environment that can't
 * actually confirm it has the width for it would risk exactly the "desktop
 * assumptions leak into what should always work" failure §7.1 exists to
 * prevent.
 */
export const DASHBOARD_LANE_BREAKPOINT_PX = 700;

export function matchesWideViewport(breakpointPx: number = DASHBOARD_LANE_BREAKPOINT_PX): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(`(min-width: ${breakpointPx}px)`).matches;
}

/**
 * React binding for `matchesWideViewport`: re-evaluates on resize/rotation
 * via the standard `MediaQueryList` `change` event (not a `resize` listener
 * -- the browser already debounces this for us and only fires when the
 * query's truth value actually flips, not on every pixel of a drag-resize).
 */
export function useIsWideViewport(breakpointPx: number = DASHBOARD_LANE_BREAKPOINT_PX): boolean {
  const [isWide, setIsWide] = useState(() => matchesWideViewport(breakpointPx));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(`(min-width: ${breakpointPx}px)`);
    const handleChange = (): void => setIsWide(mql.matches);
    handleChange(); // the breakpoint itself may have changed between render and effect
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, [breakpointPx]);

  return isWide;
}

/**
 * Motion utilities every animating component (starting with M3 task 12,
 * none exist yet) should build on, rather than each reinventing its own
 * prefers-reduced-motion check or visibility gate. Nothing here animates
 * anything itself -- this is the utility layer the brief's §7.4 constraints
 * ("respect prefers-reduced-motion", "pause when the tab is hidden") ask to
 * be the default rather than an opt-in.
 */

/** True if the user has asked the OS/browser for reduced motion. Safe to
 * call during SSR-less environments (this app has none) and in tests where
 * `window` may be a jsdom stand-in without `matchMedia` implemented. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True if the document is the active, visible tab right now. */
export function isPageVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible';
}

/**
 * Subscribes to the Page Visibility API and returns an unsubscribe
 * function. A `requestAnimationFrame` loop should check `isPageVisible()`
 * (or gate on this callback) before scheduling its next frame -- §7.4:
 * animations "pause when the tab is hidden," not merely slow down.
 */
export function onVisibilityChange(callback: (visible: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = () => callback(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

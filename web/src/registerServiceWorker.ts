/**
 * Service worker registration (M6).
 *
 * Kept out of `main.tsx` so it can be tested and so the reasoning below has
 * somewhere to live. See `web/public/sw.js` for what the worker actually does,
 * and in particular why it can never authenticate its own requests.
 *
 * ## Only in production builds
 *
 * A service worker caches the app shell. In `npm run dev:web` that means Vite's
 * dev server hands you a module graph that the worker then serves back from
 * cache, and edits stop appearing — the classic "why isn't my change showing"
 * afternoon. Vite serves `public/` in dev too, so `sw.js` is reachable there;
 * registering it is what is gated, not the file.
 *
 * `import.meta.env.PROD` is a Vite build-time constant, so the whole call is
 * eliminated from the dev bundle rather than merely skipped at runtime.
 *
 * ## Failure is not an error
 *
 * A browser with service workers disabled, a private window, an insecure
 * origin — all of these are ordinary. The dashboard works fully without a
 * worker; it just does not work *offline*. So a failed registration is logged
 * once and otherwise ignored, never surfaced to the reader as a fault.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // After `load`, deliberately: registration competes with the first render for
  // bandwidth and main-thread time otherwise, and the first paint matters more
  // than caching for a visit that has already reached the network.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      // Not console.error: nothing is broken. The app is fully usable; only
      // offline replay is unavailable.
      console.warn('watchfloor: offline support unavailable —', error);
    });
  });
}

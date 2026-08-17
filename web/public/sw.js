/* eslint-disable no-restricted-globals */
/**
 * Watchfloor service worker — offline read (M6).
 *
 * A classic script, not a module worker: module service workers only reached
 * Safari in 16.4, and iOS Safari is the target this exists for. Plain
 * `self.addEventListener` works everywhere a PWA does.
 *
 * ## The constraint that shapes everything here
 *
 * `WF_API_TOKEN` is held in memory only, for one tab's lifetime — never
 * localStorage, sessionStorage, or a cookie (web/src/auth/AuthContext.tsx
 * explains why, and a page reload deliberately clears it).
 *
 * A service worker therefore **cannot authenticate its own requests**. It has
 * no token and must never be given one. So "offline read" cannot mean "fetch
 * the feed in the background"; it can only mean "replay what this browser
 * already fetched while it was online and authenticated".
 *
 * That is what this does. Every cache entry is a response the app itself
 * obtained with a valid token. The worker never originates an API request.
 *
 * ## THE AUTHORIZATION HEADER IS STRIPPED BEFORE ANYTHING IS STORED
 *
 * `cache.put(request, response)` stores the *request* alongside the response,
 * and a Request carries its headers — including `Authorization: Bearer <the
 * token>`. Caching the request as-received would therefore write the one
 * secret this frontend holds into on-disk storage, silently undoing the
 * memory-only decision above.
 *
 * Every `put` below is keyed by a bare `new Request(url)` instead. See
 * `cacheKeyFor`.
 *
 * ## What this stores, stated plainly
 *
 * §7.1 says read/saved/dismissed state must not live in browser storage, and
 * this project extended that stance to the token itself. Caching API responses
 * is a real departure from it: feed content lands in the Cache API, on disk,
 * and is readable **without the token** by anyone with the device unlocked.
 *
 * It is a departure the brief asks for — M6's deliverable is "PWA manifest +
 * service worker for offline read", and there is no offline read without
 * stored content. It is bounded deliberately:
 *
 *   - Only `GET` responses that were `200`.
 *   - Only `/api/feed`, `/api/entities*` and `/api/dashboard/header` — the
 *     read surface. Not `/api/sources` (operational), not `/api/search`
 *     (unbounded query space), and never anything under `/api/items/` (those
 *     are state CHANGES; a cached save or dismiss would be a lie).
 *   - Never `/health`, which is unauthenticated and trivially re-fetched.
 *   - One versioned cache, so bumping CACHE_VERSION drops everything.
 *
 * The dashboard's own "offline" affordance tells the reader when what they are
 * looking at came from here rather than from the network.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `watchfloor-shell-${CACHE_VERSION}`;
const DATA_CACHE = `watchfloor-data-${CACHE_VERSION}`;

/**
 * API paths worth replaying offline. Prefix-matched against `url.pathname`.
 *
 * `/api/items/` is deliberately absent and must stay absent: those endpoints
 * mutate read/saved/dismissed state, and serving one from cache would report a
 * write that never reached the server.
 */
const CACHEABLE_API_PREFIXES = ['/api/feed', '/api/entities', '/api/dashboard/header'];

/** Decides whether a response for this request may be stored. Pure; tested. */
self.isCacheableApi = function isCacheableApi(method, pathname) {
  if (method !== 'GET') return false;
  return CACHEABLE_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}?`) || pathname.startsWith(`${p}/`));
};

/**
 * The key a response is stored under: a bare Request built from the URL only.
 *
 * This is the line that keeps `Authorization` out of storage. Pure; tested by
 * asserting the returned Request carries no headers at all.
 */
self.cacheKeyFor = function cacheKeyFor(url) {
  return new Request(url, { method: 'GET' });
};

self.addEventListener('install', (event) => {
  // No precache manifest. Vite hashes asset filenames at build time, so a
  // hardcoded list would be wrong the moment anything is rebuilt, and
  // generating one needs a build plugin this project would rather not add.
  // The shell is cached on first visit instead (see the fetch handler), which
  // costs one online load and cannot go stale against the wrong filenames.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache from an older CACHE_VERSION. This is the only place
      // the worker deletes anything, and it is bounded to caches this worker
      // created.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('watchfloor-') && n !== SHELL_CACHE && n !== DATA_CACHE)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST/DELETE go straight to the network

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch third-party requests

  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    if (!self.isCacheableApi(request.method, url.pathname)) return;
    event.respondWith(networkFirst(request, url));
    return;
  }

  event.respondWith(shellFirst(request, url));
});

/**
 * Fresh data when online; the last good copy when not.
 *
 * Network-first rather than cache-first, deliberately: this is a situational
 * awareness tool, and showing yesterday's feed to someone who has a working
 * connection would be a worse failure than a slightly slower load.
 */
async function networkFirst(request, url) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DATA_CACHE);
      // Clone before the body is consumed by the caller, and store under a
      // header-free key -- see cacheKeyFor.
      await cache.put(self.cacheKeyFor(url.href), response.clone());
    }
    return response;
  } catch (networkError) {
    const cached = await caches.match(self.cacheKeyFor(url.href));
    if (cached) {
      // Marked so the app can say "this is what you saw last time" rather than
      // presenting stale data as current.
      const headers = new Headers(cached.headers);
      headers.set('X-Watchfloor-From-Cache', '1');
      return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
    }
    throw networkError;
  }
}

/** The app shell: serve from cache when we have it, fill the cache when we don't. */
async function shellFirst(request, url) {
  const cached = await caches.match(self.cacheKeyFor(url.href));
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && (response.type === 'basic' || response.type === 'default')) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(self.cacheKeyFor(url.href), response.clone());
    }
    return response;
  } catch (networkError) {
    // A navigation with nothing cached: fall back to the app entry, so an
    // installed PWA opened offline shows the UI rather than a browser error.
    if (request.mode === 'navigate') {
      const shell = await caches.match(self.cacheKeyFor(new URL('/', self.location.origin).href));
      if (shell) return shell;
    }
    throw networkError;
  }
}

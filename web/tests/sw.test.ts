import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

/**
 * Tests the SHIPPED service worker file, not a copy of its logic.
 *
 * `web/public/sw.js` is a classic script served verbatim (it is in `public/`,
 * so Vite copies it untouched) and cannot be imported as a module. It is
 * therefore evaluated here in a `node:vm` context with a stubbed `self` —
 * which means these assertions are made against the exact bytes the browser
 * will run, rather than against a re-implementation that could drift from it.
 *
 * Only the pure decision functions are exercised. The fetch handlers need a
 * real Cache API and a real network, and asserting them here would mean
 * mocking both, which would prove only that the mocks agree with each other.
 */

const SW_PATH = join(process.cwd(), 'web', 'public', 'sw.js');

interface SwGlobals {
  isCacheableApi: (method: string, pathname: string) => boolean;
  cacheKeyFor: (url: string) => Request;
}

let sw: SwGlobals;

beforeAll(() => {
  const source = readFileSync(SW_PATH, 'utf8');
  const listeners: unknown[] = [];
  const selfStub: Record<string, unknown> = {
    addEventListener: (...args: unknown[]) => listeners.push(args),
    location: { origin: 'http://localhost:5173' },
    skipWaiting: () => undefined,
    clients: { claim: () => undefined },
  };
  const sandbox = {
    self: selfStub,
    caches: { keys: async () => [], delete: async () => true, open: async () => ({}), match: async () => undefined },
    fetch: async () => new Response(''),
    Request,
    Response,
    Headers,
    URL,
    Promise,
    console,
  };
  runInContext(source, createContext(sandbox));
  sw = selfStub as unknown as SwGlobals;
});

describe('the shipped service worker evaluates at all', () => {
  it('defines the decision functions the fetch handler depends on', () => {
    // If the file throws on evaluation, the browser registers nothing and the
    // PWA silently stops working offline. This is the cheapest possible guard
    // against a syntax error reaching a device.
    expect(typeof sw.isCacheableApi).toBe('function');
    expect(typeof sw.cacheKeyFor).toBe('function');
  });
});

describe('cacheKeyFor — the Authorization header must never reach storage', () => {
  it('produces a request carrying no headers at all', () => {
    // THE test in this file. `cache.put(request, ...)` stores the request, and
    // a Request carries its headers -- so caching the one the app sent would
    // write `Authorization: Bearer <WF_API_TOKEN>` into on-disk Cache storage,
    // silently undoing AuthContext's memory-only guarantee.
    const key = sw.cacheKeyFor('http://localhost:5173/api/feed?beat=cyber');

    expect([...key.headers.keys()]).toEqual([]);
    expect(key.headers.get('authorization')).toBeNull();
    expect(key.url).toBe('http://localhost:5173/api/feed?beat=cyber');
    expect(key.method).toBe('GET');
  });

  it('does not carry headers across even when one is set on an equivalent request', () => {
    // Non-vacuity: prove a Request CAN hold the header, so the emptiness above
    // is the function's doing and not a property of Request in this runtime.
    const withToken = new Request('http://localhost:5173/api/feed', {
      headers: { Authorization: 'Bearer super-secret-token' },
    });
    expect(withToken.headers.get('authorization')).toBe('Bearer super-secret-token');

    const key = sw.cacheKeyFor(withToken.url);
    expect(key.headers.get('authorization')).toBeNull();
  });
});

describe('isCacheableApi — what may be replayed offline', () => {
  it.each([
    ['/api/feed'],
    ['/api/feed?beat=cyber&limit=50'],
    ['/api/entities'],
    ['/api/entities/graph?entity=OpenAI'],
    ['/api/dashboard/header'],
  ])('caches the read surface: %s', (path) => {
    expect(sw.isCacheableApi('GET', path.split('?')[0]!)).toBe(true);
  });

  it('NEVER caches item state endpoints', () => {
    // A cached save or dismiss would report a write that never reached the
    // server. §7 also says dismissals are permanent -- serving one from cache
    // would make a failed dismissal look successful and unrecoverable.
    expect(sw.isCacheableApi('GET', '/api/items/abc123/state')).toBe(false);
    expect(sw.isCacheableApi('POST', '/api/items/abc123/save')).toBe(false);
  });

  it('does not cache search or source health', () => {
    // Search has an unbounded query space; source health is operational and
    // stale operational data is worse than none -- it would report a feed as
    // healthy after it started failing.
    expect(sw.isCacheableApi('GET', '/api/search')).toBe(false);
    expect(sw.isCacheableApi('GET', '/api/sources')).toBe(false);
  });

  it('only ever caches GET', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      expect(sw.isCacheableApi(method, '/api/feed')).toBe(false);
    }
  });

  it('does not match a path that merely starts with the same letters', () => {
    // `/api/feedback` must not be treated as `/api/feed`.
    expect(sw.isCacheableApi('GET', '/api/feedback')).toBe(false);
  });
});

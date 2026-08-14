// Shared mount/flush/fetch-mocking helpers for the web/tests/*.test.tsx
// suites -- extracted so the ItemRow/BeatFilter/Stream suites (M3 task 8)
// don't each reinvent App.test.tsx's original inline boilerplate. NOT a
// test file itself: this name does not match vitest.config.ts's
// `web/tests/**/*.test.tsx` include pattern, so it is never collected and
// run as its own (empty) suite.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { FeedItem, FeedResponse } from '../src/api/types.ts';

// React 19's act() requires this flag or it warns on every call, even
// though the calls below are already wrapped correctly -- a
// testing-environment declaration, not a fixture. Setting it more than
// once (once per importing test file) is harmless.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

export function mount(element: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Flushes the microtask queue inside `act` so a promise's .then()/.catch() state update lands before the next assertion. */
export async function flush(times = 3): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

/**
 * Dispatches a click INSIDE a (synchronous) `act()` call. Plain
 * `el.dispatchEvent(...)` also reaches React's event handler, but any
 * resulting `setState` then runs outside of act's tracking, which React
 * warns about even though the update is otherwise perfectly correct. Follow
 * every `actClick` that can trigger an async effect (a fetch, in this
 * codebase) with `await flush()` to let its promise settle before asserting.
 */
export function actClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Fires a real `input` event, bypassing React's tracking of the native value setter -- the standard workaround for driving a controlled input without @testing-library (not a dependency this repo has taken on). */
export function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Fetch mocking
// ---------------------------------------------------------------------------

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

export interface RouteHandler {
  match: (url: string, init: RequestInit | undefined) => boolean;
  status?: number;
  body?: unknown;
}

/**
 * A `fetch` stand-in that dispatches to whichever `RouteHandler` matches (in
 * order) and records every call it received -- so a test can assert not
 * just what rendered, but which URL (and therefore which query parameters)
 * actually reached `fetch`. That is what makes "beat filtering happens
 * server-side" and "the cursor is passed back verbatim" provable rather
 * than merely plausible: a client-side filter would never issue a second
 * `fetch` call at all, and a reconstructed cursor query would show up as an
 * extra `beat=`/`profile=` parameter on the recorded URL.
 */
export function fetchRouter(handlers: RouteHandler[]): {
  fn: ReturnType<typeof vi.fn>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const handler = handlers.find((h) => h.match(url, init));
    if (!handler) throw new Error(`fetchRouter: no handler matched ${url}`);
    return {
      ok: (handler.status ?? 200) < 400,
      status: handler.status ?? 200,
      json: async () => handler.body,
    };
  });
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// FeedItem / FeedResponse fixtures
// ---------------------------------------------------------------------------

let keyCounter = 0;

/** A syntactically-plausible 64-char hex itemKey, distinct per call. */
function fixtureItemKey(): string {
  keyCounter += 1;
  return keyCounter.toString(16).padStart(64, '0');
}

export function makeFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    itemKey: fixtureItemKey(),
    title: 'Fixture item',
    canonicalUrl: 'https://example.test/fixture',
    summary: 'A short excerpt.',
    sourceId: 'fixture-source',
    publishedAt: '2026-08-14T12:00:00.000Z',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    representativeBeat: 'usnews',
    clusterSize: 1,
    signalScore: 3.14,
    readScore: 1.5,
    sortProfile: 'signal',
    override: {
      signal: { pinned: false, priority: null, label: null },
      read: { pinned: false, priority: null, label: null },
    },
    state: { readAt: null, savedAt: null, dismissedAt: null },
    ...overrides,
  };
}

export function makeFeedResponse(overrides: Partial<FeedResponse> = {}): FeedResponse {
  return {
    items: [],
    beat: null,
    profile: 'signal',
    now: '2026-08-14T18:00:00.000Z',
    total: 0,
    nextCursor: null,
    ...overrides,
  };
}

// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { DASHBOARD_LANE_BREAKPOINT_PX, matchesWideViewport, useIsWideViewport } from '../src/lib/viewport.ts';
import { mount, type Mounted } from './testUtils.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('matchesWideViewport -- pure matchMedia read (M3 task 10)', () => {
  it('is true when the min-width query matches', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(matchesWideViewport()).toBe(true);
  });

  it('is false when the query does not match', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(matchesWideViewport()).toBe(false);
  });

  it('queries the exact breakpoint passed, defaulting to DASHBOARD_LANE_BREAKPOINT_PX', () => {
    const seen: string[] = [];
    vi.stubGlobal('matchMedia', (query: string) => {
      seen.push(query);
      return { matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} };
    });
    matchesWideViewport();
    expect(seen).toEqual([`(min-width: ${DASHBOARD_LANE_BREAKPOINT_PX}px)`]);

    matchesWideViewport(1024);
    expect(seen).toEqual([`(min-width: ${DASHBOARD_LANE_BREAKPOINT_PX}px)`, '(min-width: 1024px)']);
  });

  it('defaults to false (narrow/Stream) when matchMedia is unavailable, same guard as prefersReducedMotion', () => {
    // No stub at all -- this repo's pinned jsdom does not implement
    // matchMedia, which is exactly the environment this guard exists for.
    expect(matchesWideViewport()).toBe(false);
  });
});

describe('useIsWideViewport -- reacts to a real MediaQueryList change event', () => {
  let current: Mounted | null = null;
  afterEach(() => {
    current?.unmount();
    current = null;
  });

  function Probe(): ReturnType<typeof createElement> {
    const isWide = useIsWideViewport();
    return createElement('span', { 'data-testid': 'probe' }, isWide ? 'wide' : 'narrow');
  }

  it('reflects the initial match and updates when the MediaQueryList fires "change"', () => {
    let matches = false;
    let changeHandler: (() => void) | null = null;
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_type: string, handler: () => void) => {
        changeHandler = handler;
      },
      removeEventListener: () => {
        changeHandler = null;
      },
    }));

    current = mount(createElement(Probe));
    expect(current.container.textContent).toBe('narrow');

    matches = true;
    act(() => changeHandler?.());
    expect(current.container.textContent).toBe('wide');
  });

  it('unsubscribes on unmount -- a later change event does not throw or update anything', () => {
    let changeHandler: (() => void) | null = null;
    let unsubscribed = false;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_type: string, handler: () => void) => {
        changeHandler = handler;
      },
      removeEventListener: () => {
        unsubscribed = true;
      },
    }));

    current = mount(createElement(Probe));
    current.unmount();
    current = null;

    expect(unsubscribed).toBe(true);
    expect(() => changeHandler?.()).not.toThrow();
  });
});

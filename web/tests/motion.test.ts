// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { prefersReducedMotion, isPageVisible, onVisibilityChange } from '../src/lib/motion.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

describe('prefersReducedMotion', () => {
  it('reflects matchMedia(prefers-reduced-motion: reduce)', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(prefersReducedMotion()).toBe(true);
  });

  it('is false when the OS has no preference', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('isPageVisible / onVisibilityChange', () => {
  it('reports the current document.visibilityState', () => {
    expect(isPageVisible()).toBe(true);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    expect(isPageVisible()).toBe(false);
  });

  it('notifies subscribers on visibilitychange and unsubscribes cleanly', () => {
    const seen: boolean[] = [];
    const unsubscribe = onVisibilityChange((visible) => seen.push(visible));

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    unsubscribe();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(seen).toEqual([false]); // the post-unsubscribe event was not delivered
  });
});

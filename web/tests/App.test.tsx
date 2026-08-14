// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../src/App.tsx';

// React 19's act() requires this flag or it warns on every call, even
// though the tests are already correct -- it is a testing-environment
// declaration, not a fixture. Set once, at module load, before any render.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

function mount(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<App />));
  return container;
}

/** Fires a real React-controlled `input` event, bypassing React's synthetic
 * event wrapper's tracking of the native value setter (the standard
 * workaround for driving a controlled input without @testing-library). */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('App', () => {
  it('shows the token gate first and makes no request until a token is entered', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const el = mount();

    expect(el.textContent).toContain('Watchfloor API token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('attaches the entered token as a Bearer header and renders the real response', async () => {
    // Two live routes fire on mount once a token exists: Dashboard's own
    // '/api/dashboard/header' AND the merged stream's '/api/feed' (M3 task
    // 8) -- both are real children of App now, not just the header. A
    // blanket mockResolvedValue (as this test used before task 8) would
    // hand the header shape to Stream's fetch too, which is not a valid
    // FeedResponse and crashes rendering. Routing by URL keeps both real.
    const fetchSpy = vi.fn((url: string) => {
      if (url.startsWith('/api/dashboard/header')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            beats: {
              ai: { lastRefreshAt: null, sourceCount: 3 },
              cyber: { lastRefreshAt: null, sourceCount: 2 },
            },
            failingSources: 1,
            enrichmentSpend: { totalCents: 0 },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          items: [],
          beat: null,
          profile: 'signal',
          now: '2026-08-14T00:00:00.000Z',
          total: 0,
          nextCursor: null,
        }),
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const el = mount();
    const input = el.querySelector('#wf-token') as HTMLInputElement;
    const form = el.querySelector('form') as HTMLFormElement;

    await act(async () => {
      typeInto(input, 'a-test-token');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      // Flush the microtask queue so the fetch promise settles and its
      // .then() state update runs inside this `act`.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/dashboard/header',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer a-test-token' }),
      }),
    );
    expect(el.textContent).toContain('2 beats configured');
    expect(el.textContent).toContain('5 sources tracked');
    expect(el.textContent).toContain('1 failing');
    // The merged stream (M3 task 8) mounted and completed its own request
    // too, rendering its explicit empty state rather than being invisible
    // or crashed.
    expect(el.textContent).toContain('Nothing here right now.');
  });

  it('treats a 401 as an invalid token and returns to the gate', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetchSpy);

    const el = mount();
    const input = el.querySelector('#wf-token') as HTMLInputElement;
    const form = el.querySelector('form') as HTMLFormElement;

    await act(async () => {
      typeInto(input, 'wrong-token');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.textContent).toContain('Watchfloor API token');
  });
});

describe('App -- responsive arrangement (M3 task 10): Stream and LaneBoard are never both mounted', () => {
  function stubFetchForBothViews() {
    return vi.fn((url: string) => {
      if (url.startsWith('/api/dashboard/header')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ beats: {}, failingSources: 0, enrichmentSpend: { amountUsd: 0 } }),
        });
      }
      if (url.startsWith('/api/dashboard/layout')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            lanes: ['ai', 'cyber', 'aisec', 'repos', 'markets', 'usnews'].map((beat) => ({ beat, collapsed: false })),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ items: [], beat: null, profile: 'signal', now: '2026-08-14T00:00:00.000Z', total: 0, nextCursor: null }),
      });
    });
  }

  async function signIn(el: HTMLDivElement): Promise<void> {
    const input = el.querySelector('#wf-token') as HTMLInputElement;
    const form = el.querySelector('form') as HTMLFormElement;
    await act(async () => {
      typeInto(input, 'a-test-token');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('below ~700px (the default, no matchMedia) renders the merged Stream, never the lane board', async () => {
    // This repo's pinned jsdom implements no matchMedia at all -- the same
    // fact lib/viewport.ts's own guard exists for -- so mounting with no
    // stub at all IS the "narrow viewport" case, not an omission.
    vi.stubGlobal('fetch', stubFetchForBothViews());

    const el = mount();
    await signIn(el);

    expect(el.querySelector('.stream')).not.toBeNull();
    expect(el.querySelector('.lane-board')).toBeNull();
    expect(el.textContent).toContain('Nothing here right now.'); // Stream's own empty state
  });

  it('at/above ~700px renders the six-lane board, never the merged Stream', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.stubGlobal('fetch', stubFetchForBothViews());

    const el = mount();
    await signIn(el);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.querySelector('.lane-board')).not.toBeNull();
    expect(el.querySelector('.stream')).toBeNull();
    expect(el.querySelectorAll('.lane')).toHaveLength(6);
  });
});

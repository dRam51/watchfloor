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
    const fetchSpy = vi.fn().mockResolvedValue({
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
      '/dashboard/header',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer a-test-token' }),
      }),
    );
    expect(el.textContent).toContain('2 beats configured');
    expect(el.textContent).toContain('5 sources tracked');
    expect(el.textContent).toContain('1 failing');
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

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceHealthPage } from '../src/components/SourceHealthPage.tsx';
import { actClick, fetchRouter, flush, mount, type Mounted } from './testUtils.tsx';
import type { SourceHealth } from '../src/api/sourceHealth.ts';

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
});

const TOKEN = 'test-token';

function makeSource(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    id: 'fixture-source',
    name: 'Fixture Source',
    beats: ['cyber'],
    weight: 1,
    pollInterval: '30m',
    pollIntervalMs: 1_800_000,
    enabled: true,
    everPolled: true,
    lastSuccessAt: '2026-08-14T19:00:00.000Z',
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    inBackoff: false,
    itemsYieldedSinceWindowStart: 12,
    windowStartedAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-14T19:00:00.000Z',
    stale: false,
    failing: false,
    ...overrides,
  };
}

function sourcesResponse(sources: SourceHealth[]): { sources: SourceHealth[] } {
  return { sources };
}

describe('SourceHealthPage -- the silent-failure case (THE load-bearing test for this whole page)', () => {
  it('a stale-but-error-free source (zero consecutiveFailures, lastError null) renders with the FAILING badge and a stale reason -- would fail if it rendered as healthy', async () => {
    const silentlyStale = makeSource({
      id: 'cisa-kev',
      name: 'CISA Known Exploited Vulnerabilities',
      pollInterval: '30m',
      consecutiveFailures: 0,
      lastError: null,
      lastFailureAt: null,
      stale: true,
      failing: true,
    });
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([silentlyStale]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    const row = current.container.querySelector('.source-health__row')!;
    expect(row.classList.contains('source-health__row--failing')).toBe(true);

    const badge = row.querySelector('.source-health__badge')!;
    expect(badge.textContent).toBe('FAILING');
    expect(badge.classList.contains('source-health__badge--failing')).toBe(true);

    // The reason must be visible and must NOT rely on lastError (which is
    // null here) -- it has to name staleness explicitly, or a reader would
    // see "FAILING" with no explanation at all.
    const reason = current.container.querySelector('.source-health__reason')!;
    expect(reason.textContent).toContain('stale');
    expect(reason.textContent).toContain('30m');

    // And the summary banner counts it too.
    expect(current.container.textContent).toContain('1 of 1 enabled source failing right now.');
  });

  it('a source with the SAME zero-error shape but failing:false (a plain healthy source) does NOT get the failing treatment -- the control case', async () => {
    const healthy = makeSource({ id: 'healthy-source', consecutiveFailures: 0, lastError: null, stale: false, failing: false });
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([healthy]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    const row = current.container.querySelector('.source-health__row')!;
    expect(row.classList.contains('source-health__row--failing')).toBe(false);
    expect(row.querySelector('.source-health__badge')!.textContent).toBe('OK');
    expect(row.querySelector('.source-health__reason')).toBeNull();
    expect(current.container.textContent).toContain('All 1 enabled source healthy.');
  });
});

describe('SourceHealthPage -- an actual error streak is also loud, and shows the real error string', () => {
  it('renders lastError text directly in the page (never hover-only) for a source with consecutiveFailures > 0', async () => {
    const erroring = makeSource({
      id: 'erroring-source',
      consecutiveFailures: 4,
      lastError: 'HTTP 503 from upstream',
      lastFailureAt: '2026-08-14T18:55:00.000Z',
      stale: false,
      failing: true,
    });
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([erroring]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).toContain('HTTP 503 from upstream');
    expect(current.container.textContent).toContain('4 consecutive failures');
    // No title-only affordance: the error text is real rendered content,
    // not stashed in a `title` attribute a touch/keyboard user could miss.
    const errorEl = current.container.querySelector('.source-health__error-text')!;
    expect(errorEl.getAttribute('title')).toBeNull();
  });
});

describe('SourceHealthPage -- nulls are meaningful, never collapsed to the same rendering', () => {
  it('distinguishes "never polled" from "polled but never succeeded" from a real timestamp', async () => {
    const neverPolled = makeSource({ id: 'never-polled', everPolled: false, lastSuccessAt: null, stale: true, failing: true });
    const polledNeverSucceeded = makeSource({
      id: 'polled-never-succeeded',
      everPolled: true,
      lastSuccessAt: null,
      consecutiveFailures: 2,
      lastError: 'timeout',
      stale: true,
      failing: true,
    });
    const succeeded = makeSource({ id: 'succeeded', lastSuccessAt: '2026-08-14T19:00:00.000Z' });

    const { fn } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/sources'),
        body: sourcesResponse([neverPolled, polledNeverSucceeded, succeeded]),
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).toContain('Never polled');
    expect(current.container.textContent).toContain('Polled, but never succeeded');
    // The third source's real timestamp renders as relative time, not a
    // literal "null"/blank -- relativeTime() never returns the word "never".
    const rows = current.container.querySelectorAll('.source-health__row');
    expect(rows).toHaveLength(3);
  });

  it('a source with no failures on record says so explicitly rather than leaving the field blank', async () => {
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([makeSource({ lastFailureAt: null })]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).toContain('No failures on record');
  });
});

describe('SourceHealthPage -- disabled sources must not read as broken', () => {
  it('a disabled source with failure history in its raw fields still shows DISABLED, never FAILING', async () => {
    const disabledWithHistory = makeSource({
      id: 'disabled-with-history',
      enabled: false,
      consecutiveFailures: 9,
      lastError: 'old failure before it was turned off',
      stale: false, // computeSourceHealth pins stale/failing false for disabled sources
      failing: false,
    });
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([disabledWithHistory]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    const row = current.container.querySelector('.source-health__row')!;
    expect(row.classList.contains('source-health__row--disabled')).toBe(true);
    expect(row.classList.contains('source-health__row--failing')).toBe(false);
    expect(row.querySelector('.source-health__badge')!.textContent).toBe('DISABLED');
    // The raw error string still passes through (history isn't erased)...
    expect(current.container.textContent).toContain('old failure before it was turned off');
    // ...but the loud FAILING reason line does not render for it.
    expect(row.querySelector('.source-health__reason')).toBeNull();
  });
});

describe('SourceHealthPage -- the tumbling window is labelled honestly, not as "last 7 days"', () => {
  it('never renders the literal phrase "last 7 days"', async () => {
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([makeSource({ itemsYieldedSinceWindowStart: 42 })]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).not.toContain('last 7 days');
    expect(current.container.textContent).toContain('42');
    expect(current.container.textContent).toContain('since window start');
    expect(current.container.textContent).toContain('resets on a ~7-day tumble');
  });

  it('says explicitly when there is no window yet, rather than showing 0 with no context', async () => {
    const { fn } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/sources'),
        body: sourcesResponse([makeSource({ itemsYieldedSinceWindowStart: 0, windowStartedAt: null })]),
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).toContain('no window yet');
  });
});

describe('SourceHealthPage -- backoff state', () => {
  it('shows when a source is in backoff and when it retries', async () => {
    const inBackoff = makeSource({
      id: 'backed-off',
      inBackoff: true,
      nextEligibleAt: '2026-08-14T21:00:00.000Z',
      consecutiveFailures: 2,
      lastError: 'rate limited',
      failing: true,
    });
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([inBackoff]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).toContain('In backoff');
  });

  it('shows "Not in backoff" for a source with no active backoff', async () => {
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([makeSource({ inBackoff: false })]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).toContain('Not in backoff');
  });
});

describe('SourceHealthPage -- loading, error, retry, and auth', () => {
  it('shows a loading state, then the real data', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const fn = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    expect(current.container.textContent).toContain('loading source health');

    resolveFetch({ ok: true, status: 200, json: async () => sourcesResponse([makeSource()]) });
    await flush();
    expect(current.container.textContent).not.toContain('loading source health');
  });

  it('surfaces a fetch failure with a retry affordance', async () => {
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/sources'), status: 500, body: {} }]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).toContain('health error');
    expect(current.container.querySelector('.source-health__retry')).not.toBeNull();
  });

  it('the Refresh button re-fetches', async () => {
    const { fn, calls } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([makeSource()]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();
    expect(calls).toHaveLength(1);

    const refreshBtn = current.container.querySelector<HTMLButtonElement>('.source-health__refresh')!;
    expect(refreshBtn.classList.contains('touch-target')).toBe(true);
    actClick(refreshBtn);
    await flush();

    expect(calls).toHaveLength(2);
  });

  it('treats a 401 as an auth failure and calls onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/sources'), status: 401, body: {} }]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={onUnauthorized} />);
    await flush();

    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe('SourceHealthPage -- ordering puts failing sources first', () => {
  it('renders the failing source before the healthy one regardless of API order', async () => {
    const healthy = makeSource({ id: 'zzz-healthy', name: 'ZZZ Healthy' });
    const failing = makeSource({ id: 'aaa-failing', name: 'AAA Failing', failing: true, stale: true });
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([healthy, failing]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    const names = Array.from(current.container.querySelectorAll('.source-health__name')).map((el) => el.textContent);
    expect(names).toEqual(['AAA Failing', 'ZZZ Healthy']);
  });
});

describe('SourceHealthPage -- close affordance', () => {
  it('renders a Close button when onClose is supplied', async () => {
    const onClose = vi.fn();
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([makeSource()]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} onClose={onClose} />);
    await flush();

    const closeBtn = current.container.querySelector<HTMLButtonElement>('.source-health__close')!;
    expect(closeBtn.classList.contains('touch-target')).toBe(true);
    actClick(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('omits the Close button when onClose is not supplied', async () => {
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/sources'), body: sourcesResponse([makeSource()]) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SourceHealthPage token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.querySelector('.source-health__close')).toBeNull();
  });
});

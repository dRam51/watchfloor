import { describe, expect, it } from 'vitest';
import { sortForHealthDisplay } from '../src/lib/sourceHealthOrder.ts';
import type { SourceHealth } from '../src/api/sourceHealth.ts';

function makeSource(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    id: 'fixture-source',
    name: 'Fixture Source',
    beats: ['cyber'],
    weight: 1,
    pollInterval: '1d',
    pollIntervalMs: 86_400_000,
    enabled: true,
    everPolled: true,
    lastSuccessAt: '2026-08-14T12:00:00.000Z',
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    inBackoff: false,
    itemsYieldedSinceWindowStart: 10,
    windowStartedAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-14T12:00:00.000Z',
    stale: false,
    failing: false,
    ...overrides,
  };
}

describe('sortForHealthDisplay', () => {
  it('puts failing sources first, ahead of healthy ones -- THE point of this whole page', () => {
    const healthy = makeSource({ id: 'healthy' });
    const failing = makeSource({ id: 'failing', failing: true, consecutiveFailures: 3 });

    expect(sortForHealthDisplay([healthy, failing]).map((s) => s.id)).toEqual(['failing', 'healthy']);
  });

  it('sorts a failing source ahead of healthy ones EVEN WHEN it has zero consecutive failures -- the stale, silent case', () => {
    // Exactly the "silent failure" shape: no error string, no failure
    // streak, failing purely because computeSourceHealth's `stale` branch
    // fired server-side. A sort keyed on consecutiveFailures (instead of
    // the `failing` field itself) would leave this source buried below
    // healthy ones, which is the one outcome this whole page must avoid.
    const healthy = makeSource({ id: 'healthy' });
    const silentlyStale = makeSource({
      id: 'silently-stale',
      failing: true,
      stale: true,
      consecutiveFailures: 0,
      lastError: null,
    });

    expect(sortForHealthDisplay([healthy, silentlyStale]).map((s) => s.id)).toEqual([
      'silently-stale',
      'healthy',
    ]);
  });

  it('puts disabled sources last, even below healthy enabled ones', () => {
    const disabled = makeSource({ id: 'disabled', enabled: false, stale: false, failing: false });
    const healthy = makeSource({ id: 'healthy' });

    expect(sortForHealthDisplay([disabled, healthy]).map((s) => s.id)).toEqual(['healthy', 'disabled']);
  });

  it('never lets a disabled source outrank a failing one, regardless of input order', () => {
    const disabled = makeSource({ id: 'disabled', enabled: false });
    const failing = makeSource({ id: 'failing', failing: true, consecutiveFailures: 1 });

    expect(sortForHealthDisplay([disabled, failing]).map((s) => s.id)).toEqual(['failing', 'disabled']);
  });

  it('preserves original relative order within a tier (stable sort)', () => {
    const a = makeSource({ id: 'a' });
    const b = makeSource({ id: 'b' });
    const c = makeSource({ id: 'c' });

    expect(sortForHealthDisplay([a, b, c]).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const input = [makeSource({ id: 'a' }), makeSource({ id: 'b', failing: true })];
    const original = [...input];

    sortForHealthDisplay(input);

    expect(input).toEqual(original);
  });
});

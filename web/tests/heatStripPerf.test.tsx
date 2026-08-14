// @vitest-environment jsdom
//
// M3 task 12 DoD 5: "Performance measured, not assumed -- report the
// numbers, especially for six simultaneous heat strips." This file is that
// measurement, not a strict CI gate: jsdom's DOM implementation is not a
// real browser's paint/layout pipeline, so the absolute numbers here are a
// proxy for "does this scale reasonably", not a literal frame-budget claim.
// Thresholds are deliberately generous (order-of-magnitude headroom over
// what was actually observed while writing this) so the assertion catches a
// genuine algorithmic regression (e.g. an accidental O(n^2)) without being
// flaky on a slower CI machine. The real numbers this test prints are what
// the task report quotes.
import { describe, expect, it } from 'vitest';
import { bucketByHour } from '../src/lib/heatStrip.ts';
import { HeatStrip } from '../src/components/HeatStrip.tsx';
import { makeFeedItem, mount } from './testUtils.tsx';

const NOW_MS = Date.parse('2026-08-14T18:00:00.000Z');
const HOUR_MS = 3_600_000;

/** `count` items spread across a 48h span (half fall inside the 24h window,
 * half outside it -- the mixed shape a real corpus has, per CLAUDE.md's
 * cisa-kev note), publishedAt varying enough that no two items land in
 * exactly the same millisecond. */
function realisticItems(count: number): ReturnType<typeof makeFeedItem>[] {
  return Array.from({ length: count }, (_, i) => {
    const offsetMs = (i % 48) * HOUR_MS + (i * 997) % HOUR_MS;
    return makeFeedItem({ publishedAt: new Date(NOW_MS - offsetMs).toISOString() });
  });
}

describe('bucketByHour -- pure computation cost', () => {
  it('buckets 1,200 items (six lanes x 200, a generous upper bound on a real lane page) well under a frame budget', () => {
    const items = realisticItems(1200);
    const start = performance.now();
    const data = bucketByHour(items, NOW_MS);
    const elapsedMs = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`[perf] bucketByHour(1200 items): ${elapsedMs.toFixed(3)}ms`);
    expect(data.total).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe('HeatStrip -- six simultaneous mounts (LaneBoard scale)', () => {
  it('mounts six 200-item HeatStrips (the real LaneBoard shape) within budget', () => {
    const lanesItems = Array.from({ length: 6 }, () => realisticItems(200));

    const start = performance.now();
    const mounted = lanesItems.map((items) => mount(<HeatStrip items={items} now={NOW_MS} />));
    const elapsedMs = performance.now() - start;

    // eslint-disable-next-line no-console
    console.log(
      `[perf] six HeatStrip mounts x 200 items each: ${elapsedMs.toFixed(2)}ms total, ` +
        `${(elapsedMs / 6).toFixed(2)}ms/lane (jsdom, not a real browser paint)`,
    );

    mounted.forEach((m) => {
      expect(m.container.querySelectorAll('.heat-strip__bar')).toHaveLength(24);
    });
    mounted.forEach((m) => m.unmount());

    expect(elapsedMs).toBeLessThan(1000);
  });

  it('20 independent mount/unmount cycles of one 200-item HeatStrip stay cheap per cycle (a proxy for repeated lane refreshes)', () => {
    const items = realisticItems(200);
    const start = performance.now();
    for (let i = 0; i < 20; i += 1) {
      const m = mount(<HeatStrip items={items} now={NOW_MS} />);
      expect(m.container.querySelectorAll('.heat-strip__bar')).toHaveLength(24);
      m.unmount();
    }
    const elapsedMs = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(
      `[perf] 20 mount/unmount cycles of one 200-item HeatStrip: ${elapsedMs.toFixed(2)}ms total, ` +
        `${(elapsedMs / 20).toFixed(2)}ms/cycle`,
    );
    expect(elapsedMs).toBeLessThan(2000);
  });
});

import { describe, expect, it } from 'vitest';
import { bucketByHour, HEAT_STRIP_BUCKET_HOURS } from '../src/lib/heatStrip.ts';
import { makeFeedItem } from './testUtils.tsx';

const NOW_MS = Date.parse('2026-08-14T18:00:00.000Z');
const HOUR_MS = 3_600_000;

function publishedHoursAgo(hours: number): string {
  return new Date(NOW_MS - hours * HOUR_MS).toISOString();
}

describe('bucketByHour -- shape', () => {
  it('always returns HEAT_STRIP_BUCKET_HOURS buckets, even for zero items', () => {
    const data = bucketByHour([], NOW_MS);
    expect(data.buckets).toHaveLength(HEAT_STRIP_BUCKET_HOURS);
    expect(data.buckets.every((c) => c === 0)).toBe(true);
    expect(data.total).toBe(0);
    expect(data.max).toBe(0);
  });
});

describe('bucketByHour -- publishedAt placement', () => {
  it('places an item published a few minutes ago in the most-recent (last) bucket', () => {
    const item = makeFeedItem({ publishedAt: publishedHoursAgo(0.1) });
    const data = bucketByHour([item], NOW_MS);
    expect(data.buckets[HEAT_STRIP_BUCKET_HOURS - 1]).toBe(1);
    expect(data.total).toBe(1);
  });

  it('places an item published ~23.5h ago in the oldest (first) bucket', () => {
    const item = makeFeedItem({ publishedAt: publishedHoursAgo(23.5) });
    const data = bucketByHour([item], NOW_MS);
    expect(data.buckets[0]).toBe(1);
  });

  it('counts multiple items landing in the same hour together', () => {
    const items = [
      makeFeedItem({ publishedAt: publishedHoursAgo(2.1) }),
      makeFeedItem({ publishedAt: publishedHoursAgo(2.2) }),
      makeFeedItem({ publishedAt: publishedHoursAgo(2.9) }),
    ];
    const data = bucketByHour(items, NOW_MS);
    expect(data.total).toBe(3);
    expect(data.max).toBe(3);
  });
});

describe('bucketByHour -- the cisa-kev historical-dump case (task brief: "will look wrong under one of them")', () => {
  it('a source dumping its full historical catalog falls OUTSIDE the 24h window entirely, not into "now"', () => {
    // cisa-kev-shaped: hundreds of entries published months/years ago,
    // arriving in one fetch. Bucketing by publishedAt (this module's
    // choice, see its own doc comment) means none of them inflate the
    // strip -- if this were bucketed by ARRIVAL instead, all of these
    // would land in one bucket and paint a false spike.
    const historicalDump = Array.from({ length: 200 }, (_, i) =>
      makeFeedItem({ publishedAt: new Date(NOW_MS - (30 * 24 + i) * HOUR_MS).toISOString() }),
    );
    const data = bucketByHour(historicalDump, NOW_MS);
    expect(data.total).toBe(0);
    expect(data.buckets.every((c) => c === 0)).toBe(true);
  });

  it('a genuinely fresh item published seconds ago among an old dump still shows up, correctly isolated', () => {
    const items = [
      ...Array.from({ length: 50 }, () => makeFeedItem({ publishedAt: publishedHoursAgo(24 * 90) })),
      makeFeedItem({ publishedAt: publishedHoursAgo(0.01) }),
    ];
    const data = bucketByHour(items, NOW_MS);
    expect(data.total).toBe(1);
    expect(data.buckets[HEAT_STRIP_BUCKET_HOURS - 1]).toBe(1);
  });
});

describe('bucketByHour -- null and unparseable publishedAt (schema allows null in principle)', () => {
  it('skips a null publishedAt rather than guessing a bucket for it', () => {
    const items = [makeFeedItem({ publishedAt: null }), makeFeedItem({ publishedAt: publishedHoursAgo(1) })];
    const data = bucketByHour(items, NOW_MS);
    expect(data.total).toBe(1);
  });

  it('skips an unparseable publishedAt defensively rather than throwing or producing NaN math', () => {
    const items = [makeFeedItem({ publishedAt: 'not-a-real-timestamp' })];
    expect(() => bucketByHour(items, NOW_MS)).not.toThrow();
    expect(bucketByHour(items, NOW_MS).total).toBe(0);
  });
});

describe('bucketByHour -- future-dated items (clock skew)', () => {
  it('skips an item published after `nowMs` rather than clamping it into the latest bucket', () => {
    const item = makeFeedItem({ publishedAt: new Date(NOW_MS + HOUR_MS).toISOString() });
    const data = bucketByHour([item], NOW_MS);
    expect(data.total).toBe(0);
  });
});

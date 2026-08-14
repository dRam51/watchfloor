import { useMemo, type CSSProperties } from 'react';
import type { FeedItem } from '../api/types.ts';
import { bucketByHour } from '../lib/heatStrip.ts';

/**
 * The thin 24h activity histogram at the top of each lane (M3 task 12,
 * §7.4: "a thin 24h activity histogram at the top of each lane showing when
 * items landed, so a quiet vs. loud news day is visible at a glance").
 *
 * Purely derived from whatever `items` its caller (`Lane.tsx`) already has
 * loaded -- no fetch of its own, so it never delays or blocks data (§7.4:
 * "nothing visual may block or delay data"). See `lib/heatStrip.ts`'s own
 * doc comment for why bucketing is by `publishedAt`, not arrival time.
 *
 * ALWAYS RENDERS 24 BARS, even for zero items -- `repos`/`markets` sit
 * empty until M4a/M4b (task brief, "things that will look like bugs"), and
 * an empty lane's strip must read as a flat, quiet line, not a missing or
 * broken element. No charting library: 24 `<span>`s, matching the brief's
 * "a handful of divs" suggestion.
 *
 * No animation of any kind -- this is a static snapshot of already-fetched
 * data, recomputed only when `items` itself changes (a fresh fetch, load
 * more, or a per-row state mutation in this lane), never on a ticking
 * clock. §7.4's rAF/pause-when-hidden/reduced-motion rules govern
 * CONTINUOUS animations (the deferred ticker tape and sparklines); there is
 * no loop here for any of that to apply to.
 */
export interface HeatStripProps {
  items: FeedItem[];
  /** Test seam only -- production callers never pass this. Defaults to the
   * real wall clock at the moment `items` last changed (mirrors
   * `relativeTime.ts`'s identical `now` convention). */
  now?: number;
}

export function HeatStrip({ items, now }: HeatStripProps) {
  const data = useMemo(() => bucketByHour(items, now ?? Date.now()), [items, now]);

  const label =
    data.total === 0
      ? 'No activity in the last 24 hours'
      : `${data.total} item${data.total === 1 ? '' : 's'} published in the last 24 hours`;

  return (
    <div className="heat-strip" role="img" aria-label={label}>
      {data.buckets.map((count, index) => (
        <span
          key={index}
          className="heat-strip__bar"
          aria-hidden="true"
          style={{ '--heat': data.max > 0 ? count / data.max : 0 } as CSSProperties}
        />
      ))}
    </div>
  );
}

import type { FeedItem } from '../api/types.ts';

/**
 * The pure bucketing math behind `HeatStrip` (M3 task 12, §7.4: "a thin 24h
 * activity histogram at the top of each lane showing when items landed").
 *
 * BUCKETED BY `publishedAt`, NOT ARRIVAL/INGEST TIME -- a deliberate choice,
 * for two independent reasons:
 *
 * 1. It's the only timestamp available. `GET /api/feed`'s wire contract
 *    (docs/api.md) carries `publishedAt` on every item and nothing else
 *    resembling a per-item "when did Watchfloor's ingest pipeline first see
 *    this" field -- no `fetchedAt`/`firstSeenAt` is returned to the client.
 *    Bucketing by arrival would require a new API field, which is out of
 *    scope here (this task must not touch `src/`; the backend is complete).
 *
 * 2. It's also the semantically honest answer to "was today a loud or quiet
 *    news day", which is what §7.4 asks the strip to show. CLAUDE.md
 *    records that `cisa-kev` "dumps its full historical catalog" on
 *    ordinary polls -- a source that redelivers hundreds of years-old CVE
 *    entries in one fetch. Bucketing by ARRIVAL would paint that fetch as a
 *    false spike on whatever hour it happened to land (hundreds of items
 *    "landing" in one bucket that were not, in any real sense, news that
 *    hour). Bucketing by `publishedAt` instead makes that same dump fall
 *    OUTSIDE the 24h window entirely -- correctly invisible, since none of
 *    those vulnerabilities were actually disclosed in the last day. A quiet
 *    hour reads as quiet; a bulk historical re-delivery does not masquerade
 *    as a loud one.
 *
 * `publishedAt` can be `null` in principle (the schema allows it, 0% on the
 * current corpus per CLAUDE.md) -- those items are skipped, not guessed
 * into a bucket. An item published before the window or (clock skew)
 * slightly after `nowMs` is also skipped rather than clamped into the
 * nearest edge bucket, for the same reason as the KEV case above: silently
 * clamping old items into "now" would manufacture activity that didn't
 * happen in the window being displayed.
 */
export const HEAT_STRIP_BUCKET_HOURS = 24;
const HOUR_MS = 3_600_000;

export interface HeatStripData {
  /** Length `HEAT_STRIP_BUCKET_HOURS`, oldest hour first, `nowMs`'s hour last. */
  buckets: number[];
  /** Sum of `buckets` -- items that actually landed inside the 24h window (may be less than `items.length`). */
  total: number;
  /** The largest single bucket count, `>= 0`. Used to scale bar heights relative to this lane's own busiest hour. */
  max: number;
}

/**
 * `nowMs` is an explicit parameter (never read internally) for the same
 * reason `relativeTime`'s `now` is -- deterministic, clock-free tests --
 * matching this codebase's "now is always a parameter" convention
 * (src/score/decay.ts).
 */
export function bucketByHour(items: readonly FeedItem[], nowMs: number): HeatStripData {
  const buckets = new Array<number>(HEAT_STRIP_BUCKET_HOURS).fill(0);
  const windowStartMs = nowMs - HEAT_STRIP_BUCKET_HOURS * HOUR_MS;

  for (const item of items) {
    if (item.publishedAt === null) continue;
    const publishedMs = Date.parse(item.publishedAt);
    if (!Number.isFinite(publishedMs)) continue;
    if (publishedMs < windowStartMs || publishedMs > nowMs) continue;

    const rawIndex = Math.floor((publishedMs - windowStartMs) / HOUR_MS);
    const index = Math.min(HEAT_STRIP_BUCKET_HOURS - 1, Math.max(0, rawIndex));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }

  let total = 0;
  let max = 0;
  for (const count of buckets) {
    total += count;
    if (count > max) max = count;
  }

  return { buckets, total, max };
}

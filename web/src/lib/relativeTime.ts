/**
 * Formats an item's `publishedAt` as a short relative string ("3m ago",
 * "5h ago", "2d ago"). Deliberately a plain function, not a date library --
 * the task brief calls this out explicitly as "a small function", and one
 * more dependency for this is not warranted (repo-wide "no new dependencies"
 * constraint, M3 plan).
 *
 * WALL-CLOCK, NOT THE FEED'S PINNED `now`: src/api/routes/feed.ts pins `now`
 * in the pagination cursor so that RANKING is a stable snapshot -- but how
 * long ago something was published is a fact about the published date, not
 * about the ranking instant, and a user re-reading a page that has sat open
 * for ten minutes expects "12m ago" to keep advancing, not to stay frozen at
 * whatever `now` page 1 happened to load with. So this reads `Date.now()` at
 * call time by default; `now` is an explicit parameter purely so tests don't
 * depend on the real clock (mirrors the rest of this codebase's "now is
 * always a parameter" convention -- src/score/decay.ts, this module's own
 * spirit if not its literal contract, since this one file is allowed to
 * default to the real clock because it is a pure display concern with no
 * correctness implication).
 */
export function relativeTime(publishedAt: string | null, now: Date = new Date()): string {
  if (publishedAt === null) return 'undated';

  const then = new Date(publishedAt).getTime();
  if (!Number.isFinite(then)) return 'undated';

  const diffMs = now.getTime() - then;
  // A publish date in the future (clock skew, or a source that pre-dates its
  // own item) reads as "just now" rather than a nonsensical negative value.
  if (diffMs < 60_000) return 'just now';

  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;

  const diffYear = Math.floor(diffDay / 365);
  return `${diffYear}y ago`;
}

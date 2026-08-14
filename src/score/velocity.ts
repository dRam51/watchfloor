import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import { localDay, getSnapshotWindow, type SnapshotWindow } from '../db/repoSnapshots.ts';

export const DEFAULT_WINDOW_DAYS = 7;

/**
 * The smallest elapsed span between the two readings a rate is computed from.
 *
 * Not a count of readings -- a SPAN, measured from the observation instants.
 * See the module doc comment ("The gate is span, not count") for why, and for
 * why 3 rather than 1 or 6.
 */
export const DEFAULT_MIN_SPAN_DAYS = 3;

/** One end of the measured interval. */
export interface VelocityEndpoint {
  /** The calendar day in the zone the reading was bucketed under. */
  day: string;
  stars: number;
  /** The canonical UTC instant the reading was actually taken. */
  observedAt: string;
}

export interface VelocityWindowFacts {
  repoId: number;
  fromDay: string;
  throughDay: string;
  expectedDays: number;
  observedDays: number;
  missingDays: string[];
}

export interface VelocityOk extends VelocityWindowFacts {
  status: 'ok';
  /** Signed. Negative is real data -- see the module doc comment, point 3. */
  starsPerDay: number;
  /** `last.stars - first.stars`, so `starsPerDay` is auditable, not opaque. */
  starsGained: number;
  /** Elapsed days between the two observation INSTANTS. Fractional. */
  spanDays: number;
  /**
   * `spanDays` as a fraction of the most the window could possibly span,
   * clamped to [0, 1]. The lever a ranker uses to stop a barely-qualifying
   * sample beating a full one on equal terms. Not a statistical confidence.
   */
  spanCoverage: number;
  /**
   * Whole days between the newest reading and the end of the window. Nonzero
   * means this rate describes an interval that stopped `staleDays` ago.
   * Reported, never gated -- see the module doc comment, point 4.
   */
  staleDays: number;
  first: VelocityEndpoint;
  last: VelocityEndpoint;
  mixedTimezone: boolean;
}

export type InsufficientReason = 'no_snapshots' | 'single_snapshot' | 'span_too_short';

export interface VelocityInsufficient extends VelocityWindowFacts {
  status: 'insufficient_history';
  reason: InsufficientReason;
  /** Elapsed days between the oldest and newest reading; 0 when under two. */
  spanDays: number;
  /** The floor `spanDays` failed to reach. */
  minSpanDays: number;
}

export type VelocityResult = VelocityOk | VelocityInsufficient;

const DAY_MS = 86_400_000;

function facts(window: SnapshotWindow): VelocityWindowFacts {
  return {
    repoId: window.repoId,
    fromDay: window.fromDay,
    throughDay: window.throughDay,
    expectedDays: window.expectedDays,
    observedDays: window.observedDays,
    missingDays: window.missingDays,
  };
}

/** The pure core: velocity from an already-read window. No database, no clock. */
export function starVelocityFromWindow(
  window: SnapshotWindow,
  minSpanDays: number = DEFAULT_MIN_SPAN_DAYS,
): VelocityResult {
  if (!(minSpanDays > 0) || !Number.isFinite(minSpanDays)) {
    throw new RangeError(`minSpanDays must be a positive finite number, got ${minSpanDays}`);
  }

  const snapshots = window.snapshots;
  const refuse = (reason: InsufficientReason, spanDays: number): VelocityInsufficient => ({
    ...facts(window),
    status: 'insufficient_history',
    reason,
    spanDays,
    minSpanDays,
  });

  if (snapshots.length === 0) return refuse('no_snapshots', 0);
  if (snapshots.length === 1) return refuse('single_snapshot', 0);

  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const spanDays = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / DAY_MS;
  if (spanDays < minSpanDays) return refuse('span_too_short', spanDays);

  const starsGained = last.stars - first.stars;

  return {
    ...facts(window),
    status: 'ok',
    // No clamp, in either direction -- module doc comment, point 3.
    starsPerDay: starsGained / spanDays,
    starsGained,
    spanDays,
    // A `days`-day window holds `days` day LABELS, so the furthest apart two
    // of them can be is `days - 1`. Real observation instants can exceed that
    // by up to a day (00:30 on the first, 23:30 on the last), hence the clamp
    // -- a coverage above 1 would be a fraction that is not one.
    spanCoverage: Math.min(1, spanDays / (window.expectedDays - 1)),
    // No date arithmetic: `missingDays` already covers exactly this window,
    // and `last.snapshotDay` is its newest OBSERVED day, so every window day
    // after it is by definition missing. Lexicographic `>` is chronological
    // at this fixed YYYY-MM-DD width -- the same property every read in
    // src/db/repoSnapshots.ts relies on.
    staleDays: window.missingDays.filter((day) => day > last.snapshotDay).length,
    first: { day: first.snapshotDay, stars: first.stars, observedAt: first.observedAt },
    last: { day: last.snapshotDay, stars: last.stars, observedAt: last.observedAt },
    mixedTimezone: window.mixedTimezone,
  };
}

export interface VelocityOptions {
  /** Canonical UTC instant. Always injected -- this module reads no clock. */
  now: string;
  /** The zone snapshot days are bucketed in (WF_TZ). Always explicit. */
  tz: string;
  windowDays?: number;
  minSpanDays?: number;
}

/** Reads the trailing window for `repoId` and computes its star velocity. */
export function computeStarVelocity(
  db: Db,
  repoId: number,
  opts: VelocityOptions,
): VelocityResult {
  assertCanonicalTimestamp('now', opts.now);
  const days = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minSpanDays = opts.minSpanDays ?? DEFAULT_MIN_SPAN_DAYS;

  // Both of these make velocity permanently uncomputable rather than merely
  // unavailable-for-now, so they fail loudly at the call rather than
  // returning an insufficient_history a reader would take for "not yet".
  if (!Number.isInteger(days) || days < 2) {
    throw new RangeError(
      `windowDays must be an integer >= 2 (a shorter window holds no two days to measure between), got ${days}`,
    );
  }
  if (minSpanDays > days - 1) {
    throw new RangeError(
      `minSpanDays ${minSpanDays} exceeds the ${days - 1} days a ${days}-day window can span`,
    );
  }

  const window = getSnapshotWindow(db, repoId, {
    throughDay: localDay(opts.now, opts.tz),
    days,
  });
  return starVelocityFromWindow(window, minSpanDays);
}

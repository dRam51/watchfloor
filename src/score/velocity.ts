import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import { localDay, getSnapshotWindow, type SnapshotWindow } from '../db/repoSnapshots.ts';

export const DEFAULT_WINDOW_DAYS = 7;

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
  starsPerDay: number;
  starsGained: number;
  spanDays: number;
  first: VelocityEndpoint;
  last: VelocityEndpoint;
  mixedTimezone: boolean;
}

export type InsufficientReason = 'no_snapshots';

export interface VelocityInsufficient extends VelocityWindowFacts {
  status: 'insufficient_history';
  reason: InsufficientReason;
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
export function starVelocityFromWindow(window: SnapshotWindow): VelocityResult {
  const snapshots = window.snapshots;
  if (snapshots.length === 0) {
    return { ...facts(window), status: 'insufficient_history', reason: 'no_snapshots' };
  }

  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const spanDays = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / DAY_MS;
  const starsGained = last.stars - first.stars;

  return {
    ...facts(window),
    status: 'ok',
    starsPerDay: starsGained / spanDays,
    starsGained,
    spanDays,
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
}

/** Reads the trailing window for `repoId` and computes its star velocity. */
export function computeStarVelocity(
  db: Db,
  repoId: number,
  opts: VelocityOptions,
): VelocityResult {
  assertCanonicalTimestamp('now', opts.now);
  const days = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const window = getSnapshotWindow(db, repoId, {
    throughDay: localDay(opts.now, opts.tz),
    days,
  });
  return starVelocityFromWindow(window);
}

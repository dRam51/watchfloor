import type { Db } from './connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';

/**
 * Converts a canonical UTC instant to the calendar date it falls on **in
 * `tz`** -- the zone the caller supplies, which in this system is always
 * `WF_TZ` (src/config/env.ts). The zone is a required parameter and this
 * module never reads `process.env.TZ`, the host clock's zone, or a default:
 * CLAUDE.md's portability rule is "TZ set explicitly in config and every
 * schedule derived from it -- never read the system timezone", and a snapshot
 * DAY is exactly such a derived schedule quantity.
 */
export function localDay(instant: string, tz: string): string {
  assertCanonicalTimestamp('instant', instant);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A snapshot day is a plain calendar LABEL (YYYY-MM-DD), not an instant. It is
 * compared lexicographically by every read below, which only matches
 * chronological order at this exact fixed width -- the same reasoning
 * src/domain/item.ts applies to its canonical timestamps.
 */
export function assertCalendarDay(field: string, value: string): void {
  if (!CALENDAR_DAY.test(value)) {
    throw new RangeError(`${field} '${value}' is not a calendar day (expected YYYY-MM-DD)`);
  }
}

/**
 * Steps a calendar-day LABEL by `delta` whole days.
 *
 * Date.UTC is correct here, and is not a violation of the never-read-the-host-
 * zone rule: both input and output are bare YYYY-MM-DD labels with no instant
 * and no zone attached, so UTC is being used purely as a fixed frame for
 * proleptic-Gregorian arithmetic. Nothing converts an instant to a day here --
 * that only ever happens in localDay, with an explicit WF_TZ. Using the local
 * `new Date(y, m, d)` constructor instead WOULD read the host zone, and would
 * additionally be wrong across a DST shift, where a local day is 23 or 25
 * hours and adding 86,400,000 ms lands on the wrong date.
 */
function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

/** One repo's star count on one calendar day in `tz`. */
export interface RepoStarSnapshot {
  /** GitHub's immutable numeric repository id. */
  repoId: number;
  /** YYYY-MM-DD in `tz`. */
  snapshotDay: string;
  stars: number;
  /** Canonical UTC instant the reading was taken. */
  observedAt: string;
  /** The zone `snapshotDay` was computed in. */
  tz: string;
}

/** A single star reading, as the GitHub adapter hands it over. */
export interface StarObservation {
  repoId: number;
  /** sha256 of the canonical URL for `fullName`, per src/domain/item.ts. */
  itemKey: string;
  /** owner/name as observed. */
  fullName: string;
  stars: number;
  observedAt: string;
  tz: string;
}

/**
 * What a `recordStarSnapshot` call actually did.
 *
 * `ignored` is the one a caller must not treat as success-by-default: it
 * means a FRESHER reading for that day was already stored and this one was
 * discarded. Returned rather than thrown because an out-of-order retry is
 * ordinary operational noise, not an error worth failing an ingest cycle
 * over -- but a caller that logs "recorded" unconditionally would be lying.
 */
export interface RecordOutcome {
  action: 'inserted' | 'updated' | 'ignored';
  /** The calendar day in `obs.tz` the reading was bucketed into. */
  snapshotDay: string;
}

const INSERT_SNAPSHOT = `
  insert into github_repo_star_snapshots
    (repo_id, snapshot_day, stars, observed_at, tz, created_at)
  values (?, ?, ?, ?, ?, ?)
  on conflict (repo_id, snapshot_day) do update set
    stars = excluded.stars,
    observed_at = excluded.observed_at,
    tz = excluded.tz
  where excluded.observed_at > github_repo_star_snapshots.observed_at
`;

const INSERT_NAME = `
  insert into github_repo_names
    (repo_id, item_key, full_name, first_seen_at, last_seen_at)
  values (?, ?, ?, ?, ?)
  on conflict (repo_id, item_key) do update set
    full_name = excluded.full_name,
    last_seen_at = excluded.last_seen_at
  where excluded.last_seen_at > github_repo_names.last_seen_at
`;

/**
 * Records one star reading, bucketed into the calendar day `observedAt` falls
 * on in `obs.tz`, and records the (repoId, itemKey) pairing that made it
 * reachable from the rest of the system.
 *
 * A second reading on a day already recorded REPLACES it rather than adding a
 * row -- `primary key (repo_id, snapshot_day)` makes a second row impossible,
 * which is what keeps a double-polled day from inflating velocity's
 * denominator. See db/migrations/0007_repo_star_snapshots.sql, section 1.
 */
export function recordStarSnapshot(db: Db, obs: StarObservation): RecordOutcome {
  assertCanonicalTimestamp('observedAt', obs.observedAt);
  const day = localDay(obs.observedAt, obs.tz);

  db.exec('begin');
  try {
    db.prepare(INSERT_NAME).run(
      obs.repoId,
      obs.itemKey,
      obs.fullName,
      obs.observedAt,
      obs.observedAt,
    );

    // Read the day's existing reading to name the outcome. `.run()`'s
    // `changes` cannot: an INSERT and a conflict-resolving UPDATE both report
    // 1, and only the WHERE-filtered no-op reports 0. The guarded upsert
    // below still does the real deciding -- this read only labels it.
    const existing = db
      .prepare(
        'select observed_at from github_repo_star_snapshots where repo_id = ? and snapshot_day = ?',
      )
      .get(obs.repoId, day) as { observed_at: string } | undefined;

    db.prepare(INSERT_SNAPSHOT).run(
      obs.repoId,
      day,
      obs.stars,
      obs.observedAt,
      obs.tz,
      obs.observedAt,
    );
    db.exec('commit');

    if (existing === undefined) return { action: 'inserted', snapshotDay: day };
    return {
      action: obs.observedAt > existing.observed_at ? 'updated' : 'ignored',
      snapshotDay: day,
    };
  } catch (cause) {
    if (db.isTransaction) db.exec('rollback');
    throw cause;
  }
}

/** One (repo_id, item_key) pairing, as it was observed. */
export interface RepoName {
  repoId: number;
  itemKey: string;
  fullName: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * The repo whose velocity history a caller holding only an `item_key` should
 * read -- the bridge from the rest of the system's identity to this module's.
 * `null` when the key belongs to no repo this system has ever seen.
 *
 * Ties break on the most recently seen pairing, because the mapping is
 * genuinely many-to-many over time: a rename gives one repo several keys, and
 * GitHub freeing a deleted repo's path for reuse gives one key several repos.
 * The older pairings stay on disk rather than being rewritten, so the
 * ambiguity stays inspectable via getRepoNames.
 */
export function resolveRepoId(db: Db, itemKey: string): number | null {
  const row = db
    .prepare(
      `select repo_id from github_repo_names
        where item_key = ?
        order by last_seen_at desc, repo_id desc
        limit 1`,
    )
    .get(itemKey) as { repo_id: number } | undefined;
  return row ? row.repo_id : null;
}

/**
 * Every name `repoId` has ever been observed under, oldest first. More than
 * one row means the repo was renamed or transferred while this system was
 * watching -- which is exactly what the numeric-id identity exists to survive.
 */
export function getRepoNames(db: Db, repoId: number): RepoName[] {
  // Inline type literal, not a named interface -- see the cast note in
  // getStarSnapshots below.
  const rows = db
    .prepare(
      `select repo_id, item_key, full_name, first_seen_at, last_seen_at
         from github_repo_names
        where repo_id = ?
        order by first_seen_at asc, item_key asc`,
    )
    .all(repoId) as Array<{
    repo_id: number;
    item_key: string;
    full_name: string;
    first_seen_at: string;
    last_seen_at: string;
  }>;

  return rows.map((r) => ({
    repoId: r.repo_id,
    itemKey: r.item_key,
    fullName: r.full_name,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  }));
}

/**
 * Every recorded day for `repoId` within `[fromDay, throughDay]` (inclusive,
 * whole history when omitted), oldest first.
 *
 * **Unobserved days are absent, never zero-filled and never interpolated.**
 * A gap-filled zero would read as "this repo gained no stars that day", which
 * is indistinguishable from a genuinely flat repo -- exactly the distinction
 * §4's velocity ranking turns on. Callers that need the gap NAMED rather than
 * merely absent should use getSnapshotWindow.
 */
export function getStarSnapshots(
  db: Db,
  repoId: number,
  range: { fromDay?: string; throughDay?: string } = {},
): RepoStarSnapshot[] {
  if (range.fromDay !== undefined) assertCalendarDay('fromDay', range.fromDay);
  if (range.throughDay !== undefined) assertCalendarDay('throughDay', range.throughDay);

  // Inline type literal, not `as RepoStarSnapshot[]`: casting .all()'s
  // Record<string, SQLOutputValue>[] to a NAMED interface array fails tsc's
  // overlap check while a structurally identical inline literal passes. See
  // CLAUDE.md, "The node:sqlite cast quirk", and src/cluster/store.ts:88-100.
  const rows = db
    .prepare(
      `select repo_id, snapshot_day, stars, observed_at, tz
         from github_repo_star_snapshots
        where repo_id = ?
          and snapshot_day >= ?
          and snapshot_day <= ?
        order by snapshot_day asc`,
    )
    // Sentinels rather than a dynamically built WHERE: snapshot_day is a
    // fixed-width YYYY-MM-DD, so these bound every real value lexicographically.
    .all(repoId, range.fromDay ?? '0000-01-01', range.throughDay ?? '9999-12-31') as Array<{
    repo_id: number;
    snapshot_day: string;
    stars: number;
    observed_at: string;
    tz: string;
  }>;

  return rows.map((r) => ({
    repoId: r.repo_id,
    snapshotDay: r.snapshot_day,
    stars: r.stars,
    observedAt: r.observed_at,
    tz: r.tz,
  }));
}

/**
 * A trailing window of days, with the gaps in it named.
 *
 * The whole point of this shape is that `snapshots` alone cannot tell a
 * consumer whether a short series means "this repo is new" or "the scheduler
 * was down" -- so both are stated: `expectedDays` is how many calendar days
 * the window covers, `observedDays` how many were actually recorded, and
 * `missingDays` which ones were not.
 */
export interface SnapshotWindow {
  repoId: number;
  /** First day of the window, inclusive. */
  fromDay: string;
  /** Last day of the window, inclusive. */
  throughDay: string;
  /** Calendar days the window spans. */
  expectedDays: number;
  /** Days actually recorded -- equal to `snapshots.length`. */
  observedDays: number;
  /** Days in the window with no reading at all, ascending. */
  missingDays: string[];
  /** Only the observed days, oldest first. */
  snapshots: RepoStarSnapshot[];
  /**
   * True when the window's rows were bucketed under more than one zone --
   * i.e. WF_TZ changed mid-window, so the days in it do not all mean the same
   * thing. A consumer computing a rate over them is measuring across a seam.
   */
  mixedTimezone: boolean;
}

/**
 * The trailing `days`-day window ending on (and including) `throughDay`.
 *
 * `throughDay` is a caller-supplied calendar day in WF_TZ, not a clock read
 * here -- this module never reads the wall clock, matching every other domain
 * module in the project (src/domain/item.ts, src/db/fetchState.ts,
 * src/domain/itemState.ts). Callers get it from `localDay(now, env.WF_TZ)`.
 */
export function getSnapshotWindow(
  db: Db,
  repoId: number,
  opts: { throughDay: string; days: number },
): SnapshotWindow {
  assertCalendarDay('throughDay', opts.throughDay);
  if (!Number.isInteger(opts.days) || opts.days < 1) {
    throw new RangeError(`days must be a positive integer, got ${opts.days}`);
  }

  const fromDay = shiftDay(opts.throughDay, -(opts.days - 1));
  const snapshots = getStarSnapshots(db, repoId, { fromDay, throughDay: opts.throughDay });
  const observed = new Set(snapshots.map((s) => s.snapshotDay));

  const missingDays: string[] = [];
  for (let i = 0; i < opts.days; i += 1) {
    const day = shiftDay(fromDay, i);
    if (!observed.has(day)) missingDays.push(day);
  }

  return {
    repoId,
    fromDay,
    throughDay: opts.throughDay,
    expectedDays: opts.days,
    observedDays: snapshots.length,
    missingDays,
    snapshots,
    mixedTimezone: new Set(snapshots.map((s) => s.tz)).size > 1,
  };
}

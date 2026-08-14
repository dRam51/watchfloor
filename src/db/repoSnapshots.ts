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

/** Every recorded day for `repoId`, oldest first. Unobserved days are absent. */
export function getStarSnapshots(db: Db, repoId: number): RepoStarSnapshot[] {
  // Inline type literal, not `as RepoStarSnapshot[]`: casting .all()'s
  // Record<string, SQLOutputValue>[] to a NAMED interface array fails tsc's
  // overlap check while a structurally identical inline literal passes. See
  // CLAUDE.md, "The node:sqlite cast quirk", and src/cluster/store.ts:88-100.
  const rows = db
    .prepare(
      `select repo_id, snapshot_day, stars, observed_at, tz
         from github_repo_star_snapshots
        where repo_id = ?
        order by snapshot_day asc`,
    )
    .all(repoId) as Array<{
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

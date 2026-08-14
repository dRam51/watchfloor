/**
 * Star-snapshot recording for `github_search` sources (M4a task 9).
 *
 * ## Why this module exists at all
 *
 * M4a task 2 built the snapshot storage (`src/db/repoSnapshots.ts`), task 4
 * built the adapter that fetches repos, and task 5 built the velocity
 * computation that reads snapshots back. **Nothing connected them.** Every
 * unit test passed, `tsc` was clean, and a live ingest wrote 359 repos and
 * zero snapshots -- so `github_repo_star_snapshots` stayed empty and velocity
 * returned `no_snapshots` for every repo, permanently.
 *
 * That is worse than it sounds. §4 ranks the repos lane by star velocity, and
 * the plan's central caveat was that velocity needs seven days of history to
 * accumulate. Without this module it would never accumulate at all: the lane
 * would show "insufficient history" on day 700 exactly as on day 1, and the
 * failure mode is silent, because "no snapshots yet" is a legitimate state
 * that the UI is *designed* to render honestly. The lane would look correct
 * while being permanently inert.
 *
 * Found by the live acceptance run, which is the only thing that could have
 * found it -- it is a gap BETWEEN correctly-built, fully-tested parts.
 *
 * ## Why it reads `raw_json` instead of taking the adapter's output
 *
 * The adapter contract (`src/adapters/types.ts`) is `fetch(source, state, now)
 * => AdapterResult`, with no database handle by design -- adapters are pure
 * over the network response. So an adapter cannot write a snapshot, and
 * threading a DB into it would break the property every other adapter relies
 * on for testability.
 *
 * The stored item is the natural join point instead: task 4 established that
 * `stargazers_count` survives into `items.raw_json`, so **a snapshot costs no
 * extra HTTP request**. This runs after the poll cycle, over what was actually
 * persisted, which also makes it idempotent against the storage layer's own
 * guarantee (task 2's `primary key (repo_id, snapshot_day)` upsert) rather
 * than against a promise about call order.
 *
 * ## `id`, not `full_name`
 *
 * The repo id is GitHub's numeric id, per task 2's identity decision: it
 * survives renames and transfers, where `owner/name` does not. A rename would
 * otherwise start a fresh zero-day velocity history for a repo that has been
 * tracked for weeks. The `item_key -> repo_id` mapping task 2 stores is
 * written by `recordStarSnapshot` itself, so this module does not maintain it
 * separately.
 */
import type { Db } from '../db/connection.ts';
import type { Source } from '../sources/load.ts';
import { recordStarSnapshot, type RecordOutcome } from '../db/repoSnapshots.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';

export interface StarSnapshotSweep {
  /** Rows examined -- one per distinct item_key from a github_search source. */
  examined: number;
  inserted: number;
  updated: number;
  /** A fresher reading for that day was already stored; this one was discarded. */
  ignored: number;
  /**
   * Rows whose `raw_json` could not yield a (numeric id, stars, full_name)
   * triple. Counted rather than thrown: one malformed row must not fail a
   * cycle, but a silently-zero snapshot count must not look like success
   * either -- the same "absent is different from zero" convention
   * `AdapterResult.skipped` follows.
   */
  unusable: number;
}

/**
 * One row per distinct `item_key`, taking the LATEST version. Under
 * append-only storage a repo re-polled on a later day has several rows sharing
 * one key, and the newest is the one whose star count is current.
 *
 * Inline type literal on the cast, not a named interface -- see CLAUDE.md,
 * "The node:sqlite cast quirk", and src/cluster/store.ts:88-100.
 */
const SELECT_LATEST = `
  select i.item_key as item_key, i.raw_json as raw_json
    from items i
    join (
      select item_key, max(fetched_at) as newest
        from items
       where source_id in (SOURCE_IDS)
       group by item_key
    ) latest
      on latest.item_key = i.item_key and latest.newest = i.fetched_at
   where i.source_id in (SOURCE_IDS)
   group by i.item_key
`;

/**
 * Records one star reading per repo currently stored from any `github_search`
 * source, bucketed into the calendar day of `observedAt` in `tz`.
 *
 * `observedAt` and `tz` are injected, never read from the wall clock or the
 * host zone -- the same convention as every other module here, and the reason
 * this is testable across DST seams (see tests). `tz` must be the configured
 * `WF_TZ`, not the machine's.
 */
export function recordStarSnapshots(
  db: Db,
  sources: readonly Source[],
  observedAt: string,
  tz: string,
): StarSnapshotSweep {
  assertCanonicalTimestamp('observedAt', observedAt);

  const searchSourceIds = sources.filter((s) => s.type === 'github_search').map((s) => s.id);
  const sweep: StarSnapshotSweep = { examined: 0, inserted: 0, updated: 0, ignored: 0, unusable: 0 };
  if (searchSourceIds.length === 0) return sweep;

  const placeholders = searchSourceIds.map(() => '?').join(', ');
  const rows = db
    .prepare(SELECT_LATEST.replaceAll('SOURCE_IDS', placeholders))
    .all(...searchSourceIds, ...searchSourceIds) as Array<{
    item_key: string;
    raw_json: string | null;
  }>;

  for (const row of rows) {
    sweep.examined += 1;

    const parsed = parseObservation(row.raw_json);
    if (parsed === null) {
      sweep.unusable += 1;
      continue;
    }

    const outcome: RecordOutcome = recordStarSnapshot(db, {
      repoId: parsed.repoId,
      itemKey: row.item_key,
      fullName: parsed.fullName,
      stars: parsed.stars,
      observedAt,
      tz,
    });

    if (outcome.action === 'inserted') sweep.inserted += 1;
    else if (outcome.action === 'updated') sweep.updated += 1;
    else sweep.ignored += 1;
  }

  return sweep;
}

/**
 * `null` for anything that does not yield all three facts. Deliberately strict:
 * a repo with a missing `id` cannot be identified stably, and one with a
 * missing `stargazers_count` would otherwise be recorded as **0 stars**, which
 * is not "unknown" -- it is a reading, and a false one that would show up as a
 * catastrophic negative velocity the next day.
 */
function parseObservation(
  rawJson: string | null,
): { repoId: number; stars: number; fullName: string } | null {
  if (rawJson === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const repoId = record.id;
  const stars = record.stargazers_count;
  const fullName = record.full_name;

  if (typeof repoId !== 'number' || !Number.isInteger(repoId) || repoId <= 0) return null;
  if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 0) return null;
  if (typeof fullName !== 'string' || fullName.length === 0) return null;

  return { repoId, stars, fullName };
}

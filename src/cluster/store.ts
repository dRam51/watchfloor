/**
 * DB-facing half of near-duplicate clustering (M2 Task 4): reading candidate
 * items to cluster, writing `clusters`/`item_clusters`, and reading cluster
 * size as of a past instant. The algorithm itself (src/cluster/similarity.ts,
 * src/cluster/group.ts) is pure and knows nothing about SQL; this module is
 * the only place in `src/cluster/` that touches `Db`.
 *
 * ## Why re-clustering APPENDS a whole new snapshot rather than growing an
 * existing cluster_id in place
 *
 * `item_clusters` is append-only (trigger-enforced, db/migrations/
 * 0001_init.sql) and keyed on `item_key`, not `item_id` -- membership
 * survives an item's re-versioning. The task is explicit that "cluster size
 * must be reconstructible at any past instant", and `item_clusters_asof`
 * (an index on `(cluster_id, fetched_at)`) exists specifically to make that
 * query cheap. The design this module implements: every clustering PASS
 * (`writeClusters`, normally called once per group discovered by
 * `groupNearDuplicates` in a single run of `src/cluster/run.ts`) creates a
 * BRAND NEW `cluster_id` for every group and stamps every member's
 * `item_clusters` row with the SAME `fetched_at` -- the pass's own run
 * timestamp. It never looks for "is this the same group as last time, reuse
 * its id" and never appends new members onto an OLD cluster_id.
 *
 * This is deliberate, for the same reason `items` itself is append-only
 * rather than updated in place: a clustering pass is a new VERSION of the
 * whole clustering state, exactly as inserting a new `items` row is a new
 * version of one item. Under this design, "what was item X's cluster size as
 * of instant T" reduces to "which pass's snapshot was current as of T" --
 * answered by `getClusterSizeAsOf` below with two indexed queries and no
 * replay logic, because within a single pass every member's `fetched_at` is
 * identical: the `<=` filter on that column is an all-or-nothing gate on the
 * whole pass, not a partial-membership question. See that function's doc
 * comment and store.test.ts's "two passes over time" test for the concrete
 * proof this produces the historically-true answer, not today's answer
 * replayed backward.
 *
 * The `clusters` table itself is NOT append-only-enforced (no trigger) --
 * old, superseded `cluster_id`s are simply never revisited by this module,
 * not deleted (this project never deletes rows -- see CLAUDE.md).
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import type { ClusterCandidate } from './group.ts';

// ---------------------------------------------------------------------------
// Reading candidates
// ---------------------------------------------------------------------------

/**
 * One candidate per distinct `item_key` in `items`, carrying that item's
 * CURRENT version's title -- the same "current version" tie-break
 * `src/domain/item.ts`'s `getCurrentItem`/`getItemAsOf` use (`fetched_at`
 * desc, then `rowid` desc to break a genuine timestamp tie deterministically;
 * see that module's comment on why a tie is real, not hypothetical: two
 * versions can legally share an instant on a batch ingest or a
 * second-precision source). Implemented as a single windowed query rather
 * than one `getCurrentItem` call per distinct `item_key` -- both are
 * correct, but doing it in one query avoids O(distinct item_keys) round
 * trips for what is, today, the single largest read in the whole clustering
 * pass.
 *
 * Exact-URL duplicates are already collapsed by `item_key` itself
 * (`src/domain/item.ts`'s `deriveItemKey`) before this function ever runs --
 * this is the ONLY read this module needs from `items`; near-duplicate
 * detection over the results is `src/cluster/group.ts`'s job, not this
 * function's.
 */
export function getCurrentTitlesForClustering(db: Db): ClusterCandidate[] {
  const rows = db
    .prepare(
      `select item_key, title
       from (
         select item_key, title,
                row_number() over (
                  partition by item_key
                  order by fetched_at desc, rowid desc
                ) as rn
         from items
       )
       where rn = 1`,
    )
    // Cast target is an INLINE type literal, not a named interface, on
    // purpose -- not a style preference. node:sqlite's .all() return type is
    // Record<string, SQLOutputValue>[], and TypeScript's "as" overlap check
    // treats a named interface array target more strictly than a
    // structurally identical inline literal array target for this exact
    // cast shape (confirmed empirically; a named `interface CandidateRow {
    // item_key: string; title: string }` here fails `tsc` with TS2352
    // "neither type sufficiently overlaps", while this inline literal with
    // the identical fields does not). tests/domain/itemBeats.test.ts's
    // existing `.all() as Array<{ item_id: string; beat: string }>` is the
    // same established pattern already in this codebase -- matched here
    // rather than reaching for `as unknown as X[]`.
    .all() as Array<{ item_key: string; title: string }>;
  return rows.map((row) => ({ itemKey: row.item_key, title: row.title }));
}

// ---------------------------------------------------------------------------
// Writing clusters
// ---------------------------------------------------------------------------

export interface ClusterWriteSummary {
  clustersCreated: number;
  membershipsWritten: number;
}

/**
 * Writes one `clusters` row and one `item_clusters` row per member for each
 * group in `groups`, all stamped with `runAt` -- the pass's own timestamp,
 * supplied by the caller rather than read from the system clock here (same
 * "now is always a parameter" stance as `src/score/decay.ts`, for the same
 * testability reason: a caller can replay a specific `runAt` and get a
 * deterministic result).
 *
 * Every group must have at least 2 members -- `groupNearDuplicates` already
 * only returns groups of size >= 2, but this function does not trust that
 * silently: a size-1 "group" reaching here is a caller bug (writing a
 * cluster row for something with no actual duplicate), and it throws rather
 * than writing a meaningless singleton cluster. `groups` may be empty (a
 * pass that found no duplicates at all) -- that is not an error, it is a
 * legitimate, common outcome; see the "prefer under-clustering" design goal
 * this task is built around.
 *
 * All writes for the whole call happen in one transaction: either every
 * group's rows land, or (on a canonical-timestamp rejection, a size-1 group,
 * or any DB error) none of them do -- no partially-written pass.
 */
export function writeClusters(db: Db, groups: string[][], runAt: string): ClusterWriteSummary {
  assertCanonicalTimestamp('runAt', runAt);
  for (const group of groups) {
    if (group.length < 2) {
      throw new RangeError(
        `writeClusters: every group must have at least 2 members (a cluster of one is not a cluster), got ${group.length}`,
      );
    }
  }

  const insertCluster = db.prepare('insert into clusters (cluster_id, created_at) values (?, ?)');
  const insertMembership = db.prepare(
    'insert into item_clusters (membership_id, cluster_id, item_key, fetched_at) values (?, ?, ?, ?)',
  );

  let clustersCreated = 0;
  let membershipsWritten = 0;

  db.exec('begin');
  try {
    for (const group of groups) {
      const clusterId = randomUUID();
      insertCluster.run(clusterId, runAt);
      clustersCreated++;
      for (const itemKey of group) {
        insertMembership.run(randomUUID(), clusterId, itemKey, runAt);
        membershipsWritten++;
      }
    }
    db.exec('commit');
  } catch (cause) {
    // SQLite can auto-rollback on some internal errors; guard against
    // "cannot rollback - no transaction is active" masking the real cause,
    // same pattern as src/db/migrate.ts and src/domain/item.ts's insertItem.
    if (db.isTransaction) db.exec('rollback');
    throw cause;
  }

  return { clustersCreated, membershipsWritten };
}

// ---------------------------------------------------------------------------
// Reading cluster size as of a past instant
// ---------------------------------------------------------------------------

/**
 * The size of the cluster `itemKey` belonged to, as of `asOf` -- the
 * point-in-time proof the task requires. Two steps, both indexed:
 *
 * 1. Find `itemKey`'s membership row with the latest `fetched_at <= asOf`
 *    (there may be several across multiple passes over the item's history;
 *    only the most recent one at-or-before `asOf` is "current" as of that
 *    instant). `rowid desc` breaks a genuine `fetched_at` tie
 *    deterministically, mirroring `src/domain/item.ts`'s `getItemAsOf` --
 *    included for the same reason that module states explicitly: SQL
 *    guarantees no tiebreak among equal sort keys on its own.
 * 2. Count every `item_clusters` row sharing that SAME `cluster_id` with
 *    `fetched_at <= asOf`. Because `writeClusters` stamps every member of
 *    one pass with the identical `fetched_at`, this count is really an
 *    all-or-nothing gate (either `asOf` is at/after the pass that produced
 *    this `cluster_id`, revealing every member written in it, or `asOf` is
 *    before it and step 1 would already have picked an earlier/no row) --
 *    not a partial-membership scenario.
 *
 * Returns 1, not 0, when `itemKey` has no membership row at or before
 * `asOf` -- the item, considered alone, always exists as a "cluster of
 * itself"; the schema simply doesn't materialize a row for a singleton (see
 * `writeClusters`'s doc comment). This is the same convention the mechanical
 * scorer (M2 Task 5) will read directly as a magnitude: "1" means "no known
 * corroborating source", never "unknown"/`null`.
 */
export function getClusterSizeAsOf(db: Db, itemKey: string, asOf: string): number {
  assertCanonicalTimestamp('asOf', asOf);

  const membership = db
    .prepare(
      `select cluster_id
       from item_clusters
       where item_key = ? and fetched_at <= ?
       order by fetched_at desc, rowid desc
       limit 1`,
    )
    .get(itemKey, asOf) as { cluster_id: string } | undefined;

  if (!membership) return 1;

  const countRow = db
    .prepare('select count(*) as n from item_clusters where cluster_id = ? and fetched_at <= ?')
    .get(membership.cluster_id, asOf) as { n: number };

  return countRow.n;
}

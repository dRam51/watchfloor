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
 * CURRENT version's title AND source_id -- the same "current version"
 * tie-break `src/domain/item.ts`'s `getCurrentItem`/`getItemAsOf` use
 * (`fetched_at` desc, then `rowid` desc to break a genuine timestamp tie
 * deterministically; see that module's comment on why a tie is real, not
 * hypothetical: two versions can legally share an instant on a batch ingest
 * or a second-precision source). Implemented as a single windowed query
 * rather than one `getCurrentItem` call per distinct `item_key` -- both are
 * correct, but doing it in one query avoids O(distinct item_keys) round
 * trips for what is, today, the single largest read in the whole clustering
 * pass.
 *
 * `sourceId` (fix round 1, M2 task 4 fix-round-1 -- see src/cluster/
 * group.ts's module doc comment) is resolved from the SAME winning row as
 * `title`, not independently -- an item_key with multiple versions attached
 * to different source_ids (the real arXiv cs.AI/cs.CR cross-listing shape)
 * must report the CURRENT version's source, matching every other field on
 * the same candidate. Verified directly in store.test.ts's tie-break test.
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
      `select item_key, title, source_id
       from (
         select item_key, title, source_id,
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
    // item_key: string; title: string; source_id: string }` here fails
    // `tsc` with TS2352 "neither type sufficiently overlaps", while this
    // inline literal with the identical fields does not).
    // tests/domain/itemBeats.test.ts's existing
    // `.all() as Array<{ item_id: string; beat: string }>` is the same
    // established pattern already in this codebase -- matched here rather
    // than reaching for `as unknown as X[]`.
    .all() as Array<{ item_key: string; title: string; source_id: string }>;
  return rows.map((row) => ({ itemKey: row.item_key, title: row.title, sourceId: row.source_id }));
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
 * point-in-time proof the task requires.
 *
 * FIX ROUND 2 (M2 task 4 fix-round-2): resolution is scoped to the latest
 * clustering RUN at or before `asOf`, not to `itemKey`'s own most recent
 * membership row. These are NOT the same question once a re-clustering pass
 * can REMOVE an item from a cluster -- which fix round 1 made a real,
 * common occurrence (its cross-source-only rule can, and in the real
 * corpus did, exclude an item from every cluster it used to belong to).
 * `writeClusters` never writes a row for a singleton (see its own doc
 * comment: "a singleton earns no row"), so an item that stops being
 * clustered gets NO new row in the next pass -- there is nothing to
 * append. Under the pre-fix-round-2 resolution ("this item_key's own most
 * recent row, full stop"), that item's stale membership from the LAST pass
 * that still included it would keep being reported as current, forever,
 * because nothing ever supersedes it. Real, not hypothetical: this is
 * exactly what happened to the 1,543-member cisa-kev cluster fix round 1
 * eliminated from the WRITE path -- three real cisa-kev items kept reading
 * back as size 1,543 through this READ path minutes after the fix had
 * already stopped writing anything for them (see
 * store.test.ts's "FIX ROUND 2" real-data regression and
 * task-4-report.md's fix-round-2 section for the full account).
 *
 * Three steps, using the fact that one call to `writeClusters` stamps EVERY
 * membership it writes with the identical `fetched_at` -- so the set of
 * DISTINCT `fetched_at` values ever seen in `item_clusters` is exactly the
 * set of past clustering runs, not an arbitrary per-row timestamp:
 *
 * 1. Find the latest RUN at or before `asOf` -- `max(fetched_at) where
 *    fetched_at <= asOf`. `null` (no clustering pass has ever run at or
 *    before `asOf`) means every item is a singleton; return 1 immediately.
 * 2. Within THAT SPECIFIC run (`fetched_at` matching it exactly, not `<=`
 *    -- a run is a single point, not a range), does `itemKey` have a
 *    membership row at all? If not, `itemKey` was a singleton in the
 *    current run (whether because it was never clustered, or because a
 *    later run genuinely stopped clustering it) -- return 1. This is the
 *    step fix round 2 changes: the pre-fix version searched `itemKey`'s
 *    entire history for its own latest row, which could resolve to an
 *    OLDER run than the one currently in effect.
 * 3. Count every row sharing that membership's `cluster_id` (a cluster_id
 *    is created fresh by every pass -- see `writeClusters` -- so it is
 *    already unique to exactly one run; the `fetched_at` filter here is
 *    retained as an explicit, self-documenting invariant check rather than
 *    because it changes the result).
 *
 * POINT-IN-TIME PROPERTY, preserved exactly, not "fixed" away: an `asOf`
 * that falls INSIDE an old (even a since-superseded, even a genuinely
 * wrong) run's own window still finds and reconstructs THAT run's true
 * historical membership -- step 1 picks whichever run was actually current
 * as of that instant, bad data included. That is correct: a historical
 * query answers "what did the system believe then", not "what do we now
 * know was true". See store.test.ts's dedicated point-in-time test for the
 * real-data proof.
 *
 * Returns 1, not 0, when `itemKey` has no membership anywhere at or before
 * `asOf` -- the item, considered alone, always exists as a "cluster of
 * itself"; the schema simply doesn't materialize a row for a singleton.
 * This is the same convention the mechanical scorer (M2 Task 5) reads
 * directly as a magnitude: "1" means "no known corroborating source",
 * never "unknown"/`null`.
 *
 * ALTERNATIVE CONSIDERED AND REJECTED (fix round 2): have `writeClusters`
 * emit an explicit singleton row for every candidate that ISN'T in a
 * multi-member group, so every item always has a fresh row every pass and
 * the pre-fix "most recent row" resolution would have kept working
 * unmodified. Rejected: the real corpus has ~4,134 candidates and ~10 real
 * clusters per pass, so this would write roughly 4,100 new rows into an
 * APPEND-ONLY table on every single pass, forever -- versus the 22 the
 * chosen fix actually writes. It would also directly contradict this
 * module's own established "a singleton earns no row" convention
 * (`writeClusters`'s doc comment, unchanged by this fix round): `clusters`
 * exists to record genuine duplication, and thousands of vacuous
 * one-member "clusters" every pass would violate that far more than a
 * slightly more involved read query does.
 */
export function getClusterSizeAsOf(db: Db, itemKey: string, asOf: string): number {
  assertCanonicalTimestamp('asOf', asOf);

  // Step 1: which clustering RUN was current as of `asOf`? The distinct
  // fetched_at values in item_clusters ARE the set of past runs (see this
  // function's doc comment).
  const run = db.prepare('select max(fetched_at) as run_at from item_clusters where fetched_at <= ?').get(asOf) as {
    run_at: string | null;
  };
  if (run.run_at === null) return 1;

  // Step 2: does itemKey have a membership WITHIN that specific run? An
  // exact match on fetched_at, not <=, because a run is one instant, not a
  // window -- this is the change from fix round 1's implementation, which
  // searched itemKey's own history unconditionally instead of scoping to
  // the run that's actually current as of `asOf`.
  const membership = db
    .prepare('select cluster_id from item_clusters where item_key = ? and fetched_at = ?')
    .get(itemKey, run.run_at) as { cluster_id: string } | undefined;
  if (!membership) return 1;

  // Step 3: how many members did that specific cluster have, in that run?
  const countRow = db
    .prepare('select count(*) as n from item_clusters where cluster_id = ? and fetched_at = ?')
    .get(membership.cluster_id, run.run_at) as { n: number };
  return countRow.n;
}

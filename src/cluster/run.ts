/**
 * Composition root for near-duplicate clustering (M2 Task 4) -- the single
 * entry point a scoring pass (M2 Task 9, out of this task's scope) calls to
 * run one full clustering pass. Named to match `src/scheduler/run.ts`'s
 * convention: the file in a module that wires its pure pieces together.
 *
 * Pipeline: `src/cluster/store.ts`'s `getCurrentTitlesForClustering` (read
 * candidates) -> `src/cluster/group.ts`'s `groupNearDuplicates` (pure
 * algorithm) -> `store.ts`'s `writeClusters` (persist). Nothing here does
 * its own SQL or its own similarity math -- this file only sequences calls
 * to the other three modules and reports what happened.
 */

import type { Db } from '../db/connection.ts';
import { loadClusterConfig, type ClusterConfig } from './config.ts';
import { getCurrentTitlesForClustering, writeClusters, type ClusterWriteSummary } from './store.ts';
import { groupNearDuplicates } from './group.ts';

export interface ClusteringPassSummary extends ClusterWriteSummary {
  /** How many distinct item_keys were considered as clustering candidates. */
  candidatesConsidered: number;
  /** How many near-duplicate groups (size >= 2) were found. */
  groupsFound: number;
}

/**
 * Runs one clustering pass: reads every current item title, groups
 * near-duplicates per `config.near_duplicate_threshold`, and writes the
 * result. `runAt` is supplied by the caller, never read from the system
 * clock here -- same "now is always a parameter" stance as
 * `src/score/decay.ts`, so a caller (tests, or a future scheduled pass) gets
 * a fully deterministic, replayable result.
 *
 * Safe to call repeatedly (e.g. on a recurring schedule): each call is an
 * independent pass that appends a fresh snapshot rather than mutating a
 * prior one -- see `src/cluster/store.ts`'s `writeClusters` doc comment for
 * why, and its and `run.test.ts`'s "re-running the pass later APPENDS"
 * tests for the proof. A pass over an unchanged item set with an unchanged
 * config reproduces the identical grouping every time (`groupNearDuplicates`
 * is deterministic) -- it simply re-records it under a new `cluster_id`
 * stamped with the new `runAt`, which is the intended, documented behavior,
 * not wasted work to be "fixed" by memoizing across calls.
 */
export function runClusteringPass(db: Db, config: ClusterConfig, runAt: string): ClusteringPassSummary {
  const candidates = getCurrentTitlesForClustering(db);
  const groups = groupNearDuplicates(candidates, config.near_duplicate_threshold);
  const writeSummary = writeClusters(db, groups, runAt);
  return {
    candidatesConsidered: candidates.length,
    groupsFound: groups.length,
    ...writeSummary,
  };
}

/** Convenience wrapper: loads config from `configPath` first, then runs the pass. */
export function runClusteringPassFromConfigFile(
  db: Db,
  configPath: string,
  runAt: string,
): ClusteringPassSummary {
  return runClusteringPass(db, loadClusterConfig(configPath), runAt);
}

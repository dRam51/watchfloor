/**
 * The corpus-wide scoring pass (M2 Task 9): calls src/score/mechanical.ts's
 * scoreItem for every item that needs it, across the whole database, in one
 * call -- the runner that module's own doc comment names but deliberately
 * does not build ("a caller (Task 9's future scoring-pass CLI...) should
 * call getLatestItemScore, never a raw `item_scores where item_id = ?`
 * query"). Mirrors src/cluster/run.ts's shape: a thin composition root over
 * an existing per-item primitive, plus the one piece of genuine new logic
 * this task owns -- deciding WHICH item_keys need that primitive called on
 * them at all.
 *
 * ---------------------------------------------------------------------------
 * What "unscored" means here, and why (constraint 2)
 * ---------------------------------------------------------------------------
 * item_scores is append-only -- scoreItem never updates a row, it appends
 * one. So this module needs an explicit, defensible answer to "does this
 * item_key need scoreItem called on it right now", not just "is item_scores
 * empty for it".
 *
 * DECISION: an item_key is DUE when at least one of its CURRENT beats
 * (getItemBeats -- Task 3's union across every item_id sharing the key) has
 * no item_scores row under the PASS'S OWN scorer_version
 * (deps.config.scorer_version, i.e. config/scoring.yaml's value). Checked
 * per beat, not merely "does any row exist at all for this item_key", via
 * getLatestItemScore (mechanical.ts) -- see isFullyScored below.
 *
 * Three consequences, all intended:
 *
 *  1. A brand-new item_key (no rows at all) is due -- the base case.
 *  2. Bump scorer_version in config/scoring.yaml (a coefficient retune, a
 *     formula change) and the very next plain `runScoringPass` call rescores
 *     the ENTIRE corpus automatically -- no --force flag needed, no code
 *     change. Every item_key fails isFullyScored because no row anywhere yet
 *     carries the new version string. This is the intended way a retuned
 *     scorer reaches already-ingested data.
 *  3. Running the pass twice in a row with an unchanged scorer_version and no
 *     new items is a NO-OP the second time: every item_key already has a
 *     current-version row for every current beat, so isFullyScored is true
 *     everywhere and nothing is written. item_scores does not grow. See
 *     pass.test.ts's "re-running is safe" block for the proof.
 *
 * A NEW BEAT appearing on an already-scored item_key (the arXiv cs.AI/cs.CR
 * cross-listing shape Task 3 fixed the READ side of) is also caught: if a
 * second item_id lands later adding a beat this item_key didn't have before,
 * that beat has no scorer_version row yet, so isFullyScored is false and the
 * item_key becomes due again. scoreItem then writes ALL of the item_key's
 * current beats afresh (its own documented, unchanged behaviour), which
 * means the beat that WAS already covered gets one harmless extra row under
 * the same scorer_version. Accepted, not hidden: item_scores' append-only
 * growth stays bounded by the number of genuine scoring EVENTS (new items,
 * new beats, version bumps, --force runs) -- the same order of magnitude
 * mechanical.ts's own module doc comment already accepts, for the identical
 * reason (scoring once per item_key writes every current beat, not once per
 * beat independently).
 *
 * What this deliberately does NOT trigger a rescore for: a new item_id
 * landing for an ALREADY-fully-scored item_key with the SAME beats (a bare
 * re-delivery, e.g. cisa-kev re-dumping an unchanged catalog entry) does not
 * make isFullyScored return false -- mechanical.ts's own module doc comment
 * already establishes that getLatestItemScore correctly keeps returning the
 * still-valid prior score for the item_key in that case. Rescoring on every
 * re-delivery would reintroduce exactly the unbounded-growth-under-
 * append-only-storage hazard that module's "item_id-vs-item_key decision"
 * section explains at length. Nor does a clustering pass ALONE trigger a
 * rescore: cluster size is a scoring INPUT (see "clustering dependency"
 * below), not part of "is this item_key current" -- re-clustering without
 * bumping scorer_version or passing --force leaves previously-scored items'
 * stored components exactly as they were, which is correct under
 * decay-at-read-time (the STORED signal/read numbers are a point-in-time
 * computation, not a live view -- docs/superpowers/plans/
 * 2026-08-14-m2-scoring.md: "one row per (item_id, beat) per genuine scoring
 * event ... not when the clock moves"). --force, below, is the deliberate
 * escape hatch for "I know something changed that scorer_version doesn't
 * capture, rescore anyway".
 *
 * ---------------------------------------------------------------------------
 * --force (constraint 2, and demonstrating "rescoring requires no refetch")
 * ---------------------------------------------------------------------------
 * options.force bypasses isFullyScored entirely: every item_key with at
 * least one beat is (re)scored, regardless of what item_scores already
 * holds. Every write is still a fresh append -- nothing in this module or
 * scoreItem ever issues an UPDATE against item_scores; the append-only
 * triggers (db/migrations/0001_init.sql) would reject one if it tried. This
 * is the operational tool for "I retuned config/scoring.yaml without
 * bumping scorer_version" or "I just reran clustering and want the new
 * cluster sizes reflected without waiting for new items to arrive" -- and
 * its own test is the literal demonstration Definition of Done #2 asks for:
 * run the pass, touch nothing on the network, run it again with --force, and
 * see item_scores grow by exactly one fresh row per (item_key, beat) with a
 * later computed_at -- no adapter, no fetch, no source touched in between.
 *
 * ---------------------------------------------------------------------------
 * Clustering dependency (constraint 4): explicit, not implicit
 * ---------------------------------------------------------------------------
 * This module does NOT call runClusteringPass itself (grep-checked by
 * pass.test.ts). scoreItem's own cluster-size input (getClusterSizeAsOf,
 * called inside scoreItem) reads whatever clustering snapshot already exists
 * on disk as of the `now` this pass is given -- "no clustering pass has run
 * yet" is not an error, it just means every item reads back cluster size 1
 * (getClusterSizeAsOf's own documented "no known corroborating source"
 * baseline), which is silently WRONG for the M2 acceptance question ("does a
 * multi-source story outrank a single-source one") if the caller forgot to
 * cluster first.
 *
 * DECISION: keep the dependency OUT of this function and put it in the
 * caller's hands, explicitly and visibly -- src/bin/score.ts's own two
 * numbered, separately-logged steps ("step 1/2: clustering ... step 2/2:
 * scoring ..."), not a hidden internal call. Considered and rejected: having
 * runScoringPass call runClusteringPass itself internally, which would
 * (a) force EVERY scoring pass to pay for a full clustering pass even when
 * nothing changed since the last one (runClusteringPass's own module doc
 * comment: each call "appends a fresh snapshot" -- clustering is not free,
 * and is not idempotent-as-a-no-op the way this module's isFullyScored check
 * is), and (b) hide a real, load-bearing ordering requirement inside a
 * function whose name gives no hint that it also reclusters the whole
 * corpus. pass.test.ts proves the ordering is real (scoring before
 * clustering under-counts corroboration) precisely so this decision is
 * checked, not just asserted.
 * ---------------------------------------------------------------------------
 */

import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp, type Beat } from '../domain/item.ts';
import { getItemBeats } from '../domain/itemBeats.ts';
import { loadInterestsFile } from '../interests/load.ts';
import { loadSourcesFile } from '../sources/load.ts';
import { getLatestItemScore, loadMechanicalScoreConfig, scoreItem, type ScoreItemDeps } from './mechanical.ts';

export interface ScoringPassOptions {
  /**
   * Bypass isFullyScored and (re)score every item_key with at least one
   * beat, regardless of what item_scores already holds under the current
   * scorer_version. See the module doc comment's "--force" section.
   */
  force?: boolean;
}

export interface ScoringPassFailure {
  itemKey: string;
  error: string;
}

export interface ScoringPassSummary {
  scorerVersion: string;
  /** Distinct item_keys examined (from `items`), scored or not this pass. */
  candidatesConsidered: number;
  /** item_keys scoreItem was actually called on this pass. */
  itemsScored: number;
  /** item_keys left alone: already fully scored under this version, or currently zero beats. */
  itemsSkipped: number;
  /** Total item_scores rows appended this pass (sum of scoreItem's own per-call row counts). */
  rowsWritten: number;
  /**
   * Per-item_key failures, isolated rather than aborting the pass --
   * mirrors src/scheduler/run.ts's "one dead feed never takes down the run"
   * (there, a source; here, an item). A real, reachable cause: an item
   * ingested under a source_id later removed from config/sources.yaml makes
   * scoreItem throw UnknownSourceError for that one item_key; every OTHER
   * item_key must still get scored.
   */
  failures: ScoringPassFailure[];
}

/** Every distinct item_key in `items`, scored or not, in a deterministic order. */
export function listAllItemKeys(db: Db): string[] {
  const rows = db.prepare('select distinct item_key from items order by item_key').all() as Array<{
    item_key: string;
  }>;
  return rows.map((r) => r.item_key);
}

/**
 * True if EVERY beat in `beats` (the caller resolves this once via
 * getItemBeats and passes it in -- this function makes no DB call beyond
 * getLatestItemScore, one per beat) has an item_scores row whose
 * scorer_version equals `scorerVersion`. Vacuously true for an empty `beats`
 * list (nothing to check) -- callers that care about "is there anything to
 * score at all" check `beats.length` themselves (see runScoringPass below),
 * because "no beats" and "fully scored" are different reasons to skip an
 * item_key and the summary counts them identically as `itemsSkipped` either
 * way.
 *
 * See the module doc comment for what this misses ON PURPOSE (a bare
 * re-delivery of an unchanged item_id) and what it catches ON PURPOSE (a
 * scorer_version bump, a newly-added beat).
 */
export function isFullyScored(db: Db, itemKey: string, beats: readonly Beat[], scorerVersion: string): boolean {
  for (const beat of beats) {
    const latest = getLatestItemScore(db, itemKey, beat);
    if (!latest || latest.scorerVersion !== scorerVersion) return false;
  }
  return true;
}

/**
 * Scores every item_key in the database that needs it (see the module doc
 * comment for the full "unscored" definition), or -- with `options.force` --
 * every item_key with at least one beat, unconditionally. Does NOT run
 * clustering; the caller is responsible for that ordering (module doc
 * comment, "Clustering dependency"). Never applies or stores a decayed
 * value: `now` is used only as scoreItem's own bookkeeping timestamp and
 * `asOf` argument to its internal cluster-size lookup, exactly as
 * scoreItem's own contract documents -- this module never imports
 * src/score/decay.ts (pass.test.ts greps for this directly).
 *
 * One item_key's failure (see ScoringPassFailure) never aborts the pass --
 * every other item_key is still attempted.
 */
export function runScoringPass(db: Db, deps: ScoreItemDeps, now: string, options: ScoringPassOptions = {}): ScoringPassSummary {
  assertCanonicalTimestamp('now', now);
  const force = options.force ?? false;

  const itemKeys = listAllItemKeys(db);
  let itemsScored = 0;
  let itemsSkipped = 0;
  let rowsWritten = 0;
  const failures: ScoringPassFailure[] = [];

  for (const itemKey of itemKeys) {
    const beats = getItemBeats(db, itemKey);
    if (beats.length === 0) {
      itemsSkipped++;
      continue;
    }

    const due = force || !isFullyScored(db, itemKey, beats, deps.config.scorer_version);
    if (!due) {
      itemsSkipped++;
      continue;
    }

    try {
      const rows = scoreItem(db, itemKey, now, deps);
      itemsScored++;
      rowsWritten += rows.length;
    } catch (cause) {
      failures.push({ itemKey, error: (cause as Error).message });
    }
  }

  return {
    scorerVersion: deps.config.scorer_version,
    candidatesConsidered: itemKeys.length,
    itemsScored,
    itemsSkipped,
    rowsWritten,
    failures,
  };
}

export interface ScoringPassConfigPaths {
  sourcesPath: string;
  interestsPath: string;
  scoringConfigPath: string;
}

/**
 * Convenience wrapper: loads all three configs scoreItem needs from disk,
 * then runs the pass. Mirrors src/cluster/run.ts's
 * runClusteringPassFromConfigFile.
 */
export function runScoringPassFromConfigFiles(
  db: Db,
  paths: ScoringPassConfigPaths,
  now: string,
  options: ScoringPassOptions = {},
): ScoringPassSummary {
  const deps: ScoreItemDeps = {
    sources: loadSourcesFile(paths.sourcesPath),
    interestProfile: loadInterestsFile(paths.interestsPath),
    config: loadMechanicalScoreConfig(paths.scoringConfigPath),
  };
  return runScoringPass(db, deps, now, options);
}

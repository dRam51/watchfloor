/**
 * The read-time ranking composition (M2 Task 9): the ONE place decay legally
 * enters this task (constraint 1 -- "if your CLI displays a ranking, it
 * applies decay at display time from the reader's now"). Nothing here writes
 * to the database; every function is a read composing three already-tested
 * primitives -- src/score/mechanical.ts's getLatestItemScore (the STORED,
 * decay-invariant components), src/score/decay.ts's computeDecayFactor (the
 * multiplier, computed fresh on every call from the reader's own `now`), and
 * src/score/overrides.ts's evaluateOverrides (the hard-pin bypass) -- into
 * one sorted, human-judgeable list per beat. src/bin/rank.ts is the thin CLI
 * that calls this.
 *
 * ---------------------------------------------------------------------------
 * Why cluster size is read as of the SCORE's own computed_at, not `now`
 * ---------------------------------------------------------------------------
 * getClusterSizeAsOf(db, itemKey, asOf) can answer "as of when": scoreItem
 * (mechanical.ts) already calls it with asOf = the scoring pass's own `now`,
 * baking that snapshot into the stored signal/read numbers. If this module
 * instead asked "as of right now" for DISPLAY, a late clustering pass could
 * show a cluster size the displayed score was never actually computed
 * against -- a reader would see "3 sources" next to a number that was
 * computed back when it was a singleton, which is more confusing than
 * informative. Using the score's own computed_at keeps the displayed cluster
 * size and the displayed score numbers describing the SAME instant, at the
 * cost of the count occasionally reading one story "behind" a clustering
 * pass that ran after the last scoring pass -- exactly the reason
 * src/bin/score.ts runs clustering, THEN scoring, in that order: the count
 * catches up on the very next scoring pass, never silently out of sync with
 * the number displayed beside it. rank.test.ts's "cluster size reflects the
 * score's own computed_at" block proves this concretely, both before and
 * after a rescore.
 *
 * ---------------------------------------------------------------------------
 * What "the top items" sorts by, and how overrides interact with sorting
 * ---------------------------------------------------------------------------
 * Two scores, never blended (no composite number is ever computed here) --
 * but ONE ordering has to come out the far end of "list the top N", so
 * sortRanked takes an explicit `profile` ('signal' or 'read', default
 * 'signal' in rankBeat -- src/bin/rank.ts's own default too) and sorts by
 * THAT profile's own decayed score, with the SAME profile's own
 * evaluateOverrides result deciding what pins to the top -- mirroring
 * overrides.ts's own documented "composition contract" for how a caller
 * should combine an OverrideResult with an ordinary computed score. This
 * generalizes correctly even though every rule shipped in
 * config/overrides.yaml today is `applies_to: [signal]` (overrides.ts's own
 * module doc comment): sorting by 'read' with today's config simply never
 * finds a pinned item, which is the documented, correct behaviour, not a gap
 * this module papers over.
 */

import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp, getCurrentItem, type Beat, type ItemType } from '../domain/item.ts';
import { getItemFirstFetchedAt } from '../domain/itemFirstFetchedAt.ts';
import { getClusterSizeAsOf } from '../cluster/store.ts';
import { getLatestItemScore } from './mechanical.ts';
import { computeDecayFactor, loadDecayConfig, type DecayConfig, type ScoreProfile } from './decay.ts';
import { evaluateOverrides, loadOverridesConfig, type OverridesConfig, type OverrideResult } from './overrides.ts';

/** 'signal' | 'read' -- structurally the same two-value union as decay.ts's ScoreProfile and overrides.ts's OverrideProfile; reused rather than re-declared. */
export type SortProfile = ScoreProfile;

export interface RankedItem {
  itemKey: string;
  itemId: string;
  title: string;
  sourceId: string;
  beat: Beat;
  publishedAt: string | null;
  itemType: ItemType;
  /** getClusterSizeAsOf as of THIS SCORE's own computed_at -- see module doc comment. */
  clusterSize: number;
  scorerVersion: string;
  computedAt: string;
  /** The stored, decay-invariant component -- never changes between two reads of the same row. */
  signalScoreRaw: number;
  readScoreRaw: number;
  /** computeDecayFactor's output for this read's `now` -- recomputed every call. */
  signalDecayFactor: number;
  readDecayFactor: number;
  /** signalScoreRaw * signalDecayFactor -- decay applied HERE, never stored. */
  signalScore: number;
  /** readScoreRaw * readDecayFactor -- decay applied HERE, never stored. */
  readScore: number;
  signalOverride: OverrideResult;
  readOverride: OverrideResult;
}

export interface RankDeps {
  decayConfig: DecayConfig;
  overridesConfig: OverridesConfig;
}

export interface BeatRanking {
  beat: Beat;
  /** Distinct item_keys currently attributed to this beat (union across every item_id sharing a key, same semantics as getItemBeats read in the opposite direction), scored or not. */
  candidateCount: number;
  /** Of those, how many have a score row for this beat and appear in `items` below. */
  scoredCount: number;
  /** `scoredCount` items, sorted by the requested profile. */
  items: RankedItem[];
}

/**
 * Every item_key ever attributed to `beat` by any item_id sharing its key --
 * the same union semantics as src/domain/itemBeats.ts's getItemBeats, read
 * in the opposite direction (beat -> item_keys instead of item_key -> beats).
 */
export function getItemKeysForBeat(db: Db, beat: Beat): string[] {
  const rows = db
    .prepare(
      `select distinct i.item_key as item_key
       from item_beats ib
       join items i on i.item_id = ib.item_id
       where ib.beat = ?
       order by i.item_key`,
    )
    .all(beat) as Array<{ item_key: string }>;
  return rows.map((r) => r.item_key);
}

function buildRankedItemsForKeys(db: Db, itemKeys: readonly string[], beat: Beat, now: string, deps: RankDeps): RankedItem[] {
  const results: RankedItem[] = [];

  for (const itemKey of itemKeys) {
    const score = getLatestItemScore(db, itemKey, beat);
    if (!score) continue; // never scored for this beat -- excluded, not an error

    const item = getCurrentItem(db, itemKey);
    if (!item) continue; // unreachable: itemKey came from a real items/item_beats join moments ago

    // getItemFirstFetchedAt is null only for an item_key with zero rows in
    // `items` -- unreachable here (see above). The fallback exists only to
    // satisfy the string|null return type without a cast.
    const firstFetchedAt = getItemFirstFetchedAt(db, itemKey) ?? item.fetchedAt;

    // The score's own computed_at, NOT `now` -- see module doc comment.
    const clusterSize = getClusterSizeAsOf(db, itemKey, score.computedAt);

    const decayInput = { publishedAt: item.publishedAt, firstFetchedAt, beat, itemType: item.itemType };
    const signalDecayFactor = computeDecayFactor(decayInput, 'signal', now, deps.decayConfig);
    const readDecayFactor = computeDecayFactor(decayInput, 'read', now, deps.decayConfig);

    const overrideInput = { sourceId: item.sourceId, publishedAt: item.publishedAt, rawJson: item.rawJson };
    const signalOverride = evaluateOverrides(overrideInput, 'signal', now, deps.overridesConfig);
    const readOverride = evaluateOverrides(overrideInput, 'read', now, deps.overridesConfig);

    results.push({
      itemKey,
      itemId: item.item_id,
      title: item.title,
      sourceId: item.sourceId,
      beat,
      publishedAt: item.publishedAt,
      itemType: item.itemType,
      clusterSize,
      scorerVersion: score.scorerVersion,
      computedAt: score.computedAt,
      signalScoreRaw: score.signalScore,
      readScoreRaw: score.readScore,
      signalDecayFactor,
      readDecayFactor,
      signalScore: score.signalScore * signalDecayFactor,
      readScore: score.readScore * readDecayFactor,
      signalOverride,
      readOverride,
    });
  }

  return results;
}

/** Standalone convenience: resolves the beat's candidate item_keys itself. Use rankBeat instead if you also need candidateCount without a second query. */
export function buildRankedItems(db: Db, beat: Beat, now: string, deps: RankDeps): RankedItem[] {
  assertCanonicalTimestamp('now', now);
  return buildRankedItemsForKeys(db, getItemKeysForBeat(db, beat), beat, now, deps);
}

function overrideFor(item: RankedItem, profile: SortProfile): OverrideResult {
  return profile === 'signal' ? item.signalOverride : item.readOverride;
}
function scoreFor(item: RankedItem, profile: SortProfile): number {
  return profile === 'signal' ? item.signalScore : item.readScore;
}

/**
 * Pinned items (per `profile`'s own override result) first, sorted by
 * priority ascending; then every other item by `profile`'s own decayed score
 * descending; ties broken by title for a deterministic order. Returns a NEW
 * array -- never mutates `items`.
 */
export function sortRanked(items: readonly RankedItem[], profile: SortProfile): RankedItem[] {
  return [...items].sort((a, b) => {
    const aOv = overrideFor(a, profile);
    const bOv = overrideFor(b, profile);
    if (aOv.pinned !== bOv.pinned) return aOv.pinned ? -1 : 1;
    if (aOv.pinned && bOv.pinned && aOv.priority !== bOv.priority) {
      return aOv.priority! - bOv.priority!;
    }
    const byScore = scoreFor(b, profile) - scoreFor(a, profile);
    if (byScore !== 0) return byScore;
    return a.title.localeCompare(b.title);
  });
}

/** Composes getItemKeysForBeat + buildRankedItemsForKeys + sortRanked into one beat's ranking. */
export function rankBeat(db: Db, beat: Beat, now: string, deps: RankDeps, profile: SortProfile = 'signal'): BeatRanking {
  assertCanonicalTimestamp('now', now);
  const itemKeys = getItemKeysForBeat(db, beat);
  const items = buildRankedItemsForKeys(db, itemKeys, beat, now, deps);
  return { beat, candidateCount: itemKeys.length, scoredCount: items.length, items: sortRanked(items, profile) };
}

/** Convenience wrapper: loads both configs rankBeat needs from disk. */
export function loadRankDepsFromConfigFiles(decayConfigPath: string, overridesConfigPath: string): RankDeps {
  return {
    decayConfig: loadDecayConfig(decayConfigPath),
    overridesConfig: loadOverridesConfig(overridesConfigPath),
  };
}

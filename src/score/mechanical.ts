import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp, getCurrentItem, type Beat } from '../domain/item.ts';
import { getItemBeats } from '../domain/itemBeats.ts';
import { getItemEntities } from '../domain/itemEntities.ts';
import { getClusterSizeAsOf } from '../cluster/store.ts';
import { matchProfile, type InterestProfile, type ProfileMatches } from '../interests/load.ts';
import type { Source } from '../sources/load.ts';
import { tryReadPortfolioFile } from './overrides.ts';
import { RepoScoringConfigSchema, resolveRepoSignal, type RepoSignal } from './repoSignal.ts';

// ---------------------------------------------------------------------------
// The mechanical scorer (M2 task 5 / §5, §5.1): combines source trust weight,
// cluster size, and interest-profile matches into the DECAY-INVARIANT
// components of signal_score and read_score, and writes them to item_scores.
//
// THE SINGLE MOST IMPORTANT CONSTRAINT: this module NEVER applies recency
// decay. item_scores is append-only, and a continuously-decaying value has
// no stable row to append -- src/score/decay.ts (config/decay.yaml) owns
// decay, applied at READ time from published_at and the reader's own now.
// Nothing in this file imports src/score/decay.ts, calls decayFactor or
// computeDecayFactor, or accepts a timestamp anywhere in the PURE formula
// (computeMechanicalScore's input type carries no date field at all -- a
// structural guarantee, not just a promise; tests/score/mechanical.test.ts
// greps this file's own source for exactly that). The only timestamp this
// module touches is `now`, threaded through scoreItem for two purposes only:
// stamping computed_at (bookkeeping, not decay) and as the `asOf` argument to
// getClusterSizeAsOf (a point-in-time snapshot of corroboration AT SCORING
// TIME, not a decay factor -- see that function's own doc comment). Neither
// use makes the stored signal_score/read_score change with the passage of
// time after the row is written.
//
// ---------------------------------------------------------------------------
// The item_id-vs-item_key decision (this milestone's fifth instance)
// ---------------------------------------------------------------------------
//
// item_scores is keyed on item_id (a specific stored VERSION), with a NOT
// NULL foreign key to items(item_id) -- enforced live (src/db/connection.ts
// sets `pragma foreign_keys = ON`), so every row this module writes must
// reference a real, existing item_id. But every INPUT this module needs is
// resolved per item_KEY (the stable identity across versions): getItemBeats,
// getItemEntities, getClusterSizeAsOf all take an item_key, exactly like the
// three precedents this milestone already fixed for the identical reason
// (src/domain/itemBeats.ts, itemEntities.ts, itemFirstFetchedAt.ts -- each
// exists because a naive single-version read returned a PLAUSIBLE wrong
// answer, not an obviously broken one).
//
// DECISION: a scoring pass resolves the item_key's CURRENT item_id (via
// getCurrentItem, the same `order by fetched_at desc, rowid desc` tie-break
// every other read in this codebase uses) and writes against THAT single
// item_id -- one row per beat the item_key belongs to, not one row per
// item_id sharing the key.
//
// CONSIDERED AND REJECTED: writing an identical row against EVERY item_id
// sharing the item_key, so a naive `item_id = getCurrentItem(...).item_id`
// join always finds something regardless of which version is "current" at
// read time. Rejected because `items` is append-only and NEVER dedupes on
// content (src/domain/itemFirstFetchedAt.ts's module doc comment: a source
// that re-delivers an unchanged entry still produces a brand-new item_id) --
// cisa-kev alone re-dumps its full catalog on nearly every poll that adds any
// new CVE. Duplicating a score row across every item_id sharing a key would
// make item_scores' row count grow with the number of RE-DELIVERIES of an
// unchanged item, not just the number of genuine scoring passes -- a worse-
// shaped version of exactly the "unbounded accumulation under append-only,
// poll-forever storage" hazard src/score/overrides.ts's module doc comment
// identifies and bounds for cisa-kev's own override rule. Attaching to a
// single current item_id per pass keeps item_scores' growth at O(scoring
// passes), not O(scoring passes x re-deliveries).
//
// THE COST OF THIS DECISION, STATED PLAINLY: if a new item_id for an
// already-scored item_key is inserted AFTER a scoring pass runs (a
// re-delivered duplicate, a correction, a second cross-listing arriving
// later), that new item_id has NO score row of its own until the next
// scoring pass. A read that naively does
// `item_scores where item_id = getCurrentItem(itemKey).item_id` would then
// find NOTHING, even though a perfectly good, still-accurate score exists
// for the item under its previous version -- exactly the shape of bug this
// milestone has already fixed four times (a plausible wrong/missing answer
// from reading a single version instead of the item).
//
// HOW A READER RETRIEVES THE RIGHT ROW: getLatestItemScore(db, itemKey,
// beat), below -- a NEW item_key-scoped read function mirroring
// getItemBeats/getItemEntities/getItemFirstFetchedAt exactly. It joins
// item_scores to items on item_id, filters to every item_id sharing the
// given item_key, and returns the row with the greatest computed_at (ties
// broken by rowid desc, the same tiebreak convention item.ts's
// getCurrentItem and cluster/store.ts's getClusterSizeAsOf already use) --
// regardless of which specific item_id it happens to be attached to. This
// guarantees the freshest KNOWN score for the ITEM is always found, even
// when the "current" item_id has moved on to a newer, not-yet-scored
// version. A caller (Task 9's future scoring-pass CLI, a future API) should
// call getLatestItemScore, never a raw `item_scores where item_id = ?`
// query keyed off getCurrentItem's result.
//
// ---------------------------------------------------------------------------
// item_type is NOT an input to this scorer -- a live correction, not an
// oversight
// ---------------------------------------------------------------------------
//
// An earlier draft of this module (and of config/scoring.yaml) used
// item.itemType as a multiplier, reading the plan's "timeliness-as-a-
// property-of-the-item" (signal_score) and "press is the churn bucket that
// must be suppressed in both views" (M1-handed-forward section) as a mandate
// to differentiate event/analysis/press. That was corrected mid-implementation
// once M2 task 7's real measurement came back: item_type is CURRENTLY
// effectively BINARY -- `event` for exactly the four government-primary
// source_ids (cisa-kev, cisa-advisories, federal-register, whitehouse-actions)
// and `analysis` for literally everything else, including real sports and
// Spanish-language wire copy (verified live: "Howard, Gray each score 29
// points as the Dream ease by the Sun 104-69" and "Swiatek vence a Rybakina
// en Toronto" both classify `analysis`). `press` -- the one case that would
// have added independent information -- is PR-wire syndication specifically
// (PRNewswire/BusinessWire/GlobeNewswire brand tokens, IR legal boilerplate)
// and matches 0 of 3,325 real items; no configured source is a PR-wire
// distributor (src/classify/itemType.ts, not modified here).
//
// Given that, an item_type-keyed multiplier here would do one of two bad
// things: (a) for `event`, add nothing beyond what `source.*` below already
// captures, since `event` is 100% determined by source_id membership in a
// fixed 4-source list already reflected in that source's own trust weight;
// or (b) for `analysis` vs `press`, create the ILLUSION of a content-quality
// signal that the real data cannot support -- `analysis` is a catch-all
// containing both a frontier-model research paper and a bare box score.
// Rather than ship a lookup table that is quietly a no-op (or worse, quietly
// wrong), this scorer omits item_type entirely. This project's convention
// (src/score/overrides.ts's two unreachable override categories,
// config/interests.yaml's empty press-release term list) is that an ABSENT
// mechanism is documented as absent, not implied to work -- an inert-but-
// present lookup table would violate that convention as surely as a silently
// broken one would. `Item.itemType` remains available on every row for a
// future scorer version to use once a further classifier refinement gives it
// independent discriminating power again; picking it up is a scorer_version
// bump (see below), not a schema change. See config/scoring.yaml's header
// and task-5-report.md for the full account, including the worked numbers
// the earlier draft was built on.
//
// One direct consequence, stated honestly rather than left for a reader to
// discover: because item_type cannot separate churn from depth today,
// read_score's "depth"/"explanatory value" claim is NOT modeled by this
// scorer at all beyond what source trust, corroboration, and interest
// matches already capture. A terse government notice and an in-depth
// analysis piece from sources of similar trust weight can receive similar
// mechanical read_score components; the two-score system's real signal/read
// DIVERGENCE is deliberately concentrated in decay (sharp vs slow half-life,
// src/score/decay.ts) rather than fabricated here from an input that cannot
// currently support the distinction.
//
// ---------------------------------------------------------------------------
// What each score is built from, and why
// ---------------------------------------------------------------------------
//
// Three normalized components, per config/scoring.yaml (full formula and a
// worked numeric example in that file's header):
//
//   sourceComponent   config/sources.yaml's trust weight (0.1-2.0),
//                     normalized to 0..1. A primary/high-trust source is
//                     both more likely to be materially significant
//                     (signal) and more likely to BE the primary source
//                     worth reading directly (read) -- weighted IDENTICALLY
//                     for both profiles, deliberately: this scorer has no
//                     grounded basis to claim source trust matters more to
//                     one profile than the other, and fabricating an
//                     asymmetry here would repeat the exact mistake just
//                     corrected for item_type.
//
//   clusterComponent  getClusterSizeAsOf's corroboration count, log-scaled
//                     and saturating, normalized to 0..1. Weighted MORE
//                     heavily for signal_score than read_score --
//                     corroboration (carried by AP *and* NPR *and* PBS) is
//                     close to a direct definition of §5.1's "materiality"
//                     for signal (M1's own prediction), but for read_score's
//                     "non-duplication" claim, heavy corroboration is at
//                     best a weaker positive: once a story is available from
//                     several outlets, one more copy's marginal read-value
//                     doesn't scale with source count the way its material
//                     significance does. This is the one place signal_score
//                     and read_score's MECHANICAL components genuinely
//                     diverge from each other by design (as opposed to
//                     merely being computed independently) -- see
//                     config/scoring.yaml's header for the reasoning against
//                     modeling this as an outright penalty instead (would
//                     need real per-reader read-history data this milestone
//                     doesn't have).
//
//   interestMultiplier  src/interests/load.ts's matchProfile, run against
//                     buildScoringText(title, summaryRaw, entities) --
//                     folding entities (getItemEntities, unioned across
//                     every item_id sharing the item_key, per Task 3/10's
//                     established pattern) into the SAME matchable text as
//                     title/summary is how this scorer answers §5.1's
//                     "entity match" for signal_score, without inventing a
//                     second matching mechanism: an entity extractor landing
//                     later (none exists yet -- item_entities carries 0 real
//                     rows, per itemEntities.ts's own doc comment) makes
//                     entity matches count automatically, no code change
//                     needed here. Boost/suppress weights (each already
//                     0.1-2.0, config/interests.yaml) sum and combine into
//                     ONE multiplier applied identically to both scores --
//                     "would I want to see/read this" applies to both
//                     machine-relevance and human-interest framings equally.
//                     suppress_gain > boost_gain (config/scoring.yaml) so a
//                     confident "not this" can crush a score harder than a
//                     match lifts one, matching the M2 acceptance goal of
//                     getting suppressed categories OFF the list rather than
//                     merely below the boosted ones.
//
// HONEST LIMITATION, verified live rather than assumed: interest-based
// suppression only fires for a headline containing a configured keyword
// term. It does NOT catch team/player-name-only sports headlines ("Howard,
// Gray each score 29 points...") or non-English wire copy ("Swiatek vence a
// Rybakina en Toronto") -- both verified zero-match against the real,
// shipped config/interests.yaml. These are Task 1's own documented, pre-
// existing gaps (M2 progress.md), not something this scorer closes, hides,
// or claims to have fixed; item_type cannot compensate for them either (see
// above). tests/score/mechanical.test.ts asserts both gaps directly against
// real titles rather than asserting a false "sports is suppressed" claim
// against an easy, keyword-bearing example alone.
//
// ---------------------------------------------------------------------------
// High-on-both -- flagged without a third schema column
// ---------------------------------------------------------------------------
//
// item_scores has exactly two score columns, by design (§5's schema). The
// plan says items scoring high on both are rare and disproportionately
// valuable and should be flagged; isHighOnBoth (below) is that flag,
// DERIVED at read time from the two stored numbers against config-driven
// thresholds -- never itself stored, the same "derived, not stored" stance
// src/score/decay.ts takes toward recency. A caller (a future API/UI) calls
// it against whatever getLatestItemScore returns; nothing about it requires
// a schema change or a third column.
//
// ---------------------------------------------------------------------------
// What scorer_version holds, and when it changes
// ---------------------------------------------------------------------------
//
// A plain string, config-driven (config/scoring.yaml's scorer_version field),
// written verbatim into every row this module writes. It is how a rescore is
// told apart from an original: item_scores is append-only, so two rows for
// the same (item_id, beat) differing only in computed_at are two POINTS IN
// TIME under the same ruleset, while two rows differing in scorer_version
// are two different ruleses entirely (a coefficient retune, a formula
// change). Convention, matching every other config file in this codebase
// (decay.yaml, interests.yaml, overrides.yaml all rely on the owner editing
// thoughtfully rather than on an enforced mechanism): bump this string
// whenever a change to config/scoring.yaml's numbers, or to this file's
// formula shape, would produce a different score for the same inputs; a
// change that does NOT affect the arithmetic (a comment, a doc-comment fix)
// must NOT bump it. Not auto-derived (e.g. a hash of the config) --
// deliberately: no other config in this codebase auto-versions itself, and
// adding that machinery here alone would be a new, inconsistent pattern for
// a small benefit (see task-5-report.md for the fuller weighing).
//
// ---------------------------------------------------------------------------
// Portfolio proximity -- explicit no-op, consistent with Task 6's convention
// ---------------------------------------------------------------------------
//
// "Portfolio proximity is an explicit no-op stub until M4b -- named, tested
// as a no-op, not silently absent" (the plan). Task 6 already built this
// exact pattern for hard overrides (src/score/overrides.ts's portfolio_stub
// rule kind: config carrying only a path, tryReadPortfolioFile returning
// null when absent, the read happening but never influencing the result).
// resolvePortfolioProximity below is the identical treatment applied to a
// SCORE COMPONENT rather than an override rule -- a conceptually distinct
// feature (a score contribution vs. a bypass-the-score-entirely bypass) that
// deliberately reuses Task 6's already-tested tryReadPortfolioFile rather
// than reimplementing "read a YAML file, tolerate ENOENT" a second time.
// Called from scoreItem (the I/O boundary) once per item, its return value
// (always exactly 0) is NOT threaded into computeMechanicalScore's pure
// formula as a parameter: since it can only ever be 0 today, accepting it as
// a parameter every caller must supply as a literal 0 would blur the pure/
// impure boundary (computeMechanicalScore reads no filesystem; whether
// config/portfolio.yaml exists is an I/O fact) for no present benefit. The
// function is still directly, independently tested (see
// tests/score/mechanical.test.ts) proving the read genuinely happens (it
// propagates a throw on malformed-but-present YAML, exactly like
// tryReadPortfolioFile itself) rather than being a stub that never touches
// the filesystem.
// ---------------------------------------------------------------------------

export class MechanicalScoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MechanicalScoreConfigError';
  }
}

export class UnknownItemKeyError extends Error {
  constructor(itemKey: string) {
    super(`scoreItem: no item found for item_key '${itemKey}' -- an item must be ingested before it can be scored`);
    this.name = 'UnknownItemKeyError';
  }
}

export class UnknownSourceError extends Error {
  constructor(sourceId: string) {
    super(`scoreItem: source '${sourceId}' is not present in the supplied sources config -- cannot resolve a trust weight`);
    this.name = 'UnknownSourceError';
  }
}

// ---------------------------------------------------------------------------
// Config schema. Field names mirror the YAML 1:1 (snake_case), matching
// src/score/decay.ts / src/score/overrides.ts / src/interests/load.ts's
// convention for config-derived types.
// ---------------------------------------------------------------------------

// Mirrors src/score/overrides.ts's identically-named, identically-reasoned
// refinement exactly (that module's own comment: "duplicating a five-line
// check is cheaper than widening this task's file scope to export one" --
// the same reasoning applies here in reverse: overrides.ts is a sibling
// task's file, off-limits to edit, so its copy is not imported either).
const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p), {
    message: 'must be a relative path — absolute paths do not survive migration',
  });

const SourceConfigSchema = z
  .object({
    min_weight: z.number().finite(),
    max_weight: z.number().finite(),
    signal_weight: z.number().nonnegative().finite(),
    read_weight: z.number().nonnegative().finite(),
  })
  .strict()
  .refine((c) => c.min_weight < c.max_weight, { message: 'source.min_weight must be less than source.max_weight' });

const ClusterConfigSchema = z
  .object({
    saturation_size: z.number().finite(),
    signal_weight: z.number().nonnegative().finite(),
    read_weight: z.number().nonnegative().finite(),
  })
  .strict()
  .refine((c) => c.saturation_size > 1, {
    message:
      'cluster.saturation_size must be greater than 1 -- log2(1) is always 0, so a saturation_size of 1 (or less) would make normalizeClusterSize saturate at cluster size 1, before any real corroboration is possible',
  });

const InterestConfigSchema = z
  .object({
    boost_gain: z.number().nonnegative().finite(),
    suppress_gain: z.number().nonnegative().finite(),
    multiplier_floor: z.number().finite(),
    multiplier_ceiling: z.number().finite(),
  })
  .strict()
  .refine((c) => c.multiplier_floor < c.multiplier_ceiling, {
    message: 'interest.multiplier_floor must be less than interest.multiplier_ceiling',
  });

const HighOnBothConfigSchema = z
  .object({
    signal_threshold: z.number().finite(),
    read_threshold: z.number().finite(),
  })
  .strict();

const PortfolioConfigSchema = z
  .object({
    portfolio_path: relativePath,
  })
  .strict();

const MechanicalScoreConfigSchema = z
  .object({
    scorer_version: z.string().min(1),
    source: SourceConfigSchema,
    cluster: ClusterConfigSchema,
    interest: InterestConfigSchema,
    high_on_both: HighOnBothConfigSchema,
    portfolio: PortfolioConfigSchema,
    // OPTIONAL, and that is load-bearing in two directions. A config without a
    // `repos:` block scores exactly as it did before M4a -- which is what keeps
    // every existing hand-built test config valid, and what makes "the repos
    // mechanism is absent" an expressible state rather than an inert table
    // (this project's convention: an absent mechanism is documented as absent,
    // never implied to work). And because the block is the ONLY thing that
    // enables the two repo terms, deleting it is a complete, one-edit rollback.
    repos: RepoScoringConfigSchema.optional(),
  })
  .strict();

export type MechanicalScoreConfig = z.infer<typeof MechanicalScoreConfigSchema>;

/** Parses and validates mechanical-scorer config YAML text. No filesystem access. */
export function parseMechanicalScoreConfig(yamlText: string): MechanicalScoreConfig {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (cause) {
    throw new MechanicalScoreConfigError(`could not parse YAML: ${(cause as Error).message}`);
  }

  const result = MechanicalScoreConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new MechanicalScoreConfigError(`invalid scoring config:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Reads and validates the mechanical-scorer config at `path`. The only I/O in this function. */
export function loadMechanicalScoreConfig(path: string): MechanicalScoreConfig {
  return parseMechanicalScoreConfig(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// The pure formula pieces -- each independently exported and tested, mirroring
// src/score/decay.ts's granularity (effectivePublishedAt, decayFactor,
// resolveHalfLifeHours each separately exported and tested before being
// composed by computeDecayFactor).
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** config/sources.yaml's 0.1-2.0 trust weight, normalized to 0..1 and clamped. */
export function normalizeSourceWeight(sourceWeight: number, config: MechanicalScoreConfig): number {
  const { min_weight, max_weight } = config.source;
  return clamp((sourceWeight - min_weight) / (max_weight - min_weight), 0, 1);
}

/**
 * getClusterSizeAsOf's corroboration count, log2-scaled and saturating at
 * config.cluster.saturation_size, normalized to 0..1. `clusterSize` must be
 * >= 1 -- getClusterSizeAsOf (src/cluster/store.ts) never returns less (a
 * singleton is a "cluster of itself"), so anything below 1 reaching here is
 * a caller bug, not a state to accommodate silently.
 */
export function normalizeClusterSize(clusterSize: number, config: MechanicalScoreConfig): number {
  if (!(clusterSize >= 1)) {
    throw new RangeError(`normalizeClusterSize: clusterSize must be >= 1 (getClusterSizeAsOf never returns less), got ${clusterSize}`);
  }
  return clamp(Math.log2(clusterSize) / Math.log2(config.cluster.saturation_size), 0, 1);
}

/**
 * Sums matched boost/suppress weights (each already 0.1-2.0,
 * config/interests.yaml) and folds them into one multiplier, applied
 * identically to both signal_score and read_score. See this module's header
 * for why suppress_gain is configured higher than boost_gain.
 */
export function computeInterestMultiplier(matches: ProfileMatches, config: MechanicalScoreConfig): number {
  const boostSum = matches.boosts.reduce((sum, m) => sum + m.weight, 0);
  const suppressSum = matches.suppressions.reduce((sum, m) => sum + m.weight, 0);
  const raw = 1 + config.interest.boost_gain * boostSum - config.interest.suppress_gain * suppressSum;
  return clamp(raw, config.interest.multiplier_floor, config.interest.multiplier_ceiling);
}

/**
 * The repos lane's two components, as ALREADY-RESOLVED NUMBERS (M4a task 7).
 *
 * Numbers, not a `VelocityResult`, and the reason is the same structural
 * guarantee this module's header opens with: a VelocityResult carries
 * observation INSTANTS, so accepting one here would put a timestamp inside
 * computeMechanicalScore's input type and destroy the "structurally incapable
 * of applying decay" property. src/score/repoSignal.ts's velocityComponentFor
 * and hnComponentFor are where the union is unwrapped -- and they are the only
 * place, so the "insufficient history is exactly 0" decision is made once, in
 * the open, rather than by whichever caller reached for `?? 0` first.
 *
 * Both are decay-invariant: `velocityComponent` describes a rate measured
 * between two fixed past instants, and `hnComponent` describes what the corpus
 * contained as of the scoring pass's own `now` -- neither moves after the row
 * is written. That is the identical shape (and identical justification) as
 * clusterSize, which getClusterSizeAsOf already resolves `asOf` the pass's now.
 */
export interface RepoScoreComponents {
  /** Signed, in [-1, 1]. 0 means "no evidence", which includes "no history yet". */
  velocityComponent: number;
  /** In [0, 1]. How strongly HN has already covered this repo. Subtracted. */
  hnComponent: number;
}

export interface MechanicalScoreComponents {
  sourceWeight: number;
  clusterSize: number;
  interestMatches: ProfileMatches;
  /** Absent for every non-repo item -- the overwhelming majority. */
  repo?: RepoScoreComponents;
}

export interface MechanicalScoreResult {
  signalScore: number;
  readScore: number;
}

/**
 * The composed, pure entry point: no I/O, no clock, no timestamp anywhere in
 * its input type -- structurally incapable of applying decay (see this
 * module's header). `now`/`asOf` resolution (getClusterSizeAsOf) and every
 * other DB read happen in scoreItem, below; this function only combines
 * already-resolved numbers.
 */
export function computeMechanicalScore(components: MechanicalScoreComponents, config: MechanicalScoreConfig): MechanicalScoreResult {
  const sourceComponent = normalizeSourceWeight(components.sourceWeight, config);
  const clusterComponent = normalizeClusterSize(components.clusterSize, config);
  const interestMultiplier = computeInterestMultiplier(components.interestMatches, config);

  let baseSignal = config.cluster.signal_weight * clusterComponent + config.source.signal_weight * sourceComponent;
  let baseRead = config.cluster.read_weight * clusterComponent + config.source.read_weight * sourceComponent;

  // The repos lane's two terms (M4a task 7 / §4). Applied only when BOTH the
  // item is a repo and the config carries weights for it -- either missing and
  // the formula is byte-identical to the pre-M4a one.
  //
  // ADDITIVE AND SUBTRACTIVE, never a multiplier. A multiplier would scale the
  // source and cluster terms, so a repo from a high-trust source would be
  // rewarded for velocity twice; and a de-rank expressed as a multiplier below
  // 1 approaches suppression asymptotically, which is precisely the boundary
  // §4 draws (its suppression list has four rules and HN overlap is not one).
  //
  // VELOCITY IS WEIGHTED FOR SIGNAL AS CORROBORATION IS: a repo's star rate is
  // the repos lane's direct evidence of §5.1's "materiality" -- the same role
  // "carried by AP *and* NPR *and* PBS" plays for a news story -- so
  // velocity.signal_weight mirrors cluster.signal_weight, and its read_weight
  // mirrors cluster.read_weight for the mirror-image reason: a rocketing repo
  // is materially significant NOW, but its star rate says little about whether
  // reading it repays the time.
  //
  // HN OVERLAP IS WEIGHTED IDENTICALLY FOR BOTH, deliberately, for exactly the
  // reason sourceComponent is (see this module's header): there is no grounded
  // basis to claim "I have already seen this" bears more on materiality than on
  // read-value, and inventing an asymmetry would repeat the item_type mistake
  // this scorer already had to correct once.
  if (config.repos && components.repo) {
    const { velocityComponent, hnComponent } = components.repo;
    baseSignal += config.repos.velocity.signal_weight * velocityComponent - config.repos.hn.signal_weight * hnComponent;
    baseRead += config.repos.velocity.read_weight * velocityComponent - config.repos.hn.read_weight * hnComponent;
  }

  return {
    signalScore: baseSignal * interestMultiplier,
    readScore: baseRead * interestMultiplier,
  };
}

/**
 * True if BOTH scores are at or above their configured high_on_both
 * threshold. Derived at read time from the two stored columns -- never
 * itself stored (see this module's header, "High-on-both").
 */
export function isHighOnBoth(result: MechanicalScoreResult, config: MechanicalScoreConfig): boolean {
  return result.signalScore >= config.high_on_both.signal_threshold && result.readScore >= config.high_on_both.read_threshold;
}

/**
 * Title + summary + entities, joined into one matchable text for
 * matchProfile. `entities` should come from getItemEntities (item_key-
 * scoped union), not a single version's own item_entities rows -- see this
 * module's header, "entity match".
 */
export function buildScoringText(title: string, summaryRaw: string | null, entities: readonly string[]): string {
  return [title, summaryRaw ?? '', ...entities].join(' ');
}

/**
 * M4b no-op (see this module's header, "Portfolio proximity"). The read
 * happens -- proving the plumbing works end to end against a real,
 * gitignored, possibly-absent file -- but the result is discarded
 * unconditionally: there is no portfolio schema, no holdings, no ticker list
 * to compute a real proximity FROM yet.
 */
export function resolvePortfolioProximity(portfolioPath: string): 0 {
  tryReadPortfolioFile(portfolioPath);
  return 0;
}

// ---------------------------------------------------------------------------
// DB-facing: writing scores
// ---------------------------------------------------------------------------

export interface ScoredRow {
  scoreId: string;
  itemId: string;
  beat: Beat;
  signalScore: number;
  readScore: number;
  scorerVersion: string;
  computedAt: string;
}

export interface ScoreItemDeps {
  sources: Source[];
  interestProfile: InterestProfile;
  config: MechanicalScoreConfig;
}

/**
 * Scores `itemKey` for every beat it belongs to (getItemBeats' union across
 * every item_id sharing the key) and appends one item_scores row per beat,
 * all attached to the item_key's CURRENT item_id as of `now` (see this
 * module's header, "The item_id-vs-item_key decision"). `now` is used only
 * as computed_at bookkeeping and as getClusterSizeAsOf's `asOf` -- never as
 * a decay input.
 *
 * Both scores are computed ONCE per item_key (not once per beat): nothing in
 * computeMechanicalScore's formula varies by beat, so the identical
 * signal_score/read_score pair is written once per beat purely so ranking
 * WITHIN each beat's own list works from a simple per-beat query, without a
 * cross-beat join.
 *
 * Throws UnknownItemKeyError if `itemKey` has never been ingested (a caller
 * error: nothing to score), and UnknownSourceError if the current item's
 * source_id is absent from `deps.sources` (a real configuration problem --
 * fails loudly rather than silently guessing a weight). Returns `[]`,
 * without writing anything, if the item currently has no item_beats rows at
 * all (a legitimate, if currently unreachable in practice, empty case --
 * mirrors getItemBeats' own "unknown key returns [], never a throw"
 * contract for "nothing to union").
 *
 * All writes for one call happen in a single transaction: either every
 * beat's row lands, or none do -- same pattern as src/cluster/store.ts's
 * writeClusters and src/domain/item.ts's insertItem.
 */
export function scoreItem(db: Db, itemKey: string, now: string, deps: ScoreItemDeps): ScoredRow[] {
  assertCanonicalTimestamp('now', now);

  const current = getCurrentItem(db, itemKey);
  if (!current) throw new UnknownItemKeyError(itemKey);

  const beats = getItemBeats(db, itemKey);
  if (beats.length === 0) return [];

  const source = deps.sources.find((s) => s.id === current.sourceId);
  if (!source) throw new UnknownSourceError(current.sourceId);

  const entities = getItemEntities(db, itemKey);
  const clusterSize = getClusterSizeAsOf(db, itemKey, now);
  const text = buildScoringText(current.title, current.summaryRaw, entities);
  const interestMatches = matchProfile(text, deps.interestProfile);

  // Portfolio proximity: named, wired into the real scoring path, an
  // unconditional no-op until M4b -- see resolvePortfolioProximity's doc
  // comment and this module's header. Computed once per item (a property of
  // the item), not once per beat.
  resolvePortfolioProximity(deps.config.portfolio.portfolio_path);

  // The repos lane (M4a task 7). Gated on the SOURCE TYPE, not on the beat and
  // not on the URL alone: `github_search` is the one source type that emits
  // repositories, so an HN story that happens to link to a repo root -- which
  // shares an item_key with the repo under append-only storage, and is a real
  // case -- never gets scored as if it were the repo. `now` reaches this only
  // as the `asOf` bound on both reads, exactly as it already does for
  // getClusterSizeAsOf; nothing here varies with the clock after the row lands.
  const repoSignal: RepoSignal | null =
    deps.config.repos && source.type === 'github_search'
      ? resolveRepoSignal(db, itemKey, current.canonicalUrl, now, deps.config.repos)
      : null;

  const { signalScore, readScore } = computeMechanicalScore(
    {
      sourceWeight: source.weight,
      clusterSize,
      interestMatches,
      ...(repoSignal
        ? { repo: { velocityComponent: repoSignal.velocityComponent, hnComponent: repoSignal.hnComponent } }
        : {}),
    },
    deps.config,
  );

  const rows: ScoredRow[] = [];
  const insert = db.prepare(
    `insert into item_scores (score_id, item_id, beat, signal_score, read_score, scorer_version, computed_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('begin');
  try {
    for (const beat of beats) {
      const scoreId = randomUUID();
      insert.run(scoreId, current.item_id, beat, signalScore, readScore, deps.config.scorer_version, now);
      rows.push({
        scoreId,
        itemId: current.item_id,
        beat,
        signalScore,
        readScore,
        scorerVersion: deps.config.scorer_version,
        computedAt: now,
      });
    }
    db.exec('commit');
  } catch (cause) {
    // SQLite can auto-rollback on some internal errors; guard against
    // "cannot rollback - no transaction is active" masking the real cause,
    // same pattern as src/db/migrate.ts, src/domain/item.ts's insertItem,
    // and src/cluster/store.ts's writeClusters.
    if (db.isTransaction) db.exec('rollback');
    throw cause;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// DB-facing: reading the latest score -- the item_key-aware read path (see
// this module's header, "How a reader retrieves the right row").
// ---------------------------------------------------------------------------

export interface ItemScoreRow {
  scoreId: string;
  itemId: string;
  beat: Beat;
  signalScore: number;
  readScore: number;
  scorerVersion: string;
  computedAt: string;
}

interface ItemScoreDbRow {
  score_id: string;
  item_id: string;
  beat: Beat;
  signal_score: number;
  read_score: number;
  scorer_version: string;
  computed_at: string;
}

/**
 * The most recently computed item_scores row for `itemKey` in `beat`,
 * regardless of which specific item_id (version) it is attached to --
 * joining item_scores to items on item_id and filtering by item_key, exactly
 * mirroring getItemBeats/getItemEntities/getItemFirstFetchedAt's "join
 * through items by item_key" shape. Returns `null` if `itemKey` has never
 * been scored for `beat` (an unknown key, an unscored item, or a beat it was
 * never scored under -- all the same "nothing here" state, never a throw).
 *
 * Ties on computed_at are broken by rowid desc (most recently inserted
 * wins) -- the same tiebreak convention src/domain/item.ts's getCurrentItem
 * and src/cluster/store.ts's getClusterSizeAsOf already use, for the same
 * reason: SQL guarantees no tiebreak among equal sort keys on its own, and
 * two scoring passes CAN legitimately share an instant (e.g. two `now`
 * values that happen to collide to millisecond precision in a batch run).
 *
 * Cost: one indexed-join query per call -- items_key_fetched (db/migrations/
 * 0001_init.sql) resolves item_key to its item_ids, item_scores_lookup
 * resolves each item_id/beat to its score rows. Not batched for a page of
 * many items, same not-yet-built note as itemBeats.ts/itemEntities.ts/
 * itemFirstFetchedAt.ts: O(items shown) queries for a list view, fine for a
 * single-item read, left unbuilt until something actually needs it in a
 * loop (Task 9, not this task).
 */
export function getLatestItemScore(db: Db, itemKey: string, beat: Beat): ItemScoreRow | null {
  const row = db
    .prepare(
      `select s.score_id as score_id, s.item_id as item_id, s.beat as beat,
              s.signal_score as signal_score, s.read_score as read_score,
              s.scorer_version as scorer_version, s.computed_at as computed_at
       from item_scores s
       join items i on i.item_id = s.item_id
       where i.item_key = ? and s.beat = ?
       order by s.computed_at desc, s.rowid desc
       limit 1`,
    )
    .get(itemKey, beat) as ItemScoreDbRow | undefined;

  if (!row) return null;
  return {
    scoreId: row.score_id,
    itemId: row.item_id,
    beat: row.beat,
    signalScore: row.signal_score,
    readScore: row.read_score,
    scorerVersion: row.scorer_version,
    computedAt: row.computed_at,
  };
}

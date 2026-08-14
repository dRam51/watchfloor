import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { BEATS, assertCanonicalTimestamp, type Beat, type ItemType } from '../domain/item.ts';

// ---------------------------------------------------------------------------
// Recency decay, applied at read time (M2 task 2 / §5.1).
//
// WHY READ TIME, NOT STORED: item_scores is append-only (db/migrations/
// 0001_init.sql). A decaying score changes continuously, so storing a
// decayed value would mean appending a new row per item per beat forever,
// recording nothing but the passage of time. Instead the scorer (a later
// task) stores decay-INVARIANT components -- source trust, cluster size,
// interest matches -- and a read query multiplies by the factor this module
// computes from `published_at` and the reader's own `now`.
//
// Consequence, intended: this module is a PURE function. No database, no
// I/O, no clock of its own -- `now` is always a parameter, config is always
// a parameter. That's what makes a historical query truthful: passing
// last Tuesday's `now` applies last Tuesday's decay to the components known
// then, rather than replaying today's ranking backwards (the same reasoning
// that drove the `as_of` work in M0/M1 -- see src/domain/item.ts's
// getItemAsOf). It's also what keeps this cheap enough to call twice per
// item (once per profile) in a list query over hundreds of rows: the hot
// path below is two Date.parse calls, a config object lookup, and one
// Math.pow -- no I/O anywhere in decayFactor/resolveHalfLifeHours/
// computeDecayFactor. (parseDecayConfig/loadDecayConfig DO touch the
// filesystem -- they are config loaders, called once at process start or
// on an explicit reload, never per item; kept in this file because the
// task's file scope is exactly {decay.ts, decay.test.ts, decay.yaml}.)
//
// TWO SCORES, NEVER BLENDED (§5.1): signal_score is machine relevance --
// sharp decay, half-life in hours. read_score is human interest -- slow
// decay, half-life in weeks, and a long-form piece must not fall off a
// cliff at two weeks. Half-lives are per item_type for the markets beat
// (an `event` decays fast, an `analysis` piece decays slowly -- see
// config/decay.yaml for why markets is keyed on item_type rather than
// beat) and per beat everywhere else. Both profiles are ALWAYS computed
// together for the same item (see computeDecayFactor's `profile`
// parameter) -- there is no code path that produces one without being able
// to produce the other from the identical inputs.
//
// THREE DELIBERATE DECISIONS, each real (not hypothetical) and each tested
// below rather than left to fall out of arithmetic by accident:
//
// 1. NULL published_at -- real: M1's first live ingest had 1,715 of 3,325
//    items with published_at NULL (1,665 of those from cisa-kev alone,
//    whose JSON feed carries no publish-date field at all; the normalizer
//    correctly refuses to guess). The options, weighed:
//      - treat as maximally old -> buries an undated item permanently, even
//        a genuinely important one (a KEV entry with no date is still a KEV
//        entry), and silently: append-only storage means this can never
//        self-correct once other components decay around it.
//      - treat as maximally fresh -> undated churn dominates every list
//        forever, and gets WORSE as more sources with unhandled date
//        formats appear (M1 already found two formats that needed fixing;
//        nothing guarantees the next one is caught before it ships).
//      - fall back to fetched_at -> ALWAYS defined (items.fetched_at is
//        NOT NULL), and defensible on its own terms: it answers "how long
//        since we noticed this" rather than "how long since this
//        happened" -- a different claim, but not an arbitrary one.
//    DECISION: fall back to fetched_at (see effectivePublishedAt). STATED
//    COST: a genuinely old document surfaced late (e.g. a historical CVE a
//    scanner only just found) reads as artificially fresh relative to an
//    item whose true publish date is known. That is accepted, not hidden.
//
// 2. FUTURE-DATED items -- real: the AP news-sitemap adapter (M1 task 8)
//    produced published_at values slightly ahead of fetchedAt/now during
//    the first live ingest. DECISION: age is clamped to >= 0, which caps
//    the decay factor at exactly 1.0 -- a future-dated item is treated as
//    "as fresh as possible right now", never boosted past that ceiling.
//    Letting the factor exceed 1.0 would let clock-skew or a sitemap bug
//    actively outrank a legitimately on-time fresh item; clamping merely
//    tolerates the defect instead of rewarding it.
//
// 3. NO FLOOR -- an exponential never reaches zero analytically, but IEEE
//    754 doubles underflow to literal 0.0 in practice once age exceeds
//    roughly 1075 half-lives (this is not exotic: at cyber's 6h signal
//    half-life that's only ~269 days). DECISION: no artificial floor or
//    hard cutoff -- decay is allowed to reach exactly 0. Considered and
//    rejected: a floor (e.g. clamping to some small epsilon) doesn't
//    remove ties among ancient items, it only relabels the age at which
//    they start -- every item older than the floor's own crossover point
//    still ties with every other one. Worse, for signal_score specifically
//    a floor actively fights the design intent: sharp/hours-scale decay
//    exists precisely so old material reads as irrelevant *now*, and a
//    floor that keeps it "a little relevant forever" undermines that. For
//    read_score the half-life is weeks-to-months, so underflow would take
//    centuries of item age -- not a practical concern there. Sort
//    stability among items that both land on exactly 0.0 is left to
//    whatever secondary sort key the read query already uses (e.g.
//    published_at) -- inventing one here would be scope this module
//    doesn't own.
// ---------------------------------------------------------------------------

export class DecayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecayConfigError';
  }
}

/**
 * Thrown by resolveHalfLifeHours when a `beat` or `item_type` has no entry
 * in the supplied config. Reachable even though the TypeScript types close
 * the door on this at compile time: `item_beats.beat` (db/migrations/
 * 0001_init.sql) carries no CHECK constraint the way `items.item_type` does,
 * so a bad value could in principle reach here from real data. Failing
 * loudly with a named error beats a bare "Cannot read properties of
 * undefined" three stack frames into a Math.pow call.
 */
export class UnknownDecayKeyError extends Error {
  constructor(kind: 'beat' | 'item_type', value: string) {
    super(`no half-life configured for ${kind} '${value}' -- config/decay.yaml is missing an entry`);
    this.name = 'UnknownDecayKeyError';
  }
}

const HalfLifePairSchema = z
  .object({
    signal_half_life_hours: z.number().positive().finite(),
    read_half_life_hours: z.number().positive().finite(),
  })
  .strict();

// Built from BEATS rather than hand-listed, so a future beat added to
// src/domain/item.ts's BEATS tuple makes this schema start requiring a
// config entry for it automatically (failing config load loudly) instead of
// silently leaving the new beat with no configured half-life.
const NON_MARKETS_BEATS = BEATS.filter((beat): beat is Exclude<Beat, 'markets'> => beat !== 'markets');
const BeatsSchema = z
  .object(
    Object.fromEntries(NON_MARKETS_BEATS.map((beat) => [beat, HalfLifePairSchema])) as Record<
      Exclude<Beat, 'markets'>,
      typeof HalfLifePairSchema
    >,
  )
  .strict();

// item.ts's ItemType is a type-only union with no runtime tuple to derive
// from (unlike BEATS) -- `satisfies` still catches drift: if ItemType ever
// gains/loses a member, this literal fails to typecheck against it.
const ITEM_TYPES = ['event', 'analysis', 'press'] as const satisfies readonly ItemType[];
const MarketsItemTypesSchema = z
  .object(
    Object.fromEntries(ITEM_TYPES.map((itemType) => [itemType, HalfLifePairSchema])) as Record<
      ItemType,
      typeof HalfLifePairSchema
    >,
  )
  .strict();

const DecayConfigSchema = z
  .object({
    beats: BeatsSchema,
    markets_item_types: MarketsItemTypesSchema,
  })
  .strict();

export type DecayConfig = z.infer<typeof DecayConfigSchema>;

/** Parses and validates decay-config YAML text. No filesystem access. */
export function parseDecayConfig(yamlText: string): DecayConfig {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (cause) {
    throw new DecayConfigError(`could not parse YAML: ${(cause as Error).message}`);
  }

  const result = DecayConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new DecayConfigError(`invalid decay config:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Reads and validates the decay config at `path`. The only I/O in this module. */
export function loadDecayConfig(path: string): DecayConfig {
  return parseDecayConfig(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// The pure decay math.
// ---------------------------------------------------------------------------

export type ScoreProfile = 'signal' | 'read';

export interface DecayTimestamps {
  publishedAt: string | null;
  fetchedAt: string;
}

export interface DecayInput extends DecayTimestamps {
  beat: Beat;
  itemType: ItemType;
}

const HOUR_MS = 3_600_000;

/**
 * The null published_at decision (see the module doc comment, point 1),
 * isolated as its own small, independently-testable unit: fall back to
 * fetchedAt, which is always defined.
 */
export function effectivePublishedAt(timestamps: DecayTimestamps): string {
  return timestamps.publishedAt ?? timestamps.fetchedAt;
}

/**
 * The pure numeric core: standard exponential half-life decay,
 * `factor = 0.5 ^ (ageHours / halfLifeHours)`.
 *
 * `now` and `halfLifeHours` are both plain parameters -- this function
 * reads no clock and no config; a caller (typically computeDecayFactor)
 * resolves the half-life first. See the module doc comment for the null-
 * published_at fallback, the future-dated clamp, and the no-floor decision
 * this implements.
 */
export function decayFactor(timestamps: DecayTimestamps, now: string, halfLifeHours: number): number {
  assertCanonicalTimestamp('now', now);
  assertCanonicalTimestamp('fetchedAt', timestamps.fetchedAt);
  if (timestamps.publishedAt !== null) {
    assertCanonicalTimestamp('publishedAt', timestamps.publishedAt);
  }
  if (!(halfLifeHours > 0) || !Number.isFinite(halfLifeHours)) {
    throw new RangeError(`halfLifeHours must be a positive finite number, got ${halfLifeHours}`);
  }

  const effective = effectivePublishedAt(timestamps);

  // Future-dated clamp (module doc comment, point 2): age floors at zero,
  // which caps the returned factor at exactly 1.0.
  const ageHours = Math.max(0, (Date.parse(now) - Date.parse(effective)) / HOUR_MS);

  // No floor (module doc comment, point 3): left to decay toward, and if
  // old enough reach, exactly 0.
  return Math.pow(0.5, ageHours / halfLifeHours);
}

/**
 * Half-lives are per item_type for the markets beat and per beat everywhere
 * else (§5.1) -- markets shares one beat across items whose staleness
 * behaves completely differently (an `event` filing vs. an `analysis`
 * piece), so beat alone can't carry the distinction the way it can for the
 * other five beats. See config/decay.yaml's header for why `markets` is
 * deliberately absent from `beats`.
 */
export function resolveHalfLifeHours(
  beat: Beat,
  itemType: ItemType,
  profile: ScoreProfile,
  config: DecayConfig,
): number {
  const pair = beat === 'markets' ? config.markets_item_types[itemType] : config.beats[beat];
  if (!pair) {
    throw beat === 'markets'
      ? new UnknownDecayKeyError('item_type', itemType)
      : new UnknownDecayKeyError('beat', beat);
  }
  return profile === 'signal' ? pair.signal_half_life_hours : pair.read_half_life_hours;
}

/**
 * The composed, per-item-per-profile entry point a read query calls: resolve
 * the configured half-life for this item's (beat, itemType, profile), then
 * apply it. Call once per profile per item (twice total, since signal_score
 * and read_score are never blended into one number) -- both calls together
 * are still cheap (module doc comment above has the full cost accounting).
 */
export function computeDecayFactor(
  input: DecayInput,
  profile: ScoreProfile,
  now: string,
  config: DecayConfig,
): number {
  const halfLifeHours = resolveHalfLifeHours(input.beat, input.itemType, profile, config);
  return decayFactor(input, now, halfLifeHours);
}

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { assertCanonicalTimestamp, type Item } from '../domain/item.ts';

// ---------------------------------------------------------------------------
// Hard overrides (M2 task 6 / spec §5): items in a configured category are
// pinned to the top REGARDLESS of the mechanical scorer's computed score --
// they bypass Task 5's scorer entirely rather than merely outscoring it.
//
// THE DESIGN PROBLEM, WITH REAL EVIDENCE: an unbounded "pin every item from
// this source" is dangerous, not hypothetical. cisa-kev dumps its ENTIRE
// historical catalog on a cold start -- verified directly against
// attic/wf-m1-firstrun-2026-08-14.db (read-only, gitignored, never opened
// by this module or its tests -- values below are hand-copied, the same
// convention every M2 Wave-1 module/test uses):
//
//   $ sqlite3 -readonly attic/wf-m1-firstrun-2026-08-14.db \
//     "select count(*) from items where source_id='cisa-kev';"
//   1665
//
//   $ sqlite3 -readonly attic/wf-m1-firstrun-2026-08-14.db \
//     "select min(json_extract(raw_json,'$.dateAdded')), \
//             max(json_extract(raw_json,'$.dateAdded')) \
//      from items where source_id='cisa-kev';"
//   2021-11-03|2026-08-11
//
// 1,665 items is HALF of M1's entire 3,325-item first-run corpus, spanning
// dateAdded from 2021-11-03 (CISA's catalog-launch backfill -- 287 of the
// 1,665 share this exact date, the single largest spike in the corpus) to
// 2026-08-11. An unbounded "every cisa-kev item is a hard override" would
// mean the first cold start -- and every future DB wipe -- pins all 1,665
// above literally everything else: the dashboard IS the KEV catalog, not a
// situational-awareness view of it.
//
// DECISION: bound the override by RECENCY, evaluated at READ TIME against
// the item's own `publishedAt`, using the reader's `now`. Concretely, cross-
// referencing the same corpus's real dateAdded spread (cumulative, i.e. "at
// most N days before 2026-08-14", the corpus's own ingest date):
//
//   <=7 days:    4 / 1,665 (0.24%)
//   <=30 days:  23 / 1,665 (1.38%)   <- the bound this module ships
//   <=90 days:  73 / 1,665 (4.38%)
//   <=365 days: 266 / 1,665 (15.98%)
//
// A 30-day bound turns a 1,665-item cold-start flood into 23 -- a 98.6%
// reduction -- while still surfacing genuinely fresh catalog additions as
// the "act now" signal a hard override exists for. See config/overrides.yaml
// for why 30 (not 7 or 90) was the number chosen, and the two-way trade
// stated plainly rather than hidden: a CVE added to KEV more than 30 days
// ago no longer force-pins, ever again, under append-only storage -- even if
// it is still unpatched somewhere and still genuinely critical. That is
// accepted, not overlooked: the item does not disappear, it falls back to
// being scored (Task 5, not yet built) like everything else, where
// cisa-kev's weight-2.0 source-trust tier (config/sources.yaml) still
// carries real weight -- it just no longer bypasses the score.
//
// WHY THE BOUND USES `publishedAt` (a fact ABOUT THE ITEM: when CISA added
// it to the catalog) AND NOT `firstFetchedAt`/`fetchedAt` (a fact about OUR
// OWN POLLING HISTORY: when we happened to notice it) -- this is the one
// design choice in this module that is load-bearing, not stylistic. On a
// cold start, EVERY item's firstFetchedAt is ~now, including the 2021-11-03
// backfill -- a firstFetchedAt-bound override would therefore pin all 1,665
// items on day one regardless of how CISA-old they are, then taper off only
// as firstFetchedAt itself ages past the window. That is not a fix, it is
// the exact failure mode restated with a delay. Binding to `publishedAt`
// instead makes the override answer "is this genuinely newsworthy right
// now" (a fact about the vulnerability) rather than "did we recently learn
// about it" (a fact about our polling history, and actively wrong on a cold
// start) -- consistent with decay-at-read-time's own reasoning (src/score/
// decay.ts's module doc comment, read but not modified by this file): a
// hard override evaluated at read time may use the reader's `now`; this
// module never reads a clock itself, `now` is always a caller-supplied
// parameter, exactly like decay.ts.
//
// THIS GENERALIZES BEYOND cisa-kev, which is why every recency-boundable
// rule below is bound the same way, not just the one with the scary number:
// `items` is append-only and every source polls forever, so an UNBOUNDED
// override's matching set can only grow across the system's lifetime --
// every poll adds new qualifying items on top of every one that already
// matched, forever. Cold start is simply the fastest, most visible way to
// observe that; a slow accumulation over months is the same defect on a
// longer clock. Recency-bounding is the fix for both.
//
// NULL publishedAt FAILS CLOSED, DELIBERATELY DIFFERENT FROM decay.ts: this
// module does NOT fall back to firstFetchedAt (or any other timestamp) when
// publishedAt is null -- an item with no verifiable date never qualifies for
// a recency-bounded override, full stop. This is a deliberate divergence
// from decay.ts's effectivePublishedAt (which falls back to firstFetchedAt
// so every item still gets a graded, continuous rank), because the two
// modules solve different problems: decay.ts must place every item
// SOMEWHERE on a continuous ranking, so "no date" needs a defined fallback;
// this module makes a BINARY, maximum-consequence decision ("bypass the
// score entirely, unconditionally"), where the safe default under
// uncertainty is "do not bypass", not "assume freshness". This is not
// hypothetical either: 100% of the real cold-start cisa-kev dump (1,665 of
// 1,665) had published_at NULL before the bare-calendar-date parse fix
// landed -- had this module fallen back to firstFetchedAt the way decay.ts
// does, the recency bound above would have done NOTHING to prevent the
// exact flood it exists to prevent, because every one of those 1,665 rows'
// firstFetchedAt was "just now" on that cold start.
//
// TWO SCORES, NEVER BLENDED, AND OVERRIDES ARE SIGNAL-ONLY: every rule
// below carries `applies_to: [signal]`, never `read`. A CISA KEV entry (or
// a critical CVE, or a Juniper SIRT advisory, or an 8-K) is exactly what
// §5.1 means by "filings and rule changes rank high [on signal]; essays
// rank near zero" -- a terse, formulaic record with an action item and a
// due date, not an explanatory, worth-reading piece. Forcing it to the top
// of read_score too would conflate "you must act on this" with "this is
// worth reading", which the two-score model exists specifically to keep
// apart. read_score keeps computing normally (Task 5) for every item,
// overridden or not -- an override never suppresses or inflates it, it
// simply does not apply there. `applies_to` is still a config field, not a
// hardcoded constant, in case a future category genuinely warrants read-side
// pinning; nothing shipped today does.
//
// PRIORITY -- how multiple overrides on one item, or on different items,
// rank against each other: every rule carries an integer `priority` (lower
// = pinned first). An item matching several rules returns every match, and
// a single derived best `priority` (the minimum), so a query layer sorting
// many pinned items has one scalar to sort by while retaining full
// per-category detail for a UI. Ties within a category are the caller's to
// break (e.g. by the item's own publishedAt) -- this module answers "is
// this item pinned, and how urgently" per item; it does not itself sort a
// page of many items, exactly so Task 5 / the query layer can compose it
// freely (see the exported evaluateOverrides doc comment).
//
// GENERICITY -- "a new category is config, not code": three matcher KINDS
// (source_match, source_json_threshold, portfolio_stub) cover every
// category the spec names. A Juniper SIRT feed appearing tomorrow, if it is
// a plain RSS/JSON source like everything else in config/sources.yaml,
// becomes reachable by flipping `enabled: true` and filling in `source_id`
// on the EXISTING juniper-sirt-advisory rule -- zero code change. The three
// kinds are the reusable primitives; a genuinely novel matching shape (e.g.
// "earnings within 5 TRADING sessions", which needs session-calendar math)
// would need a fourth kind -- exactly as adding a source of a truly new
// PROTOCOL (config/sources.yaml's `type`) needs a new adapter, not a config
// edit. `source_match` and `no reachable source` are the SAME kind: a rule
// referencing a source_id that never appears in real data (Juniper, NWS)
// simply never matches, with zero special-casing -- what makes those two
// categories LEGIBLE as "configured but no source" is `enabled: false` plus
// a mandatory `note` (enforced below), not a distinct code path.
//
// THE TWO NAMED-UNREACHABLE CATEGORIES (Juniper SIRT, NWS/NHC) are
// represented as `source_match` rules with `enabled: false` and a `note`
// explaining why (no feed exists; api.weather.gov's robots.txt disallows
// the whole host) -- see config/overrides.yaml. `enabled: false` gates the
// rule OFF BEFORE its matcher ever runs, deliberately, rather than relying
// on "the source_id never appears in real data" as the only protection --
// even a stray/malformed item that somehow carried one of those source ids
// must still not pin, and a rule that is never evaluated at all guarantees
// that independent of what data exists.
//
// A THIRD, UNNAMED-BY-THE-SPEC GAP, FOUND BY TRACING CURRENT CODE RATHER
// THAN ASSUMED: cve-critical-cvss (via nvd-cve) is "reachable" in the sense
// that its matcher is fully implemented and correct, and nvd-cve's own
// ingest window (src/adapters/json.ts's NVD_WINDOW_DAYS, read but not
// modified here) structurally cannot dump a KEV-style full-history flood.
// But NVD's `cve.published` field carries no UTC offset
// ("1988-10-01T04:00:00.000", confirmed against the real
// tests/fixtures/adapters/nvd-cve.json), and src/normalize/item.ts's
// ISO8601_RE (read, not modified, by this module) deliberately refuses to
// interpret an offset-less date-time rather than guess the host's local
// zone. So every real nvd-cve item's `published_at` is -- permanently, by
// design, not as a pagination bug the in-flight sibling fix will resolve --
// NULL. Combined with this module's fail-closed-on-null decision (the same
// decision that closes the cisa-kev cold-start hole), cve-critical-cvss
// cannot currently produce a live pin on real data, even once nvd-cve is
// enabled and ingesting. This is recorded here, in the config, and in the
// task report as a THIRD gap -- distinct in cause from Juniper/NWS (no
// route exists at all) but identical in observable effect today (configured,
// correct, inert) -- rather than silently assumed working because its
// matcher happens to be fully built.
//
// PORTFOLIO-LINKED CATEGORIES (8-K from a held name, earnings within 5
// sessions) -- M4b, not this milestone, and the markets beat ingests
// nothing at all in M1/M2 (no SEC-filing source, no earnings-calendar
// source exists in config/sources.yaml), so there is structurally nothing
// in `items` these could ever match against yet, independent of anything
// this module does. Represented as a THIRD kind, `portfolio_stub`: an
// explicit, named, always-no-op matcher (mirroring Task 5's identical
// requirement for portfolio proximity: "named, tested as a no-op, not
// silently absent") that DOES read a configured, gitignored portfolio file
// at runtime (tryReadPortfolioFile, below) -- proving the "expressible as
// config that reads from the gitignored file at runtime" plumbing genuinely
// works end to end -- but never lets the result influence matching. Tracked
// config (config/overrides.yaml) carries only `portfolio_path` (a path) and
// `milestone` -- never a ticker, holding, or weight. See that file's header
// and the task report for the full portfolio-safety accounting.
// ---------------------------------------------------------------------------

export class OverrideConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverrideConfigError';
  }
}

// ---------------------------------------------------------------------------
// Config schema. Field names mirror the YAML 1:1 (snake_case), matching
// src/score/decay.ts / src/interests/load.ts's convention for config-derived
// types -- unlike domain-derived types (Item, camelCase), a config type's
// job is to stay legible against the file an owner is editing by hand.
// ---------------------------------------------------------------------------

const PROFILES = ['signal', 'read'] as const;
export type OverrideProfile = (typeof PROFILES)[number];

// Mirrors src/config/env.ts's `relativePath` refinement exactly (module not
// imported: that const isn't exported, and duplicating a five-line check is
// cheaper than widening this task's file scope to export one). Same
// rationale: CLAUDE.md's zero-absolute-paths rule governs the committed
// source tree, including config values checked into it.
const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p), {
    message: 'must be a relative path — absolute paths do not survive migration',
  });

const BaseRuleFields = {
  id: z.string().min(1),
  label: z.string().min(1),
  // Lower number = pinned first when several rules match the same item.
  // Positive integer, not 0/negative -- see config/overrides.yaml header for
  // the shipped ordering and why. `.int()` matches priority's role as a
  // discrete rank, not a weight to be interpolated.
  priority: z.number().int().positive(),
  // Which score profile(s) this rule bypasses. Every shipped rule is
  // [signal] only -- see this file's module doc comment -- but the field
  // stays config-driven rather than hardcoded, matching the "config not
  // code" mandate.
  applies_to: z.array(z.enum(PROFILES)).min(1),
  enabled: z.boolean(),
  note: z.string().min(1).optional(),
};

const SourceMatchRuleSchema = z
  .object({
    ...BaseRuleFields,
    kind: z.literal('source_match'),
    source_id: z.string().min(1),
    // In days -- see module doc comment for why a bound is mandatory (not
    // optional) on every recency-boundable kind: an override with no bound
    // at all, over append-only storage that polls forever, can only
    // accumulate its matching set across the system's lifetime. Required by
    // the schema so a future rule cannot be added without one, silently
    // reopening the cold-start hole this file exists to close.
    recency_bound_days: z.number().positive(),
  })
  .strict();

const SourceJsonThresholdRuleSchema = z
  .object({
    ...BaseRuleFields,
    kind: z.literal('source_json_threshold'),
    source_id: z.string().min(1),
    // Tried in order; the first path that resolves to a finite number wins.
    // Lets one rule express "prefer the CVSS v3.1 score, fall back to v3.0"
    // (real NVD shape: an older, not-yet-rescored CVE carries v3.0 or only
    // v2) without a second rule or a code change.
    json_paths: z.array(z.string().min(1)).min(1),
    comparator: z.enum(['gte', 'gt']),
    threshold: z.number(),
    recency_bound_days: z.number().positive(),
  })
  .strict();

const PortfolioStubRuleSchema = z
  .object({
    ...BaseRuleFields,
    kind: z.literal('portfolio_stub'),
    milestone: z.string().min(1),
    portfolio_path: relativePath,
  })
  .strict();

const OverrideRuleSchema = z.discriminatedUnion('kind', [
  SourceMatchRuleSchema,
  SourceJsonThresholdRuleSchema,
  PortfolioStubRuleSchema,
]);

export type OverrideRule = z.infer<typeof OverrideRuleSchema>;

const OverridesFileSchema = z
  .object({
    overrides: z.array(OverrideRuleSchema).min(1, 'overrides must have at least one entry'),
  })
  .strict();

export interface OverridesConfig {
  overrides: OverrideRule[];
}

function assertNoDuplicateIds(rules: OverrideRule[]): void {
  const seen = new Set<string>();
  for (const { id } of rules) {
    if (seen.has(id)) {
      throw new OverrideConfigError(`duplicate override id: ${id}`);
    }
    seen.add(id);
  }
}

/**
 * A disabled rule (Juniper, NWS, both M4b portfolio stubs) must document WHY
 * it's disabled -- that's the difference between a "legible, tested
 * configured-but-no-source state" (the task's own words) and a rule that's
 * merely present but unexplained. Enforced here, after the Zod parse, the
 * same way src/interests/load.ts enforces "no term in both boosts and
 * suppressions" after ITS Zod parse -- an invariant that spans more than one
 * field/rule isn't naturally a single-field Zod check.
 */
function assertDisabledRulesHaveNotes(rules: OverrideRule[]): void {
  for (const { id, enabled, note } of rules) {
    if (!enabled && !note) {
      throw new OverrideConfigError(`override '${id}' is disabled but has no note explaining why`);
    }
  }
}

/** Parses and validates overrides-config YAML text. No filesystem access. */
export function parseOverridesConfig(yamlText: string): OverridesConfig {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (cause) {
    throw new OverrideConfigError(`could not parse YAML: ${(cause as Error).message}`);
  }

  const result = OverridesFileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new OverrideConfigError(`invalid overrides config:\n${lines.join('\n')}`);
  }

  assertNoDuplicateIds(result.data.overrides);
  assertDisabledRulesHaveNotes(result.data.overrides);

  return result.data;
}

/** Reads and validates the overrides config at `path`. The only I/O besides `tryReadPortfolioFile`. */
export function loadOverridesConfig(path: string): OverridesConfig {
  return parseOverridesConfig(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// The pure recency predicate -- isolated exactly like src/score/decay.ts
// isolates effectivePublishedAt, so the fail-closed-on-null decision (the
// module doc comment's central claim) has its own small, directly-tested
// unit rather than being buried inside evaluateOverrides.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * True if `publishedAt` is at or before `now` and no more than
 * `maxAgeDays` earlier -- OR if `publishedAt` is AFTER `now` (a future-dated
 * item, e.g. clock skew or a sitemap bug -- treated as "as fresh as
 * possible", never rejected for being "too fresh"; mirrors src/score/
 * decay.ts's future-dated clamp, which this module read but did not modify).
 *
 * `publishedAt === null` is ALWAYS false, regardless of `maxAgeDays` -- see
 * the module doc comment for why this deliberately does not fall back to
 * any other timestamp the way decay.ts's effectivePublishedAt does.
 */
export function withinRecencyBound(publishedAt: string | null, now: string, maxAgeDays: number): boolean {
  assertCanonicalTimestamp('now', now);
  if (publishedAt === null) return false;
  assertCanonicalTimestamp('publishedAt', publishedAt);

  const ageMs = Date.parse(now) - Date.parse(publishedAt);
  return ageMs <= maxAgeDays * DAY_MS;
}

// ---------------------------------------------------------------------------
// The raw_json numeric-path reader, for source_json_threshold rules. No
// entity extractor exists yet (src/domain/itemEntities.ts's own doc comment:
// `select count(*) from item_entities` against the real M1 corpus returns
// 0), and Item carries no structured CVSS field, so raw_json is the only
// place a value like NVD's CVSS baseScore can be read from today. The path
// syntax (dot-separated; a segment that is all digits indexes an array) is
// generic on purpose -- reusable for any future numeric-threshold-on-raw-
// JSON category, not hardcoded to NVD's shape in code. NVD's own shape is
// DATA (config/overrides.yaml's json_paths), not logic here.
// ---------------------------------------------------------------------------

function getByPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Parses `rawJson` and returns the first `jsonPaths` entry that resolves to
 * a finite number, trying them in order (config-declared preference, e.g.
 * "CVSS v3.1, falling back to v3.0" -- see SourceJsonThresholdRuleSchema's
 * doc comment). `null` for a malformed JSON body, a path that resolves to
 * nothing, or a non-numeric value at every path -- never a throw: a
 * malformed or unexpectedly-shaped individual item is a reason for that
 * item not to match, the same "skip, don't fail the batch" rule
 * src/adapters/json.ts documents for a malformed entry (read, not modified,
 * by this module).
 */
export function extractJsonThreshold(rawJson: string, jsonPaths: readonly string[]): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }

  for (const path of jsonPaths) {
    const value = getByPath(parsed, path);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function passesThreshold(value: number, comparator: 'gte' | 'gt', threshold: number): boolean {
  return comparator === 'gte' ? value >= threshold : value > threshold;
}

// ---------------------------------------------------------------------------
// Portfolio-file plumbing for `portfolio_stub` rules. Deliberately generic
// and shallow: this does NOT define portfolio.yaml's own internal schema
// (holdings/tickers/weights) -- that is M4b's design decision, not this
// task's, and config/portfolio.yaml has no consumer anywhere in the
// codebase yet (confirmed: .gitignore's own comment on that file, "nothing
// in the codebase reads either file at build or test time, so a clone is
// unaffected"). This function proves the READ happens, at runtime, from a
// path named in tracked config -- the literal requirement -- and tolerates
// the file being absent (a fresh clone will never have it) without
// tolerating a present-but-corrupt file, which fails loudly like every
// other config loader in this codebase.
// ---------------------------------------------------------------------------

/**
 * Reads and YAML-parses `portfolioPath`. Returns `null` if the file does
 * not exist (never an error -- a fresh clone or a machine that hasn't
 * configured a portfolio yet is a normal, healthy state, not a
 * misconfiguration). Re-throws any other filesystem error, and throws on
 * malformed YAML in a file that DOES exist -- a present-but-corrupt config
 * file is a real problem and should fail loudly, exactly like every other
 * config loader in this codebase (parseDecayConfig, loadInterests, this
 * file's own parseOverridesConfig).
 */
export function tryReadPortfolioFile(portfolioPath: string): unknown | null {
  let text: string;
  try {
    text = readFileSync(portfolioPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
  return parse(text);
}

// ---------------------------------------------------------------------------
// The composed entry point.
// ---------------------------------------------------------------------------

/**
 * The minimal item shape this module needs -- a structural subset of
 * `Item` (src/domain/item.ts), not a copy of its field names, so the two
 * can never silently drift apart. Deliberately excludes `beats`/`entities`/
 * every other Item field: no shipped rule kind needs them, and a caller
 * (the eventual query layer, or Task 5's mechanical scorer) can pass a real,
 * DB-hydrated `Item` directly wherever this type is expected.
 */
export type OverrideItemInput = Pick<Item, 'sourceId' | 'publishedAt' | 'rawJson'>;

export interface OverrideMatch {
  id: string;
  label: string;
  priority: number;
}

export interface OverrideResult {
  /** True if at least one enabled rule matched this item for this profile. */
  pinned: boolean;
  /** The best (lowest) priority among `matches`, or `null` if `matches` is empty. */
  priority: number | null;
  /** Every matching rule, sorted by priority ascending (ties broken by id). */
  matches: OverrideMatch[];
}

/**
 * Evaluates every rule in `config` against `item` for one score `profile`,
 * at instant `now`. Pure: no I/O, no clock of its own, `now` and `config`
 * are always parameters -- mirrors src/score/decay.ts's `computeDecayFactor`
 * exactly, and for the same reason (module doc comment above): a hard
 * override evaluated at read time may use the reader's own `now`, which is
 * only true if this function never reads a clock itself. (The one exception
 * -- `portfolio_stub` rules DO perform a file read, via `tryReadPortfolioFile`
 * -- is scoped narrowly: see that rule kind's branch below and the module
 * doc comment's portfolio section.)
 *
 * COMPOSITION CONTRACT for Task 5 / the eventual query layer: call this once
 * per item per profile (e.g. once for `signal_score`, once for `read_score`
 * -- exactly the same "twice per item" shape decay.ts's computeDecayFactor
 * already expects a caller to use). If `.pinned`, the mechanical score for
 * that profile should not be computed at all, or if it is, must not be used
 * for ranking -- sort pinned items by `.priority` ascending (and, for a
 * stable order among ties, whatever secondary key the query already uses,
 * e.g. `publishedAt` descending) ahead of every non-pinned item, which sorts
 * by its ordinary computed score. This module has no visibility into "all
 * items on a page", by design, so it never produces that final sort itself
 * -- only the per-item decision a caller composes into one.
 */
export function evaluateOverrides(
  item: OverrideItemInput,
  profile: OverrideProfile,
  now: string,
  config: OverridesConfig,
): OverrideResult {
  assertCanonicalTimestamp('now', now);
  if (item.publishedAt !== null) assertCanonicalTimestamp('publishedAt', item.publishedAt);

  const matches: OverrideMatch[] = [];

  for (const rule of config.overrides) {
    if (!rule.enabled) continue;
    if (!rule.applies_to.includes(profile)) continue;

    if (rule.kind === 'portfolio_stub') {
      // M4b no-op stub (module doc comment, "portfolio-linked categories"):
      // the read happens -- proving the runtime-file-read plumbing the task
      // requires -- but its result never influences matching. There is no
      // filing or earnings-calendar ingestion anywhere in M1/M2 for this to
      // match against yet.
      tryReadPortfolioFile(rule.portfolio_path);
      continue;
    }

    if (rule.source_id !== item.sourceId) continue;
    if (!withinRecencyBound(item.publishedAt, now, rule.recency_bound_days)) continue;

    if (rule.kind === 'source_match') {
      matches.push({ id: rule.id, label: rule.label, priority: rule.priority });
      continue;
    }

    // source_json_threshold
    const value = extractJsonThreshold(item.rawJson, rule.json_paths);
    if (value !== null && passesThreshold(value, rule.comparator, rule.threshold)) {
      matches.push({ id: rule.id, label: rule.label, priority: rule.priority });
    }
  }

  matches.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  return {
    pinned: matches.length > 0,
    priority: matches.length > 0 ? matches[0]!.priority : null,
    matches,
  };
}

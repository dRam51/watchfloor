/**
 * The daily vault note (M5 task 5).
 *
 * §8.1: *"Daily note (`daily/YYYY-MM-DD.md`) — frontmatter with date, per-beat
 * counts, and the market ribbon snapshot. Sections per beat, top N each as a
 * link plus one-line why. Hard-override items pinned in a 'Flagged' section at
 * the top. **Idempotent overwrite, not append.**"*
 *
 * ## 1. Idempotence is the acceptance criterion, so it is the design constraint
 *
 * M5 acceptance deletes the whole `watchfloor/` tree and requires `daily/` to
 * reproduce **exactly**. That makes "idempotent overwrite" a testable property
 * rather than a habit: the note is a pure function of (corpus state, date,
 * config). Nothing here reads a clock, and the note carries no generation
 * timestamp, no run id and no counter — anything differing between two runs
 * over the same corpus would break acceptance, and would break it *silently*,
 * because a note with a fresh timestamp still looks right.
 *
 * The one place a clock would normally enter is decay, which M2 applies at read
 * time from the reader's `now`. So `now` is not read here either: it is
 * {@link dailyNoteInstant}, derived from the note's own date and `WF_TZ`.
 *
 * Two smaller consequences of the same rule:
 *
 * - **`watchfloor_generated_at` is the note's as-of instant, not a wall clock.**
 *   Task 4 makes the field mandatory on every managed note. Filling it from the
 *   clock would change the bytes on every run, which is exactly what acceptance
 *   forbids, so it carries the instant the note describes. The body says so.
 * - **Ordering never uses `localeCompare`.** `sortRanked` in `src/score/rank.ts`
 *   breaks ties on title with `localeCompare`, whose collation depends on the
 *   host's ICU build. Two hosts would then order two equal-scoring items
 *   differently — a portability bug that only shows up as "the note changed".
 *   Ties here break on `item_key`, a sha256 hex digest compared by codepoint,
 *   exactly as `src/api/routes/feed.ts`'s `compareRankKey` does.
 *
 * ## 2. Pinning is a separate axis, and pinned items are hoisted, not copied
 *
 * A hard override bypasses the score rather than competing with it: on the real
 * corpus **21 of 50 pinned cyber rows round to exactly 0.000**. A Flagged
 * section built by sorting on score would therefore print the most urgent items
 * last. Flagged is ordered by override **priority**, then by publication time,
 * then by `item_key` — score is not consulted at all.
 *
 * Pinned items are then **removed from their beat's top N**. Leaving them in
 * would let a cold start — CISA KEV dumps its entire 1,665-entry catalog on a
 * first poll — fill the cyber section with a second copy of the pin list, and
 * the beat's top N exists to answer a different question: what scored highest.
 * The count line under each heading still reports how many of that beat's
 * ranked items were hoisted, so nothing disappears without saying so.
 *
 * ## 3. The market ribbon does not exist, and the note says that rather than 0
 *
 * M4b is deferred: `config/portfolio.yaml` is unwritten and no source is
 * configured for the markets beat. §8.1 asks for a ribbon snapshot in
 * frontmatter anyway. An absent data source and a flat market are different
 * facts, so `market_ribbon` is the token `not_configured` with a detail line —
 * never a number, never an empty object, never a zero. That is the same
 * discipline `/api/sources` follows with `everPolled`/`null`, and the M5 plan
 * requires it of every M4b-dependent surface: *"never an empty array, which a
 * bot would read as 'no catalysts' rather than 'no data source.'"*
 *
 * The same distinction is drawn per beat: a beat with no configured source says
 * so, instead of rendering the "no items today" line a quiet beat gets.
 *
 * ## 4. Point in time: the candidate set is bounded by `fetched_at <= asOf`
 *
 * A note for a past date must not contain items that did not exist that day.
 * The candidate query below bounds on `fetched_at`, and the item version is
 * read with `getItemAsOf` — the same pinned-`now` shape `/feed` uses for its
 * cursor. Two inherited asymmetries, stated rather than discovered:
 *
 * - `getItemBeats` is deliberately timeless (its own doc comment), so a beat
 *   attributed to an item later still counts for an older note.
 * - `getLatestItemScore` has no as-of variant; the newest scoring pass wins.
 *   A rescore therefore moves an old note's numbers. Adding `computed_at <=
 *   asOf` belongs in `src/score/mechanical.ts`, which this task does not own.
 *
 * ## 5. Where the "one-line why" comes from, and why it is not the LLM
 *
 * Wave 1 shipped a working local LLM seam. Using it here would break §1: a
 * blurb is a function of the model, the daemon being up, the daily token
 * ceiling and the cache's contents, none of which are "corpus state, date,
 * config". A cache miss on the second run — or a refusal at the ceiling — would
 * silently produce a different note over an identical corpus, and the failure
 * would look exactly like success.
 *
 * So the why is **the ranking evidence**, assembled from facts already stored:
 * the source and its configured trust weight, the corroboration count that fed
 * `signal_score`, which interest terms matched, how old the item is, and the
 * decayed score itself. That is not a truncated title — it is the answer to the
 * question the section actually poses ("why is this in today's top five"),
 * which a summary of the article would not answer at all. Task 6's weekly note
 * is where §8.1 asks for real blurbs, and it is the right place for the model.
 */

import { getClusterSizeAsOf } from '../cluster/store.ts';
import type { Db } from '../db/connection.ts';
import { assertCalendarDay, localDay } from '../db/repoSnapshots.ts';
import { BEATS, getItemAsOf, type Beat, type Item } from '../domain/item.ts';
import { getItemBeats } from '../domain/itemBeats.ts';
import { getItemEntities } from '../domain/itemEntities.ts';
import { getItemFirstFetchedAt } from '../domain/itemFirstFetchedAt.ts';
import { matchProfile, type InterestProfile, type ProfileMatches } from '../interests/load.ts';
import { computeDecayFactor, type DecayConfig } from '../score/decay.ts';
import { buildScoringText, getLatestItemScore } from '../score/mechanical.ts';
import { evaluateOverrides, type OverrideResult, type OverridesConfig } from '../score/overrides.ts';
import type { Source } from '../sources/load.ts';
import { renderManagedNote, type ManagedContent } from './frontmatter.ts';
import type { VaultSession, VaultWriteResult } from './session.ts';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** §8.1's "top N each". Five fits a phone screen and a glance. */
export const DEFAULT_TOP_PER_BEAT = 5;

/**
 * A visible bound on the Flagged section.
 *
 * The overrides shipped today are recency-bounded (30 days for KEV), which
 * turns the 1,665-entry cold-start catalog dump into roughly 23 pins. This cap
 * is the second line of defence, and it **reports** rather than truncates
 * silently: `session.writeManagedNote` refuses a note past its 256 KiB
 * per-file cap outright, so an unbounded Flagged section on a badly-configured
 * override would cost the whole note, not just its tail.
 */
export const DEFAULT_FLAGGED_LIMIT = 50;

export interface DailyNoteDeps {
  /** `WF_TZ`. Never the host's zone. */
  readonly tz: string;
  readonly decayConfig: DecayConfig;
  readonly overridesConfig: OverridesConfig;
  /** The loaded `config/sources.yaml`. Read for trust weight and beat coverage. */
  readonly sources: readonly Source[];
  readonly interests: InterestProfile;
  readonly topPerBeat?: number;
  readonly flaggedLimit?: number;
}

/** One ranked item, with everything the "why" line is assembled from. */
export interface DailyEntry {
  readonly itemKey: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly sourceId: string;
  /** The beat this entry was ranked under. */
  readonly beat: Beat;
  /** Every beat the item carries — `getItemBeats`' union, so a cross-listing shows both. */
  readonly beats: readonly Beat[];
  readonly publishedAt: string | null;
  readonly firstFetchedAt: string;
  readonly clusterSize: number;
  /** Decayed at {@link DailyNote.asOf}. Never stored. */
  readonly signalScore: number;
  readonly override: OverrideResult;
  readonly interest: ProfileMatches;
}

/**
 * Why a beat has nothing to show — three different facts that must not collapse
 * into one sentence.
 */
export type BeatCoverage = 'no_source' | 'all_sources_disabled' | 'covered';

export interface DailyBeatSection {
  readonly beat: Beat;
  readonly coverage: BeatCoverage;
  /** Items ranked for this beat as of the note's instant, pinned ones included. */
  readonly ranked: number;
  /** Of those, how many were hoisted into Flagged. */
  readonly flagged: number;
  /** The top N that remain after hoisting. */
  readonly shown: readonly DailyEntry[];
}

export interface DailyNote {
  readonly relPath: string;
  readonly date: string;
  /** The instant the whole note is computed against. */
  readonly asOf: string;
  readonly content: ManagedContent;
  readonly flagged: readonly DailyEntry[];
  /** How many items were pinned before {@link DailyNoteDeps.flaggedLimit} applied. */
  readonly flaggedTotal: number;
  readonly sections: readonly DailyBeatSection[];
}

/**
 * The instant a daily note is computed against: the **last millisecond of
 * `date` in `tz`**.
 *
 * Derived, never read from a clock — that is what makes the note reproducible.
 * Regenerating 2026-08-15's note at 09:00 and again at 22:00 asks decay and the
 * hard overrides the same question both times, so the same corpus yields the
 * same bytes. A wall-clock `now` would move every decayed score between the two
 * runs and quietly reorder the note.
 *
 * Found by bisection against {@link localDay} rather than by arithmetic on a
 * UTC offset, so the day boundary here is the *same* boundary the token
 * ceiling, the star snapshots and the header strip already use. A zone whose
 * offset is not a whole number of hours, or one that shifts across this very
 * boundary, needs no special case: the predicate is monotone either way.
 */
export function dailyNoteInstant(date: string, tz: string): string {
  assertCalendarDay('date', date);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];

  // Bracketing: no zone is more than 14 hours from UTC, so 18 hours on each
  // side is comfortably outside every offset and every DST shift.
  let lo = Date.UTC(year, month - 1, day) - 18 * HOUR_MS;
  let hi = Date.UTC(year, month - 1, day + 1) + 18 * HOUR_MS;

  const onOrBefore = (ms: number): boolean => localDay(new Date(ms).toISOString(), tz) <= date;

  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (onOrBefore(mid)) lo = mid;
    else hi = mid;
  }
  return new Date(lo).toISOString();
}

// ---------------------------------------------------------------------------
// Candidate resolution
// ---------------------------------------------------------------------------

/**
 * Every distinct `item_key` carrying `beat` with at least one version fetched
 * at or before `asOf` — the point-in-time half of §4 above.
 *
 * A near-copy of `src/api/routes/feed.ts`'s `candidateItemKeysForBeat`, kept
 * local rather than shared because `src/score/rank.ts`'s `getItemKeysForBeat`
 * is deliberately unbounded and this note must not contain post-dated items.
 */
function candidateItemKeys(db: Db, beat: Beat, asOf: string): string[] {
  const rows = db
    .prepare(
      `select distinct i.item_key as item_key
       from item_beats ib
       join items i on i.item_id = ib.item_id
       where ib.beat = ? and i.fetched_at <= ?
       order by i.item_key`,
    )
    // Cast target is an inline type literal, not a named interface -- see
    // src/cluster/store.ts:88-100's comment on this node:sqlite TS2352 quirk.
    .all(beat, asOf) as Array<{ item_key: string }>;
  return rows.map((r) => r.item_key);
}

function buildEntry(
  db: Db,
  itemKey: string,
  beat: Beat,
  item: Item,
  asOf: string,
  deps: DailyNoteDeps,
): DailyEntry | null {
  const score = getLatestItemScore(db, itemKey, beat);
  if (score === null) return null; // never scored for this beat -- excluded, not an error

  const firstFetchedAt = getItemFirstFetchedAt(db, itemKey) ?? item.fetchedAt;
  const entities = getItemEntities(db, itemKey);

  const decayFactor = computeDecayFactor(
    { publishedAt: item.publishedAt, firstFetchedAt, beat, itemType: item.itemType },
    'signal',
    asOf,
    deps.decayConfig,
  );

  return {
    itemKey,
    title: item.title,
    canonicalUrl: item.canonicalUrl,
    sourceId: item.sourceId,
    beat,
    beats: getItemBeats(db, itemKey),
    publishedAt: item.publishedAt,
    firstFetchedAt,
    // As of the SCORE's own computed_at, never `asOf` -- src/score/rank.ts's
    // documented reasoning: the displayed count and the displayed score must
    // describe one instant.
    clusterSize: getClusterSizeAsOf(db, itemKey, score.computedAt),
    signalScore: score.signalScore * decayFactor,
    override: evaluateOverrides(
      { sourceId: item.sourceId, publishedAt: item.publishedAt, rawJson: item.rawJson },
      'signal',
      asOf,
      deps.overridesConfig,
    ),
    interest: matchProfile(buildScoringText(item.title, item.summaryRaw, entities), deps.interests),
  };
}

/**
 * `item_key` descending, by codepoint. The total tiebreak everywhere below.
 *
 * Never `localeCompare`: an `item_key` is a sha256 hex digest, and codepoint
 * order is exact and identical on every host, where ICU collation is not.
 */
function byItemKeyDesc(a: DailyEntry, b: DailyEntry): number {
  if (a.itemKey === b.itemKey) return 0;
  return a.itemKey > b.itemKey ? -1 : 1;
}

/** Decayed signal descending. Pinned items never reach here — they are hoisted. */
function byScoreDesc(a: DailyEntry, b: DailyEntry): number {
  if (a.signalScore !== b.signalScore) return b.signalScore - a.signalScore;
  return byItemKeyDesc(a, b);
}

/**
 * Override priority ascending, then publication time descending, then
 * `item_key`. **Score is not consulted** — see §2 of the module comment.
 * An undated item sorts after every dated one rather than being dropped.
 */
function byPinPriority(a: DailyEntry, b: DailyEntry): number {
  const byPriority = (a.override.priority ?? 0) - (b.override.priority ?? 0);
  if (byPriority !== 0) return byPriority;
  if (a.publishedAt !== b.publishedAt) {
    if (a.publishedAt === null) return 1;
    if (b.publishedAt === null) return -1;
    return a.publishedAt > b.publishedAt ? -1 : 1;
  }
  return byItemKeyDesc(a, b);
}

function coverageOf(beat: Beat, sources: readonly Source[]): BeatCoverage {
  const forBeat = sources.filter((s) => s.beats.includes(beat));
  if (forBeat.length === 0) return 'no_source';
  if (!forBeat.some((s) => s.enabled)) return 'all_sources_disabled';
  return 'covered';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * A trust weight, at the precision it is written in `config/sources.yaml`:
 * `2` renders `2.0`, `1.8` renders `1.8`, and an unexpected `1.25` keeps both
 * digits rather than being rounded into a different claim.
 */
function formatWeight(weight: number): string {
  const fixed = weight.toFixed(2);
  return fixed.endsWith('0') ? fixed.slice(0, -1) : fixed;
}

/** Markdown link text: one line, with the characters that end a link escaped. */
function linkText(title: string): string {
  return title.replace(/\s+/g, ' ').trim().replace(/([\\[\]])/g, '\\$1');
}

/**
 * Markdown link target. Only the five characters that can terminate or nest a
 * link are percent-encoded; everything else is left exactly as stored, so the
 * URL in the note is the URL in the database.
 */
function linkTarget(url: string): string {
  return url.replace(/[\s<>()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** Whole units, largest that reads naturally. Deterministic given `asOf`. */
function formatElapsed(fromMs: number, toMs: number): string {
  const ms = toMs - fromMs;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < 48 * HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

function ageClause(entry: DailyEntry, asOf: string): string {
  const asOfMs = Date.parse(asOf);
  if (entry.publishedAt === null) {
    // 1,715 of the first live corpus's 3,325 items had a null published_at, so
    // this is the common case, not an edge one. Saying "first seen" rather than
    // inventing an age keeps our polling history distinct from the item's own.
    return `undated, first seen ${formatElapsed(Date.parse(entry.firstFetchedAt), asOfMs)} ago`;
  }
  const publishedMs = Date.parse(entry.publishedAt);
  if (publishedMs > asOfMs) return 'dated after this note';
  return `${formatElapsed(publishedMs, asOfMs)} old`;
}

function quoteTerms(terms: readonly string[]): string {
  const shown = terms.slice(0, 2).map((t) => `"${t}"`);
  const rest = terms.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

function interestClauses(matches: ProfileMatches): string[] {
  const clauses: string[] = [];
  if (matches.boosts.length > 0) clauses.push(`matches ${quoteTerms(matches.boosts.map((m) => m.term))}`);
  if (matches.suppressions.length > 0) {
    clauses.push(`suppressed by ${quoteTerms(matches.suppressions.map((m) => m.term))}`);
  }
  return clauses;
}

/**
 * The "one-line why": the ranking evidence, in the order a reader needs it —
 * who said it, how many said it, whether it matches a standing interest, how
 * old it is, and what it scored. See §5 of the module comment.
 */
function whyClauses(entry: DailyEntry, asOf: string, trustById: Map<string, number>): string[] {
  const trust = trustById.get(entry.sourceId);
  return [
    trust === undefined ? `${entry.sourceId} (trust unknown)` : `${entry.sourceId} (trust ${formatWeight(trust)})`,
    entry.clusterSize > 1 ? `${entry.clusterSize} sources` : 'single source',
    ...interestClauses(entry.interest),
    ageClause(entry, asOf),
    `signal ${entry.signalScore.toFixed(3)}`,
  ];
}

function renderEntry(
  entry: DailyEntry,
  asOf: string,
  trustById: Map<string, number>,
  pinContext: boolean,
): string {
  const clauses = whyClauses(entry, asOf, trustById);
  if (pinContext) {
    // The pin comes first because it is the reason the item is in this section
    // at all, and the beat comes next because Flagged is cross-beat.
    const labels = entry.override.matches.map((m) => m.label).join(', ');
    clauses.unshift(`**${labels}** (priority ${entry.override.priority})`, entry.beats.join('/'));
  }
  return `- [${linkText(entry.title)}](${linkTarget(entry.canonicalUrl)}) — ${clauses.join(' · ')}`;
}

const MARKET_RIBBON_DETAIL =
  'no markets source is configured (M4b), so there is no ribbon to snapshot — ' +
  'an absent data source, not a flat market';

const MARKET_RIBBON_DETAIL_NO_SUBSYSTEM =
  'markets sources are configured, but the §7 market ribbon itself is M4b and does not exist yet — ' +
  'an absent data source, not a flat market';

function coverageLine(coverage: BeatCoverage): string {
  return coverage === 'no_source'
    ? 'No source is configured for this beat — an absent data source, not a quiet day.'
    : 'Every source configured for this beat is disabled — an absent data source, not a quiet day.';
}

function renderSection(
  section: DailyBeatSection,
  asOf: string,
  trustById: Map<string, number>,
): string[] {
  const lines = [`## ${section.beat}`, ''];
  if (section.coverage !== 'covered') {
    lines.push(coverageLine(section.coverage), '');
    return lines;
  }
  if (section.ranked === 0) {
    lines.push('No scored item as of this instant.', '');
    return lines;
  }
  if (section.shown.length === 0) {
    lines.push(
      `${section.ranked} ranked · ${section.flagged} flagged · every ranked item is pinned and appears in Flagged above.`,
      '',
    );
    return lines;
  }
  lines.push(
    `${section.ranked} ranked · ${section.flagged} flagged · top ${section.shown.length} by signal.`,
    '',
  );
  for (const entry of section.shown) lines.push(renderEntry(entry, asOf, trustById, false));
  lines.push('');
  return lines;
}

function renderFlagged(
  flagged: readonly DailyEntry[],
  flaggedTotal: number,
  asOf: string,
  trustById: Map<string, number>,
): string[] {
  const lines = ['## Flagged', ''];
  if (flaggedTotal === 0) {
    lines.push('Nothing is pinned by a hard override as of this instant.', '');
    return lines;
  }
  lines.push(
    flagged.length === flaggedTotal
      ? `${flaggedTotal} pinned by a hard override, ordered by override priority — never by score, which a pin bypasses rather than competes with.`
      : `${flaggedTotal} pinned by a hard override; showing the ${flagged.length} highest-priority. Ordered by override priority — never by score, which a pin bypasses rather than competes with.`,
    '',
  );
  for (const entry of flagged) lines.push(renderEntry(entry, asOf, trustById, true));
  lines.push('');
  return lines;
}

// ---------------------------------------------------------------------------
// The composed build
// ---------------------------------------------------------------------------

/**
 * Builds `daily/YYYY-MM-DD.md` from the corpus as of the end of `date` in
 * `deps.tz`.
 *
 * Pure with respect to the clock: the same database, date and config produce
 * byte-identical output, which is the property M5 acceptance tests by deleting
 * the vault tree and regenerating it.
 */
export function buildDailyNote(db: Db, date: string, deps: DailyNoteDeps): DailyNote {
  assertCalendarDay('date', date);
  const asOf = dailyNoteInstant(date, deps.tz);
  const topPerBeat = deps.topPerBeat ?? DEFAULT_TOP_PER_BEAT;
  const flaggedLimit = deps.flaggedLimit ?? DEFAULT_FLAGGED_LIMIT;
  const trustById = new Map(deps.sources.map((s) => [s.id, s.weight]));

  const sections: DailyBeatSection[] = [];
  const pinnedByKey = new Map<string, DailyEntry>();

  for (const beat of BEATS) {
    const coverage = coverageOf(beat, deps.sources);
    const entries: DailyEntry[] = [];

    for (const itemKey of candidateItemKeys(db, beat, asOf)) {
      // The version as of the note's instant, never getCurrentItem: a version
      // fetched after `asOf` must not leak into a past date's note.
      const item = getItemAsOf(db, itemKey, asOf);
      if (item === null) continue; // unreachable: the candidate query already bounds fetched_at
      const entry = buildEntry(db, itemKey, beat, item, asOf, deps);
      if (entry !== null) entries.push(entry);
    }

    const pinned = entries.filter((e) => e.override.pinned);
    for (const entry of pinned) {
      // A cross-listed item is pinned once, under the first beat in BEATS
      // order; `entry.beats` still names every beat it carries.
      if (!pinnedByKey.has(entry.itemKey)) pinnedByKey.set(entry.itemKey, entry);
    }

    sections.push({
      beat,
      coverage,
      ranked: entries.length,
      flagged: pinned.length,
      shown: entries
        .filter((e) => !e.override.pinned)
        .sort(byScoreDesc)
        .slice(0, topPerBeat),
    });
  }

  const allPinned = [...pinnedByKey.values()].sort(byPinPriority);
  const flagged = allPinned.slice(0, flaggedLimit);

  const marketsCovered = coverageOf('markets', deps.sources) === 'covered';
  const body = [
    `# Watchfloor — ${date}`,
    '',
    `> Corpus as of ${asOf} — the end of ${date} in ${deps.tz}.`,
    '> Rewritten in place on every run. Same corpus, same bytes: nothing here reads a clock.',
    '',
    ...renderFlagged(flagged, allPinned.length, asOf, trustById),
    ...sections.flatMap((section) => renderSection(section, asOf, trustById)),
  ].join('\n');

  const counts: Record<string, unknown> = {};
  for (const section of sections) counts[`count_${section.beat}`] = section.ranked;

  return {
    relPath: `daily/${date}.md`,
    date,
    asOf,
    flagged,
    flaggedTotal: allPinned.length,
    sections,
    content: renderManagedNote({
      tier: 'fully-managed',
      // NOT a wall clock -- see §1 of the module comment. This is the instant
      // the note describes, which is what makes two runs byte-identical.
      generatedAt: asOf,
      fields: {
        date,
        timezone: deps.tz,
        top_per_beat: topPerBeat,
        count_flagged: allPinned.length,
        ...counts,
        market_ribbon: 'not_configured',
        market_ribbon_detail: marketsCovered ? MARKET_RIBBON_DETAIL_NO_SUBSYSTEM : MARKET_RIBBON_DETAIL,
      },
      body,
    }),
  };
}

/**
 * Builds the note and writes it through Task 4's session.
 *
 * `writeManagedNote` is the `fully-managed` tier: idempotent overwrite, and
 * only over a file that carries our own frontmatter. A hand-authored note that
 * happens to sit in `daily/` is refused, not replaced.
 */
export function writeDailyNote(
  session: VaultSession,
  db: Db,
  date: string,
  deps: DailyNoteDeps,
): VaultWriteResult {
  const note = buildDailyNote(db, date, deps);
  return session.writeManagedNote(note.relPath, note.content);
}

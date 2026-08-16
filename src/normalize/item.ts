/**
 * Raw adapter output -> validated NewItem.
 *
 * Every adapter (Tasks 6-9) emits the same `RawItem` shape regardless of the
 * feed format it read; this module is the single place that turns that shape
 * into something `insertItem` will accept. It is pure: no network, no I/O, no
 * database, so it is tested directly with plain inputs and outputs.
 *
 * The rule that matters most here concerns `publishedAt`. `items` is
 * append-only (no UPDATE or DELETE, trigger-enforced), so a `publishedAt`
 * written once can never be corrected. A malformed timestamp that makes
 * `insertItem` throw `InvalidTimestampError` is loud and recoverable -- the
 * caller just skips that item. A *plausible-looking but wrong* timestamp is
 * not: it is accepted, stored, and permanently misfiles the item in history
 * with no way to detect or repair it later. Every date-parsing decision below
 * is biased toward returning `null` over guessing, and toward hand-written,
 * fully-deterministic parsing over any use of `new Date(arbitraryString)` /
 * `Date.parse(arbitraryString)` -- both of which fall back to
 * implementation-defined behavior for anything outside the one exact ISO
 * form the spec fixes, which is precisely the unreliability this module
 * exists to avoid. The only spec-guaranteed, non-implementation-defined
 * pieces used here are `Date.UTC` with explicit numeric components (pure
 * arithmetic, no string parsing) and `Date.prototype.toISOString()` (a fixed
 * output format for in-range dates).
 */

import { canonicalizeUrl } from './url.ts';
import { assertCanonicalTimestamp, type NewItem } from '../domain/item.ts';
import type { Source } from '../sources/load.ts';
import { classifyItemType } from '../classify/itemType.ts';
import { extractEntities } from '../entities/extract.ts';
import type { EntityRuleset } from '../entities/rules.ts';

export interface RawItem {
  url: string;
  title: string;
  publishedAt?: string | null;
  summary?: string | null;
  author?: string | null;
  raw: unknown;
}

const MAX_SUMMARY_LENGTH = 300;

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

// A parsed date is only trusted if its year falls in this window. This is
// not a cosmetic sanity check -- it is load-bearing for two reasons:
//
// 1. `Date.prototype.toISOString()` only produces the fixed-width 4-digit-
//    year form `YYYY-MM-DDTHH:mm:ss.sssZ` that `assertCanonicalTimestamp`
//    requires when the represented year is in [0, 9999]. Outside that range
//    it switches to an expanded +/-YYYYYY form, which would make this
//    function capable of emitting a value `insertItem` rejects -- exactly
//    what this task's definition of done requires proving can't happen.
//    Bounding years to a plausible window keeps this function's output
//    inside the 4-digit form unconditionally (see the exhaustive test that
//    checks every supported and rejected `publishedAt` case against
//    `assertCanonicalTimestamp`).
// 2. It is a cheap, deliberate backstop against a units mixup elsewhere in
//    the pipeline (see `parseEpochSeconds` below): interpreting a
//    milliseconds value as seconds does not fail to parse -- it produces a
//    perfectly well-formed timestamp for a date roughly 55,000 years in the
//    future. That is precisely the "plausible-looking but wrong" failure
//    this module exists to avoid, and it is silent unless something checks
//    plausibility explicitly. 1990-2200 is wide enough to never reject a
//    real article (every source in the M1 set has existed since at most the
//    1990s) while being nowhere near a seconds/milliseconds collision, which
//    is off by a factor of 1000 -- there is no real date near the boundary
//    that could accidentally trip this in the wrong direction.
const MIN_PLAUSIBLE_YEAR = 1990;
const MAX_PLAUSIBLE_YEAR = 2200;

/**
 * Day 0 of the next month is the last day of this one -- the standard JS
 * trick for computing days-in-month, and safe here (unlike validating an
 * already-suspect day below) because both inputs are already known good: it
 * asks `Date.UTC` to compute an authoritative fact from two trusted numbers,
 * not to normalize a possibly-wrong one.
 */
function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * True if year/month/day/hour/minute/second describe a real calendar
 * date and time.
 *
 * Components are range-checked explicitly rather than handed straight to
 * `Date.UTC` and trusted: `Date.UTC` *normalizes* out-of-range fields
 * instead of rejecting them (month 13 rolls into next year, day 32 rolls
 * into next month, Feb 30 rolls into March), which would silently turn a
 * corrupt date into a different, valid-looking one -- exactly the failure
 * this module exists to prevent.
 */
function isValidCalendarDateTime(
  year: number,
  monthIndex0: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (monthIndex0 < 0 || monthIndex0 > 11) return false;
  if (day < 1 || day > daysInMonth(year, monthIndex0)) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  return true;
}

/**
 * Turns a UTC millisecond instant into a canonical timestamp, or `null` if
 * it isn't finite, isn't within `Date`'s own representable range (which
 * shows up as a NaN year, not a thrown error -- see below), or falls
 * outside the plausible-year window (see above).
 */
function toCanonical(millis: number): string | null {
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  const year = date.getUTCFullYear();
  // `new Date` does not throw for a finite `millis` value outside its own
  // +/-8,640,000,000,000,000ms representable range -- it silently becomes
  // an Invalid Date, whose getUTCFullYear() returns NaN. Every NaN
  // comparison is false, so without this explicit check both
  // `year < MIN_PLAUSIBLE_YEAR` and `year > MAX_PLAUSIBLE_YEAR` evaluate
  // false, the plausible-year guard is silently bypassed, and
  // `date.toISOString()` below throws RangeError: Invalid time value --
  // an uncaught exception from ordinary-looking epoch-seconds input (e.g.
  // an accidental epoch-microseconds value), not the "malformed timestamp
  // throws loudly at insertItem" case this module is designed around.
  // (Fix round 1, Finding 1.)
  if (!Number.isFinite(year) || year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return null;
  return date.toISOString();
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Zone tokens with exactly one meaning everywhere, so treating them as
// +00:00 is not a guess. Every OTHER letter zone (EST, EDT, CST, CDT, MST,
// MDT, PST, PDT, and the RFC-822 single-letter military zones) is rejected:
// RFC 822 nominally assigns these fixed offsets, but real feed generators
// are widely known to emit e.g. "EST" year-round rather than switching to
// "EDT" for daylight saving, and "CST" alone is a genuine multi-way
// collision worldwide (US Central, China, Cuba, and Australian Central time
// all use it). JS `Date`'s own handling of these tokens is
// implementation-defined besides. There is no reliable way to recover the
// intended offset without a lookup table that could easily be wrong for a
// given feed, so per "never guess a date" the whole class yields null.
const UTC_ZONE_TOKENS = new Set(['UT', 'UTC', 'GMT', 'Z']);

// No real-world UTC offset exceeds this. +14:00 (Kiribati's Line Islands) is
// the extreme high case; bounding both directions symmetrically at 14:00
// per fix round 1's bundled minor rather than modeling the true (slightly
// asymmetric, -12:00..+14:00) real-world range, which nobody asked for and
// which risks rejecting a legitimate offset if the real extremes ever shift.
const MAX_OFFSET_MINUTES = 14 * 60;

function parseZoneOffsetMinutes(zone: string): number | null {
  const numeric = /^([+-])(\d{2})(\d{2})$/.exec(zone);
  if (numeric) {
    const [, sign, hh, mm] = numeric;
    const hours = Number(hh);
    const minutes = Number(mm);
    const magnitude = hours * 60 + minutes;
    // Checking the combined magnitude (not `hours` alone against a fixed
    // cap) also catches a value like "+1430", where `hours` on its own
    // would still look plausible but the total does not. A
    // corrupted-but-well-shaped offset like "+2200" would otherwise compute
    // a numerically valid-looking but wrong instant -- the exact
    // plausible-but-wrong failure this module exists to prevent -- rather
    // than failing to parse. (Fix round 1, bundled minor: was +/-23:59.)
    if (minutes > 59 || magnitude > MAX_OFFSET_MINUTES) return null;
    return sign === '-' ? -magnitude : magnitude;
  }
  if (UTC_ZONE_TOKENS.has(zone.toUpperCase())) return 0;
  return null;
}

/**
 * RFC-822/2822 date, e.g. "Tue, 12 Aug 2026 14:30:00 -0400" or
 * "12 Aug 2026 14:30:00 GMT". The day-of-week token, if present, is parsed
 * but deliberately never checked against the actual computed weekday --
 * RFC 2822 itself says the date/time wins over an inconsistent day name, and
 * real feeds get this wrong often enough (the brief's own worked example,
 * "Tue, 12 Aug 2026", names a Wednesday) that validating it would reject
 * good dates for a cosmetic mismatch that carries no ambiguity of its own.
 */
const RFC822_RE =
  /^(?:[A-Za-z]{3},\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}|\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4}|[A-Za-z]{1,5})$/;

/**
 * Windows an RFC-822 year string into a four-digit year. Four-digit years
 * pass through unchanged. A two-digit year is windowed per RFC 822's own
 * successor, RFC 2822 §4.3 ("Obsolete Date and Time"), quoted here in full
 * because this is exactly the kind of rule this module insists on citing
 * rather than inventing:
 *
 *   "If a two digit year is encountered whose value is between 00 and 49,
 *   the year is interpreted by adding 2000, ending up with a value between
 *   2000 and 2049. If a two digit year is encountered with a value between
 *   50 and 99, or any three digit year is encountered, the year is
 *   interpreted by adding 1900."
 *   -- RFC 2822 §4.3, https://www.rfc-editor.org/rfc/rfc2822#section-4.3
 *
 * This is a FIXED mapping, not a sliding window re-derived from today's
 * date the way some libc `strptime("%y")` implementations pick a floating
 * +/-50-year window around "now". A fixed rule means this function's
 * answer for a given two-digit year never changes as time passes and needs
 * no notion of "the current date" -- so reading "26" as 2026 is not this
 * code guessing what year it probably is; it is applying a windowing rule
 * fixed by spec decades before this feed existed, which happens to place
 * "26" in 2000-2049. `RFC822_RE` accepts exactly 2 or exactly 4 digits, so
 * this function is never asked to resolve anything else -- RFC 2822 §4.3
 * also defines a rule for three-digit years, but that shape does not occur
 * in the M1 live corpus and is not part of what this task asked this
 * parser to widen, so it stays unmatched (and thus `null`) by deliberate
 * choice, not oversight.
 *
 * This function only WINDOWS the year; it does not judge plausibility.
 * `toCanonical`'s existing MIN/MAX_PLAUSIBLE_YEAR check runs afterward on
 * every path through this parser exactly as it always has, so a
 * correctly-windowed-but-implausible result (e.g. two-digit "50" -> 1950,
 * below the 1990 floor) still fails closed instead of being trusted just
 * because the windowing arithmetic was followed correctly.
 */
function resolveRfc822Year(yearStr: string): number {
  if (yearStr.length === 4) return Number(yearStr);
  const twoDigit = Number(yearStr);
  return twoDigit <= 49 ? 2000 + twoDigit : 1900 + twoDigit;
}

function parseRfc822(value: string): string | null {
  const m = RFC822_RE.exec(value);
  if (!m) return null;
  const [, dayStr, monStr, yearStr, hourStr, minStr, secStr, zone] = m;

  const monthIndex0 = MONTHS[monStr!.toLowerCase()];
  if (monthIndex0 === undefined) return null;

  const year = resolveRfc822Year(yearStr!);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minStr);
  const second = Number(secStr);
  if (!isValidCalendarDateTime(year, monthIndex0, day, hour, minute, second)) return null;

  const offsetMinutes = parseZoneOffsetMinutes(zone!);
  if (offsetMinutes === null) return null;

  const millis = Date.UTC(year, monthIndex0, day, hour, minute, second) - offsetMinutes * 60_000;
  return toCanonical(millis);
}

/**
 * ISO-8601 with an explicit numeric offset or 'Z'. A date-time with NO
 * offset at all (e.g. "2026-08-12T14:30:00") is deliberately NOT matched:
 * per the ECMA-262 Date Time String Format, an offset-less date-*time* is
 * local time in whatever time zone the running process happens to be in.
 * This is a self-hosted server that could run anywhere; treating it as this
 * host's local clock would be a guess standing in for a parse, so it is
 * refused rather than accepted.
 */
const ISO8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

function parseIso8601(value: string): string | null {
  const m = ISO8601_RE.exec(value);
  if (!m) return null;
  const [, yearStr, monStr, dayStr, hourStr, minStr, secStr, fracStr, zoneStr] = m;

  const year = Number(yearStr);
  const monthIndex0 = Number(monStr) - 1;
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minStr);
  const second = Number(secStr);
  if (!isValidCalendarDateTime(year, monthIndex0, day, hour, minute, second)) return null;

  // Fractional seconds are right-padded/truncated to exactly 3 digits
  // (milliseconds): ".5" means 5 tenths of a second (500ms), not 5ms, so
  // padding must happen on the right, and any precision beyond a
  // millisecond is truncated -- no real feed needs sub-millisecond
  // publish-time resolution, and the canonical format only has room for 3
  // digits regardless.
  const ms = fracStr ? Number(fracStr.slice(0, 3).padEnd(3, '0')) : 0;

  const offsetMinutes = parseZoneOffsetMinutes(zoneStr!.replace(':', ''));
  if (offsetMinutes === null) return null;

  const millis = Date.UTC(year, monthIndex0, day, hour, minute, second, ms) - offsetMinutes * 60_000;
  return toCanonical(millis);
}

/**
 * Bare calendar date, no time component at all, e.g. "2026-08-11"
 * (cisa-kev's `dateAdded`, federal-register's `publication_date` -- both
 * sampled verbatim from the M1 live corpus). The DATE here is unambiguous;
 * the TIME of day is not -- the source simply never states one. Rejecting
 * the whole value over a missing time is what produced the gap this
 * function fixes: 1,715 of 3,325 items (51.6%) in the first live ingest had
 * a null `publishedAt`, entirely from three sources emitting this shape or
 * the two-digit-year RFC-822 shape above.
 *
 * Convention chosen: midnight UTC (00:00:00.000Z) on the given date.
 * Reasons, and the cost, stated plainly rather than left implicit:
 *
 *   - It is the standard, unsurprising reading -- it is what the ECMA-262
 *     Date Time String Format itself assigns to a date-only ISO string
 *     (`new Date("2026-08-11")` means exactly this instant), so adopting it
 *     here does not introduce a new, project-specific convention.
 *   - It is reproducible from the string alone, with no other input (not
 *     `fetchedAt`, not a guess at the source's publishing habits).
 *   - It never rolls into the previous or next calendar day in any
 *     timezone the way "local midnight" or "noon in some assumed zone"
 *     could -- there is no zone conversion involved at all.
 *
 *   THE COST: an item dated this way sorts as if it were published at the
 *   very first instant of that day. A same-day item from another source
 *   carrying a real intraday timestamp (e.g. "2026-08-11T14:22:00Z") will
 *   always sort as NEWER than a same-day cisa-kev/federal-register item
 *   stamped "2026-08-11T00:00:00.000Z" by this convention -- even if the
 *   cisa-kev entry was actually added later that same day. Recency ranking
 *   is therefore trustworthy at day granularity for these sources, but NOT
 *   at intraday granularity. That is a real trade, accepted here because
 *   the alternative -- leaving the date null, as before -- discarded the
 *   date entirely rather than merely losing sub-day precision on it.
 *
 * Calendar components are validated the same way, and by the same
 * function, as every other parser in this module: `isValidCalendarDateTime`
 * rejects an impossible month/day (e.g. "2026-13-45") outright rather than
 * handing it to `Date.UTC`, which would silently normalize it into a
 * different, valid-looking date instead of failing.
 */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDateOnly(value: string): string | null {
  const m = DATE_ONLY_RE.exec(value);
  if (!m) return null;
  const [, yearStr, monStr, dayStr] = m;

  const year = Number(yearStr);
  const monthIndex0 = Number(monStr) - 1;
  const day = Number(dayStr);
  if (!isValidCalendarDateTime(year, monthIndex0, day, 0, 0, 0)) return null;

  const millis = Date.UTC(year, monthIndex0, day, 0, 0, 0, 0);
  return toCanonical(millis);
}

/**
 * Bare epoch seconds, e.g. "1786545000" (Hacker News via Algolia's
 * `created_at_i`). A bare digit string is indistinguishable from epoch
 * MILLISECONDS by shape alone -- there is nothing in "1786545000000" that
 * marks it as milliseconds rather than a very large seconds value. This
 * function resolves that by CONTRACT rather than by guessing: a bare digit
 * string always means seconds. A source whose native unit is milliseconds
 * must convert to seconds (or emit one of the other supported string
 * formats) in its own adapter, where the unit is actually known, rather than
 * relying on this function to infer it. As a backstop against an adapter
 * bug that violates this contract, `toCanonical`'s plausible-year window
 * catches the fallout: a milliseconds value misread as seconds lands
 * roughly 55,000 years in the future, which is a `null`, not a corrupted
 * "valid" row.
 */
function parseEpochSeconds(value: string): string | null {
  if (!/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return null;
  return toCanonical(seconds * 1000);
}

function parsePublishedAt(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return (
    parseIso8601(trimmed) ??
    parseDateOnly(trimmed) ??
    parseRfc822(trimmed) ??
    parseEpochSeconds(trimmed)
  );
}

// ---------------------------------------------------------------------------
// Summary truncation
// ---------------------------------------------------------------------------

// A UTF-16 high surrogate (the first unit of a two-unit surrogate pair,
// e.g. an emoji or other non-BMP character) never appears alone in
// well-formed text -- it is always immediately followed by a low surrogate
// (0xDC00-0xDFFF). Range from the Unicode standard, not a guess.
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

/**
 * Truncates to at most 300 characters at a word boundary, so an excerpt
 * never ends mid-word. Falls back to a hard cut only when there is no space
 * anywhere in the first 300 characters to truncate at (a single
 * pathologically long token) -- returning nothing at all in that case would
 * be worse than a hard cut.
 */
function truncateSummary(summary: string | null): string | null {
  if (summary === null) return null;
  if (summary.length <= MAX_SUMMARY_LENGTH) return summary;

  const slice = summary.slice(0, MAX_SUMMARY_LENGTH);
  const lastSpace = slice.lastIndexOf(' ');
  // lastSpace > 0, not >= 0: a space at index 0 (the only space found) would
  // otherwise truncate to an empty string. Falling back to the hard cut
  // keeps at least the leading content.
  let cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;

  // `.slice(0, 300)` cuts by UTF-16 code unit, which can land inside a
  // surrogate pair (e.g. an emoji) and leave a lone high surrogate as the
  // final character. Node's UTF-8 encoder does not throw on that -- it
  // silently replaces the orphaned surrogate with U+FFFD, and SQLite TEXT
  // storage goes through exactly this encoding, so this is real silent
  // corruption of stored text, not a cosmetic glitch. Drop the orphaned
  // surrogate rather than store it. `charCodeAt` on an empty string returns
  // NaN, which safely fails both range comparisons below, so this is a
  // no-op for the (unreachable in practice, but not assumed away) empty-cut
  // case. (Fix round 1, Finding 3.)
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= HIGH_SURROGATE_MIN && lastCode <= HIGH_SURROGATE_MAX) {
    cut = cut.slice(0, -1);
  }

  return cut.trimEnd();
}

// ---------------------------------------------------------------------------
// item_type
//
// M1 shipped a deliberately crude four-branch rule here (source tier, a
// government-primary id list, and a >=400-word threshold on the original
// summary), refined in M2 task 7 into `classifyItemType`
// (src/classify/itemType.ts) -- moved there rather than kept inline because
// it is now substantial enough to own its own module, its own tests, and
// its own extensive real-corpus-grounded doc comment (see that file). This
// call site is otherwise unchanged in shape: classification still happens
// once, at insert time, using the feed's ORIGINAL (pre-truncation) summary
// -- see .superpowers/sdd/2026-08-14-m2-scoring/task-7-report.md for why
// this stays an insert-time-only refinement rather than adding a
// read-time reclassification path.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// normalizeItem
// ---------------------------------------------------------------------------

/**
 * `entityRules` is optional, and omitting it means `entities: []` -- exactly
 * what this function did before M5 task 16, so every existing caller and test
 * is unaffected.
 *
 * It is a PARAMETER rather than a module-level load because this function is
 * pure: reading `config/entities.yaml` here would put file I/O in the one
 * module whose doc comment promises none, and would make the extraction rules
 * a hidden global instead of something a composition root hands in and a test
 * can vary. `src/scheduler/run.ts` threads it through from `src/bin/ingest.ts`
 * and `src/bin/scheduler.ts`.
 *
 * Entities are attributed from `source.beats` -- THIS version's beats, not the
 * `item_key`-wide union, which does not exist yet at insert time and must not:
 * an extraction is stored per `item_id`, so it has to be a pure function of the
 * row for this path and the backfill sweep to provably agree.
 * `getItemEntities` recovers the union at read time.
 */
export function normalizeItem(
  raw: RawItem,
  source: Source,
  fetchedAt: string,
  entityRules?: EntityRuleset,
): NewItem {
  // fetchedAt is a passthrough, not something this function converts -- the
  // caller (the scheduler) owns producing it, normally via
  // `new Date().toISOString()`. Validating it here, with the exact same
  // function insertItem itself uses (not a second validator), means a bad
  // clock reading fails loudly at the point it entered the pipeline instead
  // of resurfacing later as a more confusing error several layers away.
  assertCanonicalTimestamp('fetchedAt', fetchedAt);

  const originalSummary = raw.summary ?? null;
  const canonicalUrl = canonicalizeUrl(raw.url);
  // Computed once and used for BOTH the stored column and entity extraction.
  //
  // Entities read the TRUNCATED summary, deliberately, and this differs from
  // `classifyItemType` two lines below, which reads the original: the
  // classifier's >=400-word rule is a fact about the feed's text, but the
  // backfill sweep (src/entities/sweep.ts) can only ever see `summary_raw` as
  // stored. Feeding this path the untruncated text would make the two write
  // paths disagree on any summary over 300 characters -- silently, and only on
  // long items. The cost is stated rather than hidden: an entity named only
  // beyond the 300-character cut is not extracted by either path.
  const summaryRaw = truncateSummary(originalSummary);

  return {
    url: raw.url,
    canonicalUrl,
    title: raw.title,
    author: raw.author ?? null,
    sourceId: source.id,
    itemType: classifyItemType(source, raw.title, originalSummary),
    // Copy rather than alias: the same Source object is reused across every
    // item drawn from that feed, so returning source.beats by reference
    // would let one item's caller mutate the array out from under every
    // other item from the same source.
    beats: [...source.beats],
    // M5 task 16. This line read `entities: []` from M1 until now, with a
    // comment deferring it to "a later milestone" -- and `select count(*) from
    // item_entities` returned 0 across 7,267 live items the whole time, while
    // five modules read that table and one acceptance criterion depended on it.
    // The canonical URL is passed because cisa-kev states its CVE id nowhere
    // else (see src/entities/extract.ts).
    entities:
      entityRules === undefined
        ? []
        : extractEntities({ title: raw.title, summaryRaw, canonicalUrl, beats: source.beats }, entityRules),
    publishedAt: parsePublishedAt(raw.publishedAt),
    fetchedAt,
    summaryRaw,
    // JSON.stringify(undefined) returns the JS value `undefined`, not a
    // string -- NewItem.rawJson is non-nullable, so an adapter that passes
    // `raw: undefined` (permitted by the `unknown` type) must not produce a
    // NewItem whose rawJson is itself `undefined`.
    rawJson: JSON.stringify(raw.raw) ?? 'null',
  };
}

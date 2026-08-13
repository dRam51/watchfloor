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
import { assertCanonicalTimestamp, type ItemType, type NewItem } from '../domain/item.ts';
import type { Source } from '../sources/load.ts';

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
  /^(?:[A-Za-z]{3},\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4}|[A-Za-z]{1,5})$/;

function parseRfc822(value: string): string | null {
  const m = RFC822_RE.exec(value);
  if (!m) return null;
  const [, dayStr, monStr, yearStr, hourStr, minStr, secStr, zone] = m;

  const monthIndex0 = MONTHS[monStr!.toLowerCase()];
  if (monthIndex0 === undefined) return null;

  const year = Number(yearStr);
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
  return parseIso8601(trimmed) ?? parseRfc822(trimmed) ?? parseEpochSeconds(trimmed);
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
// item_type: deliberately crude, four-branch mechanical rule
// ---------------------------------------------------------------------------

// Exact source ids from the brief's government-primary list, minus `cisa-*`
// which is a prefix match handled separately below.
const GOVERNMENT_PRIMARY_IDS = new Set([
  'federal-register',
  'whitehouse-actions',
  'scotus-slip',
  'nws-fl-alerts',
  'nvd-cve',
]);

function isGovernmentPrimary(sourceId: string): boolean {
  return GOVERNMENT_PRIMARY_IDS.has(sourceId) || sourceId.startsWith('cisa-');
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * items.item_type is NOT NULL with a CHECK constraint (event | analysis |
 * press), so M1 cannot insert a row without SOME value. This rule is
 * deliberately crude -- full classification is a later milestone's job
 * (M2/M4b).
 *
 * Originally implemented as the brief's literal four branches with no
 * `tier === 'analysis'` branch, per an explicit "do not improve it"
 * instruction, and flagged in the task-4 report as a possible asymmetry
 * worth a second look (Source.tier has two possible values but only
 * tier:"event" participated). Fix round 1, Finding 2 ruled the omission a
 * required addition: without it, every analysis-tier source silently falls
 * through to the word-count/press branches unless it happens to exceed 400
 * words, which is wrong for an explicit operator declaration. Placed
 * alongside the tier:"event" check, ahead of both the government-primary
 * check and the word-count fallback -- a tier is a stated fact about the
 * source, not a heuristic, so it outranks both.
 *
 * Word count is measured against the FEED'S ORIGINAL summary, before the
 * 300-character truncation applied for storage. Truncating first would cap
 * every summary at roughly 50-60 words, making the >= 400 branch
 * permanently unreachable rather than merely rare -- the only reading under
 * which that branch is actually exercisable, which the task's own
 * definition of done requires.
 */
function assignItemType(source: Source, originalSummary: string | null): ItemType {
  if (source.tier === 'event') return 'event';
  if (source.tier === 'analysis') return 'analysis';
  if (isGovernmentPrimary(source.id)) return 'event';
  const wordCount = originalSummary === null ? 0 : countWords(originalSummary);
  if (wordCount >= 400) return 'analysis';
  return 'press';
}

// ---------------------------------------------------------------------------
// normalizeItem
// ---------------------------------------------------------------------------

export function normalizeItem(raw: RawItem, source: Source, fetchedAt: string): NewItem {
  // fetchedAt is a passthrough, not something this function converts -- the
  // caller (the scheduler) owns producing it, normally via
  // `new Date().toISOString()`. Validating it here, with the exact same
  // function insertItem itself uses (not a second validator), means a bad
  // clock reading fails loudly at the point it entered the pipeline instead
  // of resurfacing later as a more confusing error several layers away.
  assertCanonicalTimestamp('fetchedAt', fetchedAt);

  const originalSummary = raw.summary ?? null;

  return {
    url: raw.url,
    canonicalUrl: canonicalizeUrl(raw.url),
    title: raw.title,
    author: raw.author ?? null,
    sourceId: source.id,
    itemType: assignItemType(source, originalSummary),
    // Copy rather than alias: the same Source object is reused across every
    // item drawn from that feed, so returning source.beats by reference
    // would let one item's caller mutate the array out from under every
    // other item from the same source.
    beats: [...source.beats],
    // Entity extraction is not this task's responsibility -- RawItem carries
    // no entity data to extract from. Left empty for a later milestone.
    entities: [],
    publishedAt: parsePublishedAt(raw.publishedAt),
    fetchedAt,
    summaryRaw: truncateSummary(originalSummary),
    // JSON.stringify(undefined) returns the JS value `undefined`, not a
    // string -- NewItem.rawJson is non-nullable, so an adapter that passes
    // `raw: undefined` (permitted by the `unknown` type) must not produce a
    // NewItem whose rawJson is itself `undefined`.
    rawJson: JSON.stringify(raw.raw) ?? 'null',
  };
}

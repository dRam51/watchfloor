import { describe, it, expect } from 'vitest';
import { normalizeItem, type RawItem } from '../../src/normalize/item.ts';
import { canonicalizeUrl, InvalidUrlError } from '../../src/normalize/url.ts';
import { assertCanonicalTimestamp, InvalidTimestampError, type Beat } from '../../src/domain/item.ts';
import type { Source } from '../../src/sources/load.ts';

// A URL with no query string at all. Task 2's canonicalization rules are
// actively being rewritten by a sibling agent right now; per this task's
// brief, no test here may assert a *specific* canonicalization outcome for
// a URL with ambiguous query params (that's Task 2's own golden-file suite).
// A bare path with no query string is untouched by every rule currently in
// flux (tracking-param stripping, query sorting) and by every rule already
// settled (lowercasing, www-stripping, https-forcing, trailing slash) since
// none of those apply here either -- so this fixture is inert either way.
const SAFE_URL = 'https://example.test/articles/one';

function rawItem(overrides: Partial<RawItem> = {}): RawItem {
  return {
    url: SAFE_URL,
    title: 'Example title',
    publishedAt: null,
    summary: null,
    author: null,
    raw: { id: 1 },
    ...overrides,
  };
}

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: 'example-source',
    name: 'Example Source',
    type: 'rss',
    url: 'https://example.test/feed.xml',
    beats: ['ai'],
    weight: 1.0,
    poll_interval: '1h',
    enabled: true,
    ...overrides,
  };
}

const FETCHED_AT = '2026-08-12T20:00:00.000Z';

/** Builds an n-word string ("word word word ...") for word-count tests. */
function words(n: number): string {
  return Array(n).fill('word').join(' ');
}

describe('normalizeItem', () => {
  // ---------------------------------------------------------------------
  // URL
  // ---------------------------------------------------------------------
  describe('url', () => {
    it('stores the raw, uncanonicalized URL verbatim in `url`', () => {
      const item = normalizeItem(rawItem({ url: SAFE_URL }), source(), FETCHED_AT);
      expect(item.url).toBe(SAFE_URL);
    });

    it('delegates canonicalization to canonicalizeUrl rather than reimplementing it', () => {
      // Compared against a LIVE call to the real dependency, not a hardcoded
      // literal -- canonicalizeUrl's own rules are owned and tested by Task
      // 2 and are currently being revised by a sibling agent. This proves
      // normalizeItem wires the URL through correctly without this test
      // depending on what any specific rule currently does.
      const item = normalizeItem(rawItem({ url: SAFE_URL }), source(), FETCHED_AT);
      expect(item.canonicalUrl).toBe(canonicalizeUrl(SAFE_URL));
    });

    it('propagates InvalidUrlError for a malformed URL rather than swallowing it', () => {
      expect(() => normalizeItem(rawItem({ url: 'not a url' }), source(), FETCHED_AT)).toThrow(
        InvalidUrlError,
      );
    });
  });

  // ---------------------------------------------------------------------
  // publishedAt: supported formats
  // ---------------------------------------------------------------------
  describe('publishedAt: supported formats', () => {
    it('parses RFC-822 with a numeric negative offset', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: 'Wed, 12 Aug 2026 14:30:00 -0400' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBe('2026-08-12T18:30:00.000Z');
    });

    it('parses RFC-822 with a numeric positive offset', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: '12 Aug 2026 09:15:00 +0530' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBe('2026-08-12T03:45:00.000Z');
    });

    it('parses RFC-822 with the literal GMT zone (unambiguously +00:00)', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: 'Wed, 12 Aug 2026 14:30:00 GMT' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBe('2026-08-12T14:30:00.000Z');
    });

    it('parses RFC-822 with no day-of-week prefix at all', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: '12 Aug 2026 14:30:00 GMT' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBe('2026-08-12T14:30:00.000Z');
    });

    it('parses ISO-8601 with a numeric offset', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: '2026-08-12T09:15:00+05:30' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBe('2026-08-12T03:45:00.000Z');
    });

    it('parses ISO-8601 already in UTC (Z), padding in missing milliseconds', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: '2026-08-12T14:30:00Z' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBe('2026-08-12T14:30:00.000Z');
    });

    it('parses ISO-8601 with fractional seconds, right-padded to milliseconds', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: '2026-08-12T14:30:00.5Z' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBe('2026-08-12T14:30:00.500Z');
    });

    it('parses ISO-8601 with sub-millisecond precision by truncating to 3 digits', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: '2026-08-12T14:30:00.123456Z' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBe('2026-08-12T14:30:00.123Z');
    });

    it('parses bare epoch seconds (Hacker News via Algolia shape)', () => {
      const item = normalizeItem(rawItem({ publishedAt: '1786545000' }), source(), FETCHED_AT);
      expect(item.publishedAt).toBe('2026-08-12T14:30:00.000Z');
    });

    it('parses a leap day in a leap year (Feb 29 2024)', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: 'Thu, 29 Feb 2024 12:00:00 +0000' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBe('2024-02-29T12:00:00.000Z');
    });
  });

  // ---------------------------------------------------------------------
  // publishedAt: never guess -- every one of these must yield null, not a
  // best-effort or implementation-defined guess.
  // ---------------------------------------------------------------------
  describe('publishedAt: unparseable or ambiguous input yields null, never a guess', () => {
    it('is null when publishedAt is null', () => {
      const item = normalizeItem(rawItem({ publishedAt: null }), source(), FETCHED_AT);
      expect(item.publishedAt).toBeNull();
    });

    it('is null when publishedAt is omitted entirely', () => {
      const raw: RawItem = {
        url: SAFE_URL,
        title: 'Example title',
        raw: { id: 1 },
      };
      const item = normalizeItem(raw, source(), FETCHED_AT);
      expect(item.publishedAt).toBeNull();
    });

    it('is null for an empty string', () => {
      const item = normalizeItem(rawItem({ publishedAt: '' }), source(), FETCHED_AT);
      expect(item.publishedAt).toBeNull();
    });

    it('is null for a whitespace-only string', () => {
      const item = normalizeItem(rawItem({ publishedAt: '   ' }), source(), FETCHED_AT);
      expect(item.publishedAt).toBeNull();
    });

    it('is null for text that is not a date at all', () => {
      const item = normalizeItem(rawItem({ publishedAt: 'not a date' }), source(), FETCHED_AT);
      expect(item.publishedAt).toBeNull();
    });

    // The genuinely-ambiguous class the brief calls out by name: RFC-822
    // dates whose zone is a timezone ABBREVIATION rather than a numeric
    // offset or a literal UTC synonym. "CST" alone is a real multi-way
    // collision (US Central, China, Cuba, Australian Central all use it);
    // "EST" is nominally fixed by RFC 822 but real feed generators are
    // widely known to emit it year-round without switching to "EDT" for
    // daylight saving, so even the "defined" abbreviations can't be trusted.
    // JS Date's own handling of these is implementation-defined besides.
    // Rejecting the whole class, rather than hand-coding a lookup for the
    // handful RFC 822 nominally fixes, is the deliberate choice here.
    it('is null for an RFC-822 date with the CST timezone abbreviation (genuinely ambiguous worldwide)', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: 'Wed, 12 Aug 2026 14:30:00 CST' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBeNull();
    });

    it('is null for an RFC-822 date with the EST timezone abbreviation', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: 'Wed, 12 Aug 2026 14:30:00 EST' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBeNull();
    });

    it('is null for an RFC-822 date with the PDT timezone abbreviation', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: 'Wed, 12 Aug 2026 14:30:00 PDT' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBeNull();
    });

    // ISO-8601 with no offset and no 'Z' at all is local time by the JS spec
    // -- but local to WHAT? This process can be deployed anywhere; treating
    // an offset-less date-time as this host's local clock would be a guess,
    // not a parse, so it is refused rather than accepted.
    it('is null for ISO-8601 with no offset and no Z (ambiguous local time)', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: '2026-08-12T14:30:00' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBeNull();
    });

    it('is null for a calendar date that does not exist (Feb 30)', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: 'Mon, 30 Feb 2026 12:00:00 +0000' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBeNull();
    });

    it('is null for Feb 29 in a non-leap year (2026)', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: 'Sun, 29 Feb 2026 12:00:00 +0000' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBeNull();
    });

    it('is null for an out-of-range hour (25)', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: 'Wed, 12 Aug 2026 25:30:00 +0000' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBeNull();
    });

    it('is null for a corrupted numeric offset (+9999, not a real UTC offset)', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: '2026-08-12T14:30:00+9999' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBeNull();
    });

    // Epoch seconds vs. epoch milliseconds are indistinguishable by shape
    // alone (both are bare digit strings). This normalizer's contract is
    // that a bare digit string always means SECONDS -- the one concrete
    // case named in the brief (Hacker News via Algolia's `created_at_i`).
    // A future adapter that accidentally hands this function milliseconds
    // (e.g. from `Date.now()`) doesn't fail to parse -- multiplying by 1000
    // again produces a perfectly well-formed timestamp some 55,000+ years in
    // the future. That is exactly the "plausible-looking but wrong" failure
    // this module exists to avoid, so the plausible-year window catches it.
    it('is null for a digit string whose magnitude implies epoch milliseconds, not seconds', () => {
      const item = normalizeItem(rawItem({ publishedAt: '1786545000000' }), source(), FETCHED_AT);
      expect(item.publishedAt).toBeNull();
    });

    // Fix round 1, Finding 1 (CRITICAL): a bare digit string that is a safe
    // integer (Number.isSafeInteger passes, up to ~9.007e15) can still, once
    // multiplied by 1000 to become milliseconds, exceed `Date`'s own
    // representable range of +/-8.64e15ms. `new Date` does not throw for
    // that -- it silently becomes an Invalid Date, whose getUTCFullYear()
    // returns NaN. Every NaN comparison is false, so the plausible-year
    // guard's `year < MIN` / `year > MAX` checks were BOTH silently bypassed
    // and execution reached `date.toISOString()`, which throws a RangeError.
    // That is not the brief's accepted "malformed input throws loudly at
    // insertItem" case -- it is normalizeItem itself throwing an
    // undocumented, wrongly-typed exception for input in exactly the
    // bare-digit epoch-seconds shape this module claims to support. These
    // three values reproduce it at increasing distance past the boundary
    // (the first is barely over; MAX_SAFE_INTEGER is nowhere near it).
    describe('epoch seconds beyond Date\'s own representable range must be null, never a thrown RangeError', () => {
      const beyondDateRange = [
        '8640000000001', // 8,640,000,000,001,000ms -- just over +/-8.64e15
        '9007199254740991', // Number.MAX_SAFE_INTEGER
        '100000000000000', // comfortably beyond range
      ];

      for (const publishedAt of beyondDateRange) {
        it(`does not throw, and is null, for epoch seconds "${publishedAt}"`, () => {
          const call = () => normalizeItem(rawItem({ publishedAt }), source(), FETCHED_AT);
          expect(call).not.toThrow();
          expect(call().publishedAt).toBeNull();
        });
      }
    });

    // Bundled minor (fix round 1): no real-world UTC offset exceeds
    // +/-14:00 (Kiribati's Line Islands is the extreme case). "+9999" was
    // already rejected (hours > 23), but a corrupted-but-well-shaped offset
    // like "+2200" was NOT: hours=22 passed the old `> 23` check and
    // produced a numerically valid-looking but wrong instant -- the exact
    // plausible-but-wrong failure this module exists to prevent, just via a
    // different input than Finding 1.
    it('is null for a numeric offset beyond +/-14:00 that the old +/-23:59 bound would have silently accepted (+2200)', () => {
      const item = normalizeItem(
        rawItem({ publishedAt: '2026-08-12T14:30:00+2200' }),
        source(),
        FETCHED_AT,
      );
      expect(item.publishedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // summary -> summaryRaw: 300-char cap at a word boundary
  // ---------------------------------------------------------------------
  describe('summary truncation', () => {
    it('stores a summary under 300 characters verbatim', () => {
      const item = normalizeItem(rawItem({ summary: 'A short summary.' }), source(), FETCHED_AT);
      expect(item.summaryRaw).toBe('A short summary.');
    });

    it('stores a summary of exactly 300 characters verbatim (boundary)', () => {
      const exact = 'x'.repeat(300);
      const item = normalizeItem(rawItem({ summary: exact }), source(), FETCHED_AT);
      expect(item.summaryRaw).toBe(exact);
      expect(item.summaryRaw).toHaveLength(300);
    });

    it('truncates a summary over 300 characters at the last word boundary', () => {
      // 30 ten-character "word0123456 " tokens = 330 chars, well past the cap,
      // with plenty of word boundaries before and after position 300.
      const long = Array.from({ length: 30 }, (_, i) => `word${i}`.padEnd(10, '_')).join(' ');
      const item = normalizeItem(rawItem({ summary: long }), source(), FETCHED_AT);

      expect(item.summaryRaw).not.toBeNull();
      const result = item.summaryRaw as string;
      expect(result.length).toBeLessThanOrEqual(300);
      // No partial word: the result must be a prefix of the original that
      // ends exactly on a token boundary, not mid-token.
      expect(long.startsWith(result)).toBe(true);
      expect(long[result.length]).toBe(' ');
      // Must not end with a dangling space.
      expect(result.endsWith(' ')).toBe(false);
    });

    it('falls back to a hard cut at 300 when there is no word boundary to truncate at', () => {
      const noSpaces = 'a'.repeat(400);
      const item = normalizeItem(rawItem({ summary: noSpaces }), source(), FETCHED_AT);
      expect(item.summaryRaw).toBe('a'.repeat(300));
    });

    it('does not split a UTF-16 surrogate pair at the hard-cut boundary (fix round 1, Finding 3)', () => {
      // 299 plain characters + one non-BMP emoji (a 2-code-unit surrogate
      // pair) straddling the 300-unit cut point, then more filler with no
      // spaces anywhere in the first 300 units -- forces the hard-cut
      // fallback path, which is where the bug lived: `.slice(0, 300)` cuts
      // by UTF-16 code unit, landing between the emoji's high and low
      // surrogate and leaving a lone high surrogate as the final character.
      const summary = 'a'.repeat(299) + '\u{1F600}' + 'b'.repeat(50);
      const item = normalizeItem(rawItem({ summary }), source(), FETCHED_AT);

      expect(item.summaryRaw).not.toBeNull();
      const result = item.summaryRaw as string;

      // A lone high surrogate at the end is exactly what silent UTF-8
      // storage (SQLite TEXT storage goes through this same encoding) would
      // mangle into U+FFFD without ever throwing. Round-tripping through
      // the same encoding is a direct, precise check: a clean string
      // survives unchanged; a string ending in an orphaned surrogate does
      // not.
      expect(Buffer.from(result, 'utf8').toString('utf8')).toBe(result);
    });

    it('is null when summary is null', () => {
      const item = normalizeItem(rawItem({ summary: null }), source(), FETCHED_AT);
      expect(item.summaryRaw).toBeNull();
    });

    it('is null when summary is omitted entirely', () => {
      const raw: RawItem = { url: SAFE_URL, title: 'Example title', raw: { id: 1 } };
      const item = normalizeItem(raw, source(), FETCHED_AT);
      expect(item.summaryRaw).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // item_type: the four-branch mechanical rule, exactly as specified.
  // Deliberately crude -- M2 owns real classification. See task-4-report.md.
  // ---------------------------------------------------------------------
  describe('item_type', () => {
    it('branch 1: source has tier "event" -> event', () => {
      const item = normalizeItem(
        rawItem({ summary: 'short' }),
        source({ id: 'crypto-prices', tier: 'event' }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('event');
    });

    it('branch 2: government-primary source by exact id -> event', () => {
      const govIds = [
        'federal-register',
        'whitehouse-actions',
        'scotus-slip',
        'nws-fl-alerts',
        'nvd-cve',
      ];
      for (const id of govIds) {
        const item = normalizeItem(
          rawItem({ summary: 'short' }),
          source({ id, tier: undefined }),
          FETCHED_AT,
        );
        expect(item.itemType, `source id ${id}`).toBe('event');
      }
    });

    it('branch 2: government-primary source matched by the cisa-* prefix -> event', () => {
      const item = normalizeItem(
        rawItem({ summary: 'short' }),
        source({ id: 'cisa-kev' }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('event');
    });

    it('branch 2: a non-cisa- source that merely contains "cisa" is NOT treated as government-primary', () => {
      const item = normalizeItem(
        rawItem({ summary: 'short' }),
        source({ id: 'not-cisa-related' }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('press');
    });

    it('branch 3: summary word count >= 400 (and not tier:event / not gov-primary) -> analysis', () => {
      const item = normalizeItem(
        rawItem({ summary: words(400) }),
        source({ id: 'some-blog' }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('analysis');
    });

    it('branch 3 boundary: exactly 399 words does NOT reach analysis', () => {
      const item = normalizeItem(
        rawItem({ summary: words(399) }),
        source({ id: 'some-blog' }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('press');
    });

    it('branch 4: otherwise -> press', () => {
      const item = normalizeItem(
        rawItem({ summary: 'A short press-length summary.' }),
        source({ id: 'some-blog' }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('press');
    });

    it('branch 4: no summary at all -> press (word count 0)', () => {
      const item = normalizeItem(
        rawItem({ summary: null }),
        source({ id: 'some-blog' }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('press');
    });

    it('precedence: tier "event" wins even over a 400+-word summary', () => {
      const item = normalizeItem(
        rawItem({ summary: words(500) }),
        source({ id: 'crypto-prices', tier: 'event' }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('event');
    });

    it('precedence: government-primary wins even over a 400+-word summary', () => {
      const item = normalizeItem(
        rawItem({ summary: words(500) }),
        source({ id: 'federal-register', tier: undefined }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('event');
    });

    it('word count is measured on the ORIGINAL summary, not the 300-char-truncated one', () => {
      // 500 words is comfortably >= 400 (analysis branch) and also
      // comfortably over 300 characters (so summaryRaw is truncated). If
      // word count were computed on the already-truncated ~50-60-word
      // excerpt instead, this would misclassify as 'press'.
      const raw = rawItem({ summary: words(500) });
      const item = normalizeItem(raw, source({ id: 'some-blog' }), FETCHED_AT);

      expect(item.itemType).toBe('analysis');
      expect((item.summaryRaw as string).length).toBeLessThanOrEqual(300);
    });

    it('branch (ruling, fix round 1 Finding 2): tier "analysis" forces item_type analysis, even with a short summary', () => {
      // Originally implemented as a literal four-branch rule with no
      // tier:"analysis" branch, per the brief's "do not improve it"
      // instruction, and flagged in the task-4 report as a possible
      // asymmetry worth a second look (Source.tier has two values but only
      // tier:"event" participated). Fix round 1, Finding 2 ruled the
      // omission a required addition: without it, an analysis-tier source
      // silently falls through to word-count/press unless it happens to
      // exceed 400 words, when a tier is an explicit operator declaration
      // that should outrank a heuristic. A one-word summary (nowhere near
      // the 400-word threshold) proves the tier branch is what wins here,
      // not a coincidental word-count match.
      const item = normalizeItem(
        rawItem({ summary: 'short' }),
        source({ id: 'some-index', tier: 'analysis' }),
        FETCHED_AT,
      );
      expect(item.itemType).toBe('analysis');
    });
  });

  // ---------------------------------------------------------------------
  // beats: copied from the source, not aliased
  // ---------------------------------------------------------------------
  describe('beats', () => {
    it('copies beats from the source', () => {
      const beats: Beat[] = ['cyber', 'aisec'];
      const item = normalizeItem(rawItem(), source({ beats }), FETCHED_AT);
      expect(item.beats).toEqual(['cyber', 'aisec']);
    });

    it('does not alias the source\'s beats array', () => {
      const beats: Beat[] = ['markets'];
      const src = source({ beats });
      const item = normalizeItem(rawItem(), src, FETCHED_AT);

      expect(item.beats).not.toBe(src.beats);
      item.beats.push('usnews');
      expect(src.beats).toEqual(['markets']);
    });
  });

  // ---------------------------------------------------------------------
  // Straightforward field pass-through / defaults
  // ---------------------------------------------------------------------
  describe('other fields', () => {
    it('copies title through', () => {
      const item = normalizeItem(rawItem({ title: 'A Specific Title' }), source(), FETCHED_AT);
      expect(item.title).toBe('A Specific Title');
    });

    it('sets sourceId from source.id', () => {
      const item = normalizeItem(rawItem(), source({ id: 'my-source' }), FETCHED_AT);
      expect(item.sourceId).toBe('my-source');
    });

    it('copies author through when present', () => {
      const item = normalizeItem(rawItem({ author: 'Jane Reporter' }), source(), FETCHED_AT);
      expect(item.author).toBe('Jane Reporter');
    });

    it('defaults author to null when absent', () => {
      const raw: RawItem = { url: SAFE_URL, title: 'Example title', raw: { id: 1 } };
      const item = normalizeItem(raw, source(), FETCHED_AT);
      expect(item.author).toBeNull();
    });

    it('passes fetchedAt through unchanged', () => {
      const item = normalizeItem(rawItem(), source(), FETCHED_AT);
      expect(item.fetchedAt).toBe(FETCHED_AT);
    });

    it('sets entities to an empty array (entity extraction is not this task\'s job)', () => {
      const item = normalizeItem(rawItem(), source(), FETCHED_AT);
      expect(item.entities).toEqual([]);
    });

    it('round-trips raw through rawJson as JSON', () => {
      const payload = { id: 42, nested: { ok: true } };
      const item = normalizeItem(rawItem({ raw: payload }), source(), FETCHED_AT);
      expect(JSON.parse(item.rawJson)).toEqual(payload);
    });

    it('stores rawJson as the string "null" (not JS undefined) when raw is undefined', () => {
      const item = normalizeItem(rawItem({ raw: undefined }), source(), FETCHED_AT);
      expect(item.rawJson).toBe('null');
    });
  });

  // ---------------------------------------------------------------------
  // Definition-of-done #3: normalizeItem can never emit a NewItem that
  // insertItem would reject as a malformed timestamp.
  // ---------------------------------------------------------------------
  describe('output always satisfies assertCanonicalTimestamp (never emits what insertItem would reject)', () => {
    it('fetchedAt always validates when given a canonical fetchedAt', () => {
      const item = normalizeItem(rawItem(), source(), FETCHED_AT);
      expect(() => assertCanonicalTimestamp('fetchedAt', item.fetchedAt)).not.toThrow();
    });

    it('rejects a non-canonical fetchedAt by throwing, rather than emitting a NewItem insertItem would later reject', () => {
      expect(() =>
        normalizeItem(rawItem(), source(), '2026-08-12T20:00:00-05:00'),
      ).toThrow(InvalidTimestampError);
    });

    it('rejects a fetchedAt missing milliseconds precision', () => {
      expect(() => normalizeItem(rawItem(), source(), '2026-08-12T20:00:00Z')).toThrow(
        InvalidTimestampError,
      );
    });

    // Every publishedAt input case exercised anywhere above, re-checked in
    // one place: the result must be null, or it must pass the exact
    // validator insertItem itself uses. There is no third outcome.
    it('every supported and rejected publishedAt input yields either null or a canonical timestamp', () => {
      const inputs = [
        null,
        undefined,
        '',
        '   ',
        'not a date',
        'Wed, 12 Aug 2026 14:30:00 -0400',
        '12 Aug 2026 09:15:00 +0530',
        'Wed, 12 Aug 2026 14:30:00 GMT',
        'Wed, 12 Aug 2026 14:30:00 CST',
        'Wed, 12 Aug 2026 14:30:00 EST',
        'Wed, 12 Aug 2026 14:30:00 PDT',
        '2026-08-12T09:15:00+05:30',
        '2026-08-12T14:30:00Z',
        '2026-08-12T14:30:00.5Z',
        '2026-08-12T14:30:00.123456Z',
        '2026-08-12T14:30:00',
        '2026-08-12T14:30:00+9999',
        '1786545000',
        '1786545000000',
        'Mon, 30 Feb 2026 12:00:00 +0000',
        'Sun, 29 Feb 2026 12:00:00 +0000',
        'Thu, 29 Feb 2024 12:00:00 +0000',
        'Wed, 12 Aug 2026 25:30:00 +0000',
        // Fix round 1, Finding 1: 13-16 digit safe integers that exceed
        // Date's own +/-8.64e15ms representable range once multiplied into
        // milliseconds -- the original version of this test topped out at
        // '1786545000000' (13 digits, but still inside Date's range), which
        // is why it didn't catch the RangeError this module could throw.
        '8640000000001',
        '9007199254740991',
        '100000000000000',
        // Fix round 1, bundled minor: an offset beyond the new +/-14:00 bound.
        '2026-08-12T14:30:00+2200',
      ];

      for (const publishedAt of inputs) {
        const item = normalizeItem(rawItem({ publishedAt }), source(), FETCHED_AT);
        if (item.publishedAt === null) continue;
        expect(
          () => assertCanonicalTimestamp('publishedAt', item.publishedAt as string),
          `input ${JSON.stringify(publishedAt)} produced ${item.publishedAt}`,
        ).not.toThrow();
      }
    });
  });
});

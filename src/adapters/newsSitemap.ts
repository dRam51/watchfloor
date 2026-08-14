/**
 * Google-News-schema sitemap adapter (Task 8) -- the only route this project
 * has to Associated Press content. AP publishes no RSS: its robots.txt
 * (tests/fixtures/robots/apnews.robots.txt) disallows `/*.rss` and
 * `/api/v2/feed/` for every user agent. But it explicitly `Sitemap:`-declares
 * `https://apnews.com/news-sitemap-content.xml`, which is allowed under the
 * default `User-agent: * / Disallow:` group, and that document carries
 * everything this pipeline needs: title, canonical URL, and publication date
 * for every recent article.
 *
 * Format: the Google News sitemap schema
 * (http://www.google.com/schemas/sitemap-news/0.9) -- a plain sitemap
 * <urlset> where each <url> carries <loc> plus a <news:news> block with
 * <news:publication><news:name>, <news:publication_date>, and <news:title>.
 * See the module-level fixture tests/fixtures/adapters/apnews-news-sitemap.xml
 * for a real, captured example.
 *
 * No description/summary/body field exists in this schema at all --
 * RawItem.summary and RawItem.author are always null for every item this
 * adapter emits. That is deliberate and matches the project's own excerpt
 * policy (a raw field the source never provided) rather than working around
 * a gap: nothing here should ever synthesise a summary to fill it in.
 *
 * Shares fast-xml-parser with src/adapters/rss.ts (both approved to import it
 * directly -- see src/adapters/types.ts's module doc: the dependency must
 * stay out of the shared contract and out of every OTHER module, not out of
 * every adapter). This file does not import anything from rss.ts, and
 * duplicates the small set of XML helpers it needs locally: each adapter
 * file is self-contained by design, matching how rss.ts's own module comment
 * describes its fast-xml-parser use as "intentionally confined to this one
 * file" -- the same isolation applies file-by-file, not just
 * dependency-by-codebase.
 *
 * ---------------------------------------------------------------------------
 * Skip vs. throw -- mirrors rss.ts's rule, adapted to this format's fields
 * ---------------------------------------------------------------------------
 * A malformed INDIVIDUAL <url> entry (no <loc>, a blank <loc>, no
 * <news:title>, or no <news:news> block at all) is dropped by parseUrlEntry
 * returning null; parseEntries (types.ts) keeps every entry that didn't and
 * counts the rest into `skipped`. This never throws, and one bad entry never
 * affects its neighbours -- proven in tests/adapters/newsSitemap.test.ts
 * against a hand-authored fixture with all four defect shapes interleaved
 * between good entries.
 *
 * A malformed <news:publication_date> is explicitly NOT a drop reason.
 * Deciding whether a date string parses is normalizeItem's job
 * (src/normalize/item.ts), never this layer's -- the raw string survives on
 * `publishedAt` untouched, exactly like rss.ts's <pubDate>/<published>
 * handling. RawItem.publishedAt is optional specifically so a format with no
 * date at all, or a date this adapter cannot make sense of, is never grounds
 * to drop an otherwise-usable article.
 *
 * A WHOLLY unparseable body throws NewsSitemapParseError: the XML tokenizer
 * itself failing (parser.parse() throwing), or the parsed document having no
 * recognizable <urlset> root at all (plain text, an HTML error page served
 * with 200, or an empty body -- fast-xml-parser does not itself throw for
 * any of these, verified directly against this file's parser config, so the
 * root-shape check is load-bearing, not a formality; same verified property
 * rss.ts's module comment documents for its own <rss>/<feed> check). Either
 * throw propagates out of fetch() so the scheduler records a real failure.
 *
 * A well-formed <urlset> with zero <url> children is NOT an error: it
 * resolves with items: [], matching a genuinely quiet publishing window
 * rather than being conflated with a broken fetch.
 *
 * Recovering entries absorbed by an unclosed element. Same mechanism as
 * rss.ts, generalized to this format's <url> element rather than
 * <item>/<entry>: fast-xml-parser is a lenient tokenizer, not a validating,
 * self-healing parser, so a genuinely unclosed element (no closing tag
 * anywhere later in the document) can absorb well-formed later siblings as
 * DESCENDANTS of the broken element instead of leaving them alone. A
 * conformant <url> never legitimately contains a descendant <url>, so
 * finding one nested inside an already-extracted entry is a
 * zero-false-positive signature of exactly this corruption --
 * recoverAbsorbedEntries below detects it and re-parses the recovered
 * siblings as their own entries, so nothing is lost.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * Language filtering -- dropped at ingest, never stored (fix-ap-language-filter task)
 * ---------------------------------------------------------------------------
 * Each <url> entry's <news:news><news:publication> block carries a
 * <news:language> ISO 639-2/B three-letter code -- "eng", "spa" -- alongside
 * <news:name>. Live-verified: roughly a third of AP's sitemap output is
 * Spanish, much of it a same-day duplicate of an English story under a
 * different URL, which word-level trigram clustering (src/cluster/) cannot
 * associate and the interest profile (src/interests/) cannot suppress (it
 * matches English keyword terms).
 *
 * The owner's decision, explicit and irreversible by design: config's
 * `filters.languages` (`config/sources.yaml`, an allow-list validated by
 * src/sources/load.ts) drops any entry whose declared language is not in the
 * list, here, before the entry is ever normalized or stored -- never stored
 * with a language tag for later read-time suppression. Absence of
 * `filters.languages` on a source means no filtering at all, never an
 * implicit English-only default (see filterByLanguage's own doc comment for
 * the exact mechanics, and its permissive-default tests).
 *
 * An entry whose language cannot be determined -- no <news:publication>, no
 * <news:language>, or a blank one -- is always KEPT regardless of the
 * allow-list, never dropped: see languageOf and filterByLanguage's doc
 * comments for why that asymmetry (undetermined is safer to keep than to
 * guess-and-drop) is deliberate. Real AP entries always declare a language in
 * practice, so this path is a defensive fallback, not the common case.
 *
 * Runs BEFORE the item cap (MAX_ITEMS_PER_FETCH below), and the excluded
 * count is reported through AdapterResult.filtered, never `skipped` (which
 * means "defective," not "excluded by policy") or `capped` (which is pinned
 * to a volume-only, OLD-end-of-range meaning a content decision would
 * violate) -- see that field's doc comment in types.ts for the full
 * reasoning on both.
 * ---------------------------------------------------------------------------
 */

import { XMLParser } from 'fast-xml-parser';
import { politeFetch, type FetchResult } from '../fetch/http.ts';
import type { Source } from '../sources/load.ts';
import type { FetchState } from '../db/fetchState.ts';
import type { RawItem } from '../normalize/item.ts';
import {
  fetchedResult,
  notModifiedResult,
  parseEntries,
  type Adapter,
  type AdapterResult,
  type ParseEntriesResult,
} from './types.ts';

/**
 * Thrown when a response cannot be read as a Google News sitemap at all. See
 * the module doc comment above for exactly which conditions raise this
 * versus which are silently tolerated (a malformed entry) or silently
 * accepted (a well-formed, empty <urlset>).
 */
export class NewsSitemapParseError extends Error {
  constructor(url: string, reason: string, opts?: { cause?: unknown }) {
    super(
      `could not parse ${url} as a Google News sitemap: ${reason}`,
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = 'NewsSitemapParseError';
  }
}

/**
 * Cap on RawItems returned per fetch, applied to the MOST RECENT entries by
 * publication date (see capToMostRecent below), never an arbitrary prefix of
 * the document -- the real AP sitemap is observably not sorted by
 * <news:publication_date> (see the fixture file header), so a file-order
 * prefix would not reliably mean "the newest ones".
 *
 * 150. AP's live sitemap ran 585-589 entries / ~294 KiB at verification time
 * (see this task's report for the exact capture), and per the Google News
 * sitemap protocol that a publisher is expected to follow, this is a ROLLING
 * window of roughly the last two days of publication, not a fixed batch --
 * the same still-recent article legitimately reappears across many
 * consecutive polls until it ages out of that window, rather than being a
 * one-shot batch that must be captured completely on a single fetch. 150
 * gives more than an order of magnitude of headroom over what even a
 * frequent poll interval (e.g. every 15-30 minutes) should ever need to pick
 * up as genuinely NEW in one cycle, while still cutting the realistic
 * ~585-entry response by more than half. A cold start, a batch import, or
 * recovery after a multi-hour outage therefore does NOT need the full body
 * in one shot: each poll re-ranks the same rolling universe by recency, so a
 * backlog clears at roughly the rate new articles arrive -- nearer three or
 * four cycles than one or two, since the cap can only ever admit that many
 * new-to-us entries per poll, not the whole deficit at once. See `capped` on
 * `AdapterResult` (src/adapters/types.ts) for how much was actually trimmed
 * on any given fetch, so this is a measured number, not just an assumption.
 * Exported so a future tuning pass finds one named constant rather than a
 * magic number buried in fetch().
 */
export const MAX_ITEMS_PER_FETCH = 150;

// One parser instance, reused across every call -- see rss.ts's identical
// module-level instance for why this is safe (XMLParser#parse is
// synchronous, no cross-call interleaving hazard).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // Never coerce text to number/boolean -- a publication_date or title that
  // happens to look numeric must stay a string. Same reasoning as rss.ts.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Decodes numeric character references and common HTML named entities, in
  // addition to the 5 predefined XML entities -- real titles carry curly
  // quotes, em dashes, and accented characters as literal UTF-8 (verified
  // against the real AP fixture) but a feed generator emitting an entity
  // form must decode the same way rss.ts's does. See rss.ts's identical
  // option for the full justification.
  htmlEntities: true,
  // Forces <url> to always be an array, even when a <urlset> has exactly
  // one -- fast-xml-parser's default is to unwrap a single-occurrence tag to
  // a bare object. Verified against a synthetic single-entry document (see
  // "does not break on a sitemap with exactly one <url>" in the test file).
  isArray: (name) => name === 'url',
});

type XmlNode = Record<string, unknown>;

function isXmlNode(value: unknown): value is XmlNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts plain text from a fast-xml-parser leaf value -- a bare string, or
 * (if the source tag ever carried attributes) an object shaped
 * `{ "#text": string, "@_attr": ... }`. Returns null for anything else
 * (absent, or an unexpected shape). Identical to rss.ts's helper of the same
 * name and purpose; duplicated rather than imported, per this file's
 * self-containment (see module doc comment).
 */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isXmlNode(value) && typeof value['#text'] === 'string') return value['#text'];
  return null;
}

/** Blank after the XML layer's own whitespace trimming is the same as absent -- an empty or whitespace-only <loc></loc> is not a link. */
function isBlank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

// ---------------------------------------------------------------------------
// Per-entry extraction
// ---------------------------------------------------------------------------

function parseUrlEntry(entry: unknown): RawItem | null {
  if (!isXmlNode(entry)) return null;

  const url = textOf(entry.loc);

  // <news:news> may be absent entirely (e.g. a plain sitemap URL with no
  // news metadata at all, which would be unusual for a document declared as
  // a NEWS sitemap specifically, but not something to trust blindly) -- in
  // which case no title is obtainable either way, same drop reason as
  // <news:title> being present-but-absent below.
  const news = entry['news:news'];
  const title = isXmlNode(news) ? textOf(news['news:title']) : null;

  if (isBlank(url) || isBlank(title)) return null;

  return {
    url: url as string,
    title: title as string,
    // Passed through exactly as written -- e.g. "2026-08-12T06:52:39-04:00".
    // Interpreting it is normalizeItem's job, never this adapter's. Absent
    // <news:publication_date> (or an absent <news:news> block, which can't
    // happen here since that already returned null above) yields null via
    // the same textOf/isXmlNode guard, not a thrown error.
    publishedAt: isXmlNode(news) ? textOf(news['news:publication_date']) : null,
    // This schema carries no description/summary/body field at all -- see
    // the module doc comment. Left null rather than synthesised.
    summary: null,
    author: null,
    // The full parsed <url> node, not just the fields RawItem surfaces --
    // <lastmod> and anything else the sitemap carries survives here even
    // though only loc/title/publication_date are extracted above.
    raw: entry,
  };
}

/**
 * Extracts a <url> entry's declared <news:language> (nested under
 * <news:news><news:publication>, e.g. "eng" or "spa" -- see the module doc comment's
 * real-entry example), or `null` when it cannot be determined: no <news:news> block, no
 * <news:publication> block, no <news:language> element at all, or a present-but-blank
 * one. `null` deliberately means "undetermined," not "excluded" -- see
 * `filterByLanguage` below for why those two are never treated the same.
 *
 * Takes `unknown` (not `XmlNode`) so it can be called directly on a `RawItem.raw` value
 * from `filterByLanguage` -- `RawItem.raw` is typed `unknown` by `src/normalize/item.ts`
 * (off-limits to this task), so re-narrowing here is this adapter's own job, exactly as
 * `parseUrlEntry` above does for the same value one step earlier.
 */
function languageOf(entry: unknown): string | null {
  if (!isXmlNode(entry)) return null;
  const news = entry['news:news'];
  if (!isXmlNode(news)) return null;
  const publication = news['news:publication'];
  if (!isXmlNode(publication)) return null;
  const language = textOf(publication['news:language']);
  return isBlank(language) ? null : language;
}

// ---------------------------------------------------------------------------
// Recovering entries absorbed by a genuinely unclosed element -- see the
// module doc comment's final section. Generalized from rss.ts's
// collectAbsorbedEntries/recoverAbsorbedEntries pair to this format's single
// entry element name ('url') rather than a parser-selected 'item'/'entry'.
// ---------------------------------------------------------------------------

function collectAbsorbedEntries(node: unknown, out: unknown[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectAbsorbedEntries(child, out);
    return;
  }
  if (!isXmlNode(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'url' && Array.isArray(value)) {
      out.push(...value);
      // A chain of several unclosed elements can absorb more than one extra
      // layer -- keep looking inside what was just recovered too.
      for (const child of value) collectAbsorbedEntries(child, out);
    } else {
      collectAbsorbedEntries(value, out);
    }
  }
}

/**
 * Expands `entries` to include anything collectAbsorbedEntries finds nested
 * inside any of them, so a sibling <url> absorbed by an earlier entry's
 * unclosed element is still parsed as its own entry rather than silently
 * lost. Returns the SAME array, no new allocation, when nothing was absorbed
 * -- a no-op on every well-formed sitemap, which is the overwhelming common
 * case (verified: the real trimmed AP fixture round-trips through this
 * function unchanged).
 */
function recoverAbsorbedEntries(entries: unknown[]): unknown[] {
  const absorbed: unknown[] = [];
  for (const entry of entries) {
    if (!isXmlNode(entry)) continue;
    for (const value of Object.values(entry)) {
      collectAbsorbedEntries(value, absorbed);
    }
  }
  return absorbed.length === 0 ? entries : [...entries, ...absorbed];
}

// ---------------------------------------------------------------------------
// Top-level: parse the body, find <urlset>/<url>, extract entries
// ---------------------------------------------------------------------------

function asEntryArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function detectUrlEntries(parsed: unknown, url: string): unknown[] {
  const root = isXmlNode(parsed) ? parsed : {};
  if (!isXmlNode(root.urlset)) {
    throw new NewsSitemapParseError(
      url,
      'root element is not <urlset> -- not a recognizable Google News sitemap document',
    );
  }
  return recoverAbsorbedEntries(asEntryArray(root.urlset.url));
}

function parseSitemapBody(body: string, url: string): ParseEntriesResult {
  let parsed: unknown;
  try {
    parsed = parser.parse(body);
  } catch (cause) {
    throw new NewsSitemapParseError(url, `XML could not be tokenized: ${(cause as Error).message}`, {
      cause,
    });
  }

  const entries = detectUrlEntries(parsed, url);
  return parseEntries(entries, parseUrlEntry);
}

// ---------------------------------------------------------------------------
// Language filtering -- config/sources.yaml's `filters.languages` allow-list
// (validated by src/sources/load.ts). The owner's explicit decision: AP's
// Spanish-language entries are dropped here, at ingest, and never stored --
// not tagged and suppressed later at read time. Runs BEFORE the item cap
// below (see fetch()'s call order), so a disallowed-language entry can never
// occupy a cap slot a valid entry could have used -- see the ordering test in
// tests/adapters/newsSitemap.test.ts for the concrete failure mode that
// ordering avoids.
// ---------------------------------------------------------------------------

/** `filterByLanguage`'s return shape -- see AdapterResult.filtered (types.ts) for why the count travels separately from `items` rather than being reconstructed by the caller as `before.length - after.length`. */
interface LanguageFilterResult {
  items: RawItem[];
  filtered: number;
}

/**
 * Keeps only items whose declared language (see `languageOf` above) is in
 * `allowedLanguages`, EXCEPT an item whose language cannot be determined at
 * all -- `languageOf` returning `null` -- which always survives regardless of
 * the allow-list. That asymmetry is deliberate, not an oversight: dropping an
 * entry because this adapter could not tell what language it was written in
 * is a harsher, less recoverable failure than keeping one whose language
 * simply couldn't be confirmed, since a dropped entry is gone for good (see
 * `items`' append-only storage) while a kept one is merely a false negative
 * for this one filter. Real AP entries always declare a language (see the
 * module doc comment), so this path is a defensive fallback for a field the
 * Google News sitemap spec requires but this adapter does not blindly trust
 * every document to actually carry, not the common case.
 *
 * `allowedLanguages` absent, or present but empty (unreachable through
 * src/sources/load.ts's Zod validation, which rejects an empty array at
 * config load -- guarded here anyway since a test can construct a `Source`
 * directly without going through the loader), both mean "no restriction":
 * every item survives and `filtered` is `0`, matching `config/sources.yaml`
 * carrying no `filters.languages` key at all for every source but `ap-news`
 * as of this task.
 */
function filterByLanguage(items: RawItem[], allowedLanguages: readonly string[] | undefined): LanguageFilterResult {
  if (allowedLanguages === undefined || allowedLanguages.length === 0) {
    return { items, filtered: 0 };
  }
  const allowed = new Set(allowedLanguages);
  const kept: RawItem[] = [];
  let filtered = 0;
  for (const item of items) {
    const language = languageOf(item.raw);
    if (language === null || allowed.has(language)) {
      kept.push(item);
    } else {
      filtered++;
    }
  }
  return { items: kept, filtered };
}

// ---------------------------------------------------------------------------
// The item cap -- see MAX_ITEMS_PER_FETCH's doc comment for the chosen value
// and rationale.
// ---------------------------------------------------------------------------

/**
 * Best-effort recency ranking used ONLY to decide which already-valid
 * RawItems (usable url + title, per parseUrlEntry) are worth keeping when
 * there are more than MAX_ITEMS_PER_FETCH of them. This is a genuinely
 * different concern from normalizeItem's never-guess-a-date rule: that rule
 * protects a value that gets PERSISTED (wrong once, permanently wrong under
 * `items`' append-only storage -- see src/normalize/item.ts's module doc);
 * this ranking never touches RawItem.publishedAt itself (parseUrlEntry above
 * always passes the raw string through untouched, regardless of what this
 * function makes of it) and has no permanent consequence -- at worst, an
 * item this can't confidently rank is deferred to the next poll rather than
 * this one, and AP's sitemap is a rolling window (see MAX_ITEMS_PER_FETCH),
 * so a deferred-but-still-recent article is expected to still be present,
 * and re-ranked, next cycle.
 *
 * An entry whose date this can't parse (or that has none) ranks last, not
 * first: there is no evidence it is recent, and the safer trim under a cap
 * is to keep the entries this IS confident are new.
 */
function recencyRank(publishedAt: string | null | undefined): number {
  if (!publishedAt) return -Infinity;
  const millis = Date.parse(publishedAt);
  return Number.isNaN(millis) ? -Infinity : millis;
}

/** No-op (returns the same array) when already at or under `max`, matching recoverAbsorbedEntries's same no-allocation-when-unneeded style. */
function capToMostRecent(items: RawItem[], max: number): RawItem[] {
  if (items.length <= max) return items;
  return items
    .slice()
    .sort((a, b) => recencyRank(b.publishedAt) - recencyRank(a.publishedAt))
    .slice(0, max);
}

// ---------------------------------------------------------------------------

export const newsSitemapAdapter: Adapter = {
  type: 'news_sitemap',

  async fetch(source: Source, state: FetchState | null): Promise<AdapterResult> {
    const fetchResult: FetchResult = await politeFetch(source.url, {
      etag: state?.etag ?? undefined,
      lastModified: state?.lastModified ?? undefined,
    });

    if (fetchResult.notModified) return notModifiedResult(fetchResult, state);

    if (fetchResult.body === null) {
      // politeFetch's contract guarantees a non-null body whenever
      // notModified is false (null only ever accompanies a 304, handled
      // above) -- this asserts that contract rather than silently treating
      // an impossible state as an empty document. Same defensive check as
      // rss.ts.
      throw new NewsSitemapParseError(source.url, 'politeFetch returned a null body for a non-304 response');
    }

    const parsed = parseSitemapBody(fetchResult.body, source.url);

    // Language filtering runs BEFORE the cap, deliberately -- see this
    // section's own header comment above filterByLanguage for why the order
    // matters (a disallowed-language entry must never be able to occupy cap
    // headroom a valid entry could have used). `source.filters?.languages` is
    // `undefined` for every source that configures no `filters.languages` key
    // (permissive default: nothing is filtered, never an implicit
    // English-only assumption) -- see src/sources/load.ts for the Zod
    // validation that guarantees this is either absent or a nonempty array of
    // three-letter codes by the time it reaches here.
    const languageFiltered = filterByLanguage(parsed.items, source.filters?.languages);

    // The cap is applied to the language-filtered `items` only -- `skipped`
    // reports genuine per-entry defects (see parseUrlEntry) and an
    // EntryParser-throw backstop (see parseEntries in types.ts), NEVER
    // entries trimmed by the cap OR excluded by the language filter.
    // Conflating skipped with the cap would make source health read a
    // healthy, working-as-designed AP poll as "the parser is broken" every
    // single run, since 585 real entries against a 150 cap would otherwise
    // report skipped: ~435 forever; conflating it with the language filter
    // would do the same to a poll that is correctly filtering exactly as
    // configured. See AdapterResult.filtered's doc comment (types.ts) for the
    // full reasoning on why that exclusion gets its own field rather than
    // reusing either existing one.
    const cappedItems = capToMostRecent(languageFiltered.items, MAX_ITEMS_PER_FETCH);
    const trimmedByCap = languageFiltered.items.length - cappedItems.length;

    let result = fetchedResult(fetchResult, { items: cappedItems, skipped: parsed.skipped });
    // `capped` and `filtered` both stay undefined (not a fabricated 0)
    // whenever their respective mechanism didn't actually remove anything
    // this fetch -- same "undefined means nothing to report" convention
    // AdapterResult.skipped already uses. See each field's own doc comment in
    // types.ts for why this must never be folded into `skipped` itself.
    if (trimmedByCap > 0) result = { ...result, capped: trimmedByCap };
    if (languageFiltered.filtered > 0) result = { ...result, filtered: languageFiltered.filtered };
    return result;
  },
};

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
 * ~585-entry response by more than half -- so a cold start, a batch import,
 * or recovery after a multi-hour outage catches up within one or two polls
 * rather than requiring the full body every single time. Exported so a
 * future tuning pass finds one named constant rather than a magic number
 * buried in fetch().
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
    // The cap is applied to `items` only -- `skipped` reports genuine
    // per-entry defects (see parseUrlEntry) and an EntryParser-throw
    // backstop (see parseEntries in types.ts), NEVER entries trimmed by the
    // cap. Conflating the two would make source health read a healthy,
    // working-as-designed AP poll as "the parser is broken" every single
    // run, since 585 real entries against a 150 cap would otherwise report
    // skipped: ~435 forever.
    const capped: ParseEntriesResult = {
      items: capToMostRecent(parsed.items, MAX_ITEMS_PER_FETCH),
      skipped: parsed.skipped,
    };
    return fetchedResult(fetchResult, capped);
  },
};

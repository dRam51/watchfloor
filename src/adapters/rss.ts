/**
 * RSS 2.0 and Atom adapter. Both formats behind one `Adapter` (see
 * src/adapters/types.ts) because they differ only in element names, not in
 * what they represent: `<item>`/`<entry>`, `<pubDate>`/`<published>`, etc.
 * The format actually received is detected from the parsed document's root
 * element (`<rss>` vs `<feed>`), never from `source.type` -- see the note on
 * `SourceType` in types.ts for why `type: 'rss'` below still covers the one
 * Atom source in the M1 set.
 *
 * `fast-xml-parser` is the only dependency this task adds, and its use is
 * intentionally confined to this one file (see package.json / task-6-report
 * for the rationale: real-world RSS is frequently malformed -- unescaped
 * ampersands, stray control characters, mismatched namespaces -- and a
 * strict parser drops otherwise-good sources over trivial markup errors).
 * No other module in this codebase may import it.
 *
 * ---------------------------------------------------------------------------
 * Skip vs. throw -- the rule that matters most here
 * ---------------------------------------------------------------------------
 * A malformed INDIVIDUAL entry (missing link, missing/empty title) is
 * dropped by `parseRssItem` / `parseAtomEntry` returning `null`, and
 * `parseEntries` (types.ts) keeps every entry that didn't. This never
 * throws, and one bad entry never affects its neighbours.
 *
 * A WHOLLY unparseable body throws `FeedParseError`, from exactly two
 * places: `parser.parse()` itself failing (the XML tokenizer gives up --
 * verified this happens for a body truncated mid-tag), or `detectFeed`
 * finding neither an `<rss><channel>` nor a `<feed>` at the root (the
 * tokenizer succeeded but produced something that isn't RSS or Atom at all
 * -- verified this is what happens for plain text, an HTML error page, or
 * an empty body: `fast-xml-parser` does not itself throw for any of these,
 * so the root-shape check below is load-bearing, not a formality). Either
 * throw propagates out of `fetch()` so the scheduler records a real failure.
 *
 * A well-formed feed with a `<channel>`/`<feed>` but zero items/entries is
 * NOT an error: it resolves with `items: []`, matching a genuinely quiet
 * publishing day rather than being conflated with a broken fetch.
 *
 * Recovering entries absorbed by an unclosed element. `fast-xml-parser` is a
 * lenient TOKENIZER, not a validating, self-healing parser. Content-level
 * malformations (unescaped `&`, stray control characters, a closing tag
 * with a mismatched namespace prefix) are all verified to recover cleanly,
 * every sibling entry intact -- no special handling needed. A genuinely
 * UNCLOSED element with no closing tag anywhere later in the document is a
 * different case: the tokenizer parses later siblings as DESCENDANTS of the
 * broken element instead of throwing or leaving them alone. Fix round 1
 * (task-6-report.md, Finding 2) closed this: a conformant `<item>`/`<entry>`
 * never contains a descendant of the same name, so finding one nested
 * anywhere inside an already-extracted entry is a zero-false-positive
 * signature of exactly this corruption -- `recoverAbsorbedEntries` below
 * detects it and re-parses the recovered siblings as their own entries, so
 * nothing is lost. A response truncated mid-tag (no well-formed content
 * following the break at all) is a distinct, more common case, and is still
 * caught the original way: the tokenizer itself throws for that.
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
 * Thrown when a response cannot be read as RSS 2.0 or Atom at all. See the
 * module doc comment above for exactly which conditions raise this versus
 * which are silently tolerated (a malformed entry) or silently accepted (a
 * well-formed, empty channel/feed).
 */
export class FeedParseError extends Error {
  constructor(url: string, reason: string, opts?: { cause?: unknown }) {
    super(`could not parse ${url} as RSS or Atom: ${reason}`, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'FeedParseError';
  }
}

// One parser instance, reused across every call: `XMLParser#parse` is
// synchronous and does not yield, so there is no cross-call interleaving
// hazard even though this is a shared module-level object in a
// single-threaded event loop.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // Text and attribute values are kept as plain strings, never coerced to
  // number/boolean -- extraction should never silently reinterpret a value
  // (a GUID of "000123" becoming the number 123, a title of "2026" becoming
  // a number) on its way out of the XML layer.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Decodes numeric character references (`&#8217;` -> the actual '’'
  // character) in addition to the 5 predefined XML entities, and tolerates
  // common HTML named entities (`&nbsp;`, `&mdash;`) that real-world feed
  // generators emit despite them not being valid bare XML. Verified: with
  // this off, `&#8217;` -- present in real fixture content -- passes
  // through as the literal 8-character text "&#8217;" instead of the
  // character it names. That is not "faithful extraction preserving the
  // source", it is an incomplete parse -- decoding a spec-defined character
  // reference is unambiguous, unlike date or URL interpretation, which
  // really is left to normalizeItem. Verified this does not weaken
  // tolerance of a bare unescaped "&" (still passed through literally, not
  // an error) or of an unrecognized entity name like "&madeupentity;"
  // (also passed through literally).
  htmlEntities: true,
  // Forces <item>/<entry> to always be an array, even when a channel/feed
  // has exactly one -- fast-xml-parser's default is to unwrap a
  // single-occurrence tag to a bare object, which would make the loop below
  // silently see just the one field it happens to share a name with.
  // Verified against a synthetic single-item document.
  isArray: (name) => name === 'item' || name === 'entry',
});

type XmlNode = Record<string, unknown>;

function isXmlNode(value: unknown): value is XmlNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts plain text from a fast-xml-parser leaf value, which is either a
 * bare string (the source tag had no attributes), or an object shaped
 * `{ "#text": string, "@_attr": ... }` (the tag had attributes AND text --
 * e.g. Atom's `<summary type="html">...`, or RSS's `<guid isPermaLink=...>`).
 * Returns `null` for anything else (absent, or an unexpected shape). Never
 * trims beyond what the parser's own `trimValues` already does, and never
 * reshapes the text further -- that is normalizeItem's job, not this
 * adapter's.
 */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isXmlNode(value) && typeof value['#text'] === 'string') return value['#text'];
  return null;
}

/** Blank after the XML layer's own whitespace trimming is the same as absent -- an empty `<title></title>` is not a title. */
function isBlank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

// ---------------------------------------------------------------------------
// RSS 2.0
// ---------------------------------------------------------------------------

function parseRssItem(item: unknown): RawItem | null {
  if (!isXmlNode(item)) return null;

  const url = textOf(item.link);
  const title = textOf(item.title);
  if (isBlank(url) || isBlank(title)) return null;

  // <description> is RSS's short-form synopsis field; <content:encoded> (the
  // Content module) is explicitly a full-article-HTML field on feeds that
  // use it at all (verified against the Krebs fixture, where it holds the
  // complete post body with images). Preferring description, and falling
  // back to content:encoded only when description is entirely absent, keeps
  // "summary" meaning an excerpt on every feed that provides one, while
  // still surfacing SOMETHING for a minimal feed that only populates the
  // full-content field. normalizeItem's 300-character cap applies to
  // whichever this resolves to either way. Precedence (not just fallback)
  // is mutation-tested: the Krebs/NPR fixtures have both fields on every
  // item with different content, and reversing this `??` breaks exactly
  // those two tests.
  const summary = textOf(item.description) ?? textOf(item['content:encoded']);

  // <dc:creator> (Dublin Core) is what both real fixtures that carry an
  // author (Krebs, NPR) actually use; RSS 2.0's own native <author> element
  // is rarely populated in practice and, per spec, holds an email address
  // rather than a display name. Preferring dc:creator, falling back to the
  // native element, covers both without guessing which a given feed means.
  // Precedence is mutation-tested via a fixture entry carrying both fields
  // with different values (fix round 1 follow-up -- the initial fallback
  // fixtures only ever had ONE of the two present, which cannot distinguish
  // "falls back correctly" from "prefers the wrong one when both exist").
  const author = textOf(item['dc:creator']) ?? textOf(item.author);

  return {
    url: url as string,
    title: title as string,
    // Passed through exactly as written -- RFC-822, ISO-8601, or anything
    // else a feed happens to use. Interpreting it is normalizeItem's job.
    publishedAt: textOf(item.pubDate),
    summary,
    author,
    // The full parsed entry, not just the fields RawItem surfaces -- nothing
    // is discarded (categories, guid, namespaced fields, content:encoded)
    // even though only some of it is extracted into typed fields above.
    raw: item,
  };
}

// ---------------------------------------------------------------------------
// Atom
// ---------------------------------------------------------------------------

/**
 * Atom's <link> can be a single element, several (different `rel`s), or
 * (rarely, and not strictly spec-conformant) missing its attributes
 * entirely. Resolves to the `rel="alternate"` one -- the article's own page,
 * which is what Atom calls the default when `rel` is omitted (RFC 4287
 * SS4.2.7.2) -- or `null` if no candidate is explicitly `alternate` or
 * rel-less.
 *
 * Fix round 1, Finding 5: this used to fall back to the first link
 * regardless of its `rel` (an entry whose only link was `rel="enclosure"`
 * or `rel="edit"` got that URL as its item URL). `canonical_url` feeds
 * `item_key`, which is permanent under append-only storage -- the same
 * reasoning that shaped every URL-canonicalization decision in this
 * milestone applies here: a knowingly-wrong URL can never be corrected once
 * written, so an entry with no genuine alternate link is dropped (returns
 * `null`, which `parseAtomEntry` below treats as "no usable link") rather
 * than guessed at.
 */
function extractAtomLink(value: unknown): string | null {
  if (typeof value === 'string') return isBlank(value) ? null : value;

  const candidates = Array.isArray(value) ? value.filter(isXmlNode) : isXmlNode(value) ? [value] : [];
  const alternate = candidates.find((l) => l['@_rel'] === undefined || l['@_rel'] === 'alternate');
  if (!alternate) return null;

  const href = alternate['@_href'];
  return typeof href === 'string' && !isBlank(href) ? href : null;
}

/** `<author><name>...</name></author>` -- entry-level or feed-level, same shape either way. Atom permits more than one; the first is used, matching `RawItem.author` being a single string. */
function extractAtomAuthorName(value: unknown): string | null {
  const author = Array.isArray(value) ? value[0] : value;
  return isXmlNode(author) ? textOf(author.name) : null;
}

function parseAtomEntry(entry: unknown, feedAuthor: string | null): RawItem | null {
  if (!isXmlNode(entry)) return null;

  const url = extractAtomLink(entry.link);
  const title = textOf(entry.title);
  if (isBlank(url) || isBlank(title)) return null;

  // <summary> is Atom's short-form field; <content> may legitimately hold
  // the complete entry body (RFC 4287 SS4.1.3). Same preference order as
  // RSS's description/content:encoded, for the same reason. Precedence is
  // mutation-tested via a fixture entry carrying both with different text.
  const summary = textOf(entry.summary) ?? textOf(entry.content);

  // <published> is the original publish time; <updated> is last-modified
  // and is REQUIRED on every Atom entry, so it is the one date field
  // guaranteed to exist if <published> is absent. Passed through untouched
  // either way. The live Simon Willison fixture has both fields on every
  // entry but always IDENTICAL, so it cannot prove precedence by itself;
  // a synthetic fixture entry with two DIFFERENT values does (fix round 1
  // follow-up, mutation-tested).
  const publishedAt = textOf(entry.published) ?? textOf(entry.updated);

  // An entry without its own <author> inherits the feed's, per RFC 4287
  // SS4.1.2 -- verified this is not a hypothetical: none of the 30 real
  // entries in the Simon Willison fixture carry a per-entry <author>, only
  // the feed does, so skipping this fallback would null out `author` on
  // every single item from that live source.
  const author = extractAtomAuthorName(entry.author) ?? feedAuthor;

  return {
    url: url as string,
    title: title as string,
    publishedAt,
    summary,
    author,
    raw: entry,
  };
}

// ---------------------------------------------------------------------------
// Top-level: detect format, extract the entry list, parse the body
// ---------------------------------------------------------------------------

interface DetectedFeed {
  entries: unknown[];
  parseOne: (raw: unknown) => RawItem | null;
}

function asEntryArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

/**
 * A conformant RSS `<item>` never contains a descendant `<item>`; a
 * conformant Atom `<entry>` never contains a descendant `<entry>`. Finding
 * one nested anywhere inside an already-extracted entry is therefore a
 * reliable, zero-false-positive signature that a genuinely unclosed element
 * elsewhere in the document (see the module doc comment's "recovering
 * absorbed entries" section) absorbed later siblings as descendants of this
 * entry, rather than leaving them as their own top-level siblings.
 * Recursively collects every such nested occurrence into `out` -- a chain of
 * several unclosed elements can absorb more than one extra layer, verified
 * against a synthetic three-item chain (see task-6-report.md fix round 1).
 */
function collectAbsorbedEntries(node: unknown, key: 'item' | 'entry', out: unknown[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectAbsorbedEntries(child, key, out);
    return;
  }
  if (!isXmlNode(node)) return;
  for (const [childKey, value] of Object.entries(node)) {
    if (childKey === key && Array.isArray(value)) {
      out.push(...value);
      // The absorbed entries themselves might have absorbed further
      // siblings in a longer chain -- keep looking inside what was just
      // recovered, not just the first level.
      for (const child of value) collectAbsorbedEntries(child, key, out);
    } else {
      collectAbsorbedEntries(value, key, out);
    }
  }
}

/**
 * Expands `entries` to include anything `collectAbsorbedEntries` finds
 * nested inside any of them, so a sibling absorbed by an earlier entry's
 * unclosed element is still parsed as its own entry rather than silently
 * lost (fix round 1, Finding 2 -- see task-6-report.md; the earlier version
 * of this module disclosed this as an unfixable known limitation, which was
 * wrong: fast-xml-parser's own `isArray` forcing already puts the absorbed
 * entries somewhere structurally addressable, this just has to go find
 * them). Returns the SAME array, no new allocation, when nothing was
 * absorbed -- a no-op on every well-formed feed, which is the overwhelming
 * common case.
 */
function recoverAbsorbedEntries(entries: unknown[], key: 'item' | 'entry'): unknown[] {
  const absorbed: unknown[] = [];
  for (const entry of entries) {
    if (!isXmlNode(entry)) continue;
    for (const value of Object.values(entry)) {
      collectAbsorbedEntries(value, key, absorbed);
    }
  }
  return absorbed.length === 0 ? entries : [...entries, ...absorbed];
}

function detectFeed(parsed: unknown, url: string): DetectedFeed {
  const root = isXmlNode(parsed) ? parsed : {};

  if (isXmlNode(root.rss)) {
    const channel = root.rss.channel;
    if (!isXmlNode(channel)) {
      throw new FeedParseError(url, '<rss> root has no <channel>');
    }
    return { entries: recoverAbsorbedEntries(asEntryArray(channel.item), 'item'), parseOne: parseRssItem };
  }

  if (isXmlNode(root.feed)) {
    const feedAuthor = extractAtomAuthorName(root.feed.author);
    return {
      entries: recoverAbsorbedEntries(asEntryArray(root.feed.entry), 'entry'),
      parseOne: (raw) => parseAtomEntry(raw, feedAuthor),
    };
  }

  throw new FeedParseError(
    url,
    'root element is neither <rss> nor <feed> -- not a recognizable RSS or Atom document',
  );
}

function parseFeedBody(body: string, url: string): ParseEntriesResult {
  let parsed: unknown;
  try {
    parsed = parser.parse(body);
  } catch (cause) {
    throw new FeedParseError(url, `XML could not be tokenized: ${(cause as Error).message}`, { cause });
  }

  const { entries, parseOne } = detectFeed(parsed, url);
  return parseEntries(entries, parseOne);
}

export const rssAdapter: Adapter = {
  // See the SourceType doc comment in types.ts: this same adapter also
  // handles Atom bodies, detected from the parsed root element rather than
  // from this value.
  type: 'rss',

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
      // an impossible state as an empty document.
      throw new FeedParseError(source.url, 'politeFetch returned a null body for a non-304 response');
    }

    const parsed = parseFeedBody(fetchResult.body, source.url);
    return fetchedResult(fetchResult, parsed);
  },
};

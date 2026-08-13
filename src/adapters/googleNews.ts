/**
 * Google News RSS adapter -- the only route by which this project reaches
 * Reuters content (Task 9 of the M1 ingest plan).
 *
 * ---------------------------------------------------------------------------
 * Why this adapter exists, and the one rule that governs everything in it
 * ---------------------------------------------------------------------------
 * Reuters' own robots.txt is an allowlist: it names roughly sixty permitted
 * crawlers and then closes with `User-agent: *` / `Disallow: /`. Watchfloor
 * is not on that list, so every path on reuters.com except `/plus/` is
 * forbidden to us -- and this project's standing rule is politeness over
 * completeness. We reach Reuters stories instead via Google News RSS scoped
 * to `site:reuters.com`, which is legitimate because Google IS allowlisted
 * by Reuters and publishes this feed openly, and because we never touch
 * reuters.com ourselves.
 *
 * THEREFORE: this module must never issue an HTTP request to reuters.com, or
 * to any publisher domain, under any circumstance -- including by letting a
 * redirect follow through. Google News item links
 * (news.google.com/rss/articles/<opaque token>) are stub redirects that only
 * resolve to the real publisher URL via a further HTTP hop. This adapter
 * never fetches one, for two independent reasons, either sufficient alone:
 *
 *   1. Resolving one would land a request on reuters.com (or whichever
 *      publisher), the exact domain this whole adapter exists to avoid --
 *      it would silently undo the only reason this route is defensible.
 *   2. A single poll of this feed returns on the order of 100 items, unlike
 *      every other adapter's single request per fetch(). Resolving each
 *      item's link individually would mean ~100 requests per poll cycle
 *      against Google -- indefensible on politeness grounds alone,
 *      independent of the robots.txt problem.
 *
 * The guarantee is structural, not merely a convention followed by
 * discipline: this module's only network call is the single delegated
 * `rssAdapter.fetch(source, state)` below, which itself calls
 * `politeFetch(source.url, ...)` exactly once against `source.url` -- the
 * configured Google News RSS endpoint. No code path in this file reads an
 * item's `link`/`guid`/`url` for the purpose of fetching it; those fields
 * (via `sourceNameOf`, on the ALREADY-fetched, already-in-memory response)
 * are only ever read to extract text, never to make a further request. See
 * tests/adapters/googleNews.test.ts's "the no-publisher-request guarantee"
 * describe block for an executable proof: a decoy server standing in for
 * the domain a resolved redirect would reach receives zero requests, and
 * the feed server itself receives exactly one request regardless of item
 * count.
 *
 * ---------------------------------------------------------------------------
 * Composing with rss.ts rather than duplicating it
 * ---------------------------------------------------------------------------
 * Google News RSS is standard RSS 2.0 (confirmed against a live capture --
 * see task-9-report.md): `<item>`, `<title>`, `<link>`, `<guid>`,
 * `<pubDate>`, `<description>`, plus RSS 2.0's own optional
 * `<source url="...">` sub-element (part of the RSS 2.0 spec itself; Google's
 * usage of it is standard, not a proprietary extension). Rather than
 * duplicating politeFetch wiring, 304 handling, the fast-xml-parser
 * configuration, the missing-link/title drop rule, unclosed-element entry
 * recovery, or the FeedParseError taxonomy, this adapter delegates the
 * entire fetch+parse to `rssAdapter.fetch` (one of the two things rss.ts
 * exports) and applies exactly two Google-News-specific transformations to
 * the resulting items: strip the publisher suffix from `title`, and never
 * surface `description` as `summary`. Every other RawItem field, and the
 * 304/throw/skipped-count behaviour, is inherited unchanged. rss.ts is never
 * modified -- only its exports are used, per this task's scope.
 *
 * This composition holds because `rssAdapter.fetch` reads only `source.url`
 * from its `Source` argument, never `source.type` -- passing a `Source`
 * whose `type` is `'google_news'` (not `'rss'`) works precisely because
 * rss.ts detects the wire format from the parsed document's root element,
 * not from config. If a future change to rss.ts ever started branching on
 * `source.type`, this composition would need revisiting; disclosed in
 * task-9-report.md as a coupling worth watching, not a hidden one.
 *
 * One small piece of duplication this boundary makes unavoidable:
 * `isXmlNode` below mirrors a type guard rss.ts also has privately (it is
 * not exported, and this task may not add an export to rss.ts) -- three
 * lines, needed to safely read the one field rss.ts's own RawItem shape
 * does not surface (`<source>`), not a reimplementation of any parsing
 * logic.
 *
 * ---------------------------------------------------------------------------
 * The URL decision: keep the Google News link, don't extract a publisher URL
 * ---------------------------------------------------------------------------
 * `RawItem.url` feeds `canonical_url`, which feeds `item_key`, which is
 * permanent under append-only storage. Investigating a live capture (see
 * task-9-report.md) found exactly one piece of publisher information in the
 * feed data: `<source url="https://www.reuters.com">Reuters</source>` --
 * present on all 100 real items sampled, always identical in shape. Its
 * `url` attribute is the publisher's SITE ROOT, not the specific article's
 * path -- there is no way to construct the real article URL from it. The
 * `<description>` field is not an alternative: it is always exactly
 * `<a href="{the same Google link}">{title}</a>&nbsp;&nbsp;<font>{source}</font>`,
 * carrying zero information beyond title+link+source (verified against
 * every one of the 100 sampled items, zero exceptions). The `<guid>` is the
 * same opaque token as the link, explicitly marked `isPermaLink="false"` --
 * Google's own admission that it isn't a stable article identifier either.
 *
 * With no reliable publisher URL extractable from feed data, and resolving
 * the link via a request forbidden outright (see above), this adapter keeps
 * the Google News link as `RawItem.url`, per the brief's own pre-authorized
 * fallback. It is stable, it resolves (just not to reuters.com directly),
 * and it is what we actually have permission to reference. The cost is that
 * cross-source dedupe will not match a Reuters story reached this way
 * against the same story from another source -- accepted, since Reuters
 * reaches this project through no other route, and a knowingly-wrong or
 * unstable URL would be worse: `item_key` can never be corrected later.
 */

import { rssAdapter } from './rss.ts';
import type { Source } from '../sources/load.ts';
import type { FetchState } from '../db/fetchState.ts';
import type { RawItem } from '../normalize/item.ts';
import type { Adapter, AdapterResult } from './types.ts';

type XmlNode = Record<string, unknown>;

function isXmlNode(value: unknown): value is XmlNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads RSS 2.0's optional `<source>` element's text content the way
 * rss.ts's fast-xml-parser configuration represents it on `RawItem.raw`:
 * either a bare string (no attributes) or `{ '#text': string, '@_url': ... }`
 * (the shape every real Google News item uses, since `<source>` always
 * carries a `url` attribute there). Returns `null` if absent, blank, or an
 * unexpected shape -- the same "never guess" posture as the rest of this
 * codebase: with no source name, there is nothing safe to strip against, so
 * the title is left exactly as extracted.
 */
function sourceNameOf(rawEntry: unknown): string | null {
  if (!isXmlNode(rawEntry)) return null;
  const source = rawEntry.source;
  if (typeof source === 'string') return source.trim() === '' ? null : source;
  if (isXmlNode(source) && typeof source['#text'] === 'string') {
    return source['#text'].trim() === '' ? null : source['#text'];
  }
  return null;
}

/**
 * Strips a trailing ` - <source>` suffix from `title`, where `<source>` is
 * the EXACT text of this entry's own `<source>` element -- never a generic
 * "cut at the last hyphen" heuristic, which would truncate any headline
 * that legitimately contains one (verified against the live fixture: 18 of
 * the first 100 real items do, e.g. "...Musk-inspired compensation plans
 * spread - Reuters"). Three cases deliberately do NOT strip, leaving
 * `title` exactly as extracted:
 *
 *   - no `<source>` element at all: no trusted name to strip against;
 *   - `<source>` present but `title` doesn't end with " - {name}": a
 *     mismatch, so stripping would cut something that isn't actually the
 *     suffix;
 *   - stripping would leave nothing but whitespace: never emit a blank
 *     title. In practice this is unreachable given rss.ts's
 *     `trimValues: true` (a trimmed title can never start with the leading
 *     space this suffix always has, so it can never be fully CONSUMED by
 *     stripping) -- kept anyway as cheap insurance, the same asymmetric-risk
 *     reasoning Task 6 applied to Atom's non-alternate-link case: a blank
 *     title feeding a permanent item_key is a far worse failure than one
 *     unstripped decorative suffix. Not exercised by a fixture test for
 *     that reason (it cannot be constructed through the real XML pathway);
 *     see task-9-report.md.
 *
 * None of this is "normalization" in the sense the adapter contract
 * forbids (no URL canonicalization, no date conversion, no truncation): it
 * is extraction of the real headline from a decorated one, the same
 * category of operation as decoding an HTML entity -- deciding which raw
 * bytes constitute the `title` field in the first place, not transforming
 * an already-decided value.
 */
function stripPublisherSuffix(title: string, rawEntry: unknown): string {
  const sourceName = sourceNameOf(rawEntry);
  if (sourceName === null) return title;

  const suffix = ` - ${sourceName}`;
  if (!title.endsWith(suffix)) return title;

  const stripped = title.slice(0, -suffix.length);
  if (stripped.trim() === '') return title;
  return stripped;
}

/**
 * Applies the two Google-News-specific transformations to an already-valid
 * RawItem produced by rss.ts's RSS 2.0 parsing: strip the publisher suffix
 * from `title`, and null out `summary`.
 *
 * `summary` is unconditionally null, never a passthrough of `<description>`:
 * investigation (task-9-report.md) found every one of 100 real items'
 * `<description>` to be exactly
 * `<a href="{this item's own Google link}">{title}</a>&nbsp;&nbsp;<font color="#6f6f6f">{source}</font>`
 * -- decorative HTML repeating information already on `title`/`url`/`raw`,
 * with double-HTML-escaped entities that would render as literal
 * "&nbsp;&nbsp;" text if ever shown. Surfacing that as `summary` would
 * fabricate a fake excerpt, not faithfully extract a real one. This is a
 * mapping decision (which raw field, if any, means "summary" for this
 * format) of exactly the kind rss.ts itself makes when it prefers
 * `<description>` over `<content:encoded>` -- not a forbidden
 * post-extraction transform of an already-decided value.
 *
 * Every other field (`url`, `publishedAt`, `author`, `raw`) is passed
 * through completely unchanged from what rss.ts already extracted.
 */
function toGoogleNewsItem(item: RawItem): RawItem {
  return {
    ...item,
    title: stripPublisherSuffix(item.title, item.raw),
    summary: null,
  };
}

export const googleNewsAdapter: Adapter = {
  type: 'google_news',

  async fetch(source: Source, state: FetchState | null): Promise<AdapterResult> {
    // The one and only network call this adapter ever makes: a single
    // request to source.url (the configured Google News RSS endpoint),
    // delegated to rss.ts's own politeFetch + RSS 2.0 parsing + 304 +
    // malformed-entry handling. See the module doc comment above for why
    // this composition is sound and why it is the whole of the
    // no-publisher-request guarantee.
    const result = await rssAdapter.fetch(source, state);

    if (result.notModified) return result;

    return { ...result, items: result.items.map(toGoogleNewsItem) };
  },
};

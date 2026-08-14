import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rssAdapter, FeedParseError } from '../../src/adapters/rss.ts';
import type { Source } from '../../src/sources/load.ts';
import type { FetchState } from '../../src/db/fetchState.ts';

// ---------------------------------------------------------------------------
// Test helpers -- same local-http-server pattern as tests/fetch/http.test.ts.
// No network in this file: every "live" scenario below is served from a
// checked-in fixture over a loopback ephemeral-port server, never the real
// internet.
// ---------------------------------------------------------------------------

type Handler = RequestListener;

function startServer(handler: Handler): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected an AddressInfo from an ephemeral TCP listener');
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

const openServers: Server[] = [];

/** Registers a server for automatic afterEach cleanup and returns its base URL. */
async function serve(handler: Handler): Promise<string> {
  const { server, baseUrl } = await startServer(handler);
  openServers.push(server);
  return baseUrl;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

/** Serves a fixed body/status/headers -- the common case of "one response, no assertions on the request". */
function serveBody(body: string, opts: { status?: number; headers?: Record<string, string> } = {}) {
  return serve((_req, res) => {
    res.writeHead(opts.status ?? 200, opts.headers ?? {});
    res.end(body);
  });
}

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', 'adapters', name), 'utf8');
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'test-source',
    name: 'Test Source',
    type: 'rss',
    url: 'https://example.test/feed',
    beats: ['ai'],
    weight: 1,
    poll_interval: '1h',
    enabled: true,
    enrichment: true,
    ...overrides,
  };
}

function makeState(overrides: Partial<FetchState> = {}): FetchState {
  return {
    sourceId: 'test-source',
    etag: null,
    lastModified: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    itemsYielded7d: 0,
    ...overrides,
  };
}

function raw(item: { raw: unknown }): Record<string, unknown> {
  return item.raw as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('rssAdapter', () => {
  it('declares its SourceType as "rss"', () => {
    expect(rssAdapter.type).toBe('rss');
  });

  describe('RSS 2.0 fixtures (real, captured live)', () => {
    it('parses Krebs on Security (WordPress-generated RSS 2.0)', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/rss+xml; charset=UTF-8',
          ETag: '"krebs-etag-1"',
          'Last-Modified': 'Tue, 11 Aug 2026 22:10:48 GMT',
        });
        res.end(fixture('krebsonsecurity-rss2.xml'));
      });

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.notModified).toBe(false);
      expect(result.etag).toBe('"krebs-etag-1"');
      expect(result.lastModified).toBe('Tue, 11 Aug 2026 22:10:48 GMT');
      expect(result.items).toHaveLength(10);

      const first = result.items[0]!;
      expect(first.url).toBe('https://krebsonsecurity.com/2026/08/microsoft-plugs-nearly-400-security-holes/');
      expect(first.title).toBe('Microsoft Plugs Nearly 400 Security Holes');
      // RFC-822 date passed through UNTOUCHED -- adapters extract, they do
      // not convert (that is normalizeItem's job).
      expect(first.publishedAt).toBe('Tue, 11 Aug 2026 21:28:35 +0000');
      expect(first.summary).toContain('Microsoft today released updates to remedy at least 398');
      // <description>, not <content:encoded> -- the latter carries the FULL
      // article HTML on this feed and must never be what "summary" means.
      expect(first.summary).not.toContain('<p>');
      expect(first.author).toBe('BrianKrebs'); // <dc:creator>, not a native <author>
      // Nothing is thrown away: the full raw entry (including fields RawItem
      // doesn't surface, like categories and content:encoded) survives on `raw`.
      expect(raw(first).title).toBe('Microsoft Plugs Nearly 400 Security Holes');
      expect(raw(first)['content:encoded']).toBeDefined();
    });

    it('parses NPR (a different RSS 2.0 generator), preferring <description> over <content:encoded>', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=UTF-8' });
        res.end(fixture('npr-rss2.xml'));
      });

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(10);
      const kennedyCenter = result.items.find((i) => i.url.includes('kennedy-center-shut-down'));
      expect(kennedyCenter).toBeDefined();
      expect(kennedyCenter!.title).toContain('Kennedy Center Board votes again');
      expect(kennedyCenter!.author).toBe('Anastasia Tsioulcas');
      expect(kennedyCenter!.publishedAt).toBe('Thu, 13 Aug 2026 14:55:30 -0400');
      // NPR's <description> is short prose; <content:encoded> on this feed
      // opens with a raw <img src='...'> tag -- proof the adapter picked
      // the right field rather than the one that happened to parse first.
      expect(kennedyCenter!.summary).not.toContain('<img');
      expect(kennedyCenter!.summary).toContain('main campus for a $250 million renovation');
    });

    it('parses arXiv cs.AI RSS despite its non-standard arxiv:/dc: namespacing', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=UTF-8' });
        res.end(fixture('arxiv-cs-ai-rss2.xml'));
      });

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(15);
      const first = result.items[0]!;
      expect(first.url).toBe('https://arxiv.org/abs/2608.11207');
      expect(first.title).toContain('Dynamic Governance of Multi-LLM Agent Systems');
      // Multi-author dc:creator is a single comma-joined string in the feed;
      // passed through verbatim, not split into a list -- splitting it would
      // be interpretation, which belongs to a later milestone, not here.
      expect(first.author).toBe('Alexander Liss, Nicholas Desmond, Santiago Gil Gallego');
      expect(first.publishedAt).toBe('Thu, 13 Aug 2026 00:00:00 -0400');
      expect(first.summary).toContain('Abstract:');
      // The namespaced fields we don't surface on RawItem are still preserved
      // faithfully on `raw`, for provenance.
      expect(raw(first)['arxiv:announce_type']).toBe('new');
      expect(raw(first)['dc:rights']).toBe('http://arxiv.org/licenses/nonexclusive-distrib/1.0/');
    });
  });

  describe('Atom fixture (real, captured live)', () => {
    it("parses Simon Willison's Atom feed, including feed-level author inheritance", async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
        res.end(fixture('simonwillison-atom.xml'));
      });

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed`, type: 'rss' }), null);

      expect(result.items).toHaveLength(30);
      const first = result.items[0]!;
      expect(first.url).toBe('https://simonwillison.net/2026/Aug/12/deepseek-v4-pro-0813/');
      expect(first.title).toBe('DeepSeek V4 Pro 0813 (on OpenRouter)');
      expect(first.publishedAt).toBe('2026-08-12T23:59:23+00:00');
      // HTML-escaped summary content is decoded to real markup, not left as
      // literal "&lt;p&gt;" text.
      expect(first.summary).toContain('<p>');
      expect(first.summary).not.toContain('&lt;');
      // None of the 30 real entries carry their own <author> -- every one
      // must fall back to the feed-level <author><name>.
      expect(first.author).toBe('Simon Willison');
      expect(result.items.every((i) => i.author === 'Simon Willison')).toBe(true);
    });
  });

  describe('malformed entries: skipped, never thrown, neighbours survive', () => {
    it('drops defective RSS items (no link, empty title, no title, blank link) while good ones and an unparseable-date item all survive', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(fixture('rss-malformed-entries.xml'));
      });

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      // 11 items in the fixture, 4 defective -> exactly 7 survive.
      expect(result.items).toHaveLength(7);
      // skipped reports the 4 defective ones -- distinct from "the feed
      // simply published nothing new" (fix round 1, Finding 3; see the
      // dedicated `AdapterResult.skipped` tests below for the case this
      // actually needed to distinguish).
      expect(result.skipped).toBe(4);
      const titles = result.items.map((i) => i.title).sort();
      expect(titles).toEqual(
        [
          'Good Item One',
          'Good Item Three',
          'Good Item Two',
          'Unparseable Date Survives',
          'Content Encoded Fallback',
          'Native Author Fallback',
          'Both Author Fields Present',
        ].sort(),
      );

      // A bad date does NOT cause a drop -- it survives with the raw string
      // passed through untouched, exactly as the feed wrote it.
      const badDate = result.items.find((i) => i.title === 'Unparseable Date Survives')!;
      expect(badDate.publishedAt).toBe('not a real date at all');

      // An item with no <pubDate> element at all is equally valid: null, not dropped.
      const noDate = result.items.find((i) => i.title === 'Good Item Three')!;
      expect(noDate.publishedAt).toBeNull();
    });

    it('resolves the content:encoded and native <author> RSS fallbacks when the short-form fields are absent (fix round 1, Finding 4)', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(fixture('rss-malformed-entries.xml'));
      });

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      // No <description> at all on this item -- summary must come from
      // <content:encoded> rather than staying null, proving the `??`
      // actually falls through rather than being dead code no test exercised.
      const contentFallback = result.items.find((i) => i.title === 'Content Encoded Fallback')!;
      expect(contentFallback.summary).toBe(
        'Full HTML content, no description element on this item at all.',
      );

      // No <dc:creator> at all on this item -- author must come from the
      // native RSS <author> element, verbatim (not reformatted).
      const authorFallback = result.items.find((i) => i.title === 'Native Author Fallback')!;
      expect(authorFallback.author).toBe('native@example.test (Native Author)');

      // BOTH fields present with different values -- dc:creator must be
      // PREFERRED, not merely used when it's the only one available.
      // Mutation-tested: swapping this `??`'s operand order breaks only
      // this one assertion, nothing else in the suite.
      const bothAuthor = result.items.find((i) => i.title === 'Both Author Fields Present')!;
      expect(bothAuthor.author).toBe('Preferred Creator');
    });

    it('drops defective Atom entries (no link, empty title, blank href) while good ones survive, resolving rel="alternate" among multiple links and entry-level author overriding the feed default', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
        res.end(fixture('atom-malformed-entries.xml'));
      });

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      // 13 entries in the fixture, 4 defective -> exactly 9 survive.
      expect(result.items).toHaveLength(9);
      expect(result.skipped).toBe(4);
      const titles = result.items.map((i) => i.title).sort();
      expect(titles).toEqual(
        [
          'Good Entry One',
          'Good Entry Three',
          'Good Entry With Multiple Links',
          'Good Entry With Own Author',
          'Unparseable Date Survives',
          'Updated Only Fallback',
          'Content Only Fallback',
          'Both Summary And Content Present',
          'Both Published And Updated Present',
        ].sort(),
      );

      const badDate = result.items.find((i) => i.title === 'Unparseable Date Survives')!;
      expect(badDate.publishedAt).toBe('not a real date at all');

      const noDate = result.items.find((i) => i.title === 'Good Entry Three')!;
      expect(noDate.publishedAt).toBeNull();

      // Two <link> elements (rel="replies" and rel="alternate") -- must
      // resolve to the alternate one specifically, not just the first.
      const multiLink = result.items.find((i) => i.title === 'Good Entry With Multiple Links')!;
      expect(multiLink.url).toBe('https://example.test/entries/good-multi-link');

      // Feed-level fallback vs. entry-level override, side by side.
      const inherited = result.items.find((i) => i.title === 'Good Entry One')!;
      expect(inherited.author).toBe('Feed-Level Author');
      const overridden = result.items.find((i) => i.title === 'Good Entry With Own Author')!;
      expect(overridden.author).toBe('Entry-Level Author');
    });

    it('resolves the <updated> and <content> Atom fallbacks when the short-form fields are absent (fix round 1, Finding 4)', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
        res.end(fixture('atom-malformed-entries.xml'));
      });

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      // No <published> at all on this entry -- publishedAt must come from
      // <updated> rather than staying null.
      const updatedFallback = result.items.find((i) => i.title === 'Updated Only Fallback')!;
      expect(updatedFallback.publishedAt).toBe('2026-08-10T00:00:00+00:00');

      // No <summary> at all on this entry -- summary must come from <content>.
      const contentFallback = result.items.find((i) => i.title === 'Content Only Fallback')!;
      expect(contentFallback.summary).toBe('Full content, no summary element on this entry at all.');

      // BOTH fields present with different text -- summary must be
      // PREFERRED, not merely used when it's the only one available.
      const bothSummary = result.items.find((i) => i.title === 'Both Summary And Content Present')!;
      expect(bothSummary.summary).toBe('Preferred summary text.');

      // BOTH date fields present with DIFFERENT values -- published must be
      // preferred. The live Simon Willison fixture has both fields on every
      // entry but always IDENTICAL, which cannot distinguish precedence;
      // this is the case that actually proves it.
      const bothDates = result.items.find((i) => i.title === 'Both Published And Updated Present')!;
      expect(bothDates.publishedAt).toBe('2026-08-01T00:00:00+00:00');
    });

    it('drops an Atom entry whose only link has a non-alternate rel, rather than resolving to a knowingly-wrong URL (fix round 1, Finding 5)', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
        res.end(fixture('atom-malformed-entries.xml'));
      });

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      // This entry's ONLY <link> is rel="enclosure" (a podcast-style
      // attachment) -- canonical_url feeds item_key, which is permanent
      // under append-only storage, so a URL with no alternate/rel-less
      // link to fall back to must drop the entry, not guess.
      expect(result.items.some((i) => i.title === 'Only Non-Alternate Link')).toBe(false);
    });
  });

  describe('AdapterResult.skipped (fix round 1, Finding 3)', () => {
    it('reports skipped: 0 alongside items: [] for a genuinely quiet, well-formed feed', async () => {
      const baseUrl = await serveBody(
        '<rss version="2.0"><channel><title>Empty</title><link>https://example.test</link><description>none today</description></channel></rss>',
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toEqual([]);
      expect(result.skipped).toBe(0);
    });

    it('distinguishes "nothing published" from "every entry was individually defective" -- both yield items: [], only skipped tells them apart', async () => {
      // Every one of these 3 items is missing its <link> -- a fetch that
      // genuinely succeeded (the channel parsed fine) but whose entries were
      // all unusable. Before this field existed, this state was
      // INDISTINGUISHABLE from the quiet-feed case above: both produced
      // `items: []`, and a scheduler calling recordSuccess(itemCount: 0)
      // would see no difference between a healthy quiet source and one
      // whose parsing had silently broken for every entry.
      const baseUrl = await serveBody(
        `<rss version="2.0"><channel><title>t</title>
<item><title>No Link One</title></item>
<item><title>No Link Two</title></item>
<item><title>No Link Three</title></item>
</channel></rss>`,
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toEqual([]);
      expect(result.skipped).toBe(3);
    });

    it('leaves skipped undefined on a notModified result -- nothing was parsed, so there is no count to report', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(304, { ETag: '"still-current"' });
        res.end();
      });

      const result = await rssAdapter.fetch(
        makeSource({ url: `${baseUrl}/feed` }),
        makeState({ etag: '"still-current"' }),
      );

      expect(result.notModified).toBe(true);
      expect(result.skipped).toBeUndefined();
    });
  });

  describe('parser robustness (content-level malformation fast-xml-parser is expected to tolerate)', () => {
    it('does not break on a channel with exactly one <item> (fast-xml-parser unwraps a single occurrence to a bare object unless forced to stay an array)', async () => {
      const baseUrl = await serveBody(
        '<rss version="2.0"><channel><title>t</title><item><title>Only One</title><link>https://example.test/only</link></item></channel></rss>',
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('Only One');
    });

    it('does not break on a feed with exactly one <entry>', async () => {
      const baseUrl = await serveBody(
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><entry><title>Only One</title><link href="https://example.test/only" rel="alternate"/></entry></feed>',
        { headers: { 'Content-Type': 'application/atom+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('Only One');
    });

    it('tolerates a bare unescaped "&" in text content instead of rejecting the whole feed', async () => {
      const baseUrl = await serveBody(
        '<rss version="2.0"><channel><item><title>Fish & Chips</title><link>https://example.test/a</link></item></channel></rss>',
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('Fish & Chips');
    });

    it('decodes numeric character references and common HTML named entities, not just the 5 predefined XML entities', async () => {
      const baseUrl = await serveBody(
        '<rss version="2.0"><channel><item><title>caf&#233; &amp; friends &mdash; &#x2764;</title><link>https://example.test/a</link></item></channel></rss>',
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items[0]!.title).toBe('café & friends — ❤');
    });

    it('recovers entries absorbed by a genuinely unclosed element instead of losing them (fix round 1, Finding 2)', async () => {
      // Deliberately pathological: <description> is opened in the first
      // item and never closed anywhere in the rest of the document (as
      // opposed to every other malformation tested above, which fast-xml-
      // parser -- verified -- tolerates cleanly without corrupting sibling
      // parsing at all). This is fundamentally different from "a whole feed
      // is truncated" (the tokenizer throws on that, proven by the
      // empty/plain-text/HTML cases above): here, well-formed content
      // genuinely continues afterward, and the lenient tokenizer's recovery
      // parses "Good Two" as a descendant of "Broken One"'s unclosed
      // <description> rather than as its own sibling <item>.
      //
      // A conformant <item> never contains a descendant <item> (same for
      // Atom's <entry>) -- that is a zero-false-positive signature this
      // adapter now detects and recovers from: "Good Two" is lifted back out
      // and parsed as its own entry, so both survive. Verified this is a
      // true recovery, not a coincidence, against a THREE-item chain too
      // (below) -- multiple absorbed siblings all come back, not just one.
      const baseUrl = await serveBody(
        `<rss version="2.0"><channel><title>t</title>
<item><title>Broken One</title><link>https://example.test/broken</link><description>oops no closing tag
<item><title>Good Two</title><link>https://example.test/good-two</link><description>fine</description></item>
</channel></rss>`,
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(2);
      const titles = result.items.map((i) => i.title).sort();
      expect(titles).toEqual(['Broken One', 'Good Two']);
      // "Broken One" itself is still a valid item (usable link and title) --
      // its <description> is genuinely truncated content, exactly the
      // "truncated element" case named in the original brief, not itself a
      // reason to drop the entry.
      const brokenOne = result.items.find((i) => i.title === 'Broken One')!;
      expect(brokenOne.summary).toBe('oops no closing tag');
      const goodTwo = result.items.find((i) => i.title === 'Good Two')!;
      expect(goodTwo.url).toBe('https://example.test/good-two');
      expect(goodTwo.summary).toBe('fine');
    });

    it('recovers a CHAIN of multiple entries absorbed by the same unclosed element', async () => {
      const baseUrl = await serveBody(
        `<rss version="2.0"><channel><title>t</title>
<item><title>Broken One</title><link>https://example.test/broken</link><description>oops no closing tag
<item><title>Good Two</title><link>https://example.test/good-two</link><description>fine</description></item>
<item><title>Good Three</title><link>https://example.test/good-three</link><description>fine too</description></item>
</channel></rss>`,
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(3);
      expect(result.items.map((i) => i.title).sort()).toEqual(['Broken One', 'Good Three', 'Good Two']);
    });

    it('recovers an Atom entry absorbed by an unclosed <summary>, the same way', async () => {
      const baseUrl = await serveBody(
        `<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
<entry><title>Broken One</title><link href="https://example.test/broken" rel="alternate"/><summary>oops no closing tag
<entry><title>Good Two</title><link href="https://example.test/good-two" rel="alternate"/><summary>fine</summary></entry>
</feed>`,
        { headers: { 'Content-Type': 'application/atom+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(2);
      expect(result.items.map((i) => i.title).sort()).toEqual(['Broken One', 'Good Two']);
    });

    it('does not change well-formed feeds at all (no false positives from entry recovery)', async () => {
      // Every one of the four real, live fixtures already proves this
      // (their item/entry counts are asserted exactly elsewhere in this
      // file) -- this is the minimal, direct version: a normal two-item
      // feed with no nesting anywhere must come through unchanged.
      const baseUrl = await serveBody(
        '<rss version="2.0"><channel><item><title>A</title><link>https://example.test/a</link></item><item><title>B</title><link>https://example.test/b</link></item></channel></rss>',
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(2);
      expect(result.items.map((i) => i.title)).toEqual(['A', 'B']);
    });
  });

  describe('wholly unparseable bodies: thrown, not skipped', () => {
    it('throws FeedParseError for a plain-text, non-XML body', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable\nplease try again later\n');
      });

      await expect(rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null)).rejects.toThrow(
        FeedParseError,
      );
    });

    it('throws FeedParseError for an HTML error page served with a 200 status', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>');
      });

      await expect(rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null)).rejects.toThrow(
        FeedParseError,
      );
    });

    it('throws FeedParseError for an empty body', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('');
      });

      await expect(rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null)).rejects.toThrow(
        FeedParseError,
      );
    });

    it('throws FeedParseError when <rss> has no <channel> at all', async () => {
      const baseUrl = await serveBody('<rss version="2.0"></rss>', {
        headers: { 'Content-Type': 'application/rss+xml' },
      });

      await expect(rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null)).rejects.toThrow(
        FeedParseError,
      );
    });

    it('does NOT throw for a well-formed but empty channel -- zero items is a valid, successful result', async () => {
      const baseUrl = await serveBody(
        '<rss version="2.0"><channel><title>Empty</title><link>https://example.test</link><description>none today</description></channel></rss>',
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.notModified).toBe(false);
      expect(result.items).toEqual([]);
    });

    it('does NOT throw for a well-formed Atom feed with zero entries', async () => {
      const baseUrl = await serveBody(
        '<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title><id>urn:x</id><updated>2026-08-12T00:00:00Z</updated></feed>',
        { headers: { 'Content-Type': 'application/atom+xml' } },
      );

      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(result.notModified).toBe(false);
      expect(result.items).toEqual([]);
    });
  });

  describe('conditional requests and 304 handling', () => {
    it('sends If-None-Match / If-Modified-Since derived from FetchState', async () => {
      let received: Record<string, string | string[] | undefined> = {};
      const baseUrl = await serve((req, res) => {
        received = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end('<rss version="2.0"><channel><title>t</title></channel></rss>');
      });

      await rssAdapter.fetch(
        makeSource({ url: `${baseUrl}/feed` }),
        makeState({ etag: '"prior-etag"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' }),
      );

      expect(received['if-none-match']).toBe('"prior-etag"');
      expect(received['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    });

    it('sends no conditional headers when state is null', async () => {
      let received: Record<string, string | string[] | undefined> = {};
      const baseUrl = await serve((req, res) => {
        received = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end('<rss version="2.0"><channel><title>t</title></channel></rss>');
      });

      await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), null);

      expect(received['if-none-match']).toBeUndefined();
      expect(received['if-modified-since']).toBeUndefined();
    });

    it('returns notModified: true with no items on a 304, without attempting to parse anything', async () => {
      const baseUrl = await serve((_req, res) => {
        // A real 304 never carries a body, but if this adapter's 304 path
        // ever accidentally tried to parse one, garbage here would make
        // that failure obvious rather than silently passing.
        res.writeHead(304, { ETag: '"still-current"' });
        res.end();
      });

      const result = await rssAdapter.fetch(
        makeSource({ url: `${baseUrl}/feed` }),
        makeState({ etag: '"still-current"' }),
      );

      expect(result.notModified).toBe(true);
      expect(result.items).toEqual([]);
      expect(result.etag).toBe('"still-current"');
    });

    it('carries the prior etag/lastModified forward when a 304 response omits fresh validators', async () => {
      const baseUrl = await serve((_req, res) => {
        // No ETag/Last-Modified on this 304 -- permitted by HTTP, though
        // RFC 7232 SS4.1 says a compliant origin should include them.
        res.writeHead(304, {});
        res.end();
      });

      const priorState = makeState({ etag: '"prior-etag"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' });
      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), priorState);

      expect(result.notModified).toBe(true);
      expect(result.items).toEqual([]);
      expect(result.etag).toBe('"prior-etag"');
      expect(result.lastModified).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    });

    it('prefers the fresh etag from a 304 response over prior state when both are present', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(304, { ETag: '"fresher-etag"' });
        res.end();
      });

      const priorState = makeState({ etag: '"stale-etag"' });
      const result = await rssAdapter.fetch(makeSource({ url: `${baseUrl}/feed` }), priorState);

      expect(result.etag).toBe('"fresher-etag"');
    });
  });
});

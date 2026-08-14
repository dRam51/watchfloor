import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { googleNewsAdapter } from '../../src/adapters/googleNews.ts';
import { FeedParseError } from '../../src/adapters/rss.ts';
import type { Source } from '../../src/sources/load.ts';
import type { FetchState } from '../../src/db/fetchState.ts';

// ---------------------------------------------------------------------------
// Test helpers -- same local-http-server pattern as tests/adapters/rss.test.ts
// and tests/fetch/http.test.ts (this codebase has no shared test-utils module;
// each adapter test file keeps its own small copy). No network in this file:
// every scenario below is served from a checked-in fixture, or an inline
// body, over a loopback ephemeral-port server -- never the real internet.
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

function fixturePath(name: string): string {
  return join(import.meta.dirname, '..', 'fixtures', 'adapters', name);
}

function fixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

/**
 * Independently recovers the Nth real article `<link>` straight from the
 * fixture's own raw text via regex, deliberately NOT by going through
 * fast-xml-parser (the same library the adapter under test uses) or by
 * hand-transcribing a ~300-character opaque token into this file (error
 * prone, and a typo there would make the test fail for the wrong reason).
 * This is what lets the real-fixture test assert the emitted `url` is
 * BYTE-IDENTICAL to what the feed actually said, via a genuinely different
 * code path than the adapter's own parsing.
 */
function nthArticleLink(xml: string, n: number): string {
  const links = [...xml.matchAll(/<link>(.*?)<\/link>/gs)]
    .map((m) => m[1]!)
    // The channel's own <link> matches the same tag name but is a
    // https://news.google.com/search?... URL, never an article stub --
    // excluded so index n means "the nth ITEM link", not "the nth <link>
    // element including the channel's".
    .filter((l) => l.includes('/rss/articles/'));
  const link = links[n];
  if (link === undefined) throw new Error(`fixture has no article link at index ${n}`);
  return link;
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'reuters-gnews',
    name: 'Reuters (via Google News)',
    type: 'google_news',
    url: 'https://news.google.com/rss/search?q=site:reuters.com+when:1d&hl=en-US&gl=US&ceid=US:en',
    beats: ['usnews'],
    weight: 1,
    poll_interval: '1h',
    enabled: true,
    enrichment: true,
    ...overrides,
  };
}

function makeState(overrides: Partial<FetchState> = {}): FetchState {
  return {
    sourceId: 'reuters-gnews',
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

describe('googleNewsAdapter', () => {
  it('declares its SourceType as "google_news"', () => {
    expect(googleNewsAdapter.type).toBe('google_news');
  });

  describe('real fixture (captured live, site:reuters.com when:1d, trimmed to 20 items)', () => {
    it('parses items, stripping the " - Reuters" suffix from the title, keeping the raw Google News link as url untouched, and never surfacing description as summary', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/rss+xml; charset=UTF-8',
          ETag: '"gnews-etag-1"',
        });
        res.end(fixture('googlenews-reuters-rss2.xml'));
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      expect(result.notModified).toBe(false);
      expect(result.items).toHaveLength(20);
      expect(result.skipped).toBe(0);

      const first = result.items[0]!;
      // Suffix stripped -- the raw title was "...building - Reuters".
      expect(first.title).toBe("Kennedy Center board votes to inscribe Trump's name on building");
      // The URL is the exact, unresolved Google News redirect stub --
      // proven byte-identical to the fixture's own <link> text via an
      // independent regex extraction, not a hand-transcribed literal and
      // not merely "looks like a google.com URL".
      expect(first.url).toBe(nthArticleLink(fixture('googlenews-reuters-rss2.xml'), 0));
      expect(first.url.startsWith('https://news.google.com/rss/articles/')).toBe(true);
      // RFC-822 date passed through UNTOUCHED -- interpreting it is
      // normalizeItem's job, not this adapter's.
      expect(first.publishedAt).toBe('Thu, 13 Aug 2026 19:56:18 GMT');
      // <description> on every Google News item is self-referential
      // boilerplate (a link back to the same stub, plus the source name in
      // a <font> tag) -- never a real excerpt, so it is never surfaced as
      // `summary` by this adapter (see the malformed-fixture test below for
      // proof this holds even when description carries unusual content).
      expect(first.summary).toBeNull();
      // Google News RSS items never carry dc:creator or a native <author>.
      expect(first.author).toBeNull();
      // Nothing is discarded: the full raw entry, including the <source>
      // element this adapter reads to know what to strip, survives on `raw`
      // for provenance, exactly as rss.ts's own parseRssItem guarantees.
      expect(raw(first).source).toEqual({ '#text': 'Reuters', '@_url': 'https://www.reuters.com' });
      expect(raw(first).title).toBe("Kennedy Center board votes to inscribe Trump's name on building - Reuters");
    });

    it('strips the publisher suffix without truncating a headline that legitimately contains internal hyphens', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=UTF-8' });
        res.end(fixture('googlenews-reuters-rss2.xml'));
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      // Real headlines from the live capture, each with an internal hyphen
      // immediately before the " - Reuters" suffix is stripped -- a naive
      // "cut at the last hyphen" implementation would truncate every one of
      // these to something like "...record as Musk", which is exactly the
      // failure mode the task brief warns about.
      const muskItem = result.items.find((i) => i.title.includes('Musk-inspired'));
      expect(muskItem?.title).toBe(
        'EXCLUSIVE: S&P 500 CEO pay jumps to record as Musk-inspired compensation plans spread',
      );

      const polandItem = result.items.find((i) => i.title.includes('Ukrainian-American'));
      expect(polandItem?.title).toBe('Poland says it arrested Russian hired to kill Ukrainian-American citizen');

      const sandiskItem = result.items.find((i) => i.title.includes('mid-to-high-teens'));
      expect(sandiskItem?.title).toBe('Sandisk forecasts mid-to-high-teens revenue growth through 2030');

      // None of these retained the trailing " - Reuters".
      for (const item of [muskItem, polandItem, sandiskItem]) {
        expect(item?.title.endsWith('Reuters')).toBe(false);
      }
    });

    it('propagates etag/lastModified from the response headers', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/rss+xml',
          ETag: '"gnews-etag-2"',
          'Last-Modified': 'Thu, 13 Aug 2026 21:20:06 GMT',
        });
        res.end(fixture('googlenews-reuters-rss2.xml'));
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      expect(result.etag).toBe('"gnews-etag-2"');
      expect(result.lastModified).toBe('Thu, 13 Aug 2026 21:20:06 GMT');
    });
  });

  describe('the no-publisher-request guarantee', () => {
    it('never follows or resolves an item link -- the URL emitted is the unresolved Google stub, and the domain it would redirect to is never contacted', async () => {
      // Stands in for "the publisher domain a resolved redirect would
      // reach" (reuters.com in production). If this adapter ever resolved
      // an item's link -- via a HEAD request, a GET, or by letting a
      // redirect follow through -- this server would see a hit.
      let decoyHits = 0;
      const decoyBaseUrl = await serve((_req, res) => {
        decoyHits++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>should never be reached</html>');
      });

      // A minimal, well-formed Google-News-shaped item whose link happens
      // to point at the decoy server -- in production this would be
      // news.google.com/rss/articles/<opaque token>, but the shape doesn't
      // matter here, only that the adapter never dereferences it.
      const itemLink = `${decoyBaseUrl}/rss/articles/FAKE_TOKEN?oc=5`;
      const feedBody = `<rss version="2.0"><channel><title>t</title><item><title>Some Headline - Reuters</title><link>${itemLink}</link><guid isPermaLink="false">FAKE_TOKEN</guid><pubDate>Thu, 13 Aug 2026 19:56:18 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item></channel></rss>`;
      const feedBaseUrl = await serveBody(feedBody, { headers: { 'Content-Type': 'application/rss+xml' } });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${feedBaseUrl}/rss/search` }), null);

      expect(result.items).toHaveLength(1);
      // The emitted URL is the raw stub, verbatim -- not resolved to
      // anything else.
      expect(result.items[0]!.url).toBe(itemLink);
      // And the domain a resolved redirect would have reached was NEVER
      // contacted. This is the executable proof behind this task's central
      // constraint.
      expect(decoyHits).toBe(0);
    });

    it('issues exactly one HTTP request per fetch(), regardless of how many items the feed contains -- never one request per item', async () => {
      let feedHits = 0;
      const baseUrl = await serve((_req, res) => {
        feedHits++;
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(fixture('googlenews-reuters-rss2.xml')); // 20 items
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      expect(result.items.length).toBeGreaterThan(1);
      expect(feedHits).toBe(1);
    });
  });

  describe('malformed entries: skipped, never thrown, neighbours survive (synthetic fixture)', () => {
    it('drops entries with no usable link or title -- same base rule the underlying RSS parser enforces -- while good and edge-case items survive, and skipped counts exactly the dropped ones', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(fixture('googlenews-malformed-entries.xml'));
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      // 12 items in the fixture; 4 defective (missing link, empty title, no
      // title element, whitespace-only link) -> exactly 8 survive.
      expect(result.items).toHaveLength(8);
      expect(result.skipped).toBe(4);

      const titles = result.items.map((i) => i.title).sort();
      expect(titles).toEqual(
        [
          'Good Item One',
          'Markets brace for wide-ranging tariff changes next quarter',
          'Unparseable Date Survives',
          'No Date At All Survives',
          'Missing Source Element - Mystery Publisher',
          'Source Present But Title Does Not Match It',
          'Description With Unexpected Content',
          'Good Item Two',
        ].sort(),
      );
    });

    it('keeps the title fully UNSTRIPPED when no <source> element is present -- no trusted publisher name to strip against, never guessed', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(fixture('googlenews-malformed-entries.xml'));
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      const noSource = result.items.find((i) => i.title.startsWith('Missing Source Element'))!;
      expect(noSource.title).toBe('Missing Source Element - Mystery Publisher');
    });

    it('keeps the title fully UNSTRIPPED when <source> is present but the title does not actually end with its suffix', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(fixture('googlenews-malformed-entries.xml'));
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      const mismatch = result.items.find((i) => i.title.startsWith('Source Present But'))!;
      expect(mismatch.title).toBe('Source Present But Title Does Not Match It');
    });

    it('strips the suffix using a bare <source> element with no url attribute -- RSS 2.0 permits <source> without one, even though Google always includes it', async () => {
      const baseUrl = await serveBody(
        '<rss version="2.0"><channel><title>t</title><item><title>Bare Source Element - Wire Service</title><link>https://news.google.com/rss/articles/BARESOURCE?oc=5</link><source>Wire Service</source></item></channel></rss>',
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('Bare Source Element');
    });

    it('never surfaces <description> as summary, even when it carries unusual, non-boilerplate content', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(fixture('googlenews-malformed-entries.xml'));
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      const item = result.items.find((i) => i.title.startsWith('Description With Unexpected Content'))!;
      expect(item.summary).toBeNull();
    });

    it('passes an unparseable pubDate through verbatim, and a missing pubDate through as null -- neither drops the entry', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(fixture('googlenews-malformed-entries.xml'));
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      const badDate = result.items.find((i) => i.title.startsWith('Unparseable Date Survives'))!;
      expect(badDate.publishedAt).toBe('not a real date at all');

      const noDate = result.items.find((i) => i.title.startsWith('No Date At All Survives'))!;
      expect(noDate.publishedAt).toBeNull();
    });

    it('strips the suffix correctly on the good items interleaved among the defective ones', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
        res.end(fixture('googlenews-malformed-entries.xml'));
      });

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      const hyphenItem = result.items.find((i) => i.title.includes('wide-ranging'))!;
      expect(hyphenItem.title).toBe('Markets brace for wide-ranging tariff changes next quarter');

      const goodTwo = result.items.find((i) => i.title === 'Good Item Two')!;
      expect(goodTwo.url).toBe('https://news.google.com/rss/articles/GOODTWO?oc=5');
    });
  });

  describe('AdapterResult.skipped', () => {
    it('reports skipped: 0 alongside items: [] for a genuinely quiet feed -- a when:1d query legitimately returns nothing on a slow news day, and that is success, not failure', async () => {
      const baseUrl = await serveBody(
        '<rss version="2.0"><channel><title>"site:reuters.com when:1d" - Google News</title><link>https://news.google.com/search?q=site:reuters.com</link><description>Google News</description></channel></rss>',
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

      expect(result.notModified).toBe(false);
      expect(result.items).toEqual([]);
      expect(result.skipped).toBe(0);
    });

    it('leaves skipped undefined on a notModified result -- nothing was parsed, so there is no count to report', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(304, { ETag: '"still-current"' });
        res.end();
      });

      const result = await googleNewsAdapter.fetch(
        makeSource({ url: `${baseUrl}/rss/search` }),
        makeState({ etag: '"still-current"' }),
      );

      expect(result.notModified).toBe(true);
      expect(result.skipped).toBeUndefined();
    });
  });

  describe('wholly unparseable bodies: thrown, not skipped', () => {
    it('throws FeedParseError for a plain-text, non-XML body, so the scheduler records a real failure', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable\nplease try again later\n');
      });

      await expect(
        googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null),
      ).rejects.toThrow(FeedParseError);
    });

    it('throws FeedParseError for an HTML error page served with a 200 status', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>');
      });

      await expect(
        googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null),
      ).rejects.toThrow(FeedParseError);
    });

    it('does NOT throw for a well-formed but empty channel -- zero items is a valid, successful result', async () => {
      const baseUrl = await serveBody(
        '<rss version="2.0"><channel><title>Empty</title><link>https://news.google.com/search?q=x</link><description>none today</description></channel></rss>',
        { headers: { 'Content-Type': 'application/rss+xml' } },
      );

      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), null);

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

      await googleNewsAdapter.fetch(
        makeSource({ url: `${baseUrl}/rss/search` }),
        makeState({ etag: '"prior-etag"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' }),
      );

      expect(received['if-none-match']).toBe('"prior-etag"');
      expect(received['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    });

    it('returns notModified: true with no items on a 304, without attempting to parse anything', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(304, { ETag: '"still-current"' });
        res.end();
      });

      const result = await googleNewsAdapter.fetch(
        makeSource({ url: `${baseUrl}/rss/search` }),
        makeState({ etag: '"still-current"' }),
      );

      expect(result.notModified).toBe(true);
      expect(result.items).toEqual([]);
      expect(result.etag).toBe('"still-current"');
    });

    it('carries the prior etag/lastModified forward when a 304 response omits fresh validators', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(304, {});
        res.end();
      });

      const priorState = makeState({ etag: '"prior-etag"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' });
      const result = await googleNewsAdapter.fetch(makeSource({ url: `${baseUrl}/rss/search` }), priorState);

      expect(result.notModified).toBe(true);
      expect(result.etag).toBe('"prior-etag"');
      expect(result.lastModified).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    });
  });
});

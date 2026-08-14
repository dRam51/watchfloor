import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newsSitemapAdapter, NewsSitemapParseError, MAX_ITEMS_PER_FETCH } from '../../src/adapters/newsSitemap.ts';
import type { Source } from '../../src/sources/load.ts';
import type { FetchState } from '../../src/db/fetchState.ts';

// ---------------------------------------------------------------------------
// Test helpers -- same local-http-server pattern as tests/adapters/rss.test.ts
// and tests/fetch/http.test.ts. No network in this file: every "live"
// scenario below is served from a checked-in fixture (or an inline literal)
// over a loopback ephemeral-port server, never the real internet.
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
    id: 'ap-news',
    name: 'AP News Sitemap',
    type: 'news_sitemap',
    url: 'https://example.test/news-sitemap-content.xml',
    beats: ['usnews'],
    weight: 1,
    poll_interval: '30m',
    enabled: true,
    enrichment: true,
    ...overrides,
  };
}

function makeState(overrides: Partial<FetchState> = {}): FetchState {
  return {
    sourceId: 'ap-news',
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

/**
 * Builds a synthetic (not a checked-in fixture) news sitemap body with `n`
 * entries, each individually well-formed (usable loc + title), and each with
 * a DISTINCT, strictly descending publication_date: entry 0 is the most
 * recent, entry n-1 the oldest, one day apart. Used only by the item-cap
 * tests below, where what matters is having deterministically-known recency
 * order across more entries than MAX_ITEMS_PER_FETCH, not real content --
 * generating this inline (same idiom rss.test.ts uses for its synthetic
 * "quiet feed" / "single item" / malformed bodies) avoids checking in a
 * fixture file sized only to exceed a cap constant.
 */
function makeManyEntriesBody(n: number): string {
  const base = Date.UTC(2026, 7, 13, 0, 0, 0); // 2026-08-13T00:00:00Z
  const entries = Array.from({ length: n }, (_, i) => {
    const date = new Date(base - i * 24 * 60 * 60 * 1000).toISOString();
    return `<url>
      <loc>https://example.test/article/entry-${i}</loc>
      <news:news>
        <news:publication><news:name>Associated Press</news:name></news:publication>
        <news:publication_date>${date}</news:publication_date>
        <news:title>Entry ${i}</news:title>
      </news:news>
    </url>`;
  }).join('\n');
  return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    ${entries}
  </urlset>`;
}

/**
 * Builds a synthetic sitemap body for cap-ranking tests that mix well-dated
 * entries with ones the cap cannot confidently rank at all: no
 * <news:publication_date> element, an empty one, and a malformed one. Each
 * of `datedCount` well-dated entries ("Dated 0".."Dated datedCount-1") gets
 * a distinct, strictly descending date one day apart, same as
 * makeManyEntriesBody -- entry 0 most recent.
 *
 * The three undated/malformed entries are SPLICED IN NEAR THE FRONT of the
 * resulting document (low file-order index, among the otherwise-most-recent
 * entries) rather than appended at the end. That placement is deliberate:
 * fix round 1, Finding 1 asked specifically for a test proving recencyRank
 * ranks an unparseable/missing date LAST, not merely that the cap trims
 * *something*. Seeding them at the front means a regression that fell back
 * to file order, or that flipped recencyRank's sign so unranked entries
 * looked most-recent, would make THESE entries survive and cut real
 * well-dated articles instead -- exactly the silent, undetected-by-length-
 * alone failure mode the finding described.
 */
function makeMixedCapBody(datedCount: number): string {
  const base = Date.UTC(2026, 7, 13, 0, 0, 0); // 2026-08-13T00:00:00Z
  const dated = Array.from({ length: datedCount }, (_, i) => {
    const date = new Date(base - i * 24 * 60 * 60 * 1000).toISOString();
    return `<url>
      <loc>https://example.test/article/dated-${i}</loc>
      <news:news>
        <news:publication><news:name>Associated Press</news:name></news:publication>
        <news:publication_date>${date}</news:publication_date>
        <news:title>Dated ${i}</news:title>
      </news:news>
    </url>`;
  });

  const undated = [
    // No <news:publication_date> element at all.
    `<url>
      <loc>https://example.test/article/undated-missing</loc>
      <news:news>
        <news:publication><news:name>Associated Press</news:name></news:publication>
        <news:title>Undated Missing</news:title>
      </news:news>
    </url>`,
    // <news:publication_date> present but empty.
    `<url>
      <loc>https://example.test/article/undated-empty</loc>
      <news:news>
        <news:publication><news:name>Associated Press</news:name></news:publication>
        <news:publication_date></news:publication_date>
        <news:title>Undated Empty</news:title>
      </news:news>
    </url>`,
    // <news:publication_date> present but not a real date.
    `<url>
      <loc>https://example.test/article/undated-malformed</loc>
      <news:news>
        <news:publication><news:name>Associated Press</news:name></news:publication>
        <news:publication_date>not a real date at all</news:publication_date>
        <news:title>Undated Malformed</news:title>
      </news:news>
    </url>`,
  ];

  const entries = dated.slice();
  entries.splice(5, 0, undated[0]!);
  entries.splice(9, 0, undated[1]!);
  entries.splice(13, 0, undated[2]!);

  return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    ${entries.join('\n')}
  </urlset>`;
}

// ---------------------------------------------------------------------------

describe('newsSitemapAdapter', () => {
  it('declares its SourceType as "news_sitemap"', () => {
    expect(newsSitemapAdapter.type).toBe('news_sitemap');
  });

  describe('real AP fixture (real, captured live, trimmed -- see the fixture file header for provenance)', () => {
    it('parses the trimmed live AP sitemap with correct field extraction', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/xml; charset=UTF-8',
          ETag: '"ap-etag-1"',
          'Last-Modified': 'Thu, 13 Aug 2026 21:20:16 GMT',
        });
        res.end(fixture('apnews-news-sitemap.xml'));
      });

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.notModified).toBe(false);
      expect(result.etag).toBe('"ap-etag-1"');
      expect(result.lastModified).toBe('Thu, 13 Aug 2026 21:20:16 GMT');
      // The fixture has 55 entries, none defective, and 55 < MAX_ITEMS_PER_FETCH
      // -- the cap must not trim a batch already under the limit.
      expect(result.items).toHaveLength(55);
      expect(result.skipped).toBe(0);

      const first = result.items[0]!;
      expect(first.url).toBe('https://apnews.com/live/trump-news-midterms-primaries-updates-08-12-2026');
      expect(first.title).toBe("White House press secretary Karoline Leavitt will leave at month's end");
      // Passed through UNTOUCHED -- adapters extract, they do not convert
      // (that is normalizeItem's job). Note the -04:00 offset survives as
      // literal text, not converted to Z.
      expect(first.publishedAt).toBe('2026-08-12T06:52:39-04:00');
      // This schema has no description/summary/body field at all -- must
      // not be synthesised to fill the gap.
      expect(first.summary).toBeNull();
      expect(first.author).toBeNull();
      // Nothing is thrown away: the full raw <url> node -- including
      // <lastmod>, which RawItem does not surface as a typed field --
      // survives on `raw`, same discipline as rss.ts.
      expect(raw(first)['lastmod']).toBe('2026-08-12T19:55:14-04:00');
      expect(raw(first)['news:news']).toBeDefined();

      // A curly right-single-quotation-mark (U+2019) title, decoded exactly
      // -- proves htmlEntities/UTF-8 handling is correct for real content
      // that uses a typographic apostrophe rather than a plain "'".
      const iceEntry = result.items.find((i) => i.url.includes('newsletter/morning-wire/august-13-2026'))!;
      expect(iceEntry.title).toBe(
        "ICE’s plan to give officers electric shock gloves, White House press secretary steps down",
      );

      // Non-English content with real diacritics decodes correctly too.
      const spanishEntry = result.items.find((i) => i.url.includes('mali-soldados-secuestrados'))!;
      expect(spanishEntry.title).toBe('Separatistas de Mali liberan a soldados que habían secuestrado');
      expect(spanishEntry.publishedAt).toBe('2026-08-13T12:06:13-04:00');
    });
  });

  describe('malformed entries: skipped, never thrown, neighbours survive', () => {
    it('drops entries with no <loc>, a blank <loc>, no <news:title>, or no <news:news> block at all, while good entries and an unparseable-date entry all survive', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(fixture('news-sitemap-malformed-entries.xml'));
      });

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      // 9 entries in the fixture, 4 defective -> exactly 5 survive.
      expect(result.items).toHaveLength(5);
      expect(result.skipped).toBe(4);

      const titles = result.items.map((i) => i.title).sort();
      expect(titles).toEqual(
        [
          'Good Item One',
          'Good Item Two',
          'Good Item Three',
          'Good Item Four',
          'Malformed Date Survives',
        ].sort(),
      );

      // A bad date does NOT cause a drop -- it survives with the raw string
      // passed through untouched, exactly as the sitemap wrote it.
      const badDate = result.items.find((i) => i.title === 'Malformed Date Survives')!;
      expect(badDate.publishedAt).toBe('not a real date at all');
      expect(badDate.url).toBe('https://example.test/article/malformed-date');

      // None of the four defective titles ("Missing Loc", "Blank Loc",
      // <undefined -- the missing-news-title entry has no news:title to
      // even carry a distinguishing name>, "Missing News Block") made it
      // through.
      expect(result.items.some((i) => i.title === 'Missing Loc')).toBe(false);
      expect(result.items.some((i) => i.title === 'Blank Loc')).toBe(false);
      expect(result.items.some((i) => i.url === 'https://example.test/article/missing-news-title')).toBe(
        false,
      );
      expect(result.items.some((i) => i.url === 'https://example.test/article/missing-news-block')).toBe(
        false,
      );
    });
  });

  describe('AdapterResult.skipped semantics', () => {
    it('reports skipped: 0 alongside items: [] for a genuinely quiet, well-formed sitemap', async () => {
      const baseUrl = await serveBody(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"></urlset>',
        { headers: { 'Content-Type': 'text/xml' } },
      );

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.notModified).toBe(false);
      expect(result.items).toEqual([]);
      expect(result.skipped).toBe(0);
    });

    it('distinguishes "nothing published" from "every entry was individually defective" -- both yield items: [], only skipped tells them apart', async () => {
      const baseUrl = await serveBody(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
          <url><news:news><news:title>No Loc One</news:title></news:news></url>
          <url><news:news><news:title>No Loc Two</news:title></news:news></url>
          <url><news:news><news:title>No Loc Three</news:title></news:news></url>
        </urlset>`,
        { headers: { 'Content-Type': 'text/xml' } },
      );

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.items).toEqual([]);
      expect(result.skipped).toBe(3);
    });

    it('leaves skipped undefined on a notModified result -- nothing was parsed, so there is no count to report', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(304, { ETag: '"still-current"' });
        res.end();
      });

      const result = await newsSitemapAdapter.fetch(
        makeSource({ url: `${baseUrl}/sitemap` }),
        makeState({ etag: '"still-current"' }),
      );

      expect(result.notModified).toBe(true);
      expect(result.skipped).toBeUndefined();
    });
  });

  describe('the item cap', () => {
    it('caps items to MAX_ITEMS_PER_FETCH, keeping the MOST RECENT by publication date rather than a file-order prefix', async () => {
      const total = MAX_ITEMS_PER_FETCH + 10;
      const baseUrl = await serveBody(makeManyEntriesBody(total), {
        headers: { 'Content-Type': 'text/xml' },
      });

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.items).toHaveLength(MAX_ITEMS_PER_FETCH);
      // Cap-trimming is not a defect -- every one of these entries parsed
      // fine, so skipped must stay 0, distinct from a parser problem.
      expect(result.skipped).toBe(0);
      // `capped` reports exactly how many were trimmed -- distinct from
      // `skipped`, and never folded into it (see AdapterResult.capped's doc
      // comment in types.ts).
      expect(result.capped).toBe(10);

      // makeManyEntriesBody makes entry 0 the newest and entry (total-1) the
      // oldest, one day apart -- so the surviving set must be EXACTLY
      // entries 0..MAX_ITEMS_PER_FETCH-1, and every older entry excluded.
      const titles = new Set(result.items.map((i) => i.title));
      for (let i = 0; i < MAX_ITEMS_PER_FETCH; i++) {
        expect(titles.has(`Entry ${i}`)).toBe(true);
      }
      for (let i = MAX_ITEMS_PER_FETCH; i < total; i++) {
        expect(titles.has(`Entry ${i}`)).toBe(false);
      }
    });

    it('does not trim a batch already at or under the cap, and leaves `capped` undefined rather than a fabricated 0', async () => {
      const baseUrl = await serveBody(makeManyEntriesBody(MAX_ITEMS_PER_FETCH), {
        headers: { 'Content-Type': 'text/xml' },
      });

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.items).toHaveLength(MAX_ITEMS_PER_FETCH);
      expect(result.capped).toBeUndefined();
    });

    it('excludes undated and malformed-dated entries before any well-dated entry when the cap binds, even though they sit near the front of the file (fix round 1, Finding 1)', async () => {
      const datedCount = MAX_ITEMS_PER_FETCH + 5; // 155 well-dated + 3 undated = 158 total
      const body = makeMixedCapBody(datedCount);
      const baseUrl = await serveBody(body, { headers: { 'Content-Type': 'text/xml' } });

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.items).toHaveLength(MAX_ITEMS_PER_FETCH);
      expect(result.skipped).toBe(0);
      expect(result.capped).toBe(datedCount + 3 - MAX_ITEMS_PER_FETCH);

      const titles = new Set(result.items.map((i) => i.title));

      // Every undated/malformed-dated entry is gone -- recencyRank ranks
      // them last (never first), so they are the FIRST to be trimmed
      // regardless of file position. These three were seeded near the front
      // (indices 5, 9, 13) specifically so a cap that fell back to file
      // order, or that had recencyRank's comparison sign flipped, would keep
      // them and cut real, well-dated recent articles instead.
      expect(titles.has('Undated Missing')).toBe(false);
      expect(titles.has('Undated Empty')).toBe(false);
      expect(titles.has('Undated Malformed')).toBe(false);

      // The MAX_ITEMS_PER_FETCH most recent DATED entries survive...
      for (let i = 0; i < MAX_ITEMS_PER_FETCH; i++) {
        expect(titles.has(`Dated ${i}`)).toBe(true);
      }
      // ...and the 5 oldest dated entries are cut too, same as the undated
      // ones -- proving the cap still ranks correctly AMONG well-dated
      // entries once the undated ones are out of the running, not just that
      // undated entries always lose.
      for (let i = MAX_ITEMS_PER_FETCH; i < datedCount; i++) {
        expect(titles.has(`Dated ${i}`)).toBe(false);
      }
    });
  });

  describe('parser robustness', () => {
    it('does not break on a sitemap with exactly one <url> (fast-xml-parser unwraps a single occurrence to a bare object unless forced to stay an array)', async () => {
      const baseUrl = await serveBody(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
          <url><loc>https://example.test/only</loc><news:news><news:title>Only One</news:title></news:news></url>
        </urlset>`,
        { headers: { 'Content-Type': 'text/xml' } },
      );

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('Only One');
    });
  });

  describe('absorbed-entry recovery (fix round 1, Finding 2)', () => {
    // rss.ts has three dedicated tests proving its equivalent
    // recoverAbsorbedEntries/collectAbsorbedEntries pair actually recovers a
    // sibling absorbed by a genuinely unclosed element, not merely that it
    // leaves well-formed documents unchanged (which the real-fixture test
    // above already proves, via the no-op path -- entries.length === 55
    // there is consistent with recovery working OR with it being dead code;
    // it cannot tell the two apart). These two tests close that gap for
    // this adapter directly, adapted to <url>/<loc>/<news:title>. Verified
    // empirically first (node -e against fast-xml-parser with this file's
    // exact parser config) that leaving <news:title> unclosed inside the
    // first <url> makes the SECOND <url> parse as a descendant nested under
    // `news:news.news:title.url`, not as a top-level sibling of <urlset> --
    // exactly the shape recoverAbsorbedEntries is designed to find and lift
    // back out.
    it('recovers a <url> entry absorbed by a genuinely unclosed element instead of losing it', async () => {
      const baseUrl = await serveBody(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
<url><loc>https://example.test/broken</loc><news:news><news:publication_date>2026-08-12T00:00:00Z</news:publication_date><news:title>oops no closing tag
<url><loc>https://example.test/good-two</loc><news:news><news:title>Good Two</news:title></news:news></url>
</urlset>`,
        { headers: { 'Content-Type': 'text/xml' } },
      );

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.items).toHaveLength(2);
      const titles = result.items.map((i) => i.title).sort();
      expect(titles).toEqual(['Good Two', 'oops no closing tag'].sort());

      // "Broken One" (its own <news:title> is the truncated text itself,
      // since that element never closed) is still a valid, usable item --
      // a truncated element's own content is not, by itself, a reason to
      // drop the entry it belongs to.
      const brokenOne = result.items.find((i) => i.url === 'https://example.test/broken')!;
      expect(brokenOne.publishedAt).toBe('2026-08-12T00:00:00Z');

      const goodTwo = result.items.find((i) => i.title === 'Good Two')!;
      expect(goodTwo.url).toBe('https://example.test/good-two');
    });

    it('recovers a CHAIN of multiple <url> entries absorbed by the same unclosed element', async () => {
      const baseUrl = await serveBody(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
<url><loc>https://example.test/broken</loc><news:news><news:title>oops no closing tag
<url><loc>https://example.test/good-two</loc><news:news><news:title>Good Two</news:title></news:news></url>
<url><loc>https://example.test/good-three</loc><news:news><news:title>Good Three</news:title></news:news></url>
</urlset>`,
        { headers: { 'Content-Type': 'text/xml' } },
      );

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.items).toHaveLength(3);
      expect(result.items.map((i) => i.title).sort()).toEqual(
        ['Good Three', 'Good Two', 'oops no closing tag'].sort(),
      );
    });
  });

  describe('wholly unparseable bodies: thrown, not skipped', () => {
    it('throws NewsSitemapParseError for a plain-text, non-XML body', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable\nplease try again later\n');
      });

      await expect(
        newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null),
      ).rejects.toThrow(NewsSitemapParseError);
    });

    it('throws NewsSitemapParseError for an HTML error page served with a 200 status', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>');
      });

      await expect(
        newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null),
      ).rejects.toThrow(NewsSitemapParseError);
    });

    it('throws NewsSitemapParseError for an empty body', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('');
      });

      await expect(
        newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null),
      ).rejects.toThrow(NewsSitemapParseError);
    });

    it('throws NewsSitemapParseError when the root element is not <urlset> at all', async () => {
      const baseUrl = await serveBody('<rss version="2.0"></rss>', {
        headers: { 'Content-Type': 'text/xml' },
      });

      await expect(
        newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null),
      ).rejects.toThrow(NewsSitemapParseError);
    });

    it('does NOT throw for a well-formed but empty <urlset> -- zero items is a valid, successful result', async () => {
      const baseUrl = await serveBody(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
        { headers: { 'Content-Type': 'text/xml' } },
      );

      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

      expect(result.notModified).toBe(false);
      expect(result.items).toEqual([]);
    });
  });

  describe('conditional requests and 304 handling', () => {
    it('sends If-None-Match / If-Modified-Since derived from FetchState', async () => {
      let received: Record<string, string | string[] | undefined> = {};
      const baseUrl = await serve((req, res) => {
        received = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
      });

      await newsSitemapAdapter.fetch(
        makeSource({ url: `${baseUrl}/sitemap` }),
        makeState({ etag: '"prior-etag"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' }),
      );

      expect(received['if-none-match']).toBe('"prior-etag"');
      expect(received['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    });

    it('sends no conditional headers when state is null', async () => {
      let received: Record<string, string | string[] | undefined> = {};
      const baseUrl = await serve((req, res) => {
        received = req.headers;
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
      });

      await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), null);

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

      const result = await newsSitemapAdapter.fetch(
        makeSource({ url: `${baseUrl}/sitemap` }),
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
      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), priorState);

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
      const result = await newsSitemapAdapter.fetch(makeSource({ url: `${baseUrl}/sitemap` }), priorState);

      expect(result.etag).toBe('"fresher-etag"');
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonAdapter, JsonParseError, UnknownJsonSourceError } from '../../src/adapters/json.ts';
import { canonicalizeUrl } from '../../src/normalize/url.ts';
import type { Source } from '../../src/sources/load.ts';
import type { FetchState } from '../../src/db/fetchState.ts';

// ---------------------------------------------------------------------------
// Test helpers -- same local-http-server pattern as tests/adapters/rss.test.ts
// and tests/fetch/http.test.ts. No network in this file: every "live"
// scenario below is served from a checked-in fixture over a loopback
// ephemeral-port server, never the real internet.
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
    res.writeHead(opts.status ?? 200, { 'Content-Type': 'application/json', ...opts.headers });
    res.end(body);
  });
}

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', 'adapters', name), 'utf8');
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'cisa-kev',
    name: 'Test Source',
    type: 'json',
    url: 'https://example.test/feed.json',
    beats: ['cyber'],
    weight: 1,
    poll_interval: '1h',
    enabled: true,
    enrichment: true,
    ...overrides,
  };
}

function makeState(overrides: Partial<FetchState> = {}): FetchState {
  return {
    sourceId: 'cisa-kev',
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

describe('jsonAdapter', () => {
  it('declares its SourceType as "json"', () => {
    expect(jsonAdapter.type).toBe('json');
  });

  // -------------------------------------------------------------------------
  // Real fixtures, captured live -- one per registered source id. Proves
  // every one of the five per-source-shape mappers actually works against
  // the real shape its API returns, not just a hand-imagined one.
  // -------------------------------------------------------------------------
  describe('real fixtures (captured live), one per registered source', () => {
    it('parses cisa-kev: { vulnerabilities: [...] }, url constructed from cveID on CISA\'s own catalog page', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ETag: '"kev-etag-1"',
          'Last-Modified': 'Tue, 11 Aug 2026 18:59:43 GMT',
        });
        res.end(fixture('cisa-kev.json'));
      });

      const result = await jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }), null);

      expect(result.notModified).toBe(false);
      expect(result.etag).toBe('"kev-etag-1"');
      expect(result.lastModified).toBe('Tue, 11 Aug 2026 18:59:43 GMT');
      // Fixture trimmed from 1665 live entries to 30 -- see task report.
      expect(result.items).toHaveLength(30);
      expect(result.skipped).toBe(0);

      const first = result.items[0]!;
      // No first-party link field exists on a KEV entry -- url is
      // constructed from cveID on CISA's own catalog page, filtered via its
      // real `field_cve` form field (verified live -- see json.ts's
      // cisaKevUrl doc comment). Deliberately NOT nvd.nist.gov (fix round 1,
      // Finding 1) -- nvd-cve below uses that host, and the two must never
      // collide on the same CVE.
      expect(first.url).toBe(
        'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
      );
      expect(first.title).toBe(
        'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) Heap Inspection Vulnerability',
      );
      // "YYYY-MM-DD" passed through untouched -- normalizeItem's job to
      // interpret (or reject) it, never this adapter's.
      expect(first.publishedAt).toBe('2026-08-11');
      expect(first.summary).toContain('heap inspection vulnerability');
      expect(first.author).toBeNull();
      // Nothing thrown away: fields RawItem doesn't surface survive on `raw`.
      expect(raw(first).vendorProject).toBe('Cisco');
      expect(raw(first).cwes).toEqual(['CWE-244']);
    });

    it('parses nvd-cve: NVD API 2.0 { vulnerabilities: [{ cve: {...} }] }, title falls back to the CVE id', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(fixture('nvd-cve.json'));
      });

      const result = await jsonAdapter.fetch(makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(5);
      expect(result.skipped).toBe(0);

      const first = result.items[0]!;
      expect(first.url).toBe('https://nvd.nist.gov/vuln/detail/CVE-1999-0095');
      // No title field exists in the NVD schema at all -- the CVE id is
      // used, the only thing every entry is guaranteed to carry.
      expect(first.title).toBe('CVE-1999-0095');
      // No UTC offset or "Z" on this field at all -- passed through exactly
      // as NVD wrote it (becomes null at normalization, never guessed).
      expect(first.publishedAt).toBe('1988-10-01T04:00:00.000');
      expect(first.summary).toBe(
        'The debug command in Sendmail is enabled, allowing attackers to execute commands as root.',
      );
      expect(first.author).toBeNull();
      expect(raw(first).cve).toBeDefined();
      expect((raw(first).cve as Record<string, unknown>).vulnStatus).toBe('Modified');
    });

    it('parses hn-algolia: { hits: [...] }, using the direct story url', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(fixture('hn-algolia.json'));
      });

      const result = await jsonAdapter.fetch(makeSource({ id: 'hn-algolia', url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(10);
      expect(result.skipped).toBe(0);

      const first = result.items[0]!;
      expect(first.url).toBe('http://www.bbc.com/news/uk-43396008');
      expect(first.title).toBe('Stephen Hawking has died');
      expect(first.publishedAt).toBe('2018-03-14T03:50:30Z');
      expect(first.author).toBe('Cogito');
      // This particular story is a link post -- no story_text.
      expect(first.summary).toBeNull();
      expect(raw(first).points).toBe(6015);
      expect(raw(first).objectID).toBe('16582136');
    });

    it('parses federal-register: { results: [...] }, using html_url and no author', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(fixture('federal-register.json'));
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'federal-register', url: `${baseUrl}/feed` }),
        null,
      );

      expect(result.items).toHaveLength(5);
      expect(result.skipped).toBe(0);

      const first = result.items[0]!;
      expect(first.url).toBe(
        'https://www.federalregister.gov/documents/2026/08/13/2026-16567/airworthiness-directives-airbus-sas-airplanes',
      );
      expect(first.title).toBe('Airworthiness Directives; Airbus SAS Airplanes');
      // "YYYY-MM-DD" -- same fate at normalization as cisa-kev's dateAdded.
      expect(first.publishedAt).toBe('2026-08-13');
      expect(first.summary).toContain('The FAA proposes to adopt a new airworthiness directive');
      // No byline concept on a regulatory document -- deliberately null,
      // not the issuing agency's name (see json.ts doc comment).
      expect(first.author).toBeNull();
      expect(raw(first).document_number).toBe('2026-16567');
    });

    it('parses nws-fl-alerts: GeoJSON { features: [{ properties: {...} }] }, url is the feature id itself', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/geo+json' });
        res.end(fixture('nws-fl-alerts.json'));
      });

      const result = await jsonAdapter.fetch(makeSource({ id: 'nws-fl-alerts', url: `${baseUrl}/feed` }), null);

      // Live capture: Florida had 15 active alerts at capture time. A zero-
      // feature capture is exercised separately below (synthetic), since
      // "zero is success" cannot be proven from a fixture that happens to be
      // non-empty.
      expect(result.items).toHaveLength(15);
      expect(result.skipped).toBe(0);

      const first = result.items[0]!;
      expect(first.url).toBe(
        'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.f562e7d93c6e7e383aa7df77036ca8e0e59344f4.001.1',
      );
      expect(first.title).toBe('Special Weather Statement issued August 13 at 5:04PM EDT by NWS Jacksonville FL');
      expect(first.publishedAt).toBe('2026-08-13T17:04:00-04:00');
      expect(first.summary).toContain('Doppler radar was tracking a strong thunderstorm');
      expect(first.author).toBe('NWS Jacksonville FL');
      expect((raw(first).properties as Record<string, unknown>).severity).toBe('Moderate');
    });
  });

  // -------------------------------------------------------------------------
  // Malformed entries: skipped, never thrown, neighbours (and fallback-URL
  // entries) survive. Each source's "malformed" means precisely: the fields
  // needed to build url/title are missing or blank. Every other field is
  // optional passthrough and never a reason to drop an entry.
  // -------------------------------------------------------------------------
  describe('malformed entries: skipped, never thrown, neighbours survive', () => {
    it('cisa-kev: drops entries with a blank/missing cveID or vulnerabilityName, or a non-object entry', async () => {
      const body = JSON.stringify({
        title: 't',
        catalogVersion: 'x',
        dateReleased: '2026-01-01T00:00:00Z',
        count: 6,
        vulnerabilities: [
          { cveID: 'CVE-2026-0001', vulnerabilityName: 'Good One', dateAdded: '2026-01-01', shortDescription: 'd1' },
          { cveID: '', vulnerabilityName: 'Blank CVE ID' },
          { cveID: 'CVE-2026-0003', vulnerabilityName: '' },
          { vulnerabilityName: 'No CVE ID Key At All' },
          { cveID: 'CVE-2026-0005', vulnerabilityName: 'Good Two', dateAdded: '2026-01-02', shortDescription: 'd2' },
          'not even an object',
        ],
      });
      const baseUrl = await serveBody(body);

      const result = await jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(2);
      expect(result.skipped).toBe(4);
      expect(result.items.map((i) => i.title).sort()).toEqual(['Good One', 'Good Two']);
      expect(result.items.find((i) => i.title === 'Good Two')!.url).toBe(
        'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-0005',
      );
    });

    it('nvd-cve: drops entries with a blank/missing cve.id, a missing cve object, or a non-object entry', async () => {
      const body = JSON.stringify({
        resultsPerPage: 6,
        startIndex: 0,
        totalResults: 6,
        format: 'x',
        version: '2.0',
        timestamp: 't',
        vulnerabilities: [
          {
            cve: {
              id: 'CVE-2026-1000',
              published: '2026-01-01T00:00:00.000',
              descriptions: [{ lang: 'en', value: 'Good desc one' }],
            },
          },
          { cve: { id: '', descriptions: [] } },
          { cve: { descriptions: [] } },
          { notCve: {} },
          {
            cve: {
              id: 'CVE-2026-1001',
              published: '2026-01-02T00:00:00.000',
              descriptions: [{ lang: 'en', value: 'Good desc two' }],
            },
          },
          'garbage',
        ],
      });
      const baseUrl = await serveBody(body);

      const result = await jsonAdapter.fetch(makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(2);
      expect(result.skipped).toBe(4);
      expect(result.items.map((i) => i.title).sort()).toEqual(['CVE-2026-1000', 'CVE-2026-1001']);
      expect(result.items.find((i) => i.title === 'CVE-2026-1000')!.summary).toBe('Good desc one');
    });

    it('hn-algolia: drops entries with no title, or with neither a url nor an objectID to fall back to -- but a missing url alone falls back to the HN discussion link and survives', async () => {
      const body = JSON.stringify({
        hits: [
          {
            objectID: '1',
            title: 'Good Story One',
            url: 'https://example.test/one',
            author: 'alice',
            created_at: '2026-01-01T00:00:00Z',
          },
          { objectID: '2', title: '', url: 'https://example.test/blank-title' },
          { objectID: '3', url: 'https://example.test/no-title' },
          { objectID: '4', title: 'No URL Falls Back To HN Discussion Link' },
          { title: 'No URL And No ObjectID', url: '' },
          'not an object',
          {
            objectID: '6',
            title: 'Good Story Two',
            url: 'https://example.test/two',
            author: 'bob',
            created_at: '2026-01-02T00:00:00Z',
          },
        ],
      });
      const baseUrl = await serveBody(body);

      const result = await jsonAdapter.fetch(makeSource({ id: 'hn-algolia', url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(3);
      expect(result.skipped).toBe(4);
      const titles = result.items.map((i) => i.title).sort();
      expect(titles).toEqual(
        ['Good Story One', 'Good Story Two', 'No URL Falls Back To HN Discussion Link'].sort(),
      );

      const fallback = result.items.find((i) => i.title === 'No URL Falls Back To HN Discussion Link')!;
      expect(fallback.url).toBe('https://news.ycombinator.com/item?id=4');
    });

    it('federal-register: drops entries with a blank/missing title or html_url, or a non-object entry', async () => {
      const body = JSON.stringify({
        description: 'x',
        count: 6,
        total_pages: 1,
        next_page_url: null,
        results: [
          {
            title: 'Good Doc One',
            html_url: 'https://example.test/doc-one',
            publication_date: '2026-01-01',
            abstract: 'abstract one',
          },
          { title: '', html_url: 'https://example.test/blank-title' },
          { title: 'No HTML URL' },
          { html_url: 'https://example.test/no-title' },
          'garbage',
          {
            title: 'Good Doc Two',
            html_url: 'https://example.test/doc-two',
            publication_date: '2026-01-02',
            abstract: 'abstract two',
          },
        ],
      });
      const baseUrl = await serveBody(body);

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'federal-register', url: `${baseUrl}/feed` }),
        null,
      );

      expect(result.items).toHaveLength(2);
      expect(result.skipped).toBe(4);
      expect(result.items.map((i) => i.title).sort()).toEqual(['Good Doc One', 'Good Doc Two']);
    });

    it('nws-fl-alerts: drops features with a blank/missing id or no usable title -- but a missing headline alone falls back to event and survives', async () => {
      const body = JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            id: 'https://api.weather.gov/alerts/urn:oid:good-one',
            properties: {
              headline: 'Good Alert One',
              sent: '2026-01-01T00:00:00-04:00',
              description: 'desc one',
              senderName: 'NWS Test',
            },
          },
          { id: '', properties: { headline: 'Blank Id' } },
          { properties: { headline: 'No Id At All' } },
          { id: 'https://api.weather.gov/alerts/urn:oid:no-title', properties: { event: '' } },
          { id: 'https://api.weather.gov/alerts/urn:oid:missing-props' },
          {
            id: 'https://api.weather.gov/alerts/urn:oid:fallback-to-event',
            properties: { event: 'Special Weather Statement Only' },
          },
          'garbage',
          {
            id: 'https://api.weather.gov/alerts/urn:oid:good-two',
            properties: { headline: 'Good Alert Two', sent: '2026-01-02T00:00:00-04:00' },
          },
        ],
      });
      const baseUrl = await serveBody(body);

      const result = await jsonAdapter.fetch(makeSource({ id: 'nws-fl-alerts', url: `${baseUrl}/feed` }), null);

      expect(result.items).toHaveLength(3);
      expect(result.skipped).toBe(5);
      const titles = result.items.map((i) => i.title).sort();
      expect(titles).toEqual(['Good Alert One', 'Good Alert Two', 'Special Weather Statement Only'].sort());

      const fallback = result.items.find((i) => i.title === 'Special Weather Statement Only')!;
      expect(fallback.url).toBe('https://api.weather.gov/alerts/urn:oid:fallback-to-event');
    });
  });

  // -------------------------------------------------------------------------
  // AdapterResult.skipped, and zero-items-is-success.
  // -------------------------------------------------------------------------
  describe('AdapterResult.skipped and zero-items-is-success', () => {
    it('nws-fl-alerts: a well-formed response with zero features is success, not failure -- Florida can genuinely have no active alerts', async () => {
      const body = JSON.stringify({
        '@context': 'https://geojson.org/geojson-ld/geojson-context.jsonld',
        type: 'FeatureCollection',
        features: [],
        title: 'current watches, warnings, and advisories for Florida',
        updated: '2026-08-13T18:00:00+00:00',
      });
      const baseUrl = await serveBody(body);

      const result = await jsonAdapter.fetch(makeSource({ id: 'nws-fl-alerts', url: `${baseUrl}/feed` }), null);

      expect(result.notModified).toBe(false);
      expect(result.items).toEqual([]);
      expect(result.skipped).toBe(0);
    });

    it('distinguishes "nothing published" from "every entry was individually defective" -- both yield items: [], only skipped tells them apart', async () => {
      // Every one of these 3 results is missing html_url -- a fetch that
      // genuinely succeeded (the envelope parsed fine) but whose entries
      // were all unusable. Before `skipped` existed this was
      // indistinguishable from a genuinely quiet day (items: [] either way).
      const body = JSON.stringify({
        description: 'x',
        count: 3,
        total_pages: 1,
        next_page_url: null,
        results: [{ title: 'No Link One' }, { title: 'No Link Two' }, { title: 'No Link Three' }],
      });
      const baseUrl = await serveBody(body);

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'federal-register', url: `${baseUrl}/feed` }),
        null,
      );

      expect(result.items).toEqual([]);
      expect(result.skipped).toBe(3);
    });

    it('leaves skipped undefined on a notModified result -- nothing was parsed, so there is no count to report', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(304, { ETag: '"still-current"' });
        res.end();
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }),
        makeState({ etag: '"still-current"' }),
      );

      expect(result.notModified).toBe(true);
      expect(result.skipped).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Unknown source id: fails loudly at dispatch, never a silent items: [].
  // -------------------------------------------------------------------------
  describe('unknown source id', () => {
    it('throws UnknownJsonSourceError for a source id with no registered mapper, without ever attempting a fetch', async () => {
      let requestCount = 0;
      const baseUrl = await serve((_req, res) => {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });

      await expect(
        jsonAdapter.fetch(makeSource({ id: 'not-a-real-json-source', url: `${baseUrl}/feed` }), null),
      ).rejects.toThrow(UnknownJsonSourceError);

      // "At dispatch" means before any network call -- a source with a typo
      // in its id must not cost a fetch (or a rate-limit slot) before failing.
      expect(requestCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Wholly unparseable bodies: thrown, not skipped.
  // -------------------------------------------------------------------------
  describe('wholly unparseable bodies: thrown, not skipped', () => {
    it('throws JsonParseError for a plain-text, non-JSON body', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Service Unavailable\nplease try again later\n');
      });

      await expect(jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }), null)).rejects.toThrow(
        JsonParseError,
      );
    });

    it('throws JsonParseError for an empty body', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('');
      });

      await expect(jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }), null)).rejects.toThrow(
        JsonParseError,
      );
    });

    it('throws JsonParseError for an HTML error page served with a 200 status', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>');
      });

      await expect(jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }), null)).rejects.toThrow(
        JsonParseError,
      );
    });

    it('throws JsonParseError for syntactically valid JSON that is not an object at all (a bare array)', async () => {
      const baseUrl = await serveBody('[1, 2, 3]');

      await expect(
        jsonAdapter.fetch(makeSource({ id: 'hn-algolia', url: `${baseUrl}/feed` }), null),
      ).rejects.toThrow(JsonParseError);
    });

    it('cisa-kev: throws when "vulnerabilities" is present but not an array', async () => {
      const baseUrl = await serveBody(JSON.stringify({ vulnerabilities: 'oops, a string' }));

      await expect(jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }), null)).rejects.toThrow(
        JsonParseError,
      );
    });

    it('nvd-cve: throws when "vulnerabilities" is missing from the envelope entirely', async () => {
      const baseUrl = await serveBody(JSON.stringify({ resultsPerPage: 5, totalResults: 0 }));

      await expect(jsonAdapter.fetch(makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }), null)).rejects.toThrow(
        JsonParseError,
      );
    });

    it('hn-algolia: throws when "hits" is present but null', async () => {
      const baseUrl = await serveBody(JSON.stringify({ hits: null }));

      await expect(
        jsonAdapter.fetch(makeSource({ id: 'hn-algolia', url: `${baseUrl}/feed` }), null),
      ).rejects.toThrow(JsonParseError);
    });

    it('federal-register: throws when "results" is present but not an array', async () => {
      const baseUrl = await serveBody(JSON.stringify({ results: 42 }));

      await expect(
        jsonAdapter.fetch(makeSource({ id: 'federal-register', url: `${baseUrl}/feed` }), null),
      ).rejects.toThrow(JsonParseError);
    });

    it('nws-fl-alerts: throws on a Problem+JSON-shaped API error body with no "features" array', async () => {
      // api.weather.gov genuinely returns this shape (RFC 7807 Problem
      // Details) on its own error responses -- syntactically valid JSON,
      // but not this source's expected envelope at all.
      const baseUrl = await serveBody(
        JSON.stringify({ status: 503, type: 'about:blank', title: 'Service Unavailable' }),
      );

      await expect(
        jsonAdapter.fetch(makeSource({ id: 'nws-fl-alerts', url: `${baseUrl}/feed` }), null),
      ).rejects.toThrow(JsonParseError);
    });
  });

  // -------------------------------------------------------------------------
  // Conditional requests and 304 handling.
  // -------------------------------------------------------------------------
  describe('conditional requests and 304 handling', () => {
    it('sends If-None-Match / If-Modified-Since derived from FetchState', async () => {
      let received: Record<string, string | string[] | undefined> = {};
      const baseUrl = await serve((req, res) => {
        received = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vulnerabilities: [] }));
      });

      await jsonAdapter.fetch(
        makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }),
        makeState({ etag: '"prior-etag"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' }),
      );

      expect(received['if-none-match']).toBe('"prior-etag"');
      expect(received['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    });

    it('sends no conditional headers when state is null', async () => {
      let received: Record<string, string | string[] | undefined> = {};
      const baseUrl = await serve((req, res) => {
        received = req.headers;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vulnerabilities: [] }));
      });

      await jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }), null);

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

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }),
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
      const result = await jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }), priorState);

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
      const result = await jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` }), priorState);

      expect(result.etag).toBe('"fresher-etag"');
    });
  });

  // -------------------------------------------------------------------------
  // Fix round 1 regressions.
  // -------------------------------------------------------------------------
  describe('fix round 1 regressions', () => {
    describe('Finding 1 (CRITICAL): cisa-kev/nvd-cve must never construct the same URL for the same CVE', () => {
      it('canonicalizeUrl(cisa-kev url) !== canonicalizeUrl(nvd-cve url) for the identical CVE id', async () => {
        const cveId = 'CVE-2026-30000';

        const kevBody = JSON.stringify({
          vulnerabilities: [
            {
              cveID: cveId,
              vulnerabilityName: 'Shared CVE, CISA Side',
              dateAdded: '2026-01-01',
              shortDescription: 'kev desc',
            },
          ],
        });
        const kevBaseUrl = await serveBody(kevBody);
        const kevResult = await jsonAdapter.fetch(makeSource({ id: 'cisa-kev', url: `${kevBaseUrl}/feed` }), null);

        const nvdBody = JSON.stringify({
          vulnerabilities: [
            {
              cve: {
                id: cveId,
                published: '2026-01-01T00:00:00.000',
                descriptions: [{ lang: 'en', value: 'nvd desc' }],
              },
            },
          ],
        });
        const nvdBaseUrl = await serveBody(nvdBody);
        const nvdResult = await jsonAdapter.fetch(makeSource({ id: 'nvd-cve', url: `${nvdBaseUrl}/feed` }), null);

        expect(kevResult.items).toHaveLength(1);
        expect(nvdResult.items).toHaveLength(1);

        const kevRawUrl = kevResult.items[0]!.url;
        const nvdRawUrl = nvdResult.items[0]!.url;

        // The requirement that actually matters is downstream of
        // canonicalizeUrl, since THAT is what deriveItemKey
        // (src/domain/item.ts) hashes -- asserting on the raw urls alone
        // would not prove the fix, since canonicalizeUrl could in principle
        // normalize two different-looking urls back together (it doesn't
        // here, but the point of this test is not to assume that).
        expect(canonicalizeUrl(kevRawUrl)).not.toBe(canonicalizeUrl(nvdRawUrl));

        // Concretely: different hosts entirely, not merely a query-string
        // detail that happens to differ.
        expect(new URL(canonicalizeUrl(kevRawUrl)).hostname).toBe('cisa.gov');
        expect(new URL(canonicalizeUrl(nvdRawUrl)).hostname).toBe('nvd.nist.gov');
      });
    });

    describe('Finding 2 (Important): nws-fl-alerts must fall back on a present-but-BLANK field, not just a missing one', () => {
      it('a blank headline (not merely a missing one) falls back to event, and a blank sent falls back to effective', async () => {
        const body = JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              id: 'https://api.weather.gov/alerts/urn:oid:blank-headline-not-missing',
              properties: {
                headline: '',
                event: 'Heat Advisory',
                sent: '',
                effective: '2026-01-03T00:00:00-04:00',
              },
            },
          ],
        });
        const baseUrl = await serveBody(body);

        const result = await jsonAdapter.fetch(makeSource({ id: 'nws-fl-alerts', url: `${baseUrl}/feed` }), null);

        // Before the fix, `asString('') ?? asString(event)` never falls
        // through -- `??` only triggers on null/undefined, and '' is
        // neither -- so this entry was wrongly dropped as blank-titled even
        // though `event` held a perfectly good value.
        expect(result.items).toHaveLength(1);
        expect(result.skipped).toBe(0);

        const item = result.items[0]!;
        expect(item.title).toBe('Heat Advisory');
        // Same fix, applied to publishedAt for consistency -- harmless
        // today (a blank becomes null at normalization either way) but must
        // not silently diverge from the title fix.
        expect(item.publishedAt).toBe('2026-01-03T00:00:00-04:00');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Fix (disabled sources, M1 follow-up): nvd-cve's per-poll date-window url
  // builder. See src/adapters/json.ts's JsonSourceMapper.buildUrl doc
  // comment for the general mechanism (one optional function per source id,
  // registered in JSON_SOURCE_MAPPERS the same way extractEntries/parseEntry
  // already are) and nvdCveUrl's own doc comment for why nvd-cve needs it:
  // NVD's unfiltered query sorts ascending from the start of its entire
  // catalog (1988-era CVEs), not by recency, and a static config url cannot
  // express "the last N days" the way a lastModStartDate/lastModEndDate
  // window can.
  // -------------------------------------------------------------------------
  describe('nvd-cve: per-poll date-window url builder', () => {
    it('builds a 90-day lastModStartDate/lastModEndDate window ending at the injected "now", forces resultsPerPage/startIndex, and preserves any OTHER configured query param', async () => {
      let requestUrl: string | undefined;
      const baseUrl = await serve((req, res) => {
        requestUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // A short page (fewer than NVD_RESULTS_PER_PAGE entries) -- keeps
        // this test to exactly one request, since it is asserting on the
        // FIRST page's url, not exercising pagination itself (see the
        // dedicated pagination describe block below for that).
        res.end(JSON.stringify({ totalResults: 0, vulnerabilities: [] }));
      });

      const fixedNow = new Date('2026-08-14T03:00:00.000Z');
      await jsonAdapter.fetch(
        // A param unrelated to pagination -- proves buildUrl adds/overwrites
        // only its own four params (two date-window, resultsPerPage,
        // startIndex) rather than replacing the whole query string.
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed?apiKey=unused-in-m1` }),
        null,
        fixedNow,
      );

      const requested = new URL(requestUrl!, baseUrl);
      expect(requested.pathname).toBe('/feed');
      expect(requested.searchParams.get('apiKey')).toBe('unused-in-m1');
      // Fix round 1, Finding 1: resultsPerPage/startIndex are now entirely
      // code-owned (NVD_RESULTS_PER_PAGE/nvdCveUrl, src/adapters/json.ts) --
      // FORCED to these values regardless of whatever the configured url
      // carried (it carries nothing here, on purpose, to prove that).
      expect(requested.searchParams.get('resultsPerPage')).toBe('200');
      expect(requested.searchParams.get('startIndex')).toBe('0');
      // A fully deterministic exact match -- possible only because "now" is
      // an injected parameter, never read from the clock inside the
      // builder itself (see buildUrl's doc comment). 90 days, not 7 --
      // widened, fix round 1 (Important item) -- see NVD_WINDOW_DAYS's own
      // doc comment for the full reasoning.
      expect(requested.searchParams.get('lastModEndDate')).toBe('2026-08-14T03:00:00.000Z');
      expect(requested.searchParams.get('lastModStartDate')).toBe('2026-05-16T03:00:00.000Z');
    });

    it('defaults to the real current time when no "now" argument is given, so production callers (2-arg fetch) need no changes', async () => {
      let requestUrl: string | undefined;
      const baseUrl = await serve((req, res) => {
        requestUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vulnerabilities: [] }));
      });

      const before = Date.now();
      await jsonAdapter.fetch(makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }), null);
      const after = Date.now();

      const requested = new URL(requestUrl!, baseUrl);
      const windowEnd = Date.parse(requested.searchParams.get('lastModEndDate')!);
      expect(windowEnd).toBeGreaterThanOrEqual(before);
      expect(windowEnd).toBeLessThanOrEqual(after);
    });

    it('a source with no registered builder (e.g. cisa-kev) fetches its configured url completely unchanged, ignoring any injected "now"', async () => {
      let requestUrl: string | undefined;
      const baseUrl = await serve((req, res) => {
        requestUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vulnerabilities: [] }));
      });

      await jsonAdapter.fetch(
        makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed?x=1` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      // No lastModStartDate/lastModEndDate ever appears -- the request is
      // byte-for-byte the configured url's own path and query string.
      expect(requestUrl).toBe('/feed?x=1');
    });

    it('the nvd-cve mapper still parses its real fixture correctly with the builder wired in (no change to entry parsing)', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(fixture('nvd-cve.json'));
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed?resultsPerPage=5` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(result.items).toHaveLength(5);
      expect(result.skipped).toBe(0);
      expect(result.items[0]!.url).toBe('https://nvd.nist.gov/vuln/detail/CVE-1999-0095');
    });
  });

  // -------------------------------------------------------------------------
  // Fix round 1 (re-review), Finding 1 (CRITICAL): nvd-cve's pagination.
  //
  // The reviewer's live finding: the exact url the ORIGINAL fix built
  // (resultsPerPage=5, no pagination) retrieved 5 of 6,090 total results
  // (0.08%) -- a single page, capped at a tiny fixed size, of a stable
  // ascending sort whose front is dominated by a tied bulk-rescore batch.
  // `nvdPagedServer` below reproduces that exact shape as a loopback
  // fixture: honors resultsPerPage/startIndex from the query string
  // (defaulting resultsPerPage to 5 when absent, matching the ORIGINAL
  // bug's own default) against a caller-chosen totalResults, so the same
  // server proves both the defect (against pre-pagination code) and the fix
  // (against paginated code) -- see the report for the actual RED-then-GREEN
  // run against this exact test.
  // -------------------------------------------------------------------------
  describe('nvd-cve: pagination (fix round 1, Finding 1 CRITICAL)', () => {
    function nvdPagedServer(totalResults: number): Promise<string> {
      return serve((req, res) => {
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const resultsPerPage = Number(url.searchParams.get('resultsPerPage') ?? '5');
        const startIndex = Number(url.searchParams.get('startIndex') ?? '0');
        const count = Math.max(0, Math.min(resultsPerPage, totalResults - startIndex));
        const vulnerabilities = Array.from({ length: count }, (_, i) => ({
          cve: {
            id: `CVE-2026-${String(startIndex + i + 1).padStart(5, '0')}`,
            published: '2026-01-01T00:00:00.000',
            descriptions: [{ lang: 'en', value: 'synthetic' }],
          },
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalResults, resultsPerPage, startIndex, vulnerabilities }));
      });
    }

    it('Finding 1 (CRITICAL): retrieves far more than a single short page of a large total, in exactly NVD_MAX_PAGES_PER_POLL requests, and reports the honest remainder via capped', async () => {
      let requestCount = 0;
      const baseUrl = await serve((req, res) => {
        requestCount++;
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const resultsPerPage = Number(url.searchParams.get('resultsPerPage') ?? '5');
        const startIndex = Number(url.searchParams.get('startIndex') ?? '0');
        const totalResults = 6090; // the reviewer's own live figure
        const count = Math.max(0, Math.min(resultsPerPage, totalResults - startIndex));
        const vulnerabilities = Array.from({ length: count }, (_, i) => ({
          cve: { id: `CVE-2026-${String(startIndex + i + 1).padStart(5, '0')}` },
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalResults, resultsPerPage, startIndex, vulnerabilities }));
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      // 5 pages x 200/page = 1,000 -- NVD_MAX_PAGES_PER_POLL x
      // NVD_RESULTS_PER_PAGE (src/adapters/json.ts). Before this fix: 5
      // (a single resultsPerPage=5 page), 0.08% of 6,090 -- see the report
      // for the actual RED run of this exact test against the prior code.
      expect(requestCount).toBe(5); // bounded -- 6,090/200 would otherwise be 31 pages
      expect(result.items).toHaveLength(1000);
      expect(result.skipped).toBe(0);
      // Never silently hidden: 6,090 total, 1,000 actually retrieved,
      // 5,090 known-to-exist-but-not-this-poll -- AdapterResult.capped
      // (src/adapters/types.ts), not a fabricated 0 and not omitted.
      expect(result.capped).toBe(5090);
      // Explicit timeout: 5 real politeFetch calls to the same loopback host,
      // each spaced by the PRODUCTION 2s per-host minimum interval (never
      // weakened for test speed -- politeness is non-negotiable even in a
      // test's own server) -- up to ~8s wall-clock, over vitest's 5s default.
      // (The bounded page count is proven above by requestCount === 5 against
      // a total that would otherwise need 31 pages -- a second test against
      // an even larger, effectively-unbounded total, e.g. the ~1,000,000-ish
      // scale of the live bulk-rescore anomaly discovered widening the
      // window, would prove nothing further about THIS property, only cost
      // another ~8s of real per-host spacing, so was deliberately not added.)
    }, 15000);

    it('stops early, before reaching maxPages, once a page returns fewer entries than a full page', async () => {
      const baseUrl = await nvdPagedServer(450); // 200 + 200 + 50 -- a short third page

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(result.items).toHaveLength(450);
      // Fully covered -- nothing excluded, so capped must be undefined, not
      // a fabricated 0 (AdapterResult.capped's own doc comment).
      expect(result.capped).toBeUndefined();
    }, 15000); // 3 real requests (2 gaps x 2s)

    it('leaves capped undefined (not 0) when the very first page already covers the whole total', async () => {
      const baseUrl = await nvdPagedServer(3);

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(result.items).toHaveLength(3);
      expect(result.capped).toBeUndefined();
    });

    it('sends conditional-request headers only on page 1; page 2+ are unconditional GETs', async () => {
      const receivedHeaders: Array<Record<string, string | string[] | undefined>> = [];
      const baseUrl = await serve((req, res) => {
        receivedHeaders.push(req.headers);
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const startIndex = Number(url.searchParams.get('startIndex') ?? '0');
        const vulnerabilities = Array.from({ length: 200 }, (_, i) => ({
          cve: { id: `CVE-2026-${String(startIndex + i + 1).padStart(5, '0')}` },
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalResults: 350, vulnerabilities: startIndex === 0 ? vulnerabilities : vulnerabilities.slice(0, 150) }));
      });

      await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        makeState({ etag: '"prior-nvd-etag"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' }),
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(receivedHeaders).toHaveLength(2); // 200 + 150 -- a short second page, exactly 2 requests
      expect(receivedHeaders[0]!['if-none-match']).toBe('"prior-nvd-etag"');
      expect(receivedHeaders[0]!['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
      // Page 2 was never conditionally requested -- state's validators
      // describe page 1's identity, not a page that never existed on any
      // prior poll (see the doc comment in jsonAdapter.fetch's paginated
      // loop for why this is correct, not an oversight).
      expect(receivedHeaders[1]!['if-none-match']).toBeUndefined();
      expect(receivedHeaders[1]!['if-modified-since']).toBeUndefined();
    }, 15000); // 2 real requests (1 gap x 2s)

    it('a 304 on page 1 short-circuits before any pagination is attempted', async () => {
      let requestCount = 0;
      const baseUrl = await serve((_req, res) => {
        requestCount++;
        res.writeHead(304, { ETag: '"still-current"' });
        res.end();
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        makeState({ etag: '"still-current"' }),
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(requestCount).toBe(1);
      expect(result.notModified).toBe(true);
      expect(result.items).toEqual([]);
    });

    it('a failure fetching page 2+ propagates and rejects the whole fetch, exactly like a page-1 failure would', async () => {
      let requestCount = 0;
      const baseUrl = await serve((req, res) => {
        requestCount++;
        if (requestCount === 1) {
          const vulnerabilities = Array.from({ length: 200 }, (_, i) => ({ cve: { id: `CVE-2026-${i + 1}` } }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ totalResults: 999, vulnerabilities }));
          return;
        }
        res.writeHead(503);
        res.end('unavailable');
      });

      await expect(
        jsonAdapter.fetch(makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }), null, new Date('2026-08-14T03:00:00.000Z')),
      ).rejects.toThrow();
      expect(requestCount).toBe(2);
    }, 15000); // 2 real requests (1 gap x 2s)

    it('malformed entries on any page are counted in skipped, not silently dropped, and do not stop pagination', async () => {
      const baseUrl = await serve((req, res) => {
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const startIndex = Number(url.searchParams.get('startIndex') ?? '0');
        const vulnerabilities: unknown[] =
          startIndex === 0
            ? [{ cve: { id: 'CVE-2026-00001' } }, { cve: { id: '' } }, 'not even an object', ...Array.from({ length: 197 }, (_, i) => ({ cve: { id: `CVE-2026-${i + 2}` } }))]
            : []; // short (empty) second page -- stop after page 1
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalResults: 200, vulnerabilities }));
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(result.items).toHaveLength(198);
      expect(result.skipped).toBe(2);
      // All 200 raw entries on this one page were genuinely retrieved
      // (198 usable + 2 malformed) -- fully covers a 200-total window, so
      // nothing was excluded BY POLICY and capped must be undefined.
      expect(result.capped).toBeUndefined();
    }, 15000); // 2 real requests (1 gap x 2s) -- page 1 is a FULL 200-entry page (malformed entries still occupy a slot), so pagination genuinely continues to a short, empty page 2 before stopping
  });
});

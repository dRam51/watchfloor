import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonAdapter, JsonParseError, UnknownJsonSourceError } from '../../src/adapters/json.ts';
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
    it('parses cisa-kev: { vulnerabilities: [...] }, url constructed from cveID via NVD', async () => {
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
      // constructed from cveID via NVD's own per-CVE page. See json.ts's
      // module doc comment for why.
      expect(first.url).toBe('https://nvd.nist.gov/vuln/detail/CVE-2026-20349');
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
        'https://nvd.nist.gov/vuln/detail/CVE-2026-0005',
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
});

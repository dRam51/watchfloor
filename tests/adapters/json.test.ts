import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonAdapter, JsonParseError, UnknownJsonSourceError } from '../../src/adapters/json.ts';
import { normalizeItem } from '../../src/normalize/item.ts';
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
      // NVD's `cve.published` carries no UTC offset or "Z" at all -- but is
      // live-verified (fix-nvd-null-dates-report.md) to always mean UTC, so
      // nvd-cve's own mapper (and only this mapper) appends "Z" rather than
      // passing the ambiguous-looking string through untouched. See the
      // dedicated describe block below ("fix, null published_at") for the
      // full RawItem -> normalizeItem proof, including why this does not
      // weaken normalizeItem's never-guess rule for any other source.
      expect(first.publishedAt).toBe('1988-10-01T04:00:00.000Z');
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
          // totalResults required since tail pagination (fix round 2):
          // nvd-cve's first fetch is always a total-discovery PROBE now --
          // see JsonSourceMapper.paginate's doc comment, src/adapters/
          // json.ts -- and serveBody answers every request (probe and the
          // real content page it triggers) with this identical body, so a
          // legible, positive totalResults is what lets the second (real
          // content page) request happen at all and reach this test's own
          // single entry.
          totalResults: 1,
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
    it('builds a 90-day lastModStartDate/lastModEndDate window ending at the injected "now", forces resultsPerPage/startIndex for a cheap total-discovery PROBE, and preserves any OTHER configured query param', async () => {
      let requestUrl: string | undefined;
      const baseUrl = await serve((req, res) => {
        requestUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // totalResults: 0 -- nothing for the tail-pagination anchor logic to
        // chase, so this stays exactly one request (the probe itself),
        // since this test is asserting on the PROBE's own url, not
        // exercising the tail walk (see the dedicated pagination describe
        // block below for that).
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
      // Tail-pagination fix (round 2): the FIRST request of any poll is now
      // a cheap total-discovery PROBE, not a full content page --
      // resultsPerPage=1, always startIndex=0 (see nvdCveUrl's and
      // nvdAnchorPageUrl's doc comments, src/adapters/json.ts, for why: NVD
      // exposes no sort parameter, so "the tail" can only be reached by
      // first learning totalResults, cheaply, then computing an explicit
      // offset -- there is no way to ask for "the last N" directly).
      expect(requested.searchParams.get('resultsPerPage')).toBe('1');
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
  // Tail-pagination fix (M1 follow-up, fix round 2): nvd-cve was retrieving
  // the WRONG END of the result set.
  //
  // Fix round 1 (its own describe block is gone; superseded, not kept
  // alongside as dead history -- this whole block replaces it) paginated
  // FORWARD from startIndex=0, on the premise that NVD's default sort was
  // "ascending by lastModified" and that a bounded number of pages from the
  // front was an honest, disclosed partial-coverage trade-off. Both premises
  // were wrong. Verified live against the real API (2026-08-14), the same
  // 90-day window this code builds: the front of the result set
  // (startIndex=0) is CVE-1999-0095 (published 1988-10-01), CVE-1999-0082,
  // CVE-1999-1471, CVE-1999-1122, CVE-1999-1467 -- with a NON-monotonic
  // lastModified (...34.460, ...32.300, ...30.747, ...46.027, ...30.147)
  // even though `published` climbs strictly across the same five. The sort
  // is ascending by CVE id / publication, not by lastModified -- the wrong
  // claim lived in the doc comment on NVD_RESULTS_PER_PAGE/
  // NVD_MAX_PAGES_PER_POLL (src/adapters/json.ts) since fix round 1; it is
  // corrected there now, not repeated here as a second copy to drift out of
  // sync.
  //
  // The practical consequence: walking forward from startIndex=0, bounded to
  // a handful of pages, retrieves the OLDEST ~1,000 entries in the window on
  // EVERY poll -- roughly 1988 through the late 1990s -- and NEVER reaches a
  // current CVE, because the newest entries sit at the HIGHEST indices
  // (verified live: startIndex=totalResults-5 on 2026-08-14 returned
  // CVE-2026-19824 through CVE-2026-73673, all published *that same day*).
  // This is exactly the symptom config/sources.yaml's now-rewritten DISABLED
  // comment named as the reason this source was turned off in the first
  // place -- fix round 1 fixed pagination MECHANICS (bounded requests,
  // honest `capped`) without checking which END of the result set they
  // walked, so the original symptom survived, unchanged, underneath a fix
  // that looked complete and was not.
  //
  // NVD API 2.0 exposes no sort parameter (verified: no documented or
  // discovered query param changes result order) -- direction is fixed, so
  // "paginate from the tail" means computing an explicit `startIndex` near
  // `totalResults` and walking FORWARD from there, not backward from 0.
  // That requires knowing `totalResults` before the first real content page
  // can even be requested, which the old design never needed (it always
  // started at the fixed, known offset 0). `nvdAnchorPageUrl` (below the
  // pagination constants, src/adapters/json.ts) is how this is done, and its
  // own doc comment covers the probe-vs-discard choice, the moving-total
  // race, and the negative-startIndex guard in detail -- this block proves
  // each of those against a controllable mock server.
  // -------------------------------------------------------------------------
  describe('nvd-cve: tail pagination (fix round 2 -- paginating from the correct end)', () => {
    /**
     * General-purpose paginated mock: honors resultsPerPage/startIndex from
     * the query string against a caller-chosen, FIXED totalResults, so it
     * can stand in for either the probe (resultsPerPage=1) or a real
     * content page (resultsPerPage=200) depending on what the code under
     * test actually requests. Still useful post-tail-fix for any test that
     * doesn't need to inspect individual requests.
     */
    function nvdPagedServer(totalResults: number): Promise<string> {
      return serve((req, res) => {
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const resultsPerPage = Number(url.searchParams.get('resultsPerPage') ?? '1');
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

    it('tail fix: retrieves the LAST real-page-budget worth of entries -- the newest, not the oldest -- in exactly NVD_MAX_PAGES_PER_POLL requests total, with honest capped', async () => {
      let requestCount = 0;
      const totalResults = 50000; // an arbitrary large total, comfortably beyond one poll's budget
      const baseUrl = await serve((req, res) => {
        requestCount++;
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const resultsPerPage = Number(url.searchParams.get('resultsPerPage') ?? '1');
        const startIndex = Number(url.searchParams.get('startIndex') ?? '0');
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

      // 1 cheap probe (resultsPerPage=1, learns totalResults) + 4 real
      // content pages x 200/page = 800. NVD_MAX_PAGES_PER_POLL is 5 total
      // requests -- the probe spends one of them, leaving 4 real pages, not
      // 5 -- a deliberate trade (see nvdAnchorPageUrl's doc comment,
      // src/adapters/json.ts, for the probe-vs-discard-a-full-page choice
      // and why the probe is still charged against the same budget).
      expect(requestCount).toBe(5);
      expect(result.items).toHaveLength(800);
      expect(result.skipped).toBe(0);
      // The actual proof this is the FIX, not just a request-count check:
      // the retrieved range is [49200, 50000) -- the highest indices,
      // closest to totalResults -- not [0, 800), which is what the pre-fix
      // code retrieved every single poll (CVE-1999-0095 first, always).
      // Under this mock's synthetic id scheme (id = startIndex+i+1), that
      // range is exactly CVE-2026-49201 through CVE-2026-50000.
      expect(result.items[0]!.title).toBe('CVE-2026-49201');
      expect(result.items[799]!.title).toBe('CVE-2026-50000');
      // Never fabricated: 50,000 total, 800 actually retrieved, 49,200
      // excluded -- but that gap is now the OLD end (indices [0, 49200)),
      // a far less alarming shape than fix round 1's capped, which counted
      // the exact same KIND of gap but at the NEW end (see
      // NVD_MAX_PAGES_PER_POLL's doc comment, src/adapters/json.ts, for the
      // full before/after contrast).
      expect(result.capped).toBe(49200);
    }, 15000);

    it('never sends a negative startIndex, even when totalResults is smaller than the whole real-page budget -- clamps the anchor to 0 and still retrieves the entire (small) set. This is the NORMAL case once the historical bulk-rescore anomaly (NVD_WINDOW_DAYS doc comment) ages out of the window', async () => {
      const totalResults = 3;
      const baseUrl = await serve((req, res) => {
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const startIndex = Number(url.searchParams.get('startIndex') ?? '0');
        // A hard guard, not merely an after-the-fact assertion: the real
        // NVD API 400s on a negative startIndex. A mock that faithfully
        // modeled that would already fail this test outright the moment the
        // clamp regressed, rather than silently returning something
        // plausible for a value NVD itself would have rejected.
        if (startIndex < 0) {
          res.writeHead(400);
          res.end('negative startIndex');
          return;
        }
        const resultsPerPage = Number(url.searchParams.get('resultsPerPage') ?? '1');
        const count = Math.max(0, Math.min(resultsPerPage, totalResults - startIndex));
        const vulnerabilities = Array.from({ length: count }, (_, i) => ({
          cve: { id: `CVE-2026-${String(startIndex + i + 1).padStart(5, '0')}` },
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalResults, vulnerabilities }));
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(result.items).toHaveLength(3);
      expect(result.items.map((i) => i.title)).toEqual(['CVE-2026-00001', 'CVE-2026-00002', 'CVE-2026-00003']);
      expect(result.capped).toBeUndefined();
    });

    it('stops before reaching the real-page budget once a page returns fewer entries than a full page -- the whole (small) catalog is covered, so capped is undefined', async () => {
      const baseUrl = await nvdPagedServer(450); // anchor clamps to 0 (450 < 800); 200 + 200 + 50 -- a short third real page

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(result.items).toHaveLength(450);
      // Fully covered -- nothing excluded, so capped must be undefined, not
      // a fabricated 0 (AdapterResult.capped's own doc comment).
      expect(result.capped).toBeUndefined();
    }, 15000); // 4 real requests (probe + 3 real pages, 3 gaps x 2s)

    it('sends conditional-request headers only on the probe; every real content page is an unconditional GET', async () => {
      const receivedHeaders: Array<Record<string, string | string[] | undefined>> = [];
      const totalResults = 250; // anchor clamps to 0; 2 real pages (200 full, then a short 50) -- 3 requests total
      const baseUrl = await serve((req, res) => {
        receivedHeaders.push(req.headers);
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const resultsPerPage = Number(url.searchParams.get('resultsPerPage') ?? '1');
        const startIndex = Number(url.searchParams.get('startIndex') ?? '0');
        const count = Math.max(0, Math.min(resultsPerPage, totalResults - startIndex));
        const vulnerabilities = Array.from({ length: count }, (_, i) => ({
          cve: { id: `CVE-2026-${String(startIndex + i + 1).padStart(5, '0')}` },
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalResults, vulnerabilities }));
      });

      await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        makeState({ etag: '"prior-nvd-etag"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' }),
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(receivedHeaders).toHaveLength(3);
      expect(receivedHeaders[0]!['if-none-match']).toBe('"prior-nvd-etag"');
      expect(receivedHeaders[0]!['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
      // Every real content page was never conditionally requested --
      // state's validators describe the PROBE's identity (a
      // resultsPerPage=1/startIndex=0 request), not a differently-shaped
      // page that was never separately validated on any prior poll.
      expect(receivedHeaders[1]!['if-none-match']).toBeUndefined();
      expect(receivedHeaders[1]!['if-modified-since']).toBeUndefined();
      expect(receivedHeaders[2]!['if-none-match']).toBeUndefined();
      expect(receivedHeaders[2]!['if-modified-since']).toBeUndefined();
    }, 15000);

    it('a 304 on the probe short-circuits before any real page is attempted', async () => {
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

    it('a failure fetching the first REAL page (right after a successful probe) propagates and rejects the whole fetch', async () => {
      let requestCount = 0;
      const baseUrl = await serve((req, res) => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ totalResults: 999, vulnerabilities: [{ cve: { id: 'CVE-2026-00001' } }] }));
          return;
        }
        res.writeHead(503);
        res.end('unavailable');
      });

      await expect(
        jsonAdapter.fetch(makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }), null, new Date('2026-08-14T03:00:00.000Z')),
      ).rejects.toThrow();
      expect(requestCount).toBe(2);
    }, 15000);

    it('malformed entries on a REAL page are counted in skipped and do not stop pagination; the probe entry is never counted or included in items, even though it would otherwise parse fine', async () => {
      const totalResults = 200; // anchor clamps to 0 -- one real page covers the whole set
      const realDataset: unknown[] = [
        { cve: { id: 'CVE-2026-00001' } },
        { cve: { id: '' } }, // malformed: blank id
        'not even an object', // malformed: not an object
        ...Array.from({ length: 197 }, (_, i) => ({ cve: { id: `CVE-2026-${i + 2}` } })),
      ];
      let requestCount = 0;
      const baseUrl = await serve((req, res) => {
        requestCount++;
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const resultsPerPage = Number(url.searchParams.get('resultsPerPage') ?? '1');
        const startIndex = Number(url.searchParams.get('startIndex') ?? '0');
        if (resultsPerPage === 1) {
          // The probe -- a perfectly well-formed entry, deliberately NOT
          // drawn from realDataset, so the assertion below can prove it
          // never reaches `items`.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ totalResults, vulnerabilities: [{ cve: { id: 'CVE-1999-00001' } }] }));
          return;
        }
        const vulnerabilities = realDataset.slice(startIndex, startIndex + resultsPerPage);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalResults, vulnerabilities }));
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      // probe + a full 200-entry real page + a short, empty real page
      // confirming nothing more remains.
      expect(requestCount).toBe(3);
      expect(result.items).toHaveLength(198); // 200 raw - 2 malformed
      expect(result.skipped).toBe(2);
      expect(result.items.some((i) => i.title === 'CVE-1999-00001')).toBe(false); // the probe's own entry never surfaces
      expect(result.capped).toBeUndefined(); // the one real page's 200 raw entries (malformed or not) fully cover the 200-total window
    }, 15000);

    it("when the probe's totalResults is unreadable, no real page is fetched -- degrades to an honestly-empty, uncapped result rather than guessing an anchor", async () => {
      let requestCount = 0;
      const baseUrl = await serve((_req, res) => {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // No totalResults field at all.
        res.end(JSON.stringify({ vulnerabilities: [{ cve: { id: 'CVE-1999-00001' } }] }));
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      expect(requestCount).toBe(1);
      expect(result.items).toEqual([]);
      expect(result.skipped).toBe(0);
      expect(result.capped).toBeUndefined();
    });

    it('a totalResults that GROWS between requests never creates a gap in what is fetched, and capped reflects the FRESHEST total observed, not the stale probe-time reading', async () => {
      // Simulates a live, continuously-appending catalog: each response's
      // totalResults is one higher than the previous response's, while the
      // CONTENT at any given index never changes (an append-only model,
      // matching real NVD behavior -- new CVEs extend the tail, they do not
      // renumber earlier entries).
      let callCount = 0;
      const requestedStartIndexes: number[] = [];
      const baseUrl = await serve((req, res) => {
        const url = new URL(req.url ?? '/', 'http://placeholder.test');
        const resultsPerPage = Number(url.searchParams.get('resultsPerPage') ?? '1');
        const startIndex = Number(url.searchParams.get('startIndex') ?? '0');
        requestedStartIndexes.push(startIndex);
        const totalResults = 1000 + callCount; // grows by 1 on every request, including the probe
        callCount++;
        const count = Math.max(0, Math.min(resultsPerPage, totalResults - startIndex));
        const vulnerabilities = Array.from({ length: count }, (_, i) => ({
          cve: { id: `CVE-2026-${String(startIndex + i + 1).padStart(5, '0')}` },
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalResults, vulnerabilities }));
      });

      const result = await jsonAdapter.fetch(
        makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` }),
        null,
        new Date('2026-08-14T03:00:00.000Z'),
      );

      // The anchor was computed ONCE, from the probe's own reading
      // (totalResults = 1000 there), NOT recomputed mid-walk against every
      // subsequent, ever-larger reading -- recomputing on every page would
      // shift where LATER pages start, which can leave a gap between a page
      // already fetched and the next one. Silently dropping a middle slice
      // is a worse failure than lagging the true tail by a handful of
      // entries for one poll. See nvdAnchorPageUrl's doc comment
      // (src/adapters/json.ts) for the full reasoning, including why
      // entries that arrive mid-poll are still guaranteed to be picked up
      // next poll rather than lost for good.
      expect(requestedStartIndexes).toEqual([0, 200, 400, 600, 800]);
      expect(result.items).toHaveLength(800);
      // capped uses the LATEST totalResults this poll actually observed
      // (from the last real page, where totalResults had reached 1004) --
      // not the stale probe-time reading of 1000, which would have
      // under-reported the gap as 200 instead of the honest 204: 200
      // old-end entries below the anchor, PLUS the 4 new entries that
      // arrived after the anchor was fixed and so were never requested this
      // poll -- both are real, neither is hidden.
      expect(result.capped).toBe(204);
    }, 15000);
  });

  // -------------------------------------------------------------------------
  // Fix (M2 Wave 1, urgent -- blocking the acceptance ingest): nvd-cve's
  // `cve.published` carries NO UTC offset and NO trailing "Z" at all -- e.g.
  // "2026-08-12T20:17:51.690" -- which src/normalize/item.ts's parseIso8601
  // deliberately refuses to interpret: an offset-less ISO-8601 date-time is,
  // per the ECMA-262 Date Time String Format, local time in whatever zone the
  // running process happens to be in, and this is a self-hosted server that
  // could run anywhere. Live-verified (2026-08-14, see
  // fix-nvd-null-dates-report.md) that this refusal, entirely correct on its
  // own terms, meant every single one of 800 items from a real, unmocked poll
  // normalized to a null published_at -- and independently live-verified,
  // freshly, that this field genuinely IS UTC: a just-published CVE's raw
  // value, read as UTC, is minutes in the past (plausible); read as any zone
  // west of UTC (e.g. US/Eastern, -04:00 in August), it becomes a timestamp
  // in the FUTURE, which a just-published CVE cannot be.
  //
  // The fix lives in nvd-cve's OWN mapper (`nvdPublishedAtUtc`,
  // src/adapters/json.ts), not in the shared normalizeItem/parseIso8601 --
  // that parser's refusal is correct for every OTHER source (an offset-less
  // date-time from a source whose zone has NOT been independently verified is
  // genuinely ambiguous), and hoisting NVD-specific knowledge into the shared
  // parser would make the next source that happens to emit the identical
  // bare shape silently misread as UTC too, with no source-specific
  // verification behind that guess at all. Every test below proves a piece of
  // that: the fix works, it is UTC (not merely a no-op that happens to look
  // right), it doesn't corrupt an already-offset value if NVD's schema ever
  // changes, and it does not leak into any other source's mapper.
  // -------------------------------------------------------------------------
  describe('fix, null published_at: nvd-cve is UTC (live-verified), applied only to this mapper', () => {
    it('appends "Z" to cve.published\'s bare local-datetime shape; normalizeItem then accepts the result as a correct, non-null UTC instant instead of refusing it', async () => {
      const body = JSON.stringify({
        totalResults: 1,
        vulnerabilities: [
          {
            cve: {
              id: 'CVE-2026-40000',
              // NVD's real shape, live-verified: no offset, no "Z".
              published: '2026-08-12T20:17:51.690',
              descriptions: [{ lang: 'en', value: 'desc' }],
            },
          },
        ],
      });
      const baseUrl = await serveBody(body);
      const source = makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` });

      const result = await jsonAdapter.fetch(source, null, new Date('2026-08-14T03:00:00.000Z'));
      expect(result.items).toHaveLength(1);

      const rawItem = result.items[0]!;
      // The fix lives HERE, at the adapter/RawItem boundary -- the value is
      // already unambiguous by the time normalizeItem ever sees it.
      expect(rawItem.publishedAt).toBe('2026-08-12T20:17:51.690Z');

      const normalized = normalizeItem(rawItem, source, '2026-08-14T03:00:00.000Z');
      expect(normalized.publishedAt).toBe('2026-08-12T20:17:51.690Z');
    });

    it('is provably a UTC interpretation, not a coincidental no-op: the SAME raw digits read as a different zone (US/Eastern, -04:00 in August) produce a materially different -- and for a just-published CVE, impossible -- instant', async () => {
      const rawPublished = '2026-08-12T20:17:51.690';
      const body = JSON.stringify({
        totalResults: 1,
        vulnerabilities: [
          {
            cve: { id: 'CVE-2026-40001', published: rawPublished, descriptions: [{ lang: 'en', value: 'd' }] },
          },
        ],
      });
      const baseUrl = await serveBody(body);
      const source = makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` });

      const result = await jsonAdapter.fetch(source, null, new Date('2026-08-14T03:00:00.000Z'));
      const actual = normalizeItem(result.items[0]!, source, '2026-08-14T03:00:00.000Z');

      // What a WRONG naive local-time-as-US/Eastern reading of the identical
      // raw digits would have produced -- computed independently here, via
      // normalizeItem's own already-correct explicit-offset parsing path,
      // never by re-running the adapter under a different assumed zone.
      const wrongEasternInterpretation = normalizeItem(
        { ...result.items[0]!, publishedAt: `${rawPublished}-04:00` },
        source,
        '2026-08-14T03:00:00.000Z',
      );

      expect(actual.publishedAt).toBe('2026-08-12T20:17:51.690Z');
      expect(wrongEasternInterpretation.publishedAt).toBe('2026-08-13T00:17:51.690Z');
      // The discriminating assertion: had nvd-cve's mapper wrongly assumed a
      // non-UTC zone instead of UTC, this would fail here -- the two values
      // are four hours apart, not coincidentally equal on any host regardless
      // of the test runner's own system timezone (neither computation reads
      // it -- see JsonSourceMapper.buildUrl's doc comment on why a builder
      // never reads the clock itself, the same discipline applied here).
      expect(actual.publishedAt).not.toBe(wrongEasternInterpretation.publishedAt);
    });

    it('does not corrupt a value that already carries an explicit offset or "Z" -- defensive, not observed live, but guards against double-suffixing if NVD\'s schema ever changes', async () => {
      const body = JSON.stringify({
        totalResults: 1,
        vulnerabilities: [
          {
            cve: {
              id: 'CVE-2026-40002',
              published: '2026-08-12T20:17:51.690Z',
              descriptions: [{ lang: 'en', value: 'd' }],
            },
          },
        ],
      });
      const baseUrl = await serveBody(body);
      const source = makeSource({ id: 'nvd-cve', url: `${baseUrl}/feed` });

      const result = await jsonAdapter.fetch(source, null, new Date('2026-08-14T03:00:00.000Z'));
      // Untouched -- not "...690ZZ" or any other corruption of an
      // already-unambiguous value.
      expect(result.items[0]!.publishedAt).toBe('2026-08-12T20:17:51.690Z');

      const normalized = normalizeItem(result.items[0]!, source, '2026-08-14T03:00:00.000Z');
      expect(normalized.publishedAt).toBe('2026-08-12T20:17:51.690Z');
    });

    it('never-guess rule intact elsewhere: the IDENTICAL offset-less shape, passed through a DIFFERENT source\'s mapper (cisa-kev), is left untouched by the adapter and still normalizes to null', async () => {
      const body = JSON.stringify({
        vulnerabilities: [
          {
            cveID: 'CVE-2026-40003',
            vulnerabilityName: 'Hypothetical bare-datetime dateAdded',
            // NOT cisa-kev's real shape (which is bare "YYYY-MM-DD") --
            // deliberately NVD-shaped here, to prove the UTC assumption this
            // fix adds is scoped to nvd-cve's own mapper and does not leak
            // into any other source's mapper or into the shared parser.
            dateAdded: '2026-08-12T20:17:51.690',
            shortDescription: 'd',
          },
        ],
      });
      const baseUrl = await serveBody(body);
      const source = makeSource({ id: 'cisa-kev', url: `${baseUrl}/feed` });

      const result = await jsonAdapter.fetch(source, null);
      // Untouched -- no "Z" appended, because this is not nvd-cve.
      expect(result.items[0]!.publishedAt).toBe('2026-08-12T20:17:51.690');

      const normalized = normalizeItem(result.items[0]!, source, '2026-08-14T03:00:00.000Z');
      // The never-guess rule this fix must not weaken: an offset-less
      // date-time from a source whose zone has not been independently
      // verified still yields null, exactly as before this fix existed.
      expect(normalized.publishedAt).toBeNull();
    });
  });
});

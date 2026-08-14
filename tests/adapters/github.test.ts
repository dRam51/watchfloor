import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSearchRequests,
  CREATED_WITHIN_DAYS,
  DEFAULT_MIN_STARS,
  githubSearchAdapter,
  GitHubSearchConfigError,
  PUSHED_WITHIN_DAYS,
  repoFromSearchItem,
  RESULTS_PER_PAGE,
} from '../../src/adapters/github.ts';
import { GitHubApiError } from '../../src/fetch/github.ts';
import { deriveItemKey } from '../../src/domain/item.ts';
import { makeRepo, repoItemKey } from '../../src/domain/repo.ts';
import { normalizeItem, type RawItem } from '../../src/normalize/item.ts';
import { canonicalizeUrl } from '../../src/normalize/url.ts';
import type { Source } from '../../src/sources/load.ts';
import type { FetchState } from '../../src/db/fetchState.ts';

// ---------------------------------------------------------------------------
// Real local http servers, real captured fixtures, no mocks and no network --
// the same pattern tests/adapters/json.test.ts and tests/fetch/github.test.ts
// established. Every "live" scenario below is a checked-in capture from
// api.github.com replayed over a loopback ephemeral-port server.
//
// Tests that touch the network use ONE topic, deliberately: the adapter issues
// two requests per topic and src/fetch/github.ts spaces requests 2s apart, so a
// nine-topic sweep would cost 34 seconds per test. Query CONSTRUCTION across
// the full topic list is covered by the pure `buildSearchRequests` tests, which
// make no requests at all.
// ---------------------------------------------------------------------------

const openServers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from an ephemeral TCP listener');
  }
  return `http://127.0.0.1:${address.port}/search/repositories`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

// The PAT is the owner's to create and does not exist on this machine. These
// tests set the env var to a fixture-only string to prove the adapter READS it;
// nothing here is or resembles a real credential, and it is always restored.
const TOKEN_ENV = 'WF_GITHUB_TOKEN';
let savedToken: string | undefined;
beforeEach(() => {
  savedToken = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
});
afterEach(() => {
  if (savedToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = savedToken;
});

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', 'github-search', name), 'utf8');
}

function fixtureJson(name: string): { total_count: number; incomplete_results: boolean; items: Record<string, unknown>[] } {
  return JSON.parse(fixture(name));
}

const captured = JSON.parse(fixture('captured-headers.json')) as Record<string, Record<string, string>>;

/** Strips the `_`-prefixed annotation keys so only real HTTP headers are sent. */
function headersOf(name: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(captured[name]!).filter(([k]) => !k.startsWith('_'))),
    'content-type': 'application/json',
    ...overrides,
  };
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'github-repos',
    name: 'GitHub topic search',
    type: 'github_search',
    url: 'https://api.github.com/search/repositories',
    beats: ['repos'],
    weight: 1,
    poll_interval: '6h',
    enabled: true,
    enrichment: true,
    filters: { topics: ['mcp'] },
    ...overrides,
  };
}

function makeState(overrides: Partial<FetchState> = {}): FetchState {
  return {
    sourceId: 'github-repos',
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

const NOW = new Date('2026-08-14T22:00:00.000Z');

/** Serves the same body for every request, with the captured 200 header set. */
function serveFixture(name: string, headers: Record<string, string> = {}): Promise<string> {
  return serve((_req, res) => {
    res.writeHead(200, headersOf('search_200', headers));
    res.end(fixture(name));
  });
}

function qOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('q') ?? '';
}

function raw(item: RawItem): Record<string, unknown> {
  return item.raw as Record<string, unknown>;
}

/**
 * The `Repo` a stored item's raw JSON still yields. Reconstructing it from the
 * PRUNED raw (rather than from the response) is the point: tasks 5 and 6 read
 * `items.raw_json`, never an AdapterResult, so this is the round trip that has
 * to hold.
 */
function repoOf(item: RawItem) {
  const repo = repoFromSearchItem(raw(item));
  if (repo === null) throw new Error(`pruned raw for ${item.title} no longer yields a Repo`);
  return repo;
}

// ---------------------------------------------------------------------------

describe('githubSearchAdapter', () => {
  it('declares its SourceType as "github_search" -- the value that has had no adapter since M1', () => {
    expect(githubSearchAdapter.type).toBe('github_search');
  });

  // -------------------------------------------------------------------------
  // Query construction. Pure: no requests at all, so the whole nine-topic list
  // is exercised here rather than over the wire.
  // -------------------------------------------------------------------------
  describe('buildSearchRequests', () => {
    const NINE = ['llm', 'agents', 'mcp', 'rag', 'ai-security', 'prompt-injection', 'llmops', 'network-automation', 'netdevops'];

    it('builds exactly two requests per topic -- the created half and the pushed half of §4\'s OR', () => {
      const requests = buildSearchRequests(makeSource({ filters: { topics: NINE } }), NOW);
      expect(requests).toHaveLength(18);
      expect(new Set(requests.map((r) => r.topic))).toEqual(new Set(NINE));
      for (const topic of NINE) {
        const halves = requests.filter((r) => r.topic === topic).map((r) => r.half);
        expect(halves.sort()).toEqual(['created', 'pushed']);
      }
    });

    // Settled by the live run, not by taste: unauthenticated, 10 of these 18
    // requests get through before the budget refuses the eleventh. Grouping a
    // topic's two halves together would mean five complete topics and four --
    // on the observed run llm, agents, mcp and rag -- contributing nothing at
    // all. Grouping by HALF instead means every topic is represented.
    it('issues every created half before any pushed half, so a truncated sweep still covers every topic', () => {
      const requests = buildSearchRequests(makeSource({ filters: { topics: NINE } }), NOW);
      expect(requests.slice(0, 9).every((r) => r.half === 'created')).toBe(true);
      expect(requests.slice(9).every((r) => r.half === 'pushed')).toBe(true);

      // What an unauthenticated poll actually gets through: 10 of 18.
      const truncated = requests.slice(0, 10);
      expect(new Set(truncated.map((r) => r.topic))).toEqual(new Set(NINE));
    });

    it('anchors both halves to the injected now, at day granularity, per §4\'s 180 and 14 days', () => {
      const [created, pushed] = buildSearchRequests(makeSource({ filters: { topics: ['mcp'] } }), NOW);
      expect(created!.q).toContain(`created:>=${'2026-02-15'}`);
      expect(pushed!.q).toContain(`pushed:>=${'2026-07-31'}`);
      expect(CREATED_WITHIN_DAYS).toBe(180);
      expect(PUSHED_WITHIN_DAYS).toBe(14);
    });

    it('reads now, never the wall clock -- a different now moves both cutoffs', () => {
      const [created, pushed] = buildSearchRequests(
        makeSource({ filters: { topics: ['mcp'] } }),
        new Date('2027-01-01T00:00:00.000Z'),
      );
      expect(created!.q).toContain('created:>=2026-07-05');
      expect(pushed!.q).toContain('pushed:>=2026-12-18');
    });

    it('carries the topic, the star floor and archived:false on every query', () => {
      for (const request of buildSearchRequests(makeSource({ filters: { topics: ['mcp'] } }), NOW)) {
        expect(request.q).toContain('topic:mcp');
        expect(request.q).toContain(`stars:>=${DEFAULT_MIN_STARS}`);
        expect(request.q).toContain('archived:false');
      }
    });

    it('takes the star floor from config when one is set, and defaults to 10 when it is not', () => {
      const [withFloor] = buildSearchRequests(makeSource({ filters: { topics: ['mcp'], min_stars: 250 } }), NOW);
      expect(withFloor!.q).toContain('stars:>=250');
      expect(DEFAULT_MIN_STARS).toBe(10);
    });

    it('sorts by stars descending and asks for one page of RESULTS_PER_PAGE', () => {
      const [first] = buildSearchRequests(makeSource({ filters: { topics: ['mcp'] } }), NOW);
      const url = new URL(first!.url);
      expect(url.searchParams.get('sort')).toBe('stars');
      expect(url.searchParams.get('order')).toBe('desc');
      expect(url.searchParams.get('per_page')).toBe(String(RESULTS_PER_PAGE));
      expect(url.searchParams.get('page')).toBeNull();
    });

    // Rotation exists because 18 requests exceed an unauthenticated minute's
    // entire search budget (10). Without it the tail of the topic list would
    // never be polled at all -- a whole category of repo silently dropped.
    it('rotates the topic order with time, so the pushed halves a truncated sweep reaches are not always the same ones', () => {
      const source = makeSource({ filters: { topics: NINE } });
      const starts = new Set<string>();
      for (let poll = 0; poll < 6; poll++) {
        const requests = buildSearchRequests(source, new Date(NOW.getTime() + poll * 6 * 60 * 60 * 1000));
        starts.add(requests[0]!.topic);
        // Rotation reorders; it never drops or duplicates.
        expect(new Set(requests.map((r) => r.topic))).toEqual(new Set(NINE));
        expect(requests).toHaveLength(18);
      }
      expect(starts.size).toBeGreaterThan(1);
    });

    // The failure this pins is silent and was nearly shipped: with a rotation
    // period that evenly divides the poll interval, the offset advances by a
    // constant, and that constant is ZERO whenever it is a multiple of the
    // topic count -- nine topics every nine hours, six every six, three every
    // three. Rotation then never rotates and the same tail is skipped forever.
    // Measured over this same grid, a 60-minute period freezes in 60
    // combinations; TOPIC_ROTATION_PERIOD_MS (13 minutes, prime, dividing none
    // of these intervals) freezes in none.
    it.each([15, 30, 60, 180, 360, 720, 1440])(
      'never freezes rotation at a %i-minute poll interval, for any topic count',
      (intervalMinutes) => {
        for (let topicCount = 2; topicCount <= 12; topicCount++) {
          const topics = Array.from({ length: topicCount }, (_, i) => `t${i}`);
          const source = makeSource({ filters: { topics } });
          for (const phaseMinutes of [0, 5, 7, 11]) {
            const starts = new Set<string>();
            for (let poll = 0; poll < 12; poll++) {
              const at = new Date(NOW.getTime() + (phaseMinutes + poll * intervalMinutes) * 60_000);
              starts.add(buildSearchRequests(source, at)[0]!.topic);
            }
            expect(starts.size, `frozen at ${topicCount} topics, phase ${phaseMinutes}m`).toBeGreaterThan(1);
          }
        }
      },
    );

    it('is deterministic for the same now -- rotation is a function of the clock, not of a counter', () => {
      const source = makeSource({ filters: { topics: NINE } });
      expect(buildSearchRequests(source, NOW)).toEqual(buildSearchRequests(source, NOW));
    });

    it('refuses a source with no topics -- a second gate behind the config schema\'s own', () => {
      expect(() => buildSearchRequests(makeSource({ filters: {} }), NOW)).toThrow(GitHubSearchConfigError);
      expect(() => buildSearchRequests(makeSource({ filters: undefined }), NOW)).toThrow(GitHubSearchConfigError);
    });

    // src/fetch/github.ts classifies the rate-limit resource from the request
    // PATHNAME. A url whose path is not under /search would be gated against
    // `core` -- a 6x larger unauthenticated budget -- and quietly overrun the
    // real one. Exactly the bug task 1 fixed for pagination links.
    it('refuses a source url that is not a /search path, because the client would bill it to the wrong budget', () => {
      expect(() => buildSearchRequests(makeSource({ url: 'https://api.github.com/repos/a/b' }), NOW)).toThrow(
        GitHubSearchConfigError,
      );
    });

    it('preserves the configured origin, so a test (or a GitHub Enterprise host) can point it elsewhere', () => {
      const [first] = buildSearchRequests(makeSource({ url: 'http://127.0.0.1:9999/search/repositories' }), NOW);
      expect(new URL(first!.url).origin).toBe('http://127.0.0.1:9999');
    });
  });

  // -------------------------------------------------------------------------
  // The real captured fixture.
  // -------------------------------------------------------------------------
  describe('real fixture: topic:mcp, created half (captured live 2026-08-14)', () => {
    it('emits one RawItem per repo and reports no defects', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const result = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);

      // 12 repos, both halves served the same fixture, deduped back to 12.
      expect(result.items).toHaveLength(12);
      expect(result.skipped).toBe(0);
      expect(result.notModified).toBe(false);
    });

    it('addresses the repo ROOT, canonicalized, so the item_key equals repoItemKey -- computable before ingest', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      const first = items[0]!;

      expect(first.url).toBe(canonicalizeUrl('https://github.com/Graphify-Labs/graphify'));

      const repo = makeRepo({
        githubId: 1,
        owner: 'Graphify-Labs',
        name: 'graphify',
        description: null,
        language: null,
        licenseSpdxId: null,
        stars: 0,
        openIssuesAndPullRequests: 0,
        lastCommitAt: null,
        isFork: false,
        isArchived: false,
        readmeFirstParagraph: null,
      });
      expect(deriveItemKey(canonicalizeUrl(first.url))).toBe(repoItemKey(repo));
    });

    it('titles the item with owner/name and attributes it to the owner', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(items[0]!.title).toBe('Graphify-Labs/graphify');
      expect(items[0]!.author).toBe('Graphify-Labs');
    });

    // A repo is not "published" once. pushed_at is the only date on it that
    // means "something happened here recently", and it is what §7's row renders
    // as last-commit age -- so the lane's displayed date and the decay baseline
    // agree. created_at would put every repo in the lane up to 180 days into
    // the past against a 72h signal half-life, which is a dead lane.
    it('dates the item by pushed_at, not created_at, and normalizes it to a canonical instant', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(items[0]!.publishedAt).toBe('2026-08-14T19:17:38Z');

      const normalized = normalizeItem(items[0]!, makeSource(), '2026-08-14T22:00:00.000Z');
      expect(normalized.publishedAt).toBe('2026-08-14T19:17:38.000Z');
      expect(normalized.beats).toEqual(['repos']);
    });

    it('carries the repo description as the summary, capped by the normalizer at 300 characters', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);

      // giancarloerra/SocratiCode's real description is 350 characters.
      const long = items.find((i) => i.title === 'giancarloerra/SocratiCode')!;
      expect(long.summary!.length).toBe(350);
      expect(normalizeItem(long, makeSource(), '2026-08-14T22:00:00.000Z').summaryRaw!.length).toBeLessThanOrEqual(300);
    });

    // Task 5 computes velocity from star snapshots. The search response already
    // carries stargazers_count for every repo, so a snapshot costs no extra
    // request -- but only if the count actually survives into stored raw.
    it('keeps stargazers_count and the repo identity in raw, so a snapshot costs no extra request', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      const first = raw(items[0]!);

      expect(first.stargazers_count).toBe(106360);
      expect(first.id).toBe(fixtureJson('search-mcp-created.json').items[0]!.id);
      expect(first.pushed_at).toBe('2026-08-14T19:17:38Z');
      expect(first.created_at).toBeTypeOf('string');
      expect(first.topics).toBeInstanceOf(Array);
      expect((first.owner as Record<string, unknown>).login).toBe('Graphify-Labs');
      expect((first.license as Record<string, unknown>).spdx_id).toBe('Apache-2.0');
    });

    // A GitHub search item is ~5.8 KB, of which roughly 30 keys are REST
    // endpoint templates mechanically derivable from full_name. `items` is
    // append-only with no dedupe, so every poll re-stores all of it.
    it('prunes the REST url templates out of raw, keeping html_url and every data field', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      const first = raw(items[0]!);

      const templates = Object.keys(first).filter((k) => k.endsWith('_url') && k !== 'html_url');
      expect(templates).toEqual([]);
      expect(first.html_url).toBe('https://github.com/Graphify-Labs/graphify');

      const original = fixtureJson('search-mcp-created.json').items[0]!;
      expect(JSON.stringify(first).length).toBeLessThan(JSON.stringify(original).length / 2);
    });

    it('maps NOASSERTION to no license rather than rendering it as one', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      const noassertion = items.find((i) => i.title === 'mksglu/context-mode')!;
      expect(repoOf(noassertion).licenseSpdxId).toBeNull();
      expect((raw(noassertion).license as Record<string, unknown>).spdx_id).toBe('NOASSERTION');
    });

    it('tolerates a repo with no detected language and no license at all', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      const bare = items.find((i) => i.title === 'lintsinghua/claude-code-book')!;
      expect(repoOf(bare).language).toBeNull();
      expect(repoOf(bare).licenseSpdxId).toBeNull();
    });

    it('leaves the pruned raw rich enough to rebuild the whole Repo, which is what tasks 5 and 6 read', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      const first = repoOf(items[0]!);
      expect(first.fullName).toBe('Graphify-Labs/graphify');
      expect(first.stars).toBe(106360);
      expect(first.openIssuesAndPullRequests).toBeTypeOf('number');
      expect(first.lastCommitAt).toBe('2026-08-14T19:17:38.000Z');
      // The search response has no README, so this is null for every repo here.
      // §4's no-README suppression therefore cannot be applied at this layer.
      expect(first.readmeExcerpt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Volume, dedupe and the small-topic case.
  // -------------------------------------------------------------------------
  it('deduplicates a repo returned by more than one query, keyed on GitHub\'s numeric id', async () => {
    // Both halves of topic:mcp are served the identical 12-repo fixture, so
    // every repo arrives twice.
    const baseUrl = await serveFixture('search-mcp-created.json');
    const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
    const ids = items.map((i) => raw(i).id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(items).toHaveLength(12);
  });

  it('never mistakes the server\'s total_count for what it actually retrieved', async () => {
    const baseUrl = await serveFixture('search-mcp-created.json');
    const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
    expect(fixtureJson('search-mcp-created.json').total_count).toBe(3644);
    expect(items).toHaveLength(12);
  });

  // The star floor's whole job. topic:netdevops has 103 repos; 34 created in
  // the last 180 days; exactly ONE of those clears 10 stars. Without a floor
  // this half of that topic would be 34 rows of empty scaffolding.
  it('handles a topic that yields a single repo once the floor is applied', async () => {
    const baseUrl = await serveFixture('search-netdevops-created.json');
    const { items } = await githubSearchAdapter.fetch(
      makeSource({ url: baseUrl, filters: { topics: ['netdevops'] } }),
      null,
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('gesh75/multivendor-ai-network-lab');
    expect(repoOf(items[0]!).stars).toBe(11);
  });

  it('treats an empty result set as a healthy quiet poll, not a failure', async () => {
    const baseUrl = await serveFixture('search-empty.json');
    const result = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
    expect(result.items).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.notModified).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Conditional requests: there are none on this endpoint.
  // -------------------------------------------------------------------------
  describe('the Search API supports no conditional requests', () => {
    it('reports etag and lastModified as null, because the response carries neither', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const result = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(result.etag).toBeNull();
      expect(result.lastModified).toBeNull();
      expect(result.notModified).toBe(false);
    });

    it('does NOT carry a prior state\'s validators forward -- that would claim a revalidation this endpoint cannot do', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const state = makeState({ etag: '"stale"', lastModified: 'Fri, 14 Aug 2026 21:02:14 GMT' });
      const result = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), state, NOW);
      expect(result.etag).toBeNull();
      expect(result.lastModified).toBeNull();
    });

    it('sends no If-None-Match even when prior state has one', async () => {
      const seen: (string | undefined)[] = [];
      const baseUrl = await serve((req, res) => {
        seen.push(req.headers['if-none-match'] as string | undefined);
        res.writeHead(200, headersOf('search_200'));
        res.end(fixture('search-empty.json'));
      });
      await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), makeState({ etag: '"stale"' }), NOW);
      expect(seen).toEqual([undefined, undefined]);
    });
  });

  // -------------------------------------------------------------------------
  // §4's suppression list, the half of it that is knowable here.
  // -------------------------------------------------------------------------
  describe('§4 suppression: forks and archived repos', () => {
    it('asks GitHub to exclude archived repos server-side, so they never occupy a result slot', async () => {
      const seen: string[] = [];
      const baseUrl = await serve((req, res) => {
        seen.push(qOf(req));
        res.writeHead(200, headersOf('search_200'));
        res.end(fixture('search-empty.json'));
      });
      await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(seen.every((q) => q.includes('archived:false'))).toBe(true);
    });

    // Synthetic, and flagged as such: the live captures contain no fork and no
    // archived repo, because GitHub's repo search excludes forks by default
    // (measured: `fork:true` widens topic:llm+pushed from 24,197 to 24,414) and
    // `archived:false` removes the rest (24,197 -> 24,132). The local check is
    // the backstop for if either of those server-side behaviours ever changes.
    it('drops a fork or an archived repo locally too, and counts it in filtered rather than skipped', async () => {
      const base = fixtureJson('search-mcp-created.json');
      const body = {
        ...base,
        items: [
          { ...base.items[0]!, fork: true },
          { ...base.items[1]!, archived: true },
          base.items[2]!,
        ],
      };
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, headersOf('search_200'));
        res.end(JSON.stringify(body));
      });

      const result = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('mukul975/Anthropic-Cybersecurity-Skills');
      // 2 excluded per query, across both halves of the one topic.
      expect(result.filtered).toBe(4);
      expect(result.skipped).toBe(0);
    });

    // The trap: intrinsicSuppressionReasons ALSO reports `no_readme`, and the
    // search response has no README for anybody. Applying it wholesale here
    // would empty the lane while looking like correct reuse.
    it('does not apply the no-README rule here -- every repo would match it and the lane would be empty', async () => {
      const baseUrl = await serveFixture('search-mcp-created.json');
      const { items } = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(items).toHaveLength(12);
      expect(items.every((i) => repoOf(i).readmeExcerpt === null)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Defective entries.
  // -------------------------------------------------------------------------
  describe('one bad entry never takes down the batch', () => {
    it('skips an entry with no usable identity and keeps its neighbours', async () => {
      const base = fixtureJson('search-mcp-created.json');
      const body = {
        ...base,
        items: [
          base.items[0]!,
          { ...base.items[1]!, id: 'not-a-number' },
          { ...base.items[2]!, owner: null },
          { ...base.items[3]!, name: '' },
          'not an object at all',
          base.items[4]!,
        ],
      };
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, headersOf('search_200'));
        res.end(JSON.stringify(body));
      });

      const result = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(result.items).toHaveLength(2);
      expect(result.skipped).toBe(8); // 4 defects x both halves of the one topic
    });

    // A repo that has never been pushed to legitimately reports pushed_at:
    // null, which is "no last commit". A pushed_at that is present but not
    // GitHub's documented shape is a different thing entirely -- storing it as
    // null would file a live repo as one that has never been touched.
    it('accepts a null pushed_at as "never pushed" but skips a malformed one', async () => {
      const base = fixtureJson('search-mcp-created.json');
      const body = {
        ...base,
        items: [
          { ...base.items[0]!, pushed_at: null },
          { ...base.items[1]!, pushed_at: 'last Tuesday' },
        ],
      };
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, headersOf('search_200'));
        res.end(JSON.stringify(body));
      });

      const result = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(result.items).toHaveLength(1);
      expect(repoOf(result.items[0]!).lastCommitAt).toBeNull();
      expect(result.items[0]!.publishedAt).toBeNull();
      expect(result.skipped).toBe(2);
    });

    it('throws when the whole response is not a search envelope at all', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(200, headersOf('search_200'));
        res.end('{"message":"Not Found"}');
      });
      await expect(githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW)).rejects.toThrow(/items/);
    });
  });

  // -------------------------------------------------------------------------
  // GitHub's refusal of §4's OR, replayed.
  // -------------------------------------------------------------------------
  it('surfaces a 422 as a real failure -- this is the response §4\'s literal OR earns (captured live)', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(422, headersOf('search_422_or'));
      res.end(fixture('search-or-422.json'));
    });
    await expect(githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW)).rejects.toThrow(GitHubApiError);

    // The captured body is the evidence for why this adapter issues two
    // queries per topic instead of one.
    const body = JSON.parse(fixture('search-or-422.json'));
    expect(body.errors[0].message).toContain('Logical operators only apply to text, not to qualifiers');
  });

  // -------------------------------------------------------------------------
  // Rate limits.
  // -------------------------------------------------------------------------
  describe('rate limits', () => {
    // Real header shape, counter adjusted to 0 -- see the fixture's _README for
    // why an exhausted response is not captured live. The reset instant is also
    // pushed far into the future: the captured one is minutes after the capture
    // and therefore already past, and src/fetch/github.ts deliberately clears a
    // spent budget once its reset has elapsed, which would make this test's
    // outcome depend on the wall clock.
    const exhausted = {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-used': '10',
      'x-ratelimit-reset': '4102444800',
    };

    it('returns what it gathered when the budget runs out mid-sweep, rather than failing the whole poll', async () => {
      let calls = 0;
      const baseUrl = await serve((_req, res) => {
        calls++;
        res.writeHead(200, headersOf('search_200', exhausted));
        res.end(fixture('search-mcp-created.json'));
      });

      const result = await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      // The first query succeeded and reported a spent budget; the second was
      // refused locally before it was ever sent.
      expect(calls).toBe(1);
      expect(result.items).toHaveLength(12);
    });

    it('fails the poll when the budget was already spent before a single query got through', async () => {
      const baseUrl = await serve((_req, res) => {
        res.writeHead(403, headersOf('search_200', exhausted));
        res.end('{"message":"API rate limit exceeded"}');
      });
      await expect(githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW)).rejects.toThrow(GitHubApiError);
    });
  });

  // -------------------------------------------------------------------------
  // Auth mode.
  // -------------------------------------------------------------------------
  describe('authenticated and unauthenticated are both real modes', () => {
    it('sends no Authorization header when WF_GITHUB_TOKEN is absent', async () => {
      const seen: (string | undefined)[] = [];
      const baseUrl = await serve((req, res) => {
        seen.push(req.headers.authorization as string | undefined);
        res.writeHead(200, headersOf('search_200'));
        res.end(fixture('search-empty.json'));
      });
      await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(seen).toEqual([undefined, undefined]);
    });

    it('sends WF_GITHUB_TOKEN as a Bearer credential when one is configured', async () => {
      process.env[TOKEN_ENV] = 'ghp_fixture_only';
      const seen: (string | undefined)[] = [];
      const baseUrl = await serve((req, res) => {
        seen.push(req.headers.authorization as string | undefined);
        res.writeHead(200, headersOf('search_200'));
        res.end(fixture('search-empty.json'));
      });
      await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null, NOW);
      expect(seen).toEqual(['Bearer ghp_fixture_only', 'Bearer ghp_fixture_only']);
    });

    it('never leaks the token into a thrown error', async () => {
      process.env[TOKEN_ENV] = 'ghp_fixture_only_secret';
      const baseUrl = await serve((_req, res) => {
        res.writeHead(500, headersOf('search_200'));
        res.end('{}');
      });

      const error = await githubSearchAdapter
        .fetch(makeSource({ url: baseUrl }), null, NOW)
        .then(() => null, (e: unknown) => e);
      const serialized = [
        String((error as Error).message),
        String((error as Error).stack),
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      ].join('\n');
      expect(serialized).not.toContain('ghp_fixture_only_secret');
    });
  });

  it('defaults now to the real clock when the scheduler omits it', async () => {
    const seen: string[] = [];
    const baseUrl = await serve((req, res) => {
      seen.push(qOf(req));
      res.writeHead(200, headersOf('search_200'));
      res.end(fixture('search-empty.json'));
    });
    await githubSearchAdapter.fetch(makeSource({ url: baseUrl }), null);
    expect(seen[0]).toMatch(/created:>=\d{4}-\d{2}-\d{2}/);
  });
});

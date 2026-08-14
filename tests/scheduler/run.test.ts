import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { getFetchState, recordFailure, isEligible, MAX_BACKOFF_MS } from '../../src/db/fetchState.ts';
import { getCurrentItem, deriveItemKey, InvalidTimestampError } from '../../src/domain/item.ts';
import { canonicalizeUrl } from '../../src/normalize/url.ts';
import type { RawItem } from '../../src/normalize/item.ts';
import type { Source } from '../../src/sources/load.ts';
import type { Adapter, AdapterResult } from '../../src/adapters/types.ts';
import {
  runPollCycle,
  parsePollIntervalMs,
  InvalidPollIntervalError,
  UnsupportedSourceTypeError,
  type SchedulerAdapterRegistry,
} from '../../src/scheduler/run.ts';

// ---------------------------------------------------------------------------
// Test infrastructure -- real temp-file SQLite (mkdtempSync) and real
// node:http loopback servers throughout. No mocks, no network: matches every
// other test file in this suite (see tests/db/fetchState.test.ts,
// tests/fetch/robots.test.ts, tests/fetch/http.test.ts).
//
// The scheduler is tested against the `Adapter` interface (src/adapters/
// types.ts), not against the concrete rss/json/newsSitemap/googleNews
// adapters -- those have their own dedicated fixture-based test suites
// already. A hand-written Adapter here is a real, full implementation of
// that interface (not a mocking-framework stub), the same shape production
// code uses; it just returns canned data or throws on purpose, so these
// tests can pin the SCHEDULER's own orchestration (eligibility, robots
// gating, 304 short-circuiting, per-source isolation, backoff) independent
// of any one adapter's parsing quirks.
// ---------------------------------------------------------------------------

const openDbs: Db[] = [];
function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  openDbs.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

function startServer(handler: RequestListener): Promise<{ server: Server; baseUrl: string }> {
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
async function serve(handler: RequestListener): Promise<string> {
  const { server, baseUrl } = await startServer(handler);
  openServers.push(server);
  return baseUrl;
}

afterEach(async () => {
  while (openDbs.length) closeDb(openDbs.pop()!);
  await Promise.all(openServers.splice(0).map(closeServer));
});

const ALLOW_ALL_ROBOTS_TXT = 'User-agent: *\nDisallow:\n';
const DENY_ALL_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/**
 * A server that answers /robots.txt permissively and 404s everything else.
 * Sufficient for every test whose adapter is canned (never calls
 * politeFetch itself), which is most of them -- only fetchRobots's own
 * network call is real in those cases.
 */
async function servePermissive(): Promise<string> {
  return serve((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(ALLOW_ALL_ROBOTS_TXT);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

let sourceCounter = 0;
function makeSource(overrides: Partial<Source> & { url: string }): Source {
  sourceCounter++;
  return {
    id: `src-${sourceCounter}`,
    name: `Source ${sourceCounter}`,
    type: 'rss',
    beats: ['cyber'],
    weight: 1,
    poll_interval: '15m',
    enabled: true,
    ...overrides,
  };
}

function rawItem(url: string, title = 'Title'): RawItem {
  return { url, title, publishedAt: null, summary: null, author: null, raw: {} };
}

function cannedAdapter(type: Source['type'], impl: Adapter['fetch']): Adapter {
  return { type, fetch: impl };
}

function successAdapter(type: Source['type'], items: RawItem[], extra: Partial<AdapterResult> = {}): Adapter {
  return cannedAdapter(type, async () => ({
    items,
    etag: null,
    lastModified: null,
    notModified: false,
    ...extra,
  }));
}

function throwingAdapter(type: Source['type'], error: Error): Adapter {
  return cannedAdapter(type, async () => {
    throw error;
  });
}

function unusedAdapter(type: Source['type']): Adapter {
  return cannedAdapter(type, async () => {
    throw new Error(`unused '${type}' adapter invoked -- this test did not expect a fetch of this type`);
  });
}

/** A full five-key SchedulerAdapterRegistry, every key defaulting to an adapter that throws if actually called -- override only the key(s) a given test needs. */
function registry(overrides: Partial<SchedulerAdapterRegistry> = {}): SchedulerAdapterRegistry {
  return {
    rss: unusedAdapter('rss'),
    atom: unusedAdapter('atom'),
    json: unusedAdapter('json'),
    news_sitemap: unusedAdapter('news_sitemap'),
    google_news: unusedAdapter('google_news'),
    ...overrides,
  };
}

const NOW = '2026-08-13T12:00:00.000Z';

// ---------------------------------------------------------------------------
// THE headline test, written first per this task's brief: "one dead feed
// must never take down the run" is the milestone's central promise.
// ---------------------------------------------------------------------------

describe('runPollCycle -- one dead feed does not take down the run', () => {
  it('three sources, the middle one throws: the other two still ingest and the failure is recorded', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();

    const urlA = `${baseUrl}/a/1`;
    const urlC = `${baseUrl}/c/1`;
    const boom = new Error('adapter exploded');

    // Three distinct source TYPES so each can be wired to its own canned
    // adapter behavior via the registry (which dispatches by type, not by
    // source id).
    const sourceA = makeSource({ id: 'src-a', type: 'rss', url: `${baseUrl}/feed-a` });
    const sourceB = makeSource({ id: 'src-b', type: 'json', url: `${baseUrl}/feed-b` });
    const sourceC = makeSource({ id: 'src-c', type: 'news_sitemap', url: `${baseUrl}/feed-c` });

    const adapters = registry({
      rss: successAdapter('rss', [rawItem(urlA, 'A item')]),
      json: throwingAdapter('json', boom),
      news_sitemap: successAdapter('news_sitemap', [rawItem(urlC, 'C item')]),
    });

    const report = await runPollCycle(db, [sourceA, sourceB, sourceC], adapters, NOW);

    expect(report.sources).toHaveLength(3);
    const [outcomeA, outcomeB, outcomeC] = report.sources;

    expect(outcomeA?.sourceId).toBe('src-a');
    expect(outcomeA?.kind).toBe('success');
    expect(outcomeA?.itemCount).toBe(1);

    expect(outcomeC?.sourceId).toBe('src-c');
    expect(outcomeC?.kind).toBe('success');
    expect(outcomeC?.itemCount).toBe(1);

    expect(outcomeB?.sourceId).toBe('src-b');
    expect(outcomeB?.kind).toBe('failure');
    expect(outcomeB?.itemCount).toBe(0);
    expect(outcomeB?.error).toContain('adapter exploded');

    // The healthy sources' items genuinely landed in SQLite.
    expect(getCurrentItem(db, deriveItemKey(canonicalizeUrl(urlA)))).not.toBeNull();
    expect(getCurrentItem(db, deriveItemKey(canonicalizeUrl(urlC)))).not.toBeNull();

    // The failure was actually recorded via recordFailure, not swallowed.
    const stateB = getFetchState(db, 'src-b');
    expect(stateB?.consecutiveFailures).toBe(1);
    expect(stateB?.lastError).toContain('adapter exploded');

    // The two healthy sources are unaffected by B's failure.
    expect(getFetchState(db, 'src-a')?.consecutiveFailures).toBe(0);
    expect(getFetchState(db, 'src-c')?.consecutiveFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 304 short-circuit.
// ---------------------------------------------------------------------------

describe('runPollCycle -- 304 not-modified', () => {
  it('records success with zero items, inserts nothing, and does not trip backoff', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    const source = makeSource({ id: 'src-1', type: 'rss', url: `${baseUrl}/feed` });

    const adapters = registry({
      rss: cannedAdapter('rss', async (_source, state) => ({
        items: [],
        etag: state?.etag ?? 'W/"etag"',
        lastModified: null,
        notModified: true,
      })),
    });

    const report = await runPollCycle(db, [source], adapters, NOW);

    expect(report.sources[0]?.kind).toBe('success');
    expect(report.sources[0]?.itemCount).toBe(0);
    expect(report.sources[0]?.notModified).toBe(true);

    const state = getFetchState(db, 'src-1');
    expect(state?.lastSuccessAt).toBe(NOW);
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.nextEligibleAt).toBeNull();
    expect(state?.lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// robots.txt unavailable (RobotsUnavailableError) -- constraint 2.
// ---------------------------------------------------------------------------

describe('runPollCycle -- robots.txt unavailable', () => {
  it('skips the source, records a robots-unavailable outcome, and never calls the adapter', async () => {
    const db = migratedDb();
    const baseUrl = await serve((req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    });

    const source = makeSource({ id: 'src-1', type: 'rss', url: `${baseUrl}/feed` });
    let adapterCalled = false;
    const adapters = registry({
      rss: cannedAdapter('rss', async () => {
        adapterCalled = true;
        return { items: [], etag: null, lastModified: null, notModified: false };
      }),
    });

    const report = await runPollCycle(db, [source], adapters, NOW);

    expect(report.sources[0]?.kind).toBe('robots-unavailable');
    expect(report.sources[0]?.itemCount).toBe(0);
    expect(typeof report.sources[0]?.error).toBe('string');
    expect(adapterCalled).toBe(false);
  });

  it('does not call recordFailure -- fetchRobots itself retries on the next call, no content-side backoff is layered on top', async () => {
    const db = migratedDb();
    const baseUrl = await serve((req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    });
    const source = makeSource({ id: 'src-1', type: 'rss', url: `${baseUrl}/feed` });
    const adapters = registry({ rss: successAdapter('rss', []) });

    await runPollCycle(db, [source], adapters, NOW);

    expect(getFetchState(db, 'src-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// robots.txt denies.
// ---------------------------------------------------------------------------

describe('runPollCycle -- robots.txt denies', () => {
  it('records robots-denied and never calls the adapter', async () => {
    const db = migratedDb();
    const baseUrl = await serve((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(DENY_ALL_ROBOTS_TXT);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const source = makeSource({ id: 'src-1', type: 'rss', url: `${baseUrl}/feed` });
    let adapterCalled = false;
    const adapters = registry({
      rss: cannedAdapter('rss', async () => {
        adapterCalled = true;
        return { items: [], etag: null, lastModified: null, notModified: false };
      }),
    });

    const report = await runPollCycle(db, [source], adapters, NOW);

    expect(report.sources[0]?.kind).toBe('robots-denied');
    expect(adapterCalled).toBe(false);
    expect(getFetchState(db, 'src-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backoff respected -- a source in backoff is skipped, not retried in-loop.
// ---------------------------------------------------------------------------

describe('runPollCycle -- backoff', () => {
  it('a source in backoff is skipped, not retried in-loop, and the adapter is never called', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    const source = makeSource({ id: 'src-1', type: 'rss', url: `${baseUrl}/feed`, poll_interval: '15m' });

    // Pre-seed a failure so the source is inside its backoff window as of NOW.
    recordFailure(db, 'src-1', 'previous failure', 15 * 60 * 1000, '2026-08-13T11:59:00.000Z');
    const seeded = getFetchState(db, 'src-1');
    expect(seeded?.nextEligibleAt).not.toBeNull();
    expect(seeded!.nextEligibleAt! > NOW).toBe(true); // sanity: still in the future as of NOW

    let adapterCalled = false;
    const adapters = registry({
      rss: cannedAdapter('rss', async () => {
        adapterCalled = true;
        return { items: [], etag: null, lastModified: null, notModified: false };
      }),
    });

    const report = await runPollCycle(db, [source], adapters, NOW);

    expect(report.sources[0]?.kind).toBe('backoff');
    expect(report.sources[0]?.nextEligibleAt).toBe(seeded?.nextEligibleAt);
    expect(adapterCalled).toBe(false);
    // Not retried in-loop: consecutiveFailures is unchanged from the seed.
    expect(getFetchState(db, 'src-1')?.consecutiveFailures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Disabled sources are skipped entirely -- before robots.txt, before the
// adapter.
// ---------------------------------------------------------------------------

describe('runPollCycle -- disabled sources', () => {
  it('skips a disabled source without ever checking robots.txt or calling the adapter', async () => {
    const db = migratedDb();
    let hits = 0;
    const baseUrl = await serve((req, res) => {
      hits++;
      res.writeHead(200);
      res.end('should never be reached');
    });
    const source = makeSource({ id: 'src-1', url: `${baseUrl}/feed`, enabled: false });

    let adapterCalled = false;
    const adapters = registry({
      rss: cannedAdapter('rss', async () => {
        adapterCalled = true;
        return { items: [], etag: null, lastModified: null, notModified: false };
      }),
    });

    const report = await runPollCycle(db, [source], adapters, NOW);

    expect(report.sources[0]?.kind).toBe('skipped');
    expect(report.sources[0]?.itemCount).toBe(0);
    expect(hits).toBe(0); // robots.txt was never fetched either
    expect(adapterCalled).toBe(false);
    expect(getFetchState(db, 'src-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// skipped vs capped -- constraint 5: distinct, never conflated.
// ---------------------------------------------------------------------------

describe('runPollCycle -- skipped and capped are reported distinctly', () => {
  it('carries AdapterResult.skipped and .capped through as separate SourceOutcome fields', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    const source = makeSource({ id: 'src-1', type: 'news_sitemap', url: `${baseUrl}/feed` });

    const adapters = registry({
      news_sitemap: successAdapter('news_sitemap', [rawItem(`${baseUrl}/a`)], { skipped: 4, capped: 2 }),
    });

    const report = await runPollCycle(db, [source], adapters, NOW);
    const outcome = report.sources[0];

    expect(outcome?.kind).toBe('success');
    expect(outcome?.itemCount).toBe(1);
    expect(outcome?.skippedEntries).toBe(4);
    expect(outcome?.capped).toBe(2);
  });

  it('leaves capped undefined (never a fabricated 0) when the adapter reports nothing capped', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    const source = makeSource({ id: 'src-1', type: 'rss', url: `${baseUrl}/feed` });

    const adapters = registry({
      rss: successAdapter('rss', [rawItem(`${baseUrl}/a`)], { skipped: 0 }),
    });

    const report = await runPollCycle(db, [source], adapters, NOW);
    const outcome = report.sources[0];

    expect(outcome?.skippedEntries).toBe(0);
    expect(outcome?.capped).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Every outcome kind is distinguishable within a single report.
// ---------------------------------------------------------------------------

describe('runPollCycle -- PollReport distinguishes every outcome kind', () => {
  it('produces a distinct kind for success, skipped, backoff, robots-denied, robots-unavailable, and failure', async () => {
    const db = migratedDb();

    const successServer = await servePermissive();
    const skippedServer = await servePermissive(); // never actually hit -- enabled:false short-circuits first
    const backoffServer = await servePermissive(); // never actually hit -- backoff short-circuits first
    const deniedServer = await serve((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200);
        res.end(DENY_ALL_ROBOTS_TXT);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const unavailableServer = await serve((req, res) => {
      res.writeHead(503);
      res.end();
    });
    const failureServer = await servePermissive();

    const sources = [
      makeSource({ id: 'success', type: 'rss', url: `${successServer}/feed` }),
      makeSource({ id: 'skipped', type: 'rss', url: `${skippedServer}/feed`, enabled: false }),
      makeSource({ id: 'backoff', type: 'rss', url: `${backoffServer}/feed` }),
      makeSource({ id: 'denied', type: 'json', url: `${deniedServer}/feed` }),
      makeSource({ id: 'unavailable', type: 'news_sitemap', url: `${unavailableServer}/feed` }),
      makeSource({ id: 'failure', type: 'google_news', url: `${failureServer}/feed` }),
    ];

    recordFailure(db, 'backoff', 'seed', 15 * 60 * 1000, '2026-08-13T11:59:00.000Z');

    const adapters = registry({
      rss: successAdapter('rss', [rawItem(`${successServer}/item-1`)]),
      json: unusedAdapter('json'), // must never be called -- robots denies first
      news_sitemap: unusedAdapter('news_sitemap'), // must never be called -- robots.txt is unreachable
      google_news: throwingAdapter('google_news', new Error('kaboom')),
    });

    const report = await runPollCycle(db, sources, adapters, NOW);
    const byId = Object.fromEntries(report.sources.map((o) => [o.sourceId, o]));

    expect(byId.success?.kind).toBe('success');
    expect(byId.skipped?.kind).toBe('skipped');
    expect(byId.backoff?.kind).toBe('backoff');
    expect(byId.denied?.kind).toBe('robots-denied');
    expect(byId.unavailable?.kind).toBe('robots-unavailable');
    expect(byId.failure?.kind).toBe('failure');

    // All six kinds are pairwise distinct values, not overlapping labels.
    expect(new Set(report.sources.map((o) => o.kind)).size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Constraint 4: the Pick<> adapter registry -- an out-of-scope M1 source
// type is a per-source failure, not a crash, and 'atom' routes through
// whatever adapter is registered under the atom key.
// ---------------------------------------------------------------------------

describe('runPollCycle -- unsupported source type', () => {
  it('records failure via UnsupportedSourceTypeError rather than throwing out of runPollCycle', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    // market_data is a legal Source.type (src/sources/load.ts's zod enum
    // covers all 8), but has no M1 adapter -- SchedulerAdapterRegistry is a
    // Pick<> over only the 5 M1-scoped types (constraint 4).
    const source = makeSource({ id: 'src-1', type: 'market_data', url: `${baseUrl}/feed` });

    const report = await runPollCycle(db, [source], registry(), NOW);

    expect(report.sources[0]?.kind).toBe('failure');
    expect(report.sources[0]?.error).toContain('market_data');
    expect(getFetchState(db, 'src-1')?.consecutiveFailures).toBe(1);
  });
});

describe('UnsupportedSourceTypeError', () => {
  it('names the source id and the unsupported type', () => {
    const err = new UnsupportedSourceTypeError('src-1', 'market_data');
    expect(err.message).toContain('src-1');
    expect(err.message).toContain('market_data');
  });
});

describe('runPollCycle -- atom source type', () => {
  it('dispatches an atom-typed source through whatever adapter is registered under the atom key', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    const source = makeSource({ id: 'src-1', type: 'atom', url: `${baseUrl}/feed` });
    const item = rawItem(`${baseUrl}/entry-1`);

    const adapters = registry({ atom: successAdapter('atom', [item]) });

    const report = await runPollCycle(db, [source], adapters, NOW);

    expect(report.sources[0]?.kind).toBe('success');
    expect(report.sources[0]?.itemCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Constraint 1: isAllowed's required 4th `origin` argument and
// RobotsHostMismatchError must never be caught-and-ignored.
// ---------------------------------------------------------------------------

describe('runPollCycle -- a robots.txt host mismatch is a real failure, never silently allowed or denied', () => {
  it('records failure (via the generic per-source catch) rather than fetching or silently skipping', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    // new URL(`${baseUrl}//feed.xml`).pathname is literally "//feed.xml" --
    // verified directly against node:url before writing this test (see
    // task-10-report.md). robots.ts's isAllowed resolves a path starting
    // with // as a protocol-relative reference to a DIFFERENT host
    // ("feed.xml"), which disagrees with this source's real origin and
    // throws RobotsHostMismatchError rather than silently answering allow
    // or deny for the wrong file.
    const source = makeSource({ id: 'src-1', type: 'rss', url: `${baseUrl}//feed.xml` });

    let adapterCalled = false;
    const adapters = registry({
      rss: cannedAdapter('rss', async () => {
        adapterCalled = true;
        return { items: [], etag: null, lastModified: null, notModified: false };
      }),
    });

    const report = await runPollCycle(db, [source], adapters, NOW);

    expect(report.sources[0]?.kind).toBe('failure');
    expect(report.sources[0]?.error).toMatch(/origin/i);
    expect(adapterCalled).toBe(false);
    expect(getFetchState(db, 'src-1')?.consecutiveFailures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// `now` validation -- matches the codebase-wide convention (isEligible,
// recordSuccess, recordFailure, normalizeItem all validate their own
// canonical-timestamp arguments before doing any work).
// ---------------------------------------------------------------------------

describe('runPollCycle -- now validation', () => {
  it('rejects a non-canonical now before touching any source', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    const source = makeSource({ id: 'src-1', url: `${baseUrl}/feed` });

    await expect(runPollCycle(db, [source], registry(), '2026-08-13T12:00:00Z')).rejects.toThrow(
      InvalidTimestampError,
    );
    expect(getFetchState(db, 'src-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Report envelope shape.
// ---------------------------------------------------------------------------

describe('runPollCycle -- report envelope', () => {
  it('echoes the now parameter and reports a real, non-negative duration', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    const source = makeSource({ id: 'src-1', url: `${baseUrl}/feed` });
    const adapters = registry({ rss: successAdapter('rss', []) });

    const report = await runPollCycle(db, [source], adapters, NOW);

    expect(report.now).toBe(NOW);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(new Date(report.finishedAt).toString()).not.toBe('Invalid Date');
    expect(report.sources[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runPollCycle -- empty source list', () => {
  it('returns an empty report rather than throwing', async () => {
    const db = migratedDb();
    const report = await runPollCycle(db, [], registry(), NOW);
    expect(report.sources).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Constraint 3: poll_interval "0m"/"0h" is a live landmine -- both gates.
// parsePollIntervalMs is gate 2 (the scheduler's own runtime guard); the
// tightened src/sources/load.ts regex is gate 1, tested in
// tests/sources/load.test.ts.
// ---------------------------------------------------------------------------

describe('parsePollIntervalMs', () => {
  it('parses minutes, hours, and days to milliseconds', () => {
    expect(parsePollIntervalMs('src', '15m')).toBe(15 * 60 * 1000);
    expect(parsePollIntervalMs('src', '6h')).toBe(6 * 60 * 60 * 1000);
    expect(parsePollIntervalMs('src', '1d')).toBe(24 * 60 * 60 * 1000);
  });

  it('rejects a zero interval, even though its own pattern would otherwise match the digits', () => {
    // Deliberately more permissive than src/sources/load.ts's tightened
    // schema regex (gate 1) -- this function's pattern still matches "0m" so
    // that the value check right after it is what actually rejects it,
    // independent of gate 1. See the doc comment in src/scheduler/run.ts.
    expect(() => parsePollIntervalMs('src', '0m')).toThrow(InvalidPollIntervalError);
    expect(() => parsePollIntervalMs('src', '0h')).toThrow(InvalidPollIntervalError);
    expect(() => parsePollIntervalMs('src', '0d')).toThrow(InvalidPollIntervalError);
  });

  it('rejects a garbage or negative-looking string', () => {
    expect(() => parsePollIntervalMs('src', 'soon')).toThrow(InvalidPollIntervalError);
    expect(() => parsePollIntervalMs('src', '')).toThrow(InvalidPollIntervalError);
    expect(() => parsePollIntervalMs('src', '-5m')).toThrow(InvalidPollIntervalError);
  });
});

describe('runPollCycle -- zero poll_interval never reaches recordFailure unguarded (defense in depth, gate 2)', () => {
  it('a source with poll_interval "0m" that fails still backs off to a safe, non-zero delay -- not a hot loop', async () => {
    const db = migratedDb();
    const baseUrl = await servePermissive();
    // Bypasses src/sources/load.ts's schema entirely (constructed directly,
    // not via loadSources, which now rejects "0m" at config-load time --
    // gate 1) to prove the SCHEDULER's own runtime guard (gate 2)
    // independently closes the same hazard, per this task's "ship both
    // gates... test both" requirement.
    const source = makeSource({ id: 'src-1', type: 'rss', url: `${baseUrl}/feed`, poll_interval: '0m' });

    const adapters = registry({ rss: throwingAdapter('rss', new Error('boom')) });

    await runPollCycle(db, [source], adapters, NOW);

    const state = getFetchState(db, 'src-1');
    expect(state?.consecutiveFailures).toBe(1);
    // Not eligible again one millisecond later -- proves nextEligibleAt did
    // not land at or before `now`, which is exactly what a zero-delay
    // backoff would produce (the hot-loop landmine this guards against).
    const oneMsLater = new Date(Date.parse(NOW) + 1).toISOString();
    expect(isEligible(db, 'src-1', oneMsLater)).toBe(false);
    // The fallback is the widest backoff this system ever applies, not an
    // arbitrary small number -- see safePollIntervalMs's doc comment in
    // src/scheduler/run.ts.
    expect(Date.parse(state!.nextEligibleAt!) - Date.parse(NOW)).toBe(MAX_BACKOFF_MS);
  });
});

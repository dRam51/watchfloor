import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { registerAuth } from '../../src/api/auth.ts';
import { registerSources, computeSourceHealth, countFailingSources } from '../../src/api/routes/sources.ts';
import type { Source } from '../../src/sources/load.ts';

// Fixed instant so every "stale" / "in backoff" comparison in this file is
// deterministic rather than racing the real wall clock. Chosen to match the
// session's "today" for readability, not because anything here depends on
// the actual date.
const NOW = '2026-08-14T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function iso(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const DAY = 24 * HOUR;

function buildSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'test-source',
    name: 'Test Source',
    type: 'rss',
    url: 'https://example.com/feed.xml',
    beats: ['cyber'],
    weight: 1.0,
    poll_interval: '1d',
    enabled: true,
    enrichment: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure-function tests: no DB, no HTTP. These are the fast, exhaustive proof
// of the failing/stale/backoff logic -- the HTTP-level tests below prove the
// wiring on top of it, not the logic itself again.
// ---------------------------------------------------------------------------

describe('computeSourceHealth', () => {
  it('a source with no source_fetch_state row at all is legible as never-polled, and reads as failing (enabled)', () => {
    const health = computeSourceHealth(buildSource({ enabled: true }), null, NOW);

    expect(health.everPolled).toBe(false);
    expect(health.lastSuccessAt).toBeNull();
    expect(health.lastFailureAt).toBeNull();
    expect(health.lastError).toBeNull();
    expect(health.consecutiveFailures).toBe(0);
    expect(health.nextEligibleAt).toBeNull();
    expect(health.inBackoff).toBe(false);
    expect(health.itemsYieldedSinceWindowStart).toBe(0);
    expect(health.windowStartedAt).toBeNull();
    expect(health.updatedAt).toBeNull();
    expect(health.stale).toBe(true);
    expect(health.failing).toBe(true);
  });

  it('a never-polled DISABLED source does not read as broken', () => {
    const health = computeSourceHealth(buildSource({ enabled: false }), null, NOW);

    expect(health.everPolled).toBe(false);
    expect(health.stale).toBe(false);
    expect(health.failing).toBe(false);
    expect(health.inBackoff).toBe(false);
  });

  it('a source that succeeded well within its own poll_interval is healthy', () => {
    // 12h interval, succeeded 30 minutes ago -- the task brief's own "fine" example.
    const health = computeSourceHealth(
      buildSource({ poll_interval: '12h' }),
      {
        lastSuccessAt: iso(-30 * MIN),
        lastFailureAt: null,
        lastError: null,
        consecutiveFailures: 0,
        nextEligibleAt: null,
        itemsYieldedSinceWindowStart: 10,
        windowStartedAt: iso(-2 * DAY),
        updatedAt: iso(-30 * MIN),
      },
      NOW,
    );

    expect(health.stale).toBe(false);
    expect(health.failing).toBe(false);
    expect(health.inBackoff).toBe(false);
    expect(health.lastSuccessAt).toBe(iso(-30 * MIN));
  });

  it('THE SILENT FAILURE: zero consecutive_failures but stale beyond its own poll_interval must still read as failing', () => {
    // 1d interval, last succeeded 25 hours ago -- the task brief's own
    // "overdue" example -- with NO recorded failures at all. A naive
    // implementation that defines failing as `consecutiveFailures > 0` alone
    // would report this source as perfectly healthy, which is exactly the
    // silent failure mode §7 calls out as "the main failure mode of a
    // system like this."
    const health = computeSourceHealth(
      buildSource({ poll_interval: '1d' }),
      {
        lastSuccessAt: iso(-25 * HOUR),
        lastFailureAt: null,
        lastError: null,
        consecutiveFailures: 0,
        nextEligibleAt: null,
        itemsYieldedSinceWindowStart: 40,
        windowStartedAt: iso(-25 * HOUR),
        updatedAt: iso(-25 * HOUR),
      },
      NOW,
    );

    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBeNull();
    expect(health.stale).toBe(true);
    expect(health.failing).toBe(true);
  });

  it('boundary: exactly at the poll_interval is not yet stale (strict greater-than)', () => {
    const health = computeSourceHealth(
      buildSource({ poll_interval: '1d' }),
      {
        lastSuccessAt: iso(-1 * DAY), // exactly 24h ago
        lastFailureAt: null,
        lastError: null,
        consecutiveFailures: 0,
        nextEligibleAt: null,
        itemsYieldedSinceWindowStart: 1,
        windowStartedAt: iso(-1 * DAY),
        updatedAt: iso(-1 * DAY),
      },
      NOW,
    );

    expect(health.stale).toBe(false);
    expect(health.failing).toBe(false);
  });

  it('boundary: one millisecond past the poll_interval is stale', () => {
    const health = computeSourceHealth(
      buildSource({ poll_interval: '1d' }),
      {
        lastSuccessAt: iso(-1 * DAY - 1),
        lastFailureAt: null,
        lastError: null,
        consecutiveFailures: 0,
        nextEligibleAt: null,
        itemsYieldedSinceWindowStart: 1,
        windowStartedAt: iso(-1 * DAY - 1),
        updatedAt: iso(-1 * DAY - 1),
      },
      NOW,
    );

    expect(health.stale).toBe(true);
    expect(health.failing).toBe(true);
  });

  it('a source that has NEVER succeeded (only failures on record) is both stale and failing, with the error string carried through', () => {
    const health = computeSourceHealth(
      buildSource({ poll_interval: '30m' }),
      {
        lastSuccessAt: null,
        lastFailureAt: iso(-5 * MIN),
        lastError: 'ETIMEDOUT: connect ETIMEDOUT 93.184.216.34:443',
        consecutiveFailures: 3,
        nextEligibleAt: iso(10 * MIN),
        itemsYieldedSinceWindowStart: 0,
        windowStartedAt: null,
        updatedAt: iso(-5 * MIN),
      },
      NOW,
    );

    expect(health.everPolled).toBe(true);
    expect(health.lastSuccessAt).toBeNull();
    expect(health.stale).toBe(true);
    expect(health.failing).toBe(true);
    expect(health.inBackoff).toBe(true);
    expect(health.lastError).toBe('ETIMEDOUT: connect ETIMEDOUT 93.184.216.34:443');
    expect(health.consecutiveFailures).toBe(3);
  });

  it('a source whose backoff window has already elapsed is no longer "in backoff" but is still failing (the error streak has not been cleared by a success)', () => {
    const health = computeSourceHealth(
      buildSource({ poll_interval: '15m' }),
      {
        lastSuccessAt: iso(-10 * DAY),
        lastFailureAt: iso(-20 * MIN),
        lastError: 'HTTP 503',
        consecutiveFailures: 2,
        nextEligibleAt: iso(-1 * MIN), // backoff already elapsed
        itemsYieldedSinceWindowStart: 5,
        windowStartedAt: iso(-10 * DAY),
        updatedAt: iso(-20 * MIN),
      },
      NOW,
    );

    expect(health.inBackoff).toBe(false);
    expect(health.failing).toBe(true);
    expect(health.stale).toBe(true);
  });

  it('a DISABLED source with real failure history in its record still shows the raw history, but never reads as broken', () => {
    const health = computeSourceHealth(
      buildSource({ enabled: false, poll_interval: '15m' }),
      {
        lastSuccessAt: null,
        lastFailureAt: iso(-1 * HOUR),
        lastError: 'boom',
        consecutiveFailures: 5,
        nextEligibleAt: iso(1 * HOUR),
        itemsYieldedSinceWindowStart: 0,
        windowStartedAt: null,
        updatedAt: iso(-1 * HOUR),
      },
      NOW,
    );

    // Raw fields: untouched, real history.
    expect(health.lastError).toBe('boom');
    expect(health.consecutiveFailures).toBe(5);
    expect(health.lastFailureAt).toBe(iso(-1 * HOUR));
    // Derived judgement fields: pinned false because this source is disabled.
    expect(health.stale).toBe(false);
    expect(health.failing).toBe(false);
    expect(health.inBackoff).toBe(false);
    expect(health.enabled).toBe(false);
  });

  it('labels the tumbling window honestly: the raw count and its window start pass through verbatim, with no claim that it covers exactly 7 days', () => {
    // Window started 10 days ago -- past the true 7-day mark -- to prove
    // this function does not recompute or clamp anything; it is a faithful
    // passthrough of source_fetch_state's own tumbling bookkeeping (see
    // db/migrations/0003_fetch_state.sql), and the field NAME
    // (itemsYieldedSinceWindowStart, paired with windowStartedAt) is what
    // carries the honesty, not a hidden recency assumption.
    const health = computeSourceHealth(
      buildSource({ poll_interval: '30m' }),
      {
        lastSuccessAt: iso(-5 * MIN),
        lastFailureAt: null,
        lastError: null,
        consecutiveFailures: 0,
        nextEligibleAt: null,
        itemsYieldedSinceWindowStart: 132,
        windowStartedAt: iso(-10 * DAY),
        updatedAt: iso(-5 * MIN),
      },
      NOW,
    );

    expect(health.itemsYieldedSinceWindowStart).toBe(132);
    expect(health.windowStartedAt).toBe(iso(-10 * DAY));
  });

  it('echoes name, beats, weight, pollInterval, and enabled straight from config', () => {
    const health = computeSourceHealth(
      buildSource({
        id: 'cisa-kev',
        name: 'CISA Known Exploited Vulnerabilities',
        beats: ['cyber'],
        weight: 2.0,
        poll_interval: '30m',
        enabled: true,
      }),
      null,
      NOW,
    );

    expect(health.id).toBe('cisa-kev');
    expect(health.name).toBe('CISA Known Exploited Vulnerabilities');
    expect(health.beats).toEqual(['cyber']);
    expect(health.weight).toBe(2.0);
    expect(health.pollInterval).toBe('30m');
    expect(health.pollIntervalMs).toBe(30 * MIN);
    expect(health.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP-level tests: proves the DB read + config combine + JSON wiring, on a
// real temp-file SQLite DB and a real Fastify server built locally (per the
// Wave 2 concurrency note: server.ts is NOT touched or imported here).
// ---------------------------------------------------------------------------

const TOKEN = 'a-real-token-that-is-long-enough';
const open: Array<ReturnType<typeof openDb>> = [];

function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

function buildTestServer(db: Db, sources: Source[]): FastifyInstance {
  const server = Fastify({ logger: false });
  registerAuth(server, TOKEN);
  registerSources(server, { db, sources });
  return server;
}

function insertFetchState(
  db: Db,
  row: {
    sourceId: string;
    lastSuccessAt?: string | null;
    lastFailureAt?: string | null;
    lastError?: string | null;
    consecutiveFailures?: number;
    nextEligibleAt?: string | null;
    itemsYielded7d?: number;
    windowStartedAt?: string | null;
    updatedAt?: string;
  },
): void {
  db.prepare(
    `insert into source_fetch_state (
       source_id, etag, last_modified, last_success_at, last_failure_at, last_error,
       consecutive_failures, next_eligible_at, items_yielded_7d,
       items_yielded_7d_window_started_at, updated_at
     ) values (?, null, null, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.sourceId,
    row.lastSuccessAt ?? null,
    row.lastFailureAt ?? null,
    row.lastError ?? null,
    row.consecutiveFailures ?? 0,
    row.nextEligibleAt ?? null,
    row.itemsYielded7d ?? 0,
    row.windowStartedAt ?? null,
    row.updatedAt ?? NOW,
  );
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

describe('GET /sources', () => {
  it('requires a bearer token, like every other route on this server', async () => {
    const server = buildTestServer(migratedDb(), [buildSource()]);
    const res = await server.inject({ method: 'GET', url: '/sources' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('does not collide with the public /health path', async () => {
    // /sources must never accidentally match the PUBLIC_PATHS allowlist
    // in src/api/auth.ts, which is an exact-match set containing only
    // '/health'.
    const server = buildTestServer(migratedDb(), [buildSource()]);
    const res = await server.inject({ method: 'GET', url: '/sources' });
    expect(res.statusCode).toBe(401); // proves it is NOT treated as public
    await server.close();
  });

  it('returns every configured source, including one with no fetch-state row at all', async () => {
    const db = migratedDb();
    const sources = [
      buildSource({ id: 'alpha', name: 'Alpha Feed' }),
      buildSource({ id: 'beta', name: 'Beta Feed' }),
    ];
    // Only 'alpha' has ever been polled -- 'beta' is configured but the
    // scheduler has never reached it yet.
    insertFetchState(db, { sourceId: 'alpha', lastSuccessAt: iso(-5 * MIN) });

    const server = buildTestServer(db, sources);
    const res = await server.inject({
      method: 'GET',
      url: '/sources',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toHaveLength(2);

    const alpha = body.sources.find((s: { id: string }) => s.id === 'alpha');
    const beta = body.sources.find((s: { id: string }) => s.id === 'beta');
    expect(alpha.everPolled).toBe(true);
    expect(beta.everPolled).toBe(false);
    expect(beta.lastSuccessAt).toBeNull();
    expect(beta.failing).toBe(true); // never polled, enabled -- the silent case
    await server.close();
  });

  it('uses camelCase keys on the wire, never the DB\'s snake_case column names', async () => {
    const db = migratedDb();
    insertFetchState(db, {
      sourceId: 'test-source',
      lastSuccessAt: iso(-25 * HOUR),
      consecutiveFailures: 0,
    });
    const server = buildTestServer(db, [buildSource({ poll_interval: '1d' })]);

    const res = await server.inject({
      method: 'GET',
      url: '/sources',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const row = res.json().sources[0];
    expect(row).toHaveProperty('lastSuccessAt');
    expect(row).toHaveProperty('consecutiveFailures');
    expect(row).toHaveProperty('itemsYieldedSinceWindowStart');
    expect(row).not.toHaveProperty('last_success_at');
    expect(row).not.toHaveProperty('consecutive_failures');
    expect(row).not.toHaveProperty('items_yielded_7d');
    await server.close();
  });

  it('nulls stay null on the wire (never omitted, never coerced to an empty string) for a source that has never failed', async () => {
    const db = migratedDb();
    insertFetchState(db, { sourceId: 'test-source', lastSuccessAt: iso(-5 * MIN) });
    const server = buildTestServer(db, [buildSource()]);

    const res = await server.inject({
      method: 'GET',
      url: '/sources',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const row = res.json().sources[0];
    expect('lastFailureAt' in row).toBe(true);
    expect(row.lastFailureAt).toBeNull();
    expect('lastError' in row).toBe(true);
    expect(row.lastError).toBeNull();
    await server.close();
  });

  it('end-to-end: the silent-failure source (zero consecutive_failures, overdue) reads as failing over real HTTP+DB, not just in the pure function', async () => {
    const db = migratedDb();
    insertFetchState(db, {
      sourceId: 'test-source',
      lastSuccessAt: iso(-25 * HOUR),
      consecutiveFailures: 0,
      lastError: null,
    });
    const server = buildTestServer(db, [buildSource({ poll_interval: '1d' })]);

    const res = await server.inject({
      method: 'GET',
      url: '/sources',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const row = res.json().sources[0];
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.failing).toBe(true);
    expect(row.stale).toBe(true);
    await server.close();
  });

  it('a disabled source never reads as failing over real HTTP+DB, even with recorded failures', async () => {
    const db = migratedDb();
    insertFetchState(db, {
      sourceId: 'test-source',
      lastError: 'boom',
      consecutiveFailures: 9,
      nextEligibleAt: iso(1 * HOUR),
    });
    const server = buildTestServer(db, [buildSource({ enabled: false })]);

    const res = await server.inject({
      method: 'GET',
      url: '/sources',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const row = res.json().sources[0];
    expect(row.enabled).toBe(false);
    expect(row.failing).toBe(false);
    expect(row.stale).toBe(false);
    expect(row.lastError).toBe('boom'); // raw history still visible
    await server.close();
  });

  it('preserves config declaration order', async () => {
    const db = migratedDb();
    const sources = [
      buildSource({ id: 'z-source' }),
      buildSource({ id: 'a-source' }),
      buildSource({ id: 'm-source' }),
    ];
    const server = buildTestServer(db, sources);

    const res = await server.inject({
      method: 'GET',
      url: '/sources',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.json().sources.map((s: { id: string }) => s.id)).toEqual([
      'z-source',
      'a-source',
      'm-source',
    ]);
    await server.close();
  });

  it('exact timestamps round-trip verbatim through the wire, not epoch numbers or locale strings', async () => {
    const db = migratedDb();
    const successAt = iso(-5 * MIN);
    insertFetchState(db, { sourceId: 'test-source', lastSuccessAt: successAt });
    const server = buildTestServer(db, [buildSource()]);

    const res = await server.inject({
      method: 'GET',
      url: '/sources',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.json().sources[0].lastSuccessAt).toBe(successAt);
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// countFailingSources: the (db, sources) => number shape Task 6's
// DashboardDeps.countFailingSources override expects (src/api/routes/dashboard.ts),
// so the header strip's "count of failing sources" can use the real
// definition rather than its documented consecutive_failures-only placeholder.
// ---------------------------------------------------------------------------

describe('countFailingSources', () => {
  it('counts the silent-failure case (zero consecutive_failures, overdue) that a naive consecutive_failures-only count would miss', () => {
    const db = migratedDb();
    const sources = [
      buildSource({ id: 'healthy', poll_interval: '12h' }),
      buildSource({ id: 'silent-failure', poll_interval: '1d' }),
      buildSource({ id: 'explicit-error', poll_interval: '15m' }),
      buildSource({ id: 'never-polled', poll_interval: '1h' }),
      buildSource({ id: 'disabled-but-stale', poll_interval: '1h', enabled: false }),
    ];
    insertFetchState(db, { sourceId: 'healthy', lastSuccessAt: iso(-30 * MIN) });
    insertFetchState(db, {
      sourceId: 'silent-failure',
      lastSuccessAt: iso(-25 * HOUR),
      consecutiveFailures: 0,
    });
    insertFetchState(db, {
      sourceId: 'explicit-error',
      lastError: 'HTTP 500',
      consecutiveFailures: 4,
      lastFailureAt: iso(-2 * MIN),
    });
    // 'never-polled' gets no row at all, deliberately.
    insertFetchState(db, {
      sourceId: 'disabled-but-stale',
      lastSuccessAt: iso(-30 * DAY),
    });

    // 3 failing: silent-failure, explicit-error, never-polled.
    // NOT failing: healthy (recent success), disabled-but-stale (disabled).
    expect(countFailingSources(db, sources)).toBe(3);
  });

  it('accepts a readonly array, matching DashboardDeps.countFailingSources exactly', () => {
    const db = migratedDb();
    const sources: readonly Source[] = [buildSource({ enabled: true })];
    expect(() => countFailingSources(db, sources)).not.toThrow();
  });
});

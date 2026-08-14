import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { registerAuth } from '../../src/api/auth.ts';
import { registerDashboard } from '../../src/api/routes/dashboard.ts';
import { loadSources, type Source } from '../../src/sources/load.ts';
import { recordSuccess, recordFailure } from '../../src/db/fetchState.ts';
import { BEATS } from '../../src/domain/item.ts';

const TOKEN = 'a-real-token-that-is-long-enough';
const open: Db[] = [];

function migratedDb(path?: string): { db: Db; path: string } {
  const dbPath = path ?? join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db');
  const db = openDb(dbPath);
  open.push(db);
  if (!path) runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return { db, path: dbPath };
}

function sources(yaml: string): Source[] {
  return loadSources(`sources:\n${yaml}`);
}

/** Mirrors src/api/server.ts's own wiring order, per this wave's brief:
 * build a server locally rather than editing src/api/server.ts. */
function buildTestServer(db: Db, srcs: Source[] = [], env: NodeJS.ProcessEnv = {}): FastifyInstance {
  const server = Fastify({ logger: false });
  registerAuth(server, TOKEN);
  registerDashboard(server, { db, sources: srcs, env });
  return server;
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

describe('GET /dashboard/header', () => {
  it('requires auth, like every other route by default', async () => {
    const { db } = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject({ method: 'GET', url: '/dashboard/header' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('returns per-beat refresh, a failing-source count, and a real-zero enrichment spend', async () => {
    const { db } = migratedDb();
    const src = sources(`
  - { id: cyber-src, name: CyberSrc, type: rss, url: 'https://cyber.test/f', beats: [cyber], weight: 1, poll_interval: 15m, enabled: true }
  - { id: broken, name: Broken, type: rss, url: 'https://broken.test/f', beats: [ai], weight: 1, poll_interval: 15m, enabled: true }
`);
    recordSuccess(db, 'cyber-src', { etag: null, lastModified: null, itemCount: 4 }, '2026-08-14T09:30:00.000Z');
    recordFailure(db, 'broken', 'HTTP 500', 15 * 60 * 1000, '2026-08-14T09:30:00.000Z');

    const server = buildTestServer(db, src, {});
    const res = await server.inject({ method: 'GET', url: '/dashboard/header', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // camelCase, bare object, all six beats present, nulls stay null.
    expect(Object.keys(body.beats).sort()).toEqual([...BEATS].sort());
    expect(body.beats.cyber).toEqual({ lastRefreshAt: '2026-08-14T09:30:00.000Z', sourceCount: 1 });
    expect(body.beats.ai).toEqual({ lastRefreshAt: null, sourceCount: 1 });
    expect(body.beats.repos).toEqual({ lastRefreshAt: null, sourceCount: 0 });

    expect(body.failingSources).toBe(1);

    expect(body.enrichmentSpend.amountUsd).toBe(0);
    expect(body.enrichmentSpend.measured).toBe(true);
    expect(typeof body.enrichmentSpend.asOf).toBe('string');
    await server.close();
  });

  it('reports enrichment spend as unmeasured, not a lying zero, when the paid gate is open', async () => {
    const { db } = migratedDb();
    const server = buildTestServer(db, [], { WF_ALLOW_PAID_ANTHROPIC: '1' });
    const res = await server.inject({ method: 'GET', url: '/dashboard/header', headers: AUTH });
    const body = res.json();
    expect(body.enrichmentSpend.amountUsd).toBeNull();
    expect(body.enrichmentSpend.measured).toBe(false);
    await server.close();
  });

  it('lets the coordinator swap in a real failing-source definition (e.g. Task 5\'s) without touching this route', async () => {
    const { db } = migratedDb();
    const server = Fastify({ logger: false });
    registerAuth(server, TOKEN);
    registerDashboard(server, {
      db,
      sources: [],
      env: {},
      countFailingSources: () => 42,
    });

    const res = await server.inject({ method: 'GET', url: '/dashboard/header', headers: AUTH });
    expect(res.json().failingSources).toBe(42);
    await server.close();
  });
});

describe('GET /dashboard/layout', () => {
  it('requires auth', async () => {
    const { db } = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject({ method: 'GET', url: '/dashboard/layout' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('defaults to all six beats in canonical order, none collapsed', async () => {
    const { db } = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject({ method: 'GET', url: '/dashboard/layout', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lanes: BEATS.map((beat) => ({ beat, collapsed: false })) });
    await server.close();
  });
});

describe('PUT /dashboard/layout', () => {
  it('is a full replace: the whole six-lane order and collapse state in one write', async () => {
    const { db, path } = migratedDb();
    const server = buildTestServer(db);
    const newLayout = {
      lanes: [
        { beat: 'usnews', collapsed: true },
        { beat: 'markets', collapsed: true },
        { beat: 'repos', collapsed: false },
        { beat: 'aisec', collapsed: false },
        { beat: 'cyber', collapsed: false },
        { beat: 'ai', collapsed: false },
      ],
    };

    const putRes = await server.inject({
      method: 'PUT',
      url: '/dashboard/layout',
      headers: AUTH,
      payload: newLayout,
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toEqual(newLayout);

    const getRes = await server.inject({ method: 'GET', url: '/dashboard/layout', headers: AUTH });
    expect(getRes.json()).toEqual(newLayout);
    await server.close();

    // Prove it persisted server-side, past this connection and this process
    // -- reopen the same file with a brand-new connection and server.
    const reconnected = openDb(path);
    open.push(reconnected);
    const server2 = buildTestServer(reconnected);
    const res2 = await server2.inject({ method: 'GET', url: '/dashboard/layout', headers: AUTH });
    expect(res2.json()).toEqual(newLayout);
    await server2.close();
  });

  it('requires auth', async () => {
    const { db } = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject({
      method: 'PUT',
      url: '/dashboard/layout',
      payload: { lanes: BEATS.map((beat) => ({ beat, collapsed: false })) },
    });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('rejects an unknown beat with 400 and does not touch the stored layout', async () => {
    const { db } = migratedDb();
    const server = buildTestServer(db);
    const before = await server.inject({ method: 'GET', url: '/dashboard/layout', headers: AUTH });

    const res = await server.inject({
      method: 'PUT',
      url: '/dashboard/layout',
      headers: AUTH,
      payload: {
        lanes: [
          { beat: 'ai', collapsed: false },
          { beat: 'cyber', collapsed: false },
          { beat: 'aisec', collapsed: false },
          { beat: 'repos', collapsed: false },
          { beat: 'markets', collapsed: false },
          { beat: 'sports', collapsed: false },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');

    const after = await server.inject({ method: 'GET', url: '/dashboard/layout', headers: AUTH });
    expect(after.json()).toEqual(before.json());
    await server.close();
  });

  it('rejects a partial layout (fewer than six lanes) with 400', async () => {
    const { db } = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject({
      method: 'PUT',
      url: '/dashboard/layout',
      headers: AUTH,
      payload: { lanes: [{ beat: 'ai', collapsed: false }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
    await server.close();
  });

  it('rejects a duplicate beat with 400', async () => {
    const { db } = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject({
      method: 'PUT',
      url: '/dashboard/layout',
      headers: AUTH,
      payload: {
        lanes: [
          { beat: 'ai', collapsed: false },
          { beat: 'ai', collapsed: true },
          { beat: 'cyber', collapsed: false },
          { beat: 'aisec', collapsed: false },
          { beat: 'repos', collapsed: false },
          { beat: 'markets', collapsed: false },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('rejects a non-boolean collapsed flag with 400', async () => {
    const { db } = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject({
      method: 'PUT',
      url: '/dashboard/layout',
      headers: AUTH,
      payload: {
        lanes: BEATS.map((beat) => ({ beat, collapsed: 'yes' })),
      },
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});

describe('unknown beat already sitting in storage (graceful degradation end-to-end)', () => {
  it('GET /dashboard/layout does not crash and drops the stale beat', async () => {
    const { db } = migratedDb();
    db.prepare(
      'insert into lane_layout (beat, position, collapsed, updated_at) values (?, ?, ?, ?)',
    ).run('crypto', 0, 0, '2026-08-14T00:00:00.000Z');

    const server = buildTestServer(db);
    const res = await server.inject({ method: 'GET', url: '/dashboard/layout', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const beats = res.json().lanes.map((l: { beat: string }) => l.beat);
    expect(beats.sort()).toEqual([...BEATS].sort());
    await server.close();
  });
});

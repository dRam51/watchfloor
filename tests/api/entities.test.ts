import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { registerAuth } from '../../src/api/auth.ts';
import { registerEntities } from '../../src/api/routes/entities.ts';
import { insertItem, type NewItem } from '../../src/domain/item.ts';

/**
 * `GET /api/entities` and `GET /api/entities/graph` — §7.4's entity graph, on
 * the wire (M5 task 17).
 *
 * Every assertion here is against a real Fastify instance over a real
 * temp-file SQLite database. No mocks: docs/api.md's conventions are about
 * what a client actually receives, and a stubbed route proves nothing about
 * `{ error }` shapes, 400s, or the whitelist mapper.
 *
 * docs/api.md carries its own warning, twice earned:
 *
 * > *(An earlier revision of this file called it `itemsYielded7d` and omitted
 * > `weight` … That was written from expectation rather than from the
 * > response.)*
 *
 * So this file pins the response's EXACT key set rather than only the keys it
 * happens to care about — a field that exists on the route and not in the docs
 * is the same defect as the reverse, and only an exhaustive check catches it.
 */

const TOKEN = 'a-real-token-that-is-long-enough';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const REAL_MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

const open: Db[] = [];

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-entities-api-')), 'wf.db'));
  open.push(db);
  runMigrations(db, REAL_MIGRATIONS_DIR);
  return db;
}

function buildTestServer(db: Db): FastifyInstance {
  const server = Fastify({ logger: false });
  registerAuth(server, TOKEN);
  registerEntities(server, { db });
  return server;
}

let clock = 0;

function addItem(
  db: Db,
  canonicalUrl: string,
  entities: string[],
  overrides: Partial<NewItem> = {},
): void {
  clock += 1;
  insertItem(db, {
    url: canonicalUrl,
    canonicalUrl,
    title: `Item ${canonicalUrl}`,
    sourceId: 'fixture-source',
    itemType: 'analysis',
    beats: ['ai'],
    entities,
    publishedAt: null,
    fetchedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, 0, clock % 1000)).toISOString(),
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  });
}

/**
 * A hub with three above-threshold neighbours, one single-mention neighbour
 * the floor must remove, and a neighbour pair joined to each other and not
 * only to the hub.
 */
function seed(): Db {
  const db = migratedDb();
  addItem(db, 'https://example.test/1', ['OpenAI', 'ChatGPT', 'Anthropic']);
  addItem(db, 'https://example.test/2', ['OpenAI', 'ChatGPT']);
  addItem(db, 'https://example.test/3', ['OpenAI', 'Anthropic']);
  addItem(db, 'https://example.test/4', ['OpenAI', 'Claude']);
  addItem(db, 'https://example.test/5', ['Anthropic', 'Claude']);
  addItem(db, 'https://example.test/6', ['OpenAI', 'CVE-2026-9999']);
  addItem(db, 'https://example.test/7', ['CVE-2026-0001']);
  return db;
}

// ---------------------------------------------------------------------------
// GET /entities
// ---------------------------------------------------------------------------

describe('GET /entities — the ranked node list', () => {
  it('requires auth, like every route but /health', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({ method: 'GET', url: '/entities' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    await server.close();
  });

  it('returns entities above the threshold, ranked by item count', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({ method: 'GET', url: '/entities', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entities).toEqual([
      { entity: 'OpenAI', itemCount: 5 },
      { entity: 'Anthropic', itemCount: 3 },
      { entity: 'ChatGPT', itemCount: 2 },
      { entity: 'Claude', itemCount: 2 },
    ]);
    await server.close();
  });

  it('states the threshold and what it excluded, so the view can say so too', async () => {
    // "Decide the threshold, make it visible to the user, and defend it."
    // A client cannot make it visible if the response does not carry it.
    const server = buildTestServer(seed());
    const res = await server.inject({ method: 'GET', url: '/entities', headers: AUTH });
    const body = res.json();
    expect(body.minItems).toBe(2);
    expect(body.entitiesTotal).toBe(6);
    expect(body.entitiesAtOrAboveThreshold).toBe(4);
    expect(body.entitiesBelowThreshold).toBe(2);
    await server.close();
  });

  it('has exactly the documented key set — no more, no less', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({ method: 'GET', url: '/entities', headers: AUTH });
    expect(Object.keys(res.json()).sort()).toEqual([
      'entities',
      'entitiesAtOrAboveThreshold',
      'entitiesBelowThreshold',
      'entitiesTotal',
      'limit',
      'minItems',
    ]);
    expect(Object.keys(res.json().entities[0]).sort()).toEqual(['entity', 'itemCount']);
    await server.close();
  });

  it('honours minItems=1, which is the "show me the whole tail" request', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({ method: 'GET', url: '/entities?minItems=1', headers: AUTH });
    const body = res.json();
    expect(body.minItems).toBe(1);
    expect(body.entities).toHaveLength(6);
    expect(body.entitiesBelowThreshold).toBe(0);
    await server.close();
  });

  it('caps the list but still reports the true above-threshold total', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({ method: 'GET', url: '/entities?limit=2', headers: AUTH });
    const body = res.json();
    expect(body.entities).toHaveLength(2);
    expect(body.entitiesAtOrAboveThreshold).toBe(4);
    await server.close();
  });

  it('fails loudly on bad input rather than clamping it', async () => {
    // `{ error: '<lowercase token>' }` with the human detail in `message` --
    // docs/api.md's stated convention, and the shape /api/feed uses. NOT the
    // shape /api/search uses: that route sends zod's raw message as `error`,
    // so a missing parameter answers `{"error":"Required"}`, which is both
    // capitalised and useless. Verified live before this was written.
    const server = buildTestServer(seed());
    for (const url of ['/entities?minItems=0', '/entities?minItems=x', '/entities?limit=0', '/entities?limit=9999']) {
      const res = await server.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode, url).toBe(400);
      expect(Object.keys(res.json()).sort(), url).toEqual(['error', 'message']);
      expect(res.json().error, url).toBe('invalid_query');
      expect(res.json().message, url).toMatch(/^(minItems|limit): /);
    }
    await server.close();
  });

  it('answers an empty corpus with an empty list, not an error', async () => {
    const db = migratedDb();
    addItem(db, 'https://example.test/none', []);
    const server = buildTestServer(db);
    const res = await server.inject({ method: 'GET', url: '/entities', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().entities).toEqual([]);
    expect(res.json().entitiesTotal).toBe(0);
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// GET /entities/graph
// ---------------------------------------------------------------------------

describe('GET /entities/graph — the ego graph', () => {
  it('requires auth', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({ method: 'GET', url: '/entities/graph?entity=OpenAI' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });

  it('returns the focus first, its neighbours ranked, and the edges among them', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({
      method: 'GET',
      url: '/entities/graph?entity=OpenAI',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.known).toBe(true);
    expect(body.nodes[0]).toEqual({
      entity: 'OpenAI',
      itemCount: 5,
      focus: true,
      sharedItemsWithFocus: null,
    });
    expect(body.nodes.slice(1).map((n: { entity: string }) => n.entity)).toEqual([
      'Anthropic',
      'ChatGPT',
      'Claude',
    ]);
    // Anthropic--Claude share item 5, which never mentions OpenAI. A star
    // would lose it, and a star is a ranked list drawn in a circle.
    expect(body.edges).toContainEqual({ source: 'Anthropic', target: 'Claude', sharedItems: 1 });
    await server.close();
  });

  it('has exactly the documented key set — no more, no less', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({
      method: 'GET',
      url: '/entities/graph?entity=OpenAI',
      headers: AUTH,
    });
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual([
      'corpus',
      'edges',
      'entity',
      'known',
      'minItems',
      'neighbours',
      'nodes',
    ]);
    expect(Object.keys(body.nodes[0]).sort()).toEqual([
      'entity',
      'focus',
      'itemCount',
      'sharedItemsWithFocus',
    ]);
    expect(Object.keys(body.edges[0]).sort()).toEqual(['sharedItems', 'source', 'target']);
    expect(Object.keys(body.neighbours).sort()).toEqual([
      'aboveThreshold',
      'hiddenBelowThreshold',
      'shown',
    ]);
    expect(Object.keys(body.corpus).sort()).toEqual([
      'entitiesAtOrAboveThreshold',
      'entitiesBelowThreshold',
      'entitiesTotal',
    ]);
    await server.close();
  });

  it('says how many neighbours the threshold removed — never a silent drop', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({
      method: 'GET',
      url: '/entities/graph?entity=OpenAI',
      headers: AUTH,
    });
    const body = res.json();
    expect(body.nodes.map((n: { entity: string }) => n.entity)).not.toContain('CVE-2026-9999');
    expect(body.neighbours).toEqual({ shown: 3, aboveThreshold: 3, hiddenBelowThreshold: 1 });
    await server.close();
  });

  it('accepts an entity name with a space, url-encoded', async () => {
    const db = migratedDb();
    addItem(db, 'https://example.test/m1', ['Model Context Protocol', 'OpenAI']);
    addItem(db, 'https://example.test/m2', ['Model Context Protocol', 'OpenAI']);
    const server = buildTestServer(db);
    const res = await server.inject({
      method: 'GET',
      url: `/entities/graph?entity=${encodeURIComponent('Model Context Protocol')}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes[0].entity).toBe('Model Context Protocol');
    await server.close();
  });

  it('reports an unknown entity as known:false with 200, not as a 404', async () => {
    // A 404 would mean "no such route". This route exists and answered: the
    // corpus does not name that entity, which is a result, not an error --
    // the same absence/emptiness distinction /api/sources already draws.
    const server = buildTestServer(seed());
    const res = await server.inject({
      method: 'GET',
      url: '/entities/graph?entity=Nothing%20mentions%20this',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.known).toBe(false);
    expect(body.entity).toBe('Nothing mentions this');
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    await server.close();
  });

  it('400s when no entity is named, rather than guessing one', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({ method: 'GET', url: '/entities/graph', headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
    // Names the parameter. `{"error":"Required"}` -- what zod's message alone
    // gives, and what /api/search really returns -- does not say for WHAT.
    expect(res.json().message).toContain('entity');
    await server.close();
  });

  it('400s on a neighbour cap outside the drawable range', async () => {
    const server = buildTestServer(seed());
    for (const url of [
      '/entities/graph?entity=OpenAI&neighbours=0',
      '/entities/graph?entity=OpenAI&neighbours=201',
      '/entities/graph?entity=OpenAI&minItems=0',
    ]) {
      const res = await server.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode, url).toBe(400);
    }
    await server.close();
  });

  it('never returns an edge whose ends are not both drawn', async () => {
    const server = buildTestServer(seed());
    const res = await server.inject({
      method: 'GET',
      url: '/entities/graph?entity=OpenAI&neighbours=1',
      headers: AUTH,
    });
    const body = res.json();
    const drawn = new Set(body.nodes.map((n: { entity: string }) => n.entity));
    for (const edge of body.edges) {
      expect(drawn.has(edge.source)).toBe(true);
      expect(drawn.has(edge.target)).toBe(true);
    }
    await server.close();
  });
});

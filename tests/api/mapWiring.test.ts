import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { buildServer } from '../../src/api/server.ts';
import { insertItem } from '../../src/domain/item.ts';
import { loadDecayConfig } from '../../src/score/decay.ts';
import { loadOverridesConfig } from '../../src/score/overrides.ts';
import { loadGazetteerFiles } from '../../src/locations/load.ts';
import { seedLocations } from '../../src/locations/seed.ts';
import { sweepLocations } from '../../src/locations/sweep.ts';
import type { Env } from '../../src/config/env.ts';

/**
 * **The occurrence-nine test, on the API side** (M7).
 *
 * Every route test in `tests/api/` builds its own Fastify instance -- correctly,
 * so a route test does not depend on the composition root. That is also exactly
 * the blindness: **all of them stay green with `registerMap` absent from
 * `src/api/server.ts`.** This file asks the only question that catches it --
 * does a request to the REAL server, at the REAL `/api` prefix, reach the map?
 *
 * It also pins the second half, which is easier to miss than the first:
 * `src/bin/api.ts` must actually LOAD a gazetteer and pass it. `ServerDeps.gazetteer`
 * is optional, so a server built without one simply has no map routes and
 * nothing anywhere else fails -- a silent, complete, invisible feature removal.
 */

const REAL_MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');
const TOKEN = 'a-real-token-that-is-long-enough';
const open: Db[] = [];

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

function env(): Env {
  return {
    WF_DB_PATH: './data/wf.db',
    WF_TZ: 'America/New_York',
    WF_API_TOKEN: TOKEN,
    WF_API_PORT: 8787,
  } as unknown as Env;
}

/** The REAL committed config, not a fixture: a map of invented places would
 * prove nothing about the map of real ones. */
function realGazetteer() {
  return loadGazetteerFiles({
    locations: join('config', 'locations.yaml'),
    jurisdictions: join('config', 'jurisdictions.yaml'),
  });
}

function realServer(): ReturnType<typeof buildServer> {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-map-wiring-')), 'wf.db'));
  open.push(db);
  runMigrations(db, REAL_MIGRATIONS_DIR);

  const gazetteer = realGazetteer();
  seedLocations(db, gazetteer);

  // Titles chosen to exercise both matching tiers -- a distinctive site alias
  // and an operator+city co-occurrence -- so a regression in either shows up
  // here as a missing pin rather than as a subtly smaller number.
  for (const [n, title] of [
    ['1', 'ASML ships first High-NA EUV system from Veldhoven'],
    ['2', 'TSMC breaks ground on second Arizona fab in Phoenix'],
    ['3', 'Microsoft patches critical Exchange flaw'],
  ] as const) {
    insertItem(db, {
      url: `https://example.test/${n}`,
      canonicalUrl: `https://example.test/${n}`,
      title,
      sourceId: 'fixture-source',
      itemType: 'analysis',
      beats: ['ai'],
      entities: [],
      publishedAt: null,
      fetchedAt: `2026-08-01T00:00:0${n}.000Z`,
      summaryRaw: null,
      rawJson: '{}',
    });
  }
  sweepLocations(db, gazetteer, { now: '2026-08-01T01:00:00.000Z' });

  return buildServer({
    db,
    env: env(),
    sources: [],
    decayConfig: loadDecayConfig(join('config', 'decay.yaml')),
    overridesConfig: loadOverridesConfig(join('config', 'overrides.yaml')),
    gazetteer,
  });
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

const MAP_URLS = [
  '/api/map/locations',
  '/api/map/jurisdictions',
  '/api/map/arcs',
  '/api/map/prefs',
  '/api/map/locations/asml-veldhoven/items',
  '/api/map/countries/NL/items',
];

describe('the map is reachable from the server every entrypoint builds', () => {
  for (const url of MAP_URLS) {
    it(`serves GET ${url}`, async () => {
      const server = realServer();
      const res = await server.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode, 'registerMap is not wired into src/api/server.ts').toBe(200);
      await server.close();
    });
  }

  it('is behind the root auth hook, without its author having done anything', async () => {
    const server = realServer();
    for (const url of MAP_URLS) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    await server.close();
  });

  it('src/bin/api.ts loads a gazetteer and passes it to buildServer', () => {
    // A source-text assertion, for the reason tests/ingest/postCycleWiring.test.ts
    // gives: the thing being asserted is that a call site EXISTS in a
    // composition root, and a composition root is exactly the code no unit test
    // instantiates. `gazetteer` is OPTIONAL on ServerDeps -- so without this,
    // deleting the load from src/bin/api.ts removes the entire map from the
    // running system and turns nothing red.
    const source = readFileSync(join(process.cwd(), 'src', 'bin', 'api.ts'), 'utf8');
    expect(source).toContain("from '../locations/load.ts'");
    expect(source).toMatch(/\bloadGazetteerFiles\s*\(/);
    expect(source).toMatch(/\bgazetteer\b/);
  });
});

describe('the map answers with what it claims to answer with', () => {
  it('clicking a facility returns the items about it, and only those', async () => {
    // §7.2's first acceptance criterion: "clicking a fab site shows me the
    // items about it."
    const server = realServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/map/locations/asml-veldhoven/items',
      headers: AUTH,
    });
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toContain('Veldhoven');
    // The Exchange item must NOT be here. That is the operator-alone rule
    // holding, and it is the difference between an infrastructure map and a
    // map of who was in the headlines.
    expect(body.items.map((i: { title: string }) => i.title)).not.toContain(
      'Microsoft patches critical Exchange flaw',
    );
    await server.close();
  });

  it('every location carries the provenance §7.2 requires the UI to show', async () => {
    const server = realServer();
    const res = await server.inject({ method: 'GET', url: '/api/map/locations', headers: AUTH });
    const { locations } = res.json();
    expect(locations.length).toBeGreaterThan(0);
    for (const l of locations) {
      // "Expect this file to be wrong and stale in places -- build the UI to
      // show verified_at so I know how much to trust a pin." A client cannot
      // show what the API does not send.
      expect(l.verifiedAt, l.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(l.sourceUrl, l.id).toMatch(/^https?:\/\//);
      expect(['site', 'city', 'region'], l.id).toContain(l.precision);
    }
    await server.close();
  });

  it('an item count on a marker matches the list behind it', async () => {
    // A discrepancy between the two would be a plausible wrong answer of
    // exactly the kind this project keeps finding: the marker says 12, the
    // click shows 9, and nothing reports it.
    const server = realServer();
    const list = (
      await server.inject({ method: 'GET', url: '/api/map/locations', headers: AUTH })
    ).json();

    for (const location of list.locations.filter((l: { itemCount: number }) => l.itemCount > 0)) {
      const items = (
        await server.inject({
          method: 'GET',
          url: `/api/map/locations/${location.id}/items`,
          headers: AUTH,
        })
      ).json();
      expect(items.items.length, location.id).toBe(location.itemCount);
    }
    await server.close();
  });

  it('persists the projection choice server-side, per §7.2', async () => {
    const server = realServer();
    const before = (
      await server.inject({ method: 'GET', url: '/api/map/prefs', headers: AUTH })
    ).json();
    expect(before.projection).toBe('globe');

    const put = await server.inject({
      method: 'PUT',
      url: '/api/map/prefs',
      headers: AUTH,
      payload: { projection: 'mercator', layers: { ...before.layers, items: true } },
    });
    expect(put.statusCode).toBe(200);

    const after = (
      await server.inject({ method: 'GET', url: '/api/map/prefs', headers: AUTH })
    ).json();
    expect(after.projection).toBe('mercator');
    expect(after.layers.items).toBe(true);
    await server.close();
  });

  it('refuses a projection it cannot render rather than storing it', async () => {
    const server = realServer();
    const before = (
      await server.inject({ method: 'GET', url: '/api/map/prefs', headers: AUTH })
    ).json();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/map/prefs',
      headers: AUTH,
      payload: { projection: 'orthographic-but-not-really', layers: before.layers },
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });
});

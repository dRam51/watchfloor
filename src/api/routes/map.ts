import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/connection.ts';
import type { GazetteerConfig } from '../../locations/load.ts';
import { buildSupplyArcs, DEFAULT_ACTIVITY_WINDOW_HOURS } from '../../map/arcs.ts';
import {
  DEFAULT_MAP_PREFS,
  getMapPrefs,
  setMapPrefs,
  MAP_LAYERS,
  MAP_PROJECTIONS,
  type MapPrefs,
} from '../../domain/mapPrefs.ts';

/**
 * The §7.2 map API.
 *
 * ## Every response is an index back into the corpus
 *
 * §7.2: *"The map is an index into the corpus, not a separate destination --
 * every click must land back in the item list."* So each resource here either
 * returns something clickable or returns the items behind a click. There is no
 * endpoint whose output is only decorative.
 *
 * ## `verified_at` and `precision` are part of the contract, not metadata
 *
 * §7.2: *"Expect this file to be wrong and stale in places -- build the UI to
 * show `verified_at` so I know how much to trust a pin."* Both fields ride on
 * every location. A client that draws a pin without them is drawing a claim
 * with no provenance, and the API makes that awkward by never omitting them.
 *
 * ## What is NOT here
 *
 * No basemap endpoint. Country polygons are a static, public-domain asset
 * served by the frontend (`web/public/geo/countries.geojson`), not corpus
 * data -- routing them through an authenticated API would add a bearer token
 * to a file that is identical for every user on earth.
 */

export interface MapRouteDeps {
  db: Db;
  gazetteer: GazetteerConfig;
  /** Injectable for tests; production passes the real clock. */
  now?: () => string;
}

function invalidQuery(error: z.ZodError): { error: string; issues: string[] } {
  return {
    error: 'invalid query',
    issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}

const ItemsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ArcsQuery = z.object({
  windowHours: z.coerce.number().int().min(1).max(24 * 90).default(DEFAULT_ACTIVITY_WINDOW_HOURS),
});

const PrefsBody = z.object({
  projection: z.enum(MAP_PROJECTIONS),
  layers: z.object(
    Object.fromEntries(MAP_LAYERS.map((l) => [l, z.boolean()])) as Record<
      (typeof MAP_LAYERS)[number],
      z.ZodBoolean
    >,
  ),
});

export function registerMap(server: FastifyInstance, deps: MapRouteDeps): void {
  const now = deps.now ?? (() => new Date().toISOString());
  const { db, gazetteer } = deps;

  /**
   * Every curated location, with its live item count.
   *
   * The count comes from the same threshold the pins are drawn at, so "12
   * items" on a marker and the list you get by clicking it are the same twelve
   * -- a discrepancy there would be the kind of plausible wrong answer this
   * project keeps finding.
   */
  server.get('/map/locations', async (_request, reply) => {
    const counts = new Map(
      (
        db
          .prepare(
            `select location_id, count(*) as n
               from item_locations
              where geo_confidence >= ?
              group by location_id`,
          )
          .all(gazetteer.minConfidence) as Array<{ location_id: string; n: number }>
      ).map((r) => [r.location_id, r.n]),
    );

    return reply.send({
      minConfidence: gazetteer.minConfidence,
      locations: gazetteer.locations.map((l) => ({
        id: l.locationId,
        name: l.name,
        kind: l.kind,
        operator: l.operator,
        country: l.country,
        lat: l.lat,
        lon: l.lon,
        precision: l.precision,
        city: l.city,
        notes: l.notes,
        sourceUrl: l.sourceUrl,
        verifiedAt: l.verifiedAt,
        entities: l.entities,
        itemCount: counts.get(l.locationId) ?? 0,
      })),
    });
  });

  /**
   * The jurisdiction layer.
   *
   * `hasPolicyClaim` is a first-class field rather than something a client
   * infers from `exportControl === 'unknown'`, because the difference matters
   * and is easy to lose: a curated row saying `unknown` is *"someone looked and
   * would not commit"*, while a generated row is *"nobody has looked."* Both
   * render uncoloured; only one is a question worth answering.
   */
  server.get('/map/jurisdictions', async (_request, reply) => {
    const counts = new Map(
      (
        db
          .prepare(
            `select country_code, count(*) as n
               from item_countries
              where geo_confidence >= ?
              group by country_code`,
          )
          .all(gazetteer.minConfidence) as Array<{ country_code: string; n: number }>
      ).map((r) => [r.country_code, r.n]),
    );

    return reply.send({
      minConfidence: gazetteer.minConfidence,
      jurisdictions: gazetteer.jurisdictions.map((j) => ({
        code: j.code,
        name: j.name,
        exportControl: j.exportControl,
        roles: j.roles,
        notes: j.notes,
        sourceUrl: j.sourceUrl,
        verifiedAt: j.verifiedAt,
        hasPolicyClaim: j.roles.length > 0 || j.exportControl !== 'unknown',
        itemCount: counts.get(j.code) ?? 0,
      })),
    });
  });

  /** §7.2: *"Click a facility -> the items linked to it."* */
  server.get<{ Params: { id: string } }>('/map/locations/:id/items', async (request, reply) => {
    const parsed = ItemsQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(invalidQuery(parsed.error));

    const location = gazetteer.locations.find((l) => l.locationId === request.params.id);
    // 404 here is correct where it is wrong on /entities: a location id is a
    // curated identifier from a config file we control, not extracted text, so
    // an unknown one really is "no such thing" rather than "nothing matched".
    if (location === undefined) {
      return reply.code(404).send({ error: `no location with id ${request.params.id}` });
    }

    return reply.send({
      location: { id: location.locationId, name: location.name, verifiedAt: location.verifiedAt },
      items: readItems(
        db,
        `select i.item_id, i.title, i.canonical_url, i.source_id, i.published_at, i.fetched_at,
                il.geo_confidence as confidence
           from item_locations il
           join items i on i.item_id = il.item_id
          where il.location_id = ? and il.geo_confidence >= ?
          order by i.fetched_at desc
          limit ?`,
        [request.params.id, gazetteer.minConfidence, parsed.data.limit],
      ),
    });
  });

  /** §7.2: *"Click a jurisdiction -> the policy items scoped to it."* */
  server.get<{ Params: { code: string } }>('/map/countries/:code/items', async (request, reply) => {
    const parsed = ItemsQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(invalidQuery(parsed.error));

    const code = request.params.code.toUpperCase();
    const jurisdiction = gazetteer.jurisdictions.find((j) => j.code === code);
    if (jurisdiction === undefined) {
      return reply.code(404).send({ error: `no jurisdiction with code ${code}` });
    }

    return reply.send({
      jurisdiction: { code: jurisdiction.code, name: jurisdiction.name },
      items: readItems(
        db,
        `select i.item_id, i.title, i.canonical_url, i.source_id, i.published_at, i.fetched_at,
                ic.geo_confidence as confidence
           from item_countries ic
           join items i on i.item_id = ic.item_id
          where ic.country_code = ? and ic.geo_confidence >= ?
          order by i.fetched_at desc
          limit ?`,
        [code, gazetteer.minConfidence, parsed.data.limit],
      ),
    });
  });

  server.get('/map/arcs', async (request, reply) => {
    const parsed = ArcsQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(invalidQuery(parsed.error));

    return reply.send({
      windowHours: parsed.data.windowHours,
      arcs: buildSupplyArcs(db, gazetteer, {
        now: now(),
        windowHours: parsed.data.windowHours,
      }),
    });
  });

  server.get('/map/prefs', async (_request, reply) => reply.send(getMapPrefs(db)));

  server.put('/map/prefs', async (request, reply) => {
    const parsed = PrefsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid body',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        defaults: DEFAULT_MAP_PREFS,
      });
    }
    setMapPrefs(db, parsed.data as MapPrefs, now());
    return reply.send(getMapPrefs(db));
  });
}

interface ItemRow {
  item_id: string;
  title: string;
  canonical_url: string;
  source_id: string;
  published_at: string | null;
  fetched_at: string;
  confidence: number;
}

function readItems(db: Db, sql: string, params: unknown[]): unknown[] {
  // Inline type literal on the cast, NOT the named `ItemRow[]` -- `.all()`
  // returns `Record<string, SQLOutputValue>[]` and TypeScript's `as` overlap
  // check is stricter about a named-interface array target (TS2352). The named
  // type is fine everywhere except as the direct cast target. See
  // src/cluster/store.ts and CLAUDE.md.
  const rows = db.prepare(sql).all(...(params as never[])) as unknown as ItemRow[];
  return rows.map((r) => ({
    itemId: r.item_id,
    title: r.title,
    url: r.canonical_url,
    sourceId: r.source_id,
    publishedAt: r.published_at,
    fetchedAt: r.fetched_at,
    confidence: r.confidence,
  }));
}

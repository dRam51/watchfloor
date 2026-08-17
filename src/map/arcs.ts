import type { Db } from '../db/connection.ts';
import type { GazetteerConfig, LocationRule } from '../locations/load.ts';

/**
 * §7.2's animated supply-chain arcs, derived server-side.
 *
 * > *"animated great-circle arcs for supply-chain flows -- ASML -> TSMC ->
 * > NVDA -> hyperscaler regions, derived from the `related_entities` map. Arcs
 * > pulse when a related item lands."*
 *
 * ## Why this is server code and not a frontend helper
 *
 * §7.1: *"The HTTP API is the only contract. No business logic in the
 * frontend. Scoring, clustering, filtering, and state transitions all live
 * server-side."* Which arcs exist, and when one should pulse, are both
 * derivations over the corpus. A future native shell (§7.3) gets the same
 * arcs from the same endpoint rather than reimplementing this.
 *
 * ## The chain is declared, not inferred
 *
 * A first design mined arcs purely from entity co-occurrence in clusters. It
 * is the wrong instrument: co-occurrence tells you which companies are written
 * about together, which for this corpus means "both appeared in a market
 * wrap-up". That produces a dense, uninformative mesh -- every large-cap
 * connected to every other -- and it would look busy while encoding nothing
 * about supply.
 *
 * The physical chain is a small, stable, KNOWN fact: lithography feeds
 * fabrication, fabrication feeds packaging, packaging feeds accelerators,
 * accelerators fill data centres. That belongs in config, cited, like every
 * other claim about the physical world in this milestone.
 *
 * Co-occurrence still has a job, and it is the right one: it sets each arc's
 * **activity** -- how much the corpus is currently talking about both ends at
 * once -- and supplies `pulseAt`. The topology is declared; the liveliness is
 * measured.
 */

/** The ordered stages of the supply chain an arc can span. */
export const SUPPLY_STAGES = [
  'equipment',
  'fabrication',
  'packaging',
  'design',
  'compute',
] as const;
export type SupplyStage = (typeof SUPPLY_STAGES)[number];

/**
 * Which stage a location kind occupies. Derived from `kind` rather than
 * declared per row, so adding a fab to config cannot forget to say what a fab
 * is for.
 *
 * `hq` is `equipment` for a reason that looks wrong until you check the data:
 * the only `hq` rows in the committed gazetteer are ASML, Applied Materials,
 * Lam Research and Tokyo Electron -- toolmakers -- plus NVIDIA, which is
 * overridden below. A `port` belongs to no stage: it is a chokepoint on every
 * arc rather than an endpoint of any.
 */
const STAGE_BY_KIND: Partial<Record<LocationRule['kind'], SupplyStage>> = {
  hq: 'equipment',
  fab: 'fabrication',
  packaging: 'packaging',
  datacenter: 'compute',
  colo: 'compute',
  cloud_region: 'compute',
};

/**
 * Entities whose stage is not what their site's `kind` implies. NVIDIA's row
 * is an `hq` because that is what Santa Clara is, but NVIDIA is the design
 * stage, not the equipment stage -- and getting this wrong would draw the
 * headline arc of the whole chain backwards.
 */
const STAGE_BY_ENTITY: Readonly<Record<string, SupplyStage>> = {
  NVIDIA: 'design',
  AMD: 'design',
  Broadcom: 'design',
};

function stageOf(location: LocationRule): SupplyStage | null {
  for (const entity of location.entities) {
    const override = STAGE_BY_ENTITY[entity];
    if (override !== undefined) return override;
  }
  return STAGE_BY_KIND[location.kind] ?? null;
}

/** Consecutive stages only. An arc from lithography straight to a data centre
 * would assert a relationship that does not exist. */
function isAdjacent(from: SupplyStage, to: SupplyStage): boolean {
  return SUPPLY_STAGES.indexOf(to) - SUPPLY_STAGES.indexOf(from) === 1;
}

export interface SupplyArc {
  fromLocationId: string;
  toLocationId: string;
  fromStage: SupplyStage;
  toStage: SupplyStage;
  /** Great-circle vertices, [lon, lat], ready for a GeoJSON LineString. */
  path: Array<[number, number]>;
  /**
   * Items in the window touching EITHER endpoint. Drives line width and how
   * hard the arc pulses.
   */
  activity: number;
  /**
   * The most recent item touching either endpoint, or null. This is what
   * §7.2's *"arcs pulse when a related item lands"* keys on -- the client
   * pulses an arc whose `pulseAt` moved since the last poll, which needs no
   * push channel and no client-side state beyond the previous response.
   */
  pulseAt: string | null;
}

// ---------------------------------------------------------------------------
// Great circles
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/**
 * Points along the great circle between two coordinates, by spherical linear
 * interpolation.
 *
 * Computed here rather than in the client because a straight line in either
 * projection is wrong in both: on a mercator map the shortest path between
 * Taipei and Phoenix bows far north of a straight segment, and on a globe a
 * straight segment tunnels through the earth. Emitting real vertices means one
 * geometry renders correctly under both projections, which is the whole point
 * of §7.2 treating them as two views of the same data.
 *
 * The antipodal case (`sin(d) == 0`) falls back to the endpoints: the great
 * circle is undefined there because every path is equally short, and no pair
 * in this gazetteer is antipodal anyway.
 */
export function greatCircle(
  from: readonly [number, number],
  to: readonly [number, number],
  segments = 48,
): Array<[number, number]> {
  const [lon1, lat1] = [from[0] * DEG, from[1] * DEG];
  const [lon2, lat2] = [to[0] * DEG, to[1] * DEG];

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  if (!Number.isFinite(d) || Math.sin(d) === 0) {
    return [
      [from[0], from[1]],
      [to[0], to[1]],
    ];
  }

  const points: Array<[number, number]> = [];
  for (let i = 0; i <= segments; i += 1) {
    const f = i / segments;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);
    points.push([
      Math.atan2(y, x) / DEG,
      Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG,
    ]);
  }
  return points;
}

// ---------------------------------------------------------------------------
// Building the arc set
// ---------------------------------------------------------------------------

export interface ArcOptions {
  /** ISO instant the activity window ends at. The reader's `now`. */
  now: string;
  /** How far back activity counts. */
  windowHours?: number;
}

export const DEFAULT_ACTIVITY_WINDOW_HOURS = 168;

interface ActivityRow {
  location_id: string;
  n: number;
  latest: string | null;
}

export function buildSupplyArcs(
  db: Db,
  config: GazetteerConfig,
  options: ArcOptions,
): SupplyArc[] {
  const windowHours = options.windowHours ?? DEFAULT_ACTIVITY_WINDOW_HOURS;
  const since = new Date(Date.parse(options.now) - windowHours * 3600_000).toISOString();

  // Activity is measured on FIRST-SEEN fetched_at, never published_at. Every
  // point-in-time read path in this project keys on when WE saw an item, for
  // the reason src/domain/itemBeats.ts records: 1,715 items in the first live
  // corpus had a null published_at, and a window on a nullable column silently
  // drops them.
  //
  // Inline type literal, NOT a named interface: `.all()` returns
  // `Record<string, SQLOutputValue>[]` and TypeScript's `as` overlap check is
  // stricter about a named-interface array target (TS2352). See
  // src/cluster/store.ts and CLAUDE.md -- leave this comment or the next
  // tidy-up reintroduces the error.
  const rows = db
    .prepare(
      `select il.location_id      as location_id,
              count(*)            as n,
              max(i.fetched_at)   as latest
         from item_locations il
         join items i on i.item_id = il.item_id
        where il.geo_confidence >= ?
          and i.fetched_at >= ?
        group by il.location_id`,
    )
    .all(config.minConfidence, since) as unknown as ActivityRow[];

  const activity = new Map(rows.map((r) => [r.location_id, r]));

  const byStage = new Map<SupplyStage, LocationRule[]>();
  for (const loc of config.locations) {
    const stage = stageOf(loc);
    if (stage === null) continue;
    const list = byStage.get(stage);
    if (list === undefined) byStage.set(stage, [loc]);
    else list.push(loc);
  }

  const arcs: SupplyArc[] = [];
  for (const [fromStage, fromList] of byStage) {
    for (const [toStage, toList] of byStage) {
      if (!isAdjacent(fromStage, toStage)) continue;
      for (const from of fromList) {
        for (const to of toList) {
          const a = activity.get(from.locationId);
          const b = activity.get(to.locationId);

          // Every declared adjacency is emitted, including arcs with zero
          // activity. They are the chain's resting state and are drawn dim --
          // an empty map is not the honest rendering of "a quiet week", and
          // omitting a link would say the relationship stopped existing.
          const latest = [a?.latest ?? null, b?.latest ?? null]
            .filter((v): v is string => v !== null)
            .sort()
            .at(-1);

          arcs.push({
            fromLocationId: from.locationId,
            toLocationId: to.locationId,
            fromStage,
            toStage,
            path: greatCircle([from.lon, from.lat], [to.lon, to.lat]),
            activity: (a?.n ?? 0) + (b?.n ?? 0),
            pulseAt: latest ?? null,
          });
        }
      }
    }
  }

  // Busiest first, id-stable ties: a client that draws only the top N should
  // get the meaningful ones, and a stable order keeps a re-poll from
  // reshuffling the map.
  arcs.sort(
    (x, y) =>
      y.activity - x.activity ||
      (x.fromLocationId < y.fromLocationId ? -1 : x.fromLocationId > y.fromLocationId ? 1 : 0) ||
      (x.toLocationId < y.toLocationId ? -1 : 1),
  );
  return arcs;
}

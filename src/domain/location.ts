import type { Db } from '../db/connection.ts';

export type LocationKind =
  | 'fab'
  | 'packaging'
  | 'datacenter'
  | 'colo'
  | 'cloud_region'
  | 'hq'
  | 'port';

export interface Location {
  locationId: string;
  name: string;
  kind: LocationKind;
  operator: string | null;
  country: string;
  lat: number;
  lon: number;
  notes: string | null;
  /** Where the fact came from. Mandatory (§7.2). */
  sourceUrl: string;
  /** How stale this pin is. Surfaced in the UI (§7.2). */
  verifiedAt: string;
}

interface LocationRow {
  location_id: string;
  name: string;
  kind: LocationKind;
  operator: string | null;
  country: string;
  lat: number;
  lon: number;
  notes: string | null;
  source_url: string;
  verified_at: string;
}

function toLocation(row: LocationRow): Location {
  return {
    locationId: row.location_id,
    name: row.name,
    kind: row.kind,
    operator: row.operator,
    country: row.country,
    lat: row.lat,
    lon: row.lon,
    notes: row.notes,
    sourceUrl: row.source_url,
    verifiedAt: row.verified_at,
  };
}

export function upsertLocation(db: Db, loc: Location): void {
  db.prepare(
    `insert into locations (location_id, name, kind, operator, country, lat, lon,
                            notes, source_url, verified_at)
     values (?,?,?,?,?,?,?,?,?,?)
     on conflict (location_id) do update set
       name = excluded.name, kind = excluded.kind, operator = excluded.operator,
       country = excluded.country, lat = excluded.lat, lon = excluded.lon,
       notes = excluded.notes, source_url = excluded.source_url,
       verified_at = excluded.verified_at`,
  ).run(
    loc.locationId,
    loc.name,
    loc.kind,
    loc.operator ?? null,
    loc.country,
    loc.lat,
    loc.lon,
    loc.notes ?? null,
    loc.sourceUrl,
    loc.verifiedAt,
  );
}

export function listLocations(db: Db): Location[] {
  // `.all()` is typed as `Record<string, SQLOutputValue>[]` (see
  // node:sqlite's ambient types). Unlike a single-row `.get()` cast (see
  // item.ts's hydrate()), TypeScript's assertion-comparability check for
  // generic array types doesn't treat an index-signature array as
  // "sufficiently overlapping" a named-property array, so a direct `as
  // LocationRow[]` fails to typecheck under this project's strict tsconfig.
  // The extra `unknown` step is required, not optional, and has no runtime
  // effect — type assertions are erased at runtime either way.
  return (
    db.prepare('select * from locations order by name').all() as unknown as LocationRow[]
  ).map(toLocation);
}

export function linkItemLocation(
  db: Db,
  itemId: string,
  locationId: string,
  geoConfidence: number,
): void {
  db.prepare(
    `insert into item_locations (item_id, location_id, geo_confidence) values (?,?,?)
     on conflict (item_id, location_id) do update set geo_confidence = excluded.geo_confidence`,
  ).run(itemId, locationId, geoConfidence);
}

export function getItemLocations(
  db: Db,
  itemId: string,
): Array<Location & { geoConfidence: number }> {
  const rows = db
    .prepare(
      `select l.*, il.geo_confidence as geo_confidence
         from item_locations il
         join locations l on l.location_id = il.location_id
        where il.item_id = ?
        order by l.name`,
    )
    .all(itemId) as unknown as Array<LocationRow & { geo_confidence: number }>;

  return rows.map((row) => ({ ...toLocation(row), geoConfidence: row.geo_confidence }));
}

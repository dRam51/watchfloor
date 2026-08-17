import type { Db } from '../db/connection.ts';
import { listLocations, upsertLocation, type Location } from '../domain/location.ts';
import type { GazetteerConfig, LocationRule } from './load.ts';

/**
 * Apply `config/locations.yaml` (plus any overlay) to the `locations` table.
 *
 * ## Why this exists at all
 *
 * `locations` has existed since `0001_init.sql` and held zero rows across
 * three milestones, because nothing ever wrote to it. `src/domain/location.ts`
 * has had a working `upsertLocation` the whole time, fully tested, reachable
 * from nothing. This function is the missing half.
 *
 * ## Config is the source of truth; the table is a projection of it
 *
 * The table exists so that `item_locations` can carry a foreign key and so a
 * read path can join without parsing YAML. It is never edited directly, and a
 * row removed from config is REPORTED rather than deleted -- CLAUDE.md's
 * never-delete rule is not suspended for convenience, and an orphaned row is
 * something to look at rather than something to clean up silently. The same
 * stance `src/entities/sweep.ts` takes toward entities the current ruleset can
 * no longer produce.
 */

export interface SeedReport {
  /** Rows written this run (inserted or updated -- the upsert cannot tell). */
  written: number;
  /**
   * Location ids in the table that config no longer defines. **Not deleted.**
   * Reported so a rename shows up as a pair (one orphan, one new id) instead
   * of silently accumulating a duplicate pin.
   */
  orphaned: string[];
}

function toDomain(rule: LocationRule): Location {
  return {
    locationId: rule.locationId,
    name: rule.name,
    kind: rule.kind,
    operator: rule.operator,
    country: rule.country,
    lat: rule.lat,
    lon: rule.lon,
    notes: rule.notes,
    sourceUrl: rule.sourceUrl,
    verifiedAt: rule.verifiedAt,
  };
}

export function seedLocations(db: Db, config: GazetteerConfig): SeedReport {
  const known = new Set(config.locations.map((l) => l.locationId));
  const orphaned = listLocations(db)
    .map((l) => l.locationId)
    .filter((id) => !known.has(id));

  // One transaction: a half-applied gazetteer would leave item_locations rows
  // pointing at a location whose coordinates are from the previous config.
  db.exec('begin');
  try {
    for (const rule of config.locations) upsertLocation(db, toDomain(rule));
    db.exec('commit');
  } catch (cause) {
    db.exec('rollback');
    throw cause;
  }

  return { written: config.locations.length, orphaned };
}

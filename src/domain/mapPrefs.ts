import type { Db } from '../db/connection.ts';

/**
 * §7.2: *"Default to whichever the user last used; remember the choice
 * server-side."*
 *
 * §7.1 says why it cannot be `localStorage`: *"Read/saved/dismissed state is
 * server-side, keyed to nothing. Single-user means phone and desktop see
 * identical state with no sync logic, no conflict resolution, no device IDs.
 * Don't put any of it in browser storage."* Opening the map on a phone should
 * find the globe if the laptop left it on the globe.
 *
 * Same stance and same shape as `src/domain/laneState.ts`, including the part
 * that matters most: **unknown keys are dropped at READ time rather than
 * rejected at write time.** A layer removed from the code leaves a stored row
 * that no longer means anything, and the alternative to filtering it is a row
 * that cannot legally exist and a migration for every toggle.
 */

export const MAP_PROJECTIONS = ['mercator', 'globe'] as const;
export type MapProjection = (typeof MAP_PROJECTIONS)[number];

/** The independently-toggleable layers of §7.2, plus the globe's own chrome. */
export const MAP_LAYERS = [
  'fabrication',
  'compute',
  'jurisdictions',
  'items',
  'arcs',
  'terminator',
] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

export interface MapPrefs {
  projection: MapProjection;
  layers: Record<MapLayer, boolean>;
}

/**
 * §7.2: *"Items -- geo-tagged news pins, off by default."* The rest are on:
 * a map that opens with nothing drawn does not communicate that it works.
 */
export const DEFAULT_MAP_PREFS: MapPrefs = {
  projection: 'globe',
  layers: {
    fabrication: true,
    compute: true,
    jurisdictions: true,
    items: false,
    arcs: true,
    terminator: true,
  },
};

const PROJECTION_KEY = 'projection';
const LAYER_PREFIX = 'layer.';

function isProjection(value: string): value is MapProjection {
  return (MAP_PROJECTIONS as readonly string[]).includes(value);
}

function isLayer(value: string): value is MapLayer {
  return (MAP_LAYERS as readonly string[]).includes(value);
}

export function getMapPrefs(db: Db): MapPrefs {
  // Inline type literal, NOT a named interface -- `.all()` returns
  // `Record<string, SQLOutputValue>[]` and TypeScript's `as` overlap check is
  // stricter about a named-interface array target (TS2352). Sixth module to
  // hit this; see src/cluster/store.ts and CLAUDE.md.
  const rows = db.prepare('select pref_key, value from map_prefs').all() as Array<{
    pref_key: string;
    value: string;
  }>;

  const prefs: MapPrefs = {
    projection: DEFAULT_MAP_PREFS.projection,
    layers: { ...DEFAULT_MAP_PREFS.layers },
  };

  for (const row of rows) {
    if (row.pref_key === PROJECTION_KEY) {
      // A stored projection this build no longer supports falls back to the
      // default rather than throwing. The map opening in mercator is a
      // recoverable disappointment; the map failing to open is not.
      if (isProjection(row.value)) prefs.projection = row.value;
      continue;
    }
    if (row.pref_key.startsWith(LAYER_PREFIX)) {
      const layer = row.pref_key.slice(LAYER_PREFIX.length);
      if (isLayer(layer)) prefs.layers[layer] = row.value === '1';
    }
  }

  return prefs;
}

/**
 * Replace the whole preference set in one transaction.
 *
 * Whole-set, never a partial PATCH, for the reason `setLaneLayout` gives about
 * ordered collections: a partial update of a set whose members interact has no
 * obvious semantics, and "which layers are on" is read as a unit every time.
 */
export function setMapPrefs(db: Db, prefs: MapPrefs, now: string): void {
  const upsert = db.prepare(
    `insert into map_prefs (pref_key, value, updated_at) values (?,?,?)
     on conflict (pref_key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  );

  db.exec('begin');
  try {
    upsert.run(PROJECTION_KEY, prefs.projection, now);
    for (const layer of MAP_LAYERS) {
      upsert.run(`${LAYER_PREFIX}${layer}`, prefs.layers[layer] ? '1' : '0', now);
    }
    db.exec('commit');
  } catch (cause) {
    db.exec('rollback');
    throw cause;
  }
}

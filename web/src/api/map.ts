import { apiFetch } from './client.ts';

/**
 * Client types for the §7.2 map API (`src/api/routes/map.ts`).
 *
 * Every field the server sends about a pin's provenance is required here, not
 * optional. §7.2: *"Expect this file to be wrong and stale in places -- build
 * the UI to show `verified_at` so I know how much to trust a pin."* Making
 * them optional would let a component forget to render them and still compile.
 */

export type LocationKind =
  | 'fab'
  | 'packaging'
  | 'datacenter'
  | 'colo'
  | 'cloud_region'
  | 'hq'
  | 'port';

export type LocationPrecision = 'site' | 'city' | 'region';

export interface MapLocation {
  id: string;
  name: string;
  kind: LocationKind;
  operator: string | null;
  country: string;
  lat: number;
  lon: number;
  precision: LocationPrecision;
  city: string | null;
  notes: string | null;
  sourceUrl: string;
  verifiedAt: string;
  entities: string[];
  itemCount: number;
}

export type ExportControlStatus =
  | 'unrestricted'
  | 'license_required'
  | 'restricted'
  | 'embargoed'
  | 'unknown';

export type SupplyRole =
  | 'fab_capacity'
  | 'advanced_fab'
  | 'packaging'
  | 'equipment'
  | 'materials'
  | 'hyperscale_compute'
  | 'design';

export interface MapJurisdiction {
  code: string;
  name: string;
  exportControl: ExportControlStatus;
  roles: SupplyRole[];
  notes: string | null;
  sourceUrl: string;
  verifiedAt: string;
  /**
   * Whether a human wrote this row, as opposed to it being generated from the
   * basemap's country list.
   *
   * A curated row reading `unknown` means *"someone looked and would not
   * commit"*; a generated one means *"nobody has looked."* Both render
   * uncoloured and only one is a question worth answering, which is why this
   * is a field rather than something the client infers.
   */
  hasPolicyClaim: boolean;
  itemCount: number;
}

export interface SupplyArc {
  fromLocationId: string;
  toLocationId: string;
  fromStage: string;
  toStage: string;
  path: Array<[number, number]>;
  activity: number;
  pulseAt: string | null;
}

export interface MapItem {
  itemId: string;
  title: string;
  url: string;
  sourceId: string;
  publishedAt: string | null;
  fetchedAt: string;
  confidence: number;
}

export type MapProjection = 'mercator' | 'globe';

export interface MapPrefs {
  projection: MapProjection;
  layers: {
    fabrication: boolean;
    compute: boolean;
    jurisdictions: boolean;
    items: boolean;
    arcs: boolean;
    terminator: boolean;
  };
}

export type MapLayerName = keyof MapPrefs['layers'];

export function fetchLocations(token: string): Promise<{
  minConfidence: number;
  locations: MapLocation[];
}> {
  return apiFetch('/api/map/locations', token);
}

export function fetchJurisdictions(token: string): Promise<{
  minConfidence: number;
  jurisdictions: MapJurisdiction[];
}> {
  return apiFetch('/api/map/jurisdictions', token);
}

export function fetchArcs(
  token: string,
  windowHours?: number,
): Promise<{ windowHours: number; arcs: SupplyArc[] }> {
  const query = windowHours === undefined ? '' : `?windowHours=${windowHours}`;
  return apiFetch(`/api/map/arcs${query}`, token);
}

export function fetchLocationItems(
  token: string,
  locationId: string,
): Promise<{ location: { id: string; name: string; verifiedAt: string }; items: MapItem[] }> {
  return apiFetch(`/api/map/locations/${encodeURIComponent(locationId)}/items`, token);
}

export function fetchCountryItems(
  token: string,
  code: string,
): Promise<{ jurisdiction: { code: string; name: string }; items: MapItem[] }> {
  return apiFetch(`/api/map/countries/${encodeURIComponent(code)}/items`, token);
}

export function fetchMapPrefs(token: string): Promise<MapPrefs> {
  return apiFetch('/api/map/prefs', token);
}

export function saveMapPrefs(token: string, prefs: MapPrefs): Promise<MapPrefs> {
  return apiFetch('/api/map/prefs', token, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(prefs),
  });
}

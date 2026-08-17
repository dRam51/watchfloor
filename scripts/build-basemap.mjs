#!/usr/bin/env node
/**
 * Build the map's base assets from Natural Earth.
 *
 * Outputs, both COMMITTED so a clone needs no network:
 *   web/public/geo/countries.geojson   country polygons for the basemap and
 *                                      the §7.2 jurisdiction choropleth
 *   src/locations/countries.json       code -> name, the full country list the
 *                                      gazetteer matches item text against
 *
 * ===========================================================================
 * WHY THERE IS NO TILE SERVER
 * ===========================================================================
 * §7.2 says "MapLibre GL JS with a free vector tile source as the base." Every
 * candidate is either an account plus an API key embedded in the client bundle
 * (MapTiler, Stadia) or a single-maintainer donation-funded host with no
 * uptime commitment (OpenFreeMap). Both put a third-party network dependency
 * in the render path of a loopback-bound, Tailscale-only dashboard, and both
 * tell that third party which part of the world the owner is looking at. A
 * free tier with an account attached is also one pricing-page edit away from
 * violating the zero-dollar rule, whose standard is that the system be
 * INCAPABLE of spending rather than merely configured not to.
 *
 * What this map actually needs is country polygons: the fabrication and
 * compute layers are a few hundred curated points, and the jurisdiction layer
 * IS a country choropleth. Street-level detail is not in scope at any zoom
 * this view uses. Natural Earth is public domain, ships as one file, and works
 * with the network unplugged.
 *
 * The upgrade path, if street detail is ever wanted, is a Protomaps `.pmtiles`
 * extract served by our own Fastify -- still zero-dollar, still no third party.
 *
 * ===========================================================================
 * USAGE
 * ===========================================================================
 *   node scripts/build-basemap.mjs            # uses a cached download if present
 *   node scripts/build-basemap.mjs --fetch    # re-download from source
 *
 * The download is the ONLY network access, it happens at build time on a
 * developer's machine, and its output is committed. Nothing at run time,
 * test time, or ingest time fetches anything.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Natural Earth 1:110m admin-0 countries. Public domain (CC0) -- "no
// restrictions on use", stated by the project itself. The nvkelso mirror is
// the canonical distribution of the GeoJSON builds.
const SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
const LICENCE = 'Natural Earth, public domain (CC0). https://www.naturalearthdata.com/about/terms-of-use/';

const CACHE = join(repoRoot, 'web', 'public', 'geo', '.ne_110m_source.json');
const OUT_GEOJSON = join(repoRoot, 'web', 'public', 'geo', 'countries.geojson');
const OUT_COUNTRIES = join(repoRoot, 'src', 'locations', 'countries.json');

/**
 * Coordinate precision, in decimal places.
 *
 * 2dp is ~1.1 km at the equator. The whole world is 40,000 km across and this
 * basemap is never zoomed past country level, so the visible difference is
 * nil -- and it is what takes the file from 839 KB to something a lazy route
 * can afford. Measured, not assumed: the script prints both sizes.
 */
const PRECISION = 2;

function round(n) {
  const f = 10 ** PRECISION;
  return Math.round(n * f) / f;
}

/** Recursively round every coordinate. GeoJSON nests arrays to arbitrary depth. */
function roundCoords(coords) {
  if (typeof coords[0] === 'number') return [round(coords[0]), round(coords[1])];
  return coords.map(roundCoords);
}

/**
 * Natural Earth's ISO_A2 is `-99` for a number of entities -- disputed areas,
 * and a handful of ordinary countries whose code the dataset leaves unset
 * (France and Norway are the well-known cases). `ISO_A2_EH` carries the
 * "de facto sovereignty" variant and fills most of them.
 *
 * Anything still unresolved keeps a `null` code: it renders as a polygon and
 * simply cannot be joined to a jurisdiction row or an item count. That is the
 * honest outcome -- inventing a code for a disputed territory would be this
 * project making a sovereignty claim in a config file.
 */
function isoCode(props) {
  for (const key of ['ISO_A2_EH', 'ISO_A2', 'WB_A2']) {
    const value = props[key];
    if (typeof value === 'string' && /^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  }
  return null;
}

function countryName(props) {
  return props.NAME_EN ?? props.NAME ?? props.ADMIN ?? props.NAME_LONG ?? null;
}

async function main() {
  const wantFetch = process.argv.includes('--fetch');
  mkdirSync(dirname(CACHE), { recursive: true });

  let raw;
  if (!wantFetch && existsSync(CACHE)) {
    raw = readFileSync(CACHE, 'utf8');
    console.log(`using cached source (${(raw.length / 1024).toFixed(0)} KB) -- pass --fetch to re-download`);
  } else {
    console.log(`fetching ${SOURCE_URL}`);
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`);
    raw = await response.text();
    writeFileSync(CACHE, raw);
    console.log(`downloaded ${(raw.length / 1024).toFixed(0)} KB`);
  }

  const source = JSON.parse(raw);
  const features = [];
  const countries = {};

  for (const feature of source.features) {
    const props = feature.properties ?? {};
    const code = isoCode(props);
    const name = countryName(props);
    if (name === null) continue;

    features.push({
      type: 'Feature',
      // Only what the map actually reads. Natural Earth ships ~160 properties
      // per feature -- population estimates, economy classifications, label
      // placement hints -- and carrying them would multiply the file size for
      // fields no layer references.
      properties: { code, name },
      geometry: {
        type: feature.geometry.type,
        coordinates: roundCoords(feature.geometry.coordinates),
      },
    });

    // A code can legitimately appear twice (a country split into multiple
    // polygon features). First name wins; they agree.
    if (code !== null && countries[code] === undefined) countries[code] = name;
  }

  const geojson = {
    type: 'FeatureCollection',
    // Provenance travels WITH the data, not only in this script. A basemap
    // whose licence is recorded in a build script nobody reads is a basemap
    // whose licence is effectively unrecorded.
    metadata: { source: SOURCE_URL, licence: LICENCE, precision: PRECISION },
    features,
  };

  const out = JSON.stringify(geojson);
  writeFileSync(OUT_GEOJSON, out);
  writeFileSync(
    OUT_COUNTRIES,
    `${JSON.stringify({ _licence: LICENCE, _source: SOURCE_URL, countries }, null, 2)}\n`,
  );

  const named = Object.keys(countries).length;
  console.log(`wrote ${OUT_GEOJSON}`);
  console.log(`  ${features.length} features, ${(raw.length / 1024).toFixed(0)} KB -> ${(out.length / 1024).toFixed(0)} KB at ${PRECISION}dp`);
  console.log(`wrote ${OUT_COUNTRIES}`);
  console.log(`  ${named} countries with an ISO code; ${features.length - named} feature(s) left codeless (disputed or unset)`);
}

await main();

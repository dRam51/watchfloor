import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * §7.2: *"Code-split the entire map bundle behind a lazy route so the
 * daily-driver dashboard never pays for WebGL it isn't using."*
 *
 * **This test reads the BUILT output, not the source.** That distinction is
 * the whole point. Whether `MapPanel.tsx` writes `lazy(() => import(...))` is
 * a fact about the source; whether the bundler *honoured* it is a fact about
 * the bundle, and only the second one is the requirement. A single static
 * `import { something } from '../map/MapView.tsx'` added anywhere -- in a
 * test helper, in a type-only import that fails to get elided, in a barrel
 * file -- silently pulls 944 KB into the entry chunk while every source-level
 * check still passes.
 *
 * Measured at the time of writing: entry 247 KB, map chunk 944 KB. Shipping
 * the map eagerly would have quadrupled the cost of opening the dashboard, on
 * a phone, to render lanes of text.
 *
 * ## Skips rather than fails when there is no build
 *
 * `npm test` does not build the frontend, and making the whole suite depend on
 * a Vite build would make it minutes slower for one assertion. A skip with a
 * stated reason is honest; a green tick with nothing checked is not, which is
 * why the skip message says what did not run.
 */

const DIST = join(process.cwd(), 'web', 'dist');
const ASSETS = join(DIST, 'assets');

const built = existsSync(ASSETS);
const describeBuilt = built ? describe : describe.skip;

if (!built) {
  // eslint-disable-next-line no-console
  console.warn(
    'web/dist/assets is absent -- the map code-split assertions did NOT run. `npm run build:web` first.',
  );
}

describeBuilt('the map bundle is code-split behind a lazy import', () => {
  const files = built ? readdirSync(ASSETS) : [];
  const entryChunks = files.filter((f) => f.startsWith('index-') && f.endsWith('.js'));
  const mapChunks = files.filter((f) => f.startsWith('MapView-') && f.endsWith('.js'));

  it('emits a separate MapView chunk', () => {
    expect(mapChunks.length, `assets: ${files.join(', ')}`).toBeGreaterThan(0);
  });

  it('keeps maplibre-gl OUT of the entry chunk', () => {
    expect(entryChunks.length).toBeGreaterThan(0);
    for (const chunk of entryChunks) {
      const text = readFileSync(join(ASSETS, chunk), 'utf8');
      expect(
        text.includes('maplibre'),
        `${chunk} contains maplibre-gl -- something imports web/src/map/MapView.tsx statically`,
      ).toBe(false);
    }
  });

  it('puts maplibre-gl in the map chunk, so the split is real rather than empty', () => {
    // Without this, a build that dropped MapView entirely would pass the
    // assertion above. The absence of a thing is only meaningful alongside
    // evidence the thing exists somewhere.
    const text = mapChunks
      .map((chunk) => readFileSync(join(ASSETS, chunk), 'utf8'))
      .join('');
    expect(text).toContain('maplibre');
  });

  it('does not preload the map chunk from index.html', () => {
    // A `<link rel="modulepreload">` would fetch the 944 KB on first paint
    // and defeat the split while every chunk-name assertion above still
    // passed -- the split would be real and pointless.
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    const preloads = html.match(/rel="modulepreload"[^>]*href="([^"]+)"/g) ?? [];
    for (const tag of preloads) {
      expect(tag, 'index.html preloads the map chunk').not.toContain('MapView');
    }
    // The basemap is a separate concern and must also not be preloaded: it is
    // 170 KB of country polygons that only the map reads.
    expect(html).not.toContain('countries.geojson');
  });
});

describe('the basemap ships with the app and needs no network', () => {
  it('web/public/geo/countries.geojson exists and carries its provenance', () => {
    // The zero-third-party decision made checkable. If this file were ever
    // replaced by a tile-server URL, the licence and source metadata would go
    // with it and this would go red.
    const path = join(process.cwd(), 'web', 'public', 'geo', 'countries.geojson');
    expect(existsSync(path), 'run `node scripts/build-basemap.mjs`').toBe(true);

    const geojson = JSON.parse(readFileSync(path, 'utf8')) as {
      metadata?: { source?: string; licence?: string };
      features: unknown[];
    };
    expect(geojson.features.length).toBeGreaterThan(150);
    expect(geojson.metadata?.licence).toContain('public domain');
    expect(geojson.metadata?.source).toContain('natural-earth');
  });

  it('the map style names no host but our own', () => {
    // The rule that keeps this offline-capable and private. A style URL, a
    // glyphs URL, or a sprite URL pointing at a third party would each be a
    // silent network dependency in the render path -- and each is the ordinary
    // way a MapLibre style is written, so this is a real hazard rather than a
    // theoretical one.
    const raw = readFileSync(join(process.cwd(), 'web', 'src', 'map', 'MapView.tsx'), 'utf8');

    // COMMENTS STRIPPED FIRST. The first version of this test did not, and it
    // failed on its own subject's doc comment -- which contains the words "No
    // glyphs and no sprite: both are URLs to a font/icon server". A test that
    // cannot tell code from prose about code is testing the wrong text, and it
    // would have gone green the moment someone rephrased the comment while
    // leaving a real `sprite:` in the style.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const key of ['glyphs', 'sprite']) {
      expect(code, `style declares ${key}, which fetches from a host`).not.toMatch(
        new RegExp(`['"]?${key}['"]?\\s*:`),
      );
    }
    for (const url of code.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
      expect(false, `MapView.tsx contains an absolute URL in code: ${url}`).toBe(true);
    }
  });
});

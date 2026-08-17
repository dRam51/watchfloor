import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Pinning the StrictMode fix**, per CLAUDE.md's third earned practice:
 * *"Pin the absence ... so wiring it turns the test red."*
 *
 * ## The defect this guards
 *
 * React StrictMode runs every effect twice in development: mount → cleanup →
 * mount, in a single tick. `MapView.tsx` builds a MapLibre map in that effect.
 * The obvious cleanup — `map.remove()` — therefore destroyed the first map
 * microseconds after construction, while its style was still loading, and the
 * second map built into the same container **never fired `load`**.
 *
 * What made it expensive was the disguise. **The globe still rendered.**
 * Projection, atmosphere, the country basemap, the chrome — all correct. Only
 * the layers that receive their data *after* `load` were empty: markers, arcs,
 * terminator, choropleth. No error event, no console warning, no failed
 * request. `getSource()` returned undefined and `setPaintProperty` threw
 * "Style is not done loading", and both of those look exactly like "the API
 * never answered".
 *
 * Proven by bisection, not by guessing: a probe map built from the same
 * MapLibre constructor with my exact style — geojson-URL source, globe
 * projection, sky with the `atmosphere-blend` interpolate — loaded in 157 ms.
 * So did one with no sources at all. The difference was never the style, the
 * data, the worker, WebGL, or the library version. It was the double mount.
 *
 * ## Why this is a source-text assertion
 *
 * The same reasoning `tests/ingest/postCycleWiring.test.ts` gives: the thing
 * being asserted is the *shape of a lifecycle*, and jsdom cannot construct a
 * MapLibre map to observe it (no WebGL, no worker). What can be checked is
 * that the deferred-teardown pattern is still there — so a later tidy-up that
 * "simplifies" the timeout back into a direct `map.remove()` turns this red
 * instead of silently emptying every layer again.
 */

const SOURCE = readFileSync(
  join(process.cwd(), 'web', 'src', 'map', 'MapView.tsx'),
  'utf8',
);

/** Strip comments so prose about `map.remove()` is never mistaken for code. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the map survives StrictMode’s double mount', () => {
  it('never calls map.remove() synchronously in an effect cleanup', () => {
    // The exact line that caused it:  return () => { map.remove(); ... }
    // A direct `map.remove()` reachable from a cleanup is the defect. The
    // permitted form is inside the deferred callback, where it reads
    // `mapRef.current?.remove()`.
    expect(
      /return\s*\(\)\s*=>\s*\{[^}]*\bmap\.remove\s*\(/.test(CODE),
      'an effect cleanup calls map.remove() directly -- under StrictMode this destroys the ' +
        'first map while its style is loading, and the second map never fires `load`',
    ).toBe(false);
  });

  it('defers the teardown so a re-mount can cancel it', () => {
    expect(CODE).toMatch(/teardownRef\.current\s*=\s*window\.setTimeout\(/);
    expect(CODE, 'the deferred teardown must actually remove the map').toMatch(
      /mapRef\.current\?\.remove\(\)/,
    );
  });

  it('cancels a pending teardown when the effect re-runs', () => {
    // Without this, the second mount lets the timeout fire and removes the map
    // it just decided to keep -- the same empty globe by a different route.
    expect(CODE).toMatch(/window\.clearTimeout\(teardownRef\.current\)/);
  });

  it('reuses an existing map instead of building a second one', () => {
    // Two maps in one container leaks a WebGL context and double-attaches
    // every listener. Verified live: exactly one <canvas> after the fix.
    expect(CODE).toMatch(/if\s*\(mapRef\.current\s*!==\s*null\)/);
  });

  it('sets `ready` from an already-loaded map, not only from the `load` event', () => {
    // `load` fires once. A listener attached after it has fired never runs, so
    // a gate that only listens can latch shut forever -- which is precisely
    // the failure mode this whole test file exists for.
    expect(CODE).toMatch(/\bmap\.loaded\(\)\s*\)\s*setReady\(true\)/);
  });
});

describe('StrictMode stays on', () => {
  it('web/src/main.tsx still wraps the app in StrictMode', () => {
    // Turning StrictMode off "fixes" the symptom and hides a real double-mount
    // defect that would recur on any remount in production. It was disabled
    // for exactly one diagnostic run and restored; this makes that permanent.
    const main = readFileSync(join(process.cwd(), 'web', 'src', 'main.tsx'), 'utf8');
    expect(main).toMatch(/<StrictMode>/);
  });
});

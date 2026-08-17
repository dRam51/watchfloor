import { useCallback, useEffect, useRef, useState } from 'react';
// maplibre-gl@6 has NO default export -- everything is named. Importing
// `maplibregl` as a default compiles under some bundlers and fails under
// `tsc` with TS1192, which is the useful outcome: the runtime object would
// have been `undefined` and the map would have failed at `new`.
import {
  AttributionControl,
  Map as MapLibreMap,
  type ErrorEvent as MapLibreErrorEvent,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  fetchArcs,
  fetchCountryItems,
  fetchJurisdictions,
  fetchLocationItems,
  fetchLocations,
  type MapItem,
  type MapJurisdiction,
  type MapLocation,
  type MapPrefs,
  type SupplyArc,
} from '../api/map.ts';
import { prefersReducedMotion, onVisibilityChange, isPageVisible } from '../lib/motion.ts';
import { nightPolygon } from '../lib/terminator.ts';
import {
  jurisdictionFillExpression,
  jurisdictionOpacityExpression,
  kindColor,
  layerGroupOf,
  readPalette,
  type MapPalette,
} from './style.ts';
import './MapView.css';

/**
 * §7.2's infrastructure map and globe.
 *
 * **This module is the lazy chunk.** It is the only file in the frontend that
 * imports `maplibre-gl`, and nothing imports it statically -- `MapPanel.tsx`
 * reaches it through `React.lazy(() => import(...))`. §7.2: *"Code-split the
 * entire map bundle behind a lazy route so the daily-driver dashboard never
 * pays for WebGL it isn't using."*
 *
 * ## No tile server, no API key, no third-party host
 *
 * The base is `web/public/geo/countries.geojson` -- Natural Earth, public
 * domain, vendored, 170 KB. See `scripts/build-basemap.mjs` for why every
 * "free" vector tile source was rejected. Consequence worth stating: this map
 * renders with the network unplugged, and nobody outside this machine learns
 * what the owner is looking at.
 *
 * ## Everything §7.2 asks of the globe is native to MapLibre
 *
 * Checked against `maplibre-gl@6.4.0`'s type declarations rather than its
 * docs. `ProjectionSpecification.type` is a `PropertyValueSpecification`, so
 * the projection is an interpolatable style property and the 2D<->globe
 * transition is a style animation rather than a view swap. `SkySpecification`
 * carries `atmosphere-blend`, `sky-color` and `horizon-color`. Great-circle
 * arcs are a `line` layer over vertices the server computes. **No deck.gl and
 * no second globe library**, which §7.2 asked to be told about either way.
 *
 * ## !! KNOWN BROKEN, 2026-08-17 -- read before trusting this file !!
 *
 * The globe DRAWS -- projection, atmosphere, the country basemap, the 2D/globe
 * toggle -- and **MapLibre's `load` event never fires**, so `ready` below stays
 * false and every data layer (markers, arcs, terminator, choropleth) is empty.
 * `map.getSource()` returns undefined and `setPaintProperty` throws "Style is
 * not done loading".
 *
 * Do not assume the cause is in this file: a probe map with NO SOURCES AT ALL
 * fails the same way, and the failure reproduces under `vite build` and in
 * maplibre-gl v5 and v6 alike. The full elimination table is in
 * `docs/superpowers/plans/2026-08-16-m7-map-globe.md`.
 *
 * The suggested next move is to stop gating on `load` altogether -- see that
 * document. Everything below is written and typechecked and untested against a
 * working map.
 */

export interface MapViewProps {
  token: string;
  onUnauthorized: () => void;
  prefs: MapPrefs;
  onPrefsChange: (prefs: MapPrefs) => void;
  /** Ambient mode: rotate slowly, suppress all interaction. */
  ambient?: boolean;
  onClose?: () => void;
}

interface Selection {
  kind: 'location' | 'country';
  title: string;
  subtitle: string;
  items: MapItem[];
  loading: boolean;
}

const BASEMAP_URL = '/geo/countries.geojson';

/** One frame of rotation in ambient mode, in degrees. ~40s per revolution at 60fps. */
const AMBIENT_DEGREES_PER_FRAME = 0.15;

/**
 * The zoom at which the whole globe just fits a container of `height` pixels.
 *
 * MapLibre's world is `512 * 2^zoom` pixels wide at any zoom. Under globe
 * projection that width is the sphere's *circumference*, so the sphere's
 * on-screen diameter is `512 * 2^zoom / π`. Solving for the zoom that makes
 * the diameter a given fraction of the container gives the expression below.
 *
 * Derived rather than tuned by eye, because the container's height is not a
 * constant: it is measured from the map's position in the page, so it changes
 * with the header above it and with the window. A hardcoded zoom was the first
 * attempt and produced a globe that was cropped in one layout and a small ball
 * adrift in a black rectangle in the next.
 */
function zoomToFitGlobe(height: number, fill = 0.86): number {
  if (height <= 0) return 0;
  return Math.log2((height * fill * Math.PI) / 512);
}

/**
 * Replace a GeoJSON source's data, or report why it could not.
 *
 * ## Why this is not `source instanceof GeoJSONSource`
 *
 * It was, and it silently did nothing. `map.getSource()` returns a `Source`
 * union, so narrowing is required before `setData` -- and `instanceof` is an
 * IDENTITY check against one particular class object. Under the dev server
 * `maplibre-gl` can be evaluated as more than one module instance (Vite's
 * dependency pre-bundler versus the raw ESM served after
 * `optimizeDeps.exclude`), and then the class the map built its source from is
 * not the class this module imported. Every check returns false, every
 * `setData` is skipped, and the map renders a perfect empty globe: no markers,
 * no arcs, no terminator, no error, no warning.
 *
 * That is the shape of failure this project keeps finding -- a plausible wrong
 * answer -- and it cost a debugging pass to separate from "the API never
 * responded", because both look identical on screen. The API had responded;
 * all three fetches were 200.
 *
 * So the check is STRUCTURAL, which is true across module instances, and a
 * miss is now **loud**. A source that cannot take data is a bug in this file,
 * not a condition to tolerate quietly.
 */
function setSourceData(
  map: MapLibreMap,
  id: string,
  data: GeoJSON.GeoJSON,
  onError: (message: string) => void,
): void {
  const source: unknown = map.getSource(id);
  if (
    source === null ||
    source === undefined ||
    typeof (source as { setData?: unknown }).setData !== 'function'
  ) {
    onError(`map source "${id}" cannot accept data -- nothing will render on that layer`);
    return;
  }
  void (source as { setData: (d: GeoJSON.GeoJSON) => unknown }).setData(data);
}

function locationsToGeoJson(
  locations: readonly MapLocation[],
  palette: MapPalette,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: locations.map((l) => ({
      type: 'Feature',
      properties: {
        id: l.id,
        name: l.name,
        kind: l.kind,
        group: layerGroupOf(l.kind),
        operator: l.operator ?? '',
        itemCount: l.itemCount,
        verifiedAt: l.verifiedAt,
        precision: l.precision,
        color: kindColor(l.kind, palette),
      },
      geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
    })),
  };
}

function arcsToGeoJson(arcs: readonly SupplyArc[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: arcs.map((a) => ({
      type: 'Feature',
      properties: { activity: a.activity, from: a.fromLocationId, to: a.toLocationId },
      geometry: { type: 'LineString', coordinates: a.path },
    })),
  };
}

function buildStyle(palette: MapPalette, prefs: MapPrefs): StyleSpecification {
  return {
    version: 8,
    // No glyphs and no sprite: both are URLs to a font/icon server, and this
    // map has no text labels or icon images by design. Declaring them would
    // add exactly the third-party fetch the basemap decision exists to avoid.
    sources: {
      countries: { type: 'geojson', data: BASEMAP_URL },
      locations: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      arcs: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      terminator: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    projection: { type: prefs.projection },
    // The atmosphere. `atmosphere-blend` is interpolated by zoom because
    // MapLibre's own spec note says to when using globe projection: the halo
    // reads as a glow at world zoom and as haze on the horizon up close.
    sky: {
      'sky-color': palette.bg,
      'horizon-color': palette.accentDim,
      'fog-color': palette.surface,
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 4, 0.4, 7, 0],
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': palette.bg } },
      {
        // Land, drawn opaque UNDER the jurisdiction choropleth.
        //
        // Two layers rather than one, because the first attempt collapsed them
        // and the globe came out solid black: the choropleth's opacity ramp
        // bottoms out at 0.18 for a country the corpus has not mentioned, and
        // 0.18 of #0b0f14 over #05070a is not a visible difference. Land has
        // to read as land whether or not it is in the news, so its presence
        // and its activity are now separate channels.
        id: 'countries-land',
        type: 'fill',
        source: 'countries',
        paint: { 'fill-color': palette.border, 'fill-opacity': 1 },
      },
      {
        id: 'countries-fill',
        type: 'fill',
        source: 'countries',
        paint: {
          'fill-color': palette.surface,
          'fill-opacity': 0.25,
        },
      },
      {
        id: 'countries-outline',
        type: 'line',
        source: 'countries',
        paint: { 'line-color': palette.borderStrong, 'line-width': 0.6 },
      },
      {
        id: 'terminator',
        type: 'fill',
        source: 'terminator',
        // 0.28, not 0.38. The first value was chosen against a white-map
        // intuition and is wrong here: the palette is already near-black, so a
        // heavy overlay does not read as "night", it reads as "this half of
        // the map failed to load". The night side still has to be legible --
        // it is where half the infrastructure is at any moment.
        paint: { 'fill-color': '#000000', 'fill-opacity': 0.28 },
      },
      {
        id: 'arcs',
        type: 'line',
        source: 'arcs',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': palette.accent,
          'line-width': ['interpolate', ['linear'], ['get', 'activity'], 0, 0.4, 40, 2.2],
          'line-opacity': ['interpolate', ['linear'], ['get', 'activity'], 0, 0.12, 40, 0.6],
        },
      },
      {
        // Drawn under the marker so a busy site reads as glowing rather than
        // merely large -- §7.4's "subtle glow on live elements only".
        id: 'locations-glow',
        type: 'circle',
        source: 'locations',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-blur': 1,
          'circle-opacity': ['interpolate', ['linear'], ['get', 'itemCount'], 0, 0, 1, 0.35, 20, 0.6],
          'circle-radius': ['interpolate', ['linear'], ['get', 'itemCount'], 0, 6, 20, 26],
        },
      },
      {
        id: 'locations',
        type: 'circle',
        source: 'locations',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': ['interpolate', ['linear'], ['get', 'itemCount'], 0, 3.5, 20, 9],
          // A `city`/`region` pin is drawn hollow. §7.2 wants the UI to show
          // how much to trust a pin; a filled dot at a town centroid claims a
          // precision the row does not have, and this is that claim made
          // visible rather than merely recorded in a panel nobody opens.
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': ['case', ['==', ['get', 'precision'], 'site'], 0, 1.5],
          'circle-opacity': ['case', ['==', ['get', 'precision'], 'site'], 0.95, 0.15],
        },
      },
    ],
  };
}

export default function MapView({
  token,
  onUnauthorized,
  prefs,
  onPrefsChange,
  ambient = false,
  onClose,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const paletteRef = useRef<MapPalette>(readPalette());
  /**
   * Set the first time the reader pans or zooms by hand. After that the map
   * belongs to them and nothing here repositions it. A ref rather than state:
   * it must not cause a render, and nothing reads it during one.
   */
  const userMovedRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locations, setLocations] = useState<MapLocation[]>([]);
  const [jurisdictions, setJurisdictions] = useState<MapJurisdiction[]>([]);
  const [arcs, setArcs] = useState<SupplyArc[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);

  // -------------------------------------------------------------------------
  // Map construction. Once, ever -- prefs changes mutate the live map rather
  // than rebuilding it, which is what makes the projection change an animated
  // transition instead of a flash of empty canvas.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (containerRef.current === null) return;

    const palette = readPalette();
    paletteRef.current = palette;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: buildStyle(palette, prefs),
      center: [10, 25],
      zoom:
        prefs.projection === 'globe'
          ? zoomToFitGlobe(containerRef.current.clientHeight)
          : 0.9,
      // Ambient mode is a wall display: nothing on it should respond to a
      // passing cursor. §7.2 calls it "no interaction".
      interactive: !ambient,
      attributionControl: false,
      // Natural Earth is public domain and asks for no attribution, but saying
      // where the map came from is right regardless, and it is the only place
      // a viewer could learn there is no third party involved.
      maplibreLogo: false,
    });

    map.on('error', (e: MapLibreErrorEvent) => {
      // MapLibre surfaces missing sources and failed fetches here rather than
      // by throwing. Swallowing it is how a map ends up blank with a clean
      // console.
      setError(e.error?.message ?? 'map failed to render');
    });

    // `dragstart`/`zoomstart` fire for programmatic moves too, so the origin
    // is checked: `originalEvent` is present only when a real input device
    // caused it. Without that check the auto-fit would disable itself the
    // first time it ran.
    const markUserMoved = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent !== undefined) userMovedRef.current = true;
    };
    map.on('dragstart', markUserMoved);
    map.on('zoomstart', markUserMoved);

    map.on('load', () => {
      map.addControl(
        new AttributionControl({
          compact: true,
          customAttribution: 'Natural Earth (public domain) · no tile server',
        }),
      );
      setReady(true);
    });

    mapRef.current = map;

    // A DEV-ONLY handle for inspecting the live map from the console.
    //
    // Not a convenience: a MapLibre map exposes no way to ask "does this
    // source have features" from outside, so a layer that renders nothing is
    // indistinguishable from a layer whose data never arrived -- and this
    // milestone spent two debugging passes on exactly that ambiguity. Guarded
    // by `import.meta.env.DEV`, so the production bundle never carries it.
    if (import.meta.env.DEV) {
      (window as unknown as { __wfMap?: MapLibreMap }).__wfMap = map;
    }

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Deliberately constructed once. `prefs` is read for the initial style and
    // then applied by the effects below; adding it here would tear the map
    // down on every toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ambient]);

  // MapLibre sizes its canvas once, at construction, and does not watch its
  // container. `MapPanel` measures the map's height from its position in the
  // page, so the container's size changes AFTER the map exists -- on first
  // measurement, on window resize, and whenever the shell above it grows (the
  // enrichment strip arrives one API response later than the nav does).
  //
  // Without this the globe renders into a stale viewport: correct pixels, wrong
  // box, and on the first attempt an empty black panel with the globe drawn
  // entirely outside it.
  useEffect(() => {
    const map = mapRef.current;
    const node = containerRef.current;
    if (map === null || node === null) return;

    const observer = new ResizeObserver(() => {
      map.resize();
      // Re-fit only while the reader has not taken control. Refitting
      // unconditionally would yank someone back out to the whole earth every
      // time the window changed size, or the header above the map grew --
      // which it does, one API response after first paint.
      if (!userMovedRef.current && map.getProjection().type === 'globe') {
        map.setZoom(zoomToFitGlobe(node.clientHeight));
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ready]);

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchLocations(token), fetchJurisdictions(token), fetchArcs(token)])
      .then(([l, j, a]) => {
        if (cancelled) return;
        setLocations(l.locations);
        setJurisdictions(j.jurisdictions);
        setArcs(a.arcs);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof Error && 'status' in cause && cause.status === 401) {
          onUnauthorized();
          return;
        }
        setError(cause instanceof Error ? cause.message : 'could not load map data');
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized]);

  // Push data into the live sources.
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready) return;
    setSourceData(map, 'locations', locationsToGeoJson(locations, paletteRef.current), setError);
  }, [locations, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready) return;
    setSourceData(map, 'arcs', arcsToGeoJson(arcs), setError);
  }, [arcs, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready || jurisdictions.length === 0) return;
    const palette = paletteRef.current;
    map.setPaintProperty(
      'countries-fill',
      'fill-color',
      jurisdictionFillExpression(jurisdictions, palette) as never,
    );
    map.setPaintProperty(
      'countries-fill',
      'fill-opacity',
      jurisdictionOpacityExpression(jurisdictions) as never,
    );
  }, [jurisdictions, ready]);

  // -------------------------------------------------------------------------
  // Preferences applied to the live map
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready) return;
    // The §7.2 requirement: "smooth projection transition between 2D and globe
    // rather than a jarring view swap." setProjection animates because the
    // style property is interpolatable -- no second library, no manual tween.
    map.setProjection({ type: prefs.projection });

    // Switching TO the globe re-frames it, even if the reader had moved the
    // 2D map: the two projections want different zooms for the same content,
    // and landing on the globe zoomed into a fab is disorienting rather than
    // continuous. Switching to mercator deliberately leaves the view alone.
    const node = containerRef.current;
    if (prefs.projection === 'globe' && node !== null) {
      map.easeTo({ zoom: zoomToFitGlobe(node.clientHeight), duration: 600 });
    }
  }, [prefs.projection, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready) return;

    const visibility = (on: boolean): 'visible' | 'none' => (on ? 'visible' : 'none');
    map.setLayoutProperty('countries-fill', 'visibility', visibility(prefs.layers.jurisdictions));
    map.setLayoutProperty('arcs', 'visibility', visibility(prefs.layers.arcs));
    map.setLayoutProperty('terminator', 'visibility', visibility(prefs.layers.terminator));

    // Fabrication and compute share one source and one layer pair, so their
    // two toggles are a filter rather than two visibility flags.
    //
    // `match` rather than `in`. Both are valid style-spec expressions, and
    // `match` is the one whose behaviour is unambiguous with a `["literal",
    // [...]]` haystack -- the `in` form silently matched nothing here, which
    // renders as an empty map rather than as an error, and cost a debugging
    // pass to distinguish from "the data never arrived".
    //
    // No filter at all when both are on: the fastest path, and it removes any
    // chance of an expression bug hiding every marker in the default state.
    const groups: string[] = [];
    if (prefs.layers.fabrication) groups.push('fabrication');
    if (prefs.layers.compute) groups.push('compute');

    const filter =
      groups.length === 2
        ? null
        : groups.length === 0
          ? (['==', ['get', 'group'], '__none__'] as never)
          : (['==', ['get', 'group'], groups[0]!] as never);
    map.setFilter('locations', filter);
    map.setFilter('locations-glow', filter);
  }, [prefs.layers, ready]);

  // -------------------------------------------------------------------------
  // The terminator, recomputed on a timer
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready || !prefs.layers.terminator) return;

    const paint = () => {
      setSourceData(
        map,
        'terminator',
        { type: 'FeatureCollection', features: [nightPolygon(new Date())] },
        setError,
      );
    };
    paint();

    // Once a minute is four hundredths of a degree of rotation -- invisible,
    // and enough that the boundary is never stale by more than a minute. A
    // requestAnimationFrame loop here would recompute 181 vertices sixty times
    // a second to move the terminator by nothing.
    const timer = window.setInterval(paint, 60_000);
    return () => window.clearInterval(timer);
  }, [ready, prefs.layers.terminator]);

  // -------------------------------------------------------------------------
  // Arc pulse, and ambient rotation
  // -------------------------------------------------------------------------
  const previousPulse = useRef(new Map<string, string | null>());
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    const key = (a: SupplyArc) => `${a.fromLocationId}->${a.toLocationId}`;
    let landed = false;
    for (const arc of arcs) {
      const before = previousPulse.current.get(key(arc));
      // Only a CHANGE counts. On first load every arc has a pulseAt and none
      // of them is news -- firing then would greet every page load with the
      // whole chain flashing, which is the "blinking siren" §7.4 rules out.
      if (before !== undefined && before !== arc.pulseAt) landed = true;
      previousPulse.current.set(key(arc), arc.pulseAt);
    }
    if (!landed || prefersReducedMotion()) return;
    setPulsing(true);
    const timer = window.setTimeout(() => setPulsing(false), 1600);
    return () => window.clearTimeout(timer);
  }, [arcs]);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready || !pulsing) return;
    let frame = 0;
    const start = performance.now();
    const step = (t: number) => {
      const phase = Math.min(1, (t - start) / 1600);
      // One pulse, decaying -- §7.4: "One pulse, not a blinking siren."
      const boost = Math.sin(phase * Math.PI) * (1 - phase) * 0.5;
      map.setPaintProperty('arcs', 'line-opacity', [
        'interpolate',
        ['linear'],
        ['get', 'activity'],
        0,
        0.12 + boost,
        40,
        Math.min(1, 0.6 + boost),
      ] as never);
      if (phase < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [pulsing, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready || !ambient || prefersReducedMotion()) return;

    let frame = 0;
    let running = isPageVisible();
    const spin = () => {
      // §7.4: animations "pause when the tab is hidden". A rotating globe in a
      // background tab is pure battery cost on a laptop.
      if (running) {
        const c = map.getCenter();
        map.setCenter([c.lng + AMBIENT_DEGREES_PER_FRAME, c.lat]);
      }
      frame = requestAnimationFrame(spin);
    };
    frame = requestAnimationFrame(spin);
    const stopWatching = onVisibilityChange((visible) => {
      running = visible;
    });
    return () => {
      cancelAnimationFrame(frame);
      stopWatching();
    };
  }, [ambient, ready]);

  // -------------------------------------------------------------------------
  // Click-through -- §7.2: "every click must land back in the item list"
  // -------------------------------------------------------------------------
  const openLocation = useCallback(
    (id: string, name: string, verifiedAt: string) => {
      setSelection({
        kind: 'location',
        title: name,
        subtitle: `verified ${verifiedAt}`,
        items: [],
        loading: true,
      });
      fetchLocationItems(token, id)
        .then((r) =>
          setSelection({
            kind: 'location',
            title: r.location.name,
            subtitle: `verified ${r.location.verifiedAt}`,
            items: r.items,
            loading: false,
          }),
        )
        .catch(() => setSelection(null));
    },
    [token],
  );

  const openCountry = useCallback(
    (code: string, name: string) => {
      setSelection({ kind: 'country', title: name, subtitle: code, items: [], loading: true });
      fetchCountryItems(token, code)
        .then((r) =>
          setSelection({
            kind: 'country',
            title: r.jurisdiction.name,
            subtitle: r.jurisdiction.code,
            items: r.items,
            loading: false,
          }),
        )
        .catch(() => setSelection(null));
    },
    [token],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready || ambient) return;

    const onMarker = (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
      const props = e.features?.[0]?.properties;
      if (props === undefined) return;
      openLocation(String(props.id), String(props.name), String(props.verifiedAt));
    };
    const onCountry = (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
      const props = e.features?.[0]?.properties;
      if (props === undefined || props.code === null) return;
      openCountry(String(props.code), String(props.name));
    };
    const pointer = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const noPointer = () => {
      map.getCanvas().style.cursor = '';
    };

    map.on('click', 'locations', onMarker);
    map.on('click', 'countries-fill', onCountry);
    map.on('mouseenter', 'locations', pointer);
    map.on('mouseleave', 'locations', noPointer);

    return () => {
      map.off('click', 'locations', onMarker);
      map.off('click', 'countries-fill', onCountry);
      map.off('mouseenter', 'locations', pointer);
      map.off('mouseleave', 'locations', noPointer);
    };
  }, [ready, ambient, openLocation, openCountry]);

  const toggleLayer = (layer: keyof MapPrefs['layers']) => {
    onPrefsChange({ ...prefs, layers: { ...prefs.layers, [layer]: !prefs.layers[layer] } });
  };

  const selected =
    selection === null ? null : jurisdictions.find((j) => j.code === selection.subtitle) ?? null;

  return (
    <div className={`mapview${ambient ? ' mapview--ambient' : ''}`}>
      <div ref={containerRef} className="mapview__canvas" data-testid="map-canvas" />

      {error !== null && <div className="mapview__error">{error}</div>}

      {!ambient && (
        <div className="mapview__chrome">
          <div className="mapview__projection" role="group" aria-label="Projection">
            {(['globe', 'mercator'] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={prefs.projection === p ? 'is-active' : ''}
                aria-pressed={prefs.projection === p}
                onClick={() => onPrefsChange({ ...prefs, projection: p })}
              >
                {p === 'globe' ? 'globe' : '2D'}
              </button>
            ))}
          </div>

          <div className="mapview__layers" role="group" aria-label="Layers">
            {(
              [
                ['fabrication', 'fab'],
                ['compute', 'compute'],
                ['jurisdictions', 'juris'],
                ['arcs', 'arcs'],
                ['terminator', 'night'],
              ] as const
            ).map(([layer, label]) => (
              <button
                key={layer}
                type="button"
                className={prefs.layers[layer] ? 'is-active' : ''}
                aria-pressed={prefs.layers[layer]}
                onClick={() => toggleLayer(layer)}
              >
                {label}
              </button>
            ))}
          </div>

          {onClose !== undefined && (
            <button type="button" className="mapview__close" onClick={onClose}>
              close
            </button>
          )}
        </div>
      )}

      {selection !== null && !ambient && (
        <aside className="mapview__panel">
          <header>
            <h2>{selection.title}</h2>
            <p>{selection.subtitle}</p>
            <button type="button" onClick={() => setSelection(null)} aria-label="Close panel">
              ×
            </button>
          </header>

          {selected !== null && (
            <dl className="mapview__policy">
              <div>
                <dt>export control</dt>
                <dd>{selected.exportControl.replace(/_/g, ' ')}</dd>
              </div>
              <div>
                <dt>supply role</dt>
                <dd>{selected.roles.length === 0 ? '—' : selected.roles.join(', ').replace(/_/g, ' ')}</dd>
              </div>
              <div>
                <dt>verified</dt>
                {/* The date, always. §7.2: "build the UI to show verified_at
                    so I know how much to trust a pin." A generated row says so
                    explicitly rather than passing as a reviewed claim. */}
                <dd>
                  {selected.verifiedAt}
                  {!selected.hasPolicyClaim && <em> · not reviewed</em>}
                </dd>
              </div>
            </dl>
          )}

          {selection.loading ? (
            <p className="mapview__empty">loading…</p>
          ) : selection.items.length === 0 ? (
            <p className="mapview__empty">
              no items above the confidence threshold. The gazetteer is curated and
              deliberately sparse — a missing pin is a gap, not a claim.
            </p>
          ) : (
            <ul className="mapview__items">
              {selection.items.map((item) => (
                <li key={item.itemId}>
                  <a href={item.url} target="_blank" rel="noreferrer noopener">
                    {item.title}
                  </a>
                  <span>
                    {item.sourceId} · {(item.confidence * 100).toFixed(0)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </div>
  );
}

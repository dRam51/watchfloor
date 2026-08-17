import type { ExportControlStatus, MapJurisdiction, MapLocation } from '../api/map.ts';

/**
 * The map's palette and its data-driven paint expressions.
 *
 * ## Why the colours are read from the DOM
 *
 * §7.1: *"Design tokens in one place -- colors, spacing, type scale as CSS
 * custom properties. A native shell reuses them; a hardcoded palette doesn't
 * travel."* MapLibre paint properties cannot resolve `var(--color-accent)`;
 * they need a literal. Rather than duplicate the palette here -- which is
 * exactly the "hardcoded palette that doesn't travel" the rule forbids -- this
 * reads the computed values off `:root` at map construction.
 *
 * The consequence is the intended one: retuning `web/src/styles/tokens.css`
 * retunes the map, and `tokens.css` stays the only file where a colour is a
 * literal value.
 */

export interface MapPalette {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  accent: string;
  accentDim: string;
  alert: string;
  error: string;
}

function token(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  // A fallback rather than a throw: a missing token should cost a shade, not
  // the whole view. The map failing to open because a colour was renamed
  // would be a worse outcome than the map opening slightly wrong.
  return value === '' ? fallback : value;
}

export function readPalette(root: HTMLElement = document.documentElement): MapPalette {
  const s = getComputedStyle(root);
  return {
    bg: token(s, '--color-bg', '#05070a'),
    surface: token(s, '--color-surface', '#0b0f14'),
    surfaceRaised: token(s, '--color-surface-raised', '#121a24'),
    border: token(s, '--color-border', '#1f2937'),
    borderStrong: token(s, '--color-border-strong', '#2c3a4d'),
    text: token(s, '--color-text-primary', '#e6edf3'),
    textDim: token(s, '--color-text-dim', '#5b6672'),
    accent: token(s, '--color-accent', '#22d3ee'),
    accentDim: token(s, '--color-accent-dim', '#0e7490'),
    alert: token(s, '--color-alert', '#f59e0b'),
    error: token(s, '--color-error', '#f87171'),
  };
}

/**
 * Export-control status to fill colour.
 *
 * `unknown` deliberately gets the ordinary surface colour rather than a hue of
 * its own. §7.2 asks the jurisdiction layer to "tell me something I didn't
 * already know", and a distinct colour for "nobody has checked" would spend
 * one of the map's few visual channels on the absence of information. An
 * uncoloured country reads correctly as *no claim made*.
 */
export function exportControlColor(
  status: ExportControlStatus,
  palette: MapPalette,
): string {
  switch (status) {
    case 'embargoed':
      return palette.error;
    case 'restricted':
      return palette.alert;
    case 'license_required':
      return palette.accentDim;
    case 'unrestricted':
      return palette.borderStrong;
    case 'unknown':
      return palette.surface;
  }
}

/**
 * A `match` expression mapping each country polygon's `code` to its fill.
 *
 * Built from the fetched jurisdiction list rather than joined via
 * `setFeatureState`, because feature-state needs stable numeric feature ids
 * that this GeoJSON does not carry, and generating them would mean a
 * `promoteId` on a property that is null for the two disputed features the
 * basemap leaves codeless.
 */
export function jurisdictionFillExpression(
  jurisdictions: readonly MapJurisdiction[],
  palette: MapPalette,
): unknown[] {
  const stops: unknown[] = [];
  for (const j of jurisdictions) {
    if (j.exportControl === 'unknown') continue;
    stops.push(j.code, exportControlColor(j.exportControl, palette));
  }
  // A `match` with no stops is invalid, so the fallback stands alone when the
  // whole list is uncurated.
  if (stops.length === 0) return ['literal', palette.surface] as unknown[];
  return ['match', ['get', 'code'], ...stops, palette.surface];
}

/**
 * Fill opacity by item volume: countries the corpus is actually talking about
 * sit forward, quiet ones recede.
 *
 * This is the "alive" half of §7.4's ops-wall intent, and it is why volume is
 * expressed as opacity rather than as a second colour scale -- two competing
 * choropleths on one polygon set is unreadable, and the export-control hue is
 * the one carrying the meaning.
 */
export function jurisdictionOpacityExpression(
  jurisdictions: readonly MapJurisdiction[],
): unknown[] {
  const stops: unknown[] = [];
  const max = Math.max(1, ...jurisdictions.map((j) => j.itemCount));
  for (const j of jurisdictions) {
    if (j.itemCount === 0) continue;
    // sqrt, not linear: one country dominating the corpus (the US, by a
    // factor of two here) would otherwise flatten every other country to
    // invisible. The same reasoning the repos lane applies to star counts.
    stops.push(j.code, 0.25 + 0.55 * Math.sqrt(j.itemCount / max));
  }
  if (stops.length === 0) return ['literal', 0.25] as unknown[];
  return ['match', ['get', 'code'], ...stops, 0.18];
}

/** Marker colour by what the facility does. */
export function kindColor(kind: MapLocation['kind'], palette: MapPalette): string {
  switch (kind) {
    case 'fab':
    case 'packaging':
      return palette.accent;
    case 'datacenter':
    case 'colo':
    case 'cloud_region':
      return palette.alert;
    case 'hq':
      return palette.text;
    case 'port':
      return palette.textDim;
  }
}

/**
 * Which §7.2 layer toggle a location belongs to.
 *
 * *Fabrication and packaging* and *compute infrastructure* are two of the
 * brief's four layers. `hq` and `port` are neither, and they ride with
 * fabrication because that is what they serve here -- ASML, Applied Materials,
 * Lam Research, Tokyo Electron and the ports the wafers leave through.
 */
export function layerGroupOf(kind: MapLocation['kind']): 'fabrication' | 'compute' {
  return kind === 'datacenter' || kind === 'colo' || kind === 'cloud_region'
    ? 'compute'
    : 'fabrication';
}

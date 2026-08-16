import type { EntityGraphResponse } from '../api/entities.ts';

/**
 * Geometry for §7.4's entity graph (M5 task 17).
 *
 * ## Why a hand-rolled radial layout and not a graph library
 *
 * d3-force and cytoscape are both large — cytoscape alone is a bigger install
 * than this project's entire production dependency tree, and M5 task 10
 * already rejected `@modelcontextprotocol/sdk` on exactly that measurement (17
 * direct dependencies resolving to 93 packages against a production total of
 * 59). But size is the weaker argument. The stronger one is that a force
 * simulation is **iterative and seed-dependent**: "the same graph draws the
 * same picture" stops being a property a test can assert and becomes one you
 * hope for, and this project has spent a whole milestone making rendered
 * output a pure function of corpus state.
 *
 * And for an ego graph the simulation has almost nothing to decide. One node
 * is distinguished, every other node is one hop from it, and a force layout of
 * that converges to — a ring. So the closed-form ring is not an approximation
 * of the "real" answer; it *is* the answer, computed directly, in about eighty
 * lines with no dependency and no tick loop.
 *
 * ## Everything here is viewBox geometry, not design tokens
 *
 * §7.1's "design tokens in one place" governs colour, spacing and type. The
 * numbers below are unitless SVG coordinates in a fixed viewBox that scales to
 * whatever width the container has; they are not px, they are not spacing, and
 * they are the layout, which is what this module is. Every colour and every
 * font size the graph renders with comes from `EntityGraphView.css` via
 * `var(--token)`, and no component in this feature contains a hex value.
 */

/** A 4:3-ish box, scaled to the container by `preserveAspectRatio`. */
export const RADIAL_VIEWBOX_WIDTH = 760;
export const RADIAL_VIEWBOX_HEIGHT = 560;

/**
 * The ring the neighbours sit on.
 *
 * Chosen against the label gutter rather than aesthetically: a horizontal
 * label has `(WIDTH / 2) - RING - NODE_RADIUS_MAX` units to run into, which at
 * these numbers is 210 — about 26 monospace characters at the size this
 * renders, which is what {@link LABEL_MAX_CHARS} is set to.
 */
const RING_RADIUS = 170;

/** Gap between a node's edge and the start of its label. */
const LABEL_GAP = 10;

/**
 * Node radii, clamped hard at both ends.
 *
 * Live counts span `Linux` at 702 items and `Guardrails` at 14. A radius
 * linear in the count would draw one as a disc and the other as a dot, so the
 * scale is `sqrt` (area-proportional, which is how people actually read circle
 * size) and then clamped. The floor matters more than the ceiling: a node too
 * small to hit is a node that cannot be clicked.
 */
const NODE_RADIUS_MIN = 4;
const NODE_RADIUS_MAX = 26;

/** Stroke widths for the edges, likewise clamped. */
const EDGE_WIDTH_MIN = 0.5;
const EDGE_WIDTH_MAX = 6;

/**
 * Characters a ring label may show before it is cut.
 *
 * Measured against the gutter above, not guessed. The full name always
 * survives — the component puts it in a `<title>` and in the adjacency list
 * beside the graph — so this cuts a *label*, never a fact.
 */
export const LABEL_MAX_CHARS = 26;

const ELLIPSIS = '…';

export function truncateLabel(text: string, maxChars: number = LABEL_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}${ELLIPSIS}`;
}

export type LabelAnchor = 'start' | 'middle' | 'end';

export interface RadialNode {
  readonly entity: string;
  /** Possibly truncated. The full name is `entity`. */
  readonly label: string;
  readonly itemCount: number;
  readonly sharedItemsWithFocus: number | null;
  readonly focus: boolean;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly labelX: number;
  readonly labelY: number;
  readonly labelAnchor: LabelAnchor;
}

export interface RadialEdge {
  readonly source: string;
  readonly target: string;
  readonly sharedItems: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  /** True for a spoke to the focus, false for a chord between two neighbours. */
  readonly toFocus: boolean;
}

export interface RadialLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly RadialNode[];
  readonly edges: readonly RadialEdge[];
}

/** Maps `value` from [min,max] onto [outMin,outMax]; the midpoint when the range is empty. */
function scale(value: number, min: number, max: number, outMin: number, outMax: number): number {
  if (max <= min) return (outMin + outMax) / 2;
  const t = (value - min) / (max - min);
  return outMin + t * (outMax - outMin);
}

/** Straight up is -90°, and the layout runs clockwise from there. */
const START_ANGLE = -Math.PI / 2;

/** Anything within this of straight up or straight down centres its label. */
const VERTICAL_TOLERANCE = 1e-6;

export function layoutEntityRadial(graph: EntityGraphResponse): RadialLayout {
  const cx = RADIAL_VIEWBOX_WIDTH / 2;
  const cy = RADIAL_VIEWBOX_HEIGHT / 2;

  const focusNode = graph.nodes.find((n) => n.focus);
  const neighbours = graph.nodes.filter((n) => !n.focus);

  const itemCounts = graph.nodes.map((n) => n.itemCount);
  const minItems = itemCounts.length > 0 ? Math.min(...itemCounts) : 0;
  const maxItems = itemCounts.length > 0 ? Math.max(...itemCounts) : 0;
  const radiusOf = (itemCount: number): number =>
    scale(
      Math.sqrt(itemCount),
      Math.sqrt(minItems),
      Math.sqrt(maxItems),
      NODE_RADIUS_MIN,
      NODE_RADIUS_MAX,
    );

  const nodes: RadialNode[] = [];

  if (focusNode) {
    nodes.push({
      entity: focusNode.entity,
      label: truncateLabel(focusNode.entity),
      itemCount: focusNode.itemCount,
      sharedItemsWithFocus: null,
      focus: true,
      x: cx,
      y: cy,
      radius: radiusOf(focusNode.itemCount),
      labelX: cx,
      // Below its own circle: a label centred ON the focus would sit under the
      // spokes converging there and be the least readable text on the page.
      labelY: cy + radiusOf(focusNode.itemCount) + LABEL_GAP + 4,
      labelAnchor: 'middle',
    });
  }

  neighbours.forEach((node, index) => {
    // `neighbours.length` is never 0 inside this loop, so no guard is needed
    // for the division -- the zero-neighbour case simply never enters it.
    const angle = START_ANGLE + (index * 2 * Math.PI) / neighbours.length;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const radius = radiusOf(node.itemCount);
    const x = cx + RING_RADIUS * cos;
    const y = cy + RING_RADIUS * sin;
    const labelDistance = RING_RADIUS + radius + LABEL_GAP;

    nodes.push({
      entity: node.entity,
      label: truncateLabel(node.entity),
      itemCount: node.itemCount,
      sharedItemsWithFocus: node.sharedItemsWithFocus,
      focus: false,
      x,
      y,
      radius,
      labelX: cx + labelDistance * cos,
      labelY: cy + labelDistance * sin,
      labelAnchor:
        Math.abs(cos) < VERTICAL_TOLERANCE ? 'middle' : cos > 0 ? 'start' : 'end',
    });
  });

  const placed = new Map(nodes.map((n) => [n.entity, n]));
  const weights = graph.edges.map((e) => e.sharedItems);
  const minWeight = weights.length > 0 ? Math.min(...weights) : 0;
  const maxWeight = weights.length > 0 ? Math.max(...weights) : 0;

  const edges: RadialEdge[] = [];
  for (const edge of graph.edges) {
    const a = placed.get(edge.source);
    const b = placed.get(edge.target);
    // The route guarantees both ends are drawn, and a renderer must not depend
    // on a guarantee it cannot check: an unresolved end yields `x1={NaN}`,
    // which is an invisible line and a console warning rather than a failure
    // anyone would notice.
    if (!a || !b) continue;
    edges.push({
      source: edge.source,
      target: edge.target,
      sharedItems: edge.sharedItems,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      width: scale(edge.sharedItems, minWeight, maxWeight, EDGE_WIDTH_MIN, EDGE_WIDTH_MAX),
      toFocus: a.focus || b.focus,
    });
  }

  return { width: RADIAL_VIEWBOX_WIDTH, height: RADIAL_VIEWBOX_HEIGHT, nodes, edges };
}

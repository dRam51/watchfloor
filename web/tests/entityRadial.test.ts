import { describe, expect, it } from 'vitest';
import {
  layoutEntityRadial,
  RADIAL_VIEWBOX_HEIGHT,
  RADIAL_VIEWBOX_WIDTH,
  truncateLabel,
} from '../src/lib/entityRadial.ts';
import type { EntityGraphResponse } from '../src/api/entities.ts';

/**
 * The §7.4 graph's geometry (M5 task 17).
 *
 * This module exists as pure functions, separate from the component, for one
 * reason: **jsdom parses no stylesheet and does not lay anything out.** A
 * component test can prove a `<circle>` element exists and can read the `cx`
 * attribute back, but it cannot tell you the node fell outside the viewBox or
 * that two of them landed on the same point. Here the coordinates are ordinary
 * numbers and those are exactly the questions a test can answer.
 *
 * It is also why the layout is **radial and closed-form** rather than a force
 * simulation. A force layout is iterative and seed-dependent: "the same graph
 * draws the same picture" stops being a property you can assert and becomes
 * one you hope for. For an ego graph it also converges to a ring anyway.
 */

function graph(neighbours: Array<[string, number, number]>, focusItems = 100): EntityGraphResponse {
  return {
    entity: 'Focus',
    known: true,
    minItems: 2,
    nodes: [
      { entity: 'Focus', itemCount: focusItems, focus: true, sharedItemsWithFocus: null },
      ...neighbours.map(([entity, itemCount, shared]) => ({
        entity,
        itemCount,
        focus: false,
        sharedItemsWithFocus: shared,
      })),
    ],
    edges: neighbours.map(([entity, , shared]) => ({
      source: entity < 'Focus' ? entity : 'Focus',
      target: entity < 'Focus' ? 'Focus' : entity,
      sharedItems: shared,
    })),
    neighbours: { shown: neighbours.length, aboveThreshold: neighbours.length, hiddenBelowThreshold: 0 },
    corpus: { entitiesTotal: 100, entitiesAtOrAboveThreshold: 20, entitiesBelowThreshold: 80 },
  };
}

const THREE = graph([
  ['Alpha', 60, 30],
  ['Beta', 40, 20],
  ['Gamma', 10, 5],
]);

describe('layoutEntityRadial — where things go', () => {
  it('puts the focus at the centre of the viewBox', () => {
    const layout = layoutEntityRadial(THREE);
    const focus = layout.nodes.find((n) => n.focus)!;
    expect(focus.x).toBe(RADIAL_VIEWBOX_WIDTH / 2);
    expect(focus.y).toBe(RADIAL_VIEWBOX_HEIGHT / 2);
  });

  it('places the strongest neighbour straight up, then goes clockwise', () => {
    // A defined starting angle rather than an arbitrary one: the top is where
    // the eye lands, and the strongest relation is what should be there.
    const layout = layoutEntityRadial(THREE);
    const alpha = layout.nodes.find((n) => n.entity === 'Alpha')!;
    expect(alpha.x).toBeCloseTo(RADIAL_VIEWBOX_WIDTH / 2, 6);
    expect(alpha.y).toBeLessThan(RADIAL_VIEWBOX_HEIGHT / 2);
    // Clockwise: the second neighbour is to the RIGHT of centre.
    expect(layout.nodes.find((n) => n.entity === 'Beta')!.x).toBeGreaterThan(RADIAL_VIEWBOX_WIDTH / 2);
  });

  it('spaces neighbours evenly, so no two land on the same point', () => {
    const many = graph(Array.from({ length: 15 }, (_, i) => [`E${i}`, 10, 15 - i] as [string, number, number]));
    const layout = layoutEntityRadial(many);
    const points = layout.nodes.map((n) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`);
    expect(new Set(points).size).toBe(points.length);
  });

  it('keeps every node inside the viewBox, label room included', () => {
    const many = graph(Array.from({ length: 15 }, (_, i) => [`E${i}`, 200, 15 - i] as [string, number, number]));
    for (const node of layoutEntityRadial(many).nodes) {
      expect(node.x - node.radius).toBeGreaterThanOrEqual(0);
      expect(node.x + node.radius).toBeLessThanOrEqual(RADIAL_VIEWBOX_WIDTH);
      expect(node.y - node.radius).toBeGreaterThanOrEqual(0);
      expect(node.y + node.radius).toBeLessThanOrEqual(RADIAL_VIEWBOX_HEIGHT);
    }
  });

  it('lays out a focus with no neighbours at all, rather than dividing by zero', () => {
    // The real state for a below-threshold focus, and for any entity whose
    // only co-occurring entities the floor removed.
    const layout = layoutEntityRadial(graph([]));
    expect(layout.nodes).toHaveLength(1);
    expect(Number.isFinite(layout.nodes[0]!.x)).toBe(true);
    expect(layout.edges).toEqual([]);
  });

  it('is deterministic — the same graph draws the same picture', () => {
    // Not free: a force simulation would fail this, which is the argument for
    // a closed-form layout rather than a library.
    expect(layoutEntityRadial(THREE)).toEqual(layoutEntityRadial(THREE));
  });
});

describe('layoutEntityRadial — how big things are', () => {
  it('sizes a node by its item count, so a hub reads as a hub', () => {
    const layout = layoutEntityRadial(THREE);
    const alpha = layout.nodes.find((n) => n.entity === 'Alpha')!;
    const gamma = layout.nodes.find((n) => n.entity === 'Gamma')!;
    expect(alpha.radius).toBeGreaterThan(gamma.radius);
  });

  it('clamps node size, so one 702-item entity does not swallow the picture', () => {
    // `Linux` names 702 items live and `Guardrails` names 14. A linear radius
    // would make one a disc and the other invisible.
    const lopsided = graph([['Tiny', 1, 1], ['Huge', 5000, 1]], 5000);
    for (const node of layoutEntityRadial(lopsided).nodes) {
      expect(node.radius).toBeGreaterThanOrEqual(4);
      expect(node.radius).toBeLessThanOrEqual(26);
    }
  });

  it('weights an edge by shared items, and clamps that too', () => {
    const layout = layoutEntityRadial(THREE);
    const strong = layout.edges.find((e) => e.source === 'Alpha' || e.target === 'Alpha')!;
    const weak = layout.edges.find((e) => e.source === 'Gamma' || e.target === 'Gamma')!;
    expect(strong.width).toBeGreaterThan(weak.width);
    for (const edge of layout.edges) {
      expect(edge.width).toBeGreaterThanOrEqual(0.5);
      expect(edge.width).toBeLessThanOrEqual(6);
    }
  });

  it('does not divide by zero when every edge has the same weight', () => {
    const flat = graph([['A', 10, 3], ['B', 10, 3], ['C', 10, 3]]);
    for (const edge of layoutEntityRadial(flat).edges) expect(Number.isFinite(edge.width)).toBe(true);
  });
});

describe('layoutEntityRadial — the edges it is given', () => {
  it('draws the edges to the placed nodes, endpoint to endpoint', () => {
    const layout = layoutEntityRadial(THREE);
    const alpha = layout.nodes.find((n) => n.entity === 'Alpha')!;
    const focus = layout.nodes.find((n) => n.focus)!;
    const edge = layout.edges.find((e) => e.source === 'Alpha' || e.target === 'Alpha')!;
    expect([edge.x1, edge.y1, edge.x2, edge.y2].every(Number.isFinite)).toBe(true);
    const ends = new Set([`${edge.x1},${edge.y1}`, `${edge.x2},${edge.y2}`]);
    expect(ends.has(`${alpha.x},${alpha.y}`)).toBe(true);
    expect(ends.has(`${focus.x},${focus.y}`)).toBe(true);
  });

  it('marks focus edges apart from neighbour-to-neighbour ones', () => {
    // They are drawn differently: the focus spokes are the answer to the
    // question asked, the chords are the structure around it.
    const withChord: EntityGraphResponse = {
      ...THREE,
      edges: [...THREE.edges, { source: 'Alpha', target: 'Beta', sharedItems: 7 }],
    };
    const layout = layoutEntityRadial(withChord);
    expect(layout.edges.filter((e) => e.toFocus)).toHaveLength(3);
    expect(layout.edges.filter((e) => !e.toFocus)).toHaveLength(1);
  });

  it('drops an edge naming a node it was not given, rather than drawing to NaN', () => {
    // The API guarantees both ends are drawn, and a renderer must not depend
    // on a guarantee it cannot check: `x1={NaN}` is an invisible line and a
    // console warning, not a failure anybody notices.
    const dangling: EntityGraphResponse = {
      ...THREE,
      edges: [...THREE.edges, { source: 'Alpha', target: 'Not drawn', sharedItems: 4 }],
    };
    const layout = layoutEntityRadial(dangling);
    expect(layout.edges).toHaveLength(3);
    for (const edge of layout.edges) expect(Number.isNaN(edge.x1 + edge.y2)).toBe(false);
  });
});

describe('labels', () => {
  it('leaves a name that fits alone', () => {
    expect(truncateLabel('Prompt injection')).toBe('Prompt injection');
  });

  it('truncates a name that would run off the edge, and marks that it did', () => {
    // Live corpus: `Retrieval-augmented generation` is 30 characters, and the
    // horizontal label gutter does not hold it at the ring radius.
    const long = 'Retrieval-augmented generation';
    const label = truncateLabel(long);
    expect(label.length).toBeLessThan(long.length);
    expect(label.endsWith('…')).toBe(true);
  });

  it('anchors a label away from the centre, so it never overlaps its own ring', () => {
    const four = graph([['N', 10, 4], ['E', 10, 3], ['S', 10, 2], ['W', 10, 1]]);
    const layout = layoutEntityRadial(four);
    const anchorOf = (entity: string) => layout.nodes.find((n) => n.entity === entity)!.labelAnchor;
    expect(anchorOf('E')).toBe('start'); // right of centre -- text runs rightwards
    expect(anchorOf('W')).toBe('end'); // left of centre -- text runs leftwards
    expect(anchorOf('N')).toBe('middle'); // straight up
    expect(anchorOf('Focus')).toBe('middle');
  });
});

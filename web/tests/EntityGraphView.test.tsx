// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EntityGraphView } from '../src/components/EntityGraphView.tsx';
import { actClick, flush, mount, type Mounted } from './testUtils.tsx';
import type { EntityGraphResponse, EntityListResponse } from '../src/api/entities.ts';

/**
 * §7.4's entity graph view (M5 task 17).
 *
 * Two things this file is careful about, both learned rather than assumed:
 *
 * 1. **jsdom parses no stylesheet and lays nothing out.** So the geometry is
 *    not tested here at all — it is `web/tests/entityRadial.test.ts`, over
 *    plain numbers. What is tested here is what the component SAYS, which
 *    branch it takes, and that the names it emits and the names the stylesheet
 *    styles are the same names (the last two `describe` blocks).
 * 2. **The threshold is a claim the view makes to the user**, and the whole
 *    argument for drawing 176 nodes rather than 3,474 rests on the user being
 *    told. A test that only checked "the graph rendered" would pass against a
 *    view that silently hid 95% of the corpus.
 */

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
  vi.unstubAllGlobals();
});

const TOKEN = 'test-token';

const LIST: EntityListResponse = {
  minItems: 2,
  limit: 200,
  entitiesTotal: 3474,
  entitiesAtOrAboveThreshold: 176,
  entitiesBelowThreshold: 3298,
  entities: [
    { entity: 'Linux', itemCount: 702 },
    { entity: 'OpenAI', itemCount: 582 },
    { entity: 'Prompt injection', itemCount: 27 },
  ],
};

function graphFor(entity: string): EntityGraphResponse {
  return {
    entity,
    known: true,
    minItems: 2,
    nodes: [
      { entity, itemCount: 582, focus: true, sharedItemsWithFocus: null },
      { entity: 'ChatGPT', itemCount: 235, focus: false, sharedItemsWithFocus: 78 },
      { entity: 'Anthropic', itemCount: 31, focus: false, sharedItemsWithFocus: 15 },
      { entity: 'Claude', itemCount: 81, focus: false, sharedItemsWithFocus: 6 },
    ],
    edges: [
      { source: 'ChatGPT', target: entity, sharedItems: 78 },
      { source: 'Anthropic', target: entity, sharedItems: 15 },
      { source: 'Anthropic', target: 'Claude', sharedItems: 15 },
      { source: 'Claude', target: entity, sharedItems: 6 },
    ],
    neighbours: { shown: 3, aboveThreshold: 54, hiddenBelowThreshold: 2 },
    corpus: { entitiesTotal: 3474, entitiesAtOrAboveThreshold: 176, entitiesBelowThreshold: 3298 },
  };
}

/** Real routing: the graph handler reads the requested entity off the URL. */
function router(
  makeGraph: (entity: string) => EntityGraphResponse = graphFor,
  listBody: EntityListResponse = LIST,
) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.startsWith('/api/entities/graph')) {
      const entity = new URLSearchParams(url.split('?')[1] ?? '').get('entity') ?? '';
      return { ok: true, status: 200, json: async () => makeGraph(entity) };
    }
    return { ok: true, status: 200, json: async () => listBody };
  });
  return { fn, calls };
}

function wideViewport(): void {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    media: '',
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

async function renderView(
  makeGraph: (entity: string) => EntityGraphResponse = graphFor,
  listBody: EntityListResponse = LIST,
  props: { onClose?: () => void } = {},
): Promise<{ container: HTMLElement; calls: string[] }> {
  const { fn, calls } = router(makeGraph, listBody);
  vi.stubGlobal('fetch', fn);
  current = mount(<EntityGraphView token={TOKEN} onUnauthorized={() => {}} {...props} />);
  await flush();
  await flush();
  return { container: current.container, calls };
}

/** A mount whose every request fails -- the only way to reach the error branch. */
async function renderFailing(): Promise<HTMLElement> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })),
  );
  current = mount(<EntityGraphView token={TOKEN} onUnauthorized={() => {}} />);
  await flush();
  await flush();
  return current.container;
}

// ---------------------------------------------------------------------------

describe('EntityGraphView — the threshold is stated, not implied', () => {
  it('says how many entities it is drawing from and how many it is not', async () => {
    const { container } = await renderView();
    const text = container.textContent!;
    expect(text).toContain('176');
    expect(text).toContain('3,474');
    expect(text).toContain('3,298');
  });

  it('names the floor in items, so the number is a rule and not a mystery', async () => {
    const { container } = await renderView();
    expect(container.querySelector('.entity-graph__threshold')!.textContent).toMatch(/2 or more items/);
  });

  it('says how many neighbours of THIS entity the floor removed', async () => {
    // Per-graph, not just corpus-wide: "2 more are named alongside it but by
    // only one item each" is a different fact from the corpus total, and it is
    // the one that explains why a particular ring looks sparse.
    const { container } = await renderView();
    expect(container.querySelector('.entity-graph__neighbour-note')!.textContent).toContain('2');
  });

  it('says it is showing 3 of 54 rather than implying 3 is all there is', async () => {
    const { container } = await renderView();
    const note = container.querySelector('.entity-graph__neighbour-note')!.textContent!;
    expect(note).toContain('54');
  });
});

describe('EntityGraphView — the ranked adjacency list, which every viewport gets', () => {
  it('lists the neighbours in the order the server ranked them', async () => {
    const { container } = await renderView();
    const rows = [...container.querySelectorAll('.entity-graph__related-entity')].map(
      (el) => el.textContent,
    );
    expect(rows).toEqual(['ChatGPT', 'Anthropic', 'Claude']);
  });

  it('shows the shared-item count beside each, which is what the relation MEANS', async () => {
    const { container } = await renderView();
    const first = container.querySelector('.entity-graph__related')!;
    expect(first.textContent).toContain('78');
  });

  it('re-focuses the graph when a related entity is chosen', async () => {
    // Navigation, and the reason the list is not merely a fallback: it is how
    // you walk the graph.
    const { container, calls } = await renderView();
    const anthropic = [...container.querySelectorAll('.entity-graph__related')].find((el) =>
      el.textContent!.includes('Anthropic'),
    )!;
    actClick(anthropic.querySelector('button') ?? anthropic);
    await flush();
    expect(calls.some((u) => u.includes('entity=Anthropic'))).toBe(true);
  });

  it('url-encodes an entity name with a space', async () => {
    // `Model Context Protocol`, `S&P 500` and `Moody's` are all real. This is
    // the client half of why the route takes a query parameter.
    const { calls } = await renderView(graphFor, {
      ...LIST,
      entities: [{ entity: 'Model Context Protocol', itemCount: 69 }],
    });
    expect(calls.some((u) => u.includes('entity=Model+Context+Protocol'))).toBe(true);
  });
});

describe('EntityGraphView — the phone answer', () => {
  it('draws no SVG below the lane breakpoint, and still renders the whole relation', async () => {
    // jsdom implements no matchMedia, which `useIsWideViewport` treats as
    // narrow -- the same guarded default App.tsx relies on for Stream. A ring
    // of 15 labels does not fit 375px, so the list IS the view there. It is
    // not a degraded graph: it carries every number the graph encodes, exactly.
    const { container } = await renderView();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelectorAll('.entity-graph__related')).toHaveLength(3);
  });

  it('draws the SVG above the breakpoint, alongside the same list', async () => {
    wideViewport();
    const { container } = await renderView();
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(container.querySelectorAll('.entity-graph__node')).toHaveLength(4);
    // The chord, not just the three spokes: the structure is the point.
    expect(container.querySelectorAll('.entity-graph__edge')).toHaveLength(4);
    expect(container.querySelectorAll('.entity-graph__related')).toHaveLength(3);
  });

  it('gives the SVG an accessible summary rather than leaving it an unlabelled image', async () => {
    wideViewport();
    const { container } = await renderView();
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    // `Linux`, not `OpenAI`: the view opens on the BIGGEST entity in the list
    // rather than on nothing, so a first impression is a graph and not a
    // prompt. (This expectation said OpenAI and was wrong; the component was
    // right, and the failure is what said so.)
    expect(svg.getAttribute('aria-label')).toContain('Linux');
    expect(svg.getAttribute('aria-label')).toContain('listed below');
  });
});

describe('EntityGraphView — the states that are not a graph', () => {
  it('says an unknown entity is unknown, rather than drawing an empty ring', async () => {
    wideViewport();
    const unknown = (entity: string): EntityGraphResponse => ({
      entity,
      known: false,
      minItems: 2,
      nodes: [],
      edges: [],
      neighbours: { shown: 0, aboveThreshold: 0, hiddenBelowThreshold: 0 },
      corpus: LIST.entitiesTotal
        ? {
            entitiesTotal: 3474,
            entitiesAtOrAboveThreshold: 176,
            entitiesBelowThreshold: 3298,
          }
        : { entitiesTotal: 0, entitiesAtOrAboveThreshold: 0, entitiesBelowThreshold: 0 },
    });
    const { container } = await renderView(unknown);
    expect(container.querySelector('.entity-graph__status')!.textContent).toMatch(/no item/i);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('distinguishes "nothing co-occurs with it" from "unknown entity"', async () => {
    const lonely = (entity: string): EntityGraphResponse => ({
      ...graphFor(entity),
      nodes: [{ entity, itemCount: 3, focus: true, sharedItemsWithFocus: null }],
      edges: [],
      neighbours: { shown: 0, aboveThreshold: 0, hiddenBelowThreshold: 0 },
    });
    const { container } = await renderView(lonely);
    const status = container.querySelector('.entity-graph__status')!.textContent!;
    expect(status).toMatch(/no other entity/i);
    expect(status).not.toMatch(/no item/i);
  });

  it('says so when the corpus has no entities at all, rather than showing a blank picker', async () => {
    const { container } = await renderView(graphFor, {
      minItems: 2,
      limit: 200,
      entitiesTotal: 0,
      entitiesAtOrAboveThreshold: 0,
      entitiesBelowThreshold: 0,
      entities: [],
    });
    expect(container.textContent).toMatch(/no entities/i);
  });

  it('surfaces a failed request instead of rendering a plausible empty graph', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })),
    );
    current = mount(<EntityGraphView token={TOKEN} onUnauthorized={() => {}} />);
    await flush();
    expect(current.container.querySelector('.entity-graph__status--error')).not.toBeNull();
  });

  it('reports a 401 to its caller rather than looping the failing request', async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })),
    );
    current = mount(<EntityGraphView token={TOKEN} onUnauthorized={onUnauthorized} />);
    await flush();
    expect(onUnauthorized).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The gap jsdom leaves: it parses no stylesheet, so every test above passes
// just as happily against a stylesheet whose selectors are typo'd. M5 task 8
// closed exactly this on RepoRow; the same two directions are checked here.
// Neither judges how the graph LOOKS -- CLAUDE.md is explicit that the palette
// is a proposal and that question is the owner's.
// ---------------------------------------------------------------------------

function readWebSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

async function emittedGraphClasses(): Promise<Set<string>> {
  const emitted = new Set<string>();
  // Every branch that emits markup nothing else does. A variant list short of
  // one of these is how a stylesheet rule ends up styling nothing while this
  // test still passes -- which is the same "scope that excludes the only case
  // capable of exhibiting the defect" CLAUDE.md names as this project's
  // characteristic test failure.
  const variants: Array<() => Promise<HTMLElement>> = [
    async () => {
      wideViewport();
      // With `onClose`, which is how App.tsx really mounts it.
      return (await renderView(graphFor, LIST, { onClose: () => {} })).container;
    },
    async () => (await renderView()).container,
    async () => {
      wideViewport();
      return (
        await renderView((entity) => ({
          ...graphFor(entity),
          known: false,
          nodes: [],
          edges: [],
          neighbours: { shown: 0, aboveThreshold: 0, hiddenBelowThreshold: 0 },
        }))
      ).container;
    },
    async () => renderFailing(),
  ];
  for (const variant of variants) {
    const container = await variant();
    for (const el of container.querySelectorAll('*')) {
      for (const cls of el.classList) if (cls.startsWith('entity-graph')) emitted.add(cls);
    }
    current!.unmount();
    current = null;
    vi.unstubAllGlobals();
  }
  return emitted;
}

describe('§7.1 — no component in this feature hardcodes a colour', () => {
  it('EntityGraphView.tsx, entityRadial.ts and EntityGraphView.css carry no colour literal', () => {
    // "Design tokens in one place ... a hardcoded palette doesn't travel."
    // CLAUDE.md records the palette as a PROPOSAL, so this is load-bearing:
    // retuning it must stay a one-file edit.
    for (const rel of [
      '../src/components/EntityGraphView.tsx',
      '../src/components/EntityGraphView.css',
      '../src/lib/entityRadial.ts',
    ]) {
      const source = readWebSource(rel);
      expect(source, `${rel} must not contain a hex colour`).not.toMatch(
        /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/,
      );
      expect(source, `${rel} must not contain an rgb()/hsl() literal`).not.toMatch(/\b(rgba?|hsla?)\(/);
    }
  });

  it('every token the graph stylesheet reads is defined in tokens.css', () => {
    const tokens = readWebSource('../src/styles/tokens.css');
    const used = new Set(readWebSource('../src/components/EntityGraphView.css').match(/--[a-z-]+(?=\))/g) ?? []);
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) {
      expect(tokens, `${name} is read by EntityGraphView.css but never defined`).toContain(`${name}:`);
    }
  });
});

describe('EntityGraphView — the component and the stylesheet agree on every name', () => {
  it('every .entity-graph* selector in the stylesheet matches a class something renders', async () => {
    // The direction with no legitimate exceptions and where a typo is silent:
    // a rule for `.entity-graph__nieghbour-note` styles nothing, and the view
    // just quietly loses its layout with no error anywhere.
    const emitted = await emittedGraphClasses();
    const selectors = new Set(
      readWebSource('../src/components/EntityGraphView.css').match(/\.entity-graph[a-z0-9_-]*/g) ?? [],
    );
    expect(selectors.size).toBeGreaterThan(8);
    for (const selector of selectors) {
      expect(emitted, `${selector} is styled but no rendered element carries it`).toContain(
        selector.slice(1),
      );
    }
  });

  it('every STATE MODIFIER the component renders has a rule', async () => {
    // The other direction, restricted to classes whose whole purpose is to
    // look different (`--focus`, `--error`, `--to-focus`). A modifier nothing
    // styles is a state the UI claims to distinguish and does not.
    const css = readWebSource('../src/components/EntityGraphView.css');
    const modifiers = [...(await emittedGraphClasses())].filter((cls) => cls.includes('--'));
    expect(modifiers.length).toBeGreaterThan(2);
    for (const cls of modifiers) {
      expect(css, `.${cls} is a state modifier with no rule -- it distinguishes nothing`).toContain(
        `.${cls}`,
      );
    }
  });
});

describe('App mounts it — otherwise this is occurrence eight', () => {
  it('App.tsx renders EntityGraphView behind a nav affordance', () => {
    // CLAUDE.md's table, entry #1: `registerItems` was correctly built, fully
    // tested and reachable from nothing. A component with a passing test file
    // and no mount point is the same defect. The behavioural half of this pin
    // lives in web/tests/App.test.tsx.
    const app = readWebSource('../src/App.tsx');
    expect(app).toContain("from './components/EntityGraphView.tsx'");
    expect(app).toMatch(/<EntityGraphView/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type NewItem } from '../../src/domain/item.ts';
import { getItemEntities } from '../../src/domain/itemEntities.ts';
import {
  buildEntityGraph,
  countRelatedEntities,
  DEFAULT_GRAPH_NEIGHBOURS,
  DEFAULT_MIN_ITEMS_FOR_NODE,
  entityItemCounts,
  entityItemKeys,
  type RelatedEntity,
} from '../../src/domain/entityGraph.ts';

/**
 * §7.4's entity graph, at the domain layer (M5 task 17).
 *
 * ## Why this module exists at all, and why the tests are written this way
 *
 * `planEntityNotes(...).related` in `src/vault/entities.ts` was, until this
 * task, the **first and only** computation of the related-entity relation in
 * this tree — task 7's own report says so and recommends lifting it to
 * `src/domain/` when an endpoint is built, "rather than an API route importing
 * a vault module."
 *
 * A lift is a refactor, and the risk of a refactor is that it changes an
 * answer while every test that could notice keeps passing. So the central
 * test in this file is not an example: it is an **equivalence test against a
 * reference implementation copied verbatim out of the vault planner** as it
 * stood before the lift ({@link vaultReferenceRelated}), run over a corpus
 * with real co-occurrence structure. If the lifted function disagrees with the
 * code it replaced, on any entity, that test says so and names the entity.
 */

/** Relative to the repo root, per this project's zero-absolute-paths rule. */
const REAL_MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wf-entity-graph-'));
  db = openDb(join(dir, 'test.db'));
  runMigrations(db, REAL_MIGRATIONS_DIR);
});

afterEach(() => {
  closeDb(db);
});

let clock = 0;

/** Distinct canonical URLs give distinct `item_key`s; entities are attached per version. */
function addItem(canonicalUrl: string, entities: string[], overrides: Partial<NewItem> = {}): void {
  clock += 1;
  const fetchedAt = new Date(Date.UTC(2026, 7, 1, 0, 0, 0, clock % 1000)).toISOString();
  insertItem(db, {
    url: canonicalUrl,
    canonicalUrl,
    title: `Item ${canonicalUrl}`,
    sourceId: 'fixture-source',
    itemType: 'analysis',
    beats: ['ai'],
    entities,
    publishedAt: null,
    fetchedAt,
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The reference implementation: `planEntityNotes`'s related-list pass, copied
// verbatim from src/vault/entities.ts at commit e16fe67 (before this task).
// Nothing below may be "tidied" — its value is that it is the OLD code.
// ---------------------------------------------------------------------------

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function vaultReferenceRelated(
  database: Db,
  entity: string,
  itemKeys: readonly string[],
  writable: ReadonlySet<string>,
  maxRelated: number,
): RelatedEntity[] {
  const counts = new Map<string, number>();
  for (const key of itemKeys) {
    for (const other of getItemEntities(database, key)) {
      const otherNfc = other.normalize('NFC');
      if (otherNfc === entity || !writable.has(otherNfc)) continue;
      counts.set(otherNfc, (counts.get(otherNfc) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([name, sharedItems]) => ({ entity: name, sharedItems }))
    .sort((a, b) => b.sharedItems - a.sharedItems || byCodePoint(a.entity, b.entity))
    .slice(0, maxRelated);
}

/**
 * A corpus with the shapes that break a naive implementation:
 * a hub, a chain, a pair that never co-occurs, a singleton, and a
 * cross-listed item ingested twice under one canonical URL (two `item_id`s,
 * one `item_key`, entities split across the two versions).
 */
function seedCorpus(): void {
  addItem('https://example.test/a1', ['OpenAI', 'ChatGPT', 'Anthropic']);
  addItem('https://example.test/a2', ['OpenAI', 'ChatGPT']);
  addItem('https://example.test/a3', ['OpenAI', 'Anthropic']);
  addItem('https://example.test/a4', ['OpenAI', 'Claude']);
  addItem('https://example.test/a5', ['Anthropic', 'Claude']);
  addItem('https://example.test/a6', ['ChatGPT']);
  addItem('https://example.test/a7', ['CVE-2026-0001']);
  // Cross-listed: same canonical URL, two versions, different entity sets.
  addItem('https://example.test/x1', ['OpenAI']);
  addItem('https://example.test/x1', ['Prompt injection']);
  addItem('https://example.test/x2', ['Prompt injection', 'Claude']);
}

function allEntityNames(): string[] {
  return [...entityItemCounts(db).keys()];
}

// ---------------------------------------------------------------------------

describe('entityItemKeys — the item set an entity names', () => {
  it('counts an item once even when two stored versions share its canonical URL', () => {
    // The three-function read-path rule, in the place it bites here: a
    // cross-listed item is two `items` rows with one `item_key`, and counting
    // versions would report it twice.
    seedCorpus();
    expect(entityItemKeys(db, ['OpenAI'])).toHaveLength(5);
    expect(entityItemKeys(db, ['Prompt injection'])).toHaveLength(2);
  });

  it('unions the item sets of several spellings of one entity', () => {
    seedCorpus();
    const union = entityItemKeys(db, ['OpenAI', 'Claude']);
    expect(union.length).toBe(new Set(union).size);
    expect(union).toHaveLength(7);
  });

  it('returns nothing for an entity nothing mentions, rather than throwing', () => {
    seedCorpus();
    expect(entityItemKeys(db, ['Nothing mentions this'])).toEqual([]);
  });
});

describe('entityItemCounts — the node list', () => {
  it('counts DISTINCT items per entity, unioning versions of one key', () => {
    seedCorpus();
    const counts = entityItemCounts(db);
    expect(counts.get('OpenAI')?.itemCount).toBe(5);
    expect(counts.get('ChatGPT')?.itemCount).toBe(3);
    expect(counts.get('Prompt injection')?.itemCount).toBe(2);
    expect(counts.get('CVE-2026-0001')?.itemCount).toBe(1);
  });

  it('merges normalisation-equivalent spellings into one entity', () => {
    // `Cafe` + combining acute and precomposed `Café` are two byte sequences
    // for one string. The vault merges them because they ARE one entity; the
    // graph must draw one node for them, not two.
    const decomposed = `Cafe${String.fromCharCode(0x301)}`;
    addItem('https://example.test/n1', [decomposed]);
    addItem('https://example.test/n2', ['Café']);
    const counts = entityItemCounts(db);
    expect([...counts.keys()]).toEqual(['Café']);
    expect(counts.get('Café')?.itemCount).toBe(2);
    expect(counts.get('Café')?.spellings).toEqual([decomposed, 'Café']);
  });

  it('is empty on a corpus with no extracted entities, never null', () => {
    addItem('https://example.test/e1', []);
    expect(entityItemCounts(db).size).toBe(0);
  });
});

describe('countRelatedEntities — the ONE implementation of the relation', () => {
  it('counts the items two entities share', () => {
    seedCorpus();
    const related = countRelatedEntities(db, 'OpenAI', entityItemKeys(db, ['OpenAI']));
    expect(related).toEqual([
      { entity: 'Anthropic', sharedItems: 2 },
      { entity: 'ChatGPT', sharedItems: 2 },
      { entity: 'Claude', sharedItems: 1 },
      { entity: 'Prompt injection', sharedItems: 1 },
    ]);
  });

  it('never lists the entity as related to itself', () => {
    seedCorpus();
    const related = countRelatedEntities(db, 'OpenAI', entityItemKeys(db, ['OpenAI']));
    expect(related.map((r) => r.entity)).not.toContain('OpenAI');
  });

  it('orders by shared items desc, then by codepoint — never by locale', () => {
    // `localeCompare` depends on the host's ICU data, so two machines could
    // order one corpus differently. src/score/rank.ts already carries that
    // latent bug; this relation must not add a second one.
    seedCorpus();
    const related = countRelatedEntities(db, 'OpenAI', entityItemKeys(db, ['OpenAI']));
    expect(related[0]!.sharedItems).toBeGreaterThanOrEqual(related[1]!.sharedItems);
    // Anthropic and ChatGPT tie at 2 shared items, so the tie-break decides,
    // and it is codepoint order: `A` before `C`.
    expect(related.slice(0, 2).map((r) => r.entity)).toEqual(['Anthropic', 'ChatGPT']);
  });

  it('honours an eligibility predicate, so a caller can hide entities it will not render', () => {
    seedCorpus();
    const related = countRelatedEntities(db, 'OpenAI', entityItemKeys(db, ['OpenAI']), {
      isEligible: (name) => name === 'Claude',
    });
    expect(related).toEqual([{ entity: 'Claude', sharedItems: 1 }]);
  });

  it('honours a limit, applied AFTER the eligibility filter', () => {
    seedCorpus();
    const related = countRelatedEntities(db, 'OpenAI', entityItemKeys(db, ['OpenAI']), { limit: 2 });
    expect(related).toHaveLength(2);
  });

  it('returns nothing for an entity whose items carry no other entity', () => {
    seedCorpus();
    expect(countRelatedEntities(db, 'CVE-2026-0001', entityItemKeys(db, ['CVE-2026-0001']))).toEqual([]);
  });

  it('sees entities attributed by a DIFFERENT version of the same item', () => {
    // `x1` is one `item_key` with two versions: one carries OpenAI, the other
    // Prompt injection. A single-version read would say they never co-occur.
    // This is the exact defect `getItemEntities` was created for.
    seedCorpus();
    const related = countRelatedEntities(db, 'OpenAI', entityItemKeys(db, ['OpenAI']));
    expect(related).toContainEqual({ entity: 'Prompt injection', sharedItems: 1 });
  });
});

describe('countRelatedEntities agrees with the vault planner it was lifted from', () => {
  it('matches the pre-lift implementation for EVERY entity in the corpus', () => {
    seedCorpus();
    const names = allEntityNames();
    expect(names.length).toBeGreaterThan(4);
    const writable = new Set(names);
    for (const entity of names) {
      const keys = entityItemKeys(db, [entity]);
      expect(
        countRelatedEntities(db, entity, keys, { isEligible: (n) => writable.has(n), limit: 15 }),
        `related list for ${entity} differs from the pre-lift vault implementation`,
      ).toEqual(vaultReferenceRelated(db, entity, keys, writable, 15));
    }
  });

  it('matches it under a restricted writable set, where the filter does real work', () => {
    seedCorpus();
    const writable = new Set(['ChatGPT', 'Claude']);
    for (const entity of allEntityNames()) {
      const keys = entityItemKeys(db, [entity]);
      expect(
        countRelatedEntities(db, entity, keys, { isEligible: (n) => writable.has(n), limit: 15 }),
        `restricted related list for ${entity} differs from the pre-lift implementation`,
      ).toEqual(vaultReferenceRelated(db, entity, keys, writable, 15));
    }
  });

  it('matches it at a limit that actually truncates', () => {
    seedCorpus();
    const writable = new Set(allEntityNames());
    const keys = entityItemKeys(db, ['OpenAI']);
    expect(countRelatedEntities(db, 'OpenAI', keys, { isEligible: (n) => writable.has(n), limit: 2 }))
      .toEqual(vaultReferenceRelated(db, 'OpenAI', keys, writable, 2));
  });
});

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

describe('buildEntityGraph — the ego graph §7.4 renders', () => {
  it('puts the focus first and its neighbours after it, most-shared first', () => {
    seedCorpus();
    const graph = buildEntityGraph(db, { entity: 'OpenAI', minItems: 1 });
    expect(graph.known).toBe(true);
    expect(graph.nodes[0]).toEqual({
      entity: 'OpenAI',
      itemCount: 5,
      focus: true,
      sharedItemsWithFocus: null,
    });
    expect(graph.nodes.slice(1).map((n) => n.entity)).toEqual([
      'Anthropic',
      'ChatGPT',
      'Claude',
      'Prompt injection',
    ]);
    expect(graph.nodes.every((n, i) => (i === 0) === n.focus)).toBe(true);
  });

  it('carries each neighbour’s own item count, so a node can be sized by it', () => {
    seedCorpus();
    const graph = buildEntityGraph(db, { entity: 'OpenAI', minItems: 1 });
    const chatgpt = graph.nodes.find((n) => n.entity === 'ChatGPT');
    expect(chatgpt).toEqual({
      entity: 'ChatGPT',
      itemCount: 3,
      focus: false,
      sharedItemsWithFocus: 2,
    });
  });

  it('draws neighbour-to-neighbour edges, so it is a graph and not a star', () => {
    // Anthropic and Claude share item a5, which does not mention OpenAI at
    // all. An implementation that only asked the focus who it co-occurs with
    // would draw a star and lose this edge entirely.
    seedCorpus();
    const graph = buildEntityGraph(db, { entity: 'OpenAI', minItems: 1 });
    expect(graph.edges).toContainEqual({
      source: 'Anthropic',
      target: 'Claude',
      sharedItems: 1,
    });
  });

  it('emits each undirected pair exactly once, in codepoint order', () => {
    seedCorpus();
    const graph = buildEntityGraph(db, { entity: 'OpenAI', minItems: 1 });
    const pairs = graph.edges.map((e) => `${e.source} ${e.target}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const edge of graph.edges) expect(edge.source < edge.target).toBe(true);
  });

  it('draws no edge to an entity that is not a node', () => {
    seedCorpus();
    const graph = buildEntityGraph(db, { entity: 'OpenAI', minItems: 1, neighbours: 2 });
    const drawn = new Set(graph.nodes.map((n) => n.entity));
    for (const edge of graph.edges) {
      expect(drawn.has(edge.source), `${edge.source} is an edge end with no node`).toBe(true);
      expect(drawn.has(edge.target), `${edge.target} is an edge end with no node`).toBe(true);
    }
  });

  it('reports an unknown entity as unknown, with an empty graph rather than an error', () => {
    seedCorpus();
    const graph = buildEntityGraph(db, { entity: 'Nothing mentions this', minItems: 1 });
    expect(graph.known).toBe(false);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.entity).toBe('Nothing mentions this');
  });

  it('resolves the focus through NFC, so a decomposed request finds the composed entity', () => {
    addItem('https://example.test/n1', ['Café', 'OpenAI']);
    addItem('https://example.test/n2', ['Café', 'OpenAI']);
    const graph = buildEntityGraph(db, { entity: `Cafe${String.fromCharCode(0x301)}`, minItems: 1 });
    expect(graph.known).toBe(true);
    expect(graph.nodes[0]!.entity).toBe('Café');
  });
});

describe('buildEntityGraph — the threshold, which the view must be able to state', () => {
  it('defaults to two distinct items per node', () => {
    expect(DEFAULT_MIN_ITEMS_FOR_NODE).toBe(2);
    seedCorpus();
    expect(buildEntityGraph(db, { entity: 'OpenAI' }).minItems).toBe(2);
  });

  it('drops a single-mention neighbour at the default floor and SAYS how many it dropped', () => {
    seedCorpus();
    // `Prompt injection` has 2 items and survives; add a one-item neighbour.
    addItem('https://example.test/a8', ['OpenAI', 'CVE-2026-9999']);
    const graph = buildEntityGraph(db, { entity: 'OpenAI' });
    expect(graph.nodes.map((n) => n.entity)).not.toContain('CVE-2026-9999');
    expect(graph.neighbours.hiddenBelowThreshold).toBe(1);
    // An absent count and a zero count are different answers -- see the
    // never-say-`[]` discipline docs/api.md already applies to source health.
    expect(graph.neighbours.aboveThreshold).toBe(4);
    expect(graph.neighbours.shown).toBe(4);
  });

  it('still draws the focus the caller asked for, even below the floor', () => {
    // The threshold governs which NEIGHBOURS are worth drawing. Refusing the
    // node the user explicitly selected would answer a question nobody asked.
    seedCorpus();
    const graph = buildEntityGraph(db, { entity: 'CVE-2026-0001', minItems: 2 });
    expect(graph.known).toBe(true);
    expect(graph.nodes[0]).toEqual({
      entity: 'CVE-2026-0001',
      itemCount: 1,
      focus: true,
      sharedItemsWithFocus: null,
    });
  });

  it('reports the corpus totals the threshold is a choice against', () => {
    seedCorpus();
    const graph = buildEntityGraph(db, { entity: 'OpenAI', minItems: 2 });
    const counts = entityItemCounts(db);
    expect(graph.corpus.entitiesTotal).toBe(counts.size);
    expect(graph.corpus.entitiesAtOrAboveThreshold).toBe(
      [...counts.values()].filter((c) => c.itemCount >= 2).length,
    );
    expect(graph.corpus.entitiesBelowThreshold).toBe(
      graph.corpus.entitiesTotal - graph.corpus.entitiesAtOrAboveThreshold,
    );
    expect(graph.corpus.entitiesAtOrAboveThreshold).toBeLessThan(graph.corpus.entitiesTotal);
  });
});

describe('buildEntityGraph — the neighbour cap, which is what keeps a graph legible', () => {
  it('defaults to fifteen neighbours', () => {
    expect(DEFAULT_GRAPH_NEIGHBOURS).toBe(15);
  });

  it('truncates to the cap and reports the number it did not draw', () => {
    for (let i = 0; i < 20; i += 1) {
      addItem(`https://example.test/hub-${i}-a`, ['Hub', `Spoke ${i}`]);
      addItem(`https://example.test/hub-${i}-b`, ['Hub', `Spoke ${i}`]);
    }
    const graph = buildEntityGraph(db, { entity: 'Hub', neighbours: 5 });
    expect(graph.neighbours.shown).toBe(5);
    expect(graph.neighbours.aboveThreshold).toBe(20);
    expect(graph.nodes).toHaveLength(6);
  });
});

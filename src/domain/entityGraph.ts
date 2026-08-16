/**
 * The related-entity relation, and the §7.4 entity graph built on it (M5 task 17).
 *
 * ## Why this module exists
 *
 * Until this task, `planEntityNotes(...).related` in `src/vault/entities.ts`
 * was the **first and only** computation of the related-entity relation in
 * this tree. Task 7's report says exactly that, and recommends lifting it here
 * when an endpoint is built, "rather than an API route importing a vault
 * module." That recommendation is what this file discharges: the vault planner
 * and `GET /api/entities/graph` now call one implementation, and neither knows
 * about the other.
 *
 * The direction of the dependency matters. `src/vault/` writes files into the
 * owner's Obsidian vault; `src/api/` answers HTTP requests. Neither is a
 * plausible home for a fact about the corpus, and an API route importing the
 * vault would put the milestone's highest-risk code — the one subsystem whose
 * bugs destroy hand-written work — on the request path of a web server for no
 * reason at all.
 *
 * ## The relation, stated once
 *
 * Two entities are related when they are named by the same *item*, and the
 * weight of the relation is how many distinct items name both. Three
 * properties are load-bearing and each exists because a simpler reading is
 * wrong:
 *
 * - **Items, not versions.** `items.item_key = sha256(canonical_url)` and an
 *   item can be stored several times (a re-poll, or two sources publishing one
 *   canonical URL — the real case is arXiv papers cross-listed in `cs.AI` and
 *   `cs.CR`). Counting rows would report one item twice.
 * - **Unioned across versions.** Entities attributed by *any* version of an
 *   item count for that item — `getItemEntities`, which exists precisely
 *   because the single-version read returned a plausible wrong answer
 *   (`CLAUDE.md`, "the scoring read path is three functions, not one").
 * - **NFC, then codepoint order.** `Cafe` + combining acute and precomposed
 *   `Café` are one entity, and ordering is by codepoint rather than
 *   `localeCompare`, whose answer depends on the host's ICU data.
 *
 * ## Pure with respect to the clock
 *
 * No decay, no relative age, no `now`. The graph is a function of the corpus
 * alone, which is what lets the vault's rendered block stay byte-identical
 * across runs (M5 acceptance) and what makes this endpoint's answer stable
 * enough to be worth caching later. Nothing here reads a clock or a config
 * file.
 */

import type { Db } from '../db/connection.ts';

export interface RelatedEntity {
  readonly entity: string;
  readonly sharedItems: number;
}

/**
 * Codepoint order, everywhere, deliberately — the same rule and the same
 * reasoning as `src/vault/entities.ts`: `localeCompare` depends on the host's
 * ICU data and locale, so two machines could order one corpus differently.
 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Item keys are bound as SQL parameters, and an entity can name a lot of them
 * — `Linux` names 702 on the live corpus. SQLite's compiled parameter ceiling
 * is high (32,766 in current builds) but it is a real ceiling and it is not
 * ours to assume, so the `in (...)` lists below are chunked. Chunks partition
 * the key set, and every aggregate here is a `count(distinct item_key)` over a
 * partition, so summing across chunks is exact rather than approximate.
 */
const KEY_CHUNK = 500;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Every distinct `item_key` naming any of these raw spellings.
 *
 * Keyed on spellings (one, in every real case; more only when two byte
 * sequences normalise to one name) rather than on a single string, so the
 * union is taken in SQL and an item naming two spellings is still one item.
 */
export function entityItemKeys(db: Db, spellings: readonly string[]): string[] {
  if (spellings.length === 0) return [];
  const placeholders = spellings.map(() => '?').join(', ');
  // Inline type literal rather than a named interface: `.all()` returns
  // `Record<string, SQLOutputValue>[]` and TypeScript's `as` overlap check is
  // stricter about a named-interface array target. See src/cluster/store.ts.
  const rows = db
    .prepare(
      `select distinct i.item_key as item_key
       from item_entities e
       join items i on i.item_id = e.item_id
       where e.entity in (${placeholders})
       order by i.item_key`,
    )
    .all(...spellings) as Array<{ item_key: string }>;
  return rows.map((r) => r.item_key);
}

export interface EntityItemCount {
  /** Distinct `item_key`s naming this entity under any spelling. */
  readonly itemCount: number;
  /** The raw `item_entities.entity` values that normalise to this name. */
  readonly spellings: readonly string[];
}

/**
 * Every entity in the corpus with the number of distinct items naming it,
 * keyed on the NFC name and ordered by codepoint.
 *
 * One query in the ordinary case. A spelling group with more than one member
 * costs one extra query, because its count is a UNION over spellings and not a
 * sum — an item naming both spellings must count once. On the live corpus
 * there are zero such groups (3,474 distinct entities, 0 non-NFC spellings),
 * which is why the general case is not paid for on every row.
 */
export function entityItemCounts(db: Db): Map<string, EntityItemCount> {
  const rows = db
    .prepare(
      `select e.entity as entity, count(distinct i.item_key) as n
       from item_entities e
       join items i on i.item_id = e.item_id
       group by e.entity`,
    )
    .all() as Array<{ entity: string; n: number }>;

  const groups = new Map<string, { spellings: string[]; sum: number }>();
  for (const row of rows) {
    const nfc = row.entity.normalize('NFC');
    const group = groups.get(nfc);
    if (group) {
      group.spellings.push(row.entity);
      group.sum += row.n;
    } else {
      groups.set(nfc, { spellings: [row.entity], sum: row.n });
    }
  }

  const out = new Map<string, EntityItemCount>();
  for (const nfc of [...groups.keys()].sort(byCodePoint)) {
    const group = groups.get(nfc)!;
    const spellings = [...group.spellings].sort(byCodePoint);
    const itemCount =
      spellings.length === 1 ? group.sum : entityItemKeys(db, spellings).length;
    out.set(nfc, { itemCount, spellings });
  }
  return out;
}

export interface RelatedOptions {
  /**
   * Which related entities the caller is willing to name. The vault passes the
   * set it will actually write a note for, because a related link there is a
   * `[[wikilink]]` and naming an entity with no note fills the owner's graph
   * with links that can never resolve. The API passes its own threshold.
   *
   * Absent means "all of them", which is what lets a caller ask for the
   * unfiltered relation and count what its own policy excluded.
   */
  readonly isEligible?: (entity: string) => boolean;
  /** Applied AFTER `isEligible`, so a filter never eats the caller's budget. */
  readonly limit?: number;
}

/**
 * The related-entity relation for one entity: who else is named by its items,
 * and by how many of them.
 *
 * **This is the single implementation.** `src/vault/entities.ts` and
 * `src/api/routes/entities.ts` both call it; nothing else computes
 * co-occurrence anywhere in the tree, and `tests/domain/entityGraph.test.ts`
 * pins the answer against the pre-lift vault code it replaced.
 *
 * `itemKeys` is a parameter rather than something this function derives,
 * because both callers already hold it (the vault to build the item list, the
 * graph to size the node) and deriving it again would double the query count
 * for no new fact.
 *
 * ## The NFC subtlety, preserved rather than fixed
 * Counts are accumulated per NFC name, and an item naming two spellings that
 * normalise to one name therefore contributes 2 to that name. That is exactly
 * what the vault's loop did before the lift, and this function reproduces it
 * deliberately: changing it here would change a rendered note. It is
 * unobservable on the live corpus (0 non-NFC spellings) and is recorded so the
 * next reader does not "fix" a behaviour that is load-bearing for equivalence.
 */
export function countRelatedEntities(
  db: Db,
  entity: string,
  itemKeys: readonly string[],
  options: RelatedOptions = {},
): RelatedEntity[] {
  const counts = new Map<string, number>();

  for (const keys of chunk(itemKeys, KEY_CHUNK)) {
    if (keys.length === 0) continue;
    const placeholders = keys.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `select e.entity as entity, count(distinct i.item_key) as shared
         from items i
         join item_entities e on e.item_id = i.item_id
         where i.item_key in (${placeholders})
         group by e.entity`,
      )
      .all(...keys) as Array<{ entity: string; shared: number }>;

    for (const row of rows) {
      const nfc = row.entity.normalize('NFC');
      if (nfc === entity) continue;
      if (options.isEligible && !options.isEligible(nfc)) continue;
      counts.set(nfc, (counts.get(nfc) ?? 0) + row.shared);
    }
  }

  const related = [...counts]
    .map(([name, sharedItems]) => ({ entity: name, sharedItems }))
    .sort((a, b) => b.sharedItems - a.sharedItems || byCodePoint(a.entity, b.entity));

  return options.limit === undefined ? related : related.slice(0, options.limit);
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * Fewest distinct items an entity needs before it is drawn as a NEIGHBOUR.
 *
 * ## Measured, on the corpus this renders
 *
 * The tail is the whole story. On the live corpus (11,016 item versions,
 * 12,232 entity attributions):
 *
 * | floor | entities |
 * | --- | --- |
 * | 1 | 3,474 |
 * | **2** | **176** |
 * | 3 | 113 |
 * | 5 | 89 |
 *
 * 3,298 of 3,474 entities are named by exactly one item, and almost all of
 * them are CVE identifiers — an identifier that appears once genuinely IS an
 * entity of that item, and it is also a node with exactly one edge, which
 * draws a spoke and says nothing. A graph of 3,474 nodes is unreadable before
 * it is slow. A graph drawn from 176 is a picture of what the corpus is
 * actually about.
 *
 * The floor is 2 rather than 3 because 2 is where "some other item mentioned
 * this too" starts being true at all — the same corroboration signal M2's
 * clustering already treats as meaningful, and it keeps the genuinely
 * multi-source CVEs (the ones carried by both CISA KEV and NVD) that a floor
 * of 3 would drop.
 *
 * ## The same number as the vault's note floor, and NOT the same constant
 *
 * `DEFAULT_MIN_ITEMS_FOR_NOTE` (`src/vault/entities.ts`) is also 2, from the
 * same measurement. They are deliberately separate constants because they
 * answer different questions — "does this entity earn a FILE in the owner's
 * knowledge base" versus "is this worth DRAWING" — and the two could
 * reasonably diverge. Collapsing them would make a retune of one silently
 * rewrite the other's notes.
 */
export const DEFAULT_MIN_ITEMS_FOR_NODE = 2;

/**
 * Neighbours drawn around the focus.
 *
 * Matches the vault's `DEFAULT_MAX_RELATED`, and for a converging reason: 15
 * labelled nodes on a ring is about what a laptop-width SVG holds before the
 * labels collide, and it is also about what a person reads off a ranked list
 * without scrolling. Beyond it the picture stops adding information and starts
 * removing it.
 */
export const DEFAULT_GRAPH_NEIGHBOURS = 15;

export interface EntityGraphNode {
  readonly entity: string;
  /** Distinct items naming this entity — the node's own weight. */
  readonly itemCount: number;
  readonly focus: boolean;
  /**
   * Items shared with the focus. `null` on the focus itself, which is not a
   * missing value: an entity is not related to itself, and this is the one
   * node for which the question has no answer.
   *
   * Materialised on the node although it also appears in `edges`, because it
   * is the ordering key: a client rendering the ranked adjacency list — which
   * is what a phone gets — must not have to join two arrays to sort a list the
   * server already sorted.
   */
  readonly sharedItemsWithFocus: number | null;
}

export interface EntityGraphEdge {
  /** The relation is symmetric. Each pair is emitted once, `source` < `target` by codepoint. */
  readonly source: string;
  readonly target: string;
  readonly sharedItems: number;
}

export interface EntityGraph {
  /** Echoed verbatim as the caller sent it, before NFC resolution. */
  readonly entity: string;
  /** False when nothing in the corpus names it. Distinct from "named by no OTHER entity". */
  readonly known: boolean;
  readonly minItems: number;
  readonly nodes: readonly EntityGraphNode[];
  readonly edges: readonly EntityGraphEdge[];
  readonly neighbours: {
    /** Drawn. */
    readonly shown: number;
    /** Eligible at this threshold, before the neighbour cap. */
    readonly aboveThreshold: number;
    /** Co-occurring entities the threshold removed. Reported, never silently dropped. */
    readonly hiddenBelowThreshold: number;
  };
  readonly corpus: {
    readonly entitiesTotal: number;
    readonly entitiesAtOrAboveThreshold: number;
    readonly entitiesBelowThreshold: number;
  };
}

export interface EntityGraphOptions {
  readonly entity: string;
  readonly minItems?: number;
  readonly neighbours?: number;
}

/**
 * The ego graph around one entity: the focus, its top neighbours, and every
 * edge AMONG those nodes.
 *
 * ## Why an ego graph rather than the whole graph
 *
 * A response is bounded by construction. The alternative — ship all 176
 * above-threshold nodes and their ~1,000 edges and let the client lay them out
 * — produces a hairball that is illegible at any viewport, and moves the
 * decision about what to draw into the frontend, which §7.1 forbids
 * ("no business logic in the frontend"). `GET /api/entities` is the unfocused
 * view: a ranked list, which is what a list is good at.
 *
 * ## Neighbour-to-neighbour edges are the INDUCED subgraph
 *
 * An edge between two neighbours means "these two are related", full stop —
 * counted over the whole corpus, not only over items that also name the focus.
 * The relation is a property of the pair. Restricting it to the focus's items
 * would print a number that is not the number the same pair shows when either
 * of them is the focus, and a graph whose edge weights change depending on
 * where you are standing is not one anybody can reason about.
 *
 * Without these edges the result is a star, which is a ranked list drawn in a
 * circle. The structure — that `Anthropic` and `Claude` are joined to each
 * other and not only to `OpenAI` — is the entire reason to draw it.
 *
 * ## Cost
 * One count query for the corpus, one key query and up to a few chunked
 * co-occurrence queries per drawn node: on the order of forty queries for a
 * 15-neighbour graph over a 7,000-item corpus, all against indexed columns.
 * Deliberately not cached — the answer is a pure function of an append-only
 * corpus, so a cache is easy to add later and impossible to get wrong now.
 */
export function buildEntityGraph(db: Db, options: EntityGraphOptions): EntityGraph {
  const minItems = options.minItems ?? DEFAULT_MIN_ITEMS_FOR_NODE;
  const maxNeighbours = options.neighbours ?? DEFAULT_GRAPH_NEIGHBOURS;

  const counts = entityItemCounts(db);
  const entitiesTotal = counts.size;
  let entitiesAtOrAbove = 0;
  for (const count of counts.values()) if (count.itemCount >= minItems) entitiesAtOrAbove += 1;

  const corpus = {
    entitiesTotal,
    entitiesAtOrAboveThreshold: entitiesAtOrAbove,
    entitiesBelowThreshold: entitiesTotal - entitiesAtOrAbove,
  } as const;

  const focus = options.entity.normalize('NFC');
  const focusCount = counts.get(focus);
  if (focusCount === undefined) {
    return {
      entity: options.entity,
      known: false,
      minItems,
      nodes: [],
      edges: [],
      neighbours: { shown: 0, aboveThreshold: 0, hiddenBelowThreshold: 0 },
      corpus,
    };
  }

  const focusKeys = entityItemKeys(db, focusCount.spellings);

  // Unfiltered, so the threshold's own effect is countable rather than
  // invisible. docs/api.md's standing distinction: absence and emptiness are
  // different answers, and "9 neighbours were dropped" is not "no neighbours".
  const allRelated = countRelatedEntities(db, focus, focusKeys);
  const eligible = allRelated.filter((r) => (counts.get(r.entity)?.itemCount ?? 0) >= minItems);
  const drawn = eligible.slice(0, maxNeighbours);

  const nodeSet = new Set<string>([focus, ...drawn.map((r) => r.entity)]);
  const nodes: EntityGraphNode[] = [
    { entity: focus, itemCount: focusCount.itemCount, focus: true, sharedItemsWithFocus: null },
    ...drawn.map((related) => ({
      entity: related.entity,
      itemCount: counts.get(related.entity)?.itemCount ?? 0,
      focus: false,
      sharedItemsWithFocus: related.sharedItems,
    })),
  ];

  const edges = new Map<string, EntityGraphEdge>();
  const addEdge = (a: string, b: string, sharedItems: number): void => {
    const [source, target] = byCodePoint(a, b) < 0 ? [a, b] : [b, a];
    edges.set(`${source} ${target}`, { source, target, sharedItems });
  };
  for (const related of drawn) addEdge(focus, related.entity, related.sharedItems);
  for (const related of drawn) {
    const spellings = counts.get(related.entity)?.spellings ?? [related.entity];
    const keys = entityItemKeys(db, spellings);
    for (const other of countRelatedEntities(db, related.entity, keys, {
      isEligible: (name) => nodeSet.has(name),
    })) {
      addEdge(related.entity, other.entity, other.sharedItems);
    }
  }

  return {
    entity: options.entity,
    known: true,
    minItems,
    nodes,
    edges: [...edges.values()].sort(
      (a, b) =>
        b.sharedItems - a.sharedItems ||
        byCodePoint(a.source, b.source) ||
        byCodePoint(a.target, b.target),
    ),
    neighbours: {
      shown: drawn.length,
      aboveThreshold: eligible.length,
      hiddenBelowThreshold: allRelated.length - eligible.length,
    },
    corpus,
  };
}

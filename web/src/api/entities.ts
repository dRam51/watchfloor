import { apiFetch } from './client.ts';

/**
 * Wire types + fetchers for `GET /api/entities` and `GET /api/entities/graph`
 * (`src/api/routes/entities.ts`, documented in `docs/api.md`).
 *
 * Declared locally rather than imported from `src/`, for the reason
 * `api/types.ts` and `api/search.ts` both give: the frontend's notion of a
 * shape is "whatever JSON the route documents", not a type-level import of
 * server internals (§7.1, "the HTTP API is the only contract").
 */

export interface EntityListEntry {
  readonly entity: string;
  /** Distinct items naming it. Cross-listed versions of one item count once. */
  readonly itemCount: number;
}

export interface EntityListResponse {
  readonly minItems: number;
  readonly limit: number;
  /**
   * Every entity in the corpus, including the ones the threshold removed.
   *
   * These three totals are not decoration. The threshold is a real editorial
   * choice — live, 3,298 of 3,474 entities are named by exactly one item — and
   * a list that omits 95% of the corpus while looking complete is exactly the
   * quiet wrongness the view must not commit. It shows them.
   */
  readonly entitiesTotal: number;
  readonly entitiesAtOrAboveThreshold: number;
  readonly entitiesBelowThreshold: number;
  readonly entities: readonly EntityListEntry[];
}

export interface EntityGraphNode {
  readonly entity: string;
  readonly itemCount: number;
  readonly focus: boolean;
  /**
   * `null` on the focus, and not because a value is missing: an entity is not
   * related to itself, so for that one node the question has no answer. Every
   * other node carries the same number its edge to the focus does — the server
   * materialises it so the ranked list needs no join.
   */
  readonly sharedItemsWithFocus: number | null;
}

export interface EntityGraphEdge {
  /** Symmetric. Each pair appears once, `source` < `target` by codepoint. */
  readonly source: string;
  readonly target: string;
  readonly sharedItems: number;
}

export interface EntityGraphResponse {
  readonly entity: string;
  /** False when nothing in the corpus names it. Never a 404 — see docs/api.md. */
  readonly known: boolean;
  readonly minItems: number;
  /** `nodes[0]` is always the focus; neighbours follow already ranked. */
  readonly nodes: readonly EntityGraphNode[];
  /** The induced subgraph: neighbour-to-neighbour edges included. */
  readonly edges: readonly EntityGraphEdge[];
  readonly neighbours: {
    readonly shown: number;
    readonly aboveThreshold: number;
    readonly hiddenBelowThreshold: number;
  };
  readonly corpus: {
    readonly entitiesTotal: number;
    readonly entitiesAtOrAboveThreshold: number;
    readonly entitiesBelowThreshold: number;
  };
}

const ENTITIES_PATH = '/api/entities';

export function fetchEntityList(token: string, minItems: number): Promise<EntityListResponse> {
  const qs = new URLSearchParams({ minItems: String(minItems) });
  return apiFetch<EntityListResponse>(`${ENTITIES_PATH}?${qs.toString()}`, token);
}

export function fetchEntityGraph(
  token: string,
  entity: string,
  minItems: number,
): Promise<EntityGraphResponse> {
  // `URLSearchParams` is what makes `S&P 500` and `Moody's` safe here — the
  // reason the route takes a query parameter rather than a path segment.
  const qs = new URLSearchParams({ entity, minItems: String(minItems) });
  return apiFetch<EntityGraphResponse>(`${ENTITIES_PATH}/graph?${qs.toString()}`, token);
}

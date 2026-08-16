import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/connection.ts';
import {
  buildEntityGraph,
  DEFAULT_GRAPH_NEIGHBOURS,
  DEFAULT_MIN_ITEMS_FOR_NODE,
  entityItemCounts,
} from '../../domain/entityGraph.ts';

/**
 * `GET /entities` and `GET /entities/graph` — §7.4's entity graph (M5 task 17).
 *
 * M5's acceptance asks that "the §7.4 entity graph view renders the
 * `related_entities`". Nothing for it existed: no endpoint, no component, no
 * relation outside the vault planner. This route is the read half.
 *
 * ## Two resources, because there are two questions
 *
 * - **`/entities`** — *which entities are worth looking at?* A ranked list.
 *   One query. This is the view's unfocused state, and a list is the right
 *   shape for "pick one".
 * - **`/entities/graph`** — *what surrounds this one?* An ego graph: the
 *   focus, its top neighbours, and every edge **among** those nodes.
 *
 * There is deliberately no "whole graph" resource. At the default threshold
 * the corpus has 176 drawable entities and on the order of a thousand edges
 * between them; that is a hairball at any viewport, and shipping it would move
 * the decision about what to draw into the frontend, which §7.1 forbids
 * ("no business logic in the frontend. Scoring, clustering, filtering ... all
 * live server-side"). Every response here is bounded by construction rather
 * than by a client remembering to bound it.
 *
 * ## Why the focus is a query parameter and not a path segment
 *
 * Entity names are extracted text, not identifiers. Live ones include
 * `Model Context Protocol`, `S&P 500`, `Moody's`, `GPT-4.1`, `D-Link` and
 * `CVE-2026-1234`. A path segment makes every one of those an encoding
 * question — and `src/vault/entities.ts` already documents that a name
 * containing `/` is a real hazard it refuses rather than repairs. A query
 * parameter has one unambiguous encoding and no segment semantics at all.
 *
 * ## Why an unknown entity is 200, not 404
 *
 * A 404 means "no such route". This route exists and answered: the corpus does
 * not name that entity. `known: false` says so, which is the same
 * absence-versus-emptiness distinction `/api/sources` draws with `everPolled`
 * and `/api/search` draws with `unsearchable` — and it matters here because
 * the entity taxonomy is config-driven (`config/entities.yaml`) and an entity
 * can be perfectly real and simply not extracted from anything yet.
 *
 * ## No decay, no `now`
 *
 * Unlike `/api/feed`, nothing on this endpoint is a function of the clock.
 * Co-occurrence is a fact about the corpus. There is therefore no `now`
 * parameter and no frozen-cursor problem, and two requests a second apart over
 * an unchanged corpus return identical bytes.
 */

export interface EntitiesRouteDeps {
  db: Db;
}

/**
 * The list cap. Not a page size — there is no cursor here, because the whole
 * point of the threshold is that the answer is small. 200 is comfortably above
 * the 176 the live corpus yields at the default floor, so the default returns
 * everything drawable and the cap exists only to stop `minItems=1` from
 * shipping 3,474 rows to a phone.
 */
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 200;

/**
 * The most neighbours any single graph will draw.
 *
 * A ceiling rather than a suggestion: past this the ring is a smear of
 * overlapping labels and the payload stops being a picture. 200 is well past
 * useful and is here so that a caller asking for something absurd gets a 400
 * naming the bound rather than a response nobody can render.
 */
const MAX_NEIGHBOURS = 200;

const ListQuerySchema = z.object({
  minItems: z.coerce.number().int().min(1).default(DEFAULT_MIN_ITEMS_FOR_NODE),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
});

const GraphQuerySchema = z.object({
  entity: z.string().min(1, 'entity must not be empty'),
  minItems: z.coerce.number().int().min(1).default(DEFAULT_MIN_ITEMS_FOR_NODE),
  neighbours: z.coerce.number().int().min(1).max(MAX_NEIGHBOURS).default(DEFAULT_GRAPH_NEIGHBOURS),
});

/**
 * The `{ error }` shape docs/api.md actually specifies — a lowercase token,
 * with the human-readable detail in `message` — copied from `/api/feed`.
 *
 * Deliberately NOT `/api/search`'s shape, which sends zod's raw message as
 * `error` itself. Verified against the running server before choosing: that
 * route answers a missing parameter with `{"error":"Required"}`, which is
 * capitalised, is not a token, and does not say which parameter. The issue
 * path is prefixed here so `entity: Required` names the field.
 */
function invalidQuery(error: z.ZodError): { error: string; message: string } {
  return {
    error: 'invalid_query',
    message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

export function registerEntities(server: FastifyInstance, deps: EntitiesRouteDeps): void {
  server.get('/entities', async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(invalidQuery(parsed.error));
    const { minItems, limit } = parsed.data;

    const counts = entityItemCounts(deps.db);
    const above = [...counts]
      .filter(([, count]) => count.itemCount >= minItems)
      // Biggest first, ties by codepoint. `localeCompare` is deliberately not
      // used anywhere in this module: its answer depends on the host's ICU
      // data, so two machines could order one corpus differently.
      .sort(([aName, a], [bName, b]) => b.itemCount - a.itemCount || (aName < bName ? -1 : aName > bName ? 1 : 0));

    return reply.send({
      minItems,
      limit,
      // Stated, not implied. "Decide the threshold, make it visible to the
      // user, and defend it" — a client cannot show what it was not told, and
      // an entity list that silently omits 3,298 of 3,474 entities while
      // looking complete is the kind of quiet wrongness this project spends
      // its comments on.
      entitiesTotal: counts.size,
      entitiesAtOrAboveThreshold: above.length,
      entitiesBelowThreshold: counts.size - above.length,
      // Explicit whitelist mapper, never a spread of the domain object: a
      // field added to `EntityItemCount` (its `spellings`, today) must not be
      // able to reach a client without somebody deciding it should.
      entities: above.slice(0, limit).map(([entity, count]) => ({
        entity,
        itemCount: count.itemCount,
      })),
    });
  });

  server.get('/entities/graph', async (request, reply) => {
    const parsed = GraphQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(invalidQuery(parsed.error));
    const { entity, minItems, neighbours } = parsed.data;

    const graph = buildEntityGraph(deps.db, { entity, minItems, neighbours });

    // Mapped field by field rather than sent as-is, for the same reason
    // `/api/search` maps its hits: the shape on the wire is a contract, and a
    // field added to the domain type should have to pass through here.
    return reply.send({
      entity: graph.entity,
      known: graph.known,
      minItems: graph.minItems,
      nodes: graph.nodes.map((node) => ({
        entity: node.entity,
        itemCount: node.itemCount,
        focus: node.focus,
        sharedItemsWithFocus: node.sharedItemsWithFocus,
      })),
      edges: graph.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        sharedItems: edge.sharedItems,
      })),
      neighbours: {
        shown: graph.neighbours.shown,
        aboveThreshold: graph.neighbours.aboveThreshold,
        hiddenBelowThreshold: graph.neighbours.hiddenBelowThreshold,
      },
      corpus: {
        entitiesTotal: graph.corpus.entitiesTotal,
        entitiesAtOrAboveThreshold: graph.corpus.entitiesAtOrAboveThreshold,
        entitiesBelowThreshold: graph.corpus.entitiesBelowThreshold,
      },
    });
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/connection.ts';
import { searchItems, toSafeMatchQuery } from '../../search/query.ts';

/**
 * `GET /search` — full-text search over `items_fts` (M3 task 2's FTS5 index).
 *
 * Task 2 shipped the query path (`searchItems`, `toSafeMatchQuery`) but no
 * route, and its brief left the endpoint's owner open. This is that endpoint,
 * written during the route-wiring commit rather than deferred to task 11 —
 * task 11 is the search *UI*, and a UI task that must first invent its own
 * backend inverts the wave structure.
 *
 * ## Why this calls `toSafeMatchQuery` itself
 *
 * `searchItems` already calls it internally and returns `[]` when it yields
 * `null`, which collapses two genuinely different outcomes into one empty
 * array: "your query contained nothing to search for" versus "your query was
 * fine and matched nothing". The UI should say different things there — the
 * first is unanswerable, the second is a real answer.
 *
 * **How narrow that first case actually is.** `toSafeMatchQuery` quotes every
 * token, which turns FTS5 operators into ordinary literals rather than
 * rejecting them — verified against the real implementation:
 *
 *     'Mangione' -> '"Mangione"'      'AND'    -> '"AND"'
 *     'AT&T'     -> '"AT&T"'          '***'    -> '"***"'
 *     'C++'      -> '"C++"'           '   '    -> null
 *
 * So `?q=AND` is not malformed at all; it searches for the literal word "AND"
 * and returns real hits. **Only input that tokenises to nothing — whitespace —
 * yields `null`.** (An earlier version of this comment claimed `"`, `AND` and
 * `++` triggered it. They do not; that was wrong, and checking it is what
 * found the error.) Zod's `.min(1)` does not catch this, because `'   '` has
 * length 3.
 *
 * The branch is therefore rare but real, and confirmed live: `?q=%20%20%20`
 * returns `unsearchable: true`. `toSafeMatchQuery`'s `string | null` return is
 * a deliberate signal from its author, so this route preserves it rather than
 * throwing it away.
 */
export interface SearchRouteDeps {
  db: Db;
}

const SearchQuerySchema = z.object({
  q: z.string().min(1, 'q must not be empty'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export function registerSearch(server: FastifyInstance, deps: SearchRouteDeps): void {
  server.get('/search', async (request, reply) => {
    const parsed = SearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      // Fail loudly on bad input rather than coercing, matching every config
      // path in this project and the `{ error }` shape auth established.
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid query' });
    }

    const { q, limit } = parsed.data;

    if (toSafeMatchQuery(q) === null) {
      // Distinct from an empty result set -- see this module's doc comment.
      return reply.send({ query: q, unsearchable: true, hits: [] });
    }

    const hits = searchItems(deps.db, q, { limit });

    // Mapped explicitly to camelCase rather than serializing `SearchHit.item`
    // directly: `Item` mixes conventions (`canonicalUrl`/`publishedAt` from
    // NewItem alongside `item_key`/`created_at` added by the DB layer), so
    // sending it raw would emit both casings in one object. Explicit mapping
    // also means a column added to `items` later cannot silently reach the
    // wire.
    return reply.send({
      query: q,
      unsearchable: false,
      hits: hits.map((hit) => ({
        itemKey: hit.item.item_key,
        title: hit.item.title,
        sourceId: hit.item.sourceId,
        canonicalUrl: hit.item.canonicalUrl,
        publishedAt: hit.item.publishedAt,
        itemType: hit.item.itemType,
        snippet: hit.snippet,
        rank: hit.rank,
      })),
    });
  });
}

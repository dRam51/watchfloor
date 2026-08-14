import { apiFetch } from './client.ts';

/**
 * Wire types + fetcher for `GET /api/search` (src/api/routes/search.ts,
 * documented in docs/api.md). Defined locally rather than imported from
 * `src/` for the same reason `api/types.ts` gives: the frontend's notion of
 * a shape is "whatever JSON the route documents," not a type-level import of
 * server internals (§7.1, "the HTTP API is the only contract").
 *
 * Kept in this task's own file rather than added to the shared
 * `api/types.ts` -- that file is not claimed by either Wave 4 task, but a
 * concurrently-edited shared file is still an avoidable merge hazard when a
 * brand-new, self-contained file does the same job with zero risk.
 */

export interface SearchHit {
  itemKey: string;
  title: string;
  sourceId: string;
  canonicalUrl: string;
  publishedAt: string | null;
  itemType: string;
  /** Matched span(s) marked with `[` … `]` -- see web/src/lib/snippet.ts's
   * `parseSnippet` for turning this into renderable segments. Never render
   * this raw with the brackets still in it, and never via innerHTML. */
  snippet: string;
  /**
   * FTS5 bm25: LOWER (more negative) is a better match. Results arrive
   * already sorted by this -- deliberately not exposed anywhere in this
   * app's UI (task brief: "do not show the raw number as if larger were
   * better"), kept on the type only because it is a real field on the wire
   * and dropping it from the type would misrepresent the response shape.
   */
  rank: number;
}

export interface SearchResponse {
  query: string;
  /**
   * True only when `query` tokenised to nothing searchable (whitespace-only
   * -- FTS operators are quoted into literals, so `AND`/`C++`/`AT&T` all
   * search for themselves and return real hits). Distinct from a query that
   * was fine and matched zero items -- collapsing the two would throw away
   * a distinction the API deliberately preserves (docs/api.md, `GET
   * /api/search`).
   */
  unsearchable: boolean;
  hits: SearchHit[];
}

const SEARCH_PATH = '/api/search';

export function fetchSearch(token: string, q: string, limit = 25): Promise<SearchResponse> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  return apiFetch<SearchResponse>(`${SEARCH_PATH}?${qs.toString()}`, token);
}

import { apiFetch } from './client.ts';
import type { Beat, FeedResponse, SortProfile } from './types.ts';

/**
 * GET /api/feed -- the one read this whole task renders. Every parameter
 * below is a query parameter the SERVER interprets; nothing here filters,
 * sorts, or paginates client-side (§7.1: "no business logic in the
 * frontend"). See src/api/routes/feed.ts's own doc comment for the full
 * design; the two rules that shape this module:
 *
 * 1. The query parameter is `profile` (`'signal' | 'read'`), not `sort` --
 *    verified against FeedQuerySchema in src/api/routes/feed.ts rather than
 *    trusted from the task brief's prose, which used "sort" loosely (the
 *    response field IS called `sortProfile`, which is probably where that
 *    came from). Sending `sort` instead would 400 (`FeedQuerySchema` is
 *    `.strict()`), so this is not a stylistic choice.
 * 2. A cursor is a snapshot: page 2+ must NOT reconstruct `beat`/`profile`/
 *    `now` from local component state -- the cursor already carries them,
 *    and re-sending a value that happens to disagree is a 400
 *    (`cursor_mismatch`). `fetchFeedPage` below enforces this at the type
 *    level: `FeedCursorParams` accepts only `cursor` and `limit`.
 */

const FEED_PATH = '/api/feed';

export interface FeedFirstPageParams {
  beat?: Beat;
  profile?: SortProfile;
  limit?: number;
}

export interface FeedCursorParams {
  cursor: string;
  limit?: number;
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const s = qs.toString();
  return s.length > 0 ? `?${s}` : '';
}

/** Page 1 (or a fresh page after the beat filter changes) -- no cursor yet. */
export function fetchFeedFirstPage(token: string, params: FeedFirstPageParams = {}): Promise<FeedResponse> {
  const query = toQueryString({ beat: params.beat, profile: params.profile, limit: params.limit });
  return apiFetch<FeedResponse>(`${FEED_PATH}${query}`, token);
}

/**
 * Page 2+ -- the cursor is passed back VERBATIM (task brief, point 2:
 * "never reconstruct a query from parts, and never assume a later page
 * reflects newer data"). `limit` is the one parameter safe to vary per
 * request: it has no cursor-agreement check server-side because it is not
 * part of the pinned ranking (unlike `now`/`beat`/`profile`), so keeping it
 * stable here is a UX choice (consistent page size), not a correctness one.
 */
export function fetchFeedNextPage(token: string, params: FeedCursorParams): Promise<FeedResponse> {
  const query = toQueryString({ cursor: params.cursor, limit: params.limit });
  return apiFetch<FeedResponse>(`${FEED_PATH}${query}`, token);
}

/**
 * Wire types for GET /api/feed and the item-state write routes
 * (src/api/routes/feed.ts, src/api/routes/items.ts). Defined locally rather
 * than imported from src/ -- the frontend has its own tsconfig (Bundler
 * resolution, DOM lib) specifically because it cannot share the server's
 * NodeNext config (see web/tsconfig.json's own comment), and "the HTTP API
 * is the only contract" (§7.1) means the frontend's notion of these shapes
 * should be "whatever JSON the route documents", not a type-level import of
 * server internals. Keep this file in sync with feed.ts's `toFeedItemJson`
 * and items.ts's `stateJson` by hand -- there is no shared package boundary
 * to enforce it automatically.
 */

// Mirrors src/domain/item.ts's BEATS tuple exactly (six beats, M3's "six
// lanes" ruling -- see docs/superpowers/plans/2026-08-14-m3-api-dashboard.md).
export const BEATS = ['ai', 'cyber', 'aisec', 'repos', 'markets', 'usnews'] as const;
export type Beat = (typeof BEATS)[number];

export const SORT_PROFILES = ['signal', 'read'] as const;
export type SortProfile = (typeof SORT_PROFILES)[number];

export interface FeedItemOverride {
  pinned: boolean;
  priority: number | null;
  label: string | null;
}

export interface FeedItemState {
  readAt: string | null;
  savedAt: string | null;
  dismissedAt: string | null;
}

export interface FeedItem {
  itemKey: string;
  title: string;
  canonicalUrl: string;
  /**
   * `null` means the source carried no excerpt at all; `''` would mean one
   * was attempted and came back empty. The two are NOT the same fact (task
   * brief, point 4) -- render them distinctly, never collapse `null` to `''`.
   */
  summary: string | null;
  sourceId: string;
  publishedAt: string | null;
  itemType: string;
  beats: Beat[];
  entities: string[];
  representativeBeat: Beat;
  clusterSize: number;
  signalScore: number;
  readScore: number;
  sortProfile: SortProfile;
  override: { signal: FeedItemOverride; read: FeedItemOverride };
  state: FeedItemState;
}

export interface FeedResponse {
  items: FeedItem[];
  beat: Beat | null;
  profile: SortProfile;
  now: string;
  total: number;
  nextCursor: string | null;
}

/** Whichever of an item's two (score, override) pairs was actually used to rank it -- `sortProfile` says which. */
export function activeOverride(item: FeedItem): FeedItemOverride {
  return item.sortProfile === 'signal' ? item.override.signal : item.override.read;
}

export function activeScore(item: FeedItem): number {
  return item.sortProfile === 'signal' ? item.signalScore : item.readScore;
}

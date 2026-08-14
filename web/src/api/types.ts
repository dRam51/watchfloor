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

/**
 * The wire form of `src/score/velocity.ts`'s `VelocityResult`, kept as a
 * DISCRIMINATED UNION on this side of the boundary too.
 *
 * Flattening it here would undo the whole point of that module. Its doc
 * comment: "`starsPerDay` exists ONLY on the `ok` branch. `result.starsPerDay`,
 * `const { starsPerDay } = result`, and `result.starsPerDay ?? 0` all fail to
 * compile against the union." A client type with `starsPerDay: number | null`
 * would hand every one of those back, at exactly the layer that renders a
 * number to a human. There are FOUR distinct insufficient reasons and on a
 * fresh database every repo is in one of them for the first seven days, so
 * this is the common case during precisely the week the lane gets judged, not
 * an edge case.
 *
 * Only the fields the row actually renders are carried; the server's endpoint
 * instants, `missingDays[]` and `mixedTimezone` are deliberately not on the
 * wire yet -- see docs/api.md and this milestone's Task 7, which owns the
 * response shape. Adding a field there is additive here.
 */
export type FeedItemVelocity =
  | {
      status: 'ok';
      /** Signed. Negative is real data -- spam-star purges, unstarring. Never clamped. */
      starsPerDay: number;
      starsGained: number;
      /** Elapsed days between two observation INSTANTS. FRACTIONAL -- never a day-label count. */
      spanDays: number;
      spanCoverage: number;
      /** Whole days between the newest reading and the end of the window. */
      staleDays: number;
      observedDays: number;
      expectedDays: number;
    }
  | {
      status: 'insufficient_history';
      reason: 'unknown_repo' | 'no_snapshots' | 'single_snapshot' | 'span_too_short';
      observedDays: number;
      expectedDays: number;
      spanDays: number;
      minSpanDays: number;
    };

/**
 * The repo-shaped payload §7's repos row renders: "repo name, one-line
 * description, language, stars + velocity arrow, last-commit age."
 *
 * Mirrors `src/domain/repo.ts`'s `Repo` plus Task 6's README-knownness flag
 * and Task 5's velocity union. Two field names are load-bearing and must not
 * be "tidied":
 *
 * - `openIssuesAndPullRequests` -- GitHub's `open_issues_count` counts open
 *   PRs too; 3 issues plus 90 open PRs reports 93. `src/domain/repo.ts` names
 *   it honestly and says so explicitly: "Task 8 must not label this bare
 *   'issues'."
 * - `readmeKnown` -- an UNREAD README (the enrichment budget ran out) and a
 *   MISSING one both produce `readmeExcerpt: null`. Only this flag separates
 *   them, and §4 suppresses only the second. See `src/enrich/repo.ts`'s
 *   `isReadmeKnown`.
 */
export interface FeedItemRepo {
  /** `owner/name`. */
  fullName: string;
  /** GitHub's one-line description, capped like any excerpt. */
  description: string | null;
  language: string | null;
  licenseSpdxId: string | null;
  stars: number;
  /** Counts open PULL REQUESTS as well as issues -- never label this "issues". */
  openIssuesAndPullRequests: number;
  /** Canonical UTC timestamp, or `null` for a repo never pushed to. */
  lastCommitAt: string | null;
  /** README first paragraph. `null` is ambiguous on its own -- see `readmeKnown`. */
  readmeExcerpt: string | null;
  /** `false` means the README question was never ANSWERED, not that there is none. */
  readmeKnown: boolean;
  velocity: FeedItemVelocity;
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
  /**
   * Present only for items that ARE a GitHub repo (M4a). OPTIONAL on purpose,
   * in two directions:
   *
   * 1. This milestone's Task 7 owns `src/api/routes/feed.ts` and `docs/api.md`
   *    and is adding the field concurrently with this one. Until it lands the
   *    server sends nothing here, and a repos-lane row renders as an ordinary
   *    news row -- degraded, but not lying about a repo it has no data for.
   * 2. It is the presence of this payload, NOT `beat === 'repos'`, that
   *    selects the repo row (see `components/FeedRow.tsx`). A repo
   *    cross-listed into `ai` renders as a repo in BOTH lanes, and a non-repo
   *    item that scores into the repos lane renders as news in it.
   */
  repo?: FeedItemRepo | null;
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

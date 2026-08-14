/**
 * GET /feed -- the core read of the whole dashboard (M3 Wave 2, Task 4):
 * ranked items, merged across beats or filtered to one, paginated, with
 * decay applied server-side at the request's `now` and everything a §7 item
 * row needs to render (score indicator, title, source, relative time via
 * publishedAt, cluster count, beat tags, override/pin status, read/saved/
 * dismissed state).
 *
 * Owns its own route registration -- `registerFeed(server, deps)` -- rather
 * than editing src/api/server.ts, which two sibling Wave-2 tasks are also
 * touching in parallel (M3 plan, "Concurrency" section). The coordinator
 * wires this into server.ts in a separate commit.
 *
 * WIRE FORMAT (shared API convention, from the coordinator): camelCase JSON
 * everywhere, bare objects (no `{data: ...}` envelope), errors are
 * `{error: string, message?: string}` with a stable lowercase token,
 * canonical `YYYY-MM-DDTHH:mm:ss.sssZ` timestamps exactly as stored (never
 * epoch numbers, never pre-formatted), and nulls stay null rather than being
 * coerced to `""` or omitted.
 *
 * ---------------------------------------------------------------------------
 * 1. Decay is applied HERE, server-side, never shipped raw for the client to
 *    decay itself (§7.1: "no business logic in the frontend"). Every stored
 *    item_scores row is decay-INVARIANT (src/score/mechanical.ts); this
 *    module is the read that multiplies by computeDecayFactor(..., now, ...)
 *    on every request.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * 2. The cursor pins `now` -- the whole reason this file exists in this shape
 * ---------------------------------------------------------------------------
 * Score is a function of the clock (decay is applied at read time), so a
 * cursor that encodes "the last score I saw" is unstable: by page 2 every
 * candidate's decayed score has moved and items cross the boundary in both
 * directions -- silent duplicates, silent drops, neither visible as an
 * error. Real at this project's half-lives: cyber's SIGNAL half-life is 6
 * hours, so this is measurable within a minute of paging near the top of the
 * ranking, where scores are closest together.
 *
 * FIX: the cursor carries page 1's own `now` (see FeedCursorPayload), and
 * every subsequent page re-applies decay at that SAME pinned instant --
 * M2's decay-at-read-time architecture already treats `now` as a parameter
 * precisely so this works (it is exactly the "what would have ranked top
 * last Tuesday" query, aimed at "page 2 of five seconds ago" instead).
 * Pagination then walks one consistent, frozen ranking rather than a
 * shifting one.
 *
 * Consequence, stated rather than discovered: a cursor is a SNAPSHOT. Items
 * ingested after the pinned `now` are not in its ranking, by design --
 * correct, not a bug, and the reason §7's `r` (refresh) key exists.
 *
 * The candidate set itself is ALSO pinned to `now` (every SQL query below
 * filters `items.fetched_at <= ?now`), not just the decay math -- otherwise
 * a newly-ingested item landing between page 1 and page 2 could still leak
 * into page 2's candidate pool even though its own decayed score was never
 * computed against the frozen `now`. This is what makes an item's identity
 * (item_key) a stable anchor across pages: the SET an item is drawn from
 * cannot grow mid-pagination, only shrink (a dismissal mid-page is allowed
 * to remove an item from a later page -- that is a live state change, a
 * different concern from the clock-drift bug this section exists to close).
 *
 * ENCODING: `FeedCursorPayload`, JSON, base64url (Buffer, no new dependency).
 * Not signed/encrypted -- the cursor carries no secret, and every route on
 * this server already requires the bearer token (src/api/auth.ts), so a
 * forged cursor can at worst mis-page the caller's own authenticated
 * request. Zod-validated on decode; a malformed cursor is a 400
 * `invalid_cursor`, never a crash.
 *
 * SEEK, not OFFSET: the cursor carries the LAST item's own rank key
 * (`{pinned, priority, score, itemKey}`), not a numeric position. Page N+1
 * re-derives the full candidate list (deterministic, since `now` and the
 * candidate-set bound are pinned) and takes every row that sorts strictly
 * AFTER that key. This is what keeps a page stable even if a dismissal (or
 * any other live state change) removes an item ahead of the boundary
 * between two page requests -- an offset would silently skip or repeat one
 * row in exactly that case; a seek keyed on identity does not.
 *
 * ---------------------------------------------------------------------------
 * 3. Ordering is (pinned, score, item_key) -- pinning is a SEPARATE axis
 * ---------------------------------------------------------------------------
 * Hard overrides (src/score/overrides.ts) pin regardless of score -- a KEV
 * entry old enough that its decayed signal has collapsed to (or rounds to)
 * 0.000 still pins, because the override bypasses the score rather than
 * competing with it. A naive `order by score desc` would sink every pinned
 * item to the bottom, which is exactly backwards. `compareRankKey` below
 * sorts pinned-before-unpinned first, priority ascending among pinned
 * (lower priority = pinned first, mirroring overrides.ts's own convention),
 * THEN score descending, THEN item_key descending as a TOTAL tiebreak --
 * ties on score are not rare here (the M2 acceptance run had every
 * single-source AP item at exactly 3.13), and item_key is the one column
 * guaranteed unique.
 *
 * ---------------------------------------------------------------------------
 * 4. Item-level facts come from the item-level read paths, never getCurrentItem
 * ---------------------------------------------------------------------------
 * `getCurrentItem` returns a single VERSION and gives a plausible-looking
 * wrong answer for anything that can vary across versions sharing an
 * item_key -- this milestone (and M2 before it) has hit that bug three
 * separate times. This module uses:
 *   - getItemAsOf(db, itemKey, now)     title/source/publishedAt/itemType/
 *                                        rawJson, AS OF THE PINNED now (not
 *                                        "whatever the latest version is
 *                                        today", which would break the
 *                                        cursor's snapshot property)
 *   - getItemBeats(db, itemKey)         beat tags, unioned across every
 *                                        version -- itemBeats.ts's own doc
 *                                        comment: this is a deliberately
 *                                        TIMELESS fact with no `asOf`
 *                                        variant, so it reflects every beat
 *                                        known at READ time, not strictly
 *                                        "as of `now`" -- a documented,
 *                                        inherited, acceptable asymmetry.
 *   - getItemEntities(db, itemKey)      entities, same union treatment
 *   - getLatestItemScore(db, itemKey, beat)   the decay-invariant components
 *   - getClusterSizeAsOf(db, itemKey, score.computedAt)  NOT `now` -- mirrors
 *     src/score/rank.ts's own documented reasoning: keeps the displayed
 *     cluster count describing the SAME instant as the displayed score,
 *     rather than a cluster count from a later clustering pass sitting next
 *     to a score that predates it.
 *
 * ---------------------------------------------------------------------------
 * Merged vs. per-beat: ONE endpoint, deliberately
 * ---------------------------------------------------------------------------
 * §7.1 requires the merged stream and the six lanes to be the SAME view --
 * "lanes are the wide-viewport arrangement of [the merged stream]", not a
 * separate component tree. Two endpoints would force that identity to be
 * maintained by convention across two independently-evolving handlers (two
 * cursor formats, two ordering implementations, two places the dismissed-
 * item filter has to be kept in sync). One endpoint with an optional `beat`
 * filter makes the identity structural: a lane's request IS a merged-stream
 * request with `beat` set, sharing the exact same cursor shape, comparator,
 * and row shape. `rankBeat` in src/score/rank.ts already established this
 * per-beat composition for the CLI; this mirrors it and extends it to the
 * cross-beat merge.
 *
 * MERGED-VIEW REPRESENTATIVE BEAT: an item can genuinely belong to more than
 * one beat (arXiv cs.AI/cs.CR cross-listing is the real, if rare, case --
 * ~18 items in the M1/M2 corpus). Beat-level facts (source trust, cluster
 * size) are IDENTICAL across every beat an item belongs to (mechanical.ts
 * writes the same signal_score/read_score pair to every beat), but the
 * DECAY RATE differs per beat (config/decay.yaml). For a merged row, this
 * module picks whichever of the item's own beats yields the HIGHEST decayed
 * score for the REQUESTED sort profile (`buildCandidateRows`'s inner loop) --
 * i.e. the item is shown at its most current, most defensible characterization
 * rather than an arbitrary one -- and uses that SAME beat's rate for both
 * signalScore and readScore on that row, so the two numbers describe one
 * coherent snapshot rather than a chimera of two different half-lives. The
 * chosen beat is surfaced as `representativeBeat` on every row (not hidden),
 * and for a beat-filtered request it always equals the requested beat.
 *
 * ---------------------------------------------------------------------------
 * Dismissed items never come back (§7)
 * ---------------------------------------------------------------------------
 * Filtered out before ranking/pagination even sees them (`getItemState`,
 * src/domain/itemState.ts). Saved and read items still appear -- only
 * dismissal excludes. The `state.dismissedAt` field on a returned row is
 * consequently always `null` by construction; kept in the response anyway
 * (rather than omitted) so the shape mirrors ItemState exactly and so a
 * regression that let a dismissed item slip through would be directly
 * observable in the JSON, not hidden by field omission.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/connection.ts';
import {
  BEATS,
  InvalidTimestampError,
  RetentionHorizonError,
  assertCanonicalTimestamp,
  getItemAsOf,
  type Beat,
  type Item,
  type ItemType,
} from '../../domain/item.ts';
import { getItemBeats } from '../../domain/itemBeats.ts';
import { getItemEntities } from '../../domain/itemEntities.ts';
import { getItemFirstFetchedAt } from '../../domain/itemFirstFetchedAt.ts';
import { getItemState } from '../../domain/itemState.ts';
import { getClusterSizeAsOf } from '../../cluster/store.ts';
import { getLatestItemScore, type ItemScoreRow } from '../../score/mechanical.ts';
import { computeDecayFactor, type DecayConfig } from '../../score/decay.ts';
import { evaluateOverrides, type OverrideResult, type OverridesConfig } from '../../score/overrides.ts';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface FeedDeps {
  db: Db;
  decayConfig: DecayConfig;
  overridesConfig: OverridesConfig;
  /**
   * Injectable clock, matching every pure module in this codebase's "now is
   * always a parameter, never read from the system clock internally"
   * convention (src/score/decay.ts, src/score/overrides.ts, src/score/
   * rank.ts). Defaults to the real clock; tests override it to simulate
   * elapsed wall-clock time between two page-1-then-page-2 requests without
   * an actual sleep, which is how the cursor-stability test below proves the
   * pinned `now` is honored rather than silently re-read per request.
   */
  now?: () => string;
}

const SORT_PROFILES = ['signal', 'read'] as const;
export type SortProfile = (typeof SORT_PROFILES)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`invalid feed cursor: ${reason}`);
    this.name = 'InvalidCursorError';
  }
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** The seek boundary: the rank key of the last item returned on the previous page. */
const CursorAfterSchema = z
  .object({
    pinned: z.boolean(),
    priority: z.number().int().positive().nullable(),
    score: z.number().finite(),
    itemKey: z.string().min(1),
  })
  .strict();

const FeedCursorPayloadSchema = z
  .object({
    v: z.literal(1),
    now: z.string().min(1),
    // 'all' represents the merged (no beat filter) view -- see the module
    // doc comment, "Merged vs. per-beat: ONE endpoint, deliberately".
    beat: z.union([z.enum(BEATS), z.literal('all')]),
    profile: z.enum(SORT_PROFILES),
    after: CursorAfterSchema,
  })
  .strict();

export type FeedCursorPayload = z.infer<typeof FeedCursorPayloadSchema>;

function encodeCursor(payload: FeedCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): FeedCursorPayload {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (cause) {
    throw new InvalidCursorError(`could not decode: ${(cause as Error).message}`);
  }
  const result = FeedCursorPayloadSchema.safeParse(json);
  if (!result.success) {
    throw new InvalidCursorError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  // Belt-and-suspenders on top of the schema's z.string().min(1): a cursor's
  // `now` must be a genuine canonical timestamp, since it is about to be fed
  // straight into computeDecayFactor/getItemAsOf/evaluateOverrides exactly
  // like a fresh request's own `now` would be.
  try {
    assertCanonicalTimestamp('cursor.now', result.data.now);
  } catch (cause) {
    throw new InvalidCursorError((cause as Error).message);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Ranking: the total order, and the seek predicate built from it
// ---------------------------------------------------------------------------

interface RankKey {
  pinned: boolean;
  priority: number | null;
  score: number;
  itemKey: string;
}

/**
 * Negative if `a` ranks BEFORE `b` (a appears earlier in the list). Pinned
 * items sort first (priority ascending among them); then unpinned items by
 * score descending; item_key descending is the final, TOTAL tiebreak (see
 * module doc comment, point 3). item_key is a sha256 hex digest -- plain
 * codepoint comparison is exact and locale-independent, unlike
 * String.localeCompare.
 */
function compareRankKey(a: RankKey, b: RankKey): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned) {
    const byPriority = (a.priority ?? 0) - (b.priority ?? 0);
    if (byPriority !== 0) return byPriority;
  }
  if (a.score !== b.score) return b.score - a.score;
  if (a.itemKey === b.itemKey) return 0;
  return a.itemKey > b.itemKey ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Candidate resolution -- pinned to `now` (module doc comment, point 2)
// ---------------------------------------------------------------------------

/**
 * Every distinct item_key that (a) currently carries `beat` (getItemBeats'
 * union semantics, read via a direct join rather than calling getItemBeats
 * per candidate up front -- cheaper for a beat-filtered request, since it
 * narrows the candidate set before any per-item work happens) and (b) had at
 * least one version already fetched at or before `now` -- the candidate-set
 * half of pinning `now` (module doc comment, point 2).
 */
function candidateItemKeysForBeat(db: Db, beat: Beat, now: string): string[] {
  const rows = db
    .prepare(
      `select distinct i.item_key as item_key
       from item_beats ib
       join items i on i.item_id = ib.item_id
       where ib.beat = ? and i.fetched_at <= ?
       order by i.item_key`,
    )
    // Cast target is an inline type literal, not a named interface -- see
    // src/cluster/store.ts:88-100's comment on this exact node:sqlite
    // TS2352 quirk (a named interface here fails tsc; a structurally
    // identical inline literal does not).
    .all(beat, now) as Array<{ item_key: string }>;
  return rows.map((r) => r.item_key);
}

/** Every distinct item_key with at least one version fetched at or before `now`, for the merged (no beat filter) view. */
function candidateItemKeysAll(db: Db, now: string): string[] {
  const rows = db.prepare(`select distinct item_key from items where fetched_at <= ? order by item_key`).all(now) as Array<{
    item_key: string;
  }>;
  return rows.map((r) => r.item_key);
}

// ---------------------------------------------------------------------------
// Building rows
// ---------------------------------------------------------------------------

interface FeedRow {
  itemKey: string;
  title: string;
  sourceId: string;
  publishedAt: string | null;
  itemType: ItemType;
  beats: Beat[];
  entities: string[];
  representativeBeat: Beat;
  clusterSize: number;
  signalScore: number;
  readScore: number;
  signalOverride: OverrideResult;
  readOverride: OverrideResult;
  state: { readAt: string | null; savedAt: string | null; dismissedAt: string | null };
}

interface BestBeatScore {
  beat: Beat;
  score: ItemScoreRow;
  signalScore: number;
  readScore: number;
}

/**
 * Scores `itemKey` against every candidate beat and returns whichever beat
 * gives the item the highest decayed score for `profile` -- see the module
 * doc comment's "MERGED-VIEW REPRESENTATIVE BEAT". For a beat-filtered
 * request, `scoringBeats` has exactly one entry, so this simply resolves
 * that beat's score (or `null` if unscored for it yet -- excluded by the
 * caller, not an error, mirroring src/score/rank.ts's own convention).
 *
 * Ties (an item whose decayed score is identical under two of its beats --
 * possible when both beats share a half-life, or trivially when
 * clusterComponent is 0 and both beats decay to the same factor by
 * coincidence) are broken by iteration order: `scoringBeats` is
 * `getItemBeats`' own alphabetically-sorted output, so the alphabetically
 * earliest beat wins deterministically -- `>` rather than `>=` below is what
 * makes that so (a later, equal-scoring beat never displaces the first).
 */
function pickBestBeat(
  db: Db,
  itemKey: string,
  item: Pick<Item, 'publishedAt' | 'itemType'>,
  firstFetchedAt: string,
  scoringBeats: readonly Beat[],
  now: string,
  profile: SortProfile,
  decayConfig: DecayConfig,
): BestBeatScore | null {
  let best: BestBeatScore | null = null;

  for (const beat of scoringBeats) {
    const score = getLatestItemScore(db, itemKey, beat);
    if (!score) continue; // never scored for this beat -- excluded, not an error

    const decayInput = { publishedAt: item.publishedAt, firstFetchedAt, beat, itemType: item.itemType };
    const signalScore = score.signalScore * computeDecayFactor(decayInput, 'signal', now, decayConfig);
    const readScore = score.readScore * computeDecayFactor(decayInput, 'read', now, decayConfig);

    const candidateScore = profile === 'signal' ? signalScore : readScore;
    const bestScore = best ? (profile === 'signal' ? best.signalScore : best.readScore) : -Infinity;
    if (candidateScore > bestScore) {
      best = { beat, score, signalScore, readScore };
    }
  }
  return best;
}

/**
 * Builds every visible row for one request: resolves the pinned-`now`
 * candidate set (module doc comment, point 2), excludes dismissed items
 * (§7), and reads every item-level fact from the item-key-scoped read paths
 * (module doc comment, point 4) rather than a single-version shortcut.
 */
function buildCandidateRows(
  db: Db,
  beatFilter: Beat | undefined,
  now: string,
  profile: SortProfile,
  decayConfig: DecayConfig,
  overridesConfig: OverridesConfig,
): FeedRow[] {
  const itemKeys = beatFilter ? candidateItemKeysForBeat(db, beatFilter, now) : candidateItemKeysAll(db, now);
  const rows: FeedRow[] = [];

  for (const itemKey of itemKeys) {
    // Dismissed items never come back (§7) -- excluded before any other
    // work happens, not filtered out of an already-ranked list.
    const state = getItemState(db, itemKey);
    if (state !== null && state.dismissedAt !== null) continue;

    // Timeless union across every version sharing this item_key -- the beat
    // TAG list shown on the row (module doc comment, point 4's itemBeats.ts
    // caveat: no `asOf` variant exists, by that module's own design).
    const allBeats = getItemBeats(db, itemKey);
    const scoringBeats = beatFilter ? ([beatFilter] as const) : allBeats;
    if (scoringBeats.length === 0) continue;

    // AS OF THE PINNED now -- not getCurrentItem, which would leak a
    // version that postdates the cursor's own snapshot instant back into an
    // already-paged-through response (module doc comment, point 4).
    const item = getItemAsOf(db, itemKey, now);
    if (!item) continue; // unreachable in practice: the candidate query already bounds fetched_at <= now

    const firstFetchedAt = getItemFirstFetchedAt(db, itemKey) ?? item.fetchedAt;

    const best = pickBestBeat(db, itemKey, item, firstFetchedAt, scoringBeats, now, profile, decayConfig);
    if (!best) continue; // none of this item's current beats have been scored yet

    const overrideInput = { sourceId: item.sourceId, publishedAt: item.publishedAt, rawJson: item.rawJson };
    const signalOverride = evaluateOverrides(overrideInput, 'signal', now, overridesConfig);
    const readOverride = evaluateOverrides(overrideInput, 'read', now, overridesConfig);

    // The score's own computed_at, NOT `now` -- see module doc comment,
    // point 4 (mirrors src/score/rank.ts's identical, documented reasoning).
    const clusterSize = getClusterSizeAsOf(db, itemKey, best.score.computedAt);

    rows.push({
      itemKey,
      title: item.title,
      sourceId: item.sourceId,
      publishedAt: item.publishedAt,
      itemType: item.itemType,
      beats: allBeats,
      entities: getItemEntities(db, itemKey),
      representativeBeat: best.beat,
      clusterSize,
      signalScore: best.signalScore,
      readScore: best.readScore,
      signalOverride,
      readOverride,
      state: {
        readAt: state?.readAt ?? null,
        savedAt: state?.savedAt ?? null,
        dismissedAt: state?.dismissedAt ?? null,
      },
    });
  }

  return rows;
}

function rankKeyFor(row: FeedRow, profile: SortProfile): RankKey {
  const override = profile === 'signal' ? row.signalOverride : row.readOverride;
  const score = profile === 'signal' ? row.signalScore : row.readScore;
  return { pinned: override.pinned, priority: override.priority, score, itemKey: row.itemKey };
}

// ---------------------------------------------------------------------------
// JSON shape -- camelCase, bare object, nulls stay null (coordinator's wire
// convention). Domain rows are never serialized directly (Item mixes
// camelCase/snake_case) -- every field below is named and mapped explicitly.
// ---------------------------------------------------------------------------

function toFeedItemJson(row: FeedRow, profile: SortProfile) {
  return {
    itemKey: row.itemKey,
    title: row.title,
    sourceId: row.sourceId,
    publishedAt: row.publishedAt,
    itemType: row.itemType,
    beats: row.beats,
    entities: row.entities,
    representativeBeat: row.representativeBeat,
    clusterSize: row.clusterSize,
    // Both scores, always both, never blended (§5.1) -- plus which one
    // determined this response's order.
    signalScore: row.signalScore,
    readScore: row.readScore,
    sortProfile: profile,
    override: {
      signal: {
        pinned: row.signalOverride.pinned,
        priority: row.signalOverride.priority,
        label: row.signalOverride.matches[0]?.label ?? null,
      },
      read: {
        pinned: row.readOverride.pinned,
        priority: row.readOverride.priority,
        label: row.readOverride.matches[0]?.label ?? null,
      },
    },
    state: row.state,
  };
}

// ---------------------------------------------------------------------------
// Query validation -- Zod, `.strict()` so an unknown key fails loudly rather
// than being silently ignored (shared convention, point 6).
// ---------------------------------------------------------------------------

const FeedQuerySchema = z
  .object({
    beat: z.enum(BEATS).optional(),
    profile: z.enum(SORT_PROFILES).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    cursor: z.string().min(1).optional(),
    // Validated for canonical shape below via assertCanonicalTimestamp,
    // not here -- reusing the one real validator rather than a second regex.
    now: z.string().min(1).optional(),
  })
  .strict();

const DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function registerFeed(server: FastifyInstance, deps: FeedDeps): void {
  const nowFn = deps.now ?? (() => new Date().toISOString());

  server.get('/feed', async (request, reply) => {
    const parsedQuery = FeedQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      await reply.code(400).send({
        error: 'invalid_query',
        message: parsedQuery.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      return;
    }
    const query = parsedQuery.data;

    let cursorPayload: FeedCursorPayload | null = null;
    if (query.cursor !== undefined) {
      try {
        cursorPayload = decodeCursor(query.cursor);
      } catch (cause) {
        await reply.code(400).send({ error: 'invalid_cursor', message: (cause as Error).message });
        return;
      }
    }

    if (query.now !== undefined) {
      try {
        assertCanonicalTimestamp('now', query.now);
      } catch (cause) {
        await reply.code(400).send({ error: 'invalid_query', message: (cause as Error).message });
        return;
      }
    }

    // Once a cursor is present it is AUTHORITATIVE for now/beat/profile --
    // an explicit query param is allowed only if it AGREES with the cursor,
    // never silently overridden (fail loudly on a hostile/inconsistent
    // combination, per the shared convention, rather than picking one and
    // discarding the other without telling the caller).
    if (cursorPayload) {
      if (query.now !== undefined && query.now !== cursorPayload.now) {
        await reply.code(400).send({ error: 'cursor_mismatch', message: '`now` does not match the cursor' });
        return;
      }
      if (query.beat !== undefined && query.beat !== cursorPayload.beat) {
        await reply.code(400).send({ error: 'cursor_mismatch', message: '`beat` does not match the cursor' });
        return;
      }
      if (query.profile !== undefined && query.profile !== cursorPayload.profile) {
        await reply.code(400).send({ error: 'cursor_mismatch', message: '`profile` does not match the cursor' });
        return;
      }
    }

    const now = cursorPayload ? cursorPayload.now : (query.now ?? nowFn());
    const beatFilter: Beat | undefined = cursorPayload
      ? cursorPayload.beat === 'all'
        ? undefined
        : cursorPayload.beat
      : query.beat;
    const profile: SortProfile = cursorPayload ? cursorPayload.profile : (query.profile ?? 'signal');
    const limit = query.limit ?? DEFAULT_LIMIT;

    try {
      const rows = buildCandidateRows(deps.db, beatFilter, now, profile, deps.decayConfig, deps.overridesConfig);
      const sorted = [...rows].sort((a, b) => compareRankKey(rankKeyFor(a, profile), rankKeyFor(b, profile)));

      const windowRows = cursorPayload
        ? sorted.filter((row) => compareRankKey(rankKeyFor(row, profile), cursorPayload!.after) > 0)
        : sorted;

      const page = windowRows.slice(0, limit);
      const hasMore = windowRows.length > page.length;

      let nextCursor: string | null = null;
      if (hasMore) {
        const lastKey = rankKeyFor(page[page.length - 1]!, profile);
        nextCursor = encodeCursor({
          v: 1,
          now,
          beat: beatFilter ?? 'all',
          profile,
          after: lastKey,
        });
      }

      await reply.send({
        items: page.map((row) => toFeedItemJson(row, profile)),
        beat: beatFilter ?? null,
        profile,
        now,
        total: sorted.length,
        nextCursor,
      });
    } catch (cause) {
      if (cause instanceof RetentionHorizonError || cause instanceof InvalidTimestampError) {
        await reply.code(400).send({ error: 'invalid_query', message: cause.message });
        return;
      }
      throw cause;
    }
  });
}

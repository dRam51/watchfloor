/**
 * Point-in-time reads for the §8.2 bot tools (M5 task 11).
 *
 * §8.2 calls this the part that will silently ruin the bot:
 *
 * > *"Every item carries `fetched_at` (when Watchfloor first had it) distinct
 * > from `published_at` (when the source says it appeared). All query tools
 * > must accept an `as_of` parameter and, when given, return only items where
 * > `fetched_at <= as_of`. Without this, any evaluation the bot runs against
 * > historical news is contaminated by lookahead bias and its backtest numbers
 * > are fiction."*
 *
 * ---------------------------------------------------------------------------
 * `fetched_at` is the filter. `published_at` is a FACT WE RELAY, never a bound
 * ---------------------------------------------------------------------------
 * Both timestamps sit on every row and the wrong one looks right. Two reasons
 * it is `fetched_at`, and the second is the one that bites:
 *
 *  1. **`published_at` is what the source claims**, and a source can publish a
 *     backdated item tomorrow. Filtering on it admits rows this system did not
 *     have at `as_of` — the definition of lookahead.
 *  2. **`published_at` is NULLABLE and really is null.** Measured on
 *     `attic/wf-m1-firstrun-2026-08-14.db`: **1,715 of 3,325 items (51.6%)**
 *     carry no publication date — 1,665 of them `cisa-kev`, whose catalogue
 *     dump has no per-entry date. `published_at <= ?` is NULL for every one of
 *     them, which SQL treats as false, so a `published_at`-keyed filter drops
 *     half the corpus **at every as_of, including "now"**, with no error and no
 *     empty result to notice. `items.fetched_at` is NOT NULL, so the correct
 *     filter is total.
 *
 * The live corpus cannot show you this: all 7,267 of its rows are dated. The
 * archive is where the hard case lives, and that is where
 * tests/mcp/tools/asOf.test.ts proves it.
 *
 * ---------------------------------------------------------------------------
 * Three facts are read as of `as_of`, not one
 * ---------------------------------------------------------------------------
 *  - **Which VERSION was current.** `items` is append-only; the newest version
 *    at or before `as_of` is what a reader then would have seen. M5 task 3
 *    measured ten live keys whose title or summary changed under an unchanged
 *    URL, one of which reverses its claim ("Wall Street *holds near* its
 *    record" -> "*slips back from* its record"). Returning today's version for
 *    a historical query hands the bot the corrected headline.
 *  - **When we FIRST had it.** `min(fetched_at)` across versions, never the
 *    selected version's own `fetched_at`. CLAUDE.md records this exact
 *    confusion as having bitten four times; `src/domain/itemFirstFetchedAt.ts`
 *    is the writable-handle equivalent and carries the long-form reasoning
 *    (short version: `cisa-kev` re-delivers unchanged entries, so a
 *    current-version `fetched_at` resets an undated item's apparent age to zero
 *    forever).
 *  - **What it SCORED.** `item_scores` is append-only with its own
 *    `computed_at`, and a score row computed after `as_of` is knowledge from
 *    after `as_of` — it can encode a cluster size that only existed once later
 *    corroborating stories arrived. Filtering items but not scores leaves the
 *    lookahead in the number the bot ranks by, which is the half a reader is
 *    least likely to check.
 *
 * ---------------------------------------------------------------------------
 * `read_score` is not merely omitted here — it is unreadable
 * ---------------------------------------------------------------------------
 * Every query below names its columns. `select *` and the identifier
 * `read_score` are both refused by `src/mcp/readonly.ts` before SQLite sees
 * them, so this module could not read the column if it tried.
 */

import { assertCanonicalTimestamp, BEATS, type Beat, type ItemType } from '../../domain/item.ts';
import type { ReadOnlyCorpus, SqlParam } from '../readonly.ts';

export type AsOfFailure = 'malformed' | 'retention_horizon';

// Declared fields, never a TypeScript parameter property -- Node 26 runs
// src/bin/*.ts through strip-only type removal and rejects those outright.
// See src/mcp/readonly.ts's SqlRefusedError for the crash that established it.
export class AsOfError extends Error {
  readonly reason: AsOfFailure;
  constructor(reason: AsOfFailure, message: string) {
    super(message);
    this.name = 'AsOfError';
    this.reason = reason;
  }
}

export interface ReadInstant {
  /** The instant every query below is answered as of. */
  readonly readAt: string;
  /** Whether the CALLER pinned it. A tool must report this rather than imply a backtest. */
  readonly asOfProvided: boolean;
}

/**
 * Resolves the instant a request is answered as of.
 *
 * A missing `as_of` means "now", and `now` is the dispatcher's canonical
 * per-request instant (`McpToolContext.now`) rather than a fresh clock read —
 * two tools called in one request must not disagree about the present.
 *
 * A malformed `as_of` is REFUSED, not coerced. `Date.parse('2026-08-14')`
 * succeeds and means midnight UTC; accepting it would silently move a
 * backtest's boundary by up to a day, and accepting an offset form
 * (`...+02:00`) would break the lexicographic comparison every timestamp
 * column in this schema relies on.
 */
export function resolveReadInstant(asOf: string | undefined, now: string): ReadInstant {
  if (asOf === undefined) return { readAt: now, asOfProvided: false };
  try {
    assertCanonicalTimestamp('asOf', asOf);
  } catch (cause) {
    throw new AsOfError('malformed', (cause as Error).message);
  }
  return { readAt: asOf, asOfProvided: true };
}

/**
 * §3 + decision 2: *"as_of queries older than this must fail loudly rather
 * than return archived, thinned rows."*
 *
 * `retention_horizon` is empty until M6's retention job seeds it, so this is a
 * no-op on every corpus that exists today. It is implemented anyway because
 * the failure it prevents is exactly this task's subject: a bot asking about
 * last year, over a corpus that has been thinned, gets a smaller answer and no
 * indication that it is smaller.
 */
export function assertWithinRetentionHorizon(corpus: ReadOnlyCorpus, asOf: string): void {
  const row = corpus.get('select oldest_intact_fetched_at as oldest from retention_horizon where id = 1');
  if (row === undefined) return;
  const oldest = String(row.oldest);
  assertCanonicalTimestamp('retention_horizon.oldest_intact_fetched_at', oldest);
  if (asOf < oldest) {
    throw new AsOfError(
      'retention_horizon',
      `as_of ${asOf} is older than this corpus's retention horizon (${oldest}); ` +
        `history before that instant has been thinned, so any answer would be quietly incomplete`,
    );
  }
}

export interface ItemVersionAsOf {
  readonly itemKey: string;
  readonly itemId: string;
  readonly title: string;
  readonly url: string;
  readonly sourceId: string;
  readonly itemType: ItemType;
  readonly publishedAt: string | null;
  /** The `fetched_at` of the version that was current at `asOf`. */
  readonly versionFetchedAt: string;
  /**
   * `min(fetched_at)` across every version visible at `asOf` — when this
   * system FIRST had the item. Never `versionFetchedAt`; see the module doc
   * comment.
   */
  readonly firstSeenAt: string;
}

/**
 * SQLite's parameter limit is generous (32,766 on any build this project runs
 * on) and the corpus is smaller than that, but an `in (...)` list built from a
 * caller-influenced set is exactly the thing that stops working at the size
 * nobody tested. Chunked, so the tools' behaviour does not have a cliff.
 */
const PARAM_CHUNK = 900;

function chunk<T>(values: readonly T[], size = PARAM_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/** Every `item_key` with at least one version fetched at or before `asOf`. */
export function visibleItemKeysAsOf(corpus: ReadOnlyCorpus, asOf: string): string[] {
  return corpus
    .all('select distinct item_key as item_key from items where fetched_at <= ? order by item_key', asOf)
    .map((row) => String(row.item_key));
}

export function readItemsAsOf(
  corpus: ReadOnlyCorpus,
  itemKeys: readonly string[],
  asOf: string,
): Map<string, ItemVersionAsOf> {
  const result = new Map<string, ItemVersionAsOf>();
  if (itemKeys.length === 0) return result;

  // `rowid desc` is the tiebreak src/domain/item.ts's getCurrentItem uses:
  // `items` has no uniqueness on (item_key, fetched_at) and two versions can
  // legally share an instant, so without it SQL guarantees no order at all.
  for (const keys of chunk(itemKeys)) {
    const params: SqlParam[] = [asOf, ...keys];
    const rows = corpus.all(
      `select item_key as item_key, item_id as item_id, title as title, url as url,
              source_id as source_id, item_type as item_type, published_at as published_at,
              fetched_at as fetched_at, rowid as row_seq
       from items
       where fetched_at <= ? and item_key in (${placeholders(keys.length)})`,
      ...params,
    );

    const best = new Map<string, { fetchedAt: string; rowSeq: number; row: Record<string, unknown> }>();
    const firstSeen = new Map<string, string>();
    for (const row of rows) {
      const key = String(row.item_key);
      const fetchedAt = String(row.fetched_at);
      const rowSeq = Number(row.row_seq);

      const seen = firstSeen.get(key);
      if (seen === undefined || fetchedAt < seen) firstSeen.set(key, fetchedAt);

      const current = best.get(key);
      if (current === undefined || fetchedAt > current.fetchedAt || (fetchedAt === current.fetchedAt && rowSeq > current.rowSeq)) {
        best.set(key, { fetchedAt, rowSeq, row });
      }
    }

    for (const [key, entry] of best) {
      const row = entry.row;
      result.set(key, {
        itemKey: key,
        itemId: String(row.item_id),
        title: String(row.title),
        url: String(row.url),
        sourceId: String(row.source_id),
        itemType: String(row.item_type) as ItemType,
        publishedAt: row.published_at === null ? null : String(row.published_at),
        versionFetchedAt: entry.fetchedAt,
        firstSeenAt: firstSeen.get(key)!,
      });
    }
  }
  return result;
}

/**
 * Beats, unioned across every version visible at `asOf`.
 *
 * The union is `src/domain/itemBeats.ts`'s rule — CLAUDE.md's *"Beats belong to
 * the item"* — and it matters here for the same reason it does there: an arXiv
 * paper cross-listed in `cs.AI` and `cs.CR` is two rows under one key, and a
 * single-version read returns only the tie-break winner's beat.
 */
export function readBeatsAsOf(
  corpus: ReadOnlyCorpus,
  itemKeys: readonly string[],
  asOf: string,
): Map<string, Beat[]> {
  const result = new Map<string, Set<Beat>>();
  for (const keys of chunk(itemKeys)) {
    const params: SqlParam[] = [asOf, ...keys];
    const rows = corpus.all(
      `select distinct i.item_key as item_key, b.beat as beat
       from item_beats b
       join items i on i.item_id = b.item_id
       where i.fetched_at <= ? and i.item_key in (${placeholders(keys.length)})`,
      ...params,
    );
    for (const row of rows) {
      const key = String(row.item_key);
      const beat = String(row.beat) as Beat;
      if (!BEATS.includes(beat)) continue;
      const set = result.get(key) ?? new Set<Beat>();
      set.add(beat);
      result.set(key, set);
    }
  }
  return new Map([...result].map(([key, set]) => [key, [...set].sort()]));
}

export interface StoredSignal {
  /** `item_scores.signal_score` — the stored, DECAY-INVARIANT component. */
  readonly signalScore: number;
  readonly scorerVersion: string;
  readonly computedAt: string;
}

/**
 * The latest signal score per (item, beat) computed at or before `asOf`.
 *
 * Keyed on `item_key`, not `item_id`, so the freshest known score for the ITEM
 * is found even when the current version has moved on to one that has not been
 * scored yet — the same rule `src/score/mechanical.ts`'s `getLatestItemScore`
 * documents.
 *
 * `read_score` is absent from the select list and could not be added: the
 * read-only handle refuses the identifier.
 */
export function readSignalScoresAsOf(
  corpus: ReadOnlyCorpus,
  itemKeys: readonly string[],
  asOf: string,
): Map<string, Map<Beat, StoredSignal>> {
  const result = new Map<string, Map<Beat, StoredSignal>>();
  const chosen = new Map<string, { computedAt: string; rowSeq: number }>();

  for (const keys of chunk(itemKeys)) {
    const params: SqlParam[] = [asOf, ...keys];
    const rows = corpus.all(
      `select i.item_key as item_key, s.beat as beat, s.signal_score as signal_score,
              s.scorer_version as scorer_version, s.computed_at as computed_at, s.rowid as row_seq
       from item_scores s
       join items i on i.item_id = s.item_id
       where s.computed_at <= ? and i.item_key in (${placeholders(keys.length)})`,
      ...params,
    );

    for (const row of rows) {
      const key = String(row.item_key);
      const beat = String(row.beat) as Beat;
      const computedAt = String(row.computed_at);
      const rowSeq = Number(row.row_seq);
      const slot = `${key} ${beat}`;
      const current = chosen.get(slot);
      if (current !== undefined && (computedAt < current.computedAt || (computedAt === current.computedAt && rowSeq <= current.rowSeq))) {
        continue;
      }
      chosen.set(slot, { computedAt, rowSeq });
      const perBeat = result.get(key) ?? new Map<Beat, StoredSignal>();
      perBeat.set(beat, {
        signalScore: Number(row.signal_score),
        scorerVersion: String(row.scorer_version),
        computedAt,
      });
      result.set(key, perBeat);
    }
  }
  return result;
}

import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp, RetentionHorizonError } from './item.ts';

/**
 * Resolves the EARLIEST `fetched_at` across every stored version (`item_id`)
 * sharing the given `item_key` -- when this system first noticed the item,
 * a value that is stable for as long as the item exists under append-only
 * storage, unlike any single version's own `fetched_at`.
 *
 * The fetched_at half of `./itemBeats.ts` and `./itemEntities.ts`: same
 * family (a corrected read scoped by `item_key`, sitting alongside
 * `./item.ts` rather than changing it), but a different defect shape --
 * this one was found in fix round 1 on `src/score/decay.ts`'s null-
 * published_at fallback, not in M1's original union-across-versions defect.
 *
 * ## The defect this fixes
 * `src/score/decay.ts`'s null-`published_at` decision falls back to
 * `fetchedAt` -- defensible, since `items.fetched_at` is always defined.
 * But `insertItem` never dedupes on content and `items` is append-only, so
 * a source that re-delivers an unchanged entry (not a correction, not a new
 * fact -- the identical item, again) produces a brand-new row with a fresh
 * `fetched_at`, and `getCurrentItem`'s `order by fetched_at desc, rowid desc
 * limit 1` (`./item.ts`) means that newest row is what any caller reaching
 * for "this item's `fetchedAt`" gets back. For an undated item, that fresh
 * `fetched_at` IS the entire timestamp decay has to work with -- so every
 * re-delivery resets its apparent age to zero, forever, no matter how old
 * the item actually is. Not a one-time offset; a permanent inability to
 * age. This function reads the one fact that doesn't reset: the first row
 * ever written for this `item_key`.
 *
 * ## Reachable today, not hypothetical
 * `cisa-kev`'s JSON feed re-dumps its ENTIRE catalog on every poll that adds
 * even a single new CVE elsewhere in the list -- confirmed directly against
 * `attic/wf-m1-firstrun-2026-08-14.db`: `cisa-kev` is the source of 1,665 of
 * M1's 1,715 null-`published_at` items, every one of them exactly the shape
 * that re-delivers unchanged. Reproduced against the real, unmodified
 * `item.ts`/`decay.ts` primitives (see `tests/score/decay.test.ts`'s "the
 * defect getItemFirstFetchedAt exists to fix" block): an undated item first
 * ingested five months before `now`, at `cyber`'s 6h signal half-life,
 * decays to `5.88e-185` using its true first-seen time -- and back to
 * exactly `1` (maximally fresh) the instant it is naively read via
 * `getCurrentItem(...).fetchedAt` after nothing more than a routine re-poll
 * that changed nothing about the entry itself.
 *
 * ## Why this has an `asOf` variant when `./itemBeats.ts` deliberately doesn't
 * `itemBeats.ts` reasoned that beat cross-listing is a permanent, timeless
 * fact about a paper, not something meaningfully reconstructed as of a past
 * instant, and left `asOf` out. First-seen time is the opposite kind of
 * fact: its entire purpose is answering a point-in-time question ("how
 * stale did this look as of last Tuesday's read"), which is the specific
 * thing M2's read-time-decay architecture exists to get right (see
 * `src/score/decay.ts`'s module doc comment and the M2 plan's "the decision
 * that shapes everything: decay at read time"). Skipping `asOf` here would
 * leave exactly the kind of historical-query untruthfulness that
 * architecture was built to avoid.
 *
 * ## Scope: never crosses item_key
 * Both functions below scope their query strictly to the given `item_key`,
 * identically to `itemBeats.ts`/`itemEntities.ts` -- two unrelated items
 * must never influence each other's first-seen time.
 *
 * ## Shape
 * A single ISO timestamp string, or `null`. Unlike `itemBeats.ts`/
 * `itemEntities.ts` (which return `[]` for "nothing here" because their
 * result is naturally a collection), the natural "nothing here" value for a
 * single timestamp is `null` -- and SQL gives this for free: `min()` over
 * zero matching rows evaluates to `NULL` without any special-casing in this
 * file (verified directly: `db.prepare(...).get(unknownKey)` returns
 * `{ first_fetched_at: null }`, never `undefined`, because an aggregate
 * query with no `GROUP BY` always produces exactly one result row). For
 * `getItemFirstFetchedAtAsOf`, `null` additionally (and correctly) means
 * "not yet seen as of `asOf`" for an item that exists but whose first
 * version postdates `asOf` -- indistinguishable from, and exactly as
 * correct as, an entirely unknown `item_key` (tested directly).
 * `items.fetched_at` is `NOT NULL`, so `null` can only ever mean "no
 * qualifying row", never "a row exists but its value is unknown".
 *
 * ## Cost
 * One indexed query per call, using the same `items_key_fetched` index
 * (`db/migrations/0001_init.sql`) `./itemBeats.ts`/`./item.ts` already rely
 * on for this exact `(item_key, fetched_at)` access pattern. Same
 * not-batched-yet note as `itemBeats.ts`/`itemEntities.ts`: fine for a
 * single-item read, `O(items shown)` queries for a list view; the fix when
 * that matters is one `item_key in (...)` query grouped client-side, left
 * unbuilt until something actually calls this in a loop.
 */
export function getItemFirstFetchedAt(db: Db, itemKey: string): string | null {
  const row = db
    .prepare('select min(fetched_at) as first_fetched_at from items where item_key = ?')
    .get(itemKey) as { first_fetched_at: string | null };
  return row.first_fetched_at;
}

/**
 * The point-in-time variant of {@link getItemFirstFetchedAt}: resolves the
 * earliest `fetched_at` among only the versions that existed at or before
 * `asOf`, so a historical decay computation never has its first-seen fact
 * contaminated by something learned after the instant being asked about.
 *
 * Mirrors `./item.ts`'s `getItemAsOf` exactly for the retention-horizon
 * guard (duplicated rather than imported as a shared helper -- `item.ts` is
 * off-limits to edit, and the guard is three lines, not worth a refactor
 * that would require touching it). `asOf` earlier than every version
 * (including every version being strictly after `asOf`, i.e. the item
 * hadn't been noticed yet as of that instant) returns `null` -- see the
 * module doc comment's "Shape" section for why that's correct, not a gap.
 */
export function getItemFirstFetchedAtAsOf(db: Db, itemKey: string, asOf: string): string | null {
  assertCanonicalTimestamp('asOf', asOf);

  const horizon = db.prepare('select oldest_intact_fetched_at from retention_horizon where id = 1').get() as
    | { oldest_intact_fetched_at: string }
    | undefined;
  if (horizon) {
    assertCanonicalTimestamp('retention_horizon.oldest_intact_fetched_at', horizon.oldest_intact_fetched_at);
    if (asOf < horizon.oldest_intact_fetched_at) {
      throw new RetentionHorizonError(asOf, horizon.oldest_intact_fetched_at);
    }
  }

  const row = db
    .prepare('select min(fetched_at) as first_fetched_at from items where item_key = ? and fetched_at <= ?')
    .get(itemKey, asOf) as { first_fetched_at: string | null };
  return row.first_fetched_at;
}

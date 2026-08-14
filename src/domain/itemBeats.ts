import type { Db } from '../db/connection.ts';
import type { Beat } from './item.ts';

/**
 * Resolves the full set of beats attributed to an item, unioned across every
 * stored version (`item_id`) that shares the given `item_key`.
 *
 * ## The defect this fixes
 * `items.item_key = sha256(canonical_url)`, and two different sources can
 * legitimately publish the same canonical URL -- the real case is arXiv
 * papers cross-listed in both `cs.AI` and `cs.CR`, which two separate feed
 * adapters (`arxiv-cs-ai`, `arxiv-cs-cr`) each ingest as their own `items`
 * row (their own `item_id`), writing their own `item_beats` rows against
 * that `item_id`. Because `item_beats` is keyed by `item_id`, not
 * `item_key`, `Item.beats` as hydrated by `getCurrentItem` / `getItemAsOf`
 * in `./item.ts` reflects only whichever single version that read's
 * `order by fetched_at desc, rowid desc limit 1` happens to pick -- the
 * *current version's* beats, not the *item's*. A paper genuinely in both
 * `ai` and `aisec` shows only one, depending on which source's row happened
 * to be inserted last.
 *
 * This is not a storage bug -- both `item_beats` rows are written correctly
 * and `items`/`item_beats` are append-only, so nothing is lost. It is a bug
 * in how beats are *read*. This function is the corrected read path: beats
 * belong to the item, unioned across every version that carried it, not to
 * whichever version wrote last. It does not change `item.ts` and does not
 * change what `Item.beats` returns -- callers that need "what beats does
 * this item genuinely belong to" (the scorer, the API) should call this
 * instead of trusting `Item.beats`.
 *
 * ## Scope: never crosses item_key
 * The union is scoped strictly to the given `item_key` -- two different
 * items that happen to share a beat obviously must not bleed into each
 * other. Two ingested *versions of the same item* (same `item_key`) can and,
 * by design, legitimately do.
 *
 * ## Shape
 * Always a plain, deduplicated, deterministically ordered `Beat[]` --
 * whether the item has one version or several, and whether or not
 * `item_key` has ever been ingested at all (an unknown key returns `[]`,
 * the same shape as a known one with no beats, never `null` or a throw).
 * Callers never need a special case for "the common case of one version".
 *
 * ## Cost
 * One indexed query per call: a subquery on `items(item_key, ...)`
 * (`items_key_fetched`, db/migrations/0001_init.sql) feeding an `in` against
 * `item_beats`'s implicit `(item_id, beat)` primary-key index. Fine for a
 * single-item read, but the current-item read path already pays a
 * per-item-key query (`getCurrentItem`/`getItemAsOf` in `./item.ts`), and
 * this adds a second one alongside it -- so resolving beats for a page of
 * items is `O(items shown)` queries, not one. Not batched here because
 * nothing today calls this in a loop; if a scored list view over hundreds of
 * items becomes the hot path, the fix is a single query keyed on
 * `item_key in (...)` grouped client-side into `Map<itemKey, Beat[]>`,
 * amortizing to one query for the whole page -- deliberately not built until
 * something needs it.
 */
export function getItemBeats(db: Db, itemKey: string): Beat[] {
  const rows = db
    .prepare(
      `select distinct beat
       from item_beats
       where item_id in (select item_id from items where item_key = ?)
       order by beat`,
    )
    .all(itemKey) as Array<{ beat: Beat }>;
  return rows.map((r) => r.beat);
}

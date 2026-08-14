import type { Db } from '../db/connection.ts';

/**
 * Resolves the full set of entities attributed to an item, unioned across every
 * stored version (`item_id`) that shares the given `item_key`.
 *
 * The entity half of `./itemBeats.ts`. Same defect, same shape, same fix --
 * read that file's doc comment for the long-form reasoning; this one records
 * only what differs.
 *
 * ## The defect this fixes
 * `items.item_key = sha256(canonical_url)`, and two different sources can
 * legitimately publish the same canonical URL -- the real case is arXiv papers
 * cross-listed in both `cs.AI` and `cs.CR`, which two separate feed adapters
 * ingest as their own `items` row (their own `item_id`). `item_entities` is
 * `(item_id, entity)` with primary key `(item_id, entity)` (db/migrations/
 * 0001_init.sql) -- byte-for-byte the shape of `item_beats` -- so `hydrate()`
 * in `./item.ts` reads entities from a single `item_id` exactly the way it read
 * beats, and `Item.entities` reflects only whichever version that read's
 * `order by fetched_at desc, rowid desc limit 1` happens to pick. Entities
 * attributed by any other source are silently dropped.
 *
 * Not a storage bug: every `item_entities` row is written correctly and
 * `items`/`item_entities` are append-only, so nothing is lost. It is a bug in
 * how entities are *read*. This function is the corrected read path. It does
 * not change `item.ts` and does not change what `Item.entities` returns --
 * callers that need "what entities does this item genuinely carry" (the scorer,
 * the API, portfolio proximity at M4b) should call this instead.
 *
 * ## Latent today, not hypothetical
 * `select count(*) from item_entities` against the first live ingest
 * (attic/wf-m1-firstrun-2026-08-14.db) returns **0**, against 3,325 rows in
 * `item_beats` -- M1 populates beats but ships no entity extractor. So this bug
 * cannot currently be observed in production data. It is fixed now anyway,
 * because the defect follows from the schema rather than from the data: the
 * moment an extractor writes the first entity row for a cross-listed item, the
 * shadowing is live, and the read path it would be wired into is the wrong one.
 * Fixing it after that point would mean auditing which reads had already been
 * taken against a shadowed view.
 *
 * ## Scope: never crosses item_key
 * The union is scoped strictly to the given `item_key` -- two different items
 * that happen to share an entity (`Microsoft` will be common) obviously must not
 * bleed into each other. Two ingested *versions of the same item* (same
 * `item_key`) can and, by design, legitimately do.
 *
 * ## Shape
 * Always a plain, deduplicated, `entity`-ordered `string[]` -- whether the item
 * has one version or several, whether it has entities or none, and whether or
 * not `item_key` has ever been ingested (an unknown key returns `[]`, the same
 * shape as a known one with no entities, never `null` or a throw). Given that
 * *every* real item is currently the no-entities case, that uniformity is doing
 * real work: no caller needs a null check for the only state the data is in.
 * Unlike `Beat[]`, this is unconstrained `string[]` -- entities are extracted
 * text, not a closed enum, so there is no union type to narrow to.
 *
 * ## Cost
 * One indexed query per call: a subquery on `items(item_key, ...)`
 * (`items_key_fetched`, db/migrations/0001_init.sql) feeding an `in` against
 * `item_entities`'s implicit `(item_id, entity)` primary-key index. Fine for a
 * single-item read, but the current-item read path already pays a
 * per-item-key query (`getCurrentItem`/`getItemAsOf` in `./item.ts`), and a
 * caller wanting both beats and entities now pays three. Resolving a page of
 * items is `O(items shown)` queries per accessor, not one. Not batched here
 * because nothing calls this in a loop yet; if a scored list view over hundreds
 * of items becomes the hot path, the fix is a single query keyed on
 * `item_key in (...)` grouped client-side into `Map<itemKey, string[]>` --
 * deliberately not built until something needs it. Same note stands in
 * `./itemBeats.ts`; whichever batching lands should cover both.
 */
export function getItemEntities(db: Db, itemKey: string): string[] {
  const rows = db
    .prepare(
      `select distinct entity
       from item_entities
       where item_id in (select item_id from items where item_key = ?)
       order by entity`,
    )
    .all(itemKey) as Array<{ entity: string }>;
  return rows.map((r) => r.entity);
}

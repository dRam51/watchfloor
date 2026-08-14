-- Full-text search (M3 task 2, src/search/query.ts). §7: "Full-text search
-- across everything retained (FTS5)."
--
-- ---------------------------------------------------------------------------
-- What "everything retained" means here, and what a user will fail to find
-- ---------------------------------------------------------------------------
-- Watchfloor stores links and short excerpts, never full article text --
-- summary_raw is capped at ~300 characters at a word boundary
-- (src/normalize/item.ts, MAX_SUMMARY_LENGTH), and raw_json is the source's
-- opaque original payload, not display text. So the indexed columns below
-- (title, summary_raw, author, source_id) genuinely ARE everything this
-- system retains that a human would recognize as "the text of the item".
-- item_entities is deliberately NOT indexed: as of this migration it holds
-- ZERO rows in both the first live M1 ingest and the M2 acceptance corpus
-- (src/domain/itemEntities.ts's own doc comment already establishes this --
-- "Latent today, not hypothetical") -- indexing an empty table teaches
-- nothing. The day an entity extractor lands, that is a second migration
-- adding an entity column, not a reason to block this one.
--
-- The direct consequence: a user searching a phrase that appeared only in
-- paragraph four of the original article -- anything past the ~300-character
-- excerpt -- gets NO hit, because that text was never stored anywhere in
-- this system, by design (§3). This is a documented property of the corpus,
-- not a search-quality bug to be fixed later. A second, subtler
-- consequence, verified directly against the M2 acceptance corpus
-- (data/wf.db): PBS NewsHour's title for the Cézanne theft story stores the
-- literal, un-decoded HTML entity text "C&eacute;zanne" (tokenizes to
-- "c" / "eacute" / "zanne"), not the accented character "Cézanne" that
-- AP's version of the same story uses (tokenizes to "cezanne" under
-- remove_diacritics). A search for "Cézanne" or "Cezanne" finds AP's item
-- and NOT PBS's -- not a search bug, but a pre-existing, un-decoded-entity
-- defect in what was stored, now visible through search. See
-- tests/search/query.test.ts.
--
-- ---------------------------------------------------------------------------
-- External-content vs. own copy: own copy, deliberately
-- ---------------------------------------------------------------------------
-- items is append-only (0001_init.sql): a correction, re-score, or
-- re-delivery (cisa-kev re-dumping its full catalog on a poll that only
-- added one new CVE elsewhere) writes a NEW item_id row under the SAME
-- item_key. An external-content FTS5 index built over items (content=items,
-- content_rowid=items.rowid, the standard FTS5-over-an-existing-table
-- pattern) would therefore gain one searchable row per VERSION, not per
-- item: a story re-fetched three times unchanged would surface three
-- identical hits, and a corrected headline would leave the stale wording
-- permanently co-searchable alongside the correction. Neither is what a
-- search feature should do.
--
-- items_fts is its own copy, holding at most one row per item_key at any
-- moment -- see "Hit granularity" below for why item_key, not item_id. It is
-- kept in sync by triggers rather than tied to items' rowid, and it is
-- REPLACED (delete + reinsert), not appended, on every new version --
-- see the sync trigger below. items itself is completely untouched:
-- the historical record of every version stays exactly where it always
-- was; this index only ever answers "what does the CURRENT version of each
-- item say", which is why it is allowed to be mutable (like item_state,
-- 0001_init.sql, and unlike items/item_scores/item_clusters) even though it
-- is derived from an append-only table.
--
-- ---------------------------------------------------------------------------
-- Hit granularity: item (item_key), not version (item_id)
-- ---------------------------------------------------------------------------
-- Decided before writing a line of the schema below: a search hit is an
-- ITEM, identified by item_key, not a version. Concretely: the Mangione
-- guilty-plea story appears in the M2 acceptance corpus from two sources --
-- ap-news and pbs-newshour -- each its own item_key (they are genuinely
-- different articles at different canonical URLs, not two versions of one
-- item), so a search for "Mangione" is EXPECTED and CORRECT to return two
-- hits, one per source. What must NOT happen is a single item_key
-- surfacing more than once because it was corrected, rescored, or
-- re-delivered -- that would be the same story shown twice for a reason
-- the user has no way to understand. item_key is therefore the identity a
-- hit is keyed on, and item_id/fetched_at/published_at for display are
-- resolved from the CURRENT version at read time (src/search/query.ts calls
-- the same getCurrentItem primitive item.ts already exports), not stored
-- redundantly here.
--
-- ---------------------------------------------------------------------------
-- Sync strategy: AFTER INSERT triggers, replace not append
-- ---------------------------------------------------------------------------
-- items has BEFORE UPDATE / BEFORE DELETE triggers that raise(ABORT)
-- (0001_init.sql) -- INSERT is the only reachable write. AFTER INSERT
-- triggers on items therefore see every new version, with no other entry
-- point to miss. Implemented as TWO mutually-exclusive triggers (defined
-- below, after the backfill) rather than one -- see "Cost measured
-- directly" just below for why -- but the behavioural contract is the same
-- either way: on a brand-new item_key, items_fts gains one row; on a
-- REVISION of an already-seen item_key, the prior items_fts row for that
-- item_key is deleted and replaced by one freshly derived from the current
-- version (order by fetched_at desc, rowid desc limit 1 -- the same
-- tie-break getCurrentItem uses, not merely "trust NEW" -- items has no
-- uniqueness on (item_key, fetched_at) and no ordering guarantee that
-- insertion order matches fetched_at order for an out-of-order backfill;
-- item.ts's own comment: "two versions can legally share an instant").
--
-- This fires INSIDE insertItem's own transaction (src/domain/item.ts), so a
-- freshly ingested item is findable via searchItems the moment insertItem's
-- transaction commits -- no separate reindex step, no rebuild pass, no
-- delay. See tests/search/query.test.ts, "findable without a manual step".
-- The delete-then-reinsert on a revision also means a corrected version's
-- stale text stops being searchable the instant the correction is ingested
-- (proven in the same test file, "a corrected version replaces the old
-- text rather than accumulating a duplicate hit", and the accompanying
-- "STALENESS CATCH" test, which was run RED against a deliberately
-- reintroduced insert-only trigger to confirm it actually fails without
-- the delete -- the concrete case a rebuild-only sync strategy could
-- silently get wrong: forget to run the rebuild and the old, now-wrong
-- text stays live and searchable indefinitely).
--
-- Cost measured directly (see task-2-report.md): first cut of this trigger
-- was a single unconditional `delete ... where item_key = ?` followed by
-- re-insert, and measured against a synthetic 4,135-row insert loop, it
-- added 4.27x total insert time (2.46s of the 3.21s run) -- because
-- item_key is UNINDEXED in items_fts (FTS5 gives no secondary index on an
-- unindexed column), that DELETE is a full scan of items_fts's *current*
-- size on EVERY insert, so total cost across a growing corpus is O(n^2),
-- not O(n). Isolated measurement confirmed the DELETE alone, not the
-- INSERT, is the cost: a bare INSERT into items_fts averaged 0.0136ms;
-- a DELETE that scans ~4,135 rows and finds nothing averaged 0.57ms --
-- essentially the entire per-item overhead.
--
-- Split into two mutually-exclusive triggers below, gated by `WHEN`, to
-- pay that DELETE cost ONLY on an actual re-version -- which the real M2
-- acceptance corpus shows is rare (4,134 of 4,135 item_keys in data/wf.db
-- have exactly one version). Both triggers ask "how many versions of this
-- item_key exist now, including the row just inserted" via
-- `count(*) from items where item_key = new.item_key`, answered entirely
-- by the existing `items_key_fetched (item_key, fetched_at desc)` index
-- (0001_init.sql) -- no new index needed, and no table scan of `items`
-- either. Remeasured with this split: total overhead for the same
-- 4,135-item synthetic run dropped from 2.46s to effectively the cost of
-- 4,135 plain inserts (task-2-report.md has the exact numbers) -- the
-- common "brand-new item_key" path never touches the DELETE branch at
-- all.
create virtual table items_fts using fts5(
  item_key unindexed,
  title,
  summary_raw,
  author,
  source_id,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Backfill: this migration can run against a database that already has rows
-- in items (data/wf.db's 4,135-item M2 acceptance corpus, most concretely).
-- The trigger below only sees INSERTs from this point forward, so without
-- this backfill every item ingested before 0005 was applied would be
-- permanently unfindable until it happened to get a new version -- silently
-- wrong, and exactly the kind of gap this migration exists to close. Same
-- "current version" derivation as the trigger (order by fetched_at desc,
-- rowid desc), applied once, at migration time, per item_key.
insert into items_fts (item_key, title, summary_raw, author, source_id)
select i.item_key, i.title, i.summary_raw, i.author, i.source_id
from items i
where i.rowid = (
  select i2.rowid
  from items i2
  where i2.item_key = i.item_key
  order by i2.fetched_at desc, i2.rowid desc
  limit 1
);

-- Common case: NEW.item_key has never been seen before (this insert makes
-- it the first version). count(*) = 1 because the just-inserted row itself
-- counts, and the count is answered by the items_key_fetched index alone
-- (item_key, fetched_at desc -- 0001_init.sql), never a table scan of
-- `items`. Nothing can exist in items_fts for an item_key with no prior
-- version, so no DELETE is needed -- this path is a single, plain,
-- cheap INSERT of NEW's own values directly (NEW is trivially "the current
-- version" when it's the ONLY version).
create trigger items_fts_sync_new_item after insert on items
when (select count(*) from items where item_key = new.item_key) = 1
begin
  insert into items_fts (item_key, title, summary_raw, author, source_id)
  values (new.item_key, new.title, new.summary_raw, new.author, new.source_id);
end;

-- Rare case: this insert is a SECOND OR LATER version of item_key (a
-- correction, re-score-triggering re-delivery, or genuine update) -- the
-- only case where a stale items_fts row can already exist and must be
-- replaced rather than left to accumulate. Re-derives "the current version"
-- the same way getCurrentItem does (order by fetched_at desc, rowid desc
-- limit 1) rather than trusting NEW to already be it, because items has no
-- uniqueness on (item_key, fetched_at) and no guarantee that insertion
-- order matches fetched_at order for an out-of-order backfill (item.ts's
-- own comment: "two versions can legally share an instant"). This is the
-- one branch that pays items_fts's unindexed-item_key DELETE scan -- see
-- the "Cost measured directly" note above for why that is acceptable: it
-- is the rare path, not the common one.
create trigger items_fts_sync_revision after insert on items
when (select count(*) from items where item_key = new.item_key) > 1
begin
  delete from items_fts where item_key = new.item_key;
  insert into items_fts (item_key, title, summary_raw, author, source_id)
  select item_key, title, summary_raw, author, source_id
  from items
  where item_key = new.item_key
  order by fetched_at desc, rowid desc
  limit 1;
end;

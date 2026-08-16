-- The entity-extraction ledger (M5 task 16, src/entities/sweep.ts).
--
-- ===========================================================================
-- 1. WHAT THIS TABLE IS FOR, AND WHY item_entities CANNOT ANSWER IT
-- ===========================================================================
-- `item_entities` (0001) stores WHICH entities an item carries. It cannot
-- store whether an item has been LOOKED AT, because the two states are the
-- same shape: an item scanned and found to carry nothing has zero rows, and so
-- does an item nobody has scanned. `src/domain/itemEntities.ts` says as much
-- in its own doc comment -- `[]` is deliberately the answer to both, so no
-- caller needs a null check.
--
-- That ambiguity is what let the gap this migration closes survive three
-- milestones. `select count(*) from item_entities` returned 0 across 7,267
-- live items; nothing in the system could tell "no extractor exists" from
-- "nothing matched", and so nothing reported it. This table makes the
-- difference a stored fact.
--
-- ===========================================================================
-- 2. THE RULESET VERSION IS THE OTHER HALF, AND THE MORE IMPORTANT ONE
-- ===========================================================================
-- Entities come from `config/entities.yaml`, which is meant to be edited --
-- adding a vendor is a config change, never a code change. Without a version
-- in the key, a term added to that file would apply ONLY to items ingested
-- afterwards, and the corpus already stored would keep whatever the rules said
-- the day it arrived. That failure is silent, permanent, and looks exactly
-- like success.
--
-- `ruleset_version` is a content digest of the loaded rules
-- (src/entities/rules.ts `rulesetVersion`), never a hand-maintained number --
-- the same reasoning db/migrations checksums its own files with: a version
-- someone must remember to bump is a version that is eventually wrong while
-- looking right. Editing the config changes the digest, which empties the
-- sweep's "already done" set, which re-extracts the whole corpus over the next
-- few polls.
--
-- ===========================================================================
-- 3. STORAGE STANCE: A LEDGER, LIKE 0009's llm_call_log
-- ===========================================================================
-- 0009 established that this schema takes two stances and says which applies
-- where. This is the LEDGER stance: a row records that a specific extraction
-- happened, and that never stops being true. It is keyed on
-- (item_id, ruleset_version) rather than item_id alone, so re-extracting the
-- same item under NEW rules appends a second row instead of overwriting the
-- first -- the history of what this system believed, and when, stays readable.
--
-- Both UPDATE and DELETE are refused. DELETE per CLAUDE.md's never-delete
-- rule; UPDATE because there is nothing in a row that can legitimately change:
-- the pair (item, ruleset) fixes the answer, so a differing result would mean
-- the extractor stopped being pure, which is a bug to find rather than a value
-- to overwrite.
--
-- ===========================================================================
-- 4. WHY BACKFILLING DOES NOT VIOLATE APPEND-ONLY
-- ===========================================================================
-- `items` is append-only, trigger-enforced (0001), so the 7,267 stored item
-- versions cannot be changed and none of them is. `item_entities` is a
-- SEPARATE table with a foreign key to `items` and NO append-only triggers of
-- its own -- writing an entity row for an existing `item_id` adds a fact about
-- that version without rewriting the version, exactly as `item_scores` does
-- for a re-score and `item_clusters` does for a re-clustering. Verified
-- against the real schema rather than assumed.
--
-- ===========================================================================
-- 5. `entity_count` IS DENORMALISED, DELIBERATELY
-- ===========================================================================
-- It is derivable by counting item_entities rows, but only for the CURRENT
-- ruleset: once a later ruleset adds rows for the same item_id, the count of
-- what the earlier ruleset found is unrecoverable, because item_entities has
-- no version column and must not grow one (an entity is a fact about the item,
-- not about the rules that noticed it). Storing the count here is what makes
-- "ruleset abcd found 2 entities for this item, ruleset efgh found 5"
-- answerable at all.

create table item_entity_extractions (
  item_id         text not null references items (item_id),
  ruleset_version text not null,
  extracted_at    text not null,
  entity_count    integer not null check (entity_count >= 0),
  primary key (item_id, ruleset_version)
);

-- The sweep's hot query is "items with no row at THIS version", and its
-- reporting query is "how far has this version got". Both key on
-- ruleset_version first; the primary key's index leads with item_id and cannot
-- serve either.
create index item_entity_extractions_version
  on item_entity_extractions (ruleset_version, item_id);

-- Canonical UTC timestamp, enforced on the only reachable write path. Same
-- mechanism and same glob as 0002's items_fetched_at_format, and for the same
-- reason: every as-of read compares these lexicographically, so a
-- non-canonical value breaks ordering silently instead of failing loudly.
create trigger item_entity_extractions_extracted_at_format
before insert on item_entity_extractions
when new.extracted_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'item_entity_extractions.extracted_at must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

create trigger item_entity_extractions_no_update before update on item_entity_extractions
begin select raise(ABORT, 'item_entity_extractions is a ledger: (item_id, ruleset_version) fixes the answer'); end;

create trigger item_entity_extractions_no_delete before delete on item_entity_extractions
begin select raise(ABORT, 'item_entity_extractions is append-only'); end;

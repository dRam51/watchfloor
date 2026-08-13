-- Push two invariants that only application code enforced down into the
-- storage layer: the beat vocabulary, and canonical UTC timestamp format.
--
-- Why it matters: items, item_beats and item_scores are append-only (BEFORE
-- UPDATE / BEFORE DELETE triggers from 0001_init). A row written by anything
-- that bypasses src/domain/item.ts -- the sqlite3 CLI, a repair script, a
-- future writer that forgets -- with beat = 'sports' or
-- fetched_at = 'not-a-timestamp' is therefore *permanently uncorrectable*.
-- Timestamps are compared lexicographically by every as_of read, so a
-- non-canonical value silently breaks point-in-time ordering rather than
-- failing loudly.
--
-- Two different mechanisms are used below, for a measured reason.
--
-- item_beats / item_scores get real CHECK constraints via the documented
-- table-rebuild procedure. Both are FK *children* with no dependants of their
-- own, so dropping them inside the runner's transaction is safe (verified).
--
-- items gets BEFORE INSERT triggers instead of CHECK constraints. The rebuild
-- procedure cannot be applied to items inside the runner's transaction:
--   * step 1 of the procedure is `PRAGMA foreign_keys = OFF`, which SQLite
--     documents -- and this schema was measured to confirm -- as a silent
--     no-op inside a transaction, and the runner wraps every migration in one;
--   * `PRAGMA defer_foreign_keys = ON` does *not* substitute: `DROP TABLE
--     items` still fails "FOREIGN KEY constraint failed" while any row exists
--     in item_beats / item_entities / item_scores / item_locations;
--   * the only sequence that would work rebuilds all four child tables purely
--     to re-point their REFERENCES clauses -- rewriting every foreign-key
--     relationship in the schema to add two format checks.
-- Because items is append-only, INSERT is the *only* reachable way a value
-- can enter fetched_at or published_at (UPDATE is already blocked by
-- items_no_update, DELETE by items_no_delete). A BEFORE INSERT trigger
-- therefore covers exactly the same surface a CHECK would, with none of the
-- rebuild's blast radius. See docs/layout.md.

-- ---------------------------------------------------------------------------
-- items: canonical timestamp format, enforced on the only reachable write path
-- ---------------------------------------------------------------------------

create trigger items_fetched_at_format before insert on items
when new.fetched_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'items.fetched_at must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

create trigger items_published_at_format before insert on items
when new.published_at is not null
 and new.published_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'items.published_at must be NULL or a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

-- ---------------------------------------------------------------------------
-- item_beats: beat vocabulary. Rebuilt because SQLite has no ADD CONSTRAINT.
-- The six values are the BEATS tuple in src/domain/item.ts; they must agree.
-- ---------------------------------------------------------------------------

create table item_beats_0002 (
  item_id text not null references items (item_id),
  beat    text not null check (beat in ('ai', 'cyber', 'aisec', 'repos', 'markets', 'usnews')),
  primary key (item_id, beat)
);

insert into item_beats_0002 (item_id, beat) select item_id, beat from item_beats;

-- Refuse to drop the original until the copy is provably complete: a non-zero
-- delta fails the CHECK, which fails the statement, which fails the migration.
create table item_beats_0002_guard (delta integer not null check (delta = 0));
insert into item_beats_0002_guard (delta)
  select (select count(*) from item_beats) - (select count(*) from item_beats_0002);
drop table item_beats_0002_guard;

drop table item_beats;
alter table item_beats_0002 rename to item_beats;

-- ---------------------------------------------------------------------------
-- item_scores: same treatment. Its index and append-only triggers go with the
-- dropped table and are recreated verbatim from 0001_init below.
-- ---------------------------------------------------------------------------

create table item_scores_0002 (
  score_id       text primary key,
  item_id        text not null references items (item_id),
  beat           text not null check (beat in ('ai', 'cyber', 'aisec', 'repos', 'markets', 'usnews')),
  signal_score   real not null,
  read_score     real not null,
  scorer_version text not null,
  computed_at    text not null
);

insert into item_scores_0002 (score_id, item_id, beat, signal_score, read_score, scorer_version, computed_at)
  select score_id, item_id, beat, signal_score, read_score, scorer_version, computed_at from item_scores;

create table item_scores_0002_guard (delta integer not null check (delta = 0));
insert into item_scores_0002_guard (delta)
  select (select count(*) from item_scores) - (select count(*) from item_scores_0002);
drop table item_scores_0002_guard;

drop table item_scores;
alter table item_scores_0002 rename to item_scores;

create index item_scores_lookup on item_scores (item_id, beat, computed_at desc);

create trigger item_scores_no_update before update on item_scores
begin select raise(ABORT, 'item_scores is append-only'); end;
create trigger item_scores_no_delete before delete on item_scores
begin select raise(ABORT, 'item_scores is append-only'); end;

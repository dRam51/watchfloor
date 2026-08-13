-- Per-source fetch state (M1 ingest, task 1).
--
-- Unlike items / item_scores / item_clusters (0001_init.sql), this table is
-- MUTABLE, OPERATIONAL state, not history: the scheduler updates a source's
-- one row in place on every poll. It deliberately carries no raise(ABORT)
-- append-only triggers and no items_no_update-style protection -- adding
-- those would make it impossible to ever record a second fetch for a source,
-- defeating the table's purpose. See src/db/fetchState.ts.
--
-- One row per source_id, brought into existence on that source's first
-- recorded fetch (success or failure) via upsert -- there is no separate
-- "register a source" step, and no foreign key to a `sources` table, because
-- source definitions live in config/sources.yaml (src/sources/load.ts), not
-- in this database.
create table source_fetch_state (
  source_id                          text primary key,

  -- Conditional-request validators (the polite HTTP layer, src/fetch/http.ts,
  -- a sibling task). Carried forward through failures: a failed attempt
  -- doesn't invalidate the last known-good validators, so the next successful
  -- attempt can still send If-None-Match / If-Modified-Since.
  etag                                text,
  last_modified                       text,

  -- Canonical UTC timestamps only (YYYY-MM-DDTHH:mm:ss.sssZ), enforced at the
  -- application layer by src/domain/item.ts's assertCanonicalTimestamp,
  -- exactly as items.fetched_at is. Comparisons against next_eligible_at rely
  -- on that fixed-width shape sorting lexicographically the same as
  -- chronologically.
  last_success_at                    text,
  last_failure_at                    text,
  last_error                         text,

  -- Backoff bookkeeping. consecutive_failures resets to 0 on any success;
  -- next_eligible_at is null whenever no backoff is in effect (the source has
  -- never failed, or its most recent attempt succeeded). See
  -- src/db/fetchState.ts recordFailure for the doubling-with-cap arithmetic.
  consecutive_failures                integer not null default 0,
  next_eligible_at                    text,

  -- Rolling ~7-day yield, maintained here so the source-health page can read
  -- one row instead of scanning `items` by source_id and fetched_at for every
  -- source on every page load. This is a tumbling window, not a true sliding
  -- one: the count resets to the latest fetch's item count once more than 7
  -- days have passed since items_yielded_7d_window_started_at, and
  -- accumulates otherwise. See src/db/fetchState.ts recordSuccess.
  items_yielded_7d                   integer not null default 0,
  items_yielded_7d_window_started_at text,

  updated_at                          text not null
);

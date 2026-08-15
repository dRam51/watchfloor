-- The enrichment cache and the LLM call ledger (M5 task 3,
-- src/db/llmCache.ts and src/db/llmCallLog.ts).
--
-- Brief §5 caps daily tokens; §15 requires the paid backend to sit behind its
-- flag "in addition to the daily token ceiling and cost logging". The M5 plan
-- adds the reason the cache exists at all: "Enrichment is re-run constantly
-- over an append-only corpus, so the cache is what keeps cost near zero even
-- with the flag on."
--
-- ===========================================================================
-- 0. THIS MIGRATION TAKES BOTH STORAGE STANCES, IN TWO TABLES, DELIBERATELY
-- ===========================================================================
-- 0007 departed from append-only because it stores a SERIES feeding a rate
-- whose denominator is a row count. 0008 departed because it stores a CURRENT
-- FACT that nothing counts. Those are different arguments, and this migration
-- needs one of each -- so rather than force one stance on both tables, it
-- states which applies where:
--
--   llm_enrichment_cache  is a CURRENT FACT, one row per question, upserted.
--                         It is 0008's argument, and section 2 works through
--                         why the reflex to make it append-only is wrong.
--   llm_call_log          is a LEDGER, one row per call, append-only and
--                         immutable. It is items / item_scores /
--                         interest_dismissal_signals' argument (0001, 0004),
--                         and section 4 works through why it may NOT be
--                         collapsed the way 0007 collapses a snapshot day.
--
-- Both refuse DELETE outright, per CLAUDE.md's never-delete rule.
--
-- ===========================================================================
-- 1. THE CACHE KEY IS CONTENT, AND item_key IS NOT PART OF IT
-- ===========================================================================
-- The reasoning in full is in src/enrich/cacheKey.ts; the part that shapes
-- THIS schema is why `item_key` is a plain nullable column here rather than
-- the primary key it is everywhere else in the system.
--
-- `item_key` = sha256(canonical_url) identifies a URL, not what is at it, and
-- `items` is append-only precisely because what is at a URL changes. A
-- `VACUUM INTO` copy of the live corpus (2026-08-15; 5,937 keys, 7,267 stored
-- versions) has TEN keys whose versions differ in title or summary, all of
-- them US-news headlines that moved under a URL that did not:
--
--   "Survivors face the challenge of rebuilding after Colombia quake"
--     -> "Signs of life emerge under Colombia quake rubble"
--   "Army identifies 2 Fort Hood helicopter pilots killed in crash"
--     -> "Army pauses Apache helicopter training missions after crash"
--   "Wall Street holds near its record ..."
--     -> "Wall Street slips back from its record ..."
--
-- An item_key-keyed row answers every one of those with the FIRST version's
-- summary, forever, and reports nothing. So the primary key is the hash of
-- the question actually asked, and item_key rides along as provenance.
--
-- Because several items can share one question (syndicated copy, a
-- cross-listed abstract), item_key is the FIRST item that produced the
-- answer, and the trigger below refuses to rewrite it: a later copy may fill
-- it in when it was null, never restate it. That is the same "an answer is
-- never lost" stance 0008 takes.
--
-- ===========================================================================
-- 2. THE CACHE IS UPSERTED PER QUESTION, AND KEEPING EVERY ANSWER IS WRONG
-- ===========================================================================
-- The reflex is append-only: an LLM completion is an OBSERVATION, and
-- observations are history. Two reasons that is wrong here, and neither is
-- 0007's reason:
--
--   * The key already encodes the entire question, so a second row under one
--     key is by construction a second answer to an IDENTICAL prompt from an
--     IDENTICAL model. There is no query anyone has for which of two answers
--     to a question with one right answer was produced first. Nothing counts
--     these rows and nothing computes a rate over them.
--   * A cache is read on the hot path of every enrichment pass. Under
--     append-only the read becomes "the newest row per key", which is the
--     shape that produced M2's worst bug (getClusterSizeAsOf) -- a
--     latest-version read that returns a plausible wrong answer.
--
-- What a later answer IS allowed to do is supersede an earlier one, because a
-- newer answer to the same question from the same model is the better one
-- (a bug fixed in the daemon, a repointed floating tag). What it may NOT do
-- is restate the past: answered_at only moves forward, first_answered_at is
-- immutable, and the row can never be removed.
--
-- Also immutable: task, backend and model. All three are INPUTS to the cache
-- key, so a row whose task changed is a row the key no longer describes.
-- resolved_model is deliberately NOT immutable -- it is the only place a
-- repointed floating model tag becomes visible, and freezing it would hide
-- the one staleness hole content keying does not close.
--
-- ===========================================================================
-- 3. AN EMPTY ANSWER IS AN ANSWER, AND THE COLUMN IS NOT NULL
-- ===========================================================================
-- src/enrich/llm/types.ts is built around one distinction: `''` on the ok
-- branch means "the model had nothing to say", and can never mean "we could
-- not ask". This table inherits that. answer_text is `not null` with no
-- minimum length, so an empty completion is stored and HITS -- re-asking a
-- question the model already answered with silence would spend a call per
-- pass forever, which is exactly what the cache exists to stop.
--
-- Correspondingly, an UNAVAILABLE result is never written here at all. There
-- is no row shape for it, deliberately: caching "Ollama was not running for
-- five minutes" would turn a transient outage into a permanent stored
-- non-answer. Failures go to llm_call_log, which has a status column for them.
--
-- ===========================================================================
-- 4. THE LEDGER IS APPEND-ONLY, AND MAY NOT BE COLLAPSED PER DAY
-- ===========================================================================
-- 0007 collapses many readings of one day into one row because the later
-- reading is a better answer to the same question. The opposite is true here:
-- two calls on one day are two DIFFERENT events that both consumed tokens and
-- both cost money, and the numbers this table exists to produce -- §5's daily
-- token total and §7's "today's enrichment spend" -- are SUMS over them.
-- Collapsing would not lose precision, it would lose money.
--
-- So: no UPDATE, no DELETE, one row per call, and the coherence CHECKs below
-- rather than a repair path.
--
-- ===========================================================================
-- 5. THE LEDGER MIRRORS LlmUsage / LlmCost EXACTLY, INCLUDING THEIR UNKNOWNS
-- ===========================================================================
-- Every backend reports usage and a cost figure "even when that figure is a
-- hard zero" (src/enrich/llm/types.ts), and both types keep "the backend did
-- not say" distinct from zero. Storing them any other way would launder an
-- unknown into a measurement at the point it enters the database:
--
--   input_tokens / output_tokens   null when the backend did not report them.
--   total_tokens                   null unless BOTH halves are real -- never
--                                  a partial total, which is makeUsage's own
--                                  rule, made unrepresentable here.
--   tokens_counted                 LlmUsage.counted. Denormalized on purpose:
--                                  it is the flag a cap must check, and §5's
--                                  ceiling reads it as a plain predicate
--                                  rather than reassembling it from two
--                                  nullable columns on every pass.
--   amount_usd / cost_measured     LlmCost. `null` means UNKNOWN, never zero;
--                                  measured $0 (a free-forever backend) is
--                                  amount_usd = 0 with cost_measured = 1, and
--                                  the two are distinguishable in SQL.
--
-- WHAT THE CEILING DOES WITH AN UNMETERED CALL IS NOT DECIDED HERE. The row
-- records nulls, honestly; src/enrich/ceiling.ts charges such a call its
-- configured worst case. Putting that substitution in the row would make the
-- ledger claim a measurement it does not have.
--
-- ===========================================================================
-- 6. "DAILY" MEANS A CALENDAR DAY IN WF_TZ, AND THE ROW RECORDS WHICH ZONE
-- ===========================================================================
-- Identical to 0007 section 4, for an identical reason: a token ceiling's day
-- is a derived schedule quantity, and CLAUDE.md requires every such quantity
-- to come from the configured zone, never the host clock's. An
-- America/New_York operator's 20:00 call is already tomorrow in UTC, so a UTC
-- bucket would reset the ceiling in the middle of the operator's evening.
--
-- The zone is computed in JS (Intl.DateTimeFormat with an explicit timeZone,
-- src/db/repoSnapshots.ts's localDay) and passed in. Nothing in this file
-- calls date(), strftime(), 'now' or 'localtime' -- SQLite's date functions
-- know only UTC and 'localtime', and 'localtime' reads the HOST's zone.
--
-- `tz` is stored per row so a change to WF_TZ is DETECTABLE rather than
-- silently corrupting: getDailyLlmUsage surfaces a day whose rows disagree
-- instead of summing across the seam.

-- ---------------------------------------------------------------------------
-- llm_enrichment_cache: one row per question ever asked of a model
-- ---------------------------------------------------------------------------
create table llm_enrichment_cache (
  -- sha256 of the canonical encoding of the whole question
  -- (src/enrich/cacheKey.ts). Same shape as item_key, and never the same
  -- thing -- the glob is what stops a caller storing an item_key, a raw
  -- prompt, or a truncated digest here.
  cache_key         text primary key
                    check (cache_key glob '[0-9a-f]*'
                           and length(cache_key) = 64
                           and cache_key not glob '*[^0-9a-f]*'),

  -- What the answer is FOR ('summary', 'weekly_blurb'). An input to the key,
  -- stored so the row is legible and queryable without recomputing it.
  task              text not null check (length(task) > 0),

  -- Which backend answered, and the model as REQUESTED. Both are inputs to
  -- the key; see section 2 for why they are immutable.
  backend           text not null check (backend in ('ollama', 'anthropic')),
  model             text not null check (length(model) > 0),

  -- The model that ANSWERED, as the backend named it -- `llama3.2` resolves
  -- to `llama3.2:latest`. Mutable on purpose (section 2): a floating tag
  -- repointed by `ollama pull` is invisible in `model` and visible only here.
  resolved_model    text not null check (length(resolved_model) > 0),

  -- What the model said. May legitimately be empty; see section 3.
  answer_text       text not null,

  -- Why generation stopped. 'length' means a real, complete-as-far-as-it-goes
  -- answer, which a consumer may want to treat differently from a clean stop.
  finish            text not null check (finish in ('stop', 'length', 'other')),

  -- PROVENANCE ONLY -- never a lookup input, and never the identity. The
  -- FIRST item that produced this answer; see section 1.
  item_key          text,

  -- Canonical UTC instant the current answer was produced. Injected, never a
  -- clock read here.
  answered_at       text not null,

  -- When this question was FIRST answered. Immutable across every later
  -- refresh, so "how long have we had an answer to this" survives.
  first_answered_at text not null,

  -- A refresh cannot predate the original.
  check (first_answered_at <= answered_at)
);

-- "Everything ever enriched for this item" -- the provenance read. The
-- primary key (cache_key) cannot serve it, and it is the only read that
-- touches item_key at all.
create index llm_enrichment_cache_item_key on llm_enrichment_cache (item_key, answered_at);

create trigger llm_enrichment_cache_no_delete before delete on llm_enrichment_cache
begin
  select raise(ABORT, 'llm_enrichment_cache rows are never deleted: retire an answer by bumping cache.version in config/enrichment.yaml, which leaves the row on disk and unreachable');
end;

-- cache_key, task, backend and model are all INPUTS to the key. first_answered_at
-- is history. None may be restated. resolved_model is deliberately absent from
-- this list -- see section 2.
create trigger llm_enrichment_cache_identity_immutable before update on llm_enrichment_cache
when new.cache_key <> old.cache_key
  or new.task <> old.task
  or new.backend <> old.backend
  or new.model <> old.model
  or new.first_answered_at <> old.first_answered_at
begin
  select raise(ABORT, 'llm_enrichment_cache identity (cache_key, task, backend, model, first_answered_at) is immutable: a row may only be refreshed with a later answer to the same question');
end;

-- Strictly forward. The backstop against a replayed or out-of-order answer
-- clobbering a fresher one; the access layer filters the conflict update so it
-- does not normally reach this trigger.
create trigger llm_enrichment_cache_answered_at_monotonic before update on llm_enrichment_cache
when new.answered_at <= old.answered_at
begin
  select raise(ABORT, 'llm_enrichment_cache.answered_at may only move forward: refusing to overwrite an answer with an equal or older one');
end;

-- Provenance may be LEARNED (null -> a key) but never rewritten. A second item
-- that happens to ask the identical question does not get to overwrite the
-- record of which one asked it first.
create trigger llm_enrichment_cache_item_key_immutable before update on llm_enrichment_cache
when old.item_key is not null and new.item_key is not old.item_key
begin
  select raise(ABORT, 'llm_enrichment_cache.item_key is immutable once set: it records the FIRST item that produced this answer');
end;

-- Same canonical-timestamp shape items.fetched_at (0002), 0007 and 0008 are
-- held to, and for the same reason: these values are compared
-- lexicographically, which only matches chronological order at a fixed width.
-- INSERT and UPDATE both covered -- this table is not append-only.
create trigger llm_enrichment_cache_format_insert before insert on llm_enrichment_cache
when new.answered_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  or new.first_answered_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'llm_enrichment_cache timestamps must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

create trigger llm_enrichment_cache_format_update before update on llm_enrichment_cache
when new.answered_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'llm_enrichment_cache.answered_at must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

-- ---------------------------------------------------------------------------
-- llm_call_log: one immutable row per call that reached a backend
-- ---------------------------------------------------------------------------
create table llm_call_log (
  call_id            text primary key,

  -- YYYY-MM-DD in `tz`. The ceiling's bucket and §7's "today". Section 6.
  usage_day          text not null,
  tz                 text not null check (length(tz) > 0),

  -- Canonical UTC instant of the call -- the injected `now`, never a clock
  -- read. Kept alongside the day bucket because the two answer different
  -- questions, exactly as 0007 keeps observed_at beside snapshot_day.
  called_at          text not null,

  backend            text not null check (backend in ('ollama', 'anthropic')),
  -- The model as REQUESTED, matching the cache key's input.
  model              text not null check (length(model) > 0),
  -- The docs/costs.md / src/cost/registry.ts row this spend belongs to.
  service_id         text not null check (length(service_id) > 0),
  task               text not null check (length(task) > 0),
  -- The question this call was answering. No FOREIGN KEY: a call that came
  -- back unavailable writes no cache row at all, and this table must record
  -- it anyway. Same reasoning source_fetch_state (0003) gives.
  cache_key          text not null,

  status             text not null check (status in ('ok', 'unavailable')),
  -- LlmUnavailableReason. Null exactly when the call produced a completion.
  unavailable_reason text,

  -- Section 5: null means the backend did not report, never zero.
  input_tokens       integer check (input_tokens is null or input_tokens >= 0),
  output_tokens      integer check (output_tokens is null or output_tokens >= 0),
  total_tokens       integer check (total_tokens is null or total_tokens >= 0),
  tokens_counted     integer not null check (tokens_counted in (0, 1)),

  amount_usd         real check (amount_usd is null or amount_usd >= 0),
  cost_measured      integer not null check (cost_measured in (0, 1)),

  -- Wall time, from a monotonic counter in the backend -- not a difference of
  -- two clock reads.
  latency_ms         integer not null check (latency_ms >= 0),

  created_at         text not null,

  -- ------------------------------------------------------------------
  -- Coherence. Each makes one impossible pairing unrepresentable through ANY
  -- writer, not merely unlikely through this one.
  -- ------------------------------------------------------------------

  -- A reason belongs to a failure, and a failure always has one.
  check ((unavailable_reason is null) = (status = 'ok')),

  -- tokens_counted IS "both halves are real". Derived, and pinned so it can
  -- never drift from the columns it summarises.
  check (tokens_counted = (case when input_tokens is not null and output_tokens is not null then 1 else 0 end)),

  -- makeUsage's rule: a total exists exactly when both halves do.
  check ((total_tokens is null) = (tokens_counted = 0)),
  check (total_tokens is null or total_tokens = input_tokens + output_tokens),

  -- computeCost's rule: unmeasured means unknown, so there is no amount; and
  -- an amount is never present without the claim that it was measured.
  check ((amount_usd is null) = (cost_measured = 0))
);

-- The ceiling's and the header strip's read: everything that happened on one
-- day. The primary key cannot serve it.
create index llm_call_log_day on llm_call_log (usage_day, status);

create trigger llm_call_log_no_update before update on llm_call_log
begin
  select raise(ABORT, 'llm_call_log is append-only; a call is an event that happened, and correcting it by mutation defeats the point of logging it');
end;

create trigger llm_call_log_no_delete before delete on llm_call_log
begin
  select raise(ABORT, 'llm_call_log is append-only; a deleted call is spend and consumption that silently stops being reported');
end;

create trigger llm_call_log_format_insert before insert on llm_call_log
when new.called_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  or new.created_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  or new.usage_day not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
begin
  select raise(ABORT, 'llm_call_log: called_at/created_at must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ) and usage_day must be YYYY-MM-DD');
end;

-- usage_day must plausibly BE the local day of called_at. Without this a
-- caller can file today's call under an arbitrary date, which is a direct
-- attack on the ceiling's bucket and invisible afterwards because the row
-- looks entirely well-formed.
--
-- The bound is loose rather than exact, because the exact answer needs the tz
-- database and SQLite does not have it here. Real offsets span UTC-12:00 to
-- UTC+14:00, so the local date runs from one day behind the UTC date to one
-- ahead; rounded outward to (-1, +2) so no genuine zone is near the edge.
-- Identical to 0007's github_repo_star_snapshots_day_matches_instant, and
-- julianday() is used purely as arithmetic on two supplied values -- it is
-- never given 'now' or 'localtime'.
create trigger llm_call_log_day_matches_instant before insert on llm_call_log
when julianday(new.called_at) - julianday(new.usage_day) <= -1.0
  or julianday(new.called_at) - julianday(new.usage_day) >= 2.0
begin
  select raise(ABORT, 'llm_call_log.usage_day is not a plausible local day for called_at: no real timezone offset can span that gap');
end;

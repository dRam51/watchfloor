-- Daily GitHub star snapshots, so star VELOCITY is computable (M4a task 2,
-- src/db/repoSnapshots.ts).
--
-- Brief §4: "Rank by star velocity (stars gained per day over the trailing 7
-- days), not absolute stars. Store daily star snapshots so velocity is
-- computable -- a repo going 40->400 in a week matters more than one sitting
-- at 30k."
--
-- Everything below follows from three questions the M4a plan told this task
-- to answer deliberately rather than by habit. Each is answered here, in the
-- schema, mechanically -- not in a doc comment on the access layer that a
-- future writer bypassing it would never read.
--
-- ===========================================================================
-- 1. One row per repo per day, enforced by the PRIMARY KEY -- not append-only
-- ===========================================================================
-- items / item_scores / item_clusters (0001_init.sql) and
-- interest_dismissal_signals (0004) are append-only, and the reflex is to
-- make a star snapshot append-only too: it is an OBSERVATION, and observations
-- are history.
--
-- That reflex is wrong here, for a reason specific to what a snapshot is FOR.
-- The one number this table exists to feed is a rate: stars gained per DAY.
-- Under append-only storage, a day the scheduler happens to poll twice
-- deposits two rows for one day, and every consumer that counts rows to get
-- its denominator is then silently wrong -- a 7-day window with one
-- double-polled day looks like 8 days of history, and the velocity it
-- computes is quietly ~12% low. That is exactly the failure mode CLAUDE.md
-- records as M2's worst bug: not a crash, but a plausible wrong answer that
-- unit tests pass straight through.
--
-- `primary key (repo_id, snapshot_day)` makes the corrupt state
-- unrepresentable. A second observation on an already-recorded day cannot
-- become a second row, at any layer, through any writer -- the sqlite3 CLI, a
-- repair script, a future adapter that forgets. The denominator is therefore
-- correct by construction, and a consumer may count rows without knowing any
-- of this.
--
-- What is given up, and why it is not history worth keeping: a second reading
-- on the same day REPLACES the first (last-write-wins, subject to the
-- monotonicity trigger below). Both readings are answers to the same
-- question -- "what is this repo's star count on 2026-08-14" -- and the later
-- one is the better answer, because it is closer to the end of the day the
-- row represents. Nothing is lost that the trailing-7-day rate could use.
-- Intraday star movement is not a thing this system was asked to retain (§4
-- says DAILY snapshots), and retaining it would mean an unbounded row count
-- per repo per day for a number no consumer reads.
--
-- Crucially, only the CURRENT day's row is ever rewritten in practice, and
-- the triggers below make that structural rather than customary: an UPDATE
-- may not change repo_id, snapshot_day, or created_at, and may only move
-- observed_at FORWARD. A yesterday row can therefore never be silently
-- restated by a stale or replayed write, and a DELETE is refused outright --
-- CLAUDE.md's never-delete rule applies to rows here exactly as it does to
-- files. This table is mutable in the same narrow, deliberate way item_state
-- (0001_init.sql), source_fetch_state (0003) and lane_layout (0006) are, and
-- for the same kind of reason: it holds a current reading, not a ledger.
--
-- ===========================================================================
-- 2. Identity is GitHub's numeric repo id, NOT owner/name and NOT item_key
-- ===========================================================================
-- The rest of the system keys on item_key = sha256(canonical_url)
-- (src/domain/item.ts). A snapshot row must NOT, and this is the whole reason
-- github_repo_names below exists.
--
-- GitHub repos get renamed and transferred between owners, and github.com
-- redirects the old path to the new one. Under an owner/name identity -- or
-- any hash of a URL built from it, which is what item_key is -- a rename
-- produces a NEW key, and with it:
--
--   * a fresh velocity history starting at zero days, for a repo that has
--     been watched for weeks. The lane would report "insufficient history"
--     for a repo it has full history for.
--   * TWO keys accumulating history for ONE repo, if both the old redirecting
--     path and the new one are ever observed -- double-counted stars split
--     across two partial series, neither of them right.
--
-- GitHub's numeric repository id is documented as stable across both renames
-- and transfers; the redirect exists precisely BECAUSE the underlying id did
-- not change. So `repo_id integer` is the identity here, and both failure
-- modes above are closed by construction: a rename keeps writing to the same
-- series, and two names resolve to one id.
--
-- github_repo_names is the map back to the rest of the system: one row per
-- (repo_id, item_key) EVER observed, never overwritten by a later name. It is
-- what lets a consumer holding only an item_key -- which is all `items`,
-- `item_state`, and every scorer ever have -- find the velocity history, and
-- it makes a rename a visible, queryable fact (two rows, one repo_id) rather
-- than an invisible discontinuity.
--
-- Note the mapping is many-to-many over time, and deliberately not
-- constrained to anything narrower: one repo_id has several item_keys after a
-- rename, AND one item_key can point at several repo_ids, because GitHub
-- frees a deleted repo's path for reuse by an unrelated repo. Resolution
-- picks the most recently seen pairing (src/db/repoSnapshots.ts,
-- resolveRepoId); the older pairings stay on disk rather than being
-- rewritten, so the ambiguity is inspectable instead of erased.
--
-- There is no FOREIGN KEY between these two tables, matching the precedent
-- source_fetch_state (0003) set for the same reason: neither is the other's
-- lifecycle parent, repo_id is deliberately non-unique in github_repo_names
-- (it is half of a compound key), and a snapshot whose name row is missing is
-- an incomplete write, not a corrupt one.
--
-- ===========================================================================
-- 3. A missed day is a MISSING ROW, never a zero and never an interpolation
-- ===========================================================================
-- The scheduler will be down sometimes; the M4a plan is explicit that a gappy
-- window is the case that will actually occur. This schema therefore stores
-- nothing at all for an unobserved day. Absence IS the signal, and it is the
-- only representation that a consumer cannot mistake for something else:
--
--   * a gap-filled zero would read as "this repo gained no stars that day" --
--     indistinguishable from a genuinely flat repo, which is precisely the
--     distinction §4's ranking depends on.
--   * an interpolated value would be a fact this system never observed,
--     written into a table whose entire purpose is to record what it did
--     observe.
--
-- getSnapshotWindow (src/db/repoSnapshots.ts) reports the gap explicitly --
-- expectedDays vs observedDays plus the missing dates themselves -- so task
-- 5 can tell "flat" from "we were not looking" without inferring it from a
-- row count.
--
-- ===========================================================================
-- 4. "Daily" means a calendar day in WF_TZ, and the row records which zone
-- ===========================================================================
-- snapshot_day is a YYYY-MM-DD calendar date in the operator's configured
-- zone (WF_TZ, src/config/env.ts) -- never UTC, and never the host clock's
-- zone, per CLAUDE.md's "TZ set explicitly in config and every schedule
-- derived from it". A snapshot day IS a derived schedule quantity.
--
-- Bucketing by UTC instead would break the very invariant section 1 above
-- exists to protect. An America/New_York operator's 20:00 poll is already
-- TOMORROW in UTC, so a 20:00 and a 21:00 poll on one local evening would
-- land in one UTC day -- but a 19:00 and a 20:00 poll would straddle two,
-- turning a single local day into two days of denominator. The zone that
-- decides the boundary has to be the same one the schedule and the dashboard
-- use.
--
-- The zone is computed in JS (Intl.DateTimeFormat with an explicit timeZone)
-- and passed in, never computed here: SQLite's own date functions know only
-- UTC and 'localtime', and 'localtime' reads the HOST's zone -- the exact
-- thing the portability rule forbids. Nothing in this file calls date(),
-- strftime(), or 'now'.
--
-- `tz` is stored on every row so a later change to WF_TZ is DETECTABLE rather
-- than silently corrupting: days recorded before and after the change have
-- different boundaries, and getSnapshotWindow surfaces a window whose rows
-- disagree instead of averaging across the seam.

-- ---------------------------------------------------------------------------
-- github_repo_names: every (repo_id, item_key) pairing ever observed
-- ---------------------------------------------------------------------------
create table github_repo_names (
  -- GitHub's immutable numeric repository id. The identity, per section 2.
  repo_id       integer not null,
  -- sha256 of the canonical URL for full_name, as src/domain/item.ts derives
  -- it. Stored, not recomputed here, because canonicalization lives in code
  -- (src/normalize/) and this schema must not carry a second copy of it.
  item_key      text not null,
  -- owner/name as observed. Display text; item_key is what identifies it.
  full_name     text not null,
  first_seen_at text not null,
  last_seen_at  text not null,
  primary key (repo_id, item_key)
);

-- The resolution path: item_key -> repo_id, most recently seen pairing first.
create index github_repo_names_item_key on github_repo_names (item_key, last_seen_at desc);

create trigger github_repo_names_no_delete before delete on github_repo_names
begin
  select raise(ABORT, 'github_repo_names rows are never deleted: a name a repo once had is what keeps its velocity history reachable after a rename');
end;

-- Identity columns are immutable. full_name is deliberately NOT in this list:
-- URL canonicalization may fold case, so two spellings of one path can share
-- an item_key, and refreshing the display text must not abort an ingest.
create trigger github_repo_names_identity_immutable before update on github_repo_names
when new.repo_id <> old.repo_id
  or new.item_key <> old.item_key
  or new.first_seen_at <> old.first_seen_at
begin
  select raise(ABORT, 'github_repo_names identity (repo_id, item_key, first_seen_at) is immutable: record a new pairing instead of restating an existing one');
end;

-- last_seen_at only ever advances. A replayed or out-of-order write must not
-- make a pairing look staler than it is -- resolveRepoId breaks ties on it.
create trigger github_repo_names_last_seen_monotonic before update on github_repo_names
when new.last_seen_at < old.last_seen_at
begin
  select raise(ABORT, 'github_repo_names.last_seen_at may only move forward');
end;

-- Same canonical-timestamp shape items.fetched_at is held to (0002), and for
-- the same reason: these values are compared lexicographically, which only
-- matches chronological order at a fixed width. INSERT and UPDATE are both
-- covered -- unlike items, this table is not append-only, so INSERT is not
-- the only reachable write path.
create trigger github_repo_names_timestamp_format_insert before insert on github_repo_names
when new.first_seen_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  or new.last_seen_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'github_repo_names timestamps must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

create trigger github_repo_names_timestamp_format_update before update on github_repo_names
when new.last_seen_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'github_repo_names timestamps must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

-- ---------------------------------------------------------------------------
-- github_repo_star_snapshots: at most one star reading per repo per local day
-- ---------------------------------------------------------------------------
create table github_repo_star_snapshots (
  repo_id      integer not null,
  -- YYYY-MM-DD in `tz`. See section 4.
  snapshot_day text not null,
  -- A star count is a cardinality; it cannot be negative. Enforced here
  -- because a negative value would produce a NEGATIVE velocity, which the
  -- lane would render as an arrow pointing the wrong way rather than as an
  -- error.
  stars        integer not null check (stars >= 0),
  -- The exact instant the reading was taken, canonical UTC. Kept alongside
  -- the day bucket because the two answer different questions: snapshot_day
  -- is the denominator's unit, observed_at is what lets a consumer compute
  -- the ACTUAL elapsed time between the window's endpoints. Those diverge --
  -- a row captured at 01:00 and one captured seven days later at 23:00 are
  -- 7.9 days apart, not 7 -- and on a DST-shift day the local day itself is
  -- 23 or 25 hours long.
  observed_at  text not null,
  -- The zone snapshot_day was computed in. See section 4.
  tz           text not null,
  -- When this day's row was FIRST written. Immutable across the same-day
  -- overwrite, so "when did we start watching this day" survives it.
  created_at   text not null,
  -- The invariant of this whole migration: one row per repo per day.
  primary key (repo_id, snapshot_day)
);

-- "Every repo observed on day D" -- the cross-repo read, which the primary
-- key (repo_id first) cannot serve.
create index github_repo_star_snapshots_day on github_repo_star_snapshots (snapshot_day);

create trigger github_repo_star_snapshots_no_delete before delete on github_repo_star_snapshots
begin
  select raise(ABORT, 'github_repo_star_snapshots rows are never deleted: a deleted day is indistinguishable from a day the scheduler missed, and velocity depends on telling those apart');
end;

-- An UPDATE here is only ever meant to be "a fresher reading of the SAME day
-- for the SAME repo". Anything else -- restating which day or which repo a
-- row belongs to, or backdating when it was first written -- is refused.
create trigger github_repo_star_snapshots_identity_immutable before update on github_repo_star_snapshots
when new.repo_id <> old.repo_id
  or new.snapshot_day <> old.snapshot_day
  or new.created_at <> old.created_at
begin
  select raise(ABORT, 'github_repo_star_snapshots identity (repo_id, snapshot_day, created_at) is immutable: a row may only be refreshed with a later reading of the same day');
end;

-- Strictly forward. This is what keeps a stale or replayed write from
-- clobbering a fresher reading -- the retry that arrives after the poll it
-- was retrying already succeeded. The access layer avoids reaching this
-- trigger at all by filtering the conflict update (see recordStarSnapshot);
-- the trigger is the backstop for every writer that does not go through it.
create trigger github_repo_star_snapshots_observed_at_monotonic before update on github_repo_star_snapshots
when new.observed_at <= old.observed_at
begin
  select raise(ABORT, 'github_repo_star_snapshots.observed_at may only move forward: refusing to overwrite a reading with an equal or older one');
end;

create trigger github_repo_star_snapshots_format_insert before insert on github_repo_star_snapshots
when new.observed_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  or new.created_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  or new.snapshot_day not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
begin
  select raise(ABORT, 'github_repo_star_snapshots: observed_at/created_at must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ) and snapshot_day must be YYYY-MM-DD');
end;

create trigger github_repo_star_snapshots_format_update before update on github_repo_star_snapshots
when new.observed_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'github_repo_star_snapshots.observed_at must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

-- snapshot_day must plausibly BE the local day of observed_at. Without this,
-- nothing stops a caller filing today's reading under an arbitrary date --
-- which is a direct attack on the denominator sections 1 and 3 protect, and
-- would be invisible afterwards because the row looks entirely well-formed.
--
-- The bound is deliberately loose rather than exact, because the exact answer
-- needs the tz database and SQLite does not have it here. Real zone offsets
-- span UTC-12:00 to UTC+14:00, so the local date legitimately runs from one
-- day behind the UTC date to one day ahead: julianday(observed_at) minus
-- julianday(snapshot_day) -- midnight of that date -- lands within (-0.6,
-- +1.6) for every real zone. Rounded outward to (-1, +2) so no genuine zone
-- can ever be near the edge, which still catches the case worth catching: a
-- day filed weeks from the reading that produced it.
--
-- julianday() is used purely as arithmetic on two supplied values. It does
-- not read a clock and is not given 'now' or 'localtime', so the no-host-zone
-- rule in section 4 is not weakened by it.
create trigger github_repo_star_snapshots_day_matches_instant before insert on github_repo_star_snapshots
when julianday(new.observed_at) - julianday(new.snapshot_day) <= -1.0
  or julianday(new.observed_at) - julianday(new.snapshot_day) >= 2.0
begin
  select raise(ABORT, 'github_repo_star_snapshots.snapshot_day is not a plausible local day for observed_at: no real timezone offset can span that gap');
end;

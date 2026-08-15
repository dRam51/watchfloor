-- The stored answer to "does this repo have a README, and what does its first
-- paragraph say?" (M4a task 11, src/db/repoReadmes.ts).
--
-- Brief §4 lists "README first paragraph" among the repos beat's enrichment
-- fields AND makes "repos with no README" one of four suppression rules. Task
-- 6 (src/enrich/repo.ts) built the fetch and the extraction; nothing stored
-- the result, so every row's readmeExcerpt was null and the fourth
-- suppression rule was inert. This table is where an answer lives between
-- polls, and it is the only thing that makes task 6's cache-and-skip real:
-- unauthenticated Core is 60 requests/hour PER IP against 359 repos in the
-- live corpus, so coverage has to COMPOUND across polls rather than restart.
--
-- ===========================================================================
-- 1. THE WHOLE POINT: three facts, and none of them may collapse into another
-- ===========================================================================
-- Task 6's carry-forward, verbatim: "an UNREAD README is indistinguishable
-- from a MISSING one. Both produce readmeExcerpt === null, and §4 suppresses
-- the second." A budget shortfall or a transient 503 would therefore silently
-- delete good repos from the lane. That is precisely the shape of M2's worst
-- bug -- a plausible wrong answer, not a crash -- so the separation is made
-- structural here rather than promised in a doc comment:
--
--   * READ, AND IT SAYS SOMETHING     outcome = 'present', first_paragraph
--                                     not null.
--   * READ, AND THERE IS NOTHING      outcome = 'absent'  (GitHub's readme
--     TO SAY                          endpoint 404s: no README file at all)
--                                     or 'no_prose' (a file exists but yields
--                                     no paragraph -- octocat/Hello-World's
--                                     README is the string `Hello World!`).
--                                     Both are ANSWERS; §4 may suppress on
--                                     either.
--   * NOT ANSWERED                    outcome is null. Two sub-cases, also
--                                     kept apart: NO ROW AT ALL means never
--                                     attempted, and a row with
--                                     attempt_failure set means attempted and
--                                     failed. §4 may NOT suppress on either.
--
-- The invariant `(outcome is null) = (answered_at is null)` and the
-- outcome/first_paragraph CHECKs below make the corrupt combinations
-- unrepresentable through ANY writer -- the sqlite3 CLI, a repair script, a
-- future pass that forgets. src/db/repoReadmes.ts's isReadmeAnswered() reads
-- exactly one column to decide; there is no second convention to keep in sync.
--
-- ===========================================================================
-- 2. THE ANSWER AND THE ATTEMPT ARE SEPARATE CLOCKS, and that is load-bearing
-- ===========================================================================
-- The obvious schema is one outcome column holding whatever the last request
-- returned. It has a bug that only shows up in production: a repo read
-- successfully on Monday and 503-ing on Tuesday would have its paragraph
-- overwritten by the failure, so the lane would render "README not yet read"
-- for a repo whose README it had already read. One flaky response would
-- degrade a row that was previously correct.
--
-- So the row carries two facts:
--
--   answered_at / outcome / first_paragraph / readme_path
--       the last time the README QUESTION was actually answered.
--   attempted_at / attempt_failure / attempt_detail
--       the last time a request was SENT, whatever came back.
--
-- A failure moves the attempt clock and leaves the answer alone. A success
-- moves both and clears attempt_failure. `answered_at <= attempted_at` always
-- holds, and `attempt_failure is null` exactly when the last attempt IS the
-- answer -- both enforced as CHECKs, so the two clocks cannot drift into an
-- impossible pairing.
--
-- The attempt clock is not bookkeeping for its own sake. It is what stops a
-- handful of permanently-failing repos from consuming the entire hourly
-- budget on every poll forever: src/ingest/repoEnrichment.ts orders
-- never-attempted repos ahead of previously-failed ones, which needs the
-- failure to have been recorded rather than forgotten.
--
-- ===========================================================================
-- 3. Upsert per repo, delete never -- and a PAST answer may not be restated
-- ===========================================================================
-- items / item_scores / item_clusters (0001_init.sql) are append-only. 0007's
-- star snapshots deliberately are not, because they feed a RATE whose
-- denominator is a row count. This table departs for a different reason
-- again, and the distinction is worth stating because the two departures are
-- not the same argument:
--
--   0007 is a SERIES: one row per repo per day, because seven days of history
--   is the thing being measured.
--   0008 is a CURRENT FACT: one row per repo, full stop. Nothing counts
--   README rows, nothing computes a rate over them, and no consumer reads
--   yesterday's paragraph. It belongs with item_state (0001), fetch state
--   (0003) and lane_layout (0006), which hold a current reading rather than a
--   ledger.
--
-- Keeping the history would be unbounded growth per repo per poll recording a
-- string that rarely changes, in service of no query anyone has.
--
-- A PAST record may NOT be restated, and that is enforced, not customary:
--   * DELETE is refused outright (CLAUDE.md's never-delete rule).
--   * repo_id and first_attempted_at are immutable.
--   * attempted_at may only move FORWARD, so a replayed or out-of-order
--     observation cannot overwrite a fresher one.
--   * answered_at may only move forward, so a stale reading cannot replace a
--     newer answer even when the attempt clocks would allow it.
--   * an answer may never be REMOVED -- outcome cannot go from non-null back
--     to null. Losing an answer would put a repo back into the "unknown"
--     state and would cost a request to recover something we already knew.
--
-- What a later observation IS allowed to do is supersede the answer with a
-- newer one, because a README is a live property of a live repository and the
-- later reading is the better one. That is the same stance src/domain/repo.ts
-- takes toward suppression: "a repo that gains a README simply stops matching
-- hasNoReadme on the next poll", which is only true if the stored answer can
-- be refreshed.
--
-- ===========================================================================
-- 4. Identity is GitHub's numeric repo id, per 0007 section 2
-- ===========================================================================
-- Not owner/name, and not item_key -- a rename produces a new item_key, which
-- would orphan a perfectly good stored README and cost a request to re-learn
-- it, and (worse) would let two names accumulate two records for one repo.
-- full_name is stored alongside as DISPLAY text and is refreshed on every
-- observation; 0007's github_repo_names remains the identity map back to the
-- rest of the system.
--
-- ===========================================================================
-- 5. No timezone anywhere, deliberately -- unlike 0007
-- ===========================================================================
-- 0007 stores `tz` on every row because a snapshot DAY is a calendar quantity
-- and the zone decides which day a reading lands in. Nothing here is bucketed
-- by day: both clocks are canonical UTC instants, and freshness is elapsed
-- time, not a calendar boundary. Adding a tz column would imply a day
-- semantics that does not exist and that a later writer would then have to
-- honour. Nothing in this file calls date(), strftime(), 'now' or
-- 'localtime'.

create table github_repo_readmes (
  -- GitHub's immutable numeric repository id. The identity, per section 4.
  repo_id            integer not null primary key,

  -- owner/name as observed. Display text, refreshed on every observation;
  -- repo_id is what identifies the row.
  full_name          text not null,

  -- ------------------------------------------------------------------
  -- THE ANSWER (section 1). null means the question is UNANSWERED, which is
  -- NOT the same as "this repo has no README" and must never be suppressed on.
  -- ------------------------------------------------------------------
  outcome            text
                     check (outcome is null or outcome in ('present', 'no_prose', 'absent')),

  -- The README's first paragraph, already through src/domain/repo.ts's
  -- toExcerpt (whitespace collapsed, trimmed, capped at a word boundary).
  --
  -- 300 is MAX_EXCERPT_LENGTH in src/domain/repo.ts, repeated here as a
  -- literal because a migration cannot import a constant. A test asserts the
  -- two agree, so raising the cap in code fails the suite loudly instead of
  -- failing writes silently at 3am. The cap is the standing "links and short
  -- excerpts, never full article text" rule, and this is the first field in
  -- the system whose SOURCE is routinely tens of kilobytes -- so the check is
  -- doing real work here rather than tidying an already-short string.
  first_paragraph    text
                     check (first_paragraph is null
                            or (length(first_paragraph) > 0
                                and length(first_paragraph) <= 300)),

  -- Which file GitHub's readme endpoint actually resolved (README.md,
  -- README.rst, readme.md, README with no extension -- all four are real and
  -- all four are in task 6's fixtures). Only meaningful when a file was read.
  readme_path        text,

  -- Canonical UTC instant the ANSWER was established. Null exactly when
  -- outcome is null; see section 1.
  answered_at        text,

  -- ------------------------------------------------------------------
  -- THE ATTEMPT (section 2). Always set: a row exists only because a request
  -- was sent.
  -- ------------------------------------------------------------------
  attempted_at       text not null,

  -- Why the LAST attempt failed to answer the question, or null when it
  -- succeeded. 'unreadable' = a README that exists but could not be read
  -- (over GitHub's 1 MB inline ceiling, or a malformed body); 'error' = the
  -- request itself failed.
  attempt_failure    text
                     check (attempt_failure is null
                            or attempt_failure in ('unreadable', 'error')),
  attempt_detail     text,

  -- When this repo was FIRST attempted. Immutable across every later
  -- observation, so "how long have we been failing to read this" survives.
  first_attempted_at text not null,

  -- --------------------------------------------------------------------
  -- Coherence between the two halves. Each of these makes one impossible
  -- pairing unrepresentable rather than merely unlikely.
  -- --------------------------------------------------------------------

  -- An outcome and the instant it was established travel together.
  check ((outcome is null) = (answered_at is null)),

  -- A paragraph exists exactly when the outcome says one does. This is the
  -- single CHECK that makes 'present' and 'no README' inseparable from the
  -- data: neither a 'present' row with nothing in it nor an 'absent' row
  -- carrying a paragraph can be written.
  check ((outcome = 'present') = (first_paragraph is not null)),

  -- A resolved path means a file was actually read.
  check (readme_path is null or outcome in ('present', 'no_prose')),

  -- A failure detail belongs to a failure.
  check (attempt_detail is null or attempt_failure is not null),

  -- The answer cannot postdate the last attempt that could have produced it.
  check (answered_at is null or answered_at <= attempted_at),

  -- Section 2's central invariant: the last attempt failed IF AND ONLY IF it
  -- is not the attempt that produced the current answer. This is what makes
  -- "a failure never clobbers an answer" a property of the schema rather than
  -- of the access layer -- a writer that overwrote the answer with a failure
  -- would have to leave answered_at = attempted_at with attempt_failure set,
  -- which this refuses.
  check ((attempt_failure is null) = (answered_at is not null and answered_at = attempted_at))
);

-- "Which repos have never been answered" -- the enrichment pass's own
-- candidate ordering read. The primary key (repo_id) cannot serve it.
create index github_repo_readmes_unanswered on github_repo_readmes (outcome, attempted_at);

create trigger github_repo_readmes_no_delete before delete on github_repo_readmes
begin
  select raise(ABORT, 'github_repo_readmes rows are never deleted: a deleted answer is indistinguishable from a README never read, and §4 suppresses only the first');
end;

create trigger github_repo_readmes_identity_immutable before update on github_repo_readmes
when new.repo_id <> old.repo_id
  or new.first_attempted_at <> old.first_attempted_at
begin
  select raise(ABORT, 'github_repo_readmes identity (repo_id, first_attempted_at) is immutable: record a new observation instead of restating an existing one');
end;

-- Strictly forward. The backstop against a replayed or out-of-order
-- observation overwriting a fresher one; the access layer filters the
-- conflict update so it does not normally reach this trigger.
create trigger github_repo_readmes_attempted_at_monotonic before update on github_repo_readmes
when new.attempted_at <= old.attempted_at
begin
  select raise(ABORT, 'github_repo_readmes.attempted_at may only move forward: refusing to overwrite an observation with an equal or older one');
end;

-- An answer may be superseded by a NEWER answer, never by an older one.
create trigger github_repo_readmes_answered_at_monotonic before update on github_repo_readmes
when new.answered_at is not null and old.answered_at is not null
 and new.answered_at < old.answered_at
begin
  select raise(ABORT, 'github_repo_readmes.answered_at may only move forward: refusing to restate a past answer');
end;

-- Section 3: an answer is never removed. Going back to unanswered would put a
-- repo into the state §4 must not suppress on, discarding something already
-- paid for.
create trigger github_repo_readmes_answer_never_lost before update on github_repo_readmes
when new.outcome is null and old.outcome is not null
begin
  select raise(ABORT, 'github_repo_readmes: an answered README may not become unanswered -- record the failed attempt and keep the answer');
end;

-- Same canonical-timestamp shape items.fetched_at (0002) and 0007's tables are
-- held to, and for the same reason: these values are compared
-- lexicographically, which only matches chronological order at a fixed width.
-- INSERT and UPDATE both covered -- this table is not append-only, so INSERT is
-- not the only reachable write path.
create trigger github_repo_readmes_format_insert before insert on github_repo_readmes
when new.attempted_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  or new.first_attempted_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  or (new.answered_at is not null
      and new.answered_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
begin
  select raise(ABORT, 'github_repo_readmes timestamps must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

create trigger github_repo_readmes_format_update before update on github_repo_readmes
when new.attempted_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  or (new.answered_at is not null
      and new.answered_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
begin
  select raise(ABORT, 'github_repo_readmes timestamps must be canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

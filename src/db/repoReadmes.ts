/**
 * Storage for §4's "README first paragraph" -- the one repos-beat enrichment
 * field that costs a request, and the input to one of §4's four suppression
 * rules (M4a task 11).
 *
 * See db/migrations/0008_repo_readmes.sql for the schema's own reasoning. The
 * two things a reader of THIS file needs to hold onto:
 *
 *  1. **An unanswered README is not an absent one.** `outcome === null` means
 *     the question has not been answered -- either never attempted (no row at
 *     all) or attempted and failed (a row with `attemptFailure` set). §4's
 *     `no_readme` rule may only be honoured on an ANSWER. {@link
 *     isReadmeAnswered} is the one predicate that decides this, and {@link
 *     cachedFirstParagraph} is the one that decides whether to spend a
 *     request.
 *  2. **A failure never clobbers an answer.** The row carries two clocks --
 *     when the question was last answered, and when a request was last sent.
 *     A 503 moves the second and leaves the first alone, so one flaky response
 *     cannot turn a repo whose README we read yesterday into one the lane
 *     reports as unread.
 *
 * This module writes nothing outside `github_repo_readmes` and reads no clock:
 * `observedAt` is injected, matching every other storage module here.
 */

import type { Db } from './connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import { toExcerpt } from '../domain/repo.ts';

/**
 * The three outcomes that ANSWER the README question.
 *
 * `present` -- read, and it yielded a paragraph.
 * `no_prose` -- a README file was read and yielded nothing worth showing (a
 *   title and a badge row; `octocat/Hello-World`'s entire README is the string
 *   `Hello World!`).
 * `absent` -- GitHub's readme endpoint 404'd: the repo has no README at all.
 *
 * §4 suppresses on the last two. It may NOT suppress on the absence of a row.
 */
export type ReadmeAnswer = 'present' | 'no_prose' | 'absent';

/**
 * Why an attempt failed to answer the question.
 *
 * `unreadable` -- a README that exists but could not be read (over GitHub's
 *   1 MB inline ceiling, or a malformed body). The file is there; we simply
 *   have not read it.
 * `error` -- the request itself failed.
 */
export type ReadmeFailure = 'unreadable' | 'error';

/** One repo's stored README state. See the module doc for the two clocks. */
export interface RepoReadmeRecord {
  /** GitHub's immutable numeric repository id. */
  repoId: number;
  /** owner/name as last observed. Display text; `repoId` identifies the row. */
  fullName: string;
  /** The last ANSWER, or `null` when the question has never been answered. */
  outcome: ReadmeAnswer | null;
  /** The capped first paragraph. Non-null exactly when `outcome === 'present'`. */
  firstParagraph: string | null;
  /** Which file GitHub's readme endpoint resolved, when one was read. */
  readmePath: string | null;
  /** Canonical UTC instant the answer was established; `null` iff `outcome` is. */
  answeredAt: string | null;
  /** Canonical UTC instant a request was last SENT, whatever came back. */
  attemptedAt: string;
  /** Why the LAST attempt failed, or `null` when it succeeded. */
  attemptFailure: ReadmeFailure | null;
  attemptDetail: string | null;
  /** When this repo was first attempted. Immutable. */
  firstAttemptedAt: string;
}

interface ObservationBase {
  repoId: number;
  fullName: string;
  /** Canonical UTC instant the request was made. Injected, never a clock read. */
  observedAt: string;
}

/**
 * One README observation, as the enrichment pass hands it over.
 *
 * A discriminated union, so `firstParagraph` exists ONLY on the branch that
 * has one -- the same discipline `VelocityResult` (src/score/velocity.ts) and
 * `ReadmeOutcome` (src/enrich/repo.ts) keep, and for the same reason: a
 * caller reaching for a paragraph on an `absent` observation should not
 * compile.
 */
export type ReadmeObservation = ObservationBase &
  (
    | { outcome: 'present'; firstParagraph: string; readmePath?: string | null }
    | { outcome: 'no_prose'; readmePath?: string | null }
    | { outcome: 'absent' }
    | { outcome: 'failed'; failure: ReadmeFailure; detail: string }
  );

/**
 * What a {@link recordRepoReadme} call actually did.
 *
 * `ignored` means a LATER observation was already stored and this one was
 * discarded -- ordinary operational noise (a retry landing after the poll it
 * was retrying already succeeded), returned rather than thrown, but a caller
 * that logged "recorded" unconditionally would be lying. Same convention as
 * `recordStarSnapshot`.
 */
export interface ReadmeRecordOutcome {
  action: 'inserted' | 'updated' | 'ignored';
}

const INSERT_ANSWER = `
  insert into github_repo_readmes
    (repo_id, full_name, outcome, first_paragraph, readme_path, answered_at,
     attempted_at, attempt_failure, attempt_detail, first_attempted_at)
  values (?, ?, ?, ?, ?, ?, ?, null, null, ?)
  on conflict (repo_id) do update set
    full_name = excluded.full_name,
    outcome = excluded.outcome,
    first_paragraph = excluded.first_paragraph,
    readme_path = excluded.readme_path,
    answered_at = excluded.answered_at,
    attempted_at = excluded.attempted_at,
    attempt_failure = null,
    attempt_detail = null
  where excluded.attempted_at > github_repo_readmes.attempted_at
`;

/**
 * The failure path updates ONLY the attempt columns. `outcome`,
 * `first_paragraph`, `readme_path` and `answered_at` are deliberately absent
 * from the SET list -- that omission is what makes "a failure never clobbers
 * an answer" true at the statement level, before the schema's CHECK ever has
 * to catch it.
 */
const INSERT_FAILURE = `
  insert into github_repo_readmes
    (repo_id, full_name, outcome, first_paragraph, readme_path, answered_at,
     attempted_at, attempt_failure, attempt_detail, first_attempted_at)
  values (?, ?, null, null, null, null, ?, ?, ?, ?)
  on conflict (repo_id) do update set
    full_name = excluded.full_name,
    attempted_at = excluded.attempted_at,
    attempt_failure = excluded.attempt_failure,
    attempt_detail = excluded.attempt_detail
  where excluded.attempted_at > github_repo_readmes.attempted_at
`;

/**
 * Records one README observation for one repo, superseding whatever was there
 * if (and only if) this observation is newer.
 *
 * A `present` observation's paragraph goes through `toExcerpt` here rather
 * than being trusted: the schema caps the column at MAX_EXCERPT_LENGTH and a
 * caller handing over a raw README would otherwise abort the write at 3am
 * instead of being capped. A paragraph that collapses to nothing is rejected
 * loudly rather than silently reclassified -- `no_prose` is the outcome for
 * that, and picking it is the caller's judgement, not this function's.
 */
export function recordRepoReadme(db: Db, obs: ReadmeObservation): ReadmeRecordOutcome {
  assertCanonicalTimestamp('observedAt', obs.observedAt);
  if (!Number.isSafeInteger(obs.repoId) || obs.repoId <= 0) {
    throw new RangeError(`repoId '${obs.repoId}' must be a positive safe integer`);
  }

  // Reads the existing row to NAME the outcome. `.run()`'s `changes` cannot:
  // an INSERT and a conflict-resolving UPDATE both report 1, and only the
  // WHERE-filtered no-op reports 0. The guarded upsert below still does the
  // real deciding -- this read only labels it. (Same shape recordStarSnapshot
  // uses, for the same reason.)
  const existing = db
    .prepare('select attempted_at from github_repo_readmes where repo_id = ?')
    .get(obs.repoId) as { attempted_at: string } | undefined;

  if (obs.outcome === 'failed') {
    db.prepare(INSERT_FAILURE).run(
      obs.repoId,
      obs.fullName,
      obs.observedAt,
      obs.failure,
      obs.detail,
      obs.observedAt,
    );
  } else {
    let paragraph: string | null = null;
    if (obs.outcome === 'present') {
      paragraph = toExcerpt(obs.firstParagraph);
      if (paragraph === null) {
        throw new RangeError(
          `a 'present' README observation for repo ${obs.repoId} has no paragraph left after ` +
            `capping -- record it as 'no_prose' instead`,
        );
      }
    }
    db.prepare(INSERT_ANSWER).run(
      obs.repoId,
      obs.fullName,
      obs.outcome,
      paragraph,
      obs.outcome === 'absent' ? null : (obs.readmePath ?? null),
      obs.observedAt,
      obs.observedAt,
      obs.observedAt,
    );
  }

  if (existing === undefined) return { action: 'inserted' };
  return { action: obs.observedAt > existing.attempted_at ? 'updated' : 'ignored' };
}

const SELECT_COLUMNS = `
  repo_id, full_name, outcome, first_paragraph, readme_path, answered_at,
  attempted_at, attempt_failure, attempt_detail, first_attempted_at
`;

// Inline type literal, not a named interface -- casting .all()/.get()'s
// Record<string, SQLOutputValue> to a NAMED interface fails tsc's overlap
// check while a structurally identical inline literal passes. See CLAUDE.md,
// "The node:sqlite cast quirk", and src/cluster/store.ts:88-100.
type ReadmeRow = {
  repo_id: number;
  full_name: string;
  outcome: string | null;
  first_paragraph: string | null;
  readme_path: string | null;
  answered_at: string | null;
  attempted_at: string;
  attempt_failure: string | null;
  attempt_detail: string | null;
  first_attempted_at: string;
};

function toRecord(row: ReadmeRow): RepoReadmeRecord {
  return {
    repoId: row.repo_id,
    fullName: row.full_name,
    outcome: row.outcome as ReadmeAnswer | null,
    firstParagraph: row.first_paragraph,
    readmePath: row.readme_path,
    answeredAt: row.answered_at,
    attemptedAt: row.attempted_at,
    attemptFailure: row.attempt_failure as ReadmeFailure | null,
    attemptDetail: row.attempt_detail,
    firstAttemptedAt: row.first_attempted_at,
  };
}

/** One repo's README state, or `null` if it has never been attempted. */
export function getRepoReadme(db: Db, repoId: number): RepoReadmeRecord | null {
  const row = db
    .prepare(`select ${SELECT_COLUMNS} from github_repo_readmes where repo_id = ?`)
    .get(repoId) as ReadmeRow | undefined;
  return row === undefined ? null : toRecord(row);
}

/**
 * SQLite binds a bounded number of parameters per statement, and the candidate
 * pool is already 359 repos and only grows. Chunked well below any build's
 * ceiling rather than relying on a compile-time default.
 */
const ID_CHUNK = 500;

/**
 * Every stored record among `repoIds`, keyed by repo id. Repos with no record
 * are simply absent from the map -- never present with a blank value, which
 * would be the same "unread looks like missing" collapse this table exists to
 * prevent.
 */
export function getRepoReadmes(
  db: Db,
  repoIds: readonly number[],
): Map<number, RepoReadmeRecord> {
  const byId = new Map<number, RepoReadmeRecord>();
  for (let i = 0; i < repoIds.length; i += ID_CHUNK) {
    const chunk = repoIds.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `select ${SELECT_COLUMNS} from github_repo_readmes where repo_id in (${placeholders})`,
      )
      .all(...chunk) as ReadmeRow[];
    for (const row of rows) byId.set(row.repo_id, toRecord(row));
  }
  return byId;
}

/**
 * Whether this record ANSWERS the README question -- §4's `no_readme` rule may
 * only be honoured when this is true, and `feed.ts` ships it as `readmeKnown`.
 *
 * `null` (no record) is false, and so is a record that only ever recorded
 * failures. Deliberately takes a nullable record so the "never attempted" and
 * "attempted and failed" cases go through the same call site and cannot be
 * handled differently by accident.
 */
export function isReadmeAnswered(record: RepoReadmeRecord | null): boolean {
  return record !== null && record.outcome !== null;
}

/**
 * The value `EnrichOptions.cachedReadmeFirstParagraph` must return for this
 * repo.
 *
 *   a string   -- read it before; skip the request and reuse the paragraph.
 *   null       -- answered, and the answer is "no README". Skip the request;
 *                 §4 may suppress.
 *   undefined  -- NOT answered. Send the request.
 *
 * The third case is the whole safety property: a failure-only record and a
 * missing record both return `undefined`, so a repo whose README was never
 * read is retried rather than suppressed. Derived from the same `outcome`
 * column {@link isReadmeAnswered} reads, so the two cannot disagree.
 *
 * Freshness is NOT decided here. A caller that wants to re-read a stale answer
 * passes `null` for the record; see src/ingest/repoEnrichment.ts, which owns
 * that policy because it owns the budget.
 */
export function cachedFirstParagraph(
  record: RepoReadmeRecord | null,
): string | null | undefined {
  if (!isReadmeAnswered(record)) return undefined;
  return record!.firstParagraph;
}

/**
 * README enrichment for `github_search` sources (M4a task 11).
 *
 * ## Why this module exists at all
 *
 * Task 6 built `src/enrich/repo.ts` -- the README fetch, the first-paragraph
 * extraction, the whole budget policy -- with 43 tests and 14 real captures.
 * **Nothing called it.** So `readmeExcerpt` was null on every row of the live
 * corpus and §4's fourth suppression rule ("repos with no README") was inert:
 * a quarter of the filter silently not running, on a lane that looked
 * correct.
 *
 * That is the third gap of exactly this shape M4a's live run found, after the
 * unregistered `github_search` adapter (`9b57df9`) and the unrecorded star
 * snapshots (`e5a3260`). All three were gaps BETWEEN correctly-built,
 * fully-tested parts, and none of them was findable by a unit test.
 *
 * This module is `src/ingest/starSnapshots.ts`'s sibling and deliberately has
 * the same shape: it runs AFTER a poll cycle, over what was actually
 * persisted, with `now` injected. Reading the stored items rather than taking
 * the adapter's output is not a shortcut -- the adapter contract
 * (`src/adapters/types.ts`) is `fetch(source, state, now) => AdapterResult`
 * with no database handle by design, so an adapter cannot do this and
 * threading a `Db` into one would break the property every other adapter
 * relies on for testability.
 *
 * ## What it adds on top of task 6, and what it must not re-decide
 *
 * The budget policy is task 6's and is used as it stands: free suppression
 * first, ranked top-N ({@link README_FETCH_LIMITS}: 8 unauthenticated, 50
 * authenticated), a live budget floor above a caller-set reserve. This module
 * supplies the two things task 6 deliberately left to a caller because it owns
 * no storage:
 *
 *  - `cachedReadmeFirstParagraph`, wired to `src/db/repoReadmes.ts`. This is
 *    **cache-and-skip: returning a value means no request is sent.** Not an
 *    ETag -- task 1 measured that a 304 still drove `x-ratelimit-used`
 *    1 -> 2 -> 3 -> 4 unauthenticated, so revalidating N READMEs costs exactly
 *    what refetching N costs. The saving exists only if the request is never
 *    made.
 *  - `isDismissed`, wired to `isRepoDismissed`. Budget-saving only;
 *    `src/api/routes/feed.ts` remains the enforcement point for dismissal.
 *
 * ## The arithmetic that shapes everything
 *
 * Unauthenticated Core is **60 requests/hour, and the ceiling is PER IP, not
 * per process** -- task 6 observed `x-ratelimit-used` already at 8 on a fresh
 * process's first request. There are 359 repos in the live corpus. A naive
 * loop is therefore six hours of budget for one poll.
 *
 * Cache-and-skip is what makes that tractable: a cached repo does not consume
 * the top-N cap either (see `enrichRepos`, where the cache check precedes the
 * limit check), so every poll spends its 8 requests on repos that have never
 * been read. **Coverage compounds instead of restarting** -- 359 repos reach
 * full coverage in roughly 45 polls rather than never.
 *
 * ## Freshness, and why the two windows differ
 *
 * A stored answer is honoured for a while and then re-read. The two windows
 * are deliberately far apart, and the asymmetry is the point:
 *
 *  - A stale POSITIVE answer is a slightly outdated sentence on a row. Nobody
 *    is harmed. {@link ANSWER_FRESH_FOR_MS}.
 *  - A stale NEGATIVE answer REMOVES THE REPO FROM THE LANE, because §4
 *    suppresses README-less repos. `src/domain/repo.ts` justifies suppressing
 *    (rather than de-ranking) precisely on the grounds that "a repo that gains
 *    a README simply stops matching `hasNoReadme` on the next poll" -- which
 *    is only true if the negative answer expires quickly. {@link
 *    NO_README_FRESH_FOR_MS}.
 *
 * ## No timezone, deliberately -- and this is a departure from its sibling
 *
 * `recordStarSnapshots` takes a `tz` because a snapshot DAY is a calendar
 * quantity: the zone decides which day a reading lands in, and that decides
 * velocity's denominator. **Nothing here is bucketed by day.** Both stored
 * clocks are canonical UTC instants and freshness is elapsed time. Taking a
 * `tz` this module ignored would imply a calendar semantics that does not
 * exist, and the next writer would have to honour it. A test pins that the
 * module's behaviour is identical under `America/New_York`, `Asia/Tokyo` and
 * `UTC`.
 */

import type { Db } from '../db/connection.ts';
import type { Source } from '../sources/load.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import { isRepoDismissed, toExcerpt, type Repo } from '../domain/repo.ts';
import { repoFromSearchItem } from '../adapters/github.ts';
import { TOKEN_ENV_VAR } from '../adapters/github.ts';
import { GitHubClient } from '../fetch/github.ts';
import {
  enrichRepos,
  type EnrichmentReport,
  type ReadmeOutcome,
  type RepoFacts,
} from '../enrich/repo.ts';
import {
  cachedFirstParagraph,
  getRepoReadmes,
  recordRepoReadme,
  type ReadmeObservation,
  type RepoReadmeRecord,
} from '../db/repoReadmes.ts';

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a stored README PARAGRAPH is honoured before the README is read
 * again. Thirty days: a project's opening paragraph is close to the slowest-
 * moving text GitHub serves, and re-reading it sooner would spend a
 * 60/hour budget on rediscovering a sentence that has not changed.
 */
export const ANSWER_FRESH_FOR_MS = 30 * 24 * HOUR_MS;

/**
 * How long "this repo has no README" is honoured before being re-checked.
 *
 * **Much shorter than {@link ANSWER_FRESH_FOR_MS}, and that asymmetry is the
 * whole reason there are two constants.** This is the answer that SUPPRESSES,
 * so a stale one hides a repo that may since have gained a README. Twenty-four
 * hours keeps `src/domain/repo.ts`'s promise -- that suppression is a
 * predicate over the current snapshot rather than a stored verdict --
 * approximately true, at a cost of one request per README-less repo per day
 * against a ~190/day budget.
 */
export const NO_README_FRESH_FOR_MS = 24 * HOUR_MS;

/**
 * Core requests this pass leaves unspent by default.
 *
 * Enrichment is the least urgent Core consumer in the system and must never be
 * why something else cannot run. Ten of sixty matters more than it looks:
 * the ceiling is per-IP, and task 6 observed 8 requests already spent on a
 * fresh process's first call, so this machine demonstrably has another Core
 * consumer on it.
 */
export const CORE_RESERVE = 10;

/** What one enrichment sweep did. */
export interface RepoEnrichmentSweep {
  /** Distinct repos considered, after collapsing a rename's two item_keys. */
  examined: number;
  /**
   * Stored rows whose `raw_json` could not be read back as a repo. Counted
   * rather than thrown -- one malformed row must not fail a cycle -- but
   * counted rather than ignored, so a silently-zero sweep cannot look like
   * success. Same convention `StarSnapshotSweep.unusable` follows.
   */
  unusable: number;
  /** README questions newly ANSWERED and stored this sweep. */
  answered: number;
  /** Attempts recorded as failures. These answer nothing; the repo is retried. */
  failed: number;
  /**
   * Task 6's own report, embedded verbatim rather than restated field by
   * field -- a second copy of `fetched`/`cached`/`skipped` here would be one
   * more thing to keep in sync. `null` means the pass did not run at all
   * because no `github_search` source is configured.
   */
  report: EnrichmentReport | null;
}

export interface RepoEnrichmentOptions {
  /** Canonical UTC instant. Injected, never `Date.now()`. */
  now: string;
  /**
   * Overridable so tests can point at a real local server. Defaults to a
   * client built from `WF_GITHUB_TOKEN` and the configured source's own
   * origin -- the same construction `githubSearchAdapter.fetch` performs, and
   * for the same reason (the token is read at the edge and handed straight to
   * the client, which keeps it in a `#private` field).
   */
  client?: GitHubClient;
  /** Overrides {@link CORE_RESERVE} for this sweep. */
  reserve?: number;
  /** Overrides task 6's {@link README_FETCH_LIMITS} for this sweep. */
  maxReadmeFetches?: number;
  minIntervalMs?: number;
}

/**
 * One row per distinct `item_key`, taking the LATEST version -- identical in
 * shape to `src/ingest/starSnapshots.ts`'s own query, plus `fetched_at`, which
 * is what lets a rename's two keys collapse onto the newer name.
 *
 * Inline type literal on the cast, not a named interface -- see CLAUDE.md,
 * "The node:sqlite cast quirk", and src/cluster/store.ts:88-100.
 */
const SELECT_LATEST = `
  select i.item_key as item_key, i.raw_json as raw_json, i.fetched_at as fetched_at
    from items i
    join (
      select item_key, max(fetched_at) as newest
        from items
       where source_id in (SOURCE_IDS)
       group by item_key
    ) latest
      on latest.item_key = i.item_key and latest.newest = i.fetched_at
   where i.source_id in (SOURCE_IDS)
   group by i.item_key
`;

interface Candidate {
  repo: Repo;
  facts: RepoFacts;
  /** The latest `fetched_at` this repo was seen at, across every name. */
  seenAt: string;
}

/**
 * Enriches every repo currently stored from a `github_search` source with its
 * README first paragraph, within task 6's budget policy, and records the
 * answer so the next poll does not have to ask again.
 */
export async function enrichRepoReadmes(
  db: Db,
  sources: readonly Source[],
  opts: RepoEnrichmentOptions,
): Promise<RepoEnrichmentSweep> {
  assertCanonicalTimestamp('now', opts.now);

  const searchSources = sources.filter((s) => s.type === 'github_search');
  const sweep: RepoEnrichmentSweep = {
    examined: 0,
    unusable: 0,
    answered: 0,
    failed: 0,
    report: null,
  };
  if (searchSources.length === 0) return sweep;

  const { candidates, unusable } = readCandidates(db, searchSources);
  sweep.examined = candidates.length;
  sweep.unusable = unusable;

  const stored = getRepoReadmes(db, candidates.map((c) => c.facts.githubId));
  const ordered = orderCandidates(candidates, stored, opts.now);

  const client =
    opts.client ??
    new GitHubClient({
      token: process.env[TOKEN_ENV_VAR],
      baseUrl: new URL(searchSources[0]!.url).origin,
    });

  const { repos, report } = await enrichRepos(
    client,
    ordered.map((c) => c.facts),
    {
      now: opts.now,
      reserve: opts.reserve ?? CORE_RESERVE,
      ...(opts.maxReadmeFetches !== undefined ? { maxReadmeFetches: opts.maxReadmeFetches } : {}),
      ...(opts.minIntervalMs !== undefined ? { minIntervalMs: opts.minIntervalMs } : {}),
      // Cache-and-skip. A record that is UNANSWERED or STALE is passed as
      // `null`, which makes `cachedFirstParagraph` return `undefined` -- send
      // the request. Only a fresh ANSWER short-circuits it.
      cachedReadmeFirstParagraph: (facts) => {
        const record = stored.get(facts.githubId) ?? null;
        return cachedFirstParagraph(isFresh(record, opts.now) ? record : null);
      },
      // Budget-saving only. feed.ts is the enforcement point for dismissal and
      // stays so -- see src/domain/repo.ts's own note against "optimizing away"
      // either one on the strength of the other.
      isDismissed: (repo) => isRepoDismissed(db, repo),
    },
  );
  sweep.report = report;

  for (const enriched of repos) {
    const observation = readmeObservationFor(enriched.readme, {
      repoId: enriched.repo.githubId,
      fullName: enriched.repo.fullName,
      observedAt: opts.now,
    });
    if (observation === null) continue;

    const { action } = recordRepoReadme(db, observation);
    if (action === 'ignored') continue;
    if (observation.outcome === 'failed') sweep.failed += 1;
    else sweep.answered += 1;
  }

  return sweep;
}

/**
 * Translates task 6's {@link ReadmeOutcome} into something to store, or `null`
 * when there is nothing new to record.
 *
 * **This is the single point where "known" becomes "an answer", and it is
 * exhaustive over `ReadmeOutcome` on purpose.** Task 6's rule -- honour
 * `no_readme` only when `isReadmeKnown` is true -- is upheld here by
 * construction: `unreadable`, `error` and every `skipped` reason produce
 * either a `failed` observation or nothing at all, and neither can ever be
 * read back as an answer (`src/db/repoReadmes.ts`'s `isReadmeAnswered`
 * inspects one column, which only an answer can set). A test walks every
 * outcome kind and asserts the two modules agree, so adding a branch to
 * either one without the other fails.
 *
 * `cached` is known but records NOTHING -- it came out of this very table, so
 * re-storing it would move the answer clock forward on evidence no newer than
 * what produced it.
 */
export function readmeObservationFor(
  outcome: ReadmeOutcome,
  ref: { repoId: number; fullName: string; observedAt: string },
): ReadmeObservation | null {
  switch (outcome.kind) {
    case 'fetched': {
      // A README that yields no prose is README-less to a reader, which is
      // what §4 cares about -- but it is a different FACT from having no file
      // at all, and an operator asking "why is this repo not in my lane"
      // deserves the real answer. `toExcerpt` is the same blank -> null rule
      // `makeRepo` applies, so the two cannot disagree about what counts.
      const paragraph = toExcerpt(outcome.firstParagraph);
      if (paragraph === null) {
        return { ...ref, outcome: 'no_prose', readmePath: outcome.path };
      }
      return { ...ref, outcome: 'present', firstParagraph: paragraph, readmePath: outcome.path };
    }
    case 'absent':
      return { ...ref, outcome: 'absent' };
    case 'unreadable':
      return { ...ref, outcome: 'failed', failure: 'unreadable', detail: outcome.why };
    case 'error':
      return {
        ...ref,
        outcome: 'failed',
        failure: 'error',
        detail: `HTTP ${outcome.status ?? 'none'}: ${outcome.message}`,
      };
    case 'cached':
    case 'skipped':
      return null;
  }
}

/**
 * Whether a stored answer may still be honoured. An unanswered record is never
 * fresh -- there is nothing to honour -- which is what keeps a failed attempt
 * from ever short-circuiting a request.
 */
function isFresh(record: RepoReadmeRecord | null, now: string): boolean {
  if (record === null || record.outcome === null || record.answeredAt === null) return false;
  const window = record.outcome === 'present' ? ANSWER_FRESH_FOR_MS : NO_README_FRESH_FOR_MS;
  return Date.parse(now) - Date.parse(record.answeredAt) < window;
}

/**
 * The priority order task 6's top-N prefix is taken from.
 *
 * Three tiers, cheapest-visible-improvement first:
 *
 *  0. **Never attempted.** The lane has nothing at all for this repo.
 *  1. **Attempted, never answered.** Visibly identical to tier 0, but a
 *     request was already spent on it, so it yields. Oldest attempt first.
 *     Without this tier a handful of permanently-failing repos would consume
 *     the entire hourly budget on every poll forever and nothing new would
 *     ever be covered.
 *  2. **Answered but stale.** The row renders correctly today; a refresh is
 *     maintenance. Oldest answer first.
 *
 * Fresh answers fall through to the end and cost nothing -- `enrichRepos`
 * checks the cache before the top-N cap, so they never occupy a slot.
 *
 * Within tier 0, order is stars descending. Stars is a PROXY, and knowingly
 * the wrong ranking key by §4's own argument ("a repo going 40->400 in a week
 * matters more than one sitting at 30k") -- but velocity is
 * `insufficient_history` for every repo until seven days of snapshots exist,
 * so ordering by it today is ordering by a constant. What makes the proxy
 * acceptable is that the order decides only who is covered FIRST, never who is
 * covered at all: cached repos are free, so coverage reaches 100% either way.
 * `githubId` is the final total tiebreak, so a sweep is deterministic.
 */
function orderCandidates(
  candidates: readonly Candidate[],
  stored: Map<number, RepoReadmeRecord>,
  now: string,
): Candidate[] {
  const tierOf = (candidate: Candidate): number => {
    const record = stored.get(candidate.facts.githubId) ?? null;
    if (record === null) return 0;
    if (record.outcome === null) return 1;
    return isFresh(record, now) ? 3 : 2;
  };

  return [...candidates].sort((a, b) => {
    const tierA = tierOf(a);
    const tierB = tierOf(b);
    if (tierA !== tierB) return tierA - tierB;

    if (tierA === 1) {
      const at = stored.get(a.facts.githubId)!.attemptedAt;
      const bt = stored.get(b.facts.githubId)!.attemptedAt;
      if (at !== bt) return at < bt ? -1 : 1;
    } else if (tierA === 2) {
      const at = stored.get(a.facts.githubId)!.answeredAt!;
      const bt = stored.get(b.facts.githubId)!.answeredAt!;
      if (at !== bt) return at < bt ? -1 : 1;
    } else if (a.facts.stars !== b.facts.stars) {
      return b.facts.stars - a.facts.stars;
    }
    return a.facts.githubId - b.facts.githubId;
  });
}

/**
 * Every distinct repo currently stored from a `github_search` source.
 *
 * **Deduplicated on GitHub's numeric id, not on `item_key`.** A renamed repo
 * has two keys and two item chains (task 2's finding), and asking GitHub for
 * the same repository twice under two names would spend two of eight requests
 * to learn one thing. The newer `fetched_at` wins, so the surviving candidate
 * carries the name the repo answers to now.
 */
function readCandidates(
  db: Db,
  searchSources: readonly Source[],
): { candidates: Candidate[]; unusable: number } {
  const ids = searchSources.map((s) => s.id);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(SELECT_LATEST.replaceAll('SOURCE_IDS', placeholders))
    .all(...ids, ...ids) as Array<{
    item_key: string;
    raw_json: string | null;
    fetched_at: string;
  }>;

  const byRepoId = new Map<number, Candidate>();
  let unusable = 0;

  for (const row of rows) {
    const repo = parseRepo(row.raw_json);
    if (repo === null) {
      unusable += 1;
      continue;
    }
    const existing = byRepoId.get(repo.githubId);
    if (existing !== undefined && existing.seenAt >= row.fetched_at) continue;
    byRepoId.set(repo.githubId, { repo, facts: toFacts(repo), seenAt: row.fetched_at });
  }

  return { candidates: [...byRepoId.values()], unusable };
}

function parseRepo(rawJson: string | null): Repo | null {
  if (rawJson === null) return null;
  try {
    return repoFromSearchItem(JSON.parse(rawJson));
  } catch {
    // Unparseable JSON. `repoFromSearchItem` itself returns null rather than
    // throwing for a well-formed object with bad fields, so this catch is only
    // JSON.parse's.
    return null;
  }
}

/**
 * A `Repo` reduced to the facts task 6 wants -- everything the search response
 * already carried, minus the README it never carries.
 *
 * Named field by field rather than spread: `RepoFacts` is
 * `Omit<RepoInput, 'readmeFirstParagraph'>` and `Repo` is a DIFFERENT shape
 * (it carries the derived `fullName`/`htmlUrl` and the branded `Excerpt`), so
 * a spread would quietly carry fields `makeRepo` does not accept. The
 * excerpt cap is applied twice as a result -- `toExcerpt` is idempotent, and
 * paying that is better than a second parser for the search response.
 */
function toFacts(repo: Repo): RepoFacts {
  return {
    githubId: repo.githubId,
    owner: repo.owner,
    name: repo.name,
    description: repo.description,
    language: repo.language,
    licenseSpdxId: repo.licenseSpdxId,
    stars: repo.stars,
    openIssuesAndPullRequests: repo.openIssuesAndPullRequests,
    lastCommitAt: repo.lastCommitAt,
    isFork: repo.isFork,
    isArchived: repo.isArchived,
  };
}

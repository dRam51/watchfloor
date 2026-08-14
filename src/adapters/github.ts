/**
 * GitHub topic-search adapter (M4a task 4) -- the `github_search` source type.
 *
 * `github_search` has sat in the `SourceType` union since M1 with **no adapter
 * behind it**; `src/scheduler/run.ts`'s `UnsupportedSourceTypeError` names it
 * as out of scope. This file fills that hole. It builds one search query per
 * (topic x recency-half), issues them through `src/fetch/github.ts`'s client,
 * and emits `RawItem`s for `src/normalize/item.ts`.
 *
 * ---------------------------------------------------------------------------
 * §4's `created:>180d OR pushed:>14d` IS NOT EXPRESSIBLE AS ONE QUERY
 * ---------------------------------------------------------------------------
 * Not a limitation worked around; a refusal, in GitHub's own words. Verified
 * live 2026-08-14 -- `q=topic:llm created:>=2026-02-15 OR pushed:>=2026-07-31`
 * returns **HTTP 422**:
 *
 *   "The search contains only logical operators (AND / OR / NOT) without any
 *    search terms. Logical operators only apply to text, not to qualifiers."
 *
 * (Captured verbatim in tests/fixtures/github-search/search-or-422.json, and
 * replayed as a test -- so if GitHub ever starts accepting it, that is a
 * visible change rather than a forgotten assumption. `q=topic:llm OR
 * topic:agents` 422s identically, so this is about qualifiers generally, not
 * about date qualifiers specifically.) Qualifiers in the legacy search API are
 * ANDed, full stop.
 *
 * **The resolution: two queries per topic, unioned in memory, deduplicated on
 * GitHub's numeric repo id.** The two halves are not redundant -- they select
 * genuinely different populations, which is why implementing only one would
 * silently drop a category rather than merely narrow the results:
 *
 *   - `created:>=180d` -- repos created recently, INCLUDING ones now dormant.
 *     Sorted by stars this is, by construction, the "got big fast" list: a
 *     repo cannot have 100k stars and a 4-month-old creation date without
 *     having risen fast. Measured on `topic:llm`: 70,432 repos, page 1 running
 *     106,360 stars down to 1,898.
 *   - `pushed:>=14d` -- repos under active maintenance, INCLUDING old ones.
 *     Measured on `topic:llm`: 24,197 repos, and the page is the household
 *     names (ollama, AutoGPT, firecrawl). Velocity ranking (task 5) is what
 *     then puts the static ones where they belong; that is the point of the
 *     lane, and this half is the control group that proves it works.
 *
 * A repo in only the first half is new-but-dormant; in only the second,
 * old-but-active. Neither is reachable from the other query.
 *
 * **What it costs**, stated rather than buried: exactly 2x the requests. Nine
 * configured topics is 18 search requests per poll, against an unauthenticated
 * ceiling of **10 per minute** (`x-ratelimit-resource: search`, a budget
 * entirely separate from `core`'s 60/hour). So an unauthenticated poll cannot
 * complete a full sweep -- see "Rotation" below for what happens instead.
 *
 * A single-query approximation was considered and rejected. `pushed:>=180d` is
 * a strict superset of the union, but it also admits every repo created years
 * ago and last touched five months ago -- the dormant long tail, which is most
 * of GitHub -- so the approximation is far worse than the thing it
 * approximates.
 *
 * ---------------------------------------------------------------------------
 * THE SORT TRAP, THIRD OCCURRENCE -- and why this adapter sorts by stars
 * ---------------------------------------------------------------------------
 * CLAUDE.md records two prior instances (nvd-cve ascending by CVE id;
 * hn-algolia sorting by all-time relevance). GitHub repo search is the third.
 * Measured live 2026-08-14 on `topic:llm`, 30 results each:
 *
 *   sort=updated   max 230,628 stars, MEDIAN 4, MIN 0 -- every result pushed
 *                  within the hour. Top hits: `lvillani/thing` (0 stars),
 *                  `uchimata2/handoff-skill` (0 stars).
 *   default        max 240,163, median 102,666, min 63,267 -- `affaan-m/ECC`,
 *                  `NousResearch/hermes-agent`, AutoGPT, ollama, firecrawl.
 *   sort=stars     BYTE-IDENTICAL to the default (166,706 bytes both times,
 *                  same 30 repos in the same order). For a bare `topic:`
 *                  query with no free-text term, "best match" IS star order.
 *
 * Neither end produces §4's ranking -- that is task 5's job, from stored
 * velocity, and no search sort can substitute for it. What a sort DOES decide
 * here is which candidates enter the pool at all, and that choice is
 * constrained by something easy to miss:
 *
 *   **Velocity needs the SAME repos to come back day after day.** Seven daily
 *   snapshots of a repo are only obtainable if that repo is in seven
 *   consecutive candidate sets. `sort=updated` returns whatever was pushed in
 *   the last few minutes, so a given repo appears in roughly one page in
 *   eight and never accumulates a window. It is not merely a low-quality
 *   pool -- it is a pool that structurally cannot support the feature.
 *
 * `sort=stars` (with `order=desc`) selects a pool that turns over slowly, so
 * snapshots accumulate. Absolute stars decide MEMBERSHIP; they never decide
 * rank. A star CEILING to exclude the 240k giants was considered and rejected:
 * it would be a second, competing ranking policy living in the adapter, and
 * velocity already demotes anything static.
 *
 * ---------------------------------------------------------------------------
 * THE QUALITY FLOOR, and the evidence for its value
 * ---------------------------------------------------------------------------
 * `stars:>=N`, applied SERVER-SIDE as a query qualifier -- the same route
 * hn-algolia's own `min_points` takes (`numericFilters=points>50` in its url),
 * and the reason neither reports anything through `AdapterResult.filtered`:
 * nothing is fetched and then discarded, so there is nothing to count.
 *
 * The floor's entire job is the SMALL-topic tail, and it is provably inert on
 * the large ones. Measured live, page 1 of `created:>=180d` sorted by stars:
 *
 *   topic:llm                70,432 repos, page 1 bottoms out at 1,898 stars
 *   topic:prompt-injection    2,843 repos, page 1 bottoms out at    17 stars
 *   topic:network-automation    444 repos, page 1 median 2 stars, min 1
 *   topic:netdevops              34 repos, MAX 11 stars, median 0
 *
 * Without a floor, half of `netdevops` is 34 rows of empty scaffolding; with
 * `stars:>=10` it is exactly ONE real repo (`gesh75/multivendor-ai-network-lab`,
 * 11 stars -- the captured fixture). On `llm` the floor changes nothing at all.
 *
 * **Why 10 and not 50.** §4's own worked example is "a repo going 40->400 in a
 * week." A floor at or above 40 makes that observation impossible by
 * construction -- the repo would only enter the pool after the rise it exists
 * to demonstrate. The floor therefore has to sit well below 40, and 10 is high
 * enough to clear the 0-1 star noise that dominates a small topic. Overridable
 * per source via `filters.min_stars`.
 *
 * **What the floor does NOT fix: topic spam at the TOP.** `affaan-m/ECC`
 * carries the `mcp` topic at 240,163 stars. A lower bound cannot touch that,
 * and nothing in this adapter can. Velocity ranking is the only mechanism that
 * addresses it, and only for repos whose star count is actually static.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SUPPRESSED HERE, AND WHAT CANNOT BE
 * ---------------------------------------------------------------------------
 * §4 suppresses forks, archived repos, README-less repos and dismissed ones.
 * Two of those are free here, one is impossible here, and one is deliberately
 * not attempted here:
 *
 *   forks       Already excluded by GitHub itself: repo search omits forks
 *               unless asked. Measured -- `topic:llm pushed:>=14d` returns
 *               24,197; the same query with `fork:true` returns 24,414.
 *   archived    NOT excluded by default; `archived:false` is added to every
 *               query. Measured -- the same query drops from 24,197 to
 *               24,132 with it. Server-side, so an archived repo never
 *               occupies one of the 50 result slots.
 *   no README   **IMPOSSIBLE HERE.** A search result carries no README, so
 *               `readmeExcerpt` is null for EVERY repo this adapter builds and
 *               `hasNoReadme` is true for every one of them. Calling
 *               `intrinsicSuppressionReasons` here -- which looks like correct
 *               reuse of `src/domain/repo.ts` -- would therefore empty the
 *               lane completely. Only `isFork` and `isArchived` are applied,
 *               deliberately and individually. Task 6 owns the README rule,
 *               because task 6 is what fetches READMEs.
 *   dismissed   `isRepoDismissed` exists "to save rate-limit budget" -- but it
 *               saves NONE at this layer, because a search request costs the
 *               same whether it yields 50 repos or 49. The budget it saves is
 *               task 6's, which spends one request PER REPO. Reading it here
 *               would mean handing a `Db` to an adapter (no other adapter has
 *               one) to buy nothing, and `src/api/routes/feed.ts` already
 *               excludes dismissed items from every view regardless.
 *
 * Fork/archived exclusions are counted in `AdapterResult.filtered`. That field's
 * doc comment ties it to `config/sources.yaml`'s `filters` map; here it traces
 * to §4's suppression list instead, which is code, not config. It is still the
 * right field -- these are deliberate content exclusions, not defects
 * (`skipped`) and not a volume ceiling (`capped`) -- and the field's own doc
 * explicitly invites new producers to reuse it rather than add a fourth. Noted
 * so nobody reading a nonzero count goes looking in the wrong file. In practice
 * it is `undefined`, because GitHub excludes both server-side; the local check
 * is the backstop for if that ever changes.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT REPORTED, AND WHY -- `capped` cannot honestly carry it
 * ---------------------------------------------------------------------------
 * One page of `RESULTS_PER_PAGE` per query means most queries leave results
 * behind: `topic:mcp created:>=180d stars:>=10` reports `total_count: 3644`
 * against 50 retrieved. That shortfall is NOT reported, and the omission is
 * deliberate.
 *
 * `AdapterResult.capped` has a **pinned direction invariant** (see its doc
 * comment, which records that the meaning inverted once already): it counts
 * entries at the OLD end of a source's range, never the new end. Both existing
 * producers are anchored to recency. This adapter's truncation is anchored to
 * STARS -- what it leaves behind is the low-star tail, which is neither the old
 * end nor the new end of anything. Setting `capped` here would corrupt the one
 * cross-source invariant that field was explicitly pinned to have, before its
 * first real consumer (M3's source-health page) exists to read it.
 *
 * Reporting it honestly needs either a new field or a deliberate contract
 * change, both in `src/adapters/types.ts`, which this task does not own.
 * Recorded in the task report as a recommendation rather than done quietly the
 * wrong way.
 *
 * ---------------------------------------------------------------------------
 * NO CONDITIONAL REQUESTS EXIST ON THIS ENDPOINT
 * ---------------------------------------------------------------------------
 * The M4a plan asks for ETag revalidation. That fits Core and **cannot exist
 * for Search**: verified live, a search response carries no `etag`, no
 * `last-modified`, and says `cache-control: no-cache`. So `etag` and
 * `lastModified` are reported as `null` on every fetch and `notModified` is
 * always `false`. The prior `FetchState`'s validators are deliberately NOT
 * carried forward the way `notModifiedResult` carries them -- that helper
 * exists so a non-compliant 304 does not lose a working validator, whereas here
 * there was never a validator to keep, and echoing a stale one back would claim
 * a revalidation capability this endpoint does not have.
 *
 * Note also, from the client's own measurements: a 304 is NOT free on the
 * unauthenticated path (replaying a valid ETag drove `x-ratelimit-used`
 * 1 -> 2 -> 3 -> 4). No budget arithmetic anywhere may assume otherwise.
 */

import {
  GitHubClient,
  GitHubRateLimitError,
} from '../fetch/github.ts';
import { makeRepo, isArchived, isFork, type Repo } from '../domain/repo.ts';
import type { Source } from '../sources/load.ts';
import type { FetchState } from '../db/fetchState.ts';
import type { RawItem } from '../normalize/item.ts';
import type { Adapter, AdapterResult } from './types.ts';

// ---------------------------------------------------------------------------
// Constants. Code-owned, not config-owned, except where noted.
// ---------------------------------------------------------------------------

/** §4's `created:>180d` half. */
export const CREATED_WITHIN_DAYS = 180;

/** §4's `pushed:>14d` half. */
export const PUSHED_WITHIN_DAYS = 14;

/**
 * The star floor when a source does not set `filters.min_stars`. See the module
 * doc comment for the measurements behind it, and for why it must stay well
 * below §4's own "40->400" example.
 */
export const DEFAULT_MIN_STARS = 10;

/**
 * Results per query. One page, never paginated -- pagination would multiply an
 * already-tight request budget (18 requests against 10/minute unauthenticated),
 * and the pool this produces is already larger than the lane can show.
 *
 * Code-owned deliberately, for the reason `NVD_RESULTS_PER_PAGE` records in
 * src/adapters/json.ts: a page size in config can drift out of step with the
 * code's own assumptions about it, silently.
 *
 * Sized from measurements, not preference. A 100-result page measured 573 KB;
 * 50 measures 287 KB, against src/fetch/github.ts's 2 MiB ceiling. 50 also
 * reaches meaningfully deeper into a big topic than 30 does (`topic:llm`
 * `created:>=180d` bottoms out at ~3,500 stars at 50, versus 6,775 at 30), and
 * the resulting pool -- 18 queries x 50, deduplicated -- is a few hundred
 * repos, which is what task 6's per-repo enrichment budget has to cover.
 */
export const RESULTS_PER_PAGE = 50;

/**
 * How often the topic order rotates. See `buildSearchRequests`.
 *
 * One hour is short enough that consecutive polls at any realistic
 * `poll_interval` start at different offsets, and long enough that two polls
 * minutes apart (a manual re-run) do not reshuffle for no reason.
 */
export const TOPIC_ROTATION_PERIOD_MS = 60 * 60 * 1000;

/**
 * The env var holding the read-only PAT. Optional: unauthenticated is a real,
 * supported mode, just a much smaller one (10 search requests/minute against
 * 30). The token is read here and handed straight to `GitHubClient`, which
 * keeps it in a private field and never lets it reach a message, a url, or a
 * log line -- this repository is public and a leaked PAT is the owner's GitHub
 * account. **No task creates this token; the owner does.**
 */
export const TOKEN_ENV_VAR = 'WF_GITHUB_TOKEN';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A `github_search` source that cannot produce a valid query at all. Thrown
 * before any network call, deliberately loud: every one of these conditions
 * would otherwise yield zero repos forever, which on a source-health page is
 * indistinguishable from a quiet source -- the exact failure
 * `UnknownJsonSourceError` exists to prevent for JSON sources.
 *
 * `src/sources/load.ts` rejects a topic-less `github_search` source at config
 * load, so this is a second gate rather than the only one. It is kept because
 * a `Source` can also be built by hand (every test fixture in this repo is),
 * and because the `/search` path check below has no config-load equivalent.
 */
export class GitHubSearchConfigError extends Error {
  constructor(sourceId: string, why: string) {
    super(`github_search source "${sourceId}" cannot build a search query: ${why}`);
    this.name = 'GitHubSearchConfigError';
  }
}

/**
 * A 2xx response that is not a search envelope at all. Mirrors
 * `JsonParseError`'s role in src/adapters/json.ts: a body that cannot be read
 * as this endpoint's known shape is a whole-fetch failure the scheduler must
 * record, not a per-entry skip. An `items` array that is merely EMPTY is not
 * this -- that is a healthy quiet poll.
 */
export class GitHubSearchParseError extends Error {
  constructor(url: string, sourceId: string, reason: string) {
    super(
      `could not read ${url} (source "${sourceId}") as a GitHub search response: ${reason}`,
    );
    this.name = 'GitHubSearchParseError';
  }
}

// ---------------------------------------------------------------------------
// Small JSON helpers -- same never-coerce, blank-is-absent conventions as
// src/adapters/json.ts's.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/** One search request this poll intends to make. */
export interface SearchRequest {
  /** The configured topic this query is for. */
  topic: string;
  /** Which half of §4's un-expressible OR this query covers. */
  half: 'created' | 'pushed';
  /** The `q` parameter, exactly as sent. */
  q: string;
  /** The fully-resolved request url. */
  url: string;
}

/**
 * The `YYYY-MM-DD` GitHub date qualifiers use, `days` before `now`.
 *
 * DAY granularity is deliberate, not a limitation of the qualifier: a
 * per-second cutoff would shift the candidate set on every poll, and a pool
 * that shifts continuously cannot accumulate the daily star snapshots velocity
 * is computed from. A day-granular cutoff moves once per day, in step with the
 * snapshot cadence itself.
 *
 * `toISOString()` renders in UTC regardless of the host's zone, so this needs
 * no timezone handling of its own -- consistent with the project's rule against
 * deriving behaviour from the system timezone. (`WF_TZ` governs *snapshot day
 * bucketing*, in src/db/repoSnapshots.ts; this is a query cutoff, where UTC is
 * simply what GitHub interprets a bare date as.)
 */
function dayStringBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The endpoint to query, taken from `source.url`, with one hard requirement:
 * **its path must be under `/search/`.**
 *
 * Not cosmetic. `src/fetch/github.ts` classifies which rate-limit budget a
 * request bills to from the resolved url's PATHNAME -- `/search/...` means the
 * `search` resource (10/minute unauthenticated), anything else means `core`
 * (60/hour, a 6x larger per-window allowance). A `github_search` source
 * misconfigured with, say, `https://api.github.com` would have every one of its
 * 18 requests gated against the wrong, more permissive budget and would overrun
 * the real one silently. That is precisely the bug task 1 fixed for pagination
 * links, arriving through config instead.
 *
 * Requiring the real path also means the scheduler's robots.txt gate -- which
 * checks `source.url`'s own pathname -- covers the path actually requested,
 * rather than an origin the adapter then departs from. (api.github.com serves
 * 404 for /robots.txt, which `fetchRobots` resolves to "no restrictions".)
 */
function searchEndpoint(source: Source): URL {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new GitHubSearchConfigError(source.id, `url ${JSON.stringify(source.url)} is not a valid URL`);
  }
  if (!url.pathname.startsWith('/search/')) {
    throw new GitHubSearchConfigError(
      source.id,
      `url path ${JSON.stringify(url.pathname)} is not a /search/ path -- src/fetch/github.ts ` +
        `derives the rate-limit resource from the pathname, so this would be billed to the ` +
        `"core" budget (60/hour) instead of "search" (10/minute) and overrun the real one`,
    );
  }
  return url;
}

/**
 * Every request this poll will make, in the order it will make them.
 *
 * Pure and `now`-injected, so the whole nine-topic sweep is testable without a
 * single request.
 *
 * ## Rotation, and the silent drop it prevents
 * Nine topics is 18 requests; an unauthenticated poll's entire search budget is
 * 10 per minute. A fixed order therefore means topics near the end of the list
 * are NEVER polled unauthenticated -- not degraded, not delayed: never fetched,
 * with nothing anywhere reporting it. That is the same shape of failure as
 * implementing only one half of §4's OR.
 *
 * The list is rotated by an offset derived from `now`, so consecutive polls
 * start at different topics and the whole list is covered across a few cycles.
 * Derived from the clock rather than persisted, deliberately: `FetchState` has
 * nowhere honest to keep a cursor (its two fields are HTTP validators), and a
 * clock-derived offset stays deterministic under an injected `now`, so it is
 * testable rather than merely plausible. With a PAT the sweep completes every
 * time and rotation is invisible.
 *
 * A topic's two halves stay ADJACENT, and rotation moves whole topics: a sweep
 * cut short mid-list never returns a topic's `created` half without its
 * `pushed` half.
 */
export function buildSearchRequests(source: Source, now: Date): SearchRequest[] {
  const topics = source.filters?.topics;
  if (!Array.isArray(topics) || topics.length === 0) {
    throw new GitHubSearchConfigError(
      source.id,
      'no filters.topics configured -- a topic list is this source type\'s only input',
    );
  }

  const endpoint = searchEndpoint(source);
  const minStars = typeof source.filters?.min_stars === 'number' ? source.filters.min_stars : DEFAULT_MIN_STARS;

  const halves: ReadonlyArray<{ half: 'created' | 'pushed'; qualifier: string }> = [
    { half: 'created', qualifier: `created:>=${dayStringBefore(now, CREATED_WITHIN_DAYS)}` },
    { half: 'pushed', qualifier: `pushed:>=${dayStringBefore(now, PUSHED_WITHIN_DAYS)}` },
  ];

  const offset = Math.floor(now.getTime() / TOPIC_ROTATION_PERIOD_MS) % topics.length;
  const rotated = [...topics.slice(offset), ...topics.slice(0, offset)];

  const requests: SearchRequest[] = [];
  for (const topic of rotated) {
    for (const { half, qualifier } of halves) {
      // `archived:false` is server-side §4 suppression; see the module doc.
      const q = `topic:${topic} archived:false stars:>=${minStars} ${qualifier}`;
      const url = new URL(endpoint);
      url.searchParams.set('q', q);
      // `order` is explicit even though desc is GitHub's default for `stars`:
      // a default that changes is exactly how a sort trap starts.
      url.searchParams.set('sort', 'stars');
      url.searchParams.set('order', 'desc');
      url.searchParams.set('per_page', String(RESULTS_PER_PAGE));
      requests.push({ topic, half, q, url: url.href });
    }
  }
  return requests;
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

/**
 * GitHub's timestamp shape on a repository object: RFC-3339 UTC with a `Z` and
 * no fractional seconds, e.g. `2026-08-14T19:17:38Z`. `assertCanonicalTimestamp`
 * (src/domain/item.ts) requires exactly three fractional digits, so the two
 * disagree by three characters.
 */
const GITHUB_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/**
 * Re-shapes one of GitHub's timestamps into this project's canonical form, or
 * `null` if it is not that shape at all.
 *
 * This RE-SHAPES; it never RE-INTERPRETS. The input already carries an explicit
 * `Z`, so no zone is inferred, no clock is read, and no calendar arithmetic
 * happens -- the instant that comes out is character-for-character the instant
 * that went in, padded to millisecond precision. That is what keeps it inside
 * `src/normalize/item.ts`'s never-guess-a-date rule rather than an exception to
 * it. (It does not validate that the date exists -- neither does
 * `assertCanonicalTimestamp` -- but since nothing is reinterpreted, an
 * impossible date is exactly as wrong on the way out as it was on the way in.)
 */
function toCanonicalInstant(value: string): string | null {
  const match = GITHUB_TIMESTAMP_RE.exec(value);
  if (match === null) return null;
  const fraction = (match[2] ?? '').slice(0, 3).padEnd(3, '0');
  return `${match[1]}.${fraction}Z`;
}

/**
 * Builds a `Repo` from one raw search result, or `null` if that result is
 * defective. Never throws.
 *
 * Exported because it is the read path for a STORED repo item too, not just a
 * live response: `raw` below is pruned but keeps every data field, so a row's
 * `items.raw_json` still yields the full `Repo` through this same function.
 * Tasks 5 and 6 read the database, never an `AdapterResult`, so this is the
 * round trip that actually has to hold -- and the test file asserts it against
 * the pruned form rather than the response, for exactly that reason.
 *
 * ## What counts as defective
 * `fork` and `archived` must be real booleans, not merely truthy/absent.
 * Coercing an absent `archived` to `false` would silently readmit the archived
 * repos §4 suppresses -- a plausible wrong answer, which is the failure mode
 * this codebase is built to refuse. Likewise `pushed_at`: `null` means a repo
 * that has never been pushed to (real, and `lastCommitAgeMs` handles it), but
 * a value that is PRESENT and unparseable is not that -- storing it as `null`
 * would file a live repo as one never touched. That is a defect, and the entry
 * is dropped.
 */
export function repoFromSearchItem(entry: unknown): Repo | null {
  if (!isRecord(entry)) return null;

  const githubId = entry.id;
  const owner = isRecord(entry.owner) ? asString(entry.owner.login) : null;
  const name = asString(entry.name);
  if (typeof githubId !== 'number' || owner === null || name === null) return null;

  if (typeof entry.fork !== 'boolean' || typeof entry.archived !== 'boolean') return null;

  let lastCommitAt: string | null = null;
  if (entry.pushed_at !== null && entry.pushed_at !== undefined) {
    const pushedAt = asString(entry.pushed_at);
    if (pushedAt === null) return null;
    lastCommitAt = toCanonicalInstant(pushedAt);
    if (lastCommitAt === null) return null;
  }

  try {
    return makeRepo({
      githubId,
      owner,
      name,
      description: asString(entry.description),
      language: asString(entry.language),
      // `spdx_id` is `NOASSERTION` for a LICENSE file licensee cannot identify;
      // makeRepo maps that to null rather than rendering it as a license name.
      licenseSpdxId: isRecord(entry.license) ? asString(entry.license.spdx_id) : null,
      stars: entry.stargazers_count as number,
      // Named for what GitHub's field actually counts -- issues AND open pull
      // requests. See src/domain/repo.ts.
      openIssuesAndPullRequests: entry.open_issues_count as number,
      lastCommitAt,
      isFork: entry.fork,
      isArchived: entry.archived,
      // A search result carries no README. This is why the no-README rule
      // cannot be applied at this layer -- see the module doc comment.
      readmeFirstParagraph: null,
    });
  } catch {
    // InvalidRepoError: a non-integer star count, an owner containing a slash,
    // a lastCommitAt that somehow still isn't canonical. One bad repo, dropped;
    // its neighbours are unaffected.
    return null;
  }
}

/**
 * Drops the REST endpoint TEMPLATES from a raw search result, keeping every
 * data field (and `html_url`, which is a page address rather than an API
 * endpoint), recursively.
 *
 * ## Why this adapter prunes when the others store raw verbatim
 * Measured, not assumed: one search result is ~5.8 KB, of which ~30 keys are
 * `*_url` templates -- `archive_url`, `blobs_url`, `git_refs_url`, … -- every
 * one mechanically derivable from `full_name`. Pruning leaves ~1.8 KB, a 69%
 * reduction. `items` is append-only with NO dedupe (`insertItem` appends a row
 * per poll per item unconditionally), so a candidate pool of a few hundred
 * repos re-stores all of that on every single poll, forever. Verbatim storage
 * here is not neutral fidelity; it is unbounded growth recording nothing.
 *
 * A single mechanical RULE rather than a hand-picked keep-list, deliberately:
 * any DATA field GitHub adds later survives automatically, and only endpoint
 * templates are lost. The one real casualty is `mirror_url`, which is neither
 * derivable nor an endpoint -- accepted because it is null on all 50 repos in
 * the live capture, and stated here rather than left to be discovered.
 */
function pruneRawEntry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneRawEntry);
  if (isRecord(value)) {
    const pruned: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key !== 'html_url' && key.endsWith('_url')) continue;
      pruned[key] = pruneRawEntry(nested);
    }
    return pruned;
  }
  return value;
}

/**
 * What one raw entry became. Three outcomes, not two -- which is why
 * `parseEntries` (src/adapters/types.ts) is not reused here: that helper models
 * exactly "parsed" and "skipped", and folding a deliberate §4 suppression into
 * `skipped` would make a healthy poll look like a parser that just broke, the
 * very confusion `filtered` was added to prevent.
 */
type EntryOutcome =
  | { kind: 'item'; githubId: number; item: RawItem }
  | { kind: 'skipped' }
  | { kind: 'filtered' };

/**
 * Maps one raw search result to a `RawItem`.
 *
 * ## The three fields worth arguing about
 *
 * **`url` is the repo's own page, derived rather than taken.** `makeRepo`
 * builds `https://github.com/{owner}/{name}` and canonicalizes it with the same
 * function the ingest path uses, which is what makes `repoItemKey` a pure
 * function of identity -- computable before the repo has ever been ingested.
 * Taking GitHub's `html_url` verbatim would usually agree and occasionally not.
 *
 * **`publishedAt` is `pushed_at`, not `created_at`.** A repository is not
 * "published" once, so neither is right by definition; `pushed_at` is right by
 * consequence. The repos beat's signal half-life is 72h: with `created_at`,
 * every repo in the pool is up to 180 days old at ingest and decays to
 * effectively nothing, which is a permanently empty lane. `pushed_at` is also
 * what §7's row renders as last-commit age, so the date shown and the date
 * decayed against are the same date. The cost, stated: a repo with an
 * automated hourly commit always looks freshest. Velocity ranking is the
 * counterweight, and is the entire architecture of M4a.
 *
 * **`author` is the owner login.** Unlike federal-register's `agencies[0]`
 * (deliberately dropped in src/adapters/json.ts because an issuing organization
 * is a different KIND of fact than a byline), a repo's owner IS its publishing
 * identity, person or organization, and is already half the repo's own
 * identity.
 */
function mapEntry(entry: unknown): EntryOutcome {
  const repo = repoFromSearchItem(entry);
  if (repo === null) return { kind: 'skipped' };

  // NOT `intrinsicSuppressionReasons` -- that also reports `no_readme`, which
  // is true for every repo here, and would empty the lane. See the module doc.
  if (isFork(repo) || isArchived(repo)) return { kind: 'filtered' };

  const record = entry as Record<string, unknown>;
  return {
    kind: 'item',
    githubId: repo.githubId,
    item: {
      url: repo.htmlUrl,
      title: repo.fullName,
      // Verbatim: deciding whether a date parses is normalizeItem's job, never
      // an adapter's. GitHub's `Z`-suffixed form parses there natively.
      publishedAt: asString(record.pushed_at),
      summary: asString(record.description),
      author: repo.owner,
      raw: pruneRawEntry(entry),
    },
  };
}

/**
 * Pulls the `items` array out of a search envelope, or throws. An `items` that
 * is present and empty is a valid envelope reporting zero results -- a quiet
 * topic (or, with the floor applied, a topic with nothing worth showing) is a
 * healthy poll, not a failure.
 */
function extractItems(body: unknown, request: SearchRequest, sourceId: string): unknown[] {
  if (!isRecord(body)) {
    throw new GitHubSearchParseError(request.url, sourceId, 'response body is not a JSON object');
  }
  if (!Array.isArray(body.items)) {
    throw new GitHubSearchParseError(request.url, sourceId, 'no "items" array in the response envelope');
  }
  return body.items;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const githubSearchAdapter: Adapter = {
  type: 'github_search',

  /**
   * One poll: every request `buildSearchRequests` produced, in order, with
   * results unioned and deduplicated on GitHub's numeric repo id.
   *
   * ## Deduplication is on the numeric id, not on `owner/name`
   * The same reasoning `src/db/repoSnapshots.ts` records for snapshot identity:
   * the numeric id survives renames and ownership transfers, and a repo reached
   * through two topics is the same repo. Within one poll the two occurrences
   * are seconds apart and carry identical data, so first-seen wins.
   *
   * ## What happens when the budget runs out mid-sweep
   * A `GitHubRateLimitError` -- whether the client refused locally before
   * sending (`spent: false`) or GitHub refused (`spent: true`) -- **stops the
   * sweep and returns what was already gathered.** Partial results from six of
   * nine topics are genuinely useful; discarding them because the seventh could
   * not be fetched is not. If NOT ONE query completed, the error propagates
   * instead, so the scheduler records a real failure and backs off rather than
   * logging a successful poll that fetched nothing.
   *
   * Deliberately never sleeps until the reset. The client documents why for
   * itself, and the same argument applies here: blocking a scheduler tick
   * converts one exhausted budget into a whole-system stall.
   *
   * ## Any OTHER error fails the whole poll
   * Every query is built by the same code from the same config against the same
   * endpoint, so a 422 (a malformed query), a 5xx, or a transport failure on
   * one is evidence about all of them, not an isolated bad entry. That matches
   * the shared contract's rule: throw when the response cannot be read as the
   * expected thing at all, skip only per-entry defects.
   *
   * ## A fresh client per poll
   * The client's learned budget is per-instance, and a poll is hours from the
   * next, so nothing useful is carried across. Two `github_search` sources
   * polled in one cycle would not share a budget -- but `x-ratelimit-remaining`
   * is GitHub's own server-side counter, so the second client still reads the
   * true remaining figure from its first response and backs off correctly; the
   * cost is at most a one-request overshoot, which GitHub answers with a 403
   * the client already classifies as a rate limit.
   */
  async fetch(source: Source, _state: FetchState | null, now: Date = new Date()): Promise<AdapterResult> {
    const requests = buildSearchRequests(source, now);
    const client = new GitHubClient({
      token: process.env[TOKEN_ENV_VAR],
      baseUrl: new URL(source.url).origin,
    });

    const items: RawItem[] = [];
    const seenRepoIds = new Set<number>();
    let skipped = 0;
    let filtered = 0;
    let completedRequests = 0;

    for (const request of requests) {
      let body: unknown;
      try {
        body = (await client.request<unknown>(request.url)).data;
      } catch (cause) {
        if (cause instanceof GitHubRateLimitError && completedRequests > 0) break;
        throw cause;
      }
      completedRequests++;

      for (const entry of extractItems(body, request, source.id)) {
        let outcome: EntryOutcome;
        try {
          outcome = mapEntry(entry);
        } catch {
          // Backstop only -- mapEntry is written not to throw. Mirrors
          // parseEntries' own catch: a bug costs its own entry, not the batch,
          // and is still counted rather than silently vanishing.
          outcome = { kind: 'skipped' };
        }

        if (outcome.kind === 'skipped') {
          skipped++;
        } else if (outcome.kind === 'filtered') {
          filtered++;
        } else if (!seenRepoIds.has(outcome.githubId)) {
          seenRepoIds.add(outcome.githubId);
          items.push(outcome.item);
        }
      }
    }

    return {
      items,
      // Not an omission -- this endpoint sends neither validator. See the
      // module doc comment; the prior state's values are deliberately not
      // echoed back.
      etag: null,
      lastModified: null,
      notModified: false,
      skipped,
      // Same "undefined rather than a fabricated 0" convention `capped` and
      // `filtered` already use. Normally undefined: GitHub excludes forks and
      // archived repos server-side, so the local check finds nothing to drop.
      ...(filtered > 0 ? { filtered } : {}),
    };
  },
};

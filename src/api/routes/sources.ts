/**
 * The source-health endpoint (M3 task 5). §7:
 *
 *   "Source health page — per source: last success, last failure, error
 *   string, items yielded over the last 7 days, current backoff state.
 *   Silent-failing feeds are the main failure mode of a system like this;
 *   make them loud."
 *
 * Combines `source_fetch_state` (db/migrations/0003_fetch_state.sql, M1) —
 * which already carries every raw field this page needs, one row per
 * source, mutable in place — with `config/sources.yaml` (via the caller's
 * already-loaded `Source[]`, `src/sources/load.ts`) for name, beats, weight,
 * poll_interval, and enabled. A source with no row at all in
 * `source_fetch_state` (configured but never yet polled) is represented
 * explicitly (`everPolled: false`), never silently omitted.
 *
 * ## Route
 * `GET /api/sources` → `{ sources: SourceHealth[] }`, in `config/sources.yaml`'s
 * own declaration order. Deliberately not `/sources` or anything else that
 * could be mistaken for `/health` (src/api/routes/health.ts, the
 * unauthenticated liveness probe) — this endpoint returns real operational
 * detail (error strings, backoff timing) and is protected like every other
 * route by `src/api/auth.ts`'s default-deny hook, which is registered at the
 * Fastify root and therefore covers this route automatically. Per the Wave 2
 * concurrency note, this module never imports or edits `src/api/server.ts`;
 * `registerSources` is composed onto a server exactly like `registerHealth`
 * and `registerAuth` are, by whoever assembles the real server.
 *
 * ## Wire format (the shared Wave 2 convention)
 * camelCase JSON, bare `{ sources: [...] }` (no envelope), canonical
 * `YYYY-MM-DDTHH:mm:ss.sssZ` timestamp strings verbatim, and nulls stay
 * null — a source that has never failed reports `lastFailureAt: null`, not
 * an omitted key or `""`. The mapping from `source_fetch_state`'s
 * snake_case columns is explicit and total (see `FetchStateRecord` and
 * `getAllFetchStateRecords` below), not a generic case-transformer, so an
 * added column cannot silently leak onto the wire un-reviewed.
 *
 * ## "Failing" and "stale", defined
 * A source is **stale** (enabled only) when there is no evidence of a
 * successful poll within ITS OWN `poll_interval` — comparing against a
 * source's own cadence, never a global threshold, per the task brief's own
 * `1d`-vs-`12h` example. A source with no recorded success at all — whether
 * because nothing has ever been attempted (`everPolled: false`) or because
 * every attempt on record has failed — is treated as maximally stale rather
 * than exempted for lack of a number to diff against.
 *
 * A source is **failing** (enabled only) when it is EITHER currently in an
 * explicit error streak (`consecutiveFailures > 0`) OR stale. That "OR" is
 * the whole point of this task: a source with **zero** recorded failures
 * that simply stopped being polled (or whose feed silently stopped
 * publishing) would read as perfectly healthy under a definition of
 * "failing" that only checks `consecutiveFailures`. That is exactly the
 * "silent-failing feed" §7 is most worried about — see
 * `computeSourceHealth`'s own tests (`tests/api/sources.test.ts`, "THE
 * SILENT FAILURE") for the constructed proof. `Task 6`'s "count of failing
 * sources" is meant to sum this one boolean; see `getSourcesHealth` below,
 * which is the direct, HTTP-free entry point for that.
 *
 * `enabled: false` sources never read as broken: `stale`, `failing`, and
 * `inBackoff` are all pinned `false` for a disabled source, regardless of
 * whatever history is on record — a disabled source is an operator
 * decision, not an operational problem. The RAW fields (`lastError`,
 * `consecutiveFailures`, etc.) still pass through whatever history exists,
 * so a source disabled after a run of failures does not have that history
 * erased, only the derived judgement about it.
 *
 * ## The tumbling window, labelled honestly
 * `source_fetch_state.items_yielded_7d` is a TUMBLING window, not a sliding
 * one (see that column's own schema comment): it resets to the latest
 * fetch's item count once more than 7 days have passed since
 * `items_yielded_7d_window_started_at`, and accumulates otherwise. A field
 * simply called "items in the last 7 days" would be quietly wrong outside
 * that reset moment. This module never calls it that: the wire field is
 * `itemsYieldedSinceWindowStart`, always paired with `windowStartedAt`, so
 * the label carries its own caveat rather than asserting a guarantee the
 * data doesn't keep. Both are passed through verbatim from the DB — this
 * module performs no recomputation, clamping, or re-bucketing of its own.
 *
 * ## "Degraded", and why it is NOT `failing` (M4a task 10)
 * A third derived judgement, orthogonal to the two above. `stale` and
 * `failing` are AVAILABILITY facts — is this source being polled, and are
 * those polls succeeding. `degraded` is a COVERAGE fact: this source is
 * polled, on schedule, successfully, and is still structurally unable to
 * observe everything it is configured to observe in one poll.
 *
 * The concrete case, and the only producer today: a `github_search` source
 * issues one request per (topic × recency-half), so nine topics is **18
 * requests against an unauthenticated ceiling of 10 per minute**. Ten go out,
 * eight never do, and the poll returns successfully — `consecutiveFailures: 0`,
 * a fresh `lastSuccessAt`, a healthy item count. Every check on this page says
 * fine. That is the same class of quiet wrongness as the `stale` branch above,
 * and §7's "silent-failing feeds … make them loud" covers it just as directly.
 *
 * **It is deliberately not folded into `failing`,** for three reasons:
 *
 *  1. `failing` is summed by `countFailingSources` into the header strip's
 *     alarm count, whose entire value is that it returns to zero when nothing
 *     is wrong. A sweep short of its budget is **permanent** until the owner
 *     creates a PAT or trims the topic list — no poll can ever clear it — so
 *     counting it there pins the alarm above zero forever, which is how an
 *     alarm stops being read. That would be a worse outcome than the silent
 *     failure it was meant to cure, not a better one.
 *  2. Both of `failing`'s existing branches are recoverable by a successful
 *     poll. This one is recoverable only by a config or credential change.
 *     Different fact, different action, different field.
 *  3. The axes are independent, and a source can be both — proven by a test.
 *     Merging them into one boolean would lose whichever one did not fire.
 *
 * `degraded` follows the same disabled-source rule as `stale`/`failing`/
 * `inBackoff`: pinned `false` for a disabled source, while the raw `sweep`
 * object still passes through, exactly as `lastError` does.
 *
 * ## `sweep` is a PREDICTION, and says so
 * `AdapterResult.coverage` (src/adapters/types.ts, task 10) is the OBSERVED
 * version of this — how many of the planned requests a given poll actually
 * completed. It is not persisted (see the section below), and the API runs in
 * a different process from the scheduler, so this endpoint cannot read it.
 * What it reports instead is derived from `config/sources.yaml` plus the auth
 * mode: how many requests a complete poll of this source *needs*, and what the
 * ceiling *is*. For `github_search` that prediction is exact — the sweep is a
 * pure function of the topic list — and `plannedRequestsPerPoll`
 * (src/adapters/github.ts) is the single shared definition, pinned against
 * `buildSearchRequests` itself by a test so the two cannot drift.
 *
 * What the prediction cannot tell you is which particular poll fell short, or
 * by how much. It answers "can this source ever complete a sweep?", not "did
 * it this time." Both are worth knowing; only the first is knowable here, and
 * inventing the second would be exactly the fabrication the section below
 * refuses.
 *
 * ## `capped` / `filtered` / `skipped` / `coverage`: deliberately NOT on this endpoint
 * `AdapterResult.capped`, `.filtered` and `.coverage` (src/adapters/types.ts)
 * and `SourceOutcome.skippedEntries` (src/scheduler/run.ts) all exist only
 * for the DURATION of one poll cycle — they live on the in-memory
 * `PollReport` the scheduler builds each tick (logged to stdout as a
 * kind-count summary by `src/bin/scheduler.ts`) and are never written to
 * `source_fetch_state` or any other table. `db/migrations/0003_fetch_state.sql`
 * has no column for any of them. There is therefore nothing for this
 * endpoint to read — surfacing them would mean fabricating a value this
 * process cannot see, which is worse than omitting the field. If a later
 * milestone wants them on the health page, they need a persistence layer
 * first (e.g. one more `source_fetch_state` column each, written by
 * `recordSuccess`), and whatever surfaces them must preserve three meanings
 * that are easy to get backwards: `capped` counts entries at the OLD end of
 * a source's range and is NOT a behind-ness ranking (nvd-cve reports
 * `capped` in the hundreds of thousands while holding CVEs published
 * minutes ago — sorting by it would rank the healthiest source as most
 * broken); `filtered` is a third, distinct count of entries a source's OWN
 * `config/sources.yaml` `filters` excluded on purpose (e.g. AP's
 * non-English entries) — not a defect and not a volume cap; and
 * `coverage.truncation.reportedMatches` is star-anchored, approximate at the
 * source, and double-counts across overlapping queries, so its shortfall
 * against `retrievedEntries` is not a number of distinct missed repos.
 *
 * `sweep`/`degraded` below are NOT an exception to this rule. They are
 * computed from `config/sources.yaml` and the auth mode, both of which this
 * process can read directly — nothing about a particular past poll is being
 * asserted. See "`sweep` is a PREDICTION" above.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/connection.ts';
import type { Source } from '../../sources/load.ts';
import { assertCanonicalTimestamp } from '../../domain/item.ts';
import { parsePollIntervalMs } from '../../scheduler/run.ts';
import { plannedRequestsPerPoll, TOKEN_ENV_VAR } from '../../adapters/github.ts';
import { GitHubClient, RATE_LIMITS, type GitHubAuthMode } from '../../fetch/github.ts';

/**
 * The wire shape for one source, `GET /api/sources`'s array element. All
 * camelCase (see module doc comment's "wire format" section).
 */
export interface SourceHealth {
  id: string;
  name: string;
  beats: Source['beats'];
  weight: number;
  /** Configured cadence exactly as written in config/sources.yaml, e.g. "30m", "6h", "1d". */
  pollInterval: string;
  /** `pollInterval` parsed to milliseconds via the SAME parser the scheduler itself uses (src/scheduler/run.ts's parsePollIntervalMs) — never a second, independently-maintained parser. */
  pollIntervalMs: number;
  enabled: boolean;

  /** False when this source has NO row in source_fetch_state at all — configured but never yet polled. See module doc comment. */
  everPolled: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** The exact error string from the most recent failure, or null if none is on record. */
  lastError: string | null;
  consecutiveFailures: number;
  /** When this source next becomes eligible to be retried under backoff, or null when no backoff is in effect. Raw value — see `inBackoff` for whether it is still in the future. */
  nextEligibleAt: string | null;
  /** True only when `nextEligibleAt` is set AND still in the future relative to the request. Always false for a disabled source. */
  inBackoff: boolean;

  /** See module doc comment, "the tumbling window, labelled honestly." NOT a true last-7-days count. */
  itemsYieldedSinceWindowStart: number;
  /** When the current tumbling window started, or null if this source has never succeeded. Pair with itemsYieldedSinceWindowStart to judge how much to trust it. */
  windowStartedAt: string | null;

  /** source_fetch_state.updated_at — when this row was last written, or null if it has never been written at all. */
  updatedAt: string | null;

  /** See module doc comment, "'failing' and 'stale', defined." Always false for a disabled source. */
  stale: boolean;
  /** See module doc comment, "'failing' and 'stale', defined." Always false for a disabled source. */
  failing: boolean;

  /**
   * How big one COMPLETE poll of this source is, against the ceiling it is
   * billed to — or `null` for a source whose poll is a single request and
   * therefore has no such fact. Never a fabricated `{requestsPerPoll: 1}`:
   * `null` means "this concept does not apply here," the same way every other
   * null on this wire means something specific. See the module doc comment,
   * "`sweep` is a PREDICTION, and says so."
   *
   * A RAW config-derived fact, so it passes through for a DISABLED source too
   * — exactly like `lastError` and `consecutiveFailures`. Only `degraded`, the
   * derived judgement about it, is pinned false for one.
   */
  sweep: SweepBudget | null;
  /**
   * True when this source is enabled and its poll cannot cover everything it
   * is configured to cover — succeeding, on schedule, and still only seeing
   * part of the picture. Orthogonal to `failing`, deliberately NOT folded into
   * it; the module doc comment's "'Degraded', and why it is NOT `failing`"
   * section is the full argument. Always false for a disabled source, and
   * false whenever `sweep` is null (no sweep, nothing to fall short of).
   */
  degraded: boolean;
}

/**
 * The size of one complete poll of a multi-request source, against the
 * rate-limit ceiling those requests are billed to. Every field is a plain
 * number or enum rather than a rendered string — a health page decides how to
 * phrase "10 of 18", this module decides what is true.
 */
export interface SweepBudget {
  /**
   * API requests ONE COMPLETE poll of this source needs. For `github_search`
   * this is `topics × 2` (§4's `created:` and `pushed:` halves, which GitHub
   * refuses to express as one query — see src/adapters/github.ts), taken from
   * that adapter's own `plannedRequestsPerPoll` rather than recomputed here.
   */
  requestsPerPoll: number;
  /**
   * The published per-minute ceiling those requests are billed against in
   * `authMode`, read from `RATE_LIMITS` (src/fetch/github.ts) rather than
   * restated — GitHub's own numbers, confirmed live, in one place.
   */
  requestsPerMinute: number;
  /**
   * Whether the POLLER has a credential. Inferred by this process from its own
   * `WF_GITHUB_TOKEN`, using `GitHubClient`'s exact rule (see
   * `detectGitHubAuthMode`).
   *
   * The caveat, stated rather than buried: the API and the scheduler are
   * SEPARATE processes (`src/bin/api.ts`, `src/bin/scheduler.ts`), both started
   * with `--env-file=.env`, so this is an inference across a process boundary
   * rather than an observation of the poller. It is correct for the
   * single-user, single-`.env` deployment this system is built for, and wrong
   * if someone ever runs the two with different environments — in which case
   * this field reports the API's mode, not the poller's.
   */
  authMode: GitHubAuthMode;
  /**
   * False when `requestsPerPoll` exceeds `requestsPerMinute`: this source
   * cannot complete a full sweep in one poll, on any poll, until its config or
   * its credential changes.
   *
   * The comparison is per-MINUTE against a whole poll because the client
   * spaces requests 2s apart (`src/fetch/github.ts`), so 18 requests span ~34
   * seconds and cannot straddle two full rate-limit windows. Measured live:
   * nine topics unauthenticated got **10 of 18** through before the budget
   * refused the eleventh. A future producer that spaces requests far enough
   * apart to span windows would need a different comparison, not just a
   * different number.
   */
  completable: boolean;
}

/**
 * The non-config, non-database inputs `computeSourceHealth` needs. Injected
 * rather than read from the ambient environment inside the computation, for
 * the same reason `now` is: a function that reads a global is one a test can
 * only exercise by mutating that global. `getSourcesHealth` resolves the
 * default once per request and threads it down.
 */
export interface SourceHealthEnv {
  githubAuthMode: GitHubAuthMode;
}

/**
 * Whether this process has a GitHub PAT.
 *
 * Delegates to `GitHubClient` rather than testing `process.env` directly, and
 * the delegation is the point: that class treats a whitespace-only value (a
 * `.env` line left as `WF_GITHUB_TOKEN=`) as an ABSENT credential, not a blank
 * one, because sending `Authorization: Bearer ` would 401 every request. If
 * this module reimplemented the check and the two ever disagreed, the health
 * page would report a 30/minute budget against a poller really on 10 — a
 * plausible wrong answer, which is the failure mode this codebase exists to
 * refuse. Constructing a client performs no I/O and starts nothing; it only
 * assigns fields.
 */
function detectGitHubAuthMode(): GitHubAuthMode {
  return new GitHubClient({ token: process.env[TOKEN_ENV_VAR] }).mode;
}

/**
 * The sweep budget for one source, or `null` when the concept does not apply.
 * `plannedRequestsPerPoll` is the gate: it returns `null` for every source
 * type that is not a multi-request sweep, and for a `github_search` source too
 * malformed to have an honest answer.
 */
function computeSweepBudget(source: Source, authMode: GitHubAuthMode): SweepBudget | null {
  const requestsPerPoll = plannedRequestsPerPoll(source);
  if (requestsPerPoll === null) return null;

  const requestsPerMinute = RATE_LIMITS[authMode].searchPerMinute;
  return {
    requestsPerPoll,
    requestsPerMinute,
    authMode,
    completable: requestsPerPoll <= requestsPerMinute,
  };
}

// ---------------------------------------------------------------------------
// Reading source_fetch_state
// ---------------------------------------------------------------------------

/**
 * The subset of a `source_fetch_state` row this endpoint needs, hydrated to
 * camelCase. Deliberately NOT `src/db/fetchState.ts`'s own `FetchState` /
 * `getFetchState`: that module's hydrated shape omits
 * `items_yielded_7d_window_started_at` and `updated_at` (its one real
 * caller, the scheduler, has no use for either), and both are required
 * here — the window start for the honest tumbling-window label above, and
 * `updated_at` as a "when was this row last touched" signal. Reading
 * directly here avoids widening that module's public surface for this one
 * extra caller.
 */
interface FetchStateRecord {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextEligibleAt: string | null;
  itemsYieldedSinceWindowStart: number;
  windowStartedAt: string | null;
  updatedAt: string;
}

/**
 * Every `source_fetch_state` row, keyed by `source_id` — one query for the
 * whole health page rather than one round trip per configured source,
 * matching the table's own stated purpose (see db/migrations/
 * 0003_fetch_state.sql's schema comment: "so the source-health page can
 * read one row instead of scanning `items` ... for every source on every
 * page load"). A source absent from the returned Map has never been polled
 * at all — `getSourcesHealth` below passes `undefined` through as `null` to
 * `computeSourceHealth` for that case.
 */
function getAllFetchStateRecords(db: Db): Map<string, FetchStateRecord> {
  const rows = db
    .prepare(
      `select source_id, last_success_at, last_failure_at, last_error,
              consecutive_failures, next_eligible_at,
              items_yielded_7d, items_yielded_7d_window_started_at, updated_at
       from source_fetch_state`,
    )
    // node:sqlite cast quirk (CLAUDE.md; src/cluster/store.ts:88-100 is the
    // original discovery, tests/domain/itemBeats.test.ts and
    // src/domain/itemState.ts's getDismissalSignals are the other
    // established instances): the cast target MUST be an inline type
    // literal, never a named interface — tsc's TS2352 "neither type
    // sufficiently overlaps" check rejects a named interface here even
    // though it is structurally identical to this literal, because
    // node:sqlite's `.all()` return type is `Record<string,
    // SQLOutputValue>[]`. Kept inline rather than reusing FetchStateRecord
    // above (whose keys are already camelCase, a different shape) for
    // exactly that reason.
    .all() as Array<{
      source_id: string;
      last_success_at: string | null;
      last_failure_at: string | null;
      last_error: string | null;
      consecutive_failures: number;
      next_eligible_at: string | null;
      items_yielded_7d: number;
      items_yielded_7d_window_started_at: string | null;
      updated_at: string;
    }>;

  const records = new Map<string, FetchStateRecord>();
  for (const row of rows) {
    records.set(row.source_id, {
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
      nextEligibleAt: row.next_eligible_at,
      itemsYieldedSinceWindowStart: row.items_yielded_7d,
      windowStartedAt: row.items_yielded_7d_window_started_at,
      updatedAt: row.updated_at,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// The pure computation — exported so Task 6 (header strip's "count of
// failing sources") and Task 11 (the health page itself) can call it (or
// getSourcesHealth below) directly, server-side, without an HTTP round trip,
// and so it can be unit-tested exhaustively without a database at all. See
// tests/api/sources.test.ts's `computeSourceHealth` suite.
// ---------------------------------------------------------------------------

/**
 * Combines one configured `Source` with its (possibly absent)
 * `source_fetch_state` record into the wire shape, applying the
 * failing/stale/backoff rules documented at the top of this file.
 *
 * `now` is a required parameter, never read from the wall clock here — the
 * same "now is always injected" convention as every other domain module in
 * this project (src/domain/item.ts, src/db/fetchState.ts,
 * src/domain/itemState.ts), and the only way `tests/api/sources.test.ts` can
 * assert staleness/backoff deterministically rather than racing real time.
 */
export function computeSourceHealth(
  source: Source,
  fetchState: FetchStateRecord | null,
  now: string,
  env: SourceHealthEnv = { githubAuthMode: detectGitHubAuthMode() },
): SourceHealth {
  assertCanonicalTimestamp('now', now);

  const pollIntervalMs = parsePollIntervalMs(source.id, source.poll_interval);
  const nowMs = Date.parse(now);

  const lastSuccessAt = fetchState?.lastSuccessAt ?? null;
  const consecutiveFailures = fetchState?.consecutiveFailures ?? 0;
  const nextEligibleAt = fetchState?.nextEligibleAt ?? null;

  // No recorded success at all (never polled, or polled but never once
  // succeeded) is treated as maximally stale. Otherwise: stale iff more time
  // has elapsed since the last success than this source's OWN poll_interval
  // (strict `>` — exactly at the interval is not yet overdue, matching the
  // scheduler's own "not-due" gate in src/scheduler/run.ts).
  const rawStale = lastSuccessAt === null || nowMs - Date.parse(lastSuccessAt) > pollIntervalMs;
  const rawFailing = consecutiveFailures > 0 || rawStale;
  const rawInBackoff = nextEligibleAt !== null && Date.parse(nextEligibleAt) > nowMs;

  // Disabled sources are deliberately not being polled — an operator
  // decision, not an operational problem — so none of the three derived
  // judgement fields may read as broken for one. See module doc comment.
  const enabled = source.enabled;
  const stale = enabled && rawStale;
  const failing = enabled && rawFailing;
  const inBackoff = enabled && rawInBackoff;

  // A coverage fact, not an availability one, and deliberately absent from
  // `rawFailing` above — see the module doc comment's "'Degraded', and why it
  // is NOT `failing`". Same disabled-source rule as the three judgements just
  // above; `sweep` itself is raw and passes through regardless.
  const sweep = computeSweepBudget(source, env.githubAuthMode);
  const degraded = enabled && sweep !== null && !sweep.completable;

  return {
    id: source.id,
    name: source.name,
    beats: source.beats,
    weight: source.weight,
    pollInterval: source.poll_interval,
    pollIntervalMs,
    enabled,

    everPolled: fetchState !== null,
    lastSuccessAt,
    lastFailureAt: fetchState?.lastFailureAt ?? null,
    lastError: fetchState?.lastError ?? null,
    consecutiveFailures,
    nextEligibleAt,
    inBackoff,

    itemsYieldedSinceWindowStart: fetchState?.itemsYieldedSinceWindowStart ?? 0,
    windowStartedAt: fetchState?.windowStartedAt ?? null,

    updatedAt: fetchState?.updatedAt ?? null,

    stale,
    failing,

    sweep,
    degraded,
  };
}

/**
 * The direct, HTTP-free entry point: every configured source's health, in
 * `sources`' own order (i.e. `config/sources.yaml`'s declaration order — no
 * sorting is imposed here; that is a display decision for whoever renders
 * this, not this module's job). One DB query total, via
 * `getAllFetchStateRecords`, regardless of how many sources are configured.
 *
 * `now` defaults to the wall clock for real callers; a test (or a future
 * caller that wants a point-in-time snapshot) may pin it explicitly, the
 * same shape as `computeSourceHealth`'s own `now` and every other
 * `now`-as-parameter module in this codebase.
 */
export function getSourcesHealth(
  db: Db,
  sources: readonly Source[],
  now: string = new Date().toISOString(),
  env: SourceHealthEnv = { githubAuthMode: detectGitHubAuthMode() },
): SourceHealth[] {
  assertCanonicalTimestamp('now', now);
  const fetchStates = getAllFetchStateRecords(db);
  // `env` is resolved ONCE for the whole page rather than defaulted per source,
  // so every row on one response agrees about the auth mode — the same "one
  // instant for the whole cycle" discipline `now` already has.
  return sources.map((source) =>
    computeSourceHealth(source, fetchStates.get(source.id) ?? null, now, env),
  );
}

/**
 * The real "count of failing sources" definition (see module doc comment,
 * "'failing' and 'stale', defined"), shaped `(db, sources) => number` to
 * drop straight into Task 6's `DashboardDeps.countFailingSources` override
 * (`src/api/routes/dashboard.ts`) — that task's own report documents its
 * default (`getFailingSourceCount`, src/domain/headerStrip.ts) as a
 * deliberately minimal placeholder, `consecutive_failures > 0` only, because
 * Task 5 had not landed yet: it explicitly under-counts the "silent" case
 * (stale-but-zero-recorded-failures) this module exists to catch. Passing
 * `countFailingSources` from THIS module as that override at registration
 * time closes the gap with a one-line wiring change — no edit to
 * `dashboard.ts` or `headerStrip.ts` required, matching that report's own
 * stated intent ("that gap should close via `DashboardDeps.countFailingSources`
 * once Task 5 exports something, not by editing `headerStrip.ts`").
 */
export function countFailingSources(db: Db, sources: readonly Source[]): number {
  return getSourcesHealth(db, sources).filter((health) => health.failing).length;
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export interface SourcesRouteDeps {
  db: Db;
  /** Already-validated sources, e.g. `loadSourcesFile('config/sources.yaml')` — this module never reads the YAML file itself. */
  sources: Source[];
}

/**
 * Registers `GET /api/sources`. Protected by whatever auth hook the caller
 * has already registered on `server` (in production, `registerAuth` from
 * src/api/auth.ts, applied at the Fastify root by `buildServer` — see that
 * file for why a hook registered there covers every route regardless of
 * registration order, including this one). This module never registers its
 * own auth and never imports src/api/server.ts, per the Wave 2 concurrency
 * note: `server.ts` is being edited by other tasks in parallel.
 */
export function registerSources(server: FastifyInstance, deps: SourcesRouteDeps): void {
  server.get('/sources', () => {
    const now = new Date().toISOString();
    return { sources: getSourcesHealth(deps.db, deps.sources, now) };
  });
}

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
 * ## `capped` / `filtered` / `skipped`: deliberately NOT on this endpoint
 * `AdapterResult.capped` and `AdapterResult.filtered` (src/adapters/types.ts)
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
 * `recordSuccess`), and whatever surfaces them must preserve two meanings
 * that are easy to get backwards: `capped` counts entries at the OLD end of
 * a source's range and is NOT a behind-ness ranking (nvd-cve reports
 * `capped` in the hundreds of thousands while holding CVEs published
 * minutes ago — sorting by it would rank the healthiest source as most
 * broken); `filtered` is a third, distinct count of entries a source's OWN
 * `config/sources.yaml` `filters` excluded on purpose (e.g. AP's
 * non-English entries) — not a defect and not a volume cap.
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/connection.ts';
import type { Source } from '../../sources/load.ts';
import { assertCanonicalTimestamp } from '../../domain/item.ts';
import { parsePollIntervalMs } from '../../scheduler/run.ts';

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
): SourceHealth[] {
  assertCanonicalTimestamp('now', now);
  const fetchStates = getAllFetchStateRecords(db);
  return sources.map((source) => computeSourceHealth(source, fetchStates.get(source.id) ?? null, now));
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
  server.get('/api/sources', () => {
    const now = new Date().toISOString();
    return { sources: getSourcesHealth(deps.db, deps.sources, now) };
  });
}

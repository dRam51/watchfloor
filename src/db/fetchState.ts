import type { Db } from './connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';

/**
 * Per-source fetch state as the scheduler and a future source-health page
 * see it. Backed by `source_fetch_state` (db/migrations/0003_fetch_state.sql)
 * -- mutable operational state, deliberately not append-only.
 *
 * `itemsYielded7d` is not part of the brief's literal field list, but is
 * added here because the schema is required to maintain it (so the
 * source-health page never has to scan `items`) and a column nothing can
 * read back would be pointless. See recordSuccess for its exact semantics.
 */
export interface FetchState {
  sourceId: string;
  etag: string | null;
  lastModified: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextEligibleAt: string | null;
  itemsYielded7d: number;
}

export interface RecordSuccessOutcome {
  etag: string | null;
  lastModified: string | null;
  itemCount: number;
}

interface FetchStateRow {
  source_id: string;
  etag: string | null;
  last_modified: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  next_eligible_at: string | null;
  items_yielded_7d: number;
  items_yielded_7d_window_started_at: string | null;
  updated_at: string;
}

// Floor for recordFailure's backoff ceiling -- see recordFailure below.
//
// Fix round 1 (task-1-report.md): this used to be applied as a flat cap
// (`min(x, MAX_BACKOFF_MS)`), which let a source whose own poll_interval
// exceeds 6h have its backoff capped BELOW its healthy cadence -- a failing
// instance of a once-a-day source was reachable every 6h, four times more
// often than a healthy instance of the same source. recordFailure now uses
// `max(MAX_BACKOFF_MS, pollIntervalMs)` as the actual ceiling, never
// MAX_BACKOFF_MS alone, so the cap can only ever widen past 6h, never narrow
// a source's own cadence.
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6 hours, per the brief

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function getRow(db: Db, sourceId: string): FetchStateRow | null {
  const row = db.prepare('select * from source_fetch_state where source_id = ?').get(sourceId) as
    | FetchStateRow
    | undefined;
  return row ?? null;
}

function hydrate(row: FetchStateRow): FetchState {
  return {
    sourceId: row.source_id,
    etag: row.etag,
    lastModified: row.last_modified,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    nextEligibleAt: row.next_eligible_at,
    itemsYielded7d: row.items_yielded_7d,
  };
}

export function getFetchState(db: Db, sourceId: string): FetchState | null {
  const row = getRow(db, sourceId);
  return row ? hydrate(row) : null;
}

// Single upsert used by both recordSuccess and recordFailure: each computes
// a complete next row in JS (arithmetic belongs there, not in SQL CASE
// expressions -- easier to read and test) and writes it here. `excluded.*`
// lets the same bound values serve the INSERT and the UPDATE branch without
// repeating them.
const UPSERT = `
  insert into source_fetch_state (
    source_id, etag, last_modified, last_success_at, last_failure_at, last_error,
    consecutive_failures, next_eligible_at, items_yielded_7d,
    items_yielded_7d_window_started_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict (source_id) do update set
    etag = excluded.etag,
    last_modified = excluded.last_modified,
    last_success_at = excluded.last_success_at,
    last_failure_at = excluded.last_failure_at,
    last_error = excluded.last_error,
    consecutive_failures = excluded.consecutive_failures,
    next_eligible_at = excluded.next_eligible_at,
    items_yielded_7d = excluded.items_yielded_7d,
    items_yielded_7d_window_started_at = excluded.items_yielded_7d_window_started_at,
    updated_at = excluded.updated_at
`;

function upsert(db: Db, row: FetchStateRow): void {
  db.prepare(UPSERT).run(
    row.source_id,
    row.etag,
    row.last_modified,
    row.last_success_at,
    row.last_failure_at,
    row.last_error,
    row.consecutive_failures,
    row.next_eligible_at,
    row.items_yielded_7d,
    row.items_yielded_7d_window_started_at,
    row.updated_at,
  );
}

/**
 * Records a successful fetch: stores the latest conditional-request
 * validators, resets backoff, and rolls `itemsYielded7d` forward.
 *
 * `itemsYielded7d` is a tumbling window, not a true sliding one: it resets to
 * `outcome.itemCount` whenever more than 7 days have passed since the window
 * started (or on a source's very first success), and accumulates otherwise.
 * That trades a small amount of accuracy right after each reset for not
 * needing a per-fetch log table -- source_fetch_state stays one row per
 * source, matching its "operational state" role.
 *
 * `now` defaults to the wall clock, mirroring `insertItem`'s `createdAt`
 * (src/domain/item.ts); a caller may pass an explicit value for testability,
 * the same shape as `isEligible`'s required `now`.
 */
export function recordSuccess(
  db: Db,
  sourceId: string,
  outcome: RecordSuccessOutcome,
  now: string = nowIso(),
): void {
  assertCanonicalTimestamp('now', now);

  const existing = getRow(db, sourceId);
  const windowStart = existing?.items_yielded_7d_window_started_at ?? null;
  const windowExpired =
    windowStart === null || Date.parse(now) - Date.parse(windowStart) >= SEVEN_DAYS_MS;

  upsert(db, {
    source_id: sourceId,
    etag: outcome.etag,
    last_modified: outcome.lastModified,
    last_success_at: now,
    last_failure_at: existing?.last_failure_at ?? null,
    last_error: existing?.last_error ?? null,
    consecutive_failures: 0,
    next_eligible_at: null,
    items_yielded_7d: windowExpired
      ? outcome.itemCount
      : (existing?.items_yielded_7d ?? 0) + outcome.itemCount,
    items_yielded_7d_window_started_at: windowExpired ? now : windowStart,
    updated_at: now,
  });
}

/**
 * Records a failed fetch and applies exponential backoff:
 * `nextEligibleAt = now + min(pollIntervalMs * 2^consecutiveFailures, ceilingMs)`,
 * where `ceilingMs = max(MAX_BACKOFF_MS, pollIntervalMs)`, using the
 * just-incremented consecutiveFailures -- so the delay strictly doubles on
 * every consecutive failure (2x, 4x, 8x, ... pollIntervalMs) until the
 * ceiling.
 *
 * INVARIANT: a source in backoff must never become eligible sooner than its
 * own healthy pollIntervalMs, at any failure count. A flat
 * `min(x, MAX_BACKOFF_MS)` cap breaks this for any source whose
 * poll_interval exceeds 6h -- see MAX_BACKOFF_MS's comment and
 * task-1-report.md's fix-round-1 entry for the worked example that caught
 * it. Widening the ceiling to `max(MAX_BACKOFF_MS, pollIntervalMs)` restores
 * it: both the first doubling (`pollIntervalMs * 2`) and the ceiling itself
 * are bounded below by pollIntervalMs, so the invariant holds at every
 * failure count, not just in the limit.
 *
 * `pollIntervalMs` is the source's configured poll_interval
 * (config/sources.yaml, parsed by the caller -- this module has no YAML
 * access) in milliseconds. Required, not optional, unlike `now`: there is no
 * safe universal default for it that wouldn't silently reintroduce the bug
 * above for a caller that omits it.
 *
 * Conditional-request validators and the last success are left untouched: a
 * failed attempt doesn't invalidate the last known-good state.
 *
 * `now` defaults to the wall clock; see recordSuccess.
 */
export function recordFailure(
  db: Db,
  sourceId: string,
  error: string,
  pollIntervalMs: number,
  now: string = nowIso(),
): void {
  assertCanonicalTimestamp('now', now);

  const existing = getRow(db, sourceId);
  const consecutiveFailures = (existing?.consecutive_failures ?? 0) + 1;
  const ceilingMs = Math.max(MAX_BACKOFF_MS, pollIntervalMs);
  const delayMs = Math.min(pollIntervalMs * 2 ** consecutiveFailures, ceilingMs);
  const nextEligibleAt = new Date(Date.parse(now) + delayMs).toISOString();

  upsert(db, {
    source_id: sourceId,
    etag: existing?.etag ?? null,
    last_modified: existing?.last_modified ?? null,
    last_success_at: existing?.last_success_at ?? null,
    last_failure_at: now,
    last_error: error,
    consecutive_failures: consecutiveFailures,
    next_eligible_at: nextEligibleAt,
    items_yielded_7d: existing?.items_yielded_7d ?? 0,
    items_yielded_7d_window_started_at: existing?.items_yielded_7d_window_started_at ?? null,
    updated_at: now,
  });
}

/**
 * Whether a source is eligible to be polled at `now`: true when it has never
 * been fetched, has no backoff in effect, or `now` has reached (inclusive)
 * `nextEligibleAt`. A source in backoff is meant to be skipped by the
 * scheduler for this cycle, not retried in-loop.
 */
export function isEligible(db: Db, sourceId: string, now: string): boolean {
  assertCanonicalTimestamp('now', now);

  const row = getRow(db, sourceId);
  if (!row || row.next_eligible_at === null) return true;
  return row.next_eligible_at <= now;
}

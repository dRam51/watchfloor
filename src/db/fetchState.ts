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

// Base unit for exponential backoff. The brief's formula is
// `poll_interval * 2^consecutiveFailures`, but `poll_interval` is per-source
// config (config/sources.yaml, read by src/sources/load.ts) that this module
// has no access to: fetchState.ts takes only a Db and plain identifiers, and
// the brief's recordFailure signature has no room for a source's config to
// pass through. A fixed base stands in for it -- every source backs off from
// the same starting point. If per-source pacing turns out to matter, the
// scheduler task (which holds both the loaded Source and this state) is the
// place to add it, e.g. by widening recordFailure with an optional override.
const BASE_BACKOFF_MS = 60_000; // 1 minute
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
 * `nextEligibleAt = now + min(BASE_BACKOFF_MS * 2^consecutiveFailures, MAX_BACKOFF_MS)`,
 * using the just-incremented consecutiveFailures -- so the delay strictly
 * doubles on every consecutive failure (2x, 4x, 8x, ... base) until the
 * 6-hour cap. Conditional-request validators and the last success are left
 * untouched: a failed attempt doesn't invalidate the last known-good state.
 *
 * `now` defaults to the wall clock; see recordSuccess.
 */
export function recordFailure(db: Db, sourceId: string, error: string, now: string = nowIso()): void {
  assertCanonicalTimestamp('now', now);

  const existing = getRow(db, sourceId);
  const consecutiveFailures = (existing?.consecutive_failures ?? 0) + 1;
  const delayMs = Math.min(BASE_BACKOFF_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
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

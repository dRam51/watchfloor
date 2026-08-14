import { apiFetch } from './client.ts';

/**
 * Wire types + fetcher for `GET /api/sources` (src/api/routes/sources.ts).
 *
 * Verified against the RUNNING server and the route's own source (2026-08-14)
 * rather than transcribed from docs/api.md's prose summary of it, which
 * omits several real fields (`weight`, `pollIntervalMs`, `everPolled`,
 * `inBackoff`, `windowStartedAt`, `updatedAt`) and uses a field name --
 * `itemsYielded7d` -- the actual route does not send; the real field is
 * `itemsYieldedSinceWindowStart` (paired with `windowStartedAt`), chosen by
 * that route specifically so the tumbling-window caveat travels with the
 * name instead of being silently promised away (see that file's own doc
 * comment, "the tumbling window, labelled honestly"). Flagged in this
 * task's report as a documentation gap; not fixed here since docs/api.md is
 * not this task's file to edit.
 */
export interface SourceHealth {
  id: string;
  name: string;
  beats: string[];
  weight: number;
  /** Configured cadence as written in config/sources.yaml, e.g. "30m", "1d". */
  pollInterval: string;
  pollIntervalMs: number;
  enabled: boolean;
  /** False when this source has no row in source_fetch_state at all --
   * configured but never yet polled. Distinct from "polled, never
   * succeeded": both leave `lastSuccessAt` null, but only this field says
   * whether an attempt was ever recorded at all. */
  everPolled: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextEligibleAt: string | null;
  /** True only when `nextEligibleAt` is set and still in the future. Always false for a disabled source. */
  inBackoff: boolean;
  /** A TUMBLING window (resets on rollover), not a sliding one -- see this
   * file's own module comment. Pair with `windowStartedAt` before treating
   * this as anything more than an at-a-glance count. */
  itemsYieldedSinceWindowStart: number;
  windowStartedAt: string | null;
  updatedAt: string | null;
  /** No successful poll within this source's OWN pollInterval (or none on
   * record at all). Always false for a disabled source -- see `failing`. */
  stale: boolean;
  /** enabled && (consecutiveFailures > 0 || stale). The `stale` half is the
   * important one: a source with ZERO recorded errors that simply stopped
   * being polled reads as failing here, which a naive
   * `consecutiveFailures > 0` check would miss entirely -- the exact
   * "silent-failing feed" §7 calls the main failure mode of a system like
   * this. Always false for a disabled source, regardless of history on
   * record (an operator decision, not an operational problem). */
  failing: boolean;
}

export interface SourcesResponse {
  sources: SourceHealth[];
}

export function fetchSourceHealth(token: string): Promise<SourcesResponse> {
  return apiFetch<SourcesResponse>('/api/sources', token);
}

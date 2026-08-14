import type { Db } from '../db/connection.ts';
import { getFetchState } from '../db/fetchState.ts';
import { isPaidAllowed } from '../cost/gate.ts';
import { BEATS, type Beat } from './item.ts';
import type { Source } from '../sources/load.ts';

/**
 * Header-strip data (M3 task 6). §7: "Header strip: last successful refresh
 * per beat, count of failing sources, today's enrichment spend."
 */

// ---------------------------------------------------------------------------
// Per-beat last successful refresh
// ---------------------------------------------------------------------------

export interface BeatRefreshStatus {
  beat: Beat;
  /**
   * The OLDEST `last_success_at` among the beat's ENABLED sources, not the
   * newest -- a deliberate choice, not the only defensible one.
   *
   * The two candidate aggregations answer different questions:
   *   - newest (max) answers "when did anything last arrive for this beat".
   *   - oldest (min) answers "how fresh is EVERYTHING currently shown in
   *     this beat, guaranteed".
   *
   * This project's own §7 framing -- "silent-failing feeds are the main
   * failure mode of a system like this; make them loud" -- rules out max:
   * a beat with five fast-polling sources and one silently-stalled source
   * would show a reassuring "moments ago" timestamp forever, with the
   * stalled source hidden behind its healthy siblings. min surfaces exactly
   * that source's staleness in the one place the owner glances at every
   * morning, instead of requiring a trip to the source-health page (Task 5)
   * to notice.
   *
   * `null` when any contributing enabled source has NEVER succeeded (no
   * `source_fetch_state` row, or one with `last_success_at` still null) --
   * "everything in this beat is at least this fresh" is not a claim that
   * can be made at all in that case, so this deliberately does not fall
   * back to "the oldest of the ones that HAVE succeeded", which would hide
   * the never-succeeded source the same way max would hide a stalled one.
   * `null` also when the beat has zero configured (enabled) sources at all
   * (`repos`/`markets` pre-M4, per the M3 plan's "empty until M4a/M4b").
   *
   * Disabled sources (`enabled: false`) are excluded entirely: a source
   * administratively turned off is not "behind", and letting its
   * (potentially very old) `last_success_at` drag the aggregate down would
   * misreport a beat as stale because of a source nobody expects to poll.
   */
  lastRefreshAt: string | null;
  /** Count of enabled sources contributing to this beat (may be zero). */
  sourceCount: number;
}

/**
 * Per-beat refresh status for all six beats, in `BEATS` canonical order.
 * `sources` is normally `config/sources.yaml`, loaded once at boot
 * (`loadSourcesFile`) and passed in by the caller -- this module has no
 * YAML access of its own, matching `src/db/fetchState.ts`'s own layering.
 */
export function getBeatRefreshStatus(db: Db, sources: readonly Source[]): BeatRefreshStatus[] {
  return BEATS.map((beat) => {
    const beatSources = sources.filter((s) => s.enabled && s.beats.includes(beat));
    if (beatSources.length === 0) {
      return { beat, lastRefreshAt: null, sourceCount: 0 };
    }

    let oldest: string | null = null;
    let anyNeverSucceeded = false;
    for (const source of beatSources) {
      const lastSuccessAt = getFetchState(db, source.id)?.lastSuccessAt ?? null;
      if (lastSuccessAt === null) {
        anyNeverSucceeded = true;
        break;
      }
      // Canonical fixed-width UTC timestamps sort lexicographically the
      // same as chronologically (src/domain/item.ts's assertCanonicalTimestamp
      // comment) -- a plain string `<` is exactly the right comparison here.
      if (oldest === null || lastSuccessAt < oldest) oldest = lastSuccessAt;
    }

    return {
      beat,
      lastRefreshAt: anyNeverSucceeded ? null : oldest,
      sourceCount: beatSources.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Failing-source count -- MINIMAL definition, not Task 5's
// ---------------------------------------------------------------------------

/**
 * Count of enabled sources currently in a failure streak
 * (`consecutive_failures > 0`, per `source_fetch_state`,
 * db/migrations/0003_fetch_state.sql).
 *
 * THIS IS DELIBERATELY MINIMAL and does NOT implement the M3 plan's fuller
 * definition of "failing", which is Task 5's job (source-health endpoint):
 * "a source that last succeeded 40 days ago with zero failures because it
 * is not being polled is the SILENT failure §7 cares most about." That
 * requires reasoning about poll_interval-relative staleness that this
 * function does not attempt, so a source that has gone silent (stopped
 * being scheduled, or is stuck in a very long backoff) with zero recorded
 * consecutive failures is invisible to this count.
 *
 * This is called out explicitly rather than left implicit: whoever wires
 * `registerDashboard` should replace this with Task 5's exported
 * definition once one exists, via the `countFailingSources` override on
 * `DashboardDeps` (src/api/routes/dashboard.ts) -- this function is the
 * default, not the final word.
 */
export function getFailingSourceCount(db: Db, sources: readonly Source[]): number {
  let count = 0;
  for (const source of sources) {
    if (!source.enabled) continue;
    const state = getFetchState(db, source.id);
    if (state && state.consecutiveFailures > 0) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Enrichment spend -- a real measured zero, not a placeholder
// ---------------------------------------------------------------------------

export interface EnrichmentSpendStatus {
  /**
   * `0` only when it is a real structural guarantee (the paid gate is
   * closed, so no billable request can have been made -- see
   * src/cost/gate.ts's own doc comment: "the running system must be
   * incapable of spending money without an explicit WF_ALLOW_PAID_* flag").
   * `null` otherwise -- see `measured`.
   */
  amountUsd: number | null;
  /**
   * `true` when `amountUsd` is a real guarantee. `false` means "unknown",
   * not "zero": there is no spend-metering pipeline in this codebase yet
   * (enrichment itself does not exist before M5), so once
   * WF_ALLOW_PAID_ANTHROPIC is set, this function has no way to measure
   * what, if anything, was actually spent. Reporting `0` in that case would
   * be a hardcoded placeholder masquerading as a measurement -- exactly
   * what this task exists to avoid -- so it reports `null` / unmeasured
   * instead, honestly, until a real metering pipeline lands with M5.
   */
  measured: boolean;
  asOf: string;
  note: string;
}

/**
 * Today's enrichment spend, derived from `src/cost/gate.ts`'s chokepoint
 * rather than a second, independently-maintained notion of "is paid
 * enrichment on". `env` and `now` are both required (no wall-clock or
 * `process.env` default read inside this module), matching this project's
 * "`now` is always injected" convention (src/domain/itemState.ts) and
 * keeping this function trivially deterministic to test.
 */
export function getEnrichmentSpendToday(env: NodeJS.ProcessEnv, now: string): EnrichmentSpendStatus {
  if (!isPaidAllowed('anthropic', env)) {
    return {
      amountUsd: 0,
      measured: true,
      asOf: now,
      note:
        'WF_ALLOW_PAID_ANTHROPIC is unset; src/cost/gate.ts hard-disables every paid enrichment ' +
        'path, so spend is structurally zero, not merely unreported.',
    };
  }

  return {
    amountUsd: null,
    measured: false,
    asOf: now,
    note:
      'WF_ALLOW_PAID_ANTHROPIC is set, but no enrichment spend-metering pipeline exists yet ' +
      '(enrichment itself ships in M5). Reporting a $0 here would be a placeholder, not a ' +
      'measurement -- reporting unmeasured instead.',
  };
}

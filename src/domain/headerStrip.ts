import type { Db } from '../db/connection.ts';
import { getFetchState } from '../db/fetchState.ts';
import { getDailyLlmUsage, getDailyLlmReachability } from '../db/llmCallLog.ts';
import { localDay } from '../db/repoSnapshots.ts';
import { isPaidAllowed } from '../cost/gate.ts';
import { SERVICES, SPEND_CATEGORIES, type CostClass, type SpendCategory } from '../cost/registry.ts';
import { OLLAMA_SERVICE_ID } from '../enrich/llm/ollama.ts';
import { ANTHROPIC_SERVICE_ID } from '../enrich/llm/anthropic.ts';
import type { LlmConfig } from '../enrich/llm/config.ts';
import type { LlmBackendName, LlmUnavailableReason } from '../enrich/llm/types.ts';
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
   * not "zero".
   *
   * M3 shipped this reporting unmeasured whenever the paid gate was open,
   * for want of a metering pipeline. M5 built one (`llm_call_log`), so the
   * unmeasured branch now fires for a REASON rather than for want of data:
   * a call whose backend reported no token counts has an unknown cost, and
   * a day containing one has an unknown total -- zero plus unknown is
   * unknown. Reporting `0` there would be a placeholder masquerading as a
   * measurement, which is exactly what this field exists to avoid.
   */
  measured: boolean;
  asOf: string;
  note: string;
}

/**
 * How the ledger is reached. Optional, and that is deliberate rather than
 * lazy: without it this function reports exactly what it reported before M5,
 * so a caller that has no database (or no enrichment) still gets the
 * structural guarantee it always got.
 */
export interface EnrichmentSpendSources {
  /** The database holding `llm_call_log` (db/migrations/0009). */
  db: Db;
}

/** `WF_TZ` is read from `env`; anything unusable falls back, loudly. */
function usableTimeZone(env: NodeJS.ProcessEnv): string | null {
  const tz = env.WF_TZ;
  if (tz === undefined || tz === '') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

const GATE_SHUT =
  'WF_ALLOW_PAID_ANTHROPIC is unset, so src/cost/gate.ts hard-disables every paid enrichment path';
const GATE_OPEN = 'WF_ALLOW_PAID_ANTHROPIC is set';

/**
 * Today's enrichment spend.
 *
 * ## What changed at M5, and what deliberately did not
 *
 * The M3 task that shipped this reported that it "starts reporting real
 * numbers at M5 without a code change". The **shape** is what that promise
 * was about, and it is unchanged: still `{ amountUsd, measured, asOf, note }`,
 * still `measured: false` meaning UNKNOWN rather than zero, still a `0` only
 * when it is a real guarantee. What it needed was a way to reach the ledger,
 * which is the optional third argument -- the API's own wiring is one extra
 * parameter in `src/api/routes/dashboard.ts` and nothing else.
 *
 * ## Where the numbers come from
 *
 * `llm_call_log` (src/db/llmCallLog.ts), summed over the calendar day `now`
 * falls on **in `WF_TZ`**. Not a UTC day: an America/New_York operator's
 * 20:00 enrichment is already tomorrow in UTC, so a UTC bucket would show
 * their evening's spend under tomorrow's header. Same argument
 * db/migrations/0007 makes for a snapshot day.
 *
 * **A cache hit is not in these numbers**, by construction: it writes no
 * ledger row, because it consumed nothing and cost nothing. So this reports
 * consumption, not activity -- which is what makes a falling number after a
 * cold start a good sign rather than a suspicious one.
 *
 * ## Three zeros that are not the same sentence
 *
 * The note distinguishes them, because §7's whole framing is that silent
 * failure is the main failure mode:
 *
 *   * nothing ran today (enrichment may be broken, or simply idle);
 *   * calls ran and every one of them was free (Ollama is free-forever, and
 *     `computeCost` prices that as MEASURED $0, not as an assumption);
 *   * the paid gate is shut, so no billable call was possible at all.
 *
 * `env` and `now` are both required -- no wall-clock or `process.env` default
 * is read inside this module, matching the project's "`now` is always
 * injected" convention.
 */
export function getEnrichmentSpendToday(
  env: NodeJS.ProcessEnv,
  now: string,
  sources?: EnrichmentSpendSources,
): EnrichmentSpendStatus {
  const gateOpen = isPaidAllowed('anthropic', env);
  const gateNote = gateOpen ? GATE_OPEN : GATE_SHUT;

  // No ledger to read: the pre-M5 answer, unchanged.
  if (sources === undefined) {
    return gateOpen
      ? {
          amountUsd: null,
          measured: false,
          asOf: now,
          note: `${GATE_OPEN}, and this caller supplied no call ledger to measure against. Reporting a $0 here would be a placeholder, not a measurement -- reporting unmeasured instead.`,
        }
      : {
          amountUsd: 0,
          measured: true,
          asOf: now,
          note: `${GATE_SHUT}, so spend is structurally zero, not merely unreported.`,
        };
  }

  const tz = usableTimeZone(env);
  if (tz === null) {
    // "Today" is not answerable without a zone, and neither summing the whole
    // table nor quietly assuming UTC would be an honest substitute -- both
    // produce a wrong number presented as a right one.
    return gateOpen
      ? {
          amountUsd: null,
          measured: false,
          asOf: now,
          note: `${GATE_OPEN}, but WF_TZ is missing or is not a valid IANA timezone, so today's calls cannot be scoped to a day. Reporting unmeasured rather than a figure over the wrong span.`,
        }
      : {
          amountUsd: 0,
          measured: true,
          asOf: now,
          note: `${GATE_SHUT}, so spend is structurally zero. (WF_TZ is missing or invalid, so the call ledger could not be scoped to a day -- fix it for a per-day figure once a paid backend is enabled.)`,
        };
  }

  const day = localDay(now, tz);
  const usage = getDailyLlmUsage(sources.db, day);

  const suffix =
    (usage.unavailableCalls > 0
      ? ` ${usage.unavailableCalls} could not reach a backend at all and consumed nothing.`
      : '') +
    (usage.mixedTimezone
      ? ' NOTE: this day contains calls bucketed under more than one timezone, so it spans a WF_TZ change and does not describe one clean span of hours.'
      : '');

  if (usage.calls === 0) {
    return {
      amountUsd: 0,
      measured: true,
      asOf: now,
      note: `no enrichment calls were made on ${day} (${tz}), so nothing was spent. ${gateNote}. Note that a cache hit makes no call and is therefore not counted here.${suffix}`,
    };
  }

  if (!usage.costMeasured) {
    const contradiction = gateOpen
      ? ''
      : ' This SHOULD NOT BE POSSIBLE with the gate shut -- src/cost/gate.ts is meant to make a billable call unreachable, so an unmeasured cost here indicates a path that bypasses it.';
    return {
      amountUsd: null,
      measured: false,
      asOf: now,
      note: `${usage.unmeasuredCostCalls} of ${usage.calls} enrichment calls on ${day} (${tz}) reported no cost, so the day's total is unknown -- reporting unmeasured rather than a partial sum presented as a total. ${gateNote}.${contradiction}${suffix}`,
    };
  }

  return {
    amountUsd: usage.amountUsd,
    measured: true,
    asOf: now,
    note: `${usage.calls} enrichment call(s) on ${day} (${tz}), ${usage.countedTokens} tokens counted, every cost measured. ${gateNote}.${suffix}`,
  };
}

// ---------------------------------------------------------------------------
// Enrichment status -- §15's "the API returns a clear 'disabled by cost
// policy' status, and the dashboard shows the feature as off" (M5 task 14)
// ---------------------------------------------------------------------------

/**
 * ## Why this is a second field beside `enrichmentSpend`, not more of it
 *
 * §15 asks for three things when a paid path's flag is absent: the scheduler
 * skips the job, the API says "disabled by cost policy", and the dashboard
 * shows the feature as off. M5 task 2 built a backend that *reports*
 * `disabled_by_cost_policy`; nothing rendered it, so §15 was only partly
 * discharged.
 *
 * The obvious move was to widen `enrichmentSpend`. That would have been
 * wrong. There are **three different facts** here, and the M5 plan's RULING 2
 * makes two of them true at once in the shipped configuration:
 *
 *  1. the paid backend is **off by cost policy** — chosen, not broken;
 *  2. enrichment spend is a **measured $0** — already published by
 *     `enrichmentSpend`, and a real guarantee rather than a placeholder;
 *  3. the **local backend is unreachable** — a real problem.
 *
 * Any two of those collapsed produces a dashboard that lies. Folding (1) into
 * (2) makes "off" and "free" the same sentence, so enabling the paid backend
 * would look like a fault; folding (3) into (1) makes a stopped Ollama
 * indistinguishable from a deliberate configuration. So this object publishes
 * (1) and (3), never (2) — {@link getEnrichmentSpendToday} owns the money, and
 * two fields publishing one number are two fields that can disagree.
 */

/** One `WF_ALLOW_PAID_*` category, and whether it is open. */
export interface PaidPathStatus {
  category: SpendCategory;
  /** The exact variable to set. Naming it is the whole remedy. */
  flag: string;
  state: 'enabled' | 'disabled_by_cost_policy';
  /** True when `config/llm.yaml` selects a backend spending against it. */
  selected: boolean;
}

/** The backend `config/llm.yaml` selects, and whether policy permits it. */
export interface ConfiguredBackendStatus {
  name: LlmBackendName;
  /** `null` when the selected backend's config block names no model. */
  model: string | null;
  /** The `docs/costs.md` / `src/cost/registry.ts` row it spends against. */
  serviceId: string;
  costClass: CostClass;
  /** `null` for a free-forever backend — it is gated on nothing. */
  spendCategory: SpendCategory | null;
  /**
   * `disabled_by_cost_policy` means enrichment cannot run **at all**: the
   * backend it was told to use is the one that is hard-disabled. Distinct
   * from a paid path merely being off while a free backend does the work.
   */
  state: 'enabled' | 'disabled_by_cost_policy';
}

/**
 * Whether a backend could be reached, **measured from the call ledger rather
 * than probed**.
 *
 * A probe would be an outbound request issued by a dashboard render, which is
 * both a latency cost on every page load and a fact about a moment nobody
 * asked about. The ledger already records the answer for every call that was
 * actually wanted.
 */
export interface EnrichmentReachability {
  /**
   * `unknown` is a real answer and must never be rendered as health: on the
   * vault cadence a day with no enrichment call is ordinary.
   */
  status: 'reachable' | 'unreachable' | 'unknown';
  /** The WF_TZ calendar day the evidence covers; `null` when there is none. */
  day: string | null;
  attempts: number;
  reached: number;
  unreached: number;
  /** Cost-gate refusals. Counted, and deliberately NOT attempts. */
  costPolicyRefusals: number;
  /**
   * The last attempt's unavailable reason, or `null` when it reached a
   * backend. A **field**, not something to be parsed back out of `detail`:
   * §7.1 keeps judgement server-side, and a frontend that regexes a sentence
   * to decide what to show has moved that judgement into the client.
   *
   * Note it can be non-null while `status` is `reachable` -- `model_missing`
   * and `http_error` both mean something answered. That pairing is the whole
   * point (task 1: collapsing them "sends an operator to restart a healthy
   * daemon").
   */
  reason: LlmUnavailableReason | null;
  detail: string;
}

export interface EnrichmentStatus {
  /** `null` when the caller supplied no `config/llm.yaml`. */
  backend: ConfiguredBackendStatus | null;
  /** Every paid category in the registry, not only the configured one. */
  paidPaths: PaidPathStatus[];
  reachability: EnrichmentReachability;
  asOf: string;
  note: string;
}

/**
 * How the status is reached. Both optional, and both for the same reason
 * {@link EnrichmentSpendSources} is: a caller with neither still gets the
 * structural cost-gate answer, which is pure environment.
 */
export interface EnrichmentStatusSources {
  /** The database holding `llm_call_log` (db/migrations/0009). */
  db?: Db;
  /** `config/llm.yaml`, loaded once at boot. */
  llmConfig?: LlmConfig;
}

/**
 * The service-registry row each backend spends against.
 *
 * Imported constants rather than string literals: `src/cost/registry.ts` is
 * mirrored by `docs/costs.md` and a test asserts the two agree, so a backend
 * pointing at an id that is not in the registry must be a compile-or-test
 * failure rather than a silently unclassified service.
 */
const BACKEND_SERVICE_ID: Record<LlmBackendName, string> = {
  ollama: OLLAMA_SERVICE_ID,
  anthropic: ANTHROPIC_SERVICE_ID,
};

function configuredModel(config: LlmConfig): string | null {
  if (config.backend === 'ollama') return config.ollama.model;
  // The `anthropic:` block is an opaque passthrough at this layer (task 1
  // could not validate a shape task 2 had not designed). Read defensively
  // rather than calling parseAnthropicConfig: a malformed block must not
  // throw out of a dashboard render, and "which model" is not the question
  // this function exists to answer.
  const model = (config.anthropic as { model?: unknown } | undefined)?.model;
  return typeof model === 'string' && model !== '' ? model : null;
}

function describeBackend(config: LlmConfig, env: NodeJS.ProcessEnv): ConfiguredBackendStatus {
  const serviceId = BACKEND_SERVICE_ID[config.backend];
  const entry = SERVICES.find((service) => service.id === serviceId);
  const costClass: CostClass = entry?.costClass ?? 'paid';
  const spendCategory = entry?.category ?? null;
  // A backend with no spend category is gated on nothing and is always
  // enabled. Note the fallback above: an id missing from the registry is
  // treated as PAID and therefore disabled, because the safe answer to "is
  // this billable?" when nobody knows is yes.
  const state =
    spendCategory === null || isPaidAllowed(spendCategory, env)
      ? 'enabled'
      : 'disabled_by_cost_policy';
  return {
    name: config.backend,
    model: configuredModel(config),
    serviceId,
    costClass,
    spendCategory,
    state,
  };
}

const NO_LEDGER: EnrichmentReachability = {
  status: 'unknown',
  day: null,
  attempts: 0,
  reached: 0,
  unreached: 0,
  costPolicyRefusals: 0,
  reason: null,
  detail:
    'no call ledger was supplied, so whether a backend can be reached is unknown -- unknown is not health.',
};

function describeReachability(
  db: Db | undefined,
  env: NodeJS.ProcessEnv,
  now: string,
): EnrichmentReachability {
  if (db === undefined) return NO_LEDGER;

  const tz = usableTimeZone(env);
  if (tz === null) {
    return {
      ...NO_LEDGER,
      detail:
        'WF_TZ is missing or is not a valid IANA timezone, so the call ledger cannot be scoped to a day. Reporting unknown rather than reachability measured over the wrong span.',
    };
  }

  const day = localDay(now, tz);
  const measured = getDailyLlmReachability(db, day);

  const refusals =
    measured.costPolicyRefusals === 0
      ? ''
      : ` ${measured.costPolicyRefusals} call(s) were refused by the cost gate before any request and are NOT counted as attempts -- that is a configuration fact, not a reachability one.`;

  if (measured.latest === null) {
    return {
      status: 'unknown',
      day,
      attempts: measured.attempts,
      reached: measured.reached,
      unreached: measured.unreached,
      costPolicyRefusals: measured.costPolicyRefusals,
      reason: null,
      detail: `nothing tried to reach a backend on ${day} (${tz}), so its state is unknown. Enrichment runs on the vault cadence, so a quiet day is ordinary -- but it is not evidence of health.${refusals}`,
    };
  }

  // The LATEST attempt decides, not the day's totals: a daemon that answered
  // twenty times this morning and has refused every connection since noon is
  // down now, and a majority vote would call it healthy.
  const { latest } = measured;
  return {
    status: latest.reached ? 'reachable' : 'unreachable',
    day,
    attempts: measured.attempts,
    reached: measured.reached,
    unreached: measured.unreached,
    costPolicyRefusals: measured.costPolicyRefusals,
    reason: latest.reason,
    detail: latest.reached
      ? `the last attempt on ${day} (${tz}) reached ${latest.backend}/${latest.model} at ${latest.calledAt}` +
        (latest.reason === null
          ? '.'
          : ` -- it answered '${latest.reason}', which means the backend is UP and something else is wrong.`) +
        ` ${measured.reached} of ${measured.attempts} attempt(s) reached it.${refusals}`
      : `the last attempt on ${day} (${tz}) could not reach ${latest.backend}/${latest.model} at ${latest.calledAt}: ${latest.reason}. ` +
        `${measured.unreached} of ${measured.attempts} attempt(s) failed to connect.${refusals}`,
  };
}

/**
 * What enrichment is configured to do, and whether cost policy and the
 * network are letting it.
 *
 * `env` and `now` are both required and neither is defaulted -- no wall clock
 * and no `process.env` read happens inside this module, matching every other
 * function in it.
 */
export function getEnrichmentStatus(
  env: NodeJS.ProcessEnv,
  now: string,
  sources?: EnrichmentStatusSources,
): EnrichmentStatus {
  const llmConfig = sources?.llmConfig;
  const backend = llmConfig === undefined ? null : describeBackend(llmConfig, env);

  const paidPaths: PaidPathStatus[] = SPEND_CATEGORIES.map((category) => ({
    category,
    flag: `WF_ALLOW_PAID_${category.toUpperCase()}`,
    state: isPaidAllowed(category, env) ? 'enabled' : 'disabled_by_cost_policy',
    selected: backend?.spendCategory === category,
  }));

  const reachability = describeReachability(sources?.db, env, now);

  const note =
    backend === null
      ? 'no llm config was supplied, so which backend enrichment would use is unknown. The cost gates below are still exact -- they are read from the environment, not from config.'
      : backend.state === 'disabled_by_cost_policy'
        ? `config/llm.yaml selects the '${backend.name}' backend, which is disabled by cost policy: set ${`WF_ALLOW_PAID_${(backend.spendCategory ?? '').toUpperCase()}`}=1 to enable it. Nothing falls back to another backend -- a silent substitution would report enrichment as running on a backend it is not (§15).`
        : `config/llm.yaml selects the '${backend.name}' backend (${backend.serviceId}, ${backend.costClass}), which cost policy permits.` +
          (paidPaths.some((path) => path.state === 'enabled')
            ? ''
            : ' Every paid path is hard-disabled, so no enrichment call can originate a charge.');

  return { backend, paidPaths, reachability, asOf: now, note };
}

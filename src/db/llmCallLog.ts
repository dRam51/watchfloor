/**
 * The LLM call ledger (M5 task 3) -- one immutable row per call that reached
 * a backend, and the daily rollup §5's token ceiling and §7's "today's
 * enrichment spend" both read.
 *
 * See db/migrations/0009_llm_enrichment.sql for the schema's reasoning. Three
 * things a reader of THIS file needs to hold onto:
 *
 *  1. **A cache HIT writes nothing here.** No call was made, no tokens were
 *     consumed, no money was spent. That is what keeps the numbers below
 *     meaningful: they are consumption, not activity.
 *  2. **Unknown is never zero.** `LlmUsage` and `LlmCost` both keep "the
 *     backend did not say" apart from a real figure, and so does every column
 *     and every field of {@link DailyLlmUsage}. A day containing one
 *     unmeasured call is an unmeasured day, because zero plus unknown is
 *     unknown.
 *  3. **This module does not decide what an unmetered call costs the
 *     ceiling.** It reports `unmeteredOkCalls`; src/enrich/ceiling.ts charges
 *     them. Substituting a figure here would make the ledger claim a
 *     measurement it does not have.
 *
 * This module writes nothing outside `llm_call_log` and reads no clock:
 * `calledAt` is injected, matching every other storage module here.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from './connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
// localDay lives with the star snapshots because that is where the WF_TZ
// bucketing rule was first written down, and it carries the full reasoning in
// its own doc comment. Imported rather than copied: a second implementation
// of "which calendar day is this instant in" is exactly the kind of drift
// CLAUDE.md flags elsewhere.
import { assertCalendarDay, localDay } from './repoSnapshots.ts';
import type { LlmBackendName, LlmUnavailableReason } from '../enrich/llm/types.ts';

/**
 * One call, as the enrichment wrapper hands it over.
 *
 * Deliberately flat rather than carrying an `LlmResult`: the wrapper has
 * already narrowed the union, and re-narrowing it here would put a second
 * copy of that logic in the storage layer.
 */
export interface LlmCallObservation {
  /** The question this call was answering (src/enrich/cacheKey.ts). */
  cacheKey: string;
  task: string;
  backend: LlmBackendName;
  /** The model as REQUESTED. */
  model: string;
  /** The docs/costs.md / src/cost/registry.ts row this spend belongs to. */
  serviceId: string;
  status: 'ok' | 'unavailable';
  /** Required when `status` is `unavailable`, forbidden otherwise. */
  unavailableReason?: LlmUnavailableReason;
  /** `null` when the backend did not report. Never invent a 0. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** `null` when unmeasured. Never a placeholder 0 -- see LlmCost. */
  amountUsd: number | null;
  costMeasured: boolean;
  latencyMs: number;
  /** Canonical UTC instant. Injected, never a clock read. */
  calledAt: string;
  /** The zone the day bucket is computed in -- always WF_TZ. */
  tz: string;
}

export interface LlmCallRecorded {
  callId: string;
  /** The calendar day in `obs.tz` this call was bucketed into. */
  usageDay: string;
}

const INSERT = `
  insert into llm_call_log
    (call_id, usage_day, tz, called_at, backend, model, service_id, task, cache_key,
     status, unavailable_reason, input_tokens, output_tokens, total_tokens,
     tokens_counted, amount_usd, cost_measured, latency_ms, created_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Records one call, bucketed into the calendar day it falls on in `obs.tz`. */
export function recordLlmCall(db: Db, obs: LlmCallObservation): LlmCallRecorded {
  assertCanonicalTimestamp('calledAt', obs.calledAt);
  const usageDay = localDay(obs.calledAt, obs.tz);

  if (obs.status === 'unavailable' && obs.unavailableReason === undefined) {
    throw new RangeError(
      "an unavailable call must carry its reason -- 'the model was unavailable' and 'the model had nothing to say' are the one distinction the LLM seam exists to keep apart",
    );
  }
  if (obs.status === 'ok' && obs.unavailableReason !== undefined) {
    throw new RangeError('an ok call must not carry an unavailable reason');
  }

  // LlmUsage.counted, recomputed rather than trusted: `total` exists exactly
  // when BOTH halves are real, and a partial total is unrepresentable in the
  // schema. See makeUsage in src/enrich/llm/types.ts.
  const counted = obs.inputTokens !== null && obs.outputTokens !== null;
  const totalTokens = counted ? obs.inputTokens! + obs.outputTokens! : null;

  const callId = randomUUID();
  db.prepare(INSERT).run(
    callId,
    usageDay,
    obs.tz,
    obs.calledAt,
    obs.backend,
    obs.model,
    obs.serviceId,
    obs.task,
    obs.cacheKey,
    obs.status,
    obs.unavailableReason ?? null,
    obs.inputTokens,
    obs.outputTokens,
    totalTokens,
    counted ? 1 : 0,
    obs.amountUsd,
    obs.costMeasured ? 1 : 0,
    obs.latencyMs,
    obs.calledAt,
  );

  return { callId, usageDay };
}

/**
 * Everything that happened on one calendar day, in the shape §5's ceiling and
 * §7's header strip both need.
 *
 * `day` is a caller-supplied calendar label in WF_TZ, not a clock read here --
 * this module never reads the wall clock, matching every other domain module
 * in the project. Callers get it from `localDay(now, env.WF_TZ)`.
 */
export interface DailyLlmUsage {
  day: string;
  /** Every logged call, ok or not. */
  calls: number;
  okCalls: number;
  unavailableCalls: number;
  /**
   * Tokens actually reported, summed over ok calls that reported BOTH halves.
   * This is a floor on the day's real consumption, never an estimate --
   * `unmeteredOkCalls` is the rest of the picture.
   */
  countedTokens: number;
  /**
   * Ok calls that reached a model and reported no usable token count. These
   * consumed real tokens that nobody counted; src/enrich/ceiling.ts charges
   * them a configured worst case rather than letting them read as free.
   *
   * Unavailable calls are deliberately NOT in this number: they produced no
   * completion, and charging them would let a stopped daemon close the
   * ceiling for the day.
   */
  unmeteredOkCalls: number;
  /**
   * Summed spend over calls whose cost was measured, in USD. `0` when nothing
   * ran -- a real guarantee, not an absence of information.
   */
  amountUsd: number;
  /** Calls whose cost was UNKNOWN. Non-zero makes the day unmeasured. */
  unmeasuredCostCalls: number;
  /** False when any call in the day reported an unknown cost. */
  costMeasured: boolean;
  /** Every zone the day's rows were bucketed under, sorted. */
  timezones: string[];
  /**
   * True when the day's rows were bucketed under more than one zone -- i.e.
   * WF_TZ changed, so the rows do not all describe the same span of hours. A
   * consumer summing them is measuring across a seam. Same stance
   * `getSnapshotWindow` takes (src/db/repoSnapshots.ts).
   */
  mixedTimezone: boolean;
}

export function getDailyLlmUsage(db: Db, day: string): DailyLlmUsage {
  assertCalendarDay('day', day);

  // Inline type literal, not a named interface -- see the cast note in
  // src/db/llmCache.ts and CLAUDE.md's "node:sqlite cast quirk".
  const row = db
    .prepare(
      `select
         count(*) as calls,
         sum(case when status = 'ok' then 1 else 0 end) as ok_calls,
         sum(case when status = 'unavailable' then 1 else 0 end) as unavailable_calls,
         sum(case when status = 'ok' and tokens_counted = 1 then total_tokens else 0 end) as counted_tokens,
         sum(case when status = 'ok' and tokens_counted = 0 then 1 else 0 end) as unmetered_ok_calls,
         sum(case when cost_measured = 1 then amount_usd else 0 end) as amount_usd,
         sum(case when cost_measured = 0 then 1 else 0 end) as unmeasured_cost_calls
       from llm_call_log
       where usage_day = ?`,
    )
    .get(day) as {
    calls: number;
    ok_calls: number | null;
    unavailable_calls: number | null;
    counted_tokens: number | null;
    unmetered_ok_calls: number | null;
    amount_usd: number | null;
    unmeasured_cost_calls: number | null;
  };

  const zoneRows = db
    .prepare('select distinct tz from llm_call_log where usage_day = ? order by tz asc')
    .all(day) as Array<{ tz: string }>;
  const timezones = zoneRows.map((r) => r.tz);

  // SQLite's SUM over zero rows is NULL, not 0. Coalesced here rather than in
  // SQL so the distinction stays visible: an empty day is a measured zero,
  // and that is a claim this function is entitled to make.
  const unmeasuredCostCalls = row.unmeasured_cost_calls ?? 0;

  return {
    day,
    calls: row.calls,
    okCalls: row.ok_calls ?? 0,
    unavailableCalls: row.unavailable_calls ?? 0,
    countedTokens: row.counted_tokens ?? 0,
    unmeteredOkCalls: row.unmetered_ok_calls ?? 0,
    amountUsd: row.amount_usd ?? 0,
    unmeasuredCostCalls,
    costMeasured: unmeasuredCostCalls === 0,
    timezones,
    mixedTimezone: timezones.length > 1,
  };
}

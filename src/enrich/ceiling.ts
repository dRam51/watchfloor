/**
 * §5's daily token ceiling, and the policy file behind it (M5 task 3).
 *
 * ## What it does at the limit: refuses
 *
 * §15's stance, which `src/fetch/github.ts` already takes at GitHub's rate
 * limit and CLAUDE.md's zero-dollar rule takes generally: *"Flag absent =
 * code path hard-disabled, never a silent fallback or a deferred retry."* So
 * at the line this returns a `closed` status and the caller sends nothing.
 * There is no sleep, no queue, no "try again in an hour" -- a deferred retry
 * is a promise to spend the budget later, made by code, without anyone asking.
 *
 * And **the refusal is nameable.** `{ status: 'closed', reason:
 * 'daily_token_ceiling' }` carries the day, the ceiling, and what has been
 * charged against it, so a pass that enriched nothing can say WHY: "we
 * stopped because of the ceiling" and "there was nothing to do" are different
 * facts, and collapsing them is the same mistake the LLM seam refuses to make
 * between "the model was unavailable" and "the model had nothing to say".
 *
 * ## It applies to Ollama too, and that is the point
 *
 * Ollama's cost is a hard zero, so a cost ceiling would never bind on it. A
 * TOKEN ceiling does: a runaway local loop is free in dollars and not free in
 * time, in heat, or in the scheduler slot it occupies. The ceiling therefore
 * keys on tokens, which every backend reports, rather than on spend, which
 * only a billable one has.
 *
 * ## The two honest limits of this design, stated rather than discovered
 *
 * 1. **It is a stop line, not a quota.** The check runs BEFORE a call and the
 *    consumption is only known AFTER it, so the day can overshoot by at most
 *    one call. That overshoot is bounded by `config/llm.yaml`'s own
 *    `max_prompt_chars` + `max_output_tokens`, which is what
 *    `unmetered_call_tokens` is derived from. Reserving a worst case up front
 *    instead would refuse calls that would have fit, on every backend, to
 *    tighten a bound that is already bounded.
 * 2. **It bounds tokens PRODUCED, not wall time WASTED.** An `unavailable`
 *    call is charged nothing (see {@link chargedTokens}), so a daemon that
 *    times out on every request will keep being asked. That is deliberate --
 *    charging failures would let a stopped Ollama close the ceiling and
 *    report a budget problem when the real problem is a stopped daemon -- and
 *    the wasted time is bounded by `limits.timeout_ms` instead.
 *
 * This module reads no clock and no `process.env`: `now` and `tz` are both
 * injected, and `tz` is always WF_TZ (src/config/env.ts), never the host's.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import { getDailyLlmUsage, type DailyLlmUsage } from '../db/llmCallLog.ts';
import { localDay } from '../db/repoSnapshots.ts';

export class EnrichmentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentPolicyError';
  }
}

/** Repo-relative, like every other path in this codebase (§12). */
export const DEFAULT_ENRICHMENT_CONFIG_PATH = 'config/enrichment.yaml';

const CeilingSchema = z
  .object({
    // A zero or negative ceiling would refuse every call while looking like a
    // configured budget -- the same class of bad value config/llm.yaml's
    // max_output_tokens rejects, and for the same reason.
    daily_tokens: z
      .number()
      .int()
      .positive('daily_tokens must be positive -- a ceiling of 0 refuses every call while looking like a budget'),
    // The one value whose bad setting is INVISIBLE: charge an unmetered call
    // zero and a backend that never reports usage runs forever under any
    // ceiling, which is precisely the runaway this bound exists to stop.
    unmetered_call_tokens: z
      .number()
      .int()
      .positive('unmetered_call_tokens must be positive -- charging an unmetered call 0 lets a backend that never reports usage run forever'),
  })
  .strict();

const CacheSchema = z
  .object({
    version: z.number().int().nonnegative('cache.version must be a non-negative integer'),
  })
  .strict();

const PolicySchema = z.object({ ceiling: CeilingSchema, cache: CacheSchema }).strict();

/** §5's ceiling, in the shape the code uses. */
export interface TokenCeilingPolicy {
  dailyTokens: number;
  /** What one unmetered ok call is charged. See the config file. */
  unmeteredCallTokens: number;
}

export interface CachePolicy {
  /** Input to the cache key; bumping it retires every answer without a delete. */
  version: number;
}

export interface EnrichmentPolicy {
  ceiling: TokenCeilingPolicy;
  cache: CachePolicy;
}

/** Parses and validates enrichment-policy YAML text. No filesystem access. */
export function parseEnrichmentPolicy(yamlText: string): EnrichmentPolicy {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (cause) {
    throw new EnrichmentPolicyError(
      `enrichment policy is not valid YAML: ${(cause as Error).message}`,
    );
  }

  const result = PolicySchema.safeParse(raw);
  if (!result.success) {
    // Path first, so the message names the offending key -- "ceiling.daily_tokens:
    // must be positive", not a complaint the reader has to go hunting for.
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new EnrichmentPolicyError(`invalid enrichment policy:\n${lines.join('\n')}`);
  }

  const data = result.data;
  return {
    ceiling: {
      dailyTokens: data.ceiling.daily_tokens,
      unmeteredCallTokens: data.ceiling.unmetered_call_tokens,
    },
    cache: { version: data.cache.version },
  };
}

/** Reads and parses the enrichment policy at `path`. */
export function loadEnrichmentPolicy(path: string): EnrichmentPolicy {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new EnrichmentPolicyError(
      `cannot read enrichment policy at ${path}: ${(cause as Error).message}`,
    );
  }
  return parseEnrichmentPolicy(text);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** Facts both branches carry, so a caller can report either without narrowing. */
interface CeilingFacts {
  /** The calendar day in `tz` the check was made against. */
  day: string;
  ceilingTokens: number;
  /** What the day has been charged: counted tokens plus unmetered worst cases. */
  chargedTokens: number;
  /** `ceilingTokens - chargedTokens`, floored at 0 -- never negative. */
  remainingTokens: number;
  /** Tokens the backends actually reported. A floor on real consumption. */
  countedTokens: number;
  /** Ok calls that reported no usable count; each charged `unmeteredCallTokens`. */
  unmeteredOkCalls: number;
  /**
   * True when the day's rows were bucketed under more than one zone, i.e.
   * WF_TZ changed mid-day. The total is then a sum across a seam, and a
   * caller should say so rather than present it as a clean figure.
   */
  mixedTimezone: boolean;
}

export interface CeilingOpen extends CeilingFacts {
  status: 'open';
}

export interface CeilingClosed extends CeilingFacts {
  status: 'closed';
  /**
   * Why the ceiling is shut. A union of one today, and a union on purpose:
   * a caller renders `reason` rather than pattern-matching a message, and a
   * second cap added later widens this instead of overloading the first.
   */
  reason: 'daily_token_ceiling';
  /** Operator-facing, with the numbers in it. Renderable as-is. */
  detail: string;
}

export type CeilingStatus = CeilingOpen | CeilingClosed;

/**
 * What a day's ledger costs the ceiling.
 *
 * Two terms, and the second is the whole argument: tokens the backends
 * reported, PLUS a configured worst case for each ok call that reached a
 * model and reported nothing. An unavailable call contributes zero -- it
 * produced no completion, and charging it would let a stopped daemon close
 * the ceiling.
 */
export function chargedTokens(usage: DailyLlmUsage, ceiling: TokenCeilingPolicy): number {
  return usage.countedTokens + usage.unmeteredOkCalls * ceiling.unmeteredCallTokens;
}

export interface CeilingCheckOptions {
  /** Canonical UTC instant. Injected -- this module never reads a clock. */
  now: string;
  /** WF_TZ. The zone the day boundary comes from, never the host's. */
  tz: string;
  policy: EnrichmentPolicy;
}

/**
 * Whether another call may be made today.
 *
 * "Today" is the calendar day `now` falls on **in `tz`**, which is always
 * WF_TZ. Bucketing by UTC instead would roll the ceiling over in the middle
 * of a New York operator's evening -- 0007 section 4's argument, applied to a
 * budget instead of a denominator.
 */
export function checkTokenCeiling(db: Db, opts: CeilingCheckOptions): CeilingStatus {
  assertCanonicalTimestamp('now', opts.now);
  const day = localDay(opts.now, opts.tz);
  const usage = getDailyLlmUsage(db, day);
  const ceiling = opts.policy.ceiling;
  const charged = chargedTokens(usage, ceiling);

  const facts: CeilingFacts = {
    day,
    ceilingTokens: ceiling.dailyTokens,
    chargedTokens: charged,
    remainingTokens: Math.max(0, ceiling.dailyTokens - charged),
    countedTokens: usage.countedTokens,
    unmeteredOkCalls: usage.unmeteredOkCalls,
    mixedTimezone: usage.mixedTimezone,
  };

  // `>=`, not `>`: at exactly the ceiling the budget is spent. Letting one
  // more call through at the line is how a limit becomes "the limit, plus
  // whatever the next call happens to want".
  if (charged >= ceiling.dailyTokens) {
    return {
      ...facts,
      status: 'closed',
      reason: 'daily_token_ceiling',
      detail:
        `refusing to call the model: ${charged} of ${ceiling.dailyTokens} tokens charged for ${day} (${opts.tz}). ` +
        `Not deferred and not queued -- raise ceiling.daily_tokens in config/enrichment.yaml, or wait for the next local day.` +
        (usage.unmeteredOkCalls > 0
          ? ` ${usage.unmeteredOkCalls} of those call(s) reported no token count and were charged ${ceiling.unmeteredCallTokens} each.`
          : '') +
        (usage.mixedTimezone
          ? ' NOTE: this day contains calls bucketed under more than one timezone, so the total spans a WF_TZ change.'
          : ''),
    };
  }

  return { ...facts, status: 'open' };
}

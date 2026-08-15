/**
 * The enrichment call path: cache, then ceiling, then the backend, then the
 * ledger (M5 task 3).
 *
 * Everything in Wave 2 that wants a model's answer goes through here rather
 * than through {@link LlmBackend} directly. The backend seam is deliberately
 * ignorant of all three concerns -- it takes a prompt and returns a result --
 * and this is the one place they are composed, in a fixed order that each of
 * the four outcomes below depends on.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **Cache lookup.** A hit ends the call: no request, no ledger row, no
 *    tokens, no money. This is what keeps cost near zero over an append-only
 *    corpus that is re-enriched on every pass -- and it is checked BEFORE the
 *    ceiling, deliberately, so a shut ceiling still serves answers already
 *    paid for. A ceiling that blanked the dashboard rather than merely
 *    stopping its growth would be punishing the reader for the budget.
 * 2. **Ceiling check.** Closed means `refused`: nothing is sent, nothing is
 *    logged, nothing is deferred (§15).
 * 3. **The backend call.**
 * 4. **The ledger**, for every call that reached step 3, ok or not. A failure
 *    is consumption of a different kind and the operator needs to see it.
 * 5. **The cache write**, for `ok` only. Unavailability is never stored as an
 *    answer -- see below.
 *
 * ## Four outcomes, and none of them collapses into another
 *
 * `cached`, `ok`, `unavailable`, `refused`. Three of those produce no fresh
 * model text, and §15's "hard refusal, never a silent deferred retry" is only
 * a meaningful stance if a caller can tell them apart -- exactly the argument
 * `src/enrich/llm/types.ts` makes for keeping "the model was unavailable"
 * out of "the model had nothing to say". A pass that enriched zero items must
 * be able to say whether the ceiling stopped it, the daemon was down, or
 * there was simply nothing to do.
 *
 * The union carries that structurally: `text` exists only on the branches
 * that have text, `usage`/`cost` only on the branch that made a call, and
 * `ceiling` only on the refusal. `tests/enrich/cached.test.ts` pins those
 * with `@ts-expect-error`, checked by `npm run typecheck`.
 *
 * ## Why an unavailable result is never cached
 *
 * Storage here is effectively permanent (CLAUDE.md's never-delete rule), so
 * caching "Ollama was not running at 14:02" would turn a five-minute outage
 * into a stored non-answer that outlives it. Failures go to the ledger, which
 * has a status column for exactly this, and the question stays unanswered so
 * the next pass asks it again.
 *
 * An **empty** completion, by contrast, IS cached: `''` on the ok branch means
 * the model had nothing to say, and re-asking that forever is precisely the
 * waste this module exists to prevent.
 */

import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import { getCachedEnrichment, putCachedEnrichment } from '../db/llmCache.ts';
import { recordLlmCall } from '../db/llmCallLog.ts';
import { enrichmentCacheKey } from './cacheKey.ts';
import { checkTokenCeiling, type CeilingClosed, type EnrichmentPolicy } from './ceiling.ts';
import type {
  LlmBackend,
  LlmBackendName,
  LlmCost,
  LlmFinishReason,
  LlmRequest,
  LlmUnavailableReason,
  LlmUsage,
} from './llm/types.ts';

export interface EnrichmentDeps {
  db: Db;
  backend: LlmBackend;
  /**
   * What the backend will apply when a request does not override it --
   * `config/llm.yaml`'s `limits.max_output_tokens` and the backend's own
   * `temperature`, as the composition root loaded them.
   *
   * Supplied here rather than read off the backend because {@link LlmBackend}
   * deliberately exposes no configuration, and the cache key has to describe
   * what actually goes on the wire: without this, lowering
   * `max_output_tokens` in config would leave every existing key matching and
   * keep serving answers generated under the old cap.
   */
  defaults: { maxOutputTokens: number; temperature: number | null };
  policy: EnrichmentPolicy;
  /** WF_TZ. The zone the ceiling's day boundary comes from, never the host's. */
  tz: string;
}

export interface EnrichmentRequest extends LlmRequest {
  /** What the answer is FOR (`summary`, `weekly_blurb`). Part of the cache key. */
  task: string;
  /**
   * The item this answer is about, for provenance. **Never part of the cache
   * key** -- see src/enrich/cacheKey.ts for the corpus evidence behind that.
   * Omit for an answer produced over no single item (§8.1's weekly note).
   */
  itemKey?: string | null;
}

export interface EnrichmentCallOptions {
  /** Canonical UTC instant, always injected. Nothing here reads a clock. */
  now: string;
  timeoutMs?: number;
  maxPromptChars?: number;
  maxResponseBytes?: number;
}

/** Facts every outcome carries, whether or not a call was made. */
interface EnrichmentFacts {
  cacheKey: string;
  task: string;
  backend: LlmBackendName;
  /** The model as REQUESTED. */
  model: string;
  /** The injected `now`. */
  asOf: string;
}

/** Served from storage. No request was made, so there is no usage and no cost. */
export interface EnrichmentServed extends EnrichmentFacts {
  status: 'cached';
  text: string;
  finish: LlmFinishReason;
  /** The model that ANSWERED when this row was written. */
  resolvedModel: string;
  answeredAt: string;
  firstAnsweredAt: string;
}

/** A fresh answer. The only branch that writes both a ledger row and a cache row. */
export interface EnrichmentGenerated extends EnrichmentFacts {
  status: 'ok';
  text: string;
  finish: LlmFinishReason;
  resolvedModel: string;
  usage: LlmUsage;
  cost: LlmCost;
  latencyMs: number;
}

/** The backend could not answer. Logged, charged nothing, never cached. */
export interface EnrichmentUnavailable extends EnrichmentFacts {
  status: 'unavailable';
  reason: LlmUnavailableReason;
  detail: string;
  retryable: boolean;
  usage: LlmUsage;
  cost: LlmCost;
  latencyMs: number;
}

/**
 * The daily token ceiling is shut. **Nothing was sent and nothing was
 * deferred** -- there is no retry hiding behind this value.
 */
export interface EnrichmentRefused extends EnrichmentFacts {
  status: 'refused';
  reason: 'daily_token_ceiling';
  ceiling: CeilingClosed;
}

export type EnrichmentResult =
  | EnrichmentServed
  | EnrichmentGenerated
  | EnrichmentUnavailable
  | EnrichmentRefused;

/** Narrowing guard for the two branches that carry text. */
export function hasEnrichmentText(
  result: EnrichmentResult,
): result is EnrichmentServed | EnrichmentGenerated {
  return result.status === 'cached' || result.status === 'ok';
}

/**
 * Answers one enrichment question, spending a model call only if it has to
 * and only if the day's budget allows it.
 *
 * Throws only what the backend throws for a caller-side error --
 * `LlmPromptTooLargeError` for an oversized prompt, which is deliberately not
 * a branch of the union because no retry can fix it and only the caller can
 * shorten it. Nothing is logged in that case, because nothing was sent.
 */
export async function completeEnrichment(
  deps: EnrichmentDeps,
  request: EnrichmentRequest,
  opts: EnrichmentCallOptions,
): Promise<EnrichmentResult> {
  assertCanonicalTimestamp('now', opts.now);

  const maxOutputTokens = request.maxOutputTokens ?? deps.defaults.maxOutputTokens;
  const temperature = request.temperature ?? deps.defaults.temperature;

  const cacheKey = enrichmentCacheKey({
    cacheVersion: deps.policy.cache.version,
    task: request.task,
    backend: deps.backend.name,
    model: deps.backend.model,
    system: request.system ?? null,
    prompt: request.prompt,
    maxOutputTokens,
    temperature,
  });

  const facts: EnrichmentFacts = {
    cacheKey,
    task: request.task,
    backend: deps.backend.name,
    model: deps.backend.model,
    asOf: opts.now,
  };

  // 1. A hit ends the call -- before the ceiling, so an answer already paid
  //    for is still served once the budget is spent.
  const hit = getCachedEnrichment(deps.db, cacheKey);
  if (hit !== null) {
    return {
      ...facts,
      status: 'cached',
      text: hit.text,
      finish: hit.finish,
      resolvedModel: hit.resolvedModel,
      answeredAt: hit.answeredAt,
      firstAnsweredAt: hit.firstAnsweredAt,
    };
  }

  // 2. The ceiling. Closed means nothing is sent and nothing is logged: no
  //    call was made, so there is nothing to record as consumption.
  const ceiling = checkTokenCeiling(deps.db, {
    now: opts.now,
    tz: deps.tz,
    policy: deps.policy,
  });
  if (ceiling.status === 'closed') {
    return { ...facts, status: 'refused', reason: ceiling.reason, ceiling };
  }

  // 3. The call. `complete` never throws for a transport, HTTP, or
  //    model-availability outcome -- those are the unavailable branch.
  const result = await deps.backend.complete(
    {
      ...(request.system !== undefined ? { system: request.system } : {}),
      prompt: request.prompt,
      maxOutputTokens,
      ...(temperature !== null ? { temperature } : {}),
    },
    {
      now: opts.now,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxPromptChars !== undefined ? { maxPromptChars: opts.maxPromptChars } : {}),
      ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
    },
  );

  // 4. Every call that reached a backend is logged, ok or not. `now` is the
  //    injected instant, not a second clock read, so the ledger row and the
  //    result agree about when this happened.
  recordLlmCall(deps.db, {
    cacheKey,
    task: request.task,
    backend: deps.backend.name,
    model: deps.backend.model,
    serviceId: deps.backend.serviceId,
    status: result.status,
    ...(result.status === 'unavailable' ? { unavailableReason: result.reason } : {}),
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    amountUsd: result.cost.amountUsd,
    costMeasured: result.cost.measured,
    latencyMs: result.latencyMs,
    calledAt: opts.now,
    tz: deps.tz,
  });

  if (result.status === 'unavailable') {
    // 5a. Never cached. See the module doc.
    return {
      ...facts,
      status: 'unavailable',
      reason: result.reason,
      detail: result.detail,
      retryable: result.retryable,
      usage: result.usage,
      cost: result.cost,
      latencyMs: result.latencyMs,
    };
  }

  // 5b. Cached, including an empty completion.
  putCachedEnrichment(deps.db, {
    cacheKey,
    task: request.task,
    backend: deps.backend.name,
    model: deps.backend.model,
    resolvedModel: result.model,
    text: result.text,
    finish: result.finish,
    itemKey: request.itemKey ?? null,
    answeredAt: opts.now,
  });

  return {
    ...facts,
    status: 'ok',
    text: result.text,
    finish: result.finish,
    resolvedModel: result.model,
    usage: result.usage,
    cost: result.cost,
    latencyMs: result.latencyMs,
  };
}

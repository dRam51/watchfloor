/**
 * The pluggable LLM backend seam (M5 task 1).
 *
 * **The interface is the deliverable, not the model choice.** CLAUDE.md
 * records the portability debt this exists to absorb: *"Local LLM inference
 * will differ on the target host. Ollama on Apple Silicon uses Metal; a mini
 * PC without a capable GPU may not run the same model at all."* So no model
 * name appears anywhere in `src/` — it comes from `config/llm.yaml`, the same
 * way a feed source comes from `config/sources.yaml` and never from adapter
 * code — and swapping the whole backend is a `backend:` line in that file.
 *
 * ## The one thing this type must make impossible
 *
 * A caller must never be able to read "the model was unavailable" as "the
 * model returned nothing to say." Those two produce the same `''` in any
 * design where the text is always present, and an empty enrichment stored
 * against an immutable, append-only corpus is indistinguishable from a real
 * one forever. So {@link LlmResult} is a discriminated union on `status`, and
 * `text` (and `finish`) exist **only** on the `ok` branch:
 *
 *     result.text            // does not compile
 *     const { text } = result // does not compile
 *     result.text ?? ''       // does not compile — the access fails first
 *
 * That is asserted, not asserted-about: `tests/enrich/llm/types.test.ts` pins
 * all four reads with `@ts-expect-error` directives checked by `npm run
 * typecheck`, so adding `text` to the unavailable branch — as `''`, as an
 * optional, as a `| null` — makes the directives unused and tsc fails with
 * TS2578. Exactly the technique `src/score/velocity.ts` uses for
 * insufficient star history, and here for the same reason: a plausible wrong
 * answer is worse than a loud absent one.
 *
 * **An unreachable backend is an ordinary, expected state.** Ollama is a
 * process on the host, not a service with an SLA; it is routinely not
 * running. `complete` therefore does not throw for it — it returns the
 * `unavailable` branch, with a `reason` a caller (and §7's header) can render.
 *
 * ## Every backend reports usage and a cost figure, including a hard zero
 *
 * §5 caps daily tokens and §15 requires cost to be visible. A backend that
 * cannot report usage cannot be capped, so {@link LlmUsage} and
 * {@link LlmCost} sit on **both** branches — a call that never reached a
 * model still has to answer "what did that cost?".
 *
 * The zero is *computed*, never special-cased: {@link computeCost} runs the
 * same arithmetic for every backend and Ollama simply has
 * {@link FREE_PRICING}. That yields a genuinely useful property — a
 * free-forever backend's cost stays **measured** even when its token counts
 * are unknown, because zero times unknown is zero — while a billable backend
 * with uncounted tokens reports `null` / unmeasured rather than a placeholder
 * `0`. `src/domain/headerStrip.ts`'s `enrichmentSpend` already draws exactly
 * that distinction; this feeds it rather than replacing it.
 */

import { assertCanonicalTimestamp } from '../../domain/item.ts';

/**
 * Which backends the seam knows about. `anthropic` is listed here — and in
 * `config/llm.yaml`'s `backend:` enum — deliberately, even though M5 task 1
 * ships only Ollama: RULING 2 has Anthropic shipping built and hard-disabled
 * in task 2, and a union it has to widen later is a union every switch
 * statement silently stops covering.
 */
export type LlmBackendName = 'ollama' | 'anthropic';

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

/**
 * What one call consumed, as the backend itself reported it.
 *
 * Every field is nullable because "the backend did not say" is a real answer
 * and inventing a `0` for it would make an unmetered call look free to §5's
 * ceiling. `counted` is denormalized from that — it is the flag a cap must
 * check, and it should not be easy to forget (the same reason
 * `EnrichedRepo.readmeKnown` exists in `src/enrich/repo.ts`).
 */
export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** The sum, or `null` when either half is unknown — never a partial total. */
  totalTokens: number | null;
  /** True only when BOTH halves are real numbers. */
  counted: boolean;
}

/** Builds a {@link LlmUsage} from whatever the backend reported. */
export function makeUsage(inputTokens: number | null, outputTokens: number | null): LlmUsage {
  const counted = inputTokens !== null && outputTokens !== null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: counted ? inputTokens! + outputTokens! : null,
    counted,
  };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** Per-million-token rates. Ollama's are zero; see {@link FREE_PRICING}. */
export interface LlmPricing {
  usdPerMillionInputTokens: number;
  usdPerMillionOutputTokens: number;
}

/**
 * A local backend's rates. Not a placeholder: `ollama-local` is registered
 * `free-forever` in `docs/costs.md` and `src/cost/registry.ts`, meaning no
 * account, no key, and nothing that could ever bill — the charge is
 * structurally zero, which is why {@link computeCost} may call it measured.
 */
export const FREE_PRICING: LlmPricing = {
  usdPerMillionInputTokens: 0,
  usdPerMillionOutputTokens: 0,
};

/**
 * What one call cost, in the shape `/api/dashboard/header`'s `enrichmentSpend`
 * already publishes (`amountUsd` + `measured` + a note). `measured: false`
 * means **unknown**, never zero.
 */
export interface LlmCost {
  amountUsd: number | null;
  /** True only when `amountUsd` is a real figure rather than an unknown. */
  measured: boolean;
  /** Why the figure is what it is. A bare zero explains nothing. */
  note: string;
  /** The `docs/costs.md` / `src/cost/registry.ts` id this spend belongs to. */
  serviceId: string;
}

const MILLION = 1_000_000;

/**
 * Prices one call.
 *
 * Two branches, and the order matters. A **zero-rate** backend is priced
 * first and unconditionally: zero times unknown is still zero, so a local
 * call reports a measured `$0` even when the daemon died before reporting a
 * single token. Only a backend with a nonzero rate needs counted tokens, and
 * without them it reports `null` / unmeasured rather than a `0` that would
 * read as a measurement.
 */
export function computeCost(usage: LlmUsage, pricing: LlmPricing, serviceId: string): LlmCost {
  const free =
    pricing.usdPerMillionInputTokens === 0 && pricing.usdPerMillionOutputTokens === 0;

  if (free) {
    return {
      amountUsd: 0,
      measured: true,
      note: `${serviceId} bills nothing at any volume, so this call cost exactly $0 whether or not its tokens were counted`,
      serviceId,
    };
  }

  if (!usage.counted) {
    return {
      amountUsd: null,
      measured: false,
      note: `${serviceId} is billable but this call reported no token counts, so its cost is unknown -- reporting unmeasured rather than a placeholder $0`,
      serviceId,
    };
  }

  const amountUsd =
    (usage.inputTokens! * pricing.usdPerMillionInputTokens) / MILLION +
    (usage.outputTokens! * pricing.usdPerMillionOutputTokens) / MILLION;

  return {
    amountUsd,
    measured: true,
    note: `${usage.inputTokens} input + ${usage.outputTokens} output tokens at ${serviceId}'s published rates`,
    serviceId,
  };
}

// ---------------------------------------------------------------------------
// The result union
// ---------------------------------------------------------------------------

/** Why generation stopped, on a call that actually produced text. */
export type LlmFinishReason =
  /** The model finished on its own. */
  | 'stop'
  /** The output-token cap was reached. A real, complete-as-far-as-it-goes answer. */
  | 'length'
  /** The backend reported something this seam does not model. Carried, not guessed at. */
  | 'other';

/**
 * Why no text exists. Each is a distinct operator-visible situation, because
 * "Ollama isn't running" and "the configured model was never pulled" need
 * different fixes and a single `error` would collapse them.
 */
export type LlmUnavailableReason =
  /** Nothing accepted the connection: the daemon is not running, or the host is wrong. */
  | 'not_running'
  /** The connection was made and then failed — reset, hang-up, truncated stream. */
  | 'transport_error'
  /** No complete response inside the configured deadline. */
  | 'timeout'
  /** The daemon is up but does not have the configured model. Fix: pull it, or edit config. */
  | 'model_missing'
  /** Any other non-2xx. `detail` carries what the backend said. */
  | 'http_error'
  /** A 2xx whose body was not the documented shape. Never guessed at. */
  | 'malformed_response'
  /** The response crossed the byte ceiling and was aborted mid-stream. */
  | 'response_too_large'
  /**
   * The paid gate is shut (§15). **Ollama can never produce this** — it is
   * local and needs no flag — but the reason lives here so task 2's gated
   * backend reports unavailability through this same union rather than
   * inventing a parallel one. §15's wording, "API reports 'disabled by cost
   * policy'", is what a caller renders from it.
   */
  | 'disabled_by_cost_policy';

/** Facts every call produces, whether or not it produced text. */
interface LlmCallFacts {
  backend: LlmBackendName;
  /**
   * On `ok`, the model that ANSWERED, as the backend named it. On
   * `unavailable`, the model that was ASKED FOR. The distinction matters when
   * a config says `llama3.2` and the daemon resolves `llama3.2:latest`.
   */
  model: string;
  usage: LlmUsage;
  cost: LlmCost;
  /**
   * Wall time for the call, measured with a monotonic duration counter.
   * Deliberately NOT derived from a clock read: `asOf` is the only calendar
   * instant here and it is always injected.
   */
  latencyMs: number;
  /** The injected `now`. Feeds `enrichmentSpend.asOf` unchanged. */
  asOf: string;
}

export interface LlmCompletion extends LlmCallFacts {
  status: 'ok';
  /**
   * What the model said. **May legitimately be empty** — that is the whole
   * point of keeping this off the other branch, so `''` means "it had nothing
   * to say" and can never mean "we could not ask".
   */
  text: string;
  finish: LlmFinishReason;
}

export interface LlmUnavailable extends LlmCallFacts {
  status: 'unavailable';
  reason: LlmUnavailableReason;
  /** Operator-facing detail: the backend's own error text, a code, a status. */
  detail: string;
  /**
   * Whether trying again later could plausibly work. `false` for a missing
   * model or a shut cost gate — both need a human, and retrying is the
   * "silent deferred retry" §15 forbids.
   */
  retryable: boolean;
}

export type LlmResult = LlmCompletion | LlmUnavailable;

/** Narrowing guard. The only supported way to reach `text`. */
export function isLlmOk(result: LlmResult): result is LlmCompletion {
  return result.status === 'ok';
}

// ---------------------------------------------------------------------------
// The backend contract
// ---------------------------------------------------------------------------

export interface LlmRequest {
  /** The instruction. Optional because not every backend has a system role. */
  system?: string;
  prompt: string;
  /** Overrides the configured cap for this one call. */
  maxOutputTokens?: number;
  /** Overrides the configured temperature for this one call. */
  temperature?: number;
}

export interface LlmCallOptions {
  /**
   * Canonical UTC instant, always injected — this module and every backend
   * built on it read no wall clock. Matches `src/score/velocity.ts` and
   * `src/enrich/repo.ts`.
   */
  now: string;
  /** Whole-call deadline. Defaults to the configured limit. */
  timeoutMs?: number;
  /** Rejection threshold for the prompt. Defaults to the configured limit. */
  maxPromptChars?: number;
  /** Streaming byte ceiling on the response. Defaults to the configured limit. */
  maxResponseBytes?: number;
}

/**
 * One backend. Swapping implementations is a `config/llm.yaml` edit; nothing
 * downstream of this interface knows which one it holds.
 */
export interface LlmBackend {
  readonly name: LlmBackendName;
  /** The configured model. Read-only, and never a literal in `src/`. */
  readonly model: string;
  /** The `docs/costs.md` id this backend spends against. */
  readonly serviceId: string;
  /**
   * Generates one completion.
   *
   * Never throws for a transport, HTTP, or model-availability outcome — those
   * are the `unavailable` branch. It DOES throw {@link LlmPromptTooLargeError}
   * for a prompt over the limit, because that is a caller-side error a retry
   * cannot fix and only the caller can decide how to shorten. Rejecting
   * rather than silently truncating follows `src/domain/item.ts`'s standing
   * rule that a normalizer never guesses at input it cannot validate.
   */
  complete(request: LlmRequest, opts: LlmCallOptions): Promise<LlmResult>;
}

/**
 * The prompt exceeded the configured character ceiling and **no request was
 * sent**.
 *
 * Deliberately a throw rather than an `unavailable` branch: the backend is
 * fine, the request is not, and folding it into unavailability would invite a
 * caller to retry an input that can never succeed. Deliberately not a silent
 * truncation either — cutting the middle out of an article and summarising
 * the remainder produces a confident, wrong blurb, which §8.1's weekly
 * reading note is the one artifact that must not contain.
 */
export class LlmPromptTooLargeError extends Error {
  readonly chars: number;
  readonly maxChars: number;

  constructor(chars: number, maxChars: number) {
    super(
      `prompt is ${chars} characters, over the ${maxChars}-character ceiling; shorten it at the call site rather than letting the backend truncate it`,
    );
    this.name = 'LlmPromptTooLargeError';
    this.chars = chars;
    this.maxChars = maxChars;
  }
}

/**
 * Shared entry-point validation for every backend: the injected `now` must be
 * canonical, and the prompt must fit. Exported so task 2's backend enforces
 * the identical contract instead of a near-identical one.
 */
export function assertCallable(request: LlmRequest, opts: LlmCallOptions, maxPromptChars: number): void {
  assertCanonicalTimestamp('now', opts.now);
  const chars = (request.system?.length ?? 0) + request.prompt.length;
  if (chars > maxPromptChars) throw new LlmPromptTooLargeError(chars, maxPromptChars);
}

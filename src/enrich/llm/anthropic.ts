/**
 * The Anthropic backend (M5 task 2) — **built, and shipped hard-disabled.**
 *
 * RULING 2 of the M5 plan: *"Build both. Anthropic ships hard-disabled with
 * `WF_ALLOW_PAID_ANTHROPIC` unset, exactly as §15 requires, for the owner to
 * enable deliberately later."*
 *
 * ## What "hard-disabled" means here, precisely
 *
 * §15: *"Flag absent = code path hard-disabled, never a silent fallback or a
 * deferred retry"* — *"the scheduler skips the job, the API returns a clear
 * 'disabled by cost policy' status, and the dashboard shows the feature as
 * off."*
 *
 * Three consequences shape this module:
 *
 *  1. **It constructs with the flag unset.** A construction-time throw would
 *     make "the dashboard shows the feature as off" unreachable — there would
 *     be no object to ask. So a disabled backend is a real {@link LlmBackend}
 *     with a name, a model, and a cost-registry id, whose `complete` reports
 *     `disabled_by_cost_policy` forever.
 *  2. **It never reads the credential while disabled.** The key is loaded at
 *     construction *only* when the gate is open, which is why the disabled
 *     path works on a machine that has no Anthropic credential at all — the
 *     machine this was written on.
 *  3. **The gate can only tighten within one backend's lifetime.** `complete`
 *     re-reads the flag and refuses if it has since been cleared; but a
 *     backend built while the gate was shut holds no key and stays disabled
 *     even if the flag is later set. Becoming live mid-process, without a
 *     credential ever having been read, is not a transition this should have.
 *
 * `createLlmBackend` (./backend.ts) therefore does **not** fall back to Ollama
 * when this backend is off. A silent substitution would report enrichment as
 * running on a backend it is not, which is the exact shape §15 forbids.
 *
 * ## Why raw HTTP rather than `@anthropic-ai/sdk`
 *
 * The M5 plan's global constraints: *"No new runtime dependency without
 * justification."* Anthropic's own guidance is to prefer the official SDK, and
 * for an ordinary application that is right. It is not right here, and the
 * reason is this task's subject rather than a preference:
 *
 *  - **The zero-dollar proof has to cover every path to the network.** The
 *    guard in `tests/cost/no-paid-requests.test.ts` blocks and records at the
 *    socket layer precisely because a client can reach the wire without
 *    `globalThis.fetch`. An SDK with its own transport, retry loop, and
 *    default `base_url` widens exactly the surface that proof has to cover —
 *    and the SDK retries 429/5xx twice by default, which is a *deferred
 *    retry*: the thing §15 names.
 *  - **`base_url` must come from config**, so a test can point it at a
 *    loopback listener. An SDK that defaults to `api.anthropic.com` puts the
 *    paid host inside the dependency, where the "no paid hostname in `src/`"
 *    tripwire cannot see it.
 *  - The request is one POST with a JSON body and two headers. `src/fetch/`
 *    and `./ollama.ts` already own this shape.
 *
 * If a future task needs streaming, tool use, or the beta surfaces, revisit
 * this — but revisit the guard in the same breath.
 *
 * ## What it does NOT send, and why that is deliberate
 *
 * No `temperature`, `top_p`, or `top_k`. Sampling parameters were **removed**
 * on the current model generation and are rejected with a 400 — so forwarding
 * {@link LlmRequest.temperature} would break every call on a current model,
 * and dropping it silently would hand a caller a sampler setting it never got.
 * A per-call temperature therefore throws
 * {@link AnthropicSamplingUnsupportedError}, in the same spirit as
 * {@link LlmPromptTooLargeError}: a caller-side error no retry can fix.
 *
 * No `stream: true` either. The configured `max_output_tokens` is small (512
 * in `config/llm.yaml`); a non-streaming request is only a timeout hazard well
 * above ~16k output tokens, and streaming would add a partial-response state
 * this seam has no way to express.
 */

import { z } from 'zod';
import { USER_AGENT } from '../../fetch/http.ts';
import { isPaidAllowed } from '../../cost/gate.ts';
import type { SpendCategory } from '../../cost/registry.ts';
import { LlmConfigError, type LlmConfig } from './config.ts';
import {
  assertCallable,
  computeCost,
  makeUsage,
  type LlmBackend,
  type LlmCallOptions,
  type LlmFinishReason,
  type LlmPricing,
  type LlmRequest,
  type LlmResult,
  type LlmUnavailableReason,
  type LlmUsage,
} from './types.ts';

/**
 * The generation endpoint. A constant this module owns — which is what lets a
 * 404 be read as "the configured model does not exist" rather than "the path
 * is wrong". See {@link createAnthropicBackend}.
 */
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';

/**
 * The API version header value. Pinned rather than tracking "latest": this is
 * the version whose response shape the parser below implements, and a silent
 * upgrade is how a working parser starts returning `malformed_response`.
 */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** The `docs/costs.md` / `src/cost/registry.ts` row this backend spends against. */
export const ANTHROPIC_SERVICE_ID = 'anthropic-api';

/** The `WF_ALLOW_PAID_*` category this backend is gated on. */
export const ANTHROPIC_SPEND_CATEGORY: SpendCategory = 'anthropic';

/**
 * The credential's environment variable.
 *
 * **Deliberately `WF_`-prefixed, and deliberately not `ANTHROPIC_API_KEY`.** A
 * development machine with Claude Code installed very plausibly exports
 * `ANTHROPIC_API_KEY`; honouring it would let this project bill a credential
 * nobody handed it, on nothing more than a flag flip. The zero-dollar rule's
 * standard is what the system is *capable* of, so the credential must be given
 * to Watchfloor by name.
 */
export const ANTHROPIC_API_KEY_ENV_VAR = 'WF_ANTHROPIC_API_KEY';

/**
 * The gate is open but no credential is configured.
 *
 * A construction-time throw rather than an `unavailable` branch: the operator
 * has explicitly asked to spend money and the system cannot, which is a
 * misconfiguration to fix now — not a runtime state to report on a dashboard
 * once per scheduled pass. Never carries the value of any environment
 * variable.
 */
export class AnthropicCredentialError extends Error {
  constructor() {
    super(
      `${ANTHROPIC_SPEND_CATEGORY} spending is enabled (WF_ALLOW_PAID_${ANTHROPIC_SPEND_CATEGORY.toUpperCase()}=1) but ${ANTHROPIC_API_KEY_ENV_VAR} is unset or blank. ` +
        `Set it in .env, or clear the flag to leave the backend hard-disabled. ` +
        `Note that a machine-wide ANTHROPIC_API_KEY is deliberately ignored -- this project only spends on a credential given to it by name.`,
    );
    this.name = 'AnthropicCredentialError';
  }
}

/**
 * A caller asked for a sampling parameter this API no longer accepts. See the
 * module doc: forwarding it 400s, and dropping it silently is worse.
 */
export class AnthropicSamplingUnsupportedError extends Error {
  constructor(parameter: string) {
    super(
      `the anthropic backend cannot honour '${parameter}': sampling parameters were removed on current models and are rejected with a 400. ` +
        `Remove it at the call site rather than having it silently dropped.`,
    );
    this.name = 'AnthropicSamplingUnsupportedError';
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AnthropicConfigSchema = z
  .object({
    // No default. The vendor's hostname stays OUT of src/ entirely: a test
    // asserts no module under src/ contains a paid vendor host, so any future
    // hardcoded endpoint trips it. It also means a test can point this at a
    // loopback listener, which is how this file is exercised at all.
    base_url: z
      .string()
      .min(1)
      .refine(
        (value) => {
          try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
          } catch {
            return false;
          }
        },
        { message: 'must be an absolute http(s) url' },
      ),
    // No default, same reasoning as ollama's: a model nobody chose is a silent
    // surprise, and here it is a silent surprise with a price attached.
    model: z
      .string()
      .min(1, 'model is required -- there is no sensible default for a billable backend'),
    pricing: z
      .object({
        // Positive, not merely non-negative. computeCost prices a zero-rate
        // backend as a MEASURED $0 unconditionally (correct for ollama-local,
        // which cannot bill at any volume). A billable service with a zero
        // rate in config would inherit that guarantee and report every call as
        // a measured free one -- the single most expensive typo available in
        // this file.
        usd_per_million_input_tokens: z
          .number()
          .positive(
            'must be positive -- a zero rate makes computeCost report a MEASURED $0 for a service that can bill',
          ),
        usd_per_million_output_tokens: z
          .number()
          .positive(
            'must be positive -- a zero rate makes computeCost report a MEASURED $0 for a service that can bill',
          ),
      })
      .strict(),
  })
  .strict();

/** The `anthropic:` block of `config/llm.yaml`, in the shape the code uses. */
export interface AnthropicConfig {
  baseUrl: string;
  model: string;
  pricing: LlmPricing;
}

/**
 * Validates the `anthropic:` block. `src/enrich/llm/config.ts` accepts it as
 * an opaque record on purpose — task 1 could not validate a shape task 2 had
 * not designed — so this is where it becomes real.
 */
export function parseAnthropicConfig(raw: unknown): AnthropicConfig {
  if (raw === undefined) {
    throw new LlmConfigError(
      "llm config selects the 'anthropic' backend but has no `anthropic:` block -- add one with base_url, model, and pricing (see config/llm.yaml)",
    );
  }
  const result = AnthropicConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  anthropic.${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new LlmConfigError(`invalid llm config:\n${lines.join('\n')}`);
  }
  const data = result.data;
  return {
    baseUrl: data.base_url,
    model: data.model,
    pricing: {
      usdPerMillionInputTokens: data.pricing.usd_per_million_input_tokens,
      usdPerMillionOutputTokens: data.pricing.usd_per_million_output_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/** `POST /v1/messages`, restricted to the fields this module reads. */
interface AnthropicMessageResponse {
  model?: unknown;
  content?: unknown;
  stop_reason?: unknown;
  usage?: unknown;
}

/**
 * Anthropic's `stop_reason`, mapped onto the seam's finish vocabulary.
 *
 * `refusal` deserves a note. It arrives as a **200 with an empty `content`
 * array**: a model was reached and declined. That belongs on the `ok` branch —
 * `text: ''` means "it said nothing", which is exactly true, and the
 * `unavailable` branch means "we could not ask". The seam models no reason for
 * it, and `other` is defined as *"the backend reported something this seam
 * does not model. Carried, not guessed at"* — so a refusal never reads as a
 * clean `stop`. `tool_use`, `pause_turn`, and `stop_sequence` land here too;
 * this module sends no tools and no stop sequences, so none of them should
 * occur, and if one does it must not be mistaken for a finished answer.
 */
function toFinishReason(raw: unknown): LlmFinishReason {
  if (raw === 'end_turn') return 'stop';
  if (raw === 'max_tokens') return 'length';
  return 'other';
}

function countOrNull(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * Transport codes meaning **nothing accepted the connection** — no network, or
 * a `base_url` pointing at nothing. Copied from ./ollama.ts rather than shared:
 * the two files classify the same codes for different hosts, and importing the
 * free local backend into the paid one to save fifteen lines would couple them
 * for no benefit. **If that list changes there, this does not inherit it.**
 */
const NOT_RUNNING_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** See ./ollama.ts — Node's fetch reports every transport failure identically. */
function transportCode(err: unknown, depth = 0): string | null {
  if (depth > 5 || err === null || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  const nested = (err as { errors?: unknown }).errors;
  if (Array.isArray(nested)) {
    for (const inner of nested) {
      const found = transportCode(inner, depth + 1);
      if (found !== null) return found;
    }
  }
  return transportCode((err as { cause?: unknown }).cause, depth + 1);
}

/** Mirrors readBodyWithCeiling in ./ollama.ts and src/fetch/http.ts (neither exported). */
async function readBodyWithCeiling(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const MAX_DETAIL_CHARS = 500;

function toDetail(body: string | null): string {
  if (body === null) return '(response exceeded the byte ceiling)';
  const trimmed = body.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return '(empty body)';
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…` : trimmed;
}

const NO_USAGE: LlmUsage = makeUsage(null, null);

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

export interface AnthropicBackend extends LlmBackend {
  readonly name: 'anthropic';
  /**
   * Whether the cost gate was open when this backend was built. `false` means
   * every call reports `disabled_by_cost_policy` and no request can be sent —
   * the state §15 asks the API and dashboard to surface.
   */
  readonly enabled: boolean;
  /** The `WF_ALLOW_PAID_*` category, so a caller can name the flag to set. */
  readonly spendCategory: SpendCategory;
}

/**
 * Builds the Anthropic backend from a loaded `config/llm.yaml`.
 *
 * `env` is injected rather than read from `process.env` at the point of use,
 * for the same reason `now` is: a test must be able to exercise both sides of
 * the gate, and a module that reads a global cannot be asked "what would you
 * do with the flag unset?"
 */
export function createAnthropicBackend(
  config: LlmConfig,
  env: NodeJS.ProcessEnv = process.env,
): AnthropicBackend {
  const { baseUrl, model, pricing } = parseAnthropicConfig(config.anthropic);
  const limits = config.limits;
  const url = new URL(ANTHROPIC_MESSAGES_PATH, baseUrl).toString();

  // THE GATE. Read once here, re-read per call below. Nothing in this function
  // touches the credential unless this is true.
  const enabled = isPaidAllowed(ANTHROPIC_SPEND_CATEGORY, env);

  let apiKey: string | null = null;
  if (enabled) {
    const raw = env[ANTHROPIC_API_KEY_ENV_VAR];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    // '' is treated as absent, exactly as GitHubClient treats a `.env` line
    // left as `WF_GITHUB_TOKEN=`.
    if (trimmed === '') throw new AnthropicCredentialError();
    apiKey = trimmed;
  }

  return {
    name: 'anthropic',
    model,
    serviceId: ANTHROPIC_SERVICE_ID,
    enabled,
    spendCategory: ANTHROPIC_SPEND_CATEGORY,

    async complete(request: LlmRequest, opts: LlmCallOptions): Promise<LlmResult> {
      const maxPromptChars = opts.maxPromptChars ?? limits.maxPromptChars;
      // Argument validation runs BEFORE the gate, deliberately. It performs no
      // I/O and cannot spend, and running it either way keeps a flag-off dry
      // run a real rehearsal: turning the flag on must not change which inputs
      // the backend rejects.
      assertCallable(request, opts, maxPromptChars);
      if (request.temperature !== undefined) {
        throw new AnthropicSamplingUnsupportedError('temperature');
      }

      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);

      const unavailable = (
        reason: LlmUnavailableReason,
        detail: string,
        retryable: boolean,
      ): LlmResult => ({
        status: 'unavailable',
        reason,
        // The model that was ASKED FOR -- there is no answer to attribute.
        model,
        backend: 'anthropic',
        detail,
        retryable,
        usage: NO_USAGE,
        // Billable and uncounted, so UNKNOWN rather than a placeholder $0.
        // Contrast ollama.ts, whose zero is a guarantee.
        cost: computeCost(NO_USAGE, pricing, ANTHROPIC_SERVICE_ID),
        latencyMs: elapsed(),
        asOf: opts.now,
      });

      // THE GATE, re-read. `enabled` alone would let a flag cleared mid-process
      // keep spending until restart; `apiKey === null` is what makes a backend
      // built while the gate was shut stay inert even if the flag is later set.
      if (!enabled || apiKey === null || !isPaidAllowed(ANTHROPIC_SPEND_CATEGORY, env)) {
        return unavailable(
          'disabled_by_cost_policy',
          `${ANTHROPIC_SERVICE_ID} is disabled by cost policy; set WF_ALLOW_PAID_${ANTHROPIC_SPEND_CATEGORY.toUpperCase()}=1 and ${ANTHROPIC_API_KEY_ENV_VAR} to enable it. No request was sent.`,
          // NOT retryable. §15: "never a silent fallback that retries later" --
          // a shut gate needs a human, not a backoff.
          false,
        );
      }

      const timeoutMs = opts.timeoutMs ?? limits.timeoutMs;
      const maxResponseBytes = opts.maxResponseBytes ?? limits.maxResponseBytes;

      const body: Record<string, unknown> = {
        model,
        max_tokens: request.maxOutputTokens ?? limits.maxOutputTokens,
        messages: [{ role: 'user', content: request.prompt }],
        // Top-level, not a message role: this API has no `system` role, and
        // sending one is a 400. The single shape difference from ollama's
        // /api/chat that a copy-paste would get wrong.
        ...(request.system !== undefined ? { system: request.system } : {}),
      };

      const timeoutSignal = AbortSignal.timeout(timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
            // The credential travels here and nowhere else -- never in the
            // url, never in the body, never in an error detail.
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
          },
          body: JSON.stringify(body),
          signal: timeoutSignal,
        });
      } catch (err) {
        if (timeoutSignal.aborted) {
          return unavailable('timeout', `no response within ${timeoutMs}ms`, true);
        }
        const code = transportCode(err);
        const message = err instanceof Error ? err.message : String(err);
        const detail = code === null ? message : `${code}: ${message}`;
        return code !== null && NOT_RUNNING_CODES.has(code)
          ? unavailable('not_running', `${detail} (nothing accepted the connection at ${baseUrl})`, true)
          : unavailable('transport_error', detail, true);
      }

      let raw: string | null;
      try {
        raw = await readBodyWithCeiling(response, maxResponseBytes);
      } catch (err) {
        if (timeoutSignal.aborted) {
          return unavailable('timeout', `no complete response within ${timeoutMs}ms`, true);
        }
        return unavailable('transport_error', err instanceof Error ? err.message : String(err), true);
      }

      if (raw === null) {
        return unavailable(
          'response_too_large',
          `response exceeded the ${maxResponseBytes}-byte ceiling`,
          false,
        );
      }

      if (response.status === 404) {
        // ANTHROPIC_MESSAGES_PATH is a constant this module owns, so the
        // endpoint cannot be what is missing. A model id that does not exist
        // (or has been retired) is what is left -- and it needs a config edit,
        // never a retry.
        return unavailable(
          'model_missing',
          `${toDetail(raw)} (is the model in config/llm.yaml's anthropic block still current?)`,
          false,
        );
      }

      if (response.status < 200 || response.status >= 300) {
        return unavailable(
          'http_error',
          `${response.status} ${response.statusText}: ${toDetail(raw)}`,
          // 429 and 5xx (including 529 overloaded) are the transient ones. A
          // 401 or 400 is permanent: retrying a bad key spends nothing but
          // achieves nothing.
          response.status === 429 || response.status >= 500,
        );
      }

      let parsed: AnthropicMessageResponse;
      try {
        parsed = JSON.parse(raw) as AnthropicMessageResponse;
      } catch {
        return unavailable('malformed_response', `body is not JSON: ${toDetail(raw)}`, false);
      }

      if (!Array.isArray(parsed.content)) {
        // The distinction this branch exists for: a `content` array that is
        // EMPTY is a real answer (a refusal), while a missing `content` key is
        // a body that is not the documented shape. Collapsing the two would
        // store `''` against an append-only corpus as though a model had said
        // nothing -- indistinguishable from a real empty answer forever.
        return unavailable(
          'malformed_response',
          `no content array in a 200 response: ${toDetail(raw)}`,
          false,
        );
      }

      const text = parsed.content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            block !== null &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string',
        )
        .map((block) => block.text)
        .join('');

      const usageRaw = parsed.usage;
      const usageObject =
        usageRaw !== null && typeof usageRaw === 'object'
          ? (usageRaw as { input_tokens?: unknown; output_tokens?: unknown })
          : {};
      const usage = makeUsage(
        countOrNull(usageObject.input_tokens),
        countOrNull(usageObject.output_tokens),
      );

      return {
        status: 'ok',
        text,
        finish: toFinishReason(parsed.stop_reason),
        // The model that ANSWERED, as the API named it -- an alias in config
        // can resolve to something more specific, and the answer's provenance
        // is the API's name for it.
        model: typeof parsed.model === 'string' ? parsed.model : model,
        backend: 'anthropic',
        usage,
        // NOTE: cache-read and cache-write tokens bill at different rates. This
        // module sends no `cache_control`, so no cached tokens can be involved
        // and input_tokens is the whole input bill. Adding prompt caching means
        // revisiting this arithmetic, not just the request.
        cost: computeCost(usage, pricing, ANTHROPIC_SERVICE_ID),
        latencyMs: elapsed(),
        asOf: opts.now,
      };
    },
  };
}

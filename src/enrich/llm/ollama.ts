/**
 * The Ollama backend (M5 task 1) — local inference, behind the seam in
 * ./types.ts.
 *
 * **Ollama needs no cost flag.** §15: *"Ollama is local and needs no flag."*
 * It is registered `free-forever` as `ollama-local` in `docs/costs.md` and
 * `src/cost/registry.ts` — no account, no key, no billing relationship to
 * have — so this module deliberately does **not** consult `src/cost/gate.ts`.
 * That is not an oversight to be "fixed": a gate call here would imply a
 * `WF_ALLOW_PAID_OLLAMA` category that must never exist. Task 2's Anthropic
 * backend is the one that goes through the gate.
 *
 * ## Why this does not call `politeFetch`
 *
 * `src/fetch/github.ts` asks and answers this question for its own case; the
 * same question applies here and the answer is even less close. Five
 * properties of `politeFetch`'s signature rule it out:
 *
 *  - **It only issues GETs.** There is no method or body parameter, and
 *    generation is a POST with a JSON body. That is decisive on its own.
 *  - **Its 2s per-host spacing is politeness toward third-party operators.**
 *    This host is the owner's own machine; spacing calls to it serves nobody
 *    and would throttle a whole-corpus enrichment pass for no reason.
 *  - **Its 10s default deadline is far too short.** A cold model load
 *    measured 13.1 seconds on this machine before a single token was
 *    generated — every call would abort during warm-up.
 *  - **It throws on non-2xx with no access to the body**, and Ollama puts the
 *    entire useful signal there: a 404 carries `{"error":"model '…' not
 *    found"}`, which is what separates `model_missing` from `not_running`.
 *  - **Conditional-request state (ETag / Last-Modified) is meaningless** for
 *    a generation endpoint.
 *
 * So this performs its own `fetch` while reusing http.ts's *shape*: the same
 * `USER_AGENT`, an `AbortSignal.timeout` covering the whole operation, and a
 * byte ceiling enforced while streaming so a pathological response is never
 * fully buffered. **Stated rather than hidden, exactly as github.ts states
 * it: if http.ts's timeout, ceiling, or spacing behaviour changes, this file
 * does not inherit it.**
 *
 * ## Why `/api/chat` and not `/api/generate`
 *
 * Measured, not assumed — both endpoints were captured live from the same
 * daemon, same model, same prompt, and both fixtures are in
 * `tests/fixtures/ollama/`:
 *
 *  1. `/api/generate` returns a **`context` array** — the full tokenised
 *     conversation — which took the response from 402 to 860 bytes for an
 *     identical answer. This module never reads it, so it is pure weight on
 *     every call.
 *  2. `/api/chat` takes a **system role natively**. `/api/generate` has only
 *     one `prompt` string, so a system instruction would have to be
 *     concatenated into it and the model would be free to treat it as user
 *     text.
 *
 * ## Two bounds, and only one of them is a failure
 *
 * `max_output_tokens` becomes Ollama's `num_predict`, a **server-side** cap.
 * Hitting it returns HTTP 200 with `done_reason: "length"` and real text, so
 * it surfaces as `finish: 'length'` on the **ok** branch — a short answer is
 * still an answer. `max_response_bytes` is defence in depth against a
 * response that is not a bounded completion at all (a proxy's error page, a
 * misconfigured base_url pointing at something else entirely), and crossing
 * it aborts the stream and reports `response_too_large`.
 */

import { USER_AGENT } from '../../fetch/http.ts';
import type { LlmConfig } from './config.ts';
import {
  FREE_PRICING,
  assertCallable,
  computeCost,
  makeUsage,
  type LlmBackend,
  type LlmCallOptions,
  type LlmFinishReason,
  type LlmRequest,
  type LlmResult,
  type LlmUnavailableReason,
  type LlmUsage,
} from './types.ts';

/**
 * The generation endpoint. Exported so the endpoint choice is assertable
 * rather than buried in a template string — see the module doc for the
 * measurement behind it.
 */
export const OLLAMA_CHAT_PATH = '/api/chat';

/**
 * The `docs/costs.md` / `src/cost/registry.ts` row this backend spends
 * against. `free-forever`: local hardware, no account, nothing that can bill.
 */
export const OLLAMA_SERVICE_ID = 'ollama-local';

/**
 * Transport error codes meaning **nothing accepted the connection**. Each is
 * a "the daemon is not running, or `base_url` is wrong" answer rather than a
 * transient blip, which is why they classify apart from a mid-stream failure.
 */
const NOT_RUNNING_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Ollama's `/api/chat` response, restricted to the fields this module reads. */
interface OllamaChatResponse {
  model?: unknown;
  message?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

/**
 * Walks an error's `cause` chain (and any `AggregateError.errors`) for a
 * transport code.
 *
 * Necessary because Node's `fetch` reports every transport failure as the
 * same `TypeError: fetch failed`; the code that says *which* failure it was
 * is one or two levels down, and undici nests it inside an `AggregateError`
 * when a host resolves to several addresses.
 */
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

/**
 * Streams a response body, aborting the instant `maxBytes` is crossed.
 *
 * Mirrors `readBodyWithCeiling` in src/fetch/http.ts, which is not exported.
 * `null` means the ceiling was crossed — a distinct outcome from any string,
 * including the empty one.
 */
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

/** Ollama's `done_reason`, mapped onto the seam's finish vocabulary. */
function toFinishReason(raw: unknown): LlmFinishReason {
  if (raw === 'stop') return 'stop';
  if (raw === 'length') return 'length';
  // Anything else is carried as 'other' rather than guessed at — a future
  // daemon adding a reason must not silently read as a clean stop.
  return 'other';
}

function countOrNull(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * A trimmed, single-line rendering of whatever the daemon put in an error
 * body, for the operator-facing `detail`. Bounded because a proxy can answer
 * with a whole HTML page.
 */
const MAX_DETAIL_CHARS = 500;

function toDetail(body: string | null): string {
  if (body === null) return '(response exceeded the byte ceiling)';
  const trimmed = body.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return '(empty body)';
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…` : trimmed;
}

const NO_USAGE: LlmUsage = makeUsage(null, null);

export interface OllamaBackend extends LlmBackend {
  readonly name: 'ollama';
}

/**
 * Builds the Ollama backend from a loaded `config/llm.yaml`.
 *
 * Takes the whole {@link LlmConfig} rather than loose arguments so there is
 * exactly one path from the config file to a running backend — no call site
 * can assemble a backend around a model name it invented.
 */
export function createOllamaBackend(config: LlmConfig): OllamaBackend {
  const { baseUrl, model, temperature, keepAlive } = config.ollama;
  const limits = config.limits;
  const url = new URL(OLLAMA_CHAT_PATH, baseUrl).toString();

  return {
    name: 'ollama',
    model,
    serviceId: OLLAMA_SERVICE_ID,

    async complete(request: LlmRequest, opts: LlmCallOptions): Promise<LlmResult> {
      const maxPromptChars = opts.maxPromptChars ?? limits.maxPromptChars;
      // Throws LlmPromptTooLargeError before anything is sent — see the seam's
      // doc comment for why an oversized prompt is a throw rather than a
      // branch of the union.
      assertCallable(request, opts, maxPromptChars);

      const timeoutMs = opts.timeoutMs ?? limits.timeoutMs;
      const maxResponseBytes = opts.maxResponseBytes ?? limits.maxResponseBytes;
      const numPredict = request.maxOutputTokens ?? limits.maxOutputTokens;

      const messages: Array<{ role: string; content: string }> = [];
      if (request.system !== undefined) messages.push({ role: 'system', content: request.system });
      messages.push({ role: 'user', content: request.prompt });

      const effectiveTemperature = request.temperature ?? temperature;
      const body: Record<string, unknown> = {
        model,
        stream: false,
        messages,
        options: {
          num_predict: numPredict,
          ...(effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
        },
        ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
      };

      // A monotonic duration counter, NOT a clock read: `asOf` is the only
      // calendar instant this module produces and it is always injected.
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);

      const unavailable = (
        reason: LlmUnavailableReason,
        detail: string,
        retryable: boolean,
      ): LlmResult => ({
        status: 'unavailable',
        reason,
        // The model that was ASKED FOR — there is no answer to attribute.
        model,
        backend: 'ollama',
        detail,
        retryable,
        usage: NO_USAGE,
        // A local call that failed cost exactly $0, and that is a guarantee
        // rather than an estimate. See computeCost's zero-rate branch.
        cost: computeCost(NO_USAGE, FREE_PRICING, OLLAMA_SERVICE_ID),
        latencyMs: elapsed(),
        asOf: opts.now,
      });

      const timeoutSignal = AbortSignal.timeout(timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
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
          ? unavailable(
              'not_running',
              `${detail} (is the Ollama daemon running at ${baseUrl}?)`,
              true,
            )
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
        // Never retryable, for the same reason ResponseTooLargeError is not in
        // src/fetch/http.ts: the same request produces the same oversized
        // response, so a retry spends the work again for the same failure.
        return unavailable(
          'response_too_large',
          `response exceeded the ${maxResponseBytes}-byte ceiling`,
          false,
        );
      }

      if (response.status === 404) {
        // The route exists on any running daemon, so a 404 from it means the
        // MODEL is missing, not the endpoint. Verified live: Ollama answers
        // {"error":"model '…' not found"}. Not retryable — retrying cannot
        // pull a model, and a silent deferred retry is what §15 forbids.
        return unavailable('model_missing', toDetail(raw), false);
      }

      if (response.status < 200 || response.status >= 300) {
        return unavailable(
          'http_error',
          `${response.status} ${response.statusText}: ${toDetail(raw)}`,
          response.status === 429 || response.status >= 500,
        );
      }

      let parsed: OllamaChatResponse;
      try {
        parsed = JSON.parse(raw) as OllamaChatResponse;
      } catch {
        return unavailable('malformed_response', `body is not JSON: ${toDetail(raw)}`, false);
      }

      const message = parsed.message;
      const content =
        message !== null && typeof message === 'object'
          ? (message as { content?: unknown }).content
          : undefined;

      if (typeof content !== 'string') {
        // The one outcome this whole module exists to keep out of the ok
        // branch: an answer-shaped response with no answer in it.
        return unavailable(
          'malformed_response',
          `no message.content string in a 200 response: ${toDetail(raw)}`,
          false,
        );
      }

      const usage = makeUsage(
        countOrNull(parsed.prompt_eval_count),
        countOrNull(parsed.eval_count),
      );

      return {
        status: 'ok',
        text: content,
        finish: toFinishReason(parsed.done_reason),
        // The model that ANSWERED, as the daemon named it — `llama3.2` in
        // config resolves to `llama3.2:latest` here, and the answer's
        // provenance is the daemon's name for it.
        model: typeof parsed.model === 'string' ? parsed.model : model,
        backend: 'ollama',
        usage,
        cost: computeCost(usage, FREE_PRICING, OLLAMA_SERVICE_ID),
        latencyMs: elapsed(),
        asOf: opts.now,
      };
    },
  };
}

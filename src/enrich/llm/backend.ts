/**
 * The one path from `config/llm.yaml` to a running backend (M5 task 1).
 *
 * Everything downstream — task 3's cache and ceiling, task 6's weekly blurbs,
 * the CLI — takes an {@link LlmBackend} and never knows which one it holds.
 * That is what makes "swap the model, or the whole backend" a config edit, as
 * requirement 1 asks and as CLAUDE.md's portability debt demands.
 *
 * **The Anthropic seam, and why it never falls back.** RULING 2 has Anthropic
 * shipping *built and hard-disabled*, which M5 task 2 landed. `backend:
 * anthropic` with `WF_ALLOW_PAID_ANTHROPIC` unset therefore returns a real
 * Anthropic backend that reports `disabled_by_cost_policy` on every call — it
 * does **not** quietly return Ollama. A silent fallback would leave an
 * operator believing they had enabled something they had not, and §15 forbids
 * exactly that shape ("never a silent fallback"). See ./anthropic.ts for why
 * a disabled backend is still a constructible object.
 */

import { createOllamaBackend } from './ollama.ts';
import { createAnthropicBackend } from './anthropic.ts';
import type { LlmConfig } from './config.ts';
import type { LlmBackend, LlmBackendName } from './types.ts';

/**
 * The configured backend exists in the seam but has no implementation wired
 * into this build. Distinct from {@link LlmConfigError} on purpose: the
 * config is *valid*, it just names something this build cannot construct.
 *
 * Both members of {@link LlmBackendName} are wired today, so this is reached
 * only through the switch's `default` — the guard for the day that union (or
 * `config.ts`'s matching enum) is widened and this file is not. Without it the
 * factory would return `undefined` and the failure would surface far away, as
 * a missing method on something that was never a backend.
 */
export class BackendNotWiredError extends Error {
  readonly backend: LlmBackendName;

  constructor(backend: LlmBackendName, owner: string) {
    super(
      `config/llm.yaml selects the '${backend}' backend, which is not wired into this build (${owner}). ` +
        `Refusing to fall back to another backend -- a silent substitution would report enrichment as running on a backend it is not.`,
    );
    this.name = 'BackendNotWiredError';
    this.backend = backend;
  }
}

/**
 * Builds the backend `config.backend` selects.
 *
 * `env` is threaded through because the Anthropic backend is gated on
 * `WF_ALLOW_PAID_ANTHROPIC` and must be testable on both sides of that gate
 * without mutating the real process environment. Ollama ignores it entirely —
 * it is local, free-forever, and consults no gate at all (§15).
 */
export function createLlmBackend(
  config: LlmConfig,
  env: NodeJS.ProcessEnv = process.env,
): LlmBackend {
  switch (config.backend) {
    case 'ollama':
      return createOllamaBackend(config);
    case 'anthropic':
      // Hard-disabled unless WF_ALLOW_PAID_ANTHROPIC=1, and honest about it
      // either way. The gate lives inside the backend rather than here so that
      // there is exactly ONE place a paid request can be issued from, and the
      // check sits next to the fetch it guards -- see tests/cost/
      // no-paid-requests.test.ts, which proves no request escapes it.
      return createAnthropicBackend(config, env);
    default:
      throw new BackendNotWiredError(
        config.backend,
        'no case in createLlmBackend covers it -- add one, or narrow the LlmBackendName union',
      );
  }
}

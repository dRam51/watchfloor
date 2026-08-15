/**
 * The one path from `config/llm.yaml` to a running backend (M5 task 1).
 *
 * Everything downstream — task 3's cache and ceiling, task 6's weekly blurbs,
 * the CLI — takes an {@link LlmBackend} and never knows which one it holds.
 * That is what makes "swap the model, or the whole backend" a config edit, as
 * requirement 1 asks and as CLAUDE.md's portability debt demands.
 *
 * **The Anthropic seam, and why it throws rather than falls back.** RULING 2
 * has task 2 shipping Anthropic *built and hard-disabled*. Until it lands,
 * `backend: anthropic` in the config must fail at construction: a silent
 * fallback to Ollama would leave an operator believing they had enabled
 * something they had not, and §15 forbids exactly that shape ("never a silent
 * fallback"). Task 2's whole edit here is one `case` — it should not need to
 * touch anything else in this file.
 */

import { createOllamaBackend } from './ollama.ts';
import type { LlmConfig } from './config.ts';
import type { LlmBackend, LlmBackendName } from './types.ts';

/**
 * The configured backend exists in the seam but has no implementation wired
 * into this build. Distinct from {@link LlmConfigError} on purpose: the
 * config is *valid*, it just names something this build cannot construct.
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

/** Builds the backend `config.backend` selects. */
export function createLlmBackend(config: LlmConfig): LlmBackend {
  switch (config.backend) {
    case 'ollama':
      return createOllamaBackend(config);
    case 'anthropic':
      // M5 task 2 owns this: the gated client plus the zero-dollar proof.
      // Wiring it here before that proof exists would put a paid client in
      // the tree ahead of the check docs/costs.md requires ship WITH it.
      throw new BackendNotWiredError(
        'anthropic',
        'M5 task 2 ships it behind WF_ALLOW_PAID_ANTHROPIC',
      );
  }
}

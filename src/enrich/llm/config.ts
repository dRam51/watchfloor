/**
 * Config loader for the LLM backend seam (M5 task 1).
 *
 * Mirrors the parse/load split every other small YAML config in this tree
 * uses (`src/cluster/config.ts`, `src/score/decay.ts`, `src/interests/load.ts`):
 * a pure `parse*` over already-read text, plus a thin `load*` that does the
 * one bit of file I/O.
 *
 * **Why the model lives here at all.** CLAUDE.md's portability debt is
 * explicit that local inference will differ on the target host — Metal on
 * Apple Silicon, possibly nothing usable on a mini PC — so the model name,
 * the daemon's address, and every bound are config, exactly as a feed source
 * is config and never adapter code. `tests/enrich/llm/config.test.ts` greps
 * `src/enrich/llm/` for a quoted model tag and fails if one appears, because
 * a baked-in default is the failure that keeps working after the config file
 * is edited.
 *
 * **The `limits` block is shared by every backend on purpose.** A timeout, a
 * prompt ceiling, a response-byte ceiling and an output-token cap are
 * properties of "we are calling a language model", not of which one. The
 * per-backend block below it holds only what is genuinely backend-specific.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

/** Repo-relative, like every other path in this codebase (§12). */
export const DEFAULT_LLM_CONFIG_PATH = 'config/llm.yaml';

const LimitsSchema = z
  .object({
    // A zero or negative deadline aborts every call before it starts, which
    // presents as a backend that is permanently "timing out" while the daemon
    // is perfectly healthy.
    timeout_ms: z
      .number()
      .int()
      .positive('timeout_ms must be positive -- a zero deadline aborts every call before it starts'),
    max_prompt_chars: z.number().int().positive('max_prompt_chars must be positive'),
    max_response_bytes: z.number().int().positive('max_response_bytes must be positive'),
    // The one bound whose bad value looks like success: a cap of 0 makes the
    // daemon return an empty completion, HTTP 200, every time. That is
    // indistinguishable at a glance from a working system whose model simply
    // has nothing to say -- precisely the confusion this whole task's return
    // type exists to prevent, so it is rejected at config load instead.
    max_output_tokens: z
      .number()
      .int()
      .positive('max_output_tokens must be positive -- a cap of 0 makes every completion empty while still returning HTTP 200'),
  })
  .strict();

const OllamaSchema = z
  .object({
    // Validated as a real http(s) origin rather than a bare string: a typo
    // like `localhost:11434` (no scheme) fails `new URL`, and the resulting
    // backend would report `not_running` forever -- pointing the operator at
    // the daemon instead of at the config line that is actually wrong.
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
        { message: 'must be an absolute http(s) url, e.g. http://127.0.0.1:11434' },
      ),
    // No default, deliberately. A model this host does not have is a loud
    // `model_missing`; a model nobody chose is a silent surprise.
    model: z.string().min(1, 'model is required -- there is no sensible default for a host we know nothing about'),
    temperature: z.number().min(0).max(2).optional(),
    /**
     * How long the daemon keeps the model resident after a call (Ollama's own
     * `keep_alive`, e.g. `5m`, `1h`, `0`). A real dial, not a nicety: a cold
     * load of llama3.2 measured **13.1 seconds** on this machine
     * (`load_duration` 13,129,639,375ns) against 0.19s warm, so a scheduled
     * enrichment pass that lets the model unload between items pays that
     * every time.
     */
    keep_alive: z.string().min(1).optional(),
  })
  .strict();

const LlmConfigSchema = z
  .object({
    backend: z.enum(['ollama', 'anthropic'], {
      errorMap: () => ({ message: "backend must be 'ollama' or 'anthropic'" }),
    }),
    limits: LimitsSchema,
    ollama: OllamaSchema,
    // Task 2's block, accepted unvalidated. This schema is otherwise strict,
    // so without this key task 2's own config edit would fail THIS task's
    // loader -- and validating a shape task 2 has not designed yet would be
    // worse. Task 2 owns its parsing.
    anthropic: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Bounds every backend enforces, in the shape the code uses. */
export interface LlmLimits {
  timeoutMs: number;
  maxPromptChars: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  temperature?: number;
  keepAlive?: string;
}

export interface LlmConfig {
  backend: 'ollama' | 'anthropic';
  limits: LlmLimits;
  ollama: OllamaConfig;
  /** Untouched passthrough for task 2. */
  anthropic?: Record<string, unknown>;
}

/** Parses and validates LLM-config YAML text. No filesystem access. */
export function parseLlmConfig(yamlText: string): LlmConfig {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (cause) {
    throw new LlmConfigError(`llm config is not valid YAML: ${(cause as Error).message}`);
  }

  const result = LlmConfigSchema.safeParse(raw);
  if (!result.success) {
    // Path first, so the message names the offending key the way
    // src/config/env.ts's does -- "timeout_ms: must be positive", not a bare
    // complaint a reader has to go hunting for.
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new LlmConfigError(`invalid llm config:\n${lines.join('\n')}`);
  }

  const data = result.data;
  const config: LlmConfig = {
    backend: data.backend,
    limits: {
      timeoutMs: data.limits.timeout_ms,
      maxPromptChars: data.limits.max_prompt_chars,
      maxResponseBytes: data.limits.max_response_bytes,
      maxOutputTokens: data.limits.max_output_tokens,
    },
    ollama: {
      baseUrl: data.ollama.base_url,
      model: data.ollama.model,
      ...(data.ollama.temperature !== undefined ? { temperature: data.ollama.temperature } : {}),
      ...(data.ollama.keep_alive !== undefined ? { keepAlive: data.ollama.keep_alive } : {}),
    },
    ...(data.anthropic !== undefined ? { anthropic: data.anthropic } : {}),
  };
  return config;
}

/** Reads and parses the LLM config file at `path`. */
export function loadLlmConfig(path: string): LlmConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new LlmConfigError(`cannot read llm config at ${path}: ${(cause as Error).message}`);
  }
  return parseLlmConfig(text);
}

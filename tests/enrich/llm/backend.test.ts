import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICES } from '../../../src/cost/registry.ts';
import { isPaidAllowed } from '../../../src/cost/gate.ts';
import {
  BackendNotWiredError,
  createLlmBackend,
} from '../../../src/enrich/llm/backend.ts';
import { OLLAMA_SERVICE_ID } from '../../../src/enrich/llm/ollama.ts';
import {
  ANTHROPIC_SERVICE_ID,
  AnthropicCredentialError,
} from '../../../src/enrich/llm/anthropic.ts';
import { DEFAULT_LLM_CONFIG_PATH, loadLlmConfig } from '../../../src/enrich/llm/config.ts';
import type { LlmConfig } from '../../../src/enrich/llm/config.ts';

function config(backend: LlmConfig['backend']): LlmConfig {
  return {
    backend,
    limits: {
      timeoutMs: 5_000,
      maxPromptChars: 24_000,
      maxResponseBytes: 1_048_576,
      maxOutputTokens: 512,
    },
    ollama: { baseUrl: 'http://127.0.0.1:1', model: 'a-model' },
  };
}

/** A config selecting anthropic, with the block that backend requires. */
function anthropicConfig(): LlmConfig {
  return {
    ...config('anthropic'),
    anthropic: {
      base_url: 'http://127.0.0.1:1',
      model: 'a-paid-model',
      pricing: { usd_per_million_input_tokens: 5, usd_per_million_output_tokens: 25 },
    },
  };
}

describe('createLlmBackend', () => {
  it('builds the backend the config selects, so swapping one is a config edit', () => {
    const backend = createLlmBackend(config('ollama'));
    expect(backend.name).toBe('ollama');
    expect(backend.model).toBe('a-model');
  });

  it('builds from the shipped config file without any argument but the config', () => {
    const backend = createLlmBackend(loadLlmConfig(join(process.cwd(), DEFAULT_LLM_CONFIG_PATH)));
    expect(backend.name).toBe('ollama');
    expect(backend.serviceId).toBe(OLLAMA_SERVICE_ID);
  });

  it('builds the anthropic backend, hard-disabled, when no paid flag is set', () => {
    // M5 task 2 landed the backend RULING 2 asked for: built, and shipped OFF.
    // Until it did, this threw BackendNotWiredError (below, which now guards a
    // different hole). The one thing that must never happen here is a quiet
    // return of Ollama -- see the next test.
    const backend = createLlmBackend(anthropicConfig(), {});
    expect(backend.name).toBe('anthropic');
    expect(backend.serviceId).toBe(ANTHROPIC_SERVICE_ID);
  });

  it('does NOT fall back to ollama when the paid flag is unset', () => {
    // §15's "never a silent fallback". An operator who selected anthropic and
    // forgot the flag must not get local inference reported as anthropic, nor
    // anthropic's identity on an ollama call. The honest answer is an anthropic
    // backend that refuses.
    const backend = createLlmBackend(anthropicConfig(), {});
    expect(backend.name).not.toBe('ollama');
    expect(backend.serviceId).not.toBe(OLLAMA_SERVICE_ID);
  });

  it('refuses to build anthropic when the flag is set but no credential is configured', () => {
    // The flag is the owner saying "spend money"; a backend that cannot
    // authenticate is a misconfiguration to fix now, not a status to report
    // once per scheduled pass.
    expect(() => createLlmBackend(anthropicConfig(), { WF_ALLOW_PAID_ANTHROPIC: '1' })).toThrow(
      AnthropicCredentialError,
    );
  });

  it('throws rather than returning undefined for a backend name no case covers', () => {
    // The switch is exhaustive over LlmBackendName today. This is the guard for
    // the day someone widens that union (or config.ts's enum) and forgets this
    // file: without the default branch the factory returns `undefined` and the
    // failure surfaces somewhere else entirely, as a missing method.
    const config = { ...anthropicConfig(), backend: 'gpt4all' as LlmConfig['backend'] };
    expect(() => createLlmBackend(config, {})).toThrow(BackendNotWiredError);
  });
});

describe('ollama-local in the cost registry', () => {
  it('is registered free-forever with no spend category', () => {
    // §15: "Ollama, being local, needs no flag." A category would imply a
    // WF_ALLOW_PAID_OLLAMA that must never exist.
    const entry = SERVICES.find((s) => s.id === OLLAMA_SERVICE_ID);
    expect(entry, 'src/cost/registry.ts has no ollama-local entry').toBeDefined();
    expect(entry!.costClass).toBe('free-forever');
    expect(entry!.category).toBeUndefined();
  });

  it('states affirmatively that no charge is possible at its limit', () => {
    // Deliberately a positive assertion rather than "does not contain the word
    // bill": the honest entry for a local service SAYS charging is impossible,
    // and a negative match would be satisfied by an entry that said nothing at
    // all about money -- and would also reject this one's own wording.
    const entry = SERVICES.find((s) => s.id === OLLAMA_SERVICE_ID)!;
    expect(entry.onLimit).toMatch(/no charge|cannot bill|never bills/i);
    expect(entry.rateLimit).toMatch(/local/i);
  });

  it('appears in docs/costs.md, which the gate test cross-checks', () => {
    const doc = readFileSync(join(process.cwd(), 'docs', 'costs.md'), 'utf8');
    expect(doc).toContain(OLLAMA_SERVICE_ID);
  });

  it('is exactly one row in docs/costs.md, not a duplicate', () => {
    // The registry entry predates this task. Adding a second row would leave
    // the doc/registry agreement test comparing against whichever it found
    // first.
    const rows = readFileSync(join(process.cwd(), 'docs', 'costs.md'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().startsWith('|') && line.includes(`\`${OLLAMA_SERVICE_ID}\``));
    expect(rows).toHaveLength(1);
  });
});

describe('the local backend is reachable with every paid flag unset', () => {
  it('needs no WF_ALLOW_PAID_* flag to be constructed', () => {
    // The zero-dollar rule is about what the system is CAPABLE of touching.
    // Ollama is capable of touching only the owner's own hardware, so it must
    // work in the default, flagless configuration -- otherwise RULING 2's
    // "Ollama is the only enabled backend" would be false on a clean install.
    const env = {};
    expect(isPaidAllowed('anthropic', env)).toBe(false);
    expect(createLlmBackend(config('ollama')).name).toBe('ollama');
  });

  it('consults no spend gate at all, by grep', () => {
    // Not merely "does not need a flag" -- must not CALL the gate. A gate call
    // here would be a standing invitation to add the category it checks.
    const source = readFileSync(join(process.cwd(), 'src', 'enrich', 'llm', 'ollama.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(source).not.toMatch(/isPaidAllowed|assertPaidAllowed|WF_ALLOW_PAID/);
  });
});

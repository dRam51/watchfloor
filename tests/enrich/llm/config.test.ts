import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_LLM_CONFIG_PATH,
  LlmConfigError,
  loadLlmConfig,
  parseLlmConfig,
} from '../../../src/enrich/llm/config.ts';

const MINIMAL = `
backend: ollama
limits:
  timeout_ms: 120000
  max_prompt_chars: 24000
  max_response_bytes: 1048576
  max_output_tokens: 512
ollama:
  base_url: http://127.0.0.1:11434
  model: llama3.2:latest
  temperature: 0
`;

describe('parseLlmConfig', () => {
  it('reads the model name from config, which is the whole point of the file', () => {
    const config = parseLlmConfig(MINIMAL);
    expect(config.backend).toBe('ollama');
    expect(config.ollama.model).toBe('llama3.2:latest');
  });

  it('reads the base url from config, because the target host may not be this one', () => {
    // CLAUDE.md's portability debt: "Ollama on Apple Silicon uses Metal; a
    // mini PC without a capable GPU may not run the same model at all."
    expect(parseLlmConfig(MINIMAL).ollama.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('carries every bound the backend enforces', () => {
    const { limits } = parseLlmConfig(MINIMAL);
    expect(limits).toEqual({
      timeoutMs: 120_000,
      maxPromptChars: 24_000,
      maxResponseBytes: 1_048_576,
      maxOutputTokens: 512,
    });
  });

  it('accepts anthropic as a backend selection even though task 1 does not implement it', () => {
    // RULING 2: Anthropic ships built and hard-disabled in task 2. A `backend`
    // enum it has to widen later is one every switch silently stops covering.
    const config = parseLlmConfig(MINIMAL.replace('backend: ollama', 'backend: anthropic'));
    expect(config.backend).toBe('anthropic');
  });

  it('leaves an anthropic block alone rather than rejecting it', () => {
    // Task 2 owns that block's shape. A strict schema that has never heard of
    // it would make task 2's config edit fail this task's loader.
    expect(() => parseLlmConfig(`${MINIMAL}\nanthropic:\n  model: some-model\n`)).not.toThrow();
  });

  it('rejects an unknown backend rather than falling back to a default', () => {
    expect(() => parseLlmConfig(MINIMAL.replace('backend: ollama', 'backend: gpt4all'))).toThrow(
      LlmConfigError,
    );
  });

  it('rejects a missing model rather than picking one', () => {
    expect(() => parseLlmConfig(MINIMAL.replace('  model: llama3.2:latest\n', ''))).toThrow(
      LlmConfigError,
    );
  });

  it('rejects a non-http base url', () => {
    // A typo here produces a backend that can never connect, and the failure
    // would otherwise surface as `not_running` -- pointing the operator at the
    // daemon rather than at the config line that is actually wrong.
    expect(() =>
      parseLlmConfig(MINIMAL.replace('http://127.0.0.1:11434', 'localhost:11434')),
    ).toThrow(LlmConfigError);
  });

  it('rejects a zero or negative timeout, which would abort every call', () => {
    expect(() => parseLlmConfig(MINIMAL.replace('timeout_ms: 120000', 'timeout_ms: 0'))).toThrow(
      LlmConfigError,
    );
  });

  it('rejects a zero output cap, which would make every answer empty', () => {
    // The one failure that looks exactly like a working system producing
    // nothing worth reading.
    expect(() =>
      parseLlmConfig(MINIMAL.replace('max_output_tokens: 512', 'max_output_tokens: 0')),
    ).toThrow(LlmConfigError);
  });

  it('rejects a temperature outside the range a sampler accepts', () => {
    expect(() => parseLlmConfig(MINIMAL.replace('temperature: 0', 'temperature: -1'))).toThrow(
      LlmConfigError,
    );
  });

  it('names the offending key when it refuses', () => {
    let message = '';
    try {
      parseLlmConfig(MINIMAL.replace('timeout_ms: 120000', 'timeout_ms: -5'));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/timeout_ms/);
  });

  it('refuses malformed yaml rather than loading a partial config', () => {
    expect(() => parseLlmConfig('backend: [unclosed')).toThrow(LlmConfigError);
  });
});

describe('the shipped config/llm.yaml', () => {
  it('loads', () => {
    const config = loadLlmConfig(join(process.cwd(), DEFAULT_LLM_CONFIG_PATH));
    expect(config.backend).toBe('ollama');
    expect(config.ollama.model.length).toBeGreaterThan(0);
  });

  it('selects ollama, the only backend RULING 2 enables', () => {
    expect(loadLlmConfig(join(process.cwd(), DEFAULT_LLM_CONFIG_PATH)).backend).toBe('ollama');
  });
});

describe('no model name is hardcoded in src/', () => {
  it('mentions no ollama model tag anywhere under src/enrich/llm', () => {
    // Requirement 1: "Model name belongs in config, never in code." A default
    // baked into the backend would silently keep working after config/llm.yaml
    // was edited, which is the failure this grep exists to catch.
    const dir = join(process.cwd(), 'src', 'enrich', 'llm');
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      // Comments are stripped first: naming a model in prose (explaining WHY
      // config/llm.yaml picks one) is documentation, not a hardcoded default.
      // The guard is about literals the code could actually reach.
      const code = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
      // A model tag looks like `name:tag` -- llama3.2:latest, qwen2.5:7b,
      // mistral:latest -- inside a string literal.
      if (/['"`][a-z0-9][a-z0-9._-]*:(latest|\d+[bm]|[a-z0-9-]*q\d)/i.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { loadLlmConfig } from '../../src/enrich/llm/config.ts';
import { createLlmBackend } from '../../src/enrich/llm/backend.ts';
import { SERVICES } from '../../src/cost/registry.ts';
import { getEnrichmentStatus } from '../../src/domain/headerStrip.ts';

/**
 * §15's FIRST clause (M5 task 14): *"the scheduler skips the job."*
 *
 * `tests/cost/no-paid-requests.test.ts` proves no request escapes the gate.
 * This file answers a different question, and a weaker-sounding one that
 * turns out to matter more here: **is there a scheduled paid job at all?**
 *
 * The answer today is no, and that is a fact about the shape of the tree
 * rather than a promise — so it is asserted rather than written down. If it
 * ever stops being true, these go red before a live run has to find out.
 *
 * Nothing here weakens the zero-dollar proof; it does not touch it.
 */

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');
const LLM_CONFIG_PATH = join(REPO_ROOT, 'config', 'llm.yaml');
const NO_FLAGS: NodeJS.ProcessEnv = { WF_TZ: 'America/New_York' };
const NOW = '2026-08-16T12:00:00.000Z';

/** Removes block and line comments so a grep sees code, not prose about code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the paid path has exactly one construction site in the running system', () => {
  it('nothing but src/vault/sync.ts calls createLlmBackend', () => {
    // The factory is the ONLY route from config to a backend that could bill
    // (src/enrich/llm/backend.ts's own doc comment). Bounding its callers is
    // what makes "which scheduled jobs can spend?" an answerable question
    // instead of a search. A second call site is not forbidden -- it just has
    // to be considered here, and named.
    const callers = tsFiles(SRC)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /\bcreateLlmBackend\s*\(/.test(source) && !file.endsWith(join('llm', 'backend.ts'));
      })
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .sort();

    expect(callers).toEqual(['src/vault/sync.ts']);
  });

  it('the scheduler reaches it only through the vault sync deps', () => {
    // So the enrichment backend is built once, at boot, when a vault is
    // configured -- and the poll loop itself constructs nothing.
    const scheduler = readFileSync(join(SRC, 'bin', 'scheduler.ts'), 'utf8');
    expect(scheduler).not.toMatch(/\bcreateLlmBackend\s*\(/);
    expect(scheduler).toMatch(/loadVaultSyncDeps\s*\(/);
  });
});

describe('what the shipped configuration actually schedules', () => {
  it('config/llm.yaml selects a free-forever backend, so no scheduled job can originate a charge', () => {
    // THE EVIDENCE BEHIND §15's FIRST CLAUSE. There is no paid job to skip:
    // createLlmBackend never constructs the Anthropic backend while
    // `backend: ollama`, so the only module in the tree that can bill is not
    // instantiated by the daemon at all.
    //
    // IF THE OWNER ENABLES ANTHROPIC (M5 plan RULING 2 explicitly anticipates
    // it), READ THIS TEST FIRST. It will go red, and the question it is asking
    // becomes live: with the paid backend selected, every weekly-blurb call is
    // refused at the gate, once per weekly slot, and the note is still written
    // without blurbs. That is a refusal, not a deferred retry -- but it is
    // work the scheduler could skip instead of attempting.
    const config = loadLlmConfig(LLM_CONFIG_PATH);
    const backend = createLlmBackend(config, NO_FLAGS);
    const entry = SERVICES.find((service) => service.id === backend.serviceId);

    expect(backend.name).toBe('ollama');
    expect(entry?.costClass).toBe('free-forever');
  });

  it('nothing retries a cost-policy refusal -- §15\'s "never a deferred retry"', () => {
    // src/enrich/cached.ts returns the unavailable result and stops; the
    // weekly cadence is level-triggered on slot identity, so the next attempt
    // is the next weekly slot, not a backoff.
    //
    // Asserted on the text because the absence of a loop is what is being
    // claimed, and an absence has no behaviour to observe. Comments are
    // stripped first -- the word "retry" appears in that file's own prose
    // precisely because it explains why there is none, and a naive grep is
    // fooled by the documentation of the property it is checking.
    const cached = stripComments(readFileSync(join(SRC, 'enrich', 'cached.ts'), 'utf8'));
    expect(cached).not.toMatch(/\b(setTimeout|setInterval)\s*\(/);
    // Exactly one call site, and no timer to re-enter it from.
    expect(cached.match(/\.complete\s*\(/g)).toHaveLength(1);
  });
});

describe('the scheduler states the cost policy at boot', () => {
  it('loads config/llm.yaml and logs the same status the API publishes', () => {
    // A source-text assertion, for the reason tests/ingest/postCycleWiring.test.ts
    // gives: the claim is that a call site EXISTS in a composition root, and a
    // composition root is the code no unit test instantiates. Task 15 recorded
    // that the daemon's tick cannot be exercised at all (loadSourcesFile is
    // hardcoded, so it would poll 28 real sources).
    //
    // The SAME function the dashboard reads, not a second sentence: two
    // hand-written descriptions of one policy are two descriptions that drift.
    const scheduler = readFileSync(join(SRC, 'bin', 'scheduler.ts'), 'utf8');
    expect(scheduler).toContain("from '../enrich/llm/config.ts'");
    expect(scheduler).toMatch(/loadLlmConfig\s*\(/);
    expect(scheduler).toContain("from '../domain/headerStrip.ts'");
    expect(scheduler).toMatch(/getEnrichmentStatus\s*\(/);
  });

  it('the sentence it logs names the state and, when shut, the flag', () => {
    // What the boot line actually says, for both branches of the only
    // decision that changes it.
    const free = getEnrichmentStatus(NO_FLAGS, NOW, {
      llmConfig: loadLlmConfig(LLM_CONFIG_PATH),
    });
    expect(free.note).toContain("selects the 'ollama' backend");
    expect(free.note).toMatch(/no enrichment call can originate a charge/);

    const paid = getEnrichmentStatus(NO_FLAGS, NOW, {
      llmConfig: { ...loadLlmConfig(LLM_CONFIG_PATH), backend: 'anthropic' },
    });
    expect(paid.note).toMatch(/disabled by cost policy/i);
    expect(paid.note).toContain('WF_ALLOW_PAID_ANTHROPIC=1');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { recordLlmCall, type LlmCallObservation } from '../../src/db/llmCallLog.ts';
import { parseLlmConfig, type LlmConfig } from '../../src/enrich/llm/config.ts';
import { SPEND_CATEGORIES } from '../../src/cost/registry.ts';
import { getEnrichmentStatus, getEnrichmentSpendToday } from '../../src/domain/headerStrip.ts';

/**
 * §15's second and third clauses (M5 task 14): *"the API returns a clear
 * 'disabled by cost policy' status, and the dashboard shows the feature as
 * off."*
 *
 * Task 2 built a backend that REPORTS `disabled_by_cost_policy`; nothing
 * rendered it. This is the read path.
 *
 * ## The three facts these tests refuse to let collapse
 *
 * The whole point of a separate status object is that these are three
 * different sentences, and any two of them collapsed produces a dashboard
 * that lies:
 *
 *  1. **the paid backend is off by cost policy** — the shipped, chosen state
 *     (M5 plan RULING 2). Pure config + environment; the ledger cannot
 *     influence it.
 *  2. **enrichment spend is a measured $0** — already true, already published
 *     by `enrichmentSpend`, and deliberately NOT re-derived here.
 *  3. **the local backend is unreachable** — a real problem, measured from
 *     `llm_call_log` rather than probed.
 *
 * A shut cost gate must never read as "the backend is down"; a down daemon
 * must never read as "spending is enabled"; and a measured $0 must never be
 * evidence that anything worked.
 */

const open: Db[] = [];
function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

const NY = 'America/New_York';
const NOW = '2026-08-15T13:00:00.000Z'; // 09:00 NY -- the 15th in both zones
const KEY = 'd'.repeat(64);

const GATE_SHUT: NodeJS.ProcessEnv = { WF_TZ: NY };
const GATE_OPEN: NodeJS.ProcessEnv = { WF_TZ: NY, WF_ALLOW_PAID_ANTHROPIC: '1' };

function call(overrides: Partial<LlmCallObservation> = {}): LlmCallObservation {
  return {
    cacheKey: KEY,
    task: 'summary',
    backend: 'ollama',
    model: 'llama3.2:latest',
    serviceId: 'ollama-local',
    status: 'ok',
    inputTokens: 42,
    outputTokens: 27,
    amountUsd: 0,
    costMeasured: true,
    latencyMs: 784,
    calledAt: NOW,
    tz: NY,
    ...overrides,
  };
}

/** The shipped configuration: Ollama, free-forever, no flag involved. */
function ollamaConfig(): LlmConfig {
  return parseLlmConfig(`
backend: ollama
limits: { timeout_ms: 120000, max_prompt_chars: 24000, max_response_bytes: 1048576, max_output_tokens: 512 }
ollama: { base_url: 'http://127.0.0.1:11434', model: 'llama3.2:latest', temperature: 0 }
`);
}

/** The paid backend selected -- the state §15's wording is actually about. */
function anthropicConfig(): LlmConfig {
  return parseLlmConfig(`
backend: anthropic
limits: { timeout_ms: 120000, max_prompt_chars: 24000, max_response_bytes: 1048576, max_output_tokens: 512 }
ollama: { base_url: 'http://127.0.0.1:11434', model: 'llama3.2:latest' }
anthropic:
  base_url: 'https://example.invalid'
  model: 'claude-opus-5'
  pricing: { usd_per_million_input_tokens: 5, usd_per_million_output_tokens: 25 }
`);
}

// ---------------------------------------------------------------------------
// Fact 1 -- the cost policy. Config and environment only.
// ---------------------------------------------------------------------------

describe('the configured backend, and whether cost policy permits it', () => {
  it('reports the shipped Ollama configuration as enabled and free-forever', () => {
    // The owner chose Ollama deliberately (M5 plan RULING 2). This must read
    // as configuration, not as a fault: the backend is enabled, and the paid
    // path being off is a separate line.
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { llmConfig: ollamaConfig() });
    expect(status.backend).toEqual({
      name: 'ollama',
      model: 'llama3.2:latest',
      serviceId: 'ollama-local',
      costClass: 'free-forever',
      spendCategory: null,
      state: 'enabled',
    });
  });

  it('reports the paid backend as disabled_by_cost_policy when its flag is unset', () => {
    // The state §15's second clause names, verbatim. Here enrichment is not
    // merely "paid path off" -- NOTHING can run, because the selected backend
    // is the one that is hard-disabled.
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { llmConfig: anthropicConfig() });
    expect(status.backend?.name).toBe('anthropic');
    expect(status.backend?.state).toBe('disabled_by_cost_policy');
    expect(status.backend?.costClass).toBe('paid');
    expect(status.backend?.spendCategory).toBe('anthropic');
  });

  it('reports the paid backend as enabled once its flag is set', () => {
    const status = getEnrichmentStatus(GATE_OPEN, NOW, { llmConfig: anthropicConfig() });
    expect(status.backend?.state).toBe('enabled');
  });

  it('lists EVERY paid spend category, not only the configured one', () => {
    // Registry-driven, the same discipline tests/cost/no-paid-requests.test.ts
    // uses: when M4b adds a markets-data client, this reports it without an
    // edit here, rather than quietly omitting a paid path from the dashboard.
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { llmConfig: ollamaConfig() });
    expect(status.paidPaths.map((p) => p.category).sort()).toEqual([...SPEND_CATEGORIES].sort());
    const anthropic = status.paidPaths.find((p) => p.category === 'anthropic')!;
    expect(anthropic).toEqual({
      category: 'anthropic',
      flag: 'WF_ALLOW_PAID_ANTHROPIC',
      state: 'disabled_by_cost_policy',
      selected: false,
    });
  });

  it('marks the paid category SELECTED when config/llm.yaml chose that backend', () => {
    // "off" and "off, and it is the one enrichment was told to use" are
    // different situations: the first is a choice, the second is a dead
    // feature.
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { llmConfig: anthropicConfig() });
    expect(status.paidPaths.find((p) => p.category === 'anthropic')!.selected).toBe(true);
    expect(status.paidPaths.find((p) => p.category === 'marketdata')!.selected).toBe(false);
  });

  it('reports backend: null when the caller supplied no config, and says so', () => {
    // Same stance getEnrichmentSpendToday takes with no ledger: report the
    // absence rather than guessing a default that would be wrong the moment
    // config/llm.yaml changed.
    const status = getEnrichmentStatus(GATE_SHUT, NOW);
    expect(status.backend).toBeNull();
    expect(status.note).toMatch(/no llm config/i);
    // The gate is still answerable without config -- it is pure environment.
    expect(status.paidPaths.find((p) => p.category === 'anthropic')!.state).toBe(
      'disabled_by_cost_policy',
    );
  });
});

// ---------------------------------------------------------------------------
// Fact 3 -- reachability, measured from the ledger and never probed.
// ---------------------------------------------------------------------------

describe('whether the configured backend could actually be reached', () => {
  it('is unknown with no ledger at all -- absence of evidence is not health', () => {
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { llmConfig: ollamaConfig() });
    expect(status.reachability.status).toBe('unknown');
    expect(status.reachability.day).toBeNull();
  });

  it('is unknown on a day nothing was attempted', () => {
    // A quiet day is not a healthy day. Enrichment runs on the vault cadence,
    // so "no call today" is ordinary and must not be dressed up as `reachable`.
    const db = migratedDb();
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: ollamaConfig() });
    expect(status.reachability.status).toBe('unknown');
    expect(status.reachability.attempts).toBe(0);
    expect(status.reachability.day).toBe('2026-08-15');
  });

  it('is reachable when the most recent attempt reached a model', () => {
    const db = migratedDb();
    recordLlmCall(db, call());
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: ollamaConfig() });
    expect(status.reachability.status).toBe('reachable');
    expect(status.reachability.reached).toBe(1);
  });

  it('is unreachable when the daemon is not running', () => {
    const db = migratedDb();
    recordLlmCall(
      db,
      call({
        status: 'unavailable',
        unavailableReason: 'not_running',
        inputTokens: null,
        outputTokens: null,
      }),
    );
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: ollamaConfig() });
    expect(status.reachability.status).toBe('unreachable');
    expect(status.reachability.unreached).toBe(1);
    expect(status.reachability.detail).toMatch(/not_running/);
  });

  it('carries the last attempt\'s reason as a field, not only inside the sentence', () => {
    // A dashboard has to show WHY the daemon is unreachable without making
    // the operator hover over a paragraph, and §7.1 puts that judgement
    // server-side -- so the reason travels as a value rather than being
    // re-extracted from prose by a regex in the frontend.
    const db = migratedDb();
    recordLlmCall(
      db,
      call({
        status: 'unavailable',
        unavailableReason: 'timeout',
        inputTokens: null,
        outputTokens: null,
      }),
    );
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: ollamaConfig() });
    expect(status.reachability.reason).toBe('timeout');
  });

  it('reports no reason at all when the last attempt succeeded', () => {
    const db = migratedDb();
    recordLlmCall(db, call());
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: ollamaConfig() });
    expect(status.reachability.reason).toBeNull();
  });

  it('treats model_missing as REACHED -- the daemon answered, it just lacks the model', () => {
    // Task 1's finding, load-bearing here: collapsing not_running and
    // model_missing "sends an operator to restart a healthy daemon". The
    // reachability line must not do that.
    const db = migratedDb();
    recordLlmCall(
      db,
      call({
        status: 'unavailable',
        unavailableReason: 'model_missing',
        inputTokens: null,
        outputTokens: null,
      }),
    );
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: ollamaConfig() });
    expect(status.reachability.status).toBe('reachable');
    expect(status.reachability.reached).toBe(1);
  });

  it('follows the LATEST attempt, not the day total -- a daemon that died at noon is down now', () => {
    const db = migratedDb();
    recordLlmCall(db, call({ calledAt: '2026-08-15T12:00:00.000Z' }));
    recordLlmCall(
      db,
      call({
        calledAt: '2026-08-15T12:30:00.000Z',
        status: 'unavailable',
        unavailableReason: 'not_running',
        inputTokens: null,
        outputTokens: null,
      }),
    );
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: ollamaConfig() });
    expect(status.reachability.status).toBe('unreachable');
    expect(status.reachability.reached).toBe(1);
    expect(status.reachability.unreached).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The collapses this object exists to prevent.
// ---------------------------------------------------------------------------

describe('the three facts stay apart', () => {
  it('a shut cost gate NEVER reads as an unreachable backend', () => {
    // The single most likely wrong rendering: `disabled_by_cost_policy` is an
    // LlmUnavailableReason like any other in the ledger, so a naive "count the
    // unavailable calls" reachability check reports a healthy local daemon as
    // down whenever the paid backend is off. It is not an attempt at all.
    const db = migratedDb();
    recordLlmCall(
      db,
      call({
        backend: 'anthropic',
        model: 'claude-opus-5',
        serviceId: 'anthropic-api',
        status: 'unavailable',
        unavailableReason: 'disabled_by_cost_policy',
        inputTokens: null,
        outputTokens: null,
        amountUsd: null,
        costMeasured: false,
      }),
    );
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: anthropicConfig() });
    expect(status.reachability.status).toBe('unknown');
    expect(status.reachability.attempts).toBe(0);
    expect(status.reachability.unreached).toBe(0);
    expect(status.reachability.costPolicyRefusals).toBe(1);
    // ...and the cost-policy fact is still reported, on its own line.
    expect(status.backend?.state).toBe('disabled_by_cost_policy');
  });

  it('an unreachable local backend NEVER reads as spending being enabled', () => {
    const db = migratedDb();
    recordLlmCall(
      db,
      call({
        status: 'unavailable',
        unavailableReason: 'not_running',
        inputTokens: null,
        outputTokens: null,
      }),
    );
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: ollamaConfig() });
    expect(status.reachability.status).toBe('unreachable');
    expect(status.paidPaths.every((p) => p.state === 'disabled_by_cost_policy')).toBe(true);
  });

  it('a measured $0 is NOT evidence that anything worked', () => {
    // Both objects are computed over the same empty day and must disagree:
    // spend is a measured zero (a guarantee), reachability is unknown (an
    // absence). Collapsing them would turn "nothing ran" into "all is well".
    const db = migratedDb();
    const spend = getEnrichmentSpendToday(GATE_SHUT, NOW, { db });
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { db, llmConfig: ollamaConfig() });
    expect(spend.amountUsd).toBe(0);
    expect(spend.measured).toBe(true);
    expect(status.reachability.status).toBe('unknown');
  });

  it('reports spend nowhere -- that fact belongs to enrichmentSpend and is not duplicated', () => {
    // Two fields publishing the same number is two fields that can disagree.
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { llmConfig: ollamaConfig() });
    expect(Object.keys(status).sort()).toEqual([
      'asOf',
      'backend',
      'note',
      'paidPaths',
      'reachability',
    ]);
    expect(JSON.stringify(status)).not.toMatch(/amountUsd/);
  });
});

describe('the instant is injected, never read', () => {
  it('carries the caller-supplied now as asOf', () => {
    const status = getEnrichmentStatus(GATE_SHUT, NOW, { llmConfig: ollamaConfig() });
    expect(status.asOf).toBe(NOW);
  });

  it('scopes the ledger day to WF_TZ, and says so when the zone is unusable', () => {
    // Same stance getEnrichmentSpendToday takes: "today" is not answerable
    // without a zone, and assuming UTC would produce a wrong answer presented
    // as a right one.
    const db = migratedDb();
    recordLlmCall(db, call());
    const status = getEnrichmentStatus({ WF_TZ: 'Not/AZone' }, NOW, {
      db,
      llmConfig: ollamaConfig(),
    });
    expect(status.reachability.status).toBe('unknown');
    expect(status.reachability.day).toBeNull();
    expect(status.reachability.detail).toMatch(/WF_TZ/);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { registerAuth } from '../../src/api/auth.ts';
import { registerDashboard } from '../../src/api/routes/dashboard.ts';
import { buildServer } from '../../src/api/server.ts';
import { loadEnv } from '../../src/config/env.ts';
import { loadDecayConfig } from '../../src/score/decay.ts';
import { loadOverridesConfig } from '../../src/score/overrides.ts';
import { loadSourcesFile } from '../../src/sources/load.ts';
import { loadLlmConfig } from '../../src/enrich/llm/config.ts';
import { recordLlmCall } from '../../src/db/llmCallLog.ts';

/**
 * §15 through the route (M5 task 14): *"the API returns a clear 'disabled by
 * cost policy' status."*
 *
 * `enrichmentSpend` was fed rather than replaced at task 3, and the same
 * discipline applies here — this adds a **sibling** field. The reason it is a
 * sibling and not more of `enrichmentSpend` is in
 * src/domain/headerStrip.ts's own doc comment: spend and policy are two facts,
 * and a field that publishes a number must not also publish a configuration.
 *
 * Own file, not appended to tests/api/dashboard.test.ts or
 * tests/api/dashboardEnrichmentSpend.test.ts, for the reason the latter
 * already records: a concurrent sibling could be in either this wave.
 */

const TOKEN = 'a-real-token-that-is-long-enough';
const NY = 'America/New_York';
const NOW = '2026-08-15T13:00:00.000Z';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const REPO_ROOT = process.cwd();
const LLM_CONFIG_PATH = join(REPO_ROOT, 'config', 'llm.yaml');

const open: Db[] = [];

function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(REPO_ROOT, 'db', 'migrations'));
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

/** The route, standalone -- the pattern every route test in this directory uses. */
function routeServer(db: Db, env: NodeJS.ProcessEnv): FastifyInstance {
  const server = Fastify({ logger: false });
  registerAuth(server, TOKEN);
  registerDashboard(server, {
    db,
    sources: [],
    env,
    now: () => NOW,
    llmConfig: loadLlmConfig(LLM_CONFIG_PATH),
  });
  return server;
}

async function header(server: FastifyInstance): Promise<Record<string, any>> {
  const res = await server.inject({ method: 'GET', url: '/dashboard/header', headers: AUTH });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('GET /dashboard/header -- enrichment', () => {
  it('publishes the cost-policy status beside the spend, never inside it', async () => {
    const db = migratedDb();
    const server = routeServer(db, { WF_TZ: NY });
    const body = await header(server);

    expect(Object.keys(body.enrichment).sort()).toEqual([
      'asOf',
      'backend',
      'note',
      'paidPaths',
      'reachability',
    ]);
    // The M3 field is untouched: its own report promised real numbers at M5
    // without a client change, and that promise still has to hold.
    expect(Object.keys(body.enrichmentSpend).sort()).toEqual([
      'amountUsd',
      'asOf',
      'measured',
      'note',
    ]);
    await server.close();
  });

  it("names the flag to set, so the remedy does not require reading the source", async () => {
    const db = migratedDb();
    const server = routeServer(db, { WF_TZ: NY });
    const body = await header(server);

    const anthropic = body.enrichment.paidPaths.find((p: any) => p.category === 'anthropic');
    expect(anthropic.state).toBe('disabled_by_cost_policy');
    expect(anthropic.flag).toBe('WF_ALLOW_PAID_ANTHROPIC');
    await server.close();
  });

  it('reports the backend config/llm.yaml actually selects, not a hardcoded guess', async () => {
    // A literal 'ollama' here would keep passing after someone edited
    // config/llm.yaml, which is the only way this field can go wrong quietly.
    const configured = loadLlmConfig(LLM_CONFIG_PATH);
    const db = migratedDb();
    const server = routeServer(db, { WF_TZ: NY });
    const body = await header(server);

    expect(body.enrichment.backend.name).toBe(configured.backend);
    await server.close();
  });

  it('flips the paid path to enabled when the flag is set, without touching reachability', async () => {
    const db = migratedDb();
    const server = routeServer(db, { WF_TZ: NY, WF_ALLOW_PAID_ANTHROPIC: '1' });
    const body = await header(server);

    expect(
      body.enrichment.paidPaths.find((p: any) => p.category === 'anthropic').state,
    ).toBe('enabled');
    // Opening a gate is not evidence that anything can be reached.
    expect(body.enrichment.reachability.status).toBe('unknown');
    await server.close();
  });

  it('reports an unreachable local daemon while the cost gate stays shut and spend stays a measured zero', async () => {
    // All three facts in one response, disagreeing exactly as they should.
    const db = migratedDb();
    recordLlmCall(db, {
      cacheKey: 'e'.repeat(64),
      task: 'summary',
      backend: 'ollama',
      model: 'llama3.2:latest',
      serviceId: 'ollama-local',
      status: 'unavailable',
      unavailableReason: 'not_running',
      inputTokens: null,
      outputTokens: null,
      amountUsd: 0,
      costMeasured: true,
      latencyMs: 2,
      calledAt: NOW,
      tz: NY,
    });
    const server = routeServer(db, { WF_TZ: NY });
    const body = await header(server);

    expect(body.enrichment.reachability.status).toBe('unreachable');
    expect(body.enrichment.backend.state).toBe('enabled');
    expect(body.enrichmentSpend.amountUsd).toBe(0);
    expect(body.enrichmentSpend.measured).toBe(true);
    await server.close();
  });

  it('computes both enrichment fields at ONE instant', async () => {
    // M4a's finding, in this file's own words: before it was fixed, the
    // failing count read the wall clock while enrichmentSpend honoured the
    // injected one, so a pinned `now` produced a header whose halves were
    // computed at different times.
    const db = migratedDb();
    const server = routeServer(db, { WF_TZ: NY });
    const body = await header(server);

    expect(body.enrichment.asOf).toBe(NOW);
    expect(body.enrichment.asOf).toBe(body.enrichmentSpend.asOf);
    await server.close();
  });

  it('still answers without an llm config, reporting the absence rather than a default', async () => {
    const db = migratedDb();
    const server = Fastify({ logger: false });
    registerAuth(server, TOKEN);
    registerDashboard(server, { db, sources: [], env: { WF_TZ: NY }, now: () => NOW });
    const body = await header(server);

    expect(body.enrichment.backend).toBeNull();
    expect(body.enrichment.paidPaths.length).toBeGreaterThan(0);
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// The wiring. CLAUDE.md's characteristic defect, eight occurrences and
// counting: a component that is correct, tested, and reachable from nothing.
// ---------------------------------------------------------------------------

const REAL_ENV = loadEnv({
  WF_DB_PATH: './data/wf.db',
  WF_DATA_DIR: './data',
  WF_LOG_DIR: './logs',
  WF_TZ: NY,
  WF_API_TOKEN: TOKEN,
});

describe('the composition root actually supplies the config', () => {
  it('buildServer forwards llmConfig to the dashboard route', async () => {
    // Route tests build their own Fastify instance, so every one of them stays
    // green with the dep dropped from server.ts. This is the half that does
    // not.
    const db = migratedDb();
    const server = buildServer({
      db,
      env: REAL_ENV,
      sources: loadSourcesFile(join(REPO_ROOT, 'config', 'sources.yaml')).slice(0, 1),
      decayConfig: loadDecayConfig(join(REPO_ROOT, 'config', 'decay.yaml')),
      overridesConfig: loadOverridesConfig(join(REPO_ROOT, 'config', 'overrides.yaml')),
      llmConfig: loadLlmConfig(LLM_CONFIG_PATH),
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/dashboard/header',
      headers: AUTH,
    });
    expect(res.json().enrichment.backend).not.toBeNull();
    await server.close();
  });

  it('src/bin/api.ts loads config/llm.yaml at boot and hands it to buildServer', () => {
    // A source-text assertion, for the reason tests/ingest/postCycleWiring.test.ts
    // gives: the thing asserted is that a call site EXISTS in a composition
    // root, and a composition root is the code no unit test instantiates.
    // Without this the field above is `null` in the process that actually
    // serves the dashboard, and every test in this file still passes.
    const source = readFileSync(join(REPO_ROOT, 'src', 'bin', 'api.ts'), 'utf8');
    expect(source).toContain("from '../enrich/llm/config.ts'");
    expect(source).toMatch(/loadLlmConfig\s*\(/);
    expect(source).toMatch(/buildServer\([^)]*llmConfig/s);
  });
});

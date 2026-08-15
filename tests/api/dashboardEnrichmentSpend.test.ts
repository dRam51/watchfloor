import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { registerAuth } from '../../src/api/auth.ts';
import { registerDashboard } from '../../src/api/routes/dashboard.ts';
import { recordLlmCall } from '../../src/db/llmCallLog.ts';

/**
 * `enrichmentSpend` end to end, through the route (M5 task 3).
 *
 * Kept in its own file rather than appended to tests/api/dashboard.test.ts:
 * that file was written by M3 task 6 and a concurrent sibling could be in it
 * this wave. Same local-server pattern it uses.
 */

const TOKEN = 'a-real-token-that-is-long-enough';
const open: Db[] = [];

function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

function buildTestServer(db: Db, env: NodeJS.ProcessEnv): FastifyInstance {
  const server = Fastify({ logger: false });
  registerAuth(server, TOKEN);
  registerDashboard(server, { db, sources: [], env, now: () => NOW });
  return server;
}

const AUTH = { authorization: `Bearer ${TOKEN}` };
const NY = 'America/New_York';
const NOW = '2026-08-15T13:00:00.000Z';

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

describe('GET /dashboard/header -- enrichmentSpend', () => {
  it('publishes the same four fields it always has', async () => {
    const db = migratedDb();
    const server = buildTestServer(db, { WF_TZ: NY });

    const res = await server.inject({ method: 'GET', url: '/dashboard/header', headers: AUTH });
    const spend = res.json().enrichmentSpend as Record<string, unknown>;

    expect(Object.keys(spend).sort()).toEqual(['amountUsd', 'asOf', 'measured', 'note']);
    expect(spend.asOf).toBe(NOW);
    await server.close();
  });

  it('reports a measured zero with real local calls behind it', async () => {
    // The whole point of feeding rather than replacing the field: the number
    // is still 0, but it is now 0 BECAUSE two priced calls summed to it, not
    // because nothing could have spent. The note is what carries that.
    const db = migratedDb();
    for (const inputTokens of [42, 100]) {
      recordLlmCall(db, {
        cacheKey: 'c'.repeat(64),
        task: 'summary',
        backend: 'ollama',
        model: 'llama3.2',
        serviceId: 'ollama-local',
        status: 'ok',
        inputTokens,
        outputTokens: 27,
        amountUsd: 0,
        costMeasured: true,
        latencyMs: 500,
        calledAt: NOW,
        tz: NY,
      });
    }

    const server = buildTestServer(db, { WF_TZ: NY });
    const res = await server.inject({ method: 'GET', url: '/dashboard/header', headers: AUTH });
    const spend = res.json().enrichmentSpend as { amountUsd: number; measured: boolean; note: string };

    expect(spend.amountUsd).toBe(0);
    expect(spend.measured).toBe(true);
    expect(spend.note).toMatch(/2 enrichment call/);
    expect(spend.note).toMatch(/196 tokens/);
    await server.close();
  });

  it('sums a billable day once the gate is open', async () => {
    const db = migratedDb();
    recordLlmCall(db, {
      cacheKey: 'c'.repeat(64),
      task: 'summary',
      backend: 'anthropic',
      model: 'claude-opus-5',
      serviceId: 'anthropic-api',
      status: 'ok',
      inputTokens: 1000,
      outputTokens: 200,
      amountUsd: 0.01,
      costMeasured: true,
      latencyMs: 900,
      calledAt: NOW,
      tz: NY,
    });

    const server = buildTestServer(db, { WF_TZ: NY, WF_ALLOW_PAID_ANTHROPIC: '1' });
    const res = await server.inject({ method: 'GET', url: '/dashboard/header', headers: AUTH });
    const spend = res.json().enrichmentSpend as { amountUsd: number; measured: boolean };

    expect(spend.amountUsd).toBeCloseTo(0.01, 10);
    expect(spend.measured).toBe(true);
    await server.close();
  });
});

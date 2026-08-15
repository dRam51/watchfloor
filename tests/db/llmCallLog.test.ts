import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { InvalidTimestampError } from '../../src/domain/item.ts';
import { recordLlmCall, getDailyLlmUsage, type LlmCallObservation } from '../../src/db/llmCallLog.ts';

const open: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

// Every test pins its zone explicitly; nothing here reads process.env.TZ or
// the host clock's zone. That is the property under test as much as it is the
// test's own hygiene -- CLAUDE.md: "TZ set explicitly in config and every
// schedule derived from it -- never read the system timezone". Same three-zone
// discipline as tests/db/repoSnapshots.test.ts, with UTC added so a
// UTC-only implementation cannot pass by accident.
const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';
const UTC = 'UTC';

const KEY = 'c'.repeat(64);

function okCall(overrides: Partial<LlmCallObservation> = {}): LlmCallObservation {
  return {
    cacheKey: KEY,
    task: 'summary',
    backend: 'ollama',
    model: 'llama3.2',
    serviceId: 'ollama-local',
    status: 'ok',
    inputTokens: 42,
    outputTokens: 27,
    amountUsd: 0,
    costMeasured: true,
    latencyMs: 784,
    calledAt: '2026-08-15T13:00:00.000Z',
    tz: NY,
    ...overrides,
  };
}

describe('recordLlmCall', () => {
  it('records one call and rolls it up into the day it falls on in tz', () => {
    const db = migratedDb();
    recordLlmCall(db, okCall());

    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.calls).toBe(1);
    expect(usage.okCalls).toBe(1);
    expect(usage.countedTokens).toBe(69);
    expect(usage.unmeteredOkCalls).toBe(0);
    expect(usage.amountUsd).toBe(0);
    expect(usage.costMeasured).toBe(true);
    expect(usage.timezones).toEqual([NY]);
    expect(usage.mixedTimezone).toBe(false);
  });

  it('returns a distinct id per call -- two identical calls are two rows', () => {
    const db = migratedDb();
    const a = recordLlmCall(db, okCall());
    const b = recordLlmCall(db, okCall());
    expect(a.callId).not.toBe(b.callId);
    expect(getDailyLlmUsage(db, '2026-08-15').calls).toBe(2);
  });

  it('rejects a non-canonical calledAt rather than bucketing a guess', () => {
    const db = migratedDb();
    expect(() => recordLlmCall(db, okCall({ calledAt: '2026-08-15' }))).toThrow(
      InvalidTimestampError,
    );
  });
});

describe('the day boundary comes from the supplied zone, never the host', () => {
  // 02:30 UTC on the 15th: still the 14th in New York, already the 15th in
  // Tokyo and UTC. A naive implementation that only ever subtracts an offset
  // passes New York and fails Tokyo.
  const INSTANT = '2026-08-15T02:30:00.000Z';

  it.each([
    [NY, '2026-08-14'],
    [TOKYO, '2026-08-15'],
    [UTC, '2026-08-15'],
  ])('buckets %s into %s', (tz, expectedDay) => {
    const db = migratedDb();
    recordLlmCall(db, okCall({ calledAt: INSTANT, tz }));

    expect(getDailyLlmUsage(db, expectedDay).calls).toBe(1);
    const otherDay = expectedDay === '2026-08-14' ? '2026-08-15' : '2026-08-14';
    expect(getDailyLlmUsage(db, otherDay).calls).toBe(0);
  });

  it('reports a day whose rows were bucketed under more than one zone', () => {
    // WF_TZ changed mid-day: the days on either side of the change do not mean
    // the same thing, so a ceiling computed over them is measuring across a
    // seam. Same stance getSnapshotWindow takes (src/db/repoSnapshots.ts).
    const db = migratedDb();
    recordLlmCall(db, okCall({ calledAt: '2026-08-15T13:00:00.000Z', tz: NY }));
    recordLlmCall(db, okCall({ calledAt: '2026-08-15T02:30:00.000Z', tz: TOKYO }));

    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.calls).toBe(2);
    expect(usage.mixedTimezone).toBe(true);
    expect(usage.timezones).toEqual([TOKYO, NY].sort());
  });
});

describe('what counts against a ceiling, and what does not', () => {
  it('counts an ok call that reported both halves of its usage', () => {
    const db = migratedDb();
    recordLlmCall(db, okCall({ inputTokens: 100, outputTokens: 50 }));
    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.countedTokens).toBe(150);
    expect(usage.unmeteredOkCalls).toBe(0);
  });

  it('records an ok call that reported NO usage as unmetered, never as zero', () => {
    // src/enrich/llm/types.ts: "the backend did not say" is a real answer and
    // inventing a 0 for it would make an unmetered call look free to the cap.
    // The row stores nulls; the ceiling decides what to charge (see
    // src/enrich/ceiling.ts), and it is not this table's job to guess.
    const db = migratedDb();
    recordLlmCall(db, okCall({ inputTokens: null, outputTokens: null }));

    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.countedTokens).toBe(0);
    expect(usage.unmeteredOkCalls).toBe(1);
    expect(usage.okCalls).toBe(1);
  });

  it('treats a half-reported call as unmetered rather than as a partial total', () => {
    const db = migratedDb();
    recordLlmCall(db, okCall({ inputTokens: 100, outputTokens: null }));

    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.countedTokens).toBe(0);
    expect(usage.unmeteredOkCalls).toBe(1);
  });

  it('logs an unavailable call but charges no tokens for it', () => {
    // A connection-refused call produced no completion and reported no usage.
    // Charging it a worst case would let a stopped daemon close the ceiling
    // for the day, which is the opposite of what the ceiling is for.
    const db = migratedDb();
    recordLlmCall(
      db,
      okCall({
        status: 'unavailable',
        unavailableReason: 'not_running',
        inputTokens: null,
        outputTokens: null,
      }),
    );

    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.calls).toBe(1);
    expect(usage.okCalls).toBe(0);
    expect(usage.unavailableCalls).toBe(1);
    expect(usage.countedTokens).toBe(0);
    expect(usage.unmeteredOkCalls).toBe(0);
  });
});

describe('cost rolls up the way computeCost prices a single call', () => {
  it('sums measured amounts', () => {
    const db = migratedDb();
    recordLlmCall(db, okCall({ amountUsd: 0.0012, costMeasured: true }));
    recordLlmCall(db, okCall({ amountUsd: 0.0018, costMeasured: true }));

    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.amountUsd).toBeCloseTo(0.003, 10);
    expect(usage.costMeasured).toBe(true);
    expect(usage.unmeasuredCostCalls).toBe(0);
  });

  it('reports the day unmeasured when ANY call in it was unmeasured', () => {
    // Zero plus unknown is unknown. src/enrich/llm/types.ts refuses to report
    // a placeholder $0 for one call; a day containing one cannot do better.
    const db = migratedDb();
    recordLlmCall(db, okCall({ amountUsd: 0.0012, costMeasured: true }));
    recordLlmCall(db, okCall({ amountUsd: null, costMeasured: false }));

    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.costMeasured).toBe(false);
    expect(usage.unmeasuredCostCalls).toBe(1);
  });

  it('reports a measured zero for a day with no calls at all', () => {
    // Nothing ran, so nothing was spent, and that is a guarantee rather than
    // an absence of information.
    const db = migratedDb();
    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.calls).toBe(0);
    expect(usage.amountUsd).toBe(0);
    expect(usage.costMeasured).toBe(true);
  });
});

describe('schema invariants -- the ledger is append-only', () => {
  it('refuses an UPDATE', () => {
    const db = migratedDb();
    recordLlmCall(db, okCall());
    expect(() => db.exec('update llm_call_log set output_tokens = 1')).toThrow(/append-only/);
  });

  it('refuses a DELETE', () => {
    const db = migratedDb();
    recordLlmCall(db, okCall());
    expect(() => db.exec('delete from llm_call_log')).toThrow(/append-only/);
  });

  it('makes a partial token total unrepresentable', () => {
    const db = migratedDb();
    expect(() =>
      db.exec(`
        insert into llm_call_log
          (call_id, usage_day, tz, called_at, backend, model, service_id, task, cache_key,
           status, unavailable_reason, input_tokens, output_tokens, total_tokens,
           tokens_counted, amount_usd, cost_measured, latency_ms, created_at)
        values ('x', '2026-08-15', 'UTC', '2026-08-15T13:00:00.000Z', 'ollama', 'm',
                'ollama-local', 'summary', '${KEY}', 'ok', null, 100, null, 100, 1, 0, 1, 1,
                '2026-08-15T13:00:00.000Z')
      `),
    ).toThrow();
  });

  it('makes an unmeasured cost with an amount attached unrepresentable', () => {
    const db = migratedDb();
    expect(() =>
      db.exec(`
        insert into llm_call_log
          (call_id, usage_day, tz, called_at, backend, model, service_id, task, cache_key,
           status, unavailable_reason, input_tokens, output_tokens, total_tokens,
           tokens_counted, amount_usd, cost_measured, latency_ms, created_at)
        values ('x', '2026-08-15', 'UTC', '2026-08-15T13:00:00.000Z', 'ollama', 'm',
                'ollama-local', 'summary', '${KEY}', 'ok', null, 42, 27, 69, 1, 0.5, 0, 1,
                '2026-08-15T13:00:00.000Z')
      `),
    ).toThrow();
  });

  it('makes an ok call carrying an unavailable reason unrepresentable', () => {
    const db = migratedDb();
    expect(() =>
      db.exec(`
        insert into llm_call_log
          (call_id, usage_day, tz, called_at, backend, model, service_id, task, cache_key,
           status, unavailable_reason, input_tokens, output_tokens, total_tokens,
           tokens_counted, amount_usd, cost_measured, latency_ms, created_at)
        values ('x', '2026-08-15', 'UTC', '2026-08-15T13:00:00.000Z', 'ollama', 'm',
                'ollama-local', 'summary', '${KEY}', 'ok', 'timeout', 42, 27, 69, 1, 0, 1, 1,
                '2026-08-15T13:00:00.000Z')
      `),
    ).toThrow();
  });

  it('refuses a usage_day no real timezone offset could produce for called_at', () => {
    // Without this, a caller can file today's call under an arbitrary date --
    // a direct attack on the ceiling's bucket, and invisible afterwards
    // because the row looks entirely well-formed. Same bound 0007 applies to
    // snapshot_day.
    const db = migratedDb();
    expect(() =>
      db.exec(`
        insert into llm_call_log
          (call_id, usage_day, tz, called_at, backend, model, service_id, task, cache_key,
           status, unavailable_reason, input_tokens, output_tokens, total_tokens,
           tokens_counted, amount_usd, cost_measured, latency_ms, created_at)
        values ('x', '2026-01-01', 'UTC', '2026-08-15T13:00:00.000Z', 'ollama', 'm',
                'ollama-local', 'summary', '${KEY}', 'ok', null, 42, 27, 69, 1, 0, 1, 1,
                '2026-08-15T13:00:00.000Z')
      `),
    ).toThrow(/plausible/);
  });
});

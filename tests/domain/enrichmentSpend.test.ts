import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { recordLlmCall, type LlmCallObservation } from '../../src/db/llmCallLog.ts';
import { getEnrichmentSpendToday } from '../../src/domain/headerStrip.ts';

/**
 * §7's "today's enrichment spend", now fed from the M5 call ledger.
 *
 * The field's SHAPE is not under test here and must not change -- M3 shipped
 * `{ amountUsd, measured, asOf, note }` as a *measured* zero rather than a
 * placeholder, and its own report promised real numbers at M5. These tests
 * pin that the numbers became real while the four fields stayed exactly as
 * they were. tests/domain/headerStrip.test.ts still covers the no-ledger
 * behaviour, unchanged.
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
const TOKYO = 'Asia/Tokyo';
const UTC = 'UTC';
const NOW = '2026-08-15T13:00:00.000Z'; // 09:00 NY, 22:00 Tokyo -- the 15th in both

const KEY = 'c'.repeat(64);

function call(overrides: Partial<LlmCallObservation> = {}): LlmCallObservation {
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
    calledAt: NOW,
    tz: NY,
    ...overrides,
  };
}

const CLOSED_GATE = { WF_TZ: NY };
const OPEN_GATE = { WF_TZ: NY, WF_ALLOW_PAID_ANTHROPIC: '1' };

describe('the shape is unchanged', () => {
  it('still reports exactly amountUsd, measured, asOf and note', () => {
    const db = migratedDb();
    recordLlmCall(db, call());
    const status = getEnrichmentSpendToday(CLOSED_GATE, NOW, { db });
    expect(Object.keys(status).sort()).toEqual(['amountUsd', 'asOf', 'measured', 'note']);
    expect(status.asOf).toBe(NOW);
  });

  it('reports the pre-M5 answer when no ledger is supplied at all', () => {
    // The signature is additive: a caller with no database still gets the
    // structural guarantee it always got.
    const status = getEnrichmentSpendToday({}, NOW);
    expect(status.amountUsd).toBe(0);
    expect(status.measured).toBe(true);
  });
});

describe('real numbers, from the ledger', () => {
  it('reports a measured zero for a day nothing was enriched', () => {
    // Nothing ran, so nothing was spent, and that is a guarantee rather than
    // an absence of information.
    const db = migratedDb();
    const status = getEnrichmentSpendToday(CLOSED_GATE, NOW, { db });
    expect(status.amountUsd).toBe(0);
    expect(status.measured).toBe(true);
    expect(status.note).toMatch(/no enrichment calls/i);
  });

  it('reports a measured zero with real local calls behind it, and says how many', () => {
    // ollama-local is free-forever, so this $0 is priced by computeCost's
    // zero-rate branch rather than assumed. It is a different sentence from
    // the empty-day zero above, and the note has to distinguish them or the
    // header cannot tell "enrichment is running and free" from "enrichment
    // is not running at all" -- the silent-failure mode §7 cares most about.
    const db = migratedDb();
    recordLlmCall(db, call());
    recordLlmCall(db, call());

    const status = getEnrichmentSpendToday(CLOSED_GATE, NOW, { db });
    expect(status.amountUsd).toBe(0);
    expect(status.measured).toBe(true);
    expect(status.note).toMatch(/2 enrichment call/);
    expect(status.note).toMatch(/138 token/);
  });

  it('sums a billable day', () => {
    const db = migratedDb();
    recordLlmCall(
      db,
      call({ backend: 'anthropic', serviceId: 'anthropic-api', amountUsd: 0.0012 }),
    );
    recordLlmCall(
      db,
      call({ backend: 'anthropic', serviceId: 'anthropic-api', amountUsd: 0.0018 }),
    );

    const status = getEnrichmentSpendToday(OPEN_GATE, NOW, { db });
    expect(status.amountUsd).toBeCloseTo(0.003, 10);
    expect(status.measured).toBe(true);
  });

  it('reports unmeasured, not a lying zero, when any call cost is unknown', () => {
    // Zero plus unknown is unknown -- computeCost's own rule, applied to a
    // day. This is the behaviour M3 shipped as a placeholder; it now happens
    // for a real reason rather than for want of a pipeline.
    const db = migratedDb();
    recordLlmCall(db, call({ backend: 'anthropic', serviceId: 'anthropic-api', amountUsd: 0.0012 }));
    recordLlmCall(
      db,
      call({
        backend: 'anthropic',
        serviceId: 'anthropic-api',
        amountUsd: null,
        costMeasured: false,
      }),
    );

    const status = getEnrichmentSpendToday(OPEN_GATE, NOW, { db });
    expect(status.amountUsd).toBeNull();
    expect(status.measured).toBe(false);
    expect(status.note).toMatch(/1 of 2/);
  });

  it('counts an unavailable call as activity without letting it move the total', () => {
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

    const status = getEnrichmentSpendToday(CLOSED_GATE, NOW, { db });
    expect(status.amountUsd).toBe(0);
    expect(status.measured).toBe(true);
    expect(status.note).toMatch(/1 could not reach/i);
  });
});

describe('"today" is a day in WF_TZ, not a UTC day and not the host zone', () => {
  it.each([
    [NY, '2026-08-15T02:30:00.000Z', false],
    [TOKYO, '2026-08-15T02:30:00.000Z', true],
    [UTC, '2026-08-15T02:30:00.000Z', true],
  ])('for %s, a call at %s counts toward today: %s', (tz, calledAt, counts) => {
    // One instant, three zones, two answers: 02:30 UTC on the 15th is still
    // the 14th in New York. A UTC-only implementation cannot produce both.
    const db = migratedDb();
    recordLlmCall(db, call({ calledAt, tz, backend: 'anthropic', amountUsd: 0.005 }));

    const status = getEnrichmentSpendToday({ WF_TZ: tz, WF_ALLOW_PAID_ANTHROPIC: '1' }, NOW, {
      db,
    });
    expect(status.amountUsd).toBe(counts ? 0.005 : 0);
  });

  it('says so when the day spans a WF_TZ change', () => {
    const db = migratedDb();
    recordLlmCall(db, call({ calledAt: NOW, tz: NY }));
    recordLlmCall(db, call({ calledAt: '2026-08-15T02:30:00.000Z', tz: TOKYO }));

    expect(getEnrichmentSpendToday(CLOSED_GATE, NOW, { db }).note).toMatch(/timezone/i);
  });

  it('falls back to the structural answer, naming WF_TZ, when the zone is unusable', () => {
    // A ledger with no zone to scope it by cannot answer "today". Reporting
    // the whole table, or silently using UTC, would both be a wrong number
    // presented as a right one.
    const db = migratedDb();
    recordLlmCall(db, call());

    for (const env of [{}, { WF_TZ: 'Mars/Olympus_Mons' }]) {
      const status = getEnrichmentSpendToday(env, NOW, { db });
      expect(status.amountUsd).toBe(0);
      expect(status.measured).toBe(true);
      expect(status.note).toMatch(/WF_TZ/);
    }
  });
});

describe('the gate is still reported, and a contradiction with it is loud', () => {
  it('names the closed gate in its note', () => {
    const db = migratedDb();
    expect(getEnrichmentSpendToday(CLOSED_GATE, NOW, { db }).note).toMatch(
      /WF_ALLOW_PAID_ANTHROPIC/,
    );
  });

  it('flags an unmeasured call recorded while the paid gate was shut', () => {
    // src/cost/gate.ts makes a billable call impossible with the flag unset,
    // so an unmeasured cost under a closed gate is a contradiction, not a
    // datum. Reported rather than smoothed over -- exactly the "stop and ask
    // when something conflicts with what is known to be true" stance.
    const db = migratedDb();
    recordLlmCall(db, call({ amountUsd: null, costMeasured: false }));

    const status = getEnrichmentSpendToday(CLOSED_GATE, NOW, { db });
    expect(status.measured).toBe(false);
    expect(status.note).toMatch(/should not be possible/i);
  });
});

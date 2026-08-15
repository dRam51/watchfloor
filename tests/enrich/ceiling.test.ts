import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { InvalidTimestampError } from '../../src/domain/item.ts';
import { recordLlmCall, type LlmCallObservation } from '../../src/db/llmCallLog.ts';
import {
  DEFAULT_ENRICHMENT_CONFIG_PATH,
  EnrichmentPolicyError,
  checkTokenCeiling,
  loadEnrichmentPolicy,
  parseEnrichmentPolicy,
  type EnrichmentPolicy,
} from '../../src/enrich/ceiling.ts';

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

// Three zones, pinned explicitly. Nothing here reads process.env.TZ or the
// host clock's zone -- CLAUDE.md: "TZ set explicitly in config and every
// schedule derived from it". A daily ceiling's day boundary IS such a
// derived schedule quantity, and it is the thing most likely to be wrong.
const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';
const UTC = 'UTC';

const KEY = 'c'.repeat(64);

const POLICY: EnrichmentPolicy = {
  ceiling: { dailyTokens: 1000, unmeteredCallTokens: 500 },
  cache: { version: 1 },
};

function call(overrides: Partial<LlmCallObservation> = {}): LlmCallObservation {
  return {
    cacheKey: KEY,
    task: 'summary',
    backend: 'ollama',
    model: 'llama3.2',
    serviceId: 'ollama-local',
    status: 'ok',
    inputTokens: 100,
    outputTokens: 50,
    amountUsd: 0,
    costMeasured: true,
    latencyMs: 500,
    calledAt: '2026-08-15T13:00:00.000Z',
    tz: NY,
    ...overrides,
  };
}

const NOW = '2026-08-15T18:00:00.000Z'; // 14:00 in NY, 03:00 next day in Tokyo

describe('checkTokenCeiling: open', () => {
  it('is open with nothing consumed, and says how much is left', () => {
    const db = migratedDb();
    const status = checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY });

    expect(status.status).toBe('open');
    expect(status.day).toBe('2026-08-15');
    expect(status.ceilingTokens).toBe(1000);
    expect(status.chargedTokens).toBe(0);
    expect(status.remainingTokens).toBe(1000);
  });

  it('subtracts counted tokens from what remains', () => {
    const db = migratedDb();
    recordLlmCall(db, call({ inputTokens: 300, outputTokens: 200 }));

    const status = checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY });
    expect(status.status).toBe('open');
    expect(status.chargedTokens).toBe(500);
    expect(status.remainingTokens).toBe(500);
  });
});

describe('checkTokenCeiling: closed', () => {
  it('closes exactly AT the ceiling, not one call past it', () => {
    const db = migratedDb();
    recordLlmCall(db, call({ inputTokens: 600, outputTokens: 400 }));

    const status = checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY });
    expect(status.status).toBe('closed');
    expect(status.chargedTokens).toBe(1000);
    expect(status.remainingTokens).toBe(0);
  });

  it('names the ceiling as the reason, and carries the numbers behind it', () => {
    // "We stopped because of the ceiling" has to be distinguishable from
    // "there was nothing to do" -- the same distinction the LLM seam draws
    // between "the model was unavailable" and "the model had nothing to say".
    // A caller that enriched zero items reads this to tell them apart.
    const db = migratedDb();
    recordLlmCall(db, call({ inputTokens: 1000, outputTokens: 500 }));

    const status = checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY });
    expect(status.status).toBe('closed');
    if (status.status !== 'closed') throw new Error('unreachable');
    expect(status.reason).toBe('daily_token_ceiling');
    expect(status.chargedTokens).toBe(1500);
    expect(status.ceilingTokens).toBe(1000);
    expect(status.detail).toMatch(/1500/);
    expect(status.detail).toMatch(/1000/);
    expect(status.detail).toMatch(/2026-08-15/);
  });

  it('never reports a negative remainder once past the line', () => {
    const db = migratedDb();
    recordLlmCall(db, call({ inputTokens: 1000, outputTokens: 500 }));
    expect(checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY }).remainingTokens).toBe(0);
  });
});

describe('what the ceiling charges, and what it does not', () => {
  it('charges an unmetered ok call its configured worst case, never zero', () => {
    // The runaway case the ceiling exists for: a backend that reaches a model
    // and reports no token counts consumed real tokens. Crediting it 0 would
    // let it run forever. The LEDGER still stores nulls -- this substitution
    // is enforcement, not measurement, exactly as computeCost reports
    // unmeasured rather than a placeholder $0.
    const db = migratedDb();
    recordLlmCall(db, call({ inputTokens: null, outputTokens: null }));

    const status = checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY });
    expect(status.chargedTokens).toBe(500);
    expect(status.unmeteredOkCalls).toBe(1);
    expect(status.countedTokens).toBe(0);
  });

  it('closes on unmetered calls alone once enough of them have run', () => {
    const db = migratedDb();
    recordLlmCall(db, call({ inputTokens: null, outputTokens: null }));
    recordLlmCall(db, call({ inputTokens: null, outputTokens: null }));

    expect(checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY }).status).toBe('closed');
  });

  it('charges nothing for an unavailable call', () => {
    // A connection-refused call produced no completion and consumed no
    // tokens. Charging it a worst case would let a stopped daemon close the
    // ceiling for the whole day -- the ceiling would then be reporting a
    // budget problem when the real problem is that Ollama is not running.
    const db = migratedDb();
    for (let i = 0; i < 10; i += 1) {
      recordLlmCall(
        db,
        call({
          status: 'unavailable',
          unavailableReason: 'not_running',
          inputTokens: null,
          outputTokens: null,
        }),
      );
    }

    const status = checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY });
    expect(status.status).toBe('open');
    expect(status.chargedTokens).toBe(0);
  });

  it('mixes counted and unmetered calls in one total', () => {
    const db = migratedDb();
    recordLlmCall(db, call({ inputTokens: 100, outputTokens: 50 }));
    recordLlmCall(db, call({ inputTokens: null, outputTokens: null }));

    expect(checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY }).chargedTokens).toBe(650);
  });
});

describe('the day boundary is WF_TZ, and it decides whether the ceiling is shut', () => {
  it('gives opposite answers for the same instant in two zones', () => {
    // One reading, one ceiling, one `now`. 02:30 UTC on the 15th is still the
    // 14th in New York and already the 15th in Tokyo, so the SAME spend is
    // yesterday's in one zone and today's in the other. A UTC-only
    // implementation cannot produce both of these.
    const spentAt = '2026-08-15T02:30:00.000Z';
    const now = '2026-08-15T13:00:00.000Z'; // 09:00 NY, 22:00 Tokyo -- the 15th in both

    const nyDb = migratedDb();
    recordLlmCall(nyDb, call({ calledAt: spentAt, tz: NY, inputTokens: 900, outputTokens: 200 }));
    const nyStatus = checkTokenCeiling(nyDb, { now, tz: NY, policy: POLICY });
    expect(nyStatus.day).toBe('2026-08-15');
    expect(nyStatus.status).toBe('open');
    expect(nyStatus.chargedTokens).toBe(0);

    const tokyoDb = migratedDb();
    recordLlmCall(
      tokyoDb,
      call({ calledAt: spentAt, tz: TOKYO, inputTokens: 900, outputTokens: 200 }),
    );
    const tokyoStatus = checkTokenCeiling(tokyoDb, { now, tz: TOKYO, policy: POLICY });
    expect(tokyoStatus.day).toBe('2026-08-15');
    expect(tokyoStatus.status).toBe('closed');
    expect(tokyoStatus.chargedTokens).toBe(1100);
  });

  it('does not reset the ceiling in the middle of the operator evening', () => {
    // 23:30 UTC is 19:30 in New York -- the same working evening as 20:30 UTC
    // -- but a UTC bucket rolls over between them and would hand the operator
    // a fresh budget mid-session. This is 0007 section 4's argument, applied
    // to a ceiling instead of a denominator.
    const db = migratedDb();
    recordLlmCall(
      db,
      call({ calledAt: '2026-08-14T23:30:00.000Z', tz: NY, inputTokens: 900, outputTokens: 200 }),
    );

    const status = checkTokenCeiling(db, {
      now: '2026-08-15T01:00:00.000Z', // 21:00 on the 14th in NY, the 15th in UTC
      tz: NY,
      policy: POLICY,
    });
    expect(status.day).toBe('2026-08-14');
    expect(status.status).toBe('closed');
  });

  it('does not carry yesterday consumption into today', () => {
    const db = migratedDb();
    recordLlmCall(
      db,
      call({ calledAt: '2026-08-14T16:00:00.000Z', tz: UTC, inputTokens: 900, outputTokens: 200 }),
    );

    const status = checkTokenCeiling(db, {
      now: '2026-08-15T16:00:00.000Z',
      tz: UTC,
      policy: POLICY,
    });
    expect(status.day).toBe('2026-08-15');
    expect(status.status).toBe('open');
  });

  it('surfaces a day whose rows were bucketed under more than one zone', () => {
    const db = migratedDb();
    recordLlmCall(db, call({ calledAt: '2026-08-15T13:00:00.000Z', tz: NY }));
    recordLlmCall(db, call({ calledAt: '2026-08-15T02:30:00.000Z', tz: TOKYO }));

    expect(checkTokenCeiling(db, { now: NOW, tz: NY, policy: POLICY }).mixedTimezone).toBe(true);
  });

  it('rejects a non-canonical now rather than bucketing a guess', () => {
    const db = migratedDb();
    expect(() => checkTokenCeiling(db, { now: '2026-08-15', tz: NY, policy: POLICY })).toThrow(
      InvalidTimestampError,
    );
  });
});

describe('parseEnrichmentPolicy', () => {
  const VALID = `
ceiling:
  daily_tokens: 250000
  unmetered_call_tokens: 6500
cache:
  version: 1
`;

  it('parses a well-formed policy into the shape the code uses', () => {
    expect(parseEnrichmentPolicy(VALID)).toEqual({
      ceiling: { dailyTokens: 250000, unmeteredCallTokens: 6500 },
      cache: { version: 1 },
    });
  });

  it.each([
    ['a zero ceiling', 'daily_tokens: 0'],
    ['a negative ceiling', 'daily_tokens: -1'],
    ['a fractional ceiling', 'daily_tokens: 1.5'],
  ])('rejects %s', (_label, line) => {
    expect(() => parseEnrichmentPolicy(VALID.replace('daily_tokens: 250000', line))).toThrow(
      EnrichmentPolicyError,
    );
  });

  it('rejects an unmetered charge of zero -- that is the runaway case, uncharged', () => {
    expect(() =>
      parseEnrichmentPolicy(VALID.replace('unmetered_call_tokens: 6500', 'unmetered_call_tokens: 0')),
    ).toThrow(EnrichmentPolicyError);
  });

  it('rejects a negative cache version', () => {
    expect(() => parseEnrichmentPolicy(VALID.replace('version: 1', 'version: -1'))).toThrow(
      EnrichmentPolicyError,
    );
  });

  it('rejects an unknown key rather than silently ignoring it', () => {
    // A typo'd `daily_token:` would otherwise leave the real ceiling at its
    // schema default and report nothing.
    expect(() => parseEnrichmentPolicy(`${VALID}\nunknown_block:\n  x: 1\n`)).toThrow(
      EnrichmentPolicyError,
    );
  });

  it('rejects text that is not valid YAML', () => {
    expect(() => parseEnrichmentPolicy('ceiling: [unclosed')).toThrow(EnrichmentPolicyError);
  });
});

describe('the shipped config/enrichment.yaml', () => {
  it('loads and validates', () => {
    // The same standard every other config in this tree is held to: the file
    // that actually ships must satisfy its own schema, or the failure shows
    // up at first enrichment instead of here.
    const policy = loadEnrichmentPolicy(join(process.cwd(), DEFAULT_ENRICHMENT_CONFIG_PATH));
    expect(policy.ceiling.dailyTokens).toBeGreaterThan(0);
    expect(policy.ceiling.unmeteredCallTokens).toBeGreaterThan(0);
    expect(policy.cache.version).toBeGreaterThanOrEqual(0);
  });

  it('reports a missing file by path rather than throwing a bare ENOENT', () => {
    expect(() => loadEnrichmentPolicy(join(process.cwd(), 'config', 'not-a-file.yaml'))).toThrow(
      EnrichmentPolicyError,
    );
  });
});

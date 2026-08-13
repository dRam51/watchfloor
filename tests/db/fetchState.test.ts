import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { InvalidTimestampError } from '../../src/domain/item.ts';
import {
  getFetchState,
  recordSuccess,
  recordFailure,
  isEligible,
  MAX_BACKOFF_MS,
} from '../../src/db/fetchState.ts';

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

// Generic poll interval for tests that exercise recordFailure but don't care
// about the exact backoff shape -- 15m is the shortest value sources.yaml's
// schema allows (src/sources/load.ts's poll_interval regex).
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

describe('getFetchState', () => {
  it('returns null for a source that has never been fetched', () => {
    const db = migratedDb();
    expect(getFetchState(db, 'src-1')).toBeNull();
  });
});

describe('recordSuccess', () => {
  it('creates a row on first call and stores etag/lastModified/lastSuccessAt', () => {
    const db = migratedDb();
    recordSuccess(
      db,
      'src-1',
      { etag: 'W/"abc"', lastModified: 'Tue, 01 Jan 2026 00:00:00 GMT', itemCount: 5 },
      '2026-08-12T00:00:00.000Z',
    );

    expect(getFetchState(db, 'src-1')).toEqual({
      sourceId: 'src-1',
      etag: 'W/"abc"',
      lastModified: 'Tue, 01 Jan 2026 00:00:00 GMT',
      lastSuccessAt: '2026-08-12T00:00:00.000Z',
      lastFailureAt: null,
      lastError: null,
      consecutiveFailures: 0,
      nextEligibleAt: null,
      itemsYielded7d: 5,
    });
  });

  it('resets consecutiveFailures and clears nextEligibleAt, but keeps failure history', () => {
    const db = migratedDb();
    recordFailure(db, 'src-1', 'timeout', FIFTEEN_MIN_MS, '2026-08-12T00:00:00.000Z');
    recordFailure(db, 'src-1', 'timeout', FIFTEEN_MIN_MS, '2026-08-12T00:05:00.000Z');
    expect(getFetchState(db, 'src-1')?.consecutiveFailures).toBe(2);

    recordSuccess(
      db,
      'src-1',
      { etag: null, lastModified: null, itemCount: 1 },
      '2026-08-12T00:10:00.000Z',
    );

    const state = getFetchState(db, 'src-1');
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.nextEligibleAt).toBeNull();
    // lastFailureAt/lastError are history, not backoff state -- a recovered
    // source should still show its most recent failure on a health page.
    expect(state?.lastFailureAt).toBe('2026-08-12T00:05:00.000Z');
    expect(state?.lastError).toBe('timeout');
  });

  it('accumulates itemsYielded7d across successes inside the 7-day window', () => {
    const db = migratedDb();
    recordSuccess(
      db,
      'src-1',
      { etag: null, lastModified: null, itemCount: 3 },
      '2026-08-06T00:00:00.000Z',
    );
    recordSuccess(
      db,
      'src-1',
      { etag: null, lastModified: null, itemCount: 4 },
      '2026-08-07T00:00:00.000Z',
    );
    expect(getFetchState(db, 'src-1')?.itemsYielded7d).toBe(7);
  });

  it('rolls itemsYielded7d over once more than 7 days separate two successes', () => {
    const db = migratedDb();
    recordSuccess(
      db,
      'src-1',
      { etag: null, lastModified: null, itemCount: 3 },
      '2026-08-01T00:00:00.000Z',
    );
    // 8 days later -- the window should have rolled, discarding the earlier count.
    recordSuccess(
      db,
      'src-1',
      { etag: null, lastModified: null, itemCount: 4 },
      '2026-08-09T00:00:00.001Z',
    );
    expect(getFetchState(db, 'src-1')?.itemsYielded7d).toBe(4);
  });

  it('defaults now to the current wall-clock time when omitted', () => {
    const db = migratedDb();
    const before = Date.now();
    recordSuccess(db, 'src-1', { etag: null, lastModified: null, itemCount: 1 });
    const after = Date.now();

    const recordedAt = Date.parse(getFetchState(db, 'src-1')!.lastSuccessAt!);
    expect(recordedAt).toBeGreaterThanOrEqual(before);
    expect(recordedAt).toBeLessThanOrEqual(after);
  });
});

describe('recordFailure', () => {
  it('records lastError, lastFailureAt, and increments consecutiveFailures', () => {
    const db = migratedDb();
    recordFailure(db, 'src-1', 'ETIMEDOUT', FIFTEEN_MIN_MS, '2026-08-12T00:00:00.000Z');
    const state = getFetchState(db, 'src-1')!;
    expect(state.lastError).toBe('ETIMEDOUT');
    expect(state.lastFailureAt).toBe('2026-08-12T00:00:00.000Z');
    expect(state.consecutiveFailures).toBe(1);
  });

  it('preserves etag, lastModified, lastSuccessAt, and itemsYielded7d from the last success', () => {
    const db = migratedDb();
    recordSuccess(
      db,
      'src-1',
      { etag: 'e1', lastModified: 'lm1', itemCount: 2 },
      '2026-08-12T00:00:00.000Z',
    );
    recordFailure(db, 'src-1', 'boom', FIFTEEN_MIN_MS, '2026-08-12T01:00:00.000Z');

    const state = getFetchState(db, 'src-1')!;
    expect(state.etag).toBe('e1');
    expect(state.lastModified).toBe('lm1');
    expect(state.lastSuccessAt).toBe('2026-08-12T00:00:00.000Z');
    expect(state.itemsYielded7d).toBe(2);
  });

  it('doubles the backoff delay with each consecutive failure', () => {
    const db = migratedDb();
    const t0 = '2026-08-12T00:00:00.000Z';

    recordFailure(db, 'src-1', 'boom', FIFTEEN_MIN_MS, t0);
    const first = getFetchState(db, 'src-1')!;
    expect(first.consecutiveFailures).toBe(1);
    const firstDelay = Date.parse(first.nextEligibleAt!) - Date.parse(t0);
    expect(firstDelay).toBeGreaterThan(0);

    recordFailure(db, 'src-1', 'boom', FIFTEEN_MIN_MS, t0);
    const second = getFetchState(db, 'src-1')!;
    expect(second.consecutiveFailures).toBe(2);
    const secondDelay = Date.parse(second.nextEligibleAt!) - Date.parse(t0);
    expect(secondDelay).toBe(firstDelay * 2);

    recordFailure(db, 'src-1', 'boom', FIFTEEN_MIN_MS, t0);
    const third = getFetchState(db, 'src-1')!;
    const thirdDelay = Date.parse(third.nextEligibleAt!) - Date.parse(t0);
    expect(thirdDelay).toBe(secondDelay * 2);
  });

  it('caps the backoff delay at 6 hours for a source whose poll interval is under the cap', () => {
    const db = migratedDb();
    const t0 = '2026-08-12T00:00:00.000Z';
    // Seed a large consecutive-failure count directly via SQL so the cap is
    // provable without 9+ sequential recordFailure calls to reach it.
    db.prepare(
      `insert into source_fetch_state (source_id, consecutive_failures, updated_at)
       values ('src-1', 20, ?)`,
    ).run(t0);

    recordFailure(db, 'src-1', 'still down', FIFTEEN_MIN_MS, t0);
    const state = getFetchState(db, 'src-1')!;
    expect(state.consecutiveFailures).toBe(21);
    expect(Date.parse(state.nextEligibleAt!) - Date.parse(t0)).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe('recordFailure backoff never beats the configured poll interval', () => {
  // Fix round 1 (task-1-report.md): a flat `min(x, MAX_BACKOFF_MS)` ceiling
  // let a source whose own poll_interval exceeds 6h have its backoff capped
  // BELOW its healthy cadence -- a failing instance of a once-a-day source
  // was reachable every 6h, four times more often than a healthy instance of
  // the same source. The invariant this proves: a source in backoff is never
  // eligible sooner than its own pollIntervalMs, at any failure count.
  //
  // Covers a spread either side of MAX_BACKOFF_MS (6h): shorter (15m, 1h),
  // exactly at it (6h), and longer than it (1d) -- the 1d case is exactly
  // the one a flat cap got wrong.
  const POLL_INTERVALS_MS: Record<string, number> = {
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };

  for (const [label, pollIntervalMs] of Object.entries(POLL_INTERVALS_MS)) {
    it(`poll_interval=${label}: nextEligibleAt never arrives sooner than pollIntervalMs, from the first failure through past where the ceiling binds`, () => {
      const db = migratedDb();
      const t0 = '2026-08-12T00:00:00.000Z';
      const ceilingMs = Math.max(MAX_BACKOFF_MS, pollIntervalMs);

      // 10 consecutive failures comfortably passes the point the ceiling
      // binds for every interval above (15m binds at failure 5; 1h at 3;
      // 6h and 1d bind immediately at failure 1), so this exercises both
      // the pre-cap doubling region and the steady-state capped region.
      for (let n = 1; n <= 10; n++) {
        recordFailure(db, 'src-1', 'boom', pollIntervalMs, t0);
        const state = getFetchState(db, 'src-1')!;
        expect(state.consecutiveFailures).toBe(n);

        const delayMs = Date.parse(state.nextEligibleAt!) - Date.parse(t0);
        expect(
          delayMs,
          `poll_interval=${label} (${pollIntervalMs}ms) at consecutiveFailures=${n}: ` +
            `delay was ${delayMs}ms, sooner than the source's own poll interval`,
        ).toBeGreaterThanOrEqual(pollIntervalMs);
        expect(delayMs).toBeLessThanOrEqual(ceilingMs);
      }
    });
  }
});

describe('isEligible', () => {
  it('returns true for a source that has never been fetched', () => {
    const db = migratedDb();
    expect(isEligible(db, 'src-1', '2026-08-12T00:00:00.000Z')).toBe(true);
  });

  it('returns true for a source with no backoff in effect', () => {
    const db = migratedDb();
    recordSuccess(
      db,
      'src-1',
      { etag: null, lastModified: null, itemCount: 1 },
      '2026-08-12T00:00:00.000Z',
    );
    expect(isEligible(db, 'src-1', '2026-08-12T00:00:01.000Z')).toBe(true);
  });

  it('returns false inside the backoff window', () => {
    const db = migratedDb();
    const t0 = '2026-08-12T00:00:00.000Z';
    recordFailure(db, 'src-1', 'boom', FIFTEEN_MIN_MS, t0);
    const state = getFetchState(db, 'src-1')!;

    const justBefore = new Date(Date.parse(state.nextEligibleAt!) - 1).toISOString();
    expect(isEligible(db, 'src-1', justBefore)).toBe(false);
  });

  it('returns true once now reaches nextEligibleAt (inclusive boundary)', () => {
    const db = migratedDb();
    const t0 = '2026-08-12T00:00:00.000Z';
    recordFailure(db, 'src-1', 'boom', FIFTEEN_MIN_MS, t0);
    const state = getFetchState(db, 'src-1')!;
    expect(isEligible(db, 'src-1', state.nextEligibleAt!)).toBe(true);
  });

  it('returns true again immediately after a success resets backoff mid-window', () => {
    const db = migratedDb();
    const t0 = '2026-08-12T00:00:00.000Z';
    recordFailure(db, 'src-1', 'boom', FIFTEEN_MIN_MS, t0);
    expect(isEligible(db, 'src-1', t0)).toBe(false);

    recordSuccess(db, 'src-1', { etag: null, lastModified: null, itemCount: 1 }, t0);
    expect(isEligible(db, 'src-1', t0)).toBe(true);
  });
});

describe('independent sources', () => {
  it('tracks each source_id independently', () => {
    const db = migratedDb();
    recordFailure(db, 'src-1', 'boom', FIFTEEN_MIN_MS, '2026-08-12T00:00:00.000Z');
    recordSuccess(
      db,
      'src-2',
      { etag: null, lastModified: null, itemCount: 9 },
      '2026-08-12T00:00:00.000Z',
    );

    expect(getFetchState(db, 'src-1')?.consecutiveFailures).toBe(1);
    expect(getFetchState(db, 'src-2')?.consecutiveFailures).toBe(0);
    expect(getFetchState(db, 'src-2')?.itemsYielded7d).toBe(9);
  });
});

describe('timestamp validation', () => {
  it('rejects a non-canonical now passed to isEligible', () => {
    const db = migratedDb();
    expect(() => isEligible(db, 'src-1', '2026-08-12T00:00:00Z')).toThrow(InvalidTimestampError);
  });

  it('rejects a non-canonical now passed to recordFailure', () => {
    const db = migratedDb();
    expect(() =>
      recordFailure(db, 'src-1', 'boom', FIFTEEN_MIN_MS, '2026-08-12 00:00:00'),
    ).toThrow(InvalidTimestampError);
  });

  it('rejects a non-canonical now passed to recordSuccess', () => {
    const db = migratedDb();
    expect(() =>
      recordSuccess(
        db,
        'src-1',
        { etag: null, lastModified: null, itemCount: 1 },
        'not-a-timestamp',
      ),
    ).toThrow(InvalidTimestampError);
  });
});

describe('0003_fetch_state mutability', () => {
  it('allows UPDATE and DELETE on source_fetch_state -- operational state, not history', () => {
    const db = migratedDb();
    recordSuccess(
      db,
      'src-1',
      { etag: 'e1', lastModified: null, itemCount: 1 },
      '2026-08-12T00:00:00.000Z',
    );

    expect(() =>
      db.prepare("update source_fetch_state set etag = 'e2' where source_id = 'src-1'").run(),
    ).not.toThrow();
    expect(getFetchState(db, 'src-1')?.etag).toBe('e2');

    expect(() =>
      db.prepare("delete from source_fetch_state where source_id = 'src-1'").run(),
    ).not.toThrow();
    expect(getFetchState(db, 'src-1')).toBeNull();
  });
});

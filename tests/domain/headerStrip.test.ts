import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadSources, type Source } from '../../src/sources/load.ts';
import { recordSuccess, recordFailure } from '../../src/db/fetchState.ts';
import { BEATS } from '../../src/domain/item.ts';
import {
  getBeatRefreshStatus,
  getFailingSourceCount,
  getEnrichmentSpendToday,
} from '../../src/domain/headerStrip.ts';

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

function sources(yaml: string): Source[] {
  return loadSources(`sources:\n${yaml}`);
}

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15m

describe('getBeatRefreshStatus', () => {
  it('reports the OLDEST last_success_at among a beat\'s sources, not the newest -- a beat is only as fresh as its stalest contributor', () => {
    const db = migratedDb();
    const src = sources(`
  - { id: fast, name: Fast, type: rss, url: 'https://fast.test/f', beats: [cyber], weight: 1, poll_interval: 15m, enabled: true }
  - { id: slow, name: Slow, type: rss, url: 'https://slow.test/f', beats: [cyber], weight: 1, poll_interval: 15m, enabled: true }
`);
    recordSuccess(db, 'fast', { etag: null, lastModified: null, itemCount: 3 }, '2026-08-14T11:00:00.000Z');
    recordSuccess(db, 'slow', { etag: null, lastModified: null, itemCount: 1 }, '2026-08-14T08:00:00.000Z');

    const status = getBeatRefreshStatus(db, src);
    const cyber = status.find((s) => s.beat === 'cyber');
    expect(cyber).toEqual({ beat: 'cyber', lastRefreshAt: '2026-08-14T08:00:00.000Z', sourceCount: 2 });
  });

  it('is null when any contributing enabled source has never succeeded -- "everything in this beat is at least this fresh" cannot be claimed otherwise', () => {
    const db = migratedDb();
    const src = sources(`
  - { id: ok, name: Ok, type: rss, url: 'https://ok.test/f', beats: [ai], weight: 1, poll_interval: 15m, enabled: true }
  - { id: never, name: Never, type: rss, url: 'https://never.test/f', beats: [ai], weight: 1, poll_interval: 15m, enabled: true }
`);
    recordSuccess(db, 'ok', { etag: null, lastModified: null, itemCount: 2 }, '2026-08-14T11:00:00.000Z');
    recordFailure(db, 'never', 'timeout', POLL_INTERVAL_MS, '2026-08-14T11:00:00.000Z');

    const status = getBeatRefreshStatus(db, src);
    expect(status.find((s) => s.beat === 'ai')).toEqual({ beat: 'ai', lastRefreshAt: null, sourceCount: 2 });
  });

  it('excludes disabled sources from both the aggregate and the source count', () => {
    const db = migratedDb();
    const src = sources(`
  - { id: live, name: Live, type: rss, url: 'https://live.test/f', beats: [aisec], weight: 1, poll_interval: 15m, enabled: true }
  - { id: off, name: Off, type: rss, url: 'https://off.test/f', beats: [aisec], weight: 1, poll_interval: 15m, enabled: false }
`);
    recordSuccess(db, 'live', { etag: null, lastModified: null, itemCount: 5 }, '2026-08-14T10:00:00.000Z');
    // The disabled source has an ancient success on record; if it leaked into
    // the aggregate it would drag lastRefreshAt back to this date.
    recordSuccess(db, 'off', { etag: null, lastModified: null, itemCount: 1 }, '2020-01-01T00:00:00.000Z');

    const status = getBeatRefreshStatus(db, src);
    expect(status.find((s) => s.beat === 'aisec')).toEqual({
      beat: 'aisec',
      lastRefreshAt: '2026-08-14T10:00:00.000Z',
      sourceCount: 1,
    });
  });

  it('reports sourceCount 0 and lastRefreshAt null for a beat with no configured sources (repos/markets pre-M4)', () => {
    const db = migratedDb();
    const src = sources(`
  - { id: only, name: Only, type: rss, url: 'https://only.test/f', beats: [ai], weight: 1, poll_interval: 15m, enabled: true }
`);
    recordSuccess(db, 'only', { etag: null, lastModified: null, itemCount: 1 }, '2026-08-14T10:00:00.000Z');

    const status = getBeatRefreshStatus(db, src);
    expect(status.find((s) => s.beat === 'repos')).toEqual({ beat: 'repos', lastRefreshAt: null, sourceCount: 0 });
    expect(status.find((s) => s.beat === 'markets')).toEqual({ beat: 'markets', lastRefreshAt: null, sourceCount: 0 });
  });

  it('covers all six beats, in BEATS canonical order, regardless of what sources are configured', () => {
    const db = migratedDb();
    const status = getBeatRefreshStatus(db, []);
    expect(status.map((s) => s.beat)).toEqual([...BEATS]);
  });

  it('a source carrying more than one beat contributes to each', () => {
    const db = migratedDb();
    const src = sources(`
  - { id: cross, name: Cross, type: rss, url: 'https://cross.test/f', beats: [cyber, aisec], weight: 1, poll_interval: 15m, enabled: true }
`);
    recordSuccess(db, 'cross', { etag: null, lastModified: null, itemCount: 1 }, '2026-08-14T09:00:00.000Z');

    const status = getBeatRefreshStatus(db, src);
    expect(status.find((s) => s.beat === 'cyber')?.sourceCount).toBe(1);
    expect(status.find((s) => s.beat === 'aisec')?.sourceCount).toBe(1);
  });
});

describe('getFailingSourceCount (minimal definition -- see module doc comment)', () => {
  it('counts an enabled source currently in a failure streak', () => {
    const db = migratedDb();
    const src = sources(`
  - { id: healthy, name: Healthy, type: rss, url: 'https://healthy.test/f', beats: [ai], weight: 1, poll_interval: 15m, enabled: true }
  - { id: failing, name: Failing, type: rss, url: 'https://failing.test/f', beats: [ai], weight: 1, poll_interval: 15m, enabled: true }
`);
    recordSuccess(db, 'healthy', { etag: null, lastModified: null, itemCount: 1 }, '2026-08-14T10:00:00.000Z');
    recordFailure(db, 'failing', 'HTTP 503', POLL_INTERVAL_MS, '2026-08-14T10:00:00.000Z');

    expect(getFailingSourceCount(db, src)).toBe(1);
  });

  it('does not count a disabled source even if its last recorded attempt failed', () => {
    const db = migratedDb();
    const src = sources(`
  - { id: off, name: Off, type: rss, url: 'https://off.test/f', beats: [ai], weight: 1, poll_interval: 15m, enabled: false }
`);
    recordFailure(db, 'off', 'HTTP 500', POLL_INTERVAL_MS, '2026-08-14T10:00:00.000Z');

    expect(getFailingSourceCount(db, src)).toBe(0);
  });

  it('does not count an enabled source that has simply never been attempted yet', () => {
    const db = migratedDb();
    const src = sources(`
  - { id: fresh, name: Fresh, type: rss, url: 'https://fresh.test/f', beats: [ai], weight: 1, poll_interval: 15m, enabled: true }
`);
    expect(getFailingSourceCount(db, src)).toBe(0);
  });

  it('a source that recovers (recordSuccess after failures) is no longer counted', () => {
    const db = migratedDb();
    const src = sources(`
  - { id: recovered, name: Recovered, type: rss, url: 'https://recovered.test/f', beats: [ai], weight: 1, poll_interval: 15m, enabled: true }
`);
    recordFailure(db, 'recovered', 'timeout', POLL_INTERVAL_MS, '2026-08-14T09:00:00.000Z');
    recordFailure(db, 'recovered', 'timeout', POLL_INTERVAL_MS, '2026-08-14T09:05:00.000Z');
    recordSuccess(db, 'recovered', { etag: null, lastModified: null, itemCount: 2 }, '2026-08-14T09:10:00.000Z');

    expect(getFailingSourceCount(db, src)).toBe(0);
  });
});

describe('getEnrichmentSpendToday', () => {
  const NOW = '2026-08-14T12:00:00.000Z';

  it('is a real, structural zero when the anthropic cost gate is closed (the default)', () => {
    const status = getEnrichmentSpendToday({}, NOW);
    expect(status.amountUsd).toBe(0);
    expect(status.measured).toBe(true);
    expect(status.asOf).toBe(NOW);
  });

  it('reports unmeasured (not a lying zero) once the gate is open, since no metering pipeline exists yet', () => {
    const status = getEnrichmentSpendToday({ WF_ALLOW_PAID_ANTHROPIC: '1' }, NOW);
    expect(status.amountUsd).toBeNull();
    expect(status.measured).toBe(false);
  });
});

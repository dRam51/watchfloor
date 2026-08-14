import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { InvalidTimestampError } from '../../src/domain/item.ts';
import {
  localDay,
  recordStarSnapshot,
  getStarSnapshots,
  resolveRepoId,
  getRepoNames,
  getSnapshotWindow,
} from '../../src/db/repoSnapshots.ts';

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

// Every test in this file pins its zone explicitly. Nothing here reads
// process.env.TZ or the host clock's zone -- that is the property under test
// as much as it is the test's own hygiene (CLAUDE.md: "TZ set explicitly in
// config and every schedule derived from it -- never read the system
// timezone"). The .env.example default is America/New_York; the tests use it
// plus zones on the other side of UTC so a UTC-only implementation fails.
const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

describe('localDay', () => {
  it('buckets an instant by the calendar date in the given zone, not UTC', () => {
    // 02:30 UTC on the 14th is 22:30 on the 13th in New York.
    expect(localDay('2026-08-14T02:30:00.000Z', NY)).toBe('2026-08-13');
  });

  it('rolls forward, not back, for a zone east of UTC', () => {
    // Same instant, opposite direction: 11:30 on the 14th in Tokyo. A naive
    // "subtract the offset" implementation that only ever moves the date
    // backwards passes the New York case and fails this one.
    expect(localDay('2026-08-14T02:30:00.000Z', TOKYO)).toBe('2026-08-14');
  });

  it('rejects a non-canonical instant rather than bucketing a guess', () => {
    // Date.parse would happily accept '2026-08-14' or '2026-08-14T02:30Z'
    // and silently produce a plausible day. Every other timestamp writer in
    // this project rejects rather than coerces (src/domain/item.ts); a
    // snapshot day derived from a coerced instant would land in the wrong
    // bucket with nothing to show for it.
    expect(() => localDay('2026-08-14', NY)).toThrow(InvalidTimestampError);
  });
});

// A repo the tests reuse. `repoId` is GitHub's immutable numeric id -- the
// identity every snapshot row keys on; `itemKey` is what the rest of the
// system keys on (sha256 of the canonical URL), carried alongside so a
// consumer holding only an item_key can still reach this history.
const AGENTKIT = {
  repoId: 900001,
  itemKey: 'a'.repeat(64),
  fullName: 'acme/agentkit',
};

describe('recordStarSnapshot', () => {
  it('stores one snapshot, readable back by repo id', () => {
    const db = migratedDb();
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 40,
      observedAt: '2026-08-08T13:00:00.000Z',
      tz: NY,
    });

    expect(getStarSnapshots(db, AGENTKIT.repoId)).toEqual([
      {
        repoId: AGENTKIT.repoId,
        snapshotDay: '2026-08-08',
        stars: 40,
        observedAt: '2026-08-08T13:00:00.000Z',
        tz: NY,
      },
    ]);
  });
});

describe('recordStarSnapshot, polled more than once in a day', () => {
  it('replaces the day rather than adding a second row, and says so', () => {
    // The invariant the whole migration exists for: a day polled twice must
    // not become two rows, or every consumer that counts rows to get its
    // per-day denominator is silently ~12% low over a 7-day window.
    const db = migratedDb();
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 40,
      observedAt: '2026-08-08T13:00:00.000Z',
      tz: NY,
    });
    const second = recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 47,
      observedAt: '2026-08-08T19:00:00.000Z',
      tz: NY,
    });

    expect(second.action).toBe('updated');
    expect(getStarSnapshots(db, AGENTKIT.repoId)).toEqual([
      {
        repoId: AGENTKIT.repoId,
        snapshotDay: '2026-08-08',
        stars: 47,
        observedAt: '2026-08-08T19:00:00.000Z',
        tz: NY,
      },
    ]);
  });

  it('ignores a reading that arrives out of order instead of clobbering a fresher one', () => {
    // The retry that lands after the poll it was retrying already succeeded.
    // The later reading is closer to the end of the day the row represents,
    // so it wins -- and the caller is told the write was a no-op rather than
    // being left to assume it landed.
    const db = migratedDb();
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 47,
      observedAt: '2026-08-08T19:00:00.000Z',
      tz: NY,
    });
    const stale = recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 40,
      observedAt: '2026-08-08T13:00:00.000Z',
      tz: NY,
    });

    expect(stale.action).toBe('ignored');
    expect(getStarSnapshots(db, AGENTKIT.repoId)[0]?.stars).toBe(47);
  });

  it('keeps one local day as one row even when it straddles UTC midnight', () => {
    // 20:00 and 21:00 on one New York evening are 00:00 and 01:00 the NEXT
    // day in UTC. Bucketing by UTC would file them as two days and halve the
    // apparent velocity; bucketing by WF_TZ files them as the one day they
    // actually were.
    const db = migratedDb();
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 40,
      observedAt: '2026-08-09T00:00:00.000Z',
      tz: NY,
    });
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 42,
      observedAt: '2026-08-09T01:00:00.000Z',
      tz: NY,
    });

    const snapshots = getStarSnapshots(db, AGENTKIT.repoId);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.snapshotDay).toBe('2026-08-08');
  });
});

// The same repo after a rename: GitHub keeps the numeric id and redirects the
// old path, so the canonical URL -- and therefore item_key -- changes while
// the repo does not.
const AGENTKIT_RENAMED = {
  repoId: AGENTKIT.repoId,
  itemKey: 'b'.repeat(64),
  fullName: 'acme/agent-kit',
};

describe('repo identity across a rename', () => {
  it('keeps one continuous velocity history rather than restarting it', () => {
    const db = migratedDb();
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 40,
      observedAt: '2026-08-08T13:00:00.000Z',
      tz: NY,
    });
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 90,
      observedAt: '2026-08-09T13:00:00.000Z',
      tz: NY,
    });
    // Renamed between polls. Nothing about the repo changed but its path.
    recordStarSnapshot(db, {
      ...AGENTKIT_RENAMED,
      stars: 220,
      observedAt: '2026-08-10T13:00:00.000Z',
      tz: NY,
    });

    expect(getStarSnapshots(db, AGENTKIT.repoId).map((s) => [s.snapshotDay, s.stars])).toEqual([
      ['2026-08-08', 40],
      ['2026-08-09', 90],
      ['2026-08-10', 220],
    ]);
  });

  it('resolves either name to the one repo, so two names cannot accumulate two histories', () => {
    const db = migratedDb();
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 40,
      observedAt: '2026-08-08T13:00:00.000Z',
      tz: NY,
    });
    recordStarSnapshot(db, {
      ...AGENTKIT_RENAMED,
      stars: 220,
      observedAt: '2026-08-10T13:00:00.000Z',
      tz: NY,
    });

    expect(resolveRepoId(db, AGENTKIT.itemKey)).toBe(AGENTKIT.repoId);
    expect(resolveRepoId(db, AGENTKIT_RENAMED.itemKey)).toBe(AGENTKIT.repoId);
    // Both names on record, neither overwritten -- a rename is a queryable
    // fact, not an invisible discontinuity.
    expect(getRepoNames(db, AGENTKIT.repoId).map((n) => n.fullName).sort()).toEqual([
      'acme/agent-kit',
      'acme/agentkit',
    ]);
  });

  it('returns null for an item_key that belongs to no known repo', () => {
    expect(resolveRepoId(migratedDb(), 'c'.repeat(64))).toBeNull();
  });

  it('resolves a reused path to the repo that most recently held it', () => {
    // GitHub frees a deleted repo's path for reuse, so one item_key can point
    // at two different numeric ids over time. The newer holder wins; the
    // older pairing stays on disk rather than being rewritten.
    const db = migratedDb();
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 40,
      observedAt: '2026-08-08T13:00:00.000Z',
      tz: NY,
    });
    recordStarSnapshot(db, {
      repoId: 900002,
      itemKey: AGENTKIT.itemKey,
      fullName: AGENTKIT.fullName,
      stars: 3,
      observedAt: '2026-08-10T13:00:00.000Z',
      tz: NY,
    });

    expect(resolveRepoId(db, AGENTKIT.itemKey)).toBe(900002);
    // And the two repos' star histories stayed separate, not merged.
    expect(getStarSnapshots(db, AGENTKIT.repoId).map((s) => s.stars)).toEqual([40]);
    expect(getStarSnapshots(db, 900002).map((s) => s.stars)).toEqual([3]);
  });
});

/** Records one reading per listed day at 13:00 New York time (17:00Z in August). */
function recordDays(
  db: ReturnType<typeof migratedDb>,
  days: Array<[day: string, stars: number]>,
  repo = AGENTKIT,
  tz = NY,
) {
  for (const [day, stars] of days) {
    recordStarSnapshot(db, { ...repo, stars, observedAt: `${day}T17:00:00.000Z`, tz });
  }
}

describe('getSnapshotWindow', () => {
  it('reports a complete trailing window with no gaps', () => {
    const db = migratedDb();
    recordDays(db, [
      ['2026-08-08', 40],
      ['2026-08-09', 55],
      ['2026-08-10', 90],
      ['2026-08-11', 130],
      ['2026-08-12', 200],
      ['2026-08-13', 300],
      ['2026-08-14', 400],
    ]);

    const window = getSnapshotWindow(db, AGENTKIT.repoId, {
      throughDay: '2026-08-14',
      days: 7,
    });

    expect(window.fromDay).toBe('2026-08-08');
    expect(window.throughDay).toBe('2026-08-14');
    expect(window.expectedDays).toBe(7);
    expect(window.observedDays).toBe(7);
    expect(window.missingDays).toEqual([]);
    expect(window.snapshots.map((s) => s.stars)).toEqual([40, 55, 90, 130, 200, 300, 400]);
  });

  it('names the days the scheduler missed rather than leaving a consumer to infer them', () => {
    // The case that will actually occur: the scheduler was down on the 10th
    // and 11th. Nothing is stored for those days -- absence IS the signal --
    // and the window says which days are absent so a consumer can tell "flat"
    // from "we were not looking".
    const db = migratedDb();
    recordDays(db, [
      ['2026-08-08', 40],
      ['2026-08-09', 55],
      ['2026-08-12', 200],
      ['2026-08-13', 300],
      ['2026-08-14', 400],
    ]);

    const window = getSnapshotWindow(db, AGENTKIT.repoId, {
      throughDay: '2026-08-14',
      days: 7,
    });

    expect(window.expectedDays).toBe(7);
    expect(window.observedDays).toBe(5);
    expect(window.missingDays).toEqual(['2026-08-10', '2026-08-11']);
    // No gap-filled zero and no interpolated value: only what was observed.
    expect(window.snapshots.map((s) => s.snapshotDay)).toEqual([
      '2026-08-08',
      '2026-08-09',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
    ]);
  });

  it('reports a whole window of missing days on a database with no history', () => {
    // Day one of the lane. The M4a plan calls insufficient history a
    // first-class state; this is what it looks like at the storage layer --
    // seven named missing days, not seven zeros.
    const window = getSnapshotWindow(migratedDb(), AGENTKIT.repoId, {
      throughDay: '2026-08-14',
      days: 7,
    });

    expect(window.observedDays).toBe(0);
    expect(window.snapshots).toEqual([]);
    expect(window.missingDays).toHaveLength(7);
    expect(window.missingDays[0]).toBe('2026-08-08');
    expect(window.missingDays.at(-1)).toBe('2026-08-14');
  });

  it('excludes days outside the window rather than widening it', () => {
    const db = migratedDb();
    recordDays(db, [
      ['2026-08-06', 10],
      ['2026-08-07', 20],
      ['2026-08-08', 40],
    ]);

    const window = getSnapshotWindow(db, AGENTKIT.repoId, {
      throughDay: '2026-08-08',
      days: 2,
    });

    expect(window.fromDay).toBe('2026-08-07');
    expect(window.snapshots.map((s) => s.stars)).toEqual([20, 40]);
  });

  it('crosses a month boundary correctly', () => {
    const db = migratedDb();
    recordDays(db, [
      ['2026-07-30', 10],
      ['2026-07-31', 20],
      ['2026-08-01', 40],
    ]);

    const window = getSnapshotWindow(db, AGENTKIT.repoId, {
      throughDay: '2026-08-01',
      days: 3,
    });

    expect(window.fromDay).toBe('2026-07-30');
    expect(window.missingDays).toEqual([]);
    expect(window.observedDays).toBe(3);
  });

  it('flags a window whose days were bucketed under different zones', () => {
    // Changing WF_TZ moves the day boundary, so days recorded either side of
    // the change are not the same unit. Averaging across that seam silently
    // produces a rate over days of two different lengths; the flag makes the
    // seam visible instead.
    const db = migratedDb();
    recordDays(db, [['2026-08-08', 40]]);
    // 03:00Z is 12:00 on 2026-08-09 in Tokyo -- the same calendar day the
    // New York rows use, reached through a different zone.
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 90,
      observedAt: '2026-08-09T03:00:00.000Z',
      tz: TOKYO,
    });

    const window = getSnapshotWindow(db, AGENTKIT.repoId, {
      throughDay: '2026-08-09',
      days: 2,
    });

    expect(window.mixedTimezone).toBe(true);
  });

  it('does not flag a window recorded entirely under one zone', () => {
    const db = migratedDb();
    recordDays(db, [
      ['2026-08-08', 40],
      ['2026-08-09', 90],
    ]);

    expect(
      getSnapshotWindow(db, AGENTKIT.repoId, { throughDay: '2026-08-09', days: 2 }).mixedTimezone,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The guarantees below are enforced by the SCHEMA, not by this module, and
// that distinction is the point: a repair script, the sqlite3 CLI, or a
// future writer that never imports repoSnapshots.ts must hit the same wall.
// Every test here therefore writes raw SQL, deliberately bypassing the access
// layer. See db/migrations/0007_repo_star_snapshots.sql.
// ---------------------------------------------------------------------------

const RAW_SNAPSHOT_COLUMNS =
  'insert into github_repo_star_snapshots (repo_id, snapshot_day, stars, observed_at, tz, created_at) values (?, ?, ?, ?, ?, ?)';

describe('schema enforcement, bypassing the access layer', () => {
  it('refuses a second row for a day already recorded', () => {
    const db = migratedDb();
    db.prepare(RAW_SNAPSHOT_COLUMNS).run(
      AGENTKIT.repoId,
      '2026-08-08',
      40,
      '2026-08-08T13:00:00.000Z',
      NY,
      '2026-08-08T13:00:00.000Z',
    );

    expect(() =>
      db.prepare(RAW_SNAPSHOT_COLUMNS).run(
        AGENTKIT.repoId,
        '2026-08-08',
        47,
        '2026-08-08T19:00:00.000Z',
        NY,
        '2026-08-08T19:00:00.000Z',
      ),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it('refuses to delete a snapshot', () => {
    const db = migratedDb();
    recordDays(db, [['2026-08-08', 40]]);
    expect(() => db.exec('delete from github_repo_star_snapshots')).toThrow(/never deleted/i);
  });

  it('refuses to restate which day or repo a row belongs to', () => {
    const db = migratedDb();
    recordDays(db, [['2026-08-08', 40]]);
    // observed_at is advanced too, so the monotonicity guard cannot be what
    // catches this -- only the identity guard can.
    expect(() =>
      db.exec(
        "update github_repo_star_snapshots set snapshot_day = '2026-08-09', observed_at = '2026-08-09T17:00:00.000Z'",
      ),
    ).toThrow(/immutable/i);
  });

  it('refuses to move a reading backwards in time', () => {
    const db = migratedDb();
    recordDays(db, [['2026-08-08', 40]]);
    expect(() =>
      db.exec(
        "update github_repo_star_snapshots set observed_at = '2026-08-08T01:00:00.000Z', stars = 1",
      ),
    ).toThrow(/may only move forward/i);
  });

  it('refuses a negative star count', () => {
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_SNAPSHOT_COLUMNS).run(
        AGENTKIT.repoId,
        '2026-08-08',
        -1,
        '2026-08-08T13:00:00.000Z',
        NY,
        '2026-08-08T13:00:00.000Z',
      ),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('refuses a non-canonical observed_at', () => {
    const db = migratedDb();
    expect(() =>
      db
        .prepare(RAW_SNAPSHOT_COLUMNS)
        .run(AGENTKIT.repoId, '2026-08-08', 40, '2026-08-08T13:00:00Z', NY, '2026-08-08T13:00:00.000Z'),
    ).toThrow(/canonical UTC/i);
  });

  it('refuses a snapshot_day no timezone offset could produce for that instant', () => {
    // The direct attack on the denominator: a well-formed row filing today's
    // reading under an unrelated day. Nothing downstream could ever notice.
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_SNAPSHOT_COLUMNS).run(
        AGENTKIT.repoId,
        '2026-07-01',
        40,
        '2026-08-08T13:00:00.000Z',
        NY,
        '2026-08-08T13:00:00.000Z',
      ),
    ).toThrow(/not a plausible local day/i);
  });

  it('accepts the widest real timezone offsets either side of the instant', () => {
    // UTC+14 (Pacific/Kiritimati) puts the local day AHEAD of the UTC date;
    // UTC-11 (Pacific/Niue) puts it behind. Both must pass the plausibility
    // trigger above, or that guard would reject legitimate rows.
    const db = migratedDb();
    recordStarSnapshot(db, {
      ...AGENTKIT,
      stars: 40,
      observedAt: '2026-08-08T13:00:00.000Z',
      tz: 'Pacific/Kiritimati',
    });
    recordStarSnapshot(db, {
      repoId: 900003,
      itemKey: 'd'.repeat(64),
      fullName: 'acme/other',
      stars: 40,
      observedAt: '2026-08-08T05:00:00.000Z',
      tz: 'Pacific/Niue',
    });

    expect(getStarSnapshots(db, AGENTKIT.repoId)[0]?.snapshotDay).toBe('2026-08-09');
    expect(getStarSnapshots(db, 900003)[0]?.snapshotDay).toBe('2026-08-07');
  });

  it('refuses to delete a repo name', () => {
    const db = migratedDb();
    recordDays(db, [['2026-08-08', 40]]);
    expect(() => db.exec('delete from github_repo_names')).toThrow(/never deleted/i);
  });

  it('refuses to repoint a recorded name at a different repo', () => {
    const db = migratedDb();
    recordDays(db, [['2026-08-08', 40]]);
    expect(() => db.exec('update github_repo_names set repo_id = 999999')).toThrow(/immutable/i);
  });

  it('refuses to make a name pairing look staler than it is', () => {
    const db = migratedDb();
    recordDays(db, [['2026-08-08', 40]]);
    expect(() =>
      db.exec("update github_repo_names set last_seen_at = '2020-01-01T00:00:00.000Z'"),
    ).toThrow(/may only move forward/i);
  });
});

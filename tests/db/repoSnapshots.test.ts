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

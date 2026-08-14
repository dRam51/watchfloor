import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { BEATS } from '../../src/domain/item.ts';
import {
  getLaneLayout,
  setLaneLayout,
  InvalidLaneLayoutError,
  type LaneLayoutEntry,
} from '../../src/domain/laneState.ts';

const open: Db[] = [];

function migratedDb(): { db: Db; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db');
  const db = openDb(path);
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return { db, path };
}

/** A second, independent connection to the same file -- proves persistence
 * survives a fresh connection, not just an in-process cache. Same pattern as
 * tests/domain/itemState.test.ts's `reopen`. */
function reopen(path: string): Db {
  const db = openDb(path);
  open.push(db);
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

const NOW = '2026-08-14T12:00:00.000Z';

describe('getLaneLayout', () => {
  it('defaults to all six beats, in BEATS canonical order, none collapsed, when nothing has ever been stored', () => {
    const { db } = migratedDb();
    const layout = getLaneLayout(db);
    expect(layout).toEqual(BEATS.map((beat) => ({ beat, collapsed: false })));
  });
});

describe('setLaneLayout', () => {
  it('persists a full reordered layout with mixed collapsed flags', () => {
    const { db } = migratedDb();
    const reversed: LaneLayoutEntry[] = [...BEATS].reverse().map((beat, i) => ({
      beat,
      collapsed: i % 2 === 0,
    }));

    const result = setLaneLayout(db, reversed, NOW);
    expect(result).toEqual(reversed);
    expect(getLaneLayout(db)).toEqual(reversed);
  });

  it('survives a fresh DB connection to the same file -- proves this is real persistence, not an in-process cache', () => {
    const { db, path } = migratedDb();
    const custom: LaneLayoutEntry[] = [
      { beat: 'usnews', collapsed: true },
      { beat: 'markets', collapsed: true },
      { beat: 'repos', collapsed: false },
      { beat: 'ai', collapsed: false },
      { beat: 'aisec', collapsed: false },
      { beat: 'cyber', collapsed: false },
    ];
    setLaneLayout(db, custom, NOW);
    closeDb(db);
    open.splice(open.indexOf(db), 1);

    const reconnected = reopen(path);
    // If setLaneLayout silently failed to persist (e.g. wrote to an
    // in-memory structure instead of the DB, or never committed), this
    // would come back as the all-default layout instead -- this assertion
    // is the one that would catch that regression.
    expect(getLaneLayout(reconnected)).toEqual(custom);
  });

  it('rejects a layout with an unknown beat, and does not partially apply it', () => {
    const { db } = migratedDb();
    const before = getLaneLayout(db);

    const bad = [
      { beat: 'ai', collapsed: false },
      { beat: 'cyber', collapsed: false },
      { beat: 'aisec', collapsed: false },
      { beat: 'repos', collapsed: false },
      { beat: 'markets', collapsed: false },
      { beat: 'sports', collapsed: false }, // not a real beat
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as unknown as LaneLayoutEntry[];

    expect(() => setLaneLayout(db, bad, NOW)).toThrow(InvalidLaneLayoutError);
    expect(getLaneLayout(db)).toEqual(before);
  });

  it('rejects a layout with a duplicate beat, and does not partially apply it', () => {
    const { db } = migratedDb();
    const before = getLaneLayout(db);

    const bad: LaneLayoutEntry[] = [
      { beat: 'ai', collapsed: false },
      { beat: 'ai', collapsed: true },
      { beat: 'cyber', collapsed: false },
      { beat: 'aisec', collapsed: false },
      { beat: 'repos', collapsed: false },
      { beat: 'markets', collapsed: false },
    ];

    expect(() => setLaneLayout(db, bad, NOW)).toThrow(InvalidLaneLayoutError);
    expect(getLaneLayout(db)).toEqual(before);
  });

  it('rejects a layout missing a beat (a partial list), and does not partially apply it', () => {
    const { db } = migratedDb();
    const before = getLaneLayout(db);

    const bad: LaneLayoutEntry[] = [
      { beat: 'ai', collapsed: false },
      { beat: 'cyber', collapsed: false },
      { beat: 'aisec', collapsed: false },
      { beat: 'repos', collapsed: false },
      { beat: 'markets', collapsed: false },
      // usnews missing
    ];

    expect(() => setLaneLayout(db, bad, NOW)).toThrow(InvalidLaneLayoutError);
    expect(getLaneLayout(db)).toEqual(before);
  });

  it('rejects a malformed `now`', () => {
    const { db } = migratedDb();
    const valid = BEATS.map((beat) => ({ beat, collapsed: false }));
    expect(() => setLaneLayout(db, valid, 'not-a-timestamp')).toThrow();
  });
});

describe('graceful degradation against stale storage', () => {
  it('ignores a beat in storage that is no longer in BEATS, without crashing, and still defaults the real six', () => {
    const { db } = migratedDb();
    // Simulate a beat that used to exist and was retired from BEATS in a
    // later code change -- a raw INSERT bypassing setLaneLayout's
    // validation entirely, exactly as a leftover row from before such a
    // rename would look.
    db.prepare(
      'insert into lane_layout (beat, position, collapsed, updated_at) values (?, ?, ?, ?)',
    ).run('crypto', 0, 0, NOW);

    const layout = getLaneLayout(db);
    expect(layout.map((l) => l.beat).sort()).toEqual([...BEATS].sort());
    expect(layout.find((l) => (l.beat as string) === 'crypto')).toBeUndefined();
  });

  it('defaults beats that have no stored row while honoring the ones that do', () => {
    const { db } = migratedDb();
    // Only two of six beats have ever been written -- e.g. a partial
    // migration-era row, or a future write path that isn't setLaneLayout.
    db.prepare(
      'insert into lane_layout (beat, position, collapsed, updated_at) values (?, ?, ?, ?)',
    ).run('cyber', 0, 1, NOW);
    db.prepare(
      'insert into lane_layout (beat, position, collapsed, updated_at) values (?, ?, ?, ?)',
    ).run('ai', 1, 0, NOW);

    const layout = getLaneLayout(db);
    expect(layout).toHaveLength(6);
    expect(layout[0]).toEqual({ beat: 'cyber', collapsed: true });
    expect(layout[1]).toEqual({ beat: 'ai', collapsed: false });
    // The four never-stored beats default to appended, in BEATS's own
    // canonical order, none collapsed.
    const rest = layout.slice(2).map((l) => l.beat);
    expect(rest).toEqual(BEATS.filter((b) => b !== 'cyber' && b !== 'ai'));
    for (const entry of layout.slice(2)) expect(entry.collapsed).toBe(false);
  });
});

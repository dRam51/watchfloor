import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem } from '../../src/domain/item.ts';
import { createBackup, listBackups, BackupError } from '../../src/backup/create.ts';

const open: Array<ReturnType<typeof openDb>> = [];
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wf-backup-'));
}
function migratedDb(dir = tempDir()): { db: ReturnType<typeof openDb>; path: string } {
  const path = join(dir, 'wf.db');
  const db = openDb(path);
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return { db, path };
}
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

const NY = 'America/New_York';
let seq = 0;
function seedItem(db: ReturnType<typeof openDb>, fetchedAt = '2026-08-16T12:00:00.000Z') {
  seq += 1;
  const url = `https://example.com/story-${seq}`;
  insertItem(db, {
    url,
    canonicalUrl: url,
    title: `story ${seq}`,
    sourceId: 'krebs',
    itemType: 'analysis',
    beats: ['cyber'],
    entities: [],
    publishedAt: fetchedAt,
    fetchedAt,
    summaryRaw: null,
    rawJson: '{}',
  });
}

describe('createBackup', () => {
  it('writes a single file that is itself a valid, complete database', () => {
    const { db, path } = migratedDb();
    for (let i = 0; i < 5; i += 1) seedItem(db);
    const outDir = tempDir();

    const result = createBackup({ dbPath: path, outDir, now: '2026-08-16T17:30:00.000Z', tz: NY });

    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    // The point of the whole exercise: open the backup and read from it.
    const restored = openDb(result.path);
    open.push(restored);
    const count = restored.prepare('select count(*) c from items').get() as { c: number };
    expect(count.c).toBe(5);
  });

  it('VERIFIES the backup by reading it back, not by trusting the copy', () => {
    const { db, path } = migratedDb();
    for (let i = 0; i < 3; i += 1) seedItem(db);
    const outDir = tempDir();

    const result = createBackup({ dbPath: path, outDir, now: '2026-08-16T17:30:00.000Z', tz: NY });

    expect(result.verification.integrityCheck).toBe('ok');
    expect(result.verification.mismatches).toEqual([]);
    expect(result.verification.verified).toBe(true);
    // Every table compared, not a sample -- and `items` must be among them,
    // or the comparison is over an empty set and proves nothing.
    const names = result.verification.tables.map((t) => t.name);
    expect(names).toContain('items');
    expect(names).toContain('schema_migrations');
    for (const t of result.verification.tables) expect(t.backup).toBe(t.source);
  });

  it('refuses a corrupt backup rather than reporting success', () => {
    // The failure this exists to catch: a backup that was written, is the right
    // size, and cannot be read. Simulated by truncating the file the verifier
    // is about to open -- the copy "succeeded" and the verification must not.
    const { db, path } = migratedDb();
    seedItem(db);
    const outDir = tempDir();

    const result = createBackup({ dbPath: path, outDir, now: '2026-08-16T17:30:00.000Z', tz: NY });
    // Corrupt it AFTER a good run, then verify the verifier would have caught it.
    const bytes = readFileSync(result.path);
    writeFileSync(result.path, bytes.subarray(0, Math.floor(bytes.length / 2)));

    expect(() => createBackup({ dbPath: result.path, outDir, now: '2026-08-16T18:00:00.000Z', tz: NY })).toThrow(
      BackupError,
    );
  });

  it('names the file from the injected instant in WF_TZ, never the host clock', () => {
    // The instant is deliberately in the PAST, not "today at a different hour".
    // A first version of this test used 2026-08-17T02:30Z, which is the 16th in
    // New York and the 17th in Tokyo -- and on the day it was written those
    // were also the real calendar days on the host, so an implementation
    // reading `new Date()` passed it. That is the same shape as the
    // countFailingSources time bomb (see src/api/routes/sources.ts): a test
    // that agrees with the wall clock by coincidence proves nothing, and stops
    // proving it silently the next day.
    const { db, path } = migratedDb();
    seedItem(db);
    const outDir = tempDir();

    // 02:30 UTC on 2025-03-05 is 21:30 on the 4th in New York.
    const ny = createBackup({ dbPath: path, outDir, now: '2025-03-05T02:30:00.000Z', tz: NY });
    const tokyo = createBackup({ dbPath: path, outDir, now: '2025-03-05T02:30:00.000Z', tz: 'Asia/Tokyo' });

    expect(ny.path).toContain('2025-03-04');
    expect(tokyo.path).toContain('2025-03-05');
    // And the time-of-day, so a date-only implementation cannot pass either.
    expect(ny.path).toContain('-213000.db');
    expect(tokyo.path).toContain('-113000.db');
  });

  it('never overwrites an existing backup', () => {
    // Two runs at the same instant must not silently collapse into one file --
    // the second would destroy the first, which is a delete by another name.
    const { db, path } = migratedDb();
    seedItem(db);
    const outDir = tempDir();
    const at = '2026-08-16T17:30:00.000Z';

    const first = createBackup({ dbPath: path, outDir, now: at, tz: NY });
    const second = createBackup({ dbPath: path, outDir, now: at, tz: NY });

    expect(second.path).not.toBe(first.path);
    expect(existsSync(first.path)).toBe(true);
    expect(statSync(first.path).size).toBeGreaterThan(0);
  });

  it('refuses to run against a database path that does not exist', () => {
    expect(() =>
      createBackup({ dbPath: join(tempDir(), 'nope.db'), outDir: tempDir(), now: '2026-08-16T17:30:00.000Z', tz: NY }),
    ).toThrow(BackupError);
  });

  it('captures rows written right up to the copy -- not a stale snapshot', () => {
    const { db, path } = migratedDb();
    for (let i = 0; i < 4; i += 1) seedItem(db);
    const outDir = tempDir();

    // A WAL-mode database keeps recent writes outside the main file. A copy
    // that used `cp` would miss these; VACUUM INTO must not.
    const result = createBackup({ dbPath: path, outDir, now: '2026-08-16T17:30:00.000Z', tz: NY });

    const restored = openDb(result.path);
    open.push(restored);
    expect((restored.prepare('select count(*) c from items').get() as { c: number }).c).toBe(4);
  });
});

describe('listBackups', () => {
  it('reports what exists and never removes any of it', () => {
    const { db, path } = migratedDb();
    seedItem(db);
    const outDir = tempDir();
    createBackup({ dbPath: path, outDir, now: '2026-08-14T17:30:00.000Z', tz: NY });
    createBackup({ dbPath: path, outDir, now: '2026-08-16T17:30:00.000Z', tz: NY });

    const before = readdirSync(outDir).length;
    const listed = listBackups(outDir);

    expect(listed).toHaveLength(2);
    expect(readdirSync(outDir).length).toBe(before); // listing is not pruning
    // Newest first, so an operator reading the top line sees the current one.
    expect(listed[0]!.path > listed[1]!.path).toBe(true);
    expect(listed[0]!.bytes).toBeGreaterThan(0);
  });

  it('returns an empty list for a directory that does not exist yet', () => {
    expect(listBackups(join(tempDir(), 'never-made'))).toEqual([]);
  });
});

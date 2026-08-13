import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';

const open: Array<ReturnType<typeof openDb>> = [];
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wf-test-'));
}
function freshDb() {
  const db = openDb(join(tempDir(), 'wf.db'));
  open.push(db);
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

describe('runMigrations', () => {
  it('applies migrations in filename order and records them', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0002_second.sql'), 'create table b (x integer);');
    writeFileSync(join(dir, '0001_first.sql'), 'create table a (x integer);');

    const db = freshDb();
    expect(runMigrations(db, dir)).toEqual(['0001_first', '0002_second']);

    const versions = db.prepare('select version from schema_migrations order by version').all();
    expect(versions).toEqual([{ version: '0001_first' }, { version: '0002_second' }]);
  });

  it('is idempotent', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_first.sql'), 'create table a (x integer);');
    const db = freshDb();
    runMigrations(db, dir);
    expect(runMigrations(db, dir)).toEqual([]);
  });

  it('rolls back a failing migration and records nothing', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_bad.sql'), 'create table a (x integer); this is not sql;');
    const db = freshDb();

    expect(() => runMigrations(db, dir)).toThrow(/0001_bad/);
    const applied = db.prepare('select count(*) as c from schema_migrations').get() as { c: number };
    expect(applied.c).toBe(0);
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'a'")
      .all();
    expect(tables).toEqual([]);
  });
});

describe('0001_init', () => {
  it('applies the real schema and blocks updates and deletes on items', () => {
    const db = freshDb();
    runMigrations(db, join(process.cwd(), 'db', 'migrations'));

    db.prepare(
      `insert into items (item_id, item_key, url, canonical_url, title, source_id,
                          item_type, fetched_at, raw_json, created_at)
       values ('i1', 'k1', 'https://e.test/a', 'https://e.test/a', 'T', 's1',
               'event', '2026-08-12T00:00:00.000Z', '{}', '2026-08-12T00:00:00.000Z')`,
    ).run();

    expect(() => db.prepare("update items set title = 'X' where item_id = 'i1'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("delete from items where item_id = 'i1'").run()).toThrow(/append-only/);
  });
});

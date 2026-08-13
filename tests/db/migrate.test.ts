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

describe('runMigrations transaction integrity', () => {
  it('rejects a migration that embeds its own COMMIT, preserving the real failure and recording nothing', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_embeds_commit.sql'), 'create table x (id integer);\ncommit;\n');
    const db = freshDb();

    let caught: Error | undefined;
    try {
      runMigrations(db, dir);
    } catch (err) {
      caught = err as Error;
    }

    // Half 1: the caller gets an informative, version-scoped error — not the
    // rollback-masking "cannot rollback - no transaction is active" that
    // escapes the unguarded catch in the pre-fix implementation.
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/0001_embeds_commit/);
    expect(caught!.message).not.toMatch(/cannot rollback - no transaction is active/);

    // Half 2: nothing was left behind. No bookkeeping row for a migration
    // that never truly completed...
    const applied = db.prepare('select count(*) as c from schema_migrations').get() as {
      c: number;
    };
    expect(applied.c).toBe(0);

    // ...and no schema drift either: the embedded COMMIT must never reach
    // SQLite, so table `x` must never come into existence at all.
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'x'")
      .all();
    expect(tables).toEqual([]);
  });

  it('rejects a migration that embeds its own ROLLBACK the same way', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, '0001_embeds_rollback.sql'),
      'create table y (id integer);\nrollback;\n',
    );
    const db = freshDb();

    expect(() => runMigrations(db, dir)).toThrow(/0001_embeds_rollback/);
    const applied = db.prepare('select count(*) as c from schema_migrations').get() as {
      c: number;
    };
    expect(applied.c).toBe(0);
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

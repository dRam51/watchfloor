import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations, assertMigrationsUpToDate } from '../../src/db/migrate.ts';
import { BEATS } from '../../src/domain/item.ts';

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
    expect(runMigrations(db, dir)).toEqual({
      applied: ['0001_first', '0002_second'],
      backfilledChecksums: [],
    });

    const versions = db.prepare('select version from schema_migrations order by version').all();
    expect(versions).toEqual([{ version: '0001_first' }, { version: '0002_second' }]);
  });

  it('is idempotent', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_first.sql'), 'create table a (x integer);');
    const db = freshDb();
    runMigrations(db, dir);
    expect(runMigrations(db, dir)).toEqual({ applied: [], backfilledChecksums: [] });
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

const MIGRATIONS = join(process.cwd(), 'db', 'migrations');

/** A migrated db holding one item plus one row in each append-only child. */
function seededDb() {
  const db = freshDb();
  runMigrations(db, MIGRATIONS);
  db.exec(`
    insert into items (item_id, item_key, url, canonical_url, title, source_id,
                       item_type, fetched_at, raw_json, created_at)
    values ('i1', 'k1', 'https://e.test/a', 'https://e.test/a', 'T', 's1',
            'event', '2026-08-12T00:00:00.000Z', '{}', '2026-08-12T00:00:00.000Z');
    insert into item_scores (score_id, item_id, beat, signal_score, read_score,
                             scorer_version, computed_at)
    values ('sc1', 'i1', 'ai', 0.5, 0.75, 'v1', '2026-08-12T00:00:00.000Z');
    insert into clusters (cluster_id, created_at) values ('c1', '2026-08-12T00:00:00.000Z');
    insert into item_clusters (membership_id, cluster_id, item_key, fetched_at)
    values ('m1', 'c1', 'k1', '2026-08-12T00:00:00.000Z');
  `);
  return db;
}

describe('0001_init append-only triggers', () => {
  // Each table gets its own case, and each asserts the POST-STATE as well as
  // the throw. A trigger naming the wrong table in its `on <table>` clause
  // would parse, apply, and still raise on some other table's mutation — so
  // "it threw" alone does not prove this table is protected. The surviving,
  // unchanged row does.
  it('blocks updates and deletes on items, leaving the row intact', () => {
    const db = seededDb();

    expect(() => db.prepare("update items set title = 'X' where item_id = 'i1'").run()).toThrow(
      /items is append-only/,
    );
    expect(() => db.prepare("delete from items where item_id = 'i1'").run()).toThrow(
      /items is append-only/,
    );

    expect(db.prepare("select title from items where item_id = 'i1'").get()).toEqual({ title: 'T' });
  });

  it('blocks updates and deletes on item_scores, leaving the row intact', () => {
    const db = seededDb();

    expect(() =>
      db.prepare("update item_scores set read_score = 0.1 where score_id = 'sc1'").run(),
    ).toThrow(/item_scores is append-only/);
    expect(() => db.prepare("delete from item_scores where score_id = 'sc1'").run()).toThrow(
      /item_scores is append-only/,
    );

    expect(db.prepare("select read_score from item_scores where score_id = 'sc1'").get()).toEqual({
      read_score: 0.75,
    });
  });

  it('blocks updates and deletes on item_clusters, leaving the row intact', () => {
    const db = seededDb();

    expect(() =>
      db.prepare("update item_clusters set item_key = 'k9' where membership_id = 'm1'").run(),
    ).toThrow(/item_clusters is append-only/);
    expect(() => db.prepare("delete from item_clusters where membership_id = 'm1'").run()).toThrow(
      /item_clusters is append-only/,
    );

    expect(
      db.prepare("select item_key from item_clusters where membership_id = 'm1'").get(),
    ).toEqual({ item_key: 'k1' });
  });

  // INSERT OR REPLACE resolves a primary-key conflict with an implicit
  // DELETE-then-INSERT. With SQLite's recursive_triggers pragma at its default
  // (OFF), that implicit DELETE does not fire BEFORE DELETE triggers, so
  // these three statements bypassed items_no_delete / item_scores_no_delete /
  // item_clusters_no_delete entirely: no error, no signal, prior version
  // gone. openDb (src/db/connection.ts) sets recursive_triggers = ON to close
  // this. Each case asserts the row survives unchanged, not just that the
  // statement throws -- a trigger naming the wrong table would still let some
  // *other* table's throw make this pass.
  it('blocks INSERT OR REPLACE on items, leaving the row intact', () => {
    const db = seededDb();

    expect(() =>
      db
        .prepare(
          `insert or replace into items (item_id, item_key, url, canonical_url, title, source_id,
                                         item_type, fetched_at, raw_json, created_at)
           values ('i1', 'k1', 'https://e.test/a', 'https://e.test/a', 'REPLACED', 's1',
                   'event', '2026-08-12T00:00:00.000Z', '{}', '2026-08-12T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/items is append-only/);

    expect(db.prepare("select title from items where item_id = 'i1'").get()).toEqual({ title: 'T' });
  });

  it('blocks INSERT OR REPLACE on item_scores, leaving the row intact', () => {
    const db = seededDb();

    expect(() =>
      db
        .prepare(
          `insert or replace into item_scores (score_id, item_id, beat, signal_score, read_score,
                                               scorer_version, computed_at)
           values ('sc1', 'i1', 'ai', 0.9, 0.9, 'v2', '2026-08-12T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/item_scores is append-only/);

    expect(db.prepare("select read_score from item_scores where score_id = 'sc1'").get()).toEqual({
      read_score: 0.75,
    });
  });

  it('blocks INSERT OR REPLACE on item_clusters, leaving the row intact', () => {
    const db = seededDb();

    expect(() =>
      db
        .prepare(
          `insert or replace into item_clusters (membership_id, cluster_id, item_key, fetched_at)
           values ('m1', 'c1', 'k9', '2026-08-12T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/item_clusters is append-only/);

    expect(
      db.prepare("select item_key from item_clusters where membership_id = 'm1'").get(),
    ).toEqual({ item_key: 'k1' });
  });
});

describe('0002_constraints', () => {
  const CANONICAL = '2026-08-12T00:00:00.000Z';

  function insertItemSql(overrides: { fetchedAt?: string; publishedAt?: string | null } = {}) {
    const fetchedAt = overrides.fetchedAt ?? CANONICAL;
    const publishedAt =
      overrides.publishedAt === undefined ? null : overrides.publishedAt;
    return `insert into items (item_id, item_key, url, canonical_url, title, source_id,
                               item_type, published_at, fetched_at, raw_json, created_at)
            values ('i9', 'k9', 'https://e.test/z', 'https://e.test/z', 'T', 's1', 'event',
                    ${publishedAt === null ? 'null' : `'${publishedAt}'`},
                    '${fetchedAt}', '{}', '${CANONICAL}')`;
  }

  it('rejects a beat outside the vocabulary on item_beats and item_scores', () => {
    const db = seededDb();

    expect(() => db.prepare("insert into item_beats values ('i1', 'sports')").run()).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      db
        .prepare(
          `insert into item_scores values ('sc9', 'i1', 'sports', 0, 0, 'v1', '${CANONICAL}')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('accepts every beat the application layer considers valid', () => {
    const db = seededDb();
    // Guards the other direction: a typo'd CHECK list would pass the reject
    // test above while quietly making a real beat un-writable.
    for (const beat of BEATS) {
      expect(() =>
        db.prepare('insert into item_beats (item_id, beat) values (?, ?)').run('i1', beat),
      ).not.toThrow();
    }
    const stored = db
      .prepare('select beat from item_beats where item_id = ? order by beat')
      .all('i1') as Array<{ beat: string }>;
    expect(stored.map((r) => r.beat).sort()).toEqual([...BEATS].sort());
  });

  it('rejects non-canonical timestamps at the SQL layer, not just in insertItem', () => {
    const db = seededDb();

    // Second precision — what strftime or `.slice(0, 19) + 'Z'` produces.
    expect(() => db.prepare(insertItemSql({ fetchedAt: '2026-08-12T00:00:00Z' })).run()).toThrow(
      /items.fetched_at must be a canonical UTC timestamp/,
    );
    // Non-UTC offset — sorts wrong against every 'Z' value.
    expect(() =>
      db.prepare(insertItemSql({ fetchedAt: '2026-08-12T00:00:00.000-05:00' })).run(),
    ).toThrow(/items.fetched_at must be a canonical UTC timestamp/);
    // Free text, the case a CHECK-less column accepted silently.
    expect(() => db.prepare(insertItemSql({ fetchedAt: 'not-a-timestamp' })).run()).toThrow(
      /items.fetched_at must be a canonical UTC timestamp/,
    );
    // published_at gets the same rule, but NULL stays legal.
    expect(() =>
      db.prepare(insertItemSql({ publishedAt: '2026-08-10T12:00:00-05:00' })).run(),
    ).toThrow(/items.published_at must be NULL or a canonical UTC timestamp/);

    expect(() => db.prepare(insertItemSql({ publishedAt: null })).run()).not.toThrow();
    expect((db.prepare('select count(*) as c from items').get() as { c: number }).c).toBe(2);
  });

  it('preserves existing rows, indexes and triggers when applied over live data', () => {
    // 0002 drops and recreates item_beats and item_scores for real. A test
    // that migrates an *empty* database proves nothing about that. Stage the
    // migrations so data exists before the rebuild runs: apply 0001 alone,
    // seed it, then let 0002 land on top.
    const dir = tempDir();
    copyFileSync(join(MIGRATIONS, '0001_init.sql'), join(dir, '0001_init.sql'));

    const db = freshDb();
    expect(runMigrations(db, dir)).toEqual({ applied: ['0001_init'], backfilledChecksums: [] });

    db.exec(`
      insert into items (item_id, item_key, url, canonical_url, title, source_id,
                         item_type, published_at, fetched_at, raw_json, created_at)
      values ('i1', 'k1', 'https://e.test/a', 'https://e.test/a', 'T1', 's1', 'event',
              '2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '{}', '${CANONICAL}'),
             ('i2', 'k1', 'https://e.test/a', 'https://e.test/a', 'T2', 's1', 'analysis',
              null, '${CANONICAL}', '{}', '${CANONICAL}');
      insert into item_beats (item_id, beat) values ('i1', 'ai'), ('i1', 'markets'), ('i2', 'ai');
      insert into item_entities (item_id, entity) values ('i1', 'NVDA');
      insert into item_scores values ('sc1', 'i1', 'ai', 0.5, 0.75, 'v1', '${CANONICAL}'),
                                     ('sc2', 'i1', 'markets', 0.1, 0.2, 'v1', '${CANONICAL}');
      insert into clusters values ('c1', '${CANONICAL}');
      insert into item_clusters values ('m1', 'c1', 'k1', '${CANONICAL}');
    `);
    const beatsBefore = db.prepare('select item_id, beat from item_beats order by 1, 2').all();
    const scoresBefore = db.prepare('select * from item_scores order by score_id').all();

    copyFileSync(join(MIGRATIONS, '0002_constraints.sql'), join(dir, '0002_constraints.sql'));
    expect(runMigrations(db, dir)).toEqual({ applied: ['0002_constraints'], backfilledChecksums: [] });

    // Every row survived the rebuild, byte for byte.
    expect(db.prepare('select item_id, beat from item_beats order by 1, 2').all()).toEqual(
      beatsBefore,
    );
    expect(db.prepare('select * from item_scores order by score_id').all()).toEqual(scoresBefore);
    for (const [table, count] of [
      ['items', 2],
      ['item_entities', 1],
      ['clusters', 1],
      ['item_clusters', 1],
    ] as const) {
      expect(
        (db.prepare(`select count(*) as c from ${table}`).get() as { c: number }).c,
        `${table} lost rows`,
      ).toBe(count);
    }

    // The rebuild recreated everything it dropped, and left no scaffolding.
    const schema = db.prepare('select name from sqlite_master order by name').all() as Array<{
      name: string;
    }>;
    const names = schema.map((r) => r.name);
    for (const object of [
      'items_key_fetched',
      'items_fetched',
      'items_canonical',
      'items_no_update',
      'items_no_delete',
      'item_scores_lookup',
      'item_scores_no_update',
      'item_scores_no_delete',
    ]) {
      expect(names, `0002 did not restore ${object}`).toContain(object);
    }
    expect(names.filter((n) => n.includes('0002'))).toEqual([]);

    // Triggers still fire on the rebuilt table, and foreign keys still bind
    // it to the items table it was detached from and reattached to.
    expect(() =>
      db.prepare("update item_scores set read_score = 0 where score_id = 'sc1'").run(),
    ).toThrow(/item_scores is append-only/);
    expect(() => db.prepare("insert into item_beats values ('ghost', 'ai')").run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(db.prepare('pragma foreign_key_check').all()).toEqual([]);
  });

  it('fails loudly and changes nothing when existing data violates a new constraint', () => {
    // A pre-existing beat outside the vocabulary must abort the whole
    // migration rather than be dropped on the floor during the copy.
    const dir = tempDir();
    copyFileSync(join(MIGRATIONS, '0001_init.sql'), join(dir, '0001_init.sql'));
    const db = freshDb();
    runMigrations(db, dir);
    db.exec(`
      insert into items (item_id, item_key, url, canonical_url, title, source_id,
                         item_type, fetched_at, raw_json, created_at)
      values ('i1', 'k1', 'u', 'u', 'T', 's1', 'event', '${CANONICAL}', '{}', '${CANONICAL}');
      insert into item_beats (item_id, beat) values ('i1', 'ai'), ('i1', 'sports');
    `);
    const schemaBefore = db.prepare('select name, sql from sqlite_master order by name').all();

    copyFileSync(join(MIGRATIONS, '0002_constraints.sql'), join(dir, '0002_constraints.sql'));
    expect(() => runMigrations(db, dir)).toThrow(/0002_constraints/);

    // Nothing applied, nothing recorded, nothing lost — the offending row is
    // still there to be found and fixed.
    expect(db.prepare('select name, sql from sqlite_master order by name').all()).toEqual(
      schemaBefore,
    );
    expect((db.prepare('select count(*) as c from item_beats').get() as { c: number }).c).toBe(2);
    const applied = db.prepare('select version from schema_migrations').all() as Array<{
      version: string;
    }>;
    expect(applied.map((r) => r.version)).toEqual(['0001_init']);
  });
});

// Fixes the finding recorded in
// .superpowers/sdd/2026-08-14-m3-api-dashboard/progress.md, "Finding: the
// migration runner has no drift detection" + the follow-up "CORRECTION +
// escalation": schema_migrations recorded only (version, applied_at), so a
// migration file edited after being applied was silently skipped forever.
// Confirmed live: 0005_fts_search.sql was applied, then split one trigger
// into two; data/wf.db kept the old, unoptimised single-trigger version and
// the runner never noticed. These tests reproduce that shape directly.
describe('runMigrations checksum verification', () => {
  it('records a sha256 checksum for every migration it applies', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_first.sql'), 'create table a (x integer);');
    const db = freshDb();
    runMigrations(db, dir);

    const row = db
      .prepare('select checksum from schema_migrations where version = ?')
      .get('0001_first') as { checksum: string | null };
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('REGRESSION (the original incident): re-running with the file untouched is a silent no-op, but re-running after the file is edited post-application fails loudly and names the file', () => {
    const dir = tempDir();
    const file = join(dir, '0001_original.sql');
    writeFileSync(file, 'create table a (x integer);');
    const db = freshDb();
    runMigrations(db, dir);

    // Untouched: re-running does nothing and raises nothing. This is the
    // correct silence — proves the fix does not turn every boot into a
    // checksum-mismatch false alarm.
    expect(runMigrations(db, dir)).toEqual({ applied: [], backfilledChecksums: [] });

    // The exact incident from the M3 progress log: the migration's author
    // edits the file (e.g. splits one trigger into two) *after* it has
    // already been applied to a real database.
    writeFileSync(file, 'create table a (x integer, y integer);');

    expect(() => runMigrations(db, dir)).toThrow(/0001_original/);
    expect(() => runMigrations(db, dir)).toThrow(/checksum/i);
    // Names the actual file on disk, not just the version stem — the person
    // hitting this is confused ("the code looks right, the database is
    // wrong") and needs to be pointed at exactly what to go look at.
    expect(() => runMigrations(db, dir)).toThrow(/0001_original\.sql/);

    // And it genuinely refused rather than quietly reapplying or quietly
    // skipping: the live table still has the pre-edit shape.
    const cols = db.prepare('pragma table_info(a)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(['x']);
  });
});

// The backfill problem: six migrations are already applied on real machines
// (including this repo's own data/wf.db) with no recorded checksum, because
// the column did not exist when they ran. The strategy chosen here: treat a
// NULL checksum as "unknown provenance — trust the on-disk file once, as of
// right now, and record it so every future run is protected." The
// alternative (refuse to boot until someone manually re-certifies six
// already-applied migrations) would brick every existing database, which
// the task explicitly rules out. The accepted limitation, stated rather
// than hidden: this cannot retroactively prove those six files were never
// edited between application and this backfill — only a checksum captured
// AT apply time could do that, and none was. It converts "permanently
// unprotected" into "protected from this point forward," which is what is
// achievable without out-of-band evidence (e.g. diffing against the live
// schema, which is exactly what the M3 coordinator had to do by hand).
describe('runMigrations checksum backfill for pre-existing rows', () => {
  /**
   * Simulates a database migrated before this checksum feature existed:
   * schema_migrations has a real applied row with no checksum recorded
   * because the column did not exist yet when the row was inserted. The
   * live schema genuinely matches the file — this is a clean legacy
   * database, not a drifted one — so backfilling is the correct call.
   */
  function seedLegacyAppliedRow(db: Db, dir: string, file: string, sql: string): void {
    writeFileSync(join(dir, file), sql);
    db.exec(`
      create table if not exists schema_migrations (
        version    text primary key,
        applied_at text not null
      )
    `);
    db.exec(sql);
    const version = file.slice(0, -'.sql'.length);
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(
      version,
      '2026-01-01T00:00:00.000Z',
    );
  }

  it('backfills a checksum on first run without bricking the database or reapplying the migration', () => {
    const dir = tempDir();
    const db = freshDb();
    seedLegacyAppliedRow(db, dir, '0001_legacy.sql', 'create table legacy (x integer);');

    expect(runMigrations(db, dir)).toEqual({ applied: [], backfilledChecksums: ['0001_legacy'] });

    const row = db
      .prepare('select checksum from schema_migrations where version = ?')
      .get('0001_legacy') as { checksum: string | null };
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);

    // Exactly one `legacy` table — reapplying `create table` would have
    // thrown "table legacy already exists" and this test would have failed
    // via the outer expect above instead of reaching here.
    const tables = db
      .prepare("select count(*) as c from sqlite_master where type = 'table' and name = 'legacy'")
      .get() as { c: number };
    expect(tables.c).toBe(1);
  });

  it('is idempotent once backfilled: an unmodified file produces no further backfill and no error', () => {
    const dir = tempDir();
    const db = freshDb();
    seedLegacyAppliedRow(db, dir, '0001_legacy.sql', 'create table legacy (x integer);');
    runMigrations(db, dir);

    expect(runMigrations(db, dir)).toEqual({ applied: [], backfilledChecksums: [] });
  });

  it('protects the migration going forward: an edit AFTER the backfill is still caught', () => {
    const dir = tempDir();
    const file = join(dir, '0001_legacy.sql');
    const db = freshDb();
    seedLegacyAppliedRow(db, dir, '0001_legacy.sql', 'create table legacy (x integer);');
    runMigrations(db, dir); // establishes the trusted baseline checksum

    writeFileSync(file, 'create table legacy (x integer, y integer);');
    expect(() => runMigrations(db, dir)).toThrow(/0001_legacy/);
  });
});

// Verified empirically in the M3 progress log: "a numerically-earlier file
// appearing after a later one already ran is applied anyway, out of order,
// with no warning."
describe('runMigrations out-of-order application', () => {
  it('refuses a numerically-earlier file that appears after a later one has already applied', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_first.sql'), 'create table a (x integer);');
    writeFileSync(join(dir, '0003_third.sql'), 'create table c (x integer);');
    const db = freshDb();
    runMigrations(db, dir); // applies 0001 and 0003; 0002 does not exist yet.

    // A migration lands late, numbered as if it belonged between the two
    // that already ran — exactly the scenario a colleague's delayed commit
    // produces.
    writeFileSync(join(dir, '0002_second.sql'), 'create table b (x integer);');

    expect(() => runMigrations(db, dir)).toThrow(/0002_second/);
    expect(() => runMigrations(db, dir)).toThrow(/order/i);

    // Nothing applied: no table b, no bookkeeping row for it.
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'b'")
      .all();
    expect(tables).toEqual([]);
    const row = db
      .prepare('select version from schema_migrations where version = ?')
      .get('0002_second');
    expect(row).toBeUndefined();
  });
});

// The boot-behaviour design question: entrypoints no longer auto-apply.
// assertMigrationsUpToDate is what src/bin/{api,ingest,score,rank,scheduler}.ts
// call instead of runMigrations — see CLAUDE.md and
// .superpowers/sdd/2026-08-14-m3-api-dashboard/fix-migration-runner-report.md
// for the reasoning. It still performs the same checksum/backfill/ordering
// checks (drift and out-of-order files are integrity problems regardless of
// whether the caller is allowed to apply), it just never executes a pending
// migration's SQL.
describe('assertMigrationsUpToDate', () => {
  it('does not throw when every migration on disk has already been applied', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_first.sql'), 'create table a (x integer);');
    const db = freshDb();
    runMigrations(db, dir);

    expect(() => assertMigrationsUpToDate(db, dir)).not.toThrow();
  });

  it('refuses to boot with pending migrations, naming them and pointing at npm run migrate', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_first.sql'), 'create table a (x integer);');
    const db = freshDb();
    // Nothing applied yet — an entrypoint booted against a fresh clone (or
    // a machine a `git pull` just landed new migrations on) before anyone
    // ran `npm run migrate`.

    expect(() => assertMigrationsUpToDate(db, dir)).toThrow(/0001_first/);
    expect(() => assertMigrationsUpToDate(db, dir)).toThrow(/npm run migrate/);

    // It really did refuse: table a was never created, unlike runMigrations.
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'a'")
      .all();
    expect(tables).toEqual([]);
  });

  it('still detects checksum drift on already-applied migrations, without applying anything new', () => {
    const dir = tempDir();
    const file = join(dir, '0001_first.sql');
    writeFileSync(file, 'create table a (x integer);');
    const db = freshDb();
    runMigrations(db, dir);

    writeFileSync(file, 'create table a (x integer, y integer);');
    expect(() => assertMigrationsUpToDate(db, dir)).toThrow(/0001_first/);
  });

  it('still refuses an out-of-order file even in check-only mode', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '0001_first.sql'), 'create table a (x integer);');
    writeFileSync(join(dir, '0003_third.sql'), 'create table c (x integer);');
    const db = freshDb();
    runMigrations(db, dir);
    writeFileSync(join(dir, '0002_second.sql'), 'create table b (x integer);');

    // Must be refused as an ORDERING violation specifically — not merely as
    // a generic "pending migration" (assertMigrationsUpToDate's own
    // "pending" message also happens to name the file, which would let a
    // disabled ordering check hide behind that unrelated message).
    expect(() => assertMigrationsUpToDate(db, dir)).toThrow(/0002_second/);
    expect(() => assertMigrationsUpToDate(db, dir)).toThrow(/order/i);
  });

  it('still backfills checksums for legacy rows even though it never applies anything', () => {
    const dir = tempDir();
    const db = freshDb();
    writeFileSync(join(dir, '0001_legacy.sql'), 'create table legacy (x integer);');
    db.exec(`
      create table if not exists schema_migrations (
        version    text primary key,
        applied_at text not null
      )
    `);
    db.exec('create table legacy (x integer);');
    db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(
      '0001_legacy',
      '2026-01-01T00:00:00.000Z',
    );

    expect(() => assertMigrationsUpToDate(db, dir)).not.toThrow();
    const row = db
      .prepare('select checksum from schema_migrations where version = ?')
      .get('0001_legacy') as { checksum: string | null };
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

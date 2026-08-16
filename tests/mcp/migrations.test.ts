/**
 * The migration guard, for a process that may not write (M5 task 10).
 *
 * CLAUDE.md is unambiguous: *"`api`, `ingest`, `score`, `rank`, and
 * `scheduler` all refuse to start with pending migrations."* The MCP server
 * must do the same — a bot backtesting against a database whose schema
 * predates the columns a tool reads gets confident, wrong answers.
 *
 * It cannot use the shared guard to do it. `assertMigrationsUpToDate` calls
 * `ensureBookkeepingTable` (a `create table if not exists`) and may
 * `update schema_migrations set checksum = ...` — two writes, on a connection
 * that has none. So this is the same check, read-only, and the difference is
 * recorded rather than papered over: a missing checksum is REPORTED here, not
 * backfilled.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { openReadOnlyCorpus, type ReadOnlyCorpus } from '../../src/mcp/readonly.ts';
import {
  assertCorpusMigrationsUpToDate,
  CorpusMigrationError,
} from '../../src/mcp/migrations.ts';
import { tempDir } from './fixture.ts';

const corpora: ReadOnlyCorpus[] = [];
afterEach(() => {
  while (corpora.length) corpora.pop()!.close();
});

/** A real migrations directory and a real database that has had `n` of them applied. */
function scenario(files: Array<[string, string]>, applyFirst: number) {
  const dir = tempDir();
  const migrations = join(dir, 'migrations');
  mkdirSync(migrations);
  for (const [name, sql] of files) writeFileSync(join(migrations, name), sql);

  const dbPath = join(dir, 'corpus.db');
  const writer = openDb(dbPath);
  if (applyFirst > 0) {
    const partial = join(dir, 'partial');
    mkdirSync(partial);
    for (const [name, sql] of files.slice(0, applyFirst)) writeFileSync(join(partial, name), sql);
    runMigrations(writer, partial);
  }
  closeDb(writer);

  const corpus = openReadOnlyCorpus(dbPath);
  corpora.push(corpus);
  return { corpus, migrations, dbPath };
}

const FILES: Array<[string, string]> = [
  ['0001_init.sql', 'create table a (x integer);'],
  ['0002_more.sql', 'create table b (x integer);'],
];

describe('assertCorpusMigrationsUpToDate', () => {
  it('passes when every migration on disk has been applied', () => {
    const { corpus, migrations } = scenario(FILES, 2);
    expect(assertCorpusMigrationsUpToDate(corpus, migrations)).toEqual({
      applied: ['0001_init', '0002_more'],
      unverifiable: [],
    });
  });

  it('refuses when a migration is pending, naming it and the remedy', () => {
    const { corpus, migrations } = scenario(FILES, 1);
    expect(() => assertCorpusMigrationsUpToDate(corpus, migrations)).toThrow(CorpusMigrationError);
    expect(() => assertCorpusMigrationsUpToDate(corpus, migrations)).toThrow(/0002_more/);
    expect(() => assertCorpusMigrationsUpToDate(corpus, migrations)).toThrow(/npm run migrate/);
  });

  it('refuses a database that has never been migrated at all', () => {
    const { corpus, migrations } = scenario(FILES, 0);
    expect(() => assertCorpusMigrationsUpToDate(corpus, migrations)).toThrow(/0001_init/);
  });

  it('refuses an applied migration whose file has since been edited', () => {
    const { corpus, migrations } = scenario(FILES, 2);
    writeFileSync(join(migrations, '0002_more.sql'), 'create table b (x integer, y text);');
    expect(() => assertCorpusMigrationsUpToDate(corpus, migrations)).toThrow(/drifted/);
  });

  // The one place this deliberately differs from the writable guard.
  it('reports a missing checksum rather than backfilling it — it may not write', () => {
    const { corpus, migrations, dbPath } = scenario(FILES, 2);
    const writer = openDb(dbPath);
    writer.exec("update schema_migrations set checksum = null where version = '0002_more'");
    closeDb(writer);

    expect(assertCorpusMigrationsUpToDate(corpus, migrations)).toEqual({
      applied: ['0001_init', '0002_more'],
      unverifiable: ['0002_more'],
    });
  });

  it('refuses a database with no schema_migrations table at all', () => {
    const dir = tempDir();
    const migrations = join(dir, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, '0001_init.sql'), 'create table a (x integer);');

    const dbPath = join(dir, 'empty.db');
    const writer = openDb(dbPath);
    writer.exec('create table unrelated (x integer)');
    closeDb(writer);

    const corpus = openReadOnlyCorpus(dbPath);
    corpora.push(corpus);
    expect(() => assertCorpusMigrationsUpToDate(corpus, migrations)).toThrow(/npm run migrate/);
  });
});

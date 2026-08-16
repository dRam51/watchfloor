/**
 * §8.2: *"Isolation that still holds: separate process, separate credential,
 * separate DB user (read-only role). The bot gets no write path."*
 *
 * SQLite has no concept of a database user, so "read-only role" has to be made
 * structural some other way. This file is the proof that it is, and the first
 * suite in it is the one that decided the design: **`SQLITE_OPEN_READONLY`
 * alone is not enough.** It refuses every DML and DDL statement, and then
 * cheerfully executes `VACUUM INTO`, which writes a complete copy of the
 * corpus to a path of the caller's choosing. Measured, not assumed — see
 * "the write that a read-only connection actually performs" below.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import {
  assertReadOnlySql,
  openReadOnlyCorpus,
  SqlRefusedError,
  type ReadOnlyCorpus,
} from '../../src/mcp/readonly.ts';

const openHandles: Db[] = [];
const openCorpora: ReadOnlyCorpus[] = [];

afterEach(() => {
  while (openHandles.length) closeDb(openHandles.pop()!);
  while (openCorpora.length) openCorpora.pop()!.close();
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wf-mcp-'));
}

/** A real temp-file database with the two columns this milestone argues about. */
function seededCorpus(): string {
  const dir = tempDir();
  const path = join(dir, 'corpus.db');
  const writer = openDb(path);
  writer.exec(`
    create table items (item_key text primary key, title text not null);
    create table item_scores (
      item_key     text not null,
      beat         text not null,
      signal_score real not null,
      read_score   real not null
    );
    insert into items values ('aaa', 'CISA adds a KEV entry');
    insert into item_scores values ('aaa', 'cyber', 4.5, 9.25);
  `);
  closeDb(writer);
  return path;
}

describe('the read-only connection itself', () => {
  it('refuses every ordinary write', () => {
    const path = seededCorpus();
    const db = openDb(path, { readOnly: true });
    openHandles.push(db);

    const writes = [
      "insert into items values ('bbb', 'x')",
      "update items set title = 'x'",
      'delete from items',
      'create table injected (a int)',
      'drop table items',
      'pragma user_version = 9',
    ];
    for (const sql of writes) {
      expect(() => db.exec(sql), sql).toThrow(/readonly database/);
    }
  });

  // -------------------------------------------------------------------------
  // The write that a read-only connection ACTUALLY PERFORMS.
  // -------------------------------------------------------------------------
  // This is why `openReadOnlyCorpus` is a wrapper rather than a bare call to
  // openDb(path, { readOnly: true }). SQLITE_OPEN_READONLY protects the OPEN
  // FILE. It says nothing about creating a NEW one, and `VACUUM INTO` does
  // exactly that: a full, readable copy of the corpus at an arbitrary path.
  //
  // For §8.2 that is the whole game — the isolation claim is not "the bot
  // cannot corrupt the dashboard's database", it is "the bot gets no write
  // path". A statement that exfiltrates 46 MB of corpus to disk is a write
  // path, and it survives the flag that is supposed to close them all.
  it('performs a real disk write via VACUUM INTO — the gap the wrapper exists to close', () => {
    const path = seededCorpus();
    const escapeHatch = join(tempDir(), 'exfiltrated.db');
    const db = openDb(path, { readOnly: true });
    openHandles.push(db);

    expect(() => db.exec(`vacuum into '${escapeHatch}'`)).not.toThrow();
    expect(existsSync(escapeHatch)).toBe(true);

    // And it is not an empty husk: the copy holds the corpus.
    const copy = openDb(escapeHatch, { readOnly: true });
    openHandles.push(copy);
    expect(copy.prepare('select title from items').all()).toEqual([{ title: 'CISA adds a KEV entry' }]);
  });
});

describe('assertReadOnlySql', () => {
  it('accepts a plain select and a common table expression', () => {
    expect(() => assertReadOnlySql('select item_key from items where beat = ?')).not.toThrow();
    expect(() =>
      assertReadOnlySql('with recent as (select item_key from items) select item_key from recent'),
    ).not.toThrow();
  });

  it.each([
    ["insert into items values ('x','y')", 'not_a_select'],
    ["update items set title = 'x'", 'not_a_select'],
    ['delete from items', 'not_a_select'],
    ['drop table items', 'not_a_select'],
    ['create table t (a int)', 'not_a_select'],
    ['alter table items add column c text', 'not_a_select'],
    ["replace into items values ('x','y')", 'not_a_select'],
    ['pragma journal_mode = delete', 'not_a_select'],
    ["attach database 'other.db' as other", 'not_a_select'],
    ['vacuum', 'not_a_select'],
    ["vacuum into '/tmp/exfiltrated.db'", 'not_a_select'],
    ['begin transaction', 'not_a_select'],
  ] as const)('refuses %s', (sql, reason) => {
    expect(() => assertReadOnlySql(sql)).toThrow(SqlRefusedError);
    try {
      assertReadOnlySql(sql);
    } catch (err) {
      expect((err as SqlRefusedError).reason).toBe(reason);
    }
  });

  it('refuses a second statement smuggled after a select', () => {
    // node:sqlite's `prepare` compiles only the first statement, but `exec`
    // runs them all -- and a future transport that reaches for `exec` should
    // not be the thing that discovers this.
    expect(() => assertReadOnlySql("select 1; insert into items values ('x','y')")).toThrow(
      /multiple_statements/,
    );
  });

  it('allows a trailing semicolon, which is not a second statement', () => {
    expect(() => assertReadOnlySql('select item_key from items;')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// read_score, at the DATA plane
// ---------------------------------------------------------------------------
// §8.2: *"The bot sees `signal_score` only — never `read_score`."* The wire
// guard (src/mcp/serialize.ts) is the second layer. This is the first: the
// column is not reachable through the bot's database handle at all, so the
// value never enters the process in the first place. That is as close to a
// column-level GRANT as SQLite gets.
describe('assertReadOnlySql and the forbidden columns', () => {
  it('refuses a select that names read_score', () => {
    expect(() => assertReadOnlySql('select read_score from item_scores')).toThrow(
      /forbidden_identifier/,
    );
  });

  it('refuses read_score aliased into an innocent-looking name', () => {
    expect(() => assertReadOnlySql('select read_score as signal_score from item_scores')).toThrow(
      /forbidden_identifier/,
    );
  });

  it('refuses read_score in a where clause, not just the result columns', () => {
    expect(() => assertReadOnlySql('select item_key from item_scores where read_score > 1')).toThrow(
      /forbidden_identifier/,
    );
  });

  it('still allows signal_score', () => {
    expect(() => assertReadOnlySql('select signal_score from item_scores')).not.toThrow();
  });

  it('refuses `select *`, because a star expands to read_score without naming it', () => {
    expect(() => assertReadOnlySql('select * from item_scores')).toThrow(/star_result_column/);
    expect(() => assertReadOnlySql('select s.* from item_scores s')).toThrow(/star_result_column/);
  });

  it('still allows count(*), which expands to nothing', () => {
    expect(() => assertReadOnlySql('select count(*) from item_scores')).not.toThrow();
    expect(() => assertReadOnlySql('select count( * ) from item_scores')).not.toThrow();
  });

  it('does not mistake multiplication for a star result column', () => {
    expect(() => assertReadOnlySql('select signal_score * 2 from item_scores')).not.toThrow();
  });

  it('is not fooled by a comment hiding the forbidden column', () => {
    expect(() => assertReadOnlySql('select /* read_score */ signal_score from item_scores')).toThrow(
      /forbidden_identifier/,
    );
  });
});

describe('openReadOnlyCorpus', () => {
  it('reads', () => {
    const corpus = openReadOnlyCorpus(seededCorpus());
    openCorpora.push(corpus);
    expect(corpus.all('select item_key, title from items')).toEqual([
      { item_key: 'aaa', title: 'CISA adds a KEV entry' },
    ]);
    expect(corpus.get('select signal_score from item_scores where item_key = ?', 'aaa')).toEqual({
      signal_score: 4.5,
    });
  });

  it('returns undefined from get when nothing matches', () => {
    const corpus = openReadOnlyCorpus(seededCorpus());
    openCorpora.push(corpus);
    expect(corpus.get('select title from items where item_key = ?', 'nope')).toBeUndefined();
  });

  it('refuses VACUUM INTO — the hole the raw connection leaves open', () => {
    const corpus = openReadOnlyCorpus(seededCorpus());
    openCorpora.push(corpus);
    const escapeHatch = join(tempDir(), 'exfiltrated.db');

    expect(() => corpus.all(`vacuum into '${escapeHatch}'`)).toThrow(SqlRefusedError);
    expect(existsSync(escapeHatch)).toBe(false);
  });

  it('refuses read_score even though the column is right there', () => {
    const corpus = openReadOnlyCorpus(seededCorpus());
    openCorpora.push(corpus);
    expect(() => corpus.all('select read_score from item_scores')).toThrow(/forbidden_identifier/);
  });

  // The handle is held in a closure, not on a field. A caller that reaches
  // for `(corpus as any).db` to route around the wrapper finds nothing --
  // "the wrapper is the only door" is a fact about the object, not a rule in
  // a comment.
  it('exposes no database handle and no write method', () => {
    const corpus = openReadOnlyCorpus(seededCorpus());
    openCorpora.push(corpus);
    const surface = corpus as unknown as Record<string, unknown>;
    for (const escape of ['db', 'database', 'handle', 'exec', 'prepare', 'run', 'loadExtension']) {
      expect(surface[escape], escape).toBeUndefined();
    }
    expect(Object.keys(corpus).sort()).toEqual(['all', 'close', 'get', 'path']);
  });
});

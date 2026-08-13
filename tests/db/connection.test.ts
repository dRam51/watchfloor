import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';

const open: Array<ReturnType<typeof openDb>> = [];
function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db');
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

describe('openDb', () => {
  it('enables WAL so the API and scheduler can share the file', () => {
    const db = openDb(tempDbPath());
    open.push(db);
    const row = db.prepare('pragma journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
  });

  it('sets a busy timeout so concurrent writers wait instead of failing', () => {
    const db = openDb(tempDbPath());
    open.push(db);
    const row = db.prepare('pragma busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBeGreaterThanOrEqual(5000);
  });

  it('enforces foreign keys', () => {
    const db = openDb(tempDbPath());
    open.push(db);
    const row = db.prepare('pragma foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it('opens read-only connections that reject writes', () => {
    const path = tempDbPath();
    const writer = openDb(path);
    writer.exec('create table t (a integer)');
    closeDb(writer);

    const reader = openDb(path, { readOnly: true });
    open.push(reader);
    expect(reader.prepare('select count(*) as c from t').get()).toEqual({ c: 0 });
    expect(() => reader.exec('insert into t values (1)')).toThrow();
  });

  // recursive_triggers governs whether the implicit DELETE that SQLite runs to
  // resolve an INSERT OR REPLACE primary-key conflict fires BEFORE DELETE
  // triggers. It defaults OFF, which is what let INSERT OR REPLACE silently
  // destroy prior versions of append-only rows (see tests/db/migrate.test.ts,
  // "0001_init append-only triggers"). Asserted directly here, at the pragma
  // level, because that behavioral test only proves the symptom is gone --
  // this proves *why*.
  it('enables recursive_triggers so the implicit delete inside INSERT OR REPLACE cannot bypass BEFORE DELETE triggers', () => {
    const db = openDb(tempDbPath());
    open.push(db);
    const row = db.prepare('pragma recursive_triggers').get() as { recursive_triggers: number };
    expect(row.recursive_triggers).toBe(1);
  });

  // Unlike journal_mode, recursive_triggers is a connection-level flag, not a
  // file-header setting -- it resets to SQLite's default on every new
  // connection and costs nothing to set on a reader. A read-only connection
  // can never itself run INSERT OR REPLACE (writes are rejected outright,
  // above), but leaving its pragma state inconsistent with the writer's would
  // be a latent surprise for any future code that inspects or relies on it.
  it('enables recursive_triggers on read-only connections too, even though journal_mode is skipped for them', () => {
    const path = tempDbPath();
    const writer = openDb(path);
    closeDb(writer);

    const reader = openDb(path, { readOnly: true });
    open.push(reader);
    const row = reader.prepare('pragma recursive_triggers').get() as { recursive_triggers: number };
    expect(row.recursive_triggers).toBe(1);
  });
});

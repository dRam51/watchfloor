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
});

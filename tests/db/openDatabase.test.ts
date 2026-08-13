import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../src/db/connection.ts';
import { openDatabase, DatabaseOpenError } from '../../src/db/openDatabase.ts';

const open: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

describe('openDatabase', () => {
  it('creates a missing parent directory on a clean checkout and opens successfully', () => {
    const root = mkdtempSync(join(tmpdir(), 'wf-test-'));
    const dbPath = join(root, 'nested', 'sub', 'wf.db');
    expect(existsSync(join(root, 'nested'))).toBe(false);

    const db = openDatabase(dbPath);
    open.push(db);

    expect(existsSync(join(root, 'nested', 'sub'))).toBe(true);
    expect(db.prepare('select 1 as ok').get()).toEqual({ ok: 1 });
  });

  it('rethrows a genuinely unopenable path as a DatabaseOpenError naming the resolved path', () => {
    // A path that is itself an existing directory can never be a valid
    // SQLite file, and its parent already exists too — so the mkdir line is
    // a no-op here. This is exactly the failure mode the mkdir fix does not
    // cover, and the one openDatabase must still surface loudly rather than
    // disappear into what looks like a healthy empty database.
    const dirAsDbPath = mkdtempSync(join(tmpdir(), 'wf-test-'));

    try {
      openDatabase(dirAsDbPath);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseOpenError);
      expect((e as DatabaseOpenError).message).toContain(dirAsDbPath);
      expect((e as DatabaseOpenError).cause).toBeDefined();
    }
  });
});

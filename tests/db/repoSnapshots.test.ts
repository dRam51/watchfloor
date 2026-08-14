import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { InvalidTimestampError } from '../../src/domain/item.ts';
import { localDay } from '../../src/db/repoSnapshots.ts';

const open: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

// Every test in this file pins its zone explicitly. Nothing here reads
// process.env.TZ or the host clock's zone -- that is the property under test
// as much as it is the test's own hygiene (CLAUDE.md: "TZ set explicitly in
// config and every schedule derived from it -- never read the system
// timezone"). The .env.example default is America/New_York; the tests use it
// plus zones on the other side of UTC so a UTC-only implementation fails.
const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

describe('localDay', () => {
  it('buckets an instant by the calendar date in the given zone, not UTC', () => {
    // 02:30 UTC on the 14th is 22:30 on the 13th in New York.
    expect(localDay('2026-08-14T02:30:00.000Z', NY)).toBe('2026-08-13');
  });

  it('rolls forward, not back, for a zone east of UTC', () => {
    // Same instant, opposite direction: 11:30 on the 14th in Tokyo. A naive
    // "subtract the offset" implementation that only ever moves the date
    // backwards passes the New York case and fails this one.
    expect(localDay('2026-08-14T02:30:00.000Z', TOKYO)).toBe('2026-08-14');
  });

  it('rejects a non-canonical instant rather than bucketing a guess', () => {
    // Date.parse would happily accept '2026-08-14' or '2026-08-14T02:30Z'
    // and silently produce a plausible day. Every other timestamp writer in
    // this project rejects rather than coerces (src/domain/item.ts); a
    // snapshot day derived from a coerced instant would land in the wrong
    // bucket with nothing to show for it.
    expect(() => localDay('2026-08-14', NY)).toThrow(InvalidTimestampError);
  });
});

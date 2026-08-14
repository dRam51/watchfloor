import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, getCurrentItem, deriveItemKey, RetentionHorizonError, type NewItem } from '../../src/domain/item.ts';
import { getItemFirstFetchedAt, getItemFirstFetchedAtAsOf } from '../../src/domain/itemFirstFetchedAt.ts';

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

// ---------------------------------------------------------------------------
// A real cisa-kev shape (attic/wf-m1-firstrun-2026-08-14.db: title
// "Microsoft Windows Remote Code Execution Vulnerability", published_at
// NULL, item_type 'event', beat 'cyber') -- cisa-kev is the source of 1,665
// of M1's 1,715 null-published_at items, and its JSON feed re-dumps its
// entire catalog on every poll that adds even one new CVE, so this is the
// exact shape that re-delivers unchanged entries as new `items` rows.
// ---------------------------------------------------------------------------
function kevItem(fetchedAt: string): NewItem {
  return {
    url: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2014-4148',
    canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2014-4148',
    title: 'Microsoft Windows Remote Code Execution Vulnerability',
    sourceId: 'cisa-kev',
    itemType: 'event',
    beats: ['cyber'],
    entities: [],
    publishedAt: null,
    fetchedAt,
    summaryRaw: null,
    rawJson: '{}',
  };
}

describe('getItemFirstFetchedAt', () => {
  it('returns the only version fetched_at for a single-version item', () => {
    const db = migratedDb();
    const v1 = insertItem(db, kevItem('2026-08-11T00:00:00.000Z'));
    expect(getItemFirstFetchedAt(db, v1.item_key)).toBe('2026-08-11T00:00:00.000Z');
  });

  // The core proof, using the real cisa-kev catalog re-dump shape: three
  // versions of the SAME item_key (a re-poll that changed nothing about
  // this particular entry, only re-delivered it because the feed's ETag
  // changed elsewhere in the catalog) must all resolve to the FIRST one's
  // fetched_at, not the last.
  it('resolves the EARLIEST fetched_at across repeated re-delivery of the same item_key, not the latest', () => {
    const db = migratedDb();
    const v1 = insertItem(db, kevItem('2026-03-14T03:47:10.404Z')); // first ingest
    insertItem(db, kevItem('2026-06-01T00:00:00.000Z')); // re-poll 1: unchanged entry, re-dumped anyway
    insertItem(db, kevItem('2026-08-14T03:47:10.404Z')); // re-poll 2: same

    expect(getItemFirstFetchedAt(db, v1.item_key)).toBe('2026-03-14T03:47:10.404Z');
    // Confirms it disagrees with the naive/obvious call on the same item_key
    // -- this is precisely the call site that must NOT be reached for.
    expect(getItemFirstFetchedAt(db, v1.item_key)).not.toBe(getCurrentItem(db, v1.item_key)?.fetchedAt);
  });

  it('is independent of insertion order -- driven by fetched_at VALUE, not row order', () => {
    const db = migratedDb();
    // Insert an EARLIER fetched_at value SECOND -- e.g. a slow/retried
    // request that lands after a later one. min() must still find it.
    const v1 = insertItem(db, kevItem('2026-08-01T00:00:00.000Z'));
    insertItem(db, kevItem('2026-06-01T00:00:00.000Z')); // earlier value, inserted later

    expect(getItemFirstFetchedAt(db, v1.item_key)).toBe('2026-06-01T00:00:00.000Z');
  });

  it('does not leak across different item_keys', () => {
    const db = migratedDb();
    const kev = insertItem(db, kevItem('2026-08-01T00:00:00.000Z'));
    const other = insertItem(
      db,
      { ...kevItem('2026-01-01T00:00:00.000Z'), url: 'https://example.test/other', canonicalUrl: 'https://example.test/other' },
    );

    expect(kev.item_key).not.toBe(other.item_key);
    expect(getItemFirstFetchedAt(db, kev.item_key)).toBe('2026-08-01T00:00:00.000Z');
    expect(getItemFirstFetchedAt(db, other.item_key)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null, not undefined or a throw, for an item_key that was never ingested', () => {
    const db = migratedDb();
    expect(getItemFirstFetchedAt(db, deriveItemKey('https://never-ingested.test/nothing'))).toBeNull();
  });
});

describe('getItemFirstFetchedAtAsOf', () => {
  it('matches the unbounded call when asOf is after every version', () => {
    const db = migratedDb();
    const v1 = insertItem(db, kevItem('2026-03-14T03:47:10.404Z'));
    insertItem(db, kevItem('2026-08-14T03:47:10.404Z'));

    expect(getItemFirstFetchedAtAsOf(db, v1.item_key, '2026-12-01T00:00:00.000Z')).toBe(
      '2026-03-14T03:47:10.404Z',
    );
  });

  it('still returns the first fetched_at when asOf lands between the first and a later re-delivery', () => {
    const db = migratedDb();
    const v1 = insertItem(db, kevItem('2026-03-14T00:00:00.000Z'));
    insertItem(db, kevItem('2026-08-14T00:00:00.000Z')); // re-delivery AFTER asOf below

    // asOf is after the first version but before the re-delivery -- the
    // first-seen fact is already established by that point and must not
    // change depending on what happens later.
    expect(getItemFirstFetchedAtAsOf(db, v1.item_key, '2026-06-01T00:00:00.000Z')).toBe(
      '2026-03-14T00:00:00.000Z',
    );
  });

  it('returns null when asOf predates the item entirely -- it had not been noticed yet', () => {
    const db = migratedDb();
    const v1 = insertItem(db, kevItem('2026-08-11T00:00:00.000Z'));
    expect(getItemFirstFetchedAtAsOf(db, v1.item_key, '2026-08-01T00:00:00.000Z')).toBeNull();
  });

  it('the null case is indistinguishable from an unknown item_key -- both mean "not yet seen as of asOf"', () => {
    const db = migratedDb();
    const v1 = insertItem(db, kevItem('2026-08-11T00:00:00.000Z'));
    const neverIngested = deriveItemKey('https://never-ingested.test/nothing');

    expect(getItemFirstFetchedAtAsOf(db, v1.item_key, '2026-08-01T00:00:00.000Z')).toBe(
      getItemFirstFetchedAtAsOf(db, neverIngested, '2026-08-01T00:00:00.000Z'),
    );
  });

  it('fails loudly past the retention horizon instead of returning thinned data (mirrors getItemAsOf)', () => {
    const db = migratedDb();
    const v1 = insertItem(db, kevItem('2026-08-11T00:00:00.000Z'));
    db.prepare(
      `insert into retention_horizon (id, oldest_intact_fetched_at, updated_at)
       values (1, '2026-06-01T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`,
    ).run();

    expect(() => getItemFirstFetchedAtAsOf(db, v1.item_key, '2026-05-01T00:00:00.000Z')).toThrow(
      RetentionHorizonError,
    );
  });

  it('does not throw when asOf lands exactly on the retention horizon (inclusive boundary)', () => {
    const db = migratedDb();
    const v1 = insertItem(db, kevItem('2026-06-01T00:00:00.000Z'));
    db.prepare(
      `insert into retention_horizon (id, oldest_intact_fetched_at, updated_at)
       values (1, '2026-06-01T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`,
    ).run();

    expect(() => getItemFirstFetchedAtAsOf(db, v1.item_key, '2026-06-01T00:00:00.000Z')).not.toThrow();
    expect(getItemFirstFetchedAtAsOf(db, v1.item_key, '2026-06-01T00:00:00.000Z')).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('rejects a non-canonical asOf', () => {
    const db = migratedDb();
    const v1 = insertItem(db, kevItem('2026-08-11T00:00:00.000Z'));
    expect(() => getItemFirstFetchedAtAsOf(db, v1.item_key, '2026-08-11')).toThrow();
  });
});

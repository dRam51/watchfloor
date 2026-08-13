import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import {
  insertItem,
  getCurrentItem,
  getItemAsOf,
  deriveItemKey,
  RetentionHorizonError,
  InvalidTimestampError,
  type NewItem,
  type Beat,
} from '../../src/domain/item.ts';

const open: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

function draft(overrides: Partial<NewItem> = {}): NewItem {
  return {
    url: 'https://example.test/a?utm_source=x',
    canonicalUrl: 'https://example.test/a',
    title: 'Original title',
    sourceId: 'src-1',
    itemType: 'event',
    beats: ['markets'],
    entities: ['NVDA'],
    publishedAt: '2026-08-10T12:00:00.000Z',
    fetchedAt: '2026-08-11T00:00:00.000Z',
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

describe('deriveItemKey', () => {
  it('is stable for the same canonical URL and differs across URLs', () => {
    expect(deriveItemKey('https://a.test/x')).toBe(deriveItemKey('https://a.test/x'));
    expect(deriveItemKey('https://a.test/x')).not.toBe(deriveItemKey('https://a.test/y'));
  });
});

describe('insertItem', () => {
  it('stores beats and entities and returns the stored item', () => {
    const db = migratedDb();
    const inputBeats: Beat[] = ['ai', 'markets'];
    const item = insertItem(db, draft({ beats: inputBeats }));
    expect(item.item_id).toBeTruthy();
    expect(item.beats.sort()).toEqual(['ai', 'markets']);
    expect(item.entities).toEqual(['NVDA']);

    // Prove persistence via a read-back — the returned Item alone is not
    // proof, since insertItem's return value is built from the caller's own
    // input and could in principle be echoed back unpersisted.
    const reloaded = getCurrentItem(db, item.item_key);
    expect(reloaded?.beats.sort()).toEqual(['ai', 'markets']);
    expect(reloaded?.entities).toEqual(['NVDA']);

    // The returned item must not alias the caller's own array.
    expect(item.beats).not.toBe(inputBeats);
  });

  it('creates a new version rather than mutating the old one', () => {
    const db = migratedDb();
    const v1 = insertItem(db, draft());
    const v2 = insertItem(db, draft({ title: 'Corrected title', fetchedAt: '2026-08-12T00:00:00.000Z' }));

    expect(v2.item_key).toBe(v1.item_key);
    expect(v2.item_id).not.toBe(v1.item_id);

    const rows = db.prepare('select count(*) as c from items').get() as { c: number };
    expect(rows.c).toBe(2);
    expect(getCurrentItem(db, v1.item_key)?.title).toBe('Corrected title');
  });
});

describe('getItemAsOf', () => {
  it('returns the version that was current at that instant, never a later one', () => {
    const db = migratedDb();
    const v1 = insertItem(db, draft({ fetchedAt: '2026-08-11T00:00:00.000Z' }));
    insertItem(db, draft({ title: 'Corrected title', fetchedAt: '2026-08-13T00:00:00.000Z' }));

    const asOf = getItemAsOf(db, v1.item_key, '2026-08-12T00:00:00.000Z');
    expect(asOf?.title).toBe('Original title');
  });

  it('returns null for an instant before the item was ever fetched', () => {
    const db = migratedDb();
    const v1 = insertItem(db, draft({ fetchedAt: '2026-08-11T00:00:00.000Z' }));
    expect(getItemAsOf(db, v1.item_key, '2026-08-01T00:00:00.000Z')).toBeNull();
  });

  it('fails loudly past the retention horizon instead of returning thinned data', () => {
    const db = migratedDb();
    const v1 = insertItem(db, draft({ fetchedAt: '2026-08-11T00:00:00.000Z' }));
    db.prepare(
      `insert into retention_horizon (id, oldest_intact_fetched_at, updated_at)
       values (1, '2026-06-01T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`,
    ).run();

    expect(() => getItemAsOf(db, v1.item_key, '2026-05-01T00:00:00.000Z')).toThrow(
      RetentionHorizonError,
    );
  });

  it('does not throw when asOf lands exactly on the retention horizon (inclusive boundary)', () => {
    const db = migratedDb();
    const v1 = insertItem(db, draft({ fetchedAt: '2026-06-01T00:00:00.000Z' }));
    db.prepare(
      `insert into retention_horizon (id, oldest_intact_fetched_at, updated_at)
       values (1, '2026-06-01T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`,
    ).run();

    // oldest_intact_fetched_at means that instant's data is still intact, so
    // asOf exactly equal to the horizon must still be answerable.
    expect(() => getItemAsOf(db, v1.item_key, '2026-06-01T00:00:00.000Z')).not.toThrow();
    expect(getItemAsOf(db, v1.item_key, '2026-06-01T00:00:00.000Z')?.fetchedAt).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('never returns a different item, even with overlapping fetched_at ranges', () => {
    const db = migratedDb();
    const itemA = insertItem(db, draft({ canonicalUrl: 'https://example.test/a', title: 'Item A' }));
    const itemB = insertItem(
      db,
      draft({
        canonicalUrl: 'https://example.test/b',
        title: 'Item B',
        fetchedAt: '2026-08-11T00:00:00.000Z',
      }),
    );

    expect(itemA.item_key).not.toBe(itemB.item_key);
    expect(getItemAsOf(db, itemA.item_key, '2026-08-12T00:00:00.000Z')?.title).toBe('Item A');
    expect(getItemAsOf(db, itemB.item_key, '2026-08-12T00:00:00.000Z')?.title).toBe('Item B');
  });
});

describe('tie-break ordering', () => {
  it('deterministically prefers the most recently inserted version when fetched_at ties', () => {
    const db = migratedDb();
    const tied = '2026-08-11T00:00:00.000Z';
    insertItem(db, draft({ title: 'first-inserted', fetchedAt: tied }));
    const v2 = insertItem(db, draft({ title: 'second-inserted', fetchedAt: tied }));

    expect(getCurrentItem(db, v2.item_key)?.title).toBe('second-inserted');
    expect(getItemAsOf(db, v2.item_key, tied)?.title).toBe('second-inserted');
  });
});

describe('timestamp validation', () => {
  it('rejects a fetchedAt missing milliseconds precision', () => {
    const db = migratedDb();
    expect(() => insertItem(db, draft({ fetchedAt: '2026-08-12T00:00:00Z' }))).toThrow(
      InvalidTimestampError,
    );
  });

  it('rejects a non-UTC-offset fetchedAt instead of risking lexicographic lookahead', () => {
    const db = migratedDb();
    expect(() => insertItem(db, draft({ fetchedAt: '2026-08-11T12:00:00-05:00' }))).toThrow(
      InvalidTimestampError,
    );
  });

  it('rejects a non-canonical publishedAt when it is non-null', () => {
    const db = migratedDb();
    expect(() => insertItem(db, draft({ publishedAt: '2026-08-10T12:00:00-05:00' }))).toThrow(
      InvalidTimestampError,
    );
  });

  it('rejects a second-precision retention horizon rather than mis-comparing against it', () => {
    const db = migratedDb();
    const v1 = insertItem(db, draft({ fetchedAt: '2026-08-11T00:00:00.000Z' }));
    // What strftime or `.slice(0, 19) + 'Z'` produces. Unvalidated, an asOf
    // exactly at the horizon compares as *before* it ('.' < 'Z'), so the one
    // instant the horizon promises is answerable throws instead.
    db.prepare(
      `insert into retention_horizon (id, oldest_intact_fetched_at, updated_at)
       values (1, '2026-08-11T00:00:00Z', '2026-08-12T00:00:00.000Z')`,
    ).run();

    expect(() => getItemAsOf(db, v1.item_key, '2026-08-11T00:00:00.000Z')).toThrow(
      InvalidTimestampError,
    );
  });

  it('rejects a non-UTC-offset retention horizon rather than silently thinning history', () => {
    const db = migratedDb();
    const v1 = insertItem(db, draft({ fetchedAt: '2026-08-11T00:00:00.000Z' }));
    // The worse half: '2026-08-11T00:00:00.000-05:00' is really 05:00Z, but
    // sorts *below* every 'T0...Z' value, so the horizon check passes and the
    // read returns data the horizon says is no longer intact — no error, no
    // signal, just quietly thinned history.
    db.prepare(
      `insert into retention_horizon (id, oldest_intact_fetched_at, updated_at)
       values (1, '2026-08-11T00:00:00.000-05:00', '2026-08-12T00:00:00.000Z')`,
    ).run();

    let threw: unknown;
    try {
      getItemAsOf(db, v1.item_key, '2026-08-11T00:00:00.000Z');
    } catch (e) {
      threw = e;
    }
    expect(threw, 'a malformed horizon must fail loudly, not return a row').toBeInstanceOf(
      InvalidTimestampError,
    );
  });

  it('rejects a non-canonical asOf, closing the lookahead leak at the read path', () => {
    const db = migratedDb();
    const v1 = insertItem(db, draft({ fetchedAt: '2026-08-12T00:00:00.500Z' }));
    // Before the fix, asking "as of the second" (no ms) compared
    // lexicographically and let this row — 500ms in the future — leak
    // through. Reject the malformed input outright instead of risking it.
    expect(() => getItemAsOf(db, v1.item_key, '2026-08-12T00:00:00Z')).toThrow(
      InvalidTimestampError,
    );
  });
});

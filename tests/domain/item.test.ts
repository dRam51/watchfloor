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
  type NewItem,
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
    const item = insertItem(db, draft({ beats: ['ai', 'markets'] }));
    expect(item.item_id).toBeTruthy();
    expect(item.beats.sort()).toEqual(['ai', 'markets']);
    expect(item.entities).toEqual(['NVDA']);
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
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type NewItem } from '../../src/domain/item.ts';
import {
  upsertLocation,
  listLocations,
  linkItemLocation,
  getItemLocations,
  type Location,
} from '../../src/domain/location.ts';

const open: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

const fab: Location = {
  locationId: 'tsmc-fab18',
  name: 'TSMC Fab 18',
  kind: 'fab',
  operator: 'TSMC',
  country: 'TW',
  lat: 23.1,
  lon: 120.28,
  notes: 'N3/N5 capacity',
  sourceUrl: 'https://example.test/fab18',
  verifiedAt: '2026-08-01',
};

const draft: NewItem = {
  url: 'https://example.test/a',
  canonicalUrl: 'https://example.test/a',
  title: 'T',
  sourceId: 's1',
  itemType: 'event',
  beats: ['markets'],
  entities: ['TSM'],
  publishedAt: null,
  fetchedAt: '2026-08-11T00:00:00.000Z',
  summaryRaw: null,
  rawJson: '{}',
};

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

describe('locations', () => {
  it('stores a location with mandatory provenance and re-reads it', () => {
    const db = migratedDb();
    upsertLocation(db, fab);
    const all = listLocations(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.sourceUrl).toBe('https://example.test/fab18');
    expect(all[0]?.verifiedAt).toBe('2026-08-01');
  });

  it('replaces an existing location on re-upsert rather than duplicating', () => {
    const db = migratedDb();
    upsertLocation(db, fab);
    upsertLocation(db, { ...fab, notes: 'updated', verifiedAt: '2026-08-12' });
    const all = listLocations(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.verifiedAt).toBe('2026-08-12');
  });

  it('links an item to a location with a confidence score', () => {
    const db = migratedDb();
    upsertLocation(db, fab);
    const item = insertItem(db, draft);
    linkItemLocation(db, item.item_id, fab.locationId, 0.92);

    const linked = getItemLocations(db, item.item_id);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.name).toBe('TSMC Fab 18');
    expect(linked[0]?.geoConfidence).toBeCloseTo(0.92);
  });

  it('rejects a link to a location that does not exist', () => {
    const db = migratedDb();
    const item = insertItem(db, draft);
    expect(() => linkItemLocation(db, item.item_id, 'nope', 0.5)).toThrow();
  });
});

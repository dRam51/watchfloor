import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, getCurrentItem, deriveItemKey, InvalidTimestampError, type NewItem } from '../../src/domain/item.ts';
import * as itemStateModule from '../../src/domain/itemState.ts';
import {
  getItemState,
  markItemRead,
  saveItem,
  unsaveItem,
  dismissItem,
  getDismissalSignals,
} from '../../src/domain/itemState.ts';

const open: Db[] = [];

function migratedDb(): { db: Db; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db');
  const db = openDb(path);
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return { db, path };
}

/** A second, independent connection to the same file -- see "persists across a
 * fresh connection" below for why this matters. */
function reopen(path: string): Db {
  const db = openDb(path);
  open.push(db);
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

// ---------------------------------------------------------------------------
// A real cisa-kev shape (attic/wf-m1-firstrun-2026-08-14.db), reused from
// tests/domain/itemFirstFetchedAt.test.ts -- cisa-kev's JSON feed re-dumps
// its entire catalog on every poll, making it the real-corpus source of
// unchanged-item re-delivery this file's re-delivery test targets.
// ---------------------------------------------------------------------------
function kevItem(overrides: Partial<NewItem> = {}): NewItem {
  return {
    url: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2014-4148',
    canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2014-4148',
    title: 'Microsoft Windows Remote Code Execution Vulnerability',
    sourceId: 'cisa-kev',
    itemType: 'event',
    beats: ['cyber'],
    entities: [],
    publishedAt: null,
    fetchedAt: '2026-08-11T00:00:00.000Z',
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

describe('getItemState', () => {
  it('returns null for an item_key that has never had its state touched', () => {
    const { db } = migratedDb();
    expect(getItemState(db, deriveItemKey('https://never-touched.test'))).toBeNull();
  });
});

describe('markItemRead', () => {
  it('sets read_at and updated_at, leaving saved_at/dismissed_at null', () => {
    const { db } = migratedDb();
    const state = markItemRead(db, 'item-1', '2026-08-14T00:00:00.000Z');
    expect(state).toEqual({
      itemKey: 'item-1',
      readAt: '2026-08-14T00:00:00.000Z',
      savedAt: null,
      dismissedAt: null,
      updatedAt: '2026-08-14T00:00:00.000Z',
    });
  });

  // The proof this file's "definition of done" item 5 asks for: mutation
  // through one connection must be visible from a completely independent
  // connection to the same file. A version of markItemRead that only
  // mutated an in-memory object (or wrote to the wrong table/column) would
  // pass a same-connection assertion but fail this one.
  it('persists across a fresh connection to the same database file', () => {
    const { db, path } = migratedDb();
    markItemRead(db, 'item-1', '2026-08-14T00:00:00.000Z');

    const reopened = reopen(path);
    expect(getItemState(reopened, 'item-1')?.readAt).toBe('2026-08-14T00:00:00.000Z');
  });

  it('does not re-stamp read_at on a later call -- read is "seen once", not "seen most recently"', () => {
    const { db } = migratedDb();
    markItemRead(db, 'item-1', '2026-08-14T00:00:00.000Z');
    const second = markItemRead(db, 'item-1', '2026-08-15T00:00:00.000Z');

    expect(second.readAt).toBe('2026-08-14T00:00:00.000Z');
    expect(getItemState(db, 'item-1')?.readAt).toBe('2026-08-14T00:00:00.000Z');
  });

  it('rejects a non-canonical now rather than silently coercing it', () => {
    const { db } = migratedDb();
    expect(() => markItemRead(db, 'item-1', '2026-08-14')).toThrow(InvalidTimestampError);
  });
});

describe('saveItem / unsaveItem', () => {
  it('sets saved_at, leaving read_at/dismissed_at untouched', () => {
    const { db } = migratedDb();
    markItemRead(db, 'item-1', '2026-08-14T00:00:00.000Z');
    const state = saveItem(db, 'item-1', '2026-08-14T01:00:00.000Z');

    expect(state.savedAt).toBe('2026-08-14T01:00:00.000Z');
    expect(state.readAt).toBe('2026-08-14T00:00:00.000Z');
    expect(state.dismissedAt).toBeNull();
  });

  it('persists across a fresh connection to the same database file', () => {
    const { db, path } = migratedDb();
    saveItem(db, 'item-1', '2026-08-14T00:00:00.000Z');

    const reopened = reopen(path);
    expect(getItemState(reopened, 'item-1')?.savedAt).toBe('2026-08-14T00:00:00.000Z');
  });

  it('un-save clears saved_at back to null, not to a separate "unsaved" marker', () => {
    const { db } = migratedDb();
    saveItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    const state = unsaveItem(db, 'item-1', '2026-08-14T02:00:00.000Z');

    expect(state?.savedAt).toBeNull();
    expect(getItemState(db, 'item-1')?.savedAt).toBeNull();
  });

  it('save is reversible: un-save then save again produces a fresh saved_at', () => {
    const { db } = migratedDb();
    saveItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    unsaveItem(db, 'item-1', '2026-08-14T01:00:00.000Z');
    const resaved = saveItem(db, 'item-1', '2026-08-14T02:00:00.000Z');

    expect(resaved.savedAt).toBe('2026-08-14T02:00:00.000Z');
  });

  it('un-save on an item_key with no row at all is a no-op that creates nothing', () => {
    const { db } = migratedDb();
    expect(unsaveItem(db, 'never-touched', '2026-08-14T00:00:00.000Z')).toBeNull();
    expect(getItemState(db, 'never-touched')).toBeNull();
  });

  it('rejects a non-canonical now on save and un-save', () => {
    const { db } = migratedDb();
    expect(() => saveItem(db, 'item-1', 'not-a-timestamp')).toThrow(InvalidTimestampError);
    expect(() => unsaveItem(db, 'item-1', 'not-a-timestamp')).toThrow(InvalidTimestampError);
  });
});

describe('dismissItem', () => {
  it('sets dismissed_at and updated_at', () => {
    const { db } = migratedDb();
    const state = dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    expect(state.dismissedAt).toBe('2026-08-14T00:00:00.000Z');
  });

  it('persists across a fresh connection to the same database file', () => {
    const { db, path } = migratedDb();
    dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');

    const reopened = reopen(path);
    expect(getItemState(reopened, 'item-1')?.dismissedAt).toBe('2026-08-14T00:00:00.000Z');
  });

  it('never comes back: a repeat dismiss call keeps the ORIGINAL dismissed_at, not the later one', () => {
    const { db } = migratedDb();
    dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    const second = dismissItem(db, 'item-1', '2026-08-20T00:00:00.000Z');

    expect(second.dismissedAt).toBe('2026-08-14T00:00:00.000Z');
    expect(getItemState(db, 'item-1')?.dismissedAt).toBe('2026-08-14T00:00:00.000Z');
  });

  it('there is no un-dismiss export -- dismissal has no reversal path in this module', () => {
    const exportNames = Object.keys(itemStateModule);
    expect(exportNames.some((name) => /undismiss/i.test(name))).toBe(false);
  });

  // The core re-delivery proof the task calls out explicitly: item_state is
  // keyed on item_key, not item_id, so it must survive a source re-dumping
  // the same item as a brand-new version row. cisa-kev does exactly this on
  // every poll that adds even one new CVE elsewhere in its catalog (see
  // itemFirstFetchedAt.test.ts and its doc comment for the real-corpus
  // evidence). Two versions, one item_key.
  it('stays dismissed across a source re-delivering the item as a new version (same item_key, two item_ids)', () => {
    const { db } = migratedDb();
    const v1 = insertItem(db, kevItem({ fetchedAt: '2026-03-14T00:00:00.000Z' }));

    dismissItem(db, v1.item_key, '2026-03-14T01:00:00.000Z');
    expect(getItemState(db, v1.item_key)?.dismissedAt).toBe('2026-03-14T01:00:00.000Z');

    // Re-poll: cisa-kev re-dumps its whole catalog, including this
    // unchanged entry -- a brand-new items row, same item_key.
    const v2 = insertItem(db, kevItem({ fetchedAt: '2026-08-14T00:00:00.000Z' }));

    expect(v2.item_key).toBe(v1.item_key);
    expect(v2.item_id).not.toBe(v1.item_id);
    expect(getCurrentItem(db, v1.item_key)?.item_id).toBe(v2.item_id); // the version pointer moved on...

    // ...but the dismissal, keyed on item_key, did not move with it.
    expect(getItemState(db, v1.item_key)?.dismissedAt).toBe('2026-03-14T01:00:00.000Z');
  });

  it('rejects a non-canonical now', () => {
    const { db } = migratedDb();
    expect(() => dismissItem(db, 'item-1', '14 Aug 2026')).toThrow(InvalidTimestampError);
  });
});

describe('dismissal as a logged negative interest signal', () => {
  it('writes one signal row on the genuine transition to dismissed', () => {
    const { db } = migratedDb();
    dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');

    expect(getDismissalSignals(db, 'item-1')).toEqual([
      { itemKey: 'item-1', dismissedAt: '2026-08-14T00:00:00.000Z' },
    ]);
  });

  it('persists the signal across a fresh connection to the same database file', () => {
    const { db, path } = migratedDb();
    dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');

    const reopened = reopen(path);
    expect(getDismissalSignals(reopened, 'item-1')).toHaveLength(1);
  });

  it('does not write a second signal row for a repeat dismiss on an already-dismissed item', () => {
    const { db } = migratedDb();
    dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    dismissItem(db, 'item-1', '2026-08-20T00:00:00.000Z');
    dismissItem(db, 'item-1', '2026-08-21T00:00:00.000Z');

    expect(getDismissalSignals(db, 'item-1')).toHaveLength(1);
  });

  it('logs independently per item_key', () => {
    const { db } = migratedDb();
    dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    dismissItem(db, 'item-2', '2026-08-14T00:00:01.000Z');

    expect(getDismissalSignals(db, 'item-1')).toEqual([
      { itemKey: 'item-1', dismissedAt: '2026-08-14T00:00:00.000Z' },
    ]);
    expect(getDismissalSignals(db, 'item-2')).toEqual([
      { itemKey: 'item-2', dismissedAt: '2026-08-14T00:00:01.000Z' },
    ]);
  });

  it('the log is append-only: direct UPDATE and DELETE are rejected', () => {
    const { db } = migratedDb();
    dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');

    expect(() => db.exec("update interest_dismissal_signals set dismissed_at = '2099-01-01T00:00:00.000Z'")).toThrow();
    expect(() => db.exec('delete from interest_dismissal_signals')).toThrow();
  });

  // The precise instruction from the task brief: "log it; don't auto-tune
  // the weights." This proves it operationally rather than by inspection --
  // config/interests.yaml's bytes on disk must be bit-for-bit identical
  // before and after a batch of dismissals, and item_state's own migration
  // (0001_init.sql) is untouched by this task, so there is no weight column
  // anywhere in this table's reach either.
  it('never touches config/interests.yaml -- proof, not assertion by inspection', () => {
    const { db } = migratedDb();
    const configPath = join(process.cwd(), 'config', 'interests.yaml');
    const before = readFileSync(configPath);

    dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    dismissItem(db, 'item-2', '2026-08-14T00:00:01.000Z');
    dismissItem(db, 'item-1', '2026-08-15T00:00:00.000Z'); // repeat, still must not touch it

    const after = readFileSync(configPath);
    expect(after.equals(before)).toBe(true);
  });
});

describe('legal flag combinations', () => {
  it('an item can be both saved and dismissed at once -- dismissing a saved item keeps it saved', () => {
    const { db } = migratedDb();
    saveItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    const state = dismissItem(db, 'item-1', '2026-08-14T01:00:00.000Z');

    expect(state.savedAt).toBe('2026-08-14T00:00:00.000Z');
    expect(state.dismissedAt).toBe('2026-08-14T01:00:00.000Z');
  });

  it('saving a dismissed item is allowed and does not un-dismiss it', () => {
    const { db } = migratedDb();
    dismissItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    const state = saveItem(db, 'item-1', '2026-08-14T01:00:00.000Z');

    expect(state.savedAt).toBe('2026-08-14T01:00:00.000Z');
    expect(state.dismissedAt).toBe('2026-08-14T00:00:00.000Z');
  });

  it('an item can be both read and dismissed at once', () => {
    const { db } = migratedDb();
    markItemRead(db, 'item-1', '2026-08-14T00:00:00.000Z');
    const state = dismissItem(db, 'item-1', '2026-08-14T01:00:00.000Z');

    expect(state.readAt).toBe('2026-08-14T00:00:00.000Z');
    expect(state.dismissedAt).toBe('2026-08-14T01:00:00.000Z');
  });

  it('all three flags can be set simultaneously', () => {
    const { db } = migratedDb();
    markItemRead(db, 'item-1', '2026-08-14T00:00:00.000Z');
    saveItem(db, 'item-1', '2026-08-14T01:00:00.000Z');
    const state = dismissItem(db, 'item-1', '2026-08-14T02:00:00.000Z');

    expect(state).toEqual({
      itemKey: 'item-1',
      readAt: '2026-08-14T00:00:00.000Z',
      savedAt: '2026-08-14T01:00:00.000Z',
      dismissedAt: '2026-08-14T02:00:00.000Z',
      updatedAt: '2026-08-14T02:00:00.000Z',
    });
  });

  it('un-saving a dismissed item keeps it dismissed', () => {
    const { db } = migratedDb();
    saveItem(db, 'item-1', '2026-08-14T00:00:00.000Z');
    dismissItem(db, 'item-1', '2026-08-14T01:00:00.000Z');
    const state = unsaveItem(db, 'item-1', '2026-08-14T02:00:00.000Z');

    expect(state?.savedAt).toBeNull();
    expect(state?.dismissedAt).toBe('2026-08-14T01:00:00.000Z');
  });
});

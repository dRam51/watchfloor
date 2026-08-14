import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, getCurrentItem, deriveItemKey, type NewItem } from '../../src/domain/item.ts';
import { getItemBeats } from '../../src/domain/itemBeats.ts';

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
// Real fixtures, copied by hand from attic/wf-m1-firstrun-2026-08-14.db -- the
// actual first live ingest (read-only; never opened by this test). Query used
// to find the collisions:
//
//   sqlite3 -readonly attic/wf-m1-firstrun-2026-08-14.db \
//     "select item_key, group_concat(distinct source_id), count(*) from items
//      group by item_key having count(*) > 1"
//
// returns exactly 18 rows, every one an arxiv-cs-ai / arxiv-cs-cr pair
// sharing one canonical_url. ARXIV_A below is one of those 18, reproduced
// verbatim: title, canonical_url, author, item_type, published_at, the
// per-source beat, and the shared fetched_at that puts item.ts's
// `order by fetched_at desc, rowid desc` tie-break in play -- exactly what
// happened on the real ingest (rowid 1721 = cs.CR, rowid 1864 = cs.AI, same
// fetched_at instant).
// ---------------------------------------------------------------------------

const ARXIV_A_URL = 'https://arxiv.org/abs/2608.11274';
const ARXIV_A_TITLE = 'Agent Safety Should Be a Runtime Contract';
const ARXIV_A_AUTHOR = 'Albus W. Ng, Yi Han, Jusheng Zhang, Wenhao Wang';
const ARXIV_A_PUBLISHED_AT = '2026-08-13T04:00:00.000Z';
const ARXIV_A_FETCHED_AT = '2026-08-14T03:47:10.404Z';

// cs.CR's version landed first (lower rowid in the real ingest) and carries
// the paper's cybersecurity-beat attribution.
function arxivACrVersion(): NewItem {
  return {
    url: ARXIV_A_URL,
    canonicalUrl: ARXIV_A_URL,
    title: ARXIV_A_TITLE,
    author: ARXIV_A_AUTHOR,
    sourceId: 'arxiv-cs-cr',
    itemType: 'press',
    beats: ['aisec'],
    entities: [],
    publishedAt: ARXIV_A_PUBLISHED_AT,
    fetchedAt: ARXIV_A_FETCHED_AT,
    summaryRaw: null,
    rawJson: '{}',
  };
}

// cs.AI's version landed second (higher rowid, identical fetched_at instant)
// and is therefore the version `getCurrentItem` picks -- carrying only the AI
// beat.
function arxivAAiVersion(): NewItem {
  return { ...arxivACrVersion(), sourceId: 'arxiv-cs-ai', beats: ['ai'] };
}

// A real, single-version, non-colliding item from the same first-run
// database, used as a control in later tests: a CISA KEV catalog entry.
function cisaKevControl(): NewItem {
  return {
    url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2014-4148',
    canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2014-4148',
    title: 'Microsoft Windows Remote Code Execution Vulnerability',
    sourceId: 'cisa-kev',
    itemType: 'event',
    beats: ['cyber'],
    entities: [],
    publishedAt: null,
    fetchedAt: ARXIV_A_FETCHED_AT,
    summaryRaw: null,
    rawJson: '{}',
  };
}

describe('the defect getItemBeats exists to fix (src/domain/item.ts unmodified)', () => {
  it('item_beats storage holds both facts correctly -- this is not a storage bug', () => {
    const db = migratedDb();
    const cr = insertItem(db, arxivACrVersion());
    const ai = insertItem(db, arxivAAiVersion());

    const rows = db
      .prepare('select item_id, beat from item_beats order by beat')
      .all() as Array<{ item_id: string; beat: string }>;
    expect(rows).toEqual([
      { item_id: ai.item_id, beat: 'ai' },
      { item_id: cr.item_id, beat: 'aisec' },
    ]);
  });

  it('getCurrentItem nonetheless surfaces only the tie-break winner\'s beat, silently dropping the other', () => {
    const db = migratedDb();
    const cr = insertItem(db, arxivACrVersion());
    const ai = insertItem(db, arxivAAiVersion());

    // Genuinely the same paper: one item_key, two source-specific versions.
    expect(ai.item_key).toBe(cr.item_key);
    expect(ai.item_id).not.toBe(cr.item_id);

    // fetched_at ties, so rowid desc breaks the tie -- cs.AI was inserted
    // second, so cs.AI wins, and its beats ('ai') are the only ones this read
    // returns. The paper is genuinely also 'aisec' (proved above); that fact
    // is lost. This is the exact defect src/domain/itemBeats.ts fixes.
    const current = getCurrentItem(db, cr.item_key);
    expect(current?.beats).toEqual(['ai']);
  });
});

describe('getItemBeats', () => {
  it('unions beats across every version sharing item_key -- real arXiv cs.AI / cs.CR cross-listing', () => {
    const db = migratedDb();
    const cr = insertItem(db, arxivACrVersion());
    const ai = insertItem(db, arxivAAiVersion());

    // Both real beats come back, regardless of which version the
    // fetched_at/rowid tie-break would have picked as "current".
    expect(getItemBeats(db, cr.item_key).sort()).toEqual(['ai', 'aisec']);
    expect(getItemBeats(db, ai.item_key).sort()).toEqual(['ai', 'aisec']);
  });

  it('does not leak beats across different item_keys', () => {
    const db = migratedDb();
    const arxiv = insertItem(db, arxivACrVersion());
    insertItem(db, arxivAAiVersion());
    const cisa = insertItem(db, cisaKevControl());

    expect(arxiv.item_key).not.toBe(cisa.item_key);
    expect(getItemBeats(db, arxiv.item_key).sort()).toEqual(['ai', 'aisec']);
    expect(getItemBeats(db, cisa.item_key)).toEqual(['cyber']);
  });

  it('returns the same shape -- a plain array, no special case -- for an item with only one version', () => {
    const db = migratedDb();
    const cisa = insertItem(db, cisaKevControl());

    expect(getItemBeats(db, cisa.item_key)).toEqual(['cyber']);
  });

  it('returns an empty array, not null or a thrown error, for an item_key that was never ingested', () => {
    const db = migratedDb();
    expect(getItemBeats(db, deriveItemKey('https://never-ingested.test/nothing'))).toEqual([]);
  });

  it('deduplicates when two versions of the same item attribute the identical beat (e.g. a routine re-poll)', () => {
    const db = migratedDb();
    const v1 = insertItem(db, cisaKevControl());
    insertItem(db, { ...cisaKevControl(), fetchedAt: '2026-08-14T04:00:00.000Z' });

    expect(getItemBeats(db, v1.item_key)).toEqual(['cyber']);
  });
});

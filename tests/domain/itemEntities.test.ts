import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, getCurrentItem, deriveItemKey, type NewItem } from '../../src/domain/item.ts';
import { getItemEntities } from '../../src/domain/itemEntities.ts';

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
// Fixtures: REAL items, SYNTHETIC entities. The distinction matters.
//
// The items are the same real cross-listing tests/domain/itemBeats.test.ts
// uses, copied by hand from attic/wf-m1-firstrun-2026-08-14.db -- the actual
// first live ingest (read-only; never opened by this test). That collision is
// real: the query
//
//   sqlite3 -readonly attic/wf-m1-firstrun-2026-08-14.db \
//     "select item_key, group_concat(distinct source_id), count(*) from items
//      group by item_key having count(*) > 1"
//
// returns exactly 18 rows, every one an arxiv-cs-ai / arxiv-cs-cr pair sharing
// one canonical_url. ARXIV_A is one of the 18, reproduced verbatim down to the
// shared fetched_at that puts item.ts's `order by fetched_at desc, rowid desc`
// tie-break in play (rowid 1721 = cs.CR, rowid 1864 = cs.AI, same instant).
//
// The ENTITY values below are invented, and deliberately so: `select count(*)
// from item_entities` against that same database returns 0. M1 populates beats
// (3,325 rows) but no entity extractor exists yet, so there is no real entity
// data to mine and none can be manufactured honestly. What is being pinned here
// is the *structural* defect -- item_entities is (item_id, entity) with primary
// key (item_id, entity), byte-for-byte the shape of item_beats, and hydrate()
// in src/domain/item.ts reads it from a single item_id exactly the way it read
// beats -- so the shadowing follows from the schema regardless of which strings
// occupy the entity column. When a real extractor lands, these fixtures should
// be replaced with mined values; until then the labels above are the honest
// account of what this file does and does not prove.
//
// The values are at least shaped like real extractions rather than 'foo'/'bar':
// ARXIV_SHARED_ENTITY is a genuine author of the genuine paper, and the CISA
// control's three entities are all derivable from its real title and real CVE.
// ---------------------------------------------------------------------------

const ARXIV_A_URL = 'https://arxiv.org/abs/2608.11274';
const ARXIV_A_TITLE = 'Agent Safety Should Be a Runtime Contract';
const ARXIV_A_AUTHOR = 'Albus W. Ng, Yi Han, Jusheng Zhang, Wenhao Wang';
const ARXIV_A_PUBLISHED_AT = '2026-08-13T04:00:00.000Z';
const ARXIV_A_FETCHED_AT = '2026-08-14T03:47:10.404Z';

// Synthetic. An entity both source versions would plausibly extract from the
// shared byline -- it exists to prove the union deduplicates rather than
// concatenates, which is the failure a `union all` would produce.
const ARXIV_SHARED_ENTITY = 'Wenhao Wang';
// Synthetic. Version-specific entities: the point is only that they differ per
// item_id, which is what makes shadowing observable.
const ARXIV_CR_ONLY_ENTITY = 'Model Context Protocol';
const ARXIV_AI_ONLY_ENTITY = 'Anthropic';

// cs.CR's version landed first (lower rowid in the real ingest).
function arxivACrVersion(): NewItem {
  return {
    url: ARXIV_A_URL,
    canonicalUrl: ARXIV_A_URL,
    title: ARXIV_A_TITLE,
    author: ARXIV_A_AUTHOR,
    sourceId: 'arxiv-cs-cr',
    itemType: 'press',
    beats: ['aisec'],
    entities: [ARXIV_SHARED_ENTITY, ARXIV_CR_ONLY_ENTITY],
    publishedAt: ARXIV_A_PUBLISHED_AT,
    fetchedAt: ARXIV_A_FETCHED_AT,
    summaryRaw: null,
    rawJson: '{}',
  };
}

// cs.AI's version landed second (higher rowid, identical fetched_at instant)
// and is therefore the version `getCurrentItem` picks.
function arxivAAiVersion(): NewItem {
  return {
    ...arxivACrVersion(),
    sourceId: 'arxiv-cs-ai',
    beats: ['ai'],
    entities: [ARXIV_SHARED_ENTITY, ARXIV_AI_ONLY_ENTITY],
  };
}

// A real, single-version, non-colliding item from the same first-run database,
// used as a control. Its entities are synthetic like the rest, but every one of
// them falls out of the real title and real CVE id.
function cisaKevControl(): NewItem {
  return {
    url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2014-4148',
    canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2014-4148',
    title: 'Microsoft Windows Remote Code Execution Vulnerability',
    sourceId: 'cisa-kev',
    itemType: 'event',
    beats: ['cyber'],
    entities: ['CVE-2014-4148', 'Microsoft', 'Windows'],
    publishedAt: null,
    fetchedAt: ARXIV_A_FETCHED_AT,
    summaryRaw: null,
    rawJson: '{}',
  };
}

describe('the defect getItemEntities exists to fix (src/domain/item.ts unmodified)', () => {
  it('item_entities storage holds both versions\' facts correctly -- this is not a storage bug', () => {
    const db = migratedDb();
    const cr = insertItem(db, arxivACrVersion());
    const ai = insertItem(db, arxivAAiVersion());

    const rows = db
      .prepare('select item_id, entity from item_entities order by entity, item_id')
      .all() as Array<{ item_id: string; entity: string }>;
    expect(rows).toEqual([
      { item_id: ai.item_id, entity: ARXIV_AI_ONLY_ENTITY },
      { item_id: cr.item_id, entity: ARXIV_CR_ONLY_ENTITY },
      // The shared entity is stored twice, once per item_id -- correct, since
      // the primary key is (item_id, entity) and these are two different rows.
      // It is the READ that has to collapse them.
      ...[ai.item_id, cr.item_id].sort().map((item_id) => ({ item_id, entity: ARXIV_SHARED_ENTITY })),
    ]);
  });

  it('getCurrentItem nonetheless surfaces only the tie-break winner\'s entities, silently dropping the other version\'s', () => {
    const db = migratedDb();
    const cr = insertItem(db, arxivACrVersion());
    const ai = insertItem(db, arxivAAiVersion());

    // Genuinely the same paper: one item_key, two source-specific versions.
    expect(ai.item_key).toBe(cr.item_key);
    expect(ai.item_id).not.toBe(cr.item_id);

    // fetched_at ties, so rowid desc breaks the tie -- cs.AI was inserted
    // second, so cs.AI wins and hydrate() returns only its entities. The
    // cs.CR version's entity is genuinely attributed to this item (proved
    // above) and is lost. Identical in mechanism to the beat shadowing
    // src/domain/itemBeats.ts fixes; this is the entity half of it.
    const current = getCurrentItem(db, cr.item_key);
    expect(current?.entities.slice().sort()).toEqual([ARXIV_AI_ONLY_ENTITY, ARXIV_SHARED_ENTITY].sort());
    expect(current?.entities).not.toContain(ARXIV_CR_ONLY_ENTITY);
  });
});

describe('getItemEntities', () => {
  it('unions entities across every version sharing item_key', () => {
    const db = migratedDb();
    const cr = insertItem(db, arxivACrVersion());
    const ai = insertItem(db, arxivAAiVersion());

    // Asserted in exact order, not `.sort()`ed first: `order by entity` is part
    // of the contract, so a caller can rely on a stable sequence and a test
    // that pre-sorts could not tell a deterministic result from a lucky one.
    const expected = [ARXIV_AI_ONLY_ENTITY, ARXIV_CR_ONLY_ENTITY, ARXIV_SHARED_ENTITY];
    expect(getItemEntities(db, cr.item_key)).toEqual(expected);
    expect(getItemEntities(db, ai.item_key)).toEqual(expected);
  });

  it('deduplicates an entity both versions attribute, rather than returning it twice', () => {
    const db = migratedDb();
    const cr = insertItem(db, arxivACrVersion());
    insertItem(db, arxivAAiVersion());

    const result = getItemEntities(db, cr.item_key);
    expect(result.filter((e) => e === ARXIV_SHARED_ENTITY)).toEqual([ARXIV_SHARED_ENTITY]);
    expect(result).toHaveLength(new Set(result).size);
  });

  it('does not leak entities across different item_keys', () => {
    const db = migratedDb();
    const arxiv = insertItem(db, arxivACrVersion());
    insertItem(db, arxivAAiVersion());
    const cisa = insertItem(db, cisaKevControl());

    expect(arxiv.item_key).not.toBe(cisa.item_key);
    expect(getItemEntities(db, arxiv.item_key)).toEqual([
      ARXIV_AI_ONLY_ENTITY,
      ARXIV_CR_ONLY_ENTITY,
      ARXIV_SHARED_ENTITY,
    ]);
    expect(getItemEntities(db, cisa.item_key)).toEqual(['CVE-2014-4148', 'Microsoft', 'Windows']);
  });

  it('returns the same shape -- a plain array, no special case -- for an item with only one version', () => {
    const db = migratedDb();
    const cisa = insertItem(db, cisaKevControl());

    expect(getItemEntities(db, cisa.item_key)).toEqual(['CVE-2014-4148', 'Microsoft', 'Windows']);
  });

  it('returns an empty array, not null or a thrown error, for an item_key that was never ingested', () => {
    const db = migratedDb();
    expect(getItemEntities(db, deriveItemKey('https://never-ingested.test/nothing'))).toEqual([]);
  });

  it('returns an empty array for an ingested item that has no entities at all -- the M1 case', () => {
    // Every one of the 3,325 items in the first live ingest is this case:
    // item_beats has 3,325 rows, item_entities has 0. An item with no entities
    // must be indistinguishable in shape from one with some, so no caller needs
    // a null check for what is currently the only state real data is in.
    const db = migratedDb();
    const item = insertItem(db, { ...cisaKevControl(), entities: [] });

    expect(getItemEntities(db, item.item_key)).toEqual([]);
  });
});

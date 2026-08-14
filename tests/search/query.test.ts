import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, deriveItemKey, type NewItem } from '../../src/domain/item.ts';
import { searchItems, toSafeMatchQuery } from '../../src/search/query.ts';

const REAL_MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

const open: Array<ReturnType<typeof openDb>> = [];
function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db');
}
function migratedDb() {
  const db = openDb(tempDbPath());
  open.push(db);
  runMigrations(db, REAL_MIGRATIONS_DIR);
  return db;
}
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

const NOW = '2026-08-14T15:47:16.582Z';

function baseItem(overrides: Partial<NewItem> = {}): NewItem {
  return {
    url: 'https://example.test/a',
    canonicalUrl: 'https://example.test/a',
    title: 'A title',
    sourceId: 'ap-news',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    publishedAt: null,
    fetchedAt: NOW,
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Real rows, copied verbatim from data/wf.db (the M2 acceptance corpus,
// read-only, never opened by this test -- see CLAUDE.md) via:
//
//   sqlite3 -readonly data/wf.db "select item_id, url, canonical_url, title,
//     author, source_id, item_type, published_at, fetched_at, summary_raw
//     from items where title like '%Mangione%' order by source_id;"
//
// and the equivalent `%zanne%` query for the Cézanne rows. Mirrors the
// hand-copied-fixture convention tests/domain/itemBeats.test.ts and
// tests/fixtures/golden/corpus.ts already established, rather than the
// committed suite depending on data/wf.db's existence -- that file is
// gitignored (*.db) and absent from a fresh clone.
// ---------------------------------------------------------------------------

function mangioneApNews(): NewItem {
  return {
    url: 'https://apnews.com/article/luigi-mangione-plea-unitedhealthcare-ceo-3b8a5bb41589c9f5f4775dba2beea66f',
    canonicalUrl:
      'https://apnews.com/article/luigi-mangione-plea-unitedhealthcare-ceo-3b8a5bb41589c9f5f4775dba2beea66f',
    title: "Luigi Mangione's lawyers say he pleads guilty to killing UnitedHealthcare CEO",
    sourceId: 'ap-news',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    publishedAt: '2026-08-14T04:04:29.000Z',
    fetchedAt: NOW,
    summaryRaw: null,
    rawJson: '{}',
  };
}

function mangionePbsNewshour(): NewItem {
  return {
    url: 'https://www.pbs.org/newshour/nation/luigi-mangione-to-appear-in-court-for-expected-guilty-plea-in-killing-of-unitedhealthcare-ceo',
    canonicalUrl:
      'https://pbs.org/newshour/nation/luigi-mangione-to-appear-in-court-for-expected-guilty-plea-in-killing-of-unitedhealthcare-ceo',
    title: 'Luigi Mangione to appear in court for expected guilty plea in killing of UnitedHealthcare CEO',
    sourceId: 'pbs-newshour',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    publishedAt: '2026-08-14T15:07:21.000Z',
    fetchedAt: NOW,
    summaryRaw:
      "Luigi Mangione is scheduled to be in federal court Friday for a hearing at which he's expected to plead guilty in connection with the 2024 killing of UnitedHealthcare CEO Brian Thompson, according to a person familiar with the matter.",
    rawJson: '{}',
  };
}

// AP's version uses the real accented character. PBS's version -- verified
// against data/wf.db, not invented -- stores the literal, un-decoded HTML
// entity text "C&eacute;zanne" instead of the accented character. These are
// two DIFFERENT byte sequences describing the same word, and that
// difference is the entire point of this fixture pair.
function cezanneApNews(): NewItem {
  return {
    url: 'https://apnews.com/article/italy-stolen-paintings-recovered-renoir-cezanne-matisse-7d0989da55b2ae2e204bb7c759a81266',
    canonicalUrl:
      'https://apnews.com/article/italy-stolen-paintings-recovered-renoir-cezanne-matisse-7d0989da55b2ae2e204bb7c759a81266',
    title: 'Italian police recover stolen Renoir, Cézanne and Matisse artworks worth millions',
    sourceId: 'ap-news',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    publishedAt: '2026-08-14T10:48:41.000Z',
    fetchedAt: NOW,
    summaryRaw: null,
    rawJson: '{}',
  };
}

function cezannePbsNewshour(): NewItem {
  return {
    url: 'https://www.pbs.org/newshour/arts/italian-police-recover-stolen-renoir-cezanne-and-matisse-paintings-worth-millions',
    canonicalUrl:
      'https://pbs.org/newshour/arts/italian-police-recover-stolen-renoir-cezanne-and-matisse-paintings-worth-millions',
    title: 'Italian police recover stolen Renoir, C&eacute;zanne and Matisse paintings worth millions',
    author: 'Associated Press',
    sourceId: 'pbs-newshour',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    publishedAt: '2026-08-14T13:40:51.000Z',
    fetchedAt: NOW,
    summaryRaw: 'Police said Friday that the artworks were taken earlier this year from a private museum near Parma.',
    rawJson: '{}',
  };
}

describe('migration 0005: items_fts schema', () => {
  it('creates an empty items_fts table on a fresh database', () => {
    const db = migratedDb();
    const row = db.prepare('select count(*) as c from items_fts').get() as { c: number };
    expect(row.c).toBe(0);
  });

  it('backfills items ingested BEFORE 0005 was applied -- proves the migration, not just the trigger, indexes pre-existing rows', () => {
    // Build a private copy of only 0001-0004 (everything up to, but not
    // including, this task's migration), in filename order, so this test
    // survives future migrations being added alongside 0005 without having
    // to hardcode "everything except 0005_fts_search.sql".
    const preFtsDir = mkdtempSync(join(tmpdir(), 'wf-test-migrations-'));
    const files = readdirSync(REAL_MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      // Strictly BEFORE 0005, not merely "not named 0005" -- migrations
      // added after this test was written (0006_lane_layout.sql) sort past
      // 0005 and must stay excluded too, or this builds a database with
      // 0006 applied and 0005 not, which the runner now correctly refuses
      // to reconcile out of order (src/db/migrate.ts, "runMigrations
      // out-of-order application"). That refusal is the fix working: this
      // test's own directory used to be able to construct exactly the
      // out-of-order shape the M3 progress log flagged as silently
      // tolerated.
      if (f >= '0005_fts_search.sql') continue;
      writeFileSync(join(preFtsDir, f), readFileSync(join(REAL_MIGRATIONS_DIR, f), 'utf8'));
    }

    const db = openDb(tempDbPath());
    open.push(db);
    runMigrations(db, preFtsDir);

    // items_fts does not exist yet -- ingest happens entirely before this
    // migration is ever applied, exactly like data/wf.db's real history.
    insertItem(db, mangioneApNews());
    insertItem(db, mangionePbsNewshour());

    // Now apply the REAL, full migrations directory (includes 0005 and
    // everything after it). runMigrations is idempotent by filename/version,
    // so this only executes what preFtsDir didn't already apply -- 0001
    // through 0004 are already recorded as applied. Computed from `files`
    // rather than hardcoded, so this survives a future 0007+ being added
    // without needing an edit here (the same robustness the directory-build
    // loop above already goes out of its way for).
    const expectedNewlyApplied = files
      .filter((f) => f >= '0005_fts_search.sql')
      .map((f) => f.slice(0, -'.sql'.length));
    const { applied: newlyApplied } = runMigrations(db, REAL_MIGRATIONS_DIR);
    expect(newlyApplied).toEqual(expectedNewlyApplied);

    // The backfill inside 0005 must have picked up both pre-existing items
    // with no separate manual reindex step.
    const hits = searchItems(db, 'Mangione');
    expect(hits.map((h) => h.item.sourceId).sort()).toEqual(['ap-news', 'pbs-newshour']);
  });
});

describe('sync: a freshly ingested item is findable with no manual step', () => {
  it('is searchable the instant insertItem returns -- no reindex, no rebuild pass', () => {
    const db = migratedDb();
    insertItem(db, mangioneApNews());

    const hits = searchItems(db, 'Mangione');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.item.title).toContain('Mangione');
    expect(hits[0]!.item.sourceId).toBe('ap-news');
  });
});

describe('hit granularity: item (item_key), not version (item_id)', () => {
  it('two different sources covering the same story are two DIFFERENT item_keys -- two hits is correct, not a bug', () => {
    const db = migratedDb();
    const ap = insertItem(db, mangioneApNews());
    const pbs = insertItem(db, mangionePbsNewshour());
    expect(ap.item_key).not.toBe(pbs.item_key);

    const hits = searchItems(db, 'Mangione');
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.item.sourceId).sort()).toEqual(['ap-news', 'pbs-newshour']);
    // Every hit key is unique -- no item_key repeated (the failure mode an
    // external-content-over-items index keyed on item_id/rowid could produce
    // for a re-versioned item; this test doesn't have re-versioning in it,
    // but it does establish "one row per distinct item" as the baseline).
    expect(new Set(hits.map((h) => h.item.item_key)).size).toBe(2);
  });

  it('re-ingesting a NEW VERSION of the same item_key (a correction) replaces the search text, never duplicates the hit', () => {
    const db = migratedDb();
    const v1 = insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/correction-story',
        url: 'https://example.test/correction-story',
        title: 'Initial headline mentions Krakatoa erroneously',
        fetchedAt: '2026-08-14T10:00:00.000Z',
      }),
    );
    const v2 = insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/correction-story',
        url: 'https://example.test/correction-story',
        title: 'Corrected headline mentions Tambora instead',
        fetchedAt: '2026-08-14T11:00:00.000Z',
      }),
    );
    expect(v1.item_key).toBe(v2.item_key);

    // Exactly one row survives in items_fts for this item_key -- proves
    // replace, not append.
    const rows = db.prepare('select count(*) as c from items_fts where item_key = ?').get(v1.item_key) as {
      c: number;
    };
    expect(rows.c).toBe(1);

    const corrected = searchItems(db, 'Tambora');
    expect(corrected).toHaveLength(1);
    expect(corrected[0]!.item.title).toContain('Tambora');
  });

  it('THE STALENESS CATCH: the pre-correction word is no longer findable at all -- would fail red if sync only appended', () => {
    const db = migratedDb();
    insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/correction-story-2',
        url: 'https://example.test/correction-story-2',
        title: 'Initial headline mentions Krakatoa erroneously',
        fetchedAt: '2026-08-14T10:00:00.000Z',
      }),
    );
    insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/correction-story-2',
        url: 'https://example.test/correction-story-2',
        title: 'Corrected headline mentions Tambora instead',
        fetchedAt: '2026-08-14T11:00:00.000Z',
      }),
    );

    // If items_fts_sync (0005_fts_search.sql) were changed to INSERT-only
    // (no DELETE of the prior row -- an index gone quietly stale), this
    // stale word would still be a hit. It must not be.
    expect(searchItems(db, 'Krakatoa')).toHaveLength(0);
  });

  it('does not leak hits across unrelated item_keys', () => {
    const db = migratedDb();
    insertItem(db, mangioneApNews());
    insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/unrelated',
        url: 'https://example.test/unrelated',
        title: 'A completely unrelated AI funding story',
      }),
    );

    const hits = searchItems(db, 'Mangione');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.item.sourceId).toBe('ap-news');
  });
});

describe('what "everything retained" means: the un-decoded-entity failure case', () => {
  it('AP’s accented "Cézanne" is findable; PBS’s literal "C&eacute;zanne" text is NOT -- a real, pre-existing storage difference, not a search bug', () => {
    const db = migratedDb();
    const ap = insertItem(db, cezanneApNews());
    const pbs = insertItem(db, cezannePbsNewshour());
    expect(ap.item_key).not.toBe(pbs.item_key);

    const accented = searchItems(db, 'Cézanne');
    expect(accented.map((h) => h.item.sourceId)).toEqual(['ap-news']);

    // remove_diacritics 2 also makes the unaccented spelling match the
    // accented AP text -- still only AP, PBS's row genuinely doesn't
    // contain the word "cezanne" in any form, only the literal entity text.
    const unaccented = searchItems(db, 'Cezanne');
    expect(unaccented.map((h) => h.item.sourceId)).toEqual(['ap-news']);

    // PBS IS findable, just not by the word "Cézanne" -- by the literal
    // entity fragment actually stored.
    const entityFragment = searchItems(db, 'eacute');
    expect(entityFragment.map((h) => h.item.sourceId)).toEqual(['pbs-newshour']);
  });
});

describe('what "everything retained" means: excerpt cap', () => {
  it('a phrase confined to text beyond the retained excerpt is never findable -- summary_raw is what was stored, nothing more', () => {
    const db = migratedDb();
    insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/excerpt-cap',
        url: 'https://example.test/excerpt-cap',
        title: 'A routine story with a short retained excerpt',
        summaryRaw: 'The retained excerpt covers only the opening of the piece.',
      }),
    );

    // "paragraph four" text was never stored anywhere -- not a bug in this
    // module, a property of what src/normalize/item.ts retains at all.
    expect(searchItems(db, 'paragraph four')).toHaveLength(0);
  });
});

describe('toSafeMatchQuery', () => {
  it('wraps a single token in a quoted phrase', () => {
    expect(toSafeMatchQuery('Mangione')).toBe('"Mangione"');
  });

  it('wraps multiple tokens as separate quoted phrases, implicit AND', () => {
    expect(toSafeMatchQuery('prompt injection')).toBe('"prompt" "injection"');
  });

  it('doubles an embedded double quote (SQL string-literal escaping)', () => {
    expect(toSafeMatchQuery('say "hello"')).toBe('"say" """hello"""');
  });

  it('returns null for empty input', () => {
    expect(toSafeMatchQuery('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(toSafeMatchQuery('   \t  ')).toBeNull();
  });

  it('passes & and + through untouched inside the quoted phrase (not FTS5 syntax, no special handling needed)', () => {
    expect(toSafeMatchQuery('AT&T')).toBe('"AT&T"');
    expect(toSafeMatchQuery('C++')).toBe('"C++"');
  });
});

describe('hostile queries: no syntax error, no operator injection', () => {
  const hostileQueries = [
    'AT&T',
    'C++',
    '"',
    '""',
    'a" OR 1=1 OR "b',
    'title:foo',
    '(unbalanced',
    'unbalanced)',
    'foo* NEAR bar',
    '-exclude',
    'foo OR bar',
    'foo NOT bar',
    '^foo',
    '\\',
    '   ',
    '',
  ];

  for (const q of hostileQueries) {
    it(`does not throw for ${JSON.stringify(q)}`, () => {
      const db = migratedDb();
      insertItem(db, mangioneApNews());
      expect(() => searchItems(db, q)).not.toThrow();
    });
  }

  it('a literal FTS5 operator typed by the user is treated as literal text, never executed as an operator', () => {
    const db = migratedDb();
    insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/or-title',
        url: 'https://example.test/or-title',
        title: 'A story literally titled foo OR bar',
      }),
    );
    insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/foo-only',
        url: 'https://example.test/foo-only',
        title: 'A story about foo alone, nothing else',
      }),
    );

    // If "OR" were interpreted as the FTS5 boolean operator, `foo OR bar`
    // would match BOTH items (the second contains "foo"). Because every
    // token is quoted, this instead requires the literal three-word phrase
    // sequence "foo", "OR", "bar" all present -- matching only the first.
    const hits = searchItems(db, 'foo OR bar');
    expect(hits.map((h) => h.item.canonicalUrl)).toEqual(['https://example.test/or-title']);
  });

  it('a bare quote alone returns no results rather than throwing', () => {
    const db = migratedDb();
    insertItem(db, mangioneApNews());
    expect(searchItems(db, '"')).toEqual([]);
  });
});

describe('ranking and limit', () => {
  it('results are ordered by rank ascending (FTS5 bm25: best match first)', () => {
    const db = migratedDb();
    insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/strong-match',
        url: 'https://example.test/strong-match',
        title: 'Qwen Qwen Qwen releases a new model called Qwen',
      }),
    );
    insertItem(
      db,
      baseItem({
        canonicalUrl: 'https://example.test/weak-match',
        url: 'https://example.test/weak-match',
        title: 'A roundup that mentions Qwen once in passing',
      }),
    );

    const hits = searchItems(db, 'Qwen');
    expect(hits).toHaveLength(2);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.rank).toBeGreaterThanOrEqual(hits[i - 1]!.rank);
    }
    expect(hits[0]!.item.canonicalUrl).toBe('https://example.test/strong-match');
  });

  it('respects a custom limit', () => {
    const db = migratedDb();
    for (let i = 0; i < 5; i++) {
      insertItem(
        db,
        baseItem({
          canonicalUrl: `https://example.test/limit-${i}`,
          url: `https://example.test/limit-${i}`,
          title: `RAG pipeline update number ${i}`,
        }),
      );
    }

    expect(searchItems(db, 'RAG', { limit: 2 })).toHaveLength(2);
    expect(searchItems(db, 'RAG')).toHaveLength(5);
  });

  it('an unknown item_key never ingested returns no results, not an error', () => {
    const db = migratedDb();
    expect(searchItems(db, deriveItemKey('https://never-ingested.test/nothing'))).toEqual([]);
  });
});

describe('indexed columns: author and source_id are searchable too', () => {
  it('matches on author', () => {
    const db = migratedDb();
    insertItem(db, cezannePbsNewshour()); // author: 'Associated Press'
    const hits = searchItems(db, 'Associated Press');
    expect(hits.map((h) => h.item.sourceId)).toEqual(['pbs-newshour']);
  });
});

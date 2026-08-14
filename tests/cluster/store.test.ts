import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, InvalidTimestampError, type NewItem } from '../../src/domain/item.ts';
import {
  getCurrentTitlesForClustering,
  writeClusters,
  getClusterSizeAsOf,
} from '../../src/cluster/store.ts';

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

function baseItem(overrides: Partial<NewItem> = {}): NewItem {
  return {
    url: 'https://example.test/a',
    canonicalUrl: 'https://example.test/a',
    title: 'A title',
    sourceId: 'ap-news',
    itemType: 'press',
    beats: ['usnews'],
    entities: [],
    publishedAt: null,
    fetchedAt: '2026-08-14T00:00:00.000Z',
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getCurrentTitlesForClustering
// ---------------------------------------------------------------------------
describe('getCurrentTitlesForClustering', () => {
  it('returns an empty array against an empty database', () => {
    const db = migratedDb();
    expect(getCurrentTitlesForClustering(db)).toEqual([]);
  });

  it('returns one candidate per distinct item_key with its title and source_id', () => {
    // sourceId (fix round 1, M2 task 4 fix-round-1): src/cluster/group.ts's
    // cross-source-only defense needs it on every candidate.
    const db = migratedDb();
    const a = insertItem(
      db,
      baseItem({
        url: 'https://example.test/a',
        canonicalUrl: 'https://example.test/a',
        title: 'Story A',
        sourceId: 'ap-news',
      }),
    );
    const b = insertItem(
      db,
      baseItem({
        url: 'https://example.test/b',
        canonicalUrl: 'https://example.test/b',
        title: 'Story B',
        sourceId: 'npr-news',
      }),
    );
    const candidates = getCurrentTitlesForClustering(db);
    expect(candidates.slice().sort((x, y) => (x.itemKey < y.itemKey ? -1 : 1))).toEqual(
      [
        { itemKey: a.item_key, title: 'Story A', sourceId: 'ap-news' },
        { itemKey: b.item_key, title: 'Story B', sourceId: 'npr-news' },
      ].sort((x, y) => (x.itemKey < y.itemKey ? -1 : 1)),
    );
  });

  it('uses the LATEST version\'s title when item_key has multiple versions (append-only re-versioning)', () => {
    const db = migratedDb();
    const v1 = insertItem(
      db,
      baseItem({
        url: 'https://example.test/a',
        canonicalUrl: 'https://example.test/a',
        title: 'Original headline',
        fetchedAt: '2026-08-14T00:00:00.000Z',
      }),
    );
    insertItem(
      db,
      baseItem({
        url: 'https://example.test/a',
        canonicalUrl: 'https://example.test/a',
        title: 'Corrected headline',
        fetchedAt: '2026-08-14T01:00:00.000Z',
      }),
    );
    const candidates = getCurrentTitlesForClustering(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({ itemKey: v1.item_key, title: 'Corrected headline', sourceId: 'ap-news' });
  });

  it('breaks a fetched_at TIE by rowid desc, matching getCurrentItem exactly -- the real arXiv cs.AI/cs.CR shape', () => {
    // Same real shared-fetched_at collision itemBeats.test.ts uses (see that
    // file's header comment for the sqlite3 query that found it in
    // attic/wf-m1-firstrun-2026-08-14.db): two versions of one item_key,
    // identical fetched_at, second-inserted (higher rowid) must win. Titles
    // are deliberately made to differ here (the real arXiv pair shares an
    // identical title, which wouldn't prove the tiebreak on its own) so a
    // wrong tiebreak is actually observable.
    const db = migratedDb();
    const shared = {
      url: 'https://arxiv.org/abs/2608.11274',
      canonicalUrl: 'https://arxiv.org/abs/2608.11274',
      fetchedAt: '2026-08-14T03:47:10.404Z',
    };
    const first = insertItem(db, baseItem({ ...shared, title: 'cs.CR version title', sourceId: 'arxiv-cs-cr' }));
    insertItem(db, baseItem({ ...shared, title: 'cs.AI version title', sourceId: 'arxiv-cs-ai' }));
    const candidates = getCurrentTitlesForClustering(db);
    expect(candidates).toHaveLength(1);
    // sourceId follows the SAME winning version as title -- not left over
    // from the first-inserted row. Real consequence (fix round 1): if this
    // resolved sourceId from the wrong version, src/cluster/group.ts's
    // cross-source-only defense could compare against a stale attribution.
    expect(candidates[0]).toEqual({
      itemKey: first.item_key,
      title: 'cs.AI version title',
      sourceId: 'arxiv-cs-ai',
    });
  });
});

// ---------------------------------------------------------------------------
// writeClusters -- append-only, fetched_at stamping.
// ---------------------------------------------------------------------------
describe('writeClusters', () => {
  it('writes one clusters row and one item_clusters row per member for a single group', () => {
    const db = migratedDb();
    const runAt = '2026-08-14T12:00:00.000Z';
    const summary = writeClusters(db, [['a', 'b', 'c']], runAt);
    expect(summary).toEqual({ clustersCreated: 1, membershipsWritten: 3 });

    const clusters = db.prepare('select cluster_id, created_at from clusters').all() as Array<{
      cluster_id: string;
      created_at: string;
    }>;
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.created_at).toBe(runAt);

    const memberships = db
      .prepare('select cluster_id, item_key, fetched_at from item_clusters order by item_key')
      .all() as Array<{ cluster_id: string; item_key: string; fetched_at: string }>;
    expect(memberships).toEqual([
      { cluster_id: clusters[0]!.cluster_id, item_key: 'a', fetched_at: runAt },
      { cluster_id: clusters[0]!.cluster_id, item_key: 'b', fetched_at: runAt },
      { cluster_id: clusters[0]!.cluster_id, item_key: 'c', fetched_at: runAt },
    ]);
  });

  it('writes multiple independent clusters rows for multiple groups in one call', () => {
    const db = migratedDb();
    const summary = writeClusters(db, [['a', 'b'], ['x', 'y', 'z']], '2026-08-14T12:00:00.000Z');
    expect(summary).toEqual({ clustersCreated: 2, membershipsWritten: 5 });
    expect((db.prepare('select count(*) as n from clusters').get() as { n: number }).n).toBe(2);
    expect((db.prepare('select count(*) as n from item_clusters').get() as { n: number }).n).toBe(5);
  });

  it('writing zero groups is a no-op that writes nothing', () => {
    const db = migratedDb();
    const summary = writeClusters(db, [], '2026-08-14T12:00:00.000Z');
    expect(summary).toEqual({ clustersCreated: 0, membershipsWritten: 0 });
    expect((db.prepare('select count(*) as n from clusters').get() as { n: number }).n).toBe(0);
  });

  it('rejects a group of fewer than 2 members -- a "cluster" of one is not a cluster', () => {
    const db = migratedDb();
    expect(() => writeClusters(db, [['solo']], '2026-08-14T12:00:00.000Z')).toThrow();
    // Nothing partially written.
    expect((db.prepare('select count(*) as n from clusters').get() as { n: number }).n).toBe(0);
  });

  it('rejects a non-canonical runAt timestamp before writing anything', () => {
    const db = migratedDb();
    expect(() => writeClusters(db, [['a', 'b']], '2026-08-14')).toThrow(InvalidTimestampError);
    expect((db.prepare('select count(*) as n from clusters').get() as { n: number }).n).toBe(0);
  });

  it('re-clustering APPENDS a new cluster_id and new item_clusters rows -- it never updates or deletes the earlier pass\'s rows', () => {
    const db = migratedDb();
    writeClusters(db, [['a', 'b']], '2026-08-14T10:00:00.000Z');
    const afterPass1 = db.prepare('select membership_id from item_clusters').all() as Array<{
      membership_id: string;
    }>;
    expect(afterPass1).toHaveLength(2);

    // Second pass: the same two items PLUS a new one, discovered later.
    writeClusters(db, [['a', 'b', 'c']], '2026-08-14T11:00:00.000Z');

    const afterPass2 = db.prepare('select membership_id from item_clusters').all() as Array<{
      membership_id: string;
    }>;
    // All of pass 1's rows are still present, untouched, PLUS pass 2's 3 new
    // ones -- 2 + 3 = 5, never 3 (which is what an update-in-place would
    // leave).
    expect(afterPass2).toHaveLength(5);
    const pass1Ids = new Set(afterPass1.map((r) => r.membership_id));
    const pass2Ids = new Set(afterPass2.map((r) => r.membership_id));
    for (const id of pass1Ids) expect(pass2Ids.has(id)).toBe(true);

    // And two independent clusters rows now exist -- pass 1's is not reused.
    expect((db.prepare('select count(*) as n from clusters').get() as { n: number }).n).toBe(2);
  });

  it('the underlying append-only triggers still reject a direct UPDATE/DELETE against rows this function wrote', () => {
    const db = migratedDb();
    writeClusters(db, [['a', 'b']], '2026-08-14T10:00:00.000Z');
    expect(() => db.exec("update item_clusters set item_key = 'z'")).toThrow();
    expect(() => db.exec('delete from item_clusters')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getClusterSizeAsOf -- the central "reconstructible at a past instant" proof.
// ---------------------------------------------------------------------------
describe('getClusterSizeAsOf', () => {
  it('returns 1 for an item_key that was never clustered', () => {
    const db = migratedDb();
    expect(getClusterSizeAsOf(db, 'never-clustered', '2026-08-14T12:00:00.000Z')).toBe(1);
  });

  it('returns the true member count for a clustered item, queried at or after the pass', () => {
    const db = migratedDb();
    const runAt = '2026-08-14T10:00:00.000Z';
    writeClusters(db, [['a', 'b', 'c']], runAt);
    expect(getClusterSizeAsOf(db, 'a', runAt)).toBe(3);
    expect(getClusterSizeAsOf(db, 'a', '2026-08-14T23:59:59.999Z')).toBe(3);
  });

  it('returns 1 -- not the current size -- when asOf predates the clustering pass entirely', () => {
    // THE central point-in-time proof: an as_of query for a moment BEFORE
    // this item was ever clustered must see it as it genuinely was then (a
    // singleton), not replay today's knowledge backward onto yesterday.
    const db = migratedDb();
    writeClusters(db, [['a', 'b', 'c']], '2026-08-14T10:00:00.000Z');
    expect(getClusterSizeAsOf(db, 'a', '2026-08-14T09:59:59.999Z')).toBe(1);
    expect(getClusterSizeAsOf(db, 'a', '2026-08-01T00:00:00.000Z')).toBe(1);
  });

  it('a query exactly AT the pass timestamp sees that pass\'s membership (inclusive <=, matching item.ts\'s as_of convention)', () => {
    const db = migratedDb();
    const runAt = '2026-08-14T10:00:00.000Z';
    writeClusters(db, [['a', 'b']], runAt);
    expect(getClusterSizeAsOf(db, 'a', runAt)).toBe(2);
  });

  it('two passes over time: as_of correctly resolves which pass was current at that instant, not just the latest', () => {
    // Pass 1 (early): {a, b} clusters as a pair. Pass 2 (later): the group
    // grows to {a, b, c} under a BRAND NEW cluster_id -- re-clustering
    // appends, it does not extend the old cluster_id in place. A query as
    // of a moment between the two passes must report the size AS IT WAS
    // THEN (2), and a query as of a moment at/after pass 2 must report the
    // grown size (3). Both must be answerable from the same table with no
    // background job re-deriving history.
    const db = migratedDb();
    const pass1At = '2026-08-10T00:00:00.000Z';
    const pass2At = '2026-08-14T00:00:00.000Z';
    writeClusters(db, [['a', 'b']], pass1At);
    writeClusters(db, [['a', 'b', 'c']], pass2At);

    // A week before pass 1 even ran: singleton.
    expect(getClusterSizeAsOf(db, 'a', '2026-08-01T00:00:00.000Z')).toBe(1);
    // Between pass 1 and pass 2: the historically-true size, 2 -- NOT 3.
    expect(getClusterSizeAsOf(db, 'a', '2026-08-12T00:00:00.000Z')).toBe(2);
    // At/after pass 2: the grown size, 3.
    expect(getClusterSizeAsOf(db, 'a', pass2At)).toBe(3);
    expect(getClusterSizeAsOf(db, 'a', '2026-08-20T00:00:00.000Z')).toBe(3);
    // 'c' did not exist (as a cluster member) until pass 2.
    expect(getClusterSizeAsOf(db, 'c', '2026-08-12T00:00:00.000Z')).toBe(1);
    expect(getClusterSizeAsOf(db, 'c', pass2At)).toBe(3);
  });

  it('rejects a non-canonical asOf timestamp', () => {
    const db = migratedDb();
    expect(() => getClusterSizeAsOf(db, 'a', '2026-08-14')).toThrow(InvalidTimestampError);
  });
});

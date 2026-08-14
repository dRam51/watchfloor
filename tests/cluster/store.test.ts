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

  it('two DIFFERENT clusters written in the SAME pass (identical fetched_at) are not conflated -- each item resolves to its OWN cluster within that run', () => {
    const db = migratedDb();
    const runAt = '2026-08-14T10:00:00.000Z';
    writeClusters(
      db,
      [
        ['a', 'b'],
        ['x', 'y', 'z'],
      ],
      runAt,
    );
    expect(getClusterSizeAsOf(db, 'a', runAt)).toBe(2);
    expect(getClusterSizeAsOf(db, 'b', runAt)).toBe(2);
    expect(getClusterSizeAsOf(db, 'x', runAt)).toBe(3);
    expect(getClusterSizeAsOf(db, 'y', runAt)).toBe(3);
    expect(getClusterSizeAsOf(db, 'z', runAt)).toBe(3);
  });
});

// =============================================================================
// FIX ROUND 2 -- append-only membership + a shrinking cluster (an item that
// stops being clustered) means "this item_key's most recent row" is no
// longer the same thing as "this item_key's CURRENT size". Reported against
// the real data/wf.db (never opened by this test -- see task-4-report.md's
// fix-round-2 section for the exact queries and the full real-scale
// validation): fix round 1's cross-source-only rule correctly excludes
// every cisa-kev/cisa-kev pair, so a re-clustering pass writes NOTHING for
// an item that was in the OLD 1,543-member cluster and is no longer in ANY
// cluster. Before this fix, getClusterSizeAsOf resolved "the most recent
// row for this item_key across all history" -- which for such an item is
// still its stale 1,543-sized membership from the last pass that included
// it, forever, because nothing ever gets written to supersede it.
//
// THE FIX: getClusterSizeAsOf now resolves in two steps instead of one --
// first "what is the latest clustering RUN at or before asOf" (every
// membership one call to writeClusters produces shares an identical
// fetched_at, so the distinct fetched_at values in item_clusters ARE the
// set of past runs), THEN "does this item_key have a membership WITHIN that
// specific run". An item absent from the current run's memberships is a
// singleton (1), full stop -- its stale membership from an OLDER run is
// simply never consulted for a "current" read, though it remains fully
// intact and correctly reconstructable for a HISTORICAL asOf inside that
// older run's own window (the point-in-time property this whole mechanism
// exists to guarantee, deliberately NOT "fixed" away -- see the dedicated
// test below).
//
// ALTERNATIVE CONSIDERED AND REJECTED: writeClusters emitting an explicit
// singleton row (its own single-member "cluster") for every unclustered
// candidate every pass. Also correct, but rejected: the real corpus has
// ~4,134 candidates and only ~10 real clusters, so this would write roughly
// 4,100 new rows into an APPEND-ONLY table on every single pass, forever --
// versus 22 under the chosen fix. It also directly contradicts this
// project's own established convention (src/cluster/store.ts's writeClusters
// doc comment, unchanged by this fix round): "a singleton earns no row" --
// `clusters` exists to record genuine duplication, and thousands of
// vacuous one-member "clusters" would violate that on every pass.
// =============================================================================
describe('getClusterSizeAsOf -- FIX ROUND 2: run-scoped resolution, not item-scoped', () => {
  it('an item that drops OUT of a cluster between two passes reads as a singleton as of the later pass -- not the stale size from the pass it was last a member of', () => {
    const db = migratedDb();
    const pass1At = '2026-08-10T00:00:00.000Z';
    writeClusters(db, [['a', 'b']], pass1At);
    expect(getClusterSizeAsOf(db, 'a', pass1At)).toBe(2);

    // Pass 2: 'a' is no longer grouped with anyone -- its near-duplicate 'b'
    // is now grouped with a DIFFERENT item instead (exactly the shape a
    // re-clustering pass produces once grouping behaviour changes).
    // writeClusters writes NOTHING for 'a' here -- there is no singleton row
    // to append.
    const pass2At = '2026-08-14T00:00:00.000Z';
    writeClusters(db, [['b', 'c']], pass2At);

    // As of pass 2 (or later): 'a' must read as a singleton, size 1 -- NOT
    // the stale size 2 from pass 1, which is still sitting in the table
    // (append-only, never deleted) but is no longer the CURRENT truth. This
    // is the exact assertion that failed against the pre-fix implementation
    // (see the mutation test in task-4-report.md's fix-round-2 section).
    expect(getClusterSizeAsOf(db, 'a', pass2At)).toBe(1);
    expect(getClusterSizeAsOf(db, 'a', '2026-08-20T00:00:00.000Z')).toBe(1);

    // 'b' correctly reads its NEW cluster's size (with 'c'), not pass 1's.
    expect(getClusterSizeAsOf(db, 'b', pass2At)).toBe(2);

    // POINT-IN-TIME PROPERTY, explicitly pinned (must NOT be "fixed" away):
    // a query for a moment BETWEEN the two passes is historically truthful
    // -- 'a' really was in a 2-member cluster then, and an as_of read must
    // say so, not retroactively apply pass 2's knowledge backward.
    expect(getClusterSizeAsOf(db, 'a', '2026-08-12T00:00:00.000Z')).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // REAL REGRESSION -- item_keys, titles, source_ids, and pass timestamps
  // copied BY HAND from a read-only copy of the real, live data/wf.db
  // (`sqlite3 data/wf.db "VACUUM INTO '<scratch>'"`; data/wf.db itself never
  // opened by this test or by anything in this task -- see
  // task-4-report.md's fix-round-2 section for the exact queries used and
  // the full real-scale before/after validation, which is not repeated
  // here at its true 1,543/107/1,890 scale for practicality).
  //
  // data/wf.db held THREE identical broken clustering passes (each a real,
  // independent reproduction of fix round 1's bug: a 1,543-member, 100%
  // cisa-kev cluster) followed by one real fixed pass. These three real
  // cisa-kev items were members of the broken cluster in every broken pass
  // and members of NOTHING in the fixed pass (fix round 1's cross-source-
  // only rule correctly excludes every cisa-kev/cisa-kev pair) -- exactly
  // the shape that exposed this bug.
  // ---------------------------------------------------------------------------
  describe('real data/wf.db regression', () => {
    const CISCO_ASA =
      '1e868cf7cef50c5834a6e8d333fe78476d9e8842c5630e847befdf786a8055b8'; // "Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) Heap Inspection Vulnerability"
    const MS_AFD =
      'c4576e09f953662a847f54326edc7db564f28bbb3ab22e38d0607cec55eba7fc'; // "Microsoft Windows Ancillary Function Driver for WinSock Use-After-Free Vulnerability"
    const METABASE =
      'ad6ab3554da5e5cc03ca5531fa9d50c6ff74a07c08484a3862caf62f8d9d2c61'; // "Metabase SQL Injection Vulnerability"
    // A real genuine SURVIVOR of the real fixed pass: whitehouse-actions and
    // federal-register both carried the identical real title "Delivering
    // Gold Standard Childhood Vaccine Recommendations for Americans" and
    // correctly remained clustered together -- a real 2-source
    // corroboration fix round 1's changes preserve correctly.
    const WHITEHOUSE_VACCINE = '41ac6d8235ff7acb5de3a74a0bf35821a0130d5e48b2b0f4b69181ea220f2b7a';
    const FEDREGISTER_VACCINE = 'ed8db510ed39ff2a7826724ca0d12483a4e3a1e8bdf463152d40eb1741c0096b';

    // The real timestamp of the FIRST of the three broken passes, and of the
    // real fixed pass, copied verbatim.
    const BROKEN_RUN_AT = '2026-08-14T16:02:50.419Z';
    const FIXED_RUN_AT = '2026-08-14T16:27:11.601Z';

    function reproduceRealScenario(db: ReturnType<typeof migratedDb>) {
      // The real broken pass clustered these 3 real items together (among
      // 1,540 other real cisa-kev items not reproduced here for
      // practicality -- this fixture proves the READ-PATH mechanism using
      // real identities and real timestamps, not a claim that this
      // in-test fixture itself is 1,543 members wide).
      writeClusters(db, [[CISCO_ASA, MS_AFD, METABASE]], BROKEN_RUN_AT);
      // The real fixed pass wrote nothing for any of the three -- they are
      // absent from every one of its groups. It DID correctly cluster the
      // real whitehouse-actions/federal-register vaccine-recommendations
      // pair.
      writeClusters(db, [[WHITEHOUSE_VACCINE, FEDREGISTER_VACCINE]], FIXED_RUN_AT);
    }

    it('the three real cisa-kev items read 1 (singleton), not their old broken-pass size, as of the fixed run', () => {
      const db = migratedDb();
      reproduceRealScenario(db);
      expect(getClusterSizeAsOf(db, CISCO_ASA, FIXED_RUN_AT)).toBe(1);
      expect(getClusterSizeAsOf(db, MS_AFD, FIXED_RUN_AT)).toBe(1);
      expect(getClusterSizeAsOf(db, METABASE, FIXED_RUN_AT)).toBe(1);
    });

    it('the real surviving cross-source cluster still reads its true size as of the fixed run', () => {
      const db = migratedDb();
      reproduceRealScenario(db);
      expect(getClusterSizeAsOf(db, WHITEHOUSE_VACCINE, FIXED_RUN_AT)).toBe(2);
      expect(getClusterSizeAsOf(db, FEDREGISTER_VACCINE, FIXED_RUN_AT)).toBe(2);
    });

    it('POINT IN TIME: an asOf inside the broken run still reconstructs the broken run\'s (wrong, but historically real) size -- truthful, not something to "fix"', () => {
      const db = migratedDb();
      reproduceRealScenario(db);
      // Exactly at the broken run's own timestamp, before the fixed run
      // ever happened: the three items genuinely WERE grouped together
      // then. An as_of read for that instant must say so -- this is the
      // requirement stated explicitly in the fix-round-2 brief: "an asOf
      // inside the broken run must still reconstruct the broken run's
      // sizes... and must not be 'fixed'."
      expect(getClusterSizeAsOf(db, CISCO_ASA, BROKEN_RUN_AT)).toBe(3);
      expect(getClusterSizeAsOf(db, MS_AFD, BROKEN_RUN_AT)).toBe(3);
      expect(getClusterSizeAsOf(db, METABASE, BROKEN_RUN_AT)).toBe(3);
      // A moment strictly between the two real runs: same historical answer.
      expect(getClusterSizeAsOf(db, CISCO_ASA, '2026-08-14T16:15:00.000Z')).toBe(3);
      // Before the broken run ever happened: a true singleton.
      expect(getClusterSizeAsOf(db, CISCO_ASA, '2026-08-14T00:00:00.000Z')).toBe(1);
    });
  });
});

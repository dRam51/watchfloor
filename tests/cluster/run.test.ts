import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type NewItem } from '../../src/domain/item.ts';
import { getClusterSizeAsOf } from '../../src/cluster/store.ts';
import { runClusteringPass, runClusteringPassFromConfigFile } from '../../src/cluster/run.ts';
import type { ClusterConfig } from '../../src/cluster/config.ts';

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
    url: 'https://example.test/default',
    canonicalUrl: 'https://example.test/default',
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

function config(threshold: number): ClusterConfig {
  return { near_duplicate_threshold: threshold };
}

// ---------------------------------------------------------------------------
// End-to-end with REAL corpus titles (attic/wf-m1-firstrun-2026-08-14.db,
// read-only, never opened by this test -- see similarity.test.ts's header
// for the exact provenance of each title) inserted as REAL items via
// insertItem, run through the full pipeline: read candidates -> group -> write.
// ---------------------------------------------------------------------------
describe('runClusteringPass -- end to end, real corpus', () => {
  it('the Mangione three-way hub clusters correctly through the full pipeline, at the production threshold', () => {
    const db = migratedDb();
    const npr = insertItem(
      db,
      baseItem({
        url: 'https://npr.org/mangione',
        canonicalUrl: 'https://npr.org/mangione',
        title: 'Mangione could plead guilty in federal case ahead of N.Y. murder trial',
        sourceId: 'npr-news',
      }),
    );
    const pbs = insertItem(
      db,
      baseItem({
        url: 'https://pbs.org/mangione',
        canonicalUrl: 'https://pbs.org/mangione',
        title: 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing',
        sourceId: 'pbs-newshour',
      }),
    );
    const ap = insertItem(
      db,
      baseItem({
        url: 'https://apnews.com/mangione',
        canonicalUrl: 'https://apnews.com/mangione',
        title: 'Luigi Mangione expected to plead guilty in killing of UnitedHealthcare CEO',
        sourceId: 'ap-news',
      }),
    );
    // An unrelated item that must stay out of the cluster entirely.
    const unrelated = insertItem(
      db,
      baseItem({
        url: 'https://apnews.com/unrelated',
        canonicalUrl: 'https://apnews.com/unrelated',
        title: 'Local bakery wins regional pastry award',
        sourceId: 'ap-news',
      }),
    );

    const runAt = '2026-08-14T12:00:00.000Z';
    const summary = runClusteringPass(db, config(0.1), runAt);

    expect(summary).toEqual({
      candidatesConsidered: 4,
      groupsFound: 1,
      clustersCreated: 1,
      membershipsWritten: 3,
    });

    expect(getClusterSizeAsOf(db, npr.item_key, runAt)).toBe(3);
    expect(getClusterSizeAsOf(db, pbs.item_key, runAt)).toBe(3);
    expect(getClusterSizeAsOf(db, ap.item_key, runAt)).toBe(3);
    expect(getClusterSizeAsOf(db, unrelated.item_key, runAt)).toBe(1);

    const clusters = db.prepare('select created_at from clusters').all() as Array<{ created_at: string }>;
    expect(clusters).toEqual([{ created_at: runAt }]);
  });

  it('the two required traps (Ukraine drones, same-source-different-angle) stay uncustered end to end', () => {
    const db = migratedDb();
    insertItem(
      db,
      baseItem({
        url: 'https://npr.org/crimea',
        canonicalUrl: 'https://npr.org/crimea',
        title: "By sky and sea, Ukraine's drone strikes challenge Russia's grip on Crimea",
        sourceId: 'npr-news',
      }),
    );
    insertItem(
      db,
      baseItem({
        url: 'https://pbs.org/refinery',
        canonicalUrl: 'https://pbs.org/refinery',
        title: 'Ukrainian drones strike major oil refinery deep inside Russia, setting it ablaze',
        sourceId: 'pbs-newshour',
      }),
    );
    insertItem(
      db,
      baseItem({
        url: 'https://pbs.org/settlers-condemns',
        canonicalUrl: 'https://pbs.org/settlers-condemns',
        title: "'Act of terror': U.S. condemns Israeli settler siege of Palestinian homes in West Bank",
        sourceId: 'pbs-newshour',
      }),
    );
    insertItem(
      db,
      baseItem({
        url: 'https://pbs.org/settlers-family',
        canonicalUrl: 'https://pbs.org/settlers-family',
        title: 'Palestinian American family recounts siege of West Bank home by Israeli settlers',
        sourceId: 'pbs-newshour',
      }),
    );

    const summary = runClusteringPass(db, config(0.1), '2026-08-14T12:00:00.000Z');
    expect(summary.groupsFound).toBe(0);
    expect(summary.clustersCreated).toBe(0);
    expect(summary.membershipsWritten).toBe(0);
    expect((db.prepare('select count(*) as n from clusters').get() as { n: number }).n).toBe(0);
  });
});

describe('runClusteringPass -- config-driven threshold actually flows through end to end', () => {
  function twoRealNearDuplicates(db: ReturnType<typeof migratedDb>) {
    insertItem(
      db,
      baseItem({
        url: 'https://npr.org/settlers',
        canonicalUrl: 'https://npr.org/settlers',
        title: "U.S. ambassador calls settler siege of Palestinian homes a 'horrific act of terror'",
        sourceId: 'npr-news',
      }),
    );
    insertItem(
      db,
      baseItem({
        url: 'https://pbs.org/settlers',
        canonicalUrl: 'https://pbs.org/settlers',
        title: "'Act of terror': U.S. condemns Israeli settler siege of Palestinian homes in West Bank",
        sourceId: 'pbs-newshour',
      }),
    );
  }

  it('a strict threshold (1.0) leaves even a real true pair unclustered', () => {
    const db = migratedDb();
    twoRealNearDuplicates(db);
    const summary = runClusteringPass(db, config(1.0), '2026-08-14T12:00:00.000Z');
    expect(summary.groupsFound).toBe(0);
  });

  it('a permissive threshold (0.0) clusters everything, including the real pair', () => {
    const db = migratedDb();
    twoRealNearDuplicates(db);
    const summary = runClusteringPass(db, config(0), '2026-08-14T12:00:00.000Z');
    expect(summary.groupsFound).toBe(1);
    expect(summary.membershipsWritten).toBe(2);
  });

  it('the production threshold (0.1, the shipped config/cluster.yaml value) clusters the real pair', () => {
    const db = migratedDb();
    twoRealNearDuplicates(db);
    const summary = runClusteringPass(db, config(0.1), '2026-08-14T12:00:00.000Z');
    expect(summary.groupsFound).toBe(1);
  });
});

describe('runClusteringPass -- edge cases', () => {
  it('an empty database produces an all-zero summary and writes nothing', () => {
    const db = migratedDb();
    const summary = runClusteringPass(db, config(0.1), '2026-08-14T12:00:00.000Z');
    expect(summary).toEqual({
      candidatesConsidered: 0,
      groupsFound: 0,
      clustersCreated: 0,
      membershipsWritten: 0,
    });
  });

  it('re-running the pass later APPENDS rather than replacing -- proven through the orchestrator, not just writeClusters directly', () => {
    const db = migratedDb();
    const a = insertItem(
      db,
      baseItem({
        url: 'https://example.test/a',
        canonicalUrl: 'https://example.test/a',
        title: 'Kennedy Center board moves forward with renovations',
      }),
    );
    insertItem(
      db,
      baseItem({
        url: 'https://example.test/b',
        canonicalUrl: 'https://example.test/b',
        title: 'Kennedy Center board moves forward with a renovation plan',
      }),
    );

    const pass1At = '2026-08-14T10:00:00.000Z';
    runClusteringPass(db, config(0.3), pass1At);
    expect(getClusterSizeAsOf(db, a.item_key, pass1At)).toBe(2);

    // A third near-duplicate arrives later; re-running the pass discovers
    // the now-larger group under a fresh cluster_id.
    const c = insertItem(
      db,
      baseItem({
        url: 'https://example.test/c',
        canonicalUrl: 'https://example.test/c',
        title: 'Kennedy Center board moves forward with new renovation timeline',
      }),
    );
    const pass2At = '2026-08-14T14:00:00.000Z';
    runClusteringPass(db, config(0.3), pass2At);

    // The historical answer is unchanged...
    expect(getClusterSizeAsOf(db, a.item_key, pass1At)).toBe(2);
    // ...but the current answer reflects the grown cluster.
    expect(getClusterSizeAsOf(db, a.item_key, pass2At)).toBe(3);
    expect(getClusterSizeAsOf(db, c.item_key, pass2At)).toBe(3);
    expect((db.prepare('select count(*) as n from clusters').get() as { n: number }).n).toBe(2);
  });
});

describe('runClusteringPassFromConfigFile -- wiring against the REAL checked-in config/cluster.yaml', () => {
  it('produces the same result as loading the config manually and calling runClusteringPass', () => {
    const db1 = migratedDb();
    const db2 = migratedDb();
    for (const db of [db1, db2]) {
      insertItem(
        db,
        baseItem({
          url: 'https://npr.org/settlers',
          canonicalUrl: 'https://npr.org/settlers',
          title: "U.S. ambassador calls settler siege of Palestinian homes a 'horrific act of terror'",
          sourceId: 'npr-news',
        }),
      );
      insertItem(
        db,
        baseItem({
          url: 'https://pbs.org/settlers',
          canonicalUrl: 'https://pbs.org/settlers',
          title: "'Act of terror': U.S. condemns Israeli settler siege of Palestinian homes in West Bank",
          sourceId: 'pbs-newshour',
        }),
      );
    }

    const runAt = '2026-08-14T12:00:00.000Z';
    const viaFile = runClusteringPassFromConfigFile(db1, 'config/cluster.yaml', runAt);
    const viaManualConfig = runClusteringPass(db2, config(0.1), runAt);

    expect(viaFile).toEqual(viaManualConfig);
    expect(viaFile.groupsFound).toBe(1);
  });
});

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
    // Three DIFFERENT sources (fix round 1: cross-source-only, see
    // src/cluster/group.ts) -- were all three still `ap-news` (baseItem's
    // default), none of them could ever cluster with each other, and this
    // test could no longer demonstrate the append-only re-clustering
    // behavior it exists to prove.
    const db = migratedDb();
    const a = insertItem(
      db,
      baseItem({
        url: 'https://example.test/a',
        canonicalUrl: 'https://example.test/a',
        title: 'Kennedy Center board moves forward with renovations',
        sourceId: 'npr-news',
      }),
    );
    insertItem(
      db,
      baseItem({
        url: 'https://example.test/b',
        canonicalUrl: 'https://example.test/b',
        title: 'Kennedy Center board moves forward with a renovation plan',
        sourceId: 'pbs-newshour',
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
        sourceId: 'ap-news',
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

// =============================================================================
// FIX ROUND 1 -- end to end through the real orchestrator (not just
// group.test.ts's direct groupNearDuplicates calls). Real titles from the
// fresh 2026-08-14 ingest (data/wf.db, copied read-only, never written to);
// see task-4-report.md's fix-round-1 section and src/cluster/group.ts's
// module doc comment for the full mechanism and evidence.
// =============================================================================
describe('runClusteringPass -- fix round 1: real formulaic corpora no longer chain, end to end', () => {
  it('a real cisa-kev CVE chain does not collapse into one cluster when run through insertItem + runClusteringPass', () => {
    const db = migratedDb();
    const cves = [
      ['https://cisa.gov/kev/cve-1', 'Microsoft Windows Remote Code Execution Vulnerability'],
      ['https://cisa.gov/kev/cve-2', 'Oracle WebLogic Server Remote Code Execution Vulnerability'],
      ['https://cisa.gov/kev/cve-3', 'Oracle WebLogic Server OS Command Injection Vulnerability'],
      ['https://cisa.gov/kev/cve-4', 'Nagios XI OS Command Injection'],
    ] as const;
    for (const [url, title] of cves) {
      insertItem(db, baseItem({ url, canonicalUrl: url, title, sourceId: 'cisa-kev', beats: ['cyber'] }));
    }
    const summary = runClusteringPass(db, config(0.1), '2026-08-14T12:00:00.000Z');
    expect(summary.groupsFound).toBe(0);
    expect(summary.clustersCreated).toBe(0);
    expect(summary.membershipsWritten).toBe(0);
  });

  it('real cross-source items still cluster normally end to end -- the fix does not over-correct into never clustering anything', () => {
    // Real 3-outlet story from the SAME fresh 2026-08-14 ingest the fix-round
    // regression evidence came from (a Niger-missionary release), proving the
    // fix does not throw out genuine multi-source corroboration along with
    // the formulaic false positives.
    const db = migratedDb();
    const pbs = insertItem(
      db,
      baseItem({
        url: 'https://pbs.org/niger-missionary',
        canonicalUrl: 'https://pbs.org/niger-missionary',
        title: 'U.S. missionary kidnapped in Niger is released after 9 months in captivity, his organization says',
        sourceId: 'pbs-newshour',
      }),
    );
    const npr = insertItem(
      db,
      baseItem({
        url: 'https://npr.org/niger-missionary',
        canonicalUrl: 'https://npr.org/niger-missionary',
        title: 'U.S. missionary who was kidnapped in Niger is released',
        sourceId: 'npr-news',
      }),
    );
    const ap = insertItem(
      db,
      baseItem({
        url: 'https://apnews.com/niger-missionary',
        canonicalUrl: 'https://apnews.com/niger-missionary',
        title: 'US missionary kidnapped in Niger is released after 9 months in captivity',
        sourceId: 'ap-news',
      }),
    );
    const runAt = '2026-08-14T12:00:00.000Z';
    const summary = runClusteringPass(db, config(0.1), runAt);
    expect(summary.groupsFound).toBe(1);
    expect(getClusterSizeAsOf(db, pbs.item_key, runAt)).toBe(3);
    expect(getClusterSizeAsOf(db, npr.item_key, runAt)).toBe(3);
    expect(getClusterSizeAsOf(db, ap.item_key, runAt)).toBe(3);
  });

  it('max_bridge_document_frequency flows from ClusterConfig through runClusteringPass into the real grouping outcome -- not just relying on groupNearDuplicates own default', () => {
    // 8 different-source candidates sharing one artificially common phrase
    // (mirrors group.test.ts's synthetic isolation of this exact mechanism),
    // exercised here through the full insertItem -> runClusteringPass path.
    // Proof this is genuinely WIRED THROUGH runClusteringPass, not merely
    // "the code happens to work because groupNearDuplicates has its own
    // default": an EXPLICIT, non-default, too-loose cap (8, equal to this
    // phrase's exact document frequency in this fixture) is passed in
    // config, and it must actually change the outcome. If runClusteringPass
    // silently ignored config.max_bridge_document_frequency (e.g. always
    // called groupNearDuplicates with only two arguments), this specific
    // assertion would fail even though the default-cap test right above it
    // would still pass -- these two tests together are what makes the
    // wiring itself the thing under test, not just the default value.
    function insertWidgets(db: ReturnType<typeof migratedDb>) {
      for (let i = 0; i < 8; i++) {
        const url = `https://example.test/widget-${i}`;
        insertItem(
          db,
          baseItem({
            url,
            canonicalUrl: url,
            title: `Widget ${i} suffers boilerplate phrase failure today`,
            sourceId: `source-${i}`,
          }),
        );
      }
    }
    const runAt = '2026-08-14T12:00:00.000Z';

    // Default cap (5, omitted from config) -- correctly stays apart.
    const dbDefault = migratedDb();
    insertWidgets(dbDefault);
    const strict = runClusteringPass(dbDefault, { near_duplicate_threshold: 0.1 }, runAt);
    expect(strict.groupsFound).toBe(0);

    // Explicit, too-loose cap (8) -- must now incorrectly merge all 8, proving
    // runClusteringPass actually reads and forwards this config field.
    const dbLoose = migratedDb();
    insertWidgets(dbLoose);
    const loose = runClusteringPass(dbLoose, { near_duplicate_threshold: 0.1, max_bridge_document_frequency: 8 }, runAt);
    expect(loose.groupsFound).toBe(1);
    expect(loose.membershipsWritten).toBe(8);
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

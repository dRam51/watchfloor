import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, deriveItemKey, InvalidTimestampError, type NewItem } from '../../src/domain/item.ts';
import { runClusteringPass } from '../../src/cluster/run.ts';
import { loadSourcesFile, type Source } from '../../src/sources/load.ts';
import { loadInterestsFile } from '../../src/interests/load.ts';
import {
  loadMechanicalScoreConfig,
  computeMechanicalScore,
  getLatestItemScore,
  type MechanicalScoreConfig,
  type ScoreItemDeps,
} from '../../src/score/mechanical.ts';
import {
  listAllItemKeys,
  isFullyScored,
  runScoringPass,
  runScoringPassFromConfigFiles,
} from '../../src/score/pass.ts';

// ---------------------------------------------------------------------------
// Temp-DB plumbing, mirroring tests/score/mechanical.test.ts / cluster/run.test.ts
// exactly (openDb -> runMigrations against the real db/migrations directory).
// Real temp-file SQLite, no mocks.
// ---------------------------------------------------------------------------
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

const NOW = '2026-08-14T00:00:00.000Z';
const LATER = '2026-08-14T01:00:00.000Z';
const MUCH_LATER = '2026-08-15T00:00:00.000Z';

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

function testSources(): Source[] {
  return [
    { id: 'ap-news', name: 'AP News', type: 'news_sitemap', url: 'https://example.test/ap', beats: ['usnews'], weight: 1.8, poll_interval: '15m', enabled: true, enrichment: true },
    { id: 'npr-news', name: 'NPR News', type: 'rss', url: 'https://example.test/npr', beats: ['usnews'], weight: 1.6, poll_interval: '1h', enabled: true, enrichment: true },
    { id: 'pbs-newshour', name: 'PBS NewsHour', type: 'rss', url: 'https://example.test/pbs', beats: ['usnews'], weight: 1.6, poll_interval: '2h', enabled: true, enrichment: true },
    { id: 'arxiv-cs-cr', name: 'arXiv cs.CR', type: 'atom', url: 'https://example.test/cr', beats: ['aisec'], weight: 0.9, poll_interval: '1d', enabled: true, enrichment: true },
    { id: 'arxiv-cs-ai', name: 'arXiv cs.AI', type: 'atom', url: 'https://example.test/ai', beats: ['ai'], weight: 0.9, poll_interval: '1d', enabled: true, enrichment: true },
    { id: 'cisa-kev', name: 'CISA KEV', type: 'json', url: 'https://example.test/kev', beats: ['cyber'], weight: 2.0, poll_interval: '30m', enabled: true, enrichment: true },
    { id: 'hn-algolia', name: 'Hacker News', type: 'json', url: 'https://example.test/hn', beats: ['ai'], weight: 0.9, poll_interval: '1h', enabled: true, enrichment: true },
  ];
}

// Mirrors tests/score/mechanical.test.ts's testConfig exactly -- round numbers
// chosen for trivial hand verification, independent of the real checked-in
// config/scoring.yaml (which the "real config" block below wires separately).
function testConfig(overrides: Partial<MechanicalScoreConfig> = {}): MechanicalScoreConfig {
  return {
    scorer_version: 'test-v0',
    source: { min_weight: 0, max_weight: 10, signal_weight: 4, read_weight: 2 },
    cluster: { saturation_size: 4, signal_weight: 4, read_weight: 1 },
    interest: { boost_gain: 1, suppress_gain: 1, multiplier_floor: 0, multiplier_ceiling: 5 },
    high_on_both: { signal_threshold: 5, read_threshold: 2 },
    portfolio: { portfolio_path: 'config/portfolio.yaml' },
    ...overrides,
  };
}

function testDeps(overrides: Partial<ScoreItemDeps> = {}): ScoreItemDeps {
  return {
    sources: testSources(),
    interestProfile: { boosts: [], suppressions: [] },
    config: testConfig(),
    ...overrides,
  };
}

function scoresRowCount(db: ReturnType<typeof migratedDb>): number {
  return (db.prepare('select count(*) as n from item_scores').get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// listAllItemKeys
// ---------------------------------------------------------------------------
describe('listAllItemKeys', () => {
  it('returns [] for an empty database', () => {
    const db = migratedDb();
    expect(listAllItemKeys(db)).toEqual([]);
  });

  it('returns each distinct item_key exactly once, even with multiple versions', () => {
    const db = migratedDb();
    const a = insertItem(db, baseItem({ url: 'https://example.test/a', canonicalUrl: 'https://example.test/a' }));
    insertItem(db, baseItem({ url: 'https://example.test/a', canonicalUrl: 'https://example.test/a', title: 'A, corrected', fetchedAt: LATER }));
    const b = insertItem(db, baseItem({ url: 'https://example.test/b', canonicalUrl: 'https://example.test/b' }));
    expect(listAllItemKeys(db).sort()).toEqual([a.item_key, b.item_key].sort());
  });
});

// ---------------------------------------------------------------------------
// isFullyScored
// ---------------------------------------------------------------------------
describe('isFullyScored', () => {
  it('vacuously true for an empty beat list -- nothing to check', () => {
    const db = migratedDb();
    expect(isFullyScored(db, 'any-key-at-all', [], 'v1')).toBe(true);
  });

  it('false when the item_key has never been scored at all', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    expect(isFullyScored(db, item.item_key, ['usnews'], 'v1')).toBe(false);
  });

  it('true once every listed beat has a row under the given scorer_version', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    runScoringPass(db, testDeps({ config: testConfig({ scorer_version: 'v1' }) }), NOW);
    expect(isFullyScored(db, item.item_key, ['usnews'], 'v1')).toBe(true);
  });

  it('false when scored under a DIFFERENT scorer_version', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    runScoringPass(db, testDeps({ config: testConfig({ scorer_version: 'v1' }) }), NOW);
    expect(isFullyScored(db, item.item_key, ['usnews'], 'v2')).toBe(false);
  });

  it('false when only SOME of the listed beats have a current-version row (the new-beat-on-an-old-item_key case)', () => {
    const db = migratedDb();
    // v1 of this item_key only carries `aisec` -- score it.
    const cr = insertItem(db, baseItem({ url: 'https://arxiv.org/abs/x', canonicalUrl: 'https://arxiv.org/abs/x', sourceId: 'arxiv-cs-cr', beats: ['aisec'] }));
    runScoringPass(db, testDeps({ config: testConfig({ scorer_version: 'v1' }) }), NOW);
    expect(isFullyScored(db, cr.item_key, ['aisec'], 'v1')).toBe(true);

    // A second item_id for the SAME item_key arrives later, adding `ai` (the
    // real arXiv cs.AI/cs.CR cross-listing shape) -- the item_key's current
    // beat set is now ['aisec', 'ai'], but only 'aisec' has ever been scored.
    insertItem(db, baseItem({ url: 'https://arxiv.org/abs/x', canonicalUrl: 'https://arxiv.org/abs/x', sourceId: 'arxiv-cs-ai', beats: ['ai'], fetchedAt: LATER }));
    expect(isFullyScored(db, cr.item_key, ['aisec', 'ai'], 'v1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runScoringPass -- basic shape
// ---------------------------------------------------------------------------
describe('runScoringPass -- basic shape', () => {
  it('an empty database produces an all-zero summary and writes nothing', () => {
    const db = migratedDb();
    const summary = runScoringPass(db, testDeps(), NOW);
    expect(summary).toEqual({
      scorerVersion: 'test-v0',
      candidatesConsidered: 0,
      itemsScored: 0,
      itemsSkipped: 0,
      rowsWritten: 0,
      failures: [],
    });
  });

  it('throws InvalidTimestampError for a malformed `now`, same contract as scoreItem', () => {
    const db = migratedDb();
    expect(() => runScoringPass(db, testDeps(), 'not-a-timestamp')).toThrow(InvalidTimestampError);
  });

  it('scores a single fresh item, writing one row per beat', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ beats: ['usnews'] }));
    const summary = runScoringPass(db, testDeps(), NOW);
    expect(summary.candidatesConsidered).toBe(1);
    expect(summary.itemsScored).toBe(1);
    expect(summary.itemsSkipped).toBe(0);
    expect(summary.rowsWritten).toBe(1);
    expect(summary.failures).toEqual([]);
  });

  it('an item with ZERO beats is skipped, not scored, not a failure', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ beats: [] }));
    const summary = runScoringPass(db, testDeps(), NOW);
    expect(summary.candidatesConsidered).toBe(1);
    expect(summary.itemsScored).toBe(0);
    expect(summary.itemsSkipped).toBe(1);
    expect(summary.rowsWritten).toBe(0);
    expect(scoresRowCount(db)).toBe(0);
  });

  it('a cross-listed item (two beats via two item_ids sharing one item_key) writes BOTH beats\' rows in one pass', () => {
    const db = migratedDb();
    const ARXIV_URL = 'https://arxiv.org/abs/2608.11274';
    insertItem(db, baseItem({ url: ARXIV_URL, canonicalUrl: ARXIV_URL, sourceId: 'arxiv-cs-cr', beats: ['aisec'], fetchedAt: NOW }));
    insertItem(db, baseItem({ url: ARXIV_URL, canonicalUrl: ARXIV_URL, sourceId: 'arxiv-cs-ai', beats: ['ai'], fetchedAt: NOW }));
    const summary = runScoringPass(db, testDeps(), NOW);
    expect(summary.candidatesConsidered).toBe(1); // one item_key
    expect(summary.itemsScored).toBe(1);
    expect(summary.rowsWritten).toBe(2); // one row per beat
  });

  it('INVARIANT: itemsScored + itemsSkipped + failures.length always equals candidatesConsidered', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ url: 'https://example.test/1', canonicalUrl: 'https://example.test/1', beats: ['usnews'] })); // scored
    insertItem(db, baseItem({ url: 'https://example.test/2', canonicalUrl: 'https://example.test/2', beats: [] })); // skipped (no beats)
    insertItem(db, baseItem({ url: 'https://example.test/3', canonicalUrl: 'https://example.test/3', beats: ['cyber'], sourceId: 'not-a-real-source' })); // failure
    const summary = runScoringPass(db, testDeps(), NOW);
    expect(summary.candidatesConsidered).toBe(3);
    expect(summary.itemsScored + summary.itemsSkipped + summary.failures.length).toBe(summary.candidatesConsidered);
  });
});

// ---------------------------------------------------------------------------
// runScoringPass -- "unscored" and safe re-running (constraint 2, the heart
// of this task)
// ---------------------------------------------------------------------------
describe('runScoringPass -- re-running is safe and predictable', () => {
  it('RUNNING TWICE IN A ROW DOES NOT DOUBLE THE TABLE: identical scorer_version, no new items, no --force', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ url: 'https://example.test/1', canonicalUrl: 'https://example.test/1', beats: ['usnews'] }));
    insertItem(db, baseItem({ url: 'https://example.test/2', canonicalUrl: 'https://example.test/2', beats: ['cyber'], sourceId: 'cisa-kev' }));

    const first = runScoringPass(db, testDeps(), NOW);
    expect(first.itemsScored).toBe(2);
    const rowsAfterFirst = scoresRowCount(db);
    expect(rowsAfterFirst).toBe(2);

    const second = runScoringPass(db, testDeps(), LATER);
    expect(second.itemsScored).toBe(0);
    expect(second.itemsSkipped).toBe(2);
    expect(second.rowsWritten).toBe(0);
    expect(scoresRowCount(db)).toBe(rowsAfterFirst); // UNCHANGED -- the table did not grow
  });

  it('a THIRD, FOURTH, ... run stays a no-op too -- not merely "safe once"', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ beats: ['usnews'] }));
    runScoringPass(db, testDeps(), NOW);
    runScoringPass(db, testDeps(), LATER);
    runScoringPass(db, testDeps(), MUCH_LATER);
    expect(scoresRowCount(db)).toBe(1);
  });

  it('BUMPING scorer_version TRIGGERS A FULL RESCORE AUTOMATICALLY, with no --force needed', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ url: 'https://example.test/1', canonicalUrl: 'https://example.test/1', beats: ['usnews'] }));
    insertItem(db, baseItem({ url: 'https://example.test/2', canonicalUrl: 'https://example.test/2', beats: ['cyber'], sourceId: 'cisa-kev' }));

    const v1 = runScoringPass(db, testDeps({ config: testConfig({ scorer_version: 'v1' }) }), NOW);
    expect(v1.itemsScored).toBe(2);
    expect(scoresRowCount(db)).toBe(2);

    const v2 = runScoringPass(db, testDeps({ config: testConfig({ scorer_version: 'v2' }) }), LATER);
    expect(v2.itemsScored).toBe(2); // every item_key rescored under the new version
    expect(v2.itemsSkipped).toBe(0);
    expect(scoresRowCount(db)).toBe(4); // v1's rows are untouched, not replaced -- append-only

    // Both versions' rows genuinely coexist -- the old score is not deleted or overwritten.
    const versions = (db.prepare('select distinct scorer_version from item_scores order by scorer_version').all() as Array<{ scorer_version: string }>).map((r) => r.scorer_version);
    expect(versions).toEqual(['v1', 'v2']);
  });

  it('--force RESCORES EVERYTHING EVEN WHEN ALREADY UP TO DATE -- demonstrating rescoring with zero refetch', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ beats: ['usnews'] }));
    const deps = testDeps();

    const first = runScoringPass(db, deps, NOW);
    expect(first.itemsScored).toBe(1);
    expect(scoresRowCount(db)).toBe(1);

    // No new ingest happened anywhere between these two calls -- the exact
    // shape of "rescoring requires no refetch": the same already-ingested
    // item_key gets a brand-new score row from nothing but a later `now`
    // and the force flag.
    const forced = runScoringPass(db, deps, LATER, { force: true });
    expect(forced.itemsScored).toBe(1);
    expect(forced.itemsSkipped).toBe(0);
    expect(scoresRowCount(db)).toBe(2); // appended, not replaced

    const rows = db.prepare('select computed_at from item_scores order by computed_at').all() as Array<{ computed_at: string }>;
    expect(rows.map((r) => r.computed_at)).toEqual([NOW, LATER]);
  });

  it('a NEW BEAT on an already-fully-scored item_key is picked up on the next plain (non-force) pass', () => {
    const db = migratedDb();
    const ARXIV_URL = 'https://arxiv.org/abs/2608.11274';
    const item = insertItem(db, baseItem({ url: ARXIV_URL, canonicalUrl: ARXIV_URL, sourceId: 'arxiv-cs-cr', beats: ['aisec'], fetchedAt: NOW }));

    const first = runScoringPass(db, testDeps(), NOW);
    expect(first.itemsScored).toBe(1);
    expect(first.rowsWritten).toBe(1);

    // A cross-listed cs.AI version of the SAME paper lands later, adding a beat.
    insertItem(db, baseItem({ url: ARXIV_URL, canonicalUrl: ARXIV_URL, sourceId: 'arxiv-cs-ai', beats: ['ai'], fetchedAt: LATER }));

    const second = runScoringPass(db, testDeps(), MUCH_LATER); // plain pass, no --force
    expect(second.itemsScored).toBe(1); // the item_key is due again -- the 'ai' beat has no row yet
    expect(second.rowsWritten).toBe(2); // scoreItem writes BOTH of its now-current beats

    // Both beats are independently readable via getLatestItemScore.
    expect(getLatestItemScore(db, item.item_key, 'aisec')).not.toBeNull();
    expect(getLatestItemScore(db, item.item_key, 'ai')).not.toBeNull();
  });

  it('a bare re-delivery (same item_key, same beats, new item_id) does NOT trigger a rescore -- the existing score is still valid and re-detected as up to date', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    const first = runScoringPass(db, testDeps(), NOW);
    expect(first.itemsScored).toBe(1);

    // insertItem never dedupes on content -- a re-delivered, unchanged entry
    // (e.g. cisa-kev re-dumping its catalog) still lands a brand-new item_id.
    insertItem(db, baseItem({ url: item.url, canonicalUrl: item.canonicalUrl, beats: ['usnews'], fetchedAt: LATER }));

    const second = runScoringPass(db, testDeps(), MUCH_LATER);
    expect(second.itemsScored).toBe(0);
    expect(second.itemsSkipped).toBe(1);
    expect(scoresRowCount(db)).toBe(1); // still just the one score from the first pass
  });
});

// ---------------------------------------------------------------------------
// runScoringPass -- per-item failure isolation
// ---------------------------------------------------------------------------
describe('runScoringPass -- one bad item never takes down the pass', () => {
  it('isolates a per-item UnknownSourceError, recording it in `failures` while scoring every other item normally', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ url: 'https://example.test/good', canonicalUrl: 'https://example.test/good', beats: ['usnews'], sourceId: 'ap-news' }));
    const bad = insertItem(db, baseItem({ url: 'https://example.test/bad', canonicalUrl: 'https://example.test/bad', beats: ['cyber'], sourceId: 'source-removed-from-config' }));

    const summary = runScoringPass(db, testDeps(), NOW);
    expect(summary.candidatesConsidered).toBe(2);
    expect(summary.itemsScored).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]!.itemKey).toBe(bad.item_key);
    expect(summary.failures[0]!.error).toMatch(/source-removed-from-config/);

    // The good item's row genuinely landed despite the bad item's failure.
    expect(scoresRowCount(db)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runScoringPass -- the clustering dependency is EXPLICIT, not implicit
// (constraint 4)
// ---------------------------------------------------------------------------
describe("runScoringPass -- does not run clustering itself; ordering is the caller's responsibility", () => {
  // Real titles, real near-duplicate pair (verified at threshold 0.10 by
  // tests/cluster/run.test.ts's own "Mangione three-way hub" case) --
  // provenance: attic/wf-m1-firstrun-2026-08-14.db, npr-news + pbs-newshour.
  function insertMangionePair(db: ReturnType<typeof migratedDb>) {
    const npr = insertItem(
      db,
      baseItem({
        url: 'https://npr.org/mangione',
        canonicalUrl: 'https://npr.org/mangione',
        title: 'Mangione could plead guilty in federal case ahead of N.Y. murder trial',
        sourceId: 'npr-news',
        beats: ['usnews'],
      }),
    );
    const pbs = insertItem(
      db,
      baseItem({
        url: 'https://pbs.org/mangione',
        canonicalUrl: 'https://pbs.org/mangione',
        title: 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing',
        sourceId: 'pbs-newshour',
        beats: ['usnews'],
      }),
    );
    return { npr, pbs };
  }

  it('scoring BEFORE clustering has ever run leaves every item at clusterSize=1 (singleton), even for a genuine near-duplicate pair', () => {
    const db = migratedDb();
    const { npr, pbs } = insertMangionePair(db);
    runScoringPass(db, testDeps(), NOW); // no clustering pass has EVER run

    const nprScore = getLatestItemScore(db, npr.item_key, 'usnews')!;
    const pbsScore = getLatestItemScore(db, pbs.item_key, 'usnews')!;

    // Both sources share weight 1.6 in testSources() -- at clusterSize=1
    // (the singleton baseline), computeMechanicalScore gives the exact
    // number both stored rows must match if clustering never ran.
    const baseline = computeMechanicalScore({ sourceWeight: 1.6, clusterSize: 1, interestMatches: { boosts: [], suppressions: [] } }, testConfig());
    expect(nprScore.signalScore).toBeCloseTo(baseline.signalScore, 10);
    expect(pbsScore.signalScore).toBeCloseTo(baseline.signalScore, 10);
  });

  it('CLUSTERING THEN SCORING (explicit order) makes the multi-source pair outrank an identical single-source item -- proving the dependency is real', () => {
    const db = migratedDb();
    const { npr, pbs } = insertMangionePair(db);
    const unrelated = insertItem(
      db,
      baseItem({
        url: 'https://npr.org/unrelated',
        canonicalUrl: 'https://npr.org/unrelated',
        title: 'Local bakery wins regional pastry award',
        sourceId: 'npr-news',
        beats: ['usnews'],
      }),
    );

    // Step 1: cluster (explicit, caller-driven -- exactly what src/bin/score.ts does).
    const clusterSummary = runClusteringPass(db, { near_duplicate_threshold: 0.1 }, NOW);
    expect(clusterSummary.groupsFound).toBe(1);

    // Step 2: score, at or after the clustering pass's own runAt.
    const scoreSummary = runScoringPass(db, testDeps(), NOW);
    expect(scoreSummary.itemsScored).toBe(3);

    const nprScore = getLatestItemScore(db, npr.item_key, 'usnews')!;
    const pbsScore = getLatestItemScore(db, pbs.item_key, 'usnews')!;
    const unrelatedScore = getLatestItemScore(db, unrelated.item_key, 'usnews')!;

    // npr's "unrelated" item and the clustered npr/pbs pair share the
    // IDENTICAL source weight (npr-news, 1.6) -- they differ ONLY in cluster
    // size, so this isolates exactly the signal the M2 acceptance question
    // asks about: does a multi-source story outrank a single-source one.
    expect(nprScore.signalScore).toBeGreaterThan(unrelatedScore.signalScore);
    expect(pbsScore.signalScore).toBeGreaterThan(unrelatedScore.signalScore);
  });

  it('the pass itself never calls runClusteringPass -- grep-level proof, not just behavioural', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'score', 'pass.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*cluster\/run\.ts['"]/);
    expect(source).not.toMatch(/\brunClusteringPass\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// runScoringPass -- NEVER applies decay (constraint 1), mirroring
// tests/score/mechanical.test.ts's identical grep-level proof
// ---------------------------------------------------------------------------
describe('runScoringPass -- never applies or stores a decayed value', () => {
  it('this module never imports src/score/decay.ts and never calls decayFactor/computeDecayFactor', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'score', 'pass.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*decay\.ts['"]/);
    expect(source).not.toMatch(/\bdecayFactor\s*\(/);
    expect(source).not.toMatch(/\bcomputeDecayFactor\s*\(/);
  });

  it('behavioural proof: scoring the identical item at two `now` values months apart produces IDENTICAL stored scores', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ publishedAt: '2026-03-01T00:00:00.000Z', fetchedAt: '2026-03-01T00:00:00.000Z', beats: ['usnews'] }));
    runScoringPass(db, testDeps({ config: testConfig({ scorer_version: 'v1' }) }), '2026-03-01T01:00:00.000Z');
    const soon = getLatestItemScore(db, item.item_key, 'usnews')!;

    runScoringPass(db, testDeps({ config: testConfig({ scorer_version: 'v2' }) }), '2026-08-14T00:00:00.000Z');
    const muchLater = getLatestItemScore(db, item.item_key, 'usnews')!;

    expect(muchLater.signalScore).toBe(soon.signalScore);
    expect(muchLater.readScore).toBe(soon.readScore);
  });
});

// ---------------------------------------------------------------------------
// runScoringPassFromConfigFiles -- wiring against the REAL checked-in config
// ---------------------------------------------------------------------------
describe('runScoringPassFromConfigFiles -- real config wiring', () => {
  const paths = {
    sourcesPath: join(process.cwd(), 'config', 'sources.yaml'),
    interestsPath: join(process.cwd(), 'config', 'interests.yaml'),
    scoringConfigPath: join(process.cwd(), 'config', 'scoring.yaml'),
  };

  it('produces the same result as loading each config manually and calling runScoringPass', () => {
    const db1 = migratedDb();
    const db2 = migratedDb();
    for (const db of [db1, db2]) {
      insertItem(db, baseItem({ beats: ['usnews'], sourceId: 'ap-news' }));
    }

    const viaFile = runScoringPassFromConfigFiles(db1, paths, NOW);
    const viaManual = runScoringPass(
      db2,
      { sources: loadSourcesFile(paths.sourcesPath), interestProfile: loadInterestsFile(paths.interestsPath), config: loadMechanicalScoreConfig(paths.scoringConfigPath) },
      NOW,
    );

    expect(viaFile).toEqual(viaManual);
    // mechanical-v1 -> mechanical-v2 on 2026-08-14 (M4a task 7): the formula
    // gained the repos lane's velocity and HN-overlap terms, so config/
    // scoring.yaml's scorer_version was bumped per its own documented
    // convention. No non-repo item's score changed; only the version string did.
    expect(viaFile.scorerVersion).toBe('mechanical-v2');
    expect(viaFile.itemsScored).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// REAL CORPUS: a realistic multi-source, multi-beat slice, wired against the
// REAL checked-in config files end to end. Real titles/urls/source_ids from
// attic/wf-m1-firstrun-2026-08-14.db (read-only, never opened by this test --
// hand-copied per this codebase's established convention, e.g.
// tests/cluster/run.test.ts, tests/score/mechanical.test.ts). cisa-kev's
// publishedAt is SYNTHETIC (the archived row's own published_at is NULL --
// a pre-fix artifact this project's own progress ledger documents at length;
// a fresh ingest today carries a real date) -- labelled as such, matching
// tests/domain/itemEntities.test.ts's "real items, synthetic [field]"
// convention.
// ---------------------------------------------------------------------------
describe('runScoringPass -- a realistic multi-source corpus, real config, no crashes', () => {
  it('scores a 6-item, 4-source, 3-beat slice with zero failures despite real messy shapes (a null-published_at government feed, real AP wire content, a real arXiv title)', () => {
    const db = migratedDb();
    const sources = loadSourcesFile(join(process.cwd(), 'config', 'sources.yaml'));
    const interestProfile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
    const config = loadMechanicalScoreConfig(join(process.cwd(), 'config', 'scoring.yaml'));

    const ap = insertItem(db, baseItem({
      url: 'https://apnews.com/mangione', canonicalUrl: 'https://apnews.com/mangione',
      title: 'Luigi Mangione expected to plead guilty in killing of UnitedHealthcare CEO',
      sourceId: 'ap-news', beats: ['usnews'], itemType: 'analysis',
      publishedAt: '2026-08-13T18:00:00.000Z',
    }));
    const npr = insertItem(db, baseItem({
      url: 'https://npr.org/mangione', canonicalUrl: 'https://npr.org/mangione',
      title: 'Mangione could plead guilty in federal case ahead of N.Y. murder trial',
      sourceId: 'npr-news', beats: ['usnews'], itemType: 'analysis',
      publishedAt: '2026-08-13T17:30:00.000Z',
    }));
    const kev = insertItem(db, baseItem({
      // Real cisa-kev shape: real title/url, but publishedAt is NULL in the
      // archive (pre-fix artifact) -- kept null here deliberately, to prove
      // the pass handles it (decay's own null-fallback, not this pass's
      // concern, but the ROW must still score without throwing).
      url: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
      canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
      title: 'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) Heap Inspection Vulnerability',
      sourceId: 'cisa-kev', beats: ['cyber'], itemType: 'event',
      publishedAt: null,
    }));
    const arxiv = insertItem(db, baseItem({
      url: 'https://arxiv.org/abs/2512.08417', canonicalUrl: 'https://arxiv.org/abs/2512.08417',
      title: 'Attention is All You Need to Defend Against Indirect Prompt Injection Attacks in LLMs',
      sourceId: 'arxiv-cs-cr', beats: ['aisec'], itemType: 'analysis',
      publishedAt: '2026-08-13T04:00:00.000Z',
    }));
    const sports = insertItem(db, baseItem({
      url: 'https://apnews.com/steelers-preseason', canonicalUrl: 'https://apnews.com/steelers-preseason',
      title: 'Steelers rookie Drew Allar impresses with 3 touchdowns in preseason win against Packers',
      sourceId: 'ap-news', beats: ['usnews'], itemType: 'analysis',
      publishedAt: '2026-08-13T20:00:00.000Z',
    }));
    const hn = insertItem(db, baseItem({
      url: 'http://bbc.com/news/uk-43396008', canonicalUrl: 'http://bbc.com/news/uk-43396008',
      title: 'Stephen Hawking has died', sourceId: 'hn-algolia', beats: ['ai'], itemType: 'analysis',
      publishedAt: '2018-03-14T03:50:30.000Z',
    }));

    // Cluster first (constraint 4), matching src/bin/score.ts's own ordering.
    runClusteringPass(db, { near_duplicate_threshold: 0.1 }, NOW);
    const summary = runScoringPass(db, { sources, interestProfile, config }, NOW);

    expect(summary.candidatesConsidered).toBe(6);
    expect(summary.failures).toEqual([]);
    expect(summary.itemsScored).toBe(6);
    expect(summary.rowsWritten).toBe(6); // one beat each

    // Every item is genuinely readable back out.
    expect(getLatestItemScore(db, ap.item_key, 'usnews')).not.toBeNull();
    expect(getLatestItemScore(db, npr.item_key, 'usnews')).not.toBeNull();
    expect(getLatestItemScore(db, kev.item_key, 'cyber')).not.toBeNull();
    expect(getLatestItemScore(db, arxiv.item_key, 'aisec')).not.toBeNull();
    expect(getLatestItemScore(db, sports.item_key, 'usnews')).not.toBeNull();
    expect(getLatestItemScore(db, hn.item_key, 'ai')).not.toBeNull();
    expect(deriveItemKey(ap.canonicalUrl)).toBe(ap.item_key); // sanity: deriveItemKey is the real, importable identity function

    // The suppressed sports headline (real "preseason" match, per
    // mechanical.test.ts's own worked example) scores below the clustered
    // Mangione pair -- the concrete shape of the M2 acceptance question.
    const mangione = getLatestItemScore(db, ap.item_key, 'usnews')!;
    const sportsScore = getLatestItemScore(db, sports.item_key, 'usnews')!;
    expect(mangione.signalScore).toBeGreaterThan(sportsScore.signalScore);
  });
});

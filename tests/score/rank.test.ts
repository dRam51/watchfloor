import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type NewItem, type ItemType } from '../../src/domain/item.ts';
import { runClusteringPass } from '../../src/cluster/run.ts';
import { scoreItem, type MechanicalScoreConfig, type ScoreItemDeps } from '../../src/score/mechanical.ts';
import { runScoringPass } from '../../src/score/pass.ts';
import type { DecayConfig } from '../../src/score/decay.ts';
import { loadOverridesConfig, type OverridesConfig, type OverrideResult } from '../../src/score/overrides.ts';
import {
  getItemKeysForBeat,
  buildRankedItems,
  sortRanked,
  rankBeat,
  loadRankDepsFromConfigFiles,
  type RankedItem,
  type RankDeps,
} from '../../src/score/rank.ts';

// ---------------------------------------------------------------------------
// Temp-DB plumbing, mirroring every other M2 score/cluster test file.
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

const T0 = '2026-08-14T00:00:00.000Z';
const T1 = '2026-08-14T01:00:00.000Z';
const T2 = '2026-08-14T02:00:00.000Z';
const T3 = '2026-08-14T03:00:00.000Z';

function baseItem(overrides: Partial<NewItem> = {}): NewItem {
  return {
    url: 'https://example.test/a',
    canonicalUrl: 'https://example.test/a',
    title: 'A title',
    sourceId: 'ap-news',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    publishedAt: T0,
    fetchedAt: T0,
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

function testScoreConfig(overrides: Partial<MechanicalScoreConfig> = {}): MechanicalScoreConfig {
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

function testScoreDeps(): ScoreItemDeps {
  return {
    sources: [
      { id: 'ap-news', name: 'AP News', type: 'news_sitemap', url: 'https://example.test/ap', beats: ['usnews'], weight: 1.8, poll_interval: '15m', enabled: true, enrichment: true },
      { id: 'npr-news', name: 'NPR News', type: 'rss', url: 'https://example.test/npr', beats: ['usnews'], weight: 1.6, poll_interval: '1h', enabled: true, enrichment: true },
      { id: 'pbs-newshour', name: 'PBS NewsHour', type: 'rss', url: 'https://example.test/pbs', beats: ['usnews'], weight: 1.6, poll_interval: '2h', enabled: true, enrichment: true },
      { id: 'arxiv-cs-cr', name: 'arXiv cs.CR', type: 'atom', url: 'https://example.test/cr', beats: ['aisec'], weight: 0.9, poll_interval: '1d', enabled: true, enrichment: true },
      { id: 'arxiv-cs-ai', name: 'arXiv cs.AI', type: 'atom', url: 'https://example.test/ai', beats: ['ai'], weight: 0.9, poll_interval: '1d', enabled: true, enrichment: true },
      { id: 'cisa-kev', name: 'CISA KEV', type: 'json', url: 'https://example.test/kev', beats: ['cyber'], weight: 2.0, poll_interval: '30m', enabled: true, enrichment: true },
    ],
    interestProfile: { boosts: [], suppressions: [] },
    config: testScoreConfig(),
  };
}

// A hand-built decay config with round, easy-to-verify half-lives -- mirrors
// tests/score/decay.test.ts's own testConfig convention. usnews/cyber/aisec/ai
// covered since those are the beats exercised below; markets omitted
// (unreachable -- M2 ingests nothing there).
function testDecayConfig(): DecayConfig {
  const pair = { signal_half_life_hours: 24, read_half_life_hours: 168 };
  return {
    beats: { ai: pair, cyber: pair, aisec: pair, repos: pair, usnews: pair },
    markets_item_types: { event: pair, analysis: pair, press: pair },
  };
}

// No enabled rules -- an empty overrides array is rejected by the real Zod
// schema (`.min(1)`), so this carries exactly one DISABLED rule, matching
// config/overrides.yaml's own convention for a rule that must never fire.
function noOverridesConfig(): OverridesConfig {
  return {
    overrides: [
      {
        id: 'disabled-placeholder',
        label: 'disabled placeholder',
        kind: 'source_match',
        source_id: 'nonexistent-source',
        recency_bound_days: 1,
        applies_to: ['signal'],
        priority: 1,
        enabled: false,
        note: 'test fixture: intentionally disabled so nothing this module does ever fires it',
      },
    ],
  };
}

function testRankDeps(overridesConfig: OverridesConfig = noOverridesConfig()): RankDeps {
  return { decayConfig: testDecayConfig(), overridesConfig };
}

function scoresRowCount(db: ReturnType<typeof migratedDb>): number {
  return (db.prepare('select count(*) as n from item_scores').get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// getItemKeysForBeat
// ---------------------------------------------------------------------------
describe('getItemKeysForBeat', () => {
  it('returns [] when no item is attributed to this beat', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ beats: ['usnews'] }));
    expect(getItemKeysForBeat(db, 'cyber')).toEqual([]);
  });

  it('a beat attributed via a DIFFERENT item_id sharing the same item_key still counts (the arXiv cross-listing shape)', () => {
    const db = migratedDb();
    const ARXIV_URL = 'https://arxiv.org/abs/2608.11274';
    const cr = insertItem(db, baseItem({ url: ARXIV_URL, canonicalUrl: ARXIV_URL, sourceId: 'arxiv-cs-cr', beats: ['aisec'], fetchedAt: T0 }));
    insertItem(db, baseItem({ url: ARXIV_URL, canonicalUrl: ARXIV_URL, sourceId: 'arxiv-cs-ai', beats: ['ai'], fetchedAt: T1 }));

    expect(getItemKeysForBeat(db, 'aisec')).toEqual([cr.item_key]);
    expect(getItemKeysForBeat(db, 'ai')).toEqual([cr.item_key]); // SAME item_key, other beat
  });
});

// ---------------------------------------------------------------------------
// buildRankedItems -- excludes unscored candidates
// ---------------------------------------------------------------------------
describe('buildRankedItems -- only scored items appear', () => {
  it('an item attributed to a beat but never scored is excluded, not an error', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ beats: ['usnews'] })); // never scored
    const items = buildRankedItems(db, 'usnews', T0, testRankDeps());
    expect(items).toEqual([]);
  });

  it('a scored item appears exactly once per beat it is scored under', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    scoreItem(db, item.item_key, T0, testScoreDeps());
    const items = buildRankedItems(db, 'usnews', T0, testRankDeps());
    expect(items).toHaveLength(1);
    expect(items[0]!.itemKey).toBe(item.item_key);
    expect(items[0]!.title).toBe('A title');
    expect(items[0]!.sourceId).toBe('ap-news');
  });
});

// ---------------------------------------------------------------------------
// buildRankedItems -- decay is applied HERE, freshly, on every call
// (constraint 1: the one legitimate place decay enters this task)
// ---------------------------------------------------------------------------
describe('buildRankedItems -- decay applied fresh at read time, never stored', () => {
  it('the SAME stored score reads back with a SMALLER decayed value at a LATER `now` -- raw components never change', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'], publishedAt: T0, fetchedAt: T0 }));
    scoreItem(db, item.item_key, T0, testScoreDeps());

    const soon = buildRankedItems(db, 'usnews', T0, testRankDeps())[0]!;
    const muchLater = buildRankedItems(db, 'usnews', '2026-09-14T00:00:00.000Z', testRankDeps())[0]!;

    expect(muchLater.signalScoreRaw).toBe(soon.signalScoreRaw); // stored component: identical
    expect(muchLater.readScoreRaw).toBe(soon.readScoreRaw);
    expect(muchLater.signalDecayFactor).toBeLessThan(soon.signalDecayFactor); // decay: strictly less
    expect(muchLater.signalScore).toBeLessThan(soon.signalScore);
    expect(soon.signalDecayFactor).toBeCloseTo(1, 6); // at t=publishedAt, decay factor is ~1
  });

  it('reading a ranking never writes to item_scores -- calling it repeatedly does not grow the table', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    scoreItem(db, item.item_key, T0, testScoreDeps());
    const before = scoresRowCount(db);

    buildRankedItems(db, 'usnews', T0, testRankDeps());
    buildRankedItems(db, 'usnews', T1, testRankDeps());
    rankBeat(db, 'usnews', T2, testRankDeps());

    expect(scoresRowCount(db)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// buildRankedItems -- cluster size is read AS OF the score's own computed_at,
// never `now` (a deliberate design choice, documented in rank.ts's header)
// ---------------------------------------------------------------------------
describe('buildRankedItems -- cluster size reflects the SCORE\'s own computed_at, not the read\'s `now`', () => {
  it('scoring BEFORE a later clustering pass keeps showing clusterSize=1 at read time, even when `now` is AFTER that clustering pass -- until the item is rescored', () => {
    const db = migratedDb();
    const npr = insertItem(db, baseItem({
      url: 'https://npr.org/mangione', canonicalUrl: 'https://npr.org/mangione',
      title: 'Mangione could plead guilty in federal case ahead of N.Y. murder trial',
      sourceId: 'npr-news', beats: ['usnews'],
    }));
    insertItem(db, baseItem({
      url: 'https://pbs.org/mangione', canonicalUrl: 'https://pbs.org/mangione',
      title: 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing',
      sourceId: 'pbs-newshour', beats: ['usnews'],
    }));

    // Score at T0 -- BEFORE any clustering pass has ever run.
    scoreItem(db, npr.item_key, T0, testScoreDeps());

    // Cluster at T1 -- AFTER the score's own computed_at (T0).
    const clusterSummary = runClusteringPass(db, { near_duplicate_threshold: 0.1 }, T1);
    expect(clusterSummary.groupsFound).toBe(1);

    // Read at T2 -- AFTER both. If this module used `now` for cluster size
    // it would (wrongly) see the T1 clustering pass; using the score's own
    // computed_at (T0) it correctly does NOT.
    const stillStale = buildRankedItems(db, 'usnews', T2, testRankDeps()).find((i) => i.itemKey === npr.item_key)!;
    expect(stillStale.clusterSize).toBe(1);

    // Rescore at T3 -- AFTER the clustering pass (T1 <= T3) -- the fresh
    // score's own computed_at now postdates clustering.
    scoreItem(db, npr.item_key, T3, testScoreDeps());
    const nowFresh = buildRankedItems(db, 'usnews', T3, testRankDeps()).find((i) => i.itemKey === npr.item_key)!;
    expect(nowFresh.clusterSize).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// sortRanked -- pure, hand-constructed fixtures (no DB): the general
// pinning/sorting algorithm, precisely controlled.
// ---------------------------------------------------------------------------
function noOverride(): OverrideResult {
  return { pinned: false, priority: null, matches: [] };
}
function pinnedOverride(id: string, priority: number): OverrideResult {
  return { pinned: true, priority, matches: [{ id, label: id, priority }] };
}

function fakeRanked(overrides: Partial<RankedItem> = {}): RankedItem {
  return {
    itemKey: 'key',
    itemId: 'id',
    title: 'title',
    sourceId: 'source',
    beat: 'usnews',
    publishedAt: T0,
    itemType: 'analysis' as ItemType,
    clusterSize: 1,
    scorerVersion: 'v1',
    computedAt: T0,
    signalScoreRaw: 1,
    readScoreRaw: 1,
    signalDecayFactor: 1,
    readDecayFactor: 1,
    signalScore: 1,
    readScore: 1,
    signalOverride: noOverride(),
    readOverride: noOverride(),
    ...overrides,
  };
}

describe('sortRanked -- pure algorithm', () => {
  it('with no overrides at all, sorts by the requested profile\'s decayed score, descending', () => {
    const low = fakeRanked({ itemKey: 'low', signalScore: 1 });
    const high = fakeRanked({ itemKey: 'high', signalScore: 9 });
    const mid = fakeRanked({ itemKey: 'mid', signalScore: 5 });
    const sorted = sortRanked([low, high, mid], 'signal');
    expect(sorted.map((i) => i.itemKey)).toEqual(['high', 'mid', 'low']);
  });

  it('a pinned item comes first EVEN WITH A LOWER SCORE than every non-pinned item -- the literal M2 acceptance question', () => {
    const highScoreNoOverride = fakeRanked({ itemKey: 'high-no-pin', signalScore: 100, signalOverride: noOverride() });
    const lowScorePinned = fakeRanked({ itemKey: 'low-pinned', signalScore: 0.01, signalOverride: pinnedOverride('cisa-kev-catalog', 30) });
    const sorted = sortRanked([highScoreNoOverride, lowScorePinned], 'signal');
    expect(sorted.map((i) => i.itemKey)).toEqual(['low-pinned', 'high-no-pin']);
  });

  it('two pinned items sort by priority ascending (lower pins first), regardless of score', () => {
    const priorityThirty = fakeRanked({ itemKey: 'p30', signalScore: 1, signalOverride: pinnedOverride('cisa-kev-catalog', 30) });
    const priorityTen = fakeRanked({ itemKey: 'p10', signalScore: 0, signalOverride: pinnedOverride('nws-nhc-alerts', 10) });
    const sorted = sortRanked([priorityThirty, priorityTen], 'signal');
    expect(sorted.map((i) => i.itemKey)).toEqual(['p10', 'p30']);
  });

  it('two pinned items with the SAME priority fall back to score, descending', () => {
    const a = fakeRanked({ itemKey: 'a', signalScore: 2, signalOverride: pinnedOverride('rule-a', 30) });
    const b = fakeRanked({ itemKey: 'b', signalScore: 9, signalOverride: pinnedOverride('rule-b', 30) });
    const sorted = sortRanked([a, b], 'signal');
    expect(sorted.map((i) => i.itemKey)).toEqual(['b', 'a']);
  });

  it('deterministic tie-break by title when scores AND pin status are equal', () => {
    const zebra = fakeRanked({ itemKey: 'z', title: 'Zebra', signalScore: 5 });
    const apple = fakeRanked({ itemKey: 'a', title: 'Apple', signalScore: 5 });
    const sorted = sortRanked([zebra, apple], 'signal');
    expect(sorted.map((i) => i.title)).toEqual(['Apple', 'Zebra']);
  });

  it("profile='read' sorts by readScore and pins by readOverride, INDEPENDENTLY of signal -- an item pinned only on signal does not jump the read-sorted queue", () => {
    const signalPinnedOnly = fakeRanked({
      itemKey: 'signal-pinned',
      signalScore: 0.01,
      readScore: 0.01,
      signalOverride: pinnedOverride('cisa-kev-catalog', 30),
      readOverride: noOverride(), // matches every shipped config/overrides.yaml rule: applies_to: [signal] only
    });
    const ordinary = fakeRanked({ itemKey: 'ordinary', signalScore: 0.01, readScore: 9 });
    const sortedByRead = sortRanked([signalPinnedOnly, ordinary], 'read');
    expect(sortedByRead.map((i) => i.itemKey)).toEqual(['ordinary', 'signal-pinned']);

    // The SAME two items sorted by signal DO put the pinned one first.
    const sortedBySignal = sortRanked([signalPinnedOnly, ordinary], 'signal');
    expect(sortedBySignal.map((i) => i.itemKey)).toEqual(['signal-pinned', 'ordinary']);
  });

  it('does not mutate its input array', () => {
    const items = [fakeRanked({ itemKey: 'a', signalScore: 1 }), fakeRanked({ itemKey: 'b', signalScore: 9 })];
    const original = [...items];
    sortRanked(items, 'signal');
    expect(items).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// rankBeat -- composition: candidateCount vs scoredCount, and end-to-end
// wiring with pass.ts's runScoringPass + cluster's runClusteringPass.
// ---------------------------------------------------------------------------
describe('rankBeat', () => {
  it('candidateCount counts every item attributed to the beat; scoredCount counts only the ones with a score row', () => {
    const db = migratedDb();
    insertItem(db, baseItem({ url: 'https://example.test/1', canonicalUrl: 'https://example.test/1', beats: ['usnews'] })); // scored below
    insertItem(db, baseItem({ url: 'https://example.test/2', canonicalUrl: 'https://example.test/2', beats: ['usnews'] })); // left unscored
    const scoredItem = insertItem(db, baseItem({ url: 'https://example.test/3', canonicalUrl: 'https://example.test/3', beats: ['usnews'] }));
    scoreItem(db, scoredItem.item_key, T0, testScoreDeps());

    const ranking = rankBeat(db, 'usnews', T0, testRankDeps());
    expect(ranking.beat).toBe('usnews');
    expect(ranking.candidateCount).toBe(3);
    expect(ranking.scoredCount).toBe(1);
    expect(ranking.items).toHaveLength(1);
    expect(ranking.items[0]!.itemKey).toBe(scoredItem.item_key);
  });

  it('end to end: cluster (cluster/run.ts) -> score (score/pass.ts) -> rank (score/rank.ts) produces a correctly ordered ranking', () => {
    const db = migratedDb();
    const npr = insertItem(db, baseItem({
      url: 'https://npr.org/mangione', canonicalUrl: 'https://npr.org/mangione',
      title: 'Mangione could plead guilty in federal case ahead of N.Y. murder trial',
      sourceId: 'npr-news', beats: ['usnews'],
    }));
    insertItem(db, baseItem({
      url: 'https://pbs.org/mangione', canonicalUrl: 'https://pbs.org/mangione',
      title: 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing',
      sourceId: 'pbs-newshour', beats: ['usnews'],
    }));
    const unrelated = insertItem(db, baseItem({
      url: 'https://npr.org/unrelated', canonicalUrl: 'https://npr.org/unrelated',
      title: 'Local bakery wins regional pastry award',
      sourceId: 'npr-news', beats: ['usnews'],
    }));

    runClusteringPass(db, { near_duplicate_threshold: 0.1 }, T0);
    runScoringPass(db, testScoreDeps(), T0);

    const ranking = rankBeat(db, 'usnews', T0, testRankDeps());
    expect(ranking.scoredCount).toBe(3);
    // The clustered pair (npr shares a source weight with `unrelated`) outranks the singleton.
    const nprEntry = ranking.items.find((i) => i.itemKey === npr.item_key)!;
    const unrelatedEntry = ranking.items.find((i) => i.itemKey === unrelated.item_key)!;
    expect(ranking.items.indexOf(nprEntry)).toBeLessThan(ranking.items.indexOf(unrelatedEntry));
    expect(nprEntry.signalScore).toBeGreaterThan(unrelatedEntry.signalScore);
  });
});

// ---------------------------------------------------------------------------
// Real overrides config: a real cisa-kev-shaped item is genuinely pinned by
// evaluateOverrides fed through the REAL config/overrides.yaml, and rankBeat
// puts it first.
// ---------------------------------------------------------------------------
describe('rankBeat -- real config/overrides.yaml wiring', () => {
  it('a real cisa-kev item within the recency bound is pinned and sorted first on signal', () => {
    const db = migratedDb();
    const overridesConfig = loadOverridesConfig(join(process.cwd(), 'config', 'overrides.yaml'));

    // Real title/url (attic/wf-m1-firstrun-2026-08-14.db), synthetic recent
    // publishedAt -- the archived row's own published_at is null (a pre-fix
    // artifact this project's ledger documents at length); a fresh ingest
    // today carries a real date, well within the 30-day recency bound.
    const kev = insertItem(db, baseItem({
      url: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
      canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
      title: 'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) Heap Inspection Vulnerability',
      sourceId: 'cisa-kev', beats: ['cyber'], itemType: 'event',
      publishedAt: '2026-08-01T00:00:00.000Z', // 13 days before T0, inside the 30-day bound
      fetchedAt: T0,
    }));
    const ordinary = insertItem(db, baseItem({
      url: 'https://bleepingcomputer.test/story', canonicalUrl: 'https://bleepingcomputer.test/story',
      title: 'A routine cybersecurity roundup with nothing overridden',
      sourceId: 'bleepingcomputer', beats: ['cyber'], itemType: 'analysis',
      publishedAt: T0, fetchedAt: T0,
    }));

    const deps: ScoreItemDeps = {
      sources: [
        ...testScoreDeps().sources,
        { id: 'bleepingcomputer', name: 'BleepingComputer', type: 'rss', url: 'https://example.test/bc', beats: ['cyber'], weight: 1.3, poll_interval: '3h', enabled: true, enrichment: true },
      ],
      interestProfile: { boosts: [], suppressions: [] },
      config: testScoreConfig(),
    };
    scoreItem(db, kev.item_key, T0, deps);
    scoreItem(db, ordinary.item_key, T0, deps);

    const ranking = rankBeat(db, 'cyber', T0, testRankDeps(overridesConfig));
    const kevEntry = ranking.items.find((i) => i.itemKey === kev.item_key)!;
    expect(kevEntry.signalOverride.pinned).toBe(true);
    expect(kevEntry.signalOverride.matches.map((m) => m.id)).toContain('cisa-kev-catalog');
    expect(kevEntry.readOverride.pinned).toBe(false); // real shipped config: every rule is applies_to: [signal] only
    expect(ranking.items[0]!.itemKey).toBe(kev.item_key); // pinned -> sorted first
  });

  it('the SAME cisa-kev item OUTSIDE the 30-day recency bound is NOT pinned -- the cold-start-flood fix, exercised through this module', () => {
    const db = migratedDb();
    const overridesConfig = loadOverridesConfig(join(process.cwd(), 'config', 'overrides.yaml'));
    const kev = insertItem(db, baseItem({
      url: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2021-11111',
      canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2021-11111',
      title: 'An old KEV entry, added to the catalog long ago',
      sourceId: 'cisa-kev', beats: ['cyber'], itemType: 'event',
      publishedAt: '2021-11-03T00:00:00.000Z', fetchedAt: T0,
    }));
    scoreItem(db, kev.item_key, T0, testScoreDeps());
    const ranking = rankBeat(db, 'cyber', T0, testRankDeps(overridesConfig));
    expect(ranking.items.find((i) => i.itemKey === kev.item_key)!.signalOverride.pinned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadRankDepsFromConfigFiles -- real config wiring
// ---------------------------------------------------------------------------
describe('loadRankDepsFromConfigFiles', () => {
  it('produces the same shape as loading each config manually', () => {
    const decayPath = join(process.cwd(), 'config', 'decay.yaml');
    const overridesPath = join(process.cwd(), 'config', 'overrides.yaml');
    const deps = loadRankDepsFromConfigFiles(decayPath, overridesPath);
    expect(deps.decayConfig.beats.usnews.signal_half_life_hours).toBe(24);
    expect(deps.overridesConfig.overrides.some((o) => o.id === 'cisa-kev-catalog')).toBe(true);
  });
});

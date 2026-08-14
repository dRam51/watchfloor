import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, getCurrentItem, type NewItem } from '../../src/domain/item.ts';
import { writeClusters } from '../../src/cluster/store.ts';
import { loadInterestsFile, matchProfile, type InterestProfile, type ProfileMatches } from '../../src/interests/load.ts';
import { loadSourcesFile, type Source } from '../../src/sources/load.ts';
import { recordStarSnapshot } from '../../src/db/repoSnapshots.ts';
import {
  MechanicalScoreConfigError,
  UnknownItemKeyError,
  UnknownSourceError,
  parseMechanicalScoreConfig,
  loadMechanicalScoreConfig,
  normalizeSourceWeight,
  normalizeClusterSize,
  computeInterestMultiplier,
  computeMechanicalScore,
  isHighOnBoth,
  buildScoringText,
  resolvePortfolioProximity,
  scoreItem,
  getLatestItemScore,
  type MechanicalScoreConfig,
} from '../../src/score/mechanical.ts';

// ---------------------------------------------------------------------------
// Temp-DB plumbing, mirroring tests/score/overrides.test.ts / decay.test.ts
// exactly (openDb -> runMigrations against the real db/migrations directory
// -> insertItem/getCurrentItem). Real temp-file SQLite, no mocks.
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

// A minimal, single-entry sources list -- enough for scoreItem's source-weight
// lookup without needing the full real config/sources.yaml for every test.
function testSources(): Source[] {
  return [
    { id: 'ap-news', name: 'AP News', type: 'news_sitemap', url: 'https://example.test/ap', beats: ['usnews'], weight: 1.8, poll_interval: '15m', enabled: true, enrichment: true },
    { id: 'arxiv-cs-cr', name: 'arXiv cs.CR', type: 'atom', url: 'https://example.test/cr', beats: ['aisec'], weight: 0.9, poll_interval: '1d', enabled: true, enrichment: true },
    { id: 'arxiv-cs-ai', name: 'arXiv cs.AI', type: 'atom', url: 'https://example.test/ai', beats: ['ai'], weight: 0.9, poll_interval: '1d', enabled: true, enrichment: true },
    { id: 'cisa-kev', name: 'CISA KEV', type: 'json', url: 'https://example.test/kev', beats: ['cyber'], weight: 2.0, poll_interval: '30m', enabled: true, enrichment: true },
  ];
}

function emptyProfileMatches(): ProfileMatches {
  return { boosts: [], suppressions: [] };
}

// ---------------------------------------------------------------------------
// A hand-built config, independent of the real checked-in config/scoring.yaml
// (which gets its own dedicated block further down). Round numbers chosen for
// trivial hand-verification -- mirrors tests/score/decay.test.ts's testConfig
// convention exactly, for the same reason: a real config retune must not
// silently change what these tests assert, and vice versa.
// ---------------------------------------------------------------------------
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

function testConfigYaml(): string {
  return `
scorer_version: test-v0
source:
  min_weight: 0
  max_weight: 10
  signal_weight: 4
  read_weight: 2
cluster:
  saturation_size: 4
  signal_weight: 4
  read_weight: 1
interest:
  boost_gain: 1
  suppress_gain: 1
  multiplier_floor: 0
  multiplier_ceiling: 5
high_on_both:
  signal_threshold: 5
  read_threshold: 2
portfolio:
  portfolio_path: config/portfolio.yaml
`;
}

// ---------------------------------------------------------------------------
// Config parsing / validation
// ---------------------------------------------------------------------------
describe('parseMechanicalScoreConfig', () => {
  it('parses a valid config', () => {
    const config = parseMechanicalScoreConfig(testConfigYaml());
    expect(config).toEqual(testConfig());
  });

  it('throws MechanicalScoreConfigError on unparseable YAML', () => {
    expect(() => parseMechanicalScoreConfig(':::not yaml:::[[[')).toThrow(MechanicalScoreConfigError);
  });

  it('throws on a missing top-level section', () => {
    const bad = testConfigYaml().replace(/^cluster:[\s\S]*?(?=interest:)/m, '');
    expect(() => parseMechanicalScoreConfig(bad)).toThrow(MechanicalScoreConfigError);
  });

  it('throws on an unrecognized top-level key (.strict())', () => {
    expect(() => parseMechanicalScoreConfig(testConfigYaml() + '\nextra_junk: 1\n')).toThrow(MechanicalScoreConfigError);
  });

  it('throws when source.min_weight >= source.max_weight', () => {
    const bad = testConfigYaml().replace('min_weight: 0', 'min_weight: 10').replace('max_weight: 10', 'max_weight: 10');
    expect(() => parseMechanicalScoreConfig(bad)).toThrow(MechanicalScoreConfigError);
  });

  it('throws when cluster.saturation_size <= 1 (log2(1) is always 0, so saturation would never be reachable)', () => {
    const bad = testConfigYaml().replace('saturation_size: 4', 'saturation_size: 1');
    expect(() => parseMechanicalScoreConfig(bad)).toThrow(MechanicalScoreConfigError);
  });

  it('throws when interest.multiplier_floor >= interest.multiplier_ceiling', () => {
    const bad = testConfigYaml().replace('multiplier_floor: 0', 'multiplier_floor: 5').replace('multiplier_ceiling: 5', 'multiplier_ceiling: 5');
    expect(() => parseMechanicalScoreConfig(bad)).toThrow(MechanicalScoreConfigError);
  });

  it('throws on a negative weight', () => {
    const bad = testConfigYaml().replace('signal_weight: 4', 'signal_weight: -4');
    expect(() => parseMechanicalScoreConfig(bad)).toThrow(MechanicalScoreConfigError);
  });

  it('throws when portfolio_path is absolute (zero-absolute-paths rule, mirrors src/score/overrides.ts)', () => {
    const bad = testConfigYaml().replace('portfolio_path: config/portfolio.yaml', 'portfolio_path: /etc/portfolio.yaml');
    expect(() => parseMechanicalScoreConfig(bad)).toThrow(MechanicalScoreConfigError);
  });

  it('throws when scorer_version is empty', () => {
    const bad = testConfigYaml().replace('scorer_version: test-v0', 'scorer_version: ""');
    expect(() => parseMechanicalScoreConfig(bad)).toThrow(MechanicalScoreConfigError);
  });
});

describe('loadMechanicalScoreConfig', () => {
  it('reads and parses a file from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-test-'));
    const path = join(dir, 'scoring.yaml');
    writeFileSync(path, testConfigYaml());
    expect(loadMechanicalScoreConfig(path)).toEqual(testConfig());
  });
});

// ---------------------------------------------------------------------------
// The real shipped config/scoring.yaml -- loads cleanly, and produces the
// exact numbers documented in its own header comment. Numbers below were
// computed independently (a standalone script, not by calling this module),
// then transcribed -- so a coefficient mutation in mechanical.ts OR in
// config/scoring.yaml shows up as an explained, reviewable test failure, not
// a silently-passing tautology. See task-5-report.md for the derivation.
// ---------------------------------------------------------------------------
describe('the real config/scoring.yaml', () => {
  const REAL_CONFIG_PATH = join(process.cwd(), 'config', 'scoring.yaml');

  it('loads without error and matches the documented shape', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    expect(config.scorer_version).toBe('mechanical-v2');
    expect(config.source).toEqual({ min_weight: 0.1, max_weight: 2.0, signal_weight: 3.5, read_weight: 3.5 });
    expect(config.cluster).toEqual({ saturation_size: 8, signal_weight: 3.5, read_weight: 1.5 });
  });

  it('a single-source cisa-kev-weighted item (source=2.0, cluster=1, no interest match) scores signal=read=3.5', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const result = computeMechanicalScore({ sourceWeight: 2.0, clusterSize: 1, interestMatches: emptyProfileMatches() }, config);
    expect(result.signalScore).toBeCloseTo(3.5, 6);
    expect(result.readScore).toBeCloseTo(3.5, 6);
  });

  it('a real suppressed AP sports headline ("...3 touchdowns in preseason win...", weight 1.8, single-source) scores signal=read≈0.1566', () => {
    // Real title, real match: verified against config/interests.yaml's actual
    // matchProfile -- "preseason" (weight 1.4) is the only match, in EITHER
    // direction. Grounds this test in the same real corpus convention used
    // throughout M2 (attic/wf-m1-firstrun-2026-08-14.db carries the literal
    // ap-news row this title comes from).
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const interests = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
    const title = 'Steelers rookie Drew Allar impresses with 3 touchdowns in preseason win against Packers';
    const text = buildScoringText(title, null, []);
    // Real whole-word matchProfile, not a naive substring scan: "touchdowns"
    // (plural) must NOT match the "touchdown" suppress term (no stemming,
    // per src/interests/load.ts's documented matching rules) -- only
    // "preseason" fires.
    const matches = matchProfile(text, interests);
    expect(matches.suppressions.map((m) => m.term)).toEqual(['preseason']);
    expect(matches.boosts).toEqual([]);
    const result = computeMechanicalScore({ sourceWeight: 1.8, clusterSize: 1, interestMatches: matches }, config);
    expect(result.signalScore).toBeCloseTo(0.15657894736842107, 6);
    expect(result.readScore).toBeCloseTo(0.15657894736842107, 6);
  });

  it('a real boosted arXiv title ("...Indirect Prompt Injection...", arxiv-cs-cr weight 0.9, single-source) scores signal=read=2.8', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const title = 'Attention is All You Need to Defend Against Indirect Prompt Injection Attacks in LLMs';
    const boostWeight = 1.8; // "prompt injection" in config/interests.yaml
    const matches = { boosts: [{ term: 'prompt injection', weight: boostWeight }], suppressions: [] };
    const result = computeMechanicalScore({ sourceWeight: 0.9, clusterSize: 1, interestMatches: matches }, config);
    expect(result.signalScore).toBeCloseTo(2.8, 6);
    expect(result.readScore).toBeCloseTo(2.8, 6);
  });

  it('MULTI-SOURCE OUTRANKS SINGLE-SOURCE on both scores -- the M2 acceptance criterion, checked at the formula level', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const single = computeMechanicalScore({ sourceWeight: 1.8, clusterSize: 1, interestMatches: emptyProfileMatches() }, config);
    const multi = computeMechanicalScore({ sourceWeight: 1.8, clusterSize: 3, interestMatches: emptyProfileMatches() }, config);
    expect(single.signalScore).toBeCloseTo(3.1315789473684212, 6);
    expect(single.readScore).toBeCloseTo(3.1315789473684212, 6);
    expect(multi.signalScore).toBeCloseTo(4.980701864876437, 6);
    expect(multi.readScore).toBeCloseTo(3.9240601977289993, 6);
    expect(multi.signalScore).toBeGreaterThan(single.signalScore);
    expect(multi.readScore).toBeGreaterThan(single.readScore);
    // Cluster corroboration drives signal MORE than read (cluster.signal_weight
    // 3.5 > cluster.read_weight 1.5, see config/scoring.yaml's header) -- the
    // relative lift is bigger for signal than for read.
    const signalLift = multi.signalScore / single.signalScore;
    const readLift = multi.readScore / single.readScore;
    expect(signalLift).toBeGreaterThan(readLift);
  });

  it('isHighOnBoth: a well-corroborated (cluster=8), high-trust (1.8), strongly-boosted item ("prompt injection" + "agent security" = 3.6) is flagged', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const matches = {
      boosts: [
        { term: 'prompt injection', weight: 1.8 },
        { term: 'agent security', weight: 1.8 },
      ],
      suppressions: [],
    };
    const result = computeMechanicalScore({ sourceWeight: 1.8, clusterSize: 8, interestMatches: matches }, config);
    expect(result.signalScore).toBeCloseTo(18.568421052631578, 6);
    expect(result.readScore).toBeCloseTo(12.968421052631578, 6);
    expect(isHighOnBoth(result, config)).toBe(true);
  });

  it('isHighOnBoth: the SAME max trust+cluster with NO interest match is NOT flagged -- corroboration and trust alone are not enough', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const result = computeMechanicalScore({ sourceWeight: 2.0, clusterSize: 8, interestMatches: emptyProfileMatches() }, config);
    expect(result.signalScore).toBeCloseTo(7, 6);
    expect(result.readScore).toBeCloseTo(5, 6);
    expect(isHighOnBoth(result, config)).toBe(false);
  });

  it('isHighOnBoth: a single boost with no corroboration crosses neither threshold', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const result = computeMechanicalScore(
      { sourceWeight: 1.8, clusterSize: 1, interestMatches: { boosts: [{ term: 'eval', weight: 1.3 }], suppressions: [] } },
      config,
    );
    expect(result.signalScore).toBeCloseTo(5.167105263157895, 6);
    expect(result.readScore).toBeCloseTo(5.167105263157895, 6);
    expect(isHighOnBoth(result, config)).toBe(false);
  });

  it('isHighOnBoth requires BOTH thresholds crossed, not just one: min trust + max cluster + strong boost crosses signal but not read', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const matches = {
      boosts: [
        { term: 'prompt injection', weight: 1.8 },
        { term: 'agent security', weight: 1.8 },
      ],
      suppressions: [],
    };
    const result = computeMechanicalScore({ sourceWeight: 0.1, clusterSize: 8, interestMatches: matches }, config);
    expect(result.signalScore).toBeCloseTo(9.799999999999999, 6);
    expect(result.readScore).toBeCloseTo(4.199999999999999, 6);
    expect(result.signalScore).toBeGreaterThanOrEqual(config.high_on_both.signal_threshold);
    expect(result.readScore).toBeLessThan(config.high_on_both.read_threshold);
    expect(isHighOnBoth(result, config)).toBe(false);
  });

  it('a real, verified NO-MATCH sports headline is NOT suppressed by interest matching -- a documented, pre-existing gap (Task 1), not something this scorer closes or hides', () => {
    // Real ap-news title (verified live via matchProfile against the shipped
    // config/interests.yaml -- zero boosts, zero suppressions): team/player-
    // name-only sports headlines are invisible to keyword matching in any
    // language (Task 1's own documented open gap, M2 progress.md). This
    // scorer does not attempt to close that gap -- it inherits Task 1's
    // matching exactly as shipped, neither better nor worse.
    const interests = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
    const title = 'Howard, Gray each score 29 points as the Dream ease by the Sun 104-69';
    const text = buildScoringText(title, null, []);
    const hits = [...interests.boosts, ...interests.suppressions].filter((t) => text.toLowerCase().includes(t.term.toLowerCase()));
    expect(hits).toEqual([]);
  });

  it('a real, verified Spanish-language headline is likewise NOT suppressed -- same documented gap', () => {
    const interests = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
    const title = 'Swiatek vence a Rybakina en Toronto';
    const text = buildScoringText(title, null, []);
    const hits = [...interests.boosts, ...interests.suppressions].filter((t) => text.toLowerCase().includes(t.term.toLowerCase()));
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeSourceWeight
// ---------------------------------------------------------------------------
describe('normalizeSourceWeight', () => {
  it('maps min_weight to exactly 0', () => {
    expect(normalizeSourceWeight(0, testConfig())).toBe(0);
  });
  it('maps max_weight to exactly 1', () => {
    expect(normalizeSourceWeight(10, testConfig())).toBe(1);
  });
  it('maps the midpoint to exactly 0.5', () => {
    expect(normalizeSourceWeight(5, testConfig())).toBe(0.5);
  });
  it('clamps a value below min_weight to 0 rather than going negative', () => {
    expect(normalizeSourceWeight(-100, testConfig())).toBe(0);
  });
  it('clamps a value above max_weight to 1 rather than exceeding it', () => {
    expect(normalizeSourceWeight(1000, testConfig())).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeClusterSize
// ---------------------------------------------------------------------------
describe('normalizeClusterSize', () => {
  it('cluster size 1 (the "cluster of itself" baseline, per getClusterSizeAsOf) normalizes to exactly 0', () => {
    expect(normalizeClusterSize(1, testConfig())).toBe(0);
  });
  it('cluster size == saturation_size normalizes to exactly 1', () => {
    expect(normalizeClusterSize(4, testConfig())).toBe(1);
  });
  it('clamps beyond saturation_size to exactly 1, never exceeding it', () => {
    expect(normalizeClusterSize(1665, testConfig())).toBe(1);
  });
  it('is monotonically non-decreasing', () => {
    const config = testConfig();
    const sizes = [1, 2, 3, 4, 5, 10, 100];
    const values = sizes.map((n) => normalizeClusterSize(n, config));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });
  it('throws RangeError for a cluster size below 1 -- getClusterSizeAsOf never returns less, so this is a caller bug, not a state to accommodate', () => {
    expect(() => normalizeClusterSize(0, testConfig())).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// computeInterestMultiplier
// ---------------------------------------------------------------------------
describe('computeInterestMultiplier', () => {
  it('no matches at all -> exactly 1 (neutral)', () => {
    expect(computeInterestMultiplier(emptyProfileMatches(), testConfig())).toBe(1);
  });
  it('a single boost raises the multiplier above 1, proportional to boost_gain * weight', () => {
    const result = computeInterestMultiplier({ boosts: [{ term: 'x', weight: 2 }], suppressions: [] }, testConfig());
    expect(result).toBe(3); // 1 + 1*2
  });
  it('a single suppression lowers the multiplier below 1, proportional to suppress_gain * weight', () => {
    const result = computeInterestMultiplier({ boosts: [], suppressions: [{ term: 'x', weight: 0.5 }] }, testConfig());
    expect(result).toBe(0.5); // 1 - 1*0.5
  });
  it('multiple boosts sum their weights before applying gain', () => {
    const result = computeInterestMultiplier(
      { boosts: [{ term: 'a', weight: 1 }, { term: 'b', weight: 1.5 }], suppressions: [] },
      testConfig(),
    );
    expect(result).toBe(3.5); // 1 + 1*(1+1.5)
  });
  it('clamps at multiplier_ceiling when boosts would push it higher', () => {
    const result = computeInterestMultiplier({ boosts: [{ term: 'a', weight: 100 }], suppressions: [] }, testConfig());
    expect(result).toBe(5); // ceiling
  });
  it('clamps at multiplier_floor when suppressions would push it below (or to) zero/negative', () => {
    const result = computeInterestMultiplier({ boosts: [], suppressions: [{ term: 'a', weight: 100 }] }, testConfig());
    expect(result).toBe(0); // floor
  });
  it('boosts and suppressions can both be present simultaneously (distinct terms can each match the same text) and net out', () => {
    const result = computeInterestMultiplier(
      { boosts: [{ term: 'eval', weight: 1.3 }], suppressions: [{ term: 'NFL', weight: 1.5 }] },
      testConfig(),
    );
    expect(result).toBeCloseTo(0.8, 10); // 1 + 1*1.3 - 1*1.5
  });
});

// ---------------------------------------------------------------------------
// computeMechanicalScore -- monotonicity and structural properties
// ---------------------------------------------------------------------------
describe('computeMechanicalScore', () => {
  it('is a pure function with NO timestamp/now/asOf parameter at all -- structurally incapable of applying decay', () => {
    // This is a type-level guarantee (MechanicalScoreComponents carries no
    // date field), asserted here at the value level too: calling it twice
    // with identical components produces IDENTICAL output, byte for byte.
    const components = { sourceWeight: 1.5, clusterSize: 3, interestMatches: emptyProfileMatches() };
    const config = testConfig();
    expect(computeMechanicalScore(components, config)).toEqual(computeMechanicalScore(components, config));
  });

  it('this module never imports src/score/decay.ts, and never CALLS decayFactor/computeDecayFactor (grep-level proof, not just behavioural)', () => {
    // Checks call syntax specifically (name immediately followed by "("),
    // not bare mentions of the names -- this module's own doc comments
    // discuss decayFactor/computeDecayFactor BY NAME, in prose, to explain
    // exactly why they are never called; a bare-word check would false-
    // positive on that explanation rather than on an actual violation.
    const source = readFileSync(join(process.cwd(), 'src', 'score', 'mechanical.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*decay\.ts['"]/);
    expect(source).not.toMatch(/\bdecayFactor\s*\(/);
    expect(source).not.toMatch(/\bcomputeDecayFactor\s*\(/);
  });

  it('higher sourceWeight (all else equal) never decreases either score', () => {
    const config = testConfig();
    const low = computeMechanicalScore({ sourceWeight: 1, clusterSize: 1, interestMatches: emptyProfileMatches() }, config);
    const high = computeMechanicalScore({ sourceWeight: 9, clusterSize: 1, interestMatches: emptyProfileMatches() }, config);
    expect(high.signalScore).toBeGreaterThan(low.signalScore);
    expect(high.readScore).toBeGreaterThan(low.readScore);
  });

  it('higher clusterSize (all else equal) never decreases either score', () => {
    const config = testConfig();
    const low = computeMechanicalScore({ sourceWeight: 5, clusterSize: 1, interestMatches: emptyProfileMatches() }, config);
    const high = computeMechanicalScore({ sourceWeight: 5, clusterSize: 4, interestMatches: emptyProfileMatches() }, config);
    expect(high.signalScore).toBeGreaterThan(low.signalScore);
    expect(high.readScore).toBeGreaterThan(low.readScore);
  });

  it('a suppression match lowers both scores relative to an otherwise-identical unsuppressed item', () => {
    const config = testConfig();
    const clean = computeMechanicalScore({ sourceWeight: 5, clusterSize: 2, interestMatches: emptyProfileMatches() }, config);
    const suppressed = computeMechanicalScore(
      { sourceWeight: 5, clusterSize: 2, interestMatches: { boosts: [], suppressions: [{ term: 'x', weight: 1 }] } },
      config,
    );
    expect(suppressed.signalScore).toBeLessThan(clean.signalScore);
    expect(suppressed.readScore).toBeLessThan(clean.readScore);
  });

  it('a boost match raises both scores relative to an otherwise-identical unboosted item', () => {
    const config = testConfig();
    const clean = computeMechanicalScore({ sourceWeight: 5, clusterSize: 2, interestMatches: emptyProfileMatches() }, config);
    const boosted = computeMechanicalScore(
      { sourceWeight: 5, clusterSize: 2, interestMatches: { boosts: [{ term: 'x', weight: 1 }], suppressions: [] } },
      config,
    );
    expect(boosted.signalScore).toBeGreaterThan(clean.signalScore);
    expect(boosted.readScore).toBeGreaterThan(clean.readScore);
  });

  it('exact worked value against the hand-built testConfig: source=5 (mid), cluster=4 (saturated), no interest', () => {
    const result = computeMechanicalScore({ sourceWeight: 5, clusterSize: 4, interestMatches: emptyProfileMatches() }, testConfig());
    // sourceComponent = 0.5, clusterComponent = 1
    // signal = 4*1 + 4*0.5 = 6; read = 1*1 + 2*0.5 = 2
    expect(result.signalScore).toBeCloseTo(6, 10);
    expect(result.readScore).toBeCloseTo(2, 10);
  });

  it('exact worked value: source=0 (min), cluster=1 (min), no interest -> both scores exactly 0', () => {
    const result = computeMechanicalScore({ sourceWeight: 0, clusterSize: 1, interestMatches: emptyProfileMatches() }, testConfig());
    expect(result.signalScore).toBe(0);
    expect(result.readScore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isHighOnBoth -- unit-level, against the hand-built testConfig
// ---------------------------------------------------------------------------
describe('isHighOnBoth (unit)', () => {
  it('false when neither score reaches its threshold', () => {
    expect(isHighOnBoth({ signalScore: 1, readScore: 1 }, testConfig())).toBe(false);
  });
  it('false when only signalScore reaches its threshold', () => {
    expect(isHighOnBoth({ signalScore: 10, readScore: 1 }, testConfig())).toBe(false);
  });
  it('false when only readScore reaches its threshold', () => {
    expect(isHighOnBoth({ signalScore: 1, readScore: 10 }, testConfig())).toBe(false);
  });
  it('true when both scores are exactly at their threshold (inclusive boundary)', () => {
    expect(isHighOnBoth({ signalScore: 5, readScore: 2 }, testConfig())).toBe(true);
  });
  it('true when both scores exceed their threshold', () => {
    expect(isHighOnBoth({ signalScore: 100, readScore: 100 }, testConfig())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildScoringText -- title + summary + entities, feeding matchProfile
// ---------------------------------------------------------------------------
describe('buildScoringText', () => {
  it('joins title, summary, and entities with spaces', () => {
    expect(buildScoringText('Title', 'Summary text', ['Entity One', 'Entity Two'])).toBe('Title Summary text Entity One Entity Two');
  });
  it('a null summary contributes nothing (not the literal string "null")', () => {
    expect(buildScoringText('Title', null, [])).toBe('Title ');
  });
  it('empty entities contribute nothing', () => {
    expect(buildScoringText('Title', 'Summary', [])).toBe('Title Summary');
  });
  it('an interest term appearing ONLY in an entity (not in title or summary) is still discoverable by matchProfile against the built text', async () => {
    const { matchProfile } = await import('../../src/interests/load.ts');
    const profile: InterestProfile = {
      boosts: [{ term: 'Juniper', weight: 1.6 }],
      suppressions: [{ term: 'placeholder-unused', weight: 0.1 }],
    };
    const text = buildScoringText('An unrelated headline', null, ['Juniper Networks']);
    const matches = matchProfile(text, profile);
    expect(matches.boosts.map((m) => m.term)).toEqual(['Juniper']);
  });
});

// ---------------------------------------------------------------------------
// resolvePortfolioProximity -- explicit M4b no-op, mirroring Task 6's
// tryReadPortfolioFile convention (src/score/overrides.ts) exactly.
// ---------------------------------------------------------------------------
describe('resolvePortfolioProximity', () => {
  it('returns exactly 0 when the portfolio file does not exist (the normal state on every machine, including a fresh clone)', () => {
    const missingPath = join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'does-not-exist-portfolio.yaml');
    expect(resolvePortfolioProximity(missingPath)).toBe(0);
  });

  it('returns exactly 0 even when a validly-formed portfolio-shaped file DOES exist -- proving the result is unconditional, not merely "usually zero because the file is usually absent"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-test-'));
    const path = join(dir, 'portfolio.yaml');
    // Deliberately NOT shaped like real holdings data (no ticker/weight) --
    // this test file is not gitignored config, so nothing portfolio-shaped
    // belongs in it either; a generic YAML document is enough to prove "a
    // file exists and parses" without needing a real schema (none exists
    // yet -- M4b's job).
    writeFileSync(path, 'some_field: some_value\n');
    expect(resolvePortfolioProximity(path)).toBe(0);
  });

  it('THE READ IS REAL, NOT A STUB THAT NEVER TOUCHES THE FILESYSTEM: propagates a throw from malformed YAML in a file that DOES exist -- same as src/score/overrides.ts\'s tryReadPortfolioFile, which this function calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-test-'));
    const path = join(dir, 'portfolio.yaml');
    // Genuinely unparseable (verified against the real `yaml` package, which
    // is lenient enough to parse many superficially-odd strings as a plain
    // scalar) -- an unbalanced flow sequence with a stray nested colon,
    // mirroring tests/score/overrides.test.ts's own parseOverridesConfig
    // malformed-YAML fixture shape.
    writeFileSync(path, 'holdings: [this is not: valid: yaml');
    expect(() => resolvePortfolioProximity(path)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// scoreItem -- the DB-facing write path
// ---------------------------------------------------------------------------
describe('scoreItem', () => {
  it('throws UnknownItemKeyError for an item_key that was never ingested', () => {
    const db = migratedDb();
    expect(() =>
      scoreItem(db, 'nonexistent-item-key', NOW, { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() }),
    ).toThrow(UnknownItemKeyError);
  });

  it('throws UnknownSourceError when the current item\'s source_id is not in the supplied sources list', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ sourceId: 'not-configured-anywhere' }));
    expect(() =>
      scoreItem(db, item.item_key, NOW, { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() }),
    ).toThrow(UnknownSourceError);
  });

  it('writes exactly one item_scores row per beat the item belongs to', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'], sourceId: 'ap-news' }));
    const rows = scoreItem(db, item.item_key, NOW, { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.beat).toBe('usnews');
  });

  it('every written row carries BOTH signal_score and read_score, never one without the other (schema requires NOT NULL on both)', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem());
    const rows = scoreItem(db, item.item_key, NOW, { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() });
    for (const row of rows) {
      expect(typeof row.signalScore).toBe('number');
      expect(typeof row.readScore).toBe('number');
      expect(Number.isFinite(row.signalScore)).toBe(true);
      expect(Number.isFinite(row.readScore)).toBe(true);
    }
  });

  it('writes scorer_version verbatim from the supplied config, and computed_at exactly equal to `now`', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem());
    const config = testConfig({ scorer_version: 'my-custom-version' });
    const rows = scoreItem(db, item.item_key, NOW, { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config });
    expect(rows[0]!.scorerVersion).toBe('my-custom-version');
    expect(rows[0]!.computedAt).toBe(NOW);
  });

  it('THE item_id DECISION: writes against the CURRENT item_id as of scoring time', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem());
    const rows = scoreItem(db, item.item_key, NOW, { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() });
    expect(rows[0]!.itemId).toBe(item.item_id);
    const stored = db.prepare('select item_id from item_scores where score_id = ?').get(rows[0]!.scoreId) as { item_id: string };
    expect(stored.item_id).toBe(item.item_id);
  });

  it('a beat set of length 0 (an item_key with no item_beats rows at all) writes nothing and returns []', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: [] }));
    const rows = scoreItem(db, item.item_key, NOW, { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() });
    expect(rows).toEqual([]);
    const count = db.prepare('select count(*) as n from item_scores').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('RESCORING APPENDS -- calling scoreItem twice for the same item_key writes a SECOND set of rows rather than replacing the first (append-only, per the global constraint)', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem());
    const deps = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() };
    scoreItem(db, item.item_key, NOW, deps);
    const laterNow = '2026-08-15T00:00:00.000Z';
    scoreItem(db, item.item_key, laterNow, deps);
    const all = db.prepare('select computed_at from item_scores order by computed_at').all() as Array<{ computed_at: string }>;
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.computed_at)).toEqual([NOW, laterNow]);
  });

  it('cluster size feeds through getClusterSizeAsOf: a clustered item scores higher than an identical unclustered one', () => {
    const db = migratedDb();
    const a = insertItem(db, baseItem({ url: 'https://example.test/a', canonicalUrl: 'https://example.test/a', title: 'Story A', sourceId: 'ap-news', beats: ['usnews'] }));
    const b = insertItem(db, baseItem({ url: 'https://example.test/b', canonicalUrl: 'https://example.test/b', title: 'Story B', sourceId: 'ap-news', beats: ['usnews'] }));
    const c = insertItem(db, baseItem({ url: 'https://example.test/c', canonicalUrl: 'https://example.test/c', title: 'Story C (unclustered control)', sourceId: 'ap-news', beats: ['usnews'] }));
    writeClusters(db, [[a.item_key, b.item_key]], NOW);

    const deps = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() };
    const clusteredRows = scoreItem(db, a.item_key, NOW, deps);
    const unclusteredRows = scoreItem(db, c.item_key, NOW, deps);
    expect(clusteredRows[0]!.signalScore).toBeGreaterThan(unclusteredRows[0]!.signalScore);
    expect(clusteredRows[0]!.readScore).toBeGreaterThan(unclusteredRows[0]!.readScore);
  });

  it('entities feed through getItemEntities (unioned across item_id, per Task 3/10\'s established pattern): an entity attributed only via a DIFFERENT item_id sharing the same item_key still affects matching', () => {
    const db = migratedDb();
    // Two versions of the SAME item_key (identical canonical_url), each
    // carrying a DIFFERENT entity -- mirrors tests/domain/itemEntities.test.ts's
    // "real items, synthetic entities, labelled as such" convention: no real
    // entity extractor exists yet (item_entities has 0 real rows -- see that
    // file's doc comment), so these entity values are constructed, not mined.
    const v1 = insertItem(
      db,
      baseItem({
        url: 'https://arxiv.org/abs/9999.00001',
        canonicalUrl: 'https://arxiv.org/abs/9999.00001',
        title: 'A paper with an unrelated headline',
        sourceId: 'arxiv-cs-cr',
        beats: ['aisec'],
        entities: ['Juniper Networks'],
        fetchedAt: '2026-08-14T00:00:00.000Z',
      }),
    );
    insertItem(
      db,
      baseItem({
        url: 'https://arxiv.org/abs/9999.00001',
        canonicalUrl: 'https://arxiv.org/abs/9999.00001',
        title: 'A paper with an unrelated headline',
        sourceId: 'arxiv-cs-cr',
        beats: ['aisec'],
        entities: [],
        fetchedAt: '2026-08-14T01:00:00.000Z',
      }),
    );
    const boostedProfile: InterestProfile = { boosts: [{ term: 'Juniper', weight: 1.6 }], suppressions: [{ term: 'placeholder', weight: 0.1 }] };
    const deps = { sources: testSources(), interestProfile: boostedProfile, config: testConfig() };
    const rows = scoreItem(db, v1.item_key, NOW, deps);
    const baseline = computeMechanicalScore({ sourceWeight: 0.9, clusterSize: 1, interestMatches: emptyProfileMatches() }, testConfig());
    // The entity-driven boost must have raised the score above the no-match baseline.
    expect(rows[0]!.signalScore).toBeGreaterThan(baseline.signalScore);
  });

  it('REAL DATA: the arXiv cs.AI / cs.CR cross-listing (verified real pair, same as tests/domain/itemBeats.test.ts) scores BOTH beats -- "beats belong to the item" honored end to end by the scorer, not just by getItemBeats in isolation', () => {
    const db = migratedDb();
    const ARXIV_URL = 'https://arxiv.org/abs/2608.11274';
    const ARXIV_TITLE = 'Agent Safety Should Be a Runtime Contract';
    const ARXIV_FETCHED_AT = '2026-08-14T03:47:10.404Z';
    const cr = insertItem(
      db,
      baseItem({ url: ARXIV_URL, canonicalUrl: ARXIV_URL, title: ARXIV_TITLE, sourceId: 'arxiv-cs-cr', beats: ['aisec'], fetchedAt: ARXIV_FETCHED_AT }),
    );
    const ai = insertItem(
      db,
      baseItem({ url: ARXIV_URL, canonicalUrl: ARXIV_URL, title: ARXIV_TITLE, sourceId: 'arxiv-cs-ai', beats: ['ai'], fetchedAt: ARXIV_FETCHED_AT }),
    );
    expect(ai.item_key).toBe(cr.item_key);

    const deps = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() };
    const rows = scoreItem(db, cr.item_key, NOW, deps);
    expect(rows.map((r) => r.beat).sort()).toEqual(['aisec', 'ai'].sort());
  });

  it('NEVER APPLIES DECAY (behavioural proof): scoring the identical item_key at two `now` values five months apart produces IDENTICAL signal_score/read_score', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ publishedAt: '2026-03-01T00:00:00.000Z', fetchedAt: '2026-03-01T00:00:00.000Z' }));
    const deps = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() };
    const soon = scoreItem(db, item.item_key, '2026-03-01T01:00:00.000Z', deps);
    const muchLater = scoreItem(db, item.item_key, '2026-08-14T00:00:00.000Z', deps);
    expect(muchLater[0]!.signalScore).toBe(soon[0]!.signalScore);
    expect(muchLater[0]!.readScore).toBe(soon[0]!.readScore);
  });

  it('portfolio proximity is invoked (named, not silently absent): scoring succeeds identically whether config/portfolio.yaml is absent or points at a bogus but valid path -- the read never influences the score, per resolvePortfolioProximity being unconditionally 0', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem());
    const deps1 = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig({ portfolio: { portfolio_path: 'config/portfolio.yaml' } }) };
    const deps2 = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig({ portfolio: { portfolio_path: 'config/definitely-does-not-exist.yaml' } }) };
    const rows1 = scoreItem(db, item.item_key, NOW, deps1);
    const rows2 = scoreItem(db, item.item_key, '2026-08-14T01:00:00.000Z', deps2);
    expect(rows2[0]!.signalScore).toBe(rows1[0]!.signalScore);
    expect(rows2[0]!.readScore).toBe(rows1[0]!.readScore);
  });
});

// ---------------------------------------------------------------------------
// getLatestItemScore -- the item_key-aware read path, the fifth instance of
// this milestone's item_id-vs-item_key problem.
// ---------------------------------------------------------------------------
describe('getLatestItemScore', () => {
  it('returns null for an item_key that has never been scored', () => {
    const db = migratedDb();
    insertItem(db, baseItem());
    expect(getLatestItemScore(db, 'nonexistent-key', 'usnews')).toBeNull();
  });

  it('returns null for a beat the item was never scored under', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    scoreItem(db, item.item_key, NOW, { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() });
    expect(getLatestItemScore(db, item.item_key, 'cyber')).toBeNull();
  });

  it('returns the row scoreItem just wrote', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    const written = scoreItem(db, item.item_key, NOW, { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() });
    const read = getLatestItemScore(db, item.item_key, 'usnews');
    expect(read).toEqual(written[0]);
  });

  it('after a RESCORE, returns the MOST RECENT row (by computed_at), not the first', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    const deps = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() };
    scoreItem(db, item.item_key, NOW, deps);
    const later = '2026-08-15T00:00:00.000Z';
    const secondPass = scoreItem(db, item.item_key, later, deps);
    const read = getLatestItemScore(db, item.item_key, 'usnews');
    expect(read?.computedAt).toBe(later);
    expect(read).toEqual(secondPass[0]);
  });

  it('ties on computed_at are broken by rowid desc (most recently inserted wins), mirroring src/domain/item.ts / src/cluster/store.ts exactly', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ beats: ['usnews'] }));
    const deps1 = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig({ scorer_version: 'first-pass' }) };
    const deps2 = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig({ scorer_version: 'second-pass' }) };
    scoreItem(db, item.item_key, NOW, deps1);
    const second = scoreItem(db, item.item_key, NOW, deps2);
    const read = getLatestItemScore(db, item.item_key, 'usnews');
    expect(read?.scorerVersion).toBe('second-pass');
    expect(read).toEqual(second[0]);
  });

  it('THE CENTRAL PROOF: a NEW version arrives for the same item_key AFTER scoring, without a rescore -- getLatestItemScore still finds the score written against the PREVIOUS item_id, while a naive `item_id = getCurrentItem(...).item_id` join would find nothing', () => {
    const db = migratedDb();
    const v1 = insertItem(
      db,
      baseItem({ url: 'https://example.test/reversioned', canonicalUrl: 'https://example.test/reversioned', title: 'Original', beats: ['usnews'], fetchedAt: '2026-08-14T00:00:00.000Z' }),
    );
    const deps = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig() };
    const written = scoreItem(db, v1.item_key, '2026-08-14T00:30:00.000Z', deps);
    expect(written[0]!.itemId).toBe(v1.item_id);

    // A second version lands LATER, unscored -- e.g. a re-delivered or
    // corrected row (insertItem never dedupes on content; items is
    // append-only). It becomes "current" without anyone having scored it.
    const v2 = insertItem(
      db,
      baseItem({ url: 'https://example.test/reversioned', canonicalUrl: 'https://example.test/reversioned', title: 'Original', beats: ['usnews'], fetchedAt: '2026-08-14T01:00:00.000Z' }),
    );
    expect(v2.item_key).toBe(v1.item_key);
    expect(getCurrentItem(db, v1.item_key)?.item_id).toBe(v2.item_id);

    // The naive approach -- join on whatever getCurrentItem resolves to --
    // finds NOTHING, because v2 was never scored.
    const naive = db.prepare('select * from item_scores where item_id = ?').get(v2.item_id);
    expect(naive).toBeUndefined();

    // The item-key-scoped read finds the score that WAS written, against v1.
    const found = getLatestItemScore(db, v1.item_key, 'usnews');
    expect(found).not.toBeNull();
    expect(found?.itemId).toBe(v1.item_id);
    expect(found?.signalScore).toBe(written[0]!.signalScore);
  });

  it('does not leak scores across different item_keys', () => {
    const db = migratedDb();
    const a = insertItem(db, baseItem({ url: 'https://example.test/x', canonicalUrl: 'https://example.test/x', beats: ['usnews'] }));
    const b = insertItem(db, baseItem({ url: 'https://example.test/y', canonicalUrl: 'https://example.test/y', beats: ['usnews'] }));
    const deps = { sources: testSources(), interestProfile: { boosts: [], suppressions: [] }, config: testConfig({ scorer_version: 'a-only' }) };
    scoreItem(db, a.item_key, NOW, deps);
    expect(getLatestItemScore(db, b.item_key, 'usnews')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M4a task 7 -- the repos lane's two new components
//
// Both are DECAY-INVARIANT stored components, exactly like sourceComponent and
// clusterComponent: computeMechanicalScore still takes no timestamp of any
// kind, and the repo inputs reach it as already-resolved numbers rather than as
// a VelocityResult (which carries instants). src/score/repoSignal.ts owns the
// reads and the "insufficient history is exactly 0" decision.
// ---------------------------------------------------------------------------
describe('the repos component (M4a task 7)', () => {
  const REAL_CONFIG_PATH = join(process.cwd(), 'config', 'scoring.yaml');

  function repoConfig(): MechanicalScoreConfig {
    return testConfig({
      repos: {
        velocity: { saturation_stars_per_day: 60, coverage_floor: 0.5, signal_weight: 4, read_weight: 2 },
        hn: {
          source_ids: ['hn-algolia'],
          url_strength: 1,
          title_strength: 0.5,
          min_title_slug_length: 6,
          generic_names: [],
          signal_weight: 3,
          read_weight: 3,
        },
      },
    });
  }

  it('the real config/scoring.yaml ships a repos block and a bumped scorer_version', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    // Bumped because the formula now takes two inputs it did not before: a repo
    // scored under the old ruleset and the new one gets different numbers, which
    // is exactly what this string exists to tell apart.
    expect(config.scorer_version).toBe('mechanical-v2');
    expect(config.repos?.velocity.signal_weight).toBe(3.5);
    expect(config.repos?.hn.source_ids).toEqual(['hn-algolia']);
  });

  it('the repos block is OPTIONAL, so a config without one still parses (and scores exactly as it did)', () => {
    const config = parseMechanicalScoreConfig(testConfigYaml());
    expect(config.repos).toBeUndefined();
    const withRepo = computeMechanicalScore(
      { sourceWeight: 5, clusterSize: 1, interestMatches: emptyProfileMatches(), repo: { velocityComponent: 1, hnComponent: 1 } },
      config,
    );
    const without = computeMechanicalScore({ sourceWeight: 5, clusterSize: 1, interestMatches: emptyProfileMatches() }, config);
    expect(withRepo).toEqual(without);
  });

  it('NON-REPO ITEMS ARE UNTOUCHED: omitting `repo` scores identically to the pre-M4a formula', () => {
    const config = repoConfig();
    const base = { sourceWeight: 5, clusterSize: 2, interestMatches: emptyProfileMatches() };
    // 4*0.5 (source) + 4*0.5 (cluster) = 4 for signal; 2*0.5 + 1*0.5 = 1.5 for read.
    const result = computeMechanicalScore(base, config);
    expect(result.signalScore).toBeCloseTo(4, 10);
    expect(result.readScore).toBeCloseTo(1.5, 10);
  });

  it('velocity raises both scores, signal more than read', () => {
    const config = repoConfig();
    const base = { sourceWeight: 5, clusterSize: 2, interestMatches: emptyProfileMatches() };
    const flat = computeMechanicalScore({ ...base, repo: { velocityComponent: 0, hnComponent: 0 } }, config);
    const rising = computeMechanicalScore({ ...base, repo: { velocityComponent: 1, hnComponent: 0 } }, config);

    expect(rising.signalScore - flat.signalScore).toBeCloseTo(4, 10); // velocity.signal_weight
    expect(rising.readScore - flat.readScore).toBeCloseTo(2, 10); // velocity.read_weight
    expect(rising.signalScore - flat.signalScore).toBeGreaterThan(rising.readScore - flat.readScore);
  });

  it('A NEGATIVE VELOCITY LOWERS THE SCORE -- a repo shedding stars sorts below a flat one, as §4 demands', () => {
    const config = repoConfig();
    const base = { sourceWeight: 5, clusterSize: 2, interestMatches: emptyProfileMatches() };
    const declining = computeMechanicalScore({ ...base, repo: { velocityComponent: -1, hnComponent: 0 } }, config);
    const flat = computeMechanicalScore({ ...base, repo: { velocityComponent: 0, hnComponent: 0 } }, config);
    expect(declining.signalScore).toBeLessThan(flat.signalScore);
  });

  it('HN OVERLAP DE-RANKS, IT DOES NOT ZERO: a repo seen on HN scores lower than the same repo unseen', () => {
    const config = repoConfig();
    const base = { sourceWeight: 5, clusterSize: 2, interestMatches: emptyProfileMatches(), repo: { velocityComponent: 1, hnComponent: 0 } };
    const unseen = computeMechanicalScore(base, config);
    const seen = computeMechanicalScore({ ...base, repo: { velocityComponent: 1, hnComponent: 1 } }, config);

    expect(unseen.signalScore - seen.signalScore).toBeCloseTo(3, 10); // hn.signal_weight
    expect(seen.signalScore).toBeGreaterThan(0); // de-ranked, not annihilated
  });

  it('a weaker (title-only) HN match de-ranks less than a URL match', () => {
    const config = repoConfig();
    const base = { sourceWeight: 5, clusterSize: 2, interestMatches: emptyProfileMatches(), repo: { velocityComponent: 1, hnComponent: 0.5 } };
    const byTitle = computeMechanicalScore(base, config);
    const byUrl = computeMechanicalScore({ ...base, repo: { velocityComponent: 1, hnComponent: 1 } }, config);
    expect(byTitle.signalScore).toBeGreaterThan(byUrl.signalScore);
  });

  it('§4 SATISFIED AGAINST THE REAL SHIPPED WEIGHTS: the 40->400 repo outranks the static 30k-star one even when HN has already covered it', () => {
    // This is a CALIBRATION CONSTRAINT on config/scoring.yaml, not a property
    // of the formula: it holds only while repos.hn.signal_weight stays well
    // below repos.velocity.signal_weight. Asserted against the real file (not
    // the hand-built test config, whose deliberately-round hn weight of 3-of-4
    // violates it) so that retuning the shipped numbers into a state where "on
    // HN" beats "actually rising" fails here rather than in the lane.
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const source = { sourceWeight: 1.0, clusterSize: 1, interestMatches: emptyProfileMatches() };
    // Components as src/score/repoSignal.ts computes them: 60/day saturates at
    // 1.0; a 30k-star repo drifting +2/day normalizes to ~0.267.
    const risingOnHn = computeMechanicalScore({ ...source, repo: { velocityComponent: 1, hnComponent: 1 } }, config);
    const staticUnseen = computeMechanicalScore({ ...source, repo: { velocityComponent: 0.267, hnComponent: 0 } }, config);
    expect(risingOnHn.signalScore).toBeGreaterThan(staticUnseen.signalScore);
  });

  it('AND THE CONVERSE, so the de-rank is not merely decorative: two equally-rising repos separate by exactly repos.hn.signal_weight', () => {
    const config = loadMechanicalScoreConfig(REAL_CONFIG_PATH);
    const source = { sourceWeight: 1.0, clusterSize: 1, interestMatches: emptyProfileMatches() };
    const onHn = computeMechanicalScore({ ...source, repo: { velocityComponent: 1, hnComponent: 1 } }, config);
    const notOnHn = computeMechanicalScore({ ...source, repo: { velocityComponent: 1, hnComponent: 0 } }, config);
    expect(notOnHn.signalScore - onHn.signalScore).toBeCloseTo(config.repos!.hn.signal_weight, 10);
  });

  it('computeMechanicalScore STILL takes no timestamp: the repo inputs are plain numbers, not a VelocityResult', () => {
    const config = repoConfig();
    const components = { sourceWeight: 1.5, clusterSize: 3, interestMatches: emptyProfileMatches(), repo: { velocityComponent: 0.4, hnComponent: 0.5 } };
    expect(computeMechanicalScore(components, config)).toEqual(computeMechanicalScore(components, config));
  });
});

describe('scoreItem, for a repos-lane item', () => {
  const GITHUB_SOURCE: Source = {
    id: 'github-mcp',
    name: 'GitHub topic: mcp',
    type: 'github_search',
    url: 'https://api.github.com/search/repositories',
    beats: ['repos'],
    weight: 1.0,
    poll_interval: '6h',
    enabled: true,
    enrichment: true,
  };

  function reposConfig(): MechanicalScoreConfig {
    return testConfig({
      repos: {
        velocity: { saturation_stars_per_day: 60, coverage_floor: 0.5, signal_weight: 4, read_weight: 2 },
        hn: {
          source_ids: ['hn-algolia'],
          url_strength: 1,
          title_strength: 0.5,
          min_title_slug_length: 6,
          generic_names: [],
          signal_weight: 3,
          read_weight: 3,
        },
      },
    });
  }

  function deps(config = reposConfig()) {
    return { sources: [...testSources(), GITHUB_SOURCE], interestProfile: { boosts: [], suppressions: [] } as InterestProfile, config };
  }

  function repoItem(owner: string, name: string): NewItem {
    return baseItem({
      url: `https://github.com/${owner}/${name}`,
      canonicalUrl: `https://github.com/${owner}/${name}`,
      title: `${name}: a thing`,
      sourceId: 'github-mcp',
      beats: ['repos'],
    });
  }

  function withHistory(db: ReturnType<typeof migratedDb>, repoId: number, itemKey: string, fullName: string) {
    // 40 -> 400 across six days: §4's own example, ~60 stars/day.
    recordStarSnapshot(db, { repoId, itemKey, fullName, stars: 40, observedAt: '2026-08-08T12:00:00.000Z', tz: 'UTC' });
    recordStarSnapshot(db, { repoId, itemKey, fullName, stars: 400, observedAt: '2026-08-14T12:00:00.000Z', tz: 'UTC' });
  }

  it('A REPO WITH NO SNAPSHOT HISTORY SCORES AS IF VELOCITY WERE ABSENT -- the lane\'s first seven days, and not a zero pretending to be flat', () => {
    const db = migratedDb();
    const item = insertItem(db, repoItem('someone', 'brand-new-thing'));
    const rows = scoreItem(db, item.item_key, '2026-08-14T18:00:00.000Z', deps());

    // 4*(1.0/10) source + 4*0 cluster = 0.4, with no repo contribution at all.
    expect(rows[0]!.signalScore).toBeCloseTo(0.4, 10);
  });

  it('A REPO WITH REAL HISTORY OUTSCORES AN IDENTICAL ONE WITHOUT: velocity is in the stored component', () => {
    const db = migratedDb();
    const rising = insertItem(db, repoItem('someone', 'rising-thing'));
    const unknown = insertItem(db, repoItem('someone', 'unknown-thing'));
    withHistory(db, 991, rising.item_key, 'someone/rising-thing');

    const now = '2026-08-14T18:00:00.000Z';
    const risingScore = scoreItem(db, rising.item_key, now, deps())[0]!;
    const unknownScore = scoreItem(db, unknown.item_key, now, deps())[0]!;

    expect(risingScore.signalScore).toBeGreaterThan(unknownScore.signalScore);
    expect(risingScore.signalScore - unknownScore.signalScore).toBeCloseTo(4, 6); // full velocity weight
  });

  it('THE MILESTONE\'S OWN TEST, ON THE ROW THAT MOTIVATED IT: github/dmca scores LOWER because of a real HN DEEP LINK, which no item_key comparison would have matched', () => {
    const now = '2026-08-14T18:00:00.000Z';

    function score(withHnRow: boolean) {
      const db = migratedDb();
      const repo = insertItem(db, repoItem('github', 'dmca'));
      withHistory(db, 991, repo.item_key, 'github/dmca');
      if (withHnRow) {
        // Transcribed verbatim from attic/wf-m1-firstrun-2026-08-14.db: the
        // archived corpus's ONLY github.com row. It is a link INTO the repo, so
        // its item_key is a different sha256 than the repo root's -- which is
        // exactly why the naive match would have fired on nothing.
        const hn = insertItem(
          db,
          baseItem({
            url: 'https://github.com/github/dmca/blob/master/2020/10/2020-10-23-RIAA.md',
            canonicalUrl: 'https://github.com/github/dmca/blob/master/2020/10/2020-10-23-RIAA.md',
            title: 'YouTube-dl has received a DMCA takedown from RIAA',
            sourceId: 'hn-algolia',
            beats: ['ai'],
          }),
        );
        expect(hn.item_key).not.toBe(repo.item_key);
      }
      return scoreItem(db, repo.item_key, now, deps())[0]!.signalScore;
    }

    const seen = score(true);
    const unseen = score(false);
    expect(seen).toBeLessThan(unseen);
    expect(unseen - seen).toBeCloseTo(3, 6); // hn.signal_weight, at url_strength 1
  });

  it('A NON-GITHUB ITEM IS COMPLETELY UNAFFECTED, even when an HN row would match its title', () => {
    const db = migratedDb();
    const item = insertItem(db, baseItem({ title: 'rustdesk something' }));
    insertItem(db, baseItem({ url: 'https://x.test/1', canonicalUrl: 'https://x.test/1', title: 'RustDesk now supports Wayland', sourceId: 'hn-algolia' }));

    const withRepos = scoreItem(db, item.item_key, '2026-08-14T18:00:00.000Z', deps())[0]!;
    const db2 = migratedDb();
    const item2 = insertItem(db2, baseItem({ title: 'rustdesk something' }));
    const withoutRepos = scoreItem(db2, item2.item_key, '2026-08-14T18:00:00.000Z', deps(testConfig()))[0]!;

    expect(withRepos.signalScore).toBe(withoutRepos.signalScore);
  });

  it('an absent repos config leaves a repo item scoring exactly as it did before M4a', () => {
    const db = migratedDb();
    const repo = insertItem(db, repoItem('someone', 'rising-thing'));
    withHistory(db, 991, repo.item_key, 'someone/rising-thing');

    const rows = scoreItem(db, repo.item_key, '2026-08-14T18:00:00.000Z', deps(testConfig()));
    expect(rows[0]!.signalScore).toBeCloseTo(0.4, 10);
  });
});

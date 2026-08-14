/**
 * M2 Task 8 -- golden-file scoring test (docs/superpowers/plans/2026-08-14-m2-scoring.md, §6).
 *
 * ## The rule this file exists to satisfy
 *
 * "Derive expectations from the rules, not by running the scorer." Every
 * `expected*` number and every expected ORDER asserted below was computed by
 * an independent, from-scratch re-implementation of the documented formulas
 * (config/scoring.yaml's header, src/score/decay.ts's module doc comment,
 * src/score/overrides.ts's recency-bound rule, src/cluster/similarity.ts's
 * documented normalization/stopword/shingle rules) in a throwaway script
 * that imports NOTHING from src/ -- never by calling scoreItem/
 * computeMechanicalScore/decayFactor/evaluateOverrides/groupNearDuplicates
 * and copying what came out. See task-8-report.md for that script and its
 * full output. This file DOES call the real functions (scoreItem,
 * getLatestItemScore, computeDecayFactor, evaluateOverrides,
 * runClusteringPass, getClusterSizeAsOf) -- that is simply what makes this a
 * test: the hand-derived numbers are the EXPECTED side, the real functions
 * produce the ACTUAL side, and the two are compared.
 *
 * ## Corpus
 *
 * tests/fixtures/golden/corpus.ts -- 21 rows (20 distinct item_keys), all
 * real content pulled from attic/wf-m1-firstrun-2026-08-14.db (read-only,
 * never written to), except two cisa-kev rows' published_at, which are
 * hand-corrected from those SAME real rows' own raw_json.dateAdded field
 * (see that file's header and this file's "hard override" section below).
 *
 * ## now
 *
 * Pinned as `NOW` (imported from the corpus fixture) at a fixed instant, so
 * this file's expectations cannot drift with the wall clock -- decay is a
 * function of `now`, and every decay-sensitive assertion below is only
 * meaningful for the exact instant it was derived against.
 *
 * ## A note on the in-flight clustering fix (see task-8-report.md)
 *
 * While this file was being written, the coordinator flagged a real defect
 * in `runClusteringPass` on a *different*, larger corpus: transitive
 * (union-find) chaining merged 1,543 unrelated cisa-kev items into one
 * cluster through weak formulaic bridges, and a fix (likely: cluster size
 * counts DISTINCT SOURCES, not raw member count) was in flight in
 * `src/cluster/**`, off-limits to this task.
 *
 * This corpus was deliberately built to be robust to that fix either way:
 * every cisa-kev title used here (Cisco ASA/FTD, Windows AFD, Accellion FTA)
 * was verified, by the same independent script, to share ZERO trigrams with
 * every other title in this corpus -- no chaining risk exists here. And for
 * both real clusters this file pins (Mangione, West Bank), raw member count
 * and distinct-source count are IDENTICAL (every member comes from a
 * different source), so the numbers below hold under either the current
 * implementation or the prospective fix. Every cluster-size assertion below
 * is paired with an explicit distinct-source-set assertion (querying
 * item_clusters/items directly, not through src/cluster/**) so the
 * fix-robust property is checked directly, not just incidentally true.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { getCurrentItem, insertItem, type Beat, type Item, type ItemType } from '../../src/domain/item.ts';
import { getItemBeats } from '../../src/domain/itemBeats.ts';
import { getItemFirstFetchedAt } from '../../src/domain/itemFirstFetchedAt.ts';
import { loadClusterConfig } from '../../src/cluster/config.ts';
import { runClusteringPass } from '../../src/cluster/run.ts';
import { getClusterSizeAsOf } from '../../src/cluster/store.ts';
import { loadSourcesFile } from '../../src/sources/load.ts';
import { loadInterestsFile } from '../../src/interests/load.ts';
import {
  computeInterestMultiplier,
  getLatestItemScore,
  loadMechanicalScoreConfig,
  scoreItem,
  type MechanicalScoreConfig,
} from '../../src/score/mechanical.ts';
import { computeDecayFactor, loadDecayConfig, type DecayInput } from '../../src/score/decay.ts';
import { evaluateOverrides, loadOverridesConfig, type OverrideItemInput, type OverrideProfile } from '../../src/score/overrides.ts';
import { matchProfile } from '../../src/interests/load.ts';
import { GOLDEN_CORPUS, NOW } from '../fixtures/golden/corpus.ts';

// ---------------------------------------------------------------------------
// Setup -- one shared DB for the whole file. Every step below calls the
// REAL implementation (this is what "actual" means in a test); nothing here
// is where expectations come from.
// ---------------------------------------------------------------------------

let db: Db;
const itemsBySlug = new Map<string, Item>();

const sourcesConfig = loadSourcesFile(join(process.cwd(), 'config', 'sources.yaml'));
const interestProfile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
const scoringConfig = loadMechanicalScoreConfig(join(process.cwd(), 'config', 'scoring.yaml'));
const decayConfig = loadDecayConfig(join(process.cwd(), 'config', 'decay.yaml'));
const overridesConfig = loadOverridesConfig(join(process.cwd(), 'config', 'overrides.yaml'));
const clusterConfig = loadClusterConfig(join(process.cwd(), 'config', 'cluster.yaml'));

beforeAll(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-golden-')), 'wf.db'));
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));

  for (const entry of GOLDEN_CORPUS) {
    const inserted = insertItem(db, entry.item);
    itemsBySlug.set(entry.slug, inserted);
  }

  // Real clustering pass, real config/cluster.yaml threshold (0.10).
  runClusteringPass(db, clusterConfig, NOW);

  // Score every distinct item_key once (scoreItem writes one row per beat
  // the key belongs to -- see that function's doc comment).
  const scoredKeys = new Set<string>();
  for (const item of itemsBySlug.values()) {
    if (scoredKeys.has(item.item_key)) continue;
    scoredKeys.add(item.item_key);
    scoreItem(db, item.item_key, NOW, { sources: sourcesConfig, interestProfile, config: scoringConfig });
  }
});

afterAll(() => {
  closeDb(db);
});

// ---------------------------------------------------------------------------
// Test-local helpers. None of these touch src/cluster/** or any other
// off-limits file -- plain SQL against the real, already-migrated schema.
// ---------------------------------------------------------------------------

/** The set of distinct source_ids contributing to itemKey's cluster (empty set if itemKey is a singleton). */
function distinctSourcesInCluster(itemKey: string): Set<string> {
  const membership = db
    .prepare('select cluster_id from item_clusters where item_key = ? order by fetched_at desc, rowid desc limit 1')
    .get(itemKey) as { cluster_id: string } | undefined;
  if (!membership) return new Set();
  const rows = db
    .prepare(
      `select distinct i.source_id as source_id
       from item_clusters ic
       join items i on i.item_key = ic.item_key
       where ic.cluster_id = ?`,
    )
    .all(membership.cluster_id) as Array<{ source_id: string }>;
  return new Set(rows.map((r) => r.source_id));
}

/**
 * Relative-tolerance comparison, uniform across every magnitude this file
 * deals with (0.5^741 included). Tolerance is 1e-5, not machine epsilon:
 * every expected literal in this file is hand-typed to 6-7 significant
 * digits (the independent derivation script computes full double
 * precision -- see task-8-report.md -- but a golden file nobody can read
 * defeats the point of a golden file, so literals here are rounded for
 * human review). 1e-5 comfortably absorbs that intentional rounding while
 * staying many orders of magnitude tighter than any real regression would
 * produce (a wrong config value moves these numbers by percents, not by
 * parts in 100,000).
 */
function expectClose(actual: number, expected: number, label: string): void {
  if (expected === 0) {
    expect(actual, `${label}: expected exactly 0, got ${actual}`).toBe(0);
    return;
  }
  const relErr = Math.abs(actual - expected) / Math.abs(expected);
  expect(relErr, `${label}: actual=${actual} expected=${expected} (relErr=${relErr})`).toBeLessThan(1e-5);
}

function overrideItemInput(slug: string): OverrideItemInput {
  const item = itemsBySlug.get(slug)!;
  return { sourceId: item.sourceId, publishedAt: item.publishedAt, rawJson: item.rawJson };
}

function decayInputFor(slug: string, beat: Beat): DecayInput {
  const item = itemsBySlug.get(slug)!;
  const firstFetchedAt = getItemFirstFetchedAt(db, item.item_key)!;
  return { publishedAt: item.publishedAt, firstFetchedAt, beat, itemType: item.itemType as ItemType };
}

/** decayed(mechanical * decayFactor) for one slug/beat/profile, using the REAL getLatestItemScore + computeDecayFactor. */
function decayedScore(slug: string, beat: Beat, profile: 'signal' | 'read'): number {
  const item = itemsBySlug.get(slug)!;
  const row = getLatestItemScore(db, item.item_key, beat)!;
  const mechanical = profile === 'signal' ? row.signalScore : row.readScore;
  const factor = computeDecayFactor(decayInputFor(slug, beat), profile, NOW, decayConfig);
  return mechanical * factor;
}

/** Composes the real ranking for one beat/profile exactly as evaluateOverrides' own doc comment specifies the query layer should: pinned items first (by priority), then the rest by decayed score descending. Returns slugs in rank order. */
function rankBeat(slugs: string[], beat: Beat, profile: 'signal' | 'read'): string[] {
  const rows = slugs.map((slug) => {
    const overrideProfile: OverrideProfile = profile;
    const override = evaluateOverrides(overrideItemInput(slug), overrideProfile, NOW, overridesConfig);
    return { slug, pinned: override.pinned, priority: override.priority, decayed: decayedScore(slug, beat, profile) };
  });
  rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) return (a.priority ?? 0) - (b.priority ?? 0);
    return b.decayed - a.decayed;
  });
  return rows.map((r) => r.slug);
}

// ---------------------------------------------------------------------------
// 1. Real 3-source cluster: Mangione (ap-news + npr-news + pbs-newshour)
// ---------------------------------------------------------------------------

describe('the only 3-source cluster in the corpus (Mangione)', () => {
  const slugs = ['mangioneAp', 'mangioneNpr', 'mangionePbs'];

  it('unites all three sources into one cluster of size 3', () => {
    for (const slug of slugs) {
      const key = itemsBySlug.get(slug)!.item_key;
      expect(getClusterSizeAsOf(db, key, NOW), slug).toBe(3);
    }
  });

  it('the cluster is genuinely 3 distinct sources, not 3 copies of one (the fix-robust property)', () => {
    const key = itemsBySlug.get('mangioneAp')!.item_key;
    expect(distinctSourcesInCluster(key)).toEqual(new Set(['ap-news', 'npr-news', 'pbs-newshour']));
  });

  it('all three members resolve to the SAME cluster_id', () => {
    const clusterId = (id: string) =>
      (db.prepare('select cluster_id from item_clusters where item_key = ?').get(id) as { cluster_id: string }).cluster_id;
    const ids = slugs.map((s) => clusterId(itemsBySlug.get(s)!.item_key));
    expect(new Set(ids).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Real 2-source cluster: West Bank settler siege (npr-news + pbs-newshour)
//    -- and the same-source, same-topic TRAP that must stay OUT of it.
// ---------------------------------------------------------------------------

describe('the only 2-source cluster in the corpus (West Bank settler siege)', () => {
  it('unites npr-news and pbs-newshour into a cluster of size 2', () => {
    for (const slug of ['westbankNpr', 'westbankPbsActOfTerror']) {
      const key = itemsBySlug.get(slug)!.item_key;
      expect(getClusterSizeAsOf(db, key, NOW), slug).toBe(2);
    }
  });

  it('the cluster is genuinely 2 distinct sources (the fix-robust property)', () => {
    const key = itemsBySlug.get('westbankNpr')!.item_key;
    expect(distinctSourcesInCluster(key)).toEqual(new Set(['npr-news', 'pbs-newshour']));
  });

  it('TRAP: the same-source, same-topic "family recounts" angle stays a singleton', () => {
    const key = itemsBySlug.get('westbankPbsFamilyRecounts')!.item_key;
    expect(getClusterSizeAsOf(db, key, NOW)).toBe(1);
    expect(distinctSourcesInCluster(key)).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// 3. Real near-miss TRAP: two different Ukraine-drone stories must NOT cluster
// ---------------------------------------------------------------------------

describe('TRAP: Ukraine-drone near-miss must NOT cluster', () => {
  it('both stay singleton clusters despite heavy surface overlap', () => {
    for (const slug of ['ukraineNprCrimea', 'ukrainePbsRefinery']) {
      const key = itemsBySlug.get(slug)!.item_key;
      expect(getClusterSizeAsOf(db, key, NOW), slug).toBe(1);
    }
  });

  it('they do not even share the same (nonexistent) cluster_id', () => {
    const cId = (slug: string) =>
      db
        .prepare('select cluster_id from item_clusters where item_key = ?')
        .get(itemsBySlug.get(slug)!.item_key) as { cluster_id: string } | undefined;
    expect(cId('ukraineNprCrimea')).toBeUndefined();
    expect(cId('ukrainePbsRefinery')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Real cross-listed item: BrowseSafe (arxiv-cs-ai + arxiv-cs-cr, one item_key)
// ---------------------------------------------------------------------------

describe('real cross-listed item: BrowseSafe (cs.AI + cs.CR)', () => {
  const key = () => itemsBySlug.get('browsesafeAi')!.item_key;

  it('getItemBeats unions both beats, not just the current version’s', () => {
    expect(getItemBeats(db, key())).toEqual(['ai', 'aisec']);
  });

  it('scoreItem wrote one row per beat, with IDENTICAL mechanical signal_score/read_score (the formula does not vary by beat)', () => {
    const ai = getLatestItemScore(db, key(), 'ai')!;
    const aisec = getLatestItemScore(db, key(), 'aisec')!;
    expect(ai.signalScore).toBe(aisec.signalScore);
    expect(ai.readScore).toBe(aisec.readScore);

    // Hand-derived: sourceComponent = (0.9-0.1)/(2.0-0.1) = 0.8/1.9 = 0.4210526...
    // clusterComponent = 0 (singleton, clusterSize=1, log2(1)=0)
    // interestMultiplier: "prompt injection" boost fires (title AND summary both
    //   contain it verbatim) = 1.8 weight, no suppression match.
    //   = clamp(1 + 0.5*1.8 - 0.8*0, 0.05, 3.0) = clamp(1.9, ...) = 1.9
    // signal_score = (3.5*0 + 3.5*0.4210526...) * 1.9 = 1.473684... * 1.9 = 2.8000
    // read_score   = (1.5*0 + 3.5*0.4210526...) * 1.9 = 1.473684... * 1.9 = 2.8000
    // (signal_weight == read_weight for `source`, and clusterComponent is 0, so
    // signal and read collapse to the identical number here -- a coincidence of
    // this particular item's clusterSize=1, not a general rule.)
    expectClose(ai.signalScore, 2.8, 'browsesafe signal_score');
    expectClose(ai.readScore, 2.8, 'browsesafe read_score');
  });

  it('but the two beats decay at DIFFERENT rates (ai vs aisec half-lives differ), so the FINAL ranked value differs by beat', () => {
    // ai: signal half-life 48h. Age = 2026-08-13T04:00 -> 2026-08-14T12:00 = 32h.
    //   decay = 0.5^(32/48) = 0.5^0.6667 = 0.629960...
    //   decayed signal (ai) = 2.8 * 0.629960 = 1.763890
    // aisec: signal half-life 8h. decay = 0.5^(32/8) = 0.5^4 = 0.0625 exactly.
    //   decayed signal (aisec) = 2.8 * 0.0625 = 0.175 exactly.
    expectClose(decayedScore('browsesafeAi', 'ai', 'signal'), 1.763889, 'browsesafe decayed signal (ai)');
    expectClose(decayedScore('browsesafeCr', 'aisec', 'signal'), 0.175, 'browsesafe decayed signal (aisec)');
  });

  it('the real matchProfile independently confirms "prompt injection" fires and nothing else does', () => {
    const item = itemsBySlug.get('browsesafeAi')!;
    const text = [item.title, item.summaryRaw ?? ''].join(' ');
    const matches = matchProfile(text, interestProfile);
    expect(matches.boosts.map((m) => m.term)).toEqual(['prompt injection']);
    expect(matches.suppressions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Real suppression targets -- including two places a hand-guess was WRONG
//    and only an independently-computed check caught it (see task-8-report.md).
// ---------------------------------------------------------------------------

describe('real suppression targets, and two documented gaps', () => {
  it('Ionescu (team/score-only headline) matches NO boost or suppress term -- the documented gap, confirmed', () => {
    const item = itemsBySlug.get('ionescuAp')!;
    const matches = matchProfile([item.title, item.summaryRaw ?? ''].join(' '), interestProfile);
    expect(matches.boosts).toEqual([]);
    expect(matches.suppressions).toEqual([]);
  });

  it('Swiatek EN is suppressed via "WTA"', () => {
    const item = itemsBySlug.get('swiatekEnAp')!;
    const matches = matchProfile([item.title, item.summaryRaw ?? ''].join(' '), interestProfile);
    expect(matches.suppressions.map((m) => m.term)).toEqual(['WTA']);
  });

  it('Swiatek ES is ALSO suppressed via "WTA" -- an acronym loanword crosses the language boundary (this was NOT the expected finding going in; see report)', () => {
    const item = itemsBySlug.get('swiatekEsAp')!;
    const matches = matchProfile([item.title, item.summaryRaw ?? ''].join(' '), interestProfile);
    expect(matches.suppressions.map((m) => m.term)).toEqual(['WTA']);
  });

  it('Phillies EN is suppressed via "homers" (not "home run" -- the title says "3 homers into corn")', () => {
    const item = itemsBySlug.get('philliesEnAp')!;
    const matches = matchProfile([item.title, item.summaryRaw ?? ''].join(' '), interestProfile);
    expect(matches.suppressions.map((m) => m.term)).toEqual(['homers']);
  });

  it('Filis ES (the SAME real event as Phillies EN) matches NOTHING -- the clean, true Spanish-content gap', () => {
    const item = itemsBySlug.get('filisEsAp')!;
    const matches = matchProfile([item.title, item.summaryRaw ?? ''].join(' '), interestProfile);
    expect(matches.boosts).toEqual([]);
    expect(matches.suppressions).toEqual([]);
  });

  it('both suppressed Swiatek scores hit the configured floor (0.05), since -0.8*1.5 = -1.2 << floor', () => {
    // interestMultiplier = clamp(1 + 0.5*0 - 0.8*1.5, 0.05, 3.0) = clamp(-0.2, 0.05, 3.0) = 0.05
    // sourceComponent (ap-news, 1.8) = 1.7/1.9 = 0.894737; clusterComponent = 0 (singleton)
    // signal_score = read_score = (3.5*0 + 3.5*0.894737) * 0.05 = 3.131579 * 0.05 = 0.1565789...
    for (const slug of ['swiatekEnAp', 'swiatekEsAp', 'philliesEnAp']) {
      const item = itemsBySlug.get(slug)!;
      const row = getLatestItemScore(db, item.item_key, 'usnews')!;
      expectClose(row.signalScore, 0.1565789, `${slug} signal_score`);
      expectClose(row.readScore, 0.1565789, `${slug} read_score`);
    }
  });

  it('the shipped multiplier_floor is independently confirmed by computeInterestMultiplier on a synthetic single-suppression input', () => {
    const m = computeInterestMultiplier({ boosts: [], suppressions: [{ term: 'WTA', weight: 1.5 }] }, scoringConfig);
    expectClose(m, 0.05, 'floored interest multiplier');
  });
});

// ---------------------------------------------------------------------------
// 6. Hard override: cisa-kev-catalog, all three real recency states
// ---------------------------------------------------------------------------

describe('hard override: cisa-kev-catalog (signal-only, recency-bounded)', () => {
  it('null published_at (real, unmodified data) fails closed -- never pins', () => {
    const result = evaluateOverrides(overrideItemInput('cisaKevNull'), 'signal', NOW, overridesConfig);
    expect(result.pinned).toBe(false);
  });

  it('a recent hand-corrected date (2026-08-11, 3.5 days before NOW) pins, priority 30', () => {
    const result = evaluateOverrides(overrideItemInput('cisaKevRecent'), 'signal', NOW, overridesConfig);
    expect(result.pinned).toBe(true);
    expect(result.priority).toBe(30);
    expect(result.matches.map((m) => m.id)).toEqual(['cisa-kev-catalog']);
  });

  it('an old hand-corrected date (2021-11-03, far past the 30-day bound) does NOT pin', () => {
    const result = evaluateOverrides(overrideItemInput('cisaKevOld'), 'signal', NOW, overridesConfig);
    expect(result.pinned).toBe(false);
  });

  it('signal-only: NONE of the three pin on the read profile, even the recent one', () => {
    for (const slug of ['cisaKevNull', 'cisaKevRecent', 'cisaKevOld']) {
      const result = evaluateOverrides(overrideItemInput(slug), 'read', NOW, overridesConfig);
      expect(result.pinned, slug).toBe(false);
    }
  });

  it('all three cisa-kev rows carry the IDENTICAL mechanical score -- overrides never touch the stored score, only ranking', () => {
    // sourceComponent (cisa-kev, weight 2.0 = max_weight) = (2.0-0.1)/(2.0-0.1) = 1.0
    // clusterComponent = 0 (each is a singleton -- verified zero trigram overlap
    //   with anything else in this corpus, see task-8-report.md)
    // interestMultiplier = 1 (no boost/suppress match on any of these titles)
    // signal_score = read_score = 3.5*0 + 3.5*1.0 = 3.5
    for (const slug of ['cisaKevNull', 'cisaKevRecent', 'cisaKevOld']) {
      const item = itemsBySlug.get(slug)!;
      const row = getLatestItemScore(db, item.item_key, 'cyber')!;
      expectClose(row.signalScore, 3.5, `${slug} signal_score`);
      expectClose(row.readScore, 3.5, `${slug} read_score`);
    }
  });

  it('DESPITE the identical mechanical score, the pinned item ranks #1 in cyber signal even though its OWN decayed score is far lower than the non-pinned null item’s -- proving the override genuinely bypasses the score rather than merely correlating with a high one', () => {
    const recentDecayed = decayedScore('cisaKevRecent', 'cyber', 'signal');
    const nullDecayed = decayedScore('cisaKevNull', 'cyber', 'signal');
    expect(recentDecayed).toBeLessThan(nullDecayed); // the pinned item's own decayed score is the SMALLER one
    const ranking = rankBeat(['cisaKevNull', 'cisaKevRecent', 'cisaKevOld', 'krebsPlain'], 'cyber', 'signal');
    expect(ranking[0]).toBe('cisaKevRecent'); // yet it still ranks first, because it is pinned
  });
});

// ---------------------------------------------------------------------------
// 7. signal_score / read_score, pinned separately, for every item -- table-driven
// ---------------------------------------------------------------------------

describe('signal_score and read_score, hand-derived and pinned separately', () => {
  // sourceComponent values (config/sources.yaml weight, clamp((w-0.1)/1.9,0,1)):
  //   ap-news 1.8 -> 0.894737   npr/pbs-news 1.6 -> 0.789474   krebs 1.3 -> 0.631579
  //   arxiv-cs-* 0.9 -> 0.421053   simonwillison 1.4 -> 0.684211   owasp-genai 1.3 -> 0.631579
  //   cisa-kev 2.0 -> 1.000000
  // clusterComponent values (clamp(log2(size)/log2(8),0,1)): size 1 -> 0, size 2 -> 0.333333, size 3 -> 0.528321
  // All interestMultiplier = 1 except the three suppressed items (0.05, see section 5) and browsesafe (1.9, see section 4).
  const cases: Array<[slug: string, beat: Beat, signal: number, read: number, note: string]> = [
    ['mangioneAp', 'usnews', 4.980702, 3.924060, 'ap-news, cluster 3'],
    ['mangioneNpr', 'usnews', 4.612281, 3.555639, 'npr-news, cluster 3'],
    ['mangionePbs', 'usnews', 4.612281, 3.555639, 'pbs-newshour, cluster 3'],
    ['westbankNpr', 'usnews', 3.929825, 3.263158, 'npr-news, cluster 2'],
    ['westbankPbsActOfTerror', 'usnews', 3.929825, 3.263158, 'pbs-newshour, cluster 2'],
    ['westbankPbsFamilyRecounts', 'usnews', 2.763158, 2.763158, 'pbs-newshour, singleton (trap)'],
    ['ukraineNprCrimea', 'usnews', 2.763158, 2.763158, 'npr-news, singleton (trap)'],
    ['ukrainePbsRefinery', 'usnews', 2.763158, 2.763158, 'pbs-newshour, singleton (trap)'],
    ['ionescuAp', 'usnews', 3.131579, 3.131579, 'ap-news, singleton, no interest match'],
    ['filisEsAp', 'usnews', 3.131579, 3.131579, 'ap-news, singleton, no interest match (ES gap)'],
    ['krebsPlain', 'cyber', 2.210526, 2.210526, 'krebs, singleton, no interest match'],
    ['simonwillisonPlain', 'ai', 2.394737, 2.394737, 'simonwillison, singleton, no interest match'],
    ['owaspGenaiTop10', 'aisec', 2.210526, 2.210526, 'owasp-genai, singleton, no interest match'],
  ];

  for (const [slug, beat, signal, read, note] of cases) {
    it(`${slug} (${beat}): ${note}`, () => {
      const item = itemsBySlug.get(slug)!;
      const row = getLatestItemScore(db, item.item_key, beat)!;
      expectClose(row.signalScore, signal, `${slug} signal_score`);
      expectClose(row.readScore, read, `${slug} read_score`);
    });
  }

  it('never blended: every case above has signal_score and read_score stored as two independent columns, never averaged or combined into one', () => {
    // Direct schema-level check: item_scores has exactly two score columns.
    const cols = db.prepare("select name from pragma_table_info('item_scores')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('signal_score');
    expect(names).toContain('read_score');
    // Excludes score_id (a "_id" column, bookkeeping) and scorer_version (an
    // "_version" column, also bookkeeping) -- exactly the two real score
    // VALUES, nothing blended into a third column.
    expect(names.filter((n) => n.endsWith('_score'))).toEqual(['signal_score', 'read_score']);
  });
});

// ---------------------------------------------------------------------------
// 8. Composed, decay-adjusted rankings -- the actual "top items" a reader
//    would see at NOW. This is the layer that answers M2's acceptance
//    question ("does a multi-source story outrank a single-source one?")
//    for real, and the layer where `now` being pinned actually matters.
// ---------------------------------------------------------------------------

describe('composed rankings at the pinned NOW (signal and read, kept separate)', () => {
  const usnewsSlugs = [
    'mangioneAp', 'mangioneNpr', 'mangionePbs',
    'westbankNpr', 'westbankPbsActOfTerror', 'westbankPbsFamilyRecounts',
    'ukraineNprCrimea', 'ukrainePbsRefinery',
    'ionescuAp', 'swiatekEnAp', 'swiatekEsAp', 'philliesEnAp', 'filisEsAp',
  ];

  it('usnews signal ranking: multi-source Mangione sweeps the top, suppressed sports items sink to the bottom', () => {
    const ranking = rankBeat(usnewsSlugs, 'usnews', 'signal');
    expect(ranking).toEqual([
      'mangioneAp', 'mangionePbs', 'mangioneNpr', 'westbankPbsActOfTerror',
      'filisEsAp', 'ionescuAp', 'westbankPbsFamilyRecounts', 'westbankNpr',
      'ukrainePbsRefinery', 'ukraineNprCrimea',
      'philliesEnAp', 'swiatekEsAp', 'swiatekEnAp',
    ]);
  });

  it('every Mangione member outranks every West Bank member on usnews signal -- close (2.7022 vs 2.6941, ~0.3% apart) but real and directionally consistent', () => {
    const mangioneMin = Math.min(...['mangioneAp', 'mangioneNpr', 'mangionePbs'].map((s) => decayedScore(s, 'usnews', 'signal')));
    const westbankMax = Math.max(...['westbankNpr', 'westbankPbsActOfTerror'].map((s) => decayedScore(s, 'usnews', 'signal')));
    expect(mangioneMin).toBeGreaterThan(westbankMax);
    expectClose(mangioneMin, 2.702185, 'weakest Mangione member (npr), decayed signal');
    expectClose(westbankMax, 2.694051, 'strongest West Bank member (pbs), decayed signal');
  });

  it('usnews read ranking: same corroboration story, but the ORDER DIFFERS from signal for one pair -- proof the two scores are not blended', () => {
    const ranking = rankBeat(usnewsSlugs, 'usnews', 'read');
    expect(ranking).toEqual([
      'mangioneAp', 'mangionePbs', 'mangioneNpr', 'westbankPbsActOfTerror',
      'filisEsAp', 'ionescuAp', 'westbankNpr', 'westbankPbsFamilyRecounts',
      'ukrainePbsRefinery', 'ukraineNprCrimea',
      'philliesEnAp', 'swiatekEsAp', 'swiatekEnAp',
    ]);
  });

  it('the westbankNpr / westbankPbsFamilyRecounts pair SWAPS ORDER between signal and read -- a real, verified case where the two-score model produces genuinely different rankings, not just different numbers', () => {
    const signalRanking = rankBeat(['westbankNpr', 'westbankPbsFamilyRecounts'], 'usnews', 'signal');
    const readRanking = rankBeat(['westbankNpr', 'westbankPbsFamilyRecounts'], 'usnews', 'read');
    // signal: familyRecounts (fresher, but no cluster boost) edges out westbankNpr
    //   (older within the day, but a genuine 2-source cluster member) --
    //   usnews signal half-life (24h) is sharp enough that ~13h of extra
    //   freshness outweighs the cluster boost.
    expect(signalRanking).toEqual(['westbankPbsFamilyRecounts', 'westbankNpr']);
    // read: usnews read half-life (168h = 1 week) is slow enough that the
    //   same ~13h freshness gap barely matters, so the cluster boost wins
    //   through -- the order FLIPS.
    expect(readRanking).toEqual(['westbankNpr', 'westbankPbsFamilyRecounts']);
  });

  it('cyber signal ranking: the pinned override wins outright; cyber read ranking has no pins at all (signal-only)', () => {
    const cyberSlugs = ['cisaKevNull', 'cisaKevRecent', 'cisaKevOld', 'krebsPlain'];
    expect(rankBeat(cyberSlugs, 'cyber', 'signal')).toEqual(['cisaKevRecent', 'cisaKevNull', 'krebsPlain', 'cisaKevOld']);
    expect(rankBeat(cyberSlugs, 'cyber', 'read')).toEqual(['cisaKevNull', 'cisaKevRecent', 'krebsPlain', 'cisaKevOld']);
  });

  it('ai and aisec rankings: the boosted, cross-listed BrowseSafe item outranks the plain comparison item in both beats and both profiles', () => {
    expect(rankBeat(['browsesafeAi', 'simonwillisonPlain'], 'ai', 'signal')).toEqual(['browsesafeAi', 'simonwillisonPlain']);
    expect(rankBeat(['browsesafeAi', 'simonwillisonPlain'], 'ai', 'read')).toEqual(['browsesafeAi', 'simonwillisonPlain']);
    expect(rankBeat(['browsesafeCr', 'owaspGenaiTop10'], 'aisec', 'signal')).toEqual(['browsesafeCr', 'owaspGenaiTop10']);
    expect(rankBeat(['browsesafeCr', 'owaspGenaiTop10'], 'aisec', 'read')).toEqual(['browsesafeCr', 'owaspGenaiTop10']);
  });

  it('owaspGenaiTop10’s aisec signal decay is astronomically small (~247 days at an 8h half-life) -- not a practically hand-verifiable magic number, so only its magnitude/ordering is pinned, not an exact float', () => {
    const decayed = decayedScore('owaspGenaiTop10', 'aisec', 'signal');
    expect(decayed).toBeGreaterThan(0); // real double, not underflowed to literal 0 (unlike cisaKevOld's cyber signal below)
    expect(decayed).toBeLessThan(1e-100); // negligible by any practical measure
  });

  it('cisaKevOld’s cyber signal decay DOES underflow to literal 0.0 -- the documented "no floor, may reach exactly 0" design decision (src/score/decay.ts), observed for real', () => {
    const factor = computeDecayFactor(decayInputFor('cisaKevOld', 'cyber'), 'signal', NOW, decayConfig);
    expect(factor).toBe(0);
    expect(decayedScore('cisaKevOld', 'cyber', 'signal')).toBe(0);
  });
});

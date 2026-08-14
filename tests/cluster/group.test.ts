import { describe, it, expect } from 'vitest';
import {
  groupNearDuplicates,
  DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY,
  type ClusterCandidate,
} from '../../src/cluster/group.ts';

// ---------------------------------------------------------------------------
// Small synthetic cases -- exercise the union-find mechanics in isolation
// before the real-corpus cases below exercise them against real titles.
//
// Every candidate below now carries a `sourceId` (fix round 1 -- see the
// "cross-source only" describe block further down for why this field exists
// at all). Fixtures meant to demonstrate "this SHOULD cluster" deliberately
// use DIFFERENT sourceIds per candidate; fixtures where source diversity
// isn't the point use distinct placeholder ids purely so the new
// same-source exclusion never silently confounds an unrelated assertion.
// ---------------------------------------------------------------------------
describe('groupNearDuplicates -- synthetic cases', () => {
  it('two near-identical titles above threshold, different sources, form one group of 2', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Kennedy Center board moves forward with renovations', sourceId: 'source-a' },
      { itemKey: 'b', title: 'Kennedy Center board moves forward with a renovation plan', sourceId: 'source-b' },
    ];
    const groups = groupNearDuplicates(candidates, 0.3);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['a', 'b']);
  });

  it('two completely unrelated titles produce no groups -- singletons are not clusters', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Fed raises interest rates half a point', sourceId: 'source-a' },
      { itemKey: 'b', title: 'Local bakery wins regional pastry award', sourceId: 'source-b' },
    ];
    expect(groupNearDuplicates(candidates, 0.1)).toEqual([]);
  });

  it('an empty candidate list produces no groups', () => {
    expect(groupNearDuplicates([], 0.1)).toEqual([]);
  });

  it('a single candidate produces no groups -- nothing to compare it against', () => {
    expect(groupNearDuplicates([{ itemKey: 'a', title: 'Anything at all', sourceId: 'source-a' }], 0.1)).toEqual([]);
  });

  it('three items with byte-identical titles, three different sources, form one group of 3 (similarity 1.0 pairwise)', () => {
    // Real scenario: a wire story republished verbatim under three different
    // URLs (three different item_keys) by three different outlets.
    const title = 'Fed raises interest rates half a point';
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title, sourceId: 'source-a' },
      { itemKey: 'b', title, sourceId: 'source-b' },
      { itemKey: 'c', title, sourceId: 'source-c' },
    ];
    const groups = groupNearDuplicates(candidates, 0.99);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['a', 'b', 'c']);
  });

  it('two disjoint pairs produce two separate groups, not one', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a1', title: 'Kennedy Center board moves forward with renovations', sourceId: 'source-a' },
      { itemKey: 'a2', title: 'Kennedy Center board moves forward with a renovation plan', sourceId: 'source-b' },
      { itemKey: 'b1', title: 'Fed raises interest rates half a point', sourceId: 'source-a' },
      { itemKey: 'b2', title: 'Fed raises interest rates by half a percentage point', sourceId: 'source-b' },
    ];
    const groups = groupNearDuplicates(candidates, 0.3);
    expect(groups).toHaveLength(2);
    const sorted = groups.map((g) => g.slice().sort()).sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
    expect(sorted).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]);
  });

  it('a lone item mixed in with one real pair stays out of the group', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Kennedy Center board moves forward with renovations', sourceId: 'source-a' },
      { itemKey: 'b', title: 'Kennedy Center board moves forward with a renovation plan', sourceId: 'source-b' },
      { itemKey: 'c', title: 'Completely unrelated story about a bakery', sourceId: 'source-c' },
    ];
    const groups = groupNearDuplicates(candidates, 0.3);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['a', 'b']);
  });

  it('is deterministic -- the same input produces the same grouping on repeated calls', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Kennedy Center board moves forward with renovations', sourceId: 'source-a' },
      { itemKey: 'b', title: 'Kennedy Center board moves forward with a renovation plan', sourceId: 'source-b' },
      { itemKey: 'c', title: 'Fed raises interest rates half a point', sourceId: 'source-c' },
    ];
    const first = groupNearDuplicates(candidates, 0.3);
    const second = groupNearDuplicates(candidates, 0.3);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// REAL CORPUS (M1) -- titles copied by hand, verbatim, from
// attic/wf-m1-firstrun-2026-08-14.db (read-only, never opened by this test).
// Threshold 0.1 throughout this block, matching the production value in
// config/cluster.yaml (task-4-report.md has the full justification) -- kept
// as a local literal rather than importing loadClusterConfig, so this test
// doesn't silently change meaning if the shipped config value is ever
// retuned; see the dedicated "threshold sensitivity" block below for tests
// that are explicitly ABOUT the threshold value itself.
// ---------------------------------------------------------------------------
const PRODUCTION_THRESHOLD = 0.1;

describe('groupNearDuplicates -- real corpus, the Mangione three-way hub', () => {
  it('unites all three real sources into ONE group even though the direct npr/ap-news pair scores exactly 0', () => {
    // Real, exact scores (see similarity.test.ts and task-4-report.md):
    //   npr <-> pbs      2/16 = 0.1250  (clears 0.10)
    //   ap-en <-> pbs    3/12 = 0.2500  (clears 0.10)
    //   npr <-> ap-en    0/15 = 0.0000  (does NOT clear 0.10)
    // A pairwise-only rule would leave npr out of ap-en's group. Transitive
    // (union-find) grouping through the pbs hub is what correctly unites all
    // three into the one real three-source story -- this is the concrete,
    // real-data reason src/cluster/group.ts uses connected components rather
    // than requiring every pair within a group to clear the threshold
    // directly. All three are genuinely different real sources, so fix
    // round 1's same-source exclusion (below) never engages here either.
    const candidates: ClusterCandidate[] = [
      {
        itemKey: 'npr-mangione',
        title: 'Mangione could plead guilty in federal case ahead of N.Y. murder trial',
        sourceId: 'npr-news',
      },
      {
        itemKey: 'pbs-mangione',
        title: 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing',
        sourceId: 'pbs-newshour',
      },
      {
        itemKey: 'ap-mangione',
        title: 'Luigi Mangione expected to plead guilty in killing of UnitedHealthcare CEO',
        sourceId: 'ap-news',
      },
    ];
    const groups = groupNearDuplicates(candidates, PRODUCTION_THRESHOLD);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['ap-mangione', 'npr-mangione', 'pbs-mangione']);
  });
});

describe('groupNearDuplicates -- real corpus, the two required traps must NOT cluster', () => {
  it('TRAP 4: two different Ukraine drone-strike stories stay in separate (non-)groups', () => {
    const candidates: ClusterCandidate[] = [
      {
        itemKey: 'npr-crimea',
        title: "By sky and sea, Ukraine's drone strikes challenge Russia's grip on Crimea",
        sourceId: 'npr-news',
      },
      {
        itemKey: 'pbs-refinery',
        title: 'Ukrainian drones strike major oil refinery deep inside Russia, setting it ablaze',
        sourceId: 'pbs-newshour',
      },
    ];
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('TRAP 5: same source, same underlying event, different angle -- stays out of the group', () => {
    // Real: both genuinely pbs-newshour -- PBS covering its own story twice.
    // Already excluded on trigram-score grounds alone (score is exactly 0,
    // similarity.test.ts), and ALSO now excluded by fix round 1's same-source
    // rule -- two independent reasons, both correct, neither load-bearing
    // for the other.
    const candidates: ClusterCandidate[] = [
      {
        itemKey: 'pbs-condemns',
        title: "'Act of terror': U.S. condemns Israeli settler siege of Palestinian homes in West Bank",
        sourceId: 'pbs-newshour',
      },
      {
        itemKey: 'pbs-family',
        title: 'Palestinian American family recounts siege of West Bank home by Israeli settlers',
        sourceId: 'pbs-newshour',
      },
    ];
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('mixed real set: pair 1 clusters, both traps stay separate, all in one call', () => {
    const candidates: ClusterCandidate[] = [
      {
        itemKey: 'npr-settlers',
        title: "U.S. ambassador calls settler siege of Palestinian homes a 'horrific act of terror'",
        sourceId: 'npr-news',
      },
      {
        itemKey: 'pbs-settlers',
        title: "'Act of terror': U.S. condemns Israeli settler siege of Palestinian homes in West Bank",
        sourceId: 'pbs-newshour',
      },
      {
        itemKey: 'pbs-family',
        title: 'Palestinian American family recounts siege of West Bank home by Israeli settlers',
        sourceId: 'pbs-newshour',
      },
      {
        itemKey: 'npr-crimea',
        title: "By sky and sea, Ukraine's drone strikes challenge Russia's grip on Crimea",
        sourceId: 'npr-news',
      },
      {
        itemKey: 'pbs-refinery',
        title: 'Ukrainian drones strike major oil refinery deep inside Russia, setting it ablaze',
        sourceId: 'pbs-newshour',
      },
    ];
    const groups = groupNearDuplicates(candidates, PRODUCTION_THRESHOLD);
    // Only the genuine pair-1 duplicate group forms. pbs-family (trap 5) and
    // both Crimea/refinery items (trap 4) are absent from every group --
    // note pbs-settlers is NOT double-counted into a second group with
    // pbs-family, because pbs-settlers/pbs-family scores 0 (see
    // similarity.test.ts TRAP 5).
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['npr-settlers', 'pbs-settlers']);
  });
});

describe('groupNearDuplicates -- threshold sensitivity (proves the tests detect a WRONG threshold)', () => {
  // Real: "Mariners to send rookie shortstop Emerson to Triple-A, AP source
  // says" / "Seahawks, cornerback Terrion Arnold are working on a deal, AP
  // source says" -- two genuinely unrelated AP transactions that collide
  // purely on AP's own recurring sourcing boilerplate. Exact score 1/13 ≈
  // 0.0769 (similarity.test.ts). Both are, in reality, ap-news -- fix round
  // 1's same-source rule (below) would ALSO exclude this pair unconditionally
  // now, which would silently defeat this test's purpose of isolating
  // THRESHOLD sensitivity specifically. Deliberately given two DIFFERENT
  // synthetic sourceIds here so this describe block continues to test
  // exactly one variable; the real same-source fact is exercised in its own
  // right by the "cross-source only" block further down.
  function spuriousPair(): ClusterCandidate[] {
    return [
      {
        itemKey: 'mariners',
        title: 'Mariners to send rookie shortstop Emerson to Triple-A, AP source says',
        sourceId: 'source-1',
      },
      {
        itemKey: 'seahawks',
        title: 'Seahawks, cornerback Terrion Arnold are working on a deal, AP source says',
        sourceId: 'source-2',
      },
    ];
  }

  it('at the PRODUCTION threshold (0.10), the spurious pair correctly stays apart', () => {
    expect(groupNearDuplicates(spuriousPair(), PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('at a WRONG, too-loose threshold (0.05), the same spurious pair incorrectly merges', () => {
    // This is the mechanism, not a hypothetical: proves groupNearDuplicates
    // actually responds to its threshold argument on real data, rather than
    // this test suite merely happening to pass at whatever threshold ships.
    // A future change that ignored the threshold parameter (e.g. hardcoding
    // a comparison) would make THIS test fail to demonstrate the unsafe
    // behavior it exists to document, which is itself a signal something
    // regressed.
    const groups = groupNearDuplicates(spuriousPair(), 0.05);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['mariners', 'seahawks']);
  });

  it('at a WRONG, too-loose threshold (0.05), TRAP 4 (real, must-not-cluster) would ALSO incorrectly merge if it scored above 0 -- documented control: it does not, because trigram Jaccard (not the threshold) already zeroes it', () => {
    // TRAP 4 scores an exact 0 (similarity.test.ts) regardless of threshold,
    // as long as the threshold stays > 0 -- this is the module's defense in
    // depth: word-level trigrams with no stemming already refuse to match
    // "Ukraine's drone strikes"/"Ukrainian drones strike" at all, so no
    // threshold choice alone could accidentally merge it. Proven here by
    // showing it stays apart even at the same loose 0.05 that DOES merge the
    // AP-boilerplate spurious pair above -- the two traps are not protected
    // by the same mechanism, and this test tells them apart.
    const candidates: ClusterCandidate[] = [
      {
        itemKey: 'npr-crimea',
        title: "By sky and sea, Ukraine's drone strikes challenge Russia's grip on Crimea",
        sourceId: 'npr-news',
      },
      {
        itemKey: 'pbs-refinery',
        title: 'Ukrainian drones strike major oil refinery deep inside Russia, setting it ablaze',
        sourceId: 'pbs-newshour',
      },
    ];
    expect(groupNearDuplicates(candidates, 0.05)).toEqual([]);
    // But threshold 0 would merge EVERYTHING (every score is >= 0) -- the
    // one value where even trigram Jaccard's own zero stops providing
    // protection. Included to make the boundary explicit rather than assumed.
    expect(groupNearDuplicates(candidates, 0)).toHaveLength(1);
  });

  it('at a stricter-than-needed threshold (0.30), even the strongest real pair (Mangione ap-en/pbs, 0.25) is missed', () => {
    // Demonstrates the OTHER direction of sensitivity: too strict, and real
    // duplicates are lost. Included so this describe block proves the tests
    // catch a threshold that is wrong in EITHER direction, not just "too
    // loose".
    const candidates: ClusterCandidate[] = [
      {
        itemKey: 'pbs-mangione',
        title: 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing',
        sourceId: 'pbs-newshour',
      },
      {
        itemKey: 'ap-mangione',
        title: 'Luigi Mangione expected to plead guilty in killing of UnitedHealthcare CEO',
        sourceId: 'ap-news',
      },
    ];
    expect(groupNearDuplicates(candidates, 0.3)).toEqual([]);
    // The identical pair DOES cluster at the production threshold.
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toHaveLength(1);
  });
});

// =============================================================================
// FIX ROUND 1 -- transitive chaining across formulaic/templated corpora.
//
// Reported against a fresh, real 4,134-item ingest (data/wf.db, copied
// read-only via `sqlite3 data/wf.db "VACUUM INTO ..."`, never written to --
// see task-4-report.md's fix-round-1 section for the full account):
// runClusteringPass produced a single 1,543-member cluster (37% of the whole
// corpus), 100% cisa-kev, and a 28-member cluster, 100% huggingface-blog.
// Mechanism, confirmed directly against this module's own trigramJaccard:
// MOST pairs score exactly 0, but a handful of formulaic phrases ("remote
// code execution", corpus document frequency 196; "improper input
// validation", 38; "large language models", 30) act as bridges that
// transitively weld huge, otherwise-unrelated swaths of a single-genre
// corpus together. Individual pair scores were never wrong -- single-link
// (union-find) transitivity is what turns many small, individually-plausible
// bridges into one enormous, meaningless component.
//
// TWO fixes, both required (proven independently below, and jointly against
// real titles):
//
// 1. CROSS-SOURCE ONLY. Two candidates sharing a source_id are never
//    unioned, regardless of score. Directly matches this project's own
//    stated definition of what a cluster means (docs/superpowers/plans/
//    2026-08-14-m2-scoring.md: "a story carried by AP *and* NPR *and* PBS is
//    national news almost by definition") -- corroboration is inherently a
//    CROSS-source claim; two items from the same outlet can never corroborate
//    each other in that sense, so their textual similarity (however high)
//    was never evidence of the thing a cluster is meant to represent. This
//    ALONE fully eliminates both real pathological clusters above -- both
//    were 100% single-source. It does not touch src/cluster/store.ts's
//    writeClusters or getClusterSizeAsOf, which stay exactly as validated in
//    the original Task 4 report -- see that report and this file's own
//    "COMPATIBILITY" block below for why that specific boundary was chosen.
//
// 2. BOILERPLATE TRIGRAM FILTERING. Separately, full-corpus validation (the
//    fix round's own instruction: "validate against the FULL corpus this
//    time, not one beat") found a SECOND, smaller-scale instance of the
//    identical pathology CROSSING source boundaries -- real arxiv-cs-ai /
//    huggingface-blog titles about unrelated "vision-language model" papers
//    and posts, which cross-source-only alone cannot catch (see the
//    dedicated describe block below for the real 15-title proof). A trigram
//    whose document frequency across the WHOLE candidate set exceeds
//    DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY is dropped from every candidate's
//    shingle set before Jaccard is computed -- the same principle as this
//    module's existing hand-picked STOPWORDS list, generalized from
//    "universally common in English" to "common within THIS corpus", and
//    computed fresh per call (never hardcoded), since which phrases are
//    boilerplate is inherently a property of the CANDIDATE SET, not of any
//    one title.
// =============================================================================

describe('groupNearDuplicates -- fix round 1: cross-source only', () => {
  it('two candidates with the IDENTICAL title do NOT cluster if they share a source_id', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Fed raises interest rates half a point', sourceId: 'ap-news' },
      { itemKey: 'b', title: 'Fed raises interest rates half a point', sourceId: 'ap-news' },
    ];
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('control: the identical pair DOES cluster once given different sourceIds, all else equal', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Fed raises interest rates half a point', sourceId: 'ap-news' },
      { itemKey: 'b', title: 'Fed raises interest rates half a point', sourceId: 'npr-news' },
    ];
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toHaveLength(1);
  });

  it('REAL REGRESSION: a real 4-title CVE chain (cisa-kev) from the fresh 2026-08-14 ingest, transitively linked end-to-end under the OLD algorithm, no longer clusters', () => {
    // Real titles, real chain, found by BFS over the actual fresh corpus
    // (data/wf.db copy) between the two endpoints the fix-round report named
    // ("Microsoft Windows Remote Code Execution Vulnerability" and "Nagios
    // XI OS Command Injection", which score an exact 0 against each other
    // directly). All four are genuinely cisa-kev. Exact adjacent-pair scores
    // (verified against this module's own trigramJaccard):
    //   [0]<>[1] 0.2857  (shared: "remote code execution")
    //   [1]<>[2] 0.1111  (shared: "oracle weblogic server")
    //   [2]<>[3] 0.1429  (shared: "os command injection")
    //   [0]<>[2] = [0]<>[3] = [1]<>[3] = 0.0000 (no direct relationship at all)
    // Under the pre-fix algorithm, transitivity alone would still weld all
    // four into one cluster via 0-1-2-3 even though the endpoints are
    // completely unrelated CVEs.
    const candidates: ClusterCandidate[] = [
      { itemKey: 'cve-1', title: 'Microsoft Windows Remote Code Execution Vulnerability', sourceId: 'cisa-kev' },
      { itemKey: 'cve-2', title: 'Oracle WebLogic Server Remote Code Execution Vulnerability', sourceId: 'cisa-kev' },
      {
        itemKey: 'cve-3',
        title: 'Oracle WebLogic Server OS Command Injection Vulnerability',
        sourceId: 'cisa-kev',
      },
      { itemKey: 'cve-4', title: 'Nagios XI OS Command Injection', sourceId: 'cisa-kev' },
    ];
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('REAL REGRESSION: six real AP MLB preview headlines (all ap-news, all templated "X host/take on the Y ... 3-game series") stay apart, though every adjacent pair clears the production threshold', () => {
    // Real, verbatim titles from the fresh 2026-08-14 ingest (all source_id
    // ap-news). The task-4 fix-round report names one pair explicitly
    // ("Blue Jays host the Yankees..." / "Cubs host the Cardinals...",
    // exactly 0.1000); all six are included here because they are mutually,
    // densely connected (many pairs score 0.10-0.25) and would form ONE
    // cluster under the pre-fix algorithm, not just a chain of pairs.
    const candidates: ClusterCandidate[] = [
      { itemKey: 'mlb-1', title: 'Blue Jays host the Yankees to start 3-game series', sourceId: 'ap-news' },
      { itemKey: 'mlb-2', title: 'Cubs host the Cardinals in first of 3-game series', sourceId: 'ap-news' },
      { itemKey: 'mlb-3', title: 'Giants host the Rockies in first of 3-game series', sourceId: 'ap-news' },
      { itemKey: 'mlb-4', title: 'Mets host the Nationals on 3-game home skid', sourceId: 'ap-news' },
      {
        itemKey: 'mlb-5',
        title: 'Braves take on the Diamondbacks in first of 3-game series',
        sourceId: 'ap-news',
      },
      { itemKey: 'mlb-6', title: 'Pirates host the Red Sox in first of 3-game series', sourceId: 'ap-news' },
    ];
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toEqual([]);
  });
});

describe('groupNearDuplicates -- fix round 1: boilerplate trigram (document-frequency) filtering', () => {
  it('a phrase common to MANY different-source candidates does not, alone, cluster two of them -- synthetic isolation of just this mechanism', () => {
    // 8 candidates, 8 DIFFERENT sources (so cross-source-only never engages),
    // all sharing one artificially common 3-word phrase and NOTHING else.
    // Real corpus analogue: "remote code execution" (df=196), "large
    // language models" (df=30) -- see the REAL REGRESSION test below for the
    // real-title version of exactly this shape.
    const candidates: ClusterCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      itemKey: `common-${i}`,
      title: `Widget ${i} suffers boilerplate phrase failure today`,
      sourceId: `source-${i}`,
    }));
    // Every pair shares ONLY "boilerplate phrase failure" -- verify that
    // WITHOUT filtering these would indeed connect (a sanity check the test
    // itself is well-formed), then verify the real call excludes them.
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('control: two candidates sharing a RARE phrase (unique to just the two of them) still cluster -- filtering does not blanket-suppress every shared trigram', () => {
    const boilerplate = Array.from({ length: 8 }, (_, i) => ({
      itemKey: `common-${i}`,
      title: `Widget ${i} suffers boilerplate phrase failure today`,
      sourceId: `source-${i}`,
    }));
    const genuine: ClusterCandidate[] = [
      { itemKey: 'real-a', title: 'Kennedy Center board moves forward with renovations', sourceId: 'source-x' },
      {
        itemKey: 'real-b',
        title: 'Kennedy Center board moves forward with a renovation plan',
        sourceId: 'source-y',
      },
    ];
    const groups = groupNearDuplicates([...boilerplate, ...genuine], PRODUCTION_THRESHOLD);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['real-a', 'real-b']);
  });

  it('REAL REGRESSION: 15 real arxiv-cs-ai / huggingface-blog titles about UNRELATED "vision-language model" work do not merge -- proves cross-source-only ALONE is not sufficient', () => {
    // Real, verbatim titles from the fresh 2026-08-14 ingest. Without ANY
    // fix, these 30 edges (>= 0.10) collapse into a 9-member and a 4-member
    // cluster. With cross-source-only ALONE (no doc-frequency filtering),
    // one 3-member cluster SURVIVES -- a real arxiv paper about "China-Origin
    // Vision-Language Models... State Alignment" incorrectly grouped with
    // two unrelated huggingface-blog posts ("A Dive into Vision-Language
        // Models", "Vision Language Models Explained"), because the arxiv title
    // clears 0.10 against EACH of them (both exactly 0.1000) purely via the
    // shared "vision language models" phrase. Both fixes together (matching
    // production exactly) reduce this to zero false merges. Verified against
    // this module's own logic in task-4-report.md's fix-round-1 validation
    // script before this test was written.
    const candidates: ClusterCandidate[] = [
      {
        itemKey: 'vlm-1',
        title: 'A Simple Efficiency Incremental Learning Framework via Vision-Language Model with Nonlinear Multi-Adapters',
        sourceId: 'arxiv-cs-ai',
      },
      {
        itemKey: 'vlm-2',
        title: 'How China-Origin Vision-Language Models Move from Refusal to Reframing in State Alignment',
        sourceId: 'arxiv-cs-ai',
      },
      {
        itemKey: 'vlm-3',
        title:
          'VLM2Rec: Resolving Modality Collapse in Vision-Language Model Embedders for Multimodal Sequential Recommendation',
        sourceId: 'arxiv-cs-ai',
      },
      { itemKey: 'vlm-4', title: 'A Dive into Vision-Language Models', sourceId: 'huggingface-blog' },
      {
        itemKey: 'vlm-5',
        title: 'Accelerating Vision-Language Models: BridgeTower on Habana Gaudi2',
        sourceId: 'huggingface-blog',
      },
      {
        itemKey: 'vlm-6',
        title: "Fine-tuning Florence-2 - Microsoft's Cutting-edge Vision Language Models",
        sourceId: 'huggingface-blog',
      },
      {
        itemKey: 'vlm-7',
        title: 'Introducing Idefics2: A Powerful 8B Vision-Language Model for the community',
        sourceId: 'huggingface-blog',
      },
      {
        itemKey: 'vlm-8',
        title: 'PaliGemma 2 Mix - New Instruction Vision Language Models by Google',
        sourceId: 'huggingface-blog',
      },
      {
        itemKey: 'vlm-9',
        title: "PaliGemma – Google's Cutting-Edge Open Vision Language Model",
        sourceId: 'huggingface-blog',
      },
      { itemKey: 'vlm-10', title: 'Preference Optimization for Vision Language Models', sourceId: 'huggingface-blog' },
      { itemKey: 'vlm-11', title: 'SmolVLM - small yet mighty Vision Language Model', sourceId: 'huggingface-blog' },
      { itemKey: 'vlm-12', title: 'Vision Language Model Alignment in TRL ⚡️', sourceId: 'huggingface-blog' },
      {
        itemKey: 'vlm-13',
        title: 'Vision Language Models (Better, faster, stronger)',
        sourceId: 'huggingface-blog',
      },
      { itemKey: 'vlm-14', title: 'Vision Language Models Explained', sourceId: 'huggingface-blog' },
      {
        itemKey: 'vlm-15',
        title: 'Welcome PaliGemma 2 – New vision language models by Google',
        sourceId: 'huggingface-blog',
      },
    ];
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('the DEFAULT cap is exported and used when the third argument is omitted -- callers get the fix without having to know the number', () => {
    expect(DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY).toBeGreaterThanOrEqual(2);
    const boilerplate = Array.from({ length: 8 }, (_, i) => ({
      itemKey: `common-${i}`,
      title: `Widget ${i} suffers boilerplate phrase failure today`,
      sourceId: `source-${i}`,
    }));
    // Called with exactly two arguments, same call shape as every OTHER test
    // in this file and as tests/cluster/run.test.ts's config() helper --
    // proves the default parameter, not an explicit override, is what's
    // doing the filtering here.
    expect(groupNearDuplicates(boilerplate, PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('threshold sensitivity for the CAP itself: a too-loose cap (equal to the fixture size) lets the boilerplate phrase merge everything, proving this mechanism is real and tunable, not vacuous', () => {
    const boilerplate: ClusterCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      itemKey: `common-${i}`,
      title: `Widget ${i} suffers boilerplate phrase failure today`,
      sourceId: `source-${i}`,
    }));
    // At the production default this must NOT merge (asserted above too).
    expect(groupNearDuplicates(boilerplate, PRODUCTION_THRESHOLD, DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY)).toEqual(
      [],
    );
    // With the cap raised to 8 (the phrase's actual document frequency in
    // this exact fixture), filtering no longer removes it, and single-link
    // chaining welds all 8 into one cluster -- the literal failure mode this
    // whole fix round exists to prevent, reproduced deliberately to prove
    // the cap parameter is load-bearing.
    const looseGroups = groupNearDuplicates(boilerplate, PRODUCTION_THRESHOLD, 8);
    expect(looseGroups).toHaveLength(1);
    expect(looseGroups[0]).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// COMPATIBILITY -- fix round 1 changed ClusterCandidate's shape (added
// sourceId) and groupNearDuplicates' signature (added an optional third
// parameter), but deliberately did NOT touch writeClusters or
// getClusterSizeAsOf (src/cluster/store.ts) or their contracts. This matters
// beyond this module: tests/score/mechanical.test.ts (a sibling's file, off
// limits) calls writeClusters directly with a hand-built, same-source
// two-item group and asserts getClusterSizeAsOf then reports more than a
// singleton -- that test would break if cross-source exclusion or
// document-frequency filtering were pushed down into writeClusters/
// getClusterSizeAsOf instead of staying in groupNearDuplicates, which is
// exactly why the fix lives ONLY here. See task-4-report.md's fix-round-1
// section for the full investigation.
// ---------------------------------------------------------------------------
describe('groupNearDuplicates -- fix round 1 compatibility notes', () => {
  it('groupNearDuplicates still accepts a bare (candidates, threshold) call -- the new third parameter is additive, not a breaking signature change', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Kennedy Center board moves forward with renovations', sourceId: 'source-a' },
      { itemKey: 'b', title: 'Kennedy Center board moves forward with a renovation plan', sourceId: 'source-b' },
    ];
    expect(groupNearDuplicates(candidates, 0.3)).toHaveLength(1);
  });
});

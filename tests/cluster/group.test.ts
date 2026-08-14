import { describe, it, expect } from 'vitest';
import { groupNearDuplicates, type ClusterCandidate } from '../../src/cluster/group.ts';

// ---------------------------------------------------------------------------
// Small synthetic cases -- exercise the union-find mechanics in isolation
// before the real-corpus cases below exercise them against real titles.
// ---------------------------------------------------------------------------
describe('groupNearDuplicates -- synthetic cases', () => {
  it('two near-identical titles above threshold form one group of 2', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Kennedy Center board moves forward with renovations' },
      { itemKey: 'b', title: 'Kennedy Center board moves forward with a renovation plan' },
    ];
    const groups = groupNearDuplicates(candidates, 0.3);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['a', 'b']);
  });

  it('two completely unrelated titles produce no groups -- singletons are not clusters', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Fed raises interest rates half a point' },
      { itemKey: 'b', title: 'Local bakery wins regional pastry award' },
    ];
    expect(groupNearDuplicates(candidates, 0.1)).toEqual([]);
  });

  it('an empty candidate list produces no groups', () => {
    expect(groupNearDuplicates([], 0.1)).toEqual([]);
  });

  it('a single candidate produces no groups -- nothing to compare it against', () => {
    expect(groupNearDuplicates([{ itemKey: 'a', title: 'Anything at all' }], 0.1)).toEqual([]);
  });

  it('three items with byte-identical titles form one group of 3 (similarity 1.0 pairwise)', () => {
    // Real scenario: a wire story republished verbatim under three different
    // URLs (three different item_keys) by three different outlets.
    const title = 'Fed raises interest rates half a point';
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title },
      { itemKey: 'b', title },
      { itemKey: 'c', title },
    ];
    const groups = groupNearDuplicates(candidates, 0.99);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['a', 'b', 'c']);
  });

  it('two disjoint pairs produce two separate groups, not one', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a1', title: 'Kennedy Center board moves forward with renovations' },
      { itemKey: 'a2', title: 'Kennedy Center board moves forward with a renovation plan' },
      { itemKey: 'b1', title: 'Fed raises interest rates half a point' },
      { itemKey: 'b2', title: 'Fed raises interest rates by half a percentage point' },
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
      { itemKey: 'a', title: 'Kennedy Center board moves forward with renovations' },
      { itemKey: 'b', title: 'Kennedy Center board moves forward with a renovation plan' },
      { itemKey: 'c', title: 'Completely unrelated story about a bakery' },
    ];
    const groups = groupNearDuplicates(candidates, 0.3);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slice().sort()).toEqual(['a', 'b']);
  });

  it('is deterministic -- the same input produces the same grouping on repeated calls', () => {
    const candidates: ClusterCandidate[] = [
      { itemKey: 'a', title: 'Kennedy Center board moves forward with renovations' },
      { itemKey: 'b', title: 'Kennedy Center board moves forward with a renovation plan' },
      { itemKey: 'c', title: 'Fed raises interest rates half a point' },
    ];
    const first = groupNearDuplicates(candidates, 0.3);
    const second = groupNearDuplicates(candidates, 0.3);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// REAL CORPUS -- titles copied by hand, verbatim, from
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
    // directly.
    const candidates: ClusterCandidate[] = [
      { itemKey: 'npr-mangione', title: 'Mangione could plead guilty in federal case ahead of N.Y. murder trial' },
      {
        itemKey: 'pbs-mangione',
        title: 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing',
      },
      {
        itemKey: 'ap-mangione',
        title: 'Luigi Mangione expected to plead guilty in killing of UnitedHealthcare CEO',
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
      },
      {
        itemKey: 'pbs-refinery',
        title: 'Ukrainian drones strike major oil refinery deep inside Russia, setting it ablaze',
      },
    ];
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('TRAP 5: same source, same underlying event, different angle -- stays out of the group', () => {
    const candidates: ClusterCandidate[] = [
      {
        itemKey: 'pbs-condemns',
        title: "'Act of terror': U.S. condemns Israeli settler siege of Palestinian homes in West Bank",
      },
      {
        itemKey: 'pbs-family',
        title: 'Palestinian American family recounts siege of West Bank home by Israeli settlers',
      },
    ];
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toEqual([]);
  });

  it('mixed real set: pair 1 clusters, both traps stay separate, all in one call', () => {
    const candidates: ClusterCandidate[] = [
      {
        itemKey: 'npr-settlers',
        title: "U.S. ambassador calls settler siege of Palestinian homes a 'horrific act of terror'",
      },
      {
        itemKey: 'pbs-settlers',
        title: "'Act of terror': U.S. condemns Israeli settler siege of Palestinian homes in West Bank",
      },
      {
        itemKey: 'pbs-family',
        title: 'Palestinian American family recounts siege of West Bank home by Israeli settlers',
      },
      {
        itemKey: 'npr-crimea',
        title: "By sky and sea, Ukraine's drone strikes challenge Russia's grip on Crimea",
      },
      {
        itemKey: 'pbs-refinery',
        title: 'Ukrainian drones strike major oil refinery deep inside Russia, setting it ablaze',
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
  // 0.0769 (similarity.test.ts). This is the single most important real
  // false-positive risk found during validation: it scores HIGHER than the
  // real Kennedy Center pair (1/17 ≈ 0.0588), so it is real, concrete proof
  // that a threshold loose enough to catch Kennedy Center is also loose
  // enough to merge two unrelated sports transactions.
  function spuriousPair(): ClusterCandidate[] {
    return [
      { itemKey: 'mariners', title: 'Mariners to send rookie shortstop Emerson to Triple-A, AP source says' },
      {
        itemKey: 'seahawks',
        title: 'Seahawks, cornerback Terrion Arnold are working on a deal, AP source says',
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
      },
      {
        itemKey: 'pbs-refinery',
        title: 'Ukrainian drones strike major oil refinery deep inside Russia, setting it ablaze',
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
      },
      {
        itemKey: 'ap-mangione',
        title: 'Luigi Mangione expected to plead guilty in killing of UnitedHealthcare CEO',
      },
    ];
    expect(groupNearDuplicates(candidates, 0.3)).toEqual([]);
    // The identical pair DOES cluster at the production threshold.
    expect(groupNearDuplicates(candidates, PRODUCTION_THRESHOLD)).toHaveLength(1);
  });
});

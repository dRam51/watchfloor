/**
 * Turns pairwise title similarity (src/cluster/similarity.ts) into clusters:
 * groups of item_keys that are, transitively, near-duplicates of each other.
 *
 * Pure and synchronous -- no I/O, no database, no config loading. Takes a
 * plain candidate list and a threshold, returns plain groups. The DB-facing
 * caller (src/cluster/store.ts) resolves candidates from `items` and the
 * threshold from config/cluster.yaml (src/cluster/config.ts), then calls
 * this.
 *
 * ## Transitive (connected-components) grouping, not pairwise-only
 *
 * This is a real, evidence-driven design decision, not the default choice
 * taken for granted. The real Mangione story in the M1 corpus (see
 * group.test.ts's "Mangione three-way hub" and task-4-report.md) has this
 * exact shape:
 *
 *   npr <-> pbs     0.1250  (clears the production threshold)
 *   ap-en <-> pbs   0.2500  (clears the production threshold)
 *   npr <-> ap-en   0.0000  (does NOT clear it -- shares no 3-word phrase)
 *
 * A rule that required every pair within a group to independently clear the
 * threshold ("complete-link") would leave npr stranded outside ap-en's
 * cluster, splitting one genuine three-source story into two, even though
 * pbs's title independently links both. Grouping by CONNECTED COMPONENTS
 * (union-find) unites all three through the pbs hub, matching what a human
 * reader would call "one story, three outlets" -- which is exactly the
 * multi-source-pickup signal the mechanical scorer (Task 5) needs cluster
 * size to carry. Complete-linkage was measured and rejected for exactly this
 * reason: it would split the real Mangione three-way story (see
 * task-4-report.md's fix-round-1 section).
 *
 * ## FIX ROUND 1 -- transitive chaining across formulaic/templated corpora
 *
 * The original version of this module stated that chaining was "not
 * specially guarded against... zero confirmed real occurrences" based on an
 * exhaustive sweep of the 180-title usnews corpus. That sweep was real and
 * correctly conducted, but it covered one beat. A fresh, full, real 4,134-
 * item ingest (all beats -- data/wf.db, copied read-only, never written to;
 * see task-4-report.md's fix-round-1 section for the full account) produced
 * a single 1,543-member cluster (37% of the entire corpus, 100% cisa-kev)
 * and a 28-member cluster (100% huggingface-blog). The individual pair
 * scores were never wrong (most pairs anywhere in the corpus score exactly
 * 0) -- the mechanism is exactly the chaining risk this module's own doc
 * comment already named: a handful of formulaic phrases ("remote code
 * execution", corpus document frequency 196 of 4,134; "large language
 * models", 30) bridge pairs that individually look like plausible near-
 * duplicates, and single-link transitivity welds those bridges into one
 * enormous, meaningless component. The conclusion was right for the data
 * tested and wrong for the corpus as a whole.
 *
 * Two independent defenses, both required (see task-4-report.md and
 * group.test.ts's "fix round 1" tests for the full real-data proof of each):
 *
 * 1. CROSS-SOURCE ONLY (the `sourceId` check inline in `groupNearDuplicates`'s
 *    comparison loop below). Two candidates sharing a `sourceId` are never
 *    unioned, full stop, regardless of score. This
 *    directly matches this project's own definition of what a cluster means
 *    (docs/superpowers/plans/2026-08-14-m2-scoring.md: "a story carried by
 *    AP *and* NPR *and* PBS is national news almost by definition") --
 *    corroboration is inherently a CROSS-source claim, so two items from one
 *    outlet were never evidence of the thing a cluster exists to represent,
 *    independent of how textually similar their titles happen to be. This
 *    ALONE fully eliminates both real pathological clusters above (both were
 *    100% single-source) and is the PRIMARY fix.
 * 2. BOILERPLATE TRIGRAM FILTERING (`filterBoilerplateShingles` below). A
 *    SEPARATE, smaller-scale instance of the identical pathology was found
 *    CROSSING source boundaries during full-corpus validation -- real
 *    arxiv-cs-ai / huggingface-blog titles about unrelated "vision-language
 *    model" papers and posts, which cross-source-only alone cannot catch
 *    (two DIFFERENT sources, so the exclusion above never engages). Any
 *    trigram whose document frequency across the WHOLE candidate set exceeds
 *    `maxBridgeDocumentFrequency` is dropped from every candidate's shingle
 *    set before Jaccard is computed. This generalizes the SAME principle
 *    `src/cluster/similarity.ts`'s hand-picked STOPWORDS list already uses
 *    (a token too generic to carry identity is excluded) from "universally
 *    common in English" to "common within this specific candidate set" --
 *    which a fixed, hardcoded list could never capture, since which phrases
 *    are boilerplate is a property of THIS batch of titles, not of the
 *    English language. Computed fresh on every call, never cached or
 *    hardcoded.
 *
 * Neither fix touches `src/cluster/store.ts`'s `writeClusters` or
 * `getClusterSizeAsOf` -- both stay exactly as validated in the original
 * Task 4 report. This is a deliberate boundary, not an oversight: a sibling
 * milestone task's test (`tests/score/mechanical.test.ts`, off limits to
 * this module's owner) calls `writeClusters` directly with a hand-built,
 * same-source two-item group and asserts `getClusterSizeAsOf` then reports
 * more than a singleton. Pushing either defense down into the write/read
 * layer instead of keeping it here, in the GROUPING algorithm, would have
 * broken that already-committed, already-passing test. See
 * task-4-report.md's fix-round-1 section for the full investigation and
 * group.test.ts's "compatibility" block for the note in test form.
 *
 * ## Cost
 *
 * O(n^2) pairwise comparisons over the candidate list. Each candidate's raw
 * shingle set is computed once; a corpus-wide document-frequency map is then
 * built in one additional O(total shingles) pass, and a FILTERED shingle set
 * per candidate is derived from it once -- so the O(n^2) loop itself is no
 * more expensive per comparison than before the fix (a same-source check
 * plus a Jaccard over an already-filtered set). Measured against the real
 * 4,134-item fresh ingest (task-4-report.md's fix-round-1 validation
 * script): well under a few seconds. Not batched or indexed further -- same
 * "don't build it until something needs it" stance as
 * src/domain/itemBeats.ts's documented cost note.
 */

import { titleTrigrams, jaccardSimilarity } from './similarity.ts';

export interface ClusterCandidate {
  /** Stable identity across item versions -- see db/migrations/0001_init.sql. */
  itemKey: string;
  /** The candidate's current title, e.g. from getCurrentItem or an equivalent query. */
  title: string;
  /**
   * The candidate's current source_id (fix round 1). Required, not optional
   * -- every real `items` row has a `source_id` (`items.source_id text not
   * null`, db/migrations/0001_init.sql), so a candidate without one would
   * mean the caller's query is already wrong, not a legitimate "unknown
   * source" state worth silently tolerating here.
   */
  sourceId: string;
}

// Fix round 1's boilerplate-trigram cap, used whenever a caller does not
// supply its own (e.g. tests/score/pass.test.ts's `{ near_duplicate_threshold:
// 0.1 }` literal, which predates this field and must keep typechecking and
// behaving sensibly -- see src/cluster/config.ts's matching `.optional()`
// field and its own doc comment for the full compatibility reasoning).
//
// Chosen from real full-corpus evidence (task-4-report.md's fix-round-1
// section): the largest genuine cross-source corroboration found in the
// fresh 4,134-item ingest is a real 3-outlet story (a Niger-missionary
// release, pbs-newshour/npr-news/ap-news), whose bridging trigrams have
// document frequency 2-3 within that corpus. The real boilerplate phrases
// that caused the reported failure start at document frequency 9 ("vision
// language models") and run into the hundreds ("remote code execution",
// 196). 5 sits with real margin above the largest confirmed-genuine case (3)
// and well below where confirmed boilerplate starts (9+) -- the same
// "margin on both sides, not a knife-edge fit" reasoning already used for
// config/cluster.yaml's near_duplicate_threshold in the original Task 4
// report. Verified directly: this value fully resolves both real regression
// cases in group.test.ts's "fix round 1" block (the cisa-kev CVE chain and
// the arxiv/huggingface "vision-language model" false merge) while leaving
// every one of the five originally-required real cases, the Mangione
// three-way hub, and a real 3-outlet corroboration case all correctly
// clustering.
export const DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY = 5;

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    const parent = this.parent.get(key);
    if (parent === undefined) throw new Error(`UnionFind.find: unknown key '${key}'`);
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root); // path compression
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

/**
 * Document frequency: for each trigram, how many DISTINCT candidates'
 * (already-filtered-for-nothing-yet, i.e. raw) shingle sets contain it. A
 * trigram shared by exactly two candidates -- the minimum possible for it to
 * matter to clustering at all -- has document frequency 2.
 */
function computeDocumentFrequency(shingleSets: ReadonlyArray<ReadonlySet<string>>): Map<string, number> {
  const freq = new Map<string, number>();
  for (const shingles of shingleSets) {
    for (const shingle of shingles) {
      freq.set(shingle, (freq.get(shingle) ?? 0) + 1);
    }
  }
  return freq;
}

/**
 * Drops any shingle whose corpus-wide document frequency exceeds
 * `maxBridgeDocumentFrequency` -- see the module doc comment's "boilerplate
 * trigram filtering" section. A shingle that is unique to (or shared by only
 * a couple of) candidates always survives; nothing here can filter every
 * candidate down to an empty set unless EVERY one of its trigrams happens to
 * be corpus-common, which real validation never produced.
 */
function filterBoilerplateShingles(
  shingles: ReadonlySet<string>,
  documentFrequency: ReadonlyMap<string, number>,
  maxBridgeDocumentFrequency: number,
): Set<string> {
  const filtered = new Set<string>();
  for (const shingle of shingles) {
    if ((documentFrequency.get(shingle) ?? 0) <= maxBridgeDocumentFrequency) {
      filtered.add(shingle);
    }
  }
  return filtered;
}

/**
 * Groups `candidates` into near-duplicate clusters by connected components
 * over the "title similarity >= threshold, cross-source, and not solely via
 * boilerplate phrasing" relation (fix round 1 -- see the module doc comment
 * for the full reasoning behind both defenses below).
 *
 * PRECONDITION: `candidates` must have unique `itemKey`s -- this function
 * does not deduplicate its input. `src/cluster/store.ts`'s candidate query
 * guarantees this by construction (one row per distinct `item_key`, the
 * current version's title and source_id).
 *
 * `maxBridgeDocumentFrequency` defaults to `DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY`
 * when omitted, so every existing two-argument call site (including a
 * sibling task's `{ near_duplicate_threshold: ... }`-shaped config literal
 * predating this field) gets the fix automatically.
 *
 * Returns only groups of size >= 2 -- a candidate with no near-duplicate
 * anywhere in the input simply does not appear in the output at all, rather
 * than appearing as a group of one. This mirrors the schema directly:
 * `clusters`/`item_clusters` (db/migrations/0001_init.sql) exist to record
 * duplication, so a singleton earns no row (see src/cluster/store.ts).
 *
 * Deterministic: item_keys within each returned group, and the groups
 * themselves, are ordered by first appearance in `candidates` -- calling
 * this twice on the same input produces byte-identical output (asserted in
 * group.test.ts).
 */
export function groupNearDuplicates(
  candidates: ClusterCandidate[],
  threshold: number,
  maxBridgeDocumentFrequency: number = DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY,
): string[][] {
  const uf = new UnionFind();
  for (const candidate of candidates) uf.add(candidate.itemKey);

  // Precompute each candidate's RAW shingle set once, not once per pairwise
  // comparison -- see the module doc comment's cost note.
  const rawShingles = candidates.map((c) => titleTrigrams(c.title));

  // Fix round 1, defense 2: corpus-wide document frequency, computed fresh
  // from THIS candidate set every call (never hardcoded -- see module doc
  // comment), then used to derive a FILTERED shingle set per candidate.
  const documentFrequency = computeDocumentFrequency(rawShingles);
  const filteredShingles = rawShingles.map((shingles) =>
    filterBoilerplateShingles(shingles, documentFrequency, maxBridgeDocumentFrequency),
  );

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      // Fix round 1, defense 1: cross-source only. Checked BEFORE computing
      // similarity -- cheaper, and makes the two defenses' independence
      // explicit (a same-source pair is skipped regardless of how it would
      // have scored).
      if (candidates[i]!.sourceId === candidates[j]!.sourceId) continue;

      const score = jaccardSimilarity(filteredShingles[i]!, filteredShingles[j]!);
      if (score >= threshold) {
        uf.union(candidates[i]!.itemKey, candidates[j]!.itemKey);
      }
    }
  }

  // Group by root, preserving first-appearance order both within each group
  // and across groups (Map iteration order follows insertion order).
  const byRoot = new Map<string, string[]>();
  for (const candidate of candidates) {
    const root = uf.find(candidate.itemKey);
    const members = byRoot.get(root);
    if (members) {
      members.push(candidate.itemKey);
    } else {
      byRoot.set(root, [candidate.itemKey]);
    }
  }

  return [...byRoot.values()].filter((members) => members.length >= 2);
}

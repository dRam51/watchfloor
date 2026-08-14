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
 * size to carry.
 *
 * ## The known cost of transitivity: chaining
 *
 * Connected-components grouping can, in principle, chain a long way from its
 * starting point: if A~B and B~C both clear the threshold but A and C don't
 * directly resemble each other at all, A and C still end up in the same
 * group through B. This is a real, well-known property of this kind of
 * clustering, not something this module hides. It is NOT specially guarded
 * against here beyond the threshold itself, for a concrete reason: the
 * exhaustive real-corpus sweep behind config/cluster.yaml's threshold
 * (task-4-report.md) found only 11 pairs, out of ~16,110 possible pairs
 * across all 180 real usnews titles, with ANY shared trigram at all -- most
 * titles share nothing whatsoever with most other titles. A borderline
 * "bridge" item would need to independently clear 0.10 against two otherwise
 * unrelated stories, which the full sweep never once produced. If a future,
 * larger corpus does produce a chaining case, the fix is a stricter
 * threshold (config/cluster.yaml, no code change) or a switch to
 * complete-link grouping -- deliberately not built pre-emptively against a
 * failure mode with zero confirmed real occurrences.
 *
 * ## Cost
 *
 * O(n^2) pairwise comparisons over the candidate list, each a cheap Jaccard
 * over small (typically well under 20-element) shingle sets computed ONCE
 * per candidate up front, not re-normalized per comparison. Fine at M1's
 * real scale (a few thousand items; ~vitest measured well under a second for
 * the full 180-item real-corpus sweep in task-4-report.md's validation
 * script). Not batched or indexed further -- same "don't build it until
 * something needs it" stance as src/domain/itemBeats.ts's documented cost
 * note: the shape of a future fix, if the candidate set grows enough to
 * matter, is either time-windowing candidates before they reach this
 * function (src/cluster/store.ts's job, not this one's) or a cheaper
 * pre-filter (e.g. blocking on a shared rare token) before the O(n^2) pass.
 */

import { titleTrigrams, jaccardSimilarity } from './similarity.ts';

export interface ClusterCandidate {
  /** Stable identity across item versions -- see db/migrations/0001_init.sql. */
  itemKey: string;
  /** The candidate's current title, e.g. from getCurrentItem or an equivalent query. */
  title: string;
}

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
 * Groups `candidates` into near-duplicate clusters by connected components
 * over the "title similarity >= threshold" relation.
 *
 * PRECONDITION: `candidates` must have unique `itemKey`s -- this function
 * does not deduplicate its input. `src/cluster/store.ts`'s candidate query
 * guarantees this by construction (one row per distinct `item_key`, the
 * current version's title).
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
export function groupNearDuplicates(candidates: ClusterCandidate[], threshold: number): string[][] {
  const uf = new UnionFind();
  for (const candidate of candidates) uf.add(candidate.itemKey);

  // Precompute each candidate's shingle set once, not once per pairwise
  // comparison -- see the module doc comment's cost note.
  const shingles = candidates.map((c) => titleTrigrams(c.title));

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const score = jaccardSimilarity(shingles[i]!, shingles[j]!);
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

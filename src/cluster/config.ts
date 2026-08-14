/**
 * Config loader for the near-duplicate clustering threshold (M2 Task 4).
 *
 * Mirrors src/score/decay.ts's parse/load split (a pure `parse*` over
 * already-read text, plus a thin `load*` that does the one bit of file I/O)
 * -- one convention for "how does a small standalone YAML config get loaded"
 * across the M2 config tree, alongside config/decay.yaml and
 * config/interests.yaml.
 *
 * WHY THIS IS (MOSTLY) THE ONLY THING IN CONFIG, AND NOTHING ELSE IS: the
 * task is explicit that the near-duplicate threshold must be "configurable
 * from config (not a constant)" -- it is a genuine dial the owner would want
 * to retune after watching real clustering behavior, exactly like
 * config/decay.yaml's half-lives. Normalization decisions (which characters
 * are boundaries, the stopword list, the shingle size) are NOT here -- see
 * src/cluster/similarity.ts's module doc comment for why those are
 * algorithmic implementation details, not tunable knobs, and belong in code
 * next to the logic they govern.
 *
 * FIX ROUND 1 (M2 task 4 fix-round-1) added `max_bridge_document_frequency`,
 * a second, genuinely-retunable dial: the cap src/cluster/group.ts's
 * groupNearDuplicates uses to stop formulaic/templated source vocabulary
 * (real: cisa-kev, huggingface-blog) from transitively chaining unrelated
 * items into one cluster. See that module's doc comment and
 * task-4-report.md for the full real-corpus derivation.
 *
 * DELIBERATELY `.optional()`, not required: a sibling milestone task's test
 * (tests/score/pass.test.ts, off limits to this module's owner) constructs a
 * bare `{ near_duplicate_threshold: 0.1 }` object literal typed as
 * `ClusterConfig`, bypassing this parser entirely -- making the new field
 * required here would break that already-committed test's typecheck.
 * `src/cluster/group.ts`'s own default parameter
 * (`DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY`) is what actually supplies a
 * value at runtime when this key is omitted; this schema's job is only to
 * validate a value IF one is present. The real, shipped config/cluster.yaml
 * sets it explicitly regardless (see that file) -- optionality here is an
 * integration-compatibility accommodation, not license to leave the real
 * config file implicit.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export class ClusterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterConfigError';
  }
}

// A Jaccard score is always in [0, 1] (src/cluster/similarity.ts's
// jaccardSimilarity), so a threshold outside that range could never match
// anything (> 1) or would match everything including totally disjoint titles
// (< 0) -- both are almost certainly a typo, not an intentional setting.
// Failing at config load, the same way src/sources/load.ts's weight bound and
// src/interests/load.ts's weight bound fail loudly on an out-of-range value
// rather than silently loading a threshold that can never do anything.
const ClusterConfigSchema = z
  .object({
    near_duplicate_threshold: z
      .number()
      .min(0, 'near_duplicate_threshold must be at least 0 (a Jaccard score is never negative)')
      .max(1, 'near_duplicate_threshold must be at most 1 (a Jaccard score never exceeds 1)'),
    // Optional -- see the module doc comment's "fix round 1" section for why.
    // .min(2): a trigram shared by fewer than 2 candidates cannot exist (a
    // shingle unique to one candidate is never a "bridge" in the first
    // place), so a cap below 2 would filter every shared trigram without
    // exception, making every cluster of size >= 2 permanently unreachable
    // -- the same class of "silently inert" hazard src/score/mechanical.ts's
    // cluster.saturation_size > 1 check guards against.
    max_bridge_document_frequency: z
      .number()
      .int('max_bridge_document_frequency must be an integer -- it counts candidates, not a fraction of one')
      .min(
        2,
        'max_bridge_document_frequency must be at least 2 -- a shared trigram has document frequency >= 2 by definition, so a lower cap would prevent every cluster from ever forming',
      )
      .optional(),
  })
  .strict();

export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;

/** Parses and validates cluster-config YAML text. No filesystem access. */
export function parseClusterConfig(yamlText: string): ClusterConfig {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (cause) {
    throw new ClusterConfigError(`could not parse YAML: ${(cause as Error).message}`);
  }

  const result = ClusterConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ClusterConfigError(`invalid cluster config:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Reads and validates the cluster config at `path`. The only I/O in this module. */
export function loadClusterConfig(path: string): ClusterConfig {
  return parseClusterConfig(readFileSync(path, 'utf8'));
}

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseClusterConfig, loadClusterConfig, ClusterConfigError } from '../../src/cluster/config.ts';

function validYaml(threshold = 0.1): string {
  return `near_duplicate_threshold: ${threshold}\n`;
}

describe('parseClusterConfig', () => {
  it('parses a valid config and returns the threshold', () => {
    expect(parseClusterConfig(validYaml(0.1))).toEqual({ near_duplicate_threshold: 0.1 });
  });

  it('accepts a threshold of exactly 0 (never cluster anything)', () => {
    expect(parseClusterConfig(validYaml(0)).near_duplicate_threshold).toBe(0);
  });

  it('accepts a threshold of exactly 1 (only identical shingle sets cluster)', () => {
    expect(parseClusterConfig(validYaml(1)).near_duplicate_threshold).toBe(1);
  });

  it('rejects a threshold above 1 -- a Jaccard score can never exceed 1', () => {
    expect(() => parseClusterConfig(validYaml(1.5))).toThrow(ClusterConfigError);
  });

  it('rejects a negative threshold -- a Jaccard score can never be negative', () => {
    expect(() => parseClusterConfig(validYaml(-0.1))).toThrow(ClusterConfigError);
  });

  it('rejects a missing near_duplicate_threshold key', () => {
    expect(() => parseClusterConfig('other_key: 1\n')).toThrow(ClusterConfigError);
  });

  it('rejects an unknown top-level key (strict schema, same convention as decay.yaml/interests.yaml)', () => {
    expect(() => parseClusterConfig(`${validYaml()}unexpected_key: true\n`)).toThrow(ClusterConfigError);
  });

  it('rejects a non-numeric threshold', () => {
    expect(() => parseClusterConfig('near_duplicate_threshold: "loose"\n')).toThrow(ClusterConfigError);
  });

  it('rejects malformed YAML with a ClusterConfigError, not a raw parser exception', () => {
    expect(() => parseClusterConfig('near_duplicate_threshold: [\n')).toThrow(ClusterConfigError);
  });

  it('the error message names the problem, not just "invalid"', () => {
    try {
      parseClusterConfig(validYaml(1.5));
      throw new Error('expected parseClusterConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClusterConfigError);
      expect((err as Error).message).toMatch(/near_duplicate_threshold/);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX ROUND 1 (M2 task 4 fix-round-1): max_bridge_document_frequency, the
// boilerplate-trigram cap src/cluster/group.ts's groupNearDuplicates uses to
// stop formulaic/templated corpora (real: cisa-kev, huggingface-blog) from
// transitively chaining into one enormous, meaningless cluster. See
// task-4-report.md's fix-round-1 section for the full real-corpus
// derivation of the chosen value.
//
// DELIBERATELY .optional(), not required and not `.default()`-only in the
// schema: a sibling milestone task's test
// (tests/score/pass.test.ts, off limits to this module's owner) constructs
// `{ near_duplicate_threshold: 0.1 }` as a bare TypeScript object literal
// typed as ClusterConfig, bypassing this parser entirely -- it must keep
// typechecking with the field OMITTED. src/cluster/group.ts's own default
// parameter (DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY) is what actually
// supplies a value at runtime when this key is absent; this schema's job is
// only to validate a value IF one is present, never to force one that
// wasn't given.
// ---------------------------------------------------------------------------
describe('parseClusterConfig -- max_bridge_document_frequency (fix round 1, optional)', () => {
  it('is valid when omitted entirely -- matches the pre-fix-round-1 config shape', () => {
    const config = parseClusterConfig(validYaml(0.1));
    expect(config.max_bridge_document_frequency).toBeUndefined();
  });

  it('accepts a valid explicit integer value', () => {
    const config = parseClusterConfig(`near_duplicate_threshold: 0.1\nmax_bridge_document_frequency: 5\n`);
    expect(config.max_bridge_document_frequency).toBe(5);
  });

  it('rejects a non-integer value', () => {
    expect(() =>
      parseClusterConfig(`near_duplicate_threshold: 0.1\nmax_bridge_document_frequency: 5.5\n`),
    ).toThrow(ClusterConfigError);
  });

  it('rejects a value below 2 -- a shared trigram, by definition, has document frequency >= 2, so a lower cap would prevent every cluster from ever forming', () => {
    expect(() =>
      parseClusterConfig(`near_duplicate_threshold: 0.1\nmax_bridge_document_frequency: 1\n`),
    ).toThrow(ClusterConfigError);
  });

  it('accepts exactly 2, the documented minimum', () => {
    const config = parseClusterConfig(`near_duplicate_threshold: 0.1\nmax_bridge_document_frequency: 2\n`);
    expect(config.max_bridge_document_frequency).toBe(2);
  });
});

describe('loadClusterConfig', () => {
  it('reads and parses a file from disk', () => {
    // Independent of the real checked-in config/cluster.yaml (which gets its
    // own dedicated test below) -- a throwaway temp-free check that the file
    // I/O itself is wired correctly, using this test file's own directory as
    // a source of a real path (process.cwd()-relative, per the portability
    // rule -- no absolute paths).
    const config = loadClusterConfig('tests/fixtures/cluster/valid.yaml');
    expect(config.near_duplicate_threshold).toBe(0.1);
  });

  it('propagates a ClusterConfigError for a missing file', () => {
    expect(() => loadClusterConfig('tests/fixtures/cluster/does-not-exist.yaml')).toThrow();
  });
});

describe('the real checked-in config/cluster.yaml', () => {
  it('parses cleanly and its threshold matches the value task-4-report.md justifies', () => {
    const text = readFileSync('config/cluster.yaml', 'utf8');
    const config = parseClusterConfig(text);
    // 0.10 sits strictly between the highest confirmed spurious score found
    // in the full real-corpus sweep (1/13 ≈ 0.0769, "AP source says"
    // boilerplate on two unrelated transactions -- see similarity.test.ts
    // and task-4-report.md) and the lowest score among the pairs this
    // threshold guarantees catching (2/17 ≈ 0.1176). See task-4-report.md
    // for the full argument, including why Kennedy Center (1/17 ≈ 0.0588)
    // is a deliberate miss, not an oversight.
    expect(config.near_duplicate_threshold).toBe(0.1);
  });

  it('sets max_bridge_document_frequency explicitly (fix round 1) rather than relying silently on the code default', () => {
    // The shipped file states its own value rather than omitting the key and
    // relying on src/cluster/group.ts's DEFAULT_MAX_BRIDGE_DOCUMENT_FREQUENCY
    // -- matching this codebase's convention of every config file being
    // fully explicit (config/decay.yaml, config/interests.yaml never rely on
    // an implicit code default either). See task-4-report.md's fix-round-1
    // section for the real-corpus derivation of 5.
    const text = readFileSync('config/cluster.yaml', 'utf8');
    const config = parseClusterConfig(text);
    expect(config.max_bridge_document_frequency).toBe(5);
  });
});

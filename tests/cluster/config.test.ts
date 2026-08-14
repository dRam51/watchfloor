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
});

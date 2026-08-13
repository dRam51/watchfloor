import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSources, loadSourcesFile, SourceConfigError } from '../../src/sources/load.ts';

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'sources', name), 'utf8');
}

describe('loadSources', () => {
  it('parses a valid file', () => {
    const sources = loadSources(fixture('valid.yaml'));
    expect(sources).toHaveLength(2);
    expect(sources[0]?.id).toBe('cisa-kev');
    expect(sources[1]?.beats).toEqual(['markets', 'ai']);
    expect(sources[1]?.tier).toBe('analysis');
  });

  it('rejects a weight outside 0.1–2.0', () => {
    expect(() => loadSources(fixture('bad-weight.yaml'))).toThrow(SourceConfigError);
  });

  it('rejects duplicate ids', () => {
    const dupe = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: 1h, enabled: true }
  - { id: a, name: B, type: rss, url: 'https://b.test/f', beats: [ai], weight: 1, poll_interval: 1h, enabled: true }
`;
    expect(() => loadSources(dupe)).toThrow(/duplicate source id: a/);
  });

  it('rejects an unknown beat', () => {
    const bad = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [sports], weight: 1, poll_interval: 1h, enabled: true }
`;
    expect(() => loadSources(bad)).toThrow(SourceConfigError);
  });

  it('rejects a malformed poll_interval', () => {
    const bad = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: soon, enabled: true }
`;
    expect(() => loadSources(bad)).toThrow(SourceConfigError);
  });

  it('loads the real config/sources.yaml', () => {
    const sources = loadSourcesFile(join(process.cwd(), 'config', 'sources.yaml'));
    expect(sources.length).toBeGreaterThan(0);
  });
});

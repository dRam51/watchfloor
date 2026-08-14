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

  // M1 task 10, constraint 3: a zero poll_interval is a live landmine --
  // src/db/fetchState.ts's recordFailure would compute a zero backoff delay,
  // making a FAILING source eligible again on every scheduler tick. Gate 1
  // of two independent gates against the same hazard (gate 2 is
  // src/scheduler/run.ts's own runtime guard on the parsed millisecond
  // value, tested in tests/scheduler/run.test.ts).
  it.each(['0m', '0h', '0d'])('rejects a zero poll_interval (%s)', (pollInterval) => {
    const bad = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: ${pollInterval}, enabled: true }
`;
    expect(() => loadSources(bad)).toThrow(SourceConfigError);
  });

  it('still accepts every previously-valid poll_interval shape after the zero-rejecting tightening', () => {
    for (const pollInterval of ['1m', '15m', '6h', '1d', '99999d']) {
      const yaml = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: ${pollInterval}, enabled: true }
`;
      expect(() => loadSources(yaml), pollInterval).not.toThrow();
    }
  });

  it('loads the real config/sources.yaml', () => {
    const sources = loadSourcesFile(join(process.cwd(), 'config', 'sources.yaml'));
    expect(sources.length).toBeGreaterThan(0);
  });

  it('accepts news_sitemap and google_news as valid source types (Tasks 8 and 9 have no other way to declare a conforming source)', () => {
    const yaml = `
sources:
  - { id: ap-news, name: AP News, type: news_sitemap, url: 'https://apnews.com/news-sitemap-content.xml', beats: [usnews], weight: 1, poll_interval: 1h, enabled: true }
  - { id: reuters-gnews, name: Reuters via Google News, type: google_news, url: 'https://news.google.com/rss/search?q=site:reuters.com', beats: [usnews], weight: 1, poll_interval: 1h, enabled: true }
`;
    const sources = loadSources(yaml);
    expect(sources.map((s) => s.type)).toEqual(['news_sitemap', 'google_news']);
  });
});

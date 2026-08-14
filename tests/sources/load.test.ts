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

  // M1 task 11: the real config grew from one placeholder entry to the full verified
  // set. `loadSourcesFile` already rejects the whole file if a SINGLE entry is
  // malformed (FileSchema is `z.array(SourceSchema)`, parsed atomically), so the two
  // tests above already prove "every entry validates" in the sense that a bad entry
  // would throw rather than silently load. What that doesn't catch is a source being
  // silently DROPPED or DUPLICATED (the file would still parse and "load fine" with
  // fewer/more rows), or a `type` that parses but has no adapter to route to at
  // runtime. Both are asserted explicitly here.
  describe('the real config/sources.yaml (M1 task 11)', () => {
    const sources = loadSourcesFile(join(process.cwd(), 'config', 'sources.yaml'));

    // Intentionally an exact count, not `toBeGreaterThan`: a future edit that adds or
    // removes a source should update this number deliberately, not slide past it
    // unnoticed. See task-11-report.md for the full list and reasoning; two of the
    // plan's 22 verified sources (scotus-slip, nws-fl-alerts) are documented in
    // docs/sources-wishlist.md instead of here -- both are blocked by the target
    // site's own robots.txt (verified against src/fetch/robots.ts's real isAllowed
    // logic, not assumed), the same category as the pre-existing Reuters-direct entry.
    it('has exactly 20 configured sources', () => {
      expect(sources.length).toBe(20);
    });

    it('has no duplicate ids', () => {
      // Belt-and-suspenders: loadSources() already throws on a duplicate id (a
      // malformed file would never reach this point at all), but the config is now
      // large enough that pinning the invariant explicitly, in terms a config editor
      // would recognize, is worth the two extra lines.
      const ids = sources.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('only uses source types that have a registered M1 adapter', () => {
      // src/adapters/*.ts implement exactly these four; type is a wider enum
      // (src/sources/load.ts) that also reserves 'atom', 'github_search', 'api', and
      // 'market_data' for adapters M1 does not ship (M4a/M4b), or -- 'atom' -- for a
      // type string no M1 source is configured to use (rss.ts content-sniffs Atom vs
      // RSS 2.0 from the parsed body and is registered under 'rss', not 'atom'; see
      // that file's own doc comment). A source configured with any of the other four
      // would load fine here and then have no adapter to route to at poll time.
      const adapterBackedTypes = new Set(['rss', 'json', 'news_sitemap', 'google_news']);
      const usedTypes = new Set(sources.map((s) => s.type));
      for (const type of usedTypes) {
        expect(adapterBackedTypes.has(type), `type "${type}" has no M1 adapter`).toBe(true);
      }
    });

    it('covers every non-market, non-repos beat with at least one enabled source', () => {
      // repos (M4a, GitHub adapter) and markets (M4b) are deliberately zero in M1 --
      // see the plan's "Not in M1" list. The other four must each have real, currently
      // -polling coverage; a beat with only disabled sources would silently show
      // nothing on the dashboard while still "loading" successfully.
      const enabledBeats = new Set(sources.filter((s) => s.enabled).flatMap((s) => s.beats));
      for (const beat of ['ai', 'cyber', 'aisec', 'usnews'] as const) {
        expect(enabledBeats.has(beat), `no enabled source covers beat "${beat}"`).toBe(true);
      }
    });
  });
});

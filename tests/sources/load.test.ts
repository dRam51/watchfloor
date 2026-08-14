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

  // fix-enrichment-field task: `enrichment` was already legal, documented YAML
  // (config/sources.yaml's `ap-news` entry set `enrichment: false`) before this schema
  // knew about it. A plain `z.object()` (no `.strict()`) strips unrecognized keys
  // instead of rejecting them, so the field loaded "successfully" while being silently
  // dropped -- the AP-excluded-from-enrichment decision it encoded had zero effect. See
  // task-11-report.md's "The `enrichment` field" section for the original discovery.
  describe('enrichment field', () => {
    it('parses enrichment: false and keeps the value', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: 1h, enabled: true, enrichment: false }
`;
      const sources = loadSources(yaml);
      expect(sources[0]?.enrichment).toBe(false);
    });

    it('defaults enrichment to true when omitted', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: 1h, enabled: true }
`;
      const sources = loadSources(yaml);
      expect(sources[0]?.enrichment).toBe(true);
    });

    it('rejects a non-boolean enrichment value', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: 1h, enabled: true, enrichment: maybe }
`;
      expect(() => loadSources(yaml)).toThrow(SourceConfigError);
    });
  });

  // fix-ap-language-filter task: `filters` was already legal, free-form YAML (the header
  // comment called it "NOT YET CONSUMED by any M1 adapter"). This task makes news_sitemap
  // the first real consumer, via `filters.languages` -- an allow-list of ISO 639-2/B
  // three-letter codes an entry's declared <news:language> must appear in to survive.
  // Malformed here must fail at load, exactly like every other source-config error (weight,
  // poll_interval, beats, enrichment) -- never discovered later at fetch time.
  describe('filters.languages', () => {
    it('accepts a languages allow-list of valid ISO 639-2/B codes', () => {
      const yaml = `
sources:
  - { id: ap-news, name: AP News, type: news_sitemap, url: 'https://apnews.test/sitemap.xml', beats: [usnews], weight: 1, poll_interval: 30m, enabled: true, filters: { languages: [eng] } }
`;
      const sources = loadSources(yaml);
      expect(sources[0]?.filters).toEqual({ languages: ['eng'] });
    });

    it('accepts more than one language code in the allow-list', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: news_sitemap, url: 'https://a.test/f', beats: [usnews], weight: 1, poll_interval: 30m, enabled: true, filters: { languages: [eng, spa] } }
`;
      const sources = loadSources(yaml);
      expect(sources[0]?.filters).toEqual({ languages: ['eng', 'spa'] });
    });

    it('still accepts a filters map with no languages key at all (e.g. arxiv-cs-cr\'s keywords-only filter)', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [aisec], weight: 1, poll_interval: 1d, enabled: true, filters: { keywords: [jailbreak, agent] } }
`;
      const sources = loadSources(yaml);
      expect(sources[0]?.filters).toEqual({ keywords: ['jailbreak', 'agent'] });
    });

    it('rejects a two-letter language code -- the sitemap declares ISO 639-2/B (three-letter), not ISO 639-1', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: news_sitemap, url: 'https://a.test/f', beats: [usnews], weight: 1, poll_interval: 30m, enabled: true, filters: { languages: [en] } }
`;
      expect(() => loadSources(yaml)).toThrow(SourceConfigError);
    });

    it('rejects an uppercase language code -- the sitemap always emits lowercase', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: news_sitemap, url: 'https://a.test/f', beats: [usnews], weight: 1, poll_interval: 30m, enabled: true, filters: { languages: [ENG] } }
`;
      expect(() => loadSources(yaml)).toThrow(SourceConfigError);
    });

    it('rejects an empty languages array -- an allow-list of nothing silently drops every entry, which is what `enabled: false` is for', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: news_sitemap, url: 'https://a.test/f', beats: [usnews], weight: 1, poll_interval: 30m, enabled: true, filters: { languages: [] } }
`;
      expect(() => loadSources(yaml)).toThrow(SourceConfigError);
    });

    it('rejects a non-array languages value', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: news_sitemap, url: 'https://a.test/f', beats: [usnews], weight: 1, poll_interval: 30m, enabled: true, filters: { languages: eng } }
`;
      expect(() => loadSources(yaml)).toThrow(SourceConfigError);
    });
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
    // unnoticed. See task-11-report.md for the full list and reasoning.
    //
    // THREE of the plan's 22 verified sources are in docs/sources-wishlist.md instead
    // of here, all blocked by the target site's own robots.txt (verified against
    // src/fetch/robots.ts's real isAllowed logic, not assumed):
    //   - scotus-slip    supremecourt.gov disallows /rss/
    //   - nws-fl-alerts  api.weather.gov disallows / (the whole host)
    //   - reuters-gnews  removed 2026-08-14 after the first live run: news.google.com
    //                    also opens `User-agent: * / Disallow: /`, so BOTH the direct
    //                    route and the indirect one are shut. This test caught that
    //                    removal, which is exactly what the exact count is for.
    it('has exactly 19 configured sources', () => {
      expect(sources.length).toBe(19);
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

    // Pinned regression for the fix-enrichment-field task: this is the exact case that
    // motivated adding `enrichment` to the schema at all (task-11-report.md's "The
    // `enrichment` field" section). Before the schema declared this key, `ap-news`'s
    // `enrichment: false` loaded "successfully" while zod silently stripped it -- this
    // fails loudly if a future config edit ever drops the field from ap-news, instead of
    // the loss going unnoticed the same way it did the first time.
    it('has enrichment: false on ap-news', () => {
      const apNews = sources.find((s) => s.id === 'ap-news');
      expect(apNews).toBeDefined();
      expect(apNews?.enrichment).toBe(false);
    });

    // Pinned regression for the fix-ap-language-filter task, same shape as the enrichment
    // pin above: this is the exact field that makes AP's Spanish wire copy never reach
    // storage. A `z.record(z.unknown())` filters schema would have silently accepted this
    // key without validating it at all -- this fails loudly if a future config edit ever
    // drops or malforms it, instead of AP quietly going back to ingesting Spanish articles.
    it('has filters.languages: [eng] on ap-news', () => {
      const apNews = sources.find((s) => s.id === 'ap-news');
      expect(apNews).toBeDefined();
      expect(apNews?.filters).toEqual({ languages: ['eng'] });
    });
  });
});

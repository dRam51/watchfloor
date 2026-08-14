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

  // fix-news-sources-and-kind task: `beat` is a TOPIC axis (aisec, ai, ...); `kind` is a
  // CONTENT axis (news vs. paper vs. blog vs. advisory vs. aggregator) -- orthogonal to
  // beat, and the thing that actually lets the owner ask for "aisec, but only news".
  // `item_type` was tried for this and found effectively binary (M2: `press` matches 0 of
  // 3,325 real items), so `kind` is a NEW, source-level field, not a repurposing of an
  // existing one. Source-level (not item-level) deliberately -- see config/sources.yaml's
  // header for why a per-item classifier is the mistake `item_type` already made.
  //
  // Optional, not required (unlike `beats`/`weight`/`type`) -- mirrors `tier`'s existing
  // precedent exactly (also `z.enum(...).optional()`, also not every source needs one).
  // Making `kind` REQUIRED would force every hand-built `Source` fixture across the test
  // suite (tests/scheduler, tests/adapters, tests/score, tests/api/sources, tests/api/
  // dashboard -- none of which this task owns) to grow a new mandatory field just to keep
  // compiling, for a schema addition those tests have no stake in. `enrichment` accepted
  // that cost deliberately, for a decision that affects every source's behavior; `kind` is
  // narrower in scope (a read-side filter), so it follows `tier`'s lighter-weight pattern
  // instead. Every REAL source in config/sources.yaml is still classified explicitly below
  // (see "every configured source has a kind classification") -- the field being optional
  // in the schema doesn't mean the classification work was skipped, only that it isn't
  // mechanically forced on every incidental test fixture elsewhere in the repo.
  describe('kind field', () => {
    it('accepts each documented kind value', () => {
      for (const kind of ['news', 'paper', 'blog', 'advisory', 'aggregator']) {
        const yaml = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: 1h, enabled: true, kind: ${kind} }
`;
        const sources = loadSources(yaml);
        expect(sources[0]?.kind, kind).toBe(kind);
      }
    });

    it('leaves kind undefined when omitted -- optional, matching tier', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: 1h, enabled: true }
`;
      const sources = loadSources(yaml);
      expect(sources[0]?.kind).toBeUndefined();
    });

    it('rejects a kind value outside the documented set', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: 1h, enabled: true, kind: press-release }
`;
      expect(() => loadSources(yaml)).toThrow(SourceConfigError);
    });

    it('rejects a kind that only differs by case -- the set is lowercase, not case-insensitive', () => {
      const yaml = `
sources:
  - { id: a, name: A, type: rss, url: 'https://a.test/f', beats: [ai], weight: 1, poll_interval: 1h, enabled: true, kind: News }
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
    //
    // fix-news-sources-and-kind task (2026-08-14): 19 -> 27. Eight sources named as
    // "verified during M1 planning" but never configured -- Ars Technica, VentureBeat,
    // Import AI, OpenAI blog (ai); The Hacker News, Dark Reading, Rapid7, Cisco Talos
    // (cyber/aisec) -- each independently re-verified live against the real robots gate
    // and for fresh, parseable content, not trusted on the old claim. See
    // fix-news-sources-and-kind-report.md (.superpowers/sdd/2026-08-14-m3-api-dashboard/,
    // gitignored, local-only) for the full evidence.
    it('has exactly 27 configured sources', () => {
      expect(sources.length).toBe(27);
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

    // fix-news-sources-and-kind task: `kind` is optional in the SCHEMA (see "kind field"
    // above), but every REAL source in this file was deliberately classified -- this
    // invariant is what keeps that true rather than aspirational. A future config edit
    // that adds a source without a `kind` fails this, loudly, at the same review point as
    // every other config-quality check here, rather than silently shipping an
    // unclassified row that /api/feed?kind=... can never match.
    it('every configured source has a kind classification', () => {
      for (const s of sources) {
        expect(s.kind, `${s.id} has no kind`).toBeDefined();
      }
    });

    // The headline outcome of the fix-news-sources-and-kind task: aisec had ZERO
    // kind:news sources before this (67 items -- 47 arXiv papers, 20 research-blog posts,
    // newest 93 days old -- structurally a papers beat, not a news beat). Pinned so a
    // future edit cannot silently regress the fix back to that state.
    it('aisec has at least one enabled kind:news source', () => {
      const aisecNews = sources.filter((s) => s.enabled && s.beats.includes('aisec') && s.kind === 'news');
      expect(aisecNews.map((s) => s.id)).toEqual(expect.arrayContaining(['the-hacker-news', 'dark-reading']));
    });

    // Pinned regression: the venturebeat.com/category/ai/feed trap (live-verified stale --
    // see config/sources.yaml's own comment on the venturebeat entry) is exactly the kind
    // of "looks like the better URL" mistake a future edit could reintroduce. Pinning the
    // actually-configured url guards against that.
    it('venturebeat is configured against the site-wide feed, not the stale category feed', () => {
      const vb = sources.find((s) => s.id === 'venturebeat');
      expect(vb?.url).toBe('https://venturebeat.com/feed/');
    });

    // Pinned regression: ars-technica-ai and dark-reading both declared `enrichment: false`
    // for the same AP-precedent reason (robots.txt names AI crawlers by name in a separate
    // group, even though our own "watchfloor" token doesn't match it) -- fails loudly if a
    // future edit drops that decision rather than the loss going unnoticed.
    it.each(['ars-technica-ai', 'dark-reading'])('has enrichment: false on %s (robots.txt names AI crawlers by name)', (id) => {
      const source = sources.find((s) => s.id === id);
      expect(source).toBeDefined();
      expect(source?.enrichment).toBe(false);
    });
  });
});

/**
 * The bot's view of `config/sources.yaml` (M5 task 11).
 *
 * Two things live here and both are rulings rather than mechanics:
 *
 * 1. **RULING 1** — the bot's default content filter is `kind in (news,
 *    advisory)`, NOT §8.2's literal `item_type in (event)`. Pinned by a test
 *    that names both, so a future reader "fixing" it back goes red with the
 *    reason in front of them.
 * 2. **Markets is not configured, and stays not configured even once a markets
 *    SOURCE exists** — the same distinction `src/vault/daily.ts` draws for the
 *    market ribbon. A source is not a data store.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSourcesFile, type Kind, type Source } from '../../../src/sources/load.ts';
import {
  DEFAULT_BOT_KINDS,
  indexSources,
  marketsAvailability,
  repoConfigPath,
} from '../../../src/mcp/tools/sources.ts';

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'a-source',
    name: 'A Source',
    type: 'rss',
    url: 'https://example.com/feed.xml',
    beats: ['ai'],
    weight: 1,
    poll_interval: '1h',
    enabled: true,
    enrichment: true,
    ...overrides,
  } as Source;
}

describe('DEFAULT_BOT_KINDS — RULING 1', () => {
  it('is exactly news + advisory, the owner-approved departure from §8.2\'s literal item_type filter', () => {
    expect([...DEFAULT_BOT_KINDS].sort()).toEqual(['advisory', 'news']);
  });

  it('excludes papers, blogs and aggregators — what "hard news and security advisories" means', () => {
    for (const kind of ['paper', 'blog', 'aggregator'] as Kind[]) {
      expect(DEFAULT_BOT_KINDS.has(kind)).toBe(false);
    }
  });
});

describe('indexSources', () => {
  it('keys by source id and carries the fields a bot needs to judge a row', () => {
    const index = indexSources([makeSource({ id: 'krebs', name: 'Krebs', kind: 'news', beats: ['cyber'], weight: 1.4 })]);
    expect(index.get('krebs')).toEqual({
      id: 'krebs',
      name: 'Krebs',
      beats: ['cyber'],
      kind: 'news',
      weight: 1.4,
      pollInterval: '1h',
      enabled: true,
    });
  });

  it('reports an unclassified source as kind null rather than guessing one', () => {
    const index = indexSources([makeSource({ id: 'mystery' })]);
    expect(index.get('mystery')?.kind).toBeNull();
  });

  it('returns undefined for a source id that is not configured at all', () => {
    expect(indexSources([makeSource()]).get('never-heard-of-it')).toBeUndefined();
  });
});

describe('marketsAvailability', () => {
  it('is not configured, and says the reason is that no markets source exists', () => {
    const availability = marketsAvailability([makeSource({ beats: ['ai'] })]);
    expect(availability.configured).toBe(false);
    expect(availability.reason).toBe('no_markets_source');
    expect(availability.marketsSources).toEqual([]);
  });

  it('is STILL not configured once a markets source exists — a source is not a data store', () => {
    const availability = marketsAvailability([
      makeSource({ id: 'some-quotes', beats: ['markets'], type: 'market_data' }),
    ]);
    expect(availability.configured).toBe(false);
    expect(availability.reason).toBe('no_markets_store');
    expect(availability.marketsSources).toEqual(['some-quotes']);
  });

  it('ignores a DISABLED markets source when deciding which reason applies', () => {
    const availability = marketsAvailability([
      makeSource({ id: 'some-quotes', beats: ['markets'], enabled: false }),
    ]);
    expect(availability.reason).toBe('no_markets_source');
    expect(availability.marketsSources).toEqual([]);
  });

  // The negative that matters: `configured` has no true branch anywhere in
  // this module. M4b is what makes it true, and M4b is deferred.
  it('has no input that makes it configured', () => {
    for (const beats of [['markets'], ['markets', 'ai'], ['ai']] as Source['beats'][]) {
      expect(marketsAvailability([makeSource({ beats })]).configured).toBe(false);
    }
  });
});

describe('against the real config/sources.yaml', () => {
  const sources = loadSourcesFile(repoConfigPath('sources.yaml'));

  it('is reading the real file — the non-vacuity check', () => {
    expect(sources.length).toBeGreaterThanOrEqual(20);
  });

  it('still has zero markets sources, which is why three §8.2 tools have no data', () => {
    expect(marketsAvailability(sources)).toMatchObject({ configured: false, reason: 'no_markets_source' });
  });

  it('classifies every real source, so the bot default is never applied to an unknown kind', () => {
    const unclassified = [...indexSources(sources).values()].filter((s) => s.kind === null);
    expect(unclassified).toEqual([]);
  });

  it('leaves real sources on both sides of the RULING 1 default', () => {
    const kinds = [...indexSources(sources).values()].filter((s) => s.enabled);
    expect(kinds.some((s) => DEFAULT_BOT_KINDS.has(s.kind!))).toBe(true);
    expect(kinds.some((s) => !DEFAULT_BOT_KINDS.has(s.kind!))).toBe(true);
  });
});

describe('repoConfigPath', () => {
  it('resolves against this module, not the process cwd — an MCP client spawns from anywhere', () => {
    expect(repoConfigPath('sources.yaml')).toBe(join(import.meta.dirname, '..', '..', '..', 'config', 'sources.yaml'));
  });
});

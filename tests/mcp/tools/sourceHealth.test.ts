/**
 * `get_source_health` (M5 task 11) — §8.2's *"so the bot can tell 'no news'
 * from 'the feed broke'."*
 *
 * Three things are being proven here, and only the first is ordinary:
 *
 * 1. Every configured source appears, including one that has never been
 *    polled — `everPolled: false`, never a silent omission.
 * 2. **The judgement does not drift from the dashboard's.** This module cannot
 *    import `src/api/routes/sources.ts` (`src/mcp/sourceRules.ts` forbids the
 *    api package in the bot's module graph), so `stale`/`failing` are computed
 *    twice in this repository. A test is the only thing that can keep the two
 *    honest, so this file feeds identical inputs to both and asserts they
 *    agree — including on §7's "silent failure" case, a source with zero
 *    recorded failures that simply stopped being polled.
 * 3. **`as_of` is REFUSED, not answered.** `source_fetch_state` is mutable
 *    operational state updated in place on every poll; it keeps no history.
 *    Answering a point-in-time question from it would hand a backtest today's
 *    health for last month's window — lookahead, in the one tool a bot uses to
 *    decide whether to trust a gap in the news.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openReadOnlyCorpus, type ReadOnlyCorpus } from '../../../src/mcp/readonly.ts';
import { computeSourceHealth } from '../../../src/api/routes/sources.ts';
import { parsePollIntervalMs } from '../../../src/scheduler/run.ts';
import { loadSourcesFile, type Source } from '../../../src/sources/load.ts';
import {
  createSourceHealthTool,
  computeBotSourceHealth,
  parseBotPollIntervalMs,
  type BotFetchState,
} from '../../../src/mcp/tools/sourceHealth.ts';
import { indexSources, repoConfigPath } from '../../../src/mcp/tools/sources.ts';
import { callBotTool, seedRealCorpus } from './fixture.ts';

const open: ReadOnlyCorpus[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

const NOW = '2026-08-16T00:00:00.000Z';

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
    kind: 'news',
    ...overrides,
  } as Source;
}

/** The five states §7 distinguishes, as raw fetch-state rows. */
const STATES: Record<string, BotFetchState | null> = {
  healthy: {
    lastSuccessAt: '2026-08-15T23:30:00.000Z',
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    itemsYieldedSinceWindowStart: 42,
    windowStartedAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-15T23:30:00.000Z',
  },
  // Zero recorded failures and simply not polled since -- §7's "silent failure".
  silentlyStale: {
    lastSuccessAt: '2026-08-01T00:00:00.000Z',
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    itemsYieldedSinceWindowStart: 0,
    windowStartedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  erroring: {
    lastSuccessAt: '2026-08-15T23:30:00.000Z',
    lastFailureAt: '2026-08-15T23:59:00.000Z',
    lastError: 'HTTP 503',
    consecutiveFailures: 3,
    nextEligibleAt: '2026-08-16T02:00:00.000Z',
    itemsYieldedSinceWindowStart: 7,
    windowStartedAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-15T23:59:00.000Z',
  },
  neverPolled: null,
};

// ---------------------------------------------------------------------------
// The drift proof
// ---------------------------------------------------------------------------
describe('agreement with the dashboard\'s own source-health rules', () => {
  const cases = Object.keys(STATES).flatMap((state) =>
    [true, false].map((enabled) => ({ state, enabled })),
  );

  it.each(cases)('agrees on $state (enabled: $enabled)', ({ state, enabled }) => {
    const source = makeSource({ enabled, poll_interval: '12h' });
    const fetchState = STATES[state]!;
    const mine = computeBotSourceHealth(indexSources([source]).get(source.id)!, fetchState, 0, NOW);
    const dashboard = computeSourceHealth(source, fetchState, NOW, { githubAuthMode: 'unauthenticated' });

    expect(mine.stale).toBe(dashboard.stale);
    expect(mine.failing).toBe(dashboard.failing);
    expect(mine.inBackoff).toBe(dashboard.inBackoff);
    expect(mine.everPolled).toBe(dashboard.everPolled);
    expect(mine.lastSuccessAt).toBe(dashboard.lastSuccessAt);
    expect(mine.lastError).toBe(dashboard.lastError);
    expect(mine.consecutiveFailures).toBe(dashboard.consecutiveFailures);
    expect(mine.itemsYieldedSinceWindowStart).toBe(dashboard.itemsYieldedSinceWindowStart);
  });

  it('covers the case §7 cares about most — silently stale reads as failing', () => {
    const source = makeSource({ poll_interval: '12h' });
    const mine = computeBotSourceHealth(indexSources([source]).get(source.id)!, STATES.silentlyStale!, 0, NOW);
    expect(mine.consecutiveFailures).toBe(0);
    expect(mine.stale).toBe(true);
    expect(mine.failing).toBe(true);
  });
});

describe('parseBotPollIntervalMs', () => {
  it('agrees with the scheduler\'s own parser on every real poll_interval in config/sources.yaml', () => {
    const sources = loadSourcesFile(repoConfigPath('sources.yaml'));
    const intervals = [...new Set(sources.map((s) => s.poll_interval))];
    expect(intervals.length).toBeGreaterThan(2);
    for (const interval of intervals) {
      expect(parseBotPollIntervalMs('x', interval)).toBe(parsePollIntervalMs('x', interval));
    }
  });

  it('agrees on the shapes the schema rejects, too', () => {
    for (const interval of ['1m', '99999d', '15m', '6h']) {
      expect(parseBotPollIntervalMs('x', interval)).toBe(parsePollIntervalMs('x', interval));
    }
    for (const interval of ['0m', '', 'soon', '5w', '1.5h']) {
      expect(() => parseBotPollIntervalMs('x', interval)).toThrow();
      expect(() => parsePollIntervalMs('x', interval)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The tool, through the real dispatcher
// ---------------------------------------------------------------------------
function healthCorpus(): ReadOnlyCorpus {
  const corpus = openReadOnlyCorpus(
    seedRealCorpus({
      items: [
        { itemId: 'i1', itemKey: 'k1', title: 'one', sourceId: 'loud', fetchedAt: '2026-08-15T23:30:00.000Z', beats: ['ai'] },
        { itemId: 'i2', itemKey: 'k2', title: 'two', sourceId: 'loud', fetchedAt: '2026-08-15T23:30:00.000Z', beats: ['ai'] },
      ],
      fetchState: [
        { sourceId: 'loud', ...STATES.healthy!, updatedAt: STATES.healthy!.updatedAt },
        { sourceId: 'quiet', ...STATES.silentlyStale!, updatedAt: STATES.silentlyStale!.updatedAt },
      ],
    }),
  );
  open.push(corpus);
  return corpus;
}

const SOURCES: Source[] = [
  makeSource({ id: 'loud', name: 'Loud Feed', poll_interval: '1h' }),
  makeSource({ id: 'quiet', name: 'Quiet Feed', poll_interval: '1h', kind: 'advisory' }),
  makeSource({ id: 'brand-new', name: 'Brand New Feed', poll_interval: '1h' }),
  makeSource({ id: 'off', name: 'Switched Off', enabled: false }),
];

const tool = [createSourceHealthTool({ sources: SOURCES })];

describe('get_source_health', () => {
  it('reports every configured source, in config order, including one never polled', async () => {
    const { structured } = await callBotTool({ corpus: healthCorpus(), tools: tool, name: 'get_source_health', now: NOW });
    const rows = structured.sources as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(['loud', 'quiet', 'brand-new', 'off']);
    expect(rows.find((r) => r.id === 'brand-new')).toMatchObject({ everPolled: false, lastSuccessAt: null });
  });

  it('answers the question the tool exists for: no news, or the feed broke', async () => {
    const { structured } = await callBotTool({ corpus: healthCorpus(), tools: tool, name: 'get_source_health', now: NOW });
    const rows = structured.sources as Array<Record<string, unknown>>;
    const loud = rows.find((r) => r.id === 'loud')!;
    const quiet = rows.find((r) => r.id === 'quiet')!;
    expect(loud).toMatchObject({ failing: false, itemsFetchedTotal: 2 });
    // Zero failures on record, and still broken.
    expect(quiet).toMatchObject({ failing: true, stale: true, consecutiveFailures: 0, itemsFetchedTotal: 0 });
  });

  it('carries a summary a bot can branch on without scanning the list', async () => {
    const { structured } = await callBotTool({ corpus: healthCorpus(), tools: tool, name: 'get_source_health', now: NOW });
    expect(structured.summary).toEqual({
      configured: 4,
      enabled: 3,
      // `brand-new` AND the disabled `off` — neverPolled is a RAW fact about
      // the fetch-state row, not a judgement, so a disabled source counts.
      neverPolled: 2,
      // `quiet` (silently stale) and `brand-new` (no success on record).
      // `off` is disabled and therefore never reads as broken.
      stale: 2,
      failing: 2,
      inBackoff: 0,
    });
  });

  it('never lets a disabled source read as broken', async () => {
    const { structured } = await callBotTool({ corpus: healthCorpus(), tools: tool, name: 'get_source_health', now: NOW });
    const off = (structured.sources as Array<Record<string, unknown>>).find((r) => r.id === 'off')!;
    expect(off).toMatchObject({ enabled: false, stale: false, failing: false, inBackoff: false });
  });

  it('publishes no source URL — operator configuration, not something a bot acts on', async () => {
    const { response } = await callBotTool({ corpus: healthCorpus(), tools: tool, name: 'get_source_health', now: NOW });
    expect(JSON.stringify(response)).not.toContain('example.com/feed.xml');
  });
});

describe('get_source_health and as_of — refused, deliberately', () => {
  it('refuses rather than answering a point-in-time question from mutable state', async () => {
    const { structured, isError } = await callBotTool({
      corpus: healthCorpus(),
      tools: tool,
      name: 'get_source_health',
      args: { asOf: '2026-08-01T00:00:00.000Z' },
      now: NOW,
    });
    expect(isError).toBe(true);
    expect(structured.status).toBe('as_of_unsupported');
    expect(structured.sources).toBeNull();
    expect(String(structured.detail)).toMatch(/source_fetch_state/);
  });

  it('does not smuggle current health into the refusal', async () => {
    const { response } = await callBotTool({
      corpus: healthCorpus(),
      tools: tool,
      name: 'get_source_health',
      args: { asOf: '2026-08-01T00:00:00.000Z' },
      now: NOW,
    });
    expect(JSON.stringify(response)).not.toContain('Loud Feed');
  });

  it('answers normally when no as_of is given', async () => {
    const { isError, structured } = await callBotTool({ corpus: healthCorpus(), tools: tool, name: 'get_source_health', now: NOW });
    expect(isError).toBe(false);
    expect(Array.isArray(structured.sources)).toBe(true);
  });
});

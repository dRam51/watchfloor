/**
 * The three §8.2 tools that have no data, because M4b is deferred (M5 task 11).
 *
 * `get_market_snapshot`, `get_catalysts` and `get_filings` depend on markets
 * data that does not exist: `config/portfolio.yaml` is unwritten, there are
 * zero markets sources, and there is no ribbon, calendar or EDGAR adapter in
 * the schema.
 *
 * **They must report "not configured", never an empty array.** The M5 plan
 * states why in one sentence: *"a bot would read [] as 'no catalysts' rather
 * than 'no data source'"*, and *"a backtest fed silent emptiness produces
 * confident, wrong numbers."* So the assertions below are mostly NEGATIVE —
 * `src/vault/daily.ts`'s `market_ribbon: not_configured` set the precedent of
 * asserting that the value is never a number, `{}`, `[]`, `0`, or omitted.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openReadOnlyCorpus, type ReadOnlyCorpus } from '../../../src/mcp/readonly.ts';
import type { Source } from '../../../src/sources/load.ts';
import { createMarketTools, DEFERRED_STATUS } from '../../../src/mcp/tools/markets.ts';
import { loadBotSources } from '../../../src/mcp/tools/sources.ts';
import { callBotTool, seedRealCorpus } from './fixture.ts';

const open: ReadOnlyCorpus[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

function corpus(): ReadOnlyCorpus {
  const handle = openReadOnlyCorpus(seedRealCorpus());
  open.push(handle);
  return handle;
}

function marketsSource(): Source {
  return {
    id: 'some-quotes',
    name: 'Some Quotes',
    type: 'market_data',
    url: 'https://example.com/quotes',
    beats: ['markets'],
    weight: 1,
    poll_interval: '15m',
    enabled: true,
    enrichment: true,
  } as Source;
}

const TOOLS = createMarketTools({ sources: [] });
const REAL_TOOLS = createMarketTools({ sources: loadBotSources() });

/** The key each tool would fill in once M4b exists. */
const PAYLOAD_KEY: Record<string, string> = {
  get_market_snapshot: 'snapshot',
  get_catalysts: 'catalysts',
  get_filings: 'filings',
};

const ARGS: Record<string, Record<string, unknown>> = {
  get_market_snapshot: {},
  get_catalysts: { entities: ['NVDA'], window: '7d' },
  get_filings: { ticker: 'NVDA', formType: '8-K' },
};

describe.each(Object.keys(PAYLOAD_KEY))('%s', (name) => {
  it('reports not_configured', async () => {
    const { structured, isError } = await callBotTool({ corpus: corpus(), tools: TOOLS, name, args: ARGS[name] });
    expect(structured.status).toBe(DEFERRED_STATUS);
    // Not a tool EXECUTION error: no argument the bot could change makes this
    // succeed, so `isError: true` ("feedback a model can self-correct from")
    // would be a lie that invites a retry loop.
    expect(isError).toBe(false);
  });

  it('returns NULL where the data would go — never [], never {}, never 0, never absent', async () => {
    const { structured } = await callBotTool({ corpus: corpus(), tools: TOOLS, name, args: ARGS[name] });
    const key = PAYLOAD_KEY[name]!;
    expect(key in structured).toBe(true);
    expect(structured[key]).toBeNull();
    expect(structured[key]).not.toEqual([]);
    expect(structured[key]).not.toEqual({});
    expect(structured[key]).not.toBe(0);
  });

  it('names what it is blocked on, so "not configured" is actionable', async () => {
    const { structured } = await callBotTool({ corpus: corpus(), tools: TOOLS, name, args: ARGS[name] });
    const blockedOn = structured.blockedOn as { milestone: string; needs: string[] };
    expect(blockedOn.milestone).toBe('M4b');
    expect(blockedOn.needs.length).toBeGreaterThan(0);
    expect(String(structured.detail).length).toBeGreaterThan(40);
  });

  it('carries no empty collection ANYWHERE in the payload that a bot could iterate as an answer', async () => {
    const { structured } = await callBotTool({ corpus: corpus(), tools: TOOLS, name, args: ARGS[name] });
    // `blockedOn.needs` and `marketsSources` are the only arrays, and needs is
    // non-empty. An empty array anywhere else is the failure mode this whole
    // family of tools exists to avoid.
    const emptyArrays: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        if (value.length === 0 && path !== 'marketsSources') emptyArrays.push(path);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) walk(child, path === '' ? key : `${path}.${key}`);
      }
    };
    walk(structured, '');
    expect(emptyArrays).toEqual([]);
  });

  it('still refuses a malformed as_of rather than hiding it behind not_configured', async () => {
    const { isError, response } = await callBotTool({
      corpus: corpus(),
      tools: TOOLS,
      name,
      args: { ...ARGS[name], asOf: '2026-08-14' },
    });
    expect(isError).toBe(true);
    expect(JSON.stringify(response)).toContain('asOf');
  });

  it('is registrable — its name and every argument name clear the §8.2 registry guard', async () => {
    const { structured } = await callBotTool({ corpus: corpus(), tools: REAL_TOOLS, name, args: ARGS[name] });
    expect(structured.status).toBe(DEFERRED_STATUS);
  });
});

describe('the reason changes once a markets SOURCE exists — and the status does not', () => {
  it('reports no_markets_source against the real config today', async () => {
    const { structured } = await callBotTool({ corpus: corpus(), tools: REAL_TOOLS, name: 'get_market_snapshot' });
    expect((structured.blockedOn as { reason: string }).reason).toBe('no_markets_source');
  });

  it('reports no_markets_store when one is configured, still not_configured', async () => {
    const tools = createMarketTools({ sources: [marketsSource()] });
    const { structured } = await callBotTool({ corpus: corpus(), tools, name: 'get_market_snapshot' });
    expect(structured.status).toBe(DEFERRED_STATUS);
    expect((structured.blockedOn as { reason: string }).reason).toBe('no_markets_store');
    expect(structured.snapshot).toBeNull();
  });
});

describe('the boundary these tools sit closest to', () => {
  it('never mentions the owner\'s portfolio file contents — only that it is missing', async () => {
    for (const name of Object.keys(PAYLOAD_KEY)) {
      const { response } = await callBotTool({ corpus: corpus(), tools: REAL_TOOLS, name, args: ARGS[name] });
      const text = JSON.stringify(response);
      // Naming the path is fine and useful; reading it is not. This module
      // imports no filesystem reader for it, asserted in sourceProperties.
      expect(text).toContain('config/portfolio.yaml');
      expect(text).not.toMatch(/holdings|weights|tickers:/i);
    }
  });

  it('echoes the request back so a bot can tell "understood but unavailable" from "misrouted"', async () => {
    const { structured } = await callBotTool({
      corpus: corpus(),
      tools: TOOLS,
      name: 'get_filings',
      args: { ticker: 'NVDA', formType: '8-K', since: '2026-01-01T00:00:00.000Z' },
    });
    expect(structured.request).toEqual({
      ticker: 'NVDA',
      formType: '8-K',
      since: '2026-01-01T00:00:00.000Z',
      asOf: '2026-08-16T00:00:00.000Z',
      asOfProvided: false,
    });
  });
});

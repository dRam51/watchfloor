/**
 * `get_items_for_entity` (M5 task 11) — §8.2's *"news matching a ticker or a
 * `related_entities` key"*, and the only §8.2 tool with real data behind it.
 *
 * Four rules are being pinned, in descending order of how quietly they fail:
 *
 * 1. **`as_of` keys on `fetched_at`, and so does the SCORE** (`computed_at`).
 *    Filtering items but not scores leaves lookahead in the exact number the
 *    bot ranks by.
 * 2. **RULING 1** — the default content filter is `kind in (news, advisory)`,
 *    the owner's approved departure from §8.2's literal `item_type in (event)`.
 * 3. **`signal_score` only, never `read_score`** — enforced three planes down
 *    and re-checked here on real output.
 * 4. **An unscored item is reported, not dropped.** The archived corpus has
 *    3,325 items and zero score rows; a tool that silently required a score
 *    would report an empty corpus as an empty world.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openReadOnlyCorpus, type ReadOnlyCorpus } from '../../../src/mcp/readonly.ts';
import { loadDecayConfig } from '../../../src/score/decay.ts';
import type { Source } from '../../../src/sources/load.ts';
import { createItemsForEntityTool } from '../../../src/mcp/tools/items.ts';
import { repoConfigPath } from '../../../src/mcp/tools/sources.ts';
import { callBotTool, seedRealCorpus, type ToolCallResult } from './fixture.ts';

const open: ReadOnlyCorpus[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

const decayConfig = loadDecayConfig(repoConfigPath('decay.yaml'));
const NOW = '2026-08-16T00:00:00.000Z';

function makeSource(id: string, kind: Source['kind'], beats: Source['beats'] = ['ai']): Source {
  return {
    id,
    name: id,
    type: 'rss',
    url: `https://example.com/${id}.xml`,
    beats,
    weight: 1,
    poll_interval: '1h',
    enabled: true,
    enrichment: true,
    kind,
  } as Source;
}

const SOURCES: Source[] = [
  makeSource('wire', 'news'),
  makeSource('advisory-feed', 'advisory', ['cyber']),
  makeSource('a-blog', 'blog'),
  makeSource('arxiv', 'paper'),
  makeSource('aggregator', 'aggregator'),
];

const tools = [createItemsForEntityTool({ sources: SOURCES, decayConfig })];

const T_EARLY = '2026-08-10T00:00:00.000Z';
const T_MID = '2026-08-13T00:00:00.000Z';
const T_LATE = '2026-08-15T00:00:00.000Z';

function corpusWithEntities(): ReadOnlyCorpus {
  const corpus = openReadOnlyCorpus(
    seedRealCorpus({
      items: [
        // A wire story, two versions: the headline changes, and it is rescored.
        { itemId: 'n1-a', itemKey: 'n1', title: 'OpenAI in talks', sourceId: 'wire', fetchedAt: T_EARLY, publishedAt: T_EARLY, beats: ['ai'], entities: ['OpenAI'], scores: [['ai', 2, 9, T_EARLY]] },
        { itemId: 'n1-b', itemKey: 'n1', title: 'OpenAI signs the deal', sourceId: 'wire', fetchedAt: T_LATE, publishedAt: T_EARLY, beats: ['ai'], entities: ['OpenAI'], scores: [['ai', 8, 9, T_LATE]] },
        // An advisory, undated -- the KEV shape.
        { itemId: 'a1', itemKey: 'a1', title: 'Microsoft Win32k Privilege Escalation Vulnerability', sourceId: 'advisory-feed', itemType: 'event', publishedAt: null, fetchedAt: T_MID, beats: ['cyber'], entities: ['Microsoft', 'OpenAI'], scores: [['cyber', 5, 3, T_MID]] },
        // A blog and a paper -- excluded by RULING 1's default.
        { itemId: 'b1', itemKey: 'b1', title: 'Thoughts on OpenAI', sourceId: 'a-blog', fetchedAt: T_MID, publishedAt: T_MID, beats: ['ai'], entities: ['OpenAI'], scores: [['ai', 9, 9, T_MID]] },
        { itemId: 'p1', itemKey: 'p1', title: 'A paper mentioning OpenAI', sourceId: 'arxiv', fetchedAt: T_MID, publishedAt: T_MID, beats: ['ai'], entities: ['OpenAI'], scores: [['ai', 9, 9, T_MID]] },
        // Never scored -- the archive's whole state.
        { itemId: 'u1', itemKey: 'u1', title: 'OpenAI, unscored', sourceId: 'wire', fetchedAt: T_MID, publishedAt: T_MID, beats: ['ai'], entities: ['OpenAI'] },
        // A different entity entirely.
        { itemId: 'o1', itemKey: 'o1', title: 'Prompt injection roundup', sourceId: 'wire', fetchedAt: T_MID, publishedAt: T_MID, beats: ['aisec'], entities: ['Prompt injection'], scores: [['aisec', 4, 4, T_MID]] },
      ],
    }),
  );
  open.push(corpus);
  return corpus;
}

async function call(args: Record<string, unknown>, now = NOW): Promise<ToolCallResult> {
  return callBotTool({ corpus: corpusWithEntities(), tools, name: 'get_items_for_entity', args, now });
}

function keysOf(result: ToolCallResult): string[] {
  return (result.structured.items as Array<Record<string, unknown>>).map((i) => String(i.itemKey));
}

// ---------------------------------------------------------------------------
// RULING 1
// ---------------------------------------------------------------------------
describe('the default content filter — RULING 1, not §8.2\'s literal item_type', () => {
  it('returns news and advisories, and excludes blogs, papers and aggregators', async () => {
    const result = await call({ entity: 'OpenAI' });
    expect(keysOf(result).sort()).toEqual(['a1', 'n1', 'u1']);
  });

  it('reports the filter it applied, naming the ruling', async () => {
    const result = await call({ entity: 'OpenAI' });
    expect(result.structured.filter).toMatchObject({ axis: 'kind', kinds: ['advisory', 'news'], default: true });
  });

  it('widens on explicit request — §8.2\'s "available only on explicit request"', async () => {
    const result = await call({ entity: 'OpenAI', kinds: ['news', 'advisory', 'blog', 'paper'] });
    expect(keysOf(result).sort()).toEqual(['a1', 'b1', 'n1', 'p1', 'u1']);
    expect(result.structured.filter).toMatchObject({ default: false });
  });

  it('does NOT key on item_type: the advisory it returns is `event`, the news is `analysis`', async () => {
    const result = await call({ entity: 'OpenAI' });
    const types = (result.structured.items as Array<Record<string, unknown>>).map((i) => i.itemType).sort();
    expect(types).toEqual(['analysis', 'analysis', 'event']);
  });
});

// ---------------------------------------------------------------------------
// Point in time
// ---------------------------------------------------------------------------
describe('as_of', () => {
  it('returns the version current at the instant, not the newest', async () => {
    const before = await call({ entity: 'OpenAI', asOf: T_MID });
    const items = before.structured.items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.itemKey === 'n1')?.title).toBe('OpenAI in talks');

    const after = await call({ entity: 'OpenAI', asOf: T_LATE });
    const later = after.structured.items as Array<Record<string, unknown>>;
    expect(later.find((i) => i.itemKey === 'n1')?.title).toBe('OpenAI signs the deal');
  });

  it('uses the score that existed at the instant, never a later rescore', async () => {
    const before = await call({ entity: 'OpenAI', asOf: T_MID });
    const items = before.structured.items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.itemKey === 'n1')?.signalScoreStored).toBe(2);

    const after = await call({ entity: 'OpenAI', asOf: T_LATE });
    const later = after.structured.items as Array<Record<string, unknown>>;
    expect(later.find((i) => i.itemKey === 'n1')?.signalScoreStored).toBe(8);
  });

  it('hides an item this system had not seen yet', async () => {
    const result = await call({ entity: 'OpenAI', asOf: '2026-08-11T00:00:00.000Z' });
    expect(keysOf(result)).toEqual(['n1']);
  });

  it('reports firstSeenAt, never the returned version\'s own fetched_at', async () => {
    const result = await call({ entity: 'OpenAI', asOf: T_LATE });
    const n1 = (result.structured.items as Array<Record<string, unknown>>).find((i) => i.itemKey === 'n1')!;
    expect(n1.firstSeenAt).toBe(T_EARLY);
  });

  it('keeps the undated advisory — the population a published_at filter drops', async () => {
    const result = await call({ entity: 'OpenAI', asOf: T_LATE });
    const a1 = (result.structured.items as Array<Record<string, unknown>>).find((i) => i.itemKey === 'a1')!;
    expect(a1.publishedAt).toBeNull();
    expect(a1.firstSeenAt).toBe(T_MID);
  });

  it('decays from the as_of instant, not from the wall clock', async () => {
    const atMid = await call({ entity: 'OpenAI', asOf: T_MID });
    const atLate = await call({ entity: 'OpenAI', asOf: T_LATE });
    const decayAt = (r: ToolCallResult, key: string) =>
      (r.structured.items as Array<Record<string, unknown>>).find((i) => i.itemKey === key)!.decayFactor as number;
    // Same stored score at both instants for a1 (scored once, at T_MID), so
    // any difference in the decayed value is decay and nothing else.
    expect(decayAt(atMid, 'a1')).toBeCloseTo(1, 12);
    expect(decayAt(atLate, 'a1')).toBeLessThan(decayAt(atMid, 'a1'));
  });

  it('applies the beat\'s own half-life — cyber signal is 6h, so 48h is 2^-8', async () => {
    const result = await call({ entity: 'OpenAI', asOf: T_LATE });
    const a1 = (result.structured.items as Array<Record<string, unknown>>).find((i) => i.itemKey === 'a1')!;
    // a1 is undated, so decay keys on firstSeenAt = T_MID; T_LATE - T_MID = 48h.
    expect(a1.decayFactor).toBeCloseTo(Math.pow(0.5, 48 / 6), 12);
    expect(a1.signalScore).toBeCloseTo(5 * Math.pow(0.5, 48 / 6), 12);
    expect(a1.signalScoreStored).toBe(5);
  });

  it('refuses a malformed as_of as a self-correctable tool error', async () => {
    const result = await call({ entity: 'OpenAI', asOf: '2026-08-13' });
    expect(result.isError).toBe(true);
    expect(result.structured.status).toBe('invalid_as_of');
  });

  it('says whether the caller pinned the instant', async () => {
    expect((await call({ entity: 'OpenAI' })).structured.asOfProvided).toBe(false);
    expect((await call({ entity: 'OpenAI', asOf: T_LATE })).structured.asOfProvided).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `since`, and why it is not published_at
// ---------------------------------------------------------------------------
describe('since', () => {
  it('filters on when Watchfloor first had the item, not on the source\'s claimed date', async () => {
    const result = await call({ entity: 'OpenAI', since: T_MID });
    // n1 was first seen at T_EARLY, so it is out even though its newest
    // version arrived at T_LATE.
    expect(keysOf(result).sort()).toEqual(['a1', 'u1']);
    expect(result.structured.sinceAxis).toBe('firstSeenAt');
  });

  it('is inclusive at its own boundary', async () => {
    expect(keysOf(await call({ entity: 'OpenAI', since: T_EARLY })).sort()).toEqual(['a1', 'n1', 'u1']);
  });

  it('would be unusable on published_at: one of these three items has none', async () => {
    const result = await call({ entity: 'OpenAI' });
    const undated = (result.structured.items as Array<Record<string, unknown>>).filter((i) => i.publishedAt === null);
    expect(undated).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------
describe('scores', () => {
  it('reports an unscored item rather than dropping it, and counts it', async () => {
    const result = await call({ entity: 'OpenAI' });
    const u1 = (result.structured.items as Array<Record<string, unknown>>).find((i) => i.itemKey === 'u1')!;
    expect(u1.signalScore).toBeNull();
    expect(u1.signalScoreStored).toBeNull();
    expect(u1.scoredAt).toBeNull();
    expect(result.structured.unscored).toBe(1);
  });

  it('drops unscored items only when a floor is asked for, and says so', async () => {
    const result = await call({ entity: 'OpenAI', minSignalScore: 0 });
    expect(keysOf(result)).not.toContain('u1');
    expect(result.structured.unscoredExcluded).toBe(1);
  });

  it('applies the floor to the DECAYED score, which is what a ranking uses', async () => {
    const high = await call({ entity: 'OpenAI', asOf: T_MID, minSignalScore: 4.9 });
    expect(keysOf(high)).toEqual(['a1']);
    const none = await call({ entity: 'OpenAI', asOf: T_LATE, minSignalScore: 4.9 });
    // 48 hours later a1's decayed score is 5 * 2^-8 -- far under the floor.
    expect(keysOf(none)).toEqual([]);
  });

  it('picks the beat the item scores highest in, and lists every beat it carries', async () => {
    const result = await call({ entity: 'OpenAI', asOf: T_LATE });
    const a1 = (result.structured.items as Array<Record<string, unknown>>).find((i) => i.itemKey === 'a1')!;
    expect(a1.beat).toBe('cyber');
    expect(a1.beats).toEqual(['cyber']);
  });

  it('never emits read_score, under any name', async () => {
    const result = await call({ entity: 'OpenAI' });
    const text = JSON.stringify(result.response);
    expect(text).not.toMatch(/read_?[sS]core/);
    // 9 is the read_score every seeded item carries; it must appear nowhere.
    expect(text).not.toContain('"readScore"');
  });
});

// ---------------------------------------------------------------------------
// Honesty about the entity itself
// ---------------------------------------------------------------------------
describe('an entity this corpus has never heard of', () => {
  it('is distinguishable from an entity with no matching news', async () => {
    const unknown = await call({ entity: 'Definitely Not An Entity' });
    expect(unknown.structured.entityKnown).toBe(false);
    expect(unknown.structured.items).toEqual([]);
    expect(unknown.structured.candidates).toBe(0);

    // Known, but every match is filtered out by the caller's own `since`.
    const filtered = await call({ entity: 'OpenAI', since: '2026-08-20T00:00:00.000Z' });
    expect(filtered.structured.entityKnown).toBe(true);
    // `candidates` counts entity matches BEFORE any filter -- all five items
    // carrying `OpenAI`, including the blog and the paper RULING 1 excludes.
    // `matched` is what survived. Two numbers, because "the entity is unknown",
    // "your kind filter removed everything" and "your since removed everything"
    // are three different answers a bot should not have to guess between.
    expect(filtered.structured.candidates).toBe(5);
    expect(filtered.structured.matched).toBe(0);
    expect(filtered.structured.items).toEqual([]);
  });

  it('matches exactly, because the extractor is case-sensitive by measurement', async () => {
    // M5 task 16 measured this: matching `iOS` case-insensitively folds in 47
    // Cisco IOS advisories.
    expect((await call({ entity: 'openai' })).structured.entityKnown).toBe(false);
    expect((await call({ entity: 'OpenAI' })).structured.entityKnown).toBe(true);
  });

  it('reports entityKnown AS OF the instant asked about', async () => {
    const result = await call({ entity: 'Prompt injection', asOf: '2026-08-11T00:00:00.000Z' });
    expect(result.structured.entityKnown).toBe(false);
    expect((await call({ entity: 'Prompt injection', asOf: T_MID })).structured.entityKnown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ordering and limits
// ---------------------------------------------------------------------------
describe('ordering', () => {
  it('ranks by decayed signal score, scored items before unscored', async () => {
    const result = await call({ entity: 'OpenAI', asOf: T_MID });
    expect(keysOf(result)).toEqual(['a1', 'n1', 'u1']);
  });

  it('honours limit and reports how many matched before it', async () => {
    const result = await call({ entity: 'OpenAI', asOf: T_MID, limit: 1 });
    expect(keysOf(result)).toEqual(['a1']);
    expect(result.structured.matched).toBe(3);
    expect(result.structured.returned).toBe(1);
  });

  it('is deterministic on a tie without depending on the host\'s ICU collation', async () => {
    // src/score/rank.ts's sortRanked breaks ties with localeCompare, which the
    // M5 ledger flags as host-ICU dependent. This tool compares item_key by
    // codepoint, so two runs on any host agree.
    const a = keysOf(await call({ entity: 'OpenAI', asOf: T_MID }));
    const b = keysOf(await call({ entity: 'OpenAI', asOf: T_MID }));
    expect(a).toEqual(b);
  });
});

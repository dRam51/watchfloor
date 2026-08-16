/**
 * Point-in-time reads for the bot (M5 task 11) — §8.2's *"the part that will
 * silently ruin the bot"*:
 *
 * > *"Every item carries `fetched_at` (when Watchfloor first had it) distinct
 * > from `published_at` (when the source says it appeared). All query tools
 * > must accept an `as_of` parameter and, when given, return only items where
 * > `fetched_at <= as_of`. Without this, any evaluation the bot runs against
 * > historical news is contaminated by lookahead bias and its backtest numbers
 * > are fiction."*
 *
 * Two corpus facts decide how this file is written, and both were measured
 * rather than assumed:
 *
 *  - **The live corpus cannot exercise the hard case.** All 7,267 of its rows
 *    carry a `published_at`. The ARCHIVED first run does: 1,715 of 3,325 are
 *    null-dated. So the real-data proof runs against
 *    `attic/wf-m1-firstrun-2026-08-14.db`, opened read-only.
 *  - **The archive has exactly ONE distinct `fetched_at`** (every row landed in
 *    one ingest at `2026-08-14T03:47:10.404Z`). That makes it a perfect
 *    boundary test and a useless sweep, so the graded sweep is a temp corpus
 *    built on the real schema.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openReadOnlyCorpus, type ReadOnlyCorpus } from '../../../src/mcp/readonly.ts';
import {
  AsOfError,
  assertWithinRetentionHorizon,
  readItemsAsOf,
  readBeatsAsOf,
  readSignalScoresAsOf,
  resolveReadInstant,
  visibleItemKeysAsOf,
} from '../../../src/mcp/tools/asOf.ts';
import { archivePath, seedRealCorpus } from './fixture.ts';

const open: ReadOnlyCorpus[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

function corpusOf(path: string): ReadOnlyCorpus {
  const corpus = openReadOnlyCorpus(path);
  open.push(corpus);
  return corpus;
}

const NOW = '2026-08-16T00:00:00.000Z';

// ---------------------------------------------------------------------------
// resolveReadInstant
// ---------------------------------------------------------------------------
describe('resolveReadInstant', () => {
  it('defaults to the request\'s canonical now, and says the caller did not pin one', () => {
    expect(resolveReadInstant(undefined, NOW)).toEqual({ readAt: NOW, asOfProvided: false });
  });

  it('uses the caller\'s as_of and says so', () => {
    expect(resolveReadInstant('2026-08-14T12:00:00.000Z', NOW)).toEqual({
      readAt: '2026-08-14T12:00:00.000Z',
      asOfProvided: true,
    });
  });

  it('refuses a non-canonical as_of rather than parsing it loosely', () => {
    // '2026-08-14' would Date.parse fine and mean midnight UTC -- a silent
    // reinterpretation of a backtest boundary.
    expect(() => resolveReadInstant('2026-08-14', NOW)).toThrow(AsOfError);
    expect(() => resolveReadInstant('2026-08-14T12:00:00Z', NOW)).toThrow(AsOfError);
    expect(() => resolveReadInstant('2026-08-14T12:00:00.000+02:00', NOW)).toThrow(AsOfError);
  });
});

// ---------------------------------------------------------------------------
// The retention horizon: a question older than the data must fail loudly
// ---------------------------------------------------------------------------
describe('assertWithinRetentionHorizon', () => {
  it('passes when no horizon is recorded — the state every corpus is in before M6', () => {
    const corpus = corpusOf(seedRealCorpus());
    expect(() => assertWithinRetentionHorizon(corpus, '2020-01-01T00:00:00.000Z')).not.toThrow();
  });

  it('refuses an as_of older than the horizon rather than answering from thinned history', () => {
    const corpus = corpusOf(seedRealCorpus({ retentionHorizon: '2026-06-01T00:00:00.000Z' }));
    expect(() => assertWithinRetentionHorizon(corpus, '2026-05-31T23:59:59.999Z')).toThrow(AsOfError);
    expect(() => assertWithinRetentionHorizon(corpus, '2026-06-01T00:00:00.000Z')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The graded sweep, on a real-schema corpus
// ---------------------------------------------------------------------------
const V1 = '2026-08-10T00:00:00.000Z';
const V2 = '2026-08-12T00:00:00.000Z';
const V3 = '2026-08-14T00:00:00.000Z';

function sweepCorpus(): ReadOnlyCorpus {
  return corpusOf(
    seedRealCorpus({
      items: [
        // Three versions of ONE item, the re-poll case: first seen at V1, the
        // headline changes at V3. Modelled on the ten real title-drift keys M5
        // task 3 measured ("Wall Street holds near its record" ->
        // "Wall Street slips back from its record").
        { itemId: 'drift-1', itemKey: 'drift', title: 'holds near its record', sourceId: 'ap-news', fetchedAt: V1, publishedAt: V1, beats: ['usnews'], entities: ['Wall Street'], scores: [['usnews', 1, 9, V1]] },
        { itemId: 'drift-2', itemKey: 'drift', title: 'slips back from its record', sourceId: 'ap-news', fetchedAt: V3, publishedAt: V1, beats: ['usnews', 'markets'], entities: ['Wall Street', 'S&P 500'], scores: [['usnews', 5, 9, V3]] },
        // An undated item, the KEV shape: null published_at, re-delivered.
        { itemId: 'kev-1', itemKey: 'kev', title: 'Microsoft Win32k Privilege Escalation Vulnerability', sourceId: 'cisa-kev', itemType: 'event', publishedAt: null, fetchedAt: V1, beats: ['cyber'], entities: ['Microsoft'], scores: [['cyber', 3, 2, V1]] },
        { itemId: 'kev-2', itemKey: 'kev', title: 'Microsoft Win32k Privilege Escalation Vulnerability', sourceId: 'cisa-kev', itemType: 'event', publishedAt: null, fetchedAt: V3, beats: ['cyber'], entities: ['Microsoft'] },
        // An item that only exists after V2.
        { itemId: 'late-1', itemKey: 'late', title: 'arrived later', sourceId: 'krebs', fetchedAt: V3, publishedAt: V2, beats: ['cyber'], entities: ['Microsoft'], scores: [['cyber', 7, 1, V3]] },
      ],
    }),
  );
}

describe('readItemsAsOf', () => {
  it('returns the version that was current AS OF the instant, not the newest one', () => {
    const corpus = sweepCorpus();
    expect(readItemsAsOf(corpus, ['drift'], V2).get('drift')?.title).toBe('holds near its record');
    expect(readItemsAsOf(corpus, ['drift'], V3).get('drift')?.title).toBe('slips back from its record');
  });

  it('is inclusive at the boundary — `<=`, never `<`', () => {
    const corpus = sweepCorpus();
    expect(readItemsAsOf(corpus, ['late'], '2026-08-13T23:59:59.999Z').has('late')).toBe(false);
    expect(readItemsAsOf(corpus, ['late'], V3).has('late')).toBe(true);
  });

  it('reports firstSeenAt as the EARLIEST version, never the version it returned', () => {
    const corpus = sweepCorpus();
    const drift = readItemsAsOf(corpus, ['drift'], V3).get('drift')!;
    expect(drift.versionFetchedAt).toBe(V3);
    // The bug CLAUDE.md records as having bitten four times: a re-poll must not
    // reset "when Watchfloor first had it" to now.
    expect(drift.firstSeenAt).toBe(V1);
  });

  it('scopes firstSeenAt to versions visible at as_of, so it never uses a fact learned later', () => {
    const corpus = sweepCorpus();
    expect(readItemsAsOf(corpus, ['drift'], V2).get('drift')?.firstSeenAt).toBe(V1);
  });

  // The whole point of keying on fetched_at.
  it('returns an item whose published_at is NULL — the population a published_at filter drops', () => {
    const corpus = sweepCorpus();
    const kev = readItemsAsOf(corpus, ['kev'], V2).get('kev');
    expect(kev?.publishedAt).toBeNull();
    expect(kev?.firstSeenAt).toBe(V1);
  });

  it('handles more keys than one SQL parameter list should carry', () => {
    const corpus = sweepCorpus();
    const keys = [...Array(2500).keys()].map((n) => `absent-${n}`);
    expect(readItemsAsOf(corpus, [...keys, 'drift'], V3).size).toBe(1);
  });
});

describe('readBeatsAsOf', () => {
  it('unions beats across versions — the itemBeats rule, scoped to as_of', () => {
    const corpus = sweepCorpus();
    expect(readBeatsAsOf(corpus, ['drift'], V2).get('drift')).toEqual(['usnews']);
    expect(readBeatsAsOf(corpus, ['drift'], V3).get('drift')).toEqual(['markets', 'usnews']);
  });
});

describe('readSignalScoresAsOf', () => {
  it('takes the latest score row computed AT OR BEFORE as_of, never a later rescore', () => {
    const corpus = sweepCorpus();
    expect(readSignalScoresAsOf(corpus, ['drift'], V2).get('drift')?.get('usnews')?.signalScore).toBe(1);
    expect(readSignalScoresAsOf(corpus, ['drift'], V3).get('drift')?.get('usnews')?.signalScore).toBe(5);
  });

  it('returns nothing for an item scored only after as_of — a score is knowledge too', () => {
    const corpus = sweepCorpus();
    expect(readSignalScoresAsOf(corpus, ['late'], V2).get('late')).toBeUndefined();
  });

  it('never reads the forbidden column: the read-only handle refuses that SQL outright', () => {
    const corpus = sweepCorpus();
    expect(() => corpus.all('select read_score from item_scores')).toThrow(/forbidden field rule/);
  });
});

// ---------------------------------------------------------------------------
// THE REAL-DATA PROOF — the archived first run, read-only, never written
// ---------------------------------------------------------------------------
describe('the archived first ingest (attic/wf-m1-firstrun-2026-08-14.db)', () => {
  const INGEST_INSTANT = '2026-08-14T03:47:10.404Z';

  it('is the corpus this proof needs: 3,325 items, 1,715 of them undated', () => {
    const corpus = corpusOf(archivePath());
    const row = corpus.get(
      'select count(*) as total, sum(case when published_at is null then 1 else 0 end) as undated from items',
    )!;
    expect(Number(row.total)).toBe(3325);
    expect(Number(row.undated)).toBe(1715);
  });

  it('returns every item at the ingest instant and none one millisecond earlier', () => {
    const corpus = corpusOf(archivePath());
    expect(visibleItemKeysAsOf(corpus, '2026-08-14T03:47:10.403Z')).toHaveLength(0);
    // 3,307 distinct item_keys across 3,325 rows -- the 18 cross-listed arXiv
    // papers CLAUDE.md records are two rows sharing one key.
    expect(visibleItemKeysAsOf(corpus, INGEST_INSTANT)).toHaveLength(3307);
  });

  /**
   * The mutation this file exists to make impossible, stated as an assertion
   * about real rows: keying the as-of filter on `published_at` silently drops
   * every undated item, at EVERY as_of, including "now".
   */
  it('keying on published_at instead of fetched_at would drop 1,715 real items — 51.6% of the corpus', () => {
    const corpus = corpusOf(archivePath());
    const byFetched = visibleItemKeysAsOf(corpus, '2026-09-01T00:00:00.000Z').length;
    const byPublished = Number(
      corpus.get('select count(distinct item_key) as n from items where published_at <= ?', '2026-09-01T00:00:00.000Z')!.n,
    );
    // 3,307 distinct keys reachable by fetched_at; 1,592 by published_at. The
    // 1,715 difference is exactly the undated row count -- the 18 cross-listed
    // arXiv duplicates are all dated, so they collapse on both sides.
    expect(byFetched).toBe(3307);
    expect(byPublished).toBe(1592);
    expect(byFetched - byPublished).toBe(1715);
  });

  it('reads real undated rows through the tool\'s own path, first-seen and all', () => {
    const corpus = corpusOf(archivePath());
    const undated = corpus
      .all('select item_key as item_key from items where published_at is null and source_id = ? limit 5', 'cisa-kev')
      .map((r) => String(r.item_key));
    expect(undated).toHaveLength(5);

    const items = readItemsAsOf(corpus, undated, INGEST_INSTANT);
    expect(items.size).toBe(5);
    for (const item of items.values()) {
      expect(item.publishedAt).toBeNull();
      expect(item.firstSeenAt).toBe(INGEST_INSTANT);
      expect(item.versionFetchedAt <= INGEST_INSTANT).toBe(true);
    }
  });

  it('every returned item satisfies fetched_at <= as_of — the §8.2 clause, checked directly', () => {
    const corpus = corpusOf(archivePath());
    const keys = visibleItemKeysAsOf(corpus, INGEST_INSTANT);
    const items = readItemsAsOf(corpus, keys, INGEST_INSTANT);
    expect(items.size).toBe(3307);
    const violations = [...items.values()].filter((i) => i.versionFetchedAt > INGEST_INSTANT || i.firstSeenAt > INGEST_INSTANT);
    expect(violations).toEqual([]);
  });
});

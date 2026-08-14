/**
 * M3 Wave 2, Task 4 -- GET /feed.
 *
 * Builds its own local server (Fastify() + registerAuth + registerFeed)
 * rather than importing src/api/server.ts's buildServer, per the task
 * brief's concurrency rule: two sibling Wave-2 tasks are editing
 * src/api/server.ts in parallel, and this file must not depend on feed
 * being wired in there yet.
 *
 * Test config (decay/overrides) is hand-built, independent of the real
 * config/*.yaml, so the numbers are legible and stable regardless of future
 * retuning -- mirrors tests/score/decay.test.ts's own stated convention.
 * The real-corpus section at the bottom is the exception: it deliberately
 * uses the real config/*.yaml against a copy of data/wf.db.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { registerAuth } from '../../src/api/auth.ts';
import { registerFeed, type FeedDeps } from '../../src/api/routes/feed.ts';
import { insertItem, deriveItemKey, type NewItem } from '../../src/domain/item.ts';
import { dismissItem, markItemRead, saveItem } from '../../src/domain/itemState.ts';
import { computeDecayFactor, type DecayConfig } from '../../src/score/decay.ts';
import { loadDecayConfig } from '../../src/score/decay.ts';
import { loadOverridesConfig, type OverridesConfig, type OverrideRule } from '../../src/score/overrides.ts';
import { loadMechanicalScoreConfig } from '../../src/score/mechanical.ts';

const TOKEN = 'a-real-token-that-is-long-enough';

// ---------------------------------------------------------------------------
// DB plumbing
// ---------------------------------------------------------------------------

const open: Db[] = [];
function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-feed-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

// ---------------------------------------------------------------------------
// Hand-built config, independent of config/*.yaml (see file header).
// ---------------------------------------------------------------------------

function testDecayConfig(): DecayConfig {
  return {
    beats: {
      ai: { signal_half_life_hours: 48, read_half_life_hours: 504 },
      cyber: { signal_half_life_hours: 6, read_half_life_hours: 336 },
      aisec: { signal_half_life_hours: 8, read_half_life_hours: 336 },
      repos: { signal_half_life_hours: 72, read_half_life_hours: 336 },
      usnews: { signal_half_life_hours: 24, read_half_life_hours: 168 },
    },
    markets_item_types: {
      event: { signal_half_life_hours: 4, read_half_life_hours: 168 },
      analysis: { signal_half_life_hours: 240, read_half_life_hours: 720 },
      press: { signal_half_life_hours: 6, read_half_life_hours: 168 },
    },
  };
}

function pinRule(overrides: Partial<OverrideRule> = {}): OverrideRule {
  return {
    id: 'test-pin',
    label: 'Test Pin',
    kind: 'source_match',
    source_id: 'pin-source',
    recency_bound_days: 3650,
    applies_to: ['signal'],
    priority: 10,
    enabled: true,
    ...overrides,
  } as OverrideRule;
}

function testOverridesConfig(rules: OverrideRule[] = [pinRule()]): OverridesConfig {
  return { overrides: rules };
}

// ---------------------------------------------------------------------------
// Item + score fixtures
// ---------------------------------------------------------------------------

let urlCounter = 0;
function baseItem(overrides: Partial<NewItem> = {}): NewItem {
  urlCounter += 1;
  const url = `https://example.test/feed-fixture-${urlCounter}`;
  return {
    url,
    canonicalUrl: url,
    title: `Fixture item ${urlCounter}`,
    sourceId: 'plain-source',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    publishedAt: '2026-08-14T00:00:00.000Z',
    fetchedAt: '2026-08-14T00:00:00.000Z',
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

/** Writes an item_scores row directly, bypassing the mechanical scorer, for exact control over the raw (decay-invariant) numbers a test needs. */
function insertScoreRow(
  db: Db,
  itemId: string,
  beat: string,
  signalScore: number,
  readScore: number,
  computedAt: string,
  scorerVersion = 'test-v1',
): void {
  db.prepare(
    `insert into item_scores (score_id, item_id, beat, signal_score, read_score, scorer_version, computed_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), itemId, beat, signalScore, readScore, scorerVersion, computedAt);
}

// ---------------------------------------------------------------------------
// Test server
// ---------------------------------------------------------------------------

function buildTestServer(db: Db, depsOverrides: Partial<FeedDeps> = {}): FastifyInstance {
  const server = Fastify({ logger: false });
  registerAuth(server, TOKEN);
  registerFeed(server, {
    db,
    decayConfig: testDecayConfig(),
    overridesConfig: testOverridesConfig(),
    ...depsOverrides,
  });
  return server;
}

function authed(url: string) {
  return { method: 'GET' as const, url, headers: { authorization: `Bearer ${TOKEN}` } };
}

const T0 = '2026-08-14T00:00:00.000Z';

// ---------------------------------------------------------------------------
// 1. Decay is applied server-side, at read time -- and this test would fail
//    if it weren't.
// ---------------------------------------------------------------------------

describe('decay is applied server-side, at the request now', () => {
  it('returns a decayed score that differs from the raw stored value, matching computeDecayFactor exactly', async () => {
    const db = migratedDb();
    // Published 72h before now; cyber signal half-life is 6h -- 12 full
    // half-lives, factor = 0.5^12 = 1/4096, nowhere near 1.
    const publishedAt = '2026-08-11T00:00:00.000Z'; // T0 - 72h
    const item = insertItem(db, baseItem({ beats: ['cyber'], publishedAt, fetchedAt: publishedAt }));
    insertScoreRow(db, item.item_id, 'cyber', 10, 5, publishedAt);

    const server = buildTestServer(db);
    const res = await server.inject(authed(`/feed?beat=cyber&now=${T0}`));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);

    const decayConfig = testDecayConfig();
    const decayInput = { publishedAt, firstFetchedAt: publishedAt, beat: 'cyber' as const, itemType: 'analysis' as const };
    const expectedSignal = 10 * computeDecayFactor(decayInput, 'signal', T0, decayConfig);
    const expectedRead = 5 * computeDecayFactor(decayInput, 'read', T0, decayConfig);

    // The load-bearing assertion: NOT the raw stored value. A regression
    // that shipped `score.signalScore` straight through (no decay applied)
    // would return exactly 10 here and fail this line.
    expect(body.items[0].signalScore).not.toBeCloseTo(10, 5);
    expect(body.items[0].signalScore).toBeCloseTo(expectedSignal, 10);
    expect(body.items[0].readScore).toBeCloseTo(expectedRead, 10);
    expect(expectedSignal).toBeCloseTo(10 / 4096, 10); // sanity: 12 half-lives, hand-checkable

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Cursor pagination pins `now` -- proven with a real cross-beat crossover
//    and a simulated clock advance between page requests.
// ---------------------------------------------------------------------------

describe('cursor pagination pins the page-1 now', () => {
  it('a cross-beat ranking crossover between page requests does not corrupt the paged result', async () => {
    // Two beats with very different half-lives (cyber 6h, ai 48h) so that
    // elapsed wall-clock time between two page requests provably CHANGES
    // the correct relative order -- proving this matters, not just
    // asserting it does. At T0, A (cyber) outranks B (ai) by a hair; by
    // T0+5h, B has decayed far less than A and overtakes it. A naive
    // implementation that re-reads the clock for page 2 (ignoring the
    // cursor's pinned now) would, at that point, rank B ahead of A and
    // therefore consider A to be "after B" in its own freshly-recomputed
    // order -- reintroducing A on page 2 as a silent DUPLICATE of page 1.
    const db = migratedDb();
    const decayConfig = testDecayConfig();

    const itemA = insertItem(db, baseItem({ beats: ['cyber'], publishedAt: '2026-08-13T23:00:00.000Z', fetchedAt: '2026-08-13T23:00:00.000Z' })); // age 1h at T0
    const itemB = insertItem(db, baseItem({ beats: ['ai'], publishedAt: '2026-08-13T23:00:00.000Z', fetchedAt: '2026-08-13T23:00:00.000Z' }));
    const itemC = insertItem(db, baseItem({ beats: ['cyber'], publishedAt: '2026-08-13T23:00:00.000Z', fetchedAt: '2026-08-13T23:00:00.000Z' }));
    const itemD = insertItem(db, baseItem({ beats: ['ai'], publishedAt: '2026-08-13T23:00:00.000Z', fetchedAt: '2026-08-13T23:00:00.000Z' }));

    insertScoreRow(db, itemA.item_id, 'cyber', 10, 10, T0);
    insertScoreRow(db, itemB.item_id, 'ai', 9, 9, T0);
    insertScoreRow(db, itemC.item_id, 'cyber', 5, 5, T0);
    insertScoreRow(db, itemD.item_id, 'ai', 1, 1, T0);

    // Sanity-check the crossover is real, independent of the endpoint.
    const inputFor = (beat: 'cyber' | 'ai') => ({ publishedAt: '2026-08-13T23:00:00.000Z', firstFetchedAt: '2026-08-13T23:00:00.000Z', beat, itemType: 'analysis' as const });
    const T5 = '2026-08-14T05:00:00.000Z';
    const aAtT0 = 10 * computeDecayFactor(inputFor('cyber'), 'signal', T0, decayConfig);
    const bAtT0 = 9 * computeDecayFactor(inputFor('ai'), 'signal', T0, decayConfig);
    const aAtT5 = 10 * computeDecayFactor(inputFor('cyber'), 'signal', T5, decayConfig);
    const bAtT5 = 9 * computeDecayFactor(inputFor('ai'), 'signal', T5, decayConfig);
    expect(aAtT0).toBeGreaterThan(bAtT0); // at T0: A ranks above B
    expect(bAtT5).toBeGreaterThan(aAtT5); // at T0+5h: B has overtaken A

    let clock = T0;
    const server = buildTestServer(db, { now: () => clock });

    const page1 = await server.inject(authed('/feed?limit=2'));
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json();
    expect(page1Body.items.map((i: { itemKey: string }) => i.itemKey)).toEqual([itemA.item_key, itemB.item_key]);
    expect(page1Body.now).toBe(T0);
    expect(page1Body.nextCursor).toBeTruthy();

    // Simulate elapsed wall-clock time BEFORE the page-2 request fires.
    clock = T5;

    const page2 = await server.inject(authed(`/feed?limit=2&cursor=${encodeURIComponent(page1Body.nextCursor)}`));
    expect(page2.statusCode).toBe(200);
    const page2Body = page2.json();

    // The cursor's own `now` is honored, not the server's current clock.
    expect(page2Body.now).toBe(T0);
    const page2Keys = page2Body.items.map((i: { itemKey: string }) => i.itemKey);
    expect(page2Keys).toEqual([itemC.item_key, itemD.item_key]);
    // The discriminating assertion: A must NOT reappear, which is exactly
    // what an unpinned (naive) implementation would produce once B
    // overtook A at the server's current time.
    expect(page2Keys).not.toContain(itemA.item_key);

    // Whole-corpus stability: two pages concatenated equal one unpaginated
    // fetch at the pinned T0, with no duplicates and no gaps.
    clock = T0;
    const full = await server.inject(authed('/feed?limit=10'));
    const fullKeys = full.json().items.map((i: { itemKey: string }) => i.itemKey);
    expect([...page1Body.items.map((i: { itemKey: string }) => i.itemKey), ...page2Keys]).toEqual(fullKeys);

    await server.close();
  });

  it('cursor mismatch with an explicit conflicting beat fails loudly rather than silently picking one', async () => {
    const db = migratedDb();
    const server = buildTestServer(db, { now: () => T0 });

    const itemA = insertItem(db, baseItem({ beats: ['cyber'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, itemA.item_id, 'cyber', 10, 10, T0);
    const itemB = insertItem(db, baseItem({ beats: ['cyber'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, itemB.item_id, 'cyber', 5, 5, T0);

    const p1 = await server.inject(authed('/feed?beat=cyber&limit=1'));
    const cursor = p1.json().nextCursor;
    expect(cursor).toBeTruthy();

    const mismatched = await server.inject(authed(`/feed?beat=ai&cursor=${encodeURIComponent(cursor)}`));
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error).toBe('cursor_mismatch');

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 2b. Both scores, never blended -- profile only decides SORT, both numbers
//     always ship, and a signal-only override never pins on the read profile.
// ---------------------------------------------------------------------------

describe('two scores, never blended', () => {
  it('profile=read sorts by readScore and ignores a signal-only override; both scores are always present', async () => {
    const db = migratedDb();
    // Signal-only pin rule (config/overrides.yaml's real shape: every
    // shipped rule is applies_to: [signal]) -- pinned on signal, not on read.
    const pinned = insertItem(db, baseItem({ sourceId: 'pin-source', beats: ['cyber'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, pinned.item_id, 'cyber', 1, 1, T0); // low on both
    const other = insertItem(db, baseItem({ sourceId: 'plain-source', beats: ['cyber'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, other.item_id, 'cyber', 50, 50, T0); // high on both

    const server = buildTestServer(db);

    const signalRes = await server.inject(authed(`/feed?beat=cyber&profile=signal&now=${T0}`));
    const signalBody = signalRes.json();
    expect(signalBody.profile).toBe('signal');
    expect(signalBody.items.map((i: { itemKey: string }) => i.itemKey)).toEqual([pinned.item_key, other.item_key]);
    // Both scores always present, even though this response is sorted by signal.
    for (const row of signalBody.items) {
      expect(typeof row.signalScore).toBe('number');
      expect(typeof row.readScore).toBe('number');
      expect(row.sortProfile).toBe('signal');
    }

    const readRes = await server.inject(authed(`/feed?beat=cyber&profile=read&now=${T0}`));
    const readBody = readRes.json();
    expect(readBody.profile).toBe('read');
    // No pin on the read profile (signal-only rule) -- pure score order instead.
    expect(readBody.items.map((i: { itemKey: string }) => i.itemKey)).toEqual([other.item_key, pinned.item_key]);
    expect(readBody.items[0].override.read.pinned).toBe(false);
    expect(readBody.items[0].override.signal.pinned).toBe(false); // 'other' never matched the pin rule at all
    const pinnedRow = readBody.items.find((i: { itemKey: string }) => i.itemKey === pinned.item_key);
    expect(pinnedRow.override.signal.pinned).toBe(true); // still true -- override info is unconditional, not hidden by sort choice
    expect(pinnedRow.override.read.pinned).toBe(false);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Ordering: (pinned, score, item_key) -- pinning is a separate axis, and
//    ties are broken by a TOTAL key.
// ---------------------------------------------------------------------------

describe('ordering: pinned first regardless of score, then score, then item_key as a total tiebreak', () => {
  it('a pinned item with decayed score 0 ranks ABOVE a high-scoring unpinned item', async () => {
    const db = migratedDb();
    const pinned = insertItem(db, baseItem({ sourceId: 'pin-source', beats: ['cyber'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, pinned.item_id, 'cyber', 0, 0, T0); // raw score exactly 0 -- decayed is 0 regardless of factor
    const unpinned = insertItem(db, baseItem({ sourceId: 'plain-source', beats: ['cyber'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, unpinned.item_id, 'cyber', 100, 100, T0);

    const server = buildTestServer(db);
    const res = await server.inject(authed(`/feed?beat=cyber&now=${T0}`));
    const body = res.json();

    expect(body.items.map((i: { itemKey: string }) => i.itemKey)).toEqual([pinned.item_key, unpinned.item_key]);
    expect(body.items[0].signalScore).toBe(0);
    expect(body.items[0].override.signal.pinned).toBe(true);
    expect(body.items[0].override.signal.label).toBe('Test Pin');
    expect(body.items[1].override.signal.pinned).toBe(false);

    await server.close();
  });

  it('exact score ties are broken by item_key descending -- a real total order, not an arbitrary one', async () => {
    const db = migratedDb();
    // Identical beat, publishedAt, and raw score -> identical decayed score.
    const x = insertItem(db, baseItem({ beats: ['cyber'], publishedAt: T0, fetchedAt: T0, url: 'https://example.test/tie-x', canonicalUrl: 'https://example.test/tie-x' }));
    const y = insertItem(db, baseItem({ beats: ['cyber'], publishedAt: T0, fetchedAt: T0, url: 'https://example.test/tie-y', canonicalUrl: 'https://example.test/tie-y' }));
    insertScoreRow(db, x.item_id, 'cyber', 7, 7, T0);
    insertScoreRow(db, y.item_id, 'cyber', 7, 7, T0);

    expect(x.item_key).not.toBe(y.item_key);
    const expectedFirst = x.item_key > y.item_key ? x.item_key : y.item_key;
    const expectedSecond = x.item_key > y.item_key ? y.item_key : x.item_key;

    const server = buildTestServer(db);
    const res = await server.inject(authed(`/feed?beat=cyber&now=${T0}`));
    const body = res.json();

    expect(body.items[0].signalScore).toBe(body.items[1].signalScore); // genuinely tied
    expect(body.items.map((i: { itemKey: string }) => i.itemKey)).toEqual([expectedFirst, expectedSecond]);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Dismissed items never come back; saved/read items still appear.
// ---------------------------------------------------------------------------

describe('item state: dismissed excluded, saved/read still shown', () => {
  it('excludes a dismissed item and includes read/saved state for the rest', async () => {
    const db = migratedDb();
    const kept = insertItem(db, baseItem({ beats: ['usnews'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, kept.item_id, 'usnews', 5, 5, T0);
    const dismissed = insertItem(db, baseItem({ beats: ['usnews'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, dismissed.item_id, 'usnews', 9, 9, T0);

    markItemRead(db, kept.item_key, T0);
    saveItem(db, kept.item_key, T0);
    dismissItem(db, dismissed.item_key, T0);

    const server = buildTestServer(db);
    const res = await server.inject(authed(`/feed?beat=usnews&now=${T0}`));
    const body = res.json();

    const keys = body.items.map((i: { itemKey: string }) => i.itemKey);
    expect(keys).not.toContain(dismissed.item_key);
    expect(keys).toEqual([kept.item_key]);
    expect(body.items[0].state).toEqual({ readAt: T0, savedAt: T0, dismissedAt: null });
    // Every returned row's dismissedAt is null by construction (module doc
    // comment) -- checked directly, not just inferred from absence.
    for (const row of body.items) expect(row.state.dismissedAt).toBeNull();

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Beat filter: merged vs. per-beat, and the cross-listed representative-
//    beat decision.
// ---------------------------------------------------------------------------

describe('beat filter: one endpoint, merged by default, filterable to one beat', () => {
  it('merged view interleaves items from multiple beats; a beat filter restricts to one', async () => {
    const db = migratedDb();
    const cyberItem = insertItem(db, baseItem({ beats: ['cyber'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, cyberItem.item_id, 'cyber', 5, 5, T0);
    const aiItem = insertItem(db, baseItem({ beats: ['ai'], publishedAt: T0, fetchedAt: T0 }));
    insertScoreRow(db, aiItem.item_id, 'ai', 5, 5, T0);

    const server = buildTestServer(db);

    const merged = await server.inject(authed(`/feed?now=${T0}`));
    const mergedKeys = merged.json().items.map((i: { itemKey: string }) => i.itemKey);
    expect(mergedKeys).toEqual(expect.arrayContaining([cyberItem.item_key, aiItem.item_key]));
    expect(merged.json().beat).toBeNull();

    const cyberOnly = await server.inject(authed(`/feed?beat=cyber&now=${T0}`));
    const cyberKeys = cyberOnly.json().items.map((i: { itemKey: string }) => i.itemKey);
    expect(cyberKeys).toEqual([cyberItem.item_key]);
    expect(cyberOnly.json().beat).toBe('cyber');

    await server.close();
  });

  it('a cross-listed item picks the beat that gives it the best decayed score as its representativeBeat, and both beat tags still show', async () => {
    const db = migratedDb();
    // Cross-listed in ai + aisec, mirroring the real arXiv cs.AI/cs.CR shape.
    const item = insertItem(db, baseItem({ beats: ['ai', 'aisec'], publishedAt: '2026-08-13T16:00:00.000Z', fetchedAt: '2026-08-13T16:00:00.000Z' })); // age 8h at T0
    // Identical raw scores; aisec's 8h half-life vs ai's 48h half-life means
    // at exactly 8h of age, aisec has decayed a full half-life (factor 0.5)
    // while ai has barely moved -- ai wins decisively.
    insertScoreRow(db, item.item_id, 'ai', 10, 10, T0);
    insertScoreRow(db, item.item_id, 'aisec', 10, 10, T0);

    const server = buildTestServer(db);
    const merged = await server.inject(authed(`/feed?now=${T0}`));
    const row = merged.json().items.find((i: { itemKey: string }) => i.itemKey === item.item_key);
    expect(row).toBeDefined();
    expect(row.representativeBeat).toBe('ai');
    expect(row.beats).toEqual(['ai', 'aisec']);

    // Filtered to aisec specifically, the SAME item still appears, scored
    // against aisec's own (faster) decay rate.
    const aisecOnly = await server.inject(authed(`/feed?beat=aisec&now=${T0}`));
    const aisecRow = aisecOnly.json().items.find((i: { itemKey: string }) => i.itemKey === item.item_key);
    expect(aisecRow).toBeDefined();
    expect(aisecRow.representativeBeat).toBe('aisec');
    expect(aisecRow.signalScore).toBeLessThan(row.signalScore); // aisec's faster decay produces the smaller number

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Zod validation: hostile/absent params.
// ---------------------------------------------------------------------------

describe('query validation', () => {
  it('works with no params at all (merged, defaults)', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject(authed('/feed'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.beat).toBeNull();
    expect(body.profile).toBe('signal');
    await server.close();
  });

  it('rejects an unknown beat', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject(authed('/feed?beat=sports'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
    await server.close();
  });

  it('rejects an unknown profile', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject(authed('/feed?profile=vibes'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
    await server.close();
  });

  it('rejects a negative limit', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject(authed('/feed?limit=-5'));
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('rejects a non-numeric limit', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject(authed('/feed?limit=lots'));
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('rejects a limit above the max', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject(authed('/feed?limit=999'));
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('rejects an unknown query key', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject(authed('/feed?foo=bar'));
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('rejects a malformed now', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject(authed('/feed?now=2026-08-14'));
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('rejects a garbage cursor rather than crashing', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject(authed('/feed?cursor=not-a-real-cursor'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_cursor');
    await server.close();
  });

  it('is protected by the shared bearer-auth hook by default', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);
    const res = await server.inject({ method: 'GET', url: '/feed' });
    expect(res.statusCode).toBe(401);
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 7. Real corpus (data/wf.db, 4,135 scored items) -- copied read-only via
//    VACUUM INTO, never mutated. Proves the endpoint behaves on real data,
//    including the "pinned at signal ~0.000" case the M3 brief calls out.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The row carries what §7's item row actually needs to render.
// ---------------------------------------------------------------------------

describe("§7's row needs a link and an excerpt, so the wire carries both", () => {
  it('returns canonicalUrl and summary, which `o` (open in new tab) and expand-in-place require', async () => {
    const db = migratedDb();
    const publishedAt = '2026-08-13T00:00:00.000Z';
    const item = insertItem(
      db,
      baseItem({
        beats: ['cyber'],
        publishedAt,
        fetchedAt: publishedAt,
        summaryRaw: 'A short excerpt, already capped at ~300 chars when stored.',
      }),
    );
    insertScoreRow(db, item.item_id, 'cyber', 10, 5, publishedAt);

    const server = buildTestServer(db);
    const res = await server.inject(authed(`/feed?beat=cyber&now=${T0}`));
    expect(res.statusCode).toBe(200);
    const row = res.json().items[0];

    // Both were absent from the original wire shape. §7's `o` action cannot
    // be implemented without a link, and "expands in place for the
    // excerpt/summary" has nothing to expand into without the excerpt --
    // and §7.1 forbids the frontend deriving either. Regressions here are
    // silent: the UI simply renders a row that cannot be opened or expanded.
    expect(row.canonicalUrl).toBe(item.canonicalUrl);
    expect(row.summary).toBe('A short excerpt, already capped at ~300 chars when stored.');
  });

  it('passes a null summary through as null rather than omitting the field', async () => {
    const db = migratedDb();
    const publishedAt = '2026-08-13T00:00:00.000Z';
    const item = insertItem(
      db,
      baseItem({ beats: ['cyber'], publishedAt, fetchedAt: publishedAt, summaryRaw: null }),
    );
    insertScoreRow(db, item.item_id, 'cyber', 10, 5, publishedAt);

    const server = buildTestServer(db);
    const res = await server.inject(authed(`/feed?beat=cyber&now=${T0}`));
    const row = res.json().items[0];

    // Absence and emptiness differ: a source with no excerpt is not a source
    // whose excerpt failed to load. The frontend renders those differently.
    expect(row).toHaveProperty('summary');
    expect(row.summary).toBeNull();
  });
});

describe('real corpus (data/wf.db)', () => {
  it('runs against the real 4,135-item corpus, and a pinned KEV entry can display signal 0.000 while still ranking first among its cyber peers', () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'wf-feed-corpus-'));
    const scratchPath = join(scratchDir, 'wf-copy.db');
    const sourceDb = join(process.cwd(), 'data', 'wf.db');
    // Snapshot via VACUUM INTO, which reads the source and writes only the
    // new file — data/wf.db's contents are never altered, and runMigrations
    // is never called against it (the constraints this test was written to).
    //
    // Deliberately NOT `-readonly`, despite that reading like the safer flag.
    // The database is in WAL mode, and a WAL-mode database with an
    // un-checkpointed WAL cannot be opened read-only at all: recovery needs
    // write access, so sqlite3 fails with "unable to open database file (14)".
    // A hot WAL is the *normal* state after any `npm run ingest` or
    // `npm run score`, so `-readonly` made this test pass on a freshly
    // checkpointed database and fail for anyone who had actually run the app
    // — an environment dependency the test does not control, which is worse
    // than the write it was trying to avoid. Verified both directions:
    // `-readonly` errors with a hot WAL and succeeds after
    // `PRAGMA wal_checkpoint(TRUNCATE)`.
    execFileSync('sqlite3', [sourceDb, `VACUUM INTO '${scratchPath}'`]);

    const db = openDb(scratchPath);
    open.push(db);

    const decayConfig = loadDecayConfig(join(process.cwd(), 'config', 'decay.yaml'));
    const overridesConfig = loadOverridesConfig(join(process.cwd(), 'config', 'overrides.yaml'));
    // Loaded to confirm the real scoring config is at least parseable in
    // this context; not otherwise used (scores are already stored).
    loadMechanicalScoreConfig(join(process.cwd(), 'config', 'scoring.yaml'));

    const server = Fastify({ logger: false });
    registerAuth(server, TOKEN);
    registerFeed(server, { db, decayConfig, overridesConfig });

    // Derived from the corpus rather than hardcoded. This was
    // `'2026-08-14T18:00:00.000Z'` ("a few hours after the real ingest"),
    // which silently encoded *when the corpus happened to be built*: scores
    // are read as-of `now`, so rebuilding `data/wf.db` any time after 18:00Z
    // made every score invisible and the feed correctly returned zero items.
    // That is a real property of as-of reads, not a bug — but a test that
    // breaks whenever the corpus is regenerated is testing the clock. Taking
    // the newest `computed_at` guarantees the stored scores are visible
    // regardless of when the rebuild ran.
    const scoredAt = db
      .prepare('select max(computed_at) as latest from item_scores')
      .get() as { latest: string | null };
    const now = scoredAt.latest ?? '2026-08-14T18:00:00.000Z';

    return (async () => {
      const start = performance.now();
      const res = await server.inject(authed(`/feed?beat=cyber&now=${now}&limit=50`));
      const elapsedMs = performance.now() - start;
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.total).toBeGreaterThan(0);
      console.log(`[feed.test] real-corpus /feed?beat=cyber took ${elapsedMs.toFixed(1)}ms for ${body.total} candidates`);

      const pinnedRows = body.items.filter((i: { override: { signal: { pinned: boolean } } }) => i.override.signal.pinned);
      expect(pinnedRows.length).toBeGreaterThan(0);
      // Every pinned row outranks every non-pinned row on this page.
      const firstUnpinnedIdx = body.items.findIndex((i: { override: { signal: { pinned: boolean } } }) => !i.override.signal.pinned);
      if (firstUnpinnedIdx >= 0) {
        for (let i = 0; i < firstUnpinnedIdx; i++) expect(body.items[i].override.signal.pinned).toBe(true);
      }

      // At least one pinned row whose displayed signal rounds to 0.000 --
      // the case the M3 brief specifically calls out ("does a KEV pin read
      // as pinned even though its score is 0.000?").
      const zeroSignalPinned = pinnedRows.filter((i: { signalScore: number }) => i.signalScore.toFixed(3) === '0.000');
      console.log(`[feed.test] pinned cyber rows: ${pinnedRows.length}, rounding to 0.000: ${zeroSignalPinned.length}`);
      expect(zeroSignalPinned.length).toBeGreaterThan(0);

      // Full merged run too, timed, to have a real cost number for the report.
      const mergedStart = performance.now();
      const merged = await server.inject(authed(`/feed?now=${now}&limit=50`));
      const mergedElapsedMs = performance.now() - mergedStart;
      expect(merged.statusCode).toBe(200);
      console.log(`[feed.test] real-corpus merged /feed took ${mergedElapsedMs.toFixed(1)}ms for ${merged.json().total} candidates`);

      await server.close();
    })();
  }, 60_000);
});

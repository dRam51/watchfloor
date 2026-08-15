import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type Beat, type NewItem } from '../../src/domain/item.ts';
import { loadSourcesFile } from '../../src/sources/load.ts';
import { loadRankDepsFromConfigFiles } from '../../src/score/rank.ts';
import { createOllamaBackend } from '../../src/enrich/llm/ollama.ts';
import type { LlmConfig } from '../../src/enrich/llm/config.ts';
import type { EnrichmentPolicy } from '../../src/enrich/ceiling.ts';
import { recordLlmCall } from '../../src/db/llmCallLog.ts';
import { createFixtureVault, digestTree, listTree } from './fixture.ts';
import { openVaultSession } from '../../src/vault/session.ts';
import { isWatchfloorManaged } from '../../src/vault/frontmatter.ts';
import { syncWeeklyNote, weeklyNoteInstant, type WeeklySyncDeps } from '../../src/vault/weekly.ts';

/**
 * The whole pass, end to end: select → blurb → render → write.
 *
 * **No mocks.** A real temp-file SQLite database with real corpus rows, a real
 * fixture vault carrying the owner's twelve real hand-authored filenames, and
 * a real local HTTP server answering with **bodies captured from this
 * machine's Ollama daemon on 2026-08-15** — the same pattern
 * `tests/enrich/cached.test.ts` uses, and for the same reason: a test that
 * needs a model running is a test that fails on a laptop with the daemon shut.
 *
 * The captured answers are in `tests/fixtures/weekly/`, one file per
 * (item, model, question), and they are what the real prompts in
 * `src/vault/weekly.ts` actually produced.
 */

const openDbs: Array<ReturnType<typeof openDb>> = [];
const openServers: Server[] = [];

afterEach(async () => {
  while (openDbs.length) closeDb(openDbs.pop()!);
  while (openServers.length) {
    const server = openServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  openDbs.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

const MODEL = 'llama3.1:8b';
const MODEL_SLUG = 'llama318b';
const NOW = '2026-08-15T22:00:00.000Z';
const TZ = 'UTC';

interface CorpusFixture {
  sourceId: string;
  title: string;
  url: string;
  publishedAt: string;
  summaryRaw: string | null;
  rawJson: string;
}

function corpus(name: string): CorpusFixture {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'tests', 'fixtures', 'corpus', `${name}.json`), 'utf8'),
  ) as CorpusFixture;
}

function captured(name: string, question: 'argues' | 'worth'): string {
  return readFileSync(
    join(process.cwd(), 'tests', 'fixtures', 'weekly', `${name}-${MODEL_SLUG}-${question}.json`),
    'utf8',
  );
}

/**
 * Answers whichever question the request is actually asking, by looking at the
 * system message the module sent. That is the only way a canned server can
 * stay honest about a two-call design: if both calls were answered with one
 * body, a bug that asked the same question twice would pass.
 */
async function ollamaServing(
  bodies: ReadonlyMap<string, { argues: string; worth: string }>,
  onRequest?: () => void,
): Promise<{ baseUrl: string; requests: () => number }> {
  let count = 0;
  const handler: RequestListener = (req, res) => {
    count += 1;
    onRequest?.();
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(raw) as {
        messages: Array<{ role: string; content: string }>;
      };
      const system = parsed.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
      const question = /pay off for/.test(system) ? 'worth' : 'argues';
      const match = [...bodies.entries()].find(([name]) => user.includes(corpus(name).title));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(match ? match[1][question] : JSON.stringify({ error: 'no fixture' }));
    });
  };
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests: () => count };
}

/** An address nothing is listening on. Ollama not running, honestly. */
async function deadAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return url;
}

function llmConfig(baseUrl: string): LlmConfig {
  return {
    backend: 'ollama',
    limits: {
      timeoutMs: 5000,
      maxPromptChars: 24000,
      maxResponseBytes: 1048576,
      maxOutputTokens: 512,
    },
    ollama: { baseUrl, model: MODEL, temperature: 0, keepAlive: '5m' },
  } as LlmConfig;
}

function policy(dailyTokens = 250000): EnrichmentPolicy {
  return {
    ceiling: { dailyTokens, unmeteredCallTokens: 6500 },
    cache: { version: 1 },
  };
}

function insertCorpusItem(
  db: ReturnType<typeof openDb>,
  name: string,
  overrides: Partial<NewItem> = {},
): { itemKey: string; itemId: string } {
  const fixture = corpus(name);
  const item = insertItem(db, {
    url: fixture.url,
    canonicalUrl: fixture.url,
    title: fixture.title,
    sourceId: fixture.sourceId,
    itemType: 'analysis',
    beats: ['ai'],
    entities: [],
    publishedAt: fixture.publishedAt,
    fetchedAt: '2026-08-14T18:38:50.262Z',
    summaryRaw: fixture.summaryRaw,
    rawJson: fixture.rawJson,
    ...overrides,
  } as NewItem);
  return { itemKey: item.item_key, itemId: item.item_id };
}

function score(
  db: ReturnType<typeof openDb>,
  itemId: string,
  beat: Beat,
  readScore: number,
): void {
  db.prepare(
    `insert into item_scores (score_id, item_id, beat, signal_score, read_score, scorer_version, computed_at)
     values (?,?,?,?,?,?,?)`,
  ).run(randomUUID(), itemId, beat, 1, readScore, 'test-v0', '2026-08-14T19:00:00.000Z');
}

function deps(
  db: ReturnType<typeof openDb>,
  baseUrl: string,
  enrichmentPolicy = policy(),
): WeeklySyncDeps {
  const sources = loadSourcesFile(join(process.cwd(), 'config', 'sources.yaml'));
  const config = llmConfig(baseUrl);
  return {
    rank: loadRankDepsFromConfigFiles(
      join(process.cwd(), 'config', 'decay.yaml'),
      join(process.cwd(), 'config', 'overrides.yaml'),
    ),
    sourceKinds: new Map(sources.map((source) => [source.id, source.kind ?? null])),
    enrichment: {
      db,
      backend: createOllamaBackend(config),
      defaults: { maxOutputTokens: 512, temperature: 0 },
      policy: enrichmentPolicy,
      tz: TZ,
    },
  };
}

const BODIES = new Map([
  ['krebs-tracking', { argues: captured('krebs-tracking', 'argues'), worth: captured('krebs-tracking', 'worth') }],
  ['arxiv-car', { argues: captured('arxiv-car', 'argues'), worth: captured('arxiv-car', 'worth') }],
  ['talos-jwr', { argues: captured('talos-jwr', 'argues'), worth: captured('talos-jwr', 'worth') }],
]);

function seedWeek(db: ReturnType<typeof openDb>): void {
  const krebs = insertCorpusItem(db, 'krebs-tracking', { beats: ['cyber'] });
  score(db, krebs.itemId, 'cyber', 6);
  const arxiv = insertCorpusItem(db, 'arxiv-car', { beats: ['ai'] });
  score(db, arxiv.itemId, 'ai', 4);
}

function noteText(root: string, relPath: string): string {
  // Read back through the same digest helper the vault fixture uses, so the
  // test reads bytes rather than what it believes it wrote.
  return readFileSync(join(root, relPath), 'utf8');
}

describe('syncWeeklyNote — the artifact', () => {
  it('writes §8.1s weekly/YYYY-[Www].md through the vault session', async () => {
    const db = migratedDb();
    seedWeek(db);
    const { baseUrl } = await ollamaServing(BODIES);
    const vault = createFixtureVault();
    const session = openVaultSession(vault.root);

    const result = await syncWeeklyNote(session, deps(db, baseUrl), { now: NOW });

    expect(result.relPath).toBe('weekly/2026-W33.md');
    expect(result.write.created).toBe(true);
    expect(isWatchfloorManaged(noteText(vault.root, result.relPath))).toBe(true);
  });

  it('carries all three of §8.1s parts for a piece we hold the text of', async () => {
    const db = migratedDb();
    seedWeek(db);
    const { baseUrl } = await ollamaServing(BODIES);
    const vault = createFixtureVault();
    const session = openVaultSession(vault.root);

    const result = await syncWeeklyNote(session, deps(db, baseUrl), { now: NOW });
    const text = noteText(vault.root, result.relPath);

    // 1. What it argues -- verbatim from the live capture.
    expect(text).toContain('DecryptAds is a free service that aggregates');
    // 2. Why it is worth the time -- a different sentence, from a second call.
    expect(text).toContain('For anyone running a website or app that serves ads');
    // 3. An estimated read time, with what it was counted from.
    expect(text).toMatch(/12 min/);
    expect(text).toMatch(/2444 words of article text this feed carries, at 200 wpm/);
  });

  it('asks each question once per item, not one question twice', async () => {
    const db = migratedDb();
    seedWeek(db);
    const { baseUrl, requests } = await ollamaServing(BODIES);
    const vault = createFixtureVault();

    await syncWeeklyNote(openVaultSession(vault.root), deps(db, baseUrl), { now: NOW });
    expect(requests()).toBe(4); // two items x two questions
  });

  it('says the read time is unknown rather than inventing one', async () => {
    const db = migratedDb();
    const arxiv = insertCorpusItem(db, 'arxiv-car', { beats: ['ai'] });
    score(db, arxiv.itemId, 'ai', 4);
    const { baseUrl } = await ollamaServing(BODIES);
    const vault = createFixtureVault();

    const result = await syncWeeklyNote(openVaultSession(vault.root), deps(db, baseUrl), {
      now: NOW,
    });
    const text = noteText(vault.root, result.relPath);
    expect(text).toMatch(/read time unknown/i);
    expect(text).toMatch(/no article text to count/i);
  });

  it('lists a headline-only item without a blurb, and says why', async () => {
    const db = migratedDb();
    seedWeek(db);
    const wire = insertItem(db, {
      url: 'https://apnews.com/article/michigan',
      canonicalUrl: 'https://apnews.com/article/michigan',
      title: '5 killed and suspect dead in incident in Michigan',
      sourceId: 'ap-news',
      itemType: 'analysis',
      beats: ['usnews'],
      entities: [],
      publishedAt: '2026-08-14T23:17:21.000Z',
      fetchedAt: '2026-08-14T18:38:50.262Z',
      summaryRaw: null,
      rawJson: '{}',
    });
    score(db, wire.item_id, 'usnews', 9);
    const { baseUrl, requests } = await ollamaServing(BODIES);
    const vault = createFixtureVault();

    const result = await syncWeeklyNote(openVaultSession(vault.root), deps(db, baseUrl), {
      now: NOW,
    });
    const text = noteText(vault.root, result.relPath);

    expect(text).toContain('5 killed and suspect dead in incident in Michigan');
    expect(text).toMatch(/only a headline/i);
    // And no model call was made about it: nothing to ask.
    expect(requests()).toBe(4);
  });
});

describe('syncWeeklyNote — the note is a function of (corpus, week, zone)', () => {
  it('every canonical timestamp in the note is the week s own as-of instant', async () => {
    const db = migratedDb();
    seedWeek(db);
    const { baseUrl } = await ollamaServing(BODIES);
    const vault = createFixtureVault();

    const result = await syncWeeklyNote(openVaultSession(vault.root), deps(db, baseUrl), {
      now: NOW,
    });
    const text = noteText(vault.root, result.relPath);
    const asOf = weeklyNoteInstant(result.week, TZ);

    const stamps = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) ?? [];
    expect(stamps.length).toBeGreaterThan(0);
    // Catches any stray clock read anywhere in the render path, including one
    // added later by somebody else.
    for (const stamp of stamps) expect(stamp).toBe(asOf);
    expect(result.generatedAt).toBe(asOf);
  });

  it('reproduces byte-identically on a second run — with the model DOWN', async () => {
    // The destructive M5 acceptance test, in miniature. The first run pays for
    // the blurbs; the second is served entirely from task 3's content-keyed
    // cache, which is the only thing that can make a sampled model's output
    // reproducible. Pointing the second run at a dead address proves the
    // cache is doing it rather than the daemon happening to agree.
    const db = migratedDb();
    seedWeek(db);
    const { baseUrl } = await ollamaServing(BODIES);
    const vault = createFixtureVault();

    const first = await syncWeeklyNote(openVaultSession(vault.root), deps(db, baseUrl), {
      now: NOW,
    });
    const before = noteText(vault.root, first.relPath);

    const dead = await deadAddress();
    const second = await syncWeeklyNote(openVaultSession(vault.root), deps(db, dead), {
      // A DIFFERENT instant in the same week, as Saturday's re-run would be.
      now: '2026-08-16T09:30:00.000Z',
    });

    expect(second.relPath).toBe(first.relPath);
    expect(noteText(vault.root, second.relPath)).toBe(before);
    expect(second.write.created).toBe(false);
    expect(second.blurbs.fromCache).toBe(4);
    expect(second.blurbs.generated).toBe(0);
  });
});

describe('syncWeeklyNote — when the model cannot answer', () => {
  it('says the daemon was unreachable rather than dropping the item', async () => {
    const db = migratedDb();
    seedWeek(db);
    const dead = await deadAddress();
    const vault = createFixtureVault();

    const result = await syncWeeklyNote(openVaultSession(vault.root), deps(db, dead), {
      now: NOW,
    });
    const text = noteText(vault.root, result.relPath);

    // The items are still there, ranked, with their read times -- only the
    // blurbs are missing, and the note says so.
    expect(text).toContain('Who’s Tracking You?');
    expect(text).toMatch(/no blurb/i);
    expect(text).toMatch(/not_running/);
    expect(result.blurbs.unavailable).toBe(4);
  });

  it('says the token ceiling closed rather than silently omitting the week', async () => {
    const db = migratedDb();
    seedWeek(db);
    // Spend the day's budget before the pass runs, through the real ledger.
    recordLlmCall(db, {
      cacheKey: 'a'.repeat(64),
      task: 'something_else',
      backend: 'ollama',
      model: MODEL,
      serviceId: 'ollama-local',
      status: 'ok',
      inputTokens: 400000,
      outputTokens: 0,
      amountUsd: 0,
      costMeasured: true,
      latencyMs: 10,
      calledAt: NOW,
      tz: TZ,
    });
    const { baseUrl, requests } = await ollamaServing(BODIES);
    const vault = createFixtureVault();

    const result = await syncWeeklyNote(openVaultSession(vault.root), deps(db, baseUrl), {
      now: NOW,
    });
    const text = noteText(vault.root, result.relPath);

    expect(requests()).toBe(0); // §15: nothing sent, nothing deferred
    expect(result.blurbs.refused).toBe(4);
    expect(text).toMatch(/daily token ceiling/i);
    expect(text).toMatch(/config\/enrichment\.yaml/);
  });
});

describe('syncWeeklyNote — the vault', () => {
  it('touches nothing but its own note', async () => {
    const db = migratedDb();
    seedWeek(db);
    const { baseUrl } = await ollamaServing(BODIES);
    const vault = createFixtureVault();
    const before = digestTree(vault.anchor);

    const result = await syncWeeklyNote(openVaultSession(vault.root), deps(db, baseUrl), {
      now: NOW,
    });

    const after = digestTree(vault.anchor);
    for (const [path, digest] of before) {
      expect(after.get(path)).toBe(digest); // every hand-authored note, byte-identical
    }
    const added = listTree(vault.anchor).filter((p) => !before.has(p));
    expect(added).toEqual([join('Watchfloor', result.relPath)]);
  });
});

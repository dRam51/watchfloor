import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { getDailyLlmUsage } from '../../src/db/llmCallLog.ts';
import { getCachedEnrichment, getEnrichmentsForItem } from '../../src/db/llmCache.ts';
import { createOllamaBackend } from '../../src/enrich/llm/ollama.ts';
import type { LlmConfig } from '../../src/enrich/llm/config.ts';
import { enrichmentCacheKey } from '../../src/enrich/cacheKey.ts';
import type { EnrichmentPolicy } from '../../src/enrich/ceiling.ts';
import { completeEnrichment, type EnrichmentDeps } from '../../src/enrich/cached.ts';

// ---------------------------------------------------------------------------
// No mocks. Real temp-file SQLite, and a real local http server serving the
// bodies Task 1 captured live from this machine's Ollama daemon on 2026-08-15
// (tests/fixtures/ollama/). The pattern is tests/enrich/llm/ollama.test.ts's,
// which is tests/fetch/http.test.ts's. Nothing here reaches the network.
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ollama', name), 'utf8');
}

const CHAT_200 = fixture('chat-200.json');

const openServers: Server[] = [];
const openDbs: Array<ReturnType<typeof openDb>> = [];

/** Counts requests as well as answering them -- the count IS the assertion. */
async function serve(handler: RequestListener): Promise<{ baseUrl: string; requests: () => number }> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from an ephemeral TCP listener');
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests: () => count };
}

function respondWith(body: string): RequestListener {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  };
}

/** An address nothing is listening on: bound, then closed before use. */
async function deadAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return url;
}

function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  openDbs.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

afterEach(async () => {
  while (openDbs.length) closeDb(openDbs.pop()!);
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

const NY = 'America/New_York';
const MODEL = 'llama3.2:latest';
const NOW = '2026-08-15T13:00:00.000Z';
const ITEM_KEY = 'a'.repeat(64);

const POLICY: EnrichmentPolicy = {
  ceiling: { dailyTokens: 250_000, unmeteredCallTokens: 6_500 },
  cache: { version: 1 },
};

function llmConfig(baseUrl: string): LlmConfig {
  return {
    backend: 'ollama',
    limits: {
      timeoutMs: 5_000,
      maxPromptChars: 24_000,
      maxResponseBytes: 1_048_576,
      maxOutputTokens: 512,
    },
    ollama: { baseUrl, model: MODEL, temperature: 0 },
  };
}

// The bounds the backend will actually apply. Passed explicitly because
// LlmBackend exposes no configuration, and the cache key must describe what
// goes on the wire -- otherwise lowering max_output_tokens in config would
// leave every existing key matching. Mirrors llmConfig above.
const DEFAULTS = { maxOutputTokens: 512, temperature: 0 };

function deps(
  db: ReturnType<typeof openDb>,
  baseUrl: string,
  policy: EnrichmentPolicy = POLICY,
): EnrichmentDeps {
  return {
    db,
    backend: createOllamaBackend(llmConfig(baseUrl)),
    defaults: DEFAULTS,
    policy,
    tz: NY,
  };
}

// A real headline from the live corpus (ap-news, item_key
// 1f88cd304c7ae28b9570af8a1e8e5d329128b24bc14c76121db351ace4944d59) and the
// headline the SAME item_key carried five hours later. One URL, one key, two
// stories. See src/enrich/cacheKey.ts.
const COLOMBIA_V1 = 'Survivors face the challenge of rebuilding after Colombia quake';
const COLOMBIA_V3 = 'Signs of life emerge under Colombia quake rubble';

function request(prompt: string) {
  return { task: 'summary', prompt, system: 'Summarise in one line.', itemKey: ITEM_KEY };
}

describe('the cache is what keeps a re-run from re-asking', () => {
  it('generates once, then serves the second identical ask without a request', async () => {
    const db = migratedDb();
    const { baseUrl, requests } = await serve(respondWith(CHAT_200));
    const d = deps(db, baseUrl);

    const first = await completeEnrichment(d, request(COLOMBIA_V1), { now: NOW });
    expect(first.status).toBe('ok');
    expect(requests()).toBe(1);

    const second = await completeEnrichment(d, request(COLOMBIA_V1), {
      now: '2026-08-15T14:00:00.000Z',
    });
    expect(second.status).toBe('cached');
    // The whole point: enrichment re-runs constantly over an append-only
    // corpus, so without this the same item is re-enriched on every pass
    // forever.
    expect(requests()).toBe(1);

    if (second.status !== 'cached') throw new Error('unreachable');
    expect(second.text).toBe(
      'A CVE (Common Vulnerability and Exposure) is a standardized identifier for publicly disclosed cybersecurity vulnerabilities in software, hardware, or firmware.',
    );
    expect(second.answeredAt).toBe(NOW);
  });

  it('re-asks when the SAME item comes back with revised content', async () => {
    // The stale-version failure, end to end. Under item_key keying the second
    // call is a hit and the dashboard shows a summary about rebuilding for a
    // story that now says survivors were found alive.
    const db = migratedDb();
    const { baseUrl, requests } = await serve(respondWith(CHAT_200));
    const d = deps(db, baseUrl);

    await completeEnrichment(d, request(COLOMBIA_V1), { now: NOW });
    const revised = await completeEnrichment(d, request(COLOMBIA_V3), {
      now: '2026-08-15T18:00:00.000Z',
    });

    expect(revised.status).toBe('ok');
    expect(requests()).toBe(2);

    // Both answers survive, under different keys, both pointing at the item.
    expect(getEnrichmentsForItem(db, ITEM_KEY)).toHaveLength(2);
  });

  it('logs the generated call and nothing at all for the hit', async () => {
    // A cache hit consumed no tokens and cost nothing, so it is not a ledger
    // event. That is what keeps the daily numbers consumption rather than
    // activity.
    const db = migratedDb();
    const { baseUrl } = await serve(respondWith(CHAT_200));
    const d = deps(db, baseUrl);

    await completeEnrichment(d, request(COLOMBIA_V1), { now: NOW });
    await completeEnrichment(d, request(COLOMBIA_V1), { now: '2026-08-15T14:00:00.000Z' });

    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.calls).toBe(1);
    expect(usage.okCalls).toBe(1);
    // The real counts from the captured fixture: 42 prompt + 27 eval.
    expect(usage.countedTokens).toBe(69);
    // ollama-local is free-forever, so this is a measured zero rather than an
    // unknown -- computeCost's zero-rate branch.
    expect(usage.amountUsd).toBe(0);
    expect(usage.costMeasured).toBe(true);
  });

  it('stores the answer under the content key, with the item as provenance', async () => {
    const db = migratedDb();
    const { baseUrl } = await serve(respondWith(CHAT_200));

    await completeEnrichment(deps(db, baseUrl), request(COLOMBIA_V1), { now: NOW });

    const key = enrichmentCacheKey({
      cacheVersion: 1,
      task: 'summary',
      backend: 'ollama',
      model: MODEL,
      system: 'Summarise in one line.',
      prompt: COLOMBIA_V1,
      maxOutputTokens: 512,
      temperature: 0,
    });
    const row = getCachedEnrichment(db, key);
    expect(row).not.toBeNull();
    expect(row!.itemKey).toBe(ITEM_KEY);
    // The model as requested vs the model that answered -- the floating-tag
    // hole made visible; see src/enrich/cacheKey.ts.
    expect(row!.model).toBe(MODEL);
    expect(row!.resolvedModel).toBe('llama3.2:latest');
  });
});

describe('an unavailable backend is never cached as an answer', () => {
  it('reports unavailable, logs it, and leaves the question unanswered', async () => {
    const db = migratedDb();
    const backend = createOllamaBackend(llmConfig(await deadAddress()));

    const result = await completeEnrichment(
      { db, backend, defaults: DEFAULTS, policy: POLICY, tz: NY },
      request(COLOMBIA_V1),
      { now: NOW },
    );

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('unreachable');
    expect(result.reason).toBe('not_running');

    // Logged, so the outage is visible...
    const usage = getDailyLlmUsage(db, '2026-08-15');
    expect(usage.calls).toBe(1);
    expect(usage.unavailableCalls).toBe(1);
    // ...and charged nothing, so a stopped daemon cannot close the ceiling.
    expect(usage.countedTokens).toBe(0);
    expect(usage.unmeteredOkCalls).toBe(0);

    // ...but NOT stored as an answer. Caching a five-minute outage would make
    // it permanent under an append-only corpus.
    expect(getEnrichmentsForItem(db, ITEM_KEY)).toEqual([]);
  });

  it('answers the question once the backend comes back', async () => {
    const db = migratedDb();
    const dead = await deadAddress();
    const req = request(COLOMBIA_V1);

    await completeEnrichment(
      { db, backend: createOllamaBackend(llmConfig(dead)), defaults: DEFAULTS, policy: POLICY, tz: NY },
      req,
      { now: NOW },
    );

    const { baseUrl } = await serve(respondWith(CHAT_200));
    const recovered = await completeEnrichment(
      { db, backend: createOllamaBackend(llmConfig(baseUrl)), defaults: DEFAULTS, policy: POLICY, tz: NY },
      req,
      { now: '2026-08-15T14:00:00.000Z' },
    );

    expect(recovered.status).toBe('ok');
    expect(getEnrichmentsForItem(db, ITEM_KEY)).toHaveLength(1);
  });
});

describe('at the ceiling it refuses, and says so', () => {
  const TINY: EnrichmentPolicy = {
    ceiling: { dailyTokens: 100, unmeteredCallTokens: 6_500 },
    cache: { version: 1 },
  };

  it('sends no request once the day is spent', async () => {
    const db = migratedDb();
    const { baseUrl, requests } = await serve(respondWith(CHAT_200));
    const d = deps(db, baseUrl, TINY);

    // 69 tokens on the first call, which is under 100.
    const first = await completeEnrichment(d, request(COLOMBIA_V1), { now: NOW });
    expect(first.status).toBe('ok');

    // 69 more would be 138. The second call never leaves the process.
    const second = await completeEnrichment(d, request(COLOMBIA_V3), { now: NOW });
    expect(second.status).toBe('ok');
    expect(requests()).toBe(2);

    const third = await completeEnrichment(
      d,
      request('Army pauses Apache helicopter training missions after crash'),
      { now: NOW },
    );
    expect(third.status).toBe('refused');
    expect(requests()).toBe(2);
  });

  it('names the ceiling as the reason and carries the numbers', async () => {
    const db = migratedDb();
    const { baseUrl } = await serve(respondWith(CHAT_200));
    const d = deps(db, baseUrl, TINY);

    await completeEnrichment(d, request(COLOMBIA_V1), { now: NOW });
    await completeEnrichment(d, request(COLOMBIA_V3), { now: NOW });
    const refused = await completeEnrichment(d, request('a third headline'), { now: NOW });

    expect(refused.status).toBe('refused');
    if (refused.status !== 'refused') throw new Error('unreachable');
    expect(refused.reason).toBe('daily_token_ceiling');
    expect(refused.ceiling.chargedTokens).toBe(138);
    expect(refused.ceiling.ceilingTokens).toBe(100);
    expect(refused.ceiling.day).toBe('2026-08-15');
  });

  it('is distinguishable from "the backend was down" and from a hit', async () => {
    // Three different situations that all produce no fresh text. §15's
    // "hard refusal, never a silent deferred retry" is only meaningful if a
    // caller can tell which one happened.
    const db = migratedDb();
    const { baseUrl } = await serve(respondWith(CHAT_200));

    // The ceiling is a stop LINE, not a reservation: a fresh day is open even
    // under a tiny ceiling, because nothing has been charged yet. So spend
    // past it first -- two calls at 69 tokens each -- and only then refuse.
    const d0 = deps(db, baseUrl, TINY);
    await completeEnrichment(d0, request(COLOMBIA_V1), { now: NOW });
    await completeEnrichment(d0, request(COLOMBIA_V3), { now: NOW });
    const spent = await completeEnrichment(d0, request('a third headline'), { now: NOW });
    expect(spent.status).toBe('refused');

    const down = await completeEnrichment(
      {
        db,
        backend: createOllamaBackend(llmConfig(await deadAddress())),
        defaults: DEFAULTS,
        policy: POLICY,
        tz: NY,
      },
      // A question nothing has answered yet -- otherwise the cache lookup
      // runs first and a down backend still returns `cached`, which is
      // correct behaviour and not what this test is measuring.
      request('Zambia suspends then restarts vote counting'),
      { now: NOW },
    );
    expect(down.status).toBe('unavailable');

    const d = deps(db, baseUrl);
    await completeEnrichment(d, request(COLOMBIA_V1), { now: NOW });
    const hit = await completeEnrichment(d, request(COLOMBIA_V1), { now: NOW });
    expect(hit.status).toBe('cached');

    expect(new Set([spent.status, down.status, hit.status]).size).toBe(3);
  });

  it('writes no ledger row for a refusal -- nothing was consumed', async () => {
    const db = migratedDb();
    const { baseUrl } = await serve(respondWith(CHAT_200));
    const d = deps(db, baseUrl, TINY);

    await completeEnrichment(d, request(COLOMBIA_V1), { now: NOW });
    await completeEnrichment(d, request(COLOMBIA_V3), { now: NOW });
    expect(getDailyLlmUsage(db, '2026-08-15').calls).toBe(2);

    const refused = await completeEnrichment(d, request('a third headline'), { now: NOW });
    expect(refused.status).toBe('refused');
    // Still two. A refusal is not consumption, and logging it would inflate
    // the very number the ceiling reads on the next pass.
    expect(getDailyLlmUsage(db, '2026-08-15').calls).toBe(2);
  });

  it('still serves a CACHED answer with the ceiling shut', async () => {
    // A hit spends nothing, so refusing it would withhold an answer already
    // paid for -- and would make the dashboard go blank at the ceiling rather
    // than merely stop growing.
    const db = migratedDb();
    const { baseUrl } = await serve(respondWith(CHAT_200));

    await completeEnrichment(deps(db, baseUrl), request(COLOMBIA_V1), { now: NOW });

    const shut = {
      ...deps(db, baseUrl),
      policy: { ...POLICY, ceiling: { ...POLICY.ceiling, dailyTokens: 1 } },
    };
    const result = await completeEnrichment(shut, request(COLOMBIA_V1), { now: NOW });
    expect(result.status).toBe('cached');
  });
});

describe('an empty completion is an answer, and it is cached', () => {
  // The captured fixture with its content emptied -- everything else, including
  // the real token counts, is untouched. src/enrich/llm/types.ts is explicit
  // that `''` on the ok branch means "the model had nothing to say".
  const CHAT_200_EMPTY = JSON.stringify({
    ...(JSON.parse(CHAT_200) as Record<string, unknown>),
    message: { role: 'assistant', content: '' },
  });

  it('does not re-ask a question the model already answered with silence', async () => {
    const db = migratedDb();
    const { baseUrl, requests } = await serve(respondWith(CHAT_200_EMPTY));
    const d = deps(db, baseUrl);

    const first = await completeEnrichment(d, request(COLOMBIA_V1), { now: NOW });
    expect(first.status).toBe('ok');

    const second = await completeEnrichment(d, request(COLOMBIA_V1), {
      now: '2026-08-15T14:00:00.000Z',
    });
    expect(second.status).toBe('cached');
    if (second.status !== 'cached') throw new Error('unreachable');
    expect(second.text).toBe('');
    expect(requests()).toBe(1);
  });
});

describe('the result union keeps the branches apart at compile time', () => {
  it('does not let a caller read text or usage without narrowing', async () => {
    const db = migratedDb();
    const { baseUrl } = await serve(respondWith(CHAT_200));
    const result = await completeEnrichment(deps(db, baseUrl), request(COLOMBIA_V1), { now: NOW });

    // Pinned with @ts-expect-error and checked by `npm run typecheck`, the
    // same technique src/enrich/llm/types.ts uses for LlmResult.text: putting
    // `text` on the refused branch, or `usage` on the cached one, makes these
    // directives unused and tsc fails with TS2578.
    // @ts-expect-error -- `text` does not exist on the refused or unavailable branches
    void result.text;
    // @ts-expect-error -- a cache hit consumed nothing, so it reports no usage
    void result.usage;
    // @ts-expect-error -- only the refused branch has a ceiling
    void result.ceiling;

    expect(result.status).toBe('ok');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { InvalidTimestampError } from '../../src/domain/item.ts';
import {
  getCachedEnrichment,
  putCachedEnrichment,
  type EnrichmentAnswer,
} from '../../src/db/llmCache.ts';

// Real temp-file SQLite and the real migration directory -- no mocks, matching
// tests/db/repoSnapshots.ts and tests/db/repoReadmes.ts.
const open: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

const KEY = 'c'.repeat(64);
const OTHER_KEY = 'd'.repeat(64);
const ITEM_KEY = 'a'.repeat(64);

function answer(overrides: Partial<EnrichmentAnswer> = {}): EnrichmentAnswer {
  return {
    cacheKey: KEY,
    task: 'summary',
    backend: 'ollama',
    model: 'llama3.2',
    resolvedModel: 'llama3.2:latest',
    text: 'A standardized identifier for publicly disclosed vulnerabilities.',
    finish: 'stop',
    itemKey: ITEM_KEY,
    answeredAt: '2026-08-15T06:39:56.760Z',
    ...overrides,
  };
}

describe('putCachedEnrichment / getCachedEnrichment', () => {
  it('stores an answer and reads it back whole', () => {
    const db = migratedDb();
    expect(putCachedEnrichment(db, answer())).toEqual({ action: 'inserted' });

    expect(getCachedEnrichment(db, KEY)).toEqual({
      cacheKey: KEY,
      task: 'summary',
      backend: 'ollama',
      model: 'llama3.2',
      resolvedModel: 'llama3.2:latest',
      text: 'A standardized identifier for publicly disclosed vulnerabilities.',
      finish: 'stop',
      itemKey: ITEM_KEY,
      answeredAt: '2026-08-15T06:39:56.760Z',
      firstAnsweredAt: '2026-08-15T06:39:56.760Z',
    });
  });

  it('returns null for a key never answered -- a miss, not an empty answer', () => {
    const db = migratedDb();
    expect(getCachedEnrichment(db, OTHER_KEY)).toBeNull();
  });

  it('stores an EMPTY completion as a real hit', () => {
    // src/enrich/llm/types.ts is explicit that `''` on the ok branch means
    // "the model had nothing to say" and can never mean "we could not ask".
    // The cache has to preserve that: re-asking a question the model already
    // answered with silence would spend a call per pass forever.
    const db = migratedDb();
    putCachedEnrichment(db, answer({ text: '' }));

    const hit = getCachedEnrichment(db, KEY);
    expect(hit).not.toBeNull();
    expect(hit!.text).toBe('');
  });

  it('keeps a truncated answer distinguishable from a complete one', () => {
    const db = migratedDb();
    putCachedEnrichment(db, answer({ finish: 'length' }));
    expect(getCachedEnrichment(db, KEY)!.finish).toBe('length');
  });

  it('accepts an answer with no item behind it', () => {
    // §8.1's weekly blurb is generated over a set of items, not one item.
    const db = migratedDb();
    putCachedEnrichment(db, answer({ itemKey: null }));
    expect(getCachedEnrichment(db, KEY)!.itemKey).toBeNull();
  });

  it('rejects a non-canonical answeredAt rather than storing a guess', () => {
    const db = migratedDb();
    expect(() => putCachedEnrichment(db, answer({ answeredAt: '2026-08-15' }))).toThrow(
      InvalidTimestampError,
    );
  });

  it('rejects a cacheKey that is not a sha256 digest', () => {
    // The one guard against a caller passing an item_key-shaped value, a raw
    // prompt, or a truncated hash. Both layers refuse: the access layer for a
    // clear message, the schema for every other writer.
    const db = migratedDb();
    expect(() => putCachedEnrichment(db, answer({ cacheKey: 'summary:llama3.2' }))).toThrow(
      RangeError,
    );
  });
});

describe('a later answer supersedes; an older one never does', () => {
  it('refreshes the row when the new answer is newer', () => {
    const db = migratedDb();
    putCachedEnrichment(db, answer({ text: 'first', answeredAt: '2026-08-15T06:00:00.000Z' }));

    expect(
      putCachedEnrichment(db, answer({ text: 'second', answeredAt: '2026-08-15T07:00:00.000Z' })),
    ).toEqual({ action: 'updated' });

    const row = getCachedEnrichment(db, KEY)!;
    expect(row.text).toBe('second');
    expect(row.answeredAt).toBe('2026-08-15T07:00:00.000Z');
    // Immutable across the refresh: "when did we first answer this question"
    // survives every later restatement.
    expect(row.firstAnsweredAt).toBe('2026-08-15T06:00:00.000Z');
  });

  it('ignores a replayed or out-of-order answer', () => {
    const db = migratedDb();
    putCachedEnrichment(db, answer({ text: 'current', answeredAt: '2026-08-15T07:00:00.000Z' }));

    expect(
      putCachedEnrichment(db, answer({ text: 'stale', answeredAt: '2026-08-15T06:00:00.000Z' })),
    ).toEqual({ action: 'ignored' });

    expect(getCachedEnrichment(db, KEY)!.text).toBe('current');
  });

  it('records a NEW resolved model under an unchanged key -- the floating-tag hole, made visible', () => {
    // `model` is the tag as requested, so `ollama pull llama3.2` fetching a
    // different build leaves every prior key matching. Storing what actually
    // answered is what makes that detectable at all; see src/enrich/cacheKey.ts.
    const db = migratedDb();
    putCachedEnrichment(db, answer({ answeredAt: '2026-08-15T06:00:00.000Z' }));
    putCachedEnrichment(
      db,
      answer({ resolvedModel: 'llama3.2:3b-instruct-q8_0', answeredAt: '2026-08-15T08:00:00.000Z' }),
    );

    const row = getCachedEnrichment(db, KEY)!;
    expect(row.model).toBe('llama3.2');
    expect(row.resolvedModel).toBe('llama3.2:3b-instruct-q8_0');
  });
});

describe('schema invariants -- enforced for every writer, not just this module', () => {
  it('refuses a DELETE', () => {
    const db = migratedDb();
    putCachedEnrichment(db, answer());
    expect(() => db.exec(`delete from llm_enrichment_cache where cache_key = '${KEY}'`)).toThrow(
      /never deleted/,
    );
  });

  it('refuses to restate what question a row answers', () => {
    // task, backend and model are INPUTS to the cache key. A row whose task
    // changed is a row the key no longer describes.
    //
    // The UPDATEs below also advance answered_at, so this isolates the
    // identity trigger: without that, the monotonicity trigger would refuse
    // them first (a no-op UPDATE leaves answered_at equal) and this test
    // would pass while asserting nothing about identity. SQLite does not
    // define which of several eligible triggers fires first.
    const db = migratedDb();
    putCachedEnrichment(db, answer({ answeredAt: '2026-08-15T06:00:00.000Z' }));
    const later = "answered_at = '2026-08-15T09:00:00.000Z'";

    expect(() =>
      db.exec(
        `update llm_enrichment_cache set task = 'weekly_blurb', ${later} where cache_key = '${KEY}'`,
      ),
    ).toThrow(/immutable/);
    expect(() =>
      db.exec(
        `update llm_enrichment_cache set model = 'qwen2.5', ${later} where cache_key = '${KEY}'`,
      ),
    ).toThrow(/immutable/);
  });

  it('refuses to move answered_at backwards', () => {
    const db = migratedDb();
    putCachedEnrichment(db, answer({ answeredAt: '2026-08-15T07:00:00.000Z' }));
    expect(() =>
      db.exec(
        `update llm_enrichment_cache set answered_at = '2026-08-15T05:00:00.000Z' where cache_key = '${KEY}'`,
      ),
    ).toThrow(/forward/);
  });

  it('refuses to rewrite the item a row was first produced for', () => {
    const db = migratedDb();
    putCachedEnrichment(db, answer({ answeredAt: '2026-08-15T06:00:00.000Z' }));
    expect(() =>
      db.exec(
        `update llm_enrichment_cache set item_key = '${OTHER_KEY}',
           answered_at = '2026-08-15T09:00:00.000Z' where cache_key = '${KEY}'`,
      ),
    ).toThrow(/immutable/);
  });

  it('accepts learning the item behind an answer that had none', () => {
    const db = migratedDb();
    putCachedEnrichment(db, answer({ itemKey: null, answeredAt: '2026-08-15T06:00:00.000Z' }));
    putCachedEnrichment(db, answer({ itemKey: ITEM_KEY, answeredAt: '2026-08-15T07:00:00.000Z' }));
    expect(getCachedEnrichment(db, KEY)!.itemKey).toBe(ITEM_KEY);
  });

  it('refuses a cache_key that is not a lowercase sha256 digest, at the schema', () => {
    const db = migratedDb();
    expect(() =>
      db.exec(`
        insert into llm_enrichment_cache
          (cache_key, task, backend, model, resolved_model, answer_text, finish,
           item_key, answered_at, first_answered_at)
        values ('NOTAHASH', 'summary', 'ollama', 'm', 'm', 'x', 'stop', null,
                '2026-08-15T06:00:00.000Z', '2026-08-15T06:00:00.000Z')
      `),
    ).toThrow(/cache_key/);
  });

  it('refuses a first_answered_at that postdates the answer', () => {
    const db = migratedDb();
    expect(() =>
      db.exec(`
        insert into llm_enrichment_cache
          (cache_key, task, backend, model, resolved_model, answer_text, finish,
           item_key, answered_at, first_answered_at)
        values ('${KEY}', 'summary', 'ollama', 'm', 'm', 'x', 'stop', null,
                '2026-08-15T06:00:00.000Z', '2026-08-15T07:00:00.000Z')
      `),
    ).toThrow();
  });
});

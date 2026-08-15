/**
 * Storage for the enrichment cache (M5 task 3).
 *
 * See db/migrations/0009_llm_enrichment.sql for the schema's own reasoning and
 * src/enrich/cacheKey.ts for why a hit is keyed on content rather than on
 * `item_key`. The three things a reader of THIS file needs to hold onto:
 *
 *  1. **The key is the question, not the item.** `getCachedEnrichment` takes
 *     a `cacheKey` and nothing else. A caller that reaches for `item_key`
 *     here is reintroducing the failure the whole design exists to prevent --
 *     serving a summary of an older version of an article.
 *  2. **An empty answer is a hit.** `text: ''` means the model had nothing to
 *     say; it is stored and returned. Only `null` from
 *     {@link getCachedEnrichment} means "never answered".
 *  3. **Unavailability is never cached.** There is no shape here for it.
 *     A failed call goes to `llm_call_log` (src/db/llmCallLog.ts), so a
 *     five-minute outage cannot become a permanent stored non-answer.
 *
 * This module writes nothing outside `llm_enrichment_cache` and reads no
 * clock: `answeredAt` is injected, matching every other storage module here.
 */

import type { Db } from './connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import type { LlmBackendName, LlmFinishReason } from '../enrich/llm/types.ts';

/** A stored answer, as it comes back out. */
export interface CachedEnrichment {
  cacheKey: string;
  task: string;
  backend: LlmBackendName;
  /** The model as REQUESTED -- an input to the key. */
  model: string;
  /**
   * The model that ANSWERED, as the backend named it. The only place a
   * repointed floating tag (`ollama pull llama3.2` fetching a different
   * build) becomes visible; see src/enrich/cacheKey.ts.
   */
  resolvedModel: string;
  /** May legitimately be `''`. See the module doc. */
  text: string;
  finish: LlmFinishReason;
  /** Provenance: the FIRST item that produced this answer. Never a lookup input. */
  itemKey: string | null;
  answeredAt: string;
  firstAnsweredAt: string;
}

/** One answer, as the enrichment wrapper hands it over. */
export interface EnrichmentAnswer {
  cacheKey: string;
  task: string;
  backend: LlmBackendName;
  model: string;
  resolvedModel: string;
  text: string;
  finish: LlmFinishReason;
  /** Omit or pass `null` for an answer produced over no single item. */
  itemKey?: string | null;
  /** Canonical UTC instant the answer was produced. Injected, never a clock read. */
  answeredAt: string;
}

/**
 * What a {@link putCachedEnrichment} call actually did.
 *
 * `ignored` means a LATER answer was already stored and this one was
 * discarded -- ordinary operational noise (two passes racing over one item),
 * returned rather than thrown, but a caller that logged "stored"
 * unconditionally would be lying. Same convention as `recordStarSnapshot`
 * and `recordRepoReadme`.
 */
export interface CachePutOutcome {
  action: 'inserted' | 'updated' | 'ignored';
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

const INSERT = `
  insert into llm_enrichment_cache
    (cache_key, task, backend, model, resolved_model, answer_text, finish,
     item_key, answered_at, first_answered_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict (cache_key) do update set
    resolved_model = excluded.resolved_model,
    answer_text = excluded.answer_text,
    finish = excluded.finish,
    -- Provenance is LEARNED, never rewritten: coalesce keeps whatever was
    -- recorded first and only fills a null. The schema trigger refuses the
    -- rewrite outright; this keeps the statement from ever attempting it.
    item_key = coalesce(llm_enrichment_cache.item_key, excluded.item_key),
    answered_at = excluded.answered_at
  where excluded.answered_at > llm_enrichment_cache.answered_at
`;

/**
 * Stores one answer, superseding whatever was there if (and only if) this
 * answer is newer.
 *
 * The cache key is validated here as well as in the schema so a caller
 * passing an `item_key`, a raw prompt, or a truncated digest gets a message
 * naming the field rather than a constraint failure at 3am.
 */
export function putCachedEnrichment(db: Db, answer: EnrichmentAnswer): CachePutOutcome {
  assertCanonicalTimestamp('answeredAt', answer.answeredAt);
  if (!SHA256_HEX.test(answer.cacheKey)) {
    throw new RangeError(
      `cacheKey '${answer.cacheKey}' is not a sha256 hex digest -- build it with enrichmentCacheKey (src/enrich/cacheKey.ts), never from an item_key or a prompt`,
    );
  }

  // Reads the existing row to NAME the outcome. `.run()`'s `changes` cannot:
  // an INSERT and a conflict-resolving UPDATE both report 1, and only the
  // WHERE-filtered no-op reports 0. The guarded upsert below still does the
  // real deciding -- this read only labels it. (Same shape recordStarSnapshot
  // and recordRepoReadme use, for the same reason.)
  const existing = db
    .prepare('select answered_at from llm_enrichment_cache where cache_key = ?')
    .get(answer.cacheKey) as { answered_at: string } | undefined;

  db.prepare(INSERT).run(
    answer.cacheKey,
    answer.task,
    answer.backend,
    answer.model,
    answer.resolvedModel,
    answer.text,
    answer.finish,
    answer.itemKey ?? null,
    answer.answeredAt,
    answer.answeredAt,
  );

  if (existing === undefined) return { action: 'inserted' };
  return { action: answer.answeredAt > existing.answered_at ? 'updated' : 'ignored' };
}

const SELECT_COLUMNS = `
  cache_key, task, backend, model, resolved_model, answer_text, finish,
  item_key, answered_at, first_answered_at
`;

// Inline type literal, not a named interface -- casting .get()'s
// Record<string, SQLOutputValue> to a NAMED interface fails tsc's overlap
// check while a structurally identical inline literal passes. See CLAUDE.md,
// "The node:sqlite cast quirk", and src/cluster/store.ts:88-100.
type CacheRow = {
  cache_key: string;
  task: string;
  backend: string;
  model: string;
  resolved_model: string;
  answer_text: string;
  finish: string;
  item_key: string | null;
  answered_at: string;
  first_answered_at: string;
};

function toRecord(row: CacheRow): CachedEnrichment {
  return {
    cacheKey: row.cache_key,
    task: row.task,
    backend: row.backend as LlmBackendName,
    model: row.model,
    resolvedModel: row.resolved_model,
    text: row.answer_text,
    finish: row.finish as LlmFinishReason,
    itemKey: row.item_key,
    answeredAt: row.answered_at,
    firstAnsweredAt: row.first_answered_at,
  };
}

/**
 * The stored answer to exactly this question, or `null` if it has never been
 * asked.
 *
 * `null` is the ONLY miss. A row whose `text` is `''` is a hit -- see the
 * module doc.
 */
export function getCachedEnrichment(db: Db, cacheKey: string): CachedEnrichment | null {
  const row = db
    .prepare(`select ${SELECT_COLUMNS} from llm_enrichment_cache where cache_key = ?`)
    .get(cacheKey) as CacheRow | undefined;
  return row === undefined ? null : toRecord(row);
}

/**
 * Every answer ever produced for `itemKey`, newest first.
 *
 * The one read that touches `item_key` at all, and it is provenance: "what
 * has this item been enriched into", for the vault notes and for debugging.
 * It is deliberately NOT a cache lookup -- an item with two content versions
 * has two rows here, and picking one of them would be exactly the stale-
 * version failure src/enrich/cacheKey.ts documents.
 */
export function getEnrichmentsForItem(db: Db, itemKey: string): CachedEnrichment[] {
  const rows = db
    .prepare(
      `select ${SELECT_COLUMNS} from llm_enrichment_cache
        where item_key = ?
        order by answered_at desc, cache_key asc`,
    )
    .all(itemKey) as CacheRow[];
  return rows.map(toRecord);
}

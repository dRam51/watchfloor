/**
 * Real-schema corpora for the §8.2 bot tools (M5 task 11).
 *
 * No mocks and no hand-written `create table`: every temp corpus here is built
 * by running the REAL `db/migrations/*.sql`, so a tool tested against it is
 * tested against the schema it will meet in production — including the
 * append-only triggers, the CHECK constraints on `beat` and `item_type`, and
 * the canonical-timestamp triggers M2 added.
 *
 * `archivePath()` is the other half. `attic/wf-m1-firstrun-2026-08-14.db` is
 * the first live ingest and is **opened read-only and never written**. It is
 * the only place the hard point-in-time case exists: 1,715 of its 3,325 items
 * carry a null `published_at`, against ZERO in the live corpus today.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../../src/db/connection.ts';
import { runMigrations } from '../../../src/db/migrate.ts';
import type { Beat, ItemType } from '../../../src/domain/item.ts';
import type { ReadOnlyCorpus } from '../../../src/mcp/readonly.ts';
import { ToolRegistry, type McpTool } from '../../../src/mcp/registry.ts';
import { createMcpServer } from '../../../src/mcp/server.ts';
import type { QueryLogRecord } from '../../../src/mcp/log.ts';
import { authedRequest, decode, TEST_MCP_TOKEN, type DecodedResponse } from '../fixture.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

export const MIGRATIONS_DIR = join(repoRoot, 'db', 'migrations');

/** The first live ingest, archived. Read-only, always. */
export function archivePath(): string {
  return join(repoRoot, 'attic', 'wf-m1-firstrun-2026-08-14.db');
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wf-mcp-tools-'));
}

export interface SeedItem {
  itemId: string;
  itemKey: string;
  title: string;
  url?: string;
  sourceId: string;
  itemType?: ItemType;
  publishedAt?: string | null;
  fetchedAt: string;
  beats?: Beat[];
  entities?: string[];
  /** `[beat, signalScore, readScore, computedAt]` — read_score is stored so the guards face a real column. */
  scores?: Array<[Beat, number, number, string]>;
}

export interface SeedFetchState {
  sourceId: string;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastError?: string | null;
  consecutiveFailures?: number;
  nextEligibleAt?: string | null;
  itemsYielded?: number;
  windowStartedAt?: string | null;
  updatedAt: string;
}

export interface SeedOptions {
  items?: SeedItem[];
  fetchState?: SeedFetchState[];
  /** Writes `retention_horizon`, so the as-of guard has something to refuse against. */
  retentionHorizon?: string;
}

/** A temp database with every real migration applied, seeded, and closed. */
export function seedRealCorpus(options: SeedOptions = {}): string {
  const path = join(tempDir(), 'corpus.db');
  const db: Db = openDb(path);
  runMigrations(db, MIGRATIONS_DIR);

  const insertItem = db.prepare(
    `insert into items (item_id, item_key, url, canonical_url, title, author, source_id, item_type,
                        published_at, fetched_at, summary_raw, raw_json, created_at)
     values (?, ?, ?, ?, ?, null, ?, ?, ?, ?, null, '{}', ?)`,
  );
  const insertBeat = db.prepare('insert into item_beats (item_id, beat) values (?, ?)');
  const insertEntity = db.prepare('insert into item_entities (item_id, entity) values (?, ?)');
  const insertScore = db.prepare(
    `insert into item_scores (score_id, item_id, beat, signal_score, read_score, scorer_version, computed_at)
     values (?, ?, ?, ?, ?, 'test-1', ?)`,
  );

  let scoreSeq = 0;
  for (const item of options.items ?? []) {
    const url = item.url ?? `https://example.com/${item.itemKey}`;
    insertItem.run(
      item.itemId,
      item.itemKey,
      url,
      url,
      item.title,
      item.sourceId,
      item.itemType ?? 'analysis',
      item.publishedAt ?? null,
      item.fetchedAt,
      item.fetchedAt,
    );
    for (const beat of item.beats ?? []) insertBeat.run(item.itemId, beat);
    for (const entity of item.entities ?? []) insertEntity.run(item.itemId, entity);
    for (const [beat, signal, read, computedAt] of item.scores ?? []) {
      insertScore.run(`score-${++scoreSeq}`, item.itemId, beat, signal, read, computedAt);
    }
  }

  const insertState = db.prepare(
    `insert into source_fetch_state (source_id, last_success_at, last_failure_at, last_error,
                                     consecutive_failures, next_eligible_at,
                                     items_yielded_7d, items_yielded_7d_window_started_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const state of options.fetchState ?? []) {
    insertState.run(
      state.sourceId,
      state.lastSuccessAt ?? null,
      state.lastFailureAt ?? null,
      state.lastError ?? null,
      state.consecutiveFailures ?? 0,
      state.nextEligibleAt ?? null,
      state.itemsYielded ?? 0,
      state.windowStartedAt ?? null,
      state.updatedAt,
    );
  }

  if (options.retentionHorizon !== undefined) {
    db.prepare('insert into retention_horizon (id, oldest_intact_fetched_at, updated_at) values (1, ?, ?)').run(
      options.retentionHorizon,
      options.retentionHorizon,
    );
  }

  closeDb(db);
  return path;
}

// ---------------------------------------------------------------------------
// Calling a tool the way a real client does
// ---------------------------------------------------------------------------

export interface ToolCallResult {
  readonly response: DecodedResponse;
  /** `structuredContent`, after the §8.2 serializer has passed it. */
  readonly structured: Record<string, unknown>;
  readonly isError: boolean;
  readonly log: QueryLogRecord[];
}

/**
 * Runs a tool through the REAL dispatcher — registry, credential gate,
 * `.strict()` argument validation, `sealBotPayload`, and the query log — rather
 * than by calling `run` directly.
 *
 * That is deliberate: Task 10 put every §8.2 guard in the dispatcher precisely
 * so a tool author cannot opt out, and a test that calls `tool.run(...)`
 * bypasses all of them. Registration itself is part of the exercise too: a tool
 * whose name or argument names imply a recommendation throws here.
 */
export async function callBotTool(options: {
  corpus: ReadOnlyCorpus;
  tools: ReadonlyArray<McpTool<never>>;
  name: string;
  args?: Record<string, unknown>;
  now?: string;
}): Promise<ToolCallResult> {
  const registry = new ToolRegistry();
  for (const tool of options.tools) registry.register(tool);

  const log: QueryLogRecord[] = [];
  const now = options.now ?? '2026-08-16T00:00:00.000Z';
  const server = createMcpServer({
    corpus: options.corpus,
    token: TEST_MCP_TOKEN,
    registry,
    log: { record: (entry) => log.push(entry) },
    now: () => now,
  });

  const line = await server.handle(
    authedRequest('tools/call', { params: { name: options.name, arguments: options.args ?? {} } }),
  );
  const response = decode(line);
  const result = response.result ?? {};
  return {
    response,
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    isError: result.isError === true,
    log,
  };
}

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

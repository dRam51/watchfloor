/**
 * The migration guard, for the one process in this system that may not write
 * (M5 task 10).
 *
 * CLAUDE.md, "Migrations are no longer applied on boot":
 *
 * > *"`npm run migrate` is the **only** thing that applies them. `api`,
 * > `ingest`, `score`, `rank`, and `scheduler` all refuse to start with pending
 * > migrations."*
 *
 * The MCP server joins that list, and for a sharper reason than the others: a
 * bot backtesting against a database whose schema predates the columns a tool
 * reads does not get an error, it gets confident wrong numbers.
 *
 * ---------------------------------------------------------------------------
 * Why it cannot call assertMigrationsUpToDate
 * ---------------------------------------------------------------------------
 * The shared guard **writes**. `reconcile` opens with
 * `ensureBookkeepingTable` (`create table if not exists schema_migrations`)
 * and, for an applied migration with no recorded checksum, runs
 * `update schema_migrations set checksum = ?`. Both are impossible on a
 * connection opened `SQLITE_OPEN_READONLY`, and giving this process a writable
 * handle "just for the boot check" would hand the bot exactly the write path
 * §8.2 says it must not have.
 *
 * So this is the same check with the writes removed, and the one behavioural
 * difference is deliberate and reported rather than hidden: **a missing
 * checksum is returned in `unverifiable`, never backfilled.** Backfilling is a
 * claim ("I am trusting this file as of now") that only the writer is entitled
 * to make. A read-only observer's honest answer is "this migration's integrity
 * cannot be checked from here", and the caller prints it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ReadOnlyCorpus } from './readonly.ts';

export class CorpusMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusMigrationError';
  }
}

export interface CorpusMigrationState {
  /** Versions recorded as applied, in order. */
  readonly applied: string[];
  /**
   * Applied migrations whose recorded checksum is null, so drift cannot be
   * detected for them. Not an error — the writable runner backfills these on
   * the next `npm run migrate` — but the operator should see it.
   */
  readonly unverifiable: string[];
}

/** Mirrors src/db/migrate.ts's own checksum, which is what the recorded values are. */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function assertCorpusMigrationsUpToDate(
  corpus: ReadOnlyCorpus,
  migrationsDir: string,
): CorpusMigrationState {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = corpus.all('select version, checksum from schema_migrations order by version');
  } catch {
    // No bookkeeping table at all. The writable runner would create one; this
    // process reports the same thing a fully-pending database reports, because
    // that is what it is.
    rows = [];
  }

  const recorded = new Map<string, string | null>();
  for (const row of rows) {
    recorded.set(String(row.version), typeof row.checksum === 'string' ? row.checksum : null);
  }

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    // Lexicographic order matches numeric order because every migration is
    // zero-padded to a fixed width -- the same assumption src/db/migrate.ts
    // relies on to apply them in the right order.
    .sort();

  const pending: string[] = [];
  const applied: string[] = [];
  const unverifiable: string[] = [];

  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    if (!recorded.has(version)) {
      pending.push(version);
      continue;
    }
    applied.push(version);

    const stored = recorded.get(version) ?? null;
    if (stored === null) {
      unverifiable.push(version);
      continue;
    }
    const current = checksumOf(readFileSync(join(migrationsDir, file), 'utf8'));
    if (stored !== current) {
      throw new CorpusMigrationError(
        `migration ${version} has drifted: db/migrations/${file} no longer matches what was ` +
          `applied to this database (recorded ${stored}, file now hashes to ${current}). The MCP ` +
          `server refuses to serve a corpus whose schema history is not what the tree describes — ` +
          `a bot cannot tell a stale column from a missing one. See CLAUDE.md, "Never edit an ` +
          `applied migration".`,
      );
    }
  }

  if (pending.length > 0) {
    throw new CorpusMigrationError(
      `pending migrations; run npm run migrate before starting the MCP server. ` +
        `Pending: ${pending.join(', ')}. (This process opens the database READ-ONLY by design ` +
        `(§8.2) and therefore cannot apply them itself, unlike a writer that merely declines to.)`,
    );
  }

  return { applied, unverifiable };
}

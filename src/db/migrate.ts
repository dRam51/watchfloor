import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './connection.ts';

// The runner owns the transaction boundary (begin/commit/rollback below). A
// migration that issues its own COMMIT or ROLLBACK ends that transaction out
// from under the runner: the subsequent bookkeeping insert then runs in
// autocommit mode and is permanently recorded even though the migration is
// about to be treated as failed, and any DDL before the embedded COMMIT is
// permanently applied with no record of it. Comments are stripped first so a
// stray mention of "commit"/"rollback" in prose doesn't false-positive.
const TRANSACTION_CONTROL = /\b(commit|rollback)\b/i;

function containsTransactionControl(sql: string): boolean {
  return TRANSACTION_CONTROL.test(sql.replace(/--[^\n]*/g, ''));
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Ensures schema_migrations exists and carries a `checksum` column, for
 * both a brand-new database (created here, with the column already in the
 * DDL) and one migrated by a pre-checksum build of this runner (table
 * exists, column doesn't). SQLite has no `ADD COLUMN IF NOT EXISTS` — that
 * syntax was tried and rejected a syntax error against the bundled 3.53.1 —
 * so the legacy path checks `pragma table_info` explicitly instead.
 */
function ensureBookkeepingTable(db: Db): void {
  db.exec(`
    create table if not exists schema_migrations (
      version    text primary key,
      checksum   text,
      applied_at text not null
    )
  `);
  const columns = db.prepare('pragma table_info(schema_migrations)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === 'checksum')) {
    db.exec('alter table schema_migrations add column checksum text');
  }
}

/** version -> recorded checksum, or null if never recorded (pre-checksum row). */
function readApplied(db: Db): Map<string, string | null> {
  const rows = db.prepare('select version, checksum from schema_migrations').all() as Array<{
    version: string;
    checksum: string | null;
  }>;
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

export interface ReconcileResult {
  /** Versions newly applied during this call (empty unless apply: true). */
  applied: string[];
  /**
   * Versions whose row had no recorded checksum (applied before this
   * feature existed) and were backfilled from the on-disk file this run.
   */
  backfilledChecksums: string[];
  /** Versions on disk that are not yet applied (empty when apply: true). */
  pending: string[];
}

/**
 * Walks every *.sql file in migrationsDir in filename order, reconciling it
 * against schema_migrations. Three integrity checks run regardless of
 * `apply`, because they concern migrations that already ran and are true
 * whether or not the caller is allowed to apply new ones:
 *
 *  1. Checksum verification. A row with a recorded checksum that no longer
 *     matches the file throws immediately, naming the file — this is the
 *     fix for the confirmed incident where 0005_fts_search.sql was edited
 *     after being applied and the old runner never noticed.
 *  2. Checksum backfill. A row with NO recorded checksum (every migration
 *     applied before this feature existed) has one computed from the
 *     current file and written back, so it is protected from this point
 *     forward. See the "backfill problem" note on assertMigrationsUpToDate
 *     and the fix-migration-runner-report.md for the full reasoning.
 *  3. Ordering. A not-yet-applied file that sorts earlier than the latest
 *     already-applied version is refused outright rather than applied out
 *     of order in silence.
 *
 * When `apply` is false, any remaining not-yet-applied (and in-order) file
 * is collected into `pending` and never executed — this is what makes
 * assertMigrationsUpToDate a true check-only path.
 */
function reconcile(db: Db, migrationsDir: string, opts: { apply: boolean }): ReconcileResult {
  ensureBookkeepingTable(db);

  const appliedMap = readApplied(db);
  // Lexicographic order matches numeric order only because every migration
  // is zero-padded to a fixed width (0001, 0002, ...) — the same assumption
  // `files.sort()` below already relies on to apply in the right order.
  const maxAppliedVersion =
    appliedMap.size > 0 ? [...appliedMap.keys()].sort().at(-1) : undefined;

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const backfilledChecksums: string[] = [];
  const pending: string[] = [];

  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    const path = join(migrationsDir, file);

    if (appliedMap.has(version)) {
      const recorded = appliedMap.get(version) ?? null;
      const sql = readFileSync(path, 'utf8');
      const current = checksumOf(sql);

      if (recorded === null) {
        db.prepare('update schema_migrations set checksum = ? where version = ?').run(
          current,
          version,
        );
        backfilledChecksums.push(version);
        console.warn(
          `[migrate] backfilled checksum for already-applied migration ${version} ` +
            `(no checksum was recorded when it ran, before this check existed). Trusting ` +
            `${file} as of right now — this cannot detect drift from before this run, only ` +
            `from here on.`,
        );
      } else if (recorded !== current) {
        throw new Error(
          `migration ${version} has drifted: db/migrations/${file} no longer matches what was ` +
            `applied to this database. Recorded checksum ${recorded}, file now hashes to ` +
            `${current}. This migration already ran, so the runner will never re-apply it — the ` +
            `database still has the schema from BEFORE this file was edited, and the file on ` +
            `disk now describes something else. Do not edit an applied migration: write a new, ` +
            `later-numbered migration for the change instead, or rebuild this database from a ` +
            `clean ingest if the drift is already live (see CLAUDE.md's "Never edit an applied ` +
            `migration").`,
        );
      }
      continue;
    }

    if (maxAppliedVersion !== undefined && version < maxAppliedVersion) {
      throw new Error(
        `migration ${version} (db/migrations/${file}) is numerically earlier than an ` +
          `already-applied migration (${maxAppliedVersion}). Refusing to apply it out of order — ` +
          `renumber it ahead of ${maxAppliedVersion}, or fold its intent into a new, ` +
          `later-numbered migration instead.`,
      );
    }

    if (!opts.apply) {
      pending.push(version);
      continue;
    }

    const sql = readFileSync(path, 'utf8');
    if (containsTransactionControl(sql)) {
      throw new Error(
        `migration ${version} failed: migration SQL must not contain COMMIT or ROLLBACK — the runner owns the transaction boundary`,
      );
    }

    db.exec('begin');
    try {
      db.exec(sql);
      db.prepare(
        'insert into schema_migrations (version, checksum, applied_at) values (?, ?, ?)',
      ).run(version, checksumOf(sql), new Date().toISOString());
      db.exec('commit');
    } catch (cause) {
      // The transaction may already be gone by the time we get here — SQLite
      // itself rolls back on some internal errors (SQLITE_FULL, SQLITE_IOERR,
      // SQLITE_NOMEM). Calling rollback with nothing to roll back throws and
      // would replace `cause` with a confusing "no transaction is active"
      // error, losing the real reason the migration failed.
      if (db.isTransaction) db.exec('rollback');
      throw new Error(`migration ${version} failed: ${(cause as Error).message}`, { cause });
    }
    applied.push(version);
  }

  return { applied, backfilledChecksums, pending };
}

/**
 * Applies every not-yet-applied migration in migrationsDir, in order. This
 * is what `npm run migrate` (src/bin/migrate.ts) calls. Entrypoints that
 * merely need to *run* — the API server, the ingest/score/rank CLIs, the
 * scheduler — call assertMigrationsUpToDate instead; see that function's
 * doc comment for why boot no longer auto-applies.
 */
export function runMigrations(
  db: Db,
  migrationsDir: string,
): { applied: string[]; backfilledChecksums: string[] } {
  const { applied, backfilledChecksums } = reconcile(db, migrationsDir, { apply: true });
  return { applied, backfilledChecksums };
}

/**
 * Check-only counterpart to runMigrations: verifies checksums, backfills
 * unrecorded ones, and refuses out-of-order files exactly like runMigrations
 * does — but never executes a pending migration's SQL. If any migration on
 * disk has not yet been applied, it throws rather than applying it.
 *
 * This is the fix for weakness (3) in
 * .superpowers/sdd/2026-08-14-m3-api-dashboard/progress.md ("CORRECTION +
 * escalation: three weaknesses in the migration runner"): every entrypoint
 * used to call runMigrations directly, so a routine `npm run rank` would
 * silently apply whatever migration files happened to be sitting on disk —
 * including a colleague's uncommitted work in progress. That was the actual
 * root cause of the confirmed incident, not (1) or (2) alone: checksums and
 * ordering checks only protect a migration that has already been reviewed
 * and applied once; they do nothing to stop the FIRST accidental apply of a
 * file nobody meant to run yet.
 *
 * The recommendation implemented here is the strict one: `npm run migrate`
 * is now a required, explicit step (see package.json and
 * src/bin/migrate.ts), and every other entrypoint refuses to boot with
 * pending migrations rather than applying them for you. See
 * fix-migration-runner-report.md for the reasoning and what this changes in
 * the operator-facing runbook.
 */
export function assertMigrationsUpToDate(
  db: Db,
  migrationsDir: string,
): { backfilledChecksums: string[] } {
  const { pending, backfilledChecksums } = reconcile(db, migrationsDir, { apply: false });
  if (pending.length > 0) {
    throw new Error(
      `pending migrations; run npm run migrate before starting watchfloor. ` +
        `Pending: ${pending.join(', ')}.`,
    );
  }
  return { backfilledChecksums };
}

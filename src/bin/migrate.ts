/**
 * Explicit migration runner — the fix for weakness (3) recorded in
 * .superpowers/sdd/2026-08-14-m3-api-dashboard/progress.md ("CORRECTION +
 * escalation: three weaknesses in the migration runner").
 *
 * Every other entrypoint — src/bin/{api,ingest,score,rank,scheduler}.ts —
 * used to call runMigrations directly on boot, so a routine `npm run rank`
 * would silently apply whatever *.sql files happened to be sitting in
 * db/migrations/, including a colleague's uncommitted work in progress.
 * That was the confirmed root cause of the incident that motivated this
 * change: an auth smoke test's `npm run rank` invocation applied
 * 0005_fts_search.sql while it was still being written, its author then
 * split one trigger into two, and the runner never noticed or re-applied it
 * — nothing distinguished "committed and reviewed" from "someone is still
 * writing this."
 *
 * This is now the ONLY entrypoint that applies migrations. Every other
 * entrypoint calls assertMigrationsUpToDate (src/db/migrate.ts) instead and
 * refuses to start if this has not been run first — see that function's doc
 * comment, and fix-migration-runner-report.md, for the full reasoning
 * behind making this an explicit step rather than continuing to auto-apply.
 *
 *   npm run migrate
 */

import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { openDatabase } from '../db/openDatabase.ts';
import { runMigrations } from '../db/migrate.ts';
import { closeDb } from '../db/connection.ts';

// Resolved relative to this module, not the process cwd — matches every
// other src/bin/*.ts entrypoint.
const repoRoot = join(import.meta.dirname, '..', '..');

try {
  const env = loadEnv();
  const db = openDatabase(env.WF_DB_PATH);
  try {
    const { applied, backfilledChecksums } = runMigrations(
      db,
      join(repoRoot, 'db', 'migrations'),
    );

    if (applied.length > 0) {
      console.log(`applied migrations: ${applied.join(', ')}`);
    } else {
      console.log('no pending migrations');
    }
    if (backfilledChecksums.length > 0) {
      console.log(
        `backfilled checksum for previously-applied migration(s) with no recorded checksum ` +
          `(applied before checksum tracking existed): ${backfilledChecksums.join(', ')}`,
      );
    }
  } finally {
    closeDb(db);
  }
  process.exit(0);
} catch (err) {
  // EnvError, DatabaseOpenError, and migration failures (bad SQL,
  // checksum drift, out-of-order files) all carry messages written
  // specifically to name the offending variable, path, version, or file —
  // a raw stack trace buries exactly that. Same pattern as every other
  // src/bin/*.ts entrypoint.
  console.error((err as Error).message);
  process.exit(1);
}

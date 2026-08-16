/**
 * One-shot vault sync (M5 task 15):
 *
 *   npm run vault
 *
 * Writes §8.1's `daily/`, `weekly/` and `entities/` once and exits — the same
 * relationship to `src/bin/scheduler.ts`'s vault work that `src/bin/ingest.ts`
 * has to its poll cycle, and built the same way: **not a fork of the daemon's
 * logic.** Both call `runVaultSync` (`src/vault/sync.ts`) with dependencies
 * from the same `loadVaultSyncDeps`, so a hand-run sync cannot quietly differ
 * from the one that actually runs unattended.
 *
 * ## This ignores the daemon's cadence, deliberately
 *
 * `src/vault/cadence.ts` exists so a 60-second tick does not rewrite the
 * weekly note 360 times over a Friday evening. It has nothing to say about a
 * human typing `npm run vault`: the operator asked, so all three areas are
 * written, whatever day it is. That also makes this the way to produce a
 * weekly note out of band — after a week the daemon was down for, or while
 * judging §8.1's blurbs.
 *
 * ## Exit codes
 *
 * `0` when the sync ran, **and also when no vault is configured** — that is
 * the shipped configuration (`WF_VAULT_ROOT` is commented out in `.env`), and
 * a clean no-op is not a failure. `1` when a vault is configured and cannot be
 * written: the operator asked for a sync and did not get one.
 */

import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { openDatabase } from '../db/openDatabase.ts';
import { assertMigrationsUpToDate } from '../db/migrate.ts';
import { closeDb } from '../db/connection.ts';
import { openVaultSession } from '../vault/session.ts';
import { loadVaultSyncDeps, resolveVaultTarget, runVaultSync } from '../vault/sync.ts';

// Resolved relative to this module, not the process cwd -- a process
// supervisor (§12) may launch us from anywhere. Matches every other bin/*.ts.
const repoRoot = join(import.meta.dirname, '..', '..');

/** Mirrors src/bin/ingest.ts's own formatLocal -- see its comment on why each bin/*.ts carries its own. */
function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
}

try {
  const env = loadEnv();

  // Checked BEFORE the database is opened. With no vault configured there is
  // nothing to do at all, and a missing WF_DB_PATH should not be the error a
  // no-op run reports.
  const target = resolveVaultTarget();
  if (target.status === 'not_configured') {
    console.log(
      'vault sync is not configured: WF_VAULT_ROOT is unset. Nothing to do. ' +
        '(Set it in .env to the Watchfloor subtree of your Obsidian vault, e.g. ' +
        '<vault>/watchfloor -- never the vault root itself.)',
    );
    process.exit(0);
  }
  if (target.status === 'unmounted') {
    // Loud, because it means the owner expects sync and is not getting it.
    // The refusal carries its own remedy; a refusal with no remedy gets
    // routed around.
    console.error(
      `vault sync refused: ${target.refusal.detail} (${target.refusal.reason})\n` +
        `  root: ${target.root}\n` +
        `  ${target.refusal.remedy}`,
    );
    process.exit(1);
  }

  const db = openDatabase(env.WF_DB_PATH);
  try {
    // Entrypoints no longer auto-apply migrations -- run `npm run migrate`
    // first. See src/db/migrate.ts's doc comment on assertMigrationsUpToDate.
    const { backfilledChecksums } = assertMigrationsUpToDate(db, join(repoRoot, 'db', 'migrations'));
    if (backfilledChecksums.length > 0) {
      console.log(
        `backfilled checksum for previously-applied migration(s) with no recorded checksum: ` +
          `${backfilledChecksums.join(', ')}`,
      );
    }

    const deps = loadVaultSyncDeps({ repoRoot, db, tz: env.WF_TZ });
    console.log(
      `watchfloor vault sync starting (TZ=${env.WF_TZ}, root=${target.root}, ` +
        `model=${deps.weekly.enrichment.backend.name}/${deps.weekly.enrichment.backend.model})`,
    );

    const now = new Date().toISOString();
    const session = openVaultSession(target.root);
    const report = await runVaultSync(session, deps, { now });

    console.log(`  daily:  ${report.daily === null ? 'not written' : `${report.daily.relPath} (${report.daily.created ? 'created' : 'updated'}, ${report.daily.bytes} bytes)`}`);
    if (report.weekly !== null) {
      const b = report.weekly.blurbs;
      console.log(
        `  weekly: ${report.weekly.relPath} (${report.weekly.write.created ? 'created' : 'updated'}) -- ` +
          `${report.weekly.entries.length} entr(ies), blurbs: ${b.generated} generated, ${b.fromCache} cached, ` +
          `${b.rejected} rejected, ${b.unavailable} unavailable, ${b.refused} refused`,
      );
    } else {
      console.log('  weekly: not written');
    }
    if (report.entities !== null) {
      console.log(
        `  entities: ${report.entities.written.length} written, ${report.entities.skipped.length} skipped` +
          (report.entities.stopped !== null ? ` -- STOPPED EARLY (${report.entities.stopped})` : ''),
      );
    }

    // Per-area refusals printed explicitly rather than left in a return value
    // nobody sees -- the same reason src/bin/ingest.ts prints a dead feed.
    for (const refusal of report.refusals) {
      console.log(`  ! ${refusal.area} refused: ${refusal.detail}`);
    }

    console.log(
      `vault sync finished at ${formatLocal(now, env.WF_TZ)} -- ` +
        `${report.filesWritten} file(s) written under ${target.root}`,
    );

    // A refusal is a failure of the thing the operator asked for, so it is
    // reported in the exit code as well as in the log.
    process.exitCode = report.refusals.length > 0 ? 1 : 0;
  } finally {
    closeDb(db);
  }
  process.exit(process.exitCode ?? 0);
} catch (err) {
  // EnvError, DatabaseOpenError, VaultMountError, and the config loaders'
  // errors all carry messages written to name the offending variable, path or
  // config line -- a raw stack trace buries exactly that.
  console.error((err as Error).message);
  process.exit(1);
}

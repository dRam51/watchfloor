/**
 * `npm run backup` — one verified copy of the corpus, then exit (M6).
 *
 * Deliberately its own entrypoint rather than a flag on another one: a backup
 * is the thing you want to run when something is already wrong, and it must not
 * depend on the scheduler being healthy, the API being up, or migrations being
 * current. It is the only entrypoint in this project that does NOT call
 * `assertMigrationsUpToDate` — see below.
 */
import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { createBackup, listBackups, BackupError } from '../backup/create.ts';

const repoRoot = join(import.meta.dirname, '..', '..');

/** Mirrors src/bin/scheduler.ts's own — WF_TZ governs human-readable local time, never the host zone. */
function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(iso));
}

function human(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

try {
  const env = loadEnv();

  // NOTE: no assertMigrationsUpToDate, and that is the point. Every other
  // entrypoint refuses to run with pending migrations, because operating on a
  // schema the code does not expect is how data gets damaged. Backup is the
  // exact inverse: a database with pending migrations is a database you most
  // want a copy of BEFORE you migrate it, and refusing here would deny the
  // operator the one command that makes the next step safe. It only ever reads.
  const outDir = join(repoRoot, env.WF_BACKUP_DIR ?? './backups');
  const dbPath = join(repoRoot, env.WF_DB_PATH);
  const now = new Date().toISOString();

  const existing = listBackups(outDir);
  const result = createBackup({ dbPath, outDir, now, tz: env.WF_TZ });

  const rows = result.verification.tables.reduce((sum, t) => sum + t.source, 0);
  console.log(
    `backup written at ${formatLocal(result.createdAt, env.WF_TZ)} (${env.WF_TZ})\n` +
      `  ${result.path}\n` +
      `  ${human(result.bytes)}, ${result.verification.tables.length} tables, ${rows.toLocaleString('en-US')} rows`,
  );
  console.log(
    `  verified by reading it back: integrity_check=${result.verification.integrityCheck}, ` +
      `every table's row count matched`,
  );

  const all = listBackups(outDir);
  const total = all.reduce((sum, b) => sum + b.bytes, 0);
  console.log(`  ${all.length} backup(s) in ${outDir}, ${human(total)} total (${existing.length} before this one)`);

  // Never rotated, never pruned -- CLAUDE.md's first standing rule. Said out
  // loud so an operator can decide, rather than discovering it as disk usage.
  if (all.length > 1) {
    console.log(`  nothing here is ever deleted automatically; remove old copies yourself when you want to`);
  }
  console.log(
    `  this is on the SAME DISK as the corpus: it protects against a bad migration or a corrupt\n` +
      `  write, not against losing the machine. Copy it off to have a real backup.`,
  );

  process.exit(0);
} catch (err) {
  if (err instanceof BackupError) {
    console.error(`backup failed: ${err.message}`);
    process.exit(1);
  }
  // EnvError and DatabaseOpenError carry messages naming the offending
  // variable or path -- same pattern as every other bin/*.ts here.
  console.error((err as Error).message);
  process.exit(1);
}

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

export function runMigrations(db: Db, migrationsDir: string): string[] {
  db.exec(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at text not null
    )
  `);

  const applied = new Set(
    (db.prepare('select version from schema_migrations').all() as Array<{ version: string }>).map(
      (r) => r.version,
    ),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];
  for (const file of files) {
    const version = file.slice(0, -'.sql'.length);
    if (applied.has(version)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    if (containsTransactionControl(sql)) {
      throw new Error(
        `migration ${version} failed: migration SQL must not contain COMMIT or ROLLBACK — the runner owns the transaction boundary`,
      );
    }

    db.exec('begin');
    try {
      db.exec(sql);
      db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(
        version,
        new Date().toISOString(),
      );
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
    newlyApplied.push(version);
  }

  return newlyApplied;
}

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './connection.ts';

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
    db.exec('begin');
    try {
      db.exec(sql);
      db.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(
        version,
        new Date().toISOString(),
      );
      db.exec('commit');
    } catch (cause) {
      db.exec('rollback');
      throw new Error(`migration ${version} failed: ${(cause as Error).message}`, { cause });
    }
    newlyApplied.push(version);
  }

  return newlyApplied;
}

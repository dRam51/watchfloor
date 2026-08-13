import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export interface OpenOptions {
  /** Read-only connections are how the trading bot is isolated (§8.2). */
  readOnly?: boolean;
}

export function openDb(path: string, opts: OpenOptions = {}): Db {
  const readOnly = opts.readOnly ?? false;
  const db = new DatabaseSync(path, { readOnly });

  // A read-only connection cannot change journal mode; the writer sets it once
  // and it persists in the file header.
  if (!readOnly) {
    db.exec('pragma journal_mode = WAL');
  }
  db.exec('pragma busy_timeout = 5000');
  db.exec('pragma foreign_keys = ON');
  // Unlike journal_mode, this is a connection-level flag, not a file write --
  // it resets to SQLite's default (OFF) on every new connection, so it goes
  // here with the other per-connection pragmas rather than inside the
  // readOnly guard above. Without it, the implicit DELETE that SQLite runs to
  // resolve an INSERT OR REPLACE primary-key conflict does not fire BEFORE
  // DELETE triggers, so items_no_delete / item_scores_no_delete /
  // item_clusters_no_delete (db/migrations/0001_init.sql) never see it: a
  // REPLACE naming an existing id silently destroys the prior append-only
  // version with no error and a clean foreign_key_check. See
  // tests/db/migrate.test.ts, "0001_init append-only triggers".
  db.exec('pragma recursive_triggers = ON');

  return db;
}

export function closeDb(db: Db): void {
  db.close();
}

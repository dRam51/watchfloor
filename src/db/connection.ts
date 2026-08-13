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

  return db;
}

export function closeDb(db: Db): void {
  db.close();
}

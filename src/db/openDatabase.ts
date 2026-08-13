import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb, type Db } from '../db/connection.ts';

export class DatabaseOpenError extends Error {
  constructor(dbPath: string, cause: unknown) {
    super(
      `failed to open database at WF_DB_PATH=${dbPath} (resolved: ${resolve(dbPath)}): ` +
        `${(cause as Error).message}`,
      { cause },
    );
    this.name = 'DatabaseOpenError';
  }
}

/**
 * Opens the entrypoint's database, creating only its own parent directory
 * first — node:sqlite does not create missing parent directories itself
 * (confirmed: ERR_SQLITE_ERROR, errcode 14 SQLITE_CANTOPEN), so a clean
 * checkout would otherwise fail before ever reaching a health check.
 *
 * Deliberately narrow: this does NOT also create WF_DATA_DIR or WF_LOG_DIR.
 * Auto-creating every configured directory turns a typo'd env var into a
 * silently-healthy empty tree instead of a loud failure naming the bad path
 * (see src/config/env.ts's relativePath comment: "reject it here rather
 * than at 3am on the target machine"). WF_LOG_DIR in particular has no
 * writer anywhere in the codebase yet, so creating it would just be
 * speculative infrastructure for a feature that doesn't exist. Do not
 * "helpfully" restore either call here.
 *
 * Any failure to open — wrong path, permissions, a path that resolves to
 * something that isn't a valid database file — is rethrown as a
 * DatabaseOpenError naming the resolved path, so a genuine misconfiguration
 * still surfaces immediately instead of disappearing into what looks like a
 * healthy empty database.
 */
export function openDatabase(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  try {
    return openDb(dbPath);
  } catch (cause) {
    throw new DatabaseOpenError(dbPath, cause);
  }
}

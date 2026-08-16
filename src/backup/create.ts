/**
 * Backup of the SQLite corpus (M6).
 *
 * ## Why this is the urgent piece of M6
 *
 * `data/wf.db` is gitignored, correctly — it is a 61 MB binary that would
 * bloat history and changes on every poll. The consequence is that **git holds
 * none of it**: 11,016 items, 12,232 entity rows, every fetch state, every
 * score, every clustering run. A clean checkout gives you the code and an empty
 * database. Everything this system has observed lives in exactly one file, on
 * exactly one disk.
 *
 * ## What this protects against, and what it does NOT
 *
 * Be precise about this, because a backup that is trusted for more than it does
 * is worse than none.
 *
 * **Protects against:** a bad migration, a corrupted write, an accidental
 * `npm run migrate` against the wrong file, a schema change that loses data, an
 * experiment that went wrong. These are the realistic failures, and a
 * same-machine copy answers all of them.
 *
 * **Does NOT protect against:** disk failure, theft, or the laptop going in a
 * river. A backup on the same disk as the original is not disaster recovery,
 * and calling it that is how people discover they had none. **Copy the file off
 * the machine** — the whole design of the deliverable is that migration is one
 * file copy, and that property is what makes off-machine storage trivial.
 *
 * **Does NOT include `.env`.** Secrets stay in one place (§12), and a backup
 * file that carries them changes how the file itself must be handled — it could
 * no longer be dropped in cloud storage without thought. `.env.example`
 * documents every variable; the runbook says what to recreate.
 *
 * ## `VACUUM INTO`, not a file copy
 *
 * The database runs in WAL mode, so recent writes live in `wf.db-wal` rather
 * than in `wf.db`. `cp wf.db backup.db` on a live database therefore silently
 * loses whatever has not been checkpointed, and produces a file that opens
 * cleanly and is missing rows — the worst possible failure, because nothing
 * complains. `VACUUM INTO` takes a read transaction and writes one consistent,
 * fully-checkpointed file. It is also what every scratch copy in this project's
 * live-verification work already uses.
 *
 * ## The backup is verified by READING it
 *
 * `VACUUM INTO` succeeding is not evidence the result is usable. This module
 * opens the file it just wrote, runs `pragma integrity_check`, and compares the
 * row count of **every** table against the source. A backup nobody has read is
 * a hypothesis, and this project's standing lesson is that a milestone is not
 * done until it has been run against reality.
 *
 * ## Nothing is ever deleted
 *
 * `CLAUDE.md`'s first standing rule. This module writes and reports; it has no
 * rotation, no `--keep=N`, and no `fs.unlink`. `listBackups` exists so an
 * operator can see what has accumulated and decide themselves, the same stance
 * `vault prune` takes — where deleting is a separate, explicit, dry-run-first
 * command that must be told exactly what it is allowed to remove.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupOptions {
  /** The live corpus. Read, never written. */
  readonly dbPath: string;
  /** Where the backup file lands. Created if missing. */
  readonly outDir: string;
  /** Canonical UTC instant. Injected, never `Date.now()` — see `backupFileName`. */
  readonly now: string;
  /** The zone the filename's calendar day is expressed in. `WF_TZ`, never the host zone. */
  readonly tz: string;
}

export interface TableComparison {
  readonly name: string;
  readonly source: number;
  readonly backup: number;
}

export interface BackupVerification {
  /** SQLite's own answer, verbatim. Anything but `ok` is a refusal. */
  readonly integrityCheck: string;
  /** Every user table, compared. Not a sample. */
  readonly tables: readonly TableComparison[];
  /** Human-readable descriptions of what disagreed. Empty means verified. */
  readonly mismatches: readonly string[];
  readonly verified: boolean;
}

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly verification: BackupVerification;
}

export interface BackupListing {
  readonly path: string;
  readonly bytes: number;
}

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The calendar day and wall-clock time in `tz`, as `YYYY-MM-DD-HHmmss`.
 *
 * Derived from the injected instant via `Intl`, never from the host zone: a
 * Linux target defaults to UTC, and a backup taken at 22:30 New York time would
 * otherwise be filed under the following day — which is exactly the kind of
 * quiet mislabelling §12 warns about for schedules, applied to filenames.
 */
export function backupFileName(now: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // `hour` can be "24" at midnight in some locales/zones under hour12:false.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `wf-${get('year')}-${get('month')}-${get('day')}-${hour}${get('minute')}${get('second')}.db`;
}

/** Every user table, in a stable order. `sqlite_%` internals are SQLite's, not ours. */
function userTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `select name from sqlite_master
        where type = 'table' and name not like 'sqlite_%'
        order by name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function countRows(db: DatabaseSync, table: string): number {
  // The table name comes from sqlite_master, not from a caller, so it cannot be
  // attacker-controlled -- but it still cannot be bound as a parameter, so it is
  // quoted rather than interpolated bare.
  const row = db.prepare(`select count(*) as c from "${table.replaceAll('"', '""')}"`).get() as {
    c: number;
  };
  return row.c;
}

/**
 * Writes one consistent, verified copy of the corpus and returns what it did.
 *
 * Throws `BackupError` rather than returning a failed result: a backup that did
 * not verify is not a backup, and a caller that has to remember to check a
 * boolean is a caller that will eventually forget.
 */
export function createBackup(options: BackupOptions): BackupResult {
  const { dbPath, outDir, now, tz } = options;

  if (!CANONICAL_TIMESTAMP.test(now)) {
    throw new BackupError(`now must be a canonical UTC timestamp, got ${JSON.stringify(now)}`);
  }
  if (!existsSync(dbPath)) {
    throw new BackupError(`no database at ${JSON.stringify(dbPath)} — nothing to back up`);
  }

  mkdirSync(outDir, { recursive: true });

  // A second run in the same second must not overwrite the first. Overwriting
  // is deleting, and this module does not delete.
  const base = backupFileName(now, tz);
  let target = join(outDir, base);
  let suffix = 1;
  while (existsSync(target)) {
    target = join(outDir, base.replace(/\.db$/, `-${suffix}.db`));
    suffix += 1;
  }

  const source = new DatabaseSync(dbPath, { readOnly: false });
  let tables: string[];
  let sourceCounts: Map<string, number>;
  try {
    // VACUUM INTO cannot run inside a transaction and needs a writable handle
    // for its read lock, but writes nothing to the source. The literal is
    // escaped for the same reason the table name above is.
    source.exec(`vacuum into '${target.replaceAll("'", "''")}'`);
    tables = userTables(source);
    sourceCounts = new Map(tables.map((t) => [t, countRows(source, t)]));
  } catch (cause) {
    throw new BackupError(`could not copy ${dbPath} to ${target}: ${(cause as Error).message}`);
  } finally {
    source.close();
  }

  const verification = verifyBackup(target, tables, sourceCounts);
  if (!verification.verified) {
    throw new BackupError(
      `backup written to ${target} but FAILED verification: ${verification.mismatches.join('; ')}. ` +
        `The file has been left in place for inspection — nothing is deleted here.`,
    );
  }

  return {
    path: target,
    bytes: statSync(target).size,
    createdAt: now,
    verification,
  };
}

/** Opens the written file and proves it is readable and complete. */
function verifyBackup(
  path: string,
  tables: readonly string[],
  sourceCounts: ReadonlyMap<string, number>,
): BackupVerification {
  const mismatches: string[] = [];
  let integrityCheck = 'not run';
  const comparisons: TableComparison[] = [];

  let backup: DatabaseSync;
  try {
    backup = new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    return {
      integrityCheck: 'could not open',
      tables: [],
      mismatches: [`the backup could not be opened at all: ${(cause as Error).message}`],
      verified: false,
    };
  }

  try {
    const row = backup.prepare('pragma integrity_check').get() as Record<string, unknown>;
    integrityCheck = String(Object.values(row)[0] ?? 'no answer');
    if (integrityCheck !== 'ok') mismatches.push(`integrity_check said ${JSON.stringify(integrityCheck)}`);

    const backupTables = new Set(userTables(backup));
    for (const table of tables) {
      if (!backupTables.has(table)) {
        mismatches.push(`table ${table} is missing from the backup`);
        continue;
      }
      const expected = sourceCounts.get(table) ?? 0;
      const actual = countRows(backup, table);
      comparisons.push({ name: table, source: expected, backup: actual });
      if (actual !== expected) {
        mismatches.push(`${table}: source has ${expected} row(s), backup has ${actual}`);
      }
    }
  } catch (cause) {
    mismatches.push(`the backup could not be read: ${(cause as Error).message}`);
  } finally {
    backup.close();
  }

  return { integrityCheck, tables: comparisons, mismatches, verified: mismatches.length === 0 };
}

/**
 * What is already there, newest first. Reports; never removes.
 *
 * A missing directory is an empty list rather than an error — "no backups yet"
 * is an ordinary state on a fresh machine, and the caller that most needs this
 * answer is the one about to take the first one.
 */
export function listBackups(outDir: string): BackupListing[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((name) => name.startsWith('wf-') && name.endsWith('.db'))
    .map((name) => {
      const path = join(outDir, name);
      return { path, bytes: statSync(path).size };
    })
    .sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
}

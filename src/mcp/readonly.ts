/**
 * The bot's database handle (M5 task 10).
 *
 * §8.2: *"Isolation that still holds: separate process, separate credential,
 * separate DB user (read-only role). The bot gets no write path."*
 *
 * SQLite has no database users, so "read-only role" has to be built out of
 * something else. This module is that something: `SQLITE_OPEN_READONLY`
 * underneath, and a wrapper on top that is the **only** door to it.
 *
 * ---------------------------------------------------------------------------
 * Why the wrapper is not belt-and-braces — the measured finding
 * ---------------------------------------------------------------------------
 * `SQLITE_OPEN_READONLY` refuses INSERT, UPDATE, DELETE, CREATE, DROP and
 * `pragma user_version = ...`, all with `attempt to write a readonly database`.
 * It does **not** refuse `VACUUM INTO`, which was run against a real read-only
 * connection during this task and wrote an 8 KiB file containing a complete,
 * readable copy of the corpus at a path the caller chose. See
 * tests/mcp/readonly.test.ts, "performs a real disk write via VACUUM INTO".
 *
 * §8.2's claim is not "the bot cannot corrupt the dashboard's database" — it
 * is "the bot gets no write path". A statement that copies the whole corpus to
 * an arbitrary path is a write path, and the open flag leaves it wide open. So
 * the statement allowlist below is load-bearing, and removing it does not
 * merely weaken a redundant check.
 *
 * ATTACH is refused for the neighbouring reason. It is *allowed* on a
 * read-only connection (measured); the attached database inherits the
 * read-only flag, so writes into it still fail — but ATTACH is an
 * open-any-file-on-disk primitive, and a read handle on an arbitrary file is
 * exactly the reach this boundary exists to deny.
 *
 * ---------------------------------------------------------------------------
 * Why `read_score` is refused HERE, not only on the wire
 * ---------------------------------------------------------------------------
 * §8.2: *"The bot sees `signal_score` only — never `read_score`."* The
 * serializer (src/mcp/serialize.ts) refuses to emit it. This layer refuses to
 * **read** it, so the value never enters the process. Two independent layers
 * over one list (src/mcp/fields.ts), which is as close to a column-level GRANT
 * as SQLite gets.
 *
 * `select *` is refused for the reason that makes the column rule real: a star
 * expands to `read_score` without ever naming it. Name your columns.
 */

import { openDb, closeDb, type Db } from '../db/connection.ts';
import { forbiddenPhraseFor } from './fields.ts';

export type SqlRefusalReason =
  | 'not_a_select'
  | 'multiple_statements'
  | 'star_result_column'
  | 'forbidden_identifier';

// Fields are DECLARED and assigned, never a TypeScript parameter property
// (`constructor(readonly reason: ...)`). Node 26 runs `src/bin/*.ts` through
// strip-only type removal, which rejects parameter properties outright with
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX -- while vitest's esbuild transpiles them
// happily. So the first draft of this file passed every unit test and killed
// the real process on its first line of work. Found by tests/mcp/bin.test.ts,
// pinned by tests/mcp/sourceProperties.test.ts, and it is why every other
// error class in this repository (src/vault/session.ts and friends) is written
// this way too.
export class SqlRefusedError extends Error {
  readonly reason: SqlRefusalReason;
  constructor(reason: SqlRefusalReason, detail: string) {
    super(`read-only corpus refused this SQL (${reason}): ${detail}`);
    this.name = 'SqlRefusedError';
    this.reason = reason;
  }
}

/** node:sqlite's anonymous-parameter value type, spelled out rather than imported. */
export type SqlParam = string | number | bigint | null | Uint8Array;

/** `--` to end of line, and `/* ... *\/` blocks. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * Blanks single-quoted literals so their contents cannot be mistaken for
 * structure. `select ';'` is one statement; `select 'a*b'` selects no star.
 * SQLite escapes a quote by doubling it, which the alternation handles.
 */
function blankStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** `"col"`, `[col]` and `` `col` `` all read as the bare identifier `col`. */
function unquoteIdentifiers(sql: string): string {
  return sql.replace(/["`[\]]/g, ' ');
}

const STATEMENT_START = /^\s*(?:with|select)\b/i;

/**
 * A `*` in RESULT-COLUMN position, which is not the same thing as a `*`
 * character. `select signal_score * 2` multiplies and must be allowed; the
 * first draft of this rule keyed on surrounding whitespace and refused it.
 *
 * The discriminator is what comes immediately before the star: a result column
 * begins after `select` (optionally `distinct`/`all`) or after a comma, and a
 * multiplication is preceded by a complete operand. `count(*)` never reaches
 * here — its parenthesised star is rewritten away first.
 */
const STAR_AFTER_SELECT = /\bselect\s+(?:distinct\s+|all\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?\*(?=\s|,|$)/i;
const STAR_AFTER_COMMA = /,\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?\*(?=\s|,|$)/;

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Refuses any SQL that is not a single read, or that names something §8.2 puts
 * out of reach.
 *
 * The forbidden-identifier scan runs over the **raw** text, before comments or
 * literals are removed, while the structural checks run over the cleaned text.
 * That asymmetry is deliberate: a comment cannot smuggle a real column
 * reference past SQLite, but `read_score` appearing in a comment or a literal
 * is a sign of someone working around this guard, and the blunter rule — *the
 * string may not appear in the bot's SQL at all, in any position or casing* —
 * is the one that is easy to state and impossible to sneak past.
 */
export function assertReadOnlySql(sql: string): void {
  for (const match of sql.matchAll(IDENTIFIER)) {
    const phrase = forbiddenPhraseFor(match[0]);
    if (phrase !== null) {
      throw new SqlRefusedError(
        'forbidden_identifier',
        `\`${match[0]}\` matches the forbidden field rule "${phrase}" (src/mcp/fields.ts)`,
      );
    }
  }

  const cleaned = unquoteIdentifiers(blankStringLiterals(stripComments(sql)));

  if (!STATEMENT_START.test(cleaned)) {
    throw new SqlRefusedError('not_a_select', `only \`select\` and \`with\` are allowed: ${sql.trim().slice(0, 120)}`);
  }

  // One trailing semicolon is punctuation. A semicolon with anything after it
  // is a second statement: node:sqlite's `prepare` compiles only the first,
  // but `exec` runs them all, and a later transport reaching for `exec` should
  // not be what discovers that.
  const withoutTrailer = cleaned.replace(/;\s*$/, '');
  if (withoutTrailer.includes(';')) {
    throw new SqlRefusedError('multiple_statements', `exactly one statement is allowed: ${sql.trim().slice(0, 120)}`);
  }

  // `count(*)` / `count( * )` -- a star inside its own parentheses expands to
  // nothing and is not a result column.
  const starScan = withoutTrailer.replace(/\(\s*\*\s*\)/g, '()');
  if (STAR_AFTER_SELECT.test(starScan) || STAR_AFTER_COMMA.test(starScan)) {
    throw new SqlRefusedError(
      'star_result_column',
      'name the columns: `select *` expands to read_score without naming it',
    );
  }
}

/**
 * The bot's whole view of the database.
 *
 * Four own properties and nothing else — no `exec`, no `prepare`, no
 * `loadExtension`, and no field holding the underlying handle. The
 * `DatabaseSync` lives in this function's closure, so a caller that reaches
 * for `(corpus as any).db` to route around `assertReadOnlySql` finds
 * `undefined`. "The wrapper is the only door" is then a fact about the object
 * rather than a rule in a comment, and tests/mcp/readonly.test.ts asserts the
 * exact key set so a fifth property cannot be added without a red test.
 */
export interface ReadOnlyCorpus {
  readonly path: string;
  all(sql: string, ...params: SqlParam[]): Array<Record<string, unknown>>;
  get(sql: string, ...params: SqlParam[]): Record<string, unknown> | undefined;
  close(): void;
}

export function openReadOnlyCorpus(path: string): ReadOnlyCorpus {
  const db: Db = openDb(path, { readOnly: true });

  return {
    path,
    all(sql: string, ...params: SqlParam[]) {
      assertReadOnlySql(sql);
      // Cast target is an inline type literal, not a named interface -- see
      // src/cluster/store.ts:88-100 on the node:sqlite TS2352 quirk (a named
      // interface here fails tsc; a structurally identical inline literal
      // does not).
      return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    },
    get(sql: string, ...params: SqlParam[]) {
      assertReadOnlySql(sql);
      const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      return row;
    },
    close() {
      closeDb(db);
    },
  };
}

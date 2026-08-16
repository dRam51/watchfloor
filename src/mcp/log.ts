/**
 * Query logging (M5 task 10).
 *
 * §8.2 asks for it in one clause and says nothing about what it should
 * contain, which is the part that actually needed deciding.
 *
 * ---------------------------------------------------------------------------
 * WHERE: stderr, one JSON object per line
 * ---------------------------------------------------------------------------
 * Not a choice so much as a constraint. The stdio binding: *"The server MUST
 * NOT write anything to its `stdout` that is not a valid MCP message"*, and
 * *"The server MAY write UTF-8 strings to `stderr` for any logging purposes"*.
 * A `console.log` in this process corrupts the protocol; a `console.error` is
 * explicitly sanctioned. §12's supervisor captures stderr, which is where an
 * operator already looks.
 *
 * Not a file: `WF_LOG_DIR` has no writer anywhere in this codebase (see
 * src/db/openDatabase.ts's comment on why it is deliberately not created), and
 * inventing rotation and retention here would be a second feature smuggled
 * into a skeleton.
 *
 * ---------------------------------------------------------------------------
 * WHAT: argument NAMES and a digest — never the values
 * ---------------------------------------------------------------------------
 * The task brief flags this directly: *"logging query parameters may capture
 * the bot's strategy."* It does. `get_items_for_entity(entity: "Cl0p")` is a
 * statement about what the operator is watching; an `as_of` sweep is a
 * statement about what they are backtesting. §8.2's premise is that the bot is
 * **isolated** from Watchfloor, and a log that transcribes its queries inverts
 * that — this process would sit accumulating a dossier on the other side of
 * the boundary, in a file, on a machine whose repository is public. CLAUDE.md
 * already treats `config/portfolio.yaml` as exactly this hazard.
 *
 * So: the log records the method, the tool, the argument **names**, the
 * outcome, the duration, and a 16-hex digest of the canonicalised arguments.
 * The digest is what keeps it operationally useful — identical queries digest
 * identically, so "the bot asked the same thing 400 times this hour" is still
 * visible, and so is "it never asks the same thing twice", without either
 * answer containing a ticker.
 *
 * `WF_MCP_LOG_ARGS=1` opts into full argument values, because a digest-only
 * log is genuinely hard to debug against. It is off by default, it is the
 * operator's explicit choice, and **it still cannot log the credential**:
 * `_meta` is stripped at every depth before anything is written, in both
 * modes, and tests/mcp/log.test.ts asserts it.
 */

import { createHash } from 'node:crypto';

export type QueryOutcome = 'ok' | 'error' | 'unauthorized' | 'refused';

export interface QueryLogRecord {
  /** Canonical `YYYY-MM-DDTHH:mm:ss.sssZ`, matching every other timestamp in this system. */
  readonly at: string;
  readonly id: string | number | null;
  readonly method: string;
  /** The tool name for `tools/call`; `null` for every other method. */
  readonly tool: string | null;
  readonly outcome: QueryOutcome;
  readonly durationMs: number;
  /** The JSON-RPC error code, when the outcome was not `ok`. */
  readonly code?: number;
  /** How many rows the tool returned, when it is a countable answer. */
  readonly resultRows?: number;
  readonly clientName?: string | null;
  readonly protocolVersion?: string | null;
  /** The tool's own arguments. Names and a digest are logged; values are not, unless opted in. */
  readonly args?: Record<string, unknown>;
}

export interface QueryLog {
  record(entry: QueryLogRecord): void;
}

/**
 * Removes `_meta` at every depth.
 *
 * `_meta` is where the credential travels (src/mcp/auth.ts), and where every
 * future protocol-level field will travel too. Stripping the whole object
 * rather than the one known key means a key added by a later revision is
 * excluded by default — the same fail-closed direction as src/api/auth.ts's
 * exemption list.
 */
export function redactMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMeta);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === '_meta') continue;
    out[key] = redactMeta(entry);
  }
  return out;
}

/** Key-sorted JSON, so `{a,b}` and `{b,a}` are one query rather than two. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A 16-hex fingerprint of the arguments, `_meta` removed first.
 *
 * Truncated from sha256: this is a correlation key, not a commitment, and 64
 * bits is far past what an hourly log needs to keep distinct queries distinct.
 * It is deliberately NOT reversible — that is the whole point.
 */
export function digestArguments(args: unknown): string {
  return createHash('sha256').update(canonicalJson(redactMeta(args)), 'utf8').digest('hex').slice(0, 16);
}

export interface QueryLogOptions {
  /** Where a line goes. `src/bin/mcp.ts` passes stderr; tests pass an array. */
  readonly write: (line: string) => void;
  /** `WF_MCP_LOG_ARGS=1`. Off by default — see this file's header. */
  readonly includeArguments?: boolean;
}

export function createQueryLog(options: QueryLogOptions): QueryLog {
  const includeArguments = options.includeArguments ?? false;

  return {
    record(entry: QueryLogRecord): void {
      const args = entry.args;
      const redacted = args === undefined ? undefined : (redactMeta(args) as Record<string, unknown>);

      const line: Record<string, unknown> = {
        at: entry.at,
        id: entry.id,
        method: entry.method,
        tool: entry.tool,
        outcome: entry.outcome,
        durationMs: entry.durationMs,
      };
      if (entry.code !== undefined) line.code = entry.code;
      if (entry.resultRows !== undefined) line.resultRows = entry.resultRows;
      if (entry.clientName !== undefined) line.clientName = entry.clientName;
      if (entry.protocolVersion !== undefined) line.protocolVersion = entry.protocolVersion;
      if (redacted !== undefined) {
        line.argKeys = Object.keys(redacted).sort();
        line.argDigest = digestArguments(args);
        if (includeArguments) line.arguments = redacted;
      }

      // JSON.stringify escapes every newline, so one record is always one
      // line even when an argument value contains one -- same framing
      // invariant the transport relies on.
      options.write(JSON.stringify(line));
    },
  };
}

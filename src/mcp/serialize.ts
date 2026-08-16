/**
 * The last thing every bot-facing payload passes through (M5 task 10).
 *
 * §8.2 names a list of things Watchfloor must never expose, and the task
 * brief's standard for enforcing it is worth quoting because it shaped this
 * module: *"A response serializer that cannot emit `read_score` is better than
 * a convention that says not to."*
 *
 * So the guard lives in the dispatcher (src/mcp/server.ts), not in the tools.
 * Task 11 writes five tools; none of them calls this, and none of them can
 * skip it. A tool added in M6 by someone who never read §8.2 inherits the
 * prohibition, which is the same fail-closed shape as src/api/auth.ts's
 * root-instance hook: the property belongs to the boundary, not to the thing
 * passing through it.
 *
 * ---------------------------------------------------------------------------
 * REFUSE, never strip
 * ---------------------------------------------------------------------------
 * Deleting the offending field would produce a response the bot reads as
 * "Watchfloor has no opinion on that", which is indistinguishable from a
 * correct answer and leaves the bug in the tree forever. Throwing turns a leak
 * attempt into a visible, logged protocol error naming the field and the rule
 * it broke. A guard whose failure mode is silence is not a guard.
 *
 * ---------------------------------------------------------------------------
 * The stated limit
 * ---------------------------------------------------------------------------
 * This checks field NAMES, not values, because §8.2's rule is about *"any
 * field whose name implies a recommendation"* and because checking values
 * would corrupt real data: the corpus contains genuine headlines using the
 * word "bearish", and an item title is content the system relays rather than a
 * label it computed. A tool that returned `{ label: 'bullish' }` would pass
 * here. That residual is recorded in the task report rather than papered over.
 */

import { forbiddenPhraseFor } from './fields.ts';

export class ForbiddenFieldError extends Error {
  constructor(
    readonly path: string,
    readonly field: string,
    readonly phrase: string,
  ) {
    // The VALUE is deliberately absent from this message. An error raised
    // because a field must not leave the process must not itself carry the
    // thing it stopped -- it is about to be logged and returned on the wire.
    super(
      `refused to serialize \`${path}\`: the field name \`${field}\` matches the forbidden rule ` +
        `"${phrase}" (§8.2, src/mcp/fields.ts)`,
    );
    this.name = 'ForbiddenFieldError';
  }
}

export class UnserializableValueError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`refused to serialize \`${path}\`: ${detail}`);
    this.name = 'UnserializableValueError';
  }
}

/**
 * A JSON value, spelled out so the walk below is total rather than "everything
 * else is probably fine".
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function describeType(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'NaN becomes null on the wire' : 'a non-finite number becomes null on the wire';
  }
  if (value === undefined) return 'undefined is silently dropped by JSON.stringify';
  if (typeof value === 'bigint') return 'JSON.stringify throws on a bigint';
  if (typeof value === 'function') return 'a function is silently dropped by JSON.stringify';
  if (typeof value === 'symbol') return 'a symbol is silently dropped by JSON.stringify';
  return `values of type ${typeof value} have no JSON form`;
}

function walk(value: unknown, path: string, seen: Set<object>): void {
  if (value === null) return;

  const type = typeof value;
  if (type === 'boolean' || type === 'string') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new UnserializableValueError(path, describeType(value));
    return;
  }
  if (type !== 'object') throw new UnserializableValueError(path, describeType(value));

  const obj = value as object;
  // Named rather than left to blow the stack: a cycle in a tool's result is a
  // bug report, and `Maximum call stack size exceeded` is not one.
  if (seen.has(obj)) throw new UnserializableValueError(path, 'a reference cycle has no JSON form');
  seen.add(obj);

  if (Array.isArray(obj)) {
    obj.forEach((entry, index) => walk(entry, `${path}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(obj)) {
      const child = path === '' ? key : `${path}.${key}`;
      const phrase = forbiddenPhraseFor(key);
      if (phrase !== null) throw new ForbiddenFieldError(child, key, phrase);
      if (entry === undefined) throw new UnserializableValueError(child, describeType(entry));
      walk(entry, child, seen);
    }
  }

  // Removed on the way back up: a value legitimately appearing twice in a tree
  // (the same frozen constant on two rows) is not a cycle, and treating it as
  // one would refuse a correct payload.
  seen.delete(obj);
}

/**
 * Returns `value` unchanged if it may cross the boundary, and throws if it may
 * not. An identity function with a precondition, not a transform — the caller
 * gets back exactly what it passed, so nothing downstream has to wonder
 * whether the payload was quietly edited.
 */
export function sealBotPayload<T>(value: T, rootPath = ''): T {
  walk(value, rootPath, new Set());
  return value;
}

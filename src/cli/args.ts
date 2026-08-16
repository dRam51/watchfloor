/**
 * `watchfloor` argument parsing (M5 task 12) — a pure function of `argv`.
 *
 * §8.1 names two commands explicitly, `watchfloor vault verify` and
 * `watchfloor vault prune`, and M5's scope line says "CLI" without enumerating
 * the rest. What the rest turned out to be is in {@link ../cli/help.ts}: the
 * `vault` group is handled in this process, and **every other command is a
 * delegation to the `src/bin/*.ts` entrypoint that already exists**, spawned
 * rather than reimplemented.
 *
 * That split is why parsing is shaped the way it is. A delegated command's
 * flags are read by the child and **never by this layer** — `score --force`
 * and `suggest --json` already mean something in `src/bin/`, and a CLI that
 * re-declared them would be a second, drifting copy of an interface it does
 * not own. So `argv` after a delegated command name is passed through
 * verbatim, and only the `vault` group is parsed here.
 *
 * ## Node's own parser, and no dependency
 *
 * `node:util`'s `parseArgs` is used in strict mode, which is what turns an
 * unknown flag and a stray positional into a refusal rather than a silently
 * ignored token. `src/bin/suggest.ts` already uses it. An arg-parsing library
 * would be a new runtime dependency for a surface of six flags.
 *
 * ## `--help` is answered before anything else is even validated
 *
 * `vault prune --apply --expect=3 --help` prints help and prunes nothing. A
 * `--help` that ran the command first would be the worst possible reading of
 * the one command in this system permitted to delete.
 */

import { parseArgs } from 'node:util';

export type HelpTopic = 'root' | 'vault' | 'vault sync' | 'vault verify' | 'vault prune';

export type CliInvocation =
  /** `watchfloor` with nothing after it. Distinct from `--help`: see help.ts. */
  | { readonly kind: 'no-command' }
  | { readonly kind: 'help'; readonly topic: HelpTopic }
  | { readonly kind: 'vault-sync' }
  | { readonly kind: 'vault-verify'; readonly json: boolean }
  | {
      readonly kind: 'vault-prune';
      readonly json: boolean;
      /** Never defaulted true, at any level of this program. */
      readonly apply: boolean;
      /** The count the operator read off a dry run. `null` when not supplied. */
      readonly expect: number | null;
    }
  | { readonly kind: 'delegate'; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'usage-error'; readonly message: string };

const HELP_FLAGS = new Set(['--help', '-h']);

/**
 * A command name becomes a filename under `src/bin/`, so it is checked as one
 * rather than trusted. A separator, a dot or a leading dash is not a command,
 * and treating it as one is how a CLI comes to run an arbitrary file.
 */
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

function usageError(message: string): CliInvocation {
  return { kind: 'usage-error', message };
}

/**
 * `--expect` is the count, and it is deliberately strict: a decimal, a
 * negative, a blank or a stray space is a typo in the one place a typo is
 * expensive, and the honest answer to a typo is a refusal rather than a
 * coerced number.
 */
function parseExpect(raw: string | undefined): number | null | 'invalid' {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) return 'invalid';
  return Number(raw);
}

function parseVault(rest: readonly string[]): CliInvocation {
  const sub = rest[0];
  if (sub === undefined || HELP_FLAGS.has(sub)) return { kind: 'help', topic: 'vault' };

  const args = rest.slice(1);
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    if (sub === 'sync' || sub === 'verify' || sub === 'prune') {
      return { kind: 'help', topic: `vault ${sub}` };
    }
  }

  if (sub === 'sync') {
    if (args.length > 0) return usageError(`vault sync takes no arguments; got ${args.join(' ')}`);
    return { kind: 'vault-sync' };
  }

  if (sub === 'verify') {
    // Named before the generic unknown-flag path, because the reason matters
    // more than the fact. `src/vault/verify.ts` has no repair path and
    // deliberately no option to add one.
    if (args.includes('--fix')) {
      return usageError(
        'vault verify has no --fix: it reports and never repairs. A tool that silently repairs ' +
          'is a tool that silently destroys the day its model of "correct" is wrong, and what it ' +
          "would be operating on is the owner's primary knowledge base.",
      );
    }
    try {
      const { values } = parseArgs({ args: [...args], options: { json: { type: 'boolean' } } });
      return { kind: 'vault-verify', json: values.json === true };
    } catch (err) {
      return usageError((err as Error).message);
    }
  }

  if (sub === 'prune') {
    let values: { json?: boolean; apply?: boolean; expect?: string };
    try {
      ({ values } = parseArgs({
        args: [...args],
        options: {
          json: { type: 'boolean' },
          apply: { type: 'boolean' },
          expect: { type: 'string' },
        },
      }));
    } catch (err) {
      return usageError((err as Error).message);
    }

    const expect = parseExpect(values.expect);
    if (expect === 'invalid') {
      return usageError(
        `--expect must be a whole number of files, and got ${JSON.stringify(values.expect)}. ` +
          'It is the count `vault prune` printed on its dry run.',
      );
    }
    const apply = values.apply === true;
    if (apply && expect === null) {
      return usageError(
        '--apply requires --expect=N, the number of files a dry run just told you it would ' +
          'remove. Run `watchfloor vault prune` first, read the count, and pass it back. If the ' +
          'tree has changed in between, the counts disagree and nothing is deleted.',
      );
    }
    return { kind: 'vault-prune', json: values.json === true, apply, expect };
  }

  return usageError(
    `unknown vault command ${JSON.stringify(sub)}. The vault commands are sync, verify and prune.`,
  );
}

/** Parses `process.argv.slice(2)`. Reads nothing else — no env, no filesystem. */
export function parseCliArgs(argv: readonly string[]): CliInvocation {
  const first = argv[0];
  if (first === undefined) return { kind: 'no-command' };
  if (HELP_FLAGS.has(first) || first === 'help') return { kind: 'help', topic: 'root' };
  if (first === 'vault') return parseVault(argv.slice(1));
  if (!COMMAND_NAME.test(first)) {
    return usageError(
      `${JSON.stringify(first)} is not a command name. Run \`watchfloor --help\` for the list.`,
    );
  }
  return { kind: 'delegate', command: first, args: argv.slice(1) };
}

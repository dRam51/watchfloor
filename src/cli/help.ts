/**
 * `watchfloor --help`, and the command list it is built from (M5 task 12).
 *
 * ## The list is discovered, not written down
 *
 * `src/bin/*.ts` is already the complete set of ways this system can be
 * started — `tests/vault/wiring.test.ts` rests on exactly that fact when it
 * asks whether a symbol is reachable from a way of starting the program. So
 * the CLI reads that directory rather than keeping a second list beside it.
 *
 * A hand-maintained command table is this project's characteristic defect in
 * miniature: it compiles, it is tested, and it silently stops describing
 * reality the day someone adds an entrypoint. M4a's `github_search` adapter
 * was unreachable for exactly that reason — a registry in a composition root
 * that a new source type was never added to. Discovery removes the registry.
 *
 * The descriptions below are still hand-written, because a one-line summary of
 * what `score` does cannot be derived from a filename. An entrypoint with no
 * description is **listed anyway**, with a blank: the command works whether or
 * not anyone has described it, and omitting it would make `--help` lie about
 * what the CLI can run. `tests/cli/help.test.ts` holds the descriptions to
 * completeness separately, where a new entrypoint reads as "describe me"
 * rather than as "you cannot run this".
 */

import { readdirSync } from 'node:fs';
import type { HelpTopic } from './args.ts';

export interface DelegatedCommand {
  /** The command as typed: `ingest`. */
  readonly name: string;
  /** The entrypoint it spawns, as a bare filename: `ingest.ts`. */
  readonly file: string;
  /** One line, or `null` when nobody has written one yet. */
  readonly description: string | null;
}

/**
 * Never delegated:
 *
 * - `watchfloor` is this program. Delegating to it is a fork bomb with extra
 *   steps.
 * - `vault` is handled in this process, and `src/bin/vault.ts` routes *back*
 *   into this CLI, so delegating to it would spawn processes until the OS
 *   refused.
 */
const NOT_DELEGATED = new Set(['watchfloor', 'vault']);

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  migrate: 'apply pending database migrations — the only thing that applies them',
  ingest: 'poll every due source once and store what comes back, then exit',
  score: 'cluster, then score (`--force` rescores everything)',
  rank: 'print the ranked feed per beat, with decay applied at read time',
  suggest: 'propose interest-profile terms from your dismissals (`--json` available)',
  api: 'serve the dashboard API on 127.0.0.1:$WF_API_PORT',
  scheduler: 'the unattended daemon: polls, scores, and writes the vault on cadence',
  // Added by M5 task 10 in the session that landed src/bin/mcp.ts, which is
  // exactly the prompt tests/cli/help.test.ts's completeness check exists to
  // give. Worth stating that this one is not for a human at a terminal: an MCP
  // client spawns it and speaks JSON-RPC over its stdin/stdout, so running it
  // by hand gets a process that waits silently for a protocol message.
  mcp: 'the read-only MCP server for the trading bot — spawned by an MCP client over stdio, not run by hand',
};

/**
 * Every entrypoint in `binDir` that this CLI will spawn.
 *
 * `ext` is a parameter rather than a constant because the compiled tree has
 * `.js` where the source tree has `.ts`, and `run.ts` passes its own module's
 * extension — so the CLI finds its siblings in whichever tree it is running
 * from, with no absolute path and no build-time list.
 */
export function discoverDelegatedCommands(binDir: string, ext: string): DelegatedCommand[] {
  return readdirSync(binDir)
    .filter((file) => file.endsWith(ext))
    .map((file) => ({ file, name: file.slice(0, -ext.length) }))
    .filter(({ name }) => !NOT_DELEGATED.has(name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ file, name }) => ({ name, file, description: DESCRIPTIONS[name] ?? null }));
}

function pad(name: string): string {
  return name.padEnd(16, ' ');
}

const EXIT_CODES = `EXIT CODES (a contract — see src/cli/exit.ts)
  0   the command ran and the answer is good
  1   the command could not run, or the run was refused
  2   the command ran and found something you must look at

  1 and 2 are separate on purpose. A check that has been failing to start for
  three weeks must not look like a vault with one stale temp file in it.`;

const INVOCATION = `  Through npm, which is how this is actually invoked:

      npm run watchfloor -- vault verify
      npm run watchfloor -- vault prune

  The \`--\` is npm's, and everything after it is this program's.`;

function rootHelp(commands: readonly DelegatedCommand[]): string {
  const delegated = commands
    .map((c) => `  ${pad(c.name)}${c.description ?? ''}`.trimEnd())
    .join('\n');

  return `watchfloor — the situational-awareness dashboard's command line.

USAGE
  watchfloor <command> [options]
  watchfloor <command> --help

VAULT (§8.1 — the Obsidian integration; runs in this process)
  ${pad('vault sync')}write daily/, weekly/ and entities/ once, then exit
  ${pad('vault verify')}check §8.1's invariants and report violations. Reports; never repairs
  ${pad('vault prune')}remove what an interrupted sync left behind. A dry run by default,
  ${pad('')}and the only default. Deleting takes --apply --expect=N

EVERYTHING ELSE (delegated to the entrypoint that already owns it)
${delegated}

  These are spawned, not reimplemented: \`watchfloor ingest\` runs exactly the
  file \`npm run ingest\` runs, and every flag after the command name is the
  child's to read, not this program's.

${INVOCATION}

${EXIT_CODES}
`;
}

function vaultHelp(): string {
  return `watchfloor vault — §8.1's Obsidian integration.

  ${pad('vault sync')}write daily/, weekly/ and entities/ once, then exit
  ${pad('vault verify')}check the invariants and report. Never repairs
  ${pad('vault prune')}remove leftovers. Dry run by default

  Watchfloor owns exactly one subtree of the vault, WF_VAULT_ROOT, and never
  writes outside it. With WF_VAULT_ROOT unset — the shipped configuration —
  sync is a clean no-op and verify has nothing to answer.

  \`npm run vault\` with no arguments is \`vault sync\`, for compatibility with
  the script that has always meant that.

${EXIT_CODES}
`;
}

function syncHelp(): string {
  return `watchfloor vault sync — write the managed areas once, then exit.

  Writes the three areas Watchfloor manages, for the day and week it is run in:

    daily/       fully managed: rewritten every run, idempotent overwrite
    weekly/      fully managed: the week's reading note, written on the same terms
    entities/    managed block only: everything outside the markers is yours

  saved/ is NOT written here. An item reaches saved/ when you save it in the
  dashboard, it is written exactly once, and no job — including this one — ever
  touches it again.

  This ignores the daemon's cadence deliberately: you asked, so all three areas
  are written whatever day it is. That also makes it the way to produce a
  weekly note out of band.

EXIT CODES
  0   the sync ran — and also when no vault is configured, which is the
      shipped state and is a clean no-op rather than a failure
  1   a vault is configured and could not be written
`;
}

function verifyHelp(): string {
  return `watchfloor vault verify — check §8.1's invariants and report violations.

  OPTIONS
    --json    the full report as JSON, including every finding code

  It reports. It never repairs, and there is deliberately no --fix. A tool that
  silently repairs is a tool that silently destroys the day its model of
  "correct" is wrong, and what it would be operating on is a knowledge base
  with years of hand-written notes and no backup in this system.

  Findings come at three severities, and \`info\` is not a minor problem — it is
  "this is what a healthy vault looks like, and you should be able to see it":
  your own hand-authored notes, an entity note we appended a block to, the
  permanent second directory entry every saved/ note carries. Only warnings and
  errors change the exit code.

EXIT CODES
  0   scanned, and nothing above \`info\`
  1   nothing was scanned: no vault configured, or the vault is not mounted
  2   scanned, and at least one warning or error
`;
}

function pruneHelp(): string {
  return `watchfloor vault prune — remove what an interrupted sync left behind.

  A DRY RUN IS THE DEFAULT, AND THE ONLY DEFAULT.

  OPTIONS
    --apply         actually delete. Requires --expect=N
    --expect=N      the number of files the dry run just said it would remove
    --json          the full report as JSON

  DELETING IS TWO STEPS, ON PURPOSE

      watchfloor vault prune                      # look. prints N candidates
      watchfloor vault prune --apply --expect=N   # delete exactly those N

  N is not knowable without having read the dry run, which is the point: this
  is the one command in the system permitted to delete anything, against a
  standing rule that nothing is ever deleted. And the check is not ceremony —
  if the tree changed between the two commands, the counts disagree and
  nothing is removed.

  WHAT IT WILL REMOVE
    - a crash-leftover temp file that names no note and is over an hour old
    - the spare directory entry a saved/ note's link(2) left behind, and only
      when the note it belongs to is proven to be the same inode

  WHAT IT WILL NEVER REMOVE, AT ANY SETTING
    - anything outside the Watchfloor subtree, or reached through a symlink
    - anything without Watchfloor frontmatter — anything you wrote
    - any saved/ note. Written once, never touched again by any job
    - any entities/ note. It can carry your prose outside the managed block
    - any directory
    - stale daily/ and weekly/ notes: removing those needs a manifest of what
      the corpus still covers, and this CLI deliberately supplies none. See
      docs/cli.md — a naive manifest deletes the whole archive

EXIT CODES
  0   nothing to remove, or --apply removed everything it proposed
  1   could not run: no vault configured, not mounted, --expect disagreed,
      or the run exceeded the deletion cap and was refused whole
  2   a dry run found candidates, or an applied run left one behind
`;
}

export function renderHelp(topic: HelpTopic, commands: readonly DelegatedCommand[]): string {
  switch (topic) {
    case 'root':
      return rootHelp(commands);
    case 'vault':
      return vaultHelp();
    case 'vault sync':
      return syncHelp();
    case 'vault verify':
      return verifyHelp();
    case 'vault prune':
      return pruneHelp();
  }
}

/**
 * The vault command group, under the name it has always had (M5 task 15,
 * extended by task 12):
 *
 *   npm run vault                -- sync, exactly as before
 *   npm run vault -- verify      -- §8.1's invariants, reported
 *   npm run vault -- prune       -- dry run by default
 *
 * ## Why a bare `npm run vault` still means `sync`
 *
 * That is what this script has meant since task 15, `package.json` and the
 * §12 runbook say so, and a script whose meaning changes under an operator is
 * worse than one that is slightly inconsistent with its sibling. `watchfloor
 * vault`, which has no history to keep, prints the group's help instead.
 *
 * ## Why the body moved
 *
 * Task 9's report ended on the open item this file closes: *"neither `verify`
 * nor `prune` has a CLI caller. `src/bin/vault.ts` is a **sync** entrypoint
 * only."* The three commands now live together in `src/cli/vault.ts` and are
 * reachable under two names — `npm run vault -- verify` and `watchfloor vault
 * verify` — rather than one implementation being copied into the other. The
 * sync body was moved unchanged, including every string it prints, which is
 * what let `tests/vault/bin.test.ts` verify the move without being edited.
 */

import { runCli } from '../cli/run.ts';

const args = process.argv.slice(2);

try {
  process.exit(await runCli(['vault', ...(args.length === 0 ? ['sync'] : args)]));
} catch (err) {
  // EnvError, DatabaseOpenError, VaultMountError, and the config loaders'
  // errors all carry messages written to name the offending variable, path or
  // config line -- a raw stack trace buries exactly that.
  console.error((err as Error).message);
  process.exit(1);
}

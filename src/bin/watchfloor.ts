/**
 * The `watchfloor` CLI (M5 task 12):
 *
 *   npm run watchfloor -- vault verify
 *   npm run watchfloor -- vault prune
 *   npm run watchfloor -- --help
 *
 * §8.1 names `watchfloor vault verify` and `watchfloor vault prune` by name.
 * Both existed, complete and tested, with no way to run them — task 9's report
 * called that occurrence six of this project's characteristic defect and named
 * this task as the owner. The routing is in `src/cli/`; this file is the door.
 *
 * Errors are printed as messages rather than stack traces, matching every
 * other `src/bin/*.ts`: `EnvError`, `DatabaseOpenError`, `VaultMountError` and
 * the config loaders all carry messages written to name the offending
 * variable, path or config line, and a raw stack trace buries exactly that.
 */

import { runCli } from '../cli/run.ts';

try {
  process.exit(await runCli(process.argv.slice(2)));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

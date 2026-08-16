/**
 * The `watchfloor` router (M5 task 12).
 *
 * One function, one `switch`, and every branch answers an exit code rather
 * than calling `process.exit` — so the two entrypoints that call it
 * (`src/bin/watchfloor.ts` and `src/bin/vault.ts`) are three lines each, and
 * the code a command chooses is a return value a test can read.
 *
 * ## Where it finds its siblings
 *
 * `binDir` and the extension both come from this module's own location, not
 * from the process working directory and not from a constant: `import.meta`
 * answers `.ts` in the source tree and `.js` in `dist/`, so the CLI finds the
 * entrypoints in whichever tree it is running from. No absolute path, and no
 * build-time list to fall out of date (§12).
 */

import { extname, join } from 'node:path';
import { parseCliArgs } from './args.ts';
import { delegate } from './delegate.ts';
import { EXIT_CANNOT_RUN, EXIT_OK } from './exit.ts';
import { discoverDelegatedCommands, renderHelp } from './help.ts';
import { runVaultPruneCommand, runVaultSyncCommand, runVaultVerifyCommand } from './vault.ts';

const binDir = join(import.meta.dirname, '..', 'bin');
const moduleExt = extname(import.meta.filename);

export async function runCli(argv: readonly string[]): Promise<number> {
  const invocation = parseCliArgs(argv);

  switch (invocation.kind) {
    case 'no-command':
      // Help, but on stderr and nonzero: a script that ran `watchfloor` with
      // an unset variable asked for nothing, and must not look successful.
      process.stderr.write(renderHelp('root', discoverDelegatedCommands(binDir, moduleExt)));
      return EXIT_CANNOT_RUN;

    case 'help':
      process.stdout.write(
        renderHelp(invocation.topic, discoverDelegatedCommands(binDir, moduleExt)),
      );
      return EXIT_OK;

    case 'usage-error':
      console.error(invocation.message);
      return EXIT_CANNOT_RUN;

    case 'vault-sync':
      return await runVaultSyncCommand();

    case 'vault-verify':
      return runVaultVerifyCommand(invocation);

    case 'vault-prune':
      return runVaultPruneCommand(invocation);

    case 'delegate': {
      const commands = discoverDelegatedCommands(binDir, moduleExt);
      const match = commands.find((command) => command.name === invocation.command);
      if (match === undefined) {
        console.error(
          `unknown command ${JSON.stringify(invocation.command)}: there is no ` +
            `src/bin/${invocation.command}${moduleExt}. The commands are: ` +
            `${['vault', ...commands.map((c) => c.name)].join(', ')}.`,
        );
        return EXIT_CANNOT_RUN;
      }
      return await delegate(binDir, match.file, invocation.args);
    }
  }
}

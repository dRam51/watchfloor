/**
 * Delegation to the entrypoints that already exist (M5 task 12).
 *
 * ## Spawned, never reimplemented
 *
 * `watchfloor ingest` runs exactly the file `npm run ingest` runs. The CLI
 * adds discoverability — one `--help` that lists the whole operational surface,
 * which §12's runbook is a sequence through — and it deliberately adds nothing
 * else. A CLI that reimplemented an entrypoint's body would be a second
 * composition root for the same job, and this project has already paid for that
 * class of drift: M4a's README enricher made a hand-run `npm run ingest` look
 * identical to the daemon's while covering 8 repos and stopping.
 *
 * The same rule governs flags. Everything after a delegated command name is
 * passed through **verbatim** and is the child's to parse. `score --force` and
 * `suggest --json` already mean something in `src/bin/`; re-declaring them here
 * would be a copy of an interface this module does not own.
 *
 * ## Why `spawn` and signal forwarding rather than `spawnSync`
 *
 * Two of the delegated commands are long-running processes — `api` and
 * `scheduler` — and §12 puts the scheduler under a process supervisor. A
 * supervisor sends `SIGTERM` to the process it started, which under `spawnSync`
 * would kill this wrapper and orphan the daemon. Forwarding costs a few lines
 * and removes that hazard entirely.
 *
 * A supervisor should still point at `src/bin/scheduler.ts` directly: this
 * wrapper is a convenience for a human at a terminal, and every layer between
 * a supervisor and its process is a layer that can fail on its own.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';

/** The signals a human or a supervisor sends, forwarded to the child. */
const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Runs `binDir/file` with `args`, inheriting stdio, and answers the exit code
 * the caller should exit with.
 *
 * A child killed by a signal answers `128 + n`, the shell convention, rather
 * than being flattened into a bare 1 — `watchfloor scheduler` interrupted at a
 * terminal is a different event from one that crashed.
 */
export function delegate(
  binDir: string,
  file: string,
  args: readonly string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(binDir, file), ...args], {
      stdio: 'inherit',
      env: process.env,
    });

    const forward = (signal: NodeJS.Signals) => (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const handlers = FORWARDED.map((signal) => [signal, forward(signal)] as const);
    for (const [signal, handler] of handlers) process.on(signal, handler);

    const detach = (): void => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };

    child.on('error', (err) => {
      detach();
      reject(err);
    });
    child.on('exit', (code, signal) => {
      detach();
      if (signal !== null) {
        const number = (constants.signals as Record<string, number>)[signal];
        resolve(number === undefined ? 1 : 128 + number);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

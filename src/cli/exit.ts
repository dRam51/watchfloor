/**
 * The exit-code contract (M5 task 12). Three codes, and the middle one is the
 * whole point.
 *
 * | code | meaning |
 * | --- | --- |
 * | `0` | the command ran and the answer is good |
 * | `1` | the command **could not run**, or the run itself was refused |
 * | `2` | the command ran and **found something you must look at** |
 *
 * `1` and `2` are separated for the same reason `/api/sources` reports
 * `everPolled: false` rather than an empty array: **absence is not emptiness.**
 * A `vault verify` that has been failing to start for three weeks because
 * `WF_VAULT_ROOT` is wrong must not be indistinguishable from a vault with a
 * stale temp file in it, and an unattended check that only looks at "nonzero"
 * makes them the same event.
 *
 * Two consequences worth stating, because both look like inconsistencies until
 * the question each command is answering is named:
 *
 * - **An unmounted vault is `1`, not `2`**, even though `verifyVault` reports
 *   it as an `error` finding. Nothing was scanned. "Zero other problems found"
 *   in a tree nobody looked at is the false negative this whole file exists to
 *   prevent.
 * - **`vault sync` with no vault configured is `0`, while `vault verify` with
 *   no vault configured is `1`.** Sync is an instruction — there are no notes
 *   to write, so there is nothing to fail. Verify is a question — there is no
 *   vault, so there is no answer, and answering `0` would assert a clean bill
 *   of health for something that does not exist. Sync's code is also Task 15's
 *   shipped contract and is deliberately not changed here.
 *
 * A delegated command's exit code is the child's, verbatim (see
 * `delegate.ts`), so this table describes the `vault` group and the CLI's own
 * usage errors only.
 */

import type { PruneResult } from '../vault/prune.ts';
import type { VaultVerifyReport } from '../vault/verify.ts';

export const EXIT_OK = 0;
export const EXIT_CANNOT_RUN = 1;
export const EXIT_FOUND = 2;

/**
 * `info` findings do not raise the code, and that is deliberate rather than
 * lenient: `src/vault/verify.ts` uses `info` to mean "this is what a healthy
 * vault looks like and you should be able to see it" — the owner's twelve
 * hand-authored notes, an entity note we appended to, the permanent temp link
 * every `saved/` note carries, an `entities/` that is empty because no entity
 * extractor exists yet. A verify that exited nonzero on a healthy vault would
 * be a verify nobody runs twice.
 */
export function verifyExitCode(report: VaultVerifyReport): number {
  if (!report.mounted) return EXIT_CANNOT_RUN;
  const actionable = report.findings.some(
    (finding) => finding.severity === 'error' || finding.severity === 'warning',
  );
  return actionable ? EXIT_FOUND : EXIT_OK;
}

/**
 * A dry run that found candidates is `2` — an answer, not a failure. That is
 * what makes the default invocation usable as a check, and the count it prints
 * is exactly what `--apply --expect=N` then demands back.
 *
 * An applied run that left a candidate behind is also `2`: every removal is
 * re-checked by the safety layer at the moment it happens, so a
 * proposed-but-not-removed file means this program's policy layer and its
 * safety layer disagreed about the same file. Task 9 calls that a policy bug,
 * and it is reported rather than swallowed.
 */
export function pruneExitCode(result: PruneResult): number {
  if (!result.mounted) return EXIT_CANNOT_RUN;
  if (result.refused !== null) return EXIT_CANNOT_RUN;
  if (result.applied) return result.removed.length < result.candidates.length ? EXIT_FOUND : EXIT_OK;
  return result.candidates.length > 0 ? EXIT_FOUND : EXIT_OK;
}
